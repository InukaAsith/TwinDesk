// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember

@Composable
internal fun Viewer(core: Core, host: WebHost, rail: MirrorRail, started: Boolean, close: () -> Unit) {
    ViewerFrame(core, host, close) {
        val bar = remember { mutableStateOf(true) }
        val keyboard = viewerKeyboardVisible()
        val toggleKeyboard: () -> Unit = { core.screen.keyboard(!keyboard) }
        val end: () -> Unit = { core.screen.end(); close() }
        ViewerChrome(core, host, rail, started, bar, keyboard,
            toggleKeyboard = toggleKeyboard,
            stop = { core.screen.control(share = false) },
            close = end,
            moreEntries = { viewerMoreEntries(core, rail) },
            rowEntries = viewerRowEntries(keyboard, toggleKeyboard, end),
        )
    }
}
