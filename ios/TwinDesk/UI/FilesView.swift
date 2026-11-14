// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files: send from Files or Photos, what's going and what came, and the Received folder in the
// Files app (On My \(Device.word) › TwinDesk › Received).
import SwiftUI
import PhotosUI
import UIKit
import UniformTypeIdentifiers

struct FilesView: View {
    @EnvironmentObject var core: Core
    @State private var picking = false
    @State private var photos: [PhotosPickerItem] = []

    var body: some View {
        ScrollView {
                GlassGroup {
                    Columns {
                        HStack(spacing: 12) {
                            Button { picking = true } label: { Label(tr("Files"), systemImage: "folder.badge.plus").frame(maxWidth: .infinity) }
                                .primaryButton().controlSize(.large).keyboardShortcut("o", modifiers: .command)
                            PhotosPicker(selection: $photos, maxSelectionCount: 50, matching: .any(of: [.images, .videos])) {
                                Label(tr("Photos"), systemImage: "photo.on.rectangle").frame(maxWidth: .infinity)
                            }
                            .secondaryButton().controlSize(.large)
                        }
                        .disabled(!core.connected)

                        if let o = core.fclip.offer {
                            VStack(alignment: .leading, spacing: 10) {
                                Label(tr("Copied on {name}", ["name": core.host?.name ?? tr("the computer")]), systemImage: "doc.on.doc").font(.headline)
                                Text(o.files == 1 ? (o.names.first ?? tr("1 file")) : tr("{files} items", ["files": o.files])).foregroundStyle(.secondary)
                                Button(tr("Save to this {device}", ["device": Device.word])) { core.fclip.save() }.primaryButton()
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassCard(tint: .blue)
                        }

                        Button { openReceived() } label: {
                            HStack {
                                Image(systemName: "folder.fill").foregroundStyle(.blue).glassChip(42, tint: .blue)
                                VStack(alignment: .leading) {
                                    Text(tr("Received")).font(.body.weight(.semibold))
                                    Text(tr("Files › On My {device} › TwinDesk", ["device": Device.word])).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "arrow.up.forward.app").foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain).glassCard().hoverLift()

                        if core.connected {
                            Label(Device.isPad ? tr("Or drag files here from Files, Photos or Safari") : tr("Or drag files onto TwinDesk from another app"),
                                  systemImage: "hand.draw")
                                .font(.subheadline).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.vertical, 22)
                                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 5])).foregroundStyle(.secondary.opacity(0.5)))
                        }
                    } right: {
                        if !core.files.batches.isEmpty {
                            SectionTitle(text: tr("Transfers"))
                            VStack(spacing: 14) {
                                ForEach(core.files.batches.prefix(30)) { b in transfer(b) }
                            }
                            .glassCard()
                        }
                    }
                    .pageWidth()
                }
            }
            .background(Backdrop())
            .navigationTitle(tr("File Sharing"))
            .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
                if case .success(let urls) = r { for u in urls { core.files.adopt(u) }; core.files.flushShares() }
            }
            .onChange(of: photos) { items in
                guard !items.isEmpty else { return }
                photos = []
                Task {
                    for it in items { if let f = try? await it.loadTransferable(type: PickedFile.self) { await MainActor.run { core.files.adopt(f.url) } } }
                    await MainActor.run { core.files.flushShares() }
                }
            }
    }

    private func transfer(_ b: Files.Batch) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: b.dir == "in" ? "arrow.down.circle.fill" : "arrow.up.circle.fill").foregroundStyle(b.dir == "in" ? .green : .blue)
                Text(b.name).lineLimit(1)
                Spacer()
                Text(b.finished ? (b.ok ? tr("Done") : b.cancelled ? tr("Cancelled") : tr("Failed")) : "\(Int(b.progress * 100))%").font(.caption).foregroundStyle(b.ok || b.cancelled ? Color.secondary : Color.orange)
                if b.dir == "out" && !b.finished {
                    Button(tr("Cancel"), role: .destructive) { core.files.cancel(b.id) }.secondaryButton().controlSize(.mini)
                }
            }
            if !b.finished { ProgressView(value: b.progress) }
            Text(ByteCountFormatter.string(fromByteCount: b.bytes, countStyle: .file) + (b.count > 1 ? tr(" · {count} items", ["count": b.count]) : ""))
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    // The Files app at our folder (its shareddocuments:// address).
    private func openReceived() {
        let dir = Files.receivedDir
        if let url = URL(string: "shareddocuments://" + dir.path) { UIApplication.shared.open(url) }
    }
}
