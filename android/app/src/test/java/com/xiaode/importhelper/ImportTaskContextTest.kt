package com.xiaode.importhelper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ImportTaskContextTest {
    @Test
    fun frozenContextDoesNotFollowLaterActiveAccountChanges() {
        var activeAccountId = "account-a"
        var editableXnm = "2026"
        val frozen = ImportTaskContext(
            serverBaseUrl = "http://127.0.0.1:3001",
            importCode = "ABCDEF12",
            accountId = activeAccountId,
            xnm = editableXnm,
            xqm = "12",
            replace = true,
            createdAt = 1L
        )
        activeAccountId = "account-b"
        editableXnm = "2030"
        assertEquals("account-a", frozen.accountId)
        assertEquals("2026", frozen.xnm)
        assertNotEquals(activeAccountId, frozen.accountId)
        assertNotEquals(editableXnm, frozen.xnm)
    }
}

