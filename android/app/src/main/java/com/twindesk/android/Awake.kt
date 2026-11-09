// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Awake while file bytes move (#143): a partial wake lock (the CPU keeps reading and writing with
// the screen off) and Wi-Fi locks (the radio stays out of power save, which slows a transfer to a
// crawl and can stall it past the computer's 30 s idle limit). touch() as bytes go; everything is
// let go HOLD_MS after the last of them, so a transfer that ends any way at all never keeps it.
package com.twindesk.android

import android.content.Context
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class Awake(ctx: Context) {
    private val app = ctx.applicationContext
    private val wake = runCatching {
        app.getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TwinDesk:files")
    }.getOrNull()?.apply { setReferenceCounted(false) }
    @Suppress("DEPRECATION")
    private val wifi = app.getSystemService(WifiManager::class.java)?.let { wm ->
        listOfNotNull(
            runCatching { wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "TwinDesk:files") }.getOrNull(),
            runCatching { wm.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "TwinDesk:files-fg") }.getOrNull(),
        )
    }.orEmpty().onEach { it.setReferenceCounted(false) }
    private val timer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "td-awake").apply { isDaemon = true } }
    @Volatile private var held = false
    val busy: Boolean get() = held // file bytes moved in the last HOLD_MS: the session pings every second (Link quiet)
    private var last = 0L
    private var off: ScheduledFuture<*>? = null

    @Synchronized fun touch() {
        val now = System.currentTimeMillis()
        if (held && now - last < 1000) return
        last = now
        // The wake lock's own timeout too: a backstop should the timer never run.
        runCatching { wake?.acquire(HOLD_MS + 5000) }
        if (!held) {
            held = true
            for (l in wifi) runCatching { l.acquire() }
            Log.i("TwinDesk", "awake for file transfers")
        }
        off?.cancel(false)
        off = timer.schedule({ release() }, HOLD_MS, TimeUnit.MILLISECONDS)
    }

    @Synchronized fun release() {
        off?.cancel(false)
        off = null
        if (!held) return
        held = false
        runCatching { if (wake?.isHeld == true) wake.release() }
        for (l in wifi) runCatching { if (l.isHeld) l.release() }
        Log.i("TwinDesk", "file transfers done: may sleep")
    }

    companion object {
        const val HOLD_MS = 60_000L
    }
}
