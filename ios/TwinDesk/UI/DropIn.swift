// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drag and drop onto TwinDesk (iPad: from Files, Photos, Safari, in Split View or Stage Manager;
// iPhone: a long press dragged in from another app): what's dropped goes to the computer.
import SwiftUI
import UniformTypeIdentifiers

enum DropIn {
    static func take(_ providers: [NSItemProvider], _ core: Core) {
        guard core.connected else { return }
        let group = DispatchGroup()
        var urls: [URL] = []
        let lock = NSLock()
        for p in providers {
            // A file's own bytes (with its name): the most specific type it offers that is data.
            let type = p.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .data) == true } ?? UTType.item.identifier
            group.enter()
            p.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                defer { group.leave() }
                guard let url = url else { return }
                // The URL lives only until this returns: our own copy, under its name.
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let name = p.suggestedName.map { n in url.pathExtension.isEmpty || n.hasSuffix("." + url.pathExtension) ? n : n + "." + url.pathExtension } ?? url.lastPathComponent
                let to = dir.appendingPathComponent(name)
                if (try? FileManager.default.copyItem(at: url, to: to)) != nil { lock.lock(); urls.append(to); lock.unlock() }
            }
        }
        group.notify(queue: .main) {
            for u in urls { core.files.adopt(u) }
            core.files.flushShares()
        }
    }
}

struct DropOverlay: View {
    let name: String?
    let connected: Bool

    var body: some View {
        ZStack {
            Color.black.opacity(0.25).ignoresSafeArea()
            VStack(spacing: 12) {
                Image(systemName: connected ? "arrow.down.doc" : "xmark.circle").font(.system(size: 44, weight: .semibold))
                Text(connected ? tr("Drop to send to {name}", ["name": name ?? tr("the computer")]) : tr("Connect to a computer first")).font(.title3.bold())
            }
            .padding(36)
            .glassCard(32, tint: connected ? .blue : .orange)
        }
        .allowsHitTesting(false)
        .transition(.opacity)
    }
}
