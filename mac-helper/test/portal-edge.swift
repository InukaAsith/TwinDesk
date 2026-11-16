// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
import CoreGraphics

@main
struct PortalEdgeTest {
  static func main() {
    let source = CGRect(x: 100, y: 100, width: 100, height: 100)
    let left = CGRect(x: 0, y: 100, width: 100, height: 100)
    let right = CGRect(x: 200, y: 100, width: 100, height: 100)
    let top = CGRect(x: 100, y: 0, width: 100, height: 100)
    let bottom = CGRect(x: 100, y: 200, width: 100, height: 100)
    let displays = [source, left, right, top, bottom]
    func hit(_ from: CGPoint, _ to: CGPoint, _ side: String, _ range: ClosedRange<Double> = 0...1,
             _ neighbors: [CGRect]? = nil) -> PortalEdgeHit? {
      portalSharedEdgeHit(from: from, to: to, display: source, side: side, range: range, displays: neighbors ?? displays)
    }
    let l = hit(CGPoint(x: 120, y: 150), CGPoint(x: 70, y: 150), "left")!
    precondition(l.offset == 0.5 && l.pin == CGPoint(x: 102, y: 150))
    let r = hit(CGPoint(x: 180, y: 150), CGPoint(x: 220, y: 150), "right")!
    precondition(r.offset == 0.5 && r.pin == CGPoint(x: 198, y: 150))
    let t = hit(CGPoint(x: 150, y: 130), CGPoint(x: 150, y: 40), "top")!
    precondition(t.offset == 0.5 && t.pin == CGPoint(x: 150, y: 102))
    let b = hit(CGPoint(x: 150, y: 190), CGPoint(x: 150, y: 230), "bottom")!
    precondition(b.offset == 0.5 && b.pin == CGPoint(x: 150, y: 198))
    precondition(hit(CGPoint(x: 120, y: 150), CGPoint(x: 70, y: 150), "left", 0...0.5) == nil)
    precondition(hit(CGPoint(x: 120, y: 150), CGPoint(x: 70, y: 150), "left", 0.5...1) != nil)
    precondition(hit(CGPoint(x: 120, y: 150), CGPoint(x: 110, y: 150), "left") == nil)
    precondition(hit(CGPoint(x: 70, y: 150), CGPoint(x: 120, y: 150), "left") == nil)
    precondition(hit(CGPoint(x: 120, y: 150), CGPoint(x: 70, y: 150), "left", 0...1, [source]) == nil)
    precondition(hit(CGPoint(x: 150, y: 150), CGPoint(x: 500, y: 250), "right") != nil, "fast diagonal crosses")
    let stop = PortalReturnStop(display: source, side: "bottom", range: 0.25...0.75)
    precondition(portalReturnContains(CGPoint(x: 150, y: 199), stop: stop), "return stops at the shared destination edge")
    precondition(!portalReturnContains(CGPoint(x: 110, y: 199), stop: stop), "outside the destination range stays local")
    precondition(!portalReturnContains(CGPoint(x: 150, y: 198), stop: stop), "not yet at the edge")
    precondition(!portalReturnContains(CGPoint(x: 150, y: 200), stop: stop), "not on the selected display")
    let start = CGPoint(x: 150, y: 180), toNeighbor = CGPoint(x: 150, y: 250)
    precondition(Screens.walk(from: start, to: toNeighbor, stops: [], portalStop: stop, displays: displays) == CGPoint(x: 150, y: 199),
                 "injected movement stops at the selected occupied edge for a shortcut-free return")
    precondition(Screens.walk(from: start, to: toNeighbor, stops: [], displays: displays) == toNeighbor,
                 "without an active portal the same move goes to the local display")
    let outsideStart = CGPoint(x: 110, y: 180), outsideTarget = CGPoint(x: 110, y: 250)
    precondition(Screens.walk(from: outsideStart, to: outsideTarget, stops: [], portalStop: stop, displays: displays) == outsideTarget,
                 "outside the configured interval movement reaches the local display")
    let otherStop = PortalReturnStop(display: left, side: "bottom", range: 0...1)
    precondition(Screens.walk(from: start, to: toNeighbor, stops: [], portalStop: otherStop, displays: displays) == toNeighbor,
                 "a portal on another display must not stop this one")
    print("shared-edge portal geometry: ok")
  }
}
