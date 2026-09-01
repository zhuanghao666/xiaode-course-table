import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLegacyDefaultTemplate,
  createSchoolATemplate,
  createSchoolBTemplate,
  detectScheduleTemplateFromTimes,
  mapSourceRange,
  normalizeCourseSlotFields,
  projectTemplateToSlots,
  visiblePeriodsForWeek
} from '../../shared/schedule-template.js';
import { mergeCourseRecords } from '../src/import-pipeline.js';

const legacySlots = Array.from({ length: 12 }, (_, index) => ({
  slot: index + 1,
  label: `第${index + 1}节`,
  start: `${String(8 + Math.floor(index / 2)).padStart(2, '0')}:00`,
  end: `${String(8 + Math.floor(index / 2)).padStart(2, '0')}:45`
}));

function course(name, sourceSlot, extra = {}) {
  const template = extra.template || createSchoolATemplate();
  return {
    id: extra.id || `${name}-${sourceSlot}`,
    accountId: 'account-a',
    termKey: 'account-a:2026:3',
    day: 1,
    name,
    location: extra.location || 'Room 1',
    teacher: extra.teacher || 'Teacher',
    weeks: extra.weeks || [1],
    oddEven: 'all',
    ...normalizeCourseSlotFields({ sourceStartSlot: sourceSlot, sourceEndSlot: sourceSlot }, template)
  };
}

test('legacy-default preserves every old numeric row and time exactly', () => {
  const template = createLegacyDefaultTemplate(legacySlots);
  assert.equal(template.templateId, 'legacy-default');
  assert.equal(template.periods.length, 12);
  template.periods.forEach((period, index) => {
    assert.equal(period.sourceSlot, index + 1);
    assert.equal(period.logicalOrder, index + 1);
    assert.equal(period.displayNumber, index + 1);
    assert.equal(period.slotKey, `P${index + 1}`);
    assert.equal(period.startTime, legacySlots[index].start);
    assert.equal(period.endTime, legacySlots[index].end);
  });
});

test('school A and B map different source slots to the same displayed P5', () => {
  const schoolA = createSchoolATemplate();
  const schoolB = createSchoolBTemplate();
  const aMidday = mapSourceRange(schoolA, 5);
  const aAfternoon = mapSourceRange(schoolA, 6);
  const bAfternoon = mapSourceRange(schoolB, 5);
  assert.equal(aMidday.startSlotKey, 'MIDDAY_1');
  assert.equal(aMidday.startSlot, 5);
  assert.equal(aAfternoon.startSlotKey, 'P5');
  assert.equal(aAfternoon.startSlot, 6);
  assert.equal(bAfternoon.startSlotKey, 'P5');
  assert.equal(bAfternoon.startSlot, 5);
  const aP5 = projectTemplateToSlots(schoolA).find((period) => period.slotKey === 'P5');
  const bP5 = projectTemplateToSlots(schoolB).find((period) => period.slotKey === 'P5');
  assert.equal(aP5.label, '第5节');
  assert.equal(bP5.label, '第5节');
  assert.equal(aP5.start, '14:00');
  assert.equal(bP5.start, '14:00');
});

test('AUTO midday row hides when empty and expands when the displayed week has a course', () => {
  const template = createSchoolATemplate();
  const empty = visiblePeriodsForWeek(template, [course('Afternoon', 6, { template })], 1);
  assert.equal(empty.some((period) => period.slotKey === 'MIDDAY_1'), false);
  const occupied = visiblePeriodsForWeek(template, [
    course('Midday', 5, { template, weeks: [2] }),
    course('Afternoon', 6, { template })
  ], 2);
  assert.equal(occupied.some((period) => period.slotKey === 'MIDDAY_1'), true);
  const anotherWeek = visiblePeriodsForWeek(template, [course('Midday', 5, { template, weeks: [2] })], 1);
  assert.equal(anotherWeek.some((period) => period.slotKey === 'MIDDAY_1'), false);
});

test('template-aware merge never joins MIDDAY_EXTENSION to REGULAR but joins regular P5-P7', () => {
  const template = createSchoolATemplate();
  const barrier = mergeCourseRecords([
    course('Same Course', 5, { template }),
    course('Same Course', 6, { template })
  ], { scheduleTemplate: template });
  assert.equal(barrier.courses.length, 2);

  const regular = mergeCourseRecords([
    course('Regular Course', 6, { template }),
    course('Regular Course', 7, { template }),
    course('Regular Course', 8, { template })
  ], { scheduleTemplate: template });
  assert.equal(regular.courses.length, 1);
  assert.equal(regular.courses[0].startSlotKey, 'P5');
  assert.equal(regular.courses[0].endSlotKey, 'P7');
  assert.equal(regular.courses[0].startSlot, 6);
  assert.equal(regular.courses[0].endSlot, 8);
});

test('different location or weeks remain separate and overlapping courses are preserved as conflicts', () => {
  const template = createSchoolBTemplate();
  const differentLocation = mergeCourseRecords([
    course('Course', 5, { template, location: 'A' }),
    course('Course', 6, { template, location: 'B' })
  ], { scheduleTemplate: template });
  assert.equal(differentLocation.courses.length, 2);

  const differentWeeks = mergeCourseRecords([
    course('Course', 5, { template, weeks: [1] }),
    course('Course', 6, { template, weeks: [2] })
  ], { scheduleTemplate: template });
  assert.equal(differentWeeks.courses.length, 2);

  const conflict = mergeCourseRecords([
    course('Course A', 5, { template, location: 'A' }),
    course('Course B', 5, { template, location: 'B' })
  ], { scheduleTemplate: template });
  assert.equal(conflict.courses.length, 2);
  assert.equal(conflict.warnings.some((warning) => warning.reasonCode === 'CONFLICTING_SCHEDULE'), true);
});

test('reliable source times detect A or B while ambiguous data never guesses', () => {
  const templates = [createSchoolATemplate(), createSchoolBTemplate()];
  const schoolA = detectScheduleTemplateFromTimes([
    { sourceSlot: 5, startTime: '11:45', endTime: '12:30' },
    { sourceSlot: 6, startTime: '14:00', endTime: '14:45' }
  ], templates);
  assert.equal(schoolA.templateId, 'school-a-v1');
  assert.equal(schoolA.confidence, 1);

  const schoolB = detectScheduleTemplateFromTimes([
    { sourceSlot: 5, startTime: '14:00', endTime: '14:45' },
    { sourceSlot: 6, startTime: '14:50', endTime: '15:35' }
  ], templates);
  assert.equal(schoolB.templateId, 'school-b-v1');
  assert.equal(detectScheduleTemplateFromTimes([{ sourceSlot: 5, startTime: '14:00' }], templates).templateId, null);
  assert.equal(detectScheduleTemplateFromTimes([{ sourceSlot: 5 }, { sourceSlot: 6 }], templates).templateId, null);
});
