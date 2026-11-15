// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Arrange: the pages in the order the person likes, and how many of them sit in the bottom bar
// (the rest under More; the tablet's sidebar in the same order). General and About stay last.
// Opened from General › Bottom bar, or by holding the bar. As the computers' Arrange
// (shared/ui-arrange.js).
package com.twindesk.android

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONArray
import org.json.JSONObject

object NavOrder {
    private const val KEY = "nav.order"
    const val MIN_BAR = 2
    const val MAX_BAR = 5
    val open = mutableStateOf(false) // the Arrange dialog
    val version = mutableIntStateOf(0) // bumped on a change: the bar and lists redraw

    data class Saved(val order: List<String>, val bar: Int)

    fun load(store: Store): Saved? = runCatching {
        val o = JSONObject(store.prefsString(KEY, ""))
        val a = o.getJSONArray("order")
        Saved((0 until a.length()).map { a.getString(it) }.distinct(), o.optInt("bar", 4).coerceIn(MIN_BAR, MAX_BAR))
    }.getOrNull()?.takeIf { it.order.isNotEmpty() }

    fun save(store: Store, order: List<String>, bar: Int) {
        store.setPrefsString(KEY, JSONObject().put("order", JSONArray(order)).put("bar", bar.coerceIn(MIN_BAR, MAX_BAR)).toString())
        version.intValue++
    }

    fun reset(store: Store) { store.setPrefsString(KEY, ""); store.setFlag(SEARCH, false); version.intValue++ }

    // The round Search button beside the bar (More's search field stays either way).
    private const val SEARCH = "nav.search"
    fun searchButton(store: Store) = store.flag(SEARCH, false) // off unless chosen
    fun setSearchButton(store: Store, on: Boolean) { store.setFlag(SEARCH, on); version.intValue++ }

    // ids in their default order → the saved one; a page new since keeps its place after the one
    // it follows by default.
    fun <T> sort(store: Store, items: List<T>, id: (T) -> String): List<T> {
        val saved = load(store) ?: return items
        val rank = saved.order.withIndex().associate { it.value to it.index.toDouble() }
        var last = -1.0
        return items.map { t -> val k = rank[id(t)] ?: (last + 0.001); last = k; k to t }.sortedBy { it.first }.map { it.second }
    }
}

// One page in the dialog.
data class ArrangeItem(val id: String, val title: String, val icon: ImageVector, val colors: List<Color>)

// Holding (on the bottom bar): opens Arrange; the tab under the finger isn't tapped then.
fun Modifier.onHold(action: () -> Unit): Modifier = pointerInput(Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var held = true
        withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
            waitForUpOrCancellation(PointerEventPass.Initial)
            held = false
        }
        if (held) {
            action()
            while (true) {
                val e = awaitPointerEvent(PointerEventPass.Initial)
                e.changes.forEach { it.consume() }
                if (e.changes.none { it.pressed }) break
            }
        }
    }
}

@Composable
fun ArrangeDialog(store: Store, items: List<ArrangeItem>, barNow: Int, onClose: () -> Unit) {
    val list = remember { mutableStateListOf<ArrangeItem>().apply { addAll(items) } }
    var bar by remember { mutableIntStateOf(barNow.coerceIn(NavOrder.MIN_BAR, NavOrder.MAX_BAR)) }
    var search by remember { mutableStateOf(NavOrder.searchButton(store)) }
    AlertDialog(
        onDismissRequest = onClose,
        containerColor = pal.card,
        title = { Text(tr("Arrange the pages"), color = pal.text) },
        text = {
            Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState())) {
                Text(tr("The first ones are in the bottom bar, the rest under More."), color = pal.muted, fontSize = 13.sp)
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(tr("In the bar"), color = pal.text, fontSize = 15.sp, modifier = Modifier.weight(1f))
                    Step("−", bar > NavOrder.MIN_BAR) { bar-- }
                    Text("$bar", color = pal.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 10.dp))
                    Step("+", bar < NavOrder.MAX_BAR) { bar++ }
                }
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(tr("Search button"), color = pal.text, fontSize = 15.sp, modifier = Modifier.weight(1f))
                    MacSwitch(search, { search = it })
                }
                list.forEachIndexed { i, it ->
                    if (i == bar) Text(tr("Under More"), color = pal.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
                    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                        Tile(it.icon, it.colors, 26)
                        Text(it.title, color = pal.text, fontSize = 15.sp, maxLines = 1, modifier = Modifier.padding(start = 10.dp).weight(1f))
                        Step("↑", i > 0) { list.add(i - 1, list.removeAt(i)) }
                        Spacer(Modifier.size(6.dp))
                        Step("↓", i < list.lastIndex) { list.add(i + 1, list.removeAt(i)) }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { NavOrder.save(store, list.map { it.id }, bar); NavOrder.setSearchButton(store, search); onClose() }) { Text(tr("Done"), color = pal.accent) } },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { NavOrder.reset(store); onClose() }) { Text(tr("Reset"), color = pal.muted) }
                TextButton(onClick = onClose) { Text(tr("Cancel"), color = pal.muted) }
            }
        },
    )
}

@Composable
private fun Step(label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(32.dp).clip(RoundedCornerShape(50)).background(pal.chip).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = if (enabled) pal.text else pal.faint, fontSize = 16.sp) }
}
