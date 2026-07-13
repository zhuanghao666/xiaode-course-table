package com.xiaode.importhelper

/** Widget 和后台刷新只接受当前账号冻结的 activeTermKey。 */
internal fun belongsToActiveTerm(courseTermKey: String, activeTermKey: String): Boolean {
    return activeTermKey.isNotBlank() && courseTermKey == activeTermKey
}

/**
 * Widget 对新范围字段和旧版单节 slot 使用同一份归一化规则。
 * 非法的 0/负值回退到旧 slot，倒序范围则安全纠正，避免时间判断越界。
 */
internal data class CourseSlotRange(val startSlot: Int, val endSlot: Int)

internal fun normalizeCourseSlotRange(
    legacySlot: Int,
    startSlot: Int?,
    endSlot: Int?
): CourseSlotRange {
    val fallback = legacySlot.takeIf { it in 1..12 } ?: 1
    val rawStart = startSlot?.takeIf { it in 1..12 } ?: fallback
    val rawEnd = endSlot?.takeIf { it in 1..12 } ?: rawStart
    return CourseSlotRange(
        startSlot = minOf(rawStart, rawEnd),
        endSlot = maxOf(rawStart, rawEnd)
    )
}

/** 返回课程从首节开始到末节结束的完整分钟范围；旧 payload 会自然退化为单节。 */
internal fun courseMinuteRange(
    range: CourseSlotRange,
    slotMinutes: Map<Int, IntRange>
): IntRange? {
    val first = slotMinutes[range.startSlot] ?: return null
    val last = slotMinutes[range.endSlot] ?: return null
    return first.first..last.last
}

internal fun courseSectionLabel(range: CourseSlotRange): String {
    return if (range.startSlot == range.endSlot) {
        "第${range.startSlot}节"
    } else {
        "第${range.startSlot}-${range.endSlot}节"
    }
}
