// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Liquid Glass on iOS 26, frosted material before it: one set of modifiers for every page.
import SwiftUI
import UIKit

extension View {
    // A card: glass on iOS 26, thin material with a hairline before.
    @ViewBuilder
    func glassCard(_ radius: CGFloat = 26, tint: Color? = nil) -> some View {
        if #available(iOS 26.0, *) {
            self.padding(18)
                .glassEffect(tint.map { Glass.regular.tint($0.opacity(0.14)) } ?? .regular, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        } else {
            self.padding(18)
                .background {
                    let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
                    ZStack { shape.fill(TDColor.card); shape.fill(tint?.opacity(0.14) ?? .clear) }
                }
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(TDColor.line))
        }
    }

    // A primary action: glassProminent on iOS 26, a filled capsule before.
    @ViewBuilder
    func primaryButton() -> some View {
        if #available(iOS 26.0, *) { self.buttonStyle(.glassProminent) }
        else { self.buttonStyle(.borderedProminent).buttonBorderShape(.capsule) }
    }

    @ViewBuilder
    func secondaryButton() -> some View {
        if #available(iOS 26.0, *) { self.buttonStyle(.glass) }
        else { self.buttonStyle(.bordered).buttonBorderShape(.capsule) }
    }

    // A round icon chip (device glyphs).
    @ViewBuilder
    func glassChip(_ size: CGFloat = 52, tint: Color = .accentColor) -> some View {
        if #available(iOS 26.0, *) {
            self.frame(width: size, height: size).glassEffect(.regular.tint(tint.opacity(0.35)), in: Circle())
        } else {
            self.frame(width: size, height: size).background(tint.opacity(0.22), in: Circle())
        }
    }
}

// A group of glass shapes that melt into each other on iOS 26.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 14
    @ViewBuilder var content: () -> Content
    var body: some View {
        if #available(iOS 26.0, *) { GlassEffectContainer(spacing: spacing) { content() } }
        else { content() }
    }
}

// TwinDesk's colours, light and dark as the computers have them: deep blacks (OLED black behind,
// near-black cards) in dark; the computers' light grey with white cards in light. The accents stay.
enum TDColor {
    private static func dyn(_ light: UIColor, _ dark: UIColor) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
    private static func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> UIColor { UIColor(red: r, green: g, blue: b, alpha: a) }

    static let bg = dyn(rgb(0.95, 0.95, 0.97), .black)
    static let content = dyn(rgb(0.949, 0.949, 0.969), rgb(0.02, 0.02, 0.024)) // #f2f2f7 / #050506
    // Translucent, so the backdrop's glows show through (the glass on iOS 26 does it itself).
    static let card = dyn(UIColor.white.withAlphaComponent(0.78), UIColor.white.withAlphaComponent(0.065))
    static let control = dyn(rgb(0.9, 0.9, 0.92), rgb(0.16, 0.16, 0.17)) // #e5e5ea / #29292b
    static let line = dyn(UIColor.black.withAlphaComponent(0.08), UIColor.white.withAlphaComponent(0.08))
    static let text = dyn(rgb(0.07, 0.07, 0.08), rgb(0.96, 0.96, 0.97))
    static let muted = dyn(rgb(0.42, 0.42, 0.45), rgb(0.58, 0.58, 0.6))
    static let sheen = dyn(UIColor.white.withAlphaComponent(0.6), UIColor.white.withAlphaComponent(0.045))
    // The accent colour (General › Appearance, the computers' swatches; "" = System: iOS has no
    // accent of its own to follow, so the computers' blue). RootView redraws when it changes.
    static var accent: Color { Color(uiAccent) }
    static var uiAccent: UIColor { Accent.color(UserDefaults.standard.string(forKey: Accent.key) ?? "") }
    static let good = Color(red: 0.2, green: 0.84, blue: 0.29) // #32d74b
    static let warn = Color(red: 1, green: 0.7, blue: 0.25)
    static let bad = Color(red: 1, green: 0.27, blue: 0.23)
}

// The computers' accent swatches (shared/look.js ACCENTS), any #rrggbb.
enum Accent {
    static let key = "accent"
    static let fallback = "#0a84ff"
    static let swatches = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff453a", "#ff9f0a", "#30d158", "#00c7be", "#8e8e93"]

    static func color(_ hex: String) -> UIColor {
        let h = hex.lowercased()
        let v = (h.count == 7 && h.hasPrefix("#")) ? UInt32(h.dropFirst(), radix: 16) : nil
        guard let n = v ?? UInt32(fallback.dropFirst(), radix: 16) else { return .systemBlue }
        return UIColor(red: CGFloat(n >> 16 & 255) / 255, green: CGFloat(n >> 8 & 255) / 255, blue: CGFloat(n & 255) / 255, alpha: 1)
    }

    // The accent turned round the colour wheel (the backdrop's other glows), as saturated as it is.
    static func shifted(_ turn: CGFloat, brightness: CGFloat = 1) -> Color {
        var hue: CGFloat = 0, sat: CGFloat = 0, bri: CGFloat = 0, a: CGFloat = 0
        TDColor.uiAccent.getHue(&hue, saturation: &sat, brightness: &bri, alpha: &a)
        let h2 = (hue + turn).truncatingRemainder(dividingBy: 1)
        return Color(UIColor(hue: h2 < 0 ? h2 + 1 : h2, saturation: sat, brightness: min(1, bri * brightness), alpha: 1))
    }
}

// General › Appearance's accent: System first (half of it lighter), then the swatches.
struct AccentPicker: View {
    @AppStorage(Accent.key) private var accent = ""
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 34), spacing: 10)], spacing: 10) {
            swatch("", Color(Accent.color(Accent.fallback)), label: tr("System"))
            ForEach(Accent.swatches, id: \.self) { h in swatch(h, Color(Accent.color(h)), label: h) }
        }
    }

    private func swatch(_ value: String, _ c: Color, label: String) -> some View {
        let on = accent == value
        return Button {
            withAnimation(.easeInOut(duration: 0.25)) { accent = value }
        } label: {
            ZStack {
                if value.isEmpty {
                    Circle().fill(AngularGradient(colors: [c, c, c.opacity(0.45), c.opacity(0.45)], center: .center))
                } else {
                    Circle().fill(c)
                }
            }
            .frame(width: 30, height: 30)
            .padding(3)
            .overlay(Circle().strokeBorder(on ? c : .clear, lineWidth: 2))
            .scaleEffect(on ? 1.06 : 1)
        }
        .buttonStyle(PressScale())
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

// Light, dark or as the system is (General › Appearance).
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String { switch self { case .system: return tr("Automatic"); case .light: return tr("Light"); case .dark: return tr("Dark") } }
    var scheme: ColorScheme? { switch self { case .system: return nil; case .light: return .light; case .dark: return .dark } }
}

// The background every page sits on: not flat black but a deep night with soft glows under the
// glass (violet from the top left, teal from the right, a warm ember low on the right), as the
// computers' windows have; in light, the same glows as pale washes. Still, so it costs nothing.
struct Backdrop: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage(Accent.key) private var accent = "" // redraws when it changes
    var body: some View {
        let dark = scheme == .dark
        ZStack {
            (dark ? Color(red: 0.035, green: 0.035, blue: 0.055) : TDColor.content)
            // The accent's glow from the top left; the colours beside it on the wheel to the right
            // and low down (a blue accent: violet, teal and ember, as the computers have it).
            RadialGradient(colors: [Accent.shifted(0.15, brightness: 0.85).opacity(dark ? 0.30 : 0.16), .clear],
                           center: UnitPoint(x: 0.2, y: -0.05), startRadius: 0, endRadius: 620)
            RadialGradient(colors: [Accent.shifted(-0.12, brightness: 0.7).opacity(dark ? 0.20 : 0.12), .clear],
                           center: UnitPoint(x: 1.05, y: 0.35), startRadius: 0, endRadius: 560)
            RadialGradient(colors: [Accent.shifted(0.45, brightness: 0.75).opacity(dark ? 0.16 : 0.08), .clear],
                           center: UnitPoint(x: 0.85, y: 1.05), startRadius: 0, endRadius: 520)
            RadialGradient(colors: [Accent.shifted(0.25, brightness: 0.65).opacity(dark ? 0.12 : 0.06), .clear],
                           center: UnitPoint(x: -0.1, y: 0.9), startRadius: 0, endRadius: 460)
            LinearGradient(colors: [TDColor.sheen, .clear], startPoint: .top, endPoint: .center)
        }
        .ignoresSafeArea()
    }
}

// TwinDesk's mark, as the computers' sidebar shows it: the icon in the page itself (no frame, no
// button around it), with a soft shadow so it sits on the glass.
struct AppMark: View {
    var size: CGFloat = 30
    var body: some View {
        Image("Mark").resizable().interpolation(.high).frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
            .shadow(color: .black.opacity(0.25), radius: size * 0.12, y: size * 0.05)
            .accessibilityLabel("TwinDesk")
    }
}

// The top of the sidebar, as the computers' is: the mark, TwinDesk, and how it's connected.
struct BrandHeader: View {
    @EnvironmentObject var core: Core
    var compact = false // in a bar (iPad's sidebar): smaller, the bar's height
    var body: some View {
        HStack(spacing: compact ? 10 : 14) {
            AppMark(size: compact ? 34 : 58)
            VStack(alignment: .leading, spacing: compact ? 1 : 3) {
                Text("TwinDesk").font(compact ? .headline : .title2.weight(.bold)).foregroundStyle(TDColor.text)
                HStack(spacing: 6) {
                    if core.connected { LiveDot(size: compact ? 7 : 8) }
                    else { Circle().fill(core.state == "connecting" ? TDColor.warn : TDColor.muted.opacity(0.6)).frame(width: compact ? 7 : 8, height: compact ? 7 : 8) }
                    Text(line).font(compact ? .caption : .subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            if !compact { Spacer(minLength: 0) }
        }
        .padding(.vertical, compact ? 0 : 6)
        // In the bar its full width: a toolbar item is offered less than it needs, and the name and
        // state were cut to a faded "T" (iPad's sidebar).
        .fixedSize(horizontal: compact, vertical: false)
        .accessibilityElement(children: .combine)
    }
    private var line: String {
        switch core.state {
        case "connected": return tr("Connected")
        case "connecting": return tr("Connecting…")
        default: return tr("Not connected")
        }
    }
}

// The computers' page animation: content rises into place (mac/control.css `rise`).
private struct Rise: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var still
    let delay: Double
    @State private var shown = false
    func body(content: Content) -> some View {
        content
            .opacity(shown || still ? 1 : 0)
            .offset(y: shown || still ? 0 : 8)
            .onAppear { withAnimation(.easeOut(duration: 0.42).delay(delay)) { shown = true } }
    }
}

extension View {
    func rise(_ delay: Double = 0) -> some View { modifier(Rise(delay: delay)) }
}

// A green dot that breathes while something is live (mac/control.css `.dot.good`).
struct LiveDot: View {
    var color: Color = TDColor.good
    var size: CGFloat = 8
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var out = false
    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
            .background(Circle().stroke(color.opacity(out ? 0 : 0.45), lineWidth: out ? 6 : 0).frame(width: size, height: size))
            .onAppear { if !still { withAnimation(.easeInOut(duration: 2.8).repeatForever(autoreverses: false)) { out = true } } }
    }
}

// The line between the two devices (mac/control-pages.css `.hero-link`): dashes marching while
// not connected; green to blue with a light travelling along it when connected.
struct LinkLine: View {
    let up: Bool
    @Environment(\.accessibilityReduceMotion) private var still
    var body: some View {
        GeometryReader { g in
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: still)) { t in
                let now = t.date.timeIntervalSinceReferenceDate
                ZStack(alignment: .leading) {
                    if up {
                        Capsule().fill(LinearGradient(colors: [TDColor.accent.opacity(0.55), TDColor.accent], startPoint: .leading, endPoint: .trailing))
                        let p = CGFloat(now.truncatingRemainder(dividingBy: 2.2) / 2.2)
                        LinearGradient(colors: [.clear, .white.opacity(0.9), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: 40).offset(x: -40 + p * (g.size.width + 40))
                    } else {
                        let p = CGFloat(now.truncatingRemainder(dividingBy: 1.6) / 1.6)
                        Path { path in path.move(to: CGPoint(x: 0, y: 1.5)); path.addLine(to: CGPoint(x: g.size.width, y: 1.5)) }
                            .stroke(TDColor.muted.opacity(0.55), style: StrokeStyle(lineWidth: 3, dash: [6, 6], dashPhase: -p * 24))
                    }
                }
                .clipShape(Capsule())
            }
        }
        .frame(height: 3)
        .shadow(color: up ? TDColor.accent.opacity(0.4) : .clear, radius: 4)
    }
}

// A small label in a capsule (Connected, Paired, Online).
struct Pill: View {
    let text: String
    var color: Color = TDColor.good
    var body: some View {
        Text(text).font(.caption2.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.16), in: Capsule())
    }
}

// A card as the computers draw theirs: an optional title row with actions, then dense rows.
struct DenseCard<Content: View, Actions: View>: View {
    var title: String = ""
    @ViewBuilder var actions: () -> Actions
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !title.isEmpty {
                HStack {
                    Text(title).font(.headline)
                    Spacer()
                    actions()
                }
                .padding(.bottom, 6)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(22)
    }
}

extension DenseCard where Actions == EmptyView {
    init(title: String = "", @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.actions = { EmptyView() }
        self.content = content
    }
}

// One row of a dense card: an icon, a name, a line under it, what's on the right.
struct DenseRow<Trailing: View>: View {
    var symbol: String? = nil
    let title: String
    var hint: String = ""
    var hintColor: Color = .secondary
    var divider = true
    @ViewBuilder var trailing: () -> Trailing
    var body: some View {
        VStack(spacing: 0) {
            if divider { Divider().overlay(TDColor.line) }
            HStack(spacing: 12) {
                if let s = symbol {
                    Image(systemName: s).font(.system(size: 17, weight: .medium)).foregroundStyle(TDColor.text.opacity(0.85))
                        .frame(width: 30)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if !hint.isEmpty { Text(hint).font(.caption).foregroundStyle(hintColor).lineLimit(2) }
                }
                Spacer(minLength: 8)
                // Buttons keep their size (two capsules beside a long hint were squeezed into circles);
                // the title and hint give way instead.
                HStack(spacing: 8) { trailing() }.controlSize(.small).lineLimit(1).fixedSize().layoutPriority(1)
            }
            .padding(.vertical, 9)
        }
    }
}

// Pressed: a little smaller, springing back (the computers' sidebar tiles).
struct PressScale: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

struct SectionTitle: View {
    let text: String
    var body: some View {
        Text(text).font(.footnote.weight(.semibold)).textCase(.uppercase).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6).padding(.top, 8)
    }
}

// A feature's icon as the computers' sidebar draws it: a white glyph on a rounded square of its colour.
struct FeatureIcon: View {
    let symbol: String
    let color: Color
    var size: CGFloat = 30
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(LinearGradient(colors: [color.opacity(0.95), color.opacity(0.75)], startPoint: .top, endPoint: .bottom),
                        in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous).strokeBorder(.white.opacity(0.12)))
    }
}

// A card's title row: the feature's icon, a title and an optional line under it.
struct CardHeader: View {
    let symbol: String
    let color: Color
    let title: String
    var detail: String? = nil
    var body: some View {
        HStack(spacing: 12) {
            FeatureIcon(symbol: symbol, color: color, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                if let d = detail { Text(d).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
        }
    }
}

// A page: its cards on the dark background, a large title, one or two columns.
struct PageScroll<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    @Environment(\.branded) private var branded
    var body: some View {
        GeometryReader { g in
            ScrollView {
                GlassGroup {
                    VStack(spacing: 16) {
                        // iPhone's Overview tab: TwinDesk's mark, name and state at the top (as Android's), no bar title.
                        if branded { BrandHeader().padding(.horizontal, 4).padding(.top, 4) }
                        content()
                    }.pageWidth().rise()
                }
            }
            .environment(\.pageWide, g.size.width >= twoColumnsAt)
        }
        .background(Backdrop())
        .navigationTitle(branded ? "" : title)
        .toolbar(branded ? .hidden : .automatic, for: .navigationBar)
    }
}

// Something that needs a computer connected: says so in place of the page's controls.
struct NeedsComputer: View {
    @EnvironmentObject var core: Core
    var what: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "bolt.horizontal.circle").font(.title2).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(core.state == "connecting" ? tr("Connecting…") : tr("Not connected")).font(.headline)
                Text(tr("Connect to a computer to use {what}.", ["what": what])).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .glassCard()
    }
}

func osSymbol(_ os: String) -> String {
    switch os {
    case "mac": return "laptopcomputer"
    case "linux": return "server.rack"
    default: return "desktopcomputer"
    }
}

struct ToggleRow: View {
    let title: String
    var detail: String? = nil
    @Binding var on: Bool
    var body: some View {
        Toggle(isOn: $on) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let d = detail { Text(d).font(.caption).foregroundStyle(.secondary) }
            }
        }
    }
}

// The page opens iPhone's Overview tab: TwinDesk's header on it in place of a bar.
private struct BrandedKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var branded: Bool {
        get { self[BrandedKey.self] }
        set { self[BrandedKey.self] = newValue }
    }
}

// Is the page wide enough for two columns (PageScroll measures it)?
private struct PageWideKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var pageWide: Bool {
        get { self[PageWideKey.self] }
        set { self[PageWideKey.self] = newValue }
    }
}

// Two columns side by side when the page is wide (an iPad sideways, or upright without the
// sidebar on a big one), one under the other otherwise: an upright iPad beside its sidebar gets
// one column, its cards at full width, as the computers' narrow windows do.
let twoColumnsAt: CGFloat = 900

struct Columns<Left: View, Right: View>: View {
    @Environment(\.pageWide) private var wide
    @ViewBuilder var left: () -> Left
    @ViewBuilder var right: () -> Right

    var body: some View {
        if wide {
            HStack(alignment: .top, spacing: 20) {
                VStack(spacing: 16) { left() }.frame(maxWidth: .infinity)
                VStack(spacing: 16) { right() }.frame(maxWidth: .infinity)
            }
        } else {
            VStack(spacing: 16) { left(); right() }
        }
    }
}

extension View {
    // A page's content: centred, at most 1100 pt wide (a 13-inch iPad in landscape), with the
    // gutters a wide screen wants.
    func pageWidth() -> some View { modifier(PageWidth()) }

    // The pointer's lift on iPad (a trackpad or mouse); nothing elsewhere.
    func hoverLift() -> some View { self.hoverEffect(.lift) }
}

private struct PageWidth: ViewModifier {
    @Environment(\.horizontalSizeClass) private var width
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: 1100)
            .padding(.horizontal, width == .regular ? 28 : 16)
            .padding(.top, width == .regular ? 8 : 0)
            .padding(.bottom, 30)
            .frame(maxWidth: .infinity)
    }
}
