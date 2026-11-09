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
                               detail: "The Photos page on the computer shows this \(Device.word)’s photos and videos, newest first, and can save them")
                    ToggleRow(title: "Allow \(core.host?.name ?? "the computer") to view photos", detail: access,
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
                               detail: "The Phone Files page on the computer browses Files › On My \(Device.word) › TwinDesk: open, copy, upload, create folders, rename and delete")
                    ToggleRow(title: "Allow \(core.host?.name ?? "the computer") to browse this folder", on: Binding(get: { _ = core.tick; return core.hub.filesOn }, set: { core.hub.set("files", $0) }))
                        .disabled(!core.connected || !core.hub.peer)
                }
                .glassCard()
            }
        }
    }

    private var access: String {
        switch PhotoAccess.now {
        case .ok: return "All photos"
        case .partial: return "Limited to selected photos (Settings › TwinDesk › Photos)"
        case .ask: return "iOS asks first"
        case .denied: return "Not allowed. Change in Settings › TwinDesk › Photos"
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
                               detail: "Shown on the computer’s Camera tab. With Virtual camera on, it’s available in Zoom, Teams, FaceTime and browsers")
                    ToggleRow(title: "Allow \(core.host?.name ?? "the computer") to use this camera", detail: permission,
                              on: Binding(get: { _ = core.tick; return core.camera.share }, set: { core.camera.setShare($0) }))
                    HStack {
                        Button { core.camera.flip() } label: { Label(core.camera.front ? "Front camera" : "Back camera", systemImage: "arrow.triangle.2.circlepath.camera") }
                            .secondaryButton()
                        if core.camera.on { Button("Stop") { core.camera.stop(tell: true) }.secondaryButton() }
                    }
                    Text("Start it from the Camera tab on the computer. iOS allows camera use only while TwinDesk is on screen.").font(.caption).foregroundStyle(.secondary)
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
                    Label(core.camera.error.isEmpty ? "Couldn’t start the camera" : core.camera.error, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(TDColor.warn).glassCard()
                }
            }
        }
    }

    private var permission: String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "Turns on when the computer requests it, and off when it stops"
        case .notDetermined: return "iOS asks first"
        default: return "Not allowed. Change in Settings › TwinDesk › Camera"
        }
    }
}
