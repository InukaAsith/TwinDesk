// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Overview's quick actions: what people do with the computer in a tap (its screen, voice
// typing, the touchpad, send photos and files, play and pause, lock…), as tiles the way Control
// Center has them. One or two rows that scroll sideways; each tile small (one cell), wide (two
// across) or, with two rows, large (two by two). Edit: add and remove them, size them, move them
// earlier or later, one row or two. Kept on this device ("overview.tiles").
// The same tiles, sizes and packing as Android's (Shortcuts.kt) and the computers' Overview of a
// phone (shared/ui-device-parts.js, D.tiles).
import SwiftUI

struct TileItem: Equatable { var id: String; var size: String } // "s" small, "w" wide, "b" large
struct TileLayout: Equatable {
    var rows: Int
    var items: [TileItem]

    static let key = "overview.tiles"
    // One row of four; the rest under Edit › Add.
    static let standard = TileLayout(rows: 1, items: [
        .init(id: "screen", size: "s"), .init(id: "voice", size: "s"), .init(id: "touchpad", size: "s"), .init(id: "photos", size: "s"),
    ])

    static func load(_ store: Store) -> TileLayout {
        guard let data = store.string(key, "").data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let a = o["items"] as? [[String: Any]] else { return standard }
        var seen = Set<String>()
        let items: [TileItem] = a.compactMap { x in
            guard let id = x["id"] as? String, seen.insert(id).inserted else { return nil }
            let s = x["s"] as? String ?? "s"
            return TileItem(id: id, size: ["s", "w", "b"].contains(s) ? s : "s")
        }
        return TileLayout(rows: (o["rows"] as? Int) == 2 ? 2 : 1, items: items)
    }

    func save(_ store: Store) {
        let o: [String: Any] = ["rows": rows, "items": items.map { ["id": $0.id, "s": $0.size] }]
        if let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) { store.setString(TileLayout.key, s) }
    }

    struct Placed { let item: TileItem; let col: Int; let row: Int; let w: Int; let h: Int }

    // Column by column, each tile in the first place it fits, in order; a large tile with one row
    // is a wide one. Android and the computers pack the same way.
    static func pack(_ items: [TileItem], rows: Int) -> [Placed] {
        var taken = Set<Int>() // col * 8 + row
        return items.map { it in
            let w = it.size == "s" ? 1 : 2
            let h = it.size == "b" && rows == 2 ? 2 : 1
            var col = 0
            while true {
                for r in 0...(rows - h) {
                    let free = (0..<w).allSatisfy { dx in (0..<h).allSatisfy { dy in !taken.contains((col + dx) * 8 + r + dy) } }
                    if free {
                        for dx in 0..<w { for dy in 0..<h { taken.insert((col + dx) * 8 + r + dy) } }
                        return Placed(item: it, col: col, row: r, w: w, h: h)
                    }
                }
                col += 1
            }
        }
    }
}

// A quick action: its words, icon and colour; whether this computer has it; on; its line; its tap.
struct TileDef {
    let id: String
    let label: String
    let symbol: String
    let color: Color
    var has = true
    var on = false
    var state = ""
    let run: () -> Void
}

struct TilesCard: View {
    @EnvironmentObject var core: Core
    let defs: [TileDef]
    @State private var layout = TileLayout.standard
    @State private var loaded = false
    @State private var editing = false
    @State private var sel: String?
    @State private var width: CGFloat = 340 // the card's inside, measured
    private let gap: CGFloat = 10
    private static let anim = Animation.easeInOut(duration: 0.2)

    private var byId: [String: TileDef] { Dictionary(defs.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }

    var body: some View {
        // An "auto." action (Save copied, while the computer has copied something) comes first, as it is.
        let auto = editing ? [] : defs.filter { $0.id.hasPrefix("auto.") }.map { TileItem(id: $0.id, size: "w") }
        let shown = auto + layout.items.filter { byId[$0.id].map { editing || $0.has } ?? false }
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(tr("Quick actions")).font(.headline)
                Spacer()
                Button(editing ? tr("Done") : tr("Edit")) { withAnimation(Self.anim) { editing.toggle(); sel = nil } }
                    .font(.subheadline.weight(editing ? .semibold : .regular))
            }
            let cell = min(120, (width - gap * 3) / 4)
            let placed = TileLayout.pack(shown, rows: layout.rows)
            let cols = placed.map { $0.col + $0.w }.max() ?? 0
            Group {
                if placed.isEmpty {
                    Text(editing ? tr("Add quick actions below.") : tr("No quick actions. Tap Edit to add some.")).font(.footnote).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        ZStack(alignment: .topLeading) {
                            Color.clear.frame(width: cell * CGFloat(cols) + gap * CGFloat(max(0, cols - 1)), height: cell * CGFloat(layout.rows) + gap * CGFloat(layout.rows - 1))
                            ForEach(placed, id: \.item.id) { p in
                                if let d = byId[p.item.id] { tile(d, p, cell) }
                            }
                        }
                        .padding(6) // room for the − badges
                    }
                    .frame(height: cell * CGFloat(layout.rows) + gap * CGFloat(layout.rows - 1) + 12)
                    .padding(-6)
                }
            }
            .frame(maxWidth: .infinity)
            .background(GeometryReader { g in
                Color.clear.onAppear { width = g.size.width }.onChange(of: g.size.width) { w in width = w }
            })
            if editing { editor }
        }
        .glassCard()
        .onAppear { if !loaded { layout = TileLayout.load(core.store); loaded = true } }
    }

    private func set(_ l: TileLayout) { layout = l; l.save(core.store) }

    @ViewBuilder
    private func tile(_ d: TileDef, _ p: TileLayout.Placed, _ cell: CGFloat) -> some View {
        let w = cell * CGFloat(p.w) + gap * CGFloat(p.w - 1)
        let h = cell * CGFloat(p.h) + gap * CGFloat(p.h - 1)
        let dim = d.has ? 1.0 : 0.4
        Button {
            if editing { withAnimation(Self.anim) { sel = sel == d.id ? nil : d.id } } else { d.run() }
        } label: {
            Group {
                if p.w == 1 {
                    VStack(spacing: 7) {
                        badge(d, 38)
                        Text(d.label).font(.caption2.weight(.medium)).multilineTextAlignment(.center).lineLimit(2).minimumScaleFactor(0.85)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(6)
                } else if p.h == 1 {
                    HStack(spacing: 10) {
                        badge(d, 40)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(d.label).font(.subheadline.weight(.semibold)).lineLimit(1)
                            if !d.state.isEmpty { Text(d.state).font(.caption2).foregroundStyle(d.on ? Color.white.opacity(0.8) : Color.secondary).lineLimit(2) }
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.horizontal, 14)
                } else {
                    VStack(alignment: .leading) {
                        badge(d, 52)
                        Spacer(minLength: 0)
                        Text(d.label).font(.headline).lineLimit(1)
                        if !d.state.isEmpty { Text(d.state).font(.caption).foregroundStyle(d.on ? Color.white.opacity(0.8) : Color.secondary).lineLimit(2) }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    .padding(14)
                }
            }
            .foregroundStyle(d.on ? Color.white : Color.primary)
            .opacity(dim)
            .frame(width: w, height: h)
            .background(d.on ? TDColor.accent : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(TDColor.accent, lineWidth: sel == d.id ? 2 : 0))
        }
        .buttonStyle(.plain)
        .hoverLift()
        .overlay(alignment: .topLeading) {
            if editing {
                Button { remove(d.id) } label: {
                    Image(systemName: "minus").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 22, height: 22).background(Color(white: 0.45), in: Circle())
                }
                .buttonStyle(.plain)
                .offset(x: -5, y: -5)
                .accessibilityLabel(tr("Remove {label}", ["label": d.label]))
            }
        }
        .offset(x: (cell + gap) * CGFloat(p.col), y: (cell + gap) * CGFloat(p.row))
    }

    private func badge(_ d: TileDef, _ size: CGFloat) -> some View {
        Group {
            if d.on {
                Image(systemName: d.symbol).font(.system(size: size * 0.48, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: size, height: size).background(Color.white.opacity(0.22), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            } else { FeatureIcon(symbol: d.symbol, color: d.color, size: size) }
        }
    }

    private func remove(_ id: String) {
        withAnimation(Self.anim) {
            set(TileLayout(rows: layout.rows, items: layout.items.filter { $0.id != id }))
            if sel == id { sel = nil }
        }
    }

    // Rows; the selected tile's place and size; the rest, to add; Reset.
    private var editor: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            HStack {
                Text(tr("Rows"))
                Spacer()
                Picker(tr("Rows"), selection: Binding(get: { layout.rows }, set: { v in withAnimation(Self.anim) { set(TileLayout(rows: v, items: layout.items)) } })) {
                    Text(tr("One")).tag(1); Text(tr("Two")).tag(2)
                }
                .pickerStyle(.segmented).frame(width: 150)
            }
            if let id = sel, let i = layout.items.firstIndex(where: { $0.id == id }), let d = byId[id] {
                HStack(spacing: 10) {
                    Text(d.label).font(.subheadline.weight(.medium)).lineLimit(1)
                    Spacer()
                    Button { move(i, -1) } label: { Image(systemName: "chevron.left") }.secondaryButton().disabled(i == 0)
                    Button { move(i, 1) } label: { Image(systemName: "chevron.right") }.secondaryButton().disabled(i == layout.items.count - 1)
                }
                HStack {
                    Text(tr("Size"))
                    Spacer()
                    // Large is two by two: with one row, small or wide.
                    let cur = layout.items[i].size == "b" && layout.rows == 1 ? "w" : layout.items[i].size
                    Picker(tr("Size"), selection: Binding(get: { cur }, set: { v in
                        withAnimation(Self.anim) { var l = layout; l.items[i].size = v; set(l) }
                    })) {
                        Text(tr("Small")).tag("s"); Text(tr("Wide")).tag("w")
                        if layout.rows == 2 { Text(tr("Large")).tag("b") }
                    }
                    .pickerStyle(.segmented).frame(width: layout.rows == 2 ? 210 : 150)
                }
            } else {
                Text(tr("Tap a quick action to move or resize it, or − to remove it.")).font(.footnote).foregroundStyle(.secondary)
            }
            let rest = defs.filter { d in d.has && !d.id.hasPrefix("auto.") && !layout.items.contains { $0.id == d.id } }
            if !rest.isEmpty {
                Text(tr("Add")).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], alignment: .leading, spacing: 8) {
                    ForEach(rest, id: \.id) { d in
                        Button {
                            withAnimation(Self.anim) { set(TileLayout(rows: layout.rows, items: layout.items + [TileItem(id: d.id, size: "s")])); sel = d.id }
                        } label: {
                            HStack(spacing: 8) {
                                FeatureIcon(symbol: d.symbol, color: d.color, size: 24)
                                Text(d.label).font(.footnote).lineLimit(1)
                                Spacer(minLength: 0)
                                Image(systemName: "plus.circle.fill").foregroundStyle(TDColor.accent)
                            }
                            .padding(.vertical, 6).padding(.horizontal, 8)
                            .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            Button(tr("Reset to default"), role: .destructive) {
                withAnimation(Self.anim) { core.store.setString(TileLayout.key, ""); layout = .standard; sel = nil }
            }
            .font(.footnote)
        }
    }

    private func move(_ i: Int, _ by: Int) {
        let j = i + by
        guard layout.items.indices.contains(j) else { return }
        withAnimation(Self.anim) { var l = layout; l.items.swapAt(i, j); set(l) }
    }
}
