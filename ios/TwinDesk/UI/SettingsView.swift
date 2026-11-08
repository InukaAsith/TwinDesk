// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Settings: this iPhone's name, staying connected in the background, notifications, and about.
import SwiftUI
import UIKit
import CoreLocation

struct SettingsView: View {
    @EnvironmentObject var core: Core
    @State private var name = Store.shared.deviceName

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    SectionTitle(text: "This iPhone")
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("Name", text: $name).font(.title3.weight(.semibold))
                            .onSubmit { core.rename(name) }
                        Text("How the computers list it. iOS doesn’t tell apps the name you gave the phone.").font(.caption).foregroundStyle(.secondary)
                    }
                    .glassCard()

                    SectionTitle(text: "Background")
                    VStack(alignment: .leading, spacing: 12) {
                        ToggleRow(title: "Stay connected", detail: "Keeps the session while TwinDesk isn’t on screen", on: bg("bg.on"))
                        Divider()
                        ToggleRow(title: "Use location", detail: locationDetail, on: bg("bg.location"))
                        if needsLocation {
                            Button("Allow Location") { Background.shared.askLocation() }.secondaryButton()
                        }
                        Divider()
                        ToggleRow(title: "Use silent audio", detail: "Plays silence alongside your music", on: bg("bg.audio"))
                        Divider()
                        ToggleRow(title: "Reconnect on its own", detail: "To the last computer, when TwinDesk wakes", on: flag("autoConnect"))
                        Text("Either keeps TwinDesk running; both is the most reliable. Each uses some battery.").font(.caption).foregroundStyle(.secondary)
                    }
                    .glassCard()

                    SectionTitle(text: "Notifications")
                    VStack(spacing: 12) {
                        ToggleRow(title: "The computer’s notifications", detail: "Shown here while connected", on: sync("notifs", "in"))
                        Divider()
                        Button("Notification Settings") {
                            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
                        }
                        .secondaryButton().frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .glassCard()

                    SectionTitle(text: "About")
                    VStack(alignment: .leading, spacing: 6) {
                        Text("TwinDesk \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")").font(.headline)
                        Text("GPL-3.0 · github.com/InukaAsith/TwinDesk").font(.caption).foregroundStyle(.secondary)
                        Text("ID \(core.store.deviceId.prefix(8))").font(.caption2.monospaced()).foregroundStyle(.tertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard()
                }
                .padding(.horizontal, 16).padding(.bottom, 30)
            }
            .background(Backdrop())
            .navigationTitle("Settings")
            .onDisappear { if name != core.store.deviceName { core.rename(name) } }
        }
    }

    private var needsLocation: Bool {
        let s = Background.shared.authorization
        return s == .notDetermined || s == .denied || (s == .authorizedWhenInUse && ProcessInfo.processInfo.operatingSystemVersion.majorVersion < 17)
    }

    private var locationDetail: String {
        switch Background.shared.authorization {
        case .authorizedAlways: return "Allowed · the blue pill shows while it runs"
        case .authorizedWhenInUse: return ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 17 ? "Allowed · the blue pill shows while it runs" : "Needs Always on iOS 16"
        case .denied, .restricted: return "Not allowed · Settings › TwinDesk › Location"
        default: return "Cell and Wi-Fi only, no GPS"
        }
    }

    private func bg(_ k: String) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.store.flag(k, true) }, set: { Background.shared.set(k, $0) })
    }

    private func flag(_ k: String) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.store.flag(k, true) }, set: { core.store.setFlag(k, $0); core.changed() })
    }

    private func sync(_ f: String, _ d: String) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.sync.get(f, d) }, set: { core.sync.set(f, d, $0) })
    }
}
