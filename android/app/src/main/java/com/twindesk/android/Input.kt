// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer's mouse and keyboard on this phone without wireless debugging (the session through
// Bluetooth, or adb not set up): the computer sends phone.in (shared/phoneinput.js) and we apply it
// with an Accessibility service, which the person switches on once, when they first move the
// cursor over here that way (phone.input.ask: a notification to the settings).
//   Touch: a click is a tap, a long press a long press, a drag a swipe along its path (replayed
//   when the button comes up: Accessibility can't hold a touch open across messages).
//   Wheel: a short swipe. Keys: Back / Home / Recents / notifications as system actions; typing
//   goes into the focused text field (characters, Backspace, Delete, arrows, Enter, Ctrl+A/C/X/V).
package com.twindesk.android

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.hypot

class InputService : AccessibilityService() {
    companion object {
        @Volatile var running: InputService? = null; private set
    }

    override fun onServiceConnected() {
        running = this
        Core.get(this).input.changed()
    }

    override fun onDestroy() {
        if (running === this) running = null
        Core.get(this).input.changed()
        super.onDestroy()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        if (running === this) running = null
        Core.get(this).input.changed()
        return super.onUnbind(intent)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    // ---- touch ----

    private val path = ArrayList<FloatArray>() // x, y
    private var downAt = 0L

    fun touch(a: String, x: Float, y: Float) {
        when (a) {
            "d" -> { path.clear(); path.add(floatArrayOf(x, y)); downAt = System.currentTimeMillis() }
            "m" -> if (path.isNotEmpty()) path.add(floatArrayOf(x, y))
            "u" -> {
                if (path.isEmpty()) return
                path.add(floatArrayOf(x, y))
                val held = (System.currentTimeMillis() - downAt).coerceIn(1, 10000)
                val first = path.first()
                val far = path.any { hypot(it[0] - first[0], it[1] - first[1]) > 12 }
                val p = Path().apply { moveTo(first[0], first[1]) }
                if (far) {
                    // At most ~40 points along the way, at its pace (capped so a slow drag isn't endless).
                    val step = maxOf(1, path.size / 40)
                    for (i in step until path.size step step) p.lineTo(path[i][0], path[i][1])
                    p.lineTo(path.last()[0], path.last()[1])
                }
                val dur = if (far) held.coerceIn(80, 3000) else if (held > 450) held.coerceAtMost(3000) else 40L
                path.clear()
                gesture(p, dur)
            }
        }
    }

    // Wheel steps (+ = up / left, like the wheel): a swipe the other way, as a finger scrolls.
    fun scroll(x: Float, y: Float, h: Double, v: Double) {
        val px = resources.displayMetrics.density * 60
        val dm = resources.displayMetrics
        val toX = (x + h * px).toFloat().coerceIn(1f, dm.widthPixels - 1f)
        val toY = (y + v * px).toFloat().coerceIn(1f, dm.heightPixels - 1f)
        if (abs(toX - x) < 2 && abs(toY - y) < 2) return
        gesture(Path().apply { moveTo(x, y); lineTo(toX, toY) }, 120)
    }

    private fun gesture(p: Path, ms: Long) {
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(p, 0, ms)).build()
        dispatchGesture(g, null, null)
    }

    // ---- keys ----

    fun key(down: Boolean, code: Int, meta: Int) {
        if (!down) return
        when (code) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> { performGlobalAction(GLOBAL_ACTION_BACK); return }
            KeyEvent.KEYCODE_HOME -> { performGlobalAction(GLOBAL_ACTION_HOME); return }
            KeyEvent.KEYCODE_APP_SWITCH -> { performGlobalAction(GLOBAL_ACTION_RECENTS); return }
            KeyEvent.KEYCODE_NOTIFICATION -> { performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS); return }
            KeyEvent.KEYCODE_ALL_APPS -> { performGlobalAction(GLOBAL_ACTION_HOME); return }
        }
        val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
        if (!node.isEditable) return
        val ctrl = meta and KeyEvent.META_CTRL_ON != 0
        if (ctrl) {
            when (code) {
                KeyEvent.KEYCODE_A -> select(node, 0, text(node).length)
                KeyEvent.KEYCODE_C -> node.performAction(AccessibilityNodeInfo.ACTION_COPY)
                KeyEvent.KEYCODE_X -> node.performAction(AccessibilityNodeInfo.ACTION_CUT)
                KeyEvent.KEYCODE_V -> node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            }
            return
        }
        val t = text(node)
        var s = node.textSelectionStart.takeIf { it >= 0 } ?: t.length
        var e = node.textSelectionEnd.takeIf { it >= 0 } ?: t.length
        if (s > e) s = e.also { e = s }
        s = s.coerceIn(0, t.length)
        e = e.coerceIn(0, t.length)
        when (code) {
            KeyEvent.KEYCODE_DEL -> when {
                s != e -> setText(node, t.removeRange(s, e), s)
                s > 0 -> setText(node, t.removeRange(s - 1, s), s - 1)
            }
            KeyEvent.KEYCODE_FORWARD_DEL -> when {
                s != e -> setText(node, t.removeRange(s, e), s)
                s < t.length -> setText(node, t.removeRange(s, s + 1), s)
            }
            KeyEvent.KEYCODE_DPAD_LEFT -> select(node, (s - 1).coerceAtLeast(0), (s - 1).coerceAtLeast(0))
            KeyEvent.KEYCODE_DPAD_RIGHT -> select(node, (e + 1).coerceAtMost(t.length), (e + 1).coerceAtMost(t.length))
            KeyEvent.KEYCODE_MOVE_HOME, KeyEvent.KEYCODE_DPAD_UP -> select(node, 0, 0)
            KeyEvent.KEYCODE_MOVE_END, KeyEvent.KEYCODE_DPAD_DOWN -> select(node, t.length, t.length)
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                val ime = Build.VERSION.SDK_INT >= 30 && node.actionList.any { it.id == android.R.id.accessibilityActionImeEnter }
                if (ime) node.performAction(android.R.id.accessibilityActionImeEnter)
                else if (node.isMultiLine) insert(node, t, s, e, "\n")
            }
            else -> {
                val ch = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).get(code, meta and (KeyEvent.META_SHIFT_MASK or KeyEvent.META_CAPS_LOCK_ON))
                if (ch > 0 && ch and KeyCharacterMap.COMBINING_ACCENT == 0) insert(node, t, s, e, ch.toChar().toString())
            }
        }
    }

    // The field's text (not its hint, which some fields report as their text while empty).
    private fun text(node: AccessibilityNodeInfo): String =
        if (Build.VERSION.SDK_INT >= 26 && node.isShowingHintText) "" else node.text?.toString() ?: ""

    private fun insert(node: AccessibilityNodeInfo, t: String, s: Int, e: Int, add: String) =
        setText(node, t.substring(0, s) + add + t.substring(e), s + add.length)

    private fun setText(node: AccessibilityNodeInfo, t: String, cursor: Int) {
        node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, t)
        })
        select(node, cursor, cursor)
    }

    private fun select(node: AccessibilityNodeInfo, s: Int, e: Int) {
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, s)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, e)
        })
    }
}

// The session's side: phone.in to the service, phone.input {on, via} to the computer, the ask.
// via: how the computer's mouse and keyboard reach this phone, "adb" (wireless debugging, else this
// service) or "phone" (always this service: Wi-Fi, direct Wi-Fi or Bluetooth, no developer options).
// The same choice as on the computer: whichever side changes it last (phone.input.via from there).
// "auto" until one is picked: ADB once wireless debugging is there, else Accessibility, whose
// permission is asked for only then.
class Input(core: Core) : Feature(core) {
    val on get() = InputService.running != null
    val via get() = core.store.prefsString("inputVia", "auto")
    // What the computer's mouse and keyboard go through now.
    val effective get() = if (via == "auto") (if (core.adb.wifiDebugging || core.adb.paired) "adb" else "phone") else via
    private var told: String? = null

    fun setVia(v: String) {
        if (v != "adb" && v != "phone" || v == via) return
        core.store.setPrefsString("inputVia", v)
        changed()
    }

    fun changed() {
        if (core.link.connected && told != "$on/$via") {
            told = "$on/$via"
            core.link.send(msg(Proto.T.PHONE_INPUT, "on" to on, "via" to via))
        }
        if (on) Notify.cancelInput(core.ctx)
        core.changed()
    }

    override fun onWelcome(host: Host) {
        told = null
        changed()
    }

    override fun onClosed() { told = null }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.PHONE_IN -> {
                val s = InputService.running ?: return true
                val x = m.optDouble("x", 0.0).toFloat()
                val y = m.optDouble("y", 0.0).toFloat()
                when (val a = m.optString("a")) {
                    "d", "m", "u" -> s.touch(a, x, y)
                    "s" -> s.scroll(x, y, m.optDouble("h", 0.0), m.optDouble("v", 0.0))
                    "k" -> s.key(m.optInt("d") == 1, m.optInt("k"), m.optInt("m"))
                }
            }
            Proto.T.PHONE_INPUT_ASK -> if (!on) Notify.input(core.ctx, core.host?.name ?: "Your computer") else changed()
            Proto.T.PHONE_INPUT_VIA -> {
                val v = m.optString("via")
                if (v == "adb" || v == "phone" || v == "auto") { core.store.setPrefsString("inputVia", v); told = "$on/$v"; core.changed() }
            }
            else -> return false
        }
        return true
    }

    // The Accessibility settings (the person finds TwinDesk there and switches it on).
    fun openSettings() {
        runCatching { core.ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
}
