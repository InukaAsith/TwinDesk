// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Remote › As a Bluetooth gamepad: this device as a Bluetooth game controller (Android's HID device
// profile), for any computer, the Mac too, with no driver and without TwinDesk there. While it's on,
// the app is registered as a gamepad (16 buttons, a hat, two sticks, two triggers); the person pairs
// this device in the computer's Bluetooth settings once, and after that it connects by itself. While
// a computer is connected, the Remote page's gamepad sends its state here (TD.pad) and it goes out
// as HID reports. Some phones' makers leave the profile out: the switch then says so. Created only
// when the Remote page first asks for it.
package com.twindesk.android

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.pm.PackageManager
import android.os.Build
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

@SuppressLint("MissingPermission") // start() checks allowed()
class BtPad(private val core: Core) {
    companion object {
        private const val RING = 16 // reports waiting at most (about a quarter of a second of frames)

        fun permissions(): Array<String> = if (Build.VERSION.SDK_INT >= 31)
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
        else emptyArray()

        // Report 1: 16 buttons (A B X Y LB RB Back Start L3 R3 …), a hat (0..7, 8 = none), X Y Z Rz
        // (the sticks, 16 bits each), then the brake and accelerator (the triggers, 0..255): 13 bytes.
        private val DESCRIPTOR = byteArrayOf(
            0x05, 0x01, 0x09, 0x05, 0xA1.toByte(), 0x01, // Generic Desktop, Game Pad, Application
            0x85.toByte(), 0x01, // Report ID 1
            0x05, 0x09, 0x19, 0x01, 0x29, 0x10, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95.toByte(), 0x10, 0x81.toByte(), 0x02, // 16 buttons
            0x05, 0x01, 0x09, 0x39, 0x15, 0x00, 0x25, 0x07, 0x35, 0x00, 0x46, 0x3B, 0x01, 0x65, 0x14, // the hat, in degrees
            0x75, 0x04, 0x95.toByte(), 0x01, 0x81.toByte(), 0x42, 0x65, 0x00, // …with a null state
            0x75, 0x04, 0x95.toByte(), 0x01, 0x81.toByte(), 0x03, // 4 bits of padding
            0x09, 0x30, 0x09, 0x31, 0x09, 0x32, 0x09, 0x35, // X Y Z Rz
            0x16, 0x01, 0x80.toByte(), 0x26, 0xFF.toByte(), 0x7F, 0x75, 0x10, 0x95.toByte(), 0x04, 0x81.toByte(), 0x02, // -32767..32767
            0x05, 0x02, 0x09, 0xC5.toByte(), 0x09, 0xC4.toByte(), // Simulation: Brake, Accelerator
            0x15, 0x00, 0x26, 0xFF.toByte(), 0x00, 0x75, 0x08, 0x95.toByte(), 0x02, 0x81.toByte(), 0x02, // 0..255
            0xC0.toByte(),
        )
        private const val ID: Byte = 1
    }

    // off · starting · unavailable (no HID device profile here) · ready (waiting for a computer) · connected
    @Volatile var state = "off"; private set
    @Volatile var message = ""; private set
    @Volatile var hostName = ""; private set
    val on: Boolean get() = core.store.flag("remote.btpad", false)
    val connected: Boolean get() = state == "connected"

    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "td-btpad").apply { isDaemon = true } }
    private val manager get() = core.ctx.getSystemService(BluetoothManager::class.java)
    private var hid: BluetoothHidDevice? = null
    @Volatile private var device: BluetoothDevice? = null
    // The current report (nothing held, the hat centred), and the reports on their way out: a ring of
    // buffers made once, so the gamepad page's frames (pad(), about 60 a second) allocate nothing. The
    // io thread sends them in order; with all of them waiting (the radio stalled), the newest waiting
    // one is overwritten instead. Guarded by `ring`.
    private val report = ByteArray(13).also { it[2] = 8 }
    private val ring = Array(RING) { ByteArray(13) }
    private var head = 0 // next slot to fill
    private var tail = 0 // next slot to send
    private var draining = false
    private val drain = Runnable {
        while (true) {
            val r = synchronized(ring) {
                if (tail == head) { draining = false; null } else ring[tail % RING]
            } ?: return@Runnable
            val d = device; val h = hid
            if (d != null && h != null) runCatching { h.sendReport(d, ID.toInt(), r) } // binder: copied before it returns
            synchronized(ring) { tail++ } // only now may pad() fill that slot again
        }
    }

    fun allowed(): Boolean = permissions().all { core.ctx.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun set(s: String, why: String = message) {
        state = s
        message = why
        core.remote.btChanged()
    }

    // The Remote page's switch (permissions asked first, there).
    fun setOn(v: Boolean) {
        core.store.setFlag("remote.btpad", v)
        if (v) start() else stop()
    }

    // Registered while it's on (the Remote page calls this whenever it's shown).
    fun start() {
        if (!on || state != "off" && state != "unavailable") return
        if (!allowed()) return set("off", tr("Allow Nearby devices for TwinDesk first"))
        val adapter = manager?.adapter
        if (adapter == null || !adapter.isEnabled) return set("off", tr("Turn on Bluetooth first"))
        set("starting", "")
        val asked = adapter.getProfileProxy(core.ctx, object : BluetoothProfile.ServiceListener {
            override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
                val h = proxy as BluetoothHidDevice
                hid = h
                if (!on) return stop()
                val sdp = BluetoothHidDeviceAppSdpSettings("TwinDesk Gamepad", "${core.store.deviceName} as a gamepad", "TwinDesk",
                    BluetoothHidDevice.SUBCLASS2_GAMEPAD, DESCRIPTOR)
                if (!h.registerApp(sdp, null, null, io, callback)) set("unavailable", tr("Another app is using this device as a Bluetooth keyboard or controller: turn that off first"))
            }
            override fun onServiceDisconnected(profile: Int) {
                hid = null
                device = null
                if (state != "off") set("off", tr("Bluetooth stopped: turn it on again"))
            }
        }, BluetoothProfile.HID_DEVICE)
        if (!asked) return set("unavailable", tr("This phone doesn’t offer Bluetooth controllers (its maker left the profile out)"))
        // No answer at all: the profile is there in name only.
        core.bg.schedule({ if (state == "starting" && hid == null) set("unavailable", tr("This phone doesn’t offer Bluetooth controllers (its maker left the profile out)")) }, 5, TimeUnit.SECONDS)
    }

    fun stop() {
        val h = hid
        hid = null
        device = null
        if (h != null) {
            runCatching { h.unregisterApp() }
            runCatching { manager?.adapter?.closeProfileProxy(BluetoothProfile.HID_DEVICE, h) }
        }
        set("off", "")
    }

    private val callback = object : BluetoothHidDevice.Callback() {
        override fun onAppStatusChanged(plugged: BluetoothDevice?, registered: Boolean) {
            if (!registered) {
                if (state != "off") set("off", if (on) tr("Android took the controller away: turn it off and on again") else "")
                return
            }
            set("ready", "")
            // The computer it was last with, if it's paired: connect again.
            val last = plugged ?: core.store.prefsString("remote.btpad.host", "").takeIf { it.isNotEmpty() }
                ?.let { a -> runCatching { manager?.adapter?.bondedDevices?.firstOrNull { it.address == a } }.getOrNull() }
            if (last != null) runCatching { hid?.connect(last) }
        }

        override fun onConnectionStateChanged(d: BluetoothDevice, s: Int) {
            when (s) {
                BluetoothProfile.STATE_CONNECTED -> {
                    device = d
                    hostName = runCatching { d.name }.getOrNull() ?: d.address
                    core.store.setPrefsString("remote.btpad.host", d.address)
                    set("connected", "")
                    sendCurrent()
                }
                BluetoothProfile.STATE_DISCONNECTED -> if (device == null || device?.address == d.address) {
                    device = null
                    if (state == "connected") set("ready", "")
                }
            }
        }

        override fun onGetReport(d: BluetoothDevice, type: Byte, id: Byte, bufferSize: Int) {
            hid?.replyReport(d, type, ID, synchronized(ring) { report.copyOf() })
        }
    }

    // The gamepad page's state (remote.js, as remote.pad): b the buttons (bits 0..13: A B X Y LB RB
    // Back Start L3 R3 Up Down Left Right), the sticks -1..1 (y down), the triggers 0..1.
    fun pad(b: Int, lx: Double, ly: Double, rx: Double, ry: Double, lt: Double, rt: Double) = synchronized(ring) {
        val r = report
        val was0 = r[0]; val was1 = r[1]; val was2 = r[2]
        r[0] = (b and 0xff).toByte()
        r[1] = (b shr 8 and 0x03).toByte() // L3, R3; the d-pad is the hat
        val up = b and (1 shl 10) != 0; val down = b and (1 shl 11) != 0
        val left = b and (1 shl 12) != 0; val right = b and (1 shl 13) != 0
        r[2] = when {
            up && right -> 1; down && right -> 3; down && left -> 5; up && left -> 7
            up -> 0; right -> 2; down -> 4; left -> 6; else -> 8
        }.toByte()
        var same = r[0] == was0 && r[1] == was1 && r[2] == was2
        same = axis(r, 3, lx) && same; same = axis(r, 5, ly) && same; same = axis(r, 7, rx) && same; same = axis(r, 9, ry) && same
        val l = (lt.coerceIn(0.0, 1.0) * 255).roundToInt().toByte()
        val t = (rt.coerceIn(0.0, 1.0) * 255).roundToInt().toByte()
        same = same && r[11] == l && r[12] == t
        r[11] = l; r[12] = t
        if (!same) queueLocked()
    }

    // Writes a stick axis (little-endian, -32767..32767) at i; true when it was already that.
    private fun axis(r: ByteArray, i: Int, v: Double): Boolean {
        val n = (v.coerceIn(-1.0, 1.0) * 32767).roundToInt()
        val lo = (n and 0xff).toByte(); val hi = (n shr 8 and 0xff).toByte()
        val same = r[i] == lo && r[i + 1] == hi
        r[i] = lo; r[i + 1] = hi
        return same
    }

    // The current report, out again (a computer just connected).
    private fun sendCurrent() = synchronized(ring) { queueLocked() }

    // Holding `ring`: a copy of the report goes in the ring, and the io thread drains it.
    private fun queueLocked() {
        if (device == null || hid == null) return
        val slot = if (head - tail >= RING) head - 1 else head++ // all waiting: the newest is replaced
        System.arraycopy(report, 0, ring[slot % RING], 0, 13)
        if (!draining) { draining = true; io.execute(drain) }
    }

    // Asks Android to let computers find this device (for pairing), from the Remote page.
    fun discoverableIntent() = android.content.Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE)
        .putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 120)
}
