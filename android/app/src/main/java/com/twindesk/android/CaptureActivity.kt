// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Capture from phone (the computer's Explorer › TwinDesk, cam.capture): the phone's own camera app
// opens, and every photo taken goes to the computer, into the folder that was right-clicked there,
// then the camera opens again for the next one. Back in the camera ends it, and the computer hears
// it (cam.capture {on: false}); the computer ending it closes this. {once: true} (the computer's
// Camera › Take a photo): one photo, then it closes by itself. The photos also stay in the
// phone's Pictures/TwinDesk.
// {mode: "scan"} (Camera › Scan document): pages in cache, a review, then one PDF to the computer.
// An older computer omits mode, and this stays a normal capture.
package com.twindesk.android

import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class CaptureActivity : ComponentActivity() {
    companion object {
        const val T = "cam.capture"
        @Volatile var running: CaptureActivity? = null; private set
    }

    private val core by lazy { Core.get(this) }
    private var uri: Uri? = null
    private var told = false
    private var dead = false
    private var scanning = false
    private var shooting = false
    private var savedPdf = false
    private var pending: String? = null
    private val pages = mutableStateListOf<ScanPage>()
    private var note by mutableStateOf("")

    private val take = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        if (scanning) onScanned(ok) else onPhoto(ok)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        scanning = intent.getStringExtra("mode") == "scan"
        if (scanning) setTheme(R.style.Theme_TwinDesk) // the manifest theme is the invisible one, for a photo
        super.onCreate(savedInstanceState)
        running = this
        if (scanning) startScan(savedInstanceState) else {
            uri = savedInstanceState?.getString("uri")?.let(Uri::parse)
            if (savedInstanceState == null) next()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        uri?.let { outState.putString("uri", it.toString()) }
        if (!scanning) return
        outState.putStringArrayList("pages", ArrayList(pages.map { it.path }))
        outState.putIntArray("degs", pages.map { it.deg }.toIntArray())
        pending?.let { outState.putString("pending", it) }
    }

    private fun startScan(saved: Bundle?) {
        if (saved == null) wipePagesDir() // a new scan. A rotation keeps the files the new instance restores.
        else {
            val paths = saved.getStringArrayList("pages") ?: arrayListOf()
            val degs = saved.getIntArray("degs") ?: IntArray(0)
            paths.forEachIndexed { i, p -> if (File(p).isFile) pages.add(ScanPage(p, degs.getOrNull(i) ?: 0)) }
            pending = saved.getString("pending")?.takeIf { File(it).isFile }
        }
        setContent {
            Theme {
                ScanScreen(pages, DocScanPdf.saving, note, ::shot, ::removeLast, ::rotateLast, ::retake, ::savePdf, ::cancelScan)
            }
        }
        onBackPressedDispatcher.addCallback(this) {
            if (DocScanPdf.saving) return@addCallback
            cancelScan()
        }
        if (saved == null) shot()
    }

    private fun shot() {
        if (dead || DocScanPdf.saving || shooting) return
        if (pages.size >= DocScanPdf.MAX_PAGES) {
            note = tr("30 pages is the most")
            return
        }
        val dir = File(cacheDir, "scan_pages").apply { mkdirs() }
        val file = File(dir, "page_${System.currentTimeMillis()}.jpg")
        if (!runCatching { file.createNewFile() }.getOrDefault(false) && !file.isFile) {
            if (pages.isEmpty()) cancelScan()
            return
        }
        val target = runCatching { FileProvider.getUriForFile(this, "$packageName.files", file) }.getOrNull()
        if (target == null) {
            file.delete()
            if (pages.isEmpty()) cancelScan()
            return
        }
        pending = file.absolutePath
        shooting = true
        if (runCatching { take.launch(target) }.isFailure) {
            shooting = false
            pending = null
            file.delete()
            if (pages.isEmpty()) cancelScan()
        }
    }

    private fun onScanned(ok: Boolean) {
        shooting = false
        val path = pending
        pending = null
        val file = path?.let { File(it) }
        if (ok && file != null && file.isFile && file.length() > 0L) {
            pages.add(ScanPage(file.absolutePath, 0))
            note = ""
            return
        }
        file?.delete()
        if (pages.isEmpty()) cancelScan() // the first shutter cancelled: nothing was scanned
    }

    private fun removeLast() {
        if (dead || DocScanPdf.saving || pages.isEmpty()) return
        val p = pages.removeAt(pages.lastIndex)
        File(p.path).delete()
        note = ""
    }

    private fun rotateLast() {
        if (dead || DocScanPdf.saving || pages.isEmpty()) return
        val i = pages.lastIndex
        pages[i] = pages[i].copy(deg = (pages[i].deg + 90) % 360)
    }

    private fun retake() {
        if (pages.isEmpty()) return
        removeLast()
        shot()
    }

    private fun savePdf() {
        if (dead || DocScanPdf.saving || pages.isEmpty()) return
        val shot = pages.toList()
        DocScanPdf.saving = true
        note = ""
        val gen = ++DocScanPdf.saveGen
        val appCtx = applicationContext
        val appCore = core
        val main = android.os.Handler(android.os.Looper.getMainLooper())
        appCore.bg.execute {
            val uri = try {
                DocScanPdf.save(appCtx, shot)
            } catch (e: Exception) {
                main.post {
                    if (gen != DocScanPdf.saveGen) return@post
                    val act = running
                    if (act == null) DocScanPdf.saving = false
                    else act.onSaveFailed(gen, e)
                }
                return@execute
            }
            if (gen != DocScanPdf.saveGen) {
                DocScanPdf.discard(appCtx, uri)
                return@execute
            }
            // files.send queues a file while disconnected. A scan is not a queued send.
            val connected = appCore.link.connected
            val items = if (connected) appCore.files.describe(listOf(uri)) else emptyList()
            val sent = connected && items.isNotEmpty() && appCore.files.send(items, "send")
            if (!sent) DocScanPdf.discard(appCtx, uri)
            main.post {
                if (gen != DocScanPdf.saveGen) return@post
                val act = running
                if (act == null) DocScanPdf.saving = false
                else if (sent) act.onSaveSent(gen)
                else act.onSaveNotSent(gen, connected)
            }
        }
    }

    private fun onSaveFailed(gen: Int, e: Exception) {
        if (gen != DocScanPdf.saveGen || dead) return
        DocScanPdf.saving = false
        val text = tr("Couldn’t make the PDF: {error}", "error" to (e.message ?: ""))
        note = text
        toast(text)
    }

    private fun onSaveSent(gen: Int) {
        if (gen != DocScanPdf.saveGen || dead) return
        toast(tr("Sending to {name}", "name" to (core.host?.name ?: tr("your computer"))))
        savedPdf = true
        DocScanPdf.saving = false
        cleanupPages()
        end(tell = false) // the computer closes the camera when the PDF arrives
    }

    private fun onSaveNotSent(gen: Int, connected: Boolean) {
        if (gen != DocScanPdf.saveGen || dead) return
        DocScanPdf.saving = false
        toast(if (!connected) tr("The computer isn’t connected. The scan was not sent.") else tr("Couldn’t make the PDF: {error}", "error" to "unreadable"))
        if (!connected) {
            cleanupPages()
            end(tell = false)
        }
    }

    private fun cancelScan() { end(tell = true) }

    private fun onPhoto(ok: Boolean) {
        val u = uri
        uri = null
        if (ok && u != null && core.link.connected) {
            core.bg.execute { core.files.send(core.files.describe(listOf(u)), "send") }
            if (intent.getBooleanExtra("once", false)) end(tell = false) else next() // once: Camera › Take a photo (shared/phonephoto.js), one photo
        } else {
            if (u != null && !ok) runCatching { contentResolver.delete(u, null, null) } // nothing was taken
            end()
        }
    }

    private fun next() {
        val name = "TwinDesk_" + SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date()) + ".jpg"
        val values = android.content.ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            if (android.os.Build.VERSION.SDK_INT >= 29) put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/TwinDesk")
        }
        val u = runCatching { contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) }.getOrNull() ?: return end()
        uri = u
        if (runCatching { take.launch(u) }.isFailure) end()
    }

    // The computer ended it, or it ended here. tell: the computer hears cam.capture {on: false}.
    fun end(tell: Boolean = true) {
        dead = true
        if (scanning) {
            DocScanPdf.saveGen++ // a PDF still being built is dropped, not sent
            DocScanPdf.saving = false
            cleanupPages()
        }
        if (tell && !told && core.link.connected) core.send(msg(T, "on" to false))
        told = true
        finish()
    }

    private fun cleanupPages() {
        for (p in pages) File(p.path).delete()
        pages.clear()
        pending?.let { File(it).delete() }
        pending = null
    }

    private fun wipePagesDir() {
        File(cacheDir, "scan_pages").listFiles()?.forEach { it.delete() }
    }

    private fun toast(text: String) = Toast.makeText(applicationContext, text, Toast.LENGTH_LONG).show()

    override fun onDestroy() {
        if (running === this) running = null
        // Only drop temp pages when finishing; Android may destroy and recreate this activity
        // while the system camera is open (memory pressure or "Don't keep activities").
        if (scanning && isFinishing && !savedPdf) cleanupPages()
        super.onDestroy()
    }
}
