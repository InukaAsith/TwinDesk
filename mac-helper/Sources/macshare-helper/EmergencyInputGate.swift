// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// After an emergency, old input stays blocked until the app ends that session and starts another.
struct EmergencyInputGate {
  private enum State { case open, waitingForEnd, waitingForNewSession }
  private var state: State = .open
  var allowsInput: Bool { state == .open }

  mutating func stop() { state = .waitingForEnd }

  mutating func session(active: Bool) {
    if !active && state == .waitingForEnd { state = .waitingForNewSession }
    else if active && state == .waitingForNewSession { state = .open }
  }
}
