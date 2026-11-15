// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
@main
struct EmergencyInputGateTest {
  static func main() {
    var gate = EmergencyInputGate()
    gate.session(active: true)
    precondition(gate.allowsInput, "a normal session accepts remote input")
    gate.stop()
    precondition(!gate.allowsInput, "emergency return immediately blocks remote input")
    gate.session(active: true)
    precondition(!gate.allowsInput, "a delayed activation cannot undo the emergency")
    gate.session(active: false)
    precondition(!gate.allowsInput, "the completed old session stays blocked")
    gate.session(active: true)
    precondition(gate.allowsInput, "a later explicitly started session accepts input again")
    print("emergency input gate: ok")
  }
}
