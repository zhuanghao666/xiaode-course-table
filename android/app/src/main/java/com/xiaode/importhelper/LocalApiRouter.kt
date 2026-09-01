package com.xiaode.importhelper

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.IOException

data class LocalApiResult(val status: Int, val data: JSONObject)

class LocalApiException(
    val status: Int,
    val data: JSONObject,
    message: String = data.optString("message", "请求失败")
) : Exception(message)

class LocalApiRouter(
    private val context: Context,
    private val configuredServerUrl: () -> String
) {
    private val repository = OfflineRepository(context)
    private val http = BackendHttpClient()

    suspend fun initialize() {
        repository.initialize(configuredServerUrl())
        repository.currentAccount()?.let {
            SyncScheduler.ensurePeriodic(context, it.accountId)
            SyncScheduler.enqueue(context, it.accountId)
        }
    }

    suspend fun handle(methodValue: String, pathValue: String, bodyText: String, token: String): LocalApiResult {
        repository.initialize(configuredServerUrl())
        val method = methodValue.uppercase()
        val path = pathValue.substringBefore('?')
        val body = try { if (bodyText.isBlank()) JSONObject() else JSONObject(bodyText) } catch (_: Throwable) {
            throw LocalApiException(400, JSONObject().put("message", "请求内容不是有效 JSON"))
        }

        if (method == "GET" && path == "/api/public/bootstrap") {
            return LocalApiResult(200, repository.publicBootstrap())
        }
        if (method == "POST" && path == "/api/auth/quick-switch") {
            repository.cachedQuickSwitch(
                body.optString("username", ""),
                body.optString("accountId", ""),
                body.optString("switchKey", "")
            )?.let { cached ->
                val accountId = cached.optString("accountId")
                schedule(accountId)
                return LocalApiResult(200, cached)
            }
            return authenticateRemotely(method, path, bodyText, token)
        }
        if (method == "POST" && path in setOf("/api/auth/login", "/api/auth/register")) {
            return authenticateRemotely(method, path, bodyText, token)
        }
        if (method == "GET" && path == "/api/auth/me") {
            val local = repository.resolveAccount(token)
            if (local != null) {
                schedule(local.accountId)
                return LocalApiResult(200, repository.me(local))
            }
            if (token.isBlank() || token == OfflineContract.NATIVE_SESSION_TOKEN) unauthorized()
            val remote = requestRemote(method, path, "", token, null)
            val account = repository.cacheAuthentication(remote, token, configuredServerUrl())
            tryApplySnapshot(account.accountId, remote, token)
            schedule(account.accountId)
            return LocalApiResult(200, repository.me(repository.resolveAccount(token) ?: account))
        }

        val account = repository.resolveAccount(token) ?: unauthorized()
        if (method == "POST" && path == "/api/auth/logout") {
            repository.clearCurrentSession(account.accountId)
            return LocalApiResult(200, JSONObject().put("ok", true))
        }
        val result = when {
            method == "PUT" && path == "/api/my/preferences" -> repository.updatePreferences(account, body)
            method == "PUT" && path == "/api/my/active-term/settings" -> repository.updateActiveTermSettings(account, body)
            method == "PUT" && path == "/api/my/active-term" -> repository.setActiveTerm(account, body.optString("termKey", ""))
            method == "PUT" && path == "/api/my/schedule-template" -> repository.updateScheduleTemplate(account, body)
            method == "DELETE" && path == "/api/my/slots" -> repository.resetSlots(account)
            method == "POST" && path == "/api/my/courses" -> repository.createCourse(account, body)
            method == "DELETE" && path == "/api/my/courses" -> repository.clearActiveTermCourses(account)
            path.startsWith("/api/my/courses/") && method == "PUT" -> repository.updateCourse(account, Uri.decode(path.substringAfterLast('/')), body)
            path.startsWith("/api/my/courses/") && method == "DELETE" -> repository.deleteCourse(account, Uri.decode(path.substringAfterLast('/')))
            method == "POST" && path == "/api/my/import" -> repository.importCourses(account, body)
            method == "GET" && path == "/api/my/backup" -> repository.backup(account)
            method == "POST" && path == "/api/my/restore" -> repository.restore(account, body)
            method == "POST" && path == "/api/my/reset" -> repository.reset(account, body.optBoolean("resetSlots", false))
            method == "GET" && path == "/api/my/sync/status" -> JSONObject().put("ok", true).put("syncStatus", repository.syncStatus(account.accountId))
            else -> {
                val remoteToken = effectiveToken(token, account.accountId)
                val direct = requestRemote(method, pathValue, bodyText, remoteToken, account.accountId)
                if (path == "/api/my/profile" && method == "PUT") {
                    repository.cacheAuthentication(direct, remoteToken, configuredServerUrl())
                }
                if (path == "/api/my/account" && method == "DELETE") {
                    repository.purgeAccount(account.accountId)
                }
                return LocalApiResult(200, direct)
            }
        }
        schedule(account.accountId)
        return LocalApiResult(200, result)
    }

    suspend fun syncStatus(): JSONObject {
        val account = repository.currentAccount() ?: return JSONObject()
            .put("status", "LOCAL").put("pendingCount", 0).put("conflictCount", 0).put("lastError", "")
        return repository.syncStatus(account.accountId)
    }

    private suspend fun authenticateRemotely(method: String, path: String, body: String, token: String): LocalApiResult {
        val remote = requestRemote(method, path, body, token, null)
        val remoteToken = remote.optString("token", token)
        val account = repository.cacheAuthentication(remote, remoteToken, configuredServerUrl())
        tryApplySnapshot(account.accountId, remote, remoteToken)
        schedule(account.accountId)
        val safe = LocalJsonMapper.copyObject(remote)
            .put("token", OfflineContract.NATIVE_SESSION_TOKEN)
            .put("switchKey", "")
        safe.optJSONObject("user")?.remove("switchKey")
        return LocalApiResult(200, safe)
    }

    private suspend fun tryApplySnapshot(accountId: String, authPayload: JSONObject, token: String) {
        val server = repository.serverUrl(accountId, configuredServerUrl())
        try {
            if (authPayload.has("availableTerms") && authPayload.has("courses")) {
                repository.applySnapshot(accountId, authPayload, server)
                return
            }
            val response = http.request(server, "GET", "/api/my/sync/snapshot", token = token)
            if (response.status in 200..299) repository.applySnapshot(accountId, response.json(), server)
            else repository.updateSyncMetadata(accountId, "FAILED", response.json().optString("message", "首次同步失败"))
        } catch (error: IOException) {
            repository.updateSyncMetadata(accountId, "OFFLINE", error.message ?: "当前离线，本地账号已保存")
        }
    }

    private suspend fun requestRemote(
        method: String,
        path: String,
        body: String,
        token: String,
        accountId: String?
    ): JSONObject {
        val server = if (accountId.isNullOrBlank()) configuredServerUrl()
        else repository.serverUrl(accountId, configuredServerUrl())
        val response = try {
            http.request(server, method, path, body, token)
        } catch (error: IOException) {
            if (!accountId.isNullOrBlank()) repository.updateSyncMetadata(accountId, "OFFLINE", error.message ?: "网络不可用")
            throw LocalApiException(503, JSONObject().put("message", error.message ?: "网络不可用"))
        }
        val json = response.json()
        if (response.status !in 200..299) throw LocalApiException(response.status, json)
        return json
    }

    private suspend fun effectiveToken(requestToken: String, accountId: String): String {
        return if (requestToken == OfflineContract.NATIVE_SESSION_TOKEN) repository.tokenFor(accountId) else requestToken
    }

    private fun schedule(accountId: String) {
        SyncScheduler.ensurePeriodic(context, accountId)
        SyncScheduler.enqueue(context, accountId)
        WidgetUpdater.updateAll(context)
    }

    private fun unauthorized(): Nothing = throw LocalApiException(
        401,
        JSONObject().put("message", "本机没有可用登录缓存，请联网登录一次")
    )
}
