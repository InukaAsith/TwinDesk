// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Your own relay (the computer's General › Your own relay, shared/relay.js): a computer that has
// one tells this device in its welcome ("relay": {addr, key, id}), kept with that computer (Host).
// When this device doesn't see the computer on its network, every other attempt goes through it
// (Core.connect, as Tailscale's do): a pipe on 127.0.0.1 here, joined to the relay, so the session
// inside is the usual one (TLS with the computer's pinned certificate, the token). The relay only
// passes bytes on. Nothing runs for a computer without a relay; nothing stays open after a session.
package com.twindesk.android

import android.util.Log
import org.json.JSONObject
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections

data class RelayInfo(val host: String, val port: Int, val key: String, val id: String) {
    fun json(): JSONObject = JSONObject().put("addr", if (host.contains(':')) "[$host]:$port" else "$host:$port").put("key", key).put("id", id)

    companion object {
        private val ID = Regex("^[0-9a-f]{32}$")
        private val NAME = Regex("^[A-Za-z0-9.-]{1,253}$")
        fun from(o: JSONObject?): RelayInfo? {
            o ?: return null
            val id = o.optString("id")
            if (!ID.matches(id)) return null
            val a = o.optString("addr").trim()
            val v6 = Regex("^\\[([0-9a-fA-F:.]+)](?::(\\d{1,5}))?$").find(a)
            val plain = Regex("^([A-Za-z0-9.-]+)(?::(\\d{1,5}))?$").find(a)
            val (h, p) = when {
                v6 != null -> v6.groupValues[1] to v6.groupValues[2]
                plain != null && NAME.matches(plain.groupValues[1]) -> plain.groupValues[1] to plain.groupValues[2]
                else -> return null
            }
            val port = p.toIntOrNull() ?: 47100
            if (port !in 1..65535) return null
            return RelayInfo(h, port, o.optString("key").filter { it.code in 0x21..0x7e }.take(128), id)
        }
    }
}

object Relay {
    // The local ports of pipes open now (a session through one isn't a cable, and its address isn't kept).
    val ports: MutableSet<Int> = Collections.synchronizedSet(mutableSetOf())

    // A pipe to the computer through the relay: a 127.0.0.1 port to connect the session to, or null
    // when the relay can't be reached or the computer isn't there. Blocks: call it off the main thread.
    fun open(r: RelayInfo): Int? {
        val up = runCatching {
            Socket().apply {
                tcpNoDelay = true
                connect(InetSocketAddress(r.host, r.port), 8000)
                soTimeout = 16000
            }
        }.onFailure { Log.i("TwinDesk", "relay: can't reach it (${it.message})") }.getOrNull() ?: return null
        val ok = runCatching {
            up.getOutputStream().apply { write("TDR1 join ${r.id} ${r.key.ifEmpty { "-" }}\n".toByteArray()); flush() }
            val line = StringBuilder()
            val ins = up.getInputStream()
            while (line.length < 64) {
                val c = ins.read()
                if (c < 0 || c == '\n'.code) break
                line.append(c.toChar())
            }
            line.toString().trim()
        }.getOrDefault("")
        if (ok != "ok") {
            Log.i("TwinDesk", "relay: ${if (ok == "key") "its key is wrong" else if (ok == "no") "the computer isn't there" else "no answer"}")
            runCatching { up.close() }
            return null
        }
        up.soTimeout = 0
        val local = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        val port = local.localPort
        ports.add(port)
        Thread({
            val down = runCatching { local.soTimeout = 15000; local.accept() }.getOrNull()
            runCatching { local.close() }
            if (down == null) { ports.remove(port); runCatching { up.close() }; return@Thread }
            down.tcpNoDelay = true
            val close = { runCatching { up.close() }; runCatching { down.close() }; ports.remove(port) }
            Thread({ runCatching { down.getInputStream().copyTo(up.getOutputStream(), 16384) }; close() }, "td-relay-up").apply { isDaemon = true }.start()
            runCatching { up.getInputStream().copyTo(down.getOutputStream(), 16384) }
            close()
        }, "td-relay-down").apply { isDaemon = true }.start()
        return port
    }
}
