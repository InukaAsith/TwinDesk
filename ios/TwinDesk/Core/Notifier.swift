// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Local notifications (the session itself carries everything, so no push service is needed while
// the app is kept alive): the computer's copies with Copy, "You copied something" with Send, files
// copied there with Save, its notifications, invites, and transfers that finished.
import Foundation
import UserNotifications
import UIKit

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    private let c = UNUserNotificationCenter.current()

    enum Cat {
        static let clipIn = "clip.in"
        static let clipOut = "clip.out"
        static let fclip = "fclip"
        static let invite = "invite"
        static let screen = "screen"
    }

    func setUp() {
        c.delegate = self
        let copy = UNNotificationAction(identifier: "copy", title: tr("Copy"), options: [])
        let send = UNNotificationAction(identifier: "send", title: tr("Send"), options: [.foreground]) // reading the clipboard needs us in front
        let save = UNNotificationAction(identifier: "save", title: tr("Save"), options: [])
        let connect = UNNotificationAction(identifier: "connect", title: tr("Pair"), options: [.foreground])
        c.setNotificationCategories([
            UNNotificationCategory(identifier: Cat.clipIn, actions: [copy], intentIdentifiers: []),
            UNNotificationCategory(identifier: Cat.clipOut, actions: [send], intentIdentifiers: []),
            UNNotificationCategory(identifier: Cat.fclip, actions: [save], intentIdentifiers: []),
            UNNotificationCategory(identifier: Cat.invite, actions: [connect], intentIdentifiers: []),
            UNNotificationCategory(identifier: Cat.screen, actions: [UNNotificationAction(identifier: "view", title: tr("View"), options: [.foreground])], intentIdentifiers: []),
        ])
        c.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    private func post(_ id: String, _ title: String, _ body: String, cat: String? = nil, info: [String: Any] = [:], sound: Bool = false, thread: String? = nil) {
        let n = UNMutableNotificationContent()
        n.title = title
        n.body = body
        if let cat = cat { n.categoryIdentifier = cat }
        n.userInfo = info
        if sound { n.sound = .default }
        if let t = thread { n.threadIdentifier = t }
        if #available(iOS 15.0, *) { n.interruptionLevel = sound ? .active : .passive }
        c.add(UNNotificationRequest(identifier: id, content: n, trigger: nil))
    }

    func clipIn(_ text: String, from: String, copied: Bool) {
        post("clip.in", copied ? tr("Copied from {from}", ["from": from]) : tr("{from} copied", ["from": from]), String(text.prefix(300)), cat: copied ? nil : Cat.clipIn,
             info: ["text": String(text.prefix(Proto.clipMaxBytes))])
    }

    func clipOut(to: String, picture: Bool) {
        post("clip.out", picture ? tr("Copied a picture") : tr("Copied text"), tr("Send to {to}?", ["to": to]), cat: Cat.clipOut)
    }

    func fclip(id: String, names: [String], files: Int, from: String) {
        let what = files == 1 ? (names.first ?? tr("1 file")) : trCount(files, "item")
        post("fclip", tr("Copied on {from}", ["from": from]), tr("{what}. Save to this {device}?", ["what": what, "device": Device.word]), cat: Cat.fclip, info: ["id": id], sound: true)
    }

    func cancelFclip() { c.removeDeliveredNotifications(withIdentifiers: ["fclip"]) }

    func fromComputer(id: String, app: String, title: String, body: String, computer: String) {
        post("n." + id, title.isEmpty ? app : title, body, info: [:], sound: true, thread: computer + "|" + app)
    }

    func shareAsk(_ name: String, airplay: String? = nil) {
        post("share", tr("{name} wants to see this screen", ["name": name]), airplay.map { tr("Tap to share, or select {name} in Control Center › Screen Mirroring.", ["name": $0]) } ?? tr("Open TwinDesk and tap Share Screen."), sound: true)
    }

    // The computer started sharing its screen while TwinDesk wasn't in front.
    func screen(_ name: String) {
        post("screen", tr("{name} is sharing its screen", ["name": name]), tr("Tap to view."), cat: Cat.screen, sound: true)
    }

    func cancel(_ id: String) { c.removeDeliveredNotifications(withIdentifiers: [id]) }

    // Anything else (a one-off line from a feature).
    func note(_ id: String, _ title: String, _ body: String, sound: Bool = false) { post(id, title, body, sound: sound) }

    func invite(_ name: String) {
        post("invite", tr("{name} wants to connect", ["name": name]), tr("Tap to pair this {device}.", ["device": Device.word]), cat: Cat.invite, sound: true)
    }

    func filesIn(_ name: String, ok: Bool, from: String) {
        guard UIApplication.shared.applicationState != .active else { return }
        post("files.in." + UUID().uuidString, ok ? tr("Received {name}", ["name": name]) : tr("{name} didn’t arrive", ["name": name]), ok ? tr("From {from} · Files › TwinDesk › Received", ["from": from]) : tr("From {from}", ["from": from]))
    }

    func filesOut(_ name: String, ok: Bool, to: String) {
        guard UIApplication.shared.applicationState != .active else { return }
        post("files.out." + UUID().uuidString, ok ? tr("Sent {name}", ["name": name]) : tr("{name} wasn’t sent", ["name": name]), ok ? tr("To {to}", ["to": to]) : tr("To {to}", ["to": to]))
    }

    // ---- delegate ----

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        // In front: the app shows these itself; the computer's own notifications still show.
        let id = notification.request.identifier
        if id.hasPrefix("n.") { done([.banner, .sound, .list]) } else { done([]) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let core = Core.shared
        switch (response.notification.request.content.categoryIdentifier, response.actionIdentifier) {
        case (Cat.clipIn, "copy"), (Cat.clipIn, UNNotificationDefaultActionIdentifier):
            if let t = info["text"] as? String { core.clip.write(t) }
        case (Cat.clipOut, "send"), (Cat.clipOut, UNNotificationDefaultActionIdentifier):
            // In front now: the clipboard can be read (iOS may ask Allow Paste).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { core.clip.sendCurrent(force: true) }
        case (Cat.fclip, "save"), (Cat.fclip, UNNotificationDefaultActionIdentifier):
            core.fclip.save(info["id"] as? String)
        case (Cat.screen, _):
            core.screen.autoOpen = true
            core.changed()
        case (Cat.invite, _):
            if let f = core.invite { core.pair(f) }
        case (_, UNNotificationDefaultActionIdentifier) where response.notification.request.identifier == "update":
            core.updates.open() // a new release (Updates.swift): its IPA or page in Safari
        default: break
        }
        done()
    }
}
