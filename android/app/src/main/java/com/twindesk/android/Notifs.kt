// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications both ways: the phone's (read by NotifListener, which needs Notification access)
// go to the computer while it accepts them (`notif.policy`); the computer's show here as real
// notifications, one channel per computer app is overkill, so one "From the computer" channel.
package com.twindesk.android

import android.app.Notification
import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import android.service.notification.StatusBarNotification
import org.json.JSONObject

class Notifs(core: Core) : Feature(core) {
    @Volatile var peerAccepts = false; private set
    @Volatile var sent = 0; private set
    @Volatile var shown = 0; private set
    private val muted get() = core.store.prefsSet("notifs.muted")
    // App icons with notifications (shared/notificon.js): ours go with an app's first one in a
    // session; the computer's are kept by app (the computer sends each only once).
    private val iconsSent = HashSet<String>()
    private val iconsIn = object : LinkedHashMap<String, Bitmap>(16, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Bitmap>?) = size > 100
    }
    private val recentSent = object : LinkedHashMap<String, Long>(32, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Long>?) = size > 64
    }

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

    fun sendPolicy() {
        core.send(msg(Proto.T.NOTIF_POLICY, "accept" to core.sync.get("notifs", "in")))
    }

    override fun onWelcome(host: Host) {
        peerAccepts = false
        sendPolicy()
    }

    override fun onClosed() {
        peerAccepts = false
        synchronized(iconsSent) { iconsSent.clear() }
    }

    // Extract title from standard, big title, conversation title, etc.
    private fun extractTitle(x: Bundle): String {
        return (x.getCharSequence(Notification.EXTRA_TITLE)
            ?: x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)
            ?: x.getCharSequence(Notification.EXTRA_TITLE_BIG))?.toString()?.trim() ?: ""
    }

    // Extract text from MessagingStyle (WhatsApp, etc.), InboxStyle, BigText, Text, or SubText
    private fun extractText(x: Bundle): String {
        // 1. Direct big text or standard text
        val bigText = x.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()
        if (!bigText.isNullOrEmpty()) return bigText

        val text = x.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
        if (!text.isNullOrEmpty()) return text

        // 2. MessagingStyle (used by WhatsApp, Telegram, Google Messages)
        val msgs = x.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (!msgs.isNullOrEmpty()) {
            val lastMsg = msgs.lastOrNull()
            if (lastMsg is Bundle) {
                val senderPerson = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    (lastMsg.getParcelable<android.app.Person>("sender_person"))?.name?.toString()?.trim() ?: ""
                } else ""
                val sender = senderPerson.ifEmpty { lastMsg.getCharSequence("sender")?.toString()?.trim() ?: "" }
                val msgText = lastMsg.getCharSequence("text")?.toString()?.trim() ?: ""
                if (msgText.isNotEmpty()) {
                    return if (sender.isNotEmpty()) "$sender: $msgText" else msgText
                }
            }
        }

        // 3. InboxStyle (used by Instagram and WhatsApp multi-message summaries)
        val lines = x.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        if (!lines.isNullOrEmpty()) {
            val valid = lines.mapNotNull { it?.toString()?.trim() }.filter { it.isNotEmpty() }
            if (valid.isNotEmpty()) return valid.joinToString("\n")
        }

        // 4. Fallback to sub text or summary text
        val subText = x.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()?.trim()
        if (!subText.isNullOrEmpty()) return subText

        val summaryText = x.getCharSequence(Notification.EXTRA_SUMMARY_TEXT)?.toString()?.trim()
        if (!summaryText.isNullOrEmpty()) return summaryText

        val infoText = x.getCharSequence(Notification.EXTRA_INFO_TEXT)?.toString()?.trim()
        if (!infoText.isNullOrEmpty()) return infoText

        return ""
    }

    // From NotifListener: a new notification on this phone.
    fun posted(sbn: StatusBarNotification) {
        if (!peerAccepts || !core.sync.get("notifs", "out") || !core.link.connected) return
        val n = sbn.notification ?: return
        val pkg = sbn.packageName
        if (pkg == core.ctx.packageName || sbn.isOngoing) return

        val isMessaging = pkg == "com.whatsapp" || pkg == "com.whatsapp.w4b" || pkg == "com.instagram.android" || pkg == "org.telegram.messenger"
        // Don't drop group summaries for messaging apps if they contain message text
        if (!isMessaging && (n.flags and Notification.FLAG_GROUP_SUMMARY != 0)) return
        if (n.category == Notification.CATEGORY_TRANSPORT || n.category == Notification.CATEGORY_PROGRESS || n.category == Notification.CATEGORY_SERVICE) return
        if (n.category == Notification.CATEGORY_CALL && core.hub.callsOn) return // the computer shows the call itself
        if (pkg in muted) return

        val x = n.extras
        val title = extractTitle(x)
        val text = extractText(x)
        if (title.isEmpty() && text.isEmpty()) return

        // Deduplicate rapid duplicate notifications (e.g. summary + child sent at same instant)
        val hash = "$pkg|$title|$text"
        val now = System.currentTimeMillis()
        synchronized(recentSent) {
            val last = recentSent[hash] ?: 0L
            if (now - last < 2000L) return
            recentSent[hash] = now
        }

        val pm = core.ctx.packageManager
        val appName = when (pkg) {
            "com.whatsapp" -> "WhatsApp"
            "com.whatsapp.w4b" -> "WhatsApp Business"
            "com.instagram.android" -> "Instagram"
            "org.telegram.messenger" -> "Telegram"
            else -> runCatching { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)
        }

        val hide = core.store.flag("notifs.hideText", false)
        val icon = if (synchronized(iconsSent) { iconsSent.add(pkg) }) appIcon(pkg) else null
        Log.d("TwinDeskNotifs", "Sending notif from $appName: $title -> $text")
        core.send(
            msg(
                Proto.T.NOTIF, "id" to sbn.key.take(200), "app" to pkg, "appName" to appName,
                "title" to title.take(300), "subtitle" to (x.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString() ?: "").take(200),
                "body" to if (hide) "" else text.take(1000), "at" to sbn.postTime,
            ).apply { if (icon != null) put("icon", icon) },
        )
        sent++
        core.changed()
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.NOTIF_POLICY -> peerAccepts = m.optBoolean("accept")
            Proto.T.NOTIF -> {
                if (!core.sync.get("notifs", "in")) return true
                val app = m.str("appName", 80).ifEmpty { m.str("app", 80) }
                val title = m.str("title", 300)
                val body = listOf(m.str("subtitle", 200), m.str("body", 1000)).filter { it.isNotEmpty() }.joinToString("\n")
                Notify.fromComputer(core.ctx, m.str("id", 200), app, title, body, core.host?.name ?: "Computer", iconIn(m))
                shown++
            }
            else -> return false
        }
        core.changed()
        return true
    }

    // A 64 px PNG of the app's icon as a data: URL, or null.
    private fun appIcon(pkg: String): String? = runCatching {
        val d = core.ctx.packageManager.getApplicationIcon(pkg)
        val bmp = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, 64, 64)
        d.draw(Canvas(bmp))
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }.getOrNull()

    // The icon of a notification from the computer: the one it came with, else the app's last one.
    private fun iconIn(m: JSONObject): Bitmap? {
        val app = m.optString("app").take(300)
        val url = m.optString("icon")
        val head = "data:image/png;base64,"
        synchronized(iconsIn) {
            if (url.startsWith(head) && url.length <= 48000 && app.isNotEmpty()) {
                runCatching {
                    val b = Base64.decode(url.substring(head.length), Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(b, 0, b.size)
                }.getOrNull()?.let { iconsIn[app] = it }
            }
            return iconsIn[app]
        }
    }
}
