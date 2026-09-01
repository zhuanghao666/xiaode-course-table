package com.xiaode.importhelper

import android.content.Context
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object SyncScheduler {
    const val ACTION_SYNC_STATUS = "com.xiaode.importhelper.ACTION_SYNC_STATUS"
    const val EXTRA_ACCOUNT_ID = "accountId"
    private const val INPUT_ACCOUNT_ID = "accountId"

    private val connected = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    fun enqueue(context: Context, accountId: String) {
        if (accountId.isBlank()) return
        val request = OneTimeWorkRequestBuilder<XiaoDeSyncWorker>()
            .setInputData(Data.Builder().putString(INPUT_ACCOUNT_ID, accountId).build())
            .setConstraints(connected)
            .addTag("xiaode-sync")
            .addTag("xiaode-sync-$accountId")
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            "xiaode-sync-now-$accountId",
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request
        )
    }

    fun ensurePeriodic(context: Context, accountId: String) {
        if (accountId.isBlank()) return
        val request = PeriodicWorkRequestBuilder<XiaoDeSyncWorker>(15, TimeUnit.MINUTES)
            .setInputData(Data.Builder().putString(INPUT_ACCOUNT_ID, accountId).build())
            .setConstraints(connected)
            .addTag("xiaode-periodic-sync-$accountId")
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
            "xiaode-sync-periodic-$accountId",
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        )
    }

    fun accountId(data: Data): String = data.getString(INPUT_ACCOUNT_ID).orEmpty()
}
