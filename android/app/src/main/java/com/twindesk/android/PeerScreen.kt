// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Connect with Android › Screen (Peer.kt): the other phone's screen here, to look at (no control).
// The phone being looked at: Android's screen capture (its own Start, PeerGrantActivity) in a service
// of its own (PeerCaptureService, apart from the computer's SoundService), the hardware H.264 encoder,
// and scrcpy's 12-byte packets (ScreenStreamer's). The bytes go in one HTTPS stream to or from the
// host: the guest POSTs its screen (/peer/screen), or GETs the host's after screen.ready.
// The phone looking: PeerViewActivity, a SurfaceView fed by the hardware decoder.
//   q screen.start {maxSize}  →  screen.ready (host's screen)  …  screen.stop / screen.state {on, error}
package com.twindesk.android

import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.io.DataInputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

object PeerScreen {
    private val main = Handler(Looper.getMainLooper())
    @Volatile var viewer: PeerViewActivity? = null
    @Volatile var capture: PeerCaptureService? = null
    @Volatile var maxSize = 1600
    @Volatile var lastState = ""

    // ---- the phone being looked at ----

    private val queue = LinkedBlockingQueue<ByteArray>()
    private val queued = AtomicLong(0)
    @Volatile private var dropping = false
    @Volatile private var sessionPacket: ByteArray? = null
    @Volatile private var configPacket: ByteArray? = null
    @Volatile private var post: Call? = null
    private const val MAX_QUEUED = 3L * 1024 * 1024

    // The other phone wants to look: Start here (Android's own prompt), on screen when it lets us
    // open it, else from a notification.
    fun asked(peer: Peer, size: Int) {
        maxSize = size.coerceIn(480, 2400)
        val c = capture
        if (c != null) { c.sync(); if (peer.role == "host") peer.send(msg("screen.ready")); return }
        val i = Intent(peer.core.ctx, PeerGrantActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (android.provider.Settings.canDrawOverlays(peer.core.ctx) || MainActivity.shown) runCatching { peer.core.ctx.startActivity(i) }
        Notify.peer(peer.core.ctx, tr("{name} wants to see your screen", "name" to peer.peerName), tr("Tap to share this screen with {name}.", "name" to peer.peerName),
            PendingIntent.getActivity(peer.core.ctx, 19, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }

    fun tell(peer: Peer, on: Boolean, error: String = "") { peer.send(msg("screen.state", "on" to on, "error" to error)) }

    // From the encoder: config and keyframes always go; behind by too much, the rest waits for the next keyframe.
    fun put(p: ByteArray, important: Boolean, session: Boolean = false, config: Boolean = false) {
        if (session) sessionPacket = p
        if (config) configPacket = p
        if (queued.get() > MAX_QUEUED && !important) { if (!dropping) { dropping = true; capture?.sync() }; return }
        if (dropping && !important) return
        if (important) dropping = false
        queued.addAndGet(p.size.toLong())
        queue.offer(p)
    }

    // A new stream: what's queued is from before, so it starts at the next keyframe (asked for now).
    private fun fresh() {
        queue.clear(); queued.set(0)
        dropping = true
        capture?.sync()
    }

    private fun take(): ByteArray? = queue.poll(500, TimeUnit.MILLISECONDS)?.also { queued.addAndGet(-it.size.toLong()) }

    // Capture started: the bytes go to the host (we're the guest), or the host says screen.ready.
    fun capturing(peer: Peer) {
        queue.clear(); queued.set(0)
        tell(peer, true)
        if (peer.role == "host") { peer.send(msg("screen.ready")); return }
        val (client, req) = peer.guestRequest("/peer/screen") ?: return
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                fresh()
                sessionPacket?.let { sink.write(it) }
                configPacket?.let { sink.write(it) }
                while (capture != null) {
                    val p = take() ?: continue
                    sink.write(p)
                    if (queue.isEmpty()) sink.flush()
                }
            }
        }
        Thread({
            runCatching { val c = client.newCall(req.post(body).build()); post = c; c.execute().close() }
                .onFailure { Log.w("TwinDesk", "peer screen: ${it.message}") }
            post = null
            main.post { capture?.stopSelf() }
        }, "td-peer-scr").start()
    }

    fun captureEnded(peer: Peer) {
        post?.cancel(); post = null
        queue.clear(); queued.set(0)
        sessionPacket = null; configPacket = null
        tell(peer, false)
        Notify.cancelPeer(peer.core.ctx)
    }

    // The other phone closed its window (or the session ended).
    fun remoteStop(peer: Peer) = main.post { capture?.stopSelf() }

    fun stopAll(peer: Peer) = main.post {
        capture?.stopSelf()
        viewer?.finish()
    }

    // ---- HTTPS on the host ----

    class Ended : Exception()

    fun http(peer: Peer, method: String, body: InputStream, out: OutputStream) {
        if (method == "POST") { // the guest's screen, to our window
            val v = viewer ?: return PeerServer.respond(out, 409)
            v.feed(body)
            PeerServer.respond(out, 200)
            throw Ended() // its socket closes
        }
        if (method == "GET") { // our screen, to the guest's window
            if (capture == null) return PeerServer.respond(out, 409)
            fresh()
            PeerServer.streamHead(out)
            sessionPacket?.let { out.write(it) }
            configPacket?.let { out.write(it) }
            out.flush()
            while (capture != null) {
                val p = take() ?: continue
                out.write(p)
                if (queue.isEmpty()) out.flush()
            }
            throw Ended()
        }
        PeerServer.respond(out, 400)
    }

    // ---- the phone looking ----

    fun view(peer: Peer, ctx: Context) {
        ctx.startActivity(Intent(ctx, PeerViewActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    // The host's screen is ready (we're the guest): fetch it.
    fun ready(peer: Peer) { viewer?.fetch(peer) }

    fun state(peer: Peer, m: JSONObject) {
        lastState = m.optString("error")
        val v = viewer ?: return
        main.post { if (!m.optBoolean("on")) { if (lastState.isNotEmpty()) v.say(lastState) else v.finish() } else v.say("") }
    }
}

// Android's prompt for the screen capture, then the service with its answer.
class PeerGrantActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Notify.cancelPeer(this)
        runCatching { startActivityForResult(getSystemService(MediaProjectionManager::class.java).createScreenCaptureIntent(), 1) }
            .onFailure { finish() }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val peer = Core.get(this).peer
        if (resultCode == RESULT_OK && data != null && peer.connected) {
            startForegroundService(Intent(this, PeerCaptureService::class.java).putExtra("code", resultCode).putExtra("data", data))
        } else PeerScreen.tell(peer, false, "${Core.get(this).store.deviceName} didn’t share its screen")
        finish()
    }
}

// The capture and its encoder, while the other phone looks.
class PeerCaptureService : Service() {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var codec: MediaCodec? = null
    private var surface: Surface? = null
    @Volatile private var gen = 0
    private val main = Handler(Looper.getMainLooper())
    private lateinit var peer: Peer
    private val dm by lazy { getSystemService(DisplayManager::class.java) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        peer = Core.get(this).peer
        if (intent?.action == STOP) { stopSelf(); return START_NOT_STICKY }
        val stop = PendingIntent.getService(this, 20, Intent(this, PeerCaptureService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, Notify.CH_LINK).setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(tr("Sharing this screen with {name}", "name" to peer.peerName))
            .setContentText(tr("Only to look at: {name} can’t control this phone.", "name" to peer.peerName))
            .addAction(Notification.Action.Builder(null, tr("Stop"), stop).build())
            .setOngoing(true).build()
        try {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } catch (e: Exception) { PeerScreen.tell(peer, false, e.message ?: "couldn’t start"); stopSelf(); return START_NOT_STICKY }
        if (projection != null) return START_NOT_STICKY
        @Suppress("DEPRECATION") val data: Intent? = intent?.getParcelableExtra("data")
        try {
            val p = getSystemService(MediaProjectionManager::class.java).getMediaProjection(intent?.getIntExtra("code", 0) ?: 0, data!!)!!
            projection = p
            p.registerCallback(object : MediaProjection.Callback() { override fun onStop() { stopSelf() } }, main)
            PeerScreen.capture = this
            encode()
            dm.registerDisplayListener(rotation, main)
            PeerScreen.capturing(peer)
        } catch (e: Exception) {
            Log.w("TwinDesk", "peer capture: ${e.message}")
            PeerScreen.tell(peer, false, e.message ?: "couldn’t capture")
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (PeerScreen.capture === this) PeerScreen.capture = null
        runCatching { dm.unregisterDisplayListener(rotation) }
        stopEncoder()
        runCatching { display?.release() }
        runCatching { projection?.stop() }
        if (::peer.isInitialized) PeerScreen.captureEnded(peer)
        super.onDestroy()
    }

    fun sync() { runCatching { codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) } }

    private val rotation = object : DisplayManager.DisplayListener {
        private var last = Pair(0, 0)
        override fun onDisplayAdded(id: Int) {}
        override fun onDisplayRemoved(id: Int) {}
        override fun onDisplayChanged(id: Int) {
            if (id != Display.DEFAULT_DISPLAY) return
            val (w, h) = screen().let { it.first to it.second }
            if (last != Pair(w, h)) { last = Pair(w, h); runCatching { encode() } }
        }
    }

    @Suppress("DEPRECATION")
    private fun screen(): Triple<Int, Int, Int> {
        val m = DisplayMetrics()
        dm.getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(m)
        return Triple(m.widthPixels, m.heightPixels, m.densityDpi)
    }

    private fun encode() {
        stopEncoder()
        val (sw, sh, dpi) = screen()
        val long = maxOf(sw, sh)
        val want = minOf(long, PeerScreen.maxSize)
        var w = 0; var h = 0
        var c: MediaCodec? = null
        for (target in listOf(want, 1600, 1280, 960)) {
            if (target > want) continue
            val k = target.toDouble() / long
            w = (Math.round(sw * k / 16.0) * 16).toInt().coerceAtLeast(16)
            h = (Math.round(sh * k / 16.0) * 16).toInt().coerceAtLeast(16)
            c = runCatching { configure(w, h) }.getOrNull()
            if (c != null) break
        }
        val codec = c ?: throw IllegalStateException("The video encoder didn’t start")
        val input = codec.createInputSurface()
        codec.start()
        this.codec = codec
        surface = input
        val d = display
        if (d == null) display = projection!!.createVirtualDisplay("TwinDesk peer", w, h, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, input, null, null)
        else { d.resize(w, h, dpi); d.surface = input }
        PeerScreen.put(ScreenStreamer.sessionPacket(w, h), true, session = true)
        val my = ++gen
        Thread({ drain(codec, my) }, "td-peer-enc").start()
    }

    private fun configure(w: Int, h: Int): MediaCodec {
        val f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 6_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, 60)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10)
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000)
            setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, 60f)
        }
        val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        try { c.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE) } catch (e: Exception) { c.release(); throw e }
        return c
    }

    private fun stopEncoder() {
        gen++
        val c = codec ?: return
        codec = null
        runCatching { c.stop() }
        runCatching { c.release() }
        runCatching { surface?.release() }
        surface = null
    }

    private fun drain(c: MediaCodec, my: Int) {
        val info = MediaCodec.BufferInfo()
        while (gen == my) {
            val i = try { c.dequeueOutputBuffer(info, 100_000) } catch (e: Exception) { break }
            if (i < 0) continue
            try {
                if (info.size > 0) {
                    val buf: ByteBuffer = c.getOutputBuffer(i) ?: continue
                    val data = ByteArray(info.size)
                    buf.position(info.offset); buf.get(data)
                    val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                    val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                    PeerScreen.put(ScreenStreamer.framePacket(info.presentationTimeUs, config, key, data), config || key, config = config)
                }
            } finally { runCatching { c.releaseOutputBuffer(i, false) } }
        }
    }

    companion object {
        const val ID = 19
        const val STOP = "com.twindesk.android.PEER_SCREEN_STOP"
    }
}

// The other phone's screen, full screen. Back closes it (and the other phone stops).
class PeerViewActivity : Activity(), SurfaceHolder.Callback {
    private lateinit var view: SurfaceView
    private lateinit var label: TextView
    private lateinit var frame: FrameLayout
    private val ready = CountDownLatch(1)
    @Volatile private var surface: Surface? = null
    @Volatile private var codec: MediaCodec? = null
    @Volatile private var call: Call? = null
    @Volatile private var alive = true
    private var size = Pair(0, 0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        frame = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        view = SurfaceView(this)
        label = TextView(this).apply { setTextColor(Color.WHITE); textSize = 16f; gravity = Gravity.CENTER; setPadding(48, 48, 48, 48) }
        frame.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))
        frame.addView(label, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        setContentView(frame)
        view.holder.addCallback(this)
        val peer = Core.get(this).peer
        if (!peer.connected) { finish(); return }
        PeerScreen.viewer = this
        say(tr("Waiting for {name}… Tap Start there.", "name" to peer.peerName))
        val long = maxOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
        peer.ask("screen.start", JSONObject().put("maxSize", long.coerceIn(720, 2400))) { r -> if (r.has("error")) say(tr("Couldn’t ask: {error}", "error" to r.optString("error"))) }
    }

    override fun onDestroy() {
        alive = false
        if (PeerScreen.viewer === this) PeerScreen.viewer = null
        call?.cancel()
        runCatching { Core.get(this).peer.send(msg("screen.stop")) }
        releaseCodec()
        super.onDestroy()
    }

    fun say(text: String) = runOnUiThread { label.text = text; label.visibility = if (text.isEmpty()) android.view.View.GONE else android.view.View.VISIBLE }

    override fun surfaceCreated(holder: SurfaceHolder) { surface = holder.surface; ready.countDown() }
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
    override fun surfaceDestroyed(holder: SurfaceHolder) { surface = null }

    // The host's screen (we're the guest): one GET, read until it ends.
    fun fetch(peer: Peer) {
        val (client, req) = peer.guestRequest("/peer/screen") ?: return
        Thread({
            runCatching {
                val c = client.newCall(req.build()); call = c
                c.execute().use { r -> if (r.code == 200) feed(r.body.byteStream()) }
            }.onFailure { if (alive) Log.w("TwinDesk", "peer view: ${it.message}") }
            if (alive) runOnUiThread { finish() }
        }, "td-peer-view").start()
    }

    // The packets (ScreenStreamer's): a session one at each new size, then the encoder's.
    fun feed(input: InputStream) {
        ready.await(5, TimeUnit.SECONDS)
        val s = DataInputStream(input)
        val head = ByteArray(12)
        val info = MediaCodec.BufferInfo()
        try {
            while (alive) {
                s.readFully(head)
                val bb = ByteBuffer.wrap(head)
                if (head[0].toInt() and 0x80 != 0) {
                    val w = bb.getInt(4); val h = bb.getInt(8)
                    start(w, h)
                    continue
                }
                val flags = bb.getLong(0)
                val len = bb.getInt(8)
                if (len <= 0 || len > 8 * 1024 * 1024) break
                val data = ByteArray(len)
                s.readFully(data)
                val c = codec ?: continue
                val config = flags and (1L shl 62) != 0L
                val pts = flags and ((1L shl 61) - 1)
                val i = c.dequeueInputBuffer(50_000)
                if (i >= 0) {
                    c.getInputBuffer(i)!!.apply { clear(); put(data) }
                    c.queueInputBuffer(i, 0, len, pts, if (config) MediaCodec.BUFFER_FLAG_CODEC_CONFIG else 0)
                }
                while (true) {
                    val o = c.dequeueOutputBuffer(info, 0)
                    if (o >= 0) c.releaseOutputBuffer(o, true) else if (o == MediaCodec.INFO_TRY_AGAIN_LATER) break
                }
            }
        } catch (e: Exception) {
            if (alive) Log.i("TwinDesk", "peer view ended: ${e.message}")
        }
    }

    private fun start(w: Int, h: Int) {
        if (w <= 0 || h <= 0) return
        releaseCodec()
        val sf = surface ?: return
        runOnUiThread { fit(w, h); say("") }
        val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        c.configure(MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h), sf, null, 0)
        c.start()
        codec = c
    }

    private fun releaseCodec() {
        val c = codec ?: return
        codec = null
        runCatching { c.stop() }
        runCatching { c.release() }
    }

    // The picture as big as fits, its shape kept.
    private fun fit(w: Int, h: Int) {
        size = Pair(w, h)
        val fw = frame.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels
        val fh = frame.height.takeIf { it > 0 } ?: resources.displayMetrics.heightPixels
        val k = minOf(fw.toDouble() / w, fh.toDouble() / h)
        view.layoutParams = FrameLayout.LayoutParams((w * k).toInt(), (h * k).toInt(), Gravity.CENTER)
    }
}
