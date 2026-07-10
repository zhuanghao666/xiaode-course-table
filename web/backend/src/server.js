import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..', '..');
const DATA_FILE = process.env.NODE_ENV === 'test' && process.env.XIAODE_DATA_FILE
  ? path.resolve(process.env.XIAODE_DATA_FILE)
  : path.join(__dirname, '..', 'data', 'db.json');
const PUBLIC_DIR = path.join(ROOT, 'frontend', 'public');
const PORT = process.env.PORT || 3001;
const APP_VERSION = 'v39';
const DB_SCHEMA_VERSION = 4;
const STORAGE_DRIVER = String(process.env.XIAODE_STORAGE || process.env.DB_DRIVER || 'json').toLowerCase();
const MYSQL_MIRROR_ENABLED = STORAGE_DRIVER === 'mysql';
let runtimeDbCache = null;
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

function migrateDbToV38(input = {}) {
  const db = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const now = new Date().toISOString();
  db.meta = db.meta && typeof db.meta === 'object' && !Array.isArray(db.meta) ? db.meta : {};
  db.meta.appVersion = APP_VERSION;
  db.meta.schemaVersion = DB_SCHEMA_VERSION;
  db.meta.storageMode = MYSQL_MIRROR_ENABLED ? 'json-primary-mysql-mirror-v39' : 'json-relational-v39';
  db.meta.storageDriver = 'json';
  db.meta.schemaNote = 'v39 以 db.json 为主存储，MySQL 仅作镜像；课程、设置、提醒和导入按 accountId 隔离。';

  if (!Array.isArray(db.slots) || db.slots.length < 12) db.slots = DEFAULT_12_SLOTS;
  db.slots = normalizeSlotsInput(db.slots, DEFAULT_12_SLOTS);
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.sessions)) db.sessions = [];
  if (!Array.isArray(db.courses)) db.courses = [];
  if (!Array.isArray(db.feedbacks)) db.feedbacks = [];
  if (!Array.isArray(db.importCodes)) db.importCodes = [];
  if (!Array.isArray(db.backups)) db.backups = [];

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
  const migrationWarnings = new Map();
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
    .map((course) => resolveLegacyScope('course', course));

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

function coursesForAccount(db, accountId) {
  return (Array.isArray(db.courses) ? db.courses : []).filter((course) => courseBelongsToAccount(course, accountId));
}

function settingForAccount(db, userId, accountId) {
  return (db.settings || []).find((setting) => setting.accountId === accountId && setting.userId === userId) || null;
}

function reminderForAccount(db, userId, accountId) {
  return (db.reminders || []).find((reminder) => reminder.accountId === accountId && reminder.userId === userId) || null;
}


function normalizeWeeks(weeks, weekText = '') {
  if (Array.isArray(weeks) && weeks.length) {
    return [...new Set(weeks.map(Number).filter(Boolean))].sort((a, b) => a - b);
  }

  // 支持“1-3周,5-16周”“第8周”“9-10周”“1~16周(单周)”等复杂周次。
  const text = String(weekText || '').trim();
  if (!text) return [];

  const out = new Set();
  const rangeRegex = /(\d+)\s*[-~到至]\s*(\d+)/g;
  let match;
  const consumed = [];
  while ((match = rangeRegex.exec(text)) !== null) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start && end) {
      const a = Math.min(start, end);
      const b = Math.max(start, end);
      for (let i = a; i <= b; i++) out.add(i);
      consumed.push([match.index, match.index + match[0].length]);
    }
  }

  // 再解析没有出现在区间里的单周，例如“8周”“第12周”。
  const withoutRanges = text.split('').map((ch, idx) => {
    return consumed.some(([a, b]) => idx >= a && idx < b) ? ' ' : ch;
  }).join('');
  for (const m of withoutRanges.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (n) out.add(n);
  }

  return [...out].sort((a, b) => a - b);
}

function parseJwxtDay(item = {}) {
  const raw = item.xqj ?? item.weekday ?? item.day;
  const n = Number(raw);
  if (n >= 1 && n <= 7) return n;

  const text = String(item.xqjmc || item.xqjName || item.weekText || '').trim();
  const map = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7,
    '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7
  };
  for (const [key, value] of Object.entries(map)) {
    if (text.includes(key)) return value;
  }
  return 0;
}

function pickFirstText(item = {}, keys = []) {
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function stripHtmlText(text = '') {
  return String(text || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeJwxtCourseItem(item = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const name = pickFirstText(item, ['kcmc', 'kcmcMc', 'kcmc_name', 'courseName', 'name']);
  if (!name) return false;
  const hasDay = Boolean(item.xqj || item.xqjmc || item.weekday || item.day);
  const hasSection = Boolean(item.jcor || item.jcs || item.jc || item.ksjc || item.jsjc || item.skjc || item.jcxx);
  const hasWeek = Boolean(item.zcd || item.zc || item.zcmc || item.weekText || item.weeks);
  return hasDay && (hasSection || hasWeek);
}

function collectJwxtCourseItems(data = {}) {
  const items = [];
  const sourceCounts = {};
  const visited = new Set();

  const add = (source, value) => {
    if (!Array.isArray(value)) return;
    let count = 0;
    for (const item of value) {
      if (!looksLikeJwxtCourseItem(item)) continue;
      const cloned = { ...item, __source: source };
      items.push(cloned);
      count++;
    }
    if (count) sourceCounts[source] = (sourceCounts[source] || 0) + count;
  };

  const walk = (node, pathName = 'root', depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 2) return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      add(pathName, node);
      for (let i = 0; i < Math.min(node.length, 20); i++) walk(node[i], `${pathName}[${i}]`, depth + 1);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) add(key, value);
      else if (value && typeof value === 'object') walk(value, key, depth + 1);
    }
  };

  walk(data);

  // 优先保证 kbList 即使字段略特殊也被纳入。
  if (Array.isArray(data.kbList)) {
    const already = new Set(items.map((item) => item));
    for (const item of data.kbList) {
      if (looksLikeJwxtCourseItem(item) && !already.has(item)) items.push({ ...item, __source: 'kbList' });
    }
    sourceCounts.kbList = Math.max(sourceCounts.kbList || 0, data.kbList.filter(looksLikeJwxtCourseItem).length);
  }

  return { items, sourceCounts };
}

function normalizeCourse(input, userId, accountId) {
  const weekText = String(input.weekText || '').trim();
  return {
    id: input.id || uid('c'),
    userId,
    accountId: String(accountId || '').trim(),
    day: Number(input.day),
    slot: Number(input.slot),
    name: String(input.name || '').trim(),
    shortName: String(input.shortName || '').trim(),
    teacher: String(input.teacher || '').trim(),
    location: String(input.location || '').trim(),
    classGroup: String(input.classGroup || '').trim(),
    weekText,
    weeks: normalizeWeeks(input.weeks, weekText),
    oddEven: input.oddEven || 'all',
    category: input.category || 'custom'
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

function inferOddEvenFromText(weekText = '') {
  const text = String(weekText || '');
  if (text.includes('单')) return 'odd';
  if (text.includes('双')) return 'even';
  return 'all';
}

function mapJwxtCategory(kclb = '', kcxz = '', name = '') {
  const text = `${kclb || ''} ${kcxz || ''} ${name || ''}`;
  if (text.includes('实验')) return 'lab';
  if (text.includes('公共必修')) return 'public_required';
  if (text.includes('专业必修')) return 'major_required';
  if (text.includes('专业选修')) return 'major_elective';
  if (text.includes('公共选修')) return 'public_elective';
  return 'custom';
}

function mapJwxtJcToSlots(jcor = '') {
  const text = stripHtmlText(String(jcor || '')).replace(/[第节]/g, '').trim();
  const match = text.match(/(\d+)\s*[-~到至]\s*(\d+)/);
  if (!match) {
    const n = Number(text.match(/\d+/)?.[0] || text);
    if (n >= 1 && n <= 12) return [n];
    if (n === 13) return [12];
    return [];
  }

  const start = Math.max(1, Number(match[1]));
  const end = Math.min(12, Number(match[2]));
  if (!start || !end || end < start) return [];
  const out = [];
  for (let slot = start; slot <= end; slot += 1) out.push(slot);
  return out;
}

function mapJwxtItemToSlots(item = {}) {
  const start = Number(item.ksjc || item.qsjc || item.startSection || item.startJc || 0);
  const end = Number(item.jsjc || item.zzjc || item.endSection || item.endJc || 0);
  if (start && end) return mapJwxtJcToSlots(`${start}-${end}`);

  const text = pickFirstText(item, ['jcor', 'jcs', 'jc', 'skjc', 'jcxx', 'sectionText']);
  return mapJwxtJcToSlots(text);
}

function uniqueCourses(courses) {
  const map = new Map();
  for (const c of courses) {
    const key = [c.day, c.slot, c.name, c.teacher, c.location, c.weekText, c.oddEven].join('|');
    if (!map.has(key)) map.set(key, c);
  }
  return [...map.values()];
}

function convertJwxtKbData(data = {}) {
  // v13：不再只读 kbList。教务系统页面里的调课、实践课、补课等可能在其他数组字段里。
  // 这里会递归扫描顶层/二级 JSON 数组，把“看起来像课程”的对象都纳入转换。
  const { items } = collectJwxtCourseItems(data);
  const courses = [];

  for (const item of items) {
    const slots = mapJwxtItemToSlots(item);
    const day = parseJwxtDay(item);
    const name = stripHtmlText(pickFirstText(item, ['kcmc', 'kcmcMc', 'kcmc_name', 'courseName', 'name']));
    const teacher = stripHtmlText(pickFirstText(item, ['xm', 'jsxm', 'teacher', 'teachers', 'jsxx']));
    const location = stripHtmlText(pickFirstText(item, ['cdmc', 'jxcdmc', 'croomName', 'location', 'jxdd', 'skdd']));
    const weekText = stripHtmlText(pickFirstText(item, ['zcd', 'zc', 'zcmc', 'weekText', 'weeks']));
    const source = String(item.__source || '');
    const isAdjusted = /调|tk|adjust/i.test(`${source} ${item.tkbz || ''} ${item.bz || ''} ${name}`);

    for (const slot of slots) {
      courses.push({
        day,
        slot,
        name: isAdjusted && !name.includes('调') ? `【调】${name}` : name,
        teacher,
        location,
        weekText: weekText || '1-17周',
        oddEven: inferOddEvenFromText(weekText || ''),
        category: mapJwxtCategory(item.kclb, item.kcxz, name)
      });
    }
  }

  return uniqueCourses(courses).filter((c) => c.name && c.day && c.slot);
}

function getJwxtImportDiagnostics(data = {}) {
  const { items, sourceCounts } = collectJwxtCourseItems(data);
  const converted = convertJwxtKbData(data);
  const kbListCount = Array.isArray(data.kbList) ? data.kbList.length : 0;
  return {
    rawCount: items.length,
    kbListCount,
    convertedCount: converted.length,
    sourceCounts
  };
}

function makeImportCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function ensureImportCodes(db) {
  if (!Array.isArray(db.importCodes)) db.importCodes = [];
  const now = Date.now();
  db.importCodes = db.importCodes.filter((item) => !item.usedAt && new Date(item.expiresAt).getTime() > now - 60_000);
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
        body.set('xnm', String(xnm || '2025'));
        body.set('xqm', String(xqm || '12'));
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
      mysqlMirror: currentMysqlStorageStatus()
    },
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
  if (user && db.users.some((u) => u.id === user.id)) writeDb(db);
  res.json({
    ok: true,
    accountId: req.auth.accountId,
    user: publicUser(user, req.auth.accountId),
    meta: db.meta,
    slots,
    courses: coursesForAccount(db, req.auth.accountId),
    preferences
  });
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
    meta: db.meta,
    slots: Array.isArray(setting?.slots) ? normalizeSlotsInput(setting.slots, db.slots) : db.slots,
    courses: coursesForAccount(db, accountId)
      .map((course) => {
        const { userId, accountId, ...rest } = course;
        return rest;
      })
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

function normalizeBackupForAccount(input, userId, accountId, defaultSlots = []) {
  const { courses, slots } = unpackBackupPayload(input);
  const normalizedCourses = courses
    .map((item) => {
      const cloned = { ...(item || {}) };
      delete cloned.id;
      delete cloned.userId;
      delete cloned.accountId;
      return normalizeCourse(cloned, userId, accountId);
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
  const normalized = normalizeBackupForAccount(backup || req.body, user.id, req.auth.accountId, db.slots);
  if (!normalized.courses.length && !normalized.slots) {
    return res.status(400).json({ ok: false, message: '备份文件里没有可恢复的课程或节次时间' });
  }

  if (mode === 'replace') {
    db.courses = db.courses.filter((course) => !courseBelongsToAccount(course, req.auth.accountId));
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
  const before = db.courses.length;
  db.courses = db.courses.filter((course) => !courseBelongsToAccount(course, req.auth.accountId));
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
  res.json({ ok: true, accountId: req.auth.accountId, courses: coursesForAccount(db, req.auth.accountId) });
});

app.post('/api/my/courses', requireLogin, (req, res) => {
  const course = normalizeCourse(req.body || {}, req.auth.user.id, req.auth.accountId);
  if (!course.name || !course.day || !course.slot) {
    return res.status(400).json({ ok: false, message: '课程名、星期、节次必填' });
  }
  const db = readDb();
  db.courses.push(course);
  writeDb(db);
  res.json({ ok: true, course });
});

app.put('/api/my/courses/:id', requireLogin, (req, res) => {
  const db = readDb();
  const idx = db.courses.findIndex((c) => c.id === req.params.id && courseBelongsToAccount(c, req.auth.accountId));
  if (idx === -1) {
    return res.status(404).json({ ok: false, message: '课程不存在或不属于你' });
  }
  db.courses[idx] = normalizeCourse({ ...db.courses[idx], ...req.body, id: req.params.id }, req.auth.user.id, req.auth.accountId);
  writeDb(db);
  res.json({ ok: true, course: db.courses[idx] });
});

app.delete('/api/my/courses', requireLogin, (req, res) => {
  const db = readDb();
  const before = db.courses.length;
  db.courses = db.courses.filter((c) => !courseBelongsToAccount(c, req.auth.accountId));
  const count = before - db.courses.length;
  writeDb(db);
  res.json({ ok: true, count });
});

app.delete('/api/my/courses/:id', requireLogin, (req, res) => {
  const db = readDb();
  const before = db.courses.length;
  db.courses = db.courses.filter((c) => !(c.id === req.params.id && courseBelongsToAccount(c, req.auth.accountId)));
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
  const normalized = courses
    .map((item) => normalizeCourse(item, req.auth.user.id, req.auth.accountId))
    .filter((c) => c.name && c.day && c.slot);

  if (replace) {
    db.courses = db.courses.filter((c) => !courseBelongsToAccount(c, req.auth.accountId)).concat(normalized);
  } else {
    db.courses = db.courses.concat(normalized);
  }
  writeDb(db);
  res.json({ ok: true, count: normalized.length });
});


// Android 导入助手专用：App 内 WebView 中由用户自己登录教务系统，App 只上传课表 JSON，不上传教务密码。
app.post('/api/my/import/jwxt-json', requireLogin, (req, res) => {
  const { jwxtData, replace = true } = req.body || {};
  if (!jwxtData || typeof jwxtData !== 'object') {
    return res.status(400).json({
      ok: false,
      code: 'JWXT_DATA_MISSING',
      message: '缺少教务系统课表数据 jwxtData。请在 Android App 内完成教务系统登录后重新导入。'
    });
  }

  const diag = getJwxtImportDiagnostics(jwxtData);
  const rawList = collectJwxtCourseItems(jwxtData).items;
  if (!rawList.length) {
    return res.status(400).json({
      ok: false,
      code: 'JWXT_KBLIST_MISSING',
      rawCount: 0,
      message: '教务系统返回数据里没有可识别的课表数组。常见原因：教务登录已过期、Cookie 没带上、接口返回了登录页，或学年学期参数不对。'
    });
  }

  const converted = convertJwxtKbData(jwxtData);
  if (!converted.length) {
    const sample = rawList.slice(0, 2).map((item) => ({
      kcmc: item.kcmc,
      xqj: item.xqj,
      jcor: item.jcor,
      jcs: item.jcs,
      jc: item.jc,
      zcd: item.zcd,
      cdmc: item.cdmc
    }));
    return res.status(400).json({
      ok: false,
      code: 'JWXT_CONVERT_EMPTY',
      rawCount: rawList.length,
      sample,
      message: rawList.length
        ? `收到教务系统可识别原始记录=${rawList.length} 条，但没有识别到可导入课程。可能字段结构变化、节次字段为空，或学年学期参数不对。`
        : '教务系统课表记录为空。请确认当前学年学期有课，或把 xnm/xqm 改成正确值后重试。'
    });
  }

  const normalized = converted
    .map((item) => normalizeCourse(item, req.auth.user.id, req.auth.accountId))
    .filter((c) => c.name && c.day && c.slot);

  if (!normalized.length) {
    return res.status(400).json({
      ok: false,
      code: 'COURSE_NORMALIZE_EMPTY',
      rawCount: rawList.length,
      kbListCount: diag.kbListCount,
      sourceCounts: diag.sourceCounts,
      convertedCount: converted.length,
      message: '教务数据已转换，但保存前校验全部失败。请检查课程名、星期、节次字段。'
    });
  }

  const db = readDb();
  const previousCount = coursesForAccount(db, req.auth.accountId).length;
  if (replace) {
    db.courses = db.courses.filter((c) => !courseBelongsToAccount(c, req.auth.accountId)).concat(normalized);
  } else {
    db.courses = db.courses.concat(normalized);
  }
  const importedAt = new Date().toISOString();
  db.meta.lastAndroidImportAt = importedAt;
  db.meta.lastAndroidImportUserId = req.auth.user.id;
  db.meta.lastAndroidImportAccountId = req.auth.accountId;
  db.meta.courseVersion = Number(db.meta.courseVersion || 0) + 1;
  writeDb(db);

  res.json({
    ok: true,
    code: 'IMPORT_OK',
    count: normalized.length,
    rawCount: diag.rawCount || rawList.length,
    kbListCount: diag.kbListCount,
    sourceCounts: diag.sourceCounts,
    convertedCount: converted.length,
    previousCount,
    replace: Boolean(replace),
    importedAt,
    courseVersion: db.meta.courseVersion,
    message: replace
      ? `已替换原有 ${previousCount} 条课程，导入 ${normalized.length} 条课程。`
      : `已追加导入 ${normalized.length} 条课程。`
  });
});


app.post('/api/my/import-code', requireLogin, (req, res) => {
  const { replace = true, xnm = '2025', xqm = '12' } = req.body || {};
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
    xnm: String(xnm || '2025'),
    xqm: String(xqm || '12'),
    createdAt: new Date().toISOString(),
    expiresAt,
    usedAt: null
  });
  writeDb(db);
  res.json({ ok: true, code, accountId: req.auth.accountId, expiresAt, replace: Boolean(replace), xnm: String(xnm || '2025'), xqm: String(xqm || '12') });
});


// Android 导入助手：校验一次性导入码。App 用它自动读取 xnm/xqm/覆盖模式，不需要用户在 App 输入小德密码。
app.get('/api/import-code/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ ok: false, message: '缺少导入码' });

  const db = readDb();
  ensureImportCodes(db);
  const record = db.importCodes.find((item) => item.code === code && !item.usedAt);
  if (!record) return res.status(404).json({ ok: false, message: '导入码不存在、已使用或已过期，请回到小德课表重新生成' });

  const secondsLeft = Math.max(0, Math.floor((new Date(record.expiresAt).getTime() - Date.now()) / 1000));
  if (secondsLeft <= 0) {
    return res.status(400).json({ ok: false, message: '导入码已过期，请回到小德课表重新生成' });
  }

  res.json({
    ok: true,
    code: record.code,
    accountId: record.accountId,
    replace: Boolean(record.replace),
    xnm: String(record.xnm || '2025'),
    xqm: String(record.xqm || '12'),
    expiresAt: record.expiresAt,
    secondsLeft,
    message: `导入码有效，剩余约 ${Math.ceil(secondsLeft / 60)} 分钟`
  });
});

app.post('/api/import-code/:code/submit', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const { jwxtData, accountId: submittedAccountId } = req.body || {};

  if (!code) return res.status(400).json({ ok: false, message: '缺少导入码' });
  if (!jwxtData || typeof jwxtData !== 'object') return res.status(400).json({ ok: false, message: '缺少教务系统课表数据' });

  const db = readDb();
  ensureImportCodes(db);
  const record = db.importCodes.find((item) => item.code === code && !item.usedAt);
  if (!record) return res.status(404).json({ ok: false, message: '导入码不存在、已使用或已过期，请回到小德课表重新生成' });
  if (submittedAccountId && String(submittedAccountId) !== record.accountId) {
    return res.status(409).json({ ok: false, message: '导入码与当前 accountId 不匹配，请重新生成导入码' });
  }
  if (new Date(record.expiresAt).getTime() < Date.now()) {
    record.usedAt = new Date().toISOString();
    writeDb(db);
    return res.status(400).json({ ok: false, message: '导入码已过期，请回到小德课表重新生成' });
  }

  const targetUser = db.users.find((u) => u.id === record.userId);
  if (!targetUser) return res.status(404).json({ ok: false, message: '导入码对应的小德课表账号不存在' });
  if (!accountForUser(db, record.userId, record.accountId)) {
    return res.status(404).json({ ok: false, message: '导入码对应的 accountId 不存在' });
  }

  const diag = getJwxtImportDiagnostics(jwxtData);
  const converted = convertJwxtKbData(jwxtData);
  if (!converted.length) return res.status(400).json({ ok: false, rawCount: diag.rawCount, kbListCount: diag.kbListCount, sourceCounts: diag.sourceCounts, message: '收到教务系统数据，但没有识别到可导入课程' });

  const normalized = converted
    .map((item) => normalizeCourse(item, record.userId, record.accountId))
    .filter((c) => c.name && c.day && c.slot);

  const previousCount = coursesForAccount(db, record.accountId).length;
  if (record.replace) {
    db.courses = db.courses.filter((c) => !courseBelongsToAccount(c, record.accountId)).concat(normalized);
  } else {
    db.courses = db.courses.concat(normalized);
  }
  const importedAt = new Date().toISOString();
  record.usedAt = importedAt;
  record.importedCount = normalized.length;
  record.rawCount = diag.rawCount;
  record.kbListCount = diag.kbListCount;
  record.sourceCounts = diag.sourceCounts;
  record.convertedCount = converted.length;
  record.previousCount = previousCount;
  db.meta.lastAndroidImportAt = importedAt;
  db.meta.lastAndroidImportUserId = record.userId;
  db.meta.lastAndroidImportAccountId = record.accountId;
  db.meta.courseVersion = Number(db.meta.courseVersion || 0) + 1;
  writeDb(db);

  res.json({
    ok: true,
    code: 'IMPORT_CODE_OK',
    count: normalized.length,
    rawCount: record.rawCount,
    kbListCount: record.kbListCount,
    sourceCounts: record.sourceCounts,
    convertedCount: converted.length,
    previousCount,
    replace: Boolean(record.replace),
    importedAt,
    courseVersion: db.meta.courseVersion,
    message: record.replace
      ? `已替换原有 ${previousCount} 条课程，导入 ${normalized.length} 条课程到 ${targetUser.name} 的小德课表`
      : `已追加导入 ${normalized.length} 条课程到 ${targetUser.name} 的小德课表`
  });
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
