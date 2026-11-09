// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Media page: Play — what plays on the computer (PcMedia.kt), its controls, and whether it shows
// in this phone's notification shade; Devices — every device's volume in one place: the computer's
// (dev.do volume, DevCtl.kt) and each of this phone's sounds (media, calls, ringer, notifications, alarms).
package com.twindesk.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

@Composable
fun MediaPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v // redraw on every Core change (Compose skips unread parameters)
    val name = core.host?.name ?: core.hosts().firstOrNull()?.name ?: tr("the computer")
    var tab by rememberSaveable { mutableStateOf("play") }
    // Open: the computer sends what plays even with the notification off.
    DisposableEffect(Unit) {
        core.pcMedia.page(true)
        onDispose { core.pcMedia.page(false) }
    }
    PageHead(tr("Media"), tr("Control what plays on {name}, and every device’s volume.", "name" to name))
    Segments(listOf("play" to tr("Play"), "devices" to tr("Devices")), tab) { tab = it }
    Spacer(Modifier.height(14.dp))
    if (tab == "play") PlayTab(core, name) else DevicesTab(core, name)
}

// Two or more tabs in a pill, the selected one filled (TwinDesk's segmented control).
@Composable
private fun Segments(items: List<Pair<String, String>>, selected: String, onPick: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(50)).background(pal.chip).padding(4.dp)) {
        for ((id, label) in items) {
            val on = id == selected
            Box(
                Modifier.weight(1f).height(38.dp).clip(RoundedCornerShape(50)).background(if (on) pal.card else Color.Transparent).clickable { onPick(id) },
                contentAlignment = Alignment.Center,
            ) { Text(label, color = if (on) pal.text else pal.muted, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium, fontSize = 14.sp) }
        }
    }
}

@Composable
private fun PlayTab(core: Core, name: String) {
    val m = core.pcMedia
    val now = m.now
    if (core.host == null) Note(tr("Connect to {name} to view and control its media.", "name" to name))
    MacCard {
        Column(Modifier.fillMaxWidth().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            // The art: the computer doesn't send any, so the app's place in TwinDesk's colours.
            Box(
                Modifier.fillMaxWidth(0.62f).aspectRatio(1f).clip(RoundedCornerShape(28.dp))
                    .background(Brush.linearGradient(listOf(Color(0xFFFF6482), Color(0xFFBF5AF2), Color(0xFF0A84FF)))),
                contentAlignment = Alignment.Center,
            ) { Icon(Ico.media, null, tint = Color.White.copy(alpha = 0.9f), modifier = Modifier.size(72.dp)) }
            Spacer(Modifier.height(18.dp))
            Text(now?.title ?: tr("Nothing playing"), color = pal.text, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
            val sub = listOfNotNull(now?.artist?.ifEmpty { null }, now?.app?.ifEmpty { null }).joinToString(" · ")
            Text(
                if (now == null) (if (core.host != null) tr("Play something on {name}", "name" to name) else tr("Not connected")) else sub.ifEmpty { name },
                color = pal.muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp),
            )
            Spacer(Modifier.height(20.dp))
            val enabled = core.host != null && now != null
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                RoundButton(Ico.prev, tr("Previous"), enabled, big = false) { m.control("previous") }
                RoundButton(if (now?.playing == true) Ico.pause else Ico.play, if (now?.playing == true) tr("Pause") else tr("Play"), enabled, big = true) { m.control("toggle") }
                RoundButton(Ico.next, "Next", enabled, big = false) { m.control("next") }
            }
        }
    }
    ComputerVolume(core, name)
    MacCard {
        SwitchRow(tr("Show in the notification shade"), tr("What plays on {name} appears with this phone’s media controls", "name" to name), m.notifOn, first = true) { m.setNotif(it) }
    }
    Note(
        when (core.host?.os) {
            "mac" -> tr("On a Mac, TwinDesk sees any app in its Now Playing, YouTube in a browser too.")
            "linux" -> tr("On Linux, TwinDesk sees any player that supports MPRIS (most do), through playerctl.")
            else -> tr("TwinDesk controls the player shown in Windows media controls, such as browsers, Spotify and Media Player.")
        },
    )
}

@Composable
private fun RoundButton(icon: ImageVector, label: String, enabled: Boolean, big: Boolean, onClick: () -> Unit) {
    val size = if (big) 76.dp else 56.dp
    Box(
        Modifier.size(width = if (big) 112.dp else size, height = size).clip(if (big) RoundedCornerShape(28.dp) else CircleShape)
            .background(if (big) pal.accent.copy(alpha = if (enabled) 1f else 0.35f) else pal.chip)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = if (big) Color.White else pal.text.copy(alpha = if (enabled) 1f else 0.4f), modifier = Modifier.size(if (big) 30.dp else 24.dp)) }
}

@Composable
private fun ComputerVolume(core: Core, name: String, first: Boolean = true, inCard: Boolean = true) {
    val c = core.dev.computer
    val level = c?.optDouble("volume", -1.0) ?: -1.0
    val can = c?.optJSONObject("can")?.optBoolean("volume", level >= 0) ?: false
    val row = @Composable {
        when {
            core.host == null -> MacRow(name, tr("Not connected"), first = first)
            c == null -> MacRow(name, tr("Waiting for {name}…", "name" to name), first = first)
            !can || level < 0 -> MacRow(name, tr("Volume control requires a newer version of TwinDesk on {name}.", "name" to name), first = first)
            else -> VolumeRow(name, Ico.display, level.toFloat(), first) { core.dev.ask("volume", "level" to it.toDouble()) }
        }
    }
    if (inCard) MacCard(tr("Volume")) { row() } else row()
}

// A device or sound: its name over a full-width slider, the level on the right.
@Composable
private fun VolumeRow(label: String, icon: ImageVector, value: Float, first: Boolean, onDone: (Float) -> Unit) {
    var v by remember(value) { mutableFloatStateOf(value) }
    Column {
        if (!first) Box(Modifier.padding(horizontal = 20.dp).fillMaxWidth().height(0.5.dp).background(pal.line))
        Column(Modifier.padding(horizontal = 20.dp, vertical = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, tint = pal.accent, modifier = Modifier.size(18.dp))
                Text(label, color = pal.text, fontSize = 15.sp, modifier = Modifier.padding(start = 8.dp).weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${(v * 100).roundToInt()}%", color = pal.muted, fontSize = 13.sp, modifier = Modifier.width(48.dp), textAlign = TextAlign.End)
            }
            Slider(v, { v = it }, valueRange = 0f..1f, onValueChangeFinished = { onDone(v) },
                colors = SliderDefaults.colors(thumbColor = Color.White, activeTrackColor = pal.accent, inactiveTrackColor = pal.trackOff))
        }
    }
}

private val STREAMS get() = listOf(
    AudioManager.STREAM_MUSIC to tr("Media"),
    AudioManager.STREAM_VOICE_CALL to tr("Calls"),
    AudioManager.STREAM_RING to tr("Ringer"),
    AudioManager.STREAM_NOTIFICATION to tr("Notifications"),
    AudioManager.STREAM_ALARM to tr("Alarms"),
)

@Composable
private fun DevicesTab(core: Core, name: String) {
    val ctx = LocalContext.current
    val audio = remember { ctx.getSystemService(AudioManager::class.java) }
    // The phone's own volume keys (or another app) change these: follow them.
    var bump by remember { mutableIntStateOf(0) }
    DisposableEffect(Unit) {
        val r = object : BroadcastReceiver() { override fun onReceive(c: Context, i: Intent) { bump++ } }
        ctx.registerReceiver(r, IntentFilter("android.media.VOLUME_CHANGED_ACTION"))
        onDispose { runCatching { ctx.unregisterReceiver(r) } }
    }
    @Suppress("UNUSED_EXPRESSION") bump
    MacCard(name) { ComputerVolume(core, name, first = true, inCard = false) }
    MacCard(core.store.deviceName) {
        STREAMS.forEachIndexed { i, (stream, label) ->
            val max = audio.getStreamMaxVolume(stream).coerceAtLeast(1)
            val now = audio.getStreamVolume(stream).toFloat() / max
            VolumeRow(label, if (i == 0) Ico.media else if (i == 1) Ico.call else Ico.bell, now, i == 0) { lv ->
                // The ringer and notifications may be refused in Do not disturb (no policy access).
                runCatching { audio.setStreamVolume(stream, (lv * max).roundToInt(), 0) }
                bump++
            }
        }
    }
    Note(tr("Changes apply to the main output on {name}. The phone’s volume buttons also adjust these sliders.", "name" to name))
}
