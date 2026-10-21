// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files on the computer (shared/ui-pfiles.js there): this phone's shared storage folder by folder,
// read and written by TwinDesk itself with All files access, so no ADB (Mount on the computer is
// the ADB way). fs.list a folder; fs.do mkdir, rename, delete; fs.save sends files and folders to
// the computer (as Send does); fs.expect puts the next batch the computer sends into a folder.
// Paths are relative to the storage's top and never leave it. Made by Hub only while it's on.
package com.twindesk.android

import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StatFs
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class FsBrowse(private val core: Core) {
    private val root: File = Environment.getExternalStorageDirectory()

    // The file at a path from the computer, inside the storage, or null.
    private fun at(path: String): File? {
        val parts = path.split('/').filter { it.isNotEmpty() && it != "." }
        if (parts.any { it == ".." || it.any { c -> c < ' ' } }) return null
        val f = File(root, parts.joinToString("/"))
        val top = root.canonicalPath
        val real = runCatching { f.canonicalPath }.getOrNull() ?: return null
        return if (real == top || real.startsWith("$top/")) f else null
    }

    private fun rel(f: File): String = f.absolutePath.removePrefix(root.absolutePath).trim('/')

    private fun cleanName(n: String): String? {
        val t = n.trim()
        return if (t.isEmpty() || t == "." || t == ".." || t.length > 255 || t.any { it == '/' || it < ' ' }) null else t
    }

    fun list(m: JSONObject): JSONObject {
        val path = m.str("path", 1000)
        val out = msg(Proto.T.FS_LIST, "path" to path)
        if (!allowed()) return out.put("error", "All files access is off for TwinDesk on this phone")
        val dir = at(path)
        if (dir == null || !dir.isDirectory) return out.put("error", "That folder isn’t there any more").put("items", JSONArray())
        val hidden = m.optBoolean("hidden")
        val items = JSONArray()
        (dir.listFiles() ?: emptyArray()).filter { hidden || !it.name.startsWith(".") }.take(5000).forEach { f ->
            val d = f.isDirectory
            val o = JSONObject().put("name", f.name).put("dir", d).put("at", f.lastModified())
            if (d) o.put("n", f.list()?.count { hidden || !it.startsWith(".") } ?: 0) else o.put("size", f.length())
            items.put(o)
        }
        runCatching { StatFs(root.path).let { out.put("free", it.availableBytes).put("total", it.totalBytes) } }
        return out.put("items", items)
    }

    // mkdir {path (the folder), name} | rename {path (the item), name} | delete {path (the folder), paths}.
    fun act(m: JSONObject): JSONObject {
        val a = m.str("a", 20)
        val path = m.str("path", 1000)
        val done = { ok: Boolean, error: String, folder: String ->
            msg(Proto.T.FS_DONE, "ref" to m.str("ref", 60), "ok" to ok, "error" to error.ifEmpty { null }, "path" to folder)
        }
        if (!allowed()) return done(false, "All files access is off for TwinDesk on this phone", path)
        val f = at(path) ?: return done(false, "Not on this phone’s storage", path)
        val name = cleanName(m.str("name", 300))
        return when (a) {
            "mkdir" -> {
                if (name == null) return done(false, "That name won’t do", path)
                val d = File(f, name)
                if (d.exists()) done(false, "$name is already there", path) else done(d.mkdirs(), if (d.isDirectory) "" else "Couldn’t make $name", path)
            }
            "rename" -> {
                val parent = rel(f.parentFile ?: root)
                if (name == null || f == root) return done(false, "That name won’t do", parent)
                val to = File(f.parentFile, name)
                if (to.exists()) done(false, "$name is already there", parent)
                else done(f.renameTo(to), if (to.exists()) "" else "Couldn’t rename ${f.name}", parent)
            }
            "delete" -> {
                val paths = m.optJSONArray("paths") ?: JSONArray()
                val gone = (0 until paths.length()).mapNotNull { at(paths.optString(it)) }.filter { it != root }
                val failed = gone.count { !it.deleteRecursively() }
                done(failed == 0, if (failed == 0) "" else "Couldn’t delete ${Files.plural(failed, "item")}", path)
            }
            else -> done(false, "", path)
        }
    }

    // To the computer's Downloads, folders with what's in them (their paths kept).
    fun save(paths: JSONArray?) {
        if (!allowed()) return
        val items = ArrayList<Files.Item>()
        for (i in 0 until (paths?.length() ?: 0)) {
            val f = at(paths!!.optString(i)) ?: continue
            if (f == root) continue
            val base = f.parentFile ?: root
            f.walkTopDown().filter { it.isFile }.take(10000 - items.size).forEach { x ->
                items += Files.Item(Uri.fromFile(x), x.name, x.length(), x.relativeTo(base).invariantSeparatorsPath)
            }
            if (items.size >= 10000) break
        }
        if (items.isNotEmpty()) core.files.send(items, "send")
    }

    // The computer's next batch (its Upload) goes into this folder; the folder is listed again after.
    fun expect(batch: String, path: String) {
        if (batch.isEmpty() || !allowed()) return
        val dir = at(path)?.takeIf { it.isDirectory } ?: return
        core.files.expect(batch, Files.Target(false, dir, where = rel(dir).ifEmpty { "Storage" }, keepBoth = true) {
            core.send(msg(Proto.T.FS_DONE, "ok" to it.ok, "error" to if (it.ok) null else "Not everything arrived", "path" to path))
        })
    }

    companion object {
        // All files access (Android 11 and later; Files isn't offered before).
        fun allowed() = Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()
    }
}
