// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The calls themselves, for Calls.kt: Android 12+ binds this (no screen of its own, the phone's
// dialer stays the dialer) to apps allowed to manage ongoing calls. The computer allows it once over
// wireless debugging (phone-bridge.js: appops MANAGE_ONGOING_CALLS); without that Calls.kt does what
// Android lets any app do (answer, end) and the computer shows no Hold or keypad.
package com.twindesk.android

import android.app.AppOpsManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.telecom.Call
import android.telecom.InCallService
import android.telecom.VideoProfile

class CallCompanion : InCallService() {
    companion object {
        @Volatile private var live: CallCompanion? = null
        @Volatile var onChange: (() -> Unit)? = null // Calls.kt, while Calls is on

        // Allowed to manage ongoing calls (the computer's appops, Android 12+).
        fun allowed(ctx: Context): Boolean {
            if (Build.VERSION.SDK_INT < 31) return false
            return runCatching {
                ctx.getSystemService(AppOpsManager::class.java)
                    .unsafeCheckOpNoThrow("android:manage_ongoing_calls", Process.myUid(), ctx.packageName) == AppOpsManager.MODE_ALLOWED
            }.getOrDefault(false)
        }

        // The calls now, newest last (empty when Android hasn't bound this: no call, or not allowed).
        fun calls(): List<Call> = live?.calls.orEmpty().filter { it.details != null }

        // The one the computer acts on: the ringing one, else the active one, else the newest.
        fun current(): Call? {
            val all = calls()
            @Suppress("DEPRECATION")
            return all.lastOrNull { it.state == Call.STATE_RINGING }
                ?: all.lastOrNull { it.state == Call.STATE_ACTIVE || it.state == Call.STATE_DIALING || it.state == Call.STATE_CONNECTING }
                ?: all.lastOrNull()
        }

        fun answer(): Boolean {
            @Suppress("DEPRECATION")
            val c = calls().lastOrNull { it.state == Call.STATE_RINGING } ?: return false
            c.answer(VideoProfile.STATE_AUDIO_ONLY)
            return true
        }

        fun end(): Boolean {
            val c = current() ?: return false
            @Suppress("DEPRECATION")
            if (c.state == Call.STATE_RINGING) c.reject(false, null) else c.disconnect()
            return true
        }

        fun hold(on: Boolean): Boolean {
            val c = current() ?: return false
            if (!c.details.can(Call.Details.CAPABILITY_HOLD) && !c.details.can(Call.Details.CAPABILITY_SUPPORT_HOLD)) return false
            if (on) c.hold() else c.unhold()
            return true
        }

        // A key of the keypad, sent as a tone on the call (0-9, *, #).
        fun dtmf(key: Char): Boolean {
            val c = current() ?: return false
            @Suppress("DEPRECATION")
            if (c.state != Call.STATE_ACTIVE) return false
            c.playDtmfTone(key)
            Handler(Looper.getMainLooper()).postDelayed({ runCatching { c.stopDtmfTone() } }, 160)
            return true
        }

        @Suppress("DEPRECATION")
        fun held(): Boolean = current()?.state == Call.STATE_HOLDING
        fun canHold(): Boolean = current()?.details?.let { it.can(Call.Details.CAPABILITY_HOLD) || it.can(Call.Details.CAPABILITY_SUPPORT_HOLD) } ?: false

        // The call's number, when Android gives it (it does to this even without the call log).
        fun number(): String = current()?.details?.handle?.schemeSpecificPart.orEmpty()
    }

    private val cb = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) = changed()
        override fun onDetailsChanged(call: Call, details: Call.Details) = changed()
    }

    private fun changed() { runCatching { onChange?.invoke() } }

    override fun onCallAdded(call: Call) {
        live = this
        call.registerCallback(cb)
        changed()
    }

    override fun onCallRemoved(call: Call) {
        call.unregisterCallback(cb)
        changed()
    }

    override fun onDestroy() {
        if (live === this) live = null
        super.onDestroy()
    }
}
