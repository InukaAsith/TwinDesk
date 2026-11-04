// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shake to bring the pointer home: while capturing, a quick left-right shake of this Mac's mouse or
// trackpad emits {"event":"shake"} and Node takes the input back here (kvm.js, kvm.shakeHome).
// Fed after the move has gone (lane or stdout), so it adds nothing in front of it: a few compares,
// no allocation. Same rules in windows-helper Shake.cs and linux-helper shake.c:
// a stroke is STROKE pt one way before it turns; REVERSALS turns within WINDOW s is a shake; a
// pause of GAP s or a short wiggle starts over; after one, COOLDOWN s of the rest doesn't count.
import Foundation

enum Shake {
  private static let STROKE = 40.0, REVERSALS = 4, WINDOW = 0.8, GAP = 0.2, COOLDOWN = 1.0
  private static var dir = 0, run = 0.0, last = 0.0, quiet = 0.0
  private static var turns = [Double](repeating: 0, count: REVERSALS), nTurns = 0, head = 0

  private static func reset() {
    dir = 0
    run = 0
    nTurns = 0
  }

  static func feed(_ dx: Double, _ dy: Double) {
    let now = ProcessInfo.processInfo.systemUptime
    if now < quiet { return }
    if now - last >= GAP { reset() }
    last = now
    if abs(dx) < 1 || abs(dy) > abs(dx) * 2 { return } // mostly up or down: not a shake
    let d = dx > 0 ? 1 : -1
    if d == dir {
      run += abs(dx)
      return
    }
    if dir != 0 && run >= STROKE {
      turns[head] = now // a ring of the last REVERSALS turns
      head = (head + 1) % REVERSALS
      nTurns = min(nTurns + 1, REVERSALS)
    } else if dir != 0 { nTurns = 0 }
    dir = d
    run = abs(dx)
    // full ring: turns[head] is the oldest of the last REVERSALS
    if nTurns == REVERSALS && now - turns[head] <= WINDOW {
      reset()
      quiet = now + COOLDOWN
      emit(["event": "shake"])
    }
  }
}
