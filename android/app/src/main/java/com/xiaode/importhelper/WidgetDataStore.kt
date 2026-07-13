package com.xiaode.importhelper

import android.content.Context
import org.json.JSONObject

object WidgetDataStore {
    private const val PREFS = "xiaode_widget_data_v11"
    private const val KEY_UPDATED_AT = "updated_at"
    private const val KEY_ACTIVE_ACCOUNT_ID = "active_account_id"
    private const val KEY_ACTIVE_TERM_KEY = "active_term_key"
    private const val KEY_PAYLOAD_PREFIX = "payload_account_term_"

    private fun scopedPayloadKey(accountId: String, termKey: String): String = "$KEY_PAYLOAD_PREFIX$accountId::$termKey"

    fun savePayload(context: Context, payload: String) {
        val accountId = JSONObject(payload).optString("accountId", "").trim()
        val activeTermKey = JSONObject(payload).optString("activeTermKey", "").trim()
        require(accountId.isNotBlank()) { "Widget payload is missing accountId" }
        require(activeTermKey.isNotBlank()) { "Widget payload is missing activeTermKey" }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ACTIVE_ACCOUNT_ID, accountId)
            .putString(KEY_ACTIVE_TERM_KEY, activeTermKey)
            .putString(scopedPayloadKey(accountId, activeTermKey), payload)
            .putLong(KEY_UPDATED_AT, System.currentTimeMillis())
            .apply()
    }

    fun getPayload(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val accountId = prefs.getString(KEY_ACTIVE_ACCOUNT_ID, "").orEmpty()
        val termKey = prefs.getString(KEY_ACTIVE_TERM_KEY, "").orEmpty()
        if (accountId.isNotBlank() && termKey.isNotBlank()) {
            return prefs.getString(scopedPayloadKey(accountId, termKey), "") ?: ""
        }
        return ""
    }

    fun getActiveAccountId(context: Context): String {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_ACTIVE_ACCOUNT_ID, "")
            .orEmpty()
    }

    fun getActiveTermKey(context: Context): String {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_ACTIVE_TERM_KEY, "")
            .orEmpty()
    }

    fun getUpdatedAt(context: Context): Long {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_UPDATED_AT, 0L)
    }
}
