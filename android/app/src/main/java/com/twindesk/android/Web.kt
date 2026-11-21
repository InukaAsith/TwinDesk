// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's screen and sound on the phone. The Mac already streams to the computers over WebRTC
// (mac/stream.js, mac/audio.js); Android's WebView speaks the same WebRTC, so the phone answers
// those offers in two small pages (assets/web): viewer.html for the screen (ViewerActivity) and
// audio.html for the sound (a WebView kept without a window). WebHost carries messages between
// the link and a page.
package com.twindesk.android

import android.annotation.SuppressLint
import android.content.Context
import android.media.MediaCodecList
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
    private val videoDecoders by lazy {
        runCatching { MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder } }
            .getOrDefault(emptyList())
    }

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
                Log.i("TwinDesk", "web: ${m.message()}")
                return true
            }
        }
        addJavascriptInterface(Bridge(), "TD")
        loadUrl("file:///android_asset/web/$page")
    }

    private inner class Bridge {
        // The pages' text in the app's language (I18n.kt); vars: a JSON object for its {name} parts.
        @JavascriptInterface fun tr(text: String, vars: String): String {
            val o = runCatching { JSONObject(vars) }.getOrNull() ?: JSONObject()
            return com.twindesk.android.tr(text, *o.keys().asSequence().map { it to o.opt(it) }.toList().toTypedArray())
        }

        @JavascriptInterface fun send(json: String) {
            runCatching { core.send(JSONObject(json)) }
        }
        // A pointer move or a wheel step (remote.js, viewer.js), many a second: written straight to the
        // socket (Link.sendMove), with no JSON string from the page and no JSONObject to parse and
        // write out again for each one. kind: 0 remote.mm {dx: a, dy: b, smooth}, 1 remote.wh {dx, dy},
        // 2 in.mm {x: a, y: b}.
        @JavascriptInterface fun move(kind: Int, a: Double, b: Double, smooth: Boolean) {
            core.link.sendMove(kind, a, b, smooth)
        }
        @JavascriptInterface fun ready() = main.post {
            ready = true
            for (m in queue) deliver(m)
            queue.clear()
            onEvent("ready", null)
        }.let { }
        @JavascriptInterface fun videoState(generation: Int, session: Int, playing: Boolean, w: Int, h: Int) = main.post {
            onEvent("videoState", msg("videoState", "generation" to generation, "session" to session, "playing" to playing, "w" to w, "h" to h))
        }.let { }
        @JavascriptInterface fun canDecodeVideo(codec: String, width: Int, height: Int, fps: Double): Boolean {
            val mime = when (codec.lowercase()) {
                "video/h264" -> "video/avc"
                "video/h265", "video/hevc" -> "video/hevc"
                "video/vp8" -> "video/x-vnd.on2.vp8"
                "video/vp9" -> "video/x-vnd.on2.vp9"
                "video/av1" -> "video/av01"
                else -> return false
            }
            if (width !in 1..4096 || height !in 1..2160 || !fps.isFinite() || fps !in 1.0..120.0) return false
            return videoDecoders.any { decoder ->
                runCatching { decoder.getCapabilitiesForType(mime).videoCapabilities
                    ?.areSizeAndRateSupported(width, height, fps) == true }.getOrDefault(false)
            }
        }
        @JavascriptInterface fun detail(generation: Int, session: Int, height: Int) = main.post {
            onEvent("videoDetail", msg("videoDetail", "generation" to generation, "session" to session, "height" to height))
        }.let { }
        @JavascriptInterface fun videoMetrics(generation: Int, session: Int, w: Int, h: Int, fps: Int, kbps: Int, dropped: Long) = main.post {
            onEvent("videoMetrics", msg("videoMetrics", "generation" to generation, "session" to session,
                "w" to w, "h" to h, "fps" to fps, "kbps" to kbps, "dropped" to dropped))
        }.let { }
        @JavascriptInterface fun playing(w: Int, h: Int) = main.post { onEvent("playing", JSONObject().put("w", w).put("h", h)) }.let { }
        @JavascriptInterface fun haptic() = main.post { view.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS) }.let { }
        // A light tap (a gamepad or touchpad button going down).
        @JavascriptInterface fun tick() = main.post { view.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY) }.let { }
        // Something for the activity around the page (remote.html: "close", "keyboard", "keyboardOff").
        @JavascriptInterface fun event(name: String) = main.post { onEvent(name, null) }.let { }
        // The gamepad's Keys: a control's key (Remote.CONTROLS id, a KeyboardEvent.code, Mouse0..2 or "").
        @JavascriptInterface fun setPad(id: String, code: String) = main.post {
            if (Remote.CONTROLS.any { it.first == id } && Remote.KEYS.any { it.first == code }) core.remote.setPad(id, code)
        }.let { }
        // The gamepad's layout (Edit): where each control is, its size, hidden ones, extra buttons.
        @JavascriptInterface fun setLayout(json: String) = main.post { core.remote.setLayout(json) }.let { }
        // The gamepad's state, as a Bluetooth gamepad (BtPad: remote.html while a computer is connected to it).
        @JavascriptInterface fun pad(b: Int, lx: Double, ly: Double, rx: Double, ry: Double, lt: Double, rt: Double) {
            if (core.btPadMade) core.btPad.pad(b, lx, ly, rx, ry, lt, rt)
        }
        // The phone's turning (remote.html's air mouse and presentation pointer): window.tdMotion while on.
        @JavascriptInterface fun motion(on: Boolean) = main.post {
            if (on && motion == null) motion = Motion(view.context) { s -> if (ready) view.evaluateJavascript("window.tdMotion&&tdMotion($s)", null) }.also { it.start() }
            else if (!on) { motion?.stop(); motion = null }
        }.let { }
    }

    private var motion: Motion? = null

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
        motion?.stop()
        motion = null
        ready = false
        view.removeJavascriptInterface("TD")
        view.loadUrl("about:blank")
        view.destroy()
    }
}

// One real display the computer offered in screen.state (the virtual display is Extend, and is not listed).
data class MacDisplay(val id: String, val name: String, val w: Int, val h: Int) {
    fun label(): String = buildString {
        append(name.ifBlank { id }.take(40))
        if (w > 0 && h > 0) append(" · ").append(w).append('×').append(h)
    }
}

data class StreamDoctorSample(val width: Int, val height: Int, val fps: Int?, val kbps: Int?, val droppedFrames: Long?) {
    fun summary(): String = listOfNotNull(
        "$width × $height",
        fps?.let { tr("{value} fps", "value" to it) },
        kbps?.let { tr("{value} Mb/s", "value" to String.format(java.util.Locale.ROOT, "%.1f", it / 1000.0)) },
        droppedFrames?.let { tr("{count} dropped frames", "count" to it) },
    ).joinToString(" · ")
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
    private var videoGeneration = 0
    private var videoSession: Int? = null
    private var videoMarker: Any? = null
    @Volatile var videoPlaying = false; private set
    private var wantStart = false // the viewer opened before we knew whether the Mac shares
    private var startedByUs = false // we started the Mac's sharing: stop it when the viewer closes
    @Volatile var autoOpened = false; private set // the computer started sharing and opened the viewer: it closes when that stops

    val sharing get() = state?.optBoolean("on") == true
    val mode get() = state?.optString("mode") ?: ""
    val remote get() = state?.optBoolean("remote", true) != false
    // The real display being mirrored, empty while extending or when the computer didn't say.
    val displayId get() = state?.optString("displayId").orEmpty()

    // Real displays the computer can mirror. Missing on an older computer: no picker, Mirror/Extend only.
    val displays: List<MacDisplay>
        get() {
            val a = state?.optJSONArray("displays") ?: return emptyList()
            val out = ArrayList<MacDisplay>(minOf(a.length(), 8))
            for (i in 0 until minOf(a.length(), 8)) {
                val o = a.optJSONObject(i) ?: continue
                val id = o.optString("id")
                if (id.isEmpty() || id.length > 16 || out.any { it.id == id }) continue
                out.add(MacDisplay(id, o.optString("name").take(60), o.optInt("w"), o.optInt("h")))
            }
            return out
        }

    // ViewerActivity opened: stream to us, at our screen's size (the Mac sizes Extend to it).
    fun attach(h: WebHost, w: Int, hpx: Int) {
        host = h
        resetVideo()
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

    // The same viewer resized: update Extend's shape without restarting sharing or its controls.
    fun resize(h: WebHost, w: Int, hpx: Int) {
        if (host !== h || !viewing || w <= 0 || hpx <= 0) return
        if (core.link.ble) waitWifi = w to hpx
        else core.send(msg("screen.policy", "accept" to true, "width" to w, "height" to hpx))
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
        // Opening again sends Mirror, and Mirror on the computer means the main screen.
        // A screen already picked stays that screen. Extend (no displayId) still starts on Mirror.
        val id = displayId
        if (id.isNotEmpty() && displays.any { it.id == id }) control(share = true, displayId = id)
        else control(share = true, mode = pickMode())
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
        Notify.screen(ctx, core.host?.name ?: tr("Your computer"))
    }

    fun detach(h: WebHost) {
        if (host !== h) return
        host = null
        resetVideo(keepDoctor = true)
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

    private fun pointerInput(): Boolean {
        val input = state?.opt("input") as? Boolean
        return when (core.host?.os) {
            "mac" -> inputOn && input != false // older Macs already report stream.input
            "win", "linux" -> input == true
            else -> false
        }
    }

    // name: the computer we're connected to, for the viewer's messages (stream.info's is the
    // display it shares, e.g. the Mac's "TwinDesk (virtual)"; a PC or Linux sends none).
    // touch: "pad" (slide moves the pointer, tap clicks) or "direct" (the
    // pointer goes where the finger is, tap = click); speed and tap are the Remote page's touchpad settings;
    // pen: a stylus is a pen on the computer (its pressure, tilt, eraser), else a mouse; penFast: a
    // stroke's samples batched per event (Fast writing), else each its own, paced (every point lands).
    fun opts(): JSONObject = msg("opts", "sound" to core.store.flag("screen.sound", false), "pacing" to (core.store.flag("screen.smooth", false).let { if (it) "smooth" else "fast" }),
        "inputOn" to pointerInput(), "name" to (core.host?.name ?: "the computer"), "touch" to (if (core.store.flag("screen.touchpad", true)) "pad" else "direct"),
        "speed" to core.remote.speed.toDouble(), "tap" to core.remote.tapClick, "pen" to core.store.flag("screen.pen", true),
        "penFast" to core.store.flag("screen.penFast", false))

    // The touchpad settings changed on the Remote page: an open viewer follows.
    fun repost() { host?.post(opts()) }

    fun setOpt(key: String, on: Boolean) {
        core.store.setFlag(key, on)
        host?.post(opts())
        core.changed()
    }

    private fun resetVideo(keepDoctor: Boolean = false) {
        if (!keepDoctor) clearDoctor()
        videoGeneration++
        videoSession = null
        videoMarker = null
        videoPlaying = false
    }

    internal fun onOffer(m: JSONObject, route: Link.TrustedRoute?) {
        // Link's socket can change while Core hands this message to the UI thread.
        if (route == null || !core.link.accepts(route)) return
        resetVideo()
        videoSession = m.optInt("session", -1)
        videoMarker = route.marker
        host?.post(JSONObject(m.toString()).put("viewerGeneration", videoGeneration))
        core.changed()
    }

    fun videoState(h: WebHost, generation: Int, session: Int, playing: Boolean, w: Int, height: Int) {
        if (host !== h || !viewing || videoGeneration != generation || videoSession != session ||
            !core.link.ownsVideoSession(videoMarker)) return
        if (videoPlaying != playing) {
            videoPlaying = playing
            core.changed()
        }
    }

    fun videoDetail(h: WebHost, generation: Int, session: Int, height: Int) {
        if (host !== h || !viewing || !sharing || !videoPlaying ||
            core.host?.os !in listOf("mac", "win", "linux") ||
            videoGeneration != generation || videoSession != session ||
            height !in 0..2160 || !core.link.ownsVideoSession(videoMarker)) return
        core.link.sendFor(videoMarker, msg("rtc.detail", "session" to session, "height" to height))
    }

    private data class DoctorReading(val marker: Any, val sample: StreamDoctorSample)
    @Volatile private var doctorReading: DoctorReading? = null
    val lastDoctorSample: StreamDoctorSample?
        get() = doctorReading?.takeIf { core.link.ownsVideoSession(it.marker) }?.sample

    val doctorSummary: String? get() = lastDoctorSample?.summary()

    fun doctorLinkChanged() {
        val reading = doctorReading ?: return
        if (!core.link.ownsVideoSession(reading.marker)) clearDoctor()
    }

    private fun clearDoctor() { doctorReading = null }

    fun videoMetrics(h: WebHost, generation: Int, session: Int, width: Int, height: Int, fps: Int, kbps: Int, dropped: Long) {
        val marker = videoMarker ?: return
        if (host !== h || !viewing || !sharing || !videoPlaying ||
            videoGeneration != generation || videoSession != session || !core.link.ownsVideoSession(marker) ||
            width !in 1..16384 || height !in 1..16384) return
        val sample = StreamDoctorSample(width, height, fps.takeIf { it in 0..240 },
            kbps.takeIf { it in 0..1_000_000 }, dropped.takeIf { it in 0..1_000_000_000 })
        val previous = doctorReading
        if (previous?.sample != sample || previous.marker !== marker) {
            doctorReading = DoctorReading(marker, sample)
            core.changed()
        }
    }

    fun playing(w: Int, h: Int) {
        size = w to h
        core.changed()
    }

    // Start/stop the Mac's sharing, or switch Mirror/Extend (when the Mac allows it).
    // displayId mirrors that real display and does not switch Extend/Mirror by itself.
    fun control(share: Boolean? = null, mode: String? = null, close: Boolean = false, displayId: String? = null) {
        val m = msg("screen.ctl")
        if (share != null) m.put("share", share)
        if (mode != null) m.put("mode", mode)
        if (close) m.put("close", true)
        if (displayId != null) m.put("displayId", displayId)
        if (share == false) {
            startedByUs = false
            resetVideo(keepDoctor = true)
        }
        core.send(m)
    }

    // Mirror one of the computer's real displays. Ownership matches Mirror: the viewer sets
    // startedByUs when it opens and sharing is off; choosing a display does not take the session over.
    fun pickDisplay(id: String) {
        if (id.isEmpty() || displays.none { it.id == id }) return
        control(share = true, displayId = id)
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

    // Mirror / Extend tapped in the viewer.
    fun pick(mode: String) {
        control(share = true, mode = mode)
    }

    override fun onWelcome(host: Host) {
        resetVideo()
        this.host?.post(msg("stream.stop"))
    }

    override fun onClosed() {
        Notify.cancelScreen(core.ctx)
        state = null
        resetVideo()
        lastInfo = null
        startedByUs = false
        host?.post(msg("stream.stop"))
        host?.post(msg("viewer.input", "on" to false))
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            "screen.state" -> {
                val was = state
                state = m
                host?.post(msg("viewer.input", "on" to pointerInput()))
                host?.post(m)
                val on = m.optBoolean("on")
                // Off -> on, not asked for here: the person pressed Share Screen on the computer.
                if (was != null && !was.optBoolean("on") && on && !viewing && !startedByUs) autoOpen()
                if (!on) { resetVideo(keepDoctor = true); Notify.cancelScreen(core.ctx) }

                if (wantStart) startIfNeeded()
                core.changed()
            }
            "stream.input" -> {
                inputOn = m.optBoolean("on", true)
                host?.post(msg("viewer.input", "on" to pointerInput()))
                core.changed()
            }
            "stream.info" -> { lastInfo = m; host?.post(m) }

            "stream.stop" -> { resetVideo(keepDoctor = true); host?.post(m); core.changed() }
            "rtc.ice" -> host?.post(m)
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
        Log.i("TwinDesk", "wifi low latency ${if (on) "on" else "off"}")
    }
}

// The phone's turning, for remote.html (tdMotion): the gyroscope's radians about the phone's x, y and z
// added up between calls (about every 12 ms), and which way is up (gravity, a unit vector), all in
// the phone's frame. "null" when there's no gyroscope.
class Motion(ctx: Context, private val out: (String) -> Unit) : android.hardware.SensorEventListener {
    private val sm = ctx.getSystemService(android.hardware.SensorManager::class.java)
    private val gyro = sm?.getDefaultSensor(android.hardware.Sensor.TYPE_GYROSCOPE)
    private val grav = sm?.getDefaultSensor(android.hardware.Sensor.TYPE_GRAVITY)
    private val accel = if (grav == null) sm?.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER) else null
    private val main = Handler(Looper.getMainLooper())
    private var last = 0L
    private var lastOut = 0L
    private val a = DoubleArray(3)
    private val up = doubleArrayOf(0.0, 0.0, 1.0)

    fun start() {
        if (sm == null || gyro == null) return out("null")
        sm.registerListener(this, gyro, 5_000, main) // as fast as it gives, up to 200 a second
        (grav ?: accel)?.let { sm.registerListener(this, it, android.hardware.SensorManager.SENSOR_DELAY_GAME, main) }
    }

    fun stop() { sm?.unregisterListener(this) }

    override fun onSensorChanged(e: android.hardware.SensorEvent) {
        val v = e.values
        if (e.sensor.type != android.hardware.Sensor.TYPE_GYROSCOPE) {
            val n = Math.sqrt((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).toDouble())
            if (n < 1) return
            val k = if (accel != null) 0.15 else 1.0 // the accelerometer alone: smoothed, so a shake doesn't tip "up"
            for (i in 0..2) up[i] += (v[i] / n - up[i]) * k
            val m = Math.sqrt(up[0] * up[0] + up[1] * up[1] + up[2] * up[2]).takeIf { it > 0 } ?: 1.0
            for (i in 0..2) up[i] /= m
            return
        }
        if (last != 0L) {
            val dt = (e.timestamp - last) / 1e9
            if (dt > 0 && dt < 0.1) for (i in 0..2) a[i] += v[i] * dt
        }
        last = e.timestamp
        val now = android.os.SystemClock.uptimeMillis()
        if (now - lastOut < 12) return
        lastOut = now
        val f = { d: Double -> String.format(java.util.Locale.ROOT, "%.6f", d) }
        out("${f(a[0])},${f(a[1])},${f(a[2])},${f(up[0])},${f(up[1])},${f(up[2])}")
        a.fill(0.0)
    }

    override fun onAccuracyChanged(s: android.hardware.Sensor?, acc: Int) {}
}
