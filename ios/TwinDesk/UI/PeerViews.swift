// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Phones (Core/Peer.swift): Android phones and iPhones nearby with TwinDesk, at the bottom of
// Connection as on Android (PhonesSection), pairing by code as with a computer. One session at a
// time: while a phone holds it, the pages are that phone's (PeerPageView, only what both can do:
// its caps), as a computer's pages adapt to a phone.
import SwiftUI
import UniformTypeIdentifiers

extension Core {
    // Another phone holds the session (and so no computer does).
    var peerMode: Bool { !connected && peer.connected }
}

// Which pages show while a phone holds the session.
func peerShows(_ p: Page, _ peer: Peer) -> Bool {
    switch p {
    case .overview, .connection, .general, .about: return true
    case .receive: return peer.can("screen")
    case .share: return true // it views this screen (Share Screen first)
    case .clipboard: return peer.can("clip")
    case .notifications: return peer.can("notifs")
    case .files: return peer.can("files")
    case .photos: return peer.can("photos") || peer.myCaps.contains("photos")
    case .messages: return peer.can("messages")
    default: return false // Remote, Audio, Camera, Media, AirPlay & SMB, Shortcuts: a computer's
    }
}

// Files picked here, copied out of their providers, to the other phone.
private func sendPicked(_ r: Result<[URL], Error>, _ peer: Peer) {
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

// A phone pairing with this one: the code both show, Allow / Deny. On the Connection page and, from
// any page, as a sheet (RootView's PairPrompts).
struct PeerPairAsk: View {
    @EnvironmentObject var core: Core
    let p: Peer.PairReq
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(symbol: "lock.shield.fill", color: TDColor.accent, title: tr("{name} wants to pair", ["name": p.name]),
                       detail: p.code.isEmpty ? tr("Waiting for its code…") : tr("Allow if it shows the same code"))
            if !p.code.isEmpty {
                Text(p.code).font(.system(size: 40, weight: .bold, design: .monospaced)).frame(maxWidth: .infinity)
                HStack {
                    Button(tr("Deny"), role: .destructive) { core.peer.respondPair(false) }.secondaryButton()
                    Spacer()
                    Button(p.allowed ? tr("Waiting for it…") : tr("Allow")) { core.peer.respondPair(true) }.primaryButton().disabled(p.allowed)
                }
            }
        }
    }
}

// ---- at the bottom of Connection: phones nearby, paired, the one connected ----

struct PhonesSection: View {
    @EnvironmentObject var core: Core
    private var peer: Peer { core.peer }

    var body: some View {
        let _ = core.tick
        VStack(spacing: 16) {
            if let p = peer.pair { pairCard(p) }
            if let h = peer.hostPairing { hostPairCard(h) }
            if let a = peer.asked { askedCard(a) }
            if peer.connected { sessionCard }
            if !peer.batches.isEmpty { PeerTransfers() }
            phonesCard
        }
    }

    private func pairCard(_ p: PairState) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(symbol: "lock.shield.fill", color: TDColor.accent, title: tr("Pair with {name}", ["name": p.name]),
                       detail: p.phase == "failed" ? p.error : p.phase == "code" ? tr("Check that both phones show this code") : p.phase == "waiting" ? tr("Waiting for {name} to allow it…", ["name": p.name]) : tr("Connecting…"))
            if p.phase == "code" {
                Text(p.code).font(.system(size: 40, weight: .bold, design: .monospaced)).frame(maxWidth: .infinity)
                HStack {
                    Button(tr("Cancel")) { peer.link.cancelPairing() }.secondaryButton()
                    Spacer()
                    Button(tr("They match")) { peer.link.confirmCode() }.primaryButton()
                }
            } else {
                HStack { Spacer(); Button(p.phase == "failed" ? "OK" : tr("Cancel")) { peer.link.cancelPairing() }.secondaryButton() }
            }
        }
        .glassCard()
    }

    // A phone pairing with us: the code both show, Allow / Deny here.
    private func hostPairCard(_ p: Peer.PairReq) -> some View {
        PeerPairAsk(p: p).glassCard()
    }

    private func askedCard(_ f: Found) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(symbol: "iphone.radiowaves.left.and.right", color: TDColor.good, title: tr("{name} wants to connect", ["name": f.name]), detail: tr("Let it connect to this {device}?", ["device": Device.word]))
            HStack {
                Button(tr("Not now")) { peer.answerAsk(false) }.secondaryButton()
                Spacer()
                Button(tr("Allow")) { peer.answerAsk(true) }.primaryButton()
            }
        }
        .glassCard()
    }

    // Connected: who, and Disconnect. What to do with it is on the pages.
    private var sessionCard: some View {
        DenseCard(title: peer.peerName) {
            Button(tr("Disconnect"), role: .destructive) { peer.disconnect() }.secondaryButton().controlSize(.small)
        } content: {
            DenseRow(symbol: peer.peerOs == "ios" ? "iphone" : "iphone.gen2", title: tr("Connected"),
                     hint: [peer.peerModel.isEmpty ? nil : peer.peerModel, peer.role == "host" ? tr("It connected to this {device}", ["device": Device.word]) : tr("This {device} connected to it", ["device": Device.word])].compactMap { $0 }.joined(separator: " · "),
                     divider: false) { LiveDot(size: 9) }
            DenseRow(symbol: "square.grid.2x2", title: tr("Its pages"),
                     hint: tr("Overview, screens, files and the rest now work with {name}. Pages it can’t do are hidden until it disconnects.", ["name": peer.peerName])) { EmptyView() }
        }
    }

    // One card: the switch, then the phones found (nearby first, then paired ones that aren't).
    private var phonesCard: some View {
        DenseCard(title: tr("Phones and tablets")) {
            if peer.on { Button { core.discovery.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.borderless).accessibilityLabel(tr("Look again")) }
        } content: {
            ToggleRow(title: tr("Connect with phones"), detail: peer.on ? tr("Android phones and iPhones nearby with TwinDesk see this one, and it sees them") : tr("Off: other phones don’t see this one"), on: bind("peer.on"))
                .padding(.vertical, 6)
            if peer.on {
                if !peer.message.isEmpty || !peer.waitingFor.isEmpty {
                    DenseRow(title: peer.waitingFor.isEmpty ? peer.message : tr("Waiting for it to allow this {device}…", ["device": Device.word]), hintColor: TDColor.warn) { EmptyView() }
                }
                let near = peer.nearby()
                let paired = Set(peer.paired().map { $0.id })
                ForEach(near) { f in
                    let here = peer.connected && peer.peerId == f.id
                    DenseRow(symbol: f.os == "ios" ? "iphone" : "iphone.gen2", title: f.name,
                             hint: here ? tr("Connected") : peer.waitingFor == f.id ? tr("Asking it to host…") : paired.contains(f.id) ? (f.port > 0 ? tr("Paired · Ready") : tr("Paired · Nearby")) : (f.port > 0 ? tr("Ready to pair") : tr("Nearby · it asks its owner first"))) {
                        if here { Pill(text: tr("Connected")) }
                        else if peer.waitingFor == f.id { Button(tr("Cancel")) { peer.cancelWait() }.secondaryButton() }
                        else {
                            if paired.contains(f.id) { Button(tr("Forget")) { peer.forget(f.id) }.secondaryButton() }
                            Button(paired.contains(f.id) ? tr("Connect") : tr("Pair")) { peer.connect(f) }.primaryButton().disabled(peer.linkState == "connecting")
                        }
                    }
                }
                ForEach(peer.paired().filter { h in !near.contains { $0.id == h.id } }) { h in
                    DenseRow(symbol: "iphone", title: h.name, hint: tr("Paired · Not nearby")) { Button(tr("Forget")) { peer.forget(h.id) }.secondaryButton() }
                }
                if near.isEmpty && peer.paired().isEmpty {
                    DenseRow(title: tr("Looking for phones…"), hint: tr("Open TwinDesk on the other phone, on the same Wi-Fi (or one’s hotspot).")) { ProgressView() }
                }
                DenseRow(title: tr("Host for other phones"), hint: peer.hostPort > 0 ? tr("They connect without asking · port {hostPort}", ["hostPort": peer.hostPort]) : tr("Paired phones connect without asking first")) {
                    Toggle("", isOn: Binding(get: { _ = core.tick; return peer.hostOn }, set: { peer.setHostOn($0) })).labelsHidden()
                }
                if core.connected {
                    DenseRow(title: tr("Connected to {name}", ["name": core.host?.name ?? tr("a computer")]), hint: tr("Connecting to a phone ends the session with the computer")) { EmptyView() }
                }
            }
        }
    }

    private func bind(_ k: String) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.store.flag(k, true) }, set: { peer.set(k, $0) })
    }
}

struct PeerTransfers: View {
    @EnvironmentObject var core: Core
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(core.peer.batches.values)) { b in
                VStack(alignment: .leading, spacing: 4) {
                    Text(b.up ? tr("Sending {file}", ["file": b.name]) : tr("Receiving {file}", ["file": b.name])).font(.subheadline)
                    ProgressView(value: b.progress)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}

// ---- the pages while a phone holds the session ----

struct PeerPageView: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    let page: Page
    @State private var picking = false
    private var peer: Peer { core.peer }

    var body: some View {
        let _ = core.tick
        Group {
            if !peerShows(page, peer) {
                PageScroll(title: page.title) { note(tr("{name} can’t do this. It’s back when you connect to a computer.", ["name": peer.peerName])) }
            } else {
                switch page {
                case .receive: receive
                case .share: share
                case .clipboard: clipboard
                case .notifications: notifications
                case .files: files
                case .photos: photos
                case .messages: PeerThreadsView()
                default: overview
                }
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in sendPicked(r, peer) }
    }

    private func note(_ t: String) -> some View {
        Text(t).font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).glassCard()
    }

    private var overview: some View {
        PageScroll(title: peer.peerName) {
            Columns {
                Hero()
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 12)], spacing: 12) {
                    if peer.can("screen") { tile(tr("Its screen"), "rectangle.on.rectangle", Page.receive.color) { peer.startScreen(); ui.cover = .peerScreen } }
                    if peer.can("files") { tile(tr("Send files"), "paperplane.fill", Page.files.color) { picking = true } }
                    if peer.can("clip") { tile(tr("Clipboard"), "doc.on.clipboard", Page.clipboard.color) { if let t = UIPasteboard.general.string { peer.clipOut(t) } } }
                    if peer.can("photos") { tile(tr("Its photos"), "photo.on.rectangle", Page.photos.color) { ui.open(.photos) } }
                    if peer.can("messages") { tile(tr("Its messages"), "message.fill", Page.messages.color) { ui.open(.messages) } }
                }
            } right: {
                if !peer.batches.isEmpty { PeerTransfers() }
                if !peer.screenError.isEmpty { note(peer.screenError) }
                ShareScreenCard()
            }
        }
    }

    private func tile(_ title: String, _ icon: String, _ color: Color, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            VStack(spacing: 8) {
                FeatureIcon(symbol: icon, color: color, size: 36)
                Text(title).font(.caption.weight(.medium)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, -4)
            .glassCard(20)
        }
        .buttonStyle(.plain).hoverLift()
    }

    private var receive: some View {
        PageScroll(title: tr("Receive screen")) {
            DenseCard(title: tr("{name}’s screen", ["name": peer.peerName])) {
                DenseRow(symbol: "rectangle.on.rectangle", title: tr("Show it here"),
                         hint: peer.peerOs == "ios" ? tr("{name} starts Share Screen in TwinDesk first.", ["name": peer.peerName]) : tr("{name} is asked to start sharing.", ["name": peer.peerName]), divider: false) {
                    Button(tr("Show")) { peer.startScreen(); ui.cover = .peerScreen }.primaryButton()
                }
                if !peer.screenError.isEmpty { DenseRow(title: peer.screenError, hintColor: TDColor.warn) { EmptyView() } }
            }
        }
    }

    private var share: some View {
        PageScroll(title: tr("Share screen")) {
            ShareScreenCard()
            note(tr("Start Share Screen, then {name} shows this {device}’s screen from its Screen page. iOS asks each time: tap Start Broadcast with TwinDesk picked.", ["name": peer.peerName, "device": Device.word]))
        }
    }

    private var clipboard: some View {
        PageScroll(title: tr("Clipboard")) {
            DenseCard(title: tr("With {name}", ["name": peer.peerName])) {
                ToggleRow(title: tr("Clipboard"), detail: tr("Copies go both ways while TwinDesk is open here"), on: bind("peer.clip")).padding(.vertical, 6)
                DenseRow(symbol: "doc.on.clipboard", title: tr("Send what’s copied"), hint: tr("This {device}’s clipboard to {name} now", ["device": Device.word, "name": peer.peerName])) {
                    Button(tr("Send")) { if let t = UIPasteboard.general.string { peer.clipOut(t) } }.primaryButton()
                }
            }
        }
    }

    private var notifications: some View {
        PageScroll(title: tr("Notifications")) {
            DenseCard(title: tr("With {name}", ["name": peer.peerName])) {
                ToggleRow(title: tr("Its notifications"), detail: tr("{name}’s notifications shown here", ["name": peer.peerName]), on: bind("peer.notifs")).padding(.vertical, 6)
            }
            note(tr("iOS doesn’t let apps read other apps’ notifications, so this {device}’s don’t go to {name}.", ["device": Device.word, "name": peer.peerName]))
        }
    }

    private var files: some View {
        PageScroll(title: tr("File Sharing")) {
            DenseCard(title: tr("With {name}", ["name": peer.peerName])) {
                DenseRow(symbol: "paperplane.fill", title: tr("Send files"), hint: tr("To {name}. Or share from any app to TwinDesk.", ["name": peer.peerName]), divider: false) {
                    Button(tr("Choose…")) { picking = true }.primaryButton()
                }
                DenseRow(symbol: "tray.and.arrow.down", title: tr("Received"), hint: tr("What {name} sends is in Files › On My {device} › TwinDesk › Received.", ["name": peer.peerName, "device": Device.word])) { EmptyView() }
            }
            if !peer.batches.isEmpty { PeerTransfers() }
        }
    }

    @ViewBuilder
    private var photos: some View {
        if peer.can("photos") {
            PeerPhotosView()
                .safeAreaInset(edge: .bottom) {
                    ToggleRow(title: tr("Photos here on {name}", ["name": peer.peerName]), detail: tr("It can see and save this {device}’s photos", ["device": Device.word]), on: bind("peer.photos"))
                        .glassCard().padding(.horizontal, 16)
                }
        } else {
            PageScroll(title: tr("Photos")) {
                DenseCard(title: tr("With {name}", ["name": peer.peerName])) {
                    ToggleRow(title: tr("Photos here on {name}", ["name": peer.peerName]), detail: tr("It can see and save this {device}’s photos", ["device": Device.word]), on: bind("peer.photos")).padding(.vertical, 6)
                }
            }
        }
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
                    if !perm.isEmpty { Button(tr("Ask on the phone")) { core.peer.ask("ask", ["what": "media"]) { _ in } }.primaryButton() }
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
        .navigationTitle(tr("Its photos"))
        .toolbar {
            if !picked.isEmpty {
                Button(tr("Save {count}", ["count": picked.count])) {
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
                Button(tr("Save to this iPhone")) { core.peer.ask("media.save", ["ids": [w.id]]) { _ in }; viewing = nil }.primaryButton().padding()
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
                error = e == "perm" ? tr("Photos aren’t allowed for TwinDesk on the phone.") : e
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
                    if !perm.isEmpty { Button(tr("Ask on the phone")) { core.peer.ask("ask", ["what": "messages"]) { _ in } } }
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
        .navigationTitle(tr("Its messages"))
        .refreshable { load() }
        .onAppear { load() }
    }

    private func load() {
        core.peer.ask("sms.threads", ["n": 80]) { r in
            if let e = r["error"] as? String {
                perm = (r["perm"] as? String) ?? ""
                error = e == "perm" ? tr("Messages aren’t allowed for TwinDesk on the phone.") : e
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
                TextField(tr("Message"), text: $text, axis: .vertical).textFieldStyle(.roundedBorder)
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
        status = tr("Sending…")
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
                    Text(tr("Allow it on {name}", ["name": core.peer.peerName])).foregroundStyle(.white.opacity(0.8))
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
