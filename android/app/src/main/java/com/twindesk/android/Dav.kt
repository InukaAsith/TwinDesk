// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A folder of this phone over WebDAV, for the computer's file manager (FolderShare.kt): Finder,
// Explorer (WebClient) and GVFS mount it through shared/foldershare.js's proxy there, only at
// https://<phone>:<port>/<secret>/<volume>/. TLS with this phone's own key (ShareKey), whose
// certificate the computer gets through the session and pins; connections from anywhere but the
// computer's address are closed before TLS starts; the secret, made per run, is the URL's first
// segment. The folders above it ('/' and '/<secret>') answer as empty ones, which Explorer looks at
// while mapping.
// The computers' own files (.DS_Store and ._* from a Mac, desktop.ini and Thumbs.db from Windows,
// .directory from KDE) stay in memory here, so nothing of theirs lands on the phone.
package com.twindesk.android

import android.net.Uri
import android.util.Log
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import kotlin.concurrent.thread

class Dav(private val root: File, private val secret: String, private val volume: String, private val ssl: SSLContext, private val allow: (InetAddress) -> Boolean) {
    private var server: ServerSocket? = null
    val port get() = server?.localPort ?: 0
    private val sidecars = ConcurrentHashMap<String, Pair<ByteArray, Long>>() // relative path -> (data, mtime)

    fun start() {
        if (server != null) return
        val s = ssl.serverSocketFactory.createServerSocket() as SSLServerSocket
        s.reuseAddress = true
        s.bind(InetSocketAddress(0))
        server = s
        thread(isDaemon = true, name = "td-dav") {
            while (!s.isClosed) {
                val c = runCatching { s.accept() }.getOrNull() ?: break
                if (!allow(c.inetAddress)) { runCatching { c.close() }; continue } // only the computer in the session
                thread(isDaemon = true, name = "td-dav-c") { runCatching { serve(c) } }
            }
        }
    }

    fun stop() {
        runCatching { server?.close() }
        server = null
        sidecars.clear()
    }

    // ---- HTTP/1.1, kept alive ----

    private fun serve(sock: Socket) = sock.use {
        sock.soTimeout = 120_000
        sock.tcpNoDelay = true
        val inp = BufferedInputStream(sock.getInputStream(), 64 * 1024)
        val out = BufferedOutputStream(sock.getOutputStream(), 64 * 1024)
        while (true) {
            val line = readLine(inp) ?: return
            if (!allow(sock.inetAddress)) return // the session moved off this address
            if (line.isEmpty()) continue
            val parts = line.split(' ')
            if (parts.size < 3) return
            val headers = HashMap<String, String>()
            while (true) {
                val h = readLine(inp) ?: return
                if (h.isEmpty()) break
                val i = h.indexOf(':')
                if (i > 0) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
            }
            val body = Body(inp, headers)
            try {
                handle(parts[0].uppercase(), parts[1], headers, body, out)
            } catch (e: Exception) {
                Log.w("TwinDesk", "dav ${parts[0]} ${parts[1]}: $e")
                return
            }
            body.drain()
            out.flush()
            if (headers["connection"].equals("close", true)) return
        }
    }

    private fun readLine(inp: InputStream): String? {
        val b = ByteArrayOutputStream()
        while (true) {
            val c = inp.read()
            if (c < 0) return if (b.size() == 0) null else b.toString("UTF-8")
            if (c == '\n'.code) break
            if (b.size() > 16 * 1024) return null
            b.write(c)
        }
        return b.toString("UTF-8").trimEnd('\r')
    }

    // The request's body: by Content-Length, or chunked (Finder sends files that way).
    private inner class Body(private val inp: InputStream, headers: Map<String, String>) : InputStream() {
        private val chunked = headers["transfer-encoding"]?.contains("chunked", true) == true
        private var left = if (chunked) 0L else headers["content-length"]?.toLongOrNull() ?: 0L
        private var done = !chunked && left == 0L
        val empty get() = !chunked && left == 0L

        private fun nextChunk(): Boolean {
            if (left > 0) return true
            if (done) return false
            if (!chunked) { done = true; return false }
            val size = (readLine(inp) ?: "").substringBefore(';').trim().toLongOrNull(16) ?: 0L
            if (size == 0L) {
                while ((readLine(inp) ?: "").isNotEmpty()) Unit // trailers
                done = true
                return false
            }
            left = size
            return true
        }

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (!nextChunk()) return -1
            val n = inp.read(b, off, minOf(len.toLong(), left).toInt())
            if (n < 0) { done = true; return -1 }
            left -= n
            if (left == 0L && chunked) readLine(inp) // the CRLF after a chunk
            if (left == 0L && !chunked) done = true
            return n
        }

        fun drain() {
            val buf = ByteArray(16 * 1024)
            while (read(buf, 0, buf.size) >= 0) Unit
        }
    }

    private val reasons = mapOf(200 to "OK", 201 to "Created", 204 to "No Content", 206 to "Partial Content", 207 to "Multi-Status", 400 to "Bad Request",
        403 to "Forbidden", 404 to "Not Found", 405 to "Method Not Allowed", 409 to "Conflict", 412 to "Precondition Failed", 416 to "Range Not Satisfiable", 500 to "Internal Server Error")

    private fun head(out: OutputStream, code: Int, headers: Map<String, String>, length: Long) {
        val sb = StringBuilder("HTTP/1.1 $code ${reasons[code] ?: "OK"}\r\n")
        for ((k, v) in headers) sb.append(k).append(": ").append(v).append("\r\n")
        sb.append("Content-Length: ").append(length).append("\r\n\r\n")
        out.write(sb.toString().toByteArray())
    }

    private fun respond(out: OutputStream, code: Int, headers: Map<String, String> = emptyMap(), body: ByteArray = ByteArray(0)) {
        head(out, code, headers, body.size.toLong())
        out.write(body)
    }

    // ---- WebDAV ----

    private val hide = Regex("^(\\.metadata_never_index.*|\\.Spotlight-V100|\\.Trashes|\\.fseventsd|\\.hidden|\\.localized|Backups\\.backupdb|\\.ql_disable.*|\\.VolumeIcon\\.icns|\\.com\\.apple\\..*|mach_kernel|\\.TemporaryItems|\\\$RECYCLE\\.BIN|System Volume Information|autorun\\.inf|\\.Trash(-\\d+)?)$", RegexOption.IGNORE_CASE)
    private val sidecar = Regex("^(\\.DS_Store|\\._.*|desktop\\.ini|Thumbs\\.db|ehthumbs(_vista)?\\.db|\\.directory)$", RegexOption.IGNORE_CASE)

    private class Entry(val name: String, val dir: Boolean, val size: Long, val mtime: Long)

    private fun httpDate(t: Long) = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(t))
    private fun isoDate(t: Long) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(t))
    private fun xml(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&apos;")

    // The URL's path, decoded, in segments.
    private fun segments(target: String): List<String>? = runCatching {
        target.substringBefore('?').split('/').filter { it.isNotEmpty() }.map { Uri.decode(it) }
    }.getOrNull()

    // Segments -> the path inside the folder ("" for it), or null when it's elsewhere.
    private fun rel(segs: List<String>): String? {
        if (segs.size < 2 || segs[0] != secret || segs[1] != volume) return null
        val rest = segs.drop(2).filter { it != "." }
        if (rest.any { it == ".." || it.contains('/') || it.contains('\u0000') }) return null
        return rest.joinToString("/")
    }

    private fun href(rel: String, dir: Boolean) =
        "/" + (listOf(secret, volume) + rel.split('/').filter { it.isNotEmpty() }).joinToString("/") { Uri.encode(it) } + if (dir) "/" else ""

    private fun file(rel: String) = if (rel.isEmpty()) root else File(root, rel)
    private fun base(rel: String) = rel.substringAfterLast('/')
    private fun parentOf(rel: String) = if (rel.contains('/')) rel.substringBeforeLast('/') else ""

    private fun stat(rel: String): Entry? {
        sidecars[rel]?.let { return Entry(base(rel), false, it.first.size.toLong(), it.second) }
        if (rel.isNotEmpty() && (hide.matches(base(rel)) || sidecar.matches(base(rel)))) return null
        val f = file(rel)
        if (!f.exists()) return null
        return Entry(if (rel.isEmpty()) volume else f.name, f.isDirectory, if (f.isDirectory) 0 else f.length(), f.lastModified())
    }

    private fun list(rel: String): List<Entry> {
        val out = ArrayList<Entry>()
        file(rel).listFiles()?.forEach { f ->
            if (!hide.matches(f.name) && !sidecar.matches(f.name)) out += Entry(f.name, f.isDirectory, if (f.isDirectory) 0 else f.length(), f.lastModified())
        }
        for ((k, v) in sidecars) if (parentOf(k) == rel) out += Entry(base(k), false, v.first.size.toLong(), v.second)
        return out
    }

    private fun entryXml(href: String, e: Entry, quota: Boolean = false): String {
        val sb = StringBuilder("<D:response><D:href>${xml(href)}</D:href><D:propstat><D:prop>")
        sb.append("<D:displayname>${xml(e.name)}</D:displayname>")
        sb.append("<D:resourcetype>${if (e.dir) "<D:collection/>" else ""}</D:resourcetype>")
        if (!e.dir) sb.append("<D:getcontentlength>${e.size}</D:getcontentlength><D:getcontenttype>${xml(mime(e.name))}</D:getcontenttype>")
        sb.append("<D:getlastmodified>${httpDate(e.mtime)}</D:getlastmodified><D:creationdate>${isoDate(e.mtime)}</D:creationdate>")
        sb.append("<D:getetag>\"${e.size.toString(16)}-${(e.mtime / 1000).toString(16)}\"</D:getetag>")
        if (quota) sb.append("<D:quota-available-bytes>${root.usableSpace}</D:quota-available-bytes><D:quota-used-bytes>${(root.totalSpace - root.usableSpace).coerceAtLeast(0)}</D:quota-used-bytes>")
        return sb.append("</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>").toString()
    }

    private fun mime(name: String) = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    private fun multistatus(out: OutputStream, body: String) = respond(
        out, 207, mapOf("Content-Type" to "application/xml; charset=utf-8"),
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><D:multistatus xmlns:D=\"DAV:\">$body</D:multistatus>".toByteArray(),
    )

    private fun handle(method: String, target: String, h: Map<String, String>, body: Body, out: OutputStream) {
        if (method == "OPTIONS") return respond(out, 200, mapOf("DAV" to "1, 2", "MS-Author-Via" to "DAV", "Allow" to "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK"))
        val segs = segments(target) ?: return respond(out, 400)
        // Above the volume: '/' and '/<secret>', empty.
        if (segs.isEmpty() || (segs.size == 1 && segs[0] == secret)) {
            if (method != "PROPFIND") return respond(out, if (method == "GET" || method == "HEAD") 200 else 405)
            val href = "/" + segs.joinToString("/") { Uri.encode(it) } + (if (segs.isEmpty()) "" else "/")
            return multistatus(out, entryXml(href, Entry(segs.lastOrNull() ?: "/", true, 0, System.currentTimeMillis())))
        }
        val rel = rel(segs) ?: return respond(out, 404)
        val name = base(rel)
        when (method) {
            "PROPFIND" -> {
                val e = stat(rel) ?: return respond(out, 404)
                val sb = StringBuilder(entryXml(href(rel, e.dir), e, rel.isEmpty()))
                if (e.dir && h["depth"] != "0") for (c in list(rel)) sb.append(entryXml(href(if (rel.isEmpty()) c.name else "$rel/${c.name}", c.dir), c))
                multistatus(out, sb.toString())
            }
            "PROPPATCH" -> multistatus(out, "<D:response><D:href>${xml(href(rel, false))}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>")
            "LOCK" -> {
                val token = "opaquelocktoken:${UUID.randomUUID()}"
                respond(
                    out, 200, mapOf("Content-Type" to "application/xml; charset=utf-8", "Lock-Token" to "<$token>"),
                    ("<?xml version=\"1.0\" encoding=\"utf-8\"?><D:prop xmlns:D=\"DAV:\"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype>" +
                        "<D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:timeout>Second-600</D:timeout><D:locktoken><D:href>$token</D:href></D:locktoken>" +
                        "</D:activelock></D:lockdiscovery></D:prop>").toByteArray(),
                )
            }
            "UNLOCK" -> respond(out, 204)
            "GET", "HEAD" -> {
                val e = stat(rel) ?: return respond(out, 404)
                if (e.dir) return respond(out, 200, mapOf("Content-Type" to "text/plain"))
                val size = e.size
                var start = 0L
                var end = size - 1
                val range = Regex("^bytes=(\\d*)-(\\d*)$").find(h["range"] ?: "")
                val partial = range != null && size > 0
                if (partial) {
                    val (a, b) = range!!.destructured
                    if (a.isNotEmpty()) start = a.toLong()
                    if (b.isNotEmpty()) end = if (a.isNotEmpty()) minOf(b.toLong(), end) else size - 1
                    if (a.isEmpty() && b.isNotEmpty()) start = maxOf(0, size - b.toLong())
                    if (start > end) return respond(out, 416, mapOf("Content-Range" to "bytes */$size"))
                }
                val len = if (size > 0) end - start + 1 else 0
                val headers = linkedMapOf("Content-Type" to mime(name), "Last-Modified" to httpDate(e.mtime), "Accept-Ranges" to "bytes")
                if (partial) headers["Content-Range"] = "bytes $start-$end/$size"
                head(out, if (partial) 206 else 200, headers, len)
                if (method == "HEAD" || len == 0L) return
                val sc = sidecars[rel]
                if (sc != null) return out.write(sc.first, start.toInt(), len.toInt())
                file(rel).inputStream().use { fin ->
                    var skip = start
                    while (skip > 0) { val n = fin.skip(skip); if (n <= 0) break; skip -= n }
                    val buf = ByteArray(64 * 1024)
                    var left = len
                    while (left > 0) {
                        val n = fin.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                        if (n < 0) break
                        out.write(buf, 0, n)
                        left -= n
                    }
                }
            }
            "PUT" -> {
                if (rel.isEmpty()) return respond(out, 405)
                if (sidecar.matches(name)) {
                    val b = ByteArrayOutputStream()
                    val buf = ByteArray(16 * 1024)
                    while (true) { val n = body.read(buf, 0, buf.size); if (n < 0) break; if (b.size() < 4 * 1024 * 1024) b.write(buf, 0, n) }
                    sidecars[rel] = b.toByteArray() to System.currentTimeMillis()
                    return respond(out, 201)
                }
                if (hide.matches(name)) return respond(out, 403)
                val f = file(rel)
                if (f.parentFile?.isDirectory != true) return respond(out, 409)
                val existed = f.exists()
                val ok = runCatching { f.outputStream().use { body.copyTo(it, 64 * 1024) } }.isSuccess
                respond(out, if (!ok) 409 else if (existed) 204 else 201)
            }
            "MKCOL" -> {
                val f = file(rel)
                respond(out, if (f.exists()) 405 else if (f.mkdir()) 201 else 409)
            }
            "DELETE" -> {
                if (sidecars.remove(rel) != null) return respond(out, 204)
                if (rel.isEmpty()) return respond(out, 403)
                val f = file(rel)
                if (!f.exists()) return respond(out, 404)
                sidecars.keys.removeAll { it.startsWith("$rel/") }
                respond(out, if (f.deleteRecursively()) 204 else 409)
            }
            "MOVE", "COPY" -> {
                val dest = runCatching { segments(Uri.parse(h["destination"] ?: "").encodedPath ?: "") }.getOrNull()?.let { rel(it) }
                if (dest.isNullOrEmpty() || rel.isEmpty()) return respond(out, 400)
                val overwrite = !(h["overwrite"] ?: "T").equals("F", true)
                val sc = sidecars[rel]
                if (sc != null || sidecar.matches(base(dest))) {
                    if (sc != null) sidecars[dest] = sc
                    if (method == "MOVE") sidecars.remove(rel)
                    return respond(out, 201)
                }
                val from = file(rel)
                val to = file(dest)
                if (!from.exists()) return respond(out, 404)
                val exists = to.exists()
                if (exists && !overwrite) return respond(out, 412)
                if (exists) to.deleteRecursively()
                val ok = if (method == "MOVE") from.renameTo(to) || (from.copyRecursively(to) && from.deleteRecursively()) else from.copyRecursively(to)
                respond(out, if (!ok) 409 else if (exists) 204 else 201)
            }
            else -> respond(out, 405)
        }
    }
}
