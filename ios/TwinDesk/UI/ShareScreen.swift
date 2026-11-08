// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Share Screen: iOS's own broadcast sheet, with TwinDesk's extension picked (Start Broadcast there
// starts it; the red pill or Control Center's Screen Recording stops it).
import SwiftUI
import ReplayKit
import UIKit

enum ShareScreen {
    static let extensionId = "com.twindesk.ios.broadcast"
    private static var picker: RPSystemBroadcastPickerView?

    // The sheet, as if its own button was tapped (it has no API to open it).
    static func open() {
        let p = picker ?? RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        p.preferredExtension = extensionId
        p.showsMicrophoneButton = false
        picker = p
        // In the window (it opens nothing otherwise), out of sight.
        if p.superview == nil, let w = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first {
            p.alpha = 0.01
            w.addSubview(p)
        }
        for case let b as UIButton in p.subviews { b.sendActions(for: .touchUpInside) }
    }
}

struct ShareScreenCard: View {
    @EnvironmentObject var core: Core

    var body: some View {
        let on = core.mirror.sharing
        HStack(spacing: 14) {
            Image(systemName: on ? "rectangle.on.rectangle.circle.fill" : "rectangle.on.rectangle")
                .font(.title3.weight(.semibold)).glassChip(48, tint: on ? .red : .purple)
            VStack(alignment: .leading, spacing: 2) {
                Text(on ? "Sharing this screen" : "Share Screen").font(.body.weight(.semibold))
                Text(on ? "On \(core.host?.name ?? "the computer") · every app, until you stop" : "Show this \(Device.word) on \(core.host?.name ?? "the computer"), like presenting in a call")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if on {
                Button("Stop") { core.mirror.stop() }.secondaryButton()
            } else {
                Button("Share") { ShareScreen.open() }.primaryButton()
            }
        }
        .glassCard(tint: on ? .red : nil)
    }
}
