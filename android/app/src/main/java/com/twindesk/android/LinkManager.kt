// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The sessions with every paired computer (docs/mesh.md): one Link per host, each with its own
// reconnect backoff, and a list of the hosts the user let go (they are not dialled again until the
// user connects them). Dialling itself is Core's: it asks which hosts are due.
package com.twindesk.android

class LinkManager(private val store: Store, private val events: Link.Events) {
    private class Retry(var attempts: Int, var nextAt: Long)

    private val links = HashMap<String, Link>()
    private val retry = HashMap<String, Retry>()
    private val paused = HashSet<String>()

    @Synchronized fun linkFor(id: String): Link = links.getOrPut(id) { Link(store, events) }

    @Synchronized fun existing(id: String): Link? = links[id]

    @Synchronized fun all(): List<Link> = links.values.toList()

    @Synchronized fun connectedLinks(): List<Link> = links.values.filter { it.connected }

    // The user connects this host (or it is invited): dial it again from now on.
    @Synchronized fun resume(id: String) {
        paused.remove(id)
        retry.remove(id)
    }

    // The user let go of this host: no reconnect until the user connects it again.
    @Synchronized fun pause(id: String) {
        paused.add(id)
    }

    // A session with this host is up.
    @Synchronized fun welcomed(id: String) {
        retry.remove(id)
    }

    // A session with this host ended. The computer let go or replaced us: stop. Anything else
    // (the network, a timeout, a busy computer) redials with the backoff of Proto.RECONNECT_MS.
    // "local" is our own doing (a switch or a disconnect) and needs no bookkeeping here.
    @Synchronized fun closed(id: String, code: String?, now: Long) {
        when (code) {
            "local" -> Unit
            Proto.E.RELEASED, Proto.E.REPLACED, Proto.E.BAD_TOKEN -> paused.add(id)
            else -> {
                val r = retry.getOrPut(id) { Retry(0, 0L) }
                r.attempts += 1
                val steps = Proto.RECONNECT_MS
                val wait = steps[minOf(r.attempts - 1, steps.size - 1)]
                r.nextAt = now + wait
            }
        }
    }

    // The paired hosts to dial now: not paused, not connected or connecting, past their backoff and
    // (the caller's test) nearby. A host whose link failed for good (identity changed) waits for Forget.
    @Synchronized fun due(now: Long, nearby: (String) -> Boolean): List<Host> = store.hosts().filter { h ->
        if (h.id in paused) return@filter false
        val l = links[h.id]
        if (l != null && (l.connected || l.state == "connecting" || l.state == "failed")) return@filter false
        val r = retry[h.id]
        if (r != null && now < r.nextAt) return@filter false
        nearby(h.id)
    }

    // The user removed this host: close it and forget everything about it.
    @Synchronized fun forget(id: String) {
        paused.remove(id)
        retry.remove(id)
        links.remove(id)?.disconnect()
    }
}
