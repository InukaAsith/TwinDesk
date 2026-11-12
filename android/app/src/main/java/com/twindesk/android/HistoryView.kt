// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// History's own view (History.kt): the clipboard's or the notifications', newest first, with a
// filter; a copied item is copied again with a tap. And the History card on the Clipboard and
// Notifications pages: Keep history, for how long, Open, and a shortcut on the Overview.
package com.twindesk.android

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.DateFormat
import java.util.Date

private fun ago(at: Long): String {
    val s = (System.currentTimeMillis() - at) / 1000
    return when {
        s < 60 -> tr("Just now")
        s < 3600 -> tr("{count} min ago", "count" to (s / 60))
        s < 86400 -> DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at))
        else -> DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(at))
    }
}

@Composable
fun HistoryScreen(core: Core, v: Int, what: String) {
    @Suppress("UNUSED_EXPRESSION") v
    val clip = what == "clip"
    val name = core.host?.name ?: tr("the computer")
    var q by rememberSaveable { mutableStateOf("") }
    val close = { History.view.value = null }
    androidx.activity.compose.BackHandler { close() }
    val all = if (clip) core.history.clip() else core.history.notifs()
    val list = if (q.isBlank()) all else all.filter { e -> listOf(e.text, e.title, e.app).any { it.contains(q.trim(), ignoreCase = true) } }
    Column(Modifier.fillMaxSize().background(pal.content).safeDrawingPadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 12.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("‹ " + tr("Back"), color = pal.accent, fontSize = 16.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { close() }.padding(10.dp))
            Box(Modifier.weight(1f))
            if (all.isNotEmpty()) Text(tr("Clear"), color = pal.bad, fontSize = 16.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { core.history.clear(what) }.padding(10.dp))
        }
        Text(if (clip) tr("Clipboard history") else tr("Notification history"), color = pal.text, fontSize = 28.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 20.dp))
        Text(
            if (core.history.save) tr("Kept encrypted on this device for {count} days", "count" to core.history.days) else tr("Since TwinDesk opened. Keep history on its page to keep it longer"),
            color = pal.muted, fontSize = 13.sp, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 10.dp),
        )
        Row(
            Modifier.padding(horizontal = 16.dp).fillMaxWidth().height(44.dp).clip(RoundedCornerShape(50)).background(pal.card).padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Ico.search, null, tint = pal.muted, modifier = Modifier.size(18.dp))
            Box(Modifier.padding(start = 8.dp).weight(1f)) {
                if (q.isEmpty()) Text(tr("Filter"), color = pal.faint, fontSize = 15.sp)
                BasicTextField(q, { q = it }, singleLine = true, textStyle = TextStyle(color = pal.text, fontSize = 15.sp), cursorBrush = SolidColor(pal.accent), modifier = Modifier.fillMaxWidth())
            }
        }
        if (list.isEmpty()) Text(if (all.isEmpty()) tr("Nothing yet") else tr("Nothing found"), color = pal.muted, fontSize = 14.sp, modifier = Modifier.padding(24.dp))
        LazyColumn(Modifier.fillMaxWidth().weight(1f).padding(horizontal = 16.dp, vertical = 8.dp)) {
            itemsIndexed(list, key = { i, e -> "$i:${e.at}" }) { i, e ->
                Column {
                    if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(pal.line))
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                            .then(if (clip) Modifier.clickable { core.clip.copyAgain(Clip.Item(e.dir, e.text)) } else Modifier)
                            .padding(horizontal = 6.dp, vertical = 11.dp),
                    ) {
                        if (!clip) Text(listOf(e.app, e.title).filter { it.isNotEmpty() }.joinToString(" · "), color = pal.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (e.text.isNotEmpty()) Text(e.text.replace('\n', ' '), color = if (clip) pal.text else pal.muted, fontSize = if (clip) 15.sp else 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        Text(
                            (if (clip) (if (e.dir == "in") tr("From {name}", "name" to name) else tr("To {name}", "name" to name)) + " · " else "") + ago(e.at) + (if (clip) tr(" · tap to copy") else ""),
                            color = pal.faint, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

// The History card on the Clipboard and Notifications pages.
@Composable
fun HistoryCard(core: Core, what: String) {
    val h = core.history
    val tile = if (what == "clip") "clipHistory" else "notifHistory"
    var pinned by remember { mutableStateOf(Tiles.has(core.store, tile)) }
    MacCard(tr("History")) {
        MacRow(
            if (what == "clip") tr("Clipboard history") else tr("Notification history"),
            tr("{count} items", "count" to (if (what == "clip") h.clip() else h.notifs()).size),
            first = true,
        ) {
            Button(
                onClick = { History.view.value = what }, shape = RoundedCornerShape(50), elevation = null, modifier = Modifier.height(40.dp),
                colors = ButtonDefaults.buttonColors(containerColor = pal.chip, contentColor = pal.text),
            ) { Text(tr("Open"), fontSize = 14.sp) }
        }
        SwitchRow(tr("Keep history"), if (h.save) tr("Encrypted on this device, with a key only TwinDesk can use") else tr("Off: forgotten when TwinDesk quits"), h.save) { h.setSave(it) }
        if (h.save) {
            MacRow(tr("Keep for"), tr("Older items are deleted"))
            val opts = listOf(1 to tr("A day"), 7 to tr("A week"), 30 to tr("30 days"), 365 to tr("A year"))
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
                opts.forEachIndexed { i, (d, label) ->
                    SegmentedButton(selected = h.days == d, onClick = { h.setDays(d) }, shape = SegmentedButtonDefaults.itemShape(i, opts.size)) { Text(label, fontSize = 12.sp, maxLines = 1) }
                }
            }
        }
        if (h.error.isNotEmpty()) MacRow(h.error, "")
        SwitchRow(tr("Shortcut on the Overview"), tr("Opens this history"), pinned) { Tiles.set(core.store, tile, it); pinned = it; core.changed() }
    }
}
