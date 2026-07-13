import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeJwxtImport,
  IMPORT_REASON_CODES,
  mergeCourseRecords,
  parseSectionsDetailed,
  parseWeeksDetailed
} from '../src/import-pipeline.js';

const fixtureRoot = path.resolve('test/fixtures/jwxt');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtureRoot, `${name}.json`), 'utf8'));
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);

test('week parser handles ranges, discontinuities, punctuation and parity', () => {
  const cases = [
    ['1-16周', range(1, 16)],
    ['1-3周,5-16周', [...range(1, 3), ...range(5, 16)]],
    ['第8周', [8]],
    ['9-10周', [9, 10]],
    ['1~16周', range(1, 16)],
    ['1,3,5,7周', [1, 3, 5, 7]],
    ['2、4、6、8周', [2, 4, 6, 8]],
    ['1-4,7,9-12周', [1, 2, 3, 4, 7, 9, 10, 11, 12]],
    ['第1-3周', [1, 2, 3]],
    ['1至16周', range(1, 16)],
    ['1到16周', range(1, 16)],
    ['1—16周', range(1, 16)],
    ['1-3周,8周,10-12周', [1, 2, 3, 8, 10, 11, 12]]
  ];
  for (const [text, expected] of cases) {
    const result = parseWeeksDetailed(null, text);
    assert.equal(result.ok, true, text);
    assert.deepEqual(result.baseWeeks, expected, text);
    assert.deepEqual(result.parsedWeeks, expected, text);
  }

  const odd = parseWeeksDetailed(null, '1-16周(单周)');
  assert.equal(odd.oddEven, 'odd');
  assert.deepEqual(odd.baseWeeks, range(1, 16));
  assert.deepEqual(odd.parsedWeeks, [1, 3, 5, 7, 9, 11, 13, 15]);
  const even = parseWeeksDetailed(null, '1-16周(双周)');
  assert.equal(even.oddEven, 'even');
  assert.deepEqual(even.parsedWeeks, [2, 4, 6, 8, 10, 12, 14, 16]);
});

test('week parser reports missing, invalid, duplicate, reversed and unreasonable values', () => {
  assert.equal(parseWeeksDetailed(null, '').reasonCode, IMPORT_REASON_CODES.MISSING_WEEKS);
  assert.equal(parseWeeksDetailed(null, '非法文本').reasonCode, IMPORT_REASON_CODES.INVALID_WEEKS);
  assert.equal(parseWeeksDetailed(null, '8-3周').reasonCode, IMPORT_REASON_CODES.INVALID_WEEKS);
  assert.equal(parseWeeksDetailed(null, '31-40周').reasonCode, IMPORT_REASON_CODES.INVALID_WEEKS);
  const duplicate = parseWeeksDetailed(null, '1,1,2,2,3周');
  assert.deepEqual(duplicate.baseWeeks, [1, 2, 3]);
  assert.ok(duplicate.warnings.some((warning) => warning.reasonCode === IMPORT_REASON_CODES.INVALID_WEEKS));
});

test('section parser supports one or continuous slots and rejects ambiguous structures', () => {
  assert.deepEqual(parseSectionsDetailed({ jcor: '第1节' }).slots, [1]);
  assert.deepEqual(parseSectionsDetailed({ jcor: '1-2节' }).slots, [1, 2]);
  assert.deepEqual(parseSectionsDetailed({ jcor: '第1,2节' }).slots, [1, 2]);
  assert.deepEqual(parseSectionsDetailed({ ksjc: 10, jsjc: 12 }).slots, [10, 11, 12]);
  assert.equal(parseSectionsDetailed({ jcor: '1-2,3-4' }).reasonCode, IMPORT_REASON_CODES.INVALID_SECTION);
  assert.equal(parseSectionsDetailed({ jcor: '2,4节' }).reasonCode, IMPORT_REASON_CODES.INVALID_SECTION);
  assert.equal(parseSectionsDetailed({ jcor: '13节' }).reasonCode, IMPORT_REASON_CODES.INVALID_SECTION);
  assert.equal(parseSectionsDetailed({ ksjc: 4, jsjc: 2 }).reasonCode, IMPORT_REASON_CODES.INVALID_SECTION);
  assert.equal(parseSectionsDetailed({}).reasonCode, IMPORT_REASON_CODES.MISSING_SECTION);
});

test('fixtures expose candidate counts, filtering, merging, conflicts and field variants', () => {
  const context = { accountId: 'account-a', userId: 'user-a', xnm: '2026', xqm: '12', traceId: 'trace-test' };
  const standard = analyzeJwxtImport(fixture('standard-kblist'), context);
  assert.deepEqual(standard.summary, {
    received: 3, recognized: 3, accepted: 3, filtered: 0, merged: 0, written: 3,
    beforeCount: 0, afterCount: 0, rawCount: 3, acceptedCount: 3, importedCount: 3,
    filteredWrongTermCount: 0, filteredUnknownSourceCount: 0
  });
  assert.deepEqual(standard.responseTerms, [{ xnm: '2026', xqm: '12', count: 3 }]);
  assert.ok(standard.courses.every((course) => course.accountId === 'account-a' && course.source === 'jwxt'));
  assert.equal(standard.courses.find((course) => course.name === '大学物理').oddEven, 'odd');

  const nested = analyzeJwxtImport(fixture('nested-multi-source'), context);
  assert.equal(nested.summary.received, 3);
  assert.equal(nested.summary.written, 2);
  assert.equal(nested.filteredUnknownSourceCount, 1);
  assert.deepEqual(nested.unknownSourceCounts, { 'data.rows': 1 });
  assert.ok(nested.candidateSources.some((source) => source.includes('adjustmentList')));
  assert.ok(nested.courses.some((course) => course.isAdjusted && course.name.includes('调')));
  assert.equal(nested.courses.some((course) => course.name === '嵌套课程'), false);

  const duplicates = analyzeJwxtImport(fixture('duplicates-conflicts'), context);
  assert.equal(duplicates.summary.received, 6);
  assert.equal(duplicates.summary.merged, 1);
  assert.equal(duplicates.summary.written, 5);
  assert.ok(duplicates.mergeEvents.some((event) => event.reasonCode === IMPORT_REASON_CODES.DUPLICATE_EXACT));
  assert.equal(duplicates.mergeEvents.some((event) => event.reasonCode === IMPORT_REASON_CODES.MERGED_SAME_COURSE), false);
  assert.ok(duplicates.warnings.some((warning) => warning.reasonCode === IMPORT_REASON_CODES.CONFLICTING_SCHEDULE));

  const invalid = analyzeJwxtImport(fixture('invalid-candidates'), context);
  assert.equal(invalid.summary.received, 8);
  assert.equal(invalid.summary.filtered, 7);
  assert.equal(invalid.summary.written, 1);
  const reasons = new Set(invalid.candidates.map((candidate) => candidate.reasonCode).filter(Boolean));
  for (const reason of [
    IMPORT_REASON_CODES.MISSING_NAME,
    IMPORT_REASON_CODES.MISSING_DAY,
    IMPORT_REASON_CODES.INVALID_DAY,
    IMPORT_REASON_CODES.MISSING_SECTION,
    IMPORT_REASON_CODES.MISSING_WEEKS,
    IMPORT_REASON_CODES.INVALID_WEEKS,
    IMPORT_REASON_CODES.INVALID_SECTION
  ]) assert.ok(reasons.has(reason), reason);
  const invalidSection = invalid.candidates.find((candidate) => candidate.reasonCode === IMPORT_REASON_CODES.INVALID_SECTION);
  assert.deepEqual(invalidSection.safeSectionFields, { jcor: '1-2,3-4' });

  assert.equal(analyzeJwxtImport(fixture('empty-response'), context).summary.received, 0);
  assert.equal(analyzeJwxtImport(fixture('html-wrapped'), context).summary.written, 1);
});

test('course consolidation is exact, scope-safe and only joins contiguous matching ranges', () => {
  const base = {
    userId: 'user-a',
    accountId: 'account-a',
    source: 'jwxt',
    termKey: 'account-a:2025:3',
    day: 1,
    name: '化工 原理',
    weeks: [1, 2, 3],
    location: '教学楼 A101',
    teacher: '张 老师'
  };
  const courses = [
    { ...base, id: 'base-1', slot: 1, startSlot: 1, endSlot: 1 },
    // 完全重复项即使空白和周次数组顺序不同，也只能保留一条。
    { ...base, id: 'duplicate', name: ' 化工   原理 ', location: ' 教学楼   A101 ', teacher: ' 张   老师 ', weeks: [3, 2, 1], slot: 1, startSlot: 1, endSlot: 1 },
    { ...base, id: 'adjacent', slot: 2, startSlot: 2, endSlot: 2 },
    // 中间缺第 3 节，不能把第 4 节跨空档并入 1-2 节。
    { ...base, id: 'gap', slot: 4, startSlot: 4, endSlot: 4 },
    { ...base, id: 'different-weeks', weeks: [1, 2], slot: 3, startSlot: 3, endSlot: 3 },
    { ...base, id: 'different-location', location: '教学楼 B202', slot: 3, startSlot: 3, endSlot: 3 },
    { ...base, id: 'different-teacher', teacher: '李老师', slot: 3, startSlot: 3, endSlot: 3 },
    { ...base, id: 'different-account', accountId: 'account-b', termKey: 'account-b:2025:3', slot: 3, startSlot: 3, endSlot: 3 },
    { ...base, id: 'different-term', termKey: 'account-a:2025:12', slot: 3, startSlot: 3, endSlot: 3 },
    { ...base, id: 'empty-teacher-5', name: '实验课', teacher: '', location: '实验室', slot: 5, startSlot: 5, endSlot: 5 },
    { ...base, id: 'empty-teacher-6', name: '实验课', teacher: '   ', location: '实验室', slot: 6, startSlot: 6, endSlot: 6 },
    // 旧版本曾为范围内每个 slot 生成同一 start/end；规范化应幂等折叠。
    { ...base, id: 'legacy-range-7', slot: 7, startSlot: 7, endSlot: 8 },
    { ...base, id: 'legacy-range-8', slot: 8, startSlot: 7, endSlot: 8 }
  ];

  const result = mergeCourseRecords(courses);
  assert.equal(result.courses.length, 9);
  assert.equal(result.events.filter((event) => event.reasonCode === IMPORT_REASON_CODES.DUPLICATE_EXACT).length, 2);
  assert.equal(result.events.filter((event) => event.reasonCode === IMPORT_REASON_CODES.MERGED_SAME_COURSE).length, 2);

  const mergedBase = result.courses.find((course) => course.id === 'base-1');
  assert.deepEqual({ startSlot: mergedBase.startSlot, endSlot: mergedBase.endSlot, slot: mergedBase.slot }, { startSlot: 1, endSlot: 2, slot: 1 });
  assert.ok(result.courses.some((course) => course.id === 'gap' && course.startSlot === 4 && course.endSlot === 4));
  assert.ok(result.courses.some((course) => course.id === 'different-weeks'));
  assert.ok(result.courses.some((course) => course.id === 'different-location'));
  assert.ok(result.courses.some((course) => course.id === 'different-teacher'));
  assert.ok(result.courses.some((course) => course.id === 'different-account'));
  assert.ok(result.courses.some((course) => course.id === 'different-term'));

  const emptyTeacher = result.courses.find((course) => course.id === 'empty-teacher-5');
  assert.deepEqual({ startSlot: emptyTeacher.startSlot, endSlot: emptyTeacher.endSlot }, { startSlot: 5, endSlot: 6 });
  const legacyRange = result.courses.filter((course) => course.startSlot === 7 && course.endSlot === 8);
  assert.equal(legacyRange.length, 1);

  const secondPass = mergeCourseRecords(result.courses);
  assert.deepEqual(secondPass.courses, result.courses);
  assert.equal(secondPass.events.length, 0);
});

test('course consolidation crosses source by default but can preserve source boundaries', () => {
  const base = {
    id: 'manual-1',
    userId: 'user-a',
    accountId: 'account-a',
    termKey: 'account-a:2025:3',
    source: 'manual',
    day: 2,
    slot: 1,
    startSlot: 1,
    endSlot: 1,
    name: 'Source Boundary Course',
    weeks: [1, 2],
    location: 'Room 101',
    teacher: 'Teacher A'
  };
  const crossSourceExact = { ...base, id: 'jwxt-exact', source: 'jwxt' };
  const crossSourceAdjacent = {
    ...base,
    id: 'jwxt-adjacent',
    source: 'jwxt',
    slot: 2,
    startSlot: 2,
    endSlot: 2
  };

  const unified = mergeCourseRecords([base, crossSourceExact, crossSourceAdjacent]);
  assert.equal(unified.courses.length, 1);
  assert.deepEqual(
    { id: unified.courses[0].id, startSlot: unified.courses[0].startSlot, endSlot: unified.courses[0].endSlot },
    { id: 'manual-1', startSlot: 1, endSlot: 2 }
  );
  assert.equal(unified.events.filter((event) => event.reasonCode === IMPORT_REASON_CODES.DUPLICATE_EXACT).length, 1);
  assert.equal(unified.events.filter((event) => event.reasonCode === IMPORT_REASON_CODES.MERGED_SAME_COURSE).length, 1);

  const sourceSeparated = mergeCourseRecords(
    [base, crossSourceExact, crossSourceAdjacent],
    { separateSources: true }
  );
  assert.equal(sourceSeparated.courses.length, 2);
  assert.deepEqual(
    sourceSeparated.courses.map((course) => ({ id: course.id, source: course.source, startSlot: course.startSlot, endSlot: course.endSlot })),
    [
      { id: 'manual-1', source: 'manual', startSlot: 1, endSlot: 1 },
      { id: 'jwxt-adjacent', source: 'jwxt', startSlot: 2, endSlot: 2 }
    ]
  );
  // 完全重复项不因 source 不同而保留；source 边界只阻止连续范围合并。
  assert.equal(sourceSeparated.events.filter((event) => event.reasonCode === IMPORT_REASON_CODES.DUPLICATE_EXACT).length, 1);
  assert.equal(sourceSeparated.events.some((event) => event.reasonCode === IMPORT_REASON_CODES.MERGED_SAME_COURSE), false);

  const manualWinsExactDedup = mergeCourseRecords(
    [crossSourceExact, base],
    { separateSources: true }
  );
  assert.equal(manualWinsExactDedup.courses.length, 1);
  assert.equal(manualWinsExactDedup.courses[0].id, 'manual-1');

  const manualRangeWinsAfterJwxtSlotsMerge = mergeCourseRecords(
    [
      { ...base, id: 'jwxt-slot-1', source: 'jwxt' },
      { ...base, id: 'manual-range', startSlot: 1, endSlot: 2 },
      { ...crossSourceAdjacent, id: 'jwxt-slot-2' }
    ],
    { separateSources: true }
  );
  assert.deepEqual(
    manualRangeWinsAfterJwxtSlotsMerge.courses.map((course) => ({ id: course.id, source: course.source, startSlot: course.startSlot, endSlot: course.endSlot })),
    [{ id: 'manual-range', source: 'manual', startSlot: 1, endSlot: 2 }]
  );

  const reversedLegacyRange = { ...base, id: 'legacy-reversed', slot: 5, startSlot: 5, endSlot: 3 };
  assert.deepEqual(mergeCourseRecords([reversedLegacyRange]).courses, [reversedLegacyRange]);
});

test('course consolidation preserves manual text and never merges different unknown week patterns', () => {
  const base = {
    userId: 'user-a',
    accountId: 'account-a',
    termKey: 'account-a:2025:3',
    source: 'manual',
    day: 3,
    weeks: [1, 2],
    oddEven: 'all',
    location: 'A<B>楼',
    teacher: '张<老师>'
  };
  const richText = mergeCourseRecords([
    { ...base, id: 'rich-1', slot: 1, name: ' C++   <高级> ' },
    { ...base, id: 'rich-2', slot: 2, name: 'C++ <高级>' },
    { ...base, id: 'plain-3', slot: 3, name: 'C++' }
  ]).courses;
  assert.deepEqual(
    richText.map((course) => ({ id: course.id, name: course.name, teacher: course.teacher, location: course.location, startSlot: course.startSlot, endSlot: course.endSlot })),
    [
      { id: 'rich-1', name: 'C++ <高级>', teacher: '张<老师>', location: 'A<B>楼', startSlot: 1, endSlot: 2 },
      { id: 'plain-3', name: 'C++', teacher: '张<老师>', location: 'A<B>楼', startSlot: 3, endSlot: 3 }
    ]
  );

  const unknownWeeks = mergeCourseRecords([
    { ...base, id: 'unknown-a', slot: 5, name: '未知周次课', weeks: [], weekText: '未知甲' },
    { ...base, id: 'unknown-b', slot: 6, name: '未知周次课', weeks: [], weekPattern: '未知乙' }
  ]).courses;
  assert.equal(unknownWeeks.length, 2);
  assert.deepEqual(unknownWeeks.map((course) => course.id), ['unknown-a', 'unknown-b']);

  const aliases = mergeCourseRecords([
    { ...base, id: 'alias-7', slot: 7, name: '   ', courseName: '别名课程', location: '', room: 'A101' },
    { ...base, id: 'alias-8', slot: 8, name: '', courseName: '别名课程', location: ' ', room: 'A101' }
  ]).courses;
  assert.deepEqual(
    aliases.map((course) => ({ id: course.id, name: course.name, location: course.location, startSlot: course.startSlot, endSlot: course.endSlot })),
    [{ id: 'alias-7', name: '别名课程', location: 'A101', startSlot: 7, endSlot: 8 }]
  );

  const differentRooms = mergeCourseRecords([
    { ...base, id: 'room-a', slot: 9, name: '地点隔离', location: '', room: 'A101' },
    { ...base, id: 'room-b', slot: 10, name: '地点隔离', location: '', room: 'B202' }
  ]).courses;
  assert.equal(differentRooms.length, 2);
});

test('strict term parser ignores unknown arrays and filters records from another term', () => {
  const context = { accountId: 'account-a', userId: 'user-a', xnm: '2025', xqm: '3', selectedTermLabel: '2025-2026 第一学期' };
  const result = analyzeJwxtImport({
    totalWeeks: 20,
    kbList: [
      { kcmc: '第一学期课程', xnm: '2025', xqm: '3', xqj: 1, jcor: '1节', zcd: '1-20周' },
      { kcmc: '错误第二学期', xnm: '2025', xqm: '12', xqj: 1, jcor: '1节', zcd: '1-17周', totalWeeks: 50 }
    ],
    historyRows: [
      { kcmc: '未知来源历史课', xnm: '2024', xqm: '12', xqj: 2, jcor: '2节', zcd: '1-18周' }
    ]
  }, context);
  assert.deepEqual(result.courses.map((course) => course.name), ['第一学期课程']);
  assert.equal(result.filteredWrongTermCount, 1);
  assert.equal(result.filteredUnknownSourceCount, 1);
  assert.equal(result.rawCount, 3);
  assert.equal(result.acceptedCount, 1);
  assert.equal(result.importedCount, 1);
  assert.equal(result.explicitTotalWeeks, 20);
  assert.equal(result.courses[0].termKey, 'account-a:2025:3');
  assert.equal(result.courses[0].selectedTermLabel, context.selectedTermLabel);
});
