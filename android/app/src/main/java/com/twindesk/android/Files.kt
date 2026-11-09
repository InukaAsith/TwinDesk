// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files both ways, in the computers' batch protocol (mac/filesend.js, mac/drop.js):
//   in:  file.offer (drop 'send' or 'paste', a batch with folders by `rel`) → file.accept →
//        file.chunk… → file.end {sha256} → file.done; files.done when the whole batch is here.
//        Send files land in Download/TwinDesk (folders kept); a paste we asked for lands where
//        FileClip wants it (the clipboard's cache, or Downloads).
//   out: the same, the other way: offers for every file, chunks one file at a time while the socket
//        has little queued, so pings and input never wait behind a big file.
// Fast files (Link.fx(), the computers' shared/fastfile.js "fx"): on the network or a cable, with a
// computer that gave a token, the bytes go as one plain HTTPS stream instead of base64 file.chunk
// (a third more on the wire, and slower): we PUT what we send, and GET what the computer sends when it
// says file.pull. Anything wrong before a byte went: that file, and the rest of the session's, go as
// file.chunk. An older computer gives no token, so it gets file.chunk as before.
// Fast files v2 (Fx2.kt), with a computer whose files engine is there (welcome {fx2}) and not through
// the cable: a big file as 4 ranges at once, both ways, the ranges' hashes in file.end. Anything wrong
// before a byte went: that file and the rest of the session's go the fx way (fx2Broken). On a Wi-Fi
// Direct group or a hotspot made for the files, the bytes keep it up (Netlink.touch), as chunks do.
package com.twindesk.android

import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class Files(core: Core) : Feature(core) {
    // Where a batch goes: Downloads (with a notification), or a folder of ours (FileClip's copy), or
    // one on the storage the computer chose (FsBrowse: `where` names it, keepBoth: a name already
    // there gets " 2", nothing is overwritten).
    class Target(val toDownloads: Boolean, val dir: File? = null, val where: String = "", val keepBoth: Boolean = false, val onDone: ((Batch) -> Unit)? = null)

    class Incoming(val id: String, val batch: String, val name: String, val rel: String, val size: Long, val out: OutputStream, val uri: Uri?, val file: File?) {
        val hash: MessageDigest = MessageDigest.getInstance("SHA-256")
        @Volatile var got = 0L
        var seq = 0
        // Fast files: its bytes come through a GET (pulling); a file.end that overtook them waits.
        var pulling = false
        var heldEnd: JSONObject? = null
        @Volatile var stop: (() -> Unit)? = null // cancels the GET
        // fx2: the ranges' hashes once every one is in (file.end {fx2} must match them).
        @Volatile var fx2Hashes: List<String>? = null
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
        val key = (id.hashCode() and 0x7fff) or 0x8000 // its notification (apart from the incoming ones')
        var shown = false // big enough for one (the progress bar while it goes)
        var lastNote = 0L
    }

    private val awake = Awake(core.ctx) // the phone stays awake while file bytes move
    val moving: Boolean get() = awake.busy
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "td-files-in").apply { isDaemon = true } }
    private val pump = Executors.newSingleThreadExecutor { r -> Thread(r, "td-files-out").apply { isDaemon = true } }
    private val pulls = Executors.newCachedThreadPool { r -> Thread(r, "td-files-fx").apply { isDaemon = true } }
    @Volatile private var fxBroken = false // fast files failed before a byte went: file.chunk for the rest of the session
    @Volatile private var fx2Broken = false // fx2 failed before a byte went: the fx way for the rest of the session
    private val ranges = Executors.newCachedThreadPool { r -> Thread(r, "td-files-fx2").apply { isDaemon = true } }
    private val progress = Any() // sentBytes from the ranges' threads
    private val incoming = ConcurrentHashMap<String, Incoming>()
    private val batches = ConcurrentHashMap<String, Batch>()
    private val expected = ConcurrentHashMap<String, Target>() // batch (fclip id) -> where a paste we asked for goes
    private val outgoing = java.util.concurrent.ConcurrentLinkedQueue<Outgoing>()
    private val outBatches = ConcurrentHashMap<String, OutBatch>()
    val recent = java.util.concurrent.CopyOnWriteArrayList<String>() // newest first, one line each
    private val drags = ConcurrentHashMap<String, Int>() // drag id -> files announced (drag.start)
    private val dropped = java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>()) // batches cancelled here: the rest of their offers refused

    // Cancel (the notification, the Files page): stops a batch either way. Each file gets file.cancel,
    // which the computer already takes as cancelled here (as when one end disconnects).
    fun cancel(batchId: String) = io.execute {
        if (batchId.isEmpty()) return@execute
        outBatches.remove(batchId)?.let { b ->
            for (f in outgoing.filter { it.batch == batchId }) {
                outgoing.remove(f) // its upload thread sees it gone and stops
                core.send(msg(Proto.T.FILE_CANCEL, "id" to f.id))
            }
            Notify.cancelFiles(core.ctx, b.key)
            recent.add(0, tr("Cancelled sending {file}", "file" to b.name))
            while (recent.size > 20) recent.removeAt(recent.size - 1)
            core.changed()
        }
        batches[batchId]?.let { b ->
            dropped.add(batchId)
            for (f in incoming.values.filter { it.batch == batchId }) abort(f.id, "cancelled here", true)
            while (batches[batchId] === b) fileFinished(b, false) // the files not offered yet: the batch ends now
            Notify.cancelFiles(core.ctx, b.key)
            recent[0] = tr("Cancelled receiving {files}", "files" to trCount(b.count, "file"))
            core.changed()
        }
    }

    fun clearRecent() {
        recent.clear()
        core.changed()
    }

    fun expect(batch: String, target: Target) {
        expected[batch] = target
    }

    // One line for the ongoing notification while something moves.
    fun activeLine(): String? {
        val inb = batches.values.firstOrNull()
        if (inb != null) return tr("Receiving {files} · {percent}%", "files" to trCount(inb.count, "file"), "percent" to pct(inb.got, inb.bytes))
        val outb = outBatches.values.firstOrNull()
        if (outb != null) return tr("Sending {file} · {percent}%", "file" to outb.name, "percent" to pct(outb.sent, outb.bytes))
        return null
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.FILE_OFFER -> io.execute { offer(m) }
            Proto.T.FILE_CHUNK -> io.execute { chunk(m) }
            Proto.T.FILE_END -> io.execute { end(m) }
            Proto.T.FILE_PULL -> io.execute { pull(m) }
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
        fxBroken = false
        fx2Broken = false
        core.send(msg(Proto.T.DRAG_POLICY, "accept" to true)) // files dragged across the edge go to Downloads
    }

    override fun onClosed() {
        io.execute {
            for (id in incoming.keys.toList()) abort(id, "disconnected", false)
            for (b in batches.values) Notify.cancelFiles(core.ctx, b.key)
            batches.clear()
            dropped.clear()
        }
        for (o in outgoing) cancelOut(o.id)
        outBatches.clear()
        awake.release()
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
        if (drop != "send" && drop != "paste" && drop != "drag" && drop != "rezume") return refuse(id, "not_allowed") // rezume: a document taken here (Rezume.kt), only when asked
        val size = m.optLong("size", -1)
        if (size < 0 || size > Proto.FILE_MAX_BYTES) return refuse(id, "too_big")
        val batchId = (if (drop == "drag") m.optString("drag") else m.optString("batch")).ifEmpty { id }
        if (batchId in dropped) return refuse(id, "cancelled")
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
                var f = File(batch.target.dir!!, rel.joinToString("/"))
                if (batch.target.keepBoth && rel.size == 1) {
                    var i = 2
                    val dot = name.lastIndexOf('.')
                    val (base, ext) = if (dot > 0) name.substring(0, dot) to name.substring(dot) else name to ""
                    while (f.exists()) f = File(batch.target.dir, "$base ${i++}$ext")
                }
                f.parentFile?.mkdirs()
                Incoming(id, batchId, name, rel.joinToString("/"), size, f.outputStream(), null, f)
            }
            incoming[id] = inc
            core.send(msg(Proto.T.FILE_ACCEPT, "id" to id))
            note(batch, true)
        } catch (e: Exception) {
            Log.w("TwinDesk", "offer $name: ${e.message}")
            refuse(id, "not_allowed")
            fileFinished(batch, false)
        }
    }

    private fun chunk(m: JSONObject) {
        val f = incoming[m.optString("id")] ?: return
        if (f.pulling) return abort(f.id, "out of order", true)
        try {
            val data = Base64.getDecoder().decode(m.optString("data"))
            if (m.optInt("seq") != f.seq++ || f.got + data.size > f.size) return abort(f.id, "out of order", true)
            f.out.write(data)
            f.hash.update(data)
            f.got += data.size
            awake.touch()
            batches[f.batch]?.let { it.got += data.size; note(it, false) }
        } catch (e: Exception) {
            abort(f.id, e.message ?: "write failed", true)
        }
    }

    private fun end(m: JSONObject) {
        val f = incoming[m.optString("id")] ?: return
        if (f.pulling) { f.heldEnd = m; return } // the GET is still bringing the last bytes
        incoming.remove(f.id)
        val batch = batches[f.batch]
        val h2 = f.fx2Hashes
        val ok = f.got == f.size && if (h2 != null) Fx2.same(m.optJSONArray("fx2"), h2) else f.hash.digest().hex() == m.optString("sha256")
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
            // (only FileClip's folder is shared through the FileProvider; a folder on the storage isn't)
            runCatching { FileProvider.getUriForFile(core.ctx, "${core.ctx.packageName}.files", f.file) }.getOrNull()?.let { batch?.placed?.add(it to mimeOf(f.name)) }
        }
        core.send(msg(Proto.T.FILE_DONE, "id" to f.id, "ok" to true, "path" to (batch?.target?.where?.ifEmpty { null } ?: "Download/TwinDesk") + "/${f.rel}"))
        batch?.let { fileFinished(it, true) }
    }

    private fun abort(id: String, why: String, tell: Boolean) {
        val f = incoming.remove(id) ?: return
        f.stop?.invoke()
        runCatching { f.out.close() }
        f.uri?.let { runCatching { core.ctx.contentResolver.delete(it, null, null) } }
        f.file?.delete()
        if (tell) core.send(msg(Proto.T.FILE_CANCEL, "id" to id))
        Log.w("TwinDesk", "file ${f.name}: $why")
        batches[f.batch]?.let { fileFinished(it, false) }
    }

    // file.pull from the computer (fast files): GET the bytes of a file we accepted. Answered
    // {failed} when we can't, and the computer sends it as file.chunk.
    private fun pull(m: JSONObject) {
        val id = m.optString("id")
        if (m.has("fx2")) return pull2(id, m.optLong("size", -1))
        val f = incoming[id]
        val fx = if (fxBroken) null else core.link.fx()
        if (f == null || fx == null || f.pulling || f.got > 0 || f.seq > 0) { core.send(msg(Proto.T.FILE_PULL, "id" to id, "failed" to true)); return }
        f.pulling = true
        pulls.execute { download(f, fx) }
    }

    private fun download(f: Incoming, fx: Link.Fx) {
        var error: String? = null
        var wrote = false
        var unsent = 0L
        try {
            val body: java.io.InputStream = if (fx.plain != null) {
                val b = FxHttp.get(fx.address, fx.plain.port, Proto.FX_PATH + Uri.encode(f.id), fx.plain.token) { sock ->
                    f.stop = { runCatching { sock.close() } }
                    if (incoming[f.id] !== f) runCatching { sock.close() }
                }
                if (b.code != 200) { b.close(); throw IOException("HTTP ${b.code}") }
                b
            } else {
                val call = fx.client.newCall(Request.Builder().url(fx.base + Uri.encode(f.id)).header(Proto.FX_HEADER, fx.token).build())
                f.stop = { call.cancel() }
                if (incoming[f.id] !== f) call.cancel()
                val res = call.execute()
                if (res.code != 200) { res.close(); throw IOException("HTTP ${res.code}") }
                res.body.byteStream()
            }
            run {
                body.use { s ->
                    val buf = ByteArray(256 * 1024)
                    while (true) {
                        val n = s.read(buf)
                        if (n < 0) break
                        if (incoming[f.id] !== f) throw IOException("cancelled")
                        if (f.got + n > f.size) throw IOException("more than offered")
                        wrote = true
                        f.out.write(buf, 0, n)
                        f.hash.update(buf, 0, n)
                        f.got += n
                        unsent += n
                        if (unsent >= 1024 * 1024) { val d = unsent; unsent = 0; io.execute { gotBytes(f, d) } }
                    }
                }
            }
        } catch (e: Exception) {
            error = e.message ?: "transfer failed"
        }
        val d = unsent
        io.execute {
            if (d > 0) gotBytes(f, d)
            pulled(f, error, wrote)
        }
    }

    // ---- fx2: in ----

    // file.pull {fx2, size}: GET its ranges at once, each written at its offset. Answered {failed,
    // fx2} when we can't (before a byte): the computer sends it the fx way.
    private fun pull2(id: String, size: Long) {
        val f = incoming[id]
        val fx = if (fxBroken || fx2Broken) null else core.link.fx()
        val port = fx?.let { if (it.plain != null && it.plain.fx2Port > 0) it.plain.fx2Port else it.fx2Port } ?: 0
        if (f == null || fx == null || port == 0 || f.pulling || f.got > 0 || f.seq > 0 || size != f.size) {
            core.send(msg(Proto.T.FILE_PULL, "id" to id, "failed" to true, "fx2" to 1))
            return
        }
        f.pulling = true
        pulls.execute { download2(f, fx, port) }
    }

    // Writes at offsets into the file the offer opened: a second descriptor on it (the stream the
    // offer opened writes nothing then, and closing it truncates nothing).
    private fun positional(f: Incoming): Pair<java.nio.channels.FileChannel, java.io.Closeable> {
        if (f.uri != null) {
            val pfd = core.ctx.contentResolver.openFileDescriptor(f.uri, "rw") ?: throw IOException("can’t open it")
            return java.io.FileOutputStream(pfd.fileDescriptor).channel to pfd
        }
        val raf = java.io.RandomAccessFile(f.file!!, "rw")
        return raf.channel to raf
    }

    private fun download2(f: Incoming, fx: Link.Fx, port: Int) {
        val plan = Fx2.plan(f.size)
        val got = java.util.concurrent.atomic.AtomicLong(0)
        val dead = java.util.concurrent.atomic.AtomicBoolean(false)
        val stops = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()
        // A range's socket or call: closed when the file stops (one at once when it already has).
        val stopWith: (() -> Unit) -> Unit = { s -> stops.add(s); if (dead.get()) runCatching { s() } }
        val stopAll = { dead.set(true); for (s in stops) runCatching { s() } }
        f.stop = stopAll
        var error: String? = null
        val hashes = arrayOfNulls<String>(plan.size)
        var opened: Pair<java.nio.channels.FileChannel, java.io.Closeable>? = null
        try {
            val (ch, _) = positional(f).also { opened = it }
            val jobs = plan.map { r ->
                ranges.submit<String> {
                    val md = MessageDigest.getInstance("SHA-256")
                    var pos = r.off
                    var left = r.len
                    val path = Fx2.path(f.id, r, f.size)
                    val body: java.io.InputStream = if (fx.plain != null && fx.plain.fx2Port > 0) {
                        if (dead.get()) throw IOException("stopped")
                        val b = FxHttp.get(fx.address, port, path, fx.plain.token) { sock -> stopWith { sock.close() }; if (incoming[f.id] !== f) sock.close() }
                        if (b.code != 200) { b.close(); throw IOException("HTTP ${b.code}") }
                        b
                    } else {
                        val h = if (fx.address.contains(':')) "[${fx.address}]" else fx.address
                        if (dead.get()) throw IOException("stopped")
                        val call = fx.client.newCall(Request.Builder().url("https://$h:$port$path").header(Proto.FX_HEADER, fx.token).build())
                        stopWith { call.cancel() }
                        if (incoming[f.id] !== f) call.cancel()
                        val res = call.execute()
                        if (res.code != 200) { res.close(); throw IOException("HTTP ${res.code}") }
                        res.body.byteStream()
                    }
                    body.use { s ->
                        val buf = ByteArray(256 * 1024)
                        var unsent = 0L
                        while (true) {
                            val n = s.read(buf)
                            if (n < 0) break
                            if (incoming[f.id] !== f || dead.get()) throw IOException("cancelled")
                            if (n > left) throw IOException("more than offered")
                            val bb = java.nio.ByteBuffer.wrap(buf, 0, n)
                            while (bb.hasRemaining()) pos += ch.write(bb, pos)
                            md.update(buf, 0, n)
                            left -= n
                            got.addAndGet(n.toLong())
                            unsent += n
                            if (unsent >= 1024 * 1024) { val d = unsent; unsent = 0; io.execute { gotBytes(f, d) } }
                        }
                        if (unsent > 0) { val d = unsent; io.execute { gotBytes(f, d) } }
                    }
                    if (left != 0L) throw IOException("the transfer stopped")
                    md.digest().hex()
                }
            }
            for ((i, j) in jobs.withIndex()) {
                try {
                    hashes[i] = j.get()
                } catch (e: java.util.concurrent.ExecutionException) {
                    stopAll() // the other ranges stop too
                    for (k in jobs) runCatching { k.get() } // … and write nothing more (the fx way may follow)
                    throw (e.cause ?: e)
                }
            }
            ch.force(false)
        } catch (e: Throwable) {
            error = e.message ?: "transfer failed"
        } finally {
            opened?.let { runCatching { it.second.close() } }
        }
        val wrote = got.get() > 0
        io.execute {
            if (error == null) {
                f.got = f.size
                f.fx2Hashes = hashes.map { it!! }
            }
            pulled2(f, error, wrote)
        }
    }

    private fun pulled2(f: Incoming, error: String?, wrote: Boolean) {
        f.pulling = false
        f.stop = null
        if (incoming[f.id] !== f) return // cancelled meanwhile
        if (error != null) {
            Log.w("TwinDesk", "fast file (fx2) ${f.name}: $error")
            if (wrote) return abort(f.id, error, true)
            fx2Broken = true
            core.send(msg(Proto.T.FILE_PULL, "id" to f.id, "failed" to true, "fx2" to 1)) // nothing came: the computer sends it the fx way
            return
        }
        f.heldEnd?.let { f.heldEnd = null; end(it) }
    }

    private fun gotBytes(f: Incoming, n: Long) {
        awake.touch()
        core.net.touch("files") // a Wi-Fi Direct group made for files stays up while they move
        batches[f.batch]?.let { it.got += n; note(it, false) }
    }

    private fun pulled(f: Incoming, error: String?, wrote: Boolean) {
        f.pulling = false
        f.stop = null
        if (incoming[f.id] !== f) return // cancelled meanwhile
        if (error != null) {
            Log.w("TwinDesk", "fast file ${f.name}: $error")
            if (wrote) return abort(f.id, error, true)
            fxBroken = true
            core.send(msg(Proto.T.FILE_PULL, "id" to f.id, "failed" to true)) // nothing came: the computer sends it as file.chunk
            return
        }
        f.heldEnd?.let { f.heldEnd = null; end(it) }
    }

    private fun fileFinished(b: Batch, ok: Boolean) {
        b.done++
        if (!ok) b.ok = false
        if (b.done < b.count) return
        batches.remove(b.id)
        val where = b.target.where.ifEmpty { "Download/TwinDesk" }
        if (drags.remove(b.id) != null) core.send(msg("drag.end", "drag" to b.id, "result" to if (b.ok) "dropped" else "failed", "where" to where))
        else core.send(msg(Proto.T.FILES_DONE, "batch" to b.id, "ok" to b.ok, "where" to where, "files" to b.done))
        val from = core.host?.name ?: tr("your computer")
        val what = if (b.tops.size == 1) b.tops.first() else trCount(b.tops.size, "item")
        recent.add(0, if (b.ok) tr("Received {what} from {from}", "what" to what, "from" to from) else tr("Some of {what} from {from}", "what" to what, "from" to from))
        while (recent.size > 20) recent.removeAt(recent.size - 1)
        if (b.target.onDone != null) {
            Notify.cancelFiles(core.ctx, b.key)
            b.target.onDone.invoke(b)
            if (b.target.where.isNotEmpty()) Notify.files(core.ctx, b.key, if (b.ok) tr("{what} from {from}", "what" to what, "from" to from) else tr("Some files didn’t arrive from {from}", "from" to from), tr("In {where}", "where" to b.target.where), null, null)
        } else {
            val open = if (b.placed.size == 1) Notify.viewIntent(b.placed[0].first, b.placed[0].second)
            else Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            Notify.files(core.ctx, b.key, if (b.ok) tr("{what} from {from}", "what" to what, "from" to from) else tr("Some files didn’t arrive from {from}", "from" to from), if (b.ok) tr("In Downloads › TwinDesk. Tap to open.") else tr("{what} is incomplete", "what" to what), null, open)
        }
        core.changed()
    }

    private fun note(b: Batch, force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && now - b.lastNote < 500) return
        b.lastNote = now
        if (b.target.onDone != null && b.target.where.isEmpty()) Notify.fclipProgress(core.ctx, tr("Copying {files} from {name}", "files" to trCount(b.count, "file"), "name" to (core.host?.name ?: tr("your computer"))), pct(b.got, b.bytes))
        else Notify.files(core.ctx, b.key, tr("Receiving {files} from {name}", "files" to trCount(b.count, "file"), "name" to (core.host?.name ?: tr("your computer"))), "${pct(b.got, b.bytes)}%", pct(b.got, b.bytes), null, cancel = b.id)
        core.changed()
    }

    // ---- out ----

    // rel: where it goes, folders kept (FsBrowse's folders); empty: the name alone.
    data class Item(val uri: Uri, val name: String, val size: Long, val rel: String = "")

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
        val unique = items.map { if (it.rel.contains('/')) return@map it; var n = it.name; var i = 2; while (!seen.add(n)) { n = it.name.substringBeforeLast('.') + " ${i++}" + it.name.substringAfterLast('.', "").let { e -> if (e.isEmpty()) "" else ".$e" } }; it.copy(name = n) }
        val bytes = unique.sumOf { it.size }
        outBatches[batch] = OutBatch(batch, kind, if (unique.size == 1) unique[0].name else trCount(unique.size, "item"), unique.size, bytes)
        unique.forEachIndexed { index, it ->
            val id = UUID.randomUUID().toString()
            outgoing.add(Outgoing(id, it.uri, it.name, it.size, batch))
            core.send(msg(Proto.T.FILE_OFFER, "id" to id, "name" to it.name, "size" to it.size, "drop" to kind, "batch" to batch, "rel" to it.rel.ifEmpty { it.name }, "index" to index, "count" to unique.size, "bytes" to bytes))
        }
        core.changed()
        return true
    }

    private fun pumpNext() {
        while (true) {
            val f = outgoing.firstOrNull { it.state == "accepted" } ?: return
            f.state = "sending"
            val fx = if (fxBroken) null else core.link.fx()
            val port2 = fx?.let { if (it.plain != null && it.plain.fx2Port > 0) it.plain.fx2Port else it.fx2Port } ?: 0
            if (fx != null && port2 > 0 && !fx2Broken) {
                val hashes = try {
                    upload2(f, fx, port2)
                } catch (e: NotSeekable) {
                    null // this file can't be read at offsets: the fx way, this file only
                } catch (e: Early) {
                    Log.w("TwinDesk", "fast file (fx2) ${f.name}: ${e.message}: the fx way for this session")
                    fx2Broken = true
                    null
                } catch (e: Exception) {
                    Log.w("TwinDesk", "send ${f.name}: ${e.message}")
                    core.send(msg(Proto.T.FILE_CANCEL, "id" to f.id))
                    outgoing.remove(f)
                    continue
                }
                if (hashes != null) {
                    core.send(msg(Proto.T.FILE_END, "id" to f.id, "sha256" to Fx2.joined(hashes), "fx2" to org.json.JSONArray(hashes)))
                    outgoing.remove(f)
                    continue
                }
            }
            if (fx != null) {
                val sha = try {
                    upload(f, fx)
                } catch (e: Early) {
                    Log.w("TwinDesk", "fast file ${f.name}: ${e.message}: file.chunk for this session")
                    fxBroken = true
                    null
                } catch (e: Exception) {
                    Log.w("TwinDesk", "send ${f.name}: ${e.message}")
                    core.send(msg(Proto.T.FILE_CANCEL, "id" to f.id))
                    outgoing.remove(f)
                    continue
                }
                if (sha != null) {
                    core.send(msg(Proto.T.FILE_END, "id" to f.id, "sha256" to sha))
                    outgoing.remove(f)
                    continue
                }
            }
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
                        sentBytes(f, n)
                    }
                }
                core.send(msg(Proto.T.FILE_END, "id" to f.id, "sha256" to md.digest().hex()))
            } catch (e: Exception) {
                Log.w("TwinDesk", "send ${f.name}: ${e.message}")
                core.send(msg(Proto.T.FILE_CANCEL, "id" to f.id))
            }
            outgoing.remove(f)
        }
    }

    private class Early(message: String) : IOException(message)
    private class NotSeekable(message: String) : IOException(message)

    // fx2: PUT its ranges at once, each read at its offset; the ranges' hashes for file.end.
    // Early: nothing went. NotSeekable: this file can't be read at offsets (a stream, not a file).
    private fun upload2(f: Outgoing, fx: Link.Fx, port: Int): List<String> {
        val pfd = runCatching { core.ctx.contentResolver.openFileDescriptor(f.uri, "r") }.getOrNull() ?: throw NotSeekable("no descriptor")
        pfd.use {
            val ch = java.io.FileInputStream(pfd.fileDescriptor).channel
            val len = runCatching { ch.size() }.getOrDefault(-1L)
            if (len != f.size) throw NotSeekable("not a file of its size")
            val plan = Fx2.plan(f.size)
            val sent = java.util.concurrent.atomic.AtomicLong(0)
            val dead = java.util.concurrent.atomic.AtomicBoolean(false)
            val stops = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()
            val stopWith: (() -> Unit) -> Unit = { s -> stops.add(s); if (dead.get()) runCatching { s() } }
            val jobs = plan.map { r ->
                ranges.submit<String> {
                    val md = MessageDigest.getInstance("SHA-256")
                    val pumpTo: (java.io.OutputStream) -> Unit = { out ->
                        val buf = ByteArray(256 * 1024)
                        val bb = java.nio.ByteBuffer.wrap(buf)
                        var pos = r.off
                        val end = r.off + r.len
                        while (pos < end) {
                            if (!outgoing.contains(f) || dead.get()) throw IOException("cancelled")
                            bb.clear()
                            bb.limit(minOf(buf.size.toLong(), end - pos).toInt())
                            val n = ch.read(bb, pos)
                            if (n < 0) throw IOException("the file shrank")
                            md.update(buf, 0, n)
                            out.write(buf, 0, n)
                            pos += n
                            sent.addAndGet(n.toLong())
                            synchronized(progress) { sentBytes(f, n) }
                        }
                    }
                    val path = Fx2.path(f.id, r, f.size)
                    if (dead.get()) throw IOException("stopped")
                    val code = if (fx.plain != null && fx.plain.fx2Port > 0) {
                        FxHttp.put(fx.address, port, path, fx.plain.token, r.len, { sock -> stopWith { sock.close() } }, pumpTo)
                    } else {
                        val body = object : RequestBody() {
                            override fun contentType() = "application/octet-stream".toMediaType()
                            override fun contentLength() = r.len
                            override fun isOneShot() = true
                            override fun writeTo(sink: BufferedSink) = pumpTo(sink.outputStream())
                        }
                        val h = if (fx.address.contains(':')) "[${fx.address}]" else fx.address
                        val call = fx.client.newCall(Request.Builder().url("https://$h:$port$path").header(Proto.FX_HEADER, fx.token).put(body).build())
                        stopWith { call.cancel() }
                        call.execute().use { it.code }
                    }
                    if (code != 200) throw IOException("HTTP $code")
                    md.digest().hex()
                }
            }
            val out = arrayOfNulls<String>(plan.size)
            for ((i, j) in jobs.withIndex()) {
                try {
                    out[i] = j.get()
                } catch (e: java.util.concurrent.ExecutionException) {
                    dead.set(true)
                    for (s in stops) runCatching { s() } // the other ranges stop too
                    for (k in jobs) runCatching { k.get() } // … and are done before the next file
                    val why = e.cause?.message ?: "no answer"
                    if (sent.get() == 0L && outgoing.contains(f)) throw Early(why)
                    throw IOException(why)
                }
            }
            return out.map { it!! }
        }
    }

    // PUT the file to the computer (fast files); its SHA-256 for file.end. Early: nothing went.
    private fun upload(f: Outgoing, fx: Link.Fx): String {
        val md = MessageDigest.getInstance("SHA-256")
        var sent = 0L
        // The file's bytes into `out`, hashed as they go.
        val pumpTo: (java.io.OutputStream) -> Unit = { out ->
            core.ctx.contentResolver.openInputStream(f.uri)!!.use { s ->
                val buf = ByteArray(256 * 1024)
                while (true) {
                    if (!outgoing.contains(f)) throw IOException("cancelled")
                    val n = s.read(buf)
                    if (n < 0) break
                    if (sent + n > f.size) throw IOException("the file grew")
                    md.update(buf, 0, n)
                    out.write(buf, 0, n)
                    sent += n
                    sentBytes(f, n)
                }
            }
        }
        val path = Uri.encode(f.id)
        try {
            val code = if (fx.plain != null) {
                FxHttp.put(fx.address, fx.plain.port, Proto.FX_PATH + path, fx.plain.token, f.size, {}, pumpTo)
            } else {
                val body = object : RequestBody() {
                    override fun contentType() = "application/octet-stream".toMediaType()
                    override fun contentLength() = f.size
                    override fun isOneShot() = true
                    override fun writeTo(sink: BufferedSink) = pumpTo(sink.outputStream())
                }
                val req = Request.Builder().url(fx.base + path).header(Proto.FX_HEADER, fx.token).put(body).build()
                fx.client.newCall(req).execute().use { it.code }
            }
            if (code != 200) throw if (sent == 0L) Early("HTTP $code") else IOException("HTTP $code")
        } catch (e: Early) {
            throw e
        } catch (e: IOException) {
            if (sent == 0L && outgoing.contains(f)) throw Early(e.message ?: "no answer")
            throw e
        }
        if (sent != f.size) throw IOException("the file shrank")
        return md.digest().hex()
    }

    private fun sentBytes(f: Outgoing, n: Int) {
        f.sent += n
        awake.touch()
        core.net.touch("files") // a Wi-Fi Direct group made for files stays up while they move
        val b = outBatches[f.batch] ?: return
        b.sent += n
        val now = System.currentTimeMillis()
        if (now - b.lastNote < 250 && b.sent < b.bytes) return
        b.lastNote = now
        core.changed()
        // Over 5 MB: a notification with a live progress bar, as for files coming in.
        if (b.bytes > 5L * 1024 * 1024) {
            b.shown = true
            Notify.files(core.ctx, b.key, tr("Sending {file} to {name}", "file" to b.name, "name" to (core.host?.name ?: tr("your computer"))), "${pct(b.sent, b.bytes)}%", pct(b.sent, b.bytes), null, up = true, cancel = b.id)
            if (outBatches[b.id] == null) Notify.cancelFiles(core.ctx, b.key) // cancelled meanwhile
        }
    }

    private fun cancelOut(id: String) {
        outgoing.removeIf { it.id == id }
    }

    private fun outDone(m: JSONObject) {
        val b = outBatches.remove(m.optString("batch")) ?: return
        outgoing.removeIf { it.batch == b.id }
        val to = core.host?.name ?: tr("your computer")
        if (b.shown) Notify.files(core.ctx, b.key, if (m.optBoolean("ok")) tr("Sent {file}", "file" to b.name) else tr("Some files weren’t delivered"), tr("On {name}", "name" to to), null, null, up = true)
        recent.add(0, if (m.optBoolean("ok")) tr("Sent {file} to {name}", "file" to b.name, "name" to to) else tr("{file} didn’t all arrive on {name}", "file" to b.name, "name" to to))
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
