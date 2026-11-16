// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The standard and F-Droid builds: no Shizuku (it's in the full build only, src/shizuku), so
// Permissions › Without a computer isn't shown. The computer grants these as before.
package com.twindesk.android

import android.content.Context

object Elevate {
    const val supported = false
    const val SHIZUKU = ""
    enum class State { Missing, Stopped, Ask, Ready }
    val last = ""
    val busy = false
    fun state(@Suppress("UNUSED_PARAMETER") ctx: Context) = State.Missing
    fun grant(@Suppress("UNUSED_PARAMETER") ctx: Context, @Suppress("UNUSED_PARAMETER") core: Core) {}
}
