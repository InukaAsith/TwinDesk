// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The layout rules (Layout.kt) against the same cases as shared/test/layout.js: normalize, canonical,
// newer and merge. The JSON is org.json (testImplementation in build.gradle.kts).
package com.twindesk.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LayoutRulesTest {
    private fun parse(json: String): JSONObject = JSONObject(json)

    private fun keys(o: JSONObject): Set<String> {
        val out = HashSet<String>()
        val iter = o.keys()
        while (iter.hasNext()) out.add(iter.next())
        return out
    }

    @Test
    fun normalizeDropsBadCellsDuplicatesAndExtraFields() {
        // Ported from shared/test/layout.js: two devices on one cell (the smaller id keeps it), bad
        // coordinates dropped, unknown fields dropped.
        val n = LayoutRules.normalize(
            parse(
                """{"rev":3,"by":"a","extra":1,"cells":{"a":{"x":0,"y":0},"b":{"x":0,"y":0},"c":{"x":1.5,"y":0},"d":{"x":1000,"y":0},"f":"x","g":{"x":-2,"y":4}}}""",
            ),
        )
        assertEquals(setOf("a", "g"), keys(n.getJSONObject("cells")))
        assertEquals(3L, n.getLong("rev"))
        assertEquals("a", n.getString("by"))
        assertFalse(n.has("extra"))
        assertEquals(0L, LayoutRules.normalize(null).getLong("rev"))
        assertEquals(0, LayoutRules.normalize(null).getJSONObject("cells").length())
    }

    @Test
    fun normalizeLimitsRevCellsAndIds() {
        assertEquals(0L, LayoutRules.normalize(parse("""{"rev":-1,"cells":{}}""")).getLong("rev"))
        assertEquals(0L, LayoutRules.normalize(parse("""{"rev":"x","cells":{}}""")).getLong("rev"))
        assertEquals("2^40 is out of range", 0L, LayoutRules.normalize(parse("""{"rev":1099511627776,"cells":{}}""")).getLong("rev"))
        // Ported: at most ten cells
        val many = JSONObject()
        for (i in 0 until 30) many.put("d%02d".format(i), JSONObject().put("x", i).put("y", 0))
        val capped = LayoutRules.normalize(JSONObject().put("rev", 1).put("cells", many))
        assertEquals(10, capped.getJSONObject("cells").length())
        // Huge input: a 65-character id is dropped, `by` is cut to 64 characters
        val tooLong = JSONObject().put("x", 0).put("y", 0)
        val big = LayoutRules.normalize(
            JSONObject().put("by", "b".repeat(100)).put(
                "cells",
                JSONObject().put("x".repeat(65), tooLong).put("ok", JSONObject().put("x", 1).put("y", 1)),
            ),
        )
        assertEquals(64, big.getString("by").length)
        assertEquals(setOf("ok"), keys(big.getJSONObject("cells")))
    }

    @Test
    fun canonicalIsSortedAndStable() {
        val a = parse("""{"rev":2,"by":"mac","cells":{"win":{"x":1,"y":0},"and":{"x":0,"y":0}}}""")
        val b = parse("""{"cells":{"and":{"x":0,"y":0},"win":{"x":1,"y":0}},"by":"mac","rev":2}""")
        assertEquals("2|mac|and:0,0;win:1,0", LayoutRules.canonical(a))
        assertEquals(LayoutRules.canonical(a), LayoutRules.canonical(b))
        assertEquals(LayoutRules.canonical(a), LayoutRules.canonical(LayoutRules.normalize(a)))
        assertEquals("0||", LayoutRules.canonical(null))
    }

    @Test
    fun newerByRevThenByThenCanonicalString() {
        val r1 = parse("""{"rev":1,"by":"z","cells":{"a":{"x":0,"y":0}}}""")
        val r2 = parse("""{"rev":2,"by":"a","cells":{"a":{"x":0,"y":0}}}""")
        assertTrue("the higher rev wins, whatever its author", LayoutRules.newer(r2, r1))
        assertFalse(LayoutRules.newer(r1, r2))

        val byA = parse("""{"rev":5,"by":"a","cells":{}}""")
        val byB = parse("""{"rev":5,"by":"b","cells":{}}""")
        assertTrue(LayoutRules.newer(byB, byA))
        assertFalse(LayoutRules.newer(byA, byB))

        // Ported: same rev, same author, different cells: exactly one of the two is newer
        val p = parse("""{"rev":5,"by":"a","cells":{"a":{"x":0,"y":0},"b":{"x":1,"y":0}}}""")
        val q = parse("""{"rev":5,"by":"a","cells":{"a":{"x":0,"y":0},"b":{"x":0,"y":1}}}""")
        assertTrue(LayoutRules.newer(p, q) != LayoutRules.newer(q, p))
        assertFalse(LayoutRules.newer(p, p))
    }

    @Test
    fun mergeIsSymmetricAndConcurrentEditsAtOneRevPickTheSameWinner() {
        // Ported: concurrent edits at the same rev, one wins on every device, the larger author.
        val x = parse("""{"rev":1,"by":"a","cells":{"a":{"x":0,"y":1},"b":{"x":0,"y":0}}}""")
        val y = parse("""{"rev":1,"by":"b","cells":{"a":{"x":0,"y":0},"b":{"x":0,"y":1}}}""")
        assertEquals(LayoutRules.canonical(LayoutRules.merge(x, y)), LayoutRules.canonical(LayoutRules.merge(y, x)))
        assertEquals("b", LayoutRules.merge(x, y).getString("by"))

        // Ported: same rev, same author, different cells: still the same winner on both sides
        val p = parse("""{"rev":5,"by":"a","cells":{"a":{"x":0,"y":0},"b":{"x":1,"y":0}}}""")
        val q = parse("""{"rev":5,"by":"a","cells":{"a":{"x":0,"y":0},"b":{"x":0,"y":1}}}""")
        assertEquals(LayoutRules.canonical(LayoutRules.merge(p, q)), LayoutRules.canonical(LayoutRules.merge(q, p)))
    }
}
