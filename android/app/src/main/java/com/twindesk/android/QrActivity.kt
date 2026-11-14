// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Pairing by the computer's QR code (Connection › Pair with a QR code there), next to Nearby and
// the code, which stay as they are: twindesk://pair?id=…&n=<name>&a=<address,address>&p=<port>&k=<nonce>.
// Reached two ways: the phone's camera app opening the link, or Scan QR code in TwinDesk (Google's
// code scanner, where the phone has it). Then Core.connectQr: the first address that answers, and
// only Allow on the computer (its nonce), or a computer already paired just connects.
package com.twindesk.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast

class QrActivity : Activity() {
    companion object {
        // A scanned text: true when it was TwinDesk's and it's going.
        fun open(ctx: Context, text: String): Boolean {
            val u = runCatching { Uri.parse(text.trim()) }.getOrNull() ?: return false
            if (u.scheme != "twindesk" || u.host != "pair") return false
            ctx.startActivity(Intent(ctx, QrActivity::class.java).setData(u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return true
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val u = intent?.data
        val id = u?.getQueryParameter("id").orEmpty().take(64)
        val port = u?.getQueryParameter("p")?.toIntOrNull() ?: 0
        val addrs = u?.getQueryParameter("a").orEmpty().split(',').map { it.trim() }.filter { it.matches(Regex("[0-9a-fA-F.:]{3,45}")) }.take(6)
        val nonce = u?.getQueryParameter("k").orEmpty().take(64)
        val name = u?.getQueryParameter("n").orEmpty().take(64)
        if (u?.scheme != "twindesk" || id.isEmpty() || addrs.isEmpty() || port !in 1..65535) {
            Toast.makeText(this, tr("That isn’t a TwinDesk pairing code"), Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        runCatching { TwinService.start(this) }
        val core = Core.get(this)
        core.bg.execute {
            val ok = core.connectQr(id, addrs, port, nonce, name)
            runOnUiThread {
                Toast.makeText(this, if (ok) tr("Pairing with {name}. Allow it there.", "name" to (name.ifEmpty { tr("your computer") })) else tr("Can’t reach {name}. Is the phone on the same Wi-Fi?", "name" to (name.ifEmpty { tr("the computer") })), Toast.LENGTH_LONG).show()
                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                finish()
            }
        }
    }
}
