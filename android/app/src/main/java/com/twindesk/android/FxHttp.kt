// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Unencrypted file transfers (the computers' shared/fastfile.js "fxPlain"; Files › Encrypt file
// transfers off on the computer): one GET or PUT of a file's bytes over plain HTTP/1.1 on a socket of
// its own. Not OkHttp: the app's network security policy refuses cleartext, and stays that way for
// everything else. The session (and the hashes in file.end, which the receiver checks) stays on TLS.
package com.twindesk.android

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket

object FxHttp {
    private const val TIMEOUT_MS = 30000 // the computer's IDLE_MS

    // A response body: read() until -1; close() closes the socket.
    class Body(val code: Int, input: InputStream, private val socket: Socket) : FilterInputStream(input) {
        override fun close() { runCatching { socket.close() } }
    }

    // opened(socket): as soon as it's connected, so a cancel can close it.
    private fun connect(host: String, port: Int, opened: (Socket) -> Unit): Socket {
        val s = Socket()
        opened(s)
        s.tcpNoDelay = true
        s.soTimeout = TIMEOUT_MS
        s.receiveBufferSize = 1024 * 1024
        s.sendBufferSize = 1024 * 1024
        s.connect(InetSocketAddress(host, port), 5000)
        return s
    }

    private fun head(method: String, host: String, port: Int, path: String, token: String, length: Long?): ByteArray {
        val h = StringBuilder()
            .append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
            .append("Host: ").append(if (host.contains(':')) "[$host]" else host).append(':').append(port).append("\r\n")
            .append(Proto.FX_HEADER).append(": ").append(token).append("\r\n")
            .append("Connection: close\r\n")
        if (length != null) h.append("Content-Type: application/octet-stream\r\nContent-Length: ").append(length).append("\r\n")
        return h.append("\r\n").toString().toByteArray(Charsets.US_ASCII)
    }

    private class Head(val code: Int, val length: Long, val chunked: Boolean)

    // The response head on `input`: status code, Content-Length (-1: none), chunked.
    private fun readHead(input: InputStream): Head {
        val lines = mutableListOf<String>()
        val line = StringBuilder()
        var total = 0
        while (true) {
            val c = input.read()
            if (c < 0) throw IOException("the connection closed")
            if (++total > 16384) throw IOException("bad response")
            if (c == '\n'.code) {
                val l = line.toString().trimEnd('\r')
                line.setLength(0)
                if (l.isEmpty()) break
                lines.add(l)
            } else line.append(c.toChar())
        }
        val code = lines.firstOrNull()?.split(' ')?.getOrNull(1)?.toIntOrNull() ?: throw IOException("bad response")
        var length = -1L
        var chunked = false
        for (l in lines.drop(1)) {
            val i = l.indexOf(':')
            if (i <= 0) continue
            val k = l.substring(0, i).trim().lowercase()
            val v = l.substring(i + 1).trim()
            if (k == "content-length") length = v.toLongOrNull() ?: -1L
            if (k == "transfer-encoding") chunked = v.lowercase().split(',').map { it.trim() }.lastOrNull() == "chunked"
        }
        return Head(code, length, chunked)
    }

    // A chunked body (Node answers that way when it has no Content-Length, as for a 403).
    private class Chunked(private val input: InputStream) : InputStream() {
        private var left = 0L
        private var done = false

        private fun line(): String {
            val b = StringBuilder()
            while (true) {
                val c = input.read()
                if (c < 0) throw IOException("the transfer stopped")
                if (c == '\n'.code) return b.toString().trimEnd('\r')
                if (b.length > 1024) throw IOException("bad chunk")
                b.append(c.toChar())
            }
        }

        private fun next(): Boolean {
            if (done) return false
            if (left == 0L) {
                left = line().substringBefore(';').trim().toLongOrNull(16) ?: throw IOException("bad chunk")
                if (left == 0L) { done = true; while (line().isNotEmpty()) Unit; return false }
            }
            return true
        }

        override fun read(): Int {
            if (!next()) return -1
            val c = input.read()
            if (c < 0) throw IOException("the transfer stopped")
            if (--left == 0L) line()
            return c
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (!next()) return -1
            val n = input.read(b, off, minOf(len.toLong(), left).toInt())
            if (n < 0) throw IOException("the transfer stopped")
            left -= n
            if (left == 0L) line()
            return n
        }
    }

    // A body of exactly `length` bytes (-1: until the connection closes).
    private class Limited(input: InputStream, private var left: Long) : FilterInputStream(input) {
        override fun read(): Int {
            if (left == 0L) return -1
            val c = super.read()
            if (c >= 0 && left > 0) left--
            return c
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left == 0L) return -1
            val n = super.read(b, off, if (left > 0) minOf(len.toLong(), left).toInt() else len)
            if (n < 0 && left > 0) throw IOException("the transfer stopped")
            if (n > 0 && left > 0) left -= n
            return n
        }
    }

    fun get(host: String, port: Int, path: String, token: String, opened: (Socket) -> Unit): Body {
        val s = connect(host, port, opened)
        try {
            s.getOutputStream().apply { write(head("GET", host, port, path, token, null)); flush() }
            val input = BufferedInputStream(s.getInputStream(), 256 * 1024)
            val h = readHead(input)
            return Body(h.code, if (h.chunked) Chunked(input) else Limited(input, h.length), s)
        } catch (e: Exception) {
            runCatching { s.close() }
            throw e
        }
    }

    // Writes the body with write(out); the response's status code.
    fun put(host: String, port: Int, path: String, token: String, length: Long, opened: (Socket) -> Unit, write: (OutputStream) -> Unit): Int {
        val s = connect(host, port, opened)
        s.use {
            val out = BufferedOutputStream(s.getOutputStream(), 256 * 1024)
            out.write(head("PUT", host, port, path, token, length))
            write(out)
            out.flush()
            return readHead(BufferedInputStream(s.getInputStream())).code // the body (if any) isn't needed
        }
    }
}
