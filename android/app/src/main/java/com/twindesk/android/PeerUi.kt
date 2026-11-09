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
        MacCard("Pairing with ${p.name}") {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (p.phase) {
                    "code", "waiting" -> {
                        Text("Check that ${p.name} shows the same code.", color = pal.text)
                        Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = pal.text)
                        if (p.phase == "code") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PButton("Codes match", true) { peer.link.confirmCode() }
                            PButton("Cancel") { peer.link.cancelPairing() }
                        } else Text("Waiting for Allow on ${p.name}…", color = pal.muted)
                    }
                    "failed" -> { Text(p.error, color = pal.bad); PButton("OK") { peer.link.cancelPairing() } }
                    else -> { Text("Connecting…", color = pal.muted); PButton("Cancel") { peer.link.cancelPairing() } }
                }
            }
        }
    }

    // Connected: who, and Disconnect. What to do with it is on the pages (PeerPage), which show only
    // what both phones can do while it holds the session.
    if (peer.connected) {
        val name = peer.peerName
        MacCard(name, action = { TextButton(onClick = { peer.disconnect() }) { Text("Disconnect", color = pal.bad, fontSize = 14.sp) } }) {
            MacRow("Connected", listOfNotNull(peer.peerModel.ifEmpty { null }, if (peer.role == "host") "Incoming connection" else "Outgoing connection").joinToString(" · "), true)
            peer.busyLine?.let { MacRow(it, "") }
            MacRow("Pages", "Overview, Screen, Files and other pages now apply to $name. Pages it doesn’t support are hidden while connected.")
        }
    }

    // One card: the switch, then the phones found (nearby first, then paired ones that aren't).
    val paired = peer.paired()
    val near = peer.nearby()
    var looking by remember { mutableStateOf(false) }
    LaunchedEffect(looking) { if (looking) { kotlinx.coroutines.delay(1500); looking = false } }
    MacCard("Phones and tablets", action = {
        if (peer.on) TextButton(onClick = { looking = true; Thread { runCatching { core.discovery.probe() } }.start() }, enabled = !looking) {
            Text(if (looking) "Looking…" else "Refresh", color = pal.accent, fontSize = 14.sp)
        }
    }) {
        SwitchRow("Connect with Android", if (peer.on) "Discoverable by nearby phones and tablets with TwinDesk" else "Off: hidden from other phones", peer.on, first = true) { peer.setOn(it) }
        if (peer.on) for (f in near) {
            val isPaired = peer.isPaired(f.id)
            val here = peer.connected && peer.peerId == f.id
            val hint = when {
                here -> "Connected"
                peer.waitingFor == f.id -> "Requesting connection…"
                f.port > 0 -> if (isPaired) "Paired · Ready" else "Ready to pair"
                else -> if (isPaired) "Paired · Nearby" else "Nearby · Requires approval on that device"
            }
            MacRow(f.name, hint) {
                if (isPaired && !here) PButton("Forget", color = pal.muted) { peer.forget(f.id) }
                if (peer.waitingFor == f.id) PButton("Cancel") { peer.cancelWait() }
                else if (!here) PButton(if (isPaired) "Connect" else "Pair", true) { peer.connect(f) }
            }
        }
        if (peer.on) for (h in paired.filter { h -> near.none { it.id == h.id } }) {
            MacRow(h.name, "Paired · Not nearby") { PButton("Forget", color = pal.muted) { peer.forget(h.id) } }
        }
        if (peer.on && near.isEmpty() && paired.isEmpty()) MacRow("Looking for phones…", "Open TwinDesk on the other phone, on the same Wi-Fi network or hotspot.")
    }
}

// ---- the pages while a phone holds the session (MainActivity's tabs by name) ----

@Composable
fun PeerPage(core: Core, v: Int, tab: String) {
    @Suppress("UNUSED_EXPRESSION") v
    val peer = core.peer
    val name = peer.peerName.ifEmpty { "Phone" }
    val ctx = LocalContext.current
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty()) peer.sendUris(uris) }
    val mine = peer.myCaps()
    when (tab) {
        "Overview" -> {
            PageHead(name, listOfNotNull("Connected", peer.peerModel.ifEmpty { null }).joinToString(" · "))
            peer.busyLine?.let { Note(it) }
            MacCard(name, action = { TextButton(onClick = { peer.disconnect() }) { Text("Disconnect", color = pal.bad, fontSize = 14.sp) } }) {
                var first = true
                val row = @Composable { label: String, hint: String, button: String, go: () -> Unit ->
                    MacRow(label, hint, first) { PButton(button, first) { go() } }
                    first = false
                }
                if (peer.can("files")) row("Send files", "Saved in Downloads › TwinDesk on $name", "Choose…") { pick.launch("*/*") }
                if (peer.can("screen")) row("Screen", "View $name’s screen on this phone", "View") { PeerScreen.view(peer, ctx) }
                if (peer.can("messages")) row("Messages", "Text messages on $name", "Open") { PeerActivity.open(ctx, "messages") }
                if (peer.can("photos")) row("Photos", "$name’s photos and videos", "Open") { PeerActivity.open(ctx, "photos") }
                if (peer.can("fs")) row("Files on $name", "Browse its storage", "Open") { PeerActivity.open(ctx, "files") }
            }
            MacCard("Shared with $name") {
                var first = true
                if (peer.can("clip")) { SwitchRow("Clipboard", "Copy on one phone, paste on the other", peer.clipOn, first = true) { peer.setClipOn(it) }; first = false }
                if (peer.can("notifs")) SwitchRow("Notifications", "Show each phone’s notifications on the other", peer.notifsOn, first = first) { peer.setNotifsOn(it) }
            }
        }
        "Screen" -> {
            PageHead("Screen", "View $name’s screen on this phone.")
            MacCard {
                MacRow("$name’s screen", if (peer.peerOs == "ios") "$name starts Share Screen in TwinDesk, then you tap View." else "$name is asked to start sharing when you tap View.", true) { PButton("View", true) { PeerScreen.view(peer, ctx) } }
                MacRow("This screen on $name", "Android asks for confirmation before sharing this screen with $name.")
            }
        }
        "Clipboard" -> {
            PageHead("Clipboard", "Copy on one phone and paste on the other.", peer.clipOn) { peer.setClipOn(it) }
            Note(if (peer.clipOn) "On. Android allows clipboard access only while TwinDesk is open: copy, then open TwinDesk, or share the text to TwinDesk." else "Off. The clipboard isn’t shared with $name.")
        }
        "Notifications" -> {
            PageHead("Notifications", "See each phone’s notifications on the other.", peer.notifsOn) { peer.setNotifsOn(it) }
            Note(when {
                !peer.notifsOn -> "Off."
                core.notifs.hasAccess -> "On. Each phone’s notifications appear on the other."
                else -> "$name’s notifications show here. Yours go there with notification access for TwinDesk (the full version)."
            })
        }
        "Files" -> {
            PageHead("Files", "Send files between this phone and $name.")
            peer.busyLine?.let { Note(it) }
            MacCard {
                MacRow("Send files", "Saved in Downloads › TwinDesk on $name. Or share from any app to TwinDesk.", true) { PButton("Choose…", true) { pick.launch("*/*") } }
                MacRow("Received", "Files from $name are saved to Downloads › TwinDesk on this phone.")
                if (peer.can("fs")) MacRow("Files on $name", "Browse its storage and save files to this phone.") { PButton("Open") { PeerActivity.open(ctx, "files") } }
            }
        }
        "Messages" -> HubBoth(core, peer, name, "messages", "Messages", "Read and reply to text messages on $name.", "Allows $name to read and send this phone’s text messages.", "messages" in mine)
        "Photos" -> HubBoth(core, peer, name, "photos", "Photos", "View and save photos and videos from $name.", "Allows $name to view this phone’s photos and videos.", "photos" in mine)
        "FileAccess" -> HubBoth(core, peer, name, "fs", "File access", "Browse $name’s storage and save files to this phone.", "Allows $name to browse this phone’s storage.", "fs" in mine)
        else -> Note("$name can’t do this.", "warn")
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
        if (peer.can(cap)) { MacRow("On $name", theirs, true) { PButton("Open", true) { PeerActivity.open(ctx, open) } }; first = false }
        if (weCan) {
            val p = core.hub.perm(what)
            MacRow("On this phone", when (p) { "ok" -> "Allowed. $ours"; "partial" -> "Partially allowed. $ours"; else -> "Not allowed. $ours" }, first) {
                if (p != "ok") PButton(if (p == "partial") "Allow more" else "Allow") { core.hub.askHere(what) }
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
            title = { Text("${f.name} wants to connect", color = pal.text) },
            text = { Text("Allow ${f.name} to pair with this phone. Both devices will show a code to confirm.", color = pal.muted) },
            confirmButton = { TextButton(onClick = { peer.answerAsk(true) }) { Text("Allow", color = pal.accent) } },
            dismissButton = { TextButton(onClick = { peer.answerAsk(false) }) { Text("Not now", color = pal.muted) } },
        )
    }
    peer.pairing?.takeIf { it.code.isNotEmpty() && !it.allowed }?.let { p ->
        AlertDialog(
            onDismissRequest = {}, containerColor = pal.card,
            title = { Text("Pair with ${p.name}?", color = pal.text) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Check that ${p.name} shows the same code.", color = pal.muted)
                    Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = pal.text)
                }
            },
            confirmButton = { TextButton(onClick = { peer.respondPair(true) }) { Text("Allow", color = pal.accent) } },
            dismissButton = { TextButton(onClick = { peer.respondPair(false) }) { Text("Deny", color = pal.muted) } },
        )
    }
    peer.link.pair?.takeIf { it.phase == "code" }?.let { p ->
        AlertDialog(
            onDismissRequest = {}, containerColor = pal.card,
            title = { Text("Pair with ${p.name}?", color = pal.text) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Check that ${p.name} shows the same code.", color = pal.muted)
                    Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, color = pal.text)
                }
            },
            confirmButton = { TextButton(onClick = { peer.link.confirmCode() }) { Text("Codes match", color = pal.accent) } },
            dismissButton = { TextButton(onClick = { peer.link.cancelPairing() }) { Text("Cancel", color = pal.muted) } },
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
                PageHead(peer.peerName.ifEmpty { "Phone" }, "")
                Note("Not connected. Connect from Connect › Connect with Android.", "warn")
                PButton("Close") { close() }
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
        Note(if (none) "${peer.peerName}’s TwinDesk can’t do this (its build doesn’t have it)." else "${peer.peerName} hasn’t allowed TwinDesk this yet.", "warn")
        if (!none) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PButton("Ask on ${peer.peerName}", true) { peer.ask("ask", JSONObject().put("what", what)) {} }
            PButton("Try again") { again() }
        }
    } else {
        Note(e, "bad")
        PButton("Try again") { again() }
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
    PageHead("Messages", "On ${peer.peerName}")
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
    LaunchedEffect(load) {
        peer.ask("sms.thread", JSONObject().put("id", t.optString("id")).put("n", 60)) { res -> r = res; items.clear(); items.addAll(res.optJSONArray("items").objects()) }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = back) { Text("‹ Back", color = pal.accent) }
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
                    if (m.optJSONArray("parts")?.length() ?: 0 > 0) Text("Picture", color = if (out) Color.White else pal.muted, fontSize = 13.sp)
                }
            }
        }
    }
    Note(sending, if (sending.startsWith("Not")) "bad" else "info")
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
        OutlinedTextField(text, { text = it }, placeholder = { Text("Message via ${peer.peerName}", color = pal.faint) }, modifier = Modifier.weight(1f),
            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = pal.text), shape = RoundedCornerShape(20.dp))
        PButton("Send", true) {
            val body = text.trim()
            val to = t.optJSONArray("addrs")?.optString(0).orEmpty()
            if (body.isEmpty() || to.isEmpty()) return@PButton
            sending = "Sending…"
            peer.ask("sms.send", JSONObject().put("to", to).put("body", body)) { res ->
                if (res.optBoolean("ok")) { text = ""; sending = ""; items.add(0, JSONObject().put("out", true).put("body", body)) }
                else sending = "Not sent: ${res.optString("error").let { if (it == "perm") "Messages access is required on ${peer.peerName}" else it }}"
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
    PageHead("Photos", "On ${peer.peerName}")
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
        TextButton(onClick = back) { Text("‹ Back", color = pal.accent) }
        Text(m.optString("name"), color = pal.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        PButton("Save to this phone", true) {
            peer.ask("media.save", JSONObject().put("ids", JSONArray().put(m.optString("id")))) { r -> said(if (r.optBoolean("ok")) "Saving ${m.optString("name")} in Downloads › TwinDesk…" else r.optString("error")) }
            back()
        }
    }
    Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
        val i = img
        if (i != null) Image(i, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        else Text(if (failed) "Couldn’t load" else "Loading…", color = pal.muted)
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
    PageHead("Files", "On ${peer.peerName}" + if (path.isEmpty()) "" else " · /$path")
    Note(note)
    if (path.isNotEmpty()) TextButton(onClick = { path = path.substringBeforeLast('/', "") }) { Text("‹ Up", color = pal.accent) }
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
                PButton("Save") {
                    peer.ask("fs.save", JSONObject().put("paths", JSONArray().put(p))) { x -> note = if (x.optBoolean("ok")) "Saving ${f.optString("name")} in Downloads › TwinDesk…" else x.optString("error") }
                }
            }
        }
    }
}
