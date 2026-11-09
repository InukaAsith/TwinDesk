// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Overview: the connected computer (how it's reached, Disconnect), what to do with it in a tap
// (send the clipboard, photos, files; see its screen; the Remote), its controls (volume, Lock,
// Sleep), what plays there, what it copied last and its latest notifications.
// Connection: the computers nearby, the paired ones, pairing by QR code or address.
import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct OverviewView: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    @State private var picking = false
    @State private var pickingPhotos = false
    @State private var photos: [PhotosPickerItem] = []

    var body: some View {
        PageScroll(title: tr("Overview")) {
            Columns {
                Hero()
                if core.connected { actions }
                if core.connected && (core.dev.can.contains(.volume) || core.dev.can.contains(.lock)) { controls }
            } right: {
                if core.connected, let n = core.media.now { NowPlayingCard(now: n) }
                if core.connected { PcClipCard(); PcNotifsCard() }
                if !core.connected {
                    VStack(alignment: .leading, spacing: 10) {
                        CardHeader(symbol: "link", color: TDColor.accent, title: core.hosts.isEmpty ? tr("Pair a computer") : tr("Connect"),
                                   detail: core.hosts.isEmpty ? tr("TwinDesk on a Mac, PC or Linux computer") : tr("Pick one in Connection"))
                        Button(tr("Open Connection")) { ui.open(.connection) }.primaryButton()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard()
                }
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
            if case .success(let urls) = r { for u in urls { core.files.adopt(u) }; core.files.flushShares() }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 50, matching: .any(of: [.images, .videos]))
        .onChange(of: photos) { items in sendPhotos(items) }
    }

    // Quick actions (Tiles.swift): what to do with the computer in a tap, edited in place.
    private var actions: some View {
        let name = core.host?.name ?? tr("the computer")
        let can = core.dev.can
        let now = core.media.now
        let playing = now?.playing == true
        var defs: [TileDef] = [
            TileDef(id: "screen", label: tr("Its screen"), symbol: "display", color: Page.receive.color, state: name) { ui.cover = .viewer },
            TileDef(id: "voice", label: tr("Voice typing"), symbol: "mic.fill", color: Color(red: 1, green: 0.27, blue: 0.4), state: tr("Speak, it types on {name}", ["name": name])) { ui.cover = .remote("voice") },
            TileDef(id: "touchpad", label: tr("Touchpad"), symbol: "hand.point.up.left.fill", color: .orange, state: tr("And keyboard")) { ui.cover = .remote("pad") },
            TileDef(id: "gamepad", label: tr("Gamepad"), symbol: "gamecontroller.fill", color: Color(red: 0.69, green: 0.32, blue: 0.87), state: tr("Keys or a controller")) { ui.cover = .remote("gamepad") },
            TileDef(id: "photos", label: tr("Send photos"), symbol: "photo.on.rectangle", color: Page.photos.color, state: tr("To {name}", ["name": name])) { pickingPhotos = true },
            TileDef(id: "files", label: tr("Send files"), symbol: "folder.fill.badge.plus", color: Page.files.color, state: tr("To Downloads")) { picking = true },
            TileDef(id: "clipboard", label: tr("Send clipboard"), symbol: "doc.on.clipboard.fill", color: Page.clipboard.color, state: tr("What’s copied here")) { _ = core.clip.sendCurrent(force: true) },
            TileDef(id: "media", label: playing ? tr("Pause") : tr("Play"), symbol: playing ? "pause.fill" : "play.fill", color: Page.media.color, on: playing,
                    state: now.map { [$0.title, $0.artist].filter { !$0.isEmpty }.joined(separator: " · ") } ?? tr("Nothing playing")) { core.media.ctl("toggle") },
            TileDef(id: "next", label: tr("Next track"), symbol: "forward.fill", color: Page.media.color, state: now?.title ?? "") { core.media.ctl("next") },
            TileDef(id: "lock", label: tr("Lock"), symbol: "lock.fill", color: Color(white: 0.45), has: can.contains(.lock), state: name) { core.dev.act("lock") },
            TileDef(id: "sleep", label: tr("Sleep"), symbol: "moon.zzz.fill", color: Color(red: 0.37, green: 0.36, blue: 0.9), has: can.contains(.sleep), state: name) { core.dev.act("sleep") },
            TileDef(id: "dnd", label: tr("Focus"), symbol: "moon.fill", color: Color(red: 0.37, green: 0.36, blue: 0.9), has: can.contains(.dnd), on: core.dev.dnd == true,
                    state: core.dev.dnd == true ? tr("On") : tr("Off")) { core.dev.act("dnd", ["on": !(core.dev.dnd ?? false)]) },
            TileDef(id: "ring", label: tr("Ring"), symbol: "bell.and.waves.left.and.right.fill", color: TDColor.bad, has: can.contains(.ring), state: tr("Find {name}", ["name": name])) { core.dev.act("ring") },
            TileDef(id: "sound", label: tr("Sound"), symbol: "speaker.wave.2.fill", color: Page.audio.color, state: tr("{name}’s sound", ["name": name])) { ui.open(.audio) },
            TileDef(id: "camera", label: tr("Webcam"), symbol: "video.fill", color: Page.camera.color, state: tr("This camera on {name}", ["name": name])) { ui.open(.camera) },
            TileDef(id: "notifications", label: tr("Notifications"), symbol: "bell.badge.fill", color: Page.notifications.color, state: tr("Both ways")) { ui.open(.notifications) },
        ]
        if core.fclip.offer != nil { // what the computer copied: kept first while it's there
            defs.insert(TileDef(id: "auto.savecopied", label: tr("Save copied"), symbol: "square.and.arrow.down.fill", color: TDColor.good, state: tr("Copied on {name}", ["name": name])) { core.fclip.save() }, at: 0)
        }
        return TilesCard(defs: defs)
    }

    // The computer's own controls (shared/devctl.js there).
    private var controls: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(symbol: osSymbol(core.host?.os ?? "mac"), color: Color(white: 0.45), title: core.host?.name ?? tr("Computer"))
            if core.dev.can.contains(.volume) {
                HStack(spacing: 10) {
                    Image(systemName: "speaker.fill").foregroundStyle(.secondary)
                    Slider(value: Binding(get: { core.dev.volume ?? 0.5 }, set: { core.dev.setVolume($0) }), in: 0...1)
                    Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 10) {
                if core.dev.can.contains(.lock) { Button { core.dev.act("lock") } label: { Label(tr("Lock"), systemImage: "lock.fill") }.secondaryButton() }
                if core.dev.can.contains(.sleep) { Button { core.dev.act("sleep") } label: { Label(tr("Sleep"), systemImage: "moon.fill") }.secondaryButton() }
                if core.dev.can.contains(.dnd) {
                    Button { core.dev.act("dnd", ["on": !(core.dev.dnd ?? false)]) } label: {
                        Label(tr("Focus"), systemImage: core.dev.dnd == true ? "moon.circle.fill" : "moon.circle")
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
                device(Device.isPad ? "ipad.landscape" : "iphone", tr("This {device}", ["device": Device.word]))
                VStack(spacing: 7) {
                    LinkLine(up: up)
                    Text(linkText).font(.caption).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 4)
                Group {
                    if let p = phone { device(p.peerOs == "ios" ? "iphone" : "iphone.gen2", p.peerName) }
                    else { device(osSymbol(h?.os ?? "mac"), h?.name ?? tr("Computer")) }
                }
                    .opacity(up || st == "connecting" ? 1 : 0.55)
                    .animation(.easeInOut(duration: 0.4), value: up)
            }
            Divider().overlay(TDColor.line).padding(.top, 16)
            Text(phone.map { tr("Connected to {name}. The pages show what it can do.", ["name": $0.peerName]) } ?? statusText).font(.subheadline).foregroundStyle(core.message.isEmpty || up ? Color.secondary : TDColor.warn)
                .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.top, 11)
            HStack(spacing: 10) {
                if let p = phone {
                    Button(tr("Disconnect"), role: .destructive) { p.disconnect() }.secondaryButton()
                } else if core.connected {
                    Button(tr("Disconnect"), role: .destructive) { core.disconnect() }.secondaryButton()
                } else if st == "connecting" {
                    ProgressView()
                } else if let h = core.hosts.first {
                    Button(tr("Connect to {name}", ["name": h.name])) { core.connect(h) }.primaryButton()
                }
            }
            .controlSize(.small)
            .padding(.top, 10)
        }
        .glassCard(26, tint: up ? TDColor.accent : nil) // the accent picked in General, not a fixed green
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
        if core.peerMode { return tr("Phone") }
        switch core.state {
        case "connected":
            let via = core.link.wired ? "USB" : core.link.viaBle ? tr("Bluetooth") : Discovery.hasEthernet ? tr("Ethernet") : "Wi-Fi"
            return [core.rttMs.map { "\($0) ms" }, via].compactMap { $0 }.joined(separator: " · ")
        case "connecting": return core.pair != nil ? tr("Pairing…") : tr("Connecting…")
        default: return tr("Not connected")
        }
    }

    private var statusText: String {
        if core.connected { return tr("Connected. Clipboard, files and screens go both ways.") }
        if core.state == "connecting" { return tr("Connecting to {name}…", ["name": core.host?.name ?? tr("the computer")]) }
        if !core.message.isEmpty { return core.message }
        return core.hosts.isEmpty ? tr("Pick a computer in Nearby, or connect by address.") : tr("Open TwinDesk on the computer to connect.")
    }
}

// What the computer copied, newest first (tap one: on this device's clipboard again).
struct PcClipCard: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    var body: some View {
        let name = core.host?.name ?? tr("the computer")
        let list = Array(core.clip.history.filter { $0.dir == "in" }.prefix(3))
        DenseCard(title: tr("{name}’s clipboard", ["name": name])) {
            Button(tr("All")) { ui.open(.clipboard) }.buttonStyle(.borderless).font(.subheadline)
        } content: {
            if list.isEmpty {
                DenseRow(symbol: "doc.on.clipboard", title: tr("Nothing copied yet"),
                         hint: core.sync.get("clipboard", "in") ? tr("What you copy on {name} shows here.", ["name": name]) : tr("Turn on Receive in Clipboard to get what {name} copies.", ["name": name]),
                         divider: false) { EmptyView() }
            }
            ForEach(Array(list.enumerated()), id: \.element.id) { i, item in
                Button { if !item.pic { core.clip.write(item.text) } } label: {
                    DenseRow(symbol: item.pic ? "photo" : "doc.on.clipboard", title: item.text, hint: ago(item.at), divider: i > 0) {
                        if !item.pic { Image(systemName: "doc.on.doc").foregroundStyle(.secondary) }
                    }
                    .lineLimit(2)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(item.pic)
            }
        }
    }
}

// The computer's latest notifications, this session.
struct PcNotifsCard: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    var body: some View {
        let name = core.host?.name ?? tr("the computer")
        let list = Array(core.notifs.recent.prefix(4))
        DenseCard(title: tr("{name}’s notifications", ["name": name])) {
            Button(tr("Settings")) { ui.open(.notifications) }.buttonStyle(.borderless).font(.subheadline)
        } content: {
            if list.isEmpty {
                DenseRow(symbol: "bell", title: tr("No notifications yet"),
                         hint: core.sync.get("notifs", "in") ? tr("Notifications from {name} show here while connected.", ["name": name]) : tr("Turn on Show notifications in Notifications to get them."),
                         divider: false) { EmptyView() }
            }
            ForEach(Array(list.enumerated()), id: \.element.id) { i, n in
                DenseRow(symbol: "bell.fill",
                         title: n.title.isEmpty ? n.app : n.title,
                         hint: [n.title.isEmpty ? "" : n.app, n.body, ago(n.at)].filter { !$0.isEmpty }.joined(separator: " · "),
                         divider: i > 0) { EmptyView() }
                    .lineLimit(2)
            }
        }
    }
}

private func ago(_ d: Date) -> String {
    if Date().timeIntervalSince(d) < 60 { return tr("Just now") }
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    f.locale = Locale(identifier: I18n.shared.lang)
    return f.localizedString(for: d, relativeTo: Date())
}

struct NowPlayingCard: View {
    @EnvironmentObject var core: Core
    let now: PcMedia.Now
    var body: some View {
        HStack(spacing: 14) {
            Artwork(image: core.media.art, size: 44)
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

// What plays on the computer: its artwork when it sent one, else the Media icon.
struct Artwork: View {
    let image: UIImage?
    var size: CGFloat = 44
    var body: some View {
        if let img = image {
            Image(uiImage: img).resizable().scaledToFill()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: size * 0.18, style: .continuous).strokeBorder(.white.opacity(0.12)))
        } else {
            FeatureIcon(symbol: "music.note", color: Page.media.color, size: size)
        }
    }
}

struct ConnectionView: View {
    @EnvironmentObject var core: Core
    @State private var address = ""
    @State private var sure: String? // the paired computer whose Forget was pressed once (Forget? to confirm)
    @State private var spin = 0.0

    var body: some View {
        PageScroll(title: tr("Connection")) {
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
        DenseCard(title: tr("Nearby")) {
            Button {
                core.discovery.refresh()
                withAnimation(.easeInOut(duration: 0.6)) { spin += 360 }
            } label: { Image(systemName: "arrow.clockwise").rotationEffect(.degrees(spin)) }
                .buttonStyle(.borderless).accessibilityLabel(tr("Look again"))
        } content: {
            let list = core.nearby
            if core.peerMode {
                DenseRow(symbol: "iphone", title: tr("Connected to {name}", ["name": core.peer.peerName]), hint: tr("Connecting to a computer ends the session with {name}.", ["name": core.peer.peerName]), divider: false) { EmptyView() }
            }
            if !core.discovery.error.isEmpty {
                DenseRow(symbol: "exclamationmark.triangle", title: tr("Can’t look for computers on this network"),
                         hint: core.discovery.error, hintColor: TDColor.warn, divider: false) { EmptyView() }
            }
            let viaBle = bleOnly
            if list.isEmpty && viaBle.isEmpty {
                DenseRow(title: tr("Looking for computers…"), hint: tr("Open TwinDesk on the computer, on the same Wi-Fi."), divider: !core.discovery.error.isEmpty) {
                    ProgressView()
                }
            }
            ForEach(Array(list.enumerated()), id: \.element.id) { i, f in
                nearbyRow(f, first: i == 0 && core.discovery.error.isEmpty)
            }
            ForEach(Array(viaBle.enumerated()), id: \.element.id) { i, b in
                let going = core.pair?.name == b.name
                DenseRow(symbol: "dot.radiowaves.left.and.right", title: b.name,
                         hint: going ? tr("Pairing…") : tr("Over Bluetooth · not on this network"),
                         divider: !(list.isEmpty && i == 0 && core.discovery.error.isEmpty)) {
                    if going { ProgressView() } else { Button(tr("Pair")) { core.pairBle(b.id) }.primaryButton() }
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
                 hint: going ? (core.pair != nil ? tr("Pairing…") : tr("Connecting…")) : f.invited ? tr("{address} · wants to connect", ["address": f.address]) : f.address,
                 divider: !first) {
            if going { ProgressView() }
            if online { Pill(text: tr("Connected")) }
            else if known != nil && !going { Pill(text: tr("Paired"), color: TDColor.muted) }
            if !online && !going {
                if let h = known {
                    Button(core.connected || core.peer.connected ? tr("Switch") : tr("Connect")) { core.connect(h) }.secondaryButton()
                } else {
                    Button(tr("Pair")) { core.pair(f) }.primaryButton()
                }
            }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    // ---- Paired: computers this device has paired with, Forget each ----

    private var pairedCard: some View {
        DenseCard(title: tr("Paired")) {
            if core.hosts.isEmpty {
                DenseRow(title: tr("Nothing paired yet"), hint: tr("Pair with a computer in Nearby."), divider: false) { EmptyView() }
            }
            ForEach(Array(core.hosts.enumerated()), id: \.element.id) { i, h in
                let online = core.host?.id == h.id && core.connected
                let near = core.nearby.contains { $0.id == h.id }
                DenseRow(symbol: osSymbol(h.os), title: h.name,
                         hint: online ? tr("Connected") : near ? tr("Nearby · last seen {ago}", ["ago": ago(h.lastSeen)]) : tr("Last seen {ago} at {address}", ["ago": ago(h.lastSeen), "address": h.address]),
                         divider: i > 0) {
                    if online { Pill(text: tr("Online")) }
                    else { Button(core.connected || core.peer.connected ? tr("Switch") : tr("Connect")) { core.connect(h) }.secondaryButton() }
                    Button(sure == h.id ? tr("Forget?") : tr("Forget"), role: sure == h.id ? .destructive : nil) {
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
        DenseCard(title: tr("Pair")) {
            DenseRow(symbol: "qrcode.viewfinder", title: tr("Scan the computer’s QR code"),
                     hint: tr("In TwinDesk on the computer: Connection › Pair with a QR code. Scan it with the Camera app."), divider: false) { EmptyView() }
            VStack(spacing: 0) {
                Divider().overlay(TDColor.line)
                HStack(spacing: 10) {
                    Image(systemName: "number").font(.system(size: 17, weight: .medium)).foregroundStyle(TDColor.text.opacity(0.85)).frame(width: 30)
                    TextField(tr("Computer’s address, e.g. 192.168.1.20"), text: $address)
                        .font(.subheadline)
                        .keyboardType(.numbersAndPunctuation).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit { if !address.isEmpty { core.pairAddress(address) } }
                    Button(tr("Connect")) { core.pairAddress(address) }.primaryButton().controlSize(.small).disabled(address.isEmpty)
                }
                .padding(.vertical, 9)
            }
        }
    }

    private var usbCard: some View {
        DenseCard(title: tr("USB cable")) {
            DenseRow(symbol: "cable.connector", title: core.link.wired ? tr("Connected through the cable") : core.usb.ready ? tr("{computerName} is on the cable", ["computerName": core.usb.computerName ?? tr("A computer")]) : tr("Not plugged in"),
                     hint: tr("On a cable the session, the screen and files go through it: faster than Wi-Fi. TwinDesk moves onto it by itself."),
                     divider: false) {
                if core.link.wired { Pill(text: tr("In use")) } else if core.usb.ready { Pill(text: tr("Ready"), color: TDColor.accent) }
            }
            // On the cable to a computer not paired yet: pair through it (no Wi-Fi needed).
            if let u = core.usb.unpaired, !core.link.wired {
                let going = core.pair?.name == u.name
                DenseRow(symbol: "link", title: tr("{name} isn’t paired yet", ["name": u.name]),
                         hint: going ? tr("Pairing through the cable…") : tr("Pair through the cable, whatever network each is on. Compare the code on both.")) {
                    if going { ProgressView() } else { Button(tr("Pair")) { core.pairUsb() }.primaryButton() }
                }
            }
        }
    }

    private func ago(_ t: Double) -> String {
        guard t > 0 else { return tr("never") }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        f.locale = Locale(identifier: I18n.shared.lang)
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
