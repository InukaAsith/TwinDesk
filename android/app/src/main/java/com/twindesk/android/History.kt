// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// History: what was copied (both ways) and the computer's notifications shown here, for this
// session — and, with Keep history on (off at first), kept across restarts for a day, a week, 30
// days or a year, encrypted with a key in Android's Keystore (made when it's turned on; no
// permission, no prompt). Read only when a history is first looked at. Each has its own view,
// opened from its page or an Overview shortcut (Tiles.kt: clipHistory, notifHistory); the pages
// keep their Recent lists at the bottom as before. As the computers' History (shared/histkeeper.js).
package com.twindesk.android

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.compose.runtime.mutableStateOf
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class History(private val core: Core) {
    // dir: "in" from the computer, "out" to it (the clipboard); a notification has its app.
    data class Entry(val at: Long, val text: String, val dir: String = "", val app: String = "", val title: String = "", val id: String = "")

    companion object {
        val view = mutableStateOf<String?>(null) // the history open: "clip" or "notifs"
        val DAYS = listOf(1, 7, 30, 365)
        private const val MAX = 1000
        private const val DAY = 86_400_000L
        private const val ALIAS = "twindesk.history"
    }

    private val clipList = ArrayList<Entry>()
    private val notifList = ArrayList<Entry>()
    @Volatile private var loaded = false
    @Volatile var error = ""; private set

    val save: Boolean get() = core.store.flag("history.save", false)
    val days: Int get() = core.store.prefsString("history.days", "7").toIntOrNull()?.takeIf { it in DAYS } ?: 7

    private fun file(what: String) = File(core.ctx.filesDir, "history-$what.enc")

    fun setSave(on: Boolean) {
        core.store.setFlag("history.save", on)
        if (on) {
            runCatching { key() }.onFailure { error = it.message ?: "Keystore"; core.store.setFlag("history.save", false) }
            loaded = true // what's here now is kept from now on
            write()
        } else forget()
        core.changed()
    }

    fun setDays(d: Int) {
        if (d !in DAYS) return
        core.store.setPrefsString("history.days", d.toString())
        prune()
        write()
        core.changed()
    }

    fun clip(): List<Entry> { load(); return synchronized(clipList) { clipList.toList() } }
    fun notifs(): List<Entry> { load(); return synchronized(notifList) { notifList.toList() } }

    fun addClip(dir: String, text: String) {
        if (text.isBlank()) return
        synchronized(clipList) {
            clipList.removeAll { it.text == text && it.dir == dir }
            clipList.add(0, Entry(System.currentTimeMillis(), text.take(20000), dir = dir))
            while (clipList.size > MAX) clipList.removeAt(clipList.lastIndex)
        }
        if (save) { load(); write() }
    }

    fun addNotif(id: String, app: String, title: String, body: String, at: Long) {
        synchronized(notifList) {
            if (id.isNotEmpty()) notifList.removeAll { it.id == id }
            notifList.add(0, Entry(if (at > 0) at else System.currentTimeMillis(), body.take(2000), app = app, title = title, id = id))
            while (notifList.size > MAX) notifList.removeAt(notifList.lastIndex)
        }
        if (save) { load(); write() }
    }

    fun clear(what: String) {
        synchronized(if (what == "clip") clipList else notifList) { (if (what == "clip") clipList else notifList).clear() }
        if (what == "clip") core.clip.history.clear()
        runCatching { file(what).delete() }
        core.changed()
    }

    // The kept ones back, once a session (when a history is first looked at, or one comes while on).
    @Synchronized private fun load() {
        if (loaded) return
        loaded = true
        if (!save) return
        for ((what, list) in listOf("clip" to clipList, "notifs" to notifList)) {
            val f = file(what)
            if (!f.exists()) continue
            runCatching {
                val a = JSONArray(String(open(f.readBytes()), Charsets.UTF_8))
                val kept = (0 until a.length()).map { a.getJSONObject(it) }.map {
                    Entry(it.optLong("at"), it.optString("text"), it.optString("dir"), it.optString("app"), it.optString("title"), it.optString("id"))
                }
                synchronized(list) {
                    val seen = list.map { it.id.ifEmpty { "${it.at}:${it.text}" } }.toHashSet()
                    list.addAll(kept.filter { seen.add(it.id.ifEmpty { "${it.at}:${it.text}" }) })
                    list.sortByDescending { it.at }
                }
            }.onFailure { error = tr("The saved history couldn’t be opened") }
        }
        prune()
    }

    private fun prune() {
        val since = System.currentTimeMillis() - days * DAY
        for (list in listOf(clipList, notifList)) synchronized(list) { list.removeAll { it.at < since } }
    }

    private fun write() {
        if (!save) return
        prune()
        val snap = listOf("clip" to synchronized(clipList) { clipList.toList() }, "notifs" to synchronized(notifList) { notifList.toList() })
        core.bg.execute {
            for ((what, list) in snap) runCatching {
                val a = JSONArray(list.map { e ->
                    JSONObject().put("at", e.at).put("text", e.text).put("dir", e.dir).put("app", e.app).put("title", e.title).put("id", e.id)
                })
                val tmp = File(file(what).path + ".tmp")
                tmp.writeBytes(seal(a.toString().toByteArray(Charsets.UTF_8)))
                tmp.renameTo(file(what))
            }
        }
    }

    // Off: the saved history and its key go (this session's lists stay until TwinDesk quits).
    private fun forget() {
        runCatching { file("clip").delete(); file("notifs").delete() }
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS) }
    }

    // ---- the Keystore key (AES-256-GCM, never leaves the Keystore) ----

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return g.generateKey()
    }

    private fun seal(b: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        return c.iv + c.doFinal(b)
    }

    private fun open(b: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12))
        return c.doFinal(b, 12, b.size - 12)
    }
}
