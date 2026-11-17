// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Displays & desktops sheet for the Mac viewer. A tile shows the still preview the Mac
// sent for that desktop during this session, or says it has not been previewed. It is
// not a live picture and it does not invent windows.
// Rows are lazy: a Mac can list 8 displays and 64 desktops, and only the visible rows
// are composed. JPEG bytes are decoded off the UI thread, one bitmap per session,
// display, space, and shot, and only after the file's own size is known to fit.
package com.twindesk.android

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext

private val Sheet = Color(0xFF1C1C1E)
private val Ink = Color(0xFFF4F4F6)
private val Muted = Color(0xFFC8C8CE)
private val Card = Color(0xFF2A2A2E)
private val CardOn = Color(0xFF243044)
private val OnCard = Color(0xFFD5E4FF)
private val Thumb = Color(0xFF121214)
private val Blue = Color(0xFF8EB4FF)
private val Line = Color(0x22FFFFFF)
private val Segment = Color(0xFF3A5F99)
private val Track = Color(0xFF101012)

private const val TILE_GAP = 8f
private const val PREVIEW_RATIO = 16f / 9f

internal fun sheetSideDp(wide: Boolean): Float = if (wide) 24f else 8f

internal fun sheetInnerDp(wide: Boolean): Float = if (wide) 20f else 16f

// Width inside the sheet after its own outer margin and padding. The sheet never
// grows past 720dp, including on a foldable, so the grid follows that width.
internal fun sheetContentWidthDp(viewportWidthDp: Float, wide: Boolean): Float {
    val sheet = (viewportWidthDp - sheetSideDp(wide) * 2f).coerceAtMost(720f)
    return (sheet - sheetInnerDp(wide) * 2f).coerceAtLeast(0f)
}

// Fewer, wider tiles as the type size grows, so a label still has a line to sit on.
internal fun deskColumnCount(contentWidthDp: Float, fontScale: Float): Int {
    val scale = fontScale.coerceIn(0.85f, 2f)
    val minTile = 96f * (1f + (scale - 1f).coerceAtLeast(0f) * 0.9f)
    val count = ((contentWidthDp + TILE_GAP) / (minTile + TILE_GAP)).toInt()
    return count.coerceIn(2, 6)
}

// Thumbnail box for one column. Height stays in a 16:9 band so a wide sheet cannot
// turn a still into a giant card.
internal fun tileExtentDp(contentWidthDp: Float, columns: Int): Pair<Float, Float> {
    val cols = columns.coerceIn(1, 8)
    val raw = (contentWidthDp - TILE_GAP * (cols - 1)) / cols
    val width = raw.coerceIn(1f, 168f)
    val height = (width / PREVIEW_RATIO).coerceIn(40f, 84f)
    return width to height
}

internal fun displayColumnCount(contentWidthDp: Float, fontScale: Float, displays: Int): Int {
    if (displays <= 1) return 1
    val scale = fontScale.coerceIn(0.85f, 2f)
    val minCard = 176f * scale.coerceAtMost(1.35f)
    return if (contentWidthDp >= minCard * 2f + TILE_GAP) 2 else 1
}

// A narrow sheet, or a large font, gives Mirror and Extend the whole row.
internal fun modeSwitchWidthDp(contentWidthDp: Float, fontScale: Float): Float {
    val tight = fontScale >= 1.3f || contentWidthDp < 520f
    return if (tight) contentWidthDp.coerceAtLeast(0f) else minOf(contentWidthDp, 420f)
}

internal data class PreviewCacheKey(
    val session: Long,
    val displayId: String,
    val spaceId: String,
    val seq: Long,
    val bucket: Int,
)

// The catalog's width and height are already capped. The JPEG can still disagree,
// so this is the size BitmapFactory reported for the file itself.
internal fun previewIntrinsicOk(width: Int, height: Int): Boolean =
    width in 1..DesktopPreview.MAX_EDGE && height in 1..DesktopPreview.MAX_EDGE

internal fun previewTargetBucket(targetPx: Int): Int {
    val px = targetPx.coerceIn(48, DesktopPreview.MAX_EDGE)
    return ((px + 16) / 32).coerceIn(2, 15)
}

internal fun previewSampleSize(srcWidth: Int, srcHeight: Int, targetPx: Int): Int {
    val edge = maxOf(srcWidth, srcHeight).coerceAtLeast(1)
    val bound = targetPx.coerceIn(48, DesktopPreview.MAX_EDGE)
    var sample = 1
    while (sample < 8 && edge / (sample * 2) >= bound) sample *= 2
    return sample
}

// Bounds only, then pixels. A second Options object: reusing the first would leave
// inJustDecodeBounds set and skip the bitmap, or allocate before the size is known.
internal fun decodePreviewBitmap(jpeg: ByteArray, targetPx: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
    if (!previewIntrinsicOk(bounds.outWidth, bounds.outHeight)) return null
    val sample = previewSampleSize(bounds.outWidth, bounds.outHeight, targetPx)
    val pixels = BitmapFactory.Options().apply {
        inSampleSize = sample
        inScaled = false
    }
    val bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, pixels) ?: return null
    if (!previewIntrinsicOk(bitmap.width, bitmap.height)) {
        bitmap.recycle()
        return null
    }
    bitmap.density = Bitmap.DENSITY_NONE
    return bitmap
}

private class PreviewDecodes {
    private val cache = object : LruCache<PreviewCacheKey, Bitmap>(6 * 1024 * 1024) {
        override fun sizeOf(key: PreviewCacheKey, value: Bitmap): Int = value.byteCount.coerceAtLeast(1)
    }

    fun peek(key: PreviewCacheKey): Bitmap? = cache.get(key)

    fun put(key: PreviewCacheKey, bitmap: Bitmap) {
        cache.put(key, bitmap)
    }

    fun clear() = cache.evictAll()
}

@Composable
fun DesktopOverview(
    catalog: DesktopSelect.Catalog,
    pendingDisplayId: String,
    note: String,
    mode: String,
    sharing: Boolean,
    remote: Boolean,
    reduceMotion: Boolean,
    previews: DesktopPreview.Board,
    spaceHold: String,
    onDone: () -> Unit,
    onDesktop: (String, String) -> Unit,
    onDisplay: (String) -> Unit,
    onMode: (String) -> Unit,
) {
    BackHandler(onBack = onDone)
    val scrim = remember { MutableInteractionSource() }
    var arrived by remember { mutableStateOf(reduceMotion) }
    LaunchedEffect(Unit) { arrived = true }
    val decodes = remember(previews.session) { PreviewDecodes() }
    DisposableEffect(decodes) { onDispose { decodes.clear() } }
    val alpha by animateFloatAsState(if (arrived) 1f else 0f, tween(if (reduceMotion) 0 else 220, easing = FastOutSlowInEasing), label = "sheet")
    val offset by animateFloatAsState(if (arrived || reduceMotion) 0f else 28f, tween(if (reduceMotion) 0 else 220, easing = FastOutSlowInEasing), label = "sheetMove")
    Box(Modifier.fillMaxSize()) {
        // Keep a tap here from reaching the Mac. Done is what closes the sheet.
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.46f)).clickable(scrim, null) {})
        BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
            val wide = maxWidth >= 580.dp
            val side = sheetSideDp(wide).dp
            val inner = sheetInnerDp(wide).dp
            val contentWidth = sheetContentWidthDp(maxWidth.value, wide)
            val fontScale = LocalDensity.current.fontScale
            val sheetHeight = (maxHeight - side - 8.dp).coerceAtLeast(0.dp)
            Column(
                Modifier
                    .padding(start = side, end = side, bottom = side)
                    .widthIn(max = 720.dp)
                    .fillMaxWidth()
                    .height(sheetHeight)
                    .graphicsLayer { this.alpha = alpha; translationY = offset }
                    .clip(RoundedCornerShape(26.dp))
                    .background(Sheet)
                    .border(1.dp, Line, RoundedCornerShape(26.dp))
                    .padding(horizontal = inner, vertical = if (wide) 16.dp else 12.dp),
            ) {
                Box(
                    Modifier
                        .padding(bottom = 12.dp)
                        .size(width = 36.dp, height = 4.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(Color.White.copy(alpha = 0.28f))
                        .align(Alignment.CenterHorizontally),
                )
                OverviewHeader(previews, onDone)
                OverviewList(
                    catalog = catalog,
                    pendingDisplayId = pendingDisplayId,
                    contentWidth = contentWidth,
                    fontScale = fontScale,
                    previews = previews,
                    decodes = decodes,
                    spaceHold = spaceHold,
                    onDesktop = onDesktop,
                    onDisplay = onDisplay,
                    modifier = Modifier.weight(1f).fillMaxWidth().padding(top = 12.dp),
                )
                OverviewFooter(note, mode, sharing, remote, contentWidth, fontScale, onMode)
            }
        }
    }
}

@Composable
private fun OverviewHeader(previews: DesktopPreview.Board, onDone: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(
                tr("Displays & desktops"),
                color = Ink,
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                tr("Choose where you want to work"),
                color = Muted,
                fontSize = 13.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
            val previewNote = when (previews.unavailable) {
                "os" -> tr("Desktop previews need macOS 14.")
                "permission" -> tr("Desktop previews need Screen Recording.")
                else -> ""
            }
            if (previewNote.isNotEmpty()) {
                Text(previewNote, color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
            }
        }
        val done = tr("Done")
        val source = remember { MutableInteractionSource() }
        Box(
            Modifier
                .height(48.dp)
                .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(Color(0xFF3A3A3C))
                .clickable(interactionSource = source, indication = ripple(color = Color.White.copy(alpha = 0.20f)), role = Role.Button, onClick = onDone)
                .padding(horizontal = 16.dp)
                .clearAndSetSemantics { role = Role.Button; contentDescription = done },
            contentAlignment = Alignment.Center,
        ) {
            Text(done, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, softWrap = false)
        }
    }
}

@Composable
private fun OverviewList(
    catalog: DesktopSelect.Catalog,
    pendingDisplayId: String,
    contentWidth: Float,
    fontScale: Float,
    previews: DesktopPreview.Board,
    decodes: PreviewDecodes,
    spaceHold: String,
    onDesktop: (String, String) -> Unit,
    onDisplay: (String) -> Unit,
    modifier: Modifier,
) {
    val cols = deskColumnCount(contentWidth, fontScale)
    val (tileW, tileH) = tileExtentDp(contentWidth, cols)
    val targetPx = with(LocalDensity.current) { tileW.dp.roundToPx() }
    val displayCols = displayColumnCount(contentWidth, fontScale, catalog.displays.size)
    LazyColumn(modifier) {
        item(key = "displays", contentType = "displays") {
            DisplayGrid(catalog, pendingDisplayId, displayCols, onDisplay)
        }
        for (display in catalog.displays) {
            item(key = "head-${display.id}", contentType = "head") {
                SectionLabel(display, contentWidth < 420f || fontScale >= 1.3f)
            }
            val rows = display.desktops.chunked(cols)
            items(
                count = rows.size,
                key = { index -> "row-${display.id}-${rows[index].first().id}-$cols" },
                contentType = { _ -> "row" },
            ) { index ->
                DesktopRow(
                    display = display,
                    desks = rows[index],
                    viewingId = catalog.viewing,
                    tileWidth = tileW,
                    tileHeight = tileH,
                    targetPx = targetPx,
                    previews = previews,
                    decodes = decodes,
                    spaceHold = spaceHold,
                    onDesktop = onDesktop,
                )
            }
            if (display.truncated) {
                item(key = "more-${display.id}", contentType = "note") {
                    Text(
                        tr("More desktops are on this Mac than this list shows"),
                        color = Muted,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(top = 2.dp, bottom = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(display: DesktopSelect.Display, stacked: Boolean) {
    val label = display.name.ifBlank { tr("This screen") }
    val title = tr("Desktops on {name}", "name" to label)
    val count = if (display.count == 1) tr("1 desktop") else tr("{count} desktops", "count" to display.count)
    if (stacked) {
        Column(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(count, color = Muted, fontSize = 12.sp)
        }
        return
    }
    Row(
        Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Bottom,
    ) {
        Text(
            title,
            color = Ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            count,
            color = Muted,
            fontSize = 12.sp,
            maxLines = 1,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

@Composable
private fun OverviewFooter(
    note: String,
    mode: String,
    sharing: Boolean,
    remote: Boolean,
    contentWidth: Float,
    fontScale: Float,
    onMode: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            note.ifBlank { tr("Tap a desktop to switch") },
            color = Muted,
            fontSize = 12.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        if (remote) ModeSwitch(mode, sharing, modeSwitchWidthDp(contentWidth, fontScale), onMode)
    }
}

@Composable
private fun DisplayGrid(
    catalog: DesktopSelect.Catalog,
    pendingDisplayId: String,
    cols: Int,
    onDisplay: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (row in catalog.displays.chunked(cols.coerceAtLeast(1))) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (display in row) {
                    DisplayCard(
                        catalog = catalog,
                        display = display,
                        pendingDisplayId = pendingDisplayId,
                        onDisplay = onDisplay,
                        modifier = Modifier.weight(1f),
                    )
                }
                repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun DisplayCard(
    catalog: DesktopSelect.Catalog,
    display: DesktopSelect.Display,
    pendingDisplayId: String,
    onDisplay: (String) -> Unit,
    modifier: Modifier,
) {
    val position = catalog.displays.indexOf(display) + 1
    val label = display.name.ifBlank { tr("This screen") }
    val viewing = display.id == catalog.viewing
    val switching = !viewing && display.id == pendingDisplayId
    val highlighted = viewing || switching
    val status = if (viewing) tr("Viewing") else if (switching) tr("Switching") else ""
    val subtitle = if (display.primary) tr("Main display") else tr("Display {n}", "n" to position)
    val description = buildString {
        append(label).append(", ").append(subtitle)
        if (status.isNotEmpty()) append(", ").append(status)
    }
    val press = remember { MutableInteractionSource() }
    Row(
        modifier
            .defaultMinSize(minHeight = 48.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(if (highlighted) CardOn else Card)
            .border(if (highlighted) 1.5.dp else 0.dp, if (highlighted) Blue else Color.Transparent, RoundedCornerShape(16.dp))
            .clickable(interactionSource = press, indication = ripple(color = Color.White.copy(alpha = 0.18f)), role = Role.Button) { onDisplay(display.id) }
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .clearAndSetSemantics {
                role = Role.Button
                selected = viewing
                contentDescription = description
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MonitorGlyph()
        Column(Modifier.weight(1f).padding(start = 10.dp, end = 8.dp)) {
            Text(label, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, color = if (highlighted) OnCard else Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 1.dp))
        }
        if (status.isNotEmpty()) {
            Text(status, color = Blue, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun DesktopRow(
    display: DesktopSelect.Display,
    desks: List<DesktopSelect.Desk>,
    viewingId: String,
    tileWidth: Float,
    tileHeight: Float,
    targetPx: Int,
    previews: DesktopPreview.Board,
    decodes: PreviewDecodes,
    spaceHold: String,
    onDesktop: (String, String) -> Unit,
) {
    Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(TILE_GAP.dp)) {
        for (desk in desks) {
            key(desk.id) {
                DesktopTile(
                    display = display,
                    desk = desk,
                    viewingId = viewingId,
                    tileWidth = tileWidth,
                    tileHeight = tileHeight,
                    targetPx = targetPx,
                    previews = previews,
                    decodes = decodes,
                    spaceHold = spaceHold,
                    onDesktop = onDesktop,
                )
            }
        }
    }
}

@Composable
private fun DesktopTile(
    display: DesktopSelect.Display,
    desk: DesktopSelect.Desk,
    viewingId: String,
    tileWidth: Float,
    tileHeight: Float,
    targetPx: Int,
    previews: DesktopPreview.Board,
    decodes: PreviewDecodes,
    spaceHold: String,
    onDesktop: (String, String) -> Unit,
) {
    val marked = desk.current
    val viewingThis = marked && display.id == viewingId
    val held = spaceHold == "overview" || spaceHold == "accessibility"
    val shot = previews.shots.find { it.displayId == display.id && it.spaceId == desk.id }
    val bitmap = rememberPreviewBitmap(decodes, previews.session, shot, targetPx)
    val status = DesktopPreview.tile(previews, display.id, desk, held)
    val shown = if (bitmap == null) DesktopPreview.Status.NONE else status
    val fullStatus = when (shown) {
        DesktopPreview.Status.CURRENT -> tr("Current preview")
        DesktopPreview.Status.LAST -> tr("Last seen this session")
        DesktopPreview.Status.NONE -> tr("Not previewed yet")
    }
    val visibleStatus = when (shown) {
        DesktopPreview.Status.CURRENT -> tr("Current")
        DesktopPreview.Status.LAST -> tr("Last seen")
        DesktopPreview.Status.NONE -> tr("No preview")
    }
    val source = remember { MutableInteractionSource() }
    val description = buildString {
        append(tr("Desktop {n}", "n" to desk.index + 1))
        if (viewingThis) append(", ").append(tr("Viewing"))
        append(", ").append(fullStatus)
    }
    Column(
        Modifier
            .width(tileWidth.dp)
            .defaultMinSize(minHeight = 48.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(
                interactionSource = source,
                indication = ripple(bounded = true, color = Color.White.copy(alpha = 0.18f)),
                enabled = desk.selectable,
                role = Role.Button,
            ) { onDesktop(display.id, desk.id) }
            .padding(bottom = 4.dp)
            .clearAndSetSemantics {
                role = Role.Button
                selected = marked
                contentDescription = description
            },
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(tileHeight.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(Thumb)
                .border(if (marked) 1.5.dp else 1.dp, if (marked) Blue else Line, RoundedCornerShape(10.dp)),
        ) {
            if (bitmap != null) {
                Image(bitmap, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            }
        }
        Row(Modifier.padding(start = 2.dp, top = 6.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            if (marked) Box(Modifier.padding(end = 4.dp).size(5.dp).clip(RoundedCornerShape(3.dp)).background(Blue))
            Text(
                tr("Desktop {n}", "n" to desk.index + 1),
                color = if (marked) Color.White else Ink,
                fontSize = 12.sp,
                fontWeight = if (marked) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            visibleStatus,
            color = if (shown == DesktopPreview.Status.CURRENT) Blue else Muted,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 2.dp, top = 1.dp, end = 2.dp),
        )
    }
}

@Composable
private fun rememberPreviewBitmap(decodes: PreviewDecodes, session: Long, shot: DesktopPreview.Shot?, targetPx: Int): androidx.compose.ui.graphics.ImageBitmap? {
    val bucket = previewTargetBucket(targetPx)
    val cacheKey = shot?.let { PreviewCacheKey(session, it.displayId, it.spaceId, it.seq, bucket) }
    var image by remember(decodes, cacheKey) { mutableStateOf(cacheKey?.let { decodes.peek(it)?.asImageBitmap() }) }
    LaunchedEffect(decodes, cacheKey) {
        val key = cacheKey
        if (key == null) {
            image = null
            return@LaunchedEffect
        }
        // key is this shot's session, display, space, and sequence. A mismatch is not this tile.
        val current = shot
        if (current.displayId != key.displayId || current.spaceId != key.spaceId || current.seq != key.seq || key.session != session) {
            image = null
            return@LaunchedEffect
        }
        decodes.peek(key)?.let {
            image = it.asImageBitmap()
            return@LaunchedEffect
        }
        image = null
        val jpeg = current.jpeg
        val decoded = withContext(Dispatchers.Default) { decodePreviewBitmap(jpeg, bucket * 32) }
        if (decoded != null && isActive) {
            decodes.put(key, decoded)
            image = decoded.asImageBitmap()
        }
    }
    return image
}

@Composable
private fun ModeSwitch(mode: String, sharing: Boolean, widthDp: Float, onMode: (String) -> Unit) {
    Row(
        Modifier
            .width(widthDp.dp)
            .height(48.dp)
            .clip(RoundedCornerShape(24.dp))
            .background(Track),
    ) {
        for (item in listOf("mirror", "extend")) {
            val on = sharing && (mode == item || (item == "mirror" && mode == "custom"))
            val label = if (item == "mirror") tr("Mirror") else tr("Extend")
            val source = remember(item) { MutableInteractionSource() }
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .clickable(
                        interactionSource = source,
                        indication = ripple(color = Color.White.copy(alpha = 0.20f)),
                        enabled = !on,
                        role = Role.Button,
                    ) { onMode(item) }
                    .padding(3.dp)
                    .clip(RoundedCornerShape(21.dp))
                    .background(if (on) Segment else Color.Transparent)
                    .clearAndSetSemantics {
                        role = Role.Button
                        selected = on
                        contentDescription = label
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                    color = if (on) Color.White else Color(0xFFE6E6EA),
                    fontSize = 14.sp,
                    fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Ellipsis,
                    autoSize = TextAutoSize.StepBased(minFontSize = 10.sp, maxFontSize = 14.sp, stepSize = 1.sp),
                )
            }
        }
    }
}

@Composable
private fun MonitorGlyph() {
    androidx.compose.foundation.Canvas(Modifier.size(width = 22.dp, height = 17.dp)) {
        val stroke = 1.6.dp.toPx()
        drawRoundRect(
            color = Color(0xFFD5DBE7),
            topLeft = androidx.compose.ui.geometry.Offset(stroke, stroke),
            size = androidx.compose.ui.geometry.Size(size.width - stroke * 2, size.height * 0.68f),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(3.dp.toPx(), 3.dp.toPx()),
            style = androidx.compose.ui.graphics.drawscope.Stroke(stroke),
        )
        drawLine(Color(0xFFD5DBE7), androidx.compose.ui.geometry.Offset(size.width / 2, size.height * 0.72f), androidx.compose.ui.geometry.Offset(size.width / 2, size.height * 0.9f), stroke)
        drawLine(Color(0xFFD5DBE7), androidx.compose.ui.geometry.Offset(size.width * 0.32f, size.height * 0.9f), androidx.compose.ui.geometry.Offset(size.width * 0.68f, size.height * 0.9f), stroke)
    }
}
