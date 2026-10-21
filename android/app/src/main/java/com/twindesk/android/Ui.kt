// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The building blocks of the app's window, drawn like TwinDesk on the Mac (mac/control.css):
// the same colours in light and dark, a sidebar of coloured icon tiles in groups, cards of rows
// (label and hint on the left, the control on the right), page headings with one main switch,
// the direction cards ("Mac → Tablet") and the layout picker.
package com.twindesk.android

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ---- colours (mac/control.css :root) ----

data class Palette(
    val accent: Color, val accentSoft: Color, val content: Color, val sidebar: Color, val card: Color, val line: Color,
    val text: Color, val muted: Color, val faint: Color, val good: Color, val warn: Color, val bad: Color, val trackOff: Color, val hover: Color,
)

private val Light = Palette(
    accent = Color(0xFF0A84FF), accentSoft = Color(0x1F0A84FF), content = Color(0xFFF2F2F5), sidebar = Color(0xFFE8E8ED), card = Color.White,
    line = Color(0x14000000), text = Color(0xFF1D1D1F), muted = Color(0xFF6E6E73), faint = Color(0xFFA1A1A6),
    good = Color(0xFF30B94D), warn = Color(0xFFE8A10C), bad = Color(0xFFE5373A), trackOff = Color(0x1F000000), hover = Color(0x0D000000),
)
private val Dark = Palette(
    accent = Color(0xFF0A84FF), accentSoft = Color(0x380A84FF), content = Color(0xFF1E1E1F), sidebar = Color(0xFF2B2B2D), card = Color(0xFF2A2A2C),
    line = Color(0x12FFFFFF), text = Color(0xFFF5F5F7), muted = Color(0xFF98989D), faint = Color(0xFF6C6C70),
    good = Color(0xFF32D74B), warn = Color(0xFFFFB340), bad = Color(0xFFFF453A), trackOff = Color(0x29FFFFFF), hover = Color(0x0FFFFFFF),
)

val LocalPalette = staticCompositionLocalOf { Light }
val pal: Palette @Composable get() = LocalPalette.current

@Composable
fun Theme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val p = if (dark) Dark else Light
    val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
        primary = p.accent, onPrimary = Color.White, surface = p.content, background = p.content,
        onSurface = p.text, onSurfaceVariant = p.muted, outline = p.faint, surfaceContainer = p.card,
        primaryContainer = p.accentSoft, onPrimaryContainer = p.accent, secondaryContainer = p.accentSoft, onSecondaryContainer = p.accent,
    )
    CompositionLocalProvider(LocalPalette provides p) { MaterialTheme(colorScheme = scheme, content = content) }
}

// ---- icons: mac/control.js ICONS, the same 20×20 line drawings ----

private fun lineIcon(name: String, d: String): ImageVector = ImageVector.Builder(name, 24.dp, 24.dp, 20f, 20f).apply {
    addPath(
        pathData = PathParser().parsePathString(d).toNodes(), fill = null, stroke = SolidColor(Color.Black),
        strokeLineWidth = 1.8f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
    )
}.build()

object Ico {
    val overview = lineIcon("overview", "M3 9.5 10 4l7 5.5V17H3z M8 17v-4h4v4")
    val display = lineIcon("display", "M3 4h14v9H3z M7 17h6 M10 13v4")
    val cursor = lineIcon("cursor", "M5 3l10 6-4.5 1.2L8.5 15z")
    val keyboard = lineIcon("keyboard", "M2.5 6h15v8h-15z M5.5 9h1 M8.5 9h1 M11.5 9h1 M14.5 9h0 M6.5 11.5h7")
    val clipboard = lineIcon("clipboard", "M6 4h8v13H6z M8 3h4v2.5H8z M8 9h4 M8 12h4")
    val files = lineIcon("files", "M3 5h5l1.5 2H17v9H3z")
    val audio = lineIcon("audio", "M4 8h3l4-3v10l-4-3H4z M14 7.5c1 .8 1 4.2 0 5 M16 5.5c2.2 1.8 2.2 7.2 0 9")
    val general = lineIcon("general", "M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M10 2.5v2 M10 15.5v2 M2.5 10h2 M15.5 10h2 M4.7 4.7l1.4 1.4 M13.9 13.9l1.4 1.4 M4.7 15.3l1.4-1.4 M13.9 6.1l1.4-1.4")
    val about = lineIcon("about", "M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z M10 9v5 M10 6.2v.1")
    val bell = lineIcon("bell", "M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0")
    val phone = lineIcon("phone", "M6.5 2.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M9 15h2")
    val more = lineIcon("more", "M4.5 10h.1 M10 10h.1 M15.5 10h.1")
    val call = lineIcon("call", "M6 3h2.5l1.2 3.2-1.7 1.3a9 9 0 0 0 4.5 4.5l1.3-1.7 3.2 1.2V16a1 1 0 0 1-1 1A13 13 0 0 1 3 4a1 1 0 0 1 1-1z")
    val message = lineIcon("message", "M3 4.5h14v9H8.5L5 16.5v-3H3z")
    val photo = lineIcon("photo", "M3 4.5h14v11H3z M3 13l4-4 3.5 3.5 2-2L17 14.5 M12.5 7.5h.1")
    val folder = lineIcon("folder", "M2.5 5h5.5l1.5 2h8v9.5h-15z")
}

// A sidebar tile: the icon in white on its section's gradient (the Mac's `.tile`).
@Composable
fun Tile(icon: ImageVector, colors: List<Color>, size: Int = 26) {
    Box(
        Modifier.size(size.dp).clip(RoundedCornerShape((size * 0.27f).dp)).background(Brush.verticalGradient(colors)),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = Color.White, modifier = Modifier.size((size * 0.66f).dp)) }
}

@Composable
fun Logo(size: Int) = Image(painterResource(R.drawable.twindesk_logo), "TwinDesk", Modifier.size(size.dp))

@Composable
fun Dot(color: Color, size: Int = 8) = Box(Modifier.size(size.dp).clip(CircleShape).background(color))

// One sidebar entry (the Mac's `.nav-item`): tile, label, and a green dot when the feature is on.
@Composable
fun NavItem(icon: ImageVector, colors: List<Color>, label: String, selected: Boolean, on: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(40.dp).clip(RoundedCornerShape(8.dp)).alpha(if (enabled) 1f else 0.4f)
            .background(if (selected) pal.accent else Color.Transparent).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Tile(icon, colors)
        Text(label, color = if (selected) Color.White else pal.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 10.dp).weight(1f))
        if (on) Dot(if (selected) Color.White else pal.good, 7)
    }
}

// ---- page parts ----

@Composable
fun PageHead(title: String, desc: String, master: Boolean? = null, onMaster: (Boolean) -> Unit = {}) {
    Row(verticalAlignment = Alignment.Top, modifier = Modifier.padding(bottom = 14.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 26.sp, fontWeight = FontWeight.Bold, color = pal.text)
            if (desc.isNotEmpty()) Text(desc, color = pal.muted, fontSize = 14.sp, modifier = Modifier.padding(top = 2.dp))
        }
        if (master != null) MacSwitch(master, onMaster)
    }
}

@Composable
fun MacSwitch(on: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true) = Switch(
    checked = on, onCheckedChange = onChange, enabled = enabled,
    colors = SwitchDefaults.colors(
        checkedTrackColor = pal.accent, checkedThumbColor = Color.White, checkedBorderColor = Color.Transparent,
        uncheckedTrackColor = pal.trackOff, uncheckedThumbColor = Color.White, uncheckedBorderColor = Color.Transparent,
    ),
)

// A card with an optional title above it (the Mac's `.card-wrap`).
@Composable
fun MacCard(title: String = "", modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.padding(bottom = 16.dp)) {
        if (title.isNotEmpty()) Text(title, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = pal.text, modifier = Modifier.padding(start = 2.dp, bottom = 6.dp))
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(pal.card).border(BorderStroke(1.dp, pal.line), RoundedCornerShape(12.dp)),
            content = content,
        )
    }
}

// A row: label and hint on the left, controls on the right; a hairline between rows. Controls too
// wide to leave the label room (under ~half the row) go on their own line under it, at the right.
@Composable
fun MacRow(label: String, hint: String = "", first: Boolean = false, onClick: (() -> Unit)? = null, controls: @Composable RowScope.() -> Unit = {}) {
    Column {
        if (!first) Box(Modifier.padding(start = 16.dp).fillMaxWidth().height(1.dp).background(pal.line))
        Layout(
            content = {
                Column {
                    Text(label, color = pal.text, fontSize = 15.sp)
                    if (hint.isNotEmpty()) Text(hint, color = pal.muted, fontSize = 12.5.sp, modifier = Modifier.padding(top = 1.dp))
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), content = controls)
            },
            modifier = Modifier.fillMaxWidth().let { if (onClick != null) it.clickable(onClick = onClick) else it }.padding(horizontal = 16.dp, vertical = 12.dp),
        ) { ms, c ->
            val w = c.maxWidth
            val ctl = ms[1].measure(Constraints(maxWidth = w))
            val gap = if (ctl.width > 0) 12.dp.roundToPx() else 0
            if (w - ctl.width - gap >= w * 0.45f) {
                val lbl = ms[0].measure(Constraints(maxWidth = w - ctl.width - gap))
                val h = maxOf(lbl.height, ctl.height)
                layout(w, h) {
                    lbl.place(0, (h - lbl.height) / 2)
                    ctl.place(w - ctl.width, (h - ctl.height) / 2)
                }
            } else {
                val lbl = ms[0].measure(Constraints(maxWidth = w))
                val v = 10.dp.roundToPx()
                layout(w, lbl.height + v + ctl.height) {
                    lbl.place(0, 0)
                    ctl.place(w - ctl.width, lbl.height + v)
                }
            }
        }
    }
}

@Composable
fun SwitchRow(label: String, hint: String, on: Boolean, first: Boolean = false, enabled: Boolean = true, onChange: (Boolean) -> Unit) =
    MacRow(label, hint, first) { MacSwitch(on, onChange, enabled) }

// A note in a tinted box (the Mac's `.note`): info, warn or bad.
@Composable
fun Note(text: String, kind: String = "info") {
    if (text.isEmpty()) return
    val bg = when (kind) { "bad" -> pal.bad.copy(alpha = 0.12f); "warn" -> pal.warn.copy(alpha = 0.14f); else -> pal.accentSoft }
    Text(text, color = pal.text, fontSize = 13.5.sp, modifier = Modifier.fillMaxWidth().padding(bottom = 14.dp).clip(RoundedCornerShape(10.dp)).background(bg).padding(12.dp))
}

@Composable
fun Pill(text: String, kind: String = "") {
    val c = when (kind) { "good" -> pal.good; "bad" -> pal.bad; "muted" -> pal.muted; else -> pal.accent }
    Text(text, color = c, fontSize = 12.sp, fontWeight = FontWeight.Medium, modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(c.copy(alpha = 0.14f)).padding(horizontal = 9.dp, vertical = 2.dp))
}

// A direction card's head: device glyph + name, an arrow line, the other device (the Mac's `.dir-head`).
@Composable
fun DirHead(from: String, fromPhone: Boolean, to: String, toPhone: Boolean) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(if (fromPhone) Ico.phone else Ico.display, null, tint = pal.accent, modifier = Modifier.size(18.dp))
        Text(from, fontWeight = FontWeight.SemiBold, color = pal.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp).weight(1f, false))
        Box(Modifier.weight(1f).padding(horizontal = 10.dp).height(2.dp).clip(RoundedCornerShape(1.dp)).background(Brush.horizontalGradient(listOf(pal.accent.copy(alpha = 0.3f), pal.accent))))
        Text("›", color = pal.accent, fontWeight = FontWeight.Bold, modifier = Modifier.padding(end = 8.dp))
        Icon(if (toPhone) Ico.phone else Ico.display, null, tint = pal.muted, modifier = Modifier.size(18.dp))
        Text(to, fontWeight = FontWeight.SemiBold, color = pal.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp).weight(1f, false))
    }
}

@Composable
fun MacSlider(value: Float, range: ClosedFloatingPointRange<Float>, steps: Int, format: (Float) -> String, onDone: (Float) -> Unit) {
    var v by remember(value) { mutableFloatStateOf(value) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Slider(v, { v = it }, valueRange = range, steps = steps, onValueChangeFinished = { onDone(v) }, modifier = Modifier.width(170.dp),
            colors = SliderDefaults.colors(thumbColor = Color.White, activeTrackColor = pal.accent, inactiveTrackColor = pal.trackOff))
        Text(format(v), color = pal.muted, fontSize = 13.sp, modifier = Modifier.width(52.dp), textAlign = TextAlign.End)
    }
}

// The layout picker (the Mac's Cursor page): this device in the middle, a slot on each side for
// the computer; tap a side to move it there.
@Composable
fun LayoutPicker(me: String, other: String, side: String, onPick: (String) -> Unit) {
    @Composable
    fun Slot(s: String, modifier: Modifier) {
        val on = side == s
        Box(
            modifier.clip(RoundedCornerShape(8.dp))
                .background(if (on) pal.accentSoft else Color.Transparent)
                .border(BorderStroke(if (on) 2.dp else 1.dp, if (on) pal.accent else pal.faint.copy(alpha = 0.6f)), RoundedCornerShape(8.dp))
                .clickable { onPick(s) },
            contentAlignment = Alignment.Center,
        ) { if (on) Text(other, color = pal.accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, textAlign = TextAlign.Center, modifier = Modifier.padding(4.dp)) }
    }
    Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Slot("top", Modifier.width(150.dp).height(44.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Slot("left", Modifier.width(90.dp).height(100.dp))
            Box(
                Modifier.width(150.dp).height(100.dp).clip(RoundedCornerShape(8.dp)).background(pal.accent),
                contentAlignment = Alignment.Center,
            ) { Text(me, color = Color.White, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.padding(6.dp)) }
            Slot("right", Modifier.width(90.dp).height(100.dp))
        }
        Slot("bottom", Modifier.width(150.dp).height(44.dp))
        val where = mapOf("left" to "to the left of", "right" to "to the right of", "top" to "above", "bottom" to "below")[side]
        Text("$other is $where $me. Tap a side to move it.", color = pal.muted, fontSize = 13.sp, textAlign = TextAlign.Center)
    }
}
