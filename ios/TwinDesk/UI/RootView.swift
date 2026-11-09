// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The app as the computers lay theirs out: a sidebar of features (each a coloured icon, a green dot
// while it's in use), the connected computer at the top, on iPad. On every iPhone a tab bar as Android's (Liquid Glass on iOS 26): Overview, Connect, Screen, Files, and More
// with the rest as the sidebar lists them.
// Over everything: the computer's screen and the Remote (full screen), pairing, an invite.
import SwiftUI
import UniformTypeIdentifiers

enum Page: String, CaseIterable, Identifiable, Hashable {
    case overview, connection, receive, share, remote, clipboard, notifications, files, photos, messages, audio, camera, media, airplay, shortcuts, general, about
    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return tr("Overview")
        case .connection: return tr("Connection")
        case .receive: return tr("Receive screen")
        case .share: return tr("Share screen")
        case .remote: return tr("Remote")
        case .clipboard: return tr("Clipboard")
        case .notifications: return tr("Notifications")
        case .files: return tr("File Sharing")
        case .photos: return tr("Photos")
        case .messages: return tr("Messages")
        case .audio: return tr("Audio")
        case .camera: return tr("Camera")
        case .media: return tr("Media")
        case .airplay: return tr("AirPlay & SMB")
        case .shortcuts: return tr("Shortcuts")
        case .general: return tr("General")
        case .about: return tr("About")
        }
    }

    var icon: String {
        switch self {
        case .overview: return "house.fill"
        case .connection: return "link"
        case .receive: return "display"
        case .share: return "rectangle.on.rectangle"
        case .remote: return "gamecontroller.fill"
        case .clipboard: return "doc.on.clipboard.fill"
        case .notifications: return "bell.fill"
        case .files: return "folder.fill"
        case .photos: return "photo.fill.on.rectangle.fill"
        case .messages: return "message.fill"
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
        case .messages: return TDColor.good
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
        [.overview, .connection],
        [.receive, .share, .remote],
        [.clipboard, .notifications, .files, .photos, .messages],
        [.audio, .camera, .media],
        [.airplay, .shortcuts],
        [.general, .about],
    ]

    // iPhone's tab bar: these as tabs, everything else under More.
    static let bottom: [Page] = [.overview, .connection, .receive, .files]
    var tabTitle: String {
        switch self {
        case .connection: return tr("Connect")
        case .receive: return tr("Screen")
        case .files: return tr("Files")
        default: return title
        }
    }

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

// iPhone's tabs: a page of its own, or More (the rest, as a list).
enum PhoneTab: Hashable { case page(Page), more }

final class AppUI: ObservableObject {
    static let shared = AppUI()
    @Published var page: Page? = .overview      // iPad: the sidebar's
    @Published var tab: PhoneTab = .page(.overview) // iPhone: the tab bar's
    @Published var paths: [PhoneTab: [Page]] = [:] // iPhone: what's open over each tab
    @Published var cover: Cover?

    // Open a page: iPad, in the sidebar. iPhone: a tab's own page, that tab (at its root); any
    // other, over the tab that's open, so Back returns to where it was opened from.
    func open(_ p: Page) {
        page = p
        if Page.bottom.contains(p) { tab = .page(p); paths[tab] = [] }
        else if paths[tab]?.last != p { paths[tab, default: []].append(p) }
    }

    func path(_ t: PhoneTab) -> Binding<[Page]> {
        Binding(get: { self.paths[t] ?? [] }, set: { self.paths[t] = $0 })
    }
}

struct RootView: View {
    @EnvironmentObject var core: Core
    @StateObject private var ui = AppUI.shared
    @Environment(\.horizontalSizeClass) private var width
    @State private var dropping = false
    @AppStorage(Accent.key) private var accent = ""

    var body: some View {
        layout
            // A new accent: everything drawn again in it (the page open stays: AppUI keeps it).
            .id(accent)
            .environmentObject(ui)
            .tint(TDColor.accent)
            .onDrop(of: [.fileURL, .item], isTargeted: $dropping) { providers in
                DropIn.take(providers, core)
                return core.connected
            }
            .overlay { if dropping { DropOverlay(name: core.host?.name, connected: core.connected) } }
            .background(shortcuts)
            .modifier(Covers(ui: ui))
            .sheet(isPresented: Binding(get: { _ = core.tick; return core.mirror.asking && core.pair == nil && ui.cover == nil },
                                        set: { if !$0 && core.mirror.asking { core.mirror.decline() } })) {
                MirrorAskSheet().environmentObject(core).presentationDetents([.large])
            }
            .modifier(PairPrompts())
    }

    @ViewBuilder
    private var layout: some View {
        // The sidebar only on an iPad (in Slide Over or a narrow split, the tab bar); every iPhone,
        // a Max sideways too, keeps the tab bar.
        if UIDevice.current.userInterfaceIdiom == .pad && width == .regular { split } else { stack }
    }

    // iPhone: the tab bar (with a phone holding the session, only the tabs it can do).
    private var stack: some View {
        let _ = core.tick
        let tabs = Page.bottom.filter { !core.peerMode || peerShows($0, core.peer) }
        return TabView(selection: Binding(get: { ui.tab }, set: { t in
            // A tab tapped again: back to its root.
            if t == ui.tab { ui.paths[t] = [] }
            ui.tab = t
            if case .page(let p) = t { ui.page = p }
        })) {
            ForEach(tabs) { p in
                NavigationStack(path: ui.path(.page(p))) {
                    PageView(page: p)
                        .environment(\.branded, p == .overview) // the tab's own page only
                        .navigationDestination(for: Page.self) { q in PageView(page: q).environment(\.branded, false) }
                }
                .tabItem { Label(p.tabTitle, systemImage: tabIcon(p)) }
                .tag(PhoneTab.page(p))
            }
            NavigationStack(path: ui.path(.more)) {
                Sidebar(selection: nil, hiding: tabs)
                    .navigationDestination(for: Page.self) { p in PageView(page: p) }
            }
            .tabItem { Label(tr("More"), systemImage: "ellipsis") }
            .tag(PhoneTab.more)
        }
        .modifier(TabBarGlass())
        // A tab that's gone (a phone that can't do it): Overview.
        .onChange(of: tabs) { t in if case .page(let p) = ui.tab, !t.contains(p) { ui.tab = .page(.overview) } }
    }

    // Line icons in the bar, as Android's (the sidebar keeps the filled, coloured ones).
    private func tabIcon(_ p: Page) -> String {
        switch p {
        case .overview: return "house"
        case .connection: return "link"
        case .receive: return "display"
        case .files: return "folder"
        default: return p.icon
        }
    }

    private var split: some View {
        NavigationSplitView {
            Sidebar(selection: $ui.page)
                .navigationSplitViewColumnWidth(min: 250, ideal: 280, max: 320)
        } detail: {
            NavigationStack { PageView(page: ui.page ?? .overview) }.id(ui.page)
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
            // AppUI too: the viewer's and the Remote's Close set ui.cover (without it, a crash). The cover
            // is presented from here, outside RootView's .environmentObject(ui).
            .fullScreenCover(item: $ui.cover) { c in cover(c).environmentObject(core).environmentObject(ui) }
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
            .alert(core.invite.map { tr("{name} wants to connect", ["name": $0.name]) } ?? "",
                   isPresented: Binding(get: { core.invite != nil && core.pair == nil }, set: { if !$0 { core.dismissInvite() } })) {
                Button(tr("Pair")) { if let f = core.invite { core.pair(f) } }
                Button(tr("Not Now"), role: .cancel) { core.dismissInvite() }
            } message: {
                Text(tr("Pair this {device} with it to share the clipboard, files and screens.", ["device": Device.word]))
            }
            // A phone (Android or iPhone) pairing with this one, or asking it to host: a popup on any
            // page, not only the card at the bottom of Connection. Swiping the sheet away denies.
            .sheet(isPresented: Binding(get: { _ = core.tick; return core.peer.hostPairing != nil && core.pair == nil },
                                        set: { if !$0, core.peer.hostPairing != nil { core.peer.respondPair(false) } })) {
                if let p = core.peer.hostPairing {
                    PeerPairAsk(p: p).padding(24).environmentObject(core).presentationDetents([.medium])
                }
            }
            .alert(core.peer.asked.map { tr("{name} wants to connect", ["name": $0.name]) } ?? "",
                   isPresented: Binding(get: { _ = core.tick; return core.peer.asked != nil && core.peer.hostPairing == nil && core.pair == nil },
                                        set: { if !$0, core.peer.asked != nil { core.peer.answerAsk(false) } })) {
                Button(tr("Allow")) { core.peer.answerAsk(true) }
                Button(tr("Not Now"), role: .cancel) { core.peer.answerAsk(false) }
            } message: {
                Text(tr("Let it connect to this {device}?", ["device": Device.word]))
            }
    }
}

// iOS 26: the Liquid Glass tab bar shrinks to its selected tab while a page scrolls down.
private struct TabBarGlass: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) { content.tabBarMinimizeBehavior(.onScrollDown) } else { content }
    }
}

// iPad: TwinDesk's mark, name and state in the sidebar's bar (beside its button), no glass pill
// around them on iOS 26.
private struct BrandBar: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if !on { content }
        else if #available(iOS 26.0, *) {
            content.toolbar { ToolbarItem(placement: .navigationBarLeading) { BrandHeader(compact: true) }.sharedBackgroundVisibility(.hidden) }
        } else {
            content.toolbar { ToolbarItem(placement: .navigationBarLeading) { BrandHeader(compact: true) } }
        }
    }
}

// The sidebar: who we're connected to, then the features.
struct Sidebar: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    var selection: Binding<Page?>?
    var hiding: [Page] = [] // iPhone's More: the pages that have tabs left out

    var body: some View {
        // No List(selection:) on iPad: its rows only answer when a row's tag is exactly the
        // selection's type, and a mismatch leaves every row dead. Plain buttons always answer.
        List { content }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Backdrop())
        // iPhone's More: a large title. iPad: TwinDesk's own header (the mark, the name, the state)
        // in the bar, beside the sidebar's button.
        .navigationTitle(selection == nil ? tr("More") : "")
        .navigationBarTitleDisplayMode(selection == nil ? .large : .inline)
        .modifier(BrandBar(on: selection != nil)) // iPad: the mark and name in the bar, level with the sidebar button
        .refreshable { core.discovery.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        // The header and the connected device as the section's header, not its rows: an inset
        // grouped section clips its rows to its own (large, on iOS 26) corners, which cut the card's.
        Section {
        } header: {
            deviceRow
            .textCase(nil)
            .padding(.top, selection == nil ? 4 : 8)
            .padding(.bottom, 4)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        }
        // The other paired computers and phones nearby, as the computers' sidebars list them: tap to connect.
        let near = nearbyPaired
        if !near.isEmpty {
            Section {
                ForEach(near, id: \.id) { d in
                    Button { d.go() } label: {
                        HStack(spacing: 12) {
                            Image(systemName: d.symbol).font(.system(size: 17)).foregroundStyle(.secondary).frame(width: 30)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(d.name).foregroundStyle(TDColor.text)
                                Text(d.sub).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressScale())
                    .listRowBackground(TDColor.card)
                }
            } header: { Text(tr("Nearby")) }
        }
        // With a phone: only what it and this one can do (PeerViews' peerShows); Messages only then.
        let groups = Page.groups.map { g in g.filter { !hiding.contains($0) && (core.peerMode ? peerShows($0, core.peer) : $0 != .messages) } }.filter { !$0.isEmpty }
        ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
            Section {
                ForEach(group) { p in
                    if let sel = selection {
                        Button { withAnimation(.easeOut(duration: 0.18)) { sel.wrappedValue = p; ui.open(p) } } label: { row(p).contentShape(Rectangle()) }
                            .buttonStyle(PressScale())
                            .hoverLift()
                            .listRowBackground(sel.wrappedValue == p ? TDColor.accent.opacity(0.35) : TDColor.card)
                    } else {
                        NavigationLink(value: p) { row(p) }
                            .listRowBackground(TDColor.card)
                    }
                }
            }
        }
    }

    // The connected computer (or the one we'd connect to), as the computers show the phone.
    private var deviceRow: some View {
        // A phone holds the session: that phone in its place.
        let phone = core.peerMode ? core.peer : nil
        let live = core.connected || phone != nil
        // Overview (it shows the link, Disconnect or Connect); Connection only while nothing is paired yet.
        return Button { ui.open(core.hosts.isEmpty && !live ? .connection : .overview) } label: {
            HStack(spacing: 14) {
                Image(systemName: phone.map { $0.peerOs == "ios" ? "iphone" : "iphone.gen2" } ?? osSymbol(core.host?.os ?? (core.hosts.first?.os ?? "mac")))
                    .font(.system(size: 22, weight: .regular)).foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(phone?.peerName ?? core.host?.name ?? core.hosts.first?.name ?? tr("No computer")).font(.headline).foregroundStyle(TDColor.text)
                    Text(phone != nil ? tr("Phone · Connected") : statusLine).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                if live { LiveDot(size: 9) }
                else { Circle().fill(core.state == "connecting" ? TDColor.warn : Color.secondary.opacity(0.4)).frame(width: 9, height: 9) }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 14)
            // The card is the row's own (not the list's row background, whose section corners cut
            // its border off): inset by the stroke's width so all four corners show.
            .background {
                let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
                ZStack {
                    shape.fill(live ? TDColor.accent.opacity(0.18) : TDColor.card)
                    shape.strokeBorder(live ? TDColor.accent.opacity(0.8) : TDColor.line, lineWidth: 1.5)
                }
                .padding(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScale())
        .hoverLift()
    }

    // Paired, nearby and not the one in the card above (the connected one, else the first computer).
    private struct NearDev { let id: String; let name: String; let symbol: String; let sub: String; let go: () -> Void }
    private var nearbyPaired: [NearDev] {
        _ = core.tick
        let phone = core.peerMode ? core.peer : nil
        let shown = phone?.peerId ?? core.host?.id ?? (core.connected ? nil : core.hosts.first?.id)
        var list: [NearDev] = []
        for h in core.hosts where h.id != shown && core.host?.id != h.id && (core.nearby.contains(where: { $0.id == h.id }) || core.ble.has(h.id)) {
            let connecting = core.state == "connecting" && core.link.host?.id == h.id
            list.append(NearDev(id: h.id, name: h.name, symbol: osSymbol(h.os), sub: connecting ? tr("Connecting…") : tr("Nearby · Tap to connect")) { core.connect(h) })
        }
        if core.peer.on {
            for f in core.peer.nearby() where f.id != shown && core.peer.isPaired(f.id) && !(core.peer.connected && core.peer.peerId == f.id) {
                list.append(NearDev(id: f.id, name: f.name, symbol: f.os == "ios" ? "iphone" : "iphone.gen2",
                                    sub: core.peer.waitingFor == f.id ? tr("Requesting connection…") : tr("Nearby · Tap to connect")) { core.peer.connect(f) })
            }
        }
        return list
    }

    private var statusLine: String {
        switch core.state {
        case "connected":
            return [core.link.wired ? "USB" : core.link.viaBle ? tr("Bluetooth") : Discovery.hasEthernet ? tr("Ethernet") : "Wi-Fi", core.rttMs.map { "\($0) ms" }].compactMap { $0 }.joined(separator: " · ")
        case "connecting": return tr("Connecting…")
        default: return core.hosts.isEmpty ? tr("Tap to pair a computer") : tr("Not connected · Tap to connect")
        }
    }

    private func row(_ p: Page) -> some View {
        HStack(spacing: 12) {
            FeatureIcon(symbol: p.icon, color: p.color)
            Text(p.title).foregroundStyle(TDColor.text)
            Spacer()
            if inUse(p) { LiveDot().transition(.scale.combined(with: .opacity)) }
        }
        .padding(.vertical, 1)
    }

    private func inUse(_ p: Page) -> Bool {
        _ = core.tick
        if core.peerMode {
            switch p {
            case .connection: return true
            case .share: return core.mirror.sharing
            case .clipboard: return core.peer.clipOn
            case .notifications: return core.peer.notifsOn
            case .files: return !core.peer.batches.isEmpty
            default: return false
            }
        }
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
    @EnvironmentObject var core: Core
    let page: Page
    var body: some View {
        let _ = core.tick
        if core.peerMode && ![.connection, .general, .about].contains(page) { PeerPageView(page: page) }
        else { pc }
    }

    @ViewBuilder
    private var pc: some View {
        switch page {
        case .overview: OverviewView()
        case .connection: ConnectionView()
        case .receive: ReceiveScreenView()
        case .share: ShareScreenView()
        case .remote: RemoteView()
        case .clipboard: ClipboardView()
        case .notifications: NotificationsView()
        case .files: FilesView()
        case .photos: PhotosView()
        case .messages: PeerThreadsView() // only a phone's (the sidebar hides it otherwise)
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
                Text(tr("Check that {name} shows this code", ["name": p?.name ?? tr("the computer")])).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Text(spaced(p?.code ?? "")).font(.system(size: 44, weight: .bold, design: .rounded)).monospacedDigit()
                HStack(spacing: 14) {
                    Button(tr("Cancel"), role: .cancel) { core.cancelPairing() }.secondaryButton()
                    Button(tr("They Match")) { core.confirmCode() }.primaryButton()
                }
            case "waiting":
                ProgressView()
                Text(p?.qr == true ? tr("Click Allow on {name}.", ["name": p?.name ?? tr("the computer")]) : tr("Confirm the code on {name} too.", ["name": p?.name ?? tr("the computer")]))
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button(tr("Cancel"), role: .cancel) { core.cancelPairing() }.secondaryButton()
            case "failed":
                Text(p?.error ?? "").multilineTextAlignment(.center).foregroundStyle(.secondary)
                Button(tr("Close")) { core.cancelPairing() }.primaryButton()
            default:
                ProgressView()
                Text(tr("Connecting…")).foregroundStyle(.secondary)
                Button(tr("Cancel"), role: .cancel) { core.cancelPairing() }.secondaryButton()
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Backdrop())
    }

    private func spaced(_ c: String) -> String { c.count == 6 ? "\(c.prefix(3)) \(c.suffix(3))" : c }
}
