package com.xiaode.importhelper

import android.content.Context
import org.json.JSONObject

object WidgetDataStore {
    private const val PREFS = "xiaode_widget_data_v11"
    private const val KEY_PAYLOAD = "payload"
    private const val KEY_UPDATED_AT = "updated_at"
    private const val KEY_ACTIVE_ACCOUNT_ID = "active_account_id"
    private const val KEY_PAYLOAD_PREFIX = "payload_account_"

    fun savePayload(context: Context, payload: String) {
        val accountId = JSONObject(payload).optString("accountId", "").trim()
        require(accountId.isNotBlank()) { "Widget payload is missing accountId" }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ACTIVE_ACCOUNT_ID, accountId)
            .putString(KEY_PAYLOAD_PREFIX + accountId, payload)
            .putLong(KEY_UPDATED_AT, System.currentTimeMillis())
            .apply()
    }

    fun getPayload(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val accountId = prefs.getString(KEY_ACTIVE_ACCOUNT_ID, "").orEmpty()
        if (accountId.isNotBlank()) {
            return prefs.getString(KEY_PAYLOAD_PREFIX + accountId, "") ?: ""
        }
        return prefs.getString(KEY_PAYLOAD, "") ?: ""
    }

    fun getActiveAccountId(context: Context): String {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_ACTIVE_ACCOUNT_ID, "")
            .orEmpty()
    }

    fun getUpdatedAt(context: Context): Long {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_UPDATED_AT, 0L)
    }
}
