// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Devices: the connected computer up top (its name, how it's reached, quick actions), then the
// computers nearby, the paired ones, and pairing by address. A computer's QR code (Connection ›
// Pair with a QR code there) opens TwinDesk straight from the Camera app.
import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct HomeView: View {
    @EnvironmentObject var core: Core
    @State private var address = ""
    @State private var picking = false
    @State private var photos: [PhotosPickerItem] = []

    var body: some View {
        NavigationStack {
            ScrollView {
                GlassGroup {
                    VStack(spacing: 16) {
                        hero
                        if core.connected { actions; ShareScreenCard() }
                        nearbyList
                        pairedList
                        byAddress
                    }
                    .padding(.horizontal, 16).padding(.bottom, 30)
                }
            }
            .background(Backdrop())
            .navigationTitle("TwinDesk")
            .refreshable { core.discovery.refresh() }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
                if case .success(let urls) = r { for u in urls { core.files.adopt(u) }; core.files.flushShares() }
            }
            .onChange(of: photos) { items in sendPhotos(items) }
        }
    }

    // ---- the connected computer ----

    private var hero: some View {
        let h = core.host
        let st = core.state
        return VStack(spacing: 14) {
            HStack(spacing: 14) {
                Image(systemName: osSymbol(h?.os ?? "mac")).font(.system(size: 24, weight: .semibold))
                    .glassChip(56, tint: core.connected ? .green : .blue)
                VStack(alignment: .leading, spacing: 3) {
                    Text(core.connected || st == "connecting" ? (h?.name ?? "Computer") : "Not connected").font(.title3.bold())
                    Text(statusLine).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
            }
            if core.connected {
                Button(role: .destructive) { core.disconnect() } label: { Label("Disconnect", systemImage: "xmark").frame(maxWidth: .infinity) }
                    .secondaryButton()
            } else if st == "connecting" {
                ProgressView().frame(maxWidth: .infinity)
            } else if !core.message.isEmpty {
                Text(core.message).font(.footnote).foregroundStyle(.orange).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .glassCard(28, tint: core.connected ? .green : nil)
    }

    private var statusLine: String {
        switch core.state {
        case "connected":
            let via = Discovery.hasEthernet ? "Ethernet" : "Wi-Fi"
            return [via, core.rttMs.map { "\($0) ms" }].compactMap { $0 }.joined(separator: " · ")
        case "connecting": return "Connecting…"
        default: return core.hosts.isEmpty ? "Pair a computer below" : "Tap a computer to connect"
        }
    }

    private var actions: some View {
        HStack(spacing: 12) {
            action("Clipboard", "doc.on.clipboard") { core.clip.sendCurrent(force: true) }
            PhotosPicker(selection: $photos, maxSelectionCount: 50, matching: .any(of: [.images, .videos])) {
                tile("Photos", "photo.on.rectangle")
            }
            action("Files", "folder.badge.plus") { picking = true }
            if core.fclip.offer != nil { action("Save copied", "square.and.arrow.down") { core.fclip.save() } }
        }
    }

    private func action(_ title: String, _ icon: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) { tile(title, icon) }.buttonStyle(.plain)
    }

    private func tile(_ title: String, _ icon: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.title3)
            Text(title).font(.caption.weight(.medium)).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .glassCard(22)
    }

    private func sendPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        photos = []
        Task {
            for it in items {
                // As files, with their own names where the library gives them.
                if let f = try? await it.loadTransferable(type: PickedFile.self) { await MainActor.run { core.files.adopt(f.url) } }
            }
            await MainActor.run { core.files.flushShares() }
        }
    }

    // ---- lists ----

    @ViewBuilder
    private var nearbyList: some View {
        let unpaired = core.nearby.filter { f in !core.hosts.contains { $0.id == f.id } }
        if !unpaired.isEmpty {
            SectionTitle(text: "Nearby")
            VStack(spacing: 0) {
                ForEach(unpaired) { f in
                    Button { core.pair(f) } label: { row(f.name, f.os, f.invited ? "Wants to connect · Tap to pair" : "Tap to pair · \(f.address)") }
                        .buttonStyle(.plain)
                    if f.id != unpaired.last?.id { Divider().padding(.leading, 58) }
                }
            }
            .glassCard()
        }
    }

    @ViewBuilder
    private var pairedList: some View {
        if !core.hosts.isEmpty {
            SectionTitle(text: "Paired")
            VStack(spacing: 0) {
                ForEach(core.hosts) { h in
                    let here = core.nearby.contains { $0.id == h.id }
                    let current = core.host?.id == h.id && core.state != "idle"
                    Button { if !current { core.connect(h) } } label: {
                        row(h.name, h.os, current ? (core.connected ? "Connected" : "Connecting…") : here ? "Nearby · Tap to connect" : "Last at \(h.address)")
                    }
                    .buttonStyle(.plain)
                    .contextMenu { Button("Forget", role: .destructive) { core.forget(h.id) } }
                    if h.id != core.hosts.last?.id { Divider().padding(.leading, 58) }
                }
            }
            .glassCard()
        }
    }

    private func row(_ name: String, _ os: String, _ sub: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: osSymbol(os)).font(.body.weight(.semibold)).glassChip(42)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.body.weight(.semibold))
                Text(sub).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    private var byAddress: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "Pair")
            VStack(alignment: .leading, spacing: 12) {
                Label("Scan the QR code in TwinDesk on the computer (Connection › Pair with a QR code) with the Camera app.", systemImage: "qrcode.viewfinder")
                    .font(.subheadline)
                HStack {
                    TextField("Computer’s address, e.g. 192.168.1.20", text: $address)
                        .keyboardType(.numbersAndPunctuation).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Pair") { core.pairAddress(address) }.primaryButton().disabled(address.isEmpty)
                }
                if !core.discovery.error.isEmpty { Text(core.discovery.error).font(.caption).foregroundStyle(.orange) }
            }
            .glassCard()
        }
    }
}

// A photo or video from the library as a file we can send (its own name and bytes).
struct PickedFile: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .item) { f in SentTransferredFile(f.url) } importing: { r in
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let to = dir.appendingPathComponent(r.file.lastPathComponent)
            try FileManager.default.copyItem(at: r.file, to: to)
            return PickedFile(url: to)
        }
    }
}
