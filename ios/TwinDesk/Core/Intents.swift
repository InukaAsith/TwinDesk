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
        guard core.connected else { return .result(dialog: "\(tr("Not connected to a computer."))") }
        return .result(dialog: "\(core.clip.sendCurrent(force: true) ? tr("Sent to {name}.", ["name": core.link.host?.name ?? tr("the computer")]) : tr("Nothing to send."))")
    }
}

struct SaveCopiedFilesIntent: AppIntent {
    static var title: LocalizedStringResource = "Save Files Copied on Computer"
    static var description = IntentDescription("Brings the files copied on the computer (⌃⌥C there) to Files › TwinDesk.")
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let core = Core.shared
        guard core.connected, core.fclip.offer != nil else { return .result(dialog: "\(tr("Nothing copied on the computer."))") }
        core.fclip.save()
        return .result(dialog: "\(tr("Saving to Files › TwinDesk."))")
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
            return .result(dialog: "\(tr("Pair a computer in TwinDesk first."))")
        }
        core.connect(h)
        return .result(dialog: "\(tr("Connecting to {name}…", ["name": h.name]))")
    }
}

// Waits up to 3 s for the session (TwinDesk woke for this).
@MainActor
private func ready() async -> Bool {
    let core = Core.shared
    core.wake()
    for _ in 0..<30 where !core.connected { try? await Task.sleep(nanoseconds: 100_000_000) }
    return core.connected
}

struct SendFilesIntent: AppIntent {
    static var title: LocalizedStringResource = "Send Files to Computer"
    static var description = IntentDescription("Sends files or photos to the connected computer (its Downloads).")
    static var openAppWhenRun = false

    @Parameter(title: "Files", supportedTypeIdentifiers: ["public.item"])
    var files: [IntentFile]

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard await ready() else { return .result(dialog: "\(tr("Not connected to a computer."))") }
        let core = Core.shared
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("shortcut-" + UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var urls: [URL] = []
        for (i, f) in files.enumerated() {
            let name = f.filename.isEmpty ? "File \(i + 1)" : f.filename
            let to = dir.appendingPathComponent(name)
            if let u = f.fileURL, (try? FileManager.default.copyItem(at: u, to: to)) != nil { urls.append(to) }
            else if (try? f.data.write(to: to)) != nil { urls.append(to) }
        }
        guard !urls.isEmpty, core.files.send(urls) else { return .result(dialog: "\(tr("Nothing to send."))") }
        return .result(dialog: "\(tr("Sending {items} to {name}.", ["items": urls.count == 1 ? urls[0].lastPathComponent : trCount(urls.count, "file"), "name": core.link.host?.name ?? tr("the computer")]))")
    }
}

struct ShowScreenIntent: AppIntent {
    static var title: LocalizedStringResource = "Show Computer’s Screen"
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        if await ready() { AppUI.shared.cover = .viewer }
        return .result()
    }
}

struct PlayPauseIntent: AppIntent {
    static var title: LocalizedStringResource = "Play or Pause on Computer"
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard await ready() else { return .result(dialog: "\(tr("Not connected to a computer."))") }
        Core.shared.media.ctl("toggle")
        return .result(dialog: "\(tr("Done."))")
    }
}

struct LockComputerIntent: AppIntent {
    static var title: LocalizedStringResource = "Lock Computer"
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard await ready() else { return .result(dialog: "\(tr("Not connected to a computer."))") }
        Core.shared.dev.act("lock")
        return .result(dialog: "\(tr("Locking {name}.", ["name": Core.shared.link.host?.name ?? tr("the computer")]))")
    }
}

struct TwinDeskShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: SendClipboardIntent(), phrases: ["Send clipboard with \(.applicationName)"])
        AppShortcut(intent: SaveCopiedFilesIntent(), phrases: ["Save copied files with \(.applicationName)"])
        AppShortcut(intent: ConnectIntent(), phrases: ["Connect with \(.applicationName)"])
        AppShortcut(intent: ShowScreenIntent(), phrases: ["Show computer screen with \(.applicationName)"])
        AppShortcut(intent: PlayPauseIntent(), phrases: ["Play or pause with \(.applicationName)"])
        AppShortcut(intent: LockComputerIntent(), phrases: ["Lock computer with \(.applicationName)"])
    }
}
