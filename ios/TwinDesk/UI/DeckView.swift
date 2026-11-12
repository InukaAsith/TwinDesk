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

// The Deck page: Open Deck, its settings and the tiles to set up. The tiles themselves open full
// screen (DeckScreen): Edit is here, not there.
struct DeckView: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    @State private var spaceId = ""
    @State private var pageOf: [String: String] = [:]

    var body: some View {
        let _ = core.tick
        let d = core.deck
        let spaces = d.spaces.filter { $0.str("kind") != "windows" }
        let name = core.host?.name ?? ""
        PageScroll(title: tr("Deck")) {
            if !core.connected { NeedsComputer(what: tr("Deck")) }
            else if d.layout == nil || d.spaces.isEmpty {
                Text(tr("Waiting for {name}…", ["name": name])).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).glassCard()
            } else {
                Button { ui.cover = .deck } label: { Label(tr("Open Deck"), systemImage: "square.grid.2x2.fill").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6) }
                    .primaryButton()
                VStack(alignment: .leading, spacing: 12) {
                    Text(tr("Settings")).font(.headline)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(tr("Hold the phone"))
                            Spacer()
                            Picker(tr("Hold the phone"), selection: Binding(get: { d.portrait }, set: { p in d.edit { $0["orient"] = p ? "portrait" : "landscape" } })) {
                                Text(tr("Landscape")).tag(false)
                                Text(tr("Portrait")).tag(true)
                            }.pickerStyle(.segmented).frame(maxWidth: 230)
                        }
                        Text(tr("The Deck opens full screen this way up. Also set on {name}’s Deck page.", ["name": name])).font(.caption).foregroundStyle(.secondary)
                    }
                    ToggleRow(title: tr("Swipe between pages"), detail: tr("Off: switch pages with the page bar, or a Go to page tile"),
                              on: Binding(get: { d.swipePages }, set: { v in d.edit { l in var w = l.obj("swipe") ?? [:]; w["pages"] = v; l["swipe"] = w } }))
                    ToggleRow(title: tr("Three-finger swipes"), detail: tr("Along the screen’s long side for the next space, across it for the next page; past the last, back to the first"),
                              on: Binding(get: { d.swipeSpaces }, set: { v in d.edit { l in var w = l.obj("swipe") ?? [:]; w["spaces"] = v; l["swipe"] = w } }))
                    ToggleRow(title: tr("Open Deck on the Overview"), detail: tr("A shortcut among the Overview’s tiles"),
                              on: Binding(get: { TileLayout.has(core.store, "deck") }, set: { TileLayout.set(core.store, "deck", $0); core.changed() }))
                }.glassCard()
                Text(tr("The Deck opens full screen and keeps the screen on. Swipe with three fingers to change page or space; tap × in its corner to close it."))
                    .font(.footnote).foregroundStyle(.secondary)
                if !spaces.isEmpty {
                    let space = spaces.first { $0.str("id") == spaceId } ?? spaces[0]
                    VStack(alignment: .leading, spacing: 12) {
                        Text(tr("Tiles")).font(.headline)
                        if spaces.count > 1 {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(spaces.indices, id: \.self) { i in
                                        let s = spaces[i]
                                        let on = s.str("id") == space.str("id")
                                        Button { spaceId = s.str("id") } label: {
                                            Text(s.str("name", max: 30)).font(.subheadline.weight(on ? .semibold : .regular))
                                                .padding(.horizontal, 12).padding(.vertical, 7)
                                                .foregroundStyle(on ? Color.white : TDColor.text)
                                                .background(on ? TDColor.accent : TDColor.control, in: Capsule())
                                        }.buttonStyle(PressScale())
                                    }
                                }
                            }
                        }
                        DeckTileSpace(space: space, pageId: Binding(get: { pageOf[space.str("id")] ?? "" }, set: { pageOf[space.str("id")] = $0 }), editing: true, full: false, toSpace: { _ in })
                    }.glassCard()
                }
            }
        }
    }
}

// The Deck full screen: only the tiles, the whole screen, a faint × in the corner; held landscape
// unless the computer's Deck says portrait (layout.orient), the screen kept on. Three fingers
// along the long side change the space, across it the page, round and round; the name shows a moment.
struct DeckScreen: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    @State private var spaceId = ""
    @State private var pageOf: [String: String] = [:]
    @State private var step = (n: 0, dir: 0)
    @State private var flash: String?

    var body: some View {
        let _ = core.tick
        let d = core.deck
        let spaces = d.spaces
        ZStack(alignment: .topTrailing) {
            TDColor.bg.ignoresSafeArea()
            if d.layout == nil || spaces.isEmpty || !core.connected {
                Text(tr("Waiting for {name}…", ["name": core.host?.name ?? ""])).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                let space = spaces.first { $0.str("id") == spaceId } ?? spaces[0]
                VStack(spacing: 4) {
                    if space.str("kind") == "windows" { DeckWindowSpace(space: space).padding(.top, 30) }
                    else {
                        DeckTileSpace(space: space, pageId: Binding(get: { pageOf[space.str("id")] ?? "" }, set: { pageOf[space.str("id")] = $0 }),
                                      editing: false, full: true, step: step.n, stepDir: step.dir, onPage: { flash = $0 }, toSpace: { go(to: $0) })
                    }
                    if let why = d.done?.why, !why.isEmpty, why != "busy" {
                        Text(tr(why)).font(.caption).foregroundStyle(TDColor.bad).lineLimit(1)
                    }
                }
                .padding(6)
                .background(ThreeFingerSwipe(enabled: d.swipeSpaces) { dx, dy in swipe(dx, dy) })
            }
            Button { ui.cover = nil } label: {
                Image(systemName: "xmark").font(.system(size: 13, weight: .bold)).foregroundStyle(TDColor.text)
                    .frame(width: 30, height: 30).background(TDColor.control, in: Circle())
            }
            .opacity(0.55).padding(8)
            .accessibilityLabel(tr("Close"))
            if let f = flash {
                Text(f).font(.headline).foregroundStyle(.white).padding(.horizontal, 18).padding(.vertical, 10)
                    .background(Color.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onAppear {
            if core.deck.portrait { Orientation.portrait() } else { Orientation.landscape() }
            UIApplication.shared.isIdleTimerDisabled = true
            core.media.page(true) // what plays there, for a media widget
        }
        .onDisappear {
            Orientation.free()
            UIApplication.shared.isIdleTimerDisabled = false
            core.media.page(false)
        }
        .onChange(of: core.deck.portrait) { p in if p { Orientation.portrait() } else { Orientation.landscape() } }
        .onChange(of: flash) { f in
            guard f != nil else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { if flash == f { withAnimation { flash = nil } } }
        }
        .task {
            while !Task.isCancelled {
                if core.connected && core.deck.layout != nil { core.deck.askState() }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    private func go(to id: String) {
        guard let s = core.deck.spaces.first(where: { $0.str("id") == id }) else { return }
        withAnimation(.easeOut(duration: 0.2)) { spaceId = id }
        flash = s.str("name", max: 30)
    }
    private func swipe(_ dx: Int, _ dy: Int) {
        let ss = core.deck.spaces
        let i = ss.firstIndex { $0.str("id") == (spaceId.isEmpty ? ss.first?.str("id") ?? "" : spaceId) } ?? 0
        // Along the screen's long side the next space, across it the next page; round and round.
        let (sp, pg) = core.deck.portrait ? (dy, dx) : (dx, dy)
        if sp != 0 {
            guard ss.count > 1 else { return }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            go(to: ss[((i + sp) % ss.count + ss.count) % ss.count].str("id"))
        } else if ss.indices.contains(i), ss[i].str("kind") != "windows" {
            step = (step.n + 1, pg)
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
    var full = false // the full-screen Deck: no bars, the grid as big as the screen
    var step = 0 // a three-finger page turn (DeckScreen): its count and direction
    var stepDir = 0
    var onPage: (String) -> Void = { _ in }
    let toSpace: (String) -> Void
    @State private var width: CGFloat = 320
    @State private var height: CGFloat = 320
    @State private var sliding = false
    @State private var open: EditTarget?
    private let gap: CGFloat = 8

    var body: some View {
        let d = core.deck
        let pages = (space["pages"] as? [JSON]) ?? []
        let idx = max(0, pages.firstIndex { $0.str("id") == pageId } ?? 0)
        VStack(alignment: .leading, spacing: 12) {
            if !full { pageBar(pages, idx) }
            if pages.isEmpty { Text(tr("No pages")).foregroundStyle(.secondary) }
            else {
                grid(pages[min(idx, pages.count - 1)], pages: pages, idx: idx)
                    .id(pages[min(idx, pages.count - 1)].str("id"))
                    .transition(.opacity)
                    .frame(maxWidth: .infinity, maxHeight: full ? .infinity : nil, alignment: .topLeading)
                    .background(GeometryReader { g in
                        Color.clear.onAppear { width = g.size.width; height = g.size.height }
                            .onChange(of: g.size) { z in width = z.width; height = z.height }
                    })
                    .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { v in
                        defer { sliding = false }
                        guard d.swipePages, !editing, !sliding, abs(v.translation.width) > 60, abs(v.translation.width) > abs(v.translation.height) * 1.5 else { return }
                        turn(pages, idx + (v.translation.width < 0 ? 1 : -1))
                    })
                if pages.count > 1 && !full {
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
        .onChange(of: step) { _ in
            let pages = (space["pages"] as? [JSON]) ?? []
            let idx = max(0, pages.firstIndex { $0.str("id") == pageId } ?? 0)
            guard pages.count > 1 else { return }
            let to = ((idx + stepDir) % pages.count + pages.count) % pages.count
            turn(pages, to)
            onPage(pages[to].str("name", max: 30))
        }
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
        let w = full ? width : min(width, 560)
        let cw = max(20, (w - gap * CGFloat(cols - 1)) / CGFloat(cols))
        // Full screen: cells as tall as the screen allows; on the Deck page, square.
        let ch = full ? max(20, (height - gap * CGFloat(rows - 1)) / CGFloat(rows)) : cw
        let tiles = (p["tiles"] as? [JSON]) ?? []
        ZStack(alignment: .topLeading) {
            Color.clear.frame(width: w, height: ch * CGFloat(rows) + gap * CGFloat(rows - 1))
            if editing {
                let taken = Set(tiles.flatMap { t in (0..<t.int("w", 1)).flatMap { dx in (0..<t.int("h", 1)).map { dy in (t.int("y") + dy) * cols + t.int("x") + dx } } })
                ForEach(0..<(rows * cols), id: \.self) { n in
                    if !taken.contains(n) {
                        Button { add(p, x: n % cols, y: n / cols) } label: {
                            Image(systemName: "plus").foregroundStyle(.secondary)
                                .frame(width: cw, height: ch)
                                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(TDColor.line))
                        }
                        .offset(x: (cw + gap) * CGFloat(n % cols), y: (ch + gap) * CGFloat(n / cols))
                    }
                }
            }
            ForEach(tiles.indices, id: \.self) { i in
                DeckTile(tile: tiles[i], cw: cw, ch: ch, gap: gap, editing: editing, sliding: $sliding) { tap(tiles[i], pages: pages, idx: idx) }
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
        case "widget": if a.str("what") == "media" { core.media.ctl("toggle") }
        default: if d.runs(a) { d.run(t.str("id")) }
        }
    }
}

// One tile at its place: its symbol, name and state; a slider's bar follows a drag.
struct DeckTile: View {
    @EnvironmentObject var core: Core
    let tile: JSON
    let cw: CGFloat
    let ch: CGFloat
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
        let width = cw * CGFloat(w) + gap * CGFloat(w - 1), height = ch * CGFloat(h) + gap * CGFloat(h - 1)
        Group {
            if a.str("k") == "widget" { DeckWidget(action: a, w: w, h: h, fg: fg) }
            else { content(w: w, h: h, fg: fg, label: label, sub: sub, slider: a.str("k") == "slider", value: value) }
        }
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
            .offset(x: (cw + gap) * CGFloat(tile.int("x")), y: (ch + gap) * CGFloat(tile.int("y")))
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

// A widget's face: the time, what plays on the computer (with its buttons), or the computer's
// processor, memory or heat (deck.state perf) as a number and a bar.
struct DeckWidget: View {
    @EnvironmentObject var core: Core
    let action: JSON
    let w: Int
    let h: Int
    let fg: Color

    var body: some View {
        let big = w > 1 || h > 1
        switch action.str("what") {
        case "clock":
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                VStack(spacing: 2) {
                    Text(ctx.date, style: .time).font(.system(size: h > 1 && w > 1 ? 40 : big ? 28 : 17, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.5)
                    Text(ctx.date.formatted(.dateTime.weekday(big ? .wide : .abbreviated).day().month(big ? .wide : .abbreviated))).font(.system(size: big ? 13 : 10)).opacity(0.75).lineLimit(1)
                }.foregroundStyle(fg).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case "media":
            let n = core.media.now
            let playing = n?.playing == true
            if !big {
                VStack(spacing: 4) {
                    DeckGlyph(icon: playing ? "pause" : "play", size: 22)
                    Text(n?.title ?? tr("Nothing playing")).font(.system(size: 10)).lineLimit(1)
                }.foregroundStyle(fg).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text(n?.title ?? tr("Nothing playing")).font(.system(size: 14, weight: .semibold)).lineLimit(h > 1 ? 2 : 1)
                    let sub = [n?.artist ?? "", n?.app ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
                    if !sub.isEmpty { Text(sub).font(.system(size: 11.5)).opacity(0.72).lineLimit(1) }
                    Spacer(minLength: 0)
                    HStack {
                        Spacer()
                        Button { core.media.ctl("prev") } label: { DeckGlyph(icon: "prev", size: 18).frame(width: 36, height: 36) }
                        Spacer()
                        Button { core.media.ctl("toggle") } label: { DeckGlyph(icon: playing ? "pause" : "play", size: 24).frame(width: 40, height: 40) }
                        Spacer()
                        Button { core.media.ctl("next") } label: { DeckGlyph(icon: "next", size: 18).frame(width: 36, height: 36) }
                        Spacer()
                    }.buttonStyle(.plain)
                }.foregroundStyle(fg).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
        default:
            let perf = core.deck.state?.obj("perf")
            let what = action.str("what")
            let num: Double? = (perf?[what] as? NSNumber)?.doubleValue
            let frac: Double? = num.map { what == "temp" ? $0 / 100 : $0 }
            let text = num.map { what == "temp" ? "\(Int($0.rounded()))°" : pct($0) } ?? "—"
            let bar: Color = (frac ?? 0) > 0.9 ? Color(red: 1, green: 0.27, blue: 0.23) : (frac ?? 0) > 0.7 ? Color(red: 1, green: 0.62, blue: 0.04) : fg
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    DeckGlyph(icon: DeckCatalog.symbolOf(action), size: big ? 18 : 14)
                    Text(what == "cpu" ? tr("CPU") : what == "ram" ? tr("Memory") : tr("Temperature")).font(.system(size: big ? 13 : 10)).opacity(0.8).lineLimit(1)
                }
                Spacer(minLength: 0)
                Text(text).font(.system(size: h > 1 ? 36 : big ? 26 : 20, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.5)
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(fg.opacity(0.22))
                        Capsule().fill(bar).frame(width: g.size.width * CGFloat(max(0, min(1, frac ?? 0))))
                    }
                }.frame(height: 5)
            }.foregroundStyle(fg).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}

// Three fingers anywhere: sideways the next (left) or previous (right) page, up or down the next
// or previous space (onSwipe(dx, dy)). A pan recognizer on the window, as SwiftUI can't count
// fingers; it doesn't cancel the touches under it.
struct ThreeFingerSwipe: UIViewRepresentable {
    let enabled: Bool
    let onSwipe: (Int, Int) -> Void

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onSwipe: (Int, Int) -> Void = { _, _ in }
        var enabled = true
        weak var pan: UIPanGestureRecognizer?
        var fired = false
        @objc func panned(_ g: UIPanGestureRecognizer) {
            guard enabled else { return }
            switch g.state {
            case .began: fired = false
            case .changed:
                let t = g.translation(in: g.view)
                guard !fired, max(abs(t.x), abs(t.y)) > 80 else { return }
                fired = true
                if abs(t.x) >= abs(t.y) { onSwipe(t.x < 0 ? 1 : -1, 0) } else { onSwipe(0, t.y < 0 ? 1 : -1) }
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
    @State private var armed: (key: String, n: Int, zone: JSON)? // a zone tapped first, waiting for an app
    @State private var drag: (app: JSON, at: CGPoint)? // an app dragged from the bar, the finger in "ws"
    @State private var pad: CGRect = .zero // the shown layout's pad in "ws"

    var body: some View {
        let d = core.deck
        Group {
            if (d.caps?["windows"] as? NSNumber)?.boolValue == false { Text(tr("Not on this computer")).foregroundStyle(.secondary) }
            else if let w = d.wins { content(w) }
            else { Text(tr("Loading windows…")).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task(id: space.str("id")) {
            while !Task.isCancelled {
                core.deck.askWins()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    // The app chosen (none at first, and none again once it's placed) and a zone tapped before an
    // app: either order works. Or an app dragged from the bar straight onto a zone, or an edge.
    // Everything on one screen, never scrolled: held sideways the apps and displays beside the pad,
    // upright above it; the pad takes what's left, 16:10.
    @ViewBuilder
    private func content(_ w: JSON) -> some View {
        let apps = (w["apps"] as? [JSON]) ?? []
        let displays = (w["displays"] as? [JSON]) ?? []
        let front = w.int64("front")
        let app = apps.first { $0.str("key") == appKey }
        let windows = (app?["windows"] as? [JSON]) ?? []
        let win = windows.first { $0.int64("wid") == wid } ?? windows.first { $0.int64("wid") == front } ?? windows.first
        let to = display ?? win?.str("display") ?? displays.first { $0.bool("main") }?.str("id") ?? displays.first?.str("id") ?? ""
        if apps.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if !w.str("why").isEmpty { Label(tr(w.str("why", max: 300)), systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(TDColor.bad) }
                Text(tr("No windows open")).foregroundStyle(.secondary)
            }
        } else {
            GeometryReader { g in
                ZStack(alignment: .topLeading) {
                    if g.size.width > g.size.height {
                        HStack(alignment: .top, spacing: 16) {
                            VStack(alignment: .leading, spacing: 10) { bar(w, apps, app, windows, win, front, to); screens(displays, win, to); Spacer(minLength: 0) }
                                .frame(width: g.size.width * 0.34)
                            VStack(alignment: .leading, spacing: 6) { pads(win, to) }
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 10) { bar(w, apps, app, windows, win, front, to); VStack(alignment: .leading, spacing: 6) { pads(win, to) }; screens(displays, win, to) }
                    }
                    // The app being dragged, under the finger.
                    if let dr = drag { icon(dr.app, 52).opacity(0.9).position(dr.at).allowsHitTesting(false) }
                }
            }
            .coordinateSpace(name: "ws")
        }
    }

    private func windowOf(_ a: JSON, _ front: Int64) -> JSON? {
        let aw = (a["windows"] as? [JSON]) ?? []
        return aw.first { $0.int64("wid") == front } ?? aw.first
    }

    // Where a drop at p goes: the shown layout's zone under it, else an edge or a corner of the display.
    private func target(_ p: CGPoint) -> JSON? {
        guard pad.width > 0, pad.contains(p) else { return nil }
        let fx = (p.x - pad.minX) / pad.width, fy = (p.y - pad.minY) / pad.height
        let gx = Int(fx * 12), gy = Int(fy * 12)
        let layouts = (space["layouts"] as? [JSON]) ?? []
        let zones = layouts.indices.contains(layoutIdx) ? ((layouts[layoutIdx]["zones"] as? [JSON]) ?? []) : []
        if let z = zones.first(where: { gx >= $0.int("x") && gx < $0.int("x") + $0.int("w", 1) && gy >= $0.int("y") && gy < $0.int("y") + $0.int("h", 1) }) { return z }
        return deckSnapZone(fx, fy)
    }

    private func same(_ a: JSON?, _ b: JSON) -> Bool {
        guard let a = a else { return false }
        return ["x", "y", "w", "h"].allSatisfy { a.int($0, 1) == b.int($0, 1) }
    }

    @ViewBuilder
    private func icon(_ a: JSON, _ s: CGFloat) -> some View {
        if let img = appIcon(a.str("icon", max: 400_000)) { Image(uiImage: img).resizable().frame(width: s, height: s) }
        else {
            Text(String(a.str("name").prefix(1)).uppercased()).font(.headline)
                .frame(width: s, height: s).background(TDColor.control, in: RoundedRectangle(cornerRadius: s / 4, style: .continuous))
        }
    }

    @ViewBuilder
    private func bar(_ w: JSON, _ apps: [JSON], _ app: JSON?, _ windows: [JSON], _ win: JSON?, _ front: Int64, _ to: String) -> some View {
        if !w.str("why").isEmpty { Label(tr(w.str("why", max: 300)), systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(TDColor.bad) }
        Text(armed.map { tr("Now choose the app for zone {n}", ["n": $0.n]) } ?? tr("App"))
            .font(.caption.weight(armed == nil ? .regular : .semibold)).foregroundStyle(armed == nil ? Color.secondary : TDColor.accent)
        // The running apps (a dot: the one in front): tap to choose, or drag one onto the pad.
        DeckFlow(spacing: 6) {
            ForEach(apps.indices, id: \.self) { i in
                let a = apps[i]
                let on = a.str("key") == app?.str("key")
                let aw = (a["windows"] as? [JSON]) ?? []
                let inFront = aw.contains { $0.int64("wid") == front }
                VStack(spacing: 3) {
                    ZStack(alignment: .topTrailing) {
                        icon(a, 36)
                        if inFront { Circle().fill(TDColor.accent).frame(width: 8, height: 8) }
                    }
                    Text(a.str("name", max: 40)).font(.caption2).lineLimit(1).foregroundStyle(TDColor.text)
                }
                .frame(width: 56).padding(5)
                .background(on ? TDColor.accent.opacity(0.22) : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .contentShape(Rectangle())
                .onTapGesture {
                    if let z = armed, let t = windowOf(a, front) { put(t, z.zone, to) }
                    else if on { appKey = nil; wid = nil } else { appKey = a.str("key"); wid = nil }
                }
                .gesture(DragGesture(minimumDistance: 8, coordinateSpace: .named("ws"))
                    .onChanged { g in drag = (a, g.location) }
                    .onEnded { g in
                        let z = target(g.location)
                        drag = nil
                        let t = on ? win : windowOf(a, front)
                        if let z = z, let t = t { put(t, z, to) }
                    })
            }
        }
        // Its windows, when it has more than one.
        if app != nil && windows.count > 1 {
            DeckFlow(spacing: 6) {
                ForEach(windows.indices, id: \.self) { i in
                    let x = windows[i]
                    let on = x.int64("wid") == win?.int64("wid")
                    Button { wid = x.int64("wid") } label: {
                        Text(x.str("title", max: 50).isEmpty ? tr("Window") : x.str("title", max: 50)).font(.footnote).lineLimit(1)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .foregroundStyle(on ? Color.white : TDColor.text)
                            .background(on ? TDColor.accent : TDColor.control, in: Capsule())
                    }.buttonStyle(PressScale())
                }
            }
        }
    }

    // The displays: which one a zone goes on, or send the window there as it is.
    @ViewBuilder
    private func screens(_ displays: [JSON], _ win: JSON?, _ to: String) -> some View {
        if displays.count > 1 {
            Text(tr("Display")).font(.caption).foregroundStyle(.secondary)
            DeckFlow(spacing: 8) {
                ForEach(displays.indices, id: \.self) { i in
                    let x = displays[i]
                    let on = x.str("id") == to
                    Button { display = x.str("id") } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(x.str("name", max: 40).isEmpty ? tr("Display") : x.str("name", max: 40)).font(.subheadline.weight(.medium)).lineLimit(1)
                            Text("\(x.int("w")) × \(x.int("h"))" + (x.bool("main") ? " · " + tr("Main") : "")).font(.caption2).opacity(0.8)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .foregroundStyle(on ? Color.white : TDColor.text)
                        .background(on ? TDColor.accent : TDColor.control, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }.buttonStyle(PressScale())
                }
            }
            if let win = win, to != win.str("display") {
                Button(tr("Move the window to this display")) { put(win, nil, to) }.secondaryButton()
            }
        }
    }

    private func put(_ win: JSON, _ zone: JSON?, _ to: String) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        core.deck.place(win.int64("wid"), display: to, zone: zone)
        appKey = nil; wid = nil; armed = nil
    }

    // The layouts drawn on the computer, swiped (none yet: the display, for its edges): tap a zone,
    // or drop an app on it.
    @ViewBuilder
    private func pads(_ win: JSON?, _ to: String) -> some View {
        let layouts = (space["layouts"] as? [JSON]) ?? []
        let hover = drag.flatMap { target($0.at) }
        let blue = Color(red: 0.04, green: 0.52, blue: 1), sky = Color(red: 0.39, green: 0.82, blue: 1)
        Text(layouts.indices.contains(layoutIdx) ? layouts[layoutIdx].str("name", max: 30) : tr("Drag to an edge")).font(.caption).foregroundStyle(.secondary)
        TabView(selection: $layoutIdx) {
            ForEach(0..<max(1, layouts.count), id: \.self) { n in
                let zones = layouts.indices.contains(n) ? ((layouts[n]["zones"] as? [JSON]) ?? []) : []
                GeometryReader { outer in
                    let pw = min(outer.size.width, outer.size.height * 1.6), ph = pw / 1.6
                    GeometryReader { g in
                        let u = g.size.width / 12, v = g.size.height / 12
                        ZStack(alignment: .topLeading) {
                            RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(red: 0.11, green: 0.16, blue: 0.27))
                            ForEach(zones.indices, id: \.self) { z in
                                let zone = zones[z]
                                let lit = armed?.key == "\(n).\(z)" || (n == layoutIdx && same(hover, zone))
                                Button {
                                    if let w = win { put(w, zone, to) }
                                    else { armed = armed?.key == "\(n).\(z)" ? nil : (key: "\(n).\(z)", n: z + 1, zone: zone) }
                                } label: {
                                    Text("\(z + 1)").font(.headline).foregroundStyle(.white)
                                        .frame(width: max(1, u * CGFloat(zone.int("w", 1)) - 6), height: max(1, v * CGFloat(zone.int("h", 1)) - 6))
                                        .background(blue.opacity(lit ? 0.75 : 0.35), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(lit ? Color.white : sky, lineWidth: lit ? 2.5 : 1.5))
                                }
                                .buttonStyle(PressScale())
                                .offset(x: u * CGFloat(zone.int("x")) + 3, y: v * CGFloat(zone.int("y")) + 3)
                            }
                            // Dropped off the zones: an edge or a corner, shown as the finger moves.
                            if n == layoutIdx, let z = hover, !zones.contains(where: { same($0, z) }) {
                                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(blue.opacity(0.45))
                                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(sky, lineWidth: 2))
                                    .frame(width: u * CGFloat(z.int("w")) - 8, height: v * CGFloat(z.int("h")) - 8)
                                    .offset(x: u * CGFloat(z.int("x")) + 4, y: v * CGFloat(z.int("y")) + 4)
                                    .allowsHitTesting(false)
                            }
                            if zones.isEmpty && drag == nil {
                                Text(tr("Draw your own layouts on the computer’s Deck page.")).font(.footnote).foregroundStyle(.white.opacity(0.75)).multilineTextAlignment(.center)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity).padding(16)
                            }
                        }
                        .onAppear { if n == layoutIdx { pad = g.frame(in: .named("ws")) } }
                        .onChange(of: g.frame(in: .named("ws"))) { f in if n == layoutIdx { pad = f } }
                        .onChange(of: layoutIdx) { i in if n == i { pad = g.frame(in: .named("ws")) } }
                    }
                    .frame(width: pw, height: ph)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .padding(.horizontal, 2)
                .tag(n)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: layouts.count > 1 ? .always : .never))
        .frame(maxHeight: .infinity)
        if armed == nil {
            Text(tr("Drag an app onto a zone or an edge, or tap an app and then a zone.")).font(.caption).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
        }
    }
}

// Views in rows, wrapped to the width.
struct DeckFlow: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let w = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let z = s.sizeThatFits(.unspecified)
            if x > 0 && x + z.width > w { x = 0; y += row + spacing; row = 0 }
            x += z.width + spacing; row = max(row, z.height); widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + row)
    }
    func placeSubviews(in b: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = b.minX, y = b.minY, row: CGFloat = 0
        for s in subviews {
            let z = s.sizeThatFits(.unspecified)
            if x > b.minX && x + z.width > b.maxX { x = b.minX; y += row + spacing; row = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(z))
            x += z.width + spacing; row = max(row, z.height)
        }
    }
}

// Where a drop at (fx, fy) of the display snaps a window on the 12 × 12 zone grid: a corner a
// quarter, the left or right edge a half, the top the whole display, the bottom its lower half.
func deckSnapZone(_ fx: CGFloat, _ fy: CGFloat) -> JSON? {
    let e: CGFloat = 0.18
    let z = { (x: Int, y: Int, w: Int, h: Int) -> JSON in ["x": x, "y": y, "w": w, "h": h] }
    let l = fx < e, r = fx > 1 - e, t = fy < e, b = fy > 1 - e
    if l && t { return z(0, 0, 6, 6) }
    if r && t { return z(6, 0, 6, 6) }
    if l && b { return z(0, 6, 6, 6) }
    if r && b { return z(6, 6, 6, 6) }
    if l { return z(0, 0, 6, 12) }
    if r { return z(6, 0, 6, 12) }
    if t { return z(0, 0, 12, 12) }
    if b { return z(0, 6, 12, 6) }
    return nil
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
