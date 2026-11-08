// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos (this iPhone's library and TwinDesk's folder on the computer's Photos and Phone Files
// pages) and Camera (this iPhone's camera on the computer).
import SwiftUI
import Photos
import UIKit
import AVFoundation

struct PhotosView: View {
    @EnvironmentObject var core: Core

    var body: some View {
        PageScroll(title: "Photos") {
            if !core.connected { NeedsComputer(what: "Photos") }
            Columns {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "photo.fill.on.rectangle.fill", color: Page.photos.color, title: "Photos on the computer",
                               detail: "Its Photos page shows this \(Device.word)’s photos and videos, newest first; Save copies them there")
                    ToggleRow(title: "Let \(core.host?.name ?? "the computer") see them", detail: access,
                              on: Binding(get: { _ = core.tick; return core.hub.mediaOn }, set: { core.hub.set("media", $0) }))
                        .disabled(!core.connected || !core.hub.peer)
                    if PhotoAccess.now == .ask {
                        Button("Allow Photos") { core.hub.askPhotos() }.secondaryButton()
                    } else if PhotoAccess.now == .denied {
                        Button("Open Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }.secondaryButton()
                    }
                }
                .glassCard()
            } right: {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "folder.fill", color: TDColor.accent, title: "TwinDesk’s folder on the computer",
                               detail: "Its Phone Files page browses Files › On My \(Device.word) › TwinDesk: open, copy there, upload into it, new folders, rename, delete")
                    ToggleRow(title: "Let \(core.host?.name ?? "the computer") browse it", on: Binding(get: { _ = core.tick; return core.hub.filesOn }, set: { core.hub.set("files", $0) }))
                        .disabled(!core.connected || !core.hub.peer)
                }
                .glassCard()
            }
        }
    }

    private var access: String {
        switch PhotoAccess.now {
        case .ok: return "All photos"
        case .partial: return "Only the photos you picked (Settings › TwinDesk › Photos)"
        case .ask: return "iOS asks first"
        case .denied: return "Not allowed: Settings › TwinDesk › Photos"
        }
    }
}

struct CameraView: View {
    @EnvironmentObject var core: Core

    var body: some View {
        PageScroll(title: "Camera") {
            if !core.connected { NeedsComputer(what: "this camera there") }
            Columns {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "video.fill", color: Page.camera.color, title: "This \(Device.word)’s camera on \(core.host?.name ?? "the computer")",
                               detail: "Its Camera tab shows it, and with Virtual camera on there, Zoom, Teams, FaceTime and the browser can pick it")
                    ToggleRow(title: "Let \(core.host?.name ?? "the computer") see this camera", detail: permission,
                              on: Binding(get: { _ = core.tick; return core.camera.share }, set: { core.camera.setShare($0) }))
                    HStack {
                        Button { core.camera.flip() } label: { Label(core.camera.front ? "Front camera" : "Back camera", systemImage: "arrow.triangle.2.circlepath.camera") }
                            .secondaryButton()
                        if core.camera.on { Button("Stop") { core.camera.stop(tell: true) }.secondaryButton() }
                    }
                    Text("Start it from the computer’s Camera tab. iOS runs the camera only while TwinDesk is on screen.").font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()
            } right: {
                if let h = core.camera.host, core.camera.on {
                    WebPageView(host: h)
                        .aspectRatio(16 / 9, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay(alignment: .topLeading) {
                            Text(core.camera.status == "live" ? "LIVE" : "Starting…").font(.caption.bold())
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(core.camera.status == "live" ? TDColor.bad : Color.black.opacity(0.5), in: Capsule()).padding(10)
                        }
                        .onDisappear { if core.camera.on { HiddenWeb.attach(h) } }
                } else if core.camera.status == "failed" {
                    Label(core.camera.error.isEmpty ? "It didn’t start" : core.camera.error, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(TDColor.warn).glassCard()
                }
            }
        }
    }

    private var permission: String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "Off until the computer asks; then on while it shows it"
        case .notDetermined: return "iOS asks first"
        default: return "Not allowed: Settings › TwinDesk › Camera"
        }
    }
}
