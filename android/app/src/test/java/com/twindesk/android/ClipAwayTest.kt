// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// While-away clipboard ownership. Identifiers and texts are inert fixtures, not a real pair or copy.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClipAwayTest {
    private val maxItem = 32
    private val known = HashMap<String, String>()

    private fun away(): ClipAway = ClipAway()

    private fun isKnown(id: String, fp: String) = known[id] == fp

    private fun bind(q: ClipAway, id: String, fp: String) {
        known[id] = fp
        q.bind(id, fp, known[id])
    }

    private fun add(q: ClipAway, text: String, at: Long = 1): Boolean =
        q.add(text, at, queueOn = true, outgoing = true, maxItems = 50, maxBytes = 64, maxItemBytes = maxItem, known = { id, fp -> isKnown(id, fp) })

    @Test
    fun samePairKeepsCopiesAcrossReconnect() {
        val q = away()
        bind(q, "id-a", "fp-a")
        assertTrue(add(q, "inert-1", 10))
        assertTrue(add(q, "inert-2", 11))
        q.bind("id-a", "fp-a", "fp-a")
        assertEquals(2, q.size)
        val batch = q.beginFlush("id-a", "fp-a", queueOn = true, outgoing = true, consent = true, known = { id, fp -> isKnown(id, fp) })
        assertEquals(listOf("inert-1", "inert-2"), batch!!.items.map { it.text })
        assertEquals(2, q.size) // not committed: the retired socket did not take them
        assertTrue(q.commit(batch))
        assertEquals(0, q.size)
    }

    @Test
    fun anotherComputerDoesNotReceiveThem() {
        val q = away()
        bind(q, "id-a", "fp-a")
        add(q, "inert-1", 10)
        bind(q, "id-b", "fp-b")
        assertEquals(0, q.size)
        assertEquals(ClipAway.Owner("id-b", "fp-b"), q.owner())
        assertNull(q.beginFlush("id-a", "fp-a", queueOn = true, outgoing = true, consent = true, known = { id, fp -> isKnown(id, fp) }))
        add(q, "inert-2", 12)
        assertNull(q.beginFlush("id-a", "fp-a", queueOn = true, outgoing = true, consent = true, known = { id, fp -> isKnown(id, fp) }))
        assertEquals(1, q.size)
        assertEquals(listOf("inert-2"), q.beginFlush("id-b", "fp-b", queueOn = true, outgoing = true, consent = true, known = { id, fp -> isKnown(id, fp) })!!.items.map { it.text })
    }

    @Test
    fun replacedFingerprintDropsTheQueue() {
        val q = away()
        bind(q, "id-a", "fp-a")
        add(q, "inert-1", 10)
        known["id-a"] = "fp-new"
        q.bind("id-a", "fp-new", known["id-a"])
        assertEquals(0, q.size)
        assertEquals("fp-new", q.owner()!!.fp)
        add(q, "inert-2", 12)
        assertNull(q.beginFlush("id-a", "fp-a", queueOn = true, outgoing = true, consent = true, known = { id, fp -> isKnown(id, fp) }))
        assertEquals(1, q.size)
    }

    @Test
    fun storeLosingTheFingerprintDropsTheQueue() {
        val q = away()
        bind(q, "id-a", "fp-a")
        add(q, "inert-1", 10)
        known["id-a"] = "fp-other"
        assertFalse(add(q, "inert-2", 11))
        assertNull(q.owner())
        assertEquals(0, q.size)
        assertNull(q.beginFlush("id-a", "fp-a", queueOn = true, outgoing = true, consent = true, known = { id, fp -> isKnown(id, fp) }))
    }

    @Test
    fun explicitDisconnectForgetAndSwitchesClear() {
        val q = away()
        bind(q, "id-a", "fp-a")
        add(q, "inert-1", 10)
        q.explicitDisconnect()
        assertEquals(0, q.size)
        assertNull(q.owner())
        assertFalse(add(q, "while-stopped", 11))
        bind(q, "id-a", "fp-a")
        add(q, "inert-2", 11)
        q.forget("id-b")
        assertEquals(1, q.size)
        q.forget("id-a")
        assertNull(q.owner())
        assertEquals(0, q.size)
        assertFalse(add(q, "inert-3", 12))

        bind(q, "id-a", "fp-a")
        add(q, "inert-4", 13)
        q.disableOutgoing()
        assertEquals(0, q.size)
        add(q, "inert-5", 14)
        q.disableQueue()
        assertEquals(0, q.size)
        assertEquals(ClipAway.Owner("id-a", "fp-a"), q.owner())
    }

    @Test
    fun flushNeedsConsentAndDoesNotCommitAfterClear() {
        val q = away()
        bind(q, "id-a", "fp-a")
        add(q, "inert-1", 10)
        assertNull(q.beginFlush("id-a", "fp-a", queueOn = true, outgoing = true, consent = false, known = { id, fp -> isKnown(id, fp) }))
        val batch = q.beginFlush("id-a", "fp-a", queueOn = true, outgoing = true, consent = true, known = { id, fp -> isKnown(id, fp) })!!
        q.explicitDisconnect()
        assertFalse(q.commit(batch))
        bind(q, "id-a", "fp-a")
        add(q, "inert-2", 12)
        assertFalse(q.commit(batch))
        assertEquals(listOf("inert-2"), q.beginFlush("id-a", "fp-a", queueOn = true, outgoing = true, consent = true, known = { id, fp -> isKnown(id, fp) })!!.items.map { it.text })
    }

    @Test
    fun disablingOutgoingOrQueueInsideFlushClears() {
        val q = away()
        bind(q, "id-a", "fp-a")
        add(q, "inert-1", 10)
        assertNull(q.beginFlush("id-a", "fp-a", queueOn = true, outgoing = false, consent = true, known = { id, fp -> isKnown(id, fp) }))
        assertEquals(0, q.size)
        add(q, "inert-2", 11)
        assertNull(q.beginFlush("id-a", "fp-a", queueOn = false, outgoing = true, consent = true, known = { id, fp -> isKnown(id, fp) }))
        assertEquals(0, q.size)
    }

    @Test
    fun unboundPairDoesNotQueue() {
        val q = away()
        assertFalse(add(q, "inert-1", 10))
        q.bind("id-a", "fp-a", null)
        assertNull(q.owner())
        q.bind("id-a", "fp-a", "fp-other")
        assertNull(q.owner())
        assertFalse(add(q, "inert-1", 10))
    }

    @Test
    fun limitsAndDuplicateMove() {
        val q = away()
        bind(q, "id-a", "fp-a")
        assertFalse(add(q, "x".repeat(maxItem + 1), 1))
        add(q, "inert-1", 10)
        assertFalse(add(q, "inert-1", 11))
        add(q, "inert-2", 12)
        add(q, "inert-1", 13)
        assertEquals(listOf("inert-2", "inert-1"), q.beginFlush("id-a", "fp-a", true, true, true, ::isKnown)!!.items.map { it.text })
    }

    @Test
    fun stalePutLatestIsDropped() {
        val gate = LatestGate()
        val first = gate.issue()
        val second = gate.issue()
        assertFalse(gate.current(first))
        assertTrue(gate.current(second))
        gate.drop()
        assertFalse(gate.current(second))
    }
}
