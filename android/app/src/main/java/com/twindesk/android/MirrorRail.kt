// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The side rail of a screen shown here full screen (the computer's, ViewerActivity; another phone's,
// PeerViewActivity), as the computers' phone windows have (shared/mirror-rail.js): a column down the
// right with Auto-rotate (on: this screen turns with the phone; off: it stays the way it is now) and
// Screenshot (the picture, saved in Pictures › TwinDesk). A small tab at the right edge shows or
// hides it; both remembered. Nothing runs until a button is pressed.
package com.twindesk.android

import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.provider.MediaStore
import android.view.Gravity
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

class MirrorRail(
    private val activity: Activity,
    // Null: this screen follows the phone (another phone). The computer viewer passes its own rule.
    private val orient: ((Boolean) -> Int?)? = null,
    private val surface: () -> SurfaceView? = { null },
) {
    private val prefs = activity.getSharedPreferences(ViewerOrientation.PREFS, Context.MODE_PRIVATE)
    private val dp = activity.resources.displayMetrics.density
    private lateinit var overlay: FrameLayout
    private lateinit var rail: LinearLayout
    private lateinit var tab: TextView
    private lateinit var rotateBtn: TextView

    // Over the activity's content, at its right edge.
    fun attach() {
        val root = FrameLayout(activity).also { overlay = it }
        rail = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = GradientDrawable().apply { setColor(0xE6202124.toInt()); cornerRadius = 16 * dp }
            setPadding((6 * dp).toInt(), (8 * dp).toInt(), (6 * dp).toInt(), (8 * dp).toInt())
        }
        rotateBtn = button("⟳", ::toggleRotation)
        rail.addView(rotateBtn)
        rail.addView(button("◉") { shot() }.also { it.contentDescription = tr("Screenshot (saved in Pictures › TwinDesk)") })
        tab = TextView(activity).apply {
            text = "‹"
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
            background = GradientDrawable().apply { setColor(0x55FFFFFF); cornerRadius = 9 * dp }
            contentDescription = tr("Side rail: rotation and screenshot")
            setOnClickListener { show(rail.visibility != View.VISIBLE) }
        }
        root.addView(rail, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.END or Gravity.CENTER_VERTICAL).apply { marginEnd = (28 * dp).toInt() })
        root.addView(tab, FrameLayout.LayoutParams((18 * dp).toInt(), (72 * dp).toInt(), Gravity.END or Gravity.CENTER_VERTICAL).apply { marginEnd = (4 * dp).toInt() })
        activity.addContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.isClickable = false
        show(prefs.getBoolean("shown", false))
        setAuto(prefs.getBoolean(ViewerOrientation.AUTO, true))
    }

    private fun button(glyph: String, onClick: () -> Unit) = TextView(activity).apply {
        text = glyph
        setTextColor(Color.WHITE)
        textSize = 22f
        gravity = Gravity.CENTER
        minWidth = (44 * dp).toInt()
        minHeight = (44 * dp).toInt()
        isClickable = true
        setOnClickListener { onClick() }
    }

    private fun show(on: Boolean) {
        rail.visibility = if (on) View.VISIBLE else View.GONE
        tab.text = if (on) "›" else "‹"
        prefs.edit().putBoolean("shown", on).apply()
    }

    fun showEdge(show: Boolean) {
        if (::overlay.isInitialized) overlay.visibility = if (show) View.VISIBLE else View.GONE
    }

    var autoRotate by mutableStateOf(true)
        private set

    fun toggleRotation() = setAuto(!autoRotate)
    fun capture() = shot()

    private fun setAuto(on: Boolean) {
        autoRotate = on
        // Off: locked the way it is now (Android keeps the current orientation).
        // The computer viewer supplies the host rule. Another phone's screen turns with this one.
        val chosen = if (orient != null) orient.invoke(on)
        else if (on) ActivityInfo.SCREEN_ORIENTATION_FULL_USER
        else ActivityInfo.SCREEN_ORIENTATION_LOCKED
        if (chosen != null) activity.requestedOrientation = chosen
        rotateBtn.alpha = if (on) 1f else 0.5f
        rotateBtn.text = if (on) "⟳" else "🔒"
        val label = if (on) tr("Auto-rotate is on: the screen turns with this phone") else tr("Auto-rotate is off: the screen stays as it is")
        rotateBtn.contentDescription = label
        if (on != prefs.getBoolean(ViewerOrientation.AUTO, true)) Toast.makeText(activity, label, Toast.LENGTH_SHORT).show()
        prefs.edit().putBoolean(ViewerOrientation.AUTO, on).apply()
    }

    // The picture as it is on this screen (PixelCopy: the video too), into Pictures › TwinDesk.
    private fun shot() {
        val v = activity.window.decorView
        if (v.width <= 0 || v.height <= 0) return
        val sv = surface()
        val w = sv?.width ?: v.width
        val h = sv?.height ?: v.height
        if (w <= 0 || h <= 0) return
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val t = HandlerThread("td-rail-shot").also { it.start() }
        val done = { r: Int ->
            t.quitSafely()
            if (r == PixelCopy.SUCCESS) save(bmp) else activity.runOnUiThread { Toast.makeText(activity, tr("Couldn’t take the screenshot"), Toast.LENGTH_SHORT).show() }
        }
        if (sv != null) PixelCopy.request(sv, bmp, { done(it) }, Handler(t.looper))
        else PixelCopy.request(activity.window, bmp, { done(it) }, Handler(t.looper))
    }

    private fun save(bmp: Bitmap) {
        val ok = runCatching {
            val name = "TwinDesk ${java.text.SimpleDateFormat("yyyy-MM-dd HH.mm.ss", java.util.Locale.US).format(java.util.Date())}.png"
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/TwinDesk")
            }
            val r = activity.contentResolver
            val uri = r.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: error("no uri")
            r.openOutputStream(uri)!!.use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }.isSuccess
        bmp.recycle()
        activity.runOnUiThread {
            Toast.makeText(activity, if (ok) tr("Screenshot saved in Pictures › TwinDesk") else tr("Couldn’t take the screenshot"), Toast.LENGTH_SHORT).show()
        }
    }

}
