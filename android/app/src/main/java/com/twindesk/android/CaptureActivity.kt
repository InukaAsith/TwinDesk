// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Capture from phone (the computer's Explorer › TwinDesk, cam.capture): the phone's own camera app
// opens, and every photo taken goes to the computer, into the folder that was right-clicked there,
// then the camera opens again for the next one. Back in the camera ends it, and the computer hears
// it (cam.capture {on: false}); the computer ending it closes this. {once: true} (the computer's
// Camera › Take a photo): one photo, then it closes by itself. The photos also stay in the
// phone's Pictures/TwinDesk.
package com.twindesk.android

import android.content.ContentValues
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
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

    private val take = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        running = this
        uri = savedInstanceState?.getString("uri")?.let(Uri::parse)
        if (savedInstanceState == null) next()
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        uri?.let { out.putString("uri", it.toString()) }
    }

    private fun next() {
        val name = "TwinDesk_" + SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date()) + ".jpg"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            if (android.os.Build.VERSION.SDK_INT >= 29) put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/TwinDesk")
        }
        val u = runCatching { contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) }.getOrNull() ?: return end()
        uri = u
        if (runCatching { take.launch(u) }.isFailure) end()
    }

    // The computer ended it, or it ended here.
    fun end(tell: Boolean = true) {
        if (tell && !told && core.link.connected) core.send(msg(T, "on" to false))
        told = true
        finish()
    }

    override fun onDestroy() {
        if (running === this) running = null
        super.onDestroy()
    }
}
