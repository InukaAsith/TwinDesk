// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer viewer's orientation. One rule for the side rail and for ViewerActivity, so a Core
// update cannot put back the host default over a lock the person chose.
//
// Auto on: a Mac may be portrait (no fixed orientation). Any other known computer stays landscape,
// which is what its virtual monitor already expects. Auto off: locked the way the phone is now.
// Until the computer is known, auto on leaves the current orientation alone.
package com.twindesk.android

import android.content.pm.ActivityInfo

object ViewerOrientation {
    const val PREFS = "mirror-rail"
    const val AUTO = "auto"

    fun requested(os: String?, auto: Boolean): Int? {
        if (!auto) return ActivityInfo.SCREEN_ORIENTATION_LOCKED
        if (os.isNullOrEmpty()) return null
        return if (os == "mac") ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    fun apply(current: Int, os: String?, auto: Boolean): Int = requested(os, auto) ?: current
}
