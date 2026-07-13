import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createImportTraceId } from './import-pipeline.js';

const SENSITIVE_KEY = /password|passwd|pwd|cookie|authorization|(?:^|_)token|sessiontoken|studentid|xuehao|sfzh|idcard|(?:rawresponse|rawpayload|jwxtdata)$/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function safeValue(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => safeValue(item)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = safeValue(childValue, childKey);
    if (sanitized !== undefined) out[childKey] = sanitized;
  }
  return out;
}

function accountRef(accountId) {
  return crypto.createHash('sha256').update(`xiaode-import-diagnostics:${String(accountId || '')}`).digest('hex').slice(0, 24);
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tempFile, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempFile, file);
}

function traceFileName(trace) {
  const stamp = String(trace.createdAt || new Date().toISOString()).replace(/[-:TZ.]/g, '').slice(0, 17);
  return `${stamp}-${trace.traceId}.json`;
}

function summaryOf(trace) {
  return {
    traceId: trace.traceId,
    createdAt: trace.createdAt,
    completedAt: trace.completedAt || null,
    accountRef: trace.accountRef,
    status: trace.status,
    rawResponseType: trace.rawResponseType || null,
    candidateSources: trace.candidateSources || [],
    sourceCounts: trace.sourceCounts || {},
    unknownSourceCounts: trace.unknownSourceCounts || {},
    rawCount: Number(trace.rawCount || 0),
    acceptedCount: Number(trace.acceptedCount || 0),
    filteredWrongTermCount: Number(trace.filteredWrongTermCount || 0),
    filteredUnknownSourceCount: Number(trace.filteredUnknownSourceCount || 0),
    importedCount: Number(trace.importedCount || 0),
    totalWeeks: Number(trace.totalWeeks || 0),
    totalWeeksSource: trace.totalWeeksSource || '',
    summary: trace.summary || {},
    warnings: trace.warnings || [],
    errors: trace.errors || [],
    reasonCode: trace.reasonCode || null,
    message: trace.message || '',
    replace: Boolean(trace.replace),
    selectedTermLabel: trace.selectedTermLabel || '',
    requestedXnm: trace.requestedXnm || '',
    requestedXqm: trace.requestedXqm || '',
    effectiveXnm: trace.effectiveXnm || '',
    effectiveXqm: trace.effectiveXqm || '',
    xnm: trace.xnm || '',
    xqm: trace.xqm || '',
    timings: trace.timings || {}
  };
}

export function createImportDiagnosticsStore(options = {}) {
  const enabledValue = options.enabled ?? process.env.XIAODE_IMPORT_DIAGNOSTICS ?? '';
  const enabled = enabledValue === true || String(enabledValue) === '1';
  const keep = Math.max(1, Math.min(200, Number(options.keep || process.env.XIAODE_IMPORT_DIAGNOSTICS_KEEP || 20)));
  const memoryKeep = Math.max(keep, 50);
  const dataFile = path.resolve(options.dataFile || 'data/db.json');
  const directory = path.resolve(options.directory || path.join(path.dirname(dataFile), 'import-diagnostics'));
  const memory = new Map();

  function diskFiles() {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((name) => /^\d{17}-imp_[A-Za-z0-9_-]+\.json$/.test(name))
      .sort()
      .reverse();
  }

  function cleanup() {
    if (!enabled || !fs.existsSync(directory)) return;
    for (const name of diskFiles().slice(keep)) fs.rmSync(path.join(directory, name), { force: true });
    for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.tmp'))) {
      fs.rmSync(path.join(directory, name), { force: true });
    }
  }

  function remember(trace) {
    memory.set(trace.traceId, trace);
    while (memory.size > memoryKeep) memory.delete(memory.keys().next().value);
  }

  function begin(context = {}) {
    const trace = {
      traceId: createImportTraceId(),
      createdAt: new Date().toISOString(),
      accountRef: accountRef(context.accountId),
      status: 'running',
      replace: Boolean(context.replace),
      selectedTermLabel: String(context.selectedTermLabel || ''),
      requestedXnm: String(context.requestedXnm || context.xnm || ''),
      requestedXqm: String(context.requestedXqm || context.xqm || ''),
      effectiveXnm: '',
      effectiveXqm: '',
      xnm: String(context.xnm || ''),
      xqm: String(context.xqm || ''),
      rawResponseType: context.rawResponseType || null,
      candidateSources: [],
      sourceCounts: {},
      unknownSourceCounts: {},
      rawCount: 0,
      acceptedCount: 0,
      filteredWrongTermCount: 0,
      filteredUnknownSourceCount: 0,
      importedCount: 0,
      totalWeeks: 0,
      totalWeeksSource: '',
      summary: { received: 0, recognized: 0, accepted: 0, filtered: 0, merged: 0, written: 0, beforeCount: 0, afterCount: 0 },
      warnings: [],
      errors: [],
      timings: {}
    };
    remember(trace);
    return clone(trace);
  }

  function finish(trace, patch = {}) {
    const completed = safeValue({ ...trace, ...patch, completedAt: new Date().toISOString() });
    completed.status = patch.status || completed.status || 'success';
    remember(completed);
    if (enabled) {
      cleanup();
      atomicWriteJson(path.join(directory, traceFileName(completed)), completed);
      cleanup();
    }
    return clone(completed);
  }

  function loadDisk() {
    const traces = [];
    for (const name of diskFiles().slice(0, keep)) {
      try {
        const trace = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        if (trace?.traceId) traces.push(trace);
      } catch {}
    }
    return traces;
  }

  function all() {
    const byId = new Map();
    for (const trace of loadDisk()) byId.set(trace.traceId, trace);
    for (const trace of memory.values()) byId.set(trace.traceId, trace);
    return [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function latestForAccount(accountId) {
    const ref = accountRef(accountId);
    const trace = all().find((item) => item.accountRef === ref);
    return trace ? clone(trace) : null;
  }

  function get(traceId) {
    const trace = all().find((item) => item.traceId === traceId);
    return trace ? clone(trace) : null;
  }

  function list(limit = 20) {
    return all().slice(0, Math.max(1, Math.min(100, Number(limit || 20)))).map(summaryOf);
  }

  cleanup();
  return {
    begin,
    finish,
    get,
    list,
    latestForAccount,
    accountRef,
    status: () => ({ enabled, keep, directory: enabled ? directory : null, memoryCount: memory.size, diskCount: enabled ? diskFiles().length : 0 })
  };
}
