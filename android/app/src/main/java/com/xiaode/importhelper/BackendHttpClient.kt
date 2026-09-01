package com.xiaode.importhelper

import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

data class BackendHttpResult(val status: Int, val body: String) {
    fun json(): JSONObject = try {
        if (body.isBlank()) JSONObject() else JSONObject(body)
    } catch (_: Throwable) {
        JSONObject().put("message", body.take(400))
    }
}

class BackendHttpClient {
    fun request(
        serverUrl: String,
        method: String,
        path: String,
        body: String = "",
        token: String = ""
    ): BackendHttpResult {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isBlank()) throw IOException("尚未设置同步服务器")
        val connection = URL("$base${if (path.startsWith('/')) path else "/$path"}")
            .openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method.uppercase()
            connection.connectTimeout = 12_000
            connection.readTimeout = 25_000
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            connection.setRequestProperty("ngrok-skip-browser-warning", "true")
            if (token.isNotBlank()) connection.setRequestProperty("x-user-token", token)
            if (body.isNotBlank() && method.uppercase() !in setOf("GET", "HEAD")) {
                val bytes = body.toByteArray(StandardCharsets.UTF_8)
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = if (stream == null) "" else BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { it.readText() }
            return BackendHttpResult(status, text)
        } finally {
            connection.disconnect()
        }
    }
}
