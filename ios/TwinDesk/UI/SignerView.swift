// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// App refresh: TwinDesk (and, with a computer that allows it, another IPA) signed with the person's
// own Apple ID by the connected computer (Core/SignerFeature.swift). Opt in, and said plainly: the
// warning first, how it works, what's sideloaded here and when each runs out.
import SwiftUI
import UniformTypeIdentifiers

struct SignerView: View {
    @EnvironmentObject var core: Core
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @State private var picking = false
    @State private var askSignOut = false
    @State private var showHow = false
    @State private var askOn = false
    @State private var askStartOver = false
    @State private var revoking: Signer.Cert?

    private var s: Signer { core.signer }
    private var pc: String { core.host?.name ?? tr("the computer") }

    var body: some View {
        let _ = core.tick
        PageScroll(title: tr("App refresh")) {
            // The switch works with or without a computer; off, only the warning and How this works.
            toggle
            warning
            if s.on {
                if !core.connected { NeedsComputer(what: tr("App refresh")) }
                else if !s.available { unavailable }
                else {
                    Columns {
                        VStack(spacing: 16) { status; if s.running || s.need != nil { runCard }; if !s.running, s.error != nil || s.doneUntil != nil { resultCard }; if showSignIn { signInCard } }
                    } right: {
                        VStack(spacing: 16) { appsCard; options }
                    }
                }
            }
            how
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [UTType(filenameExtension: "ipa") ?? .item], allowsMultipleSelection: false) { r in
            guard case .success(let urls) = r, let u = urls.first else { return }
            // A copy of its own: the picked file is only readable while this runs.
            let scoped = u.startAccessingSecurityScopedResource()
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let to = dir.appendingPathComponent(u.lastPathComponent)
            let ok = (try? FileManager.default.copyItem(at: u, to: to)) != nil
            if scoped { u.stopAccessingSecurityScopedResource() }
            if ok { s.install(to) }
        }
        .alert(tr("Not recommended"), isPresented: $askOn) {
            Button(tr("Turn on anyway"), role: .destructive) { s.on = true }
            Button(tr("Cancel"), role: .cancel) {}
        } message: {
            Text(tr("This signs in to Apple with your Apple ID from TwinDesk. Apple can refuse the sign-in, lock the Apple ID for a while, or stop it from signing apps. We recommend AltStore: if you already use it, keep using it."))
        }
        .alert(tr("Revoke the certificate made by {name}?", ["name": revoking?.name ?? ""]), isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } })) {
            Button(tr("Revoke"), role: .destructive) { if let c = revoking { s.revoke(c.id) }; revoking = nil }
            Button(tr("Cancel"), role: .cancel) { revoking = nil }
        } message: {
            Text(tr("Apps signed with this certificate stop launching until they are signed again with a new certificate. The tool that made it has to make a new one the next time it runs. This cannot be undone."))
        }
        .confirmationDialog(tr("Start over with a new certificate?"), isPresented: $askStartOver, titleVisibility: .visible) {
            Button(tr("Revoke and start over"), role: .destructive) { s.startOver() }
            Button(tr("Cancel"), role: .cancel) {}
        } message: {
            Text(tr("TwinDesk’s certificate is revoked at Apple and a new one is made, then TwinDesk is signed and installed again. Other apps installed with TwinDesk need to be refreshed again."))
        }
        .confirmationDialog(tr("Sign out of App refresh?"), isPresented: $askSignOut, titleVisibility: .visible) {
            Button(tr("Sign out")) { s.signOut(everything: false) }
            Button(tr("Sign out and forget the certificate"), role: .destructive) { s.signOut(everything: true) }
            Button(tr("Cancel"), role: .cancel) {}
        }
    }

    private var showSignIn: Bool { !s.running && (!s.facts.signedIn || s.needsSignIn) }

    private var toggle: some View {
        VStack(alignment: .leading, spacing: 12) {
            ToggleRow(title: tr("App refresh"), detail: tr("The computer re-signs TwinDesk before its 7-day provisioning profile expires. Switching this on or off does the same in TwinDesk on the computer."),
                      on: Binding(get: { s.on }, set: { if $0 { askOn = true } else { s.on = false } }))
            Divider()
            ToggleRow(title: tr("Expiry on Overview"), detail: tr("In TwinDesk’s last 7 days, Overview shows when it expires, with Refresh now."),
                      on: Binding(get: { s.homeCard }, set: { s.homeCard = $0 }))
        }
        .glassCard()
    }

    // One warning, AltStore recommended in it.
    private var warning: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill").font(.title2).foregroundStyle(TDColor.bad)
            VStack(alignment: .leading, spacing: 8) {
                Text(tr("Not recommended")).font(.headline).foregroundStyle(TDColor.bad)
                Text(tr("Apple has refused sign-ins from tools like this one, locked Apple IDs for a while, and stopped some from signing apps at all. Use an Apple ID made for this, not your main one."))
                    .font(.subheadline)
                Divider()
                Text(tr("We recommend AltStore. If you already use it, keep using it.")).font(.subheadline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(tint: .red)
    }

    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 8) {
            CardHeader(symbol: "signature", color: Page.signing.color, title: tr("{name} can’t sign yet", ["name": pc]))
            Text(tr("TwinDesk on {name} turns this on as well once it is connected. If it doesn’t, update TwinDesk on {name} to a version that includes TwinDesk iPhone.", ["name": pc]))
                .font(.caption).foregroundStyle(.secondary)
        }
        .glassCard()
    }

    private var status: some View {
        let f = s.facts
        let mine = s.apps.first { $0.twindesk }
        return VStack(alignment: .leading, spacing: 12) {
            CardHeader(symbol: "signature", color: Page.signing.color, title: tr("TwinDesk on this device"),
                       detail: mine.map { left($0.expires) } ?? "")
            if f.signedIn {
                Text(tr("Signed in as {account}. Apple’s session lasts until {date}.", ["account": f.email, "date": day(f.until / 1000)]))
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text(tr("Not signed in.")).font(.caption).foregroundStyle(.secondary)
            }
            if !s.seen {
                Text(tr("{name} doesn’t see this device for installing right now. It looks again when a refresh starts; if it still can’t, connect the cable once, unlock and tap Trust, and turn on Wi-Fi sync.", ["name": pc]))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if f.signedIn && !s.running {
                Button { s.refresh() } label: { Label(tr("Refresh now"), systemImage: "arrow.clockwise").frame(maxWidth: .infinity) }.primaryButton()
                Button(tr("Start over…")) { askStartOver = true }.secondaryButton().controlSize(.small)
            }
        }
        .glassCard()
    }

    // The run's steps: done ones ticked, the one running with a spinner (and its percent), the ones to come dimmed.
    private static let ahead = ["register", "cert", "appid", "profile", "installprofile", "sign", "install"]
    private static let order = ["upload", "find", "cached", "download", "signin", "session", "register", "revoke", "cert", "appid", "profile", "installprofile", "sign", "install"]

    private var runCard: some View {
        let steps = Self.order.filter { s.done.contains($0) || Self.ahead.contains($0) }
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                CardHeader(symbol: "signature", color: Page.signing.color, title: tr("Progress"))
                Spacer()
                Button(tr("Stop")) { s.stop() }.secondaryButton().controlSize(.small)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(steps, id: \.self) { k in
                    let now = k == s.step
                    let done = !now && s.done.contains(k)
                    HStack(spacing: 10) {
                        if now { ProgressView().controlSize(.small).frame(width: 18) }
                        else { Image(systemName: done ? "checkmark.circle.fill" : "circle").foregroundStyle(done ? TDColor.good : Color.secondary.opacity(0.5)).frame(width: 18) }
                        Text(label(k)).font(.subheadline).fontWeight(now ? .semibold : .regular).foregroundStyle(now ? TDColor.text : done ? Color.secondary : Color.secondary.opacity(0.6))
                        Spacer()
                        if now && (k == "sign" || k == "install") && s.percent > 0 { Text("\(s.percent)%").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                    }
                }
            }
            if (s.step == "install" || s.step == "sign") && s.percent > 0 { ProgressView(value: Double(s.percent), total: 100) }
            switch s.need {
            case .code(let err):
                Text(tr("Apple sent a code to your devices.")).font(.caption).foregroundStyle(.secondary)
                if !err.isEmpty { Text(err).font(.caption).foregroundStyle(TDColor.bad) }
                HStack {
                    TextField(tr("Verification code"), text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode).textFieldStyle(.roundedBorder)
                    Button(tr("Continue")) { s.answer(code: code); code = "" }.primaryButton().disabled(code.count < 6)
                }
            case .certs(let certs):
                Text(tr("This Apple ID has the maximum number of development certificates. Revoke one to continue: apps signed with it stop launching until they are signed again. Nothing is revoked unless you choose it here."))
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(certs) { c in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(c.name)
                            Text(c.ours ? day(c.expires) : tr("Created by another tool: the apps it signed stop launching")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(tr("Revoke"), role: .destructive) { if c.ours { s.revoke(c.id) } else { revoking = c } }.secondaryButton().controlSize(.small)
                    }
                }
                Button(tr("Cancel")) { s.cancelQuestion() }.secondaryButton()
            case nil: EmptyView()
            }
        }
        .glassCard()
    }

    // How the last run ended: what went wrong (Apple's words and code), or until when it runs now.
    private var resultCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let e = s.error {
                Label(tr("It didn’t work"), systemImage: "exclamationmark.triangle.fill").font(.headline).foregroundStyle(TDColor.bad)
                Text(e).font(.subheadline).textSelection(.enabled)
            } else if let d = s.doneUntil {
                Label(tr("Installed"), systemImage: "checkmark.circle.fill").font(.headline).foregroundStyle(TDColor.good)
                Text(tr("Installed. It runs until {date}.", ["date": day(d.timeIntervalSince1970)])).font(.subheadline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(tint: s.error != nil ? .red : nil)
    }

    private var signInCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(symbol: "person.badge.key.fill", color: Page.signing.color, title: tr("Sign in with an Apple ID"),
                       detail: tr("The password is used once, to sign in, and is not kept."))
            TextField("Apple ID", text: $email).textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
            SecureField(tr("Password"), text: $password).textContentType(.password).textFieldStyle(.roundedBorder)
            Button {
                s.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password)
                password = ""
            } label: { Text(tr("Sign in and refresh")).frame(maxWidth: .infinity) }
                .primaryButton().disabled(email.isEmpty || password.isEmpty)
        }
        .glassCard()
    }

    private var appsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(symbol: "square.grid.2x2.fill", color: TDColor.accent, title: tr("Sideloaded apps"), detail: tr("Each runs until its date, then has to be signed again."))
            if s.apps.isEmpty { Text(tr("None found")).font(.caption).foregroundStyle(.secondary) }
            ForEach(s.apps) { a in
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(a.name)
                        Text([a.version, a.teamName].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if s.anyIpa && s.facts.signedIn && !s.running {
                        Button { s.refresh(app: a.id) } label: { Image(systemName: "arrow.clockwise") }.secondaryButton().controlSize(.small).accessibilityLabel(tr("Refresh now"))
                    }
                    Text(left(a.expires)).font(.caption.monospacedDigit()).foregroundStyle(a.expires - Date().timeIntervalSince1970 < 2 * 86400 ? TDColor.bad : .secondary)
                }
            }
            if s.anyIpa && s.facts.signedIn && !s.running {
                Button { picking = true } label: { Label(tr("Install an IPA…"), systemImage: "plus").frame(maxWidth: .infinity) }.secondaryButton()
            }
        }
        .glassCard()
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 12) {
            ToggleRow(title: tr("Refresh automatically"), detail: tr("When {name} says an app here has few days left: by itself while this device is unlocked, else a notification to tap.", ["name": pc]),
                      on: Binding(get: { s.auto }, set: { s.auto = $0 }))
            if s.computerKeeps {
                Label(tr("{name} keeps a copy of the signing session (switched on there).", ["name": pc]), systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
            }
            if s.facts.signedIn || !s.facts.email.isEmpty {
                Button(tr("Sign out…"), role: .destructive) { askSignOut = true }.secondaryButton()
            }
        }
        .glassCard()
    }

    private var how: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation { showHow.toggle() } } label: {
                HStack { Text(tr("How this works")).font(.headline); Spacer(); Image(systemName: showHow ? "chevron.up" : "chevron.down") }.foregroundStyle(TDColor.text)
            }
            if showHow {
                Group {
                    Text(tr("An app from outside the App Store runs for 7 days when it is signed with a free Apple ID, and then has to be signed again. AltStore and Sideloadly do that. This does the same from TwinDesk."))
                    Text(tr("The computer signs in to Apple with your Apple ID the way Xcode does, asks for a development certificate named “TwinDesk”, signs the app with it and installs it through the cable or Wi-Fi sync."))
                    Text(tr("Your password is used once and kept nowhere. What is kept, in this device’s Keychain only, is Apple’s developer session (about a year; it can manage certificates and app IDs, not iCloud or purchases), the certificate’s key and a device identity. For each refresh they are sealed for the computer’s signing helper, which keeps nothing."))
                    Text(tr("The Apple ID and password go to Apple only. One more server is used, an “anisette” server ({server}), which Apple’s sign-in needs. It never gets the Apple ID or the password, but it does hold the identity Apple trusts after your verification code.", ["server": s.anisette]))
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
        .glassCard()
    }

    private func label(_ k: String) -> String {
        switch k {
        case "upload": return tr("Sending the file to the computer…")
        case "cached": return tr("Using the TwinDesk copy stored on the computer…")
        case "download": return tr("Downloading TwinDesk…")
        case "signin": return tr("Signing in to Apple…")
        case "find": return tr("Waiting for the computer to see this device…")
        case "session": return tr("Opening the Apple session…")
        case "register": return tr("Registering the device…")
        case "revoke": return tr("Revoking TwinDesk’s certificate…")
        case "cert": return tr("Getting the certificate…")
        case "appid": return tr("Registering the app ID…")
        case "profile": return tr("Getting the provisioning profile…")
        case "installprofile": return tr("Installing the provisioning profiles…")
        case "sign": return tr("Signing the app…")
        case "install": return tr("Installing…")
        default: return tr("Working…")
        }
    }

    private func day(_ seconds: Double) -> String {
        seconds > 0 ? Date(timeIntervalSince1970: seconds).formatted(date: .abbreviated, time: .shortened) : ""
    }

    private func left(_ expires: Double) -> String {
        let secs = expires - Date().timeIntervalSince1970
        if expires <= 0 { return "" }
        if secs <= 0 { return tr("Expired") }
        let days = Int(secs / 86400)
        return days >= 1 ? tr("{count} days left", ["count": "\(days)"]) : tr("{count} hours left", ["count": "\(max(1, Int(secs / 3600)))"])
    }
}
