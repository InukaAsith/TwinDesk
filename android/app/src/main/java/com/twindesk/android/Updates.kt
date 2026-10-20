// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Updates (shared/updates.js on the computers): asks GitHub for new releases of the repository this
// build came from (BuildConfig.UPDATE_REPO, the repository whose CI built it: the main project's
// builds follow the main project, a fork's builds follow that fork), picks this build's APK (the full
// one for TwinDesk with notifications, the standard one otherwise), downloads it and hands it to
// Android's installer. An update over the installed app keeps everything: settings, pairings and the
// permissions the user gave (they belong to the app and its signature, which an update shares).
// Android always shows its own "Update this app?" screen: no app can skip it.
//   prefs: updates.auto (check 15 s after start and every 6 hours), updates.channel ('', 'stable' or
//   'beta'; '' = by this build: a pre-release build starts on beta), updates.notified (the last
//   version a notification announced, so each one is told once).
package com.twindesk.android

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class Updates(private val core: Core) {
    data class Apk(val name: String, val url: String, val size: Long = 0, val digest: String = "")

    @Volatile var checking = false; private set
    @Volatile var latest = ""; private set
    @Volatile var prerelease = false; private set
    @Volatile var available = false; private set
    @Volatile var download: Apk? = null; private set
    @Volatile var releaseUrl = RELEASES; private set
    @Volatile var noReleases = false; private set
    @Volatile var error = ""; private set
    @Volatile var checkedAt = 0L; private set
    /** idle | downloading | ready (downloaded, waiting for the installer screen) */
    @Volatile var state = "idle"; private set
    @Volatile var progress = 0.0; private set

    val current: String get() = BuildConfig.VERSION_NAME
    val repo: String get() = BuildConfig.UPDATE_REPO
    var auto: Boolean
        get() = core.store.flag("updates.auto", true)
        set(on) { core.store.setFlag("updates.auto", on); start(); core.changed() }

    /** "stable" or "beta": the setting, else beta for a pre-release build. */
    val channel: String get() = channelFor(core.store.prefsString("updates.channel", ""), current)
    fun setBeta(on: Boolean) {
        core.store.setPrefsString("updates.channel", if (on) "beta" else "stable")
        core.changed()
        checkNow()
    }

    private val http by lazy { OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build() }
    private val httpDownload by lazy { http.newBuilder().callTimeout(0, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build() }
    private var timer: ScheduledFuture<*>? = null

    private val api: String
        get() = if (channel == "beta") "https://api.github.com/repos/$repo/releases?per_page=30" else "https://api.github.com/repos/$repo/releases/latest"
    private val releasesPage: String get() = "https://github.com/$repo/releases"

    // Start (or stop) the automatic checks after the setting changed.
    fun start() {
        timer?.cancel(false)
        timer = if (auto) core.bg.scheduleWithFixedDelay({ check(false) }, FIRST_DELAY, EVERY, TimeUnit.MILLISECONDS) else null
    }

    fun checkNow() = core.bg.execute { check(true) }

    private fun check(manual: Boolean) {
        if (checking || state == "downloading") return
        checking = true
        error = ""
        core.changed()
        try {
            val req = Request.Builder().url(api)
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "TwinDesk/$current")
                .build()
            http.newCall(req).execute().use { res ->
                if (res.code == 404) {
                    noRelease()
                    return
                }
                if (!res.isSuccessful) throw Exception(if (res.code == 403) "GitHub is busy, try again later" else "GitHub answered ${res.code}")
                val text = res.body.string()
                val list = if (channel == "beta") JSONArray(text) else JSONArray().put(JSONObject(text))
                val r = pickRelease(list, channel == "beta")
                if (r == null) {
                    if (list.length() == 0) { noRelease(); return }
                    throw Exception("The latest release has no version number")
                }
                val tag = tagOf(r)
                if (tag != latest) { state = "idle"; progress = 0.0 }
                latest = tag
                prerelease = r.optBoolean("prerelease")
                available = compare(tag, current) > 0
                download = pickApk(r.optJSONArray("assets"), BuildConfig.NOTIF_LISTENER)
                releaseUrl = r.optString("html_url").ifEmpty { releasesPage }
                noReleases = false
                checkedAt = System.currentTimeMillis()
            }
            if (available && core.store.prefsString("updates.notified", "") != latest) {
                core.store.setPrefsString("updates.notified", latest)
                Notify.update(core.ctx, latest + if (prerelease) " (beta)" else "", current)
            }
        } catch (e: Exception) {
            if (manual) error = e.message ?: "Couldn’t reach GitHub"
        } finally {
            checking = false
            core.changed()
        }
    }

    private fun noRelease() {
        latest = ""; available = false; download = null; releaseUrl = releasesPage; noReleases = true
        checkedAt = System.currentTimeMillis()
    }

    // The URL for Download: this build's APK, else the release page.
    val url: String get() = download?.takeIf { available }?.url ?: releaseUrl

    fun open() {
        core.ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Download the APK and open Android's installer on it (an update over this app keeps all its data). */
    fun install() {
        val apk = download?.takeIf { available } ?: return open()
        if (state == "downloading") return
        core.bg.execute { downloadAndInstall(apk) }
    }

    private fun downloadAndInstall(apk: Apk) {
        state = "downloading"; progress = 0.0; error = ""
        core.changed()
        try {
            val dir = File(core.ctx.cacheDir, "updates")
            dir.deleteRecursively()
            dir.mkdirs()
            val file = File(dir, apk.name.replace(Regex("[^\\w.-]"), "_"))
            val req = Request.Builder().url(apk.url).header("User-Agent", "TwinDesk/$current").build()
            val sha = MessageDigest.getInstance("SHA-256")
            var got = 0L
            httpDownload.newCall(req).execute().use { res ->
                if (!res.isSuccessful) throw Exception("The download answered ${res.code}")
                val total = res.body.contentLength().takeIf { it > 0 } ?: apk.size
                var lastTick = 0L
                res.body.byteStream().use { input ->
                    file.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            sha.update(buf, 0, n)
                            got += n
                            val now = System.currentTimeMillis()
                            if (total > 0 && now - lastTick > 250) { lastTick = now; progress = (got.toDouble() / total).coerceAtMost(1.0); core.changed() }
                        }
                    }
                }
            }
            if (apk.size > 0 && got != apk.size) throw Exception("The download is incomplete")
            val want = Regex("^sha256:([0-9a-fA-F]{64})$").find(apk.digest)?.groupValues?.get(1)
            if (want != null && sha.digest().joinToString("") { "%02x".format(it) } != want.lowercase()) throw Exception("The download is damaged (checksum differs)")
            progress = 1.0
            state = "ready"
            launchInstaller(file)
        } catch (e: Exception) {
            state = "idle"; progress = 0.0
            error = e.message ?: "The download failed"
            File(core.ctx.cacheDir, "updates").deleteRecursively()
        } finally {
            core.changed()
        }
    }

    private fun launchInstaller(file: File) {
        val ctx = core.ctx
        if (!ctx.packageManager.canRequestPackageInstalls()) { // Android asks once per app: Install unknown apps
            error = "Allow TwinDesk to install updates in the screen that opened, then tap Update again"
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        }
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", file)
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    companion object {
        const val DEFAULT_REPO = "InukaAsith/TwinDesk"
        const val RELEASES = "https://github.com/$DEFAULT_REPO/releases"
        private const val FIRST_DELAY = 15_000L
        private const val EVERY = 6 * 60 * 60 * 1000L

        private class Version(val nums: List<Int>, val pre: String)

        // "v1.2.3" / "1.2" / "1.2.3-beta.1" / "2.1.10-pr1"; null when it isn't a version.
        private fun parse(v: String): Version? {
            val m = Regex("""^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?""").find(v.trim()) ?: return null
            return Version(m.groupValues[1].split('.').map { it.toInt() }, m.groupValues[2])
        }

        // Pre-release labels piece by piece, numbers as numbers: pr2 < pr10.
        private fun comparePre(a: String, b: String): Int {
            val re = Regex("""\d+|[^\d.]+""")
            val x = re.findAll(a).map { it.value }.toList()
            val y = re.findAll(b).map { it.value }.toList()
            for (i in 0 until maxOf(x.size, y.size)) {
                if (i >= x.size) return -1
                if (i >= y.size) return 1
                val nx = x[i][0].isDigit()
                val ny = y[i][0].isDigit()
                if (nx && ny) {
                    val d = x[i].toBigInteger().compareTo(y[i].toBigInteger())
                    if (d != 0) return d
                } else if (nx != ny) return if (nx) -1 else 1
                else if (x[i] != y[i]) return x[i].compareTo(y[i]).coerceIn(-1, 1)
            }
            return 0
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
            return comparePre(x.pre, y.pre)
        }

        /** "stable" | "beta": the setting, else beta for a pre-release build and stable for the rest. */
        fun channelFor(setting: String, current: String): String {
            if (setting == "beta" || setting == "stable") return setting
            return if (parse(current)?.pre?.isNotEmpty() == true) "beta" else "stable"
        }

        private fun tagOf(r: JSONObject): String = r.optString("tag_name").ifEmpty { r.optString("name") }.removePrefix("v").removePrefix("V")

        /** The release to offer: never a draft; stable skips pre-releases; the highest version wins. */
        fun pickRelease(list: JSONArray, beta: Boolean): JSONObject? {
            var best: JSONObject? = null
            for (i in 0 until list.length()) {
                val r = list.optJSONObject(i) ?: continue
                if (r.optBoolean("draft") || parse(tagOf(r)) == null) continue
                if (!beta && r.optBoolean("prerelease")) continue
                if (best == null || compare(tagOf(r), tagOf(best)) > 0) best = r
            }
            return best
        }

        // TwinDesk-2.0.0-full.apk for the full build; the other .apk (TwinDesk-2.0.0.apk) for the standard one.
        fun pickApk(assets: JSONArray?, full: Boolean): Apk? {
            if (assets == null) return null
            for (i in 0 until assets.length()) {
                val a = assets.optJSONObject(i) ?: continue
                val name = a.optString("name")
                val url = a.optString("browser_download_url")
                if (!name.endsWith(".apk", true) || url.isEmpty()) continue
                if (name.contains("full", true) == full) return Apk(name, url, a.optLong("size"), a.optString("digest"))
            }
            return null
        }
    }
}
