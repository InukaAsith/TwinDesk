// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A computer's LAN addresses (welcome "lan" and "lanPort", shared/lanaddrs.js, #287): on a network that
// drops broadcasts (campus, office, guest Wi-Fi), discovery never sees the computer, so a session that
// came through Bluetooth stayed there. With these the phone dials the computer on the Wi-Fi itself, the
// addresses that share this phone's network first; a dial that fails leaves the session on Bluetooth.
package com.twindesk.android

import org.json.JSONArray

object Lan {
    private const val MAX = 3
    private val V4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

    fun isPrivate(a: String): Boolean {
        val m = V4.find(a) ?: return false
        val b1 = m.groupValues[1].toInt()
        val b2 = m.groupValues[2].toInt()
        return b1 == 10 || (b1 == 172 && b2 in 16..31) || (b1 == 192 && b2 == 168)
    }

    fun clean(a: JSONArray?): List<String> {
        if (a == null) return emptyList()
        return (0 until a.length()).map { a.optString(it) }.filter { isPrivate(it) }.distinct().take(MAX)
    }

    // This phone's private IPv4 addresses now (its Wi-Fi's).
    fun mine(): List<String> = runCatching {
        java.net.NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().filter { it.isUp && !it.isLoopback }
            .flatMap { n -> n.inetAddresses.toList().mapNotNull { it.hostAddress?.substringBefore('%') } }
            .filter { isPrivate(it) }
    }.getOrDefault(emptyList())

    // The computer's addresses this phone may reach: on its network (the first two parts alike: a /16 or
    // narrower, as most LANs), nearest first. None when the phone has no private address (mobile data).
    fun reachable(lan: List<String>, mine: List<String> = mine()): List<String> {
        if (mine.isEmpty()) return emptyList()
        val prefixes = mine.map { it.split('.').take(2).joinToString(".") }
        val near = lan.filter { a -> prefixes.any { a.startsWith("$it.") } }
        val sameThree = mine.map { it.substringBeforeLast('.') }
        return near.sortedBy { a -> if (sameThree.any { a.startsWith("$it.") }) 0 else 1 }
    }
}
