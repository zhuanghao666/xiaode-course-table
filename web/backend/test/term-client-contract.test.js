import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve('..', '..');
const frontend = fs.readFileSync(path.join(repoRoot, 'web', 'frontend', 'public', 'index.html'), 'utf8');
const activity = fs.readFileSync(path.join(repoRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'xiaode', 'importhelper', 'MainActivity.kt'), 'utf8');
const widget = fs.readFileSync(path.join(repoRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'xiaode', 'importhelper', 'WidgetUpdater.kt'), 'utf8');

test('web reads active term limits and never navigates by global meta totalWeeks', () => {
  assert.match(frontend, /function getActiveTerm\(\)/);
  assert.match(frontend, /function getActiveTermTotalWeeks\(\)/);
  assert.match(frontend, /function getActiveTermStart\(\)/);
  assert.match(frontend, /\/api\/my\/active-term/);
  assert.match(frontend, /activeTermKey:\s*getActiveTerm\(\)\?\.termKey/);
  assert.doesNotMatch(frontend, /state\.meta\??\.totalWeeks/);
  assert.doesNotMatch(frontend, /totalWeeks\s*\|\|\s*17/);
  assert.doesNotMatch(frontend, /1-17周/);
});

test('Android uses frozen import context for request, submit and replace mode', () => {
  assert.match(activity, /val xnm = context\.xnm/);
  assert.match(activity, /val xqm = context\.xqm/);
  assert.match(activity, /fetchJwxtSchedule\(cookie, xnm, xqm\)/);
  assert.match(activity, /\.put\("replace", context\.replace\)/);
  assert.doesNotMatch(activity, /xnm\s*=\s*"2025"/);
  assert.doesNotMatch(activity, /xqm\s*=\s*"12"/);
});

test('Widget requires activeTermKey and has no 17-week fallback', () => {
  assert.match(widget, /WidgetDataStore\.getActiveTermKey/);
  assert.match(widget, /belongsToActiveTerm\(termKey, activeTermKey\)/);
  assert.doesNotMatch(widget, /totalWeeks[^\n]*17/);
});
