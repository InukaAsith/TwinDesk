// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Update check (Updates.kt on Android, shared/updates.js on the computers): asks GitHub for the
// latest release of TwinDesk and compares its tag with this app's version. Nothing is installed
// here (the app is sideloaded): Download opens the release's IPA, or the release page, in Safari.
//   store: updates.auto (on screen: a check at most every 6 hours; never a timer in the background,
//   so it costs no battery), updates.notified (the last version a notification announced).
import Foundation
import UIKit

final class Updates {
    unowned let core: Core
    init(_ core: Core) { self.core = core }

    private static let repo = "InukaAsith/TwinDesk"
    private static let api = URL(string: "https://api.github.com/repos/\(repo)/releases/latest")!
    static let releases = URL(string: "https://github.com/\(repo)/releases")!
    private static let every: TimeInterval = 6 * 60 * 60

    private(set) var checking = false
    private(set) var latest = ""
    private(set) var available = false
    private(set) var download: URL?
    private(set) var releaseUrl = Updates.releases
    private(set) var noReleases = false
    private(set) var error = ""
    private(set) var checkedAt: Date?

    var current: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "" }
    var auto: Bool {
        get { core.store.flag("updates.auto", true) }
        set { core.store.setFlag("updates.auto", newValue); core.changed(); if newValue { onScreen() } }
    }

    // TwinDesk came on screen: a check when it's on and the last one is old enough.
    func onScreen() {
        guard auto, !checking else { return }
        if let at = checkedAt, Date().timeIntervalSince(at) < Self.every { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self = self, self.core.inFront, !self.checking else { return }
            if let at = self.checkedAt, Date().timeIntervalSince(at) < Self.every { return }
            self.check(manual: false)
        }
    }

    func checkNow() { check(manual: true) }

    private func check(manual: Bool) {
        guard !checking else { return }
        checking = true
        error = ""
        core.changed()
        var req = URLRequest(url: Self.api, timeoutInterval: 20)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("TwinDesk/\(current)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { [weak self] data, res, err in
            DispatchQueue.main.async { self?.done(manual, data, res as? HTTPURLResponse, err) }
        }.resume()
    }

    private func done(_ manual: Bool, _ data: Data?, _ res: HTTPURLResponse?, _ err: Error?) {
        defer { checking = false; core.changed() }
        guard err == nil, let res = res else {
            if manual { error = tr("Couldn’t reach GitHub") }
            return
        }
        if res.statusCode == 404 {
            latest = ""; available = false; download = nil; releaseUrl = Self.releases; noReleases = true; checkedAt = Date()
            return
        }
        guard res.statusCode == 200, let d = data, let r = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
            if manual { error = res.statusCode == 403 ? tr("GitHub is busy, try again later") : tr("GitHub answered {code}", ["code": "\(res.statusCode)"]) }
            return
        }
        var tag = (r["tag_name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (r["name"] as? String ?? "")
        if tag.hasPrefix("v") || tag.hasPrefix("V") { tag.removeFirst() }
        guard Self.parse(tag) != nil else {
            if manual { error = tr("The latest release has no version number") }
            return
        }
        latest = tag
        available = Self.compare(tag, current) > 0
        download = (r["assets"] as? [[String: Any]] ?? []).lazy
            .first { ($0["name"] as? String ?? "").lowercased().hasSuffix(".ipa") }
            .flatMap { ($0["browser_download_url"] as? String).flatMap(URL.init(string:)) }
        releaseUrl = (r["html_url"] as? String).flatMap(URL.init(string:)) ?? Self.releases
        noReleases = false
        checkedAt = Date()
        if available && core.store.string("updates.notified", "") != latest {
            core.store.setString("updates.notified", latest)
            Notifier.shared.note("update", tr("TwinDesk {latest} is available", ["latest": latest]),
                                 tr("You have {current}. Tap to download the new version.", ["current": current]))
        }
    }

    // Download: the release's IPA, else its page.
    var url: URL { available ? (download ?? releaseUrl) : releaseUrl }
    func open() { UIApplication.shared.open(url) }

    // "v1.2.3" / "1.2" / "1.2.3-beta.1"; nil when it isn't a version.
    private static func parse(_ v: String) -> (nums: [Int], pre: String)? {
        let s = v.trimmingCharacters(in: .whitespaces)
        guard let m = s.range(of: #"^v?\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?"#, options: .regularExpression) else { return nil }
        var head = String(s[m])
        if head.hasPrefix("v") { head.removeFirst() }
        let parts = head.split(separator: "-", maxSplits: 1).map(String.init)
        let nums = parts[0].split(separator: ".").compactMap { Int($0) }
        return (nums, parts.count > 1 ? parts[1] : "")
    }

    // > 0 when a is newer than b. A pre-release is older than the same version without one.
    static func compare(_ a: String, _ b: String) -> Int {
        guard let x = parse(a), let y = parse(b) else { return 0 }
        for i in 0..<max(x.nums.count, y.nums.count) {
            let d = (i < x.nums.count ? x.nums[i] : 0) - (i < y.nums.count ? y.nums[i] : 0)
            if d != 0 { return d }
        }
        if x.pre == y.pre { return 0 }
        if x.pre.isEmpty { return 1 }
        if y.pre.isEmpty { return -1 }
        return x.pre < y.pre ? -1 : 1
    }
}
