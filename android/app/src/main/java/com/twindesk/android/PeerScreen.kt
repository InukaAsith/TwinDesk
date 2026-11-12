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
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.AudioTrack
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
import java.nio.ByteOrder
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

object PeerScreen {
    private val main = Handler(Looper.getMainLooper())
    @Volatile var viewer: PeerViewActivity? = null
    @Volatile var capture: PeerCaptureService? = null
    @Volatile var audioPlayer: PeerAudioPlayer? = null
    @Volatile var maxSize = 1600
    @Volatile var lastState = ""
    @Volatile var soundError = ""
    @Volatile var screenActive = false
    @Volatile var remoteWantsAudio = false
    @Volatile var standaloneSoundActive = false
    @Volatile var remoteSoundOn = false

    // ---- sound playback and capture controls ----

    fun ensureAudioPlayer(): PeerAudioPlayer {
        var p = audioPlayer
        if (p == null) {
            p = PeerAudioPlayer()
            audioPlayer = p
        }
        return p
    }

    fun stopAudio() {
        audioPlayer?.release()
        audioPlayer = null
    }

    fun onSound(peer: Peer, m: JSONObject) {
        if (!peer.screenSound) return
        ensureAudioPlayer().feed(m)
    }

    @Volatile var pendingRemoteUdpPort = 0
    @Volatile var pendingRemoteUdpToken = 0L
    @Volatile var pendingRemoteUdpKey: ByteArray? = null

    // The listener's key for the UDP lane, sent over the phones' TLS link; no key, no UDP (the sound
    // then goes through that link instead).
    fun keyOf(m: JSONObject): ByteArray? = m.optString("udpKey").takeIf { it.isNotEmpty() }
        ?.let { runCatching { android.util.Base64.decode(it, android.util.Base64.NO_WRAP) }.getOrNull() }?.takeIf { it.size == 16 }

    fun wantSound(peer: Peer, on: Boolean) {
        if (!peer.connected) return
        val player = if (on) ensureAudioPlayer() else null
        val port = player?.udpPort ?: 0
        val token = player?.udpToken ?: 0L
        peer.send(msg(Proto.T.PEER_SOUND_WANT, "on" to on, "udpPort" to port, "udpToken" to token, "udpKey" to (player?.udpKeyB64 ?: "")))
    }

    fun onSoundWant(peer: Peer, m: JSONObject) {
        val on = m.optBoolean("on")
        remoteWantsAudio = on
        val remotePort = m.optInt("udpPort", 0)
        val remoteToken = m.optLong("udpToken", 0L)
        val remoteKey = keyOf(m)
        val c = capture
        if (c != null) {
            if (remotePort > 0 && remoteToken != 0L && remoteKey != null) {
                peer.peerAddress()?.let { addr -> c.setRemoteUdp(addr, remotePort, remoteToken, remoteKey) }
            }
            c.update()
        } else if (on && peer.shareSound) {
            pendingRemoteUdpPort = remotePort
            pendingRemoteUdpToken = remoteToken
            pendingRemoteUdpKey = remoteKey
            val ctx = peer.core.ctx
            val i = Intent(ctx, PeerGrantActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            if (android.provider.Settings.canDrawOverlays(ctx) || MainActivity.shown) runCatching { ctx.startActivity(i) }
            val pi = PendingIntent.getActivity(ctx, 19, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            Notify.peer(
                ctx,
                tr("{name} wants to hear audio from this phone", "name" to peer.peerName),
                tr("Tap to share sound with {name}.", "name" to peer.peerName),
                pi,
            )
        }
        peer.core.changed()
    }

    fun onSoundState(peer: Peer, m: JSONObject) {
        val on = m.optBoolean("on")
        remoteSoundOn = on
        val err = m.optString("error")
        if (err.isNotEmpty()) soundError = err
        val remotePort = m.optInt("udpPort", 0)
        val remoteToken = m.optLong("udpToken", 0L)
        if (on) {
            val player = ensureAudioPlayer()
            if (remotePort > 0 && remoteToken != 0L) {
                peer.peerAddress()?.let { addr -> player.connectUdp(addr, remotePort, remoteToken) }
            }
            if (peer.connected) {
                peer.send(msg(Proto.T.PEER_SOUND_WANT, "on" to true, "udpPort" to player.udpPort, "udpToken" to player.udpToken, "udpKey" to player.udpKeyB64))
            }
        } else {
            if (!peer.screenSound || viewer == null) {
                stopAudio()
            }
        }
        peer.core.changed()
    }

    fun tellSoundState(peer: Peer) {
        val c = capture
        val on = (c?.capturingAudio == true) || standaloneSoundActive
        val port = c?.udpPort ?: 0
        val token = c?.udpToken ?: 0L
        if (peer.connected) peer.send(msg(Proto.T.PEER_SOUND_STATE, "on" to on, "error" to soundError, "udpPort" to port, "udpToken" to token))
    }

    fun startStandaloneSound(peer: Peer, ctx: Context) {
        if (!peer.connected) return
        standaloneSoundActive = true
        soundError = ""
        val c = capture
        if (c != null) {
            c.update()
        } else {
            val i = Intent(ctx, PeerGrantActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            runCatching { ctx.startActivity(i) }
        }
        tellSoundState(peer)
        peer.core.changed()
    }

    fun stopStandaloneSound(peer: Peer) {
        standaloneSoundActive = false
        val c = capture
        if (c != null) {
            if (!screenActive) c.stopSelf() else c.update()
        } else {
            tellSoundState(peer)
        }
        peer.core.changed()
    }

    fun startCapture(ctx: Context) {
        startStandaloneSound(Core.get(ctx).peer, ctx)
    }

    fun stopCapture() {
        capture?.let { stopStandaloneSound(Core.get(it).peer) }
    }

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
    fun asked(peer: Peer, size: Int, audio: Boolean = true, remotePort: Int = 0, remoteToken: Long = 0L, remoteKey: ByteArray? = null) {
        maxSize = size.coerceIn(480, 2400)
        remoteWantsAudio = audio
        screenActive = true
        val c = capture
        if (c != null) {
            if (remotePort > 0 && remoteToken != 0L && remoteKey != null) {
                peer.peerAddress()?.let { addr -> c.setRemoteUdp(addr, remotePort, remoteToken, remoteKey) }
            }
            c.sync()
            c.update()
            if (peer.role == "host") peer.send(msg("screen.ready"))
            return
        }
        pendingRemoteUdpPort = remotePort
        pendingRemoteUdpToken = remoteToken
        pendingRemoteUdpKey = remoteKey
        val ctx = peer.core.ctx
        val i = Intent(ctx, PeerGrantActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (android.provider.Settings.canDrawOverlays(ctx) || MainActivity.shown) runCatching { ctx.startActivity(i) }
        val pi = PendingIntent.getActivity(ctx, 19, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        Notify.peer(
            ctx,
            tr("{name} wants to see your screen", "name" to peer.peerName),
            tr("Tap to share this screen with {name}.", "name" to peer.peerName),
            pi,
        )
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
                while (capture != null && screenActive) {
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
            main.post {
                screenActive = false
                if (!standaloneSoundActive) capture?.stopSelf()
                else capture?.update()
            }
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
    fun remoteStop(peer: Peer) = main.post {
        screenActive = false
        val c = capture
        if (c != null) {
            if (!standaloneSoundActive) c.stopSelf()
            else c.update()
        }
    }

    fun stopAll(peer: Peer) = main.post {
        screenActive = false
        standaloneSoundActive = false
        remoteWantsAudio = false
        capture?.stopSelf()
        viewer?.finish()
        stopAudio()
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
            if (capture == null || !screenActive) return PeerServer.respond(out, 409)
            fresh()
            PeerServer.streamHead(out)
            sessionPacket?.let { out.write(it) }
            configPacket?.let { out.write(it) }
            out.flush()
            while (capture != null && screenActive) {
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
        val peer = Core.get(this).peer
        val needAudio = peer.shareSound && (PeerScreen.remoteWantsAudio || PeerScreen.standaloneSoundActive || PeerScreen.screenActive)
        if (needAudio && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 2)
        } else ask()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        ask()
    }

    private fun ask() {
        runCatching { startActivityForResult(getSystemService(MediaProjectionManager::class.java).createScreenCaptureIntent(), 1) }
            .onFailure { finish() }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val peer = Core.get(this).peer
        if (requestCode == 1 && resultCode == RESULT_OK && data != null && peer.connected) {
            startForegroundService(Intent(this, PeerCaptureService::class.java).putExtra("code", resultCode).putExtra("data", data))
        } else if (requestCode == 1) {
            PeerScreen.standaloneSoundActive = false
            if (PeerScreen.screenActive) PeerScreen.tell(peer, false, "${Core.get(this).store.deviceName} didn’t share its screen")
            PeerScreen.screenActive = false // nothing is shared: no low-latency Wi-Fi or busy link for it
            PeerScreen.remoteWantsAudio = false
            PeerScreen.tellSoundState(peer)
            peer.core.changed()
        }
        finish()
    }
}

// The capture and its encoder, while the other phone looks or listens.
class PeerCaptureService : Service() {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var codec: MediaCodec? = null
    private var surface: Surface? = null
    @Volatile private var gen = 0
    private val main = Handler(Looper.getMainLooper())
    private lateinit var peer: Peer
    private val dm by lazy { getSystemService(DisplayManager::class.java) }
    private var audioRecord: AudioRecord? = null
    private var audioCodec: MediaCodec? = null
    @Volatile var audioCodecName = "pcm"; private set
    @Volatile var capturingAudio = false; private set
    private var audioThread: Thread? = null

    private var udpSocket: DatagramSocket? = null
    @Volatile var udpPort = 0; private set
    @Volatile var udpToken = 0L; private set
    @Volatile private var remoteUdpAddr: InetSocketAddress? = null
    @Volatile var udpActive = false; private set
    private var udpRxThread: Thread? = null
    private var udpSeq = 0
    private var udpSalt = 0
    @Volatile private var remoteUdpKey: ByteArray? = null

    fun setRemoteUdp(host: String, port: Int, token: Long, key: ByteArray) {
        if (port <= 0 || token == 0L) return
        Thread({
            runCatching {
                val addr = InetAddress.getByName(host)
                remoteUdpKey = key
                remoteUdpAddr = InetSocketAddress(addr, port)
                udpActive = true
            }
        }, "td-peer-aud-dns").start()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val title = when {
            capturingAudio && codec != null -> tr("Sharing screen and sound with {name}", "name" to peer.peerName)
            codec != null -> tr("Sharing this screen with {name}", "name" to peer.peerName)
            else -> tr("Sharing sound with {name}", "name" to peer.peerName)
        }
        val text = when {
            codec != null -> tr("Only to look at: {name} can’t control this phone.", "name" to peer.peerName)
            else -> tr("Audio is playing on {name}.", "name" to peer.peerName)
        }
        val stop = PendingIntent.getService(this, 20, Intent(this, PeerCaptureService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, Notify.CH_LINK).setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .addAction(Notification.Action.Builder(null, tr("Stop"), stop).build())
            .setOngoing(true).build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        peer = Core.get(this).peer
        if (intent?.action == STOP) { stopSelf(); return START_NOT_STICKY }
        val n = buildNotification()
        val fgsType = if (android.os.Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0
        try {
            if (fgsType != 0) startForeground(ID, n, fgsType)
            else startForeground(ID, n)
        } catch (e: Exception) {
            PeerScreen.tell(peer, false, e.message ?: "couldn’t start")
            stopSelf()
            return START_NOT_STICKY
        }
        if (projection != null) {
            update()
            return START_NOT_STICKY
        }
        @Suppress("DEPRECATION") val data: Intent? = intent?.getParcelableExtra("data")
        val code = intent?.getIntExtra("code", 0) ?: 0
        if (data == null) { stopSelf(); return START_NOT_STICKY }
        try {
            val p = getSystemService(MediaProjectionManager::class.java).getMediaProjection(code, data) ?: throw IllegalStateException("no capture grant")
            projection = p
            p.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.i("TwinDesk", "MediaProjection stopped by system")
                    stopSelf()
                }
            }, main)
            PeerScreen.capture = this
            dm.registerDisplayListener(rotation, main)
            update()
        } catch (e: Exception) {
            Log.w("TwinDesk", "peer capture: ${e.message}")
            PeerScreen.soundError = e.message ?: "couldn’t capture"
            PeerScreen.tell(peer, false, e.message ?: "couldn’t capture")
            stopSelf()
        }
        return START_NOT_STICKY
    }

    fun update() {
        val p = projection ?: return
        val wantAudio = peer.shareSound && (PeerScreen.remoteWantsAudio || PeerScreen.standaloneSoundActive)
        val wantScreen = PeerScreen.screenActive
        if (!wantAudio && !wantScreen) {
            stopSelf()
            return
        }
        if (wantAudio && !capturingAudio) {
            beginAudio(p)
        } else if (!wantAudio && capturingAudio) {
            endAudio()
        }
        if (wantScreen && codec == null) {
            runCatching {
                encode()
                PeerScreen.capturing(peer)
            }.onFailure { e ->
                Log.w("TwinDesk", "peer encode: ${e.message}")
                PeerScreen.tell(peer, false, e.message ?: "couldn’t start screen encoder")
            }
        } else if (!wantScreen && codec != null) {
            stopEncoder()
            PeerScreen.captureEnded(peer)
        }
        updateNotification()
        PeerScreen.tellSoundState(peer)
        peer.core.changed()
    }

    private fun updateNotification() {
        val n = buildNotification()
        runCatching {
            getSystemService(android.app.NotificationManager::class.java).notify(ID, n)
        }
    }

    private fun beginAudio(p: MediaProjection) {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            PeerScreen.soundError = "Microphone permission required for sound capture"
            return
        }
        val rate = 48000
        val frame = 960 // 20 ms
        val cfg = AudioPlaybackCaptureConfiguration.Builder(p)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .excludeUid(android.os.Process.myUid()) // not the other phone's sound we play: it would go back round as an echo
            .build()
        val fmt = AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build()
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
        val r = runCatching {
            AudioRecord.Builder().setAudioFormat(fmt).setBufferSizeInBytes(maxOf(min, frame * 4 * 8)).setAudioPlaybackCaptureConfig(cfg).build()
        }.getOrNull() ?: run {
            PeerScreen.soundError = "Could not initialize audio capture"
            return
        }
        if (r.state != AudioRecord.STATE_INITIALIZED) {
            r.release()
            PeerScreen.soundError = "Audio record not initialized"
            return
        }
        audioRecord = r
        // Opus (Android 10's own encoder); raw PCM where a phone has none.
        audioCodec = runCatching {
            MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS).apply {
                configure(MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, rate, 2).apply {
                    setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
                }, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                start()
            }
        }.getOrNull()
        audioCodecName = if (audioCodec != null) "opus" else "pcm"

        val token = java.util.concurrent.ThreadLocalRandom.current().nextLong()
        udpToken = token
        val uSock = runCatching { DatagramSocket(0) }.getOrNull()
        udpSocket = uSock
        udpPort = uSock?.localPort ?: 0
        udpActive = false
        udpSeq = 0
        udpSalt = java.util.concurrent.ThreadLocalRandom.current().nextInt() // with the sequence, a new nonce for every packet under the listener's key
        val pendingKey = PeerScreen.pendingRemoteUdpKey
        if (PeerScreen.pendingRemoteUdpPort > 0 && PeerScreen.pendingRemoteUdpToken != 0L && pendingKey != null) {
            val h = peer.peerAddress()
            if (h != null) setRemoteUdp(h, PeerScreen.pendingRemoteUdpPort, PeerScreen.pendingRemoteUdpToken, pendingKey)
        }
        if (uSock != null) {
            udpRxThread = Thread({
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
                val buf = ByteArray(64)
                val dp = DatagramPacket(buf, buf.size)
                while (!uSock.isClosed) { // endAudio closes it
                    try {
                        uSock.receive(dp)
                        if (dp.length >= 8) {
                            val bb = ByteBuffer.wrap(dp.data, dp.offset, dp.length)
                            if (bb.long == token) {
                                remoteUdpAddr = InetSocketAddress(dp.address, dp.port)
                                udpActive = true
                            }
                        }
                    } catch (_: Exception) {
                        break
                    }
                }
            }, "td-peer-aud-udp-rx").apply { isDaemon = true; start() }
        }
        PeerScreen.tellSoundState(peer)

        try {
            r.startRecording()
            capturingAudio = true
            PeerScreen.soundError = ""
            audioThread = Thread({ audioLoop(r, frame) }, "td-peer-aud").apply { start() }
        } catch (e: Exception) {
            Log.w("TwinDesk", "peer audio start: ${e.message}")
            PeerScreen.soundError = e.message ?: "audio start failed"
            endAudio()
        }
    }

    private fun audioLoop(r: AudioRecord, frame: Int) {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
        val pcm = ByteArray(frame * 4) // 3840 bytes = 20ms
        val info = MediaCodec.BufferInfo()
        val out = org.json.JSONArray()
        val enc = audioCodec
        val cName = audioCodecName
        while (capturingAudio) {
            var n = 0
            while (n < pcm.size && capturingAudio) {
                val k = r.read(pcm, n, pcm.size - n)
                if (k <= 0) {
                    if (k < 0) {
                        try { Thread.sleep(20) } catch (_: Exception) {}
                        break
                    }
                    try { Thread.sleep(5) } catch (_: Exception) {}
                    break
                }
                n += k
            }
            if (n < pcm.size) continue

            if (enc == null) {
                out.put(android.util.Base64.encodeToString(pcm, android.util.Base64.NO_WRAP))
            } else {
                val inputIdx = enc.dequeueInputBuffer(10_000)
                if (inputIdx >= 0) {
                    enc.getInputBuffer(inputIdx)!!.apply { clear(); put(pcm) }
                    enc.queueInputBuffer(inputIdx, 0, pcm.size, 0, 0)
                }
                while (true) {
                    val outIdx = enc.dequeueOutputBuffer(info, 0)
                    if (outIdx < 0) break
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
                        val b = ByteArray(info.size)
                        enc.getOutputBuffer(outIdx)!!.apply { position(info.offset); get(b) }
                        val target = remoteUdpAddr
                        val uSock = udpSocket
                        val key = remoteUdpKey
                        if (udpActive && target != null && key != null && uSock != null && !uSock.isClosed) {
                            val pkt = PeerAudioSeal.seal(key, udpToken, udpSalt, udpSeq++, b)
                            runCatching { uSock.send(DatagramPacket(pkt, pkt.size, target)) }
                        } else {
                            out.put(android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP))
                        }
                    }
                    enc.releaseOutputBuffer(outIdx, false)
                }
            }

            if (out.length() > 0) {
                if (peer.connected && peer.queued() < 64 * 1024L) {
                    peer.send(msg(Proto.T.PEER_SOUND, "codec" to cName, "p" to out))
                }
                while (out.length() > 0) out.remove(0)
            }
        }
    }

    private fun endAudio() {
        capturingAudio = false
        udpActive = false
        remoteUdpAddr = null
        remoteUdpKey = null
        runCatching { udpSocket?.close() }
        udpSocket = null
        udpPort = 0
        udpToken = 0L
        runCatching { audioThread?.join(500) }
        audioThread = null
        runCatching { udpRxThread?.join(200) }
        udpRxThread = null
        runCatching { audioRecord?.stop() }
        runCatching { audioRecord?.release() }
        audioRecord = null
        runCatching { audioCodec?.stop() }
        runCatching { audioCodec?.release() }
        audioCodec = null
        if (::peer.isInitialized) PeerScreen.tellSoundState(peer)
    }

    override fun onDestroy() {
        endAudio()
        if (PeerScreen.capture === this) PeerScreen.capture = null
        PeerScreen.standaloneSoundActive = false
        runCatching { dm.unregisterDisplayListener(rotation) }
        stopEncoder()
        runCatching { display?.release() }
        display = null
        runCatching { projection?.stop() }
        projection = null
        if (::peer.isInitialized) {
            if (PeerScreen.screenActive) PeerScreen.captureEnded(peer)
            PeerScreen.tellSoundState(peer)
            peer.core.changed()
        }
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
            if (last != Pair(w, h)) {
                last = Pair(w, h)
                if (PeerScreen.screenActive && codec != null) runCatching { encode() }
            }
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
        val pr = projection ?: return
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
        if (d == null) display = pr.createVirtualDisplay("TwinDesk peer", w, h, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, input, null, null)
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
        val player = if (peer.screenSound && peer.can("sound")) PeerScreen.ensureAudioPlayer() else null // an iPhone has no sound to send
        say(tr("Waiting for {name}… Tap Start there.", "name" to peer.peerName))
        val long = maxOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
        val udpPort = player?.udpPort ?: 0
        val udpToken = player?.udpToken ?: 0L
        peer.ask("screen.start", JSONObject()
            .put("maxSize", long.coerceIn(720, 2400))
            .put("audio", player != null)
            .put("udpPort", udpPort)
            .put("udpToken", udpToken)
            .put("udpKey", player?.udpKeyB64 ?: "")) { r -> if (r.has("error")) say(tr("Couldn’t ask: {error}", "error" to r.optString("error"))) }
        peer.core.changed()
    }

    override fun onDestroy() {
        alive = false
        if (PeerScreen.viewer === this) PeerScreen.viewer = null
        val peer = Core.get(this).peer
        if (!PeerScreen.standaloneSoundActive) PeerScreen.stopAudio()
        call?.cancel()
        runCatching { peer.send(msg("screen.stop")) }
        releaseCodec()
        peer.core.changed()
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

class PeerAudioPlayer {
    private var track: AudioTrack? = null
    private var codec: MediaCodec? = null
    private val queue = LinkedBlockingQueue<Pair<String, ByteArray>>()
    @Volatile private var running = true
    @Volatile private var prebuffering = true
    @Volatile var isPlaying = false; private set
    @Volatile private var lastWriteTime = 0L
    @Volatile private var lastUdpRx = 0L
    private var worker: Thread? = null

    // UDP receiver
    private var udpSocket: DatagramSocket? = null
    val udpPort get() = udpSocket?.localPort ?: 0
    val udpToken = java.util.concurrent.ThreadLocalRandom.current().nextLong()
    private val udpKey = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
    val udpKeyB64: String = android.util.Base64.encodeToString(udpKey, android.util.Base64.NO_WRAP)
    @Volatile private var senderToken = 0L
    private var udpThread: Thread? = null

    companion object {
        private const val RATE = 48000
        private const val CHANNELS = 2
        private const val BYTES_PER_SAMPLE = 2 // 16-bit PCM
        private const val CUSHION_MS = 20 // 1 Opus frame (20ms) cushion for ultra-low latency & smoothness
    }

    init {
        val minBuf = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT)
        val initialBuf = maxOf(minBuf, (RATE * CHANNELS * BYTES_PER_SAMPLE * CUSHION_MS) / 1000)
        val t = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_GAME)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                    .build()
            )
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .setBufferSizeInBytes(initialBuf)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track = t
        if (android.os.Build.VERSION.SDK_INT >= 24) {
            val targetFrames = (RATE * CUSHION_MS) / 1000
            runCatching { t.setBufferSizeInFrames(targetFrames) }
        }

        // Optional Opus decoder in case peer sends Opus
        codec = runCatching {
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, RATE, CHANNELS)
            val csd0 = ByteBuffer.wrap(byteArrayOf(
                0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // 'OpusHead'
                1, 2, 0x38, 0x01, 0x80.toByte(), 0xbb.toByte(), 0, 0, 0, 0, 0
            ))
            val csd1 = ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(6_500_000L).apply { flip() }
            val csd2 = ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(80_000_000L).apply { flip() }
            format.setByteBuffer("csd-0", csd0)
            format.setByteBuffer("csd-1", csd1)
            format.setByteBuffer("csd-2", csd2)
            MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS).apply {
                configure(format, null, null, 0)
                start()
            }
        }.getOrNull()

        val uSock = runCatching { DatagramSocket(0) }.getOrNull()
        udpSocket = uSock
        if (uSock != null) {
            udpThread = Thread({ udpLoop(uSock) }, "td-peer-aud-udp").apply { isDaemon = true; start() }
        }

        worker = Thread({ loop() }, "td-peer-aud-play").apply { start() }
    }

    private fun udpLoop(s: DatagramSocket) {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
        val buf = ByteArray(2048)
        val dp = DatagramPacket(buf, buf.size)
        while (running && !s.isClosed) {
            try {
                s.receive(dp)
                if (dp.length > PeerAudioSeal.HEAD) {
                    val token = ByteBuffer.wrap(dp.data, dp.offset, 8).long
                    val st = senderToken
                    if (st != 0L && token != st) continue
                    val opusData = PeerAudioSeal.open(udpKey, dp.data, dp.offset, dp.length) ?: continue // not sealed with our key
                    lastUdpRx = System.currentTimeMillis()
                    feedUdp(opusData)
                }
            } catch (_: Exception) {
                if (!running) break
            }
        }
    }

    fun connectUdp(remoteHost: String, remotePort: Int, remoteToken: Long) {
        senderToken = remoteToken
        val s = udpSocket ?: return
        if (s.isClosed || remotePort <= 0) return
        Thread({
            runCatching {
                val addr = InetAddress.getByName(remoteHost)
                val ping = ByteBuffer.allocate(8).putLong(remoteToken).array()
                s.send(DatagramPacket(ping, ping.size, addr, remotePort))
            }
        }, "td-peer-aud-ping").start()
    }

    fun feedUdp(data: ByteArray) {
        if (!running) return
        while (queue.size > 2) {
            queue.poll()
        }
        queue.offer(Pair("opus", data))
    }

    fun feed(m: JSONObject) {
        if (!running) return
        if (System.currentTimeMillis() - lastUdpRx < 1500) return
        val codecType = m.optString("codec", "pcm")
        val p = m.optJSONArray("p") ?: return

        // Drop oldest frames if queue exceeds target cushion (+1 frame leeway)
        val maxFrames = 2
        while (queue.size > maxFrames) {
            queue.poll()
        }

        for (i in 0 until p.length()) {
            val b64 = p.optString(i)
            if (b64.isEmpty()) continue
            val b = runCatching { android.util.Base64.decode(b64, android.util.Base64.NO_WRAP) }.getOrNull() ?: continue
            queue.offer(Pair(codecType, b))
        }
    }

    private fun loop() {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
        var bufferedBytes = 0
        var ptsUs = 0L
        val info = MediaCodec.BufferInfo()
        val pcmOut = ByteArray(RATE * 4)

        while (running) {
            val item = try { queue.poll(100, TimeUnit.MILLISECONDS) } catch (e: Exception) { break }
            if (item == null) {
                // If queue ran completely dry for > 150ms, mark as prebuffering again for next burst
                if (queue.isEmpty() && System.currentTimeMillis() - lastWriteTime > 150) {
                    prebuffering = true
                    bufferedBytes = 0
                    isPlaying = false
                }
                continue
            }
            val (cType, data) = item
            val t = track ?: continue

            val pcmBytes: ByteArray? = if (cType == "pcm" || codec == null) {
                data
            } else {
                decodeOpus(data, ptsUs, info, pcmOut).also { ptsUs += 20000L }
            }

            if (pcmBytes != null && pcmBytes.isNotEmpty()) {
                t.write(pcmBytes, 0, pcmBytes.size)
                lastWriteTime = System.currentTimeMillis()
                val prebufferTarget = (RATE * CHANNELS * BYTES_PER_SAMPLE * CUSHION_MS) / 1000
                if (prebuffering) {
                    bufferedBytes += pcmBytes.size
                    if (bufferedBytes >= prebufferTarget) {
                        runCatching { t.play() }
                        prebuffering = false
                        isPlaying = true
                    }
                } else {
                    if (t.playState != AudioTrack.PLAYSTATE_PLAYING) {
                        runCatching { t.play() }
                    }
                    isPlaying = true
                }
            }
        }
    }

    private fun decodeOpus(data: ByteArray, pts: Long, info: MediaCodec.BufferInfo, pcmOut: ByteArray): ByteArray? {
        val c = codec ?: return null
        return try {
            val inputIdx = c.dequeueInputBuffer(10_000)
            if (inputIdx >= 0) {
                val inBuf = c.getInputBuffer(inputIdx)
                if (inBuf != null) {
                    inBuf.clear()
                    inBuf.put(data)
                    c.queueInputBuffer(inputIdx, 0, data.size, pts, 0)
                }
            }
            var result: ByteArray? = null
            while (running) {
                val outIdx = c.dequeueOutputBuffer(info, 0)
                if (outIdx < 0) {
                    if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED || outIdx == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED) continue
                    break
                }
                if (info.size > 0) {
                    val outBuf = c.getOutputBuffer(outIdx)
                    if (outBuf != null) {
                        val len = minOf(info.size, pcmOut.size)
                        outBuf.position(info.offset)
                        outBuf.get(pcmOut, 0, len)
                        result = pcmOut.copyOf(len)
                    }
                }
                c.releaseOutputBuffer(outIdx, false)
                if (result != null) break
            }
            result
        } catch (e: Exception) {
            Log.w("TwinDesk", "opus decode: ${e.message}")
            null
        }
    }

    fun release() {
        running = false
        isPlaying = false
        queue.clear()
        runCatching { udpSocket?.close() }
        udpSocket = null
        runCatching { udpThread?.join(200) }
        udpThread = null
        runCatching { worker?.join(300) }
        worker = null
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        codec = null
        runCatching { track?.stop() }
        runCatching { track?.release() }
        track = null
    }
}

// The UDP lane's packets: token (8) | salt (4) | sequence (4) | AES-GCM of the Opus frame, the header as
// associated data. The key is the listener's, sent over the phones' TLS link, so only it can play them
// and nobody else on the Wi-Fi can feed it.
object PeerAudioSeal {
    const val HEAD = 16
    private fun nonce(salt: Int, seq: Int) = ByteBuffer.allocate(12).putInt(salt).putInt(seq).putInt(0).array()

    fun seal(key: ByteArray, token: Long, salt: Int, seq: Int, frame: ByteArray): ByteArray {
        val head = ByteBuffer.allocate(HEAD).putLong(token).putInt(salt).putInt(seq).array()
        val c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        c.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(key, "AES"), javax.crypto.spec.GCMParameterSpec(128, nonce(salt, seq)))
        c.updateAAD(head)
        return head + c.doFinal(frame)
    }

    fun open(key: ByteArray, buf: ByteArray, off: Int, len: Int): ByteArray? = runCatching {
        val bb = ByteBuffer.wrap(buf, off + 8, 8)
        val salt = bb.int
        val seq = bb.int
        val c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        c.init(javax.crypto.Cipher.DECRYPT_MODE, javax.crypto.spec.SecretKeySpec(key, "AES"), javax.crypto.spec.GCMParameterSpec(128, nonce(salt, seq)))
        c.updateAAD(buf, off, HEAD)
        c.doFinal(buf, off + HEAD, len - HEAD)
    }.getOrNull()
}
