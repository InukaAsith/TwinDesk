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
// This device, the line, the computer (as the computers' Connection page draws it), what's going on
// under it, Disconnect / Connect.
struct Hero: View {
    @EnvironmentObject var core: Core

    var body: some View {
        let h = core.host ?? core.hosts.first
        let st = core.state
        let phone = core.peerMode ? core.peer : nil // another phone holds the session: it on the right
        let up = core.connected || phone != nil
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 6) {
                device(Device.isPad ? "ipad.landscape" : "iphone", "This \(Device.word)")
                VStack(spacing: 7) {
                    LinkLine(up: up)
                    Text(linkText).font(.caption).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 4)
                Group {
                    if let p = phone { device(p.peerOs == "ios" ? "iphone" : "iphone.gen2", p.peerName) }
                    else { device(osSymbol(h?.os ?? "mac"), h?.name ?? "Computer") }
                }
                    .opacity(up || st == "connecting" ? 1 : 0.55)
                    .animation(.easeInOut(duration: 0.4), value: up)
            }
            Divider().overlay(TDColor.line).padding(.top, 16)
            Text(phone.map { "Connected to \($0.peerName). The pages show what it can do." } ?? statusText).font(.subheadline).foregroundStyle(core.message.isEmpty || up ? Color.secondary : TDColor.warn)
                .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.top, 11)
            HStack(spacing: 10) {
                if let p = phone {
                    Button("Disconnect", role: .destructive) { p.disconnect() }.secondaryButton()
                } else if core.connected {
                    Button("Disconnect", role: .destructive) { core.disconnect() }.secondaryButton()
                } else if st == "connecting" {
                    ProgressView()
                } else if let h = core.hosts.first {
                    Button("Connect to \(h.name)") { core.connect(h) }.primaryButton()
                }
            }
            .controlSize(.small)
            .padding(.top, 10)
        }
        .glassCard(26, tint: up ? TDColor.good : nil)
        .animation(.easeInOut(duration: 0.3), value: st)
    }

    private func device(_ symbol: String, _ name: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 40, weight: .light)).foregroundStyle(TDColor.text.opacity(0.88))
                .frame(height: 48)
            Text(name).font(.footnote.weight(.semibold)).lineLimit(1).truncationMode(.middle)
        }
        .frame(width: 104)
    }

    private var linkText: String {
        if core.peerMode { return "Phone" }
        switch core.state {
        case "connected":
            let via = core.link.wired ? "USB" : core.link.viaBle ? "Bluetooth" : Discovery.hasEthernet ? "Ethernet" : "Wi-Fi"
            return [core.rttMs.map { "\($0) ms" }, via].compactMap { $0 }.joined(separator: " · ")
        case "connecting": return core.pair != nil ? "Pairing…" : "Connecting…"
        default: return "Not connected"
        }
    }

    private var statusText: String {
        if core.connected { return "Connected. Clipboard, files and screens go both ways." }
        if core.state == "connecting" { return "Connecting to \(core.host?.name ?? "the computer")…" }
        if !core.message.isEmpty { return core.message }
        return core.hosts.isEmpty ? "Pick a computer in Nearby, or connect by address." : "Open TwinDesk on the computer to connect."
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
    @State private var sure: String? // the paired computer whose Forget was pressed once (Forget? to confirm)
    @State private var spin = 0.0

    var body: some View {
        PageScroll(title: "Connection") {
            Columns {
                Hero()
                nearbyCard
                pairedCard
            } right: {
                addressCard
                usbCard
            }
            // Phones and tablets (Peer), at the bottom as on Android.
            PhonesSection()
        }
        .refreshable { core.discovery.refresh() }
        // While it's on screen, computers not paired yet are found over Bluetooth too (Pair through it).
        .onAppear { core.ble.look(true) }
        .onDisappear { core.ble.look(false) }
    }

    // Computers found over Bluetooth only (not on this network), not paired: Pair goes through Bluetooth.
    private struct BleFound: Identifiable { let id: String; let name: String }
    private var bleOnly: [BleFound] {
        _ = core.tick
        let seen = Set(core.nearby.map(\.id)).union(core.hosts.map(\.id))
        return core.ble.unpaired.filter { !seen.contains($0.key) }.map { BleFound(id: $0.key, name: $0.value) }.sorted { $0.name < $1.name }
    }

    // ---- Nearby: every computer TwinDesk sees, paired or not ----

    private var nearbyCard: some View {
        DenseCard(title: "Nearby") {
            Button {
                core.discovery.refresh()
                withAnimation(.easeInOut(duration: 0.6)) { spin += 360 }
            } label: { Image(systemName: "arrow.clockwise").rotationEffect(.degrees(spin)) }
                .buttonStyle(.borderless).accessibilityLabel("Look again")
        } content: {
            let list = core.nearby
            if core.peerMode {
                DenseRow(symbol: "iphone", title: "Connected to \(core.peer.peerName)", hint: "Connecting to a computer ends the session with \(core.peer.peerName).", divider: false) { EmptyView() }
            }
            if !core.discovery.error.isEmpty {
                DenseRow(symbol: "exclamationmark.triangle", title: "Can’t look for computers on this network",
                         hint: core.discovery.error, hintColor: TDColor.warn, divider: false) { EmptyView() }
            }
            let viaBle = bleOnly
            if list.isEmpty && viaBle.isEmpty {
                DenseRow(title: "Looking for computers…", hint: "Open TwinDesk on the computer, on the same Wi-Fi.", divider: !core.discovery.error.isEmpty) {
                    ProgressView()
                }
            }
            ForEach(Array(list.enumerated()), id: \.element.id) { i, f in
                nearbyRow(f, first: i == 0 && core.discovery.error.isEmpty)
            }
            ForEach(Array(viaBle.enumerated()), id: \.element.id) { i, b in
                let going = core.pair?.name == b.name
                DenseRow(symbol: "dot.radiowaves.left.and.right", title: b.name,
                         hint: going ? "Pairing…" : "Over Bluetooth · not on this network",
                         divider: !(list.isEmpty && i == 0 && core.discovery.error.isEmpty)) {
                    if going { ProgressView() } else { Button("Pair") { core.pairBle(b.id) }.primaryButton() }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    @ViewBuilder
    private func nearbyRow(_ f: Found, first: Bool) -> some View {
        let known = core.hosts.first { $0.id == f.id }
        let mine = core.host?.id == f.id
        let online = mine && core.connected
        let going = (mine && core.state == "connecting") || core.pair?.name == f.name
        DenseRow(symbol: osSymbol(f.os), title: f.name,
                 hint: going ? (core.pair != nil ? "Pairing…" : "Connecting…") : f.invited ? "\(f.address) · wants to connect" : f.address,
                 divider: !first) {
            if going { ProgressView() }
            if online { Pill(text: "Connected") }
            else if known != nil && !going { Pill(text: "Paired", color: TDColor.muted) }
            if !online && !going {
                if let h = known {
                    Button(core.connected || core.peer.connected ? "Switch" : "Connect") { core.connect(h) }.secondaryButton()
                } else {
                    Button("Pair") { core.pair(f) }.primaryButton()
                }
            }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    // ---- Paired: computers this device has paired with, Forget each ----

    private var pairedCard: some View {
        DenseCard(title: "Paired") {
            if core.hosts.isEmpty {
                DenseRow(title: "Nothing paired yet", hint: "Pair with a computer in Nearby.", divider: false) { EmptyView() }
            }
            ForEach(Array(core.hosts.enumerated()), id: \.element.id) { i, h in
                let online = core.host?.id == h.id && core.connected
                let near = core.nearby.contains { $0.id == h.id }
                DenseRow(symbol: osSymbol(h.os), title: h.name,
                         hint: online ? "Connected" : near ? "Nearby · last seen \(ago(h.lastSeen))" : "Last seen \(ago(h.lastSeen)) at \(h.address)",
                         divider: i > 0) {
                    if online { Pill(text: "Online") }
                    else { Button(core.connected || core.peer.connected ? "Switch" : "Connect") { core.connect(h) }.secondaryButton() }
                    Button(sure == h.id ? "Forget?" : "Forget", role: sure == h.id ? .destructive : nil) {
                        if sure == h.id { sure = nil; withAnimation { core.forget(h.id) } }
                        else {
                            withAnimation { sure = h.id }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { if sure == h.id { withAnimation { sure = nil } } }
                        }
                    }
                    .secondaryButton()
                    .tint(sure == h.id ? TDColor.bad : nil)
                }
            }
        }
        .animation(.easeInOut(duration: 0.25), value: core.hosts.map(\.id))
    }

    // ---- by address, or a QR code ----

    private var addressCard: some View {
        DenseCard(title: "Pair") {
            DenseRow(symbol: "qrcode.viewfinder", title: "Scan the computer’s QR code",
                     hint: "In TwinDesk on the computer: Connection › Pair with a QR code. Scan it with the Camera app.", divider: false) { EmptyView() }
            VStack(spacing: 0) {
                Divider().overlay(TDColor.line)
                HStack(spacing: 10) {
                    Image(systemName: "number").font(.system(size: 17, weight: .medium)).foregroundStyle(TDColor.text.opacity(0.85)).frame(width: 30)
                    TextField("Computer’s address, e.g. 192.168.1.20", text: $address)
                        .font(.subheadline)
                        .keyboardType(.numbersAndPunctuation).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit { if !address.isEmpty { core.pairAddress(address) } }
                    Button("Connect") { core.pairAddress(address) }.primaryButton().controlSize(.small).disabled(address.isEmpty)
                }
                .padding(.vertical, 9)
            }
        }
    }

    private var usbCard: some View {
        DenseCard(title: "USB cable") {
            DenseRow(symbol: "cable.connector", title: core.link.wired ? "Connected through the cable" : core.usb.ready ? "\(core.usb.computerName ?? "A computer") is on the cable" : "Not plugged in",
                     hint: "On a cable the session, the screen and files go through it: faster than Wi-Fi. TwinDesk moves onto it by itself.",
                     divider: false) {
                if core.link.wired { Pill(text: "In use") } else if core.usb.ready { Pill(text: "Ready", color: TDColor.accent) }
            }
            // On the cable to a computer not paired yet: pair through it (no Wi-Fi needed).
            if let u = core.usb.unpaired, !core.link.wired {
                let going = core.pair?.name == u.name
                DenseRow(symbol: "link", title: "\(u.name) isn’t paired yet",
                         hint: going ? "Pairing through the cable…" : "Pair through the cable, whatever network each is on. Compare the code on both.") {
                    if going { ProgressView() } else { Button("Pair") { core.pairUsb() }.primaryButton() }
                }
            }
        }
    }

    private func ago(_ t: Double) -> String {
        guard t > 0 else { return "never" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: Date(timeIntervalSince1970: t), relativeTo: Date())
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
