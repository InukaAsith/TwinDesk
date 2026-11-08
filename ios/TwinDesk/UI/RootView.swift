// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Four sections (tabs or a sidebar, Liquid Glass on iOS 26 by themselves) and the sheets that come
// up over them: pairing (the code to compare) and an invite from a computer.
import SwiftUI
import UniformTypeIdentifiers

enum Page: String, CaseIterable, Identifiable {
    case devices, clipboard, files, settings
    var id: String { rawValue }
    var title: String { ["devices": "Devices", "clipboard": "Clipboard", "files": "Files", "settings": "Settings"][rawValue]! }
    var icon: String { ["devices": "laptopcomputer.and.iphone", "clipboard": "doc.on.clipboard", "files": "folder", "settings": "gearshape"][rawValue]! }
    var key: KeyEquivalent { ["devices": "1", "clipboard": "2", "files": "3", "settings": "4"][rawValue]! }
}

// Tabs on a narrow screen (iPhone, iPad in Slide Over or a small Stage Manager window); a sidebar
// on a wide one (iPad, iPhone Max in landscape). Files dropped anywhere on it go to the computer.
struct RootView: View {
    @EnvironmentObject var core: Core
    @Environment(\.horizontalSizeClass) private var width
    @State private var section: Page? = .devices
    @State private var dropping = false

    var body: some View {
        Group {
            if width == .regular { split } else { tabs }
        }
        .onDrop(of: [.fileURL, .item], isTargeted: $dropping) { providers in
            DropIn.take(providers, core)
            return core.connected
        }
        .overlay { if dropping { DropOverlay(name: core.host?.name, connected: core.connected) } }
        .background(shortcuts)
        .sheet(isPresented: Binding(get: { core.pair != nil }, set: { if !$0 { core.cancelPairing() } })) {
            PairSheet().environmentObject(core).presentationDetents([.medium])
        }
        .alert(core.invite.map { "\($0.name) wants to connect" } ?? "",
               isPresented: Binding(get: { core.invite != nil && core.pair == nil }, set: { if !$0 { core.dismissInvite() } })) {
            Button("Pair") { if let f = core.invite { core.pair(f) } }
            Button("Not Now", role: .cancel) { core.dismissInvite() }
        } message: {
            Text("Pair this \(Device.word) with it to share the clipboard and files.")
        }
    }

    private var tabs: some View {
        TabView(selection: Binding(get: { section ?? .devices }, set: { section = $0 })) {
            ForEach(Page.allCases) { s in page(s).tabItem { Label(s.title, systemImage: s.icon) }.tag(s) }
        }
    }

    private var split: some View {
        NavigationSplitView {
            List(selection: $section) {
                ForEach(Page.allCases) { s in
                    Label(s.title, systemImage: s.icon).tag(s)
                }
                if core.connected, let h = core.host {
                    Section("Connected") {
                        Label(h.name, systemImage: osSymbol(h.os))
                        if let ms = core.rttMs { Text("\(ms) ms").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            .navigationTitle("TwinDesk")
            .navigationSplitViewColumnWidth(min: 220, ideal: 250, max: 300)
        } detail: {
            page(section ?? .devices)
        }
    }

    @ViewBuilder
    private func page(_ s: Page) -> some View {
        switch s {
        case .devices: HomeView()
        case .clipboard: ClipboardView()
        case .files: FilesView()
        case .settings: SettingsView()
        }
    }

    // A hardware keyboard (iPad's Magic Keyboard): ⌘1–4 for the sections, ⇧⌘V sends the clipboard.
    private var shortcuts: some View {
        ZStack {
            ForEach(Page.allCases) { s in
                Button("") { section = s }.keyboardShortcut(s.key, modifiers: .command)
            }
            Button("") { core.clip.sendCurrent(force: true) }.keyboardShortcut("v", modifiers: [.command, .shift])
            Button("") { core.mirror.sharing ? core.mirror.stop() : ShareScreen.open() }.keyboardShortcut("s", modifiers: [.command, .shift])
        }
        .opacity(0).allowsHitTesting(false).accessibilityHidden(true)
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
