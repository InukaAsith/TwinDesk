// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Discovery on UDP DISCOVERY_PORT, as on the computers: beacons to every broadcast address (we are a
// guest: role 'guest'), answers probes, and keeps the computers nearby. A Mac's invite (its phone
// tile was clicked, or Pair) arrives here too.
//
// With the screen off the multicast lock goes and beacons slow down: held, it lets every
// broadcast on the Wi-Fi (ARP, mDNS, SSDP…) wake the phone, all day. Invites and probes sent to
// our own address are unicast and still arrive; the computers' broadcasts wait for the screen.
package com.twindesk.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.concurrent.thread

// Screen off: two beacons per DEVICE_STALE_MS, so a computer keeps listing us while we're awake.
private const val BEACON_SCREEN_OFF_MS = 5000L
// A packet's handling that takes this long is stuck: its stack goes to the log, and a new worker
// takes the packets after it.
private const val STUCK_MS = 5000L

data class Found(
    val id: String,
    val name: String,
    val os: String,
    val address: String,
    val port: Int,
    val fp: String,
    val lastSeen: Long,
    val invited: Boolean,
)

class Discovery(
    private val ctx: Context,
    private val self: () -> JSONObject, // {id, name}
    private val onChange: () -> Unit,
    private val onInvite: (Found) -> Unit,
) {
    val found = ConcurrentHashMap<String, Found>()
    // Other phones with TwinDesk (their beacon's `ap`, Peer.kt): port is their phone server's, 0 while
    // they don't host one. Kept apart from `found`, which is only computers.
    val phones = ConcurrentHashMap<String, Found>()
    @Volatile var peerPort = 0 // ours, in our beacon as `phost` while we host
    // Connect with Android on (Peer.kt): our beacon says `ap` (every phone app lists only a phone that
    // does), and other phones are listed and heard. Off: phones don't see this one at all.
    @Volatile var peerOn = false
    @Volatile var onPeerAsk: ((Found, JSONObject) -> Unit)? = null // another phone's peer.* (Peer.kt)
    @Volatile var error = ""
    @Volatile private var sock: DatagramSocket? = null
    @Volatile private var running = false
    private var lock: WifiManager.MulticastLock? = null
    @Volatile private var screenOn = true
    private var screenWatch: BroadcastReceiver? = null

    // Each packet is handled on the worker, never on the thread reading the socket: a handler that
    // blocked (an invite's connect, a lock held elsewhere) stopped the reading, and every beacon,
    // probe and invite after it was dropped by the kernel. The phone looked gone to the computers,
    // and clicking it there did nothing, until the app started again.
    private class Worker {
        @Volatile var busySince = 0L
        @Volatile var thread: Thread? = null
        val exec: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "td-discovery-work").apply { isDaemon = true; thread = this } }
    }
    @Volatile private var worker = Worker()

    private fun dispatch(block: () -> Unit) {
        val w = worker
        val since = w.busySince
        if (since != 0L && System.currentTimeMillis() - since > STUCK_MS) {
            val where = w.thread?.stackTrace?.joinToString("\n  at ") ?: "?"
            Log.w("TwinDesk", "discovery: a packet's handling is stuck (${System.currentTimeMillis() - since} ms), going on without it:\n  at $where")
            w.exec.shutdownNow()
            worker = Worker()
        }
        val now = worker
        now.exec.execute {
            now.busySince = System.currentTimeMillis()
            try { block() } catch (e: Exception) { Log.w("TwinDesk", "discovery: ${e.message}") } finally { now.busySince = 0L }
        }
    }

    fun start() {
        if (running) return
        running = true
        // Some phones drop broadcast packets for apps without this (held only while the screen is on).
        lock = (ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .createMulticastLock("twindesk").apply { setReferenceCounted(false) }
        screen(ctx.getSystemService(PowerManager::class.java)?.isInteractive != false)
        screenWatch = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                screen(i.action == Intent.ACTION_SCREEN_ON)
                // Back in every computer's list at once, and theirs in ours (off the main thread).
                if (screenOn) thread(name = "td-wake", isDaemon = true) { beacon(); probe() }
            }
        }.also { ctx.registerReceiver(it, IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF) }) }
        thread(name = "td-discovery", isDaemon = true) { receiveLoop() }
        thread(name = "td-beacon", isDaemon = true) {
            while (running) {
                beacon()
                prune()
                Thread.sleep(if (screenOn) Proto.BEACON_MS else BEACON_SCREEN_OFF_MS)
            }
        }
    }

    fun stop() {
        running = false
        screenWatch?.let { runCatching { ctx.unregisterReceiver(it) } }
        screenWatch = null
        sock?.close()
        sock = null
        runCatching { lock?.release() }
    }

    @Synchronized private fun screen(on: Boolean) {
        screenOn = on
        runCatching { if (on) lock?.acquire() else lock?.release() }
    }

    fun list(): List<Found> = found.values.sortedWith(compareByDescending<Found> { it.invited }.thenBy { it.name })

    private fun beaconMsg(): JSONObject = self().put("t", Proto.T.BEACON).put("v", Proto.VERSION).put("os", Proto.OS)
        .put("role", "guest").put("port", Proto.PORT).put("fp", "")
        .apply { if (peerOn) { put("ap", 1); if (peerPort > 0) put("phost", peerPort) } } // a phone for other phones (computers ignore both)

    // A packet to one address (Peer.kt's peer.ask to another phone).
    fun sendTo(m: JSONObject, address: String) = send(m, address)

    fun probe(address: String? = null) {
        val m = JSONObject().put("t", Proto.T.PROBE).put("v", Proto.VERSION).put("id", self().getString("id"))
        if (address != null) send(m, address) else targets().forEach { send(m, it) }
    }

    fun beacon() {
        val m = beaconMsg()
        for (t in targets()) send(m, t)
    }

    fun clearInvite(id: String) {
        found[id]?.let { if (it.invited) { found[id] = it.copy(invited = false); onChange() } }
    }

    private fun targets(): Set<String> {
        val out = mutableSetOf("255.255.255.255")
        runCatching {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in ni.interfaceAddresses) {
                    val b = ia.broadcast
                    if (ia.address is Inet4Address && b != null) out.add(b.hostAddress!!)
                }
            }
        }
        // A computer on this phone's hotspot gets the hotspot's broadcast above. (Not /proc/net/arp:
        // Android 10 and later, all this app runs on, don't let apps read it.)
        return out
    }

    private fun send(m: JSONObject, address: String, port: Int = Proto.DISCOVERY_PORT) {
        val s = sock ?: return
        runCatching {
            val b = m.toString().toByteArray()
            s.send(DatagramPacket(b, b.size, InetAddress.getByName(address), port))
        }
    }

    private fun receiveLoop() {
        while (running) {
            try {
                val s = DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(InetSocketAddress(Proto.DISCOVERY_PORT))
                }
                sock = s
                error = ""
                onChange()
                beacon()
                probe()
                val buf = ByteArray(4096)
                while (running) {
                    val p = DatagramPacket(buf, buf.size)
                    s.receive(p)
                    val text = String(p.data, 0, p.length)
                    val from = p.address.hostAddress ?: continue
                    val port = p.port
                    dispatch { handle(text, from, port) }
                }
            } catch (e: Exception) {
                if (!running) return
                error = "Can’t listen (${e.message})"
                Log.w("TwinDesk", "discovery: ${e.message}")
                runCatching { sock?.close() } // its port is free for the next one
                onChange()
                Thread.sleep(5000)
            }
        }
    }

    private fun handle(text: String, address: String, port: Int) {
        val m = runCatching { JSONObject(text) }.getOrNull() ?: return
        val me = self().getString("id")
        if (m.optInt("v") != Proto.VERSION || m.optString("id").isEmpty() || m.optString("id") == me) return
        val t = m.optString("t")
        if (t == Proto.T.PROBE) return send(beaconMsg(), address, port)
        if (t.startsWith("peer.")) { // another phone (Peer.kt)
            if (!peerOn) return
            val f = phones[m.optString("id")]?.copy(address = address) ?: Found(m.optString("id"), m.optString("name").take(100).ifEmpty { "Phone" }, Proto.OS, address, 0, "", System.currentTimeMillis(), false)
            onPeerAsk?.invoke(f, m)
            return
        }
        if (t != Proto.T.BEACON && t != Proto.T.INVITE) return
        val os = m.optString("os", "mac")
        if (os == Proto.OS || os == "ios") { // other phones, Android or iPhone: only for Connect with Android (Peer.kt)
            if (t != Proto.T.BEACON || m.optInt("ap") != 1 || !peerOn) return
            val id = m.getString("id")
            val old = phones[id]
            val port = m.optInt("phost", 0).takeIf { it in 1..65535 } ?: 0
            val d = Found(id, m.optString("name").take(100).ifEmpty { "Phone" }, os, address, port, "", System.currentTimeMillis(), false)
            phones[id] = d
            if (old == null || old.name != d.name || old.address != d.address || old.port != d.port) onChange()
            return
        }
        if (t == Proto.T.BEACON && m.optString("role", "host") != "host") return
        val id = m.getString("id")
        val old = found[id]
        val d = Found(
            id = id,
            name = m.optString("name").take(100).ifEmpty { when (os) { "mac" -> "Mac"; "linux" -> "Linux"; else -> "PC" } },
            os = os,
            address = address,
            port = m.optInt("port", Proto.PORT).takeIf { it in 1..65535 } ?: Proto.PORT,
            fp = Proto.normFingerprint(m.optString("fp")),
            lastSeen = System.currentTimeMillis(),
            invited = (old?.invited ?: false) || t == Proto.T.INVITE,
        )
        found[id] = d
        if (t == Proto.T.INVITE) onInvite(d)
        if (old == null || old.name != d.name || old.address != d.address || old.invited != d.invited) onChange()
    }

    private fun prune() {
        val now = System.currentTimeMillis()
        var changed = false
        for ((id, d) in found) if (now - d.lastSeen > Proto.DEVICE_STALE_MS) { found.remove(id); changed = true }
        for ((id, d) in phones) if (now - d.lastSeen > Proto.DEVICE_STALE_MS) { phones.remove(id); changed = true }
        if (changed) onChange()
    }
}
