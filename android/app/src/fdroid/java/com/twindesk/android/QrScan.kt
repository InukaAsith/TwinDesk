// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Scan QR code in the F-Droid build: no Google code scanner (proprietary), so MainActivity.scanQr
// opens the Camera app, which opens twindesk:// pairing links in TwinDesk (QrActivity).
package com.twindesk.android

import android.content.Context

object QrScan {
    @Suppress("UNUSED_PARAMETER")
    fun start(ctx: Context, onCode: (String) -> Unit, onFail: () -> Unit): Boolean = false
}
