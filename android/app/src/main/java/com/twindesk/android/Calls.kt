// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Calls on the computer (Hub.kt): the phone's call state as it changes (call.state), Answer,
// Decline, End and Call from there (call.do), the call history and contacts. Made only while
// Calls is on; the one receiver it has is registered then and gone with it.
package com.twindesk.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Phone as P
import android.telecom.TelecomManager
import android.telephony.TelephonyManager
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class Calls(private val hub: Hub, private val core: Core) {
    private val ctx = core.ctx
    private var registered = false

    // The call now: idle | ringing | offhook (answered or dialing), who, which way, since when.
    private var state = "idle"
    private var number = ""
    private var dir = ""
    private var since = 0L
    // Dialed from the computer: its number, for the call that follows.
    private var dialed = ""
    private var dialedAt = 0L

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val s = i.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
            // Only with the call log allowed (Android sends it twice then: once with, once without).
            @Suppress("DEPRECATION") val n = i.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: ""
            changed(s, n)
        }
    }

    fun start() {
        if (registered || !hub.granted(Manifest.permission.READ_PHONE_STATE)) return
        registered = true
        ctx.registerReceiver(receiver, IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED))
        // A call already going: the computer shows it too.
        @Suppress("DEPRECATION")
        val now = runCatching { ctx.getSystemService(TelephonyManager::class.java).callState }.getOrDefault(TelephonyManager.CALL_STATE_IDLE)
        state = "idle"
        when (now) {
            TelephonyManager.CALL_STATE_RINGING -> changed(TelephonyManager.EXTRA_STATE_RINGING, "")
            TelephonyManager.CALL_STATE_OFFHOOK -> changed(TelephonyManager.EXTRA_STATE_OFFHOOK, "")
            else -> report()
        }
    }

    fun stop() {
        if (registered) runCatching { ctx.unregisterReceiver(receiver) }
        registered = false
        state = "idle"
    }

    private fun changed(s: String, n: String) {
        val st = when (s) { TelephonyManager.EXTRA_STATE_RINGING -> "ringing"; TelephonyManager.EXTRA_STATE_OFFHOOK -> "offhook"; else -> "idle" }
        val now = System.currentTimeMillis()
        if (st == state) {
            if (n.isEmpty() || n == number) return
            number = n // the second broadcast, with the number
        } else {
            when (st) {
                "ringing" -> { dir = "in"; number = n; since = now }
                "offhook" -> {
                    if (state == "idle") { dir = "out"; number = if (now - dialedAt < 60000) dialed else "" }
                    since = now
                }
            }
            state = st
        }
        report()
    }

    private fun report() {
        val st = state; val n = number; val d = dir; val at = since
        hub.run {
            val who = if (n.isNotEmpty()) lookup(n) else null
            core.send(msg(Proto.T.CALL_STATE, "state" to st, "number" to n, "name" to (who?.first ?: ""), "photo" to who?.second, "dir" to d, "since" to at))
        }
    }

    // call.do from the computer.
    @SuppressLint("MissingPermission")
    fun act(m: JSONObject) {
        val a = m.str("a", 20)
        val telecom = ctx.getSystemService(TelecomManager::class.java)
        val r = runCatching {
            when (a) {
                "dial" -> {
                    if (!hub.granted(Manifest.permission.CALL_PHONE)) error("dial")
                    val n = m.str("number", 60).filter { it.isDigit() || it in "+*#,;" }
                    if (n.isEmpty()) error("number")
                    dialed = n
                    dialedAt = System.currentTimeMillis()
                    telecom.placeCall(Uri.fromParts("tel", n, null), Bundle())
                }
                "answer" -> {
                    if (!hub.granted(Manifest.permission.ANSWER_PHONE_CALLS)) error("answer")
                    @Suppress("DEPRECATION") telecom.acceptRingingCall()
                }
                "end" -> {
                    if (!hub.granted(Manifest.permission.ANSWER_PHONE_CALLS)) error("answer")
                    @Suppress("DEPRECATION") if (!telecom.endCall()) error("end")
                }
                // The phone's microphone (its sound stays on the phone); over Bluetooth the computer mutes its own.
                "mute" -> ctx.getSystemService(AudioManager::class.java).isMicrophoneMute = m.optBoolean("on")
                else -> error("unknown")
            }
        }
        core.send(msg(Proto.T.CALL_DONE, "a" to a, "ok" to r.isSuccess, "error" to r.exceptionOrNull()?.message))
    }

    // The newest calls (needs the call log).
    fun log(n: Int): JSONArray {
        val out = JSONArray()
        if (!hub.granted(Manifest.permission.READ_CALL_LOG)) return out
        val names = HashMap<String, String>()
        ctx.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION),
            null, null, "${CallLog.Calls.DATE} DESC",
        )?.use { c ->
            while (c.moveToNext() && out.length() < n.coerceIn(1, 300)) {
                val num = c.getString(0) ?: ""
                val name = c.getString(1)?.takeIf { it.isNotBlank() } ?: names.getOrPut(num) { lookup(num, photo = false)?.first ?: "" }
                val type = when (c.getInt(2)) {
                    CallLog.Calls.INCOMING_TYPE, CallLog.Calls.ANSWERED_EXTERNALLY_TYPE -> "in"
                    CallLog.Calls.OUTGOING_TYPE -> "out"
                    CallLog.Calls.MISSED_TYPE -> "missed"
                    CallLog.Calls.REJECTED_TYPE -> "rejected"
                    CallLog.Calls.BLOCKED_TYPE -> "blocked"
                    CallLog.Calls.VOICEMAIL_TYPE -> "voicemail"
                    else -> "in"
                }
                out.put(JSONObject().put("number", num).put("name", name).put("type", type).put("at", c.getLong(3)).put("dur", c.getLong(4)))
            }
        }
        return out
    }

    // Contacts with phone numbers, matching q (all when empty), one entry per person.
    fun contacts(q: String): JSONArray {
        val out = JSONArray()
        if (!hub.granted(Manifest.permission.READ_CONTACTS)) return out
        val uri = if (q.isBlank()) P.CONTENT_URI else Uri.withAppendedPath(P.CONTENT_FILTER_URI, Uri.encode(q.trim()))
        val people = LinkedHashMap<Long, JSONObject>()
        ctx.contentResolver.query(uri, arrayOf(P.CONTACT_ID, P.DISPLAY_NAME, P.NUMBER, P.TYPE, P.LABEL, P.STARRED), null, null, "${P.DISPLAY_NAME} COLLATE NOCASE")?.use { c ->
            while (c.moveToNext() && people.size < 3000) {
                val id = c.getLong(0)
                val n = c.getString(2) ?: continue
                val o = people.getOrPut(id) { JSONObject().put("name", c.getString(1) ?: n).put("starred", c.getInt(5) == 1).put("numbers", JSONArray()) }
                val nums = o.getJSONArray("numbers")
                val clean = n.filter { it.isDigit() || it == '+' }
                if ((0 until nums.length()).any { nums.getJSONObject(it).optString("n").filter { ch -> ch.isDigit() || ch == '+' } == clean }) continue
                val label = P.getTypeLabel(ctx.resources, c.getInt(3), c.getString(4) ?: "").toString()
                nums.put(JSONObject().put("n", n).put("label", label))
            }
        }
        people.values.forEach { out.put(it) }
        return out
    }

    // A number's contact: (name, small photo as a data: URL).
    private fun lookup(n: String, photo: Boolean = true): Pair<String, String?>? {
        if (!hub.granted(Manifest.permission.READ_CONTACTS)) return null
        return runCatching {
            ctx.contentResolver.query(
                Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(n)),
                arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME, ContactsContract.PhoneLookup.PHOTO_THUMBNAIL_URI), null, null, null,
            )?.use { c ->
                if (!c.moveToFirst()) return@use null
                val name = c.getString(0) ?: ""
                val pic = if (photo) c.getString(1)?.let { thumb(Uri.parse(it)) } else null
                name to pic
            }
        }.getOrNull()
    }

    private fun thumb(uri: Uri): String? = runCatching {
        val b = ctx.contentResolver.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it) } ?: return null
        val s = Bitmap.createScaledBitmap(b, 96, 96, true)
        val out = ByteArrayOutputStream()
        s.compress(Bitmap.CompressFormat.JPEG, 80, out)
        "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }.getOrNull()
}
