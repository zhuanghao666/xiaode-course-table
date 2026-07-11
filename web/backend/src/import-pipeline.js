import crypto from 'crypto';

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
  const visited = new Set();

  const addCandidate = (item, source, sourceIndex) => {
    if (!looksLikeCandidate(item) || candidates.length >= maxCandidates) return;
    candidates.push({ item, source, sourceIndex });
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
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
      node.forEach((item, index) => {
        addCandidate(item, pathName, index);
        walk(item, `${pathName}[${index}]`, depth + 1);
      });
      return;
    }
    for (const [key, value] of Object.entries(node)) walk(value, pathName === 'root' ? key : `${pathName}.${key}`, depth + 1);
  };

  walk(data);
  return { candidates, sourceCounts, rawResponseType: rawResponseType(data), truncated: candidates.length >= maxCandidates };
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
  return normalizeText(value).toLocaleLowerCase('zh-CN');
}

function effectiveCourseWeeks(course) {
  return effectiveWeeks(uniqueSorted(course.weeks || []), course.oddEven || 'all');
}

function overlap(a = [], b = []) {
  const right = new Set(b);
  return a.some((value) => right.has(value));
}

function exactFingerprint(course) {
  return [
    course.accountId || '', course.source || '', course.termKey || '', normalizedIdentityText(course.name),
    normalizedIdentityText(course.shortName), Number(course.day), Number(course.slot),
    normalizedIdentityText(course.teacher), normalizedIdentityText(course.location), normalizedIdentityText(course.classGroup),
    uniqueSorted(course.weeks || []).join(','), course.oddEven || 'all', course.category || 'custom', Boolean(course.isAdjusted)
  ].join('|');
}

function mergeFingerprint(course) {
  return [
    course.accountId || '', course.source || '', course.termKey || '', normalizedIdentityText(course.name),
    normalizedIdentityText(course.shortName), Number(course.day), Number(course.slot),
    normalizedIdentityText(course.teacher), normalizedIdentityText(course.location), normalizedIdentityText(course.classGroup),
    course.oddEven || 'all', course.category || 'custom', Boolean(course.isAdjusted)
  ].join('|');
}

function scheduleFingerprint(course) {
  return [course.accountId || '', Number(course.day), Number(course.slot)].join('|');
}

export function mergeCourseRecords(courses = [], options = {}) {
  const merged = [];
  const exactMap = new Map();
  const identityMap = new Map();
  const scheduleMap = new Map();
  const events = [];
  const warnings = [];

  for (const original of courses) {
    const course = { ...original, weeks: uniqueSorted(original.weeks || []) };
    const exactKey = exactFingerprint(course);
    if (exactMap.has(exactKey)) {
      const kept = exactMap.get(exactKey);
      events.push({ reasonCode: IMPORT_REASON_CODES.DUPLICATE_EXACT, keptCandidateId: kept._candidateId || null, mergedCandidateId: course._candidateId || null, keptCourseIndex: merged.indexOf(kept), weeksBefore: kept.weeks, mergedWeeks: course.weeks, weeksAfter: kept.weeks });
      continue;
    }

    const mergeKey = mergeFingerprint(course);
    if (identityMap.has(mergeKey)) {
      const kept = identityMap.get(mergeKey);
      const before = [...kept.weeks];
      kept.weeks = uniqueSorted([...kept.weeks, ...course.weeks]);
      kept.weekText = formatWeekText(kept.weeks, kept.oddEven);
      events.push({ reasonCode: IMPORT_REASON_CODES.MERGED_SAME_COURSE, keptCandidateId: kept._candidateId || null, mergedCandidateId: course._candidateId || null, keptCourseIndex: merged.indexOf(kept), weeksBefore: before, mergedWeeks: course.weeks, weeksAfter: kept.weeks });
      exactMap.set(exactFingerprint(kept), kept);
      continue;
    }

    const scheduled = scheduleMap.get(scheduleFingerprint(course)) || [];
    for (const other of scheduled) {
      if (!overlap(effectiveCourseWeeks(other), effectiveCourseWeeks(course))) continue;
      const sameIdentity = mergeFingerprint(other) === mergeKey;
      if (sameIdentity) continue;
      const warning = {
        reasonCode: IMPORT_REASON_CODES.CONFLICTING_SCHEDULE,
        message: '同一星期和节次存在周次重叠但课程指纹不同，已保留两条记录。',
        candidateIds: [other._candidateId || null, course._candidateId || null].filter(Boolean),
        day: course.day,
        slot: course.slot
      };
      warnings.push(warning);
    }

    merged.push(course);
    exactMap.set(exactKey, course);
    identityMap.set(mergeKey, course);
    scheduled.push(course);
    scheduleMap.set(scheduleFingerprint(course), scheduled);
  }

  return { courses: merged, events, warnings };
}

function candidateFieldNames(item) {
  return Object.keys(item || {})
    .filter((key) => key !== '__source' && !SENSITIVE_FIELD_NAME.test(key))
    .slice(0, 80)
    .sort();
}

function rejection(diag, reasonCode, humanReadableReason) {
  diag.result = reasonCode === IMPORT_REASON_CODES.UNSUPPORTED_STRUCTURE ? 'rejected' : 'filtered';
  diag.reasonCode = reasonCode;
  diag.humanReadableReason = humanReadableReason;
  return diag;
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
      result: 'accepted',
      reasonCode: null,
      humanReadableReason: '',
      producedCourseCount: 0
    };

    if (!name) rejection(diag, IMPORT_REASON_CODES.MISSING_NAME, '缺少课程名称。');
    else if (!dayResult.ok) rejection(diag, dayResult.reasonCode, dayResult.humanReadableReason);
    else if (!sectionResult.ok) rejection(diag, sectionResult.reasonCode, sectionResult.humanReadableReason);
    else if (!weekResult.ok) rejection(diag, weekResult.reasonCode, weekResult.humanReadableReason);

    for (const warning of weekResult.warnings) warnings.push({ ...warning, candidateId });
    if (diag.result !== 'accepted') {
      filtered += 1;
      errors.push({ reasonCode: diag.reasonCode, message: diag.humanReadableReason, candidateId });
      diagnostics.push(diag);
      return;
    }

    recognized += 1;
    const adjusted = /调|tk|adjust/i.test(`${source} ${item.tkbz || ''} ${item.bz || ''} ${name}`);
    const storedName = adjusted && !name.includes('调') ? `【调】${name}` : name;
    for (const slot of sectionResult.slots) {
      generated.push({
        userId: context.userId || '',
        accountId: context.accountId || '',
        day: dayResult.day,
        slot,
        startSlot: sectionResult.startSlot,
        endSlot: sectionResult.endSlot,
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
        termKey: `${context.xnm || ''}:${context.xqm || ''}`,
        xnm: String(context.xnm || ''),
        xqm: String(context.xqm || ''),
        isAdjusted: adjusted,
        importTraceId: context.traceId || '',
        _candidateId: candidateId
      });
    }
    diag.producedCourseCount = sectionResult.slots.length;
    diagnostics.push(diag);
  });

  if (collected.truncated) warnings.push({ reasonCode: IMPORT_REASON_CODES.UNSUPPORTED_STRUCTURE, message: '候选数量超过安全上限，诊断已截断。' });
  const parsingMs = elapsed(parsingStart);
  const mergeStart = nowMs();
  const mergeResult = mergeCourseRecords(generated);
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
        : '与同课程其他周次安全合并。';
    }
  }

  const accepted = generated.length;
  const summary = {
    received: collected.candidates.length,
    recognized,
    accepted,
    filtered,
    merged: mergeResult.events.length,
    written: mergeResult.courses.length,
    beforeCount: 0,
    afterCount: 0
  };
  return {
    rawResponseType: collected.rawResponseType,
    candidateSources: Object.keys(collected.sourceCounts),
    sourceCounts: collected.sourceCounts,
    candidates: diagnostics,
    courses: mergeResult.courses.map(({ _candidateId, ...course }) => course),
    mergeEvents: mergeResult.events,
    summary,
    warnings,
    errors,
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
