// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The JSON side of the pool (Mesh.kt is pure and never sees JSON): a pooled message on the wire is its
// fields plus the stamps o (origin), s (sequence), d (the origin's direct links) and h (hops). A message
// without o is an old peer's, and what an old peer gets carries no stamps (docs/mesh.md).
package com.twindesk.android

import org.json.JSONArray
import org.json.JSONObject

private val STAMPS = setOf("o", "s", "d", "h")

fun JSONObject.toPoolMsg(): PoolMsg {
    val body = HashMap<String, Any?>()
    keys().forEach { k -> if (k !in STAMPS) body[k] = opt(k)?.takeIf { it !== JSONObject.NULL } }
    val origin = if (has("o") && !isNull("o")) optString("o") else null
    val d = optJSONArray("d")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
    return PoolMsg(body, o = origin, s = optLong("s", 0L), d = d, h = optInt("h", 0))
}

fun PoolMsg.toJson(): JSONObject {
    val j = JSONObject()
    for ((k, v) in body) j.put(k, v ?: JSONObject.NULL)
    if (o != null) j.put("o", o).put("s", s).put("d", jsonArray(d)).put("h", h)
    return j
}

// A message as plain Kotlin values (Map, List, String, Number, Boolean, null) for the pure validators
// (Intro.kt): JSONObject.NULL becomes null.
fun JSONObject.toPlainMap(): Map<String, Any?> {
    val out = HashMap<String, Any?>()
    keys().forEach { k -> out[k] = plainOf(opt(k)) }
    return out
}

private fun plainOf(v: Any?): Any? = when {
    v == null || v === JSONObject.NULL -> null
    v is JSONObject -> v.toPlainMap()
    v is JSONArray -> (0 until v.length()).map { plainOf(v.opt(it)) }
    else -> v
}

// The `members` of a mesh.roster message (shared/mesh.js Mesh.handle()).
fun JSONObject.rosterMembers(): List<Member> {
    val a = optJSONArray("members") ?: return emptyList()
    return (0 until a.length()).mapNotNull { i ->
        val o = a.optJSONObject(i) ?: return@mapNotNull null
        cleanMember(if (o.isNull("id")) null else o.opt("id"), if (o.isNull("name")) null else o.opt("name"), if (o.isNull("os")) null else o.opt("os"))
    }
}

fun Member.toJson(): JSONObject = JSONObject().put("id", id).put("name", name).put("os", os)
