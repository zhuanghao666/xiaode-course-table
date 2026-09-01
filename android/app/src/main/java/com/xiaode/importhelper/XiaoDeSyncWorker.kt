package com.xiaode.importhelper

import android.content.Context
import android.content.Intent
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.IOException

class XiaoDeSyncWorker private constructor(
    appContext: Context,
    params: WorkerParameters,
    private val repository: OfflineRepository,
    private val http: BackendHttpClient
) : CoroutineWorker(appContext, params) {
    constructor(appContext: Context, params: WorkerParameters) : this(
        appContext,
        params,
        OfflineRepository(appContext),
        BackendHttpClient()
    )

    internal constructor(
        appContext: Context,
        params: WorkerParameters,
        repository: OfflineRepository
    ) : this(appContext, params, repository, BackendHttpClient())

    override suspend fun doWork(): Result {
        val accountId = SyncScheduler.accountId(inputData)
        if (accountId.isBlank()) return Result.failure()
        val token = repository.tokenFor(accountId)
        val serverUrl = repository.serverUrl(accountId, "")
        if (token.isBlank()) {
            repository.updateSyncMetadata(accountId, "AUTH_REQUIRED", "需要重新登录后才能同步")
            notifyChanged(accountId)
            return Result.success()
        }
        if (serverUrl.isBlank()) {
            repository.updateSyncMetadata(accountId, "OFFLINE", "尚未设置同步服务器")
            notifyChanged(accountId)
            return Result.success()
        }

        repository.updateSyncMetadata(accountId, "SYNCING")
        notifyChanged(accountId)
        while (true) {
            // Re-read after every acknowledgement so later edits of the same entity use
            // the server revision/id produced by the preceding mutation.
            val mutation = repository.pending(accountId).firstOrNull() ?: break
            val request = JSONObject()
                .put("operationId", mutation.operationId)
                .put("accountId", mutation.accountId)
                .put("termKey", mutation.termKey)
                .put("entityType", mutation.entityType)
                .put("entityLocalId", mutation.entityLocalId)
                .put("serverId", mutation.serverId)
                .put("operationType", mutation.operationType)
                .put("baseRevision", mutation.baseRevision)
                .put("payload", try { JSONObject(mutation.payloadJson) } catch (_: Throwable) { JSONObject() })
            val response = try {
                http.request(serverUrl, "POST", "/api/my/sync/mutation", request.toString(), token)
            } catch (error: IOException) {
                repository.recordAttempt(mutation.operationId, error.message.orEmpty())
                repository.updateSyncMetadata(accountId, "OFFLINE", error.message ?: "网络不可用")
                notifyChanged(accountId)
                return Result.retry()
            }
            val json = response.json()
            when {
                response.status == 401 || response.status == 403 -> {
                    repository.recordAttempt(mutation.operationId, json.optString("message", "登录已失效"))
                    repository.updateSyncMetadata(accountId, "AUTH_REQUIRED", json.optString("message", "登录已失效"))
                    notifyChanged(accountId)
                    return Result.success()
                }
                response.status == 409 && json.optBoolean("conflict", true) -> {
                    repository.recordConflict(mutation, json.optJSONObject("serverEntity") ?: JSONObject.NULL.let { JSONObject() }, json.optString("message", "服务器记录已变化"))
                    notifyChanged(accountId)
                    continue
                }
                response.status !in 200..299 -> {
                    val message = json.optString("message", "同步请求失败（HTTP ${response.status}）")
                    repository.recordAttempt(mutation.operationId, message)
                    repository.updateSyncMetadata(accountId, "FAILED", message)
                    notifyChanged(accountId)
                    return Result.success()
                }
                else -> {
                    repository.acknowledgeMutation(mutation, json)
                    repository.updateSyncMetadata(accountId, "SYNCING", pushed = true)
                }
            }
        }

        // A mutation created while this worker was pushing must be sent before any pull.
        if (!OfflineMergePolicy.mayPull(repository.pendingCount(accountId))) {
            SyncScheduler.enqueue(applicationContext, accountId)
            notifyChanged(accountId)
            return Result.success()
        }

        val snapshot = try {
            http.request(serverUrl, "GET", "/api/my/sync/snapshot", token = token)
        } catch (error: IOException) {
            repository.updateSyncMetadata(accountId, "OFFLINE", error.message ?: "拉取失败")
            notifyChanged(accountId)
            return Result.retry()
        }
        if (snapshot.status == 401 || snapshot.status == 403) {
            repository.updateSyncMetadata(accountId, "AUTH_REQUIRED", snapshot.json().optString("message", "登录已失效"))
            notifyChanged(accountId)
            return Result.success()
        }
        if (snapshot.status !in 200..299) {
            repository.updateSyncMetadata(accountId, "FAILED", snapshot.json().optString("message", "拉取失败（HTTP ${snapshot.status}）"))
            notifyChanged(accountId)
            return Result.retry()
        }
        repository.applySnapshot(accountId, snapshot.json(), serverUrl)
        WidgetUpdater.updateAll(applicationContext)
        notifyChanged(accountId)
        return Result.success()
    }

    private fun notifyChanged(accountId: String) {
        applicationContext.sendBroadcast(Intent(SyncScheduler.ACTION_SYNC_STATUS).apply {
            setPackage(applicationContext.packageName)
            putExtra(SyncScheduler.EXTRA_ACCOUNT_ID, accountId)
        })
    }
}
