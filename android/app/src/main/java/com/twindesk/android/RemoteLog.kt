// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Log.i/w/e/d that also send the line to the test log server on the local network (tools/logserver.js,
// shared/logship.js on the computers), so a phone's side of a problem can be read next to the
// computers'. Lines go out in small batches from one background thread; an unreachable server is
// retried later and never slows the app. BuildConfig.LOG_SERVER empty = off.
package com.twindesk.android

import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

object RemoteLog {
    private const val MAX_PENDING = 500
    private const val RETRY_MS = 15_000L
    private val pending = ArrayDeque<String>()
    private val exec by lazy { Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "remote-log").apply { isDaemon = true } } }
    private var started = false
    private var nextTry = 0L
    private val clock = object : ThreadLocal<SimpleDateFormat>() {
        override fun initialValue() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    }

    fun i(tag: String, msg: String) { Log.i(tag, msg); ship("LOG", tag, msg) }
    fun d(tag: String, msg: String) { Log.d(tag, msg); ship("LOG", tag, msg) }
    fun w(tag: String, msg: String) { Log.w(tag, msg); ship("WARN", tag, msg) }
    fun w(tag: String, msg: String, tr: Throwable?) { Log.w(tag, msg, tr); ship("WARN", tag, msg + (tr?.let { ": $it" } ?: "")) }
    fun e(tag: String, msg: String) { Log.e(tag, msg); ship("ERROR", tag, msg) }
    fun e(tag: String, msg: String, tr: Throwable?) { Log.e(tag, msg, tr); ship("ERROR", tag, msg + (tr?.let { ": $it" } ?: "")) }

    @Synchronized private fun ship(level: String, tag: String, msg: String) {
        if (BuildConfig.LOG_SERVER.isEmpty()) return
        pending.addLast("${clock.get()!!.format(Date())} $level [$tag] ${msg.take(1500)}")
        while (pending.size > MAX_PENDING) pending.removeFirst()
        if (!started) {
            started = true
            exec.scheduleWithFixedDelay({ runCatching { flush() } }, 1500, 1500, java.util.concurrent.TimeUnit.MILLISECONDS)
        }
    }

    private fun flush() {
        if (System.currentTimeMillis() < nextTry) return
        val lines: List<String> = synchronized(this) { List(minOf(200, pending.size)) { pending.removeFirst() } }
        if (lines.isEmpty()) return
        var ok = false
        try {
            val c = URL(BuildConfig.LOG_SERVER).openConnection() as HttpURLConnection
            c.requestMethod = "POST"
            c.connectTimeout = 2500
            c.readTimeout = 3000
            c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            val body = JSONObject().put("device", "android-" + Build.MODEL).put("lines", JSONArray(lines)).toString().toByteArray()
            c.outputStream.use { it.write(body) }
            ok = c.responseCode in 200..299
            c.disconnect()
        } catch (_: Exception) {
        }
        if (!ok) {
            synchronized(this) { for (l in lines.asReversed()) pending.addFirst(l); while (pending.size > MAX_PENDING) pending.removeFirst() }
            nextTry = System.currentTimeMillis() + RETRY_MS
        }
    }
}
