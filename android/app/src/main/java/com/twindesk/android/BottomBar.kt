// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's bottom bar. A destination keeps the width of its label, so a narrow phone, a larger
// font, extra pages, or the Search button cannot slice the word. No Core and no network: the
// window passes the labels it already has.
package com.twindesk.android

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// One destination. The window passes the label it already resolved.
internal data class BottomDest(
    val label: String,
    val icon: ImageVector,
    val selected: Boolean,
    val dot: Boolean,
    val onClick: () -> Unit,
)

// The floating bar and, when [search] is set, the round button beside it (the same insets as the phone).
@Composable
internal fun PhoneBottomChrome(dests: List<BottomDest>, search: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 10.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        PhoneBottomBar(dests)
        if (search != null) {
            Spacer(Modifier.width(10.dp))
            search()
        }
    }
}

private data class BottomSlots(val widths: List<Dp>, val gap: Dp, val scroll: Boolean)

// [budget] is the bar's inner width. Each slot is at least 48dp and wide enough for the measured
// word. When they fit, the gap opens up to 8dp. When they do not, the row scrolls and a window
// that contains the selected label is shown whole.
private fun bottomSlots(textWidths: List<Dp>, budget: Dp): BottomSlots {
    if (textWidths.isEmpty()) return BottomSlots(emptyList(), 0.dp, false)
    val room = budget.coerceAtLeast(0.dp)
    val base = textWidths.map { w -> maxOf(48.dp, w + 4.dp).let { if (room >= 48.dp) minOf(it, room) else it } }
    val n = base.size
    val sum = base.fold(0.dp) { acc, w -> acc + w }
    val gaps = n - 1
    if (gaps == 0) return BottomSlots(listOf(maxOf(base[0], room)), 0.dp, base[0] > room)
    if (sum <= room) {
        val gap = ((room - sum) / gaps).coerceIn(0.dp, 8.dp)
        val extra = ((room - sum - gap * gaps) / n).coerceAtLeast(0.dp)
        return BottomSlots(base.map { it + extra }, gap, false)
    }
    return BottomSlots(base, 0.dp, true)
}

// Where the spare goes so the chosen run is on screen as whole words. A spare after the run
// (the run is not the end) lets it sit flush left. A spare before the run (the run is the end,
// and shorter than the bar) lets the row sit flush right, instead of leaving the previous word
// cut on the left.
private data class BottomSpare(val at: Int, val px: Int, val scrollPx: Int)

private fun bottomSpare(widthsPx: List<Int>, viewportPx: Int, window: IntRange, scroll: Boolean): BottomSpare {
    if (!scroll || widthsPx.isEmpty() || window.first > window.last) return BottomSpare(-1, 0, 0)
    val windowPx = widthsPx.subList(window.first, window.last + 1).sum()
    val sparePx = (viewportPx - windowPx).coerceAtLeast(0)
    val coversEnd = window.last == widthsPx.lastIndex
    val at = when {
        sparePx == 0 -> -1
        coversEnd && window.first > 0 -> window.first
        !coversEnd -> window.last + 1
        else -> -1
    }
    val before = if (window.first > 0) widthsPx.subList(0, window.first).sum() else 0
    // A run that ends on the last label sits flush right. ScrollState clamps this once measured.
    val scrollPx = if (at == window.first && coversEnd) Int.MAX_VALUE / 4 else before
    return BottomSpare(at, sparePx, scrollPx)
}

// The widest run of labels that fits in [viewport] and contains [selected].
private fun labelWindow(widths: List<Dp>, viewport: Dp, selected: Int): IntRange {
    var bestS = selected.coerceIn(0, widths.lastIndex)
    var bestE = bestS
    var bestCount = 1
    for (s in widths.indices) {
        var sum = 0.dp
        for (e in s..widths.lastIndex) {
            sum += widths[e]
            if (sum > viewport) break
            val count = e - s + 1
            if (selected in s..e && (count > bestCount || (count == bestCount && s < bestS))) {
                bestS = s
                bestE = e
                bestCount = count
            }
        }
    }
    return bestS..bestE
}

@Composable
private fun RowScope.PhoneBottomBar(dests: List<BottomDest>) {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    // LabelMedium is 12sp with 0.5sp tracking. SemiBold is the selected weight, and the wider one.
    val style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp)
    val textWidths = dests.map { d ->
        with(density) { measurer.measure(d.label, style = style, maxLines = 1, softWrap = false).size.width.toDp() }
    }
    BoxWithConstraints(
        Modifier.weight(1f).heightIn(min = 48.dp)
            .shadow(14.dp, RoundedCornerShape(28.dp), ambientColor = Color.Black.copy(alpha = 0.12f), spotColor = Color.Black.copy(alpha = 0.12f))
            .clip(RoundedCornerShape(28.dp)).background(pal.card)
            .onHold { NavOrder.open.value = true },
    ) {
        val slots = bottomSlots(textWidths, maxWidth)
        val selected = dests.indexOfFirst { it.selected }.let { if (it < 0) 0 else it }
        val window = if (slots.scroll) labelWindow(slots.widths, maxWidth, selected) else dests.indices
        val widthsPx = slots.widths.map { with(density) { it.roundToPx() } }
        val spare = bottomSpare(widthsPx, with(density) { maxWidth.roundToPx() }, window, slots.scroll)
        // Initial value is applied before the first draw. A new selection starts a new position.
        val scrollState = remember(spare.scrollPx) { ScrollState(spare.scrollPx) }
        Row(
            Modifier.then(if (slots.scroll) Modifier.horizontalScroll(scrollState) else Modifier),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            dests.forEachIndexed { i, d ->
                if (i > 0 && slots.gap > 0.dp) Spacer(Modifier.width(slots.gap))
                if (i == spare.at && spare.px > 0) Spacer(Modifier.exactWidth(spare.px))
                BottomDestItem(d, slots.widths[i])
            }
        }
    }
}

// A spacer at an exact pixel width, so the next word starts on the clip instead of a pixel early.
private fun Modifier.exactWidth(px: Int): Modifier = layout { measurable, constraints ->
    val w = px.coerceAtLeast(0)
    val placeable = measurable.measure(constraints.copy(minWidth = w, maxWidth = w))
    layout(w, placeable.height) { placeable.place(0, 0) }
}

@Composable
private fun BottomDestItem(dest: BottomDest, width: Dp) {
    val pill = minOf(56.dp, (width - 12.dp).coerceAtLeast(32.dp))
    Column(
        Modifier.width(width).heightIn(min = 48.dp)
            .clickable(role = Role.Tab, onClick = dest.onClick)
            .semantics { selected = dest.selected }
            .padding(top = 12.dp, bottom = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // 12dp above and 20dp below keep the icon and the label inside the 28dp corner.
        Box(Modifier.height(32.dp).width(pill), contentAlignment = Alignment.Center) {
            if (dest.selected) Box(Modifier.fillMaxSize().clip(RoundedCornerShape(50)).background(pal.accentSoft))
            Box {
                Icon(dest.icon, null, tint = if (dest.selected) pal.accent else pal.muted, modifier = Modifier.size(24.dp))
                if (dest.dot) Box(Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-2).dp)) { Dot(pal.good, 7) }
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(
            dest.label,
            color = if (dest.selected) pal.text else pal.muted,
            fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.5.sp,
            fontWeight = if (dest.selected) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            modifier = Modifier.width(width),
        )
    }
}
