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
        Core.shared.mirror.willStart() // the sheet takes the app out of focus: stay on Wi-Fi meanwhile
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
        // Side by side when there's room, the button under the words when there isn't (never a
        // word broken a letter a line).
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) { icon(on); words(on).layoutPriority(1); Spacer(minLength: 8); button(on).fixedSize() }
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 14) { icon(on); words(on) }
                button(on)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(tint: on ? .red : nil)
    }

    private func icon(_ on: Bool) -> some View {
        Image(systemName: on ? "rectangle.on.rectangle.circle.fill" : "rectangle.on.rectangle")
            .font(.title3.weight(.semibold)).glassChip(48, tint: on ? .red : .purple)
    }

    private func words(_ on: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(on ? tr("Sharing this screen") : tr("Share Screen")).font(.body.weight(.semibold))
            Text(on ? tr("On {name} · Entire screen until you stop", ["name": core.host?.name ?? tr("the computer")]) : tr("Show this {device}’s screen on {name}, as in a video call", ["device": Device.word, "name": core.host?.name ?? tr("the computer")]))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func button(_ on: Bool) -> some View {
        if on { Button(tr("Stop")) { core.mirror.stop() }.secondaryButton() }
        else { Button(tr("Share")) { ShareScreen.open() }.primaryButton() }
    }
}
