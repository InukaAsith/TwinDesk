// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Android components around Core: the foreground service that keeps it running, the
// notification listener, notification buttons, start at boot, and the Quick Settings tile.
package com.twindesk.android

import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.service.quicksettings.TileService
import android.util.Log

class TwinService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val core = Core.get(this)
        try {
            startForeground(Notify.ID_LINK, Notify.link(this, core), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } catch (e: Exception) {
            RemoteLog.w("TwinDesk", "foreground service: ${e.message}")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    companion object {
        fun start(ctx: Context) {
            runCatching { ctx.startForegroundService(Intent(ctx, TwinService::class.java)) }
                .onFailure { RemoteLog.w("TwinDesk", "start service: ${it.message}") }
        }

        // The ongoing notification follows the link.
        private var lastKey = ""
        fun refresh(ctx: Context) {
            val core = Core.get(ctx)
            val key = listOf(core.host?.name, core.link.state, core.adb.wifiDebugging, core.files.activeLine(), core.hosts().firstOrNull { core.isNear(it.id) }?.id).toString()
            if (key == lastKey) return
            lastKey = key
            ctx.getSystemService(NotificationManager::class.java).notify(Notify.ID_LINK, Notify.link(ctx, core))
        }
    }
}

class NotifListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        runCatching { Core.get(this).notifs.posted(sbn) }
    }
}

class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val core = Core.get(ctx)
        val arg = intent.getStringExtra("arg") ?: ""
        when (intent.action) {
            DISCONNECT -> core.disconnect()
            EXIT -> exit(ctx, core)
            CONNECT -> core.hosts().find { it.id == arg }?.let { core.connect(it) }
            SEND_CLIP -> ctx.startActivity(Intent(ctx, ClipActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            FCLIP_COPY -> core.fclip.fetch(arg, save = false)
            FCLIP_SAVE -> core.fclip.fetch(arg, save = true)
            ADB_ON -> core.adb.turnOn()
            SOUND_STOP -> core.sound.stop()
            PAIR_CODE -> {
                val code = android.app.RemoteInput.getResultsFromIntent(intent)?.getCharSequence("code")?.toString() ?: ""
                core.adb.sendPairCode(code)
            }
        }
    }

    // Exit: disconnect (so the computer hears it), stop the service and its notification, and end
    // the process, so nothing reconnects or comes back until TwinDesk is opened again (or the phone
    // restarts: BootReceiver).
    private fun exit(ctx: Context, core: Core) {
        core.disconnect()
        ctx.stopService(Intent(ctx, TwinService::class.java))
        ctx.getSystemService(NotificationManager::class.java).cancelAll()
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ android.os.Process.killProcess(android.os.Process.myPid()) }, 600)
    }

    companion object {
        const val DISCONNECT = "com.twindesk.android.DISCONNECT"
        const val CONNECT = "com.twindesk.android.CONNECT"
        const val SEND_CLIP = "com.twindesk.android.SEND_CLIP"
        const val FCLIP_COPY = "com.twindesk.android.FCLIP_COPY"
        const val FCLIP_SAVE = "com.twindesk.android.FCLIP_SAVE"
        const val ADB_ON = "com.twindesk.android.ADB_ON"
        const val PAIR_CODE = "com.twindesk.android.PAIR_CODE"
        const val EXIT = "com.twindesk.android.EXIT"
        const val SOUND_STOP = "com.twindesk.android.SOUND_STOP"
    }
}

// A computer found this device on a USB cable and set up adb reverse to its port: connect through
// it. Only adb's shell can send this (the receiver requires DUMP, which apps don't get).
class WiredReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getStringExtra("host") ?: return
        val port = intent.getIntExtra("port", 0)
        if (port <= 0 || port > 65535) return
        runCatching { TwinService.start(ctx) }
        Core.get(ctx).connectWired(id, port, intent.getStringExtra("nonce") ?: "", intent.getStringExtra("name")?.take(64) ?: "")
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) TwinService.start(ctx)
    }
}

// Quick Settings: wireless debugging on/off in one tap (the Mac's screen, input and sound use it).
// Switches it directly once the Mac granted the permission; until then it opens the setting.
class AdbTile : TileService() {
    override fun onStartListening() {
        val core = Core.get(this)
        qsTile?.apply {
            state = if (core.adb.wifiDebugging) android.service.quicksettings.Tile.STATE_ACTIVE else android.service.quicksettings.Tile.STATE_INACTIVE
            subtitle = if (core.adb.canEnable) null else "Tap to set up"
            updateTile()
        }
    }

    override fun onClick() {
        val core = Core.get(this)
        if (core.adb.canEnable) {
            core.adb.enable(!core.adb.wifiDebugging)
            core.adb.sendState()
            onStartListening()
            return
        }
        val i = Intent(android.provider.Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
            .putExtra(":settings:fragment_args_key", "toggle_adb_wireless").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (android.os.Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(android.app.PendingIntent.getActivity(this, 1, i, android.app.PendingIntent.FLAG_IMMUTABLE))
        else @Suppress("DEPRECATION") startActivityAndCollapse(i)
    }
}

// Quick Settings: send this phone's clipboard to the computer (Android lets only the app in
// front read it, so the tile opens a see-through activity for a moment).
class ClipTile : TileService() {
    override fun onClick() {
        val i = Intent(this, ClipActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (android.os.Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(android.app.PendingIntent.getActivity(this, 0, i, android.app.PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(i)
        }
    }
}
