// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Wi-Fi for a session that runs through Bluetooth (the phone's side of shared/netlink.js, same
// messages and the same choice of who hosts): files and screens need more than Bluetooth carries,
// so this phone hosts a Wi-Fi Direct group the computer joins (a Mac), or joins the computer's
// (a PC's access point keeps its own Wi-Fi). Once both are on it, discovery sees the computer there
// and Core moves the session onto it (Link.resume). When neither side needs it any more it's
// taken down and the session carries on through Bluetooth.
//
// A Mac asks for the phone's own hotspot instead for the screen (net.hotspot): a notification
// opens the hotspot settings.
package com.twindesk.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

// Wi-Fi Direct: host a group (we're its owner) or join one by its name and passphrase.
@SuppressLint("MissingPermission") // allowed() is checked first
class Direct(private val ctx: Context) {
    private val mgr: WifiP2pManager? = ctx.getSystemService(WifiP2pManager::class.java)
    private val ch: WifiP2pManager.Channel? by lazy { mgr?.initialize(ctx, Looper.getMainLooper(), null) }

    companion object {
        fun permission(): String = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION
    }

    fun allowed() = ctx.checkSelfPermission(permission()) == PackageManager.PERMISSION_GRANTED
    fun supported() = mgr != null && ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)
    fun can() = supported() && allowed()

    private fun await(what: String, call: (WifiP2pManager.ActionListener) -> Unit): String? {
        val done = CountDownLatch(1)
        var err: String? = "timed out"
        call(object : WifiP2pManager.ActionListener {
            override fun onSuccess() { err = null; done.countDown() }
            override fun onFailure(reason: Int) {
                err = when (reason) { WifiP2pManager.P2P_UNSUPPORTED -> "not supported"; WifiP2pManager.BUSY -> "busy"; else -> "error $reason" }
                done.countDown()
            }
        })
        done.await(10, TimeUnit.SECONDS)
        if (err != null) Log.i("TwinDesk", "direct: $what: $err")
        return err
    }

    private fun groupUp(owner: Boolean): Boolean {
        val done = CountDownLatch(1)
        var ok = false
        val c = ch ?: return false
        mgr?.requestConnectionInfo(c) { info ->
            ok = info != null && info.groupFormed && info.isGroupOwner == owner
            done.countDown()
        }
        done.await(3, TimeUnit.SECONDS)
        return ok
    }

    private val wifi get() = ctx.applicationContext.getSystemService(android.net.wifi.WifiManager::class.java)

    // Wi-Fi off: Wi-Fi Direct can't work (Android answers "busy"). Ask the person to switch it on
    // (a notification, or the Wi-Fi panel if TwinDesk is open) and wait for it.
    private fun ensureWifi(name: String) {
        if (wifi?.isWifiEnabled == true) return
        Log.i("TwinDesk", "direct: Wi-Fi is off, asking for it")
        Notify.wifiOff(ctx, name)
        repeat(90) {
            if (wifi?.isWifiEnabled == true) { Notify.cancelWifiOff(ctx); Thread.sleep(1500); return } // P2P comes up a moment after Wi-Fi
            Thread.sleep(500)
        }
        Notify.cancelWifiOff(ctx)
        throw Exception("Wi-Fi is off on the phone")
    }

    // band2: the computer's Wi-Fi is 2.4 GHz only (net.caps {band5: false}): left on auto the group
    // often goes on 5 GHz, where it never sees it.
    private fun config(ssid: String, pass: String, band2: Boolean = false) = WifiP2pConfig.Builder()
        .setNetworkName(ssid).setPassphrase(pass).enablePersistentMode(false)
        .setGroupOperatingBand(if (band2) WifiP2pConfig.GROUP_OWNER_BAND_2GHZ else WifiP2pConfig.GROUP_OWNER_BAND_AUTO).build()

    // Blocking (a background thread): throws with why when it can't.
    fun host(ssid: String, pass: String, name: String = "The computer", band2: Boolean = false) {
        if (!can()) throw Exception(if (!supported()) "no Wi-Fi Direct" else "Nearby devices not allowed")
        ensureWifi(name)
        await("remove") { mgr!!.removeGroup(ch!!, it) }
        await("create") { mgr!!.createGroup(ch!!, config(ssid, pass, band2), it) }?.let { throw Exception(it) }
        repeat(30) { if (groupUp(true)) return; Thread.sleep(500) }
        throw Exception("the group didn’t start")
    }

    fun join(ssid: String, pass: String, name: String = "The computer") {
        if (!can()) throw Exception(if (!supported()) "no Wi-Fi Direct" else "Nearby devices not allowed")
        ensureWifi(name)
        await("remove") { mgr!!.removeGroup(ch!!, it) }
        await("connect") { mgr!!.connect(ch!!, config(ssid, pass), it) }?.let { throw Exception(it) }
        repeat(60) { if (groupUp(false)) return; Thread.sleep(500) }
        await("cancel") { mgr!!.cancelConnect(ch!!, it) }
        throw Exception("couldn’t join $ssid")
    }

    fun stop() {
        if (!can()) return
        await("remove") { mgr!!.removeGroup(ch!!, it) }
    }
}

class Netlink(core: Core) : Feature(core) {
    val direct = Direct(core.ctx)
    @Volatile var state = "idle"; private set // idle | asking | hosting | joining | joined | failed
    @Volatile var error = ""; private set
    @Volatile var hotspotAsked = false; private set
    private val needs = HashMap<String, Long>() // why -> idle ms (0 = until released)
    private val lastUse = HashMap<String, Long>()
    private val peerNeeds = HashSet<String>()
    private var peerCaps: JSONObject? = null
    private val held = ArrayList<JSONObject>()
    private var ssid = ""
    private var pass = ""
    private var linger: ScheduledFuture<*>? = null
    private var deadline: ScheduledFuture<*>? = null

    companion object {
        const val FILES_IDLE_MS = 20000L
        const val LINGER_MS = 15000L
        // Address ranges of the links made here: Wi-Fi Direct, a computer's access point, a hotspot (shared/netlink.js).
        val GROUP_NETS = listOf("192.168.49.", "10.42.", "192.168.137.", "192.168.43.", "172.20.10.")
        val HOLD = setOf(Proto.T.FILE_OFFER, Proto.T.DRAG_START)
    }

    private val onBle get() = core.link.connected && core.link.ble
    private fun hostOs() = core.host?.os ?: "mac"

    init {
        core.bg.scheduleWithFixedDelay({ tick() }, 1, 1, TimeUnit.SECONDS)
    }

    override fun onWelcome(host: Host) {
        synchronized(this) { peerCaps = null }
        if (!onBle) return
        core.link.send(msg(Proto.T.NET_CAPS, "host" to direct.can(), "join" to direct.can(), "hotspot" to true))
    }

    override fun onClosed() {
        synchronized(this) {
            needs.clear(); peerNeeds.clear(); peerCaps = null
            linger?.cancel(false); deadline?.cancel(false)
            flushLocked()
        }
        hotspotAsked = false
        Notify.cancelHotspot(core.ctx)
        down()
        set("idle", "")
    }

    // How the session runs, for the status lines: USB, Bluetooth, a Wi-Fi Direct link (or the
    // computer's hotspot) made for a file or a screen, which goes again by itself ("Temporary"), or
    // asked for with Connect with Wi-Fi Direct; else the same Wi-Fi network. A group that's up
    // beside a session on the real network doesn't count.
    val via: String get() {
        if (core.link.wired) return "USB"
        if (core.link.ble) return "Bluetooth"
        val onGroup = state in setOf("hosting", "joined") && GROUP_NETS.any { core.host?.address?.startsWith(it) == true }
        if (!onGroup) return "Wi-Fi"
        val name = if (hotspotAsked) "Hotspot" else "Wi-Fi Direct"
        val asked = synchronized(this) { "user" in needs || "user" in peerNeeds } || hotspotAsked
        return if (asked) name else "Temporary $name"
    }

    // On a link made here or there (for whatever reason): Back to Bluetooth can end it.
    val linked get() = state in setOf("hosting", "joining", "joined")

    // Back to Bluetooth here: what either side needed the link for ends now, on both.
    fun drop() {
        core.link.send(msg(Proto.T.NET_RELEASE, "why" to "", "all" to true))
        core.bg.execute { dropped() }
    }

    // Back to Bluetooth (here, or on the computer: net.release {all}): nobody needs the link any more.
    private fun dropped() {
        synchronized(this) {
            needs.clear(); peerNeeds.clear()
            linger?.cancel(false)
            flushLocked()
        }
        down()
        set("idle", "")
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t == Proto.T.FILE_CHUNK) { touch("files"); return false }
        when (t) {
            Proto.T.NET_CAPS -> synchronized(this) { peerCaps = m }
            Proto.T.NET_NEED -> {
                synchronized(this) { peerNeeds.add(m.optString("why", "files").take(20)); linger?.cancel(false) }
                when {
                    m.optBoolean("keep") && linked -> Unit // on the link already: only keep it up
                    state == "hosting" || state == "joined" && iHost() -> sendJoin()
                    plan() != "me" -> core.link.send(msg(Proto.T.NET_JOIN, "error" to "can’t host"))
                    else -> core.bg.execute { startHost() }
                }
            }
            Proto.T.NET_JOIN -> {
                val s = m.optString("ssid")
                if (m.has("error") || s.isEmpty()) fail("${core.host?.name ?: "The computer"} can’t host Wi-Fi")
                else core.bg.execute { join(s.take(32), m.optString("pass").take(63)) }
            }
            Proto.T.NET_JOINED -> if (!m.optBoolean("ok")) fail(m.optString("error").ifEmpty { "The computer couldn’t join" }.take(200))
            Proto.T.NET_RELEASE -> if (m.optBoolean("all")) dropped() else { synchronized(this) { peerNeeds.remove(m.optString("why")) }; maybeDown() }
            Proto.T.NET_HOTSPOT -> {
                hotspotAsked = m.optBoolean("on")
                if (hotspotAsked) Notify.hotspot(core.ctx, core.host?.name ?: "The computer") else Notify.cancelHotspot(core.ctx)
                core.changed()
            }
            else -> return false
        }
        return true
    }

    // Outgoing: files wait for Wi-Fi (sent through link once the session is on it, or failed).
    fun holdOut(m: JSONObject): Boolean {
        val t = m.optString("t")
        if (t == Proto.T.FILE_CHUNK) touch("files")
        synchronized(this) {
            if (t !in HOLD && !(held.isNotEmpty() && t.startsWith("file."))) return false
            if (!onBle || plan() == null) return false
            held.add(m)
            if (held.size > 1) return true
        }
        need("files", FILES_IDLE_MS)
        return true
    }

    fun need(why: String, idleMs: Long = 0) {
        if (!onBle) return
        val fresh: Boolean
        synchronized(this) {
            fresh = !needs.containsKey(why)
            needs[why] = idleMs
            lastUse[why] = System.currentTimeMillis()
            linger?.cancel(false)
        }
        if (fresh || state == "idle" || state == "failed") core.bg.execute { ensure(why) }
    }

    fun wanted(why: String) = synchronized(this) { needs.containsKey(why) }

    fun release(why: String) {
        synchronized(this) { if (needs.remove(why) == null) return }
        core.link.send(msg(Proto.T.NET_RELEASE, "why" to why))
        maybeDown()
    }

    fun touch(why: String) = synchronized(this) { if (needs.containsKey(why)) lastUse[why] = System.currentTimeMillis() }

    private fun plan(): String? {
        val them = peerCaps ?: return null
        val c = direct.can()
        val meHost = c && them.optBoolean("join")
        val peerHost = them.optBoolean("host") && c
        if (meHost && !peerHost) return "me"
        if (peerHost && !meHost) return "peer"
        if (!meHost) return null
        if (hostOs() == "win") return "peer" // a PC's access point keeps its own Wi-Fi up
        return "peer" // we're the guest: the session's host hosts
    }

    private fun iHost() = plan() == "me"

    private fun ensure(why: String) {
        if (state in setOf("asking", "hosting", "joining", "joined")) return
        val p = plan() ?: return fail("Neither side can host Wi-Fi")
        error = ""
        if (p == "me") return startHost()
        set("asking", "")
        armDeadline()
        core.link.send(msg(Proto.T.NET_NEED, "why" to why))
    }

    private fun startHost() {
        ssid = "DIRECT-TD-" + Proto.randomHex(3)
        pass = Proto.randomHex(10)
        set("hosting", "")
        armDeadline()
        try {
            val band2 = synchronized(this) { peerCaps?.optBoolean("band5", true) == false }
            direct.host(ssid, pass, core.host?.name ?: "The computer", band2)
        } catch (e: Exception) {
            core.link.send(msg(Proto.T.NET_JOIN, "error" to (e.message ?: "failed")))
            return fail("Couldn’t start Wi-Fi Direct: ${e.message}")
        }
        if (state == "hosting") sendJoin()
    }

    private fun sendJoin() = core.link.send(msg(Proto.T.NET_JOIN, "ssid" to ssid, "pass" to pass))

    private fun join(s: String, p: String) {
        ssid = s
        set("joining", "")
        armDeadline()
        try {
            direct.join(s, p, core.host?.name ?: "The computer")
        } catch (e: Exception) {
            core.link.send(msg(Proto.T.NET_JOINED, "ok" to false, "error" to (e.message ?: "failed")))
            return fail("Couldn’t join $s: ${e.message}")
        }
        core.link.send(msg(Proto.T.NET_JOINED, "ok" to true))
        set("joined", "")
    }

    private fun armDeadline() {
        deadline?.cancel(false)
        deadline = core.bg.schedule({ if (onBle && state != "idle") fail("Wi-Fi didn’t come up in time") }, 60, TimeUnit.SECONDS)
    }

    private fun fail(why: String) {
        Log.i("TwinDesk", "netlink: $why")
        synchronized(this) { needs.clear() }
        down()
        set("failed", why)
        flush()
    }

    private fun maybeDown() {
        synchronized(this) {
            if (needs.isNotEmpty() || peerNeeds.isNotEmpty() || state == "idle" || state == "failed") return
            linger?.cancel(false)
            linger = core.bg.schedule({
                synchronized(this) { if (needs.isNotEmpty() || peerNeeds.isNotEmpty()) return@schedule }
                down()
                set("idle", "")
            }, LINGER_MS, TimeUnit.MILLISECONDS)
        }
    }

    private fun down() {
        deadline?.cancel(false)
        if (state in setOf("hosting", "joining", "joined")) core.bg.execute { direct.stop() }
        ssid = ""
    }

    private fun flush() = synchronized(this) { flushLocked() }

    private fun flushLocked() {
        val list = ArrayList(held)
        held.clear()
        for (m in list) core.link.send(m)
    }

    private fun tick() {
        if (held.isNotEmpty() && !onBle && core.link.connected) { deadline?.cancel(false); flush() }
        val now = System.currentTimeMillis()
        val idle = synchronized(this) { needs.filter { (w, ms) -> ms > 0 && now - (lastUse[w] ?: now) > ms }.keys.toList() }
        for (w in idle) release(w)
    }

    private fun set(s: String, err: String) {
        state = s
        error = err
        core.changed()
    }
}
