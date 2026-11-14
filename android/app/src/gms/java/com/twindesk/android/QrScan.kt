// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Scan QR code in the GitHub builds (standard, full): Google's code scanner, which needs no camera
// permission. False when it can't start; onFail when the phone doesn't have it (MainActivity.scanQr).
package com.twindesk.android

import android.content.Context
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

object QrScan {
    fun start(ctx: Context, onCode: (String) -> Unit, onFail: () -> Unit): Boolean {
        val opts = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(ctx, opts).startScan()
            .addOnSuccessListener { b -> onCode(b.rawValue.orEmpty()) }
            .addOnFailureListener { onFail() }
        return true
    }
}
