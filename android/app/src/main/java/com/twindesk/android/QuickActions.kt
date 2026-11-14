// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The buttons on TwinDesk's notification while connected (General › Notification buttons): any
// three of these, each switched on or off. Android shows three buttons on a notification. Buttons
// that open a screen (the clipboard, a file picker, the touchpad) start it straight from the
// notification (Android 12 and later block a receiver from doing it); the rest go to ActionReceiver.
package com.twindesk.android

import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Toast

object QuickActions {
    class Btn(val id: String, val label: String, val hint: String)

    const val MAX = 3
    val ALL get() = listOf(
        Btn("clip", tr("Send clipboard"), tr("Sends this phone’s clipboard to the computer")),
        Btn("files", tr("Send files"), tr("Opens the file picker")),
        Btn("remote", tr("Touchpad"), tr("Opens the Remote’s touchpad and keyboard")),
        Btn("media", tr("Play/Pause"), tr("Media playing on the computer")),
        Btn("ring", tr("Ring computer"), tr("Plays a sound on the computer")),
        Btn("lock", tr("Lock computer"), tr("Locks the computer’s screen")),
        Btn("disconnect", tr("Disconnect"), tr("Ends the connection")),
        Btn("exit", tr("Exit"), tr("Closes TwinDesk until it’s opened again")),
    )
    private val DEFAULT = listOf("clip", "disconnect", "exit")

    fun chosen(core: Core): List<String> {
        val v = core.store.prefsString("notif.buttons", "")
        if (v.isEmpty()) return DEFAULT
        return v.split(',').filter { id -> ALL.any { it.id == id } }.take(MAX)
    }

    fun key(core: Core) = core.store.prefsString("notif.buttons", "")

    // On: added at the end (refused when three are on already); off: taken out.
    fun set(core: Core, id: String, on: Boolean): Boolean {
        val now = chosen(core)
        val next = if (on) { if (id in now) now else if (now.size >= MAX) return false else now + id } else now - id
        core.store.setPrefsString("notif.buttons", next.joinToString(",").ifEmpty { "none" })
        core.changed()
        return true
    }

    // The connected notification's buttons, in the order chosen.
    fun actions(ctx: Context, core: Core): List<Notification.Action> = chosen(core).mapNotNull { id ->
        val label = ALL.first { it.id == id }.label
        val pi: PendingIntent = when (id) {
            "clip" -> activity(ctx, 30, Intent(ctx, ClipActivity::class.java))
            "files" -> activity(ctx, 31, Intent(ctx, PickActivity::class.java))
            "remote" -> activity(ctx, 32, Intent(ctx, RemoteActivity::class.java).putExtra("mode", "pad"))
            "media" -> Notify.action(ctx, ActionReceiver.PC_MEDIA, 33, "toggle")
            "ring" -> Notify.action(ctx, ActionReceiver.RING_PC, 34)
            "lock" -> Notify.action(ctx, ActionReceiver.LOCK_PC, 35)
            "disconnect" -> Notify.action(ctx, ActionReceiver.DISCONNECT, 12)
            "exit" -> Notify.action(ctx, ActionReceiver.EXIT, 15)
            else -> return@mapNotNull null
        }
        Notification.Action.Builder(null, label, pi).build()
    }

    private fun activity(ctx: Context, req: Int, i: Intent): PendingIntent =
        PendingIntent.getActivity(ctx, req, i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
}

// The notification's Send files: Android's file picker, then the files go to the computer (as Send).
class PickActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return
        val core = Core.get(this)
        if (core.host == null) {
            Toast.makeText(applicationContext, tr("Not connected to your computer"), Toast.LENGTH_SHORT).show()
            return finish()
        }
        val i = Intent(Intent.ACTION_GET_CONTENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        runCatching { startActivityForResult(i, 1) }.onFailure { finish() }
    }

    @Deprecated("Activity result API: a see-through activity with no Compose")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        val uris = buildList {
            data?.clipData?.let { c -> for (k in 0 until c.itemCount) add(c.getItemAt(k).uri) }
            if (isEmpty()) data?.data?.let { add(it) }
        }
        if (resultCode == RESULT_OK && uris.isNotEmpty()) {
            val core = Core.get(this)
            core.files.send(core.files.describe(uris), "send")
            Toast.makeText(applicationContext, tr("Sending to {name}", "name" to (core.host?.name ?: tr("your computer"))), Toast.LENGTH_SHORT).show()
        }
        finish()
    }
}
