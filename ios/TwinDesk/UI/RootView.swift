// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The app as the computers lay theirs out: a sidebar of features (each a coloured icon, a green dot
// while it's in use), the connected computer at the top. On iPhone the sidebar is the first screen
// and each feature opens over it; on iPad (and an iPhone Max sideways) it stays at the side.
// Over everything: the computer's screen and the Remote (full screen), pairing, an invite.
import SwiftUI
import UniformTypeIdentifiers

enum Page: String, CaseIterable, Identifiable, Hashable {
    case overview, connection, phones, receive, share, remote, clipboard, notifications, files, photos, audio, camera, media, airplay, shortcuts, general, about
    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return "Overview"
        case .connection: return "Connection"
        case .phones: return "Phones"
        case .receive: return "Receive screen"
        case .share: return "Share screen"
        case .remote: return "Remote"
        case .clipboard: return "Clipboard"
        case .notifications: return "Notifications"
        case .files: return "File Sharing"
        case .photos: return "Photos"
        case .audio: return "Audio"
        case .camera: return "Camera"
        case .media: return "Media"
        case .airplay: return "AirPlay & SMB"
        case .shortcuts: return "Shortcuts"
        case .general: return "General"
        case .about: return "About"
        }
    }

    var icon: String {
        switch self {
        case .overview: return "house.fill"
        case .connection: return "link"
        case .phones: return "iphone.gen2"
        case .receive: return "display"
        case .share: return "rectangle.on.rectangle"
        case .remote: return "gamecontroller.fill"
        case .clipboard: return "doc.on.clipboard.fill"
        case .notifications: return "bell.fill"
        case .files: return "folder.fill"
        case .photos: return "photo.fill.on.rectangle.fill"
        case .audio: return "speaker.wave.2.fill"
        case .camera: return "video.fill"
        case .media: return "play.fill"
        case .airplay: return "airplayvideo"
        case .shortcuts: return "square.stack.3d.up.fill"
        case .general: return "gearshape.fill"
        case .about: return "info"
        }
    }

    var color: Color {
        switch self {
        case .overview: return Color(white: 0.45)
        case .connection, .receive, .share, .files, .about: return TDColor.accent
        case .remote: return .orange
        case .phones: return TDColor.good
        case .clipboard: return Color(red: 0.35, green: 0.78, blue: 0.85)
        case .notifications: return TDColor.bad
        case .photos: return Color(red: 1, green: 0.58, blue: 0.2)
        case .audio: return Color(red: 1, green: 0.3, blue: 0.42)
        case .camera: return Color(red: 0.69, green: 0.32, blue: 0.87)
        case .media: return Color(red: 0.98, green: 0.24, blue: 0.5)
        case .airplay: return Color(red: 1, green: 0.8, blue: 0.0)
        case .shortcuts: return Color(red: 0.37, green: 0.36, blue: 0.9)
        case .general: return Color(white: 0.5)
        }
    }

    // The sidebar's groups, as the computers have them.
    static let groups: [[Page]] = [
        [.overview, .connection, .phones],
        [.receive, .share, .remote],
        [.clipboard, .notifications, .files, .photos],
        [.audio, .camera, .media],
        [.airplay, .shortcuts],
        [.general, .about],
    ]

    var key: KeyEquivalent? {
        switch self {
        case .overview: return "1"
        case .connection: return "2"
        case .receive: return "3"
        case .remote: return "4"
        case .clipboard: return "5"
        case .files: return "6"
        case .general: return ","
        default: return nil
        }
    }
}

// What's over the pages now (full screen).
enum Cover: Identifiable, Equatable {
    case viewer, remote(String), peerScreen
    var id: String { switch self { case .viewer: return "viewer"; case .peerScreen: return "peerScreen"; case .remote(let m): return "remote." + m } }
}

final class AppUI: ObservableObject {
    static let shared = AppUI()
    @Published var page: Page? = .overview
    @Published var path: [Page] = []
    @Published var cover: Cover?

    // Open a page (on iPhone: over the sidebar).
    func open(_ p: Page) {
        page = p
        if path.last != p { path = [p] }
    }
}

struct RootView: View {
    @EnvironmentObject var core: Core
    @StateObject private var ui = AppUI.shared
    @Environment(\.horizontalSizeClass) private var width
    @State private var dropping = false

    var body: some View {
        layout
            .environmentObject(ui)
            .tint(TDColor.accent)
            .onDrop(of: [.fileURL, .item], isTargeted: $dropping) { providers in
                DropIn.take(providers, core)
                return core.connected
            }
            .overlay { if dropping { DropOverlay(name: core.host?.name, connected: core.connected) } }
            .background(shortcuts)
            .modifier(Covers(ui: ui))
            .modifier(PairPrompts())
    }

    @ViewBuilder
    private var layout: some View {
        if width == .regular { split } else { stack }
    }

    private var stack: some View {
        NavigationStack(path: $ui.path) {
            Sidebar(selection: nil)
                .navigationDestination(for: Page.self) { p in PageView(page: p) }
        }
    }

    private var split: some View {
        NavigationSplitView {
            Sidebar(selection: $ui.page)
                .navigationSplitViewColumnWidth(min: 250, ideal: 280, max: 320)
        } detail: {
            NavigationStack { PageView(page: ui.page ?? .overview) }
        }
        .navigationSplitViewStyle(.balanced)
    }

    // A hardware keyboard (iPad's Magic Keyboard): ⌘1–6 and ⌘, for the pages, ⇧⌘V sends the
    // clipboard, ⇧⌘S shares the screen, ⇧⌘R shows the computer's.
    private var shortcuts: some View {
        ZStack {
            ForEach(Page.allCases.filter { $0.key != nil }) { p in
                Button("") { ui.open(p) }.keyboardShortcut(p.key!, modifiers: .command)
            }
            Button("") { core.clip.sendCurrent(force: true) }.keyboardShortcut("v", modifiers: [.command, .shift])
            Button("") { core.mirror.sharing ? core.mirror.stop() : ShareScreen.open() }.keyboardShortcut("s", modifiers: [.command, .shift])
            Button("") { if core.connected { ui.cover = .viewer } }.keyboardShortcut("r", modifiers: [.command, .shift])
        }
        .opacity(0).allowsHitTesting(false).accessibilityHidden(true)
    }
}

// What comes up over the pages: the computer's screen, the Remote (full screen); it opens the
// viewer by itself when the computer starts sharing.
private struct Covers: ViewModifier {
    @EnvironmentObject var core: Core
    @ObservedObject var ui: AppUI

    func body(content: Content) -> some View {
        content
            .fullScreenCover(item: $ui.cover) { c in cover(c).environmentObject(core) }
            .onChange(of: core.tick) { _ in
                guard core.screen.autoOpen else { return }
                core.screen.autoOpen = false
                if ui.cover == nil && core.connected { ui.cover = .viewer }
            }
    }

    @ViewBuilder
    private func cover(_ c: Cover) -> some View {
        switch c {
        case .viewer: ViewerScreen()
        case .remote(let mode): RemoteScreen(mode: mode)
        case .peerScreen: PeerScreenView()
        }
    }
}

// Pairing (the code to compare) and an invite from a computer.
private struct PairPrompts: ViewModifier {
    @EnvironmentObject var core: Core

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: Binding(get: { core.pair != nil }, set: { if !$0 { core.cancelPairing() } })) {
                PairSheet().environmentObject(core).presentationDetents([.medium])
            }
            .alert(core.invite.map { "\($0.name) wants to connect" } ?? "",
                   isPresented: Binding(get: { core.invite != nil && core.pair == nil }, set: { if !$0 { core.dismissInvite() } })) {
                Button("Pair") { if let f = core.invite { core.pair(f) } }
                Button("Not Now", role: .cancel) { core.dismissInvite() }
            } message: {
                Text("Pair this \(Device.word) with it to share the clipboard, files and screens.")
            }
    }
}

// The sidebar: who we're connected to, then the features.
struct Sidebar: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    var selection: Binding<Page?>?

    var body: some View {
        Group {
            if let sel = selection {
                List(selection: sel) { content }
            } else {
                List { content }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Backdrop())
        .navigationTitle("TwinDesk")
        .navigationBarTitleDisplayMode(selection == nil ? .large : .inline)
        .refreshable { core.discovery.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        Section {
            deviceRow
        }
        ForEach(Array(Page.groups.enumerated()), id: \.offset) { _, group in
            Section {
                ForEach(group) { p in
                    if selection != nil {
                        row(p).tag(Optional(p))
                    } else {
                        NavigationLink(value: p) { row(p) }
                    }
                }
            }
            .listRowBackground(TDColor.card)
        }
    }

    // The connected computer (or the one we'd connect to), as the computers show the phone.
    private var deviceRow: some View {
        Button { ui.open(.connection) } label: {
            HStack(spacing: 14) {
                Image(systemName: osSymbol(core.host?.os ?? (core.hosts.first?.os ?? "mac")))
                    .font(.system(size: 22, weight: .regular)).foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(core.host?.name ?? core.hosts.first?.name ?? "No computer").font(.headline).foregroundStyle(TDColor.text)
                    Text(statusLine).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                Circle().fill(core.connected ? TDColor.good : core.state == "connecting" ? TDColor.warn : Color.secondary.opacity(0.4))
                    .frame(width: 9, height: 9)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(core.connected ? TDColor.accent.opacity(0.18) : TDColor.card)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(core.connected ? TDColor.accent.opacity(0.8) : TDColor.line, lineWidth: 1.5))
        )
    }

    private var statusLine: String {
        switch core.state {
        case "connected":
            return [core.link.wired ? "USB" : core.link.viaBle ? "Bluetooth" : Discovery.hasEthernet ? "Ethernet" : "Wi-Fi", core.rttMs.map { "\($0) ms" }].compactMap { $0 }.joined(separator: " · ")
        case "connecting": return "Connecting…"
        default: return core.hosts.isEmpty ? "Tap to pair a computer" : "Not connected · Tap to connect"
        }
    }

    private func row(_ p: Page) -> some View {
        HStack(spacing: 12) {
            FeatureIcon(symbol: p.icon, color: p.color)
            Text(p.title).foregroundStyle(TDColor.text)
            Spacer()
            if inUse(p) { Circle().fill(TDColor.good).frame(width: 8, height: 8) }
        }
        .padding(.vertical, 1)
    }

    private func inUse(_ p: Page) -> Bool {
        _ = core.tick
        if p == .phones { return core.peer.connected }
        guard core.connected else { return false }
        switch p {
        case .receive: return core.screen.viewing
        case .share: return core.mirror.sharing
        case .remote: return core.remote.active || core.remote.controllerName != nil
        case .clipboard: return core.sync.get("clipboard", "in") || core.sync.get("clipboard", "out")
        case .notifications: return core.sync.get("notifs", "in")
        case .files: return core.files.batches.contains { !$0.finished }
        case .photos: return core.hub.mediaOn || core.hub.filesOn
        case .audio: return core.sound.playing
        case .camera: return core.camera.on
        case .media: return core.media.now?.playing == true
        default: return false
        }
    }
}

// One page by name.
struct PageView: View {
    let page: Page
    var body: some View {
        switch page {
        case .overview: OverviewView()
        case .connection: ConnectionView()
        case .phones: PhonesView()
        case .receive: ReceiveScreenView()
        case .share: ShareScreenView()
        case .remote: RemoteView()
        case .clipboard: ClipboardView()
        case .notifications: NotificationsView()
        case .files: FilesView()
        case .photos: PhotosView()
        case .audio: AudioView()
        case .camera: CameraView()
        case .media: MediaView()
        case .airplay: AirPlayView()
        case .shortcuts: ShortcutsView()
        case .general: SettingsView()
        case .about: AboutView()
        }
    }
}

struct PairSheet: View {
    @EnvironmentObject var core: Core

    var body: some View {
        let p = core.pair
        VStack(spacing: 22) {
            Image(systemName: p?.phase == "failed" ? "exclamationmark.triangle" : "lock.shield")
                .font(.system(size: 34, weight: .semibold)).glassChip(72, tint: p?.phase == "failed" ? .orange : .blue)
            Text(p?.name ?? "").font(.title2.bold())
            switch p?.phase ?? "" {
            case "code":
                Text("Check that \(p?.name ?? "the computer") shows this code").foregroundStyle(.secondary).multilineTextAlignment(.center)
                Text(spaced(p?.code ?? "")).font(.system(size: 44, weight: .bold, design: .rounded)).monospacedDigit()
                HStack(spacing: 14) {
                    Button("Cancel", role: .cancel) { core.cancelPairing() }.secondaryButton()
                    Button("They Match") { core.confirmCode() }.primaryButton()
                }
            case "waiting":
                ProgressView()
                Text(p?.qr == true ? "Click Allow on \(p?.name ?? "the computer")." : "Confirm the code on \(p?.name ?? "the computer") too.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("Cancel", role: .cancel) { core.cancelPairing() }.secondaryButton()
            case "failed":
                Text(p?.error ?? "").multilineTextAlignment(.center).foregroundStyle(.secondary)
                Button("Close") { core.cancelPairing() }.primaryButton()
            default:
                ProgressView()
                Text("Connecting…").foregroundStyle(.secondary)
                Button("Cancel", role: .cancel) { core.cancelPairing() }.secondaryButton()
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Backdrop())
    }

    private func spaced(_ c: String) -> String { c.count == 6 ? "\(c.prefix(3)) \(c.suffix(3))" : c }
}
