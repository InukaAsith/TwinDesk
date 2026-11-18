// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard › While away, in memory only. The copies belong to one authenticated pair: its known id
// and the fingerprint it pinned. They go out only when that same pair is back. Another computer, a
// replaced fingerprint (the pair was made again), or a forgotten one never receives them.
package com.twindesk.android

internal class ClipAway {
    data class Owner(val id: String, val fp: String)
    data class Item(val text: String, val at: Long)
    data class Flush(val epoch: Int, val items: List<Item>)

    private val lock = Any()
    private val items = ArrayList<Item>()
    private var owner: Owner? = null
    private var epoch = 0

    val size: Int get() = synchronized(lock) { items.size }
    fun owner(): Owner? = synchronized(lock) { owner }

    // knownFp is the fingerprint stored for this id. Null, or a different one: this is not that pair.
    fun bind(id: String, fp: String, knownFp: String?) {
        synchronized(lock) {
            if (id.isEmpty() || fp.isEmpty() || knownFp == null || knownFp != fp) {
                dropOwner()
                return
            }
            val next = Owner(id, fp)
            if (owner == next) return
            items.clear()
            epoch++
            owner = next
        }
    }

    // known is read under the lock. It must only look at the stored pair, not call back in here.
    fun add(
        text: String,
        at: Long,
        queueOn: Boolean,
        outgoing: Boolean,
        maxItems: Int,
        maxBytes: Int,
        maxItemBytes: Int,
        known: (id: String, fp: String) -> Boolean,
    ): Boolean = synchronized(lock) {
        val o = owner ?: return false
        if (!known(o.id, o.fp)) {
            dropOwner()
            return false
        }
        if (!queueOn || !outgoing || text.isEmpty()) return false
        val bytes = text.toByteArray().size
        if (bytes > maxItemBytes) return false
        if (items.lastOrNull()?.text == text) return false
        items.removeAll { it.text == text }
        items.add(Item(text, at))
        while (items.size > maxItems) items.removeAt(0)
        while (items.size > 1 && items.sumOf { it.text.toByteArray().size } > maxBytes) items.removeAt(0)
        true
    }

    fun explicitDisconnect() = synchronized(lock) { dropOwner() }
    fun disableOutgoing() = clearItems()
    fun disableQueue() = clearItems()

    fun forget(id: String) {
        synchronized(lock) { if (owner?.id == id) dropOwner() }
    }

    // consent: that pair's clip.policy accepts the queue. id and fp are the socket's pair, not a
    // guess. A mismatch keeps the copies for the owner; a pair the store no longer has is dropped.
    fun beginFlush(
        id: String,
        fp: String,
        queueOn: Boolean,
        outgoing: Boolean,
        consent: Boolean,
        known: (id: String, fp: String) -> Boolean,
    ): Flush? = synchronized(lock) {
        val o = owner ?: return null
        if (!known(o.id, o.fp)) {
            dropOwner()
            return null
        }
        if (!queueOn || !outgoing) {
            items.clear()
            epoch++
            return null
        }
        if (!consent || o.id != id || o.fp != fp || items.isEmpty()) return null
        Flush(epoch, items.toList())
    }

    // False: Disconnect, Forget or a new owner landed while the send was in flight. The copies
    // already queued for the new owner stay.
    fun commit(flush: Flush): Boolean = synchronized(lock) {
        if (flush.epoch != epoch) return false
        for (item in flush.items) {
            val i = items.indexOfFirst { it.text == item.text && it.at == item.at }
            if (i >= 0) items.removeAt(i)
        }
        true
    }

    private fun clearItems() {
        synchronized(lock) {
            if (items.isEmpty()) return
            items.clear()
            epoch++
        }
    }

    private fun dropOwner() {
        items.clear()
        epoch++
        owner = null
    }
}

// One posted "put the latest" runnable. A newer queue, a closed session, or Disconnect retires it.
internal class LatestGate {
    private val lock = Any()
    private var ticket = 0

    fun issue(): Int = synchronized(lock) { ++ticket }
    fun drop() { synchronized(lock) { ticket++ } }
    fun current(ticket: Int): Boolean = synchronized(lock) { ticket == this.ticket }
}
