package com.xiaode.importhelper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.util.GregorianCalendar

class ImportTaskContextTest {
    private fun localDate(year: Int, month: Int, day: Int) = GregorianCalendar(year, month - 1, day)

    @Test
    fun frozenContextDoesNotFollowLaterActiveAccountChanges() {
        var activeAccountId = "account-a"
        var editableXnm = "2026"
        var editableXqm = "3"
        var selectedTermLabel = "2026-2027 第一学期"
        var selectedScheduleTemplateId = "school-a-v1"
        val frozen = ImportTaskContext(
            serverBaseUrl = "http://127.0.0.1:3001",
            importCode = "ABCDEF12",
            accountId = activeAccountId,
            selectedTermLabel = selectedTermLabel,
            xnm = editableXnm,
            xqm = editableXqm,
            replace = true,
            createdAt = 1L,
            scheduleTemplateId = selectedScheduleTemplateId
        )
        activeAccountId = "account-b"
        editableXnm = "2030"
        editableXqm = "12"
        selectedTermLabel = "2030-2031 第二学期"
        selectedScheduleTemplateId = "school-b-v1"
        assertEquals("account-a", frozen.accountId)
        assertEquals("2026-2027 第一学期", frozen.selectedTermLabel)
        assertEquals("2026", frozen.xnm)
        assertEquals("3", frozen.xqm)
        assertEquals("school-a-v1", frozen.scheduleTemplateId)
        assertNotEquals(activeAccountId, frozen.accountId)
        assertNotEquals(editableXnm, frozen.xnm)
        assertNotEquals(editableXqm, frozen.xqm)
        assertNotEquals(selectedTermLabel, frozen.selectedTermLabel)
        assertNotEquals(selectedScheduleTemplateId, frozen.scheduleTemplateId)
    }

    @Test
    fun persistedContextRestoresTheExactSelectedTermWithoutDefaults() {
        val original = ImportTaskContext(
            serverBaseUrl = "http://127.0.0.1:3001",
            importCode = "TERMTEST",
            accountId = "account-a",
            selectedTermLabel = "2024-2025 第一学期",
            xnm = "2024",
            xqm = "3",
            replace = true,
            createdAt = 2L,
            scheduleTemplateId = "school-b-v1"
        )
        val restored = ImportTaskContext.restore(original.persistedFields(), original.replace, original.createdAt)
        assertEquals(original, restored)
        assertEquals(null, ImportTaskContext.restore(original.persistedFields() - "xqm", true, 2L))
    }

    @Test
    fun widgetCourseScopeRequiresTheExactActiveTermKey() {
        assertEquals(true, belongsToActiveTerm("account-a:2025:3", "account-a:2025:3"))
        assertEquals(false, belongsToActiveTerm("account-a:2025:12", "account-a:2025:3"))
        assertEquals(false, belongsToActiveTerm("account-b:2025:3", "account-a:2025:3"))
        assertEquals(false, belongsToActiveTerm("", "account-a:2025:3"))
    }

    @Test
    fun widgetCourseRangeUsesNewFieldsAndFallsBackToLegacySlot() {
        assertEquals(CourseSlotRange(3, 3), normalizeCourseSlotRange(3, null, null))
        assertEquals(CourseSlotRange(1, 2), normalizeCourseSlotRange(9, 1, 2))
        assertEquals(CourseSlotRange(4, 6), normalizeCourseSlotRange(4, 6, 4))
        assertEquals(CourseSlotRange(2, 2), normalizeCourseSlotRange(2, 0, -1))
        assertEquals(CourseSlotRange(4, 4), normalizeCourseSlotRange(4, 13, 99))
    }

    @Test
    fun widgetCourseRangeCoversFromFirstSectionStartThroughLastSectionEnd() {
        val slots = mapOf(
            1 to (8 * 60..8 * 60 + 45),
            2 to (8 * 60 + 55..9 * 60 + 40),
            3 to (10 * 60..10 * 60 + 45)
        )
        val range = courseMinuteRange(CourseSlotRange(1, 2), slots)
        assertEquals((8 * 60)..(9 * 60 + 40), range)
        assertEquals(true, range?.contains(9 * 60 + 30))
        assertEquals(false, range?.contains(10 * 60))
        assertEquals(null, courseMinuteRange(CourseSlotRange(1, 4), slots))
        assertEquals("第1-2节", courseSectionLabel(CourseSlotRange(1, 2)))
        assertEquals("第3节", courseSectionLabel(CourseSlotRange(3, 3)))
    }

    @Test
    fun widgetDropsOnlyExactLogicalRangeDuplicates() {
        val base = WidgetUpdater.Course(
            termKey = "account-a:2025:3",
            name = "Range Course",
            teacher = "Teacher A",
            location = "Room 0411",
            day = 3,
            startSlot = 1,
            endSlot = 2,
            weeks = setOf(1, 2),
            oddEven = "all"
        )
        val duplicateWithWhitespace = base.copy(name = "  Range   Course  ", location = " Room 0411 ")
        val differentWeeks = base.copy(weeks = setOf(3, 4))

        val result = WidgetUpdater.deduplicateCourses(listOf(base, duplicateWithWhitespace, differentWeeks))
        assertEquals(2, result.size)
        assertEquals(base, result[0])
        assertEquals(differentWeeks, result[1])
    }

    @Test
    fun unknownTermStartNeverCreatesActualWeekOrTodayCourse() {
        val unknown = getTermCalendarState("", 20, localDate(2026, 9, 7))
        assertEquals(TermCalendarStatus.UNKNOWN, unknown.status)
        assertEquals(null, unknown.actualWeek)
        assertEquals(1, unknown.displayedWeek)
        assertEquals(false, unknown.todayInDisplayedWeek)

        val nonMonday = getTermCalendarState("2026-09-01", 20, localDate(2026, 9, 7))
        assertEquals(TermCalendarStatus.UNKNOWN, nonMonday.status)
        assertEquals(null, nonMonday.actualWeek)
    }

    @Test
    fun knownTermStartDistinguishesBeforeActiveAndAfter() {
        val before = getTermCalendarState("2026-09-07", 20, localDate(2026, 9, 1))
        assertEquals(TermCalendarStatus.BEFORE_TERM, before.status)
        assertEquals(0, before.actualWeek)
        assertEquals(false, before.todayInDisplayedWeek)
        assertEquals(6, before.daysUntilStart)

        val firstDay = getTermCalendarState("2026-09-07", 20, localDate(2026, 9, 7))
        assertEquals(TermCalendarStatus.ACTIVE, firstDay.status)
        assertEquals(1, firstDay.actualWeek)
        assertEquals(true, firstDay.todayInDisplayedWeek)
        assertEquals(1, getTermCalendarState("2026-09-07", 20, localDate(2026, 9, 13)).actualWeek)
        assertEquals(2, getTermCalendarState("2026-09-07", 20, localDate(2026, 9, 14)).actualWeek)

        val after = getTermCalendarState("2026-09-07", 20, localDate(2027, 2, 1))
        assertEquals(TermCalendarStatus.AFTER_TERM, after.status)
        assertEquals(20, after.displayedWeek)
        assertEquals(false, after.todayInDisplayedWeek)

        val uncertainEnd = getTermCalendarState(
            "2026-09-07",
            16,
            localDate(2027, 1, 25),
            totalWeeksReliable = false
        )
        assertEquals(TermCalendarStatus.ACTIVE, uncertainEnd.status)
        assertEquals(21, uncertainEnd.actualWeek)
        assertEquals(21, uncertainEnd.displayedWeek)
        assertEquals(true, uncertainEnd.todayInDisplayedWeek)
    }

    @Test
    fun previewWeekDoesNotBecomeTodayWhenActualWeekDiffers() {
        val preview = getTermCalendarState("2026-09-07", 20, localDate(2026, 9, 23), 1)
        assertEquals(3, preview.actualWeek)
        assertEquals(1, preview.displayedWeek)
        assertEquals(false, preview.todayInDisplayedWeek)
    }
}
