// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This device as the computer's remote (the Remote page): a touchpad and keyboard, or a gamepad
// whose sticks and buttons press the computer's keys. RemoteActivity shows remote.html, which
// sends remote.* straight to the computer; the computer moves its pointer and types while it lets
// this device control it (remote.state says whether it does, and why not). Windows, Mac and Linux;
// an older TwinDesk on a Mac or Linux doesn't answer, and the page says so.
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
    @Volatile var why = ""; private set // why it doesn't take it now (the computer says), "" when it does
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

    // An older TwinDesk on a Mac or Linux doesn't take the remote (it never answers remote.hello).
    val unsupported: Boolean get() = allowed == null && active && core.host?.os.let { it == "mac" || it == "linux" }

    // What each gamepad control presses: a KeyboardEvent.code, "Mouse0/1/2" (left, right, middle), or "".
    fun padKey(id: String): String = overrides().optString(id, DEFAULTS[id] ?: "")
    fun setPad(id: String, code: String) {
        core.store.setPrefsString("remote.pad", overrides().put(id, code).toString())
        push()
    }
    fun resetPad() { core.store.setPrefsString("remote.pad", "{}"); push() }

    // The gamepad's layout (its Edit, remote.js): {items: {id: {x, y, s, hide, label}}, custom: [{id, label, key, x, y, s}]},
    // x and y the control's middle as a share of the screen. Kept as the page wrote it (checked to be JSON, 32 KB at most).
    fun layout(): JSONObject = runCatching { JSONObject(core.store.prefsString("remote.layout", "{}")) }.getOrDefault(JSONObject())
    fun setLayout(json: String) {
        if (json.length > 32_000) return
        val o = runCatching { JSONObject(json) }.getOrNull() ?: return
        core.store.setPrefsString("remote.layout", o.toString())
    }
    private fun overrides(): JSONObject = runCatching { JSONObject(core.store.prefsString("remote.pad", "{}")) }.getOrDefault(JSONObject())
    private fun padMap(): JSONObject = JSONObject().also { o -> for ((id, _) in CONTROLS) o.put(id, padKey(id)) }

    fun opts(): JSONObject {
        ble = core.link.ble
        return msg("opts", "mode" to mode, "name" to (core.host?.name ?: tr("the computer")), "me" to core.store.deviceName, "connected" to (core.host != null),
            "os" to (core.host?.os ?: ""), "ble" to core.link.ble, "speed" to speed.toDouble(), "tap" to tapClick, "smooth" to smooth, "pad" to padMap(), "layout" to layout(),
            "bt" to (core.btPadMade && core.btPad.connected), "btName" to (if (core.btPadMade) core.btPad.hostName else ""),
            // The gamepad's Keys: its controls and what each can press.
            "controls" to org.json.JSONArray(CONTROLS.map { org.json.JSONArray(listOf(it.first, it.second)) }),
            "keys" to org.json.JSONArray(KEYS.map { org.json.JSONArray(listOf(it.first, it.second)) }))
    }

    // As a Bluetooth gamepad (BtPad) connected or not: an open page follows.
    fun btChanged() {
        host?.post(opts())
        core.changed()
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
        why = m.optString("why")
        host?.post(m)
        core.changed()
        return true
    }

    companion object {
        // The gamepad's controls, in the order the Remote page lists them.
        val CONTROLS get() = listOf(
            "lsUp" to tr("Left stick up"), "lsLeft" to tr("Left stick left"), "lsDown" to tr("Left stick down"), "lsRight" to tr("Left stick right"),
            "l3" to "L3", "r3" to "R3",
            "a" to "A", "b" to "B", "x" to "X", "y" to "Y",
            "lb" to "LB", "rb" to "RB", "lt" to "LT", "rt" to "RT",
            "up" to tr("D-pad up"), "down" to tr("D-pad down"), "left" to tr("D-pad left"), "right" to tr("D-pad right"),
            "back" to tr("gamepad|Back"), "start" to tr("gamepad|Start"),
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
        val KEYS: List<Pair<String, String>> get() = buildList {
            add("" to tr("Nothing"))
            add("Mouse0" to tr("Left click")); add("Mouse1" to tr("Right click")); add("Mouse2" to tr("Middle click"))
            for (c in 'A'..'Z') add("Key$c" to "$c")
            for (d in 0..9) add("Digit$d" to "$d")
            addAll(listOf(
                "Space" to tr("Space"), "Enter" to "Enter", "Escape" to "Esc", "Tab" to "Tab", "Backspace" to "Backspace",
                "ShiftLeft" to "Shift", "ControlLeft" to "Ctrl", "AltLeft" to "Alt",
                "ArrowUp" to tr("Up arrow"), "ArrowDown" to tr("Down arrow"), "ArrowLeft" to tr("Left arrow"), "ArrowRight" to tr("Right arrow"),
                "Minus" to "-", "Equal" to "=", "BracketLeft" to "[", "BracketRight" to "]", "Semicolon" to ";", "Quote" to "'",
                "Comma" to ",", "Period" to ".", "Slash" to "/", "Backquote" to "`",
            ))
            for (f in 1..12) add("F$f" to "F$f")
            addAll(listOf("Insert" to "Insert", "Delete" to "Delete", "Home" to "Home", "End" to "End", "PageUp" to "Page Up", "PageDown" to "Page Down"))
        }

        fun keyName(code: String): String = KEYS.firstOrNull { it.first == code }?.second ?: code
    }
}

// Full screen: the touchpad and keyboard (any way up), the gamepad (held sideways), or voice typing.
class RemoteActivity : ComponentActivity() {
    private var host: WebHost? = null
    private var mode = "pad"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mode = when (intent.getStringExtra("mode")) { "gamepad" -> "gamepad"; "voice" -> "voice"; else -> "pad" }
        if (mode == "gamepad") requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Voice typing keeps the system bars, and the page sits inside them and above the keyboard
        // (edge to edge is enforced, so by the insets: below), its box and keys in sight while
        // Gboard's microphone listens.
        if (mode != "voice") {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            WindowInsetsControllerCompat(window, window.decorView).apply {
                hide(WindowInsetsCompat.Type.systemBars())
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }
        val h = WebHost(this, "remote.html", Core.get(this)) { ev, _ ->
            when (ev) {
                "close" -> finish()
                // The touchpad's Rotate: sideways and back (the gamepad is always sideways).
                "rotate" -> requestedOrientation =
                    if (resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE) ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
                    else ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
                "keyboard" -> host?.keyboard(true)
                "padReset" -> Core.get(this).remote.resetPad() // the gamepad's Keys › Reset
                "keyboardOff" -> host?.keyboard(false)
            }
        }
        host = h
        if (mode == "voice") {
            val frame = android.widget.FrameLayout(this).apply { setBackgroundColor(android.graphics.Color.rgb(11, 11, 13)) }
            frame.addView(h.view, android.widget.FrameLayout.LayoutParams(-1, -1))
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(frame) { v, ins ->
                val b = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
                v.setPadding(b.left, b.top, b.right, b.bottom)
                WindowInsetsCompat.CONSUMED
            }
            setContentView(frame)
        } else setContentView(h.view)
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
