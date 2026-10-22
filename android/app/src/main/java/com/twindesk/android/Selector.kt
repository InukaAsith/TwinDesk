// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer selector in the header: which computer the phone's one-to-one features work with.
// PURE Kotlin (no Android classes), so the JVM tests run it as it is (SelectorTest.kt). Core feeds it
// the paired computers and their links; MainActivity draws the result.
package com.twindesk.android

// A paired computer as the selector sees it. state: "connected" | "connecting" | "offline".
// transport: "usb" | "ble" | "ip" for a connected one, "" otherwise.
data class PcEntry(val id: String, val name: String, val os: String, val state: String, val transport: String, val near: Boolean = false)

enum class PcAction { USE, CONNECT, NONE }

// One line of the dropdown. action: USE = core.select(id); CONNECT = core.connect(host) then use it;
// NONE = disabled (it is connecting already).
data class PcChoice(
    val id: String,
    val name: String,
    val os: String,
    val state: String,
    val transport: String,
    val selected: Boolean,
    val action: PcAction,
    val detail: String,
)

// label: the header text; dot: "good" | "warn" | "faint"; expandable: show the arrow and open the list.
data class PcSelector(val choices: List<PcChoice>, val current: PcChoice?, val label: String, val dot: String, val expandable: Boolean)

object PcSelect {
    const val NONE = "No computer"
    const val IDLE = "Not connected"

    fun osName(os: String) = when (os) { "mac" -> "Mac"; "linux" -> "Linux"; "win" -> "PC"; "android" -> "Android"; else -> "" }

    fun transportName(t: String) = when (t) { "usb" -> "USB"; "ble" -> "Bluetooth"; "ip" -> "Wi-Fi"; else -> "" }

    private fun rank(state: String) = when (state) { "connected" -> 0; "connecting" -> 1; else -> 2 }

    // attachedId: the computer the features are attached to now (Core.host?.id), null when none is connected.
    // Order: connected first, then connecting, then paired-only; the input order is kept inside each group.
    fun build(entries: List<PcEntry>, attachedId: String?): PcSelector {
        val ordered = entries.withIndex().sortedWith(compareBy({ rank(it.value.state) }, { it.index })).map { it.value }
        val att = attachedId?.takeIf { id -> entries.any { it.id == id && it.state == "connected" } }
        val choices = ordered.map { e ->
            val name = e.name.ifEmpty { osName(e.os).ifEmpty { "Computer" } }
            val detail = when (e.state) {
                "connected" -> listOf(osName(e.os), transportName(e.transport)).filter { it.isNotEmpty() }.joinToString(" · ")
                "connecting" -> "Connecting…"
                else -> if (e.near) "Paired · nearby" else "Paired · not nearby"
            }
            PcChoice(
                e.id, name, e.os, e.state, e.transport, e.id == att,
                when (e.state) { "connected" -> PcAction.USE; "connecting" -> PcAction.NONE; else -> PcAction.CONNECT },
                detail,
            )
        }
        val current = choices.firstOrNull { it.selected }
        val connecting = choices.firstOrNull { it.state == "connecting" }
        val label = when {
            current != null -> current.name
            choices.isEmpty() -> NONE
            connecting != null -> connecting.name
            else -> IDLE
        }
        val dot = when {
            current != null -> "good"
            connecting != null -> "warn"
            else -> "faint"
        }
        return PcSelector(choices, current, label, dot, choices.size >= 2)
    }

    // The attached computer: the selected one while it is connected, else the most recently connected
    // one (since: when each session started), else none. Core.attach() uses it.
    fun pickAttached(selectedId: String?, connected: List<String>, since: Map<String, Long>): String? =
        selectedId?.takeIf { it in connected } ?: connected.maxByOrNull { since[it] ?: 0L }
}
