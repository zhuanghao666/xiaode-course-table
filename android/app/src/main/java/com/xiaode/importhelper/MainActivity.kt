package com.xiaode.importhelper

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.ClipData
import android.content.ContentUris
import android.content.ContentValues
import android.content.ComponentName
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.provider.MediaStore
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.net.UnknownHostException
import java.nio.charset.StandardCharsets
import java.util.LinkedHashSet
import java.util.TimeZone
import javax.net.ssl.SSLException

/**
 * 小德课表 App v29 · Web v39 MySQL 测试版
 *
 * 主页面：WebView 承载网页版小德课表。
 * 导入页：原生 WebView 打开教务系统，用户自己登录；App 读取 Cookie 请求课表 JSON，上传到后端。
 *
 * Web 端通过 window.XiaoDeAndroid.startImport(JSON.stringify({...})) 把一次性导入码交给 App，
 * 用户无需复制/粘贴导入码。
 *
 * v29 同步 Web v39：保留稳定 App 壳，并配套后端 MySQL 本地测试能力；多账号、备份恢复、课程文件分享、原生日历提醒继续保留：
 * - 备份导出：Android Bridge 接管 JSON 下载，保存到系统下载目录或 App 下载目录。
 * - 备份导入：支持 WebView file input 选择 .json 文件。
 * - 分享课表/课程提醒：Web 可调用 Android 原生分享面板，分享到微信、QQ、文件等。
 */
class MainActivity : Activity() {
    private companion object {
        const val JWXT_BASE = "http://211.64.47.165"
        const val PREFS = "xiaode_app_v10"
        const val KEY_SERVER = "server_url"
        const val MAX_STATUS_CHARS = 360
        const val FILE_CHOOSER_REQUEST = 2701
        const val CALENDAR_PERMISSION_REQUEST = 2702
        const val STATE_IMPORT_CODE = "state_import_code"
        const val STATE_IMPORT_ACCOUNT = "state_import_account"
        const val STATE_IMPORT_SERVER = "state_import_server"
        const val STATE_IMPORT_TERM_LABEL = "state_import_term_label"
        const val STATE_IMPORT_XNM = "state_import_xnm"
        const val STATE_IMPORT_XQM = "state_import_xqm"
        const val STATE_IMPORT_REPLACE = "state_import_replace"
        const val STATE_IMPORT_CREATED_AT = "state_import_created_at"
        const val STATE_IMPORT_MODE = "state_import_mode"
    }

    private class HttpStatusException(val statusCode: Int, val responseText: String) : IOException("HTTP $statusCode")

    private data class ImportSummary(
        val message: String,
        val savedCount: Int,
        val rawCount: Int,
        val convertedCount: Int,
        val previousCount: Int,
        val replace: Boolean,
        val importedAt: String,
        val accountId: String,
        val traceId: String,
        val recognizedCount: Int,
        val filteredCount: Int,
        val filteredWrongTermCount: Int,
        val filteredUnknownSourceCount: Int,
        val mergedCount: Int,
        val afterCount: Int,
        val requestedTermLabel: String,
        val effectiveTermLabel: String,
        val totalWeeks: Int,
        val totalWeeksSource: String
    )

    private val mainHandler = Handler(Looper.getMainLooper())

    private lateinit var root: LinearLayout
    private lateinit var statusText: TextView
    private lateinit var appPanel: LinearLayout
    private lateinit var importPanel: LinearLayout

    private lateinit var settingsPanel: LinearLayout
    private lateinit var appHeaderRow: LinearLayout
    private lateinit var settingsButton: Button
    private lateinit var copyDiagnosticsButton: Button
    private lateinit var addWidgetButton: Button
    private lateinit var serverInput: EditText
    private lateinit var openServerButton: Button
    private lateinit var reloadAppButton: Button
    private lateinit var homeButton: Button
    private lateinit var appWebView: WebView

    private lateinit var importButton: Button
    private lateinit var reloadJwxtButton: Button
    private lateinit var importMoreButton: Button
    private lateinit var closeImportButton: Button
    private lateinit var importSettingsPanel: LinearLayout
    private lateinit var selectedTermText: TextView
    private lateinit var replaceCheck: CheckBox
    private lateinit var checkJwxtButton: Button
    private lateinit var clearCookieButton: Button
    private lateinit var importWebView: WebView

    private var serverUrl: String = ""
    private var activeImportContext: ImportTaskContext? = null
    private var isBusy = false
    private var inImportMode = false
    private var lastDiagnostics: String = ""
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        configureWebViews()
        loadPrefs()
        bindEvents()

        if (serverUrl.isNotBlank()) {
            openXiaodeWeb(serverUrl)
        } else {
            showServerSettings(true)
            setStatus("欢迎使用小德课表。第一次使用请填写服务器地址，例如 http://10.20.4.13:3001 或 ngrok 地址。")
        }
        restoreImportContext(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        activeImportContext?.let { context ->
            val fields = context.persistedFields()
            outState.putString(STATE_IMPORT_CODE, fields["importCode"])
            outState.putString(STATE_IMPORT_ACCOUNT, fields["accountId"])
            outState.putString(STATE_IMPORT_SERVER, fields["serverBaseUrl"])
            outState.putString(STATE_IMPORT_TERM_LABEL, fields["selectedTermLabel"])
            outState.putString(STATE_IMPORT_XNM, fields["xnm"])
            outState.putString(STATE_IMPORT_XQM, fields["xqm"])
            outState.putBoolean(STATE_IMPORT_REPLACE, context.replace)
            outState.putLong(STATE_IMPORT_CREATED_AT, context.createdAt)
            outState.putBoolean(STATE_IMPORT_MODE, inImportMode)
        }
        super.onSaveInstanceState(outState)
    }

    private fun restoreImportContext(savedState: Bundle?) {
        if (savedState == null) return
        val fields = mapOf(
            "serverBaseUrl" to normalizeServerUrl(savedState.getString(STATE_IMPORT_SERVER, "")),
            "importCode" to savedState.getString(STATE_IMPORT_CODE, "").trim().uppercase(),
            "accountId" to savedState.getString(STATE_IMPORT_ACCOUNT, "").trim(),
            "selectedTermLabel" to savedState.getString(STATE_IMPORT_TERM_LABEL, "").trim(),
            "xnm" to savedState.getString(STATE_IMPORT_XNM, "").trim(),
            "xqm" to savedState.getString(STATE_IMPORT_XQM, "").trim()
        )
        activeImportContext = ImportTaskContext.restore(
            fields,
            replace = savedState.getBoolean(STATE_IMPORT_REPLACE, true),
            createdAt = savedState.getLong(STATE_IMPORT_CREATED_AT, System.currentTimeMillis())
        ) ?: return
        showFrozenTerm(activeImportContext)
        replaceCheck.isChecked = activeImportContext?.replace ?: true
        if (savedState.getBoolean(STATE_IMPORT_MODE, false)) {
            reloadJwxt()
            setStatus("导入账号上下文已恢复。请重新确认教务登录状态后读取上传。")
        }
    }

    private fun buildUi() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) window.statusBarColor = Color.WHITE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR

        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(6), dp(8), dp(6))
            setBackgroundColor(Color.WHITE)
        }

        statusText = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.rgb(48, 48, 48))
            setBackgroundColor(Color.rgb(246, 246, 246))
            setPadding(dp(8), dp(4), dp(8), dp(4))
            maxLines = 2
            visibility = View.GONE
        }

        appPanel = buildAppPanel()
        importPanel = buildImportPanel()

        root.addView(statusText, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        root.addView(appPanel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(importPanel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
    }

    private fun buildAppPanel(): LinearLayout {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.VISIBLE
        }

        appHeaderRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(2), 0, dp(4))
            visibility = View.GONE
        }
        settingsButton = button("服务器")
        copyDiagnosticsButton = button("诊断")
        addWidgetButton = button("组件")
        val spacer = View(this)
        appHeaderRow.addView(spacer, LinearLayout.LayoutParams(0, 1, 1f))
        appHeaderRow.addView(copyDiagnosticsButton, LinearLayout.LayoutParams(dp(70), LinearLayout.LayoutParams.WRAP_CONTENT))
        appHeaderRow.addView(addWidgetButton, LinearLayout.LayoutParams(dp(70), LinearLayout.LayoutParams.WRAP_CONTENT))
        appHeaderRow.addView(settingsButton, LinearLayout.LayoutParams(dp(76), LinearLayout.LayoutParams.WRAP_CONTENT))

        settingsPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(0, dp(2), 0, dp(6))
            setBackgroundColor(Color.rgb(250, 250, 250))
        }
        val settingsTip = TextView(this).apply {
            text = ""
            textSize = 12f
            setTextColor(Color.rgb(92,92,92))
            setPadding(0, 0, 0, 0)
            visibility = View.GONE
        }

        val serverRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(4), 0, dp(6))
        }
        serverInput = edit("小德课表服务器地址", InputType.TYPE_CLASS_TEXT)
        openServerButton = button("打开")
        reloadAppButton = button("刷新")
        homeButton = button("首页")
        serverRow.addView(serverInput, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        serverRow.addView(openServerButton, LinearLayout.LayoutParams(dp(64), LinearLayout.LayoutParams.WRAP_CONTENT))
        serverRow.addView(reloadAppButton, LinearLayout.LayoutParams(dp(64), LinearLayout.LayoutParams.WRAP_CONTENT))
        serverRow.addView(homeButton, LinearLayout.LayoutParams(dp(64), LinearLayout.LayoutParams.WRAP_CONTENT))

        appWebView = WebView(this)
        settingsPanel.addView(settingsTip)
        settingsPanel.addView(serverRow)

        panel.addView(appHeaderRow)
        panel.addView(settingsPanel)
        panel.addView(appWebView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        return panel
    }

    private fun buildImportPanel(): LinearLayout {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(0, dp(4), 0, 0)
        }

        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        importButton = primaryButton("读取上传")
        reloadJwxtButton = button("刷新")
        importMoreButton = button("更多")
        closeImportButton = button("回课表")
        toolbar.addView(importButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.25f))
        toolbar.addView(reloadJwxtButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 0.9f))
        toolbar.addView(importMoreButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 0.8f))
        toolbar.addView(closeImportButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 0.95f))

        importSettingsPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(0, dp(6), 0, dp(6))
            setBackgroundColor(Color.rgb(250, 250, 250))
        }
        selectedTermText = TextView(this).apply {
            text = "学期由课表页明确选择后冻结"
            textSize = 14f
            setTextColor(Color.rgb(70, 70, 70))
            setPadding(dp(10), dp(8), dp(10), dp(8))
        }
        replaceCheck = CheckBox(this).apply {
            text = "覆盖当前账号原课表"
            textSize = 14f
            isChecked = true
            isEnabled = false
        }
        checkJwxtButton = button("检查教务登录状态")
        clearCookieButton = button("清除教务 Cookie")
        importSettingsPanel.addView(selectedTermText)
        importSettingsPanel.addView(replaceCheck)
        importSettingsPanel.addView(checkJwxtButton, fullWidthParams())
        importSettingsPanel.addView(clearCookieButton, fullWidthParams())

        importWebView = WebView(this)
        panel.addView(toolbar)
        panel.addView(importSettingsPanel)
        panel.addView(importWebView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        return panel
    }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    private fun configureWebViews() {
        CookieManager.getInstance().setAcceptCookie(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(appWebView, true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(importWebView, true)
        }

        configureCommonWebView(appWebView, forXiaode = true)
        configureCommonWebView(importWebView, forXiaode = false)

        appWebView.addJavascriptInterface(AndroidBridge(), "XiaoDeAndroid")
        appWebView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (!url.isNullOrBlank() && url != "about:blank") {
                    setStatus("小德课表已打开。登录后点击“功能中心 → 教务导入”。")
                    injectBridgeReadyHint(view)
                }
            }
        }
        appWebView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: WebChromeClient.FileChooserParams?
            ): Boolean {
                return openFileChooser(filePathCallback, fileChooserParams)
            }
        }
        appWebView.setDownloadListener { url, _, _, _, _ ->
            if (url.startsWith("blob:", ignoreCase = true)) {
                notifyWebToast("正在由 App 保存备份文件……")
            } else {
                try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Throwable) {}
            }
        }

        importWebView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (inImportMode && !url.isNullOrBlank() && url != "about:blank") {
                    val cookie = collectJwxtCookies()
                    val cookieTip = if (cookie.isBlank()) "暂未读到 Cookie" else "已读到 Cookie"
                    setStatus("教务系统已打开（$cookieTip）。登录成功后点“读取上传”。")
                    view?.postDelayed({ view.evaluateJavascript("window.scrollTo(0, 0);", null) }, 180)
                }
            }
        }
        importWebView.webChromeClient = WebChromeClient()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureCommonWebView(webView: WebView, forXiaode: Boolean) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = forXiaode
            loadWithOverviewMode = false
            builtInZoomControls = !forXiaode
            displayZoomControls = false
            setSupportZoom(true)
            textZoom = 100
            saveFormData = false
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }
    }

    private fun injectBridgeReadyHint(view: WebView?) {
        view ?: return
        view.evaluateJavascript(
            """
            (function(){
              window.__XIAODE_ANDROID_APP__ = true;
              window.dispatchEvent(new CustomEvent('xiaode-android-ready'));
              try {
                if (window.XiaoDeAndroid && typeof window.downloadJson === 'function' && !window.__xiaodeAndroidDownloadPatched) {
                  window.__xiaodeAndroidDownloadPatched = true;
                  window.__xiaodeOriginalDownloadJson = window.downloadJson;
                  window.downloadJson = function(data, filename){
                    try {
                      var text = JSON.stringify(data, null, 2);
                      window.XiaoDeAndroid.saveBackupFile(filename || 'xiaode-backup.json', text);
                    } catch (err) {
                      window.__xiaodeOriginalDownloadJson(data, filename);
                    }
                  };
                }
              } catch (e) {}
            })();
            """.trimIndent(),
            null
        )
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun syncWidgetData(payload: String) {
            mainHandler.post {
                try {
                    if (payload.isBlank() || payload.length < 10) return@post
                    WidgetDataStore.savePayload(this@MainActivity, payload)
                    XiaoDeWidgetProvider.updateAllWidgets(this@MainActivity)
                } catch (_: Throwable) {
                    // 小组件同步失败不能影响主 App 使用。
                }
            }
        }

        @JavascriptInterface
        fun startImport(payload: String) {
            mainHandler.post {
                try {
                    val json = JSONObject(payload)
                    val code = json.optString("code", "").trim().uppercase()
                    val accountId = json.optString("accountId", "").trim()
                    val selectedTermLabel = json.optString("selectedTermLabel", "").trim()
                    val xnm = json.optString("xnm", "").trim()
                    val xqm = json.optString("xqm", "").trim()
                    val bridgeServer = normalizeServerUrl(json.optString("serverUrl", serverUrl))
                    if (code.length < 6) {
                        setStatus("网页传来的导入码无效，请在网页端重新生成。")
                        return@post
                    }
                    if (accountId.isBlank()) {
                        setStatus("网页没有传来 accountId，请刷新课表页后重新生成导入码。")
                        return@post
                    }
                    if (bridgeServer.isBlank()) {
                        setStatus("网页没有传来服务器地址，请先在 App 顶部打开小德课表服务器。")
                        return@post
                    }
                    if (selectedTermLabel.isBlank() || xnm.isBlank() || xqm.isBlank()) {
                        setStatus("网页没有传来明确的教务学期，请返回课表页重新选择学年和学期。")
                        return@post
                    }
                    serverUrl = bridgeServer
                    activeImportContext = ImportTaskContext(
                        serverBaseUrl = bridgeServer,
                        importCode = code,
                        accountId = accountId,
                        selectedTermLabel = selectedTermLabel,
                        xnm = xnm,
                        xqm = xqm,
                        replace = json.optBoolean("replace", true),
                        createdAt = System.currentTimeMillis()
                    )
                    showFrozenTerm(activeImportContext)
                    replaceCheck.isChecked = activeImportContext?.replace ?: true
                    serverInput.setText(serverUrl)
                    saveServer()
                    hideKeyboard()
                    showImportScreen()
                    setStatus("已自动接收导入码 $code。请在下方教务系统网页登录，完成后点“读取上传”。")
                    reloadJwxt()
                } catch (e: Exception) {
                    setStatus("接收网页导入码失败：${e.message ?: e.javaClass.simpleName}")
                }
            }
        }

        @JavascriptInterface
        fun saveBackupFile(filename: String, content: String) {
            Thread {
                try {
                    val savedTo = saveTextAsDownload(filename, content)
                    mainHandler.post {
                        notifyWebToast("备份已保存：$savedTo")
                        setStatus("备份已保存：$savedTo")
                    }
                } catch (t: Throwable) {
                    mainHandler.post {
                        notifyWebToast("备份保存失败：${humanizeError(t)}")
                        setStatus("备份保存失败：${humanizeError(t)}")
                    }
                }
            }.start()
        }

        @JavascriptInterface
        fun shareTextFile(filename: String, content: String, mimeType: String) {
            mainHandler.post {
                try {
                    shareTextAsFile(filename, content, mimeType)
                } catch (t: Throwable) {
                    notifyWebToast("分享失败：${humanizeError(t)}")
                    setStatus("分享失败：${humanizeError(t)}")
                }
            }
        }


        @JavascriptInterface
        fun hasCalendarPermission(): Boolean {
            return this@MainActivity.hasCalendarPermission()
        }

        @JavascriptInterface
        fun requestCalendarPermission() {
            mainHandler.post { requestCalendarPermissionFromWeb() }
        }

        @JavascriptInterface
        fun listCalendars(): String {
            return try {
                listWritableCalendarsJson().toString()
            } catch (t: Throwable) {
                JSONObject()
                    .put("ok", false)
                    .put("message", humanizeError(t))
                    .put("calendars", JSONArray())
                    .toString()
            }
        }

        @JavascriptInterface
        fun syncCourseReminders(payload: String) {
            Thread {
                val result = try {
                    syncCourseRemindersToCalendar(payload)
                } catch (t: Throwable) {
                    JSONObject()
                        .put("ok", false)
                        .put("message", humanizeError(t))
                }
                mainHandler.post {
                    dispatchWebEvent("xiaode-calendar-sync-result", result)
                    if (result.optBoolean("ok")) {
                        val inserted = result.optInt("inserted", 0)
                        val deleted = result.optInt("deleted", 0)
                        setStatus("课程提醒已写入系统日历：新增 $inserted 个，清理旧提醒 $deleted 个。")
                    } else {
                        val message = result.optString("message", "未知错误")
                        setStatus("课程提醒同步失败：$message")
                    }
                }
            }.start()
        }
    }


    private fun hasCalendarPermission(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            (checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED &&
                checkSelfPermission(Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED)
    }

    private fun requestCalendarPermissionFromWeb() {
        if (hasCalendarPermission()) {
            dispatchWebEvent("xiaode-calendar-permission", JSONObject().put("granted", true))
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(
                arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR),
                CALENDAR_PERMISSION_REQUEST
            )
        }
    }

    private fun dispatchWebEvent(eventName: String, detail: JSONObject) {
        if (!::appWebView.isInitialized) return
        val script = """
            (function(){
              try {
                window.dispatchEvent(new CustomEvent(${JSONObject.quote(eventName)}, { detail: $detail }));
              } catch(e) {}
            })();
        """.trimIndent()
        try { appWebView.post { appWebView.evaluateJavascript(script, null) } } catch (_: Throwable) {}
    }

    private fun listWritableCalendarsJson(): JSONObject {
        if (!hasCalendarPermission()) {
            return JSONObject()
                .put("ok", false)
                .put("message", "需要先允许日历权限。")
                .put("calendars", JSONArray())
        }
        val calendars = JSONArray()
        val projection = arrayOf(
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.ACCOUNT_NAME,
            CalendarContract.Calendars.OWNER_ACCOUNT,
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
            CalendarContract.Calendars.VISIBLE,
            CalendarContract.Calendars.IS_PRIMARY
        )
        val selection = "${CalendarContract.Calendars.VISIBLE}!=0 AND ${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL}>=?"
        val args = arrayOf(CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR.toString())
        contentResolver.query(CalendarContract.Calendars.CONTENT_URI, projection, selection, args, null)?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(CalendarContract.Calendars._ID)
            val nameIndex = cursor.getColumnIndexOrThrow(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME)
            val accountIndex = cursor.getColumnIndexOrThrow(CalendarContract.Calendars.ACCOUNT_NAME)
            val ownerIndex = cursor.getColumnIndexOrThrow(CalendarContract.Calendars.OWNER_ACCOUNT)
            val accessIndex = cursor.getColumnIndexOrThrow(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL)
            val primaryIndex = cursor.getColumnIndex(CalendarContract.Calendars.IS_PRIMARY)
            while (cursor.moveToNext()) {
                val id = cursor.getLong(idIndex)
                val name = cursor.getString(nameIndex).orEmpty().ifBlank { cursor.getString(accountIndex).orEmpty().ifBlank { "日历 $id" } }
                calendars.put(
                    JSONObject()
                        .put("id", id.toString())
                        .put("name", name)
                        .put("account", cursor.getString(accountIndex).orEmpty())
                        .put("owner", cursor.getString(ownerIndex).orEmpty())
                        .put("accessLevel", cursor.getInt(accessIndex))
                        .put("primary", primaryIndex >= 0 && cursor.getInt(primaryIndex) == 1)
                )
            }
        }
        return JSONObject()
            .put("ok", true)
            .put("calendars", calendars)
            .put("message", if (calendars.length() > 0) "已读取可写入日历。" else "没有找到可写入的日历。请先打开系统日历并添加一个本地或账号日历。")
    }

    private fun syncCourseRemindersToCalendar(payload: String): JSONObject {
        if (!hasCalendarPermission()) throw IOException("需要先允许日历权限。")
        val json = JSONObject(payload)
        val accountId = json.optString("accountId", "").trim()
        if (accountId.isBlank()) throw IOException("提醒数据缺少 accountId。")
        val calendarId = json.optString("calendarId").toLongOrNull() ?: json.optLong("calendarId", -1L)
        if (calendarId <= 0L) throw IOException("没有选择目标日历。")
        val events = json.optJSONArray("events") ?: JSONArray()
        if (events.length() == 0) throw IOException("没有可写入的课程提醒。")

        val accountMarker = "XIAODE_ACCOUNT::$accountId"
        val deleted = deleteOldXiaodeEvents(calendarId, accountMarker)
        var inserted = 0
        val timezone = TimeZone.getDefault().id
        for (i in 0 until events.length()) {
            val item = events.optJSONObject(i) ?: continue
            var startMs = item.optLong("startMs", 0L)
            var endMs = item.optLong("endMs", 0L)
            if (startMs <= 0L) continue
            if (endMs <= startMs) endMs = startMs + 5 * 60 * 1000L
            val title = item.optString("title", "课程提醒").ifBlank { "课程提醒" }.take(120)
            val location = item.optString("location", "")
            var description = item.optString("description", "")
            if (!description.contains(accountMarker)) {
                description = description.trim() + "\n$accountMarker"
            }
            if (!description.contains("XIAODE_REMINDER::")) {
                val fp = item.optString("fingerprint", "${System.currentTimeMillis()}-$i")
                description = description.trim() + "\nXIAODE_REMINDER::$fp"
            }
            val alarmMinutes = item.optInt("alarmMinutes", 0).coerceIn(0, 24 * 60)
            val values = ContentValues().apply {
                put(CalendarContract.Events.CALENDAR_ID, calendarId)
                put(CalendarContract.Events.TITLE, title)
                put(CalendarContract.Events.DTSTART, startMs)
                put(CalendarContract.Events.DTEND, endMs)
                put(CalendarContract.Events.EVENT_TIMEZONE, timezone)
                put(CalendarContract.Events.EVENT_LOCATION, location)
                put(CalendarContract.Events.DESCRIPTION, description)
                put(CalendarContract.Events.HAS_ALARM, 1)
                put(CalendarContract.Events.ALL_DAY, 0)
                put(CalendarContract.Events.AVAILABILITY, CalendarContract.Events.AVAILABILITY_BUSY)
            }
            val eventUri = contentResolver.insert(CalendarContract.Events.CONTENT_URI, values) ?: continue
            val eventId = ContentUris.parseId(eventUri)
            val reminderValues = ContentValues().apply {
                put(CalendarContract.Reminders.EVENT_ID, eventId)
                put(CalendarContract.Reminders.MINUTES, alarmMinutes)
                put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
            }
            contentResolver.insert(CalendarContract.Reminders.CONTENT_URI, reminderValues)
            inserted++
        }
        return JSONObject()
            .put("ok", true)
            .put("inserted", inserted)
            .put("deleted", deleted)
            .put("message", "课程提醒已写入系统日历。")
    }

    private fun deleteOldXiaodeEvents(calendarId: Long, accountMarker: String): Int {
        val projection = arrayOf(CalendarContract.Events._ID, CalendarContract.Events.DESCRIPTION)
        val selection = "${CalendarContract.Events.CALENDAR_ID}=? AND ${CalendarContract.Events.DESCRIPTION} LIKE ?"
        val args = arrayOf(calendarId.toString(), "%XIAODE_REMINDER::%")
        var deleted = 0
        contentResolver.query(CalendarContract.Events.CONTENT_URI, projection, selection, args, null)?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(CalendarContract.Events._ID)
            val descriptionIndex = cursor.getColumnIndexOrThrow(CalendarContract.Events.DESCRIPTION)
            while (cursor.moveToNext()) {
                val description = cursor.getString(descriptionIndex).orEmpty()
                if (!description.contains(accountMarker)) continue
                val eventUri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, cursor.getLong(idIndex))
                deleted += contentResolver.delete(eventUri, null, null)
            }
        }
        return deleted
    }

    private fun openFileChooser(
        callback: ValueCallback<Array<Uri>>?,
        params: WebChromeClient.FileChooserParams?
    ): Boolean {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = callback
        return try {
            val intent = params?.createIntent() ?: Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/json"
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/json", "text/plain"))
            }
            startActivityForResult(intent, FILE_CHOOSER_REQUEST)
            true
        } catch (t: Throwable) {
            filePathCallback?.onReceiveValue(null)
            filePathCallback = null
            notifyWebToast("无法打开文件选择器：${humanizeError(t)}")
            false
        }
    }


    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == CALENDAR_PERMISSION_REQUEST) {
            val granted = hasCalendarPermission()
            dispatchWebEvent("xiaode-calendar-permission", JSONObject().put("granted", granted))
            setStatus(if (granted) "已获得日历权限，可以选择提醒方式并写入系统日历。" else "没有获得日历权限，课程提醒只能导出 .ics 文件。")
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_CHOOSER_REQUEST) {
            val result = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            filePathCallback?.onReceiveValue(result)
            filePathCallback = null
        }
    }

    private fun shareTextAsFile(filename: String, content: String, mimeType: String) {
        val safeName = sanitizeShareFilename(filename)
        val shareDir = File(cacheDir, "xiaode_share")
        if (!shareDir.exists()) shareDir.mkdirs()
        val file = File(shareDir, safeName)
        FileOutputStream(file).use { it.write(content.toByteArray(StandardCharsets.UTF_8)) }
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val cleanMime = mimeType.substringBefore(';').ifBlank { "application/octet-stream" }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = cleanMime
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, safeName)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(intent, "分享小德课表文件"))
        setStatus("已打开系统分享面板：$safeName")
    }

    private fun saveTextAsDownload(filename: String, content: String): String {
        val safeName = sanitizeFilename(filename.ifBlank { "xiaode-backup.json" })
        val bytes = content.toByteArray(StandardCharsets.UTF_8)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                put(MediaStore.Downloads.MIME_TYPE, "application/json")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IOException("无法创建下载文件")
            try {
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: throw IOException("无法写入下载文件")
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
                return "下载/$safeName"
            } catch (t: Throwable) {
                try { contentResolver.delete(uri, null, null) } catch (_: Throwable) {}
                throw t
            }
        }

        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
        if (!dir.exists()) dir.mkdirs()
        val file = File(dir, safeName)
        FileOutputStream(file).use { it.write(bytes) }
        return file.absolutePath
    }

    private fun sanitizeFilename(name: String): String {
        val clean = name.replace(Regex("[\\/:*?\"<>|]"), "_").trim().ifBlank { "xiaode-backup.json" }
        return if (clean.endsWith(".json", ignoreCase = true)) clean else "$clean.json"
    }

    private fun sanitizeShareFilename(name: String): String {
        val clean = name.replace(Regex("[\\/:*?\"<>|]"), "_").trim().ifBlank { "xiaode-share.txt" }
        return clean.take(80)
    }

    private fun notifyWebToast(message: String) {
        try {
            if (::appWebView.isInitialized) {
                val script = "try{ if(typeof toast==='function') toast(" + JSONObject.quote(message) + "); }catch(e){}"
                appWebView.post { appWebView.evaluateJavascript(script, null) }
            }
        } catch (_: Throwable) {}
    }

    private fun bindEvents() {
        settingsButton.setOnClickListener { showServerSettings(settingsPanel.visibility != View.VISIBLE) }
        copyDiagnosticsButton.setOnClickListener { copyDiagnostics() }
        addWidgetButton.setOnClickListener { requestPinWidget() }
        openServerButton.setOnClickListener { openServerFromInput() }
        reloadAppButton.setOnClickListener { if (serverUrl.isNotBlank()) appWebView.reload() else openServerFromInput() }
        homeButton.setOnClickListener { if (serverUrl.isNotBlank()) openXiaodeWeb(serverUrl) else openServerFromInput() }
        importButton.setOnClickListener { fetchAndUploadSchedule() }
        reloadJwxtButton.setOnClickListener { reloadJwxt() }
        importMoreButton.setOnClickListener { toggleImportMore() }
        closeImportButton.setOnClickListener { exitImportScreen("已返回小德课表。") }
        checkJwxtButton.setOnClickListener { checkJwxtLoginState() }
        clearCookieButton.setOnClickListener { clearJwxtCookies() }
    }

    private fun requestPinWidget() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = getSystemService(AppWidgetManager::class.java)
                val provider = ComponentName(this, XiaoDeWidgetProvider::class.java)
                if (manager != null && manager.isRequestPinAppWidgetSupported) {
                    manager.requestPinAppWidget(provider, null, null)
                    setStatus("已请求添加桌面小组件。若桌面弹出确认，请点允许；如果没有弹出，可长按桌面空白处 → 小组件 → 小德课表。")
                    return
                }
            }
            setStatus("当前桌面不支持 App 内一键添加。请长按桌面空白处 → 小组件/插件 → 小德课表。")
        } catch (t: Throwable) {
            setStatus("添加小组件请求失败：${t.message ?: t.javaClass.simpleName}。可长按桌面空白处手动添加。")
        }
    }

    private fun loadPrefs() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        serverUrl = prefs.getString(KEY_SERVER, "") ?: ""
        serverInput.setText(serverUrl)
    }

    private fun saveServer() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, serverUrl).apply()
    }

    private fun openServerFromInput() {
        val cleanServer = normalizeServerUrl(serverInput.text.toString())
        if (cleanServer.isBlank()) {
            setStatus("请填写小德课表服务器地址。")
            return
        }
        serverUrl = cleanServer
        saveServer()
        openXiaodeWeb(serverUrl)
    }

    private fun openXiaodeWeb(url: String) {
        showAppScreen()
        serverInput.setText(url)
        setStatus("正在打开小德课表：$url")
        appWebView.loadUrl(url)
        showServerSettings(false)
    }

    private fun reloadJwxt() {
        showImportScreen()
        setStatus("正在打开教务系统。教务密码只在网页中输入，App 不保存。")
        importWebView.loadUrl(JWXT_BASE)
    }

    private fun showFrozenTerm(context: ImportTaskContext?) {
        if (!::selectedTermText.isInitialized) return
        selectedTermText.text = if (context == null) {
            "学期由课表页明确选择后冻结"
        } else {
            "本次请求：${context.selectedTermLabel}（xnm=${context.xnm}，xqm=${context.xqm}）"
        }
    }

    private fun fetchAndUploadSchedule() {
        // 整个异步任务只使用开始时冻结的上下文，不再读取全局当前账号或可编辑输入框。
        val context = activeImportContext
        if (context == null) {
            setStatus("导入上下文不存在，请回到课表页重新生成导入码。")
            return
        }
        val cleanServer = context.serverBaseUrl
        val codeForImport = context.importCode
        val accountIdForImport = context.accountId
        if (cleanServer.isBlank() || codeForImport.length < 6) {
            setStatus("没有有效导入码。请回到小德课表网页，点击“功能中心 → 教务导入”。")
            return
        }
        if (accountIdForImport.isBlank()) {
            setStatus("导入上下文缺少 accountId，请回到课表页重新生成导入码。")
            return
        }

        val xnm = context.xnm
        val xqm = context.xqm
        CookieManager.getInstance().flush()
        val cookie = collectJwxtCookies()
        if (cookie.isBlank()) {
            setStatus("还没有读到教务系统 Cookie。请先在下方 WebView 完成教务系统登录。")
            return
        }

        runAsync("正在读取教务系统课表并上传……", {
            val raw = fetchJwxtSchedule(cookie, xnm, xqm)
            val body = JSONObject()
                .put("jwxtData", raw)
                .put("accountId", accountIdForImport)
                .put("selectedTermLabel", context.selectedTermLabel)
                .put("xnm", context.xnm)
                .put("xqm", context.xqm)
                .put("replace", context.replace)
            val upload = postJson("$cleanServer/api/import-code/$codeForImport/submit", body)
            if (!upload.optBoolean("ok")) throw IOException(upload.optString("message", "上传失败"))
            val resultSummary = upload.optJSONObject("summary") ?: JSONObject()
            val saved = resultSummary.optInt("written", upload.optInt("count", 0))
            val rawCount = resultSummary.optInt("received", upload.optInt("rawCount", 0))
            val convertedCount = resultSummary.optInt("accepted", upload.optInt("convertedCount", saved))
            val previousCount = upload.optInt("previousCount", -1)
            val serverMessage = upload.optString("message", "")
            val requestedTerm = upload.optJSONObject("requestedTerm") ?: JSONObject()
            val effectiveTerm = upload.optJSONObject("effectiveTerm") ?: JSONObject()
            ImportSummary(
                message = if (serverMessage.isNotBlank()) serverMessage else "读取 $rawCount 条原始课表记录，已保存 $saved 条课程。",
                savedCount = saved,
                rawCount = rawCount,
                convertedCount = convertedCount,
                previousCount = previousCount,
                replace = upload.optBoolean("replace", context.replace),
                importedAt = upload.optString("importedAt", ""),
                accountId = accountIdForImport,
                traceId = upload.optString("traceId", ""),
                recognizedCount = resultSummary.optInt("recognized", convertedCount),
                filteredCount = resultSummary.optInt("filtered", 0),
                filteredWrongTermCount = resultSummary.optInt("filteredWrongTermCount", 0),
                filteredUnknownSourceCount = resultSummary.optInt("filteredUnknownSourceCount", 0),
                mergedCount = resultSummary.optInt("merged", 0),
                afterCount = resultSummary.optInt("afterCount", upload.optInt("afterCount", saved)),
                requestedTermLabel = requestedTerm.optString("label", context.selectedTermLabel),
                effectiveTermLabel = effectiveTerm.optString("label", ""),
                totalWeeks = upload.optInt("totalWeeks", 0),
                totalWeeksSource = upload.optString("totalWeeksSource", "")
            )
        }) { summary ->
            serverUrl = cleanServer
            saveServer()
            activeImportContext = null
            clearJwxtCookiesSilently()
            exitImportScreen("导入成功：${summary.message} 已自动返回课表页；仅在该账号仍为当前账号时刷新。")
            notifyXiaodeWebImportSuccess(summary)
            showImportSuccessDialog(summary)
        }
    }

    private fun notifyXiaodeWebImportSuccess(summary: ImportSummary) {
        if (!::appWebView.isInitialized) return
        val detail = JSONObject()
            .put("accountId", summary.accountId)
            .put("traceId", summary.traceId)
            .put("savedCount", summary.savedCount)
            .put("rawCount", summary.rawCount)
            .put("convertedCount", summary.convertedCount)
            .put("previousCount", summary.previousCount)
            .put("replace", summary.replace)
            .put("importedAt", summary.importedAt)
            .put("message", summary.message)
            .put("requestedTerm", summary.requestedTermLabel)
            .put("effectiveTerm", summary.effectiveTermLabel)
            .put("summary", JSONObject()
                .put("received", summary.rawCount)
                .put("recognized", summary.recognizedCount)
                .put("accepted", summary.convertedCount)
                .put("filtered", summary.filteredCount)
                .put("filteredWrongTermCount", summary.filteredWrongTermCount)
                .put("filteredUnknownSourceCount", summary.filteredUnknownSourceCount)
                .put("merged", summary.mergedCount)
                .put("written", summary.savedCount)
                .put("beforeCount", summary.previousCount)
                .put("afterCount", summary.afterCount))
        val script = """
            (function(){
              window.__xiaodeLastImportSummary = $detail;
              window.dispatchEvent(new CustomEvent('xiaode-import-success', { detail: $detail }));
            })();
        """.trimIndent()
        try { appWebView.evaluateJavascript(script, null) } catch (_: Throwable) {}
    }

    private fun requestWidgetSyncFromWeb() {
        if (!::appWebView.isInitialized) return
        val script = """
            (function(){
              try {
                if (typeof window.__xiaodeSyncWidgetNow === 'function') {
                  window.__xiaodeSyncWidgetNow('android-request');
                }
              } catch(e) {}
            })();
        """.trimIndent()
        try {
            appWebView.postDelayed({ appWebView.evaluateJavascript(script, null) }, 900)
            appWebView.postDelayed({ appWebView.evaluateJavascript(script, null) }, 2200)
        } catch (_: Throwable) {}
    }

    private fun showImportSuccessDialog(summary: ImportSummary) {
        val lines = buildString {
            appendLine("导入成功")
            appendLine("本次请求：${summary.requestedTermLabel}")
            appendLine("实际返回：${summary.effectiveTermLabel.ifBlank { "教务响应未提供学期字段" }}")
            appendLine("原始课表记录：${summary.rawCount} 条")
            appendLine("成功识别候选：${summary.recognizedCount} 条")
            appendLine("写入小德课表：${summary.savedCount} 条")
            appendLine("合并：${summary.mergedCount} 条；过滤：${summary.filteredCount} 条")
            appendLine("过滤其他学期：${summary.filteredWrongTermCount} 条；过滤未知来源：${summary.filteredUnknownSourceCount} 条")
            if (summary.totalWeeks > 0) appendLine("学期总周数：${summary.totalWeeks}（${summary.totalWeeksSource.ifBlank { "已保存" }}）")
            if (summary.previousCount >= 0) appendLine("导入前原课程：${summary.previousCount} 条")
            if (summary.afterCount >= 0) appendLine("导入后当前账号课程：${summary.afterCount} 条")
            appendLine("模式：${if (summary.replace) "覆盖导入" else "追加导入"}")
            if (summary.traceId.isNotBlank()) appendLine("诊断编号：${summary.traceId}")
            if (summary.importedAt.isNotBlank()) appendLine("时间：${summary.importedAt}")
        }
        try {
            AlertDialog.Builder(this)
                .setTitle("小德课表")
                .setMessage(lines)
                .setPositiveButton("回到课表", null)
                .setNegativeButton("复制诊断") { _, _ -> copyDiagnostics() }
                .show()
        } catch (_: Throwable) {
            setStatus(lines)
        }
    }

    private fun safeRefreshXiaodeWeb() {
        if (!::appWebView.isInitialized) return
        appWebView.postDelayed({
            try {
                if (appWebView.url.isNullOrBlank() || appWebView.url == "about:blank") {
                    if (serverUrl.isNotBlank()) appWebView.loadUrl(serverUrl)
                } else {
                    appWebView.reload()
                }
            } catch (t: Throwable) {
                setStatus("导入成功，但自动刷新课表失败：${humanizeError(t)}。可手动点顶部刷新。")
            }
        }, 350)
    }

    private fun checkJwxtLoginState() {
        CookieManager.getInstance().flush()
        val cookie = collectJwxtCookies()
        if (cookie.isBlank()) {
            setStatus("未检测到教务系统 Cookie。请先在教务网页登录；若已登录，点一次教务首页或刷新。")
            return
        }
        val context = activeImportContext
        if (context == null) {
            setStatus("缺少冻结的导入学期，请返回课表页重新选择。")
            return
        }
        val xnm = context.xnm
        val xqm = context.xqm
        runAsync("正在检查教务课表接口……", {
            val raw = fetchJwxtSchedule(cookie, xnm, xqm)
            val kbList = raw.optJSONArray("kbList") ?: JSONArray()
            if (kbList.length() > 0) {
                "✅ 教务登录有效。当前 xnm=$xnm, xqm=$xqm，读取到 ${kbList.length()} 条原始记录。"
            } else {
                "⚠️ 课表接口可访问，但 kbList 为空。可能学年学期不对，或该学期没有课。"
            }
        }) { result -> setStatus(result) }
    }

    private fun fetchJwxtSchedule(cookie: String, xnm: String, xqm: String): JSONObject {
        val payload = formBody(
            "xnm" to xnm,
            "xqm" to xqm,
            "kzlx" to "ck",
            "xsdm" to "",
            "kclbdm" to ""
        )
        val text = request(
            method = "POST",
            url = "$JWXT_BASE/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151",
            headers = mapOf(
                "Content-Type" to "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With" to "XMLHttpRequest",
                "Accept" to "application/json, text/javascript, */*; q=0.01",
                "Referer" to "$JWXT_BASE/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151",
                "Cookie" to cookie
            ),
            body = payload.toByteArray(StandardCharsets.UTF_8)
        )
        return try {
            JSONObject(text)
        } catch (e: Exception) {
            val sample = text.replace(Regex("\\s+"), " ").take(180)
            val loginHint = when {
                text.contains("登录", ignoreCase = true) || text.contains("login", ignoreCase = true) -> "返回内容像登录页，说明教务登录可能失效或 Cookie 没带上。"
                text.startsWith("<") -> "返回内容是 HTML，不是 JSON，可能被重定向到网页。"
                else -> "返回内容不是 JSON。"
            }
            throw IOException("课表接口异常：$loginHint 返回片段：$sample")
        }
    }

    private fun postJson(url: String, body: JSONObject): JSONObject {
        val headers = linkedMapOf(
            "Content-Type" to "application/json; charset=UTF-8",
            "Accept" to "application/json",
            "ngrok-skip-browser-warning" to "true"
        )
        val text = try {
            request("POST", url, headers, body.toString().toByteArray(StandardCharsets.UTF_8))
        } catch (e: HttpStatusException) {
            val message = parseServerMessage(e.responseText)
            throw IOException(if (message.isBlank()) "小德后端返回 HTTP ${e.statusCode}。" else "$message（HTTP ${e.statusCode}）")
        }
        return try {
            JSONObject(text)
        } catch (e: Exception) {
            throw IOException("小德课表后端没有返回 JSON。返回片段：${text.take(180)}")
        }
    }

    private fun request(method: String, url: String, headers: Map<String, String>, body: ByteArray?): String {
        val conn = try {
            (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 20_000
                readTimeout = 30_000
                instanceFollowRedirects = true
                for ((k, v) in headers) setRequestProperty(k, v)
                if (body != null) {
                    doOutput = true
                    setFixedLengthStreamingMode(body.size)
                }
            }
        } catch (e: MalformedURLException) {
            throw IOException("地址格式不正确：$url。")
        }

        try {
            if (body != null) conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            val text = readText(if (code in 200..299) conn.inputStream else conn.errorStream)
            if (code !in 200..299) throw HttpStatusException(code, text)
            return text
        } catch (e: HttpStatusException) {
            throw e
        } catch (e: UnknownHostException) {
            throw IOException("找不到服务器：${URL(url).host}。检查地址、热点、ngrok 是否有效。")
        } catch (e: SocketTimeoutException) {
            throw IOException("连接超时。可能是服务器没启动、网络慢、防火墙阻止，或教务系统不可达。")
        } catch (e: ConnectException) {
            throw IOException("连接失败。请确认 backend 正在运行，端口是 3001，Windows 防火墙允许 Node.js。")
        } catch (e: SSLException) {
            throw IOException("HTTPS 连接失败。若使用 ngrok，请确认地址完整且以 https:// 开头。")
        } catch (e: IOException) {
            val msg = e.message ?: e.javaClass.simpleName
            if (msg.contains("CLEARTEXT", ignoreCase = true) || msg.contains("Cleartext", ignoreCase = true)) {
                throw IOException("Android 拦截了 HTTP 明文请求。请确认 network_security_config 已启用。")
            }
            throw IOException(msg)
        } finally {
            conn.disconnect()
        }
    }

    private fun readText(stream: InputStream?): String {
        if (stream == null) return ""
        BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { reader ->
            return reader.readText()
        }
    }

    private fun collectJwxtCookies(): String {
        val manager = CookieManager.getInstance()
        val candidates = listOf(
            "$JWXT_BASE/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151",
            "$JWXT_BASE/jwglxt/xtgl/index_initMenu.html",
            "$JWXT_BASE/jwglxt/",
            JWXT_BASE
        )
        val parts = LinkedHashSet<String>()
        for (url in candidates) {
            val raw = manager.getCookie(url) ?: continue
            raw.split(';').map { it.trim() }.filter { it.isNotBlank() }.forEach { parts.add(it) }
        }
        return parts.joinToString("; ")
    }

    private fun formBody(vararg pairs: Pair<String, String>): String = pairs.joinToString("&") { (k, v) ->
        "${URLEncoder.encode(k, "UTF-8")}" + "=" + URLEncoder.encode(v, "UTF-8")
    }

    private fun normalizeServerUrl(raw: String): String {
        val trimmed = raw.trim().trimEnd('/')
        if (trimmed.isBlank()) return ""
        return when {
            trimmed.startsWith("http://") || trimmed.startsWith("https://") -> trimmed
            trimmed.contains("ngrok", ignoreCase = true) -> "https://$trimmed"
            else -> "http://$trimmed"
        }
    }

    private fun parseServerMessage(text: String): String {
        return try {
            JSONObject(text).optString("message", "")
        } catch (_: Exception) {
            text.replace(Regex("\\s+"), " ").take(160)
        }
    }

    private fun humanizeError(t: Throwable): String {
        val msg = t.message ?: t.javaClass.simpleName
        return when {
            msg.contains("Failed to connect", ignoreCase = true) || msg.contains("连接失败") -> "连接失败：后端可能没启动、防火墙没放行，或服务器地址/IP 变了。"
            msg.contains("timeout", ignoreCase = true) || msg.contains("超时") -> "连接超时：检查网络、VPN/梯子、手机热点，或稍后重试。"
            msg.contains("Unable to resolve", ignoreCase = true) || msg.contains("找不到服务器") -> "找不到服务器：检查地址拼写、ngrok 是否还有效。"
            msg.contains("HTTP 401") -> "登录态失效或导入码无效：请在小德课表网页重新生成导入码。"
            msg.contains("HTTP 403") -> "被拒绝访问：可能是导入码过期、已被使用，或后端拒绝。"
            msg.contains("HTTP 404") -> "接口不存在：请确认网页后端已经换成支持导入码的版本。"
            msg.contains("HTTP 500") -> "后端内部错误：看 VS Code 终端红色报错。"
            else -> msg
        }
    }

    private fun clearJwxtCookies() {
        clearJwxtCookiesSilently()
        setStatus("已清除教务系统 Cookie。小德课表登录态会保留。")
    }

    /**
     * 只清理教务系统 Cookie，不再调用 removeAllCookies() / WebStorage.deleteAllData()。
     *
     * v8 里为了安全用了全局清理，但 Android 的 CookieManager 和 WebStorage 是整个 App 共享的，
     * 会把小德课表 WebView 里的登录 Cookie / localStorage 也一起清掉，导致导入后回课表需要重新登录。
     * 这里改成只把 211.64.47.165 相关 Cookie 逐个过期，避免误伤小德课表网页登录态。
     */
    private fun clearJwxtCookiesSilently() {
        try {
            val manager = CookieManager.getInstance()
            val jwxtUrls = listOf(
                JWXT_BASE,
                "$JWXT_BASE/",
                "$JWXT_BASE/jwglxt/",
                "$JWXT_BASE/jwglxt/xtgl/login_slogin.html",
                "$JWXT_BASE/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151"
            )
            val names = LinkedHashSet<String>()
            for (url in jwxtUrls) {
                val raw = manager.getCookie(url) ?: continue
                raw.split(';')
                    .map { it.trim() }
                    .filter { it.contains('=') }
                    .map { it.substringBefore('=').trim() }
                    .filter { it.isNotBlank() }
                    .forEach { names.add(it) }
            }

            for (name in names) {
                val expired = "$name=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/"
                manager.setCookie(JWXT_BASE, expired)
                manager.setCookie("$JWXT_BASE/", expired)
                manager.setCookie("$JWXT_BASE/jwglxt/", expired)
            }
            manager.flush()

            if (::importWebView.isInitialized) {
                importWebView.clearHistory()
                importWebView.clearCache(false)
            }
        } catch (_: Throwable) {
            // 清理失败不影响导入结果，也不能因此让 App 崩溃。
        }
    }

    private fun toggleImportMore() {
        importSettingsPanel.visibility = if (importSettingsPanel.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }

    private fun showImportScreen() {
        inImportMode = true
        statusText.maxLines = 2
        appPanel.visibility = View.GONE
        importPanel.visibility = View.VISIBLE
    }

    private fun showAppScreen() {
        inImportMode = false
        statusText.maxLines = 3
        importPanel.visibility = View.GONE
        appPanel.visibility = View.VISIBLE
        if (serverUrl.isBlank()) showServerSettings(true) else showServerSettings(false)
    }

    private fun showServerSettings(show: Boolean) {
        if (::appHeaderRow.isInitialized) {
            appHeaderRow.visibility = if (show) View.VISIBLE else View.GONE
        }
        if (::settingsPanel.isInitialized) {
            settingsPanel.visibility = if (show) View.VISIBLE else View.GONE
        }
    }

    private fun exitImportScreen(message: String) {
        inImportMode = false
        activeImportContext = null
        showFrozenTerm(null)
        try {
            if (::importWebView.isInitialized) {
                importWebView.stopLoading()
                importWebView.loadUrl("about:blank")
            }
        } catch (_: Throwable) {
            // 不让 WebView 状态异常影响返回课表页。
        }
        showAppScreen()
        setStatus(message)
    }

    private fun <T> runAsync(message: String, work: () -> T, onSuccess: (T) -> Unit) {
        if (isBusy) return
        setBusy(true)
        setStatus(message)
        Thread {
            try {
                val result = work()
                mainHandler.post {
                    try {
                        setBusy(false)
                        onSuccess(result)
                    } catch (t: Throwable) {
                        setBusy(false)
                        setStatus("结果已返回，但界面更新失败：${humanizeError(t)}")
                    }
                }
            } catch (t: Throwable) {
                mainHandler.post {
                    setBusy(false)
                    setStatus("失败：${humanizeError(t)}")
                }
            }
        }.start()
    }

    private fun setBusy(busy: Boolean) {
        isBusy = busy
        val enabled = !busy
        openServerButton.isEnabled = enabled
        reloadAppButton.isEnabled = enabled
        homeButton.isEnabled = enabled
        importButton.isEnabled = enabled
        reloadJwxtButton.isEnabled = enabled
        importMoreButton.isEnabled = enabled
        closeImportButton.isEnabled = enabled
        checkJwxtButton.isEnabled = enabled
        clearCookieButton.isEnabled = enabled
    }

    private fun setStatus(text: String) {
        statusText.text = if (text.length > MAX_STATUS_CHARS) text.take(MAX_STATUS_CHARS) + "…" else text
        statusText.visibility = if (inImportMode || (serverUrl.isBlank() && text.contains("服务器"))) View.VISIBLE else View.GONE
        lastDiagnostics = buildDiagnosticText(text)
    }

    private fun copyDiagnostics() {
        val text = if (lastDiagnostics.isBlank()) buildDiagnosticText(statusText.text?.toString() ?: "") else lastDiagnostics
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("小德课表诊断信息", text))
            setStatus("诊断信息已复制，可以发给开发者排查。")
        } catch (e: Exception) {
            setStatus("复制诊断信息失败：${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun buildDiagnosticText(currentStatus: String): String = buildString {
        appendLine("小德课表 App v31 · Web v41 学期隔离与动态周数版")
        appendLine("serverUrl=${serverUrl.ifBlank { serverInput.text?.toString() ?: "" }}")
        appendLine("appUrl=${if (::appWebView.isInitialized) appWebView.url else ""}")
        appendLine("importMode=$inImportMode")
        appendLine("hasImportCode=${activeImportContext?.importCode?.isNotBlank() == true}")
        appendLine("hasImportAccount=${activeImportContext?.accountId?.isNotBlank() == true}")
        appendLine("selectedTermLabel=${activeImportContext?.selectedTermLabel ?: ""}")
        appendLine("xnm=${activeImportContext?.xnm ?: ""}")
        appendLine("xqm=${activeImportContext?.xqm ?: ""}")
        appendLine("jwxtCookieLength=${try { collectJwxtCookies().length } catch (_: Throwable) { -1 }}")
        appendLine("status=$currentStatus")
        appendLine("android=${Build.VERSION.SDK_INT}")
    }

    private fun hideKeyboard() {
        try {
            val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            imm.hideSoftInputFromWindow(root.windowToken, 0)
        } catch (_: Exception) {}
    }

    private fun edit(hintText: String, inputTypeValue: Int): EditText = EditText(this).apply {
        hint = hintText
        inputType = inputTypeValue
        setSingleLine(true)
        setSelectAllOnFocus(false)
        textSize = 15f
        setPadding(dp(8), 0, dp(8), 0)
    }

    private fun button(text: String): Button = Button(this).apply {
        this.text = text
        isAllCaps = false
        textSize = 13f
        minHeight = dp(44)
    }

    private fun primaryButton(text: String): Button = button(text).apply { textSize = 14f }

    private fun fullWidthParams(): LinearLayout.LayoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    ).apply { topMargin = dp(4) }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (inImportMode) {
            if (::importWebView.isInitialized && importWebView.canGoBack()) {
                importWebView.goBack()
            } else {
                exitImportScreen("已返回小德课表。")
            }
        } else if (::appWebView.isInitialized && appWebView.canGoBack()) {
            appWebView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
