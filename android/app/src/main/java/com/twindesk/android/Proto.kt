// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The wire protocol from the phone's side: the same constants and pairing math as
// shared/protocol.js (keep the two in step).
package com.twindesk.android

import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom

object Proto {
    const val VERSION = 1
    const val PORT = 47800
    const val DISCOVERY_PORT = 47801
    const val BEACON_MS = 2000L
    const val DEVICE_STALE_MS = 10000L
    const val PING_MS = 1000L
    const val TIMEOUT_MS = 4000L
    const val PHONE_GRACE_MS = 30000L
    // Mesh (docs/mesh.md; same values as shared/protocol.js): many computers at once.
    const val MAX_DEVICES = 10
    const val IDLE_PING_MS = 5000L
    const val IDLE_TIMEOUT_MS = 15000L
    const val POOL_SEEN_LIMIT = 200 // (origin, seq) pairs remembered per pool for dedupe
    const val POOL_MAX_HOPS = 9 // one less than MAX_DEVICES: a chain of ten, and duplicates are dropped
    val RECONNECT_MS = longArrayOf(1000L, 2000L, 3000L) // a dropped link redials after these; then the last one
    const val CLIP_MAX_BYTES = 256 * 1024
    const val FILE_CHUNK_BYTES = 64 * 1024
    const val MAX_PAYLOAD = 16 * 1024 * 1024
    const val OS = "android"
    private const val SAS_LABEL = "macshare-sas-v1"

    // Message types (field `t`) the phone uses.
    object T {
        const val BEACON = "beacon"
        const val PROBE = "probe"
        const val INVITE = "invite"
        const val PAIR_START = "pair.start"
        const val PAIR_NONCE = "pair.nonce"
        const val PAIR_REVEAL = "pair.reveal"
        const val PAIR_CONFIRM = "pair.confirm"
        const val PAIR_OK = "pair.ok"
        const val PAIR_CANCEL = "pair.cancel"
        const val HELLO = "hello"
        const val WELCOME = "welcome"
        const val ERROR = "error"
        const val PING = "ping"
        const val PONG = "pong"
        const val CLIP = "clip"
        const val CLIP_POLICY = "clip.policy"
        const val NOTIF = "notif"
        const val NOTIF_POLICY = "notif.policy"
        const val FILE_OFFER = "file.offer"
        const val FILE_ACCEPT = "file.accept"
        const val FILE_REFUSE = "file.refuse"
        const val FILE_CHUNK = "file.chunk"
        const val FILE_END = "file.end"
        const val FILE_DONE = "file.done"
        const val FILE_CANCEL = "file.cancel"
        const val FILES_DONE = "files.done"
        const val DRAG_POLICY = "drag.policy"
        const val FCLIP_OFFER = "fclip.offer"
        const val FCLIP_PASTE = "fclip.paste"
        const val FCLIP_GONE = "fclip.gone"
        const val FCLIP_KEY = "fclip.key"
        const val PAIR_SYNC = "pair.sync"
        const val SMB_OFFER = "smb.offer"
        const val SMB_REVOKE = "smb.revoke"
        const val SMB_STATE = "smb.state"
        const val PHONE_INFO = "phone.info"
        const val PHONE_APPS_LIST = "phone.apps.list"
        const val PHONE_APPS = "phone.apps"
        const val PHONE_POINTER = "phone.pointer"
        const val PHONE_WAKE = "phone.wake"
        const val PHONE_AWAKE = "phone.awake"
        const val ADB_STATE = "adb.state"
        const val ADB_ENABLE = "adb.enable"
        const val ADB_PAIR = "adb.pair"
        const val ADB_BRIDGE = "adb.bridge"
        const val WOL_INFO = "wol.info"
        const val MESH_ROSTER = "mesh.roster" // the computers this phone is connected to (docs/mesh.md)
    }

    object E {
        const val VERSION_MISMATCH = "version_mismatch"
        const val BAD_TOKEN = "bad_token"
        const val PAIR_REFUSED = "pair_refused"
        const val PAIR_TIMEOUT = "pair_timeout"
        const val BUSY = "busy"
        const val REPLACED = "replaced"
        const val RELEASED = "released"
    }

    private val random = SecureRandom()

    fun randomHex(bytes: Int): String {
        val b = ByteArray(bytes)
        random.nextBytes(b)
        return b.hex()
    }

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    // Pairing commit for our nonce: sha256(nonce bytes), hex.
    fun commitOf(nonceHex: String): String = sha256(nonceHex.unhex()).hex()

    // The 6-digit code both sides show:
    // sha256(SAS_LABEL || fp bytes || nw bytes || nm bytes), first 4 bytes as uint32 BE, mod 1e6.
    fun sasCode(fp: String, nwHex: String, nmHex: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(SAS_LABEL.toByteArray(Charsets.UTF_8))
        md.update(normFingerprint(fp).unhex())
        md.update(nwHex.unhex())
        md.update(nmHex.unhex())
        val h = md.digest()
        val n = ByteBuffer.wrap(h, 0, 4).int.toLong() and 0xffffffffL
        return (n % 1000000).toString().padStart(6, '0')
    }

    fun normFingerprint(fp: String?): String = (fp ?: "").replace(":", "").lowercase()
}

fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

fun String.unhex(): ByteArray {
    val s = if (length % 2 == 0) this else "0$this"
    return ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

// Small JSON helpers: msg("t", "k" to v, …)
fun msg(t: String, vararg fields: Pair<String, Any?>): JSONObject {
    val o = JSONObject().put("t", t)
    for ((k, v) in fields) o.put(k, v ?: JSONObject.NULL)
    return o
}

fun JSONObject.str(key: String, max: Int = 500): String = optString(key, "").let { if (isNull(key)) "" else it.take(max) }

fun jsonArray(items: Iterable<Any?>): JSONArray = JSONArray().also { a -> items.forEach { a.put(it) } }
