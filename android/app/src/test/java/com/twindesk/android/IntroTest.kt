// Port of shared/test/intro.js (validators, Mesh.known()) against Mesh.kt and Intro.kt, plus the guest
// side of a grant (what is stored) and the phone's rules (it cannot host).
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IntroTest {
    private val ok: Map<String, Any?> = mapOf(
        "t" to Intro.GRANT, "req" to "r", "macId" to "m", "macName" to "Mac", "os" to "mac",
        "fp" to "ab".repeat(32), "port" to 5000, "addrs" to listOf("192.168.1.5"), "token" to "cd".repeat(32),
    )

    @Test fun canHost() {
        assertTrue(Intro.canHost("mac"))
        assertTrue(Intro.canHost("win"))
        assertTrue(Intro.canHost("linux"))
        assertFalse(Intro.canHost("android"))
        assertFalse(Intro.canHost(null))
    }

    @Test fun validGrant() {
        assertTrue(Intro.validGrant(ok))
        assertFalse(Intro.validGrant(ok + ("fp" to "zz")))
        assertFalse(Intro.validGrant(ok + ("fp" to "ab".repeat(31))))
        assertFalse(Intro.validGrant(ok + ("token" to "not hex!")))
        assertFalse(Intro.validGrant(ok + ("token" to "")))
        assertFalse(Intro.validGrant(ok + ("port" to 0)))
        assertFalse(Intro.validGrant(ok + ("port" to 65536)))
        assertFalse(Intro.validGrant(ok + ("port" to 5000.5)))
        assertFalse(Intro.validGrant(ok + ("port" to "5000")))
        assertTrue(Intro.validGrant(ok + ("port" to 65535L)))
        assertTrue(Intro.validGrant(ok + ("port" to 5000.0)))
        assertFalse(Intro.validGrant(ok + ("addrs" to emptyList<String>())))
        assertFalse(Intro.validGrant(ok + ("addrs" to List(9) { "10.0.0.$it" })))
        assertTrue(Intro.validGrant(ok + ("addrs" to List(8) { "10.0.0.$it" })))
        assertFalse(Intro.validGrant(ok + ("addrs" to listOf(1))))
        assertFalse(Intro.validGrant(ok + ("addrs" to "10.0.0.1")))
        assertFalse(Intro.validGrant(ok + ("macId" to "")))
        assertFalse(Intro.validGrant(ok - "req"))
        assertFalse(Intro.validGrant(ok + ("t" to "mesh.roster")))
        assertFalse(Intro.validGrant(null))
        // Colons and capitals in the fingerprint are fine (a pairing's form), the token must be hex.
        assertTrue(Intro.validGrant(ok + ("fp" to "AB:".repeat(31) + "AB")))
        assertTrue(Intro.validGrant(mapOf("t" to Intro.REPLY, "req" to "r", "ok" to false, "error" to "no")))
    }

    @Test fun validAsk() {
        assertTrue(Intro.validAsk(mapOf("t" to Intro.ASK, "req" to "r", "for" to "g")))
        assertTrue(Intro.validAsk(mapOf("t" to Intro.ASK, "req" to "r", "for" to "g", "name" to "Phone")))
        assertFalse(Intro.validAsk(mapOf("t" to Intro.ASK, "for" to "g")))
        assertFalse(Intro.validAsk(mapOf("t" to Intro.ASK, "req" to "r", "for" to "g", "name" to 3)))
        assertFalse(Intro.validAsk(null))
    }

    @Test fun grantedIsStoredLikeAPairing() {
        val g = Intro.granted(ok + ("fp" to "AB:".repeat(31) + "AB") + ("addrs" to listOf("192.168.1.5", "10.0.0.2")))
        assertNotNull(g)
        assertEquals("m", g!!.id)
        assertEquals("Mac", g.name)
        assertEquals("mac", g.os)
        assertEquals("192.168.1.5", g.address)
        assertEquals(5000, g.port)
        assertEquals("ab".repeat(32), g.fp)
        assertEquals("cd".repeat(32), g.token)
        // Defaults for a missing name and system, like Host.from.
        val d = Intro.granted(ok - "macName" - "os")!!
        assertEquals("Computer", d.name)
        assertEquals("mac", d.os)
    }

    @Test fun grantedRefusesWhatIsNotAValidGrant() {
        assertNull(Intro.granted(ok + ("fp" to "zz")))
        assertNull(Intro.granted(ok + ("t" to Intro.REPLY)))
        assertNull(Intro.granted(mapOf("t" to Intro.REPLY, "req" to "r", "ok" to false)))
        assertNull(Intro.granted(null))
    }

    @Test fun cleanMemberLimits() {
        assertEquals(Member("M", "Mac", "mac"), cleanMember("M", "Mac", "mac"))
        assertEquals(Member("M", "", ""), cleanMember("M", null, null))
        assertEquals(64, cleanMember("M", "x".repeat(100), "mac")!!.name.length)
        assertEquals(16, cleanMember("M", "n", "o".repeat(40))!!.os.length)
        assertNull(cleanMember("", "n", "mac"))
        assertNull(cleanMember(5, "n", "mac"))
        assertNull(cleanMember(null, "n", "mac"))
    }

    // Mesh.known(): members of a peer's roster are listed as indirect devices.
    @Test fun knownListsIndirectDevices() {
        val m = MeshMembers("P")
        val win = Member("W", "Win", "win")
        assertEquals(1, m.known(listOf(win)).size)
        m.set("W", listOf(Member("P", "me", "android"), Member("M", "Mac", "mac")))
        val k = m.known(listOf(win))
        assertEquals(listOf("M:false", "W:true"), k.map { "${it.id}:${it.direct}" }.sorted())
        assertEquals(listOf("W"), k.first { it.id == "M" }.via)
        assertTrue(k.first { it.id == "W" }.via.isEmpty())
        // Now linked to M directly.
        val mac = Member("M", "Mac", "mac")
        val k2 = m.known(listOf(win, mac))
        assertTrue(k2.first { it.id == "M" }.direct)
        assertEquals(2, k2.size)
        // W gone: its members are forgotten.
        m.remove("W")
        assertEquals(listOf("M"), m.known(listOf(mac)).map { it.id })
    }

    @Test fun knownIgnoresMembersOfPeersThatAreNotConnected() {
        val m = MeshMembers("P")
        m.set("W", listOf(Member("M", "Mac", "mac")))
        assertEquals(emptyList<Known>(), m.known(emptyList()))
        // …and takes names and systems from the report when the direct entry has none.
        val k = m.known(listOf(Member("W", "", ""), Member("M", "", "")))
        assertEquals(2, k.size)
        m.set("W", listOf(Member("M", "Mac", "mac"), Member("M", "Dup", "mac"), Member("X", "Other", "linux"), Member("W", "W2", "win")))
        val k3 = m.known(listOf(Member("W", "", ""), Member("M", "", "")))
        assertEquals("Mac", k3.first { it.id == "M" }.name)
        assertEquals("W2", k3.first { it.id == "W" }.name)
        assertEquals(listOf("W", "M", "X"), k3.map { it.id })
        assertEquals(listOf("W"), k3.first { it.id == "X" }.via)
    }

    @Test fun twoPeersReportingTheSameDeviceBothAreVia() {
        val m = MeshMembers("P")
        m.set("A", listOf(Member("Z", "Zed", "linux")))
        m.set("B", listOf(Member("Z", "Zed", "linux")))
        val k = m.known(listOf(Member("A", "a", "win"), Member("B", "b", "mac")))
        assertEquals(listOf("A", "B"), k.first { it.id == "Z" }.via)
        // Our own id is never listed.
        m.set("A", listOf(Member("P", "me", "android")))
        assertTrue(m.known(listOf(Member("A", "a", "win"))).none { it.id == "P" })
    }
}
