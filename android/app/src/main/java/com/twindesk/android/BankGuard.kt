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
        runCatching { restore() }
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
        exitTwinDesk(ctx, core)
        notice(label, switched) // after Exit's cancelAll: this one stays
    }

    // Opening TwinDesk again: what was on comes back (only what we switched off).
    fun restore() {
        val was = core.store.prefsString("bank.was", "")
        if (was.isEmpty()) return
        core.store.setPrefsString("bank.was", "")
        tripped = false
        Notify.nm(ctx).cancel(ID)
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
                .setAutoCancel(true).build(),
        )
    }
}
