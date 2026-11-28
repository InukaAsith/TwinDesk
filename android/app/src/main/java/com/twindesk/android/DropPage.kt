// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Drop page (Drop.kt): the conversation fills the page, To picks everyone or one device, the gear shows
// the devices (Block) and Clear All in its place. Tap a message for its actions, shown as icons.
package com.twindesk.android

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.DateFormat
import java.util.Date

private object DropIco {
    val gear = lineIcon("drop.gear", "M16.30 8.15 L18.10 8.36 L18.10 11.64 L16.30 11.85 L15.84 13.30 L17.11 14.59 L14.79 16.91 L13.37 15.79 L12.05 16.48 L11.64 18.10 L8.36 18.10 L8.15 16.30 L6.70 15.84 L5.41 17.11 L3.09 14.79 L4.21 13.37 L3.52 12.05 L1.90 11.64 L1.90 8.36 L3.70 8.15 L4.16 6.70 L2.89 5.41 L5.21 3.09 L6.63 4.21 L7.95 3.52 L8.36 1.90 L11.64 1.90 L11.85 3.70 L13.30 4.16 L14.59 2.89 L16.91 5.21 L15.79 6.63 Z M12.5 10a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z")
    val open = lineIcon("drop.open", "M11 3.5h5.5V9 M16.5 3.5 9 11 M14 12v4.5H3.5V6H8")
    val save = lineIcon("drop.save", "M10 3v10 M5.5 8.5 10 13l4.5-4.5 M3.5 16.5h13")
    val share = lineIcon("drop.share", "M10 12.5V3 M6.5 6.5 10 3l3.5 3.5 M5 9H3.5v8h13V9H15")
    val copy = lineIcon("drop.copy", "M7 7h9.5v9.5H7z M13 7V3.5H3.5V13H7")
    val del = lineIcon("drop.del", "M4 5.5h12 M8 5.5V3.5h4v2 M5.5 5.5l.8 11h7.4l.8-11 M8.5 8.5v5 M11.5 8.5v5")
    val delAll = lineIcon("drop.delAll", "M4 5.5h12 M8 5.5V3.5h4v2 M5.5 5.5l.8 11h7.4l.8-11 M8 9l4 4 M12 9l-4 4")
    val send = lineIcon("drop.send", "M3.5 10 16.5 4l-4 12.5-3-5z M9.5 11.5l7-7.5")
    val file = lineIcon("drop.file", "M5 2.5h6.5L15 6v11.5H5z M11.5 2.5V6H15")
}

@Composable
private fun IconBtn(icon: ImageVector, label: String, tint: Color, onClick: () -> Unit) =
    Box(Modifier.size(34.dp).clip(RoundedCornerShape(9.dp)).clickable(onClickLabel = label, onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(20.dp))
    }

private fun bytes(n: Long) = if (n < 1024) "$n B" else if (n < 1048576) "%.1f KB".format(n / 1024.0) else "%.1f MB".format(n / 1048576.0)

@Composable
fun ColumnScope.DropPage(core: Core, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v
    val drop = core.drop
    var settings by rememberSaveable { mutableStateOf(false) }
    var to by rememberSaveable { mutableStateOf("*") }
    var text by rememberSaveable { mutableStateOf("") }
    var picking by remember { mutableStateOf(false) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris -> if (uris.isNotEmpty()) drop.postFiles(to, uris) }
    DisposableEffect(Unit) { drop.ask(); onDispose { } }
    PageHead(tr("Drop"), tr("One conversation with all your devices: messages, links, pictures and files."), drop.on) { drop.setOn(it) }
    if (!drop.on) { Note(tr("Drop is off. Turn it on to send and receive messages with your other devices.")); return }
    val items = drop.view()
    if (drop.unread() > 0 && MainActivity.shown) LaunchedEffect(items.size) { drop.read() }
    val members = drop.members
    if (to != "*" && members.none { it.id == to && it.online }) to = "*"
    if (core.host == null) Note(tr("Not connected. What you send waits here and goes when TwinDesk connects to a computer."))
    Note(drop.note)

    Column(Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(18.dp)).background(pal.card).border(1.dp, pal.line, RoundedCornerShape(18.dp))) {
        // Head: To, and the gear.
        Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (settings) {
                Text(tr("Devices"), fontWeight = FontWeight.SemiBold, color = pal.text, modifier = Modifier.weight(1f))
                Text(tr("Done"), color = pal.accent, fontWeight = FontWeight.Medium, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { settings = false }.padding(10.dp))
            } else {
                Text(tr("To"), color = pal.muted, fontSize = 14.sp)
                Box(Modifier.padding(start = 8.dp).weight(1f)) {
                    val label = if (to == "*") tr("Everyone") else members.firstOrNull { it.id == to }?.name ?: tr("Everyone")
                    Text("$label  ▾", color = pal.text, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { picking = true }.padding(horizontal = 8.dp, vertical = 8.dp))
                    DropdownMenu(picking, { picking = false }) {
                        DropdownMenuItem({ Text(tr("Everyone")) }, { to = "*"; picking = false })
                        for (m in members.filter { it.online }) DropdownMenuItem({ Text(m.name) }, { to = m.id; picking = false })
                    }
                }
                IconBtn(DropIco.gear, tr("Devices"), pal.muted) { settings = true; drop.ask() }
            }
        }
        Box(Modifier.fillMaxWidth().heightIn(min = 1.dp).background(pal.line).padding(top = 1.dp))
        if (settings) DropSettings(core, drop) else DropThread(core, drop, items, Modifier.weight(1f))
        if (!settings) {
            Box(Modifier.fillMaxWidth().background(pal.line).padding(top = 1.dp))
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconBtn(Ico.plus, tr("Attach files"), pal.accent) { pick.launch("*/*") }
                BasicTextField(text, { text = it }, textStyle = TextStyle(color = pal.text, fontSize = 15.sp), cursorBrush = SolidColor(pal.accent), maxLines = 5,
                    modifier = Modifier.weight(1f).padding(horizontal = 6.dp).clip(RoundedCornerShape(18.dp)).background(pal.trackOff.copy(alpha = 0.5f)).padding(horizontal = 12.dp, vertical = 9.dp),
                    decorationBox = { inner -> Box { if (text.isEmpty()) Text(tr("Message"), color = pal.faint, fontSize = 15.sp); inner() } })
                IconBtn(DropIco.send, tr("Send"), if (text.isBlank()) pal.faint else pal.accent) { if (text.isNotBlank()) { drop.post(to, text); text = "" } }
            }
        }
    }
}

@Composable
private fun DropThread(core: Core, drop: Drop, items: List<Drop.Item>, modifier: Modifier) {
    val list = rememberLazyListState()
    LaunchedEffect(items.size) { if (items.isNotEmpty()) list.scrollToItem(items.size - 1) }
    var open by remember { mutableStateOf<String?>(null) }
    if (items.isEmpty()) {
        Box(modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
            Text(tr("No messages yet. What you send here reaches every device, or the one you pick."), color = pal.muted, fontSize = 14.sp)
        }
        return
    }
    val clip = LocalClipboardManager.current
    LazyColumn(modifier.fillMaxWidth().padding(horizontal = 10.dp), state = list, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        item { Spacer(Modifier.size(6.dp)) }
        items(items, key = { it.id }) { x ->
            val out = x.from == core.store.deviceId
            Row(Modifier.fillMaxWidth(), horizontalArrangement = if (out) Arrangement.End else Arrangement.Start) {
                Column(Modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(16.dp)).background(if (out) pal.accent else pal.trackOff)
                    .clickable { open = if (open == x.id) null else x.id }.padding(horizontal = 11.dp, vertical = 7.dp)) {
                    val fg = if (out) Color.White else pal.text
                    val head = when {
                        !out && x.to == "*" -> x.name
                        !out -> tr("{name}, only to you", "name" to x.name)
                        x.to != "*" -> tr("To {name}", "name" to (drop.members.firstOrNull { it.id == x.to }?.name ?: tr("one device")))
                        else -> ""
                    }
                    if (head.isNotEmpty()) Text(head, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = fg.copy(alpha = 0.7f))
                    x.file?.let { f ->
                        if (f.image) drop.thumb(x)?.let { b ->
                            Image(b.asImageBitmap(), f.name, contentScale = ContentScale.Fit, modifier = Modifier.padding(top = 4.dp).widthIn(max = 260.dp).heightIn(max = 260.dp).clip(RoundedCornerShape(10.dp)))
                        }
                        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(DropIco.file, null, tint = fg, modifier = Modifier.size(22.dp))
                            Column(Modifier.padding(start = 8.dp)) {
                                Text(f.name, color = fg, fontWeight = FontWeight.Medium, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(bytes(f.size), color = fg.copy(alpha = 0.75f), fontSize = 11.sp)
                            }
                        }
                    }
                    if (x.text.isNotEmpty()) SelectionContainer { Text(x.text, color = fg, fontSize = 15.sp) }
                    if (open == x.id) Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(x.at)), fontSize = 11.sp, color = fg.copy(alpha = 0.75f), modifier = Modifier.padding(end = 4.dp))
                        if (x.file != null) {
                            IconBtn(DropIco.open, tr("Open"), fg) { drop.open(x) }
                            IconBtn(DropIco.save, tr("Save to Downloads"), fg) { drop.save(x) }
                        } else IconBtn(DropIco.copy, tr("Copy"), fg) { clip.setText(AnnotatedString(x.text)); drop.note(tr("Copied")) }
                        IconBtn(DropIco.share, tr("Share"), fg) { drop.share(x) }
                        IconBtn(DropIco.del, tr("Delete for me"), fg) { drop.del(x.id, false); open = null }
                        if (out) IconBtn(DropIco.delAll, tr("Delete for everyone"), fg) { drop.del(x.id, true); open = null }
                    }
                }
            }
        }
        item { Spacer(Modifier.size(6.dp)) }
    }
}

@Composable
private fun ColumnScope.DropSettings(core: Core, drop: Drop) {
    Column(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 4.dp)) {
        val blocked = drop.blockedList().toMap()
        val seen = HashSet<String>()
        var first = true
        for (m in drop.members) {
            seen.add(m.id)
            val b = blocked.containsKey(m.id)
            MacRow(m.name, if (b) tr("Blocked: its messages aren’t shown here") else if (m.online) tr("Connected") else tr("Not connected"), first = first) {
                Text(if (b) tr("Unblock") else tr("Block"), color = pal.accent, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { drop.block(m.id, !b, m.name) }.padding(8.dp))
            }
            first = false
        }
        for ((id, name) in blocked) if (id !in seen) {
            MacRow(name, tr("Blocked: its messages aren’t shown here"), first = first) {
                Text(tr("Unblock"), color = pal.accent, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { drop.block(id, false, name) }.padding(8.dp))
            }
            first = false
        }
        if (first) MacRow(tr("No other devices yet"), if (core.host == null) tr("Connect to a computer: it brings in the other devices.") else tr("Phones and computers connected to this one join the conversation."), first = true)
        MacRow(tr("Clear All"), tr("Removes every message from this phone only. The other devices keep theirs.")) {
            Text(tr("Clear All"), color = pal.bad, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { drop.clear() }.padding(8.dp))
        }
    }
}
