// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The input lane in the helper (native/tdfast, docs/protocol.md): Node out of the move path on both
// ends. Driving: the event tap's moves go straight onto the lane (td_move) and nothing is written to
// stdout; clicks, keys, wheel and gestures carry their event number and fence for Node. Driven: the
// lane's moves are injected here (deduplicated, speed applied, after the event they wait for); its
// events go to Node as {"event":"laneEv"} and come back as `inject` in order.
// Command `lane {op: bind | start | stop | active | route | event | driven | hold | fence | done}`.
// With `lane: N` (N > 0, Multi-device, #273): that device's own lane (td_lane_*), `close` too, and its
// events say `lane: N`. Without it, lane 0 exactly as before (the one-to-one app).
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

  /// The lane the tap's moves go on (route > 0 on it last), for the driving flag.
  private var driveLane: UInt32 = 0

  func handle(_ msg: [String: Any], id: Any?) {
    let op = msg["op"] as? String ?? ""
    let num = { (k: String) -> Double in (msg[k] as? NSNumber)?.doubleValue ?? 0 }
    let u32 = { (k: String) -> UInt32 in UInt32(max(0, min(Double(UInt32.max), num(k).rounded()))) }
    let on = { (msg["on"] as? Bool) == true ? Int32(1) : Int32(0) }
    let lid = u32("lane")
    if lid > 0 { return handleLane(lid, op, msg, id, num: num, u32: u32, on: on) }
    switch op {
    case "bind":
      let port = td_bind()
      if port == 0 { return replyError(id, "no lane socket") }
      reply(id, ["port": Int(port)])
    case "start":
      guard let key = msg["key"] as? String, let ip = msg["ip"] as? String else { return replyError(id, "bad lane start") }
      let role: Int32 = (msg["role"] as? String) == "host" ? 0 : 1
      let ok = td_start(role, key, ip, UInt16(clamping: Int(num("port"))), laneCallback, nil)
      started = ok == 1
      if driveLane == 0 { driving = false }
      reply(id, ["ok": started])
    case "stop":
      td_stop()
      started = false
      if driveLane == 0 { driving = false }
    case "active":
      td_active(on())
    case "route":
      let r = u32("route")
      td_drive_reset(r)
      if r != 0 { driveLane = 0; driving = started } else if driveLane == 0 { driving = false }
    case "event":
      guard let m = msg["msg"] as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: m) else { return }
      let es = u32("es")
      data.withUnsafeBytes { p in td_send_event(p.bindMemory(to: UInt8.self).baseAddress, data.count, es) }
    case "driven":
      td_driven(u32("route"), num("speed"))
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

  /// Multi-device: one lane per device (#273).
  private var laneStarted = Set<UInt32>()

  private func handleLane(_ lid: UInt32, _ op: String, _ msg: [String: Any], _ id: Any?,
                          num: (String) -> Double, u32: (String) -> UInt32, on: () -> Int32) {
    switch op {
    case "bind":
      let port = td_lane_bind(lid)
      if port == 0 { return replyError(id, "no lane socket") }
      reply(id, ["port": Int(port), "lane": Int(lid)])
    case "start":
      guard let key = msg["key"] as? String, let ip = msg["ip"] as? String else { return replyError(id, "bad lane start") }
      let role: Int32 = (msg["role"] as? String) == "host" ? 0 : 1
      let ok = td_lane_start(lid, role, key, ip, UInt16(clamping: Int(num("port"))), laneCallback, UnsafeMutableRawPointer(bitPattern: UInt(lid)))
      if ok == 1 { laneStarted.insert(lid) } else { laneStarted.remove(lid) }
      if driveLane == lid { driving = false }
      reply(id, ["ok": ok == 1])
    case "stop", "close":
      if op == "close" { td_lane_close(lid) } else { td_lane_stop(lid) }
      laneStarted.remove(lid)
      if driveLane == lid { driving = false; driveLane = 0 }
    case "active":
      td_lane_active(lid, on())
    case "route":
      let r = u32("route")
      td_lane_drive_reset(lid, r)
      if r != 0 { driveLane = lid; driving = laneStarted.contains(lid) } else if driveLane == lid { driving = false }
    case "event":
      guard let m = msg["msg"] as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: m) else { return }
      let es = u32("es")
      data.withUnsafeBytes { p in td_lane_send_event(lid, p.bindMemory(to: UInt8.self).baseAddress, data.count, es) }
    case "driven":
      td_lane_driven(lid, u32("route"), num("speed"))
    case "hold":
      td_lane_hold(lid, on())
    case "fence":
      var dx = 0.0, dy = 0.0
      if td_lane_fence_apply(lid, u32("route"), u32("mn"), num("cx"), num("cy"), &dx, &dy) == 1 {
        injector.moveRel(dx, dy)
      }
    case "done":
      td_lane_done(lid, u32("es"))
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

  private static let fenced: Set<String> = ["k.md", "k.mu", "k.wh", "k.kd", "k.ku", "k.ge", "k.mod"]

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
  }
}

/// The lane's moves to the main queue without a dictionary or a block per move: they add up under a
/// lock, and one main-queue drain per batch injects them (in order with stdin's `inject` and `fence`,
/// which are on the main queue too).
private let pendLock = NSLock()
private var pendX = 0.0, pendY = 0.0
private var pendPosted = false

private func drainMoves() {
  pendLock.lock()
  let dx = pendX, dy = pendY
  pendX = 0
  pendY = 0
  pendPosted = false
  pendLock.unlock()
  if dx != 0 || dy != 0 { injector.moveRel(dx, dy) }
}

private let drainItem: @convention(block) () -> Void = { drainMoves() }

/// The lane's thread.
private let laneCallback: td_callback = { ctx, kind, dx, dy, json, len in
  // ctx: the lane id (Multi-device); nil for lane 0, whose events stay as they always were.
  let lane = Int(bitPattern: ctx)
  let tag: [String: Any] = lane > 0 ? ["lane": lane] : [:]
  switch kind {
  case Int32(TD_MOVE):
    pendLock.lock()
    pendX += dx
    pendY += dy
    let post = !pendPosted
    pendPosted = true
    pendLock.unlock()
    if post { DispatchQueue.main.async(execute: drainItem) }
  case Int32(TD_EVENT):
    guard let json = json,
          let obj = try? JSONSerialization.jsonObject(with: Data(bytes: json, count: len)) as? [String: Any] else { return }
    DispatchQueue.main.async { emit(["event": "laneEv", "msg": obj].merging(tag) { a, _ in a }) }
  case Int32(TD_UP):
    emit(["event": "lane", "up": true, "rtt": dx].merging(tag) { a, _ in a })
  case Int32(TD_DOWN):
    emit(["event": "lane", "up": false].merging(tag) { a, _ in a })
  default:
    break
  }
}
#endif
