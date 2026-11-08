// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One CGVirtualDisplay at a time (private API, header from DeskPad), plus explicit mode selection.
import Cocoa
import VirtualDisplayBridge

struct HelperError: Error { let message: String }

final class VirtualDisplay {
  private var display: CGVirtualDisplay?
  private var generation = 0

  var displayID: CGDirectDisplayID? { display?.displayID }

  func create(width: Int, height: Int, hiDPI: Bool, hz: Double, name: String,
              done: @escaping (Result<[String: Any], HelperError>) -> Void) {
    destroy()
    generation += 1
    let gen = generation
    let scale = hiDPI ? 2 : 1
    let pw = width * scale, ph = height * scale

    let d = CGVirtualDisplayDescriptor()
    d.setDispatchQueue(DispatchQueue.main)
    d.name = name
    // Scaled sizes around the asked one, like a real panel's (System Settings › Displays: Larger
    // Text … More Space), the asked size selected. Larger ones are drawn at more pixels than the
    // other device has and scaled down for it.
    let factors: [Double] = [1.5, 1.25, 1.125, 1.0, 0.875, 0.75, 0.625, 0.5]
    let even = { (v: Double) -> UInt in UInt(max(2, Int(v.rounded()) & ~1)) }
    d.maxPixelsWide = UInt32(even(Double(pw) * factors[0]))
    d.maxPixelsHigh = UInt32(even(Double(ph) * factors[0]))
    // ~ a 27" panel; only affects the reported DPI.
    d.sizeInMillimeters = CGSize(width: 600, height: 600.0 * Double(height) / Double(width))
    d.productID = 0x4d53
    d.vendorID = 0x4d53
    d.serialNum = 1 // stable: macOS remembers the arrangement
    d.terminationHandler = { [weak self] _, _ in
      DispatchQueue.main.async {
        guard let self = self, gen == self.generation, self.display != nil else { return }
        self.display = nil
        log("virtual display terminated")
        emit(["event": "displayTerminated"])
      }
    }

    let vd = CGVirtualDisplay(descriptor: d)
    let s = CGVirtualDisplaySettings()
    s.hiDPI = hiDPI ? 1 : 0
    // hiDPI: each pixel size is also offered at half (its points); the asked size first.
    var modes = [CGVirtualDisplayMode(width: UInt(pw), height: UInt(ph), refreshRate: hz)]
    var seen = Set([pw * 100000 + ph])
    for f in factors where f != 1.0 {
      let w = even(Double(pw) * f), h = even(Double(ph) * f)
      if w < 640 || h < 360 || !seen.insert(Int(w) * 100000 + Int(h)).inserted { continue }
      modes.append(CGVirtualDisplayMode(width: w, height: h, refreshRate: hz))
    }
    if hiDPI && seen.insert(width * 100000 + height).inserted {
      modes.append(CGVirtualDisplayMode(width: UInt(width), height: UInt(height), refreshRate: hz))
    }
    s.modes = modes
    guard vd.apply(s) else {
      done(.failure(HelperError(message: "applySettings failed")))
      return
    }
    display = vd
    let id = vd.displayID
    log("created display \(id) \(width)x\(height) pt, \(pw)x\(ph) px")
    selectMode(id: id, width: width, pixels: pw, attempt: 0, gen: gen) { [weak self] in
      guard let self = self, gen == self.generation else {
        done(.failure(HelperError(message: "replaced")))
        return
      }
      let b = CGDisplayBounds(id)
      let mode = CGDisplayCopyDisplayMode(id)
      done(.success([
        "displayId": Int(id),
        "bounds": ["x": b.origin.x, "y": b.origin.y, "width": b.size.width, "height": b.size.height],
        "pixelWidth": mode?.pixelWidth ?? pw,
        "pixelHeight": mode?.pixelHeight ?? ph,
      ]))
    }
  }

  // Wait until the mode list contains (width points, pixels wide) and switch to it.
  private func selectMode(id: CGDirectDisplayID, width: Int, pixels: Int, attempt: Int, gen: Int,
                          then: @escaping () -> Void) {
    guard gen == generation else { return then() }
    let opts = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
    let modes = (CGDisplayCopyAllDisplayModes(id, opts) as? [CGDisplayMode]) ?? []
    if let mode = modes.first(where: { $0.width == width && $0.pixelWidth == pixels }) {
      var cfg: CGDisplayConfigRef?
      if CGBeginDisplayConfiguration(&cfg) == .success, let cfg = cfg {
        CGConfigureDisplayWithDisplayMode(cfg, id, mode, nil)
        let err = CGCompleteDisplayConfiguration(cfg, .forSession)
        if err != .success { log("mode switch failed: \(err.rawValue)") }
      }
      return then()
    }
    if attempt >= 10 {
      log("mode \(width) pt / \(pixels) px not found; keeping default")
      return then()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
      self.selectMode(id: id, width: width, pixels: pixels, attempt: attempt + 1, gen: gen, then: then)
    }
  }

  func destroy() {
    if display != nil {
      log("destroying display \(display!.displayID)")
      generation += 1
      display = nil // releasing the object removes the display
    }
  }
}
