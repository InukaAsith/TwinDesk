// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The app: one window with four tabs, and the life-cycle hooks the session needs (front, back,
// a twindesk://pair link from the computer's QR code, a relaunch by location in the background).
import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Notifier.shared.setUp()
        Core.shared.start()
        // Relaunched in the background by a significant location change: straight back on.
        if launchOptions?[.location] != nil { Core.shared.wake() }
        return true
    }
}

@main
struct TwinDeskApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @Environment(\.scenePhase) private var phase
    @StateObject private var core = Core.shared
    @AppStorage("appearance") private var appearance = Appearance.system.rawValue
    // General › Language: the whole window is drawn again in the new language.
    @StateObject private var i18n = I18n.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .id(i18n.lang)
                .environmentObject(core)
                .onOpenURL { core.openURL($0) }
                .preferredColorScheme((Appearance(rawValue: appearance) ?? .system).scheme)
        }
        .onChange(of: phase) { p in
            switch p {
            case .active:
                core.setFront(true)
                core.wake()
                core.clip.appBecameActive()
                core.hub.appBecameActive()
                core.files.importInbox()
            case .background:
                core.setFront(false)
                Background.shared.enteredBackground()
            case .inactive:
                core.outOfFocus() // an iPad window out of focus, the app switcher: onto Bluetooth too
            default: break
            }
        }
    }
}
