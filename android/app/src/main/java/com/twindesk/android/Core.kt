// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Everything the phone does, in one place: discovery, the sessions and the features on them. The
// foreground service (TwinService) keeps it alive; the UI reads it and bumps on `version`.
//
// Several computers at once (docs/mesh.md): the phone dials every paired computer (LinkManager) and
// stays connected to all of them. The one-to-one features (screen, files, apps, pointer, …) talk to
// the attached computer: the one the user picked or that drives this phone (kvm.take), else the most
// recently connected. The pooled features (clipboard, notifications) talk to all of them.
package com.twindesk.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

abstract class Feature(val core: Core) {
    // The attached computer is now this one: one-to-one features start clean.
    open fun onWelcome(host: Host) {}
    // The attached computer went away, or the phone switched to another one.
    open fun onClosed() {}
    // Any computer connected or disconnected (the pooled features keep their state per computer).
    open fun onPeerWelcome(host: Host) {}
    open fun onPeerClosed(host: Host) {}
    // Return true when the message was this feature's.
    open fun onMessage(t: String, m: JSONObject): Boolean = false
    // host: the computer the message came from.
    open fun onMessage(t: String, m: JSONObject, host: Host): Boolean = onMessage(t, m)
}

class Core private constructor(val ctx: Context) : Link.Events {
    val store = Store(ctx)
    val version = MutableStateFlow(0)
    val bg = Executors.newScheduledThreadPool(2) { r -> Thread(r, "td-core").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())

    val discovery = Discovery(ctx, { JSONObject().put("id", store.deviceId).put("name", store.deviceName) }, ::changed, ::onInvite)
    // One session per paired computer.
    val links = LinkManager(store, this)
    // Pairing has a socket of its own until the computer is paired.
    val pairLink = Link(store, this)
    private val idle = Link(store, this) // what the one-to-one features see when no computer is attached

    // An unpaired computer asked us to pair (shown until acted on).
    @Volatile var invite: Found? = null; private set
    // The computer the user picked (or that drove us last); the features follow it while it is connected.
    @Volatile private var selectedId: String? = null
    // The computer the one-to-one features are attached to right now (null: none connected).
    @Volatile private var attachedId: String? = null
    // When each computer's session started: the most recent one is the fallback.
    private val since = ConcurrentHashMap<String, Long>()
    // What each computer says it is connected to (mesh.roster).
    private val rosters = ConcurrentHashMap<String, List<String>>()
    @Volatile private var wiredNonce = ""

    val sync = PairSync(this)
    val clip = Clip(this)
    val notifs = Notifs(this)
    val files = Files(this)
    val fclip = FileClip(this)
    val info = PhoneInfo(this)
    val apps = Apps(this)
    val wake = Wake(this)
    val adb = Adb(this)
    val pointer = Pointer(this)
    val drive = Drive(this)
    val screen = Screen(this)
    val macSound = MacSound(this)
    val shortcuts = Shortcuts(this)
    val kvm = Kvm(this)
    val updates = Updates(this)
    private val features: List<Feature> = listOf(sync, clip, notifs, files, fclip, info, apps, wake, adb, pointer, drive, screen, macSound, shortcuts, kvm)

    // The link of the attached computer (idle when none is connected) and the computer behind it.
    val link: Link get() = attachedId?.let { links.existing(it) } ?: idle
    val host: Host? get() = if (link.connected) link.host else null

    fun start() {
        discovery.start()
        Notify.channels(ctx)
        updates.start()
        // The phone connects to every paired computer on its own: all of them on start, then the
        // ones discovery sees (dialDue, with the backoff of each link).
        for (h in store.hosts()) dial(h)
        bg.scheduleWithFixedDelay({ dialDue() }, Proto.BEACON_MS, Proto.BEACON_MS, TimeUnit.MILLISECONDS)
    }

    // Wi-Fi out of power save while a screen streams either way (power save adds 50–200 ms bursts).
    private val wifiFast by lazy { WifiFast(ctx) }

    fun changed() {
        // (runCatching: discovery may report before every feature exists)
        runCatching { wifiFast.hold(link.connected && !link.wired && (screen.viewing || adb.viewed)) }
        version.value++
        main.post { TwinService.refresh(ctx) }
    }

    // To the attached computer (the one-to-one features).
    fun send(m: JSONObject): Boolean = link.send(m)

    fun sendTo(hostId: String, m: JSONObject): Boolean = links.existing(hostId)?.send(m) ?: false

    fun sendAll(m: JSONObject) {
        for (l in links.connectedLinks()) l.send(m)
    }

    fun hosts(): List<Host> = store.hosts()

    // What the computers list says about a paired computer.
    fun stateOf(h: Host): String {
        val l = links.existing(h.id)
        return when {
            l != null && l.connected -> if (l.wired) "Connected over USB" else "Connected"
            l != null && l.state == "connecting" -> "Connecting…"
            else -> "Last address ${h.address}"
        }
    }

    // The user connects a paired computer (or an invite brings it): wireless debugging on, dial it.
    fun connect(h: Host) {
        // The Mac's screen, input and sound need wireless debugging: switch it on as we connect.
        if (adb.canEnable && !adb.wifiDebugging) adb.enable(true)
        links.resume(h.id)
        dial(h)
    }

    // Dial a paired computer, at the address discovery last saw for it.
    private fun dial(h: Host) {
        val seen = discovery.found[h.id]
        if (seen != null && (seen.address != h.address || seen.port != h.port)) {
            h.address = seen.address
            h.port = seen.port
            store.putHost(h)
        }
        links.linkFor(h.id).connect(h)
    }

    // Every beacon period: the paired computers that discovery sees and that are due for a dial.
    private fun dialDue() {
        for (h in links.due(System.currentTimeMillis()) { discovery.found.containsKey(it) }) dial(h)
    }

    // The computer found this device on a USB cable (adb reverse to its port, then a broadcast:
    // WiredReceiver): take the session through the cable, also from a Wi-Fi session with it.
    fun connectWired(id: String, port: Int, nonce: String) {
        val h = store.hosts().find { it.id == id }
        if (h == null) { Log.i("TwinDesk", "USB: $id isn't paired here"); return }
        Log.i("TwinDesk", "USB: connecting to ${h.name} through the cable")
        wiredNonce = nonce
        links.resume(id)
        links.linkFor(id).connect(h, port)
    }

    // The Disconnect button: the attached computer lets go. It is not dialled again until the user
    // connects it.
    fun disconnect() {
        val l = link
        if (l.hostId.isEmpty()) return
        links.pause(l.hostId)
        l.disconnect()
    }

    fun pair(f: Found) {
        invite = null
        discovery.clearInvite(f.id)
        pairLink.startPairing(f.address, f.port, f.name)
    }

    fun pairAddress(address: String) = pairLink.startPairing(address.trim(), Proto.PORT, address.trim())

    fun dismissInvite() {
        invite?.let { discovery.clearInvite(it.id) }
        invite = null
        changed()
    }

    fun forget(id: String) {
        links.forget(id)
        store.forgetHost(id)
        rosters.remove(id)
        attach()
        changed()
    }

    private fun onInvite(f: Found) {
        val h = store.hosts().find { it.id == f.id }
        if (h != null) {
            Log.i("TwinDesk", "invite from ${f.name}: connecting")
            if (links.existing(h.id)?.let { it.connected || it.state == "connecting" } == true) return
            h.address = f.address
            h.port = f.port
            connect(h)
            return
        }
        if (pairLink.pair != null) return
        invite = f
        Notify.invite(ctx, f.name)
        changed()
    }

    // The one-to-one features follow this computer (kvm.take, or the user's pick).
    @Synchronized fun select(hostId: String) {
        selectedId = hostId
        attach()
    }

    // The attached computer: the selected one while it is connected, else the most recently connected.
    // When it changes, the one-to-one features get onClosed for the old one and onWelcome for the new
    // one, on the main thread.
    @Synchronized private fun attach() {
        val want = selectedId?.takeIf { links.existing(it)?.connected == true }
            ?: links.connectedLinks().maxByOrNull { since[it.hostId] ?: 0L }?.hostId
        refreshBusy(want)
        if (want == attachedId) return
        val old = attachedId
        attachedId = want
        val h = want?.let { links.existing(it)?.host }
        main.post {
            if (old != null) for (f in features) runCatching { f.onClosed() }
            if (h != null) for (f in features) runCatching { f.onWelcome(h) }
        }
    }

    // Quick keep-alive for the link of the attached computer (Mesh.kt keepalive); the others are idle.
    private fun refreshBusy(attached: String?) {
        for (l in links.all()) l.busy = l.hostId.isNotEmpty() && l.hostId == attached
    }

    // ---- Link.Events ----

    override fun onChange() = changed()

    override fun onWelcome(from: Link, host: Host) {
        Log.i("TwinDesk", "session with ${host.name}")
        Notify.cancelInvite(ctx)
        links.welcomed(host.id)
        since[host.id] = System.currentTimeMillis()
        // Tells the computer which of its USB devices this is (its screen and input use that one).
        if (from.wired) from.send(JSONObject().put("t", "phone.wired").put("nonce", wiredNonce))
        for (f in features) runCatching { f.onPeerWelcome(host) }.onFailure { Log.e("TwinDesk", "peer welcome", it) }
        if (selectedId?.let { links.existing(it)?.connected == true } != true) selectedId = host.id
        attach()
        broadcastRoster()
        changed()
    }

    override fun onPaired(from: Link, host: Host) {
        // The pairing socket is done: the computer gets a session of its own.
        from.disconnect()
        links.resume(host.id)
        links.linkFor(host.id).connect(host)
    }

    override fun onMessage(from: Link, m: JSONObject) {
        val host = from.host ?: return
        val t = m.optString("t")
        if (t == Proto.T.MESH_ROSTER) {
            rosters[host.id] = m.optJSONArray("peers")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
            return
        }
        // The one-to-one features hear the attached computer only.
        if (host.id != attachedId) return
        main.post {
            for (f in features) {
                val mine = try { f.onMessage(t, m, host) } catch (e: Exception) { Log.e("TwinDesk", "message $t", e); true }
                if (mine) return@post
            }
        }
    }

    override fun onClosed(from: Link, host: Host, code: String?) {
        links.closed(host.id, code, System.currentTimeMillis())
        rosters.remove(host.id)
        for (f in features) runCatching { f.onPeerClosed(host) }
        attach()
        broadcastRoster()
        changed()
    }

    // Our direct links, to every connected computer that takes the mesh (docs/mesh.md).
    private fun broadcastRoster() {
        val ids = links.connectedLinks().map { it.hostId }
        for (l in links.connectedLinks()) {
            if (l.mesh) l.send(msg(Proto.T.MESH_ROSTER, "peers" to jsonArray(ids)))
        }
    }

    companion object {
        @Volatile private var instance: Core? = null
        fun get(ctx: Context): Core = instance ?: synchronized(this) {
            instance ?: Core(ctx.applicationContext).also { instance = it; it.start() }
        }
    }
}
