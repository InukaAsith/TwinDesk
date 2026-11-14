// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer asked to see this screen (its Show screen; Core/Mirror.swift): Share Screen (the
// broadcast) or Screen Mirroring to the computer's AirPlay receiver, which it turned on. No app can
// open Control Center or start Screen Mirroring, so an animation shows where it is: the swipe down
// from the top right corner, the Screen Mirroring button, the computer in the list.
import SwiftUI
import UIKit

struct MirrorAskSheet: View {
    @EnvironmentObject var core: Core
    @Environment(\.dismiss) private var dismiss
    @State private var how = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image(systemName: "rectangle.on.rectangle")
                    .font(.system(size: 30, weight: .semibold)).glassChip(68, tint: .purple)
                    .padding(.top, 10)
                VStack(spacing: 6) {
                    Text(tr("{name} wants to see this screen", ["name": core.host?.name ?? tr("The computer")]))
                        .font(.title3.bold()).multilineTextAlignment(.center)
                    Text(tr("Share it with TwinDesk, or mirror it using AirPlay."))
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                VStack(spacing: 10) {
                    Button {
                        dismiss()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { ShareScreen.open() }
                    } label: {
                        Label(tr("Share Screen"), systemImage: "record.circle").frame(maxWidth: .infinity)
                    }
                    .primaryButton().controlSize(.large)
                    Button {
                        withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) { how = true }
                        core.mirror.useAirPlay()
                    } label: {
                        Label(tr("Screen Mirroring"), systemImage: "airplayvideo").frame(maxWidth: .infinity)
                    }
                    .secondaryButton().controlSize(.large)
                }
                if how && core.mirror.airplayOff {
                    // The Mac's own receiver is off: macOS's switch, opened there by TwinDesk.
                    Label(tr("Turn on AirPlay Receiver on {name}: System Settings › General › AirDrop & Handoff › AirPlay Receiver (macOS 12 or later). TwinDesk opened it there.", ["name": core.host?.name ?? tr("the Mac")]),
                          systemImage: "exclamationmark.circle")
                        .font(.footnote).foregroundStyle(TDColor.warn).multilineTextAlignment(.leading)
                }
                if how {
                    MirrorGuide(target: core.mirror.airplayName)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    Button(tr("Done")) { dismiss() }.secondaryButton()
                } else {
                    Button(tr("Not Now"), role: .cancel) { core.mirror.decline(); dismiss() }
                        .foregroundStyle(.secondary)
                }
            }
            .padding(24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .background(Backdrop())
        .onDisappear { if core.mirror.asking { core.mirror.decline() } }
    }
}

// Where Screen Mirroring is, playing on a loop: 1 swipe down from the top right corner, 2 the
// Screen Mirroring button in Control Center, 3 the computer in the list.
struct MirrorGuide: View {
    let target: String
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var step = 0
    @State private var finger: CGFloat = 0 // 0 at the top, 1 down (the swipe)
    @State private var pulse = false

    private let steps = [tr("Swipe down from the top right corner"), tr("Tap Screen Mirroring"), ""]

    var body: some View {
        VStack(spacing: 16) {
            device
                .frame(width: 210, height: Device.isPad ? 280 : 340)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(0..<3) { i in
                    HStack(spacing: 10) {
                        Text("\(i + 1)").font(.caption.bold()).foregroundStyle(.white)
                            .frame(width: 22, height: 22)
                            .background(step == i ? TDColor.accent : TDColor.muted.opacity(0.5), in: Circle())
                        Text(i == 2 ? tr("Select {target}", ["target": target]) : steps[i])
                            .font(.subheadline.weight(step == i ? .semibold : .regular))
                            .foregroundStyle(step == i ? TDColor.text : .secondary)
                    }
                    .animation(.easeInOut(duration: 0.25), value: step)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(Device.isPad || hasNotch ? tr("Control Center opens from the top right corner.") : tr("On an iPhone with a Home button, swipe up from the bottom edge instead."))
                .font(.caption).foregroundStyle(.secondary)
        }
        .glassCard()
        .task { await loop() }
    }

    private var hasNotch: Bool {
        (UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.safeAreaInsets.bottom ?? 0) > 0
    }

    // The device, its screen showing what each step shows.
    private var device: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 30, style: .continuous).fill(Color(white: 0.08))
                RoundedRectangle(cornerRadius: 30, style: .continuous).strokeBorder(Color(white: 0.35), lineWidth: 3)
                // The home screen behind: a few app squares.
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(28), spacing: 14), count: 4), spacing: 14) {
                    ForEach(0..<16) { i in
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .fill([Color.blue, .green, .orange, .pink, .purple, .teal, .yellow, .red][i % 8].opacity(0.55))
                            .frame(width: 28, height: 28)
                    }
                }
                .padding(.top, 44).frame(width: w)
                .blur(radius: step >= 1 ? 6 : 0)

                if step >= 1 { controlCenter(w, h).transition(.opacity.combined(with: .move(edge: .top))) }
                if step == 2 { list(w, h).transition(.scale(scale: 0.9).combined(with: .opacity)) }

                // The finger: the swipe in step 1, a tap on the button in step 2, on the computer in 3.
                Image(systemName: "hand.point.up.left.fill")
                    .font(.system(size: 30)).foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.5), radius: 4)
                    .position(fingerAt(w, h))
                    .opacity(step == 0 && finger == 0 ? 0.6 : 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
        }
        .accessibilityLabel(tr("Open Control Center, tap Screen Mirroring, select {target}", ["target": target]))
    }

    private func fingerAt(_ w: CGFloat, _ h: CGFloat) -> CGPoint {
        switch step {
        case 0: return CGPoint(x: w - 34, y: 22 + finger * h * 0.42)
        case 1: return CGPoint(x: 62, y: 128)
        default: return CGPoint(x: w * 0.62, y: h * 0.52)
        }
    }

    private func controlCenter(_ w: CGFloat, _ h: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                tile("wifi", .blue)
                tile("antenna.radiowaves.left.and.right", .green)
            }
            HStack(spacing: 10) {
                // Screen Mirroring, as Control Center draws it: two screens.
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.18))
                    Image(systemName: "rectangle.on.rectangle").font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                }
                .frame(width: 56, height: 56)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(TDColor.accent, lineWidth: 3)
                        .scaleEffect(pulse ? 1.18 : 1)
                        .opacity(step == 1 ? (pulse ? 0 : 1) : 0)
                )
                tile("lock.rotation", .white)
            }
        }
        .padding(.top, 40).padding(.leading, 26)
        .frame(width: w, height: h, alignment: .topLeading)
        .background(Color.black.opacity(0.45))
    }

    private func tile(_ s: String, _ c: Color) -> some View {
        Image(systemName: s).font(.system(size: 18, weight: .semibold)).foregroundStyle(c == .white ? .white : c)
            .frame(width: 56, height: 56)
            .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func list(_ w: CGFloat, _ h: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("Screen Mirroring")).font(.caption.bold()).foregroundStyle(.white)
            HStack(spacing: 8) {
                Image(systemName: "laptopcomputer").font(.caption).foregroundStyle(.white)
                Text(target).font(.caption.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(8)
            .background(TDColor.accent.opacity(pulse ? 0.7 : 0.4), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            HStack(spacing: 8) {
                Image(systemName: "appletv").font(.caption).foregroundStyle(.white.opacity(0.5))
                Text(tr("Living Room")).font(.caption).foregroundStyle(.white.opacity(0.5))
            }
            .padding(.horizontal, 8)
        }
        .padding(14)
        .frame(width: w - 36)
        .background(Color(white: 0.16), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .position(x: w / 2, y: h * 0.5)
    }

    private func loop() async {
        if still { step = 2; return }
        while !Task.isCancelled {
            step = 0; finger = 0; pulse = false
            try? await Task.sleep(nanoseconds: 500_000_000)
            withAnimation(.easeInOut(duration: 0.9)) { finger = 1 }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            withAnimation(.spring(response: 0.45, dampingFraction: 0.8)) { step = 1 }
            withAnimation(.easeOut(duration: 1).repeatCount(2, autoreverses: false)) { pulse = true }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            pulse = false
            withAnimation(.spring(response: 0.45, dampingFraction: 0.8)) { step = 2 }
            withAnimation(.easeInOut(duration: 0.8).repeatCount(3, autoreverses: true)) { pulse = true }
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            withAnimation(.easeOut(duration: 0.3)) { step = 0; finger = 0; pulse = false }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
    }
}
