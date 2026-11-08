// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shortcuts actions: Send Clipboard (put it on Back Tap or the Action button: copy, then tap, and it's
// on the computer), Save Copied Files, Connect. They open TwinDesk for a moment where iOS needs the
// app in front to read the clipboard.
import AppIntents
import UIKit

struct SendClipboardIntent: AppIntent {
    static var title: LocalizedStringResource = "Send Clipboard to Computer"
    static var description = IntentDescription("Sends what you copied on this iPhone to the connected computer.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let core = Core.shared
        core.wake()
        for _ in 0..<30 where !core.connected { try? await Task.sleep(nanoseconds: 100_000_000) }
        guard core.connected else { return .result(dialog: "Not connected to a computer.") }
        return .result(dialog: core.clip.sendCurrent(force: true) ? "Sent to \(core.link.host?.name ?? "the computer")." : "Nothing to send.")
    }
}

struct SaveCopiedFilesIntent: AppIntent {
    static var title: LocalizedStringResource = "Save Files Copied on Computer"
    static var description = IntentDescription("Brings the files copied on the computer (⌃⌥C there) to Files › TwinDesk.")
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let core = Core.shared
        guard core.connected, core.fclip.offer != nil else { return .result(dialog: "Nothing copied on the computer.") }
        core.fclip.save()
        return .result(dialog: "Saving to Files › TwinDesk.")
    }
}

struct ConnectIntent: AppIntent {
    static var title: LocalizedStringResource = "Connect to Computer"
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let core = Core.shared
        core.start()
        guard let id = core.store.lastHostId ?? core.store.hosts().first?.id, let h = core.store.host(id) else {
            return .result(dialog: "Pair a computer in TwinDesk first.")
        }
        core.connect(h)
        return .result(dialog: "Connecting to \(h.name)…")
    }
}

struct TwinDeskShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: SendClipboardIntent(), phrases: ["Send clipboard with \(.applicationName)"])
        AppShortcut(intent: SaveCopiedFilesIntent(), phrases: ["Save copied files with \(.applicationName)"])
        AppShortcut(intent: ConnectIntent(), phrases: ["Connect with \(.applicationName)"])
    }
}
