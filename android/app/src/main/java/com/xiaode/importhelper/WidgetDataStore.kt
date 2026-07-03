package com.xiaode.importhelper

import android.content.Context

object WidgetDataStore {
    private const val PREFS = "xiaode_widget_data_v11"
    private const val KEY_PAYLOAD = "payload"
    private const val KEY_UPDATED_AT = "updated_at"

    fun savePayload(context: Context, payload: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_PAYLOAD, payload)
            .putLong(KEY_UPDATED_AT, System.currentTimeMillis())
            .apply()
    }

    fun getPayload(context: Context): String {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PAYLOAD, "") ?: ""
    }

    fun getUpdatedAt(context: Context): Long {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_UPDATED_AT, 0L)
    }
}
