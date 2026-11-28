// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Overview › Computers: every computer of the mesh with what this iPhone may do there, and the layout
// (Core/MeshMgr.swift; android/…/MeshMgr.kt's MeshCard). Shown only when the mesh has more than one device.
import SwiftUI

struct MeshCard: View {
    @EnvironmentObject var core: Core
    @State private var refusal = ""
    @State private var arranging = false

    private func go(_ d: MeshMgr.Dev, _ what: String, _ label: String, dev: String = "") {
        refusal = ""
        let mgr = core.mesh
        if !mgr.strong.contains(what) { return mgr.act(to: d.id, what, label: label, dev: dev) }
        MeshMgr.confirm(label, ok: { mgr.act(to: d.id, what, label: label, dev: dev) }, refused: { refusal = $0 })
    }

    private func state(_ d: MeshMgr.Dev) -> String {
        if d.me { return tr("Connected to this phone") }
        if !d.online { return tr("Not connected") }
        if !d.on { return tr("Doesn’t let phones manage it") }
        if !d.said { return tr("Connected (an older TwinDesk)") }
        return tr("Connected")
    }

    private func buttons(_ d: MeshMgr.Dev) -> [(String, String)] {
        [("wake", tr("Wake")), ("lock", tr("Lock")), ("unlock", tr("Unlock")), ("sleep", tr("Sleep")), ("restart", tr("Restart")), ("shutdown", tr("Shut down"))]
            .filter { d.can.contains($0.0) }
    }

    var body: some View {
        let mgr = core.mesh
        let devs = mgr.devices
        Group {
            if devs.count >= 2 {
                DenseCard(title: tr("Computers")) {
                    Button(arranging ? tr("Done") : tr("Arrange")) { arranging.toggle() }.buttonStyle(.borderless).font(.subheadline)
                } content: {
                    ForEach(Array(devs.enumerated()), id: \.element.id) { i, d in
                        VStack(alignment: .leading, spacing: 6) {
                            DenseRow(symbol: d.os == "mac" ? "laptopcomputer" : "desktopcomputer", title: d.name, hint: state(d),
                                     hintColor: d.online ? .secondary : TDColor.muted, divider: i > 0) { EmptyView() }
                            let bs = buttons(d)
                            if !bs.isEmpty {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 6) {
                                        ForEach(bs.indices, id: \.self) { k in
                                            let (what, label) = bs[k]
                                            pill(label, strong: mgr.strong.contains(what)) { go(d, what, tr("{what} {name}", ["what": label, "name": d.name])) }
                                        }
                                    }
                                }
                            }
                            if let p = d.pending {
                                Text(tr("{name} wants to pair with {computer}. Code {code}: check it’s the one on {name}.", ["name": p.name, "computer": d.name, "code": p.code]))
                                    .font(.footnote)
                                HStack(spacing: 6) {
                                    pill(tr("Allow"), strong: true) { go(d, "approve", tr("Allow {name}", ["name": p.name])) }
                                    pill(tr("Deny")) { go(d, "deny", tr("Deny {name}", ["name": p.name])) }
                                }
                            }
                            if arranging && !d.me {
                                pill(tr("Remove from the mesh"), strong: true) {
                                    let label = tr("Remove {name}", ["name": d.name])
                                    MeshMgr.confirm(label, ok: { mgr.act(to: "*", "remove", label: label, dev: d.id) }, refused: { refusal = $0 })
                                }
                            }
                        }
                        .padding(.bottom, 4)
                    }
                    if arranging { MeshLayoutGrid(devs: devs) }
                    let line = refusal.isEmpty ? mgr.result : refusal
                    if !line.isEmpty { Text(line).font(.caption).foregroundStyle(.secondary).padding(.top, 6) }
                }
            }
        }
        .onAppear { core.mesh.look(true) }
        .onDisappear { core.mesh.look(false) }
    }

    private func pill(_ label: String, strong: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.footnote.weight(.medium)).lineLimit(1)
                .foregroundStyle(strong ? TDColor.bad : TDColor.text)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(TDColor.control, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

// The layout's grid (shared/layout.js cells): tap a device, then one of the places it may go.
struct MeshLayoutGrid: View {
    @EnvironmentObject var core: Core
    let devs: [MeshMgr.Dev]
    @State private var picked = ""

    var body: some View {
        let v = core.mesh.view
        let lay = v?.obj("layout")
        let cells = lay?.obj("cells") ?? [:]
        let me = v?.str("me", max: 64) ?? ""
        var at: [String: String] = [:] // "x,y" → device id
        for (id, c) in cells { if let c = c as? JSON { at["\(c.int("x")),\(c.int("y"))"] = id } }
        let free = Set((lay?.obj("targets")?[picked] as? [String]) ?? [])
        let all = Array(at.keys) + Array(free)
        let xs = all.compactMap { Int($0.split(separator: ",").first ?? "") }
        let ys = all.compactMap { Int($0.split(separator: ",").last ?? "") }
        let names = Dictionary(devs.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        return VStack(alignment: .leading, spacing: 6) {
            if !at.isEmpty, let x0 = xs.min(), let x1 = xs.max(), let y0 = ys.min(), let y1 = ys.max() {
                Text(picked.isEmpty ? tr("Tap a device, then where it goes") : tr("Tap a lit place for {name}", ["name": names[picked] ?? tr("Phone")]))
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(y0...y1, id: \.self) { y in
                    HStack(spacing: 6) {
                        ForEach(x0...x1, id: \.self) { x in
                            let k = "\(x),\(y)"
                            let id = at[k]
                            let lit = free.contains(k)
                            Button {
                                if let id { picked = picked == id ? "" : id }
                                else if lit { core.mesh.act(to: me, "place", label: tr("Move {name}", ["name": names[picked] ?? tr("Phone")]), dev: picked, x: x, y: y); picked = "" }
                            } label: {
                                Text(id.map { names[$0] ?? tr("Phone") } ?? "")
                                    .font(.caption2.weight(id == me ? .semibold : .regular)).lineLimit(2).multilineTextAlignment(.center)
                                    .frame(width: 72, height: 48)
                                    .background(RoundedRectangle(cornerRadius: 10).fill(id != nil && id == picked ? TDColor.accent.opacity(0.3) : id != nil ? TDColor.control : lit ? TDColor.accent.opacity(0.15) : .clear))
                                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(lit || (id != nil && id == picked) ? TDColor.accent : id != nil ? TDColor.line : .clear))
                            }
                            .buttonStyle(.plain)
                            .disabled(id == nil && !lit)
                        }
                    }
                }
            }
        }
        .padding(.top, 8)
    }
}
