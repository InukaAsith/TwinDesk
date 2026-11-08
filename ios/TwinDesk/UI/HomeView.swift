// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Overview: the connected computer (how it's reached, Disconnect), what to do with it in a tap
// (send the clipboard, photos, files; see its screen; the Remote; share this screen), its controls
// (volume, Lock, Sleep) and what plays there.
// Connection: the computers nearby, the paired ones, pairing by QR code or address.
import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct OverviewView: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    @State private var picking = false
    @State private var photos: [PhotosPickerItem] = []

    var body: some View {
        PageScroll(title: "Overview") {
            Columns {
                Hero()
                if core.connected { actions }
                if core.connected && (core.dev.can.contains(.volume) || core.dev.can.contains(.lock)) { controls }
            } right: {
                if core.connected, let n = core.media.now { NowPlayingCard(now: n) }
                if core.connected { ShareScreenCard() }
                if !core.connected {
                    VStack(alignment: .leading, spacing: 10) {
                        CardHeader(symbol: "link", color: TDColor.accent, title: core.hosts.isEmpty ? "Pair a computer" : "Connect",
                                   detail: core.hosts.isEmpty ? "TwinDesk on a Mac, PC or Linux computer" : "Pick one in Connection")
                        Button("Open Connection") { ui.open(.connection) }.primaryButton()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard()
                }
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
            if case .success(let urls) = r { for u in urls { core.files.adopt(u) }; core.files.flushShares() }
        }
        .onChange(of: photos) { items in sendPhotos(items) }
    }

    private var actions: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 12)], spacing: 12) {
            tileButton("Clipboard", "doc.on.clipboard", Page.clipboard.color) { core.clip.sendCurrent(force: true) }
            PhotosPicker(selection: $photos, maxSelectionCount: 50, matching: .any(of: [.images, .videos])) {
                tile("Photos", "photo.on.rectangle", Page.photos.color)
            }
            .buttonStyle(.plain)
            tileButton("Files", "folder.badge.plus", Page.files.color) { picking = true }
            tileButton("Its screen", "display", Page.receive.color) { ui.cover = .viewer }
            tileButton("Touchpad", "hand.point.up.left", Page.remote.color) { ui.cover = .remote("pad") }
            tileButton("Gamepad", "gamecontroller", Page.remote.color) { ui.cover = .remote("gamepad") }
            if core.fclip.offer != nil { tileButton("Save copied", "square.and.arrow.down", TDColor.good) { core.fclip.save() } }
        }
    }

    private func tileButton(_ title: String, _ icon: String, _ color: Color, _ run: @escaping () -> Void) -> some View {
        Button(action: run) { tile(title, icon, color) }.buttonStyle(.plain).hoverLift()
    }

    private func tile(_ title: String, _ icon: String, _ color: Color) -> some View {
        VStack(spacing: 8) {
            FeatureIcon(symbol: icon, color: color, size: 36)
            Text(title).font(.caption.weight(.medium)).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, -4)
        .glassCard(20)
    }

    // The computer's own controls (shared/devctl.js there).
    private var controls: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(symbol: osSymbol(core.host?.os ?? "mac"), color: Color(white: 0.45), title: core.host?.name ?? "Computer")
            if core.dev.can.contains(.volume) {
                HStack(spacing: 10) {
                    Image(systemName: "speaker.fill").foregroundStyle(.secondary)
                    Slider(value: Binding(get: { core.dev.volume ?? 0.5 }, set: { core.dev.setVolume($0) }), in: 0...1)
                    Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 10) {
                if core.dev.can.contains(.lock) { Button { core.dev.act("lock") } label: { Label("Lock", systemImage: "lock.fill") }.secondaryButton() }
                if core.dev.can.contains(.sleep) { Button { core.dev.act("sleep") } label: { Label("Sleep", systemImage: "moon.fill") }.secondaryButton() }
                if core.dev.can.contains(.dnd) {
                    Button { core.dev.act("dnd", ["on": !(core.dev.dnd ?? false)]) } label: {
                        Label("Focus", systemImage: core.dev.dnd == true ? "moon.circle.fill" : "moon.circle")
                    }.secondaryButton()
                }
            }
            .controlSize(.small)
        }
        .glassCard()
    }

    private func sendPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        photos = []
        Task {
            for it in items {
                if let f = try? await it.loadTransferable(type: PickedFile.self) { await MainActor.run { core.files.adopt(f.url) } }
            }
            await MainActor.run { core.files.flushShares() }
        }
    }
}

// The connected computer, or what we're doing about it.
struct Hero: View {
    @EnvironmentObject var core: Core

    var body: some View {
        let h = core.host
        let st = core.state
        VStack(spacing: 14) {
            HStack(spacing: 14) {
                Image(systemName: osSymbol(h?.os ?? "mac")).font(.system(size: 24, weight: .semibold))
                    .glassChip(56, tint: core.connected ? TDColor.good : TDColor.accent)
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
                Text(core.message).font(.footnote).foregroundStyle(TDColor.warn).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .glassCard(28, tint: core.connected ? TDColor.good : nil)
    }

    private var statusLine: String {
        switch core.state {
        case "connected":
            let via = core.link.wired ? "USB cable" : core.link.viaBle ? "Bluetooth" : Discovery.hasEthernet ? "Ethernet" : "Wi-Fi"
            return [via, core.rttMs.map { "\($0) ms" }].compactMap { $0 }.joined(separator: " · ")
        case "connecting": return "Connecting…"
        default: return core.hosts.isEmpty ? "Pair a computer in Connection" : "Tap a computer in Connection"
        }
    }
}

struct NowPlayingCard: View {
    @EnvironmentObject var core: Core
    let now: PcMedia.Now
    var body: some View {
        HStack(spacing: 14) {
            FeatureIcon(symbol: "music.note", color: Page.media.color, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(now.title).font(.body.weight(.semibold)).lineLimit(1)
                Text([now.artist, now.app].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button { core.media.ctl("prev") } label: { Image(systemName: "backward.fill") }.buttonStyle(.plain)
            Button { core.media.ctl("toggle") } label: { Image(systemName: now.playing ? "pause.fill" : "play.fill").font(.title2) }.buttonStyle(.plain)
            Button { core.media.ctl("next") } label: { Image(systemName: "forward.fill") }.buttonStyle(.plain)
        }
        .glassCard()
    }
}

struct ConnectionView: View {
    @EnvironmentObject var core: Core
    @State private var address = ""

    var body: some View {
        PageScroll(title: "Connection") {
            Columns {
                Hero()
                nearbyList
                pairedList
            } right: {
                byAddress
                VStack(alignment: .leading, spacing: 10) {
                    CardHeader(symbol: "cable.connector", color: TDColor.good, title: "USB cable",
                               detail: core.link.wired ? "Connected through the cable" : (core.usb.ready ? "\(core.usb.computerName ?? "A computer") is on the cable" : "Plug this \(Device.word) into the computer"))
                    Text("On a cable the session, the screen and files go through it: faster than Wi-Fi, and nothing on the network. TwinDesk moves onto it by itself when it’s plugged in.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard()
            }
        }
        .refreshable { core.discovery.refresh() }
    }

    @ViewBuilder
    private var nearbyList: some View {
        let unpaired = core.nearby.filter { f in !core.hosts.contains { $0.id == f.id } }
        if !unpaired.isEmpty {
            SectionTitle(text: "Nearby")
            VStack(spacing: 0) {
                ForEach(unpaired) { f in
                    Button { core.pair(f) } label: { row(f.name, f.os, f.invited ? "Wants to connect · Tap to pair" : "Tap to pair · \(f.address)") }
                        .buttonStyle(.plain).hoverLift()
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
                    .buttonStyle(.plain).hoverLift()
                    .contextMenu { Button("Forget", role: .destructive) { core.forget(h.id) } }
                    if h.id != core.hosts.last?.id { Divider().padding(.leading, 58) }
                }
            }
            .glassCard()
            Text("Touch and hold a computer to forget it.").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 6)
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
                if !core.discovery.error.isEmpty { Text(core.discovery.error).font(.caption).foregroundStyle(TDColor.warn) }
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
