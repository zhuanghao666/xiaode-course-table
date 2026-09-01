package com.xiaode.importhelper

import android.content.Context
import androidx.room.withTransaction
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class OfflineRepository internal constructor(
    private val context: Context,
    private val providedTokenStore: SessionTokenStore? = null
) {
    private val database = XiaoDeDatabase.get(context)
    private val dao = database.dao()
    private val tokenVault by lazy { providedTokenStore ?: TokenVault(context) }

    suspend fun initialize(serverUrl: String) {
        for (template in ScheduleTemplateDefaults.all()) {
            val id = template.optString("templateId")
            if (dao.template("", id) == null) dao.upsertTemplate(LocalJsonMapper.templateToEntity(template, ""))
        }
        migrateLegacyWidgetPayload(serverUrl)
        val accounts = dao.accounts()
        if (dao.currentAccount() == null && accounts.isNotEmpty()) dao.setCurrentAccount(accounts.first().accountId)
        val currentAccountId = dao.currentAccount()?.accountId.orEmpty()
        for (account in accounts) {
            val current = dao.syncMetadata(account.accountId)
            val nextServerUrl = when {
                current == null -> serverUrl
                account.accountId == currentAccountId && serverUrl.isNotBlank() -> serverUrl
                else -> current.serverUrl
            }
            dao.upsertSyncMetadata((current ?: SyncMetadataEntity(account.accountId)).copy(
                serverUrl = nextServerUrl
            ))
            if (account.switchKey.isNotBlank()) dao.upsertAccount(account.copy(switchKey = ""))
        }
    }

    private suspend fun migrateLegacyWidgetPayload(serverUrl: String) {
        val prefs = context.getSharedPreferences("xiaode_widget_data_v11", Context.MODE_PRIVATE)
        val accountId = prefs.getString("active_account_id", "").orEmpty()
        val termKey = prefs.getString("active_term_key", "").orEmpty()
        if (accountId.isBlank() || termKey.isBlank() || dao.account(accountId) != null) return
        val payload = prefs.getString("payload_account_term_$accountId::$termKey", "").orEmpty()
        if (payload.isBlank()) return
        val root = try { JSONObject(payload) } catch (_: Throwable) { return }
        val now = OfflineContract.nowIso()
        val account = AccountEntity(
            accountId = accountId,
            username = root.optString("username", "local-$accountId"),
            name = root.optString("scheduleName", "本机课表"),
            activeTermKey = termKey,
            isCurrent = true,
            updatedAt = now
        )
        val meta = root.optJSONObject("meta") ?: JSONObject()
        val term = TermEntity(
            termRowId = OfflineContract.termRowId(accountId, termKey),
            accountId = accountId,
            termKey = termKey,
            selectedTermLabel = root.optString("selectedTermLabel", "已迁移课表"),
            termStart = meta.optString("termStart", ""),
            termStartStatus = if (meta.optString("termStart", "").isBlank()) "unknown" else "known",
            totalWeeks = meta.optInt("totalWeeks", 20).coerceIn(1, 60),
            totalWeeksSource = "legacy-widget",
            scheduleTemplateId = root.optJSONObject("scheduleTemplate")?.optString("templateId", "legacy-default") ?: "legacy-default",
            active = true,
            updatedAt = now
        )
        database.withTransaction {
            dao.clearCurrentAccount()
            dao.upsertAccount(account)
            dao.upsertTerm(term)
            root.optJSONObject("scheduleTemplate")?.let {
                dao.upsertTemplate(LocalJsonMapper.templateToEntity(it, accountId))
            }
            val courses = root.optJSONArray("courses") ?: JSONArray()
            for (index in 0 until courses.length()) {
                val value = courses.optJSONObject(index) ?: continue
                val localId = "legacy-widget-${UUID.randomUUID()}"
                dao.upsertCourse(LocalJsonMapper.courseFromJson(accountId, termKey, value, localId))
            }
            dao.upsertSyncMetadata(SyncMetadataEntity(accountId, serverUrl, "LOCAL", "已从旧版小组件缓存迁移"))
        }
    }

    suspend fun currentAccount(): AccountEntity? = dao.currentAccount()

    suspend fun resolveAccount(token: String): AccountEntity? {
        val account = when {
            token == OfflineContract.NATIVE_SESSION_TOKEN -> dao.currentAccount()
            token.isBlank() -> null
            else -> dao.accountByTokenHash(OfflineContract.tokenHash(token))
        }
        if (account != null && !account.isCurrent) dao.setCurrentAccount(account.accountId)
        return account?.copy(isCurrent = true)
    }

    suspend fun publicBootstrap(): JSONObject {
        val current = dao.currentAccount()
        val template = LocalJsonMapper.templateJson(dao.template("", "legacy-default")
            ?: LocalJsonMapper.templateToEntity(ScheduleTemplateDefaults.legacy()))
        return JSONObject()
            .put("meta", metaJson(null))
            .put("slots", ScheduleTemplateDefaults.slots(template))
            .put("scheduleTemplate", template)
            .put("scheduleTemplates", JSONArray(ScheduleTemplateDefaults.all().map { it }))
            .put("currentUser", JSONObject.NULL)
            .put("courses", JSONArray())
            .put("localSessionAvailable", current != null)
            .put("syncStatus", if (current == null) localStatus() else syncStatus(current.accountId))
    }

    suspend fun me(account: AccountEntity): JSONObject {
        val terms = dao.terms(account.accountId)
        val active = terms.firstOrNull { it.termKey == account.activeTermKey } ?: terms.firstOrNull()
        val activeCourses = active?.let { dao.courses(account.accountId, it.termKey) }.orEmpty()
        val templates = dao.templates(account.accountId)
        val template = active?.let { dao.template(account.accountId, it.scheduleTemplateId) }
            ?: dao.template("", "legacy-default")
            ?: LocalJsonMapper.templateToEntity(ScheduleTemplateDefaults.legacy())
        val user = LocalJsonMapper.accountToJson(account)
        val available = JSONArray()
        for (term in terms) available.put(LocalJsonMapper.termToJson(term, dao.courses(account.accountId, term.termKey).size))
        val courses = JSONArray(activeCourses.map { LocalJsonMapper.courseToJson(it) })
        val templateArray = JSONArray(templates.distinctBy { it.templateId }.map { LocalJsonMapper.templateJson(it) })
        val activeJson = active?.let { LocalJsonMapper.termToJson(it, activeCourses.size) }
        return JSONObject()
            .put("ok", true)
            .put("accountId", account.accountId)
            .put("user", user)
            .put("meta", metaJson(active))
            .put("slots", ScheduleTemplateDefaults.slots(LocalJsonMapper.templateJson(template)))
            .put("activeTerm", activeJson ?: JSONObject.NULL)
            .put("availableTerms", available)
            .put("termStart", active?.termStart.orEmpty())
            .put("totalWeeks", active?.totalWeeks ?: 20)
            .put("courses", courses)
            .put("scheduleTemplate", LocalJsonMapper.templateJson(template))
            .put("scheduleTemplates", templateArray)
            .put("preferences", jsonObject(dao.preference(account.accountId)?.preferencesJson))
            .put("syncStatus", syncStatus(account.accountId))
    }

    suspend fun cacheAuthentication(response: JSONObject, fallbackToken: String, serverUrl: String): AccountEntity {
        val user = response.optJSONObject("user") ?: JSONObject()
        val accountId = response.optString("accountId", user.optString("accountId", ""))
        require(accountId.isNotBlank()) { "服务器响应缺少 accountId" }
        val token = response.optString("token", fallbackToken)
        val existing = dao.account(accountId)
        val now = OfflineContract.nowIso()
        val account = AccountEntity(
            accountId = accountId,
            userId = user.optString("id", existing?.userId.orEmpty()),
            username = user.optString("username", existing?.username.orEmpty()),
            name = user.optString("name", existing?.name.orEmpty()),
            switchKey = "",
            tokenHash = OfflineContract.tokenHash(token).ifBlank { existing?.tokenHash.orEmpty() },
            activeTermKey = response.optString("activeTermKey", existing?.activeTermKey.orEmpty()),
            isCurrent = true,
            revision = response.optJSONObject("account")?.optLong("revision", existing?.revision ?: 1) ?: (existing?.revision ?: 1),
            updatedAt = now
        )
        database.withTransaction {
            dao.clearCurrentAccount()
            dao.upsertAccount(account)
            if (dao.terms(accountId).isEmpty()) {
                val termKey = account.activeTermKey.ifBlank { "legacy" }
                dao.upsertTerm(TermEntity(
                    termRowId = OfflineContract.termRowId(accountId, termKey),
                    accountId = accountId,
                    termKey = termKey,
                    selectedTermLabel = "本机课表",
                    active = true,
                    updatedAt = now
                ))
                dao.upsertAccount(account.copy(activeTermKey = termKey))
            }
            dao.upsertSyncMetadata((dao.syncMetadata(accountId) ?: SyncMetadataEntity(accountId)).copy(serverUrl = serverUrl))
        }
        if (token.isNotBlank()) tokenVault.put(accountId, token)
        return dao.account(accountId) ?: account
    }

    suspend fun applySnapshot(accountId: String, snapshot: JSONObject, serverUrl: String) {
        val existingAccount = dao.account(accountId) ?: return
        val user = snapshot.optJSONObject("user") ?: JSONObject()
        val remoteAccount = snapshot.optJSONObject("account") ?: JSONObject()
        val pending = dao.allMutations(accountId)
        val dirtyCourseLocalIds = pending.filter { it.entityType == "COURSE" }.map { it.entityLocalId }.filter { it.isNotBlank() }.toSet()
        val dirtyCourseServerIds = pending.filter { it.entityType == "COURSE" }.map { it.serverId }.filter { it.isNotBlank() }.toSet()
        val dirtyTerms = pending.filter { it.entityType == "TERM" }.map { it.termKey }.toSet()
        val activeTermDirty = pending.any { it.entityType == "ACTIVE_TERM" }
        val preferencesDirty = pending.any { it.entityType == "PREFERENCES" }
        val templatesDirty = pending.any { it.entityType == "SCHEDULE_TEMPLATE" || it.entityType == "SLOTS" }
        val now = OfflineContract.nowIso()

        database.withTransaction {
            val remoteActiveTermKey = if (activeTermDirty) existingAccount.activeTermKey else remoteAccount.optString(
                "activeTermKey", snapshot.optString("activeTermKey", existingAccount.activeTermKey)
            )
            val nextAccount = existingAccount.copy(
                userId = user.optString("id", existingAccount.userId),
                username = user.optString("username", existingAccount.username),
                name = user.optString("name", existingAccount.name),
                // Native account switching resolves the remote credential from TokenVault.
                // Never copy a raw switch key from a server snapshot into the Room cache.
                switchKey = "",
                activeTermKey = remoteActiveTermKey,
                revision = remoteAccount.optLong("revision", existingAccount.revision).coerceAtLeast(1),
                updatedAt = remoteAccount.optString("updatedAt", now)
            )
            dao.upsertAccount(nextAccount)

            val remoteTerms = snapshot.optJSONArray("availableTerms") ?: JSONArray()
            if (dirtyTerms.isEmpty()) dao.deleteTerms(accountId)
            for (index in 0 until remoteTerms.length()) {
                val term = LocalJsonMapper.termFromJson(accountId, remoteTerms.optJSONObject(index) ?: continue)
                    .copy(active = (remoteActiveTermKey == (remoteTerms.optJSONObject(index)?.optString("termKey") ?: "")))
                if (term.termKey !in dirtyTerms) dao.upsertTerm(term)
            }

            val oldCourses = dao.allCourses(accountId)
            for (course in oldCourses) {
                if (OfflineMergePolicy.shouldReplaceCourse(accountId, course.localId, course.serverId, pending)) dao.deleteCourse(course.localId)
            }
            val remoteCourses = snapshot.optJSONArray("courses") ?: JSONArray()
            for (index in 0 until remoteCourses.length()) {
                val value = remoteCourses.optJSONObject(index) ?: continue
                val serverId = value.optString("id", "")
                val clientLocalId = value.optString("clientLocalId", "")
                if (serverId in dirtyCourseServerIds || clientLocalId in dirtyCourseLocalIds) continue
                val existing = dao.courseByServerId(accountId, serverId)
                    ?: clientLocalId.takeIf { it.isNotBlank() }?.let { dao.courseByClientLocalId(accountId, it) }
                val localId = existing?.localId ?: clientLocalId.ifBlank { "server-$accountId-$serverId" }
                dao.upsertCourse(LocalJsonMapper.courseFromJson(accountId, value.optString("termKey", "legacy"), value, localId))
            }

            if (!templatesDirty) {
                dao.deleteAccountTemplates(accountId)
                val remoteTemplates = snapshot.optJSONArray("scheduleTemplates") ?: JSONArray()
                for (index in 0 until remoteTemplates.length()) {
                    val value = remoteTemplates.optJSONObject(index) ?: continue
                    val owner = value.optString("accountId", "").takeUnless { it == "null" }.orEmpty()
                    dao.upsertTemplate(LocalJsonMapper.templateToEntity(value, owner))
                }
            }
            if (!preferencesDirty) {
                dao.upsertPreference(PreferenceEntity(
                    accountId = accountId,
                    preferencesJson = (snapshot.optJSONObject("preferences") ?: JSONObject()).toString(),
                    revision = snapshot.optLong("preferenceRevision", 1).coerceAtLeast(1),
                    updatedAt = now
                ))
            }
            val previous = dao.syncMetadata(accountId) ?: SyncMetadataEntity(accountId)
            dao.upsertSyncMetadata(previous.copy(
                serverUrl = serverUrl,
                status = if (dao.unresolvedConflicts(accountId).isEmpty()) "SYNCED" else "CONFLICT",
                lastError = "",
                lastPullAt = System.currentTimeMillis(),
                lastAttemptAt = System.currentTimeMillis()
            ))
        }
    }

    suspend fun createCourse(account: AccountEntity, body: JSONObject): JSONObject {
        val term = requireActiveTerm(account)
        val localId = "local-${UUID.randomUUID()}"
        val now = OfflineContract.nowIso()
        val enriched = LocalJsonMapper.copyObject(body)
            .put("termKey", term.termKey)
            .put("accountId", account.accountId)
            .put("clientLocalId", localId)
            .put("createdAt", now)
            .put("updatedAt", now)
        if (enriched.optString("weekText", "").isBlank() && (enriched.optJSONArray("weeks")?.length() ?: 0) == 0) {
            enriched.put("weekText", "1-${term.totalWeeks}周")
        }
        val course = LocalJsonMapper.courseFromJson(account.accountId, term.termKey, enriched, localId).copy(syncState = "PENDING")
        require(course.name.isNotBlank()) { "课程名不能为空" }
        database.withTransaction {
            dao.upsertCourse(course)
            enqueueMutation(course.accountId, course.termKey, "COURSE", course.localId, "", "CREATE", 0, LocalJsonMapper.courseToJson(course))
        }
        return JSONObject().put("ok", true).put("course", LocalJsonMapper.courseToJson(course)).put("syncStatus", syncStatus(account.accountId))
    }

    suspend fun updateCourse(account: AccountEntity, id: String, body: JSONObject): JSONObject {
        val existing = dao.course(id) ?: dao.courseByServerId(account.accountId, id)
            ?: throw NoSuchElementException("课程不存在")
        require(existing.accountId == account.accountId) { "课程不属于当前账号" }
        val merged = LocalJsonMapper.courseToJson(existing)
        val keys = body.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            merged.put(key, body.opt(key))
        }
        if (body.has("weekText") && !body.has("weeks")) merged.remove("weeks")
        merged.put("id", existing.serverId).put("clientLocalId", existing.clientLocalId).put("updatedAt", OfflineContract.nowIso())
        val course = LocalJsonMapper.courseFromJson(account.accountId, existing.termKey, merged, existing.localId)
            .copy(serverId = existing.serverId, revision = existing.revision, createdAt = existing.createdAt, syncState = "PENDING")
        database.withTransaction {
            dao.upsertCourse(course)
            enqueueMutation(account.accountId, course.termKey, "COURSE", course.localId, course.serverId, "UPDATE", course.revision, LocalJsonMapper.courseToJson(course))
        }
        return JSONObject().put("ok", true).put("course", LocalJsonMapper.courseToJson(course)).put("syncStatus", syncStatus(account.accountId))
    }

    suspend fun deleteCourse(account: AccountEntity, id: String): JSONObject {
        val course = dao.course(id) ?: dao.courseByServerId(account.accountId, id)
            ?: return JSONObject().put("ok", true).put("deleted", false)
        require(course.accountId == account.accountId) { "课程不属于当前账号" }
        database.withTransaction {
            dao.markCourseDeleted(course.localId, OfflineContract.nowIso())
            enqueueMutation(account.accountId, course.termKey, "COURSE", course.localId, course.serverId, "DELETE", course.revision, LocalJsonMapper.courseToJson(course))
        }
        return JSONObject().put("ok", true).put("deleted", true).put("syncStatus", syncStatus(account.accountId))
    }

    suspend fun clearActiveTermCourses(account: AccountEntity): JSONObject {
        val term = requireActiveTerm(account)
        val courses = dao.courses(account.accountId, term.termKey)
        for (course in courses) deleteCourse(account, course.localId)
        return JSONObject().put("ok", true).put("count", courses.size).put("syncStatus", syncStatus(account.accountId))
    }

    suspend fun updatePreferences(account: AccountEntity, body: JSONObject): JSONObject {
        val value = body.optJSONObject("preferences") ?: body
        val existing = dao.preference(account.accountId) ?: PreferenceEntity(account.accountId)
        val next = existing.copy(preferencesJson = value.toString(), updatedAt = OfflineContract.nowIso())
        database.withTransaction {
            dao.upsertPreference(next)
            enqueueMutation(account.accountId, "", "PREFERENCES", account.accountId, "", "UPDATE", existing.revision, JSONObject().put("preferences", value))
        }
        return JSONObject().put("ok", true).put("accountId", account.accountId).put("preferences", value).put("syncStatus", syncStatus(account.accountId))
    }

    suspend fun setActiveTerm(account: AccountEntity, termKey: String): JSONObject {
        val term = dao.term(account.accountId, termKey) ?: throw NoSuchElementException("学期不存在")
        val next = account.copy(activeTermKey = termKey, updatedAt = OfflineContract.nowIso())
        database.withTransaction {
            dao.upsertAccount(next)
            dao.setActiveTerm(account.accountId, termKey)
            enqueueMutation(account.accountId, termKey, "ACTIVE_TERM", account.accountId, "", "UPDATE", account.revision, JSONObject().put("termKey", termKey))
        }
        return me(next)
    }

    suspend fun updateActiveTermSettings(account: AccountEntity, body: JSONObject): JSONObject {
        val term = requireActiveTerm(account)
        val totalWeeks = body.optInt("totalWeeks", term.totalWeeks).coerceIn(1, 60)
        val termStart = body.optString("termStart", term.termStart).trim()
        require(OfflineContract.isValidMondayTermStart(termStart)) { "请选择第一教学周的周一；日期未知时可以留空" }
        val next = term.copy(
            termStart = termStart,
            termStartStatus = if (termStart.isBlank()) "unknown" else "known",
            totalWeeks = totalWeeks,
            totalWeeksSource = "manual",
            updatedAt = OfflineContract.nowIso()
        )
        database.withTransaction {
            dao.upsertTerm(next)
            enqueueMutation(account.accountId, term.termKey, "TERM", term.termRowId, "", "UPDATE", term.revision,
                JSONObject().put("termStart", next.termStart).put("totalWeeks", next.totalWeeks))
        }
        return JSONObject().put("ok", true).put("activeTerm", LocalJsonMapper.termToJson(next, dao.courses(account.accountId, term.termKey).size))
            .put("syncStatus", syncStatus(account.accountId))
    }

    suspend fun updateScheduleTemplate(account: AccountEntity, body: JSONObject): JSONObject {
        val term = requireActiveTerm(account)
        val selectTemplateId = body.optString("selectTemplateId", "")
        if (selectTemplateId.isNotBlank()) {
            val selected = dao.template(account.accountId, selectTemplateId) ?: throw NoSuchElementException("课节模板不存在")
            val nextTerm = term.copy(scheduleTemplateId = selected.templateId, updatedAt = OfflineContract.nowIso())
            database.withTransaction {
                dao.upsertTerm(nextTerm)
                remapTermCourses(account.accountId, term.termKey, LocalJsonMapper.templateJson(selected))
                enqueueMutation(account.accountId, term.termKey, "TERM", term.termRowId, "", "UPDATE", term.revision,
                    JSONObject().put("scheduleTemplateId", selected.templateId))
            }
            return JSONObject().put("ok", true).put("scheduleTemplate", LocalJsonMapper.templateJson(selected))
                .put("slots", ScheduleTemplateDefaults.slots(LocalJsonMapper.templateJson(selected))).put("syncStatus", syncStatus(account.accountId))
        }

        val current = dao.template(account.accountId, term.scheduleTemplateId)
            ?: LocalJsonMapper.templateToEntity(ScheduleTemplateDefaults.legacy())
        val candidate = LocalJsonMapper.copyObject(body)
            .put("templateId", current.templateId)
            .put("accountId", account.accountId)
            .put("termKey", term.termKey)
            .put("updatedAt", OfflineContract.nowIso())
            .put("revision", current.revision)
        validateSourceMapping(LocalJsonMapper.templateJson(current), candidate)
        val entity = LocalJsonMapper.templateToEntity(candidate, account.accountId)
        database.withTransaction {
            dao.upsertTemplate(entity)
            dao.upsertTerm(term.copy(scheduleTemplateId = entity.templateId, updatedAt = OfflineContract.nowIso()))
            remapTermCourses(account.accountId, term.termKey, candidate)
            enqueueMutation(account.accountId, term.termKey, "SCHEDULE_TEMPLATE", entity.templateRowId, "", "UPDATE", current.revision, candidate)
        }
        return JSONObject().put("ok", true).put("scheduleTemplate", candidate)
            .put("slots", ScheduleTemplateDefaults.slots(candidate)).put("syncStatus", syncStatus(account.accountId))
    }

    suspend fun resetSlots(account: AccountEntity): JSONObject =
        updateScheduleTemplate(account, JSONObject().put("selectTemplateId", "legacy-default"))

    suspend fun importCourses(account: AccountEntity, body: JSONObject): JSONObject {
        val replace = body.optBoolean("replace", false)
        val term = requireActiveTerm(account)
        val values = body.optJSONArray("courses") ?: JSONArray()
        val prepared = mutableListOf<CourseEntity>()
        val now = OfflineContract.nowIso()
        for (index in 0 until values.length()) {
            val value = values.optJSONObject(index) ?: continue
            if (value.optString("name", "").isBlank()) continue
            val localId = "local-${UUID.randomUUID()}"
            val enriched = LocalJsonMapper.copyObject(value)
                .put("accountId", account.accountId)
                .put("termKey", term.termKey)
                .put("clientLocalId", localId)
                .put("createdAt", now)
                .put("updatedAt", now)
            if (enriched.optString("weekText", "").isBlank() && (enriched.optJSONArray("weeks")?.length() ?: 0) == 0) {
                enriched.put("weekText", "1-${term.totalWeeks}周")
            }
            val course = LocalJsonMapper.courseFromJson(account.accountId, term.termKey, enriched, localId)
                .copy(syncState = "PENDING")
            require(course.name.isNotBlank() && course.day in 1..7 && course.startSlot >= 1 && course.endSlot >= course.startSlot) {
                "导入课程缺少有效的课程名、星期或节次"
            }
            prepared += course
        }
        require(prepared.isNotEmpty()) { "导入内容里没有可恢复的有效课程，原课表未改变" }
        database.withTransaction {
            if (replace) {
                for (course in dao.courses(account.accountId, term.termKey)) {
                    dao.markCourseDeleted(course.localId, now)
                    enqueueMutation(account.accountId, term.termKey, "COURSE", course.localId, course.serverId, "DELETE", course.revision, LocalJsonMapper.courseToJson(course))
                }
            }
            for (course in prepared) {
                dao.upsertCourse(course)
                enqueueMutation(course.accountId, course.termKey, "COURSE", course.localId, "", "CREATE", 0, LocalJsonMapper.courseToJson(course))
            }
        }
        return JSONObject().put("ok", true).put("count", prepared.size).put("syncStatus", syncStatus(account.accountId))
    }

    suspend fun backup(account: AccountEntity): JSONObject {
        val terms = dao.terms(account.accountId)
        val active = terms.firstOrNull { it.termKey == account.activeTermKey } ?: terms.firstOrNull()
        val templates = dao.templates(account.accountId)
        val allCourses = active?.let { dao.courses(account.accountId, it.termKey) }.orEmpty()
        val backup = JSONObject()
            .put("app", "xiaode-course-table")
            .put("appVersion", "android-room-v2")
            .put("schemaVersion", 8)
            .put("exportedAt", OfflineContract.nowIso())
            .put("user", JSONObject().put("username", account.username).put("name", account.name))
            .put("account", JSONObject().put("id", account.accountId).put("name", account.name).put("username", account.username))
            .put("preferences", jsonObject(dao.preference(account.accountId)?.preferencesJson))
            .put("meta", metaJson(active))
            .put("activeTerm", active?.let { LocalJsonMapper.termToJson(it) } ?: JSONObject.NULL)
            .put("availableTerms", JSONArray(terms.map { LocalJsonMapper.termToJson(it) }))
            .put("scheduleTemplate", active?.let { dao.template(account.accountId, it.scheduleTemplateId) }?.let { LocalJsonMapper.templateJson(it) } ?: ScheduleTemplateDefaults.legacy())
            .put("scheduleTemplates", JSONArray(templates.map { LocalJsonMapper.templateJson(it) }))
            .put("courses", JSONArray(allCourses.map { LocalJsonMapper.courseToJson(it).apply { remove("accountId") } }))
        return JSONObject().put("ok", true).put("accountId", account.accountId).put("backup", backup)
    }

    suspend fun restore(account: AccountEntity, body: JSONObject): JSONObject {
        val backup = body.optJSONObject("backup") ?: throw IllegalArgumentException("备份内容无效")
        val mode = body.optString("mode", "replace")
        val courses = backup.optJSONArray("courses") ?: JSONArray()
        val backupTermKey = backup.optJSONObject("activeTerm")?.optString("termKey", "").orEmpty()
        val scoped = JSONArray()
        for (index in 0 until courses.length()) {
            val course = courses.optJSONObject(index) ?: continue
            val courseTermKey = course.optString("termKey", "")
            if (backupTermKey.isBlank() || courseTermKey.isBlank() || courseTermKey == backupTermKey) scoped.put(course)
        }
        require(scoped.length() > 0) { "备份中没有当前备份学期的课程，原课表未改变" }
        return importCourses(account, JSONObject().put("courses", scoped).put("replace", mode == "replace"))
    }

    suspend fun reset(account: AccountEntity, resetSlots: Boolean): JSONObject {
        val cleared = clearActiveTermCourses(account)
        if (resetSlots) resetSlots(account)
        return JSONObject().put("ok", true).put("count", cleared.optInt("count", 0)).put("syncStatus", syncStatus(account.accountId))
    }

    suspend fun cachedQuickSwitch(username: String, accountId: String, switchKey: String): JSONObject? {
        val candidate = when {
            accountId.isNotBlank() -> dao.account(accountId)
            username.isNotBlank() -> dao.accountByUsername(username)
            else -> null
        } ?: return null
        val token = tokenVault.get(candidate.accountId)
        if (token.isBlank()) return null
        dao.setCurrentAccount(candidate.accountId)
        return JSONObject().put("ok", true).put("token", OfflineContract.NATIVE_SESSION_TOKEN).put("switchKey", "")
            .put("accountId", candidate.accountId).put("user", LocalJsonMapper.accountToJson(candidate.copy(isCurrent = true)))
    }

    suspend fun tokenFor(accountId: String): String = tokenVault.get(accountId)

    suspend fun clearCurrentSession(accountId: String) {
        if (dao.currentAccount()?.accountId == accountId) dao.clearCurrentAccount()
    }

    suspend fun purgeAccount(accountId: String) {
        database.withTransaction {
            dao.deleteCourses(accountId)
            dao.deleteTerms(accountId)
            dao.deleteAccountTemplates(accountId)
            dao.deletePreference(accountId)
            dao.deleteSyncMetadata(accountId)
            dao.deletePendingMutations(accountId)
            dao.deleteConflicts(accountId)
            dao.deleteAccount(accountId)
        }
        tokenVault.remove(accountId)
    }

    suspend fun pending(accountId: String): List<PendingMutationEntity> = OfflineContract.orderedForPush(dao.pendingMutations(accountId))
    suspend fun deletePending(operationId: String) = dao.deletePendingMutation(operationId)
    suspend fun recordAttempt(operationId: String, error: String) = dao.recordMutationAttempt(operationId, error.take(500))
    suspend fun course(localId: String): CourseEntity? = dao.course(localId)
    suspend fun pendingCount(accountId: String): Int = dao.pendingCount(accountId)

    suspend fun recordConflict(mutation: PendingMutationEntity, serverJson: JSONObject, message: String) {
        database.withTransaction {
            dao.upsertConflict(SyncConflictEntity(
                conflictId = "conflict-${mutation.operationId}",
                operationId = mutation.operationId,
                accountId = mutation.accountId,
                termKey = mutation.termKey,
                entityType = mutation.entityType,
                entityLocalId = mutation.entityLocalId,
                localJson = mutation.payloadJson,
                serverJson = serverJson.toString(),
                reason = message,
                createdAt = System.currentTimeMillis()
            ))
            dao.markMutationConflict(mutation.operationId, message.take(500))
            updateSyncMetadata(mutation.accountId, "CONFLICT", message)
        }
    }

    suspend fun acknowledgeMutation(mutation: PendingMutationEntity, response: JSONObject) {
        database.withTransaction {
            val revision = response.optLong("revision", mutation.baseRevision).coerceAtLeast(mutation.baseRevision)
            val updatedAt = response.optString("updatedAt", OfflineContract.nowIso())
            val resolvedServerId = response.optString("serverId", mutation.serverId)
            dao.deletePendingMutation(mutation.operationId)
            if (mutation.entityType == "COURSE") {
                val course = dao.course(mutation.entityLocalId)
                if (course != null) {
                    if (mutation.operationType == "DELETE") {
                        dao.deleteCourse(course.localId)
                    } else {
                        dao.rebasePendingMutations(
                            mutation.accountId, mutation.entityType, mutation.entityLocalId,
                            mutation.operationId, resolvedServerId, revision
                        )
                        dao.upsertCourse(course.copy(
                            serverId = resolvedServerId.ifBlank { course.serverId },
                            revision = revision.coerceAtLeast(course.revision),
                            updatedAt = updatedAt,
                            syncState = if (dao.pendingForEntity(course.accountId, course.localId) > 0) "PENDING" else "SYNCED"
                        ))
                    }
                }
            } else {
                when (mutation.entityType) {
                    "PREFERENCES" -> dao.preference(mutation.accountId)?.let {
                        dao.upsertPreference(it.copy(revision = revision.coerceAtLeast(it.revision), updatedAt = updatedAt))
                    }
                    "TERM" -> dao.term(mutation.accountId, mutation.termKey)?.let {
                        dao.upsertTerm(it.copy(revision = revision.coerceAtLeast(it.revision), updatedAt = updatedAt))
                    }
                    "ACTIVE_TERM" -> dao.account(mutation.accountId)?.let {
                        dao.upsertAccount(it.copy(revision = revision.coerceAtLeast(it.revision), updatedAt = updatedAt))
                    }
                    "SCHEDULE_TEMPLATE", "SLOTS" -> dao.templateByRowId(mutation.entityLocalId)?.let {
                        dao.upsertTemplate(it.copy(revision = revision.coerceAtLeast(it.revision), updatedAt = updatedAt))
                    }
                }
                dao.rebasePendingMutations(
                    mutation.accountId, mutation.entityType, mutation.entityLocalId,
                    mutation.operationId, resolvedServerId, revision
                )
            }
        }
    }

    suspend fun updateSyncMetadata(accountId: String, status: String, error: String = "", pushed: Boolean = false) {
        val previous = dao.syncMetadata(accountId) ?: SyncMetadataEntity(accountId)
        val now = System.currentTimeMillis()
        dao.upsertSyncMetadata(previous.copy(
            status = status,
            lastError = error.take(500),
            lastPushAt = if (pushed) now else previous.lastPushAt,
            lastAttemptAt = now
        ))
    }

    suspend fun serverUrl(accountId: String, fallback: String): String =
        dao.syncMetadata(accountId)?.serverUrl?.ifBlank { fallback } ?: fallback

    suspend fun syncStatus(accountId: String): JSONObject {
        val metadata = dao.syncMetadata(accountId) ?: SyncMetadataEntity(accountId)
        val conflicts = dao.unresolvedConflicts(accountId)
        return JSONObject()
            .put("status", if (conflicts.isNotEmpty()) "CONFLICT" else metadata.status)
            .put("pendingCount", dao.pendingCount(accountId))
            .put("conflictCount", conflicts.size)
            .put("lastError", metadata.lastError)
            .put("lastPushAt", metadata.lastPushAt)
            .put("lastPullAt", metadata.lastPullAt)
    }

    private fun localStatus() = JSONObject().put("status", "LOCAL").put("pendingCount", 0).put("conflictCount", 0).put("lastError", "")

    private suspend fun enqueueMutation(
        accountId: String,
        termKey: String,
        entityType: String,
        entityLocalId: String,
        serverId: String,
        operationType: String,
        baseRevision: Long,
        payload: JSONObject
    ) {
        dao.insertPendingMutation(PendingMutationEntity(
            operationId = "op-${UUID.randomUUID()}",
            accountId = accountId,
            termKey = termKey,
            entityType = entityType,
            entityLocalId = entityLocalId,
            serverId = serverId,
            operationType = operationType,
            baseRevision = baseRevision,
            payloadJson = payload.toString(),
            createdAt = System.currentTimeMillis()
        ))
        updateSyncMetadata(accountId, "LOCAL")
    }

    private suspend fun requireActiveTerm(account: AccountEntity): TermEntity {
        return dao.term(account.accountId, account.activeTermKey)
            ?: dao.terms(account.accountId).firstOrNull()
            ?: throw IllegalStateException("当前账号没有可用学期")
    }

    private suspend fun remapTermCourses(accountId: String, termKey: String, template: JSONObject) {
        for (course in dao.courses(accountId, termKey)) {
            val start = ScheduleTemplateDefaults.mapSource(template, course.sourceStartSlot) ?: continue
            val end = ScheduleTemplateDefaults.mapSource(template, course.sourceEndSlot) ?: start
            dao.upsertCourse(course.copy(
                startSlot = start.optInt("logicalOrder", course.startSlot),
                endSlot = end.optInt("logicalOrder", course.endSlot),
                startSlotKey = start.optString("slotKey", course.startSlotKey),
                endSlotKey = end.optString("slotKey", course.endSlotKey),
                scheduleTemplateId = template.optString("templateId", course.scheduleTemplateId),
                updatedAt = OfflineContract.nowIso()
            ))
        }
    }

    private fun validateSourceMapping(current: JSONObject, candidate: JSONObject) {
        val old = current.optJSONArray("periods") ?: JSONArray()
        val next = candidate.optJSONArray("periods") ?: throw IllegalArgumentException("课节模板不能为空")
        require(old.length() == next.length()) { "普通编辑不能增删来源课节，请改用模板切换" }
        for (index in 0 until old.length()) {
            val left = old.optJSONObject(index) ?: continue
            val right = next.optJSONObject(index) ?: throw IllegalArgumentException("课节模板格式无效")
            require(left.optInt("sourceSlot") == right.optInt("sourceSlot")) { "普通编辑不能更改来源节次映射" }
            require(left.optString("slotKey") == right.optString("slotKey")) { "普通编辑不能更改课节标识" }
        }
    }

    private fun metaJson(term: TermEntity?): JSONObject = JSONObject()
        .put("appVersion", "v41-android-offline")
        .put("schemaVersion", 8)
        .put("storageMode", "android-room-local-first")
        .put("schemaNote", "Android 以 Room 为本地主存储，联网后通过幂等队列同步")
        .put("termStart", term?.termStart.orEmpty())
        .put("totalWeeks", term?.totalWeeks ?: 20)

    private fun jsonObject(value: String?): JSONObject = try {
        JSONObject(value ?: "{}")
    } catch (_: Throwable) {
        JSONObject()
    }
}
