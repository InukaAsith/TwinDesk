// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// Pure geometry for a shortcut-gated portal on a shared local-display edge.
import CoreGraphics

struct PortalEdgeHit {
  let offset: Double
  let pin: CGPoint
}

struct PortalReturnStop {
  let display: CGRect
  let side: String
  let range: ClosedRange<Double>
}

// Tests the selected display and interval, not every outer edge on the same desktop side.
func portalReturnContains(_ p: CGPoint, stop: PortalReturnStop) -> Bool {
  let d = stop.display
  guard d.width >= 4, d.height >= 4, d.contains(p) else { return false }
  let vertical = stop.side == "left" || stop.side == "right"
  let edge: Bool
  switch stop.side {
  case "left": edge = p.x <= d.minX + 0.5
  case "right": edge = p.x >= d.maxX - 1.5
  case "top": edge = p.y <= d.minY + 0.5
  case "bottom": edge = p.y >= d.maxY - 1.5
  default: return false
  }
  let offset = Double(((vertical ? p.y : p.x) - (vertical ? d.minY : d.minX)) / (vertical ? d.height : d.width))
  return edge && offset >= stop.range.lowerBound && offset <= stop.range.upperBound
}

func portalSharedEdgeHit(from start: CGPoint, to end: CGPoint, display: CGRect, side: String,
                         range: ClosedRange<Double>, displays: [CGRect]) -> PortalEdgeHit? {
  guard display.width >= 4, display.height >= 4, display.contains(start),
        [start.x, start.y, end.x, end.y].allSatisfy({ $0.isFinite }) else { return nil }
  let dx = end.x - start.x, dy = end.y - start.y
  let t: CGFloat
  switch side {
  case "left": guard dx < 0, end.x < display.minX else { return nil }; t = (display.minX - start.x) / dx
  case "right": guard dx > 0, end.x >= display.maxX else { return nil }; t = (display.maxX - start.x) / dx
  case "top": guard dy < 0, end.y < display.minY else { return nil }; t = (display.minY - start.y) / dy
  case "bottom": guard dy > 0, end.y >= display.maxY else { return nil }; t = (display.maxY - start.y) / dy
  default: return nil
  }
  guard t >= 0, t <= 1 else { return nil }
  let hit = CGPoint(x: start.x + dx * t, y: start.y + dy * t)
  let vertical = side == "left" || side == "right"
  let pos = vertical ? hit.y : hit.x, lo = vertical ? display.minY : display.minX
  let len = vertical ? display.height : display.width
  let offset = Double((pos - lo) / len)
  guard offset >= range.lowerBound, (offset < range.upperBound || (range.upperBound == 1 && offset == 1)) else { return nil }
  let probe: CGPoint
  switch side {
  case "left": probe = CGPoint(x: display.minX - 0.5, y: hit.y)
  case "right": probe = CGPoint(x: display.maxX + 0.5, y: hit.y)
  case "top": probe = CGPoint(x: hit.x, y: display.minY - 0.5)
  default: probe = CGPoint(x: hit.x, y: display.maxY + 0.5)
  }
  guard displays.contains(where: { $0 != display && $0.contains(probe) }) else { return nil }
  let x = min(max(hit.x, display.minX + 2), display.maxX - 2)
  let y = min(max(hit.y, display.minY + 2), display.maxY - 2)
  return PortalEdgeHit(offset: offset, pin: CGPoint(x: x, y: y))
}
