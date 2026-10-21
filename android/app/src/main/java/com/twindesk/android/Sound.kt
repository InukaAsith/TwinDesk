// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This phone's sound on the computer without wireless debugging: Android's playback capture
// (Android 10+, through a screen capture grant, asked for on the phone each time), Opus through
// MediaCodec, over the session (phone.sound). The computer asks for it (phone.sound.want) while
// "Play this device's sound" is on and adb can't carry it; when adb can, it says off again.
// Apps that don't allow capture (some streaming apps, calls) stay silent there, and the sound keeps
// playing on the phone as well: only adb can move it off the phone.
package com.twindesk.android

import android.Manifest
import android.app.Activity
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.IBinder
import android.util.Base64
import android.util.Log
import org.json.JSONArray

private const val RATE = 48000
private const val FRAME = 960 // 20 ms
private const val MAX_QUEUED = 96 * 1024L // bytes waiting on the socket: past this, sound is dropped (late sound is worse than none)

class PhoneSound(core: Core) : Feature(core) {
    @Volatile var wanted = false; private set // the computer asks for it
    val on get() = SoundService.running != null
    @Volatile var error = ""; private set

    override fun onClosed() = want(false)

    override fun onMessage(t: String, m: org.json.JSONObject): Boolean {
        if (t != Proto.T.PHONE_SOUND_WANT) return false
        want(m.optBoolean("on"))
        return true
    }

    private fun want(v: Boolean) {
        if (v == wanted) return
        wanted = v
        error = ""
        if (v) Notify.sound(core.ctx, core.host?.name ?: "your computer")
        else { Notify.cancelSound(core.ctx); SoundService.stop(core.ctx) }
        tell()
        core.changed()
    }

    // Start (the notification, or the app): the capture grant, then the service.
    fun start(ctx: Context) {
        ctx.startActivity(Intent(ctx, SoundActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun stop() {
        SoundService.stop(core.ctx)
    }

    fun ok() = failed("") // started: an earlier error is gone

    fun failed(why: String) {
        error = why
        tell()
        core.changed()
    }

    // phone.sound.state {on, waiting (for Start here), error, codec}
    fun tell() {
        if (!core.link.connected) return
        core.send(msg(Proto.T.PHONE_SOUND_STATE, "on" to on, "waiting" to (wanted && !on), "error" to error, "codec" to (SoundService.running?.codec ?: "")))
    }
}

// The grant: microphone permission (Android wants it for any capture), then the screen capture
// prompt (which, for sound, is the only way in).
class SoundActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Notify.cancelSound(this)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        else ask()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) ask()
        else { Core.get(this).sound.failed("Allow the microphone permission for TwinDesk on the phone (Android asks it for any sound capture)"); finish() }
    }

    private fun ask() {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), 2)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 2 && resultCode == RESULT_OK && data != null) {
            runCatching { startForegroundService(Intent(this, SoundService::class.java).putExtra("code", resultCode).putExtra("data", data)) }
                .onFailure { Core.get(this).sound.failed(it.message ?: "couldn’t start") }
        } else if (requestCode == 2) Core.get(this).sound.failed("Not started on the phone")
        finish()
    }
}

// Holds the capture (Android wants a foreground service of type mediaProjection for it).
class SoundService : Service() {
    private var projection: MediaProjection? = null
    private var record: AudioRecord? = null
    private var codecs: MediaCodec? = null
    @Volatile private var capturing = false
    @Volatile var codec = ""; private set
    private var thread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val core = Core.get(this)
        val name = core.host?.name ?: "your computer"
        try {
            startForeground(Notify.ID_SOUND, Notify.soundOn(this, name), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } catch (e: Exception) {
            core.sound.failed(e.message ?: "couldn’t start"); stopSelf(); return START_NOT_STICKY
        }
        if (running != null) return START_NOT_STICKY
        @Suppress("DEPRECATION")
        val data: Intent? = intent?.getParcelableExtra("data")
        val code = intent?.getIntExtra("code", 0) ?: 0
        if (data == null || !core.sound.wanted) { stopSelf(); return START_NOT_STICKY }
        try {
            begin(core, code, data)
        } catch (e: Exception) {
            Log.w("TwinDesk", "sound: ${e.message}")
            core.sound.failed(e.message ?: "couldn’t capture"); end(); stopSelf()
            return START_NOT_STICKY
        }
        running = this
        core.sound.ok()
        return START_NOT_STICKY
    }

    @Suppress("MissingPermission") // asked for in SoundActivity
    private fun begin(core: Core, code: Int, data: Intent) {
        val p = getSystemService(MediaProjectionManager::class.java).getMediaProjection(code, data) ?: throw IllegalStateException("no capture grant")
        projection = p
        p.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { stopSelf() } // stopped from the status bar or the lock screen
        }, null)
        val cfg = AudioPlaybackCaptureConfiguration.Builder(p)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()
        val fmt = AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build()
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
        val r = AudioRecord.Builder().setAudioFormat(fmt).setBufferSizeInBytes(maxOf(min, FRAME * 4 * 8)).setAudioPlaybackCaptureConfig(cfg).build()
        if (r.state != AudioRecord.STATE_INITIALIZED) { r.release(); throw IllegalStateException("Android refused the sound capture") }
        record = r
        // Opus (Android 10's own encoder); raw PCM where a phone has none.
        codecs = runCatching {
            MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS).apply {
                configure(MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, RATE, 2).apply {
                    setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
                }, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                start()
            }
        }.getOrNull()
        codec = if (codecs != null) "opus" else "pcm"
        r.startRecording()
        capturing = true
        thread = Thread({ loop(core) }, "td-sound").apply { start() }
    }

    private fun loop(core: Core) {
        val r = record ?: return
        val pcm = ByteArray(FRAME * 4)
        val info = MediaCodec.BufferInfo()
        val out = JSONArray()
        var batched = 0
        while (capturing) {
            var n = 0
            while (n < pcm.size && capturing) {
                val k = r.read(pcm, n, pcm.size - n)
                if (k <= 0) { if (k < 0) capturing = false; break }
                n += k
            }
            if (n < pcm.size) continue
            val c = codecs
            if (c == null) out.put(Base64.encodeToString(pcm, Base64.NO_WRAP))
            else {
                val i = c.dequeueInputBuffer(10_000)
                if (i >= 0) {
                    c.getInputBuffer(i)!!.apply { clear(); put(pcm) }
                    c.queueInputBuffer(i, 0, pcm.size, 0, 0)
                }
                while (true) {
                    val o = c.dequeueOutputBuffer(info, 0)
                    if (o < 0) break
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
                        val b = ByteArray(info.size)
                        c.getOutputBuffer(o)!!.apply { position(info.offset); get(b) }
                        out.put(Base64.encodeToString(b, Base64.NO_WRAP))
                    }
                    c.releaseOutputBuffer(o, false)
                }
            }
            // Two frames a message (40 ms): fewer messages, little delay.
            if (++batched < 2 || out.length() == 0) continue
            batched = 0
            if (core.link.queued() < MAX_QUEUED) core.send(msg(Proto.T.PHONE_SOUND, "codec" to codec, "p" to JSONArray(out.toString())))
            while (out.length() > 0) out.remove(0)
        }
    }

    private fun end() {
        capturing = false
        runCatching { thread?.join(500) }
        runCatching { record?.stop() }
        runCatching { record?.release() }
        runCatching { codecs?.stop() }
        runCatching { codecs?.release() }
        runCatching { projection?.stop() }
        record = null; codecs = null; projection = null
    }

    override fun onDestroy() {
        end()
        if (running === this) running = null
        val core = Core.get(this)
        if (core.sound.wanted && core.link.connected) Notify.sound(this, core.host?.name ?: "your computer") // stopped here: Start again from there
        core.sound.tell()
        core.changed()
        super.onDestroy()
    }

    companion object {
        @Volatile var running: SoundService? = null; private set
        fun stop(ctx: Context) {
            runCatching { ctx.stopService(Intent(ctx, SoundService::class.java)) }
        }
    }
}
