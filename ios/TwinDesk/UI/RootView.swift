// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Four tabs (the tab bar is Liquid Glass on iOS 26 by itself) and the sheets that come up over
// them: pairing (the code to compare) and an invite from a computer.
import SwiftUI

struct RootView: View {
    @EnvironmentObject var core: Core

    var body: some View {
        TabView {
            HomeView().tabItem { Label("Devices", systemImage: "laptopcomputer.and.iphone") }
            ClipboardView().tabItem { Label("Clipboard", systemImage: "doc.on.clipboard") }
            FilesView().tabItem { Label("Files", systemImage: "folder") }
            SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .sheet(isPresented: Binding(get: { core.pair != nil }, set: { if !$0 { core.cancelPairing() } })) {
            PairSheet().environmentObject(core).presentationDetents([.medium])
        }
        .alert(core.invite.map { "\($0.name) wants to connect" } ?? "",
               isPresented: Binding(get: { core.invite != nil && core.pair == nil }, set: { if !$0 { core.dismissInvite() } })) {
            Button("Pair") { if let f = core.invite { core.pair(f) } }
            Button("Not Now", role: .cancel) { core.dismissInvite() }
        } message: {
            Text("Pair this iPhone with it to share the clipboard and files.")
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
