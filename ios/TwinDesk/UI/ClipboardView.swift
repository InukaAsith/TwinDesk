// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard: the two directions (shared with the computer, pair.sync), how the computer's copies
// arrive here, the "You copied something" notification, and the recent items.
import SwiftUI

struct ClipboardView: View {
    @EnvironmentObject var core: Core

    var body: some View {
        ScrollView {
                Columns {
                    Button { core.clip.sendCurrent(force: true) } label: {
                        Label(tr("Send Clipboard to {name}", ["name": core.host?.name ?? tr("Computer")]), systemImage: "arrow.up.doc.on.clipboard").frame(maxWidth: .infinity)
                    }
                    .primaryButton().controlSize(.large).disabled(!core.connected)

                    SectionTitle(text: tr("Sync"))
                    VStack(spacing: 12) {
                        ToggleRow(title: tr("Copies on this {device} are available on the computer", ["device": Device.word]), on: sync("clipboard", "out"))
                        Divider()
                        ToggleRow(title: tr("Copies on the computer are available on this {device}", ["device": Device.word]), on: sync("clipboard", "in"))
                        Divider()
                        ToggleRow(title: tr("Pictures"), detail: tr("Includes pictures up to 10 MB"), on: opt("clip.images"))
                    }
                    .glassCard()

                    SectionTitle(text: tr("From the computer"))
                    VStack(spacing: 12) {
                        ToggleRow(title: tr("Copy to the clipboard immediately"), detail: tr("When off, a notification offers Copy"), on: opt("clip.auto"))
                        Divider()
                        ToggleRow(title: tr("Notify"), detail: tr("While TwinDesk is in the background"), on: opt("clip.notify"))
                    }
                    .glassCard()

                    SectionTitle(text: tr("From this {device}", ["device": Device.word]))
                    VStack(alignment: .leading, spacing: 12) {
                        ToggleRow(title: tr("Offer to send copied items"), detail: tr("Shows a notification with Send while TwinDesk is in the background"), on: opt("clip.notifyOwn"))
                        Text(tr("iOS lets only the app on screen read the clipboard, so Send opens TwinDesk for a moment. Set Settings › TwinDesk › Paste from Other Apps to Allow, so iOS doesn’t ask each time. The Send Clipboard shortcut works from Back Tap and the Action button."))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .glassCard()
                } right: {
                    if !core.clip.history.isEmpty {
                        SectionTitle(text: tr("Recent"))
                        VStack(spacing: 0) {
                            ForEach(core.clip.history) { item in
                                Button { core.clip.write(item.text) } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: item.dir == "in" ? "arrow.down.circle.fill" : "arrow.up.circle.fill")
                                            .foregroundStyle(item.dir == "in" ? .green : .blue)
                                        Text(item.text).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                                        Image(systemName: "doc.on.doc").foregroundStyle(.secondary)
                                    }
                                    .padding(.vertical, 8).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).hoverLift()
                            }
                        }
                        .glassCard()
                    }
                }
                .pageWidth()
            }
            .background(Backdrop())
            .navigationTitle(tr("Clipboard"))
    }

    private func sync(_ f: String, _ d: String) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.sync.get(f, d) }, set: { core.sync.set(f, d, $0) })
    }

    private func opt(_ k: String) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.store.flag(k, true) }, set: { core.clip.setOption(k, $0) })
    }
}
