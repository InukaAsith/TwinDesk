// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Joining everyone, the guest side (shared/intro.js, docs/mesh.md "Joining everyone"): a computer that is
// connected to this phone and to another computer introduces them with mesh.intro.grant. The phone is
// always a guest: it dials computers and cannot listen, so it never answers mesh.intro.ask.
// PURE Kotlin like Mesh.kt (the JSON is converted in MeshWire.kt), so the JVM tests run it as it is.
package com.twindesk.android

object Intro {
    const val ASK = "mesh.intro.ask"
    const val REPLY = "mesh.intro.reply"
    const val GRANT = "mesh.intro.grant"

    private val HEX = Regex("^[0-9a-f]+$")

    // A phone cannot listen (shared/intro.js canHost).
    fun canHost(os: String?): Boolean = os == "win" || os == "mac" || os == "linux"

    private fun str(v: Any?, n: Int): Boolean = v is String && v.isNotEmpty() && v.length <= n

    // Port 1..65535 as an integer (JSON numbers arrive as Int, Long or Double).
    private fun port(v: Any?): Int? {
        val n = v as? Number ?: return null
        val d = n.toDouble()
        if (d != Math.floor(d) || d <= 0.0 || d >= 65536.0) return null
        return d.toInt()
    }

    // The fingerprint as stored by a pairing: lower case, no colons.
    fun normFp(v: Any?): String = (v as? String ?: "").replace(":", "").lowercase()

    // shared/intro.js validGrant: a reply with ok:false is valid (it carries no credential).
    fun validGrant(m: Map<String, Any?>?): Boolean {
        if (m == null) return false
        val t = m["t"]
        if ((t != GRANT && t != REPLY) || !str(m["req"], 64)) return false
        if (t == REPLY && m["ok"] == false) return true
        val fp = normFp(m["fp"])
        val addrs = m["addrs"] as? List<*> ?: return false
        return str(m["macId"], 128) && fp.length == 64 && HEX.matches(fp) &&
            str(m["token"], 128) && HEX.matches(m["token"] as String) &&
            port(m["port"]) != null &&
            addrs.isNotEmpty() && addrs.size <= 8 && addrs.all { str(it, 64) }
    }

    // shared/intro.js validAsk.
    fun validAsk(m: Map<String, Any?>?): Boolean {
        if (m == null || m["t"] != ASK || !str(m["req"], 64) || !str(m["for"], 128)) return false
        val name = m["name"]
        return name == null || name is String
    }

    // What a grant stores: the same fields a finished pairing stores as a Host (Link.onPairOk).
    data class Granted(val id: String, val name: String, val os: String, val address: String, val port: Int, val fp: String, val token: String)

    // A valid mesh.intro.grant as the host to store, else null (not a grant, or invalid).
    fun granted(m: Map<String, Any?>?): Granted? {
        if (m == null || m["t"] != GRANT || !validGrant(m)) return null
        val id = m["macId"] as String
        val name = (m["macName"] as? String ?: "").take(64).ifEmpty { "Computer" }
        val os = (m["os"] as? String ?: "").take(16).ifEmpty { "mac" }
        val addr = (m["addrs"] as List<*>).first() as String
        return Granted(id, name, os, addr, port(m["port"])!!, normFp(m["fp"]), m["token"] as String)
    }
}
