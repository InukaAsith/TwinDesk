// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Internet over USB (#277; shared/tether.js and shared/tetherrelay.js on the computer): this phone
// uses the computer's internet through the cable, as gnirehtet does, with nothing else installed.
//   - As a session starts this says it can (tether.state {can: true}); a computer too old to know
//     it never offers, and nothing here runs.
//   - The computer offers (tether {on, port, token}) once it's switched on there and this phone
//     is on its cable with USB debugging: its relay is this phone's 127.0.0.1:<port> (adb reverse).
//   - A VPN (TetherVpn) takes every IPv4 packet the apps send and passes it, as it is, through
//     that one stream; the computer makes the connections. TwinDesk itself stays outside it. IPv6
//     isn't routed (apps use this phone's own networks for it).
//   - Android asks once for the VPN permission (TetherActivity, opened from a notification when the
//     app isn't in front). Refused, or Stop in the VPN's notification: switched off on the computer
//     (tether.set {on: false}).
//   - The cable unplugged, the session ended or tether {on: false}: the VPN stops and this phone is
//     back on its own networks.
// The stream proves both ends know the token first: TDT1 <nonce>, the computer's HMAC of it and its
// nonce, this phone's HMAC of that.
package com.twindesk.android

import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class Tether(core: Core) : Feature(core) {
    data class Offer(val port: Int, val token: String)

    @Volatile var offer: Offer? = null; private set
    @Volatile var state = "off"; private set // off | ask | starting | on | error
    @Volatile var why = ""; private set
    private var lastSent = ""

    override fun onWelcome(host: Host) {
        offer = null
        lastSent = ""
        TetherVpn.stop(core.ctx)
        set("off", "")
    }

    override fun onClosed() {
        offer = null
        TetherVpn.stop(core.ctx)
        Notify.nm(core.ctx).cancel(Notify.ID_TETHER)
        state = "off"
        why = ""
    }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        if (t != Proto.T.TETHER) return false
        val port = m.optInt("port")
        val token = m.str("token", 128)
        if (m.optBoolean("on") && port in 1..65535 && token.matches(Regex("[0-9a-f]{32,128}"))) {
            offer = Offer(port, token)
            start()
        } else {
            offer = null
            TetherVpn.stop(core.ctx)
            Notify.nm(core.ctx).cancel(Notify.ID_TETHER)
            set("off", "")
        }
        return true
    }

    // The VPN permission first (once), then the VPN.
    private fun start() {
        val ctx = core.ctx
        if (VpnService.prepare(ctx) == null) { launch(); return }
        set("ask", "")
        notifyAsk()
        // In front, or allowed to draw over other apps: the prompt opens by itself.
        if (inFront() || Settings.canDrawOverlays(ctx)) runCatching {
            ctx.startActivity(Intent(ctx, TetherActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private fun inFront() = runCatching {
        android.app.ActivityManager.RunningAppProcessInfo().also { android.app.ActivityManager.getMyMemoryState(it) }.importance <=
            android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }.getOrDefault(false)

    fun launch() {
        if (offer == null) return
        Notify.nm(core.ctx).cancel(Notify.ID_TETHER)
        set("starting", "")
        runCatching { core.ctx.startService(Intent(core.ctx, TetherVpn::class.java)) }
            .onFailure { set("error", it.message ?: "couldn’t start") }
    }

    // The VPN permission refused, or Stop: off here and on the computer.
    fun userStop(why: String = "") {
        offer = null
        TetherVpn.stop(core.ctx)
        Notify.nm(core.ctx).cancel(Notify.ID_TETHER)
        set("off", why)
        if (core.link.connected) core.send(msg(Proto.T.TETHER_SET, "on" to false))
    }

    // From TetherVpn: running, or stopped (and why).
    fun vpnState(s: String, w: String = "") {
        if (s == "off" && offer == null && state == "off") return
        set(s, w)
    }

    private fun set(s: String, w: String) {
        state = s
        why = w
        tell()
        core.changed()
    }

    fun tell() {
        if (!core.link.connected) return
        val m = msg(Proto.T.TETHER_STATE, "can" to true, "state" to state, "why" to why)
        val key = m.toString()
        if (key == lastSent) return
        lastSent = key
        core.send(m)
    }

    private fun notifyAsk() {
        val ctx = core.ctx
        val name = core.host?.name ?: tr("your computer")
        val open = PendingIntent.getActivity(ctx, 19, Intent(ctx, TetherActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = tr("This phone can use {name}’s internet through the USB cable. Tap Allow, then confirm Android’s VPN request.", "name" to name)
        runCatching {
            Notify.nm(ctx).notify(Notify.ID_TETHER, Notification.Builder(ctx, Notify.CH_INVITE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Use {name}’s internet?", "name" to name))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .addAction(Notification.Action.Builder(null, tr("Allow"), open).build())
                .addAction(Notification.Action.Builder(null, tr("Not now"), Notify.action(ctx, ActionReceiver.TETHER_STOP, 20)).build())
                .setOnlyAlertOnce(true)
                .build())
        }
    }

    companion object {
        const val PHONE_IP = "10.215.173.1"
        const val DNS_IP = "10.215.173.2" // the computer sends these queries to its own DNS server (tetherrelay.js)
        const val MTU = 16384 // as tetherrelay.js: big packets, fewer of them through adb

        fun hmac(key: String, s: String): String {
            val m = Mac.getInstance("HmacSHA256")
            m.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
            return m.doFinal(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        }
    }
}

// Android's VPN permission, asked from the front.
class TetherActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val core = Core.get(this)
        if (core.tether.offer == null) { finish(); return }
        val ask = VpnService.prepare(this)
        if (ask == null) { core.tether.launch(); finish(); return }
        @Suppress("DEPRECATION")
        runCatching { startActivityForResult(ask, 1) }.onFailure {
            core.tether.userStop(tr("Android didn’t let TwinDesk ask for the VPN permission"))
            finish()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        val core = Core.get(this)
        if (resultCode == RESULT_OK) core.tether.launch()
        else core.tether.userStop(tr("The VPN permission wasn’t given on the phone"))
        finish()
    }
}

// The VPN: the apps' IPv4 packets to and from the computer's relay.
class TetherVpn : VpnService() {
    // One run per offer: its own socket and VPN interface, so a new offer (or Stop) ends the old one
    // without the old one's ending touching the new.
    private class Run(val gen: Int) {
        @Volatile var sock: Socket? = null
        @Volatile var tun: ParcelFileDescriptor? = null
        @Volatile var stopping = false
        fun close() {
            runCatching { sock?.close() }
            runCatching { tun?.close() }
        }
    }

    @Volatile private var cur: Run? = null
    private var gen = 0

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { stopRun(); stopSelf(); return START_NOT_STICKY }
        val core = Core.get(this)
        val offer = core.tether.offer ?: run { stopRun(); stopSelf(); return START_NOT_STICKY }
        stopRun() // a new offer: start again with it
        val r = Run(++gen)
        cur = r
        running = this
        Thread({ run(core, offer, r) }, "td-tether").apply { isDaemon = true; start() }
        return START_NOT_STICKY
    }

    private fun stopRun() {
        val r = cur ?: return
        r.stopping = true
        r.close()
    }

    private fun run(core: Core, offer: Tether.Offer, r: Run) {
        var why = ""
        try {
            val s = Socket()
            r.sock = s
            protect(s)
            s.tcpNoDelay = true
            s.connect(InetSocketAddress("127.0.0.1", offer.port), 5000)
            handshake(s, offer.token)
            if (r.stopping) return
            val pfd = Builder()
                .setSession(tr("Internet over USB"))
                .addAddress(Tether.PHONE_IP, 24)
                .addRoute("0.0.0.0", 0)
                .addDnsServer(Tether.DNS_IP)
                .setMtu(Tether.MTU)
                .addDisallowedApplication(packageName) // TwinDesk's own session stays on the phone's networks
                .setBlocking(true)
                .setConfigureIntent(Notify.openApp(this))
                .setMetered(false)
                .establish() ?: throw Exception(tr("Android didn’t start the VPN (the permission was taken back?)"))
            r.tun = pfd
            if (r.stopping) return
            core.tether.vpnState("on")
            notifyOn(core)
            val up = Thread({ toComputer(pfd, s, r) }, "td-tether-up").apply { isDaemon = true; start() }
            toPhone(s.getInputStream(), FileOutputStream(pfd.fileDescriptor), r)
            up.interrupt()
            if (!r.stopping) why = tr("The cable or the computer ended it")
        } catch (e: Exception) {
            if (!r.stopping) {
                why = e.message ?: "stopped"
                Log.w("TwinDesk", "tether: $e")
            }
        } finally {
            r.close()
            if (cur === r) { // still the current run: report, and the service ends
                cur = null
                running = null
                Notify.nm(this).cancel(Notify.ID_TETHER)
                core.tether.vpnState(if (why.isNotEmpty()) "error" else "off", why)
                stopSelf()
            }
        }
    }

    private fun handshake(s: Socket, token: String) {
        s.soTimeout = 5000
        val nonce = Proto.randomHex(16)
        val out = s.getOutputStream()
        val inp = s.getInputStream()
        out.write("TDT1 $nonce\n".toByteArray(Charsets.ISO_8859_1))
        out.flush()
        val line = readLine(inp)
        val parts = line.split(" ")
        if (parts.size != 2 || !java.security.MessageDigest.isEqual(parts[0].toByteArray(), Tether.hmac(token, "r$nonce").toByteArray()) || !parts[1].matches(Regex("[0-9a-f]{32}")))
            throw Exception(tr("Something else answered on the cable, not TwinDesk on the computer"))
        out.write("${Tether.hmac(token, "p${parts[1]}")}\n".toByteArray(Charsets.ISO_8859_1))
        out.flush()
        s.soTimeout = 0
    }

    private fun readLine(inp: InputStream): String {
        val b = StringBuilder()
        while (b.length < 200) {
            val c = inp.read()
            if (c < 0) throw Exception(tr("The computer closed the connection"))
            if (c == '\n'.code) return b.toString()
            b.append(c.toChar())
        }
        throw Exception("hello too long")
    }

    // The apps' packets, as they are, to the computer.
    private fun toComputer(pfd: ParcelFileDescriptor, s: Socket, r: Run) {
        runCatching {
            val inp = FileInputStream(pfd.fileDescriptor)
            val out = s.getOutputStream()
            val buf = ByteArray(Tether.MTU)
            while (!r.stopping) {
                val n = inp.read(buf)
                if (n < 0) break
                if (n < 20 || (buf[0].toInt() shr 4) != 4) continue // IPv4 only
                out.write(buf, 0, n)
            }
        }
        runCatching { s.close() }
    }

    // The computer's packets, one by one (by their IPv4 length), to the apps.
    private fun toPhone(inp: InputStream, tunOut: FileOutputStream, r: Run) {
        val buf = ByteArray(Tether.MTU)
        while (!r.stopping) {
            if (!readFully(inp, buf, 0, 20)) return
            if ((buf[0].toInt() shr 4) != 4) throw Exception("the stream broke")
            val len = ((buf[2].toInt() and 0xff) shl 8) or (buf[3].toInt() and 0xff)
            if (len < 20 || len > buf.size) throw Exception("the stream broke")
            if (!readFully(inp, buf, 20, len - 20)) return
            tunOut.write(buf, 0, len)
        }
    }

    private fun readFully(inp: InputStream, b: ByteArray, off: Int, n: Int): Boolean {
        var got = 0
        while (got < n) {
            val r = inp.read(b, off + got, n - got)
            if (r < 0) return false
            got += r
        }
        return true
    }

    private fun notifyOn(core: Core) {
        val name = core.host?.name ?: tr("your computer")
        runCatching {
            Notify.nm(this).notify(Notify.ID_TETHER, Notification.Builder(this, Notify.CH_LINK)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(tr("Using {name}’s internet over USB", "name" to name))
                .setContentIntent(Notify.openApp(this))
                .setOngoing(true)
                .addAction(Notification.Action.Builder(null, tr("Stop"), Notify.action(this, ActionReceiver.TETHER_STOP, 21)).build())
                .build())
        }
    }

    override fun onRevoke() { // another VPN started, or it was switched off in Android's settings
        val r = cur
        stopRun()
        cur = null
        running = null
        if (r != null) Core.get(this).tether.userStop(tr("Another VPN took over, or the VPN was switched off in Android’s settings"))
        stopSelf()
    }

    override fun onDestroy() {
        stopRun()
        cur = null
        running = null
        super.onDestroy()
    }

    companion object {
        const val STOP = "com.twindesk.android.TETHER_VPN_STOP"
        @Volatile var running: TetherVpn? = null

        fun stop(ctx: Context) {
            if (running == null) return
            runCatching { ctx.startService(Intent(ctx, TetherVpn::class.java).setAction(STOP)) }
        }
    }
}
