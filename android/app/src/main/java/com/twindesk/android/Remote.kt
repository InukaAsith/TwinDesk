// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This device as the computer's remote (the Remote page): a touchpad and keyboard, or a gamepad
// whose sticks and buttons press the computer's keys. RemoteActivity shows remote.html, which
// sends remote.* straight to the computer; the computer moves its pointer and types while it lets
// this device control it (remote.state says whether it does). Windows only for now: a Mac or
// Linux doesn't answer, and the page says so.
package com.twindesk.android

import android.content.pm.ActivityInfo
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.util.Locale

class Remote(core: Core) : Feature(core) {
    @Volatile var allowed: Boolean? = null; private set // the computer's last answer; null: not asked yet (or no answer)
    @Volatile var active = false; private set // RemoteActivity is in front
    private var host: WebHost? = null
    private var mode = "pad"
    @Volatile private var ble: Boolean? = null // what the page was last told (through Bluetooth it sends moves less often)

    // The touchpad's pointer speed (also the gamepad's right stick and the screen viewer's touchpad).
    val speed: Float get() = core.store.prefsString("remote.speed", "1.0").toFloatOrNull()?.coerceIn(0.3f, 3f) ?: 1f
    fun setSpeed(v: Float) { core.store.setPrefsString("remote.speed", String.format(Locale.ROOT, "%.2f", v)); push() }

    // The computer eases each move out over about a frame (even motion, a frame later) instead of jumping.
    val smooth: Boolean get() = core.store.flag("remote.smooth", true)
    fun setSmooth(on: Boolean) { core.store.setFlag("remote.smooth", on); push() }

    // A quick tap left-clicks (a slide never does). Off: only the click buttons click.
    val tapClick: Boolean get() = core.store.flag("remote.tapClick", true)
    fun setTapClick(on: Boolean) { core.store.setFlag("remote.tapClick", on); push() }

    // A Mac or Linux computer doesn't take the remote yet (it never answers remote.hello).
    val unsupported: Boolean get() = allowed == null && core.host?.os.let { it == "mac" || it == "linux" }

    // What each gamepad control presses: a KeyboardEvent.code, "Mouse0/1/2" (left, right, middle), or "".
    fun padKey(id: String): String = overrides().optString(id, DEFAULTS[id] ?: "")
    fun setPad(id: String, code: String) {
        core.store.setPrefsString("remote.pad", overrides().put(id, code).toString())
        push()
    }
    fun resetPad() { core.store.setPrefsString("remote.pad", "{}"); push() }
    private fun overrides(): JSONObject = runCatching { JSONObject(core.store.prefsString("remote.pad", "{}")) }.getOrDefault(JSONObject())
    private fun padMap(): JSONObject = JSONObject().also { o -> for ((id, _) in CONTROLS) o.put(id, padKey(id)) }

    fun opts(): JSONObject {
        ble = core.link.ble
        return msg("opts", "mode" to mode, "name" to (core.host?.name ?: "the computer"), "me" to core.store.deviceName, "connected" to (core.host != null),
            "os" to (core.host?.os ?: ""), "ble" to core.link.ble, "speed" to speed.toDouble(), "tap" to tapClick, "smooth" to smooth, "pad" to padMap())
    }

    private fun push() {
        host?.post(opts())
        core.screen.repost()
        core.changed()
    }

    // The session moved between Bluetooth and Wi-Fi (Core.onChange): an open page follows.
    fun linkChanged() {
        if (host != null && ble != core.link.ble) host?.post(opts())
    }

    private fun hello() { if (core.link.connected) core.send(msg(Proto.T.REMOTE_HELLO)) }

    fun attach(h: WebHost, mode: String) {
        host = h
        this.mode = mode
        active = true
        h.post(opts())
        allowed?.let { h.post(msg(Proto.T.REMOTE_STATE, "allowed" to it)) }
        hello()
        core.changed()
    }

    fun detach(h: WebHost) {
        if (host !== h) return
        host = null
        active = false
        if (core.link.connected) core.send(msg(Proto.T.REMOTE_RELEASE))
        core.changed()
    }

    override fun onWelcome(host: Host) {
        allowed = null
        this.host?.post(opts())
        if (active) hello()
    }

    override fun onClosed() {
        allowed = null
        host?.post(opts())
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t != Proto.T.REMOTE_STATE) return false
        allowed = m.optBoolean("allowed", false)
        host?.post(m)
        core.changed()
        return true
    }

    companion object {
        // The gamepad's controls, in the order the Remote page lists them.
        val CONTROLS = listOf(
            "lsUp" to "Left stick up", "lsLeft" to "Left stick left", "lsDown" to "Left stick down", "lsRight" to "Left stick right",
            "l3" to "L3", "r3" to "R3",
            "a" to "A", "b" to "B", "x" to "X", "y" to "Y",
            "lb" to "LB", "rb" to "RB", "lt" to "LT", "rt" to "RT",
            "up" to "D-pad up", "down" to "D-pad down", "left" to "D-pad left", "right" to "D-pad right",
            "back" to "Back", "start" to "Start",
        )

        // Common PC game keys: move on WASD, jump on A, aim and fire on the triggers.
        val DEFAULTS = mapOf(
            "lsUp" to "KeyW", "lsLeft" to "KeyA", "lsDown" to "KeyS", "lsRight" to "KeyD",
            "l3" to "ShiftLeft", "r3" to "KeyV",
            "a" to "Space", "b" to "ControlLeft", "x" to "KeyR", "y" to "KeyE",
            "lb" to "KeyQ", "rb" to "KeyF", "lt" to "Mouse1", "rt" to "Mouse0",
            "up" to "ArrowUp", "down" to "ArrowDown", "left" to "ArrowLeft", "right" to "ArrowRight",
            "back" to "Tab", "start" to "Escape",
        )

        // What a control can press (the picker's list).
        val KEYS: List<Pair<String, String>> = buildList {
            add("" to "Nothing")
            add("Mouse0" to "Left click"); add("Mouse1" to "Right click"); add("Mouse2" to "Middle click")
            for (c in 'A'..'Z') add("Key$c" to "$c")
            for (d in 0..9) add("Digit$d" to "$d")
            addAll(listOf(
                "Space" to "Space", "Enter" to "Enter", "Escape" to "Esc", "Tab" to "Tab", "Backspace" to "Backspace",
                "ShiftLeft" to "Shift", "ControlLeft" to "Ctrl", "AltLeft" to "Alt",
                "ArrowUp" to "Up arrow", "ArrowDown" to "Down arrow", "ArrowLeft" to "Left arrow", "ArrowRight" to "Right arrow",
                "Minus" to "-", "Equal" to "=", "BracketLeft" to "[", "BracketRight" to "]", "Semicolon" to ";", "Quote" to "'",
                "Comma" to ",", "Period" to ".", "Slash" to "/", "Backquote" to "`",
            ))
            for (f in 1..12) add("F$f" to "F$f")
            addAll(listOf("Insert" to "Insert", "Delete" to "Delete", "Home" to "Home", "End" to "End", "PageUp" to "Page Up", "PageDown" to "Page Down"))
        }

        fun keyName(code: String): String = KEYS.firstOrNull { it.first == code }?.second ?: code
    }
}

// Full screen: the touchpad and keyboard (any way up), or the gamepad (held sideways).
class RemoteActivity : ComponentActivity() {
    private var host: WebHost? = null
    private var mode = "pad"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mode = if (intent.getStringExtra("mode") == "gamepad") "gamepad" else "pad"
        if (mode == "gamepad") requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        val h = WebHost(this, "remote.html", Core.get(this)) { ev, _ ->
            when (ev) {
                "close" -> finish()
                "keyboard" -> host?.keyboard(true)
                "keyboardOff" -> host?.keyboard(false)
            }
        }
        host = h
        setContentView(h.view)
    }

    override fun onStart() {
        super.onStart()
        host?.let { Core.get(this).remote.attach(it, mode) }
    }

    override fun onStop() {
        super.onStop()
        host?.let { Core.get(this).remote.detach(it) }
    }

    override fun onDestroy() {
        host?.destroy()
        host = null
        super.onDestroy()
    }
}
