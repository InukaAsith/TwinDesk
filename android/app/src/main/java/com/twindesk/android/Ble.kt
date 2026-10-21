// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Bluetooth LE, for a computer that isn't on this phone's network (shared/protocol.js P.BLE). The
// computer advertises the TwinDesk service; we scan for it, read INFO (its beacon), and stay
// connected to the ones we're paired with, saying hello on CTRL so the computer shows this phone
// nearby and can invite it. The session goes through a pipe: a 127.0.0.1 port here (Link connects
// its WSS there, as for the USB cable), whose bytes we write to UP and get back from DOWN. TLS, the
// pinned certificate and the token are the session's own, end to end.
package com.twindesk.android

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
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
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

@SuppressLint("MissingPermission") // every entry point checks allowed()
class Ble(
    private val ctx: Context,
    private val hello: () -> JSONObject, // {id, name, os}
    private val isPaired: (String) -> Boolean,
    private val onChange: () -> Unit,
    private val onInvite: (Found) -> Unit,
) {
    companion object {
        val SERVICE: UUID = UUID.fromString("b7f30001-2c4e-4d1a-9a57-3e8c2f6d0a91")
        val INFO: UUID = UUID.fromString("b7f30002-2c4e-4d1a-9a57-3e8c2f6d0a91")
        val CTRL: UUID = UUID.fromString("b7f30003-2c4e-4d1a-9a57-3e8c2f6d0a91")
        val UP: UUID = UUID.fromString("b7f30004-2c4e-4d1a-9a57-3e8c2f6d0a91")
        val DOWN: UUID = UUID.fromString("b7f30005-2c4e-4d1a-9a57-3e8c2f6d0a91")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        const val STALE_MS = 20000L
        const val RETRY_MS = 15000L // a computer we couldn't read: try it again after this

        fun permissions(): Array<String> = if (Build.VERSION.SDK_INT >= 31)
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    // When the computer last sent anything down a pipe: a big message takes a while through
    // Bluetooth, and the session's liveness counts its bytes, not only whole messages (Link.bleRx).
    @Volatile var lastDown = 0L

    // Computers near: host id -> Found (address "ble:<mac>").
    val found = ConcurrentHashMap<String, Found>()
    @Volatile var scanning = false; private set
    private val conns = ConcurrentHashMap<String, Conn>() // device MAC -> connection
    private val tried = ConcurrentHashMap<String, Long>() // device MAC -> when we last connected to read it
    private val manager get() = ctx.getSystemService(BluetoothManager::class.java)

    fun allowed(): Boolean = permissions().all { ctx.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    val radioOn: Boolean get() = runCatching { manager?.adapter?.isEnabled == true }.getOrDefault(false)

    fun get(id: String): Found? = found[id]

    // ---- scanning ----

    private val scanCb = object : ScanCallback() {
        override fun onScanResult(type: Int, r: ScanResult) = seen(r.device)
        override fun onBatchScanResults(results: MutableList<ScanResult>) { for (r in results) seen(r.device) }
        override fun onScanFailed(code: Int) { Log.w("TwinDesk", "ble: scan failed $code"); scanning = false }
    }

    fun scan(on: Boolean) {
        if (on == scanning) return
        val sc = runCatching { manager?.adapter?.bluetoothLeScanner }.getOrNull()
        if (on) {
            if (!allowed() || !radioOn || sc == null) return
            val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()
            val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_POWER).build()
            runCatching { sc.startScan(listOf(filter), settings, scanCb); scanning = true }.onFailure { Log.w("TwinDesk", "ble: scan: ${it.message}") }
        } else {
            scanning = false
            runCatching { sc?.stopScan(scanCb) }
        }
    }

    // An advertisement: a computer we know by its address stays fresh; a new one is read once.
    private fun seen(d: BluetoothDevice) {
        val mac = d.address
        val f = found.values.find { it.address == "ble:$mac" }
        if (f != null) {
            found[f.id] = f.copy(lastSeen = System.currentTimeMillis())
            if (isPaired(f.id) && conns[mac] == null) connect(d) // keep a link to paired computers (invites)
            return
        }
        if (conns[mac] != null || System.currentTimeMillis() - (tried[mac] ?: 0) < RETRY_MS) return
        tried[mac] = System.currentTimeMillis()
        connect(d)
    }

    fun prune() {
        val now = System.currentTimeMillis()
        var changed = false
        for ((id, f) in found) {
            val mac = f.address.removePrefix("ble:")
            if (now - f.lastSeen > STALE_MS && conns[mac]?.ready != true) { found.remove(id); changed = true }
        }
        if (changed) onChange()
    }

    // keep: stay connected even if not paired (pairing goes through the pipe).
    private fun connect(d: BluetoothDevice, keep: Boolean = false) {
        if (!allowed()) return
        val c = Conn(d, keep)
        conns[d.address] = c
        c.start()
    }

    // A pipe to the computer with this id: the 127.0.0.1 port for the session's socket, or null.
    fun open(id: String, timeoutMs: Long = 15000): Int? {
        val f = found[id] ?: return null
        val mac = f.address.removePrefix("ble:")
        var c = conns[mac]
        if (c == null) {
            val d = runCatching { manager.adapter.getRemoteDevice(mac) }.getOrNull() ?: return null
            connect(d, keep = true)
            c = conns[mac] ?: return null
        }
        return c.openPipe(timeoutMs)
    }

    // On the same Wi-Fi as the computer (Core.bleTick): links without a pipe go.
    fun trim() {
        for (c in conns.values.toList()) if (!c.piped) c.close()
    }

    fun stop() {
        scan(false)
        for (c in conns.values) c.close()
        conns.clear()
        found.clear()
    }

    // ---- one computer ----

    private inner class Conn(val dev: BluetoothDevice, val keep: Boolean) {
        @Volatile var gatt: BluetoothGatt? = null
        @Volatile var ready = false
        @Volatile var hostId = ""
        private var mtu = 23
        private var ctrl: BluetoothGattCharacteristic? = null
        private var up: BluetoothGattCharacteristic? = null
        // GATT does one operation at a time: each waits for its own callback (a latch per operation,
        // so a late callback can't let the next one start early, which Android refuses as busy).
        private val ops = LinkedBlockingDeque<Pair<String, () -> Boolean>>()
        @Volatile private var opLatch = java.util.concurrent.CountDownLatch(0)
        @Volatile private var opKind = "" // the callback the running operation waits for
        @Volatile private var alive = true
        private val readyWait = java.util.concurrent.CountDownLatch(1)
        // The pipe: its socket here, and whether the computer opened its end.
        @Volatile private var sock: Socket? = null
        val piped get() = sock != null
        @Volatile private var pipeGen = 0 // the pipe a queued UP chunk belongs to: a closed pipe's never go out
        @Volatile private var opened: java.util.concurrent.CountDownLatch? = null
        private val upSlots = java.util.concurrent.Semaphore(16) // UP writes in flight

        fun start() {
            thread(name = "td-ble-ops", isDaemon = true) { opLoop() }
            gatt = runCatching {
                dev.connectGatt(ctx, false, cb, BluetoothDevice.TRANSPORT_LE)
            }.getOrNull()
            if (gatt == null) close()
        }

        private fun opLoop() {
            while (alive) {
                val (kind, op) = ops.poll(1, TimeUnit.SECONDS) ?: continue
                val latch = java.util.concurrent.CountDownLatch(1)
                opKind = kind
                opLatch = latch
                val started = runCatching { op() }.getOrDefault(false)
                if (started && !latch.await(5, TimeUnit.SECONDS)) Log.w("TwinDesk", "ble: GATT $kind timed out")
            }
        }

        // A callback: it ends the running operation only if it's the one that operation waits for.
        private fun opDone(kind: String) { if (kind == opKind) opLatch.countDown() }

        private fun op(kind: String, block: () -> Boolean) = ops.add(kind to block)

        private val cb = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) {
                if (state == BluetoothProfile.STATE_CONNECTED) {
                    op("mtu") { g.requestMtu(517) }
                } else if (state == BluetoothProfile.STATE_DISCONNECTED) close()
            }

            override fun onMtuChanged(g: BluetoothGatt, m: Int, status: Int) {
                mtu = if (status == BluetoothGatt.GATT_SUCCESS) m else 23
                opDone("mtu")
                op("services") { g.discoverServices() }
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                opDone("services")
                val s = g.getService(SERVICE) ?: return close()
                ctrl = s.getCharacteristic(CTRL)
                up = s.getCharacteristic(UP)
                val info = s.getCharacteristic(INFO) ?: return close()
                op("read") { g.readCharacteristic(info) }
            }

            @Deprecated("API < 33")
            override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
                @Suppress("DEPRECATION") onRead(g, c.value ?: ByteArray(0), status)
            }

            override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) = onRead(g, value, status)

            override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
                if (c.uuid == UP) upSlots.release()
                opDone("write")
            }

            override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) { opDone("descriptor") }

            @Deprecated("API < 33")
            override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
                @Suppress("DEPRECATION") onNotify(c.uuid, c.value ?: return)
            }

            override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) = onNotify(c.uuid, value)
        }

        private fun onRead(g: BluetoothGatt, value: ByteArray, status: Int) {
            opDone("read")
            val o = runCatching { JSONObject(String(value)) }.getOrNull()
            val id = o?.optString("id").orEmpty()
            if (status != BluetoothGatt.GATT_SUCCESS || id.isEmpty()) return close()
            hostId = id
            val os = o!!.optString("os", "mac")
            val f = Found(id, o.optString("name").take(100).ifEmpty { "Computer" }, os, "ble:${dev.address}",
                o.optInt("port", Proto.PORT), Proto.normFingerprint(o.optString("fp")), System.currentTimeMillis(), false)
            val old = found[id]
            found[id] = f
            if (old == null || old.name != f.name || old.address != f.address) onChange()
            if (!isPaired(id) && !keep) { close(); return } // listed for pairing; connected again for that
            // Paired: listen on CTRL (invites) and DOWN (the pipe), and say who we are.
            for (uuid in listOf(CTRL, DOWN)) {
                val c = g.getService(SERVICE)?.getCharacteristic(uuid) ?: continue
                g.setCharacteristicNotification(c, true)
                val d = c.getDescriptor(CCCD) ?: continue
                op("descriptor") { writeDescriptor(g, d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) }
            }
            ctrlWrite(hello().put("op", "hello"))
            op("") { ready = true; readyWait.countDown(); false }
        }

        private fun onNotify(uuid: UUID, value: ByteArray) {
            if (uuid == DOWN) {
                lastDown = System.currentTimeMillis()
                val s = sock ?: return
                runCatching { s.getOutputStream().write(value) }.onFailure { closePipe(false) }
                return
            }
            if (uuid != CTRL) return
            val o = runCatching { JSONObject(String(value)) }.getOrNull() ?: return
            when (o.optString("op")) {
                "invite" -> found[hostId]?.let { onInvite(it.copy(invited = true)) }
                "closed" -> closePipe(false)
            }
        }

        fun openPipe(timeoutMs: Long): Int? {
            if (!readyWait.await(timeoutMs, TimeUnit.MILLISECONDS)) return null
            closePipe(true)
            val latch = java.util.concurrent.CountDownLatch(1)
            opened = latch
            val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
            thread(name = "td-ble-pipe", isDaemon = true) {
                val s = runCatching { server.soTimeout = timeoutMs.toInt(); server.accept() }.getOrNull()
                runCatching { server.close() }
                if (s == null) return@thread
                s.tcpNoDelay = true
                sock = s
                pipeGen++
                gatt?.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                ctrlWrite(JSONObject().put("op", "open"))
                pump(s)
            }
            return server.localPort
        }

        // The session's bytes to UP, in MTU-sized writes, at most upSlots in flight.
        private fun pump(s: Socket) {
            val buf = ByteArray(4096)
            val max = (mtu - 3).coerceIn(20, 512) // an attribute value is at most 512 bytes
            val input = s.getInputStream()
            val gen = pipeGen
            while (alive && sock === s) {
                val n = runCatching { input.read(buf) }.getOrDefault(-1)
                if (n < 0) break
                var i = 0
                while (i < n && sock === s) {
                    val len = minOf(max, n - i)
                    val chunk = buf.copyOfRange(i, i + len)
                    i += len
                    if (!upSlots.tryAcquire(10, TimeUnit.SECONDS)) { Log.w("TwinDesk", "ble: UP stalled"); closePipe(true); return }
                    op("write") {
                        if (pipeGen != gen || sock !== s) { upSlots.release(); return@op false } // that pipe is over
                        // Acknowledged writes: a write without response may be dropped (macOS does under
                        // load), and one lost byte breaks the session's TLS.
                        val ok = writeRetry(up, chunk, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
                        if (!ok) { // a lost chunk breaks the TLS stream: end this pipe (nothing after it goes)
                            Log.w("TwinDesk", "ble: UP write failed, closing the pipe")
                            upSlots.release()
                            if (sock === s) closePipe(true)
                        }
                        ok
                    }
                }
            }
            if (sock === s) closePipe(true)
        }

        private fun ctrlWrite(o: JSONObject) {
            val c = ctrl ?: return
            val bytes = o.toString().toByteArray()
            op("write") { writeRetry(c, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) }
        }

        // Android refuses a write while its own buffers are full: try again for a while (3 s).
        private fun writeRetry(c: BluetoothGattCharacteristic?, v: ByteArray, type: Int): Boolean {
            c ?: return false
            repeat(300) {
                val g = gatt ?: return false
                if (writeChr(g, c, v, type)) return true
                Thread.sleep(10)
            }
            return false
        }

        private fun closePipe(tell: Boolean) {
            val s = sock ?: return
            Log.i("TwinDesk", "ble: pipe closed${if (tell) "" else " by the computer"}")
            sock = null
            pipeGen++
            runCatching { s.close() }
            if (tell && alive) ctrlWrite(JSONObject().put("op", "close"))
            gatt?.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_BALANCED)
        }

        fun close() {
            if (!alive) return
            alive = false
            ready = false
            runCatching { sock?.close() }
            sock = null
            runCatching { gatt?.disconnect(); gatt?.close() }
            gatt = null
            conns.remove(dev.address, this)
            readyWait.countDown()
        }

        @Suppress("DEPRECATION")
        private fun writeChr(g: BluetoothGatt, c: BluetoothGattCharacteristic, v: ByteArray, type: Int): Boolean =
            if (Build.VERSION.SDK_INT >= 33) g.writeCharacteristic(c, v, type) == BluetoothGatt.GATT_SUCCESS
            else { c.writeType = type; c.value = v; g.writeCharacteristic(c) }

        @Suppress("DEPRECATION")
        private fun writeDescriptor(g: BluetoothGatt, d: BluetoothGattDescriptor, v: ByteArray): Boolean =
            if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(d, v) == BluetoothGatt.GATT_SUCCESS
            else { d.value = v; g.writeDescriptor(d) }
    }
}
