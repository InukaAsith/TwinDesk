// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Update check (shared/updates.js on the computers): asks GitHub for the latest release of
// TwinDesk, compares its tag with this app's version and picks this build's APK (the full one for
// TwinDesk with notifications, the standard one otherwise). Nothing is installed here; Download
// opens the APK (or the release page) in the browser.
//   prefs: updates.auto (check 15 s after start and every 6 hours), updates.notified (the last
//   version a notification announced, so each one is told once).
package com.twindesk.android

import android.content.Intent
import android.net.Uri
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class Updates(private val core: Core) {
    data class Apk(val name: String, val url: String)

    @Volatile var checking = false; private set
    @Volatile var latest = ""; private set
    @Volatile var available = false; private set
    @Volatile var download: Apk? = null; private set
    @Volatile var releaseUrl = RELEASES; private set
    @Volatile var noReleases = false; private set
    @Volatile var error = ""; private set
    @Volatile var checkedAt = 0L; private set

    val current: String get() = BuildConfig.VERSION_NAME
    var auto: Boolean
        get() = core.store.flag("updates.auto", true)
        set(on) { core.store.setFlag("updates.auto", on); start(); core.changed() }

    private val http by lazy { OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build() }
    private var timer: ScheduledFuture<*>? = null

    // Start (or stop) the automatic checks after the setting changed.
    fun start() {
        timer?.cancel(false)
        timer = if (auto) core.bg.scheduleWithFixedDelay({ check(false) }, FIRST_DELAY, EVERY, TimeUnit.MILLISECONDS) else null
    }

    fun checkNow() = core.bg.execute { check(true) }

    private fun check(manual: Boolean) {
        if (checking) return
        checking = true
        error = ""
        core.changed()
        try {
            val req = Request.Builder().url(API)
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "TwinDesk/$current")
                .build()
            http.newCall(req).execute().use { res ->
                if (res.code == 404) {
                    latest = ""; available = false; download = null; releaseUrl = RELEASES; noReleases = true
                    checkedAt = System.currentTimeMillis()
                    return
                }
                if (!res.isSuccessful) throw Exception(if (res.code == 403) "GitHub is busy, try again later" else "GitHub answered ${res.code}")
                val r = JSONObject(res.body.string())
                val tag = r.optString("tag_name").ifEmpty { r.optString("name") }.removePrefix("v").removePrefix("V")
                if (parse(tag) == null) throw Exception("The latest release has no version number")
                latest = tag
                available = compare(tag, current) > 0
                download = pickApk(r.optJSONArray("assets"), BuildConfig.NOTIF_LISTENER)
                releaseUrl = r.optString("html_url").ifEmpty { RELEASES }
                noReleases = false
                checkedAt = System.currentTimeMillis()
            }
            if (available && core.store.prefsString("updates.notified", "") != latest) {
                core.store.setPrefsString("updates.notified", latest)
                Notify.update(core.ctx, latest, current)
            }
        } catch (e: Exception) {
            if (manual) error = e.message ?: "Couldn’t reach GitHub"
        } finally {
            checking = false
            core.changed()
        }
    }

    // The URL for Download: this build's APK, else the release page.
    val url: String get() = download?.takeIf { available }?.url ?: releaseUrl

    fun open() {
        core.ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    companion object {
        private const val REPO = "InukaAsith/TwinDesk"
        private const val API = "https://api.github.com/repos/$REPO/releases/latest"
        const val RELEASES = "https://github.com/$REPO/releases"
        private const val FIRST_DELAY = 15_000L
        private const val EVERY = 6 * 60 * 60 * 1000L

        private class Version(val nums: List<Int>, val pre: String)

        // "v1.2.3" / "1.2" / "1.2.3-beta.1"; null when it isn't a version.
        private fun parse(v: String): Version? {
            val m = Regex("""^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?""").find(v.trim()) ?: return null
            return Version(m.groupValues[1].split('.').map { it.toInt() }, m.groupValues[2])
        }

        // > 0 when a is newer than b. A pre-release is older than the same version without one.
        fun compare(a: String, b: String): Int {
            val x = parse(a) ?: return 0
            val y = parse(b) ?: return 0
            for (i in 0 until maxOf(x.nums.size, y.nums.size)) {
                val d = x.nums.getOrElse(i) { 0 } - y.nums.getOrElse(i) { 0 }
                if (d != 0) return d
            }
            if (x.pre == y.pre) return 0
            if (x.pre.isEmpty()) return 1
            if (y.pre.isEmpty()) return -1
            return x.pre.compareTo(y.pre)
        }

        // TwinDesk-2.0.0-full.apk for the full build; the other .apk (TwinDesk-2.0.0.apk) for the standard one.
        private fun pickApk(assets: org.json.JSONArray?, full: Boolean): Apk? {
            if (assets == null) return null
            for (i in 0 until assets.length()) {
                val a = assets.optJSONObject(i) ?: continue
                val name = a.optString("name")
                val url = a.optString("browser_download_url")
                if (!name.endsWith(".apk", true) || url.isEmpty()) continue
                if (name.contains("full", true) == full) return Apk(name, url)
            }
            return null
        }
    }
}
