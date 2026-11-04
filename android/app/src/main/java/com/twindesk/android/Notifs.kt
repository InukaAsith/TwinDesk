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
import java.io.ByteArrayOutputStream
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

class Notifs(core: Core) : Feature(core) {
    @Volatile var peerAccepts = false; private set
    @Volatile var sent = 0; private set
    @Volatile var shown = 0; private set
    private val muted get() = core.store.prefsSet("notifs.muted")

    // Per app (#102): the apps that had a notification to send, each with its own switch on the
    // Notifications page (on unless muted). Kept across restarts, up to 200.
    fun apps(): List<Pair<String, String>> {
        val pm = core.ctx.packageManager
        return core.store.prefsSet("notifs.apps").mapNotNull { pkg ->
            val label = runCatching { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() }.getOrNull() ?: return@mapNotNull null
            pkg to label
        }.sortedBy { it.second.lowercase() }
    }

    fun isMuted(pkg: String) = pkg in muted

    fun setMuted(pkg: String, on: Boolean) {
        core.store.setPrefsSet("notifs.muted", if (on) muted + pkg else muted - pkg)
        core.changed()
    }

    private fun seen(pkg: String) {
        val all = core.store.prefsSet("notifs.apps")
        if (pkg in all) return
        core.store.setPrefsSet("notifs.apps", if (all.size >= 200) all else all + pkg)
    }
    // App icons with notifications (shared/notificon.js): ours go with an app's first one in a
    // session; the computer's are kept by app (the computer sends each only once).
    private val iconsSent = HashSet<String>()
    private val iconsIn = object : LinkedHashMap<String, Bitmap>(16, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Bitmap>?) = size > 100
    }
    // Each sent notification's reply action (a chat's Reply), for notif.reply from the computer.
    private val replies = object : LinkedHashMap<String, Notification.Action>(32, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Notification.Action>?) = size > 80
    }
    // Messages' chat apps on the computer (shared/chats.js): while it asks (chat.want), each chat
    // app conversation's recent messages as its notification shows them (chat.conv), whether or not
    // notifications go there; answered through the same Reply (notif.reply).
    @Volatile private var chatsWanted = false
    private val chatApps = setOf(
        "com.whatsapp", "com.whatsapp.w4b", "com.instagram.android", "org.telegram.messenger", "org.telegram.messenger.web",
        "org.thunderdog.challegram", "com.facebook.orca", "org.thoughtcrime.securesms",
    )
    // Each sent notification's other buttons (Mark as read, Archive…), by key, for notif.act; and the
    // keys the computer has, so it hears when they go from here (notif.gone).
    private val actions = object : LinkedHashMap<String, List<Notification.Action>>(32, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, List<Notification.Action>>?) = size > 80
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
        chatsWanted = false
        sendPolicy()
    }

    override fun onClosed() {
        peerAccepts = false
        chatsWanted = false
        synchronized(iconsSent) { iconsSent.clear() }
    }

    // Extract title from standard, big title, conversation title, etc.
    private fun extractTitle(x: Bundle): String {
        return (x.getCharSequence(Notification.EXTRA_TITLE)
            ?: x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)
            ?: x.getCharSequence(Notification.EXTRA_TITLE_BIG))?.toString()?.trim() ?: ""
    }

    // MessagingStyle's messages, and a message's sender (typed reads from Android 13).
    @Suppress("DEPRECATION")
    private fun messages(x: Bundle): Array<out android.os.Parcelable>? =
        if (Build.VERSION.SDK_INT >= 33) x.getParcelableArray(Notification.EXTRA_MESSAGES, android.os.Parcelable::class.java)
        else x.getParcelableArray(Notification.EXTRA_MESSAGES)

    @Suppress("DEPRECATION")
    private fun senderOf(m: Bundle): android.app.Person? = when {
        Build.VERSION.SDK_INT >= 33 -> m.getParcelable("sender_person", android.app.Person::class.java)
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P -> m.getParcelable("sender_person")
        else -> null
    }

    // Extract text from MessagingStyle (WhatsApp, etc.), InboxStyle, BigText, Text, or SubText
    private fun extractText(x: Bundle): String {
        // 1. Direct big text or standard text
        val bigText = x.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()
        if (!bigText.isNullOrEmpty()) return bigText

        val text = x.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
        if (!text.isNullOrEmpty()) return text

        // 2. MessagingStyle (used by WhatsApp, Telegram, Google Messages)
        val msgs = messages(x)
        if (!msgs.isNullOrEmpty()) {
            val lastMsg = msgs.lastOrNull()
            if (lastMsg is Bundle) {
                val senderPerson = senderOf(lastMsg)?.name?.toString()?.trim() ?: ""
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

    private fun appNameOf(pkg: String): String = when (pkg) {
        "com.whatsapp" -> "WhatsApp"
        "com.whatsapp.w4b" -> "WhatsApp Business"
        "com.instagram.android" -> "Instagram"
        "org.telegram.messenger", "org.telegram.messenger.web" -> "Telegram"
        "com.facebook.orca" -> "Messenger"
        "org.thoughtcrime.securesms" -> "Signal"
        else -> runCatching { core.ctx.packageManager.let { pm -> pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() } }.getOrDefault(pkg)
    }

    // A chat app's conversation for the computer's Messages: its MessagingStyle messages (sender,
    // text, time; the user's own have no sender), else the notification's text as one message.
    private fun chatPosted(sbn: StatusBarNotification) {
        if (!chatsWanted || !core.link.connected) return
        val n = sbn.notification ?: return
        if (sbn.packageName !in chatApps && !otherChat(sbn, n)) return
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        if (core.store.flag("notifs.hideText", false)) return
        val x = n.extras
        val title = extractTitle(x)
        val convTitle = x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()?.trim().orEmpty()
        val name = convTitle.ifEmpty { title }
        val key = (if (Build.VERSION.SDK_INT >= 26) n.shortcutId else null)?.takeIf { it.isNotEmpty() } ?: name
        if (key.isEmpty()) return
        val items = JSONArray()
        val msgs = messages(x)
        if (!msgs.isNullOrEmpty()) {
            for (p in msgs) {
                if (p !is Bundle) continue
                val text = p.getCharSequence("text")?.toString()?.trim().orEmpty()
                if (text.isEmpty()) continue
                val person = senderOf(p)
                val sender = p.getCharSequence("sender")
                val me = person == null && sender == null
                val from = if (me) "" else (person?.name ?: sender)?.toString()?.trim().orEmpty()
                items.put(JSONObject().put("at", p.getLong("time", sbn.postTime)).put("from", from.take(120)).put("text", text.take(4000)).put("me", me))
            }
        } else {
            val text = extractText(x)
            if (text.isNotEmpty()) items.put(JSONObject().put("at", sbn.postTime).put("from", title.take(120)).put("text", text.take(4000)).put("me", false))
        }
        if (items.length() == 0) return
        val reply = n.actions?.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }
        if (reply != null) synchronized(replies) { replies[sbn.key] = reply }
        val group = x.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
        core.send(
            msg(
                "chat.conv", "key" to key.take(300), "app" to sbn.packageName, "appName" to appNameOf(sbn.packageName),
                "name" to name.take(200), "group" to group, "id" to sbn.key.take(200), "reply" to (reply != null), "items" to items,
                "pic" to true, // takes a picture from the computer (chat.pic)
            ),
        )
    }

    // Another app's conversation (Viber, LINE, Discord, Slack…): a message notification in Android's
    // conversation style, from anything but a texting app (those are Messages' texts).
    private fun otherChat(sbn: StatusBarNotification, n: Notification): Boolean {
        if (sbn.packageName == core.ctx.packageName || sbn.isOngoing) return false
        if (n.category != Notification.CATEGORY_MESSAGE || messages(n.extras).isNullOrEmpty()) return false
        val sms = runCatching { android.provider.Telephony.Sms.getDefaultSmsPackage(core.ctx) }.getOrNull()
        return sbn.packageName != sms && sbn.packageName !in SMS_APPS
    }

    // The conversations open on the phone now (the computer just asked).
    private fun chatSnapshot() {
        val l = NotifListener.running ?: return
        runCatching { l.activeNotifications }.getOrNull()?.forEach { runCatching { chatPosted(it) } }
    }

    // From NotifListener: a new notification on this phone.
    fun posted(sbn: StatusBarNotification) {
        runCatching { chatPosted(sbn) }
        if (!peerAccepts || !core.sync.get("notifs", "out") || !core.link.connected) return
        val n = sbn.notification ?: return
        val pkg = sbn.packageName
        if (pkg == core.ctx.packageName || sbn.isOngoing) return

        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return // the group's children come too (a summary is "3 messages from 2 chats")
        if (n.category == Notification.CATEGORY_TRANSPORT || n.category == Notification.CATEGORY_PROGRESS || n.category == Notification.CATEGORY_SERVICE) return
        if (n.category == Notification.CATEGORY_CALL && core.hub.callsOn) return // the computer shows the call itself
        seen(pkg)
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

        val reply = n.actions?.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }
        if (reply != null) synchronized(replies) { replies[sbn.key] = reply }
        // Its other buttons (no typing): the computer shows them, and taps them here (notif.act).
        val buttons = n.actions.orEmpty().filter { a -> a !== reply && a.actionIntent != null && a.title?.isNotBlank() == true && a.remoteInputs.isNullOrEmpty() }.take(3)
        synchronized(actions) { actions[sbn.key] = buttons }
        val hide = core.store.flag("notifs.hideText", false)
        val icon = if (synchronized(iconsSent) { iconsSent.add(pkg) }) appIcon(pkg) else null
        core.send(
            msg(
                Proto.T.NOTIF, "id" to sbn.key.take(200), "app" to pkg, "appName" to appName,
                "title" to title.take(300), "subtitle" to (x.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString() ?: "").take(200),
                "body" to if (hide) "" else text.take(1000), "at" to sbn.postTime,
            ).apply {
                if (icon != null) put("icon", icon)
                if (reply != null) put("reply", true) // the computer may answer it (notif.reply)
                if (buttons.isNotEmpty()) put("actions", jsonArray(buttons.map { it.title.toString().take(40) }))
            },
        )
        sent++
        core.changed()
    }

    // From NotifListener: gone from this phone (swiped, opened, or the app took it back): from the
    // computer's list too.
    fun removed(sbn: StatusBarNotification) {
        val had = synchronized(actions) { actions.remove(sbn.key) } != null
        synchronized(replies) { replies.remove(sbn.key) }
        if (had && peerAccepts && core.link.connected) core.send(msg("notif.gone", "id" to sbn.key.take(200)))
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            // Dismissed on the computer: from this phone too.
            "notif.dismiss" -> {
                val key = m.str("id", 200)
                if (key.isNotEmpty() && synchronized(actions) { actions.containsKey(key) }) runCatching { NotifListener.running?.cancelNotification(key) }
            }
            // One of its buttons, clicked on the computer.
            "notif.act" -> {
                val a = synchronized(actions) { actions[m.str("id", 200)] }?.getOrNull(m.optInt("i", -1)) ?: return true
                runCatching { a.actionIntent.send() }
            }
            Proto.T.NOTIF_POLICY -> peerAccepts = m.optBoolean("accept")
            "chat.want" -> {
                chatsWanted = m.optBoolean("on") && hasAccess
                if (chatsWanted) chatSnapshot()
            }
            Proto.T.NOTIF -> {
                if (!core.sync.get("notifs", "in")) return true
                val app = m.str("appName", 80).ifEmpty { m.str("app", 80) }
                val title = m.str("title", 300)
                val body = listOf(m.str("subtitle", 200), m.str("body", 1000)).filter { it.isNotEmpty() }.joinToString("\n")
                Notify.fromComputer(core.ctx, m.str("id", 200), app, title, body, core.host?.name ?: "Computer", iconIn(m))
                shown++
            }
            // An answer typed on the computer (Overview, Messages' chat apps): through the app's own Reply.
            "notif.reply" -> {
                val key = m.str("id", 200)
                val text = m.str("text", 5000)
                val a = synchronized(replies) { replies[key] } ?: return true
                if (text.isNotEmpty()) runCatching {
                    val intent = android.content.Intent()
                    val results = Bundle()
                    for (ri in a.remoteInputs.orEmpty()) results.putCharSequence(ri.resultKey, text)
                    android.app.RemoteInput.addResultsToIntent(a.remoteInputs, intent, results)
                    a.actionIntent.send(core.ctx, 0, intent)
                }
            }
            // A picture from Messages' chat apps: through the app's Reply where it takes pictures,
            // else the app opens on that conversation with it attached, to send on the phone.
            "chat.pic" -> chatPicture(m)
            else -> return false
        }
        core.changed()
        return true
    }

    private fun chatPicture(m: JSONObject) {
        val ref = m.str("ref", 60)
        val app = m.str("app", 200)
        val chat = m.str("chat", 300)
        val text = m.str("text", 5000).trim()
        val done = { ok: Boolean, opened: Boolean, error: String? -> core.send(msg("chat.picd", "ref" to ref, "ok" to ok, "opened" to opened, "error" to error)); Unit }
        val raw = runCatching { Base64.decode(m.str("image", 6_000_000).substringAfter("base64,", ""), Base64.DEFAULT) }.getOrNull()
        if (raw == null || raw.isEmpty() || !Regex("^[A-Za-z][\\w]*(\\.[\\w]+)+$").matches(app)) return done(false, false, "That picture can't be read")
        val ctx = core.ctx
        val dir = java.io.File(ctx.cacheDir, "mms").apply { mkdirs() }
        dir.listFiles()?.forEach { if (it.name.startsWith("chat-") && System.currentTimeMillis() - it.lastModified() > 3_600_000) it.delete() }
        val file = java.io.File(dir, "chat-" + System.currentTimeMillis() + ".jpg").apply { writeBytes(raw) }
        val uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", file)
        // 1. The Reply takes pictures (RemoteInput's data types): sent from here, like a typed answer.
        val a = synchronized(replies) { replies[m.str("id", 200)] }
        val takes = a?.remoteInputs.orEmpty().firstOrNull { ri -> ri.allowedDataTypes.orEmpty().any { it == "image/*" || it == "image/jpeg" } }
        if (a != null && takes != null) {
            val sent = runCatching {
                ctx.grantUriPermission(app, uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                val intent = android.content.Intent()
                android.app.RemoteInput.addDataResultToIntent(takes, intent, mapOf("image/jpeg" to uri))
                if (text.isNotEmpty()) a.remoteInputs.filter { it.allowFreeFormInput && it !== takes }.forEach { ri ->
                    android.app.RemoteInput.addResultsToIntent(arrayOf(ri), intent, Bundle().apply { putCharSequence(ri.resultKey, text) })
                }
                a.actionIntent.send(ctx, 0, intent)
            }.isSuccess
            if (sent) return done(true, false, null)
        }
        // 2. The app's own share screen, on that conversation (its shortcut), the picture and text in it.
        if (!(Settings.canDrawOverlays(ctx) || MainActivity.shown)) return done(false, false, "Allow TwinDesk to display over other apps on the phone")
        val share = android.content.Intent(android.content.Intent.ACTION_SEND).setPackage(app).setType("image/jpeg")
            .putExtra(android.content.Intent.EXTRA_STREAM, uri)
            .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        share.clipData = android.content.ClipData.newRawUri("", uri)
        if (text.isNotEmpty()) share.putExtra(android.content.Intent.EXTRA_TEXT, text)
        if (chat.isNotEmpty()) {
            share.putExtra(android.content.Intent.EXTRA_SHORTCUT_ID, chat) // Android's direct share: that conversation
            if ('@' in chat) share.putExtra("jid", chat) // WhatsApp's own
        }
        if (runCatching { ctx.startActivity(share) }.isSuccess) done(true, true, null)
        else done(false, false, "That app doesn't take pictures")
    }

    companion object {
        private val SMS_APPS = setOf("com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.mms", "com.android.messaging")
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
