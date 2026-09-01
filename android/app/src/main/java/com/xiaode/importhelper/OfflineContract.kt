package com.xiaode.importhelper

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

object OfflineContract {
    const val APP_ASSET_HOME = "https://appassets.androidplatform.net/assets/index.html"
    const val NATIVE_SESSION_TOKEN = "native-local-session"

    fun nowIso(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(Date())

    fun tokenHash(token: String): String {
        if (token.isBlank() || token == NATIVE_SESSION_TOKEN) return ""
        return MessageDigest.getInstance("SHA-256")
            .digest(token.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    fun isValidMondayTermStart(value: String): Boolean {
        if (value.isBlank()) return true
        if (!Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(value)) return false
        val parser = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            isLenient = false
            timeZone = TimeZone.getTimeZone("UTC")
        }
        val date = try { parser.parse(value) } catch (_: Throwable) { null } ?: return false
        if (parser.format(date) != value) return false
        return Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { time = date }
            .get(Calendar.DAY_OF_WEEK) == Calendar.MONDAY
    }

    fun normalizeWeeks(explicit: List<Int>, weekText: String, maxWeeks: Int = 60): List<Int> {
        val direct = explicit.filter { it in 1..maxWeeks }.distinct().sorted()
        if (direct.isNotEmpty()) return direct
        val normalized = weekText
            .replace('，', ',').replace('、', ',').replace('；', ',')
            .replace('～', '-').replace('—', '-').replace('–', '-').replace('至', '-')
        val result = linkedSetOf<Int>()
        for (part in normalized.split(',', ';').map { it.trim() }.filter { it.isNotBlank() }) {
            val range = Regex("(\\d+)\\s*-\\s*(\\d+)").find(part)
            if (range != null) {
                val start = range.groupValues[1].toIntOrNull() ?: continue
                val end = range.groupValues[2].toIntOrNull() ?: continue
                if (start in 1..maxWeeks && end in start..maxWeeks) for (week in start..end) result += week
                continue
            }
            Regex("\\d+").findAll(part).forEach { match ->
                match.value.toIntOrNull()?.takeIf { it in 1..maxWeeks }?.let(result::add)
            }
        }
        return result.sorted()
    }

    /** Pushes are replayed in creation order. Pull is allowed only after this list is empty. */
    fun orderedForPush(values: List<PendingMutationEntity>): List<PendingMutationEntity> =
        values.sortedWith(compareBy<PendingMutationEntity> { it.createdAt }.thenBy { it.operationId })

    fun termRowId(accountId: String, termKey: String) = "$accountId::$termKey"
    fun templateRowId(accountId: String, templateId: String) = "${accountId.ifBlank { "global" }}::$templateId"
}

object OfflineMergePolicy {
    fun pendingForScope(values: List<PendingMutationEntity>, accountId: String, termKey: String? = null) =
        values.filter { it.accountId == accountId && (termKey == null || it.termKey == termKey) }

    fun mayPull(pendingCount: Int): Boolean = pendingCount == 0

    fun shouldReplaceCourse(
        accountId: String,
        localId: String,
        serverId: String,
        values: List<PendingMutationEntity>
    ): Boolean = values.none { mutation ->
        mutation.accountId == accountId &&
            mutation.entityType == "COURSE" &&
            (mutation.entityLocalId == localId || (serverId.isNotBlank() && mutation.serverId == serverId))
    }
}

data class NativePeriodDefinition(
    val sourceSlot: Int,
    val logicalOrder: Int,
    val displayNumber: Int?,
    val startTime: String,
    val endTime: String,
    val slotKey: String = displayNumber?.let { "P$it" } ?: "MIDDAY_1",
    val displayLabel: String = displayNumber?.let { "第${it}节" } ?: "午间加时",
    val kind: String = if (displayNumber == null) "MIDDAY_EXTENSION" else "REGULAR",
    val visibilityPolicy: String = if (displayNumber == null) "AUTO" else "ALWAYS"
)

object ScheduleTemplateDefaults {
    private val standardTimes = listOf(
        "08:00" to "08:45", "08:55" to "09:40", "10:00" to "10:45", "10:55" to "11:40",
        "14:00" to "14:45", "14:50" to "15:35", "15:55" to "16:40", "16:45" to "17:30",
        "18:20" to "19:05", "19:10" to "19:55", "20:05" to "20:50", "21:00" to "21:45"
    )
    private val legacyTimes = listOf(
        "08:00" to "08:45", "08:55" to "09:40", "10:00" to "10:45", "10:55" to "11:40",
        "11:50" to "12:35", "14:00" to "14:45", "14:50" to "15:35", "15:55" to "16:40",
        "16:45" to "17:30", "18:20" to "19:05", "19:10" to "19:55", "20:05" to "20:50"
    )

    private fun period(value: NativePeriodDefinition) = JSONObject()
        .put("slotKey", value.slotKey)
        .put("sourceSlot", value.sourceSlot)
        .put("logicalOrder", value.logicalOrder)
        .put("displayNumber", value.displayNumber ?: JSONObject.NULL)
        .put("displayLabel", value.displayLabel)
        .put("startTime", value.startTime)
        .put("endTime", value.endTime)
        .put("kind", value.kind)
        .put("visibilityPolicy", value.visibilityPolicy)

    private fun template(id: String, name: String, schoolId: String?, periods: JSONArray) = JSONObject()
        .put("templateId", id)
        .put("schoolId", schoolId ?: JSONObject.NULL)
        .put("campusId", JSONObject.NULL)
        .put("accountId", JSONObject.NULL)
        .put("termKey", JSONObject.NULL)
        .put("name", name)
        .put("version", 1)
        .put("allowCrossKindMerge", false)
        .put("periods", periods)
        .put("createdAt", "")
        .put("updatedAt", "")
        .put("revision", 1)

    fun legacyDefinitions(): List<NativePeriodDefinition> = legacyTimes.mapIndexed { index, time ->
        NativePeriodDefinition(index + 1, index + 1, index + 1, time.first, time.second)
    }

    fun schoolADefinitions(): List<NativePeriodDefinition> {
        val periods = mutableListOf<NativePeriodDefinition>()
        for (source in 1..4) {
            val time = standardTimes[source - 1]
            periods += NativePeriodDefinition(source, source, source, time.first, time.second)
        }
        periods += NativePeriodDefinition(5, 5, null, "11:45", "12:30")
        for (source in 6..12) {
            val display = source - 1
            val time = standardTimes[display - 1]
            periods += NativePeriodDefinition(source, source, display, time.first, time.second)
        }
        return periods
    }

    fun schoolBDefinitions(): List<NativePeriodDefinition> = (1..12).map { source ->
            val time = standardTimes[source - 1]
            NativePeriodDefinition(source, source, source, time.first, time.second)
    }

    private fun jsonPeriods(values: List<NativePeriodDefinition>) = JSONArray().apply {
        values.forEach { put(period(it)) }
    }

    fun legacy(): JSONObject = template("legacy-default", "旧版默认课节时间表", null, jsonPeriods(legacyDefinitions()))

    fun schoolA(): JSONObject = template("school-a-v1", "学校 A 课节时间表", "school-a", jsonPeriods(schoolADefinitions()))

    fun schoolB(): JSONObject = template("school-b-v1", "学校 B 课节时间表", "school-b", jsonPeriods(schoolBDefinitions()))

    fun all(): List<JSONObject> = listOf(legacy(), schoolA(), schoolB())

    fun slots(template: JSONObject): JSONArray {
        val result = JSONArray()
        val periods = template.optJSONArray("periods") ?: JSONArray()
        for (index in 0 until periods.length()) {
            val p = periods.optJSONObject(index) ?: continue
            val slot = p.optInt("logicalOrder", index + 1)
            val start = p.optString("startTime", "")
            val end = p.optString("endTime", "")
            result.put(JSONObject()
                .put("slot", slot)
                .put("sourceSlot", p.optInt("sourceSlot", slot))
                .put("logicalOrder", slot)
                .put("displayNumber", if (p.isNull("displayNumber")) JSONObject.NULL else p.optInt("displayNumber"))
                .put("slotKey", p.optString("slotKey", "P$slot"))
                .put("label", p.optString("displayLabel", "第${slot}节"))
                .put("displayLabel", p.optString("displayLabel", "第${slot}节"))
                .put("range", "$start-$end")
                .put("start", start)
                .put("end", end)
                .put("kind", p.optString("kind", "REGULAR"))
                .put("visibilityPolicy", p.optString("visibilityPolicy", "ALWAYS")))
        }
        return result
    }

    fun mapSource(template: JSONObject, sourceSlot: Int): JSONObject? {
        val periods = template.optJSONArray("periods") ?: return null
        for (index in 0 until periods.length()) {
            val period = periods.optJSONObject(index) ?: continue
            if (period.optInt("sourceSlot", -1) == sourceSlot) return period
        }
        return null
    }
}
