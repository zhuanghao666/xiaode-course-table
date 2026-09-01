import crypto from 'crypto';
import {
  normalizeCourseSlotFields,
  templateRangesAreAdjacent,
  templateRangesOverlap
} from '../../shared/schedule-template.js';

export const IMPORT_REASON_CODES = Object.freeze({
  MISSING_NAME: 'MISSING_NAME',
  MISSING_DAY: 'MISSING_DAY',
  INVALID_DAY: 'INVALID_DAY',
  MISSING_SECTION: 'MISSING_SECTION',
  INVALID_SECTION: 'INVALID_SECTION',
  MISSING_WEEKS: 'MISSING_WEEKS',
  INVALID_WEEKS: 'INVALID_WEEKS',
  DUPLICATE_EXACT: 'DUPLICATE_EXACT',
  MERGED_SAME_COURSE: 'MERGED_SAME_COURSE',
  CONFLICTING_SCHEDULE: 'CONFLICTING_SCHEDULE',
  UNSUPPORTED_STRUCTURE: 'UNSUPPORTED_STRUCTURE',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  EXPIRED_IMPORT_CODE: 'EXPIRED_IMPORT_CODE',
  USED_IMPORT_CODE: 'USED_IMPORT_CODE',
  MISSING_TERM_PARAMS: 'MISSING_TERM_PARAMS',
  INVALID_TERM_PARAMS: 'INVALID_TERM_PARAMS',
  TERM_RESPONSE_MISMATCH: 'TERM_RESPONSE_MISMATCH',
  FILTERED_WRONG_TERM: 'FILTERED_WRONG_TERM',
  FILTERED_UNKNOWN_SOURCE: 'FILTERED_UNKNOWN_SOURCE',
  UNTRUSTED_TOTAL_WEEKS_FIELD: 'UNTRUSTED_TOTAL_WEEKS_FIELD',
  UNKNOWN: 'UNKNOWN'
});

const NAME_KEYS = ['kcmc', 'kcmcMc', 'kcmc_name', 'courseName', 'name'];
const TEACHER_KEYS = ['xm', 'jsxm', 'teacher', 'teachers', 'jsxx'];
const LOCATION_KEYS = ['cdmc', 'jxcdmc', 'croomName', 'location', 'jxdd', 'skdd'];
const CLASS_GROUP_KEYS = ['jxbmc', 'jxbzc', 'classGroup', 'className', 'bjmc'];
const WEEK_KEYS = ['zcd', 'zc', 'zcmc', 'weekText', 'weeks'];
const SECTION_TEXT_KEYS = ['jcor', 'jcs', 'jc', 'skjc', 'jcxx', 'sectionText'];
const COURSE_HINT_KEYS = new Set([
  ...NAME_KEYS,
  ...TEACHER_KEYS,
  ...LOCATION_KEYS,
  ...CLASS_GROUP_KEYS,
  ...WEEK_KEYS,
  ...SECTION_TEXT_KEYS,
  'xqj', 'xqjmc', 'xqjName', 'weekday', 'day',
  'ksjc', 'jsjc', 'qsjc', 'zzjc', 'startSection', 'endSection', 'startJc', 'endJc'
]);
const TERM_LABEL_KEYS = ['selectedTermLabel', 'xnxqmc', 'xnxqMc', 'xnmcXqmc', 'semesterName', 'termName'];
const ALLOWED_COURSE_ARRAYS = new Map([
  ['kblist', 'kbList'],
  ['sjklist', 'sjkList'],
  ['practicelist', 'practiceList'],
  ['adjustmentlist', 'adjustmentList'],
  ['tklist', 'tkList'],
  ['bklist', 'bkList'],
  ['bkkblist', 'bkkbList'],
  ['temporarycourselist', 'temporaryCourseList'],
  ['extracourselist', 'extraCourseList']
]);
// 真实 JWXT 响应目前没有经过验证的“学期总教学周数”字段。
// 这里故意保持空白；只有拿到脱敏真实响应并确认字段语义和所在层级后，才能新增精确根字段。
// zxs 是课程总学时（常见值 48/54），绝不能作为 totalWeeks。
const VERIFIED_TOTAL_WEEKS_ROOT_KEYS = new Set([]);
const UNTRUSTED_TOTAL_WEEKS_KEYS = new Set(['totalweeks', 'xqzcs', 'zxs', 'maxweek', 'weekcount']);
const TERM_START_KEYS = new Set(['termstart', 'xqksrq', 'startdate', 'semesterstartdate']);
const SENSITIVE_FIELD_NAME = /password|passwd|pwd|cookie|token|authorization|student|studentid|xh|xuehao|sfzh|idcard/i;

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function elapsed(start) {
  return Math.max(0, Number((nowMs() - start).toFixed(3)));
}

function normalizeText(value = '') {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickFirst(item = {}, keys = []) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function uniqueSorted(values = []) {
  return [...new Set(values.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

function parityForText(text = '') {
  const value = String(text || '');
  if (/单\s*周|\(\s*单\s*\)|（\s*单\s*）/.test(value)) return 'odd';
  if (/双\s*周|\(\s*双\s*\)|（\s*双\s*）/.test(value)) return 'even';
  return 'all';
}

function effectiveWeeks(baseWeeks, oddEven) {
  if (oddEven === 'odd') return baseWeeks.filter((week) => week % 2 === 1);
  if (oddEven === 'even') return baseWeeks.filter((week) => week % 2 === 0);
  return [...baseWeeks];
}

export function formatWeekText(weeks = [], oddEven = 'all') {
  const values = uniqueSorted(weeks);
  if (!values.length) return '';
  const parts = [];
  let start = values[0];
  let end = values[0];
  for (let i = 1; i <= values.length; i += 1) {
    const value = values[i];
    if (value === end + 1) {
      end = value;
      continue;
    }
    parts.push(start === end ? String(start) : `${start}-${end}`);
    start = value;
    end = value;
  }
  const suffix = oddEven === 'odd' ? '(单周)' : oddEven === 'even' ? '(双周)' : '';
  return `${parts.join(',')}周${suffix}`;
}

export function parseWeeksDetailed(weeks, weekText = '', options = {}) {
  const maxWeeks = Math.max(1, Math.min(60, Number(options.maxWeeks || 30)));
  const warnings = [];
  const rawText = normalizeText(weekText);
  const oddEven = parityForText(rawText);
  const out = [];
  let invalid = false;
  let duplicate = false;

  const pushWeek = (week) => {
    const value = Number(week);
    if (!Number.isInteger(value) || value < 1 || value > maxWeeks) {
      invalid = true;
      return;
    }
    if (out.includes(value)) duplicate = true;
    else out.push(value);
  };

  if (Array.isArray(weeks) && weeks.length) {
    for (const week of weeks) pushWeek(week);
  } else if (rawText) {
    const cleaned = rawText
      .replace(/[（(][^）)]*[单双][^）)]*[）)]/g, '')
      .replace(/单\s*周|双\s*周/g, '')
      .replace(/[第周\s]/g, '')
      .replace(/[，、；;]/g, ',')
      .replace(/[~～—–至到]/g, '-')
      .replace(/,+/g, ',')
      .replace(/^,|,$/g, '');

    if (!cleaned) invalid = true;
    for (const token of cleaned.split(',').filter(Boolean)) {
      if (/^\d+$/.test(token)) {
        pushWeek(Number(token));
        continue;
      }
      const range = token.match(/^(\d+)-(\d+)$/);
      if (!range) {
        invalid = true;
        continue;
      }
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start) {
        invalid = true;
        continue;
      }
      if (start < 1 || end > maxWeeks) {
        invalid = true;
        continue;
      }
      for (let week = start; week <= end; week += 1) pushWeek(week);
    }
  }

  const baseWeeks = uniqueSorted(out);
  if (duplicate) warnings.push({ reasonCode: IMPORT_REASON_CODES.INVALID_WEEKS, message: '周次中包含重复数字，已去重。' });
  if (invalid && baseWeeks.length) warnings.push({ reasonCode: IMPORT_REASON_CODES.INVALID_WEEKS, message: `部分周次无法解析或超出 1-${maxWeeks}，已忽略无效部分。` });
  if (!baseWeeks.length) {
    return {
      ok: false,
      reasonCode: rawText || (Array.isArray(weeks) && weeks.length)
        ? IMPORT_REASON_CODES.INVALID_WEEKS
        : IMPORT_REASON_CODES.MISSING_WEEKS,
      humanReadableReason: rawText || (Array.isArray(weeks) && weeks.length)
        ? '周次格式无效或超出合理学期范围。'
        : '缺少周次。',
      baseWeeks: [],
      parsedWeeks: [],
      oddEven,
      weekText: rawText,
      normalizedWeekText: '',
      warnings
    };
  }

  return {
    ok: true,
    reasonCode: null,
    humanReadableReason: '',
    baseWeeks,
    parsedWeeks: effectiveWeeks(baseWeeks, oddEven),
    oddEven,
    weekText: rawText,
    normalizedWeekText: formatWeekText(baseWeeks, oddEven),
    warnings
  };
}

export function parseDayDetailed(item = {}) {
  const raw = item.xqj ?? item.weekday ?? item.day;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const number = Number(raw);
    if (Number.isInteger(number) && number >= 1 && number <= 7) return { ok: true, day: number };
    if (/^\d+$/.test(String(raw).trim())) {
      return { ok: false, day: 0, reasonCode: IMPORT_REASON_CODES.INVALID_DAY, humanReadableReason: '星期必须在 1 到 7 之间。' };
    }
  }
  const text = normalizeText(item.xqjmc || item.xqjName || item.weekdayName || raw || '');
  if (!text) return { ok: false, day: 0, reasonCode: IMPORT_REASON_CODES.MISSING_DAY, humanReadableReason: '缺少星期。' };
  const match = text.match(/(?:星期|周)([一二三四五六日天1-7])/);
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
  if (match && map[match[1]]) return { ok: true, day: map[match[1]] };
  return { ok: false, day: 0, reasonCode: IMPORT_REASON_CODES.INVALID_DAY, humanReadableReason: '无法识别星期文本。' };
}

function validSection(section) {
  return Number.isInteger(section) && section >= 1 && section <= 12;
}

export function parseSectionsDetailed(item = {}) {
  const startRaw = pickFirst(item, ['ksjc', 'qsjc', 'startSection', 'startJc']);
  const endRaw = pickFirst(item, ['jsjc', 'zzjc', 'endSection', 'endJc']);
  if (startRaw !== '' || endRaw !== '') {
    const start = Number(startRaw || endRaw);
    const end = Number(endRaw || startRaw);
    if (!validSection(start) || !validSection(end) || end < start) {
      return { ok: false, slots: [], startSlot: 0, endSlot: 0, reasonCode: IMPORT_REASON_CODES.INVALID_SECTION, humanReadableReason: '起止节次无效、倒序或超出 12 节。' };
    }
    return { ok: true, slots: Array.from({ length: end - start + 1 }, (_, index) => start + index), startSlot: start, endSlot: end, sectionText: `${start}-${end}` };
  }

  const rawText = normalizeText(pickFirst(item, SECTION_TEXT_KEYS));
  if (!rawText) return { ok: false, slots: [], startSlot: 0, endSlot: 0, reasonCode: IMPORT_REASON_CODES.MISSING_SECTION, humanReadableReason: '缺少节次。' };
  const text = rawText
    .replace(/[第节\s]/g, '')
    .replace(/[~～—–至到]/g, '-')
    .replace(/[，、；;]/g, ',');
  const tokens = text.split(',').filter(Boolean);
  if (tokens.length > 1 && tokens.some((token) => token.includes('-'))) {
    return { ok: false, slots: [], startSlot: 0, endSlot: 0, reasonCode: IMPORT_REASON_CODES.INVALID_SECTION, humanReadableReason: '节次包含多个区间，无法确定连续课程范围。' };
  }

  let slots = [];
  if (tokens.length > 1) {
    if (!tokens.every((token) => /^\d+$/.test(token))) {
      return { ok: false, slots: [], startSlot: 0, endSlot: 0, reasonCode: IMPORT_REASON_CODES.INVALID_SECTION, humanReadableReason: '节次列表格式无效。' };
    }
    slots = uniqueSorted(tokens.map(Number));
    const contiguous = slots.every((slot, index) => index === 0 || slot === slots[index - 1] + 1);
    if (!slots.every(validSection) || !contiguous) {
      return { ok: false, slots: [], startSlot: 0, endSlot: 0, reasonCode: IMPORT_REASON_CODES.INVALID_SECTION, humanReadableReason: '节次列表不是 1 到 12 内的连续节次。' };
    }
  } else {
    const range = text.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!validSection(start) || !validSection(end) || end < start) {
        return { ok: false, slots: [], startSlot: 0, endSlot: 0, reasonCode: IMPORT_REASON_CODES.INVALID_SECTION, humanReadableReason: '节次区间无效、倒序或超出 12 节。' };
      }
      slots = Array.from({ length: end - start + 1 }, (_, index) => start + index);
    } else if (/^\d+$/.test(text) && validSection(Number(text))) {
      slots = [Number(text)];
    } else {
      return { ok: false, slots: [], startSlot: 0, endSlot: 0, reasonCode: IMPORT_REASON_CODES.INVALID_SECTION, humanReadableReason: '无法识别节次文本。' };
    }
  }
  return { ok: true, slots, startSlot: slots[0], endSlot: slots[slots.length - 1], sectionText: rawText };
}

function rawResponseType(data) {
  if (Array.isArray(data)) return 'array';
  if (data === null) return 'null';
  if (typeof data === 'string') return /<[^>]+>/.test(data) ? 'html-text' : 'text';
  return typeof data;
}

function looksLikeCandidate(item) {
  return Boolean(item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).some((key) => COURSE_HINT_KEYS.has(key)));
}

function embeddedJson(text) {
  const cleaned = normalizeText(text);
  if (cleaned.length < 2 || cleaned.length > 1_000_000 || !/^[\[{]/.test(cleaned)) return null;
  try { return JSON.parse(cleaned); } catch { return null; }
}

export function collectJwxtCandidates(data, options = {}) {
  const maxDepth = Math.max(1, Math.min(8, Number(options.maxDepth || 5)));
  const maxCandidates = Math.max(10, Math.min(5000, Number(options.maxCandidates || 1000)));
  const candidates = [];
  const sourceCounts = {};
  const unknownSourceCounts = {};
  const visited = new Set();

  const addCandidate = (item, source, sourceIndex) => {
    if (!looksLikeCandidate(item) || candidates.length >= maxCandidates) return;
    candidates.push({ item, source, sourceIndex });
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  };

  const countUnknownCandidates = (items, source) => {
    const count = items.filter(looksLikeCandidate).length;
    if (count) unknownSourceCounts[source] = (unknownSourceCounts[source] || 0) + count;
  };

  const walk = (node, pathName = 'root', depth = 0) => {
    if (node === null || node === undefined || depth > maxDepth || candidates.length >= maxCandidates) return;
    if (typeof node === 'string') {
      const parsed = embeddedJson(node);
      if (parsed) walk(parsed, `${pathName}:embeddedJson`, depth + 1);
      return;
    }
    if (typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      // 根数组及来源不明数组只做计数，不再把“看起来像课程”的对象直接导入。
      countUnknownCandidates(node, pathName);
      node.forEach((item, index) => walk(item, `${pathName}[${index}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const childPath = pathName === 'root' ? key : `${pathName}.${key}`;
      if (Array.isArray(value)) {
        const allowedSource = ALLOWED_COURSE_ARRAYS.get(String(key).toLowerCase());
        if (allowedSource) {
          value.forEach((item, index) => addCandidate(item, allowedSource, index));
          value.forEach((item, index) => walk(item, `${childPath}[${index}]`, depth + 1));
        } else {
          countUnknownCandidates(value, childPath);
          value.forEach((item, index) => walk(item, `${childPath}[${index}]`, depth + 1));
        }
        continue;
      }
      walk(value, childPath, depth + 1);
    }
  };

  walk(data);
  const filteredUnknownSourceCount = Object.values(unknownSourceCounts).reduce((sum, count) => sum + count, 0);
  return {
    candidates,
    sourceCounts,
    unknownSourceCounts,
    filteredUnknownSourceCount,
    rawResponseType: rawResponseType(data),
    truncated: candidates.length >= maxCandidates
  };
}

function mapCategory(item = {}, name = '') {
  const text = `${item.kclb || ''} ${item.kcxz || ''} ${name || ''}`;
  if (text.includes('实验')) return 'lab';
  if (text.includes('公共必修')) return 'public_required';
  if (text.includes('专业必修')) return 'major_required';
  if (text.includes('专业选修')) return 'major_elective';
  if (text.includes('公共选修')) return 'public_elective';
  return 'custom';
}

function normalizedIdentityText(value = '') {
  return normalizeStoredCourseText(value);
}

// 已落库的手工课程允许包含尖括号等普通字符；合并身份只规范化空白，不做 HTML 清洗。
function normalizeStoredCourseText(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function firstNonEmptyStoredCourseText(...values) {
  for (const value of values) {
    const text = normalizeStoredCourseText(value);
    if (text) return text;
  }
  return '';
}

function effectiveCourseWeeks(course) {
  return effectiveWeeks(uniqueSorted(course.weeks || []), course.oddEven || 'all');
}

function overlap(a = [], b = []) {
  const right = new Set(b);
  return a.some((value) => right.has(value));
}

function courseSectionRange(course = {}) {
  const rawFallback = Number(course.slot ?? course.startSection ?? 0);
  const fallback = Number.isInteger(rawFallback) && rawFallback >= 1 && rawFallback <= 12 ? rawFallback : 0;
  const start = Number(course.startSlot ?? course.startSection ?? fallback);
  const end = Number(course.endSlot ?? course.endSection ?? start);
  const valid = Number.isInteger(start) && start >= 1 && start <= 12
    && Number.isInteger(end) && end >= start && end <= 12;
  const safeStart = Number.isInteger(start) && start >= 1 && start <= 12 ? start : fallback;
  const safeEnd = Number.isInteger(end) && end >= safeStart && end <= 12 ? end : safeStart;
  return { startSlot: safeStart, endSlot: safeEnd, valid };
}

function weeksFingerprint(course) {
  const effective = effectiveCourseWeeks(course);
  if (effective.length) return `weeks:${effective.join(',')}`;
  return `pattern:${normalizeStoredCourseText(course.weekText || course.weekPattern)}|parity:${normalizeStoredCourseText(course.oddEven || 'all')}`;
}

function normalizeMergeCourse(original = {}, order = 0) {
  const range = courseSectionRange(original);
  const parsedWeeks = parseWeeksDetailed(
    original.weeks,
    original.weekText || original.weekPattern || '',
    { maxWeeks: 60 }
  );
  const weeks = uniqueSorted(parsedWeeks.baseWeeks || []);
  const oddEven = original.oddEven || parsedWeeks.oddEven || 'all';
  return {
    ...original,
    day: Number(original.day ?? original.weekday),
    slot: range.startSlot,
    startSlot: range.startSlot,
    endSlot: range.endSlot,
    name: firstNonEmptyStoredCourseText(original.name, original.courseName),
    teacher: normalizeStoredCourseText(original.teacher),
    location: firstNonEmptyStoredCourseText(original.location, original.room),
    weeks,
    oddEven,
    weekText: formatWeekText(weeks, oddEven) || firstNonEmptyStoredCourseText(original.weekText, original.weekPattern),
    _mergeWeeksKnown: effectiveWeeks(weeks, oddEven).length > 0,
    _mergeRangeValid: range.valid,
    _mergeOrder: order
  };
}

function exactFingerprint(course) {
  return [
    course.accountId || '', course.termKey || '', course.scheduleTemplateId || '', normalizedIdentityText(course.name),
    Number(course.day), course.startSlotKey || Number(course.startSlot), course.endSlotKey || Number(course.endSlot), weeksFingerprint(course),
    normalizedIdentityText(course.location), normalizedIdentityText(course.teacher)
  ].join('|');
}

function mergeFingerprint(course, options = {}) {
  return [
    course.accountId || '', options.separateSources ? (course.source === 'jwxt' ? 'jwxt' : 'non-jwxt') : '', course.termKey || '', course.scheduleTemplateId || '', normalizedIdentityText(course.name),
    Number(course.day), weeksFingerprint(course), normalizedIdentityText(course.location), normalizedIdentityText(course.teacher)
  ].join('|');
}

function scheduleFingerprint(course) {
  return [course.accountId || '', course.termKey || '', course.scheduleTemplateId || '', Number(course.day)].join('|');
}

function rangesAreAdjacent(left, right, options = {}) {
  if (options.scheduleTemplate) return templateRangesAreAdjacent(left, right, options.scheduleTemplate, options);
  return Number(left.endSlot) + 1 === Number(right.startSlot);
}

function rangesOverlap(left, right, options = {}) {
  if (options.scheduleTemplate) return templateRangesOverlap(left, right, options.scheduleTemplate);
  return Number(left.startSlot) <= Number(right.endSlot)
    && Number(right.startSlot) <= Number(left.endSlot);
}

export function mergeCourseRecords(courses = [], options = {}) {
  const merged = [];
  const exactMap = new Map();
  const identityMap = new Map();
  const scheduleMap = new Map();
  const events = [];
  const warnings = [];

  const normalized = courses.map((course, index) => normalizeMergeCourse(course, index));
  const isMergeable = (course) => course.name
    && Number.isInteger(course.day) && course.day >= 1 && course.day <= 7
    && course._mergeRangeValid
    && course.startSlot >= 1 && course.endSlot >= course.startSlot && course.endSlot <= 12;
  const passthrough = normalized
    .map((course, index) => ({ course, original: courses[index] }))
    .filter(({ course }) => !isMergeable(course))
    .map(({ original }) => original);
  const prepared = normalized
    .filter(isMergeable)
    .sort((a, b) => Number(a.startSlot) - Number(b.startSlot)
      || Number(a.endSlot) - Number(b.endSlot)
      || (options.separateSources ? Number(a.source === 'jwxt') - Number(b.source === 'jwxt') : 0)
      || a._mergeOrder - b._mergeOrder);

  for (const course of prepared) {
    const exactKey = exactFingerprint(course);
    if (exactMap.has(exactKey)) {
      const kept = exactMap.get(exactKey);
      events.push({ reasonCode: IMPORT_REASON_CODES.DUPLICATE_EXACT, keptCandidateId: kept._candidateId || null, mergedCandidateId: course._candidateId || null, keptCourseIndex: merged.indexOf(kept), weeksBefore: kept.weeks, mergedWeeks: course.weeks, weeksAfter: kept.weeks });
      continue;
    }

    const mergeKey = mergeFingerprint(course, options);
    const sameIdentityRanges = identityMap.get(mergeKey) || [];
    const adjacent = sameIdentityRanges.find((kept) => kept._mergeWeeksKnown && course._mergeWeeksKnown && rangesAreAdjacent(kept, course, options));
    if (adjacent) {
      const beforeRange = { startSlot: adjacent.startSlot, endSlot: adjacent.endSlot };
      adjacent.endSlot = course.endSlot;
      adjacent.slot = adjacent.startSlot;
      if (course.sourceEndSlot !== undefined) adjacent.sourceEndSlot = course.sourceEndSlot;
      if (course.endSlotKey) adjacent.endSlotKey = course.endSlotKey;
      if (course.scheduleTemplateId) adjacent.scheduleTemplateId = course.scheduleTemplateId;
      events.push({
        reasonCode: IMPORT_REASON_CODES.MERGED_SAME_COURSE,
        keptCandidateId: adjacent._candidateId || null,
        mergedCandidateId: course._candidateId || null,
        keptCourseIndex: merged.indexOf(adjacent),
        weeksBefore: adjacent.weeks,
        mergedWeeks: course.weeks,
        weeksAfter: adjacent.weeks,
        rangeBefore: beforeRange,
        mergedRange: { startSlot: course.startSlot, endSlot: course.endSlot },
        rangeAfter: { startSlot: adjacent.startSlot, endSlot: adjacent.endSlot }
      });
      exactMap.set(exactFingerprint(adjacent), adjacent);
      continue;
    }

    const scheduled = scheduleMap.get(scheduleFingerprint(course)) || [];
    for (const other of scheduled) {
      if (!rangesOverlap(other, course, options) || !overlap(effectiveCourseWeeks(other), effectiveCourseWeeks(course))) continue;
      if (mergeFingerprint(other, options) === mergeKey) continue;
      warnings.push({
        reasonCode: IMPORT_REASON_CODES.CONFLICTING_SCHEDULE,
        message: '同一星期和节次范围存在周次重叠但课程指纹不同，已保留两条记录。',
        candidateIds: [other._candidateId || null, course._candidateId || null].filter(Boolean),
        day: course.day,
        startSlot: Math.max(other.startSlot, course.startSlot),
        endSlot: Math.min(other.endSlot, course.endSlot)
      });
    }

    merged.push(course);
    exactMap.set(exactKey, course);
    sameIdentityRanges.push(course);
    identityMap.set(mergeKey, sameIdentityRanges);
    scheduled.push(course);
    scheduleMap.set(scheduleFingerprint(course), scheduled);
  }

  // 分来源合并后可能形成新的跨来源完全重复范围；最终再去重一次，手工记录优先保留。
  const finalCourses = [];
  const finalExactMap = new Map();
  for (const course of merged) {
    const key = exactFingerprint(course);
    const existing = finalExactMap.get(key);
    if (existing) {
      let kept = existing;
      let removed = course;
      if (options.separateSources && existing.source === 'jwxt' && course.source !== 'jwxt') {
        const index = finalCourses.indexOf(existing);
        if (index >= 0) finalCourses[index] = course;
        finalExactMap.set(key, course);
        kept = course;
        removed = existing;
      }
      events.push({ reasonCode: IMPORT_REASON_CODES.DUPLICATE_EXACT, keptCandidateId: kept._candidateId || null, duplicateCandidateId: removed._candidateId || null, keptCourseIndex: finalCourses.indexOf(kept) });
      continue;
    }
    finalCourses.push(course);
    finalExactMap.set(key, course);
  }

  for (const course of finalCourses) {
    delete course._mergeWeeksKnown;
    delete course._mergeRangeValid;
    delete course._mergeOrder;
  }

  // 旧数据中无法安全判断范围的记录必须原样保留，迁移不能静默删除用户课程。
  return { courses: [...finalCourses, ...passthrough], events, warnings };
}

function jwxtDisplaySessionFingerprint(course) {
  const range = courseSectionRange(course);
  const classGroup = normalizeStoredCourseText(course.classGroup);
  const importTraceId = normalizeStoredCourseText(course.importTraceId);
  if (course.source !== 'jwxt' || !classGroup || !importTraceId || !range.valid || effectiveCourseWeeks(course).length === 0) return '';
  return [
    normalizeStoredCourseText(course.accountId),
    normalizeStoredCourseText(course.termKey),
    Number(course.day ?? course.weekday),
    firstNonEmptyStoredCourseText(course.name, course.courseName),
    firstNonEmptyStoredCourseText(course.location, course.room),
    range.startSlot,
    range.endSlot,
    classGroup,
    normalizeStoredCourseText(course.category || 'custom'),
    Boolean(course.isAdjusted),
    normalizeStoredCourseText(course.sourceDetail),
    importTraceId
  ].join('|');
}

function courseScheduleVariants(course) {
  if (Array.isArray(course.scheduleVariants) && course.scheduleVariants.length) {
    return course.scheduleVariants.map((variant) => ({ ...variant }));
  }
  return [{
    id: course.id || '',
    weeks: uniqueSorted(course.weeks || []),
    weekText: firstNonEmptyStoredCourseText(course.weekText, course.weekPattern),
    oddEven: course.oddEven || 'all',
    teacher: normalizeStoredCourseText(course.teacher),
    source: course.source || ''
  }];
}

// 教务系统可能同时返回“整学期教师”和“分周教师”记录。底层记录仍严格保留，
// 这里只为 API/Widget 生成同一导入批次、同一班级和同一完整范围的一张逻辑展示卡。
export function buildCourseDisplayRecords(courses = []) {
  const output = [];
  const grouped = new Map();
  for (const course of courses || []) {
    const key = jwxtDisplaySessionFingerprint(course);
    if (!key) {
      output.push(course);
      continue;
    }
    if (!grouped.has(key)) {
      const entry = { index: output.length, courses: [] };
      grouped.set(key, entry);
      output.push(null);
    }
    grouped.get(key).courses.push(course);
  }

  for (const { index, courses: variants } of grouped.values()) {
    if (variants.length === 1) {
      output[index] = variants[0];
      continue;
    }
    const sample = variants[0];
    const underlyingIds = [...new Set(variants.flatMap((course) => {
      const ids = Array.isArray(course.underlyingIds) ? course.underlyingIds : [course.id];
      return ids.map((id) => normalizeStoredCourseText(id)).filter(Boolean);
    }))];
    const scheduleVariants = variants.flatMap(courseScheduleVariants);
    const weeks = uniqueSorted(scheduleVariants.flatMap((variant) => effectiveWeeks(uniqueSorted(variant.weeks || []), variant.oddEven || 'all')));
    const teachers = [...new Set(scheduleVariants.map((variant) => normalizeStoredCourseText(variant.teacher)).filter(Boolean))];
    output[index] = {
      ...sample,
      weeks,
      oddEven: 'all',
      weekText: formatWeekText(weeks, 'all') || sample.weekText || '',
      teacher: teachers.join(' / '),
      underlyingIds,
      sourceIds: underlyingIds,
      scheduleVariants,
      variantCount: scheduleVariants.length,
      logicalSession: true
    };
  }

  return output.filter(Boolean);
}

function candidateFieldNames(item) {
  return Object.keys(item || {})
    .filter((key) => key !== '__source' && !SENSITIVE_FIELD_NAME.test(key))
    .slice(0, 80)
    .sort();
}

function safeFailedSectionFields(item = {}) {
  const out = {};
  for (const key of ['jc', 'jcor', 'jcs', 'oldjc']) {
    if (item[key] === undefined || item[key] === null) continue;
    const value = normalizeText(item[key]).slice(0, 120);
    if (value) out[key] = value;
  }
  return out;
}

function rejection(diag, reasonCode, humanReadableReason) {
  diag.result = reasonCode === IMPORT_REASON_CODES.UNSUPPORTED_STRUCTURE ? 'rejected' : 'filtered';
  diag.reasonCode = reasonCode;
  diag.humanReadableReason = humanReadableReason;
  return diag;
}

function normalizedTermLabel(value = '') {
  return normalizeText(value).replace(/\s+/g, ' ');
}

function responseTermForItem(item = {}) {
  return {
    xnm: normalizeText(item.xnm ?? item.XNM ?? ''),
    xqm: normalizeText(item.xqm ?? item.XQM ?? ''),
    label: normalizedTermLabel(pickFirst(item, TERM_LABEL_KEYS))
  };
}

function itemMatchesRequestedTerm(item, context) {
  const response = responseTermForItem(item);
  const requestedXnm = normalizeText(context.xnm || '');
  const requestedXqm = normalizeText(context.xqm || '');
  const requestedLabel = normalizedTermLabel(context.selectedTermLabel || '');
  const hasCode = Boolean(response.xnm || response.xqm);
  const codeMatches = !hasCode || (response.xnm === requestedXnm && response.xqm === requestedXqm);
  const labelMatches = !response.label || response.label === requestedLabel;
  return { matches: codeMatches && labelMatches, response };
}

function extractScheduleMetadata(data, context = {}) {
  const maxDepth = Math.max(1, Math.min(8, Number(context.maxDepth || 5)));
  const visited = new Set();
  const ignoredTotalWeeksFields = new Set();
  const termStarts = [];

  // 总周数只允许从经过真实响应验证的根字段读取，禁止递归猜测同名或缩写字段。
  let explicitTotalWeeks = null;
  let explicitTotalWeeksField = '';
  if (data && typeof data === 'object' && !Array.isArray(data) && itemMatchesRequestedTerm(data, context).matches) {
    for (const key of VERIFIED_TOTAL_WEEKS_ROOT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      const weeks = Number(data[key]);
      if (Number.isInteger(weeks) && weeks >= 1 && weeks <= 30) {
        explicitTotalWeeks = weeks;
        explicitTotalWeeksField = key;
        break;
      }
    }
  }

  const walk = (node, depth = 0) => {
    if (node === null || node === undefined || depth > maxDepth) return;
    if (typeof node === 'string') {
      const parsed = embeddedJson(node);
      if (parsed) walk(parsed, depth + 1);
      return;
    }
    if (typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    const belongsToRequestedTerm = itemMatchesRequestedTerm(node, context).matches;
    for (const [key, value] of Object.entries(node)) {
      const normalizedKey = String(key).toLowerCase();
      if (belongsToRequestedTerm && UNTRUSTED_TOTAL_WEEKS_KEYS.has(normalizedKey)) ignoredTotalWeeksFields.add(normalizedKey);
      if (belongsToRequestedTerm && TERM_START_KEYS.has(normalizedKey)) {
        const text = normalizeText(value);
        const match = text.match(/^(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})$/);
        if (match) termStarts.push(`${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`);
      }
      walk(value, depth + 1);
    }
  };

  walk(data);
  return {
    explicitTotalWeeks,
    explicitTotalWeeksField,
    ignoredTotalWeeksFields: [...ignoredTotalWeeksFields].sort(),
    explicitTermStart: termStarts[0] || ''
  };
}

export function analyzeJwxtImport(data, context = {}) {
  const totalStart = nowMs();
  const collectionStart = nowMs();
  const collected = collectJwxtCandidates(data, context);
  const collectionMs = elapsed(collectionStart);
  const parsingStart = nowMs();
  const diagnostics = [];
  const generated = [];
  const warnings = [];
  const errors = [];
  let recognized = 0;
  let filtered = 0;
  let filteredWrongTermCount = 0;
  const responseTermCounts = new Map();
  const acceptedResponseTermCounts = new Map();
  let incompleteResponseTermCount = 0;
  const scheduleMetadata = extractScheduleMetadata(data, context);
  if (scheduleMetadata.ignoredTotalWeeksFields.length) {
    const fields = scheduleMetadata.ignoredTotalWeeksFields.join('、');
    warnings.push({
      reasonCode: IMPORT_REASON_CODES.UNTRUSTED_TOTAL_WEEKS_FIELD,
      message: `已忽略未经真实响应验证的总周数字段：${fields}；将使用已确认的手工设置或课程最晚周次。`
    });
  }

  collected.candidates.forEach(({ item, source, sourceIndex }, index) => {
    const candidateId = `candidate-${index + 1}`;
    const name = normalizeText(pickFirst(item, NAME_KEYS));
    const teacher = normalizeText(pickFirst(item, TEACHER_KEYS));
    const location = normalizeText(pickFirst(item, LOCATION_KEYS));
    const classGroup = normalizeText(pickFirst(item, CLASS_GROUP_KEYS));
    const rawWeekValue = pickFirst(item, WEEK_KEYS);
    const weekText = Array.isArray(rawWeekValue) ? '' : normalizeText(rawWeekValue);
    const explicitWeeks = Array.isArray(item.weeks) ? item.weeks : Array.isArray(rawWeekValue) ? rawWeekValue : null;
    const dayResult = parseDayDetailed(item);
    const sectionResult = parseSectionsDetailed(item);
    const weekResult = parseWeeksDetailed(explicitWeeks, weekText, { maxWeeks: context.maxWeeks || 30 });
    const termMatch = itemMatchesRequestedTerm(item, context);
    const responseXnm = termMatch.response.xnm;
    const responseXqm = termMatch.response.xqm;
    const responseTermLabel = termMatch.response.label;
    if (responseXnm && responseXqm) {
      const key = `${responseXnm}\u0000${responseXqm}`;
      responseTermCounts.set(key, (responseTermCounts.get(key) || 0) + 1);
    } else if (responseXnm || responseXqm) {
      incompleteResponseTermCount += 1;
    }
    const diag = {
      candidateId,
      source,
      sourceIndex,
      rawFieldNames: candidateFieldNames(item),
      name,
      day: dayResult.day || 0,
      slot: sectionResult.startSlot || 0,
      startSlot: sectionResult.startSlot || 0,
      endSlot: sectionResult.endSlot || 0,
      weekText,
      parsedWeeks: weekResult.parsedWeeks,
      oddEven: weekResult.oddEven,
      teacher,
      location,
      classGroup,
      responseXnm,
      responseXqm,
      responseTermLabel,
      result: 'accepted',
      reasonCode: null,
      humanReadableReason: '',
      producedCourseCount: 0
    };

    if (!termMatch.matches) rejection(diag, IMPORT_REASON_CODES.FILTERED_WRONG_TERM, '原始课程记录不属于本次冻结的学期。');
    else if (!name) rejection(diag, IMPORT_REASON_CODES.MISSING_NAME, '缺少课程名称。');
    else if (!dayResult.ok) rejection(diag, dayResult.reasonCode, dayResult.humanReadableReason);
    else if (!sectionResult.ok) rejection(diag, sectionResult.reasonCode, sectionResult.humanReadableReason);
    else if (!weekResult.ok) rejection(diag, weekResult.reasonCode, weekResult.humanReadableReason);

    for (const warning of weekResult.warnings) warnings.push({ ...warning, candidateId });
    if (diag.result !== 'accepted') {
      diag.safeSectionFields = safeFailedSectionFields(item);
      filtered += 1;
      if (diag.reasonCode === IMPORT_REASON_CODES.FILTERED_WRONG_TERM) filteredWrongTermCount += 1;
      errors.push({ reasonCode: diag.reasonCode, message: diag.humanReadableReason, candidateId });
      diagnostics.push(diag);
      return;
    }

    recognized += 1;
    if (responseXnm && responseXqm) {
      const key = `${responseXnm}\u0000${responseXqm}`;
      acceptedResponseTermCounts.set(key, (acceptedResponseTermCounts.get(key) || 0) + 1);
    }
    const adjusted = /调|tk|adjust/i.test(`${source} ${item.tkbz || ''} ${item.bz || ''} ${name}`);
    const storedName = adjusted && !name.includes('调') ? `【调】${name}` : name;
    const sourceSlots = {
      sourceStartSlot: sectionResult.startSlot,
      sourceEndSlot: sectionResult.endSlot
    };
    const mappedSlots = context.scheduleTemplate
      ? normalizeCourseSlotFields(sourceSlots, context.scheduleTemplate)
      : {
          slot: sectionResult.startSlot,
          startSlot: sectionResult.startSlot,
          endSlot: sectionResult.endSlot,
          startSlotKey: `P${sectionResult.startSlot}`,
          endSlotKey: `P${sectionResult.endSlot}`,
          scheduleTemplateId: String(context.scheduleTemplateId || 'legacy-default'),
          ...sourceSlots
        };
    generated.push({
      userId: context.userId || '',
      accountId: context.accountId || '',
      day: dayResult.day,
      slot: mappedSlots?.slot || sectionResult.startSlot,
      startSlot: mappedSlots?.startSlot || sectionResult.startSlot,
      endSlot: mappedSlots?.endSlot || sectionResult.endSlot,
      sourceStartSlot: sectionResult.startSlot,
      sourceEndSlot: sectionResult.endSlot,
      startSlotKey: mappedSlots?.startSlotKey || `P${sectionResult.startSlot}`,
      endSlotKey: mappedSlots?.endSlotKey || `P${sectionResult.endSlot}`,
      scheduleTemplateId: mappedSlots?.scheduleTemplateId || String(context.scheduleTemplateId || 'legacy-default'),
      name: storedName,
      originalName: name,
      shortName: '',
      teacher,
      location,
      classGroup,
      weekText: weekResult.normalizedWeekText,
      weeks: weekResult.baseWeeks,
      oddEven: weekResult.oddEven,
      category: mapCategory(item, name),
      source: 'jwxt',
      sourceDetail: source,
      sourceIndex,
      termKey: String(context.termKey || `${context.accountId || ''}:${context.xnm || ''}:${context.xqm || ''}`),
      xnm: responseXnm || String(context.xnm || ''),
      xqm: responseXqm || String(context.xqm || ''),
      selectedTermLabel: String(context.selectedTermLabel || ''),
      isAdjusted: adjusted,
      importTraceId: context.traceId || '',
      _candidateId: candidateId
    });
    diag.producedCourseCount = 1;
    diagnostics.push(diag);
  });

  if (collected.truncated) warnings.push({ reasonCode: IMPORT_REASON_CODES.UNSUPPORTED_STRUCTURE, message: '候选数量超过安全上限，诊断已截断。' });
  const parsingMs = elapsed(parsingStart);
  const mergeStart = nowMs();
  const mergeResult = mergeCourseRecords(generated, { scheduleTemplate: context.scheduleTemplate });
  const mergeMs = elapsed(mergeStart);
  warnings.push(...mergeResult.warnings);

  const mergedCandidateIds = new Map();
  for (const event of mergeResult.events) {
    if (!event.mergedCandidateId) continue;
    const list = mergedCandidateIds.get(event.mergedCandidateId) || [];
    list.push(event);
    mergedCandidateIds.set(event.mergedCandidateId, list);
  }
  for (const diag of diagnostics) {
    const events = mergedCandidateIds.get(diag.candidateId) || [];
    if (!events.length || diag.result !== 'accepted') continue;
    diag.mergeEvents = events.map((event) => ({ reasonCode: event.reasonCode, weeksBefore: event.weeksBefore, weeksAfter: event.weeksAfter }));
    if (events.length >= diag.producedCourseCount) {
      diag.result = 'merged';
      diag.reasonCode = events.every((event) => event.reasonCode === IMPORT_REASON_CODES.DUPLICATE_EXACT)
        ? IMPORT_REASON_CODES.DUPLICATE_EXACT
        : IMPORT_REASON_CODES.MERGED_SAME_COURSE;
      diag.humanReadableReason = diag.reasonCode === IMPORT_REASON_CODES.DUPLICATE_EXACT
        ? '与已接收候选完全重复，已去重。'
        : '与同一课程的连续节次安全合并。';
    }
  }

  const accepted = generated.length;
  const rawCount = collected.candidates.length + collected.filteredUnknownSourceCount;
  const filteredUnknownSourceCount = collected.filteredUnknownSourceCount;
  const importedCount = mergeResult.courses.length;
  const summary = {
    received: rawCount,
    recognized,
    accepted,
    filtered: filtered + filteredUnknownSourceCount,
    merged: mergeResult.events.length,
    written: importedCount,
    beforeCount: 0,
    afterCount: 0,
    rawCount,
    acceptedCount: recognized,
    importedCount,
    filteredWrongTermCount,
    filteredUnknownSourceCount
  };
  const responseTerms = [...responseTermCounts.entries()].map(([key, count]) => {
    const [xnm, xqm] = key.split('\u0000');
    return { xnm, xqm, count };
  });
  const acceptedResponseTerms = [...acceptedResponseTermCounts.entries()].map(([key, count]) => {
    const [xnm, xqm] = key.split('\u0000');
    return { xnm, xqm, count };
  });
  return {
    selectedTermLabel: String(context.selectedTermLabel || ''),
    xnm: String(context.xnm || ''),
    xqm: String(context.xqm || ''),
    rawResponseType: collected.rawResponseType,
    candidateSources: Object.keys(collected.sourceCounts),
    sourceCounts: collected.sourceCounts,
    unknownSourceCounts: collected.unknownSourceCounts,
    rawCount,
    acceptedCount: recognized,
    filteredWrongTermCount,
    filteredUnknownSourceCount,
    importedCount,
    candidates: diagnostics,
    courses: mergeResult.courses.map(({ _candidateId, ...course }) => course),
    mergeEvents: mergeResult.events,
    summary,
    warnings,
    errors,
    responseTerms,
    acceptedResponseTerms,
    incompleteResponseTermCount,
    explicitTotalWeeks: scheduleMetadata.explicitTotalWeeks,
    explicitTotalWeeksField: scheduleMetadata.explicitTotalWeeksField,
    ignoredTotalWeeksFields: scheduleMetadata.ignoredTotalWeeksFields,
    explicitTermStart: scheduleMetadata.explicitTermStart,
    timings: {
      collectionMs,
      parsingMs,
      mergeMs,
      totalMs: elapsed(totalStart)
    }
  };
}

export function createImportTraceId() {
  return `imp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}
