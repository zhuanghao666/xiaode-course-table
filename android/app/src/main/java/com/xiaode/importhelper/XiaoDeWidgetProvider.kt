package com.xiaode.importhelper

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent

class XiaoDeWidgetProvider : AppWidgetProvider() {
    companion object {
        const val ACTION_REFRESH = "com.xiaode.importhelper.ACTION_REFRESH_WIDGET"

        fun updateAllWidgets(context: Context) {
            WidgetUpdater.updateAll(context)
        }
    }

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val pending = goAsync()
        WidgetUpdater.update(context, appWidgetManager, appWidgetIds) { pending.finish() }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH || intent.action == Intent.ACTION_TIME_CHANGED || intent.action == Intent.ACTION_DATE_CHANGED) {
            val pending = goAsync()
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, XiaoDeWidgetProvider::class.java))
            WidgetUpdater.update(context, manager, ids) { pending.finish() }
        }
    }
}
