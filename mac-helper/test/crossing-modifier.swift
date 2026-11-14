// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
import CoreGraphics

@main
struct CrossingModifierTest {
  static func main() {
    precondition(!allowsCrossing(required: "Command", flags: []),
                 "a Command-gated edge must not cross without Command")
    precondition(allowsCrossing(required: "Command", flags: [.maskCommand]),
                 "holding Command must allow the crossing")
    precondition(allowsCrossing(required: "", flags: []),
                 "without a required modifier the existing crossing remains available")
    precondition(allowsCrossing(required: "Control", flags: [.maskControl]))
    precondition(allowsCrossing(required: "Alt", flags: [.maskAlternate]))
    precondition(allowsCrossing(required: "Shift", flags: [.maskShift]))
    precondition(!allowsCrossing(required: "Control", flags: [.maskCommand]))
    precondition(!allowsCrossing(required: "Unknown", flags: [.maskCommand]))
    let heldAtCrossing = crossingFlags(crossingBits([.maskCommand, .maskAlternate]))
    precondition(allowsCrossing(required: "Command", flags: heldAtCrossing),
                 "a key held before the handover remains available at the return edge")
    precondition(allowsCrossing(required: "Alt", flags: heldAtCrossing),
                 "the normal TwinDesk hotkey can also be a held crossing modifier")
    precondition(!allowsCrossing(required: "Command", flags: crossingFlags(crossingBits([]))),
                 "releasing the key closes the return edge again")
    var pressure = 75.0
    precondition(!crossingModifierGate(required: "Command", flags: [], reset: { pressure = 0 }))
    precondition(pressure == 0, "releasing the modifier clears earlier edge pressure")
    pressure = 20
    precondition(crossingModifierGate(required: "Command", flags: [.maskCommand], reset: { pressure = 0 }))
    precondition(pressure == 20, "holding the modifier preserves the current push")
    print("crossing modifier: ok")
  }
}
