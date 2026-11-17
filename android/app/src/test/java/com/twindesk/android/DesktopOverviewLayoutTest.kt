// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Sheet sizing and the decision to refuse a JPEG before any pixels are allocated.
// BitmapFactory itself stays on a device; these checks are the pure rules.
package com.twindesk.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DesktopOverviewLayoutTest {
    @Test
    fun phonePortraitKeepsTilesCompact() {
        val width = sheetContentWidthDp(360f, false)
        assertEquals(3, deskColumnCount(width, 1f))
        assertEquals(1, displayColumnCount(width, 1f, 2))
        val (tile, height) = tileExtentDp(width, 3)
        assertTrue(tile in 70f..120f)
        assertTrue(height in 40f..84f)
        assertEquals(width, modeSwitchWidthDp(width, 1f), 0.1f)
    }

    @Test
    fun largeTypeUsesFewerColumnsAndTheFullModeSwitch() {
        val width = sheetContentWidthDp(360f, false)
        assertEquals(2, deskColumnCount(width, 1.6f))
        val (_, height) = tileExtentDp(width, 2)
        assertTrue(height <= 84f)
        assertEquals(width, modeSwitchWidthDp(width, 1.6f), 0.1f)
    }

    @Test
    fun landscapeAndFoldableShareTheSheetCap() {
        val phone = sheetContentWidthDp(800f, true)
        val fold = sheetContentWidthDp(840f, true)
        assertEquals(phone, fold, 0.1f)
        assertTrue(phone <= 680f)
        assertEquals(6, deskColumnCount(phone, 1f))
        val (tile, height) = tileExtentDp(phone, 6)
        assertTrue(tile <= 168f)
        assertTrue(height <= 84f)
        assertEquals(2, displayColumnCount(phone, 1f, 3))
        assertEquals(420f, modeSwitchWidthDp(phone, 1f), 0.1f)
        assertEquals(phone, modeSwitchWidthDp(phone, 1.4f), 0.1f)
    }

    @Test
    fun intrinsicSizeAboveTheCapOrMissingIsRefused() {
        assertTrue(previewIntrinsicOk(DesktopPreview.MAX_EDGE, 270))
        assertTrue(previewIntrinsicOk(1, 1))
        assertFalse(previewIntrinsicOk(DesktopPreview.MAX_EDGE + 1, 270))
        assertFalse(previewIntrinsicOk(480, DesktopPreview.MAX_EDGE + 1))
        assertFalse(previewIntrinsicOk(0, 270))
        assertFalse(previewIntrinsicOk(-1, -1))
    }

    @Test
    fun sampleSizeShrinksTowardTheTileWithoutPassingTheCap() {
        assertEquals(4, previewSampleSize(480, 270, 96))
        assertEquals(1, previewSampleSize(480, 270, 400))
        assertEquals(1, previewSampleSize(120, 68, 96))
        assertEquals(8, previewSampleSize(480, 270, 48))
        assertTrue(previewSampleSize(4000, 2000, 64) <= 8)
    }

    @Test
    fun cacheKeyKeepsASessionFromReusingAnother() {
        val first = PreviewCacheKey(1L, "1", "2", 9L, previewTargetBucket(96))
        val next = first.copy(session = 2L)
        assertNotEquals(first, next)
        assertNotEquals(first, first.copy(seq = 10L))
        assertNotEquals(first, first.copy(displayId = "3"))
        assertNotEquals(first, first.copy(spaceId = "4"))
        assertEquals(3, previewTargetBucket(96))
    }
}
