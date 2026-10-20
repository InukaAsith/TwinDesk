// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications both ways, across every connected computer (docs/mesh.md: one pool). The phone's
// (read by NotifListener, which needs Notification access) go to the computers that accept them
// (`notif.policy`); the computers' show here as real notifications, one "From the computer" channel.
package com.twindesk.android

import android.app.Notification
import android.content.ComponentName
import android.provider.Settings
import android.service.notification.StatusBarNotification
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

class Notifs(core: Core) : Feature(core) {
    // What each computer said it accepts from us (its notif.policy). Only the ones that said yes get ours.
    private val accepts = ConcurrentHashMap<String, Boolean>()
    private val pool = Pool(core.store.deviceId, { core.poolPeers { accepts[it] == true } })
    @Volatile var sent = 0; private set
    @Volatile var shown = 0; private set
    private val muted get() = core.store.prefsSet("notifs.muted")

    // The standard build (what people download) has no notification listener: Play Protect blocks
    // sideloaded apps with one. The computer installs the full build over it (adb, not checked).
    val supported get() = BuildConfig.NOTIF_LISTENER

    val hasAccess: Boolean
        get() {
            if (!supported) return false
            val flat = Settings.Secure.getString(core.ctx.contentResolver, "enabled_notification_listeners") ?: return false
            val me = ComponentName(core.ctx, NotifListener::class.java).flattenToString()
            return flat.split(':').any { it == me }
        }

    // Some connected computer accepts our notifications.
    val peerAccepts: Boolean get() = core.links.connectedLinks().any { accepts[it.hostId] == true }

    private fun policy(): JSONObject = msg(Proto.T.NOTIF_POLICY, "accept" to core.sync.get("notifs", "in"))

    fun sendPolicy() = core.sendAll(policy())

    override fun onPeerWelcome(host: Host) {
        accepts.remove(host.id)
        core.sendTo(host.id, policy())
    }

    override fun onPeerClosed(host: Host) {
        accepts.remove(host.id)
    }

    // The same text from the same app within a few seconds goes once: a notification shown on one device can come back
    // as a new one (each trip has its own id), and that loop must end here.
    private val recent = HashMap<String, Long>()
    @Synchronized private fun repeated(vararg parts: String): Boolean {
        val now = System.currentTimeMillis()
        val key = parts.joinToString("\u0001") { it.take(200) }
        val was = recent[key]
        if (was != null && now - was < 15_000) return true
        recent[key] = now
        if (recent.size > 300) recent.entries.removeAll { now - it.value >= 15_000 }
        return false
    }

    // From NotifListener: a new notification on this phone.
    fun posted(sbn: StatusBarNotification) {
        if (!peerAccepts || !core.sync.get("notifs", "out") || core.links.connectedLinks().isEmpty()) return
        val n = sbn.notification ?: return
        if (sbn.packageName == core.ctx.packageName || sbn.isOngoing) return
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return // the group's children come too
        if (n.category == Notification.CATEGORY_TRANSPORT || n.category == Notification.CATEGORY_PROGRESS || n.category == Notification.CATEGORY_SERVICE) return
        if (sbn.packageName in muted) return
        val x = n.extras
        val title = x.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = (x.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: x.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: ""
        if (title.isEmpty() && text.isEmpty()) return
        if (repeated("out", sbn.packageName, title, text)) return
        val pm = core.ctx.packageManager
        val appName = runCatching { pm.getApplicationLabel(pm.getApplicationInfo(sbn.packageName, 0)).toString() }.getOrDefault(sbn.packageName)
        val hide = core.store.flag("notifs.hideText", false)
        val body = mapOf<String, Any?>(
            "t" to Proto.T.NOTIF, "id" to sbn.key.take(200), "app" to sbn.packageName, "appName" to appName,
            "title" to title.take(300), "subtitle" to (x.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString() ?: "").take(200),
            "body" to if (hide) "" else text.take(1000), "at" to sbn.postTime,
        )
        if (pool.publish(body).sent.isEmpty()) return
        sent++
        core.changed()
    }

    override fun onMessage(t: String, m: JSONObject, host: Host): Boolean {
        when (t) {
            Proto.T.NOTIF_POLICY -> accepts[host.id] = m.optBoolean("accept")
            Proto.T.NOTIF -> {
                if (!core.sync.get("notifs", "in")) return true
                val r = pool.receive(host.id, m.toPoolMsg())
                if (!r.fresh) return true
                val app = m.str("appName", 80).ifEmpty { m.str("app", 80) }
                val title = m.str("title", 300)
                val text = listOf(m.str("subtitle", 200), m.str("body", 1000)).filter { it.isNotEmpty() }.joinToString("\n")
                if (repeated("in", m.str("app", 80), title, text)) return true
                Notify.fromComputer(core.ctx, m.str("id", 200), app, title, text, core.nameOf(r.msg.o, host))
                shown++
            }
            else -> return false
        }
        core.changed()
        return true
    }
}
