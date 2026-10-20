// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What the phone remembers: its identity, the computers it paired with (hosts) and its settings.
package com.twindesk.android

import android.content.Context
import android.os.Build
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject

// A paired computer this phone connects to (it hosts the session).
data class Host(
    val id: String,
    var name: String,
    val os: String,
    var address: String,
    var port: Int,
    val fp: String,
    val token: String,
    var lastSeen: Long,
) {
    fun json(): JSONObject = JSONObject()
        .put("id", id).put("name", name).put("os", os).put("address", address)
        .put("port", port).put("fp", fp).put("token", token).put("lastSeen", lastSeen)

    companion object {
        fun from(o: JSONObject) = Host(
            o.getString("id"), o.optString("name", "Mac"), o.optString("os", "mac"), o.optString("address"),
            o.optInt("port", Proto.PORT), o.getString("fp"), o.getString("token"), o.optLong("lastSeen"),
        )
    }
}

class Store(private val ctx: Context) {
    private val prefs = ctx.getSharedPreferences("twindesk", Context.MODE_PRIVATE)

    val deviceId: String = prefs.getString("deviceId", null) ?: Proto.randomHex(16).also {
        prefs.edit().putString("deviceId", it).apply()
    }

    // The phone's own name as people know it (Settings › About › Device name). Some phones (MIUI)
    // leave that as the model number ("M2010J19CG") and keep the real one ("POCO M3") as the
    // Bluetooth name and the marketing name.
    val deviceName: String
        get() = prefs.getString("deviceName", null)?.takeIf { it.isNotBlank() }
            ?: Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() && it != Build.MODEL }
            ?: runCatching { Settings.Secure.getString(ctx.contentResolver, "bluetooth_name") }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: marketName()
            ?: Build.MODEL

    private fun marketName(): String? = runCatching {
        val sp = Class.forName("android.os.SystemProperties")
        val get = sp.getMethod("get", String::class.java)
        listOf("ro.product.marketname", "ro.product.vendor.marketname", "ro.config.marketing_name")
            .map { get.invoke(null, it) as String }.firstOrNull { it.isNotBlank() }
    }.getOrNull()

    fun setDeviceName(name: String) = prefs.edit().putString("deviceName", name.trim().take(64)).apply()

    fun hosts(): List<Host> = try {
        val a = JSONArray(prefs.getString("hosts", "[]"))
        (0 until a.length()).map { Host.from(a.getJSONObject(it)) }
    } catch (e: Exception) {
        emptyList()
    }

    fun saveHosts(list: List<Host>) = prefs.edit().putString("hosts", jsonArray(list.map { it.json() }).toString()).apply()

    fun putHost(h: Host) = saveHosts(listOf(h) + hosts().filter { it.id != h.id })

    fun forgetHost(id: String) = saveHosts(hosts().filter { it.id != id })

    // Settings: one boolean per switch.
    fun flag(key: String, default: Boolean): Boolean = prefs.getBoolean(key, default)
    fun setFlag(key: String, on: Boolean) = prefs.edit().putBoolean(key, on).apply()

    fun prefsString(key: String, default: String): String = prefs.getString(key, default) ?: default
    fun setPrefsString(key: String, v: String) = prefs.edit().putString(key, v).apply()

    fun prefsSet(key: String): Set<String> = prefs.getStringSet(key, emptySet()) ?: emptySet()
    fun setPrefsSet(key: String, v: Set<String>) = prefs.edit().putStringSet(key, v).apply()

    // Two-way switches remembered per pair (pair.sync), as JSON by host id.
    fun pairSync(hostId: String): JSONObject? = prefs.getString("sync.$hostId", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    fun setPairSync(hostId: String, v: JSONObject) = prefs.edit().putString("sync.$hostId", v.toString()).apply()

    // The newest shared layout heard of (docs/mesh.md, "Shared layout"), kept as its JSON text.
    fun getLayout(): JSONObject? = prefs.getString("layout", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    fun setLayout(v: JSONObject) = prefs.edit().putString("layout", v.toString()).apply()
}
