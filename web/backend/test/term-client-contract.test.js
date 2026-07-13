import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const repoRoot = path.resolve('..', '..');
const frontend = fs.readFileSync(path.join(repoRoot, 'web', 'frontend', 'public', 'index.html'), 'utf8');
const frontendFixed = fs.readFileSync(path.join(repoRoot, 'web', 'frontend', 'public', 'index.fixed.html'), 'utf8');
const activity = fs.readFileSync(path.join(repoRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'xiaode', 'importhelper', 'MainActivity.kt'), 'utf8');
const widget = fs.readFileSync(path.join(repoRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'xiaode', 'importhelper', 'WidgetUpdater.kt'), 'utf8');
const termScope = fs.readFileSync(path.join(repoRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'xiaode', 'importhelper', 'TermScope.kt'), 'utf8');

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

test('web course rendering uses strict identities, explicit ranges and contiguous-only spanning', () => {
  assert.match(frontend, /function courseStartSlot\(/);
  assert.match(frontend, /function courseEndSlot\(/);
  assert.match(frontend, /function courseCoversSlot\(/);
  assert.match(frontend, /function normalizeCourseText\(/);
  assert.match(frontend, /function courseWeeksFingerprint\(/);
  assert.match(frontend, /function courseMergeKey\(/);
  assert.match(frontend, /function courseExactKey\(/);
  assert.match(frontend, /function groupSameCourses\(/);
  assert.match(frontend, /function canSpanNext\(group,\s*day,\s*currentSlot,\s*nextSlot,\s*week\)/);
  assert.match(frontend, /nextSlot\s*!==\s*currentSlot\s*\+\s*1/);
  assert.match(frontend, /startSlot:\s*courseStartSlot\(c\)/);
  assert.match(frontend, /endSlot:\s*courseEndSlot\(c\)/);
});

test('web range model renders each logical course once inside overlap components', () => {
  assert.equal(frontendFixed, frontend);
  assert.match(frontend, /function buildLogicalCourseItems\(/);
  assert.match(frontend, /function buildOverlapComponents\(/);
  assert.match(frontend, /function overlapComponentsForDay\(/);
  assert.match(frontend, /logical-range-component/);
  assert.match(frontend, /range-conflict/);
  assert.match(frontend, /return logicalItemsForDay\(day,week,slots\)/);
  const renderTableSource = frontend.match(/function renderTable\(\)\{([\s\S]*?)\n\s*function mergedDayItems/);
  assert.ok(renderTableSource, 'desktop renderer must remain inspectable');
  assert.match(renderTableSource[1], /overlapComponentsForDay\(/);
  assert.match(renderTableSource[1], /component\.items\.map\(/);
  assert.doesNotMatch(renderTableSource[1], /groupsForCell\(/, 'desktop must not render a range once per covered cell');

  const helperBlock = frontend.match(/\/\/ LOGICAL_COURSE_RANGE_HELPERS_START([\s\S]*?)\/\/ LOGICAL_COURSE_RANGE_HELPERS_END/);
  assert.ok(helperBlock, 'logical range helper block must remain extractable for regression tests');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${helperBlock[1]};globalThis.rangeHelpers={buildLogicalCourseItems,buildOverlapComponents};`, sandbox);
  const { buildLogicalCourseItems, buildOverlapComponents } = sandbox.rangeHelpers;
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const identityOf = course => [
    course.accountId,
    course.termKey,
    course.day,
    normalize(course.name),
    [...course.weeks].sort((a, b) => a - b).join(','),
    normalize(course.location),
    normalize(course.teacher)
  ].join('|');
  const startOf = course => course.startSlot;
  const endOf = course => course.endSlot;
  const exactOf = course => `${identityOf(course)}|${startOf(course)}-${endOf(course)}`;
  const base = { accountId: 'A', termKey: 'A:2025:3', day: 1, name: '化工 原理', weeks: [1, 2], location: '教一楼', teacher: '张老师' };
  const records = [
    { ...base, id: 'a-1', startSlot: 1, endSlot: 1 },
    { ...base, id: 'a-duplicate', name: '  化工   原理 ', startSlot: 1, endSlot: 1 },
    { ...base, id: 'a-2', startSlot: 2, endSlot: 2 },
    { ...base, id: 'different-weeks', weeks: [1, 3], startSlot: 2, endSlot: 2 },
    { ...base, id: 'different-room', location: '教二楼', startSlot: 2, endSlot: 2 },
    { ...base, id: 'different-teacher', teacher: '李老师', startSlot: 2, endSlot: 2 },
    { ...base, id: 'a-4', startSlot: 4, endSlot: 4 },
    { ...base, id: 'a-6', startSlot: 6, endSlot: 6 }
  ];
  const items = buildLogicalCourseItems(records, { identityOf, exactOf, startOf, endOf });
  assert.equal(items.length, 6, 'exact duplicate is removed and only truly contiguous identical ranges merge');
  const baseItems = Array.from(items).filter(item => item.key === identityOf(base));
  assert.deepEqual(baseItems.map(item => [item.startSlot, item.endSlot]), [[1, 2], [4, 4], [6, 6]]);
  assert.deepEqual([...baseItems[0].ids], ['a-1', 'a-2']);
  const components = buildOverlapComponents(items);
  assert.equal(components.length, 3, 'independent slot 4 and 6 ranges stay separate when slot 5 is hidden');
  assert.equal(components[0].items.length, 4, 'A(1-2) and three distinct slot-2 conflicts share one component without duplicating A');
});

test('shared course-card formatting exposes location and independently controls teacher and section text', () => {
  assert.match(frontend, /function formatCourseCardFields\(c,\s*opts/);
  assert.match(frontend, /course-location/);
  assert.match(frontend, /course-teacher/);
  assert.match(frontend, /course-section/);
  assert.match(frontend, /showSectionRange:\s*true/);
  assert.doesNotMatch(frontend, /data-table-size="screenshot"[\s\S]{0,160}\.meta2\s*\{[^}]*display\s*:\s*none/i);
});

test('fresh portrait mobile layout is compact while explicit layout choices remain persisted', () => {
  assert.match(frontend, /function isMobilePortrait\(/);
  assert.match(frontend, /function legacyLayoutLooksCustomized\(/);
  assert.match(frontend, /function applyMobileCompactDefaults\(/);
  assert.match(frontend, /function markLayoutCustomized\(/);
  assert.match(frontend, /layoutCustomized/);
  assert.match(frontend, /tableFontSize/);
  assert.match(frontend, /function setTableFontSize\(/);
  assert.match(frontend, /function setInfoMode\(/);
  assert.match(frontend, /tableSize\s*=\s*['"]screenshot['"]/);
  assert.match(frontend, /showLocation:\s*true/);
  assert.match(frontend, /showTeacher:\s*false/);
  assert.match(frontend, /showSectionRange:\s*false/);
});

test('Android Widget consumes logical section ranges with legacy slot fallback', () => {
  assert.match(widget, /val startSlot:\s*Int/);
  assert.match(widget, /val endSlot:\s*Int/);
  assert.match(widget, /o\.has\("startSlot"\)/);
  assert.match(widget, /o\.has\("endSlot"\)/);
  assert.match(widget, /courseMinuteRange\(CourseSlotRange\(course\.startSlot,\s*course\.endSlot\)/);
  assert.match(widget, /courseSectionLabel\(CourseSlotRange\(course\.startSlot,\s*course\.endSlot\)/);
  assert.match(termScope, /data class CourseSlotRange\(val startSlot:\s*Int,\s*val endSlot:\s*Int\)/);
  assert.match(termScope, /fun normalizeCourseSlotRange\(/);
  assert.match(termScope, /fun courseMinuteRange\(/);
  assert.match(termScope, /fun courseSectionLabel\(/);
});
