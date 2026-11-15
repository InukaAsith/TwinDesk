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
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.gestures.awaitTouchSlopOrCancellation
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.unit.IntOffset
import androidx.compose.runtime.key
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
    // Apps side by side: [{key, wid?, zone}] on a display (one not running is opened on the computer).
    fun arrange(display: String, items: List<JSONObject>) { done = null; core.send(msg(Proto.T.DECK_ARRANGE, "display" to display, "items" to JSONArray(items))) }
    fun winOp(wid: Long, op: String) { done = null; core.send(msg(Proto.T.DECK_PLACE, "wid" to wid, "op" to op)) }
    fun restore(wid: Long) { done = null; core.send(msg(Proto.T.DECK_PLACE, "wid" to wid, "restore" to true)) }
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

// Three fingers across the screen: onSwipe(dx, dy), one of them ±1 (DeckFull turns it into a
// space along the screen's long side, a page across it).
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
    // The screen kept on here too, as in the full Deck (DeckActivity).
    val view = androidx.compose.ui.platform.LocalView.current
    androidx.compose.runtime.DisposableEffect(view) { view.keepScreenOn = true; onDispose { view.keepScreenOn = false } }
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
        SwitchRow(tr("Three-finger swipes"), tr("Along the screen’s long side for the next space, across it for the next page; past the last, back to the first"), d.swipeSpaces) { on ->
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
// corner. Three fingers along the long side change the space, across it the page, round and round.
@Composable
fun DeckFull(core: Core, close: () -> Unit) {
    val v by core.version.collectAsState()
    @Suppress("UNUSED_EXPRESSION") v
    val d = core.deck
    val spaces = d.spaces
    var touched by remember { mutableStateOf(false) } // the first touch anywhere puts the hint away
    Box(Modifier.fillMaxSize().background(pal.content).windowInsetsPadding(WindowInsets.safeDrawing).padding(6.dp)
        .pointerInput(Unit) { awaitEachGesture { awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial); waitForUpOrCancellation(PointerEventPass.Initial); touched = true } }) {
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
        val ctx = LocalContext.current
        val show = { to: JSONObject -> spaceId = to.optString("id"); flash = to.str("name", 30) }
        val toSpace = { to: JSONObject -> show(to) }
        // Along the screen's long side the next space, across it the next page; round and round.
        val swipe = { dx: Int, dy: Int ->
            val (sp, pg) = if (d.portrait) dy to dx else dx to dy
            val i = spaces.indexOf(space)
            if (sp != 0) { if (spaces.size > 1) toSpace(spaces[Math.floorMod(i + sp, spaces.size)]) }
            else if (space.optString("kind") != "windows") step = (step.first + 1) to pg
        }
        val swipeNow by rememberUpdatedState(swipe) // the detector outlives recompositions
        // Showing the way to the window space: the first time a short picture that must be followed
        // (then a tour of it), after that a nudge and a tab each time the Deck opens elsewhere, there
        // until the first touch (a tile, a swipe, the tab itself).
        val win = spaces.firstOrNull { it.optString("kind") == "windows" }
        var intro by remember { mutableStateOf(win != null && !tourDone(ctx, "intro")) }
        var tour by remember { mutableStateOf(!tourDone(ctx, "windows")) }
        val nudge = remember { Animatable(0f) }
        var hint by remember { mutableStateOf(win != null && !intro && space.optString("kind") != "windows") }
        LaunchedEffect(hint) { if (!hint) nudge.animateTo(0f, tween(200)) }
        LaunchedEffect(touched) { if (touched) hint = false }
        val toWindows = { win?.let { toSpace(it) }; Unit }
        Column(Modifier.fillMaxSize().threeFingerSwipe(d.swipeSpaces) { dx, dy -> swipeNow(dx, dy) }
            .graphicsLayer { val o = -nudge.value * 28.dp.toPx(); if (d.portrait) translationY = o else translationX = o }) {
            if (space.optString("kind") == "windows") Column(Modifier.weight(1f)) { WindowSpace(d, space) }
            else TileSpace(core, d, space, pageOf, editing = false, full = true, step = step, onPage = { flash = it }) { to -> spaces.firstOrNull { it.optString("id") == to }?.let(toSpace) }
            d.done?.second?.takeIf { it.isNotEmpty() && it != "busy" }?.let { Text(tr(it), color = pal.bad, fontSize = 12.sp, maxLines = 1, modifier = Modifier.padding(top = 4.dp)) }
        }
        if (hint && win != null && space.optString("kind") != "windows") SwipeHint(d, win.str("name", 30).ifEmpty { tr("Windows") }, nudge, toWindows)
        CloseButton(Modifier.align(Alignment.TopEnd).alpha(0.55f), close)
        if (intro) DeckIntro(d) { tourSet(ctx, "intro"); intro = false; win?.let(show) }
        else if (tour && space.optString("kind") == "windows") WindowTour { tourSet(ctx, "windows"); tour = false }
        flash?.let {
            Box(Modifier.align(Alignment.Center).clip(RoundedCornerShape(14.dp)).background(Color.Black.copy(alpha = 0.7f)).padding(horizontal = 18.dp, vertical = 10.dp)) {
                Text(it, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

// The small × in the full-screen Deck's corner.
// ---- showing the way to the window space ----

private const val TOUR_PREFS = "deck_tour"
private fun tourDone(ctx: Context, k: String) = ctx.getSharedPreferences(TOUR_PREFS, Context.MODE_PRIVATE).getBoolean(k, false)
private fun tourSet(ctx: Context, k: String) = ctx.getSharedPreferences(TOUR_PREFS, Context.MODE_PRIVATE).edit().putBoolean(k, true).apply()
private fun ease(x: Float) = x.coerceIn(0f, 1f).let { it * it * (3 - 2 * it) }
private fun span(t: Float, a: Float, b: Float) = ease((t - a) / (b - a))
private val tourBlue = Color(0xFF0A84FF)
private val tourApps = listOf(Color(0xFF30D158), Color(0xFFFF9F0A), Color(0xFFBF5AF2))

// Three fingertips, sliding the way a space turns (portrait: down the screen).
@Composable
private fun Fingers(t: Float, portrait: Boolean, m: Modifier = Modifier) = Box(m.size(44.dp)) {
    val p = span(t, 0.1f, 0.8f)
    val a = if (t < 0.85f) 1f else 1f - span(t, 0.85f, 1f)
    for (i in 0..2) {
        val o = (i - 1) * 12
        val x = if (portrait) o.dp else (14 - 28 * p).dp
        val y = if (portrait) (14 - 28 * p).dp else o.dp
        Box(Modifier.align(Alignment.Center).offset(x, y).size(10.dp).alpha(a).clip(CircleShape).background(Color.White.copy(alpha = 0.9f)))
    }
}

// Each time the full Deck opens away from the window space: the tiles nudge towards it and a tab at
// that edge shows the three-finger swipe until the first touch (DeckFull); a tap on it goes there.
@Composable
private fun BoxScope.SwipeHint(d: Deck, name: String, nudge: Animatable<Float, *>, go: () -> Unit) {
    var shown by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        delay(350)
        repeat(2) { nudge.animateTo(1f, tween(260)); nudge.animateTo(0f, spring(dampingRatio = 0.45f, stiffness = 300f)) }
    }
    val t by rememberInfiniteTransition(label = "hint").animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "t")
    AnimatedVisibility(shown, Modifier.align(if (d.portrait) Alignment.BottomCenter else Alignment.CenterEnd), enter = fadeIn(), exit = fadeOut()) {
        val shape = if (d.portrait) RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp) else RoundedCornerShape(topStart = 16.dp, bottomStart = 16.dp)
        val inner: @Composable () -> Unit = {
            Fingers(t, d.portrait)
            Text(name, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
            Text(if (d.portrait) "↓" else "›", color = Color.White, fontSize = 18.sp)
        }
        val m = Modifier.clip(shape).background(tourBlue.copy(alpha = 0.92f)).clickable { shown = false; go() }.padding(horizontal = 10.dp, vertical = 8.dp)
        if (d.portrait) Row(m, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { inner() }
        else Column(m.width(84.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) { inner() }
    }
}

// The first time: a short picture of the swipe, and nothing else works until the window space is
// reached (three fingers here, or the button).
@Composable
private fun BoxScope.DeckIntro(d: Deck, go: () -> Unit) {
    val t by rememberInfiniteTransition(label = "intro").animateFloat(0f, 1f, infiniteRepeatable(tween(2200, easing = LinearEasing)), label = "t")
    var ready by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { delay(1800); ready = true }
    val goNow by rememberUpdatedState(go)
    Box(Modifier.matchParentSize().background(Color.Black.copy(alpha = 0.78f))
        .pointerInput(Unit) { awaitEachGesture { do { val e = awaitPointerEvent(); e.changes.forEach { it.consume() } } while (e.changes.any { it.pressed }) } }
        .threeFingerSwipe(true) { dx, dy -> if ((if (d.portrait) dy else dx) != 0) goNow() }, contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(24.dp)) {
            // The tiles slide away, the window space slides in, three fingers sweep across.
            BoxWithConstraints(Modifier.size(if (d.portrait) 150.dp else 260.dp, if (d.portrait) 240.dp else 150.dp).clip(RoundedCornerShape(16.dp)).background(Color(0xFF1C1C1E))) {
                val p = span(t, 0.2f, 0.7f)
                val (W, H) = maxWidth to maxHeight
                val sx = { k: Float -> if (d.portrait) 0.dp else W * k }
                val sy = { k: Float -> if (d.portrait) H * k else 0.dp }
                Box(Modifier.offset(sx(-p), sy(-p)).fillMaxSize().padding(10.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (r in 0..2) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            for (c in 0..3) Box(Modifier.size(if (d.portrait) 26.dp else 52.dp, 34.dp).clip(RoundedCornerShape(7.dp)).background(listOf(tourBlue, Color(0xFF30D158), Color(0xFFFF9F0A), Color(0xFFFF375F))[(r + c) % 4].copy(alpha = 0.8f)))
                        }
                    }
                }
                Box(Modifier.offset(sx(1 - p), sy(1 - p)).fillMaxSize().padding(10.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { for (c in tourApps) Box(Modifier.size(20.dp).clip(RoundedCornerShape(5.dp)).background(c)) }
                        Row(Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)).background(Color(0xFF14213A)).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(5.dp)).background(tourApps[0].copy(alpha = 0.55f)))
                            Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(5.dp)).background(tourApps[1].copy(alpha = 0.55f)))
                        }
                    }
                }
                Fingers(t, d.portrait, Modifier.align(Alignment.Center).graphicsLayer { scaleX = 1.6f; scaleY = 1.6f })
            }
            Text(tr("Your computer’s windows are one swipe away"), color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
            Text(if (d.portrait) tr("Swipe up or down with three fingers to reach your windows") else tr("Swipe sideways with three fingers to reach your windows"),
                color = Color.White.copy(alpha = 0.8f), fontSize = 14.sp, textAlign = TextAlign.Center)
            Box(Modifier.height(44.dp), contentAlignment = Alignment.Center) {
                if (ready) Box(Modifier.clip(RoundedCornerShape(50)).background(tourBlue).clickable { goNow() }.padding(horizontal = 20.dp, vertical = 10.dp)) {
                        Text(tr("Take me there"), color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    }
            }
        }
    }
}

// The first time in the window space: three quick pictures (tap, hold, drag); it can't be used until
// the last one's button.
@Composable
private fun BoxScope.WindowTour(done: () -> Unit) {
    var step by remember { mutableStateOf(0) }
    var ready by remember(step) { mutableStateOf(false) }
    LaunchedEffect(step) { delay(1600); ready = true }
    val t by rememberInfiniteTransition(label = "tour").animateFloat(0f, 1f, infiniteRepeatable(tween(2600, easing = LinearEasing)), label = "t")
    val texts = listOf(
        tr("Tap an app: the ways it can sit show up. Tap one to arrange it."),
        tr("Hold an app to pick a few, then choose how they sit together."),
        tr("Or drag an app onto the display: a corner, a side or the middle."),
    )
    Box(Modifier.matchParentSize().background(Color.Black.copy(alpha = 0.8f))
        .pointerInput(Unit) { awaitEachGesture { do { val e = awaitPointerEvent(); e.changes.forEach { it.consume() } } while (e.changes.any { it.pressed }) } },
        contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(24.dp).widthIn(max = 420.dp)) {
            TourDemo(step, t, Modifier.size(280.dp, 170.dp))
            Text(texts[step], color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (i in texts.indices) Box(Modifier.size(7.dp).clip(CircleShape).background(if (i == step) Color.White else Color.White.copy(alpha = 0.3f)))
            }
            Box(Modifier.height(44.dp), contentAlignment = Alignment.Center) {
                if (ready) Box(Modifier.clip(RoundedCornerShape(50)).background(tourBlue).clickable { if (step < texts.size - 1) step++ else done() }.padding(horizontal = 22.dp, vertical = 10.dp)) {
                        Text(if (step < texts.size - 1) tr("Next") else tr("Start"), color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    }
            }
        }
    }
}

// A little window space: three apps along the top, the display below, a fingertip doing the step.
@Composable
private fun TourDemo(step: Int, t: Float, m: Modifier) = BoxWithConstraints(m.clip(RoundedCornerShape(16.dp)).background(Color(0xFF1C1C1E)).padding(10.dp)) {
    val W = maxWidth; val H = maxHeight
    val appS = 26.dp; val gap = 10.dp
    val appX = { i: Int -> (appS + gap) * i }
    val dispY = appS + 12.dp
    val dispH = H - dispY
    // The finger's place and press, by step.
    var fx = 0.dp; var fy = 0.dp; var press = 0f; var drag: Color? = null
    val picked = mutableListOf<Int>(); var layouts = 0f; var placed = 0f; var lit = 0f
    when (step) {
        0 -> {
            val toL = span(t, 0.5f, 0.65f)
            fx = appX(0) + appS / 2 + (W * 0.5f - appX(0) - appS / 2) * toL; fy = appS / 2 + (dispY + dispH * 0.5f - appS / 2) * toL
            press = if (t in 0.15f..0.3f || t in 0.7f..0.8f) 1f else 0f
            if (t > 0.25f && t < 0.8f) picked += 0
            layouts = span(t, 0.3f, 0.45f) * (1 - span(t, 0.8f, 0.85f)); placed = span(t, 0.8f, 0.9f)
        }
        1 -> {
            val toB = span(t, 0.38f, 0.48f); val toL = span(t, 0.6f, 0.7f)
            fx = appX(0) + appS / 2 + (appX(1) - appX(0)) * toB + (W * 0.5f - appX(1) - appS / 2) * toL; fy = appS / 2 + (dispY + dispH * 0.5f - appS / 2) * toL
            press = if (t in 0.05f..0.35f || t in 0.5f..0.56f || t in 0.74f..0.82f) 1f else 0f
            if (t > 0.3f && t < 0.82f) picked += 0
            if (t > 0.54f && t < 0.82f) picked += 1
            layouts = span(t, 0.56f, 0.66f) * (1 - span(t, 0.82f, 0.86f)); placed = span(t, 0.82f, 0.92f)
        }
        else -> {
            val dn = span(t, 0.2f, 0.6f)
            fx = appX(2) + appS / 2 + (W * 0.2f - appX(2) - appS / 2) * dn; fy = appS / 2 + (dispY + dispH * 0.5f - appS / 2) * dn
            press = if (t in 0.1f..0.65f) 1f else 0f
            if (t in 0.15f..0.65f) drag = tourApps[2]
            lit = span(t, 0.4f, 0.5f) * (1 - span(t, 0.65f, 0.7f)); placed = span(t, 0.65f, 0.75f)
        }
    }
    // Apps.
    tourApps.forEachIndexed { i, c ->
        val n = picked.indexOf(i)
        Box(Modifier.offset(appX(i), 0.dp).size(appS).clip(RoundedCornerShape(7.dp)).background(c).border(if (n >= 0) 2.dp else 0.dp, Color.White, RoundedCornerShape(7.dp)), contentAlignment = Alignment.Center) {
            if (n >= 0 && step == 1) Text("${n + 1}", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
    }
    // The display: or, while apps are picked, the ways they can sit.
    Box(Modifier.offset(0.dp, dispY).size(W, dispH).clip(RoundedCornerShape(10.dp)).background(Color(0xFF14213A))) {
        val half = W / 2
        if (step == 2) {
            Box(Modifier.size(half, dispH).padding(3.dp).alpha(lit).clip(RoundedCornerShape(7.dp)).background(tourBlue.copy(alpha = 0.5f)).border(2.dp, Color.White, RoundedCornerShape(7.dp)))
            Box(Modifier.size(half, dispH).padding(3.dp).alpha(placed * (1 - span(t, 0.95f, 1f))).clip(RoundedCornerShape(7.dp)).background(tourApps[2].copy(alpha = 0.7f)))
        } else {
            val apps = if (step == 0) listOf(tourApps[0]) else listOf(tourApps[0], tourApps[1])
            if (placed > 0f) Row(Modifier.fillMaxSize().padding(3.dp).alpha(placed * (1 - span(t, 0.95f, 1f))), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                if (step == 0) { Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(6.dp)).background(apps[0].copy(alpha = 0.7f))); Spacer(Modifier.weight(1f)) }
                else for (c in apps) Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(6.dp)).background(c.copy(alpha = 0.7f)))
            }
            if (layouts > 0f) Row(Modifier.fillMaxSize().padding(8.dp).alpha(layouts), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                for (k in 0..2) Box(Modifier.weight(1f).aspectRatio(1.5f).graphicsLayer { scaleX = 0.8f + 0.2f * layouts; scaleY = scaleX }.clip(RoundedCornerShape(5.dp)).background(Color(0xFF2A3B5C))
                    .border(if (k == 1) 1.5.dp else 0.dp, Color.White.copy(alpha = 0.6f), RoundedCornerShape(5.dp)).padding(3.dp)) {
                    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        when (k) {
                            0 -> { Box(Modifier.weight(1f).fillMaxHeight().background(apps[0].copy(alpha = 0.7f))); if (apps.size > 1) Box(Modifier.weight(1f).fillMaxHeight().background(apps[1].copy(alpha = 0.7f))) }
                            1 -> { Box(Modifier.weight(1f).fillMaxHeight().background(apps[0].copy(alpha = 0.7f))); Box(Modifier.weight(1f).fillMaxHeight().background(apps.getOrNull(1)?.copy(alpha = 0.7f) ?: Color.White.copy(alpha = 0.08f))) }
                            else -> { Box(Modifier.weight(2f).fillMaxHeight().background(apps[0].copy(alpha = 0.7f))); Box(Modifier.weight(1f).fillMaxHeight().background(apps.getOrNull(1)?.copy(alpha = 0.7f) ?: Color.White.copy(alpha = 0.08f))) }
                        }
                    }
                }
            }
        }
    }
    // The app being dragged, and the fingertip (a ring grows while it holds, step 2).
    drag?.let { c -> Box(Modifier.offset(fx - 13.dp, fy - 13.dp).size(26.dp).alpha(0.9f).clip(RoundedCornerShape(7.dp)).background(c)) }
    val ring = if (step == 1 && t in 0.05f..0.35f) span(t, 0.05f, 0.3f) else 0f
    if (ring > 0f) Box(Modifier.offset(fx - 18.dp, fy - 18.dp).size(36.dp).alpha(1 - ring * 0.5f).graphicsLayer { scaleX = 0.6f + ring * 0.6f; scaleY = scaleX }.border(2.dp, Color.White, CircleShape))
    Box(Modifier.offset(fx - 11.dp, fy - 11.dp).size(22.dp).graphicsLayer { scaleX = 1f - press * 0.2f; scaleY = scaleX }.clip(CircleShape).background(Color.White.copy(alpha = 0.55f + press * 0.3f)))
}

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
        if (pages.size < 2) return@LaunchedEffect
        val to = Math.floorMod(pager.currentPage + step.second, pages.size)
        pager.animateScrollToPage(to); onPage(pages[to].str("name", 30))
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

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
private fun WindowSpace(d: Deck, space: JSONObject) {
    LaunchedEffect(space.optString("id")) { while (true) { d.askWins(); delay(4000) } }
    val w = d.wins
    if (d.caps?.optBoolean("windows", true) == false) { Text(tr("Not on this computer"), color = pal.muted); return }
    if (w == null) { Text(tr("Loading windows…"), color = pal.muted); return }
    val apps = w.optJSONArray("apps").objs()
    // The apps with a window showing; then, past a line in the same row, every minimized window (grayed).
    val showing = apps.filter { !it.optBoolean("min") }
    val minWins = apps.flatMap { a -> a.optJSONArray("windows").objs().filter { it.optBoolean("min") }.map { a to it } }
    val known = w.optJSONArray("known").objs()
    val displays = w.optJSONArray("displays").objs()
    val front = w.optLong("front")
    val haptic = LocalHapticFeedback.current
    // The apps picked, in order (a tap picks one, a hold adds more); a place tapped before any app;
    // the display shown; the saved sets' shelf; what was arranged last (for Save).
    var sel by remember { mutableStateOf(listOf<String>()) }
    var multi by remember { mutableStateOf(false) } // select mode: a hold starts it, taps then add and take out
    var pref by remember { mutableStateOf(mapOf<String, Long>()) } // an app's window chosen (a chip, or a minimized one held)
    var armed by remember { mutableStateOf<JSONObject?>(null) }
    var display by remember { mutableStateOf("") }
    var shelf by rememberSaveable { mutableStateOf(false) }
    var last by remember { mutableStateOf<Pair<List<String>, List<JSONObject>>?>(null) }
    val byKey = { k: String -> apps.firstOrNull { it.optString("key") == k } }
    val picked = sel.mapNotNull(byKey)
    LaunchedEffect(apps.map { it.optString("key") }) { sel = sel.filter { k -> apps.any { it.optString("key") == k } } }
    val one = picked.singleOrNull()
    val windows = one?.optJSONArray("windows").objs()
    // An app's window: the one chosen, else the one in front, else one showing, else a minimized one.
    val windowOf = { a: JSONObject -> a.optJSONArray("windows").objs().let { ws -> ws.firstOrNull { it.optLong("wid") == pref[a.optString("key")] } ?: ws.firstOrNull { it.optLong("wid") == front } ?: ws.firstOrNull { !it.optBoolean("min") } ?: ws.firstOrNull() } }
    val mainId = displays.firstOrNull { it.optBoolean("main") }?.optString("id") ?: displays.firstOrNull()?.optString("id") ?: ""
    val shown = display.takeIf { id -> displays.any { it.optString("id") == id } } ?: one?.let { windowOf(it)?.optString("display") }?.takeIf { it.isNotEmpty() } ?: mainId
    val shownD = displays.firstOrNull { it.optString("id") == shown }
    val ratio = shownD?.takeIf { it.optInt("h") > 0 }?.let { it.optInt("w").toFloat() / it.optInt("h") }?.coerceIn(0.5f, 3f) ?: 1.6f

    val clear = { sel = emptyList(); multi = false; pref = emptyMap(); armed = null }
    val put = { a: JSONObject, zone: JSONObject ->
        windowOf(a)?.let { d.place(it.optLong("wid"), shown, JSONObject(zone.toString())) }
        clear()
    }
    // A tap picks that app alone (again: none). A hold starts select mode with it picked (never takes
    // it out); in select mode a tap adds or takes out, and taking out the last one ends it.
    val tap = { k: String ->
        if (multi || sel.size > 1) { sel = if (k in sel) sel - k else (sel + k).takeLast(6); if (sel.isEmpty()) multi = false }
        else sel = if (sel == listOf(k)) emptyList() else listOf(k)
        pref = pref - k
    }
    val hold = { k: String -> haptic.performHapticFeedback(HapticFeedbackType.LongPress); multi = true; if (k !in sel) sel = (sel + k).takeLast(6); pref = pref - k }
    // The picked apps into a configuration's zones, in order; remembered for Save.
    val arrange = { zones: List<JSONObject> ->
        val items = picked.zip(zones).map { (a, z) -> JSONObject().put("key", a.optString("key")).put("wid", windowOf(a)?.optLong("wid") ?: 0).put("zone", JSONObject(z.toString())) }
        // Done: the picking ends (Save still offered for what was just arranged).
        if (items.isNotEmpty()) { d.arrange(shown, items); last = picked.map { it.optString("key") } to zones.take(items.size); clear() }
    }
    val windowSpace = d.spaces.firstOrNull { it.optString("kind") == "windows" }
    val sets = windowSpace?.optJSONArray("sets").objs()
    val saveSet = save@{
        val (keys, zones) = last ?: return@save
        val items = JSONArray()
        keys.zip(zones).forEach { (k, z) -> items.put(JSONObject().put("key", k).put("name", (byKey(k) ?: known.firstOrNull { it.optString("key") == k })?.str("name", 60) ?: "").put("zone", z)) }
        d.edit { l ->
            val s = l.optJSONArray("spaces").objs().firstOrNull { it.optString("kind") == "windows" } ?: return@edit
            val arr = s.optJSONArray("sets") ?: JSONArray().also { s.put("sets", it) }
            arr.put(JSONObject().put("id", newId("w")).put("display", shown).put("items", items))
        }
        last = null; shelf = true
    }
    val dropSet = { id: String -> d.edit { l -> l.optJSONArray("spaces").objs().forEach { s -> s.optJSONArray("sets")?.removeWhere { it.optString("id") == id } } } }

    // A drag from the bar: the app and where the finger is; the display's place on the screen.
    var dragging by remember { mutableStateOf<Pair<JSONObject, Offset>?>(null) }
    var pad by remember { mutableStateOf<Rect?>(null) }
    var origin by remember { mutableStateOf(Offset.Zero) }
    // Wherever the finger is on the display, whatever's picked: a corner a quarter, a side a half, the middle all of it.
    val target = { p: Offset -> pad?.takeIf { it.contains(p) }?.let { r -> snapZone((p.x - r.left) / r.width, (p.y - r.top) / r.height) } }
    val targetNow by rememberUpdatedState(target)
    val dropNow by rememberUpdatedState({ a: JSONObject, p: Offset -> targetNow(p)?.let { z -> put(a, z) }; Unit })
    val hover = dragging?.let { target(it.second) }

    // One app in the picker: its icon (bigger when there's room), its place in the order once picked.
    // win: a minimized window of it instead, grayed and named after its title: a tap brings it back,
    // a hold picks the app with that window (arranging brings it back too).
    @Composable
    fun AppItem(a: JSONObject, itemW: Dp, iconSize: Dp, win: JSONObject?) = key(a.optString("key") + (win?.optLong("wid") ?: "")) {
        val k = a.optString("key")
        val mw = win?.optLong("wid")
        val chosenMin = pref[k]?.let { p -> a.optJSONArray("windows").objs().any { it.optLong("wid") == p && it.optBoolean("min") } } == true
        val n = if (if (mw != null) pref[k] == mw else !chosenMin) sel.indexOf(k) else -1
        val inFront = win == null && a.optJSONArray("windows").objs().any { it.optLong("wid") == front }
        val choose = { if (mw != null) pref = pref + (k to mw) }
        var at by remember { mutableStateOf(Offset.Zero) }
        Column(Modifier.width(itemW).onGloballyPositioned { at = it.positionInRoot() }
            .pointerInput(k, mw) {
                // Downwards: a drag onto the display. Sideways: the row scrolls.
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    var down2 = false
                    val ch = awaitTouchSlopOrCancellation(down.id) { c, over -> if (abs(over.y) > abs(over.x)) { down2 = true; c.consume() } }
                    if (ch == null || !down2) return@awaitEachGesture
                    choose()
                    dragging = a to (at + ch.position)
                    val ended = drag(ch.id) { c -> dragging = dragging?.let { it.first to (at + c.position) }; c.consume() }
                    if (ended) dragging?.let { (x, p) -> dropNow(x, p) }
                    dragging = null
                }
            }
            .clip(RoundedCornerShape(14.dp)).background(if (n >= 0) pal.accentSoft else Color.Transparent)
            .combinedClickable(onLongClick = { hold(k); choose() }) {
                val z = armed
                when {
                    z != null -> { choose(); put(a, z) }
                    mw != null && !multi && sel.size < 2 -> { d.restore(mw); clear() }
                    mw != null && k in sel && pref[k] != mw -> choose() // picked already: this window instead
                    else -> { tap(k); if (k in sel) choose() }
                }
            }.padding(5.dp).alpha(if (mw != null && n < 0) 0.45f else 1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Box {
                AppIcon(a, iconSize)
                if (n >= 0) Box(Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-4).dp).size(18.dp).clip(CircleShape).background(pal.accent), contentAlignment = Alignment.Center) {
                    Text("${n + 1}", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                } else if (inFront) Box(Modifier.align(Alignment.TopEnd).size(8.dp).clip(CircleShape).background(pal.accent))
            }
            Text(win?.str("title", 40)?.ifEmpty { null } ?: a.str("name", 40), color = pal.text, fontSize = 10.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp))
        }
    }

    // One row along the top: the apps showing, as big as the room allows, then past a line the
    // minimized windows; below, only when the picked app has more than one window, its windows.
    val bar: @Composable () -> Unit = {
        BoxWithConstraints(Modifier.fillMaxWidth().padding(end = 40.dp)) {
            val itemW = (maxWidth / maxOf(1, showing.size + minWins.size)).coerceIn(62.dp, 96.dp)
            val iconSize = (itemW * 0.62f).coerceIn(38.dp, 58.dp)
            Column {
                if (apps.isEmpty()) Text(tr("No windows open"), color = pal.muted, fontSize = 13.sp, modifier = Modifier.padding(8.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    for (a in showing) AppItem(a, itemW, iconSize, null)
                    if (minWins.isNotEmpty()) {
                        Box(Modifier.padding(horizontal = 6.dp).width(1.dp).height(iconSize + 14.dp).background(pal.muted.copy(alpha = 0.4f)))
                        for ((a, x) in minWins) AppItem(a, itemW, iconSize, x)
                    }
                }
                if (one != null && windows.size > 1) Row(Modifier.horizontalScroll(rememberScrollState()).padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (x in windows) {
                        val on = x === windowOf(one)
                        Box(Modifier.clip(RoundedCornerShape(50)).background(if (on) pal.accent else pal.card).clickable { pref = pref + (one.optString("key") to x.optLong("wid")) }.padding(horizontal = 12.dp, vertical = 6.dp)
                            .alpha(if (x.optBoolean("min") && !on) 0.5f else 1f)) {
                            Text(x.str("title", 40).ifEmpty { tr("Window") }, color = if (on) Color.White else pal.text, fontSize = 12.sp, maxLines = 1)
                        }
                    }
                }
            }
        }
    }

    // The displays, down the left side when there's more than one: which one the apps go on.
    val rail: @Composable () -> Unit = {
        Column(Modifier.width(96.dp).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (x in displays) {
                val on = x.optString("id") == shown
                val ar = if (x.optInt("h") > 0) x.optInt("w").toFloat() / x.optInt("h") else 1.6f
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (on) pal.accentSoft else Color.Transparent).clickable { display = x.optString("id") }.padding(6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.fillMaxWidth().aspectRatio(ar.coerceIn(0.5f, 3f)).clip(RoundedCornerShape(4.dp)).background(Color(0xFF1C2A44))
                        .border(if (on) 2.dp else 1.dp, if (on) pal.accent else pal.muted.copy(alpha = 0.5f), RoundedCornerShape(4.dp)))
                    Text(x.str("name", 40).ifEmpty { tr("Display") }, color = if (on) pal.accent else pal.text, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                    if (x.optBoolean("main")) Text(tr("Main"), color = pal.muted, fontSize = 10.sp)
                }
            }
            val win = one?.let(windowOf)
            if (win != null && shown != win.optString("display")) TextButton(onClick = { d.place(win.optLong("wid"), shown, null); clear() }) {
                Text(tr("Move here"), color = pal.accent, fontSize = 12.sp)
            }
        }
    }

    // The display itself, as wide as the screen: its windows where they are now, the place under the
    // finger lit while an app is dragged; a tap places the picked app (or waits for one).
    val screen: @Composable (Modifier) -> Unit = { m ->
        BoxWithConstraints(m.onGloballyPositioned { pad = it.boundsInRoot() }.clip(RoundedCornerShape(14.dp)).background(Color(0xFF14213A))
            .pointerInput(shown, sel, armed, pref) {
                detectTapGestures { o ->
                    val z = snapZone(o.x / size.width, o.y / size.height) ?: return@detectTapGestures
                    when {
                        one != null -> put(one, z)
                        picked.isEmpty() -> armed = if (armed?.toString() == z.toString()) null else z
                    }
                }
            }) {
            val u = maxWidth / ZONE_GRID; val v = maxHeight / ZONE_GRID
            // The windows on this display, the one in front drawn last.
            val here = apps.flatMap { a -> a.optJSONArray("windows").objs().filter { !it.optBoolean("min") && it.optString("display") == shown }.map { a to it } }.asReversed()
            for ((a, x) in here) {
                val f = x.optJSONArray("f") ?: continue
                val fx = f.optDouble(0).toFloat().coerceIn(0f, 1f); val fy = f.optDouble(1).toFloat().coerceIn(0f, 1f)
                val fw = f.optDouble(2).toFloat().coerceIn(0.02f, 1f - fx); val fh = f.optDouble(3).toFloat().coerceIn(0.02f, 1f - fy)
                val lit = a.optString("key") in sel
                Box(Modifier.offset(x = maxWidth * fx, y = maxHeight * fy).size(maxWidth * fw, maxHeight * fh).padding(2.dp)
                    .clip(RoundedCornerShape(6.dp)).background(Color(0xFF2A3B5C))
                    .border(if (lit) 2.dp else 1.dp, if (lit) Color(0xFF64D2FF) else Color.White.copy(alpha = 0.18f), RoundedCornerShape(6.dp)),
                    contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        AppIcon(a, 26.dp)
                        Text(x.str("title", 60).ifEmpty { a.str("name", 40) }, color = Color.White.copy(alpha = 0.75f), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 6.dp))
                    }
                }
            }
            // Where it would go: under the dragged app, or the place tapped first.
            (hover ?: armed)?.let { z ->
                Box(Modifier.offset(x = u * z.optInt("x"), y = v * z.optInt("y")).size(u * z.optInt("w"), v * z.optInt("h")).padding(4.dp)
                    .clip(RoundedCornerShape(10.dp)).background(Color(0xFF0A84FF).copy(alpha = 0.5f)).border(2.dp, Color.White, RoundedCornerShape(10.dp)))
            }
            if (dragging != null) Box(Modifier.fillMaxSize().border(1.dp, Color.White.copy(alpha = 0.15f), RoundedCornerShape(14.dp)))
            Text(shownD?.str("name", 40) ?: "", color = Color.White.copy(alpha = 0.5f), fontSize = 11.sp, modifier = Modifier.align(Alignment.BottomStart).padding(8.dp))
        }
    }

    // How the picked apps can sit side by side (more places than apps leave some free), the ones
    // drawn on the computer with as many places first: in the middle, as big as they fit. A tap arranges.
    val drawn = space.optJSONArray("layouts").objs()
    val names = drawn.associate { it.optJSONArray("zones").objs().toString() to it.str("name", 30) }
    val configs = if (picked.isEmpty()) emptyList() else deckConfigs(picked.size, drawn.map { it.optJSONArray("zones").objs() })
    val choices: @Composable (Modifier) -> Unit = { m ->
        BoxWithConstraints(m, contentAlignment = Alignment.Center) {
            val gap = 12.dp
            val count = maxOf(1, configs.size)
            // The column count that gives each picture the most room.
            var best = 1; var bestW = 0.dp
            for (c in 1..count) {
                val r = (count + c - 1) / c
                val tw = minOf((maxWidth - gap * (c - 1)) / c, ((maxHeight - gap * (r - 1)) / r - 18.dp) * ratio)
                if (tw > bestW) { bestW = tw; best = c }
            }
            Column(verticalArrangement = Arrangement.spacedBy(gap), horizontalAlignment = Alignment.CenterHorizontally) {
                for (rowC in configs.chunked(best)) Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                    for (c in rowC) {
                        val now = last?.let { it.first == sel && it.second == c.take(picked.size) } == true
                        Column(Modifier.width(bestW), horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(Modifier.fillMaxWidth().aspectRatio(ratio).clip(RoundedCornerShape(12.dp))
                                .border(if (now) 2.5.dp else 0.dp, if (now) pal.accent else Color.Transparent, RoundedCornerShape(12.dp)).clickable { arrange(c) }) {
                                Mini(c, picked, Modifier.fillMaxSize(), 48.dp)
                            }
                            Text(names[c.toString()] ?: "", color = pal.muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.height(18.dp).padding(top = 3.dp))
                        }
                    }
                }
            }
        }
    }

    // Along the bottom: a hint, or what the picked apps can do: order turned round, Save, Clear.
    val row: @Composable () -> Unit = {
        Row(Modifier.fillMaxWidth().height(48.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (picked.isEmpty()) Text(if (armed != null) tr("Now tap the app for that place") else tr("Tap an app to see where it can go, hold one to pick more. Or drag it onto the display."),
                color = if (armed != null) pal.accent else pal.muted, fontSize = 12.sp, maxLines = 2, modifier = Modifier.padding(horizontal = 4.dp))
            if (picked.size > 1) Chip(tr("Swap order")) { sel = sel.drop(1) + sel.first() }
            if (last != null && (sel.isEmpty() || last?.first == sel)) Chip(tr("Save"), accent = true) { saveSet() }
            if (picked.isNotEmpty()) Chip(tr("Clear")) { clear() }
        }
    }

    Box(Modifier.fillMaxSize().onGloballyPositioned { origin = it.positionInRoot() }) {
        Column(Modifier.fillMaxSize()) {
            bar()
            Row(Modifier.weight(1f).fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (displays.size > 1) rail()
                // Apps picked: their layouts here; the display back while one is dragged (or nothing's picked).
                if (picked.isNotEmpty() && dragging == null) choices(Modifier.weight(1f).fillMaxHeight().padding(end = 36.dp))
                else screen(Modifier.weight(1f).fillMaxHeight())
            }
            row()
        }
        // At the right edge: the window's own buttons (the picked app's window, else the one in front)
        // in a thin bar, and the saved sets' shelf below it.
        val ctl = one?.let(windowOf) ?: apps.firstNotNullOfOrNull { a -> a.optJSONArray("windows").objs().firstOrNull { it.optLong("wid") == front } }
        Column(Modifier.align(Alignment.CenterEnd).fillMaxHeight().padding(vertical = 24.dp), horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically)) {
            if (ctl != null && !shelf) Column(Modifier.width(30.dp).clip(RoundedCornerShape(topStart = 12.dp, bottomStart = 12.dp)).background(pal.card).padding(vertical = 4.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                val wd = ctl.optLong("wid")
                @Composable fun btn(label: String, op: String, glyph: @Composable () -> Unit) =
                    Box(Modifier.size(30.dp, 36.dp).clickable { haptic.performHapticFeedback(HapticFeedbackType.LongPress); d.winOp(wd, op); if (op == "close" || op == "min") clear() }
                        .semantics { contentDescription = label }, contentAlignment = Alignment.Center) { glyph() }
                btn(tr("Close"), "close") { Icon(Ico.close, null, tint = pal.bad, modifier = Modifier.size(13.dp)) }
                btn(tr("Minimize"), "min") { DeckGlyph("minimize", pal.text, 15.dp) }
                btn(tr("Maximize"), "max") { DeckGlyph("maximize", pal.text, 15.dp) }
                btn(tr("Full screen"), "full") { DeckGlyph("display", pal.text, 15.dp) }
            }
            shelfView(d, sets, shelf, { shelf = it }, byKey, known, displays, shown, dropSet)
        }
        // The app being dragged, under the finger.
        dragging?.let { (a, p) ->
            Box(Modifier.offset { IntOffset((p.x - origin.x).roundToInt() - 26.dp.roundToPx(), (p.y - origin.y).roundToInt() - 26.dp.roundToPx()) }.alpha(0.9f)) { AppIcon(a, 52.dp) }
        }
    }
}

// The saved sets on a shelf at the right edge, pulled out with its tab: one tap arranges them
// (and opens the ones not running).
@Composable
private fun shelfView(d: Deck, sets: List<JSONObject>, shelf: Boolean, setShelf: (Boolean) -> Unit, byKey: (String) -> JSONObject?, known: List<JSONObject>,
                      displays: List<JSONObject>, shown: String, dropSet: (String) -> Unit) {
    if (!shelf) Box(Modifier.width(30.dp).height(96.dp).clip(RoundedCornerShape(topStart = 12.dp, bottomStart = 12.dp)).background(pal.card).clickable { setShelf(true) },
        contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Ico.left, tr("Saved sets"), tint = pal.text, modifier = Modifier.size(14.dp))
            if (sets.isNotEmpty()) Text("${sets.size}", color = pal.muted, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
        }
    } else Column(Modifier.width(220.dp).fillMaxHeight().clip(RoundedCornerShape(topStart = 14.dp, bottomStart = 14.dp)).background(pal.card).padding(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(tr("Saved sets"), color = pal.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Box(Modifier.size(28.dp).clip(CircleShape).clickable { setShelf(false) }, contentAlignment = Alignment.Center) { Icon(Ico.right, tr("Close"), tint = pal.muted, modifier = Modifier.size(14.dp)) }
        }
        if (sets.isEmpty()) Text(tr("Pick apps, choose how they sit, then Save: they wait here, ready to arrange (and open) in one tap."), color = pal.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (s in sets) key(s.optString("id")) {
                val items = s.optJSONArray("items").objs()
                val look = { k: String -> byKey(k) ?: known.firstOrNull { it.optString("key") == k } }
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(pal.content.copy(alpha = 0.6f)).clickable {
                    val to = s.optString("display").takeIf { id -> displays.any { it.optString("id") == id } } ?: shown
                    d.arrange(to, items.map { JSONObject().put("key", it.optString("key")).put("zone", it.optJSONObject("zone")) })
                }.padding(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Mini(items.map { it.optJSONObject("zone") ?: JSONObject() }, items.map { look(it.optString("key")) }, Modifier.width(64.dp).aspectRatio(1.6f))
                    Text(s.str("name", 60), color = pal.text, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 8.dp))
                    Box(Modifier.size(26.dp).clip(CircleShape).clickable { dropSet(s.optString("id")) }, contentAlignment = Alignment.Center) {
                        Icon(Ico.close, tr("Remove"), tint = pal.muted, modifier = Modifier.size(12.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun Chip(text: String, accent: Boolean = false, onClick: () -> Unit) = Box(
    Modifier.clip(RoundedCornerShape(50)).background(if (accent) pal.accent else pal.card).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 8.dp),
) { Text(text, color = if (accent) Color.White else pal.text, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1) }

// A small picture of zones on a display, each with its app's icon (a zone with no app left free).
@Composable
private fun Mini(zones: List<JSONObject>, apps: List<JSONObject?>, m: Modifier, icon: Dp = 26.dp) = BoxWithConstraints(m.clip(RoundedCornerShape(8.dp)).background(Color(0xFF14213A))) {
    val u = maxWidth / ZONE_GRID; val v = maxHeight / ZONE_GRID
    zones.forEachIndexed { i, z ->
        val a = apps.getOrNull(i)
        Box(Modifier.offset(x = u * z.optInt("x"), y = v * z.optInt("y")).size(u * z.optInt("w", 12), v * z.optInt("h", 12)).padding(1.5.dp)
            .clip(RoundedCornerShape(4.dp)).background(if (i < apps.size) Color(0xFF0A84FF).copy(alpha = 0.4f) else Color.White.copy(alpha = 0.06f))
            .border(1.dp, if (i < apps.size) Color(0xFF64D2FF) else Color.White.copy(alpha = 0.2f), RoundedCornerShape(4.dp)), contentAlignment = Alignment.Center) {
            if (a != null) AppIcon(a, minOf(minOf(u * z.optInt("w", 12), v * z.optInt("h", 12)) * 0.6f, icon))
        }
    }
}

// How n apps can sit side by side on the 12 × 12 grid, in their order. Some have a place more than
// there are apps (three in the quarters); the computer's own drawn layouts with as many places come first.
internal fun deckConfigs(n: Int, drawn: List<List<JSONObject>> = emptyList()): List<List<JSONObject>> {
    fun z(x: Int, y: Int, w: Int, h: Int) = JSONObject().put("x", x).put("y", y).put("w", w).put("h", h)
    val q = listOf(z(0, 0, 6, 6), z(6, 0, 6, 6), z(0, 6, 6, 6), z(6, 6, 6, 6))
    val made = when (n) {
        1 -> listOf(listOf(z(0, 0, 12, 12)), listOf(z(0, 0, 6, 12)), listOf(z(6, 0, 6, 12)), listOf(z(2, 1, 8, 10)))
        2 -> listOf(listOf(z(0, 0, 6, 12), z(6, 0, 6, 12)), listOf(z(0, 0, 8, 12), z(8, 0, 4, 12)), listOf(z(0, 0, 4, 12), z(4, 0, 8, 12)), listOf(z(0, 0, 12, 6), z(0, 6, 12, 6)))
        3 -> listOf(
            listOf(z(0, 0, 4, 12), z(4, 0, 4, 12), z(8, 0, 4, 12)),
            listOf(z(0, 0, 6, 12), z(6, 0, 6, 6), z(6, 6, 6, 6)),
            listOf(z(0, 0, 6, 6), z(0, 6, 6, 6), z(6, 0, 6, 12)),
            q,
            listOf(z(0, 0, 12, 6), z(0, 6, 6, 6), z(6, 6, 6, 6)),
            listOf(z(0, 0, 8, 12), z(8, 0, 4, 6), z(8, 6, 4, 6)),
        )
        4 -> listOf(q,
            listOf(z(0, 0, 3, 12), z(3, 0, 3, 12), z(6, 0, 3, 12), z(9, 0, 3, 12)),
            listOf(z(0, 0, 6, 12), z(6, 0, 6, 4), z(6, 4, 6, 4), z(6, 8, 6, 4)),
            listOf(z(0, 0, 12, 6), z(0, 6, 4, 6), z(4, 6, 4, 6), z(8, 6, 4, 6)),
            listOf(z(0, 0, 4, 6), z(4, 0, 4, 6), z(8, 0, 4, 6), z(0, 6, 4, 6), z(4, 6, 4, 6), z(8, 6, 4, 6)),
        )
        5 -> listOf(
            listOf(z(0, 0, 4, 6), z(4, 0, 4, 6), z(8, 0, 4, 6), z(0, 6, 6, 6), z(6, 6, 6, 6)),
            listOf(z(0, 0, 6, 12), z(6, 0, 3, 6), z(9, 0, 3, 6), z(6, 6, 3, 6), z(9, 6, 3, 6)),
            listOf(z(0, 0, 4, 6), z(4, 0, 4, 6), z(8, 0, 4, 6), z(0, 6, 4, 6), z(4, 6, 4, 6), z(8, 6, 4, 6)),
        )
        else -> listOf(
            listOf(z(0, 0, 4, 6), z(4, 0, 4, 6), z(8, 0, 4, 6), z(0, 6, 4, 6), z(4, 6, 4, 6), z(8, 6, 4, 6)),
            listOf(z(0, 0, 6, 4), z(6, 0, 6, 4), z(0, 4, 6, 4), z(6, 4, 6, 4), z(0, 8, 6, 4), z(6, 8, 6, 4)),
        )
    }
    // The person's own (with as many places as there are apps) first; the ready-made ones they match left out.
    val own = drawn.filter { it.size == n }.distinctBy { it.toString() }
    val seen = own.map { it.toString() }.toSet()
    return own + made.filter { it.toString() !in seen }
}

// An app's icon, or its first letter.
@Composable
private fun AppIcon(a: JSONObject, size: Dp) {
    val img = appIcon(a.optString("icon"))
    if (img != null) Image(img, null, Modifier.size(size))
    else Box(Modifier.size(size).clip(RoundedCornerShape(size / 4)).background(pal.card), contentAlignment = Alignment.Center) {
        Text(a.str("name", 2).take(1).uppercase(), color = pal.text, fontWeight = FontWeight.SemiBold)
    }
}

// Where a drop or a tap at (fx, fy) of the display puts a window, on the 12 × 12 zone grid, the
// same on every page: a corner a quarter, a side a half, the middle the whole display.
internal fun snapZone(fx: Float, fy: Float): JSONObject? {
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null
    val e = 0.3f
    val z = { x: Int, y: Int, w: Int, h: Int -> JSONObject().put("x", x).put("y", y).put("w", w).put("h", h) }
    val left = fx < e; val right = fx > 1 - e; val top = fy < e; val bottom = fy > 1 - e
    return when {
        left && top -> z(0, 0, 6, 6)
        right && top -> z(6, 0, 6, 6)
        left && bottom -> z(0, 6, 6, 6)
        right && bottom -> z(6, 6, 6, 6)
        left -> z(0, 0, 6, 12)
        right -> z(6, 0, 6, 12)
        top -> z(0, 0, 12, 6)
        bottom -> z(0, 6, 12, 6)
        else -> z(0, 0, 12, 12)
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
