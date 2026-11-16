// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Linked with Android: this phone's computer, linked through Android's own companion
// device chooser (CompanionDeviceManager). While a computer is linked, Android itself lets TwinDesk
// run and use data in the background and start its service from there: no battery optimization
// prompt, and the phone maker's "app killer" leaves it alone.
//
// The chooser lists a TwinDesk computer that's looking for phones over Bluetooth (its window open,
// Bluetooth on: shared/blepolicy.js) and computers already paired with this phone over Bluetooth.
//
// Start TwinDesk when it's near (off unless switched on, Android 12+): Android watches for the linked
// computer with its own Bluetooth scanning (nothing of ours runs), and binds CompanionPresence when it
// shows up; TwinDesk then starts and connects as it does after a restart.
package com.twindesk.android

import android.annotation.SuppressLint
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanFilter
import android.companion.AssociationInfo
import android.companion.AssociationRequest
import android.companion.BluetoothDeviceFilter
import android.companion.BluetoothLeDeviceFilter
import android.companion.CompanionDeviceManager
import android.companion.CompanionDeviceService
import android.companion.DevicePresenceEvent
import android.companion.ObservingDevicePresenceRequest
import android.content.Context
import android.content.IntentSender
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log

object CompanionLink {
    data class Linked(val id: Int, val mac: String, val name: String)

    private fun cdm(ctx: Context): CompanionDeviceManager? =
        if (ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_COMPANION_DEVICE_SETUP)) ctx.getSystemService(CompanionDeviceManager::class.java) else null

    fun supported(ctx: Context) = cdm(ctx) != null
    fun canWatch() = Build.VERSION.SDK_INT >= 31

    @SuppressLint("MissingPermission")
    fun linked(ctx: Context): List<Linked> {
        val m = cdm(ctx) ?: return emptyList()
        return runCatching {
            if (Build.VERSION.SDK_INT >= 33) m.myAssociations.mapNotNull { a ->
                val mac = a.deviceMacAddress?.toString()?.uppercase() ?: return@mapNotNull null
                Linked(a.id, mac, a.displayName?.toString()?.takeIf { it.isNotBlank() } ?: btName(ctx, mac) ?: mac)
            } else @Suppress("DEPRECATION") m.associations.map { mac -> Linked(0, mac.uppercase(), btName(ctx, mac) ?: mac) }
        }.getOrDefault(emptyList())
    }

    @SuppressLint("MissingPermission")
    private fun btName(ctx: Context, mac: String): String? = runCatching {
        ctx.getSystemService(BluetoothManager::class.java)?.adapter?.getRemoteDevice(mac)?.name
    }.getOrNull()

    // Android's chooser: TwinDesk computers looking for phones over Bluetooth LE, and computers this
    // phone is paired with over Bluetooth. ask(sender): show it (an activity result launcher).
    @SuppressLint("MissingPermission")
    fun link(ctx: Context, ask: (IntentSender) -> Unit, failed: (String) -> Unit) {
        val m = cdm(ctx) ?: return failed("unsupported")
        val b = AssociationRequest.Builder()
            .addDeviceFilter(BluetoothLeDeviceFilter.Builder().setScanFilter(ScanFilter.Builder().setServiceUuid(ParcelUuid(Ble.SERVICE)).build()).build())
        val bonded = runCatching {
            ctx.getSystemService(BluetoothManager::class.java)?.adapter?.bondedDevices.orEmpty()
                .filter { it.bluetoothClass?.majorDeviceClass == BluetoothClass.Device.Major.COMPUTER }
        }.getOrDefault(emptyList())
        for (d in bonded) b.addDeviceFilter(BluetoothDeviceFilter.Builder().setAddress(d.address).build())
        val req = b.setSingleDevice(false).build()
        runCatching {
            if (Build.VERSION.SDK_INT >= 33) {
                m.associate(req, ctx.mainExecutor, object : CompanionDeviceManager.Callback() {
                    override fun onAssociationPending(sender: IntentSender) = ask(sender)
                    override fun onAssociationCreated(info: AssociationInfo) { watch(ctx) }
                    override fun onFailure(error: CharSequence?) = failed(error?.toString() ?: "")
                })
            } else {
                @Suppress("DEPRECATION")
                m.associate(req, object : CompanionDeviceManager.Callback() {
                    @Deprecated("Android 12 and older")
                    override fun onDeviceFound(sender: IntentSender) = ask(sender)
                    override fun onFailure(error: CharSequence?) = failed(error?.toString() ?: "")
                }, Handler(Looper.getMainLooper()))
            }
        }.onFailure { failed(it.message ?: "") }
    }

    fun remove(ctx: Context, l: Linked) {
        val m = cdm(ctx) ?: return
        unwatch(ctx, l)
        runCatching { if (Build.VERSION.SDK_INT >= 33 && l.id != 0) m.disassociate(l.id) else @Suppress("DEPRECATION") m.disassociate(l.mac) }
    }

    // ---- Start TwinDesk when it's near ----

    fun near(ctx: Context) = canWatch() && Core.get(ctx).store.flag("companion.near", false)
    fun setNear(ctx: Context, on: Boolean) {
        Core.get(ctx).store.setFlag("companion.near", on)
        if (on) watch(ctx) else linked(ctx).forEach { unwatch(ctx, it) }
    }

    // Asks Android to watch for every linked computer (again after a new link; it remembers).
    fun watch(ctx: Context) {
        if (!near(ctx)) return
        val m = cdm(ctx) ?: return
        for (l in linked(ctx)) runCatching {
            if (Build.VERSION.SDK_INT >= 36 && l.id != 0) m.startObservingDevicePresence(ObservingDevicePresenceRequest.Builder().setAssociationId(l.id).build())
            else @Suppress("DEPRECATION") m.startObservingDevicePresence(l.mac)
        }.onFailure { Log.w("TwinDesk", "companion watch: ${it.message}") }
    }

    private fun unwatch(ctx: Context, l: Linked) {
        val m = cdm(ctx) ?: return
        if (!canWatch()) return
        runCatching {
            if (Build.VERSION.SDK_INT >= 36 && l.id != 0) m.stopObservingDevicePresence(ObservingDevicePresenceRequest.Builder().setAssociationId(l.id).build())
            else @Suppress("DEPRECATION") m.stopObservingDevicePresence(l.mac)
        }
    }

    @Volatile private var lastNear = 0L
    // The linked computer showed up: TwinDesk starts (General › Run in the background permitting) and
    // looks for it at once.
    fun appeared(ctx: Context) {
        if (!near(ctx)) return
        val now = System.currentTimeMillis()
        if (now - lastNear < 30_000) return // one appearance, several callbacks
        lastNear = now
        val core = Core.get(ctx)
        if (!core.background || core.bank.pending || core.store.flag("exited", false)) return // closed (Exit, a banking app): stays closed
        Log.i("TwinDesk", "companion: the linked computer is near")
        TwinService.start(ctx)
        core.bg.execute { core.near() }
    }
}

// Bound by Android while a linked computer is near (CompanionLink.watch). No work of its own.
class CompanionPresence : CompanionDeviceService() {
    override fun onDeviceAppeared(info: AssociationInfo) = CompanionLink.appeared(this)

    @Deprecated("Android 12")
    override fun onDeviceAppeared(address: String) = CompanionLink.appeared(this)

    override fun onDevicePresenceEvent(event: DevicePresenceEvent) {
        if (event.event == DevicePresenceEvent.EVENT_BLE_APPEARED || event.event == DevicePresenceEvent.EVENT_BT_CONNECTED) CompanionLink.appeared(this)
    }
}

