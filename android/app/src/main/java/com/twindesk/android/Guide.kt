// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The wireless debugging steps, to let the computer show this screen and use its mouse and
// keyboard here, each ticked off as it happens: a page from Overview's Set up and General › Setup.
// The pairing code is typed in TwinDesk's notification (Settings' code dialog closes if you switch
// apps), or here when Settings is side by side; the phone sends it to the computer,
// which pairs (adb.pair), and says how it went (adb.bridge).
package com.twindesk.android

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Open from anywhere (General › Setup, the Cursor page, Overview's line under Connected while
// wireless debugging isn't set up): App shows the guide page while this is true. It never opens by itself.
object Guide {
    val open = mutableStateOf(false)

    fun close(core: Core) {
        open.value = false
        core.changed()
    }
}

private val xiaomi = Build.MANUFACTURER.equals("Xiaomi", true) || Build.BRAND.equals("POCO", true) || Build.BRAND.equals("Redmi", true)

@Composable
fun WirelessGuide(core: Core, ctx: Context, v: Int) {
    @Suppress("UNUSED_EXPRESSION") v
    val a = core.adb
    val name = core.host?.name ?: core.hosts().firstOrNull()?.name ?: "your computer"

    Box(Modifier.fillMaxSize().background(pal.content).safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Tile(Ico.display, listOf(Color(0xFF5AC8FA), Color(0xFF0A84FF)), 44)
                Column(Modifier.padding(start = 14.dp)) {
                    Text("Wireless debugging", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = pal.text)
                    Text("Once, so $name can show this screen and use its mouse and keyboard here", color = pal.muted, fontSize = 13.5.sp)
                }
            }
            Spacer(Modifier.height(20.dp))
            if (a.paired) Note("Done: $name is paired with this device’s wireless debugging.", "info")
            WirelessSteps(core, ctx, "")
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = { Guide.close(core) }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = pal.accent, contentColor = Color.White),
            ) { Text("Done", modifier = Modifier.padding(vertical = 4.dp)) }
        }
    }
}

// The steps, short enough for one screen: the finished ones as one line of ticks, the current one
// with its hint and button, the rest as titles. The code field is for Settings side by side.
@Composable
private fun WirelessSteps(core: Core, ctx: Context, title: String, foot: @Composable () -> Unit = {}) {
    val a = core.adb
    val name = core.host?.name ?: core.hosts().firstOrNull()?.name ?: "your computer"
    val connected = core.host != null
    class S(val title: String, val hint: String, val done: Boolean, val optional: Boolean = false, val action: @Composable () -> Unit = {})
    val steps = listOfNotNull(
        S("Connect to $name", "Open TwinDesk on $name, then tap Connect on Overview.", connected) {
            core.hosts().firstOrNull()?.let { h -> Secondary("Connect") { core.connect(h) } }
        },
        S(
            "Turn on Developer options",
            if (xiaomi) "About phone › tap “OS version” 7 times." else "About phone › tap “Build number” 7 times.", a.devOptions,
        ) { Secondary("Open") { ctx.startActivity(Intent(Settings.ACTION_DEVICE_INFO_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } },
        // Without it MIUI and HyperOS refuse the computer's touches and keys (the computer tells us).
        if (xiaomi) S(
            "Xiaomi: “USB debugging (Security settings)”",
            "Developer options › USB debugging (Security settings): on, for touch, mouse and keyboard from $name. It asks for a Mi account.",
            a.paired && !a.inputBlocked, optional = !a.inputBlocked,
        ) { Secondary("Open") { a.openSettings() } } else null,
        S("Turn on USB and Wireless debugging", "Developer options › USB debugging and Wireless debugging: both on.", a.wifiDebugging) { Secondary("Open") { a.turnOn() } },
        S(
            "Pair with $name",
            if (a.pairing) "Pairing…" else "“Pair device with pairing code”, then type the code in TwinDesk’s notification.", a.paired,
        ) { Primary("Pair") { a.askForCode(); a.openSettings() } },
    )
    val current = steps.indexOfFirst { !it.done && !it.optional }
    MacCard(title) {
        val done = steps.filter { it.done }
        if (done.isNotEmpty()) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(22.dp).clip(CircleShape).background(pal.good), contentAlignment = Alignment.Center) {
                Text("✓", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 12.sp)
            }
            Text(done.joinToString(" · ") { it.title.removePrefix("Turn on ").removeSuffix(" with $name").removeSuffix(" to $name") }, color = pal.muted, fontSize = 13.sp, modifier = Modifier.padding(start = 10.dp))
        }
        var first = done.isEmpty()
        steps.forEachIndexed { i, st ->
            if (st.done) return@forEachIndexed
            Step(i + 1, st.title, if (i == current) st.hint else "", false, first = first, optional = st.optional, compact = i != current) {
                if (i == current || st.optional) st.action()
            }
            first = false
        }
        if (!a.paired && a.bridgeMessage.isNotEmpty() && a.bridge != "ready") Text(
            a.bridgeMessage, color = pal.muted, fontSize = 12.sp, maxLines = 2, modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
        )
        // Settings side by side (tablets, split screen): type the code here instead.
        if (!a.paired && connected) {
            var code by remember { mutableStateOf("") }
            Box(Modifier.fillMaxWidth().height(1.dp).background(pal.line))
            Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    code, { code = it.filter { c -> c.isDigit() }.take(6) }, placeholder = { Text("Or type the code here", color = pal.faint, fontSize = 14.sp) }, singleLine = true,
                    modifier = Modifier.weight(1f), shape = RoundedCornerShape(8.dp),
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 16.sp, color = pal.text, letterSpacing = 3.sp),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                )
                Primary("Pair") { a.askForCode(); a.sendPairCode(code) }
            }
        }
        foot()
    }
}

// One numbered step (like the Mac's setup rows); compact: a later step, title only.
@Composable
private fun Step(n: Int, title: String, hint: String, done: Boolean, first: Boolean = false, optional: Boolean = false, compact: Boolean = false, action: @Composable () -> Unit) {
    Column {
        if (!first) Box(Modifier.padding(start = 50.dp).fillMaxWidth().height(1.dp).background(pal.line))
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = if (compact) 6.dp else 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(if (compact) 22.dp else 26.dp).clip(CircleShape).background(if (done) pal.good else if (optional || compact) pal.trackOff else pal.accentSoft),
                contentAlignment = Alignment.Center,
            ) { Text(if (done) "✓" else "$n", color = if (done) Color.White else if (compact) pal.muted else pal.accent, fontWeight = FontWeight.Bold, fontSize = if (compact) 12.sp else 14.sp) }
            Column(Modifier.weight(1f).padding(start = 12.dp, end = 10.dp)) {
                Text(title, color = if (compact && !optional) pal.muted else pal.text, fontSize = if (compact) 13.5.sp else 15.sp)
                if (hint.isNotEmpty()) Text(hint, color = pal.muted, fontSize = 12.5.sp)
            }
            if (!done) action()
        }
    }
}

@Composable
private fun Primary(label: String, onClick: () -> Unit) = Button(onClick = onClick, colors = ButtonDefaults.buttonColors(containerColor = pal.accent, contentColor = Color.White), shape = RoundedCornerShape(8.dp)) { Text(label) }

@Composable
private fun Secondary(label: String, onClick: () -> Unit) = OutlinedButton(onClick = onClick, shape = RoundedCornerShape(8.dp)) { Text(label, color = pal.text) }
