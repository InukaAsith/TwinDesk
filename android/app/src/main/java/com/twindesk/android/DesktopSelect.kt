// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which macOS desktop a viewer may ask for, and when a different display has to be
// showing first. A tap never sends a display change and a desktop change together.
// The desktop message waits until a later screen.state says this viewer is capturing
// that display, the catalog revision moved, and a decoded frame belongs to that
// capture session and view generation. A frame already playing does not count.
// A display card asks only for that screen. The same wait ends in a note, including
// when the picture arrives after a timeout, and never becomes a desktop change.
// Stop, revoked input, a new session, a closed viewer, or a picture that landed on
// some other display cancels the wait, so it cannot run after the picture returns.
package com.twindesk.android

object DesktopSelect {
    const val MAX_DISPLAYS = 8
    const val MAX_LISTED = 64
    const val MAX_COUNT = 256
    const val WAIT_MS = 12000L

    private val SPACE_ID = Regex("^[0-9]{1,20}$")
    private val DISPLAY_ID = Regex("^[0-9]{1,16}$")

    data class WireDisplay(
        val id: String,
        val name: String,
        val primary: Boolean,
        val current: Int,
        val count: Int,
        val truncated: Boolean,
        val spaces: List<String>,
    )

    data class Desk(val id: String, val index: Int, val current: Boolean, val selectable: Boolean)
    data class Display(
        val id: String,
        val name: String,
        val primary: Boolean,
        val currentIndex: Int,
        val count: Int,
        val truncated: Boolean,
        val desktops: List<Desk>,
    )
    data class Catalog(val rev: Long, val viewing: String, val viewGen: Long?, val capture: Long?, val displays: List<Display>)
    data class Pending(
        val displayId: String,
        val spaceId: String,
        val name: String,
        val sinceRev: Long,
        val sinceGen: Long?,
        val at: Long,
        val session: Long = 0,
        val fromDisplay: String = "",
        val displayOnly: Boolean = false,
    )
    data class Frame(val capture: Long, val viewGen: Long)

    sealed class Action {
        data class Space(val displayId: String, val spaceId: String, val index: Int, val count: Int, val rev: Long, val name: String) : Action()
        data class DisplayThenWait(val displayId: String, val name: String, val pending: Pending) : Action()
        data class Note(val code: String, val name: String = "") : Action()
        data object None : Action()
    }

    data class Result(val pending: Pending?, val action: Action)

    fun accept(rev: Long, viewing: String, viewGen: Long?, rows: List<WireDisplay>, capture: Long? = null): Catalog? {
        if (rev < 0L || rev > 0xffffffffL) return null
        if (viewGen != null && (viewGen < 0L || viewGen > 0xffffffffL)) return null
        val view = cleanId(viewing)
        val displays = ArrayList<Display>(MAX_DISPLAYS)
        for (row in rows) {
            if (displays.size >= MAX_DISPLAYS) break
            val id = cleanId(row.id) ?: continue
            if (displays.any { it.id == id }) continue
            val count = row.count
            if (count < 1 || count > MAX_COUNT) continue
            val spaces = ArrayList<String>(minOf(row.spaces.size, MAX_LISTED))
            for (space in row.spaces) {
                if (spaces.size >= MAX_LISTED) break
                val sid = cleanSpace(space) ?: continue
                if (!spaces.contains(sid)) spaces.add(sid)
            }
            if (spaces.isEmpty() || spaces.size > count) continue
            val current = if (row.current in 0 until count) row.current else -1
            val selectableCount = count <= MAX_COUNT
            val desktops = spaces.mapIndexed { index, sid ->
                Desk(sid, index, current == index, selectableCount && index < count)
            }
            displays.add(Display(
                id,
                cleanName(row.name),
                row.primary,
                current,
                count,
                row.truncated || spaces.size < count,
                desktops,
            ))
        }
        if (displays.isEmpty()) return null
        val shown = if (view != null && displays.any { it.id == view }) view else ""
        val gen = if (shown.isEmpty()) null else viewGen
        val cap = capture?.takeIf { it in 1L..0xffffffffL }
        return Catalog(rev, shown, gen, if (shown.isEmpty()) null else cap, displays)
    }

    fun tap(catalog: Catalog?, displayId: String, spaceId: String, canSwitchDisplay: Boolean, now: Long, session: Long = 0): Result {
        val cat = catalog ?: return Result(null, Action.Note("unavailable"))
        val display = cat.displays.find { it.id == displayId } ?: return Result(null, Action.Note("display"))
        val desk = display.desktops.find { it.id == spaceId } ?: return Result(null, Action.Note("space"))
        if (!desk.selectable || display.count > MAX_COUNT) return Result(null, Action.Note("space"))
        val name = display.name
        if (display.id == cat.viewing && desk.current) return Result(null, Action.Note("already", name))
        if (display.id == cat.viewing) {
            if (cat.viewGen == null) return Result(null, Action.Note("wait", name))
            return Result(null, Action.Space(display.id, desk.id, desk.index, display.count, cat.rev, name))
        }
        if (!canSwitchDisplay) return Result(null, Action.Note("display", name))
        val pending = Pending(display.id, desk.id, name, cat.rev, cat.viewGen, now, session, cat.viewing)
        return Result(pending, Action.DisplayThenWait(display.id, name, pending))
    }

    // The overview's display card. Already showing it, or a screen this viewer cannot
    // mirror, sends nothing. Otherwise the picture has to catch up before the note
    // may say it is showing. spaceId stays empty, so this wait cannot name a desktop.
    fun switchDisplay(catalog: Catalog?, displayId: String, canSwitchDisplay: Boolean, now: Long, session: Long = 0): Result {
        val cat = catalog ?: return Result(null, Action.Note("unavailable"))
        val display = cat.displays.find { it.id == displayId } ?: return Result(null, Action.Note("display"))
        val name = display.name
        if (display.id == cat.viewing) return Result(null, Action.Note("showing", name))
        if (!canSwitchDisplay) return Result(null, Action.Note("display", name))
        val pending = Pending(display.id, "", name, cat.rev, cat.viewGen, now, session, cat.viewing, displayOnly = true)
        return Result(pending, Action.DisplayThenWait(display.id, name, pending))
    }

    // Why a wait must be dropped before it can send. Null means the wait may continue.
    // "stale" is a picture that moved to a display other than the one the wait started
    // on and the one it asked for, or a view generation that went backwards.
    fun cancelReason(
        pending: Pending,
        sharing: Boolean,
        input: Boolean,
        viewer: Boolean,
        session: Long,
        catalog: Catalog?,
        mirroredId: String,
    ): String? {
        if (!viewer) return "closed"
        if (!sharing) return "stop"
        if (!input) return "revoke"
        if (session != pending.session) return "session"
        if (pending.fromDisplay.isNotEmpty() && catalog != null) {
            val landed = catalog.viewing.ifEmpty { mirroredId }
            if (landed.isNotEmpty() && landed != pending.displayId && landed != pending.fromDisplay) return "stale"
        }
        val gen = catalog?.viewGen
        if (gen != null && pending.sinceGen != null && gen < pending.sinceGen) return "stale"
        return null
    }

    // Pending stays until the mirrored picture and the catalog both name that display,
    // with a new view generation, a new revision, and a decoded frame of that capture
    // session and view generation. A frame from an older capture does not count.
    fun onState(pending: Pending?, catalog: Catalog?, mirroredId: String, now: Long, frame: Frame? = null): Result {
        val wait = pending ?: return Result(null, Action.None)
        if (now - wait.at >= WAIT_MS) return Result(null, Action.Note("timeout", wait.name))
        if (wait.displayOnly) return onDisplay(wait, catalog, mirroredId, frame)
        val cat = catalog ?: return Result(wait, Action.None)
        if (cat.viewing != wait.displayId || mirroredId != wait.displayId) return Result(wait, Action.None)
        val gen = cat.viewGen
        val genFresh = if (wait.sinceGen == null) gen != null else gen != null && gen != wait.sinceGen
        if (!genFresh || cat.rev == wait.sinceRev) return Result(wait, Action.None)
        val display = cat.displays.find { it.id == wait.displayId } ?: return Result(null, Action.Note("gone", wait.name))
        val desk = display.desktops.find { it.id == wait.spaceId }
        if (desk == null || !desk.selectable) return Result(null, Action.Note("gone", display.name.ifEmpty { wait.name }))
        val cap = cat.capture
        val shown = cat.viewGen
        if (cap == null || shown == null || frame == null || frame.capture != cap || frame.viewGen != shown) {
            return Result(wait, Action.None)
        }
        if (desk.current) return Result(null, Action.Note("showing", display.name.ifEmpty { wait.name }))
        return Result(null, Action.Space(display.id, desk.id, desk.index, display.count, cat.rev, display.name.ifEmpty { wait.name }))
    }

    // The display card's wait. The picture has to be this display, with a new generation,
    // a new revision, and a decoded frame of that capture. Success is a note. It is not a desktop.
    private fun onDisplay(wait: Pending, catalog: Catalog?, mirroredId: String, frame: Frame?): Result {
        val cat = catalog ?: return Result(wait, Action.None)
        if (cat.viewing != wait.displayId || mirroredId != wait.displayId) return Result(wait, Action.None)
        val gen = cat.viewGen
        val genFresh = if (wait.sinceGen == null) gen != null else gen != null && gen != wait.sinceGen
        if (!genFresh || cat.rev == wait.sinceRev) return Result(wait, Action.None)
        val display = cat.displays.find { it.id == wait.displayId } ?: return Result(null, Action.Note("display", wait.name))
        val cap = cat.capture
        val shown = cat.viewGen
        if (cap == null || shown == null || frame == null || frame.capture != cap || frame.viewGen != shown) {
            return Result(wait, Action.None)
        }
        return Result(null, Action.Note("showing", display.name.ifEmpty { wait.name }))
    }

    // The wait gave up, and a later state shows the display anyway. Say so, and do not
    // send the desktop change that was no longer being waited for.
    fun afterTimeout(displayId: String, catalog: Catalog?, mirroredId: String): Action {
        if (displayId.isEmpty() || catalog == null) return Action.None
        if (catalog.viewing != displayId || mirroredId != displayId) return Action.None
        val name = catalog.displays.find { it.id == displayId }?.name.orEmpty()
        return Action.Note("late", name)
    }

    private fun cleanId(id: String): String? {
        val v = id.trim()
        return if (DISPLAY_ID.matches(v) && v != "0") v else null
    }

    private fun cleanSpace(id: String): String? {
        val v = id.trim()
        return if (SPACE_ID.matches(v) && v != "0") v else null
    }

    private fun cleanName(name: String): String {
        val cleaned = name.replace(Regex("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        return cleaned.take(60)
    }
}
