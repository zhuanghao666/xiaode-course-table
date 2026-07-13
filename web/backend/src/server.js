import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  analyzeJwxtImport,
  buildCourseDisplayRecords,
  IMPORT_REASON_CODES,
  mergeCourseRecords,
  parseWeeksDetailed
} from './import-pipeline.js';
import { createImportDiagnosticsStore } from './import-diagnostics-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..', '..');
const DATA_FILE = process.env.NODE_ENV === 'test' && process.env.XIAODE_DATA_FILE
  ? path.resolve(process.env.XIAODE_DATA_FILE)
  : path.join(__dirname, '..', 'data', 'db.json');
const PUBLIC_DIR = path.join(ROOT, 'frontend', 'public');
const PORT = process.env.PORT || 3001;
const APP_VERSION = 'v41-dev';
const DB_SCHEMA_VERSION = 6;
const DEFAULT_TOTAL_WEEKS = 20;
const STORAGE_DRIVER = String(process.env.XIAODE_STORAGE || process.env.DB_DRIVER || 'json').toLowerCase();
const MYSQL_MIRROR_ENABLED = STORAGE_DRIVER === 'mysql';
const importDiagnosticsStore = createImportDiagnosticsStore({ dataFile: DATA_FILE });
let runtimeDbCache = null;
let writeDbCallCount = 0;
let mysqlSyncState = null;
let mysqlStatusReader = null;
let mysqlStorageStatus = {
  enabled: MYSQL_MIRROR_ENABLED,
  connected: false,
  ok: !MYSQL_MIRROR_ENABLED,
  lastAttemptAt: null,
  lastSyncedAt: null,
  lastError: null,
  message: MYSQL_MIRROR_ENABLED ? 'MySQL 镜像等待初始化' : 'MySQL 镜像未启用'
};

function currentMysqlStorageStatus() {
  return mysqlStatusReader ? mysqlStatusReader() : { ...mysqlStorageStatus };
}

function cloneDb(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function writeJsonFileOnly(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
  const fd = fs.openSync(tempFile, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(db, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempFile, DATA_FILE);
}

const DEFAULT_12_SLOTS = [
  { slot: 1, label: '第1节', range: '08:00-08:45', start: '08:00', end: '08:45' },
  { slot: 2, label: '第2节', range: '08:55-09:40', start: '08:55', end: '09:40' },
  { slot: 3, label: '第3节', range: '10:00-10:45', start: '10:00', end: '10:45' },
  { slot: 4, label: '第4节', range: '10:55-11:40', start: '10:55', end: '11:40' },
  { slot: 5, label: '第5节', range: '11:50-12:35', start: '11:50', end: '12:35' },
  { slot: 6, label: '第6节', range: '14:00-14:45', start: '14:00', end: '14:45' },
  { slot: 7, label: '第7节', range: '14:50-15:35', start: '14:50', end: '15:35' },
  { slot: 8, label: '第8节', range: '15:55-16:40', start: '15:55', end: '16:40' },
  { slot: 9, label: '第9节', range: '16:45-17:30', start: '16:45', end: '17:30' },
  { slot: 10, label: '第10节', range: '18:20-19:05', start: '18:20', end: '19:05' },
  { slot: 11, label: '第11节', range: '19:10-19:55', start: '19:10', end: '19:55' },
  { slot: 12, label: '第12节', range: '20:05-20:50', start: '20:05', end: '20:50' }
];

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

function readDb() {
  if (runtimeDbCache) return migrateDbToV38(cloneDb(runtimeDbCache));
  const raw = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : '{}';
  const db = JSON.parse(raw || '{}');
  // v31：默认节次升级为 12 节。旧数据库如果仍是 6 个合并节次，则自动补齐为 12 节，避免新 UI 缺行。
  if (!Array.isArray(db.slots) || db.slots.length < 12) db.slots = DEFAULT_12_SLOTS;
  const normalized = migrateDbToV38(db);
  runtimeDbCache = cloneDb(normalized);
  return normalized;
}

function writeDb(db) {
  writeDbCallCount += 1;
  const normalized = migrateDbToV38(db || {});
  normalized.meta.lastUpdated = new Date().toISOString();
  normalized.meta.storageDriver = 'json';
  runtimeDbCache = cloneDb(normalized);
  // db.json 永远先同步、原子落盘；MySQL 仅在成功后异步镜像。
  writeJsonFileOnly(normalized);
  if (mysqlSyncState) {
    mysqlSyncState(normalized).catch((err) => {
      console.error('[mysql-mirror] 后台同步失败，JSON 已保存：', String(err?.message || err));
    });
  }
  return normalized;
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureUserSwitchKey(user) {
  if (!user) return '';
  if (!user.switchKey) user.switchKey = uid('switch');
  return user.switchKey;
}

const DEFAULT_PREFERENCES = {
  theme: 'morandi',
  bottomToolbarHidden: false,
  infoMode: 'compact',
  tableSize: 'classic',
  tableDayWidth: 48,
  tableRowHeight: 118,
  tableFontSize: 16,
  layoutCustomized: false,
  hideFifthSlot: false,
  courseSettings: {},
  reminderSettings: {}
};

function sanitizePreferences(input = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const tableSize = ['classic', 'screenshot', 'classroom'].includes(src.tableSize) ? src.tableSize : DEFAULT_PREFERENCES.tableSize;
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  const courseSettings = src.courseSettings && typeof src.courseSettings === 'object' && !Array.isArray(src.courseSettings)
    ? {
        totalWeeks: String(src.courseSettings.totalWeeks ?? ''),
        weekStartDay: String(src.courseSettings.weekStartDay ?? '1'),
        termStart: String(src.courseSettings.termStart ?? ''),
        showLocation: src.courseSettings.showLocation !== false,
        showTeacher: src.courseSettings.showTeacher !== false,
        showSectionRange: src.courseSettings.showSectionRange !== false,
        showClassGroup: Boolean(src.courseSettings.showClassGroup),
        customTime: Boolean(src.courseSettings.customTime)
      }
    : {};
  const reminderSettings = src.reminderSettings && typeof src.reminderSettings === 'object' && !Array.isArray(src.reminderSettings)
    ? {
        startEnabled: src.reminderSettings.startEnabled !== false,
        startOffset: num(src.reminderSettings.startOffset, 10, 0, 240),
        endEnabled: src.reminderSettings.endEnabled !== false,
        endOffset: num(src.reminderSettings.endOffset, 0, 0, 240),
        calendarId: String(src.reminderSettings.calendarId ?? '').slice(0, 200),
        calendarName: String(src.reminderSettings.calendarName ?? '').slice(0, 200)
      }
    : {};
  return {
    ...DEFAULT_PREFERENCES,
    theme: String(src.theme || DEFAULT_PREFERENCES.theme).slice(0, 40),
    bottomToolbarHidden: Boolean(src.bottomToolbarHidden),
    infoMode: ['compact', 'full'].includes(src.infoMode) ? src.infoMode : DEFAULT_PREFERENCES.infoMode,
    tableSize,
    tableDayWidth: num(src.tableDayWidth, tableSize === 'screenshot' ? 42 : tableSize === 'classroom' ? 52 : 48, 38, 96),
    tableRowHeight: num(src.tableRowHeight, tableSize === 'screenshot' ? 72 : tableSize === 'classroom' ? 78 : 118, 58, 160),
    tableFontSize: num(src.tableFontSize, tableSize === 'screenshot' ? 10 : 16, 9, 20),
    layoutCustomized: Boolean(src.layoutCustomized),
    hideFifthSlot: Boolean(src.hideFifthSlot),
    courseSettings,
    reminderSettings
  };
}

function ensureUserPreferences(user) {
  if (!user) return sanitizePreferences({});
  user.preferences = sanitizePreferences(user.preferences || {});
  return user.preferences;
}

function accountIdForUser(user) {
  return user?.accountId || user?.id || '';
}

function accountForUser(db, userId, accountId) {
  return (db.accounts || []).find((account) => account.id === accountId && account.userId === userId) || null;
}

function publicUser(user, accountId = accountIdForUser(user)) {
  return {
    id: user.id,
    accountId,
    username: user.username,
    name: user.name,
    role: user.role,
    switchKey: user.switchKey
  };
}

function createAccountFromUser(user) {
  const accountId = accountIdForUser(user);
  return {
    id: accountId,
    userId: user.id,
    username: user.username,
    name: user.name,
    role: user.role || 'user',
    switchKey: user.switchKey || '',
    status: 'active',
    createdAt: user.createdAt || new Date().toISOString(),
    updatedAt: user.updatedAt || user.createdAt || new Date().toISOString()
  };
}

function buildTermKey(accountId, xnm, xqm) {
  return `${String(accountId || '').trim()}:${String(xnm || '').trim()}:${String(xqm || '').trim()}`;
}

function legacyTermKey(accountId) {
  return `${String(accountId || '').trim()}:legacy`;
}

function normalizeTotalWeeks(value, fallback = DEFAULT_TOTAL_WEEKS) {
  const weeks = Number(value);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 60) return fallback;
  return weeks;
}

function normalizeDateText(value = '') {
  const text = String(value || '').trim();
  return /^20\d{2}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function normalizeLegacyCourseTerm(course, accountId) {
  let xnm = String(course.xnm || '').trim();
  let xqm = String(course.xqm || '').trim();
  const oldTermKey = String(course.termKey || '').trim();
  if ((!xnm || !xqm) && /^\d{4}:\d{1,4}$/.test(oldTermKey)) [xnm, xqm] = oldTermKey.split(':');
  if (xnm && xqm) {
    return {
      termKey: buildTermKey(accountId, xnm, xqm),
      xnm,
      xqm,
      selectedTermLabel: String(course.selectedTermLabel || `${xnm}/${xqm}`).trim()
    };
  }
  return { termKey: legacyTermKey(accountId), xnm: '', xqm: '', selectedTermLabel: '历史课程' };
}

function migrateDbToV38(input = {}) {
  const db = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const now = new Date().toISOString();
  db.meta = db.meta && typeof db.meta === 'object' && !Array.isArray(db.meta) ? db.meta : {};
  db.meta.appVersion = APP_VERSION;
  db.meta.schemaVersion = DB_SCHEMA_VERSION;
  db.meta.storageMode = MYSQL_MIRROR_ENABLED ? 'json-primary-mysql-mirror-v41' : 'json-term-isolated-v41';
  db.meta.storageDriver = 'json';
  db.meta.schemaNote = 'v41 以 db.json 为主存储；课程按 accountId + termKey 隔离，MySQL 仅作镜像。';

  if (!Array.isArray(db.slots) || db.slots.length < 12) db.slots = DEFAULT_12_SLOTS;
  db.slots = normalizeSlotsInput(db.slots, DEFAULT_12_SLOTS);
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.sessions)) db.sessions = [];
  if (!Array.isArray(db.courses)) db.courses = [];
  if (!Array.isArray(db.feedbacks)) db.feedbacks = [];
  if (!Array.isArray(db.importCodes)) db.importCodes = [];
  if (!Array.isArray(db.backups)) db.backups = [];
  if (!Array.isArray(db.terms)) db.terms = [];

  const userIds = new Set();
  for (const user of db.users) {
    if (!user || typeof user !== 'object') continue;
    if (!user.id) user.id = uid('u');
    userIds.add(user.id);
    user.accountId = accountIdForUser(user);
    ensureUserSwitchKey(user);
    ensureUserPreferences(user);
    if (Array.isArray(user.slots)) user.slots = normalizeSlotsInput(user.slots, db.slots);
    if (!user.createdAt) user.createdAt = now;
  }

  const accountMap = new Map();
  if (Array.isArray(db.accounts)) {
    for (const account of db.accounts) {
      if (account && typeof account === 'object' && account.id) accountMap.set(account.id, account);
    }
  }
  for (const user of db.users) {
    if (!user || !user.id) continue;
    const base = createAccountFromUser(user);
    accountMap.set(base.id, { ...(accountMap.get(base.id) || {}), ...base });
  }
  db.accounts = [...accountMap.values()].filter((account) => account && account.id && userIds.has(account.userId));

  const accountIdsByUser = new Map();
  const accountOwners = new Map();
  for (const account of db.accounts) {
    accountOwners.set(account.id, account.userId);
    const ids = accountIdsByUser.get(account.userId) || [];
    ids.push(account.id);
    accountIdsByUser.set(account.userId, ids);
  }
  const migrationWarnings = new Map((Array.isArray(db.meta.migrationWarnings) ? db.meta.migrationWarnings : [])
    .filter((warning) => warning && warning.code && warning.entityType && warning.id)
    .map((warning) => [`${warning.code}:${warning.entityType}:${warning.id}`, warning]));
  function warnUnresolved(entityType, entity, message) {
    const id = String(entity?.id || entity?.token || entity?.code || 'unknown');
    const warning = { code: 'ACCOUNT_SCOPE_UNRESOLVED', entityType, id, message };
    migrationWarnings.set(`${warning.code}:${entityType}:${id}`, warning);
  }
  function resolveLegacyScope(entityType, entity) {
    if (!entity || typeof entity !== 'object') return entity;
    const scoped = { ...entity };
    const owner = scoped.accountId ? accountOwners.get(scoped.accountId) : '';
    if (scoped.accountId && !scoped.userId && owner) scoped.userId = owner;
    if (!scoped.accountId && scoped.userId) {
      const candidates = accountIdsByUser.get(scoped.userId) || [];
      if (candidates.length === 1) scoped.accountId = candidates[0];
      else warnUnresolved(entityType, scoped, `userId ${scoped.userId} cannot be mapped to exactly one accountId`);
    }
    if (!scoped.accountId || !scoped.userId || accountOwners.get(scoped.accountId) !== scoped.userId) {
      warnUnresolved(entityType, scoped, 'accountId and userId ownership could not be verified');
    }
    return scoped;
  }

  const settingMap = new Map();
  const unresolvedSettings = [];
  if (Array.isArray(db.settings)) {
    for (const rawSetting of db.settings) {
      const setting = resolveLegacyScope('setting', rawSetting);
      if (setting && accountOwners.get(setting.accountId) === setting.userId) settingMap.set(setting.accountId, setting);
      else if (setting && typeof setting === 'object') unresolvedSettings.push(setting);
    }
  }
  const reminderMap = new Map();
  const unresolvedReminders = [];
  if (Array.isArray(db.reminders)) {
    for (const rawReminder of db.reminders) {
      const reminder = resolveLegacyScope('reminder', rawReminder);
      if (reminder && accountOwners.get(reminder.accountId) === reminder.userId) reminderMap.set(reminder.accountId, reminder);
      else if (reminder && typeof reminder === 'object') unresolvedReminders.push(reminder);
    }
  }
  for (const user of db.users) {
    if (!user || !user.id) continue;
    const accountId = accountIdForUser(user);
    const legacyPreferences = ensureUserPreferences(user);
    const setting = settingMap.get(accountId) || {};
    const reminder = reminderMap.get(accountId) || {};
    const preferences = sanitizePreferences(setting.preferences || legacyPreferences);
    preferences.reminderSettings = sanitizePreferences({
      reminderSettings: reminder.settings || preferences.reminderSettings
    }).reminderSettings;
    const accountSlots = Array.isArray(setting.slots)
      ? normalizeSlotsInput(setting.slots, db.slots)
      : Array.isArray(user.slots)
        ? normalizeSlotsInput(user.slots, db.slots)
        : null;
    user.preferences = preferences;
    if (accountSlots) user.slots = accountSlots;
    else delete user.slots;
    settingMap.set(accountId, {
      id: setting.id || `set_${accountId}`,
      accountId,
      userId: user.id,
      preferences,
      slots: accountSlots,
      updatedAt: setting.updatedAt || now
    });
    reminderMap.set(accountId, {
      id: reminder.id || `rem_${accountId}`,
      accountId,
      userId: user.id,
      settings: preferences.reminderSettings || {},
      updatedAt: reminder.updatedAt || now
    });
  }
  db.settings = [...settingMap.values(), ...unresolvedSettings]
    .filter((setting) => setting && typeof setting === 'object');
  db.reminders = [...reminderMap.values(), ...unresolvedReminders]
    .filter((reminder) => reminder && typeof reminder === 'object');

  db.courses = db.courses
    .filter((course) => course && typeof course === 'object')
    .map((course) => resolveLegacyScope('course', course))
    .map((course) => {
      if (!course.accountId || accountOwners.get(course.accountId) !== course.userId) return course;
      const term = normalizeLegacyCourseTerm(course, course.accountId);
      if (!course.termKey || course.termKey !== term.termKey) {
        const warning = {
          code: 'TERM_SCOPE_NORMALIZED',
          entityType: 'course',
          id: String(course.id || 'unknown'),
          message: term.xnm && term.xqm ? '旧课程已按 xnm/xqm 迁移到账号学期 termKey' : '无法推断学期的旧课程已保留在 legacy termKey'
        };
        migrationWarnings.set(`${warning.code}:course:${warning.id}`, warning);
      }
      return { ...course, ...term };
    });

  // v41：把旧版“每节一条”的物理记录幂等折叠为一条逻辑节次范围；无法确认账号归属的记录原样保留。
  const scopedCourses = db.courses.filter((course) => course.accountId && course.termKey && accountOwners.get(course.accountId) === course.userId);
  const unresolvedCourses = db.courses.filter((course) => !scopedCourses.includes(course));
  const consolidatedCourses = mergeCourseRecords(scopedCourses, { separateSources: true }).courses;
  if (consolidatedCourses.length < scopedCourses.length) {
    const warning = {
      code: 'COURSE_RECORDS_CONSOLIDATED',
      entityType: 'course',
      id: 'all',
      message: `已将 ${scopedCourses.length} 条逐节/重复课程安全折叠为 ${consolidatedCourses.length} 条逻辑课程范围`
    };
    migrationWarnings.set(`${warning.code}:course:${warning.id}`, warning);
  }
  db.courses = [...consolidatedCourses, ...unresolvedCourses];

  const termMap = new Map();
  for (const rawTerm of db.terms) {
    if (!rawTerm || typeof rawTerm !== 'object') continue;
    const accountId = String(rawTerm.accountId || '').trim();
    const userId = String(rawTerm.userId || accountOwners.get(accountId) || '').trim();
    if (!accountId || accountOwners.get(accountId) !== userId) continue;
    const xnm = String(rawTerm.xnm || '').trim();
    const xqm = String(rawTerm.xqm || '').trim();
    const termKey = xnm && xqm ? buildTermKey(accountId, xnm, xqm) : legacyTermKey(accountId);
    termMap.set(termKey, {
      id: String(rawTerm.id || `term_${crypto.createHash('sha1').update(termKey).digest('hex').slice(0, 16)}`),
      userId,
      accountId,
      termKey,
      xnm,
      xqm,
      selectedTermLabel: String(rawTerm.selectedTermLabel || rawTerm.label || (xnm && xqm ? `${xnm}/${xqm}` : '历史课程')).trim(),
      termStart: normalizeDateText(rawTerm.termStart),
      totalWeeks: normalizeTotalWeeks(rawTerm.totalWeeks),
      totalWeeksSource: String(rawTerm.totalWeeksSource || 'saved').trim() || 'saved',
      createdAt: rawTerm.createdAt || now,
      updatedAt: rawTerm.updatedAt || now
    });
  }

  for (const course of db.courses) {
    if (!course.accountId || accountOwners.get(course.accountId) !== course.userId || !course.termKey) continue;
    const existing = termMap.get(course.termKey);
    const maxCourseWeek = Math.max(0, ...(Array.isArray(course.weeks) ? course.weeks.map(Number).filter(Number.isFinite) : []));
    if (existing) {
      if (existing.totalWeeksSource === 'course-max-week' && maxCourseWeek > existing.totalWeeks) {
        existing.totalWeeks = normalizeTotalWeeks(maxCourseWeek, existing.totalWeeks);
      }
      continue;
    }
    termMap.set(course.termKey, {
      id: `term_${crypto.createHash('sha1').update(course.termKey).digest('hex').slice(0, 16)}`,
      userId: course.userId,
      accountId: course.accountId,
      termKey: course.termKey,
      xnm: String(course.xnm || ''),
      xqm: String(course.xqm || ''),
      selectedTermLabel: String(course.selectedTermLabel || (course.xnm && course.xqm ? `${course.xnm}/${course.xqm}` : '历史课程')),
      termStart: '',
      totalWeeks: maxCourseWeek || normalizeTotalWeeks(db.meta.totalWeeks),
      totalWeeksSource: maxCourseWeek ? 'course-max-week' : 'legacy-default',
      createdAt: now,
      updatedAt: now
    });
  }

  for (const account of db.accounts) {
    const accountTerms = [...termMap.values()].filter((term) => term.accountId === account.id);
    if (!accountTerms.length) {
      const termKey = legacyTermKey(account.id);
      termMap.set(termKey, {
        id: `term_${crypto.createHash('sha1').update(termKey).digest('hex').slice(0, 16)}`,
        userId: account.userId,
        accountId: account.id,
        termKey,
        xnm: '',
        xqm: '',
        selectedTermLabel: '历史课程',
        termStart: '',
        totalWeeks: normalizeTotalWeeks(db.meta.totalWeeks),
        totalWeeksSource: 'legacy-default',
        createdAt: now,
        updatedAt: now
      });
    }
    const refreshedTerms = [...termMap.values()].filter((term) => term.accountId === account.id);
    const validExisting = refreshedTerms.find((term) => term.termKey === account.activeTermKey);
    const latestImport = db.importCodes
      .filter((item) => item.accountId === account.id && item.usedAt && item.xnm && item.xqm)
      .sort((a, b) => String(b.usedAt).localeCompare(String(a.usedAt)))[0];
    const importedKey = latestImport ? buildTermKey(account.id, latestImport.xnm, latestImport.xqm) : '';
    const importedTerm = refreshedTerms.find((term) => term.termKey === importedKey);
    const activeTerm = validExisting || importedTerm || refreshedTerms.find((term) => term.xnm && term.xqm) || refreshedTerms[0];
    account.activeTermKey = activeTerm.termKey;

    const oldCourseSettings = settingMap.get(account.id)?.preferences?.courseSettings || {};
    if (activeTerm && oldCourseSettings) {
      if (oldCourseSettings.totalWeeks && activeTerm.totalWeeksSource === 'legacy-default') {
        activeTerm.totalWeeks = normalizeTotalWeeks(oldCourseSettings.totalWeeks, activeTerm.totalWeeks);
        activeTerm.totalWeeksSource = 'legacy-account-setting';
      }
      if (oldCourseSettings.termStart && !activeTerm.termStart) activeTerm.termStart = normalizeDateText(oldCourseSettings.termStart);
    }
  }
  db.terms = [...termMap.values()];

  db.sessions = db.sessions
    .filter((session) => session && typeof session === 'object' && session.token)
    .map((session) => resolveLegacyScope('session', session));

  db.feedbacks = db.feedbacks.map((feedback) => resolveLegacyScope('feedback', feedback));
  db.importCodes = db.importCodes.map((item) => resolveLegacyScope('importCode', item));
  db.backups = db.backups.map((backup) => resolveLegacyScope('backup', backup));
  db.meta.migrationWarnings = [...migrationWarnings.values()];
  return db;
}

function courseBelongsToAccount(course = {}, accountId = '') {
  return Boolean(accountId) && course.accountId === accountId;
}

function allCoursesForAccount(db, accountId) {
  return (Array.isArray(db.courses) ? db.courses : []).filter((course) => courseBelongsToAccount(course, accountId));
}

function termsForAccount(db, accountId) {
  return (Array.isArray(db.terms) ? db.terms : []).filter((term) => term.accountId === accountId);
}

function activeTermForAccount(db, accountId) {
  const account = (db.accounts || []).find((item) => item.id === accountId);
  const terms = termsForAccount(db, accountId);
  return terms.find((term) => term.termKey === account?.activeTermKey) || terms[0] || null;
}

function coursesForAccount(db, accountId, termKey = activeTermForAccount(db, accountId)?.termKey || '') {
  if (!termKey) return [];
  const scoped = allCoursesForAccount(db, accountId).filter((course) => course.termKey === termKey);
  // 输出层忽略存储来源合并逻辑课程；底层仍保留 source 边界，保证 jwxt replace 不会吞掉手工课程。
  return buildCourseDisplayRecords(mergeCourseRecords(scoped).courses);
}

function retainedLogicalCourse(db, target) {
  const logical = coursesForAccount(db, target.accountId, target.termKey);
  const byId = logical.find((course) => course.id === target.id);
  if (byId) return byId;
  const byUnderlyingId = logical.find((course) => Array.isArray(course.underlyingIds) && course.underlyingIds.includes(target.id));
  if (byUnderlyingId) return byUnderlyingId;
  const targetStart = Number(target.startSlot ?? target.slot);
  const targetEnd = Number(target.endSlot ?? targetStart);
  return logical.find((course) => {
    const courseStart = Number(course.startSlot ?? course.slot);
    const courseEnd = Number(course.endSlot ?? courseStart);
    if (courseStart > targetStart || courseEnd < targetEnd) return false;
    const projectedRange = { ...course, slot: targetStart, startSlot: targetStart, endSlot: targetEnd };
    return mergeCourseRecords([projectedRange, target]).courses.length === 1;
  }) || null;
}

function publicTerm(db, term) {
  if (!term) return null;
  return {
    termKey: term.termKey,
    xnm: term.xnm || '',
    xqm: term.xqm || '',
    selectedTermLabel: term.selectedTermLabel || '历史课程',
    label: term.selectedTermLabel || '历史课程',
    termStart: term.termStart || '',
    totalWeeks: normalizeTotalWeeks(term.totalWeeks),
    totalWeeksSource: term.totalWeeksSource || 'saved',
    courseCount: coursesForAccount(db, term.accountId, term.termKey).length
  };
}

function activeTermPayload(db, accountId) {
  const activeTerm = activeTermForAccount(db, accountId);
  return {
    activeTerm: publicTerm(db, activeTerm),
    availableTerms: termsForAccount(db, accountId)
      .map((term) => publicTerm(db, term))
      .sort((a, b) => String(b.xnm || '').localeCompare(String(a.xnm || '')) || String(b.xqm || '').localeCompare(String(a.xqm || ''))),
    courses: coursesForAccount(db, accountId, activeTerm?.termKey)
  };
}

function settingForAccount(db, userId, accountId) {
  return (db.settings || []).find((setting) => setting.accountId === accountId && setting.userId === userId) || null;
}

function reminderForAccount(db, userId, accountId) {
  return (db.reminders || []).find((reminder) => reminder.accountId === accountId && reminder.userId === userId) || null;
}

function firstNonEmptyCourseText(...values) {
  for (const value of values) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}


function normalizeCourse(input, userId, accountId, term = null) {
  const weekText = String(input.weekText || input.weekPattern || '').trim();
  const parsed = parseWeeksDetailed(input.weeks, weekText, { maxWeeks: 60 });
  const scopedTerm = term || normalizeLegacyCourseTerm(input, accountId);
  const requestedSlot = Number(input.slot ?? input.startSlot ?? input.startSection ?? 0);
  const requestedStart = Number(input.startSlot ?? input.startSection ?? requestedSlot);
  const requestedEnd = Number(input.endSlot ?? input.endSection ?? requestedStart);
  const startSlot = Number.isInteger(requestedStart) && requestedStart >= 1 && requestedStart <= 12 ? requestedStart : 0;
  const endSlot = Number.isInteger(requestedEnd) && requestedEnd >= startSlot && requestedEnd <= 12 ? requestedEnd : startSlot;
  return {
    id: input.id || uid('c'),
    userId,
    accountId: String(accountId || '').trim(),
    day: Number(input.day ?? input.weekday),
    slot: startSlot,
    name: firstNonEmptyCourseText(input.name, input.courseName),
    shortName: String(input.shortName || '').trim(),
    teacher: firstNonEmptyCourseText(input.teacher),
    location: firstNonEmptyCourseText(input.location, input.room),
    classGroup: String(input.classGroup || '').trim(),
    weekText: parsed.normalizedWeekText || weekText,
    weeks: parsed.baseWeeks,
    oddEven: input.oddEven || parsed.oddEven || 'all',
    category: input.category || 'custom',
    source: input.source || 'manual',
    sourceDetail: String(input.sourceDetail || '').slice(0, 200),
    sourceIndex: Number.isInteger(Number(input.sourceIndex)) ? Number(input.sourceIndex) : null,
    startSlot,
    endSlot,
    termKey: String(scopedTerm.termKey || input.termKey || legacyTermKey(accountId)).slice(0, 160),
    xnm: String(scopedTerm.xnm || input.xnm || '').slice(0, 20),
    xqm: String(scopedTerm.xqm || input.xqm || '').slice(0, 20),
    selectedTermLabel: String(scopedTerm.selectedTermLabel || input.selectedTermLabel || '历史课程').slice(0, 120),
    isAdjusted: Boolean(input.isAdjusted),
    importTraceId: String(input.importTraceId || '').slice(0, 80)
  };
}


function normalizeSlotsInput(slots, fallback = []) {
  const source = Array.isArray(slots) && slots.length ? slots : fallback;
  return source.map((item, index) => {
    const slot = Number(item.slot || index + 1);
    const start = String(item.start || String(item.range || '').split('-')[0] || '').trim();
    const end = String(item.end || String(item.range || '').split('-')[1] || '').trim();
    return {
      slot,
      label: String(item.label || `第${slot}节`).trim(),
      range: String(item.range || (start && end ? `${start}-${end}` : '')).trim(),
      start,
      end
    };
  }).filter((item) => item.slot && item.label);
}

function isValidTimeText(value = '') {
  return /^\d{2}:\d{2}$/.test(String(value || ''));
}

function timeTextToMinutes(value = '') {
  const [h, m] = String(value || '').split(':').map(Number);
  return h * 60 + m;
}

function makeImportCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function ensureImportCodes(db) {
  if (!Array.isArray(db.importCodes)) db.importCodes = [];
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  // 保留近期已使用/过期记录，才能准确区分 USED 与 EXPIRED，而不是统一返回“不存在”。
  db.importCodes = db.importCodes.filter((item) => {
    const createdAt = new Date(item?.createdAt || item?.expiresAt || 0).getTime();
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  });
}

async function fetchJwxtScheduleByPuppeteer({ username, password, xnm, xqm }) {
  const puppeteer = (await import('puppeteer')).default;
  const baseUrl = 'http://211.64.47.165';
  const loginUrl = `${baseUrl}/jwglxt/xtgl/index_initMenu.html`;
  const fallbackLoginUrl = `${baseUrl}/jwglxt/xtgl/login_slogin.html?language=zh_CN`;
  const schedulePath = '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151';
  const autoLogin = Boolean(username && password);
  const profileDir = path.join(__dirname, '..', '.jwxt-browser-profiles', uid('profile'));

  const possibleBrowserPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);

  const executablePath = possibleBrowserPaths.find((p) => fs.existsSync(p));

  const browser = await puppeteer.launch({
    // 同学远程导入时不弹窗口；本机手动导入时保留窗口。
    headless: autoLogin ? true : false,
    ...(executablePath ? { executablePath } : {}),
    userDataDir: profileDir,
    ignoreHTTPSErrors: true,
    defaultViewport: { width: 1280, height: 900 },
    args: [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,IsolateOrigins,site-per-process',
      '--allow-running-insecure-content',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    page.on('dialog', async (dialog) => {
      try { await dialog.accept(); } catch {}
    });

    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (err) {
      await page.goto(fallbackLoginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    await page.evaluate(() => {
      document.title = '小德课表正在登录教务系统，请稍候';
    }).catch(() => {});

    if (autoLogin) {
      const typeFirst = async (selectors, value) => {
        for (const selector of selectors) {
          const el = await page.$(selector).catch(() => null);
          if (el) {
            await el.click({ clickCount: 3 }).catch(() => {});
            await el.press('Backspace').catch(() => {});
            await el.type(String(value), { delay: 20 });
            return true;
          }
        }
        return false;
      };

      const hasUser = await typeFirst(['#yhm', 'input[name="yhm"]', 'input[name="username"]', 'input[type="text"]'], username);
      const hasPass = await typeFirst(['#mm', 'input[name="mm"]', 'input[type="password"]'], password);

      if (!hasUser || !hasPass) {
        throw new Error('没有找到教务系统登录框，可能页面结构变化或访问被拦截');
      }

      const clicked = await page.evaluate(() => {
        const selectors = ['#dl', '#login', 'button[type="submit"]', 'input[type="submit"]', '.login-btn', '.btn-primary'];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) { el.click(); return true; }
        }
        const candidates = Array.from(document.querySelectorAll('button,input,a'));
        const btn = candidates.find((el) => /登录|登\s*录|login/i.test(el.innerText || el.value || el.textContent || ''));
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (!clicked) {
        await page.keyboard.press('Enter');
      }
    }

    // 手动模式：用户在弹出的浏览器窗口里自己登录。
    // 自动模式：Puppeteer 已输入用户名密码并点击登录。
    await page.waitForFunction(
      () => {
        const href = location.href;
        const text = document.body ? document.body.innerText || '' : '';
        return href.includes('/xtgl/index_initMenu.html') ||
          (!/login_slogin|xtgl\/login/i.test(href) && /欢迎|我的应用|信息查询|选课|课表/.test(text));
      },
      { timeout: autoLogin ? 90000 : 180000 }
    );

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const data = await page.evaluate(
      async ({ schedulePath, xnm, xqm }) => {
        const body = new URLSearchParams();
        if (!xnm || !xqm) throw new Error('缺少明确的教务学期参数');
        body.set('xnm', String(xnm));
        body.set('xqm', String(xqm));
        body.set('kzlx', 'ck');
        body.set('xsdm', '');
        body.set('kclbdm', '');

        const res = await fetch(schedulePath, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body
        });

        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`课表接口没有返回 JSON：${text.slice(0, 120)}`);
        }
      },
      { schedulePath, xnm, xqm }
    );

    return data;
  } catch (err) {
    if (autoLogin && /Waiting failed|timeout/i.test(String(err.message || err))) {
      throw new Error('教务系统登录超时：可能是账号密码错误、需要验证码，或教务系统限制访问');
    }
    throw err;
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

function authUser(req) {
  const token = req.headers['x-user-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
  if (!token) return null;
  const db = readDb();
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;
  const user = db.users.find((u) => u.id === session.userId);
  if (!user) return null;
  const accountId = session.accountId || accountIdForUser(user);
  const account = accountForUser(db, user.id, accountId);
  return account ? { user, account, accountId, session, token } : null;
}

function requireLogin(req, res, next) {
  const info = authUser(req);
  if (!info) return res.status(401).json({ ok: false, message: '请先登录' });
  // 普通接口的数据范围只来自已验证会话；客户端字段仅用于一致性校验。
  const requestedAccountId = req.body?.accountId ?? req.query?.accountId;
  const requestedUserId = req.body?.userId ?? req.query?.userId;
  if (requestedAccountId !== undefined && String(requestedAccountId) !== info.accountId) {
    return res.status(403).json({ ok: false, message: '请求 accountId 与当前会话不一致' });
  }
  if (requestedUserId !== undefined && String(requestedUserId) !== info.user.id) {
    return res.status(403).json({ ok: false, message: '请求 userId 与当前会话不一致' });
  }
  req.auth = info;
  next();
}

function requireAdmin(req, res, next) {
  const info = authUser(req);
  if (!info || info.user.role !== 'admin') return res.status(403).json({ ok: false, message: '需要管理员权限' });
  req.auth = info;
  next();
}

app.get('/api/health', (req, res) => {
  const db = readDb();
  const primaryCounts = {
    users: db.users?.length || 0,
    accounts: db.accounts?.length || 0,
    courses: db.courses?.length || 0,
    terms: db.terms?.length || 0,
    settings: db.settings?.length || 0,
    reminders: db.reminders?.length || 0
  };
  res.json({
    ok: true,
    service: 'xiaode-course-table',
    version: APP_VERSION,
    storage: {
      primary: 'db.json',
      primaryCounts,
      primaryMigrationWarnings: db.meta?.migrationWarnings || [],
      mysqlMirror: currentMysqlStorageStatus(),
      importDiagnostics: importDiagnosticsStore.status()
    },
    ...(process.env.NODE_ENV === 'test' ? { testAudit: { writeDbCallCount } } : {}),
    time: new Date().toISOString()
  });
});

app.get('/api/public/bootstrap', (req, res) => {
  const db = readDb();
  res.json({
    meta: db.meta,
    slots: db.slots,
    currentUser: null,
    courses: []
  });
});

app.post('/api/auth/register', (req, res) => {
  const { username, password, name } = req.body || {};
  const db = readDb();
  const cleanUsername = String(username || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  const cleanPassword = String(password || '');

  if (!cleanUsername || !cleanPassword || !cleanName) {
    return res.status(400).json({ ok: false, message: '用户名、姓名、密码都必填' });
  }
  if (cleanPassword.length < 4) {
    return res.status(400).json({ ok: false, message: '密码至少 4 位' });
  }
  if (db.users.some((u) => u.username === cleanUsername)) {
    return res.status(400).json({ ok: false, message: '用户名已存在' });
  }

  const user = {
    id: uid('u'),
    username: cleanUsername,
    password: cleanPassword,
    name: cleanName,
    role: 'user',
    switchKey: uid('switch'),
    preferences: sanitizePreferences({}),
    createdAt: new Date().toISOString()
  };
  user.accountId = accountIdForUser(user);
  db.users.push(user);
  const token = uid('token');
  db.sessions.push({ token, userId: user.id, accountId: user.accountId, createdAt: new Date().toISOString() });
  writeDb(db);

  res.json({
    ok: true,
    token,
    switchKey: user.switchKey,
    accountId: user.accountId,
    user: publicUser(user, user.accountId)
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const db = readDb();
  const user = db.users.find(
    (u) => u.username === String(username || '').trim().toLowerCase() && u.password === String(password || '')
  );
  if (!user) {
    return res.status(401).json({ ok: false, message: '用户名或密码错误' });
  }
  const token = uid('token');
  const switchKey = ensureUserSwitchKey(user);
  const accountId = accountIdForUser(user);
  db.sessions.push({ token, userId: user.id, accountId, createdAt: new Date().toISOString() });
  writeDb(db);
  res.json({
    ok: true,
    token,
    switchKey,
    accountId,
    user: publicUser(user, accountId)
  });
});

app.post('/api/auth/quick-switch', (req, res) => {
  const { username, switchKey, accountId: requestedAccountId } = req.body || {};
  const db = readDb();
  const cleanUsername = String(username || '').trim().toLowerCase();
  const user = db.users.find((u) => u.username === cleanUsername);
  if (!user || !user.switchKey || String(user.switchKey) !== String(switchKey || '')) {
    return res.status(401).json({ ok: false, message: '账号切换状态已过期，请重新登录一次' });
  }
  const accountId = accountIdForUser(user);
  if (requestedAccountId && String(requestedAccountId) !== accountId) {
    return res.status(401).json({ ok: false, message: '账号标识不匹配，请重新登录' });
  }
  const token = uid('token');
  db.sessions.push({ token, userId: user.id, accountId, createdAt: new Date().toISOString(), via: 'quick-switch' });
  writeDb(db);
  res.json({
    ok: true,
    token,
    switchKey: user.switchKey,
    accountId,
    user: publicUser(user, accountId)
  });
});

app.post('/api/auth/logout', requireLogin, (req, res) => {
  const db = readDb();
  db.sessions = db.sessions.filter((s) => s.token !== req.auth.token);
  writeDb(db);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireLogin, (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.user.id) || req.auth.user;
  const switchKey = ensureUserSwitchKey(user);
  const setting = settingForAccount(db, user.id, req.auth.accountId);
  const preferences = sanitizePreferences(setting?.preferences || user.preferences || {});
  const slots = Array.isArray(setting?.slots) ? normalizeSlotsInput(setting.slots, db.slots) : db.slots;
  const termState = activeTermPayload(db, req.auth.accountId);
  const activeTerm = termState.activeTerm;
  if (user && db.users.some((u) => u.id === user.id)) writeDb(db);
  res.json({
    ok: true,
    accountId: req.auth.accountId,
    user: publicUser(user, req.auth.accountId),
    meta: { ...db.meta, termStart: activeTerm?.termStart || '', totalWeeks: activeTerm?.totalWeeks || DEFAULT_TOTAL_WEEKS },
    slots,
    activeTerm,
    availableTerms: termState.availableTerms,
    termStart: activeTerm?.termStart || '',
    totalWeeks: activeTerm?.totalWeeks || DEFAULT_TOTAL_WEEKS,
    courses: termState.courses,
    preferences
  });
});

app.put('/api/my/active-term', requireLogin, (req, res) => {
  const termKey = String(req.body?.termKey || '').trim();
  if (!termKey) return res.status(400).json({ ok: false, message: 'termKey 不能为空' });
  const db = readDb();
  const account = accountForUser(db, req.auth.user.id, req.auth.accountId);
  const term = termsForAccount(db, req.auth.accountId).find((item) => item.termKey === termKey);
  if (!account || !term) return res.status(404).json({ ok: false, message: '学期不存在或不属于当前账号' });
  account.activeTermKey = term.termKey;
  account.updatedAt = new Date().toISOString();
  writeDb(db);
  const payload = activeTermPayload(db, req.auth.accountId);
  res.json({ ok: true, accountId: req.auth.accountId, ...payload });
});

app.put('/api/my/active-term/settings', requireLogin, (req, res) => {
  const db = readDb();
  const term = activeTermForAccount(db, req.auth.accountId);
  if (!term) return res.status(409).json({ ok: false, message: '当前账号没有激活学期' });
  const totalWeeks = Number(req.body?.totalWeeks);
  const termStart = String(req.body?.termStart || '').trim();
  if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > 60) {
    return res.status(400).json({ ok: false, message: '学期总周数必须是 1 到 60 的整数' });
  }
  if (termStart && !normalizeDateText(termStart)) return res.status(400).json({ ok: false, message: '开学日期格式应为 YYYY-MM-DD' });
  term.totalWeeks = totalWeeks;
  term.totalWeeksSource = 'manual';
  term.termStart = normalizeDateText(termStart);
  term.updatedAt = new Date().toISOString();
  writeDb(db);
  res.json({ ok: true, accountId: req.auth.accountId, activeTerm: publicTerm(db, term) });
});

app.put('/api/auth/password', requireLogin, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (String(req.auth.user.password) !== String(oldPassword || '')) {
    return res.status(400).json({ ok: false, message: '原密码不正确' });
  }
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ ok: false, message: '新密码至少 4 位' });
  }
  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.user.id);
  user.password = String(newPassword);
  writeDb(db);
  res.json({ ok: true, message: '密码已更新' });
});



app.put('/api/my/preferences', requireLogin, (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.user.id);
  if (!user) return res.status(404).json({ ok: false, message: '账号不存在' });
  const setting = settingForAccount(db, user.id, req.auth.accountId);
  const reminder = reminderForAccount(db, user.id, req.auth.accountId);
  if (!setting || !reminder) return res.status(409).json({ ok: false, message: '账号设置记录不存在' });
  const preferences = sanitizePreferences(req.body?.preferences || req.body || {});
  setting.preferences = preferences;
  setting.updatedAt = new Date().toISOString();
  reminder.settings = preferences.reminderSettings;
  reminder.updatedAt = setting.updatedAt;
  if (accountIdForUser(user) === req.auth.accountId) user.preferences = preferences;
  writeDb(db);
  res.json({ ok: true, accountId: req.auth.accountId, preferences });
});

app.put('/api/my/slots', requireLogin, (req, res) => {
  const { slots } = req.body || {};
  if (!Array.isArray(slots) || !slots.length) {
    return res.status(400).json({ ok: false, message: '节次时间不能为空' });
  }
  const normalized = normalizeSlotsInput(slots);
  if (!normalized.length) {
    return res.status(400).json({ ok: false, message: '节次格式不正确' });
  }
  for (const slot of normalized) {
    if (!isValidTimeText(slot.start) || !isValidTimeText(slot.end)) {
      return res.status(400).json({ ok: false, message: `${slot.label} 的开始/结束时间不完整` });
    }
    if (timeTextToMinutes(slot.start) >= timeTextToMinutes(slot.end)) {
      return res.status(400).json({ ok: false, message: `${slot.label} 的结束时间要晚于开始时间` });
    }
    slot.range = `${slot.start}-${slot.end}`;
  }
  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.user.id);
  if (!user) return res.status(404).json({ ok: false, message: '账号不存在' });
  const setting = settingForAccount(db, user.id, req.auth.accountId);
  if (!setting) return res.status(409).json({ ok: false, message: '账号设置记录不存在' });
  setting.slots = normalized;
  setting.updatedAt = new Date().toISOString();
  if (accountIdForUser(user) === req.auth.accountId) user.slots = normalized;
  writeDb(db);
  res.json({ ok: true, accountId: req.auth.accountId, slots: normalized });
});

app.delete('/api/my/slots', requireLogin, (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.user.id);
  if (!user) return res.status(404).json({ ok: false, message: '账号不存在' });
  const setting = settingForAccount(db, user.id, req.auth.accountId);
  if (!setting) return res.status(409).json({ ok: false, message: '账号设置记录不存在' });
  setting.slots = null;
  setting.updatedAt = new Date().toISOString();
  if (accountIdForUser(user) === req.auth.accountId) delete user.slots;
  writeDb(db);
  res.json({ ok: true, accountId: req.auth.accountId, slots: db.slots });
});


function buildUserBackup(db, user, accountId) {
  const setting = settingForAccount(db, user.id, accountId);
  const termState = activeTermPayload(db, accountId);
  return {
    app: 'xiaode-course-table',
    appVersion: APP_VERSION,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    user: {
      username: user.username,
      name: user.name
    },
    account: {
      id: accountId,
      name: user.name,
      username: user.username
    },
    preferences: sanitizePreferences(setting?.preferences || user.preferences || {}),
    meta: { ...db.meta, termStart: termState.activeTerm?.termStart || '', totalWeeks: termState.activeTerm?.totalWeeks || DEFAULT_TOTAL_WEEKS },
    activeTerm: termState.activeTerm,
    availableTerms: termState.availableTerms,
    slots: Array.isArray(setting?.slots) ? normalizeSlotsInput(setting.slots, db.slots) : db.slots,
    courses: coursesForAccount(db, accountId)
      .map((course) => {
        const { userId, accountId, ...rest } = course;
        return rest;
      })
  };
}

function finishImportTrace(trace, patch = {}) {
  try {
    return importDiagnosticsStore.finish(trace, patch);
  } catch (err) {
    // 诊断持久化不能反向影响 JSON 主业务。
    console.error('[import-diagnostics] 保存脱敏诊断失败：', String(err?.message || err));
    return { ...trace, ...patch };
  }
}

function importFailure(trace, status, reasonCode, message, patch = {}) {
  const completed = finishImportTrace(trace, {
    status: 'failed',
    reasonCode,
    message,
    errors: [...(patch.errors || trace.errors || []), { reasonCode, message }],
    ...patch
  });
  return {
    status,
    body: {
      ok: false,
      traceId: trace.traceId,
      reasonCode,
      message,
      summary: completed.summary || trace.summary,
      warnings: completed.warnings || [],
      requestedTerm: completed.requestedTerm || null,
      effectiveTerm: completed.effectiveTerm || null,
      refreshRequired: false
    }
  };
}

function validateImportTermParams(input = {}, { requireLabel = true } = {}) {
  const xnm = String(input.xnm ?? '').trim();
  const xqm = String(input.xqm ?? '').trim();
  const selectedTermLabel = String(input.selectedTermLabel ?? '').trim();
  if (!xnm || !xqm || (requireLabel && !selectedTermLabel)) {
    return { ok: false, reasonCode: IMPORT_REASON_CODES.MISSING_TERM_PARAMS, message: '必须明确选择教务学年和学期，不能使用默认学期。' };
  }
  const year = Number(xnm);
  if (!/^\d{4}$/.test(xnm) || year < 2000 || year > 2100 || !/^\d{1,4}$/.test(xqm) || selectedTermLabel.length > 120) {
    return { ok: false, reasonCode: IMPORT_REASON_CODES.INVALID_TERM_PARAMS, message: '教务学期参数格式无效，请重新选择教务系统提供的原始选项。' };
  }
  return { ok: true, xnm, xqm, selectedTermLabel };
}

function termView(xnm, xqm, label, verifiedByResponse = false) {
  return { xnm: String(xnm || ''), xqm: String(xqm || ''), label: String(label || ''), verifiedByResponse: Boolean(verifiedByResponse) };
}

function resolveEffectiveImportTerm(analysis, requested) {
  const responseTerms = Array.isArray(analysis.responseTerms) ? analysis.responseTerms : [];
  const acceptedResponseTerms = Array.isArray(analysis.acceptedResponseTerms) ? analysis.acceptedResponseTerms : [];
  if (!acceptedResponseTerms.length) {
    if (analysis.filteredWrongTermCount > 0) {
      const effective = responseTerms.length === 1 ? responseTerms[0] : { xnm: '', xqm: '' };
      return {
        ok: false,
        requestedTerm: termView(requested.xnm, requested.xqm, requested.selectedTermLabel),
        effectiveTerm: termView(effective.xnm, effective.xqm, effective.xnm && effective.xqm ? `${effective.xnm}/${effective.xqm}` : '响应不属于所选学期', true),
        responseTerms
      };
    }
    return { ok: true, requestedTerm: termView(requested.xnm, requested.xqm, requested.selectedTermLabel), effectiveTerm: termView('', '', '', false) };
  }
  const mismatched = acceptedResponseTerms.filter((term) => term.xnm !== requested.xnm || term.xqm !== requested.xqm);
  if (mismatched.length || acceptedResponseTerms.length !== 1) {
    const effective = acceptedResponseTerms.length === 1 ? acceptedResponseTerms[0] : { xnm: '', xqm: '' };
    return {
      ok: false,
      requestedTerm: termView(requested.xnm, requested.xqm, requested.selectedTermLabel),
      effectiveTerm: termView(effective.xnm, effective.xqm, effective.xnm && effective.xqm ? `${effective.xnm}/${effective.xqm}` : '响应包含多个学期', true),
      responseTerms
    };
  }
  return {
    ok: true,
    requestedTerm: termView(requested.xnm, requested.xqm, requested.selectedTermLabel),
    effectiveTerm: termView(requested.xnm, requested.xqm, requested.selectedTermLabel, true),
    responseTerms
  };
}

function isJwxtCourseForTerm(course, accountId, termKey) {
  return courseBelongsToAccount(course, accountId)
    && course.source === 'jwxt'
    && course.termKey === termKey;
}

function addPreImportBackup(db, user, accountId, traceId, xnm, xqm) {
  if (!Array.isArray(db.backups)) db.backups = [];
  const entry = {
    id: uid('backup_import'),
    kind: 'pre-import',
    userId: user.id,
    accountId,
    traceId,
    xnm: String(xnm || ''),
    xqm: String(xqm || ''),
    createdAt: new Date().toISOString(),
    backup: buildUserBackup(db, user, accountId)
  };
  const sameAccount = db.backups.filter((item) => item.accountId === accountId && item.kind === 'pre-import');
  const removeIds = new Set(sameAccount.slice(9).map((item) => item.id));
  db.backups = [entry, ...db.backups.filter((item) => !removeIds.has(item.id))];
  return entry.id;
}

function executeJwxtImport({ db, user, accountId, jwxtData, replace, xnm, xqm, selectedTermLabel, trace, importCode = '' }) {
  const requested = validateImportTermParams({ xnm, xqm, selectedTermLabel });
  if (!requested.ok) return importFailure(trace, 400, requested.reasonCode, requested.message);
  const termKey = buildTermKey(accountId, requested.xnm, requested.xqm);
  const existingTerm = termsForAccount(db, accountId).find((term) => term.termKey === termKey) || null;
  const analysis = analyzeJwxtImport(jwxtData, {
    traceId: trace.traceId,
    userId: user.id,
    accountId,
    termKey,
    xnm: requested.xnm,
    xqm: requested.xqm,
    selectedTermLabel: requested.selectedTermLabel,
    maxWeeks: 60
  });
  const traceBase = {
    rawResponseType: analysis.rawResponseType,
    candidateSources: analysis.candidateSources,
    sourceCounts: analysis.sourceCounts,
    unknownSourceCounts: analysis.unknownSourceCounts,
    rawCount: analysis.rawCount,
    acceptedCount: analysis.acceptedCount,
    filteredWrongTermCount: analysis.filteredWrongTermCount,
    filteredUnknownSourceCount: analysis.filteredUnknownSourceCount,
    importedCount: analysis.importedCount,
    candidates: analysis.candidates,
    mergeEvents: analysis.mergeEvents,
    summary: analysis.summary,
    warnings: analysis.warnings,
    errors: analysis.errors,
    timings: analysis.timings
  };
  const resolvedTerm = resolveEffectiveImportTerm(analysis, requested);
  const termTrace = {
    selectedTermLabel: requested.selectedTermLabel,
    requestedXnm: requested.xnm,
    requestedXqm: requested.xqm,
    effectiveXnm: resolvedTerm.effectiveTerm.xnm,
    effectiveXqm: resolvedTerm.effectiveTerm.xqm,
    requestedTerm: resolvedTerm.requestedTerm,
    effectiveTerm: resolvedTerm.effectiveTerm,
    responseTerms: resolvedTerm.responseTerms || [],
    incompleteResponseTermCount: analysis.incompleteResponseTermCount || 0
  };
  if (!resolvedTerm.ok) {
    return importFailure(trace, 422, IMPORT_REASON_CODES.TERM_RESPONSE_MISMATCH, '请求学期与教务响应课程学期不一致，未写入任何课程。', { ...traceBase, ...termTrace });
  }
  if (!analysis.summary.received) {
    return importFailure(trace, 422, IMPORT_REASON_CODES.UNSUPPORTED_STRUCTURE, '教务响应中没有找到候选课程数组。', { ...traceBase, ...termTrace });
  }
  if (!analysis.courses.length) {
    const reasonCode = analysis.errors[0]?.reasonCode || IMPORT_REASON_CODES.UNSUPPORTED_STRUCTURE;
    return importFailure(trace, 422, reasonCode, '已收到教务数据，但所有候选均未通过安全解析。', { ...traceBase, ...termTrace });
  }

  const courseMaxWeek = Math.max(0, ...analysis.courses.flatMap((course) => Array.isArray(course.weeks) ? course.weeks.map(Number).filter(Number.isFinite) : []));
  let totalWeeks = DEFAULT_TOTAL_WEEKS;
  let totalWeeksSource = 'default';
  if (analysis.explicitTotalWeeks) {
    totalWeeks = normalizeTotalWeeks(analysis.explicitTotalWeeks);
    totalWeeksSource = 'jwxt-response';
  } else if (courseMaxWeek) {
    totalWeeks = normalizeTotalWeeks(courseMaxWeek);
    totalWeeksSource = 'course-max-week';
  } else if (existingTerm?.totalWeeks) {
    totalWeeks = normalizeTotalWeeks(existingTerm.totalWeeks);
    totalWeeksSource = existingTerm.totalWeeksSource || 'saved';
  }
  const targetTerm = {
    termKey,
    xnm: requested.xnm,
    xqm: requested.xqm,
    selectedTermLabel: requested.selectedTermLabel
  };
  const normalized = analysis.courses
    .map((item) => normalizeCourse(item, user.id, accountId, targetTerm))
    .filter((course) => course.name && course.day >= 1 && course.day <= 7 && course.slot >= 1 && course.slot <= 12 && course.weeks.length);
  if (!normalized.length || normalized.some((course) => course.accountId !== accountId)) {
    return importFailure(trace, 422, IMPORT_REASON_CODES.ACCOUNT_MISMATCH, '规范化结果为空或 accountId 校验失败。', { ...traceBase, ...termTrace });
  }

  const beforeCount = coursesForAccount(db, accountId, termKey).length;
  const nextDb = cloneDb(db);
  const existingSameTerm = nextDb.courses.filter((course) => isJwxtCourseForTerm(course, accountId, termKey));
  const preserved = nextDb.courses.filter((course) => !isJwxtCourseForTerm(course, accountId, termKey));
  let importedCourses = normalized;
  let appendMergeEvents = [];
  let appendWarnings = [];
  if (!replace) {
    const appended = mergeCourseRecords([...existingSameTerm, ...normalized]);
    importedCourses = appended.courses;
    appendMergeEvents = appended.events;
    appendWarnings = appended.warnings;
  }
  const nextCourses = [...preserved, ...importedCourses];
  if (nextCourses.some((course) => !course.accountId) || normalized.some((course) => course.source !== 'jwxt')) {
    return importFailure(trace, 422, IMPORT_REASON_CODES.ACCOUNT_MISMATCH, '导入结果范围校验失败，旧课程保持不变。', { ...traceBase, ...termTrace });
  }

  addPreImportBackup(nextDb, user, accountId, trace.traceId, requested.xnm, requested.xqm);
  nextDb.courses = nextCourses;
  const importedAt = new Date().toISOString();
  const nextAccount = accountForUser(nextDb, user.id, accountId);
  if (!nextAccount) {
    return importFailure(trace, 422, IMPORT_REASON_CODES.ACCOUNT_MISMATCH, '导入账号不存在，旧课程保持不变。', { ...traceBase, ...termTrace });
  }
  const nextTerm = termsForAccount(nextDb, accountId).find((term) => term.termKey === termKey);
  const savedTerm = {
    id: nextTerm?.id || `term_${crypto.createHash('sha1').update(termKey).digest('hex').slice(0, 16)}`,
    userId: user.id,
    accountId,
    termKey,
    xnm: requested.xnm,
    xqm: requested.xqm,
    selectedTermLabel: requested.selectedTermLabel,
    termStart: analysis.explicitTermStart || nextTerm?.termStart || '',
    totalWeeks,
    totalWeeksSource,
    createdAt: nextTerm?.createdAt || importedAt,
    updatedAt: importedAt,
    lastImportTraceId: trace.traceId
  };
  nextDb.terms = [...termsForAccount(nextDb, accountId).filter((term) => term.termKey !== termKey), savedTerm, ...(nextDb.terms || []).filter((term) => term.accountId !== accountId)];
  nextAccount.activeTermKey = termKey;
  nextAccount.updatedAt = importedAt;
  if (importCode) {
    const record = nextDb.importCodes.find((item) => item.code === importCode);
    if (record) {
      record.usedAt = importedAt;
      record.traceId = trace.traceId;
      record.importedCount = normalized.length;
    }
  }
  nextDb.meta.lastAndroidImportAt = importedAt;
  nextDb.meta.lastAndroidImportUserId = user.id;
  nextDb.meta.lastAndroidImportAccountId = accountId;
  nextDb.meta.lastImportTraceId = trace.traceId;
  nextDb.meta.courseVersion = Number(nextDb.meta.courseVersion || 0) + 1;
  const afterCount = nextCourses.filter((course) => courseBelongsToAccount(course, accountId) && course.termKey === termKey).length;
  const summary = {
    ...analysis.summary,
    merged: analysis.summary.merged + appendMergeEvents.length,
    written: normalized.length,
    beforeCount,
    afterCount,
    rawCount: analysis.rawCount,
    acceptedCount: analysis.acceptedCount,
    filteredWrongTermCount: analysis.filteredWrongTermCount,
    filteredUnknownSourceCount: analysis.filteredUnknownSourceCount,
    importedCount: normalized.length
  };
  const writeStart = process.hrtime.bigint();
  try {
    writeDb(nextDb);
  } catch (err) {
    const writeMs = Number(process.hrtime.bigint() - writeStart) / 1_000_000;
    return importFailure(trace, 500, IMPORT_REASON_CODES.UNKNOWN, '写入 db.json 失败，旧课程未被替换。', {
      ...traceBase,
      ...termTrace,
      summary,
      timings: { ...analysis.timings, writeMs: Number(writeMs.toFixed(3)) }
    });
  }
  const writeMs = Number(process.hrtime.bigint() - writeStart) / 1_000_000;
  const warnings = [...analysis.warnings, ...appendWarnings];
  const completed = finishImportTrace(trace, {
    ...traceBase,
    ...termTrace,
    status: 'success',
    message: `收到 ${summary.received} 条，识别 ${summary.recognized} 条，写入 ${summary.written} 条，合并 ${summary.merged} 条，过滤 ${summary.filtered} 条。`,
    summary,
    warnings,
    importedCount: normalized.length,
    totalWeeks,
    totalWeeksSource,
    termStart: savedTerm.termStart,
    mergeEvents: [...analysis.mergeEvents, ...appendMergeEvents],
    timings: { ...analysis.timings, writeMs: Number(writeMs.toFixed(3)) }
  });
  return {
    status: 200,
    body: {
      ok: true,
      code: importCode ? 'IMPORT_CODE_OK' : 'IMPORT_OK',
      traceId: trace.traceId,
      summary,
      warnings,
      requestedTerm: resolvedTerm.requestedTerm,
      effectiveTerm: resolvedTerm.effectiveTerm,
      activeTerm: publicTerm(nextDb, savedTerm),
      totalWeeks,
      totalWeeksSource,
      termStart: savedTerm.termStart,
      refreshRequired: true,
      count: summary.written,
      rawCount: summary.received,
      convertedCount: summary.accepted,
      previousCount: beforeCount,
      afterCount,
      replace: Boolean(replace),
      importedAt,
      courseVersion: nextDb.meta.courseVersion,
      message: completed.message
    }
  };
}

function unpackBackupPayload(input = {}) {
  const backup = input && typeof input === 'object' && input.backup ? input.backup : input;
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    return { courses: [], slots: null };
  }
  const courses = Array.isArray(backup.courses)
    ? backup.courses
    : Array.isArray(backup.data?.courses)
      ? backup.data.courses
      : [];
  const slots = Array.isArray(backup.slots)
    ? backup.slots
    : Array.isArray(backup.data?.slots)
      ? backup.data.slots
      : null;
  return { courses, slots };
}

function normalizeBackupForAccount(input, userId, accountId, defaultSlots = [], term = null) {
  const { courses, slots } = unpackBackupPayload(input);
  const normalizedCourses = courses
    .map((item) => {
      const cloned = { ...(item || {}) };
      delete cloned.id;
      delete cloned.userId;
      delete cloned.accountId;
      delete cloned.termKey;
      return normalizeCourse(cloned, userId, accountId, term);
    })
    .filter((course) => course.name && course.day && course.slot);
  const normalizedSlots = Array.isArray(slots) && slots.length ? normalizeSlotsInput(slots, defaultSlots) : null;
  return { courses: normalizedCourses, slots: normalizedSlots };
}

app.get('/api/my/backup', requireLogin, (req, res) => {
  const db = readDb();
  res.json({ ok: true, accountId: req.auth.accountId, backup: buildUserBackup(db, req.auth.user, req.auth.accountId) });
});

app.post('/api/my/restore', requireLogin, (req, res) => {
  const { backup, mode = 'replace' } = req.body || {};
  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.user.id);
  if (!user) return res.status(404).json({ ok: false, message: '账号不存在' });

  const setting = settingForAccount(db, user.id, req.auth.accountId);
  const reminder = reminderForAccount(db, user.id, req.auth.accountId);
  if (!setting || !reminder) return res.status(409).json({ ok: false, message: '账号设置记录不存在' });
  const activeTerm = activeTermForAccount(db, req.auth.accountId);
  if (!activeTerm) return res.status(409).json({ ok: false, message: '当前账号没有激活学期' });
  const normalized = normalizeBackupForAccount(backup || req.body, user.id, req.auth.accountId, db.slots, activeTerm);
  if (!normalized.courses.length && !normalized.slots) {
    return res.status(400).json({ ok: false, message: '备份文件里没有可恢复的课程或节次时间' });
  }

  if (mode === 'replace') {
    db.courses = db.courses.filter((course) => !(courseBelongsToAccount(course, req.auth.accountId) && course.termKey === activeTerm.termKey));
  }
  db.courses = db.courses.concat(normalized.courses);
  if (normalized.slots) {
    setting.slots = normalized.slots;
    if (accountIdForUser(user) === req.auth.accountId) user.slots = normalized.slots;
  }
  const backupPayload = backup && typeof backup === 'object' ? backup : req.body;
  if (backupPayload?.preferences || backupPayload?.clientPreferences) {
    setting.preferences = sanitizePreferences(backupPayload.preferences || backupPayload.clientPreferences || {});
    reminder.settings = setting.preferences.reminderSettings;
    if (accountIdForUser(user) === req.auth.accountId) user.preferences = setting.preferences;
  }
  setting.updatedAt = new Date().toISOString();
  reminder.updatedAt = setting.updatedAt;
  writeDb(db);
  res.json({ ok: true, mode, count: normalized.courses.length, slotsRestored: Boolean(normalized.slots) });
});

app.post('/api/my/reset', requireLogin, (req, res) => {
  const { resetSlots = false } = req.body || {};
  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.user.id);
  if (!user) return res.status(404).json({ ok: false, message: '账号不存在' });
  const activeTerm = activeTermForAccount(db, req.auth.accountId);
  if (!activeTerm) return res.status(409).json({ ok: false, message: '当前账号没有激活学期' });
  const before = db.courses.length;
  db.courses = db.courses.filter((course) => !(courseBelongsToAccount(course, req.auth.accountId) && course.termKey === activeTerm.termKey));
  const count = before - db.courses.length;
  if (resetSlots) {
    const setting = settingForAccount(db, user.id, req.auth.accountId);
    if (setting) {
      setting.slots = null;
      setting.updatedAt = new Date().toISOString();
    }
    if (accountIdForUser(user) === req.auth.accountId) delete user.slots;
  }
  writeDb(db);
  res.json({ ok: true, count, resetSlots: Boolean(resetSlots) });
});

app.get('/api/my/courses', requireLogin, (req, res) => {
  const db = readDb();
  const payload = activeTermPayload(db, req.auth.accountId);
  res.json({ ok: true, accountId: req.auth.accountId, ...payload });
});

app.post('/api/my/courses', requireLogin, (req, res) => {
  const db = readDb();
  const activeTerm = activeTermForAccount(db, req.auth.accountId);
  if (!activeTerm) return res.status(409).json({ ok: false, message: '当前账号没有激活学期' });
  const course = normalizeCourse(req.body || {}, req.auth.user.id, req.auth.accountId, activeTerm);
  if (!course.name || !course.day || !course.slot) {
    return res.status(400).json({ ok: false, message: '课程名、星期、节次必填' });
  }
  db.courses.push(course);
  const savedDb = writeDb(db);
  res.json({ ok: true, course: retainedLogicalCourse(savedDb, course) || course });
});

app.put('/api/my/courses/:id', requireLogin, (req, res) => {
  const db = readDb();
  const activeTerm = activeTermForAccount(db, req.auth.accountId);
  const idx = db.courses.findIndex((c) => c.id === req.params.id && courseBelongsToAccount(c, req.auth.accountId) && c.termKey === activeTerm?.termKey);
  if (idx === -1) {
    return res.status(404).json({ ok: false, message: '课程不存在或不属于你' });
  }
  const patch = { ...db.courses[idx], ...req.body, id: req.params.id };
  if (req.body?.slot !== undefined && req.body?.startSlot === undefined && req.body?.endSlot === undefined) {
    patch.startSlot = req.body.slot;
    patch.endSlot = req.body.slot;
  }
  db.courses[idx] = normalizeCourse(patch, req.auth.user.id, req.auth.accountId, activeTerm);
  const updated = db.courses[idx];
  const savedDb = writeDb(db);
  res.json({ ok: true, course: retainedLogicalCourse(savedDb, updated) || updated });
});

app.delete('/api/my/courses', requireLogin, (req, res) => {
  const db = readDb();
  const activeTerm = activeTermForAccount(db, req.auth.accountId);
  const before = db.courses.length;
  db.courses = db.courses.filter((c) => !(courseBelongsToAccount(c, req.auth.accountId) && c.termKey === activeTerm?.termKey));
  const count = before - db.courses.length;
  writeDb(db);
  res.json({ ok: true, count });
});

app.delete('/api/my/courses/:id', requireLogin, (req, res) => {
  const db = readDb();
  const activeTerm = activeTermForAccount(db, req.auth.accountId);
  const before = db.courses.length;
  db.courses = db.courses.filter((c) => !(c.id === req.params.id && courseBelongsToAccount(c, req.auth.accountId) && c.termKey === activeTerm?.termKey));
  if (db.courses.length === before) {
    return res.status(404).json({ ok: false, message: '课程不存在或不属于你' });
  }
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/my/import', requireLogin, (req, res) => {
  const { courses, replace = true } = req.body || {};
  if (!Array.isArray(courses)) {
    return res.status(400).json({ ok: false, message: 'courses 必须是数组' });
  }
  const db = readDb();
  const activeTerm = activeTermForAccount(db, req.auth.accountId);
  if (!activeTerm) return res.status(409).json({ ok: false, message: '当前账号没有激活学期' });
  const normalized = courses
    .map((item) => normalizeCourse(item, req.auth.user.id, req.auth.accountId, activeTerm))
    .filter((c) => c.name && c.day && c.slot);

  const existing = db.courses.filter((course) => courseBelongsToAccount(course, req.auth.accountId) && course.termKey === activeTerm.termKey);
  const preserved = db.courses.filter((course) => !(courseBelongsToAccount(course, req.auth.accountId) && course.termKey === activeTerm.termKey));
  const consolidated = mergeCourseRecords(replace ? normalized : [...existing, ...normalized], { separateSources: true });
  db.courses = [...preserved, ...consolidated.courses];
  writeDb(db);
  res.json({ ok: true, count: normalized.length, logicalCount: consolidated.courses.length, mergedCount: consolidated.events.length });
});


// Android 导入助手专用：App 内 WebView 中由用户自己登录教务系统，App 只上传课表 JSON，不上传教务密码。
app.post('/api/my/import/jwxt-json', requireLogin, (req, res) => {
  const { jwxtData, replace = true, xnm = '', xqm = '', selectedTermLabel = '' } = req.body || {};
  const trace = importDiagnosticsStore.begin({ accountId: req.auth.accountId, replace, xnm, xqm, selectedTermLabel, requestedXnm: xnm, requestedXqm: xqm });
  const term = validateImportTermParams({ xnm, xqm, selectedTermLabel });
  if (!term.ok) {
    const failed = importFailure(trace, 400, term.reasonCode, term.message);
    return res.status(failed.status).json(failed.body);
  }
  if (!jwxtData || typeof jwxtData !== 'object') {
    const failed = importFailure(trace, 400, IMPORT_REASON_CODES.UNSUPPORTED_STRUCTURE, '缺少教务系统课表数据 jwxtData。');
    return res.status(failed.status).json(failed.body);
  }
  const db = readDb();
  const user = db.users.find((item) => item.id === req.auth.user.id);
  if (!user) {
    const failed = importFailure(trace, 404, IMPORT_REASON_CODES.ACCOUNT_MISMATCH, '当前账号不存在。');
    return res.status(failed.status).json(failed.body);
  }
  const result = executeJwxtImport({ db, user, accountId: req.auth.accountId, jwxtData, replace: Boolean(replace), xnm: term.xnm, xqm: term.xqm, selectedTermLabel: term.selectedTermLabel, trace });
  return res.status(result.status).json(result.body);
});


app.post('/api/my/import-code', requireLogin, (req, res) => {
  const { replace = true, xnm = '', xqm = '', selectedTermLabel = '' } = req.body || {};
  const term = validateImportTermParams({ xnm, xqm, selectedTermLabel });
  if (!term.ok) return res.status(400).json({ ok: false, reasonCode: term.reasonCode, message: term.message });
  const db = readDb();
  ensureImportCodes(db);

  let code = makeImportCode();
  while (db.importCodes.some((item) => item.code === code && !item.usedAt)) code = makeImportCode();

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.importCodes.unshift({
    code,
    userId: req.auth.user.id,
    accountId: req.auth.accountId,
    sessionTokenHash: crypto.createHash('sha256').update(req.auth.token).digest('hex'),
    username: req.auth.user.username,
    replace: Boolean(replace),
    selectedTermLabel: term.selectedTermLabel,
    xnm: term.xnm,
    xqm: term.xqm,
    createdAt: new Date().toISOString(),
    expiresAt,
    usedAt: null
  });
  writeDb(db);
  res.json({ ok: true, code, accountId: req.auth.accountId, expiresAt, replace: Boolean(replace), selectedTermLabel: term.selectedTermLabel, xnm: term.xnm, xqm: term.xqm });
});


// Android 导入助手：校验一次性导入码。App 用它自动读取 xnm/xqm/覆盖模式，不需要用户在 App 输入小德密码。
app.get('/api/import-code/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ ok: false, message: '缺少导入码' });

  const db = readDb();
  ensureImportCodes(db);
  const record = db.importCodes.find((item) => item.code === code);
  if (!record) return res.status(404).json({ ok: false, reasonCode: IMPORT_REASON_CODES.UNKNOWN, message: '导入码不存在，请回到小德课表重新生成' });
  if (record.usedAt) return res.status(409).json({ ok: false, reasonCode: IMPORT_REASON_CODES.USED_IMPORT_CODE, message: '导入码已使用，请重新生成' });

  const secondsLeft = Math.max(0, Math.floor((new Date(record.expiresAt).getTime() - Date.now()) / 1000));
  if (secondsLeft <= 0) {
    return res.status(410).json({ ok: false, reasonCode: IMPORT_REASON_CODES.EXPIRED_IMPORT_CODE, message: '导入码已过期，请回到小德课表重新生成' });
  }
  const term = validateImportTermParams(record);
  if (!term.ok) return res.status(422).json({ ok: false, reasonCode: term.reasonCode, message: term.message });

  res.json({
    ok: true,
    code: record.code,
    accountId: record.accountId,
    replace: Boolean(record.replace),
    selectedTermLabel: term.selectedTermLabel,
    xnm: term.xnm,
    xqm: term.xqm,
    expiresAt: record.expiresAt,
    secondsLeft,
    message: `导入码有效，剩余约 ${Math.ceil(secondsLeft / 60)} 分钟`
  });
});

app.post('/api/import-code/:code/submit', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const {
    jwxtData,
    accountId: submittedAccountId = '',
    selectedTermLabel: submittedTermLabel = '',
    xnm: submittedXnm = '',
    xqm: submittedXqm = '',
    replace: submittedReplace
  } = req.body || {};

  const db = readDb();
  ensureImportCodes(db);
  const record = db.importCodes.find((item) => item.code === code);
  const trace = importDiagnosticsStore.begin({ accountId: record?.accountId || '', replace: record?.replace, selectedTermLabel: record?.selectedTermLabel, xnm: record?.xnm, xqm: record?.xqm, requestedXnm: record?.xnm, requestedXqm: record?.xqm });
  if (!code || !record) {
    const failed = importFailure(trace, 404, IMPORT_REASON_CODES.UNKNOWN, '导入码不存在，请回到小德课表重新生成。');
    return res.status(failed.status).json(failed.body);
  }
  if (record.usedAt) {
    const failed = importFailure(trace, 409, IMPORT_REASON_CODES.USED_IMPORT_CODE, '导入码已使用，请重新生成。');
    return res.status(failed.status).json(failed.body);
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    const failed = importFailure(trace, 410, IMPORT_REASON_CODES.EXPIRED_IMPORT_CODE, '导入码已过期，请重新生成。');
    return res.status(failed.status).json(failed.body);
  }
  if (String(submittedAccountId).trim() !== record.accountId) {
    const failed = importFailure(trace, 403, IMPORT_REASON_CODES.ACCOUNT_MISMATCH, '导入码与当前 accountId 不匹配。');
    return res.status(failed.status).json(failed.body);
  }
  const term = validateImportTermParams(record);
  if (!term.ok) {
    const failed = importFailure(trace, 400, term.reasonCode, term.message);
    return res.status(failed.status).json(failed.body);
  }
  if (String(submittedXnm).trim() !== term.xnm || String(submittedXqm).trim() !== term.xqm || String(submittedTermLabel).trim() !== term.selectedTermLabel) {
    const failed = importFailure(trace, 403, IMPORT_REASON_CODES.INVALID_TERM_PARAMS, 'Android 冻结的学期与导入码绑定学期不一致。');
    return res.status(failed.status).json(failed.body);
  }
  if (typeof submittedReplace !== 'boolean' || submittedReplace !== Boolean(record.replace)) {
    const failed = importFailure(trace, 403, IMPORT_REASON_CODES.INVALID_TERM_PARAMS, 'Android 冻结的覆盖模式与导入码绑定值不一致。');
    return res.status(failed.status).json(failed.body);
  }
  if (!jwxtData || typeof jwxtData !== 'object') {
    const failed = importFailure(trace, 400, IMPORT_REASON_CODES.UNSUPPORTED_STRUCTURE, '缺少教务系统课表数据。');
    return res.status(failed.status).json(failed.body);
  }

  const targetUser = db.users.find((u) => u.id === record.userId);
  if (!targetUser) {
    const failed = importFailure(trace, 404, IMPORT_REASON_CODES.ACCOUNT_MISMATCH, '导入码对应的小德课表账号不存在。');
    return res.status(failed.status).json(failed.body);
  }
  if (!accountForUser(db, record.userId, record.accountId)) {
    const failed = importFailure(trace, 404, IMPORT_REASON_CODES.ACCOUNT_MISMATCH, '导入码对应的 accountId 不存在。');
    return res.status(failed.status).json(failed.body);
  }
  const result = executeJwxtImport({
    db,
    user: targetUser,
    accountId: record.accountId,
    jwxtData,
    replace: Boolean(record.replace),
    xnm: term.xnm,
    xqm: term.xqm,
    selectedTermLabel: term.selectedTermLabel,
    trace,
    importCode: record.code
  });
  return res.status(result.status).json(result.body);
});

app.post('/api/my/import/jwxt', requireLogin, async (req, res) => {
  res.status(410).json({
    ok: false,
    message: '网页版自动登录导入已停用。请使用 Android「小德课表导入助手」：在 App 内打开教务系统，用户自己登录后读取课表并上传。'
  });
});

app.put('/api/my/profile', requireLogin, (req, res) => {
  const { name, username } = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanUsername = String(username || '').trim().toLowerCase();
  if (!cleanName) return res.status(400).json({ ok: false, message: '姓名不能为空' });
  if (!cleanUsername) return res.status(400).json({ ok: false, message: '用户名不能为空' });
  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.user.id);
  if (!user) return res.status(404).json({ ok: false, message: '账号不存在' });
  if (db.users.some((u) => u.id !== user.id && u.username === cleanUsername)) {
    return res.status(400).json({ ok: false, message: '用户名已存在' });
  }
  user.name = cleanName;
  user.username = cleanUsername;
  const account = accountForUser(db, user.id, req.auth.accountId);
  if (account) {
    account.name = cleanName;
    account.username = cleanUsername;
    account.updatedAt = new Date().toISOString();
  }
  writeDb(db);
  res.json({ ok: true, accountId: req.auth.accountId, user: publicUser(user, req.auth.accountId) });
});

app.delete('/api/my/account', requireLogin, (req, res) => {
  const { password } = req.body || {};
  const db = readDb();
  const user = db.users.find((u) => u.id === req.auth.user.id);
  if (!user) return res.status(404).json({ ok: false, message: '账号不存在' });
  if (String(user.password || '') !== String(password || '')) {
    return res.status(401).json({ ok: false, message: '密码不正确，未删除账号' });
  }
  if (user.role === 'admin') return res.status(400).json({ ok: false, message: '管理员账号不能在这里删除' });
  const beforeCourses = db.courses.length;
  const accountIds = new Set((db.accounts || []).filter((account) => account.userId === user.id).map((account) => account.id));
  db.users = db.users.filter((u) => u.id !== user.id);
  db.sessions = db.sessions.filter((s) => s.userId !== user.id);
  db.accounts = (db.accounts || []).filter((account) => account.userId !== user.id);
  db.settings = (db.settings || []).filter((setting) => !accountIds.has(setting.accountId));
  db.reminders = (db.reminders || []).filter((reminder) => !accountIds.has(reminder.accountId));
  db.importCodes = (db.importCodes || []).filter((item) => !accountIds.has(item.accountId));
  db.courses = db.courses.filter((course) => !accountIds.has(course.accountId));
  if (Array.isArray(db.feedbacks)) db.feedbacks = db.feedbacks.filter((feedback) => !accountIds.has(feedback.accountId));
  writeDb(db);
  res.json({ ok: true, removedCourses: beforeCourses - db.courses.length });
});


app.post('/api/my/feedback', requireLogin, (req, res) => {
  const { type = '建议', content = '', contact = '', page = '', userAgent = '' } = req.body || {};
  const cleanContent = String(content || '').trim();
  if (!cleanContent) {
    return res.status(400).json({ ok: false, message: '反馈内容不能为空' });
  }
  if (cleanContent.length > 1000) {
    return res.status(400).json({ ok: false, message: '反馈内容最多 1000 字' });
  }

  const db = readDb();
  if (!Array.isArray(db.feedbacks)) db.feedbacks = [];
  db.feedbacks.unshift({
    id: uid('fb'),
    userId: req.auth.user.id,
    accountId: req.auth.accountId,
    username: req.auth.user.username,
    name: req.auth.user.name,
    type: String(type || '建议').trim() || '建议',
    content: cleanContent,
    contact: String(contact || '').trim(),
    page: String(page || '').trim(),
    userAgent: String(userAgent || '').slice(0, 300),
    ip: req.ip,
    createdAt: new Date().toISOString(),
    status: 'new'
  });
  writeDb(db);
  res.json({ ok: true, message: '反馈已收到，谢谢你' });
});

app.get('/api/my/import-diagnostics/latest', requireLogin, (req, res) => {
  const trace = importDiagnosticsStore.latestForAccount(req.auth.accountId);
  if (!trace) return res.status(404).json({ ok: false, message: '当前账号还没有导入诊断摘要' });
  res.json({
    ok: true,
    trace: {
      traceId: trace.traceId,
      createdAt: trace.createdAt,
      completedAt: trace.completedAt || null,
      status: trace.status,
      summary: trace.summary,
      warnings: trace.warnings || [],
      errors: trace.errors || [],
      reasonCode: trace.reasonCode || null,
      message: trace.message || '',
      replace: Boolean(trace.replace),
      selectedTermLabel: trace.selectedTermLabel || '',
      requestedXnm: trace.requestedXnm || '',
      requestedXqm: trace.requestedXqm || '',
      effectiveXnm: trace.effectiveXnm || '',
      effectiveXqm: trace.effectiveXqm || '',
      requestedTerm: trace.requestedTerm || null,
      effectiveTerm: trace.effectiveTerm || null,
      xnm: trace.xnm || '',
      xqm: trace.xqm || '',
      sourceCounts: trace.sourceCounts || {},
      rawCount: trace.rawCount || trace.summary?.rawCount || 0,
      acceptedCount: trace.acceptedCount || trace.summary?.acceptedCount || 0,
      filteredWrongTermCount: trace.filteredWrongTermCount || trace.summary?.filteredWrongTermCount || 0,
      filteredUnknownSourceCount: trace.filteredUnknownSourceCount || trace.summary?.filteredUnknownSourceCount || 0,
      importedCount: trace.importedCount || trace.summary?.importedCount || 0,
      totalWeeks: trace.totalWeeks || 0,
      totalWeeksSource: trace.totalWeeksSource || '',
      termStart: trace.termStart || '',
      timings: trace.timings || {}
    }
  });
});

app.get('/api/admin/import-diagnostics', requireAdmin, (req, res) => {
  res.json({ ok: true, status: importDiagnosticsStore.status(), traces: importDiagnosticsStore.list(req.query.limit) });
});

app.get('/api/admin/import-diagnostics/:traceId', requireAdmin, (req, res) => {
  const trace = importDiagnosticsStore.get(String(req.params.traceId || ''));
  if (!trace) return res.status(404).json({ ok: false, message: '诊断 trace 不存在' });
  res.json({ ok: true, trace });
});

app.get('/api/admin/feedbacks', requireAdmin, (req, res) => {
  const db = readDb();
  res.json({ ok: true, feedbacks: Array.isArray(db.feedbacks) ? db.feedbacks : [] });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const db = readDb();
  const users = db.users.map((u) => {
    const accountIds = new Set((db.accounts || []).filter((account) => account.userId === u.id).map((account) => account.id));
    return {
      id: u.id,
      accountId: accountIdForUser(u),
      username: u.username,
      name: u.name,
      role: u.role,
      courseCount: (db.courses || []).filter((course) => accountIds.has(course.accountId)).length,
      createdAt: u.createdAt
    };
  });
  res.json({ ok: true, users });
});

app.get('/api/admin/schema', requireAdmin, (req, res) => {
  const db = readDb();
  const accountOwners = new Map((db.accounts || []).map((account) => [account.id, account.userId]));
  const missingAccountIdCourses = (db.courses || []).filter((course) => !course.accountId).length;
  const orphanCourses = (db.courses || []).filter((course) => course.accountId && accountOwners.get(course.accountId) !== course.userId).length;
  const orphanSettings = (db.settings || []).filter((setting) => accountOwners.get(setting.accountId) !== setting.userId).length;
  const orphanReminders = (db.reminders || []).filter((reminder) => accountOwners.get(reminder.accountId) !== reminder.userId).length;
  const orphanImportCodes = (db.importCodes || []).filter((item) => accountOwners.get(item.accountId) !== item.userId).length;
  res.json({
    ok: true,
    schemaVersion: db.meta?.schemaVersion || 1,
    storageMode: db.meta?.storageMode || 'legacy-json',
    counts: {
      users: db.users.length,
      accounts: db.accounts.length,
      courses: db.courses.length,
      settings: db.settings.length,
      reminders: db.reminders.length,
      sessions: db.sessions.length,
      backups: db.backups.length
    },
    checks: {
      missingAccountIdCourses,
      orphanCourses,
      orphanSettings,
      orphanReminders,
      orphanImportCodes,
      accountIsolationOk: missingAccountIdCourses === 0 && orphanCourses === 0 && orphanSettings === 0 && orphanReminders === 0 && orphanImportCodes === 0,
      readyForMysql: missingAccountIdCourses === 0 && orphanCourses === 0 && orphanSettings === 0 && orphanReminders === 0 && orphanImportCodes === 0
    }
  });
});

app.get('/api/admin/storage', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    appVersion: APP_VERSION,
    configuredDriver: STORAGE_DRIVER,
    storage: {
      primary: 'db.json',
      mysqlMirror: currentMysqlStorageStatus()
    },
    dataFile: DATA_FILE
  });
});

app.post('/api/admin/mysql-sync-now', requireAdmin, async (req, res) => {
  if (!mysqlSyncState) return res.status(400).json({ ok: false, message: '当前没有启用 MySQL，同步开关是 XIAODE_STORAGE=mysql' });
  try {
    await mysqlSyncState(readDb());
    res.json({ ok: true, storage: currentMysqlStorageStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, message: String(err?.message || err), storage: currentMysqlStorageStatus() });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const db = readDb();
  const target = db.users.find((u) => u.id === req.params.id);
  if (!target) {
    return res.status(404).json({ ok: false, message: '用户不存在' });
  }
  if (target.role === 'admin') {
    return res.status(400).json({ ok: false, message: '不能删除管理员账号' });
  }
  if (target.id === req.auth.user.id) {
    return res.status(400).json({ ok: false, message: '不能删除当前登录账号' });
  }

  const beforeCourses = db.courses.length;
  const targetAccountIds = new Set((db.accounts || []).filter((account) => account.userId === target.id).map((account) => account.id));
  db.users = db.users.filter((u) => u.id !== target.id);
  db.sessions = db.sessions.filter((s) => s.userId !== target.id);
  db.accounts = (db.accounts || []).filter((account) => account.userId !== target.id);
  db.settings = (db.settings || []).filter((setting) => !targetAccountIds.has(setting.accountId));
  db.reminders = (db.reminders || []).filter((reminder) => !targetAccountIds.has(reminder.accountId));
  db.importCodes = (db.importCodes || []).filter((item) => !targetAccountIds.has(item.accountId));
  db.courses = db.courses.filter((course) => !targetAccountIds.has(course.accountId));
  if (Array.isArray(db.feedbacks)) {
    db.feedbacks = db.feedbacks.filter((feedback) => !targetAccountIds.has(feedback.accountId));
  }
  writeDb(db);
  res.json({ ok: true, message: `已删除用户 ${target.username}`, removedCourses: beforeCourses - db.courses.length });
});

app.put('/api/admin/meta', requireAdmin, (req, res) => {
  const db = readDb();
  db.meta = { ...db.meta, ...req.body };
  writeDb(db);
  res.json({ ok: true, meta: db.meta });
});

app.put('/api/admin/slots', requireAdmin, (req, res) => {
  const { slots } = req.body || {};
  if (!Array.isArray(slots) || !slots.length) {
    return res.status(400).json({ ok: false, message: 'slots 不能为空' });
  }
  const db = readDb();
  db.slots = slots.map((item, index) => ({
    slot: Number(item.slot || index + 1),
    label: String(item.label || `第${index + 1}节`),
    range: String(item.range || `${item.start}-${item.end}`),
    start: String(item.start || ''),
    end: String(item.end || '')
  }));
  writeDb(db);
  res.json({ ok: true, slots: db.slots });
});

app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));


async function initStorageAndStart() {
  const localDb = readDb();
  runtimeDbCache = cloneDb(migrateDbToV38(localDb));
  writeJsonFileOnly(runtimeDbCache);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`小德课表 running at http://localhost:${PORT}`);
    console.log(`局域网访问：请用本机 IPv4 地址访问 http://本机IP:${PORT}`);
    console.log(`主存储：db.json；MySQL 镜像：${MYSQL_MIRROR_ENABLED ? '已启用' : '未启用'}`);
  });

  if (MYSQL_MIRROR_ENABLED) {
    try {
      const mysqlStore = await import('./mysql-store.js');
      mysqlStatusReader = mysqlStore.getMysqlStatus;
      mysqlStorageStatus = mysqlStore.getMysqlStatus();
      mysqlSyncState = async (db, options) => {
        try {
          await mysqlStore.syncMysqlState(migrateDbToV38(cloneDb(db)), options);
        } finally {
          mysqlStorageStatus = mysqlStore.getMysqlStatus();
        }
      };
      // 启动只把本地快照推向 MySQL，绝不从 MySQL 回灌 db.json。
      await mysqlSyncState(runtimeDbCache, { force: true });
      console.log('[storage] MySQL 镜像初始化并同步成功。');
    } catch (err) {
      // 保留同步函数，后续 writeDb 会按冷却策略重新连接，服务始终继续使用 JSON。
      console.error('[storage] MySQL 镜像初始化失败，继续使用 db.json：', String(err?.message || err));
    }
  }
}

await initStorageAndStart();
