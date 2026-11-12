// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck (shared/deck.js on the computer): tiles here that the computer runs — shortcuts, text,
// media, sound, Bluetooth, brightness, windows, apps, websites, the clipboard — in spaces of pages.
// A tile space: pages of tiles of any size, swiped sideways (when the layout allows), sliders that
// set a level live as they're dragged. A window space: pick a running app, swipe to one of the
// layouts drawn on the computer and tap a zone, or send the window to another display.
// The computer keeps the layout (shared/deck-model.js); the phone edits a tile's action, look and
// size and adds or removes tiles and pages (deck.save). Moving tiles by dragging and drawing
// window layouts happen on the computer's Deck page. Paths of files and scripts never come here.
// Only when the computer offers it (deck.offer) and this phone's Deck module is on (Modules.kt).
package com.twindesk.android

import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalContext
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt

class Deck(core: Core) : Feature(core) {
    class App(val id: String, val name: String)

    private val main = Handler(Looper.getMainLooper())
    // Compose state, written on the main thread: whatever reads a field redraws when it changes
    // (the page's parts are skipped when their arguments are the same objects).
    var offered by mutableStateOf(false); private set
    var layout by mutableStateOf<JSONObject?>(null); private set
    var can by mutableStateOf<Set<String>>(emptySet()); private set
    var caps by mutableStateOf<JSONObject?>(null); private set
    var platform by mutableStateOf(""); private set
    var apps by mutableStateOf<List<App>?>(null); private set
    // Levels, devices and switches on the computer (deck.state): volume, muted, outputs, bt, displays…
    var state by mutableStateOf<JSONObject?>(null); private set
    // The window space's running apps, their windows and the displays (deck.wins).
    var wins by mutableStateOf<JSONObject?>(null); private set
    // The last tile's answer: its id and why it didn't run ("" when it did).
    var done by mutableStateOf<Pair<String, String>?>(null); private set

    val mac get() = platform == "mac"
    val spaces: List<JSONObject> get() = layout?.optJSONArray("spaces").objs()
    val swipePages get() = layout?.optJSONObject("swipe")?.optBoolean("pages", true) ?: true
    val swipeSpaces get() = layout?.optJSONObject("swipe")?.optBoolean("spaces", true) ?: true
    // How the full-screen Deck is held (layout.orient, set on the computer's Deck page or here): landscape unless portrait.
    val portrait get() = layout?.optString("orient") == "portrait"

    private fun reset() { offered = false; layout = null; apps = null; state = null; wins = null; done = null }
    override fun onWelcome(host: Host) { main.post { reset(); core.changed() } }
    override fun onClosed() { main.post { reset(); core.changed() } }

    override fun onMessage(t: String, m: JSONObject): Boolean {
        when (t) {
            Proto.T.DECK_OFFER -> main.post { offered = true; core.send(msg(Proto.T.DECK_HELLO)); core.changed() }
            Proto.T.DECK_LAYOUT -> main.post {
                val c = m.optJSONArray("can") ?: JSONArray()
                layout = m.optJSONObject("layout")
                can = (0 until c.length()).map { c.optString(it) }.toSet()
                caps = m.optJSONObject("caps")
                platform = m.str("platform", 10).ifEmpty { if (m.optBoolean("mac")) "mac" else "" }
                core.changed()
            }
            Proto.T.DECK_DONE -> main.post { done = m.str("id", 40) to (if (m.optBoolean("ok")) "" else m.str("why", 300)); core.changed() }
            Proto.T.DECK_STATE -> main.post { m.optJSONObject("state")?.let { state = it; core.changed() } }
            Proto.T.DECK_WINS -> main.post { wins = m; core.changed() }
            Proto.T.DECK_APPS -> main.post {
                apps = m.optJSONArray("apps").objs().map { App(it.str("id", 500), it.str("name", 80)) }
                core.changed()
            }
            Proto.T.DECK_CLIP -> main.post {
                runCatching { core.ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("TwinDesk", m.str("text", 100000))) }
                Toast.makeText(core.ctx, tr("Copied from {name}", "name" to (core.host?.name ?: "")), Toast.LENGTH_SHORT).show()
            }
            else -> return false
        }
        return true
    }

    fun run(id: String) { done = null; core.send(msg(Proto.T.DECK_RUN, "id" to id)) }
    fun set(id: String, value: Float) = core.send(msg(Proto.T.DECK_SET, "id" to id, "value" to value.toDouble()))
    fun askState() = core.send(msg(Proto.T.DECK_STATE))
    fun askWins() = core.send(msg(Proto.T.DECK_WINS))
    fun askApps() { if (apps == null) core.send(msg(Proto.T.DECK_APPS)) }
    fun place(wid: Long, display: String, zone: JSONObject?) {
        done = null
        core.send(if (zone != null) msg(Proto.T.DECK_PLACE, "wid" to wid, "display" to display, "zone" to zone) else msg(Proto.T.DECK_PLACE, "wid" to wid, "display" to display))
    }

    // Edited here: shown at once; the computer keeps its own paths, normalizes it and sends it back.
    fun save(l: JSONObject) { layout = l; core.changed(); core.send(msg(Proto.T.DECK_SAVE, "layout" to l)) }
    fun edit(fn: (JSONObject) -> Unit) {
        val l = JSONObject((layout ?: return).toString())
        fn(l)
        save(l)
    }

    // A tile by its id, wherever it is: the tile, its page and its space.
    fun find(id: String): Triple<JSONObject, JSONObject, JSONObject>? {
        for (s in spaces) for (p in s.optJSONArray("pages").objs()) for (t in p.optJSONArray("tiles").objs()) if (t.optString("id") == id) return Triple(t, p, s)
        return null
    }

    // Whether the computer can run this action (its kind, and the entry's needs).
    fun runs(a: JSONObject): Boolean {
        val k = a.optString("k")
        if (k == "nav" || k == "none") return true
        if (k == "widget") return DeckCatalog.entry(a)?.let { DeckCatalog.available(it, caps, platform) == null } ?: true
        if (k !in can) return false
        val e = DeckCatalog.entry(a) ?: return true
        return DeckCatalog.available(e, caps, platform) == null
    }
}

fun JSONArray?.objs(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
private fun JSONArray.removeWhere(fn: (JSONObject) -> Boolean) { for (i in length() - 1 downTo 0) if (optJSONObject(i)?.let(fn) == true) remove(i) }

internal val DECK_COLORS = listOf("#2c2c2e", "#0a84ff", "#30b94d", "#ff9f0a", "#ff3b30", "#bf5af2", "#5e5ce6", "#64d2ff", "#ff2d55", "#ffd60a", "#a2845e", "#8e8e93")
internal fun deckColor(hex: String): Color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(Color(0xFF2C2C2E))
private fun newId(p: String) = p + System.currentTimeMillis().toString(36) + (0..1295).random().toString(36)
private const val ZONE_GRID = 12

// What a tile is called: its label, or the action's name.
internal fun deckLabel(t: JSONObject, platform: String): String =
    t.str("label", 40).ifEmpty { DeckCatalog.entry(t.optJSONObject("action"))?.name(platform)?.let { tr(it) } ?: "" }
internal fun deckIcon(t: JSONObject): String = t.str("icon", 16).ifEmpty { DeckCatalog.symbolOf(t.optJSONObject("action")) }

// The line under a tile's name: a level, a device, on or off.
private fun stateText(a: JSONObject, s: JSONObject?): String {
    s ?: return ""
    val pct = { v: Double -> "${(v * 100).roundToInt()}%" }
    val w = a.optString("what")
    return when (a.optString("k")) {
        "slider" -> level(a, s)?.let { pct(it.toDouble()) } ?: ""
        "volume" -> if (w == "toggle" || w == "mute" || w == "unmute") (if (s.optBoolean("muted")) tr("Muted") else pct(s.optDouble("volume", 0.0))) else ""
        "mic" -> if (s.optBoolean("micMuted")) tr("Muted") else tr("Live")
        "output", "input" -> s.optJSONArray(if (a.optString("k") == "output") "outputs" else "inputs").objs()
            .firstOrNull { d -> if (a.optString("id").isNotEmpty()) d.optString("id") == a.optString("id") else d.optBoolean("on") }?.str("name", 60) ?: ""
        "bt" -> {
            val bt = s.optJSONObject("bt") ?: return ""
            if (a.optString("id").isNotEmpty()) bt.optJSONArray("devices").objs().firstOrNull { it.optString("id") == a.optString("id") }
                ?.let { if (it.optBoolean("connected")) tr("Connected") else tr("Not connected") } ?: ""
            else if (bt.optBoolean("radio")) tr("On") else tr("Off")
        }
        "sys" -> if (w == "darkmode") (if (s.optBoolean("dark")) tr("Dark") else tr("Light")) else ""
        else -> ""
    }
}
private fun level(a: JSONObject, s: JSONObject?): Float? {
    s ?: return null
    return when (a.optString("what")) {
        "volume" -> s.optDouble("volume", Double.NaN)
        "mic" -> s.optDouble("micVolume", Double.NaN)
        else -> s.optJSONArray("displays").objs().firstOrNull { d -> a.optString("display").isEmpty() || d.optString("id") == a.optString("display") }?.optDouble("level", Double.NaN) ?: Double.NaN
    }.takeIf { !it.isNaN() }?.toFloat()
}

// Three fingers across the screen: sideways the next or previous page, up or down the next or
// previous space (onSwipe(dx, dy), one of them ±1).
private fun Modifier.threeFingerSwipe(enabled: Boolean, onSwipe: (Int, Int) -> Unit) = if (!enabled) this else pointerInput(Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var start: androidx.compose.ui.geometry.Offset? = null
        var fired = false
        while (true) {
            val e = awaitPointerEvent(PointerEventPass.Initial)
            val down = e.changes.filter { it.pressed }
            if (down.isEmpty()) break
            if (down.size >= 3) {
                val at = androidx.compose.ui.geometry.Offset(down.map { it.position.x }.average().toFloat(), down.map { it.position.y }.average().toFloat())
                if (start == null) start = at
                e.changes.forEach { it.consume() } // the page swipe and the tiles under it don't move too
                val dx = at.x - start.x; val dy = at.y - start.y
                if (!fired && maxOf(abs(dx), abs(dy)) > 110f) {
                    fired = true
                    if (abs(dx) >= abs(dy)) onSwipe(if (dx < 0) 1 else -1, 0) else onSwipe(0, if (dy < 0) 1 else -1)
                }
            } else if (start != null) e.changes.forEach { it.consume() }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
// The Deck page: its settings and Open Deck. The tiles themselves open full screen (DeckActivity).
@Composable
fun DeckPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change
    val d = core.deck
    val ctx = LocalContext.current
    val name = core.host?.name ?: ""
    PageHead(tr("Deck"), tr("Tiles that run shortcuts, media, sound, windows and more on {name}", "name" to name))
    if (d.layout == null || d.spaces.isEmpty()) {
        Text(tr("Waiting for {name}…", "name" to name), color = pal.muted)
        return
    }
    androidx.compose.material3.Button(
        onClick = { DeckActivity.open(ctx) }, shape = RoundedCornerShape(14.dp),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = pal.accent, contentColor = Color.White),
        modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp).height(52.dp),
    ) {
        Icon(Ico.deck, null, modifier = Modifier.size(18.dp))
        Text(tr("Open Deck"), fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 8.dp))
    }
    var pinned by remember { mutableStateOf(Tiles.has(core.store, "deck")) }
    MacCard(tr("Settings")) {
        MacRow(tr("Hold the phone"), tr("The Deck opens full screen this way up. Also set on {name}’s Deck page.", "name" to name), first = true) {
            val portrait = d.portrait
            SingleChoiceSegmentedButtonRow {
                listOf(false to tr("Landscape"), true to tr("Portrait")).forEachIndexed { i, (p, label) ->
                    SegmentedButton(selected = portrait == p, onClick = { d.edit { it.put("orient", if (p) "portrait" else "landscape") } },
                        shape = SegmentedButtonDefaults.itemShape(i, 2)) { Text(label, maxLines = 1) }
                }
            }
        }
        SwitchRow(tr("Swipe between pages"), tr("Off: switch pages with the page bar, or a Go to page tile"), d.swipePages) { on ->
            d.edit { l -> (l.optJSONObject("swipe") ?: JSONObject().also { l.put("swipe", it) }).put("pages", on) }
        }
        SwitchRow(tr("Three-finger swipes"), tr("Sideways for the next or previous page, up or down for the next or previous space"), d.swipeSpaces) { on ->
            d.edit { l -> (l.optJSONObject("swipe") ?: JSONObject().also { l.put("swipe", it) }).put("spaces", on) }
        }
        SwitchRow(tr("Open Deck on the Overview"), tr("A shortcut among the Overview’s tiles"), pinned) { on -> Tiles.set(core.store, "deck", on); pinned = on }
    }
    Note(tr("The Deck opens full screen and keeps the screen on. Swipe with three fingers to change page or space; tap × in its corner to close it."))
    DeckEditor(core, d)
}

// The tiles to set up, on the Deck page (the full-screen Deck has no Edit): a space, its pages,
// tap a tile or an empty place. Moving and resizing by dragging stays on the computer's Deck page.
@Composable
private fun DeckEditor(core: Core, d: Deck) {
    val spaces = d.spaces.filter { it.optString("kind") != "windows" }
    if (spaces.isEmpty()) return
    var spaceId by rememberSaveable { mutableStateOf(spaces.first().optString("id")) }
    val space = spaces.firstOrNull { it.optString("id") == spaceId } ?: spaces.first()
    val pageOf = remember { mutableStateMapOf<String, String>() }
    MacCard(tr("Tiles")) {
        Column(Modifier.padding(12.dp)) {
            if (spaces.size > 1) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (s in spaces) {
                    val on = s === space
                    Box(Modifier.clip(RoundedCornerShape(50)).background(if (on) pal.accent else pal.card).clickable { spaceId = s.optString("id") }.padding(horizontal = 12.dp, vertical = 6.dp)) {
                        Text(s.str("name", 30), color = if (on) Color.White else pal.text, fontSize = 13.sp, maxLines = 1)
                    }
                }
            }
            TileSpace(core, d, space, pageOf, editing = true, full = false) { }
        }
    }
}

// The Deck full screen (DeckActivity): only the tiles, every bit of the screen, and a faint × in a
// corner. Three fingers sideways turn the page, up or down change the space; the name shows a moment.
@Composable
fun DeckFull(core: Core, close: () -> Unit) {
    val v by core.version.collectAsState()
    @Suppress("UNUSED_EXPRESSION") v
    val d = core.deck
    val spaces = d.spaces
    Box(Modifier.fillMaxSize().background(pal.content).windowInsetsPadding(WindowInsets.safeDrawing).padding(6.dp)) {
        if (d.layout == null || spaces.isEmpty()) {
            Text(tr("Waiting for {name}…", "name" to (core.host?.name ?: "")), color = pal.muted, modifier = Modifier.align(Alignment.Center))
            CloseButton(Modifier.align(Alignment.TopEnd), close)
            return@Box
        }
        // Levels, devices and the computer's use for the tiles, while it shows.
        LaunchedEffect(Unit) { while (true) { d.askState(); delay(3000) } }
        var spaceId by rememberSaveable { mutableStateOf(spaces.first().optString("id")) }
        val space = spaces.firstOrNull { it.optString("id") == spaceId } ?: spaces.first()
        val pageOf = remember { mutableStateMapOf<String, String>() } // each space's page
        var step by remember { mutableStateOf(0 to 0) } // a three-finger page turn: (count, direction)
        var flash by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(flash) { if (flash != null) { delay(900); flash = null } }
        val toSpace = { to: JSONObject -> spaceId = to.optString("id"); flash = to.str("name", 30) }
        val swipe = { dx: Int, dy: Int ->
            val i = spaces.indexOf(space)
            if (dy != 0) spaces.getOrNull(i + dy)?.let(toSpace)
            else if (space.optString("kind") != "windows") step = (step.first + 1) to dx
        }
        val swipeNow by rememberUpdatedState(swipe) // the detector outlives recompositions
        Column(Modifier.fillMaxSize().threeFingerSwipe(d.swipeSpaces) { dx, dy -> swipeNow(dx, dy) }) {
            if (space.optString("kind") == "windows") Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(top = 30.dp)) { WindowSpace(d, space) }
            else TileSpace(core, d, space, pageOf, editing = false, full = true, step = step, onPage = { flash = it }) { to -> spaces.firstOrNull { it.optString("id") == to }?.let(toSpace) }
            d.done?.second?.takeIf { it.isNotEmpty() && it != "busy" }?.let { Text(tr(it), color = pal.bad, fontSize = 12.sp, maxLines = 1, modifier = Modifier.padding(top = 4.dp)) }
        }
        CloseButton(Modifier.align(Alignment.TopEnd).alpha(0.55f), close)
        flash?.let {
            Box(Modifier.align(Alignment.Center).clip(RoundedCornerShape(14.dp)).background(Color.Black.copy(alpha = 0.7f)).padding(horizontal = 18.dp, vertical = 10.dp)) {
                Text(it, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

// The small × in the full-screen Deck's corner.
@Composable
private fun CloseButton(m: Modifier, close: () -> Unit) = Box(
    m.size(30.dp).clip(CircleShape).background(pal.card).clickable(onClick = close), contentAlignment = Alignment.Center,
) { Icon(Ico.close, tr("Close"), tint = pal.text, modifier = Modifier.size(14.dp)) }

// The Deck full screen: no bars, the screen kept on, held the way the computer's Deck says
// (landscape unless it's set to portrait), as the gamepad is held sideways.
class DeckActivity : ComponentActivity() {
    companion object {
        fun open(ctx: Context) = ctx.startActivity(Intent(ctx, DeckActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun hold(portrait: Boolean) {
        val want = if (portrait) ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        if (requestedOrientation != want) requestedOrientation = want
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val core = Core.get(this)
        hold(core.deck.portrait)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        setContent {
            Theme {
                val v by core.version.collectAsState()
                @Suppress("UNUSED_EXPRESSION") v
                // Disconnected, or the computer took the Deck away: closed.
                if (core.host == null || !core.deck.offered) LaunchedEffect(Unit) { delay(1500); if (core.host == null || !core.deck.offered) finish() }
                LaunchedEffect(core.deck.portrait) { hold(core.deck.portrait) }
                DeckFull(core) { finish() }
            }
        }
    }

    // What plays on the computer, for a media widget, while the Deck is in front.
    override fun onStart() { super.onStart(); Core.get(this).pcMedia.page(true) }
    override fun onStop() { Core.get(this).pcMedia.page(false); super.onStop() }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ColumnScope.TileSpace(core: Core, d: Deck, space: JSONObject, pageOf: MutableMap<String, String>, editing: Boolean, full: Boolean,
    step: Pair<Int, Int> = 0 to 0, onPage: (String) -> Unit = {}, toSpace: (String) -> Unit) {
    val sid = space.optString("id")
    val pages = space.optJSONArray("pages").objs()
    if (pages.isEmpty()) { Text(tr("No pages"), color = pal.muted); return }
    val idx = pages.indexOfFirst { it.optString("id") == pageOf[sid] }.coerceAtLeast(0)
    val pager = rememberPagerState(initialPage = idx) { pages.size }
    val scope = rememberCoroutineScope()
    val haptic = LocalHapticFeedback.current
    var open by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(pager.currentPage, sid) { pages.getOrNull(pager.currentPage)?.let { pageOf[sid] = it.optString("id") } }
    // A three-finger swipe (DeckFull): the next or previous page, its name shown a moment.
    LaunchedEffect(step.first) {
        if (step.first == 0) return@LaunchedEffect
        val to = pager.currentPage + step.second
        pages.getOrNull(to)?.let { pager.animateScrollToPage(to); onPage(it.str("name", 30)) }
    }
    val toPage = { i: Int -> if (i in pages.indices) scope.launch { pager.animateScrollToPage(i) }; Unit }

    // The pages by name; editing: + adds one.
    if (!full) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        pages.forEachIndexed { i, p ->
            val on = i == pager.currentPage
            Box(Modifier.clip(RoundedCornerShape(50)).background(if (on) pal.text.copy(alpha = 0.14f) else Color.Transparent).border(1.dp, pal.line, RoundedCornerShape(50))
                .clickable { toPage(i) }.padding(horizontal = 12.dp, vertical = 5.dp)) {
                Text(p.str("name", 30), color = pal.text, fontSize = 12.5.sp, maxLines = 1, fontWeight = if (on) FontWeight.SemiBold else null)
            }
        }
        if (editing) Box(Modifier.clip(RoundedCornerShape(50)).border(1.dp, pal.line, RoundedCornerShape(50)).clickable {
            d.edit { l -> spaceIn(l, sid)?.optJSONArray("pages")?.put(JSONObject().put("id", newId("p")).put("name", tr("Page {n}", "n" to (pages.size + 1))).put("cols", 4).put("rows", 4).put("tiles", JSONArray())) }
            scope.launch { delay(50); pager.animateScrollToPage(pages.size) }
        }.padding(horizontal = 12.dp, vertical = 5.dp)) { Text("+", color = pal.text, fontSize = 12.5.sp) }
    }

    // The grid fills the screen: each page's cells as wide and tall as its columns and rows allow.
    BoxWithConstraints(if (full) Modifier.fillMaxWidth().weight(1f) else Modifier.fillMaxWidth()) {
        val gap = 8.dp
        val width = if (full) maxWidth else maxWidth.coerceAtMost(560.dp)
        fun cwOf(p: JSONObject): Dp { val c = p.optInt("cols", 4).coerceIn(2, 8); return (width - gap * (c - 1)) / c }
        // Full screen: as tall as the screen allows. On the Deck page: square cells.
        val height = if (full) maxHeight else pages.maxOf { p -> val r = p.optInt("rows", 4).coerceIn(2, 8); cwOf(p) * r + gap * (r - 1) }
        fun chOf(p: JSONObject): Dp { val r = p.optInt("rows", 4).coerceIn(2, 8); return if (full) (height - gap * (r - 1)) / r else cwOf(p) }
        HorizontalPager(pager, Modifier.width(width).height(height), userScrollEnabled = d.swipePages && !editing, pageSpacing = 24.dp, beyondViewportPageCount = 1) { pi ->
            val p = pages[pi]
            val cols = p.optInt("cols", 4).coerceIn(2, 8)
            val rows = p.optInt("rows", 4).coerceIn(2, 8)
            val cw = cwOf(p)
            val ch = chOf(p)
            val tiles = p.optJSONArray("tiles").objs()
            Box(Modifier.fillMaxSize()) {
                // Editing: the empty places, to add a tile in one.
                if (editing) {
                    val taken = HashSet<Int>()
                    for (t in tiles) for (dx in 0 until t.optInt("w", 1)) for (dy in 0 until t.optInt("h", 1)) taken += (t.optInt("y") + dy) * cols + t.optInt("x") + dx
                    for (r in 0 until rows) for (c in 0 until cols) if (r * cols + c !in taken) Box(
                        Modifier.offset(x = (cw + gap) * c, y = (ch + gap) * r).size(cw, ch).clip(RoundedCornerShape(14.dp))
                            .border(1.dp, pal.line, RoundedCornerShape(14.dp)).clickable {
                                val id = newId("t")
                                d.edit { l -> pageIn(l, p.optString("id"))?.optJSONArray("tiles")?.put(JSONObject().put("id", id).put("x", c).put("y", r).put("w", 1).put("h", 1)
                                    .put("label", "").put("icon", "").put("color", "#0a84ff").put("action", JSONObject().put("k", "none"))) }
                                open = id
                            },
                        contentAlignment = Alignment.Center,
                    ) { Text("+", color = pal.muted, fontSize = 20.sp) }
                }
                for (t in tiles) TileView(d, t, cw, ch, gap, editing) {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    val a = t.optJSONObject("action") ?: JSONObject()
                    when {
                        editing -> open = t.optString("id")
                        a.optString("k") == "nav" -> when (a.optString("what")) {
                            "page" -> toPage(pages.indexOfFirst { it.optString("id") == a.optString("to") })
                            "next" -> toPage(pi + 1)
                            "prev" -> toPage(pi - 1)
                            "space" -> toSpace(a.optString("to"))
                            "nextspace", "prevspace" -> d.spaces.let { ss ->
                                val i = ss.indexOfFirst { it.optString("id") == space.optString("id") } + if (a.optString("what") == "nextspace") 1 else -1
                                ss.getOrNull(i)?.let { toSpace(it.optString("id")) }
                            }
                        }
                        a.optString("k") == "none" -> {}
                        a.optString("k") == "widget" -> if (a.optString("what") == "media") core.pcMedia.control("toggle")
                        d.runs(a) -> d.run(t.optString("id"))
                    }
                }
            }
        }
    }
    // Dots: where this page is among them.
    if (pages.size > 1 && !full) Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.Center) {
        pages.indices.forEach { i -> Box(Modifier.padding(3.dp).size(7.dp).clip(CircleShape).background(if (i == pager.currentPage) pal.text else pal.muted.copy(alpha = 0.4f))) }
    }
    if (editing) {
        Text(tr("Tap a tile to set it up, or an empty place to add one. Move and resize tiles by dragging on {name}’s Deck page.", "name" to (core.host?.name ?: "")),
            color = pal.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
        val cur = pages.getOrNull(pager.currentPage)
        if (cur != null && pages.size > 1) TextButton(onClick = {
            d.edit { l -> spaceIn(l, sid)?.optJSONArray("pages")?.removeWhere { it.optString("id") == cur.optString("id") } }
            scope.launch { pager.scrollToPage(0) }
        }) { Text(tr("Delete this page"), color = pal.bad) }
    }
    open?.let { id -> d.find(id)?.let { (t, p, _) -> TileEditor(core, d, t, p) { open = null } } ?: run { open = null } }
}

private fun spaceIn(l: JSONObject, id: String) = l.optJSONArray("spaces").objs().firstOrNull { it.optString("id") == id }
private fun pageIn(l: JSONObject, id: String) = l.optJSONArray("spaces").objs().flatMap { it.optJSONArray("pages").objs() }.firstOrNull { it.optString("id") == id }
private fun tileIn(l: JSONObject, id: String) = l.optJSONArray("spaces").objs().flatMap { it.optJSONArray("pages").objs() }.flatMap { it.optJSONArray("tiles").objs() }.firstOrNull { it.optString("id") == id }

// One tile at its place on the grid: its symbol, name and state; a slider's bar follows a drag.
@Composable
private fun TileView(d: Deck, t: JSONObject, cw: Dp, ch: Dp, gap: Dp, editing: Boolean, onTap: () -> Unit) {
    val id = t.optString("id")
    val a = t.optJSONObject("action") ?: JSONObject()
    val w = t.optInt("w", 1); val h = t.optInt("h", 1)
    val bg = deckColor(t.optString("color"))
    val fg = if (bg.luminance() > 0.6f) Color(0xFF1D1D1F) else Color.White
    val runs = d.runs(a)
    val failed = d.done?.first == id && d.done?.second?.isNotEmpty() == true && d.done?.second != "busy"
    val label = deckLabel(t, d.platform)
    val icon = deckIcon(t)
    val slider = a.optString("k") == "slider" && !editing && runs
    var drag by remember(id) { mutableStateOf<Float?>(null) }
    val value = drag ?: level(a, d.state)
    Box(
        Modifier.offset(x = (cw + gap) * t.optInt("x"), y = (ch + gap) * t.optInt("y"))
            .size(cw * w + gap * (w - 1), ch * h + gap * (h - 1))
            .alpha(if (runs) 1f else 0.4f)
            .clip(RoundedCornerShape(16.dp)).background(bg)
            .border(if (failed) 2.dp else 0.dp, if (failed) pal.bad else Color.Transparent, RoundedCornerShape(16.dp))
            .then(if (slider) Modifier.pointerInput(id) {
                val at = { x: Float -> (x / size.width.coerceAtLeast(1)).coerceIn(0f, 1f) }
                detectHorizontalDragGestures(
                    onDragStart = { o -> val v = at(o.x); drag = v; d.set(id, v) },
                    onDragEnd = { drag = null }, onDragCancel = { drag = null },
                ) { ch, _ -> ch.consume(); val v = at(ch.position.x); drag = v; d.set(id, v) }
            }.pointerInput(id + "tap") {
                detectTapGestures { o -> d.set(id, (o.x / size.width).coerceIn(0f, 1f)); drag = null }
            } else Modifier.clickable(onClick = onTap))
            .padding(if (w == 1 && h == 1) 6.dp else 12.dp),
    ) {
        if (a.optString("k") == "widget") { WidgetFace(d, a, fg, w, h); return@Box }
        val sub = if (slider) value?.let { "${(it * 100).roundToInt()}%" } ?: "" else stateText(a, d.state)
        val iconSize = if (w == 1 && h == 1) 24.dp else 28.dp
        if (w == 1) Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            DeckGlyph(icon, fg, iconSize)
            if (label.isNotEmpty()) Text(label, color = fg, fontSize = 11.sp, lineHeight = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
            if (sub.isNotEmpty() && h > 1) Text(sub, color = fg.copy(alpha = 0.72f), fontSize = 11.sp, maxLines = 1)
        } else Column(Modifier.fillMaxSize(), verticalArrangement = if (h == 1) Arrangement.Center else Arrangement.SpaceBetween) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                DeckGlyph(icon, fg, iconSize)
                Column(Modifier.weight(1f)) {
                    Text(label, color = fg, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (sub.isNotEmpty()) Text(sub, color = fg.copy(alpha = 0.72f), fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (a.optString("k") == "slider") Box(Modifier.padding(top = 8.dp).fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(fg.copy(alpha = 0.22f))) {
                Box(Modifier.fillMaxWidth(value ?: 0f).fillMaxHeight().background(fg.copy(alpha = 0.95f)))
            }
        }
    }
}

// A widget's face: the time, what plays on the computer (with its buttons), or the computer's
// processor, memory or heat (deck.state perf) as a number and a bar.
@Composable
private fun WidgetFace(d: Deck, a: JSONObject, fg: Color, w: Int, h: Int) {
    val ctx = LocalContext.current
    val big = w > 1 || h > 1
    when (val what = a.optString("what")) {
        "clock" -> {
            var now by remember { mutableStateOf(System.currentTimeMillis()) }
            LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); delay(1000 - now % 1000) } }
            val date = java.util.Date(now)
            val time = android.text.format.DateFormat.getTimeFormat(ctx).format(date)
            val day = java.text.SimpleDateFormat(android.text.format.DateFormat.getBestDateTimePattern(java.util.Locale.getDefault(), if (big) "EEEEdMMMM" else "EEEdMMM"), java.util.Locale.getDefault()).format(date)
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text(time, color = fg, fontSize = if (h > 1 && w > 1) 40.sp else if (big) 28.sp else 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(day, color = fg.copy(alpha = 0.75f), fontSize = if (big) 13.sp else 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        "media" -> {
            val n = d.core.pcMedia.now
            val playing = n?.playing == true
            val btn = @Composable { icon: String, act: String, size: Dp ->
                Box(Modifier.size(size + 14.dp).clip(CircleShape).clickable { d.core.pcMedia.control(act) }, contentAlignment = Alignment.Center) { DeckGlyph(icon, fg, size) }
            }
            if (!big) Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                DeckGlyph(if (playing) "pause" else "play", fg, 24.dp)
                Text(n?.title ?: tr("Nothing playing"), color = fg, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
            } else Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.SpaceBetween) {
                Column {
                    Text(n?.title ?: tr("Nothing playing"), color = fg, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = if (h > 1) 2 else 1, overflow = TextOverflow.Ellipsis)
                    val sub = listOfNotNull(n?.artist?.takeIf { it.isNotEmpty() }, n?.app?.takeIf { it.isNotEmpty() }).joinToString(" · ")
                    if (sub.isNotEmpty()) Text(sub, color = fg.copy(alpha = 0.72f), fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                    btn("prev", "prev", 20.dp)
                    btn(if (playing) "pause" else "play", "toggle", 26.dp)
                    btn("next", "next", 20.dp)
                }
            }
        }
        else -> {
            val perf = d.state?.optJSONObject("perf")
            val label = when (what) { "cpu" -> tr("CPU"); "ram" -> tr("Memory"); else -> tr("Temperature") }
            val frac: Float? = when (what) {
                "cpu" -> perf?.optDouble("cpu", Double.NaN)?.takeIf { !it.isNaN() }?.toFloat()
                "ram" -> perf?.optDouble("ram", Double.NaN)?.takeIf { !it.isNaN() }?.toFloat()
                else -> perf?.optDouble("temp", Double.NaN)?.takeIf { !it.isNaN() }?.let { (it / 100.0).toFloat() }
            }
            val text = when {
                frac == null -> "—"
                what == "temp" -> "${perf!!.optDouble("temp").roundToInt()}°"
                else -> "${(frac * 100).roundToInt()}%"
            }
            // Busy or hot: amber past 70, red past 90.
            val bar = when { frac == null -> fg; frac > 0.9f -> Color(0xFFFF453A); frac > 0.7f -> Color(0xFFFF9F0A); else -> fg }
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.SpaceBetween) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    DeckGlyph(DeckCatalog.symbolOf(a), fg, if (big) 20.dp else 16.dp)
                    Text(label, color = fg.copy(alpha = 0.8f), fontSize = if (big) 13.sp else 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(text, color = fg, fontSize = if (h > 1) 36.sp else if (big) 26.sp else 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Box(Modifier.fillMaxWidth().height(5.dp).clip(RoundedCornerShape(3.dp)).background(fg.copy(alpha = 0.22f))) {
                    Box(Modifier.fillMaxWidth((frac ?: 0f).coerceIn(0f, 1f)).fillMaxHeight().background(bar))
                }
            }
        }
    }
}

// A symbol (DeckCatalog) or, when it isn't one, an emoji.
@Composable
internal fun DeckGlyph(icon: String, tint: Color, size: Dp) {
    val v = DeckCatalog.symbol(icon)
    if (v != null) Icon(v, null, tint = tint, modifier = Modifier.size(size))
    else Text(icon, fontSize = (size.value * 0.85f).sp)
}

// ---- the window space ----

private val iconCache = HashMap<String, ImageBitmap?>()
private fun appIcon(data: String): ImageBitmap? = if (data.isEmpty()) null else iconCache.getOrPut(data) {
    runCatching { val b = Base64.decode(data.substringAfter(","), Base64.DEFAULT); BitmapFactory.decodeByteArray(b, 0, b.size)?.asImageBitmap() }.getOrNull()
}

@Composable
private fun WindowSpace(d: Deck, space: JSONObject) {
    LaunchedEffect(space.optString("id")) { while (true) { d.askWins(); delay(5000) } }
    val w = d.wins
    if (d.caps?.optBoolean("windows", true) == false) { Text(tr("Not on this computer"), color = pal.muted); return }
    if (w == null) { Text(tr("Loading windows…"), color = pal.muted); return }
    w.str("why", 300).takeIf { it.isNotEmpty() }?.let { Text(tr(it), color = pal.bad, fontSize = 13.sp, modifier = Modifier.padding(bottom = 8.dp)) }
    val apps = w.optJSONArray("apps").objs()
    val displays = w.optJSONArray("displays").objs()
    val front = w.optLong("front")
    // The app chosen (none at first, and none again once it's placed), and a zone tapped before an
    // app: either order works. Tap an app then a zone, or a zone then an app; with two zones,
    // place one app, tap the other zone, pick the next app.
    var appKey by remember { mutableStateOf<String?>(null) }
    var wid by remember { mutableStateOf<Long?>(null) }
    var armed by remember { mutableStateOf<Pair<Int, JSONObject>?>(null) } // a zone's number and rect
    var display by remember { mutableStateOf("") }
    val app = apps.firstOrNull { it.optString("key") == appKey }
    if (apps.isEmpty()) { Text(tr("No windows open"), color = pal.muted); return }
    val windows = app?.optJSONArray("windows").objs()
    val win = windows.firstOrNull { it.optLong("wid") == wid } ?: windows.firstOrNull { it.optLong("wid") == front } ?: windows.firstOrNull()
    val shownDisplay = display.ifEmpty { win?.optString("display") ?: displays.firstOrNull { it.optBoolean("main") }?.optString("id") ?: displays.firstOrNull()?.optString("id") ?: "" }
    val put = { target: JSONObject, zone: JSONObject? ->
        d.place(target.optLong("wid"), shownDisplay, zone)
        appKey = null; wid = null; armed = null
    }
    val windowOf = { a: JSONObject -> a.optJSONArray("windows").objs().let { ws -> ws.firstOrNull { it.optLong("wid") == front } ?: ws.firstOrNull() } }

    // The running apps (a dot: the one in front).
    Text(armed?.let { tr("Now choose the app for zone {n}", "n" to it.first) } ?: tr("App"),
        color = if (armed != null) pal.accent else pal.muted, fontSize = 12.sp, fontWeight = if (armed != null) FontWeight.SemiBold else null, modifier = Modifier.padding(bottom = 6.dp))
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        for (a in apps) {
            val on = a === app
            val inFront = a.optJSONArray("windows").objs().any { it.optLong("wid") == front }
            Column(Modifier.width(64.dp).clip(RoundedCornerShape(12.dp)).background(if (on) pal.accentSoft else Color.Transparent)
                .clickable {
                    val z = armed
                    val target = windowOf(a)
                    if (z != null && target != null) put(target, JSONObject(z.second.toString()))
                    else if (on) { appKey = null; wid = null } else { appKey = a.optString("key"); wid = null }
                }.padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box {
                    val img = appIcon(a.optString("icon"))
                    if (img != null) Image(img, null, Modifier.size(40.dp))
                    else Box(Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(pal.card), contentAlignment = Alignment.Center) {
                        Text(a.str("name", 2).take(1).uppercase(), color = pal.text, fontWeight = FontWeight.SemiBold)
                    }
                    if (inFront) Box(Modifier.align(Alignment.TopEnd).size(8.dp).clip(CircleShape).background(pal.accent))
                }
                Text(a.str("name", 40), color = pal.text, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
    // Its windows, when it has more than one.
    if (app != null && windows.size > 1) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (x in windows) {
            val on = x === win
            Box(Modifier.clip(RoundedCornerShape(50)).background(if (on) pal.accent else pal.card).clickable { wid = x.optLong("wid") }.padding(horizontal = 12.dp, vertical = 6.dp)) {
                Text(x.str("title", 50).ifEmpty { tr("Window") }, color = if (on) Color.White else pal.text, fontSize = 12.sp, maxLines = 1)
            }
        }
    }

    // The first page: drag the app to an edge (halves), the top (full) or a corner (quarters), as
    // windows snap on a computer. Then the layouts, swiped: tap a zone.
    val layouts = space.optJSONArray("layouts").objs()
    val pager = rememberPagerState { layouts.size + 1 }
    Text(if (pager.currentPage == 0) tr("Drag to an edge") else layouts.getOrNull(pager.currentPage - 1)?.str("name", 30) ?: "",
        color = pal.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp))
    HorizontalPager(pager, Modifier.fillMaxWidth(), pageSpacing = 16.dp) { i ->
        if (i == 0) SnapPad(app, win) { z -> win?.let { put(it, z) } }
        else {
            val zones = layouts[i - 1].optJSONArray("zones").objs()
            BoxWithConstraints(Modifier.fillMaxWidth().aspectRatio(16f / 10f).clip(RoundedCornerShape(12.dp)).background(Color(0xFF1C2A44))) {
                val u = maxWidth / ZONE_GRID; val v = maxHeight / ZONE_GRID
                zones.forEachIndexed { n, z ->
                    val lit = armed?.second?.toString() == z.toString()
                    Box(
                        Modifier.offset(x = u * z.optInt("x"), y = v * z.optInt("y")).size(u * z.optInt("w", 1), v * z.optInt("h", 1)).padding(3.dp)
                            .clip(RoundedCornerShape(8.dp)).background(Color(0xFF0A84FF).copy(alpha = if (lit) 0.75f else 0.35f))
                            .border(if (lit) 2.5.dp else 1.5.dp, if (lit) Color.White else Color(0xFF64D2FF), RoundedCornerShape(8.dp))
                            .clickable {
                                // An app chosen: there. None: this zone waits for one.
                                if (win != null) put(win, JSONObject(z.toString()))
                                else armed = if (lit) null else (n + 1) to z
                            },
                        contentAlignment = Alignment.Center,
                    ) { Text("${n + 1}", color = Color.White, fontWeight = FontWeight.SemiBold) }
                }
            }
        }
    }
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.Center) {
        (0..layouts.size).forEach { i -> Box(Modifier.padding(3.dp).size(7.dp).clip(CircleShape).background(if (i == pager.currentPage) pal.text else pal.muted.copy(alpha = 0.4f))) }
    }
    Text(
        if (app == null && armed == null) tr("Choose an app, then a zone, or tap a zone first and then the app.") else "",
        color = pal.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp),
    )
    // The displays: which one a zone goes on, or send the window there as it is.
    if (displays.size > 1) {
        Text(tr("Display"), color = pal.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp))
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (x in displays) {
                val on = x.optString("id") == shownDisplay
                Column(Modifier.clip(RoundedCornerShape(12.dp)).background(if (on) pal.accent else pal.card).clickable { display = x.optString("id") }.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(x.str("name", 40).ifEmpty { tr("Display") }, color = if (on) Color.White else pal.text, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                    Text("${x.optInt("w")} × ${x.optInt("h")}" + if (x.optBoolean("main")) " · " + tr("Main") else "", color = if (on) Color.White.copy(alpha = 0.8f) else pal.muted, fontSize = 11.sp)
                }
            }
        }
        if (win != null && shownDisplay != win.optString("display")) TextButton(onClick = { put(win, null) }) {
            Text(tr("Move the window to this display"), color = pal.accent)
        }
    }
    Text(tr("Draw your own layouts on the computer’s Deck page."), color = pal.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
}

// Where a drop at (fx, fy) of the display snaps a window, on the 12 × 12 zone grid: a corner a
// quarter, the left or right edge a half, the top the whole display; elsewhere nothing.
internal fun snapZone(fx: Float, fy: Float): JSONObject? {
    val e = 0.18f
    val z = { x: Int, y: Int, w: Int, h: Int -> JSONObject().put("x", x).put("y", y).put("w", w).put("h", h) }
    val left = fx < e; val right = fx > 1 - e; val top = fy < e; val bottom = fy > 1 - e
    return when {
        left && top -> z(0, 0, 6, 6)
        right && top -> z(6, 0, 6, 6)
        left && bottom -> z(0, 6, 6, 6)
        right && bottom -> z(6, 6, 6, 6)
        left -> z(0, 0, 6, 12)
        right -> z(6, 0, 6, 12)
        top -> z(0, 0, 12, 12)
        bottom -> z(0, 6, 12, 6)
        else -> null
    }
}

// The display, with the chosen app in the middle to drag to an edge; where it would go shows as it moves.
@Composable
private fun SnapPad(app: JSONObject?, win: JSONObject?, onDrop: (JSONObject) -> Unit) {
    var at by remember { mutableStateOf<androidx.compose.ui.geometry.Offset?>(null) }
    val drop by rememberUpdatedState(onDrop)
    BoxWithConstraints(Modifier.fillMaxWidth().aspectRatio(16f / 10f).clip(RoundedCornerShape(12.dp)).background(Color(0xFF1C2A44))
        .pointerInput(app?.optString("key"), win?.optLong("wid")) {
            if (app == null || win == null) return@pointerInput
            detectDragGestures(
                onDragStart = { o -> at = o },
                onDragEnd = {
                    val p = at; at = null
                    if (p != null) snapZone(p.x / size.width, p.y / size.height)?.let(drop)
                },
                onDragCancel = { at = null },
            ) { ch, delta -> ch.consume(); at = (at ?: ch.position) + delta }
        }) {
        val u = maxWidth / ZONE_GRID; val v = maxHeight / ZONE_GRID
        val p = at
        val zone = p?.let { with(androidx.compose.ui.platform.LocalDensity.current) { snapZone(it.x / maxWidth.toPx(), it.y / maxHeight.toPx()) } }
        zone?.let { z ->
            Box(Modifier.offset(x = u * z.optInt("x"), y = v * z.optInt("y")).size(u * z.optInt("w"), v * z.optInt("h")).padding(4.dp)
                .clip(RoundedCornerShape(10.dp)).background(Color(0xFF0A84FF).copy(alpha = 0.45f)).border(2.dp, Color(0xFF64D2FF), RoundedCornerShape(10.dp)))
        }
        if (app == null || win == null) Text(tr("Choose an app, then drag it to an edge or a corner."), color = Color.White.copy(alpha = 0.75f), fontSize = 13.sp,
            textAlign = TextAlign.Center, modifier = Modifier.align(Alignment.Center).padding(16.dp))
        else {
            val img = appIcon(app.optString("icon"))
            val dp = with(androidx.compose.ui.platform.LocalDensity.current) { p?.let { androidx.compose.ui.unit.DpOffset(it.x.toDp() - 26.dp, it.y.toDp() - 26.dp) } }
            Column(
                (if (dp != null) Modifier.offset(dp.x, dp.y) else Modifier.align(Alignment.Center)).width(52.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (img != null) Image(img, null, Modifier.size(52.dp))
                else Box(Modifier.size(52.dp).clip(RoundedCornerShape(12.dp)).background(pal.card), contentAlignment = Alignment.Center) {
                    Text(app.str("name", 2).take(1).uppercase(), color = pal.text, fontWeight = FontWeight.SemiBold)
                }
            }
            if (p == null) Text(tr("Drag {name} to an edge or a corner", "name" to app.str("name", 40)), color = Color.White.copy(alpha = 0.75f), fontSize = 12.sp,
                modifier = Modifier.align(Alignment.BottomCenter).padding(10.dp))
        }
    }
}

// ---- setting up a tile ----

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TileEditor(core: Core, d: Deck, t: JSONObject, page: JSONObject, close: () -> Unit) {
    val id = t.optString("id")
    var label by remember(id) { mutableStateOf(t.str("label", 40)) }
    var icon by remember(id) { mutableStateOf(t.str("icon", 16)) }
    var color by remember(id) { mutableStateOf(t.optString("color", "#0a84ff")) }
    var w by remember(id) { mutableStateOf(t.optInt("w", 1)) }
    var h by remember(id) { mutableStateOf(t.optInt("h", 1)) }
    var action by remember(id) { mutableStateOf(JSONObject((t.optJSONObject("action") ?: JSONObject().put("k", "none")).toString())) }
    var picking by remember(id) { mutableStateOf(action.optString("k") == "none" && t.str("label", 40).isEmpty()) }
    var pinned by remember(id) { mutableStateOf(Tiles.pinned(core.store, id)) }
    // A tile just added in an empty place: cancelling takes it away again instead of leaving a blank tile.
    val fresh = remember(id) { picking }
    fun cancel() {
        if (fresh) d.edit { l -> pageIn(l, page.optString("id"))?.optJSONArray("tiles")?.removeWhere { it.optString("id") == id } }
        close()
    }
    val k = action.optString("k")
    fun put(vararg kv: Pair<String, Any>) { action = JSONObject(action.toString()).apply { kv.forEach { put(it.first, it.second) } } }
    // Whether a size fits on the page from where the tile is, past no other tile.
    val cols = page.optInt("cols", 4); val rows = page.optInt("rows", 4)
    val x0 = t.optInt("x"); val y0 = t.optInt("y")
    fun fits(nw: Int, nh: Int): Boolean {
        if (x0 + nw > cols || y0 + nh > rows) return false
        return page.optJSONArray("tiles").objs().none { o -> o.optString("id") != id &&
            x0 < o.optInt("x") + o.optInt("w", 1) && o.optInt("x") < x0 + nw && y0 < o.optInt("y") + o.optInt("h", 1) && o.optInt("y") < y0 + nh }
    }

    if (picking) { ActionPicker(d, { if (fresh && action.optString("k") == "none") cancel() else picking = false }) { e ->
        action = e.action()
        if (e.wide && w == 1 && fits(2, 1)) w = 2
        if (e.k == "app") d.askApps()
        picking = false
    }; return }

    AlertDialog(
        onDismissRequest = ::cancel,
        containerColor = pal.card,
        title = { Text(tr("Tile"), color = pal.text) },
        text = {
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                // The action, and Change.
                val e = DeckCatalog.entry(action)
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(pal.content).clickable { picking = true }.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    DeckGlyph(DeckCatalog.symbolOf(action), pal.text, 22.dp)
                    Column(Modifier.weight(1f).padding(start = 10.dp)) {
                        Text(e?.let { tr(it.name(d.platform)) } ?: tr("Label only"), color = pal.text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        e?.let { Text(tr(it.desc(d.platform)), color = pal.muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    }
                    Text(tr("Change"), color = pal.accent, fontSize = 13.sp)
                }
                ActionOptions(d, action, page) { kv -> put(*kv) }
                if (e?.local == true || k == "macro") Text(tr("Set this one up on {name}’s Deck page.", "name" to (core.host?.name ?: "")), color = pal.muted, fontSize = 12.sp)

                OutlinedTextField(label, { label = it.take(40) }, label = { Text(tr("Label")) }, placeholder = { Text(e?.let { tr(it.name(d.platform)) } ?: "") }, singleLine = true)
                Text(tr("Symbol"), color = pal.muted, fontSize = 12.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val auto = icon.isEmpty()
                    Box(Modifier.size(34.dp).clip(RoundedCornerShape(8.dp)).background(if (auto) pal.accent else pal.content).clickable { icon = "" }, contentAlignment = Alignment.Center) {
                        Text(tr("Auto"), color = if (auto) Color.White else pal.text, fontSize = 9.sp)
                    }
                    for (s in DeckCatalog.SYMBOLS) Box(Modifier.size(34.dp).clip(RoundedCornerShape(8.dp)).background(if (icon == s) pal.accent else pal.content).clickable { icon = s }, contentAlignment = Alignment.Center) {
                        DeckGlyph(s, if (icon == s) Color.White else pal.text, 18.dp)
                    }
                }
                OutlinedTextField(if (DeckCatalog.symbol(icon) == null) icon else "", { icon = it.take(16) }, label = { Text(tr("Or an emoji")) }, singleLine = true)
                Text(tr("Colour"), color = pal.muted, fontSize = 12.sp)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (c in DECK_COLORS) Box(Modifier.size(28.dp).clip(CircleShape).background(deckColor(c)).border(if (c == color) 2.5.dp else 0.dp, pal.text, CircleShape).clickable { color = c })
                }
                Text(tr("Size"), color = pal.muted, fontSize = 12.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Stepper(tr("Wide"), w, 1..4, { fits(it, h) }) { w = it }
                    Stepper(tr("High"), h, 1..4, { fits(w, it) }) { h = it }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(tr("In the Overview’s shortcuts"), color = pal.text, fontSize = 14.sp)
                        Text(tr("Runs from the Overview too"), color = pal.muted, fontSize = 12.sp)
                    }
                    Switch(pinned, { pinned = it })
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                d.edit { l -> tileIn(l, id)?.apply { put("label", label); put("icon", icon); put("color", color); put("w", w); put("h", h); put("action", action) } }
                Tiles.pin(core.store, id, pinned)
                close()
            }) { Text(tr("Save"), color = pal.accent) }
        },
        dismissButton = {
            Row {
                TextButton(onClick = {
                    d.edit { l -> pageIn(l, page.optString("id"))?.optJSONArray("tiles")?.removeWhere { it.optString("id") == id } }
                    Tiles.pin(core.store, id, false)
                    close()
                }) { Text(tr("Delete"), color = pal.bad) }
                TextButton(onClick = ::cancel) { Text(tr("Cancel"), color = pal.muted) }
            }
        },
    )
}

@Composable
private fun Stepper(name: String, value: Int, range: IntRange, ok: (Int) -> Boolean, set: (Int) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(name, color = pal.text, fontSize = 13.sp)
        val less = value - 1; val more = value + 1
        Box(Modifier.size(30.dp).clip(CircleShape).background(pal.content).clickable(enabled = less in range) { set(less) }, contentAlignment = Alignment.Center) {
            Text("−", color = if (less in range) pal.text else pal.faint)
        }
        Text("$value", color = pal.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        val can = more in range && ok(more)
        Box(Modifier.size(30.dp).clip(CircleShape).background(pal.content).clickable(enabled = can) { set(more) }, contentAlignment = Alignment.Center) {
            Text("+", color = if (can) pal.text else pal.faint)
        }
    }
}

// The options of an action's kind: its shortcut, text, website, app, device, level, display, page.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ActionOptions(d: Deck, a: JSONObject, page: JSONObject, put: (Array<out Pair<String, Any>>) -> Unit) {
    val k = a.optString("k")
    val w = a.optString("what")
    val s = d.state
    fun set(vararg kv: Pair<String, Any>) = put(kv)
    @Composable fun pick(opts: List<Pair<String, String>>, chosen: String, fn: (String) -> Unit) {
        if (opts.isEmpty()) { Text(tr("Nothing to choose from yet"), color = pal.muted, fontSize = 12.sp); return }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((id, name) in opts) Box(Modifier.clip(RoundedCornerShape(50)).background(if (id == chosen) pal.accent else pal.content).clickable { fn(id) }.padding(horizontal = 10.dp, vertical = 6.dp)) {
                Text(name, color = if (id == chosen) Color.White else pal.text, fontSize = 12.sp, maxLines = 1)
            }
        }
    }
    @Composable fun amount(name: String, key: String, def: Int, range: IntRange) {
        Text("$name: ${a.optInt(key, def)}" + if (key == "level") "%" else "", color = pal.muted, fontSize = 12.sp)
        Slider(a.optInt(key, def).toFloat(), { set(key to it.roundToInt()) }, valueRange = range.first.toFloat()..range.last.toFloat())
    }
    LaunchedEffect(k) { if (k in listOf("output", "input", "bt", "bright", "slider")) d.askState() }
    when (k) {
        "keys" -> OutlinedTextField(a.optString("combo"), { set("combo" to it.trim()) }, label = { Text(tr("Shortcut, like Mod+Shift+KeyS")) }, singleLine = true,
            supportingText = { Text(tr("Mod is ⌘ on a Mac and Ctrl elsewhere. Or record it on the computer’s Deck page."), fontSize = 11.sp) })
        "text" -> {
            OutlinedTextField(a.optString("text"), { set("text" to it.take(4000)) }, label = { Text(tr("Text")) })
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(tr("Press Return after it"), color = pal.text, fontSize = 14.sp, modifier = Modifier.weight(1f))
                Switch(a.optBoolean("enter"), { set("enter" to it) })
            }
        }
        "url" -> OutlinedTextField(a.optString("url"), { set("url" to it.trim()) }, label = { Text(tr("Website")) }, singleLine = true)
        "app" -> {
            val list = d.apps
            if (list == null) Text(tr("Loading apps…"), color = pal.muted)
            else pick(list.map { it.id to it.name }, a.optString("id")) { id -> set("id" to id, "name" to (list.firstOrNull { it.id == id }?.name ?: "")) }
        }
        "output", "input" -> {
            val devs = s?.optJSONArray(if (k == "output") "outputs" else "inputs").objs()
            pick(devs.map { it.optString("id") to it.str("name", 60) }, a.optString("id")) { id -> set("id" to id, "name" to (devs.firstOrNull { it.optString("id") == id }?.str("name", 80) ?: "")) }
        }
        "bt" -> if (w == "connect" || w == "disconnect" || w == "toggleconn") {
            val devs = s?.optJSONObject("bt")?.optJSONArray("devices").objs()
            pick(devs.map { it.optString("id") to it.str("name", 60) }, a.optString("id")) { id -> set("id" to id, "name" to (devs.firstOrNull { it.optString("id") == id }?.str("name", 80) ?: "")) }
        }
        "volume" -> when (w) { "up", "down" -> amount(tr("Step"), "step", 6, 1..25); "set" -> amount(tr("Level"), "level", 50, 0..100) }
        "bright", "slider" -> {
            if (k == "bright" && w == "set") amount(tr("Level"), "level", 70, 0..100)
            if (k == "bright" || w == "bright") {
                val ds = s?.optJSONArray("displays").objs()
                if (ds.size > 1) pick(listOf("" to tr("Every display")) + ds.map { it.optString("id") to it.str("name", 60) }, a.optString("display")) { set("display" to it) }
            }
        }
        "nav" -> when (w) {
            "page" -> pick(d.spaces.flatMap { it.optJSONArray("pages").objs() }.map { it.optString("id") to it.str("name", 30) }, a.optString("to")) { set("to" to it) }
            "space" -> pick(d.spaces.map { it.optString("id") to it.str("name", 30) }, a.optString("to")) { set("to" to it) }
        }
    }
}

// Every action, by group, with a search; those this computer can't do are shown greyed with why.
@Composable
private fun ActionPicker(d: Deck, close: () -> Unit, choose: (DeckCatalog.Entry) -> Unit) {
    var q by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = close,
        containerColor = pal.card,
        title = { Text(tr("Choose an action"), color = pal.text) },
        text = {
            Column(Modifier.heightIn(max = 560.dp)) {
                OutlinedTextField(q, { q = it }, placeholder = { Text(tr("Search")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    val words = q.trim().lowercase()
                    for ((g, gname) in DeckCatalog.GROUPS) {
                        val list = DeckCatalog.ENTRIES.filter { it.group == g && (words.isEmpty() ||
                            tr(it.name(d.platform)).lowercase().contains(words) || tr(it.desc(d.platform)).lowercase().contains(words)) }
                        if (list.isEmpty()) continue
                        Text(tr(gname), color = pal.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
                        for (e in list) {
                            val why = if (e.device) null else if (e.k !in d.can) "Not on this computer" else DeckCatalog.available(e, d.caps, d.platform)
                            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable(enabled = why == null) { choose(e) }.alpha(if (why == null) 1f else 0.45f).padding(horizontal = 8.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically) {
                                DeckGlyph(DeckCatalog.symbolOf(e.action()), pal.text, 20.dp)
                                Column(Modifier.weight(1f).padding(start = 10.dp)) {
                                    Text(tr(e.name(d.platform)), color = pal.text, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                                    Text(why?.let { tr(it) } ?: tr(e.desc(d.platform)), color = pal.muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    if (e.local) Text(tr("Stays on this computer"), color = pal.accent, fontSize = 11.sp)
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = close) { Text(tr("Cancel"), color = pal.muted) } },
    )
}
