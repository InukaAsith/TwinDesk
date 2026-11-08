// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Phones (Core/Peer.swift): Android phones and iPhones nearby with TwinDesk, pairing by code as
// with a computer, then the clipboard, notifications and files both ways, its Photos and Messages
// here, and the screens both ways.
import SwiftUI
import UniformTypeIdentifiers

struct PhonesView: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    @State private var picking = false

    private var peer: Peer { core.peer }

    var body: some View {
        let _ = core.tick
        PageScroll(title: "Phones") {
            if let p = peer.pair { pairCard(p) }
            if let h = peer.hostPairing { hostPairCard(h) }
            if let a = peer.asked { askedCard(a) }
            if peer.connected { sessionCard } else { nearbyCard }
            if !peer.batches.isEmpty { transfersCard }
            settingsCard
            Text("A phone with TwinDesk (Android or iPhone) on the same Wi-Fi. The one you connect to hosts: if it isn’t, Connect asks it to (Allow there). To show this \(Device.word)’s screen, start Share Screen first.")
                .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
            guard case .success(let urls) = r else { return }
            var out: [URL] = []
            for u in urls {
                let scoped = u.startAccessingSecurityScopedResource()
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let to = dir.appendingPathComponent(u.lastPathComponent)
                if (try? FileManager.default.copyItem(at: u, to: to)) != nil { out.append(to) }
                if scoped { u.stopAccessingSecurityScopedResource() }
            }
            peer.sendFiles(out)
        }
    }

    private func pairCard(_ p: PairState) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(symbol: "lock.shield.fill", color: TDColor.accent, title: "Pair with \(p.name)",
                       detail: p.phase == "failed" ? p.error : p.phase == "code" ? "Check that both phones show this code" : p.phase == "waiting" ? "Waiting for \(p.name) to allow it…" : "Connecting…")
            if p.phase == "code" {
                Text(p.code).font(.system(size: 40, weight: .bold, design: .monospaced)).frame(maxWidth: .infinity)
                HStack {
                    Button("Cancel") { peer.link.cancelPairing() }.secondaryButton()
                    Spacer()
                    Button("They match") { peer.link.confirmCode() }.primaryButton()
                }
            } else {
                HStack { Spacer(); Button(p.phase == "failed" ? "OK" : "Cancel") { peer.link.cancelPairing() }.secondaryButton() }
            }
        }
        .glassCard()
    }

    // A phone pairing with us: the code both show, Allow / Deny here.
    private func hostPairCard(_ p: Peer.PairReq) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(symbol: "lock.shield.fill", color: TDColor.accent, title: "\(p.name) wants to pair",
                       detail: p.code.isEmpty ? "Waiting for its code…" : "Allow if it shows the same code")
            if !p.code.isEmpty {
                Text(p.code).font(.system(size: 40, weight: .bold, design: .monospaced)).frame(maxWidth: .infinity)
                HStack {
                    Button("Deny", role: .destructive) { peer.respondPair(false) }.secondaryButton()
                    Spacer()
                    Button(p.allowed ? "Waiting for it…" : "Allow") { peer.respondPair(true) }.primaryButton().disabled(p.allowed)
                }
            }
        }
        .glassCard()
    }

    private func askedCard(_ f: Found) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(symbol: "iphone.radiowaves.left.and.right", color: TDColor.good, title: "\(f.name) wants to connect", detail: "Let it connect to this \(Device.word)?")
            HStack {
                Button("Not now") { peer.answerAsk(false) }.secondaryButton()
                Spacer()
                Button("Allow") { peer.answerAsk(true) }.primaryButton()
            }
        }
        .glassCard()
    }

    private var sessionCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(symbol: "iphone.gen2", color: TDColor.good, title: peer.peerName, detail: peer.peerModel.isEmpty ? "Connected" : "Connected · \(peer.peerModel)")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 10)], spacing: 10) {
                tile("Its screen", "rectangle.on.rectangle", TDColor.accent) { peer.startScreen(); ui.cover = .peerScreen }
                NavigationLink { PeerPhotosView() } label: { tileLabel("Its photos", "photo.on.rectangle", Page.photos.color) }
                NavigationLink { PeerThreadsView() } label: { tileLabel("Its messages", "message.fill", TDColor.good) }
                tile("Send files", "paperplane.fill", Color.blue) { picking = true }
                tile("Send clipboard", "doc.on.clipboard", Page.clipboard.color) {
                    if let t = UIPasteboard.general.string { peer.clipOut(t) }
                }
            }
            if !peer.screenError.isEmpty { Text(peer.screenError).font(.caption).foregroundStyle(TDColor.warn) }
            Button("Disconnect", role: .destructive) { peer.disconnect() }.secondaryButton()
        }
        .glassCard()
    }

    private func tile(_ t: String, _ icon: String, _ c: Color, _ a: @escaping () -> Void) -> some View {
        Button(action: a) { tileLabel(t, icon, c) }.buttonStyle(.plain)
    }

    private func tileLabel(_ t: String, _ icon: String, _ c: Color) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            FeatureIcon(symbol: icon, color: c, size: 30)
            Text(t).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, minHeight: 70, alignment: .leading)
        .padding(12)
        .background(TDColor.control, in: RoundedRectangle(cornerRadius: 16))
    }

    private var nearbyCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(symbol: "antenna.radiowaves.left.and.right", color: TDColor.good, title: "Phones nearby",
                       detail: peer.waitingFor.isEmpty ? (peer.message.isEmpty ? nil : peer.message) : "Waiting for it to allow this iPhone…")
            let near = peer.nearby()
            let paired = Set(peer.paired().map { $0.id })
            if near.isEmpty {
                Text(peer.on ? "Looking… Open TwinDesk on the other phone, on the same Wi-Fi." : "Phones is off.").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(near) { f in
                HStack {
                    Image(systemName: f.os == "ios" ? "iphone" : "iphone.gen2").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(f.name)
                        Text(paired.contains(f.id) ? "Paired" : f.port > 0 ? "Ready" : "Asks first").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if peer.waitingFor == f.id { Button("Cancel") { peer.cancelWait() }.secondaryButton() }
                    else { Button(paired.contains(f.id) ? "Connect" : "Pair") { peer.connect(f) }.primaryButton().disabled(peer.linkState == "connecting") }
                }
            }
            let gone = peer.paired().filter { h in !near.contains { $0.id == h.id } }
            if !gone.isEmpty {
                Divider()
                ForEach(gone) { h in
                    HStack {
                        Text(h.name).foregroundStyle(.secondary)
                        Spacer()
                        Button("Forget", role: .destructive) { peer.forget(h.id) }.font(.caption)
                    }
                }
            }
        }
        .glassCard()
    }

    private var transfersCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(peer.batches.values)) { b in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(b.up ? "Sending" : "Receiving") \(b.name)").font(.subheadline)
                    ProgressView(value: b.progress)
                }
            }
        }
        .glassCard()
    }

    private var settingsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            ToggleRow(title: "Phones", detail: "Android phones and iPhones nearby with TwinDesk", on: bind("peer.on"))
            Divider()
            ToggleRow(title: "Host for other phones", detail: peer.hostPort > 0 ? "They connect without asking · port \(peer.hostPort)" : "They connect without asking first",
                      on: Binding(get: { _ = core.tick; return peer.hostOn }, set: { peer.setHostOn($0) }))
            Divider()
            ToggleRow(title: "Clipboard", detail: "Copies go both ways while TwinDesk is open here", on: bind("peer.clip"))
            Divider()
            ToggleRow(title: "Its notifications", detail: "Shown here", on: bind("peer.notifs"))
            Divider()
            ToggleRow(title: "Photos on it", detail: "It can see and save this iPhone’s photos", on: bind("peer.photos"))
        }
        .glassCard()
    }

    private func bind(_ k: String) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.store.flag(k, true) }, set: { peer.set(k, $0) })
    }
}

// ---- its Photos ----

struct PeerPhotosView: View {
    @EnvironmentObject var core: Core
    @State private var items: [JSON] = []
    @State private var thumbs: [String: UIImage] = [:]
    @State private var next = ""
    @State private var more = false
    @State private var loading = false
    @State private var error = ""
    @State private var perm = ""
    @State private var picked: Set<String> = []
    @State private var viewing: String?
    @State private var big: UIImage?

    var body: some View {
        ScrollView {
            if !error.isEmpty {
                VStack(spacing: 12) {
                    Text(error).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    if !perm.isEmpty { Button("Ask on the phone") { core.peer.ask("ask", ["what": "media"]) { _ in } }.primaryButton() }
                }.padding(30)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 2)], spacing: 2) {
                ForEach(items.indices, id: \.self) { i in
                    let id = (items[i]["id"] as? String) ?? ""
                    ZStack(alignment: .topTrailing) {
                        Color(white: 0.15)
                        if let t = thumbs[id] { Image(uiImage: t).resizable().scaledToFill() }
                        if (items[i]["video"] as? Bool) == true { Image(systemName: "video.fill").font(.caption).padding(5).foregroundStyle(.white) }
                        if picked.contains(id) { Image(systemName: "checkmark.circle.fill").foregroundStyle(.white, TDColor.accent).padding(5) }
                    }
                    .aspectRatio(1, contentMode: .fill)
                    .clipped()
                    .contentShape(Rectangle())
                    .onAppear { thumb(id); if i == items.count - 1 && more { load() } }
                    .onTapGesture { if picked.isEmpty { open(id) } else { toggle(id) } }
                    .onLongPressGesture { toggle(id) }
                }
            }
            if loading { ProgressView().padding() }
        }
        .background(Backdrop())
        .navigationTitle("Its photos")
        .toolbar {
            if !picked.isEmpty {
                Button("Save \(picked.count)") {
                    core.peer.ask("media.save", ["ids": Array(picked)]) { _ in }
                    picked.removeAll()
                }
            }
        }
        .onAppear { if items.isEmpty { load() } }
        .sheet(item: Binding(get: { viewing.map { Wrap(id: $0) } }, set: { viewing = $0?.id })) { w in
            ZStack {
                Color.black.ignoresSafeArea()
                if let b = big { Image(uiImage: b).resizable().scaledToFit() } else { ProgressView() }
            }
            .overlay(alignment: .bottom) {
                Button("Save to this iPhone") { core.peer.ask("media.save", ["ids": [w.id]]) { _ in }; viewing = nil }.primaryButton().padding()
            }
        }
    }

    private struct Wrap: Identifiable { let id: String }

    private func toggle(_ id: String) { if picked.contains(id) { picked.remove(id) } else { picked.insert(id) } }

    private func load() {
        guard !loading else { return }
        loading = true
        var args: JSON = ["kind": "all", "n": 90]
        if !next.isEmpty { args["before"] = next }
        core.peer.ask("media.list", args) { r in
            loading = false
            if let e = r["error"] as? String {
                perm = (r["perm"] as? String) ?? ""
                error = e == "perm" ? "Photos aren’t allowed for TwinDesk on the phone." : e
                return
            }
            error = ""
            items += (r["items"] as? [JSON]) ?? []
            more = (r["more"] as? Bool) ?? false
            next = (r["next"] as? String) ?? ""
        }
    }

    private func thumb(_ id: String) {
        guard thumbs[id] == nil, !id.isEmpty else { return }
        thumbs[id] = UIImage()
        core.peer.ask("media.thumb", ["id": id]) { r in
            if let d = r["data"] as? String, let img = Self.image(d) { thumbs[id] = img }
        }
    }

    private func open(_ id: String) {
        big = nil
        viewing = id
        core.peer.ask("media.view", ["id": id], timeout: 40) { r in
            if let d = r["data"] as? String { big = Self.image(d) }
        }
    }

    static func image(_ dataUrl: String) -> UIImage? {
        guard let comma = dataUrl.firstIndex(of: ","), let d = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])) else { return nil }
        return UIImage(data: d)
    }
}

// ---- its Messages ----

struct PeerThreadsView: View {
    @EnvironmentObject var core: Core
    @State private var threads: [JSON] = []
    @State private var error = ""
    @State private var perm = ""

    var body: some View {
        List {
            if !error.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(error).foregroundStyle(.secondary)
                    if !perm.isEmpty { Button("Ask on the phone") { core.peer.ask("ask", ["what": "messages"]) { _ in } } }
                }
            }
            ForEach(threads.indices, id: \.self) { i in
                let t = threads[i]
                NavigationLink {
                    PeerThreadView(id: (t["id"] as? String) ?? "", name: (t["name"] as? String) ?? "", to: ((t["addrs"] as? [String]) ?? []).first ?? "")
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text((t["name"] as? String) ?? "").fontWeight((t["unread"] as? Bool) == true ? .bold : .regular).lineLimit(1)
                            Spacer()
                            Text(when(t["at"])).font(.caption).foregroundStyle(.secondary)
                        }
                        Text((t["snippet"] as? String) ?? "").font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Backdrop())
        .navigationTitle("Its messages")
        .refreshable { load() }
        .onAppear { load() }
    }

    private func load() {
        core.peer.ask("sms.threads", ["n": 80]) { r in
            if let e = r["error"] as? String {
                perm = (r["perm"] as? String) ?? ""
                error = e == "perm" ? "Messages aren’t allowed for TwinDesk on the phone." : e
                return
            }
            error = ""
            threads = (r["items"] as? [JSON]) ?? []
        }
    }
}

func when(_ v: Any?) -> String {
    guard let ms = (v as? NSNumber)?.doubleValue, ms > 0 else { return "" }
    let d = Date(timeIntervalSince1970: ms / 1000)
    let f = DateFormatter()
    f.doesRelativeDateFormatting = true
    f.dateStyle = Calendar.current.isDateInToday(d) ? .none : .short
    f.timeStyle = Calendar.current.isDateInToday(d) ? .short : .none
    return f.string(from: d)
}

struct PeerThreadView: View {
    @EnvironmentObject var core: Core
    let id: String
    let name: String
    let to: String
    @State private var items: [JSON] = []
    @State private var text = ""
    @State private var status = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(items.indices.reversed(), id: \.self) { i in
                        let m = items[i]
                        let out = (m["out"] as? Bool) ?? false
                        HStack {
                            if out { Spacer(minLength: 50) }
                            Text((m["body"] as? String) ?? "")
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .background(out ? TDColor.accent : TDColor.card, in: RoundedRectangle(cornerRadius: 18))
                                .foregroundStyle(.white)
                            if !out { Spacer(minLength: 50) }
                        }
                    }
                }
                .padding()
            }
            if !status.isEmpty { Text(status).font(.caption).foregroundStyle(.secondary) }
            HStack {
                TextField("Message", text: $text, axis: .vertical).textFieldStyle(.roundedBorder)
                Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || to.isEmpty)
            }
            .padding()
        }
        .background(Backdrop())
        .navigationTitle(name)
        .onAppear { load() }
    }

    private func load() {
        core.peer.ask("sms.thread", ["id": id, "n": 60]) { r in items = (r["items"] as? [JSON]) ?? [] }
    }

    private func send() {
        let body = text
        text = ""
        status = "Sending…"
        core.peer.ask("sms.send", ["to": to, "body": body]) { r in
            status = (r["error"] as? String) ?? ""
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { load() }
        }
    }
}

// ---- its screen (full screen) ----

struct PeerScreenView: View {
    @EnvironmentObject var core: Core
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let _ = core.tick
        ZStack {
            Color.black.ignoresSafeArea()
            LayerView(layer: core.peer.screen.layer).ignoresSafeArea()
            if !core.peer.screenError.isEmpty {
                Text(core.peer.screenError).foregroundStyle(.white).padding().background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
            } else if core.peer.screen.size == .zero {
                VStack(spacing: 10) {
                    ProgressView().tint(.white)
                    Text("Allow it on \(core.peer.peerName)").foregroundStyle(.white.opacity(0.8))
                }
            }
        }
        .overlay(alignment: .topTrailing) {
            Button { core.peer.stopScreen(); dismiss() } label: {
                Image(systemName: "xmark").font(.headline).padding(12).background(.ultraThinMaterial, in: Circle())
            }
            .padding()
        }
        .statusBarHidden()
        .onChange(of: core.peer.screenOn) { on in if !on { dismiss() } }
        .onDisappear { core.peer.stopScreen() }
    }
}

struct LayerView: UIViewRepresentable {
    let layer: CALayer
    final class Host: UIView {
        var sub: CALayer?
        override func layoutSubviews() {
            super.layoutSubviews()
            CATransaction.begin(); CATransaction.setDisableActions(true)
            sub?.frame = bounds
            CATransaction.commit()
        }
    }
    func makeUIView(context: Context) -> Host {
        let v = Host()
        v.backgroundColor = .black
        layer.removeFromSuperlayer()
        v.layer.addSublayer(layer)
        v.sub = layer
        return v
    }
    func updateUIView(_ v: Host, context: Context) { v.setNeedsLayout() }
}
