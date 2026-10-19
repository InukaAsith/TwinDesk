// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The JSON side of the pool (Mesh.kt is pure and never sees JSON): a pooled message on the wire is its
// fields plus the stamps o (origin), s (sequence), d (the origin's direct links) and h (hops). A message
// without o is an old peer's, and what an old peer gets carries no stamps (docs/mesh.md).
package com.twindesk.android

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
