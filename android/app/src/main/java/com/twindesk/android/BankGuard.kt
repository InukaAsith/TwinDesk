// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Banking apps (General › Banking apps): many refuse to run while USB or wireless debugging,
// Developer options or an Accessibility service is on. When one of them comes to the front,
// TwinDesk switches those off (with WRITE_SECURE_SETTINGS, granted over wireless debugging) and
// exits, so the bank's app opens as on any phone. Opening TwinDesk again turns back on what was on
// (Turn back on when TwinDesk opens).
//   Which apps: the ones that look like a bank's (their name or package: bank, banking, wallet, UPI…)
//   unless switched off, and any the person switches on.
//   Seeing one open: the Accessibility service's window changes (Input.kt), at once; without it,
//   Usage access (granted over wireless debugging), checked every 1.5 s while the screen is on and
//   something it would switch off is on. Nothing runs while it's off or there's nothing to do.
// Back on by itself (Turn back on after the banking app, with Usage access): an alarm looks every
// few minutes whether the banking app is still in front, and once it isn't, what was switched off
// comes back (TwinDesk stays closed until it's opened). The notification has Turn back on too.
// Open with banking pause: a home screen shortcut for one banking app (BankLaunchActivity) that
// switches everything off first and then opens it, so the app never sees debugging on.
package com.twindesk.android

import android.app.AppOpsManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import org.json.JSONObject

class BankGuard(private val core: Core) {
    companion object {
        private const val POLL_MS = 1500L
        private const val CH = "bank"
        private const val ID = 19
        private const val BACK_MS = 3 * 60_000L // how often the alarm looks whether the banking app left
        private const val BACK_FOR_MS = 4 * 3600_000L // and for how long, at most
        // Words in an app's name or package that mean money: a bank, a wallet, a payments app. These
        // count anywhere ("MobileBanking", "com.x.sparkasse"); the rest only as words of their own.
        private val ANYWHERE = Regex("bank|banque|banco|bancaria|banca|sparkasse|wallet|finanz|finance|paytm|phonepe|paypal|revolut|binance|coinbase|wellsfargo|bankofamerica|americanexpress|capitalone|commbank", RegexOption.IGNORE_CASE)
        private val WORDS = Regex(
            "volksbank|raiffeisen|credit ?union|kredit|upi|bhim|gpay|venmo|monzo|wise|n26|chase|barclays|hsbc|santander|citi|amex|bofa|lloyds|natwest|halifax|ing|bbva|bnp|" +
                "sampath|hnb|ntb|nationstrust|combank|boc|ndb|seylan|dfcc|frimi|genie|sbi|yono|icici|hdfc|axis|kotak|idfc|pnb|canara|maybank|dbs|ocbc|uob|anz|westpac|nab",
            RegexOption.IGNORE_CASE,
        )
        // Not banks, though their names say so.
        private val NOT = Regex("word ?bank|power ?bank|food ?bank|question ?bank|sound ?bank|blood ?bank|bankai|memory ?bank", RegexOption.IGNORE_CASE)

        fun looksLikeBank(pkg: String, label: String): Boolean {
            val words = "$pkg $label"
            if (NOT.containsMatchIn(words)) return false
            if (ANYWHERE.containsMatchIn(words)) return true
            return WORDS.findAll(words).any { m ->
                val before = words.getOrNull(m.range.first - 1)
                val after = words.getOrNull(m.range.last + 1)
                (before == null || !before.isLetter()) && (after == null || !after.isLetter())
            }
        }
    }

    private val ctx get() = core.ctx
    private val cr get() = ctx.contentResolver
    private val main = Handler(Looper.getMainLooper())
    private var polling = false
    @Volatile private var tripped = false

    // ---- settings ----

    val on: Boolean get() = core.store.flag("bank.on", true)
    fun setOn(v: Boolean) { core.store.setFlag("bank.on", v); core.changed(); check() }
    // Developer options off too (most banks check it, not only debugging).
    val devOff: Boolean get() = core.store.flag("bank.devOff", true)
    fun setDevOff(v: Boolean) { core.store.setFlag("bank.devOff", v); core.changed() }
    val restoreOn: Boolean get() = core.store.flag("bank.restore", true)
    fun setRestore(v: Boolean) { core.store.setFlag("bank.restore", v); core.changed() }
    // Turn back on by itself once the banking app is left (needs Usage access to see that).
    val autoBack: Boolean get() = core.store.flag("bank.autoBack", true)
    fun setAutoBack(v: Boolean) { core.store.setFlag("bank.autoBack", v); core.changed() }
    // The last time it happened, for the page: "Sampath Bank · 10:42".
    val last: String get() = core.store.prefsString("bank.last", "")

    private val added get() = core.store.prefsSet("bank.add") // switched on by the person
    private val skipped get() = core.store.prefsSet("bank.skip") // looked like a bank's, switched off

    fun auto(pkg: String) = looksLikeBank(pkg, core.appList.label(pkg))
    fun isBank(pkg: String) = pkg in added || (pkg !in skipped && auto(pkg))
    fun setBank(pkg: String, v: Boolean) {
        val a = auto(pkg)
        core.store.setPrefsSet("bank.add", if (v && !a) added + pkg else added - pkg)
        core.store.setPrefsSet("bank.skip", if (!v && a) skipped + pkg else skipped - pkg)
        core.changed()
    }
    // The apps it watches now, for the page's count.
    fun banks(): List<AppList.App> = core.appList.get().filter { isBank(it.pkg) }

    // A new app: nothing to remember (it's judged by its name each time); the page redraws.
    fun installed(@Suppress("UNUSED_PARAMETER") pkg: String) = core.changed()

    // ---- what it would switch off ----

    private fun global(k: String) = runCatching { Settings.Global.getInt(cr, k, 0) == 1 }.getOrDefault(false)
    private val a11yFlat get() = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
    private val me get() = ComponentName(ctx, InputService::class.java)
    private fun a11yOurs(flat: String) = flat.split(':').any { it.equals(me.flattenToString(), true) || it.equals(me.flattenToShortString(), true) }

    // Something a bank's app minds is on (only then is there anything to do).
    private val exposed: Boolean get() = global(Settings.Global.ADB_ENABLED) || global("adb_wifi_enabled") ||
        (devOff && global(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED)) || InputService.running != null

    val usageAccess: Boolean get() = runCatching {
        @Suppress("DEPRECATION")
        ctx.getSystemService(AppOpsManager::class.java).checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName) == AppOpsManager.MODE_ALLOWED
    }.getOrDefault(false)

    // How it sees a bank's app open, for the page.
    val how: String get() = when {
        InputService.running != null -> "accessibility"
        usageAccess -> "usage"
        else -> ""
    }

    // ---- watching ----

    // Core.start: watch the screen going on and off; turn back on what was on before (we're open again).
    fun start() {
        runCatching { startRestore() }
        val f = IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF) }
        ctx.registerReceiver(object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) = check()
        }, f)
        check()
    }

    // The Accessibility service saw this app come to the front.
    fun front(pkg: String) {
        if (on && !tripped && pkg != ctx.packageName && isBank(pkg)) main.post { trip(pkg) }
    }

    // Poll Usage access while it could matter: on, no Accessibility service (that one tells us at
    // once), the screen on, something exposed. Checked again on the screen's changes and settings.
    fun check() {
        main.post {
            val interactive = ctx.getSystemService(PowerManager::class.java)?.isInteractive != false
            val want = on && InputService.running == null && interactive && usageAccess && exposed
            if (want && !polling) { polling = true; main.postDelayed(poll, POLL_MS) }
            else if (!want && polling) { polling = false; main.removeCallbacks(poll) }
        }
    }

    // Core.changed (often, during a transfer): once, half a second after the last.
    private val checkNow = Runnable { check() }
    fun checkSoon() { main.removeCallbacks(checkNow); main.postDelayed(checkNow, 500) }

    private var lastPoll = 0L
    private val poll: Runnable = object : Runnable {
        override fun run() {
            if (!polling) return
            val now = System.currentTimeMillis()
            val from = if (lastPoll == 0L) now - 3000 else lastPoll - 200
            lastPoll = now
            frontSince(from)?.let { front(it) }
            if (!(on && InputService.running == null && exposed)) { polling = false; return }
            main.postDelayed(this, POLL_MS)
        }
    }

    // The last app that came to the front since `from` (null: none did).
    private fun frontSince(from: Long): String? = runCatching {
        val usm = ctx.getSystemService(UsageStatsManager::class.java) ?: return null
        val ev = usm.queryEvents(from, System.currentTimeMillis())
        val e = UsageEvents.Event()
        var pkg: String? = null
        while (ev.hasNextEvent()) {
            ev.getNextEvent(e)
            @Suppress("DEPRECATION")
            if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED || e.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND) pkg = e.packageName
        }
        pkg
    }.getOrNull()

    // ---- switching off, and back on ----

    private fun trip(pkg: String) {
        if (tripped || !exposed) return
        val (label, switched) = switchOff(pkg)
        exitTwinDesk(ctx, core)
        notice(label, switched) // after Exit's cancelAll: this one stays
    }

    // Open with banking pause (BankLaunchActivity): off first, then the app, then TwinDesk closes.
    fun openPaused(pkg: String) {
        val launch = ctx.packageManager.getLaunchIntentForPackage(pkg)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) ?: return
        val (label, switched) = if (exposed) switchOff(pkg) else core.appList.label(pkg) to false
        runCatching { ctx.startActivity(launch) }
        exitTwinDesk(ctx, core)
        if (switched) notice(label, true)
    }

    // A home screen shortcut that opens this app with banking pause.
    fun pinShortcut(pkg: String): Boolean = runCatching {
        val label = core.appList.label(pkg)
        val icon = runCatching { ctx.packageManager.getApplicationIcon(pkg) }.getOrNull()
        val bmp = icon?.let { d ->
            val b = android.graphics.Bitmap.createBitmap(192, 192, android.graphics.Bitmap.Config.ARGB_8888)
            d.setBounds(0, 0, 192, 192); d.draw(android.graphics.Canvas(b)); b
        }
        val s = androidx.core.content.pm.ShortcutInfoCompat.Builder(ctx, "bank-$pkg")
            .setShortLabel(label)
            .setLongLabel(tr("{app} with banking pause", "app" to label))
            .setIcon(if (bmp != null) androidx.core.graphics.drawable.IconCompat.createWithBitmap(bmp) else androidx.core.graphics.drawable.IconCompat.createWithResource(ctx, R.mipmap.ic_launcher))
            .setIntent(Intent(ctx, BankLaunchActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra("pkg", pkg))
            .build()
        androidx.core.content.pm.ShortcutManagerCompat.requestPinShortcut(ctx, s, null)
    }.getOrDefault(false)

    // Switch off what a bank's app minds; remembers what was on. Returns (its label, switched).
    private fun switchOff(pkg: String): Pair<String, Boolean> {
        tripped = true
        val label = core.appList.label(pkg)
        // What was on, to turn back on later (kept if we already saved one: the first is the true one).
        if (core.store.prefsString("bank.was", "").isEmpty()) {
            core.store.setPrefsString(
                "bank.was",
                JSONObject().put("dev", global(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED)).put("adb", global(Settings.Global.ADB_ENABLED))
                    .put("wifi", global("adb_wifi_enabled")).put("a11y", a11yOurs(a11yFlat)).toString(),
            )
        }
        var switched = core.adb.canEnable && runCatching {
            Settings.Global.putInt(cr, "adb_wifi_enabled", 0)
            Settings.Global.putInt(cr, Settings.Global.ADB_ENABLED, 0)
            if (devOff) Settings.Global.putInt(cr, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0)
        }.isSuccess
        // Our Accessibility service: off from the settings (so it can come back), else by itself.
        if (InputService.running != null || a11yOurs(a11yFlat)) {
            val off = core.adb.canEnable && runCatching {
                val rest = a11yFlat.split(':').filter { it.isNotEmpty() && !a11yOurs(it) }.joinToString(":")
                Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, rest)
            }.isSuccess
            if (!off) runCatching { InputService.running?.disableSelf() }
        }
        if (!core.adb.canEnable) switched = false
        val time = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date())
        core.store.setPrefsString("bank.last", "$label · $time")
        core.store.setPrefsString("bank.app", pkg)
        core.store.setPrefsString("bank.since", System.currentTimeMillis().toString())
        if (switched && autoBack && usageAccess && restoreOn) later()
        return label to switched
    }

    // ---- back on by itself ----

    private fun alarm(): PendingIntent = PendingIntent.getBroadcast(ctx, 0x6261, Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.BANK_CHECK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    // Inexact and not waking the phone: with the screen off nobody is in the banking app.
    private fun later() = runCatching {
        ctx.getSystemService(android.app.AlarmManager::class.java).set(android.app.AlarmManager.ELAPSED_REALTIME, android.os.SystemClock.elapsedRealtime() + BACK_MS, alarm())
    }

    // The alarm: the banking app still in front (or the screen off): look again later; left: back on.
    fun backCheck() {
        if (core.store.prefsString("bank.was", "").isEmpty()) return
        val since = core.store.prefsString("bank.since", "0").toLongOrNull() ?: 0L
        if (System.currentTimeMillis() - since > BACK_FOR_MS) return // gave up: opening TwinDesk does it
        val pkg = core.store.prefsString("bank.app", "")
        val interactive = ctx.getSystemService(PowerManager::class.java)?.isInteractive != false
        val front = frontSince(maxOf(since, System.currentTimeMillis() - BACK_FOR_MS))
        if (!interactive || front == null || front == pkg || isBank(front)) { later(); return }
        restore()
        Notify.nm(ctx).notify(ID, Notification.Builder(ctx, CH).setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(tr("Debugging is back on")).setContentText(tr("You left {app}. Open TwinDesk to connect again.", "app" to core.appList.label(pkg)))
            .setContentIntent(PendingIntent.getActivity(ctx, 19, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE))
            .setTimeoutAfter(60_000).setAutoCancel(true).build())
    }

    // Switched off for a banking app and not back on yet.
    val pending: Boolean get() = core.store.prefsString("bank.was", "").isNotEmpty()

    // TwinDesk started without being opened (Android starting it for a linked computer, the alarm,
    // a restart): while the banking app is still in front nothing comes back under it, it waits
    // (the alarm, or TwinDesk opened, or Turn back on). Opened by the person: MainActivity, opened().
    private fun startRestore() {
        if (!pending) return
        val pkg = core.store.prefsString("bank.app", "")
        val front = if (usageAccess) frontSince(System.currentTimeMillis() - BACK_FOR_MS) else null
        if (front != null && front != ctx.packageName && (front == pkg || isBank(front))) {
            tripped = true
            if (autoBack && usageAccess && restoreOn) later()
            return
        }
        restore()
    }

    // TwinDesk's window opened: Restore when TwinDesk opens.
    fun opened() { if (pending) runCatching { restore() } }

    // Opening TwinDesk again: what was on comes back (only what we switched off).
    fun restore() {
        val was = core.store.prefsString("bank.was", "")
        if (was.isEmpty()) return
        core.store.setPrefsString("bank.was", "")
        tripped = false
        Notify.nm(ctx).cancel(ID)
        runCatching { ctx.getSystemService(android.app.AlarmManager::class.java).cancel(alarm()) }
        if (!restoreOn || !core.adb.canEnable) return
        val w = runCatching { JSONObject(was) }.getOrNull() ?: return
        runCatching {
            if (w.optBoolean("dev")) Settings.Global.putInt(cr, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 1)
            if (w.optBoolean("adb")) Settings.Global.putInt(cr, Settings.Global.ADB_ENABLED, 1)
            if (w.optBoolean("wifi") && core.adb.onWifiNetwork) Settings.Global.putInt(cr, "adb_wifi_enabled", 1)
        }
        if (w.optBoolean("a11y") && !a11yOurs(a11yFlat)) runCatching {
            val now = a11yFlat
            Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, if (now.isEmpty()) me.flattenToString() else "$now:${me.flattenToString()}")
            Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
        }
    }

    // Said once, after it happened: what was switched off and how to get it back.
    private fun notice(label: String, switched: Boolean) = runCatching {
        val nm = Notify.nm(ctx)
        nm.createNotificationChannel(NotificationChannel(CH, tr("Banking apps"), NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = tr("TwinDesk closed so a banking app could open")
        })
        val text = if (switched) if (devOff) tr("Debugging and Developer options are off while you use {app}. Open TwinDesk to turn them back on.", "app" to label)
            else tr("Debugging is off while you use {app}. Open TwinDesk to turn it back on.", "app" to label)
        else tr("Turn off USB and wireless debugging in Developer options if {app} still refuses to open.", "app" to label)
        nm.notify(
            ID,
            Notification.Builder(ctx, CH).setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("TwinDesk closed for {app}", "app" to label))
                .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(PendingIntent.getActivity(ctx, 19, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE))
                .apply { if (switched && restoreOn) addAction(Notification.Action.Builder(null, tr("Turn back on"), Notify.action(ctx, ActionReceiver.BANK_BACK, 0x6262)).build()) }
                .setAutoCancel(true).build(),
        )
    }
}
