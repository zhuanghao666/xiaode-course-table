import mysql from 'mysql2/promise';

let pool = null;
let syncChain = Promise.resolve();
let status = {
  enabled: false,
  driver: 'mysql',
  ok: false,
  message: 'MySQL 尚未初始化'
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

function mysqlConfig(withDatabase = true) {
  const cfg = {
    host: env('MYSQL_HOST', env('DB_HOST', '127.0.0.1')),
    port: Number(env('MYSQL_PORT', env('DB_PORT', '3306'))),
    user: env('MYSQL_USER', env('DB_USER', 'root')),
    password: env('MYSQL_PASSWORD', env('DB_PASSWORD', '')),
    waitForConnections: true,
    connectionLimit: Number(env('MYSQL_CONNECTION_LIMIT', '10')),
    charset: 'utf8mb4'
  };
  if (withDatabase) cfg.database = databaseName();
  return cfg;
}

export function getMysqlStatus() {
  return { ...status };
}

async function ensureDatabase() {
  const dbName = databaseName();
  const bootstrap = await mysql.createConnection(mysqlConfig(false));
  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await bootstrap.end();
  }
}

async function ensureTables(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      state_key VARCHAR(64) PRIMARY KEY,
      state_json LONGTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

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
      name VARCHAR(255) NOT NULL,
      short_name VARCHAR(255),
      teacher VARCHAR(255),
      location VARCHAR(255),
      class_group VARCHAR(255),
      week_text VARCHAR(255),
      weeks_json LONGTEXT,
      odd_even VARCHAR(40),
      category VARCHAR(80),
      raw_json LONGTEXT,
      INDEX idx_courses_account_day_slot (account_id, day, slot),
      INDEX idx_courses_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id VARCHAR(120) PRIMARY KEY,
      account_id VARCHAR(80) NOT NULL,
      user_id VARCHAR(80) NOT NULL,
      preferences_json LONGTEXT,
      slots_json LONGTEXT,
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
}

async function readStateFromMysql() {
  const [rows] = await pool.query('SELECT state_json FROM app_state WHERE state_key = ?', ['main']);
  if (!rows.length) return null;
  try {
    return JSON.parse(rows[0].state_json || '{}');
  } catch {
    return null;
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
  const tables = ['users', 'accounts', 'courses', 'settings', 'reminders', 'sessions', 'slots', 'feedbacks', 'import_codes', 'backups'];
  for (const table of tables) await conn.query(`DELETE FROM \`${table}\``);
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
      `INSERT INTO accounts (id, user_id, username, name, role, status, created_at, updated_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.id, a.userId || '', a.username || '', a.name || '', a.role || '', a.status || '', a.createdAt || '', a.updatedAt || '', j(a)]
    );
  }

  for (const c of db.courses || []) {
    await conn.query(
      `INSERT INTO courses (id, user_id, account_id, day, slot, name, short_name, teacher, location, class_group, week_text, weeks_json, odd_even, category, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.userId || '', c.accountId || c.userId || '', Number(c.day || 0), Number(c.slot || 0), c.name || '', c.shortName || '', c.teacher || '', c.location || '', c.classGroup || '', c.weekText || '', j(c.weeks || []), c.oddEven || 'all', c.category || 'custom', j(c)]
    );
  }

  for (const s of db.settings || []) {
    await conn.query(
      `INSERT INTO settings (id, account_id, user_id, preferences_json, slots_json, updated_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.accountId || '', s.userId || '', j(s.preferences || {}), j(s.slots || null), s.updatedAt || '', j(s)]
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
  if (!pool) throw new Error('MySQL 连接池尚未初始化');
  const snapshot = clone(db);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await upsertState(conn, snapshot);
    await clearMirrorTables(conn);
    await insertMirrorRows(conn, snapshot);
    await conn.commit();
    status = {
      ...status,
      enabled: true,
      ok: true,
      driver: 'mysql-dual-write',
      database: databaseName(),
      lastSyncedAt: new Date().toISOString(),
      counts: {
        users: snapshot.users?.length || 0,
        accounts: snapshot.accounts?.length || 0,
        courses: snapshot.courses?.length || 0,
        settings: snapshot.settings?.length || 0,
        reminders: snapshot.reminders?.length || 0
      },
      message: 'MySQL 同步正常，同时保留 db.json 回滚备份'
    };
  } catch (err) {
    await conn.rollback().catch(() => {});
    status = { ...status, ok: false, lastError: String(err?.message || err), lastErrorAt: new Date().toISOString() };
    throw err;
  } finally {
    conn.release();
  }
}

export async function syncMysqlState(db) {
  const snapshot = clone(db);
  syncChain = syncChain.then(() => syncNow(snapshot));
  return syncChain;
}

export async function initMysqlState(initialDb, normalizeDb) {
  await ensureDatabase();
  pool = mysql.createPool(mysqlConfig(true));
  const conn = await pool.getConnection();
  try {
    await ensureTables(conn);
  } finally {
    conn.release();
  }

  const fromMysql = await readStateFromMysql();
  const db = normalizeDb(fromMysql || initialDb || {});
  status = {
    enabled: true,
    ok: true,
    driver: 'mysql-dual-write',
    database: databaseName(),
    loadedFrom: fromMysql ? 'mysql.app_state' : 'db.json',
    initializedAt: new Date().toISOString(),
    message: fromMysql ? '已从 MySQL 读取状态' : 'MySQL 为空，已用 db.json 初始化'
  };
  await syncMysqlState(db);
  return db;
}
