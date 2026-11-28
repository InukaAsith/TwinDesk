// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drop (shared/drop.js): one conversation with every TwinDesk device. This phone keeps what it may see (to
// everyone, to it, from it) in its own folder, and the computer it's connected to passes the rest on to
// the mesh. Written while away, a message waits here and goes when a computer connects: each side says
// which ids it has (drop.hi) and the other sends what's missing (drop.msgs).
//   drop.hi {ids, gone, since?} ↔ ; drop.msgs {items} ↔ ; drop.msg {item} ↔ ; drop.del {id, from, at, to} ↔
//   drop.who {} → ; drop.who {members} ← : who the To picker offers (the computer first)
// item: {id, from, name, os, at, to: "*" | id, text?, file?: {name, size, mime, data (base64)}}
package com.twindesk.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

class Drop(core: Core) : Feature(core) {
    companion object {
        const val HI = "drop.hi"
        const val MSGS = "drop.msgs"
        const val MSG = "drop.msg"
        const val DEL = "drop.del"
        const val WHO = "drop.who"
        const val MAX_FILE = 5 * 1024 * 1024
        const val MAX_TEXT = 8000
        private const val KEEP = 300
        private const val KEEP_BYTES = 100L * 1024 * 1024
        private const val HI_IDS = 300
        private const val BATCH = 6 * 1024 * 1024
        private const val CH = "drop"
        private const val NOTE_ID = 20
        private val ID = Regex("^[A-Za-z0-9_.:-]{1,64}$")
        private val ITEM_ID = Regex("^[A-Za-z0-9_-]{8,64}$")
    }

    class FileInfo(val name: String, val size: Long, val mime: String) {
        val image get() = mime.matches(Regex("^image/(png|jpe?g|gif|webp|bmp|heic)$"))
    }
    class Item(val id: String, val from: String, val name: String, val os: String, val at: Long, val to: String,
               var text: String, var file: FileInfo?, var gone: Boolean, var hid: Boolean, val k: Long)
    class Member(val id: String, val name: String, val os: String, val online: Boolean)

    private val root = File(core.ctx.filesDir, "drop")
    private val roomFile = File(root, "room.json")
    private val items = ArrayList<Item>()
    private val byId = HashMap<String, Item>()
    private var k = 0L
    private var readK = 0L
    private var loaded = false
    private var onFlag = false // off on a new install
    private val blocked = LinkedHashMap<String, String>()
    @Volatile var members: List<Member> = emptyList(); private set
    @Volatile var note: String = ""; private set
    private val thumbs = HashMap<String, Bitmap?>()
    private val me get() = core.store.deviceId

    // ---- the room on disk ----

    @Synchronized private fun load() {
        if (loaded) return
        loaded = true
        runCatching {
            val j = JSONObject(roomFile.readText())
            k = j.optLong("k"); readK = j.optLong("read"); onFlag = j.optBoolean("on", false)
            j.optJSONObject("blocked")?.let { b -> b.keys().forEach { blocked[it] = b.optString(it) } }
            val a = j.optJSONArray("items") ?: JSONArray()
            for (i in 0 until a.length()) {
                val x = a.optJSONObject(i) ?: continue
                val f = x.optJSONObject("file")
                val it = Item(x.str("id", 64), x.str("from", 64), x.str("name", 64), x.str("os", 10), x.optLong("at"), x.str("to", 64).ifEmpty { "*" },
                    x.str("text", MAX_TEXT), f?.let { FileInfo(it.str("name", 200), it.optLong("size"), it.str("mime", 100)) },
                    x.optBoolean("gone"), x.optBoolean("hid"), x.optLong("k"))
                if (ITEM_ID.matches(it.id) && !byId.containsKey(it.id)) { items.add(it); byId[it.id] = it }
            }
            items.sortWith(compareBy<Item>({ it.at }, { it.id }))
        }
    }

    private var saving = false
    @Synchronized private fun save() {
        if (saving) return
        saving = true
        core.bg.schedule({ flush() }, 300, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    @Synchronized private fun flush() {
        saving = false
        val a = JSONArray()
        for (x in items) a.put(JSONObject().put("id", x.id).put("from", x.from).put("name", x.name).put("os", x.os).put("at", x.at).put("to", x.to).put("k", x.k).apply {
            if (x.text.isNotEmpty()) put("text", x.text)
            x.file?.let { put("file", JSONObject().put("name", it.name).put("size", it.size).put("mime", it.mime)) }
            if (x.gone) put("gone", true)
            if (x.hid) put("hid", true)
        })
        val b = JSONObject(); blocked.forEach { (id, n) -> b.put(id, n) }
        runCatching {
            root.mkdirs()
            val tmp = File(root, "room.json.tmp")
            tmp.writeText(JSONObject().put("v", 1).put("k", k).put("read", readK).put("on", onFlag).put("blocked", b).put("items", a).toString())
            tmp.renameTo(roomFile)
        }
    }

    fun fileOf(x: Item): File? = x.file?.let { File(File(File(root, "files"), x.id), it.name) }
    private fun dropFile(x: Item) { File(File(root, "files"), x.id).deleteRecursively(); synchronized(thumbs) { thumbs.remove(x.id) } }

    private fun insert(it: Item) {
        var i = items.size
        while (i > 0 && (items[i - 1].at > it.at || (items[i - 1].at == it.at && items[i - 1].id > it.id))) i--
        items.add(i, it); byId[it.id] = it
        var bytes = items.sumOf { x -> x.file?.size ?: 0L }
        while (items.size > KEEP || (bytes > KEEP_BYTES && items.isNotEmpty())) {
            val x = items.removeAt(0); byId.remove(x.id); bytes -= x.file?.size ?: 0L; dropFile(x)
        }
    }

    // ---- who sees what ----

    private fun mine(to: String, from: String) = to == "*" || to == me || from == me
    private fun shown(x: Item) = !x.hid && !x.gone && mine(x.to, x.from) && !(x.from != me && blocked.containsKey(x.from))

    val on: Boolean get() { load(); return onFlag }

    fun setOn(v: Boolean) {
        synchronized(this) { load(); onFlag = v; save() }
        if (v && core.host != null) hello()
        core.changed()
    }

    fun block(id: String, v: Boolean, name: String) {
        synchronized(this) { load(); if (v) blocked[id] = name.take(64) else blocked.remove(id); save() }
        core.changed()
    }

    fun blockedList(): List<Pair<String, String>> = synchronized(this) { load(); blocked.entries.map { it.key to it.value } }

    fun view(): List<Item> = synchronized(this) { load(); items.filter { shown(it) }.takeLast(300) }

    fun unread(): Int = synchronized(this) { if (!loaded) load(); if (!onFlag) 0 else items.count { it.k > readK && it.from != me && shown(it) } }

    fun read() {
        val changed = synchronized(this) { load(); if (readK != k) { readK = k; save(); true } else false }
        if (changed) { Notify.nm(core.ctx).cancel(NOTE_ID); core.changed() }
    }

    // ---- the link ----

    override fun onWelcome(host: Host) { members = emptyList(); hello() }
    override fun onClosed() { members = emptyList() }

    private fun hello() {
        if (!on) return
        val (ids, gone, since) = synchronized(this) {
            val list = items.takeLast(HI_IDS)
            Triple(list.map { it.id }, list.filter { it.gone }.map { it.id }, if (list.size == HI_IDS) list[0].at else 0L)
        }
        core.send(JSONObject().put("t", HI).put("ids", JSONArray(ids)).put("gone", JSONArray(gone)).apply { if (since > 0) put("since", since) })
        ask()
    }

    // The To picker's devices (the page asks when it opens).
    fun ask() { if (on && core.host != null) core.send(JSONObject().put("t", WHO)) }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t != HI && t != MSGS && t != MSG && t != DEL && t != WHO) return false
        if (!on) return true
        when (t) {
            HI -> core.bg.execute { answer(m) }
            WHO -> {
                val a = m.optJSONArray("members") ?: JSONArray()
                members = (0 until a.length()).mapNotNull { a.optJSONObject(it) }.filter { ID.matches(it.str("id", 64)) && it.str("id", 64) != me }
                    .map { Member(it.str("id", 64), it.str("name", 64), it.str("os", 10), it.optBoolean("online")) }
                core.changed()
            }
            MSGS -> core.bg.execute {
                val a = m.optJSONArray("items") ?: JSONArray()
                var any = false
                for (i in 0 until minOf(a.length(), 150)) a.optJSONObject(i)?.let { any = take(it) || any }
                if (any) core.changed()
            }
            MSG -> core.bg.execute { m.optJSONObject("item")?.let { if (take(it)) core.changed() } }
            DEL -> core.bg.execute { if (take(JSONObject(m.toString()).put("gone", true))) core.changed() }
        }
        return true
    }

    private fun answer(m: JSONObject) {
        val have = HashSet<String>(); m.optJSONArray("ids")?.let { a -> for (i in 0 until minOf(a.length(), HI_IDS * 2)) have.add(a.optString(i)) }
        val buried = HashSet<String>(); m.optJSONArray("gone")?.let { a -> for (i in 0 until minOf(a.length(), HI_IDS)) buried.add(a.optString(i)) }
        val since = m.optLong("since")
        val lack = synchronized(this) { load(); items.filter { !it.hid && (it.id !in have || (it.gone && it.id !in buried)) && it.at >= since }.takeLast(150) }
        var batch = JSONArray(); var size = 0
        for (x in lack) {
            val w = wire(x) ?: continue
            val n = w.optJSONObject("file")?.optString("data")?.length ?: (200 + x.text.length)
            if (batch.length() > 0 && size + n > BATCH) { core.send(JSONObject().put("t", MSGS).put("items", batch)); batch = JSONArray(); size = 0 }
            batch.put(w); size += n
        }
        if (batch.length() > 0) core.send(JSONObject().put("t", MSGS).put("items", batch))
    }

    private fun wire(x: Item): JSONObject? {
        val w = JSONObject().put("id", x.id).put("from", x.from).put("name", x.name).put("os", x.os).put("at", x.at).put("to", x.to)
        if (x.gone) return w.put("gone", true)
        if (x.text.isNotEmpty()) w.put("text", x.text)
        x.file?.let { f ->
            val bytes = runCatching { fileOf(x)!!.readBytes() }.getOrNull() ?: return null
            w.put("file", JSONObject().put("name", f.name).put("size", f.size).put("mime", f.mime).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
        }
        return w
    }

    private fun safeName(n: String) = n.take(200).replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").replace(Regex("^\\.+"), "_").trim().ifEmpty { "file" }

    // An item from the computer: kept the first time, when this phone may see it. True when the room changed.
    private fun take(j: JSONObject): Boolean {
        val id = j.str("id", 64); val from = j.str("from", 64); val at = j.optLong("at")
        val to = j.str("to", 64).ifEmpty { "*" }
        if (!ITEM_ID.matches(id) || !ID.matches(from) || at <= 0 || (to != "*" && !ID.matches(to)) || !mine(to, from)) return false
        val gone = j.optBoolean("gone")
        val fresh: Item
        synchronized(this) {
            load()
            val old = byId[id]
            if (old != null) {
                if (!gone || old.gone || old.from != from) return false
                dropFile(old); old.text = ""; old.file = null; old.gone = true
                save()
                return true
            }
            if (from == me && !gone) return false // ours, gone from here: not back
            var info: FileInfo? = null
            var data: ByteArray? = null
            j.optJSONObject("file")?.let { f ->
                val size = f.optLong("size", -1)
                if (size < 0 || size > MAX_FILE) return false
                data = runCatching { Base64.decode(f.optString("data"), Base64.DEFAULT) }.getOrNull() ?: return false
                if (data!!.size.toLong() != size) return false
                info = FileInfo(safeName(f.str("name", 200)), size, f.str("mime", 100))
            }
            val text = j.str("text", MAX_TEXT)
            if (!gone && text.isEmpty() && info == null) return false
            fresh = Item(id, from, j.str("name", 64), j.str("os", 10), at, to, if (gone) "" else text, if (gone) null else info, gone, false, ++k)
            if (info != null && !gone) runCatching { fileOf(fresh)!!.apply { parentFile?.mkdirs() }.writeBytes(data!!) }.onFailure { return false }
            insert(fresh)
            save()
        }
        if (shown(fresh) && fresh.from != me) announce(fresh)
        return true
    }

    // A pop-up for a new message while TwinDesk isn't on screen.
    private fun announce(x: Item) {
        if (MainActivity.shown) return
        val ctx = core.ctx
        val n = Notify.nm(ctx)
        if (n.getNotificationChannel(CH) == null) n.createNotificationChannel(NotificationChannel(CH, tr("Drop"), NotificationManager.IMPORTANCE_HIGH).apply { description = tr("Messages from your other devices") })
        val open = PendingIntent.getActivity(ctx, NOTE_ID, Intent(ctx, MainActivity::class.java).putExtra("tab", "Drop")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val count = unread()
        runCatching {
            n.notify(NOTE_ID, Notification.Builder(ctx, CH).setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(x.name.ifEmpty { tr("Drop") })
                .setContentText(x.text.ifEmpty { x.file?.name ?: "" })
                .setStyle(Notification.BigTextStyle().bigText(x.text.ifEmpty { x.file?.name ?: "" }))
                .apply { if (count > 1) setNumber(count) }
                .setContentIntent(open).setAutoCancel(true).build())
        }
    }

    // ---- this phone ----

    private fun send(it: Item, data: ByteArray?) {
        if (core.host == null) return // it goes with the next drop.hi
        val w = JSONObject().put("id", it.id).put("from", it.from).put("name", it.name).put("os", it.os).put("at", it.at).put("to", it.to)
        if (it.text.isNotEmpty()) w.put("text", it.text)
        it.file?.let { f -> w.put("file", JSONObject().put("name", f.name).put("size", f.size).put("mime", f.mime).put("data", Base64.encodeToString(data, Base64.NO_WRAP))) }
        core.send(JSONObject().put("t", MSG).put("item", w))
    }

    private fun newItem(to: String, text: String, file: FileInfo?): Item =
        Item(UUID.randomUUID().toString(), me, core.store.deviceName.take(64), Proto.OS, System.currentTimeMillis(), if (to == "*" || !ID.matches(to)) "*" else to, text, file, false, false, ++k)

    fun post(to: String, text: String) {
        val t = text.trim().take(MAX_TEXT)
        if (t.isEmpty() || !on) return
        val it = synchronized(this) { load(); newItem(to, t, null).also { insert(it); readK = k; save() } }
        core.changed()
        core.bg.execute { send(it, null) }
    }

    fun postFiles(to: String, uris: List<Uri>) {
        if (!on) return
        core.bg.execute {
            val big = ArrayList<String>()
            for (u in uris.take(20)) {
                val cr = core.ctx.contentResolver
                var name = "file"; var size = -1L
                runCatching { cr.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c -> if (c.moveToFirst()) { name = c.getString(0) ?: name; size = c.getLong(1) } } }
                if (size > MAX_FILE) { big.add(name); continue }
                val bytes = runCatching { cr.openInputStream(u)?.use { it.readBytes() } }.getOrNull() ?: continue
                if (bytes.size > MAX_FILE) { big.add(name); continue }
                val info = FileInfo(safeName(name), bytes.size.toLong(), cr.getType(u) ?: Files.mimeOf(name))
                val it = synchronized(this) {
                    load()
                    newItem(to, "", info).also { x -> fileOf(x)!!.apply { parentFile?.mkdirs() }.writeBytes(bytes); insert(x); readK = k; save() }
                }
                send(it, bytes)
            }
            note = if (big.isEmpty()) "" else tr("Too large for Drop (5 MB at most): {names}. Send it from Files instead.", "names" to big.joinToString(", "))
            core.changed()
        }
    }

    fun del(id: String, everyone: Boolean) {
        val tomb = synchronized(this) {
            load()
            val x = byId[id] ?: return
            if (x.gone) return
            if (everyone && x.from != me) return
            dropFile(x); x.text = ""; x.file = null
            if (everyone) x.gone = true else x.hid = true
            save()
            if (everyone) JSONObject().put("t", DEL).put("id", x.id).put("from", x.from).put("at", x.at).put("to", x.to) else null
        }
        if (tomb != null && core.host != null) core.send(tomb)
        core.changed()
    }

    fun clear() {
        synchronized(this) { load(); for (x in items) if (shown(x)) { dropFile(x); x.text = ""; x.file = null; x.hid = true }; save() }
        core.changed()
    }

    fun note(text: String) { note = text; core.changed() }

    // A picture, made small for the page (decoded once).
    fun thumb(x: Item): Bitmap? {
        synchronized(thumbs) { if (thumbs.containsKey(x.id)) return thumbs[x.id] }
        val f = fileOf(x) ?: return null
        val b = runCatching {
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(f.path, o)
            var s = 1
            while (o.outWidth / s > 900 || o.outHeight / s > 900) s *= 2
            BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = s })
        }.getOrNull()
        synchronized(thumbs) { thumbs[x.id] = b }
        return b
    }

    private fun uriOf(x: Item): Uri? = fileOf(x)?.takeIf { it.exists() }?.let { runCatching { FileProvider.getUriForFile(core.ctx, "${core.ctx.packageName}.files", it) }.getOrNull() }

    fun open(x: Item) {
        val u = uriOf(x) ?: return
        runCatching {
            core.ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_VIEW).setDataAndType(u, x.file!!.mime.ifEmpty { "*/*" })
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), x.file!!.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    fun share(x: Item) {
        val i = Intent(Intent.ACTION_SEND)
        val u = if (x.file != null) uriOf(x) else null
        if (u != null) i.setType(x.file!!.mime.ifEmpty { "*/*" }).putExtra(Intent.EXTRA_STREAM, u).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        else i.setType("text/plain").putExtra(Intent.EXTRA_TEXT, x.text)
        runCatching { core.ctx.startActivity(Intent.createChooser(i, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    // Saved to Download/TwinDesk.
    fun save(x: Item) {
        val f = fileOf(x) ?: return
        val info = x.file ?: return
        core.bg.execute {
            val ok = runCatching {
                val cr = core.ctx.contentResolver
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, info.name)
                    put(MediaStore.Downloads.MIME_TYPE, info.mime.ifEmpty { Files.mimeOf(info.name) })
                    put(MediaStore.Downloads.RELATIVE_PATH, "Download/TwinDesk/")
                }
                val uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("no space")
                cr.openOutputStream(uri)!!.use { out -> f.inputStream().use { it.copyTo(out) } }
            }.isSuccess
            note(if (ok) tr("Saved to Download/TwinDesk") else tr("Couldn’t save {name}", "name" to info.name))
        }
    }
}
