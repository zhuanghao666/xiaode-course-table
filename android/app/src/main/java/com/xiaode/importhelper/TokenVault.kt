package com.xiaode.importhelper

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

internal interface SessionTokenStore {
    fun put(accountId: String, token: String)
    fun get(accountId: String): String
    fun remove(accountId: String)
}

/** Raw session tokens never enter Room, logs, diagnostics, backups, or widget payloads. */
class TokenVault(context: Context) : SessionTokenStore {
    private val preferences = EncryptedSharedPreferences.create(
        context.applicationContext,
        "xiaode_secure_sessions_v1",
        MasterKey.Builder(context.applicationContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    override fun put(accountId: String, token: String) {
        if (accountId.isBlank() || token.isBlank()) return
        preferences.edit().putString("session::$accountId", token).apply()
    }

    override fun get(accountId: String): String = preferences.getString("session::$accountId", "").orEmpty()

    override fun remove(accountId: String) {
        preferences.edit().remove("session::$accountId").apply()
    }
}
