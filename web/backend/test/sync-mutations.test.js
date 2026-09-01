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
      server.close((error) => error ? reject(error) : resolve(port));
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

async function removeEventually(target) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function launch(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaode-sync-mutation-'));
  const dataFile = path.join(tempDir, 'db.json');
  const termA = 'account-a:2026:3';
  const termB = 'account-a:2027:3';
  fs.writeFileSync(dataFile, JSON.stringify({
    meta: { totalWeeks: 20 },
    slots: [],
    users: [{ id: 'user-a', accountId: 'account-a', username: 'alpha', password: 'pass-a', name: 'Alpha', role: 'user', switchKey: 'switch-a' }],
    accounts: [{ id: 'account-a', userId: 'user-a', username: 'alpha', name: 'Alpha', role: 'user', status: 'active', activeTermKey: termA }],
    settings: [{ id: 'set-a', userId: 'user-a', accountId: 'account-a', preferences: {}, slots: null, revision: 1 }],
    reminders: [{ id: 'rem-a', userId: 'user-a', accountId: 'account-a', settings: {} }],
    terms: [
      { id: 'term-a', userId: 'user-a', accountId: 'account-a', termKey: termA, xnm: '2026', xqm: '3', selectedTermLabel: '2026 第一学期', totalWeeks: 20, totalWeeksSource: 'manual', revision: 1 },
      { id: 'term-b', userId: 'user-a', accountId: 'account-a', termKey: termB, xnm: '2027', xqm: '3', selectedTermLabel: '2027 第一学期', totalWeeks: 20, totalWeeksSource: 'manual', revision: 1 }
    ],
    courses: [], sessions: [], feedbacks: [], importCodes: [], backups: []
  }, null, 2), 'utf8');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, NODE_ENV: 'test', XIAODE_DATA_FILE: dataFile, XIAODE_STORAGE: 'json', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve());
    await removeEventually(tempDir);
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(output.join(''));
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return { baseUrl, dataFile, termA, termB };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend did not start: ${output.join('')}`);
}

function mutation(overrides = {}) {
  return {
    operationId: 'op-create-1',
    accountId: 'account-a',
    termKey: 'account-a:2026:3',
    entityType: 'COURSE',
    entityLocalId: 'local-course-1',
    operationType: 'CREATE',
    payload: {
      localId: 'local-course-1',
      name: 'Offline Chemistry',
      location: 'Room 0411',
      teacher: 'Teacher',
      day: 1,
      slot: 1,
      weeks: [1, 2]
    },
    ...overrides
  };
}

test('sync mutation is idempotent, term explicit, account isolated and conflict safe', async (t) => {
  const { baseUrl, dataFile, termB } = await launch(t);
  const login = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'alpha', password: 'pass-a' } });
  const token = login.data.token;

  const createBody = mutation();
  const created = await request(baseUrl, '/api/my/sync/mutation', { token, method: 'POST', body: createBody });
  assert.equal(created.status, 200);
  assert.equal(created.data.serverEntity.location, 'Room 0411');
  assert.equal(created.data.revision, 1);

  const replay = await request(baseUrl, '/api/my/sync/mutation', { token, method: 'POST', body: createBody });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.serverId, created.data.serverId);
  const diskAfterReplay = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(diskAfterReplay.courses.filter((course) => course.clientLocalId === 'local-course-1').length, 1);

  const reusedWithDifferentPayload = await request(baseUrl, '/api/my/sync/mutation', {
    token,
    method: 'POST',
    body: mutation({ payload: { ...createBody.payload, location: 'Room 9999' } })
  });
  assert.equal(reusedWithDifferentPayload.status, 409);
  assert.equal(reusedWithDifferentPayload.data.conflict, true);

  const staleUpdate = await request(baseUrl, '/api/my/sync/mutation', {
    token,
    method: 'POST',
    body: mutation({
      operationId: 'op-update-stale',
      operationType: 'UPDATE',
      serverId: created.data.serverId,
      baseRevision: 99,
      payload: { ...createBody.payload, location: 'Room 0412' }
    })
  });
  assert.equal(staleUpdate.status, 409);
  assert.equal(staleUpdate.data.serverEntity.location, 'Room 0411');

  const updated = await request(baseUrl, '/api/my/sync/mutation', {
    token,
    method: 'POST',
    body: mutation({
      operationId: 'op-update-1',
      operationType: 'UPDATE',
      serverId: created.data.serverId,
      baseRevision: 1,
      payload: { ...createBody.payload, location: 'Room 0412' }
    })
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.revision, 2);
  assert.equal(updated.data.serverEntity.location, 'Room 0412');

  const inactiveTermCreate = await request(baseUrl, '/api/my/sync/mutation', {
    token,
    method: 'POST',
    body: mutation({
      operationId: 'op-create-inactive-term',
      termKey: termB,
      entityLocalId: 'local-course-term-b',
      payload: { ...createBody.payload, localId: 'local-course-term-b', name: 'Other Term Course' }
    })
  });
  assert.equal(inactiveTermCreate.status, 200);
  assert.equal(inactiveTermCreate.data.termKey, termB);

  const spoofed = await request(baseUrl, '/api/my/sync/mutation', {
    token,
    method: 'POST',
    body: mutation({ operationId: 'op-spoof', accountId: 'account-b' })
  });
  assert.equal(spoofed.status, 403);

  const snapshot = await request(baseUrl, '/api/my/sync/snapshot', { token });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.courses.some((course) => course.name === 'Offline Chemistry' && course.location === 'Room 0412'), true);
  assert.equal(snapshot.data.courses.some((course) => course.name === 'Other Term Course' && course.termKey === termB), true);
  assert.equal(snapshot.data.availableTerms.length, 2);
  assert.equal(Object.hasOwn(snapshot.data.user, 'password'), false);
  assert.equal(JSON.stringify(snapshot.data).includes(token), false);

  const deletedBody = mutation({
    operationId: 'op-delete-1',
    operationType: 'DELETE',
    serverId: created.data.serverId,
    baseRevision: 2,
    payload: { serverId: created.data.serverId }
  });
  const deleted = await request(baseUrl, '/api/my/sync/mutation', { token, method: 'POST', body: deletedBody });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.deleted, true);
  const deleteReplay = await request(baseUrl, '/api/my/sync/mutation', { token, method: 'POST', body: deletedBody });
  assert.deepEqual(deleteReplay.data, deleted.data);
  const finalSnapshot = await request(baseUrl, '/api/my/sync/snapshot', { token });
  assert.equal(finalSnapshot.data.courses.some((course) => course.clientLocalId === 'local-course-1'), false);
});

test('preferences and active-term mutations use revisions without depending on implicit active term', async (t) => {
  const { baseUrl, termB } = await launch(t);
  const login = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'alpha', password: 'pass-a' } });
  const token = login.data.token;
  const preferences = await request(baseUrl, '/api/my/sync/mutation', {
    token,
    method: 'POST',
    body: {
      operationId: 'op-prefs', accountId: 'account-a', termKey: '', entityType: 'PREFERENCES',
      entityLocalId: 'account-a', operationType: 'UPDATE', baseRevision: 1,
      payload: { preferences: { theme: 'ocean', tableSize: 'screenshot' } }
    }
  });
  assert.equal(preferences.status, 200);
  assert.equal(preferences.data.preferences.theme, 'ocean');

  const activeTerm = await request(baseUrl, '/api/my/sync/mutation', {
    token,
    method: 'POST',
    body: {
      operationId: 'op-active-term', accountId: 'account-a', termKey: termB, entityType: 'ACTIVE_TERM',
      entityLocalId: 'account-a', operationType: 'UPDATE', baseRevision: 1, payload: { termKey: termB }
    }
  });
  assert.equal(activeTerm.status, 200);
  const snapshot = await request(baseUrl, '/api/my/sync/snapshot', { token });
  assert.equal(snapshot.data.activeTermKey, termB);
  assert.equal(snapshot.data.preferences.theme, 'ocean');
});

test('template selection mutations remap from preserved source slots instead of reinterpreting display rows', async (t) => {
  const { baseUrl, termA } = await launch(t);
  const login = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'alpha', password: 'pass-a' } });
  const token = login.data.token;
  const initial = await request(baseUrl, '/api/my/sync/snapshot', { token });
  const initialTerm = initial.data.availableTerms.find((term) => term.termKey === termA);

  const created = await request(baseUrl, '/api/my/sync/mutation', {
    token,
    method: 'POST',
    body: mutation({
      operationId: 'op-template-source-course',
      entityLocalId: 'template-source-course',
      payload: {
        localId: 'template-source-course', name: 'Source Five', day: 1,
        sourceStartSlot: 5, sourceEndSlot: 5, slot: 5, weeks: [1]
      }
    })
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.serverEntity.sourceStartSlot, 5);

  const selectedA = await request(baseUrl, '/api/my/sync/mutation', {
    token,
    method: 'POST',
    body: {
      operationId: 'op-select-school-a', accountId: 'account-a', termKey: termA,
      entityType: 'TERM', entityLocalId: `account-a::${termA}`, operationType: 'UPDATE',
      baseRevision: initialTerm.revision, payload: { scheduleTemplateId: 'school-a-v1' }
    }
  });
  assert.equal(selectedA.status, 200);
  let snapshot = await request(baseUrl, '/api/my/sync/snapshot', { token });
  let course = snapshot.data.courses.find((item) => item.clientLocalId === 'template-source-course');
  assert.equal(course.sourceStartSlot, 5);
  assert.equal(course.startSlot, 5);
  assert.equal(course.startSlotKey, 'MIDDAY_1');

  const selectedB = await request(baseUrl, '/api/my/sync/mutation', {
    token,
    method: 'POST',
    body: {
      operationId: 'op-select-school-b', accountId: 'account-a', termKey: termA,
      entityType: 'TERM', entityLocalId: `account-a::${termA}`, operationType: 'UPDATE',
      baseRevision: selectedA.data.revision, payload: { scheduleTemplateId: 'school-b-v1' }
    }
  });
  assert.equal(selectedB.status, 200);
  snapshot = await request(baseUrl, '/api/my/sync/snapshot', { token });
  course = snapshot.data.courses.find((item) => item.clientLocalId === 'template-source-course');
  assert.equal(course.sourceStartSlot, 5);
  assert.equal(course.startSlot, 5);
  assert.equal(course.startSlotKey, 'P5');
});
