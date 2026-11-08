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

// TwinDesk's colours (the computers' dark appearance, mac/control.css).
enum TDColor {
    static let bg = Color(red: 0.105, green: 0.105, blue: 0.11) // #1b1b1c
    static let content = Color(red: 0.118, green: 0.118, blue: 0.122) // #1e1e1f
    static let card = Color(red: 0.165, green: 0.165, blue: 0.173) // #2a2a2c
    static let control = Color(red: 0.227, green: 0.227, blue: 0.235) // #3a3a3c
    static let line = Color.white.opacity(0.07)
    static let text = Color(red: 0.96, green: 0.96, blue: 0.97)
    static let muted = Color(red: 0.6, green: 0.6, blue: 0.62)
    static let accent = Color(red: 0.04, green: 0.52, blue: 1) // #0a84ff
    static let good = Color(red: 0.2, green: 0.84, blue: 0.29) // #32d74b
    static let warn = Color(red: 1, green: 0.7, blue: 0.25)
    static let bad = Color(red: 1, green: 0.27, blue: 0.23)
}

// The background every page sits on: the computers' dark content colour, with a faint glow at the
// top for the glass to catch.
struct Backdrop: View {
    var body: some View {
        ZStack(alignment: .top) {
            TDColor.content
            RadialGradient(colors: [TDColor.accent.opacity(0.16), .clear], center: .top, startRadius: 0, endRadius: 520)
                .frame(height: 520)
        }
        .ignoresSafeArea()
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
            GlassGroup { VStack(spacing: 16) { content() }.pageWidth() }
        }
        .background(Backdrop())
        .navigationTitle(title)
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
