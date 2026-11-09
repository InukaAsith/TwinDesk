// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Staying connected with TwinDesk in the background. iOS suspends an app a few seconds after it
// leaves the screen, which would end the session. iOS's own way comes first: the session moves onto
// the Bluetooth link (Core.backgrounded, unless Off screen is set to Wi-Fi), which iOS keeps and
// wakes the app for; back on Wi-Fi when TwinDesk is open again. The microphone,
// once recording, keeps going on its own (Mic). Two backups keep the whole app running instead, each
// a switch in Settings › Background, off unless turned on:
//
//  • Location: continuous updates at the lowest accuracy (cell and Wi-Fi only, no GPS) with the blue
//    pill in the status bar. iOS 17+ needs only While Using (CLBackgroundActivitySession); iOS 16
//    needs Always. Significant-change monitoring relaunches the app if iOS ended it anyway.
//  • Silent audio: a silent sound playing, mixed with others (your music isn't stopped). A phone
//    call or another app taking the audio pauses it; we start it again when it's over.
//
// Both cost some battery. They run only while a computer is paired and "Stay connected" is on. While
// the screen is shared (the broadcast extension sends through the app), the silent audio runs for
// that time only: iOS keeps an extension, not the app it sends through.
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
    private var lastWake = Date.distantPast // a location update's look at the session, at most every 30 s
    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    private let store = Store.shared

    var enabled: Bool { store.flag("bg.on", true) }
    var useLocation: Bool { store.flag("bg.location", false) }
    var useAudio: Bool { store.flag("bg.audio", false) }
    // Mic is recording: the audio session is its (play and record); ours only adds to it.
    var recording = false
    var active: Bool { locating || engine?.isRunning == true }
    // The computer's music on the Lock Screen (PcMedia): our sound doesn't mix with others then,
    // which is what makes iOS show our Now Playing.
    private(set) var nowPlaying = false
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
        let sharing = Core.shared.mirror.sharing // the screen shared: the app relays it, so it stays up meanwhile
        if want && useLocation { startLocation() } else { stopLocation() }
        if want && (useAudio || nowPlaying || sharing) { startAudio() } else { stopAudio() }
        Core.shared.changed()
    }

    func setNowPlaying(_ on: Bool) {
        guard on != nowPlaying else { return }
        nowPlaying = on
        stopAudio()
        apply()
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
        Core.shared.backgrounded() // General › Background › Off screen: Bluetooth (the default)
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
        // Connected on the network: nothing to look at (the link watches itself; a sweep of the subnet
        // here was radio time for nothing). Otherwise at most every 30 s. The location settings above
        // stay as they are: they are what keeps the app running (no distance filter with low accuracy).
        let core = Core.shared
        if core.link.connected && !core.link.viaBle { return }
        if Date().timeIntervalSince(lastWake) < 30 { return }
        lastWake = Date()
        core.wake()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    // ---- silent audio ----

    private func startAudio() {
        if engine?.isRunning == true { return }
        do {
            let s = AVAudioSession.sharedInstance()
            if !recording { // the microphone's play-and-record session takes our silence as it is
                try s.setCategory(.playback, mode: .default, options: nowPlaying ? [] : [.mixWithOthers])
                try s.setActive(true)
            }
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
        if !recording { try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation]) }
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
