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
      { code: 'EXPIRED1', userId: 'user-a', accountId: 'account-a', username: 'fixture-a', replace: true, selectedTermLabel: '2026-2027 第二学期', xnm: '2026', xqm: '12', createdAt: expiredAt, expiresAt: expiredAt, usedAt: null }
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

async function createCode(baseUrl, token = 'fixture-token-a', replace = true, term = frozenTerm) {
  return request(baseUrl, '/api/my/import-code', { token, method: 'POST', body: { replace, ...term } });
}

const frozenTerm = { selectedTermLabel: '2026-2027 第二学期', xnm: '2026', xqm: '12' };
const firstTerm = { selectedTermLabel: '2025-2026 第一学期', xnm: '2025', xqm: '3' };

function fixtureForTerm(term, suffix = '') {
  const cloned = structuredClone(fixture);
  cloned.kbList = cloned.kbList.map((item) => ({ ...item, kcmc: `${item.kcmc}${suffix}`, xnm: term.xnm, xqm: term.xqm }));
  return cloned;
}

test('replace is atomic, account scoped, term scoped and preserves manual courses', async (t) => {
  const { baseUrl, dataFile, root } = await launch(t, { XIAODE_IMPORT_DIAGNOSTICS: '1', XIAODE_IMPORT_DIAGNOSTICS_KEEP: '20' });
  const code = await createCode(baseUrl);
  assert.equal(code.status, 200);
  const beforeAudit = (await request(baseUrl, '/api/health')).data.testAudit.writeDbCallCount;
  const imported = await request(baseUrl, `/api/import-code/${code.data.code}/submit`, {
    method: 'POST',
    body: { accountId: 'account-a', replace: true, ...frozenTerm, jwxtData: fixture }
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.ok, true);
  assert.ok(imported.data.traceId.startsWith('imp_'));
  assert.equal(imported.data.totalWeeks, 16);
  assert.equal(imported.data.totalWeeksSource, 'course-max-week');
  assert.deepEqual(imported.data.summary, {
    received: 3, recognized: 3, accepted: 5, filtered: 0, merged: 0, written: 5,
    beforeCount: 1, afterCount: 5, rawCount: 3, acceptedCount: 3, importedCount: 5,
    filteredWrongTermCount: 0, filteredUnknownSourceCount: 0
  });
  assert.equal(imported.data.refreshRequired, true);
  assert.deepEqual(imported.data.requestedTerm, { xnm: '2026', xqm: '12', label: '2026-2027 第二学期', verifiedByResponse: false });
  assert.deepEqual(imported.data.effectiveTerm, { xnm: '2026', xqm: '12', label: '2026-2027 第二学期', verifiedByResponse: true });
  const afterAudit = (await request(baseUrl, '/api/health')).data.testAudit.writeDbCallCount;
  assert.equal(afterAudit - beforeAudit, 1);

  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.ok(disk.courses.some((course) => course.id === 'a-manual'));
  assert.ok(disk.courses.some((course) => course.id === 'a-jwxt-other'));
  assert.equal(disk.courses.some((course) => course.id === 'a-jwxt-current'), false);
  assert.deepEqual(disk.courses.filter((course) => course.accountId === 'account-b').map((course) => course.id), ['b-manual']);
  assert.equal(disk.courses.filter((course) => course.accountId === 'account-a' && course.source === 'jwxt' && course.termKey === 'account-a:2026:12').length, 5);
  assert.ok(disk.backups.some((backup) => backup.kind === 'pre-import' && backup.accountId === 'account-a' && backup.traceId === imported.data.traceId));
  assert.equal(disk.importCodes.find((item) => item.code === code.data.code).traceId, imported.data.traceId);

  const latestA = await request(baseUrl, '/api/my/import-diagnostics/latest', { token: 'fixture-token-a' });
  assert.equal(latestA.status, 200);
  assert.equal(latestA.data.trace.traceId, imported.data.traceId);
  assert.equal(latestA.data.trace.selectedTermLabel, frozenTerm.selectedTermLabel);
  assert.equal(latestA.data.trace.requestedXnm, frozenTerm.xnm);
  assert.equal(latestA.data.trace.requestedXqm, frozenTerm.xqm);
  assert.equal(latestA.data.trace.effectiveXnm, frozenTerm.xnm);
  assert.equal(latestA.data.trace.effectiveXqm, frozenTerm.xqm);
  assert.equal((await request(baseUrl, '/api/my/import-diagnostics/latest', { token: 'fixture-token-b' })).status, 404);
  const diagnosticsDir = path.join(root, 'import-diagnostics');
  const files = fs.readdirSync(diagnosticsDir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const persisted = fs.readFileSync(path.join(diagnosticsDir, files[0]), 'utf8');
  assert.doesNotMatch(persisted, /fixture-token|fixture-pass|Cookie|authorization/i);
  assert.equal(JSON.parse(persisted).importedCount, 5);

  const reused = await request(baseUrl, `/api/import-code/${code.data.code}/submit`, { method: 'POST', body: { accountId: 'account-a', replace: true, ...frozenTerm, jwxtData: fixture } });
  assert.equal(reused.status, 409);
  assert.equal(reused.data.reasonCode, 'USED_IMPORT_CODE');
});

test('invalid, expired and account-mismatched imports preserve all existing courses', async (t) => {
  const { baseUrl, dataFile } = await launch(t);
  const initialIds = JSON.parse(fs.readFileSync(dataFile, 'utf8')).courses.map((course) => course.id).sort();

  const expired = await request(baseUrl, '/api/import-code/EXPIRED1/submit', { method: 'POST', body: { accountId: 'account-a', replace: true, ...frozenTerm, jwxtData: fixture } });
  assert.equal(expired.status, 410);
  assert.equal(expired.data.reasonCode, 'EXPIRED_IMPORT_CODE');

  const mismatchCode = await createCode(baseUrl);
  const mismatch = await request(baseUrl, `/api/import-code/${mismatchCode.data.code}/submit`, { method: 'POST', body: { accountId: 'account-b', replace: true, ...frozenTerm, jwxtData: fixture } });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.data.reasonCode, 'ACCOUNT_MISMATCH');

  const invalidCode = await createCode(baseUrl);
  const invalid = await request(baseUrl, `/api/import-code/${invalidCode.data.code}/submit`, { method: 'POST', body: { accountId: 'account-a', replace: true, ...frozenTerm, jwxtData: { kbList: [] } } });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.data.traceId);
  assert.equal(invalid.data.reasonCode, 'UNSUPPORTED_STRUCTURE');
  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.deepEqual(disk.courses.map((course) => course.id).sort(), initialIds);
  assert.equal(disk.importCodes.find((item) => item.code === invalidCode.data.code).usedAt, null);
  assert.equal(fs.existsSync(path.join(path.dirname(dataFile), 'import-diagnostics')), false);
});

test('term parameters are explicit and response mismatch never writes db.json', async (t) => {
  const { baseUrl, dataFile } = await launch(t);
  const beforeMissing = (await request(baseUrl, '/api/health')).data.testAudit.writeDbCallCount;
  const missing = await request(baseUrl, '/api/my/import-code', { token: 'fixture-token-a', method: 'POST', body: { replace: true } });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.reasonCode, 'MISSING_TERM_PARAMS');
  const invalid = await request(baseUrl, '/api/my/import-code', { token: 'fixture-token-a', method: 'POST', body: { replace: true, selectedTermLabel: 'invalid', xnm: 'year', xqm: 'semester' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.reasonCode, 'INVALID_TERM_PARAMS');
  assert.equal((await request(baseUrl, '/api/health')).data.testAudit.writeDbCallCount, beforeMissing);

  const second = await createCode(baseUrl, 'fixture-token-a', true, frozenTerm);
  const first = await createCode(baseUrl, 'fixture-token-a', true, firstTerm);
  assert.notEqual(second.data.xqm, first.data.xqm);
  assert.notEqual(second.data.selectedTermLabel, first.data.selectedTermLabel);

  const staleContext = await request(baseUrl, `/api/import-code/${second.data.code}/submit`, {
    method: 'POST',
    body: { accountId: 'account-a', replace: true, ...firstTerm, jwxtData: fixtureForTerm(frozenTerm) }
  });
  assert.equal(staleContext.status, 403);
  assert.equal(staleContext.data.reasonCode, 'INVALID_TERM_PARAMS');

  const idsBeforeMismatch = JSON.parse(fs.readFileSync(dataFile, 'utf8')).courses.map((course) => course.id).sort();
  const writesBeforeMismatch = (await request(baseUrl, '/api/health')).data.testAudit.writeDbCallCount;
  const mismatch = await request(baseUrl, `/api/import-code/${second.data.code}/submit`, {
    method: 'POST',
    body: { accountId: 'account-a', replace: true, ...frozenTerm, jwxtData: fixtureForTerm(firstTerm, '-错误学期') }
  });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.data.reasonCode, 'TERM_RESPONSE_MISMATCH');
  assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')).courses.map((course) => course.id).sort(), idsBeforeMismatch);
  assert.equal((await request(baseUrl, '/api/health')).data.testAudit.writeDbCallCount, writesBeforeMismatch);
});

test('replace is isolated by both accountId and selected term', async (t) => {
  const { baseUrl, dataFile } = await launch(t);
  const secondCode = await createCode(baseUrl, 'fixture-token-a', true, frozenTerm);
  assert.equal((await request(baseUrl, `/api/import-code/${secondCode.data.code}/submit`, {
    method: 'POST', body: { accountId: 'account-a', replace: true, ...frozenTerm, jwxtData: fixtureForTerm(frozenTerm, '-A二') }
  })).status, 200);

  const firstCodeA = await createCode(baseUrl, 'fixture-token-a', true, firstTerm);
  assert.equal((await request(baseUrl, `/api/import-code/${firstCodeA.data.code}/submit`, {
    method: 'POST', body: { accountId: 'account-a', replace: true, ...firstTerm, jwxtData: fixtureForTerm(firstTerm, '-A一') }
  })).status, 200);

  const firstCodeB = await createCode(baseUrl, 'fixture-token-b', true, firstTerm);
  assert.equal((await request(baseUrl, `/api/import-code/${firstCodeB.data.code}/submit`, {
    method: 'POST', body: { accountId: 'account-b', replace: true, ...firstTerm, jwxtData: fixtureForTerm(firstTerm, '-B一') }
  })).status, 200);

  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(disk.courses.filter((course) => course.accountId === 'account-a' && course.termKey === 'account-a:2026:12' && course.source === 'jwxt').length, 5);
  assert.equal(disk.courses.filter((course) => course.accountId === 'account-a' && course.termKey === 'account-a:2025:3' && course.source === 'jwxt').length, 5);
  assert.equal(disk.courses.filter((course) => course.accountId === 'account-b' && course.termKey === 'account-b:2025:3' && course.source === 'jwxt').length, 5);
  assert.ok(disk.courses.some((course) => course.id === 'a-manual'));
  assert.ok(disk.courses.some((course) => course.id === 'b-manual'));
});

test('activeTerm isolates display, strict sources and dynamic week limits per term', async (t) => {
  const { baseUrl, dataFile } = await launch(t);
  const firstPayload = fixtureForTerm(firstTerm, '-第一学期');
  firstPayload.totalWeeks = 20;
  firstPayload.kbList.push({
    kcmc: '不应混入的第二学期课程', xnm: frozenTerm.xnm, xqm: frozenTerm.xqm,
    xqj: 1, jcor: '1节', zcd: '1-17周'
  });
  firstPayload.historyRows = [{
    kcmc: '未知数组历史课程', xnm: '2024', xqm: '12', xqj: 2, jcor: '2节', zcd: '1-18周'
  }];

  const firstCode = await createCode(baseUrl, 'fixture-token-a', true, firstTerm);
  const firstImport = await request(baseUrl, `/api/import-code/${firstCode.data.code}/submit`, {
    method: 'POST',
    body: { accountId: 'account-a', replace: true, ...firstTerm, jwxtData: firstPayload }
  });
  assert.equal(firstImport.status, 200);
  assert.equal(firstImport.data.summary.filteredWrongTermCount, 1);
  assert.equal(firstImport.data.summary.filteredUnknownSourceCount, 1);
  assert.equal(firstImport.data.summary.rawCount, 5);
  assert.equal(firstImport.data.totalWeeks, 20);
  assert.equal(firstImport.data.totalWeeksSource, 'jwxt-response');
  assert.equal(firstImport.data.activeTerm.termKey, 'account-a:2025:3');
  assert.equal(firstImport.data.activeTerm.courseCount, 5);

  const secondPayload = fixtureForTerm(frozenTerm, '-第二学期');
  secondPayload.totalWeeks = 17;
  const secondCode = await createCode(baseUrl, 'fixture-token-a', true, frozenTerm);
  const secondImport = await request(baseUrl, `/api/import-code/${secondCode.data.code}/submit`, {
    method: 'POST',
    body: { accountId: 'account-a', replace: true, ...frozenTerm, jwxtData: secondPayload }
  });
  assert.equal(secondImport.status, 200);
  assert.equal(secondImport.data.totalWeeks, 17);

  const activeSecond = await request(baseUrl, '/api/auth/me', { token: 'fixture-token-a' });
  assert.equal(activeSecond.data.activeTerm.termKey, 'account-a:2026:12');
  assert.equal(activeSecond.data.totalWeeks, 17);
  assert.ok(activeSecond.data.courses.every((course) => course.termKey === 'account-a:2026:12' && course.name.endsWith('-第二学期')));
  assert.equal(activeSecond.data.courses.some((course) => course.name.includes('第一学期')), false);

  const switchedFirst = await request(baseUrl, '/api/my/active-term', {
    token: 'fixture-token-a', method: 'PUT', body: { termKey: 'account-a:2025:3' }
  });
  assert.equal(switchedFirst.status, 200);
  assert.equal(switchedFirst.data.activeTerm.totalWeeks, 20);
  const activeFirst = await request(baseUrl, '/api/auth/me', { token: 'fixture-token-a' });
  assert.ok(activeFirst.data.courses.every((course) => course.termKey === 'account-a:2025:3' && course.name.endsWith('-第一学期')));
  assert.equal(activeFirst.data.courses.some((course) => course.name.includes('第二学期')), false);

  const manualWeeks = await request(baseUrl, '/api/my/active-term/settings', {
    token: 'fixture-token-a', method: 'PUT', body: { totalWeeks: 20, termStart: '2025-09-01' }
  });
  assert.equal(manualWeeks.status, 200);
  assert.equal(manualWeeks.data.activeTerm.totalWeeksSource, 'manual');
  assert.equal(manualWeeks.data.activeTerm.termStart, '2025-09-01');

  const diskBeforeReplace = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const secondIds = diskBeforeReplace.courses
    .filter((course) => course.termKey === 'account-a:2026:12')
    .map((course) => course.id).sort();
  const replaceFirstCode = await createCode(baseUrl, 'fixture-token-a', true, firstTerm);
  const replacement = fixtureForTerm(firstTerm, '-第一学期新版');
  replacement.totalWeeks = 20;
  assert.equal((await request(baseUrl, `/api/import-code/${replaceFirstCode.data.code}/submit`, {
    method: 'POST', body: { accountId: 'account-a', replace: true, ...firstTerm, jwxtData: replacement }
  })).status, 200);
  const diskAfterReplace = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.deepEqual(diskAfterReplace.courses.filter((course) => course.termKey === 'account-a:2026:12').map((course) => course.id).sort(), secondIds);
  assert.ok(diskAfterReplace.courses.filter((course) => course.termKey === 'account-a:2025:3').every((course) => course.name.endsWith('新版')));

  const modeCode = await createCode(baseUrl, 'fixture-token-a', true, firstTerm);
  const mismatchedMode = await request(baseUrl, `/api/import-code/${modeCode.data.code}/submit`, {
    method: 'POST', body: { accountId: 'account-a', replace: false, ...firstTerm, jwxtData: replacement }
  });
  assert.equal(mismatchedMode.status, 403);
  assert.equal(mismatchedMode.data.reasonCode, 'INVALID_TERM_PARAMS');
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
  const imported = await request(baseUrl, `/api/import-code/${code.data.code}/submit`, { method: 'POST', body: { accountId: 'account-a', replace: true, ...frozenTerm, jwxtData: fixture } });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.summary.written, 5);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const health = await request(baseUrl, '/api/health');
  assert.equal(health.data.storage.primary, 'db.json');
  assert.equal(health.data.storage.mysqlMirror.ok, false);
  assert.ok(JSON.parse(fs.readFileSync(dataFile, 'utf8')).courses.some((course) => course.importTraceId === imported.data.traceId));
});
