// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The apps on this phone that open from the launcher (the manifest's <queries> lets us see them),
// for the pages that pick apps: Notifications › Apps (the allow or block list) and General ›
// Banking apps. Read once, in the background, and again when an app is installed or removed.
package com.twindesk.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build

class AppList(private val core: Core) {
    class App(val pkg: String, val label: String)

    @Volatile var all: List<App> = emptyList(); private set
    @Volatile private var loading = false
    private var watching = false
    private val icons = object : LinkedHashMap<String, Bitmap>(64, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Bitmap>?) = size > 120
    }

    // The list (maybe still empty: it's read in the background, and the page redraws when it's in).
    fun get(): List<App> {
        if (all.isEmpty()) load()
        return all
    }

    fun label(pkg: String): String = all.firstOrNull { it.pkg == pkg }?.label
        ?: runCatching { core.ctx.packageManager.let { pm -> pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() } }.getOrDefault(pkg)

    fun load() {
        if (loading) return
        loading = true
        watch()
        core.bg.execute {
            try {
                val pm = core.ctx.packageManager
                val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                all = pm.queryIntentActivities(launcher, 0)
                    .map { it.activityInfo.packageName }
                    .distinct()
                    .filter { it != core.ctx.packageName }
                    .mapNotNull { pkg -> runCatching { App(pkg, pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()) }.getOrNull() }
                    .sortedBy { it.label.lowercase() }
            } finally {
                loading = false
            }
            core.changed()
        }
    }

    // Small (96 px) app icons for the lists, kept for the most recent 120.
    fun icon(pkg: String): Bitmap? {
        synchronized(icons) { icons[pkg]?.let { return it } }
        val b = runCatching {
            val d = core.ctx.packageManager.getApplicationIcon(pkg)
            val bmp = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
            d.setBounds(0, 0, 96, 96)
            d.draw(Canvas(bmp))
            bmp
        }.getOrNull() ?: return null
        synchronized(icons) { icons[pkg] = b }
        return b
    }

    private fun watch() {
        if (watching) return
        watching = true
        val f = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED); addAction(Intent.ACTION_PACKAGE_REMOVED); addAction(Intent.ACTION_PACKAGE_CHANGED)
            addDataScheme("package")
        }
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                load()
                // A new app that looks like a bank's: watched from now on (BankGuard.kt).
                if (i.action == Intent.ACTION_PACKAGE_ADDED) i.data?.schemeSpecificPart?.let { core.bank.installed(it) }
            }
        }
        if (Build.VERSION.SDK_INT >= 33) core.ctx.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED) else core.ctx.registerReceiver(r, f)
    }
}
