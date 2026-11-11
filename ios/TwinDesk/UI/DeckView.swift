// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck page (Core/Deck.swift; android/…/Deck.kt has the same): the computer's spaces as chips;
// a tile space's pages (swiped sideways when the layout allows it, three fingers for the next space),
// tiles of any size on the page's grid, sliders that set a level live as they're dragged. A window
// space: the running apps there, the layouts drawn on the computer (swiped, a zone tapped puts the
// window there), the displays. Edit: a tile's action, look and size; tiles and pages added or removed.
import SwiftUI
import UIKit

func deckColor(_ hex: String) -> Color {
    let h = hex.lowercased()
    guard h.count == 7, h.hasPrefix("#"), let n = UInt32(h.dropFirst(), radix: 16) else { return Color(white: 0.17) }
    return Color(red: Double(n >> 16 & 255) / 255, green: Double(n >> 8 & 255) / 255, blue: Double(n & 255) / 255)
}
private func isLight(_ hex: String) -> Bool {
    guard hex.count == 7, let n = UInt32(hex.dropFirst(), radix: 16) else { return false }
    return (0.2126 * Double(n >> 16 & 255) + 0.7152 * Double(n >> 8 & 255) + 0.0722 * Double(n & 255)) / 255 > 0.62
}
let deckColors = ["#2c2c2e", "#0a84ff", "#30b94d", "#ff9f0a", "#ff3b30", "#bf5af2", "#5e5ce6", "#64d2ff", "#ff2d55", "#ffd60a", "#a2845e", "#8e8e93"]

// What a tile is called (its label, or its action's name) and the symbol it shows.
func deckLabel(_ t: JSON, _ platform: String) -> String {
    let l = t.str("label", max: 40)
    if !l.isEmpty { return l }
    return DeckCatalog.entry(t.obj("action")).map { tr($0.name(platform)) } ?? ""
}
func deckIcon(_ t: JSON) -> String { let i = t.str("icon", max: 16); return i.isEmpty ? DeckCatalog.symbolOf(t.obj("action")) : i }

// A Deck symbol (an SF Symbol), or an emoji.
struct DeckGlyph: View {
    let icon: String
    var size: CGFloat = 22
    var body: some View {
        if let sf = DeckCatalog.sf[icon] { Image(systemName: sf).font(.system(size: size, weight: .semibold)) }
        else { Text(icon).font(.system(size: size)) }
    }
}

private func level(_ a: JSON, _ s: JSON?) -> Double? {
    guard let s = s else { return nil }
    switch a.str("what") {
    case "volume": return (s["volume"] as? NSNumber)?.doubleValue
    case "mic": return (s["micVolume"] as? NSNumber)?.doubleValue
    default:
        let ds = (s["displays"] as? [JSON]) ?? []
        let d = ds.first { a.str("display").isEmpty || $0.str("id") == a.str("display") }
        return (d?["level"] as? NSNumber)?.doubleValue
    }
}
private func pct(_ v: Double) -> String { "\(Int((v * 100).rounded()))%" }

// The line under a tile's name: a level, a device, on or off.
private func stateText(_ a: JSON, _ s: JSON?) -> String {
    guard let s = s else { return "" }
    let w = a.str("what")
    switch a.str("k") {
    case "slider": return level(a, s).map(pct) ?? ""
    case "volume": return ["toggle", "mute", "unmute"].contains(w) ? (s.bool("muted") ? tr("Muted") : pct((s["volume"] as? NSNumber)?.doubleValue ?? 0)) : ""
    case "mic": return s.bool("micMuted") ? tr("Muted") : tr("Live")
    case "output", "input":
        let ds = (s[a.str("k") == "output" ? "outputs" : "inputs"] as? [JSON]) ?? []
        return ds.first { a.str("id").isEmpty ? $0.bool("on") : $0.str("id") == a.str("id") }?.str("name", max: 60) ?? ""
    case "bt":
        guard let bt = s.obj("bt") else { return "" }
        if !a.str("id").isEmpty {
            guard let d = ((bt["devices"] as? [JSON]) ?? []).first(where: { $0.str("id") == a.str("id") }) else { return "" }
            return d.bool("connected") ? tr("Connected") : tr("Not connected")
        }
        return bt.bool("radio") ? tr("On") : tr("Off")
    case "sys": return w == "darkmode" ? (s.bool("dark") ? tr("Dark") : tr("Light")) : ""
    default: return ""
    }
}

struct DeckView: View {
    @EnvironmentObject var core: Core
    @State private var spaceId = ""
    @State private var pageOf: [String: String] = [:]
    @State private var editing = false

    var body: some View {
        let _ = core.tick
        let d = core.deck
        let spaces = d.spaces
        PageScroll(title: tr("Deck")) {
            if !core.connected { NeedsComputer(what: tr("Deck")) }
            else if d.layout == nil || spaces.isEmpty {
                Text(tr("Waiting for {name}…", ["name": core.host?.name ?? ""])).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).glassCard()
            } else {
                let space = spaces.first { $0.str("id") == spaceId } ?? spaces[0]
                VStack(alignment: .leading, spacing: 14) {
                    spaceBar(spaces, space)
                    if space.str("kind") == "windows" { DeckWindowSpace(space: space) }
                    else { DeckTileSpace(space: space, pageId: Binding(get: { pageOf[space.str("id")] ?? "" }, set: { pageOf[space.str("id")] = $0 }), editing: editing, toSpace: { go(to: $0) }) }
                    if let why = d.done?.why, !why.isEmpty, why != "busy" {
                        Label(tr(why), systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(TDColor.bad)
                    }
                }
                .glassCard()
                .background(ThreeFingerSwipe(enabled: d.swipeSpaces && !editing) { dir in step(dir) })
            }
        }
        .task {
            while !Task.isCancelled {
                if core.connected && core.deck.layout != nil { core.deck.askState() }
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    private func go(to id: String) { if core.deck.spaces.contains(where: { $0.str("id") == id }) { withAnimation(.easeOut(duration: 0.2)) { spaceId = id } } }
    private func step(_ dir: Int) {
        let ss = core.deck.spaces
        let i = ss.firstIndex { $0.str("id") == spaceId } ?? 0
        let j = max(0, min(ss.count - 1, i + dir))
        if j != i { UIImpactFeedbackGenerator(style: .light).impactOccurred(); go(to: ss[j].str("id")) }
    }

    private func spaceBar(_ spaces: [JSON], _ space: JSON) -> some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(spaces.indices, id: \.self) { i in
                        let s = spaces[i]
                        let on = s.str("id") == space.str("id")
                        Button { go(to: s.str("id")) } label: {
                            Label(s.str("name", max: 30), systemImage: s.str("kind") == "windows" ? "display" : "square.grid.2x2.fill")
                                .font(.subheadline.weight(on ? .semibold : .regular))
                                .padding(.horizontal, 12).padding(.vertical, 7)
                                .foregroundStyle(on ? Color.white : TDColor.text)
                                .background(on ? TDColor.accent : TDColor.control, in: Capsule())
                        }.buttonStyle(PressScale())
                    }
                }
            }
            if space.str("kind") != "windows" {
                Button(editing ? tr("Done") : tr("Edit")) { withAnimation(.easeOut(duration: 0.18)) { editing.toggle() } }
                    .font(.subheadline.weight(editing ? .semibold : .regular))
            }
        }
    }
}

// ---- a tile space ----

private struct EditTarget: Identifiable { let id: String }

struct DeckTileSpace: View {
    @EnvironmentObject var core: Core
    let space: JSON
    @Binding var pageId: String
    let editing: Bool
    let toSpace: (String) -> Void
    @State private var width: CGFloat = 320
    @State private var sliding = false
    @State private var open: EditTarget?
    private let gap: CGFloat = 8

    var body: some View {
        let d = core.deck
        let pages = (space["pages"] as? [JSON]) ?? []
        let idx = max(0, pages.firstIndex { $0.str("id") == pageId } ?? 0)
        VStack(alignment: .leading, spacing: 12) {
            pageBar(pages, idx)
            if pages.isEmpty { Text(tr("No pages")).foregroundStyle(.secondary) }
            else {
                grid(pages[min(idx, pages.count - 1)], pages: pages, idx: idx)
                    .id(pages[min(idx, pages.count - 1)].str("id"))
                    .transition(.opacity)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(GeometryReader { g in Color.clear.onAppear { width = g.size.width }.onChange(of: g.size.width) { w in width = w } })
                    .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { v in
                        defer { sliding = false }
                        guard d.swipePages, !editing, !sliding, abs(v.translation.width) > 60, abs(v.translation.width) > abs(v.translation.height) * 1.5 else { return }
                        turn(pages, idx + (v.translation.width < 0 ? 1 : -1))
                    })
                if pages.count > 1 {
                    HStack(spacing: 6) {
                        ForEach(pages.indices, id: \.self) { i in Circle().fill(i == idx ? TDColor.text : TDColor.muted.opacity(0.4)).frame(width: 7, height: 7) }
                    }.frame(maxWidth: .infinity)
                }
            }
            if editing {
                Text(tr("Tap a tile to set it up, or an empty place to add one. Move and resize tiles by dragging on {name}’s Deck page.", ["name": core.host?.name ?? ""]))
                    .font(.caption).foregroundStyle(.secondary)
                if pages.count > 1, idx < pages.count {
                    Button(tr("Delete this page"), role: .destructive) {
                        let pid = pages[idx].str("id")
                        d.edit { l in Deck.mapSpaces(&l) { s in if s.str("id") == space.str("id") { s["pages"] = ((s["pages"] as? [JSON]) ?? []).filter { $0.str("id") != pid } } } }
                        pageId = ""
                    }.font(.subheadline)
                }
            }
        }
        .sheet(item: $open) { t in DeckTileEditor(tileId: t.id).environmentObject(core) }
    }

    private func turn(_ pages: [JSON], _ i: Int) {
        guard i >= 0, i < pages.count else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        withAnimation(.easeOut(duration: 0.2)) { pageId = pages[i].str("id") }
    }

    private func pageBar(_ pages: [JSON], _ idx: Int) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(pages.indices, id: \.self) { i in
                    Button { turn(pages, i) } label: {
                        Text(pages[i].str("name", max: 30)).font(.footnote.weight(i == idx ? .semibold : .regular))
                            .padding(.horizontal, 12).padding(.vertical, 5)
                            .foregroundStyle(TDColor.text)
                            .background(i == idx ? TDColor.text.opacity(0.14) : Color.clear, in: Capsule())
                            .overlay(Capsule().strokeBorder(TDColor.line))
                    }.buttonStyle(PressScale())
                }
                if editing {
                    Button {
                        let id = Deck.newId("p")
                        core.deck.edit { l in Deck.mapSpaces(&l) { s in
                            guard s.str("id") == space.str("id") else { return }
                            var ps = (s["pages"] as? [JSON]) ?? []
                            ps.append(["id": id, "name": tr("Page {n}", ["n": ps.count + 1]), "cols": 4, "rows": 4, "tiles": [JSON]()])
                            s["pages"] = ps
                        } }
                        pageId = id
                    } label: { Image(systemName: "plus").padding(.horizontal, 12).padding(.vertical, 6).overlay(Capsule().strokeBorder(TDColor.line)) }
                }
            }
        }
    }

    @ViewBuilder
    private func grid(_ p: JSON, pages: [JSON], idx: Int) -> some View {
        let cols = max(2, min(8, p.int("cols", 4))), rows = max(2, min(8, p.int("rows", 4)))
        let w = min(width, 560)
        let cell = max(20, (w - gap * CGFloat(cols - 1)) / CGFloat(cols))
        let tiles = (p["tiles"] as? [JSON]) ?? []
        ZStack(alignment: .topLeading) {
            Color.clear.frame(width: w, height: cell * CGFloat(rows) + gap * CGFloat(rows - 1))
            if editing {
                let taken = Set(tiles.flatMap { t in (0..<t.int("w", 1)).flatMap { dx in (0..<t.int("h", 1)).map { dy in (t.int("y") + dy) * cols + t.int("x") + dx } } })
                ForEach(0..<(rows * cols), id: \.self) { n in
                    if !taken.contains(n) {
                        Button { add(p, x: n % cols, y: n / cols) } label: {
                            Image(systemName: "plus").foregroundStyle(.secondary)
                                .frame(width: cell, height: cell)
                                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(TDColor.line))
                        }
                        .offset(x: (cell + gap) * CGFloat(n % cols), y: (cell + gap) * CGFloat(n / cols))
                    }
                }
            }
            ForEach(tiles.indices, id: \.self) { i in
                DeckTile(tile: tiles[i], cell: cell, gap: gap, editing: editing, sliding: $sliding) { tap(tiles[i], pages: pages, idx: idx) }
            }
        }
    }

    private func add(_ p: JSON, x: Int, y: Int) {
        let id = Deck.newId("t")
        core.deck.edit { l in Deck.editPage(&l, p.str("id")) { pg in
            var ts = (pg["tiles"] as? [JSON]) ?? []
            ts.append(["id": id, "x": x, "y": y, "w": 1, "h": 1, "label": "", "icon": "", "color": "#0a84ff", "action": ["k": "none"]])
            pg["tiles"] = ts
        } }
        open = EditTarget(id: id)
    }

    private func tap(_ t: JSON, pages: [JSON], idx: Int) {
        let d = core.deck
        let a = t.obj("action") ?? [:]
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if editing { open = EditTarget(id: t.str("id")); return }
        switch a.str("k") {
        case "nav":
            switch a.str("what") {
            case "page": if let i = pages.firstIndex(where: { $0.str("id") == a.str("to") }) { turn(pages, i) }
            case "next": turn(pages, idx + 1)
            case "prev": turn(pages, idx - 1)
            case "space": toSpace(a.str("to"))
            default:
                let ss = d.spaces
                let i = (ss.firstIndex { $0.str("id") == space.str("id") } ?? 0) + (a.str("what") == "nextspace" ? 1 : -1)
                if i >= 0, i < ss.count { toSpace(ss[i].str("id")) }
            }
        case "none": break
        default: if d.runs(a) { d.run(t.str("id")) }
        }
    }
}

// One tile at its place: its symbol, name and state; a slider's bar follows a drag.
struct DeckTile: View {
    @EnvironmentObject var core: Core
    let tile: JSON
    let cell: CGFloat
    let gap: CGFloat
    let editing: Bool
    @Binding var sliding: Bool
    let onTap: () -> Void
    @State private var drag: Double?

    var body: some View {
        let d = core.deck
        let a = tile.obj("action") ?? [:]
        let w = tile.int("w", 1), h = tile.int("h", 1)
        let hex = tile.str("color", max: 7)
        let fg: Color = isLight(hex) ? Color(white: 0.11) : .white
        let runs = d.runs(a)
        let id = tile.str("id")
        let failed = d.done.map { $0.id == id && !$0.why.isEmpty && $0.why != "busy" } ?? false
        let slider = a.str("k") == "slider" && !editing && runs
        let value = drag ?? level(a, d.state)
        let sub = slider ? (value.map(pct) ?? "") : stateText(a, d.state)
        let label = deckLabel(tile, d.platform)
        let width = cell * CGFloat(w) + gap * CGFloat(w - 1), height = cell * CGFloat(h) + gap * CGFloat(h - 1)
        content(w: w, h: h, fg: fg, label: label, sub: sub, slider: a.str("k") == "slider", value: value)
            .padding(w == 1 && h == 1 ? 6 : 12)
            .frame(width: width, height: height)
            .background(deckColor(hex), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(failed ? TDColor.bad : .clear, lineWidth: 2))
            .opacity(runs ? 1 : 0.4)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .gesture(slider ? DragGesture(minimumDistance: 0).onChanged { g in
                sliding = true
                let v = max(0, min(1, g.location.x / max(1, width)))
                drag = v
                d.set(id, v)
            }.onEnded { _ in drag = nil } : nil)
            .onTapGesture { if !slider { onTap() } }
            .offset(x: (cell + gap) * CGFloat(tile.int("x")), y: (cell + gap) * CGFloat(tile.int("y")))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder
    private func content(w: Int, h: Int, fg: Color, label: String, sub: String, slider: Bool, value: Double?) -> some View {
        let icon = deckIcon(tile)
        if w == 1 {
            VStack(spacing: 4) {
                DeckGlyph(icon: icon, size: h == 1 ? 20 : 24)
                if !label.isEmpty { Text(label).font(.system(size: 11, weight: .semibold)).lineLimit(2).multilineTextAlignment(.center) }
                if h > 1 && !sub.isEmpty { Text(sub).font(.system(size: 11)).opacity(0.72).lineLimit(1) }
            }
            .foregroundStyle(fg).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if h > 1 { Spacer(minLength: 0) }
                HStack(spacing: 10) {
                    DeckGlyph(icon: icon, size: 24)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(label).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                        if !sub.isEmpty { Text(sub).font(.system(size: 11.5)).opacity(0.72).lineLimit(1) }
                    }
                    Spacer(minLength: 0)
                }
                if slider {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(fg.opacity(0.22))
                            Capsule().fill(fg.opacity(0.95)).frame(width: g.size.width * CGFloat(value ?? 0))
                        }
                    }.frame(height: 6)
                }
            }
            .foregroundStyle(fg).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}

// Three fingers sideways anywhere: the next (left) or previous (right) space. A pan recognizer on
// the window, as SwiftUI can't count fingers; it doesn't cancel the touches under it.
struct ThreeFingerSwipe: UIViewRepresentable {
    let enabled: Bool
    let onSwipe: (Int) -> Void

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onSwipe: (Int) -> Void = { _ in }
        var enabled = true
        weak var pan: UIPanGestureRecognizer?
        var fired = false
        @objc func panned(_ g: UIPanGestureRecognizer) {
            guard enabled else { return }
            switch g.state {
            case .began: fired = false
            case .changed:
                let t = g.translation(in: g.view)
                if !fired, abs(t.x) > 80, abs(t.x) > abs(t.y) * 1.3 { fired = true; onSwipe(t.x < 0 ? 1 : -1) }
            default: break
            }
        }
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Anchor: UIView {
        var coordinator: Coordinator?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let c = coordinator else { return }
            if let p = c.pan { p.view?.removeGestureRecognizer(p) }
            guard let w = window else { return }
            let p = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.panned(_:)))
            p.minimumNumberOfTouches = 3
            p.maximumNumberOfTouches = 3
            p.cancelsTouchesInView = false
            p.delegate = c
            w.addGestureRecognizer(p)
            c.pan = p
        }
    }

    func makeUIView(context: Context) -> Anchor {
        let v = Anchor()
        v.isUserInteractionEnabled = false
        v.coordinator = context.coordinator
        return v
    }
    func updateUIView(_ v: Anchor, context: Context) {
        context.coordinator.onSwipe = onSwipe
        context.coordinator.enabled = enabled
    }
    static func dismantleUIView(_ v: Anchor, coordinator: Coordinator) {
        if let p = coordinator.pan { p.view?.removeGestureRecognizer(p) }
    }
}

// ---- the window space ----

private var iconCache: [String: UIImage] = [:]
private func appIcon(_ data: String) -> UIImage? {
    if data.isEmpty { return nil }
    if let i = iconCache[data] { return i }
    let b64 = data.components(separatedBy: ",").last ?? data
    guard let d = Data(base64Encoded: b64), let img = UIImage(data: d) else { return nil }
    iconCache[data] = img
    return img
}

struct DeckWindowSpace: View {
    @EnvironmentObject var core: Core
    let space: JSON
    @State private var appKey: String?
    @State private var wid: Int64?
    @State private var display: String?
    @State private var layoutIdx = 0

    var body: some View {
        let d = core.deck
        VStack(alignment: .leading, spacing: 12) {
            if (d.caps?["windows"] as? NSNumber)?.boolValue == false { Text(tr("Not on this computer")).foregroundStyle(.secondary) }
            else if let w = d.wins { content(w) }
            else { Text(tr("Loading windows…")).foregroundStyle(.secondary) }
            Text(tr("Draw your own layouts on the computer’s Deck page.")).font(.caption).foregroundStyle(.secondary)
        }
        .task(id: space.str("id")) {
            while !Task.isCancelled {
                core.deck.askWins()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    @ViewBuilder
    private func content(_ w: JSON) -> some View {
        let apps = (w["apps"] as? [JSON]) ?? []
        let displays = (w["displays"] as? [JSON]) ?? []
        let front = w.int64("front")
        let app = apps.first { $0.str("key") == appKey }
            ?? apps.first { (($0["windows"] as? [JSON]) ?? []).contains { $0.int64("wid") == front } } ?? apps.first
        if !w.str("why").isEmpty { Label(tr(w.str("why", max: 300)), systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(TDColor.bad) }
        if let app = app {
            let windows = (app["windows"] as? [JSON]) ?? []
            let win = windows.first { $0.int64("wid") == wid } ?? windows.first { $0.int64("wid") == front } ?? windows.first
            Text(tr("App")).font(.caption).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(apps.indices, id: \.self) { i in
                        let a = apps[i]
                        let on = a.str("key") == app.str("key")
                        Button { appKey = a.str("key"); wid = nil; display = nil } label: {
                            VStack(spacing: 4) {
                                if let img = appIcon(a.str("icon", max: 400_000)) { Image(uiImage: img).resizable().frame(width: 40, height: 40) }
                                else {
                                    Text(String(a.str("name").prefix(1)).uppercased()).font(.headline)
                                        .frame(width: 40, height: 40).background(TDColor.control, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                }
                                Text(a.str("name", max: 40)).font(.caption2).lineLimit(1).foregroundStyle(TDColor.text)
                            }
                            .frame(width: 64).padding(6)
                            .background(on ? TDColor.accent.opacity(0.22) : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }.buttonStyle(PressScale())
                    }
                }
            }
            if windows.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(windows.indices, id: \.self) { i in
                            let x = windows[i]
                            let on = x.int64("wid") == win?.int64("wid")
                            Button { wid = x.int64("wid"); display = nil } label: {
                                Text(x.str("title", max: 50).isEmpty ? tr("Window") : x.str("title", max: 50)).font(.footnote).lineLimit(1)
                                    .padding(.horizontal, 12).padding(.vertical, 6)
                                    .foregroundStyle(on ? Color.white : TDColor.text)
                                    .background(on ? TDColor.accent : TDColor.control, in: Capsule())
                            }.buttonStyle(PressScale())
                        }
                    }
                }
            }
            if let win = win { placing(win, displays) }
        } else {
            Text(tr("No windows open")).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func placing(_ win: JSON, _ displays: [JSON]) -> some View {
        let d = core.deck
        let layouts = (space["layouts"] as? [JSON]) ?? []
        let to = display ?? win.str("display")
        if !layouts.isEmpty {
            let i = min(layoutIdx, layouts.count - 1)
            Text(layouts[i].str("name", max: 30)).font(.caption).foregroundStyle(.secondary)
            TabView(selection: $layoutIdx) {
                ForEach(layouts.indices, id: \.self) { n in
                    let zones = (layouts[n]["zones"] as? [JSON]) ?? []
                    GeometryReader { g in
                        let u = g.size.width / 12, v = g.size.height / 12
                        ZStack(alignment: .topLeading) {
                            RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(red: 0.11, green: 0.16, blue: 0.27))
                            ForEach(zones.indices, id: \.self) { z in
                                let zone = zones[z]
                                Button {
                                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                    d.place(win.int64("wid"), display: to, zone: zone)
                                } label: {
                                    Text("\(z + 1)").font(.headline).foregroundStyle(.white)
                                        .frame(width: max(1, u * CGFloat(zone.int("w", 1)) - 6), height: max(1, v * CGFloat(zone.int("h", 1)) - 6))
                                        .background(Color(red: 0.04, green: 0.52, blue: 1).opacity(0.35), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(red: 0.39, green: 0.82, blue: 1), lineWidth: 1.5))
                                }
                                .buttonStyle(PressScale())
                                .offset(x: u * CGFloat(zone.int("x")) + 3, y: v * CGFloat(zone.int("y")) + 3)
                            }
                        }
                    }
                    .padding(.horizontal, 2)
                    .tag(n)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: layouts.count > 1 ? .always : .never))
            .aspectRatio(16 / 10, contentMode: .fit)
        }
        if displays.count > 1 {
            Text(tr("Display")).font(.caption).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(displays.indices, id: \.self) { i in
                        let x = displays[i]
                        let on = x.str("id") == to
                        Button { display = x.str("id") } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(x.str("name", max: 40).isEmpty ? tr("Display") : x.str("name", max: 40)).font(.subheadline.weight(.medium)).lineLimit(1)
                                Text("\(x.int("w")) × \(x.int("h"))" + (x.bool("main") ? " · " + tr("Main") : "")).font(.caption2).opacity(0.8)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .foregroundStyle(on ? Color.white : TDColor.text)
                            .background(on ? TDColor.accent : TDColor.control, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }.buttonStyle(PressScale())
                    }
                }
            }
            if to != win.str("display") {
                Button(tr("Move the window to this display")) { d.place(win.int64("wid"), display: to, zone: nil) }.secondaryButton()
            }
        }
    }
}

// ---- setting up a tile ----

struct DeckTileEditor: View {
    @EnvironmentObject var core: Core
    @Environment(\.dismiss) private var dismiss
    let tileId: String
    @State private var loaded = false
    @State private var label = ""
    @State private var icon = ""
    @State private var emoji = ""
    @State private var color = "#0a84ff"
    @State private var w = 1
    @State private var h = 1
    @State private var action: JSON = ["k": "none"]
    @State private var pinned = false
    @State private var picking = false
    @State private var fresh = false // just added in an empty place: leaving without Save takes it away again
    @State private var saved = false

    var body: some View {
        let d = core.deck
        let e = DeckCatalog.entry(action)
        NavigationStack {
            Form {
                Section {
                    Button { picking = true } label: {
                        HStack(spacing: 12) {
                            DeckGlyph(icon: DeckCatalog.symbolOf(action), size: 20).frame(width: 28).foregroundStyle(TDColor.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(e.map { tr($0.name(d.platform)) } ?? tr("Label only")).foregroundStyle(TDColor.text)
                                if let e = e { Text(tr(e.desc(d.platform))).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                            }
                            Spacer()
                            Text(tr("Change")).font(.subheadline)
                        }
                    }
                    DeckActionOptions(action: $action)
                    if e?.local == true || action.str("k") == "macro" {
                        Text(tr("Set this one up on {name}’s Deck page.", ["name": core.host?.name ?? ""])).font(.caption).foregroundStyle(.secondary)
                    }
                } header: { Text(tr("Action")) }

                Section {
                    TextField(e.map { tr($0.name(d.platform)) } ?? tr("Label"), text: $label)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 7), spacing: 6) {
                        symbolCell(nil)
                        ForEach(DeckCatalog.symbols, id: \.self) { s in symbolCell(s) }
                    }
                    TextField(tr("Or an emoji"), text: $emoji)
                    HStack(spacing: 8) {
                        ForEach(deckColors, id: \.self) { c in
                            Circle().fill(deckColor(c)).frame(width: 24, height: 24)
                                .overlay(Circle().strokeBorder(TDColor.text, lineWidth: c == color ? 2.5 : 0))
                                .onTapGesture { color = c }
                        }
                    }
                } header: { Text(tr("Label")) }

                Section {
                    Stepper("\(tr("Wide")): \(w)", value: Binding(get: { w }, set: { v in if fits(v, h) { w = v } }), in: 1...4)
                    Stepper("\(tr("High")): \(h)", value: Binding(get: { h }, set: { v in if fits(w, v) { h = v } }), in: 1...4)
                } header: { Text(tr("Size")) }

                Section {
                    ToggleRow(title: tr("In the Overview’s quick actions"), detail: tr("Runs from the Overview too"), on: $pinned)
                }

                Section {
                    Button(tr("Delete"), role: .destructive) {
                        d.edit { l in Deck.mapPages(&l) { p in
                            let ts = (p["tiles"] as? [JSON]) ?? []
                            if ts.contains(where: { $0.str("id") == tileId }) { p["tiles"] = ts.filter { $0.str("id") != tileId } }
                        } }
                        TileLayout.pin(core.store, tileId, false)
                        dismiss()
                    }
                }
            }
            .navigationTitle(tr("Tile"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(tr("Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(tr("Save")) { save(); saved = true; dismiss() }.fontWeight(.semibold) }
            }
            .sheet(isPresented: $picking, onDismiss: { if fresh && action.str("k") == "none" { dismiss() } }) {
                DeckActionPicker { entry in
                    action = entry.action
                    if entry.wide && w == 1 && fits(2, h) { w = 2 }
                    if entry.k == "app" { core.deck.askApps() }
                    picking = false
                }.environmentObject(core)
            }
        }
        .onAppear(perform: load)
        .onDisappear {
            let id = tileId
            guard fresh, !saved, core.deck.find(id) != nil else { return }
            core.deck.edit { l in Deck.mapPages(&l) { p in
                if var ts = p["tiles"] as? [JSON], ts.contains(where: { $0.str("id") == id }) { ts.removeAll { $0.str("id") == id }; p["tiles"] = ts }
            } }
        }
    }

    private func symbolCell(_ s: String?) -> some View {
        let on = s == nil ? (icon.isEmpty && emoji.isEmpty) : icon == s
        return Group {
            if let s = s { DeckGlyph(icon: s, size: 15) } else { Text(tr("Auto")).font(.system(size: 9)) }
        }
        .frame(width: 34, height: 34)
        .foregroundStyle(on ? Color.white : TDColor.text)
        .background(on ? TDColor.accent : TDColor.control, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .onTapGesture { icon = s ?? ""; emoji = "" }
    }

    private func load() {
        guard !loaded, let (t, _) = core.deck.find(tileId) else { return }
        loaded = true
        label = t.str("label", max: 40)
        let i = t.str("icon", max: 16)
        if DeckCatalog.sf[i] != nil || i.isEmpty { icon = i } else { emoji = i }
        color = t.str("color", max: 7).isEmpty ? "#0a84ff" : t.str("color", max: 7)
        w = t.int("w", 1); h = t.int("h", 1)
        action = t.obj("action") ?? ["k": "none"]
        pinned = TileLayout.pinned(core.store, tileId)
        if action.str("k") == "none" && label.isEmpty { picking = true; fresh = true }
    }

    // Whether a size fits on the page from where the tile is, past no other tile.
    private func fits(_ nw: Int, _ nh: Int) -> Bool {
        guard let (t, p) = core.deck.find(tileId) else { return false }
        let x = t.int("x"), y = t.int("y")
        if x + nw > p.int("cols", 4) || y + nh > p.int("rows", 4) { return false }
        return !((p["tiles"] as? [JSON]) ?? []).contains { o in
            o.str("id") != tileId && x < o.int("x") + o.int("w", 1) && o.int("x") < x + nw && y < o.int("y") + o.int("h", 1) && o.int("y") < y + nh
        }
    }

    private func save() {
        let ic = emoji.trimmingCharacters(in: .whitespaces).isEmpty ? icon : String(emoji.trimmingCharacters(in: .whitespaces).prefix(16))
        let a = action
        core.deck.edit { l in Deck.editTile(&l, tileId) { t in
            t["label"] = String(label.prefix(40)); t["icon"] = ic; t["color"] = color; t["w"] = w; t["h"] = h; t["action"] = a
        } }
        TileLayout.pin(core.store, tileId, pinned)
    }
}

// The options of an action's kind: its shortcut, text, website, app, device, level, display, page.
struct DeckActionOptions: View {
    @EnvironmentObject var core: Core
    @Binding var action: JSON

    private func bind(_ k: String) -> Binding<String> { Binding(get: { action.str(k, max: 4000) }, set: { action[k] = $0 }) }
    private func set(_ kv: [String: Any]) { var a = action; for (k, v) in kv { a[k] = v }; action = a }

    var body: some View {
        let d = core.deck
        let k = action.str("k"), w = action.str("what"), s = d.state
        Group {
            switch k {
            case "keys":
                TextField(tr("Shortcut, like Mod+Shift+KeyS"), text: bind("combo")).autocorrectionDisabled().textInputAutocapitalization(.never)
                Text(tr("Mod is ⌘ on a Mac and Ctrl elsewhere. Or record it on the computer’s Deck page.")).font(.caption).foregroundStyle(.secondary)
            case "text":
                TextField(tr("Text"), text: bind("text"), axis: .vertical)
                Toggle(tr("Press Return after it"), isOn: Binding(get: { action.bool("enter") }, set: { action["enter"] = $0 }))
            case "url":
                TextField(tr("Website"), text: bind("url")).keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
            case "app":
                if let apps = d.apps { pick(apps.map { ($0.id, $0.name) }, action.str("id")) { id in set(["id": id, "name": apps.first { $0.id == id }?.name ?? ""]) } }
                else { Text(tr("Loading apps…")).foregroundStyle(.secondary) }
            case "output", "input":
                let ds = (s?[k == "output" ? "outputs" : "inputs"] as? [JSON]) ?? []
                pick(ds.map { ($0.str("id"), $0.str("name", max: 60)) }, action.str("id")) { id in set(["id": id, "name": ds.first { $0.str("id") == id }?.str("name", max: 80) ?? ""]) }
            case "bt" where ["connect", "disconnect", "toggleconn"].contains(w):
                let ds = (s?.obj("bt")?["devices"] as? [JSON]) ?? []
                pick(ds.map { ($0.str("id"), $0.str("name", max: 60)) }, action.str("id")) { id in set(["id": id, "name": ds.first { $0.str("id") == id }?.str("name", max: 80) ?? ""]) }
            case "volume" where w == "up" || w == "down": amount(tr("Step"), "step", 6, 1...25)
            case "volume" where w == "set": amount(tr("Level"), "level", 50, 0...100)
            case "bright", "slider":
                if k == "bright" && w == "set" { amount(tr("Level"), "level", 70, 0...100) }
                if k == "bright" || w == "bright" {
                    let ds = (s?["displays"] as? [JSON]) ?? []
                    if ds.count > 1 { pick([("", tr("Every display"))] + ds.map { ($0.str("id"), $0.str("name", max: 60)) }, action.str("display")) { set(["display": $0]) } }
                }
            case "nav" where w == "page":
                pick(d.spaces.flatMap { ($0["pages"] as? [JSON]) ?? [] }.map { ($0.str("id"), $0.str("name", max: 30)) }, action.str("to")) { set(["to": $0]) }
            case "nav" where w == "space":
                pick(d.spaces.map { ($0.str("id"), $0.str("name", max: 30)) }, action.str("to")) { set(["to": $0]) }
            default: EmptyView()
            }
        }
        .onAppear { if ["output", "input", "bt", "bright", "slider"].contains(k) { d.askState() } }
    }

    @ViewBuilder
    private func pick(_ opts: [(String, String)], _ chosen: String, _ fn: @escaping (String) -> Void) -> some View {
        if opts.isEmpty { Text(tr("Nothing to choose from yet")).font(.caption).foregroundStyle(.secondary) }
        else {
            Picker(tr("Choose"), selection: Binding(get: { chosen }, set: fn)) {
                if !opts.contains(where: { $0.0 == chosen }) { Text("—").tag(chosen) }
                ForEach(opts.indices, id: \.self) { i in Text(opts[i].1).tag(opts[i].0) }
            }
        }
    }

    private func amount(_ name: String, _ key: String, _ def: Int, _ range: ClosedRange<Int>) -> some View {
        let v = action.has(key) ? action.int(key, def) : def
        return VStack(alignment: .leading) {
            Text("\(name): \(v)" + (key == "level" ? "%" : "")).font(.caption).foregroundStyle(.secondary)
            Slider(value: Binding(get: { Double(v) }, set: { action[key] = Int($0.rounded()) }), in: Double(range.lowerBound)...Double(range.upperBound), step: 1)
        }
    }
}

// Every action, by group, with a search; those the computer can't do are greyed with why.
struct DeckActionPicker: View {
    @EnvironmentObject var core: Core
    @Environment(\.dismiss) private var dismiss
    let choose: (DeckCatalog.Entry) -> Void
    @State private var q = ""

    var body: some View {
        let d = core.deck
        let words = q.trimmingCharacters(in: .whitespaces).lowercased()
        NavigationStack {
            List {
                ForEach(DeckCatalog.groups, id: \.0) { g in
                    let list = DeckCatalog.entries.filter { e in e.group == g.0 && (words.isEmpty ||
                        tr(e.name(d.platform)).lowercased().contains(words) || tr(e.desc(d.platform)).lowercased().contains(words)) }
                    if !list.isEmpty {
                        Section(tr(g.1)) {
                            ForEach(list, id: \.id) { e in
                                let why: String? = e.device ? nil : (!d.can.contains(e.k) ? "Not on this computer" : DeckCatalog.available(e, d.caps, d.platform))
                                Button { choose(e) } label: {
                                    HStack(alignment: .top, spacing: 12) {
                                        DeckGlyph(icon: DeckCatalog.symbolOf(e.action), size: 17).frame(width: 26).foregroundStyle(TDColor.accent)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(tr(e.name(d.platform))).foregroundStyle(TDColor.text)
                                            Text(why.map { tr($0) } ?? tr(e.desc(d.platform))).font(.caption).foregroundStyle(.secondary)
                                            if e.local { Text(tr("Stays on this computer")).font(.caption2).foregroundStyle(TDColor.accent) }
                                        }
                                    }
                                }
                                .disabled(why != nil)
                                .opacity(why == nil ? 1 : 0.45)
                            }
                        }
                    }
                }
            }
            .searchable(text: $q, prompt: tr("Search"))
            .navigationTitle(tr("Choose an action"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(tr("Cancel")) { dismiss() } } }
        }
    }
}
