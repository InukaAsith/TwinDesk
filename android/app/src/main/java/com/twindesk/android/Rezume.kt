// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume (shared/rezume.js on the computer): go on with what's in use on the other device.
//   Offering: the app in front here (TwinDesk's Accessibility says which), and in a browser its
//   address (its address bar, read by its id), once it stayed in front STABLE_MS: rz.offer. The
//   computer opens a tab in its browser, an app in a phone window (wireless debugging). Without
//   Accessibility the computer asks through wireless debugging instead (policy detect: false).
//   Taking: the computer's tab or document as a quiet notification (the last one only); tapped, a
//   tab opens here, a document comes across (file.offer drop 'rezume') and opens. Sent on purpose
//   (the computer's Send to): opened at once when Android lets TwinDesk (Display over other apps),
//   else a notification that rings once.
//   "Open on computer" in the share sheet (ShareActivity) is there only while ReZume is on.
// Off until turned on: nothing is read, nothing runs.
package com.twindesk.android

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class Rezume(core: Core) : Feature(core) {
    class Offer(val id: String, val kind: String, val title: String, val url: String, val name: String, val size: Long, val app: String, val appName: String)

    fun opt(k: String, d: Boolean = true) = core.store.flag("rezume.$k", d)
    val on get() = opt("on", false)

    @Volatile var peer: JSONObject? = null; private set // the computer's rz.policy
    @Volatile var incoming: Offer? = null; private set // the computer's
    @Volatile var offered: String = ""; private set // what we offer, for the page
    @Volatile var message: String = ""; private set
    private var outId = ""
    private var outKey = ""
    private var outAt = 0L
    private var seenKey = ""
    private var seenSince = 0L
    private var last: JSONObject? = null // what was last in front here (again: offered at once when the computer comes)
    private var lastAt = 0L

    // The computer (re)connected or turned it on: what was last in front here goes at once while it's
    // fresh, not only once something else comes to the front.
    private fun again(p: JSONObject) {
        val a = last ?: return
        if (!(on && opt("send")) || outId.isNotEmpty() || System.currentTimeMillis() - lastAt > TTL_MS) return
        val kind = a.optString("kind")
        if (kind == "web" && !(opt("web") && p.optBoolean("web", true))) return
        if (kind == "app" && !(opt("apps") && p.optBoolean("apps", false))) return
        core.bg.execute { send(JSONObject(a.toString()), false) }
    }
    private var detectSaid: Boolean? = null
    private var poll: ScheduledFuture<*>? = null
    private val icons = HashMap<String, String>()
    private val dismissed = HashSet<String>()

    // sync: tell the computer (pair.sync), unless it's the computer's change being taken here.
    fun set(k: String, v: Boolean, sync: Boolean = true) {
        core.store.setFlag("rezume.$k", v)
        if (k == "on") shareTarget(v)
        apply()
        if (sync && (k == "on" || k == "send" || k == "receive")) core.sync.rezumeChanged()
    }

    // "Open on computer" in the share sheet only while ReZume is on.
    private fun shareTarget(v: Boolean) = runCatching {
        core.ctx.packageManager.setComponentEnabledSetting(
            ComponentName(core.ctx, "com.twindesk.android.OpenOnComputer"),
            if (v) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP,
        )
    }

    override fun onWelcome(host: Host) {
        incoming = null
        outId = ""; outKey = ""; seenKey = ""
        detectSaid = null
        apply()
    }

    override fun onClosed() {
        peer = null
        incoming = null
        outId = ""; outKey = ""
        timers()
        Notify.cancelRezume(core.ctx)
    }

    fun apply() {
        sendPolicy()
        if (!on || !opt("receive")) {
            incoming = null
            Notify.cancelRezume(core.ctx)
        }
        if (!(on && opt("send")) && outId.isNotEmpty()) clearOut()
        timers()
        core.changed()
    }

    private fun sendPolicy() {
        if (!core.link.connected) return
        val detect = InputService.running != null
        detectSaid = detect
        core.send(msg(Proto.T.RZ_POLICY, "on" to (on && opt("receive")), "web" to opt("web"), "docs" to opt("docs"), "apps" to false, "push" to opt("push"), "detect" to (on && opt("send") && detect)))
    }

    private fun timers() {
        val p = peer
        val want = on && opt("send") && core.link.connected && p != null && p.optBoolean("on")
        if (want && poll == null) poll = core.bg.scheduleWithFixedDelay({ runCatching { tick() }.onFailure { Log.e("TwinDesk", "rezume", it) } }, 1500, 1500, TimeUnit.MILLISECONDS)
        else if (!want) {
            poll?.cancel(false)
            poll = null
        }
    }

    // ---- offering ----

    private fun tick() {
        val det = InputService.running != null
        if (det != detectSaid) sendPolicy() // Accessibility came or went: the computer asks through wireless debugging or not
        val p = peer ?: return
        if (outId.isNotEmpty() && System.currentTimeMillis() - outAt > TTL_MS) clearOut()
        val svc = InputService.running ?: return
        if (!core.ctx.getSystemService(PowerManager::class.java).isInteractive) return // the screen off: what was offered stays
        // The window in front, from its own content: the keyboard opening (typing in the address bar) makes
        // it the "active package", and nothing says so when it closes again; the active window stays the app's.
        val pkg = runCatching { svc.rootInActiveWindow?.packageName?.toString() }.getOrNull()?.takeIf { it.isNotEmpty() && !NOT_AN_APP.containsMatchIn(it) } ?: svc.activePackage
        if (pkg.isEmpty() || NOT_AN_APP.containsMatchIn(pkg)) return say("nothing to offer in front ($pkg)")
        val a = current(svc, pkg, p) ?: return
        say("")
        last = JSONObject(a.second.toString())
        lastAt = System.currentTimeMillis()
        val now = System.currentTimeMillis()
        if (a.first == outKey) { outAt = now; return }
        if (a.first != seenKey) { seenKey = a.first; seenSince = now; return }
        if (now - seenSince < STABLE_MS) return
        seenKey = ""
        send(a.second, false)
    }

    // (key, the offer) for what's in front: a browser's tab, else the app.
    private fun current(svc: InputService, pkg: String, p: JSONObject): Pair<String, JSONObject>? {
        val name = label(pkg)
        val ids = URL_BARS[pkg]
        if (ids != null) {
            if (!(opt("web") && p.optBoolean("web", true))) return null.also { say("web pages are off") }
            val url = addressOf(svc, pkg, ids) ?: return null
            val title = Uri.parse(url).host?.removePrefix("www.") ?: url
            return "web $url" to JSONObject().put("kind", "web").put("url", url).put("title", title).put("app", pkg).put("appName", name)
        }
        if (!(opt("apps") && p.optBoolean("apps", false)) || name.isEmpty()) return null
        return "app $pkg" to JSONObject().put("kind", "app").put("title", name).put("app", pkg).put("appName", name)
    }

    private fun addressOf(svc: InputService, pkg: String, ids: List<String>): String? {
        val root = runCatching { svc.rootInActiveWindow }.getOrNull() ?: return null.also { say("no window content ($pkg)") }
        if (root.packageName?.toString() != pkg) return null.also { say("the window in front is ${root.packageName}, not $pkg") }
        for (id in ids) {
            val n: AccessibilityNodeInfo = root.findAccessibilityNodeInfosByViewId("$pkg:id/$id").orEmpty().firstOrNull { it.isVisibleToUser } ?: continue
            if (n.isFocused) return null.also { say("the address bar is being typed in") } // being typed in
            return normalize(n.text?.toString() ?: "") ?: null.also { say("not an address in $id") }
        }
        return null.also { say("no address bar found in $pkg") }
    }

    // Why nothing is offered, in the log once each time it changes.
    private var said = ""
    private fun say(why: String) {
        if (why == said) return
        said = why
        if (why.isNotEmpty()) Log.i("TwinDesk", "rezume: $why")
    }

    private fun label(pkg: String): String = runCatching {
        val pm = core.ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString().take(100)
    }.getOrDefault("")

    private fun icon(pkg: String): String = icons.getOrPut(pkg) {
        if (core.link.ble) return "" // slow there: the computer has the phone's app list
        runCatching {
            val d = core.ctx.packageManager.getApplicationIcon(pkg)
            val size = 64
            val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            d.setBounds(0, 0, size, size)
            d.draw(Canvas(bmp))
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }.getOrDefault("")
    }

    private fun send(o: JSONObject, push: Boolean) {
        val id = UUID.randomUUID().toString().replace("-", "").take(16)
        val app = o.optString("app")
        o.put("t", Proto.T.RZ_OFFER).put("id", id).put("at", System.currentTimeMillis()).put("icon", icon(app))
        if (push) o.put("push", true)
        outId = id
        outKey = if (o.optString("kind") == "web") "web " + o.optString("url") else "app $app"
        outAt = System.currentTimeMillis()
        offered = o.optString("title")
        core.send(o)
        Log.i("TwinDesk", "rezume: offered ${o.optString("kind")} ${o.optString("app")}${if (push) " (sent)" else ""}")
        core.changed()
    }

    private fun clearOut() {
        if (outId.isNotEmpty()) core.send(msg(Proto.T.RZ_CLEAR, "id" to outId))
        outId = ""; outKey = ""; offered = ""
        core.changed()
    }

    // The share sheet's "Open on computer": a link opened there now.
    fun pushUrl(text: String): String? {
        val url = URL_IN.find(text)?.value ?: return tr("That has no link to open")
        val p = peer
        val name = core.host?.name ?: tr("your computer")
        if (p == null) return tr("{name} has no ReZume yet: update TwinDesk there", "name" to name)
        if (!p.optBoolean("on") || !p.optBoolean("web", true)) return tr("ReZume is off on {name}", "name" to name)
        send(JSONObject().put("kind", "web").put("url", url).put("title", Uri.parse(url).host?.removePrefix("www.") ?: url).put("app", "").put("appName", ""), true)
        return null
    }

    // ---- taking ----

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.RZ_POLICY -> {
                val was = peer?.optBoolean("on") == true
                val first = peer == null
                if (peer?.optBoolean("on") != m.optBoolean("on")) Log.i("TwinDesk", "rezume: ${if (m.optBoolean("on")) "on" else "off"} on the computer")
                peer = m
                if (first) sendPolicy() // ours may have come before ReZume loaded there (when it's turned on)
                if (!m.optBoolean("on")) clearOut()
                else if (!was) again(m)
                timers()
                core.changed()
            }
            Proto.T.RZ_OFFER -> offer(m)
            Proto.T.RZ_CLEAR -> if (incoming?.id == m.optString("id")) {
                incoming = null
                Notify.cancelRezume(core.ctx)
                core.changed()
            }
            Proto.T.RZ_TAKE -> core.send(msg(Proto.T.RZ_DONE, "id" to m.optString("id"), "ok" to false, "why" to "The phone has no document to send"))
            Proto.T.RZ_DONE -> if (!m.optBoolean("ok")) { message = m.optString("why").take(200).ifEmpty { tr("It couldn’t be sent") }; core.changed() }
            else -> return false
        }
        return true
    }

    private fun offer(m: JSONObject) {
        if (!on || !opt("receive")) return
        val kind = m.optString("kind")
        val id = m.optString("id").take(64)
        if (id.isEmpty() || id in dismissed) return
        val o = when (kind) {
            "web" -> {
                val url = normalize(m.optString("url")) ?: return
                if (!opt("web")) return
                Offer(id, kind, m.optString("title").take(300).ifEmpty { url }, url, "", 0, m.optString("app").take(300), m.optString("appName").take(100))
            }
            "doc" -> {
                if (!opt("docs")) return
                val name = m.optString("name").substringAfterLast('/').substringAfterLast('\\').take(200).ifEmpty { "Document" }
                Offer(id, kind, m.optString("title").take(300).ifEmpty { name }, "", name, m.optLong("size", 0), m.optString("app").take(300), m.optString("appName").take(100))
            }
            else -> return
        }
        val push = m.optBoolean("push") && opt("push")
        Log.i("TwinDesk", "rezume: ${o.kind} from the computer${if (m.optBoolean("push")) " (sent)" else ""}")
        if (push && Settings.canDrawOverlays(core.ctx)) return take(o) // Android lets an app with the overlay open things
        incoming = o
        if (opt("notify") || push) Notify.rezume(core.ctx, core.host?.name ?: tr("your computer"), o, loud = push)
        core.changed()
    }

    fun dismiss() {
        incoming?.let { dismissed.add(it.id) }
        incoming = null
        Notify.cancelRezume(core.ctx)
        core.changed()
    }

    // The notification's tap (RezumeActivity), the page's Open, or a push.
    fun take(o: Offer? = incoming, ctx: android.content.Context = core.ctx) {
        o ?: return
        if (incoming?.id == o.id) incoming = null
        Notify.cancelRezume(core.ctx)
        message = ""
        when (o.kind) {
            "web" -> runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(o.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                .onFailure { message = tr("No app here opens {url}", "url" to o.url) }
            "doc" -> {
                message = tr("Getting {name}…", "name" to o.name)
                core.files.expect("rz-${o.id}", Files.Target(true, onDone = { b -> opened(b, o.name) }))
                core.send(msg(Proto.T.RZ_TAKE, "id" to o.id))
            }
        }
        core.changed()
    }

    private fun opened(b: Files.Batch, name: String) {
        message = if (b.ok) "" else tr("{name} didn’t arrive", "name" to name)
        val f = b.placed.firstOrNull()
        if (b.ok && f != null) {
            val view = Notify.viewIntent(f.first, f.second)
            if (Settings.canDrawOverlays(core.ctx)) runCatching { core.ctx.startActivity(view) }
            Notify.rezumeReady(core.ctx, name, view) // Android may not let it open from here: tap to open
        }
        core.changed()
    }

    companion object {
        const val STABLE_MS = 2500L
        const val TTL_MS = 10 * 60 * 1000L
        // The address bar of each browser, by its view id.
        private val CHROMIUM = listOf("url_bar")
        val URL_BARS = mapOf(
            "com.android.chrome" to CHROMIUM, "com.chrome.beta" to CHROMIUM, "com.chrome.dev" to CHROMIUM, "com.chrome.canary" to CHROMIUM,
            "com.microsoft.emmx" to CHROMIUM, "com.brave.browser" to CHROMIUM, "com.vivaldi.browser" to CHROMIUM, "com.kiwibrowser.browser" to CHROMIUM,
            "org.mozilla.firefox" to listOf("mozac_browser_toolbar_url_view", "url_bar_title"), "org.mozilla.firefox_beta" to listOf("mozac_browser_toolbar_url_view"),
            "org.mozilla.fenix" to listOf("mozac_browser_toolbar_url_view"), "org.mozilla.focus" to listOf("mozac_browser_toolbar_url_view", "display_url"),
            "com.sec.android.app.sbrowser" to listOf("location_bar_edit_text", "custom_tab_toolbar_url_bar_text"),
            "com.opera.browser" to listOf("url_field"), "com.opera.mini.native" to listOf("url_field"),
            "com.duckduckgo.mobile.android" to listOf("omnibarTextInput"),
        )
        val NOT_AN_APP = Regex("launcher|\\.home$|miui\\.home|systemui|com\\.twindesk|inputmethod|\\.keyboard|permissioncontroller|packageinstaller", RegexOption.IGNORE_CASE)
        private val HOST = Regex("^([\\w-]+\\.)+[a-z]{2,}(:\\d+)?([/?#]|$)|^localhost(:\\d+)?([/?#]|$)", RegexOption.IGNORE_CASE)
        private val URL_IN = Regex("https?://\\S+", RegexOption.IGNORE_CASE)

        // http and https only ("example.com/page" as the bar shows it is https://example.com/page).
        fun normalize(v: String): String? {
            val s = v.trim()
            if (s.isEmpty() || s.contains(' ')) return null
            val u = if (s.startsWith("http://", true) || s.startsWith("https://", true)) s else if (HOST.containsMatchIn(s)) "https://$s" else return null
            val p = runCatching { Uri.parse(u) }.getOrNull() ?: return null
            return if ((p.scheme == "http" || p.scheme == "https") && !p.host.isNullOrEmpty() && u.length <= 8192) u else null
        }
    }
}
