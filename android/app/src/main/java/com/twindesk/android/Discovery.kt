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
import kotlin.concurrent.thread

// Screen off: two beacons per DEVICE_STALE_MS, so a computer keeps listing us while we're awake.
private const val BEACON_SCREEN_OFF_MS = 5000L

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
    @Volatile var error = ""
    @Volatile private var sock: DatagramSocket? = null
    @Volatile private var running = false
    private var lock: WifiManager.MulticastLock? = null
    @Volatile private var screenOn = true
    private var screenWatch: BroadcastReceiver? = null

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

    fun probe(address: String? = null) {
        val m = JSONObject().put("t", Proto.T.PROBE).put("v", Proto.VERSION).put("id", self().getString("id"))
        if (address != null) send(m, address) else targets().forEach { send(m, it) }
    }

    private fun beacon() {
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
                    handle(String(p.data, 0, p.length), p.address.hostAddress ?: continue, p.port)
                }
            } catch (e: Exception) {
                if (!running) return
                error = "Can’t listen (${e.message})"
                Log.w("TwinDesk", "discovery: ${e.message}")
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
        if (t != Proto.T.BEACON && t != Proto.T.INVITE) return
        val os = m.optString("os", "mac")
        if (os == Proto.OS) return // other phones: nothing to do with them
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
        if (changed) onChange()
    }
}
