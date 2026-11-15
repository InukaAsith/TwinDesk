// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Search: the settings, shortcuts and features, found by what they do ("share pc audio to phone",
// "phone audio on pc", "dark mode"), and the pages by name — the tab at the tab bar's right end,
// More's search field, ⌘K on an iPad keyboard. The entries and words are the computers'
// (shared/search-index.js → SearchIndex.swift); the matcher is the same as theirs.
//
// Arrange: the pages in the order the person likes, and how many are tabs (the rest under More,
// the iPad's sidebar in the same order). General and About stay last. From More's Edit, or
// General › Page order. As the computers' Arrange (shared/ui-arrange.js) and Android's.
import SwiftUI

// MARK: - Arrange

enum NavOrder {
    private static let key = "nav.order"
    static let minBar = 2, maxBar = 5
    static let fixed: [Page] = [.general, .about]
    struct Saved: Codable { var order: [String]; var bar: Int }

    // How many pages the bar can hold beside More (and Search). iOS 26's system bar takes five
    // tabs, Search one of them, before it makes a More of its own; TwinDesk's own bar, all five.
    static func barLimit(search: Bool) -> Int {
        if #available(iOS 26.0, *) { return search ? 3 : 4 }
        return maxBar
    }

    // Once: a bar saved at three while Search took the fourth place, with Search off now, gets it back.
    static func migrate() {
        let k = "nav.bar4"
        guard !UserDefaults.standard.bool(forKey: k) else { return }
        UserDefaults.standard.set(true, forKey: k)
        guard !searchButton, barLimit(search: false) > barLimit(search: true), let s = load(), s.bar == barLimit(search: true) else { return }
        if let d = try? JSONEncoder().encode(Saved(order: s.order, bar: s.bar + 1)) { UserDefaults.standard.set(d, forKey: key) }
    }

    static func load() -> Saved? {
        guard let d = UserDefaults.standard.data(forKey: key), let s = try? JSONDecoder().decode(Saved.self, from: d), !s.order.isEmpty else { return nil }
        return Saved(order: s.order, bar: min(max(s.bar, minBar), maxBar))
    }

    static func save(_ order: [Page], bar: Int) {
        if let d = try? JSONEncoder().encode(Saved(order: order.map(\.rawValue), bar: min(max(bar, minBar), maxBar))) { UserDefaults.standard.set(d, forKey: key) }
        AppUI.shared.navVersion += 1
    }

    static func reset() {
        UserDefaults.standard.removeObject(forKey: key)
        UserDefaults.standard.removeObject(forKey: searchKey)
        AppUI.shared.navVersion += 1
    }

    // The Search button at the bar's right end (More's search field stays either way). As Android's.
    private static let searchKey = "nav.search"
    static var searchButton: Bool { UserDefaults.standard.object(forKey: searchKey) as? Bool ?? false } // off unless chosen
    static func setSearchButton(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: searchKey)
        AppUI.shared.navVersion += 1
    }

    // The pages but General and About, in the saved order; one new since keeps its place after
    // the one it follows by default.
    static func ordered() -> [Page] {
        let all = Page.allCases.filter { !fixed.contains($0) }
        guard let s = load() else { return all }
        var rank: [String: Double] = [:]
        for (i, id) in s.order.enumerated() where rank[id] == nil { rank[id] = Double(i) }
        var last = -1.0
        return all.map { p -> (Double, Page) in let k = rank[p.rawValue] ?? (last + 0.001); last = k; return (k, p) }
            .sorted { $0.0 < $1.0 }.map(\.1)
    }
}

extension Page {
    // Shown now: with a phone, only what it and this one can do; Messages only then; the Deck while offered.
    func shown(_ core: Core) -> Bool {
        core.peerMode ? peerShows(self, core.peer) : self != .messages && (self != .deck || core.deck.offered)
    }
}

struct ArrangeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var pages: [Page] = NavOrder.ordered()
    @State private var bar: Int = min(NavOrder.load()?.bar ?? Page.bottom.count, NavOrder.barLimit(search: NavOrder.searchButton))
    @State private var search: Bool = NavOrder.searchButton

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Stepper(value: $bar, in: NavOrder.minBar...NavOrder.barLimit(search: search)) {
                        HStack { Text(tr("In the bar")); Spacer(); Text("\(bar)").foregroundStyle(.secondary) }
                    }
                    Toggle(tr("Search button"), isOn: $search)
                        // Search off: its place in the bar goes to one more page; on: the bar gives one back.
                        .onChange(of: search) { on in let d = NavOrder.barLimit(search: false) - NavOrder.barLimit(search: true); bar = min(max(bar + (on ? -d : d), NavOrder.minBar), NavOrder.barLimit(search: on)) }
                } footer: { Text(tr("The first ones are in the bottom bar, the rest under More.")) }
                Section {
                    ForEach(Array(pages.enumerated()), id: \.element) { i, p in
                        HStack(spacing: 12) {
                            Image(systemName: p.icon).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                                .frame(width: 28, height: 28).background(p.color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                            Text(p.title)
                            Spacer()
                            if i < bar { Text(tr("In the bar")).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    .onMove { from, to in pages.move(fromOffsets: from, toOffset: to) }
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle(tr("Arrange the pages"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(tr("Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(tr("Done")) { NavOrder.save(pages, bar: bar); NavOrder.setSearchButton(search); dismiss() }.bold() }
                ToolbarItem(placement: .bottomBar) { Button(tr("Reset"), role: .destructive) { NavOrder.reset(); dismiss() } }
            }
        }
    }
}

// MARK: - Search

enum SearchMatch {
    struct Item: Identifiable {
        let en: String, title: String, k: String, page: String, dir: String, whereName: String, isPage: Bool
        var id: String { (isPage ? "p:" : "e:") + en }
    }
    private struct Tok { let raw: String; let w: String }

    // Words: lower case, letters and digits, one word for synonyms, a plural's s gone.
    private static func tokens(_ s: String, keepStop: Bool = false) -> [Tok] {
        s.lowercased().folding(options: .diacriticInsensitive, locale: nil)
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty && (keepStop || !SearchIndex.stop.contains($0)) }
            .map { raw in
                var w = SearchIndex.syn[raw] ?? raw
                if w.count > 3 && w.hasSuffix("s") && !w.hasSuffix("ss") { w.removeLast() }
                return Tok(raw: raw, w: SearchIndex.syn[w] ?? w)
            }
    }

    // Which way the query goes: "c2p" (pc audio to phone), "p2c" (phone audio on pc), or "".
    private static func direction(_ q: String) -> String {
        let ws = tokens(q, keepStop: true).map(\.w)
        var devs: [(Character, Bool)] = []
        for (i, w) in ws.enumerated() {
            let d: Character? = w == "computer" ? "c" : w == "phone" ? "p" : nil
            if let d { devs.append((d, i > 0 && SearchIndex.to.contains(ws[i - 1]))) }
        }
        guard let first = devs.first else { return "" }
        if devs.count == 1 { return first.1 ? (first.0 == "p" ? "c2p" : "p2c") : (first.0 == "p" ? "p2c" : "c2p") }
        if !devs.contains(where: { $0.0 != first.0 }) { return "" }
        return first.0 == "c" ? "c2p" : "p2c"
    }

    static func match(_ q: String, _ items: [Item]) -> [Item] {
        var seen = Set<String>()
        let qt = tokens(q).filter { seen.insert($0.w).inserted }
        if qt.isEmpty { return [] }
        let qs = qt.map(\.w)
        let dir = direction(q)
        var hits: [(Item, Double, Int)] = []
        for (i, e) in items.enumerated() {
            let tk = tokens(e.en) + tokens(e.k) + tokens(e.title) + tokens(e.whereName)
            let bag = Set(tk.map(\.w))
            let all = Array(bag) + tk.map(\.raw)
            var s = 0.0, most = 0.0
            for t in qt {
                let wt = SearchIndex.light.contains(t.w) ? 0.4 : 1.0
                most += wt
                if bag.contains(t.w) { s += wt }
                else if t.raw.count >= 2 && all.contains(where: { $0.hasPrefix(t.raw) || $0.hasPrefix(t.w) }) { s += 0.7 * wt }
                else if t.w.count >= 4 && all.contains(where: { $0.count >= 4 && t.w.hasPrefix($0) }) { s += 0.5 * wt }
            }
            var score = s / most
            if score < (qs.count >= 3 ? 0.6 : 0.5) { continue }
            if !dir.isEmpty && !e.dir.isEmpty { score += e.dir == dir ? 0.3 : -0.3 }
            if tokens(e.title).map(\.w).joined(separator: " ").hasPrefix(qs.joined(separator: " ")) { score += 0.2 }
            hits.append((e, score, i))
        }
        return hits.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.2 < $1.2 }.map(\.0)
    }

    // The pages shown now and the entries on them.
    static func items(_ pages: [Page]) -> [Item] {
        let ids = Set(pages.map(\.rawValue))
        return pages.map { Item(en: $0.rawValue, title: $0.title, k: $0.rawValue, page: $0.rawValue, dir: "", whereName: "", isPage: true) } +
            SearchIndex.entries.filter { ids.contains($0.page) }.map { e in
                Item(en: e.en, title: e.title(), k: e.k, page: e.page, dir: e.dir, whereName: Page(rawValue: e.page)?.title ?? "", isPage: false)
            }
    }
}

// The search page: the field, then what's found; a tap opens its page. As a tab, it pushes the
// page over itself; as a sheet (More, the iPad, ⌘K), it closes and opens the page.
struct SearchView: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    var sheet = false
    @Environment(\.dismiss) private var dismiss
    @State private var q = ""
    @FocusState private var focused: Bool

    var body: some View {
        let _ = core.tick
        let items = SearchMatch.items(Page.allCases.filter { $0.shown(core) })
        let found = Array(SearchMatch.match(q, items).prefix(20))
        List {
            if found.isEmpty {
                Text(q.trimmingCharacters(in: .whitespaces).isEmpty ? tr("Try “share pc audio to phone”, “dark mode” or “send a file”") : tr("Nothing found"))
                    .font(.subheadline).foregroundStyle(.secondary).listRowBackground(Color.clear)
            }
            ForEach(found) { it in
                Button { pick(it) } label: {
                    HStack {
                        Text(it.title).foregroundStyle(TDColor.text).lineLimit(2)
                        Spacer()
                        Text(it.isPage ? tr("Page") : it.whereName).font(.footnote).foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .listRowBackground(TDColor.card)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Backdrop())
        .safeAreaInset(edge: .top) { field }
        .navigationTitle(tr("Search"))
        .navigationBarTitleDisplayMode(sheet ? .inline : .large)
        .toolbar { if sheet { ToolbarItem(placement: .cancellationAction) { Button(tr("Cancel")) { dismiss() } } } }
        .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { focused = true } }
    }

    private var field: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField(tr("Search settings and features"), text: $q)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit {
                    let items = SearchMatch.items(Page.allCases.filter { $0.shown(core) })
                    if let f = SearchMatch.match(q, items).first { pick(f) }
                }
            if !q.isEmpty { Button { q = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) } }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background(TDColor.card, in: Capsule())
        .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 4)
    }

    private func pick(_ it: SearchMatch.Item) {
        guard let p = Page(rawValue: it.page) else { return }
        focused = false
        if sheet {
            dismiss()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { ui.open(p) }
        } else {
            ui.open(p)
        }
    }
}

// More's search field (and the iPad's sidebar): a tap opens Search.
struct SearchFieldButton: View {
    @EnvironmentObject var ui: AppUI
    var body: some View {
        Button { ui.searching = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                Text(tr("Search settings and features")).lineLimit(1)
                Spacer()
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(TDColor.card, in: Capsule())
        }
        .buttonStyle(PressScale())
    }
}
