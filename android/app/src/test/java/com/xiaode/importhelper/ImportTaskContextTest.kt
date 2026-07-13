package com.xiaode.importhelper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ImportTaskContextTest {
    @Test
    fun frozenContextDoesNotFollowLaterActiveAccountChanges() {
        var activeAccountId = "account-a"
        var editableXnm = "2026"
        var editableXqm = "3"
        var selectedTermLabel = "2026-2027 第一学期"
        val frozen = ImportTaskContext(
            serverBaseUrl = "http://127.0.0.1:3001",
            importCode = "ABCDEF12",
            accountId = activeAccountId,
            selectedTermLabel = selectedTermLabel,
            xnm = editableXnm,
            xqm = editableXqm,
            replace = true,
            createdAt = 1L
        )
        activeAccountId = "account-b"
        editableXnm = "2030"
        editableXqm = "12"
        selectedTermLabel = "2030-2031 第二学期"
        assertEquals("account-a", frozen.accountId)
        assertEquals("2026-2027 第一学期", frozen.selectedTermLabel)
        assertEquals("2026", frozen.xnm)
        assertEquals("3", frozen.xqm)
        assertNotEquals(activeAccountId, frozen.accountId)
        assertNotEquals(editableXnm, frozen.xnm)
        assertNotEquals(editableXqm, frozen.xqm)
        assertNotEquals(selectedTermLabel, frozen.selectedTermLabel)
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
            createdAt = 2L
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
}
