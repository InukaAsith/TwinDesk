// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

internal enum class ConnectionCloseReason {
    LOCAL, INTERRUPTED, ASLEEP, REPLACED, RELEASED, BAD_PAIRING, IDENTITY, VERSION, PAUSED;

    companion object {
        fun from(code: String?, identity: Boolean): ConnectionCloseReason = when {
            identity -> IDENTITY
            code == "local" -> LOCAL
            code == "asleep" -> ASLEEP
            code == "replaced" -> REPLACED
            code == "released" -> RELEASED
            code == "bad_token" -> BAD_PAIRING
            code == "version_mismatch" -> VERSION
            code == "paused" -> PAUSED
            else -> INTERRUPTED
        }
    }
}

internal data class ConnectionCloseObservation(
    val id: String,
    val fingerprint: String,
    val reason: ConnectionCloseReason,
    val at: Long,
)

// One process-local observation. Reconnecting the same pair keeps the reason available;
// selecting another pair discards it before a new dial can publish state.
internal class ConnectionObservations {
    @Volatile private var last: ConnectionCloseObservation? = null

    fun select(id: String, fingerprint: String) {
        if (last?.let { it.id != id || it.fingerprint != fingerprint } == true) last = null
    }

    fun closed(id: String, fingerprint: String, code: String?, identity: Boolean, at: Long) {
        last = ConnectionCloseObservation(id, fingerprint, ConnectionCloseReason.from(code, identity), at)
    }

    fun forPair(id: String, fingerprint: String): ConnectionCloseObservation? =
        last?.takeIf { it.id == id && it.fingerprint == fingerprint }
}

internal fun doctorTransport(core: Core): String {
    val link = core.link
    val endpoint = if (link.connected) link.endpoint() else null
    return when {
        !link.connected -> tr("Not connected")
        link.wired -> "USB"
        link.ble -> tr("Bluetooth")
        endpoint?.first == "127.0.0.1" && endpoint.second in Relay.ports -> tr("Your own relay")
        Tailnet.isTailnet(endpoint?.first.orEmpty()) -> "Tailscale"
        else -> tr(core.net.via)
    }
}
