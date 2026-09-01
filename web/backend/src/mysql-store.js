import mysql from 'mysql2/promise';

const RETRY_COOLDOWN_MS = Math.max(1000, Number(process.env.MYSQL_RETRY_COOLDOWN_MS || 5000));
const APP_STATE_TABLE = 'app_state';

let pool = null;
let schemaReady = false;
let pendingSnapshot = null;
let syncWorker = null;
let retryTimer = null;
let nextRetryAt = 0;
let status = {
  enabled: true,
  connected: false,
  ok: false,
  lastAttemptAt: null,
  lastSyncedAt: null,
  lastError: null,
  message: 'MySQL 镜像尚未初始化'
};

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function databaseName() {
  return env('MYSQL_DATABASE', env('DB_NAME', 'xiaode_course_table'));
}

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll('`', '``')}\``;
}

function mysqlConfig(withDatabase = true) {
  const cfg = {
    host: env('MYSQL_HOST', env('DB_HOST', '127.0.0.1')),
    port: Number(env('MYSQL_PORT', env('DB_PORT', '3306'))),
    user: env('MYSQL_USER', env('DB_USER', 'root')),
    password: env('MYSQL_PASSWORD', env('DB_PASSWORD', '')),
    waitForConnections: true,
    connectionLimit: Number(env('MYSQL_CONNECTION_LIMIT', '10')),
    connectTimeout: Number(env('MYSQL_CONNECT_TIMEOUT_MS', '3000')),
    charset: 'utf8mb4'
  };
  if (withDatabase) cfg.database = databaseName();
  return cfg;
}

export function getMysqlStatus() {
  return clone(status);
}

function errorMessage(err) {
  return String(err?.message || err || '未知 MySQL 错误');
}

function recordFailure(err, message = 'MySQL 镜像同步失败，db.json 不受影响') {
  const now = new Date().toISOString();
  status = {
    ...status,
    enabled: true,
    ok: false,
    lastError: errorMessage(err),
    lastErrorAt: now,
    message
  };
  nextRetryAt = Date.now() + RETRY_COOLDOWN_MS;
}

function isConnectionError(err) {
  return [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EPIPE',
    'PROTOCOL_CONNECTION_LOST',
    'ER_ACCESS_DENIED_ERROR',
    'ER_DBACCESS_DENIED_ERROR'
  ].includes(err?.code);
}

async function closePool() {
  const oldPool = pool;
  pool = null;
  schemaReady = false;
  if (oldPool) await oldPool.end().catch(() => {});
}

async function ensureDatabase() {
  const bootstrap = await mysql.createConnection(mysqlConfig(false));
  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(databaseName())} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await bootstrap.end();
  }
}

async function tableExists(conn, tableName) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      LIMIT 1`,
    [databaseName(), tableName]
  );
  return rows.length > 0;
}

async function tableColumns(conn, tableName) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [databaseName(), tableName]
  );
  return rows;
}

async function recordAppStateMigrationHistory(conn) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'app_state_legacy_%'
      ORDER BY TABLE_NAME DESC`,
    [databaseName()]
  );
  const legacyTables = rows
    .map((row) => String(row.TABLE_NAME || ''))
    .filter((name) => name.startsWith('app_state_legacy_'));
  if (!legacyTables.length) return;
  const current = status.migration || {};
  status = {
    ...status,
    migration: {
      ...current,
      appState: current.appState === 'rebuilt' ? 'rebuilt' : 'previously-migrated',
      legacyTable: current.legacyTable || legacyTables[0],
      legacyTables
    }
  };
}

async function hasUniqueStateKey(conn) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        AND COLUMN_NAME = 'state_key' AND NON_UNIQUE = 0
      LIMIT 1`,
    [databaseName(), APP_STATE_TABLE]
  );
  return rows.length > 0;
}

async function createAppStateTable(conn, tableName = APP_STATE_TABLE) {
  await conn.query(`
    CREATE TABLE ${quoteIdentifier(tableName)} (
      state_key VARCHAR(64) NOT NULL PRIMARY KEY,
      state_json LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function migrationSuffix() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

async function rebuildLegacyAppState(conn, columns) {
  const suffix = migrationSuffix();
  const tempTable = `app_state_migrating_${suffix}`;
  let backupTable = `app_state_legacy_${suffix}`;
  while (await tableExists(conn, backupTable)) backupTable = `app_state_legacy_${migrationSuffix()}`;

  const names = new Map(columns.map((column) => [String(column.COLUMN_NAME).toLowerCase(), column.COLUMN_NAME]));
  const keyColumn = names.get('state_key') || names.get('id') || names.get('key') || names.get('name');
  const jsonColumn = names.get('state_json') || names.get('data') || names.get('json') || names.get('value');

  try {
    await createAppStateTable(conn, tempTable);
    if (jsonColumn) {
      const keyExpression = keyColumn
        ? `CASE WHEN ${quoteIdentifier(keyColumn)} IS NULL OR TRIM(CAST(${quoteIdentifier(keyColumn)} AS CHAR)) = '' THEN CONCAT('legacy-', REPLACE(UUID(), '-', '')) ELSE LEFT(CAST(${quoteIdentifier(keyColumn)} AS CHAR), 64) END`
        : `CONCAT('legacy-', REPLACE(UUID(), '-', ''))`;
      await conn.query(
        `INSERT IGNORE INTO ${quoteIdentifier(tempTable)} (state_key, state_json, updated_at)
         SELECT ${keyExpression}, COALESCE(CAST(${quoteIdentifier(jsonColumn)} AS CHAR), '{}'), CURRENT_TIMESTAMP
           FROM ${quoteIdentifier(APP_STATE_TABLE)}`
      );
    }
    // RENAME TABLE 是原子的；旧表完整保留，任何无法识别的数据仍可从 legacy 表恢复。
    await conn.query(
      `RENAME TABLE ${quoteIdentifier(APP_STATE_TABLE)} TO ${quoteIdentifier(backupTable)}, ${quoteIdentifier(tempTable)} TO ${quoteIdentifier(APP_STATE_TABLE)}`
    );
    status = {
      ...status,
      migration: {
        appState: 'rebuilt',
        legacyTable: backupTable,
        migratedRecognizedData: Boolean(jsonColumn)
      }
    };
  } catch (err) {
    if (await tableExists(conn, tempTable).catch(() => false)) {
      await conn.query(`DROP TABLE ${quoteIdentifier(tempTable)}`).catch(() => {});
    }
    throw err;
  }
}

async function ensureAppStateTable(conn) {
  if (!(await tableExists(conn, APP_STATE_TABLE))) {
    await createAppStateTable(conn);
    status = { ...status, migration: { appState: 'created' } };
    return;
  }

  let columns = await tableColumns(conn, APP_STATE_TABLE);
  const names = new Set(columns.map((column) => String(column.COLUMN_NAME).toLowerCase()));

  if (names.has('state_key') && names.has('state_json') && !names.has('updated_at')) {
    await conn.query(
      `ALTER TABLE ${quoteIdentifier(APP_STATE_TABLE)} ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
    );
    columns = await tableColumns(conn, APP_STATE_TABLE);
    names.add('updated_at');
  }

  const required = new Set(['state_key', 'state_json', 'updated_at']);
  const hasRequired = [...required].every((name) => names.has(name));
  const uniqueStateKey = hasRequired && await hasUniqueStateKey(conn);
  const stateKeyColumn = columns.find((column) => String(column.COLUMN_NAME).toLowerCase() === 'state_key');
  const stateJsonColumn = columns.find((column) => String(column.COLUMN_NAME).toLowerCase() === 'state_json');
  const compatibleTypes = (!stateKeyColumn || ['char', 'varchar'].includes(String(stateKeyColumn.DATA_TYPE).toLowerCase()))
    && (!stateJsonColumn || ['text', 'mediumtext', 'longtext', 'json'].includes(String(stateJsonColumn.DATA_TYPE).toLowerCase()));
  const blockingExtraColumn = columns.some((column) => {
    const name = String(column.COLUMN_NAME).toLowerCase();
    return !required.has(name)
      && column.IS_NULLABLE === 'NO'
      && column.COLUMN_DEFAULT === null
      && !String(column.EXTRA || '').toLowerCase().includes('auto_increment');
  });

  if (!hasRequired || !uniqueStateKey || !compatibleTypes || blockingExtraColumn) {
    await rebuildLegacyAppState(conn, columns);
  } else if (!status.migration) {
    status = { ...status, migration: { appState: 'compatible' } };
  }
}

async function ensureColumn(conn, tableName, columnName, definition) {
  const columns = await tableColumns(conn, tableName);
  if (columns.some((column) => String(column.COLUMN_NAME).toLowerCase() === columnName.toLowerCase())) return;
  await conn.query(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${definition}`);
}

async function ensureIndex(conn, tableName, indexName, columns) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [databaseName(), tableName, indexName]
  );
  if (rows.length) return;
  await conn.query(`ALTER TABLE ${quoteIdentifier(tableName)} ADD INDEX ${quoteIdentifier(indexName)} (${columns.map(quoteIdentifier).join(', ')})`);
}

async function ensureTables(conn) {
  await ensureAppStateTable(conn);
  await recordAppStateMigrationHistory(conn);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(80) PRIMARY KEY,
      account_id VARCHAR(80),
      username VARCHAR(120) NOT NULL,
      name VARCHAR(120),
      role VARCHAR(40),
      switch_key VARCHAR(120),
      password_text VARCHAR(255),
      preferences_json LONGTEXT,
      created_at VARCHAR(40),
      raw_json LONGTEXT,
      INDEX idx_users_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id VARCHAR(80) PRIMARY KEY,
      user_id VARCHAR(80) NOT NULL,
      username VARCHAR(120),
      name VARCHAR(120),
      role VARCHAR(40),
      status VARCHAR(40),
      active_term_key VARCHAR(160),
      revision INT,
      created_at VARCHAR(40),
      updated_at VARCHAR(40),
      raw_json LONGTEXT,
      INDEX idx_accounts_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS courses (
      id VARCHAR(80) PRIMARY KEY,
      user_id VARCHAR(80) NOT NULL,
      account_id VARCHAR(80) NOT NULL,
      day INT,
      slot INT,
      start_slot INT,
      end_slot INT,
      source_start_slot INT,
      source_end_slot INT,
      start_slot_key VARCHAR(80),
      end_slot_key VARCHAR(80),
      schedule_template_id VARCHAR(120),
      client_local_id VARCHAR(120),
      revision INT,
      updated_at VARCHAR(40),
      name VARCHAR(255) NOT NULL,
      short_name VARCHAR(255),
      teacher VARCHAR(255),
      location VARCHAR(255),
      room VARCHAR(255),
      class_group VARCHAR(255),
      week_text VARCHAR(255),
      weeks_json LONGTEXT,
      odd_even VARCHAR(40),
      category VARCHAR(80),
      source VARCHAR(120),
      source_ids_json LONGTEXT,
      underlying_ids_json LONGTEXT,
      schedule_variants_json LONGTEXT,
      term_key VARCHAR(160),
      xnm VARCHAR(20),
      xqm VARCHAR(20),
      selected_term_label VARCHAR(160),
      raw_json LONGTEXT,
      INDEX idx_courses_account_day_slot (account_id, day, slot),
      INDEX idx_courses_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS terms (
      term_key VARCHAR(160) PRIMARY KEY,
      account_id VARCHAR(80) NOT NULL,
      user_id VARCHAR(80) NOT NULL,
      xnm VARCHAR(20),
      xqm VARCHAR(20),
      selected_term_label VARCHAR(160),
      term_start VARCHAR(20),
      total_weeks INT,
      total_weeks_source VARCHAR(80),
      schedule_template_id VARCHAR(120),
      revision INT,
      updated_at VARCHAR(40),
      raw_json LONGTEXT,
      INDEX idx_terms_account_id (account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id VARCHAR(120) PRIMARY KEY,
      account_id VARCHAR(80) NOT NULL,
      user_id VARCHAR(80) NOT NULL,
      preferences_json LONGTEXT,
      slots_json LONGTEXT,
      revision INT,
      updated_at VARCHAR(40),
      raw_json LONGTEXT,
      INDEX idx_settings_account_id (account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id VARCHAR(120) PRIMARY KEY,
      account_id VARCHAR(80) NOT NULL,
      user_id VARCHAR(80) NOT NULL,
      settings_json LONGTEXT,
      updated_at VARCHAR(40),
      raw_json LONGTEXT,
      INDEX idx_reminders_account_id (account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(160) PRIMARY KEY,
      user_id VARCHAR(80) NOT NULL,
      account_id VARCHAR(80),
      created_at VARCHAR(40),
      raw_json LONGTEXT,
      INDEX idx_sessions_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS slots (
      slot INT PRIMARY KEY,
      label VARCHAR(80),
      range_text VARCHAR(80),
      start_time VARCHAR(20),
      end_time VARCHAR(20),
      raw_json LONGTEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schedule_templates (
      template_id VARCHAR(120) PRIMARY KEY,
      account_id VARCHAR(80),
      term_key VARCHAR(160),
      school_id VARCHAR(120),
      campus_id VARCHAR(120),
      name VARCHAR(160),
      version INT,
      revision INT,
      updated_at VARCHAR(40),
      periods_json LONGTEXT,
      raw_json LONGTEXT,
      INDEX idx_schedule_templates_account_term (account_id, term_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS processed_mutations (
      operation_id VARCHAR(160) NOT NULL,
      account_id VARCHAR(80) NOT NULL,
      term_key VARCHAR(160),
      payload_hash VARCHAR(80) NOT NULL,
      status_code INT,
      response_json LONGTEXT,
      created_at VARCHAR(40),
      raw_json LONGTEXT,
      PRIMARY KEY (operation_id, account_id),
      INDEX idx_processed_mutations_account_created (account_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS feedbacks (
      id VARCHAR(80) PRIMARY KEY,
      user_id VARCHAR(80),
      account_id VARCHAR(80),
      username VARCHAR(120),
      name VARCHAR(120),
      type VARCHAR(80),
      content TEXT,
      contact VARCHAR(255),
      page VARCHAR(255),
      status VARCHAR(80),
      created_at VARCHAR(40),
      raw_json LONGTEXT,
      INDEX idx_feedbacks_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS import_codes (
      code VARCHAR(40) PRIMARY KEY,
      user_id VARCHAR(80),
      account_id VARCHAR(80),
      username VARCHAR(120),
      replace_mode TINYINT(1),
      xnm VARCHAR(20),
      xqm VARCHAR(20),
      created_at VARCHAR(40),
      expires_at VARCHAR(40),
      used_at VARCHAR(40),
      raw_json LONGTEXT,
      INDEX idx_import_codes_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS backups (
      id VARCHAR(120) PRIMARY KEY,
      account_id VARCHAR(80),
      user_id VARCHAR(80),
      created_at VARCHAR(40),
      raw_json LONGTEXT,
      INDEX idx_backups_account_id (account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 旧镜像表采用幂等列迁移，不能要求用户删除数据库。
  await ensureColumn(conn, 'accounts', 'active_term_key', 'VARCHAR(160) NULL');
  await ensureColumn(conn, 'accounts', 'revision', 'INT NULL');
  await ensureColumn(conn, 'courses', 'term_key', 'VARCHAR(160) NULL');
  await ensureColumn(conn, 'courses', 'xnm', 'VARCHAR(20) NULL');
  await ensureColumn(conn, 'courses', 'xqm', 'VARCHAR(20) NULL');
  await ensureColumn(conn, 'courses', 'selected_term_label', 'VARCHAR(160) NULL');
  await ensureColumn(conn, 'courses', 'start_slot', 'INT NULL');
  await ensureColumn(conn, 'courses', 'end_slot', 'INT NULL');
  await ensureColumn(conn, 'courses', 'source_start_slot', 'INT NULL');
  await ensureColumn(conn, 'courses', 'source_end_slot', 'INT NULL');
  await ensureColumn(conn, 'courses', 'start_slot_key', 'VARCHAR(80) NULL');
  await ensureColumn(conn, 'courses', 'end_slot_key', 'VARCHAR(80) NULL');
  await ensureColumn(conn, 'courses', 'schedule_template_id', 'VARCHAR(120) NULL');
  await ensureColumn(conn, 'courses', 'client_local_id', 'VARCHAR(120) NULL');
  await ensureColumn(conn, 'courses', 'revision', 'INT NULL');
  await ensureColumn(conn, 'courses', 'updated_at', 'VARCHAR(40) NULL');
  await ensureColumn(conn, 'courses', 'room', 'VARCHAR(255) NULL');
  await ensureColumn(conn, 'courses', 'source', 'VARCHAR(120) NULL');
  await ensureColumn(conn, 'courses', 'source_ids_json', 'LONGTEXT NULL');
  await ensureColumn(conn, 'courses', 'underlying_ids_json', 'LONGTEXT NULL');
  await ensureColumn(conn, 'courses', 'schedule_variants_json', 'LONGTEXT NULL');
  await ensureColumn(conn, 'terms', 'schedule_template_id', 'VARCHAR(120) NULL');
  await ensureColumn(conn, 'terms', 'revision', 'INT NULL');
  await ensureColumn(conn, 'settings', 'revision', 'INT NULL');
  await ensureIndex(conn, 'courses', 'idx_courses_account_term', ['account_id', 'term_key']);
}

async function openConfiguredPool() {
  pool = mysql.createPool(mysqlConfig(true));
  try {
    const conn = await pool.getConnection();
    conn.release();
  } catch (err) {
    await closePool();
    if (err?.code !== 'ER_BAD_DB_ERROR') throw err;
    await ensureDatabase();
    pool = mysql.createPool(mysqlConfig(true));
  }
}

async function ensureReady() {
  if (pool && schemaReady) return;
  status = { ...status, lastAttemptAt: new Date().toISOString(), message: '正在连接并检查 MySQL 镜像结构' };
  try {
    if (!pool) await openConfiguredPool();
    const conn = await pool.getConnection();
    try {
      await ensureTables(conn);
    } finally {
      conn.release();
    }
    schemaReady = true;
    status = {
      ...status,
      enabled: true,
      connected: true,
      ok: true,
      database: databaseName(),
      lastError: null,
      initializedAt: status.initializedAt || new Date().toISOString(),
      message: 'MySQL 镜像结构已就绪，主存储仍为 db.json'
    };
  } catch (err) {
    status = { ...status, connected: false };
    recordFailure(err, 'MySQL 初始化失败，服务继续使用 db.json');
    await closePool();
    throw err;
  }
}

async function upsertState(conn, db) {
  await conn.query(
    `INSERT INTO app_state (state_key, state_json) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE state_json = VALUES(state_json), updated_at = CURRENT_TIMESTAMP`,
    ['main', JSON.stringify(db)]
  );
}

async function clearMirrorTables(conn) {
  const tables = ['users', 'accounts', 'courses', 'terms', 'settings', 'reminders', 'sessions', 'slots', 'schedule_templates', 'processed_mutations', 'feedbacks', 'import_codes', 'backups'];
  for (const table of tables) await conn.query(`DELETE FROM ${quoteIdentifier(table)}`);
}

function j(value) {
  return JSON.stringify(value ?? null);
}

async function insertMirrorRows(conn, db) {
  for (const u of db.users || []) {
    await conn.query(
      `INSERT INTO users (id, account_id, username, name, role, switch_key, password_text, preferences_json, created_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.id, u.accountId || u.id, u.username || '', u.name || '', u.role || 'user', u.switchKey || '', u.password || '', j(u.preferences || {}), u.createdAt || '', j(u)]
    );
  }

  for (const a of db.accounts || []) {
    await conn.query(
      `INSERT INTO accounts (id, user_id, username, name, role, status, active_term_key, revision, created_at, updated_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.id, a.userId || '', a.username || '', a.name || '', a.role || '', a.status || '', a.activeTermKey || '', Number(a.revision || 1), a.createdAt || '', a.updatedAt || '', j(a)]
    );
  }

  for (const c of db.courses || []) {
    await conn.query(
      `INSERT INTO courses (id, user_id, account_id, day, slot, start_slot, end_slot, source_start_slot, source_end_slot, start_slot_key, end_slot_key, schedule_template_id, client_local_id, revision, updated_at, name, short_name, teacher, location, room, class_group, week_text, weeks_json, odd_even, category, source, source_ids_json, underlying_ids_json, schedule_variants_json, term_key, xnm, xqm, selected_term_label, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.userId || '', c.accountId || c.userId || '', Number(c.day || 0), Number(c.slot || 0), Number(c.startSlot || c.slot || 0), Number(c.endSlot || c.slot || 0), Number(c.sourceStartSlot || c.startSlot || c.slot || 0), Number(c.sourceEndSlot || c.endSlot || c.slot || 0), c.startSlotKey || '', c.endSlotKey || '', c.scheduleTemplateId || '', c.clientLocalId || '', Number(c.revision || 1), c.updatedAt || '', c.name || '', c.shortName || '', c.teacher || '', c.location || '', c.room || c.location || '', c.classGroup || '', c.weekText || '', j(c.weeks || []), c.oddEven || 'all', c.category || 'custom', c.source || '', j(c.sourceIds || []), j(c.underlyingIds || []), j(c.scheduleVariants || []), c.termKey || '', c.xnm || '', c.xqm || '', c.selectedTermLabel || '', j(c)]
    );
  }

  for (const term of db.terms || []) {
    await conn.query(
      `INSERT INTO terms (term_key, account_id, user_id, xnm, xqm, selected_term_label, term_start, total_weeks, total_weeks_source, schedule_template_id, revision, updated_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [term.termKey, term.accountId || '', term.userId || '', term.xnm || '', term.xqm || '', term.selectedTermLabel || '', term.termStart || '', Number(term.totalWeeks || 0), term.totalWeeksSource || '', term.scheduleTemplateId || '', Number(term.revision || 1), term.updatedAt || '', j(term)]
    );
  }

  for (const s of db.settings || []) {
    await conn.query(
      `INSERT INTO settings (id, account_id, user_id, preferences_json, slots_json, revision, updated_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.accountId || '', s.userId || '', j(s.preferences || {}), j(s.slots || null), Number(s.revision || 1), s.updatedAt || '', j(s)]
    );
  }

  for (const r of db.reminders || []) {
    await conn.query(
      `INSERT INTO reminders (id, account_id, user_id, settings_json, updated_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [r.id, r.accountId || '', r.userId || '', j(r.settings || {}), r.updatedAt || '', j(r)]
    );
  }

  for (const sess of db.sessions || []) {
    await conn.query(
      `INSERT INTO sessions (token, user_id, account_id, created_at, raw_json)
       VALUES (?, ?, ?, ?, ?)`,
      [sess.token, sess.userId || '', sess.accountId || sess.userId || '', sess.createdAt || '', j(sess)]
    );
  }

  for (const slot of db.slots || []) {
    await conn.query(
      `INSERT INTO slots (slot, label, range_text, start_time, end_time, raw_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Number(slot.slot || 0), slot.label || '', slot.range || '', slot.start || '', slot.end || '', j(slot)]
    );
  }

  for (const template of db.scheduleTemplates || []) {
    await conn.query(
      `INSERT INTO schedule_templates (template_id, account_id, term_key, school_id, campus_id, name, version, revision, updated_at, periods_json, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [template.templateId, template.accountId || null, template.termKey || null, template.schoolId || null, template.campusId || null, template.name || '', Number(template.version || 1), Number(template.revision || 1), template.updatedAt || '', j(template.periods || []), j(template)]
    );
  }

  for (const operation of db.processedMutations || []) {
    await conn.query(
      `INSERT INTO processed_mutations (operation_id, account_id, term_key, payload_hash, status_code, response_json, created_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [operation.operationId, operation.accountId || '', operation.termKey || '', operation.payloadHash || '', Number(operation.statusCode || 200), j(operation.response || {}), operation.createdAt || '', j(operation)]
    );
  }

  for (const f of db.feedbacks || []) {
    await conn.query(
      `INSERT INTO feedbacks (id, user_id, account_id, username, name, type, content, contact, page, status, created_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.id, f.userId || '', f.accountId || f.userId || '', f.username || '', f.name || '', f.type || '', f.content || '', f.contact || '', f.page || '', f.status || '', f.createdAt || '', j(f)]
    );
  }

  for (const item of db.importCodes || []) {
    await conn.query(
      `INSERT INTO import_codes (code, user_id, account_id, username, replace_mode, xnm, xqm, created_at, expires_at, used_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [item.code, item.userId || '', item.accountId || item.userId || '', item.username || '', item.replace ? 1 : 0, item.xnm || '', item.xqm || '', item.createdAt || '', item.expiresAt || '', item.usedAt || null, j(item)]
    );
  }

  for (const b of db.backups || []) {
    await conn.query(
      `INSERT INTO backups (id, account_id, user_id, created_at, raw_json)
       VALUES (?, ?, ?, ?, ?)`,
      [b.id || `${b.accountId || b.userId || 'backup'}_${b.createdAt || Date.now()}`, b.accountId || '', b.userId || '', b.createdAt || '', j(b)]
    );
  }
}

async function syncNow(db) {
  const snapshot = clone(db);
  let conn = null;
  status = { ...status, lastAttemptAt: new Date().toISOString(), message: '正在同步 db.json 快照到 MySQL 镜像' };
  try {
    await ensureReady();
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await upsertState(conn, snapshot);
    await clearMirrorTables(conn);
    await insertMirrorRows(conn, snapshot);
    await conn.commit();
    nextRetryAt = 0;
    status = {
      ...status,
      enabled: true,
      connected: true,
      ok: true,
      database: databaseName(),
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
      counts: {
        users: snapshot.users?.length || 0,
        accounts: snapshot.accounts?.length || 0,
        courses: snapshot.courses?.length || 0,
        terms: snapshot.terms?.length || 0,
        settings: snapshot.settings?.length || 0,
        reminders: snapshot.reminders?.length || 0,
        scheduleTemplates: snapshot.scheduleTemplates?.length || 0,
        processedMutations: snapshot.processedMutations?.length || 0
      },
      message: 'MySQL 镜像同步正常；db.json 是主存储'
    };
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (isConnectionError(err)) {
      status = { ...status, connected: false };
      await closePool();
    }
    recordFailure(err);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

function kickSyncWorker(force = false) {
  if (syncWorker) return syncWorker;
  const delay = force ? 0 : Math.max(0, nextRetryAt - Date.now());
  syncWorker = new Promise((resolve, reject) => {
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      try {
        // 连续写入只保留并最终同步较新的完整快照，同一时刻只有一个事务。
        while (pendingSnapshot) {
          const snapshot = pendingSnapshot;
          pendingSnapshot = null;
          await syncNow(snapshot);
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    }, delay);
  }).finally(() => {
    syncWorker = null;
    if (pendingSnapshot) void kickSyncWorker().catch(() => {});
  });
  return syncWorker;
}

export function syncMysqlState(db, options = {}) {
  pendingSnapshot = clone(db);
  return kickSyncWorker(Boolean(options.force));
}

export async function initMysqlState(initialDb, normalizeDb = (value) => value) {
  const db = normalizeDb(clone(initialDb || {}));
  await syncMysqlState(db, { force: true });
  return db;
}
