// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The app's window, laid out like TwinDesk on the Mac: a sidebar with the TwinDesk logo and the
// pages in the Mac's groups (Display, Input, Share, More, then General and About), each page a
// heading with its main switch over cards of rows. On a phone held upright the sidebar becomes
// tabs along the bottom (the rest under More). The building blocks are in Ui.kt.
package com.twindesk.android

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.luminance
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.ui.draganddrop.DragAndDropTarget
import androidx.compose.ui.draganddrop.mimeTypes
import androidx.compose.ui.draganddrop.toAndroidDragEvent
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

class MainActivity : ComponentActivity() {
    private var resumed = mutableStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        TwinService.start(this)
        setContent { Theme { App(Core.get(this), resumed.value) } }
        openTab.value = intent?.getStringExtra("tab")
    }

    // A notification opened a page (the computer's media: Media).
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra("tab")?.let { openTab.value = it }
    }

    override fun onResume() {
        super.onResume()
        shown = true
        resumed.value++ // permissions may have changed in Settings
        Core.get(this).foreground() // a look at the session; one put off by Reconnect in the background
        Core.get(this).adb.check() // back from Settings: is wireless debugging on now?
        Core.get(this).hub.let { if (it.callsOn || it.messagesOn || it.mediaOn || it.filesOn) it.permsChanged() }
        Core.get(this).share.let { if (it.on && it.serving != it.allowed) it.core.bg.execute { it.sync() } } // All files access just allowed (or taken away)
    }

    override fun onPause() {
        super.onPause()
        shown = false
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // In front: Android lets us read the clipboard now.
        if (hasFocus) Core.get(this).let { if (it.sync.get("clipboard", "out")) it.clip.sendCurrent(false); it.peer.clipNow() }
    }

    companion object {
        @Volatile var shown = false // on screen: Android lets us open a prompt (Hub.ask)
        val openTab = mutableStateOf<String?>(null) // a page to open (Tab's name), from a notification
    }
}

private fun grad(a: Long, b: Long) = listOf(Color(a), Color(b))

// The pages, with the Mac's tile colours and groups.
private enum class Tab(val title: String, val icon: ImageVector, val colors: List<Color>, val group: String) {
    // Overview: the computer itself, only while connected; Connection: pairing, Nearby, the link.
    Overview("Overview", Ico.overview, grad(0xFF8E8E93, 0xFF636366), ""),
    Connection("Connection", Ico.link, grad(0xFF5AC8FA, 0xFF0A84FF), ""),
    // On the computer, from this phone (Hub.kt): their settings here.
    Calls("Calls", Ico.call, grad(0xFF5EE07A, 0xFF30B94D), "Phone"),
    Messages("Messages", Ico.message, grad(0xFF5EE07A, 0xFF30B94D), "Phone"),
    Photos("Photos", Ico.photo, grad(0xFFFFD60A, 0xFFFF9F0A), "Phone"),
    FileAccess("File access", Ico.folder, grad(0xFF64D2FF, 0xFF0A84FF), "Phone"),
    Screen("Screen", Ico.display, grad(0xFF5AC8FA, 0xFF0A84FF), "Display"),
    Cursor("Mouse", Ico.cursor, grad(0xFFFFB340, 0xFFFF9500), "Input"),
    Keyboard("Keyboard", Ico.keyboard, grad(0xFFD1D1D6, 0xFF8E8E93), "Input"),
    Remote("Remote", Ico.remote, grad(0xFFBF5AF2, 0xFF8944AB), "Input"),
    Clipboard("Clipboard", Ico.clipboard, grad(0xFF64D2FF, 0xFF30B0C7), "Share"),
    Notifications("Notifications", Ico.bell, grad(0xFFFF6961, 0xFFFF3B30), "Share"),
    Files("Files", Ico.files, grad(0xFF64D2FF, 0xFF0A84FF), "Share"),
    Rezume("ReZume", Ico.rezume, grad(0xFF64D2FF, 0xFF0A84FF), "Share"),
    Sound("Sound", Ico.audio, grad(0xFFFF6482, 0xFFFF2D55), "More"),
    Media("Media", Ico.media, grad(0xFFFF6482, 0xFFBF5AF2), "More"),
    Camera("Camera", Ico.camera, grad(0xFFBF5AF2, 0xFF8944AB), "More"),
    General("General", Ico.general, grad(0xFFAEAEB2, 0xFF636366), "bottom"),
    About("About", Ico.about, grad(0xFF64D2FF, 0xFF0A84FF), "bottom"),
}

// Another phone holds the session (Peer.kt; one at a time, so no computer): the pages are that
// phone's, and only those both phones can do (its caps in peer.info), as a computer's pages adapt to a phone.
private fun peerMode(core: Core) = core.host == null && core.peer.connected
private fun peerShown(core: Core, t: Tab): Boolean {
    val p = core.peer
    val mine = p.myCaps()
    return when (t) {
        Tab.Overview, Tab.Connection, Tab.General, Tab.About -> true
        Tab.Screen -> p.can("screen")
        Tab.Clipboard -> p.can("clip")
        Tab.Notifications -> p.can("notifs")
        Tab.Files -> p.can("files")
        Tab.Messages -> p.can("messages") || "messages" in mine
        Tab.Photos -> p.can("photos") || "photos" in mine
        Tab.FileAccess -> p.can("fs") || "fs" in mine
        else -> false // Calls, Mouse, Keyboard, Remote, ReZume, Sound, Media, Camera: a computer's
    }
}

// The bottom bar: Overview first while connected, Connection second; before that Connection first.
private fun bottom(core: Core) = when {
    core.host != null -> listOf(Tab.Overview, Tab.Connection, Tab.Screen, Tab.Files)
    peerMode(core) -> listOf(Tab.Overview, Tab.Connection, Tab.Screen, Tab.Files).filter { peerShown(core, it) }
    else -> listOf(Tab.Connection, Tab.Screen, Tab.Files)
}
// Overview only while connected (elsewhere, Connection shows); with a phone, only what it can do.
private fun shown(core: Core, t: Tab) = if (peerMode(core)) peerShown(core, t) else t != Tab.Overview || core.host != null

// The sidebar's green dot: the page's feature is on.
private fun isOn(core: Core, t: Tab): Boolean = if (peerMode(core)) when (t) {
    Tab.Connection -> true
    Tab.Clipboard -> core.peer.clipOn
    Tab.Notifications -> core.peer.notifsOn
    Tab.Files -> core.peer.busyLine != null
    else -> false
} else isOnPc(core, t)

private fun isOnPc(core: Core, t: Tab): Boolean = when (t) {
    Tab.Screen -> core.screen.viewing
    Tab.Cursor -> core.kvm.linked && core.sync.get("cursor", "in")
    Tab.Keyboard -> core.sync.value("keyboard") == "true"
    Tab.Remote -> core.remote.active
    Tab.Clipboard -> core.sync.get("clipboard", "in") || core.sync.get("clipboard", "out")
    Tab.Notifications -> core.sync.get("notifs", "in") || core.sync.get("notifs", "out")
    Tab.Sound -> core.sync.get("audio", "in") || core.sync.get("audio", "out")
    Tab.Media -> core.pcMedia.now?.playing == true
    Tab.Camera -> core.adb.camera.on
    Tab.Rezume -> core.rezume.on
    Tab.Calls -> core.hub.callsOn
    Tab.Messages -> core.hub.messagesOn
    Tab.Photos -> core.hub.mediaOn
    Tab.FileAccess -> core.hub.filesOn
    else -> false
} && core.host != null

private fun them(core: Core) = core.host?.name ?: core.hosts().firstOrNull()?.name ?: tr("the computer")

// Pages that can't work over Bluetooth and don't move the session onto Wi-Fi by themselves
// (sound streams over the network; the computer's Photos): shown as they are while the session
// is on Bluetooth, saying so, with Connect with Wi-Fi Direct (WifiGate).
private fun wifiOnly(core: Core, t: Tab) = (t == Tab.Sound || t == Tab.Photos) && core.host != null && core.link.ble

@Composable
fun App(core: Core, resumed: Int) {
    val v by core.version.collectAsState()
    @Suppress("UNUSED_EXPRESSION") v; @Suppress("UNUSED_EXPRESSION") resumed // re-read Core on every bump
    var tab by rememberSaveable { mutableStateOf(Tab.Connection) }
    // Connected (to a computer or a phone): its Overview (from Connection); not connected: Connection in its place.
    val connected = core.host != null || core.peer.connected
    var wasConnected by rememberSaveable { mutableStateOf(false) }
    if (connected && !wasConnected && tab == Tab.Connection) tab = Tab.Overview
    wasConnected = connected
    if (!connected && tab == Tab.Overview) tab = Tab.Connection
    if (!shown(core, tab)) tab = if (connected) Tab.Overview else Tab.Connection // a page the other device can't do
    val BOTTOM = bottom(core)
    var more by rememberSaveable { mutableStateOf(false) }
    MainActivity.openTab.value?.let { name ->
        Tab.entries.firstOrNull { it.name == name }?.takeIf { shown(core, it) }?.let { tab = it; more = false }
        MainActivity.openTab.value = null
    }
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    // Wireless debugging went off (MIUI / HyperOS): ask once per time it happens.
    var adbAsked by rememberSaveable { mutableStateOf(false) }
    if (!core.adb.off) adbAsked = false
    if (core.adb.off && !adbAsked && !core.link.ble) { // over Bluetooth it can't be used anyway
        val name = them(core)
        AlertDialog(
            onDismissRequest = { adbAsked = true },
            containerColor = pal.card,
            title = { Text(tr("Turn on wireless debugging"), color = pal.text) },
            text = {
                Text(
                    tr("{name} uses it to show this screen, control this device with its mouse and keyboard, and play sound. ", "name" to name) +
                        tr("Some phones (MIUI, HyperOS) turn it off after a network change, screen lock or restart.\n\n") +
                        tr("Developer options will open. Turn on USB debugging and Wireless debugging, then return to TwinDesk."),
                    color = pal.muted,
                )
            },
            confirmButton = { TextButton(onClick = { adbAsked = true; core.adb.openSettings() }) { Text(tr("Open Settings"), color = pal.accent) } },
            dismissButton = { TextButton(onClick = { adbAsked = true }) { Text(tr("Not now"), color = pal.muted) } },
        )
    }

    // Another device rang this phone (its Overview › Ring): Stop over whatever page is open, not
    // only on the notification and the Connection page.
    if (core.dev.ringing) {
        val who = core.host?.name ?: tr("Your computer")
        AlertDialog(
            onDismissRequest = {},
            containerColor = pal.card,
            title = { Text(tr("Ringing"), color = pal.text) },
            text = { Text(tr("{name} is ringing this phone.", "name" to who), color = pal.muted) },
            confirmButton = { TextButton(onClick = { core.dev.stopRing() }) { Text(tr("Stop"), color = pal.bad) } },
        )
    }

    // A computer wants to pair, or its code is up: over whatever page is open, not only the
    // notification and the Overview.
    core.invite?.let { inv ->
        AlertDialog(
            onDismissRequest = {},
            containerColor = pal.card,
            title = { Text(tr("{name} wants to pair", "name" to inv.name), color = pal.text) },
            text = { Text(tr("Tap Pair to pair this device with {name}. You’ll confirm that both devices show the same code.", "name" to inv.name), color = pal.muted) },
            confirmButton = { TextButton(onClick = { core.pair(inv) }) { Text(tr("Pair"), color = pal.accent) } },
            dismissButton = { TextButton(onClick = { core.dismissInvite() }) { Text(tr("Not now"), color = pal.muted) } },
        )
    }
    core.link.pair?.takeIf { it.phase == "code" && !it.wired && !it.qr }?.let { p ->
        AlertDialog(
            onDismissRequest = {},
            containerColor = pal.card,
            title = { Text(tr("Pair with {name}?", "name" to p.name), color = pal.text) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(tr("Check that {name} shows the same code.", "name" to p.name), color = pal.muted)
                    Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp, color = pal.text)
                }
            },
            confirmButton = { TextButton(onClick = { core.link.confirmCode() }) { Text(tr("Codes match"), color = pal.accent) } },
            dismissButton = { TextButton(onClick = { core.link.cancelPairing() }) { Text(tr("Cancel"), color = pal.muted) } },
        )
    }

    PeerDialogs(core, v) // another phone (Connect with Android): asks to connect, or its pairing code

    // Setup first while something needed isn't allowed (Skip for now remembers what was skipped).
    val ctx = LocalContext.current
    var setupDone by rememberSaveable { mutableStateOf(false) }
    if (!setupDone && SetupCheck.shouldShow(ctx, core)) return SetupScreen(core, ctx, v + resumed) { setupDone = true }
    // The wireless debugging guide when opened from General › Setup / Cursor (Overview has it as a card).
    if (Guide.open.value) return WirelessGuide(core, ctx, v + resumed)

    Box(Modifier.fillMaxSize().background(pal.content)) {
        if (wide) {
            Row(Modifier.safeDrawingPadding()) {
                Sidebar(core, v, tab) { tab = it }
                // the page in a rounded sheet beside the sidebar, as the phone's under its branding
                Box(Modifier.weight(1f).fillMaxHeight().padding(top = 10.dp, end = 10.dp, bottom = 10.dp).clip(RoundedCornerShape(28.dp)).background(pal.sheet)) {
                    Page(core, v, tab, Modifier.fillMaxSize())
                }
            }
        } else {
            // Back: through the pages visited, in order (More counts as one); with none left,
            // Android's own Back (leaves the app).
            val history = remember { androidx.compose.runtime.mutableStateListOf<Pair<Tab, Boolean>>() }
            val go = { t: Tab, m: Boolean ->
                if ((tab to more) != (t to m)) {
                    history.add(tab to more)
                    if (history.size > 40) history.removeAt(0)
                    tab = t; more = m
                }
            }
            androidx.activity.compose.BackHandler(enabled = history.isNotEmpty()) {
                var back = history.removeAt(history.lastIndex)
                while (!shown(core, back.first) && history.isNotEmpty()) back = history.removeAt(history.lastIndex) // Overview after a disconnect
                if (shown(core, back.first)) { tab = back.first; more = back.second }
            }
            Column(Modifier.safeDrawingPadding()) {
                if (!more && tab == BOTTOM.first()) TopIdentity(core, v) // TwinDesk on the main page only
                else Spacer(Modifier.height(10.dp))
                // The page in a big rounded sheet under the branding; the bar floats at its bottom.
                Column(Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp)).background(pal.sheet)) {
                if (more) MoreList(core, v, BOTTOM, Modifier.weight(1f)) { go(it, false) }
                else Page(core, v, tab, Modifier.weight(1f))
                // A Material navigation bar, as Google's own apps have it: line icons, the selected
                // one in a pill of the accent colour, labels under them, the bar itself rounded and
                // floating off the edges (the tablet keeps the Mac-like sidebar with coloured tiles).
                NavigationBar(
                    containerColor = pal.card, tonalElevation = 0.dp, windowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
                    modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 10.dp, top = 4.dp)
                        .shadow(14.dp, RoundedCornerShape(28.dp), ambientColor = Color.Black.copy(alpha = 0.12f), spotColor = Color.Black.copy(alpha = 0.12f))
                        .clip(RoundedCornerShape(28.dp)).height(72.dp),
                ) {
                    val item = @Composable { label: String, icon: ImageVector, selected: Boolean, dot: Boolean, go: () -> Unit ->
                        NavigationBarItem(
                            selected = selected, onClick = go,
                            icon = {
                                Box {
                                    Icon(icon, label, modifier = Modifier.size(24.dp))
                                    if (dot) Box(Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-2).dp)) { Dot(pal.good, 7) }
                                }
                            },
                            label = { Text(label, maxLines = 1, softWrap = false, fontSize = 12.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = pal.accent, selectedTextColor = pal.text, indicatorColor = pal.accentSoft,
                                unselectedIconColor = pal.muted, unselectedTextColor = pal.muted,
                            ),
                        )
                    }
                    for (t in BOTTOM) item(if (t == Tab.Connection) tr("Connect") else tr(t.title), t.icon, !more && tab == t, isOn(core, t)) { go(t, false) }
                    item(tr("More"), Ico.more, more || tab !in BOTTOM, false) { go(tab, true) }
                }
                }
            }
        }
    }
}

// The top of the sidebar: the logo, TwinDesk, and who is connected (the Mac's `.identity`).
@Composable
private fun Identity(core: Core, v: Int, logo: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Logo(logo)
        Column(Modifier.padding(start = 12.dp)) {
            Text("TwinDesk", fontWeight = FontWeight.Bold, fontSize = 19.sp, color = pal.text)
            Row(verticalAlignment = Alignment.CenterVertically) {
                val h = core.host
                val ph = core.peer.takeIf { h == null && it.connected }
                Dot(when { h != null || ph != null -> pal.good; core.link.pair != null || core.link.state == "connecting" -> pal.warn; else -> pal.faint }, 7)
                Text(
                    when {
                        h != null -> h.name + " · " + tr(core.net.via) + (core.link.rttMs?.let { " · $it ms" } ?: "")
                        ph != null -> ph.peerName + " · " + tr("Phone")
                        core.link.pair != null -> tr("Pairing…")
                        core.link.state == "connecting" -> tr("Connecting…")
                        else -> tr("Not connected")
                    },
                    color = pal.muted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp),
                )
            }
        }
    }
}

@Composable
private fun Sidebar(core: Core, v: Int, tab: Tab, go: (Tab) -> Unit) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    Column(Modifier.width(250.dp).fillMaxHeight().background(pal.sidebar).verticalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 14.dp)) {
        Box(Modifier.padding(start = 4.dp, bottom = 18.dp)) { Identity(core, v, 54) }
        Devices(core, v) { go(Tab.Overview) }
        var group: String? = null
        for (t in Tab.entries.filter { shown(core, it) }) {
            if (t.group == "bottom" && group != "bottom") Box(Modifier.padding(horizontal = 8.dp, vertical = 8.dp).fillMaxWidth().height(1.dp).background(pal.line))
            else if (group != null && t.group != group) Spacer(Modifier.height(10.dp))
            group = t.group
            NavItem(t.icon, t.colors, tr(t.title), tab == t, isOn(core, t)) { go(t) }
        }
    }
}

// Under the identity, as the computers' sidebars have them: the connected computer or phone, then
// the paired ones nearby. Tap the connected one: Overview; another: connect it (the session moves).
@Composable
private fun Devices(core: Core, v: Int, open: () -> Unit) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val link = core.link
    val peer = core.peer
    val host = core.host
    val phone = peer.connected && host == null
    class Dev(val id: String, val name: String, val isPhone: Boolean, val connected: Boolean, val sub: String, val go: () -> Unit)
    val list = mutableListOf<Dev>()
    if (host != null) list += Dev(host.id, host.name, false, true, tr(core.net.via) + (link.rttMs?.let { " · $it ms" } ?: ""), open)
    if (phone) list += Dev(peer.peerId, peer.peerName, true, true, tr("Phone · Connected"), open)
    for (h in core.hosts()) {
        if (h.id == host?.id || !core.isNear(h.id)) continue
        val connecting = link.state == "connecting" && link.host?.id == h.id
        list += Dev(h.id, h.name, false, false, if (connecting) tr("Connecting…") else tr("Nearby · Tap to connect")) {
            if (peer.connected) peer.disconnect()
            if (host != null) core.switchTo(h) else core.connect(h)
        }
    }
    if (peer.on) for (f in peer.nearby()) {
        if (!peer.isPaired(f.id) || (phone && f.id == peer.peerId)) continue
        list += Dev(f.id, f.name, true, false, if (peer.waitingFor == f.id) tr("Requesting connection…") else tr("Nearby · Tap to connect")) { peer.connect(f) }
    }
    if (list.isEmpty()) return
    Column(Modifier.padding(bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (d in list) {
            val shape = RoundedCornerShape(12.dp)
            Row(
                Modifier.fillMaxWidth().clip(shape)
                    .background(if (d.connected) pal.accentSoft else pal.card)
                    .border(1.dp, if (d.connected) pal.accent.copy(alpha = 0.7f) else pal.line, shape)
                    .clickable(onClick = d.go).padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(34.dp).clip(RoundedCornerShape(9.dp)).background(pal.content), contentAlignment = Alignment.Center) {
                    Icon(if (d.isPhone) Ico.phone else Ico.display, null, tint = if (d.connected) pal.accent else pal.muted, modifier = Modifier.size(20.dp))
                }
                Column(Modifier.padding(start = 10.dp).weight(1f)) {
                    Text(d.name, color = pal.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(d.sub, color = pal.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (d.connected) Dot(pal.good, 7)
            }
        }
    }
}

@Composable
private fun TopIdentity(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    Box(Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 14.dp)) { Identity(core, v, 36) }
}

@Composable
private fun MoreList(core: Core, v: Int, BOTTOM: List<Tab>, modifier: Modifier, go: (Tab) -> Unit) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp)) {
        PageHead(tr("More"), "")
        MacCard {
            Tab.entries.filter { it !in BOTTOM && shown(core, it) }.forEachIndexed { i, t ->
                Column {
                    if (i > 0) Box(Modifier.padding(start = 58.dp).fillMaxWidth().height(1.dp).background(pal.line))
                    Row(Modifier.fillMaxWidth().clickable { go(t) }.padding(horizontal = 16.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                        Tile(t.icon, t.colors, 30)
                        Text(tr(t.title), color = pal.text, fontSize = 16.sp, modifier = Modifier.padding(start = 12.dp).weight(1f))
                        if (wifiOnly(core, t)) Text(tr("Wi-Fi Direct"), color = pal.muted, fontSize = 12.sp)
                        if (isOn(core, t)) Dot(pal.good, 7)
                        Text("›", color = pal.faint, fontSize = 20.sp, modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun Page(core: Core, v: Int, tab: Tab, modifier: Modifier) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    Column(modifier.fillMaxHeight().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 20.dp)) {
        Column(Modifier.widthIn(max = 820.dp)) {
            if (peerMode(core) && tab != Tab.Connection && tab != Tab.General && tab != Tab.About) PeerPage(core, v, tab.name)
            else when (tab) {
                Tab.Overview -> OverviewPage(core, v, connection = false)
                Tab.Connection -> OverviewPage(core, v, connection = true)
                Tab.Calls -> CallsPage(core, v)
                Tab.Messages -> MessagesPage(core, v)
                Tab.Photos -> PhotosPage(core, v)
                Tab.FileAccess -> FileAccessPage(core, v)
                Tab.Screen -> ScreenPage(core, v)
                Tab.Cursor -> CursorPage(core, v)
                Tab.Keyboard -> KeyboardPage(core, v)
                Tab.Remote -> RemotePage(core, v)
                Tab.Clipboard -> ClipboardPage(core, v)
                Tab.Notifications -> NotificationsPage(core, v)
                Tab.Files -> FilesPage(core, v)
                Tab.Rezume -> RezumePage(core, v)
                Tab.Sound -> SoundPage(core, v)
                Tab.Media -> MediaPage(core, v)
                Tab.Camera -> CameraPage(core, v)
                Tab.General -> GeneralPage(core, v)
                Tab.About -> AboutPage(core, v)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

// The buttons in a row: one size everywhere, small enough that two fit beside a row's label
// (larger ones went onto a line of their own under it).
private val ROW_PAD = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 0.dp)

@Composable
private fun Primary(label: String, onClick: () -> Unit) = Button(onClick = onClick, colors = ButtonDefaults.buttonColors(containerColor = pal.accent, contentColor = Color.White),
    shape = if (Modern.on) RoundedCornerShape(50) else RoundedCornerShape(8.dp), contentPadding = ROW_PAD, modifier = Modifier.height(if (Modern.on) 40.dp else 36.dp)) { Text(label, fontSize = 14.sp, maxLines = 1, fontWeight = if (Modern.on) FontWeight.SemiBold else null) }

// A row of equal buttons (Ring, Lock, Sleep): tonal pills on the phone, outlined on the tablet.
@Composable
private fun ChipButton(onClick: () -> Unit, modifier: Modifier, content: @Composable RowScope.() -> Unit) =
    if (Modern.on) Button(onClick = onClick, modifier = modifier.height(44.dp), shape = RoundedCornerShape(50), elevation = null,
        colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = pal.text), content = content)
    else OutlinedButton(onClick = onClick, modifier = modifier, shape = RoundedCornerShape(8.dp), content = content)

@Composable
private fun Secondary(label: String, color: Color = pal.text, onClick: () -> Unit) =
    // The phone: a tonal pill (the accent's soft tint, no outline); the tablet: outlined, as the Mac's.
    if (Modern.on) Button(onClick = onClick, shape = RoundedCornerShape(50), contentPadding = ROW_PAD, modifier = Modifier.height(40.dp),
        colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = if (color == pal.text) pal.text else color), elevation = null,
    ) { Text(label, color = if (color == pal.text) pal.text else color, fontSize = 14.sp, maxLines = 1, fontWeight = FontWeight.Medium) }
    else OutlinedButton(onClick = onClick, shape = RoundedCornerShape(8.dp),
        contentPadding = ROW_PAD, modifier = Modifier.height(36.dp)) { Text(label, color = color, fontSize = 14.sp, maxLines = 1) }

@Composable
private fun NotConnected(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    Note(tr("Not connected. Connect to {name} from the Connection page.", "name" to them(core)), "warn")
}

// ---- Overview ----

@Composable
// One page, two halves: Connection (pairing, the link, Nearby, Switch to, Bluetooth, Scan QR code)
// and Overview (the link, the computer's controls, every feature's switches; only while connected).
private fun OverviewPage(core: Core, v: Int, connection: Boolean) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val link = core.link
    val host = core.host
    val me = core.store.deviceName
    val ip = remember(v) { core.adb.address() } // this phone's Wi-Fi address, for pairing by address on the computer
    if (!connection && host != null) PageHead(host.name, listOfNotNull(tr("Connected"), tr(core.net.via), link.rttMs?.let { "$it ms" }).joinToString(" · "))
    else if (LocalConfiguration.current.screenWidthDp >= 600) PageHead(tr("Connection"), listOf(me, ip).filter { it.isNotEmpty() }.joinToString(" · "))
    else PageHead(tr("Connection"), listOf(me, ip).filter { it.isNotEmpty() }.joinToString(" · "))

    // The computer rang this phone: Stop here too (and on its notification).
    if (core.dev.ringing) Row(
        Modifier.fillMaxWidth().padding(bottom = 16.dp).clip(RoundedCornerShape(12.dp)).background(pal.bad.copy(alpha = 0.12f)).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(tr("{name} is ringing this phone", "name" to (host?.name ?: tr("Your computer"))), color = pal.text, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Button(onClick = { core.dev.stopRing() }, colors = ButtonDefaults.buttonColors(containerColor = pal.bad, contentColor = Color.White), shape = RoundedCornerShape(8.dp)) { Text(tr("Stop")) }
    }
    if (connection) core.invite?.let { inv ->
        Note(tr("{name} wants to pair with this device.", "name" to inv.name))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 16.dp)) {
            Primary(tr("Pair")) { core.pair(inv) }
            Secondary(tr("Not now")) { core.dismissInvite() }
        }
    }
    if (connection) link.pair?.let { p ->
        MacCard(tr("Pairing with {name}", "name" to p.name)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (p.phase) {
                    "code", "waiting" -> if (p.wired || p.qr) {
                        Text(if (p.qr) tr("Click Allow on {name}.", "name" to p.name) else tr("On the USB cable. Click Allow on {name}.", "name" to p.name), color = pal.text)
                        Secondary(tr("Cancel")) { link.cancelPairing() }
                    } else {
                        Text(tr("Check that {name} shows the same code.", "name" to p.name), color = pal.text)
                        Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp, color = pal.text)
                        if (p.phase == "code") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Primary(tr("Codes match")) { link.confirmCode() }
                            Secondary(tr("Cancel")) { link.cancelPairing() }
                        } else Text(tr("Waiting for Allow on {name}…", "name" to p.name), color = pal.muted)
                    }
                    "failed" -> {
                        Text(p.error, color = pal.bad)
                        Secondary("OK") { link.cancelPairing() }
                    }
                    else -> {
                        Text(if (p.ble) tr("Connecting over Bluetooth…") else tr("Connecting…"), color = pal.muted)
                        Secondary(tr("Cancel")) { link.cancelPairing() }
                    }
                }
            }
        }
    }

    // The hero: this device, the link, the computer (the Mac's `.hero`). The phone: a card in the
    // accent's gradient with everything on it in white.
    val heroAccent = pal.accent
    if (Modern.on) HeroCard { HeroBody(core, v, me, host, link, heroAccent) } else MacCard { HeroBody(core, v, me, host, link, heroAccent) }


    // The computer's own controls (dev.state, DevCtl.kt): ring, lock, sleep, Bluetooth, Do not disturb, volume.
    if (!connection && host != null) ComputerCard(core, host.name)

    // Shortcuts (Tiles.kt): its screen, voice typing, the touchpad, files… as tiles, edited here.
    if (!connection && host != null) TilesCard(core)

    // The other paired computers, while connected: Switch (Take over when nearby) lets this one go and connects that one.
    if (connection && host != null) {
        val others = core.hosts().filter { it.id != host.id }
        if (others.isNotEmpty()) MacCard(tr("Switch to")) {
            others.forEachIndexed { i, h ->
                val near = core.isNear(h.id)
                MacRow(h.name, if (near && !core.discovery.found.containsKey(h.id)) tr("Paired · Nearby over Bluetooth") else if (near) tr("Paired · Nearby") else tr("Paired · Not nearby"), i == 0) {
                    Secondary(if (near) tr("Take over") else tr("Switch")) { core.switchTo(h) }
                }
            }
        }
        MacCard { BleSwitch(core, tr("Allow Nearby devices permission in General"), first = true) }
    }

    // What each feature does in each direction is on its own page (the switches are shared with the
    // computer): Overview keeps to the link, the computer's controls and the way to its screen.

    // Refresh: asks every computer on the network to answer now (they also announce themselves every few seconds).
    var looking by remember { mutableStateOf(false) }
    LaunchedEffect(looking) { if (looking) { kotlinx.coroutines.delay(1500); looking = false } }
    if (host == null) MacCard(tr("Nearby"), action = {
        TextButton(onClick = { looking = true; Thread { runCatching { core.discovery.probe() } }.start() }, enabled = !looking) {
            Text(if (looking) tr("Looking…") else tr("Refresh"), color = pal.accent, fontSize = 14.sp)
        }
    }) {
        val hosts = core.hosts()
        // The computer's QR code (Connection there): an extra way, next to these.
        val act = LocalContext.current
        if (core.peer.connected) MacRow(tr("Connected to {name}", "name" to core.peer.peerName), tr("Connecting to a computer ends the session with {name}", "name" to core.peer.peerName), true)
        MacRow(tr("Scan a QR code"), tr("On your computer, open Connection › Pair a phone with a QR code"), !core.peer.connected) { Secondary(tr("Scan")) { scanQr(act) } }
        var first = false
        for (h in hosts) {
            val near = core.isNear(h.id)
            MacRow(h.name, if (link.state == "connecting" && link.host?.id == h.id) tr("Connecting…") else if (near && !core.discovery.found.containsKey(h.id)) tr("Paired · Nearby over Bluetooth") else if (near) tr("Paired · Nearby") else tr("Paired · Not nearby"), first) {
                Secondary(tr("Forget"), pal.muted) { core.forget(h.id) }
                // Nearby: Take over (a phone's hello takes the computer from whoever has it).
                Primary(if (near) tr("Take over") else tr("Connect")) { core.connect(h) }
            }
            first = false
        }
        for (f in core.nearby().filter { f -> hosts.none { it.id == f.id } }) {
            MacRow(f.name, "${if (f.os == "mac") "Mac" else if (f.os == "linux") "Linux" else "PC"} · ${if (f.address.startsWith("ble:") || f.address.startsWith("blp:")) tr("Bluetooth") else f.address}", first) { Secondary(tr("Pair")) { core.pair(f) } }
            first = false
        }
        if (first) MacRow(tr("Looking for computers…"), if (core.bleOn && core.ble.allowed()) tr("Open TwinDesk on your computer. Use the same Wi-Fi network, or turn on Bluetooth.") else tr("Open TwinDesk on your computer, on the same Wi-Fi network"), true)
        BleSwitch(core, tr("Allow Nearby devices permission in General"))
        var addr by remember { mutableStateOf("") }
        Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(1.dp).background(pal.line))
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(tr("Pair by address"), color = pal.text, fontSize = 15.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(addr, { addr = it }, placeholder = { Text("192.168.1.20", color = pal.faint) }, singleLine = true, modifier = Modifier.weight(1f),
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = pal.text), shape = RoundedCornerShape(8.dp),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                Secondary(tr("Pair")) { if (addr.isNotBlank()) core.pairAddress(addr) }
            }
        }
    }

    // Connect with Android (PeerUi.kt): another phone, beside the computer, at the bottom.
    if (connection) AndroidSection(core, v)
}

// The connected computer's controls, when it has them (an older TwinDesk says nothing: no card).
@Composable
private fun ComputerCard(core: Core, name: String) {
    @Suppress("UNUSED_VARIABLE") val v = core.version.collectAsState().value // redraw on Core changes (Compose skips it otherwise: same core); read here, so it subscribes
    val c = core.dev.computer ?: return
    // Which TwinDesk the computer runs (its dev.state's app; none: older than 2.5): red when older than this one.
    val theirs = c.optJSONObject("app")?.optString("v").orEmpty()
    val older = theirs.isEmpty() || Updates.compare(theirs, BuildConfig.VERSION_NAME) < 0
    if (older) Note(if (theirs.isEmpty()) tr("{name} has an older version of TwinDesk. Update it to use all features.", "name" to name)
        else tr("{name} has TwinDesk {theirs} and this phone has {version}. Update TwinDesk on {name} to use all features.", "name" to name, "theirs" to theirs, "version" to BuildConfig.VERSION_NAME), "warn")
    val can = c.optJSONObject("can") ?: return
    if (can.length() == 0) return
    MacCard(name) {
        MacRow("TwinDesk", tr("On {name}", "name" to name), true) { Text(theirs.ifEmpty { tr("Older") }, color = if (older) pal.bad else pal.muted, fontSize = 14.sp) }
        val ringing = c.optBoolean("ringing")
        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (can.optBoolean("ring")) ChipButton({ core.dev.ask(if (ringing) "ringStop" else "ring") }, Modifier.weight(1f)) {
                Text(if (ringing) tr("Stop") else tr("Ring"), color = if (ringing) pal.bad else pal.text, maxLines = 1)
            }
            if (can.optBoolean("lock")) ChipButton({ core.dev.ask("lock") }, Modifier.weight(1f)) { Text(tr("Lock"), color = pal.text, maxLines = 1) }
            if (can.optBoolean("sleep")) ChipButton({ core.dev.ask("sleep") }, Modifier.weight(1f)) { Text(tr("Sleep"), color = pal.text, maxLines = 1) }
        }
        var first = true
        if (can.optBoolean("bluetooth") && c.has("bluetooth")) { SwitchRow(tr("Bluetooth"), tr("On {name}", "name" to name), c.optBoolean("bluetooth"), first = first) { core.dev.ask("bluetooth", "on" to it) }; first = false }
        if (can.optBoolean("dnd") && c.has("dnd")) { SwitchRow(tr("Do not disturb"), tr("On {name}", "name" to name), c.optBoolean("dnd"), first = first) { core.dev.ask("dnd", "on" to it) }; first = false }
        if (can.optBoolean("volume") && c.has("volume")) {
            if (!first) Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(1.dp).background(pal.line))
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                Text(tr("Volume"), color = pal.text, fontSize = 15.sp)
                MacSlider(c.optDouble("volume").toFloat(), 0f..1f, 0, { "${(it * 100).toInt()}%" }) { core.dev.ask("volume", "level" to it.toDouble()) }
            }
        }
    }
}

// TwinDesk's own Scan QR code: Google's code scanner where the phone has it (no camera permission
// here), else the camera app (it opens twindesk:// links too: QrActivity).
fun scanQr(ctx: android.content.Context) {
    val ok = runCatching {
        val opts = com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE).build()
        com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(ctx, opts).startScan()
            .addOnSuccessListener { b -> if (!QrActivity.open(ctx, b.rawValue.orEmpty())) android.widget.Toast.makeText(ctx, tr("That isn’t a TwinDesk pairing code"), android.widget.Toast.LENGTH_SHORT).show() }
            .addOnFailureListener { openCamera(ctx) }
    }.isSuccess
    if (!ok) openCamera(ctx)
}

private fun openCamera(ctx: android.content.Context) {
    android.widget.Toast.makeText(ctx, tr("Scan it with the Camera app to open TwinDesk"), android.widget.Toast.LENGTH_LONG).show()
    runCatching { ctx.startActivity(Intent(android.provider.MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

// Bluetooth with computers (Overview and General, as on the computers): for one that isn't on this
// network. Off by itself while the session is on the same Wi-Fi, on again when that drops (Core.bleTick).
@Composable
private fun BleSwitch(core: Core, askHint: String, first: Boolean = false) {
    @Suppress("UNUSED_VARIABLE") val v = core.version.collectAsState().value // redraw on Core changes (Compose skips it otherwise: same core); read here, so it subscribes
    val ctx = LocalContext.current
    val name = them(core)
    val link = core.link
    val allowed = (Ble.permissions() + BleServe.permissions() + Direct.permission()).all { ctx.checkSelfPermission(it) == android.content.pm.PackageManager.PERMISSION_GRANTED }
    SwitchRow(tr("Bluetooth with computers"), when {
        !core.bleOn -> tr("Off: only computers on this network or on USB")
        !core.ble.radioOn -> tr("Bluetooth is off on this device")
        !allowed -> askHint
        core.bleWifiOff && link.connected && core.net.via == "Wi-Fi" -> tr("Paused while on the same Wi-Fi as {name}; resumes if Wi-Fi drops", "name" to name)
        else -> tr("Connects to {name} when it isn’t on this network. Files and screens use a temporary Wi-Fi Direct link", "name" to name)
    }, core.bleOn, first = first) { core.store.setFlag("ble", it); core.changed() }
}

@Composable
private fun Device(name: String, phone: Boolean, modifier: Modifier) {
    val k = if (LocalConfiguration.current.screenWidthDp >= 600) 1f else 0.72f // smaller drawings on a phone
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        if (phone) Box(Modifier.width((34 * k).dp).height((60 * k).dp).clip(RoundedCornerShape(8.dp)).border(3.dp, pal.text.copy(alpha = 0.85f), RoundedCornerShape(8.dp)))
        else Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.width((84 * k).dp).height((54 * k).dp).clip(RoundedCornerShape(6.dp)).border(3.dp, pal.text.copy(alpha = 0.85f), RoundedCornerShape(6.dp)))
            Box(Modifier.padding(top = 3.dp).width((104 * k).dp).height(5.dp).clip(RoundedCornerShape(bottomStart = 6.dp, bottomEnd = 6.dp)).background(pal.text.copy(alpha = 0.85f)))
        }
        Text(name, fontWeight = FontWeight.SemiBold, color = pal.text, fontSize = 13.sp, maxLines = 2, lineHeight = 16.sp, textAlign = TextAlign.Center, overflow = TextOverflow.Ellipsis,
            softWrap = name.contains(' '), modifier = Modifier.padding(top = 8.dp, start = 2.dp, end = 2.dp))
    }
}

// ---- Wi-Fi Direct ----

// Over Bluetooth, a page that needs Wi-Fi says so and offers the way there (the Overview's
// Connect with Wi-Fi Direct): the page itself stays as it is.
@Composable
private fun WifiGate(core: Core, what: String) {
    @Suppress("UNUSED_VARIABLE") val v = core.version.collectAsState().value // redraw on Core changes (Compose skips it otherwise: same core); read here, so it subscribes
    if (core.host == null || !core.link.ble) return
    val n = core.net
    val moving = n.state in listOf("asking", "hosting", "joining")
    Note(
        when {
            moving -> tr("{what} is only available over Wi-Fi Direct. Connecting…", "what" to what)
            n.state == "failed" -> tr("{what} is only available over Wi-Fi Direct. {error}", "what" to what, "error" to (n.error.ifEmpty { tr("Wi-Fi Direct couldn’t start") }))
            else -> tr("{what} requires Wi-Fi Direct or the same Wi-Fi network. You’re connected over Bluetooth.", "what" to what)
        },
        "warn",
    )
    if (!moving) Row(Modifier.padding(bottom = 14.dp)) {
        Primary(if (n.state == "failed") tr("Try again") else tr("Connect with Wi-Fi Direct")) { core.net.need("user"); core.changed() }
    }
}

// ---- Calls, Messages, Photos, File access (on the computer, from this phone: Hub.kt) ----

// The top of each: the switch (the computer keeps it), and what's missing here, with Allow.
@Composable
private fun HubHead(core: Core, v: Int, what: String, title: String, desc: String): Boolean {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val hub = core.hub
    val name = them(core)
    val perm = hub.perm(what)
    val on = hub.on(what)
    PageHead(title, desc, if (core.host != null && hub.peer && perm != "none") on else null) {
        hub.set(what, it)
        if (it && perm != "ok") hub.askHere(what)
    }
    if (core.host == null) { NotConnected(core, v); return false }
    if (!hub.peer) { Note(tr("Update TwinDesk on {name} to use {title}.", "name" to name, "title" to title), "warn"); return false }
    when {
        perm == "none" && what == "files" -> Note(tr("File access requires Android 11 or later. You can still mount this phone on {name} using ADB.", "name" to name), "warn")
        perm == "none" -> Note(tr("{title} requires the full version of TwinDesk, as Android restricts downloaded apps from reading messages. Once wireless debugging is set up, install it from the Phone page on {name}. Your settings and pairings are kept.", "title" to title, "name" to name), "warn")
        !on -> Note(tr("Off. Turn it on on this phone or on {name}.", "name" to name))
        perm == "ask" -> {
            Note(
                when (what) {
                    "files" -> tr("Allow All files access so {name} can browse this phone’s storage. ADB isn’t required.", "name" to name)
                    "media" -> tr("Allow access to photos and videos so {name} can show them.", "name" to name)
                    else -> tr("{title} needs {count} permissions. You’ll be asked once.", "title" to title, "count" to Hub.wanted(what).size)
                },
                "warn",
            )
            Row(Modifier.padding(bottom = 14.dp)) { Primary(tr("Allow")) { hub.askHere(what) } }
        }
        perm == "partial" -> {
            Note(if (what == "media") tr("Only the photos you selected are shown on {name}.", "name" to name) else tr("Some {title} features need more permissions.", "title" to title))
            Row(Modifier.padding(bottom = 14.dp)) { Secondary(tr("Allow more")) { hub.askHere(what) } }
        }
        else -> Note(tr("On. {title} from this phone is available on {name}.", "title" to title, "name" to name))
    }
    return on && perm != "none"
}

@Composable
private fun CallsPage(core: Core, v: Int) {
    val name = them(core)
    if (!HubHead(core, v, "calls", tr("Calls"), tr("Answer, make and end calls on {name}.", "name" to them(core)))) return
    MacCard(tr("On {name}", "name" to name)) {
        MacRow(tr("Answer and decline"), tr("Shows incoming calls on {name}", "name" to name), first = true)
        MacRow(tr("Make calls"), tr("Use the keypad, contacts and recent calls on {name}", "name" to name))
    }
    // The computer as this phone's headset: paired over classic Bluetooth by the person, in Bluetooth
    // settings (TwinDesk doesn't pair them itself). Forget at the bottom.
    val hub = core.hub
    if (hub.btAudio) MacCard(tr("Sound on {name}", "name" to name)) {
        val bt = hub.btState()
        val allowed = bt.optBoolean("allowed", true)
        val bonded = bt.optBoolean("bonded")
        MacRow(
            tr("Bluetooth"),
            when {
                !allowed -> tr("Allow Nearby devices permission to check the Bluetooth pairing with {name}", "name" to name)
                !bt.optBoolean("radio", true) -> tr("Bluetooth is off on this phone")
                bt.optBoolean("bonding") -> tr("Pairing… Confirm the code on both devices")
                bt.optBoolean("forget") -> tr("Forget {name} in this phone’s Bluetooth settings, then pair them again", "name" to name)
                bonded -> tr("Paired with {name}. Call audio can play there.", "name" to name)
                bt.optBoolean("le") -> tr("Paired over Bluetooth LE only, which doesn’t support calls. Forget the device, then pair it again in Bluetooth settings.")
                !hub.btKnown -> tr("Waiting for {name}…", "name" to name)
                else -> tr("Not paired with {name} over Bluetooth. Pair them in Bluetooth settings, and TwinDesk connects automatically.", "name" to name)
            },
            first = true,
        ) {
            if (!allowed) Primary(tr("Allow")) { hub.askHere("bt") }
            else if (hub.btKnown && !bonded && !bt.optBoolean("bonding")) Secondary(tr("Open Bluetooth settings")) { hub.btSettings() }
        }
        var sure by remember { mutableStateOf(false) }
        MacRow(tr("Forget"), tr("Removes the Bluetooth pairing between this phone and {name}, then opens Bluetooth settings", "name" to name)) {
            TextButton(onClick = { if (sure) { sure = false; hub.forgetBt() } else { sure = true } }) { Text(if (sure) "Forget?" else tr("Forget"), color = pal.bad) }
        }
    }
}

@Composable
private fun MessagesPage(core: Core, v: Int) {
    val name = them(core)
    if (!HubHead(core, v, "messages", tr("Messages"), tr("Read and send text messages on {name}.", "name" to them(core)))) return
    MacCard(tr("On {name}", "name" to name)) {
        MacRow(tr("Conversations"), tr("Texts and MMS pictures in Messages on {name}", "name" to name), first = true)
        MacRow(tr("New texts"), tr("Shown as a badge in Messages on {name}", "name" to name))
    }
}

@Composable
private fun PhotosPage(core: Core, v: Int) {
    val name = them(core)
    WifiGate(core, tr("Photos on {name}", "name" to name))
    if (!HubHead(core, v, "media", tr("Photos"), tr("View and copy this phone’s photos and videos on {name}.", "name" to them(core)))) return
    MacCard(tr("On {name}", "name" to name)) {
        MacRow(tr("Photos, videos and screenshots"), tr("Newest first, in Photos on {name}", "name" to name), first = true)
        MacRow(tr("Save"), tr("Saved to the Downloads folder on {name}", "name" to name))
    }
}

@Composable
private fun FileAccessPage(core: Core, v: Int) {
    val name = them(core)
    WifiGate(core, tr("Phone Files on {name}", "name" to name))
    if (HubHead(core, v, "files", tr("File access"), tr("Browse this phone’s storage on {name} and copy files in either direction.", "name" to them(core)))) MacCard(tr("On {name}", "name" to name)) {
        MacRow(tr("Phone Files"), tr("Browse, upload, download, rename and delete files"), first = true)
        MacRow(tr("Without ADB"), tr("Uses All files access instead of ADB. To use ADB, mount the phone on {name}.", "name" to name))
        MacRow(tr("Connection"), tr("Works over USB, Wi-Fi and Wi-Fi Direct"))
    }
    if (core.host != null) SharedFolders(core, v)
}

// Shared folders, both ways (FolderShare.kt): this phone's in the computer's file manager, the
// computer's in the Files app here.
@Composable
private fun SharedFolders(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val ctx = LocalContext.current
    val sh = core.share
    val name = them(core)
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri -> if (uri != null) sh.choose(uri) }
    val ble = core.link.ble
    MacCard(tr("Shared folders")) {
        SwitchRow(
            tr("Share a folder with {name}", "name" to name),
            when {
                !sh.allowed -> tr("Requires All files access")
                ble && sh.on -> tr("{folder}. {name} opens it over Wi-Fi Direct.", "folder" to sh.shown(), "name" to name)
                sh.error.isNotEmpty() -> tr("Couldn’t share: {error}", "error" to sh.error)
                sh.on && sh.serving -> tr("{folder}. Open it on {name} in Phone Files › Shared folders.", "folder" to sh.shown(), "name" to name)
                else -> sh.shown()
            },
            sh.on, first = true,
        ) {
            sh.setOn(it)
            if (it && !sh.allowed) core.hub.askHere("files")
        }
        MacRow(tr("Folder"), sh.shown()) { Secondary(tr("Choose…")) { pick.launch(null) } }
        val pc = sh.pc
        MacRow(
            tr("{name}’s shared folder", "name" to name),
            when {
                ble && sh.opening -> tr("Connecting with Wi-Fi Direct…")
                ble && sh.pcServe -> tr("Opening connects over Wi-Fi Direct")
                pc != null -> tr("Available as “{name}” in the Files app and file pickers", "name" to pc.name)
                sh.pcServe -> tr("Opening…")
                else -> tr("Turn on to browse a folder on {name} from the Files app", "name" to name)
            },
        ) {
            if (pc != null) Primary(tr("Open")) { openPcShare(ctx) }
            else if (ble && sh.pcServe && !sh.opening) Primary(tr("Open")) { sh.openOverWifi() }
            MacSwitch(sh.pcServe, { sh.setPcServe(it) })
        }
    }
}

// The Files app at the computer's shared folder (its root; else the system's file picker there).
fun openPcShare(ctx: android.content.Context) {
    val root = android.provider.DocumentsContract.buildRootUri(PcShareProvider.authority(ctx), PcShareProvider.ROOT)
    val doc = android.provider.DocumentsContract.buildDocumentUri(PcShareProvider.authority(ctx), "/")
    val tries = listOf(
        Intent(Intent.ACTION_VIEW).setDataAndType(root, "vnd.android.document/root"),
        Intent(Intent.ACTION_VIEW).setDataAndType(doc, android.provider.DocumentsContract.Document.MIME_TYPE_DIR),
        Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI, doc),
    )
    for (i in tries) if (runCatching { ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)) }.isSuccess) return
}

// ---- Screen ----

// This device's camera on the computer (its Camera tab: phoneview.js openCamera, over wireless
// debugging): its picture in TwinDesk there, and with Virtual camera on there, a camera every app
// there can pick ("TwinDesk Camera").
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CameraPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val host = core.host
    val adb = core.adb
    val cam = adb.camera
    val name = them(core)
    val canShow = adb.paired || adb.known
    var facing by rememberSaveable { mutableStateOf("back") }
    val shown = if (cam.on) cam.facing ?: facing else facing
    PageHead(
        tr("Camera"),
        tr("Use this device’s camera on {name}, in TwinDesk or in any app.", "name" to name),
        master = if (host != null && (canShow || cam.on)) cam.on else null,
        onMaster = { adb.cameraOnComputer(it, facing) },
    )
    if (host == null) return NotConnected(core, v)
    MacCard(tr("This camera on {name}", "name" to name)) {
        MacRow(
            tr("Camera"),
            if (cam.on) tr("Switching may take a moment") else tr("Camera used when starting"),
            first = true,
        ) {
            SingleChoiceSegmentedButtonRow {
                val sides = listOf("back" to tr("camera|Back"), "front" to tr("camera|Front"))
                sides.forEachIndexed { i, (f, label) ->
                    SegmentedButton(
                        selected = shown == f,
                        onClick = { facing = f; if (cam.on) adb.cameraOnComputer(true, f) },
                        shape = SegmentedButtonDefaults.itemShape(i, sides.size),
                    ) { Text(label) }
                }
            }
        }
        MacRow(
            tr("On {name}", "name" to name),
            when {
                !canShow -> tr("Requires wireless debugging. Set it up from Overview.")
                cam.error.isNotEmpty() -> tr("Stopped: {error}", "error" to cam.error)
                cam.on && cam.virtual -> tr("Available as “TwinDesk Camera”. Choose it in Zoom, Teams or your browser.")
                cam.on -> tr("Shown on the Camera page in TwinDesk. Turn on Virtual camera there to use it in other apps.")
                else -> tr("Off")
            },
        )
    }
    Note(
        if (cam.virtual) tr("Virtual camera is on. Apps on {name} can use this camera as “TwinDesk Camera”.", "name" to name)
        else tr("To use this camera in apps like Zoom, Teams or a browser, turn on Virtual camera on the Camera page in TwinDesk on {name}.", "name" to name),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScreenPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val host = core.host
    val s = core.screen
    val ctx = LocalContext.current
    val name = them(core)
    PageHead(tr("Screen"), tr("Use this device as a display for {name}, either mirroring its screen or extending it.", "name" to name))
    if (host == null) return NotConnected(core, v)
    // The other way round: this device's screen in a window on the computer, over wireless debugging.
    // Paired now or before: the computer brings it back by itself (on Bluetooth, onto Wi-Fi first).
    val adb = core.adb
    val canShow = adb.paired || adb.known
    MacCard(tr("This screen on {name}", "name" to name)) {
        MacRow(
            tr("Show this screen on {name}", "name" to name),
            when {
                !canShow -> tr("Requires wireless debugging. Set it up from Overview.")
                adb.viewed -> tr("This device’s windows are open on {name}", "name" to name)
                else -> tr("Opens in a window you can control with the mouse and keyboard")
            },
            first = true,
        ) {
            if (adb.viewed) Secondary(tr("Close")) { adb.showOnComputer(false) }
            Button(onClick = { adb.showOnComputer(true) }, enabled = canShow, colors = ButtonDefaults.buttonColors(containerColor = pal.accent, contentColor = Color.White), shape = RoundedCornerShape(8.dp)) { Text(tr("Show")) }
        }
    }
    Note(
        when {
            !s.sharing -> tr("{name} isn’t sharing its screen.", "name" to name)
            s.mode == "extend" -> tr("{name} is extending its desktop to this screen.", "name" to name)
            else -> tr("{name} is mirroring its screen.", "name" to name)
        },
    )
    MacCard {
        MacRow(tr("Show {name}’s screen", "name" to name), tr("Opens full screen. Tap the handle at the top for display options and the keyboard."), first = true) {
            Primary(tr("Open")) { ctx.startActivity(Intent(ctx, ViewerActivity::class.java)) }
        }
        if (s.remote) MacRow(tr("Mode"), tr("Extend uses this device as a second display for {name}", "name" to name)) {
            // A phone: Mirror and Extend across the row's width, under the label.
            SingleChoiceSegmentedButtonRow(if (LocalConfiguration.current.screenWidthDp < 600) Modifier.fillMaxWidth() else Modifier) {
                val modes = listOf("mirror" to tr("Mirror"), "extend" to tr("Extend"))
                modes.forEachIndexed { i, (m, label) ->
                    SegmentedButton(selected = s.sharing && s.mode == m, onClick = { s.control(share = true, mode = m) }, shape = SegmentedButtonDefaults.itemShape(i, modes.size)) { Text(label) }
                }
            }
        } else MacRow(tr("Mode"), tr("Managed from {name}", "name" to name))
        if (s.sharing && s.remote) MacRow(tr("Sharing"), "") { Secondary(tr("Stop")) { s.control(share = false) } }
    }
    MacCard(tr("Touch")) {
        val pad = core.store.flag("screen.touchpad", true)
        SwitchRow(tr("Touchpad"), tr("Slide to move the pointer, like a laptop touchpad. When off, the pointer follows your finger."), pad, first = true) { s.setOpt("screen.touchpad", it) }
        if (pad) {
            MacRow(tr("Slide"), tr("Moves the pointer"))
            MacRow(tr("Tap"), if (core.remote.tapClick) tr("Clicks") else tr("No action (Tap to click is off in Remote)"))
            MacRow(tr("Touch and hold"), tr("Right-click"))
            MacRow(tr("Two fingers"), tr("Scrolls"))
        } else {
            MacRow(tr("Tap"), tr("Clicks"))
            MacRow(tr("Touch and hold"), tr("Right-click"))
            MacRow(tr("Drag"), tr("Select or move windows"))
            MacRow(tr("Two fingers"), tr("Scrolls"))
        }
        if (!s.inputOn) MacRow(tr("Input is off"), tr("{name} doesn’t accept input from this device. Turn on Receive input in Share screen on {name}.", "name" to name))
    }
    MacCard(tr("Stylus")) {
        SwitchRow(tr("Pen"), tr("Use the stylus as a drawing tablet on {name}, with pressure, tilt, eraser and side button. Touch is ignored while the pen is near. When off, the stylus acts as a mouse.", "name" to name), core.store.flag("screen.pen", true), first = true) { s.setOpt("screen.pen", it) }
        SwitchRow(tr("Fast writing"), tr("Lines reach {name} a little sooner but can lose points along the way. Leave off for smooth drawing and handwriting.", "name" to name), core.store.flag("screen.penFast", false), enabled = core.store.flag("screen.pen", true)) { s.setOpt("screen.penFast", it) }
    }
    MacCard(tr("Playback")) {
        // The same setting as Share screen › Resolution on the computer (pair.sync "res"): either side changes both.
        MacRow(tr("Resolution"), tr("The same as Share screen › Resolution on {name}", "name" to name), first = true) {
            SingleChoiceSegmentedButtonRow(if (LocalConfiguration.current.screenWidthDp < 600) Modifier.fillMaxWidth() else Modifier) {
                val res = core.sync.value("res")
                val sizes = listOf(1080 to "1080p", 1440 to "1440p", 2160 to "4K", 0 to tr("Full"))
                sizes.forEachIndexed { i, (h, label) ->
                    SegmentedButton(selected = res == h.toString(), onClick = { core.sync.setValue("res", h) }, shape = SegmentedButtonDefaults.itemShape(i, sizes.size)) { Text(label, maxLines = 1) }
                }
            }
        }
        SwitchRow(tr("{name}’s sound with the screen", "name" to name), tr("When {name} shares audio with its screen", "name" to name), core.store.flag("screen.sound", false)) { s.setOpt("screen.sound", it) }
        SwitchRow(tr("Smooth motion"), tr("Smoother playback with about one frame of added delay"), core.store.flag("screen.smooth", false)) { s.setOpt("screen.smooth", it) }
    }
}

// ---- Cursor ----

@Composable
private fun CursorPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val host = core.host
    val name = them(core)
    val me = core.store.deviceName
    // Over Bluetooth (pair.sync "ble", the computer's kvm.js): off, nothing crosses while the session runs through Bluetooth.
    val paused = core.link.ble && core.sync.value("ble") == "false"
    val shared = core.kvm.linked && core.sync.get("cursor", "in") && !paused
    PageHead(tr("Cursor"), tr("Move the pointer past the edge of the screen on {name} to control this device.", "name" to name), if (host != null) shared else null) {
        // Through Bluetooth, with cursor sharing on, the switch is Over Bluetooth: off there leaves it on for Wi-Fi.
        if (core.link.ble && core.kvm.linked && core.sync.get("cursor", "in")) core.sync.setValue("ble", it)
        else {
            if (it && !core.sync.get("cursor", "in")) core.sync.set("cursor", "in", true)
            if (it && core.link.ble) core.sync.setValue("ble", true)
            core.kvm.setLinked(it)
        }
    }
    if (host == null) return NotConnected(core, v)
    // Accessibility (chosen, or a session on Bluetooth): no wireless debugging needed, only the service.
    // ADB reached without wireless debugging (its TCP mode, on a direct Wi-Fi link) counts as there.
    val adbOn = core.adb.wifiDebugging || core.adb.paired
    val viaPhone = core.input.via == "phone" || (core.input.via == "auto" || core.link.ble) && !adbOn
    val adbMissing = !viaPhone && !adbOn
    Note(
        when {
            viaPhone && !core.input.supported -> tr("This version of TwinDesk can’t use Accessibility, as Play Protect restricts downloaded apps. ") +
                tr("Use wireless debugging instead, or install the full version of TwinDesk from the Phone page on {name}.", "name" to name)
            viaPhone && !core.input.on -> tr("Allow TwinDesk in Accessibility settings so {name} can tap and type on this device.", "name" to name)
            adbMissing -> tr("{name} controls this device through wireless debugging, which is off. You can also choose Limited below.", "name" to name)
            !core.pointer.allowed -> tr("Allow “Show the pointer” in General to see the pointer from {name}.", "name" to name)
            !core.kvm.linked -> tr("Cursor sharing is off. Double-tap {hotkey} on {name} to turn it on.", "hotkey" to core.kvm.hotkey, "name" to name)
            paused -> tr("Cursor sharing is paused over Bluetooth. It resumes on Wi-Fi, or double-tap {hotkey} on {name} to turn it on.", "hotkey" to core.kvm.hotkey, "name" to name)
            else -> tr("Move the pointer on {name} past the edge of its screen to control this device. Double-tap {hotkey} to return.", "name" to name, "hotkey" to core.kvm.hotkey)
        },
        if (adbMissing || viaPhone && !core.input.on || !core.pointer.allowed) "warn" else "info",
    )
    if (viaPhone && !core.input.supported) Row(Modifier.padding(bottom = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!adbOn) Primary(tr("Turn on wireless debugging")) { core.adb.turnOn() }
        if (core.adb.setupNeeded) Secondary(tr("Set up")) { Guide.open.value = true }
    }
    else if (viaPhone && !core.input.on) Row(Modifier.padding(bottom = 14.dp)) { Primary(tr("Allow")) { core.input.openSettings() } }
    else if (adbMissing || !viaPhone && core.adb.setupNeeded) Row(Modifier.padding(bottom = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (adbMissing) Primary(tr("Turn on wireless debugging")) { core.adb.turnOn() }
        if (core.adb.setupNeeded) Secondary(tr("Set up")) { Guide.open.value = true }
    }
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow(tr("Use {name}’s mouse and keyboard on {me}", "name" to name, "me" to me), tr("Move the pointer past the edge of the screen"), core.sync.get("cursor", "in"), first = true) { core.sync.set("cursor", "in", it) }
        MacRow(tr("Control method"), when {
            core.input.via == "auto" && core.input.effective == "adb" -> tr("Auto: Full (ADB), wireless debugging is on")
            core.input.via == "auto" -> tr("Auto: Limited until wireless debugging is on")
            core.input.via == "phone" -> tr("Limited: taps and types through Accessibility, over Wi-Fi, Wi-Fi Direct and Bluetooth, without developer options")
            else -> tr("Full (ADB): full control through wireless debugging. Limited is used over Bluetooth.")
        }) {
            SingleChoiceSegmentedButtonRow {
                val ways = listOf("auto" to tr("Auto"), "adb" to tr("Full (ADB)"), "phone" to tr("Limited"))
                ways.forEachIndexed { i, (w, label) ->
                    SegmentedButton(selected = core.input.via == w, onClick = { core.input.setVia(w); core.changed() }, shape = SegmentedButtonDefaults.itemShape(i, ways.size)) { Text(label, maxLines = 1) }
                }
            }
        }
    }
    MacCard(tr("Where {name} is", "name" to name)) { LayoutPicker(me, name, core.kvm.macSide) { core.kvm.setMacSide(it) } }
    MacCard(tr("Pointer")) {
        val speed = core.sync.value("speed").toFloatOrNull() ?: 1f
        MacRow(tr("Pointer speed"), "", first = true) {
            MacSlider(speed, 0.25f..4f, 14, { "%.2f×".format(it) }) { v ->
                val steps = listOf(0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f, 2.5f, 3f, 3.5f, 4f)
                val snapped = steps.minBy { kotlin.math.abs(it - v) }
                core.sync.setValue("speed", if (snapped % 1f == 0f) snapped.toInt() else snapped)
            }
        }
        SwitchRow(tr("Reverse scrolling"), tr("Invert the scroll direction on this device"), core.sync.value("reverseScroll") == "true") { core.sync.setValue("reverseScroll", it) }
        MacRow(tr("Right-click"), tr("Back"))
        MacRow(tr("Middle click"), tr("Home"))
    }
    MacCard(tr("Not on the same network")) {
        SwitchRow(tr("Over Bluetooth"), tr("Keeps working over Bluetooth when {name} isn’t on this network, at a slower rate. When off, it pauses until you’re back on Wi-Fi.", "name" to name),
            core.sync.value("ble") != "false", first = true) { core.sync.setValue("ble", it) }
    }
}

// ---- Keyboard ----

@Composable
private fun KeyboardPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val host = core.host
    val name = them(core)
    val me = core.store.deviceName
    val on = core.sync.value("keyboard") == "true"
    PageHead(tr("Keyboard"), tr("Type on whichever device the pointer is on."), if (host != null) on else null) { core.sync.setValue("keyboard", it) }
    if (host == null) return NotConnected(core, v)
    Note(if (on) tr("The keyboard on {name} types on this device while its pointer is here.", "name" to name) else tr("Keyboard sharing is off. Only the pointer is shared."))
    MacCard(tr("Hotkey")) {
        MacRow(core.kvm.hotkey, tr("Double-tap on {name} to turn cursor sharing on or off. You can change it in TwinDesk on {name}.", "name" to name), first = true)
    }
    MacCard {
        DirHead(name, false, me, true)
        MacRow(tr("Shortcuts"), tr("⌘ works as Ctrl, so ⌘C copies and ⌘V pastes"), first = true)
        MacRow(tr("Typing"), tr("Keys are sent directly, so any keyboard layout works and the on-screen keyboard stays hidden"))
    }
    MacCard(tr("In the screen view")) {
        MacRow(tr("{name}’s screen here", "name" to name), tr("A keyboard connected to this device types on {name}. Tap Keyboard to open the on-screen keyboard.", "name" to name), first = true)
    }
}

// ---- Remote ----

// ReZume (Rezume.kt): the computer's tab or document here, this phone's tab or app there.
@Composable
private fun RezumePage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val r = core.rezume
    val ctx = LocalContext.current
    val name = them(core)
    PageHead("ReZume", tr("Continue the web page, document or app you were using, on this phone or on {name}.", "name" to name), r.on) { r.set("on", it) }
    if (!r.on) return Note(tr("Off. When on, the page or app you’re using is offered to {name}, and what you’re using on {name} is offered here.", "name" to name))
    if (core.host == null) return NotConnected(core, v)
    val o = r.incoming
    if (o != null) MacCard(tr("Continue from {name}", "name" to name)) {
        MacRow(o.title, if (o.kind == "web") (android.net.Uri.parse(o.url).host ?: o.url) else o.name, first = true) {
            Primary(tr("Open")) { r.take(o, ctx) }
            Spacer(Modifier.width(8.dp))
            Secondary(tr("Dismiss")) { r.dismiss() }
        }
    }
    val p = r.peer
    Note(when {
        p == null -> tr("ReZume isn’t available on {name}. Update TwinDesk there.", "name" to name)
        !p.optBoolean("on") -> tr("ReZume is off on {name}. Turn it on there as well.", "name" to name)
        InputService.running == null && core.adb.wifiDebugging -> tr("Ready. {name} can continue this phone’s apps through wireless debugging. To include web pages, turn on Accessibility for TwinDesk.", "name" to name)
        InputService.running == null -> tr("You can continue pages and documents from {name}. To send this phone’s pages, turn on Accessibility for TwinDesk, or wireless debugging for apps.", "name" to name)
        r.offered.isNotEmpty() -> tr("Offered to {name}: {offered}", "name" to name, "offered" to r.offered)
        else -> "Ready."
    }, if (p == null || !p.optBoolean("on")) "warn" else "info")
    if (r.message.isNotEmpty()) Note(r.message)
    if (InputService.running == null) MacCard {
        MacRow(tr("Accessibility"), tr("Used only to detect the active app and the browser’s current address"), first = true) {
            Secondary(tr("Open settings")) { ctx.startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
    }
    MacCard(tr("Content")) {
        SwitchRow(tr("Web pages"), tr("The active tab in Chrome, Firefox, Edge, Samsung Internet, Brave, Opera, Vivaldi or DuckDuckGo"), r.opt("web"), first = true) { r.set("web", it) }
        SwitchRow(tr("Documents"), tr("Open the active document from {name} on this phone", "name" to name), r.opt("docs")) { r.set("docs", it) }
        SwitchRow(tr("Apps"), tr("Open the active app on {name} in its own window. Requires wireless debugging.", "name" to name), r.opt("apps")) { r.set("apps", it) }
    }
    MacCard(tr("Sharing")) {
        SwitchRow(tr("Send from this device"), tr("{name} can continue what you’re using", "name" to name), r.opt("send"), first = true) { r.set("send", it) }
        SwitchRow(tr("Take {name}’s", "name" to name), tr("Receive from {name}", "name" to name), r.opt("receive")) { r.set("receive", it) }
        SwitchRow(tr("Open received items automatically"), tr("Items sent from {name} open without asking. Requires Display over other apps, otherwise a notification is shown.", "name" to name), r.opt("push")) { r.set("push", it) }
    }
    MacCard(tr("Items from {name}", "name" to name)) {
        SwitchRow(tr("Show a notification"), tr("A silent notification that’s replaced by the next one"), r.opt("notify"), first = true) { r.set("notify", it) }
    }
    Note(tr("Share a link to “Open on computer” to open it on {name}.", "name" to name))
}

@Composable
private fun RemotePage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val r = core.remote
    val ctx = LocalContext.current
    val name = them(core)
    val me = core.store.deviceName
    PageHead(tr("Remote"), tr("Use this device as {name}’s touchpad and keyboard, a gamepad, or to type by voice.", "name" to name))
    if (core.host == null) {
        NotConnected(core, v)
        return BtPadCard(core) // works without TwinDesk on the computer
    }
    if (r.unsupported) Note(tr("{name} doesn’t support Remote. Update TwinDesk there.", "name" to name), "warn")
    else if (r.allowed == false) Note(r.why.ifEmpty { tr("{name} doesn’t accept input from this device. Turn on Remote in TwinDesk on {name}.", "name" to name) }, "warn")
    val open = { mode: String -> ctx.startActivity(Intent(ctx, RemoteActivity::class.java).putExtra("mode", mode)) }
    MacCard {
        MacRow(tr("Touchpad and keyboard"), tr("Slide to move the pointer, tap to click, touch and hold to right-click, and scroll with two fingers. Includes a keyboard and media keys."), first = true) {
            Primary(tr("Open")) { open("pad") }
        }
        MacRow(tr("Gamepad"), tr("Hold the phone sideways like a controller. The left stick acts as WASD and the right stick as the mouse. Customise buttons with Keys.")) {
            Primary(tr("Open")) { open("gamepad") }
        }
        MacRow(tr("Voice typing"), tr("Speak with your keyboard’s voice typing (Gboard’s microphone). Each word is typed on {name} as it appears, and fixes are typed there too.", "name" to name)) {
            Primary(tr("Open")) { open("voice") }
        }
    }
    MacCard(tr("Touchpad")) {
        MacRow(tr("Pointer speed"), tr("Also applies to the gamepad’s right stick and the screen touchpad"), first = true) {
            MacSlider(r.speed, 0.3f..3f, 0, { "%.1f×".format(java.util.Locale.ROOT, it) }) { r.setSpeed(it) }
        }
        SwitchRow(tr("Tap to click"), tr("Tap to click. When off, use the click buttons."), r.tapClick) { r.setTapClick(it) }
        SwitchRow(tr("Smooth motion"), tr("Smoother pointer movement on {name}, with about one frame of added delay", "name" to name), r.smooth) { r.setSmooth(it) }
    }
    BtPadCard(core)
    Note(
        when {
            core.link.wired -> tr("Connected by USB, the fastest connection for games.")
            core.link.ble -> tr("Over Bluetooth, the pointer updates about 30 times a second. Wi-Fi or USB is faster.")
            else -> tr("Over Wi-Fi, the response time is shown at the top of the app. For games, USB is fastest.")
        },
    )
}

// As a Bluetooth gamepad (BtPad.kt): any computer, the Mac too, no driver and no TwinDesk there.
@Composable
private fun BtPadCard(core: Core) {
    @Suppress("UNUSED_VARIABLE") val v = core.version.collectAsState().value // redraw on Core changes (Compose skips it otherwise: same core); read here, so it subscribes
    val ctx = LocalContext.current
    val made = core.btPadMade
    val on = core.store.flag("remote.btpad", false)
    val pad = if (made || on) core.btPad else null
    LaunchedEffect(on) { if (on) core.btPad.start() }
    val findable = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { core.changed() }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { got ->
        if (got.values.all { it }) { core.btPad.setOn(true); findable.launch(core.btPad.discoverableIntent()) }
        else ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
    }
    val state = pad?.state ?: "off"
    MacCard(tr("As a Bluetooth gamepad")) {
        SwitchRow(tr("As a Bluetooth gamepad"), tr("Use this phone as a Bluetooth game controller for any computer, without drivers or TwinDesk. ") +
            tr("Works with games that support any controller, such as Steam and emulators. For Xbox-only games on Windows, use Real gamepad on the PC."), on, first = true) { v ->
            if (!v) core.btPad.setOn(false)
            else if (!core.btPad.allowed()) ask.launch(BtPad.permissions())
            else { core.btPad.setOn(true); findable.launch(core.btPad.discoverableIntent()) }
        }
        if (on) {
            MacRow(tr("Status"), when (state) {
                "starting" -> tr("Starting…")
                "unavailable" -> pad?.message ?: ""
                "connected" -> tr("Connected to {hostName}. Open the gamepad to play.", "hostName" to pad?.hostName)
                "ready" -> tr("Ready. Waiting for a computer to connect.")
                else -> pad?.message?.ifEmpty { tr("Off") } ?: tr("Off")
            }) { if (state == "connected") Primary(tr("Open")) { ctx.startActivity(Intent(ctx, RemoteActivity::class.java).putExtra("mode", "gamepad")) } }
            if (state == "ready") {
                MacRow(tr("Pair it once"), tr("On the computer, open Bluetooth settings and add a device, ") +
                    tr("then choose “{deviceName}”. It reconnects automatically while this is on.", "deviceName" to core.store.deviceName)) {
                    Secondary(tr("Make discoverable")) { findable.launch(core.btPad.discoverableIntent()) }
                }
            }
        }
    }
}

// ---- Clipboard ----

@Composable
private fun ClipboardPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val name = them(core)
    val me = core.store.deviceName
    val ctx = LocalContext.current
    PageHead(tr("Clipboard"), tr("Copy on one device and paste on the other."))
    if (core.host == null) NotConnected(core, v)
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow(tr("Receive from {name}", "name" to name), tr("At once"), core.sync.get("clipboard", "in"), first = true) { core.sync.set("clipboard", "in", it) }
    }
    MacCard {
        DirHead(me, true, name, false)
        SwitchRow(tr("Send to {name}", "name" to name), tr("While TwinDesk is open, or at any time with wireless debugging"), core.sync.get("clipboard", "out"), first = true) { core.sync.set("clipboard", "out", it) }
        if (core.host != null) MacRow(tr("Send the clipboard now"), tr("Also available as a Quick Settings tile")) { Secondary(tr("Send")) { core.clip.sendCurrent(true) } }
    }
    // Pictures both ways, this device's screenshots among them (Clip.kt, Screenshots.kt). Finding
    // new screenshots needs photo access.
    val clip = core.clip
    val shots = core.shots
    val askPhotos = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted && !shots.canRead) ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
        core.changed()
    }
    MacCard(tr("Pictures")) {
        SwitchRow(tr("Pictures"), tr("Copy pictures and screenshots up to 10 MB in both directions. Also turn on Pictures on {name}. Not available over Bluetooth.", "name" to name), clip.picturesOn, first = true) { clip.setPictures(it); shots.watch() }
        if (clip.picturesOn && core.host != null && !clip.peerImages) MacRow(tr("Off on {name}", "name" to name), tr("Turn on Pictures in Clipboard on {name} (TwinDesk 2.3 or later)", "name" to name))
        if (clip.picturesOn) {
            SwitchRow(tr("Send screenshots to {name}", "name" to name), tr("New screenshots are copied to the clipboard on {name}", "name" to name), shots.on) { shots.setOn(it) }
            if (shots.on && !shots.canRead) MacRow(tr("Allow photo access"), tr("TwinDesk only checks for new screenshots")) { Primary(tr("Allow")) { askPhotos.launch(shots.permission) } }
            if (shots.lastSent.isNotEmpty()) MacRow(tr("Last screenshot sent"), shots.lastSent)
        }
    }
    if (clip.history.isNotEmpty()) MacCard(tr("Recent")) {
        clip.history.toList().take(12).forEachIndexed { i, item ->
            // A picture of ours isn't kept here: only the computer's copy again.
            val again = item.dir == "in" || item.picture == null
            MacRow(item.text.replace('\n', ' ').take(120), (if (item.dir == "in") tr("From {name}", "name" to name) else tr("To {name}", "name" to name)) + if (again) tr(" · tap to copy") else "", first = i == 0, onClick = if (again) ({ clip.copyAgain(item) }) else null)
        }
    }
}

// ---- Notifications ----

@Composable
private fun NotificationsPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val name = them(core)
    val me = core.store.deviceName
    val ctx = LocalContext.current
    PageHead(tr("Notifications"), tr("See notifications from both devices."))
    if (core.host == null) NotConnected(core, v)
    if (!core.notifs.supported) Note(
        tr("This version of TwinDesk can’t read notifications, as Play Protect restricts downloaded apps. ") +
            tr("Once wireless debugging is set up, install the full version from the Phone page on {name}. Your settings and pairings are kept.", "name" to name),
        "warn",
    )
    else if (!core.notifs.hasAccess) Note(tr("Allow Notification access to show this device’s notifications on {name}.", "name" to name), "warn")
    MacCard {
        DirHead(me, true, name, false)
        SwitchRow(tr("Show this device’s notifications on {name}", "name" to name), tr("{count} sent", "count" to core.notifs.sent), core.sync.get("notifs", "out"), first = true) { core.sync.set("notifs", "out", it) }
        SwitchRow(tr("Hide the message text"), tr("Only the app name and title are shown on {name}", "name" to name), core.store.flag("notifs.hideText", false)) { core.store.setFlag("notifs.hideText", it); core.changed() }
        if (core.notifs.supported && !core.notifs.hasAccess) MacRow(tr("Notification access"), tr("Required to read notifications")) { Primary(tr("Allow")) { ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) } }
        if (!core.notifs.supported && !core.adb.paired) MacRow(tr("Wireless debugging"), tr("Set it up, then install the full version from {name}", "name" to name)) { Primary(tr("Guide")) { Guide.open.value = true } }
    }
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow(tr("Show {name}’s notifications here", "name" to name), tr("{count} shown", "count" to core.notifs.shown), core.sync.get("notifs", "in"), first = true) { core.sync.set("notifs", "in", it) }
    }
    // Each app on its own (#102): every app on the phone, as a block list or an allow list (AppCards.kt).
    if (core.notifs.supported) NotifAppsCard(core, name)
}

// ---- Files ----

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FilesPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val host = core.host
    val ctx = LocalContext.current
    val name = them(core)
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty()) core.files.send(core.files.describe(uris), "send") }
    val pickCopy = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty()) core.fclip.copy(core.files.describe(uris)) }
    PageHead(tr("Files"), tr("Send, copy and drag files between your devices."))
    if (host == null) return NotConnected(core, v)

    core.fclip.incoming?.let { o ->
        MacCard(tr("Copied on {name}", "name" to name)) {
            MacRow(if (o.names.size == 1) o.names[0] else tr("{count} items", "count" to o.names.size), FileClip.size(o.bytes), first = true) {
                Primary(tr("Copy")) { core.fclip.fetch(o.id, save = false) }
                Secondary(tr("Save")) { core.fclip.fetch(o.id, save = true) }
            }
        }
    }

    MacCard(tr("Send to {name}", "name" to name)) {
        MacRow(tr("Send files"), tr("Saved to the Downloads folder on {name}. You can also share from any app.", "name" to name), first = true) { Primary(tr("Choose…")) { pick.launch("*/*") } }
        MacRow(tr("Copy files"), tr("Choose files, then paste them anywhere on {name} with ⌃⌥V", "name" to name)) { Secondary(tr("Choose…")) { pickCopy.launch("*/*") } }
        // Drag files here from another app (split screen or a floating window).
        var over by remember { mutableStateOf(false) }
        val target = remember {
            object : DragAndDropTarget {
                override fun onEntered(event: DragAndDropEvent) { over = true }
                override fun onExited(event: DragAndDropEvent) { over = false }
                override fun onEnded(event: DragAndDropEvent) { over = false }
                override fun onDrop(event: DragAndDropEvent): Boolean {
                    over = false
                    val e = event.toAndroidDragEvent()
                    (ctx as? android.app.Activity)?.requestDragAndDropPermissions(e)
                    val clip = e.clipData ?: return false
                    val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
                    if (uris.isNotEmpty()) core.bg.execute { core.files.send(core.files.describe(uris), "send") }
                    else clip.getItemAt(0)?.text?.toString()?.let { core.clip.sendText(it) }
                    return true
                }
            }
        }
        Box(
            Modifier.padding(horizontal = 16.dp, vertical = 12.dp).fillMaxWidth().height(if (Modern.on) 52.dp else 100.dp)
                .clip(RoundedCornerShape(if (Modern.on) 16.dp else 10.dp))
                .let { if (Modern.on) it.background(if (over) pal.accentSoft else pal.chip) else it.border(2.dp, if (over) pal.accent else pal.faint.copy(alpha = 0.5f), RoundedCornerShape(10.dp)).background(if (over) pal.accentSoft else Color.Transparent) }
                .dragAndDropTarget(shouldStartDragAndDrop = { ev -> ev.mimeTypes().isNotEmpty() }, target = target),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Ico.files, null, tint = if (over) pal.accent else pal.muted, modifier = Modifier.size(18.dp))
                Text(if (over) tr("Drop to send to {name}", "name" to name) else tr("Or drag files here"), color = if (over) pal.accent else pal.muted, fontSize = 13.5.sp, maxLines = 1)
            }
        }
    }
    MacCard(tr("From {name}", "name" to name)) {
        MacRow(tr("Drag across the screen edge"), tr("Files you drag to this device are saved in Downloads › TwinDesk"), first = true)
        MacRow(tr("Copy on {name} with ⌃⌥C", "name" to name), tr("Paste the files here, or save them to this device"))
        MacRow(tr("Drop on the phone window"), tr("Files dropped on this phone’s window on {name} are saved to this device", "name" to name))
    }

    val moving = core.files.sending.map { Triple(tr("Sending {file}", "file" to it.name), Files.pct(it.sent, it.bytes), it.id) } +
        core.files.receiving.map { Triple(tr("Receiving {files}", "files" to trCount(it.count, "file")), Files.pct(it.got, it.bytes), it.id) }
    if (moving.isNotEmpty() || core.fclip.status.isNotEmpty()) MacCard(tr("In progress")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((label, pct, id) in moving) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("$label · $pct%", color = pal.text, modifier = Modifier.weight(1f))
                    Secondary(tr("Cancel")) { core.files.cancel(id) }
                }
                LinearProgressIndicator(progress = { pct / 100f }, modifier = Modifier.fillMaxWidth(), color = pal.accent, trackColor = pal.trackOff)
            }
            if (core.fclip.status.isNotEmpty()) Text(core.fclip.status, color = pal.muted)
        }
    }
    if (core.files.recent.isNotEmpty()) MacCard(tr("Recent")) {
        core.files.recent.take(10).forEachIndexed { i, r -> MacRow(r, "", first = i == 0) }
        MacRow(tr("Clear this list"), tr("Only the list here. The files stay where they are.")) { Secondary(tr("Clear")) { core.files.clearRecent() } }
        MacRow(tr("Downloads"), "") { Secondary(tr("Show")) { ctx.startActivity(Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
    }
}

// ---- Sound ----

@Composable
private fun SoundPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val name = them(core)
    val me = core.store.deviceName
    PageHead(tr("Sound"), tr("Play audio from one device on the other."))
    if (core.host == null) NotConnected(core, v)
    else WifiGate(core, tr("Sound"))
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow(tr("Play {name}’s sound here", "name" to name), if (core.macSound.playing) tr("Playing") else "", core.sync.get("audio", "in"), first = true) { core.sync.set("audio", "in", it) }
    }
    MacCard {
        DirHead(me, true, name, false)
        SwitchRow(tr("Play this device’s sound on {name}", "name" to name), soundHint(core), core.sync.get("audio", "out"), first = true) { core.sync.set("audio", "out", it) }
        SoundStart(core)
    }
    Note(tr("Audio from screen sharing plays in the screen view. See Screen › Playback."))
}

// This device's sound there: through wireless debugging, else captured here (Sound.kt).
private fun soundHint(core: Core) = when {
    core.sound.on -> tr("Playing on the other device. Stop it from the notification.")
    core.sound.error.isNotEmpty() -> core.sound.error
    else -> tr("Uses wireless debugging when available. Otherwise, TwinDesk asks to capture audio each time.")
}

// The computer is waiting for the capture: Start here, as in the notification.
@Composable
private fun SoundStart(core: Core) {
    @Suppress("UNUSED_VARIABLE") val v = core.version.collectAsState().value // redraw on Core changes (Compose skips it otherwise: same core); read here, so it subscribes
    val ctx = LocalContext.current
    if (core.mirror.wanted && !core.mirror.on) MacRow(tr("Show this screen"), core.mirror.error.ifEmpty { tr("Android asks once to share the screen") }) { Primary(tr("Start")) { core.sound.start(ctx) } }
    else if (core.mirror.on) MacRow(tr("Screen shared"), tr("Close its window on the computer, or Stop, to end it.")) { Secondary(tr("Stop")) { core.sound.stop() } }
    if (core.sound.wanted && !core.sound.on) MacRow(tr("Start the sound"), tr("Android asks for permission to capture audio")) { Primary(tr("Start")) { core.sound.start(ctx) } }
    else if (core.sound.on) MacRow(tr("Captured sound"), tr("Audio also plays on this phone. Use wireless debugging to play it only on the computer.")) { Secondary(tr("Stop")) { core.sound.stop() } }
}

// ---- General ----

@Composable
private fun GeneralPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val ctx = LocalContext.current
    val name = them(core)
    var dev by remember { mutableStateOf(core.store.deviceName) }
    PageHead(tr("General"), "")
    MacCard(tr("Startup")) {
        SwitchRow(tr("Run in the background"), if (core.background) tr("Stays connected while TwinDesk is closed, and starts with the phone") else tr("Connected only while TwinDesk is open"), core.background, first = true) { core.background = it }
    }
    // Connections (#143): quiet links (Link.kt) and reconnecting with TwinDesk closed.
    MacCard(tr("Connections")) {
        SwitchRow(tr("Prioritize performance over battery life"), if (core.performance) tr("Checks the connection every second, even when nothing is in use") else tr("Checks an idle connection every few minutes, and immediately when a feature starts"), core.performance, first = true) { core.performance = it }
        SwitchRow(tr("Reconnect in the background"), if (core.reconnectBg) tr("Restores a dropped connection while TwinDesk is closed") else tr("Restores a dropped connection when TwinDesk opens"), core.reconnectBg) { core.reconnectBg = it }
    }
    TailscaleCard(core) // #161 (Tailnet.kt)
    val pm = ctx.getSystemService(PowerManager::class.java)
    @Composable
    fun Setup(label: String, hint: String, done: Boolean, action: String, first: Boolean = false, onClick: () -> Unit) =
        MacRow(label, hint, first) { if (done) Pill(tr("Allowed"), "good") else Primary(action, onClick) }
    // Bluetooth and Wi-Fi Direct, for a computer not on this network.
    val nearbyPerms = (Ble.permissions() + BleServe.permissions() + Direct.permission()).distinct().toTypedArray()
    val nearbyAllowed = nearbyPerms.all { ctx.checkSelfPermission(it) == android.content.pm.PackageManager.PERMISSION_GRANTED }
    val askNearby = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions(),
    ) { core.changed() }
    val askNotify = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) { core.changed() }
    // Every permission and feature in one place: each is asked for only when switched on elsewhere,
    // or here.
    MacCard(tr("Permissions")) {
        if (Build.VERSION.SDK_INT >= 33) Setup(tr("Notifications"), tr("Incoming files, pairing requests and connection status"),
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED, tr("Allow")) {
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // Calls, Messages, Photos and Files on $name (Hub): what each needs, asked here too.
        for ((what, hint) in listOf(
            "calls" to tr("Answer and make calls on {name}", "name" to name),
            "messages" to tr("Read and send texts on {name}", "name" to name),
            "media" to tr("Your photos and videos on {name}", "name" to name),
            "files" to tr("Browse this device’s storage and shared folders on {name}", "name" to name),
        )) {
            val perm = core.hub.perm(what)
            if (perm == "none") MacRow(Hub.label(what), if (what == "files") tr("Requires Android 11 or later") else tr("Requires the full version of TwinDesk (install it from {name})", "name" to name))
            else Setup(Hub.label(what), if (perm == "partial") tr("Partially allowed · {hint}", "hint" to hint) else hint, perm == "ok", tr("Allow")) { core.hub.askHere(what) }
        }
        if (core.notifs.supported) Setup(tr("Notification access"), tr("Show this device’s notifications on {name}", "name" to name), core.notifs.hasAccess, tr("Allow")) {
            ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } else MacRow(tr("Notification access"), tr("Requires the full version of TwinDesk (install it from {name})", "name" to name))
        Setup(tr("Battery optimization"), tr("Exempts TwinDesk so {name} can connect at any time", "name" to name), pm.isIgnoringBatteryOptimizations(ctx.packageName), tr("Allow")) {
            @Suppress("BatteryLife")
            ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
        }
        MacRow(
            tr("Wireless debugging"),
            when {
                core.adb.paired -> tr("Paired with {name} for screen, sound, mouse and keyboard", "name" to name)
                core.link.ble -> tr("Requires Wi-Fi (currently connected over Bluetooth)")
                core.adb.wifiDebugging && !core.adb.setupNeeded -> tr("Paired with {name} · Reconnecting…", "name" to name)
                core.adb.wifiDebugging -> tr("On · Not yet paired with {name}", "name" to name)
                else -> tr("Used for screen, sound, mouse and keyboard with {name}", "name" to name)
            },
        ) {
            if (core.adb.paired) Pill(tr("Paired"), "good")
            else if (core.link.ble) Pill(tr("Wi-Fi only"), "muted")
            else {
                if (!core.adb.wifiDebugging) Secondary(tr("Turn on")) { core.adb.turnOn() }
                Primary(tr("Guide")) { Guide.open.value = true }
            }
        }
        // Off until switched on (Adb.autoOffEnabled): only what TwinDesk switched on goes off again.
        SwitchRow(
            tr("Turn off wireless debugging when disconnected"),
            when {
                !core.adb.canEnable -> tr("2 minutes after {name} disconnects, when TwinDesk turned it on", "name" to name)
                core.adb.autoOffEnabled -> tr("Off 2 minutes after {name} disconnects, on again when it reconnects. Not applied when you turned it on yourself", "name" to name)
                else -> tr("Stays on after {name} disconnects", "name" to name)
            },
            core.adb.autoOffEnabled, enabled = core.adb.canEnable,
        ) { core.adb.setAutoOff(it) }
        Setup(tr("Nearby devices"), tr("Bluetooth and Wi-Fi Direct, when {name} isn’t on this network", "name" to name), nearbyAllowed, tr("Allow")) {
            askNearby.launch(nearbyPerms)
        }
        if (core.input.supported) Setup(tr("Mouse and keyboard"), tr("Accessibility service: control from {name} without wireless debugging", "name" to name), core.input.on, tr("Allow")) { core.input.openSettings() }
        else MacRow(tr("Mouse and keyboard"), tr("Uses wireless debugging. The Accessibility service requires the full version of TwinDesk"))
        Setup(tr("Display over other apps"), tr("Shows the pointer from {name}", "name" to name), core.pointer.allowed, tr("Allow")) {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        }
        if (Build.VERSION.SDK_INT >= 30) Setup(tr("All files access"), tr("Wallpaper on {name}, Files and shared folders", "name" to name), android.os.Environment.isExternalStorageManager(), tr("Allow")) {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        }
    }
    NotifButtonsCard(core) // TwinDesk's notification: which buttons (QuickActions.kt)
    BankCard(core) // banking apps: debugging off and TwinDesk closes (BankGuard.kt)
    AppearanceCard()
    LanguageCard(core)
    MacCard(tr("This device")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(tr("Device name"), color = pal.text, fontSize = 15.sp)
            Text(tr("How other devices see this one"), color = pal.muted, fontSize = 12.5.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(dev, { dev = it }, singleLine = true, modifier = Modifier.weight(1f),
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = pal.text), shape = RoundedCornerShape(8.dp))
                Secondary(tr("Save")) { core.store.setDeviceName(dev); core.changed() }
            }
        }
    }
    MacCard(tr("Network and Bluetooth")) {
        BleSwitch(core, tr("Requires the Nearby devices permission"), first = true)
        SwitchRow(tr("Turn off Bluetooth on Wi-Fi connections"), if (core.bleWifiOff) tr("While connected to {name} over the same Wi-Fi network", "name" to name)
            else tr("Bluetooth stays on as a fallback if Wi-Fi drops"), core.bleWifiOff) { core.store.setFlag("bleWifiOff", it); core.changed() }
        val n = core.net
        if (n.state != "idle") MacRow(tr("Wi-Fi Direct"), when (n.state) {
            "asking", "hosting" -> tr("Starting a direct Wi-Fi link…")
            "joining" -> tr("Joining {name}’s Wi-Fi Direct link…", "name" to name)
            "joined" -> tr("Connected to {name} over Wi-Fi Direct", "name" to name)
            "failed" -> n.error
            else -> ""
        })
    }
    if (core.hosts().isNotEmpty()) MacCard(tr("Paired computers")) {
        core.hosts().forEachIndexed { i, h ->
            MacRow(h.name, if (core.host?.id == h.id) (if (core.link.wired) tr("Connected over USB") else if (core.link.ble) tr("Connected over Bluetooth") else tr("Connected")) else tr("Last address: {address}", "address" to h.address), first = i == 0) {
                if (core.host?.id == h.id) Pill(tr("Online"), "good")
                TextButton(onClick = { core.forget(h.id) }) { Text(tr("Forget"), color = pal.muted) }
            }
        }
    }
}


// The phone's hero card: one surface with a faint tint of the accent (no inner shade, no
// gradient), so nothing in it asks for attention; its buttons are white pills on it.
@Composable
private fun HeroCard(content: @Composable ColumnScope.() -> Unit) {
    val p = pal
    val dark = p.text.luminance() > 0.5f
    val bg = androidx.compose.ui.graphics.lerp(p.card, p.accent, if (dark) 0.07f else 0.05f)
    val soft = p.copy(chip = if (dark) Color.White.copy(alpha = 0.08f) else Color.White)
    Column(Modifier.padding(bottom = 18.dp).fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(bg)) {
        androidx.compose.runtime.CompositionLocalProvider(LocalPalette provides soft) { content() }
    }
}

@Composable
private fun ColumnScope.HeroBody(core: Core, v: Int, me: String, host: Host?, link: Link, accent: Color) {
    @Suppress("UNUSED_EXPRESSION") v
    // Another phone holds the session: this phone, the link, that phone.
    val ph = core.peer.takeIf { host == null && it.connected }

        Row(
            Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 12.dp).fillMaxWidth()
                
                .padding(horizontal = 8.dp, vertical = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Device(me, phone = true, Modifier.weight(1f))
            Column(Modifier.weight(0.9f), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)).background(
                    if (host != null || ph != null) Brush.horizontalGradient(listOf(pal.good, pal.accent)) else Brush.horizontalGradient(listOf(pal.trackOff, pal.trackOff)),
                ))
                Text(
                    when { host != null -> listOfNotNull(tr(core.net.via), link.rttMs?.let { "$it ms" }).joinToString(" · ").ifEmpty { tr("Connected") }; ph != null -> tr("Connected"); link.state == "connecting" -> tr("Connecting…"); link.pair != null -> tr("Pairing…"); else -> tr("Not connected") },
                    color = pal.muted, fontSize = 11.sp, maxLines = 2, lineHeight = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp),
                )
            }
            if (ph != null) Device(ph.peerName, phone = true, Modifier.weight(1f))
            else Device(them(core), phone = false, Modifier.weight(1f))
        }
        if (!(Modern.on && (host != null || ph != null))) Text(
            when {
                host != null -> tr("Connected")
                ph != null -> tr("Connected") + (if (ph.role == "host") tr(" · It connected to this phone") else "")
                link.message.isNotEmpty() -> link.message
                core.hosts().isNotEmpty() -> tr("Tap Connect, or select this device on your computer.")
                else -> tr("Choose a computer below, or pair by address.")
            },
            color = pal.muted, fontSize = 12.5.sp, lineHeight = 17.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 14.dp),
        )
        // Wireless debugging not set up (or off): one line under Connected, with the way to fix it.
        // Reached anyway (adb's TCP mode, on a direct Wi-Fi link): nothing to fix.
        // Over Bluetooth: greyed out, it only works over Wi-Fi.
        val adbBle = core.link.ble
        if (host != null && !core.adb.paired && (adbBle || core.adb.setupNeeded || !core.adb.wifiDebugging)) Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 14.dp).clip(RoundedCornerShape(8.dp)).background(if (Modern.on) pal.chip else if (adbBle) pal.line.copy(alpha = 0.35f) else pal.warn.copy(alpha = 0.12f)).padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (adbBle) tr("Wireless debugging requires Wi-Fi. You’re connected to {name} over Bluetooth.", "name" to host.name)
                else if (!core.adb.needed) tr("Wireless debugging isn’t in use. {name} shows and controls this screen through TwinDesk; set it up for phone apps in windows and the camera.", "name" to host.name)
                else if (core.adb.setupNeeded) tr("Wireless debugging isn’t set up. {name} uses it to show and control this screen.", "name" to host.name)
                else tr("Wireless debugging is off. {name} uses it to show and control this screen.", "name" to host.name),
                color = if (adbBle) pal.muted else pal.text, fontSize = 12.5.sp, lineHeight = 17.sp, modifier = Modifier.weight(1f).padding(end = 8.dp),
            )
            if (!adbBle) { if (core.adb.setupNeeded) Secondary(tr("Set up")) { Guide.open.value = true } else Secondary(tr("Turn on")) { core.adb.turnOn() } }
        }
        if (ph != null) Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (ph.can("screen")) Button(onClick = { PeerScreen.view(ph, core.ctx) }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(50),
                colors = ButtonDefaults.buttonColors(containerColor = if (Modern.on) pal.accentSoft else pal.accent, contentColor = if (Modern.on) pal.accent else Color.White), elevation = if (Modern.on) null else ButtonDefaults.buttonElevation()) {
                Text(tr("Show {name}’s screen", "name" to ph.peerName), fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Button(onClick = { ph.disconnect() }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(50), elevation = null, colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = pal.text)) { Text(tr("Disconnect")) }
        }
        if (host != null) {
            val show = { core.ctx.startActivity(Intent(core.ctx, ViewerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            // On Bluetooth: a direct Wi-Fi link on request, or made for files and screens: Back to Bluetooth ends it (both sides).
            val onWifi = core.net.wanted("user") || core.net.linked
            val wifiLabel = if (onWifi) tr("Back to Bluetooth") else if (core.link.ble) tr("Connect with Wi-Fi Direct") else null
            val wifiClick = { if (onWifi) core.net.drop() else core.net.need("user"); core.changed() }
            if (LocalConfiguration.current.screenWidthDp >= 600) {
                Row(Modifier.fillMaxWidth().padding(bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                    Primary(tr("Show {name}’s screen", "name" to host.name), show)
                    if (wifiLabel != null) Secondary(wifiLabel) { wifiClick() }
                    Secondary(tr("Disconnect")) { core.disconnect() }
                }
            } else {
                // A phone: one button per line, inside the card's padding.
                Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = show, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(50),
                        colors = ButtonDefaults.buttonColors(containerColor = if (Modern.on) pal.accentSoft else pal.accent, contentColor = if (Modern.on) pal.accent else Color.White), elevation = if (Modern.on) null else ButtonDefaults.buttonElevation()) {
                        Text(tr("Show {name}’s screen", "name" to host.name), fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (wifiLabel != null) Button(onClick = { wifiClick() }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(50), elevation = null, colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = pal.text)) { Text(wifiLabel) }
                    Button(onClick = { core.disconnect() }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(50), elevation = null, colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = pal.text)) { Text(tr("Disconnect")) }
                }
            }
        }
    }

// ---- About ----

@Composable
private fun AboutPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    Column(Modifier.fillMaxWidth().padding(top = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Logo(110)
        Text("TwinDesk", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = pal.text, modifier = Modifier.padding(top = 10.dp))
        Text(tr("Version {version}", "version" to BuildConfig.VERSION_NAME), color = pal.muted)
        Text(tr("Use your computer and phone together as one workspace."), color = pal.muted, modifier = Modifier.padding(top = 6.dp, bottom = 20.dp))
    }
    val ctx = LocalContext.current
    val open = { url: String -> ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    val u = core.updates
    MacCard(tr("Updates")) {
        MacRow(
            "TwinDesk",
            when {
                u.checking -> tr("Checking…")
                u.error.isNotEmpty() -> tr("Couldn’t check: {error}", "error" to u.error)
                u.available -> tr("{latest} is available. You have {current}. ", "latest" to u.latest, "current" to u.current) + (u.download?.let { tr("Download {name}", "name" to it.name) } ?: tr("Opens the release page"))
                u.noReleases -> tr("Version {current}. No releases are available yet.", "current" to u.current)
                u.checkedAt > 0 -> tr("Up to date · checked {time}", "time" to java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(u.checkedAt)))
                else -> tr("Version {current}", "current" to u.current)
            },
            first = true,
        ) {
            if (u.available) Primary(tr("Download")) { u.open() }
            if (!u.checking) Secondary(tr("Check now")) { u.checkNow() }
        }
        SwitchRow(tr("Check automatically"), tr("Looks for new releases on GitHub every few hours"), u.auto) { u.auto = it }
    }
    MacCard(tr("Made by")) {
        MacRow("Inuka Asith", "inukaasith.vercel.app", first = true) { Secondary(tr("Portfolio")) { open("https://inukaasith.vercel.app") } }
        MacRow(tr("Source code"), "github.com/InukaAsith/TwinDesk") { Secondary("GitHub") { open("https://github.com/InukaAsith/TwinDesk") } }
        MacRow(tr("Releases"), tr("New versions for every platform")) { Secondary(tr("Open")) { open("https://github.com/InukaAsith/TwinDesk/releases") } }
    }
    MacCard(tr("License")) {
        MacRow(tr("GNU General Public License v3"), tr("Free and open source. Copyright © 2026 inukaasith"), first = true) {
            Secondary(tr("Read")) { open("https://github.com/InukaAsith/TwinDesk/blob/main/LICENSE") }
        }
        MacRow(tr("Screen, input and sound over wireless debugging"), "scrcpy-server (Apache-2.0)")
        MacRow(tr("Network"), "OkHttp (Apache-2.0)")
    }
    Text(tr("Crafted with ☕ and ❤️ in Sri Lanka 🇱🇰"), color = pal.muted, fontSize = 13.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 24.dp))
}
