// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard text both ways. The computer's copies land on the phone's clipboard at once (apps
// may write the clipboard from the background). Android lets only the app in front read it, so
// the phone's copies go over while TwinDesk is open, from the share sheet and the Quick Settings
// tile; with wireless debugging on, the Mac also follows the phone's clipboard itself (scrcpy).
package com.twindesk.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import org.json.JSONObject

class Clip(core: Core) : Feature(core) {
    private val cm get() = core.ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    @Volatile var peerAccepts = false; private set
    @Volatile var lastIn: String? = null; private set
    @Volatile var lastOut: String? = null; private set
    val history = ArrayDeque<Pair<String, String>>() // (dir, text), newest first

    init {
        core.ctx.mainExecutor.execute {
            cm.addPrimaryClipChangedListener { if (core.sync.get("clipboard", "out")) sendCurrent(false) }
        }
    }

    fun sendPolicy() {
        core.send(msg(Proto.T.CLIP_POLICY, "accept" to core.sync.get("clipboard", "in")))
    }

    override fun onWelcome(host: Host) {
        peerAccepts = false
        sendPolicy()
    }

    override fun onClosed() {
        peerAccepts = false
    }

    // What is on the clipboard now goes to the computer (works while we are in front, or from
    // the share sheet / tile, which bring us to the front for a moment).
    fun sendCurrent(force: Boolean): Boolean {
        val item = runCatching { cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0) }.getOrNull() ?: return false
        // A picture or files on the clipboard (files copied from the computer, a screenshot): no
        // text to send. coerceToText would make one of their content:// address, which would
        // replace the computer's clipboard.
        if (item.text == null && item.htmlText == null) return false
        val text = runCatching { item.coerceToText(core.ctx)?.toString() }.getOrNull() ?: return false
        return sendText(text, force)
    }

    fun sendText(text: String, force: Boolean = true): Boolean {
        if (!core.link.connected || text.isEmpty()) return false
        if (!force && (text == lastOut || text == lastIn)) return false
        if (text.toByteArray().size > Proto.CLIP_MAX_BYTES) return false
        if (!force && !peerAccepts) return false
        lastOut = text
        remember("out", text)
        core.send(msg(Proto.T.CLIP, "text" to text))
        core.changed()
        return true
    }

    // The computer's copy (text) here, as if copied on the phone.
    fun receiveText(text: String) {
        lastIn = text
        remember("in", text)
        cm.setPrimaryClip(ClipData.newPlainText("TwinDesk", text))
        core.changed()
    }

    private fun remember(dir: String, text: String) {
        history.removeAll { it.second == text }
        history.addFirst(dir to text)
        while (history.size > 20) history.removeLast()
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.CLIP_POLICY -> peerAccepts = m.optBoolean("accept")
            Proto.T.CLIP -> {
                val text = m.optString("text")
                if (core.sync.get("clipboard", "in") && text.isNotEmpty() && text.toByteArray().size <= Proto.CLIP_MAX_BYTES) receiveText(text)
            }
            else -> return false
        }
        core.changed()
        return true
    }
}
