// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Joining another device's Wi-Fi for a moment (its Wi-Fi Direct group, or a phone's hotspot) when
// it isn't on this Mac's network, then back to whatever network macOS picks (the one it was on).
// A Mac has one Wi-Fi radio, so while joined it is on that network only.
//
// Commands: wifiInfo -> {power, ssid, location}; wifiJoin {ssid, password} -> ok | error;
//           wifiLeave; wifiLocation (asks for Location, which macOS wants for Wi-Fi scans).
import CoreLocation
import CoreWLAN
import Foundation

final class WifiCtl: NSObject, CLLocationManagerDelegate {
  static let shared = WifiCtl()

  private let work = DispatchQueue(label: "macshare.wifi")
  private var loc: CLLocationManager? // main thread
  private var powerBefore = true
  private var joined = ""

  private var iface: CWInterface? { CWWiFiClient.shared().interface() }

  func info() -> [String: Any] {
    let i = iface
    return ["power": i?.powerOn() ?? false, "ssid": i?.ssid() ?? "", "name": i?.interfaceName ?? "",
            "joined": joined, "location": locationState()]
  }

  // Main thread (CLLocationManager wants the thread it was made on to have a run loop). When In
  // Use is all Wi-Fi names need.
  func askLocation() {
    if loc == nil {
      loc = CLLocationManager()
      loc?.delegate = self
    }
    if loc?.authorizationStatus == .notDetermined { loc?.requestWhenInUseAuthorization() }
  }

  private func locationState() -> String {
    switch CLLocationManager().authorizationStatus {
    case .authorizedAlways: return "granted"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "notDetermined"
    default: return "granted"
    }
  }

  func join(ssid: String, password: String, done: @escaping (String?) -> Void) {
    work.async {
      guard let i = self.iface, let name = i.interfaceName else { return done("This Mac has no Wi-Fi") }
      if self.joined.isEmpty { self.powerBefore = i.powerOn() }
      if !i.powerOn() { try? i.setPower(true) }
      if i.ssid() == ssid {
        self.joined = ssid
        return done(nil)
      }
      // CoreWLAN first; macOS hides scan results from apps without Location, so networksetup
      // (which scans for itself) when that finds nothing, and at once without Location.
      for _ in 0..<(self.locationState() == "granted" ? 5 : 0) {
        if let net = (try? i.scanForNetworks(withName: ssid, includeHidden: false))?.first {
          do {
            try i.associate(to: net, password: password)
            self.joined = ssid
            return done(nil)
          } catch {
            log("wifi: associate \(ssid): \(error.localizedDescription)")
            break
          }
        }
        Thread.sleep(forTimeInterval: 1.5)
      }
      for _ in 0..<3 {
        let r = Self.run("/usr/sbin/networksetup", ["-setairportnetwork", name, ssid, password])
        // It prints nothing when it joined, else why it didn't.
        if r.code == 0 && r.out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          self.joined = ssid
          return done(nil)
        }
        log("wifi: networksetup \(ssid): \(r.out.trimmingCharacters(in: .whitespacesAndNewlines))")
        Thread.sleep(forTimeInterval: 2)
      }
      done("Couldn’t join \(ssid)")
    }
  }

  // Off the joined network: Wi-Fi off and on again, so macOS joins its usual network by itself (a
  // plain disassociate leaves it unconnected). Off for good if it was off before.
  func leave(done: @escaping () -> Void) {
    work.async {
      guard let i = self.iface, !self.joined.isEmpty else { return done() }
      i.disassociate()
      try? i.setPower(false)
      if self.powerBefore {
        Thread.sleep(forTimeInterval: 0.5)
        try? i.setPower(true)
      }
      self.joined = ""
      done()
    }
  }

  private static func run(_ path: String, _ args: [String]) -> (code: Int32, out: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (-1, error.localizedDescription) }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
  }
}
