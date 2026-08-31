package com.xiaode.importhelper

import java.util.Calendar
import java.util.GregorianCalendar
import java.util.TimeZone

/** Widget 和后台刷新只接受当前账号冻结的 activeTermKey。 */
internal fun belongsToActiveTerm(courseTermKey: String, activeTermKey: String): Boolean {
    return activeTermKey.isNotBlank() && courseTermKey == activeTermKey
}

internal enum class TermCalendarStatus {
    UNKNOWN,
    BEFORE_TERM,
    ACTIVE,
    AFTER_TERM
}

internal data class TermCalendarState(
    val status: TermCalendarStatus,
    val actualWeek: Int?,
    val displayedWeek: Int,
    val todayInDisplayedWeek: Boolean,
    val todayDayIndex: Int,
    val daysUntilStart: Int? = null,
    val daysAfterEnd: Int? = null
)

private const val MILLIS_PER_DAY = 86_400_000L

private fun calendarDayOrdinal(calendar: Calendar): Long {
    val utc = GregorianCalendar(TimeZone.getTimeZone("UTC")).apply {
        isLenient = false
        clear()
        set(calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH), calendar.get(Calendar.DAY_OF_MONTH), 0, 0, 0)
    }
    return utc.timeInMillis / MILLIS_PER_DAY
}

private fun termStartDayOrdinal(termStart: String): Long? {
    val match = Regex("^(20\\d{2})-(\\d{2})-(\\d{2})$").matchEntire(termStart.trim()) ?: return null
    return try {
        val utc = GregorianCalendar(TimeZone.getTimeZone("UTC")).apply {
            isLenient = false
            clear()
            set(match.groupValues[1].toInt(), match.groupValues[2].toInt() - 1, match.groupValues[3].toInt(), 0, 0, 0)
        }
        val millis = utc.timeInMillis
        if (utc.get(Calendar.DAY_OF_WEEK) != Calendar.MONDAY) null else millis / MILLIS_PER_DAY
    } catch (_: IllegalArgumentException) {
        null
    }
}

/** actualWeek 只描述现实状态；unknown 不计算，未开学为 0，预览周单独保存。 */
internal fun getTermCalendarState(
    termStart: String,
    totalWeeks: Int,
    today: Calendar,
    requestedDisplayedWeek: Int? = null,
    totalWeeksReliable: Boolean = true
): TermCalendarState {
    val safeTotalWeeks = totalWeeks.coerceIn(1, 60)
    val todayDayIndex = if (today.get(Calendar.DAY_OF_WEEK) == Calendar.SUNDAY) 7 else today.get(Calendar.DAY_OF_WEEK) - 1
    val requested = requestedDisplayedWeek?.coerceIn(1, 60)
    val requestedWithinKnownLimit = requested?.coerceAtMost(safeTotalWeeks)
    val startOrdinal = termStartDayOrdinal(termStart)
        ?: return TermCalendarState(TermCalendarStatus.UNKNOWN, null, requestedWithinKnownLimit ?: 1, false, todayDayIndex)
    val todayOrdinal = calendarDayOrdinal(today)
    val diffDays = (todayOrdinal - startOrdinal).toInt()
    if (diffDays < 0) {
        return TermCalendarState(TermCalendarStatus.BEFORE_TERM, 0, requestedWithinKnownLimit ?: 1, false, todayDayIndex, daysUntilStart = -diffDays)
    }
    val actualWeek = diffDays / 7 + 1
    if (totalWeeksReliable && actualWeek > safeTotalWeeks) {
        val endOrdinal = startOrdinal + safeTotalWeeks * 7L - 1L
        return TermCalendarState(
            TermCalendarStatus.AFTER_TERM,
            actualWeek,
            requested ?: safeTotalWeeks,
            false,
            todayDayIndex,
            daysAfterEnd = (todayOrdinal - endOrdinal).toInt()
        )
    }
    val displayLimitWeeks = if (totalWeeksReliable) safeTotalWeeks else maxOf(safeTotalWeeks, actualWeek, requested ?: 1)
    val displayed = (requested ?: actualWeek).coerceIn(1, displayLimitWeeks)
    return TermCalendarState(TermCalendarStatus.ACTIVE, actualWeek, displayed, displayed == actualWeek, todayDayIndex)
}

/**
 * Widget 对新范围字段和旧版单节 slot 使用同一份归一化规则。
 * 非法的 0/负值回退到旧 slot，倒序范围则安全纠正，避免时间判断越界。
 */
internal data class CourseSlotRange(val startSlot: Int, val endSlot: Int)

internal fun normalizeCourseSlotRange(
    legacySlot: Int,
    startSlot: Int?,
    endSlot: Int?
): CourseSlotRange {
    val fallback = legacySlot.takeIf { it in 1..12 } ?: 1
    val rawStart = startSlot?.takeIf { it in 1..12 } ?: fallback
    val rawEnd = endSlot?.takeIf { it in 1..12 } ?: rawStart
    return CourseSlotRange(
        startSlot = minOf(rawStart, rawEnd),
        endSlot = maxOf(rawStart, rawEnd)
    )
}

/** 返回课程从首节开始到末节结束的完整分钟范围；旧 payload 会自然退化为单节。 */
internal fun courseMinuteRange(
    range: CourseSlotRange,
    slotMinutes: Map<Int, IntRange>
): IntRange? {
    val first = slotMinutes[range.startSlot] ?: return null
    val last = slotMinutes[range.endSlot] ?: return null
    return first.first..last.last
}

internal fun courseSectionLabel(range: CourseSlotRange): String {
    return if (range.startSlot == range.endSlot) {
        "第${range.startSlot}节"
    } else {
        "第${range.startSlot}-${range.endSlot}节"
    }
}
