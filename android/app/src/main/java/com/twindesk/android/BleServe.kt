// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Bluetooth LE the other way round, for a PC whose Bluetooth can't advertise reliably (Ble.kt finds
// computers that advertise): this phone advertises P.BLE.PHONE_SERVICE and serves the same
// characteristics, and the PC connects to it (shared/blepipe.js BlePhones). The PC says hello on
// CTRL with its beacon (listed under Nearby), and a pipe opens when it sends {op: open}: because
// its person pressed Pair or Connect (an invite), or because we asked ({op: want}, our Pair or
// Connect). The PC writes UP, we notify DOWN; the session (TLS, pinned certificate, token) is
// still ours to the PC's server, through a 127.0.0.1 port here as for Ble.kt's pipes.
package com.twindesk.android

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import org.json.JSONObject
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

@SuppressLint("MissingPermission") // every entry point checks allowed()
class BleServe(
    private val ctx: Context,
    private val hello: () -> JSONObject, // {id, name, os}
    private val onChange: () -> Unit,
    // A PC opened a pipe without our asking (its Pair or Connect): the port to connect the session
    // to is ready. False: not taken (busy, or not paired: shown as an invite), the pipe closes.
    private val onOpen: (Found, Int) -> Boolean,
) {
    companion object {
        val PHONE_SERVICE: UUID = UUID.fromString("b7f30006-2c4e-4d1a-9a57-3e8c2f6d0a91")

        fun permissions(): Array<String> = if (Build.VERSION.SDK_INT >= 31)
            arrayOf(Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
        else emptyArray()
    }

    // Bytes from a PC through a pipe count as alive (Link.bleRx), as Ble.lastDown does.
    @Volatile var lastRx = 0L

    // PCs connected to us that said hello: host id -> Found (address "blp:<mac>").
    val found = ConcurrentHashMap<String, Found>()
    private val peers = ConcurrentHashMap<String, Peer>() // device MAC -> state
    private val manager get() = ctx.getSystemService(BluetoothManager::class.java)
    private var server: BluetoothGattServer? = null
    private var ctrl: BluetoothGattCharacteristic? = null
    private var down: BluetoothGattCharacteristic? = null
    @Volatile private var advertising = false
    private val notes = LinkedBlockingQueue<Triple<BluetoothDevice, BluetoothGattCharacteristic, ByteArray>>()
    private val noteSent = Semaphore(0)
    // A Linux computer's writes: their responses go from here until Android takes one (respond), and
    // notifications wait for them meanwhile.
    private val responses = LinkedBlockingQueue<() -> Unit>()
    private val responding = AtomicInteger()

    fun allowed(): Boolean = permissions().all { ctx.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    fun get(id: String): Found? = found[id]

    init {
        thread(name = "td-blp-notify", isDaemon = true) { notifyLoop() }
        thread(name = "td-blp-respond", isDaemon = true) { while (true) responses.take()() }
    }

    // ---- advertising ----

    private val advCb = object : AdvertiseCallback() {
        override fun onStartSuccess(s: AdvertiseSettings) { Log.i("TwinDesk", "blp: advertising") }
        override fun onStartFailure(code: Int) { Log.w("TwinDesk", "blp: advertising failed $code"); advertising = false }
    }

    // On while a PC may want us (not connected); the server stays up for the PCs already linked.
    fun advertise(on: Boolean) {
        if (on == advertising) return
        val adv = runCatching { manager?.adapter?.bluetoothLeAdvertiser }.getOrNull()
        if (on) {
            if (!allowed() || adv == null || !openServer()) return
            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .setConnectable(true)
                .setTimeout(0)
                .build()
            val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(PHONE_SERVICE)).setIncludeDeviceName(false).build()
            runCatching { adv.startAdvertising(settings, data, advCb); advertising = true }.onFailure { Log.w("TwinDesk", "blp: advertise: ${it.message}") }
        } else {
            advertising = false
            runCatching { adv?.stopAdvertising(advCb) }
        }
    }

    // On the same Wi-Fi as the PC (Core.bleTick): PCs linked without a pipe are let go.
    fun trim() {
        for (p in peers.values.toList()) if (!p.piped) runCatching { server?.cancelConnection(p.dev) } // onConnectionStateChange cleans up
    }

    // Bluetooth off for TwinDesk: no advertising, no PCs.
    fun stop() {
        advertise(false)
        for (p in peers.values) p.closePipe(false)
        peers.clear()
        found.clear()
        runCatching { server?.close() }
        server = null
    }

    private fun openServer(): Boolean {
        if (server != null) return true
        val s = runCatching { manager.openGattServer(ctx, cb) }.getOrNull() ?: return false
        val svc = BluetoothGattService(PHONE_SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        svc.addCharacteristic(BluetoothGattCharacteristic(Ble.INFO, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ))
        val c = BluetoothGattCharacteristic(Ble.CTRL, BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_NOTIFY, BluetoothGattCharacteristic.PERMISSION_WRITE)
        c.addDescriptor(cccd())
        svc.addCharacteristic(c)
        svc.addCharacteristic(BluetoothGattCharacteristic(Ble.UP, BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE, BluetoothGattCharacteristic.PERMISSION_WRITE))
        val d = BluetoothGattCharacteristic(Ble.DOWN, BluetoothGattCharacteristic.PROPERTY_NOTIFY, 0)
        d.addDescriptor(cccd())
        svc.addCharacteristic(d)
        added = CountDownLatch(1)
        if (!s.addService(svc)) { runCatching { s.close() }; return false }
        added.await(3, TimeUnit.SECONDS)
        server = s
        ctrl = s.getService(PHONE_SERVICE)?.getCharacteristic(Ble.CTRL)
        down = s.getService(PHONE_SERVICE)?.getCharacteristic(Ble.DOWN)
        return true
    }

    @Volatile private var added = CountDownLatch(0)

    private fun cccd() = BluetoothGattDescriptor(Ble.CCCD, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE)

    // ---- our Pair or Connect: ask the PC for a pipe ----

    // The 127.0.0.1 port for the session's socket once the PC opened its end, or null.
    fun open(id: String, timeoutMs: Long = 15000): Int? {
        val f = found[id] ?: return null
        val p = peers[f.address.removePrefix("blp:")] ?: return null
        val latch = CountDownLatch(1)
        p.asked = latch
        p.ctrlNote(JSONObject().put("op", "want"))
        if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) { p.asked = null; return null }
        return p.listen()
    }

    // ---- the GATT server ----

    private val cb = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService) { added.countDown() }

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) peers.getOrPut(device.address) { Peer(device) }
            else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                val p = peers.remove(device.address) ?: return
                p.closePipe(false)
                if (found.values.removeIf { it.address == "blp:${device.address}" }) onChange()
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) { peers[device.address]?.mtu = mtu }

        override fun onCharacteristicReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, c: BluetoothGattCharacteristic) {
            val s = server ?: return
            if (c.uuid != Ble.INFO) { s.sendResponse(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null); return }
            val v = hello().toString().toByteArray()
            if (offset > v.size) { s.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null); return }
            s.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, v.copyOfRange(offset, v.size))
        }

        override fun onCharacteristicWriteRequest(device: BluetoothDevice, requestId: Int, c: BluetoothGattCharacteristic, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?) {
            val p = peers.getOrPut(device.address) { Peer(device) }
            val v = value ?: ByteArray(0)
            when (c.uuid) {
                Ble.UP -> p.up(v)
                Ble.CTRL -> p.onCtrl(v)
            }
            if (responseNeeded) respond(p, device, requestId, offset, v)
        }

        override fun onDescriptorWriteRequest(device: BluetoothDevice, requestId: Int, d: BluetoothGattDescriptor, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?) {
            if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
        }

        override fun onDescriptorReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, d: BluetoothGattDescriptor) {
            server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) { noteSent.release() }
    }

    // A write's response. To Linux, until Android takes it: it refuses one while a notification of ours
    // is on its way ("Sending response failed"), the bytes taken already, and Linux waited 30 s for it
    // with the session stalled, then ended the pipe. Not from this callback: Android hands us its
    // callbacks one at a time, and onNotificationSent, which ends the refusing, would wait behind it.
    // Windows and the Mac get theirs as they always did.
    private fun respond(p: Peer, device: BluetoothDevice, requestId: Int, offset: Int, value: ByteArray) {
        if (p.os != "linux") { server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value); return }
        responding.incrementAndGet()
        responses.put {
            var ok = false
            repeat(400) {
                if (ok) return@repeat
                val s = server ?: return@repeat
                ok = runCatching { s.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value) }.getOrDefault(false)
                if (!ok) Thread.sleep(5)
            }
            if (!ok) Log.w("TwinDesk", "blp: a write's response didn't go out")
            responding.decrementAndGet()
        }
    }

    // Notifications go one at a time: the next waits for the last one's onNotificationSent, and for a
    // response on its way to Linux (respond).
    private fun notifyLoop() {
        while (true) {
            val (dev, c, v) = notes.take()
            var waited = 0
            while (responding.get() > 0 && waited++ < 1500) Thread.sleep(2)
            val s = server ?: continue
            noteSent.drainPermits()
            var ok = false
            repeat(100) {
                if (ok) return@repeat
                ok = runCatching {
                    if (Build.VERSION.SDK_INT >= 33) s.notifyCharacteristicChanged(dev, c, false, v) == BluetoothGatt.GATT_SUCCESS
                    else {
                        @Suppress("DEPRECATION") c.value = v
                        @Suppress("DEPRECATION") s.notifyCharacteristicChanged(dev, c, false)
                    }
                }.getOrDefault(false)
                if (!ok) Thread.sleep(10)
            }
            if (!ok) { peers[dev.address]?.closePipe(true); continue }
            noteSent.tryAcquire(2, TimeUnit.SECONDS)
        }
    }

    // One PC connected to us.
    private inner class Peer(val dev: BluetoothDevice) {
        @Volatile var mtu = 23
        @Volatile var os = "" // its hello's: "linux" gets its responses sent until Android takes them (respond)
        @Volatile var asked: CountDownLatch? = null // our open(): waiting for the PC's {op: open}
        @Volatile private var sock: Socket? = null
        @Volatile private var listener: ServerSocket? = null // waiting for the session's socket
        val piped get() = sock != null || listener != null
        @Volatile private var gen = 0 // the pipe a DOWN chunk belongs to
        private val pending = java.io.ByteArrayOutputStream() // UP before the session's socket connected

        fun ctrlNote(o: JSONObject) {
            val c = ctrl ?: return
            notes.add(Triple(dev, c, o.toString().toByteArray()))
        }

        fun onCtrl(v: ByteArray) {
            val o = runCatching { JSONObject(String(v)) }.getOrNull() ?: return
            when (o.optString("op")) {
                "hello" -> {
                    val id = o.optString("id")
                    if (id.isEmpty()) return
                    os = o.optString("os", "win")
                    val f = Found(id.take(64), o.optString("name").take(100).ifEmpty { "Computer" }, o.optString("os", "win"), "blp:${dev.address}",
                        o.optInt("port", Proto.PORT), Proto.normFingerprint(o.optString("fp")), System.currentTimeMillis(), false)
                    val old = found[f.id]
                    found[f.id] = f
                    if (old == null || old.name != f.name || old.address != f.address) onChange()
                }
                "open" -> {
                    val a = asked
                    if (a != null) { asked = null; a.countDown(); return } // the answer to our want
                    val f = found.values.find { it.address == "blp:${dev.address}" }
                    if (f == null) { ctrlNote(JSONObject().put("op", "closed")); return }
                    val port = listen()
                    if (!onOpen(f, port)) closePipe(true)
                }
                "close" -> closePipe(false)
            }
        }

        // The session's socket connects here; its bytes go DOWN, UP's come back to it.
        fun listen(): Int {
            closePipe(false)
            val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
            listener = server
            thread(name = "td-blp-pipe", isDaemon = true) {
                val s = runCatching { server.soTimeout = 15000; server.accept() }.getOrNull()
                runCatching { server.close() }
                if (listener !== server) { runCatching { s?.close() }; return@thread } // closed meanwhile
                listener = null
                if (s == null) { ctrlNote(JSONObject().put("op", "closed")); return@thread }
                s.tcpNoDelay = true
                synchronized(pending) {
                    sock = s
                    gen++
                    if (pending.size() > 0) runCatching { s.getOutputStream().write(pending.toByteArray()) }
                    pending.reset()
                }
                pump(s, gen)
            }
            return server.localPort
        }

        fun up(v: ByteArray) {
            lastRx = System.currentTimeMillis()
            synchronized(pending) {
                val s = sock
                if (s == null) { if (pending.size() < 1 shl 20) pending.write(v); return }
                runCatching { s.getOutputStream().write(v) }.onFailure { closePipe(true) }
            }
        }

        private fun pump(s: Socket, g: Int) {
            val buf = ByteArray(4096)
            val input = s.getInputStream()
            val c = down ?: return closePipe(true)
            while (sock === s && gen == g) {
                val n = runCatching { input.read(buf) }.getOrDefault(-1)
                if (n < 0) break
                val max = (mtu - 3).coerceIn(20, 512) // an attribute value is at most 512 bytes
                var i = 0
                while (i < n) {
                    val len = minOf(max, n - i)
                    notes.add(Triple(dev, c, buf.copyOfRange(i, i + len)))
                    i += len
                }
                while (notes.size > 64 && sock === s) Thread.sleep(5) // don't run far ahead of the radio
            }
            if (sock === s) closePipe(true)
        }

        fun closePipe(tell: Boolean) {
            synchronized(pending) {
                pending.reset()
                val l = listener
                listener = null
                runCatching { l?.close() }
                val s = sock
                if (s == null && l == null) return
                sock = null
                gen++
                runCatching { s?.close() }
            }
            Log.i("TwinDesk", "blp: pipe closed${if (tell) "" else " by the PC"}")
            if (tell) ctrlNote(JSONObject().put("op", "closed"))
        }
    }
}
