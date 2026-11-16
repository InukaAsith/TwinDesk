// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Desktop geometry for KVM: outer edges, offsets along the crossing side,
// where to land the pointer, and clamping moves to the desktop. Global CG coordinates
// (top-left origin, points).
import CoreGraphics

enum Screens {
  private static var cache: (at: Double, rects: [CGRect]) = (0, [])

  /// Bounds of every active, non-mirrored display (cached for 0.5 s: this runs on every move).
  static func displays() -> [CGRect] {
    let now = CFAbsoluteTimeGetCurrent()
    if now - cache.at < 0.5 { return cache.rects }
    cache = (now, readDisplays())
    return cache.rects
  }

  static func invalidate() { cache.at = 0 }

  private static func readDisplays() -> [CGRect] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.prefix(Int(count))
      .filter { CGDisplayMirrorsDisplay($0) == kCGNullDirectDisplay }
      .map { CGDisplayBounds($0) }
  }

  static func union(_ ds: [CGRect] = displays()) -> CGRect {
    ds.reduce(CGRect.null) { $0.union($1) }
  }

  private static func containing(_ p: CGPoint, _ ds: [CGRect]) -> CGRect? {
    ds.first { p.x >= $0.minX && p.x < $0.maxX && p.y >= $0.minY && p.y < $0.maxY }
  }

  /// True when `p` sits on `side`'s edge of its display (within ~1 pt) and no other display
  /// continues past that edge at that point.
  static func isOuterEdge(_ p: CGPoint, side: String) -> Bool {
    isOuterEdge(p, side: side, displays: displays())
  }

  private static func isOuterEdge(_ p: CGPoint, side: String, displays ds: [CGRect]) -> Bool {
    guard let d = containing(p, ds) else { return false }
    let tol: CGFloat = 1.5
    switch side {
    case "right":
      return p.x >= d.maxX - tol && !ds.contains { abs($0.minX - d.maxX) < 1 && p.y >= $0.minY && p.y < $0.maxY }
    case "left":
      return p.x <= d.minX + tol - 1 && !ds.contains { abs($0.maxX - d.minX) < 1 && p.y >= $0.minY && p.y < $0.maxY }
    case "bottom":
      return p.y >= d.maxY - tol && !ds.contains { abs($0.minY - d.maxY) < 1 && p.x >= $0.minX && p.x < $0.maxX }
    case "top":
      return p.y <= d.minY + tol - 1 && !ds.contains { abs($0.maxY - d.minY) < 1 && p.x >= $0.minX && p.x < $0.maxX }
    default:
      return false
    }
  }

  /// 0–1 position of `p` along `side`, measured on the bounding box of all displays.
  static func offset(_ p: CGPoint, side: String) -> Double {
    let u = union()
    let v = (side == "left" || side == "right") ? (p.y - u.minY) / max(1, u.height) : (p.x - u.minX) / max(1, u.width)
    return Double(min(max(v, 0), 1))
  }

  /// A point 2 pt inside `side`'s outer edge at `offset` (or the main display's centre).
  static func edgePoint(side: String?, offset: Double?) -> CGPoint {
    let ds = displays()
    guard let side = side, let off = offset, !ds.isEmpty else {
      let m = CGDisplayBounds(CGMainDisplayID())
      return CGPoint(x: m.midX, y: m.midY)
    }
    let u = union(ds)
    let o = CGFloat(min(max(off, 0), 1))
    if side == "left" || side == "right" {
      var y = u.minY + o * u.height
      var cands = ds.filter { y >= $0.minY && y < $0.maxY }
      if cands.isEmpty, let near = ds.min(by: { dist(y, $0.minY, $0.maxY) < dist(y, $1.minY, $1.maxY) }) {
        cands = [near]
        y = min(max(y, near.minY), near.maxY - 1)
      }
      let d = side == "right" ? cands.max { $0.maxX < $1.maxX }! : cands.min { $0.minX < $1.minX }!
      return CGPoint(x: side == "right" ? d.maxX - 2 : d.minX + 2, y: min(max(y, d.minY + 1), d.maxY - 2))
    } else {
      var x = u.minX + o * u.width
      var cands = ds.filter { x >= $0.minX && x < $0.maxX }
      if cands.isEmpty, let near = ds.min(by: { dist(x, $0.minX, $0.maxX) < dist(x, $1.minX, $1.maxX) }) {
        cands = [near]
        x = min(max(x, near.minX), near.maxX - 1)
      }
      let d = side == "bottom" ? cands.max { $0.maxY < $1.maxY }! : cands.min { $0.minY < $1.minY }!
      return CGPoint(x: min(max(x, d.minX + 1), d.maxX - 2), y: side == "bottom" ? d.maxY - 2 : d.minY + 2)
    }
  }

  private static func dist(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat {
    v < lo ? lo - v : v >= hi ? v - hi + 1 : 0
  }

  /// Where a relative move from `from` to `to` ends: like `clamp`, but it follows the path display
  /// by display and stops on the edge of a `stops` side where it is an outer edge, so a large jump
  /// can't land on a display past the return edge (the rest counts toward the resistance).
  static func walk(from: CGPoint, to: CGPoint, stops: [String], portalStop: PortalReturnStop? = nil) -> CGPoint {
    walk(from: from, to: to, stops: stops, portalStop: portalStop, displays: displays())
  }

  // Geometry with an explicit display list also allows deterministic tests without an event tap.
  static func walk(from: CGPoint, to: CGPoint, stops: [String], portalStop: PortalReturnStop? = nil, displays ds: [CGRect]) -> CGPoint {
    if stops.isEmpty && portalStop == nil { return clamp(to, from: from, displays: ds) }
    var p = from
    for _ in 0..<8 {
      guard let d = containing(p, ds) else { break }
      if containing(to, ds) == d { return to }
      let vx = to.x - p.x, vy = to.y - p.y
      var t: CGFloat = 1, side = ""
      if vx > 0, to.x >= d.maxX { let k = (d.maxX - p.x) / vx; if k < t { t = k; side = "right" } }
      if vx < 0, to.x < d.minX { let k = (d.minX - p.x) / vx; if k < t { t = k; side = "left" } }
      if vy > 0, to.y >= d.maxY { let k = (d.maxY - p.y) / vy; if k < t { t = k; side = "bottom" } }
      if vy < 0, to.y < d.minY { let k = (d.minY - p.y) / vy; if k < t { t = k; side = "top" } }
      if side.isEmpty { break }
      let e = CGPoint(x: min(max(p.x + vx * t, d.minX), d.maxX - 1), y: min(max(p.y + vy * t, d.minY), d.maxY - 1))
      if let portal = portalStop, portal.display == d, portal.side == side, portalReturnContains(e, stop: portal) { return e }
      if stops.contains(side) && isOuterEdge(e, side: side, displays: ds) { return e }
      // Step just over the edge, onto the next display (or off the desktop: clamp below).
      let next = CGPoint(x: side == "right" ? d.maxX : side == "left" ? d.minX - 1 : e.x,
                         y: side == "bottom" ? d.maxY : side == "top" ? d.minY - 1 : e.y)
      if containing(next, ds) == nil { break }
      p = next
    }
    return clamp(to, from: from, displays: ds)
  }

  /// `to` if it is on a display, else `to` clamped into the display that holds `from`.
  static func clamp(_ to: CGPoint, from: CGPoint) -> CGPoint {
    clamp(to, from: from, displays: displays())
  }

  private static func clamp(_ to: CGPoint, from: CGPoint, displays ds: [CGRect]) -> CGPoint {
    if containing(to, ds) != nil { return to }
    guard let d = containing(from, ds) ?? ds.first else { return to }
    return CGPoint(x: min(max(to.x, d.minX), d.maxX - 1), y: min(max(to.y, d.minY), d.maxY - 1))
  }
}
