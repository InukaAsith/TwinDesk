// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Android app's web pages (android/app/src/main/assets/web, bundled here as "web"): the
// computer's screen (viewer.html), the Remote (remote.html) and the computer's sound (audio.html).
// Each runs in a WKWebView with the same window.TD the Android WebHost gives them (send, move,
// ready, playing, haptic, tick, event, setPad, setLayout, pad), and gets messages through
// window.tdRecv(message). WebKit has WebRTC (iOS 14.3+), the Pencil as pointerType "pen", and
// pointer events for the touchpad and mouse, so the pages work as they are.
import Foundation
import WebKit
import UIKit
import SwiftUI
import CoreMotion

final class WebHost: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    let page: String
    let view: WKWebView
    private weak var core: Core?
    private var ready = false
    private var queue: [JSON] = []
    private var motion: CMMotionManager?
    var onEvent: (String, JSON?) -> Void = { _, _ in }

    private static let shim = """
    (() => {
      const post = (o) => window.webkit.messageHandlers.td.postMessage(o);
      window.TD = {
        send: (s) => post({ k: 'send', s: String(s) }),
        move: (kind, a, b, smooth) => post({ k: 'move', kind, a, b, smooth: !!smooth }),
        ready: () => post({ k: 'ready' }),
        playing: (w, h) => post({ k: 'playing', w, h }),
        haptic: () => post({ k: 'haptic' }),
        tick: () => post({ k: 'tick' }),
        event: (name) => post({ k: 'event', name: String(name) }),
        setPad: (id, code) => post({ k: 'setPad', id: String(id), code: String(code) }),
        setLayout: (json) => post({ k: 'setLayout', s: String(json) }),
        pad: (b, lx, ly, rx, ry, lt, rt) => post({ k: 'pad', b, lx, ly, rx, ry, lt, rt }),
        motion: (on) => post({ k: 'motion', on: !!on }),
      };
      const log = console.log.bind(console);
      console.log = (...a) => { try { post({ k: 'log', s: a.map(String).join(' ') }); } catch (e) {} log(...a); };
    })();
    """

    // dir: "web" (the Android app's pages) or "WebIOS" (this app's own: the camera).
    init(_ page: String, core: Core, dir: String = "web") {
        self.page = page
        self.core = core
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsPictureInPictureMediaPlayback = false
        let uc = WKUserContentController()
        uc.addUserScript(WKUserScript(source: Self.shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        uc.addUserScript(WKUserScript(source: I18n.shared.webScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = uc
        view = WKWebView(frame: CGRect(x: 0, y: 0, width: 10, height: 10), configuration: cfg)
        super.init()
        uc.add(WeakHandler(self), name: "td")
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.pinchGestureRecognizer?.isEnabled = false
        view.allowsLinkPreview = false
        view.navigationDelegate = self
        view.uiDelegate = self
        if #available(iOS 16.4, *) { view.isInspectable = true }
        if let dir = Bundle.main.url(forResource: dir, withExtension: nil) {
            view.loadFileURL(dir.appendingPathComponent(page), allowingReadAccessTo: dir)
        } else {
            NSLog("TwinDesk: the web pages aren't in the app")
        }
    }

    // A message to the page (any thread); queued until it says it's ready.
    func post(_ m: JSON) {
        DispatchQueue.main.async {
            if self.ready { self.deliver(m) } else { self.queue.append(m) }
        }
    }

    private func deliver(_ m: JSON) {
        guard let s = encodeJSON(m) else { return }
        view.evaluateJavaScript("window.tdRecv && window.tdRecv(\(s));", completionHandler: nil)
    }

    func js(_ s: String) { DispatchQueue.main.async { self.view.evaluateJavaScript(s, completionHandler: nil) } }

    func destroy() {
        motionOn(false)
        ready = false
        queue.removeAll()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "td")
        view.stopLoading()
        view.loadHTMLString("", baseURL: nil)
        view.removeFromSuperview()
    }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let o = message.body as? [String: Any], let k = o["k"] as? String, let core = core else { return }
        switch k {
        case "send":
            if let s = o["s"] as? String, let m = decodeJSON(s) {
                if m.str("t") == "cam.state" { core.camera.pageStatus(m) }
                core.send(m)
            }
        case "move":
            let kind = (o["kind"] as? NSNumber)?.intValue ?? 0
            let a = (o["a"] as? NSNumber)?.doubleValue ?? 0
            let b = (o["b"] as? NSNumber)?.doubleValue ?? 0
            switch kind {
            case 0: core.send(msg("remote.mm", ["dx": a, "dy": b, "smooth": (o["smooth"] as? Bool) ?? false]))
            case 1: core.send(msg("remote.wh", ["dx": a, "dy": b]))
            default: core.send(msg("in.mm", ["x": a, "y": b]))
            }
        case "ready":
            ready = true
            for m in queue { deliver(m) }
            queue.removeAll()
            onEvent("ready", nil)
        case "playing":
            onEvent("playing", ["w": (o["w"] as? NSNumber)?.intValue ?? 0, "h": (o["h"] as? NSNumber)?.intValue ?? 0])
        case "haptic": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "tick": UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.6)
        case "event": onEvent((o["name"] as? String) ?? "", nil)
        case "setPad": core.remote.setPad((o["id"] as? String) ?? "", (o["code"] as? String) ?? "")
        case "setLayout": core.remote.setLayout((o["s"] as? String) ?? "")
        case "pad":
            let n = { (key: String) in (o[key] as? NSNumber)?.doubleValue ?? 0 }
            core.remote.pad(b: Int(n("b")), lx: n("lx"), ly: n("ly"), rx: n("rx"), ry: n("ry"), lt: n("lt"), rt: n("rt"))
        case "motion": motionOn((o["on"] as? Bool) ?? false)
        case "log":
            NSLog("TwinDesk web(%@): %@", page, (o["s"] as? String) ?? "")
        default: break
        }
    }

    // The phone's turning, for remote.html (window.tdMotion: the air mouse, the presentation pointer):
    // radians about the phone's x, y and z added up between calls (about every 12 ms), and which way is
    // up (against gravity, a unit vector), in the phone's frame. tdMotion(null): no gyroscope.
    private func motionOn(_ on: Bool) {
        if !on { motion?.stopDeviceMotionUpdates(); motion = nil; return }
        guard motion == nil else { return }
        let m = CMMotionManager()
        guard m.isDeviceMotionAvailable else { return js("window.tdMotion&&tdMotion(null)") }
        motion = m
        m.deviceMotionUpdateInterval = 1.0 / 100
        var a = (0.0, 0.0, 0.0), last: TimeInterval = 0, sent: TimeInterval = 0
        m.startDeviceMotionUpdates(to: .main) { [weak self] d, _ in
            guard let self = self, let d = d, self.ready else { return }
            if last > 0 {
                let dt = d.timestamp - last
                if dt > 0 && dt < 0.1 { a.0 += d.rotationRate.x * dt; a.1 += d.rotationRate.y * dt; a.2 += d.rotationRate.z * dt }
            }
            last = d.timestamp
            guard d.timestamp - sent >= 0.012 else { return }
            sent = d.timestamp
            let g = d.gravity
            let f = { (v: Double) in String(format: "%.6f", v) }
            self.view.evaluateJavaScript("window.tdMotion&&tdMotion(\(f(a.0)),\(f(a.1)),\(f(a.2)),\(f(-g.x)),\(f(-g.y)),\(f(-g.z)))", completionHandler: nil)
            a = (0, 0, 0)
        }
    }

    // Links never open in here.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let u = action.request.url
        if u?.isFileURL == true || u?.scheme == "about" { return decisionHandler(.allow) }
        if let u = u { UIApplication.shared.open(u) }
        decisionHandler(.cancel)
    }

    // The page's own camera and microphone (the Camera page): granted, as iOS asked the person already.
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // The web content process went away (memory pressure): load the page again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        webView.reload()
    }
}

// WKUserContentController keeps its handlers strongly: this breaks the cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(uc, didReceive: message)
    }
}

// A web page as a SwiftUI view (the WKWebView itself, moved into this place).

struct WebPageView: UIViewRepresentable {
    let host: WebHost
    func makeUIView(context: Context) -> UIView {
        let box = UIView()
        box.backgroundColor = .black
        host.view.removeFromSuperview()
        host.view.alpha = 1
        host.view.isUserInteractionEnabled = true
        host.view.frame = box.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        box.addSubview(host.view)
        return box
    }
    func updateUIView(_ v: UIView, context: Context) {}
}

// A hidden page that only plays (the computer's sound): in the window, out of sight, so WebKit
// treats it as on screen and lets it play.
enum HiddenWeb {
    static func attach(_ h: WebHost) {
        DispatchQueue.main.async {
            guard h.view.window == nil,
                  let w = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first else { return }
            h.view.removeFromSuperview()
            h.view.autoresizingMask = []
            h.view.frame = CGRect(x: -4, y: -4, width: 2, height: 2)
            h.view.alpha = 0.01
            h.view.isUserInteractionEnabled = false
            w.addSubview(h.view)
        }
    }
}
