// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Staying connected with TwinDesk in the background. iOS suspends an app a few seconds after it
// leaves the screen, which ends the session. Two ways to keep running, each a switch in Settings ›
// Background (both on by default while connected):
//
//  • Location: continuous updates at the lowest accuracy (cell and Wi-Fi only, no GPS) with the blue
//    pill in the status bar. iOS 17+ needs only While Using (CLBackgroundActivitySession); iOS 16
//    needs Always. Significant-change monitoring relaunches the app if iOS ended it anyway.
//  • Silent audio: a silent sound playing, mixed with others (your music isn't stopped). A phone
//    call or another app taking the audio pauses it; we start it again when it's over.
//
// Both cost some battery. They run only while a computer is paired and "Stay connected" is on.
import Foundation
import CoreLocation
import AVFoundation
import UIKit

final class Background: NSObject, CLLocationManagerDelegate {
    static let shared = Background()

    private let lm = CLLocationManager()
    private var session: AnyObject? // CLBackgroundActivitySession (iOS 17+)
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var locating = false
    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    private let store = Store.shared

    var enabled: Bool { store.flag("bg.on", true) }
    var useLocation: Bool { store.flag("bg.location", true) }
    var useAudio: Bool { store.flag("bg.audio", true) }
    var active: Bool { locating || engine?.isRunning == true }
    var authorization: CLAuthorizationStatus { lm.authorizationStatus }

    override init() {
        super.init()
        lm.delegate = self
        lm.desiredAccuracy = kCLLocationAccuracyThreeKilometers
        lm.distanceFilter = kCLDistanceFilterNone
        lm.pausesLocationUpdatesAutomatically = false
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(mediaReset), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
    }

    func set(_ key: String, _ on: Bool) {
        store.setFlag(key, on)
        apply()
    }

    // On while there's a computer to stay with; off otherwise.
    func apply() {
        let want = enabled && !store.hosts().isEmpty
        if want && useLocation { startLocation() } else { stopLocation() }
        if want && useAudio { startAudio() } else { stopAudio() }
        Core.shared.changed()
    }

    func askLocation() {
        if lm.authorizationStatus == .notDetermined { lm.requestWhenInUseAuthorization() }
        else if lm.authorizationStatus == .authorizedWhenInUse {
            if #available(iOS 17.0, *) {} else { lm.requestAlwaysAuthorization() }
        }
    }

    // Leaving the screen: a few seconds' grace while the keepers take over.
    func enteredBackground() {
        if bgTask == .invalid {
            bgTask = UIApplication.shared.beginBackgroundTask(withName: "TwinDesk") { [weak self] in self?.endTask() }
        }
        apply()
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.endTask() }
    }

    private func endTask() {
        if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid }
    }

    // ---- location ----

    private func startLocation() {
        let st = lm.authorizationStatus
        if st == .notDetermined { lm.requestWhenInUseAuthorization(); return }
        guard st == .authorizedAlways || st == .authorizedWhenInUse else { return }
        if locating { return }
        locating = true
        lm.allowsBackgroundLocationUpdates = true
        lm.showsBackgroundLocationIndicator = true
        if #available(iOS 17.0, *) { session = CLBackgroundActivitySession() }
        lm.startUpdatingLocation()
        if CLLocationManager.significantLocationChangeMonitoringAvailable() { lm.startMonitoringSignificantLocationChanges() }
    }

    private func stopLocation() {
        guard locating else { return }
        locating = false
        lm.stopUpdatingLocation()
        lm.stopMonitoringSignificantLocationChanges()
        if #available(iOS 17.0, *) { (session as? CLBackgroundActivitySession)?.invalidate() }
        session = nil
        lm.allowsBackgroundLocationUpdates = false
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus == .authorizedWhenInUse {
            if #available(iOS 17.0, *) {} else { manager.requestAlwaysAuthorization() }
        }
        apply()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        // Nothing to do with where we are: each update is only a moment awake to look at the session.
        Core.shared.wake()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    // ---- silent audio ----

    private func startAudio() {
        if engine?.isRunning == true { return }
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try s.setActive(true)
            let e = AVAudioEngine()
            let p = AVAudioPlayerNode()
            let fmt = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
            e.attach(p)
            e.connect(p, to: e.mainMixerNode, format: fmt)
            e.mainMixerNode.outputVolume = 0
            let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 44100)!
            buf.frameLength = 44100 // a second of silence (zeros), looped
            try e.start()
            p.scheduleBuffer(buf, at: nil, options: .loops)
            p.play()
            engine = e
            player = p
        } catch {
            NSLog("TwinDesk: silent audio: %@", error.localizedDescription)
        }
    }

    private func stopAudio() {
        player?.stop()
        engine?.stop()
        player = nil
        engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    @objc private func interrupted(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let t = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if t == .ended {
            stopAudio()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.apply() }
        }
    }

    @objc private func mediaReset() {
        engine = nil
        player = nil
        apply()
    }
}
