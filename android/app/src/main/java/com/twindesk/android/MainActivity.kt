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
        resumed.value++ // permissions may have changed in Settings
        Core.get(this).adb.check() // back from Settings: is wireless debugging on now?
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // In front: Android lets us read the clipboard now.
        if (hasFocus) Core.get(this).let { if (it.sync.get("clipboard", "out")) it.clip.sendCurrent(false) }
    }
}

private fun grad(a: Long, b: Long) = listOf(Color(a), Color(b))

// The pages, with the Mac's tile colours and groups.
private enum class Tab(val title: String, val icon: ImageVector, val colors: List<Color>, val group: String) {
    Overview("Overview", Ico.overview, grad(0xFF8E8E93, 0xFF636366), ""),
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
    else -> false
} && core.host != null

private fun them(core: Core) = core.host?.name ?: core.hosts().firstOrNull()?.name ?: "the computer"

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
    if (core.adb.off && !adbAsked) {
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                val h = core.host
                Dot(when { h != null -> pal.good; core.pairLink.pair != null || core.link.state == "connecting" -> pal.warn; else -> pal.faint }, 7)
                Text(
                    when {
                        h != null -> h.name + (if (core.link.wired) " · USB" else "") + (core.link.rttMs?.let { " · $it ms" } ?: "")
                        core.pairLink.pair != null -> "Pairing…"
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
                    "code", "waiting" -> {
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
                    else -> Text("Connecting…", color = pal.muted)
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
                    when { host != null -> listOfNotNull(if (link.wired) "USB" else null, link.rttMs?.let { "$it ms" }).joinToString(" · ").ifEmpty { "Connected" }; link.state == "connecting" -> "Connecting…"; pairing.pair != null -> "Pairing…"; else -> "Not connected" },
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
        if (host != null) {
            val show = { core.ctx.startActivity(Intent(core.ctx, ViewerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            if (LocalConfiguration.current.screenWidthDp >= 600) {
                Row(Modifier.fillMaxWidth().padding(bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                    Primary("Show ${host.name}’s screen", show)
                    Secondary("Disconnect") { core.disconnect() }
                }
            } else {
                // A phone: one button per line, inside the card's padding.
                Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = show, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(8.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = pal.accent, contentColor = Color.White)) {
                        Text("Show ${host.name}’s screen", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    OutlinedButton(onClick = { core.disconnect() }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(8.dp)) { Text("Disconnect", color = pal.text) }
                }
            }
        }
    }

    // Wireless debugging, under the connected card, until the computer is paired with it.
    WirelessCard(core, LocalContext.current, v)

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
                SwitchRow("Sound", "Through wireless debugging", core.sync.get("audio", "out"), first = true) { core.sync.set("audio", "out", it) }
                SwitchRow("Clipboard", "", core.sync.get("clipboard", "out")) { core.sync.set("clipboard", "out", it) }
                SwitchRow("Notifications", if (core.notifs.hasAccess) "" else if (!core.notifs.supported) "Needs TwinDesk with notifications (Notifications page)" else "Needs Notification access (General)", core.sync.get("notifs", "out")) { core.sync.set("notifs", "out", it) }
            }
        }
        if (wide) Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) { m2p(Modifier.weight(1f)); p2m(Modifier.weight(1f)) }
        else { m2p(Modifier); p2m(Modifier) }
    }

    MacCard("Nearby") {
        val hosts = core.hosts()
        var first = true
        for (h in hosts) {
            val near = core.discovery.found.containsKey(h.id)
            MacRow(h.name, if (core.links.existing(h.id)?.connected == true) "Connected" else if (core.links.existing(h.id)?.state == "connecting") "Connecting…" else if (near) "Nearby · paired" else "Paired · not nearby", first) {
                if (core.links.existing(h.id)?.connected != true) Primary("Connect") { core.connect(h) }
            }
            first = false
        }
        for (f in core.discovery.list().filter { f -> hosts.none { it.id == f.id } }) {
            MacRow(f.name, "${if (f.os == "mac") "Mac" else if (f.os == "linux") "Linux" else "PC"} · ${f.address}", first) { Secondary("Pair") { core.pair(f) } }
            first = false
        }
        if (first) MacRow("Looking for computers…", "Open TwinDesk on your Mac (same Wi-Fi)", true)
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
    val shared = core.kvm.linked && core.sync.get("cursor", "in")
    PageHead("Cursor", "Move $name’s pointer off the edge of its screen to use this device.", if (host != null) shared else null) {
        if (it && !core.sync.get("cursor", "in")) core.sync.set("cursor", "in", true)
        core.kvm.setLinked(it)
    }
    if (host == null) return NotConnected(core, v)
    Note(
        when {
            !core.adb.wifiDebugging -> "$name moves the pointer here through wireless debugging, which is off."
            !core.pointer.allowed -> "Allow “Show the pointer” in General › Setup to see $name’s pointer here."
            !core.kvm.linked -> "Cursor sharing is off. Double-tap ${core.kvm.hotkey} on $name to turn it on."
            else -> "Push $name’s pointer past its edge to come here. Double-tap ${core.kvm.hotkey} to take everything back."
        },
        if (!core.adb.wifiDebugging || !core.pointer.allowed) "warn" else "info",
    )
    if (!core.adb.wifiDebugging || core.adb.setupNeeded) Row(Modifier.padding(bottom = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!core.adb.wifiDebugging) Primary("Turn on wireless debugging") { core.adb.turnOn() }
        if (core.adb.setupNeeded) Secondary("Set up") { Guide.open.value = true }
    }
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow("Use $name’s mouse and keyboard on $me", "Push the pointer past the edge", core.sync.get("cursor", "in"), first = true) { core.sync.set("cursor", "in", it) }
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
    MacCard {
        DirHead(name, false, me, true)
        SwitchRow("Play $name’s sound here", if (core.macSound.playing) "Playing" else "", core.sync.get("audio", "in"), first = true) { core.sync.set("audio", "in", it) }
    }
    MacCard {
        DirHead(me, true, name, false)
        SwitchRow("Play this device’s sound on $name", "Through wireless debugging · Android 11 or later", core.sync.get("audio", "out"), first = true) { core.sync.set("audio", "out", it) }
    }
    Note("Sound that comes with the screen plays in the screen view (Screen › Playback).")
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
    MacCard("Setup") {
        if (core.notifs.supported) Setup("Notification access", "To show this device’s notifications on $name", core.notifs.hasAccess, "Allow", first = true) {
            ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } else MacRow("Notification access", "Comes with TwinDesk with notifications, which $name installs (its Phone page)", first = true)
        Setup("Run in the background", "So $name can reach this device any time", pm.isIgnoringBatteryOptimizations(ctx.packageName), "Allow") {
            @Suppress("BatteryLife")
            ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
        }
        MacRow(
            "Wireless debugging",
            when {
                core.adb.paired -> "Paired with $name: this screen and sound there, its mouse and keyboard here"
                core.adb.wifiDebugging && !core.adb.setupNeeded -> "Paired with $name, reconnecting…"
                core.adb.wifiDebugging -> "On. Pair it with $name once (the guide walks you through it)"
                else -> "For this screen and sound on $name, and its mouse and keyboard here"
            },
        ) {
            if (core.adb.paired && core.adb.wifiDebugging) Pill("Paired", "good")
            else {
                if (!core.adb.wifiDebugging) Secondary("Turn on") { core.adb.turnOn() }
                Primary("Guide") { Guide.open.value = true }
            }
        }
        Setup("Show the pointer", "Draws $name’s pointer over other apps", core.pointer.allowed, "Allow") {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        }
        if (Build.VERSION.SDK_INT >= 30) Setup("Wallpaper on $name", "Optional. Android shares the wallpaper only with All files access", android.os.Environment.isExternalStorageManager(), "Allow") {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        }
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
