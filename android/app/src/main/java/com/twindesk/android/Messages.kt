// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Messages on the computer (Hub.kt): the phone's conversations (SMS and MMS) read from Android's
// message store, new ones as they come (sms.new), and texts sent from the computer through this
// phone (sms.send). Made only while Messages is on: the store's observer and the "sent" receiver
// are registered then and gone with it. Needs TwinDesk with notifications (the SMS permissions).
package com.twindesk.android

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.telephony.SmsManager
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class Messages(private val hub: Hub, private val core: Core) {
    private val ctx = core.ctx
    private val cr = ctx.contentResolver
    private val main = Handler(Looper.getMainLooper())
    private var observer: ContentObserver? = null
    private var receiver: BroadcastReceiver? = null
    @Volatile private var newest = 0L // the newest message's time (ms) already told about
    private var checking = false
    private var req = 0
    private val names = HashMap<String, String>() // address -> contact name ("" when none)

    fun start() {
        if (observer != null || !hub.granted(Manifest.permission.READ_SMS)) return
        val o = object : ContentObserver(main) {
            override fun onChange(selfChange: Boolean) {
                // A burst of changes (a message arriving touches several tables): one look, a moment later.
                if (checking) return
                checking = true
                main.postDelayed({ checking = false; hub.run { check() } }, 600)
            }
        }
        observer = o
        hub.run { newest = maxOf(latest("content://sms", 1), latest("content://mms", 1000)).takeIf { it > 0 } ?: System.currentTimeMillis() }
        cr.registerContentObserver(Uri.parse("content://mms-sms/"), true, o)
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                if (!i.getBooleanExtra("last", false) && resultCode == Activity.RESULT_OK) return
                val error = when (resultCode) {
                    Activity.RESULT_OK -> null
                    SmsManager.RESULT_ERROR_NO_SERVICE -> "No service"
                    SmsManager.RESULT_ERROR_RADIO_OFF -> "Airplane mode is on"
                    else -> "Not sent"
                }
                core.send(msg(Proto.T.SMS_SENT, "ref" to i.getStringExtra("ref"), "ok" to (error == null), "error" to error))
            }
        }
        receiver = r
        ContextCompat.registerReceiver(ctx, r, IntentFilter(SENT), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    fun stop() {
        observer?.let { runCatching { cr.unregisterContentObserver(it) } }
        receiver?.let { runCatching { ctx.unregisterReceiver(it) } }
        observer = null
        receiver = null
        main.removeCallbacksAndMessages(null)
        synchronized(names) { names.clear() }
    }

    private fun latest(uri: String, scale: Long): Long = runCatching {
        cr.query(Uri.parse(uri), arrayOf("date"), null, null, "date DESC")?.use { c -> if (c.moveToFirst()) c.getLong(0) * scale else 0L } ?: 0L
    }.getOrDefault(0L)

    // Something changed in the store: messages newer than the last one told about go to the computer.
    private fun check() {
        if (observer == null) return
        val found = ArrayList<JSONObject>()
        cr.query(Uri.parse("content://sms"), SMS_COLS, "date > ? AND type != 3", arrayOf(newest.toString()), "date ASC")?.use { c ->
            while (c.moveToNext() && found.size < 20) found.add(sms(c))
        }
        cr.query(Uri.parse("content://mms"), MMS_COLS, "date > ? AND msg_box != 3", arrayOf((newest / 1000).toString()), "date ASC")?.use { c ->
            while (c.moveToNext() && found.size < 40) mms(c)?.let { found.add(it) }
        }
        for (m in found.sortedBy { it.optLong("at") }) {
            if (m.optLong("at") <= newest) continue
            newest = m.optLong("at")
            core.send(msg(Proto.T.SMS_NEW, "thread" to m.remove("thread"), "msg" to m))
        }
    }

    // Conversations, newest first: {id, addrs, name, snippet, at, unread}.
    fun threads(n: Int): JSONArray {
        val want = n.coerceIn(1, 300)
        val out = runCatching { conversations(want) }.getOrNull() ?: scan(want)
        return jsonArray(out)
    }

    // Android's conversation list (most phones).
    private fun conversations(n: Int): List<JSONObject>? {
        val addrs = HashMap<String, String>()
        cr.query(Uri.parse("content://mms-sms/canonical-addresses"), arrayOf("_id", "address"), null, null, null)?.use { c ->
            while (c.moveToNext()) addrs[c.getString(0)] = c.getString(1) ?: ""
        }
        val out = ArrayList<JSONObject>()
        cr.query(Uri.parse("content://mms-sms/conversations?simple=true"), arrayOf("_id", "date", "recipient_ids", "snippet", "read"), null, null, "date DESC")?.use { c ->
            while (c.moveToNext() && out.size < n) {
                val list = (c.getString(2) ?: "").split(' ').mapNotNull { addrs[it]?.takeIf { a -> a.isNotBlank() } }
                if (list.isEmpty()) continue
                out.add(thread(c.getLong(0), list, c.getString(3) ?: "", c.getLong(1), c.getInt(4) == 0))
            }
        } ?: return null
        return out
    }

    // Where that list isn't offered (some Samsung phones): the newest message of each thread.
    private fun scan(n: Int): List<JSONObject> {
        val seen = LinkedHashMap<Long, JSONObject>()
        cr.query(Uri.parse("content://sms"), arrayOf("thread_id", "address", "body", "date", "read"), "type != 3", null, "date DESC")?.use { c ->
            var rows = 0
            while (c.moveToNext() && seen.size < n && rows++ < 5000) {
                val id = c.getLong(0)
                if (id in seen) { if (c.getInt(4) == 0) seen[id]?.put("unread", true); continue }
                seen[id] = thread(id, listOf(c.getString(1) ?: ""), c.getString(2) ?: "", c.getLong(3), c.getInt(4) == 0)
            }
        }
        cr.query(Uri.parse("content://mms"), arrayOf("thread_id", "_id", "date", "read"), "msg_box != 3", null, "date DESC")?.use { c ->
            var rows = 0
            while (c.moveToNext() && rows++ < 500) {
                val id = c.getLong(0)
                val at = c.getLong(2) * 1000
                val t = seen[id]
                if (t != null && t.optLong("at") >= at) continue
                val m = mmsDetail(c.getLong(1), false)
                seen[id] = thread(id, m.addrs.ifEmpty { listOf("") }, m.text.ifEmpty { if (m.images > 0) "Picture" else "" }, at, c.getInt(3) == 0)
            }
        }
        return seen.values.sortedByDescending { it.optLong("at") }.take(n)
    }

    private fun thread(id: Long, addrs: List<String>, snippet: String, at: Long, unread: Boolean) = JSONObject()
        .put("id", id.toString()).put("addrs", jsonArray(addrs)).put("name", addrs.map { name(it).ifEmpty { it } }.joinToString(", "))
        .put("snippet", snippet.take(160)).put("at", at).put("unread", unread)

    // One conversation's messages, newest first, older than `before`: {id, before, items, more}.
    fun thread(m: JSONObject): JSONObject {
        val id = m.str("id", 20).toLongOrNull() ?: return msg(Proto.T.SMS_THREAD, "id" to m.str("id", 20), "items" to JSONArray(), "more" to false)
        val before = m.optLong("before", 0L).let { if (it <= 0) Long.MAX_VALUE else it }
        val n = m.optInt("n", 50).coerceIn(1, 200)
        val items = ArrayList<JSONObject>()
        cr.query(Uri.parse("content://sms"), SMS_COLS, "thread_id = ? AND date < ? AND type != 3", arrayOf(id.toString(), before.toString()), "date DESC")?.use { c ->
            while (c.moveToNext() && items.size <= n) items.add(sms(c))
        }
        var mms = 0
        cr.query(Uri.parse("content://mms"), MMS_COLS, "thread_id = ? AND date < ? AND msg_box != 3", arrayOf(id.toString(), (before / 1000).toString()), "date DESC")?.use { c ->
            while (c.moveToNext() && mms++ <= n) mms(c)?.let { if (it.optLong("at") < before) items.add(it) }
        }
        val sorted = items.sortedByDescending { it.optLong("at") }
        for (x in sorted) x.remove("thread")
        return msg(Proto.T.SMS_THREAD, "id" to id.toString(), "before" to m.optLong("before", 0L), "items" to jsonArray(sorted.take(n)), "more" to (sorted.size > n))
    }

    private fun sms(c: android.database.Cursor): JSONObject {
        val type = c.getInt(4)
        val addr = c.getString(1) ?: ""
        return JSONObject().put("id", "s" + c.getLong(0)).put("thread", c.getLong(5).toString()).put("body", (c.getString(2) ?: "").take(5000))
            .put("at", c.getLong(3)).put("out", type != 1).put("from", if (type == 1) addr else "").put("fromName", if (type == 1) name(addr) else "")
            .put("status", when (type) { 4, 6 -> "sending"; 5 -> "failed"; else -> "" })
    }

    private fun mms(c: android.database.Cursor): JSONObject? {
        val id = c.getLong(0)
        val box = c.getInt(2)
        val d = mmsDetail(id, box == 1)
        val parts = JSONArray()
        d.parts.forEach { (pid, type) -> parts.put(JSONObject().put("id", "p$pid").put("type", type)) }
        return JSONObject().put("id", "m$id").put("thread", c.getLong(3).toString()).put("body", d.text.take(5000)).put("at", c.getLong(1) * 1000)
            .put("out", box != 1).put("from", d.from).put("fromName", if (d.from.isNotEmpty()) name(d.from) else "")
            .put("status", when (box) { 4 -> "sending"; 5 -> "failed"; else -> "" }).put("parts", parts)
    }

    private class Mms(val text: String, val parts: List<Pair<Long, String>>, val from: String, val addrs: List<String>) {
        val images get() = parts.size
    }

    // An MMS's text, pictures and who sent it (incoming) or the people in it.
    private fun mmsDetail(id: Long, incoming: Boolean): Mms {
        val text = StringBuilder()
        val parts = ArrayList<Pair<Long, String>>()
        cr.query(Uri.parse("content://mms/part"), arrayOf("_id", "ct", "text"), "mid = ?", arrayOf(id.toString()), null)?.use { c ->
            while (c.moveToNext()) {
                val ct = c.getString(1) ?: ""
                when {
                    ct == "text/plain" -> c.getString(2)?.let { if (text.isNotEmpty()) text.append('\n'); text.append(it) }
                    ct.startsWith("image/") -> parts.add(c.getLong(0) to ct)
                }
            }
        }
        var from = ""
        val addrs = ArrayList<String>()
        cr.query(Uri.parse("content://mms/$id/addr"), arrayOf("address", "type"), null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val a = c.getString(0) ?: continue
                if (a == "insert-address-token") continue
                if (c.getInt(1) == 137) from = a else addrs.add(a) // 137: from; 151: to
            }
        }
        if (!incoming) from = ""
        return Mms(text.toString(), parts, from, (listOf(from) + addrs).filter { it.isNotEmpty() }.distinct())
    }

    // An MMS picture, at most 1024 px, as a data: URL.
    fun part(id: String): String? {
        val pid = id.removePrefix("p").toLongOrNull() ?: return null
        val uri = Uri.parse("content://mms/part/$pid")
        return runCatching {
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            cr.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it, null, o) }
            var sample = 1
            while (maxOf(o.outWidth, o.outHeight) / sample > 1024) sample *= 2
            val b = cr.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }!!
            val out = ByteArrayOutputStream()
            b.compress(Bitmap.CompressFormat.JPEG, 82, out)
            "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }.getOrNull()
    }

    // A text from the computer, sent by this phone (Android adds it to the conversation).
    fun send(m: JSONObject) {
        val ref = m.str("ref", 60)
        val to = m.str("to", 60).filter { it.isDigit() || it in "+*#" }.ifEmpty { m.str("to", 60).trim() }
        val body = m.str("body", 5000)
        val fail = { why: String -> core.send(msg(Proto.T.SMS_SENT, "ref" to ref, "ok" to false, "error" to why)); Unit }
        if (!hub.granted(Manifest.permission.SEND_SMS)) return fail("Allow sending messages on the phone")
        if (to.isEmpty() || body.isBlank()) return fail("Nothing to send")
        runCatching {
            @Suppress("DEPRECATION")
            val sm = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java) else SmsManager.getDefault()
            val parts = sm.divideMessage(body)
            val sent = ArrayList(parts.indices.map { i ->
                PendingIntent.getBroadcast(
                    ctx, 7000 + (req++ % 1000), Intent(SENT).setPackage(ctx.packageName).putExtra("ref", ref).putExtra("last", i == parts.size - 1),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT,
                )
            })
            sm.sendMultipartTextMessage(to, null, parts, sent, null)
        }.onFailure { fail(it.message ?: "Not sent") }
    }

    // An address's contact name ("" when none), remembered while Messages is on.
    private fun name(addr: String): String {
        if (addr.isEmpty() || !hub.granted(Manifest.permission.READ_CONTACTS)) return ""
        synchronized(names) { names[addr]?.let { return it } }
        val n = runCatching {
            cr.query(Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(addr)), arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)
                ?.use { c -> if (c.moveToFirst()) c.getString(0) ?: "" else "" } ?: ""
        }.getOrDefault("")
        synchronized(names) { if (names.size > 2000) names.clear(); names[addr] = n }
        return n
    }

    companion object {
        private const val SENT = "com.twindesk.android.SMS_SENT"
        private val SMS_COLS = arrayOf("_id", "address", "body", "date", "type", "thread_id")
        private val MMS_COLS = arrayOf("_id", "date", "msg_box", "thread_id")
    }
}
