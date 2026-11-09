// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What plays on this phone, for the computer's Overview (its media controls, shared/nowplaying.js):
// the app's media session — title, artist, its art, playing or paused, where it is — and Play,
// Pause, Next, Previous and Seek from there. Android shows media sessions only to a notification
// listener, so it's the full app's (the standard one says why: phone.media {none, why: 'listener'}).
// Sent only while the computer asks (phone.media.want, its Audio › Media controls on Overview),
// on every change, the art only when it changes.
package com.twindesk.android

import android.content.ComponentName
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class NowPlaying(core: Core) : Feature(core) {
    private val main = Handler(Looper.getMainLooper())
    private var want = false
    private var msm: MediaSessionManager? = null
    private var controller: MediaController? = null
    private var lastArt = ""
    private val component get() = ComponentName(core.ctx, NotifListener::class.java)
    private val sessions = MediaSessionManager.OnActiveSessionsChangedListener { pick(it) }
    private val callback = object : MediaController.Callback() {
        override fun onMetadataChanged(metadata: MediaMetadata?) = later()
        override fun onPlaybackStateChanged(state: PlaybackState?) = later()
        override fun onSessionDestroyed() = pick(runCatching { msm?.getActiveSessions(component) }.getOrNull())
    }
    private val sendNow = Runnable { send() }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.PHONE_MEDIA_WANT -> if (m.optBoolean("on")) start() else stop()
            Proto.T.PHONE_MEDIA_CTL -> control(m.optString("a"), m.optLong("pos", -1))
            else -> return false
        }
        return true
    }

    override fun onClosed() = stop()

    private fun start() {
        want = true
        lastArt = ""
        if (!BuildConfig.NOTIF_LISTENER) return none("listener")
        val m = core.ctx.getSystemService(MediaSessionManager::class.java) ?: return none("listener")
        try {
            if (msm == null) m.addOnActiveSessionsChangedListener(sessions, component, main)
            msm = m
            pick(m.getActiveSessions(component))
        } catch (_: SecurityException) {
            msm = null
            none("listener") // notification access not allowed (yet)
        }
    }

    // Notification access came on (NotifListener connected) while the computer asks: start for real
    // (before, Android refused the sessions and it said "listener").
    fun retry() = main.post { if (want && msm == null) start() }

    private fun stop() {
        want = false
        main.removeCallbacks(sendNow)
        runCatching { msm?.removeOnActiveSessionsChangedListener(sessions) }
        msm = null
        controller?.unregisterCallback(callback)
        controller = null
    }

    // The session to show: one that plays, else the first (the most recent). Never TwinDesk's own
    // (the computer's sound playing here): the computer knows what it plays.
    private fun pick(all: List<MediaController>?) {
        val list = all.orEmpty().filter { it.packageName != core.ctx.packageName }
        val c = list.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: list.firstOrNull()
        if (c?.sessionToken != controller?.sessionToken) {
            controller?.unregisterCallback(callback)
            controller = c
            c?.registerCallback(callback, main)
            lastArt = ""
        }
        later()
    }

    // Metadata and state come in bursts: one message for them.
    private fun later() {
        main.removeCallbacks(sendNow)
        main.postDelayed(sendNow, 150)
    }

    private fun none(why: String = "") {
        if (want) core.send(msg(Proto.T.PHONE_MEDIA, "none" to true, "why" to why))
    }

    private fun send() {
        if (!want) return
        val c = controller ?: return none()
        val md = c.metadata
        val st = c.playbackState
        val title = (md?.getText(MediaMetadata.METADATA_KEY_TITLE) ?: md?.getText(MediaMetadata.METADATA_KEY_DISPLAY_TITLE))?.toString() ?: ""
        if (md == null || title.isEmpty()) return none()
        val artist = (md.getText(MediaMetadata.METADATA_KEY_ARTIST) ?: md.getText(MediaMetadata.METADATA_KEY_ALBUM_ARTIST) ?: md.getText(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE))?.toString() ?: ""
        val album = md.getText(MediaMetadata.METADATA_KEY_ALBUM)?.toString() ?: ""
        val pm = core.ctx.packageManager
        val appName = runCatching { pm.getApplicationLabel(pm.getApplicationInfo(c.packageName, 0)).toString() }.getOrDefault(c.packageName)
        val playing = st?.state == PlaybackState.STATE_PLAYING || st?.state == PlaybackState.STATE_BUFFERING
        val actions = st?.actions ?: 0L
        // The position as of a wall-clock time, so the computer moves it on by itself.
        val at = if (st != null) System.currentTimeMillis() - (SystemClock.elapsedRealtime() - st.lastPositionUpdateTime) else System.currentTimeMillis()
        val m = msg(
            Proto.T.PHONE_MEDIA,
            "app" to c.packageName, "appName" to appName, "title" to title.take(200), "artist" to artist.take(200), "album" to album.take(200),
            "playing" to playing, "duration" to md.getLong(MediaMetadata.METADATA_KEY_DURATION).coerceAtLeast(0), "position" to (st?.position ?: -1),
            "at" to at, "speed" to (st?.playbackSpeed ?: 1f).toDouble(),
            "next" to (actions and PlaybackState.ACTION_SKIP_TO_NEXT != 0L), "prev" to (actions and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L),
            "seek" to (actions and PlaybackState.ACTION_SEEK_TO != 0L),
        )
        val art = md.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: md.getBitmap(MediaMetadata.METADATA_KEY_ART) ?: md.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON)
        val key = "${c.packageName}|$title|$album|${art?.generationId}"
        if (key != lastArt) {
            lastArt = key
            m.put("art", art?.let { jpeg(it) } ?: "")
        }
        core.send(m)
    }

    private fun jpeg(b: Bitmap): String? = runCatching {
        val k = 160f / maxOf(b.width, b.height).coerceAtLeast(1)
        val small = if (k < 1f) Bitmap.createScaledBitmap(b, (b.width * k).toInt().coerceAtLeast(1), (b.height * k).toInt().coerceAtLeast(1), true) else b
        val out = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.JPEG, 80, out)
        "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }.getOrNull()

    private fun control(a: String, pos: Long) {
        val c = controller ?: return
        val tc = c.transportControls
        when (a) {
            "play" -> tc.play()
            "pause" -> tc.pause()
            "toggle" -> if (c.playbackState?.state == PlaybackState.STATE_PLAYING) tc.pause() else tc.play()
            "next" -> tc.skipToNext()
            "prev" -> tc.skipToPrevious()
            "seek" -> if (pos >= 0) tc.seekTo(pos)
        }
    }
}
