// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The shared layout of the mesh (docs/mesh.md, "Shared layout"): where every device sits relative to the
// others. The phone keeps the newest layout it hears of, relays it and sends it to a computer that
// connects. It never makes one and does not use it for edges. The rules are a Kotlin mirror of
// shared/layout.js (normalize, canonical, newer, merge); keep the two in step.
package com.twindesk.android

import org.json.JSONObject
import kotlin.math.abs

object LayoutRules {
    private const val LIMIT = 64L // |x| and |y| stay within this (untrusted input)
    private const val MAX_CELLS = 10 // P.MAX_DEVICES plus this device
    private const val MAX_ID = 64
    private const val MAX_BY = 64
    private const val MAX_REV = 1L shl 40 // 2^40

    // An integer from a parsed JSON value (org.json gives Int, Long or Double), else null.
    private fun whole(v: Any?): Long? = when (v) {
        is Int -> v.toLong()
        is Long -> v
        is Double -> if (v.isFinite() && v == Math.floor(v) && abs(v) < 2e15) v.toLong() else null
        else -> null
    }

    private fun keysOf(o: JSONObject): List<String> {
        val out = ArrayList<String>()
        val iter = o.keys()
        while (iter.hasNext()) out.add(iter.next())
        return out
    }

    // An untrusted value (from a message or settings) made into a valid layout: unknown fields, bad
    // coordinates and two devices on one cell are dropped (the smaller id keeps the cell). Always returns
    // a new object with the fields rev, by and cells.
    fun normalize(value: JSONObject?): JSONObject {
        var rev = 0L
        var by = ""
        val cells = JSONObject()
        if (value != null) {
            val r = whole(value.opt("rev"))
            if (r != null && r >= 0 && r < MAX_REV) rev = r
            val b = value.opt("by")
            if (b is String) by = b.take(MAX_BY)
            val src = value.optJSONObject("cells")
            if (src != null) {
                val ids = keysOf(src).sorted()
                val taken = HashSet<String>()
                var count = 0
                for (id in ids) {
                    val c = src.optJSONObject(id) ?: continue
                    val x = whole(c.opt("x")) ?: continue
                    val y = whole(c.opt("y")) ?: continue
                    if (id.isEmpty() || id.length > MAX_ID) continue
                    if (abs(x) > LIMIT || abs(y) > LIMIT) continue
                    val key = "$x,$y"
                    if (key in taken || count >= MAX_CELLS) continue
                    taken.add(key)
                    count++
                    cells.put(id, JSONObject().put("x", x.toInt()).put("y", y.toInt()))
                }
            }
        }
        return JSONObject().put("rev", rev).put("by", by).put("cells", cells)
    }

    // A stable string of a layout: equal layouts give equal strings. Same format as shared/layout.js:
    // rev|by|id:x,y;... with the ids sorted.
    fun canonical(layout: JSONObject?): String {
        val l = normalize(layout)
        val cells = l.getJSONObject("cells")
        val parts = keysOf(cells).sorted().map { id ->
            val c = cells.getJSONObject(id)
            "$id:${c.getInt("x")},${c.getInt("y")}"
        }
        return "${l.getLong("rev")}|${l.getString("by")}|${parts.joinToString(";")}"
    }

    // True when a is newer than b: the higher rev wins; at the same rev the larger `by`, then the larger
    // canonical string, so every device picks the same one.
    fun newer(a: JSONObject?, b: JSONObject?): Boolean {
        val x = normalize(a)
        val y = normalize(b)
        val rx = x.getLong("rev")
        val ry = y.getLong("rev")
        if (rx != ry) return rx > ry
        val bx = x.getString("by")
        val by = y.getString("by")
        if (bx != by) return bx > by
        return canonical(x) > canonical(y)
    }

    // The layout two devices agree on: the newer one.
    fun merge(a: JSONObject?, b: JSONObject?): JSONObject = if (newer(b, a)) normalize(b) else normalize(a)
}

// The shared layout as a pooled item, like the clipboard (its own Pool; docs/mesh.md, "Shared layout"). A
// layout from any computer is applied once when it is newer than the stored one, and the Pool relays it.
// A computer that connects gets the stored layout, so a late joiner converges. The phone never makes one.
class LayoutFeature(core: Core) : Feature(core) {
    private val pool = Pool(core.store.deviceId, { core.poolPeers { true } })

    // A layout is kept only when it is usable: rev >= 1 and at least one cell.
    private fun usable(l: JSONObject): Boolean = l.optLong("rev") >= 1 && (l.optJSONObject("cells")?.length() ?: 0) > 0

    private fun stored(): JSONObject? = core.store.getLayout()?.let { LayoutRules.normalize(it) }?.takeIf { usable(it) }

    override fun onPeerWelcome(host: Host) {
        val l = stored() ?: return
        pool.publish(mapOf("t" to Proto.T.LAYOUT, "layout" to l))
    }

    override fun onMessage(t: String, m: JSONObject, host: Host): Boolean {
        if (t != Proto.T.LAYOUT) return false
        val r = pool.receive(host.id, m.toPoolMsg())
        if (r.fresh) {
            val incoming = LayoutRules.normalize(m.optJSONObject("layout"))
            val current = core.store.getLayout()?.let { LayoutRules.normalize(it) } ?: LayoutRules.normalize(null)
            if (usable(incoming) && LayoutRules.newer(incoming, current)) {
                core.store.setLayout(incoming)
                core.changed()
            }
        }
        return true
    }
}
