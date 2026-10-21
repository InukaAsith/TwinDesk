// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Calls, Messages, Photos and Files on the computer (shared/phonehub.js there). Each is off until it is
// switched on (its page on the computer, or Overview here), and while it's off nothing of it runs:
// no receiver, no observer, no thread, and the classes that do the work (Calls.kt, Messages.kt,
// Media.kt, FsBrowse.kt) aren't even made. Switched off, or the session gone: all of it stops at once.
// What each needs is asked for when it's switched on (here, or Allow at the top of its page on
// the computer), never in Setup.
package com.twindesk.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Process
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class Hub(core: Core) : Feature(core) {
    // What the computer has on (hub.policy). Nothing until a computer that knows these says so.
    @Volatile var peer = false; private set
    @Volatile var callsOn = false; private set
    @Volatile var messagesOn = false; private set
    @Volatile var mediaOn = false; private set
    @Volatile var filesOn = false; private set // the computer browses this phone's storage (All files access)
    @Volatile var btAudio = false; private set // the computer takes calls' sound over Bluetooth
    @Volatile private var btAddress = "" // the computer's Bluetooth address (hub.bt)
    private var lastState = ""

    private var calls: Calls? = null
    private var messages: Messages? = null
    private var media: Media? = null
    private var fs: FsBrowse? = null

    // One background thread for the three's queries: made when one is first used, gone when all are off.
    private var io: ExecutorService? = null

    fun on(what: String) = when (what) { "calls" -> callsOn; "messages" -> messagesOn; "media" -> mediaOn; "files" -> filesOn; else -> false }

    fun run(block: () -> Unit) {
        val e = synchronized(this) {
            io ?: Executors.newSingleThreadExecutor { r ->
                Thread({ Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); r.run() }, "td-hub").apply { isDaemon = true }
            }.also { io = it }
        }
        runCatching { e.execute { runCatching(block).onFailure { Log.e("TwinDesk", "hub", it) } } }
    }

    // A new session, or none: all off until the computer says (hub.policy).
    private fun reset() {
        peer = false
        callsOn = false; messagesOn = false; mediaOn = false; filesOn = false; btAudio = false
        btAddress = ""
        lastState = ""
        apply()
    }

    override fun onWelcome(host: Host) = reset()

    override fun onClosed() = reset()

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.HUB_POLICY -> {
                peer = true
                callsOn = m.optBoolean("calls")
                messagesOn = m.optBoolean("messages")
                mediaOn = m.optBoolean("media")
                filesOn = m.optBoolean("files")
                btAudio = m.optBoolean("bt")
                apply()
                lastState = ""
                sendState()
                core.changed()
            }
            Proto.T.HUB_ASK -> ask(m.str("what", 20))
            Proto.T.HUB_BT -> {
                m.str("address", 17).uppercase().let { if (it.isNotEmpty()) btAddress = it }
                if (m.optBoolean("unpair")) core.bg.execute { unpairBt() } // the computer's Forget
                sendState()
            }
            Proto.T.CALL_DO -> calls?.act(m) ?: core.send(msg(Proto.T.CALL_DONE, "a" to m.str("a", 20), "ok" to false, "error" to "off"))
            Proto.T.CALL_LOG -> calls?.let { c -> run { core.send(msg(Proto.T.CALL_LOG, "items" to c.log(m.optInt("n", 100)))) } }
            Proto.T.CONTACTS -> calls?.let { c -> val q = m.str("q", 80); run { core.send(msg(Proto.T.CONTACTS, "q" to q, "items" to c.contacts(q))) } }
            Proto.T.SMS_THREADS -> messages?.let { s -> run { core.send(msg(Proto.T.SMS_THREADS, "items" to s.threads(m.optInt("n", 60)))) } }
            Proto.T.SMS_THREAD -> messages?.let { s -> run { core.send(s.thread(m)) } }
            Proto.T.SMS_PART -> messages?.let { s -> val id = m.str("id", 40); run { core.send(msg(Proto.T.SMS_PART, "id" to id, "data" to s.part(id))) } }
            Proto.T.SMS_SEND -> messages?.send(m) ?: core.send(msg(Proto.T.SMS_SENT, "ref" to m.str("ref", 60), "ok" to false, "error" to "off"))
            // Pictures never go through Bluetooth (they held up everything else): USB, Wi-Fi, Wi-Fi Direct.
            Proto.T.MEDIA_LIST -> if (mediaOn && !core.link.ble) media().let { md -> run { core.send(md.list(m)) } }
            Proto.T.MEDIA_THUMB -> if (mediaOn && !core.link.ble) media().thumbs(m.optJSONArray("ids"))
            Proto.T.MEDIA_VIEW -> if (mediaOn && !core.link.ble) media().let { md -> val id = m.str("id", 40); run { core.send(msg(Proto.T.MEDIA_VIEW, "id" to id, "data" to md.view(id))) } }
            Proto.T.MEDIA_SAVE -> if (mediaOn) media().let { md -> val ids = m.optJSONArray("ids"); run { md.save(ids) } }
            Proto.T.FS_LIST -> if (filesOn) fs().let { f -> run { core.send(f.list(m)) } }
            Proto.T.FS_DO -> if (filesOn) fs().let { f -> run { core.send(f.act(m)) } }
            Proto.T.FS_SAVE -> if (filesOn) fs().let { f -> val paths = m.optJSONArray("paths"); run { f.save(paths) } }
            Proto.T.FS_EXPECT -> if (filesOn) fs().expect(m.str("batch", 64), m.str("path", 1000))
            else -> return false
        }
        return true
    }

    private fun media(): Media = media ?: Media(this, core).also { media = it }

    private fun fs(): FsBrowse = fs ?: FsBrowse(core).also { fs = it }

    // Starts what's on (with what it needs allowed) and stops what's off. Called again when
    // permissions change: start() does nothing when already running.
    private fun apply() {
        val live = core.link.connected && peer
        if (live && callsOn) (calls ?: Calls(this, core).also { calls = it }).start() else { calls?.stop(); calls = null }
        if (live && messagesOn) (messages ?: Messages(this, core).also { messages = it }).start() else { messages?.stop(); messages = null }
        if (!(live && mediaOn)) { media?.stop(); media = null }
        if (!(live && filesOn)) fs = null
        if (!(live && (callsOn || messagesOn || mediaOn || filesOn))) synchronized(this) { io?.shutdownNow(); io = null }
        watchBonds(live && callsOn && btAudio)
    }

    // The person switched one here: the computer follows (it keeps the setting).
    fun set(what: String, on: Boolean) {
        when (what) { "calls" -> callsOn = on; "messages" -> messagesOn = on; "media" -> mediaOn = on; "files" -> filesOn = on; else -> return }
        apply()
        core.send(msg(Proto.T.HUB_SET, "what" to what, "on" to on))
        sendState()
        core.changed()
    }

    // Back from the permission prompt or Settings: start what can start now, and tell the computer.
    fun permsChanged() {
        if (!peer) return
        apply()
        sendState()
        core.changed()
    }

    fun sendState() {
        if (!peer || !core.link.connected) return
        val st = msg(
            Proto.T.HUB_STATE,
            "calls" to JSONObject().put("perm", perm("calls")).put("missing", jsonArray(missing("calls"))),
            "messages" to JSONObject().put("perm", perm("messages")).put("missing", jsonArray(missing("messages"))),
            "media" to JSONObject().put("perm", perm("media")),
            "files" to JSONObject().put("perm", perm("files")),
            "bt" to if (callsOn) bt() else JSONObject(),
            "opens" to Settings.canDrawOverlays(core.ctx), // Allow on the computer opens the prompt here (else a notification)
        )
        val key = st.toString()
        if (key == lastState) return
        lastState = key
        core.send(st)
        core.changed() // the app's pages show the same (pairing for calls' sound)
    }

    fun granted(p: String) = core.ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    // In this build at all (the SMS permissions are only in TwinDesk with notifications).
    private val declared: Set<String> by lazy {
        runCatching {
            core.ctx.packageManager.getPackageInfo(core.ctx.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions?.toSet()
        }.getOrNull() ?: emptySet()
    }

    // 'ok' | 'partial' (works, with something missing) | 'ask' | 'none' (not in this build).
    fun perm(what: String): String {
        val want = wanted(what)
        if (what == "messages" && Manifest.permission.READ_SMS !in declared) return "none"
        if (what == "media" && Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) return "ok"
        if (what == "files") return if (Build.VERSION.SDK_INT < 30) "none" else if (FsBrowse.allowed()) "ok" else "ask"
        val have = want.filter { granted(it) }
        return when {
            have.size == want.size -> "ok"
            what == "media" && Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> "partial"
            granted(main(what)) -> "partial"
            else -> "ask"
        }
    }

    // What's missing, by what it does: state, numbers, dial, answer, contacts; read, send.
    fun missing(what: String): List<String> = wanted(what).filter { !granted(it) }.map {
        when (it) {
            Manifest.permission.READ_PHONE_STATE -> "state"
            Manifest.permission.READ_CALL_LOG -> "numbers"
            Manifest.permission.CALL_PHONE -> "dial"
            Manifest.permission.ANSWER_PHONE_CALLS -> "answer"
            Manifest.permission.READ_CONTACTS -> "contacts"
            Manifest.permission.READ_SMS -> "read"
            Manifest.permission.SEND_SMS -> "send"
            else -> "media"
        }
    }

    // The person on the phone is asked (the computer's Allow): the prompt opens straight away when
    // Android lets us (display over other apps, or TwinDesk on screen), else a notification.
    private fun ask(what: String) {
        if (what !in listOf("calls", "messages", "media", "files", "bt")) return
        val i = Intent(core.ctx, PermActivity::class.java).putExtra("what", what).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Settings.canDrawOverlays(core.ctx) || MainActivity.shown) runCatching { core.ctx.startActivity(i) }
        else Notify.hubAsk(core.ctx, what, core.host?.name ?: "Your computer")
    }

    // ---- Bluetooth: calls' sound on the computer needs this phone paired with it ----
    // Over classic Bluetooth (BR/EDR): hands-free runs only there. The person pairs them in Bluetooth
    // settings (the Calls pages say how): TwinDesk doesn't pair them itself. A pairing over Bluetooth
    // LE only (le below) can't carry a call: Forget, on either side, starts over.

    @Volatile private var bonding = false // pairing with the computer right now
    @Volatile private var forget = false // the old pairing has to be forgotten in Settings first
    private var bondWatch: BroadcastReceiver? = null

    // For the app's Calls page: the pairing as the computer sees it (bt()), Bluetooth settings and Forget from here.
    val btKnown get() = btAddress.isNotEmpty()
    fun btState(): JSONObject = bt()
    fun btSettings() = runCatching { core.ctx.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }

    // Forget from here: both forget each other (this phone, then the computer: phonehub.js, which
    // opens its Bluetooth settings), and Bluetooth settings open here, to pair them again.
    fun forgetBt() {
        core.bg.execute {
            if (unpairBt()) btSettings() // else they opened already, to forget it there
            core.send(msg(Proto.T.HUB_BT, "unpair" to true))
            core.changed()
        }
    }

    // The app's own pages: ask here (the prompt, or All files access in Settings).
    fun askHere(what: String) = runCatching {
        core.ctx.startActivity(Intent(core.ctx, PermActivity::class.java).putExtra("what", what).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @SuppressLint("MissingPermission")
    private fun bt(): JSONObject {
        val o = JSONObject()
        if (Build.VERSION.SDK_INT >= 31 && !granted(Manifest.permission.BLUETOOTH_CONNECT)) return o.put("allowed", false)
        val a = core.ctx.getSystemService(BluetoothManager::class.java)?.adapter ?: return o.put("none", true)
        o.put("allowed", true).put("radio", a.isEnabled).put("name", runCatching { a.name }.getOrNull() ?: "")
            .put("bonding", bonding).put("forget", forget)
        if (btAddress.isNotEmpty()) {
            val d = runCatching { a.bondedDevices.find { it.address.equals(btAddress, true) } }.getOrNull()
            val le = d != null && runCatching { d.type == BluetoothDevice.DEVICE_TYPE_LE }.getOrDefault(false)
            o.put("bonded", d != null && !le).put("le", le)
        }
        return o
    }

    // While the computer takes calls' sound: told when this phone's pairing with it changes (paired in
    // the computer's Bluetooth settings, or forgotten), so the computer connects, or says why, at once.
    @Synchronized
    private fun watchBonds(on: Boolean) {
        if (on == (bondWatch != null)) return
        if (!on) {
            bondWatch?.let { r -> runCatching { core.ctx.unregisterReceiver(r) } }
            bondWatch = null
            bonding = false
            return
        }
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                @Suppress("DEPRECATION")
                val dev = i.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE) ?: return
                if (btAddress.isEmpty() || !dev.address.equals(btAddress, true)) return
                val s = i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1)
                bonding = s == BluetoothDevice.BOND_BONDING
                if (s == BluetoothDevice.BOND_NONE) forget = false
                sendState()
            }
        }
        runCatching { core.ctx.registerReceiver(r, IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED)) }.onSuccess { bondWatch = r }
    }

    // Forget: this phone forgets the computer, over classic Bluetooth and LE (one pairing in Android).
    // False when Android keeps it for itself: its Bluetooth settings open, to forget it there (forget).
    @SuppressLint("MissingPermission")
    private fun unpairBt(): Boolean {
        if (btAddress.isEmpty() || Build.VERSION.SDK_INT >= 31 && !granted(Manifest.permission.BLUETOOTH_CONNECT)) return true
        val a = core.ctx.getSystemService(BluetoothManager::class.java)?.adapter ?: return true
        val d = runCatching { a.getRemoteDevice(btAddress) }.getOrNull() ?: return true
        forget = false
        if (d.bondState != BluetoothDevice.BOND_NONE && !unbond(d)) {
            Log.i("TwinDesk", "bt: can't forget $btAddress here")
            btSettings()
            forget = true
            sendState()
            return false
        }
        core.bg.schedule({ lastState = ""; sendState() }, 1500, java.util.concurrent.TimeUnit.MILLISECONDS)
        return true
    }

    // Android's removeBond isn't public: true when it took it.
    private fun unbond(d: BluetoothDevice): Boolean =
        runCatching { BluetoothDevice::class.java.getMethod("removeBond").invoke(d) as Boolean }.getOrDefault(false)

    companion object {
        // Everything each one uses.
        fun wanted(what: String): List<String> = when (what) {
            "calls" -> listOf(Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CALL_LOG, Manifest.permission.CALL_PHONE,
                Manifest.permission.ANSWER_PHONE_CALLS, Manifest.permission.READ_CONTACTS)
            "messages" -> listOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.READ_CONTACTS)
            "bt" -> if (Build.VERSION.SDK_INT >= 31) listOf(Manifest.permission.BLUETOOTH_CONNECT) else emptyList()
            "media" -> if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
                else listOf(Manifest.permission.READ_EXTERNAL_STORAGE)
            else -> emptyList()
        }

        // What's asked for (Android 14 adds "only the photos I choose").
        fun request(what: String): List<String> = wanted(what) +
            if (what == "media" && Build.VERSION.SDK_INT >= 34) listOf(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) else emptyList()

        // Without this one it doesn't work at all.
        fun main(what: String): String = when (what) {
            "calls" -> Manifest.permission.READ_PHONE_STATE
            "messages" -> Manifest.permission.READ_SMS
            else -> wanted(what).first()
        }

        fun label(what: String) = when (what) { "calls" -> "Calls"; "messages" -> "Messages"; "files" -> "Files"; "bt" -> "Calls on the computer"; else -> "Photos and videos" }
    }
}

// Invisible: Android's own prompt for what Calls, Messages or Photos need (or Nearby devices, to
// see the pairing for calls' sound; Files: All files access in Settings). Refused for good
// before (Android won't ask again): TwinDesk's page in Settings instead.
class PermActivity : Activity() {
    private var what = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        what = intent.getStringExtra("what") ?: ""
        Notify.cancelHubAsk(this)
        val core = Core.get(this)
        // Files: All files access is a page in Settings, not a prompt (back: MainActivity.onResume).
        if (what == "files") {
            if (!FsBrowse.allowed()) runCatching {
                startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            core.hub.permsChanged()
            finish()
            return
        }
        val want = Hub.request(what).filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (what.isEmpty() || want.isEmpty() || core.hub.perm(what) == "none") { core.hub.permsChanged(); finish(); return }
        if (core.store.flag("hub.refused.$what", false) && want.none { shouldShowRequestPermissionRationale(it) }) {
            runCatching {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            finish()
            return
        }
        requestPermissions(want.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val core = Core.get(this)
        val refused = permissions.filterIndexed { i, _ -> grantResults.getOrNull(i) != PackageManager.PERMISSION_GRANTED }
        // Only some photos chosen: Android asks again next time (the person may want more).
        val chose = what == "media" && core.hub.perm("media") == "partial"
        core.store.setFlag("hub.refused.$what", !chose && refused.isNotEmpty() && refused.none { shouldShowRequestPermissionRationale(it) })
        core.hub.permsChanged()
        finish()
    }
}
