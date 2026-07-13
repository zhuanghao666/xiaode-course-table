package com.xiaode.importhelper

/** Widget 和后台刷新只接受当前账号冻结的 activeTermKey。 */
internal fun belongsToActiveTerm(courseTermKey: String, activeTermKey: String): Boolean {
    return activeTermKey.isNotBlank() && courseTermKey == activeTermKey
}
