// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Everything the phone does, in one place: discovery, the link and the features on it. The
// foreground service (TwinService) keeps it alive; the UI reads it and bumps on `version`.
//
// When to connect: only when asked — the Mac's phone tile (an invite from a paired computer),
// Connect here, or Pair — and to resume a session that dropped by accident (for
// PHONE_GRACE_MS, while the Mac keeps the session for us). Never on our own otherwise, since
// connecting takes the Mac away from the computer it is paired with.
package com.twindesk.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

abstract class Feature(val core: Core) {
    open fun onWelcome(host: Host) {}
    open fun onClosed() {}
    // Return true when the message was this feature's.
    open fun onMessage(t: String, m: JSONObject): Boolean = false
}

class Core private constructor(val ctx: Context) : Link.Events {
    val store = Store(ctx)
    init { I18n.init(ctx, store) }
    val version = MutableStateFlow(0)
    val bg = Executors.newScheduledThreadPool(2) { r -> Thread(r, "td-core").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())

    val discovery = Discovery(ctx, { JSONObject().put("id", store.deviceId).put("name", store.deviceName) }, ::changed, ::onInvite)
    val link = Link(store, this)
    // Computers that aren't on this phone's network, through Bluetooth (Ble.kt).
    val ble = Ble(ctx, { JSONObject().put("id", store.deviceId).put("name", store.deviceName).put("os", Proto.OS) },
        { id -> store.hosts().any { it.id == id } }, ::changed, ::onInvite)
    val bleOn get() = store.flag("ble", true)
    val bleWifiOff get() = store.flag("bleWifiOff", true) // General's Turn off Bluetooth on Wi-Fi connections (bleTick)
    // … and PCs that connect to us: this phone advertises (BleServe.kt), as a PC's Bluetooth often can't.
    val serve = BleServe(ctx, { JSONObject().put("id", store.deviceId).put("name", store.deviceName).put("os", Proto.OS) }, ::changed, ::onServeOpen)
    init { link.bleRx = { maxOf(ble.lastDown, serve.lastRx) } }

    // An unpaired computer asked us to pair (shown until acted on).
    @Volatile var invite: Found? = null; private set
    // Resume: until when we try to get a dropped session back.
    @Volatile private var resumeUntil = 0L
    @Volatile private var resumeHost: Host? = null

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
    val input = Input(this)
    val drive = Drive(this)
    val screen = Screen(this)
    val macSound = MacSound(this)
    val shortcuts = Shortcuts(this)
    val kvm = Kvm(this)
    val remote = Remote(this) // this phone as the computer's touchpad, keyboard and gamepad (the Remote page)
    // …and as a Bluetooth gamepad for any computer: made only when it's on or the Remote page asks.
    private val btPadLazy = lazy { BtPad(this) }
    val btPad by btPadLazy
    val btPadMade: Boolean get() = btPadLazy.isInitialized()
    val updates = Updates(this)
    val net = Netlink(this)
    val hub = Hub(this) // Calls, Messages and Photos on the computer: nothing runs until one is on
    val share = FolderShare(this) // shared folders with the computer, both ways
    val sound = PhoneSound(this) // this phone's sound there without wireless debugging
    val mirror = PhoneMirror(this) // this phone's screen there without wireless debugging
    val shots = Screenshots(this) // screenshots both ways, onto the other clipboard
    val nowPlaying = NowPlaying(this) // what plays here, for the computer's media controls
    val rezume = Rezume(this) // ReZume: go on with what's in use on the other device (off until turned on)
    val dev = DevCtl(this) // this phone's controls on the computer's Overview, the computer's on the Computer page
    val appList = AppList(this) // the phone's apps, for the pages that pick some (Notifications, Banking apps)
    val bank = BankGuard(this) // a banking app opened: debugging off, and TwinDesk exits (General › Banking apps)
    val pcMedia = PcMedia(this) // what plays on the computer: the Media page and a media notification here
    // Connect with Android: another phone, on a session of its own beside the computer's (Peer.kt).
    // Not a Feature: the computer's messages never reach it, nor its the computer.
    val peer = Peer(this)
    private val features: List<Feature> = listOf(net, sync, clip, notifs, files, fclip, info, apps, wake, adb, pointer, input, drive, screen, macSound, shortcuts, kvm, remote, hub, share, sound, mirror, shots, nowPlaying, rezume, dev, pcMedia)

    val host: Host? get() = if (link.connected) link.host else null

    // Not after Exit (the notification's): Android brings the process back for the notification
    // listener or the Accessibility service, and nothing should start or show then. wake() (TwinService.start:
    // the app opened, the phone restarted, a cable) starts it again.
    private var started = false
    private fun start() {
        if (started || store.flag("exited", false)) return
        started = true
        discovery.start()
        runCatching { peer.start() }.onFailure { Log.e("TwinDesk", "peer", it) }
        Notify.channels(ctx)
        updates.start()
        if (store.flag("remote.btpad", false)) btPad.start()
        runCatching { bank.start() }.onFailure { Log.e("TwinDesk", "bank", it) }
        bg.scheduleWithFixedDelay({ runCatching { bleTick() }.onFailure { Log.e("TwinDesk", "ble", it) } }, 2, 2, TimeUnit.SECONDS)
        // Quiet links (Link.kt, shared/quiet.js, #143): what keeps the session pinging every second.
        // Clipboard, notifications and cursor sharing switched on don't: their messages go when
        // something happens, and a message makes the link active at once.
        link.keepPinging = performance
        link.busyHere = {
            screen.viewing || adb.viewed || remote.active || files.moving || mirror.wanted || sound.wanted || SoundService.running != null ||
                MainActivity.shown
        }
        // The screen came on or the phone was unlocked: look at the session now (a dead one is found
        // within seconds instead of at the next quiet ping).
        runCatching {
            ctx.registerReceiver(object : android.content.BroadcastReceiver() {
                override fun onReceive(c: Context, i: android.content.Intent) { link.wake() }
            }, android.content.IntentFilter().apply { addAction(android.content.Intent.ACTION_SCREEN_ON); addAction(android.content.Intent.ACTION_USER_PRESENT) })
        }
    }

    // General › Connections › Prioritize performance over battery life (off): on, the session pings
    // every second even when nothing is in use (as before); off, an idle one goes quiet.
    var performance: Boolean
        get() = store.flag("performance", false)
        set(on) { store.setFlag("performance", on); link.keepPinging = on; changed() }

    // General › Connections › Reconnect in the background (on): a session that dropped by accident is
    // taken up again with TwinDesk closed. Off: only once TwinDesk is opened (foreground()).
    // General › Tailscale (Tailnet.kt): on unless switched off.
    var tailscale: Boolean
        get() = store.flag("tailscale", true)
        set(on) { store.setFlag("tailscale", on); changed() }
    var reconnectBg: Boolean
        get() = store.flag("reconnectBg", true)
        set(on) { store.setFlag("reconnectBg", on); changed() }
    @Volatile private var resumeLater: Host? = null

    // MainActivity on screen: a session put off by Reconnect in the background, and a look at the
    // current one.
    fun foreground() {
        link.wake()
        val h = resumeLater ?: return
        resumeLater = null
        if (link.connected || link.state == "connecting" || link.pair != null || peer.connected) return
        val known = store.hosts().find { it.id == h.id } ?: return
        Log.i("TwinDesk", "opened: reconnecting to ${known.name}")
        bg.execute { connect(known) }
    }
    private fun inBackground() = !reconnectBg && !MainActivity.shown

    // Every 2 s: Bluetooth scans while it may be needed (not connected, or connected through it),
    // and a session through Bluetooth moves onto the network as soon as the computer is seen there
    // (the same Wi-Fi, or a group Netlink made). On the same Wi-Fi, with General's Turn off Bluetooth
    // on Wi-Fi connections on, Bluetooth goes altogether (its fallback, then its links): the Wi-Fi
    // dropping ends the session, which comes back over Bluetooth (resume). On a group Netlink made,
    // or a USB cable, it stays as the fallback.
    private val resumeTried = HashMap<String, Long>()
    private fun bleTick() {
        ble.prune()
        if (bleWifiOff && link.connected && net.via == "Wi-Fi") {
            link.dropAlt()
            ble.trim()
            serve.trim()
        }
        val want = bleOn && ble.allowed() && ble.radioOn && (!link.connected || link.ble)
        ble.scan(want)
        if (!bleOn && ble.found.isNotEmpty()) ble.stop()
        serve.advertise(bleOn && serve.allowed() && ble.radioOn && !link.connected && !peer.connected) // a phone holds the session: computers wait
        if (!bleOn && serve.found.isNotEmpty()) serve.stop()
        val h = link.host
        if (link.connected && !link.ble) screen.onWifi()
        if (h == null || !link.connected || !link.ble || link.resuming) return
        val f = discovery.found[h.id] ?: return
        val now = System.currentTimeMillis()
        if (now - (resumeTried[f.address] ?: 0) < 8000) return
        resumeTried[f.address] = now
        Log.i("TwinDesk", "${h.name} is on the network at ${f.address}: moving the session there")
        link.resume(f.address, f.port)
    }

    // Computers near: on the network, then the ones only Bluetooth sees.
    fun nearby(): List<Found> {
        val net = discovery.list()
        val near = net + ble.found.values.filter { b -> bleOn && net.none { it.id == b.id } }.sortedBy { it.name }
        return near + serve.found.values.filter { b -> bleOn && near.none { it.id == b.id } }.sortedBy { it.name }
    }

    fun isNear(id: String) = discovery.found.containsKey(id) || (bleOn && (ble.found.containsKey(id) || serve.found.containsKey(id)))

    // Wi-Fi out of power save while a screen streams either way, or the Remote is in use (power
    // save adds 50–200 ms bursts).
    private val wifiFast by lazy { WifiFast(ctx) }

    // General › Run in the background (on by default): connected with the app closed, and started with
    // the phone. Off: only while the app is open (swiping it away stops TwinDesk, as Exit does).
    var background: Boolean
        get() = store.flag("background", true)
        set(on) { store.setFlag("background", on); changed() }

    // General › Language: the pages redraw at once (tr() reads I18n.lang); the notification
    // channels' names and the status notification follow.
    fun setLanguage(code: String) {
        I18n.choose(code, store)
        Notify.channels(ctx)
        changed()
    }

    fun changed() {
        // (runCatching: discovery may report before every feature exists)
        runCatching { wifiFast.hold(link.connected && !link.wired && (screen.viewing || adb.viewed || remote.active)) }
        runCatching { link.nudge() } // a hold started or ended: the computer hears within a tick
        version.value++
        main.post { TwinService.refresh(ctx); if (started) bank.checkSoon() }
    }

    // Through Bluetooth, files wait for Wi-Fi (Netlink.holdOut).
    fun send(m: JSONObject): Boolean = net.holdOut(m) || link.send(m)

    fun hosts(): List<Host> = store.hosts()

    // The UI's Connect, or the Mac's invite: take the session.
    fun connect(h: Host) = connect(h, false)

    // skipNet: the network just failed to reach it (a stale address after the Wi-Fi went): Bluetooth first.
    private fun connect(h: Host, skipNet: Boolean) {
        resumeUntil = 0
        // The computer's screen, input and sound through ADB need wireless debugging: switch it on as
        // we connect (unless that computer said it doesn't use it: all through Native there).
        if (adb.canEnable && !adb.wifiDebugging && adb.neededBy(h)) adb.enable(true)
        val seen = if (skipNet) null else discovery.found[h.id]
        if (seen != null && (seen.address != h.address || seen.port != h.port)) {
            h.address = seen.address
            h.port = seen.port
            store.putHost(h)
        }
        // Not on this network but near: through Bluetooth (a PC's link to us first: blePipe).
        val viaBle = seen == null && bleOn && (serve.get(h.id) != null || ble.get(h.id) != null)
        triedNet = !viaBle
        if (viaBle) {
            bg.execute {
                val port = blePipe(h.id)
                if (port != null) link.connect(h, blePort = port)
                else if (h.address != "127.0.0.1") link.connect(h)
            }
            return
        }
        // Not seen on this network: every other Connect through Tailscale, when both are on it (#161).
        // The address is for this attempt only (a copy); discovery puts the network's back.
        if (seen == null && tailscale) {
            tailTurn = !tailTurn
            val t = Tailnet.address(h)
            if (tailTurn && t != null && t != h.address && Tailnet.onIt()) {
                Log.i("TwinDesk", "${h.name} isn’t on this network: through Tailscale")
                link.connect(h.copy(address = t))
                return
            }
        }
        link.connect(h)
    }
    @Volatile private var tailTurn = false

    // A PC opened a pipe on its own (its Pair or Connect, an invite): a paired one connects through
    // it now, an unpaired one is shown as an invite (Pair asks it for a pipe again).
    private fun onServeOpen(f: Found, port: Int): Boolean {
        val h = store.hosts().find { it.id == f.id }
        if (h == null || link.connected || link.state == "connecting" || link.pair != null || peer.connected) {
            if (h == null) onInvite(f.copy(invited = true))
            return false
        }
        Log.i("TwinDesk", "${f.name} opened a Bluetooth pipe: connecting")
        resumeUntil = 0
        link.connect(h, blePort = port)
        return true
    }

    // The computer found this device on a USB cable (adb reverse to its port, then a broadcast:
    // WiredReceiver): take the session through the cable, also from a Wi-Fi session with it. Not
    // paired with it yet: pair through the cable (no Wi-Fi needed), then the session follows.
    fun connectWired(id: String, port: Int, nonce: String, name: String) {
        if (peer.connected) { Log.i("TwinDesk", "USB: ${name.ifEmpty { id }} found, but another phone is connected"); return }
        val h = store.hosts().find { it.id == id }
        if (h == null) {
            if (link.pair != null && link.pair?.phase != "failed") { Log.i("TwinDesk", "USB: already pairing"); return }
            Log.i("TwinDesk", "USB: pairing with ${name.ifEmpty { id }} through the cable")
            resumeUntil = 0
            wiredNonce = nonce
            invite?.let { discovery.clearInvite(it.id) }
            invite = null
            link.startPairing("127.0.0.1", port, name.ifEmpty { "Computer" }, nonce)
            return
        }
        Log.i("TwinDesk", "USB: connecting to ${h.name} through the cable")
        resumeUntil = 0
        wiredNonce = nonce
        link.connect(h, port)
    }
    @Volatile private var wiredNonce = ""

    // The computer's pairing QR code, scanned here (QrActivity): the first of its addresses that
    // answers, then pairing with its nonce (only Allow there, as on the cable). A computer already
    // paired connects where discovery sees it or at its stored address; only when neither answers,
    // at the code's address for this one attempt, never stored: a browsable link can't re-point it,
    // and the session pins the computer's certificate, so another machine there fails.
    // false: none of them answers from this network.
    fun connectQr(id: String, addrs: List<String>, port: Int, nonce: String, name: String): Boolean {
        val answers = { a: String, p: Int ->
            runCatching { java.net.Socket().use { s -> s.connect(java.net.InetSocketAddress(a, p), 800) }; true }.getOrDefault(false)
        }
        resumeUntil = 0
        store.hosts().find { it.id == id }?.let { h ->
            val use = if (discovery.found[h.id] != null || answers(h.address, h.port)) h
                else addrs.firstOrNull { answers(it, port) }?.let { h.copy(address = it, port = port) } ?: h
            Log.i("TwinDesk", "QR: connecting to ${h.name}")
            connect(use)
            return true
        }
        val address = addrs.firstOrNull { answers(it, port) } ?: return false
        Log.i("TwinDesk", "QR: pairing with ${name.ifEmpty { id }} at $address")
        invite?.let { discovery.clearInvite(it.id) }
        invite = null
        link.startPairing(address, port, name.ifEmpty { "Computer" }, nonce, qr = true)
        return true
    }

    fun disconnect() {
        resumeUntil = 0
        link.disconnect()
    }

    // Another paired computer, while connected: this one is let go (bye), then that one.
    fun switchTo(h: Host) {
        disconnect()
        connect(h)
    }

    fun pair(f: Found) {
        invite = null
        discovery.clearInvite(f.id)
        if (f.address.startsWith("blp:") || f.address.startsWith("ble:")) {
            // Through Bluetooth: "Connecting…" at once (the pipe takes a few seconds), and why when it
            // doesn't open (it used to say nothing, so Pair looked dead).
            link.pairOpening(f.name)
            bg.execute {
                val port = blePipe(f.id)
                if (link.pair?.phase != "connecting" || link.pair?.port != 0) return@execute // cancelled meanwhile
                if (port != null) link.startPairing("127.0.0.1", port, f.name, viaBle = true)
                else link.pairUnreachable(tr("{name} didn’t answer over Bluetooth. Open TwinDesk on it, or put both on the same Wi-Fi, then Pair again.", "name" to f.name))
            }
            return
        }
        link.startPairing(f.address, f.port, f.name)
    }

    // A pipe to a computer near over Bluetooth: through the link a PC holds to us (BleServe) first,
    // as it is up already, else to the computer's own advertising (Ble), which a PC's Bluetooth
    // often can't keep up (it was tried first, and Pair failed in silence when it was stale).
    private fun blePipe(id: String): Int? =
        (if (serve.get(id) != null) serve.open(id) else null) ?: (if (ble.get(id) != null) ble.open(id) else null)

    fun pairAddress(address: String) = link.startPairing(address.trim(), Proto.PORT, address.trim())

    fun dismissInvite() {
        invite?.let { discovery.clearInvite(it.id) }
        invite = null
        changed()
    }

    fun forget(id: String) {
        if (link.host?.id == id) link.disconnect()
        store.forgetHost(id)
        changed()
    }

    private fun onInvite(f: Found) {
        val h = store.hosts().find { it.id == f.id }
        if (h != null) {
            // A phone holds the session (one at a time): the computer waits; Connect here takes it back.
            if (peer.connected) { Log.i("TwinDesk", "invite from ${f.name}: a phone holds the session"); return }
            Log.i("TwinDesk", "invite from ${f.name}: connecting")
            if (link.host?.id == h.id && (link.state == "connected" || link.state == "connecting")) return
            if (!f.address.startsWith("ble:") && !f.address.startsWith("blp:")) {
                h.address = f.address
                h.port = f.port
            }
            connect(h)
            return
        }
        if (link.pair != null) return
        invite = f
        Notify.invite(ctx, f.name)
        changed()
    }

    // ---- Link.Events ----

    override fun onChange() {
        runCatching { share.linkChanged() } // the session moved (Bluetooth <-> Wi-Fi): shared folders follow
        runCatching { remote.linkChanged() } // … and the Remote page's pace
        changed()
    }

    override fun onWelcome(host: Host) {
        Log.i("TwinDesk", "session with ${host.name}")
        resumeUntil = 0
        Notify.cancelInvite(ctx)
        // One session: a phone's ends (Peer.started ends ours the other way).
        if (peer.connected) { Log.i("TwinDesk", "ending the phone session for ${host.name}"); peer.disconnect() }
        // Tells the computer which of its USB devices this is (its screen and input use that one).
        if (link.wired) link.send(JSONObject().put("t", "phone.wired").put("nonce", wiredNonce))
        // Paired through the cable: its network address once discovery has seen it.
        val seen = discovery.found[host.id]
        if (host.address == "127.0.0.1" && seen != null) {
            host.address = seen.address
            host.port = seen.port
            store.putHost(host)
        }
        for (f in features) runCatching { f.onWelcome(host) }.onFailure { Log.e("TwinDesk", "welcome", it) }
        changed()
    }

    override fun onMessage(m: JSONObject) {
        val t = m.optString("t")
        main.post {
            for (f in features) {
                val mine = try { f.onMessage(t, m) } catch (e: Exception) { Log.e("TwinDesk", "message $t", e); true }
                if (mine) return@post
            }
        }
    }

    override fun onClosed(host: Host, code: String?) {
        main.post {
            for (f in features) runCatching { f.onClosed() }
            changed()
        }
        // Dropped by accident (not let go, replaced, forgotten or closed here): try to get it back.
        val accidental = code == null || code !in setOf("local", Proto.E.RELEASED, Proto.E.REPLACED, Proto.E.BAD_TOKEN, Proto.E.BUSY, Proto.E.ASLEEP)
        if (!accidental || link.state == "failed") return
        if (inBackground()) { resumeLater = host; Log.i("TwinDesk", "dropped in the background: reconnecting when TwinDesk opens"); return }
        if (resumeUntil == 0L) resumeUntil = System.currentTimeMillis() + Proto.PHONE_GRACE_MS
        resumeHost = host
        bg.schedule({ resume() }, 1500, TimeUnit.MILLISECONDS)
    }

    @Volatile private var triedNet = false

    private fun resume() {
        val h = resumeHost ?: return
        if (System.currentTimeMillis() > resumeUntil || link.connected || link.state == "connecting" || link.pair != null || peer.connected) return
        if (inBackground()) { resumeLater = h; return }
        Log.i("TwinDesk", "resuming the session with ${h.name}")
        val until = resumeUntil
        connect(store.hosts().find { it.id == h.id } ?: return, triedNet)
        resumeUntil = until // connect() clears it; keep the window open for the next drop
    }

    companion object {
        @Volatile private var instance: Core? = null
        fun get(ctx: Context): Core = instance ?: synchronized(this) {
            instance ?: Core(ctx.applicationContext).also { instance = it; it.start() }
        }

        fun wake(ctx: Context): Core = get(ctx).also { it.store.setFlag("exited", false); it.start() }
    }
}
