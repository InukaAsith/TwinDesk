// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac viewer's overlay; its size never changes the WebView or the Extend display.
package com.twindesk.android

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val chrome = Color(0xF5232427)
private val border = Color(0xFF494A4F)
private val muted = Color(0xFFC4C7CD)
private val accent = Color(0xFFA9C9FF)
private val chromeShape = RoundedCornerShape(17.dp)
private val menuColors = darkColorScheme(
    surface = Color(0xFF27282B), surfaceContainer = Color(0xFF27282B),
    onSurface = Color.White, onSurfaceVariant = muted, primary = accent,
)

@Composable
internal fun MacViewerToolbar(
    title: String,
    detail: String,
    menu: String,
    onMenu: (String) -> Unit,
    canDisplay: Boolean,
    canScale: Boolean,
    scale: String,
    canResolution: Boolean,
    resolution: String,
    onResolution: (Int) -> Unit,
    onScale: (String) -> Unit,
    sheetReady: Boolean,
    onOverview: () -> Unit,
    showModes: Boolean,
    mode: String,
    displays: List<MacDisplay>,
    displayId: String,
    spaces: Boolean,
    onMode: (String) -> Unit,
    onDisplay: (String) -> Unit,
    onSpace: (String) -> Unit,
    keyboard: Boolean,
    onKeyboard: () -> Unit,
    touchpad: Boolean,
    onTouchpad: (Boolean) -> Unit,
    audio: Boolean,
    onAudio: (Boolean) -> Unit,
    autoRotate: Boolean,
    onRotate: () -> Unit,
    onScreenshot: () -> Unit,
    onStop: (() -> Unit)?,
    onClose: () -> Unit,
    onOpenLogin: (() -> Unit)? = null,
) {
    MaterialTheme(colorScheme = menuColors) {
        BoxWithConstraints {
            val inline = maxWidth >= 404.dp && androidx.compose.ui.platform.LocalDensity.current.fontScale < 1.35f
            Column(Modifier.widthIn(max = 520.dp).clip(chromeShape).background(chrome).border(1.dp, border, chromeShape)
                .padding(horizontal = 6.dp, vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                if (!inline) ViewerTitle(title, detail, Modifier.padding(top = 4.dp, start = 8.dp, end = 8.dp, bottom = 1.dp), centered = true)
                Row(horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    if (inline) ViewerTitle(title, detail, Modifier.padding(start = 10.dp, end = 8.dp).widthIn(min = 126.dp, max = 224.dp), centered = false)
                    if (canDisplay || spaces) Box {
                        ViewerTool(tr("Displays & desktops"), Ico.display, menu == "display") {
                            if (sheetReady) onOverview() else onMenu("display")
                        }
                        DropdownMenu(expanded = menu == "display" && !sheetReady, onDismissRequest = { onMenu("") }) {
                            if (showModes) {
                                ViewerChoice(tr("Mirror"), mode == "mirror", onMenu) { onMode("mirror") }
                                ViewerChoice(tr("Extend"), mode == "extend", onMenu) { onMode("extend") }
                            }
                            if (displays.size > 1) {
                                HorizontalDivider()
                                for (display in displays) ViewerChoice(display.label(), display.id == displayId && mode != "extend", onMenu) { onDisplay(display.id) }
                            }
                            if (spaces) {
                                HorizontalDivider()
                                ViewerChoice(tr("Previous desktop"), false, onMenu) { onSpace("prev") }
                                ViewerChoice(tr("Next desktop"), false, onMenu) { onSpace("next") }
                            }
                        }
                    }
                    if (canScale) Box {
                        ViewerTool(tr("View options"), Ico.viewScale, menu == "view") { onMenu("view") }
                        DropdownMenu(expanded = menu == "view", onDismissRequest = { onMenu("") }) {
                            ViewerMenuLabel(tr("Scale"))
                            ViewerChoice(tr("Fit"), scale == "fit", onMenu) { onScale("fit") }
                            ViewerChoice(tr("Fill"), scale == "fill", onMenu) { onScale("fill") }
                            ViewerChoice(tr("Actual size") + " · 100%", scale == "actual", onMenu) { onScale("actual") }
                            if (canResolution) {
                                HorizontalDivider()
                                ViewerMenuLabel(tr("Resolution"))
                                for ((value, label) in listOf(1080 to "1080p", 1440 to "1440p", 2160 to "4K", 0 to tr("Full"))) {
                                    ViewerChoice(label, resolution == value.toString(), onMenu) { onResolution(value) }
                                }
                            }
                        }
                    }
                    ViewerTool(if (keyboard) tr("Hide keyboard") else tr("Keyboard"), Ico.keyboard, keyboard, onKeyboard)
                    Box {
                        ViewerTool(tr("More"), Ico.more, menu == "more") { onMenu("more") }
                        DropdownMenu(expanded = menu == "more", onDismissRequest = { onMenu("") }) {
                            if (canScale) {
                                ViewerChoice(tr("Touchpad"), touchpad, onMenu) { onTouchpad(true) }
                                ViewerChoice(tr("Direct touch"), !touchpad, onMenu) { onTouchpad(false) }
                                HorizontalDivider()
                            }
                            ViewerChoice(tr("Sound"), audio, onMenu) { onAudio(!audio) }
                            ViewerChoice(tr("Auto-rotate"), autoRotate, onMenu, onRotate)
                            ViewerChoice(tr("Screenshot"), false, onMenu, onScreenshot)
                            if (onOpenLogin != null) ViewerChoice(tr("Open Mac login screen"), false, onMenu, onOpenLogin)
                            if (onStop != null) {
                                HorizontalDivider()
                                ViewerChoice(tr("Stop"), false, onMenu, onStop)
                            }
                        }
                    }
                    ViewerTool(tr("Close"), Ico.close, false, onClose)
                }
            }
        }
    }
}

@Composable
private fun ViewerTitle(title: String, detail: String, modifier: Modifier, centered: Boolean) {
    Column(modifier, horizontalAlignment = if (centered) Alignment.CenterHorizontally else Alignment.Start) {
        Text(title, color = Color.White, fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(detail, color = muted, fontSize = 11.sp, lineHeight = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ViewerTool(label: String, icon: ImageVector, active: Boolean, click: () -> Unit) {
    Box(Modifier.size(48.dp).clip(RoundedCornerShape(11.dp))
        .background(if (active) Color(0x334E8BD9) else Color.Transparent)
        .clickable(role = Role.Button, onClick = click), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = if (active) accent else Color.White, modifier = Modifier.size(22.dp))
    }
}

@Composable
private fun ViewerMenuLabel(label: String) {
    Text(label, color = muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 2.dp))
}

@Composable
private fun ViewerChoice(label: String, selected: Boolean, onMenu: (String) -> Unit, click: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label, color = if (selected) accent else Color.White) },
        trailingIcon = if (selected) ({ Icon(Ico.check, null, tint = accent, modifier = Modifier.size(18.dp)) }) else null,
        modifier = if (selected) Modifier.semantics { this.selected = true } else Modifier,
        onClick = { onMenu(""); click() },
    )
}
