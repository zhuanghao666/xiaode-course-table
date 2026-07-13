import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, output) {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) throw new Error(`backend exited early: ${output.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`backend health timeout: ${output.join('')}`);
}

async function request(baseUrl, route, { token = '', method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-user-token': token } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json();
  return { status: response.status, data };
}

function preferences(theme, calendarId) {
  return {
    theme,
    courseSettings: { totalWeeks: '18', weekStartDay: '1' },
    reminderSettings: { startEnabled: true, startOffset: 10, endEnabled: false, endOffset: 0, calendarId, calendarName: calendarId }
  };
}

function seedDb() {
  return {
    meta: { totalWeeks: 18, termStart: '2026-02-23' },
    slots: [],
    users: [
      { id: 'user-a', accountId: 'account-a', username: 'alpha', password: 'pass-a', name: 'Alpha', role: 'user', switchKey: 'switch-a', preferences: preferences('ocean', 'cal-a') },
      { id: 'user-b', accountId: 'account-b', username: 'beta', password: 'pass-b', name: 'Beta', role: 'user', switchKey: 'switch-b', preferences: preferences('sunset', 'cal-b') }
    ],
    accounts: [
      { id: 'account-a', userId: 'user-a', username: 'alpha', name: 'Alpha', role: 'user', status: 'active' },
      { id: 'account-b', userId: 'user-b', username: 'beta', name: 'Beta', role: 'user', status: 'active' }
    ],
    settings: [
      { id: 'set-a', userId: 'user-a', accountId: 'account-a', preferences: preferences('ocean', 'cal-a'), slots: null },
      { id: 'set-b', userId: 'user-b', accountId: 'account-b', preferences: preferences('sunset', 'cal-b'), slots: null }
    ],
    reminders: [
      { id: 'rem-a', userId: 'user-a', accountId: 'account-a', settings: preferences('ocean', 'cal-a').reminderSettings },
      { id: 'rem-b', userId: 'user-b', accountId: 'account-b', settings: preferences('sunset', 'cal-b').reminderSettings }
    ],
    courses: [
      { id: 'course-a', userId: 'user-a', accountId: 'account-a', day: 1, slot: 1, name: 'A-物理', weeks: [1] },
      { id: 'course-b', userId: 'user-b', accountId: 'account-b', day: 1, slot: 1, name: 'B-化学', weeks: [1] }
    ],
    sessions: [],
    feedbacks: [],
    importCodes: [],
    backups: []
  };
}

async function launchBackend(t, initialDb, extraEnv = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaode-account-isolation-'));
  const dataFile = path.join(tempDir, 'db.json');
  fs.writeFileSync(dataFile, JSON.stringify(initialDb, null, 2), 'utf8');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XIAODE_DATA_FILE: dataFile,
      XIAODE_STORAGE: 'json',
      PORT: String(port),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve());
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl, child, output);
  return { baseUrl, child, dataFile, output };
}

test('courses, settings, reminders and imports are isolated by accountId', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaode-account-isolation-'));
  const dataFile = path.join(tempDir, 'db.json');
  fs.writeFileSync(dataFile, JSON.stringify(seedDb(), null, 2), 'utf8');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      XIAODE_DATA_FILE: dataFile,
      XIAODE_STORAGE: 'json',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve());
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child, output);

  const loginA = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'alpha', password: 'pass-a' } });
  const loginB = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'beta', password: 'pass-b' } });
  assert.equal(loginA.status, 200);
  assert.equal(loginA.data.accountId, 'account-a');
  assert.equal(loginB.data.accountId, 'account-b');
  const tokenA = loginA.data.token;
  const tokenB = loginB.data.token;

  const meA = await request(baseUrl, '/api/auth/me', { token: tokenA });
  const meB = await request(baseUrl, '/api/auth/me', { token: tokenB });
  assert.equal(meA.data.accountId, 'account-a');
  assert.deepEqual(meA.data.courses.map((course) => course.name), ['A-物理']);
  assert.equal(meA.data.preferences.theme, 'ocean');
  assert.deepEqual(meB.data.courses.map((course) => course.name), ['B-化学']);
  assert.equal(meB.data.preferences.theme, 'sunset');

  const spoofedCourse = await request(baseUrl, '/api/my/courses', {
    token: tokenA,
    method: 'POST',
    body: { accountId: 'account-b', day: 3, slot: 3, name: 'Forced Alpha Course' }
  });
  assert.equal(spoofedCourse.status, 403);
  const spoofedQuery = await request(baseUrl, '/api/auth/me?accountId=account-b', { token: tokenA });
  assert.equal(spoofedQuery.status, 403);

  const addedA = await request(baseUrl, '/api/my/courses', {
    token: tokenA,
    method: 'POST',
    body: { day: 1, slot: 1, name: 'A-新增物理' }
  });
  assert.equal(addedA.status, 200);
  assert.equal(addedA.data.course.accountId, 'account-a');
  const changedA = await request(baseUrl, `/api/my/courses/${addedA.data.course.id}`, {
    token: tokenA,
    method: 'PUT',
    body: { name: 'A-物理-已修改' }
  });
  assert.equal(changedA.status, 200);
  assert.equal(changedA.data.course.name, 'A-物理-已修改');
  const bAfterAChange = await request(baseUrl, '/api/auth/me', { token: tokenB });
  assert.deepEqual(bAfterAChange.data.courses.map((course) => course.name), ['B-化学']);
  const deletedA = await request(baseUrl, `/api/my/courses/${addedA.data.course.id}`, { token: tokenA, method: 'DELETE' });
  assert.equal(deletedA.status, 200);
  assert.deepEqual((await request(baseUrl, '/api/auth/me', { token: tokenB })).data.courses.map((course) => course.name), ['B-化学']);

  const crossAccountEdit = await request(baseUrl, '/api/my/courses/course-b', {
    token: tokenA,
    method: 'PUT',
    body: { name: 'Should Not Change' }
  });
  assert.equal(crossAccountEdit.status, 404);
  const crossAccountDelete = await request(baseUrl, '/api/my/courses/course-b', { token: tokenA, method: 'DELETE' });
  assert.equal(crossAccountDelete.status, 404);
  assert.deepEqual((await request(baseUrl, '/api/auth/me', { token: tokenB })).data.courses.map((course) => course.name), ['B-化学']);

  const updatedPreferences = preferences('forest', 'cal-a-2');
  updatedPreferences.courseSettings.showSectionRange = false;
  const preferenceUpdate = await request(baseUrl, '/api/my/preferences', {
    token: tokenA,
    method: 'PUT',
    body: { preferences: updatedPreferences }
  });
  assert.equal(preferenceUpdate.status, 200);
  const meAAfterPreferenceUpdate = await request(baseUrl, '/api/auth/me', { token: tokenA });
  const meBAfterPreferenceUpdate = await request(baseUrl, '/api/auth/me', { token: tokenB });
  assert.equal(meAAfterPreferenceUpdate.data.preferences.courseSettings.showSectionRange, false);
  assert.equal(meBAfterPreferenceUpdate.data.preferences.courseSettings.showSectionRange, true);
  assert.equal(meBAfterPreferenceUpdate.data.preferences.theme, 'sunset');
  assert.equal(meBAfterPreferenceUpdate.data.preferences.reminderSettings.calendarId, 'cal-b');

  const slotUpdate = await request(baseUrl, '/api/my/slots', {
    token: tokenA,
    method: 'PUT',
    body: { slots: [{ slot: 1, label: 'Alpha Slot', start: '07:00', end: '07:45' }] }
  });
  assert.equal(slotUpdate.status, 200);
  const meAAfterSlotUpdate = await request(baseUrl, '/api/auth/me', { token: tokenA });
  const meBAfterSlotUpdate = await request(baseUrl, '/api/auth/me', { token: tokenB });
  assert.equal(meAAfterSlotUpdate.data.slots[0].start, '07:00');
  assert.equal(meBAfterSlotUpdate.data.slots[0].start, '08:00');

  const imported = await request(baseUrl, '/api/my/import', {
    token: tokenA,
    method: 'POST',
    body: { replace: true, courses: [{ day: 4, slot: 4, name: 'Alpha Imported', accountId: 'account-b' }] }
  });
  assert.equal(imported.status, 200);
  const meAAfterImport = await request(baseUrl, '/api/auth/me', { token: tokenA });
  const meBAfterImport = await request(baseUrl, '/api/auth/me', { token: tokenB });
  assert.deepEqual(meAAfterImport.data.courses.map((course) => course.name), ['Alpha Imported']);
  assert.deepEqual(meBAfterImport.data.courses.map((course) => course.name), ['B-化学']);

  const importedB = await request(baseUrl, '/api/my/import', {
    token: tokenB,
    method: 'POST',
    body: { replace: true, courses: [{ day: 4, slot: 4, name: 'B-化学-导入替换' }] }
  });
  assert.equal(importedB.status, 200);
  assert.deepEqual((await request(baseUrl, '/api/auth/me', { token: tokenA })).data.courses.map((course) => course.name), ['Alpha Imported']);
  assert.deepEqual((await request(baseUrl, '/api/auth/me', { token: tokenB })).data.courses.map((course) => course.name), ['B-化学-导入替换']);

  const backupA = await request(baseUrl, '/api/my/backup', { token: tokenA });
  assert.equal(backupA.data.backup.account.id, 'account-a');
  assert.deepEqual(backupA.data.backup.courses.map((course) => course.name), ['Alpha Imported']);

  await request(baseUrl, '/api/my/import', {
    token: tokenA,
    method: 'POST',
    body: { replace: true, courses: [{ day: 6, slot: 6, name: 'A-临时变更' }] }
  });
  const restoredA = await request(baseUrl, '/api/my/restore', {
    token: tokenA,
    method: 'POST',
    body: { replace: true, backup: backupA.data.backup }
  });
  assert.equal(restoredA.status, 200);
  assert.deepEqual((await request(baseUrl, '/api/auth/me', { token: tokenA })).data.courses.map((course) => course.name), ['Alpha Imported']);
  assert.deepEqual((await request(baseUrl, '/api/auth/me', { token: tokenB })).data.courses.map((course) => course.name), ['B-化学-导入替换']);

  const importCode = await request(baseUrl, '/api/my/import-code', { token: tokenA, method: 'POST', body: { replace: true, selectedTermLabel: '2026-2027 第一学期', xnm: '2026', xqm: '3' } });
  assert.equal(importCode.data.accountId, 'account-a');
  const mismatchedSubmit = await request(baseUrl, `/api/import-code/${importCode.data.code}/submit`, {
    method: 'POST',
    body: { accountId: 'account-b', jwxtData: { kbList: [] } }
  });
  assert.equal(mismatchedSubmit.status, 403);
  const codeSubmit = await request(baseUrl, `/api/import-code/${importCode.data.code}/submit`, {
    method: 'POST',
    body: {
      accountId: 'account-a',
      selectedTermLabel: '2026-2027 第一学期',
      xnm: '2026',
      xqm: '3',
      replace: true,
      jwxtData: { kbList: [{ kcmc: 'Alpha Code Import', xnm: '2026', xqm: '3', xqj: 5, ksjc: 5, jsjc: 5, zcd: '1-2周', xm: 'Teacher A', cdmc: 'Room A' }] }
    }
  });
  assert.equal(codeSubmit.status, 200);
  const meAAfterCode = await request(baseUrl, '/api/auth/me', { token: tokenA });
  const meBAfterCode = await request(baseUrl, '/api/auth/me', { token: tokenB });
  assert.deepEqual(meAAfterCode.data.courses.map((course) => course.name), ['Alpha Code Import']);
  assert.equal(meAAfterCode.data.activeTerm.termKey, 'account-a:2026:3');
  assert.ok(meAAfterCode.data.availableTerms.some((term) => term.termKey === 'account-a:legacy'));
  assert.deepEqual(meBAfterCode.data.courses.map((course) => course.name), ['B-化学-导入替换']);

  const invalidToken = await request(baseUrl, '/api/auth/me', { token: 'invalid-token' });
  assert.equal(invalidToken.status, 401);

  const rejectedSwitch = await request(baseUrl, '/api/auth/quick-switch', {
    method: 'POST',
    body: { username: 'alpha', switchKey: 'switch-a', accountId: 'account-b' }
  });
  assert.equal(rejectedSwitch.status, 401);

  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.ok(disk.sessions.every((session) => session.accountId));
  assert.ok(disk.courses.every((course) => course.accountId === 'account-a' || course.accountId === 'account-b'));
  assert.equal(disk.settings.find((setting) => setting.accountId === 'account-b').preferences.theme, 'sunset');
  assert.equal(disk.settings.find((setting) => setting.accountId === 'account-b').slots, null);
  assert.equal(disk.reminders.find((reminder) => reminder.accountId === 'account-b').settings.calendarId, 'cal-b');
  assert.equal(disk.importCodes.find((item) => item.code === importCode.data.code).sessionTokenHash.length, 64);
});

test('MySQL mirror failure does not block JSON writes or account isolation', async (t) => {
  const { baseUrl, dataFile } = await launchBackend(t, seedDb(), {
    XIAODE_STORAGE: 'mysql',
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '1',
    MYSQL_CONNECT_TIMEOUT_MS: '250',
    MYSQL_RETRY_COOLDOWN_MS: '1000'
  });

  const loginA = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'alpha', password: 'pass-a' } });
  assert.equal(loginA.status, 200);
  const created = await request(baseUrl, '/api/my/courses', {
    token: loginA.data.token,
    method: 'POST',
    body: { day: 1, slot: 1, name: 'A-镜像故障仍可写' }
  });
  assert.equal(created.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 350));
  const health = await request(baseUrl, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.storage.primary, 'db.json');
  assert.equal(health.data.storage.mysqlMirror.enabled, true);
  assert.equal(health.data.storage.mysqlMirror.connected, false);
  assert.equal(health.data.storage.mysqlMirror.ok, false);
  assert.ok(health.data.storage.mysqlMirror.lastError);

  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.ok(disk.courses.some((course) => course.name === 'A-镜像故障仍可写' && course.accountId === 'account-a'));
  assert.ok(disk.courses.some((course) => course.name === 'B-化学' && course.accountId === 'account-b'));
});

test('legacy accountId migration only fills uniquely attributable records', async (t) => {
  const legacy = seedDb();
  legacy.accounts.push({ id: 'account-a-secondary', userId: 'user-a', username: 'alpha-secondary', name: 'Alpha Secondary', role: 'user', status: 'active' });
  legacy.courses = [
    { id: 'legacy-ambiguous', userId: 'user-a', day: 1, slot: 1, name: '归属不明确课程', weeks: [1] },
    { id: 'legacy-unique', userId: 'user-b', day: 1, slot: 1, name: 'B-唯一可推断课程', weeks: [1] }
  ];
  const { baseUrl, dataFile } = await launchBackend(t, legacy);

  const loginA = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'alpha', password: 'pass-a' } });
  const loginB = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'beta', password: 'pass-b' } });
  assert.equal(loginA.status, 200);
  assert.equal(loginB.status, 200);
  assert.deepEqual((await request(baseUrl, '/api/auth/me', { token: loginA.data.token })).data.courses, []);
  assert.deepEqual((await request(baseUrl, '/api/auth/me', { token: loginB.data.token })).data.courses.map((course) => course.name), ['B-唯一可推断课程']);

  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(disk.courses.find((course) => course.id === 'legacy-ambiguous').accountId, undefined);
  assert.equal(disk.courses.find((course) => course.id === 'legacy-unique').accountId, 'account-b');
  assert.ok(disk.meta.migrationWarnings.some((warning) => warning.entityType === 'course' && warning.id === 'legacy-ambiguous'));
});

test('migration and login writes preserve scoped legacy courses that cannot be consolidated', async (t) => {
  const legacy = seedDb();
  legacy.courses = [
    {
      id: 'legacy-missing-name',
      userId: 'user-a',
      accountId: 'account-a',
      termKey: 'account-a:legacy',
      day: 2,
      slot: 2,
      weeks: [1, 2],
      legacyMarker: 'missing-name-must-survive'
    },
    {
      id: 'legacy-invalid-slot',
      userId: 'user-a',
      accountId: 'account-a',
      termKey: 'account-a:legacy',
      day: 3,
      slot: 99,
      name: 'Invalid Slot Must Survive',
      weeks: [1, 2],
      legacyMarker: 'invalid-slot-must-survive'
    }
  ];
  const { baseUrl, dataFile } = await launchBackend(t, legacy);

  // 登录会创建 session 并触发 writeDb；两条无法安全规范化的旧记录仍须原样落盘。
  const login = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: 'alpha', password: 'pass-a' }
  });
  assert.equal(login.status, 200);
  assert.equal((await request(baseUrl, '/api/auth/me', { token: login.data.token })).status, 200);

  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const missingName = disk.courses.find((course) => course.id === 'legacy-missing-name');
  const invalidSlot = disk.courses.find((course) => course.id === 'legacy-invalid-slot');
  assert.ok(missingName);
  assert.equal(Object.hasOwn(missingName, 'name'), false);
  assert.equal(missingName.slot, 2);
  assert.equal(missingName.legacyMarker, 'missing-name-must-survive');
  assert.ok(invalidSlot);
  assert.equal(invalidSlot.slot, 99);
  assert.equal(Object.hasOwn(invalidSlot, 'startSlot'), false);
  assert.equal(Object.hasOwn(invalidSlot, 'endSlot'), false);
  assert.equal(invalidSlot.legacyMarker, 'invalid-slot-must-survive');
});

test('course POST and PUT return the retained logical course id and merged range', async (t) => {
  const initial = seedDb();
  initial.courses.push({
    id: 'course-editable',
    userId: 'user-a',
    accountId: 'account-a',
    day: 5,
    slot: 5,
    name: 'Edit Me',
    weeks: [1]
  });
  const { baseUrl, dataFile } = await launchBackend(t, initial);
  const login = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: 'alpha', password: 'pass-a' }
  });
  const token = login.data.token;

  const duplicate = await request(baseUrl, '/api/my/courses', {
    token,
    method: 'POST',
    body: { day: 1, slot: 1, name: 'A-物理', weeks: [1] }
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(
    { id: duplicate.data.course.id, startSlot: duplicate.data.course.startSlot, endSlot: duplicate.data.course.endSlot },
    { id: 'course-a', startSlot: 1, endSlot: 1 }
  );

  const adjacent = await request(baseUrl, '/api/my/courses', {
    token,
    method: 'POST',
    body: { day: 1, slot: 2, name: 'A-物理', weeks: [1] }
  });
  assert.equal(adjacent.status, 200);
  assert.deepEqual(
    { id: adjacent.data.course.id, startSlot: adjacent.data.course.startSlot, endSlot: adjacent.data.course.endSlot },
    { id: 'course-a', startSlot: 1, endSlot: 2 }
  );

  const updated = await request(baseUrl, '/api/my/courses/course-editable', {
    token,
    method: 'PUT',
    body: { day: 1, slot: 3, name: 'A-物理', weeks: [1] }
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(
    { id: updated.data.course.id, startSlot: updated.data.course.startSlot, endSlot: updated.data.course.endSlot },
    { id: 'course-a', startSlot: 1, endSlot: 3 }
  );

  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.ok(disk.courses.some((course) => course.id === 'course-a'));
  assert.equal(disk.courses.some((course) => course.id === 'course-editable'), false);
  const storedLogical = disk.courses.filter((course) => course.name === 'A-物理');
  assert.equal(storedLogical.length, 1);
  assert.deepEqual(
    { id: storedLogical[0].id, startSlot: storedLogical[0].startSlot, endSlot: storedLogical[0].endSlot },
    { id: 'course-a', startSlot: 1, endSlot: 3 }
  );
  const me = await request(baseUrl, '/api/auth/me', { token });
  const logical = me.data.courses.filter((course) => course.name === 'A-物理');
  assert.equal(logical.length, 1);
  assert.deepEqual(
    { id: logical[0].id, startSlot: logical[0].startSlot, endSlot: logical[0].endSlot },
    { id: 'course-a', startSlot: 1, endSlot: 3 }
  );

  const aliasCourse = await request(baseUrl, '/api/my/courses', {
    token,
    method: 'POST',
    body: { day: 2, slot: 8, name: ' ', courseName: 'Alias Course', location: '', room: 'Room A101', weeks: [1] }
  });
  assert.equal(aliasCourse.status, 200);
  assert.equal(aliasCourse.data.course.name, 'Alias Course');
  assert.equal(aliasCourse.data.course.location, 'Room A101');
});

test('/api/my/import append reports input count separately from logical result count', async (t) => {
  const initial = seedDb();
  initial.courses = initial.courses.map((course) => course.id === 'course-a' ? { ...course, source: 'manual' } : course);
  const { baseUrl } = await launchBackend(t, initial);
  const login = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: 'alpha', password: 'pass-a' }
  });

  const imported = await request(baseUrl, '/api/my/import', {
    token: login.data.token,
    method: 'POST',
    body: {
      replace: false,
      courses: [
        { day: 1, slot: 1, name: 'A-物理', weeks: [1] },
        { day: 1, slot: 2, name: 'A-物理', weeks: [1] }
      ]
    }
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.count, 2);
  assert.equal(imported.data.logicalCount, 1);
  assert.equal(imported.data.mergedCount, 2);

  const me = await request(baseUrl, '/api/auth/me', { token: login.data.token });
  const logical = me.data.courses.filter((course) => course.name === 'A-物理');
  assert.equal(logical.length, 1);
  assert.deepEqual(
    { startSlot: logical[0].startSlot, endSlot: logical[0].endSlot },
    { startSlot: 1, endSlot: 2 }
  );
});

test('/api/auth/me exposes one JWXT logical session while preserving schedule variants on disk', async (t) => {
  const initial = seedDb();
  const base = {
    userId: 'user-a',
    accountId: 'account-a',
    day: 3,
    slot: 1,
    startSlot: 1,
    endSlot: 2,
    name: 'Chemical Engineering Principles',
    location: 'Building A 0411',
    source: 'jwxt',
    sourceDetail: 'kbList',
    importTraceId: 'trace-family',
    classGroup: 'class-family',
    oddEven: 'all'
  };
  initial.courses = [
    { ...base, id: 'family-full', weeks: [1, 2, 3, 4], teacher: 'Teacher Foreign' },
    { ...base, id: 'family-first', weeks: [1, 2], teacher: 'Teacher Tian' },
    { ...base, id: 'family-second', weeks: [3, 4], teacher: 'Teacher Wang' },
    initial.courses.find((course) => course.id === 'course-b')
  ];
  const { baseUrl, dataFile } = await launchBackend(t, initial);
  const login = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: 'alpha', password: 'pass-a' }
  });

  const me = await request(baseUrl, '/api/auth/me', { token: login.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.courses.length, 1);
  assert.equal(me.data.courses[0].logicalSession, true);
  assert.deepEqual(me.data.courses[0].underlyingIds, ['family-full', 'family-first', 'family-second']);
  assert.deepEqual(
    { startSlot: me.data.courses[0].startSlot, endSlot: me.data.courses[0].endSlot },
    { startSlot: 1, endSlot: 2 }
  );

  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const rawFamily = disk.courses.filter((course) => course.importTraceId === 'trace-family');
  assert.equal(rawFamily.length, 3);
  assert.deepEqual(rawFamily.map((course) => course.id), ['family-full', 'family-first', 'family-second']);
});
