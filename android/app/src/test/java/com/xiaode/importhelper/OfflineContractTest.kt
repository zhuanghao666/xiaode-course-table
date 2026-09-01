package com.xiaode.importhelper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class OfflineContractTest {
    @Test
    fun schoolTemplatesKeepSourceSlotsSeparateFromDisplayRows() {
        val schoolA = ScheduleTemplateDefaults.schoolADefinitions()
        val schoolB = ScheduleTemplateDefaults.schoolBDefinitions()

        val aSource5 = schoolA.find { it.sourceSlot == 5 }!!
        val aSource6 = schoolA.find { it.sourceSlot == 6 }!!
        val bSource5 = schoolB.find { it.sourceSlot == 5 }!!

        assertNull(aSource5.displayNumber)
        assertEquals("MIDDAY_EXTENSION", aSource5.kind)
        assertEquals("AUTO", aSource5.visibilityPolicy)
        assertEquals(5, aSource6.displayNumber)
        assertEquals(6, aSource6.logicalOrder)
        assertEquals("P5", aSource6.slotKey)
        assertEquals(5, bSource5.displayNumber)
        assertEquals(5, bSource5.logicalOrder)
        assertNull(schoolA.find { it.sourceSlot == 99 })
    }

    @Test
    fun outboxOrderingIsDeterministicAndTokensAreOnlyHashed() {
        fun mutation(id: String, createdAt: Long) = PendingMutationEntity(
            operationId = id,
            accountId = "a",
            entityType = "COURSE",
            operationType = "UPDATE",
            payloadJson = "{}",
            createdAt = createdAt
        )
        val ordered = OfflineContract.orderedForPush(listOf(
            mutation("op-c", 2), mutation("op-b", 1), mutation("op-a", 1)
        ))
        assertEquals(listOf("op-a", "op-b", "op-c"), ordered.map { it.operationId })
        val raw = "secret-session-token"
        val hash = OfflineContract.tokenHash(raw)
        assertFalse(hash.contains(raw))
        assertEquals(64, hash.length)
        assertNotEquals(hash, OfflineContract.tokenHash("another-token"))
        assertEquals("", OfflineContract.tokenHash(OfflineContract.NATIVE_SESSION_TOKEN))
    }

    @Test
    fun dirtyPullProtectionIsAccountAndTermScoped() {
        val dirty = PendingMutationEntity(
            operationId = "op-dirty",
            accountId = "account-a",
            termKey = "term-a",
            entityType = "COURSE",
            entityLocalId = "local-a",
            serverId = "server-a",
            operationType = "UPDATE",
            payloadJson = "{}",
            createdAt = 1
        )
        assertFalse(OfflineMergePolicy.shouldReplaceCourse("account-a", "local-a", "server-a", listOf(dirty)))
        assertTrue(OfflineMergePolicy.shouldReplaceCourse("account-b", "local-a", "server-a", listOf(dirty)))
        assertEquals(1, OfflineMergePolicy.pendingForScope(listOf(dirty), "account-a", "term-a").size)
        assertEquals(0, OfflineMergePolicy.pendingForScope(listOf(dirty), "account-a", "term-b").size)
        assertFalse(OfflineMergePolicy.mayPull(1))
        assertTrue(OfflineMergePolicy.mayPull(0))
    }

    @Test
    fun termStartMustBeBlankOrAnActualMonday() {
        assertTrue(OfflineContract.isValidMondayTermStart(""))
        assertTrue(OfflineContract.isValidMondayTermStart("2026-09-07"))
        assertFalse(OfflineContract.isValidMondayTermStart("2026-09-08"))
        assertFalse(OfflineContract.isValidMondayTermStart("2026-02-30"))
        assertFalse(OfflineContract.isValidMondayTermStart("09/07/2026"))
    }

    @Test
    fun widgetUsesTemplateDisplayNumbersInsteadOfLogicalRowIndexes() {
        val schoolAP5 = WidgetUpdater.Slot(6, "第5节", "14:00-14:45", "14:00", "14:45", 5, "P5")
        val schoolAP6 = WidgetUpdater.Slot(7, "第6节", "14:50-15:35", "14:50", "15:35", 6, "P6")
        val midday = WidgetUpdater.Slot(5, "午间加时", "11:45-12:30", "11:45", "12:30", null, "MIDDAY_1")
        assertEquals("第5节", WidgetUpdater.templateSectionLabel(schoolAP5, schoolAP5))
        assertEquals("第5-6节", WidgetUpdater.templateSectionLabel(schoolAP5, schoolAP6))
        assertEquals("午间加时", WidgetUpdater.templateSectionLabel(midday, midday))
        assertEquals("午间加时–第5节", WidgetUpdater.templateSectionLabel(midday, schoolAP5))
    }

    @Test
    fun weekTextCreatesStableWeeksForOfflineCourses() {
        assertEquals((1..3).toList() + (5..16).toList(), OfflineContract.normalizeWeeks(emptyList(), "1-3周,5-16周"))
        assertEquals(listOf(1, 3, 5), OfflineContract.normalizeWeeks(emptyList(), "第1、3、5周"))
        assertEquals(listOf(2, 4), OfflineContract.normalizeWeeks(listOf(4, 2, 4, 99), "1-20周"))
    }

    @Test
    fun exportedRoomSchemaContainsOfflineAndConflictTables() {
        val root = File(System.getProperty("user.dir") ?: ".")
        val bases = generateSequence(root) { it.parentFile }.take(6).toList()
        val candidates = bases.flatMap { base -> listOf(
            File(base, "schemas/com.xiaode.importhelper.XiaoDeDatabase/2.json"),
            File(base, "app/schemas/com.xiaode.importhelper.XiaoDeDatabase/2.json"),
            File(base, "android/app/schemas/com.xiaode.importhelper.XiaoDeDatabase/2.json")
        ) }
        val schema = candidates.firstOrNull { it.isFile }?.readText()
            ?: error("Room schema 2.json was not exported")
        for (required in listOf(
            "accounts", "terms", "courses", "slot_templates", "preferences",
            "sync_metadata", "pending_mutations", "sync_conflicts",
            "sourceStartSlot", "scheduleTemplateId", "operationId", "serverJson"
        )) assertTrue("schema missing $required", schema.contains(required))
    }
}
