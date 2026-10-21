// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's side of the session: a WSS client with the computer's certificate pinned, pairing as
// the initiator (numeric comparison), hello, liveness. Like windows/link.js and mac/link.js, except
// that a phone connects only when asked (or to resume a session that dropped by accident).
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

private const val FALLBACK_MS = 5000L // on the network this long, answering: its Bluetooth fallback goes (dropAlt)
private const val ANSWERING_MS = 3000L // … answering = something came through it this recently

data class PairState(
    val phase: String, // connecting | starting | code | waiting | failed
    val address: String,
    val port: Int,
    val name: String,
    val code: String = "",
    val error: String = "",
    val wired: Boolean = false, // through the USB cable: no code to compare, only Allow on the computer
    val ble: Boolean = false, // through Bluetooth: the address is the pipe's, not the computer's
)

class Link(
    private val store: Store,
    private val events: Events,
) {
    // The one the link belongs to is passed on (one Link per computer, LinkManager.kt).
    interface Events {
        fun onChange()
        fun onWelcome(link: Link, host: Host)
        fun onMessage(link: Link, m: JSONObject)
        fun onClosed(link: Link, host: Host, code: String?)
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
    // Through Bluetooth (Ble.kt): the computer's port reached through a pipe on 127.0.0.1. After a
    // resume onto the network (Core), false again, with the Bluetooth socket kept as the fallback.
    @Volatile var ble = false; private set
    val connected get() = state == "connected"
    // The computer answered hello with mesh: 1, so it takes the pool and the roster (docs/mesh.md).
    @Volatile var mesh = false; private set
    // Selected or driving: the keep-alive is the quick kind (Core sets it).
    @Volatile var busy = false
    val hostId: String get() = host?.id ?: ""

    private val exec = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "td-link").apply { isDaemon = true } }
    private var ws: WebSocket? = null
    private var mode = "" // session | pair
    private var nw = ""
    private var pairNonce = "" // pairing through the cable: the nonce the computer sent us over adb
    private var seenFp = ""
    private var lastRx = 0L
    private var lastCode: String? = null
    private var pinger: ScheduledFuture<*>? = null
    // Resume (hello {resume}): the session's other socket, and one being opened.
    private var resumeKey = ""
    private var alt: WebSocket? = null
    private var altBle = false
    private var movedAt = 0L // when the session moved onto the network (dropAlt)
    private var pending: WebSocket? = null
    private var pendingAddress = ""
    private val lastRxOf = java.util.concurrent.ConcurrentHashMap<WebSocket, Long>()
    private var helloTimer: ScheduledFuture<*>? = null
    var bleRx: () -> Long = { 0L } // Ble.lastDown: bytes arriving through Bluetooth count as alive

    private fun run(block: () -> Unit) = exec.execute { try { block() } catch (e: Exception) { Log.e("TwinDesk", "link", e) } }

    // usbPort: connect through the cable (adb reverse) instead of the network; the host's own
    // address stays as it is, for when the cable comes out.
    // blePort: through a Bluetooth pipe on 127.0.0.1 instead.
    fun connect(h: Host, usbPort: Int = 0, blePort: Int = 0) = run {
        val viaUsb = usbPort > 0
        val viaBle = blePort > 0
        if (ws != null && host?.id == h.id && wired == viaUsb && ble == viaBle && (state == "connecting" || state == "connected")) return@run
        closeSocket()
        pair = null
        host = h
        wired = viaUsb
        ble = viaBle
        when {
            viaUsb -> open("session", "127.0.0.1", usbPort, h.fp)
            viaBle -> open("session", "127.0.0.1", blePort, h.fp)
            else -> open("session", h.address, h.port, h.fp)
        }
        setState("connecting", "")
    }

    // The session is through Bluetooth and the computer is on the network now (the same one, or a
    // Wi-Fi Direct group / hotspot just made for it): move it there without ending it.
    fun resume(address: String, port: Int) = run {
        val h = host ?: return@run
        if (state != "connected" || !ble || resumeKey.isEmpty() || pending != null) return@run
        pendingAddress = address
        pending = socket("wss://$address:$port", h.fp)
    }

    val resuming get() = pending != null

    fun disconnect() = run {
        if (state == "connected") raw(msg(Proto.T.BYE))
        closeSocket()
        setState("idle", "")
    }

    // nonce: through the USB cable (WiredReceiver): pair.start carries it, which tells the computer
    // the request is from the phone on its cable, and the code is confirmed here without asking
    // (only the computer the phone allowed USB debugging for could have sent the nonce).
    fun startPairing(address: String, port: Int, name: String, nonce: String = "", viaBle: Boolean = false) = run {
        closeSocket()
        host = null
        wired = false
        ble = viaBle
        pairNonce = nonce
        pair = PairState("connecting", address, port, name, wired = nonce.isNotEmpty(), ble = viaBle)
        open("pair", address, port, null)
        events.onChange()
    }

    // Pairing through Bluetooth: shown at once while the pipe opens (Core.pair), then startPairing,
    // or failed with why.
    fun pairOpening(name: String) {
        pair = PairState("connecting", "", 0, name, ble = true)
        events.onChange()
    }

    fun pairUnreachable(error: String) = run { pairFailed(error) }

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
        ws = socket("wss://$address:$port", pinFp)
    }

    // Self-signed certificates: the fingerprint is the identity (pinned once paired).
    private fun socket(url: String, pinFp: String?): WebSocket {
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
        return client.newWebSocket(Request.Builder().url(url).build(), Listener())
    }

    // ---- the resume socket and the fallback ----

    private fun gone(w: WebSocket, failure: String?) {
        lastRxOf.remove(w)
        when {
            w === pending -> pending = null
            w === alt -> { alt = null; events.onChange() }
            w === ws -> if (!(state == "connected" && fallBack())) onClose(failure)
        }
    }

    private fun onPendingOpen(w: WebSocket) {
        val h = host ?: return
        lastRxOf[w] = System.currentTimeMillis()
        w.send(msg(Proto.T.HELLO, "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName, "os" to Proto.OS, "token" to h.token, "resume" to resumeKey).toString())
        exec.schedule({ if (pending === w) { pending = null; w.cancel() } }, Proto.TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    // welcome {resumed}: the computer sends on the new socket from now on; so do we.
    private fun promote(w: WebSocket) {
        pending = null
        alt?.cancel()
        alt = ws
        altBle = ble
        ws = w
        ble = false
        movedAt = System.currentTimeMillis()
        host?.let { h ->
            if (h.address != pendingAddress) { h.address = pendingAddress; store.putHost(h) }
        }
        Log.i("TwinDesk", "session moved to $pendingAddress")
        events.onChange()
    }

    // On the same Wi-Fi as the computer (Core.bleTick): the Bluetooth fallback goes once this path
    // has proven itself (on it FALLBACK_MS, answering). The Wi-Fi dropping then ends the session,
    // which comes back over Bluetooth (Core.resume).
    fun dropAlt() = run {
        val a = alt ?: return@run
        val w = ws ?: return@run
        val now = System.currentTimeMillis()
        if (ble || !altBle || now - movedAt < FALLBACK_MS || now - (lastRxOf[w] ?: 0L) > ANSWERING_MS) return@run
        alt = null
        lastRxOf.remove(a)
        a.close(1000, null)
        Log.i("TwinDesk", "Bluetooth fallback closed: the session stays on Wi-Fi")
        events.onChange()
    }

    // The session's socket closed: carry on through the other one if it's still there.
    private fun fallBack(): Boolean {
        val a = alt ?: return false
        alt = null
        ws = a
        ble = altBle
        Log.i("TwinDesk", "session back on ${if (ble) "Bluetooth" else "the network"}")
        events.onChange()
        return true
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = run {
            if (webSocket === ws) onOpen() else if (webSocket === pending) onPendingOpen(webSocket)
        }
        override fun onMessage(webSocket: WebSocket, text: String) = run {
            lastRxOf[webSocket] = System.currentTimeMillis()
            if (webSocket === pending) {
                val m = runCatching { JSONObject(text) }.getOrNull()
                if (m?.optString("t") == Proto.T.WELCOME && m.optBoolean("resumed")) promote(webSocket)
                else { pending = null; webSocket.cancel() }
            } else if (webSocket === ws || webSocket === alt) onText(text)
        }
        // The computer closed it (Disconnect, Forget…): answer at once. OkHttp waits for us to,
        // and until then neither side saw the session end.
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = run {
            webSocket.close(1000, null)
            gone(webSocket, null)
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = run { gone(webSocket, null) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = run {
            if (webSocket !== ws) return@run gone(webSocket, t.message)
            lastRxOf.remove(webSocket)
            if (state == "connected" && fallBack()) return@run
            onClose(if (generateSequence(t) { it.cause }.any { it is CertificateException }) "identity" else t.message ?: "failed")
        }
    }

    private fun onOpen() {
        lastRx = System.currentTimeMillis()
        if (mode == "pair") {
            nw = Proto.randomHex(16)
            val start = msg(Proto.T.PAIR_START, "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName, "os" to Proto.OS, "commit" to Proto.commitOf(nw))
            if (pairNonce.isNotEmpty()) start.put("wired", pairNonce)
            raw(start)
            pair = pair?.copy(phase = "starting")
            events.onChange()
            return
        }
        hello()
    }

    private fun hello() {
        val h = host ?: return
        raw(msg(Proto.T.HELLO, "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName, "os" to Proto.OS, "token" to h.token))
        helloTimer?.cancel(false)
        helloTimer = exec.schedule({ if (state != "connected") { message = "No answer"; ws?.cancel() } }, if (ble) Proto.BLE_TIMEOUT_MS else Proto.TIMEOUT_MS, TimeUnit.MILLISECONDS)
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
        if (p.wired) {
            raw(msg(Proto.T.PAIR_CONFIRM))
            pair = pair?.copy(phase = "waiting")
        }
        events.onChange()
    }

    private fun onPairOk(m: JSONObject) {
        val p = pair ?: return
        if (mode != "pair" || p.phase != "waiting") return
        val token = m.optString("token")
        val id = m.optString("macId")
        if (token.isEmpty() || id.isEmpty()) return pairFailed("The computer sent a bad pairing message.")
        // Through the cable the address is this phone's own end of adb reverse: the computer's
        // network address comes from discovery when it's seen (Core.connect), else the cable again.
        // Through Bluetooth likewise: no network address yet (Core keeps the pipe for it).
        val h = if (p.wired || p.ble) Host(id, m.optString("macName").take(64).ifEmpty { p.name }, m.optString("os", "mac"), "127.0.0.1", Proto.PORT, seenFp, token, System.currentTimeMillis())
            else Host(id, m.optString("macName").take(64).ifEmpty { p.name }, m.optString("os", "mac"), p.address, p.port, seenFp, token, System.currentTimeMillis())
        store.putHost(h)
        pair = null
        mode = "session"
        host = h
        wired = p.wired
        ble = p.ble
        setState("connecting", "")
        events.onPaired(this, h) // the session with this computer starts on a link of its own (Core.onPaired)
        hello()
    }

    private fun onWelcome(m: JSONObject) {
        mesh = m.optInt("mesh", 0) == 1
        if (mode != "session" || state == "connected") return
        helloTimer?.cancel(false)
        val h = host ?: return
        m.optString("macName").takeIf { it.isNotEmpty() }?.let { h.name = it.take(64) }
        h.lastSeen = System.currentTimeMillis()
        store.putHost(h)
        rttMs = null
        resumeKey = m.optString("resume")
        ws?.let { lastRxOf[it] = System.currentTimeMillis() }
        // Each of the session's sockets on its own: a quiet fallback goes, the session lives on.
        pinger = exec.scheduleWithFixedDelay({
            val now = System.currentTimeMillis()
            for (w in listOfNotNull(ws, alt)) {
                val onBle = if (w === ws) ble else altBle
                val limit = if (onBle) Proto.BLE_TIMEOUT_MS else Proto.TIMEOUT_MS
                val rx = maxOf(lastRxOf[w] ?: lastRx, if (onBle) bleRx() else 0L)
                if (now - rx > limit) {
                    Log.i("TwinDesk", "${if (onBle) "Bluetooth" else "network"} socket silent for ${now - rx} ms, closing")
                    if (w === ws && alt == null) message = "Stopped answering"
                    w.cancel()
                } else w.send(msg(Proto.T.PING, "ts" to now).toString())
            }
        }, Proto.PING_MS, Proto.PING_MS, TimeUnit.MILLISECONDS)
        setState("connected", "")
        events.onWelcome(this, h)
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
            Proto.E.REPLACED -> m.optString("message").ifEmpty { "Another device connected" }
            Proto.E.RELEASED -> "Disconnected from ${host?.name ?: "the computer"}"
            Proto.E.ASLEEP -> "${host?.name ?: "The computer"} is asleep"
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

    private fun dropOthers() {
        resumeKey = ""
        alt?.cancel()
        alt = null
        pending?.cancel()
        pending = null
        lastRxOf.clear()
    }

    private fun onClose(failure: String?) {
        Log.i("TwinDesk", "link closed: mode=$mode state=$state ble=$ble failure=$failure code=$lastCode")
        pinger?.cancel(false)
        helloTimer?.cancel(false)
        ws = null
        dropOthers()
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
        dropOthers()
        val wasConnected = state == "connected"
        if (wasConnected) state = "idle"
        w?.close(1000, null)
        if (wasConnected) host?.let { events.onClosed(this, it, "local") }
    }

    private fun raw(m: JSONObject) {
        ws?.send(m.toString())
    }

    private fun setState(s: String, msg: String) {
        state = s
        message = msg
        events.onChange()
    }
}
