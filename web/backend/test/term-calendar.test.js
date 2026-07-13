import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve('..', 'frontend', 'public', 'term-calendar.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const calendar = sandbox.XiaoDeTermCalendar;

function state(today, termStart = '2026-09-07', totalWeeks = 20, displayedWeek = null) {
  return calendar.getTermCalendarState({ today, termStart, totalWeeks, displayedWeek });
}

test('unknown termStart permits week-one preview without inventing actualWeek or today', () => {
  for (const termStart of ['', '2026-09-01', '2026-02-31', 'not-a-date']) {
    const unknown = state('2026-09-07', termStart);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.actualWeek, null);
    assert.equal(unknown.displayedWeek, 1);
    assert.equal(unknown.todayInDisplayedWeek, false);
    assert.equal(unknown.displayedWeekStart, null);
    assert.equal(calendar.dateForDisplayedDay(unknown, 1), null);
  }
  assert.equal(state('2026-09-07', '', 20, 4).displayedWeek, 4, 'unknown state still allows explicit preview navigation');
});

test('known Monday termStart distinguishes before, active and after term', () => {
  const before = state('2026-09-01');
  assert.deepEqual(
    { status: before.status, actualWeek: before.actualWeek, displayedWeek: before.displayedWeek, today: before.todayInDisplayedWeek, days: before.daysUntilStart },
    { status: 'before-term', actualWeek: 0, displayedWeek: 1, today: false, days: 6 }
  );

  const firstMonday = state('2026-09-07');
  assert.equal(firstMonday.status, 'active');
  assert.equal(firstMonday.actualWeek, 1);
  assert.equal(firstMonday.todayInDisplayedWeek, true);
  assert.equal(state('2026-09-13').actualWeek, 1);
  assert.equal(state('2026-09-14').actualWeek, 2);

  const after = state('2027-02-01');
  assert.equal(after.status, 'after-term');
  assert.ok(after.actualWeek > after.totalWeeks);
  assert.equal(after.displayedWeek, 20);
  assert.equal(after.todayInDisplayedWeek, false);
});

test('preview and actual week are independent and only actual displayed week can be today', () => {
  const preview = state('2026-09-23', '2026-09-07', 20, 1);
  assert.equal(preview.actualWeek, 3);
  assert.equal(preview.displayedWeek, 1);
  assert.equal(preview.todayInDisplayedWeek, false);
  assert.equal(state('2026-09-23', '2026-09-07', 20, 3).todayInDisplayedWeek, true);
});

test('weekday dates use local calendar days across month, year and leap day', () => {
  const crossYear = state('2026-12-28', '2026-12-28', 18, 1);
  assert.equal(calendar.formatMonthDay(calendar.dateForDisplayedDay(crossYear, 1)), '12/28');
  assert.equal(calendar.formatMonthDay(calendar.dateForDisplayedDay(crossYear, 7)), '01/03');

  const leap = state('2028-02-28', '2028-02-28', 20, 1);
  assert.equal(calendar.formatMonthDay(calendar.dateForDisplayedDay(leap, 2)), '02/29');
  assert.equal(calendar.localDayOrdinal('2028-03-01') - calendar.localDayOrdinal('2028-02-28'), 2);
});
