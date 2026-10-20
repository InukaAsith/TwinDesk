// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files both ways, in the computers' batch protocol (mac/filesend.js, mac/drop.js):
//   in:  file.offer (drop 'send' or 'paste', a batch with folders by `rel`) → file.accept →
//        file.chunk… → file.end {sha256} → file.done; files.done when the whole batch is here.
//        Send files land in Download/TwinDesk (folders kept); a paste we asked for lands where
//        FileClip wants it (the clipboard's cache, or Downloads).
//   out: the same, the other way: offers for every file, chunks one file at a time while the socket
//        has little queued, so pings and input never wait behind a big file.
package com.twindesk.android

import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class Files(core: Core) : Feature(core) {
    // Where a batch goes: Downloads (with a notification), or a folder of ours (FileClip's copy).
    class Target(val toDownloads: Boolean, val dir: File? = null, val onDone: ((Batch) -> Unit)? = null)

    class Incoming(val id: String, val batch: String, val name: String, val rel: String, val size: Long, val out: OutputStream, val uri: Uri?, val file: File?) {
        val hash: MessageDigest = MessageDigest.getInstance("SHA-256")
        var got = 0L
        var seq = 0
    }

    class Batch(val id: String, val kind: String, val count: Int, val bytes: Long, val target: Target) {
        var done = 0
        var ok = true
        var got = 0L
        val placed = mutableListOf<Pair<Uri, String?>>() // (uri, mime) of each file, in order
        val tops = linkedSetOf<String>()
        val key = (id.hashCode() and 0x7fff)
        var lastNote = 0L
    }

    class Outgoing(val id: String, val uri: Uri, val name: String, val size: Long, val batch: String) {
        var state = "offered" // offered | accepted | sending
        var sent = 0L
    }

    class OutBatch(val id: String, val kind: String, val name: String, val files: Int, val bytes: Long) {
        var sent = 0L
    }

    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "td-files-in").apply { isDaemon = true } }
    private val pump = Executors.newSingleThreadExecutor { r -> Thread(r, "td-files-out").apply { isDaemon = true } }
    private val incoming = ConcurrentHashMap<String, Incoming>()
    private val batches = ConcurrentHashMap<String, Batch>()
    private val expected = ConcurrentHashMap<String, Target>() // batch (fclip id) -> where a paste we asked for goes
    private val outgoing = java.util.concurrent.ConcurrentLinkedQueue<Outgoing>()
    private val outBatches = ConcurrentHashMap<String, OutBatch>()
    val recent = java.util.concurrent.CopyOnWriteArrayList<String>() // newest first, one line each
    private val drags = ConcurrentHashMap<String, Int>() // drag id -> files announced (drag.start)

    fun expect(batch: String, target: Target) {
        expected[batch] = target
    }

    // One line for the ongoing notification while something moves.
    fun activeLine(): String? {
        val inb = batches.values.firstOrNull()
        if (inb != null) return "Receiving ${plural(inb.count, "file")} · ${pct(inb.got, inb.bytes)}%"
        val outb = outBatches.values.firstOrNull()
        if (outb != null) return "Sending ${outb.name} · ${pct(outb.sent, outb.bytes)}%"
        return null
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.FILE_OFFER -> io.execute { offer(m) }
            Proto.T.FILE_CHUNK -> io.execute { chunk(m) }
            Proto.T.FILE_END -> io.execute { end(m) }
            Proto.T.FILE_CANCEL -> io.execute { abort(m.optString("id"), "cancelled", false); cancelOut(m.optString("id")) }
            Proto.T.FILE_ACCEPT -> {
                outgoing.find { it.id == m.optString("id") }?.let { if (it.state == "offered") it.state = "accepted" }
                pump.execute { pumpNext() }
            }
            Proto.T.FILE_REFUSE -> cancelOut(m.optString("id"))
            Proto.T.FILE_DONE -> Unit
            Proto.T.FILES_DONE -> outDone(m)
            Proto.T.DRAG_POLICY -> Unit
            // The Mac's pointer crossed onto the phone dragging files: they land in Download/TwinDesk.
            "drag.start" -> {
                val id = m.optString("drag")
                if (id.isNotEmpty()) {
                    drags[id] = m.optInt("files", 0)
                    if (m.optInt("files", 0) == 0) core.send(msg("drag.end", "drag" to id, "result" to "dropped", "where" to "Download/TwinDesk"))
                    else expect(id, Target(true))
                }
            }
            "drag.cancel" -> io.execute {
                val id = m.optString("drag")
                drags.remove(id)
                expected.remove(id)
                for (f in incoming.values.filter { it.batch == id }) abort(f.id, "cancelled", false)
                batches.remove(id)?.let { Notify.cancelFiles(core.ctx, it.key) }
            }
            else -> return false
        }
        return true
    }

    override fun onWelcome(host: Host) {
        core.send(msg(Proto.T.DRAG_POLICY, "accept" to true)) // files dragged across the edge go to Downloads
    }

    override fun onClosed() {
        io.execute {
            for (id in incoming.keys.toList()) abort(id, "disconnected", false)
            for (b in batches.values) Notify.cancelFiles(core.ctx, b.key)
            batches.clear()
        }
        for (o in outgoing) cancelOut(o.id)
        outBatches.clear()
        core.changed()
    }

    // ---- in ----

    private fun refuse(id: String, why: String) { core.send(msg(Proto.T.FILE_REFUSE, "id" to id, "why" to why)) }

    private fun cleanSegment(s: String): String {
        var n = s.replace(Regex("[\\u0000-\\u001f/:\\\\]"), "_").trim()
        if (n.isEmpty() || n == "." || n == "..") n = "file"
        return n.take(200)
    }

    private fun offer(m: JSONObject) {
        val id = m.optString("id")
        if (id.isEmpty() || incoming.containsKey(id)) return
        val drop = m.optString("drop")
        if (drop != "send" && drop != "paste" && drop != "drag") return refuse(id, "not_allowed")
        val size = m.optLong("size", -1)
        if (size < 0 || size > 4L * 1024 * 1024 * 1024) return refuse(id, "too_big")
        val batchId = (if (drop == "drag") m.optString("drag") else m.optString("batch")).ifEmpty { id }
        val rel = m.optString("rel").ifEmpty { m.optString("name") }.split('/').filter { it.isNotEmpty() }.map(::cleanSegment)
        if (rel.isEmpty()) return refuse(id, "bad_name")
        var batch = batches[batchId]
        if (batch == null) {
            val target = expected.remove(batchId) ?: if (drop == "send" || drop == "drag") Target(true) else return refuse(id, "not_expected")
            batch = Batch(batchId, drop, m.optInt("count", 1).coerceAtLeast(1), m.optLong("bytes", size), target)
            batches[batchId] = batch
        }
        batch.tops.add(rel[0])
        val name = rel.last()
        try {
            val inc = if (batch.target.toDownloads) {
                val dir = (listOf("Download", "TwinDesk") + rel.dropLast(1)).joinToString("/") + "/"
                val mime = mimeOf(name)
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, dir)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = core.ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("no space")
                Incoming(id, batchId, name, rel.joinToString("/"), size, core.ctx.contentResolver.openOutputStream(uri)!!, uri, null)
            } else {
                val f = File(batch.target.dir!!, rel.joinToString("/"))
                f.parentFile?.mkdirs()
                Incoming(id, batchId, name, rel.joinToString("/"), size, f.outputStream(), null, f)
            }
            incoming[id] = inc
            core.send(msg(Proto.T.FILE_ACCEPT, "id" to id))
            note(batch, true)
        } catch (e: Exception) {
            RemoteLog.w("TwinDesk", "offer $name: ${e.message}")
            refuse(id, "not_allowed")
            fileFinished(batch, false)
        }
    }

    private fun chunk(m: JSONObject) {
        val f = incoming[m.optString("id")] ?: return
        try {
            val data = Base64.getDecoder().decode(m.optString("data"))
            if (m.optInt("seq") != f.seq++ || f.got + data.size > f.size) return abort(f.id, "out of order", true)
            f.out.write(data)
            f.hash.update(data)
            f.got += data.size
            batches[f.batch]?.let { it.got += data.size; note(it, false) }
        } catch (e: Exception) {
            abort(f.id, e.message ?: "write failed", true)
        }
    }

    private fun end(m: JSONObject) {
        val f = incoming.remove(m.optString("id")) ?: return
        val batch = batches[f.batch]
        val ok = f.got == f.size && f.hash.digest().hex() == m.optString("sha256")
        runCatching { f.out.close() }
        if (!ok) {
            f.uri?.let { runCatching { core.ctx.contentResolver.delete(it, null, null) } }
            f.file?.delete()
            core.send(msg(Proto.T.FILE_DONE, "id" to f.id, "ok" to false, "error" to "checksum"))
            batch?.let { fileFinished(it, false) }
            return
        }
        if (f.uri != null) {
            core.ctx.contentResolver.update(f.uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            batch?.placed?.add(f.uri to mimeOf(f.name))
        } else if (f.file != null) {
            val uri = FileProvider.getUriForFile(core.ctx, "${core.ctx.packageName}.files", f.file)
            batch?.placed?.add(uri to mimeOf(f.name))
        }
        core.send(msg(Proto.T.FILE_DONE, "id" to f.id, "ok" to true, "path" to "Download/TwinDesk/${f.rel}"))
        batch?.let { fileFinished(it, true) }
    }

    private fun abort(id: String, why: String, tell: Boolean) {
        val f = incoming.remove(id) ?: return
        runCatching { f.out.close() }
        f.uri?.let { runCatching { core.ctx.contentResolver.delete(it, null, null) } }
        f.file?.delete()
        if (tell) core.send(msg(Proto.T.FILE_CANCEL, "id" to id))
        RemoteLog.w("TwinDesk", "file ${f.name}: $why")
        batches[f.batch]?.let { fileFinished(it, false) }
    }

    private fun fileFinished(b: Batch, ok: Boolean) {
        b.done++
        if (!ok) b.ok = false
        if (b.done < b.count) return
        batches.remove(b.id)
        val where = "Download/TwinDesk"
        if (drags.remove(b.id) != null) core.send(msg("drag.end", "drag" to b.id, "result" to if (b.ok) "dropped" else "failed", "where" to where))
        else core.send(msg(Proto.T.FILES_DONE, "batch" to b.id, "ok" to b.ok, "where" to where, "files" to b.done))
        val from = core.host?.name ?: "your computer"
        val what = if (b.tops.size == 1) b.tops.first() else plural(b.tops.size, "item")
        recent.add(0, "${if (b.ok) "Received" else "Some of"} $what from $from")
        while (recent.size > 20) recent.removeAt(recent.size - 1)
        if (b.target.onDone != null) {
            Notify.cancelFiles(core.ctx, b.key)
            b.target.onDone.invoke(b)
        } else {
            val open = if (b.placed.size == 1) Notify.viewIntent(b.placed[0].first, b.placed[0].second)
            else Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            Notify.files(core.ctx, b.key, if (b.ok) "$what from $from" else "Not everything arrived from $from", if (b.ok) "In Downloads › TwinDesk. Tap to open." else "$what is incomplete", null, open)
        }
        core.changed()
    }

    private fun note(b: Batch, force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && now - b.lastNote < 500) return
        b.lastNote = now
        if (b.target.onDone != null) Notify.fclipProgress(core.ctx, "Copying ${plural(b.count, "file")} from ${core.host?.name ?: "your computer"}", pct(b.got, b.bytes))
        else Notify.files(core.ctx, b.key, "Receiving ${plural(b.count, "file")} from ${core.host?.name ?: "your computer"}", "${pct(b.got, b.bytes)}%", pct(b.got, b.bytes), null)
        core.changed()
    }

    // ---- out ----

    data class Item(val uri: Uri, val name: String, val size: Long)

    fun describe(uris: List<Uri>): List<Item> = uris.mapNotNull { uri ->
        runCatching {
            core.ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (!c.moveToFirst()) return@use null
                val name = c.getString(0) ?: uri.lastPathSegment ?: "file"
                val size = if (c.isNull(1)) -1L else c.getLong(1)
                Item(uri, cleanSegment(name), size)
            }
        }.getOrNull()
    }.map { if (it.size >= 0) it else it.copy(size = sizeByReading(it.uri)) }

    private fun sizeByReading(uri: Uri): Long = runCatching {
        core.ctx.contentResolver.openInputStream(uri)!!.use { s -> var n = 0L; val b = ByteArray(65536); while (true) { val r = s.read(b); if (r < 0) break; n += r }; n }
    }.getOrDefault(0L)

    // Offer every file now (kind 'send' = Send to computer, 'paste' = the computer pasted what we copied).
    fun send(items: List<Item>, kind: String, batch: String = UUID.randomUUID().toString()): Boolean {
        if (!core.link.connected || items.isEmpty()) return false
        val seen = mutableSetOf<String>()
        val unique = items.map { var n = it.name; var i = 2; while (!seen.add(n)) { n = it.name.substringBeforeLast('.') + " ${i++}" + it.name.substringAfterLast('.', "").let { e -> if (e.isEmpty()) "" else ".$e" } }; it.copy(name = n) }
        val bytes = unique.sumOf { it.size }
        outBatches[batch] = OutBatch(batch, kind, if (unique.size == 1) unique[0].name else plural(unique.size, "item"), unique.size, bytes)
        unique.forEachIndexed { index, it ->
            val id = UUID.randomUUID().toString()
            outgoing.add(Outgoing(id, it.uri, it.name, it.size, batch))
            core.send(msg(Proto.T.FILE_OFFER, "id" to id, "name" to it.name, "size" to it.size, "drop" to kind, "batch" to batch, "rel" to it.name, "index" to index, "count" to unique.size, "bytes" to bytes))
        }
        core.changed()
        return true
    }

    private fun pumpNext() {
        while (true) {
            val f = outgoing.firstOrNull { it.state == "accepted" } ?: return
            f.state = "sending"
            val md = MessageDigest.getInstance("SHA-256")
            var seq = 0
            try {
                core.ctx.contentResolver.openInputStream(f.uri)!!.use { s ->
                    val buf = ByteArray(Proto.FILE_CHUNK_BYTES)
                    while (true) {
                        if (!outgoing.contains(f) || !core.link.connected) return
                        while (core.link.queued() > 1024 * 1024) Thread.sleep(5)
                        val n = s.readNBytesCompat(buf)
                        if (n <= 0) break
                        md.update(buf, 0, n)
                        core.send(msg(Proto.T.FILE_CHUNK, "id" to f.id, "seq" to seq++, "data" to Base64.getEncoder().encodeToString(buf.copyOf(n))))
                        f.sent += n
                        outBatches[f.batch]?.let { it.sent += n }
                        if (seq % 32 == 0) core.changed()
                    }
                }
                core.send(msg(Proto.T.FILE_END, "id" to f.id, "sha256" to md.digest().hex()))
            } catch (e: Exception) {
                RemoteLog.w("TwinDesk", "send ${f.name}: ${e.message}")
                core.send(msg(Proto.T.FILE_CANCEL, "id" to f.id))
            }
            outgoing.remove(f)
        }
    }

    private fun cancelOut(id: String) {
        outgoing.removeIf { it.id == id }
    }

    private fun outDone(m: JSONObject) {
        val b = outBatches.remove(m.optString("batch")) ?: return
        outgoing.removeIf { it.batch == b.id }
        val to = core.host?.name ?: "your computer"
        recent.add(0, if (m.optBoolean("ok")) "Sent ${b.name} to $to" else "${b.name} didn’t all arrive on $to")
        while (recent.size > 20) recent.removeAt(recent.size - 1)
        core.changed()
    }

    val sending: List<OutBatch> get() = outBatches.values.toList()
    val receiving: List<Batch> get() = batches.values.toList()

    companion object {
        fun mimeOf(name: String): String =
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

        fun plural(n: Int, what: String) = "$n $what${if (n == 1) "" else "s"}"
        fun pct(a: Long, b: Long) = if (b <= 0) 100 else ((a * 100) / b).toInt().coerceIn(0, 100)
    }
}

// InputStream.readNBytes(buf, off, len) is API 33: fill the buffer as far as the stream allows.
fun java.io.InputStream.readNBytesCompat(buf: ByteArray): Int {
    var n = 0
    while (n < buf.size) {
        val r = read(buf, n, buf.size - n)
        if (r < 0) break
        n += r
    }
    return n
}
