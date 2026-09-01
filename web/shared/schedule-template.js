export const PERIOD_KINDS = Object.freeze({
  REGULAR: 'REGULAR',
  MIDDAY_EXTENSION: 'MIDDAY_EXTENSION',
  BREAK_EXTENSION: 'BREAK_EXTENSION',
  CUSTOM: 'CUSTOM'
});

export const VISIBILITY_POLICIES = Object.freeze({
  ALWAYS: 'ALWAYS',
  AUTO: 'AUTO'
});

const VALID_KINDS = new Set(Object.values(PERIOD_KINDS));
const VALID_VISIBILITY_POLICIES = new Set(Object.values(VISIBILITY_POLICIES));

function integer(value, fallback = null) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function cleanText(value, maxLength = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function timeFromRange(range, index) {
  return cleanText(range, 40).split('-')[index] || '';
}

function defaultPeriodLabel(kind, displayNumber, slotKey) {
  if (kind === PERIOD_KINDS.MIDDAY_EXTENSION) return '午间加时';
  if (displayNumber !== null) return `第${displayNumber}节`;
  return slotKey;
}

export function normalizePeriodDefinition(input = {}, index = 0) {
  const logicalOrder = Math.max(1, integer(input.logicalOrder, index + 1));
  const sourceSlot = integer(input.sourceSlot, null);
  const displayNumberValue = integer(input.displayNumber, null);
  const displayNumber = displayNumberValue !== null && displayNumberValue > 0 ? displayNumberValue : null;
  const kind = VALID_KINDS.has(input.kind) ? input.kind : PERIOD_KINDS.REGULAR;
  const visibilityPolicy = VALID_VISIBILITY_POLICIES.has(input.visibilityPolicy)
    ? input.visibilityPolicy
    : VISIBILITY_POLICIES.ALWAYS;
  const fallbackKey = displayNumber !== null ? `P${displayNumber}` : `SLOT_${logicalOrder}`;
  const slotKey = cleanText(input.slotKey || fallbackKey, 80).replace(/[^A-Za-z0-9_.:-]/g, '_') || fallbackKey;
  const startTime = cleanText(input.startTime ?? input.start ?? timeFromRange(input.range, 0), 20);
  const endTime = cleanText(input.endTime ?? input.end ?? timeFromRange(input.range, 1), 20);
  return {
    slotKey,
    sourceSlot: sourceSlot !== null && sourceSlot > 0 ? sourceSlot : null,
    logicalOrder,
    displayNumber,
    displayLabel: cleanText(input.displayLabel ?? input.label, 80) || defaultPeriodLabel(kind, displayNumber, slotKey),
    startTime,
    endTime,
    kind,
    visibilityPolicy
  };
}

export function normalizeScheduleTemplate(input = {}, fallbackPeriods = []) {
  const sourcePeriods = Array.isArray(input.periods) && input.periods.length ? input.periods : fallbackPeriods;
  const periods = [];
  const seenKeys = new Set();
  const seenSourceSlots = new Set();
  sourcePeriods.forEach((rawPeriod, index) => {
    const period = normalizePeriodDefinition(rawPeriod, index);
    if (seenKeys.has(period.slotKey)) return;
    if (period.sourceSlot !== null && seenSourceSlots.has(period.sourceSlot)) return;
    seenKeys.add(period.slotKey);
    if (period.sourceSlot !== null) seenSourceSlots.add(period.sourceSlot);
    periods.push(period);
  });
  periods.sort((left, right) => left.logicalOrder - right.logicalOrder || left.slotKey.localeCompare(right.slotKey));
  periods.forEach((period, index) => {
    // logicalOrder is the stable timetable row order and must be unique.
    period.logicalOrder = index + 1;
  });
  return {
    templateId: cleanText(input.templateId || 'legacy-default', 120),
    schoolId: cleanText(input.schoolId, 120) || null,
    campusId: cleanText(input.campusId, 120) || null,
    accountId: cleanText(input.accountId, 120) || null,
    termKey: cleanText(input.termKey, 180) || null,
    name: cleanText(input.name || '标准课节时间表', 160),
    version: Math.max(1, integer(input.version, 1)),
    allowCrossKindMerge: Boolean(input.allowCrossKindMerge),
    periods,
    createdAt: cleanText(input.createdAt, 40),
    updatedAt: cleanText(input.updatedAt, 40),
    revision: Math.max(1, integer(input.revision, 1))
  };
}

function slotTime(slot = {}) {
  const range = cleanText(slot.range, 40);
  return {
    startTime: cleanText(slot.start ?? timeFromRange(range, 0), 20),
    endTime: cleanText(slot.end ?? timeFromRange(range, 1), 20)
  };
}

export function createLegacyDefaultTemplate(slots = [], overrides = {}) {
  const periods = (Array.isArray(slots) ? slots : []).map((slot, index) => {
    const slotNumber = Math.max(1, integer(slot.slot, index + 1));
    return {
      slotKey: `P${slotNumber}`,
      sourceSlot: slotNumber,
      logicalOrder: index + 1,
      displayNumber: slotNumber,
      displayLabel: cleanText(slot.label, 80) || `第${slotNumber}节`,
      ...slotTime(slot),
      kind: PERIOD_KINDS.REGULAR,
      visibilityPolicy: VISIBILITY_POLICIES.ALWAYS
    };
  });
  return normalizeScheduleTemplate({
    templateId: 'legacy-default',
    name: '旧版默认课节时间表',
    version: 1,
    ...overrides,
    periods
  });
}

const STANDARD_TIMES = [
  ['08:00', '08:45'], ['08:55', '09:40'], ['10:00', '10:45'], ['10:55', '11:40'],
  ['14:00', '14:45'], ['14:50', '15:35'], ['15:55', '16:40'], ['16:45', '17:30'],
  ['18:20', '19:05'], ['19:10', '19:55'], ['20:05', '20:50'], ['21:00', '21:45']
];

function regularPeriod({ sourceSlot, displayNumber, logicalOrder, times = STANDARD_TIMES[displayNumber - 1] || ['', ''] }) {
  return {
    slotKey: `P${displayNumber}`,
    sourceSlot,
    logicalOrder,
    displayNumber,
    displayLabel: `第${displayNumber}节`,
    startTime: times[0],
    endTime: times[1],
    kind: PERIOD_KINDS.REGULAR,
    visibilityPolicy: VISIBILITY_POLICIES.ALWAYS
  };
}

export function createSchoolATemplate(overrides = {}) {
  const periods = [];
  for (let sourceSlot = 1; sourceSlot <= 4; sourceSlot += 1) {
    periods.push(regularPeriod({ sourceSlot, displayNumber: sourceSlot, logicalOrder: sourceSlot }));
  }
  periods.push({
    slotKey: 'MIDDAY_1',
    sourceSlot: 5,
    logicalOrder: 5,
    displayNumber: null,
    displayLabel: '午间加时',
    startTime: '11:45',
    endTime: '12:30',
    kind: PERIOD_KINDS.MIDDAY_EXTENSION,
    visibilityPolicy: VISIBILITY_POLICIES.AUTO
  });
  for (let sourceSlot = 6; sourceSlot <= 12; sourceSlot += 1) {
    const displayNumber = sourceSlot - 1;
    periods.push(regularPeriod({ sourceSlot, displayNumber, logicalOrder: sourceSlot }));
  }
  return normalizeScheduleTemplate({
    templateId: 'school-a-v1',
    schoolId: 'school-a',
    name: '学校 A 课节时间表',
    version: 1,
    ...overrides,
    periods: overrides.periods || periods
  });
}

export function createSchoolBTemplate(overrides = {}) {
  const periods = Array.from({ length: 12 }, (_, index) => regularPeriod({
    sourceSlot: index + 1,
    displayNumber: index + 1,
    logicalOrder: index + 1
  }));
  return normalizeScheduleTemplate({
    templateId: 'school-b-v1',
    schoolId: 'school-b',
    name: '学校 B 课节时间表',
    version: 1,
    ...overrides,
    periods: overrides.periods || periods
  });
}

export function periodForSourceSlot(template, sourceSlot) {
  const value = integer(sourceSlot, null);
  return normalizeScheduleTemplate(template).periods.find((period) => period.sourceSlot === value) || null;
}

export function periodForSlotKey(template, slotKey) {
  const key = cleanText(slotKey, 80);
  return normalizeScheduleTemplate(template).periods.find((period) => period.slotKey === key) || null;
}

export function periodForLogicalOrder(template, logicalOrder) {
  const value = integer(logicalOrder, null);
  return normalizeScheduleTemplate(template).periods.find((period) => period.logicalOrder === value) || null;
}

export function mapSourceRange(templateInput, sourceStartSlot, sourceEndSlot = sourceStartSlot) {
  const template = normalizeScheduleTemplate(templateInput);
  const startSource = integer(sourceStartSlot, null);
  const endSource = integer(sourceEndSlot, startSource);
  if (startSource === null || endSource === null || endSource < startSource) return null;
  const mapped = [];
  for (let sourceSlot = startSource; sourceSlot <= endSource; sourceSlot += 1) {
    const period = template.periods.find((candidate) => candidate.sourceSlot === sourceSlot);
    if (!period) return null;
    mapped.push(period);
  }
  const contiguous = mapped.every((period, index) => index === 0 || period.logicalOrder === mapped[index - 1].logicalOrder + 1);
  if (!contiguous) return null;
  return {
    sourceStartSlot: startSource,
    sourceEndSlot: endSource,
    slot: mapped[0].logicalOrder,
    startSlot: mapped[0].logicalOrder,
    endSlot: mapped[mapped.length - 1].logicalOrder,
    startSlotKey: mapped[0].slotKey,
    endSlotKey: mapped[mapped.length - 1].slotKey,
    scheduleTemplateId: template.templateId
  };
}

export function detectScheduleTemplateFromTimes(records = [], templates = []) {
  const observations = (Array.isArray(records) ? records : []).map((record) => {
    const sourceSlot = integer(record?.sourceSlot ?? record?.sourceStartSlot ?? record?.slot, null);
    const range = cleanText(record?.range, 40);
    const startTime = cleanText(record?.startTime ?? record?.start ?? timeFromRange(range, 0), 20);
    const endTime = cleanText(record?.endTime ?? record?.end ?? timeFromRange(range, 1), 20);
    return { sourceSlot, startTime, endTime };
  }).filter((item) => item.sourceSlot !== null && item.startTime);
  if (observations.length < 2) return { templateId: null, confidence: 0, matched: 0, total: observations.length, reason: 'insufficient-reliable-times' };

  const candidates = (Array.isArray(templates) ? templates : []).map((template) => {
    const normalized = normalizeScheduleTemplate(template);
    let matched = 0;
    for (const observation of observations) {
      const period = normalized.periods.find((item) => item.sourceSlot === observation.sourceSlot);
      if (!period || period.startTime !== observation.startTime) continue;
      if (observation.endTime && period.endTime && period.endTime !== observation.endTime) continue;
      matched += 1;
    }
    return { template: normalized, matched, confidence: matched / observations.length };
  }).sort((left, right) => right.confidence - left.confidence || right.matched - left.matched);
  const best = candidates[0];
  const second = candidates[1];
  const uniqueEnough = best && (!second || best.confidence - second.confidence >= 0.2);
  if (!best || best.matched < 2 || best.confidence < 0.8 || !uniqueEnough) {
    return { templateId: null, confidence: best?.confidence || 0, matched: best?.matched || 0, total: observations.length, reason: 'low-confidence' };
  }
  return {
    templateId: best.template.templateId,
    template: best.template,
    confidence: best.confidence,
    matched: best.matched,
    total: observations.length,
    reason: 'verified-times'
  };
}

function periodForCompatibleNumber(template, value) {
  const number = integer(value, null);
  if (number === null) return null;
  return template.periods.find((period) => period.logicalOrder === number)
    || template.periods.find((period) => period.kind === PERIOD_KINDS.REGULAR && period.displayNumber === number)
    || null;
}

export function normalizeCourseSlotFields(input = {}, templateInput) {
  const template = normalizeScheduleTemplate(templateInput);
  const sourceStart = integer(input.sourceStartSlot, null);
  const sourceEnd = integer(input.sourceEndSlot, sourceStart);
  if (sourceStart !== null) {
    const mapped = mapSourceRange(template, sourceStart, sourceEnd);
    if (mapped) return mapped;
  }
  const startByKey = periodForSlotKey(template, input.startSlotKey);
  const endByKey = periodForSlotKey(template, input.endSlotKey || input.startSlotKey);
  if (startByKey && endByKey && endByKey.logicalOrder >= startByKey.logicalOrder) {
    return {
      sourceStartSlot: sourceStart ?? startByKey.sourceSlot,
      sourceEndSlot: sourceEnd ?? endByKey.sourceSlot,
      slot: startByKey.logicalOrder,
      startSlot: startByKey.logicalOrder,
      endSlot: endByKey.logicalOrder,
      startSlotKey: startByKey.slotKey,
      endSlotKey: endByKey.slotKey,
      scheduleTemplateId: template.templateId
    };
  }
  const rawStart = integer(input.startSlot ?? input.startSection ?? input.slot, null);
  const rawEnd = integer(input.endSlot ?? input.endSection ?? rawStart, rawStart);
  const startPeriod = periodForCompatibleNumber(template, rawStart);
  const endPeriod = periodForCompatibleNumber(template, rawEnd);
  if (!startPeriod || !endPeriod || endPeriod.logicalOrder < startPeriod.logicalOrder) return null;
  return {
    sourceStartSlot: sourceStart ?? startPeriod.sourceSlot,
    sourceEndSlot: sourceEnd ?? endPeriod.sourceSlot,
    slot: startPeriod.logicalOrder,
    startSlot: startPeriod.logicalOrder,
    endSlot: endPeriod.logicalOrder,
    startSlotKey: startPeriod.slotKey,
    endSlotKey: endPeriod.slotKey,
    scheduleTemplateId: template.templateId
  };
}

export function templateRangeForCourse(course = {}, templateInput) {
  const template = normalizeScheduleTemplate(templateInput);
  const start = periodForSlotKey(template, course.startSlotKey)
    || periodForLogicalOrder(template, course.startSlot ?? course.slot);
  const end = periodForSlotKey(template, course.endSlotKey || course.startSlotKey)
    || periodForLogicalOrder(template, course.endSlot ?? course.startSlot ?? course.slot);
  if (!start || !end || end.logicalOrder < start.logicalOrder) return null;
  return { start, end, template };
}

export function templateRangesAreAdjacent(left, right, templateInput, options = {}) {
  const leftRange = templateRangeForCourse(left, templateInput);
  const rightRange = templateRangeForCourse(right, templateInput);
  if (!leftRange || !rightRange) return false;
  if (leftRange.end.logicalOrder + 1 !== rightRange.start.logicalOrder) return false;
  const allowCrossKind = Boolean(options.allowCrossKindMerge || leftRange.template.allowCrossKindMerge);
  return allowCrossKind || leftRange.end.kind === rightRange.start.kind;
}

export function templateRangesOverlap(left, right, templateInput) {
  const leftRange = templateRangeForCourse(left, templateInput);
  const rightRange = templateRangeForCourse(right, templateInput);
  if (!leftRange || !rightRange) return false;
  return leftRange.start.logicalOrder <= rightRange.end.logicalOrder
    && rightRange.start.logicalOrder <= leftRange.end.logicalOrder;
}

function courseWeeks(course = {}) {
  const parity = String(course.oddEven || 'all');
  return [...new Set((Array.isArray(course.weeks) ? course.weeks : []).map(Number).filter(Number.isInteger))]
    .filter((week) => parity === 'odd' ? week % 2 === 1 : parity === 'even' ? week % 2 === 0 : true);
}

export function visiblePeriodsForWeek(templateInput, courses = [], displayedWeek = null) {
  const template = normalizeScheduleTemplate(templateInput);
  const week = integer(displayedWeek, null);
  return template.periods.filter((period) => {
    if (period.visibilityPolicy !== VISIBILITY_POLICIES.AUTO) return true;
    return (courses || []).some((course) => {
      if (week !== null && !courseWeeks(course).includes(week)) return false;
      const range = templateRangeForCourse(course, template);
      return range && period.logicalOrder >= range.start.logicalOrder && period.logicalOrder <= range.end.logicalOrder;
    });
  });
}

export function projectTemplateToSlots(templateInput) {
  return normalizeScheduleTemplate(templateInput).periods.map((period) => ({
    slot: period.logicalOrder,
    slotKey: period.slotKey,
    sourceSlot: period.sourceSlot,
    label: period.displayLabel,
    range: period.startTime && period.endTime ? `${period.startTime}-${period.endTime}` : '',
    start: period.startTime,
    end: period.endTime,
    kind: period.kind,
    visibilityPolicy: period.visibilityPolicy,
    displayNumber: period.displayNumber,
    logicalOrder: period.logicalOrder
  }));
}
