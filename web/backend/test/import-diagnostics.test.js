import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImportDiagnosticsStore } from '../src/import-diagnostics-store.js';

test('diagnostics disabled keeps memory summary and creates no files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaode-diag-off-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createImportDiagnosticsStore({ enabled: false, dataFile: path.join(root, 'db.json') });
  const trace = store.begin({ accountId: 'account-a', replace: true, xnm: '2026', xqm: '12' });
  store.finish(trace, { status: 'success', summary: { written: 2 }, message: 'ok' });
  assert.equal(store.status().enabled, false);
  assert.equal(store.latestForAccount('account-a').summary.written, 2);
  assert.equal(fs.existsSync(path.join(root, 'import-diagnostics')), false);
});

test('diagnostics enabled writes redacted atomic traces and enforces retention', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaode-diag-on-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'import-diagnostics');
  const store = createImportDiagnosticsStore({ enabled: true, keep: 2, dataFile: path.join(root, 'db.json'), directory });
  for (let index = 0; index < 3; index += 1) {
    const trace = store.begin({ accountId: 'account-a', replace: true, xnm: '2026', xqm: '12' });
    store.finish(trace, {
      status: 'success',
      summary: { written: index },
      password: 'must-not-persist',
      Cookie: 'must-not-persist',
      token: 'must-not-persist',
      jwxtData: { private: true },
      candidates: [{ rawFieldNames: ['kcmc', 'xqj'], name: '脱敏夹具课程' }]
    });
  }
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 2);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
  for (const file of files) {
    const text = fs.readFileSync(path.join(directory, file), 'utf8');
    assert.doesNotMatch(text, /must-not-persist|password|Cookie|jwxtData/);
  }
  assert.equal(store.list().length, 3);
  assert.equal(store.status().diskCount, 2);
});

