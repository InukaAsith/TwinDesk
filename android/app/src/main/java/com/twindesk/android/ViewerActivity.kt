// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's screen, full screen: Mirror (the Mac's own screen) or Extend (a second screen for the
// Mac, sized to this one). The picture and the touches are viewer.html's; this activity adds a
// small bar (tap the handle at the top): Mirror / Extend, which display, Displays & desktops, previous/next desktop, keyboard, close.
// When this Mac sends a desktop catalog, that sheet is the mirror, display, and desktop control.
// Stop, the keyboard, and Close stay on the bar. An older Mac, or a picture that is not sharing
// or not taking input, keeps Mirror, Extend, the display list, and previous/next.
package com.twindesk.android

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.delay

class ViewerActivity : ComponentActivity() {
    private var host: WebHost? = null
    private var started by mutableStateOf(false)
    private var attached = false
    private var viewport: Pair<Int, Int>? = null
    private val resize = Runnable { updateViewport() }

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
            if (ev == "videoState" && data != null) host?.let {
                core.screen.videoState(it, data.optInt("generation"), data.optInt("session"), data.optBoolean("playing"), data.optInt("w"), data.optInt("h"))
            }
            if (ev == "videoDetail" && data != null) host?.let {
                core.screen.videoDetail(it, data.optInt("generation"), data.optInt("session"), data.optInt("height", -1))
            }
            if (ev == "videoMetrics" && data != null) host?.let {
                core.screen.videoMetrics(it, data.optInt("generation"), data.optInt("session"), data.optInt("w"), data.optInt("h"),
                    data.optInt("fps", -1), data.optInt("kbps", -1), data.optLong("dropped", -1))
            }
            if (ev == "playing" && data != null) core.screen.playing(data.optInt("w"), data.optInt("h"))
        }
        host = h
        h.view.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) {
                h.view.removeCallbacks(resize)
                h.view.postDelayed(resize, 250)
            }
        }
        setContent { Theme { Viewer(core, h, started) { finish() } } }
        MirrorRail(this).attach() // the side rail: Auto-rotate, Screenshot
    }

    override fun onStart() {
        super.onStart()
        started = true
        host?.view?.post(resize)
    }

    private fun updateViewport() {
        if (!started) return
        val h = host ?: return
        val w = h.view.width
        val hpx = h.view.height
        if (w <= 0 || hpx <= 0) return
        val core = Core.get(this)
        // The measured WebView follows folds, split windows and cutouts. Mac Extend can use
        // portrait; other hosts keep the landscape policy their virtual monitors already expect.
        val next = if (core.host?.os == "mac") w to hpx else maxOf(w, hpx) to minOf(w, hpx)
        if (viewport == next) return
        viewport = next
        if (attached) core.screen.resize(h, next.first, next.second)
        else { attached = true; core.screen.attach(h, next.first, next.second) }
    }

    override fun onStop() {
        super.onStop()
        started = false
        host?.view?.removeCallbacks(resize)
        Core.get(this).screen.previewSheet(false)
        host?.let { Core.get(this).screen.detach(it) }
        attached = false
        viewport = null
    }

    override fun onDestroy() {
        host?.destroy()
        host = null
        super.onDestroy()
    }
}

@androidx.compose.runtime.Composable
private fun Viewer(core: Core, host: WebHost, started: Boolean, close: () -> Unit) {
    val v by core.version.collectAsState()
    @Suppress("UNUSED_EXPRESSION") v
    var bar by remember { mutableStateOf(true) }
    var keyboard by remember { mutableStateOf(false) }
    var overview by remember(core.host?.id) { mutableStateOf(false) }
    val reduceMotion = android.provider.Settings.Global.getFloat(
        LocalContext.current.contentResolver,
        android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
    ) == 0f
    val s = core.screen
    LaunchedEffect(bar, s.spaceNote) {
        if (bar && s.spaceNote.isEmpty()) { delay(4000); bar = false }
    }
    LaunchedEffect(s.spaceNote) {
        if (s.spaceNote.isNotEmpty()) bar = true
    }
    val desks = s.desktopCatalog
    // A catalog from this Mac, while it is sharing and taking input, is the new sheet.
    // The bar then drops the controls that sheet already has.
    val sheetReady = desks != null && desks.displays.isNotEmpty() && core.host?.os == "mac" && s.sharing && s.inputOn
    LaunchedEffect(overview) { if (overview) s.refreshDesktops() }
    LaunchedEffect(sheetReady) { if (!sheetReady) overview = false }
    LaunchedEffect(overview, sheetReady, started, s.previewEpoch) {
        s.previewSheet(overview && sheetReady && started)
    }
    val name = core.host?.name ?: "Mac"
    // Opened because the computer started sharing: it closes when the computer stops.
    var seenOn by remember { mutableStateOf(false) }
    LaunchedEffect(s.sharing, v) {
        if (s.sharing) seenOn = true
        else if (seenOn && s.autoOpened && s.state != null) close()
    }

    Box(Modifier.fillMaxSize().background(Color.Black).windowInsetsPadding(WindowInsets.displayCutout)) {
        AndroidView(factory = { host.view.also { (it.parent as? android.view.ViewGroup)?.removeView(it) } }, modifier = Modifier.fillMaxSize())
        // A small handle at the top: tap for the bar (the rest of the screen is the Mac's).
        Box(
            Modifier.align(Alignment.TopCenter).padding(top = 4.dp).width(72.dp).height(18.dp)
                .clip(RoundedCornerShape(9.dp)).background(Color(0x55FFFFFF)).clickable { bar = !bar },
        )
        AnimatedVisibility(bar, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter).padding(top = 28.dp)) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color(0xE6202124)).horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(name, color = Color.White, modifier = Modifier.padding(start = 8.dp))
                    Text(
                        doctorTransport(core), color = Color.White, fontSize = 11.sp,
                        modifier = Modifier.padding(end = 4.dp).clip(RoundedCornerShape(6.dp))
                            .background(if (core.link.wired) Color(0xFF30D158).copy(alpha = 0.35f) else Color(0x33FFFFFF)).padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                    if (s.remote) {
                        if (!sheetReady) {
                            for (mode in listOf("mirror", "extend")) {
                                val on = s.sharing && (s.mode == mode || (mode == "mirror" && s.mode == "custom" && s.displayId.isNotEmpty()))
                                val label = if (mode == "mirror") tr("Mirror") else tr("Extend")
                                if (on) FilledTonalButton(onClick = { bar = true }) { Text(label) }
                                else TextButton(onClick = { s.pick(mode); bar = true }) { Text(label, color = Color.White) }
                            }
                        }
                        if (s.sharing) TextButton(onClick = { s.control(share = false) }) { Text(tr("Stop"), color = Color.White) }
                    }
                    if (sheetReady) {
                        TextButton(
                            onClick = { overview = true; bar = true },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) { Text(tr("Displays & desktops"), color = Color.White) }
                    }
                    TextButton(onClick = { keyboard = !keyboard; s.keyboard(keyboard); bar = true }) { Text(if (keyboard) tr("Hide keyboard") else tr("Keyboard"), color = Color.White) }
                    TextButton(onClick = { s.end(); close() }) { Text(tr("Close"), color = Color.White) }
                }
                if (s.viewing && s.videoPlaying && s.sharing) s.doctorSummary?.let {
                    Text(it, color = Color(0xFFB9BDC6), fontSize = 11.sp,
                        modifier = Modifier.padding(top = 4.dp, start = 8.dp, end = 8.dp)
                            .clip(RoundedCornerShape(6.dp)).background(Color(0xE6202124))
                            .padding(horizontal = 8.dp, vertical = 4.dp))
                }

                if (!sheetReady && s.remote && s.displays.size > 1) {
                    Row(
                        Modifier.padding(top = 6.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color(0xE6202124)).padding(horizontal = 8.dp, vertical = 2.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        MacDisplayPick(s.displays, if (s.sharing && s.mode != "extend") s.displayId else "", onDark = true) { s.pickDisplay(it); bar = true }
                    }
                }
                if (!sheetReady && s.spaces && s.sharing && s.inputOn && core.host?.os == "mac") {
                    MacDesktopRow(
                        onPrev = { s.space("prev"); bar = true },
                        onNext = { s.space("next"); bar = true },
                    )
                }
                if (s.spaceNote.isNotEmpty() && !overview) Text(
                    s.spaceNote,
                    color = Color.White,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(top = 6.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color(0xE6202124)).padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }
        if (overview && sheetReady) {
            Box(Modifier.fillMaxSize().zIndex(2f)) {
                DesktopOverview(
                    catalog = desks,
                    pendingDisplayId = s.pendingDisplayId,
                    note = s.spaceNote,
                    mode = s.mode,
                    sharing = s.sharing,
                    remote = s.remote,
                    reduceMotion = reduceMotion,
                    previews = s.desktopPreviews,
                    spaceHold = s.state?.optString("spaceHold").orEmpty(),
                    onDone = { overview = false },
                    onDesktop = { displayId, spaceId -> s.selectDesktop(displayId, spaceId) },
                    onDisplay = { id -> if (id != desks.viewing && id != s.pendingDisplayId) s.selectDisplay(id) },
                    onMode = { s.pick(it) },
                )
            }
        }
    }
}

// Previous and next macOS desktop. Its own composable so the scroll state is not created
// on a condition inside Viewer. Shown only while this Mac is sharing and taking input.
@androidx.compose.runtime.Composable
private fun MacDesktopRow(onPrev: () -> Unit, onNext: () -> Unit) {
    Row(
        Modifier.padding(top = 6.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color(0xE6202124))
            .horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onPrev) { Text(tr("Previous desktop"), color = Color.White) }
        TextButton(onClick = onNext) { Text(tr("Next desktop"), color = Color.White) }
    }
}
