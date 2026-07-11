package com.xiaode.importhelper

/**
 * 一次导入的不可变身份边界。
 *
 * 原生层不接收小德登录 token；一次性 importCode 就是后端可验证的短期会话上下文。
 * 创建后所有网络请求只读取本对象，不能再从当前 WebView 账号或可编辑输入框取值。
 */
internal data class ImportTaskContext(
    val serverBaseUrl: String,
    val importCode: String,
    val accountId: String,
    val xnm: String,
    val xqm: String,
    val replace: Boolean,
    val createdAt: Long
) {
    init {
        require(serverBaseUrl.isNotBlank()) { "serverBaseUrl is required" }
        require(importCode.length >= 6) { "importCode is invalid" }
        require(accountId.isNotBlank()) { "accountId is required" }
        require(xnm.isNotBlank()) { "xnm is required" }
        require(xqm.isNotBlank()) { "xqm is required" }
    }
}

