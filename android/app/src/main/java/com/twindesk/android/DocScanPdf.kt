// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Scan document (Camera › Scan document on the computer): pages from the phone's camera, turned
// into one PDF with Android's own PdfDocument. No library and no cloud. Each photo is decoded
// small (a 50 MP picture never becomes a full bitmap), turned upright, and drawn on a white page.
package com.twindesk.android

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.RectF
import android.graphics.pdf.PdfDocument
import android.media.ExifInterface
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class ScanPage(val path: String, val deg: Int)

object DocScanPdf {
    const val MAX_PAGES = 30
    private const val MAX_PX = 1800 // the long edge of a page in the PDF
    private const val PAGE_W = 595 // A4, in points
    private const val PAGE_H = 842
    private const val MARGIN = 28
    private const val JPEG_Q = 82

    var saving by mutableStateOf(false)
    @Volatile var saveGen = 0

    fun sampleSize(width: Int, height: Int, maxPx: Int): Int {
        var sample = 1
        var w = width
        var h = height
        while (w > maxPx || h > maxPx) {
            sample *= 2
            w /= 2
            h /= 2
        }
        return sample
    }

    // 0, 90, 180 or 270. android.media.ExifInterface is in the platform (API 24+); no library.
    fun exifDegrees(path: String): Int = runCatching {
        val exif = ExifInterface(path)
        when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_TRANSPOSE -> 90
            ExifInterface.ORIENTATION_ROTATE_180 -> 180
            ExifInterface.ORIENTATION_ROTATE_270, ExifInterface.ORIENTATION_TRANSVERSE -> 270
            else -> 0
        }
    }.getOrDefault(0)

    // A small bitmap, upright (the file's EXIF plus the user's extra turns). Null if it can't be read.
    // The caller recycles a PDF bitmap; a thumbnail stays, because Compose is still drawing it.
    fun decode(path: String, extraDeg: Int, maxPx: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxPx)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val src = BitmapFactory.decodeFile(path, opts) ?: return null
        val deg = Math.floorMod(exifDegrees(path) + extraDeg, 360)
        if (deg == 0) return src
        val turned = Bitmap.createBitmap(src, 0, 0, src.width, src.height, Matrix().apply { postRotate(deg.toFloat()) }, true)
        if (turned != src) src.recycle()
        return turned
    }

    fun write(pages: List<ScanPage>, out: OutputStream) {
        val pdf = PdfDocument()
        var written = 0
        try {
            for (page in pages) {
                val raw = decode(page.path, page.deg, MAX_PX) ?: continue
                val jpeg = ByteArrayOutputStream()
                val ok = raw.compress(Bitmap.CompressFormat.JPEG, JPEG_Q, jpeg)
                raw.recycle()
                if (!ok) continue
                val bytes = jpeg.toByteArray()
                val jpg = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: continue
                try {
                    written += 1
                    val pg = pdf.startPage(PdfDocument.PageInfo.Builder(PAGE_W, PAGE_H, written).create())
                    val canvas = pg.canvas
                    canvas.drawColor(Color.WHITE)
                    val maxW = (PAGE_W - 2 * MARGIN).toFloat()
                    val maxH = (PAGE_H - 2 * MARGIN).toFloat()
                    val scale = minOf(maxW / jpg.width, maxH / jpg.height)
                    val dw = jpg.width * scale
                    val dh = jpg.height * scale
                    val left = (PAGE_W - dw) / 2f
                    val top = (PAGE_H - dh) / 2f
                    canvas.drawBitmap(jpg, null, RectF(left, top, left + dw, top + dh), null)
                    pdf.finishPage(pg)
                } finally {
                    jpg.recycle()
                }
            }
            if (written == 0) error("no pages")
            pdf.writeTo(out)
        } finally {
            pdf.close()
        }
    }

    // Documents/TwinDesk/TwinDesk_Scan_YYYYMMDD_HHmmss.pdf. A cache file if the store refuses the insert.
    fun save(ctx: Context, pages: List<ScanPage>): Uri {
        val name = "TwinDesk_Scan_" + SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date()) + ".pdf"
        val resolver = ctx.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf")
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOCUMENTS + "/TwinDesk")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = runCatching { resolver.insert(MediaStore.Files.getContentUri("external"), values) }.getOrNull()
        if (uri != null) {
            val stream = runCatching { resolver.openOutputStream(uri) }.getOrNull()
            if (stream != null) {
                try {
                    stream.use { write(pages, it) }
                    resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                    return uri
                } catch (e: Exception) {
                    runCatching { resolver.delete(uri, null, null) }
                    throw e
                }
            }
            runCatching { resolver.delete(uri, null, null) }
        }
        val dir = File(ctx.cacheDir, "scan_pdf").apply { mkdirs() }
        val file = File(dir, name)
        try {
            FileOutputStream(file).use { write(pages, it) }
            return FileProvider.getUriForFile(ctx, ctx.packageName + ".files", file)
        } catch (e: Exception) {
            file.delete()
            throw e
        }
    }

    fun discard(ctx: Context, uri: Uri) {
        runCatching { ctx.contentResolver.delete(uri, null, null) }
        val name = uri.lastPathSegment?.substringAfterLast('/') ?: return
        val cached = File(File(ctx.cacheDir, "scan_pdf"), name)
        if (cached.isFile) cached.delete()
    }
}

@Composable
fun ScanScreen(
    pages: List<ScanPage>,
    busy: Boolean,
    note: String,
    onAdd: () -> Unit,
    onRemoveLast: () -> Unit,
    onRotateLast: () -> Unit,
    onRetake: () -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
) {
    val n = pages.size
    val count = if (n == 1) tr("1 page") else tr("{count} pages", "count" to n)
    val has = n > 0 && !busy
    Column(
        Modifier.fillMaxSize().background(pal.sheet).windowInsetsPadding(WindowInsets.safeDrawing)
            .verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(tr("Scan document"), color = pal.text, fontSize = 22.sp)
        Text(count, color = pal.muted, fontSize = 15.sp)
        if (note.isNotEmpty()) Text(note, color = pal.bad, fontSize = 14.sp)
        if (n > 0) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                pages.forEach { PageThumb(it) }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = onRotateLast, enabled = has) { Text(tr("Rotate")) }
            TextButton(onClick = onRetake, enabled = has) { Text(tr("Retake")) }
            TextButton(onClick = onRemoveLast, enabled = has) { Text(tr("Remove last page")) }
        }
        Button(onClick = onAdd, enabled = !busy && n < DocScanPdf.MAX_PAGES, modifier = Modifier.fillMaxWidth()) { Text(tr("Add page")) }
        Button(onClick = onSave, enabled = has, modifier = Modifier.fillMaxWidth()) { Text(tr("Save and send PDF")) }
        TextButton(onClick = onCancel, enabled = !busy, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text(tr("Cancel")) }
    }
}

@Composable
private fun PageThumb(page: ScanPage) {
    var bmp by remember(page.path, page.deg) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    LaunchedEffect(page.path, page.deg) {
        val decoded = withContext(Dispatchers.IO) { DocScanPdf.decode(page.path, page.deg, 360) }
        bmp = decoded?.asImageBitmap()
    }
    val shape = RoundedCornerShape(10.dp)
    val b = bmp
    if (b == null) {
        androidx.compose.foundation.layout.Box(Modifier.size(72.dp).clip(shape).background(pal.chip))
    } else {
        Image(
            b, contentDescription = null,
            modifier = Modifier.height(96.dp).clip(shape).background(pal.card),
            contentScale = ContentScale.Fit,
        )
    }
}
