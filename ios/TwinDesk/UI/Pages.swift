// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The feature pages: Receive screen (and its full-screen viewer), Share screen, Remote (and its
// full-screen pad), Notifications, Audio, Media, AirPlay & SMB, Shortcuts, About.
import SwiftUI
import AVKit
import UIKit

// ---- Receive screen ----

struct ReceiveScreenView: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI

    var body: some View {
        PageScroll(title: "Receive screen") {
            if !core.connected { NeedsComputer(what: "its screen") }
            Columns {
                VStack(alignment: .leading, spacing: 14) {
                    CardHeader(symbol: "display", color: Page.receive.color, title: "\(core.host?.name ?? "The computer")’s screen",
                               detail: statusLine)
                    Button { ui.cover = .viewer } label: { Label("Show It Here", systemImage: "play.rectangle.fill").frame(maxWidth: .infinity) }
                        .primaryButton().controlSize(.large).disabled(!core.connected)
                    Text("Mirror shows the computer’s screen. Extend uses this \(Device.word) as a second display, sized to fit. Switch modes from the bar at the top (tap the handle).")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()

                VStack(alignment: .leading, spacing: 12) {
                    Text("Touch").font(.headline)
                    Picker("Touch", selection: Binding(get: { core.screen.touchpad }, set: { core.screen.setOpt("screen.touchpad", $0) })) {
                        Text("Touch screen").tag(false)
                        Text("Touchpad").tag(true)
                    }
                    .pickerStyle(.segmented)
                    Text(core.screen.touchpad
                         ? "Slide to move the pointer, tap to click, touch and hold to right-click, and scroll with two fingers."
                         : "The pointer follows your finger: tap to click, drag to drag, touch and hold to right-click, and scroll with two fingers.")
                        .font(.caption).foregroundStyle(.secondary)
                    Divider()
                    ToggleRow(title: "Apple Pencil as a pen", detail: "Pressure, tilt and eraser, as a drawing tablet on the computer. When off, Apple Pencil acts as a mouse", on: opt("screen.pen", true))
                    Divider()
                    ToggleRow(title: "Fast writing", detail: "Lines reach the computer a little sooner but can lose points along the way. Leave off for smooth drawing and handwriting", on: opt("screen.penFast", false))
                    Divider()
                    ToggleRow(title: "Play the computer’s sound", detail: "Along with the screen", on: opt("screen.sound", true))
                    Divider()
                    ToggleRow(title: "Smooth", detail: "Smoother playback with about one frame of added delay", on: opt("screen.smooth", false))
                }
                .glassCard()
            } right: {
                VStack(alignment: .leading, spacing: 10) {
                    CardHeader(symbol: "keyboard", color: Color(white: 0.45), title: "Keyboard and mouse")
                    Text("A keyboard, mouse or trackpad connected to this \(Device.word) controls the computer while its screen is shown. The Keyboard button in the bar opens the on-screen keyboard.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard()
                VStack(alignment: .leading, spacing: 10) {
                    CardHeader(symbol: "cable.connector", color: TDColor.good, title: "Best over USB")
                    Text("When connected by USB, the screen is sent over the cable instead of Wi-Fi.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard()
            }
        }
    }

    private var statusLine: String {
        guard core.connected else { return "Not connected" }
        if core.screen.viewing { return "Showing on this \(Device.word)" }
        if core.screen.sharing { return "Sharing (\(core.screen.mode == "extend" ? "Extend" : "Mirror"))" }
        return core.screen.remote ? "Starts when opened" : "Start sharing on the computer"
    }

    private func opt(_ k: String, _ def: Bool) -> Binding<Bool> {
        Binding(get: { _ = core.tick; return core.store.flag(k, def) }, set: { core.screen.setOpt(k, $0) })
    }
}

// The computer's screen, full screen, with a small bar (tap the handle at the top).
struct ViewerScreen: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    @State private var host: WebHost?
    @State private var bar = true
    @State private var keyboard = false
    @State private var seenOn = false
    @State private var hide: DispatchWorkItem?

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            if let h = host { WebPageView(host: h).ignoresSafeArea() }
            KeyProxyView(on: $keyboard, screen: core.screen).frame(width: 1, height: 1).opacity(0.01)
            Capsule().fill(Color.white.opacity(0.35)).frame(width: 72, height: 6).padding(.top, 6)
                .padding(.horizontal, 30).padding(.bottom, 14).contentShape(Rectangle())
                .onTapGesture { bar.toggle(); autoHide() }
            if bar { barView.padding(.top, 26).transition(.opacity) }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .animation(.easeInOut(duration: 0.2), value: bar)
        .onAppear {
            let h = host ?? WebHost("viewer.html", core: core)
            host = h
            core.screen.attach(h)
            autoHide()
        }
        .onDisappear {
            if let h = host { core.screen.detach(h); h.destroy() }
            host = nil
        }
        .onChange(of: core.tick) { _ in
            if core.screen.sharing { seenOn = true }
            else if seenOn && core.screen.autoOpened && core.screen.state != nil { close() }
            if !core.connected { close() }
        }
    }

    private var barView: some View {
        let s = core.screen
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Text(core.host?.name ?? "Computer").font(.subheadline.weight(.semibold)).padding(.leading, 6)
                Text(core.link.wired ? "USB" : core.link.viaBle ? "Bluetooth" : "Wi-Fi").font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background((core.link.wired ? TDColor.good.opacity(0.35) : Color.white.opacity(0.18)), in: RoundedRectangle(cornerRadius: 6))
                if s.remote {
                    ForEach(["mirror", "extend"].filter { s.modes.contains($0) }, id: \.self) { m in
                        barButton(m == "mirror" ? "Mirror" : "Extend", selected: s.sharing && s.mode == m) { s.pick(m) }
                    }
                    if s.sharing { barButton("Stop") { s.control(share: false) } }
                }
                barButton(s.touchpad ? "Touchpad" : "Touch", icon: s.touchpad ? "rectangle.and.hand.point.up.left" : "hand.point.up") {
                    s.setOpt("screen.touchpad", !s.touchpad)
                }
                barButton("Keyboard", icon: "keyboard", selected: keyboard) { keyboard.toggle() }
                barButton("Close", icon: "xmark") { s.end(); close() }
            }
            .padding(.horizontal, 6).padding(.vertical, 5)
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(.ultraThinMaterial, in: Capsule())
        .environment(\.colorScheme, .dark)
        .padding(.horizontal, 12)
        .frame(maxWidth: 720)
    }

    private func barButton(_ title: String, icon: String? = nil, selected: Bool = false, _ run: @escaping () -> Void) -> some View {
        Button { run(); autoHide() } label: {
            Group {
                if let i = icon { Label(title, systemImage: i) } else { Text(title) }
            }
            .font(.subheadline)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(selected ? TDColor.accent.opacity(0.6) : Color.clear, in: Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
    }

    private func autoHide() {
        hide?.cancel()
        let w = DispatchWorkItem { bar = false }
        hide = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: w)
    }

    private func close() { if ui.cover == .viewer { ui.cover = nil } }
}

// The on-screen keyboard for the viewer (KeyProxy takes what's typed).
struct KeyProxyView: UIViewRepresentable {
    @Binding var on: Bool
    let screen: Screen

    func makeUIView(context: Context) -> KeyProxy {
        let v = KeyProxy()
        let s = screen
        v.onText = { [weak s] t in s?.typeText(t) }
        v.onKey = { [weak s] c, down in s?.key(c, down) }
        return v
    }

    func updateUIView(_ v: KeyProxy, context: Context) {
        DispatchQueue.main.async {
            if on && !v.isFirstResponder { v.becomeFirstResponder() }
            else if !on && v.isFirstResponder { v.resignFirstResponder() }
        }
    }
}

// ---- Share screen ----

struct ShareScreenView: View {
    @EnvironmentObject var core: Core

    var body: some View {
        PageScroll(title: "Share screen") {
            if !core.connected { NeedsComputer(what: "Share Screen") }
            Columns {
                ShareScreenCard()
                VStack(alignment: .leading, spacing: 10) {
                    Text("How it works").font(.headline)
                    Text("Like presenting in a video call: this \(Device.word)’s entire screen appears in a window on \(core.host?.name ?? "the computer") until you stop sharing (the red indicator at the top, or Control Center).")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text("iOS asks each time. Select TwinDesk, then tap Start Broadcast.").font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard()
            } right: {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "airplayvideo", color: Page.airplay.color, title: "Or Screen Mirroring", detail: "Using AirPlay from Control Center")
                    Text("If Share Screen doesn’t start, use AirPlay instead. Show screen on \(core.host?.name ?? "the computer") turns on its AirPlay receiver. Then:")
                        .font(.caption).foregroundStyle(.secondary)
                    MirrorGuide(target: core.mirror.airplayName)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard()
                if core.connected && core.host?.os == "mac" { // only a Mac takes the screen over the cable
                    VStack(alignment: .leading, spacing: 10) {
                        CardHeader(symbol: "cable.connector", color: TDColor.good, title: "Over USB with a Mac", detail: "Starts automatically")
                        Text("When connected to a Mac by USB, the \(Device.word) window on the Mac shows this screen at 60 frames per second without Share Screen. Tap Trust when this \(Device.word) asks.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard()
                }
            }
        }
    }
}

// ---- Remote ----

struct RemoteView: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI

    var body: some View {
        PageScroll(title: "Remote") {
            if !core.connected { NeedsComputer(what: "the Remote") }
            Columns {
                VStack(alignment: .leading, spacing: 14) {
                    CardHeader(symbol: "hand.point.up.left.fill", color: Page.remote.color, title: "Touchpad and keyboard",
                               detail: "Control the pointer, click, scroll and type on \(core.host?.name ?? "the computer")")
                    Button { ui.cover = .remote("pad") } label: { Label("Open Touchpad", systemImage: "rectangle.and.hand.point.up.left.fill").frame(maxWidth: .infinity) }
                        .primaryButton().controlSize(.large).disabled(!core.connected)
                }
                .glassCard()
                VStack(alignment: .leading, spacing: 14) {
                    CardHeader(symbol: "gamecontroller.fill", color: Page.remote.color, title: "Gamepad",
                               detail: "Sticks and buttons mapped to the computer’s keys, or a virtual controller on Windows and Linux (Remote › Real gamepad)")
                    Button { ui.cover = .remote("gamepad") } label: { Label("Open Gamepad", systemImage: "gamecontroller").frame(maxWidth: .infinity) }
                        .primaryButton().controlSize(.large).disabled(!core.connected)
                    Text("To customize the layout, use Edit in the gamepad to move, resize, hide or add controls, and Keys to assign what each one presses.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()
                VStack(alignment: .leading, spacing: 14) {
                    CardHeader(symbol: "mic.fill", color: Color(red: 1, green: 0.27, blue: 0.4), title: "Voice typing",
                               detail: "Speak with Dictation (the keyboard’s microphone): each word is typed on \(core.host?.name ?? "the computer") as it appears, and fixes are typed there too")
                    Button { ui.cover = .remote("voice") } label: { Label("Open Voice typing", systemImage: "mic").frame(maxWidth: .infinity) }
                        .primaryButton().controlSize(.large).disabled(!core.connected)
                }
                .glassCard()
                if let a = core.remote.allowed, !a, !core.remote.why.isEmpty {
                    Label(core.remote.why, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(TDColor.warn).glassCard()
                }
            } right: {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Touchpad").font(.headline)
                    HStack {
                        Text("Speed")
                        Slider(value: Binding(get: { core.remote.speed }, set: { core.remote.setSpeed($0) }), in: 0.3...3)
                    }
                    Divider()
                    ToggleRow(title: "Tap to click", detail: "A quick tap performs a left click", on: Binding(get: { _ = core.tick; return core.remote.tapClick }, set: { core.remote.setTapClick($0) }))
                    Divider()
                    ToggleRow(title: "Smooth pointer", detail: "Smoother pointer movement with about one frame of added delay", on: Binding(get: { _ = core.tick; return core.remote.smooth }, set: { core.remote.setSmooth($0) }))
                }
                .glassCard()
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "gamecontroller", color: Color(red: 0.2, green: 0.7, blue: 0.4), title: "Game controller",
                               detail: core.remote.controllerName.map { "\($0) connected" } ?? "Pair a controller in Settings › Bluetooth")
                    ToggleRow(title: "Use on the computer", detail: "An Xbox, PlayStation or MFi controller connected to this \(Device.word) works on the computer, as a controller when Real gamepad is on there, otherwise as the gamepad’s keys",
                              on: Binding(get: { _ = core.tick; return core.remote.controllerOn }, set: { core.remote.setControllerOn($0) }))
                }
                .glassCard()
            }
        }
    }
}

// The Remote page itself, full screen.
struct RemoteScreen: View {
    @EnvironmentObject var core: Core
    @EnvironmentObject var ui: AppUI
    let mode: String
    @State private var host: WebHost?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            // Voice typing keeps inside the safe area and above the keyboard (its box and keys in
            // sight while Dictation listens); the touchpad and gamepad take the whole screen.
            if let h = host {
                if mode == "voice" { WebPageView(host: h) } else { WebPageView(host: h).ignoresSafeArea() }
            }
        }
        .statusBarHidden(mode != "voice")
        .persistentSystemOverlays(mode == "voice" ? .automatic : .hidden)
        .onAppear {
            let h = host ?? WebHost("remote.html", core: core)
            host = h
            h.onEvent = { ev, _ in
                switch ev {
                case "close": ui.cover = nil
                case "rotate": Orientation.toggle()
                case "padReset": core.remote.resetPad()
                default: break
                }
            }
            core.remote.attach(h, mode: mode)
            if mode == "gamepad" { Orientation.landscape() }
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            if let h = host { core.remote.detach(h); h.destroy() }
            host = nil
            Orientation.free()
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }
}

// The window held sideways (the gamepad, the touchpad's Rotate) and back.
enum Orientation {
    private static var scene: UIWindowScene? { UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first }

    static func landscape() { request(.landscape) }
    static func free() { request(Device.isPad ? .all : .allButUpsideDown) }
    static func toggle() {
        let land = scene?.interfaceOrientation.isLandscape == true
        request(land ? .portrait : .landscape)
    }

    private static func request(_ mask: UIInterfaceOrientationMask) {
        guard let s = scene else { return }
        if #available(iOS 16.0, *) {
            s.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
            s.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }
    }
}

// ---- Notifications ----

struct NotificationsView: View {
    @EnvironmentObject var core: Core

    var body: some View {
        PageScroll(title: "Notifications") {
            Columns {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "bell.badge.fill", color: Page.notifications.color, title: "The computer’s notifications",
                               detail: core.notifs.shown > 0 ? "\(core.notifs.shown) shown this session" : nil)
                    ToggleRow(title: "Show notifications", detail: "Messages, mail and reminders from \(core.host?.name ?? "the computer"), while connected",
                              on: Binding(get: { _ = core.tick; return core.sync.get("notifs", "in") }, set: { core.sync.set("notifs", "in", $0) }))
                    Button("Notification Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
                        .secondaryButton()
                }
                .glassCard()
            } right: {
                VStack(alignment: .leading, spacing: 10) {
                    CardHeader(symbol: "iphone", color: Color(white: 0.45), title: "This \(Device.word)’s notifications")
                    Text("iOS lets no app read other apps’ notifications, so they can’t go to the computer from TwinDesk.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard()
            }
        }
    }
}

// ---- Audio ----

struct AudioView: View {
    @EnvironmentObject var core: Core

    var body: some View {
        PageScroll(title: "Audio") {
            Columns {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "speaker.wave.2.fill", color: Page.audio.color, title: "The computer’s sound here",
                               detail: core.sound.playing ? "Playing" : nil)
                    ToggleRow(title: "Play \(core.host?.name ?? "the computer")’s sound on this \(Device.word)", detail: "Turns on Send this computer’s sound on the computer too",
                              on: Binding(get: { _ = core.tick; return core.sound.on }, set: { core.sound.set($0) }))
                }
                .glassCard()
            } right: {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "airplayaudio", color: Page.airplay.color, title: "This \(Device.word)’s sound on the computer",
                               detail: "Via AirPlay: TwinDesk on the computer acts as an AirPlay receiver")
                    HStack {
                        RoutePicker().frame(width: 44, height: 44)
                        Text("Select \(core.host?.name ?? "the computer") here, in Control Center or from any app’s AirPlay button.").font(.caption).foregroundStyle(.secondary)
                    }
                    Text("While Share Screen is on, app audio is included with the screen.").font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "mic.fill", color: Page.audio.color, title: "Microphone",
                               detail: core.mic.running ? "Live on \(core.host?.name ?? "the computer")" : nil)
                    ToggleRow(title: "Use this \(Device.word)’s microphone on \(core.host?.name ?? "the computer")",
                              detail: micDetail,
                              on: Binding(get: { _ = core.tick; return core.sync.get("mic", "out") }, set: { core.sync.set("mic", "out", $0) }))
                        .disabled(!core.connected)
                }
                .glassCard()
            }
        }
    }
}

extension AudioView {
    private var micDetail: String {
        if core.mic.running { return "Calls and recordings on \(core.host?.name ?? "the computer") hear this \(Device.word). TwinDesk keeps it on in the background (the orange dot)" }
        switch core.host?.os {
        case "linux": return "Apps there pick “TwinDesk Microphone”"
        default: return "Apps there pick it through a virtual audio cable (BlackHole on a Mac, VB-CABLE on Windows)"
        }
    }
}

// iOS's AirPlay button.
struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = .white
        v.activeTintColor = UIColor(TDColor.accent)
        v.prioritizesVideoDevices = false
        return v
    }
    func updateUIView(_ v: AVRoutePickerView, context: Context) {}
}

// ---- Media ----

struct MediaView: View {
    @EnvironmentObject var core: Core

    var body: some View {
        PageScroll(title: "Media") {
            if !core.connected { NeedsComputer(what: "its media") }
            Columns {
                VStack(spacing: 16) {
                    Artwork(image: core.media.art, size: core.media.art == nil ? 96 : 180)
                    VStack(spacing: 4) {
                        Text(core.media.now?.title ?? "Nothing playing").font(.title3.bold()).multilineTextAlignment(.center)
                        Text(subtitle).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    HStack(spacing: 44) {
                        Button { core.media.ctl("prev") } label: { Image(systemName: "backward.fill").font(.title) }
                        Button { core.media.ctl("toggle") } label: { Image(systemName: core.media.now?.playing == true ? "pause.fill" : "play.fill").font(.system(size: 44)) }
                        Button { core.media.ctl("next") } label: { Image(systemName: "forward.fill").font(.title) }
                    }
                    .buttonStyle(.plain)
                    .disabled(!core.connected)
                    if core.dev.can.contains(.volume) {
                        HStack(spacing: 10) {
                            Image(systemName: "speaker.fill").foregroundStyle(.secondary)
                            Slider(value: Binding(get: { core.dev.volume ?? 0.5 }, set: { core.dev.setVolume($0) }), in: 0...1)
                            Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .glassCard()
            } right: {
                VStack(alignment: .leading, spacing: 12) {
                    ToggleRow(title: "On the Lock Screen", detail: "Media playing on the computer, with controls in Control Center and on the Lock Screen. This \(Device.word)’s own audio pauses while it’s shown, as iOS shows one app at a time.",
                              on: Binding(get: { _ = core.tick; return core.media.lockScreen }, set: { core.media.setLockScreen($0) }))
                    Text("On a Mac: any app in its Now Playing, YouTube in a browser too. Windows: any app in its media controls. Linux: any MPRIS player.").font(.caption).foregroundStyle(.secondary)
                }
                .glassCard()
            }
        }
        .onAppear { core.media.page(true) }
        .onDisappear { core.media.page(false) }
    }

    private var subtitle: String {
        guard let n = core.media.now else { return "On \(core.host?.name ?? "the computer")" }
        return [n.artist, n.album, n.app].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

// ---- AirPlay & SMB ----

struct AirPlayView: View {
    @EnvironmentObject var core: Core
    @State private var copied = false

    var body: some View {
        PageScroll(title: "AirPlay & SMB") {
            Columns {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "airplayvideo", color: Page.airplay.color, title: "AirPlay to the computer",
                               detail: "TwinDesk on the computer acts as an AirPlay receiver. No extra app is required")
                    step(1, "Turn on AirPlay in TwinDesk’s AirPlay & SMB page on \(core.host?.name ?? "the computer").")
                    step(2, "To mirror this screen, open Control Center, tap Screen Mirroring and select \(core.host?.name ?? "the computer").")
                    step(3, "For a video or audio only, tap AirPlay in the app (Photos, Safari, Music, YouTube) and select the computer.")
                    HStack {
                        RoutePicker().frame(width: 44, height: 44)
                        Text("Audio only").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .glassCard()
            } right: {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "externaldrive.connected.to.line.below.fill", color: TDColor.accent, title: "The computer’s folder in Files",
                               detail: core.smb.offer != nil ? "Shared over SMB" : "Not shared")
                    if let o = core.smb.offer {
                        info("Server", core.smb.url?.absoluteString ?? "smb://\(o.address)/\(o.share)")
                        info("Name", o.user)
                        HStack {
                            info("Password", String(repeating: "•", count: min(12, o.password.count)))
                            Spacer()
                            Button(copied ? "Copied" : "Copy") { core.clip.write(o.password); copied = true }.secondaryButton().controlSize(.small)
                        }
                        Button { core.smb.connectInFiles() } label: { Label("Connect in Files", systemImage: "folder.badge.plus").frame(maxWidth: .infinity) }
                            .primaryButton()
                        Text("Files opens Connect to Server with the address filled in. Choose Connect, then Registered User, enter the name above and paste the password. The folder then appears under Shared in Files and in every app’s file picker.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Turn on Share a folder in the AirPlay & SMB page of TwinDesk on \(core.host?.name ?? "the computer"). Its address, user name and password then appear here.")
                            .font(.caption).foregroundStyle(.secondary)
                        Text("Other SMB shares can be added the same way: Files › ··· › Connect to Server.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .glassCard()
            }
        }
    }

    private func step(_ n: Int, _ t: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(n)").font(.caption.bold()).frame(width: 22, height: 22).background(Page.airplay.color.opacity(0.3), in: Circle())
            Text(t).font(.subheadline)
        }
    }

    private func info(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(k).font(.caption2).foregroundStyle(.secondary)
            Text(v).font(.subheadline.monospaced()).textSelection(.enabled)
        }
    }
}

// ---- Shortcuts ----

struct ShortcutsView: View {
    var body: some View {
        PageScroll(title: "Shortcuts") {
            Columns {
                VStack(alignment: .leading, spacing: 12) {
                    CardHeader(symbol: "square.stack.3d.up.fill", color: Page.shortcuts.color, title: "TwinDesk’s actions",
                               detail: "In the Shortcuts app, and for Siri, Back Tap and the Action button")
                    ForEach(Self.actions.indices, id: \.self) { i in
                        let a = Self.actions[i]
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: a.2).frame(width: 24).foregroundStyle(Page.shortcuts.color)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(a.0).font(.subheadline.weight(.semibold))
                                Text(a.1).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button("Open Shortcuts") { if let u = URL(string: "shortcuts://") { UIApplication.shared.open(u) } }.secondaryButton()
                }
                .glassCard()
            } right: {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Back Tap").font(.headline)
                    Text("Settings › Accessibility › Touch › Back Tap › Double Tap › Send Clipboard to Computer. Copy something, then double-tap the back of the \(Device.word) to send it.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Share sheet").font(.headline).padding(.top, 6)
                    Text("Send to Computer is available in the Share sheet of every app, for photos, files, links and text.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard()
            }
        }
    }

    static let actions: [(String, String, String)] = [
        ("Send Clipboard to Computer", "Copies this device’s clipboard to the computer", "doc.on.clipboard"),
        ("Send Files to Computer", "Sends photos or files to the computer’s Downloads folder", "square.and.arrow.up"),
        ("Save Files Copied on Computer", "Saves files copied on the computer (⌃⌥C) to Files › TwinDesk", "square.and.arrow.down"),
        ("Show Computer’s Screen", "Opens the computer’s screen in full screen", "display"),
        ("Play or Pause on Computer", "Toggles media playback on the computer", "playpause"),
        ("Lock Computer", "Locks the computer’s screen", "lock"),
        ("Connect to Computer", "Connects to the last computer", "link"),
    ]
}

// ---- About ----

struct AboutView: View {
    @EnvironmentObject var core: Core
    @Environment(\.openURL) private var openURL
    @State private var copied = false

    private static let portfolio = URL(string: "https://inukaasith.vercel.app")!
    private static let github = URL(string: "https://github.com/InukaAsith/TwinDesk")!
    private static let releases = URL(string: "https://github.com/InukaAsith/TwinDesk/releases")!
    private static let issues = URL(string: "https://github.com/InukaAsith/TwinDesk/issues")!
    private static let licence = URL(string: "https://github.com/InukaAsith/TwinDesk/blob/main/LICENSE")!

    private var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "" }
    private var build: String { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "" }

    var body: some View {
        PageScroll(title: "About") {
            Columns {
                hero
                DenseCard(title: "Made by") {
                    DenseRow(symbol: "person.crop.circle", title: "Inuka Asith", hint: "Designed and built TwinDesk · inukaasith.vercel.app", divider: false) {
                        Button("Portfolio") { openURL(Self.portfolio) }.secondaryButton()
                    }
                    DenseRow(symbol: "chevron.left.forwardslash.chevron.right", title: "Source code", hint: "github.com/InukaAsith/TwinDesk") {
                        Button("GitHub") { openURL(Self.github) }.secondaryButton()
                    }
                    DenseRow(symbol: "arrow.down.circle", title: "All releases", hint: "TwinDesk for macOS, Windows and Linux") {
                        Button("Releases") { openURL(Self.releases) }.secondaryButton()
                    }
                    DenseRow(symbol: "ladybug", title: "Report a problem", hint: "Issues on GitHub") {
                        Button("Report") { openURL(Self.issues) }.secondaryButton()
                    }
                }
            } right: {
                DenseCard(title: "This \(Device.word)") {
                    fact("iphone", "Name", UIDevice.current.name, first: true)
                    fact("cpu", "Model", Self.model)
                    fact("gearshape", "System", "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)")
                    DenseRow(symbol: "number", title: "TwinDesk ID", hint: String(core.store.deviceId.prefix(16))) {
                        Button(copied ? "Copied" : "Copy") { core.clip.write(core.store.deviceId); copied = true }.secondaryButton()
                    }
                }
                DenseCard(title: "This app") {
                    fact("app.badge", "Version", version, first: true)
                    fact("hammer", "Build", build)
                    if let h = core.host, core.connected { fact(osSymbol(h.os), "Connected to", "\(h.name) · \(osName(h.os))") }
                }
                DenseCard(title: "Licence") {
                    DenseRow(symbol: "doc.text", title: "GNU General Public License v3", hint: "Free and open source. Copyright © 2026 inukaasith", divider: false) {
                        Button("Read") { openURL(Self.licence) }.secondaryButton()
                    }
                    DenseRow(symbol: "heart", title: "Crafted with ☕ and ❤️ in Sri Lanka 🇱🇰") { EmptyView() }
                }
            }
        }
    }

    private var hero: some View {
        VStack(spacing: 10) {
            Image("Mark").resizable().frame(width: 104, height: 104).clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                .shadow(color: TDColor.accent.opacity(0.35), radius: 18, y: 6)
            Text("TwinDesk").font(.largeTitle.bold())
            Text("Version \(version) (\(build))").font(.subheadline).foregroundStyle(.secondary)
            Text("Use your \(Device.word) and computers together: clipboard, files, screens, remote control and audio.")
                .font(.subheadline).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Text("by Inuka Asith").font(.footnote.weight(.semibold)).foregroundStyle(TDColor.accent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .glassCard(tint: TDColor.accent)
    }

    private func fact(_ symbol: String, _ title: String, _ value: String, first: Bool = false) -> some View {
        DenseRow(symbol: symbol, title: title, divider: !first) {
            Text(value).font(.subheadline).foregroundStyle(.secondary).lineLimit(1).textSelection(.enabled)
        }
    }

    private func osName(_ os: String) -> String { os == "mac" ? "macOS" : os == "linux" ? "Linux" : "Windows" }

    // The hardware's own name (iPad14,3), as Settings › General › About lists it.
    private static let model: String = {
        var u = utsname()
        uname(&u)
        let id = withUnsafeBytes(of: &u.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
        return "\(UIDevice.current.model) · \(id)"
    }()
}
