// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Lan.kt (#287, #294): which of a computer's welcome addresses the phone may dial.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LanTest {
    @Test
    fun privateAndUsableLinkLocalOnly() {
        assertTrue(Lan.isPrivate("192.168.1.4"))
        assertTrue(Lan.isLinkLocal("169.254.1.0"))
        assertTrue(Lan.isLinkLocal("169.254.254.255"))
        assertFalse(Lan.isLinkLocal("169.254.0.7"))
        assertFalse(Lan.isLinkLocal("169.254.255.7"))
        assertFalse(Lan.isLinkLocal("8.8.8.8"))
    }

    @Test
    fun cleanKeepsUsableAddresses() {
        val a = listOf("192.168.1.4", "100.64.0.1", "169.254.9.9", "169.254.0.1", "8.8.8.8", "192.168.1.4")
        assertEquals(listOf("192.168.1.4", "169.254.9.9"), Lan.clean(a))
    }

    @Test
    fun linkLocalReachableFromLinkLocal() {
        assertEquals(listOf("169.254.9.9"), Lan.reachable(listOf("169.254.9.9", "10.0.0.5"), listOf("169.254.3.3")))
        assertEquals(emptyList<String>(), Lan.reachable(listOf("169.254.9.9"), listOf("192.168.1.2")))
    }
}
