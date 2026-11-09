// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This iPhone's camera on the computer (its Camera tab and virtual camera: shared/camshare.js and
// vcam.js there), the way another computer shares its own: the computer asks (cam.open) while
// "Let the computer see this camera" is on here (cam.policy), and WebRTC carries the picture
// (WebIOS/camera.html: cam.offer / answer / ice). iOS keeps the camera to the app on screen, so it
// runs while TwinDesk is open: the Camera page shows what it sends.
import Foundation
import UIKit
import AVFoundation

final class Camera: Feature {
    private(set) var host: WebHost?
    private(set) var status = "" // "" | starting | live | failed
    private(set) var error = ""
    var on: Bool { status == "starting" || status == "live" }

    var share: Bool { core.store.flag("camera.share", false) }
    var front: Bool { core.store.flag("camera.front", false) }

    func setShare(_ v: Bool) {
        if v && AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { _ in DispatchQueue.main.async { self.core.changed() } }
        }
        core.store.setFlag("camera.share", v)
        if !v { stop(tell: true) }
        sendPolicy()
        core.changed()
    }

    func flip() {
        core.store.setFlag("camera.front", !front)
        if on { host?.post(["t": "start", "facing": front ? "user" : "environment"]) }
        core.changed()
    }

    func sendPolicy() { core.send(msg("cam.policy", ["share": share])) }

    override func onWelcome(_ host: Computer, _ m: JSON) { sendPolicy() }
    override func onClosed() { stop(tell: false) }

    private func page() -> WebHost {
        if let h = host { return h }
        let h = WebHost("camera.html", core: core, dir: "WebIOS")
        HiddenWeb.attach(h) // in the window: WebKit runs the camera only for a page that's on screen
        host = h
        return h
    }

    func stop(tell: Bool) {
        guard host != nil || on else { return }
        host?.post(["t": "stop"])
        host?.destroy()
        host = nil
        if tell && core.connected { core.send(msg("cam.close")) }
        status = ""
        UIApplication.shared.isIdleTimerDisabled = false
        core.changed()
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        switch t {
        case "cam.open":
            guard share else { core.send(msg("cam.state", ["status": "refused"])); return true }
            guard UIApplication.shared.applicationState == .active else {
                core.send(msg("cam.state", ["status": "failed", "error": "open TwinDesk on the \(Device.word): iOS runs the camera only for the app on screen"]))
                Notifier.shared.note("camera", tr("{name} requests this camera", ["name": core.host?.name ?? tr("The computer")]), tr("Open TwinDesk to share it."), sound: true)
                return true
            }
            status = "starting"
            error = ""
            core.send(msg("cam.state", ["status": "starting"]))
            page().post(["t": "start", "facing": front ? "user" : "environment"])
            UIApplication.shared.isIdleTimerDisabled = true
            core.changed()
        case "cam.answer": host?.post(["t": "answer", "sdp": m.str("sdp", max: 200_000)])
        case "cam.ice":
            if m.str("from") == "view", let c = m["candidate"] { host?.post(["t": "ice", "candidate": c]) }
        case "cam.close": stop(tell: false)
        case "cam.state": // ours, through the page: kept for the Camera page too
            break
        case "cam.policy": break // the computer's own camera for us: not shown on the iPhone
        default: return false
        }
        return true
    }

    // The page's own cam.state (it sends it to the computer; this follows along).
    func pageStatus(_ m: JSON) {
        status = m.str("status") == "failed" ? "failed" : m.str("status")
        error = m.str("error")
        if status == "failed" { UIApplication.shared.isIdleTimerDisabled = false }
        core.changed()
    }
}
