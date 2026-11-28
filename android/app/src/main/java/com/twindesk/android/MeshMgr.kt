// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The mesh manager (shared/mesh-manage.js): every computer of the computer's mesh on Overview, not only
// the connected one. Wake one that's off, lock, unlock (Full KVM), sleep, restart or shut down any of
// them, answer a pairing waiting on one, remove a device from the mesh, and move devices on the layout.
// The connected computer relays to the others. Restart, shut down, unlock, pairings and removing ask for
// this phone's fingerprint (or its screen lock) first; each computer may turn this off or revoke the phone.
//   mesh.ask → while Overview is on screen (every ASK_MS); mesh.view ← the whole mesh
//   mesh.do {rid, to, do, dev?, x?, y?} → ; mesh.done {rid, ok, why} ←
// Nothing is asked while Overview isn't shown; one-to-one computers (no mesh) never answer: no card.
package com.twindesk.android

import android.app.Activity
import android.app.KeyguardManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

class MeshMgr(core: Core) : Feature(core) {
    companion object {
        const val ASK = "mesh.ask"
        const val VIEW = "mesh.view"
        const val DO = "mesh.do"
        const val DONE = "mesh.done"
        private const val ASK_MS = 30_000L
    }

    class Dev(val id: String, val name: String, val os: String, val self: Boolean, val online: Boolean, val on: Boolean,
              val said: Boolean, val can: Set<String>, val pending: Triple<String, String, String>?)

    @Volatile var view: JSONObject? = null; private set
    @Volatile var result: String = ""; private set
    private val waiting = ConcurrentHashMap<String, String>() // rid -> what was asked, for the line under the card
    private var looking = 0
    private var seq = 0
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private val again: Runnable = object : Runnable {
        override fun run() {
            if (looking <= 0 || !core.link.connected) return
            core.send(msg(ASK))
            main.postDelayed(this, ASK_MS)
        }
    }

    // Overview came on screen / went: ask only while someone looks.
    fun look(on: Boolean) {
        looking += if (on) 1 else -1
        main.removeCallbacks(again)
        if (looking > 0) main.post(again)
    }

    override fun onWelcome(host: Host) { view = null; result = ""; if (looking > 0) { main.removeCallbacks(again); main.post(again) } }
    override fun onClosed() { view = null; waiting.clear() }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            VIEW -> { view = m; core.changed() }
            DONE -> {
                val what = waiting.remove(m.str("rid", 40)) ?: return true
                result = if (m.optBoolean("ok")) tr("{what}: done", "what" to what) else tr("{what}: {why}", "what" to what, "why" to why(m.str("why", 20)))
                core.changed()
            }
            else -> return false
        }
        return true
    }

    private fun why(w: String) = when (w) {
        "off" -> tr("that computer doesn’t let phones manage it")
        "revoked" -> tr("that computer revoked this phone")
        "cant" -> tr("that computer can’t do it")
        "nothing" -> tr("nothing to do")
        "offline" -> tr("not connected")
        "timeout" -> tr("no answer (an older TwinDesk there?)")
        else -> tr("didn’t work")
    }

    fun devices(): List<Dev> {
        val a = view?.optJSONArray("devices") ?: return emptyList()
        return (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { d ->
            val c = d.optJSONObject("can")
            val can = c?.keys()?.asSequence()?.filter { c.optBoolean(it) }?.toSet() ?: emptySet()
            val p = d.optJSONObject("pending")
            Dev(d.str("id", 64), d.str("name", 64), d.str("os", 10), d.optBoolean("self"), d.optBoolean("online"), d.optBoolean("on", true),
                d.optBoolean("said"), can, p?.let { Triple(it.str("name", 64), it.str("os", 10), it.str("code", 12)) })
        }
    }

    val strong: Set<String> get() {
        val a = view?.optJSONArray("strong") ?: return setOf("unlock", "restart", "shutdown", "approve", "remove")
        return (0 until a.length()).map { a.optString(it) }.toSet()
    }

    fun act(to: String, act: String, label: String, dev: String = "", x: Int? = null, y: Int? = null) {
        val rid = "m" + (++seq) + "-" + System.currentTimeMillis() % 100000
        waiting[rid] = label
        result = tr("{what}…", "what" to label)
        val m = msg(DO, "rid" to rid, "to" to to, "do" to act)
        if (dev.isNotEmpty()) m.put("dev", dev)
        if (x != null) m.put("x", x)
        if (y != null) m.put("y", y)
        core.send(m)
        core.changed()
        main.postDelayed({ if (waiting.remove(rid) != null) { result = tr("{what}: {why}", "what" to label, "why" to why("timeout")); core.changed() } }, 12_000)
    }
}

// The fingerprint (or the screen lock) before a strong action; a phone without a screen lock can't do them.
fun confirmStrong(act: Activity, title: String, ok: () -> Unit, refused: (String) -> Unit) {
    val km = act.getSystemService(KeyguardManager::class.java)
    if (km == null || !km.isDeviceSecure) { refused(tr("Set a screen lock on this phone first")); return }
    val b = BiometricPrompt.Builder(act).setTitle(title).setSubtitle(tr("Confirm it’s you"))
    if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
    else @Suppress("DEPRECATION") b.setDeviceCredentialAllowed(true)
    runCatching {
        b.build().authenticate(CancellationSignal(), act.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = ok()
            override fun onAuthenticationError(code: Int, msg: CharSequence) { if (code != BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED && code != BiometricPrompt.BIOMETRIC_ERROR_CANCELED) refused(msg.toString()) }
        })
    }.onFailure { refused(it.message ?: "") }
}

@Composable
private fun MPill(label: String, strong: Boolean = false, onClick: () -> Unit) = Button(
    onClick = onClick, shape = RoundedCornerShape(50), elevation = null,
    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 0.dp),
    modifier = Modifier.padding(end = 6.dp, bottom = 6.dp),
    colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = if (strong) pal.bad else pal.text),
) { Text(label, fontSize = 13.sp, maxLines = 1) }

// Overview › Computers: every computer of the mesh with what the phone may do there, and the layout.
@Composable
fun MeshCard(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change
    val mgr = core.mesh
    DisposableEffect(Unit) { mgr.look(true); onDispose { mgr.look(false) } }
    val devs = mgr.devices()
    if (devs.size < 2) return // one-to-one, or an older computer: nothing to manage beyond the Computer card
    val act = LocalContext.current as? Activity
    val strong = mgr.strong
    var refusal by remember { mutableStateOf("") }
    var arranging by remember { mutableStateOf(false) }
    fun go(d: MeshMgr.Dev, what: String, label: String, dev: String = "") {
        if (what !in strong) return mgr.act(d.id, what, label, dev)
        if (act == null) return
        confirmStrong(act, label, { mgr.act(d.id, what, label, dev) }, { refusal = it })
    }
    MacCard(tr("Computers"), action = {
        TextButton(onClick = { arranging = !arranging }) { Text(if (arranging) tr("Done") else tr("Arrange"), color = pal.accent, fontSize = 14.sp) }
    }) {
        devs.forEachIndexed { i, d ->
            val state = when {
                d.self -> tr("Connected to this phone")
                !d.online -> tr("Not connected")
                !d.on -> tr("Doesn’t let phones manage it")
                !d.said -> tr("Connected (an older TwinDesk)")
                else -> tr("Connected")
            }
            MacRow(d.name, state, i == 0)
            Column(Modifier.padding(start = 16.dp, end = 12.dp, bottom = 6.dp)) {
                Row(Modifier.fillMaxWidth()) {
                    LazyRow {
                        val buttons = buildList {
                            if ("wake" in d.can) add("wake" to tr("Wake"))
                            if ("lock" in d.can) add("lock" to tr("Lock"))
                            if ("unlock" in d.can) add("unlock" to tr("Unlock"))
                            if ("sleep" in d.can) add("sleep" to tr("Sleep"))
                            if ("restart" in d.can) add("restart" to tr("Restart"))
                            if ("shutdown" in d.can) add("shutdown" to tr("Shut down"))
                        }
                        items(buttons) { (what, label) -> MPill(label, what in strong) { go(d, what, tr("{what} {name}", "what" to label, "name" to d.name)) } }
                    }
                }
                d.pending?.let { (name, _, code) ->
                    Text(tr("{name} wants to pair with {computer}. Code {code}: check it’s the one on {name}.", "name" to name, "computer" to d.name, "code" to code), color = pal.text, fontSize = 13.sp, modifier = Modifier.padding(vertical = 4.dp))
                    Row {
                        MPill(tr("Allow"), true) { go(d, "approve", tr("Allow {name}", "name" to name)) }
                        MPill(tr("Deny")) { go(d, "deny", tr("Deny {name}", "name" to name)) }
                    }
                }
                if (!d.self && arranging) MPill(tr("Remove from the mesh"), true) {
                    if (act != null) confirmStrong(act, tr("Remove {name}", "name" to d.name), { mgr.act("*", "remove", tr("Remove {name}", "name" to d.name), d.id) }, { refusal = it })
                }
            }
        }
        if (arranging) LayoutGrid(core, mgr, devs)
        val line = refusal.ifEmpty { mgr.result }
        if (line.isNotEmpty()) Text(line, color = pal.muted, fontSize = 12.5.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
    }
}

// The layout's grid (shared/layout.js cells): tap a device, then one of the places it may go.
@Composable
private fun LayoutGrid(core: Core, mgr: MeshMgr, devs: List<MeshMgr.Dev>) {
    val lay = mgr.view?.optJSONObject("layout") ?: return
    val cells = lay.optJSONObject("cells") ?: return
    val targets = lay.optJSONObject("targets")
    val me = mgr.view?.str("me", 64) ?: return
    val at = HashMap<String, String>() // "x,y" -> device id
    for (id in cells.keys()) { val c = cells.optJSONObject(id) ?: continue; at["${c.optInt("x")},${c.optInt("y")}"] = id }
    if (at.isEmpty()) return
    var picked by remember { mutableStateOf("") }
    val free = targets?.optJSONArray(picked)?.let { a -> (0 until a.length()).map { a.optString(it) }.toSet() } ?: emptySet()
    val all = at.keys + free
    val xs = all.map { it.substringBefore(',').toInt() }
    val ys = all.map { it.substringAfter(',').toInt() }
    val names = devs.associate { it.id to it.name }
    Text(if (picked.isEmpty()) tr("Tap a device, then where it goes") else tr("Tap a lit place for {name}", "name" to (names[picked] ?: tr("Phone"))),
        color = pal.muted, fontSize = 12.5.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
    Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (y in ys.min()..ys.max()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (x in xs.min()..xs.max()) {
                val k = "$x,$y"
                val id = at[k]
                val lit = k in free
                val shape = RoundedCornerShape(10.dp)
                Box(
                    Modifier.size(72.dp, 48.dp).clip(shape)
                        .background(when { id != null && id == picked -> pal.accentSoft; id != null -> pal.content; lit -> pal.accentSoft.copy(alpha = 0.5f); else -> Color.Transparent })
                        .border(1.dp, if (lit || id == picked) pal.accent else if (id != null) pal.line else Color.Transparent, shape)
                        .clickable(enabled = id != null || lit) {
                            if (id != null) picked = if (picked == id) "" else id
                            else if (lit) { mgr.act(me, "place", tr("Move {name}", "name" to (names[picked] ?: tr("Phone"))), picked, x, y); picked = "" }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    if (id != null) Text(names[id] ?: tr("Phone"), color = pal.text, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.Center, fontWeight = if (id == me) FontWeight.SemiBold else null, modifier = Modifier.padding(4.dp))
                }
            }
        }
    }
}
