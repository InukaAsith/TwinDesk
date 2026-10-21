// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's screen and sound on the phone. The Mac already streams to the computers over WebRTC
// (mac/stream.js, mac/audio.js); Android's WebView speaks the same WebRTC, so the phone answers
// those offers in two small pages (assets/web): viewer.html for the screen (ViewerActivity) and
// audio.html for the sound (a WebView kept without a window). WebHost carries messages between
// the link and a page.
package com.twindesk.android

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import org.json.JSONObject

class WebHost(ctx: Context, page: String, private val core: Core, private val onEvent: (String, JSONObject?) -> Unit = { _, _ -> }) {
    private val main = Handler(Looper.getMainLooper())
    private var ready = false
    private val queue = mutableListOf<JSONObject>()

    @SuppressLint("SetJavaScriptEnabled")
    val view: WebView = WebView(ctx).apply {
        settings.javaScriptEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true
        settings.domStorageEnabled = false
        setBackgroundColor(android.graphics.Color.BLACK)
        isFocusable = true
        isFocusableInTouchMode = true
        webChromeClient = object : WebChromeClient() {
            // A <video> with nothing playing yet shows WebView's grey play button: black instead.
            override fun getDefaultVideoPoster(): android.graphics.Bitmap =
                android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.BLACK) }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                RemoteLog.i("TwinDesk", "web: ${m.message()}")
                return true
            }
        }
        addJavascriptInterface(Bridge(), "TD")
        loadUrl("file:///android_asset/web/$page")
    }

    private inner class Bridge {
        @JavascriptInterface fun send(json: String) {
            runCatching { core.send(JSONObject(json)) }
        }
        @JavascriptInterface fun ready() = main.post {
            ready = true
            for (m in queue) deliver(m)
            queue.clear()
            onEvent("ready", null)
        }.let { }
        @JavascriptInterface fun playing(w: Int, h: Int) = main.post { onEvent("playing", JSONObject().put("w", w).put("h", h)) }.let { }
        @JavascriptInterface fun haptic() = main.post { view.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS) }.let { }
    }

    // A message to the page (any thread).
    fun post(m: JSONObject) = main.post { if (ready) deliver(m) else queue.add(m) }

    private fun deliver(m: JSONObject) {
        view.evaluateJavascript("window.tdRecv && window.tdRecv(${m});", null)
    }

    // The soft keyboard for typing on the Mac (viewer.html types what it gets into its hidden field).
    fun keyboard(on: Boolean) = main.post {
        val imm = view.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
        if (on) {
            view.requestFocus()
            imm.showSoftInput(view, 0)
        } else imm.hideSoftInputFromWindow(view.windowToken, 0)
    }

    fun destroy() = main.post {
        ready = false
        view.removeJavascriptInterface("TD")
        view.loadUrl("about:blank")
        view.destroy()
    }
}

// The Mac's screen: what it shares (screen.state), Start/Stop and Mirror/Extend (screen.ctl), and
// the viewer page while ViewerActivity is open (screen.policy tells the Mac to stream).
class Screen(core: Core) : Feature(core) {
    @Volatile var state: JSONObject? = null; private set // the Mac's screen.state
    @Volatile var inputOn = true; private set // the Mac's "Receive input" (stream.input)
    @Volatile var viewing = false; private set
    @Volatile var size: Pair<Int, Int>? = null; private set // the picture playing now
    private var host: WebHost? = null
    private var lastInfo: JSONObject? = null
    private var wantStart = false // the viewer opened before we knew whether the Mac shares
    private var startedByUs = false // we started the Mac's sharing: stop it when the viewer closes
    @Volatile var autoOpened = false; private set // the computer started sharing and opened the viewer: it closes when that stops

    val sharing get() = state?.optBoolean("on") == true
    val mode get() = state?.optString("mode") ?: ""
    val remote get() = state?.optBoolean("remote", true) != false

    // ViewerActivity opened: stream to us, at our screen's size (the Mac sizes Extend to it).
    fun attach(h: WebHost, w: Int, hpx: Int) {
        host = h
        viewing = true
        h.post(opts()) // first: the computer's name for the messages below
        lastInfo?.let { h.post(it) }
        state?.let { h.post(it) }
        Notify.cancelScreen(core.ctx)
        // Through Bluetooth the picture needs Wi-Fi first (Netlink): asked for once it's there (onWifi).
        if (core.link.ble) {
            waitWifi = w to hpx
            core.net.need("screen")
            core.changed()
            return
        }
        policy(w, hpx)
    }

    private fun policy(w: Int, hpx: Int) {
        core.send(msg("screen.policy", "accept" to true, "width" to w, "height" to hpx))
        // Show the Mac's screen = the Mac starts sharing, in the mode used last.
        if (state == null) wantStart = true else startIfNeeded()
        core.changed()
    }

    @Volatile private var waitWifi: Pair<Int, Int>? = null

    // The session moved onto Wi-Fi (Core): the viewer that was waiting for it starts now.
    fun onWifi() {
        val (w, hpx) = waitWifi ?: return
        waitWifi = null
        if (viewing) core.bg.execute { policy(w, hpx) }
    }

    private fun startIfNeeded() {
        wantStart = false
        if (!viewing || sharing || !remote) return
        startedByUs = true
        control(share = true, mode = pickMode())
    }

    // Always Mirror to start with (the computer's screen as it is); Extend is a tap away in the viewer.
    private fun pickMode(): String {
        val modes = state?.optJSONArray("modes")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: listOf("extend", "mirror")
        return if ("mirror" in modes) "mirror" else modes.firstOrNull() ?: "mirror"
    }

    // The computer started sharing by itself (its Share Screen): open the viewer, or, where
    // Android doesn't let us start it from the background, a notification to tap.
    private fun autoOpen() {
        if (viewing) return
        autoOpened = true
        val ctx = core.ctx
        if (android.provider.Settings.canDrawOverlays(ctx)) {
            val ok = runCatching { ctx.startActivity(android.content.Intent(ctx, ViewerActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
            if (ok) return
        }
        Notify.screen(ctx, core.host?.name ?: "Your computer")
    }

    fun detach(h: WebHost) {
        if (host !== h) return
        host = null
        viewing = false
        size = null
        wantStart = false
        waitWifi = null
        core.net.release("screen")
        if (core.link.connected) {
            core.send(msg("screen.policy", "accept" to false))
            if (startedByUs && sharing) control(share = false)
        }
        startedByUs = false
        autoOpened = false
        core.changed()
    }

    // name: the computer we're connected to, for the viewer's messages (stream.info's is the
    // display it shares, e.g. the Mac's "TwinDesk (virtual)"; a PC or Linux sends none).
    fun opts(): JSONObject = msg("opts", "sound" to core.store.flag("screen.sound", false), "pacing" to (core.store.flag("screen.smooth", false).let { if (it) "smooth" else "fast" }),
        "name" to (core.host?.name ?: "the computer"))

    fun setOpt(key: String, on: Boolean) {
        core.store.setFlag(key, on)
        host?.post(opts())
        core.changed()
    }

    fun playing(w: Int, h: Int) {
        size = w to h
        core.changed()
    }

    // Start/stop the Mac's sharing, or switch Mirror/Extend (when the Mac allows it).
    fun control(share: Boolean? = null, mode: String? = null, close: Boolean = false) {
        val m = msg("screen.ctl")
        if (share != null) m.put("share", share)
        if (mode != null) m.put("mode", mode)
        if (close) m.put("close", true)
        if (share == false) startedByUs = false
        core.send(m)
    }

    fun keyboard(on: Boolean) {
        host?.post(msg("keyboard", "on" to on))
        host?.keyboard(on)
    }

    // The viewer's Close: the computer stops sharing too (whoever started it; close: even when it
    // doesn't let us start and switch it).
    fun end() {
        if (core.link.connected && sharing) control(share = false, close = true)
    }

    // Mirror / Extend tapped in the viewer (for this time: the next one starts on Mirror again).
    fun pick(mode: String) {
        control(share = true, mode = mode)
    }

    override fun onClosed() {
        Notify.cancelScreen(core.ctx)
        state = null
        lastInfo = null
        startedByUs = false
        host?.post(msg("stream.stop"))
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            "screen.state" -> {
                val was = state
                state = m
                host?.post(m)
                val on = m.optBoolean("on")
                // Off -> on, not asked for here: the person pressed Share Screen on the computer.
                if (was != null && !was.optBoolean("on") && on && !viewing && !startedByUs) autoOpen()
                if (!on) Notify.cancelScreen(core.ctx)
                if (wantStart) startIfNeeded()
                core.changed()
            }
            "stream.input" -> { inputOn = m.optBoolean("on", true); core.changed() }
            "stream.info" -> { lastInfo = m; host?.post(m) }
            "rtc.offer", "rtc.ice", "stream.stop" -> host?.post(m)
            else -> return false
        }
        return true
    }
}

// The Mac's sound here (audio m2w): a page in a WebView with no window answers its offers.
class MacSound(core: Core) : Feature(core) {
    private var host: WebHost? = null
    @Volatile var playing = false; private set

    fun sendPolicy() {
        core.send(msg("audio.policy", "accept" to core.sync.get("audio", "in")))
        if (!core.sync.get("audio", "in")) stop()
    }

    override fun onWelcome(host: Host) = sendPolicy()

    override fun onClosed() = stop()

    private fun stop() {
        host?.destroy()
        host = null
        if (playing) { playing = false; core.changed() }
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (!t.startsWith("audio.") || m.optString("dir") != "m2w") return false
        when (t) {
            "audio.offer" -> {
                if (!core.sync.get("audio", "in")) return true
                val h = host ?: WebHost(core.ctx, "audio.html", core).also { host = it }
                h.post(m)
                playing = true
                core.changed()
            }
            "audio.stop" -> stop()
            else -> host?.post(m)
        }
        return true
    }
}

// A Wi-Fi lock that keeps the radio out of power save (which holds packets back for up to a
// beacon interval, 100 ms and more): low latency while our viewer is in front, high performance
// for the computer's phone windows (low latency counts only for the app in front).
class WifiFast(ctx: Context) {
    private val wm = ctx.applicationContext.getSystemService(android.net.wifi.WifiManager::class.java)
    @Suppress("DEPRECATION")
    private val locks = listOfNotNull(
        runCatching { wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "TwinDesk:screen") }.getOrNull(),
        runCatching { wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "TwinDesk:screen-bg") }.getOrNull(),
    ).onEach { it.setReferenceCounted(false) }
    private var held = false

    @Synchronized fun hold(on: Boolean) {
        if (on == held) return
        held = on
        for (l in locks) runCatching { if (on) l.acquire() else l.release() }
        RemoteLog.i("TwinDesk", "wifi low latency ${if (on) "on" else "off"}")
    }
}
