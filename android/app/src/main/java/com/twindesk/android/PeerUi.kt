// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Connect with Android (Peer.kt): its section at the bottom of Connect (the phones found and paired,
// the one connected), its dialogs (a phone asks to connect, the pairing code on either side), the
// pages while a phone holds the session (PeerPage: MainActivity's tabs, only what both can do), and
// PeerActivity: the other phone's Messages, Photos and Files.
package com.twindesk.android

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Bundle
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONArray
import org.json.JSONObject

@Composable
private fun PButton(label: String, primary: Boolean = false, color: Color? = null, onClick: () -> Unit) = Button(
    onClick = onClick, shape = RoundedCornerShape(50), elevation = null,
    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 0.dp),
    modifier = Modifier.padding(0.dp).let { it },
    colors = ButtonDefaults.buttonColors(containerColor = if (primary) pal.accent else pal.chip, contentColor = if (primary) Color.White else color ?: pal.text),
) { Text(label, fontSize = 14.sp, maxLines = 1, fontWeight = FontWeight.Medium) }

// ---- the Android page ----

@Composable
fun AndroidSection(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v
    val peer = core.peer
    val ctx = LocalContext.current
    Note(peer.message, "warn")

    // Pairing from here (we're the guest): the code to compare.
    peer.link.pair?.let { p ->
        MacCard(tr("Pairing with {name}", "name" to p.name)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (p.phase) {
                    "code", "waiting" -> {
                        Text(tr("Check that {name} shows the same code.", "name" to p.name), color = pal.text)
                        Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = pal.text)
                        if (p.phase == "code") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PButton(tr("Codes match"), true) { peer.link.confirmCode() }
                            PButton(tr("Cancel")) { peer.link.cancelPairing() }
                        } else Text(tr("Waiting for Allow on {name}…", "name" to p.name), color = pal.muted)
                    }
                    "failed" -> { Text(p.error, color = pal.bad); PButton("OK") { peer.link.cancelPairing() } }
                    else -> { Text(tr("Connecting…"), color = pal.muted); PButton(tr("Cancel")) { peer.link.cancelPairing() } }
                }
            }
        }
    }

    // Connected: who, and Disconnect. What to do with it is on the pages (PeerPage), which show only
    // what both phones can do while it holds the session.
    if (peer.connected) {
        val name = peer.peerName
        MacCard(name, action = { TextButton(onClick = { peer.disconnect() }) { Text(tr("Disconnect"), color = pal.bad, fontSize = 14.sp) } }) {
            MacRow(tr("Connected"), listOfNotNull(peer.peerModel.ifEmpty { null }, if (peer.role == "host") tr("Incoming connection") else tr("Outgoing connection")).joinToString(" · "), true)
            peer.busyLine?.let { MacRow(it, "") }
            MacRow(tr("Pages"), tr("Overview, Screen, Files and other pages now apply to {name}. Pages it doesn’t support are hidden while connected.", "name" to name))
        }
    }

    // One card: the switch, then the phones found (nearby first, then paired ones that aren't).
    val paired = peer.paired()
    val near = peer.nearby()
    var looking by remember { mutableStateOf(false) }
    LaunchedEffect(looking) { if (looking) { kotlinx.coroutines.delay(1500); looking = false } }
    MacCard(tr("Phones and tablets"), action = {
        if (peer.on) TextButton(onClick = { looking = true; Thread { runCatching { core.discovery.probe() } }.start() }, enabled = !looking) {
            Text(if (looking) tr("Looking…") else tr("Refresh"), color = pal.accent, fontSize = 14.sp)
        }
    }) {
        SwitchRow(tr("Connect with Android"), if (peer.on) tr("Discoverable by nearby phones and tablets with TwinDesk") else tr("Off: hidden from other phones"), peer.on, first = true) { peer.setOn(it) }
        if (peer.on) for (f in near) {
            val isPaired = peer.isPaired(f.id)
            val here = peer.connected && peer.peerId == f.id
            val hint = when {
                here -> tr("Connected")
                peer.waitingFor == f.id -> tr("Requesting connection…")
                f.port > 0 -> if (isPaired) tr("Paired · Ready") else tr("Ready to pair")
                else -> if (isPaired) tr("Paired · Nearby") else tr("Nearby · Requires approval on that device")
            }
            MacRow(f.name, hint) {
                if (isPaired && !here) PButton(tr("Forget"), color = pal.muted) { peer.forget(f.id) }
                if (peer.waitingFor == f.id) PButton(tr("Cancel")) { peer.cancelWait() }
                else if (!here) PButton(if (isPaired) tr("Connect") else tr("Pair"), true) { peer.connect(f) }
            }
        }
        if (peer.on) for (h in paired.filter { h -> near.none { it.id == h.id } }) {
            MacRow(h.name, tr("Paired · Not nearby")) { PButton(tr("Forget"), color = pal.muted) { peer.forget(h.id) } }
        }
        if (peer.on && near.isEmpty() && paired.isEmpty()) MacRow(tr("Looking for phones…"), tr("Open TwinDesk on the other phone, on the same Wi-Fi network or hotspot."))
    }
}

// ---- the pages while a phone holds the session (MainActivity's tabs by name) ----

@Composable
fun PeerPage(core: Core, v: Int, tab: String) {
    @Suppress("UNUSED_EXPRESSION") v
    val peer = core.peer
    val name = peer.peerName.ifEmpty { tr("Phone") }
    val ctx = LocalContext.current
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty()) peer.sendUris(uris) }
    val mine = peer.myCaps()
    when (tab) {
        "Overview" -> {
            PageHead(name, listOfNotNull(tr("Connected"), peer.peerModel.ifEmpty { null }).joinToString(" · "))
            peer.busyLine?.let { Note(it) }
            MacCard(name, action = { TextButton(onClick = { peer.disconnect() }) { Text(tr("Disconnect"), color = pal.bad, fontSize = 14.sp) } }) {
                var first = true
                val row = @Composable { label: String, hint: String, button: String, go: () -> Unit ->
                    MacRow(label, hint, first) { PButton(button, first) { go() } }
                    first = false
                }
                if (peer.can("files")) row(tr("Send files"), tr("Saved in Downloads › TwinDesk on {name}", "name" to name), tr("Choose…")) { pick.launch("*/*") }
                if (peer.can("screen")) row(tr("Screen"), tr("View {name}’s screen on this phone", "name" to name), tr("View")) { PeerScreen.view(peer, ctx) }
                if (peer.can("messages")) row(tr("Messages"), tr("Text messages on {name}", "name" to name), tr("Open")) { PeerActivity.open(ctx, "messages") }
                if (peer.can("photos")) row(tr("Photos"), tr("{name}’s photos and videos", "name" to name), tr("Open")) { PeerActivity.open(ctx, "photos") }
                if (peer.can("fs")) row(tr("Files on {name}", "name" to name), tr("Browse its storage"), tr("Open")) { PeerActivity.open(ctx, "files") }
            }
            MacCard(tr("Shared with {name}", "name" to name)) {
                var first = true
                if (peer.can("clip")) { SwitchRow(tr("Clipboard"), tr("Copy on one phone, paste on the other"), peer.clipOn, first = true) { peer.setClipOn(it) }; first = false }
                if (peer.can("notifs")) SwitchRow(tr("Notifications"), tr("Show each phone’s notifications on the other"), peer.notifsOn, first = first) { peer.setNotifsOn(it) }
            }
        }
        "Screen" -> {
            PageHead(tr("Screen"), tr("View {name}’s screen on this phone.", "name" to name))
            MacCard {
                MacRow(tr("{name}’s screen", "name" to name), if (peer.peerOs == "ios") tr("{name} starts Share Screen in TwinDesk, then you tap View.", "name" to name) else tr("{name} is asked to start sharing when you tap View.", "name" to name), true) { PButton(tr("View"), true) { PeerScreen.view(peer, ctx) } }
                MacRow(tr("This screen on {name}", "name" to name), tr("Android asks for confirmation before sharing this screen with {name}.", "name" to name))
            }
        }
        "Clipboard" -> {
            PageHead(tr("Clipboard"), tr("Copy on one phone and paste on the other."), peer.clipOn) { peer.setClipOn(it) }
            Note(if (peer.clipOn) tr("On. Android allows clipboard access only while TwinDesk is open: copy, then open TwinDesk, or share the text to TwinDesk.") else tr("Off. The clipboard isn’t shared with {name}.", "name" to name))
        }
        "Notifications" -> {
            PageHead(tr("Notifications"), tr("See each phone’s notifications on the other."), peer.notifsOn) { peer.setNotifsOn(it) }
            Note(when {
                !peer.notifsOn -> "Off."
                core.notifs.hasAccess -> tr("On. Each phone’s notifications appear on the other.")
                else -> tr("{name}’s notifications show here. Yours go there with notification access for TwinDesk (the full version).", "name" to name)
            })
        }
        "Files" -> {
            PageHead(tr("Files"), tr("Send files between this phone and {name}.", "name" to name))
            peer.busyLine?.let { Note(it) }
            MacCard {
                MacRow(tr("Send files"), tr("Saved in Downloads › TwinDesk on {name}. Or share from any app to TwinDesk.", "name" to name), true) { PButton(tr("Choose…"), true) { pick.launch("*/*") } }
                MacRow(tr("Received"), tr("Files from {name} are saved to Downloads › TwinDesk on this phone.", "name" to name))
                if (peer.can("fs")) MacRow(tr("Files on {name}", "name" to name), tr("Browse its storage and save files to this phone.")) { PButton(tr("Open")) { PeerActivity.open(ctx, "files") } }
            }
        }
        tr("Messages") -> HubBoth(core, peer, name, "messages", tr("Messages"), tr("Read and reply to text messages on {name}.", "name" to name), tr("Allows {name} to read and send this phone’s text messages.", "name" to name), "messages" in mine)
        tr("Photos") -> HubBoth(core, peer, name, "photos", tr("Photos"), tr("View and save photos and videos from {name}.", "name" to name), tr("Allows {name} to view this phone’s photos and videos.", "name" to name), "photos" in mine)
        "FileAccess" -> HubBoth(core, peer, name, "fs", tr("File access"), tr("Browse {name}’s storage and save files to this phone.", "name" to name), tr("Allows {name} to browse this phone’s storage.", "name" to name), "fs" in mine)
        else -> Note(tr("{name} can’t do this.", "name" to name), "warn")
    }
}

// Messages, Photos, File access with a phone: theirs to open here (when it can), ours for it (when we can).
@Composable
private fun HubBoth(core: Core, peer: Peer, name: String, cap: String, title: String, theirs: String, ours: String, weCan: Boolean) {
    val ctx = LocalContext.current
    val what = when (cap) { "photos" -> "media"; "fs" -> "files"; else -> cap } // Hub's names
    val open = when (cap) { "fs" -> "files"; else -> cap } // PeerActivity's
    PageHead(title, "")
    MacCard {
        var first = true
        if (peer.can(cap)) { MacRow(tr("On {name}", "name" to name), theirs, true) { PButton(tr("Open"), true) { PeerActivity.open(ctx, open) } }; first = false }
        if (weCan) {
            val p = core.hub.perm(what)
            MacRow(tr("On this phone"), when (p) { "ok" -> tr("Allowed. {ours}", "ours" to ours); "partial" -> tr("Partially allowed. {ours}", "ours" to ours); else -> tr("Not allowed. {ours}", "ours" to ours) }, first) {
                if (p != "ok") PButton(if (p == "partial") tr("Allow more") else tr("Allow")) { core.hub.askHere(what) }
            }
        }
    }
}

// Over whatever page is open: a phone asks to connect, or our pairing code (we host).
@Composable
fun PeerDialogs(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val peer = core.peer
    peer.asked?.let { f ->
        AlertDialog(
            onDismissRequest = {}, containerColor = pal.card,
            title = { Text(tr("{name} wants to connect", "name" to f.name), color = pal.text) },
            text = { Text(tr("Allow {name} to pair with this phone. Both devices will show a code to confirm.", "name" to f.name), color = pal.muted) },
            confirmButton = { TextButton(onClick = { peer.answerAsk(true) }) { Text(tr("Allow"), color = pal.accent) } },
            dismissButton = { TextButton(onClick = { peer.answerAsk(false) }) { Text(tr("Not now"), color = pal.muted) } },
        )
    }
    peer.pairing?.takeIf { it.code.isNotEmpty() && !it.allowed }?.let { p ->
        AlertDialog(
            onDismissRequest = {}, containerColor = pal.card,
            title = { Text(tr("Pair with {name}?", "name" to p.name), color = pal.text) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(tr("Check that {name} shows the same code.", "name" to p.name), color = pal.muted)
                    Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = pal.text)
                }
            },
            confirmButton = { TextButton(onClick = { peer.respondPair(true) }) { Text(tr("Allow"), color = pal.accent) } },
            dismissButton = { TextButton(onClick = { peer.respondPair(false) }) { Text(tr("Deny"), color = pal.muted) } },
        )
    }
    peer.link.pair?.takeIf { it.phase == "code" }?.let { p ->
        AlertDialog(
            onDismissRequest = {}, containerColor = pal.card,
            title = { Text(tr("Pair with {name}?", "name" to p.name), color = pal.text) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(tr("Check that {name} shows the same code.", "name" to p.name), color = pal.muted)
                    Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = pal.text)
                }
            },
            confirmButton = { TextButton(onClick = { peer.link.confirmCode() }) { Text(tr("Codes match"), color = pal.accent) } },
            dismissButton = { TextButton(onClick = { peer.link.cancelPairing() }) { Text(tr("Cancel"), color = pal.muted) } },
        )
    }
}

// ---- the other phone's Messages, Photos and Files ----

class PeerActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val what = intent.getStringExtra("what") ?: "messages"
        setContent { Theme { PeerBrowse(Core.get(this), what) { finish() } } }
    }

    companion object {
        fun open(ctx: Context, what: String) = ctx.startActivity(Intent(ctx, PeerActivity::class.java).putExtra("what", what).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

private fun dataImage(url: String?): ImageBitmap? = runCatching {
    val b = Base64.decode(url!!.substringAfter("base64,"), Base64.DEFAULT)
    BitmapFactory.decodeByteArray(b, 0, b.size)!!.asImageBitmap()
}.getOrNull()

private fun JSONArray?.objects(): List<JSONObject> = (0 until (this?.length() ?: 0)).mapNotNull { this!!.optJSONObject(it) }

@Composable
private fun PeerBrowse(core: Core, what: String, close: () -> Unit) {
    val v by core.version.collectAsState()
    @Suppress("UNUSED_EXPRESSION") v
    val peer = core.peer
    Box(Modifier.fillMaxSize().background(pal.content).safeDrawingPadding()) {
        Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
            if (!peer.connected) {
                PageHead(peer.peerName.ifEmpty { tr("Phone") }, "")
                Note(tr("Not connected. Connect from Connect › Connect with Android."), "warn")
                PButton(tr("Close")) { close() }
                return@Column
            }
            when (what) {
                "photos" -> Photos(peer)
                "files" -> FilesBrowse(peer)
                else -> MessagesBrowse(peer)
            }
        }
    }
}

// An error from the other phone: its permission missing (with Allow there), or why.
@Composable
private fun Problem(peer: Peer, r: JSONObject?, what: String, again: () -> Unit) {
    val e = r?.optString("error").orEmpty()
    if (e.isEmpty()) return
    if (e == "perm") {
        val none = r?.optString("perm") == "none"
        Note(if (none) tr("{name}’s TwinDesk can’t do this (its build doesn’t have it).", "name" to peer.peerName) else tr("{name} hasn’t allowed TwinDesk this yet.", "name" to peer.peerName), "warn")
        if (!none) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PButton(tr("Ask on {name}", "name" to peer.peerName), true) { peer.ask("ask", JSONObject().put("what", what)) {} }
            PButton(tr("Try again")) { again() }
        }
    } else {
        Note(e, "bad")
        PButton(tr("Try again")) { again() }
    }
}

@Composable
private fun androidx.compose.foundation.layout.ColumnScope.MessagesBrowse(peer: Peer) {
    var threads by remember { mutableStateOf<JSONObject?>(null) }
    var open by remember { mutableStateOf<JSONObject?>(null) }
    var load by remember { mutableStateOf(0) }
    LaunchedEffect(load) { peer.ask("sms.threads", JSONObject().put("n", 100)) { threads = it } }
    val o = open
    if (o != null) {
        BackHandler { open = null }
        return Conversation(peer, o) { open = null }
    }
    PageHead(tr("Messages"), tr("On {name}", "name" to peer.peerName))
    val r = threads
    if (r == null) return Text("Loading…", color = pal.muted)
    Problem(peer, r, "messages") { threads = null; load++ }
    LazyColumn(Modifier.fillMaxWidth()) {
        items(r.optJSONArray("items").objects()) { t ->
            Column(Modifier.fillMaxWidth().clickable { open = t }.padding(vertical = 10.dp)) {
                Row {
                    Text(t.optString("name"), color = pal.text, fontSize = 16.sp, fontWeight = if (t.optBoolean("unread")) FontWeight.Bold else FontWeight.Normal, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(android.text.format.DateUtils.getRelativeTimeSpanString(t.optLong("at")).toString(), color = pal.faint, fontSize = 12.sp)
                }
                Text(t.optString("snippet"), color = pal.muted, fontSize = 13.5.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.ColumnScope.Conversation(peer: Peer, t: JSONObject, back: () -> Unit) {
    val items = remember { mutableStateListOf<JSONObject>() }
    var r by remember { mutableStateOf<JSONObject?>(null) }
    var load by remember { mutableStateOf(0) }
    var text by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf("") }
    var sendFailed by remember { mutableStateOf(false) }
    LaunchedEffect(load) {
        peer.ask("sms.thread", JSONObject().put("id", t.optString("id")).put("n", 60)) { res -> r = res; items.clear(); items.addAll(res.optJSONArray("items").objects()) }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = back) { Text(tr("‹ Back"), color = pal.accent) }
        Text(t.optString("name"), color = pal.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    if (r == null) Text("Loading…", color = pal.muted)
    Problem(peer, r, "messages") { load++ }
    val list = rememberLazyListState()
    LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, reverseLayout = true) {
        items(items) { m ->
            val out = m.optBoolean("out")
            Box(Modifier.fillMaxWidth().padding(vertical = 3.dp), contentAlignment = if (out) Alignment.CenterEnd else Alignment.CenterStart) {
                Column(Modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(16.dp)).background(if (out) pal.accent else pal.card).padding(horizontal = 12.dp, vertical = 8.dp)) {
                    if (!out && m.optString("fromName").isNotEmpty() && (t.optJSONArray("addrs")?.length() ?: 0) > 1) Text(m.optString("fromName"), color = pal.muted, fontSize = 12.sp)
                    val body = m.optString("body")
                    if (body.isNotEmpty()) Text(body, color = if (out) Color.White else pal.text, fontSize = 15.sp)
                    if (m.optJSONArray("parts")?.length() ?: 0 > 0) Text(tr("Picture"), color = if (out) Color.White else pal.muted, fontSize = 13.sp)
                }
            }
        }
    }
    Note(sending, if (sendFailed) "bad" else "info")
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
        OutlinedTextField(text, { text = it }, placeholder = { Text(tr("Message via {name}", "name" to peer.peerName), color = pal.faint) }, modifier = Modifier.weight(1f),
            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = pal.text), shape = RoundedCornerShape(20.dp))
        PButton(tr("Send"), true) {
            val body = text.trim()
            val to = t.optJSONArray("addrs")?.optString(0).orEmpty()
            if (body.isEmpty() || to.isEmpty()) return@PButton
            sending = tr("Sending…"); sendFailed = false
            peer.ask("sms.send", JSONObject().put("to", to).put("body", body)) { res ->
                if (res.optBoolean("ok")) { text = ""; sending = ""; items.add(0, JSONObject().put("out", true).put("body", body)) }
                else { sendFailed = true; sending = tr("Not sent: {error}", "error" to (res.optString("error").let { if (it == "perm") tr("Messages access is required on {name}", "name" to peer.peerName) else it })) }
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.ColumnScope.Photos(peer: Peer) {
    val items = remember { mutableStateListOf<JSONObject>() }
    val thumbs = remember { mutableStateMapOf<String, ImageBitmap?>() }
    var r by remember { mutableStateOf<JSONObject?>(null) }
    var next by remember { mutableStateOf("") }
    var more by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var load by remember { mutableStateOf(0) }
    var big by remember { mutableStateOf<JSONObject?>(null) }
    var note by remember { mutableStateOf("") }
    val page = {
        if (!loading) {
            loading = true
            peer.ask("media.list", JSONObject().put("kind", "all").put("n", 90).put("before", next)) { res ->
                loading = false
                r = res
                if (!res.has("error")) { items.addAll(res.optJSONArray("items").objects()); next = res.optString("next"); more = res.optBoolean("more") }
            }
        }
    }
    LaunchedEffect(load) { items.clear(); next = ""; page() }
    val b = big
    if (b != null) {
        BackHandler { big = null }
        return BigPhoto(peer, b, { big = null }) { note = it }
    }
    PageHead(tr("Photos"), tr("On {name}", "name" to peer.peerName))
    Note(note)
    if (r == null) Text("Loading…", color = pal.muted)
    Problem(peer, r, "media") { r = null; load++ }
    LazyVerticalGrid(GridCells.Adaptive(104.dp), Modifier.fillMaxWidth().weight(1f), horizontalArrangement = Arrangement.spacedBy(3.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        itemsIndexed(items) { i, m ->
            val id = m.optString("id")
            LaunchedEffect(id) { if (!thumbs.containsKey(id)) { thumbs[id] = null; peer.ask("media.thumb", JSONObject().put("id", id)) { thumbs[id] = dataImage(it.optString("data")) } } }
            if (i == items.size - 1 && more) LaunchedEffect(i) { page() }
            Box(Modifier.aspectRatio(1f).clip(RoundedCornerShape(4.dp)).background(pal.card).clickable { big = m }) {
                thumbs[id]?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                if (m.optBoolean("video")) Text("▶", color = Color.White, fontSize = 14.sp, modifier = Modifier.align(Alignment.BottomStart).padding(4.dp))
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.ColumnScope.BigPhoto(peer: Peer, m: JSONObject, back: () -> Unit, said: (String) -> Unit) {
    var img by remember { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(m) { peer.ask("media.view", JSONObject().put("id", m.optString("id")), 40_000) { r -> img = dataImage(r.optString("data")); failed = img == null } }
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = back) { Text(tr("‹ Back"), color = pal.accent) }
        Text(m.optString("name"), color = pal.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        PButton(tr("Save to this phone"), true) {
            peer.ask("media.save", JSONObject().put("ids", JSONArray().put(m.optString("id")))) { r -> said(if (r.optBoolean("ok")) tr("Saving {file} in Downloads › TwinDesk…", "file" to m.optString("name")) else r.optString("error")) }
            back()
        }
    }
    Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
        val i = img
        if (i != null) Image(i, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        else Text(if (failed) tr("Couldn’t load") else tr("Loading…"), color = pal.muted)
    }
}

@Composable
private fun androidx.compose.foundation.layout.ColumnScope.FilesBrowse(peer: Peer) {
    var path by remember { mutableStateOf("") }
    var r by remember { mutableStateOf<JSONObject?>(null) }
    var load by remember { mutableStateOf(0) }
    var note by remember { mutableStateOf("") }
    LaunchedEffect(path, load) { r = null; peer.ask("fs.list", JSONObject().put("path", path)) { r = it } }
    if (path.isNotEmpty()) BackHandler { path = path.substringBeforeLast('/', "") }
    PageHead(tr("Files"), tr("On {name}", "name" to peer.peerName) + if (path.isEmpty()) "" else " · /$path")
    Note(note)
    if (path.isNotEmpty()) TextButton(onClick = { path = path.substringBeforeLast('/', "") }) { Text(tr("‹ Up"), color = pal.accent) }
    val res = r
    if (res == null) return Text("Loading…", color = pal.muted)
    Problem(peer, res, "files") { load++ }
    val list = res.optJSONArray("items").objects().sortedWith(compareByDescending<JSONObject> { it.optBoolean("dir") }.thenBy { it.optString("name").lowercase() })
    LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
        items(list) { f ->
            val dir = f.optBoolean("dir")
            val p = if (path.isEmpty()) f.optString("name") else "$path/${f.optString("name")}"
            Row(Modifier.fillMaxWidth().clickable(enabled = dir) { path = p }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text((if (dir) "📁 " else "") + f.optString("name"), color = pal.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(if (dir) Files.plural(f.optInt("n"), "item") else FileClip.size(f.optLong("size")), color = pal.muted, fontSize = 12.sp)
                }
                PButton(tr("Save")) {
                    peer.ask("fs.save", JSONObject().put("paths", JSONArray().put(p))) { x -> note = if (x.optBoolean("ok")) tr("Saving {file} in Downloads › TwinDesk…", "file" to f.optString("name")) else x.optString("error") }
                }
            }
        }
    }
}
