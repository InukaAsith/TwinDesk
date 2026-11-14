// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Update check (shared/updates.js on the computers): asks GitHub for the latest release of
// TwinDesk, compares its tag with this app's version and picks this build's APK (the full one for
// TwinDesk with notifications, the standard one otherwise). Update installs it in place, over this
// one (PackageInstaller: same package, same signing key, so settings and permissions stay): the
// APK is downloaded, checked against the SHA-256 GitHub gives for it, and handed to Android, which
// asks once to confirm (and, the first time, to allow TwinDesk to install apps). On Android 12 and
// later, once TwinDesk installed itself, later updates need no confirmation.
//   prefs: updates.auto (check 15 s after start and every 6 hours), updates.notified (the last
//   version a notification announced, so each one is told once), updates.install (download a new
//   version by itself and install it when no computer is connected).
package com.twindesk.android

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import java.io.File
import java.security.MessageDigest
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class Updates(private val core: Core) {
    data class Apk(val name: String, val url: String, val size: Long = 0, val digest: String = "")

    @Volatile var checking = false; private set
    @Volatile var latest = ""; private set
    @Volatile var available = false; private set
    @Volatile var download: Apk? = null; private set
    @Volatile var releaseUrl = RELEASES; private set
    @Volatile var noReleases = false; private set
    @Volatile var error = ""; private set
    @Volatile var checkedAt = 0L; private set
    // In place: stage "" | "downloading" | "ready" (downloaded) | "installing" (with Android).
    @Volatile var stage = ""; private set
    @Volatile var progress = 0f; private set
    @Volatile var installError = ""; private set
    private var file: File? = null
    private var fileFor = ""

    val current: String get() = BuildConfig.VERSION_NAME
    var auto: Boolean
        get() = core.store.flag("updates.auto", true)
        set(on) { core.store.setFlag("updates.auto", on); start(); core.changed() }

    // Install new versions by themselves (off until switched on).
    var install: Boolean
        get() = core.store.flag("updates.install", false)
        set(on) { core.store.setFlag("updates.install", on); if (on && available) core.bg.execute { autoInstall() }; core.changed() }

    private val http by lazy { OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build() }
    private var timer: ScheduledFuture<*>? = null

    // Start (or stop) the automatic checks after the setting changed.
    fun start() {
        timer?.cancel(false)
        if (!BuildConfig.UPDATER) return // the F-Droid build: F-Droid updates it
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
                if (!res.isSuccessful) throw Exception(if (res.code == 403) tr("GitHub is busy, try again later") else tr("GitHub answered {code}", "code" to res.code))
                val r = JSONObject(res.body.string())
                val tag = r.optString("tag_name").ifEmpty { r.optString("name") }.removePrefix("v").removePrefix("V")
                if (parse(tag) == null) throw Exception(tr("The latest release has no version number"))
                latest = tag
                available = compare(tag, current) > 0
                download = pickApk(r.optJSONArray("assets"), BuildConfig.NOTIF_LISTENER)
                releaseUrl = r.optString("html_url").ifEmpty { RELEASES }
                noReleases = false
                checkedAt = System.currentTimeMillis()
            }
            if (stage == "ready" && download?.url != fileFor) { stage = ""; file = null } // a newer release than the download
            if (available && install) core.bg.execute { autoInstall() }
            if (available && core.store.prefsString("updates.notified", "") != latest) {
                core.store.setPrefsString("updates.notified", latest)
                Notify.update(core.ctx, latest, current)
            }
        } catch (e: Exception) {
            if (manual) error = e.message ?: tr("Couldn’t reach GitHub")
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

    // ---- in place ----

    // Update: downloaded (or the download reused) and installed over this TwinDesk.
    fun installNow() { if (BuildConfig.UPDATER) core.bg.execute { installInPlace(asked = true) } }

    private fun allowed(): Boolean = core.ctx.packageManager.canRequestPackageInstalls()

    @Synchronized
    private fun installInPlace(asked: Boolean) {
        val d = download?.takeIf { available } ?: return
        if (stage == "downloading" || stage == "installing") return
        if (!allowed()) {
            // Android's "Install unknown apps" for TwinDesk, once: then Update again.
            installError = tr("Allow TwinDesk to install apps, then tap Install now again")
            core.changed()
            if (asked) runCatching {
                core.ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + core.ctx.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            return
        }
        try {
            val f = fetch(d)
            stage = "installing"; installError = ""; core.changed()
            commit(f)
        } catch (e: Exception) {
            stage = if (file != null) "ready" else ""
            installError = e.message ?: tr("The update didn’t install")
            core.changed()
        }
    }

    private fun fetch(d: Apk): File {
        file?.takeIf { stage == "ready" && fileFor == d.url && it.exists() }?.let { return it }
        val dir = File(core.ctx.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // one update's file at a time
        val out = File(dir, d.name.replace(Regex("[^\\w.@+-]"), "_"))
        val part = File(dir, out.name + ".part")
        stage = "downloading"; progress = 0f; installError = ""; core.changed()
        val sha = MessageDigest.getInstance("SHA-256")
        var got = 0L
        http.newCall(Request.Builder().url(d.url).header("User-Agent", "TwinDesk/$current").build()).execute().use { res ->
            if (!res.isSuccessful) throw Exception(tr("The download failed ({code})", "code" to res.code))
            val total = res.body.contentLength().takeIf { it > 0 } ?: d.size
            var said = 0L
            res.body.byteStream().use { inp ->
                part.outputStream().use { o ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n); sha.update(buf, 0, n); got += n
                        if (total > 0 && got - said > total / 100) { said = got; progress = got.toFloat() / total; core.changed() }
                    }
                }
            }
        }
        val hex = sha.digest().joinToString("") { "%02x".format(it) }
        val want = d.digest.removePrefix("sha256:").lowercase()
        if ((want.length == 64 && hex != want) || (want.length != 64 && d.size > 0 && got != d.size)) {
            part.delete()
            throw Exception(tr("The download didn’t match the release’s file"))
        }
        part.renameTo(out)
        file = out; fileFor = d.url; stage = "ready"; progress = 1f; core.changed()
        return out
    }

    // The APK goes to Android's installer; its answer comes to UpdateReceiver.
    private fun commit(f: File) {
        val pi = core.ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(core.ctx.packageName)
            setSize(f.length())
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            s.openWrite("base.apk", 0, f.length()).use { o ->
                f.inputStream().use { it.copyTo(o) }
                s.fsync(o)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val back = PendingIntent.getBroadcast(core.ctx, 51, Intent(core.ctx, UpdateReceiver::class.java).setPackage(core.ctx.packageName), flags)
            s.commit(back.intentSender)
        }
    }

    // Android's answer (UpdateReceiver). Success never comes back here: the new version replaces this process.
    fun installAnswer(ok: Boolean, waiting: Boolean, message: String) {
        if (waiting) return
        stage = if (file?.exists() == true) "ready" else ""
        installError = if (ok) "" else message.ifEmpty { tr("The update didn’t install") }
        core.changed()
    }

    // Install automatically: downloaded now, installed when no computer is connected (checked every
    // 10 minutes until then). Android may still ask to confirm; then a notification says so.
    private fun autoInstall() {
        if (!install || !available || stage.isNotEmpty() && stage != "ready") return
        if (!allowed()) return
        try { fetch(download ?: return) } catch (e: Exception) { stage = ""; installError = e.message ?: ""; core.changed(); return }
        if (core.host != null) { core.bg.schedule({ autoInstall() }, 10, TimeUnit.MINUTES); return }
        installInPlace(asked = false)
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
                if (name.contains("full", true) == full) return Apk(name, url, a.optLong("size"), a.optString("digest"))
            }
            return null
        }
    }
}

// Android's installer answers an update (Updates.commit): it needs the person's OK (shown now when
// TwinDesk is on screen, else as a notification), it failed, or it's done (this process is replaced).
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val core = Core.get(ctx)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (MainActivity.shown) runCatching { ctx.startActivity(confirm) }.onFailure { Notify.updateReady(ctx, confirm, core.updates.latest) }
            else Notify.updateReady(ctx, confirm, core.updates.latest)
            core.updates.installAnswer(ok = true, waiting = true, message = "")
            return
        }
        val ok = status == PackageInstaller.STATUS_SUCCESS
        core.updates.installAnswer(ok, waiting = false, message = if (status == PackageInstaller.STATUS_FAILURE_ABORTED) tr("The update was cancelled") else intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "")
    }
}
