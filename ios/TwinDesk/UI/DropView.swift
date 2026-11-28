// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drop (Core/Drop.swift): one conversation with every TwinDesk device, as on Android's Drop page. The To
// picker sends to everyone or to one device; the gear shows the devices (Block) and Clear All. Holding a
// message shows its actions: Copy, Share (Save to Files there), Delete for me, Delete for everyone (its sender's).
import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct DropView: View {
    @EnvironmentObject var core: Core
    @State private var text = ""
    @State private var to = "*"
    @State private var picking = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var settings = false
    @FocusState private var typing: Bool

    var body: some View {
        let _ = core.tick
        let drop = core.drop
        Group {
            if !drop.on { off } else { room }
        }
        .background(Backdrop())
        .navigationTitle(tr("Drop"))
        .toolbar {
            if drop.on {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { settings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel(tr("Devices"))
                }
            }
        }
        .sheet(isPresented: $settings) { DropSettings().environmentObject(core) }
        .onAppear { drop.ask(); drop.read() }
        .onChange(of: core.tick) { _ in if core.inFront { drop.read() } }
    }

    private var off: some View {
        ScrollView {
            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    ToggleRow(title: tr("Drop"), detail: tr("One conversation with all your devices: messages, links, pictures and files."),
                              on: Binding(get: { core.drop.on }, set: { core.drop.setOn($0) }))
                    Text(tr("Drop is off. Turn it on to send and receive messages with your other devices.")).font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()
            }
            .pageWidth()
        }
    }

    private var room: some View {
        let items = core.drop.view()
        return VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        if !core.connected {
                            Text(tr("Not connected. What you send waits here and goes when TwinDesk connects to a computer."))
                                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.top, 8)
                        }
                        if items.isEmpty {
                            Text(tr("No messages yet. What you send here reaches every device, or the one you pick."))
                                .foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.top, 60).padding(.horizontal, 30)
                        }
                        ForEach(items) { x in DropBubble(item: x).id(x.id) }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .frame(maxWidth: 900).frame(maxWidth: .infinity)
                }
                .scrollDismissesKeyboard(.interactively)
                .onAppear { if let l = items.last { proxy.scrollTo(l.id, anchor: .bottom) } }
                .onChange(of: items.last?.id) { id in if let id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } } }
            }
            if !core.drop.note.isEmpty {
                HStack {
                    Text(core.drop.note).font(.caption).foregroundStyle(.orange)
                    Spacer()
                    Button { core.drop.setNote("") } label: { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16).padding(.vertical, 6)
            }
            composer
        }
    }

    private var toName: String {
        to == "*" ? tr("Everyone") : (core.drop.members.first { $0.id == to }?.name ?? tr("one device"))
    }

    private var composer: some View {
        VStack(spacing: 8) {
            HStack {
                Text(tr("To")).font(.caption).foregroundStyle(.secondary)
                Menu {
                    Button(tr("Everyone")) { to = "*" }
                    let ms = core.drop.members
                    if ms.isEmpty { Text(core.connected ? tr("No other devices yet") : tr("Connect to a computer: it brings in the other devices.")) }
                    ForEach(ms) { m in
                        Button { to = m.id } label: { Label(m.name, systemImage: m.os == "android" || m.os == "ios" ? "iphone" : osSymbol(m.os)) }
                    }
                } label: {
                    HStack(spacing: 4) { Text(toName); Image(systemName: "chevron.up.chevron.down").font(.caption2) }.font(.caption.weight(.semibold))
                }
                Spacer()
            }
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    Button { picking = true } label: { Label(tr("Attach files"), systemImage: "doc") }
                    PhotosPicker(selection: $photos, maxSelectionCount: 10, matching: .any(of: [.images, .videos])) { Label(tr("Photos"), systemImage: "photo") }
                } label: {
                    Image(systemName: "plus").font(.system(size: 17, weight: .semibold)).frame(width: 36, height: 36)
                }
                .accessibilityLabel(tr("Attach files"))
                TextField(tr("Message"), text: $text, axis: .vertical)
                    .lineLimit(1...6).focused($typing)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(TDColor.card))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(TDColor.line))
                Button {
                    core.drop.post(to: to, text: text); text = ""
                } label: {
                    Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).frame(width: 36, height: 36)
                        .background(Circle().fill(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.gray.opacity(0.35) : TDColor.accent))
                        .foregroundStyle(.white)
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(tr("Send"))
            }
        }
        .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 10)
        .background(.bar)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
            if case .success(let urls) = r { core.drop.postFiles(to: to, urls: urls) }
        }
        .onChange(of: photos) { list in
            guard !list.isEmpty else { return }
            photos = []
            let dest = to
            Task {
                var out: [(String, Data?, Bool)] = []
                for (i, p) in list.enumerated() {
                    guard let d = try? await p.loadTransferable(type: Data.self) else { continue }
                    let ext = p.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                    out.append(("Photo \(i + 1).\(ext)", d.count > Drop.maxFile ? nil : d, d.count > Drop.maxFile))
                }
                core.drop.post(to: dest, files: out)
            }
        }
    }
}

private struct DropBubble: View {
    @EnvironmentObject var core: Core
    let item: Drop.Item

    private var mine: Bool { item.from == core.store.deviceId }
    private var whenText: String {
        let d = Date(timeIntervalSince1970: TimeInterval(item.at) / 1000)
        return Calendar.current.isDateInToday(d) ? d.formatted(date: .omitted, time: .shortened) : d.formatted(date: .abbreviated, time: .shortened)
    }
    private var who: String {
        if mine { return item.to == "*" ? "" : tr("To {name}", ["name": core.drop.members.first { $0.id == item.to }?.name ?? tr("one device")]) }
        return item.to == "*" ? item.name : tr("{name}, only to you", ["name": item.name])
    }

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 50) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                if !who.isEmpty { Text(who).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).padding(.horizontal, 6) }
                VStack(alignment: .leading, spacing: 6) {
                    if let f = item.file {
                        if f.image, let img = core.drop.thumb(item) {
                            Image(uiImage: img).resizable().scaledToFit().frame(maxWidth: 260, maxHeight: 260).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        } else {
                            HStack(spacing: 8) {
                                Image(systemName: "doc.fill").font(.title3)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(f.name).font(.subheadline.weight(.medium)).lineLimit(2)
                                    Text(ByteCountFormatter.string(fromByteCount: f.size, countStyle: .file)).font(.caption).opacity(0.75)
                                }
                            }
                        }
                    }
                    if !item.text.isEmpty {
                        Text(.init(linked(item.text))).textSelection(.enabled).tint(mine ? .white : TDColor.accent)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(mine ? TDColor.accent : TDColor.card))
                .foregroundStyle(mine ? Color.white : TDColor.text)
                .contextMenu { actions }
                Text(whenText).font(.caption2).foregroundStyle(.tertiary).padding(.horizontal, 6)
            }
            if !mine { Spacer(minLength: 50) }
        }
    }

    @ViewBuilder private var actions: some View {
        if !item.text.isEmpty {
            Button { UIPasteboard.general.string = item.text; core.drop.setNote(tr("Copied")) } label: { Label(tr("Copy"), systemImage: "doc.on.doc") }
        }
        if let u = core.drop.fileURL(item), item.file != nil {
            ShareLink(item: u) { Label(tr("Share"), systemImage: "square.and.arrow.up") }
        } else if !item.text.isEmpty {
            ShareLink(item: item.text) { Label(tr("Share"), systemImage: "square.and.arrow.up") }
        }
        Button(role: .destructive) { core.drop.del(item.id, everyone: false) } label: { Label(tr("Delete for me"), systemImage: "trash") }
        if mine {
            Button(role: .destructive) { core.drop.del(item.id, everyone: true) } label: { Label(tr("Delete for everyone"), systemImage: "trash.slash") }
        }
    }

    // Links in the text, tappable (Markdown's autolinks; the rest stays as it is).
    private func linked(_ s: String) -> String {
        let esc = s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "*", with: "\\*").replacingOccurrences(of: "_", with: "\\_")
            .replacingOccurrences(of: "`", with: "\\`").replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
        return esc.replacingOccurrences(of: "(https?://[^\\s<>]+)", with: "<$1>", options: .regularExpression)
    }
}

// The gear: the devices in the conversation (Block / Unblock) and Clear All.
private struct DropSettings: View {
    @EnvironmentObject var core: Core
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = false

    var body: some View {
        let _ = core.tick
        let blocked = core.drop.blockedList()
        let members = core.drop.members
        let extra = blocked.filter { b in !members.contains { $0.id == b.id } }
        NavigationStack {
            List {
                Section {
                    ToggleRow(title: tr("Drop"), detail: tr("One conversation with all your devices: messages, links, pictures and files."),
                              on: Binding(get: { core.drop.on }, set: { core.drop.setOn($0) }))
                }
                Section {
                    if members.isEmpty && extra.isEmpty { Text(core.connected ? tr("No other devices yet") : tr("Connect to a computer: it brings in the other devices.")).foregroundStyle(.secondary) }
                    ForEach(members) { m in row(m.id, m.name, m.os, online: m.online, blocked: blocked.contains { $0.id == m.id }) }
                    ForEach(extra, id: \.id) { b in row(b.id, b.name, "", online: false, blocked: true) }
                } header: { Text(tr("Devices")) } footer: { Text(tr("Phones and computers connected to this one join the conversation.")) }
                Section {
                    Button(tr("Clear All"), role: .destructive) { confirm = true }
                } footer: { Text(tr("Removes every message from this {device} only. The other devices keep theirs.", ["device": Device.word])) }
            }
            .navigationTitle(tr("Drop"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(tr("Done")) { dismiss() } } }
            .confirmationDialog(tr("Clear All"), isPresented: $confirm) {
                Button(tr("Clear All"), role: .destructive) { core.drop.clear() }
            }
        }
        .onAppear { core.drop.ask() }
    }

    private func row(_ id: String, _ name: String, _ os: String, online: Bool, blocked: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: os == "android" || os == "ios" ? "iphone" : osSymbol(os)).frame(width: 24).foregroundStyle(online ? TDColor.accent : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                if blocked { Text(tr("Blocked: its messages aren’t shown here")).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            Button(blocked ? tr("Unblock") : tr("Block")) { core.drop.block(id, !blocked, name: name) }.buttonStyle(.borderless)
        }
    }
}
