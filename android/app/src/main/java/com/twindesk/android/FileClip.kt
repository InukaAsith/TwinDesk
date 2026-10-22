// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files with the computer's shortcuts (mac/fclip.js):
//   The computer copied files (⌃⌥C): `fclip.offer` → a notification here, "Copy to clipboard" or
//   "Save to Downloads". Copy fetches them (`fclip.paste`, then a 'paste' batch) and puts them on
//   the clipboard as content: links, so they paste natively into any app that takes files; the
//   notification also offers Share. Save puts them in Download/TwinDesk.
//   The phone copies files ("Copy to computer" in the share sheet): our `fclip.offer`; when the
//   computer pastes (⌃⌥V), its `fclip.paste` asks for them and they go as a 'paste' batch.
package com.twindesk.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.util.UUID

class FileClip(core: Core) : Feature(core) {
    data class Offer(val id: String, val names: List<String>, val files: Int, val bytes: Long, val at: Long)

    @Volatile var incoming: Offer? = null; private set // theirs
    @Volatile var ours: Pair<String, List<Files.Item>>? = null; private set // (id, items) copied here
    @Volatile var status = ""; private set

    private val clipDir get() = File(core.ctx.cacheDir, "clip")

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.FCLIP_OFFER -> {
                val items = m.optJSONArray("items") ?: return true
                val names = (0 until minOf(items.length(), 1000)).map { items.getJSONObject(it).optString("name").take(200) }
                val o = Offer(m.optString("id"), names, m.optInt("files"), m.optLong("bytes"), System.currentTimeMillis())
                if (o.id.isEmpty()) return true
                incoming = o
                Notify.fclipOffer(core.ctx, core.host?.name ?: "your computer", "${describe(o)} · ${size(o.bytes)}", o.id)
            }
            Proto.T.FCLIP_GONE -> {
                if (incoming?.id == m.optString("id")) {
                    incoming = null
                    Notify.cancelFclip(core.ctx)
                }
            }
            // The Mac's paste shortcut while its keyboard is on the phone: its copied files onto our clipboard.
            Proto.T.FCLIP_KEY -> {
                if (m.optString("action") == "paste") incoming?.let { fetch(it.id, save = false) }
            }
            Proto.T.FCLIP_PASTE -> {
                val (id, items) = ours ?: return true
                if (m.optString("id") != id) {
                    core.send(msg(Proto.T.FCLIP_GONE, "id" to m.optString("id")))
                    return true
                }
                core.files.send(items, "paste", id)
            }
            else -> return false
        }
        core.changed()
        return true
    }

    override fun onClosed() {
        if (incoming != null) Notify.cancelFclip(core.ctx)
        incoming = null
    }

    private fun describe(o: Offer) = if (o.names.size == 1) o.names[0] else "${o.names.size} items"

    // "Copy to clipboard" / "Save to Downloads" on the computer's copy.
    fun fetch(id: String, save: Boolean) {
        val o = incoming
        if (o == null || o.id != id || !core.link.connected) {
            Notify.fclipReady(core.ctx, "Nothing to copy any more", "Copy the files again on your computer.", null)
            return
        }
        val from = core.host?.name ?: "your computer"
        if (save) {
            core.files.expect(id, Files.Target(true))
        } else {
            val dir = File(clipDir, id)
            clipDir.deleteRecursively() // only the newest copy stays
            dir.mkdirs()
            core.files.expect(id, Files.Target(false, dir) { b -> onCopied(o, b, from) })
        }
        status = if (save) "Saving ${describe(o)}…" else "Copying ${describe(o)}…"
        core.send(msg(Proto.T.FCLIP_PASTE, "id" to id))
        Notify.fclipProgress(core.ctx, "${if (save) "Saving" else "Copying"} ${describe(o)} from $from", -1)
        core.changed()
    }

    private fun onCopied(o: Offer, b: Files.Batch, from: String) {
        if (!b.ok || b.placed.isEmpty()) {
            status = "Copy failed"
            Notify.fclipReady(core.ctx, "Couldn’t copy ${describe(o)}", "Not everything arrived from $from.", null)
            return
        }
        val cr = core.ctx.contentResolver
        val clip = ClipData.newUri(cr, describe(o), b.placed[0].first)
        for ((uri, _) in b.placed.drop(1)) clip.addItem(cr, ClipData.Item(uri))
        (core.ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
        status = "${describe(o)} copied"
        val share = if (b.placed.size == 1) {
            Intent(Intent.ACTION_SEND).setType(b.placed[0].second ?: "*/*").putExtra(Intent.EXTRA_STREAM, b.placed[0].first)
        } else {
            Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*").putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList<Uri>(b.placed.map { it.first }))
        }.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        Notify.fclipReady(core.ctx, "${describe(o)} copied", "Paste it in any app, or share it.", share)
        incoming = null
        core.changed()
    }

    // "Copy to computer" from the share sheet: the computer pastes with its shortcut.
    fun copy(items: List<Files.Item>): Boolean {
        if (!core.link.connected || items.isEmpty()) return false
        val id = UUID.randomUUID().toString()
        ours?.let { core.send(msg(Proto.T.FCLIP_GONE, "id" to it.first)) }
        ours = id to items
        val arr = jsonArray(items.map { JSONObject().put("name", it.name).put("dir", false).put("size", it.size) })
        core.send(msg(Proto.T.FCLIP_OFFER, "id" to id, "items" to arr, "files" to items.size, "bytes" to items.sumOf { it.size }))
        core.changed()
        return true
    }

    companion object {
        fun size(n: Long) = when {
            n < 1024 -> "$n B"
            n < 1024 * 1024 -> "%.1f KB".format(n / 1024.0)
            n < 1024L * 1024 * 1024 -> "%.1f MB".format(n / 1048576.0)
            else -> "%.2f GB".format(n / 1073741824.0)
        }
    }
}
