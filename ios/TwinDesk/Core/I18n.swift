// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The app's language, as on Android (I18n.kt) and the desktop (shared/i18n.js): the English text in
// the code is the key, <language>.json in the bundle gives another language's text, and anything
// missing stays English. General › Language picks one; until then the iPhone's own language decides.
// What only goes to the computer (errors and labels it shows) stays English: the computer translates it.
import Foundation
import SwiftUI

final class I18n: ObservableObject {
    static let shared = I18n()

    // What General offers: code, the name in its own language, its flag.
    static let languages: [(code: String, name: String, flag: String)] = [
        ("en", "English", "🇬🇧"), ("zh-CN", "简体中文", "🇨🇳"), ("ru", "Русский", "🇷🇺"),
        ("tr", "Türkçe", "🇹🇷"), ("pt-BR", "Português (Brasil)", "🇧🇷"),
    ]
    private static let key = "language"

    // RootView redraws everything with .id(lang) when it changes.
    @Published private(set) var lang = "en"
    // The saved choice; "" follows the iPhone's language.
    private(set) var choice = ""
    private var messages: [String: String] = [:]
    private let lock = NSLock()

    private init() {
        let saved = UserDefaults.standard.string(forKey: Self.key) ?? ""
        choice = Self.known(saved) ? saved : ""
        use(Self.resolve(choice))
    }

    func choose(_ code: String) {
        guard Self.known(code) else { return }
        choice = code
        UserDefaults.standard.set(code, forKey: Self.key)
        use(code)
    }

    static func known(_ code: String) -> Bool { languages.contains { $0.code == code } }

    // As on the desktop and Android: Simplified Chinese (not Traditional), Russian, Turkish, and any
    // Portuguese (Brazil, Portugal…) as Brazilian Portuguese; the rest English.
    static func resolve(_ pref: String, preferred: [String] = Locale.preferredLanguages) -> String {
        if known(pref) { return pref }
        guard let first = preferred.first?.lowercased() else { return "en" }
        if first.hasPrefix("zh") { return first.contains("hant") || first.hasSuffix("-tw") || first.hasSuffix("-hk") || first.hasSuffix("-mo") ? "en" : "zh-CN" }
        if first.hasPrefix("ru") { return "ru" }
        if first.hasPrefix("tr") { return "tr" }
        if first.hasPrefix("pt") { return "pt-BR" }
        return "en"
    }

    private func use(_ code: String) {
        var m: [String: String] = [:]
        if code != "en", let url = Bundle.main.url(forResource: code, withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let o = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            m = o.filter { !$0.value.isEmpty }
        }
        lock.lock(); messages = m; lock.unlock()
        if Thread.isMainThread { lang = code } else { DispatchQueue.main.async { self.lang = code } }
    }

    // "camera|Back": one English word with another meaning there; English shows what follows the |.
    func text(_ key: String) -> String {
        lock.lock(); let v = messages[key]; lock.unlock()
        if let v { return v }
        guard let bar = key.firstIndex(of: "|") else { return key }
        return String(key[key.index(after: bar)...])
    }

    // For the web pages (the Remote, the screen viewer): their TD.tr, as on Android.
    var webScript: String {
        lock.lock(); let m = messages; lock.unlock()
        let json = (try? JSONSerialization.data(withJSONObject: m)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return """
        (() => {
          const m = \(json);
          window.TD = window.TD || {};
          window.TD.tr = (text, vars) => {
            let v = {}; try { v = JSON.parse(vars || '{}'); } catch (e) {}
            const s = m[text] || text.replace(/^[^|]*\\|/, '');
            return s.replace(/\\{(\\w+)\\}/g, (x, k) => (k in v ? String(v[k]) : x));
          };
        })();
        """
    }
}

private let trVar = try! NSRegularExpression(pattern: "\\{(\\w+)\\}")

// The text in this iPhone's language. {name} parts are filled once, so braces in a device's name
// stay as they are.
func tr(_ text: String, _ vars: [String: Any] = [:]) -> String {
    let s = I18n.shared.text(text)
    if vars.isEmpty { return s }
    let ns = s as NSString
    var out = ""
    var at = 0
    for m in trVar.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
        out += ns.substring(with: NSRange(location: at, length: m.range.location - at))
        let name = ns.substring(with: m.range(at: 1))
        if let v = vars[name] { out += plain(v) } else { out += ns.substring(with: m.range) }
        at = m.range.location + m.range.length
    }
    return out + ns.substring(from: at)
}

// A value as text; an optional shows what it holds, not "Optional(…)".
private func plain(_ v: Any) -> String {
    let m = Swift.Mirror(reflecting: v)
    if m.displayStyle == .optional { return m.children.first.map { plain($0.value) } ?? "" }
    return "\(v)"
}

// "1 file" / "3 files", in this iPhone's language.
func trCount(_ n: Int, _ what: String) -> String { n == 1 ? tr("1 \(what)") : tr("{count} \(what)s", ["count": n]) }
