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
        PageScroll(title: tr("Photos")) {
            if !core.connected { NeedsComputer(what: tr("Photos")) }
            Columns {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "photo.fill.on.rectangle.fill", color: Page.photos.color, title: tr("Photos on the computer"),
                               detail: tr("The Photos page on the computer shows this {device}’s photos and videos, newest first, and can save them", ["device": Device.word]))
                    ToggleRow(title: tr("Allow {name} to view photos", ["name": core.host?.name ?? tr("the computer")]), detail: access,
                              on: Binding(get: { _ = core.tick; return core.hub.mediaOn }, set: { core.hub.set("media", $0) }))
                        .disabled(!core.connected || !core.hub.peer)
                    if PhotoAccess.now == .ask {
                        Button(tr("Allow Photos")) { core.hub.askPhotos() }.secondaryButton()
                    } else if PhotoAccess.now == .denied {
                        Button(tr("Open Settings")) { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }.secondaryButton()
                    }
                }
                .glassCard()
            } right: {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "folder.fill", color: TDColor.accent, title: tr("TwinDesk’s folder on the computer"),
                               detail: tr("The Phone Files page on the computer browses Files › On My {device} › TwinDesk: open, copy, upload, create folders, rename and delete", ["device": Device.word]))
                    ToggleRow(title: tr("Allow {name} to browse this folder", ["name": core.host?.name ?? tr("the computer")]), on: Binding(get: { _ = core.tick; return core.hub.filesOn }, set: { core.hub.set("files", $0) }))
                        .disabled(!core.connected || !core.hub.peer)
                }
                .glassCard()
            }
        }
    }

    private var access: String {
        switch PhotoAccess.now {
        case .ok: return tr("All photos")
        case .partial: return tr("Limited to selected photos (Settings › TwinDesk › Photos)")
        case .ask: return tr("iOS asks first")
        case .denied: return tr("Not allowed. Change in Settings › TwinDesk › Photos")
        }
    }
}

struct CameraView: View {
    @EnvironmentObject var core: Core

    var body: some View {
        PageScroll(title: tr("Camera")) {
            if !core.connected { NeedsComputer(what: tr("this camera there")) }
            Columns {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "video.fill", color: Page.camera.color, title: tr("This {device}’s camera on {name}", ["device": Device.word, "name": core.host?.name ?? tr("the computer")]),
                               detail: tr("Shown on the computer’s Camera tab. With Virtual camera on, it’s available in Zoom, Teams, FaceTime and browsers"))
                    ToggleRow(title: tr("Allow {name} to use this camera", ["name": core.host?.name ?? tr("the computer")]), detail: permission,
                              on: Binding(get: { _ = core.tick; return core.camera.share }, set: { core.camera.setShare($0) }))
                    HStack {
                        Button { core.camera.flip() } label: { Label(core.camera.front ? tr("Front camera") : tr("Back camera"), systemImage: "arrow.triangle.2.circlepath.camera") }
                            .secondaryButton()
                        if core.camera.on { Button(tr("Stop")) { core.camera.stop(tell: true) }.secondaryButton() }
                    }
                    Text(tr("Start it from the Camera tab on the computer. iOS allows camera use only while TwinDesk is on screen.")).font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()
            } right: {
                if let h = core.camera.host, core.camera.on {
                    WebPageView(host: h)
                        .aspectRatio(16 / 9, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay(alignment: .topLeading) {
                            Text(core.camera.status == "live" ? "LIVE" : tr("Starting…")).font(.caption.bold())
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(core.camera.status == "live" ? TDColor.bad : Color.black.opacity(0.5), in: Capsule()).padding(10)
                        }
                        .onDisappear { if core.camera.on { HiddenWeb.attach(h) } }
                } else if core.camera.status == "failed" {
                    Label(core.camera.error.isEmpty ? tr("Couldn’t start the camera") : core.camera.error, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(TDColor.warn).glassCard()
                }
            }
        }
    }

    private var permission: String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return tr("Turns on when the computer requests it, and off when it stops")
        case .notDetermined: return tr("iOS asks first")
        default: return tr("Not allowed. Change in Settings › TwinDesk › Camera")
        }
    }
}
