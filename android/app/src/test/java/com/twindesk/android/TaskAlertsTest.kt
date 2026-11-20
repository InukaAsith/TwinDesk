// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskAlertsTest {
    @Test
    fun currentSocketGetsOneCompletionAndDuplicateDoesNotAlertAgain() {
        val socket = Any()
        val gate = TaskAlertGate()
        gate.select(socket)
        val complete = TaskAlertGate.parse("a".repeat(32), "Build", true)!!
        assertTrue(gate.take(complete, socket, 10000))
        assertFalse(gate.take(complete, socket, 12000))
        val failed = TaskAlertGate.parse("b".repeat(32), "Terminal task", false)!!
        assertTrue(gate.take(failed, socket, 12000))
    }

    @Test
    fun malformedLabelsRetiredSocketAndRapidAlertsAreDropped() {
        assertNull(TaskAlertGate.parse("invalid", "Build", true))
        assertNull(TaskAlertGate.parse("a".repeat(32), "Build", "true"))
        for (title in listOf("", " ", "a".repeat(81), "name\nsecret", "name\u202esecret", "name\u2028secret", "name\u2029secret"))
            assertNull(TaskAlertGate.parse("a".repeat(32), title, true))
        assertNotNull(TaskAlertGate.parse("a".repeat(32), "a".repeat(80), true))
        val old = Any()
        val current = Any()
        val gate = TaskAlertGate()
        gate.select(old)
        val alert = TaskCompletion("a".repeat(32), "Build", true)
        assertTrue(gate.take(alert, old, 10000))
        gate.select(current)
        assertFalse(gate.take(alert, old, 12000))
        assertTrue(gate.take(alert, current, 12000))
        for (i in 1..7) assertTrue(gate.take(alert.copy(id = i.toString(16).padStart(32, '0')), current, 12100))
        val overflow = alert.copy(id = "b".repeat(32))
        assertFalse(gate.take(overflow, current, 12100))
        assertFalse(gate.take(overflow, current, 80000))
        assertTrue(gate.take(alert.copy(id = "d".repeat(32)), current, 80000))
        gate.select(null)
        assertFalse(gate.take(alert.copy(id = "c".repeat(32)), current, 16000))
    }
}
