// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General: this iPhone's name, staying connected in the background, the USB cable, and what
// TwinDesk is allowed to use (each with its state, Allow while iOS can still ask, else Settings).
import SwiftUI
import CoreBluetooth
import UIKit
import CoreLocation
import Photos
import AVFoundation
import UserNotifications

struct SettingsView: View {
    @EnvironmentObject var core: Core
    @State private var name = Store.shared.deviceName
    @State private var notifs: UNAuthorizationStatus = .notDetermined
    @AppStorage("appearance") private var appearance = Appearance.system.rawValue

    var body: some View {
        PageScroll(title: "General") {
            // One column on every screen: settings read top to bottom, as the computers' General.
            VStack(spacing: 16) {
                // What TwinDesk may use, first: what's missing is the first thing seen.
                SectionTitle(text: "Permissions")
                VStack(spacing: 0) {
                    perm("bell.fill", Page.notifications.color, "Notifications", "Notifications, clipboard and file alerts from the computer", notifState) { askNotifications() }
                    Divider().padding(.leading, 46)
                    perm("location.fill", TDColor.accent, "Location", "Keeps TwinDesk running in the background", locationState) { Background.shared.askLocation() }
                    Divider().padding(.leading, 46)
                    perm("dot.radiowaves.left.and.right", Color.blue, "Bluetooth", "Connection when not on the same Wi-Fi", bleState) { core.ble.setOn(true) }
                    Divider().padding(.leading, 46)
                    perm("photo.fill", Page.photos.color, "Photos", "Sending photos and browsing them from the computer", photosState) { core.hub.askPhotos() }
                    Divider().padding(.leading, 46)
                    perm("camera.fill", Page.camera.color, "Camera", "Using this camera on the computer", avState(.video)) { AVCaptureDevice.requestAccess(for: .video) { _ in DispatchQueue.main.async { core.changed() } } }
                    Divider().padding(.leading, 46)
                    perm("mic.fill", Page.audio.color, "Microphone", "Using this microphone on the computer", avState(.audio)) { AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { core.changed() } } }
                    Divider().padding(.leading, 46)
                    perm("network", TDColor.good, "Local Network", "Finding computers on this network", core.nearby.isEmpty && !core.connected ? .unknown : .ok) {}
                }
                .glassCard()
                Button("Open TwinDesk’s Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
                    .secondaryButton().frame(maxWidth: .infinity, alignment: .leading)
                Text("Apps can’t check Local Network access. If no computer appears, check Settings › TwinDesk › Local Network. Set Paste from Other Apps to Allow so iOS doesn’t ask each time the clipboard is sent.")
                    .font(.caption).foregroundStyle(.secondary)

                SectionTitle(text: "Appearance")
                VStack(alignment: .leading, spacing: 10) {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(Appearance.allCases) { a in Text(a.title).tag(a.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    Text("Automatic follows this \(Device.word)’s light or dark setting").font(.caption).foregroundStyle(.secondary)
                    Divider()
                    Text("Accent colour").font(.subheadline.weight(.semibold))
                    AccentPicker()
                    Text("Used for buttons, switches and the background").font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()

                SectionTitle(text: "Device name")
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Name", text: $name).font(.title3.weight(.semibold))
                        .onSubmit { core.rename(name) }
                    Text("How other devices see this one").font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()

                SectionTitle(text: "Synced with \(core.host?.name ?? core.hosts.first?.name ?? "the computer")")
                VStack(alignment: .leading, spacing: 12) {
                    ToggleRow(title: "Send clipboard", detail: "Copies on this \(Device.word) are available on the computer", on: sync("clipboard", "out"))
                    Divider()
                    ToggleRow(title: "Receive clipboard", detail: "Copies on the computer are available on this \(Device.word)", on: sync("clipboard", "in"))
                    Divider()
                    ToggleRow(title: "Show notifications", detail: "The computer’s notifications on this \(Device.word)", on: sync("notifs", "in"))
                    Divider()
                    ToggleRow(title: "Play the computer’s sound", detail: "Audio from the computer plays on this \(Device.word)", on: sync("audio", "in"))
                    Divider()
                    ToggleRow(title: "Remote control", detail: "The touchpad, keyboard and gamepad control the computer", on: sync("remote", "out"))
                    Divider()
                    ToggleRow(title: "Send files", detail: "The computer accepts files and photos from this \(Device.word)", on: sync("files", "out"))
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Playback of shared screens")
                        Picker("Playback", selection: Binding<String>(get: { _ = core.tick; return core.sync.value("pace") }, set: { (v: String) in core.sync.setValue("pace", v as Any) })) {
                            Text("Fastest").tag("fast")
                            Text("Smooth").tag("smooth")
                            Text("Steady").tag("steady")
                        }
                        .pickerStyle(.segmented)
                        Text(paceDetail).font(.caption).foregroundStyle(.secondary)
                    }
                    Text(core.connected ? "Synced with the computer: a change on either device applies to both. Saved for each computer." : "Available while connected. Saved for each computer.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .disabled(!core.connected)
                .glassCard()

                SectionTitle(text: "Background")
                VStack(alignment: .leading, spacing: 12) {
                    ToggleRow(title: "Stay connected", detail: "Keeps the connection in the background", on: bg("bg.on"))
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        Text("When TwinDesk is in the background")
                        Picker("When TwinDesk is in the background", selection: Binding<String>(get: { _ = core.tick; return core.store.string("bg.mode", "ble") }, set: { (v: String) in core.store.setString("bg.mode", v); core.changed() })) {
                            Text("Bluetooth").tag("ble")
                            Text("Wi-Fi").tag("wifi")
                        }
                        .pickerStyle(.segmented)
                        Text(core.store.string("bg.mode", "ble") == "ble"
                             ? "The connection moves to Bluetooth when TwinDesk leaves the screen and back to Wi-Fi when it opens. Uses the least battery and survives the screen locking."
                             : "The connection stays on Wi-Fi while iOS keeps TwinDesk running, usually while the screen is on. Bluetooth restores it if Wi-Fi drops.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .disabled(!core.store.flag("bg.on", true))
                    Divider()
                    Text("Keep TwinDesk running with").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    ToggleRow(title: "Location", detail: locationDetail, on: bg("bg.location", false))
                    Divider()
                    ToggleRow(title: "Silent audio", detail: "Plays silent audio alongside other audio", on: bg("bg.audio", false))
                    Divider()
                    ToggleRow(title: "Reconnect automatically", detail: "To the last computer when TwinDesk resumes", on: flag("autoConnect"))
                    Text("iOS suspends apps shortly after they leave the screen. These options keep TwinDesk running in the background for transfers, Share Screen and files, at some cost in battery.").font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()

                SectionTitle(text: "Network and Bluetooth")
                VStack(alignment: .leading, spacing: 12) {
                    ToggleRow(title: "USB", detail: "Moves the connection to the USB cable when one is plugged in", on: flag("usb.auto"))
                    Divider()
                    ToggleRow(title: "Bluetooth", detail: bleDetail, on: Binding(get: { _ = core.tick; return core.ble.on }, set: { core.ble.setOn($0) }))
                    Divider()
                    ToggleRow(title: "Prioritize performance over battery life", detail: core.performance ? "Checks the connection every second, even when nothing is in use" : "Checks an idle connection every few minutes, and immediately when a feature starts", on: Binding(get: { _ = core.tick; return core.performance }, set: { core.performance = $0 }))
                    Divider()
                    ToggleRow(title: "Reconnect in the background", detail: core.reconnectBg ? "Restores a dropped connection while TwinDesk is in the background" : "Restores a dropped connection when TwinDesk opens", on: Binding(get: { _ = core.tick; return core.reconnectBg }, set: { core.reconnectBg = $0 }))
                }
                .glassCard()

            }
        }
        .onAppear { refreshNotifs() }
        .onDisappear { if name != core.store.deviceName { core.rename(name) } }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in refreshNotifs(); core.changed() }
    }

    private func sync(_ f: String, _ d: String) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.sync.get(f, d) }, set: { core.sync.set(f, d, $0) })
    }

    private var paceDetail: String {
        switch core.sync.value("pace") {
        case "smooth": return "Even motion, about one frame later"
        case "steady": return "The steadiest motion, paced as a web browser plays it, a few frames later"
        default: return "Each frame the moment it arrives"
        }
    }

    enum PermState { case ok, partial, ask, denied, unknown }

    private func perm(_ icon: String, _ color: Color, _ title: String, _ detail: String, _ st: PermState, _ ask: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            FeatureIcon(symbol: icon, color: color, size: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            switch st {
            case .ok: Label("Allowed", systemImage: "checkmark.circle.fill").labelStyle(.iconOnly).foregroundStyle(TDColor.good).font(.title3)
            case .partial: Text("Partial").font(.caption.bold()).foregroundStyle(TDColor.warn)
            case .ask: Button("Allow") { ask() }.primaryButton().controlSize(.small)
            case .denied: Button("Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }.secondaryButton().controlSize(.small)
            case .unknown: Image(systemName: "questionmark.circle").foregroundStyle(.secondary).font(.title3)
            }
        }
        .padding(.vertical, 8)
    }

    private var notifState: PermState {
        switch notifs {
        case .authorized, .provisional, .ephemeral: return .ok
        case .denied: return .denied
        default: return .ask
        }
    }

    private func refreshNotifs() {
        UNUserNotificationCenter.current().getNotificationSettings { s in DispatchQueue.main.async { notifs = s.authorizationStatus } }
    }

    private func askNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in refreshNotifs() }
    }

    private var locationState: PermState {
        _ = core.tick
        switch Background.shared.authorization {
        case .authorizedAlways: return .ok
        case .authorizedWhenInUse: return ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 17 ? .ok : .partial
        case .notDetermined: return .ask
        default: return .denied
        }
    }

    private var bleState: PermState {
        _ = core.tick
        switch CBManager.authorization {
        case .allowedAlways: return .ok
        case .notDetermined: return .ask
        default: return .denied
        }
    }

    private var bleDetail: String {
        _ = core.tick
        if !core.ble.near.isEmpty { return "Linked to \(core.ble.near.values.sorted().joined(separator: ", ")) · Wakes TwinDesk and keeps the connection off Wi-Fi" }
        switch core.ble.radio {
        case "unauthorized": return "Not allowed · Settings › TwinDesk › Bluetooth"
        case "off": return core.ble.on ? "Bluetooth is off" : "Off"
        default: return "Wakes TwinDesk in the background and keeps the connection off Wi-Fi"
        }
    }

    private var photosState: PermState {
        _ = core.tick
        switch PhotoAccess.now { case .ok: return .ok; case .partial: return .partial; case .ask: return .ask; case .denied: return .denied }
    }

    private func avState(_ m: AVMediaType) -> PermState {
        _ = core.tick
        switch AVCaptureDevice.authorizationStatus(for: m) {
        case .authorized: return .ok
        case .notDetermined: return .ask
        default: return .denied
        }
    }

    private var locationDetail: String {
        switch Background.shared.authorization {
        case .authorizedAlways: return "Allowed · A blue indicator shows while in use"
        case .authorizedWhenInUse: return ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 17 ? "Allowed · A blue indicator shows while in use" : "Requires Always on iOS 16"
        case .denied, .restricted: return "Not allowed · Settings › TwinDesk › Location"
        default: return "Cellular and Wi-Fi positioning only (no GPS)"
        }
    }

    private func bg(_ k: String, _ def: Bool = true) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.store.flag(k, def) }, set: { Background.shared.set(k, $0) })
    }

    private func flag(_ k: String) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.store.flag(k, true) }, set: { core.store.setFlag(k, $0); core.changed(); if k == "usb.auto" && $0 { core.usb.moveOn() } })
    }
}
