// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Port of shared/test/mesh-pool.js: the Pool scenarios (full mesh, partial meshes, legacy peers, echo,
// duplicates, window eviction, hop limit, pool off, out-of-order items) against Mesh.kt.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MeshPoolTest {
    // Deterministic PRNG (mulberry32), the same as the JS test, so a failing graph replays by its seed.
    private class Rng(seed: Int) {
        private var a = seed
        fun next(): Double {
            a += 0x6d2b79f5
            var t = (a xor (a ushr 15)) * (1 or a)
            t = (t + ((t xor (t ushr 7)) * (61 or t))) xor t
            return (t xor (t ushr 14)).toLong().and(0xffffffffL).toDouble() / 4294967296.0
        }
    }

    private class Node(val id: String, val legacy: Boolean) {
        var pool: Pool? = null
        val applied = HashMap<String, Int>()
        val raw = ArrayList<PoolMsg>() // what a legacy node received, as it arrived
    }

    private class Envelope(val from: String, val to: String, val msg: PoolMsg)

    // An item published (or sent by a legacy leaf) and a way to count the sends it caused.
    private class Entry(val item: String, val origin: String, private val sendsSince: () -> Int) {
        fun sends(): Int = sendsSince()
    }

    // In-memory network. A node is a Pool, or a legacy leaf (an old one-to-one app: no Pool).
    // Messages wait in a queue; drain() delivers them in FIFO order or in an order chosen by pick().
    private inner class Net {
        val nodes = LinkedHashMap<String, Node>()
        val adj = HashMap<String, LinkedHashSet<String>>()
        val queue = ArrayList<Envelope>()
        var sends = 0

        fun addNode(id: String, legacy: Boolean = false): Net {
            nodes[id] = Node(id, legacy)
            adj[id] = LinkedHashSet()
            return this
        }

        fun link(a: String, b: String): Net {
            adj.getValue(a).add(b)
            adj.getValue(b).add(a)
            return this
        }

        // Build the Pool of every non-legacy node. The limits are explicit, not the protocol constants.
        fun start(seenLimit: Int, maxHops: Int): Net {
            for (node in nodes.values) {
                if (node.legacy) continue
                node.pool = Pool(
                    selfId = node.id,
                    peers = { peersOf(node.id) },
                    seenLimit = seenLimit,
                    maxHops = maxHops,
                )
            }
            return this
        }

        // What node id sees as its connected peers. mesh is false when the other side is legacy.
        fun peersOf(id: String): List<PoolPeer> = adj.getValue(id).map { other ->
            PoolPeer(other, mesh = !nodes.getValue(other).legacy, pool = true) { m -> enqueue(id, other, m) }
        }

        fun enqueue(from: String, to: String, msg: PoolMsg): Boolean {
            sends += 1
            queue.add(Envelope(from, to, msg))
            return true
        }

        // Deliver the queued message at index. Returns false when there is none there.
        fun deliverAt(index: Int): Boolean {
            if (index !in queue.indices) return false
            val e = queue.removeAt(index)
            val node = nodes.getValue(e.to)
            val item = e.msg.body["item"] as String
            if (node.legacy) {
                node.raw.add(e.msg)
                node.applied[item] = (node.applied[item] ?: 0) + 1
                return true
            }
            val r = node.pool!!.receive(e.from, e.msg)
            if (r.fresh) node.applied[item] = (node.applied[item] ?: 0) + 1
            return true
        }

        // Deliver everything. pick(queueLength) gives the index to deliver next (default: FIFO).
        fun drain(pick: ((Int) -> Int)? = null) {
            while (queue.isNotEmpty()) {
                val index = pick?.invoke(queue.size) ?: 0
                deliverAt(index)
            }
        }

        fun publish(origin: String, item: String): Entry {
            val before = sends
            nodes.getValue(origin).pool!!.publish(mapOf("item" to item))
            return Entry(item, origin) { sends - before }
        }

        // A legacy leaf sends an item to its neighbour, as an old app does (no stamps).
        fun legacySend(leaf: String, item: String): Entry {
            val neighbour = adj.getValue(leaf).first()
            val before = sends
            enqueue(leaf, neighbour, PoolMsg(body = mapOf("item" to item)))
            return Entry(item, leaf) { sends - before }
        }

        // Every node except the origin applied the item exactly once; the origin applied nothing.
        fun assertExactlyOnce(e: Entry, label: String) {
            for (node in nodes.values) {
                val got = node.applied[e.item] ?: 0
                val want = if (node.id == e.origin) 0 else 1
                assertEquals("$label: node ${node.id} applied ${e.item}", want, got)
            }
        }

        fun directedLinks(): Int = adj.values.sumOf { it.size }
    }

    private fun fullMesh(n: Int): Net {
        val net = Net()
        for (i in 0 until n) net.addNode("n$i")
        for (i in 0 until n) for (j in i + 1 until n) net.link("n$i", "n$j")
        return net
    }

    private var itemNo = 0
    private fun nextItem(): String = "item" + (++itemNo)

    private val opts = Pair(200, 3) // seenLimit, maxHops

    // 1. Full mesh: every node applies once, origin never, n-1 sends per item.
    @Test
    fun fullMeshDeliversOnceToEveryNode() {
        val r = Rng(1)
        for (n in 2..10) {
            val net = fullMesh(n).start(opts.first, opts.second)
            for (k in 0 until 30) {
                val origin = "n" + (r.next() * n).toInt()
                val e = net.publish(origin, nextItem())
                net.drain()
                net.assertExactlyOnce(e, "full mesh n=$n")
                assertEquals("full mesh n=$n: sends per item", n - 1, e.sends())
            }
        }
    }

    // 2. Partial meshes: line, star, ring and seeded random connected graphs. maxHops 10 covers a line of 10.
    @Test
    fun lineStarRingAndRandomGraphsDeliverOnce() {
        val wide = 10

        // Line A-B-C-D: every node once; the origin's item crosses each link once.
        run {
            val net = Net().addNode("A").addNode("B").addNode("C").addNode("D")
            net.link("A", "B").link("B", "C").link("C", "D").start(200, wide)
            val e = net.publish("A", nextItem())
            net.drain()
            net.assertExactlyOnce(e, "line from end")
            assertEquals("line: 3 links, 3 sends", 3, e.sends())
            val f = net.publish("B", nextItem())
            net.drain()
            net.assertExactlyOnce(f, "line from middle")
        }

        // Star: centre C, leaves L1..L6.
        run {
            val net = Net().addNode("C")
            for (i in 1..6) {
                net.addNode("L$i").link("C", "L$i")
            }
            net.start(200, wide)
            val e = net.publish("L3", nextItem())
            net.drain()
            net.assertExactlyOnce(e, "star from leaf")
            assertEquals("star from leaf: leaf->C, C->5 leaves", 6, e.sends())
        }

        // Ring of 7.
        run {
            val net = Net()
            val n = 7
            for (i in 0 until n) net.addNode("r$i")
            for (i in 0 until n) net.link("r$i", "r${(i + 1) % n}")
            net.start(200, wide)
            for (i in 0 until n) {
                val e = net.publish("r$i", nextItem())
                net.drain()
                net.assertExactlyOnce(e, "ring origin r$i")
                assertTrue("ring: sends bounded by directed links", e.sends() <= net.directedLinks())
            }
        }

        // Random connected graphs of 2..10 nodes: a random tree plus random extra links.
        var graphs = 0
        for (seed in 1..300) {
            val r = Rng(seed)
            val n = 2 + (r.next() * 9).toInt()
            val net = Net()
            for (i in 0 until n) net.addNode("g$i")
            for (i in 1 until n) net.link("g$i", "g${(r.next() * i).toInt()}")
            for (i in 0 until n) for (j in i + 1 until n) {
                if (r.next() < 0.2) net.link("g$i", "g$j")
            }
            net.start(200, wide)
            val links = net.directedLinks()
            for (k in 0 until 10) {
                val origin = "g" + (r.next() * n).toInt()
                val e = net.publish(origin, nextItem())
                // Random delivery order: items reach nodes in any order the network likes.
                net.drain { len -> (r.next() * len).toInt() }
                net.assertExactlyOnce(e, "random graph seed=$seed n=$n")
                assertTrue("random graph seed=$seed: sends ${e.sends()} > directed links $links", e.sends() <= links)
            }
            graphs += 1
        }
        assertEquals(300, graphs)
    }

    // 3. Legacy peers (mesh false, no stamps).
    @Test
    fun legacyPeersGetPlainMessagesAndTheirItemsArriveOnce() {
        // Mesh A-B-C with the legacy leaf L on B.
        val net = Net().addNode("A").addNode("B").addNode("C").addNode("L", legacy = true)
        net.link("A", "B").link("B", "C").link("B", "L").start(200, 3)

        // An item from the legacy leaf reaches every mesh node once.
        val fromLeaf = net.legacySend("L", nextItem())
        net.drain()
        for (id in listOf("A", "B", "C")) {
            assertEquals("legacy origin: $id applies once", 1, net.nodes.getValue(id).applied[fromLeaf.item])
        }
        assertEquals("legacy origin: leaf->B, B->A, B->C", 3, fromLeaf.sends())

        // An item from A reaches the legacy leaf once, and it arrives with no stamps.
        val toLeaf = net.publish("A", nextItem())
        net.drain()
        net.assertExactlyOnce(toLeaf, "item to legacy leaf")
        val received = net.nodes.getValue("L").raw.filter { it.body["item"] == toLeaf.item }
        assertEquals("legacy leaf got exactly one item (the one from A)", 1, received.size)
        assertNull("legacy leaf received a stamp", received[0].o)
        assertEquals(0L, received[0].s) // no sequence number either
    }

    // 3b. Legacy items in a loop: triangle A-B-C with the legacy leaf L on B. Two different items from
    // L must each be applied once everywhere (the stamp given at B keeps them apart).
    @Test
    fun legacyItemsInALoopAreEachAppliedOnce() {
        val net = Net().addNode("A").addNode("B").addNode("C").addNode("L", legacy = true)
        net.link("A", "B").link("B", "C").link("A", "C").link("B", "L").start(200, 3)
        val first = net.legacySend("L", nextItem())
        net.drain()
        net.assertExactlyOnce(first, "legacy loop item 1")
        val second = net.legacySend("L", nextItem())
        net.drain()
        net.assertExactlyOnce(second, "legacy loop item 2")
    }

    // 4a. Own echo is dropped.
    @Test
    fun ownEchoIsDropped() {
        val sent = ArrayList<Pair<String, PoolMsg>>()
        val peers = listOf(PoolPeer("B", mesh = true, pool = true) { m -> sent.add("B" to m); true })
        val pool = Pool("A", { peers }, seenLimit = 3, maxHops = 3)
        val published = pool.publish(mapOf("item" to "mine"))
        assertEquals("A", published.msg.o)
        assertEquals(1L, published.msg.s)
        assertEquals(listOf("B"), published.msg.d)
        assertEquals(0, published.msg.h)
        assertEquals(listOf("B"), published.sent)
        val echo = pool.receive("B", published.msg)
        assertFalse("own echo is not fresh", echo.fresh)
    }

    // 4b. A duplicate (o, s) is dropped; another sequence number from the same origin is fresh.
    @Test
    fun duplicatesAreDroppedButNewNumbersAreFresh() {
        val pool = Pool("A", { listOf(PoolPeer("B", mesh = true, pool = true) { true }) }, seenLimit = 3, maxHops = 3)
        val dup = PoolMsg(mapOf("item" to "x"), o = "C", s = 1L, d = listOf("C"), h = 0)
        assertTrue("first copy is fresh", pool.receive("B", dup).fresh)
        assertFalse("second copy is a duplicate", pool.receive("B", dup).fresh)
    }

    // 4c. Window eviction, seenLimit 3: an item is accepted again only after 3 newer items.
    @Test
    fun windowEvictionAcceptsAnOldItemAgainAfterSeenLimitNewerOnes() {
        val w = Pool("A", { emptyList() }, seenLimit = 3, maxHops = 3)
        fun item(s: Long) = PoolMsg(mapOf("item" to "w$s"), o = "C", s = s, d = listOf("C"), h = 0)
        assertTrue(w.receive("X", item(1)).fresh)
        assertTrue(w.receive("X", item(2)).fresh)
        assertTrue(w.receive("X", item(3)).fresh)
        assertFalse("still remembered after 2 newer", w.receive("X", item(1)).fresh)
        assertTrue("newer item is fresh", w.receive("X", item(4)).fresh)
        assertTrue("evicted after 3 newer: accepted again", w.receive("X", item(1)).fresh)
        // The window is per origin: another origin with the same numbers is not affected.
        assertTrue(w.receive("X", PoolMsg(mapOf("item" to "o"), o = "D", s = 4L, d = listOf("D"), h = 0)).fresh)
    }

    // 4d. pool off: the peer gets nothing, is not relayed to, and its pool items are ignored.
    @Test
    fun poolOffPeersGetNothingAndTheirItemsAreIgnored() {
        val log = mapOf("B" to ArrayList<PoolMsg>(), "C" to ArrayList<PoolMsg>(), "D" to ArrayList<PoolMsg>())
        val off = Pool(
            "A",
            {
                listOf(
                    PoolPeer("B", mesh = true, pool = true) { m -> log.getValue("B").add(m); true },
                    PoolPeer("C", mesh = true, pool = false) { m -> log.getValue("C").add(m); true },
                    PoolPeer("D", mesh = false, pool = true) { m -> log.getValue("D").add(m); true },
                )
            },
            seenLimit = 200,
            maxHops = 3,
        )
        val pub = off.publish(mapOf("item" to "p"))
        assertEquals("publish skips the pool:false peer", listOf("B", "D"), pub.sent)
        assertTrue("pool:false peer received nothing on publish", log.getValue("C").isEmpty())

        val relayed = off.receive("B", PoolMsg(mapOf("item" to "q"), o = "E", s = 1L, d = listOf("E"), h = 0))
        assertEquals("relay skips the pool:false peer", listOf("D"), relayed.relayed)
        assertTrue("pool:false peer received nothing on relay", log.getValue("C").isEmpty())

        val fromOff = off.receive("C", PoolMsg(mapOf("item" to "r"), o = "E", s = 2L, d = listOf("E"), h = 0))
        assertFalse("items from a pool:false peer are ignored", fromOff.fresh)

        // A relayed copy to a legacy peer carries no stamps.
        val toLegacy = log.getValue("D")[1]
        assertNull(toLegacy.o)
        assertEquals("q", toLegacy.body["item"])
    }

    // 4e. Hop limit, exactly: origin N0 on a line of 10 nodes, maxHops 3. N4 would relay with h=4 and
    // N5 never gets the item.
    @Test
    fun hopLimitStopsTheRelayChain() {
        val net = Net()
        for (i in 0 until 10) net.addNode("N$i")
        for (i in 0 until 9) net.link("N$i", "N${i + 1}")
        net.start(200, 3)
        val e = net.publish("N0", nextItem())
        net.drain()
        for (i in 1..4) {
            assertEquals("hop limit: N$i gets it", 1, net.nodes.getValue("N$i").applied[e.item])
        }
        for (i in 5 until 10) {
            assertEquals("hop limit: N$i is beyond reach", 0, net.nodes.getValue("N$i").applied[e.item] ?: 0)
        }
        assertEquals("hop limit: 4 sends (N0..N4 links)", 4, e.sends())
    }

    // 6a. Two items from one origin arrive out of order through different paths (diamond O-A-C, O-B-C).
    @Test
    fun itemsArrivingOutOfOrderAreAppliedOnce() {
        val net = Net().addNode("O").addNode("A").addNode("B").addNode("C")
        net.link("O", "A").link("O", "B").link("A", "C").link("B", "C").start(200, 3)
        val first = net.publish("O", "first")
        val second = net.publish("O", "second")
        // Deliver O->B(second) first, then B's relay of it to C, before anything else.
        net.deliverAt(net.queue.indexOfFirst { it.from == "O" && it.to == "B" && it.msg.body["item"] == "second" })
        net.deliverAt(net.queue.indexOfFirst { it.from == "B" && it.to == "C" && it.msg.body["item"] == "second" })
        assertEquals("C has item 2 before item 1", 1, net.nodes.getValue("C").applied["second"])
        assertEquals("C does not have item 1 yet", 0, net.nodes.getValue("C").applied["first"] ?: 0)
        net.drain()
        net.assertExactlyOnce(first, "out of order item 1")
        net.assertExactlyOnce(second, "out of order item 2")
    }

    // 6b. The origin's d omits a peer that is in fact connected: the relay must still reach it.
    @Test
    fun relayReachesAPeerMissingFromTheOriginsLinks() {
        val sent = ArrayList<Pair<String, PoolMsg>>()
        val pool = Pool(
            "X",
            {
                listOf(
                    PoolPeer("A", mesh = true, pool = true) { m -> sent.add("A" to m); true },
                    PoolPeer("B", mesh = true, pool = true) { m -> sent.add("B" to m); true },
                )
            },
            seenLimit = 200,
            maxHops = 3,
        )
        // The origin O says its links are only [A], but B is connected to X too.
        val r = pool.receive("A", PoolMsg(mapOf("item" to "stale"), o = "O", s = 1L, d = listOf("A"), h = 0))
        assertTrue(r.fresh)
        assertEquals("B is relayed to even though d did not list it", listOf("B"), r.relayed)
        assertEquals(1, sent.size)
        assertEquals("relay carries h+1", 1, sent[0].second.h)
        assertEquals("relay keeps the origin", "O", sent[0].second.o)
    }

    @Test
    fun keepaliveIsFasterOnlyForBusyLinks() {
        assertEquals(KeepAlive(Proto.PING_MS, Proto.TIMEOUT_MS), keepalive(busy = true))
        assertEquals(KeepAlive(Proto.IDLE_PING_MS, Proto.IDLE_TIMEOUT_MS), keepalive(busy = false))
    }
}
