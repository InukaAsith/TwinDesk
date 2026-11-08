// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files v2 (docs/protocol.md "fx2", the computers' shared/fx2-engine.js): the computer's files
// engine has a server of its own (welcome {fx2: {port}}, fxPlain.fx2Port when unencrypted). A file up
// to 8 MB goes as one range, a bigger one as 4 ranges at once, each a request of its own:
//   PUT|GET /twindesk/fx2/<id>?i=&off=&len=&total=, the fx token in x-twindesk-fx.
// Each side hashes each range (SHA-256) while it streams; file.end carries the sender's ({fx2: [hex]},
// sha256 = SHA-256 of the hashes joined by ','). Files.kt sends and receives with it; anything wrong
// before a byte went: that file, and the rest of the session's, go the fx way.
package com.twindesk.android

import android.net.Uri
import org.json.JSONArray
import java.security.MessageDigest

object Fx2 {
    private const val ONE_RANGE_MAX = 8L * 1024 * 1024
    private const val RANGES = 4
    private const val ALIGN = 1024L * 1024

    data class Range(val i: Int, val off: Long, val len: Long)

    // The same plan as the engine's: the computer refuses a range that isn't one of it.
    fun plan(size: Long): List<Range> {
        if (size <= ONE_RANGE_MAX) return listOf(Range(0, 0, size))
        val step = ((size + RANGES * ALIGN - 1) / (RANGES * ALIGN)) * ALIGN
        val out = mutableListOf<Range>()
        var off = 0L
        var i = 0
        while (off < size) {
            out.add(Range(i++, off, minOf(step, size - off)))
            off += step
        }
        return out
    }

    fun path(id: String, r: Range, total: Long) = "${Proto.FX2_PATH}${Uri.encode(id)}?i=${r.i}&off=${r.off}&len=${r.len}&total=$total"

    // file.end's sha256 for a file that went this way.
    fun joined(hashes: List<String>): String =
        MessageDigest.getInstance("SHA-256").digest(hashes.joinToString(",").toByteArray(Charsets.US_ASCII)).hex()

    // file.end {fx2} is the sender's hashes, in range order, and they're ours.
    fun same(theirs: JSONArray?, ours: List<String>): Boolean {
        if (theirs == null || theirs.length() != ours.size) return false
        for (i in ours.indices) if (theirs.optString(i).lowercase() != ours[i]) return false
        return true
    }
}
