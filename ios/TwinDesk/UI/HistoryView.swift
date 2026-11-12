// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// History's own view (History.swift): the clipboard's or the notifications', newest first, with a
// filter; a copied item is copied again with a tap. And the History card on the Clipboard and
// Notifications pages: Open, Keep history, for how long, and a shortcut on the Overview.
import SwiftUI

struct HistoryView: View {
    @EnvironmentObject var core: Core
    @Environment(\.dismiss) private var dismiss
    let what: String
    @State private var q = ""

    var body: some View {
        let _ = core.tick
        let clip = what == "clip"
        let name = core.host?.name ?? tr("the computer")
        let all = clip ? core.history.clip() : core.history.notifs()
        let t = q.trimmingCharacters(in: .whitespaces)
        let list = t.isEmpty ? all : all.filter { e in [e.text, e.title, e.app].contains { $0.localizedCaseInsensitiveContains(t) } }
        List {
            Section {
                if list.isEmpty {
                    Text(all.isEmpty ? tr("Nothing yet") : tr("Nothing found")).foregroundStyle(.secondary).listRowBackground(TDColor.card)
                }
                ForEach(list) { e in
                    Button { if clip { core.clip.write(e.text) } } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            if !clip {
                                Text([e.app, e.title].filter { !$0.isEmpty }.joined(separator: " · ")).font(.subheadline.weight(.semibold)).foregroundStyle(TDColor.text).lineLimit(1)
                            }
                            if !e.text.isEmpty {
                                Text(e.text).font(clip ? .body : .subheadline).foregroundStyle(clip ? TDColor.text : .secondary).lineLimit(3)
                            }
                            Text((clip ? (e.dir == "in" ? tr("From {name}", ["name": name]) : tr("To {name}", ["name": name])) + " · " : "")
                                 + ago(e.at) + (clip ? tr(" · tap to copy") : ""))
                                .font(.caption).foregroundStyle(.tertiary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(TDColor.card)
                }
            } footer: {
                Text(core.history.save ? tr("Kept encrypted on this device for {count} days", ["count": core.history.keepDays])
                                       : tr("Since TwinDesk opened. Keep history on its page to keep it longer"))
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Backdrop())
        .searchable(text: $q, prompt: tr("Filter"))
        .navigationTitle(clip ? tr("Clipboard history") : tr("Notification history"))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(tr("Done")) { dismiss() } }
            ToolbarItem(placement: .destructiveAction) { if !all.isEmpty { Button(tr("Clear"), role: .destructive) { core.history.clear(what) } } }
        }
    }

    private func ago(_ at: Double) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: Date(timeIntervalSince1970: at), relativeTo: Date())
    }
}

// The History card on the Clipboard and Notifications pages.
struct HistoryCard: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    let what: String

    var body: some View {
        let _ = core.tick
        let h = core.history
        let tile = what == "clip" ? "clipHistory" : "notifHistory"
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(what == "clip" ? tr("Clipboard history") : tr("Notification history")).font(.subheadline.weight(.semibold))
                    Text(tr("{count} items", ["count": (what == "clip" ? h.clip() : h.notifs()).count])).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button(tr("Open")) { ui.history = what }.secondaryButton()
            }
            Divider()
            ToggleRow(title: tr("Keep history"), detail: h.save ? tr("Encrypted on this device, with a key only TwinDesk can use") : tr("Off: forgotten when TwinDesk quits"),
                      on: Binding(get: { _ = core.tick; return h.save }, set: { h.setSave($0) }))
            if h.save {
                Picker(tr("Keep for"), selection: Binding(get: { _ = core.tick; return h.keepDays }, set: { h.setDays($0) })) {
                    Text(tr("A day")).tag(1); Text(tr("A week")).tag(7); Text(tr("30 days")).tag(30); Text(tr("A year")).tag(365)
                }
                .pickerStyle(.segmented)
                Text(tr("Older items are deleted")).font(.caption).foregroundStyle(.secondary)
            }
            if !h.error.isEmpty { Text(h.error).font(.caption).foregroundStyle(TDColor.warn) }
            Divider()
            ToggleRow(title: tr("Shortcut on the Overview"), detail: tr("Opens this history"),
                      on: Binding(get: { _ = core.tick; return TileLayout.has(core.store, tile) }, set: { TileLayout.set(core.store, tile, $0); core.changed() }))
        }
        .glassCard()
    }
}

// The computer's notifications shown here, newest first, at the bottom of their page.
struct RecentNotifs: View {
    @EnvironmentObject var core: Core

    var body: some View {
        let _ = core.tick
        let recent = Array(core.history.notifs().prefix(8))
        if !recent.isEmpty {
            SectionTitle(text: tr("Recent"))
            VStack(alignment: .leading, spacing: 10) {
                ForEach(recent) { e in
                    VStack(alignment: .leading, spacing: 2) {
                        Text([e.app, e.title].filter { !$0.isEmpty }.joined(separator: " · ")).font(.subheadline.weight(.semibold)).lineLimit(1)
                        if !e.text.isEmpty { Text(e.text).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .glassCard()
        }
    }
}
