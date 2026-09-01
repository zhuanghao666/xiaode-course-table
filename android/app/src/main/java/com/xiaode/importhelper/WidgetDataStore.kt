package com.xiaode.importhelper

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject

/**
 * Widget state is projected directly from Room. WebView callbacks are no longer a data source,
 * so a reboot, offline launch, or killed WebView cannot make the widget lose the active schedule.
 */
object WidgetDataStore {
    @Deprecated("v33 widgets read Room directly")
    fun savePayload(context: Context, payload: String) = Unit

    fun getPayload(context: Context): String = runBlocking(Dispatchers.IO) {
        val dao = XiaoDeDatabase.get(context).dao()
        val account = dao.currentAccount() ?: return@runBlocking ""
        val terms = dao.terms(account.accountId)
        val term = terms.firstOrNull { it.termKey == account.activeTermKey } ?: terms.firstOrNull()
            ?: return@runBlocking ""
        val template = dao.template(account.accountId, term.scheduleTemplateId)
            ?: dao.template("", "legacy-default")
            ?: LocalJsonMapper.templateToEntity(ScheduleTemplateDefaults.legacy())
        JSONObject()
            .put("version", 5)
            .put("accountId", account.accountId)
            .put("activeTermKey", term.termKey)
            .put("scheduleName", account.name.ifBlank { "我的课表" })
            .put("selectedTermLabel", term.selectedTermLabel)
            .put("meta", JSONObject()
                .put("termStart", term.termStart)
                .put("totalWeeks", term.totalWeeks)
                .put("totalWeeksReliable", term.totalWeeksSource.isNotBlank()))
            .put("activeTerm", LocalJsonMapper.termToJson(term))
            .put("availableTerms", JSONArray(terms.map { LocalJsonMapper.termToJson(it) }))
            .put("scheduleTemplate", LocalJsonMapper.templateJson(template))
            .put("slots", ScheduleTemplateDefaults.slots(LocalJsonMapper.templateJson(template)))
            .put("courses", JSONArray(dao.courses(account.accountId, term.termKey).map { LocalJsonMapper.courseToJson(it) }))
            .put("preferences", try {
                JSONObject(dao.preference(account.accountId)?.preferencesJson ?: "{}")
            } catch (_: Throwable) { JSONObject() })
            .toString()
    }

    fun getActiveAccountId(context: Context): String = runBlocking(Dispatchers.IO) {
        XiaoDeDatabase.get(context).dao().currentAccount()?.accountId.orEmpty()
    }

    fun getActiveTermKey(context: Context): String = runBlocking(Dispatchers.IO) {
        XiaoDeDatabase.get(context).dao().currentAccount()?.activeTermKey.orEmpty()
    }

    fun getUpdatedAt(context: Context): Long = runBlocking(Dispatchers.IO) {
        val dao = XiaoDeDatabase.get(context).dao()
        val account = dao.currentAccount() ?: return@runBlocking 0L
        val sync = dao.syncMetadata(account.accountId) ?: return@runBlocking 0L
        maxOf(sync.lastPullAt, sync.lastPushAt, sync.lastAttemptAt)
    }
}
