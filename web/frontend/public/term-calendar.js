(function installTermCalendar(root) {
  const DAY_MS = 86_400_000;

  function normalizeTotalWeeks(value) {
    const weeks = Number(value);
    return Number.isInteger(weeks) && weeks >= 1 && weeks <= 60 ? weeks : 20;
  }

  function localDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }
    const match = String(value || '').trim().match(/^(20\d{2})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const result = new Date(year, month - 1, day);
    result.setHours(0, 0, 0, 0);
    if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day) return null;
    return result;
  }

  // termStart 的业务含义固定为第一教学周周一，其他星期视为尚未确认。
  function validTermStart(value) {
    const date = localDate(value);
    return date && date.getDay() === 1 ? date : null;
  }

  // 使用本地年月日生成连续日序号，避免夏令时造成 23/25 小时日差。
  function localDayOrdinal(value) {
    const date = localDate(value);
    return date ? Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS) : null;
  }

  function addLocalDays(value, days) {
    const date = localDate(value);
    if (!date) return null;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + Number(days || 0));
  }

  function weekdayIndex(value) {
    const date = localDate(value);
    if (!date) return 0;
    return date.getDay() === 0 ? 7 : date.getDay();
  }

  function getTermCalendarState({ today = new Date(), termStart = '', totalWeeks = 20, displayedWeek = null } = {}) {
    const normalizedToday = localDate(today) || localDate(new Date());
    const start = validTermStart(termStart);
    const weeks = normalizeTotalWeeks(totalWeeks);
    const requested = Number(displayedWeek);
    const hasRequested = Number.isInteger(requested) && requested >= 1;
    const preview = (fallback) => Math.max(1, Math.min(weeks, hasRequested ? requested : fallback));

    if (!start) {
      return {
        status: 'unknown',
        actualWeek: null,
        displayedWeek: preview(1),
        totalWeeks: weeks,
        termStartDate: null,
        displayedWeekStart: null,
        displayedWeekEnd: null,
        todayInDisplayedWeek: false,
        todayDayIndex: weekdayIndex(normalizedToday),
        daysUntilStart: null,
        daysAfterEnd: null
      };
    }

    const todayOrdinal = localDayOrdinal(normalizedToday);
    const startOrdinal = localDayOrdinal(start);
    const daysSinceStart = todayOrdinal - startOrdinal;
    const rawWeek = Math.floor(daysSinceStart / 7) + 1;
    const status = daysSinceStart < 0 ? 'before-term' : (rawWeek > weeks ? 'after-term' : 'active');
    const actualWeek = status === 'before-term' ? 0 : rawWeek;
    const displayed = preview(status === 'before-term' ? 1 : (status === 'after-term' ? weeks : rawWeek));
    const displayedWeekStart = addLocalDays(start, (displayed - 1) * 7);
    const displayedWeekEnd = addLocalDays(displayedWeekStart, 6);
    const todayInDisplayedWeek = status === 'active' && displayed === actualWeek;
    const endOrdinal = startOrdinal + weeks * 7 - 1;

    return {
      status,
      actualWeek,
      displayedWeek: displayed,
      totalWeeks: weeks,
      termStartDate: start,
      displayedWeekStart,
      displayedWeekEnd,
      todayInDisplayedWeek,
      todayDayIndex: weekdayIndex(normalizedToday),
      daysUntilStart: status === 'before-term' ? -daysSinceStart : 0,
      daysAfterEnd: status === 'after-term' ? todayOrdinal - endOrdinal : 0
    };
  }

  function dateForDisplayedDay(calendarState, day) {
    const weekday = Number(day);
    if (!calendarState?.displayedWeekStart || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
    return addLocalDays(calendarState.displayedWeekStart, weekday - 1);
  }

  function formatMonthDay(value) {
    const date = localDate(value);
    if (!date) return '';
    return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  }

  root.XiaoDeTermCalendar = Object.freeze({
    localDate,
    validTermStart,
    localDayOrdinal,
    addLocalDays,
    getTermCalendarState,
    dateForDisplayedDay,
    formatMonthDay
  });
}(globalThis));
