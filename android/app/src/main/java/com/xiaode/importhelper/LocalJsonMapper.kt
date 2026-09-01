package com.xiaode.importhelper

import org.json.JSONArray
import org.json.JSONObject

object LocalJsonMapper {
    fun accountToJson(account: AccountEntity): JSONObject = JSONObject()
        .put("id", account.userId)
        .put("accountId", account.accountId)
        .put("username", account.username)
        .put("name", account.name)
        .put("activeTermKey", account.activeTermKey)
        .put("revision", account.revision)
        .put("updatedAt", account.updatedAt)

    fun termToJson(term: TermEntity, courseCount: Int = 0): JSONObject = JSONObject()
        .put("termKey", term.termKey)
        .put("xnm", term.xnm)
        .put("xqm", term.xqm)
        .put("selectedTermLabel", term.selectedTermLabel)
        .put("label", term.selectedTermLabel)
        .put("termStart", term.termStart)
        .put("termStartStatus", term.termStartStatus)
        .put("actualWeek", JSONObject.NULL)
        .put("totalWeeks", term.totalWeeks)
        .put("totalWeeksSource", term.totalWeeksSource.ifBlank { "saved" })
        .put("totalWeeksReliable", term.totalWeeksSource.isNotBlank())
        .put("scheduleTemplateId", term.scheduleTemplateId)
        .put("active", term.active)
        .put("updatedAt", term.updatedAt)
        .put("revision", term.revision)
        .put("courseCount", courseCount)

    fun termFromJson(accountId: String, value: JSONObject): TermEntity {
        val termKey = value.optString("termKey", "legacy").ifBlank { "legacy" }
        return TermEntity(
            termRowId = OfflineContract.termRowId(accountId, termKey),
            accountId = accountId,
            termKey = termKey,
            selectedTermLabel = value.optString("selectedTermLabel", value.optString("label", "历史课程")),
            xnm = value.optString("xnm", ""),
            xqm = value.optString("xqm", ""),
            termStart = value.optString("termStart", ""),
            termStartStatus = value.optString("termStartStatus", if (value.optString("termStart", "").isBlank()) "unknown" else "known"),
            totalWeeks = value.optInt("totalWeeks", 20).coerceIn(1, 60),
            totalWeeksSource = value.optString("totalWeeksSource", "saved"),
            scheduleTemplateId = value.optString("scheduleTemplateId", "legacy-default").ifBlank { "legacy-default" },
            active = value.optBoolean("active", false),
            revision = value.optLong("revision", 1).coerceAtLeast(1),
            updatedAt = value.optString("updatedAt", "")
        )
    }

    fun courseToJson(course: CourseEntity): JSONObject = JSONObject()
        .put("id", course.serverId.ifBlank { course.localId })
        .put("localId", course.localId)
        .put("clientLocalId", course.clientLocalId)
        .put("accountId", course.accountId)
        .put("termKey", course.termKey)
        .put("name", course.name)
        .put("shortName", course.shortName)
        .put("teacher", course.teacher)
        .put("location", course.location)
        .put("room", course.room)
        .put("classGroup", course.classGroup)
        .put("day", course.day)
        .put("slot", course.startSlot)
        .put("sourceStartSlot", course.sourceStartSlot)
        .put("sourceEndSlot", course.sourceEndSlot)
        .put("startSlot", course.startSlot)
        .put("endSlot", course.endSlot)
        .put("startSlotKey", course.startSlotKey)
        .put("endSlotKey", course.endSlotKey)
        .put("scheduleTemplateId", course.scheduleTemplateId)
        .put("weekText", course.weekText)
        .put("weeks", jsonArray(course.weeksJson))
        .put("oddEven", course.oddEven)
        .put("category", course.category)
        .put("source", course.source)
        .put("sourceIds", jsonArray(course.sourceIdsJson))
        .put("underlyingIds", jsonArray(course.underlyingIdsJson))
        .put("scheduleVariants", jsonArray(course.scheduleVariantsJson))
        .put("revision", course.revision)
        .put("createdAt", course.createdAt)
        .put("updatedAt", course.updatedAt)
        .put("syncState", course.syncState)

    fun courseFromJson(
        accountId: String,
        fallbackTermKey: String,
        value: JSONObject,
        localId: String
    ): CourseEntity {
        val start = value.optInt("startSlot", value.optInt("slot", 1)).coerceAtLeast(1)
        val end = value.optInt("endSlot", start).coerceAtLeast(start)
        val sourceStart = value.optInt("sourceStartSlot", start).coerceAtLeast(1)
        val sourceEnd = value.optInt("sourceEndSlot", sourceStart).coerceAtLeast(sourceStart)
        val weekText = value.optString("weekText", "")
        val explicitWeeks = value.optJSONArray("weeks")?.let { array ->
            (0 until array.length()).map { array.optInt(it) }
        }.orEmpty()
        val weeks = OfflineContract.normalizeWeeks(explicitWeeks, weekText)
        val now = OfflineContract.nowIso()
        return CourseEntity(
            localId = localId,
            accountId = accountId,
            termKey = value.optString("termKey", fallbackTermKey).ifBlank { fallbackTermKey },
            serverId = value.optString("id", value.optString("serverId", "")).takeUnless { it == localId }.orEmpty(),
            clientLocalId = value.optString("clientLocalId", localId).ifBlank { localId },
            name = value.optString("name", "").trim(),
            shortName = value.optString("shortName", "").trim(),
            teacher = value.optString("teacher", "").trim(),
            location = value.optString("location", "").trim(),
            room = value.optString("room", "").trim(),
            classGroup = value.optString("classGroup", "").trim(),
            day = value.optInt("day", 1).coerceIn(1, 7),
            sourceStartSlot = sourceStart,
            sourceEndSlot = sourceEnd,
            startSlot = start,
            endSlot = end,
            startSlotKey = value.optString("startSlotKey", "P$start"),
            endSlotKey = value.optString("endSlotKey", "P$end"),
            scheduleTemplateId = value.optString("scheduleTemplateId", "legacy-default").ifBlank { "legacy-default" },
            weekText = weekText,
            weeksJson = JSONArray(weeks).toString(),
            oddEven = value.optString("oddEven", "all"),
            category = value.optString("category", "custom"),
            source = value.optString("source", ""),
            sourceIdsJson = (value.optJSONArray("sourceIds") ?: JSONArray()).toString(),
            underlyingIdsJson = (value.optJSONArray("underlyingIds") ?: JSONArray()).toString(),
            scheduleVariantsJson = (value.optJSONArray("scheduleVariants") ?: JSONArray()).toString(),
            revision = value.optLong("revision", 0).coerceAtLeast(0),
            createdAt = value.optString("createdAt", now),
            updatedAt = value.optString("updatedAt", now),
            syncState = value.optString("syncState", "SYNCED"),
            isDeleted = false
        )
    }

    fun templateToEntity(value: JSONObject, fallbackAccountId: String = ""): SlotTemplateEntity {
        val templateId = value.optString("templateId", "legacy-default").ifBlank { "legacy-default" }
        val accountId = value.optString("accountId", fallbackAccountId).takeUnless { it == "null" }.orEmpty()
        val normalized = JSONObject(value.toString()).put("templateId", templateId)
        return SlotTemplateEntity(
            templateRowId = OfflineContract.templateRowId(accountId, templateId),
            templateId = templateId,
            accountId = accountId,
            termKey = value.optString("termKey", "").takeUnless { it == "null" }.orEmpty(),
            name = value.optString("name", "标准课节时间表"),
            templateJson = normalized.toString(),
            revision = value.optLong("revision", 1).coerceAtLeast(1),
            updatedAt = value.optString("updatedAt", "")
        )
    }

    fun templateJson(value: SlotTemplateEntity): JSONObject = try {
        JSONObject(value.templateJson)
    } catch (_: Throwable) {
        ScheduleTemplateDefaults.legacy()
    }

    fun jsonArray(text: String): JSONArray = try {
        JSONArray(text)
    } catch (_: Throwable) {
        JSONArray()
    }

    fun copyObject(value: JSONObject?): JSONObject = try {
        JSONObject(value?.toString() ?: "{}")
    } catch (_: Throwable) {
        JSONObject()
    }
}
