// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which desktop a tap may ask for, and when a different display has to be showing first.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DesktopSelectTest {
    @Test
    fun sameDisplaySendsOneDesktopAndDoesNotSendTheCurrentOne() {
        val catalog = catalog(viewGen = 4)
        val current = DesktopSelect.tap(catalog, "1", "10", true, 0)
        assertEquals("already", (current.action as DesktopSelect.Action.Note).code)
        assertNull(current.pending)

        val next = DesktopSelect.tap(catalog, "1", "11", true, 0)
        val space = next.action as DesktopSelect.Action.Space
        assertNull(next.pending)
        assertEquals("1", space.displayId)
        assertEquals("11", space.spaceId)
        assertEquals(1, space.index)
        assertEquals(3, space.count)
        assertEquals(10L, space.rev)
    }

    @Test
    fun sameDisplayWaitsUntilThisPictureHasAGeneration() {
        val catalog = catalog(viewGen = null)
        val step = DesktopSelect.tap(catalog, "1", "11", true, 0)
        assertEquals("wait", (step.action as DesktopSelect.Action.Note).code)
        assertNull(step.pending)
    }

    @Test
    fun otherDisplayWaitsForThisViewerBeforeAnyDesktopMessage() {
        val start = catalog(viewGen = 3)
        val asked = DesktopSelect.tap(start, "2", "21", true, 1_000)
        val wait = asked.action as DesktopSelect.Action.DisplayThenWait
        assertEquals("2", wait.displayId)
        assertEquals("2", asked.pending?.displayId)
        assertEquals("21", asked.pending?.spaceId)
        assertEquals(10L, asked.pending?.sinceRev)
        assertEquals(3L, asked.pending?.sinceGen)
        assertEquals(1_000L, asked.pending?.at)

        val stillHere = DesktopSelect.onState(asked.pending, start, "1", 1_000)
        assertTrue(stillHere.action is DesktopSelect.Action.None)
        assertEquals(asked.pending, stillHere.pending)

        val pictureOnly = DesktopSelect.onState(asked.pending, start, "2", 2_000)
        assertTrue(pictureOnly.action is DesktopSelect.Action.None)

        val sameGeneration = DesktopSelect.onState(asked.pending, catalog(viewing = "2", viewGen = 3, rev = 11), "2", 3_000)
        assertTrue(sameGeneration.action is DesktopSelect.Action.None)

        val sameRevision = DesktopSelect.onState(asked.pending, catalog(viewing = "2", viewGen = 4, rev = 10), "2", 4_000)
        assertTrue(sameRevision.action is DesktopSelect.Action.None)

        val fresh = catalog(
            viewing = "2",
            viewGen = 4,
            rev = 11,
            capture = 9,
            rows = listOf(screen("1", "Built-in", 0, listOf("10", "11", "12")), screen("2", "Studio", 0, listOf("20", "22", "21"))),
        )
        val noFrame = DesktopSelect.onState(asked.pending, fresh, "2", 5_000, null)
        assertTrue(noFrame.action is DesktopSelect.Action.None)
        assertEquals(asked.pending, noFrame.pending)

        val staleFrame = DesktopSelect.onState(asked.pending, fresh, "2", 5_000, DesktopSelect.Frame(8, 4))
        assertTrue(staleFrame.action is DesktopSelect.Action.None)
        assertEquals(asked.pending, staleFrame.pending)

        val otherGeneration = DesktopSelect.onState(asked.pending, fresh, "2", 5_000, DesktopSelect.Frame(9, 3))
        assertTrue(otherGeneration.action is DesktopSelect.Action.None)
        assertEquals(asked.pending, otherGeneration.pending)

        val noCapture = catalog(
            viewing = "2",
            viewGen = 4,
            rev = 11,
            rows = listOf(screen("1", "Built-in", 0, listOf("10", "11", "12")), screen("2", "Studio", 0, listOf("20", "22", "21"))),
        )
        val missingCapture = DesktopSelect.onState(asked.pending, noCapture, "2", 5_000, DesktopSelect.Frame(9, 4))
        assertTrue(missingCapture.action is DesktopSelect.Action.None)
        assertEquals(asked.pending, missingCapture.pending)

        val ready = DesktopSelect.onState(asked.pending, fresh, "2", 5_000, DesktopSelect.Frame(9, 4))
        val space = ready.action as DesktopSelect.Action.Space
        assertNull(ready.pending)
        assertEquals("2", space.displayId)
        assertEquals("21", space.spaceId)
        assertEquals(2, space.index)
        assertEquals(3, space.count)
        assertEquals(11L, space.rev)

        val timed = DesktopSelect.onState(
            asked.pending,
            fresh,
            "2",
            1_000 + DesktopSelect.WAIT_MS,
            DesktopSelect.Frame(9, 4),
        )
        assertEquals("timeout", (timed.action as DesktopSelect.Action.Note).code)
        assertNull(timed.pending)
    }

    @Test
    fun stopRevokeSessionAndCloseLeaveNothingThatCanSendWhenThePictureReturns() {
        val start = catalog(viewGen = 3)
        val asked = DesktopSelect.tap(start, "2", "21", true, 1_000, session = 4)
        val pending = asked.pending!!
        assertEquals("1", pending.fromDisplay)
        assertEquals(4L, pending.session)
        val fresh = catalog(
            viewing = "2",
            viewGen = 5,
            rev = 11,
            capture = 9,
            rows = listOf(screen("1", "Built-in", 0, listOf("10", "11", "12")), screen("2", "Studio", 0, listOf("20", "22", "21"))),
        )
        val frame = DesktopSelect.Frame(9, 5)
        // The kept wait would send. Stop, revoke, a new session, and a closed viewer must drop it first.
        assertTrue(DesktopSelect.onState(pending, fresh, "2", 2_000, frame).action is DesktopSelect.Action.Space)
        assertEquals("stop", DesktopSelect.cancelReason(pending, false, true, true, 4, fresh, "2"))
        assertEquals("revoke", DesktopSelect.cancelReason(pending, true, false, true, 4, fresh, "2"))
        assertEquals("session", DesktopSelect.cancelReason(pending, true, true, true, 5, fresh, "2"))
        assertEquals("closed", DesktopSelect.cancelReason(pending, true, true, false, 4, fresh, "2"))
        val restarted = DesktopSelect.onState(null, fresh, "2", 3_000, frame)
        assertTrue(restarted.action is DesktopSelect.Action.None)
        assertNull(restarted.pending)
    }

    @Test
    fun anotherDisplayOrAnOlderGenerationIsStaleAndTheOriginIsNot() {
        val start = catalog(viewGen = 3)
        val pending = DesktopSelect.tap(start, "2", "21", true, 1_000, session = 4).pending!!
        val origin = catalog(viewing = "1", viewGen = 4, rev = 11)
        assertNull(DesktopSelect.cancelReason(pending, true, true, true, 4, origin, "1"))
        val unseen = catalog(viewing = "")
        assertNull(DesktopSelect.cancelReason(pending, true, true, true, 4, unseen, "1"))
        assertNull(DesktopSelect.cancelReason(pending, true, true, true, 4, unseen, "2"))
        val third = catalog(
            viewing = "3",
            viewGen = 6,
            rev = 12,
            rows = listOf(
                screen("1", "Built-in", 0, listOf("10", "11", "12")),
                screen("2", "Studio", 0, listOf("20", "21")),
                screen("3", "Side", 0, listOf("30")),
            ),
        )
        assertEquals("stale", DesktopSelect.cancelReason(pending, true, true, true, 4, third, "3"))
        val backwards = catalog(viewing = "1", viewGen = 2, rev = 12)
        assertEquals("stale", DesktopSelect.cancelReason(pending, true, true, true, 4, backwards, "1"))
        val older = DesktopSelect.Pending("2", "21", "Studio", 10, 3, 1_000)
        assertEquals("", older.fromDisplay)
        assertNull(DesktopSelect.cancelReason(older, true, true, true, 0, third, "3"))
        assertEquals("stale", DesktopSelect.cancelReason(older, true, true, true, 0, backwards, "1"))
    }

    @Test
    fun aDesktopThatLeftOrIsAlreadyShowingIsNotSent() {
        val pending = DesktopSelect.Pending("2", "21", "Studio", 10, 3, 1_000)
        val gone = catalog(viewing = "2", viewGen = 4, rev = 11, rows = listOf(screen("2", "Studio", 0, listOf("20"))))
        val missing = DesktopSelect.onState(pending, gone, "2", 2_000)
        assertEquals("gone", (missing.action as DesktopSelect.Action.Note).code)
        assertNull(missing.pending)

        val showing = catalog(viewing = "2", viewGen = 4, rev = 11, capture = 9, rows = listOf(screen("2", "Studio", 1, listOf("20", "21"))))
        val notYet = DesktopSelect.onState(pending, showing, "2", 2_000)
        assertTrue(notYet.action is DesktopSelect.Action.None)
        assertEquals(pending, notYet.pending)
        val there = DesktopSelect.onState(pending, showing, "2", 2_000, DesktopSelect.Frame(9, 4))
        assertEquals("showing", (there.action as DesktopSelect.Action.Note).code)
        assertNull(there.pending)
    }

    @Test
    fun timeoutDoesNotBecomeADesktopMessageLater() {
        val pending = DesktopSelect.Pending("2", "21", "Studio", 10, 3, 1_000)
        val waiting = DesktopSelect.onState(pending, catalog(), "1", 1_000 + DesktopSelect.WAIT_MS - 1)
        assertTrue(waiting.action is DesktopSelect.Action.None)
        assertEquals(pending, waiting.pending)

        val timed = DesktopSelect.onState(pending, catalog(viewing = "2", viewGen = 9, rev = 40), "2", 1_000 + DesktopSelect.WAIT_MS)
        assertEquals("timeout", (timed.action as DesktopSelect.Action.Note).code)
        assertNull(timed.pending)

        val arrived = catalog(viewing = "2", viewGen = 9, rev = 40)
        assertTrue(DesktopSelect.afterTimeout("", arrived, "2") is DesktopSelect.Action.None)
        assertTrue(DesktopSelect.afterTimeout("2", catalog(), "2") is DesktopSelect.Action.None)
        val late = DesktopSelect.afterTimeout("2", arrived, "2") as DesktopSelect.Action.Note
        assertEquals("late", late.code)
        assertEquals("Studio", late.name)
    }

    @Test
    fun displayCardWaitsForThePictureAndDoesNotChangeTheDesktop() {
        val start = catalog(viewGen = 3)
        val here = DesktopSelect.switchDisplay(start, "1", true, 1_000, session = 4)
        assertEquals("showing", (here.action as DesktopSelect.Action.Note).code)
        assertNull(here.pending)

        val refused = DesktopSelect.switchDisplay(start, "2", false, 1_000, session = 4)
        assertEquals("display", (refused.action as DesktopSelect.Action.Note).code)
        assertNull(refused.pending)

        val missing = DesktopSelect.switchDisplay(start, "9", true, 1_000, session = 4)
        assertEquals("display", (missing.action as DesktopSelect.Action.Note).code)
        assertNull(missing.pending)

        val asked = DesktopSelect.switchDisplay(start, "2", true, 1_000, session = 4)
        val wait = asked.action as DesktopSelect.Action.DisplayThenWait
        assertEquals("2", wait.displayId)
        val pending = asked.pending!!
        assertTrue(pending.displayOnly)
        assertEquals("", pending.spaceId)
        assertEquals("2", pending.displayId)
        assertEquals("1", pending.fromDisplay)
        assertEquals(4L, pending.session)

        val stillHere = DesktopSelect.onState(pending, start, "1", 2_000)
        assertTrue(stillHere.action is DesktopSelect.Action.None)
        assertEquals(pending, stillHere.pending)

        val fresh = catalog(
            viewing = "2",
            viewGen = 4,
            rev = 11,
            capture = 9,
            rows = listOf(screen("1", "Built-in", 0, listOf("10", "11", "12")), screen("2", "Studio", 0, listOf("20", "21"))),
        )
        val noFrame = DesktopSelect.onState(pending, fresh, "2", 3_000, null)
        assertTrue(noFrame.action is DesktopSelect.Action.None)
        val staleFrame = DesktopSelect.onState(pending, fresh, "2", 3_000, DesktopSelect.Frame(8, 4))
        assertTrue(staleFrame.action is DesktopSelect.Action.None)
        val sameGeneration = DesktopSelect.onState(pending, catalog(viewing = "2", viewGen = 3, rev = 11, capture = 9), "2", 3_000, DesktopSelect.Frame(9, 3))
        assertTrue(sameGeneration.action is DesktopSelect.Action.None)

        val ready = DesktopSelect.onState(pending, fresh, "2", 4_000, DesktopSelect.Frame(9, 4))
        val shown = ready.action as DesktopSelect.Action.Note
        assertEquals("showing", shown.code)
        assertEquals("Studio", shown.name)
        assertNull(ready.pending)

        val timed = DesktopSelect.onState(pending, fresh, "2", 1_000 + DesktopSelect.WAIT_MS, DesktopSelect.Frame(9, 4))
        assertEquals("timeout", (timed.action as DesktopSelect.Action.Note).code)
        assertNull(timed.pending)
        val late = DesktopSelect.afterTimeout("2", fresh, "2")
        assertEquals("late", (late as DesktopSelect.Action.Note).code)

        assertEquals("stop", DesktopSelect.cancelReason(pending, false, true, true, 4, fresh, "2"))
        assertEquals("revoke", DesktopSelect.cancelReason(pending, true, false, true, 4, fresh, "2"))
        assertEquals("session", DesktopSelect.cancelReason(pending, true, true, true, 5, fresh, "2"))
        assertEquals("closed", DesktopSelect.cancelReason(pending, true, true, false, 4, fresh, "2"))
        val third = catalog(
            viewing = "3",
            viewGen = 6,
            rev = 12,
            rows = listOf(
                screen("1", "Built-in", 0, listOf("10", "11", "12")),
                screen("2", "Studio", 0, listOf("20", "21")),
                screen("3", "Side", 0, listOf("30")),
            ),
        )
        assertEquals("stale", DesktopSelect.cancelReason(pending, true, true, true, 4, third, "3"))
        assertNull(DesktopSelect.cancelReason(pending, true, true, true, 4, catalog(viewing = "1", viewGen = 4, rev = 11), "1"))
    }

    @Test
    fun anotherDisplayIsNotRequestedWhenThisViewerCannotSwitchIt() {
        val step = DesktopSelect.tap(catalog(), "2", "21", false, 0)
        assertEquals("display", (step.action as DesktopSelect.Action.Note).code)
        assertNull(step.pending)
    }

    @Test
    fun acceptDropsHostileRowsAndKeepsAShortenedList() {
        assertNull(DesktopSelect.accept(-1, "1", 1, listOf(screen("1", "Built-in", 0, listOf("10")))))
        assertNull(DesktopSelect.accept(0x1_0000_0000L, "1", 1, listOf(screen("1", "Built-in", 0, listOf("10")))))
        assertNull(DesktopSelect.accept(1, "1", -1, listOf(screen("1", "Built-in", 0, listOf("10")))))
        assertNull(DesktopSelect.accept(1, "1", 1, listOf(screen("0", "Zero", 0, listOf("10")))))
        assertNull(DesktopSelect.accept(1, "1", 1, listOf(screen("1", "Built-in", 0, listOf("10", "11"), count = 1))))
        assertNull(DesktopSelect.accept(1, "nope", 1, emptyList()))

        val messy = DesktopSelect.accept(
            7,
            "1",
            2,
            listOf(
                screen("1", "A\u0000\u202eBuilt-in name that is far longer than sixty characters and must be cut", 0, listOf("10", "0", "10", "11")),
                screen("1", "Duplicate", 0, listOf("12")),
                screen("abc", "Bad", 0, listOf("13")),
                screen("2", "Studio", 0, listOf("20", "21"), count = 5),
            ) + (3..20).map { screen(it.toString(), "Extra $it", 0, listOf("${it}0")) },
        )!!
        assertEquals("1", messy.viewing)
        assertEquals(2L, messy.viewGen)
        assertEquals(8, messy.displays.size)
        assertEquals(60, messy.displays[0].name.length)
        assertTrue(messy.displays[0].name.startsWith("A Built-in"))
        assertFalse(messy.displays[0].name.contains('\u0000'))
        assertFalse(messy.displays[0].name.contains('\u202e'))
        assertEquals(listOf("10", "11"), messy.displays[0].desktops.map { it.id })
        assertTrue(messy.displays[1].truncated)
        assertEquals(5, messy.displays[1].count)
        assertTrue(messy.displays[1].desktops.all { it.selectable })
        assertFalse(messy.displays.any { it.id == "9" })

        val listed = (1..70).map { it.toString() }
        val long = DesktopSelect.accept(1, "1", 1, listOf(screen("1", "Built-in", 0, listed, count = 70)))!!
        assertEquals(64, long.displays[0].desktops.size)
        assertEquals(70, long.displays[0].count)
        assertTrue(long.displays[0].truncated)
        assertTrue(long.displays[0].desktops.all { it.selectable })

        val unseen = DesktopSelect.accept(1, "9", 4, listOf(screen("1", "Built-in", 0, listOf("10"))))!!
        assertEquals("", unseen.viewing)
        assertNull(unseen.viewGen)
    }

    private fun catalog(
        viewing: String = "1",
        viewGen: Long? = 4,
        rev: Long = 10,
        capture: Long? = null,
        rows: List<DesktopSelect.WireDisplay> = listOf(
            screen("1", "Built-in", 0, listOf("10", "11", "12")),
            screen("2", "Studio", 0, listOf("20", "21")),
        ),
    ): DesktopSelect.Catalog = DesktopSelect.accept(rev, viewing, viewGen, rows, capture)!!

    private fun screen(
        id: String,
        name: String,
        current: Int,
        spaces: List<String>,
        count: Int = spaces.size,
    ) = DesktopSelect.WireDisplay(id, name, id == "1", current, count, spaces.size < count, spaces)
}
