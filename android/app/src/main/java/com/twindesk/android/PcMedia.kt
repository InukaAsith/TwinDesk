// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What plays on the computer (shared/pcnow.js): on the Media page, and as a media notification here
// (Media › Show in the notification shade) — Android puts it in the shade's media player, with
// Play/Pause, Next and Previous, the computer's name on it. Asked for (pc.media.want) only while one
// of them wants it; the computer reads its player every few seconds while asked, nothing otherwise.
package com.twindesk.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

class PcMedia(core: Core) : Feature(core) {
    companion object {
        private const val CH = "pcmedia"
        private const val ID = 20
    }

    class Now(val title: String, val artist: String, val album: String, val app: String, val playing: Boolean)

    private val main = Handler(Looper.getMainLooper())
    @Volatile var now: Now? = null; private set
    private var session: MediaSession? = null
    private var asked = false
    @Volatile var pageOpen = false; private set

    // Media › Show in the notification shade (on unless switched off).
    val notifOn: Boolean get() = core.store.flag("pcmedia.notif", true)
    fun setNotif(on: Boolean) { core.store.setFlag("pcmedia.notif", on); main.post { want(); show() }; core.changed() }

    // The Media page in front: it shows what plays even with the notification off.
    fun page(open: Boolean) { pageOpen = open; main.post { want() } }

    private fun want() {
        val w = core.link.connected && (notifOn || pageOpen)
        if (w == asked) return
        asked = w
        if (core.link.connected) core.send(msg(Proto.T.PC_MEDIA_WANT, "on" to w))
        if (!w) { now = null; show(); core.changed() }
    }

    override fun onWelcome(host: Host) { main.post { asked = false; want() } }

    override fun onClosed() {
        main.post {
            asked = false
            now = null
            show()
            core.changed()
        }
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t != Proto.T.PC_MEDIA) return false
        val n = if (m.optBoolean("none") || m.optString("title").isEmpty()) null
        else Now(m.str("title", 200), m.str("artist", 200), m.str("album", 200), m.str("app", 100), m.optBoolean("playing", true))
        main.post { now = n; show(); core.changed() }
        return true
    }

    // Play, Pause, Next, Previous: on the computer.
    fun control(a: String) {
        core.send(msg(Proto.T.PC_MEDIA_CTL, "a" to a))
        // Shown at once (the computer's answer follows in a moment).
        val n = now ?: return
        if (a == "toggle" || a == "play" || a == "pause") main.post {
            now = Now(n.title, n.artist, n.album, n.app, if (a == "toggle") !n.playing else a == "play")
            show()
            core.changed()
        }
    }

    // ---- the media notification ----

    private fun show() {
        val n = now
        val nm = Notify.nm(core.ctx)
        if (n == null || !notifOn || !core.link.connected) {
            runCatching { nm.cancel(ID) }
            session?.run { isActive = false; release() }
            session = null
            return
        }
        val s = session ?: MediaSession(core.ctx, "TwinDesk computer").also { ms ->
            ms.setCallback(object : MediaSession.Callback() {
                override fun onPlay() = control("play")
                override fun onPause() = control("pause")
                override fun onSkipToNext() = control("next")
                override fun onSkipToPrevious() = control("previous")
                override fun onStop() = control("pause")
            }, main)
            session = ms
        }
        val name = core.host?.name ?: "Computer"
        s.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, n.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, n.artist.ifEmpty { n.app })
                .putString(MediaMetadata.METADATA_KEY_ALBUM, n.album)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, n.artist.ifEmpty { n.app })
                .build(),
        )
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                .setState(if (n.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (n.playing) 1f else 0f)
                .build(),
        )
        s.isActive = true
        nm.createNotificationChannel(NotificationChannel(CH, tr("Computer’s media"), NotificationManager.IMPORTANCE_LOW).apply {
            description = tr("What plays on your computer, with its controls")
            setShowBadge(false)
        })
        val act = { icon: Int, label: String, a: String, req: Int ->
            Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(core.ctx, icon), label, Notify.action(core.ctx, ActionReceiver.PC_MEDIA, req, a)).build()
        }
        val open = PendingIntent.getActivity(core.ctx, 20, Intent(core.ctx, MainActivity::class.java).putExtra("tab", "Media").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = Notification.Builder(core.ctx, CH)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(n.title)
            .setContentText(n.artist.ifEmpty { n.app })
            .setSubText(name)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(n.playing)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(act(android.R.drawable.ic_media_previous, tr("Previous"), "previous", 21))
            .addAction(if (n.playing) act(android.R.drawable.ic_media_pause, tr("Pause"), "pause", 22) else act(android.R.drawable.ic_media_play, tr("Play"), "play", 22))
            .addAction(act(android.R.drawable.ic_media_next, tr("Next"), "next", 23))
            .setStyle(Notification.MediaStyle().setMediaSession(s.sessionToken).setShowActionsInCompactView(0, 1, 2))
        runCatching { nm.notify(ID, b.build()) }
    }
}
