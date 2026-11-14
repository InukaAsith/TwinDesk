// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The connected computer in Android's share sheet: a sharing shortcut ("Inukas-MBA") in the
// top row while it is connected, so sharing to it is one tap from any app (ShareActivity sends).
package com.twindesk.android

import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat

class Shortcuts(core: Core) : Feature(core) {
    private val category = "com.twindesk.android.SHARE_TARGET"

    override fun onWelcome(host: Host) {
        runCatching {
            val s = ShortcutInfoCompat.Builder(core.ctx, "send-${host.id}")
                .setShortLabel(host.name)
                .setLongLabel(tr("Send to {name}", "name" to host.name))
                .setIcon(IconCompat.createWithResource(core.ctx, R.mipmap.ic_launcher))
                .setCategories(setOf(category))
                .setLongLived(true)
                .setIntent(Intent(core.ctx, MainActivity::class.java).setAction(Intent.ACTION_VIEW))
                .build()
            ShortcutManagerCompat.removeAllDynamicShortcuts(core.ctx)
            ShortcutManagerCompat.pushDynamicShortcut(core.ctx, s)
        }
    }

    override fun onClosed() {
        runCatching { ShortcutManagerCompat.removeAllDynamicShortcuts(core.ctx) }
    }
}
