package com.xiaode.importhelper

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

object WidgetUpdater {
    private val DAYS = arrayOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

    data class Slot(
        val slot: Int,
        val label: String,
        val range: String,
        val start: String,
        val end: String
    )

    data class Course(
        val termKey: String,
        val name: String,
        val teacher: String,
        val location: String,
        val day: Int,
        val startSlot: Int,
        val endSlot: Int,
        val weeks: Set<Int>,
        val oddEven: String
    )

    data class DisplayCourse(
        val status: String,
        val course: Course?,
        val slot: Slot?,
        val endSlot: Slot?,
        val dayLabel: String,
        val subText: String
    )

    // Web 已发送逻辑课程；这里再去除旧缓存中的完全重复范围，避免 Widget 选择到重复副本。
    internal fun deduplicateCourses(courses: List<Course>): List<Course> {
        fun normalized(value: String) = value.replace(Regex("\\s+"), " ").trim()
        return courses.distinctBy { course ->
            listOf(
                course.termKey,
                normalized(course.name),
                normalized(course.teacher),
                normalized(course.location),
                course.day,
                course.startSlot,
                course.endSlot,
                course.weeks.sorted(),
                course.oddEven
            )
        }
    }

    fun updateAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(ComponentName(context, XiaoDeWidgetProvider::class.java))
        if (ids.isNotEmpty()) update(context, manager, ids)
    }

    fun update(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) {
            manager.updateAppWidget(id, buildViews(context))
        }
    }

    private fun buildViews(context: Context): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_next_course)
        val payload = WidgetDataStore.getPayload(context)
        val updatedAt = WidgetDataStore.getUpdatedAt(context)

        val openIntent = Intent(context, MainActivity::class.java)
        val openPendingIntent = PendingIntent.getActivity(
            context,
            1001,
            openIntent,
            pendingFlags()
        )
        views.setOnClickPendingIntent(R.id.widgetRoot, openPendingIntent)

        val refreshIntent = Intent(context, XiaoDeWidgetProvider::class.java).apply {
            action = XiaoDeWidgetProvider.ACTION_REFRESH
        }
        val refreshPendingIntent = PendingIntent.getBroadcast(
            context,
            1002,
            refreshIntent,
            pendingFlags()
        )
        views.setOnClickPendingIntent(R.id.widgetRefresh, refreshPendingIntent)

        if (payload.isBlank()) {
            views.setTextViewText(R.id.widgetTitle, "小德课表")
            views.setTextViewText(R.id.widgetChip, "未同步")
            views.setTextViewText(R.id.widgetCourseName, "打开 App 同步课表")
            views.setTextViewText(R.id.widgetMeta1, "登录后进入课表页，桌面小组件会自动更新")
            views.setTextViewText(R.id.widgetMeta2, "点击小组件打开小德课表")
            views.setTextViewText(R.id.widgetSub, "")
            return views
        }

        try {
            val json = JSONObject(payload)
            val accountId = json.optString("accountId", "").trim()
            val activeTermKey = json.optString("activeTermKey", "").trim()
            if (accountId.isBlank() || accountId != WidgetDataStore.getActiveAccountId(context)) {
                throw IllegalStateException("Widget account context is invalid")
            }
            if (activeTermKey.isBlank() || activeTermKey != WidgetDataStore.getActiveTermKey(context)) {
                throw IllegalStateException("Widget term context is invalid")
            }
            val scheduleName = json.optString("scheduleName", "我的课表").ifBlank { "我的课表" }
            val meta = json.optJSONObject("meta") ?: JSONObject()
            val termStart = meta.optString("termStart", "")
            val totalWeeks = meta.optInt("totalWeeks", 20).coerceIn(1, 60)
            val slots = parseSlots(json.optJSONArray("slots") ?: JSONArray())
            val courses = parseCourses(json.optJSONArray("courses") ?: JSONArray(), activeTermKey)
            val now = Calendar.getInstance()
            val calendarState = getTermCalendarState(termStart, totalWeeks, now)

            views.setTextViewText(R.id.widgetTitle, "小德课表 · $scheduleName")
            if (calendarState.status != TermCalendarStatus.ACTIVE) {
                when (calendarState.status) {
                    TermCalendarStatus.UNKNOWN -> {
                        views.setTextViewText(R.id.widgetChip, "待确认")
                        views.setTextViewText(R.id.widgetCourseName, "开学日期待确认")
                        views.setTextViewText(R.id.widgetMeta1, "课程已同步，可在 App 中预览第1周")
                        views.setTextViewText(R.id.widgetMeta2, "学校公布后请设置第一教学周周一")
                    }
                    TermCalendarStatus.BEFORE_TERM -> {
                        views.setTextViewText(R.id.widgetChip, "未开学")
                        views.setTextViewText(R.id.widgetCourseName, "该学期尚未开始")
                        views.setTextViewText(R.id.widgetMeta1, "第一教学周周一 $termStart")
                        views.setTextViewText(R.id.widgetMeta2, "距离开学还有 ${calendarState.daysUntilStart ?: 0} 天")
                    }
                    TermCalendarStatus.AFTER_TERM -> {
                        views.setTextViewText(R.id.widgetChip, "已结课")
                        views.setTextViewText(R.id.widgetCourseName, "本学期已经结束")
                        views.setTextViewText(R.id.widgetMeta1, "本学期共 $totalWeeks 周")
                        views.setTextViewText(R.id.widgetMeta2, "打开 App 可查看历史课表")
                    }
                    TermCalendarStatus.ACTIVE -> Unit
                }
                val syncText = if (updatedAt > 0) "同步 ${SimpleDateFormat("HH:mm", Locale.CHINA).format(Date(updatedAt))}" else "等待同步"
                views.setTextViewText(R.id.widgetSub, syncText)
                return views
            }
            val week = calendarState.actualWeek ?: return views
            val display = findDisplayCourse(courses, slots, week, now)

            views.setTextViewText(R.id.widgetChip, display.status)
            val course = display.course
            val slot = display.slot
            val endSlot = display.endSlot ?: slot
            if (course == null || slot == null) {
                views.setTextViewText(R.id.widgetCourseName, "今天没有下一节课")
                views.setTextViewText(R.id.widgetMeta1, "第 ${week} 周 · 可以休息一下")
                views.setTextViewText(R.id.widgetMeta2, display.subText)
            } else {
                views.setTextViewText(R.id.widgetCourseName, course.name.ifBlank { "未命名课程" })
                val sectionLabel = courseSectionLabel(CourseSlotRange(course.startSlot, course.endSlot))
                val timeRange = "${slot.start}-${endSlot?.end ?: slot.end}"
                views.setTextViewText(R.id.widgetMeta1, "${display.dayLabel} · $sectionLabel · $timeRange")
                views.setTextViewText(R.id.widgetMeta2, course.location.ifBlank { course.teacher.ifBlank { "地点未填写" } })
            }
            val syncText = if (updatedAt > 0) "同步 ${SimpleDateFormat("HH:mm", Locale.CHINA).format(Date(updatedAt))} · 第 ${week} 周" else "第 ${week} 周"
            views.setTextViewText(R.id.widgetSub, syncText)
        } catch (e: Exception) {
            views.setTextViewText(R.id.widgetTitle, "小德课表")
            views.setTextViewText(R.id.widgetChip, "需刷新")
            views.setTextViewText(R.id.widgetCourseName, "小组件数据解析失败")
            views.setTextViewText(R.id.widgetMeta1, "请打开 App，刷新小德课表页面")
            views.setTextViewText(R.id.widgetMeta2, e.message ?: "未知错误")
            views.setTextViewText(R.id.widgetSub, "")
        }
        return views
    }

    private fun pendingFlags(): Int {
        return PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
    }

    private fun parseSlots(array: JSONArray): Map<Int, Slot> {
        val map = linkedMapOf<Int, Slot>()
        for (i in 0 until array.length()) {
            val o = array.optJSONObject(i) ?: continue
            val slot = o.optInt("slot", i + 1)
            val range = o.optString("range", "")
            val start = o.optString("start", range.substringBefore("-", "00:00")).ifBlank { "00:00" }
            val end = o.optString("end", range.substringAfter("-", "23:59")).ifBlank { "23:59" }
            map[slot] = Slot(slot, o.optString("label", "第${slot}节"), range.ifBlank { "$start-$end" }, start, end)
        }
        return map
    }

    private fun parseCourses(array: JSONArray, activeTermKey: String): List<Course> {
        val list = mutableListOf<Course>()
        for (i in 0 until array.length()) {
            val o = array.optJSONObject(i) ?: continue
            val termKey = o.optString("termKey", "").trim()
            if (!belongsToActiveTerm(termKey, activeTermKey)) continue
            val weeksArray = o.optJSONArray("weeks") ?: JSONArray()
            val weeks = mutableSetOf<Int>()
            for (j in 0 until weeksArray.length()) weeks.add(weeksArray.optInt(j))
            val legacySlot = o.optInt("slot", 1)
            val range = normalizeCourseSlotRange(
                legacySlot = legacySlot,
                startSlot = if (o.has("startSlot")) o.optInt("startSlot", legacySlot) else null,
                endSlot = if (o.has("endSlot")) o.optInt("endSlot", legacySlot) else null
            )
            list.add(
                Course(
                    termKey = termKey,
                    name = o.optString("name", ""),
                    teacher = o.optString("teacher", ""),
                    location = o.optString("location", ""),
                    day = o.optInt("day", 1),
                    startSlot = range.startSlot,
                    endSlot = range.endSlot,
                    weeks = weeks,
                    oddEven = o.optString("oddEven", "all")
                )
            )
        }
        return deduplicateCourses(list)
    }

    private fun getDayIndex(calendar: Calendar): Int {
        val d = calendar.get(Calendar.DAY_OF_WEEK)
        return if (d == Calendar.SUNDAY) 7 else d - 1
    }

    private fun timeToMin(time: String): Int {
        val parts = time.split(":")
        val h = parts.getOrNull(0)?.toIntOrNull() ?: 0
        val m = parts.getOrNull(1)?.toIntOrNull() ?: 0
        return h * 60 + m
    }

    private fun activeInWeek(c: Course, week: Int): Boolean {
        if (c.weeks.isNotEmpty() && !c.weeks.contains(week)) return false
        if (c.oddEven == "odd" && week % 2 == 0) return false
        if (c.oddEven == "even" && week % 2 == 1) return false
        return true
    }

    private fun findDisplayCourse(courses: List<Course>, slots: Map<Int, Slot>, currentWeek: Int, now: Calendar): DisplayCourse {
        val today = getDayIndex(now)
        val minuteNow = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        val thisWeek = courses.filter { activeInWeek(it, currentWeek) }
        val slotMinutes = slots.mapValues { (_, slot) -> timeToMin(slot.start)..timeToMin(slot.end) }

        fun minuteRange(course: Course): IntRange? {
            return courseMinuteRange(CourseSlotRange(course.startSlot, course.endSlot), slotMinutes)
        }

        fun startMinute(course: Course): Int {
            return minuteRange(course)?.first ?: Int.MAX_VALUE
        }

        val current = thisWeek
            .filter { c -> c.day == today && (minuteRange(c)?.contains(minuteNow) == true) }
            .minByOrNull(::startMinute)
        if (current != null) {
            val slot = slots[current.startSlot]
            val endSlot = slots[current.endSlot] ?: slot
            return DisplayCourse("上课中", current, slot, endSlot, DAYS.getOrElse(today - 1) { "今天" }, "正在上课")
        }

        val nextToday = thisWeek
            .filter { c -> c.day == today && startMinute(c) > minuteNow && startMinute(c) != Int.MAX_VALUE }
            .minByOrNull(::startMinute)
        if (nextToday != null) {
            val slot = slots[nextToday.startSlot]
            val endSlot = slots[nextToday.endSlot] ?: slot
            val diff = (minuteRange(nextToday)?.first?.minus(minuteNow) ?: 0)
            val status = if (diff in 1..10) "即将上课" else "课间休息"
            return DisplayCourse(status, nextToday, slot, endSlot, "今天", "距离下一节约 ${diff} 分钟")
        }

        for (offset in 1..6) {
            val futureDay = ((today - 1 + offset) % 7) + 1
            val week = currentWeek + ((today - 1 + offset) / 7)
            val candidate = courses
                .filter { c -> c.day == futureDay && activeInWeek(c, week) }
                .filter { startMinute(it) != Int.MAX_VALUE }
                .minByOrNull(::startMinute)
            if (candidate != null) {
                val slot = slots[candidate.startSlot]
                val endSlot = slots[candidate.endSlot] ?: slot
                val label = when (offset) {
                    1 -> "明天"
                    2 -> "后天"
                    else -> DAYS.getOrElse(futureDay - 1) { "之后" }
                }
                return DisplayCourse("下一节", candidate, slot, endSlot, label, "下一次有课：$label")
            }
        }

        return DisplayCourse("今日结束", null, null, null, "", "本周后续暂无课程")
    }
}
