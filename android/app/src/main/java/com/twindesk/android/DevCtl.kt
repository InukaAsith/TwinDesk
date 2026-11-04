// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This phone's controls on the computer's Overview, and the computer's here (shared/devctl.js):
//   dev.state → the computer: what it can do here (ring, lock, quick settings, ringer, volume), its
//     quick settings (Wi-Fi, Bluetooth, mobile data, hotspot, torch, Do not disturb, auto-rotate,
//     battery saver: on or off, a word about each, and which only open their panel here), the media
//     volume, the ringer, and the most used apps (Usage access, granted over wireless debugging).
//     Sent at the start of each session and whenever one of them changes.
//   dev.do ← the computer: ring until stopped (the alarm sound at full volume, even on silent),
//     lock (Accessibility), a quick setting, the ringer, the volume. What Android doesn't let an app
//     switch (Wi-Fi, data, hotspot and Bluetooth on newer Android) the computer switches over
//     wireless debugging when it can (shared/devadb.js); otherwise its panel opens here.
//   dev.state ← the computer: its own (ring, lock, sleep, Bluetooth, Do not disturb, volume), for
//     the Computer page here; dev.do → the computer from that page.
package com.twindesk.android

import android.Manifest
import android.app.AppOpsManager
import android.app.NotificationManager
import android.app.usage.UsageStatsManager
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.hardware.camera2.CameraManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import android.telephony.TelephonyManager
import android.accessibilityservice.AccessibilityService
import androidx.core.content.ContextCompat
import org.json.JSONObject

class DevCtl(core: Core) : Feature(core) {
    companion object {
        const val DO = "dev.do"
        const val STATE = "dev.state"
        private const val RING_MS = 120_000L
    }

    private val ctx get() = core.ctx
    private val main = Handler(Looper.getMainLooper())
    private val sendSoon = Runnable { sendState() }
    private var watching = false
    private var torchOn = false
    private var ringtone: Ringtone? = null
    private var alarmBefore = -1
    private var last = ""

    // The computer's own controls, for the Computer page (null: it hasn't said: an older TwinDesk).
    @Volatile var computer: JSONObject? = null; private set
    var onComputer: (() -> Unit)? = null

    override fun onWelcome(host: Host) {
        computer = null
        last = ""
        watch(true)
        sendState()
        askTries = 0
        main.removeCallbacks(askAgain)
        main.postDelayed(askAgain, 1500)
    }

    // The computer's dev.state can be missed at the start (it sent before this side listened, or the
    // computer had another device selected then): without it Overview shows only the hero until a
    // page change there. Ours again, a few times, until it answers (it answers our first).
    private var askTries = 0
    private val askAgain: Runnable = object : Runnable {
        override fun run() {
            if (!core.link.connected || computer != null || askTries >= 6) return
            askTries++
            last = ""
            asking = true
            try { sendState() } finally { asking = false }
            main.postDelayed(this, 1500L * (askTries + 1))
        }
    }

    override fun onClosed() {
        main.removeCallbacks(askAgain)
        watch(false)
        ring(false)
        computer = null
        main.post { onComputer?.invoke() }
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            DO -> main.post { act(m) }
            STATE -> { computer = m; core.changed(); main.post { onComputer?.invoke() } }
            // Explorer's Capture from phone on the computer: the camera here, each photo there.
            CaptureActivity.T -> main.post {
                if (m.optBoolean("on")) runCatching { ctx.startActivity(android.content.Intent(ctx, CaptureActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
                else CaptureActivity.running?.end(tell = false)
            }
            else -> return false
        }
        return true
    }

    // The Computer page's buttons: to the computer.
    // Ring and Stop show at once (as the computer's Overview does): the computer's dev.state corrects
    // it, but one that is late or never comes (another device selected there) must not leave Ring
    // up while it rings, so Stop stays reachable.
    fun ask(cmd: String, vararg fields: Pair<String, Any?>) {
        core.send(msg(DO, "do" to cmd, *fields))
        val c = computer ?: return
        if (cmd == "ring" || cmd == "ringStop") {
            computer = JSONObject(c.toString()).put("ringing", cmd == "ring")
            core.changed()
            main.post { onComputer?.invoke() }
        }
    }

    // ---- what the computer asks ----

    private fun act(m: JSONObject) {
        runCatching {
            when (m.optString("do")) {
                "ring" -> ring(true)
                "ringStop" -> ring(false)
                "lock" -> lock()
                "qs" -> qs(m.optString("id"), m.optBoolean("on"))
                "ringer" -> ringer(m.optString("mode"))
                "volume" -> volume(m.optDouble("level", -1.0))
            }
        }
        later(250)
    }

    private val audio get() = ctx.getSystemService(AudioManager::class.java)

    // Ringing because the computer asked: Stop on the phone (its notification, or Overview here).
    val ringing get() = ringtone != null
    fun stopRing() = main.post { ring(false) }.let { }

    private fun ring(on: Boolean) {
        main.removeCallbacks(stopRing)
        val was = ringtone != null
        ringtone?.stop()
        ringtone = null
        if (was && !on) { Notify.cancelRinging(ctx); core.changed() }
        if (alarmBefore >= 0) { runCatching { audio.setStreamVolume(AudioManager.STREAM_ALARM, alarmBefore, 0) }; alarmBefore = -1 }
        if (!on) { later(0); return }
        val uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE) ?: return
        val r = RingtoneManager.getRingtone(ctx, uri) ?: return
        r.audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        if (Build.VERSION.SDK_INT >= 28) r.isLooping = true
        alarmBefore = audio.getStreamVolume(AudioManager.STREAM_ALARM)
        runCatching { audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0) }
        r.play()
        ringtone = r
        Notify.ringing(ctx, core.host?.name.orEmpty())
        core.changed()
        main.postDelayed(stopRing, RING_MS)
        later(0)
    }
    private val stopRing = Runnable { ring(false) }

    // Locks with the Accessibility service (Android 9+); the computer locks over ADB otherwise.
    private fun lock() {
        val a = InputService.running ?: return
        if (Build.VERSION.SDK_INT >= 28) a.performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN)
    }

    private fun qs(id: String, on: Boolean) {
        when (id) {
            "torch" -> torch(on)
            "dnd" -> dnd(on)
            "rotate" -> if (Settings.System.canWrite(ctx)) Settings.System.putInt(ctx.contentResolver, Settings.System.ACCELEROMETER_ROTATION, if (on) 1 else 0) else panel(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS).setData(android.net.Uri.parse("package:" + ctx.packageName)))
            "wifi" -> if (Build.VERSION.SDK_INT < 29) @Suppress("DEPRECATION") wifi()?.setWifiEnabled(on) else panel(Intent(Settings.Panel.ACTION_WIFI))
            "data" -> panel(if (Build.VERSION.SDK_INT >= 29) Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY) else Intent(Settings.ACTION_DATA_ROAMING_SETTINGS))
            "bluetooth" -> {
                val a = bt()
                @Suppress("DEPRECATION", "MissingPermission")
                val done = Build.VERSION.SDK_INT < 33 && a != null && runCatching { if (on) a.enable() else a.disable() }.getOrDefault(false)
                if (!done) panel(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
            }
            "hotspot" -> panel(Intent().setClassName("com.android.settings", "com.android.settings.TetherSettings"), Intent(Settings.ACTION_WIRELESS_SETTINGS))
            "saver" -> panel(Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS))
        }
    }

    // A setting this app can't switch: its panel on the phone (TwinDesk may start it from the
    // background with Display over other apps).
    private fun panel(vararg intents: Intent) {
        for (i in intents) if (runCatching { ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess) return
    }

    private fun torch(on: Boolean) {
        val cm = ctx.getSystemService(CameraManager::class.java) ?: return
        val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true } ?: return
        cm.setTorchMode(id, on)
    }

    // Do not disturb: the notification listener may set it (the full app), else with Do not
    // disturb access, else its settings open.
    private fun dnd(on: Boolean) {
        val f = if (on) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.isNotificationPolicyAccessGranted) { nm.setInterruptionFilter(f); return }
        val l = NotifListener.running
        if (l != null) { runCatching { l.requestInterruptionFilter(f) }.onSuccess { return } }
        panel(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
    }

    private fun ringer(mode: String) {
        val m = when (mode) { "ring" -> AudioManager.RINGER_MODE_NORMAL; "vibrate" -> AudioManager.RINGER_MODE_VIBRATE; "silent" -> AudioManager.RINGER_MODE_SILENT; else -> return }
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (m == AudioManager.RINGER_MODE_SILENT && !nm.isNotificationPolicyAccessGranted) {
            // Silent needs Do not disturb access; the listener's Do not disturb is the nearest thing.
            val l = NotifListener.running
            if (l != null) { runCatching { l.requestInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_NONE) }; return }
            panel(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
            return
        }
        runCatching { audio.ringerMode = m }
    }

    private fun volume(level: Double) {
        if (level < 0) return
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(level.coerceIn(0.0, 1.0) * max).toInt(), 0)
    }

    // ---- what the computer is told ----

    private fun wifi() = ctx.applicationContext.getSystemService(WifiManager::class.java)
    private fun bt() = ctx.getSystemService(BluetoothManager::class.java)?.adapter

    private fun granted(p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    private fun sendState() {
        if (!core.link.connected) return
        val qs = JSONObject()
        val detail = JSONObject()
        val panel = JSONObject()
        runCatching { wifi()?.let { qs.put("wifi", it.isWifiEnabled) } }
        runCatching {
            val a = bt()
            if (a != null && (Build.VERSION.SDK_INT < 31 || granted(Manifest.permission.BLUETOOTH_CONNECT))) qs.put("bluetooth", a.isEnabled)
        }
        runCatching {
            val tm = ctx.getSystemService(TelephonyManager::class.java)
            if (tm != null && tm.phoneType != TelephonyManager.PHONE_TYPE_NONE) {
                qs.put("data", Settings.Global.getInt(ctx.contentResolver, "mobile_data", 0) == 1)
                tm.networkOperatorName?.takeIf { it.isNotBlank() }?.let { detail.put("data", it.take(30)) }
            }
        }
        runCatching {
            val w = wifi()
            val m = w?.javaClass?.getMethod("isWifiApEnabled")
            if (m != null) qs.put("hotspot", m.invoke(w) == true)
        }
        if (ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)) qs.put("torch", torchOn)
        runCatching { qs.put("dnd", ctx.getSystemService(NotificationManager::class.java).currentInterruptionFilter > NotificationManager.INTERRUPTION_FILTER_ALL) }
        runCatching { qs.put("rotate", Settings.System.getInt(ctx.contentResolver, Settings.System.ACCELEROMETER_ROTATION, 0) == 1) }
        runCatching { qs.put("saver", ctx.getSystemService(PowerManager::class.java).isPowerSaveMode) }
        if (Build.VERSION.SDK_INT >= 29) { panel.put("wifi", true); panel.put("data", true); panel.put("hotspot", true) } else { panel.put("data", true); panel.put("hotspot", true) }
        if (Build.VERSION.SDK_INT >= 33) panel.put("bluetooth", true)
        panel.put("saver", true)
        if (!Settings.System.canWrite(ctx)) panel.put("rotate", true)
        qs.put("detail", detail).put("panel", panel)
        runCatching {
            val a = audio
            qs.put("volume", a.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / a.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1))
            qs.put("ringer", when (a.ringerMode) { AudioManager.RINGER_MODE_SILENT -> "silent"; AudioManager.RINGER_MODE_VIBRATE -> "vibrate"; else -> "ring" })
        }
        val can = JSONObject().put("ring", true).put("qs", true).put("ringer", true).put("volume", true)
        if (InputService.running != null && Build.VERSION.SDK_INT >= 28) can.put("lock", true)
        val m = msg(STATE, "can" to can, "ringing" to (ringtone != null), "qs" to qs, "info" to info())
        m.put("app", JSONObject().put("v", BuildConfig.VERSION_NAME)) // which TwinDesk (shared/appinfo.js): the computer warns when it's older
        top()?.let { m.put("top", jsonArray(it)) }
        val k = m.toString()
        if (k == last) return
        last = k
        if (asking) m.put("ask", true) // the computer answers with its own (shared/devctl.js)
        core.send(m)
    }
    private var asking = false

    // For the computer's Overview card: storage, the network, the signal.
    private fun info(): JSONObject {
        val o = JSONObject()
        runCatching {
            val st = android.os.StatFs(android.os.Environment.getDataDirectory().path)
            val gb = 1_000_000_000.0
            val total = st.totalBytes / gb
            o.put("storageTotal", Math.round(total)).put("storageUsed", Math.round(total - st.availableBytes / gb))
        }
        runCatching {
            val cm = ctx.getSystemService(android.net.ConnectivityManager::class.java)
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            if (caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) == true) {
                @Suppress("DEPRECATION")
                val ssid = wifi()?.connectionInfo?.ssid?.trim('"')?.takeIf { it.isNotBlank() && it != "<unknown ssid>" }
                o.put("wifi", ssid ?: "Wi-Fi")
            }
        }
        runCatching {
            val tm = ctx.getSystemService(TelephonyManager::class.java)
            if (tm != null && tm.phoneType != TelephonyManager.PHONE_TYPE_NONE) {
                val gen = if (granted(Manifest.permission.READ_PHONE_STATE)) @Suppress("DEPRECATION") when (tm.dataNetworkType) {
                    TelephonyManager.NETWORK_TYPE_NR -> "5G"
                    TelephonyManager.NETWORK_TYPE_LTE -> "4G"
                    TelephonyManager.NETWORK_TYPE_HSPAP, TelephonyManager.NETWORK_TYPE_HSPA, TelephonyManager.NETWORK_TYPE_UMTS, TelephonyManager.NETWORK_TYPE_HSDPA, TelephonyManager.NETWORK_TYPE_HSUPA -> "3G"
                    TelephonyManager.NETWORK_TYPE_EDGE, TelephonyManager.NETWORK_TYPE_GPRS -> "2G"
                    else -> ""
                } else ""
                o.put("cell", listOf(tm.networkOperatorName.orEmpty(), gen).filter { it.isNotBlank() }.joinToString(" · "))
                if (Build.VERSION.SDK_INT >= 28) tm.signalStrength?.level?.let { o.put("signal", listOf("None", "Weak", "Fair", "Good", "Excellent")[it.coerceIn(0, 4)]) }
            }
        }
        return o
    }

    // The most used apps of the last week, with Usage access (wireless debugging grants it).
    private fun top(): List<String>? {
        val ops = ctx.getSystemService(AppOpsManager::class.java)
        @Suppress("DEPRECATION")
        val mode = runCatching { ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName) }.getOrDefault(AppOpsManager.MODE_IGNORED)
        if (mode != AppOpsManager.MODE_ALLOWED) return null
        val usm = ctx.getSystemService(UsageStatsManager::class.java) ?: return null
        val now = System.currentTimeMillis()
        val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - 7 * 86_400_000L, now) ?: return null
        val pm = ctx.packageManager
        return stats.groupBy { it.packageName }.mapValues { (_, v) -> v.sumOf { it.totalTimeInForeground } }
            .filter { (p, t) -> t > 60_000 && p != ctx.packageName && pm.getLaunchIntentForPackage(p) != null }
            .entries.sortedByDescending { it.value }.take(8).map { it.key }
    }

    private fun later(ms: Long) {
        main.removeCallbacks(sendSoon)
        main.postDelayed(sendSoon, ms + 150)
    }

    // ---- watching for changes while connected ----

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) = later(300)
    }
    private val observer = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) = later(300)
    }
    private val torchCb = object : CameraManager.TorchCallback() {
        override fun onTorchModeChanged(cameraId: String, enabled: Boolean) { torchOn = enabled; later(100) }
    }
    private val poll = object : Runnable {
        override fun run() { later(0); main.postDelayed(this, 60_000) } // volume and the most used apps
    }

    private fun watch(on: Boolean) = main.post {
        if (on == watching) return@post
        watching = on
        val cm = ctx.getSystemService(CameraManager::class.java)
        if (on) {
            val f = IntentFilter().apply {
                addAction(WifiManager.WIFI_STATE_CHANGED_ACTION)
                addAction("android.net.wifi.WIFI_AP_STATE_CHANGED")
                addAction("android.bluetooth.adapter.action.STATE_CHANGED")
                addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
                addAction(AudioManager.RINGER_MODE_CHANGED_ACTION)
                addAction("android.media.VOLUME_CHANGED_ACTION")
                addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED)
            }
            ContextCompat.registerReceiver(ctx, receiver, f, ContextCompat.RECEIVER_EXPORTED)
            ctx.contentResolver.registerContentObserver(Settings.System.getUriFor(Settings.System.ACCELEROMETER_ROTATION), false, observer)
            ctx.contentResolver.registerContentObserver(Settings.Global.getUriFor("mobile_data"), true, observer)
            runCatching { cm?.registerTorchCallback(torchCb, main) }
            main.postDelayed(poll, 60_000)
        } else {
            runCatching { ctx.unregisterReceiver(receiver) }
            runCatching { ctx.contentResolver.unregisterContentObserver(observer) }
            runCatching { cm?.unregisterTorchCallback(torchCb) }
            main.removeCallbacks(poll)
            main.removeCallbacks(sendSoon)
        }
    }
}
