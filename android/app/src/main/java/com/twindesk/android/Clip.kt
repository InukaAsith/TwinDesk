// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard text both ways, across every connected computer (docs/mesh.md: one pool). A copy goes to
// the computers that accept clipboard from us; a clip from any computer is applied once and relayed by
// the Pool. The computers' copies land on the phone's clipboard at once (apps may write the clipboard
// from the background). Android lets only the app in front read it, so the phone's copies go over
// while TwinDesk is open, from the share sheet and the Quick Settings tile; with wireless debugging on,
// the Mac also follows the phone's clipboard itself (scrcpy).
package com.twindesk.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

class Clip(core: Core) : Feature(core) {
    private val cm get() = core.ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    // What each computer said it accepts from us (its clip.policy). A computer that has not said is
    // sent our copies only when the user sends them (sendText with force).
    private val accepts = ConcurrentHashMap<String, Boolean>()
    private val pool = Pool(core.store.deviceId, { core.poolPeers { accepts[it] != false } })
    @Volatile var lastIn: String? = null; private set
    @Volatile var lastOut: String? = null; private set
    val history = ArrayDeque<Pair<String, String>>() // (dir, text), newest first

    // Some connected computer accepts clipboard from us (the automatic copies go only then).
    val peerAccepts: Boolean get() = core.links.connectedLinks().any { accepts[it.hostId] == true }

    init {
        core.ctx.mainExecutor.execute {
            cm.addPrimaryClipChangedListener { if (core.sync.get("clipboard", "out")) sendCurrent(false) }
        }
    }

    private fun policy(): JSONObject = msg(Proto.T.CLIP_POLICY, "accept" to core.sync.get("clipboard", "in"))

    fun sendPolicy() = core.sendAll(policy())

    override fun onPeerWelcome(host: Host) {
        accepts.remove(host.id)
        core.sendTo(host.id, policy())
    }

    override fun onPeerClosed(host: Host) {
        accepts.remove(host.id)
    }

    // What is on the clipboard now goes to the computers (works while we are in front, or from
    // the share sheet / tile, which bring us to the front for a moment).
    fun sendCurrent(force: Boolean): Boolean {
        val text = runCatching { cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(core.ctx)?.toString() }.getOrNull()
            ?: return false
        return sendText(text, force)
    }

    fun sendText(text: String, force: Boolean = true): Boolean {
        if (core.links.connectedLinks().isEmpty() || text.isEmpty()) return false
        if (!force && (text == lastOut || text == lastIn)) return false
        if (text.toByteArray().size > Proto.CLIP_MAX_BYTES) return false
        if (!force && !peerAccepts) return false
        if (pool.publish(mapOf("t" to Proto.T.CLIP, "text" to text)).sent.isEmpty()) return false
        lastOut = text
        remember("out", text)
        core.changed()
        return true
    }

    // A computer's copy (text) here, as if copied on the phone.
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

    override fun onMessage(t: String, m: JSONObject, host: Host): Boolean {
        when (t) {
            Proto.T.CLIP_POLICY -> accepts[host.id] = m.optBoolean("accept")
            Proto.T.CLIP -> onClip(m, host)
            else -> return false
        }
        core.changed()
        return true
    }

    // A clip from a computer, applied once and relayed by the pool. With clipboard "in" off here it is
    // neither applied nor relayed.
    private fun onClip(m: JSONObject, host: Host) {
        if (!core.sync.get("clipboard", "in")) return
        val text = m.optString("text")
        if (text.isEmpty() || text.toByteArray().size > Proto.CLIP_MAX_BYTES) return
        val r = pool.receive(host.id, m.toPoolMsg())
        if (r.fresh) receiveText(text)
    }
}
