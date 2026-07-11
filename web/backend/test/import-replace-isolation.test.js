import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const fixture = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/jwxt/standard-kblist.json'), 'utf8'));

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

async function request(baseUrl, route, { token = '', method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-user-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, data: await response.json() };
}

async function waitForHealth(baseUrl, child, output) {
  for (let index = 0; index < 80; index += 1) {
    if (child.exitCode !== null) throw new Error(`backend exited: ${output.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`backend health timeout: ${output.join('')}`);
}

function preferences(theme) {
  return { theme, courseSettings: { totalWeeks: '20', weekStartDay: '1' }, reminderSettings: {} };
}

function seedDb() {
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  return {
    meta: { totalWeeks: 20, termStart: '2026-02-23' },
    slots: [],
    users: [
      { id: 'user-a', accountId: 'account-a', username: 'fixture-a', password: 'fixture-pass-a', name: 'Fixture A', role: 'user', switchKey: 'switch-a', preferences: preferences('ocean') },
      { id: 'user-b', accountId: 'account-b', username: 'fixture-b', password: 'fixture-pass-b', name: 'Fixture B', role: 'user', switchKey: 'switch-b', preferences: preferences('sunset') }
    ],
    accounts: [
      { id: 'account-a', userId: 'user-a', username: 'fixture-a', name: 'Fixture A', role: 'user', status: 'active' },
      { id: 'account-b', userId: 'user-b', username: 'fixture-b', name: 'Fixture B', role: 'user', status: 'active' }
    ],
    settings: [
      { id: 'set-a', userId: 'user-a', accountId: 'account-a', preferences: preferences('ocean'), slots: null },
      { id: 'set-b', userId: 'user-b', accountId: 'account-b', preferences: preferences('sunset'), slots: null }
    ],
    reminders: [
      { id: 'rem-a', userId: 'user-a', accountId: 'account-a', settings: {} },
      { id: 'rem-b', userId: 'user-b', accountId: 'account-b', settings: {} }
    ],
    courses: [
      { id: 'a-manual', userId: 'user-a', accountId: 'account-a', source: 'manual', day: 1, slot: 1, name: 'A 手动课程', weeks: [1] },
      { id: 'a-jwxt-current', userId: 'user-a', accountId: 'account-a', source: 'jwxt', termKey: '2026:12', day: 2, slot: 2, name: 'A 旧教务课程', weeks: [1] },
      { id: 'a-jwxt-other', userId: 'user-a', accountId: 'account-a', source: 'jwxt', termKey: '2025:12', day: 3, slot: 3, name: 'A 其他学期课程', weeks: [1] },
      { id: 'b-manual', userId: 'user-b', accountId: 'account-b', source: 'manual', day: 1, slot: 1, name: 'B 手动课程', weeks: [1] }
    ],
    sessions: [
      { token: 'fixture-token-a', userId: 'user-a', accountId: 'account-a', createdAt: new Date().toISOString() },
      { token: 'fixture-token-b', userId: 'user-b', accountId: 'account-b', createdAt: new Date().toISOString() }
    ],
    feedbacks: [],
    importCodes: [
      { code: 'EXPIRED1', userId: 'user-a', accountId: 'account-a', username: 'fixture-a', replace: true, xnm: '2026', xqm: '12', createdAt: expiredAt, expiresAt: expiredAt, usedAt: null }
    ],
    backups: []
  };
}

async function launch(t, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaode-import-api-'));
  const dataFile = path.join(root, 'db.json');
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
      XIAODE_IMPORT_DIAGNOSTICS: '0',
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
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl, child, output);
  return { baseUrl, dataFile, root };
}

async function createCode(baseUrl, token = 'fixture-token-a', replace = true) {
  return request(baseUrl, '/api/my/import-code', { token, method: 'POST', body: { replace, xnm: '2026', xqm: '12' } });
}

test('replace is atomic, account scoped, term scoped and preserves manual courses', async (t) => {
  const { baseUrl, dataFile, root } = await launch(t, { XIAODE_IMPORT_DIAGNOSTICS: '1', XIAODE_IMPORT_DIAGNOSTICS_KEEP: '20' });
  const code = await createCode(baseUrl);
  assert.equal(code.status, 200);
  const beforeAudit = (await request(baseUrl, '/api/health')).data.testAudit.writeDbCallCount;
  const imported = await request(baseUrl, `/api/import-code/${code.data.code}/submit`, {
    method: 'POST',
    body: { accountId: 'account-a', jwxtData: fixture }
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.ok, true);
  assert.ok(imported.data.traceId.startsWith('imp_'));
  assert.deepEqual(imported.data.summary, { received: 3, recognized: 3, accepted: 5, filtered: 0, merged: 0, written: 5, beforeCount: 3, afterCount: 7 });
  assert.equal(imported.data.refreshRequired, true);
  const afterAudit = (await request(baseUrl, '/api/health')).data.testAudit.writeDbCallCount;
  assert.equal(afterAudit - beforeAudit, 1);

  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.ok(disk.courses.some((course) => course.id === 'a-manual'));
  assert.ok(disk.courses.some((course) => course.id === 'a-jwxt-other'));
  assert.equal(disk.courses.some((course) => course.id === 'a-jwxt-current'), false);
  assert.deepEqual(disk.courses.filter((course) => course.accountId === 'account-b').map((course) => course.id), ['b-manual']);
  assert.equal(disk.courses.filter((course) => course.accountId === 'account-a' && course.source === 'jwxt' && course.termKey === '2026:12').length, 5);
  assert.ok(disk.backups.some((backup) => backup.kind === 'pre-import' && backup.accountId === 'account-a' && backup.traceId === imported.data.traceId));
  assert.equal(disk.importCodes.find((item) => item.code === code.data.code).traceId, imported.data.traceId);

  const latestA = await request(baseUrl, '/api/my/import-diagnostics/latest', { token: 'fixture-token-a' });
  assert.equal(latestA.status, 200);
  assert.equal(latestA.data.trace.traceId, imported.data.traceId);
  assert.equal((await request(baseUrl, '/api/my/import-diagnostics/latest', { token: 'fixture-token-b' })).status, 404);
  const diagnosticsDir = path.join(root, 'import-diagnostics');
  const files = fs.readdirSync(diagnosticsDir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const persisted = fs.readFileSync(path.join(diagnosticsDir, files[0]), 'utf8');
  assert.doesNotMatch(persisted, /fixture-token|fixture-pass|Cookie|authorization/i);

  const reused = await request(baseUrl, `/api/import-code/${code.data.code}/submit`, { method: 'POST', body: { accountId: 'account-a', jwxtData: fixture } });
  assert.equal(reused.status, 409);
  assert.equal(reused.data.reasonCode, 'USED_IMPORT_CODE');
});

test('invalid, expired and account-mismatched imports preserve all existing courses', async (t) => {
  const { baseUrl, dataFile } = await launch(t);
  const initialIds = JSON.parse(fs.readFileSync(dataFile, 'utf8')).courses.map((course) => course.id).sort();

  const expired = await request(baseUrl, '/api/import-code/EXPIRED1/submit', { method: 'POST', body: { accountId: 'account-a', jwxtData: fixture } });
  assert.equal(expired.status, 410);
  assert.equal(expired.data.reasonCode, 'EXPIRED_IMPORT_CODE');

  const mismatchCode = await createCode(baseUrl);
  const mismatch = await request(baseUrl, `/api/import-code/${mismatchCode.data.code}/submit`, { method: 'POST', body: { accountId: 'account-b', jwxtData: fixture } });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.data.reasonCode, 'ACCOUNT_MISMATCH');

  const invalidCode = await createCode(baseUrl);
  const invalid = await request(baseUrl, `/api/import-code/${invalidCode.data.code}/submit`, { method: 'POST', body: { accountId: 'account-a', jwxtData: { kbList: [] } } });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.data.traceId);
  assert.equal(invalid.data.reasonCode, 'UNSUPPORTED_STRUCTURE');
  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.deepEqual(disk.courses.map((course) => course.id).sort(), initialIds);
  assert.equal(disk.importCodes.find((item) => item.code === invalidCode.data.code).usedAt, null);
  assert.equal(fs.existsSync(path.join(path.dirname(dataFile), 'import-diagnostics')), false);
});

test('MySQL failure does not block traced JSON import', async (t) => {
  const { baseUrl, dataFile } = await launch(t, {
    XIAODE_STORAGE: 'mysql',
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '1',
    MYSQL_CONNECT_TIMEOUT_MS: '250',
    MYSQL_RETRY_COOLDOWN_MS: '1000'
  });
  const code = await createCode(baseUrl);
  const imported = await request(baseUrl, `/api/import-code/${code.data.code}/submit`, { method: 'POST', body: { accountId: 'account-a', jwxtData: fixture } });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.summary.written, 5);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const health = await request(baseUrl, '/api/health');
  assert.equal(health.data.storage.primary, 'db.json');
  assert.equal(health.data.storage.mysqlMirror.ok, false);
  assert.ok(JSON.parse(fs.readFileSync(dataFile, 'utf8')).courses.some((course) => course.importTraceId === imported.data.traceId));
});
