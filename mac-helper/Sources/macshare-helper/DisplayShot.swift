// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One still image of one display.
//
// macOS 14 and later: ScreenCaptureKit's screenshot of the SCDisplay whose displayID
// was requested. The shareable-content list is how ScreenCaptureKit names a display.
// It is not a picture. The screenshot call runs once, for that display only.
// There is no second display and no older full-framebuffer fallback. Screen Recording
// is the permission the helper already preflights for the live picture. If it is
// missing, this returns permission and does not prompt.
//
// macOS 13: ScreenCaptureKit can stream, but SCScreenshotManager is macOS 14. This
// returns os and does not invent a preview. The cursor is left out so a thumbnail is
// not a pointer-position update. The pixels are still that display.
import AppKit
import ScreenCaptureKit

/// One generation for every displayShot that has left the command thread.
/// begin() is called before that hop. cancel(), or a later begin(), makes the
/// earlier token fail owns(). The generation is only read and written under the
/// lock, so the capture task and the command thread cannot tear it.
enum ShotEpoch {
  private static var generation: UInt64 = 0
  private static let lock = NSLock()

  static func begin() -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    generation &+= 1
    if generation == 0 { generation = 1 }
    return generation
  }

  static func cancel() {
    lock.lock()
    defer { lock.unlock() }
    generation &+= 1
    if generation == 0 { generation = 1 }
  }

  static func owns(_ token: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return token != 0 && token == generation
  }
}

enum ShotFit {
  static let maxEdge = 480
  static let maxBytes = 24 * 1024

  // Long side at most maxEdge, which itself cannot exceed the module cap.
  // nil when the size is not a real display or the fitted side would be zero.
  static func fit(width: Int, height: Int, maxEdge: Int = ShotFit.maxEdge) -> (width: Int, height: Int)? {
    if width < 1 || height < 1 || maxEdge < 1 || maxEdge > ShotFit.maxEdge { return nil }
    let long = max(width, height)
    if long <= maxEdge { return (width, height) }
    let scale = Double(maxEdge) / Double(long)
    let fittedWidth = Int((Double(width) * scale).rounded(.down))
    let fittedHeight = Int((Double(height) * scale).rounded(.down))
    if fittedWidth < 1 || fittedHeight < 1 || fittedWidth > maxEdge || fittedHeight > maxEdge { return nil }
    return (fittedWidth, fittedHeight)
  }
}

enum DisplayShot {
  /// `token` is the ShotEpoch.begin() value taken before this hop. A cancel or a
  /// replacement shot during the screenshot returns stale and no JPEG.
  static func take(displayId: UInt32, token: UInt64) async -> [String: Any] {
    let body = await takeBody(displayId: displayId, token: token)
    if !ShotEpoch.owns(token) { return ["unavailable": "stale"] }
    return body
  }

  private static func takeBody(displayId: UInt32, token: UInt64) async -> [String: Any] {
    if !ShotEpoch.owns(token) { return ["unavailable": "stale"] }
    if displayId == 0 { return ["unavailable": "display"] }
    guard #available(macOS 14.0, *) else { return ["unavailable": "os"] }
    return await takeOneDisplay(displayId, token: token)
  }

  @available(macOS 14.0, *)
  private static func takeOneDisplay(_ displayId: UInt32, token: UInt64) async -> [String: Any] {
    if !ShotEpoch.owns(token) { return ["unavailable": "stale"] }
    if !CGPreflightScreenCaptureAccess() { return ["unavailable": "permission"] }
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let display = content.displays.first(where: { $0.displayID == displayId }),
            display.displayID == displayId else {
        return ["unavailable": "display"]
      }
      guard let size = ShotFit.fit(width: display.width, height: display.height) else {
        return ["unavailable": "display"]
      }
      let cfg = SCStreamConfiguration()
      cfg.width = size.width
      cfg.height = size.height
      cfg.scalesToFit = true
      cfg.showsCursor = false
      let filter = SCContentFilter(display: display, excludingWindows: [])
      // Enumeration can outlive the ask. A cancel or a newer shot during that await
      // must not start the screenshot.
      if !ShotEpoch.owns(token) { return ["unavailable": "stale"] }
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
      if !ShotEpoch.owns(token) { return ["unavailable": "stale"] }
      guard let jpeg = jpegData(image, maxBytes: ShotFit.maxBytes),
            jpeg.width >= 1, jpeg.height >= 1,
            jpeg.width <= ShotFit.maxEdge, jpeg.height <= ShotFit.maxEdge,
            jpeg.data.count <= ShotFit.maxBytes else {
        return ["unavailable": "bounds"]
      }
      return [
        "displayId": String(displayId),
        "width": jpeg.width,
        "height": jpeg.height,
        "jpeg": jpeg.data.base64EncodedString(),
      ]
    } catch {
      return ["unavailable": "capture"]
    }
  }
}

private struct JpegBytes {
  let data: Data
  let width: Int
  let height: Int
}

private func jpegData(_ image: CGImage, maxBytes: Int) -> JpegBytes? {
  guard var current = fitted(image) else { return nil }
  var quality = 0.7
  for _ in 0..<8 {
    guard current.width <= ShotFit.maxEdge, current.height <= ShotFit.maxEdge else { return nil }
    let rep = NSBitmapImageRep(cgImage: current)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]) else { return nil }
    if data.count <= maxBytes { return JpegBytes(data: data, width: current.width, height: current.height) }
    if quality > 0.4 {
      quality -= 0.15
      continue
    }
    quality = 0.55
    guard let smaller = scale(current, factor: 0.7),
          smaller.width < current.width || smaller.height < current.height,
          let next = fitted(smaller) else { return nil }
    current = next
  }
  return nil
}

private func fitted(_ image: CGImage) -> CGImage? {
  if image.width <= ShotFit.maxEdge && image.height <= ShotFit.maxEdge && image.width > 0 && image.height > 0 { return image }
  guard let size = ShotFit.fit(width: image.width, height: image.height) else { return nil }
  return draw(image, width: size.width, height: size.height)
}

private func scale(_ image: CGImage, factor: Double) -> CGImage? {
  let width = Int((Double(image.width) * factor).rounded(.down))
  let height = Int((Double(image.height) * factor).rounded(.down))
  if width < 1 || height < 1 { return nil }
  return draw(image, width: width, height: height)
}

private func draw(_ image: CGImage, width: Int, height: Int) -> CGImage? {
  guard let ctx = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return nil }
  ctx.interpolationQuality = .medium
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return ctx.makeImage()
}
