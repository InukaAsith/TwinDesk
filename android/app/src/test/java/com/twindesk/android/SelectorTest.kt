// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SelectorTest {
    private fun e(id: String, state: String, tr: String = "", near: Boolean = false, os: String = "mac") =
        PcEntry(id, "pc-$id", os, state, tr, near)

    @Test fun noComputer() {
        val s = PcSelect.build(emptyList(), null)
        assertEquals("No computer", s.label)
        assertFalse(s.expandable)
        assertNull(s.current)
        assertEquals("faint", s.dot)
    }

    @Test fun oneComputerIsPlainText() {
        val s = PcSelect.build(listOf(e("a", "connected", "ip")), "a")
        assertEquals("pc-a", s.label)
        assertFalse(s.expandable)
        assertEquals("good", s.dot)
    }

    @Test fun orderConnectedFirstThenConnectingThenPaired() {
        val s = PcSelect.build(listOf(e("o1", "offline"), e("c1", "connecting"), e("a", "connected", "ble"), e("o2", "offline"), e("b", "connected", "ip")), "b")
        assertEquals(listOf("a", "b", "c1", "o1", "o2"), s.choices.map { it.id })
        assertTrue(s.expandable)
        assertEquals("pc-b", s.label)
        assertEquals(listOf(false, true, false, false, false), s.choices.map { it.selected })
    }

    @Test fun actions() {
        val s = PcSelect.build(listOf(e("a", "connected", "usb"), e("c", "connecting"), e("o", "offline", near = true)), "a")
        assertEquals(listOf(PcAction.USE, PcAction.NONE, PcAction.CONNECT), s.choices.map { it.action })
        assertEquals("Mac · USB", s.choices[0].detail)
        assertEquals("Paired · nearby", s.choices[2].detail)
        assertEquals("Paired · not nearby", PcSelect.build(listOf(e("o", "offline")), null).choices[0].detail)
    }

    @Test fun staleAttachedIdIsIgnored() {
        // attached says "x" but x is not connected any more: nothing is selected
        val s = PcSelect.build(listOf(e("x", "offline"), e("y", "offline")), "x")
        assertNull(s.current)
        assertEquals("Not connected", s.label)
        assertTrue(s.choices.none { it.selected })
    }

    @Test fun connectingShowsItsName() {
        val s = PcSelect.build(listOf(e("o", "offline"), e("c", "connecting")), null)
        assertEquals("pc-c", s.label)
        assertEquals("warn", s.dot)
    }

    @Test fun nameFallsBackToOs() {
        val s = PcSelect.build(listOf(PcEntry("a", "", "win", "connected", "ip")), "a")
        assertEquals("PC", s.label)
        assertEquals("Computer", PcSelect.build(listOf(PcEntry("a", "", "", "offline", "")), null).choices[0].name)
    }

    @Test fun pickAttachedKeepsSelection() {
        assertEquals("a", PcSelect.pickAttached("a", listOf("a", "b"), mapOf("a" to 1L, "b" to 9L)))
    }

    @Test fun pickAttachedFallsBackToNewestWhenSelectedDisconnects() {
        assertEquals("b", PcSelect.pickAttached("a", listOf("b", "c"), mapOf("b" to 5L, "c" to 2L)))
        assertEquals("c", PcSelect.pickAttached(null, listOf("b", "c"), mapOf("b" to 5L, "c" to 7L)))
    }

    @Test fun pickAttachedNoneConnected() {
        assertNull(PcSelect.pickAttached("a", emptyList(), emptyMap()))
    }
}
