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
    // Computers that aren't on this phone's network, through Bluetooth (Ble.kt).
    val ble = Ble(ctx, { JSONObject().put("id", store.deviceId).put("name", store.deviceName).put("os", Proto.OS) },
        { id -> store.hosts().any { it.id == id } }, ::changed, ::onInvite)
    val bleOn get() = store.flag("ble", true)
    val bleWifiOff get() = store.flag("bleWifiOff", true) // General's Turn off Bluetooth on Wi-Fi connections (bleTick)
    // … and PCs that connect to us: this phone advertises (BleServe.kt), as a PC's Bluetooth often can't.
    val serve = BleServe(ctx, { JSONObject().put("id", store.deviceId).put("name", store.deviceName).put("os", Proto.OS) }, ::changed, ::onServeOpen)
    init { links.bleRx = { maxOf(ble.lastDown, serve.lastRx) } } // a session through Bluetooth: its bytes are a sign of life

    // An unpaired computer asked us to pair (shown until acted on).
    @Volatile var invite: Found? = null; private set
    // The computer the user picked (or that drove us last); the features follow it while it is connected.
    @Volatile private var selectedId: String? = null
    // The computer the one-to-one features are attached to right now (null: none connected).
    @Volatile private var attachedId: String? = null
    // A computer the user picked in the selector while it was not connected: selected when it comes up.
    @Volatile private var pendingUse: String? = null
    // When each computer's session started: the most recent one is the fallback.
    private val since = ConcurrentHashMap<String, Long>()
    // What each computer says it is connected to (mesh.roster).
    private val rosters = ConcurrentHashMap<String, List<String>>()
    // … and who they are (mesh.roster `members`), so the phone can list the whole mesh (known()).
    private val members = MeshMembers(store.deviceId)
    // Join every device the mesh introduces (mesh.intro.grant), Settings: Join every device automatically.
    val meshAutoJoin get() = store.flag("meshAutoJoin", true)
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
    // The shared layout of the mesh: stored and relayed by the phone, never edited here (docs/mesh.md).
    val layout = LayoutFeature(this)
    val net = Netlink(this) // Wi-Fi for a session through Bluetooth (netlink.js)
    val input = Input(this)
    val hub = Hub(this) // Calls, Messages and Photos on the computer: nothing runs until one is on
    val share = FolderShare(this) // shared folders with the computer, both ways
    val sound = PhoneSound(this) // this phone's sound there without wireless debugging
    private val features: List<Feature> = listOf(net, sync, clip, notifs, files, fclip, info, apps, wake, adb, pointer, input, drive, screen, macSound, shortcuts, kvm, layout, hub, share, sound)

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
        bg.scheduleWithFixedDelay({ runCatching { bleTick() }.onFailure { RemoteLog.e("TwinDesk", "ble", it) } }, 2, 2, TimeUnit.SECONDS)
    }

    // Every 2 s: Bluetooth scans while it may be needed (no computer connected, or one connected
    // through it), and a session through Bluetooth moves onto the network as soon as the computer is
    // seen there (the same Wi-Fi, or a group Netlink made). On the same Wi-Fi, with General's Turn off
    // Bluetooth on Wi-Fi connections on, Bluetooth goes altogether: the Wi-Fi dropping ends the session,
    // which comes back over Bluetooth (dialDue). On a group Netlink made, or a USB cable, it stays.
    private val resumeTried = HashMap<String, Long>()
    private fun bleTick() {
        ble.prune()
        val l = link
        if (bleWifiOff && l.connected && net.via == "Wi-Fi") {
            l.dropAlt()
            ble.trim()
            serve.trim()
        }
        val want = bleOn && ble.allowed() && ble.radioOn && (!l.connected || l.ble)
        ble.scan(want)
        if (!bleOn && ble.found.isNotEmpty()) ble.stop()
        serve.advertise(bleOn && serve.allowed() && ble.radioOn && !l.connected)
        if (!bleOn && serve.found.isNotEmpty()) serve.stop()
        val h = l.host
        if (l.connected && !l.ble) screen.onWifi()
        if (h == null || !l.connected || !l.ble || l.resuming) return
        val f = discovery.found[h.id] ?: return
        val now = System.currentTimeMillis()
        if (now - (resumeTried[f.address] ?: 0) < 8000) return
        resumeTried[f.address] = now
        RemoteLog.i("TwinDesk", "${h.name} is on the network at ${f.address}: moving the session there")
        l.resume(f.address, f.port)
    }

    // Computers near: on the network, then the ones only Bluetooth sees.
    fun nearby(): List<Found> {
        val onNet = discovery.list()
        val near = onNet + ble.found.values.filter { b -> bleOn && onNet.none { it.id == b.id } }.sortedBy { it.name }
        return near + serve.found.values.filter { b -> bleOn && near.none { it.id == b.id } }.sortedBy { it.name }
    }

    fun isNear(id: String) = discovery.found.containsKey(id) || (bleOn && (ble.found.containsKey(id) || serve.found.containsKey(id)))

    // Wi-Fi out of power save while a screen streams either way (power save adds 50–200 ms bursts).
    private val wifiFast by lazy { WifiFast(ctx) }

    fun changed() {
        // (runCatching: discovery may report before every feature exists)
        runCatching { wifiFast.hold(link.connected && !link.wired && (screen.viewing || adb.viewed)) }
        version.value++
        main.post { TwinService.refresh(ctx) }
    }

    // To the attached computer (the one-to-one features).
    // Through Bluetooth, files wait for Wi-Fi (Netlink.holdOut).
    fun send(m: JSONObject): Boolean = net.holdOut(m) || link.send(m)

    fun sendTo(hostId: String, m: JSONObject): Boolean = links.existing(hostId)?.send(m) ?: false

    fun sendAll(m: JSONObject) {
        for (l in links.connectedLinks()) l.send(m)
    }

    fun hosts(): List<Host> = store.hosts()

    // Everyone in the mesh this phone knows of: the connected computers (direct) and the devices they
    // report (indirect, with the ids of the computers that report them). Mesh.kt MeshMembers.known().
    fun known(): List<Known> = members.known(links.connectedLinks().mapNotNull { l -> l.host?.let { Member(it.id, it.name, it.os) } })

    // The pool's view of the connected computers (Clip and Notifs): each gets the items where accept says so.
    fun poolPeers(accept: (String) -> Boolean): List<PoolPeer> = links.connectedLinks().map { l ->
        val id = l.hostId
        PoolPeer(id, l.mesh, true) { m -> accept(id) && l.send(m.toJson()) }
    }

    // The name of the computer an item started on (its origin), else the one it came from.
    fun nameOf(origin: String?, from: Host): String =
        origin?.let { o -> store.hosts().find { it.id == o }?.name } ?: from.name

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

    // Dial a paired computer, at the address discovery last saw for it; not on this network but near:
    // through Bluetooth (a PC's link to us first: blePipe). skipNet: the network just failed to reach
    // it (a stale address after the Wi-Fi went): Bluetooth first.
    private fun dial(h: Host, skipNet: Boolean = false) {
        val seen = if (skipNet) null else discovery.found[h.id]
        if (seen != null && (seen.address != h.address || seen.port != h.port)) {
            h.address = seen.address
            h.port = seen.port
            store.putHost(h)
        }
        val l = links.linkFor(h.id)
        val viaBle = seen == null && bleOn && (serve.get(h.id) != null || ble.get(h.id) != null)
        if (viaBle) {
            bg.execute {
                val port = blePipe(h.id)
                if (port != null) l.connect(h, blePort = port)
                else if (h.address != "127.0.0.1") l.connect(h)
            }
            return
        }
        l.connect(h)
    }

    // A PC opened a pipe on its own (its Pair or Connect, an invite): a paired one connects through
    // it now, an unpaired one is shown as an invite (Pair asks it for a pipe again).
    private fun onServeOpen(f: Found, port: Int): Boolean {
        val h = store.hosts().find { it.id == f.id }
        if (h == null || links.existing(f.id)?.let { it.connected || it.state == "connecting" } == true) {
            if (h == null) onInvite(f.copy(invited = true))
            return false
        }
        RemoteLog.i("TwinDesk", "${f.name} opened a Bluetooth pipe: connecting")
        links.resume(f.id)
        links.linkFor(f.id).connect(h, blePort = port)
        return true
    }

    // A pipe to a computer near over Bluetooth: through the link a PC holds to us (BleServe) first,
    // as it is up already, else to the computer's own advertising (Ble), which a PC's Bluetooth
    // often can't keep up (it was tried first, and Pair failed in silence when it was stale).
    private fun blePipe(id: String): Int? =
        (if (serve.get(id) != null) serve.open(id) else null) ?: (if (ble.get(id) != null) ble.open(id) else null)

    // Another paired computer, while connected: this one is let go (bye), then that one.
    fun switchTo(h: Host) {
        disconnect()
        connect(h)
    }

    // Every beacon period: the paired computers that discovery sees and that are due for a dial.
    private fun dialDue() {
        for (h in links.due(System.currentTimeMillis()) { discovery.found.containsKey(it) }) dial(h)
    }

    // The computer found this device on a USB cable (adb reverse to its port, then a broadcast:
    // WiredReceiver): take the session through the cable, also from a Wi-Fi session with it.
    fun connectWired(id: String, port: Int, nonce: String, name: String = "") {
        val h = store.hosts().find { it.id == id }
        if (h == null) {
            // Not paired yet: pair through the cable (no Wi-Fi needed), then the session follows.
            if (pairLink.pair != null && pairLink.pair?.phase != "failed") { RemoteLog.i("TwinDesk", "USB: already pairing"); return }
            RemoteLog.i("TwinDesk", "USB: pairing with ${name.ifEmpty { id }} through the cable")
            wiredNonce = nonce
            invite?.let { discovery.clearInvite(it.id) }
            invite = null
            pairLink.startPairing("127.0.0.1", port, name.ifEmpty { "Computer" }, nonce)
            return
        }
        RemoteLog.i("TwinDesk", "USB: connecting to ${h.name} through the cable")
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
        if (f.address.startsWith("blp:") || f.address.startsWith("ble:")) {
            // Through Bluetooth: "Connecting…" at once (the pipe takes a few seconds), and why when it
            // doesn't open (it used to say nothing, so Pair looked dead).
            pairLink.pairOpening(f.name)
            bg.execute {
                val port = blePipe(f.id)
                if (pairLink.pair?.phase != "connecting" || pairLink.pair?.port != 0) return@execute // cancelled meanwhile
                if (port != null) pairLink.startPairing("127.0.0.1", port, f.name, viaBle = true)
                else pairLink.pairUnreachable("${f.name} didn’t answer over Bluetooth. Open TwinDesk on it, or put both on the same Wi-Fi, then Pair again.")
            }
            return
        }
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
        members.remove(id)
        attach()
        changed()
    }

    private fun onInvite(f: Found) {
        val h = store.hosts().find { it.id == f.id }
        if (h != null) {
            RemoteLog.i("TwinDesk", "invite from ${f.name}: connecting")
            if (links.existing(h.id)?.let { it.connected || it.state == "connecting" } == true) return
            if (!f.address.startsWith("ble:") && !f.address.startsWith("blp:")) {
                h.address = f.address
                h.port = f.port
            }
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

    // The header's computer selector (Selector.kt): every paired computer with its session state.
    fun pcEntries(): List<PcEntry> = store.hosts().map { h ->
        val l = links.existing(h.id)
        val up = l != null && l.connected
        PcEntry(
            h.id, h.name, h.os,
            when { up -> "connected"; l != null && l.state == "connecting" -> "connecting"; else -> "offline" },
            if (!up) "" else if (l?.wired == true) "usb" else if (l?.ble == true) "ble" else "ip",
            isNear(h.id),
        )
    }

    fun pcSelector(): PcSelector = PcSelect.build(pcEntries(), host?.id)

    // The selector's choice: a connected computer is selected at once; a paired one that is not
    // connected is dialled and selected as soon as its session is up.
    fun choose(c: PcChoice) {
        when (c.action) {
            PcAction.USE -> select(c.id)
            PcAction.CONNECT -> store.hosts().find { it.id == c.id }?.let { pendingUse = it.id; connect(it) }
            PcAction.NONE -> Unit
        }
    }

    // The attached computer: the selected one while it is connected, else the most recently connected.
    // When it changes, the one-to-one features get onClosed for the old one and onWelcome for the new
    // one, on the main thread.
    @Synchronized private fun attach() {
        val want = PcSelect.pickAttached(selectedId, links.connectedLinks().map { it.hostId }, since)
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

    // The driver of this phone changed (Kvm): the attached computer and the busy flags follow.
    fun driverChanged() = attach()

    // Quick keep-alive for the attached computer and for the one driving this phone (Mesh.kt keepalive).
    private fun refreshBusy(attached: String?) {
        val driver = kvm.driverId
        for (l in links.all()) l.busy = l.hostId.isNotEmpty() && (l.hostId == attached || l.hostId == driver)
    }

    // ---- Link.Events ----

    override fun onChange() {
        runCatching { share.linkChanged() } // the session moved (Bluetooth <-> Wi-Fi): shared folders follow
        changed()
    }

    override fun onWelcome(from: Link, host: Host) {
        RemoteLog.i("TwinDesk", "session with ${host.name}")
        Notify.cancelInvite(ctx)
        links.welcomed(host.id)
        since[host.id] = System.currentTimeMillis()
        // Tells the computer which of its USB devices this is (its screen and input use that one).
        if (from.wired) from.send(JSONObject().put("t", "phone.wired").put("nonce", wiredNonce))
        for (f in features) runCatching { f.onPeerWelcome(host) }.onFailure { RemoteLog.e("TwinDesk", "peer welcome", it) }
        if (pendingUse == host.id) { selectedId = host.id; pendingUse = null }
        else if (selectedId?.let { links.existing(it)?.connected == true } != true) selectedId = host.id
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
            if (from.connected) members.set(host.id, m.rosterMembers())
            changed()
            return
        }
        if (t == Intro.ASK) {
            // A phone cannot listen, so it cannot host a pairing for anyone: say so (docs/mesh.md).
            if (from.connected && from.mesh && Intro.validAsk(m.toPlainMap())) {
                from.send(msg(Intro.REPLY, "req" to m.optString("req"), "for" to m.optString("for"), "ok" to false, "error" to "cannot host"))
            }
            return
        }
        if (t == Intro.GRANT) {
            onGrant(from, m)
            return
        }
        // A computer taking or letting go of the phone's mouse and keyboard, from any computer.
        if (t == Proto.T.KVM_TAKE || t == Proto.T.KVM_RELEASE || t == Proto.T.KVM_HOME) {
            kvm.onDriver(t, host)
            return
        }
        // The one-to-one features hear the attached computer only; the pooled types from every computer.
        if (host.id != attachedId && t !in POOLED_TYPES && t !in FROM_ANY_COMPUTER) return
        main.post {
            for (f in features) {
                val mine = try { f.onMessage(t, m, host) } catch (e: Exception) { RemoteLog.e("TwinDesk", "message $t", e); true }
                if (mine) return@post
            }
        }
    }

    override fun onClosed(from: Link, host: Host, code: String?) {
        links.closed(host.id, code, System.currentTimeMillis())
        rosters.remove(host.id)
        members.remove(host.id)
        for (f in features) runCatching { f.onPeerClosed(host) }
        attach()
        broadcastRoster()
        changed()
    }

    // Our direct links, to every connected computer that takes the mesh (docs/mesh.md).
    private fun broadcastRoster() {
        val ids = links.connectedLinks().map { it.hostId }
        val own = links.connectedLinks().mapNotNull { l -> l.host?.let { Member(it.id, it.name, it.os).toJson() } }
        for (l in links.connectedLinks()) {
            if (l.mesh) l.send(msg(Proto.T.MESH_ROSTER, "peers" to jsonArray(ids), "members" to jsonArray(own)))
        }
    }

    // mesh.intro.grant (shared/intro.js): a connected computer introduces another one. Stored like a
    // finished pairing (Link.onPairOk), then dialled; ignored when it is a duplicate, when the registry
    // is full, or when Join every device automatically is off.
    private fun onGrant(from: Link, m: JSONObject) {
        if (!from.connected || !from.mesh || !meshAutoJoin) return
        val g = Intro.granted(m.toPlainMap()) ?: return
        if (g.id == store.deviceId) return
        val have = store.hosts()
        if (have.any { it.id == g.id } || have.size >= Proto.MAX_DEVICES) return
        RemoteLog.i("TwinDesk", "${from.host?.name} introduced ${g.name}: joining it")
        val h = Host(g.id, g.name, g.os, g.address, g.port, g.fp, g.token, System.currentTimeMillis())
        store.putHost(h)
        links.resume(h.id)
        dial(h)
        changed()
    }

    companion object {
        // Message types a computer that is not the attached one may send: the pooled ones (clipboard,
        // notifications, layout) and the policy switches that go with them.
        // What every computer sends the phone for its own adb bridge (the pointer overlay, the bridge state, the app list), attached or not.
        private val FROM_ANY_COMPUTER = setOf(Proto.T.PHONE_POINTER, Proto.T.ADB_BRIDGE, Proto.T.PHONE_APPS_LIST)
        private val POOLED_TYPES = setOf(Proto.T.LAYOUT, Proto.T.CLIP, Proto.T.CLIP_POLICY, Proto.T.NOTIF, Proto.T.NOTIF_POLICY)
        @Volatile private var instance: Core? = null
        fun get(ctx: Context): Core = instance ?: synchronized(this) {
            instance ?: Core(ctx.applicationContext).also { instance = it; it.start() }
        }
    }
}
