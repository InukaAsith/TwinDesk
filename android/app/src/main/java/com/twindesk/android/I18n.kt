// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The app's language, as on the desktop (shared/i18n.js): the English text in the code is the key,
// assets/i18n/<language>.json gives another language's text, and anything missing stays English.
// General › Language picks one; until then the phone's own language decides.
// What only goes to the computer (errors and labels it shows) stays English: the computer translates it.
package com.twindesk.android

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import java.util.Locale

object I18n {
    // What General offers, each in its own language.
    val LANGUAGES = listOf(
        "en" to "English", "zh-CN" to "简体中文", "ru" to "Русский", "tr" to "Türkçe", "pt-BR" to "Português (Brasil)",
    )
    // Shown before each name in the picker.
    val FLAGS = mapOf("en" to "🇬🇧", "zh-CN" to "🇨🇳", "ru" to "🇷🇺", "tr" to "🇹🇷", "pt-BR" to "🇧🇷")
    private const val PREF = "language"

    // Read by every tr(): Compose redraws what it drew with it when the language changes.
    var lang by mutableStateOf("en"); private set
    @Volatile private var messages: Map<String, String> = emptyMap()
    private var app: Context? = null

    // The saved choice; "" follows the phone's language.
    var choice = ""; private set

    fun init(ctx: Context, store: Store) {
        app = ctx.applicationContext
        choice = store.prefsString(PREF, "").takeIf { known(it) }.orEmpty()
        use(resolve(choice))
    }

    fun choose(code: String, store: Store) {
        if (!known(code)) return
        choice = code
        store.setPrefsString(PREF, code)
        use(code)
    }

    private fun known(code: String) = LANGUAGES.any { it.first == code }

    // As on the desktop: Chinese in Simplified Chinese (Traditional scripts and regions stay English),
    // Russian, Turkish, and any Portuguese (Brazil, Portugal…) in Brazilian Portuguese.
    fun resolve(pref: String, system: Locale = Locale.getDefault()): String = when {
        known(pref) -> pref
        system.language == "zh" && system.script != "Hant" && system.country !in setOf("TW", "HK", "MO") -> "zh-CN"
        system.language == "ru" -> "ru"
        system.language == "tr" -> "tr"
        system.language == "pt" -> "pt-BR"
        else -> "en"
    }

    private fun use(code: String) {
        messages = if (code == "en") emptyMap() else load(code)
        lang = code
    }

    private fun load(code: String): Map<String, String> = runCatching {
        val text = app!!.assets.open("i18n/$code.json").bufferedReader().use { it.readText() }
        val o = JSONObject(text)
        buildMap { for (k in o.keys()) o.optString(k).takeIf { it.isNotEmpty() }?.let { put(k, it) } }
    }.getOrDefault(emptyMap())

    // "camera|Back": one English word with another meaning there; English shows what follows the |.
    fun text(key: String): String = (if (lang == "en") null else messages[key]) ?: key.substringAfter('|')
}

private val VAR = Regex("\\{(\\w+)\\}")

// The text in this phone's language. {name} parts are filled once, so braces or dollars in a
// device's name stay as they are.
fun tr(text: String, vararg vars: Pair<String, Any?>): String {
    val s = I18n.text(text)
    if (vars.isEmpty()) return s
    return VAR.replace(s) { m -> vars.firstOrNull { it.first == m.groupValues[1] }?.second?.toString() ?: m.value }
}

// "1 file" / "3 files", in this phone's language (Files.plural stays English for the computer).
fun trCount(n: Int, what: String): String = if (n == 1) tr("1 $what") else tr("{count} ${what}s", "count" to n)
