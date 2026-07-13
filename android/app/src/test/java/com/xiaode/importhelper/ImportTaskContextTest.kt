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
}
