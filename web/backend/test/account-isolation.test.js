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
      { id: 'course-a', userId: 'user-a', accountId: 'account-a', day: 1, slot: 1, name: 'Alpha Course', weeks: [1] },
      { id: 'course-b', userId: 'user-b', accountId: 'account-b', day: 2, slot: 2, name: 'Beta Course', weeks: [1] }
    ],
    sessions: [],
    feedbacks: [],
    importCodes: [],
    backups: []
  };
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
  assert.deepEqual(meA.data.courses.map((course) => course.name), ['Alpha Course']);
  assert.equal(meA.data.preferences.theme, 'ocean');
  assert.deepEqual(meB.data.courses.map((course) => course.name), ['Beta Course']);
  assert.equal(meB.data.preferences.theme, 'sunset');

  const spoofedCourse = await request(baseUrl, '/api/my/courses', {
    token: tokenA,
    method: 'POST',
    body: { accountId: 'account-b', day: 3, slot: 3, name: 'Forced Alpha Course' }
  });
  assert.equal(spoofedCourse.status, 200);
  assert.equal(spoofedCourse.data.course.accountId, 'account-a');
  const crossAccountEdit = await request(baseUrl, '/api/my/courses/course-b', {
    token: tokenA,
    method: 'PUT',
    body: { name: 'Should Not Change' }
  });
  assert.equal(crossAccountEdit.status, 404);

  const updatedPreferences = preferences('forest', 'cal-a-2');
  const preferenceUpdate = await request(baseUrl, '/api/my/preferences', {
    token: tokenA,
    method: 'PUT',
    body: { preferences: updatedPreferences }
  });
  assert.equal(preferenceUpdate.status, 200);
  const meBAfterPreferenceUpdate = await request(baseUrl, '/api/auth/me', { token: tokenB });
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
  assert.deepEqual(meBAfterImport.data.courses.map((course) => course.name), ['Beta Course']);

  const backupA = await request(baseUrl, '/api/my/backup', { token: tokenA });
  assert.equal(backupA.data.backup.account.id, 'account-a');
  assert.deepEqual(backupA.data.backup.courses.map((course) => course.name), ['Alpha Imported']);

  const importCode = await request(baseUrl, '/api/my/import-code', { token: tokenA, method: 'POST', body: { replace: true } });
  assert.equal(importCode.data.accountId, 'account-a');
  const mismatchedSubmit = await request(baseUrl, `/api/import-code/${importCode.data.code}/submit`, {
    method: 'POST',
    body: { accountId: 'account-b', jwxtData: { kbList: [] } }
  });
  assert.equal(mismatchedSubmit.status, 409);
  const codeSubmit = await request(baseUrl, `/api/import-code/${importCode.data.code}/submit`, {
    method: 'POST',
    body: {
      accountId: 'account-a',
      jwxtData: { kbList: [{ kcmc: 'Alpha Code Import', xqj: 5, ksjc: 5, jsjc: 5, zcd: '1-2周', xm: 'Teacher A', cdmc: 'Room A' }] }
    }
  });
  assert.equal(codeSubmit.status, 200);
  const meAAfterCode = await request(baseUrl, '/api/auth/me', { token: tokenA });
  const meBAfterCode = await request(baseUrl, '/api/auth/me', { token: tokenB });
  assert.deepEqual(meAAfterCode.data.courses.map((course) => course.name), ['Alpha Code Import']);
  assert.deepEqual(meBAfterCode.data.courses.map((course) => course.name), ['Beta Course']);

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
});
