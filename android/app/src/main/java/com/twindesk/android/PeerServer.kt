// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This phone as a host for another phone (Connect with Android, Peer.kt): TLS on PEER_PORT with this
// phone's own key (ShareKey, the shared folder's), whose certificate the other phone pins after
// pairing, exactly as it pins a computer's. One socket is the session, a WebSocket (RFC 6455, text
// frames only, what OkHttp sends); the others are HTTP/1.1 requests for the bytes that shouldn't go
// through it (files, the screen), each checked with the session's key by Peer.
// Nothing here knows the protocol: Peer gets each socket's messages and each request.
package com.twindesk.android

import android.util.Base64
import android.util.Log
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.SSLServerSocket
import kotlin.concurrent.thread

class PeerServer(private val handler: Handler) {
    interface Handler {
        fun onOpen(ws: Ws)
        fun onText(ws: Ws, text: String)
        fun onClose(ws: Ws)
        // An HTTP request that isn't the WebSocket: answer it on `out` (respond()), reading `body`.
        fun onRequest(method: String, path: String, headers: Map<String, String>, body: InputStream, out: OutputStream, sock: Socket)
    }

    private var server: ServerSocket? = null
    val port get() = server?.localPort ?: 0
    val running get() = server != null

    @Synchronized
    fun start(): Boolean {
        if (server != null) return true
        val ssl = runCatching { ShareKey.ssl() }.getOrElse { Log.w("TwinDesk", "peer: no key (${it.message})"); return false }
        val s = ssl.serverSocketFactory.createServerSocket() as SSLServerSocket
        s.reuseAddress = true
        // Its own port, else any (the beacon says which).
        if (runCatching { s.bind(InetSocketAddress(PEER_PORT)) }.isFailure) {
            if (runCatching { s.bind(InetSocketAddress(0)) }.isFailure) { runCatching { s.close() }; return false }
        }
        server = s
        thread(isDaemon = true, name = "td-peer-srv") {
            while (!s.isClosed) {
                val c = runCatching { s.accept() }.getOrNull() ?: break
                thread(isDaemon = true, name = "td-peer-c") { runCatching { serve(c) }.onFailure { runCatching { c.close() } } }
            }
        }
        Log.i("TwinDesk", "peer: hosting on $port")
        return true
    }

    @Synchronized
    fun stop() {
        runCatching { server?.close() }
        server = null
    }

    private fun serve(sock: Socket) {
        sock.soTimeout = 30_000
        sock.tcpNoDelay = true
        val inp = BufferedInputStream(sock.getInputStream(), 64 * 1024)
        val out = BufferedOutputStream(sock.getOutputStream(), 64 * 1024)
        try {
            while (true) {
                val line = readLine(inp) ?: return
                if (line.isEmpty()) continue
                val parts = line.split(' ')
                if (parts.size < 3) return
                val headers = HashMap<String, String>()
                while (true) {
                    val h = readLine(inp) ?: return
                    if (h.isEmpty()) break
                    val i = h.indexOf(':')
                    if (i > 0 && headers.size < 64) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
                }
                if (headers["upgrade"].equals("websocket", true)) return websocket(sock, inp, out, headers)
                val body = Body(inp, headers)
                handler.onRequest(parts[0].uppercase(), parts[1], headers, body, out, sock)
                body.drain()
                out.flush()
                if (headers["connection"].equals("close", true)) return
            }
        } finally {
            runCatching { sock.close() }
        }
    }

    // ---- WebSocket ----

    private fun websocket(sock: Socket, inp: InputStream, out: OutputStream, headers: Map<String, String>) {
        val key = headers["sec-websocket-key"] ?: return respond(out, 400)
        val accept = Base64.encodeToString(MessageDigest.getInstance("SHA-1").digest((key + WS_GUID).toByteArray()), Base64.NO_WRAP)
        out.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
        out.flush()
        sock.soTimeout = 0 // liveness is Peer's (pings)
        val ws = Ws(sock, out)
        ws.startWriter()
        handler.onOpen(ws)
        try {
            val msg = ByteArrayOutputStream()
            var msgOp = -1
            while (true) {
                val b0 = inp.read()
                if (b0 < 0) break
                val b1 = inp.read()
                if (b1 < 0) break
                val fin = b0 and 0x80 != 0
                val op = b0 and 0x0f
                val masked = b1 and 0x80 != 0
                var len = (b1 and 0x7f).toLong()
                if (len == 126L) len = ((readByte(inp) shl 8) or readByte(inp)).toLong()
                else if (len == 127L) { len = 0; repeat(8) { len = (len shl 8) or readByte(inp).toLong() } }
                if (len < 0 || len > Proto.MAX_PAYLOAD || msg.size() + len > Proto.MAX_PAYLOAD) throw IOException("too big")
                val mask = if (masked) ByteArray(4).also { readFully(inp, it) } else null
                val data = ByteArray(len.toInt())
                readFully(inp, data)
                if (mask != null) for (i in data.indices) data[i] = (data[i].toInt() xor mask[i and 3].toInt()).toByte()
                when (op) {
                    0x8 -> { ws.close(); break }
                    0x9 -> ws.frame(0xA, data)
                    0xA -> Unit
                    0x0, 0x1, 0x2 -> {
                        if (op != 0) { msg.reset(); msgOp = op }
                        msg.write(data)
                        if (fin) {
                            if (msgOp == 1) handler.onText(ws, msg.toString("UTF-8"))
                            msg.reset()
                            msgOp = -1
                        }
                    }
                    else -> throw IOException("opcode $op")
                }
            }
        } catch (e: Exception) {
            if (e !is EOFException && e !is java.net.SocketException) Log.w("TwinDesk", "peer: socket ended", e)
        } finally {
            ws.close()
            handler.onClose(ws)
        }
    }

    // One WebSocket: what goes out waits in a queue for its own thread, so nobody sending blocks on
    // the network (the UI sends too). queued(): bytes not written yet (files and thumbnails wait on it).
    class Ws(val sock: Socket, private val out: OutputStream) {
        private val q = LinkedBlockingQueue<ByteArray>()
        private val pending = AtomicLong(0)
        @Volatile var open = true; private set
        @Volatile var lastRx = System.currentTimeMillis()
        val address: String get() = sock.inetAddress?.hostAddress ?: ""
        var tag: Any? = null // Peer's state for it

        fun queued(): Long = pending.get()

        fun send(text: String): Boolean {
            if (!open) return false
            val b = text.toByteArray()
            pending.addAndGet(b.size.toLong())
            q.offer(encode(0x1, b))
            return true
        }

        fun frame(op: Int, data: ByteArray) { if (open) q.offer(encode(op, data)) }

        fun startWriter() = thread(isDaemon = true, name = "td-peer-ws") {
            try {
                while (open || q.isNotEmpty()) {
                    val f = q.poll(1, java.util.concurrent.TimeUnit.SECONDS) ?: continue
                    if (f.isEmpty()) break
                    out.write(f)
                    if (q.isEmpty()) out.flush()
                    if (f.size > 1 && (f[0].toInt() and 0x0f) == 0x1) pending.addAndGet(-payloadLen(f))
                }
            } catch (_: Exception) {
            } finally {
                open = false
                runCatching { sock.close() }
            }
        }

        fun close() {
            if (!open) return
            runCatching { q.offer(encode(0x8, ByteArray(0))) }
            open = false
            q.offer(ByteArray(0)) // the writer ends after what's queued
        }

        private fun payloadLen(f: ByteArray): Long {
            val l = f[1].toInt() and 0x7f
            return when (l) {
                126 -> (((f[2].toInt() and 0xff) shl 8) or (f[3].toInt() and 0xff)).toLong()
                127 -> { var n = 0L; for (i in 2 until 10) n = (n shl 8) or (f[i].toLong() and 0xff); n }
                else -> l.toLong()
            }
        }

        private fun encode(op: Int, data: ByteArray): ByteArray {
            val n = data.size
            val head = when {
                n < 126 -> byteArrayOf((0x80 or op).toByte(), n.toByte())
                n < 65536 -> byteArrayOf((0x80 or op).toByte(), 126, (n shr 8).toByte(), n.toByte())
                else -> ByteArray(10).also { h ->
                    h[0] = (0x80 or op).toByte(); h[1] = 127
                    for (i in 0 until 8) h[9 - i] = ((n.toLong() shr (8 * i)) and 0xff).toByte()
                }
            }
            return head + data
        }
    }

    // ---- HTTP ----

    // The request's body: by Content-Length, or chunked (OkHttp sends a stream of unknown length so).
    class Body(private val inp: InputStream, headers: Map<String, String>) : InputStream() {
        private val chunked = headers["transfer-encoding"]?.contains("chunked", true) == true
        private var left = if (chunked) 0L else headers["content-length"]?.toLongOrNull() ?: 0L
        private var done = !chunked && left == 0L
        val length: Long = if (chunked) -1 else left

        private fun nextChunk(): Boolean {
            if (left > 0) return true
            if (done) return false
            if (!chunked) { done = true; return false }
            val size = (readLine(inp) ?: "").substringBefore(';').trim().toLongOrNull(16) ?: 0L
            if (size == 0L) {
                while ((readLine(inp) ?: "").isNotEmpty()) Unit
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
            if (len == 0) return 0
            if (!nextChunk()) return -1
            val n = inp.read(b, off, minOf(len.toLong(), left).toInt())
            if (n < 0) { done = true; return -1 }
            left -= n
            if (left == 0L && chunked) readLine(inp)
            if (left == 0L && !chunked) done = true
            return n
        }

        fun drain() {
            val buf = ByteArray(16 * 1024)
            while (read(buf, 0, buf.size) >= 0) Unit
        }
    }

    companion object {
        const val PEER_PORT = 47806
        private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

        fun readLine(inp: InputStream): String? {
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

        private fun readByte(inp: InputStream): Int { val c = inp.read(); if (c < 0) throw EOFException(); return c }

        private fun readFully(inp: InputStream, b: ByteArray) {
            var n = 0
            while (n < b.size) { val r = inp.read(b, n, b.size - n); if (r < 0) throw EOFException(); n += r }
        }

        private val reasons = mapOf(200 to "OK", 400 to "Bad Request", 403 to "Forbidden", 404 to "Not Found", 409 to "Conflict", 500 to "Internal Server Error")

        fun respond(out: OutputStream, code: Int, body: ByteArray = ByteArray(0), type: String = "text/plain") {
            out.write("HTTP/1.1 $code ${reasons[code] ?: "OK"}\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\n\r\n".toByteArray())
            out.write(body)
        }

        // A response whose length isn't known (a stream): its bytes until the socket closes.
        fun streamHead(out: OutputStream, length: Long = -1) {
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n" +
                (if (length >= 0) "Content-Length: $length\r\n" else "Connection: close\r\n") + "\r\n").toByteArray())
        }
    }
}
