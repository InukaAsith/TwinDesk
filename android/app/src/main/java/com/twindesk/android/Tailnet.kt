// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tailscale (#161, shared/tailnet.js): a computer tells this phone its Tailscale addresses (welcome
// "tail"); when discovery doesn't see that computer (mobile data, another network), every other
// Connect dials one of them instead of the last address. Only while this phone is on Tailscale
// itself (an address in 100.64.0.0/10 or fd7a:115c:a1e0::/48) and General › Tailscale is on.
package com.twindesk.android

import org.json.JSONArray

object Tailnet {
    private const val MAX = 2

    fun isTailnet(a: String): Boolean {
        val m = Regex("^100\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").find(a)
        if (m != null) {
            val (b, c, d) = m.destructured
            return b.toInt() in 64..127 && c.toInt() <= 255 && d.toInt() <= 255
        }
        return a.lowercase().startsWith("fd7a:115c:a1e0:")
    }

    fun clean(a: JSONArray?): List<String> {
        if (a == null) return emptyList()
        return (0 until a.length()).map { a.optString(it) }.filter { isTailnet(it) }.distinct().take(MAX)
    }

    // This phone is on Tailscale (its VPN is up).
    fun onIt(): Boolean = runCatching {
        java.net.NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().any { n ->
            n.isUp && n.inetAddresses.toList().any { isTailnet(it.hostAddress?.substringBefore('%') ?: "") }
        }
    }.getOrDefault(false)

    // The computer's Tailscale address to try (IPv4 first), or null.
    fun address(h: Host): String? = h.tail.firstOrNull { !it.contains(':') } ?: h.tail.firstOrNull()
}

// General › Tailscale: the switch, and how to set it up.
@androidx.compose.runtime.Composable
fun TailscaleCard(core: Core) {
    MacCard("Tailscale") {
        SwitchRow(tr("Connect through Tailscale"), if (core.tailscale) tr("When the computer isn’t on this network, Connect tries its Tailscale address") else tr("Off: only this network, Bluetooth and the cable"), core.tailscale, first = true) { core.tailscale = it }
        MacRow(tr("How to set it up"), tr("1. Install Tailscale on this phone and on the computer, and sign in to the same account on both. 2. Pair them once here, on the same Wi-Fi (or type the computer’s Tailscale address, 100.x.y.z, in Pair by address). 3. Away from that Wi-Fi, keep Tailscale on and tap Connect: TwinDesk reaches the computer through it, even over mobile data."))
        MacRow(tr("This phone"), if (Tailnet.onIt()) tr("On Tailscale") else tr("Not on Tailscale now"))
    }
}
