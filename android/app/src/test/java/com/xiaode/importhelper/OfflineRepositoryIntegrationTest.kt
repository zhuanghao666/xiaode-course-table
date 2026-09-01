package com.xiaode.importhelper

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.Data
import androidx.work.ListenableWorker
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class OfflineRepositoryIntegrationTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        XiaoDeDatabase.resetForTests()
        context.deleteDatabase("xiaode-offline-v2.db")
        context.getSharedPreferences("xiaode_widget_data_v11", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @After
    fun tearDown() {
        XiaoDeDatabase.resetForTests()
        context.deleteDatabase("xiaode-offline-v2.db")
    }

    private suspend fun seedAccount(
        accountId: String = "account-a",
        termKey: String = "$accountId:2026:12",
        current: Boolean = true,
        serverUrl: String = "http://127.0.0.1:3001"
    ): Pair<AccountEntity, TermEntity> {
        val dao = XiaoDeDatabase.get(context).dao()
        val account = AccountEntity(
            accountId = accountId,
            username = accountId,
            name = accountId,
            activeTermKey = termKey,
            isCurrent = current,
            revision = 4,
            updatedAt = "2026-09-01T00:00:00.000Z"
        )
        val term = TermEntity(
            termRowId = OfflineContract.termRowId(accountId, termKey),
            accountId = accountId,
            termKey = termKey,
            selectedTermLabel = "2026-2027 第二学期",
            xnm = "2026",
            xqm = "12",
            totalWeeks = 20,
            scheduleTemplateId = "legacy-default",
            active = true,
            revision = 3,
            updatedAt = account.updatedAt
        )
        dao.upsertAccount(account)
        dao.upsertTerm(term)
        dao.upsertSyncMetadata(SyncMetadataEntity(accountId, serverUrl, "SYNCED"))
        return account to term
    }

    private fun memoryTokenStore(): SessionTokenStore = object : SessionTokenStore {
        private val tokens = mutableMapOf<String, String>()
        override fun put(accountId: String, token: String) { tokens[accountId] = token }
        override fun get(accountId: String): String = tokens[accountId].orEmpty()
        override fun remove(accountId: String) { tokens.remove(accountId) }
    }

    private fun syncWorker(repository: OfflineRepository, accountId: String): XiaoDeSyncWorker =
        TestListenableWorkerBuilder<XiaoDeSyncWorker>(
            context = context,
            inputData = Data.Builder().putString("accountId", accountId).build()
        ).setWorkerFactory(object : WorkerFactory() {
            override fun createWorker(
                appContext: Context,
                workerClassName: String,
                workerParameters: WorkerParameters
            ): ListenableWorker = XiaoDeSyncWorker(appContext, workerParameters, repository)
        }).build()

    @Test
    fun offlineCrudIsImmediateDurableAndCreatesPersistentOutbox() = runBlocking {
        val repository = OfflineRepository(context)
        repository.initialize("http://127.0.0.1:3001")
        val (account, term) = seedAccount()

        val created = repository.createCourse(account, JSONObject()
            .put("name", "离线化工原理")
            .put("location", "求实楼0411")
            .put("day", 2)
            .put("startSlot", 1)
            .put("endSlot", 2)
            .put("weekText", "1-3周,5-16周"))
        val localId = created.getJSONObject("course").getString("localId")
        val dao = XiaoDeDatabase.get(context).dao()
        assertEquals(1, dao.courses(account.accountId, term.termKey).size)
        assertEquals(1, dao.pendingCount(account.accountId))
        assertEquals("[1,2,3,5,6,7,8,9,10,11,12,13,14,15,16]", dao.course(localId)?.weeksJson)

        repository.updateCourse(account, localId, JSONObject()
            .put("location", "求实楼0412")
            .put("weekText", "2-4周"))
        assertEquals("求实楼0412", dao.course(localId)?.location)
        assertEquals("[2,3,4]", dao.course(localId)?.weeksJson)
        assertEquals(2, dao.pendingCount(account.accountId))

        // A new repository instance sees the same Room state, modelling process/UI recreation.
        val reopened = OfflineRepository(context).me(account)
        assertEquals("求实楼0412", reopened.getJSONArray("courses").getJSONObject(0).getString("location"))

        repository.deleteCourse(account, localId)
        assertTrue(dao.courses(account.accountId, term.termKey).isEmpty())
        assertTrue(dao.allCourses(account.accountId).single { it.localId == localId }.isDeleted)
        assertEquals(3, dao.pendingCount(account.accountId))
    }

    @Test
    fun sequentialOfflineEditsAreRebasedInsteadOfSelfConflicting() = runBlocking {
        val repository = OfflineRepository(context)
        repository.initialize("http://127.0.0.1:3001")
        val (account, term) = seedAccount()
        val dao = XiaoDeDatabase.get(context).dao()
        dao.upsertCourse(CourseEntity(
            localId = "local-synced",
            serverId = "server-1",
            clientLocalId = "local-synced",
            accountId = account.accountId,
            termKey = term.termKey,
            name = "化工原理",
            location = "0411",
            day = 1,
            sourceStartSlot = 1,
            sourceEndSlot = 2,
            startSlot = 1,
            endSlot = 2,
            weeksJson = "[1,2]",
            revision = 7
        ))

        repository.updateCourse(account, "local-synced", JSONObject().put("location", "0412"))
        repository.updateCourse(account, "local-synced", JSONObject().put("location", "0413"))
        var pending = repository.pending(account.accountId)
        assertEquals(listOf(7L, 7L), pending.map { it.baseRevision })

        repository.acknowledgeMutation(pending[0], JSONObject().put("serverId", "server-1").put("revision", 8).put("updatedAt", "u8"))
        pending = repository.pending(account.accountId)
        assertEquals(1, pending.size)
        assertEquals(8, pending[0].baseRevision)
        repository.acknowledgeMutation(pending[0], JSONObject().put("serverId", "server-1").put("revision", 9).put("updatedAt", "u9"))
        assertEquals(0, dao.pendingCount(account.accountId))
        assertEquals(9L, dao.course("local-synced")?.revision)
        assertEquals("0413", dao.course("local-synced")?.location)
        assertEquals("SYNCED", dao.course("local-synced")?.syncState)
    }

    @Test
    fun dirtySnapshotMergeAndWidgetStayAccountAndTermScoped() = runBlocking {
        val repository = OfflineRepository(context)
        repository.initialize("http://127.0.0.1:3001")
        val (accountA, termA) = seedAccount()
        val (accountB, termB) = seedAccount("account-b", "account-b:2026:12", current = false, serverUrl = "http://server-b")
        val dao = XiaoDeDatabase.get(context).dao()
        dao.upsertCourse(CourseEntity("a-local", accountA.accountId, termA.termKey, "a-server", "a-local", name = "A 本地", location = "本地0412", day = 1, sourceStartSlot = 1, sourceEndSlot = 1, startSlot = 1, endSlot = 1, weeksJson = "[1]", revision = 2))
        dao.upsertCourse(CourseEntity("b-local", accountB.accountId, termB.termKey, "b-server", "b-local", name = "B 课程", day = 2, sourceStartSlot = 1, sourceEndSlot = 1, startSlot = 1, endSlot = 1, weeksJson = "[1]", revision = 2))
        repository.updateCourse(accountA, "a-local", JSONObject().put("location", "本地0413"))

        repository.applySnapshot(accountA.accountId, JSONObject()
            .put("account", JSONObject().put("activeTermKey", termA.termKey).put("revision", 4))
            .put("user", JSONObject().put("username", "account-a").put("switchKey", "must-not-enter-room"))
            .put("availableTerms", JSONArray().put(LocalJsonMapper.termToJson(termA)))
            .put("courses", JSONArray().put(JSONObject()
                .put("id", "a-server").put("clientLocalId", "a-local").put("termKey", termA.termKey)
                .put("name", "A 服务器").put("location", "服务器旧值").put("day", 1).put("slot", 1).put("weeks", JSONArray().put(1))))
            .put("preferences", JSONObject()), "http://server-a-new")

        assertEquals("本地0413", dao.course("a-local")?.location)
        assertEquals("B 课程", dao.course("b-local")?.name)
        assertEquals("", dao.account(accountA.accountId)?.switchKey)
        assertEquals("http://server-b", dao.syncMetadata(accountB.accountId)?.serverUrl)
        val widget = JSONObject(WidgetDataStore.getPayload(context))
        assertEquals(accountA.accountId, widget.getString("accountId"))
        assertEquals(termA.termKey, widget.getString("activeTermKey"))
        assertEquals(1, widget.getJSONArray("courses").length())
        assertEquals("本地0413", widget.getJSONArray("courses").getJSONObject(0).getString("location"))
    }

    @Test
    fun invalidReplaceImportAndRestoreLeaveExistingCourseUntouched() = runBlocking {
        val repository = OfflineRepository(context)
        repository.initialize("http://127.0.0.1:3001")
        val (account, term) = seedAccount()
        val dao = XiaoDeDatabase.get(context).dao()
        dao.upsertCourse(CourseEntity("keep", account.accountId, term.termKey, "keep-server", "keep", name = "必须保留", day = 1, sourceStartSlot = 1, sourceEndSlot = 1, startSlot = 1, endSlot = 1, weeksJson = "[1]"))

        val importError = runCatching { repository.importCourses(account, JSONObject().put("replace", true).put("courses", JSONArray())) }.exceptionOrNull()
        assertNotNull(importError)
        assertEquals("必须保留", dao.course("keep")?.name)
        val restoreError = runCatching { repository.restore(account, JSONObject().put("mode", "replace").put("backup", JSONObject().put("courses", JSONArray()))) }.exceptionOrNull()
        assertNotNull(restoreError)
        assertEquals("必须保留", dao.course("keep")?.name)
        assertFalse(dao.course("keep")?.isDeleted ?: true)
    }

    @Test
    fun migrationCreatesV2WithoutDroppingLegacySentinel() {
        XiaoDeDatabase.resetForTests()
        val raw = context.openOrCreateDatabase("xiaode-offline-v2.db", Context.MODE_PRIVATE, null)
        raw.execSQL("CREATE TABLE legacy_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        raw.execSQL("INSERT INTO legacy_sentinel (id, value) VALUES (1, 'preserve-me')")
        raw.version = 1
        raw.close()

        val db = XiaoDeDatabase.get(context)
        val sqlite = db.openHelper.writableDatabase
        assertEquals(2, sqlite.version)
        sqlite.query("SELECT value FROM legacy_sentinel WHERE id = 1").use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals("preserve-me", cursor.getString(0))
        }
        for (table in listOf("accounts", "terms", "courses", "slot_templates", "pending_mutations", "sync_conflicts")) {
            sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", arrayOf(table)).use { cursor ->
                assertTrue("missing $table", cursor.moveToFirst())
            }
        }
    }

    @Test
    fun legacyWidgetCacheMigratesToLegacyTemplateWithoutMovingRows() = runBlocking {
        val payload = JSONObject()
            .put("selectedTermLabel", "旧课表")
            .put("meta", JSONObject().put("totalWeeks", 18))
            .put("courses", JSONArray().put(JSONObject()
                .put("id", "old-6").put("name", "旧第六节").put("day", 1).put("slot", 6)
                .put("weeks", JSONArray().put(1))))
        context.getSharedPreferences("xiaode_widget_data_v11", Context.MODE_PRIVATE).edit()
            .putString("active_account_id", "legacy-account")
            .putString("active_term_key", "legacy-account:legacy")
            .putString("payload_account_term_legacy-account::legacy-account:legacy", payload.toString())
            .commit()

        OfflineRepository(context).initialize("http://server")
        val dao = XiaoDeDatabase.get(context).dao()
        val migrated = dao.courses("legacy-account", "legacy-account:legacy").single()
        assertEquals(6, migrated.sourceStartSlot)
        assertEquals(6, migrated.startSlot)
        assertEquals("P6", migrated.startSlotKey)
        assertEquals("legacy-default", migrated.scheduleTemplateId)
    }

    @Test
    fun syncWorkerPushesOutboxBeforePullAndClearsItAfterRecovery() = runBlocking {
        val accountId = "worker-account"
        val termKey = "$accountId:2026:12"
        val mutationResponse = JSONObject()
            .put("ok", true)
            .put("serverId", "worker-server-course")
            .put("revision", 5)
            .put("updatedAt", "2026-09-01T01:00:00.000Z")
            .toString()
        val snapshotResponse = JSONObject()
            .put("account", JSONObject().put("activeTermKey", termKey).put("revision", 5))
            .put("user", JSONObject().put("username", accountId).put("name", accountId))
            .put("availableTerms", JSONArray().put(JSONObject()
                .put("termKey", termKey).put("selectedTermLabel", "2026-2027 第二学期")
                .put("xnm", "2026").put("xqm", "12").put("totalWeeks", 20)
                .put("scheduleTemplateId", "legacy-default").put("revision", 5)))
            .put("courses", JSONArray().put(JSONObject()
                .put("id", "worker-server-course").put("clientLocalId", "worker-local-course")
                .put("termKey", termKey).put("name", "同步测试课程").put("location", "联网后0412")
                .put("day", 1).put("slot", 1).put("startSlot", 1).put("endSlot", 1)
                .put("weeks", JSONArray().put(1)).put("revision", 5)))
            .put("preferences", JSONObject())
            .toString()
        val server = MockWebServer().apply {
            enqueue(MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(mutationResponse))
            enqueue(MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(snapshotResponse))
            start()
        }

        try {
            val serverUrl = server.url("/").toString().trimEnd('/')
            val tokenStore = memoryTokenStore()
            val repository = OfflineRepository(context, tokenStore)
            repository.initialize(serverUrl)
            val (account, term) = seedAccount(accountId, "$accountId:2026:12", serverUrl = serverUrl)
            tokenStore.put(accountId, "worker-token")
            XiaoDeDatabase.get(context).dao().upsertCourse(CourseEntity(
                localId = "worker-local-course",
                serverId = "worker-server-course",
                clientLocalId = "worker-local-course",
                accountId = accountId,
                termKey = term.termKey,
                name = "同步测试课程",
                location = "离线0411",
                day = 1,
                sourceStartSlot = 1,
                sourceEndSlot = 1,
                startSlot = 1,
                endSlot = 1,
                weeksJson = "[1]",
                revision = 4
            ))
            repository.updateCourse(account, "worker-local-course", JSONObject().put("location", "联网后0412"))

            val result = syncWorker(repository, accountId).doWork()

            assertEquals(ListenableWorker.Result.success().javaClass, result.javaClass)
            val pushRequest = server.takeRequest(5, TimeUnit.SECONDS)
            val pullRequest = server.takeRequest(5, TimeUnit.SECONDS)
            assertNotNull(pushRequest)
            assertNotNull(pullRequest)
            assertEquals("POST", pushRequest?.method)
            assertEquals("/api/my/sync/mutation", pushRequest?.path)
            assertEquals("GET", pullRequest?.method)
            assertEquals("/api/my/sync/snapshot", pullRequest?.path)
            val mutation = JSONObject(pushRequest!!.body.readUtf8())
            assertEquals(accountId, mutation.getString("accountId"))
            assertEquals(term.termKey, mutation.getString("termKey"))
            assertEquals("worker-local-course", mutation.getString("entityLocalId"))
            assertEquals(0, repository.pendingCount(accountId))
            assertEquals("联网后0412", XiaoDeDatabase.get(context).dao().course("worker-local-course")?.location)
            assertEquals("SYNCED", XiaoDeDatabase.get(context).dao().syncMetadata(accountId)?.status)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun syncWorkerRetainsOutboxAndErrorWhenServerRejectsMutation() = runBlocking {
        val server = MockWebServer().apply {
            enqueue(MockResponse().setResponseCode(503)
                .setHeader("Content-Type", "application/json")
                .setBody(JSONObject().put("message", "服务器暂时不可用").toString()))
            start()
        }
        val accountId = "worker-failure-account"
        try {
            val serverUrl = server.url("/").toString().trimEnd('/')
            val tokenStore = memoryTokenStore().also { it.put(accountId, "worker-token") }
            val repository = OfflineRepository(context, tokenStore)
            repository.initialize(serverUrl)
            val (account, term) = seedAccount(accountId, "$accountId:2026:12", serverUrl = serverUrl)
            XiaoDeDatabase.get(context).dao().upsertCourse(CourseEntity(
                localId = "failure-local-course",
                serverId = "failure-server-course",
                clientLocalId = "failure-local-course",
                accountId = accountId,
                termKey = term.termKey,
                name = "失败重试课程",
                location = "离线0411",
                day = 1,
                sourceStartSlot = 1,
                sourceEndSlot = 1,
                startSlot = 1,
                endSlot = 1,
                weeksJson = "[1]",
                revision = 4
            ))
            repository.updateCourse(account, "failure-local-course", JSONObject().put("location", "离线0412"))

            val result = syncWorker(repository, accountId).doWork()

            assertEquals(ListenableWorker.Result.success().javaClass, result.javaClass)
            assertEquals(1, server.requestCount)
            val pending = repository.pending(accountId).single()
            assertEquals(1, pending.attemptCount)
            assertEquals("服务器暂时不可用", pending.lastError)
            assertEquals("离线0412", XiaoDeDatabase.get(context).dao().course("failure-local-course")?.location)
            assertEquals("FAILED", XiaoDeDatabase.get(context).dao().syncMetadata(accountId)?.status)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun immediateAndPeriodicWorkUseIndependentUniqueChains() {
        val config = Configuration.Builder().setExecutor(SynchronousExecutor()).build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, config)
        SyncScheduler.ensurePeriodic(context, "account-a")
        SyncScheduler.enqueue(context, "account-a")
        val manager = WorkManager.getInstance(context)
        assertEquals(1, manager.getWorkInfosForUniqueWork("xiaode-sync-periodic-account-a").get().size)
        assertEquals(1, manager.getWorkInfosForUniqueWork("xiaode-sync-now-account-a").get().size)
    }
}
