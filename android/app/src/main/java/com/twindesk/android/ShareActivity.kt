// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The share sheet's two targets, "Send to computer" and "Copy to computer" (the activity alias),
// and the see-through activity that reads the clipboard for a moment (Android lets only the app in
// front read it) for the Quick Settings tile and the notification's "Send clipboard".
package com.twindesk.android

import android.app.Activity
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.core.content.IntentCompat

class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val core = Core.get(this)
        val copy = intent.component?.className?.endsWith("CopyToComputer") == true
        val open = intent.component?.className?.endsWith("OpenOnComputer") == true
        val host = core.host
        // No computer, but another phone (Connect with Android): Send goes to it.
        if (host == null && !copy && !open && core.peer.connected) {
            val uris = when (intent.action) {
                Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
                Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
                else -> emptyList()
            }
            val text = intent.getStringExtra(Intent.EXTRA_TEXT)
            if (uris.isEmpty() && !text.isNullOrEmpty()) { core.peer.clipOut(text); toast(tr("Copied on {name}", "name" to core.peer.peerName)); return finish() }
            for (u in uris) runCatching { grantUriPermission(packageName, u, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            if (uris.isNotEmpty()) { core.peer.sendUris(uris); toast(tr("Sending {items} to {name}", "items" to trCount(uris.size, "item"), "name" to core.peer.peerName)) }
            return finish()
        }
        if (host == null) {
            toast(tr("Not connected. Open TwinDesk to connect to your computer."))
            return finish()
        }
        // ReZume's "Open on computer": the link opens there now.
        if (open) {
            val text = listOfNotNull(intent.getStringExtra(Intent.EXTRA_TEXT), intent.dataString).joinToString(" ")
            val why = core.rezume.pushUrl(text)
            toast(why ?: tr("Opening on {name}", "name" to host.name))
            return finish()
        }
        val uris = mutableListOf<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> {
                IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.add(it) }
                if (uris.isEmpty()) {
                    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
                    if (!text.isNullOrEmpty()) {
                        core.clip.sendText(text)
                        toast(tr("Copied on {name}", "name" to host.name))
                        return finish()
                    }
                }
            }
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.addAll(it) }
        }
        if (uris.isEmpty()) return finish()
        // The share's read grant ends with this activity; the files are read later, when the
        // computer accepts them. Keep a grant of our own until the process ends.
        for (u in uris) runCatching { grantUriPermission(packageName, u, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        // Reading names and sizes may take a moment for big shares; the URIs stay readable for us.
        core.bg.execute {
            val items = core.files.describe(uris)
            val ok = if (copy) core.fclip.copy(items) else core.files.send(items, "send")
            runOnUiThread {
                toast(
                    when {
                        !ok -> tr("Couldn’t send to {name}", "name" to host.name)
                        copy -> tr("Copied for {name}. Paste on it with ⌃⌥V", "name" to host.name)
                        else -> tr("Sending {items} to {name}", "items" to trCount(items.size, "item"), "name" to host.name)
                    },
                )
            }
        }
        finish()
    }

    private fun toast(t: String) = Toast.makeText(applicationContext, t, Toast.LENGTH_SHORT).show()
}

class ClipActivity : Activity() {
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) return
        val core = Core.get(this)
        val cm = getSystemService(ClipboardManager::class.java)
        val clip = cm.primaryClip
        val name = core.host?.name ?: tr("your computer")
        val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(this)?.toString() else null
        val uri = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri
        val msg = when {
            core.host == null -> tr("Not connected to your computer")
            uri != null -> {
                val items = core.files.describe((0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri })
                if (core.fclip.copy(items)) tr("Copied for {name}. Paste on it with ⌃⌥V", "name" to name) else tr("Couldn’t copy that")
            }
            text.isNullOrEmpty() -> tr("The clipboard is empty")
            core.clip.sendText(text) -> tr("Clipboard sent to {name}", "name" to name)
            else -> tr("Couldn’t send the clipboard")
        }
        Toast.makeText(applicationContext, msg, Toast.LENGTH_SHORT).show()
        finish()
    }
}

// ReZume's notification tapped: the computer's tab opens here, or its document comes (Rezume.kt).
// See-through and gone at once: Android lets an activity in front open things.
class RezumeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val r = Core.get(this).rezume
        val o = r.incoming
        if (o != null && o.id == intent.getStringExtra("id")) {
            r.take(o, this)
            if (o.kind == "doc") toast(tr("Getting {name}…", "name" to o.name))
        } else toast(tr("That isn’t offered any more"))
        finish()
    }

    private fun toast(t: String) = Toast.makeText(applicationContext, t, Toast.LENGTH_SHORT).show()
}

// The home screen shortcut "Wireless debugging": on at once if the Mac granted it, else the setting.
class AdbActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val core = Core.get(this)
        if (core.adb.enable(true, byPerson = true)) {
            core.adb.sendState()
            Toast.makeText(applicationContext, tr("Wireless debugging is on"), Toast.LENGTH_SHORT).show()
        } else core.adb.openSettings()
        finish()
    }
}
