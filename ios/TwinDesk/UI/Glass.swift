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
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(.white.opacity(0.12)))
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

// The soft background every page sits on: glass needs something behind it.
struct Backdrop: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.05, green: 0.18, blue: 0.42), Color(red: 0.24, green: 0.10, blue: 0.45)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Circle().fill(Color.cyan.opacity(0.35)).frame(width: 340).blur(radius: 90).offset(x: -140, y: -260)
            Circle().fill(Color.pink.opacity(0.25)).frame(width: 300).blur(radius: 100).offset(x: 150, y: 260)
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
