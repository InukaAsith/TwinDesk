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
// Quiet links (shared/quiet.js): the same numbers as the computers'.
private const val QUIET_IDLE = "idle"
private const val QUIET_ACTIVE_MS = 15000L
private const val QUIET_PING_MS = 5 * 60 * 1000L
private const val QUIET_TIMEOUT_MS = 11 * 60 * 1000L

data class PairState(
    val phase: String, // connecting | starting | code | waiting | failed
    val address: String,
    val port: Int,
    val name: String,
    val code: String = "",
    val error: String = "",
    val wired: Boolean = false, // through the USB cable: no code to compare, only Allow on the computer
    val ble: Boolean = false, // through Bluetooth: the address is the pipe's, not the computer's
    val qr: Boolean = false, // the computer's QR code, on the network: no code to compare either
)

class Link(
    private val store: Store,
    private val events: Events,
    // Where paired hosts are kept: the computers ("hosts"), or another phone (Peer.kt: "peerHosts").
    private val hostsKey: String = "hosts",
) {
    interface Events {
        fun onChange()
        fun onWelcome(host: Host)
        fun onMessage(m: JSONObject)
        fun onClosed(host: Host, code: String?)
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

    // Quiet links (shared/quiet.js, #143): while nothing is live here and the computer says the same
    // (`idle {on}`), the session stops pinging every second and the radio and CPU can sleep: one ping
    // every QUIET_PING_MS, closed after QUIET_TIMEOUT_MS of silence. A message sent while quiet is
    // followed by one ping (a probe): no answer within TIMEOUT_MS and the socket closes (and the
    // session comes back). Messages don't end the quiet; busyHere (Core: something live here), the
    // computer saying busy or wake() do. A computer that never says idle (an older app) keeps today's
    // pings. Not through Bluetooth.
    @Volatile var busyHere: () -> Boolean = { false }
    @Volatile var keepPinging = false
    @Volatile private var peerIdle = false
    @Volatile private var saidIdle = false
    @Volatile private var lastUse = 0L // the session's start: active for QUIET_ACTIVE_MS
    @Volatile private var probeAt = 0L
    private var probed = false
    @Volatile private var wokeAt = 0L
    @Volatile private var quietSince = 0L
    private var quietEnd = 0L
    private var quietPing = 0L
    val quiet: Boolean get() = quietSince != 0L

    // The screen came on, the network changed, the app opened: active again for a while, so a session
    // that died in the quiet is found within TIMEOUT_MS. Also when a hold starts or ends (Core.changed).
    fun wake() { wokeAt = System.currentTimeMillis(); if (pinger != null) runCatching { exec.execute { beat() } } }
    // Only says this side's idle state if it changed (no pings: Core.changed() calls this often).
    fun nudge() { if (pinger != null) runCatching { exec.execute { if (state == "connected") sayIdle(System.currentTimeMillis()) } } }

    private fun idleHere(now: Long) = !keepPinging && !runCatching { busyHere() }.getOrDefault(true) && now - maxOf(lastUse, wokeAt) >= QUIET_ACTIVE_MS

    private fun sayIdle(now: Long): Boolean {
        val mine = idleHere(now)
        if (mine != saidIdle) { ws?.let { w -> if (!ble && w.send(msg(QUIET_IDLE, "on" to mine).toString())) saidIdle = mine } }
        return mine
    }
    var bleRx: () -> Long = { 0L } // Ble.lastDown: bytes arriving through Bluetooth count as alive
    // Fast files (Proto.FX_PATH): the session's token from welcome {fx}; none from a computer that can't.
    @Volatile private var fxToken = ""
    // … and welcome {fxPlain: {port, token}}: the computer allows unencrypted file transfers (its
    // Files › Encrypt file transfers off). We always allow them (hello {fxPlain: 1}): the computer decides.
    @Volatile private var fxPlain: Fx.Plain? = null
    // … and fast files v2 (the computers' shared/fx2.js, Fx2.kt): welcome {fx2: {port}}, the port of
    // the computer's files engine (0: none, an older computer).
    @Volatile private var fx2Port = 0
    private var fxClient: Pair<String, OkHttpClient>? = null // (pinned fingerprint, client), kept for its connections

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
    // qr: the nonce came in the computer's QR code instead: the same, over the network.
    fun startPairing(address: String, port: Int, name: String, nonce: String = "", viaBle: Boolean = false, qr: Boolean = false) = run {
        closeSocket()
        host = null
        wired = false
        ble = viaBle
        pairNonce = nonce
        pair = PairState("connecting", address, port, name, wired = nonce.isNotEmpty() && !qr, ble = viaBle, qr = qr)
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
        if (quietSince != 0L && probeAt == 0L) probeAt = System.currentTimeMillis()
        return w.send(m.toString())
    }

    // send() for the pointer's hot path (WebHost's TD.move): the line written into one builder, made
    // once. Never held for Wi-Fi (Netlink.holdOut holds only files). kind: 0 remote.mm, 1 remote.wh,
    // 2 in.mm (WebHost).
    private val hot = StringBuilder(96)
    fun sendMove(kind: Int, a: Double, b: Double, smooth: Boolean): Boolean {
        val w = ws ?: return false
        if (state != "connected" || !a.isFinite() || !b.isFinite()) return false
        val line = synchronized(hot) {
            val s = hot
            s.setLength(0)
            when (kind) {
                0 -> num(num(s.append("{\"t\":\"remote.mm\",\"dx\":"), a).append(",\"dy\":"), b).append(",\"smooth\":").append(smooth)
                1 -> num(num(s.append("{\"t\":\"remote.wh\",\"dx\":"), a).append(",\"dy\":"), b)
                2 -> num(num(s.append("{\"t\":\"in.mm\",\"x\":"), a).append(",\"y\":"), b)
                else -> return false
            }
            s.append('}').toString()
        }
        return w.send(line)
    }

    // A JSON number: a whole one without ".0" (as the page's JSON.stringify writes it).
    private fun num(s: StringBuilder, v: Double): StringBuilder {
        val l = v.toLong()
        return if (l.toDouble() == v && l > -1_000_000_000_000L && l < 1_000_000_000_000L) s.append(l) else s.append(v)
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

    // Where each socket goes ("address", port), for the session's other HTTPS calls (Mirror.kt).
    private val endOf = java.util.concurrent.ConcurrentHashMap<WebSocket, Pair<String, Int>>()

    // The session's socket now: its address and port (127.0.0.1 through the cable or Bluetooth).
    fun endpoint(): Pair<String, Int>? = ws?.let { endOf[it] }

    // An HTTPS client for the session's computer, its certificate pinned as the session's is.
    fun https(): OkHttpClient? {
        val fp = host?.fp ?: return null
        return client(fp).newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).writeTimeout(0, TimeUnit.MILLISECONDS).build()
    }

    // Fast files for the next file: the computer gave a token, and the session is on the network, a
    // cable or a Wi-Fi Direct group / hotspot (as the computers' fastfile.js usable()). Else the bytes
    // go as file.chunk. plain: unencrypted (FxHttp) to `address` on that port, with its own token;
    // null: HTTPS (client). fx2Port: the computer's files engine (fx2, Fx2.kt), 0 when there's none
    // (an older computer, or through the cable: adb reverse carries only the session's port);
    // plain.fx2Port: its plain server.
    class Fx(val base: String, val token: String, val client: OkHttpClient, val address: String, val plain: Plain?, val fx2Port: Int = 0) {
        class Plain(val port: Int, val token: String, val fx2Port: Int = 0)
    }

    fun fx(): Fx? {
        val token = fxToken
        if (state != "connected" || ble || token.isEmpty()) return null
        val (address, port) = endpoint() ?: return null
        val fp = host?.fp ?: return null
        val c = synchronized(this) {
            fxClient?.takeIf { it.first == fp }?.second ?: client(fp).newBuilder()
                .readTimeout(30, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS) // the computer's IDLE_MS
                .build().also { fxClient = fp to it }
        }
        val h = if (address.contains(':')) "[$address]" else address
        // Not through the cable: adb reverse carries only the session's port.
        val plain = if (wired) null else fxPlain
        return Fx("https://$h:$port${Proto.FX_PATH}", token, c, address, plain, if (wired) 0 else fx2Port)
    }

    // Self-signed certificates: the fingerprint is the identity (pinned once paired).
    private fun socket(url: String, pinFp: String?): WebSocket {
        val w = client(pinFp).newWebSocket(Request.Builder().url(url).build(), Listener())
        Regex("^wss://([^:/]+):(\\d+)").find(url)?.let { endOf[w] = it.groupValues[1] to it.groupValues[2].toInt() }
        return w
    }

    private fun client(pinFp: String?): OkHttpClient {
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
        return OkHttpClient.Builder()
            .socketFactory(NoDelaySockets)
            .sslSocketFactory(ssl.socketFactory, trust)
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    // ---- the resume socket and the fallback ----

    private fun gone(w: WebSocket, failure: String?) {
        lastRxOf.remove(w)
        endOf.remove(w)
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
            if (h.address != pendingAddress) { h.address = pendingAddress; store.putHost(h, hostsKey) }
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
        Log.i("TwinDesk", "Bluetooth fallback closed. The connection remains on Wi-Fi")
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
        raw(msg(Proto.T.HELLO, "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName, "os" to Proto.OS, "token" to h.token, "fx" to 1, "fxPlain" to 1).apply { if (!wired) put("fx2", 1) })
        helloTimer?.cancel(false)
        helloTimer = exec.schedule({ if (state != "connected") { message = tr("No answer"); ws?.cancel() } }, if (ble) Proto.BLE_TIMEOUT_MS else Proto.TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    private fun onText(text: String) {
        val m = runCatching { JSONObject(text) }.getOrNull() ?: return
        val t = m.optString("t")
        lastRx = System.currentTimeMillis()
        when (t) {
            Proto.T.PAIR_NONCE -> return onNonce(m)
            Proto.T.PAIR_OK -> return onPairOk(m)
            Proto.T.PAIR_CANCEL -> return pairFailed(tr("Pairing was cancelled on the computer."))
            Proto.T.WELCOME -> return onWelcome(m)
            Proto.T.ERROR -> return onError(m)
            Proto.T.PING -> { if (state == "connected") raw(msg(Proto.T.PONG, "ts" to m.opt("ts"))); return }
            Proto.T.PONG -> { if (m.has("ts")) rttMs = maxOf(0, System.currentTimeMillis() - m.optLong("ts")); return }
            QUIET_IDLE -> { if (state == "connected") { val was = peerIdle; peerIdle = m.optBoolean("on"); if (was != peerIdle) nudge() }; return }
        }
        if (state == "connected") events.onMessage(m)
    }

    private fun onNonce(m: JSONObject) {
        val p = pair ?: return
        val nonce = m.optString("nonce")
        if (mode != "pair" || nw.isEmpty() || !Regex("^[0-9a-f]{32,128}$").matches(nonce) || nonce.length % 2 != 0) {
            return pairFailed(tr("The computer sent an invalid pairing response."))
        }
        raw(msg(Proto.T.PAIR_REVEAL, "nonce" to nw))
        pair = p.copy(phase = "code", code = Proto.sasCode(seenFp, nw, nonce))
        if (p.wired || p.qr) {
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
        if (token.isEmpty() || id.isEmpty()) return pairFailed(tr("The computer sent an invalid pairing response."))
        // Through the cable the address is this phone's own end of adb reverse: the computer's
        // network address comes from discovery when it's seen (Core.connect), else the cable again.
        // Through Bluetooth likewise: no network address yet (Core keeps the pipe for it).
        val h = if (p.wired || p.ble) Host(id, m.optString("macName").take(64).ifEmpty { p.name }, m.optString("os", "mac"), "127.0.0.1", Proto.PORT, seenFp, token, System.currentTimeMillis())
            else Host(id, m.optString("macName").take(64).ifEmpty { p.name }, m.optString("os", "mac"), p.address, p.port, seenFp, token, System.currentTimeMillis())
        store.putHost(h, hostsKey)
        pair = null
        mode = "session"
        host = h
        wired = p.wired
        ble = p.ble
        setState("connecting", "")
        hello()
    }

    private fun onWelcome(m: JSONObject) {
        if (mode != "session" || state == "connected") return
        helloTimer?.cancel(false)
        val h = host ?: return
        m.optString("macName").takeIf { it.isNotEmpty() }?.let { h.name = it.take(64) }
        if (m.has("tail")) h.tail = Tailnet.clean(m.optJSONArray("tail")) // its Tailscale addresses (Tailnet.kt)
        h.lastSeen = System.currentTimeMillis()
        store.putHost(h, hostsKey)
        rttMs = null
        resumeKey = m.optString("resume")
        fxToken = m.optString("fx").takeIf { Regex("^[0-9a-f]{32}$").matches(it) } ?: ""
        fxPlain = m.optJSONObject("fxPlain")?.let { p ->
            val port = p.optInt("port", 0)
            val token = p.optString("token")
            val p2 = p.optInt("fx2Port", 0).takeIf { it in 1..65535 } ?: 0
            if (port in 1..65535 && Regex("^[0-9a-f]{32}$").matches(token)) Fx.Plain(port, token, p2) else null
        }
        fx2Port = m.optJSONObject("fx2")?.optInt("port", 0)?.takeIf { it in 1..65535 && fxToken.isNotEmpty() } ?: 0
        ws?.let { lastRxOf[it] = System.currentTimeMillis() }
        // Each of the session's sockets on its own: a quiet fallback goes, the session lives on.
        peerIdle = false
        saidIdle = false
        quietSince = 0L
        quietEnd = 0L
        probeAt = 0L
        probed = false
        lastUse = System.currentTimeMillis()
        pinger = exec.scheduleWithFixedDelay({ beat() }, Proto.PING_MS, Proto.PING_MS, TimeUnit.MILLISECONDS)
        setState("connected", "")
        events.onWelcome(h)
    }

    // Each of the session's sockets on its own: a quiet fallback goes, the session lives on.
    private fun beat() {
        if (state != "connected") return
        val now = System.currentTimeMillis()
        // Quiet (both ends idle): only the network socket's own rule changes; Bluetooth as before.
        val mine = sayIdle(now)
        val quietNow = mine && peerIdle && !ble
        if (quietNow && quietSince == 0L) { quietSince = now; Log.i("TwinDesk", "link quiet: pings every ${QUIET_PING_MS / 60000} min") }
        if (!quietNow && quietSince != 0L) { quietSince = 0L; quietEnd = now; probeAt = 0L; probed = false; Log.i("TwinDesk", "link active: pings every second") }
        run {
            for (w in listOfNotNull(ws, alt)) {
                val onBle = if (w === ws) ble else altBle
                val limit = if (onBle) Proto.BLE_TIMEOUT_MS else Proto.TIMEOUT_MS
                val rx = maxOf(lastRxOf[w] ?: lastRx, if (onBle) bleRx() else 0L, if (onBle) 0L else quietEnd)
                if (!onBle && quietNow) {
                    if (w === ws && probeAt != 0L) { // something went out while quiet: is anyone there?
                        if (rx >= probeAt) { probeAt = 0L; probed = false }
                        else if (!probed) { probed = true; quietPing = now; w.send(msg(Proto.T.PING, "ts" to now).toString()); continue }
                        else if (now - probeAt > Proto.TIMEOUT_MS) {
                            Log.i("TwinDesk", "no answer on a quiet link, closing")
                            if (alt == null) message = tr("Not responding")
                            w.cancel()
                            continue
                        } else continue
                    }
                    if (now - rx > QUIET_TIMEOUT_MS) {
                        Log.i("TwinDesk", "network socket silent for ${now - rx} ms on a quiet link, closing")
                        if (w === ws && alt == null) message = tr("Not responding")
                        w.cancel()
                    } else if (now - maxOf(quietPing, quietSince) >= QUIET_PING_MS) {
                        quietPing = now
                        w.send(msg(Proto.T.PING, "ts" to now).toString())
                    }
                    continue
                }
                if (now - rx > limit) {
                    Log.i("TwinDesk", "${if (onBle) "Bluetooth" else "network"} socket silent for ${now - rx} ms, closing")
                    if (w === ws && alt == null) message = tr("Not responding")
                    w.cancel()
                } else w.send(msg(Proto.T.PING, "ts" to now).toString())
            }
        }
    }

    private val pairErrors get() = mapOf(
        Proto.E.PAIR_REFUSED to tr("Pairing was refused."),
        Proto.E.PAIR_TIMEOUT to tr("Pairing timed out."),
        Proto.E.BUSY to tr("That computer is busy pairing with another device."),
        Proto.E.VERSION_MISMATCH to tr("That computer runs a different version of TwinDesk. Update both devices."),
    )

    private fun onError(m: JSONObject) {
        val code = m.optString("code")
        lastCode = code
        if (mode == "pair") return pairFailed(pairErrors[code] ?: tr("Pairing failed ({code}).", "code" to code))
        message = when (code) {
            Proto.E.BAD_TOKEN -> tr("{name} forgot this phone. Pair again.", "name" to (host?.name ?: tr("The computer")))
            Proto.E.BUSY -> m.optString("message").ifEmpty { tr("Busy with another device") }
            Proto.E.REPLACED -> m.optString("message").ifEmpty { tr("Another device connected") }
            Proto.E.RELEASED -> tr("Disconnected from {name}", "name" to (host?.name ?: tr("the computer")))
            Proto.E.ASLEEP -> tr("{name} is asleep", "name" to (host?.name ?: tr("The computer")))
            else -> tr("Closed ({code})", "code" to code)
        }
        if (code == Proto.E.BAD_TOKEN) host?.let { store.forgetHost(it.id, hostsKey) }
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
        pinger = null
        quietSince = 0L
        helloTimer?.cancel(false)
        ws = null
        fxToken = ""
        fxPlain = null
        fx2Port = 0
        dropOthers()
        if (mode == "pair") {
            val p = pair
            if (p != null && p.phase != "failed") {
                pairFailed(if (p.phase == "connecting") tr("Couldn’t connect to {address}{reason}.", "address" to p.address, "reason" to (failure?.let { " ($it)" } ?: "")) else tr("The connection closed."))
            }
            return
        }
        val was = state
        if (failure == "identity") {
            setState("failed", tr("{name} looks different now. Forget it and pair again.", "name" to (host?.name ?: tr("The computer"))))
        } else {
            if (message.isEmpty() && failure != null) message = failure
            setState(if (was == "connected" || was == "connecting") "idle" else was, message)
        }
        host?.let { events.onClosed(it, lastCode) }
    }

    private fun closeSocket() {
        pinger?.cancel(false)
        helloTimer?.cancel(false)
        val w = ws
        ws = null
        fxToken = ""
        fxPlain = null
        fx2Port = 0
        dropOthers()
        val wasConnected = state == "connected"
        if (wasConnected) state = "idle"
        w?.close(1000, null)
        if (wasConnected) host?.let { events.onClosed(it, "local") }
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

// The session's sockets without Nagle: input (a pen's 120–240 samples a second, pointer moves) goes
// out at once instead of waiting for the computer to acknowledge what went before (40–200 ms with
// its delayed ACKs). OkHttp leaves Nagle on; the TLS socket is layered over these.
private object NoDelaySockets : javax.net.SocketFactory() {
    private val base = javax.net.SocketFactory.getDefault()
    private fun nd(s: java.net.Socket) = s.apply { runCatching { tcpNoDelay = true } }
    override fun createSocket() = nd(base.createSocket())
    override fun createSocket(host: String?, port: Int) = nd(base.createSocket(host, port))
    override fun createSocket(host: String?, port: Int, localHost: java.net.InetAddress?, localPort: Int) = nd(base.createSocket(host, port, localHost, localPort))
    override fun createSocket(host: java.net.InetAddress?, port: Int) = nd(base.createSocket(host, port))
    override fun createSocket(address: java.net.InetAddress?, port: Int, localAddress: java.net.InetAddress?, localPort: Int) = nd(base.createSocket(address, port, localAddress, localPort))
}
