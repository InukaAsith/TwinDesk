// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Screenshots both ways with the computer, onto the other device's clipboard (clip.image, the
// format of shared/clipsync.js: a PNG with its id, width and height; one-to-one, so no `o`).
// A screenshot taken here goes to the computer, which puts it on its clipboard (and saves it only
// if set to there). Android tells apps in the background nothing about screenshots, so while
// connected we watch the photo library for a new picture in a Screenshots folder (needs photo
// access, or the All files access the computer may have had granted). The computer's arrive on
// this clipboard, kept in our cache, and in Pictures › TwinDesk only with "Also save" (pictures
// there are never sent back). Never through Bluetooth: a picture is megabytes. Only TwinDesk for
// Windows takes them so far (windows/phone-shots.js), so nothing goes to a Mac or Linux.
package com.twindesk.android

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.BaseColumns
import android.provider.MediaStore
import android.provider.MediaStore.MediaColumns as C
import android.util.Base64
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.sqrt

class Screenshots(core: Core) : Feature(core) {
    private val main = Handler(Looper.getMainLooper())
    private var observer: ContentObserver? = null
    private val seen = LinkedHashSet<Long>() // photo library ids looked at already
    @Volatile var lastSent = ""; private set // the last one's name, for the Clipboard page
    @Volatile var lastIn = ""; private set // the last one from the computer

    // This device's screenshots to the computer.
    val on: Boolean get() = core.store.flag("screenshots.out", true)
    fun setOn(v: Boolean) { core.store.setFlag("screenshots.out", v); watch(); core.changed() }
    // The computer's onto this clipboard; and also into Pictures › TwinDesk.
    val receive: Boolean get() = core.store.flag("screenshots.in", true)
    fun setReceive(v: Boolean) { core.store.setFlag("screenshots.in", v); core.changed() }
    val save: Boolean get() = core.store.flag("screenshots.save", false)
    fun setSave(v: Boolean) { core.store.setFlag("screenshots.save", v); core.changed() }

    // The photo permission this Android asks for (13 and later: Photos; before: storage).
    val permission: String get() = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
    val canRead: Boolean get() = (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) ||
        core.ctx.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    // Only TwinDesk for Windows takes them so far.
    val computerTakes: Boolean get() = (core.host ?: core.hosts().firstOrNull())?.os == "win"

    private val look = Runnable { core.bg.execute { runCatching { send() }.onFailure { Log.w("TwinDesk", "screenshot: ${it.message}") } } }

    override fun onWelcome(host: Host) = watch()
    override fun onClosed() = watch()

    // The photo library is watched only while connected with "Screenshots go to" on: a screenshot is
    // written, then marked done, so one look once the changes settle.
    fun watch() {
        val want = on && core.link.connected
        synchronized(this) {
            if (want && observer == null) {
                val o = object : ContentObserver(main) {
                    override fun onChange(selfChange: Boolean, uri: Uri?) {
                        main.removeCallbacks(look)
                        main.postDelayed(look, SETTLE_MS)
                    }
                }
                runCatching {
                    core.ctx.contentResolver.registerContentObserver(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, o)
                    observer = o
                }.onFailure { Log.w("TwinDesk", "screenshots: ${it.message}") }
            } else if (!want && observer != null) {
                observer?.let { runCatching { core.ctx.contentResolver.unregisterContentObserver(it) } }
                observer = null
                main.removeCallbacks(look)
            }
        }
    }

    // The newest picture in a Screenshots folder from the last few seconds, if it's new: to the computer.
    private fun send() {
        if (!on || !core.sync.get("clipboard", "out") || !core.link.connected || core.link.ble) return
        if (!computerTakes || !core.clip.peerAccepts || !canRead) return
        val cr = core.ctx.contentResolver
        val cols = arrayOf(BaseColumns._ID, C.DISPLAY_NAME, C.MIME_TYPE, C.SIZE)
        // The same Screenshots as the Photos page (Media.kt); Pictures › TwinDesk (the computer's, saved here) never.
        val where = "${C.DATE_ADDED} >= ? AND ${C.IS_PENDING} = 0 AND " +
            "(${C.RELATIVE_PATH} LIKE ? OR ${C.BUCKET_DISPLAY_NAME} = ?) AND " +
            "(${C.RELATIVE_PATH} IS NULL OR ${C.RELATIVE_PATH} NOT LIKE ?)"
        val args = arrayOf((System.currentTimeMillis() / 1000 - FRESH_S).toString(), "%Screenshots%", "Screenshots", "%TwinDesk%")
        val found = cr.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cols, where, args, "${C.DATE_ADDED} DESC, ${BaseColumns._ID} DESC")?.use { c ->
            if (!c.moveToFirst()) null else Pic(c.getLong(0), c.getString(1) ?: "Screenshot", c.getString(2) ?: "", c.getLong(3))
        } ?: return
        synchronized(seen) {
            if (!seen.add(found.id)) return
            while (seen.size > 50) seen.remove(seen.first())
        }
        val shot = png(cr, ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, found.id), found.mime, found.size) ?: return
        val data = Base64.encodeToString(shot.bytes, Base64.NO_WRAP)
        // One message of up to ~11 MB: the socket closes past 16 MB queued, so wait for it to drain a little.
        val until = System.currentTimeMillis() + 10000
        while (core.link.queued() > 1024 * 1024 && System.currentTimeMillis() < until) Thread.sleep(10)
        if (!core.link.connected || core.link.ble || core.link.queued() > 1024 * 1024) return
        core.send(msg(Proto.T.CLIP_IMAGE, "id" to Proto.randomHex(8), "w" to shot.w, "h" to shot.h, "png" to data, "ts" to System.currentTimeMillis()))
        lastSent = found.name
        core.changed()
    }

    private class Pic(val id: Long, val name: String, val mime: String, val size: Long)
    private class Shot(val bytes: ByteArray, val w: Int, val h: Int)

    // As a PNG of at most CLIP_IMAGE_MAX_BYTES: a PNG as it is, anything else (a JPEG or WebP
    // screenshot) encoded again, made smaller while it is too big.
    private fun png(cr: ContentResolver, uri: Uri, mime: String, size: Long): Shot? {
        if (mime == "image/png" && size in 1..Proto.CLIP_IMAGE_MAX_BYTES.toLong()) {
            val b = cr.openInputStream(uri)?.use { it.readBytes() } ?: return null
            if (b.size <= Proto.CLIP_IMAGE_MAX_BYTES && isPng(b)) {
                val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(b, 0, b.size, o)
                return Shot(b, o.outWidth.coerceAtLeast(0), o.outHeight.coerceAtLeast(0))
            }
        }
        var bmp = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: return null
        try {
            for (i in 0 until 5) {
                val out = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
                if (out.size() <= Proto.CLIP_IMAGE_MAX_BYTES) return Shot(out.toByteArray(), bmp.width, bmp.height)
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

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t != Proto.T.CLIP_IMAGE) return false
        fromComputer(m)
        return true
    }

    // A screenshot from the computer, checked as shared/clipsync.js readImage checks it: onto this
    // clipboard (a file in our cache, which the clipboard hands to the app that pastes), and into
    // Pictures › TwinDesk with "Also save".
    private fun fromComputer(m: JSONObject) {
        if (!receive || !core.sync.get("clipboard", "in")) return
        val data = m.optString("png")
        val id = m.optString("id")
        if (data.isEmpty() || data.length > (Proto.CLIP_IMAGE_MAX_BYTES * 4L + 2) / 3 + 8 || id.isEmpty() || id.length > 128) return
        val from = core.host?.name ?: "Computer"
        core.bg.execute {
            try {
                val png = Base64.decode(data, Base64.DEFAULT)
                if (png.size > Proto.CLIP_IMAGE_MAX_BYTES || !isPng(png)) return@execute
                val name = clean("$from ${SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.ROOT).format(Date())}") + ".png"
                val dir = File(core.ctx.cacheDir, "clip/shots").apply { mkdirs() }
                // Keep the last few (a paste may come later); older ones go.
                dir.listFiles()?.sortedByDescending { it.lastModified() }?.drop(4)?.forEach { it.delete() }
                val file = File(dir, name).also { it.writeBytes(png) }
                val uri = FileProvider.getUriForFile(core.ctx, "${core.ctx.packageName}.files", file)
                main.post {
                    runCatching {
                        (core.ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                            .setPrimaryClip(ClipData.newUri(core.ctx.contentResolver, "Screenshot", uri))
                    }.onFailure { Log.w("TwinDesk", "screenshot from the computer: ${it.message}") }
                }
                if (save) saveCopy(name, png)
                lastIn = name
                core.changed()
            } catch (e: Exception) {
                Log.w("TwinDesk", "screenshot from the computer: ${e.message}")
            }
        }
    }

    // Into Pictures › TwinDesk (outside Screenshots: never sent back).
    private fun saveCopy(name: String, png: ByteArray) {
        val values = ContentValues().apply {
            put(C.DISPLAY_NAME, name)
            put(C.MIME_TYPE, "image/png")
            put(C.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/TwinDesk")
            put(C.IS_PENDING, 1)
        }
        val cr = core.ctx.contentResolver
        val uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return
        try {
            cr.openOutputStream(uri)?.use { it.write(png) } ?: throw IllegalStateException("can't write $name")
            cr.update(uri, ContentValues().apply { put(C.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            runCatching { cr.delete(uri, null, null) }
            throw e
        }
    }

    private fun clean(s: String) = s.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().trimStart('.').take(80).ifEmpty { "Screenshot" }

    companion object {
        private const val SETTLE_MS = 700L
        private const val FRESH_S = 20L // older pictures (synced in, copied over) aren't screenshots just taken
        private val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        private fun isPng(b: ByteArray) = b.size > 8 && (0 until 8).all { b[it] == PNG_SIGNATURE[it] }
    }
}
