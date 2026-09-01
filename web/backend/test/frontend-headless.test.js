import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const edgePath = edgeCandidates.find((candidate) => fs.existsSync(candidate));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(predicate, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
  });
  return {
    socket,
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

function seedDb() {
  return {
    meta: { totalWeeks: 20, termStart: '2026-02-23' },
    slots: [],
    users: [
      {
        id: 'headless-user', accountId: 'headless-account', username: 'headless', password: 'headless-pass',
        name: 'Headless', role: 'user', switchKey: 'headless-switch', preferences: { courseSettings: {} }
      },
      {
        id: 'headless-user-b', accountId: 'headless-account-b', username: 'headless-b', password: 'headless-pass-b',
        name: 'Headless B', role: 'user', switchKey: 'headless-switch-b', preferences: { courseSettings: {} }
      }
    ],
    accounts: [
      { id: 'headless-account', userId: 'headless-user', username: 'headless', name: 'Headless', role: 'user', status: 'active' },
      { id: 'headless-account-b', userId: 'headless-user-b', username: 'headless-b', name: 'Headless B', role: 'user', status: 'active' }
    ],
    settings: [],
    reminders: [],
    courses: [{
      id: 'headless-range', userId: 'headless-user', accountId: 'headless-account', day: 1,
      slot: 1, startSlot: 1, endSlot: 2, name: 'Range Course', location: '', room: 'Room 0411',
      weeks: Array.from({ length: 20 }, (_, index) => index + 1), source: 'manual'
    }],
    sessions: [], feedbacks: [], importCodes: [], backups: []
  };
}

test('portrait Web timetable renders one spanning DOM and persists the section-range switch', {
  skip: !edgePath || typeof WebSocket === 'undefined'
}, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaode-headless-'));
  const dataFile = path.join(tempDir, 'db.json');
  const profileDir = path.join(tempDir, 'edge-profile');
  fs.writeFileSync(dataFile, JSON.stringify(seedDb(), null, 2), 'utf8');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const backend = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, NODE_ENV: 'test', XIAODE_DATA_FILE: dataFile, XIAODE_STORAGE: 'json', PORT: String(port) },
    stdio: 'ignore'
  });
  const edge = spawn(edgePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'
  ], { stdio: 'ignore' });
  let cdp = null;
  t.after(async () => {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch {}
      try { cdp.socket.close(); } catch {}
      // Edge acknowledges Browser.close before all profile-holding subprocesses have exited on Windows.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (edge.exitCode === null) edge.kill();
    if (backend.exitCode === null) backend.kill();
    await Promise.all([
      new Promise((resolve) => edge.exitCode === null ? edge.once('exit', resolve) : resolve()),
      new Promise((resolve) => backend.exitCode === null ? backend.once('exit', resolve) : resolve())
    ]);
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  await waitFor(async () => {
    try { return (await fetch(`${baseUrl}/api/health`)).ok; } catch { return false; }
  }, 'backend health timeout');
  const activePortFile = path.join(profileDir, 'DevToolsActivePort');
  const debugPort = await waitFor(() => {
    if (!fs.existsSync(activePortFile)) return 0;
    return Number(fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0]) || 0;
  }, 'Edge DevTools port timeout');
  const page = await waitFor(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return pages.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl) || null;
    } catch { return null; }
  }, 'Edge page target timeout');
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 }
  });
  await cdp.send('Page.navigate', { url: baseUrl });
  await waitFor(async () => {
    const result = await cdp.send('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
    return result.result?.value === baseUrl;
  }, 'frontend navigation timeout');
  await cdp.send('Runtime.evaluate', {
    expression: `(async()=>{const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'headless',password:'headless-pass'})});const data=await response.json();localStorage.setItem('courseTableUserToken',data.token);localStorage.setItem('headlessTestTokenA',data.token);localStorage.setItem('xiaodeCurrentAccountId',data.accountId);return data.ok;})()`,
    awaitPromise: true,
    returnByValue: true
  });
  await cdp.send('Page.reload', { ignoreCache: true });

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'browser evaluation failed');
    return result.result?.value;
  };
  await waitFor(async () => (await evaluate(`document.querySelectorAll('.logical-range-component .course[title="Range Course"]').length`)) === 1, 'logical course DOM timeout');
  const compact = await evaluate(`(()=>{const cards=[...document.querySelectorAll('.logical-range-component .course[title="Range Course"]')];const card=cards[0];const parent=card.parentElement;return {cardCount:cards.length,gridRow:parent.style.gridRow,nameCount:(card.textContent.match(/Range Course/g)||[]).length,locationCount:(card.textContent.match(/Room 0411/g)||[]).length,sectionCount:(card.textContent.match(/1-2/g)||[]).length,timeCells:document.querySelectorAll('.timecell').length,firstTime:document.querySelector('.timecell')?.textContent||'',tableSize:document.body.dataset.tableSize};})()`);
  assert.deepEqual(compact, {
    cardCount: 1,
    gridRow: '2 / span 2',
    nameCount: 1,
    locationCount: 1,
    sectionCount: 0,
    timeCells: 12,
    firstTime: '第1节08:00-08:45',
    tableSize: 'screenshot'
  });

  const importWhileUnknown = await evaluate(`(async()=>{const response=await fetch('/api/my/import',{method:'POST',headers:{'content-type':'application/json','x-user-token':state.token},body:JSON.stringify({replace:false,courses:[{name:'Unknown Term Import',day:7,slot:12,weeks:[1]}]})});return {status:response.status,body:await response.json()};})()`);
  assert.equal(importWhileUnknown.status, 200);
  assert.equal(importWhileUnknown.body.ok, true);

  const unknownState = await evaluate(`(()=>{state.previewWeek=4;renderAll();showTodayCourses();const payload=buildWidgetPayload();return {status:getTermCalendarStateForUi().status,actualWeek:getWeek(),displayedWeek:getSelectedWeek(),todayHeads:document.querySelectorAll('.head.today').length,datedHeads:[...document.querySelectorAll('.day-sub')].filter(node=>/\\d{2}\\/\\d{2}/.test(node.textContent)).length,weekTitle:document.querySelector('#weekTitle')?.textContent||'',statusPill:document.querySelector('#statusPill')?.textContent||'',toast:document.querySelector('#toast')?.textContent||'',widgetStatus:payload.meta.termStartStatus,widgetWeek:payload.meta.currentWeek,widgetWeeksReliable:payload.meta.totalWeeksReliable};})()`);
  assert.deepEqual(unknownState, {
    status: 'unknown',
    actualWeek: null,
    displayedWeek: 4,
    todayHeads: 0,
    datedHeads: 0,
    weekTitle: '预览第 4 周 · 历史课程',
    statusPill: '开学日期待确认',
    toast: '开学日期尚未确认，暂时无法定位今天的课程',
    widgetStatus: 'unknown',
    widgetWeek: null,
    widgetWeeksReliable: false
  });

  const termSetting = await evaluate(`(async()=>{const invalid=await fetch('/api/my/active-term/settings',{method:'PUT',headers:{'content-type':'application/json','x-user-token':state.token},body:JSON.stringify({totalWeeks:20,termStart:'2099-01-06'})});const valid=await fetch('/api/my/active-term/settings',{method:'PUT',headers:{'content-type':'application/json','x-user-token':state.token},body:JSON.stringify({totalWeeks:20,termStart:'2099-01-05'})});const data=await valid.json();state.activeTerm=data.activeTerm;state.previewWeek=null;renderAll();const known={status:getTermCalendarStateForUi().status,serverStatus:data.activeTerm.termStartStatus,serverWeek:data.activeTerm.actualWeek,actualWeek:getWeek(),todayHeads:document.querySelectorAll('.head.today').length,firstDate:document.querySelector('.day-sub')?.textContent||''};const cleared=await fetch('/api/my/active-term/settings',{method:'PUT',headers:{'content-type':'application/json','x-user-token':state.token},body:JSON.stringify({totalWeeks:20,termStart:''})});const clearedData=await cleared.json();state.activeTerm=clearedData.activeTerm;state.previewWeek=null;renderAll();return {invalidStatus:invalid.status,validStatus:valid.status,clearStatus:cleared.status,known,clearedState:getTermCalendarStateForUi().status,clearedServerState:clearedData.activeTerm.termStartStatus};})()`);
  assert.deepEqual(termSetting, {
    invalidStatus: 400,
    validStatus: 200,
    clearStatus: 200,
    known: { status: 'before-term', serverStatus: 'before-term', serverWeek: 0, actualWeek: 0, todayHeads: 0, firstDate: '01/05' },
    clearedState: 'unknown',
    clearedServerState: 'unknown'
  });
  await evaluate(`saveCourseSettings({...state.courseSettings,showSectionRange:true});renderAll();true`);
  const enabled = await evaluate(`(()=>{const cards=[...document.querySelectorAll('.logical-range-component .course[title="Range Course"]')];return {cardCount:cards.length,gridRow:cards[0].parentElement.style.gridRow,sectionCount:(cards[0].textContent.match(/1-2/g)||[]).length};})()`);
  assert.deepEqual(enabled, { cardCount: 1, gridRow: '2 / span 2', sectionCount: 1 });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(async () => (await evaluate(`document.querySelectorAll('.logical-range-component .course[title="Range Course"] .course-section').length`)) === 1, 'section setting reload timeout');
  assert.equal(await evaluate(`document.querySelectorAll('.logical-range-component .course[title="Range Course"]').length`), 1);

  const switchedToB = await evaluate(`(async()=>{const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'headless-b',password:'headless-pass-b'})});const data=await response.json();await switchToSavedAccount({token:data.token,accountId:data.accountId,userId:data.user.id,username:data.user.username,name:data.user.name},null);return {accountId:state.accountId,showSectionRange:state.courseSettings.showSectionRange};})()`);
  assert.deepEqual(switchedToB, { accountId: 'headless-account-b', showSectionRange: false });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    screenOrientation: { type: 'landscapePrimary', angle: 90 }
  });
  await cdp.send('Page.reload', { ignoreCache: true });
  const desktopDefault = await waitFor(async () => {
    const value = await evaluate(`typeof state==='undefined'?null:{accountId:state.accountId,tableSize:state.tableSize,showTeacher:state.courseSettings.showTeacher,showSectionRange:state.courseSettings.showSectionRange}`);
    return value?.accountId === 'headless-account-b' && value?.tableSize === 'classic' ? value : null;
  }, 'desktop default reload timeout');
  assert.deepEqual(desktopDefault, { accountId: 'headless-account-b', tableSize: 'classic', showTeacher: true, showSectionRange: true });
  const switchedBackToA = await evaluate(`(async()=>{await switchToSavedAccount({token:localStorage.getItem('headlessTestTokenA'),accountId:'headless-account',userId:'headless-user',username:'headless',name:'Headless'},null);return {accountId:state.accountId,showSectionRange:state.courseSettings.showSectionRange,cardCount:document.querySelectorAll('.logical-range-component .course[title="Range Course"]').length};})()`);
  assert.deepEqual(switchedBackToA, { accountId: 'headless-account', showSectionRange: true, cardCount: 1 });
});
