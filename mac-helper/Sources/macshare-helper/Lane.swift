// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The input lane in the helper (native/tdfast, docs/perf-plan.md P3): Node out of the move path on both
// ends. Driving: the event tap's moves go straight onto the lane (td_move) and nothing is written to
// stdout; clicks, keys, wheel and gestures carry their event number and fence for Node, and clicks and
// wheel go onto the lane from here too ("sent": Node sends only their WSS copy). Driven: the lane's
// moves are injected here (deduplicated, speed applied, after the event they wait for), and so are its
// clicks and wheel when they're next in order (`direct`); every event also goes to Node as
// {"event":"laneEv"}, and what Node injects comes back as `lane inject` with its number, injected only
// if the lane didn't already (td_claim).
// Command `lane {op: bind | start | stop | active | route | event | driven | direct | hold | fence |
// done | inject}`.
// Built only when build.sh found cargo (-D TDFAST); without it, `lane` is an unknown command and
// Node keeps its own lane (shared/inputlane.js), which speaks the same wire.
#if TDFAST
import Foundation
import TdFast

final class NativeLane {
  static let shared = NativeLane()
  /// Node said this crossing is ours to drive (route > 0): the tap's moves go on the lane.
  private(set) var driving = false
  private var started = false

  func handle(_ msg: [String: Any], id: Any?) {
    let op = msg["op"] as? String ?? ""
    let num = { (k: String) -> Double in (msg[k] as? NSNumber)?.doubleValue ?? 0 }
    let u32 = { (k: String) -> UInt32 in UInt32(max(0, min(Double(UInt32.max), num(k).rounded()))) }
    let on = { (msg["on"] as? Bool) == true ? Int32(1) : Int32(0) }
    switch op {
    case "bind":
      let port = td_bind()
      if port == 0 { return replyError(id, "no lane socket") }
      reply(id, ["port": Int(port), "events": 1]) // events: `direct` and `inject` (clicks and wheel from the lane)
    case "start":
      guard let key = msg["key"] as? String, let ip = msg["ip"] as? String else { return replyError(id, "bad lane start") }
      let role: Int32 = (msg["role"] as? String) == "host" ? 0 : 1
      let ok = td_start(role, key, ip, UInt16(clamping: Int(num("port"))), laneCallback, nil)
      started = ok == 1
      driving = false
      reply(id, ["ok": started])
    case "stop":
      td_stop()
      started = false
      driving = false
    case "active":
      td_active(on())
    case "route":
      let r = u32("route")
      td_drive_reset(r)
      driving = started && r != 0
    case "event":
      guard let m = msg["msg"] as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: m) else { return }
      let es = u32("es")
      data.withUnsafeBytes { p in td_send_event(p.bindMemory(to: UInt8.self).baseAddress, data.count, es) }
    case "driven":
      td_driven(u32("route"), num("speed"))
    case "direct":
      td_direct(on(), (msg["reverse"] as? Bool) == true ? 1 : 0)
    case "inject": // an event Node delivers in order: once, unless the lane injected it already
      if let ev = msg["ev"] as? [String: Any], td_claim(u32("es")) == 1 { injector.injectRel(ev) }
    case "hold":
      td_hold(on())
    case "fence":
      var dx = 0.0, dy = 0.0
      if td_fence_apply(u32("route"), u32("mn"), num("cx"), num("cy"), &dx, &dy) == 1 {
        injector.moveRel(dx, dy)
      }
    case "done":
      td_done(u32("es"))
    default:
      replyError(id, "unknown lane op \(op)")
    }
  }

  /// A move from the tap while capturing: nil when it went on the lane (write nothing), else the k.mm
  /// to write (with the totals while the lane is down).
  func move(_ dx: Double, _ dy: Double) -> [String: Any]? {
    if !driving { return ["t": "k.mm", "dx": dx, "dy": dy] }
    var r: UInt32 = 0, mn: UInt32 = 0, cx = 0.0, cy = 0.0
    switch td_move(dx, dy, &r, &mn, &cx, &cy) {
    case 1: return nil
    case 0: return ["t": "k.mm", "dx": dx, "dy": dy, "route": Int(r), "mn": Int(mn), "mc": [cx, cy]]
    default: return ["t": "k.mm", "dx": dx, "dy": dy]
    }
  }

  private static let fenced: Set<String> = ["k.md", "k.mu", "k.wh", "k.kd", "k.ku", "k.ge"]
  private static let direct: Set<String> = ["k.md", "k.mu", "k.wh"]

  /// A click, key, wheel or gesture from the tap: numbered, with where the moves before it took the pointer.
  func fence(_ fields: inout [String: Any]) {
    guard driving, let t = fields["t"] as? String, NativeLane.fenced.contains(t) else { return }
    var r: UInt32 = 0, mn: UInt32 = 0, cx = 0.0, cy = 0.0
    let es = td_fence(&r, &mn, &cx, &cy)
    if es == 0 { return }
    fields["es"] = Int(es)
    fields["route"] = Int(r)
    fields["mn"] = Int(mn)
    fields["mc"] = [cx, cy]
    // A click or wheel goes onto the lane from here, without waiting for Node (no layout to apply).
    guard NativeLane.direct.contains(t) else { return }
    var m = fields
    m.removeValue(forKey: "es")
    guard let data = try? JSONSerialization.data(withJSONObject: m) else { return }
    data.withUnsafeBytes { p in td_send_event(p.bindMemory(to: UInt8.self).baseAddress, data.count, es) }
    fields["sent"] = true
  }
}

/// The lane's moves, clicks and wheel to the main queue, in order, without a dictionary or a block per
/// move: a fixed ring where a move adds to the newest entry when that is a move, and one main-queue
/// drain per batch injects them (in order with stdin's `inject` and `fence`, on the main queue too).
private struct Pending { var kind: Int32 = 0; var a = 0.0; var b = 0.0; var line = false }
private let pendLock = NSLock()
private var pend = [Pending](repeating: Pending(), count: 256)
private var pendHead = 0, pendTail = 0
private var pendPosted = false

private func queue(_ kind: Int32, _ a: Double, _ b: Double, _ line: Bool = false) {
  pendLock.lock()
  let n = pend.count
  if kind == Int32(TD_MOVE), pendHead > pendTail, pend[(pendHead - 1) % n].kind == kind {
    pend[(pendHead - 1) % n].a += a
    pend[(pendHead - 1) % n].b += b
  } else if pendHead - pendTail < n {
    pend[pendHead % n] = Pending(kind: kind, a: a, b: b, line: line)
    pendHead += 1
  } // full (the main queue is stuck for 256 entries): dropped
  let post = !pendPosted
  pendPosted = true
  pendLock.unlock()
  if post { DispatchQueue.main.async(execute: drainItem) }
}

private func drainLane() {
  while true {
    pendLock.lock()
    if pendTail == pendHead {
      pendPosted = false
      pendLock.unlock()
      return
    }
    let e = pend[pendTail % pend.count]
    pendTail += 1
    pendLock.unlock()
    switch e.kind {
    case Int32(TD_MOVE): if e.a != 0 || e.b != 0 { injector.moveRel(e.a, e.b) }
    case Int32(TD_BUTTON): injector.injectRel(["t": e.b != 0 ? "k.md" : "k.mu", "b": Int(e.a)])
    case Int32(TD_WHEEL): injector.injectRel(["t": "k.wh", "dx": e.a, "dy": e.b, "mode": e.line ? "line" : "pixel"])
    default: break
    }
  }
}

private let drainItem: @convention(block) () -> Void = { drainLane() }

/// The lane's thread.
private let laneCallback: td_callback = { _, kind, dx, dy, json, len in
  switch kind {
  case Int32(TD_MOVE), Int32(TD_BUTTON):
    queue(kind, dx, dy)
  case Int32(TD_WHEEL):
    queue(kind, dx, dy, len == 1)
  case Int32(TD_EVENT):
    guard let json = json,
          let obj = try? JSONSerialization.jsonObject(with: Data(bytes: json, count: len)) as? [String: Any] else { return }
    DispatchQueue.main.async { emit(["event": "laneEv", "msg": obj]) }
  case Int32(TD_UP):
    emit(["event": "lane", "up": true, "rtt": dx])
  case Int32(TD_DOWN):
    emit(["event": "lane", "up": false])
  default:
    break
  }
}
#endif
