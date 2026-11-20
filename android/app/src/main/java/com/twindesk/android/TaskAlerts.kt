// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

internal data class TaskCompletion(val id: String, val title: String, val ok: Boolean)

internal class TaskAlertGate {
    private var owner: Any? = null
    private val seen = LinkedHashSet<String>()
    private val recent = ArrayDeque<Long>()

    fun select(marker: Any?) {
        if (owner === marker) return
        owner = marker
        seen.clear()
        recent.clear()
    }

    fun take(alert: TaskCompletion, marker: Any, now: Long): Boolean {
        if (owner !== marker || !seen.add(alert.id)) return false
        if (seen.size > 64) seen.remove(seen.first())
        while (recent.isNotEmpty() && now - recent.first() >= 60000) recent.removeFirst()
        if (recent.size >= 8) return false
        recent.addLast(now)
        return true
    }

    companion object {
        private val identifier = Regex("[0-9a-f]{32}")
        private val controls = Regex("""[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]""")

        fun parse(id: Any?, title: Any?, ok: Any?): TaskCompletion? {
            if (id !is String || !id.matches(identifier) || ok !is Boolean) return null
            if (title !is String || title.length !in 1..80 || title.isBlank() ||
                controls.containsMatchIn(title)) return null
            return TaskCompletion(id, title, ok)
        }
    }
}

// This setting belongs to the paired Mac's certificate. Each delivery also belongs to its socket.
class TaskAlerts(private val core: Core) {
    private val main = Handler(Looper.getMainLooper())
    private val gate = TaskAlertGate()
    private var policyOwner: Any? = null
    private var policyOn: Boolean? = null
    private var nextNotification = 0

    private fun approved(route: Link.TrustedRoute): Boolean =
        core.moduleOn("notifications") && "notifications" !in Modules.off(core.store) &&
            core.host?.let { it.os == "mac" && it.id == route.id && it.fp == route.fp } == true &&
            core.store.hosts().any { it.id == route.id && it.fp == route.fp && it.os == "mac" } &&
            core.store.prefsString("taskAlerts.${route.id}", "") == route.fp

    val enabled: Boolean get() = core.link.currentTrustedRoute()?.let(::approved) == true

    val canNotify: Boolean get() = (Build.VERSION.SDK_INT < 33 ||
        core.ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
        Notify.nm(core.ctx).areNotificationsEnabled() &&
        Notify.nm(core.ctx).getNotificationChannel(Notify.CH_TASK)?.importance != android.app.NotificationManager.IMPORTANCE_NONE

    fun setEnabled(route: Link.TrustedRoute?, on: Boolean) {
        if (route == null || !core.link.accepts(route) || core.host?.os != "mac") return
        if (on && (!core.moduleOn("notifications") || "notifications" in Modules.off(core.store))) return
        if (core.store.hosts().none { it.id == route.id && it.fp == route.fp && it.os == "mac" }) return
        core.store.setPrefsString("taskAlerts.${route.id}", if (on) route.fp else "")
        if (!on) Notify.cancelTask(core.ctx)
        publishPolicy(route)
        core.changed()
    }

    fun modulesChanged() {
        if ("notifications" in Modules.off(core.store)) Notify.cancelTask(core.ctx)
        linkChanged()
    }

    fun forget(id: String) {
        core.store.setPrefsString("taskAlerts.$id", "")
        if (core.host?.id == id) Notify.cancelTask(core.ctx)
    }

    fun linkChanged() {
        val route = core.link.currentTrustedRoute()
        main.post { publishPolicy(route) }
    }

    private fun publishPolicy(route: Link.TrustedRoute?) {
        if (route == null || !core.link.accepts(route) || core.host?.os != "mac") {
            if (core.link.currentTrustedRoute() == null || core.host?.os != "mac") {
                policyOwner = null
                policyOn = null
                gate.select(null)
            }
            return
        }
        gate.select(route.marker)
        val on = approved(route) && canNotify
        if (policyOwner === route.marker && policyOn == on) return
        if (core.link.sendFor(route, msg(Proto.T.TASK_ALERT_POLICY, "on" to on))) {
            policyOwner = route.marker
            policyOn = on
        }
    }

    internal fun receive(alert: TaskCompletion?, route: Link.TrustedRoute?) {
        if (alert == null || route == null || !core.link.accepts(route) || !approved(route) || !canNotify) return
        if (!gate.take(alert, route.marker, SystemClock.elapsedRealtime())) return
        // Recheck after preparing the alert, immediately before Android accepts the notification.
        if (core.link.accepts(route) && approved(route) && canNotify) {
            Notify.task(core.ctx, alert.title, alert.ok, nextNotification)
            nextNotification = (nextNotification + 1) % 8
        }
    }
}
