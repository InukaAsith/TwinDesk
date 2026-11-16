// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Permissions › Without a computer: what the computer grants once over wireless
// debugging (mac/phone-bridge.js _setup: WRITE_SECURE_SETTINGS, Usage access, notification
// access, sensitive notifications, background running…), granted on the phone itself through
// Shizuku, when the person has it installed and running (Shizuku pairs with the phone's own
// wireless debugging, or runs as root). The full build only (src/noshizuku has the stand-in);
// it carries only Shizuku's small client API.
// Nothing runs until the person taps Grant: one round of the same commands, as the shell user,
// then nothing. Without Shizuku the row says where to get it; the computer's way stays.
package com.twindesk.android

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import rikka.shizuku.Shizuku

object Elevate {
    const val supported = true
    const val SHIZUKU = "moe.shizuku.privileged.api"
    private const val ASK = 0x7464

    // What the row shows: not installed, installed but not running, running (allowed or not), done.
    enum class State { Missing, Stopped, Ask, Ready }

    @Volatile var last = "" // the outcome of the last Grant, for the row
        private set
    @Volatile var busy = false
        private set

    fun installed(ctx: Context) = runCatching { ctx.packageManager.getPackageInfo(SHIZUKU, 0); true }.getOrDefault(false)

    fun state(ctx: Context): State = when {
        !installed(ctx) -> State.Missing
        !runCatching { Shizuku.pingBinder() }.getOrDefault(false) -> State.Stopped
        runCatching { Shizuku.isPreV11() || Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED }.getOrDefault(true) -> State.Ask
        else -> State.Ready
    }

    // The same as the computer's setup, for this app (minus what only a computer needs).
    private fun commands(pkg: String) = listOf(
        "pm grant $pkg android.permission.WRITE_SECURE_SETTINGS",
        "pm grant $pkg android.permission.POST_NOTIFICATIONS",
        "appops set $pkg SYSTEM_ALERT_WINDOW allow",
        "cmd notification allow_listener $pkg/$pkg.NotifListener",
        "dumpsys deviceidle whitelist +$pkg",
        "appops set $pkg RUN_ANY_IN_BACKGROUND allow",
        "appops set $pkg GET_USAGE_STATS allow",
        "appops set $pkg WRITE_SETTINGS allow",
        "cmd notification allow_dnd $pkg",
        "appops set $pkg MANAGE_ONGOING_CALLS allow",
        "appops set $pkg RECEIVE_SENSITIVE_NOTIFICATIONS allow",
        "cmd notification allow_listener $pkg/$pkg.NotifListener", // again: Android reads the new trust
    )

    // Grant: asks Shizuku for TwinDesk first if needed (its own dialog), then runs the commands.
    fun grant(ctx: Context, core: Core) {
        when (state(ctx)) {
            State.Missing, State.Stopped -> return
            State.Ask -> {
                if (runCatching { Shizuku.shouldShowRequestPermissionRationale() }.getOrDefault(false)) {
                    last = tr("Shizuku said no before: allow TwinDesk in Shizuku’s app list"); core.changed(); return
                }
                val l = object : Shizuku.OnRequestPermissionResultListener {
                    override fun onRequestPermissionResult(requestCode: Int, grantResult: Int) {
                        if (requestCode != ASK) return
                        Shizuku.removeRequestPermissionResultListener(this)
                        if (grantResult == PackageManager.PERMISSION_GRANTED) run(ctx, core)
                        else { last = tr("Not allowed in Shizuku"); core.changed() }
                    }
                }
                Shizuku.addRequestPermissionResultListener(l)
                runCatching { Shizuku.requestPermission(ASK) }.onFailure { Shizuku.removeRequestPermissionResultListener(l) }
            }
            State.Ready -> run(ctx, core)
        }
    }

    private fun run(ctx: Context, core: Core) {
        if (busy) return
        busy = true
        core.changed()
        Thread {
            val failed = commands(ctx.packageName).count { !exec(it) }
            last = if (failed == 0) tr("Granted") else tr("Granted, except {count} this Android doesn’t have", "count" to failed)
            busy = false
            core.changed()
        }.apply { isDaemon = true }.start()
    }

    // One command as Shizuku's user (shell, or root). Shizuku 13 keeps newProcess private for
    // its own reasons (it prefers a bound service for long work); one short command each is what
    // it was made for, so it's called directly.
    private fun exec(cmd: String): Boolean = runCatching {
        val m = Shizuku::class.java.getDeclaredMethod("newProcess", Array<String>::class.java, Array<String>::class.java, String::class.java)
        m.isAccessible = true
        val p = m.invoke(null, arrayOf("sh", "-c", cmd), null, null) as Process
        val out = p.inputStream.bufferedReader().readText() + p.errorStream.bufferedReader().readText()
        val code = p.waitFor()
        if (code != 0 || out.contains("Exception") || out.contains("Unknown")) Log.i("TwinDesk", "elevate: $cmd → $code ${out.take(160)}")
        code == 0 && !out.contains("Exception")
    }.onFailure { Log.w("TwinDesk", "elevate: ${it.message}") }.getOrDefault(false)
}
