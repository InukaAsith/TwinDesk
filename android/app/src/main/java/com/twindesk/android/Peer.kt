// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Connect with Android: this phone and another phone with TwinDesk. One session at a time, as on the
// computers: a phone's session ends the computer's (Core.link) and a computer's ends the phone's, and
// while a phone is connected the app's pages are that phone's (only what both can do: peer.info's
// caps). Its own link, its own paired list, its own port.
//
// Roles: the phone that taps Connect is the guest, the other the host. The host runs PeerServer
// (always, with "Host for other phones" on; else only when asked: peer.ask over discovery, which a
// paired phone gets at once and a new one after Allow). The guest's side is a second Link, the
// computers' own client (pairing by code, hello, pings), with its hosts kept apart ("peerHosts").
// After the first pairing each phone also gives the other a token for itself (peer.rev), so either
// can connect to the other later without pairing again.
//
// On the session, the same messages both ways (both phones run this): clip, notif, files (f.*),
// requests (q → r: the other phone's messages, photos, files, its screen) and screen.*. The bytes of
// files and the screen go in HTTPS requests to the host (the guest's PUT or GET, the host's answer),
// with the session's key (peer.key), never through the session itself.
package com.twindesk.android

import android.Manifest
import android.app.Notification
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.service.notification.StatusBarNotification
import android.util.Log
import android.util.Size
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class Peer(val core: Core) : PeerServer.Handler, Link.Events {
    private val ctx = core.ctx
    private val store = core.store
    private val main = Handler(Looper.getMainLooper())
    val server = PeerServer(this)
    val link = Link(store, this, HOSTS)
    private val work = Executors.newFixedThreadPool(2) { r -> Thread(r, "td-peer").apply { isDaemon = true } }
    private val xfer = Executors.newCachedThreadPool { r -> Thread(r, "td-peer-x").apply { isDaemon = true } }

    // ---- settings ----
    // Connect with Android itself (off until turned on): off, other phones don't see this one (Discovery's
    // peerOn), nothing hosts, a session with a phone ends.
    val on get() = store.flag("peer.on", false)
    fun setOn(v: Boolean) {
        store.setFlag("peer.on", v)
        core.discovery.peerOn = v
        if (!v) {
            if (connected) disconnect()
            if (link.pair != null) link.cancelPairing()
            asked = null
            waitingFor = ""
            message = ""
            core.discovery.phones.clear()
        }
        hosting()
        core.bg.execute { runCatching { core.discovery.beacon() } }
        core.changed()
    }
    val hostOn get() = store.flag("peer.host", false)
    fun setHostOn(v: Boolean) { store.setFlag("peer.host", v); hosting(); core.changed() }
    val clipOn get() = store.flag("peer.clip", true)
    fun setClipOn(v: Boolean) { store.setFlag("peer.clip", v); core.changed() }
    val notifsOn get() = store.flag("peer.notifs", true)
    fun setNotifsOn(v: Boolean) { store.setFlag("peer.notifs", v); core.changed() }

    // ---- the session ----
    @Volatile var role = "" ; private set // "" | host | guest
    @Volatile var peerId = ""; private set
    @Volatile var peerName = ""; private set
    @Volatile private var hostWs: PeerServer.Ws? = null
    @Volatile private var key = "" // the session's key for its HTTPS requests
    val connected get() = role.isNotEmpty()
    // The other phone: its os (from pairing or its hello) and what it can do (peer.info's caps).
    @Volatile var peerOs = ""; private set
    @Volatile private var peerCaps: Set<String>? = null
    fun can(c: String): Boolean = c in (peerCaps ?: defaultCaps(peerOs))
    // What this phone offers the other: the same names in our peer.info.
    fun myCaps(): Set<String> = buildSet {
        addAll(listOf("clip", "notifs", "files", "screen", "photos"))
        if (core.hub.perm("messages") != "none") add("messages")
        if (core.hub.perm("files") != "none") add("fs")
    }
    // A phone older than caps: an iPhone has no messages or storage to browse; an Android phone has all.
    private fun defaultCaps(os: String) = if (os == "ios") setOf("clip", "notifs", "files", "screen", "photos")
        else setOf("clip", "notifs", "files", "screen", "photos", "messages", "fs")
    @Volatile var message = ""; private set

    // ---- pairing, as the host (mac/pairing.js) ----
    class PairReq(val ws: PeerServer.Ws, val id: String, val name: String, val commit: String, val nm: String) {
        var nw = ""
        var code = ""
        var confirmed = false
        var allowed = false
        val at = System.currentTimeMillis()
    }
    @Volatile var pairing: PairReq? = null; private set
    // A phone asked us to host (peer.ask), not paired yet: Allow or Not now.
    @Volatile var asked: Found? = null; private set
    @Volatile private var tempUntil = 0L // hosting because we were asked, until then (or while a session lasts)
    // As the guest: waiting for this phone to start hosting (our peer.ask), until then.
    @Volatile var waitingFor: String = ""; private set
    @Volatile private var waitUntil = 0L

    private val myFp: String by lazy { runCatching { Proto.sha256(android.util.Base64.decode(ShareKey.cert(), android.util.Base64.NO_WRAP)).hex() }.getOrDefault("") }

    fun start() {
        core.discovery.peerOn = on
        core.discovery.onPeerAsk = { f, m -> main.post { onAsk(f, m) } }
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        ctx.mainExecutor.execute { cm.addPrimaryClipChangedListener { clipNow() } }
        core.bg.scheduleWithFixedDelay({ runCatching { tick() }.onFailure { Log.e("TwinDesk", "peer", it) } }, 1, 1, TimeUnit.SECONDS)
        hosting()
    }

    // The server runs while it's wanted: the setting, an ask, a session, a pairing.
    @Synchronized
    private fun hosting() {
        val now = System.currentTimeMillis()
        val want = on && (hostOn || now < tempUntil || role == "host" || pairing != null)
        if (want && !server.running) server.start()
        if (!want && server.running) server.stop()
        val port = if (server.running) server.port else 0
        if (core.discovery.peerPort != port) {
            core.discovery.peerPort = port
            core.bg.execute { runCatching { core.discovery.beacon() } }
        }
    }

    private var ticks = 0
    private fun tick() {
        ticks++
        val now = System.currentTimeMillis()
        // The host's liveness: the guest pings every second (Link).
        hostWs?.let { w -> if (now - w.lastRx > Proto.TIMEOUT_MS) { Log.i("TwinDesk", "peer: $peerName stopped answering"); w.close() } else w.send(msg(Proto.T.PING, "ts" to now).toString()) }
        pairing?.let { p -> if (now - p.at > 60_000) { pairing = null; pairFailed(p.ws); fail(p.ws, Proto.E.PAIR_TIMEOUT, "Pairing timed out"); core.changed() } }
        // Waiting for the other phone to host: it's in its beacon (or peer.hosting) now.
        if (waitingFor.isNotEmpty()) {
            val f = core.discovery.phones[waitingFor]
            if (f != null && f.port > 0) { waitingFor = ""; main.post { connect(f) } }
            else if (now > waitUntil) { waitingFor = ""; message = tr("{name} didn’t answer. Open TwinDesk on it, or turn on Host for other phones there.", "name" to (f?.name ?: tr("That phone"))); core.changed() }
        }
        if (ticks % 5 == 0) hosting()
    }

    // ---- as the guest ----

    fun paired(): List<Host> = store.hosts(HOSTS)
    fun isPaired(id: String) = paired().any { it.id == id } || guests().has(id)
    fun nearby(): List<Found> = core.discovery.phones.values.sortedBy { it.name }

    // Connect on a phone near: straight to it while it hosts; else ask it to.
    fun connect(f: Found) {
        message = ""
        if (connected && peerId == f.id) return
        if (connected) disconnect()
        if (f.port <= 0) {
            waitingFor = f.id
            waitUntil = System.currentTimeMillis() + 30_000
            core.bg.execute { core.discovery.sendTo(msg("peer.ask", "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName), f.address) }
            core.changed()
            return
        }
        val h = paired().find { it.id == f.id }
        if (h != null) {
            h.address = f.address; h.port = f.port
            store.putHost(h, HOSTS)
            link.connect(h)
        } else link.startPairing(f.address, f.port, f.name)
        core.changed()
    }

    fun cancelWait() { waitingFor = ""; core.changed() }

    fun disconnect() {
        resumeUntil = 0
        when (role) {
            "guest" -> link.disconnect()
            "host" -> { hostWs?.send(msg(Proto.T.BYE).toString()); hostWs?.close() }
        }
        if (link.pair != null) link.cancelPairing()
    }

    fun forget(id: String) {
        if (peerId == id && connected) { send(msg("peer.forget")); disconnect() }
        store.forgetHost(id, HOSTS)
        val g = guests(); g.remove(id); store.setPrefsString(GUESTS, g.toString())
        core.changed()
    }

    // Link.Events (the guest's link)
    override fun onChange() = core.changed()
    override fun onWelcome(host: Host) {
        resumeUntil = 0
        role = "guest"
        peerId = host.id
        peerName = host.name
        peerOs = host.os
        peerCaps = null
        key = ""
        // A token for the other way (it can connect to us later, without pairing again), and our certificate.
        val token = Proto.randomHex(32)
        val g = guests()
        g.put(host.id, JSONObject().put("name", host.name).put("tokenHash", Proto.sha256(token.toByteArray()).hex()).put("at", System.currentTimeMillis()))
        store.setPrefsString(GUESTS, g.toString())
        send(msg("peer.rev", "token" to token, "fp" to myFp, "port" to PeerServer.PEER_PORT))
        started()
    }
    override fun onMessage(m: JSONObject) = dispatch(m)
    override fun onClosed(host: Host, code: String?) {
        if (role == "guest") ended()
        // Dropped by accident: try to get it back for a while (as Core does with the computer).
        val accidental = code == null || code !in setOf("local", Proto.E.RELEASED, Proto.E.REPLACED, Proto.E.BAD_TOKEN, Proto.E.BUSY)
        if (!accidental || link.state == "failed") { resumeUntil = 0; return }
        if (resumeUntil == 0L) resumeUntil = System.currentTimeMillis() + Proto.PHONE_GRACE_MS
        core.bg.schedule({
            if (System.currentTimeMillis() > resumeUntil || connected || link.state == "connecting" || link.pair != null) return@schedule
            val h = paired().find { it.id == host.id } ?: return@schedule
            core.discovery.phones[h.id]?.let { f -> if (f.port > 0) { h.address = f.address; h.port = f.port } }
            link.connect(h)
        }, 2, TimeUnit.SECONDS)
    }
    @Volatile private var resumeUntil = 0L

    // ---- as the host (PeerServer.Handler) ----

    override fun onOpen(ws: PeerServer.Ws) {}

    override fun onText(ws: PeerServer.Ws, text: String) {
        ws.lastRx = System.currentTimeMillis()
        val m = runCatching { JSONObject(text) }.getOrNull() ?: return ws.close()
        val t = m.optString("t")
        if (ws === hostWs) {
            when (t) {
                Proto.T.PING -> ws.send(msg(Proto.T.PONG, "ts" to m.opt("ts")).toString())
                Proto.T.PONG -> Unit
                Proto.T.BYE -> ws.close()
                else -> dispatch(m)
            }
            return
        }
        when (t) {
            Proto.T.PAIR_START -> pairStart(ws, m)
            Proto.T.PAIR_REVEAL -> pairing?.takeIf { it.ws === ws }?.let { p ->
                val nonce = m.optString("nonce")
                if (p.nw.isNotEmpty() || !Regex("^[0-9a-f]{32}$").matches(nonce) || Proto.commitOf(nonce) != p.commit) { pairing = null; pairFailed(ws); fail(ws, Proto.E.PAIR_REFUSED, "Nonce does not match"); core.changed(); return }
                p.nw = nonce
                p.code = Proto.sasCode(myFp, p.nw, p.nm)
                Log.i("TwinDesk", "peer: pairing code ready for ${p.name}")
                core.changed()
                main.post { Notify.peer(ctx, tr("Pair with {name}?", "name" to p.name), tr("Check that both phones show the same code in TwinDesk.")) }
            }
            Proto.T.PAIR_CONFIRM -> pairing?.takeIf { it.ws === ws && it.code.isNotEmpty() }?.let { it.confirmed = true; finishPair() }
            Proto.T.PAIR_CANCEL -> { if (pairing?.ws === ws) { pairing = null; pairFailed(ws); core.changed() }; ws.close() }
            Proto.T.HELLO -> hello(ws, m)
            else -> fail(ws, "bad_message", "\"$t\" before welcome")
        }
    }

    override fun onClose(ws: PeerServer.Ws) {
        if (pairing?.ws === ws) { pairing = null; pairFailed(ws); core.changed() }
        if (ws === hostWs) { hostWs = null; ended() }
    }

    private fun fail(ws: PeerServer.Ws, code: String, why: String) {
        ws.send(msg(Proto.T.ERROR, "code" to code, "message" to why).toString())
        ws.close()
    }

    // Failed pairings per address, as shared/pairfail.js: after 5 in 10 minutes that address can't
    // start another for a while, so a phone on the network can't keep popping the dialog.
    private val pairFails = HashMap<String, MutableList<Long>>()
    private fun pairFailed(ws: PeerServer.Ws) {
        val a = ws.address
        if (a.isEmpty() || a == "127.0.0.1") return
        val now = System.currentTimeMillis()
        synchronized(pairFails) { pairFails.getOrPut(a) { mutableListOf() }.apply { removeAll { now - it >= 600_000 }; add(now) } }
    }
    private fun pairLocked(ws: PeerServer.Ws): Boolean = synchronized(pairFails) {
        val l = pairFails[ws.address] ?: return false
        val now = System.currentTimeMillis()
        l.removeAll { now - it >= 600_000 }
        if (l.isEmpty()) pairFails.remove(ws.address)
        l.size >= 5
    }

    private fun pairStart(ws: PeerServer.Ws, m: JSONObject) {
        if (pairLocked(ws)) return fail(ws, Proto.E.PAIR_REFUSED, "Too many failed pairing attempts; wait a few minutes and try again")
        val p = pairing
        if (p != null && p.ws !== ws) return fail(ws, Proto.E.BUSY, "Another pairing is in progress")
        if (m.optInt("v") != Proto.VERSION) return fail(ws, Proto.E.VERSION_MISMATCH, "Different TwinDesk version")
        val id = m.optString("id")
        val commit = m.optString("commit")
        if (id.isEmpty() || !Regex("^[0-9a-f]{64}$").matches(commit)) { pairFailed(ws); return fail(ws, "bad_message", "pair.start needs id and commit") }
        val nm = Proto.randomHex(16)
        pairing = PairReq(ws, id.take(64), m.optString("name").take(64).ifEmpty { "Phone" }, commit, nm)
        ws.send(msg(Proto.T.PAIR_NONCE, "nonce" to nm, "os" to Proto.OS).toString())
        hosting()
        core.changed()
    }

    // Allow / Deny here (the dialog).
    fun respondPair(allow: Boolean) {
        val p = pairing ?: return
        if (!allow) { pairing = null; pairFailed(p.ws); fail(p.ws, Proto.E.PAIR_REFUSED, "Refused"); core.changed(); return }
        if (p.code.isEmpty()) return
        p.allowed = true
        finishPair()
    }

    private fun finishPair() {
        val p = pairing ?: return
        core.changed()
        if (!p.confirmed || !p.allowed) return
        val token = Proto.randomHex(32)
        val g = guests()
        g.put(p.id, JSONObject().put("name", p.name).put("tokenHash", Proto.sha256(token.toByteArray()).hex()).put("at", System.currentTimeMillis()))
        store.setPrefsString(GUESTS, g.toString())
        p.ws.send(msg(Proto.T.PAIR_OK, "token" to token, "macId" to store.deviceId, "macName" to store.deviceName, "os" to Proto.OS).toString())
        pairing = null
        synchronized(pairFails) { pairFails.remove(p.ws.address) }
        Log.i("TwinDesk", "peer: paired with ${p.name}")
        core.changed()
    }

    private fun hello(ws: PeerServer.Ws, m: JSONObject) {
        if (m.optInt("v") != Proto.VERSION) return fail(ws, Proto.E.VERSION_MISMATCH, "Different TwinDesk version")
        val id = m.optString("id")
        val e = guests().optJSONObject(id)
        val token = m.optString("token")
        if (e == null || token.isEmpty() || !java.security.MessageDigest.isEqual(Proto.sha256(token.toByteArray()).hex().toByteArray(), e.optString("tokenHash").toByteArray())) {
            return fail(ws, Proto.E.BAD_TOKEN, "Not paired with this phone")
        }
        if (role == "guest") return fail(ws, Proto.E.BUSY, "Connected to another phone")
        hostWs?.let { old -> if (old !== ws) { old.send(msg(Proto.T.ERROR, "code" to Proto.E.REPLACED, "message" to "Connected again").toString()); old.close() } }
        if (role == "host") ended()
        hostWs = ws
        role = "host"
        peerId = id
        peerName = m.optString("name").take(64).ifEmpty { e.optString("name") }
        peerOs = m.optString("os").take(20)
        peerCaps = null
        e.put("name", peerName); val g = guests(); g.put(id, e); store.setPrefsString(GUESTS, g.toString())
        key = Proto.randomHex(16)
        ws.send(msg(Proto.T.WELCOME, "v" to Proto.VERSION, "macId" to store.deviceId, "macName" to store.deviceName, "os" to Proto.OS).toString())
        ws.send(msg("peer.key", "key" to key).toString())
        tempUntil = 0
        hosting()
        started()
    }

    // ---- both ----

    fun send(m: JSONObject): Boolean = when (role) {
        "host" -> hostWs?.send(m.toString()) ?: false
        "guest" -> link.send(m)
        else -> false
    }

    private fun queued(): Long = when (role) { "host" -> hostWs?.queued() ?: 0; "guest" -> link.queued(); else -> 0 }

    private fun started() {
        Log.i("TwinDesk", "peer: session with $peerName as $role")
        message = ""
        send(msg("peer.info", "model" to android.os.Build.MODEL, "os" to Proto.OS, "caps" to JSONArray(myCaps().toList())))
        // One session: the computer's ends (Core.connect and Core.onWelcome end ours the other way).
        if (core.link.connected || core.link.state == "connecting") { Log.i("TwinDesk", "peer: ending the computer's session for $peerName"); core.disconnect() }
        core.changed()
    }

    private fun ended() {
        Log.i("TwinDesk", "peer: session with $peerName ended")
        role = ""
        key = ""
        peerCaps = null
        val waiting = calls.values.toList()
        calls.clear()
        main.post { for (cb in waiting) runCatching { cb(JSONObject().put("error", tr("Disconnected"))) } }
        for (id in inFiles.keys.toList()) inFailed(id)
        outFiles.clear()
        PeerScreen.stopAll(this)
        hosting()
        core.changed()
    }

    // A phone asked us to host (peer.ask), or answered ours (peer.hosting, peer.no).
    private fun onAsk(f: Found, m: JSONObject) {
        when (m.optString("t")) {
            "peer.ask" -> {
                if (connected) return
                if (hostOn || guests().has(f.id) || paired().any { it.id == f.id }) return allowHost(f)
                val last = asked
                if (last != null && last.id == f.id) return
                asked = f
                Notify.peer(ctx, tr("{name} wants to connect", "name" to f.name), tr("Open TwinDesk to allow the connection."))
                core.changed()
            }
            "peer.hosting" -> {
                val port = m.optInt("port")
                if (waitingFor == f.id && port in 1..65535) {
                    core.discovery.phones[f.id] = (core.discovery.phones[f.id] ?: f).copy(address = f.address, port = port, lastSeen = System.currentTimeMillis())
                }
            }
            "peer.no" -> if (waitingFor == f.id) { waitingFor = ""; message = tr("{name} said not now.", "name" to f.name); core.changed() }
        }
    }

    private fun allowHost(f: Found) {
        tempUntil = System.currentTimeMillis() + 120_000
        hosting()
        val port = server.port
        if (port > 0) core.bg.execute { core.discovery.sendTo(msg("peer.hosting", "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName, "port" to port), f.address) }
    }

    fun answerAsk(allow: Boolean) {
        val f = asked ?: return
        asked = null
        Notify.cancelPeer(ctx)
        if (allow) allowHost(f)
        else core.bg.execute { core.discovery.sendTo(msg("peer.no", "v" to Proto.VERSION, "id" to store.deviceId, "name" to store.deviceName), f.address) }
        core.changed()
    }

    private fun guests(): JSONObject = runCatching { JSONObject(store.prefsString(GUESTS, "{}")) }.getOrDefault(JSONObject())

    @Volatile var peerModel = ""; private set

    private fun dispatch(m: JSONObject) {
        when (m.optString("t")) {
            "peer.key" -> key = m.optString("key").take(64)
            "peer.info" -> {
                peerModel = m.optString("model").take(80)
                m.optString("os").take(20).takeIf { it.isNotEmpty() }?.let { peerOs = it }
                m.optJSONArray("caps")?.let { a -> peerCaps = (0 until a.length()).map { a.optString(it).take(20) }.toSet() }
                core.changed()
            }
            // The other way: the guest can be reached as a host too, with this token.
            "peer.rev" -> if (role == "host") {
                val token = m.optString("token")
                val fp = Proto.normFingerprint(m.optString("fp"))
                if (Regex("^[0-9a-f]{64}$").matches(token) && Regex("^[0-9a-f]{64}$").matches(fp)) {
                    val near = core.discovery.phones[peerId]
                    store.putHost(Host(peerId, peerName, Proto.OS, near?.address ?: hostWs?.address ?: "", m.optInt("port", PeerServer.PEER_PORT), fp, token, System.currentTimeMillis()), HOSTS)
                }
            }
            "peer.forget" -> { val id = peerId; main.post { forget(id) } }
            "clip" -> clipIn(m)
            "notif" -> notifIn(m)
            "f.offer" -> work.execute { inOffer(m) }
            "f.accept" -> outAccepted(m.optString("id"))
            "f.pull" -> Unit
            "f.done" -> outDone(m.optString("id"), m.optBoolean("ok"))
            "f.cancel" -> { inFailed(m.optString("id")); outFiles.remove(m.optString("id")) }
            "q" -> work.execute { answer(m) }
            "r" -> calls.remove(m.optString("qid"))?.let { cb -> main.post { cb(m) } }
            "screen.ready" -> PeerScreen.ready(this)
            "screen.stop" -> PeerScreen.remoteStop(this)
            "screen.state" -> PeerScreen.state(this, m)
        }
    }

    // ---- clipboard ----

    @Volatile private var clipLastIn = ""
    @Volatile private var clipLastOut = ""

    // What's on the clipboard now (Android lets us read it while we're in front).
    fun clipNow() {
        if (!connected || !clipOn) return
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = runCatching { cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString() }.getOrNull() ?: return
        clipOut(text)
    }

    // From Clip.sendText too (the share sheet, the tile).
    fun clipOut(text: String) {
        if (!connected || !clipOn || text.isEmpty() || text == clipLastIn || text == clipLastOut || text.toByteArray().size > Proto.CLIP_MAX_BYTES) return
        clipLastOut = text
        send(msg("clip", "text" to text))
    }

    private fun clipIn(m: JSONObject) {
        val text = m.optString("text")
        if (!clipOn || text.isEmpty() || text.toByteArray().size > Proto.CLIP_MAX_BYTES) return
        clipLastIn = text
        main.post { runCatching { (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("TwinDesk", text)) } }
    }

    // ---- notifications ----

    private val recentNotifs = object : LinkedHashMap<String, Long>(32, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Long>?) = size > 64
    }

    // From Notifs.posted: this phone's notification, to the other phone too.
    fun notifPosted(sbn: StatusBarNotification, n: Notifs) {
        if (!connected || !notifsOn) return
        val no = sbn.notification ?: return
        val pkg = sbn.packageName
        if (pkg == ctx.packageName || sbn.isOngoing || no.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        if (no.category == Notification.CATEGORY_TRANSPORT || no.category == Notification.CATEGORY_PROGRESS || no.category == Notification.CATEGORY_SERVICE) return
        if (n.isMuted(pkg)) return
        val title = n.titleOf(no.extras)
        val text = if (store.flag("notifs.hideText", false)) "" else n.textOf(no.extras)
        if (title.isEmpty() && text.isEmpty()) return
        val hash = "$pkg|$title|$text"
        val now = System.currentTimeMillis()
        synchronized(recentNotifs) { if (now - (recentNotifs[hash] ?: 0L) < 2000L) return; recentNotifs[hash] = now }
        send(msg("notif", "id" to sbn.key.take(200), "app" to pkg, "appName" to n.appName(pkg), "title" to title.take(300), "body" to text.take(1000), "at" to sbn.postTime))
    }

    private fun notifIn(m: JSONObject) {
        if (!notifsOn) return
        val app = m.str("appName", 80).ifEmpty { m.str("app", 80) }
        Notify.fromComputer(ctx, "peer:" + m.str("id", 200), app, m.str("title", 300), m.str("body", 1000), peerName.ifEmpty { "Phone" })
    }

    // ---- files ----
    // f.offer {id, name, size, batch, count, rel} → f.accept. The bytes: the guest PUTs what it sends
    // (/peer/f/<id>) and GETs what the host sends (after f.accept there, the host waits); f.done from
    // the one receiving. Into Download/TwinDesk.

    class OutFile(val id: String, val uri: Uri, val name: String, val size: Long, val batch: String)
    class InFile(val id: String, val name: String, val size: Long, val batch: String, val uri: Uri, val out: OutputStream) { @Volatile var got = 0L }
    class Batch(val id: String, val count: Int, val bytes: Long, val up: Boolean, val name: String) {
        var done = 0; var ok = true; var moved = 0L; var last = 0L
        val key = (id.hashCode() and 0x7fff) or (if (up) 0x8000 else 0)
        var only: Pair<Uri, String>? = null
    }
    private val outFiles = ConcurrentHashMap<String, OutFile>()
    private val inFiles = ConcurrentHashMap<String, InFile>()
    private val batches = ConcurrentHashMap<String, Batch>()
    val busyLine: String? get() = batches.values.firstOrNull()?.let { b -> if (b.up) tr("Sending {file} · {pct}%", "file" to b.name, "pct" to Files.pct(b.moved, b.bytes)) else tr("Receiving {file} · {pct}%", "file" to b.name, "pct" to Files.pct(b.moved, b.bytes)) }

    // Send these to the other phone. rel: folders kept (its Files).
    fun sendFiles(items: List<Files.Item>): Boolean {
        if (!connected || items.isEmpty()) return false
        val batch = UUID.randomUUID().toString()
        val bytes = items.sumOf { it.size.coerceAtLeast(0) }
        batches[batch] = Batch(batch, items.size, bytes, true, if (items.size == 1) items[0].name else Files.plural(items.size, "item"))
        items.forEachIndexed { i, it ->
            val id = UUID.randomUUID().toString()
            outFiles[id] = OutFile(id, it.uri, it.name, it.size, batch)
            send(msg("f.offer", "id" to id, "name" to it.name, "size" to it.size, "batch" to batch, "count" to items.size, "index" to i, "bytes" to bytes, "rel" to it.rel.ifEmpty { it.name }))
        }
        core.changed()
        return true
    }

    fun sendUris(uris: List<Uri>) = work.execute { sendFiles(core.files.describe(uris)) }

    private fun outAccepted(id: String) {
        val f = outFiles[id] ?: return
        if (role == "guest") xfer.execute { put(f) } // the host waits for our PUT; as the host, its GET
    }

    private fun put(f: OutFile) {
        val (address, port) = link.endpoint() ?: return outDone(f.id, false)
        val client = link.https() ?: return outDone(f.id, false)
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = f.size
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) { pumpFile(f, sink.outputStream()) }
        }
        val h = if (address.contains(':')) "[$address]" else address
        val ok = runCatching {
            client.newCall(Request.Builder().url("https://$h:$port/peer/f/${Uri.encode(f.id)}").header(HDR, key).put(body).build()).execute().use { it.code == 200 }
        }.getOrElse { Log.w("TwinDesk", "peer: send ${f.name}: ${it.message}"); false }
        if (!ok) { send(msg("f.cancel", "id" to f.id)); outDone(f.id, false) }
    }

    private fun pumpFile(f: OutFile, out: OutputStream) {
        ctx.contentResolver.openInputStream(f.uri)!!.use { s ->
            val buf = ByteArray(256 * 1024)
            var sent = 0L
            while (true) {
                if (!outFiles.containsKey(f.id)) throw java.io.IOException("cancelled")
                val n = s.read(buf)
                if (n < 0) break
                if (sent + n > f.size) throw java.io.IOException("the file grew")
                out.write(buf, 0, n)
                sent += n
                moved(f.batch, n.toLong())
            }
        }
    }

    private fun outDone(id: String, ok: Boolean) {
        val f = outFiles.remove(id) ?: return
        finished(f.batch, ok, null)
    }

    private fun inOffer(m: JSONObject) {
        val id = m.optString("id")
        val size = m.optLong("size", -1)
        if (id.isEmpty() || inFiles.containsKey(id)) return
        if (size < 0 || size > Proto.FILE_MAX_BYTES) { send(msg("f.cancel", "id" to id)); return }
        val rel = m.optString("rel").ifEmpty { m.optString("name") }.split('/').filter { it.isNotEmpty() }.map(::clean)
        if (rel.isEmpty()) { send(msg("f.cancel", "id" to id)); return }
        val batchId = m.optString("batch").ifEmpty { id }
        val b = batches.getOrPut(batchId) { Batch(batchId, m.optInt("count", 1).coerceIn(1, 100_000), m.optLong("bytes", size), false, if (m.optInt("count", 1) == 1) rel.last() else Files.plural(m.optInt("count", 1), "item")) }
        try {
            val name = rel.last()
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, Files.mimeOf(name))
                put(MediaStore.Downloads.RELATIVE_PATH, (listOf("Download", "TwinDesk") + rel.dropLast(1)).joinToString("/") + "/")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("no space")
            val f = InFile(id, name, size, batchId, uri, ctx.contentResolver.openOutputStream(uri)!!)
            inFiles[id] = f
            send(msg("f.accept", "id" to id))
            if (role == "guest") xfer.execute { get(f) }
            else if (size == 0L) work.execute { inFinish(f) }
        } catch (e: Exception) {
            Log.w("TwinDesk", "peer: offer: ${e.message}")
            send(msg("f.cancel", "id" to id))
            finished(b.id, false, null)
        }
    }

    // As the guest: the host's file, fetched.
    private fun get(f: InFile) {
        val ok = runCatching {
            val (address, port) = link.endpoint() ?: error("not connected")
            val client = link.https() ?: error("not connected")
            val h = if (address.contains(':')) "[$address]" else address
            client.newCall(Request.Builder().url("https://$h:$port/peer/f/${Uri.encode(f.id)}").header(HDR, key).build()).execute().use { r ->
                if (r.code != 200) error("HTTP ${r.code}")
                receive(f, r.body.byteStream())
            }
        }.onFailure { Log.w("TwinDesk", "peer: fetch ${f.name}: ${it.message}") }.isSuccess
        if (ok) inFinish(f) else { send(msg("f.cancel", "id" to f.id)); inFailed(f.id) }
    }

    private fun receive(f: InFile, s: InputStream) {
        val buf = ByteArray(256 * 1024)
        while (f.got < f.size) {
            val n = s.read(buf, 0, minOf(buf.size.toLong(), f.size - f.got).toInt())
            if (n < 0) break
            if (inFiles[f.id] !== f) throw java.io.IOException("cancelled")
            f.out.write(buf, 0, n)
            f.got += n
            moved(f.batch, n.toLong())
        }
        if (f.got != f.size) throw java.io.IOException("only ${f.got} of ${f.size} bytes")
    }

    private fun inFinish(f: InFile) {
        if (inFiles.remove(f.id) == null) return
        runCatching { f.out.close() }
        ctx.contentResolver.update(f.uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        send(msg("f.done", "id" to f.id, "ok" to true))
        finished(f.batch, true, f.uri to Files.mimeOf(f.name))
    }

    private fun inFailed(id: String) {
        val f = inFiles.remove(id) ?: return
        runCatching { f.out.close() }
        runCatching { ctx.contentResolver.delete(f.uri, null, null) }
        finished(f.batch, false, null)
    }

    private fun moved(batch: String, n: Long) {
        val b = batches[batch] ?: return
        b.moved += n
        val now = System.currentTimeMillis()
        if (now - b.last < 400) return
        b.last = now
        Notify.files(ctx, b.key, if (b.up) tr("Sending {file} to {name}", "file" to b.name, "name" to peerName) else tr("Receiving {file} from {name}", "file" to b.name, "name" to peerName), "${Files.pct(b.moved, b.bytes)}%", Files.pct(b.moved, b.bytes), null, up = b.up)
        core.changed()
    }

    private fun finished(batch: String, ok: Boolean, placed: Pair<Uri, String>?) {
        val b = batches[batch] ?: return
        synchronized(b) {
            b.done++
            if (!ok) b.ok = false
            if (placed != null && b.count == 1) b.only = placed
            if (b.done < b.count) return
        }
        batches.remove(batch)
        if (b.up) Notify.files(ctx, b.key, if (b.ok) tr("Sent {file}", "file" to b.name) else tr("Not everything arrived"), tr("On {name}", "name" to peerName), null, null, up = true)
        else {
            val open = b.only?.let { Notify.viewIntent(it.first, it.second) } ?: Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            Notify.files(ctx, b.key, if (b.ok) tr("{what} from {from}", "what" to b.name, "from" to peerName) else tr("Some files didn’t arrive from {from}", "from" to peerName), if (b.ok) tr("In Downloads › TwinDesk. Tap to open.") else tr("{what} is incomplete", "what" to b.name), null, open)
        }
        core.changed()
    }

    private fun clean(s: String): String {
        var n = s.replace(Regex("[\\u0000-\\u001f/:\\\\]"), "_").trim()
        if (n.isEmpty() || n == "." || n == "..") n = "file"
        return n.take(200)
    }

    // ---- requests: the other phone's Messages, Photos, Files, screen ----

    private val calls = ConcurrentHashMap<String, (JSONObject) -> Unit>()

    // Ask the other phone; the answer comes on the main thread ({error} when it can't).
    fun ask(op: String, args: JSONObject = JSONObject(), timeoutMs: Long = 20_000, cb: (JSONObject) -> Unit) {
        if (!connected) { main.post { cb(JSONObject().put("error", tr("Not connected"))) }; return }
        val id = Proto.randomHex(8)
        calls[id] = cb
        args.put("t", "q").put("qid", id).put("op", op)
        send(args)
        main.postDelayed({ calls.remove(id)?.let { it(JSONObject().put("error", tr("No answer"))) } }, timeoutMs)
    }

    private val messages by lazy { Messages(core.hub, core) }
    private val media by lazy { Media(core.hub, core) }
    private val fs by lazy { FsBrowse(core) }

    private fun answer(m: JSONObject) {
        val id = m.optString("qid")
        val r = runCatching { op(m.optString("op"), m) }.getOrElse { e -> JSONObject().put("error", e.message ?: "Failed") }
        // Thumbnails wait while files are queued on the session.
        send(r.put("t", "r").put("qid", id))
    }

    private fun need(what: String): JSONObject? {
        val p = core.hub.perm(what)
        if (p == "ok" || p == "partial") return null
        return JSONObject().put("error", "perm").put("perm", p)
    }

    private fun op(op: String, m: JSONObject): JSONObject = when (op) {
        "perms" -> JSONObject().put("messages", core.hub.perm("messages")).put("media", core.hub.perm("media")).put("files", core.hub.perm("files"))
        "ask" -> {
            val what = m.str("what", 20)
            if (what in listOf("messages", "media", "files")) main.post {
                val i = Intent(ctx, PermActivity::class.java).putExtra("what", what).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (android.provider.Settings.canDrawOverlays(ctx) || MainActivity.shown) runCatching { ctx.startActivity(i) } else Notify.hubAsk(ctx, what, peerName)
            }
            JSONObject().put("ok", true)
        }
        "sms.threads" -> need("messages") ?: JSONObject().put("items", messages.threads(m.optInt("n", 80)))
        "sms.thread" -> need("messages") ?: messages.thread(m).let { JSONObject().put("items", it.optJSONArray("items") ?: JSONArray()).put("more", it.optBoolean("more")) }
        "sms.part" -> need("messages") ?: JSONObject().put("data", messages.part(m.str("id", 40)))
        "sms.send" -> need("messages") ?: smsSend(m)
        "media.list" -> need("media") ?: media.list(m).let { JSONObject().put("items", it.optJSONArray("items")).put("more", it.optBoolean("more")).put("next", it.optString("next")) }
        "media.thumb" -> JSONObject().put("data", thumb(m.str("id", 40)))
        "media.view" -> JSONObject().put("data", media.view(m.str("id", 40)))
        "media.save" -> {
            val ids = m.optJSONArray("ids") ?: JSONArray()
            val uris = (0 until ids.length()).mapNotNull { mediaUri(ids.optString(it)) }.take(500)
            if (uris.isNotEmpty()) sendFiles(core.files.describe(uris))
            JSONObject().put("ok", true).put("n", uris.size)
        }
        "fs.list" -> need("files") ?: fs.list(m)
        "fs.save" -> {
            if (need("files") != null) need("files")!!
            else {
                val root = android.os.Environment.getExternalStorageDirectory()
                val paths = m.optJSONArray("paths") ?: JSONArray()
                val items = ArrayList<Files.Item>()
                for (i in 0 until paths.length()) {
                    val parts = paths.optString(i).split('/').filter { it.isNotEmpty() && it != "." }
                    if (parts.isEmpty() || parts.any { it == ".." }) continue
                    val f = java.io.File(root, parts.joinToString("/"))
                    if (!f.canonicalPath.startsWith(root.canonicalPath + "/")) continue
                    val base = f.parentFile ?: root
                    f.walkTopDown().filter { it.isFile }.take(10000 - items.size).forEach { x -> items += Files.Item(Uri.fromFile(x), x.name, x.length(), x.relativeTo(base).invariantSeparatorsPath) }
                }
                if (items.isNotEmpty()) sendFiles(items)
                JSONObject().put("ok", true).put("n", items.size)
            }
        }
        "screen.start" -> { main.post { PeerScreen.asked(this, m.optInt("maxSize", 1600)) }; JSONObject().put("ok", true) }
        else -> JSONObject().put("error", "unknown")
    }

    private fun mediaUri(id: String): Uri? {
        val n = id.drop(1).toLongOrNull() ?: return null
        return when (id.firstOrNull()) {
            'i' -> ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, n)
            'v' -> ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, n)
            else -> null
        }
    }

    private fun thumb(id: String): String? = runCatching {
        val b = ctx.contentResolver.loadThumbnail(mediaUri(id)!!, Size(256, 256), null)
        val out = ByteArrayOutputStream()
        b.compress(Bitmap.CompressFormat.JPEG, 72, out)
        "data:image/jpeg;base64," + android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
    }.getOrNull()

    @Suppress("DEPRECATION")
    private fun smsSend(m: JSONObject): JSONObject {
        if (!core.hub.granted(Manifest.permission.SEND_SMS)) return JSONObject().put("error", "Allow sending messages on $peerName")
        val to = m.str("to", 60).filter { it.isDigit() || it in "+*#" }
        val body = m.str("body", 5000)
        if (to.isEmpty() || body.isBlank()) return JSONObject().put("error", "Nothing to send")
        val sm = if (android.os.Build.VERSION.SDK_INT >= 31) ctx.getSystemService(android.telephony.SmsManager::class.java) else android.telephony.SmsManager.getDefault()
        sm.sendMultipartTextMessage(to, null, sm.divideMessage(body), null, null)
        return JSONObject().put("ok", true)
    }

    // ---- HTTPS on our server (as the host) ----

    override fun onRequest(method: String, path: String, headers: Map<String, String>, body: InputStream, out: OutputStream, sock: Socket) {
        val ws = hostWs
        val k = key
        if (role != "host" || ws == null || k.isEmpty() || headers[HDR] != k || sock.inetAddress?.hostAddress != ws.address) return PeerServer.respond(out, 403)
        val p = path.substringBefore('?')
        when {
            p.startsWith("/peer/f/") -> {
                val id = Uri.decode(p.removePrefix("/peer/f/"))
                if (method == "PUT") {
                    val f = inFiles[id] ?: return PeerServer.respond(out, 404)
                    val ok = runCatching { receive(f, body) }.onFailure { Log.w("TwinDesk", "peer: receive ${f.name}: ${it.message}") }.isSuccess
                    if (ok) { work.execute { inFinish(f) }; PeerServer.respond(out, 200) } else { inFailed(id); PeerServer.respond(out, 500) }
                } else if (method == "GET") {
                    val f = outFiles[id] ?: return PeerServer.respond(out, 404)
                    PeerServer.streamHead(out, f.size)
                    try { pumpFile(f, out); out.flush() } catch (e: Exception) { outDone(id, false); throw e }
                    // f.done from the guest ends it
                } else PeerServer.respond(out, 400)
            }
            p == "/peer/screen" -> PeerScreen.http(this, method, body, out)
            else -> PeerServer.respond(out, 404)
        }
    }

    // For PeerScreen: the guest's HTTPS to us, with the key.
    fun guestRequest(path: String): Pair<okhttp3.OkHttpClient, Request.Builder>? {
        if (role != "guest") return null
        val (address, port) = link.endpoint() ?: return null
        val client = link.https() ?: return null
        val h = if (address.contains(':')) "[$address]" else address
        return client to Request.Builder().url("https://$h:$port$path").header(HDR, key)
    }

    companion object {
        const val HOSTS = "peerHosts"
        private const val GUESTS = "peerGuests"
        const val HDR = "x-twindesk-peer"
    }
}
