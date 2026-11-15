// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A banking app's "with banking pause" home screen shortcut (BankGuard.pinShortcut): switches off what
// banking apps mind, opens the app, and TwinDesk closes. Nothing shows.
package com.twindesk.android

import android.app.Activity
import android.os.Bundle

class BankLaunchActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pkg = intent.getStringExtra("pkg").orEmpty()
        if (pkg.isNotEmpty()) Core.get(this).bank.openPaused(pkg)
        finish()
    }
}
