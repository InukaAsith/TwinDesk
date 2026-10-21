// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos and videos on the computer (Hub.kt): the phone's gallery a page at a time (media.list),
// small pictures for the grid (media.thumb, the ones on screen first), a big one to look at
// (media.view), and the files themselves to the computer's Downloads (media.save, as Send).
// Nothing runs on its own: it answers what the computer asks while its page is open.
package com.twindesk.android

import android.content.ContentUris
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.BaseColumns
import android.provider.MediaStore
import android.provider.MediaStore.Files.FileColumns as F
import android.provider.MediaStore.MediaColumns as C
import android.util.Base64
import android.util.Size
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class Media(private val hub: Hub, private val core: Core) {
    private val cr = core.ctx.contentResolver
    private val want = ArrayDeque<String>() // pictures still to send, the computer's order
    private var pumping = false
    @Volatile private var stopped = false

    fun stop() {
        stopped = true
        synchronized(want) { want.clear() }
    }

    // One page of the gallery, newest first. `before` is where the last page ended ("<date>:<id>").
    fun list(m: JSONObject): JSONObject {
        val kind = m.str("kind", 20)
        val n = m.optInt("n", 120).coerceIn(1, 500)
        val before = m.str("before", 40)
        val sel = StringBuilder(
            when (kind) {
                "photos" -> "${F.MEDIA_TYPE} = ${F.MEDIA_TYPE_IMAGE}"
                "videos" -> "${F.MEDIA_TYPE} = ${F.MEDIA_TYPE_VIDEO}"
                "screenshots" -> "${F.MEDIA_TYPE} = ${F.MEDIA_TYPE_IMAGE} AND (${C.RELATIVE_PATH} LIKE '%Screenshots%' OR ${C.BUCKET_DISPLAY_NAME} = 'Screenshots')"
                else -> "${F.MEDIA_TYPE} IN (${F.MEDIA_TYPE_IMAGE}, ${F.MEDIA_TYPE_VIDEO})"
            },
        )
        val args = ArrayList<String>()
        val (bd, bi) = before.split(':').let { (it.getOrNull(0)?.toLongOrNull() ?: 0L) to (it.getOrNull(1)?.toLongOrNull() ?: 0L) }
        if (bd > 0) {
            sel.append(" AND (${C.DATE_ADDED} < ? OR (${C.DATE_ADDED} = ? AND ${BaseColumns._ID} < ?))")
            args += listOf(bd.toString(), bd.toString(), bi.toString())
        }
        val items = JSONArray()
        var last = ""
        var more = false
        cr.query(
            MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL),
            arrayOf(BaseColumns._ID, F.MEDIA_TYPE, C.DATE_ADDED, C.DATE_TAKEN, C.WIDTH, C.HEIGHT, C.SIZE, C.DISPLAY_NAME, C.DURATION, C.BUCKET_DISPLAY_NAME, C.ORIENTATION),
            sel.toString(), args.toTypedArray(), "${C.DATE_ADDED} DESC, ${BaseColumns._ID} DESC",
        )?.use { c ->
            while (c.moveToNext()) {
                if (items.length() >= n) { more = true; break }
                val id = c.getLong(0)
                val video = c.getInt(1) == F.MEDIA_TYPE_VIDEO
                val added = c.getLong(2)
                val taken = c.getLong(3)
                val turned = c.getInt(10) % 180 != 0
                items.put(
                    JSONObject().put("id", (if (video) "v" else "i") + id).put("video", video).put("at", if (taken > 0) taken else added * 1000)
                        .put("w", if (turned) c.getInt(5) else c.getInt(4)).put("h", if (turned) c.getInt(4) else c.getInt(5))
                        .put("size", c.getLong(6)).put("name", c.getString(7) ?: "").put("dur", c.getLong(8)).put("album", c.getString(9) ?: ""),
                )
                last = "$added:$id"
            }
        }
        return msg(Proto.T.MEDIA_LIST, "kind" to kind, "before" to before, "items" to items, "more" to more, "next" to last)
    }

    private fun uri(id: String): Uri? {
        val n = id.drop(1).toLongOrNull() ?: return null
        return when (id.firstOrNull()) {
            'i' -> ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, n)
            'v' -> ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, n)
            else -> null
        }
    }

    // These next: the ones still waiting from before are dropped (scrolled past).
    fun thumbs(ids: JSONArray?) {
        val list = (0 until (ids?.length() ?: 0)).map { ids!!.optString(it).take(40) }.filter { it.isNotEmpty() }.take(300)
        synchronized(want) {
            want.clear()
            want.addAll(list)
            if (pumping || list.isEmpty()) return
            pumping = true
        }
        hub.run { pump() }
    }

    // One at a time, while the link has little queued: input and the rest never wait behind them.
    private fun pump() {
        try {
            while (!stopped && core.link.connected && !core.link.ble) {
                val id = synchronized(want) { want.removeFirstOrNull() } ?: break
                while (core.link.queued() > 256 * 1024 && !stopped) Thread.sleep(5)
                val data = runCatching { jpeg(cr.loadThumbnail(uri(id)!!, Size(256, 256), null), 72) }.getOrNull()
                core.send(msg(Proto.T.MEDIA_THUMB, "id" to id, "data" to data))
            }
        } finally {
            synchronized(want) { pumping = false; if (want.isNotEmpty() && !stopped) { pumping = true; hub.run { pump() } } }
        }
    }

    // A big picture to look at (a video's frame).
    fun view(id: String): String? = runCatching {
        val u = uri(id)!!
        val b = if (id.startsWith("v")) cr.loadThumbnail(u, Size(1280, 1280), null)
        else ImageDecoder.decodeBitmap(ImageDecoder.createSource(cr, u)) { d, info, _ ->
            val s = info.size
            val k = 1600.0 / maxOf(s.width, s.height)
            if (k < 1) d.setTargetSize((s.width * k).toInt().coerceAtLeast(1), (s.height * k).toInt().coerceAtLeast(1))
            d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        jpeg(b, 85)
    }.getOrNull()

    // The files themselves, to the computer's Downloads (as Send to computer).
    fun save(ids: JSONArray?) {
        val uris = (0 until (ids?.length() ?: 0)).mapNotNull { uri(ids!!.optString(it)) }.take(500)
        if (uris.isNotEmpty()) core.files.send(core.files.describe(uris), "send")
    }

    private fun jpeg(b: Bitmap, q: Int): String {
        val out = ByteArrayOutputStream()
        b.compress(Bitmap.CompressFormat.JPEG, q, out)
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}
