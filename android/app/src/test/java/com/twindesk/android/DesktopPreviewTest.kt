// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which preview the phone may keep. Pixel decode stays in the sheet, so this test never
// calls BitmapFactory.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DesktopPreviewTest {
    @Test
    fun currentSpaceOfAPermittedDisplayIsKept() {
        val board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), catalog())
        assertEquals(1, board.shots.size)
        assertEquals("1", board.shots[0].spaceId)
        assertEquals("", board.unavailable)
        assertEquals(DesktopPreview.Status.CURRENT, DesktopPreview.tile(board, "1", desk("1", 0, true), false))
    }

    @Test
    fun anotherDisplayAndABadJpegAreRefused() {
        val start = DesktopPreview.EMPTY
        assertEquals(start, DesktopPreview.reduce(start, shot("9", "1"), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "99"), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", capture = 8), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", viewGen = 4), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", width = 481), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", jpeg = byteArrayOf(0, 0, 0, 0)), catalog()))
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0, 0)), catalog()))
        val huge = ByteArray(DesktopPreview.MAX_BYTES + 1)
        huge[0] = 0xFF.toByte(); huge[1] = 0xD8.toByte()
        huge[huge.size - 2] = 0xFF.toByte(); huge[huge.size - 1] = 0xD9.toByte()
        assertEquals(start, DesktopPreview.reduce(start, shot("1", "1", jpeg = huge), catalog()))
    }

    @Test
    fun inactiveDesktopIsLastSeenAndAHoldIsNotCurrent() {
        var board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), catalog())
        board = DesktopPreview.reduce(board, shot("1", "2"), catalog())
        assertEquals(DesktopPreview.Status.LAST, DesktopPreview.tile(board, "1", desk("2", 1, false), false))
        assertEquals(DesktopPreview.Status.LAST, DesktopPreview.tile(board, "1", desk("1", 0, true), true))
        assertEquals(DesktopPreview.Status.NONE, DesktopPreview.tile(board, "1", desk("3", 2, false), false))
    }

    @Test
    fun clearDropsShotsAndKeepsTheNotice() {
        val noted = DesktopPreview.reduce(DesktopPreview.EMPTY, DesktopPreview.Incoming(false, "os", "", "", -1, -1, 0, 0, null), null)
        val withShot = noted.copy(shots = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), catalog()).shots)
        val cleared = DesktopPreview.reduce(withShot, DesktopPreview.Incoming(true, "", "", "", -1, -1, 0, 0, null), catalog())
        assertTrue(cleared.shots.isEmpty())
        assertEquals("os", cleared.unavailable)
        val permission = DesktopPreview.reduce(withShot, DesktopPreview.Incoming(false, "permission", "", "", -1, -1, 0, 0, null), catalog())
        assertTrue(permission.shots.isEmpty())
        assertEquals("permission", permission.unavailable)
    }

    @Test
    fun catalogChangeDropsWhatItNoLongerAllows() {
        val board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "2"), catalog())
        assertTrue(DesktopPreview.retain(board, null).shots.isEmpty())
        assertEquals("", DesktopPreview.retain(board, null).unavailable)
        assertEquals(1, DesktopPreview.retain(board, catalog().copy(capture = null)).shots.size)
        assertTrue(DesktopPreview.retain(board, catalog().copy(capture = null)).shots[0].stale)
        assertTrue(DesktopPreview.retain(board, catalog().copy(capture = 8)).shots[0].stale)
        assertTrue(DesktopPreview.retain(board, catalog().copy(viewGen = 9)).shots[0].stale)
        val gone = catalog().copy(displays = listOf(catalog().displays[0].copy(desktops = listOf(desk("1", 0, true)))))
        assertTrue(DesktopPreview.retain(board, gone).shots.isEmpty())
        val same = DesktopPreview.retain(board, catalog())
        assertEquals(1, same.shots.size)
        // Space 2 is not the current desktop. The picture stays, and it is last-seen.
        assertTrue(same.shots[0].stale)
        val current = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), catalog())
        val still = DesktopPreview.retain(current, catalog())
        assertFalse(still.shots[0].stale)
    }

    @Test
    fun spaceThatStopsBeingCurrentStaysLastSeenUntilRefreshed() {
        val showing = catalog()
        val board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), showing)
        assertEquals(DesktopPreview.Status.CURRENT, DesktopPreview.tile(board, "1", desk("1", 0, true), false))

        val left = withCurrent(showing, "2")
        val kept = DesktopPreview.retain(board, left)
        assertEquals(1, kept.shots.size)
        assertEquals(7L, kept.shots[0].capture)
        assertEquals(3L, kept.shots[0].viewGen)
        assertTrue(kept.shots[0].stale)
        assertEquals(DesktopPreview.Status.LAST, DesktopPreview.tile(kept, "1", desk("1", 0, false), false))

        val back = DesktopPreview.retain(kept, showing)
        assertEquals(1, back.shots.size)
        assertTrue(back.shots[0].stale)
        assertEquals(DesktopPreview.Status.LAST, DesktopPreview.tile(back, "1", desk("1", 0, true), false))

        val refreshed = DesktopPreview.reduce(back, shot("1", "1"), showing)
        assertFalse(refreshed.shots.single { it.spaceId == "1" }.stale)
        assertEquals(DesktopPreview.Status.CURRENT, DesktopPreview.tile(refreshed, "1", desk("1", 0, true), false))
    }

    @Test
    fun switchingDisplaysKeepsTheLastSeenShotStale() {
        val first = catalog()
        val board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), first)
        val second = first.copy(capture = 8, viewGen = 9)
        val kept = DesktopPreview.retain(board, second)
        assertEquals(1, kept.shots.size)
        assertEquals("1", kept.shots[0].spaceId)
        assertTrue(kept.shots[0].stale)
        assertEquals(DesktopPreview.Status.LAST, DesktopPreview.tile(kept, "1", desk("1", 0, true), false))
        val staleGen = DesktopPreview.reduce(kept, shot("1", "2", capture = 7, viewGen = 3), second)
        assertEquals(1, staleGen.shots.size)
        val fresh = DesktopPreview.reduce(kept, shot("1", "2", capture = 8, viewGen = 9), second)
        assertEquals(2, fresh.shots.size)
        assertFalse(fresh.shots.first { it.spaceId == "2" }.stale)
        assertEquals(DesktopPreview.Status.CURRENT, DesktopPreview.tile(fresh, "1", desk("2", 1, true), false))
    }

    @Test
    fun anotherSessionDropsTheShots() {
        val board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), catalog())
        val reduced = DesktopPreview.reduce(board, shot("1", "2"), catalog(), session = 4)
        assertTrue(reduced.shots.isEmpty())
        assertEquals(4, reduced.session)
        val retained = DesktopPreview.retain(board, catalog(), session = 4)
        assertTrue(retained.shots.isEmpty())
        assertEquals(4, retained.session)
        assertEquals("", retained.unavailable)
    }

    @Test
    fun oldReplyAfterCloseAndReopenIsRefused() {
        val cat = catalog()
        val ask = DesktopPreview.SheetAsk()
        var board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), cat)
        val oldJpeg = shot("1", "2")
        // Capture and view generation still match, so the epoch is the only fence.
        assertEquals(2, DesktopPreview.reduce(board, oldJpeg, cat).shots.size)

        val opened = ask.open()
        fun apply(replyEpoch: Long, msg: DesktopPreview.Incoming) {
            if (!ask.accepts(replyEpoch, msg.clear, msg.unavailable)) return
            board = DesktopPreview.reduce(board, msg, cat)
        }

        apply(opened, shot("1", "1"))
        assertEquals(1, board.shots.size)

        ask.close()
        apply(opened, oldJpeg)
        assertEquals(1, board.shots.size)
        val clear = DesktopPreview.Incoming(true, "", "", "", -1, -1, 0, 0, null)
        apply(opened, clear)
        assertTrue(board.shots.isEmpty())

        board = DesktopPreview.reduce(DesktopPreview.EMPTY, shot("1", "1"), cat)
        val reopened = ask.open()
        assertTrue(reopened != opened)
        apply(opened, oldJpeg)
        apply(opened, clear)
        apply(opened, DesktopPreview.Incoming(false, "os", "", "", -1, -1, 0, 0, null))
        apply(opened, DesktopPreview.Incoming(false, "permission", "", "", -1, -1, 0, 0, null))
        assertEquals(1, board.shots.size)
        assertEquals("1", board.shots[0].spaceId)
        assertEquals(7L, board.shots[0].capture)
        assertEquals(3L, board.shots[0].viewGen)
        assertEquals("", board.unavailable)

        apply(reopened, oldJpeg)
        assertEquals(2, board.shots.size)

        ask.end()
        apply(reopened, oldJpeg)
        apply(reopened, clear)
        apply(reopened, DesktopPreview.Incoming(false, "permission", "", "", -1, -1, 0, 0, null))
        assertEquals(2, board.shots.size)
        assertEquals("", board.unavailable)

        val next = ask.open()
        apply(reopened, oldJpeg)
        apply(reopened, clear)
        assertEquals(2, board.shots.size)
        apply(next, shot("1", "3"))
        assertTrue(board.shots.any { it.spaceId == "3" })
        assertEquals(7L, board.shots.first { it.spaceId == "3" }.capture)
        assertEquals(3L, board.shots.first { it.spaceId == "3" }.viewGen)
    }

    @Test
    fun oldestShotLeavesWhenTheSessionIsFull() {
        var board = DesktopPreview.EMPTY
        val cat = catalog()
        for (id in 1..13) board = DesktopPreview.reduce(board, shot("1", id.toString()), cat)
        assertEquals(DesktopPreview.MAX_SHOTS, board.shots.size)
        assertFalse(board.shots.any { it.spaceId == "1" })
        assertTrue(board.shots.any { it.spaceId == "13" })
    }

    private fun jpeg(): ByteArray = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x11, 0x22, 0xFF.toByte(), 0xD9.toByte())

    private fun shot(
        displayId: String,
        spaceId: String,
        capture: Long = 7,
        viewGen: Long = 3,
        width: Int = 480,
        height: Int = 270,
        jpeg: ByteArray = jpeg(),
    ) = DesktopPreview.Incoming(false, "", displayId, spaceId, capture, viewGen, width, height, jpeg)

    private fun desk(id: String, index: Int, current: Boolean) = DesktopSelect.Desk(id, index, current, true)

    private fun catalog(): DesktopSelect.Catalog {
        val spaces = (1..16).map { n -> desk(n.toString(), n - 1, n == 1) }
        val display = DesktopSelect.Display("1", "Built-in", true, 0, spaces.size, false, spaces)
        return DesktopSelect.Catalog(1, "1", 3, 7, listOf(display))
    }

    private fun withCurrent(cat: DesktopSelect.Catalog, spaceId: String): DesktopSelect.Catalog {
        val display = cat.displays[0]
        val desktops = display.desktops.map { it.copy(current = it.id == spaceId) }
        val index = desktops.indexOfFirst { it.current }.coerceAtLeast(0)
        return cat.copy(displays = listOf(display.copy(currentIndex = index, desktops = desktops)))
    }
}
