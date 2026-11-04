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
    }

    override fun onResume() {
        super.onResume()
        shown = true
        resumed.value++ // permissions may have changed in Settings
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
        if (hasFocus) Core.get(this).let { if (it.sync.get("clipboard", "out")) it.clip.sendCurrent(false) }
    }

    companion object {
        @Volatile var shown = false // on screen: Android lets us open a prompt (Hub.ask)
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
    Camera("Camera", Ico.camera, grad(0xFFBF5AF2, 0xFF8944AB), "More"),
    General("General", Ico.general, grad(0xFFAEAEB2, 0xFF636366), "bottom"),
    About("About", Ico.about, grad(0xFF64D2FF, 0xFF0A84FF), "bottom"),
}

// The bottom bar: Overview first while connected, Connection second; before that Connection first.
private fun bottom(core: Core) = if (core.host != null) listOf(Tab.Overview, Tab.Connection, Tab.Screen, Tab.Files) else listOf(Tab.Connection, Tab.Screen, Tab.Cursor, Tab.Files)
// Overview only while connected (elsewhere, Connection shows).
private fun shown(core: Core, t: Tab) = t != Tab.Overview || core.host != null

// The sidebar's green dot: the page's feature is on.
private fun isOn(core: Core, t: Tab): Boolean = when (t) {
    Tab.Screen -> core.screen.viewing
    Tab.Cursor -> core.kvm.linked && core.sync.get("cursor", "in")
    Tab.Keyboard -> core.sync.value("keyboard") == "true"
    Tab.Remote -> core.remote.active
    Tab.Clipboard -> core.sync.get("clipboard", "in") || core.sync.get("clipboard", "out")
    Tab.Notifications -> core.sync.get("notifs", "in") || core.sync.get("notifs", "out")
    Tab.Sound -> core.sync.get("audio", "in") || core.sync.get("audio", "out")
    Tab.Camera -> core.adb.camera.on
    Tab.Rezume -> core.rezume.on
    Tab.Calls -> core.hub.callsOn
    Tab.Messages -> core.hub.messagesOn
    Tab.Photos -> core.hub.mediaOn
    Tab.FileAccess -> core.hub.filesOn
    else -> false
} && core.host != null

private fun them(core: Core) = core.host?.name ?: core.hosts().firstOrNull()?.name ?: "the computer"

// Pages that can't work over Bluetooth and don't move the session onto Wi-Fi by themselves
// (sound streams over the network; the computer's Photos): shown as they are while the session
// is on Bluetooth, saying so, with Connect with Wi-Fi Direct (WifiGate).
private fun wifiOnly(core: Core, t: Tab) = (t == Tab.Sound || t == Tab.Photos) && core.host != null && core.link.ble

@Composable
fun App(core: Core, resumed: Int) {
    val v by core.version.collectAsState()
    @Suppress("UNUSED_EXPRESSION") v; @Suppress("UNUSED_EXPRESSION") resumed // re-read Core on every bump
    var tab by rememberSaveable { mutableStateOf(Tab.Connection) }
    // Connected: its Overview (from Connection); not connected: Connection in its place.
    val connected = core.host != null
    var wasConnected by rememberSaveable { mutableStateOf(false) }
    if (connected && !wasConnected && tab == Tab.Connection) tab = Tab.Overview
    wasConnected = connected
    if (!connected && tab == Tab.Overview) tab = Tab.Connection
    val BOTTOM = bottom(core)
    var more by rememberSaveable { mutableStateOf(false) }
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    // Wireless debugging went off (MIUI / HyperOS): ask once per time it happens.
    var adbAsked by rememberSaveable { mutableStateOf(false) }
    if (!core.adb.off) adbAsked = false
    if (core.adb.off && !adbAsked && !core.link.ble) { // over Bluetooth it can't be used anyway
        val name = them(core)
        AlertDialog(
            onDismissRequest = { adbAsked = true },
            containerColor = pal.card,
            title = { Text("Turn on wireless debugging", color = pal.text) },
            text = {
                Text(
                    "$name uses it to show this screen, control this device with its mouse and keyboard, and play sound. " +
                        "Some phones (MIUI, HyperOS) turn it off after a network change, screen lock or restart.\n\n" +
                        "Developer options will open. Turn on USB debugging and Wireless debugging, then return to TwinDesk.",
                    color = pal.muted,
                )
            },
            confirmButton = { TextButton(onClick = { adbAsked = true; core.adb.openSettings() }) { Text("Open Settings", color = pal.accent) } },
            dismissButton = { TextButton(onClick = { adbAsked = true }) { Text("Not now", color = pal.muted) } },
        )
    }

    // Another device rang this phone (its Overview › Ring): Stop over whatever page is open, not
    // only on the notification and the Connection page.
    if (core.dev.ringing) {
        val who = core.host?.name ?: "Your computer"
        AlertDialog(
            onDismissRequest = {},
            containerColor = pal.card,
            title = { Text("Ringing", color = pal.text) },
            text = { Text("$who is ringing this phone.", color = pal.muted) },
            confirmButton = { TextButton(onClick = { core.dev.stopRing() }) { Text("Stop", color = pal.bad) } },
        )
    }

    // A computer wants to pair, or its code is up: over whatever page is open, not only the
    // notification and the Overview.
    core.invite?.let { inv ->
        AlertDialog(
            onDismissRequest = {},
            containerColor = pal.card,
            title = { Text("${inv.name} wants to pair", color = pal.text) },
            text = { Text("Tap Pair to pair this device with ${inv.name}. You’ll confirm that both devices show the same code.", color = pal.muted) },
            confirmButton = { TextButton(onClick = { core.pair(inv) }) { Text("Pair", color = pal.accent) } },
            dismissButton = { TextButton(onClick = { core.dismissInvite() }) { Text("Not now", color = pal.muted) } },
        )
    }
    core.link.pair?.takeIf { it.phase == "code" && !it.wired && !it.qr }?.let { p ->
        AlertDialog(
            onDismissRequest = {},
            containerColor = pal.card,
            title = { Text("Pair with ${p.name}?", color = pal.text) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Check that ${p.name} shows the same code.", color = pal.muted)
                    Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp, color = pal.text)
                }
            },
            confirmButton = { TextButton(onClick = { core.link.confirmCode() }) { Text("Codes match", color = pal.accent) } },
            dismissButton = { TextButton(onClick = { core.link.cancelPairing() }) { Text("Cancel", color = pal.muted) } },
        )
    }

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
                Page(core, v, tab, Modifier.weight(1f))
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
                    for (t in BOTTOM) item(if (t == Tab.Connection) "Connect" else t.title, t.icon, !more && tab == t, isOn(core, t)) { go(t, false) }
                    item("More", Ico.more, more || tab !in BOTTOM, false) { go(tab, true) }
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
                Dot(when { h != null -> pal.good; core.link.pair != null || core.link.state == "connecting" -> pal.warn; else -> pal.faint }, 7)
                Text(
                    when {
                        h != null -> h.name + " · " + core.net.via + (core.link.rttMs?.let { " · $it ms" } ?: "")
                        core.link.pair != null -> "Pairing…"
                        core.link.state == "connecting" -> "Connecting…"
                        else -> "Not connected"
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
        var group: String? = null
        for (t in Tab.entries.filter { shown(core, it) }) {
            if (t.group == "bottom" && group != "bottom") Box(Modifier.padding(horizontal = 8.dp, vertical = 8.dp).fillMaxWidth().height(1.dp).background(pal.line))
            else if (group != null && t.group != group) Spacer(Modifier.height(10.dp))
            group = t.group
            NavItem(t.icon, t.colors, t.title, tab == t, isOn(core, t)) { go(t) }
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
        PageHead("More", "")
        MacCard {
            Tab.entries.filter { it !in BOTTOM && shown(core, it) }.forEachIndexed { i, t ->
                Column {
                    if (i > 0) Box(Modifier.padding(start = 58.dp).fillMaxWidth().height(1.dp).background(pal.line))
                    Row(Modifier.fillMaxWidth().clickable { go(t) }.padding(horizontal = 16.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                        Tile(t.icon, t.colors, 30)
                        Text(t.title, color = pal.text, fontSize = 16.sp, modifier = Modifier.padding(start = 12.dp).weight(1f))
                        if (wifiOnly(core, t)) Text("Wi-Fi Direct", color = pal.muted, fontSize = 12.sp)
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
            when (tab) {
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
    Note("Not connected. Connect to ${them(core)} from the Connection page.", "warn")
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
    if (!connection && host != null) PageHead(host.name, listOfNotNull("Connected", core.net.via, link.rttMs?.let { "$it ms" }).joinToString(" · "))
    else if (LocalConfiguration.current.screenWidthDp >= 600) PageHead("Connection", listOf(me, ip).filter { it.isNotEmpty() }.joinToString(" · "))
    else PageHead("Connection", listOf(me, ip).filter { it.isNotEmpty() }.joinToString(" · "))

    // The computer rang this phone: Stop here too (and on its notification).
    if (core.dev.ringing) Row(
        Modifier.fillMaxWidth().padding(bottom = 16.dp).clip(RoundedCornerShape(12.dp)).background(pal.bad.copy(alpha = 0.12f)).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("${host?.name ?: "Your computer"} is ringing this phone", color = pal.text, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Button(onClick = { core.dev.stopRing() }, colors = ButtonDefaults.buttonColors(containerColor = pal.bad, contentColor = Color.White), shape = RoundedCornerShape(8.dp)) { Text("Stop") }
    }
    if (connection) core.invite?.let { inv ->
        Note("${inv.name} wants to pair with this device.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 16.dp)) {
            Primary("Pair") { core.pair(inv) }
            Secondary("Not now") { core.dismissInvite() }
        }
    }
    if (connection) link.pair?.let { p ->
        MacCard("Pairing with ${p.name}") {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (p.phase) {
                    "code", "waiting" -> if (p.wired || p.qr) {
                        Text(if (p.qr) "Click Allow on ${p.name}." else "On the USB cable. Click Allow on ${p.name}.", color = pal.text)
                        Secondary("Cancel") { link.cancelPairing() }
                    } else {
                        Text("Check that ${p.name} shows the same code.", color = pal.text)
                        Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp, color = pal.text)
                        if (p.phase == "code") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Primary("Codes match") { link.confirmCode() }
                            Secondary("Cancel") { link.cancelPairing() }
                        } else Text("Waiting for Allow on ${p.name}…", color = pal.muted)
                    }
                    "failed" -> {
                        Text(p.error, color = pal.bad)
                        Secondary("OK") { link.cancelPairing() }
                    }
                    else -> {
                        Text(if (p.ble) "Connecting over Bluetooth…" else "Connecting…", color = pal.muted)
                        Secondary("Cancel") { link.cancelPairing() }
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

    // The other paired computers, while connected: Switch (Take over when nearby) lets this one go and connects that one.
    if (connection && host != null) {
        val others = core.hosts().filter { it.id != host.id }
        if (others.isNotEmpty()) MacCard("Switch to") {
            others.forEachIndexed { i, h ->
                val near = core.isNear(h.id)
                MacRow(h.name, if (near && !core.discovery.found.containsKey(h.id)) "Paired · Nearby over Bluetooth" else if (near) "Paired · Nearby" else "Paired · Not nearby", i == 0) {
                    Secondary(if (near) "Take over" else "Switch") { core.switchTo(h) }
                }
            }
        }
        MacCard { BleSwitch(core, "Allow Nearby devices permission in General", first = true) }
    }

    // What each feature does in each direction is on its own page (the switches are shared with the
    // computer): Overview keeps to the link, the computer's controls and the way to its screen.

    // Refresh: asks every computer on the network to answer now (they also announce themselves every few seconds).
    var looking by remember { mutableStateOf(false) }
    LaunchedEffect(looking) { if (looking) { kotlinx.coroutines.delay(1500); looking = false } }
    if (host == null) MacCard("Nearby", action = {
        TextButton(onClick = { looking = true; Thread { runCatching { core.discovery.probe() } }.start() }, enabled = !looking) {
            Text(if (looking) "Looking…" else "Refresh", color = pal.accent, fontSize = 14.sp)
        }
    }) {
        val hosts = core.hosts()
        // The computer's QR code (Connection there): an extra way, next to these.
        val act = LocalContext.current
        MacRow("Scan a QR code", "On your computer, open Connection › Pair a phone with a QR code", true) { Secondary("Scan") { scanQr(act) } }
        var first = false
        for (h in hosts) {
            val near = core.isNear(h.id)
            MacRow(h.name, if (link.state == "connecting" && link.host?.id == h.id) "Connecting…" else if (near && !core.discovery.found.containsKey(h.id)) "Paired · Nearby over Bluetooth" else if (near) "Paired · Nearby" else "Paired · Not nearby", first) {
                Secondary("Forget", pal.muted) { core.forget(h.id) }
                // Nearby: Take over (a phone's hello takes the computer from whoever has it).
                Primary(if (near) "Take over" else "Connect") { core.connect(h) }
            }
            first = false
        }
        for (f in core.nearby().filter { f -> hosts.none { it.id == f.id } }) {
            MacRow(f.name, "${if (f.os == "mac") "Mac" else if (f.os == "linux") "Linux" else "PC"} · ${if (f.address.startsWith("ble:") || f.address.startsWith("blp:")) "Bluetooth" else f.address}", first) { Secondary("Pair") { core.pair(f) } }
            first = false
        }
        if (first) MacRow("Looking for computers…", if (core.bleOn && core.ble.allowed()) "Open TwinDesk on your computer. Use the same Wi-Fi network, or turn on Bluetooth." else "Open TwinDesk on your computer, on the same Wi-Fi network", true)
        BleSwitch(core, "Allow Nearby devices permission in General")
        var addr by remember { mutableStateOf("") }
        Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(1.dp).background(pal.line))
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Pair by address", color = pal.text, fontSize = 15.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(addr, { addr = it }, placeholder = { Text("192.168.1.20", color = pal.faint) }, singleLine = true, modifier = Modifier.weight(1f),
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = pal.text), shape = RoundedCornerShape(8.dp),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                Secondary("Pair") { if (addr.isNotBlank()) core.pairAddress(addr) }
            }
        }
    }
}

// The connected computer's controls, when it has them (an older TwinDesk says nothing: no card).
@Composable
private fun ComputerCard(core: Core, name: String) {
    @Suppress("UNUSED_VARIABLE") val v by core.version.collectAsState() // redraw on Core changes (Compose skips it otherwise: same core)
    val c = core.dev.computer ?: return
    // Which TwinDesk the computer runs (its dev.state's app; none: older than 2.5): red when older than this one.
    val theirs = c.optJSONObject("app")?.optString("v").orEmpty()
    val older = theirs.isEmpty() || Updates.compare(theirs, BuildConfig.VERSION_NAME) < 0
    if (older) Note(if (theirs.isEmpty()) "$name has an older version of TwinDesk. Update it to use all features."
        else "$name has TwinDesk $theirs and this phone has ${BuildConfig.VERSION_NAME}. Update TwinDesk on $name to use all features.", "warn")
    val can = c.optJSONObject("can") ?: return
    if (can.length() == 0) return
    MacCard(name) {
        MacRow("TwinDesk", "On $name", true) { Text(theirs.ifEmpty { "Older" }, color = if (older) pal.bad else pal.muted, fontSize = 14.sp) }
        val ringing = c.optBoolean("ringing")
        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (can.optBoolean("ring")) ChipButton({ core.dev.ask(if (ringing) "ringStop" else "ring") }, Modifier.weight(1f)) {
                Text(if (ringing) "Stop" else "Ring", color = if (ringing) pal.bad else pal.text, maxLines = 1)
            }
            if (can.optBoolean("lock")) ChipButton({ core.dev.ask("lock") }, Modifier.weight(1f)) { Text("Lock", color = pal.text, maxLines = 1) }
            if (can.optBoolean("sleep")) ChipButton({ core.dev.ask("sleep") }, Modifier.weight(1f)) { Text("Sleep", color = pal.text, maxLines = 1) }
        }
        var first = true
        if (can.optBoolean("bluetooth") && c.has("bluetooth")) { SwitchRow("Bluetooth", "On $name", c.optBoolean("bluetooth"), first = first) { core.dev.ask("bluetooth", "on" to it) }; first = false }
        if (can.optBoolean("dnd") && c.has("dnd")) { SwitchRow("Do not disturb", "On $name", c.optBoolean("dnd"), first = first) { core.dev.ask("dnd", "on" to it) }; first = false }
        if (can.optBoolean("volume") && c.has("volume")) {
            if (!first) Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(1.dp).background(pal.line))
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                Text("Volume", color = pal.text, fontSize = 15.sp)
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
            .addOnSuccessListener { b -> if (!QrActivity.open(ctx, b.rawValue.orEmpty())) android.widget.Toast.makeText(ctx, "That isn’t a TwinDesk pairing code", android.widget.Toast.LENGTH_SHORT).show() }
            .addOnFailureListener { openCamera(ctx) }
    }.isSuccess
    if (!ok) openCamera(ctx)
}

private fun openCamera(ctx: android.content.Context) {
    android.widget.Toast.makeText(ctx, "Scan it with the Camera app to open TwinDesk", android.widget.Toast.LENGTH_LONG).show()
    runCatching { ctx.startActivity(Intent(android.provider.MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

// Bluetooth with computers (Overview and General, as on the computers): for one that isn't on this
// network. Off by itself while the session is on the same Wi-Fi, on again when that drops (Core.bleTick).
@Composable
private fun BleSwitch(core: Core, askHint: String, first: Boolean = false) {
    @Suppress("UNUSED_VARIABLE") val v by core.version.collectAsState() // redraw on Core changes (Compose skips it otherwise: same core)
    val ctx = LocalContext.current
    val name = them(core)
    val link = core.link
    val allowed = (Ble.permissions() + BleServe.permissions() + Direct.permission()).all { ctx.checkSelfPermission(it) == android.content.pm.PackageManager.PERMISSION_GRANTED }
    SwitchRow("Bluetooth with computers", when {
        !core.bleOn -> "Only computers on this network or connected by USB can connect"
        !core.ble.radioOn -> "Bluetooth is off on this device"
        !allowed -> askHint
        core.bleWifiOff && link.connected && core.net.via == "Wi-Fi" -> "Paused while you’re on the same Wi-Fi as $name. Resumes if Wi-Fi drops."
        else -> "Connects to $name over Bluetooth when it isn’t on this network. Files and screen sharing use a temporary Wi-Fi Direct link."
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
    @Suppress("UNUSED_VARIABLE") val v by core.version.collectAsState() // redraw on Core changes (Compose skips it otherwise: same core)
    if (core.host == null || !core.link.ble) return
    val n = core.net
    val moving = n.state in listOf("asking", "hosting", "joining")
    Note(
        when {
            moving -> "$what is only available over Wi-Fi Direct. Connecting…"
            n.state == "failed" -> "$what is only available over Wi-Fi Direct. ${n.error.ifEmpty { "Wi-Fi Direct didn’t come up" }}"
            else -> "$what requires Wi-Fi Direct or the same Wi-Fi network. You’re connected over Bluetooth."
        },
        "warn",
    )
    if (!moving) Row(Modifier.padding(bottom = 14.dp)) {
        Primary(if (n.state == "failed") "Try again" else "Connect with Wi-Fi Direct") { core.net.need("user"); core.changed() }
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
    if (!hub.peer) { Note("Update TwinDesk on $name to use $title.", "warn"); return false }
    when {
        perm == "none" && what == "files" -> Note("File access requires Android 11 or later. You can still mount this phone on $name using ADB.", "warn")
        perm == "none" -> Note("$title requires the full version of TwinDesk, as Android restricts downloaded apps from reading messages. Once wireless debugging is set up, install it from the Phone page on $name. Your settings and pairings are kept.", "warn")
        !on -> Note("Off. Turn it on here or on $name.")
        perm == "ask" -> {
            Note(
                when (what) {
                    "files" -> "Allow All files access so $name can browse this phone’s storage. ADB isn’t required."
                    "media" -> "Allow access to photos and videos so $name can show them."
                    else -> "$title needs ${Hub.wanted(what).size} permissions. You’ll be asked once."
                },
                "warn",
            )
            Row(Modifier.padding(bottom = 14.dp)) { Primary("Allow") { hub.askHere(what) } }
        }
        perm == "partial" -> {
            Note(if (what == "media") "Only the photos you selected are shown on $name." else "Some $title features need more permissions.")
            Row(Modifier.padding(bottom = 14.dp)) { Secondary("Allow more") { hub.askHere(what) } }
        }
        else -> Note("On. $title from this phone is available on $name.")
    }
    return on && perm != "none"
}

@Composable
private fun CallsPage(core: Core, v: Int) {
    val name = them(core)
    if (!HubHead(core, v, "calls", "Calls", "Answer, make and end calls on ${them(core)}.")) return
    MacCard("On $name") {
        MacRow("Answer and decline", "Shows incoming calls on $name", first = true)
        MacRow("Make calls", "Use the keypad, contacts and recent calls on $name")
    }
    // The computer as this phone's headset: paired over classic Bluetooth by the person, in Bluetooth
    // settings (TwinDesk doesn't pair them itself). Forget at the bottom.
    val hub = core.hub
    if (hub.btAudio) MacCard("Sound on $name") {
        val bt = hub.btState()
        val allowed = bt.optBoolean("allowed", true)
        val bonded = bt.optBoolean("bonded")
        MacRow(
            "Bluetooth",
            when {
                !allowed -> "Allow Nearby devices permission to check the Bluetooth pairing with $name"
                !bt.optBoolean("radio", true) -> "Bluetooth is off on this phone"
                bt.optBoolean("bonding") -> "Pairing… Confirm the code on both devices"
                bt.optBoolean("forget") -> "Forget $name in this phone’s Bluetooth settings, then pair them again"
                bonded -> "Paired with $name. Call audio can play there."
                bt.optBoolean("le") -> "Paired over Bluetooth LE only, which doesn’t support calls. Forget the device, then pair it again in Bluetooth settings."
                !hub.btKnown -> "Waiting for $name…"
                else -> "Not paired with $name over Bluetooth. Pair them in Bluetooth settings, and TwinDesk connects automatically."
            },
            first = true,
        ) {
            if (!allowed) Primary("Allow") { hub.askHere("bt") }
            else if (hub.btKnown && !bonded && !bt.optBoolean("bonding")) Secondary("Open Bluetooth settings") { hub.btSettings() }
        }
        var sure by remember { mutableStateOf(false) }
        MacRow("Forget", "Removes the Bluetooth pairing between this phone and $name, then opens Bluetooth settings") {
            TextButton(onClick = { if (sure) { sure = false; hub.forgetBt() } else { sure = true } }) { Text(if (sure) "Forget?" else "Forget", color = pal.bad) }
        }
    }
}

@Composable
private fun MessagesPage(core: Core, v: Int) {
    val name = them(core)
    if (!HubHead(core, v, "messages", "Messages", "Read and send text messages on ${them(core)}.")) return
    MacCard("On $name") {
        MacRow("Conversations", "Texts and MMS pictures in Messages on $name", first = true)
        MacRow("New texts", "Shown as a badge in Messages on $name")
    }
}

@Composable
private fun PhotosPage(core: Core, v: Int) {
    val name = them(core)
    WifiGate(core, "Photos on $name")
    if (!HubHead(core, v, "media", "Photos", "View and copy this phone’s photos and videos on ${them(core)}.")) return
    MacCard("On $name") {
        MacRow("Photos, videos and screenshots", "Newest first, in Photos on $name", first = true)
        MacRow("Save", "Saved to the Downloads folder on $name")
    }
}

@Composable
private fun FileAccessPage(core: Core, v: Int) {
    val name = them(core)
    WifiGate(core, "Phone Files on $name")
    if (HubHead(core, v, "files", "File access", "Browse this phone’s storage on ${them(core)} and copy files in either direction.")) MacCard("On $name") {
        MacRow("Phone Files", "Browse, upload, download, rename and delete files", first = true)
        MacRow("Without ADB", "Uses All files access instead of ADB. To use ADB, mount the phone on $name.")
        MacRow("Connection", "Works over USB, Wi-Fi and Wi-Fi Direct")
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
    MacCard("Shared folders") {
        SwitchRow(
            "Share a folder with $name",
            when {
                !sh.allowed -> "Requires All files access"
                ble && sh.on -> "${sh.shown()}. $name opens it over Wi-Fi Direct."
                sh.error.isNotEmpty() -> "Couldn’t share: ${sh.error}"
                sh.on && sh.serving -> "${sh.shown()}. Open it on $name in Phone Files › Shared folders."
                else -> sh.shown()
            },
            sh.on, first = true,
        ) {
            sh.setOn(it)
            if (it && !sh.allowed) core.hub.askHere("files")
        }
        MacRow("Folder", sh.shown()) { Secondary("Choose…") { pick.launch(null) } }
        val pc = sh.pc
        MacRow(
            "$name’s shared folder",
            when {
                ble && sh.opening -> "Connecting with Wi-Fi Direct…"
                ble && sh.pcServe -> "Opening connects over Wi-Fi Direct"
                pc != null -> "Available as “${pc.name}” in the Files app and file pickers"
                sh.pcServe -> "Opening…"
                else -> "Turn on to browse a folder on $name from the Files app"
            },
        ) {
            if (pc != null) Primary("Open") { openPcShare(ctx) }
            else if (ble && sh.pcServe && !sh.opening) Primary("Open") { sh.openOverWifi() }
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
        "Camera",
        "Use this device’s camera on $name, in TwinDesk or in any app.",
        master = if (host != null && (canShow || cam.on)) cam.on else null,
        onMaster = { adb.cameraOnComputer(it, facing) },
    )
    if (host == null) return NotConnected(core, v)
    MacCard("This camera on $name") {
        MacRow(
            "Camera",
            if (cam.on) "Switching may take a moment" else "Camera used when starting",
            first = true,
        ) {
            SingleChoiceSegmentedButtonRow {
                val sides = listOf("back" to "Back", "front" to "Front")
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
            "On $name",
            when {
                !canShow -> "Requires wireless debugging. Set it up from Overview."
                cam.error.isNotEmpty() -> "It stopped: ${cam.error}"
                cam.on && cam.virtual -> "Available as “TwinDesk Camera”. Choose it in Zoom, Teams or your browser."
                cam.on -> "Shown on the Camera page in TwinDesk. Turn on Virtual camera there to use it in other apps."
                else -> "Off"
            },
        )
    }
    Note(
        if (cam.virtual) "Virtual camera is on. Apps on $name can use this camera as “TwinDesk Camera”."
        else "To use this camera in apps like Zoom, Teams or a browser, turn on Virtual camera on the Camera page in TwinDesk on $name.",
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
    PageHead("Screen", "Use this device as a display for $name, either mirroring its screen or extending it.")
    if (host == null) return NotConnected(core, v)
    // The other way round: this device's screen in a window on the computer, over wireless debugging.
    // Paired now or before: the computer brings it back by itself (on Bluetooth, onto Wi-Fi first).
    val adb = core.adb
    val canShow = adb.paired || adb.known
    MacCard("This screen on $name") {
        MacRow(
            "Show this screen on $name",
            when {
                !canShow -> "Requires wireless debugging. Set it up from Overview."
                adb.viewed -> "This device’s windows are open on $name"
                else -> "Opens in a window you can control with the mouse and keyboard"
            },
            first = true,
        ) {
            if (adb.viewed) Secondary("Close") { adb.showOnComputer(false) }
            Button(onClick = { adb.showOnComputer(true) }, enabled = canShow, colors = ButtonDefaults.buttonColors(containerColor = pal.accent, contentColor = Color.White), shape = RoundedCornerShape(8.dp)) { Text("Show") }
        }
    }
    Note(
        when {
            !s.sharing -> "$name isn’t sharing its screen."
            s.mode == "extend" -> "$name is extending its desktop to this screen."
            else -> "$name is mirroring its screen."
        },
    )
    MacCard {
        MacRow("Show $name’s screen", "Opens full screen. Tap the handle at the top for display options and the keyboard.", first = true) {
            Primary("Open") { ctx.startActivity(Intent(ctx, ViewerActivity::class.java)) }
        }
        if (s.remote) MacRow("Mode", "Extend uses this device as a second display for $name") {
            // A phone: Mirror and Extend across the row's width, under the label.
            SingleChoiceSegmentedButtonRow(if (LocalConfiguration.current.screenWidthDp < 600) Modifier.fillMaxWidth() else Modifier) {
                val modes = listOf("mirror" to "Mirror", "extend" to "Extend")
                modes.forEachIndexed { i, (m, label) ->
                    SegmentedButton(selected = s.sharing && s.mode == m, onClick = { s.control(share = true, mode = m) }, shape = SegmentedButtonDefaults.itemShape(i, modes.size)) { Text(label) }
                }
            }
        } else MacRow("Mode", "Managed from $name")
        if (s.sharing && s.remote) MacRow("Sharing", "") { Secondary("Stop") { s.control(share = false) } }
    }
    MacCard("Touch") {
        val pad = core.store.flag("screen.touchpad", true)
        SwitchRow("Touchpad", "Slide to move the pointer, like a laptop touchpad. When off, the pointer follows your finger.", pad, first = true) { s.setOpt("screen.touchpad", it) }
        if (pad) {
            MacRow("Slide", "Moves the pointer")
            MacRow("Tap", if (core.remote.tapClick) "Clicks" else "No action (Tap to click is off in Remote)")
            MacRow("Touch and hold", "Right-click")
            MacRow("Two fingers", "Scrolls")
        } else {
            MacRow("Tap", "Clicks")
            MacRow("Touch and hold", "Right-click")
            MacRow("Drag", "Select or move windows")
            MacRow("Two fingers", "Scrolls")
        }
        if (!s.inputOn) MacRow("Input is off", "$name doesn’t accept input from this device. Turn on Receive input in Share screen on $name.")
    }
    MacCard("Stylus") {
        SwitchRow("Pen", "Use the stylus as a drawing tablet on $name, with pressure, tilt, eraser and side button. Touch is ignored while the pen is near. When off, the stylus acts as a mouse.", core.store.flag("screen.pen", true), first = true) { s.setOpt("screen.pen", it) }
    }
    MacCard("Playback") {
        SwitchRow("$name’s sound with the screen", "When $name shares audio with its screen", core.store.flag("screen.sound", false), first = true) { s.setOpt("screen.sound", it) }
        SwitchRow("Smooth motion", "Smoother playback with about one frame of added delay", core.store.flag("screen.smooth", false)) { s.setOpt("screen.smooth", it) }
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
    PageHead("Cursor", "Move the pointer past the edge of the screen on $name to control this device.", if (host != null) shared else null) {
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
            viaPhone && !core.input.supported -> "This version of TwinDesk can’t use Accessibility, as Play Protect restricts downloaded apps. " +
                "Use wireless debugging instead, or install the full version of TwinDesk from the Phone page on $name."
            viaPhone && !core.input.on -> "Allow TwinDesk in Accessibility settings so $name can tap and type on this device."
            adbMissing -> "$name controls this device through wireless debugging, which is off. You can also choose Limited below."
            !core.pointer.allowed -> "Allow “Show the pointer” in General to see the pointer from $name."
            !core.kvm.linked -> "Cursor sharing is off. Double-tap ${core.kvm.hotkey} on $name to turn it on."
            paused -> "Cursor sharing is paused over Bluetooth. It resumes on Wi-Fi, or double-tap ${core.kvm.hotkey} on $name to turn it on."
            else -> "Move the pointer on $name past the edge of its screen to control this device. Double-tap ${core.kvm.hotkey} to return."
        },
        if (adbMissing || viaPhone && !core.input.on || !core.pointer.allowed) "warn" else "info",
    )
    if (viaPhone && !core.input.supported) Row(Modifier.padding(bottom = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!adbOn) Primary("Turn on wireless debugging") { core.adb.turnOn() }
        if (core.adb.setupNeeded) Secondary("Set up") { Guide.open.value = true }
    }
    else if (viaPhone && !core.input.on) Row(Modifier.padding(bottom = 14.dp)) { Primary("Allow") { core.input.openSettings() } }
    else if (adbMissing || !viaPhone && core.adb.setupNeeded) Row(Modifier.padding(bottom = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (adbMissing) Primary("Turn on wireless debugging") { core.adb.turnOn() }
        if (core.adb.setupNeeded) Secondary("Set up") { Guide.open.value = true }
    }
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow("Use $name’s mouse and keyboard on $me", "Move the pointer past the edge of the screen", core.sync.get("cursor", "in"), first = true) { core.sync.set("cursor", "in", it) }
        MacRow("Control method", when {
            core.input.via == "auto" && core.input.effective == "adb" -> "Auto: Full (ADB), wireless debugging is on"
            core.input.via == "auto" -> "Auto: Limited until wireless debugging is on"
            core.input.via == "phone" -> "Limited: taps and types through Accessibility, over Wi-Fi, Wi-Fi Direct and Bluetooth, without developer options"
            else -> "Full (ADB): full control through wireless debugging. Limited is used over Bluetooth."
        }) {
            SingleChoiceSegmentedButtonRow {
                val ways = listOf("auto" to "Auto", "adb" to "Full (ADB)", "phone" to "Limited")
                ways.forEachIndexed { i, (w, label) ->
                    SegmentedButton(selected = core.input.via == w, onClick = { core.input.setVia(w); core.changed() }, shape = SegmentedButtonDefaults.itemShape(i, ways.size)) { Text(label, maxLines = 1) }
                }
            }
        }
    }
    MacCard("Where $name is") { LayoutPicker(me, name, core.kvm.macSide) { core.kvm.setMacSide(it) } }
    MacCard("Pointer") {
        val speed = core.sync.value("speed").toFloatOrNull() ?: 1f
        MacRow("Pointer speed", "", first = true) {
            MacSlider(speed, 0.25f..4f, 14, { "%.2f×".format(it) }) { v ->
                val steps = listOf(0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f, 2.5f, 3f, 3.5f, 4f)
                val snapped = steps.minBy { kotlin.math.abs(it - v) }
                core.sync.setValue("speed", if (snapped % 1f == 0f) snapped.toInt() else snapped)
            }
        }
        SwitchRow("Reverse scrolling", "Invert the scroll direction on this device", core.sync.value("reverseScroll") == "true") { core.sync.setValue("reverseScroll", it) }
        MacRow("Right-click", "Back")
        MacRow("Middle click", "Home")
    }
    MacCard("Not on the same network") {
        SwitchRow("Over Bluetooth", "Keeps working over Bluetooth when $name isn’t on this network, at a slower rate. When off, it pauses until you’re back on Wi-Fi.",
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
    PageHead("Keyboard", "Type on whichever device the pointer is on.", if (host != null) on else null) { core.sync.setValue("keyboard", it) }
    if (host == null) return NotConnected(core, v)
    Note(if (on) "The keyboard on $name types on this device while its pointer is here." else "Keyboard sharing is off. Only the pointer is shared.")
    MacCard("Hotkey") {
        MacRow(core.kvm.hotkey, "Double-tap on $name to turn cursor sharing on or off. You can change it in TwinDesk on $name.", first = true)
    }
    MacCard {
        DirHead(name, false, me, true)
        MacRow("Shortcuts", "⌘ works as Ctrl, so ⌘C copies and ⌘V pastes", first = true)
        MacRow("Typing", "Keys are sent directly, so any keyboard layout works and the on-screen keyboard stays hidden")
    }
    MacCard("In the screen view") {
        MacRow("$name’s screen here", "A keyboard connected to this device types on $name. Tap Keyboard to open the on-screen keyboard.", first = true)
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
    PageHead("ReZume", "Continue the web page, document or app you were using, on this phone or on $name.", r.on) { r.set("on", it) }
    if (!r.on) return Note("Off. When on, the page or app you’re using is offered to $name, and what you’re using on $name is offered here.")
    if (core.host == null) return NotConnected(core, v)
    val o = r.incoming
    if (o != null) MacCard("Continue from $name") {
        MacRow(o.title, if (o.kind == "web") (android.net.Uri.parse(o.url).host ?: o.url) else o.name, first = true) {
            Primary("Open") { r.take(o, ctx) }
            Spacer(Modifier.width(8.dp))
            Secondary("Dismiss") { r.dismiss() }
        }
    }
    val p = r.peer
    Note(when {
        p == null -> "ReZume isn’t available on $name. Update TwinDesk there."
        !p.optBoolean("on") -> "ReZume is off on $name. Turn it on there as well."
        InputService.running == null && core.adb.wifiDebugging -> "Ready. $name can continue this phone’s apps through wireless debugging. To include web pages, turn on Accessibility for TwinDesk."
        InputService.running == null -> "You can continue pages and documents from $name. To send this phone’s pages, turn on Accessibility for TwinDesk, or wireless debugging for apps."
        r.offered.isNotEmpty() -> "Offered to $name: ${r.offered}"
        else -> "Ready."
    }, if (p == null || !p.optBoolean("on")) "warn" else "info")
    if (r.message.isNotEmpty()) Note(r.message)
    if (InputService.running == null) MacCard {
        MacRow("Accessibility", "Used only to detect the active app and the browser’s current address", first = true) {
            Secondary("Open settings") { ctx.startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
    }
    MacCard("Content") {
        SwitchRow("Web pages", "The active tab in Chrome, Firefox, Edge, Samsung Internet, Brave, Opera, Vivaldi or DuckDuckGo", r.opt("web"), first = true) { r.set("web", it) }
        SwitchRow("Documents", "Open the active document from $name on this phone", r.opt("docs")) { r.set("docs", it) }
        SwitchRow("Apps", "Open the active app on $name in its own window. Requires wireless debugging.", r.opt("apps")) { r.set("apps", it) }
    }
    MacCard("Sharing") {
        SwitchRow("Send from this device", "$name can continue what you’re using", r.opt("send"), first = true) { r.set("send", it) }
        SwitchRow("Take $name’s", "Receive from $name", r.opt("receive")) { r.set("receive", it) }
        SwitchRow("Open received items automatically", "Items sent from $name open without asking. Requires Display over other apps, otherwise a notification is shown.", r.opt("push")) { r.set("push", it) }
    }
    MacCard("Items from $name") {
        SwitchRow("Show a notification", "A silent notification that’s replaced by the next one", r.opt("notify"), first = true) { r.set("notify", it) }
    }
    Note("Share a link to “Open on computer” to open it on $name.")
}

@Composable
private fun RemotePage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val r = core.remote
    val ctx = LocalContext.current
    val name = them(core)
    val me = core.store.deviceName
    PageHead("Remote", "Use this device as $name’s touchpad and keyboard, or as a gamepad.")
    if (core.host == null) {
        NotConnected(core, v)
        return BtPadCard(core) // works without TwinDesk on the computer
    }
    if (r.unsupported) Note("$name doesn’t support Remote. Update TwinDesk there.", "warn")
    else if (r.allowed == false) Note(r.why.ifEmpty { "$name doesn’t accept input from this device. Turn on Remote in TwinDesk on $name." }, "warn")
    val open = { mode: String -> ctx.startActivity(Intent(ctx, RemoteActivity::class.java).putExtra("mode", mode)) }
    MacCard {
        MacRow("Touchpad and keyboard", "Slide to move the pointer, tap to click, touch and hold to right-click, and scroll with two fingers. Includes a keyboard and media keys.", first = true) {
            Primary("Open") { open("pad") }
        }
        MacRow("Gamepad", "Hold the phone sideways like a controller. The left stick acts as WASD and the right stick as the mouse. Customise buttons with Keys.") {
            Primary("Open") { open("gamepad") }
        }
    }
    MacCard("Touchpad") {
        MacRow("Pointer speed", "Also applies to the gamepad’s right stick and the screen touchpad", first = true) {
            MacSlider(r.speed, 0.3f..3f, 0, { "%.1f×".format(java.util.Locale.ROOT, it) }) { r.setSpeed(it) }
        }
        SwitchRow("Tap to click", "Tap to click. When off, use the click buttons.", r.tapClick) { r.setTapClick(it) }
        SwitchRow("Smooth motion", "Smoother pointer movement on $name, with about one frame of added delay", r.smooth) { r.setSmooth(it) }
    }
    BtPadCard(core)
    Note(
        when {
            core.link.wired -> "Connected by USB, the fastest connection for games."
            core.link.ble -> "Over Bluetooth, the pointer updates about 30 times a second. Wi-Fi or USB is faster."
            else -> "Over Wi-Fi, the response time is shown at the top of the app. For games, USB is fastest."
        },
    )
}

// As a Bluetooth gamepad (BtPad.kt): any computer, the Mac too, no driver and no TwinDesk there.
@Composable
private fun BtPadCard(core: Core) {
    @Suppress("UNUSED_VARIABLE") val v by core.version.collectAsState() // redraw on Core changes (Compose skips it otherwise: same core)
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
    MacCard("As a Bluetooth gamepad") {
        SwitchRow("As a Bluetooth gamepad", "Use this phone as a Bluetooth game controller for any computer, without drivers or TwinDesk. " +
            "Works with games that support any controller, such as Steam and emulators. For Xbox-only games on Windows, use Real gamepad on the PC.", on, first = true) { v ->
            if (!v) core.btPad.setOn(false)
            else if (!core.btPad.allowed()) ask.launch(BtPad.permissions())
            else { core.btPad.setOn(true); findable.launch(core.btPad.discoverableIntent()) }
        }
        if (on) {
            MacRow("Status", when (state) {
                "starting" -> "Starting…"
                "unavailable" -> pad?.message ?: ""
                "connected" -> "Connected to ${pad?.hostName}. Open the gamepad to play."
                "ready" -> "Ready. Waiting for a computer to connect."
                else -> pad?.message?.ifEmpty { "Off" } ?: "Off"
            }) { if (state == "connected") Primary("Open") { ctx.startActivity(Intent(ctx, RemoteActivity::class.java).putExtra("mode", "gamepad")) } }
            if (state == "ready") {
                MacRow("Pair it once", "On the computer, open Bluetooth settings and add a device, " +
                    "then choose “${core.store.deviceName}”. It reconnects automatically while this is on.") {
                    Secondary("Make discoverable") { findable.launch(core.btPad.discoverableIntent()) }
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
    PageHead("Clipboard", "Copy on one device and paste on the other.")
    if (core.host == null) NotConnected(core, v)
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow("Receive from $name", "At once", core.sync.get("clipboard", "in"), first = true) { core.sync.set("clipboard", "in", it) }
    }
    MacCard {
        DirHead(me, true, name, false)
        SwitchRow("Send to $name", "While TwinDesk is open, or at any time with wireless debugging", core.sync.get("clipboard", "out"), first = true) { core.sync.set("clipboard", "out", it) }
        if (core.host != null) MacRow("Send the clipboard now", "Also available as a Quick Settings tile") { Secondary("Send") { core.clip.sendCurrent(true) } }
    }
    // Pictures both ways, this device's screenshots among them (Clip.kt, Screenshots.kt). Finding
    // new screenshots needs photo access.
    val clip = core.clip
    val shots = core.shots
    val askPhotos = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted && !shots.canRead) ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
        core.changed()
    }
    MacCard("Pictures") {
        SwitchRow("Pictures", "Copy pictures and screenshots up to 10 MB in both directions. Also turn on Pictures on $name. Not available over Bluetooth.", clip.picturesOn, first = true) { clip.setPictures(it); shots.watch() }
        if (clip.picturesOn && core.host != null && !clip.peerImages) MacRow("Off on $name", "Turn on Pictures in Clipboard on $name (TwinDesk 2.3 or later)")
        if (clip.picturesOn) {
            SwitchRow("Send screenshots to $name", "New screenshots are copied to the clipboard on $name", shots.on) { shots.setOn(it) }
            if (shots.on && !shots.canRead) MacRow("Allow photo access", "TwinDesk only checks for new screenshots") { Primary("Allow") { askPhotos.launch(shots.permission) } }
            if (shots.lastSent.isNotEmpty()) MacRow("Last screenshot sent", shots.lastSent)
        }
    }
    if (clip.history.isNotEmpty()) MacCard("Recent") {
        clip.history.toList().take(12).forEachIndexed { i, item ->
            // A picture of ours isn't kept here: only the computer's copy again.
            val again = item.dir == "in" || item.picture == null
            MacRow(item.text.replace('\n', ' ').take(120), (if (item.dir == "in") "From $name" else "To $name") + if (again) " · tap to copy" else "", first = i == 0, onClick = if (again) ({ clip.copyAgain(item) }) else null)
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
    PageHead("Notifications", "See notifications from both devices.")
    if (core.host == null) NotConnected(core, v)
    if (!core.notifs.supported) Note(
        "This version of TwinDesk can’t read notifications, as Play Protect restricts downloaded apps. " +
            "Once wireless debugging is set up, install the full version from the Phone page on $name. Your settings and pairings are kept.",
        "warn",
    )
    else if (!core.notifs.hasAccess) Note("Allow Notification access to show this device’s notifications on $name.", "warn")
    MacCard {
        DirHead(me, true, name, false)
        SwitchRow("Show this device’s notifications on $name", "${core.notifs.sent} sent", core.sync.get("notifs", "out"), first = true) { core.sync.set("notifs", "out", it) }
        SwitchRow("Hide the message text", "Only the app name and title are shown on $name", core.store.flag("notifs.hideText", false)) { core.store.setFlag("notifs.hideText", it); core.changed() }
        if (core.notifs.supported && !core.notifs.hasAccess) MacRow("Notification access", "Required to read notifications") { Primary("Allow") { ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) } }
        if (!core.notifs.supported && !core.adb.paired) MacRow("Wireless debugging", "Set it up, then install the full version from $name") { Primary("Guide") { Guide.open.value = true } }
    }
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow("Show $name’s notifications here", "${core.notifs.shown} shown", core.sync.get("notifs", "in"), first = true) { core.sync.set("notifs", "in", it) }
    }
    // Each app on its own (#102): switched off, its notifications stay on this device.
    if (core.notifs.supported) MacCard("Apps") {
        val apps = core.notifs.apps()
        if (apps.isEmpty()) MacRow("No notifications yet", "Apps show up here after their first notification", first = true)
        apps.forEachIndexed { i, (pkg, label) ->
            SwitchRow(label, "", !core.notifs.isMuted(pkg), first = i == 0) { core.notifs.setMuted(pkg, !it) }
        }
    }
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
    PageHead("Files", "Send, copy and drag files between your devices.")
    if (host == null) return NotConnected(core, v)

    core.fclip.incoming?.let { o ->
        MacCard("Copied on $name") {
            MacRow(if (o.names.size == 1) o.names[0] else "${o.names.size} items", FileClip.size(o.bytes), first = true) {
                Primary("Copy") { core.fclip.fetch(o.id, save = false) }
                Secondary("Save") { core.fclip.fetch(o.id, save = true) }
            }
        }
    }

    MacCard("Send to $name") {
        MacRow("Send files", "Saved to the Downloads folder on $name. You can also share from any app.", first = true) { Primary("Choose…") { pick.launch("*/*") } }
        MacRow("Copy files", "Choose files, then paste them anywhere on $name with ⌃⌥V") { Secondary("Choose…") { pickCopy.launch("*/*") } }
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
                Text(if (over) "Drop to send to $name" else "Or drag files here", color = if (over) pal.accent else pal.muted, fontSize = 13.5.sp, maxLines = 1)
            }
        }
    }
    MacCard("From $name") {
        MacRow("Drag across the screen edge", "Files you drag to this device are saved in Downloads › TwinDesk", first = true)
        MacRow("Copy on $name with ⌃⌥C", "Paste the files here, or save them to this device")
        MacRow("Drop on the phone window", "Files dropped on this phone’s window on $name are saved to this device")
    }

    val moving = core.files.sending.map { "Sending ${it.name}" to Files.pct(it.sent, it.bytes) } +
        core.files.receiving.map { "Receiving ${Files.plural(it.count, "file")}" to Files.pct(it.got, it.bytes) }
    if (moving.isNotEmpty() || core.fclip.status.isNotEmpty()) MacCard("In progress") {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((label, pct) in moving) {
                Text("$label · $pct%", color = pal.text)
                LinearProgressIndicator(progress = { pct / 100f }, modifier = Modifier.fillMaxWidth(), color = pal.accent, trackColor = pal.trackOff)
            }
            if (core.fclip.status.isNotEmpty()) Text(core.fclip.status, color = pal.muted)
        }
    }
    if (core.files.recent.isNotEmpty()) MacCard("Recent") {
        core.files.recent.take(10).forEachIndexed { i, r -> MacRow(r, "", first = i == 0) }
        MacRow("Downloads", "") { Secondary("Show") { ctx.startActivity(Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
    }
}

// ---- Sound ----

@Composable
private fun SoundPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val name = them(core)
    val me = core.store.deviceName
    PageHead("Sound", "Play audio from one device on the other.")
    if (core.host == null) NotConnected(core, v)
    else WifiGate(core, "Sound")
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow("Play $name’s sound here", if (core.macSound.playing) "Playing" else "", core.sync.get("audio", "in"), first = true) { core.sync.set("audio", "in", it) }
    }
    MacCard {
        DirHead(me, true, name, false)
        SwitchRow("Play this device’s sound on $name", soundHint(core), core.sync.get("audio", "out"), first = true) { core.sync.set("audio", "out", it) }
        SoundStart(core)
    }
    Note("Audio from screen sharing plays in the screen view. See Screen › Playback.")
}

// This device's sound there: through wireless debugging, else captured here (Sound.kt).
private fun soundHint(core: Core) = when {
    core.sound.on -> "Playing on the other device. Stop it from the notification."
    core.sound.error.isNotEmpty() -> core.sound.error
    else -> "Uses wireless debugging when available. Otherwise, TwinDesk asks to capture audio each time."
}

// The computer is waiting for the capture: Start here, as in the notification.
@Composable
private fun SoundStart(core: Core) {
    @Suppress("UNUSED_VARIABLE") val v by core.version.collectAsState() // redraw on Core changes (Compose skips it otherwise: same core)
    val ctx = LocalContext.current
    if (core.mirror.wanted && !core.mirror.on) MacRow("Show this screen", core.mirror.error.ifEmpty { "Android asks once to share the screen" }) { Primary("Start") { core.sound.start(ctx) } }
    else if (core.mirror.on) MacRow("Screen shared", "Close its window on the computer, or Stop, to end it.") { Secondary("Stop") { core.sound.stop() } }
    if (core.sound.wanted && !core.sound.on) MacRow("Start the sound", "Android asks for permission to capture audio") { Primary("Start") { core.sound.start(ctx) } }
    else if (core.sound.on) MacRow("Captured sound", "Audio also plays on this phone. Use wireless debugging to play it only on the computer.") { Secondary("Stop") { core.sound.stop() } }
}

// ---- General ----

@Composable
private fun GeneralPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val ctx = LocalContext.current
    val name = them(core)
    var dev by remember { mutableStateOf(core.store.deviceName) }
    PageHead("General", "")
    val pm = ctx.getSystemService(PowerManager::class.java)
    @Composable
    fun Setup(label: String, hint: String, done: Boolean, action: String, first: Boolean = false, onClick: () -> Unit) =
        MacRow(label, hint, first) { if (done) Pill("Allowed", "good") else Primary(action, onClick) }
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
    MacCard("Permissions") {
        if (Build.VERSION.SDK_INT >= 33) Setup("Notifications", "Incoming files, pairing requests and connection status",
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED, "Allow") {
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // Calls, Messages, Photos and Files on $name (Hub): what each needs, asked here too.
        for ((what, hint) in listOf(
            "calls" to "Answer and make calls on $name",
            "messages" to "Read and send texts on $name",
            "media" to "Your photos and videos on $name",
            "files" to "Browse this device’s storage and shared folders on $name",
        )) {
            val perm = core.hub.perm(what)
            if (perm == "none") MacRow(Hub.label(what), if (what == "files") "Requires Android 11 or later" else "Requires the full version of TwinDesk, which you can install from $name")
            else Setup(Hub.label(what), if (perm == "partial") "Some permissions are missing: $hint" else hint, perm == "ok", "Allow") { core.hub.askHere(what) }
        }
        if (core.notifs.supported) Setup("Notification access", "Show this device’s notifications on $name", core.notifs.hasAccess, "Allow") {
            ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } else MacRow("Notification access", "Available in the full version of TwinDesk, which you can install from $name")
        Setup("Run in the background", "Lets $name connect to this device at any time", pm.isIgnoringBatteryOptimizations(ctx.packageName), "Allow") {
            @Suppress("BatteryLife")
            ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
        }
        MacRow(
            "Wireless debugging",
            when {
                core.adb.paired -> "Paired with $name for screen, sound, mouse and keyboard"
                core.link.ble -> "Requires Wi-Fi. You’re connected over Bluetooth."
                core.adb.wifiDebugging && !core.adb.setupNeeded -> "Paired with $name, reconnecting…"
                core.adb.wifiDebugging -> "On. Pair it with $name once using the guide."
                else -> "Used for screen, sound, mouse and keyboard with $name"
            },
        ) {
            if (core.adb.paired) Pill("Paired", "good")
            else if (core.link.ble) Pill("Wi-Fi only", "muted")
            else {
                if (!core.adb.wifiDebugging) Secondary("Turn on") { core.adb.turnOn() }
                Primary("Guide") { Guide.open.value = true }
            }
        }
        // Off until switched on (Adb.autoOffEnabled): only what TwinDesk switched on goes off again.
        SwitchRow(
            "Turn off wireless debugging when disconnected",
            when {
                !core.adb.canEnable -> "Turns off 2 minutes after $name disconnects, if TwinDesk turned it on"
                core.adb.autoOffEnabled -> "Turns off 2 minutes after $name disconnects and back on when it reconnects. Stays on if you turned it on yourself."
                else -> "Wireless debugging stays on after $name disconnects"
            },
            core.adb.autoOffEnabled, enabled = core.adb.canEnable,
        ) { core.adb.setAutoOff(it) }
        Setup("Nearby devices", "Use Bluetooth and Wi-Fi Direct when $name isn’t on this network", nearbyAllowed, "Allow") {
            askNearby.launch(nearbyPerms)
        }
        if (core.input.supported) Setup("Mouse and keyboard", "Lets $name control this phone on any network without wireless debugging", core.input.on, "Allow") { core.input.openSettings() }
        else MacRow("Mouse and keyboard", "Uses wireless debugging. Accessibility control is available in the full version of TwinDesk.")
        Setup("Show the pointer", "Shows the pointer from $name over other apps", core.pointer.allowed, "Allow") {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        }
        if (Build.VERSION.SDK_INT >= 30) Setup("All files access", "Used for your wallpaper on $name, Files and shared folders", android.os.Environment.isExternalStorageManager(), "Allow") {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        }
    }
    AppearanceCard()
    MacCard("This device") {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Name", color = pal.text, fontSize = 15.sp)
            Text("How this device appears on your computers", color = pal.muted, fontSize = 12.5.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(dev, { dev = it }, singleLine = true, modifier = Modifier.weight(1f),
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = pal.text), shape = RoundedCornerShape(8.dp))
                Secondary("Save") { core.store.setDeviceName(dev); core.changed() }
            }
        }
    }
    MacCard("Not on the same network") {
        BleSwitch(core, "Allow Nearby devices permission above", first = true)
        SwitchRow("Turn off Bluetooth on Wi-Fi connections", if (core.bleWifiOff) "Turns Bluetooth off while connected to $name over the same Wi-Fi network"
            else "Bluetooth stays on as a backup if Wi-Fi drops", core.bleWifiOff) { core.store.setFlag("bleWifiOff", it); core.changed() }
        val n = core.net
        if (n.state != "idle") MacRow("Wi-Fi", when (n.state) {
            "asking", "hosting" -> "Starting a direct Wi-Fi link…"
            "joining" -> "Joining $name’s Wi-Fi…"
            "joined" -> "On a direct Wi-Fi link with $name"
            "failed" -> n.error
            else -> ""
        })
    }
    if (core.hosts().isNotEmpty()) MacCard("Paired") {
        core.hosts().forEachIndexed { i, h ->
            MacRow(h.name, if (core.host?.id == h.id) (if (core.link.wired) "Connected over USB" else if (core.link.ble) "Connected over Bluetooth" else "Connected") else "Last address ${h.address}", first = i == 0) {
                if (core.host?.id == h.id) Pill("Online", "good")
                TextButton(onClick = { core.forget(h.id) }) { Text("Forget", color = pal.muted) }
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

        Row(
            Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 12.dp).fillMaxWidth()
                
                .padding(horizontal = 8.dp, vertical = 20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Device(me, phone = true, Modifier.weight(1f))
            Column(Modifier.weight(0.9f), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)).background(
                    if (host != null) Brush.horizontalGradient(listOf(pal.good, pal.accent)) else Brush.horizontalGradient(listOf(pal.trackOff, pal.trackOff)),
                ))
                Text(
                    when { host != null -> listOfNotNull(core.net.via, link.rttMs?.let { "$it ms" }).joinToString(" · ").ifEmpty { "Connected" }; link.state == "connecting" -> "Connecting…"; link.pair != null -> "Pairing…"; else -> "Not connected" },
                    color = pal.muted, fontSize = 11.sp, maxLines = 2, lineHeight = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp),
                )
            }
            Device(them(core), phone = false, Modifier.weight(1f))
        }
        if (!(Modern.on && host != null)) Text(
            when {
                host != null -> "Connected"
                link.message.isNotEmpty() -> link.message
                core.hosts().isNotEmpty() -> "Tap Connect, or select this device on your computer."
                else -> "Choose a computer below, or pair by address."
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
                if (adbBle) "Wireless debugging requires Wi-Fi. You’re connected to ${host.name} over Bluetooth."
                else if (!core.adb.needed) "Wireless debugging isn’t in use. ${host.name} shows and controls this screen through TwinDesk; set it up for phone apps in windows and the camera."
                else if (core.adb.setupNeeded) "Wireless debugging isn’t set up. ${host.name} uses it to show and control this screen."
                else "Wireless debugging is off. ${host.name} uses it to show and control this screen.",
                color = if (adbBle) pal.muted else pal.text, fontSize = 12.5.sp, lineHeight = 17.sp, modifier = Modifier.weight(1f).padding(end = 8.dp),
            )
            if (!adbBle) { if (core.adb.setupNeeded) Secondary("Set up") { Guide.open.value = true } else Secondary("Turn on") { core.adb.turnOn() } }
        }
        if (host != null) {
            val show = { core.ctx.startActivity(Intent(core.ctx, ViewerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            // On Bluetooth: a direct Wi-Fi link on request, or made for files and screens: Back to Bluetooth ends it (both sides).
            val onWifi = core.net.wanted("user") || core.net.linked
            val wifiLabel = if (onWifi) "Back to Bluetooth" else if (core.link.ble) "Connect with Wi-Fi Direct" else null
            val wifiClick = { if (onWifi) core.net.drop() else core.net.need("user"); core.changed() }
            if (LocalConfiguration.current.screenWidthDp >= 600) {
                Row(Modifier.fillMaxWidth().padding(bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                    Primary("Show ${host.name}’s screen", show)
                    if (wifiLabel != null) Secondary(wifiLabel) { wifiClick() }
                    Secondary("Disconnect") { core.disconnect() }
                }
            } else {
                // A phone: one button per line, inside the card's padding.
                Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = show, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(50),
                        colors = ButtonDefaults.buttonColors(containerColor = if (Modern.on) pal.accentSoft else pal.accent, contentColor = if (Modern.on) pal.accent else Color.White), elevation = if (Modern.on) null else ButtonDefaults.buttonElevation()) {
                        Text("Show ${host.name}’s screen", fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (wifiLabel != null) Button(onClick = { wifiClick() }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(50), elevation = null, colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = pal.text)) { Text(wifiLabel) }
                    Button(onClick = { core.disconnect() }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(50), elevation = null, colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = pal.text)) { Text("Disconnect") }
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
        Text("Version ${BuildConfig.VERSION_NAME}", color = pal.muted)
        Text("Use your computer and phone together as one workspace.", color = pal.muted, modifier = Modifier.padding(top = 6.dp, bottom = 20.dp))
    }
    val ctx = LocalContext.current
    val open = { url: String -> ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    val u = core.updates
    MacCard("Updates") {
        MacRow(
            "TwinDesk",
            when {
                u.checking -> "Checking…"
                u.error.isNotEmpty() -> "Couldn’t check: ${u.error}"
                u.available -> "${u.latest} is available. You have ${u.current}. " + (u.download?.let { "Download ${it.name}" } ?: "Opens the release page")
                u.noReleases -> "Version ${u.current}. No releases are available yet."
                u.checkedAt > 0 -> "Up to date · checked " + java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(u.checkedAt))
                else -> "Version ${u.current}"
            },
            first = true,
        ) {
            if (u.available) Primary("Download") { u.open() }
            if (!u.checking) Secondary("Check now") { u.checkNow() }
        }
        SwitchRow("Check automatically", "Looks for new releases on GitHub every few hours", u.auto) { u.auto = it }
    }
    MacCard("Made by") {
        MacRow("Inuka Asith", "inukaasith.vercel.app", first = true) { Secondary("Portfolio") { open("https://inukaasith.vercel.app") } }
        MacRow("Source code", "github.com/InukaAsith/TwinDesk") { Secondary("GitHub") { open("https://github.com/InukaAsith/TwinDesk") } }
        MacRow("Releases", "New versions for every platform") { Secondary("Open") { open("https://github.com/InukaAsith/TwinDesk/releases") } }
    }
    MacCard("License") {
        MacRow("GNU General Public License v3", "Free and open source. Copyright © 2026 inukaasith", first = true) {
            Secondary("Read") { open("https://github.com/InukaAsith/TwinDesk/blob/main/LICENSE") }
        }
        MacRow("Screen, input and sound over wireless debugging", "scrcpy-server (Apache-2.0)")
        MacRow("Network", "OkHttp (Apache-2.0)")
    }
    Text("Crafted with ☕ and ❤️ in Sri Lanka 🇱🇰", color = pal.muted, fontSize = 13.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 24.dp))
}
