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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
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
    Overview("Overview", Ico.overview, grad(0xFF8E8E93, 0xFF636366), ""),
    // On the computer, from this phone (Hub.kt): their settings here.
    Calls("Calls", Ico.call, grad(0xFF5EE07A, 0xFF30B94D), "Phone"),
    Messages("Messages", Ico.message, grad(0xFF5EE07A, 0xFF30B94D), "Phone"),
    Photos("Photos", Ico.photo, grad(0xFFFFD60A, 0xFFFF9F0A), "Phone"),
    FileAccess("File access", Ico.folder, grad(0xFF64D2FF, 0xFF0A84FF), "Phone"),
    Screen("Screen", Ico.display, grad(0xFF5AC8FA, 0xFF0A84FF), "Display"),
    Cursor("Cursor", Ico.cursor, grad(0xFFFFB340, 0xFFFF9500), "Input"),
    Keyboard("Keyboard", Ico.keyboard, grad(0xFFD1D1D6, 0xFF8E8E93), "Input"),
    Clipboard("Clipboard", Ico.clipboard, grad(0xFF64D2FF, 0xFF30B0C7), "Share"),
    Notifications("Notifications", Ico.bell, grad(0xFFFF6961, 0xFFFF3B30), "Share"),
    Files("Files", Ico.files, grad(0xFF64D2FF, 0xFF0A84FF), "Share"),
    Sound("Sound", Ico.audio, grad(0xFFFF6482, 0xFFFF2D55), "More"),
    General("General", Ico.general, grad(0xFFAEAEB2, 0xFF636366), "bottom"),
    About("About", Ico.about, grad(0xFF64D2FF, 0xFF0A84FF), "bottom"),
}

private val BOTTOM = listOf(Tab.Overview, Tab.Screen, Tab.Cursor, Tab.Files)

// The sidebar's green dot: the page's feature is on.
private fun isOn(core: Core, t: Tab): Boolean = when (t) {
    Tab.Screen -> core.screen.viewing
    Tab.Cursor -> core.kvm.linked && core.sync.get("cursor", "in")
    Tab.Keyboard -> core.sync.value("keyboard") == "true"
    Tab.Clipboard -> core.sync.get("clipboard", "in") || core.sync.get("clipboard", "out")
    Tab.Notifications -> core.sync.get("notifs", "in") || core.sync.get("notifs", "out")
    Tab.Sound -> core.sync.get("audio", "in") || core.sync.get("audio", "out")
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
    var tab by rememberSaveable { mutableStateOf(Tab.Overview) }
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
                    "$name uses it for this device’s screen, its mouse and keyboard here, and sound. " +
                        "Some phones (MIUI, HyperOS) switch it off after a Wi-Fi change, a screen lock or a restart.\n\n" +
                        "Settings opens at Developer options: switch USB debugging and Wireless debugging on, then come back.",
                    color = pal.muted,
                )
            },
            confirmButton = { TextButton(onClick = { adbAsked = true; core.adb.openSettings() }) { Text("Open Settings", color = pal.accent) } },
            dismissButton = { TextButton(onClick = { adbAsked = true }) { Text("Not now", color = pal.muted) } },
        )
    }

    // A computer wants to pair, or its code is up: over whatever page is open, not only the
    // notification and the Overview.
    core.invite?.let { inv ->
        AlertDialog(
            onDismissRequest = {},
            containerColor = pal.card,
            title = { Text("${inv.name} wants to pair", color = pal.text) },
            text = { Text("Press Pair to pair this device with ${inv.name}. You’ll check that both show the same code.", color = pal.muted) },
            confirmButton = { TextButton(onClick = { core.pair(inv) }) { Text("Pair", color = pal.accent) } },
            dismissButton = { TextButton(onClick = { core.dismissInvite() }) { Text("Not now", color = pal.muted) } },
        )
    }
    core.link.pair?.takeIf { it.phase == "code" && !it.wired }?.let { p ->
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
            Column(Modifier.safeDrawingPadding()) {
                TopIdentity(core, v)
                if (more) MoreList(core, v, Modifier.weight(1f)) { tab = it; more = false }
                else Page(core, v, tab, Modifier.weight(1f))
                NavigationBar(containerColor = pal.card) {
                    val item = @Composable { label: String, icon: ImageVector, colors: List<Color>, selected: Boolean, go: () -> Unit ->
                        NavigationBarItem(
                            selected = selected, onClick = go,
                            icon = { Box(Modifier.alpha(if (selected) 1f else 0.72f)) { Tile(icon, colors, 28) } },
                            label = { Text(label, maxLines = 1, fontSize = 11.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal) },
                            colors = NavigationBarItemDefaults.colors(selectedTextColor = pal.accent, indicatorColor = pal.accentSoft, unselectedTextColor = pal.muted),
                        )
                    }
                    for (t in BOTTOM) item(t.title, t.icon, t.colors, !more && tab == t) { tab = t; more = false }
                    item("More", Ico.more, grad(0xFFAEAEB2, 0xFF636366), more || tab !in BOTTOM) { more = true }
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
            PcPicker(core, v)
        }
    }
}

// The computer selector in the header (Selector.kt): the computer every page works with. One paired
// computer: plain text. Several: tap to list them all (connected first, then the paired ones that are
// not connected, which a tap dials and then selects); the choice is Core.choose, the same select()
// the Devices card's Use button calls.
@Composable
private fun PcPicker(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val sel = core.pcSelector()
    var open by remember { mutableStateOf(false) }
    val h = core.host
    val base = when {
        sel.current == null && core.pairLink.pair != null -> "Pairing…"
        sel.current == null && sel.dot == "warn" -> sel.label + " · Connecting…"
        sel.current == null && sel.choices.isNotEmpty() -> PcSelect.IDLE
        else -> sel.label
    }
    val label = base + (if (h == null) "" else (if (core.link.wired) " · USB" else if (core.link.ble) " · Bluetooth" else "") + (core.link.rttMs?.let { " · $it ms" } ?: ""))
    val dot = when { core.pairLink.pair != null && sel.current == null -> pal.warn; sel.dot == "good" -> pal.good; sel.dot == "warn" -> pal.warn; else -> pal.faint }
    Box {
        Row(
            Modifier.clip(RoundedCornerShape(6.dp)).then(if (sel.expandable) Modifier.clickable { open = true } else Modifier),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Dot(dot, 7)
            Text(label, color = pal.muted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp).widthIn(max = 220.dp))
            if (sel.expandable) Text("▾", color = pal.muted, fontSize = 12.sp, modifier = Modifier.padding(start = 4.dp))
        }
        DropdownMenu(expanded = open && sel.expandable, onDismissRequest = { open = false }, modifier = Modifier.background(pal.card)) {
            for (c in sel.choices) {
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(c.name, color = if (c.state == "offline") pal.faint else pal.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (c.detail.isNotEmpty()) Text(c.detail, color = pal.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    },
                    onClick = { open = false; core.choose(c) },
                    enabled = c.action != PcAction.NONE,
                    leadingIcon = { Dot(when (c.state) { "connected" -> pal.good; "connecting" -> pal.warn; else -> pal.faint }, 8) },
                    trailingIcon = { if (c.selected) Text("✓", color = pal.accent, fontSize = 14.sp) },
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
        for (t in Tab.entries) {
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
    Box(Modifier.fillMaxWidth().background(pal.sidebar).padding(horizontal = 16.dp, vertical = 10.dp)) { Identity(core, v, 40) }
}

@Composable
private fun MoreList(core: Core, v: Int, modifier: Modifier, go: (Tab) -> Unit) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp)) {
        PageHead("More", "")
        MacCard {
            Tab.entries.filter { it !in BOTTOM }.forEachIndexed { i, t ->
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
                Tab.Overview -> OverviewPage(core, v)
                Tab.Calls -> CallsPage(core, v)
                Tab.Messages -> MessagesPage(core, v)
                Tab.Photos -> PhotosPage(core, v)
                Tab.FileAccess -> FileAccessPage(core, v)
                Tab.Screen -> ScreenPage(core, v)
                Tab.Cursor -> CursorPage(core, v)
                Tab.Keyboard -> KeyboardPage(core, v)
                Tab.Clipboard -> ClipboardPage(core, v)
                Tab.Notifications -> NotificationsPage(core, v)
                Tab.Files -> FilesPage(core, v)
                Tab.Sound -> SoundPage(core, v)
                Tab.General -> GeneralPage(core, v)
                Tab.About -> AboutPage(core, v)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun Primary(label: String, onClick: () -> Unit) = Button(onClick = onClick, colors = ButtonDefaults.buttonColors(containerColor = pal.accent, contentColor = Color.White), shape = RoundedCornerShape(8.dp)) { Text(label) }

@Composable
private fun Secondary(label: String, onClick: () -> Unit) = OutlinedButton(onClick = onClick, shape = RoundedCornerShape(8.dp)) { Text(label, color = pal.text) }

@Composable
private fun NotConnected(core: Core, v: Int) = Note("Not connected. Connect to ${them(core)} on the Overview page.".also { v }, "warn")

// ---- Overview ----

@Composable
private fun OverviewPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val link = core.link
    val pairing = core.pairLink
    val host = core.host
    val me = core.store.deviceName
    val ip = remember(v) { core.adb.address() } // this phone's Wi-Fi address, for pairing by address on the computer
    if (LocalConfiguration.current.screenWidthDp >= 600) PageHead("TwinDesk", listOf(me, ip).filter { it.isNotEmpty() }.joinToString(" · "))
    else PageHead(me, listOf("This device", ip).filter { it.isNotEmpty() }.joinToString(" · "))

    core.invite?.let { inv ->
        Note("${inv.name} wants to pair with this device.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 16.dp)) {
            Primary("Pair") { core.pair(inv) }
            Secondary("Not now") { core.dismissInvite() }
        }
    }
    pairing.pair?.let { p ->
        MacCard("Pairing with ${p.name}") {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                when (p.phase) {
                    "code", "waiting" -> if (p.wired) {
                        Text("On the USB cable. Click Allow on ${p.name}.", color = pal.text)
                        Secondary("Cancel") { link.cancelPairing() }
                    } else {
                        Text("Check that ${p.name} shows the same code.", color = pal.text)
                        Text("${p.code.take(3)} ${p.code.drop(3)}", fontSize = 40.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp, color = pal.text)
                        if (p.phase == "code") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Primary("Codes match") { pairing.confirmCode() }
                            Secondary("Cancel") { pairing.cancelPairing() }
                        } else Text("Waiting for Allow on ${p.name}…", color = pal.muted)
                    }
                    "failed" -> {
                        Text(p.error, color = pal.bad)
                        Secondary("OK") { pairing.cancelPairing() }
                    }
                    else -> {
                        Text(if (p.ble) "Connecting over Bluetooth…" else "Connecting…", color = pal.muted)
                        Secondary("Cancel") { link.cancelPairing() }
                    }
                }
            }
        }
    }

    // The hero: this device, the link, the computer (the Mac's `.hero`).
    MacCard {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 22.dp), verticalAlignment = Alignment.CenterVertically) {
            Device(me, phone = true, Modifier.weight(1f))
            Column(Modifier.weight(0.9f), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)).background(
                    if (host != null) Brush.horizontalGradient(listOf(pal.good, pal.accent)) else Brush.horizontalGradient(listOf(pal.trackOff, pal.trackOff)),
                ))
                Text(
                    when { host != null -> listOfNotNull(if (link.wired) "USB" else if (link.ble) "Bluetooth" else null, link.rttMs?.let { "$it ms" }).joinToString(" · ").ifEmpty { "Connected" }; link.state == "connecting" -> "Connecting…"; pairing.pair != null -> "Pairing…"; else -> "Not connected" },
                    color = pal.muted, fontSize = 11.sp, maxLines = 2, lineHeight = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp),
                )
            }
            Device(them(core), phone = false, Modifier.weight(1f))
        }
        Text(
            when {
                host != null -> "Connected"
                link.message.isNotEmpty() -> link.message
                core.hosts().isNotEmpty() -> "Tap Connect, or click this device on your Mac."
                else -> "Pick a computer below, or pair by address."
            },
            color = pal.muted, fontSize = 12.5.sp, lineHeight = 17.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 14.dp),
        )
        // Wireless debugging not set up (or off): one line under Connected, with the way to fix it.
        // Reached anyway (adb's TCP mode, on a direct Wi-Fi link): nothing to fix.
        // Over Bluetooth: greyed out, it only works over Wi-Fi.
        val adbBle = core.link.ble
        if (host != null && !core.adb.paired && (adbBle || core.adb.setupNeeded || !core.adb.wifiDebugging)) Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 14.dp).clip(RoundedCornerShape(8.dp)).background(if (adbBle) pal.line.copy(alpha = 0.35f) else pal.warn.copy(alpha = 0.12f)).padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (adbBle) "Wireless debugging: only available over Wi-Fi. You’re connected to ${host.name} over Bluetooth."
                else if (core.adb.setupNeeded) "Wireless debugging isn’t set up. ${host.name} needs it to show this screen and control it through ADB."
                else "Wireless debugging is off. ${host.name} needs it to show this screen and control it through ADB.",
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
                    Button(onClick = show, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(8.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = pal.accent, contentColor = Color.White)) {
                        Text("Show ${host.name}’s screen", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (wifiLabel != null) OutlinedButton(onClick = { wifiClick() }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(8.dp)) { Text(wifiLabel, color = pal.text) }
                    OutlinedButton(onClick = { core.disconnect() }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(8.dp)) { Text("Disconnect", color = pal.text) }
                }
            }
        }
    }


    // Everyone in the mesh: every connected computer (Use attaches the screen, files and the rest to it)
    // and the devices only they are connected to (via …: this phone cannot dial them by tapping).
    val known = core.known()
    if (known.size >= 2 || (known.isNotEmpty() && known.any { !it.direct })) MacCard("Devices") {
        val byId = known.associateBy { it.id }
        known.forEachIndexed { i, k ->
            val os = when (k.os) { "mac" -> "Mac"; "linux" -> "Linux"; "win" -> "PC"; "android" -> "Android"; else -> "" }
            val name = k.name.ifEmpty { os.ifEmpty { "Device" } }
            if (k.direct) {
                val l = core.links.existing(k.id)
                val attached = host?.id == k.id
                MacRow(name, listOf(os, if (l?.wired == true) "USB" else if (l?.ble == true) "Bluetooth" else "Connected").filter { it.isNotEmpty() }.joinToString(" · "), i == 0) {
                    if (attached) Pill("In use", "good")
                    else Secondary("Use") { core.select(k.id) }
                }
            } else {
                MacRow(name, listOf(os, "via " + k.via.joinToString(", ") { byId[it]?.name?.takeIf { n -> n.isNotEmpty() } ?: "a computer" }).filter { it.isNotEmpty() }.joinToString(" · "), i == 0) {
                    Pill(if (!Intro.canHost(k.os)) "Not connectable" else if (core.meshAutoJoin) "Joining" else "Not connected", "muted")
                }
            }
        }
    }

    // The other paired computers, while connected: Switch (Take over when nearby) lets this one go and connects that one.
    if (host != null) {
        val others = core.hosts().filter { it.id != host.id && core.links.existing(it.id)?.connected != true }
        if (others.isNotEmpty()) MacCard("Switch to") {
            others.forEachIndexed { i, h ->
                val near = core.isNear(h.id)
                MacRow(h.name, if (near && !core.discovery.found.containsKey(h.id)) "Nearby over Bluetooth · paired" else if (near) "Nearby · paired" else "Paired · not nearby", i == 0) {
                    Secondary(if (near) "Take over" else "Switch") { core.switchTo(h) }
                }
            }
        }
        MacCard { BleSwitch(core, "Allow Nearby devices on the General page", first = true) }
    }

    if (host != null) {
        val wide = LocalConfiguration.current.screenWidthDp >= 840
        val m2p = @Composable { mod: Modifier ->
            MacCard(modifier = mod) {
                DirHead(host.name, false, me, true)
                SwitchRow("Screen", "Open it on the Screen page", core.screen.viewing, first = true) { if (it) core.ctx.startActivity(Intent(core.ctx, ViewerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                SwitchRow("Sound", "", core.sync.get("audio", "in")) { core.sync.set("audio", "in", it) }
                SwitchRow("Mouse and keyboard", "", core.sync.get("cursor", "in")) { core.sync.set("cursor", "in", it) }
                SwitchRow("Clipboard", "", core.sync.get("clipboard", "in")) { core.sync.set("clipboard", "in", it) }
                SwitchRow("Notifications", "", core.sync.get("notifs", "in")) { core.sync.set("notifs", "in", it) }
            }
        }
        val p2m = @Composable { mod: Modifier ->
            MacCard(modifier = mod) {
                DirHead(me, true, host.name, false)
                SwitchRow("Sound", soundHint(core), core.sync.get("audio", "out"), first = true) { core.sync.set("audio", "out", it) }
                SoundStart(core)
                SwitchRow("Clipboard", "", core.sync.get("clipboard", "out")) { core.sync.set("clipboard", "out", it) }
                SwitchRow("Notifications", if (core.notifs.hasAccess) "" else if (!core.notifs.supported) "Needs TwinDesk with notifications (Notifications page)" else "Needs Notification access (General)", core.sync.get("notifs", "out")) { core.sync.set("notifs", "out", it) }
                // Calls, Messages and Photos, when the computer has them: what each needs is asked for as it's switched on.
                if (core.hub.peer) for (what in listOf("calls", "messages", "media", "files")) {
                    val perm = core.hub.perm(what)
                    val on = core.hub.on(what)
                    SwitchRow(
                        Hub.label(what),
                        when {
                            perm == "none" && what == "files" -> "Needs Android 11 or later"
                            perm == "none" -> "Needs TwinDesk with notifications (Notifications page)"
                            on && perm == "ask" && what == "files" -> "Allow All files access: switch it on again"
                            on && perm == "ask" -> "Tap Allow on the prompt, or switch it on again"
                            on && perm == "partial" && what == "media" -> "Only the photos you chose"
                            on && perm == "partial" -> "Some access is missing: switch it on again to allow it"
                            what == "calls" -> "Answer and make calls on ${host.name}"
                            what == "messages" -> "Read and send texts on ${host.name}"
                            what == "files" -> "Browse this phone’s storage on ${host.name}, no ADB"
                            else -> "See and save them on ${host.name}"
                        },
                        on, enabled = perm != "none",
                    ) {
                        core.hub.set(what, it)
                        if (it && perm != "ok") core.ctx.startActivity(Intent(core.ctx, PermActivity::class.java).putExtra("what", what).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                }
            }
        }
        if (wide) Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) { m2p(Modifier.weight(1f)); p2m(Modifier.weight(1f)) }
        else { m2p(Modifier); p2m(Modifier) }
    }

    MacCard("Nearby") {
        val hosts = core.hosts()
        var first = true
        for (h in hosts) {
            val near = core.isNear(h.id)
            MacRow(h.name, if (link.state == "connecting" && link.host?.id == h.id) "Connecting…" else if (near && !core.discovery.found.containsKey(h.id)) "Nearby over Bluetooth · paired" else if (near) "Nearby · paired" else "Paired · not nearby", first) {
                TextButton(onClick = { core.forget(h.id) }) { Text("Forget", color = pal.bad) }
                // Nearby: Take over (a phone's hello takes the computer from whoever has it).
                Primary(if (near) "Take over" else "Connect") { core.connect(h) }
            }
            first = false
        }
        for (f in core.nearby().filter { f -> hosts.none { it.id == f.id } }) {
            MacRow(f.name, "${if (f.os == "mac") "Mac" else if (f.os == "linux") "Linux" else "PC"} · ${if (f.address.startsWith("ble:") || f.address.startsWith("blp:")) "Bluetooth" else f.address}", first) { Secondary("Pair") { core.pair(f) } }
            first = false
        }
        if (first) MacRow("Looking for computers…", if (core.bleOn && core.ble.allowed()) "Open TwinDesk on your computer (same Wi-Fi, or Bluetooth on)" else "Open TwinDesk on your Mac (same Wi-Fi)", true)
        BleSwitch(core, "Allow Nearby devices on the General page")
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

// Bluetooth with computers (Overview and General, as on the computers): for one that isn't on this
// network. Off by itself while the session is on the same Wi-Fi, on again when that drops (Core.bleTick).
@Composable
private fun BleSwitch(core: Core, askHint: String, first: Boolean = false) {
    val ctx = LocalContext.current
    val name = them(core)
    val link = core.link
    val allowed = (Ble.permissions() + BleServe.permissions() + Direct.permission()).all { ctx.checkSelfPermission(it) == android.content.pm.PackageManager.PERMISSION_GRANTED }
    SwitchRow("Bluetooth with computers", when {
        !core.bleOn -> "Only computers on this network or a USB cable connect"
        !core.ble.radioOn -> "Bluetooth is off on this device"
        !allowed -> askHint
        core.bleWifiOff && link.connected && core.net.via == "Wi-Fi" -> "Off while you’re on the same Wi-Fi as $name, on again if it drops"
        else -> "Connects to $name over Bluetooth when it isn’t on this network. Files and screens move to a direct Wi-Fi link for a while"
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
    if (core.host == null || !core.link.ble) return
    val n = core.net
    val moving = n.state in listOf("asking", "hosting", "joining")
    Note(
        when {
            moving -> "$what is only available over Wi-Fi Direct. Connecting…"
            n.state == "failed" -> "$what is only available over Wi-Fi Direct. ${n.error.ifEmpty { "Wi-Fi Direct didn’t come up" }}"
            else -> "$what is only available over Wi-Fi Direct (or the same Wi-Fi network): you’re connected over Bluetooth."
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
    if (!hub.peer) { Note("TwinDesk on $name needs to be up to date for $title.", "warn"); return false }
    when {
        perm == "none" && what == "files" -> Note("File access needs Android 11 or later. Mount on $name works through ADB instead.", "warn")
        perm == "none" -> Note("$title needs TwinDesk with notifications: Android doesn’t let downloaded apps read texts. $name installs it once wireless debugging is set up (its Phone page › Install). Your settings and pairing stay.", "warn")
        !on -> Note("Off. Switch it on here or on $name.")
        perm == "ask" -> {
            Note(
                when (what) {
                    "files" -> "Allow All files access, so $name can browse this phone’s storage. TwinDesk reads and writes the files itself: no ADB."
                    "media" -> "Allow photos and videos, so $name can show them."
                    else -> "Allow what $title needs: ${Hub.wanted(what).size} permissions, asked for once."
                },
                "warn",
            )
            Row(Modifier.padding(bottom = 14.dp)) { Primary("Allow") { hub.askHere(what) } }
        }
        perm == "partial" -> {
            Note(if (what == "media") "Only the photos you chose show on $name." else "Some of $title needs more: allow the rest to use all of it.")
            Row(Modifier.padding(bottom = 14.dp)) { Secondary("Allow more") { hub.askHere(what) } }
        }
        else -> Note("On: $title from this phone on $name.")
    }
    return on && perm != "none"
}

@Composable
private fun CallsPage(core: Core, v: Int) {
    val name = them(core)
    if (!HubHead(core, v, "calls", "Calls", "Answer, make and end this phone’s calls on ${them(core)}.")) return
    MacCard("On $name") {
        MacRow("Answer and decline", "A window on $name when this phone rings", first = true)
        MacRow("Make calls", "The number pad, contacts and recent calls on $name’s Calls page")
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
                !allowed -> "Allow Nearby devices so TwinDesk sees this phone’s pairing with $name"
                !bt.optBoolean("radio", true) -> "Bluetooth is off on this phone"
                bt.optBoolean("bonding") -> "Pairing… Confirm the code here and on $name"
                bt.optBoolean("forget") -> "Forget $name in Bluetooth settings here (Android keeps the old pairing for itself), then pair them again there"
                bonded -> "Paired with $name: calls can play there"
                bt.optBoolean("le") -> "Paired over Bluetooth LE only, which can’t carry a call: Forget, then pair them again in Bluetooth settings"
                !hub.btKnown -> "Waiting for $name…"
                else -> "Not paired with $name over classic Bluetooth: pair them in Bluetooth settings (here: Pair new device, or Add device on $name). TwinDesk connects once they are"
            },
            first = true,
        ) {
            if (!allowed) Primary("Allow") { hub.askHere("bt") }
            else if (hub.btKnown && !bonded && !bt.optBoolean("bonding")) Secondary("Open Bluetooth settings") { hub.btSettings() }
        }
        var sure by remember { mutableStateOf(false) }
        MacRow("Forget", "This phone and $name forget each other, over classic Bluetooth and LE; Bluetooth settings open to pair them again") {
            TextButton(onClick = { if (sure) { sure = false; hub.forgetBt() } else { sure = true } }) { Text(if (sure) "Forget?" else "Forget", color = pal.bad) }
        }
    }
}

@Composable
private fun MessagesPage(core: Core, v: Int) {
    val name = them(core)
    if (!HubHead(core, v, "messages", "Messages", "Read and send this phone’s texts on ${them(core)}.")) return
    MacCard("On $name") {
        MacRow("Conversations", "Texts and MMS pictures on $name’s Messages page", first = true)
        MacRow("New texts", "Counted on the Messages tab on $name")
    }
}

@Composable
private fun PhotosPage(core: Core, v: Int) {
    val name = them(core)
    WifiGate(core, "Photos on $name")
    if (!HubHead(core, v, "media", "Photos", "See this phone’s photos and videos on ${them(core)} and copy them there.")) return
    MacCard("On $name") {
        MacRow("Photos, videos and screenshots", "Newest first on $name’s Photos page", first = true)
        MacRow("Save", "Copies go to $name’s Downloads")
    }
}

@Composable
private fun FileAccessPage(core: Core, v: Int) {
    val name = them(core)
    WifiGate(core, "Phone Files on $name")
    if (HubHead(core, v, "files", "File access", "Browse this phone’s storage on ${them(core)}, and copy files both ways.")) MacCard("On $name") {
        MacRow("Phone Files", "Folders, Save to $name, Upload, New folder, Rename, Delete", first = true)
        MacRow("No ADB", "TwinDesk reads and writes the files itself with All files access. Mount on $name is the ADB way")
        MacRow("Where", "On USB, Wi-Fi or Wi-Fi Direct. Over Bluetooth $name says so, with Connect with Wi-Fi Direct")
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
                !sh.allowed -> "Needs All files access (above)"
                ble && sh.on -> "${sh.shown()}: $name opens it over Wi-Fi Direct"
                sh.error.isNotEmpty() -> "Couldn’t share: ${sh.error}"
                sh.on && sh.serving -> "${sh.shown()}: open on $name (Phone Files › Shared folders)"
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
                ble && sh.pcServe -> "Open connects with Wi-Fi Direct"
                pc != null -> "“${pc.name}” in the Files app and every app’s file picker"
                sh.pcServe -> "Opening…"
                else -> "Off: switch it on to see a folder of $name in the Files app"
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScreenPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val host = core.host
    val s = core.screen
    val ctx = LocalContext.current
    val name = them(core)
    PageHead("Screen", "Use this device as a screen for $name: its own screen (Mirror), or a second one (Extend).")
    if (host == null) return NotConnected(core, v)
    Note(
        when {
            !s.sharing -> "$name isn’t sharing its screen."
            s.mode == "extend" -> "$name shares a second screen the size of this one (Extend)."
            else -> "$name shares its own screen (Mirror)."
        },
    )
    MacCard {
        MacRow("Show $name’s screen", "Full screen. Tap the handle at the top for Mirror, Extend and the keyboard", first = true) {
            Primary("Open") { ctx.startActivity(Intent(ctx, ViewerActivity::class.java)) }
        }
        if (s.remote) MacRow("Mode", "Extend makes $name a second screen the size of this one") {
            SingleChoiceSegmentedButtonRow {
                val modes = listOf("mirror" to "Mirror", "extend" to "Extend")
                modes.forEachIndexed { i, (m, label) ->
                    SegmentedButton(selected = s.sharing && s.mode == m, onClick = { s.control(share = true, mode = m) }, shape = SegmentedButtonDefaults.itemShape(i, modes.size)) { Text(label) }
                }
            }
        } else MacRow("Mode", "$name starts and switches its sharing itself")
        if (s.sharing && s.remote) MacRow("Sharing", "") { Secondary("Stop") { s.control(share = false) } }
    }
    MacCard("Touch") {
        MacRow("Tap", "Click", first = true)
        MacRow("Hold", "Right click")
        MacRow("Drag", "Drag (select, move windows)")
        MacRow("Two fingers", "Scroll")
        if (!s.inputOn) MacRow("Input is off", "$name doesn’t take input from here (its Share screen › Receive input)")
    }
    MacCard("Playback") {
        SwitchRow("$name’s sound with the screen", "When $name shares sound with its screen", core.store.flag("screen.sound", false), first = true) { s.setOpt("screen.sound", it) }
        SwitchRow("Smooth", "Even motion, about one frame later. Off: each frame the moment it arrives", core.store.flag("screen.smooth", false)) { s.setOpt("screen.smooth", it) }
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
    PageHead("Cursor", "Move $name’s pointer off the edge of its screen to use this device.", if (host != null) shared else null) {
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
            viaPhone && !core.input.supported -> "This build of TwinDesk can’t use Accessibility: Android’s Play Protect blocks downloaded apps that can. " +
                "Use wireless debugging, or once it’s set up, $name installs TwinDesk with notifications, which can (on $name, Phone page › Install)."
            viaPhone && !core.input.on -> "Allow TwinDesk in Accessibility, so $name’s pointer can tap and type here."
            adbMissing -> "$name moves the pointer here through wireless debugging, which is off. Or choose Accessibility below."
            !core.pointer.allowed -> "Allow “Show the pointer” in General › Setup to see $name’s pointer here."
            !core.kvm.linked -> "Cursor sharing is off. Double-tap ${core.kvm.hotkey} on $name to turn it on."
            paused -> "Cursor sharing is off over Bluetooth. It comes back on Wi-Fi, or double-tap ${core.kvm.hotkey} on $name to turn it on."
            else -> "Push $name’s pointer past its edge to come here. Double-tap ${core.kvm.hotkey} to take everything back."
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
        SwitchRow("Use $name’s mouse and keyboard on $me", "Push the pointer past the edge", core.sync.get("cursor", "in"), first = true) { core.sync.set("cursor", "in", it) }
        MacRow("Through", when {
            core.input.via == "auto" && core.input.effective == "adb" -> "Automatic: ADB, wireless debugging is on"
            core.input.via == "auto" -> "Automatic: Accessibility until wireless debugging is on"
            core.input.via == "phone" -> "Accessibility: TwinDesk taps and types itself, over Wi-Fi, Wi-Fi Direct or Bluetooth. No developer options"
            else -> "ADB (wireless debugging): full control. Over Bluetooth without it, Accessibility"
        }) {
            SingleChoiceSegmentedButtonRow {
                val ways = listOf("adb" to "ADB", "phone" to "Accessibility")
                ways.forEachIndexed { i, (w, label) ->
                    SegmentedButton(selected = core.input.effective == w, onClick = { core.input.setVia(w); core.changed() }, shape = SegmentedButtonDefaults.itemShape(i, ways.size)) { Text(label, maxLines = 1) }
                }
            }
        }
    }
    MacCard("Where $name is") { LayoutPicker(me, name, core.kvm.macSide) { core.kvm.setMacSide(it) } }
    MacCard("Feel") {
        val speed = core.sync.value("speed").toFloatOrNull() ?: 1f
        MacRow("Pointer speed here", "", first = true) {
            MacSlider(speed, 0.25f..4f, 14, { "%.2f×".format(it) }) { v ->
                val steps = listOf(0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f, 2.5f, 3f, 3.5f, 4f)
                val snapped = steps.minBy { kotlin.math.abs(it - v) }
                core.sync.setValue("speed", if (snapped % 1f == 0f) snapped.toInt() else snapped)
            }
        }
        SwitchRow("Reverse scrolling", "Scroll here the other way", core.sync.value("reverseScroll") == "true") { core.sync.setValue("reverseScroll", it) }
        MacRow("Right click", "Back")
        MacRow("Middle click", "Home")
    }
    MacCard("Not on the same network") {
        SwitchRow("Over Bluetooth", "When $name isn’t on this network and you’re connected through Bluetooth (slower). Off: nothing crosses until you’re on Wi-Fi again. The same on both",
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
    Note(if (on) "$name’s keyboard types here while its pointer is here." else "Keyboard sharing is off: only the pointer comes here.")
    MacCard("Hotkey") {
        MacRow(core.kvm.hotkey, "Double-tap on $name to turn cursor sharing on or off. Set it in TwinDesk on $name", first = true)
    }
    MacCard {
        DirHead(name, false, me, true)
        MacRow("Shortcuts here", "⌘ works as Ctrl, so ⌘C copies and ⌘V pastes", first = true)
        MacRow("Typing", "Every key goes as a key, so any keyboard layout and the soft keyboard stay out of the way")
    }
    MacCard("In the screen view") {
        MacRow("$name’s screen here", "A keyboard on this device types on $name. The Keyboard button opens the soft keyboard", first = true)
    }
}

// ---- Clipboard ----

@Composable
private fun ClipboardPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val name = them(core)
    val me = core.store.deviceName
    val ctx = LocalContext.current
    PageHead("Clipboard", "Copy on one, paste on the other.")
    if (core.host == null) NotConnected(core, v)
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow("Copies on $name land here", "At once", core.sync.get("clipboard", "in"), first = true) { core.sync.set("clipboard", "in", it) }
    }
    MacCard {
        DirHead(me, true, name, false)
        SwitchRow("Copies here go to $name", "While TwinDesk is open, or always with wireless debugging", core.sync.get("clipboard", "out"), first = true) { core.sync.set("clipboard", "out", it) }
        if (core.host != null) MacRow("Send the clipboard now", "Also: the Send clipboard tile in Quick Settings") { Secondary("Send") { core.clip.sendCurrent(true) } }
    }
    if (core.clip.history.isNotEmpty()) MacCard("Recent") {
        core.clip.history.toList().take(12).forEachIndexed { i, (dir, text) ->
            MacRow(text.replace('\n', ' ').take(120), if (dir == "in") "From $name · tap to copy" else "To $name · tap to copy", first = i == 0, onClick = {
                ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("TwinDesk", text))
            })
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
    PageHead("Notifications", "See each other’s notifications.")
    if (core.host == null) NotConnected(core, v)
    if (!core.notifs.supported) Note(
        "This build of TwinDesk can’t read this device’s notifications: Android’s Play Protect blocks downloaded apps that can. " +
            "$name installs TwinDesk with notifications for you once wireless debugging is set up: on $name, Phone page › Install. Your settings and pairing stay.",
        "warn",
    )
    else if (!core.notifs.hasAccess) Note("Allow Notification access so this device’s notifications can go to $name.", "warn")
    MacCard {
        DirHead(me, true, name, false)
        SwitchRow("Show this device’s notifications on $name", "${core.notifs.sent} sent", core.sync.get("notifs", "out"), first = true) { core.sync.set("notifs", "out", it) }
        SwitchRow("Hide the message text", "Only the app and title go to $name", core.store.flag("notifs.hideText", false)) { core.store.setFlag("notifs.hideText", it); core.changed() }
        if (core.notifs.supported && !core.notifs.hasAccess) MacRow("Notification access", "Needed to read them") { Primary("Allow") { ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) } }
        if (!core.notifs.supported && !core.adb.paired) MacRow("Wireless debugging", "Set it up first, then install from $name") { Primary("Guide") { Guide.open.value = true } }
    }
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow("Show $name’s notifications here", "${core.notifs.shown} shown", core.sync.get("notifs", "in"), first = true) { core.sync.set("notifs", "in", it) }
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
    PageHead("Files", "Send files, copy and paste them, drag them across.")
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
        MacRow("Send files", "They land in $name’s Downloads. From any app: Share › $name", first = true) { Primary("Choose…") { pick.launch("*/*") } }
        MacRow("Copy files", "Paste them on $name with ⌃⌥V, where you want them") { Secondary("Choose…") { pickCopy.launch("*/*") } }
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
            Modifier.padding(16.dp).fillMaxWidth().height(100.dp).clip(RoundedCornerShape(10.dp))
                .border(2.dp, if (over) pal.accent else pal.faint.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
                .background(if (over) pal.accentSoft else Color.Transparent)
                .dragAndDropTarget(shouldStartDragAndDrop = { ev -> ev.mimeTypes().isNotEmpty() }, target = target),
            contentAlignment = Alignment.Center,
        ) { Text(if (over) "Drop to send to $name" else "Drag files here to send them to $name", color = pal.muted) }
    }
    MacCard("From $name") {
        MacRow("Drag across the edge", "Files dragged onto this device land in Downloads › TwinDesk", first = true)
        MacRow("⌃⌥C on $name", "This device offers to copy them to its clipboard or save them")
        MacRow("Drop on the phone window", "Files dropped on this device’s window on $name come here")
    }

    val moving = core.files.sending.map { "Sending ${it.name}" to Files.pct(it.sent, it.bytes) } +
        core.files.receiving.map { "Receiving ${Files.plural(it.count, "file")}" to Files.pct(it.got, it.bytes) }
    if (moving.isNotEmpty() || core.fclip.status.isNotEmpty()) MacCard("Now") {
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
    PageHead("Sound", "Hear one on the other.")
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
    Note("Sound that comes with the screen plays in the screen view (Screen › Playback).")
}

// This device's sound there: through wireless debugging, else captured here (Sound.kt).
private fun soundHint(core: Core) = when {
    core.sound.on -> "Playing there (captured here: Stop in the notification)"
    core.sound.error.isNotEmpty() -> core.sound.error
    else -> "Through wireless debugging, else TwinDesk captures it (Start, each time)"
}

// The computer is waiting for the capture: Start here, as in the notification.
@Composable
private fun SoundStart(core: Core) {
    val ctx = LocalContext.current
    if (core.sound.wanted && !core.sound.on) MacRow("Start the sound", "Android asks to allow the capture") { Primary("Start") { core.sound.start(ctx) } }
    else if (core.sound.on) MacRow("Captured sound", "Plays here too: only wireless debugging moves it off this phone") { Secondary("Stop") { core.sound.stop() } }
}

// ---- General ----

@Composable
private fun GeneralPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val ctx = LocalContext.current
    val name = them(core)
    var dev by remember { mutableStateOf(core.store.deviceName) }
    PageHead("General", "")
    MacCard("This device") {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Name", color = pal.text, fontSize = 15.sp)
            Text("What your computers call it", color = pal.muted, fontSize = 12.5.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(dev, { dev = it }, singleLine = true, modifier = Modifier.weight(1f),
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 15.sp, color = pal.text), shape = RoundedCornerShape(8.dp))
                Secondary("Save") { core.store.setDeviceName(dev); core.changed() }
            }
        }
    }
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
    MacCard("Allow") {
        if (Build.VERSION.SDK_INT >= 33) Setup("Notifications", "Files arriving, invites from $name, and TwinDesk staying connected",
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED, "Allow") {
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // Calls, Messages, Photos and Files on $name (Hub): what each needs, asked here too.
        for ((what, hint) in listOf(
            "calls" to "Answer and make calls on $name",
            "messages" to "Read and send texts on $name",
            "media" to "Your photos and videos on $name",
            "files" to "This device’s storage and shared folders on $name, no ADB",
        )) {
            val perm = core.hub.perm(what)
            if (perm == "none") MacRow(Hub.label(what), if (what == "files") "Needs Android 11 or later" else "Needs TwinDesk with notifications ($name installs it)")
            else Setup(Hub.label(what), if (perm == "partial") "Some access is missing: $hint" else hint, perm == "ok", "Allow") { core.hub.askHere(what) }
        }
        if (core.notifs.supported) Setup("Notification access", "To show this device’s notifications on $name", core.notifs.hasAccess, "Allow") {
            ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } else MacRow("Notification access", "Comes with TwinDesk with notifications, which $name installs (its Phone page)")
        Setup("Run in the background", "So $name can reach this device any time", pm.isIgnoringBatteryOptimizations(ctx.packageName), "Allow") {
            @Suppress("BatteryLife")
            ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
        }
        MacRow(
            "Wireless debugging",
            when {
                core.adb.paired -> "Paired with $name: this screen and sound there, its mouse and keyboard here"
                core.link.ble -> "Only available over Wi-Fi: you’re connected over Bluetooth"
                core.adb.wifiDebugging && !core.adb.setupNeeded -> "Paired with $name, reconnecting…"
                core.adb.wifiDebugging -> "On. Pair it with $name once (the guide walks you through it)"
                else -> "For this screen and sound on $name, and its mouse and keyboard here"
            },
        ) {
            if (core.adb.paired) Pill("Paired", "good")
            else if (core.link.ble) Pill("Wi-Fi only", "muted")
            else {
                if (!core.adb.wifiDebugging) Secondary("Turn on") { core.adb.turnOn() }
                Primary("Guide") { Guide.open.value = true }
            }
        }
        Setup("Nearby devices", "Bluetooth and Wi-Fi Direct, for $name when it isn’t on this network", nearbyAllowed, "Allow") {
            askNearby.launch(nearbyPerms)
        }
        if (core.input.supported) Setup("Mouse and keyboard", "Accessibility: $name’s cursor on this phone without wireless debugging, on any network. Only needed when ADB isn’t used", core.input.on, "Allow") { core.input.openSettings() }
        else MacRow("Mouse and keyboard", "Through wireless debugging. Without it: comes with TwinDesk with notifications, which $name installs (its Phone page)")
        Setup("Show the pointer", "Draws $name’s pointer over other apps", core.pointer.allowed, "Allow") {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        }
        if (Build.VERSION.SDK_INT >= 30) Setup("All files access", "Your wallpaper on $name, Files and shared folders", android.os.Environment.isExternalStorageManager(), "Allow") {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        }
    }
    MacCard("Every device") {
        SwitchRow("Join every device automatically", "When $name is connected to another computer that this device doesn’t know yet, connect to it too: pair once, the whole mesh follows", core.meshAutoJoin, first = true) {
            core.store.setFlag("meshAutoJoin", it); core.changed()
        }
    }
    MacCard("Not on the same network") {
        BleSwitch(core, "Allow Nearby devices above", first = true)
        SwitchRow("Turn off Bluetooth on Wi-Fi connections", if (core.bleWifiOff) "On the same Wi-Fi network as $name (not Wi-Fi Direct), Bluetooth goes off until the connection ends"
            else "Bluetooth stays on beside the Wi-Fi, the way back if it drops", core.bleWifiOff) { core.store.setFlag("bleWifiOff", it); core.changed() }
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
            MacRow(h.name, core.stateOf(h), first = i == 0) {
                if (core.links.existing(h.id)?.connected == true) Pill("Online", "good")
                TextButton(onClick = { core.forget(h.id) }) { Text("Forget", color = pal.bad) }
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
        Text("Use your computer and this device as one desk.", color = pal.muted, modifier = Modifier.padding(top = 6.dp, bottom = 20.dp))
    }
    val ctx = LocalContext.current
    val open = { url: String -> ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    val u = core.updates
    MacCard("Updates") {
        MacRow(
            "TwinDesk",
            when {
                u.state == "downloading" -> "Downloading… ${(u.progress * 100).toInt()}%"
                u.checking -> "Checking…"
                u.error.isNotEmpty() -> "Couldn’t update: ${u.error}"
                u.available -> "${u.latest}${if (u.prerelease) " (beta)" else ""} is available. You have ${u.current}. " +
                    (u.download?.let { "Updates in place; your settings and permissions stay (Android asks you to confirm)" } ?: "Opens the release page")
                u.noReleases -> "Version ${u.current}. No releases published yet"
                u.checkedAt > 0 -> "Up to date · checked " + java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(u.checkedAt))
                else -> "Version ${u.current}"
            },
            first = true,
        ) {
            if (u.available && u.state != "downloading") Primary(if (u.download != null) "Update now" else "Download") { u.install() }
            if (!u.checking && u.state != "downloading") Secondary("Check now") { u.checkNow() }
        }
        SwitchRow("Check automatically", "Looks for new releases on GitHub every few hours", u.auto) { u.auto = it }
        SwitchRow("Beta releases", "Pre-releases from the same project, to try changes early", u.channel == "beta") { u.setBeta(it) }
        MacRow("Update source", "github.com/${u.repo} · ${u.channel} channel")
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
}
