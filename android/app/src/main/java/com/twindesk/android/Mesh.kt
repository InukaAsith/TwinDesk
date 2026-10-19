// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The mesh core of the phone: a Kotlin port of Pool and keepalive in shared/mesh.js. The design is in
// docs/mesh.md and the executable spec is shared/test/mesh-pool.js (ported to MeshPoolTest.kt).
// PURE Kotlin: no Android classes and no org.json, so the JVM tests run it as it is. The JSON of a
// message is converted in MeshWire.kt.
package com.twindesk.android

// A pooled message: the feature's own fields (body: t, text, …) and the stamps (docs/mesh.md).
// o == null means no stamps: the message came from an old one-to-one peer, or it is what one gets.
data class PoolMsg(
    val body: Map<String, Any?>,
    val o: String? = null, // origin device id
    val s: Long = 0L, // origin sequence number, per origin and pool
    val d: List<String> = emptyList(), // the origin's direct links when it published
    val h: Int = 0, // hops: 0 at the origin, +1 per relay
) {
    // The message as a peer of this kind gets it: a mesh peer gets the stamps, an old app the plain body.
    fun forPeer(mesh: Boolean): PoolMsg = if (mesh) this else copy(o = null, s = 0L, d = emptyList(), h = 0)
}

// A connected device as the pool sees it. send returns false when the message could not be sent.
// mesh false: an old app. pool false: that device switched the pool off (never sent items, never relayed to).
data class PoolPeer(
    val id: String,
    val mesh: Boolean,
    val pool: Boolean,
    val send: (PoolMsg) -> Boolean,
)

// Fan-out, dedupe and relay of one pooled item kind (clipboard, notifications). Peers are asked on
// every call (they come and go). Thread-safe: calls are serialised.
class Pool(
    private val selfId: String,
    private val peers: () -> List<PoolPeer>,
    private val seenLimit: Int = Proto.POOL_SEEN_LIMIT,
    private val maxHops: Int = Proto.POOL_MAX_HOPS,
) {
    class Published(val msg: PoolMsg, val sent: List<String>) // sent: the peers whose send returned true
    class Received(val fresh: Boolean, val msg: PoolMsg, val relayed: List<String>) // fresh: apply it

    private var seq = 0L // our own sequence numbers
    private val legacySeq = HashMap<String, Long>() // per old peer: the number given to its items
    private val seen = HashMap<String, LinkedHashSet<Long>>() // origin -> sequence numbers, oldest first

    // Stamp body as our own item and send it to every pool-capable peer.
    @Synchronized
    fun publish(body: Map<String, Any?>): Published {
        seq += 1
        val list = peers()
        val stamped = PoolMsg(body, o = selfId, s = seq, d = list.map { it.id }, h = 0)
        markSeen(selfId, seq)
        val sent = ArrayList<String>()
        for (p in list) {
            if (!p.pool) continue
            if (p.send(stamped.forPeer(p.mesh))) sent.add(p.id)
        }
        return Published(stamped, sent)
    }

    // An item that arrived from peer fromId. A message without stamps comes from that peer, which is
    // its origin. Fresh items must be applied by the feature; they are relayed here, once.
    @Synchronized
    fun receive(fromId: String, msg: PoolMsg): Received {
        val list = peers()
        if (list.any { it.id == fromId && !it.pool }) return Received(false, msg, emptyList())

        var m = msg
        if (m.o == null) {
            val n = (legacySeq[fromId] ?: 0L) + 1
            legacySeq[fromId] = n
            m = m.copy(o = fromId, s = n, d = listOf(fromId), h = 0)
        }
        val origin = m.o ?: return Received(false, m, emptyList())
        if (origin == selfId) return Received(false, m, emptyList()) // our own echo
        if (seen[origin]?.contains(m.s) == true) return Received(false, m, emptyList()) // duplicate
        markSeen(origin, m.s)

        // Relay, except to the sender, the origin, and the origin's own direct links (they got it from
        // the origin). The hop limit bounds a chain.
        val relayed = ArrayList<String>()
        val hops = m.h + 1
        if (hops <= maxHops) {
            val out = m.copy(h = hops)
            for (p in list) {
                if (p.id == fromId || p.id == origin || p.id == selfId) continue
                if (!p.pool) continue
                if (m.d.contains(p.id)) continue
                if (p.send(out.forPeer(p.mesh))) relayed.add(p.id)
            }
        }
        return Received(true, m, relayed)
    }

    // Remember (origin, seq). Only the newest seenLimit numbers per origin are kept, so an item is
    // accepted again only after seenLimit newer items from the same origin.
    private fun markSeen(origin: String, n: Long) {
        val set = seen.getOrPut(origin) { LinkedHashSet() }
        set.add(n)
        while (set.size > seenLimit) set.remove(set.first())
    }
}

// Keep-alive timing for one link. Busy = the selected device, or the one driving this phone.
data class KeepAlive(val intervalMs: Long, val timeoutMs: Long)

fun keepalive(busy: Boolean): KeepAlive =
    if (busy) KeepAlive(Proto.PING_MS, Proto.TIMEOUT_MS) else KeepAlive(Proto.IDLE_PING_MS, Proto.IDLE_TIMEOUT_MS)
