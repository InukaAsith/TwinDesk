// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Cards that pick apps or buttons: Notifications › Apps (every app on the phone, as a block list or
// an allow list), General › Banking apps (BankGuard.kt) and General › Notification buttons
// (QuickActions.kt).
package com.twindesk.android

import android.content.Intent
import android.provider.Settings
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val FIRST = 40 // rows shown before "Show all"

// An app's row: its icon, its name (and a word under it), a switch.
@Composable
private fun AppRow(core: Core, pkg: String, label: String, hint: String, on: Boolean, first: Boolean, onChange: (Boolean) -> Unit) {
    Column {
        if (!first) Box(Modifier.padding(horizontal = 20.dp).fillMaxWidth().height(0.5.dp).background(pal.line))
        Row(Modifier.fillMaxWidth().clickable { onChange(!on) }.padding(horizontal = 20.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            val icon by produceState<android.graphics.Bitmap?>(null, pkg) { value = withContext(Dispatchers.IO) { core.appList.icon(pkg) } }
            Box(Modifier.size(34.dp).clip(RoundedCornerShape(9.dp)).background(pal.chip)) {
                icon?.let { Image(it.asImageBitmap(), null, Modifier.size(34.dp)) }
            }
            Column(Modifier.weight(1f).padding(start = 12.dp, end = 8.dp)) {
                Text(label, color = pal.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (hint.isNotEmpty()) Text(hint, color = pal.muted, fontSize = 12.sp, maxLines = 1)
            }
            MacSwitch(on, onChange)
        }
    }
}

@Composable
private fun Search(q: String, onQ: (String) -> Unit) = OutlinedTextField(
    q, onQ, singleLine = true, placeholder = { Text(tr("Search apps"), color = pal.muted) }, shape = RoundedCornerShape(50),
    colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = pal.accent, unfocusedBorderColor = pal.line, focusedTextColor = pal.text, unfocusedTextColor = pal.text),
    modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
)

// Two choices in a pill, the selected one filled.
@Composable
private fun Choice(items: List<Pair<String, String>>, selected: String, onPick: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp).clip(RoundedCornerShape(50)).background(pal.chip).padding(4.dp)) {
        for ((id, label) in items) {
            val on = id == selected
            Box(Modifier.weight(1f).height(36.dp).clip(RoundedCornerShape(50)).background(if (on) pal.accent else Color.Transparent).clickable { onPick(id) }, contentAlignment = Alignment.Center) {
                Text(label, color = if (on) Color.White else pal.muted, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium, fontSize = 14.sp)
            }
        }
    }
}

// ---- Notifications › Apps ----

@Composable
fun NotifAppsCard(core: Core, name: String) {
    val n = core.notifs
    var q by rememberSaveable { mutableStateOf("") }
    var all by rememberSaveable { mutableStateOf(false) }
    val seen = remember(core) { n.apps().map { it.first }.toSet() }
    val apps = core.appList.get()
    val list = apps.filter { q.isBlank() || it.label.contains(q.trim(), true) || it.pkg.contains(q.trim(), true) }
        // The ones that had notifications first, then the rest, each by name.
        .sortedWith(compareBy({ it.pkg !in seen }, { it.label.lowercase() }))
    val on = list.count { n.sends(it.pkg) }
    MacCard(tr("Apps"), action = {
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            TextButton(onClick = { n.setAll(list.map { it.pkg }, true) }) { Text(tr("All"), color = pal.accent, fontSize = 13.sp) }
            TextButton(onClick = { n.setAll(list.map { it.pkg }, false) }) { Text(tr("None"), color = pal.accent, fontSize = 13.sp) }
        }
    }) {
        Choice(listOf("block" to tr("Block list"), "allow" to tr("Allow list")), if (n.allowMode) "allow" else "block") { n.setAllowMode(it == "allow") }
        Text(
            if (n.allowMode) tr("Only the apps switched on send notifications to {name}. New apps stay off.", "name" to name)
            else tr("Every app sends notifications to {name} except the ones switched off. New apps are on.", "name" to name),
            color = pal.muted, fontSize = 12.5.sp, modifier = Modifier.padding(horizontal = 20.dp),
        )
        Search(q) { q = it }
        if (apps.isEmpty()) MacRow(tr("Loading apps…"), first = true)
        else if (list.isEmpty()) MacRow(tr("No apps match “{q}”", "q" to q.trim()), first = true)
        else Text(tr("{on} of {count} send", "on" to on, "count" to list.size), color = pal.muted, fontSize = 12.sp, modifier = Modifier.padding(start = 20.dp, bottom = 4.dp))
        val shown = if (all || q.isNotBlank()) list else list.take(FIRST)
        shown.forEachIndexed { i, a ->
            AppRow(core, a.pkg, a.label, if (a.pkg in seen) tr("Has sent notifications") else "", n.sends(a.pkg), i == 0) { n.setSends(a.pkg, it) }
        }
        if (shown.size < list.size) MacRow(tr("Show all {count} apps", "count" to list.size), onClick = { all = true })
    }
}

// ---- General › Banking apps ----

@Composable
fun BankCard(core: Core) {
    val ctx = LocalContext.current
    val b = core.bank
    var open by rememberSaveable { mutableStateOf(false) }
    var q by rememberSaveable { mutableStateOf("") }
    val banks = b.banks()
    MacCard(tr("Banking apps")) {
        SwitchRow(
            tr("Close TwinDesk for banking apps"),
            if (b.devOff) tr("When a banking app opens, TwinDesk turns off USB and wireless debugging, Developer options and its Accessibility service, then closes")
            else tr("When a banking app opens, TwinDesk turns off USB and wireless debugging and its Accessibility service, then closes"),
            b.on, first = true,
        ) { b.setOn(it) }
        if (b.on) {
            SwitchRow(tr("Turn off Developer options"), tr("Checked by most banking apps"), b.devOff) { b.setDevOff(it) }
            SwitchRow(tr("Restore when TwinDesk opens"), tr("Turns these settings back on the next time TwinDesk opens"), b.restoreOn) { b.setRestore(it) }
            if (!core.adb.canEnable) MacRow(tr("Wireless debugging required"), tr("Without it, TwinDesk closes but can’t turn debugging off")) { }
            if (b.how.isEmpty()) MacRow(tr("Usage access"), tr("Detects when a banking app opens (or use the Accessibility service)")) {
                TextButton(onClick = { runCatching { ctx.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }) { Text(tr("Allow"), color = pal.accent) }
            }
            if (b.last.isNotEmpty()) MacRow(tr("Last closed for"), b.last)
            MacRow(
                tr("Banking apps"),
                if (banks.isEmpty()) tr("None selected") else banks.take(4).joinToString(", ") { it.label } + if (banks.size > 4) tr(" and {count} more", "count" to banks.size - 4) else "",
                onClick = { open = !open },
            ) { Text(if (open) tr("Done") else tr("Choose"), color = pal.accent, fontSize = 14.sp) }
            if (open) {
                Search(q) { q = it }
                val apps = core.appList.get().filter { q.isBlank() || it.label.contains(q.trim(), true) || it.pkg.contains(q.trim(), true) }
                    .sortedWith(compareBy({ !b.isBank(it.pkg) }, { it.label.lowercase() }))
                val list = if (q.isBlank()) apps.take(FIRST + banks.size) else apps
                list.forEachIndexed { i, a ->
                    AppRow(core, a.pkg, a.label, if (b.auto(a.pkg)) tr("Detected as a banking app") else "", b.isBank(a.pkg), i == 0) { b.setBank(a.pkg, it) }
                }
                if (q.isBlank() && list.size < apps.size) Text(tr("Search to find more apps"), color = pal.muted, fontSize = 12.5.sp, modifier = Modifier.padding(20.dp))
            }
        }
    }
}

// ---- General › Notification buttons ----

@Composable
fun NotifButtonsCard(core: Core) {
    val ctx = LocalContext.current
    val chosen = QuickActions.chosen(core)
    MacCard(tr("Notification buttons")) {
        Text(
            tr("Shown on TwinDesk’s notification while connected · {count} of {max} selected", "count" to chosen.size, "max" to QuickActions.MAX),
            color = pal.muted, fontSize = 12.5.sp, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 4.dp),
        )
        QuickActions.ALL.forEach { btn ->
            SwitchRow(btn.label, btn.hint, btn.id in chosen) { on ->
                if (!QuickActions.set(core, btn.id, on)) Toast.makeText(ctx, tr("You can select up to {max} buttons", "max" to QuickActions.MAX), Toast.LENGTH_SHORT).show()
            }
        }
    }
}
