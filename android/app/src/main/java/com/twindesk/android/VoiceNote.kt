// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Voice note (a button of the connected notification, General › Notification buttons; not one of
// the defaults): recording starts at once, Send stops it and the note goes to the computer as Send
// files does (it waits there under Waiting to send when the computer isn't connected). A copy stays
// in the phone's Recordings/TwinDesk. Leaving the dialog sends what was recorded: Android lets only
// an app on screen use the microphone, so nothing records in the background.
package com.twindesk.android

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class VoiceNoteActivity : Activity() {
    private var rec: MediaRecorder? = null
    private var pfd: ParcelFileDescriptor? = null
    private var uri: Uri? = null
    private var started = 0L
    private var dialog: AlertDialog? = null
    private var done = false
    private val main = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            val s = (System.currentTimeMillis() - started) / 1000
            dialog?.setMessage(String.format(Locale.ROOT, "%d:%02d", s / 60, s % 60))
            if (rec != null) main.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return finish()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        } else begin()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) begin() else finish()
    }

    private fun begin() {
        val core = Core.get(this)
        val name = core.host?.name ?: core.hosts().firstOrNull()?.name ?: tr("your computer")
        val ok = runCatching { start() }.onFailure { Log.w("TwinDesk", "voice note: ${it.message}") }.isSuccess
        if (!ok) {
            Toast.makeText(applicationContext, tr("Couldn’t record"), Toast.LENGTH_SHORT).show()
            discard()
            return finish()
        }
        // The system's own dialog look, light or dark as the phone is.
        val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        dialog = AlertDialog.Builder(this, if (night) android.R.style.Theme_DeviceDefault_Dialog_Alert else android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
            .setTitle(tr("Voice note for {name}", "name" to name))
            .setMessage("0:00")
            .setPositiveButton(tr("Send")) { _, _ -> finishNote(send = true) }
            .setNegativeButton(tr("Cancel")) { _, _ -> finishNote(send = false) }
            .setOnCancelListener { finishNote(send = false) }
            .show()
        main.post(tick)
    }

    private fun start() {
        val stamp = SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.ROOT).format(Date())
        val v = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, "Voice note $stamp.m4a")
            put(MediaStore.MediaColumns.MIME_TYPE, "audio/mp4")
            put(MediaStore.MediaColumns.RELATIVE_PATH, (if (Build.VERSION.SDK_INT >= 31) Environment.DIRECTORY_RECORDINGS else Environment.DIRECTORY_MUSIC) + "/TwinDesk")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val u = contentResolver.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v) ?: error("no place for it")
        uri = u
        val fd = contentResolver.openFileDescriptor(u, "w") ?: error("can't write it")
        pfd = fd
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else MediaRecorder()
        r.setAudioSource(MediaRecorder.AudioSource.MIC)
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        r.setAudioEncodingBitRate(96000)
        r.setAudioSamplingRate(44100)
        r.setOutputFile(fd.fileDescriptor)
        r.prepare()
        r.start()
        rec = r
        started = System.currentTimeMillis()
    }

    // Stops it; send: to the computer (a note under a second isn't one).
    private fun finishNote(send: Boolean) {
        if (done) return
        done = true
        main.removeCallbacks(tick)
        val r = rec
        rec = null
        val long = System.currentTimeMillis() - started >= 1000
        val stopped = r != null && runCatching { r.stop() }.isSuccess
        runCatching { r?.release() }
        runCatching { pfd?.close() }
        val u = uri
        if (!send || !stopped || !long || u == null) {
            discard()
        } else {
            runCatching { contentResolver.update(u, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null) }
            val core = Core.get(this)
            val now = core.link.connected
            val went = core.files.send(core.files.describe(listOf(u)), "send")
            val name = core.host?.name ?: core.hosts().firstOrNull()?.name ?: tr("your computer")
            Toast.makeText(applicationContext, when {
                now -> tr("Sending to {name}", "name" to name)
                went -> tr("Waiting for {name}", "name" to name) // Waiting to send
                else -> tr("Saved in Recordings › TwinDesk")
            }, Toast.LENGTH_SHORT).show()
        }
        dialog?.dismiss()
        finish()
    }

    private fun discard() {
        uri?.let { u -> runCatching { contentResolver.delete(u, null, null) } }
        uri = null
    }

    // Off screen: Android takes the microphone away, so what was recorded goes now.
    override fun onStop() {
        super.onStop()
        if (rec != null && !isChangingConfigurations) finishNote(send = true)
    }

    override fun onDestroy() {
        if (!done) finishNote(send = false)
        super.onDestroy()
    }
}
