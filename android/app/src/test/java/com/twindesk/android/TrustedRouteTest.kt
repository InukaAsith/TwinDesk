// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrustedRouteTest {
    @Test
    fun exactSocketAndPairMatch() {
        val socket = Any()
        val route = Link.TrustedRoute(socket, "host-a", "fp-a")
        assertTrue(route.matches(socket, "host-a", "fp-a"))
    }

    @Test
    fun replacedSocketOrPairCannotMatch() {
        val socket = Any()
        val route = Link.TrustedRoute(socket, "host-a", "fp-a")
        assertFalse(route.matches(Any(), "host-a", "fp-a"))
        assertFalse(route.matches(socket, "host-b", "fp-a"))
        assertFalse(route.matches(socket, "host-a", "fp-b"))
    }
}
