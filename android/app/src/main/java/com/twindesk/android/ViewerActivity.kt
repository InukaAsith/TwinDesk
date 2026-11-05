// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's screen, full screen: Mirror (the Mac's own screen) or Extend (a second screen for the
// Mac, sized to this one). The picture and the touches are viewer.html's; this activity adds a
// small bar (tap the handle at the top): Mirror / Extend, Start / Stop, keyboard, close.
package com.twindesk.android

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.delay

class ViewerActivity : ComponentActivity() {
    private var host: WebHost? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        val core = Core.get(this)
        val h = WebHost(this, "viewer.html", core) { ev, data ->
            if (ev == "playing" && data != null) core.screen.playing(data.optInt("w"), data.optInt("h"))
        }
        host = h
        setContent { Theme { Viewer(core, h) { finish() } } }
    }

    override fun onStart() {
        super.onStart()
        val h = host ?: return
        val m = resources.displayMetrics
        // Physical pixels of this screen, landscape (the viewer is held landscape: a computer's
        // screen is, and Windows' virtual monitor takes no portrait size): the computer makes Extend this shape.
        // Android 11 and later: the window's metrics; Android 10 (minSdk) has only the display's real size (#93).
        val (bw, bh) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            windowManager.currentWindowMetrics.bounds.let { it.width() to it.height() }
        } else {
            val real = android.util.DisplayMetrics()
            @Suppress("DEPRECATION") windowManager.defaultDisplay.getRealMetrics(real)
            real.widthPixels to real.heightPixels
        }
        val w = bw.coerceAtLeast(m.widthPixels)
        val hpx = bh.coerceAtLeast(m.heightPixels)
        Core.get(this).screen.attach(h, maxOf(w, hpx), minOf(w, hpx))
    }

    override fun onStop() {
        super.onStop()
        host?.let { Core.get(this).screen.detach(it) }
    }

    override fun onDestroy() {
        host?.destroy()
        host = null
        super.onDestroy()
    }
}

@androidx.compose.runtime.Composable
private fun Viewer(core: Core, host: WebHost, close: () -> Unit) {
    val v by core.version.collectAsState()
    @Suppress("UNUSED_EXPRESSION") v
    var bar by remember { mutableStateOf(true) }
    var keyboard by remember { mutableStateOf(false) }
    LaunchedEffect(bar) { if (bar) { delay(4000); bar = false } }
    val s = core.screen
    val name = core.host?.name ?: "Mac"
    // Opened because the computer started sharing: it closes when the computer stops.
    var seenOn by remember { mutableStateOf(false) }
    LaunchedEffect(s.sharing, v) {
        if (s.sharing) seenOn = true
        else if (seenOn && s.autoOpened && s.state != null) close()
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { host.view.also { (it.parent as? android.view.ViewGroup)?.removeView(it) } }, modifier = Modifier.fillMaxSize())
        // A small handle at the top: tap for the bar (the rest of the screen is the Mac's).
        Box(
            Modifier.align(Alignment.TopCenter).padding(top = 4.dp).width(72.dp).height(18.dp)
                .clip(RoundedCornerShape(9.dp)).background(Color(0x55FFFFFF)).clickable { bar = !bar },
        )
        AnimatedVisibility(bar, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter).padding(top = 28.dp)) {
            Row(
                Modifier.clip(RoundedCornerShape(16.dp)).background(Color(0xE6202124)).padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(name, color = Color.White, modifier = Modifier.padding(start = 8.dp))
                // Which way the picture comes: the USB cable, or Wi-Fi.
                Text(
                    if (core.link.wired) "USB" else "Wi-Fi", color = Color.White, fontSize = 11.sp,
                    modifier = Modifier.padding(end = 4.dp).clip(RoundedCornerShape(6.dp))
                        .background(if (core.link.wired) Color(0xFF30D158).copy(alpha = 0.35f) else Color(0x33FFFFFF)).padding(horizontal = 6.dp, vertical = 2.dp),
                )
                if (s.remote) {
                    for (mode in listOf("mirror", "extend")) {
                        val on = s.sharing && s.mode == mode
                        val label = if (mode == "mirror") tr("Mirror") else tr("Extend")
                        if (on) FilledTonalButton(onClick = { bar = true }) { Text(label) }
                        else TextButton(onClick = { s.pick(mode); bar = true }) { Text(label, color = Color.White) }
                    }
                    if (s.sharing) TextButton(onClick = { s.control(share = false) }) { Text(tr("Stop"), color = Color.White) }
                }
                TextButton(onClick = { keyboard = !keyboard; s.keyboard(keyboard); bar = true }) { Text(if (keyboard) tr("Hide keyboard") else tr("Keyboard"), color = Color.White) }
                TextButton(onClick = { s.end(); close() }) { Text(tr("Close"), color = Color.White) }
            }
        }
    }
}
