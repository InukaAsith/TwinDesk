// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer's notifications, shown here (notif, notif.policy). The other way can't be done by an
// app on iOS: no app may read another app's notifications. (The computers could get them over
// Bluetooth from iOS itself, ANCS, which needs no app: a separate piece of work on their side.)
// And the phone's own details for the computer's tile (phone.info).
import Foundation
import UIKit

final class Notifs: Feature {
    struct Item: Identifiable { let id = UUID(); let app: String; let title: String; let body: String; let at = Date() }
    private(set) var shown = 0
    private(set) var recent: [Item] = [] // this session's, newest first (the Overview's card)

    func sendPolicy() {
        core.send(msg(Proto.T.notifPolicy, ["accept": core.sync.get("notifs", "in")]))
    }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        if host.id != lastHost { recent = []; lastHost = host.id } // another computer's aren't its
        sendPolicy()
    }
    private var lastHost: String?

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        guard t == Proto.T.notif else { return t == Proto.T.notifPolicy }
        guard core.sync.get("notifs", "in") else { return true }
        let app = m.str("appName", max: 80).isEmpty ? m.str("app", max: 80) : m.str("appName", max: 80)
        let body = [m.str("subtitle", max: 200), m.str("body", max: 1000)].filter { !$0.isEmpty }.joined(separator: "\n")
        Notifier.shared.fromComputer(id: m.str("id", max: 200), app: app, title: m.str("title", max: 300), body: body,
                                     computer: core.link.host?.name ?? "Computer")
        shown += 1
        recent.insert(Item(app: app, title: m.str("title", max: 300), body: body), at: 0)
        if recent.count > 20 { recent.removeLast(recent.count - 20) }
        core.changed()
        return true
    }
}

final class PhoneInfo: Feature {
    private var observers: [NSObjectProtocol] = []

    override func onWelcome(_ host: Computer, _ m: JSON) {
        UIDevice.current.isBatteryMonitoringEnabled = true
        send()
        if observers.isEmpty {
            let nc = NotificationCenter.default
            for n in [UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification] {
                observers.append(nc.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in self?.send() })
            }
        }
    }

    func send() {
        guard core.connected else { return }
        let d = UIDevice.current
        let level = d.batteryLevel
        var m = msg(Proto.T.phoneInfo, [
            "model": core.store.model, "maker": "Apple", "release": d.systemVersion, "sdk": 0,
            "colors": ["#0a84ff", "#5e5ce6"], "app": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "platform": d.userInterfaceIdiom == .pad ? "ipados" : "ios", "caps": [String](),
        ])
        if level >= 0 { m["battery"] = Int(level * 100) }
        m["charging"] = d.batteryState == .charging || d.batteryState == .full
        core.send(m)
    }
}
