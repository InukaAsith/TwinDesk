// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This device's screenshots onto the computer's clipboard, as a picture (Clip.kt sendPicture,
// marked `shot`). On a computer a screenshot goes when it is put on the clipboard; Android puts
// none there and tells apps in the background nothing about screenshots, so while connected we
// watch the photo library for a new picture in a Screenshots folder (needs photo access, or the
// All files access the computer may have had granted). Only while Pictures is on here and on the
// computer; never through Bluetooth.
package com.twindesk.android

import android.Manifest
import android.content.ContentUris
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.BaseColumns
import android.provider.MediaStore
import android.provider.MediaStore.MediaColumns as C
import android.util.Log

class Screenshots(core: Core) : Feature(core) {
    private val main = Handler(Looper.getMainLooper())
    private var observer: ContentObserver? = null
    private val seen = LinkedHashSet<Long>() // photo library ids looked at already
    @Volatile var lastSent = ""; private set // the last one's name, for the Clipboard page

    // This device's screenshots to the computer (with Pictures on).
    val on: Boolean get() = core.store.flag("screenshots.out", false)
    fun setOn(v: Boolean) { core.store.setFlag("screenshots.out", v); watch(); core.changed() }

    // The photo permission this Android asks for (13 and later: Photos; before: storage).
    val permission: String get() = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
    val canRead: Boolean get() = (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) ||
        core.ctx.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private val look = Runnable { core.bg.execute { runCatching { send() }.onFailure { Log.w("TwinDesk", "screenshot: ${it.message}") } } }

    override fun onWelcome(host: Host) = watch()
    override fun onClosed() = watch()

    // The photo library is watched only while connected with "Screenshots go to" and Pictures on: a
    // screenshot is written, then marked done, so one look once the changes settle.
    fun watch() {
        val want = on && core.clip.picturesOn && core.link.connected
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
        if (!on || !core.clip.canSendPictures || !canRead) return
        val cr = core.ctx.contentResolver
        val cols = arrayOf(BaseColumns._ID, C.DISPLAY_NAME, C.MIME_TYPE, C.SIZE)
        // The same Screenshots as the Photos page (Media.kt).
        val where = "${C.DATE_ADDED} >= ? AND ${C.IS_PENDING} = 0 AND " +
            "(${C.RELATIVE_PATH} LIKE ? OR ${C.BUCKET_DISPLAY_NAME} = ?)"
        val args = arrayOf((System.currentTimeMillis() / 1000 - FRESH_S).toString(), "%Screenshots%", "Screenshots")
        val found = cr.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cols, where, args, "${C.DATE_ADDED} DESC, ${BaseColumns._ID} DESC")?.use { c ->
            if (!c.moveToFirst()) null else Pic(c.getLong(0), c.getString(1) ?: "Screenshot", c.getString(2) ?: "", c.getLong(3))
        } ?: return
        synchronized(seen) {
            if (!seen.add(found.id)) return
            while (seen.size > 50) seen.remove(seen.first())
        }
        val png = Clip.toPng(cr, ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, found.id), found.mime, found.size) ?: return
        if (core.clip.sendPicture(png, true)) {
            lastSent = found.name
            core.changed()
        }
    }

    private class Pic(val id: Long, val name: String, val mime: String, val size: Long)

    companion object {
        private const val SETTLE_MS = 700L
        private const val FRESH_S = 20L // older pictures (synced in, copied over) aren't screenshots just taken
    }
}
