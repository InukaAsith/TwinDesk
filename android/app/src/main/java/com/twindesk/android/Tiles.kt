// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Overview's shortcuts: what people do with the computer in a tap (its screen, voice typing,
// the touchpad, send files, play and pause, lock…), as tiles the way Control Center has them.
// One or two rows that scroll sideways; each tile small (one cell), wide (two across) or, with two
// rows, large (two by two). Edit: add and remove them, size them, move them earlier or later, one
// row or two. Kept on this phone ("overview.tiles"), as the gamepad keeps its layout.
// The same tiles, sizes and packing as the iPhone app's (ios/TwinDesk/UI/Tiles.swift) and the
// computers' Overview of a phone (shared/ui-device-parts.js, D.tiles).
package com.twindesk.android

import android.content.Intent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONArray
import org.json.JSONObject

object Tiles {
    // A tile in the layout: its shortcut and size ("s" small, "w" wide, "b" large).
    data class Item(val id: String, val size: String)
    data class Layout(val rows: Int, val items: List<Item>)
    // Where a tile lands: its column and row, and how many of each it covers.
    data class Placed(val item: Item, val col: Int, val row: Int, val w: Int, val h: Int)

    private const val KEY = "overview.tiles"
    // One row of four; the rest under Edit › Add.
    val DEFAULT = Layout(1, listOf(Item("screen", "s"), Item("voice", "s"), Item("touchpad", "s"), Item("files", "s")))

    fun load(store: Store): Layout = runCatching {
        val o = JSONObject(store.prefsString(KEY, ""))
        val a = o.getJSONArray("items")
        Layout(if (o.optInt("rows", 1) == 2) 2 else 1, (0 until a.length()).map { a.getJSONObject(it) }
            .map { Item(it.getString("id"), it.optString("s", "s").takeIf { s -> s in listOf("s", "w", "b") } ?: "s") }
            .distinctBy { it.id })
    }.getOrDefault(DEFAULT)

    fun save(store: Store, l: Layout) = store.setPrefsString(KEY, JSONObject()
        .put("rows", l.rows)
        .put("items", JSONArray(l.items.map { JSONObject().put("id", it.id).put("s", it.size) })).toString())

    fun reset(store: Store) = store.setPrefsString(KEY, "")

    // Column by column, each tile in the first place it fits, in order: a large tile with one row
    // is a wide one. The computers and the iPhone pack the same way.
    fun pack(items: List<Item>, rows: Int): List<Placed> {
        val taken = HashSet<Pair<Int, Int>>()
        return items.map { it ->
            val w = if (it.size == "s") 1 else 2
            val h = if (it.size == "b" && rows == 2) 2 else 1
            var col = 0
            var spot: Pair<Int, Int>? = null
            while (spot == null) {
                for (r in 0..(rows - h)) {
                    if ((0 until w).all { dx -> (0 until h).all { dy -> (col + dx to r + dy) !in taken } }) { spot = col to r; break }
                }
                if (spot == null) col++
            }
            for (dx in 0 until w) for (dy in 0 until h) taken += (spot.first + dx to spot.second + dy)
            Placed(it, spot.first, spot.second, w, h)
        }
    }
}

// A shortcut: its words, icon and colours; whether this computer has it; on (a switch that's on,
// something playing); the line under its name; what a tap does.
private class Def(
    val id: String, val label: String, val icon: ImageVector, val colors: List<Color>,
    val has: () -> Boolean = { true }, val on: () -> Boolean = { false }, val state: () -> String = { "" }, val run: () -> Unit,
)

private fun g(a: Long, b: Long) = listOf(Color(a), Color(b))

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TilesCard(core: Core) {
    @Suppress("UNUSED_VARIABLE") val v = core.version.collectAsState().value // redraw on every Core change
    val host = core.host ?: return
    val ctx = LocalContext.current
    val name = host.name
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty()) core.files.send(core.files.describe(uris), "send") }
    val c = core.dev.computer
    val can = c?.optJSONObject("can")
    val toast = { text: String -> Toast.makeText(ctx, text, Toast.LENGTH_SHORT).show() }
    val remote = { mode: String -> ctx.startActivity(Intent(ctx, RemoteActivity::class.java).putExtra("mode", mode)) }
    val page = { tab: String -> MainActivity.openTab.value = tab }
    val now = core.pcMedia.now
    val defs = listOf(
        Def("screen", tr("Its screen"), Ico.display, g(0xFF5AC8FA, 0xFF0A84FF), state = { name }) {
            ctx.startActivity(Intent(ctx, ViewerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        },
        Def("voice", tr("Voice typing"), Ico.mic, g(0xFFFF6482, 0xFFFF2D55), state = { tr("Speak, it types on {name}", "name" to name) }) { remote("voice") },
        Def("touchpad", tr("Touchpad"), Ico.touchpad, g(0xFFFFB340, 0xFFFF9500), state = { tr("And keyboard") }) { remote("pad") },
        Def("gamepad", tr("Gamepad"), Ico.gamepad, g(0xFFBF5AF2, 0xFF8944AB), state = { tr("Keys or a controller") }) { remote("gamepad") },
        Def("files", tr("Send files"), Ico.send, g(0xFF64D2FF, 0xFF0A84FF), state = { tr("To Downloads") }) { pick.launch("*/*") },
        Def("clipboard", tr("Send clipboard"), Ico.clipboard, g(0xFF64D2FF, 0xFF30B0C7), state = { tr("What’s copied here") }) {
            toast(if (core.clip.sendCurrent(true)) tr("Clipboard sent to {name}", "name" to name) else tr("Nothing to send on the clipboard"))
        },
        Def("media", if (now?.playing == true) tr("Pause") else tr("Play"), if (now?.playing == true) Ico.pause else Ico.play, g(0xFFFF6482, 0xFFBF5AF2),
            on = { now?.playing == true }, state = { now?.let { listOf(it.title, it.artist).filter { s -> s.isNotEmpty() }.joinToString(" · ") } ?: tr("Nothing playing") },
        ) { core.pcMedia.control("toggle") },
        Def("next", tr("Next track"), Ico.next, g(0xFFFF6482, 0xFFBF5AF2), state = { now?.title ?: "" }) { core.pcMedia.control("next") },
        Def("lock", tr("Lock"), Ico.lock, g(0xFF8E8E93, 0xFF48484A), has = { can?.optBoolean("lock") == true }, state = { name }) { core.dev.ask("lock") },
        Def("sleep", tr("Sleep"), Ico.sleep, g(0xFF7D7AFF, 0xFF5856D6), has = { can?.optBoolean("sleep") == true }, state = { name }) { core.dev.ask("sleep") },
        Def("ring", if (c?.optBoolean("ringing") == true) tr("Stop ringing") else tr("Ring"), Ico.bell, g(0xFFFF6961, 0xFFFF3B30), has = { can?.optBoolean("ring") == true },
            on = { c?.optBoolean("ringing") == true }, state = { tr("Find {name}", "name" to name) }) { core.dev.ask(if (c?.optBoolean("ringing") == true) "ringStop" else "ring") },
        Def("dnd", tr("Do not disturb"), Ico.dnd, g(0xFF7D7AFF, 0xFF5856D6), has = { can?.optBoolean("dnd") == true && c?.has("dnd") == true },
            on = { c?.optBoolean("dnd") == true }, state = { if (c?.optBoolean("dnd") == true) tr("On") else tr("Off") }) { core.dev.ask("dnd", "on" to (c?.optBoolean("dnd") != true)) },
        Def("bluetooth", tr("Bluetooth"), Ico.bluetooth, g(0xFF5AC8FA, 0xFF0A84FF), has = { can?.optBoolean("bluetooth") == true && c?.has("bluetooth") == true },
            on = { c?.optBoolean("bluetooth") == true }, state = { if (c?.optBoolean("bluetooth") == true) tr("On") else tr("Off") }) { core.dev.ask("bluetooth", "on" to (c?.optBoolean("bluetooth") != true)) },
        Def("sound", tr("Sound"), Ico.audio, g(0xFFFF6482, 0xFFFF2D55), on = { core.sync.get("audio", "in") }, state = { if (core.sync.get("audio", "in")) tr("Playing here") else tr("{name}’s sound", "name" to name) }) { page("Sound") },
        Def("camera", tr("Webcam"), Ico.camera, g(0xFFBF5AF2, 0xFF8944AB), on = { core.adb.camera.on }, state = { tr("This camera on {name}", "name" to name) }) { page("Camera") },
        Def("mouse", tr("Mouse"), Ico.cursor, g(0xFFFFB340, 0xFFFF9500), state = { tr("{name}’s mouse here", "name" to name) }) { page("Cursor") },
        Def("notifications", tr("Notifications"), Ico.bell, g(0xFFFF6961, 0xFFFF3B30), state = { tr("Both ways") }) { page("Notifications") },
    )
    val byId = defs.associateBy { it.id }

    var layout by remember { mutableStateOf(Tiles.load(core.store)) }
    var editing by rememberSaveable { mutableStateOf(false) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    val set = { l: Tiles.Layout -> layout = l; Tiles.save(core.store, l) }
    // What shows: the shortcuts this computer has (editing shows the rest greyed, to keep their place).
    val shown = layout.items.filter { byId[it.id]?.let { d -> editing || d.has() } == true }

    MacCard(tr("Shortcuts"), action = {
        TextButton(onClick = { editing = !editing; sel = null }) {
            Text(if (editing) tr("Done") else tr("Edit"), color = pal.accent, fontSize = 14.sp, fontWeight = if (editing) FontWeight.SemiBold else null)
        }
    }) {
        BoxWithConstraints(Modifier.fillMaxWidth().padding(12.dp)) {
            val gap = 10.dp
            val cell = ((maxWidth - gap * 3) / 4).coerceAtMost(120.dp) // four across on a phone
            val placed = Tiles.pack(shown, layout.rows)
            val cols = (placed.maxOfOrNull { it.col + it.w } ?: 0)
            if (placed.isEmpty()) Text(if (editing) tr("Add shortcuts below.") else tr("No shortcuts. Tap Edit to add some."), color = pal.muted, fontSize = 13.sp, modifier = Modifier.padding(8.dp))
            else Box(Modifier.horizontalScroll(rememberScrollState())) {
                Box(Modifier.width(cell * cols + gap * (cols - 1)).height(cell * layout.rows + gap * (layout.rows - 1))) {
                    for (p in placed) {
                        val d = byId[p.item.id] ?: continue
                        TileView(
                            d, p, cell, gap, editing = editing, selected = sel == d.id, missing = !d.has(),
                            onTap = { if (editing) sel = if (sel == d.id) null else d.id else d.run() },
                            onRemove = { set(layout.copy(items = layout.items.filter { it.id != d.id })); if (sel == d.id) sel = null },
                        )
                    }
                }
            }
        }
        if (editing) {
            Line()
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // One row or two.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(tr("Rows"), color = pal.text, fontSize = 15.sp, modifier = Modifier.weight(1f))
                    Segments(listOf("1" to tr("One"), "2" to tr("Two")), layout.rows.toString()) { set(layout.copy(rows = it.toInt())) }
                }
                // The selected tile: earlier, later, its size.
                val cur = sel?.let { id -> layout.items.firstOrNull { x -> x.id == id } }
                if (cur != null) {
                    val d = byId[cur.id]!!
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(d.label, color = pal.text, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        val i = layout.items.indexOf(cur)
                        RoundButton(Ico.left, i > 0) { set(layout.copy(items = layout.items.toMutableList().apply { add(i - 1, removeAt(i)) })) }
                        RoundButton(Ico.right, i < layout.items.size - 1) { set(layout.copy(items = layout.items.toMutableList().apply { add(i + 1, removeAt(i)) })) }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(tr("Size"), color = pal.text, fontSize = 15.sp, modifier = Modifier.weight(1f))
                        // Large needs two rows (a square two by two): with one row, small or wide.
                        val sizes = listOf("s" to tr("Small"), "w" to tr("Wide")) + if (layout.rows == 2) listOf("b" to tr("Large")) else emptyList()
                        Segments(sizes, if (cur.size == "b" && layout.rows == 1) "w" else cur.size) { s ->
                            set(layout.copy(items = layout.items.map { x -> if (x.id == cur.id) x.copy(size = s) else x }))
                        }
                    }
                } else Text(tr("Tap a shortcut to move or resize it, or − to remove it."), color = pal.muted, fontSize = 13.sp)
                // The rest, to add.
                val rest = defs.filter { d -> d.has() && layout.items.none { x -> x.id == d.id } }
                if (rest.isNotEmpty()) {
                    Text(tr("Add"), color = pal.muted, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (d in rest) Row(
                            Modifier.clip(RoundedCornerShape(50)).background(pal.chip.takeIf { x -> x != Color.Transparent } ?: pal.hover)
                                .clickable { set(layout.copy(items = layout.items + Tiles.Item(d.id, "s"))); sel = d.id }
                                .padding(start = 6.dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Tile(d.icon, d.colors, 24)
                            Text(d.label, color = pal.text, fontSize = 13.5.sp)
                            Icon(Ico.plus, null, tint = pal.accent, modifier = Modifier.size(16.dp))
                        }
                    }
                }
                TextButton(onClick = { Tiles.reset(core.store); layout = Tiles.DEFAULT; sel = null }, modifier = Modifier.padding(start = 0.dp)) {
                    Text(tr("Reset to default"), color = pal.bad, fontSize = 14.sp)
                }
            }
        }
    }
}

// One tile: small (the icon over its name), wide (the icon beside its name and line) or large (the
// icon big at the top, the name and its line at the bottom). On: the accent behind it, in white.
@Composable
private fun TileView(d: Def, p: Tiles.Placed, cell: Dp, gap: Dp, editing: Boolean, selected: Boolean, missing: Boolean, onTap: () -> Unit, onRemove: () -> Unit) {
    val dark = pal.text.luminance() > 0.5f
    val on = d.on()
    val bg = if (on) pal.accent else if (dark) Color.White.copy(alpha = 0.07f) else Color.Black.copy(alpha = 0.04f)
    val fg = if (on) Color.White else pal.text
    val sub = if (on) Color.White.copy(alpha = 0.8f) else pal.muted
    val w = cell * p.w + gap * (p.w - 1)
    val h = cell * p.h + gap * (p.h - 1)
    val state = d.state()
    Box(Modifier.offset(x = (cell + gap) * p.col, y = (cell + gap) * p.row).size(w, h)) {
        Box(
            Modifier.fillMaxSize().clip(RoundedCornerShape(22.dp)).background(bg)
                .then(if (selected) Modifier.border(2.dp, pal.accent, RoundedCornerShape(22.dp)) else Modifier)
                .clickable(onClick = onTap).padding(if (p.w == 1) 8.dp else 14.dp),
        ) {
            val alpha = if (missing) 0.4f else 1f
            when {
                p.w == 1 -> Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Badge(d, on, 38, alpha)
                    Spacer(Modifier.height(7.dp))
                    Text(d.label, color = fg.copy(alpha = alpha), fontSize = 11.5.sp, lineHeight = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center, fontWeight = FontWeight.Medium)
                }
                p.h == 1 -> Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Badge(d, on, 40, alpha)
                    Column(Modifier.weight(1f)) {
                        Text(d.label, color = fg.copy(alpha = alpha), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (state.isNotEmpty()) Text(state, color = sub.copy(alpha = alpha), fontSize = 11.5.sp, lineHeight = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
                else -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.SpaceBetween) {
                    Badge(d, on, 52, alpha)
                    Column {
                        Text(d.label, color = fg.copy(alpha = alpha), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (state.isNotEmpty()) Text(state, color = sub.copy(alpha = alpha), fontSize = 12.5.sp, lineHeight = 16.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        // Editing: − in the corner takes it off.
        if (editing) Box(
            Modifier.align(Alignment.TopStart).offset(x = (-4).dp, y = (-4).dp).size(24.dp).clip(CircleShape)
                .background(if (dark) Color(0xFF48484A) else Color(0xFF8E8E93)).clickable(onClick = onRemove),
            contentAlignment = Alignment.Center,
        ) { Icon(Ico.minus, tr("Remove {label}", "label" to d.label), tint = Color.White, modifier = Modifier.size(16.dp)) }
    }
}

// The icon on its gradient, a rounded square (white on the accent while on).
@Composable
private fun Badge(d: Def, on: Boolean, size: Int, alpha: Float) {
    Box(
        Modifier.size(size.dp).clip(RoundedCornerShape((size * 0.3f).dp))
            .background(if (on) Brush.verticalGradient(listOf(Color.White.copy(alpha = 0.28f), Color.White.copy(alpha = 0.18f))) else Brush.verticalGradient(d.colors.map { it.copy(alpha = it.alpha * alpha) })),
        contentAlignment = Alignment.Center,
    ) { Icon(d.icon, null, tint = Color.White, modifier = Modifier.size((size * 0.56f).dp)) }
}

@Composable
private fun Segments(options: List<Pair<String, String>>, value: String, onPick: (String) -> Unit) {
    val dark = pal.text.luminance() > 0.5f
    Row(Modifier.clip(RoundedCornerShape(50)).background(if (dark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.06f)).padding(3.dp)) {
        for ((k, label) in options) {
            val on = k == value
            Box(
                Modifier.clip(RoundedCornerShape(50)).background(if (on) pal.accent else Color.Transparent).clickable { onPick(k) }.padding(horizontal = 14.dp, vertical = 7.dp),
            ) { Text(label, color = if (on) Color.White else pal.text, fontSize = 13.5.sp, fontWeight = if (on) FontWeight.SemiBold else null) }
        }
    }
}

@Composable
private fun RoundButton(icon: ImageVector, enabled: Boolean, onClick: () -> Unit) {
    val dark = pal.text.luminance() > 0.5f
    Box(
        Modifier.size(38.dp).clip(CircleShape).background(if (dark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.06f))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = if (enabled) pal.text else pal.faint, modifier = Modifier.size(20.dp)) }
}

@Composable
private fun Line() = Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(1.dp).background(pal.line))
