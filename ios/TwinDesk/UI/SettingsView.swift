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

    var body: some View {
        PageScroll(title: "General") {
            Columns {
                SectionTitle(text: "This \(Device.word)")
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Name", text: $name).font(.title3.weight(.semibold))
                        .onSubmit { core.rename(name) }
                    Text("How the computers list it. iOS doesn’t tell apps the name you gave the \(Device.word).").font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()

                SectionTitle(text: "Background")
                VStack(alignment: .leading, spacing: 12) {
                    ToggleRow(title: "Stay connected", detail: "Off screen, the session moves onto Bluetooth, the way iOS allows", on: bg("bg.on"))
                    Divider()
                    Text("Backups").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    ToggleRow(title: "Use location", detail: locationDetail, on: bg("bg.location", false))
                    Divider()
                    ToggleRow(title: "Use silent audio", detail: "Plays silence alongside your music", on: bg("bg.audio", false))
                    Divider()
                    ToggleRow(title: "Reconnect on its own", detail: "To the last computer, when TwinDesk wakes", on: flag("autoConnect"))
                    Text("Bluetooth needs no backup. Turn one on if the computer has no Bluetooth, or to keep Wi-Fi speed with TwinDesk off screen. Each uses some battery.").font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()

                SectionTitle(text: "Connection")
                VStack(alignment: .leading, spacing: 12) {
                    ToggleRow(title: "Use the USB cable", detail: "Plugged into the computer, the session moves onto the cable by itself", on: flag("usb.auto"))
                    Divider()
                    ToggleRow(title: "Use Bluetooth", detail: bleDetail, on: Binding(get: { _ = core.tick; return core.ble.on }, set: { core.ble.setOn($0) }))
                }
                .glassCard()
            } right: {
                SectionTitle(text: "Permissions")
                VStack(spacing: 0) {
                    perm("bell.fill", Page.notifications.color, "Notifications", "The computer’s notifications, copies and files", notifState) { askNotifications() }
                    Divider().padding(.leading, 46)
                    perm("location.fill", TDColor.accent, "Location", "Staying connected in the background", locationState) { Background.shared.askLocation() }
                    Divider().padding(.leading, 46)
                    perm("dot.radiowaves.left.and.right", Color.blue, "Bluetooth", "Notifications and the session away from Wi-Fi", bleState) { core.ble.setOn(true) }
                    Divider().padding(.leading, 46)
                    perm("photo.fill", Page.photos.color, "Photos", "Sending photos, and Photos on the computer", photosState) { core.hub.askPhotos() }
                    Divider().padding(.leading, 46)
                    perm("camera.fill", Page.camera.color, "Camera", "This camera on the computer", avState(.video)) { AVCaptureDevice.requestAccess(for: .video) { _ in DispatchQueue.main.async { core.changed() } } }
                    Divider().padding(.leading, 46)
                    perm("mic.fill", Page.audio.color, "Microphone", "This microphone on the computer", avState(.audio)) { AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { core.changed() } } }
                    Divider().padding(.leading, 46)
                    perm("network", TDColor.good, "Local Network", "Finding and reaching your computers", core.nearby.isEmpty && !core.connected ? .unknown : .ok) {}
                }
                .glassCard()
                Button("Open TwinDesk’s Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
                    .secondaryButton().frame(maxWidth: .infinity, alignment: .leading)
                Text("Local Network can’t be read by an app: if no computer shows up, check Settings › TwinDesk › Local Network. Paste from Other Apps set to Allow stops iOS asking each time you send the clipboard.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .onAppear { refreshNotifs() }
        .onDisappear { if name != core.store.deviceName { core.rename(name) } }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in refreshNotifs(); core.changed() }
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
            case .partial: Text("Some").font(.caption.bold()).foregroundStyle(TDColor.warn)
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
        if !core.ble.near.isEmpty { return "Linked to \(core.ble.near.values.sorted().joined(separator: ", ")) · wakes TwinDesk, and carries the session off Wi-Fi" }
        switch core.ble.radio {
        case "unauthorized": return "Not allowed · Settings › TwinDesk › Bluetooth"
        case "off": return core.ble.on ? "Bluetooth is off" : "Off"
        default: return "Keeps TwinDesk woken in the background, and the session off Wi-Fi"
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
        case .authorizedAlways: return "Allowed · the blue pill shows while it runs"
        case .authorizedWhenInUse: return ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 17 ? "Allowed · the blue pill shows while it runs" : "Needs Always on iOS 16"
        case .denied, .restricted: return "Not allowed · Settings › TwinDesk › Location"
        default: return "Cell and Wi-Fi only, no GPS"
        }
    }

    private func bg(_ k: String, _ def: Bool = true) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.store.flag(k, def) }, set: { Background.shared.set(k, $0) })
    }

    private func flag(_ k: String) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.store.flag(k, true) }, set: { core.store.setFlag(k, $0); core.changed(); if k == "usb.auto" && $0 { core.usb.moveOn() } })
    }
}
