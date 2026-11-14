// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Modules (as on the computers, shared/modules.js): every page but Overview, Connection,
// General and About can be switched off. Off at start: its page isn't in the sidebar and its
// features hear nothing from the computer (Core.features). Applies after a restart, the
// process's set is read once (Core.modulesAtStart).
package com.twindesk.android

import android.content.Context
import android.content.Intent

object Modules {
    // Pages that are always there.
    val FIXED = setOf("overview", "connection", "general", "about")
    private const val KEY = "modules.off"

    fun off(store: Store): Set<String> = store.prefsSet(KEY)
    fun set(store: Store, id: String, on: Boolean) =
        store.setPrefsSet(KEY, if (on) off(store) - id else off(store) + id)

    // Start TwinDesk again so the switches apply (the process holds the set it started with).
    fun restart(ctx: Context) {
        val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
        ctx.startActivity(Intent.makeRestartActivityTask(i.component))
        Runtime.getRuntime().exit(0)
    }
}
