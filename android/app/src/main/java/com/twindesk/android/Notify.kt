// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Every notification TwinDesk posts: the link (the foreground service), invites, files arriving,
// files copied on the computer (Copy / Save), and the computer's own notifications.
package com.twindesk.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import android.content.Intent
import android.net.Uri

object Notify {
    const val CH_LINK = "link"
    const val CH_INVITE = "invite"
    const val CH_FILES = "files"
    const val CH_CLIP = "clip"
    const val CH_COMPUTER = "computer"
    const val CH_UPDATES = "updates"
    const val CH_SCREEN = "screen"
    const val CH_ASK = "ask"
    const val CH_REZUME = "rezume.now" // what's in use on the computer: shown with the others, no sound ("rezume", silent, hid it)
    const val CH_REZUME_SENT = "rezume.sent" // … sent on purpose (Send to), rings

    const val ID_LINK = 1
    const val ID_INVITE = 2
    const val ID_FCLIP = 3
    const val ID_ADB = 4
    const val ID_PAIR = 5
    const val ID_UPDATE = 6
    const val ID_SCREEN = 7
    const val ID_HOTSPOT = 8
    const val ID_WIFI = 9
    const val ID_INPUT = 10
    const val ID_HUB_ASK = 11
    const val ID_REZUME = 13 // ReZume: the computer's tab or document (the last one only)
    const val ID_REZUME_READY = 14 // … a document that came, to open
    const val ID_RING = 15 // the computer rang this phone: Stop
    const val ID_DIAL = 16 // a code from the computer (*#06#…): tap to open the dialer with it
    const val ID_MEDIA_DEL = 17 // Remove on the computer's Photos page, without All files access: tap for Android's confirmation
    const val ID_PEER = 18 // Connect with Android (Peer.kt): a phone asks to connect, to pair, to see the screen
    const val ID_SOUND = 12 // the sound capture: asking for Start, then its service's own
    private const val ID_FILES_BASE = 1000
    private const val ID_COMPUTER_BASE = 100000

    fun nm(ctx: Context) = ctx.getSystemService(NotificationManager::class.java)

    fun channels(ctx: Context) {
        val n = nm(ctx)
        n.createNotificationChannel(NotificationChannel(CH_LINK, tr("Connection"), NotificationManager.IMPORTANCE_LOW).apply {
            description = tr("Shown while TwinDesk is ready for your computer")
            setShowBadge(false)
        })
        n.createNotificationChannel(NotificationChannel(CH_INVITE, tr("Pairing requests"), NotificationManager.IMPORTANCE_HIGH))
        n.createNotificationChannel(NotificationChannel(CH_FILES, tr("Files"), NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = tr("Files arriving from your computer")
        })
        n.createNotificationChannel(NotificationChannel(CH_CLIP, tr("Copied on your computer"), NotificationManager.IMPORTANCE_HIGH).apply {
            description = tr("Files copied with the shortcut, ready to paste or save")
        })
        n.createNotificationChannel(NotificationChannel(CH_COMPUTER, tr("Your computer’s notifications"), NotificationManager.IMPORTANCE_HIGH))
        n.createNotificationChannel(NotificationChannel(CH_SCREEN, tr("Shared screens"), NotificationManager.IMPORTANCE_HIGH).apply {
            description = tr("Your computer is sharing its screen with this phone")
        })
        n.createNotificationChannel(NotificationChannel(CH_UPDATES, tr("Updates"), NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = tr("A new version of TwinDesk on GitHub")
        })
    }

    fun openApp(ctx: Context): PendingIntent = PendingIntent.getActivity(
        ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun action(ctx: Context, action: String, req: Int, extra: String = ""): PendingIntent = PendingIntent.getBroadcast(
        ctx, req, Intent(ctx, ActionReceiver::class.java).setAction(action).putExtra("arg", extra),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    // The computer started sharing and the viewer couldn't open by itself (no "Display over other
    // apps"): tap to see it.
    fun screen(ctx: Context, name: String) {
        val open = PendingIntent.getActivity(
            ctx, 7, Intent(ctx, ViewerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        runCatching {
            nm(ctx).notify(ID_SCREEN, Notification.Builder(ctx, CH_SCREEN)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("{name} is sharing its screen", "name" to name))
                .setContentText(tr("Tap to view"))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build())
        }
    }

    fun cancelScreen(ctx: Context) = runCatching { nm(ctx).cancel(ID_SCREEN) }.let { }

    fun link(ctx: Context, core: Core): Notification {
        val h = core.host
        val b = Notification.Builder(ctx, CH_LINK)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentIntent(openApp(ctx))
            .setOngoing(true)
            .setShowWhen(false)
        when {
            h != null -> {
                b.setContentTitle(tr("Connected to {name}", "name" to h.name))
                b.setContentText(core.files.activeLine() ?: tr("Files, clipboard and notifications are shared"))
                // The ones chosen in General › Notification buttons (three at most); wireless debugging
                // being off has its own notification (adbOff).
                QuickActions.actions(ctx, core).forEach { b.addAction(it) }
            }
            core.link.state == "connecting" -> b.setContentTitle(tr("Connecting to {name}…", "name" to (core.link.host?.name ?: tr("your computer"))))
            else -> {
                b.setContentTitle(tr("Ready for your computer"))
                val near = core.hosts().firstOrNull { core.isNear(it.id) }
                b.setContentText(if (near != null) tr("{name} is nearby", "name" to near.name) else tr("Open TwinDesk on your computer to connect"))
                if (near != null) b.addAction(Notification.Action.Builder(null, tr("Connect to {name}", "name" to near.name), action(ctx, ActionReceiver.CONNECT, 13, near.id)).build())
            }
        }
        if (h == null) b.addAction(Notification.Action.Builder(null, tr("Exit"), action(ctx, ActionReceiver.EXIT, 15)).build())
        return b.build()
    }

    fun invite(ctx: Context, name: String) {
        nm(ctx).notify(
            ID_INVITE,
            Notification.Builder(ctx, CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("{name} wants to pair", "name" to name))
                .setContentText(tr("Open TwinDesk to compare the code"))
                .setContentIntent(openApp(ctx))
                .setAutoCancel(true)
                .build(),
        )
    }

    fun cancelInvite(ctx: Context) = nm(ctx).cancel(ID_INVITE)

    // The computer (a Mac, through Bluetooth) wants this phone's screen, which needs Wi-Fi: the
    // hotspot, which only the person can switch on. Tap: the hotspot settings.
    fun hotspot(ctx: Context, name: String) {
        val settings = Intent("android.settings.TETHER_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val target = if (settings.resolveActivity(ctx.packageManager) != null) settings
            else Intent(android.provider.Settings.ACTION_WIRELESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val open = PendingIntent.getActivity(ctx, 8, target, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        runCatching {
            nm(ctx).notify(ID_HOTSPOT, Notification.Builder(ctx, CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Turn on the hotspot for {name}", "name" to name))
                .setContentText(tr("{name} isn’t on this phone’s network. Tap to open the hotspot, then type its name and password on {name}.", "name" to name))
                .setStyle(Notification.BigTextStyle().bigText(tr("{name} isn’t on this phone’s network. Tap to open the hotspot, then type its name and password on {name}.", "name" to name)))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build())
        }
    }

    fun cancelHotspot(ctx: Context) = nm(ctx).cancel(ID_HOTSPOT)

    // Wi-Fi Direct needs Wi-Fi on (no network needed), and Android doesn't let apps switch it on.
    fun wifiOff(ctx: Context, name: String) {
        val panel = Intent(if (Build.VERSION.SDK_INT >= 29) android.provider.Settings.Panel.ACTION_WIFI else android.provider.Settings.ACTION_WIFI_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val open = PendingIntent.getActivity(ctx, 9, panel, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = tr("Files and screens with {name} use Wi-Fi Direct. Tap to turn on Wi-Fi; no network connection is required.", "name" to name)
        runCatching {
            nm(ctx).notify(ID_WIFI, Notification.Builder(ctx, CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Turn on Wi-Fi for {name}", "name" to name))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build())
        }
        // TwinDesk on screen: the Wi-Fi panel straight away (Android ignores this from the background).
        runCatching { ctx.startActivity(panel) }
    }

    fun cancelWifiOff(ctx: Context) = nm(ctx).cancel(ID_WIFI)

    // A code dialed on the computer (Calls.kt): never run from there, the dialer opens with it here.
    fun dial(ctx: Context, code: String, open: Intent) {
        val pi = PendingIntent.getActivity(ctx, ID_DIAL, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        runCatching {
            nm(ctx).notify(ID_DIAL, Notification.Builder(ctx, CH_ASK)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Dial {code}", "code" to code))
                .setContentText(tr("Code from the computer. Tap to open it in the dialer."))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build())
        }
    }

    // The computer's mouse wants this phone without wireless debugging: the Accessibility switch.
    // supported: this build has the Accessibility service (the full one); else the app, which says how to get it.
    fun input(ctx: Context, name: String, supported: Boolean) {
        val to = if (supported) Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS) else Intent(ctx, MainActivity::class.java)
        val open = PendingIntent.getActivity(ctx, 10, to.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = if (supported) tr("To use {name}’s mouse and keyboard without wireless debugging, turn on TwinDesk in Accessibility (Installed apps). Tap to open settings.", "name" to name)
            else tr("This version of TwinDesk requires wireless debugging for the mouse and keyboard from {name}. Set up wireless debugging, then install the full version from the Phone page on {name}.", "name" to name)
        runCatching {
            nm(ctx).notify(ID_INPUT, Notification.Builder(ctx, CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Let {name} control this phone", "name" to name))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build())
        }
    }

    fun cancelInput(ctx: Context) = nm(ctx).cancel(ID_INPUT)

    // The computer wants this phone's sound or its screen without wireless debugging (Sound.kt,
    // Mirror.kt): Start asks for the capture (one Start for both).
    fun sound(ctx: Context, name: String, screen: Boolean = false) {
        val start = PendingIntent.getActivity(ctx, 12, Intent(ctx, SoundActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = if (screen) tr("Without wireless debugging, TwinDesk shares the screen itself. Tap Start, then confirm. Stop it from this notification at any time.")
            else tr("Without wireless debugging, TwinDesk captures the audio itself. Tap Start, then confirm. Apps that block capture stay silent.")
        runCatching {
            nm(ctx).notify(ID_SOUND, Notification.Builder(ctx, CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(if (screen) tr("Show this phone’s screen on {name}", "name" to name) else tr("Play this phone’s sound on {name}", "name" to name))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(start)
                .addAction(Notification.Action.Builder(null, tr("Start"), start).build())
                .setOnlyAlertOnce(true)
                .build())
        }
    }

    fun cancelSound(ctx: Context) = runCatching { nm(ctx).cancel(ID_SOUND) }.let { }

    // While it plays there (SoundService's own notification): Stop ends it.
    fun soundOn(ctx: Context, name: String, screen: Boolean = false, sound: Boolean = true): Notification = Notification.Builder(ctx, CH_LINK)
        .setSmallIcon(R.drawable.ic_stat)
        .setContentTitle(when {
            screen && sound -> tr("This phone’s screen and sound are on {name}", "name" to name)
            screen -> tr("This phone’s screen is shown on {name}", "name" to name)
            else -> tr("This phone’s sound plays on {name}", "name" to name)
        })
        .setContentIntent(openApp(ctx))
        .setOngoing(true)
        .addAction(Notification.Action.Builder(null, tr("Stop"), action(ctx, ActionReceiver.SOUND_STOP, 13)).build())
        .build()

    // Photos removed on the computer when TwinDesk can't delete them itself (no All files access):
    // Android's own Delete confirmation, opened by tapping (it can't open from the background).
    fun mediaDelete(ctx: Context, name: String, count: Int, confirm: PendingIntent) {
        val what = if (count == 1) tr("1 photo or video") else tr("{count} photos and videos", "count" to count)
        runCatching {
            nm(ctx).createNotificationChannel(NotificationChannel(CH_ASK, tr("Requests from your computer"), NotificationManager.IMPORTANCE_HIGH).apply {
                description = tr("Access requested by your computer (Calls, Messages, Photos)")
            })
            nm(ctx).notify(ID_MEDIA_DEL, Notification.Builder(ctx, CH_ASK)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Remove {what}?", "what" to what))
                .setContentText(tr("{name} asks to remove them from this phone. Tap to confirm.", "name" to name))
                .setContentIntent(confirm)
                .setAutoCancel(true)
                .build())
        }
    }

    // The computer's Allow for Calls, Messages or Photos, when the prompt can't open by itself
    // (no "Display over other apps"): tap for Android's prompt. Its channel is made the first time.
    fun hubAsk(ctx: Context, what: String, name: String) {
        val open = PendingIntent.getActivity(ctx, 11, Intent(ctx, PermActivity::class.java).putExtra("what", what).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = tr("{name} asks to use {feature} from this phone. Tap to allow it.", "name" to name, "feature" to Hub.label(what))
        runCatching {
            nm(ctx).createNotificationChannel(NotificationChannel(CH_ASK, tr("Requests from your computer"), NotificationManager.IMPORTANCE_HIGH).apply {
                description = tr("Access requested by your computer (Calls, Messages, Photos)")
            })
            nm(ctx).notify(ID_HUB_ASK, Notification.Builder(ctx, CH_ASK)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Allow {feature} for {name}", "feature" to Hub.label(what), "name" to name))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build())
        }
    }

    // The computer rang this phone (Overview › Ring there): Stop here, or swipe it away.
    fun ringing(ctx: Context, name: String) = runCatching {
        val stop = action(ctx, ActionReceiver.RING_STOP, 15)
        val open = PendingIntent.getActivity(ctx, 15, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        nm(ctx).notify(ID_RING, Notification.Builder(ctx, CH_INVITE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(tr("Ringing"))
            .setContentText(if (name.isNotEmpty()) tr("{name} is ringing this phone", "name" to name) else tr("Your computer is ringing this phone"))
            .setCategory(Notification.CATEGORY_ALARM)
            .setContentIntent(open)
            .setDeleteIntent(stop)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, tr("Stop"), stop).build())
            .build())
    }.let { }

    fun cancelRinging(ctx: Context) = runCatching { nm(ctx).cancel(ID_RING) }.let { }

    fun cancelHubAsk(ctx: Context) = runCatching { nm(ctx).cancel(ID_HUB_ASK) }.let { }

    // An update downloaded and handed to Android, which wants the person's OK: tap to confirm it.
    fun updateReady(ctx: Context, confirm: Intent, latest: String) = runCatching {
        val open = PendingIntent.getActivity(ctx, 52, confirm, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        nm(ctx).notify(
            ID_UPDATE,
            Notification.Builder(ctx, CH_UPDATES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("TwinDesk {latest} is ready to install", "latest" to latest))
                .setContentText(tr("Tap to update. Your settings and permissions stay."))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build(),
        )
    }.let { }

    // A new release on GitHub (Updates): tap to update in place (About opens and the update starts),
    // or to download it in the browser when the release has no APK for this build.
    fun update(ctx: Context, latest: String, current: String) {
        val inPlace = Core.get(ctx).updates.download != null
        val tap = if (inPlace) Intent(ctx, MainActivity::class.java).putExtra("tab", "About").putExtra("update", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            else Intent(Intent.ACTION_VIEW, Uri.parse(Core.get(ctx).updates.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val open = PendingIntent.getActivity(ctx, 50, tap, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        nm(ctx).notify(
            ID_UPDATE,
            Notification.Builder(ctx, CH_UPDATES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("TwinDesk {latest} is available", "latest" to latest))
                .setContentText(if (inPlace) tr("You have {current}. Tap to update.", "current" to current) else tr("You have {current}. Tap to download the new version.", "current" to current))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build(),
        )
    }

    // Wireless debugging went off while connected (MIUI / HyperOS do that): tap to turn it on.
    fun adbOff(ctx: Context, computer: String) {
        val open = PendingIntent.getActivity(
            ctx, 30, Intent(ctx, AdbActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        nm(ctx).notify(
            ID_ADB,
            Notification.Builder(ctx, CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Wireless debugging is off"))
                .setContentText(tr("{computer} needs it for this screen, its mouse and keyboard here, and sound. Tap, then turn on USB debugging and Wireless debugging (both).", "computer" to computer))
                .setStyle(Notification.BigTextStyle().bigText(tr("{computer} needs it for this screen, its mouse and keyboard here, and sound. Tap, then turn on USB debugging and Wireless debugging (both).", "computer" to computer)))
                .setContentIntent(open)
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
                .build(),
        )
    }

    fun cancelAdbOff(ctx: Context) = nm(ctx).cancel(ID_ADB)

    // The pairing code box: type the code from "Pair device with pairing code" right here, so
    // Settings' dialog stays open (it closes when you switch apps).
    fun pairCode(ctx: Context, computer: String) {
        val input = android.app.RemoteInput.Builder("code").setLabel(tr("6-digit pairing code")).build()
        val pi = PendingIntent.getBroadcast(
            ctx, 40, Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.PAIR_CODE),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        nm(ctx).notify(
            ID_PAIR,
            Notification.Builder(ctx, CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Enter the pairing code"))
                .setContentText(tr("Enter the 6-digit code shown in Settings to pair with {computer}.", "computer" to computer))
                .setStyle(Notification.BigTextStyle().bigText(tr("Settings shows a 6-digit code under “Pair with device”. Tap Enter code, type it and send. {computer} completes the pairing.", "computer" to computer)))
                .setOnlyAlertOnce(false)
                .addAction(Notification.Action.Builder(null, tr("Enter code"), pi).addRemoteInput(input).build())
                .build(),
        )
    }

    fun pairResult(ctx: Context, title: String, text: String, again: Boolean, progress: Boolean = false) {
        val b = Notification.Builder(ctx, CH_INVITE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setAutoCancel(!progress)
        if (progress) b.setProgress(0, 0, true).setOngoing(true)
        if (again) {
            val input = android.app.RemoteInput.Builder("code").setLabel(tr("6-digit pairing code")).build()
            val pi = PendingIntent.getBroadcast(
                ctx, 40, Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.PAIR_CODE),
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            b.addAction(Notification.Action.Builder(null, tr("Enter code"), pi).addRemoteInput(input).build())
        }
        nm(ctx).notify(ID_PAIR, b.build())
    }

    // Files on their way (progress) and when they are here (open / show).
    // up: going to the computer (the upload arrow).
    fun files(ctx: Context, key: Int, title: String, text: String, progress: Int?, open: Intent?, up: Boolean = false, cancel: String? = null) {
        val b = Notification.Builder(ctx, CH_FILES)
            .setSmallIcon(if (up) (if (progress != null) android.R.drawable.stat_sys_upload else android.R.drawable.stat_sys_upload_done)
                else if (progress != null) android.R.drawable.stat_sys_download else android.R.drawable.stat_sys_download_done)
            .setContentTitle(title)
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(progress != null)
            .setAutoCancel(progress == null)
        if (progress != null) b.setProgress(100, progress, progress < 0)
        // cancel: the batch id; Cancel stops it on both ends (Files.cancel)
        if (progress != null && cancel != null) b.addAction(Notification.Action.Builder(null, tr("Cancel"), action(ctx, ActionReceiver.FILES_CANCEL, 0x10000 + key, cancel)).build())
        if (open != null) b.setContentIntent(PendingIntent.getActivity(ctx, key, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        nm(ctx).notify(ID_FILES_BASE + key, b.build())
    }

    fun cancelFiles(ctx: Context, key: Int) = nm(ctx).cancel(ID_FILES_BASE + key)

    // The computer copied files with its shortcut: copy them here, or save them.
    fun fclipOffer(ctx: Context, from: String, what: String, id: String) {
        nm(ctx).notify(
            ID_FCLIP,
            Notification.Builder(ctx, CH_CLIP)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Copied on {from}", "from" to from))
                .setContentText(what)
                .setContentIntent(openApp(ctx))
                .setTimeoutAfter(10 * 60 * 1000L)
                .addAction(Notification.Action.Builder(null, tr("Copy to clipboard"), action(ctx, ActionReceiver.FCLIP_COPY, 21, id)).build())
                .addAction(Notification.Action.Builder(null, tr("Save to Downloads"), action(ctx, ActionReceiver.FCLIP_SAVE, 22, id)).build())
                .build(),
        )
    }

    // Files are on the clipboard: paste them anywhere, or share them.
    fun fclipReady(ctx: Context, title: String, text: String, share: Intent?) {
        val b = Notification.Builder(ctx, CH_CLIP)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(5 * 60 * 1000L)
            .setAutoCancel(true)
        if (share != null) {
            val pi = PendingIntent.getActivity(ctx, 23, Intent.createChooser(share, tr("Share")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            b.addAction(Notification.Action.Builder(null, tr("Share…"), pi).build())
            b.setContentIntent(pi)
        }
        nm(ctx).notify(ID_FCLIP, b.build())
    }

    fun fclipProgress(ctx: Context, title: String, progress: Int) {
        nm(ctx).notify(
            ID_FCLIP,
            Notification.Builder(ctx, CH_CLIP)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(title)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setProgress(100, progress, progress < 0)
                .build(),
        )
    }

    fun cancelFclip(ctx: Context) = nm(ctx).cancel(ID_FCLIP)

    // Connect with Android (Peer.kt): another phone wants something; tapping opens TwinDesk (or `open`).
    fun peer(ctx: Context, title: String, text: String, open: PendingIntent? = null) = runCatching {
        nm(ctx).notify(ID_PEER, Notification.Builder(ctx, CH_INVITE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open ?: openApp(ctx))
            .setAutoCancel(true)
            .build())
    }.let { }

    fun cancelPeer(ctx: Context) = runCatching { nm(ctx).cancel(ID_PEER) }.let { }

    // icon: the app's (from the computer), else TwinDesk's own shows.
    fun fromComputer(ctx: Context, key: String, app: String, title: String, body: String, computer: String, icon: android.graphics.Bitmap? = null) {
        nm(ctx).notify(
            ID_COMPUTER_BASE + (key.hashCode() and 0xffff),
            Notification.Builder(ctx, CH_COMPUTER)
                .setSmallIcon(R.drawable.ic_stat)
                .setLargeIcon(icon)
                .setSubText("$app · $computer")
                .setContentTitle(title.ifEmpty { app })
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .build(),
        )
    }

    // ReZume (Rezume.kt): the computer's tab or document, to go on with here. Constant (like Handoff's
    // icon, it stays while the computer offers it), quiet, replaced by the next, gone when the computer
    // offers nothing; Open and Dismiss. loud: sent on purpose (Send to on the computer). Its channel is made the first time.
    fun rezume(ctx: Context, computer: String, o: Rezume.Offer, loud: Boolean) {
        val n = nm(ctx)
        if (n.getNotificationChannel(CH_REZUME) == null) {
            runCatching { n.deleteNotificationChannel("rezume") } // the first one, silent: it went under the computer's notifications
            n.createNotificationChannel(NotificationChannel(CH_REZUME, "ReZume", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = tr("Continue what you were doing on your computer")
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            })
        }
        if (loud && n.getNotificationChannel(CH_REZUME_SENT) == null) n.createNotificationChannel(NotificationChannel(CH_REZUME_SENT, tr("ReZume: sent to this phone"), NotificationManager.IMPORTANCE_HIGH).apply {
            description = tr("A page or document sent from your computer")
        })
        val tap = PendingIntent.getActivity(ctx, ID_REZUME, Intent(ctx, RezumeActivity::class.java).putExtra("id", o.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val what = if (o.kind == "web") (Uri.parse(o.url).host ?: o.url) else o.name
        n.notify(ID_REZUME, Notification.Builder(ctx, if (loud) CH_REZUME_SENT else CH_REZUME)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(tr("Continue from {computer}", "computer" to computer))
            .setContentText(o.title + if (what != o.title) " · $what" else "")
            .setSubText(o.appName.ifEmpty { null })
            .setContentIntent(tap)
            .setOngoing(true)
            .setAutoCancel(false)
            .setGroup("rezume") // its own card, never bundled with the computer's notifications
            .setOnlyAlertOnce(!loud)
            .addAction(Notification.Action.Builder(null, tr("Open"), tap).build())
            .addAction(Notification.Action.Builder(null, tr("Dismiss"), action(ctx, ActionReceiver.REZUME_DISMISS, ID_REZUME)).build())
            .build())
    }

    fun cancelRezume(ctx: Context) = runCatching { nm(ctx).cancel(ID_REZUME) }.let { }

    fun rezumeReady(ctx: Context, name: String, view: Intent) {
        nm(ctx).notify(ID_REZUME_READY, Notification.Builder(ctx, CH_FILES)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(name)
            .setContentText(tr("From your computer. Tap to open."))
            .setContentIntent(PendingIntent.getActivity(ctx, ID_REZUME_READY, view, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAutoCancel(true)
            .build())
    }

    fun viewIntent(uri: Uri, mime: String?): Intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime ?: "*/*")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
}
