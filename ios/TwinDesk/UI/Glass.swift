// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Liquid Glass on iOS 26, frosted material before it: one set of modifiers for every page.
import SwiftUI

extension View {
    // A card: glass on iOS 26, thin material with a hairline before.
    @ViewBuilder
    func glassCard(_ radius: CGFloat = 26, tint: Color? = nil) -> some View {
        if #available(iOS 26.0, *) {
            self.padding(18)
                .glassEffect(tint.map { Glass.regular.tint($0.opacity(0.25)) } ?? .regular, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
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

// TwinDesk's colours: deep blacks (OLED black behind, near-black cards), the computers' accents.
enum TDColor {
    static let bg = Color.black
    static let content = Color(red: 0.02, green: 0.02, blue: 0.024) // #050506
    static let card = Color(red: 0.082, green: 0.082, blue: 0.09) // #151517
    static let control = Color(red: 0.16, green: 0.16, blue: 0.17) // #29292b
    static let line = Color.white.opacity(0.08)
    static let text = Color(red: 0.96, green: 0.96, blue: 0.97)
    static let muted = Color(red: 0.58, green: 0.58, blue: 0.6)
    static let accent = Color(red: 0.04, green: 0.52, blue: 1) // #0a84ff
    static let good = Color(red: 0.2, green: 0.84, blue: 0.29) // #32d74b
    static let warn = Color(red: 1, green: 0.7, blue: 0.25)
    static let bad = Color(red: 1, green: 0.27, blue: 0.23)
}

// The background every page sits on: black, with a faint neutral sheen at the top for the glass.
struct Backdrop: View {
    var body: some View {
        ZStack(alignment: .top) {
            TDColor.content
            LinearGradient(colors: [Color.white.opacity(0.045), .clear], startPoint: .top, endPoint: .bottom)
                .frame(height: 360)
        }
        .ignoresSafeArea()
    }
}

// TwinDesk's mark beside a title (top right).
struct AppMark: View {
    var size: CGFloat = 30
    var body: some View {
        Image("Mark").resizable().interpolation(.high).frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.23, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: size * 0.23, style: .continuous).strokeBorder(.white.opacity(0.12)))
            .accessibilityLabel("TwinDesk")
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
                        Capsule().fill(LinearGradient(colors: [TDColor.good, TDColor.accent], startPoint: .leading, endPoint: .trailing))
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
        .shadow(color: up ? TDColor.good.opacity(0.35) : .clear, radius: 4)
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
                HStack(spacing: 8) { trailing() }.controlSize(.small)
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
    var body: some View {
        ScrollView {
            GlassGroup { VStack(spacing: 16) { content() }.pageWidth().rise() }
        }
        .background(Backdrop())
        .navigationTitle(title)
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { AppMark(size: 28) } }
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
                Text(core.state == "connecting" ? "Connecting…" : "Not connected").font(.headline)
                Text("Connect to a computer to use \(what).").font(.caption).foregroundStyle(.secondary)
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

// Two columns side by side on a wide screen (iPad), one under the other on a narrow one.
struct Columns<Left: View, Right: View>: View {
    @Environment(\.horizontalSizeClass) private var width
    @ViewBuilder var left: () -> Left
    @ViewBuilder var right: () -> Right

    var body: some View {
        if width == .regular {
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
