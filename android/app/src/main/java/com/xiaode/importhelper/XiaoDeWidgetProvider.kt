package com.xiaode.importhelper

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
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
        WidgetUpdater.update(context, appWidgetManager, appWidgetIds)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH || intent.action == Intent.ACTION_TIME_CHANGED || intent.action == Intent.ACTION_DATE_CHANGED) {
            WidgetUpdater.updateAll(context)
        }
    }
}
