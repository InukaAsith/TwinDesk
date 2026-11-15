// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.

@main
struct InputSourceShortcutTest {
  static func main() {
    typealias B = InputSourceShortcut.Binding
    let ctrlSpace = B(enabled: true, keyCode: 49, modifiers: 262144)
    let ctrlOptSpace = B(enabled: true, keyCode: 49, modifiers: 786432)

    precondition(InputSourceShortcut.shouldSwitch(heldKinds: ["Control"], bindings: [:], selectableSourceCount: 2),
                 "missing plist entries use macOS defaults")
    precondition(!InputSourceShortcut.shouldSwitch(heldKinds: ["Control"], bindings: [:], selectableSourceCount: 1),
                 "one layout: pass Space through")
    precondition(!InputSourceShortcut.shouldSwitch(heldKinds: ["Control", "Alt"], bindings: [:], selectableSourceCount: 1))

    precondition(InputSourceShortcut.shouldSwitch(heldKinds: ["Control", "Alt"], bindings: [61: ctrlOptSpace], selectableSourceCount: 2))
    precondition(!InputSourceShortcut.shouldSwitch(heldKinds: ["Control"], bindings: [60: B(enabled: false, keyCode: 49, modifiers: 262144)], selectableSourceCount: 2),
                 "disabled macOS shortcut")
    precondition(!InputSourceShortcut.shouldSwitch(heldKinds: ["Control"], bindings: [60: B(enabled: true, keyCode: 49, modifiers: 786432)], selectableSourceCount: 2),
                 "rebound shortcut does not match default ctrl+space")
    precondition(!InputSourceShortcut.shouldSwitch(heldKinds: ["Control", "Shift"], bindings: [60: ctrlSpace], selectableSourceCount: 2))
    precondition(InputSourceShortcut.hotkeyID(for: ["Control"]) == 60)
    precondition(InputSourceShortcut.hotkeyID(for: ["Control", "Alt"]) == 61)
    print("input source shortcut: ok")
  }
}
