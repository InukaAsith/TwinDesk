// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.content.pm.ActivityInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ViewerOrientationTest {
    @Test
    fun macCanBePortraitAndOtherComputersStayLandscape() {
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, ViewerOrientation.requested("mac", true))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, ViewerOrientation.requested("windows", true))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, ViewerOrientation.requested("linux", true))
        assertNull(ViewerOrientation.requested(null, true))
        assertNull(ViewerOrientation.requested("", true))
    }

    @Test
    fun lockWinsAcrossHostChangeAndLifecycle() {
        val open = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        val landscape = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        val locked = ViewerOrientation.apply(open, "mac", auto = false)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_LOCKED, locked)
        // The connected computer changes, and a later Core update runs the same rule again.
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_LOCKED, ViewerOrientation.apply(locked, "windows", false))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_LOCKED, ViewerOrientation.apply(locked, "linux", false))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_LOCKED, ViewerOrientation.apply(locked, null, false))
        // Auto on again follows the computer that is connected now.
        assertEquals(landscape, ViewerOrientation.apply(locked, "windows", true))
        assertEquals(open, ViewerOrientation.apply(landscape, "mac", true))
        // No computer yet: auto on does not throw away a lock or a landscape hold.
        assertEquals(locked, ViewerOrientation.apply(locked, null, true))
        assertEquals(landscape, ViewerOrientation.apply(landscape, "", true))
    }
}
