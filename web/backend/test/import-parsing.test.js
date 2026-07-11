import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeJwxtImport,
  IMPORT_REASON_CODES,
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
  assert.deepEqual(standard.summary, { received: 3, recognized: 3, accepted: 5, filtered: 0, merged: 0, written: 5, beforeCount: 0, afterCount: 0 });
  assert.ok(standard.courses.every((course) => course.accountId === 'account-a' && course.source === 'jwxt'));
  assert.equal(standard.courses.find((course) => course.name === '大学物理').oddEven, 'odd');

  const nested = analyzeJwxtImport(fixture('nested-multi-source'), context);
  assert.equal(nested.summary.received, 3);
  assert.equal(nested.summary.written, 5);
  assert.ok(nested.candidateSources.some((source) => source.includes('adjustmentList')));
  assert.ok(nested.courses.some((course) => course.isAdjusted && course.name.includes('调')));

  const duplicates = analyzeJwxtImport(fixture('duplicates-conflicts'), context);
  assert.equal(duplicates.summary.received, 6);
  assert.equal(duplicates.summary.merged, 2);
  assert.equal(duplicates.summary.written, 4);
  assert.ok(duplicates.mergeEvents.some((event) => event.reasonCode === IMPORT_REASON_CODES.DUPLICATE_EXACT));
  assert.ok(duplicates.mergeEvents.some((event) => event.reasonCode === IMPORT_REASON_CODES.MERGED_SAME_COURSE));
  assert.ok(duplicates.warnings.some((warning) => warning.reasonCode === IMPORT_REASON_CODES.CONFLICTING_SCHEDULE));

  const invalid = analyzeJwxtImport(fixture('invalid-candidates'), context);
  assert.equal(invalid.summary.received, 8);
  assert.equal(invalid.summary.filtered, 7);
  assert.equal(invalid.summary.written, 2);
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

  assert.equal(analyzeJwxtImport(fixture('empty-response'), context).summary.received, 0);
  assert.equal(analyzeJwxtImport(fixture('html-wrapped'), context).summary.written, 1);
});
