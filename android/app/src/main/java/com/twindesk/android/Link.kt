// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One session with one computer: a WSS client with that computer's certificate pinned, hello, liveness.
// The phone has one Link per paired computer (LinkManager); pairing uses a Link of its own until
// the pairing succeeds, then the new computer gets a session Link (Core.onPaired). Like windows/link.js
// and mac/link.js. A Link dials; the phone never listens.
package com.twindesk.android

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

data class PairState(
    val phase: String, // connecting | starting | code | waiting | failed
    val address: String,
    val port: Int,
    val name: String,
    val code: String = "",
    val error: String = "",
)

class Link(
    private val store: Store,
    private val events: Events,
) {
    interface Events {
        fun onChange()
        fun onWelcome(link: Link, host: Host)
        fun onMessage(link: Link, m: JSONObject)
        fun onClosed(link: Link, host: Host, code: String?)
        // A pairing succeeded: the pairing link is done and the computer is paired (see Core.onPaired).
        fun onPaired(link: Link, host: Host)
    }

    // idle | connecting | connected | failed
    @Volatile var state = "idle"; private set
    @Volatile var message = ""; private set
    @Volatile var pair: PairState? = null; private set
    @Volatile var host: Host? = null; private set
    @Volatile var rttMs: Long? = null; private set
    // On a USB cable: the computer's port reached through adb reverse on this device's 127.0.0.1.
    @Volatile var wired = false; private set
    // The computer answered hello with mesh: 1, so it takes the pool and the roster (docs/mesh.md).
    @Volatile var mesh = false; private set
    // Selected or driving: keep-alive is the quick kind (Mesh.kt keepalive). Set by Core.
    @Volatile var busy = false
    val connected get() = state == "connected"
    // The id of the computer this link is for ("" before any host).
    val hostId: String get() = host?.id ?: ""

    private val exec = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "td-link").apply { isDaemon = true } }
    private var ws: WebSocket? = null
    private var mode = "" // session | pair
    private var nw = ""
    private var seenFp = ""
    @Volatile private var lastRx = 0L
    @Volatile private var lastTx = 0L
    private var lastCode: String? = null
    private var pinger: ScheduledFuture<*>? = null
    private var helloTimer: ScheduledFuture<*>? = null

    private fun run(block: () -> Unit) = exec.execute { try { block() } catch (e: Exception) { Log.e("TwinDesk", "link", e) } }

    // usbPort: connect through the cable (adb reverse) instead of the network; the host's own
    // address stays as it is, for when the cable comes out.
    fun connect(h: Host, usbPort: Int = 0) = run {
        val viaUsb = usbPort > 0
        if (ws != null && host?.id == h.id && wired == viaUsb && (state == "connecting" || state == "connected")) return@run
        closeSocket()
        pair = null
        host = h
        wired = viaUsb
        if (viaUsb) open("session", "127.0.0.1", usbPort, h.fp) else open("session", h.address, h.port, h.fp)
        setState("connecting", "")
    }

    fun disconnect() = run {
        closeSocket()
        setState("idle", "")
    }

    fun startPairing(address: String, port: Int, name: String) = run {
        closeSocket()
        host = null
        pair = PairState("connecting", address, port, name)
        open("pair", address, port, null)
        events.onChange()
    }

    fun confirmCode() = run {
        val p = pair ?: return@run
        if (p.phase != "code" || mode != "pair") return@run
        raw(msg(Proto.T.PAIR_CONFIRM))
        pair = p.copy(phase = "waiting")
        events.onChange()
    }

    fun cancelPairing() = run {
        val p = pair ?: return@run
        if (mode == "pair" && p.phase != "failed") raw(msg(Proto.T.PAIR_CANCEL))
        pair = null
        if (mode == "pair") closeSocket()
        events.onChange()
    }

    fun send(m: JSONObject): Boolean {
        val w = ws ?: return false
        if (state != "connected") return false
        lastTx = System.currentTimeMillis()
        return w.send(m.toString())
    }

    // Bytes queued on the socket (file sending waits while it is high).
    fun queued(): Long = ws?.queueSize() ?: 0

    // ---- socket ----

    private fun open(m: String, address: String, port: Int, pinFp: String?) {
        mode = m
        nw = ""
        seenFp = ""
        lastCode = null
        // Self-signed certificates: the fingerprint is the identity (pinned once paired).
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String?) {
                val fp = Proto.sha256(chain[0].encoded).hex()
                seenFp = fp
                if (pinFp != null && fp != pinFp) throw CertificateException("identity changed")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        val client = OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, trust)
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        val req = Request.Builder().url("wss://$address:$port").build()
        ws = client.newWebSocket(req, Listener())
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = run { if (webSocket === ws) onOpen() }
        override fun onMessage(webSocket: WebSocket, text: String) = run { if (webSocket === ws) onText(text) }
        // The computer closed it (Disconnect, Forget…): answer at once. OkHttp waits for us to,
        // and until then neither side saw the session end.
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = run {
            webSocket.close(1000, null)
            if (webSocket === ws) onClose(null)
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = run { if (webSocket === ws) onClose(null) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = run {
            if (webSocket !== ws) return@run
            onClose(if (generateSequence(t) { it.cause }.any { it is CertificateException }) "identity" else t.message ?: "failed")
        }
    }

    private fun onOpen() {
        lastRx = System.currentTimeMillis()
        if (mode == "pair") {
            nw = Proto.randomHex(16)
            raw(msg(Proto.T.PAIR_START, "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName, "os" to Proto.OS, "commit" to Proto.commitOf(nw)))
            pair = pair?.copy(phase = "starting")
            events.onChange()
            return
        }
        hello()
    }

    private fun hello() {
        val h = host ?: return
        raw(msg(Proto.T.HELLO, "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName, "os" to Proto.OS, "token" to h.token, "mesh" to 1))
        helloTimer?.cancel(false)
        helloTimer = exec.schedule({ if (state != "connected") { message = "No answer"; ws?.cancel() } }, Proto.TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    private fun onText(text: String) {
        val m = runCatching { JSONObject(text) }.getOrNull() ?: return
        val t = m.optString("t")
        lastRx = System.currentTimeMillis()
        when (t) {
            Proto.T.PAIR_NONCE -> return onNonce(m)
            Proto.T.PAIR_OK -> return onPairOk(m)
            Proto.T.PAIR_CANCEL -> return pairFailed("Pairing was cancelled on the computer.")
            Proto.T.WELCOME -> return onWelcome(m)
            Proto.T.ERROR -> return onError(m)
            Proto.T.PING -> { if (state == "connected") raw(msg(Proto.T.PONG, "ts" to m.opt("ts"))); return }
            Proto.T.PONG -> { if (m.has("ts")) rttMs = maxOf(0, System.currentTimeMillis() - m.optLong("ts")); return }
        }
        if (state == "connected") events.onMessage(this, m)
    }

    private fun onNonce(m: JSONObject) {
        val p = pair ?: return
        val nonce = m.optString("nonce")
        if (mode != "pair" || nw.isEmpty() || !Regex("^[0-9a-f]{32,128}$").matches(nonce) || nonce.length % 2 != 0) {
            return pairFailed("The computer sent a bad pairing message.")
        }
        raw(msg(Proto.T.PAIR_REVEAL, "nonce" to nw))
        pair = p.copy(phase = "code", code = Proto.sasCode(seenFp, nw, nonce))
        events.onChange()
    }

    private fun onPairOk(m: JSONObject) {
        val p = pair ?: return
        if (mode != "pair" || p.phase != "waiting") return
        val token = m.optString("token")
        val id = m.optString("macId")
        if (token.isEmpty() || id.isEmpty()) return pairFailed("The computer sent a bad pairing message.")
        if (store.hosts().none { it.id == id } && store.hosts().size >= Proto.MAX_DEVICES) {
            return pairFailed("This phone already has ${Proto.MAX_DEVICES} computers paired.")
        }
        val h = Host(id, m.optString("macName").take(64).ifEmpty { p.name }, m.optString("os", "mac"), p.address, p.port, seenFp, token, System.currentTimeMillis())
        store.putHost(h)
        pair = null
        // The session with this computer starts on a link of its own (Core.onPaired).
        events.onPaired(this, h)
    }

    private fun onWelcome(m: JSONObject) {
        if (mode != "session" || state == "connected") return
        helloTimer?.cancel(false)
        val h = host ?: return
        m.optString("macName").takeIf { it.isNotEmpty() }?.let { h.name = it.take(64) }
        h.lastSeen = System.currentTimeMillis()
        store.putHost(h)
        rttMs = null
        mesh = m.optInt("mesh", 0) == 1
        lastTx = System.currentTimeMillis()
        pinger?.cancel(false)
        // Liveness, checked every quarter second: a ping only when nothing went out for the interval
        // (Mesh.kt keepalive: busy links often, the others rarely).
        pinger = exec.scheduleWithFixedDelay({ keepAliveTick() }, 250, 250, TimeUnit.MILLISECONDS)
        setState("connected", "")
        events.onWelcome(this, h)
    }

    private fun keepAliveTick() {
        val now = System.currentTimeMillis()
        val k = keepalive(busy)
        if (now - lastRx > k.timeoutMs) {
            message = "Stopped answering"
            ws?.cancel()
        } else if (now - lastTx >= k.intervalMs) {
            raw(msg(Proto.T.PING, "ts" to now))
        }
    }

    private val pairErrors = mapOf(
        Proto.E.PAIR_REFUSED to "Pairing was refused.",
        Proto.E.PAIR_TIMEOUT to "Pairing timed out.",
        Proto.E.BUSY to "That computer is busy pairing with another device.",
        Proto.E.VERSION_MISMATCH to "That computer runs a different TwinDesk version. Update both.",
    )

    private fun onError(m: JSONObject) {
        val code = m.optString("code")
        lastCode = code
        if (mode == "pair") return pairFailed(pairErrors[code] ?: "Pairing failed ($code).")
        message = when (code) {
            Proto.E.BAD_TOKEN -> "${host?.name ?: "The computer"} forgot this phone. Pair again."
            Proto.E.BUSY -> m.optString("message").ifEmpty { "Busy with another device" }
            Proto.E.REPLACED -> "Another phone connected"
            Proto.E.RELEASED -> "Disconnected from ${host?.name ?: "the computer"}"
            else -> "Closed ($code)"
        }
        if (code == Proto.E.BAD_TOKEN) host?.let { store.forgetHost(it.id) }
    }

    private fun pairFailed(error: String) {
        val p = pair ?: return
        pair = p.copy(phase = "failed", error = error, code = "")
        closeSocket()
        events.onChange()
    }

    private fun onClose(failure: String?) {
        pinger?.cancel(false)
        helloTimer?.cancel(false)
        ws = null
        if (mode == "pair") {
            val p = pair
            if (p != null && p.phase != "failed") {
                pairFailed(if (p.phase == "connecting") "Couldn’t connect to ${p.address}${failure?.let { " ($it)" } ?: ""}." else "The connection closed.")
            }
            return
        }
        val was = state
        if (failure == "identity") {
            setState("failed", "${host?.name ?: "The computer"} looks different now. Forget it and pair again.")
        } else {
            if (message.isEmpty() && failure != null) message = failure
            setState(if (was == "connected" || was == "connecting") "idle" else was, message)
        }
        host?.let { events.onClosed(this, it, lastCode) }
    }

    private fun closeSocket() {
        pinger?.cancel(false)
        helloTimer?.cancel(false)
        val w = ws
        ws = null
        val wasConnected = state == "connected"
        if (wasConnected) state = "idle"
        w?.close(1000, null)
        if (wasConnected) host?.let { events.onClosed(this, it, "local") }
    }

    private fun raw(m: JSONObject) {
        lastTx = System.currentTimeMillis()
        ws?.send(m.toString())
    }

    private fun setState(s: String, msg: String) {
        state = s
        message = msg
        events.onChange()
    }
}
