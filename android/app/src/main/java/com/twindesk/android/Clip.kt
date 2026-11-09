// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard text and pictures both ways. The computer's copies land on the phone's clipboard at
// once (apps may write the clipboard from the background). Android lets only the app in front read
// it, so the phone's copies go over while TwinDesk is open, from the share sheet and the Quick
// Settings tile; with wireless debugging on, the Mac also follows the phone's clipboard itself
// (scrcpy, text only).
// Pictures (clip.image + clip.image.part, shared/clipimage.js): a PNG of up to 10 MB in pieces,
// only while "Pictures" is on on both sides (clip.policy images), never through Bluetooth. Ours
// land on the clipboard from a file in our cache; this device's screenshots go the same way
// (Screenshots.kt).
package com.twindesk.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.min
import kotlin.math.sqrt

class Clip(core: Core) : Feature(core) {
    private val cm get() = core.ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private val main = Handler(Looper.getMainLooper())
    @Volatile var peerAccepts = false; private set
    @Volatile var peerImages = false; private set // the computer takes pictures (its clip.policy)
    @Volatile var lastIn: String? = null; private set
    @Volatile var lastOut: String? = null; private set
    val history = ArrayDeque<Item>() // newest first

    // A Recent item: text, or a picture (its file in our cache, copied again by its address).
    data class Item(val dir: String, val text: String, val picture: Uri? = null)

    // Pictures are put together and sent one at a time, off the main thread.
    private val pics = Executors.newSingleThreadExecutor { r -> Thread(r, "td-clip-pic").apply { isDaemon = true } }
    private var inPic: PicIn? = null // being put together (pics thread only)
    @Volatile private var outId = "" // the picture going out; a newer copy stops it

    private class PicIn(val id: String, val w: Int, val h: Int, val bytes: Int, val parts: Int, val shot: Boolean, val at: Long) {
        val buf = ByteArrayOutputStream(bytes)
        var got = 0
    }

    init {
        core.ctx.mainExecutor.execute {
            cm.addPrimaryClipChangedListener { if (core.sync.get("clipboard", "out")) sendCurrent(false) }
        }
    }

    // Clipboard › Pictures here: the computer's pictures land on this clipboard, and this device's go there.
    val picturesOn: Boolean get() = core.store.flag("clip.images", false)
    fun setPictures(v: Boolean) {
        core.store.setFlag("clip.images", v)
        sendPolicy()
        core.changed()
    }

    // A picture of ours would go now.
    val canSendPictures: Boolean get() = picturesOn && peerImages && core.sync.get("clipboard", "out") && core.link.connected && !core.link.ble

    fun sendPolicy() {
        val accept = core.sync.get("clipboard", "in")
        core.send(msg(Proto.T.CLIP_POLICY, "accept" to accept, "images" to (accept && picturesOn)))
    }

    override fun onWelcome(host: Host) {
        peerAccepts = false
        peerImages = false
        sendPolicy()
    }

    override fun onClosed() {
        peerAccepts = false
        peerImages = false
        outId = ""
        pics.execute { inPic = null }
    }

    // What is on the clipboard now goes to the computer (works while we are in front, or from
    // the share sheet / tile, which bring us to the front for a moment).
    fun sendCurrent(force: Boolean): Boolean {
        val clip = runCatching { cm.primaryClip?.takeIf { it.itemCount > 0 } }.getOrNull() ?: return false
        val item = clip.getItemAt(0)
        // A picture or files on the clipboard (files copied from the computer, a screenshot): no
        // text to send. coerceToText would make one of their content:// address, which would
        // replace the computer's clipboard. A picture goes as one with Pictures on.
        if (item.text == null && item.htmlText == null) {
            val uri = item.uri ?: return false
            val mime = clip.description.takeIf { it.mimeTypeCount > 0 }?.getMimeType(0) ?: core.ctx.contentResolver.getType(uri) ?: ""
            if (!mime.startsWith("image/") || uri.authority == "${core.ctx.packageName}.files" || !canSendPictures) return false
            pics.execute {
                runCatching { toPng(core.ctx.contentResolver, uri, mime, -1) }
                    .onFailure { Log.w("TwinDesk", "clipboard picture: ${it.message}") }
                    .getOrNull()?.let { sendPicture(it, false) }
            }
            return true
        }
        val text = runCatching { item.coerceToText(core.ctx)?.toString() }.getOrNull() ?: return false
        return sendText(text, force)
    }

    fun sendText(text: String, force: Boolean = true): Boolean {
        runCatching { core.peer.clipOut(text) } // a phone connected with Connect with Android too (Peer.kt)
        if (!core.link.connected || text.isEmpty()) return false
        if (!force && (text == lastOut || text == lastIn)) return false
        if (text.toByteArray().size > Proto.CLIP_MAX_BYTES) return false
        if (!force && !peerAccepts) return false
        outId = "" // a picture still going is out of date
        lastOut = text
        remember(Item("out", text))
        core.send(msg(Proto.T.CLIP, "text" to text))
        core.changed()
        return true
    }

    // A PNG to the computer, in pieces as the socket drains (the mouse and keys never wait behind
    // it). Call off the main thread. False when a newer copy took its place or the link went.
    fun sendPicture(p: Png, shot: Boolean): Boolean {
        if (!canSendPictures || p.bytes.size > Proto.CLIP_IMAGE_MAX_BYTES) return false
        val id = Proto.randomHex(8)
        outId = id
        val part = Proto.CLIP_IMAGE_PART_BYTES
        val parts = (p.bytes.size + part - 1) / part
        val live = { outId == id && canSendPictures }
        core.send(msg(Proto.T.CLIP_IMAGE, "id" to id, "w" to p.w, "h" to p.h, "bytes" to p.bytes.size, "parts" to parts).apply { if (shot) put("shot", true) })
        for (i in 0 until parts) {
            while (core.link.queued() > 512 * 1024) {
                if (!live()) return false
                Thread.sleep(10)
            }
            if (!live()) return false
            val from = i * part
            core.send(msg(Proto.T.CLIP_IMAGE_PART, "id" to id, "i" to i, "data" to Base64.encodeToString(p.bytes, from, min(part, p.bytes.size - from), Base64.NO_WRAP)))
        }
        if (outId == id) outId = ""
        remember(Item("out", "${if (shot) tr("Screenshot") else tr("Picture")} · ${p.w} × ${p.h}"))
        core.changed()
        return true
    }

    // The computer's copy (text) here, as if copied on the phone.
    fun receiveText(text: String) {
        lastIn = text
        remember(Item("in", text))
        cm.setPrimaryClip(ClipData.newPlainText("TwinDesk", text))
        core.changed()
    }

    // A Recent item back on this clipboard.
    fun copyAgain(item: Item) {
        val uri = item.picture
        if (uri != null) runCatching { cm.setPrimaryClip(ClipData.newUri(core.ctx.contentResolver, "Picture", uri)) }
        else cm.setPrimaryClip(ClipData.newPlainText("TwinDesk", item.text))
    }

    private fun remember(item: Item) {
        main.post {
            if (item.picture == null) history.removeAll { it.picture == null && it.text == item.text }
            history.addFirst(item)
            while (history.size > 20) history.removeLast()
            core.changed()
        }
    }

    // ---- pictures in (pics thread) ----

    private fun header(m: JSONObject) {
        inPic = null
        val id = m.optString("id")
        if (id.isEmpty() || id.length > 128) return
        val w = m.optInt("w").coerceIn(0, 65535)
        val h = m.optInt("h").coerceIn(0, 65535)
        val shot = m.optBoolean("shot")
        val inline = m.optString("png")
        if (inline.isNotEmpty()) { // whole, in the message (Multi-device's form)
            if (inline.length > (Proto.CLIP_IMAGE_MAX_BYTES * 4L + 2) / 3 + 8) return
            val png = runCatching { Base64.decode(inline, Base64.DEFAULT) }.getOrNull() ?: return
            if (png.size <= Proto.CLIP_IMAGE_MAX_BYTES && isPng(png)) receivePicture(png, w, h, shot)
            return
        }
        val bytes = m.optInt("bytes")
        val parts = m.optInt("parts")
        if (bytes < 9 || bytes > Proto.CLIP_IMAGE_MAX_BYTES || parts != (bytes + Proto.CLIP_IMAGE_PART_BYTES - 1) / Proto.CLIP_IMAGE_PART_BYTES) return
        inPic = PicIn(id, w, h, bytes, parts, shot, System.currentTimeMillis())
    }

    private fun part(m: JSONObject) {
        val c = inPic ?: return
        if (m.optString("id") != c.id) return
        val data = m.optString("data")
        if (m.optInt("i", -1) != c.got || data.isEmpty() || data.length > (Proto.CLIP_IMAGE_PART_BYTES * 4 + 2) / 3 + 8 || System.currentTimeMillis() - c.at > 60000) {
            inPic = null
            return
        }
        val b = runCatching { Base64.decode(data, Base64.DEFAULT) }.getOrNull()
        if (b == null || c.buf.size() + b.size > c.bytes || (c.got + 1 < c.parts && b.size != Proto.CLIP_IMAGE_PART_BYTES)) {
            inPic = null
            return
        }
        c.buf.write(b)
        c.got++
        if (c.got < c.parts) return
        inPic = null
        val png = c.buf.toByteArray()
        if (png.size == c.bytes && isPng(png)) receivePicture(png, c.w, c.h, c.shot)
    }

    // On this clipboard: a file in our cache, which the clipboard hands to the app that pastes.
    private fun receivePicture(png: ByteArray, w: Int, h: Int, shot: Boolean) {
        if (!core.sync.get("clipboard", "in") || !picturesOn) return
        outId = "" // theirs is newer than a picture of ours still going
        try {
            val dir = File(core.ctx.cacheDir, "clip/pictures").apply { mkdirs() }
            // Keep the last few (a paste may come later, Recent copies them again); older ones go.
            dir.listFiles()?.sortedByDescending { it.lastModified() }?.drop(8)?.forEach { it.delete() }
            val file = File(dir, "${if (shot) "Screenshot" else "Picture"}-${System.currentTimeMillis()}.png").also { it.writeBytes(png) }
            val uri = FileProvider.getUriForFile(core.ctx, "${core.ctx.packageName}.files", file)
            main.post {
                runCatching { cm.setPrimaryClip(ClipData.newUri(core.ctx.contentResolver, if (shot) "Screenshot" else "Picture", uri)) }
                    .onFailure { Log.w("TwinDesk", "picture from the computer: ${it.message}") }
            }
            val size = if (w > 0 && h > 0) "$w × $h" else "${png.size / 1024} KB"
            remember(Item("in", "${if (shot) tr("Screenshot") else tr("Picture")} · $size", uri))
        } catch (e: Exception) {
            Log.w("TwinDesk", "picture from the computer: ${e.message}")
        }
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.CLIP_POLICY -> {
                peerAccepts = m.optBoolean("accept")
                peerImages = m.optBoolean("images")
            }
            Proto.T.CLIP -> {
                outId = ""
                pics.execute { inPic = null }
                val text = m.optString("text")
                if (core.sync.get("clipboard", "in") && text.isNotEmpty() && text.toByteArray().size <= Proto.CLIP_MAX_BYTES) receiveText(text)
            }
            Proto.T.CLIP_IMAGE -> pics.execute { header(m) }
            Proto.T.CLIP_IMAGE_PART -> pics.execute { part(m) }
            else -> return false
        }
        core.changed()
        return true
    }

    class Png(val bytes: ByteArray, val w: Int, val h: Int)

    companion object {
        private val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        fun isPng(b: ByteArray) = b.size > 8 && (0 until 8).all { b[it] == PNG_SIGNATURE[it] }

        // A picture as a PNG of at most CLIP_IMAGE_MAX_BYTES: a PNG as it is, anything else (a JPEG
        // or WebP screenshot) encoded again, made smaller while it is too big. size: -1 if not known.
        fun toPng(cr: ContentResolver, uri: Uri, mime: String, size: Long): Png? {
            if (mime == "image/png" && size <= Proto.CLIP_IMAGE_MAX_BYTES) {
                val b = cr.openInputStream(uri)?.use { it.readBytes() } ?: return null
                if (b.size <= Proto.CLIP_IMAGE_MAX_BYTES && isPng(b)) {
                    val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(b, 0, b.size, o)
                    return Png(b, o.outWidth.coerceAtLeast(0), o.outHeight.coerceAtLeast(0))
                }
            }
            var bmp = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: return null
            try {
                for (i in 0 until 5) {
                    val out = ByteArrayOutputStream()
                    bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
                    if (out.size() <= Proto.CLIP_IMAGE_MAX_BYTES) return Png(out.toByteArray(), bmp.width, bmp.height)
                    val k = sqrt(Proto.CLIP_IMAGE_MAX_BYTES.toDouble() / out.size()) * 0.9
                    val smaller = Bitmap.createScaledBitmap(bmp, (bmp.width * k).toInt().coerceAtLeast(1), (bmp.height * k).toInt().coerceAtLeast(1), true)
                    if (smaller !== bmp) bmp.recycle()
                    bmp = smaller
                }
            } finally {
                bmp.recycle()
            }
            return null
        }
    }
}
