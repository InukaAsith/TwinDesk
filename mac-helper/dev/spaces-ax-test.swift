// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fake Mission Control tree and the overview state machine. Compile with SpacesAX.swift
// and run this binary only. It does not link SpacesOverview, Accessibility, SkyLight,
// or the expose notification, and it does not open Mission Control or press a button.
//
// One-job refusal lives in SpaceOverview.begin: a second spacesSwitch while needsTick
// is true is an error and does not touch the running attempt. This file does not
// construct that type.
import Foundation

var failures = 0

func check(_ ok: Bool, _ name: String) {
  if ok { return }
  failures += 1
  FileHandle.standardError.write(Data("FAIL \(name)\n".utf8))
}

func describe(_ reply: OverviewReply?) -> String {
  switch reply {
  case nil: return "nil"
  case .armed(let token): return "armed(\(token))"
  case .ok: return "ok"
  case .fail(let why): return "fail(\(why))"
  }
}

func dump(_ effects: OverviewEffects) -> String {
  "hold=\(effects.hold) open=\(effects.open) close=\(effects.close) restore=\(effects.restore) aborted=\(effects.aborted) switch=\(describe(effects.switchReply)) commit=\(describe(effects.commitReply))"
}

func expect(_ name: String, _ got: OverviewEffects, hold: Bool = false, open: Bool = false, close: Bool = false, restore: Bool = false, aborted: Bool = false, switchReply: OverviewReply? = nil, commitReply: OverviewReply? = nil) {
  let want = OverviewEffects(hold: hold, open: open, close: close, restore: restore, aborted: aborted, switchReply: switchReply, commitReply: commitReply)
  check(got == want, "\(name): \(dump(got))")
}

func describe(_ decision: PressDecision) -> String {
  switch decision {
  case .fire(let index): return "fire(\(index))"
  case .settle(let effects): return "settle(\(dump(effects)))"
  }
}

func buttons(_ count: Int, pressable: Bool = true) -> [Bool] {
  Array(repeating: pressable, count: count)
}

func desk(_ id: UInt32?, groups: Int = 1, lists: [[Bool]]) -> MCDisplay {
  MCDisplay(displayID: id, spaceGroups: groups, lists: lists)
}

func tree(_ displays: MCDisplay...) -> PollInput {
  .show(.tree(displays))
}

func host(dockCount: Int = 1, windowManagerCount: Int = 1, dockMCCount: Int = 0, dockHasMC: Bool = false, dockDisplays: [MCDisplay] = [], windowDisplays: [MCDisplay] = []) -> HostSnapshot {
  HostSnapshot(dockCount: dockCount, windowManagerCount: windowManagerCount, dockMCCount: dockMCCount, dockHasMC: dockHasMC, dockDisplays: dockDisplays, windowDisplays: windowDisplays)
}

func job(token: String = "1", displayId: UInt32 = 1, index: Int = 1, count: Int = 3, started: Double = 10) -> OverviewMachine {
  OverviewMachine(token: token, displayId: displayId, spaceIndex: index, spaceCount: count, started: started, deadline: started + 2, readyDelay: 0.3, armWindow: 1, commitWindow: 0.5, confirmWindow: 1)
}

func row(_ id: UInt32, _ current: UInt64?) -> DisplayCurrent {
  DisplayCurrent(displayId: id, current: current)
}

/// Display 1 has three pressable thumbnails. Display 2 has two. Index 1 is display 1's second.
func readyPair() -> PollInput {
  tree(
    desk(1, lists: [buttons(3)]),
    desk(2, lists: [buttons(2)])
  )
}

func opened(_ machine: OverviewMachine) {
  let effects = machine.start(input: .show(.hidden))
  expect("start hidden", effects, hold: true, open: true)
  check(machine.phase == .polling && machine.held && !machine.openedByUs, "start is polling before the notification")
  machine.noteOpened()
  check(machine.openedByUs, "noteOpened")
}

func arm(_ machine: OverviewMachine, _ input: PollInput) {
  opened(machine)
  let early = machine.tick(now: 10.0, input: input)
  expect("first ready before delay", early)
  check(machine.phase == .polling, "one ready tick does not arm")
  let waiting = machine.tick(now: 10.2, input: input)
  expect("second ready before delay", waiting)
  check(machine.phase == .polling, "two ready ticks before readyDelay do not arm")
  let armed = machine.tick(now: 10.3, input: input)
  expect("arm", armed, switchReply: .armed(machine.token))
  check(machine.phase == .armed, "phase armed")
}

func classifyTests() {
  let wm = [desk(1, lists: [buttons(3)]), desk(2, lists: [buttons(2)])]
  let mac27 = MissionControlPlan.classify(host(dockMCCount: 1, dockHasMC: true, windowDisplays: wm))
  check(mac27 == .show(.tree(wm)), "macOS 27 uses WindowManager displays and ignores the empty Dock mc stub")

  let dockOnly = [desk(7, lists: [buttons(2)])]
  let older = MissionControlPlan.classify(host(dockMCCount: 1, dockHasMC: true, dockDisplays: dockOnly))
  check(older == .show(.tree(dockOnly)), "Dock tree when WindowManager has no displays")

  let both = MissionControlPlan.classify(host(dockMCCount: 1, dockHasMC: true, dockDisplays: dockOnly, windowDisplays: wm))
  check(both == .ambiguousHost, "Dock and WindowManager trees together are ambiguous")

  let twoWM = MissionControlPlan.classify(host(windowManagerCount: 2, windowDisplays: wm))
  check(twoWM == .ambiguousHost, "two WindowManager processes")
  let twoDock = MissionControlPlan.classify(host(dockCount: 2, dockMCCount: 1, dockHasMC: true, windowDisplays: wm))
  check(twoDock == .ambiguousHost, "two Dock processes beat a well-formed WindowManager tree")
  let twoMC = MissionControlPlan.classify(host(dockMCCount: 2, dockHasMC: true, windowDisplays: wm))
  check(twoMC == .ambiguousHost, "two Dock mc groups")

  let stub = MissionControlPlan.classify(host(dockMCCount: 1, dockHasMC: true))
  check(stub == .show(.stub), "Dock mc with no displays is a stub")
  let hidden = MissionControlPlan.classify(host())
  check(hidden == .show(.hidden), "no mc is hidden")

  let ghostWM = MissionControlPlan.classify(host(windowManagerCount: 0, windowDisplays: wm))
  check(ghostWM == .ambiguousHost, "WindowManager displays with no process")
  let ghostDock = MissionControlPlan.classify(host(dockCount: 0, dockMCCount: 1, dockHasMC: true))
  check(ghostDock == .ambiguousHost, "Dock mc with no Dock process")
  let ghostTree = MissionControlPlan.classify(host(dockCount: 0, dockDisplays: dockOnly))
  check(ghostTree == .ambiguousHost, "Dock displays with no Dock process")
}

func planTests() {
  let pair = readyPair()
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [buttons(3)]), desk(2, lists: [buttons(2)])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .ready(1), "exact index 1 of display 1")
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [buttons(3)]), desk(2, lists: [buttons(2)])]), displayId: 2, spaceIndex: 0, spaceCount: 2) == .ready(0), "exact index 0 of display 2, not display 1")
  if case .show(.tree(let displays)) = pair {
    check(MissionControlPlan.plan(show: .tree(displays), displayId: 2, spaceIndex: 1, spaceCount: 3) == .incomplete, "display 2's short list is not display 1's press")
  }

  check(MissionControlPlan.plan(show: .tree([desk(nil, lists: [buttons(3)])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .incomplete, "missing AXDisplayID")
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [buttons(3)]), desk(nil, lists: [buttons(2)])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .incomplete, "a neighbour with no id blocks the press")
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [buttons(3)]), desk(1, lists: [buttons(3)])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .refuse("ambiguous"), "duplicate AXDisplayID")
  check(MissionControlPlan.plan(show: .tree([desk(2, lists: [buttons(2)]), desk(2, lists: [buttons(2)])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .refuse("ambiguous"), "duplicate of another display")
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [buttons(2)])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .incomplete, "short list")
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [buttons(4)])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .refuse("ambiguous"), "long list")
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [buttons(3), buttons(3)])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .refuse("ambiguous"), "two lists")
  check(MissionControlPlan.plan(show: .tree([desk(1, groups: 2, lists: [buttons(3)])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .refuse("ambiguous"), "two space groups")
  check(MissionControlPlan.plan(show: .tree([desk(1, groups: 0, lists: [])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .incomplete, "no space group yet")
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [[true, false, true]])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .incomplete, "a child that is not pressable")
  check(MissionControlPlan.plan(show: .tree([desk(2, lists: [buttons(3)])]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .incomplete, "wrong display stays incomplete")
  check(MissionControlPlan.plan(show: .tree([]), displayId: 1, spaceIndex: 1, spaceCount: 3) == .incomplete, "empty tree")
  check(MissionControlPlan.plan(show: .hidden, displayId: 1, spaceIndex: 1, spaceCount: 3) == .incomplete, "hidden is not a press")
  check(MissionControlPlan.plan(show: .stub, displayId: 1, spaceIndex: 1, spaceCount: 3) == .incomplete, "stub is not a press")
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [buttons(3)])]), displayId: 0, spaceIndex: 1, spaceCount: 3) == .refuse("unavailable"), "display id 0")
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [buttons(3)])]), displayId: 1, spaceIndex: -1, spaceCount: 3) == .refuse("unavailable"), "negative index")
  check(MissionControlPlan.plan(show: .tree([desk(1, lists: [buttons(3)])]), displayId: 1, spaceIndex: 3, spaceCount: 3) == .refuse("unavailable"), "index past count")
}

func compositionTests() {
  check(SpaceComposition.clean(current: [9, 15], windows: [[9], [15], [9, 15]]), "windows on the current desktops are clean")
  check(SpaceComposition.clean(current: [9], windows: []), "a display with no normal windows is clean")
  check(!SpaceComposition.clean(current: [9, 15], windows: [[10]]), "a window on another desktop is not clean")
  check(!SpaceComposition.clean(current: [9, 15], windows: [[9], []]), "a window with no space is not clean")
  check(!SpaceComposition.clean(current: [9, 15], windows: nil), "an unreadable window list is not clean")
  check(!SpaceComposition.clean(current: [], windows: []), "no current desktop is not clean")
  check(!SpaceComposition.clean(current: [9, 9], windows: [[9]]), "one current desktop on two displays is not clean")
  check(!SpaceComposition.clean(current: [0, 15], windows: [[15]]), "a zero desktop id is not clean")
}

func moveTests() {
  let before = [row(1, 10), row(2, 20)]
  let swapped = [row(2, 20), row(1, 11)]
  check(SpaceMoveCheck.baseline(before, displayId: 1, spaceId: 11), "baseline is the other desktop")
  check(!SpaceMoveCheck.baseline(before, displayId: 1, spaceId: 10), "already there is not a move")
  check(!SpaceMoveCheck.baseline([row(1, 10), row(2, nil)], displayId: 1, spaceId: 11), "another display with no current is not a baseline")
  check(SpaceMoveCheck.judge(before: before, after: swapped, displayId: 1, spaceId: 11) == .confirmed, "destination current and the other display unchanged")
  check(SpaceMoveCheck.judge(before: [row(1, 10)], after: [row(1, 11)], displayId: 1, spaceId: 11) == .confirmed, "one display can confirm")
  check(SpaceMoveCheck.judge(before: before, after: [row(1, 10), row(2, 20)], displayId: 1, spaceId: 11) == .pending, "still the old desktop")
  check(SpaceMoveCheck.judge(before: before, after: [row(1, 11), row(2, 21)], displayId: 1, spaceId: 11) == .refused("spans"), "another display changed")
  check(SpaceMoveCheck.judge(before: before, after: [row(1, 12), row(2, 20)], displayId: 1, spaceId: 11) == .refused("unavailable"), "a third desktop")
  check(SpaceMoveCheck.judge(before: before, after: nil, displayId: 1, spaceId: 11) == .unread, "a failed space read can be retried")
  check(SpaceMoveCheck.judge(before: before, after: [row(1, 11)], displayId: 1, spaceId: 11) == .refused("unavailable"), "a missing display")
  check(SpaceMoveCheck.judge(before: before, after: [row(1, 11), row(1, 11)], displayId: 1, spaceId: 11) == .refused("ambiguous"), "duplicate display id")
  check(SpaceMoveCheck.judge(before: before, after: [row(1, nil), row(2, 20)], displayId: 1, spaceId: 11) == .unread, "destination current not readable yet")
  check(SpaceMoveCheck.judge(before: before, after: [row(1, 11), row(2, nil)], displayId: 1, spaceId: 11) == .unread, "other current not readable yet")
  check(SpaceMoveCheck.judge(before: before, after: [row(1, 12), row(2, nil)], displayId: 1, spaceId: 11) == .refused("unavailable"), "a third desktop is not hidden by an unreadable neighbour")
}

func machineTests() {
  let input = readyPair()

  do {
    let machine = job()
    let unread = machine.start(input: .unreadable)
    expect("unreadable start", unread, switchReply: .fail("unavailable"))
    check(!machine.held && machine.phase == .settled, "unreadable start does not hold")
  }

  do {
    let machine = job()
    let shown = machine.start(input: .show(.stub))
    expect("already stub", shown, switchReply: .fail("overview"))
    check(!machine.held && !machine.openedByUs, "already open does not hold or take ownership")
  }

  do {
    let machine = job()
    let shown = machine.start(input: input)
    expect("already tree", shown, switchReply: .fail("overview"))
    check(!machine.held, "visible tree does not hold")
  }

  do {
    let machine = job()
    let bad = machine.start(input: .ambiguousHost)
    expect("ambiguous host start", bad, switchReply: .fail("ambiguous"))
    check(!machine.held && machine.phase == .settled, "ambiguous host does not hold or close")
  }

  do {
    let machine = job()
    opened(machine)
    let undo = machine.cancelOpen(why: "overview")
    expect("cancel open", undo, restore: true, switchReply: .fail("overview"))
    check(!machine.openedByUs && !undo.close, "cancelOpen does not close")
  }

  do {
    let machine = job()
    opened(machine)
    let gap = machine.tick(now: 10.4, input: .show(.hidden))
    expect("incomplete resets", gap)
    let one = machine.tick(now: 10.5, input: input)
    expect("ready after reset", one)
    check(machine.phase == .polling, "a single ready after incomplete does not arm")
    let two = machine.tick(now: 10.5, input: input)
    expect("second ready after delay", two, switchReply: .armed("1"))
  }

  do {
    let machine = job()
    opened(machine)
    let stopped = machine.abort(token: "1", now: 10.2, input: .show(.hidden))
    expect("abort while polling, overview not visible yet", stopped, restore: true, aborted: true, switchReply: .fail("stale"))
    check(!stopped.close && !machine.pressed, "abort does not toggle what it cannot see and does not press")
    let decision = machine.beginPress(now: 10.2, input: input)
    check(decision == .settle(OverviewEffects()), "abort before arm is not fire: \(describe(decision))")
  }

  do {
    let machine = job()
    opened(machine)
    let stopped = machine.abort(token: "1", now: 10.2, input: input)
    expect("abort while polling a visible tree", stopped, close: true, aborted: true)
    check(stopped.switchReply == nil && !stopped.restore && machine.held && machine.phase == .releasing, "close does not resume input")
    let during = machine.tick(now: 10.3, input: input)
    expect("closing overview stays held", during)
    check(!during.close && !during.restore, "a visible read during close does not toggle again")
    let missed = machine.tick(now: 10.4, input: .unreadable)
    expect("unreadable during close is not hidden", missed)
    check(!missed.close && !missed.restore, "unreadable during close does not resume or toggle")
    let done = machine.tick(now: 10.5, input: .show(.hidden))
    expect("fresh hidden after close", done, restore: true, switchReply: .fail("stale"))
    check(!done.close && !machine.held && !machine.pressed, "hidden releases input and does not press")
  }

  do {
    let machine = job()
    opened(machine)
    let early = machine.tick(now: 10.1, input: .show(.stub))
    expect("stub while polling", early)
    let later = machine.tick(now: 12, input: .unreadable)
    expect("unreadable after a seen stub does not toggle", later)
    check(!later.close && !later.restore && machine.phase == .releasing && machine.held, "unknown keeps the hold and does not reuse the stub")
    let again = machine.tick(now: 12.2, input: .unreadable)
    expect("unreadable again does not toggle", again)
    check(!again.close, "a second unreadable read does not toggle")
    let hidden = machine.tick(now: 12.4, input: .show(.hidden))
    expect("fresh hidden releases without a toggle", hidden, restore: true, switchReply: .fail("unavailable"))
    check(!hidden.close, "fresh hidden does not toggle")
  }

  do {
    let machine = job()
    opened(machine)
    _ = machine.tick(now: 12, input: .unreadable)
    let seen = machine.tick(now: 12.2, input: .show(.stub))
    expect("fresh stub after unknown closes once", seen, close: true)
    check(machine.phase == .releasing && machine.held, "the close stays held")
    let twice = machine.tick(now: 12.3, input: .show(.stub))
    expect("second stub does not toggle again", twice)
    check(!twice.close && !twice.restore, "a second visible read does not toggle again")
    let done = machine.tick(now: 12.5, input: .show(.hidden))
    expect("hidden after that close", done, restore: true, switchReply: .fail("unavailable"))
    check(!done.close, "hidden after close does not toggle")
  }

  do {
    let machine = job()
    opened(machine)
    _ = machine.tick(now: 12, input: .unreadable)
    let seen = machine.tick(now: 12.2, input: .show(.stub))
    expect("fresh stub asks for one close", seen, close: true)
    machine.closeMissed()
    let retry = machine.tick(now: 12.3, input: .show(.stub))
    expect("a missed close is not sent again", retry)
    check(!retry.close && !retry.restore && machine.held, "a missed close is not retried")
    let stuck = machine.tick(now: 13, input: .show(.stub))
    expect("confirm bound while visible keeps the hold", stuck)
    check(!stuck.close && !stuck.restore && machine.held && machine.phase == .releasing, "a visible confirm bound does not resume or toggle")
    let unknown = machine.tick(now: 13.1, input: .unreadable)
    expect("confirm bound while unknown keeps the hold", unknown)
    check(!unknown.close && !unknown.restore && machine.held, "an unknown confirm bound does not resume or toggle")
    let ambiguous = machine.tick(now: 13.2, input: .ambiguousHost)
    expect("confirm bound while ambiguous keeps the hold", ambiguous)
    check(!ambiguous.close && !ambiguous.restore, "ambiguous is not a hidden confirmation and not a toggle")
    let done = machine.tick(now: 13.3, input: .show(.hidden))
    expect("fresh hidden after the confirm bound", done, restore: true, switchReply: .fail("unavailable"))
    check(!done.close && !machine.held, "a hidden confirmation releases input")
  }

  do {
    let machine = job()
    opened(machine)
    let hidden = machine.tick(now: 12, input: .show(.hidden))
    expect("deadline while hidden", hidden, restore: true, switchReply: .fail("unavailable"))
    check(!hidden.close, "still hidden is not closed")
  }

  do {
    let machine = job()
    opened(machine)
    let missed = machine.tick(now: 12, input: .unreadable)
    expect("deadline never seen", missed)
    check(!missed.close && !missed.restore && machine.phase == .releasing && machine.held, "unreadable with no prior show does not toggle or resume")
    let done = machine.tick(now: 12.2, input: .show(.hidden))
    expect("never seen then hidden", done, restore: true, switchReply: .fail("unavailable"))
    check(!done.close, "hidden without a prior show does not toggle")
  }

  do {
    let machine = job()
    arm(machine, input)
    let expired = machine.tick(now: 11.3, input: input)
    expect("arm timeout", expired, close: true)
    check(machine.phase == .releasing && machine.held && expired.switchReply == nil, "arm timeout holds through the close")
    let late = machine.commit(token: "1", now: 11.4, input: input)
    expect("commit after arm timeout", late, commitReply: .fail("unavailable"))
    check(machine.phase == .releasing && !machine.pressed, "late commit does not press or settle the hold")
    let decision = machine.beginPress(now: 11.4, input: input)
    check(decision == .settle(OverviewEffects()), "commit after timeout does not press: \(describe(decision))")
    let done = machine.tick(now: 11.5, input: .show(.hidden))
    expect("arm timeout hidden", done, restore: true)
    check(done.commitReply == nil && done.switchReply == nil, "the commit reply was the late commit")
  }

  do {
    let machine = job()
    opened(machine)
    let early = machine.commit(token: "1", now: 10.1, input: .show(.hidden))
    expect("commit before arm", early, restore: true, switchReply: .fail("stale"), commitReply: .fail("stale"))
    check(machine.phase == .settled, "commit before arm settles")
  }

  do {
    let machine = job()
    arm(machine, input)
    let wrong = machine.commit(token: "other", now: 10.4, input: input)
    expect("wrong commit token", wrong, commitReply: .fail("stale"))
    check(machine.phase == .armed && !machine.cancelled, "wrong token does not touch the attempt")
    let ignored = machine.abort(token: "other", now: 10.4, input: input)
    expect("wrong abort token", ignored)
    check(machine.phase == .armed && !machine.cancelled, "wrong abort token does not cancel")
  }

  do {
    let machine = job()
    arm(machine, input)
    let held = machine.tick(now: 10.4, input: .ambiguousHost)
    expect("armed tick waits for commit or the arm deadline", held)
    check(machine.phase == .armed, "an armed attempt is not dropped by a later reading")
    let stopped = machine.abort(token: "1", now: 10.4, input: input)
    expect("abort while armed", stopped, close: true, aborted: true)
    check(stopped.switchReply == nil && stopped.commitReply == nil && !stopped.restore, "armed abort holds input")
    let decision = machine.beginPress(now: 10.5, input: input)
    check(decision == .settle(OverviewEffects()), "abort before press is not fire: \(describe(decision))")
    check(!machine.pressed, "abort does not press")
    let done = machine.tick(now: 10.6, input: .show(.hidden))
    expect("armed abort then hidden", done, restore: true)
    check(done.switchReply == nil && done.commitReply == nil, "armed abort has no second reply")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: .ambiguousHost)
    let decision = machine.beginPress(now: 10.45, input: .ambiguousHost)
    check(decision == .settle(OverviewEffects()), "ambiguous at press time does not toggle: \(describe(decision))")
    check(!machine.pressed && machine.phase == .releasing && machine.held, "ambiguous host does not press or resume")
    let done = machine.tick(now: 10.5, input: .show(.hidden))
    expect("ambiguous then hidden", done, restore: true, commitReply: .fail("ambiguous"))
    check(!done.close, "hidden confirmation is not a toggle")
  }

  do {
    let machine = job()
    arm(machine, input)
    let accepted = machine.commit(token: "1", now: 10.4, input: input)
    expect("commit", accepted)
    check(machine.phase == .committing, "commit waits for the next turn")
    let stopped = machine.abort(token: "1", now: 10.45, input: input)
    expect("abort after commit", stopped, close: true, aborted: true)
    check(stopped.commitReply == nil && !stopped.restore && machine.phase == .releasing, "abort after commit holds through the close")
    let decision = machine.beginPress(now: 10.5, input: input)
    check(decision == .settle(OverviewEffects()), "commit then abort then beginPress does not fire: \(describe(decision))")
    check(!machine.pressed, "replaced commit does not press")
    let done = machine.tick(now: 10.6, input: .show(.hidden))
    expect("abort after commit releases when hidden", done, restore: true, commitReply: .fail("stale"))
    check(machine.phase == .settled && !done.close, "hidden after abort settles without a toggle")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    let decision = machine.beginPress(now: 10.9, input: input)
    check(decision == .settle(OverviewEffects(close: true)), "commit window expiry holds: \(describe(decision))")
    check(!machine.pressed && machine.phase == .releasing && machine.held, "expired commit does not press or resume")
    let done = machine.tick(now: 11.0, input: .show(.hidden))
    expect("commit window then hidden", done, restore: true, commitReply: .fail("unavailable"))
    check(!done.close, "commit window hidden does not toggle")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    let decision = machine.beginPress(now: 10.5, input: input)
    check(decision == .fire(1), "beginPress fires index 1: \(describe(decision))")
    let pressed = machine.finishPress(ok: true, now: 10.5, input: input)
    expect("press holds input", pressed)
    check(machine.pressed && machine.phase == .releasing && machine.held && !pressed.close && pressed.commitReply == nil, "success does not toggle or report yet")
    let showing = machine.tick(now: 10.6, input: input, move: .confirmed)
    expect("confirmed while the overview is up", showing)
    check(!showing.restore && showing.commitReply == nil && machine.held, "a space change is not a hidden overview")
    let unread = machine.tick(now: 10.7, input: .unreadable, move: .confirmed)
    expect("unreadable after press is not hidden", unread)
    check(!unread.restore && !unread.close, "unreadable after press is not hidden and not a toggle")
    let pending = machine.tick(now: 10.8, input: .show(.hidden), move: .pending)
    expect("hidden before the space list moves", pending)
    check(!pending.restore && pending.commitReply == nil, "hidden without a confirmed move does not succeed")
    let done = machine.tick(now: 10.9, input: .show(.hidden), move: .confirmed)
    expect("hidden and destination confirmed", done, restore: true, commitReply: .ok)
    check(!done.close && !machine.held, "success does not toggle Mission Control")
    let late = machine.abort(token: "1", now: 11, input: .show(.hidden))
    expect("abort after accept", late)
    check(!late.aborted, "abort after the press decision does not unwind it")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    _ = machine.beginPress(now: 10.5, input: input)
    _ = machine.finishPress(ok: true, now: 10.5, input: input)
    let drifted = machine.tick(now: 10.6, input: input, move: .refused("spans"))
    expect("drift while open holds input", drifted)
    check(machine.held && drifted.commitReply == nil && !drifted.close, "drift while open keeps the hold")
    let late = machine.tick(now: 11.5, input: input, move: .confirmed)
    expect("latched drift while visible does not resume", late)
    check(!late.restore && !late.close && late.commitReply == nil && machine.held, "the bound does not resume a visible drifted switch")
    let done = machine.tick(now: 11.6, input: .show(.hidden), move: .confirmed)
    expect("latched drift is not a later success", done, restore: true, commitReply: .fail("spans"))
    check(!done.close, "a drifted switch does not toggle")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    _ = machine.beginPress(now: 10.5, input: input)
    _ = machine.finishPress(ok: true, now: 10.5, input: input)
    let late = machine.tick(now: 11.5, input: input, move: .pending)
    expect("postcheck bound while the overview is up", late)
    check(!late.restore && !late.close && late.commitReply == nil && machine.held, "a visible postcheck bound does not resume input")
    let unknown = machine.tick(now: 11.6, input: .unreadable, move: .unread)
    expect("postcheck bound while unreadable", unknown)
    check(!unknown.restore && !unknown.close && machine.held, "an unknown postcheck bound does not resume or toggle")
    let done = machine.tick(now: 11.7, input: .show(.hidden), move: .pending)
    expect("hidden after the bound without a move", done, restore: true, commitReply: .fail("unavailable"))
    check(!done.close && !machine.held, "a hidden confirmation releases input when the desktop did not move")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    _ = machine.beginPress(now: 10.5, input: input)
    _ = machine.finishPress(ok: true, now: 10.5, input: input)
    let late = machine.tick(now: 11.5, input: input, move: .confirmed)
    expect("confirmed while the overview is still up at the bound", late)
    check(!late.restore && !late.close && late.commitReply == nil && machine.held, "a space change is not a hidden overview")
    let unknown = machine.tick(now: 11.6, input: .ambiguousHost, move: .confirmed)
    expect("ambiguous after the bound is not hidden", unknown)
    check(!unknown.restore && !unknown.close && machine.held, "ambiguous does not resume or toggle")
    let done = machine.tick(now: 11.7, input: .show(.hidden), move: .confirmed)
    expect("hidden after the bound confirms the press", done, restore: true, commitReply: .ok)
    check(!done.close && !machine.held, "success does not toggle")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    let decision = machine.beginPress(now: 10.5, input: input)
    check(decision == .fire(1), "fire before abandon")
    let dropped = machine.abandonPress(now: 10.5, input: input)
    expect("abandon before press", dropped, close: true)
    check(dropped.commitReply == nil && machine.phase == .releasing && machine.held, "abandon holds through the close")
    check(!machine.pressed, "abandon does not press")
    let again = machine.beginPress(now: 10.5, input: input)
    check(again == .settle(OverviewEffects()), "abandon cannot fire again: \(describe(again))")
    let done = machine.tick(now: 10.6, input: .show(.hidden))
    expect("abandon then hidden", done, restore: true, commitReply: .fail("unavailable"))
    check(!done.close, "abandon hidden does not toggle")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    _ = machine.beginPress(now: 10.5, input: input)
    let failed = machine.finishPress(ok: false, now: 10.5, input: input)
    expect("failed press", failed, close: true)
    check(failed.commitReply == nil && machine.phase == .releasing && machine.held, "failed press holds through the close")
    check(!machine.pressed, "failed press is not a switch")
    let done = machine.tick(now: 10.6, input: .show(.hidden))
    expect("failed press then hidden", done, restore: true, commitReply: .fail("unavailable"))
    check(!done.close, "failed press hidden does not toggle")
  }

  do {
    let machine = job()
    let effects = machine.start(input: .show(.hidden))
    expect("hold without owning", effects, hold: true, open: true)
    let first = machine.tick(now: 10.3, input: input)
    expect("ready without noteOpened", first)
    let second = machine.tick(now: 10.3, input: input)
    expect("arm without noteOpened", second, switchReply: .armed("1"))
    _ = machine.commit(token: "1", now: 10.4, input: input)
    _ = machine.beginPress(now: 10.5, input: input)
    let failed = machine.finishPress(ok: false, now: 10.5, input: input)
    expect("failure without ownership", failed, restore: true, commitReply: .fail("unavailable"))
    check(!failed.close && !machine.openedByUs, "failure does not close an overview we did not open")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    let decision = machine.beginPress(now: 10.5, input: .show(.tree([desk(2, lists: [buttons(3)])])))
    check(decision == .settle(OverviewEffects(close: true)), "wrong display at press time holds: \(describe(decision))")
    check(machine.phase == .releasing && machine.held && !machine.pressed, "wrong display holds and does not press")
    let done = machine.tick(now: 10.6, input: .show(.hidden))
    expect("wrong display then hidden", done, restore: true, commitReply: .fail("unavailable"))
    check(!done.close, "wrong display hidden does not toggle")
  }

  do {
    let machine = job()
    opened(machine)
    let stopped = machine.abort(token: "1", now: 10.2, input: input)
    expect("abort visible for the confirm bound", stopped, close: true, aborted: true)
    let stuck = machine.tick(now: 11.2, input: input)
    expect("close still visible at the confirm bound", stuck)
    check(!stuck.restore && !stuck.close && machine.held && machine.phase == .releasing, "the bound does not resume while the overview is visible")
    let unknown = machine.tick(now: 11.3, input: .unreadable)
    expect("close then unknown past the bound", unknown)
    check(!unknown.restore && !unknown.close && machine.held, "unknown past the bound does not resume or toggle")
    let done = machine.tick(now: 11.4, input: .show(.hidden))
    expect("hidden after a visible bound", done, restore: true, switchReply: .fail("stale"))
    check(!done.close && !machine.held, "only the hidden read releases input")
  }

  do {
    let machine = job()
    opened(machine)
    let stop = machine.shutdown(now: 10.4, input: input)
    expect("shutdown while visible closes once", stop, close: true)
    check(stop.switchReply == nil && !stop.restore && machine.held && !machine.openedByUs && machine.phase == .releasing, "shutdown clears ownership and keeps the hold")
    let again = machine.tick(now: 10.5, input: input)
    expect("visible after shutdown does not toggle", again)
    check(!again.close && !again.restore && machine.held, "cleared ownership does not close again")
    let unknown = machine.tick(now: 10.6, input: .unreadable)
    expect("unknown after shutdown does not toggle", unknown)
    check(!unknown.close && !unknown.restore, "unknown stays fail closed")
    let done = machine.tick(now: 10.7, input: .show(.hidden))
    expect("hidden after shutdown recovers input", done, restore: true, switchReply: .fail("unavailable"))
    check(!done.close && !machine.held && !machine.openedByUs, "recovery does not toggle")
  }

  do {
    let machine = job()
    opened(machine)
    let stop = machine.shutdown(now: 10.4, input: .unreadable)
    expect("shutdown while unknown", stop)
    check(!stop.close && !stop.restore && machine.held && !machine.openedByUs, "unknown shutdown does not toggle or resume")
    let seen = machine.tick(now: 10.5, input: .show(.stub))
    expect("later visible is not ours", seen)
    check(!seen.close && !seen.restore && machine.held, "cleared ownership does not close a later overview")
    let ambiguous = machine.shutdown(now: 10.6, input: .ambiguousHost)
    expect("second shutdown while ambiguous", ambiguous)
    check(!ambiguous.close && !ambiguous.restore && machine.phase == .releasing && machine.held, "a second shutdown does not toggle or resume")
    let done = machine.tick(now: 10.7, input: .show(.hidden))
    expect("hidden recovers after unknown shutdown", done, restore: true, switchReply: .fail("unavailable"))
    check(!done.close && !machine.held, "hidden recovery does not toggle")
  }

  do {
    let machine = job()
    opened(machine)
    let stop = machine.shutdown(now: 10.4, input: .show(.hidden))
    expect("shutdown while hidden recovers", stop, restore: true, switchReply: .fail("unavailable"))
    check(!stop.close && !machine.held && !machine.openedByUs && machine.phase == .settled, "a hidden shutdown settles without a toggle")
    expect("shutdown after settle", machine.shutdown(now: 10.5, input: input))
    check(machine.phase == .settled && !machine.openedByUs, "a settled shutdown does not reopen")
  }

  do {
    let machine = job()
    let started = machine.start(input: .show(.hidden))
    expect("start for shutdown without ownership", started, hold: true, open: true)
    let stop = machine.shutdown(now: 10.2, input: input)
    expect("shutdown without ownership while visible", stop)
    check(!stop.close && !stop.restore && machine.held && !machine.openedByUs, "an overview we did not open is not closed, and input stays held")
    let done = machine.tick(now: 10.3, input: .show(.hidden))
    expect("hidden recovers an unowned hold", done, restore: true, switchReply: .fail("unavailable"))
    check(!done.close && !machine.held, "unowned recovery does not toggle")
  }

  do {
    let machine = job()
    arm(machine, input)
    let stop = machine.shutdown(now: 10.4, input: input)
    expect("shutdown while armed and visible", stop, close: true)
    check(stop.switchReply == nil && stop.commitReply == nil && !stop.restore && !machine.openedByUs && machine.held, "an armed shutdown does not resume or reply twice")
    let late = machine.commit(token: "1", now: 10.5, input: input)
    expect("commit after shutdown", late, commitReply: .fail("unavailable"))
    check(machine.phase == .releasing && machine.held && !machine.pressed, "a late commit does not press or resume")
    let decision = machine.beginPress(now: 10.5, input: input)
    check(decision == .settle(OverviewEffects()), "shutdown cannot press: \(describe(decision))")
    let done = machine.tick(now: 10.6, input: .show(.hidden))
    expect("hidden after armed shutdown", done, restore: true)
    check(done.switchReply == nil && done.commitReply == nil && !done.close, "the commit reply was the late commit")
  }

  do {
    let machine = job()
    arm(machine, input)
    let accepted = machine.commit(token: "1", now: 10.4, input: input)
    expect("commit before shutdown", accepted)
    let stop = machine.shutdown(now: 10.45, input: input)
    expect("shutdown while committing and visible", stop, close: true)
    check(stop.commitReply == nil && !stop.restore && machine.held && !machine.pressed && !machine.openedByUs, "the in-flight commit stays open and input stays held")
    let decision = machine.beginPress(now: 10.5, input: input)
    check(decision == .settle(OverviewEffects()), "shutdown does not press: \(describe(decision))")
    let done = machine.tick(now: 10.6, input: .show(.hidden))
    expect("hidden answers the in-flight commit", done, restore: true, commitReply: .fail("unavailable"))
    check(!done.close && !machine.held, "recovery does not toggle")
  }

  do {
    let machine = job()
    arm(machine, input)
    let stop = machine.shutdown(now: 10.4, input: .show(.hidden))
    expect("shutdown while armed and hidden", stop, restore: true)
    check(!stop.close && stop.switchReply == nil && stop.commitReply == nil && !machine.held && machine.phase == .settled, "hidden armed shutdown settles without another switch reply")
    let late = machine.commit(token: "1", now: 10.5, input: .show(.hidden))
    expect("commit after hidden shutdown", late, commitReply: .fail("unavailable"))
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    _ = machine.beginPress(now: 10.5, input: input)
    _ = machine.finishPress(ok: true, now: 10.5, input: input)
    let stop = machine.shutdown(now: 10.6, input: input, move: .confirmed)
    expect("shutdown after press while visible", stop)
    check(!stop.close && !stop.restore && machine.held && !machine.openedByUs && machine.pressed && stop.commitReply == nil, "a press is not toggled closed")
    let again = machine.tick(now: 10.7, input: .show(.stub), move: .confirmed)
    expect("still visible after press shutdown", again)
    check(!again.close && !again.restore && machine.held, "a later visible read does not toggle a press")
    let done = machine.tick(now: 10.8, input: .show(.hidden), move: .confirmed)
    expect("hidden after shutdown still confirms the press", done, restore: true, commitReply: .ok)
    check(!done.close && !machine.held, "recovery does not toggle")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    _ = machine.beginPress(now: 10.5, input: input)
    _ = machine.finishPress(ok: true, now: 10.5, input: input)
    let stop = machine.shutdown(now: 10.6, input: .unreadable, move: .confirmed)
    expect("shutdown after press while unknown", stop)
    check(!stop.close && !stop.restore && machine.held && !machine.openedByUs, "unknown after a press does not toggle or resume")
    let done = machine.shutdown(now: 10.7, input: .show(.hidden), move: .confirmed)
    expect("later hidden shutdown confirms the press", done, restore: true, commitReply: .ok)
    check(!done.close, "hidden shutdown does not toggle a press")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    _ = machine.beginPress(now: 10.5, input: input)
    _ = machine.finishPress(ok: true, now: 10.5, input: input)
    let stop = machine.shutdown(now: 10.6, input: .show(.hidden), move: .pending)
    expect("shutdown hidden before the space list moves", stop)
    check(!stop.restore && !stop.close && machine.held && machine.phase == .releasing && stop.commitReply == nil, "shutdown does not fail a hidden press before the bound")
    let done = machine.tick(now: 11.5, input: .show(.hidden), move: .pending)
    expect("bound after shutdown without a move", done, restore: true, commitReply: .fail("unavailable"))
    check(!done.close && !machine.held, "the hidden bound releases input")
  }

  do {
    let machine = job()
    arm(machine, input)
    _ = machine.commit(token: "1", now: 10.4, input: input)
    _ = machine.beginPress(now: 10.5, input: input)
    _ = machine.finishPress(ok: true, now: 10.5, input: input)
    let stop = machine.shutdown(now: 10.6, input: .show(.hidden), move: .refused("spans"))
    expect("shutdown hidden after drift", stop, restore: true, commitReply: .fail("spans"))
    check(!stop.close && !machine.held && machine.phase == .settled, "a hidden drifted shutdown settles without a toggle")
  }

  do {
    let machine = job()
    opened(machine)
    let unread = machine.tick(now: 12, input: .unreadable)
    expect("unknown at the poll deadline", unread)
    check(machine.phase == .releasing && machine.held && machine.openedByUs && !unread.close, "unknown does not toggle before shutdown")
    let stop = machine.shutdown(now: 12.1, input: .show(.stub))
    expect("shutdown sees the overview and closes once", stop, close: true)
    check(!stop.restore && !machine.openedByUs && machine.held, "that close keeps the hold and drops ownership")
    let again = machine.tick(now: 12.2, input: .show(.stub))
    expect("second visible after that shutdown", again)
    check(!again.close && !again.restore, "ownership stays cleared")
    let done = machine.tick(now: 12.3, input: .show(.hidden))
    expect("hidden after shutdown close", done, restore: true, switchReply: .fail("unavailable"))
    check(!done.close, "hidden recovery does not toggle")
  }

  do {
    let machine = job()
    opened(machine)
    _ = machine.tick(now: 12, input: .unreadable)
    let seen = machine.tick(now: 12.2, input: .show(.stub))
    expect("close before shutdown", seen, close: true)
    machine.closeMissed()
    let stop = machine.shutdown(now: 12.4, input: .show(.stub))
    expect("shutdown does not repeat a missed close", stop)
    check(!stop.close && !stop.restore && machine.held && !machine.openedByUs, "a missed close stays missed and input stays held")
    let retry = machine.tick(now: 12.5, input: .show(.stub))
    expect("visible after a missed close and shutdown", retry)
    check(!retry.close && !retry.restore, "shutdown does not give the close another try")
    let done = machine.tick(now: 12.6, input: .show(.hidden))
    expect("hidden recovers a missed close", done, restore: true, switchReply: .fail("unavailable"))
    check(!done.close, "recovery does not toggle")
  }

  do {
    let idle = job()
    expect("abort idle", idle.abort(token: "1", now: 10, input: .show(.hidden)))
    check(idle.phase == .idle, "idle abort stays idle")
    expect("shutdown idle", idle.shutdown(now: 10, input: .unreadable))
    check(idle.phase == .idle && !idle.openedByUs, "idle shutdown stays idle and does not toggle")
  }

  // JS disconnect sends spacesAbort. An unreadable timeout is already releasing and
  // still owns the overview; abort must drop that ownership. The user can then close
  // and reopen Mission Control, and a later visible tick must not close theirs.
  do {
    let machine = job()
    opened(machine)
    let unread = machine.tick(now: 12, input: .unreadable)
    expect("unknown timeout before disconnect", unread)
    check(machine.phase == .releasing && machine.held && machine.openedByUs && !unread.close, "unknown timeout does not toggle")
    let stopped = machine.abort(token: "1", now: 12.1, input: .unreadable)
    expect("disconnect abort while releasing and unknown", stopped, aborted: true)
    check(!stopped.close && !stopped.restore && machine.held && !machine.openedByUs && machine.phase == .releasing, "abort clears ownership and keeps the hold")
    let theirs = machine.tick(now: 12.2, input: .show(.stub))
    expect("user reopened overview after abort", theirs)
    check(!theirs.close && !theirs.restore && machine.held && !machine.openedByUs, "a later visible tick does not close the user's overview")
    let unknown = machine.tick(now: 12.3, input: .unreadable)
    expect("unknown after ownership lost", unknown)
    check(!unknown.close && !unknown.restore && machine.held, "unknown after abort does not toggle or resume")
    let ambiguous = machine.tick(now: 12.35, input: .ambiguousHost)
    expect("ambiguous after ownership lost", ambiguous)
    check(!ambiguous.close && !ambiguous.restore && machine.held, "ambiguous after abort does not toggle or resume")
    let done = machine.tick(now: 12.4, input: .show(.hidden))
    expect("hidden after disconnect abort", done, restore: true, switchReply: .fail("stale"))
    check(!done.close && !machine.held && !machine.openedByUs, "only the fresh hidden read releases input")
  }

  do {
    let machine = job()
    opened(machine)
    _ = machine.tick(now: 12, input: .unreadable)
    let stopped = machine.abort(token: "1", now: 12.1, input: .ambiguousHost)
    expect("disconnect abort while ambiguous", stopped, aborted: true)
    check(!stopped.close && !stopped.restore && machine.held && !machine.openedByUs, "ambiguous abort does not toggle or resume")
    let theirs = machine.tick(now: 12.2, input: .show(.stub))
    expect("visible after an ambiguous abort", theirs)
    check(!theirs.close && !theirs.restore && machine.held, "ownership lost on an ambiguous abort is not a later close")
    let done = machine.tick(now: 12.3, input: .show(.hidden))
    expect("hidden after an ambiguous abort", done, restore: true, switchReply: .fail("stale"))
    check(!done.close && !machine.held, "hidden recovery does not toggle")
  }

  do {
    let machine = job()
    opened(machine)
    _ = machine.tick(now: 12, input: .unreadable)
    let stopped = machine.abort(token: "1", now: 12.1, input: .show(.stub))
    expect("abort still sees the overview we opened", stopped, close: true, aborted: true)
    check(!stopped.restore && !machine.openedByUs && machine.held && machine.phase == .releasing, "that close keeps the hold and drops ownership")
    let theirs = machine.tick(now: 12.2, input: .show(.stub))
    expect("user overview after the abort close", theirs)
    check(!theirs.close && !theirs.restore && machine.held && !machine.openedByUs, "a second visible read is not ours")
    let done = machine.tick(now: 12.3, input: .show(.hidden))
    expect("hidden after the abort close", done, restore: true, switchReply: .fail("stale"))
    check(!done.close && !machine.held, "hidden recovery does not toggle")
  }

  do {
    let machine = job()
    opened(machine)
    _ = machine.tick(now: 12, input: .unreadable)
    let stopped = machine.abort(token: "1", now: 12.1, input: .show(.hidden))
    expect("abort while the overview is already hidden", stopped, restore: true, aborted: true, switchReply: .fail("stale"))
    check(!stopped.close && !machine.held && !machine.openedByUs && machine.phase == .settled, "a fresh hidden read settles without a toggle")
    let theirs = machine.tick(now: 12.2, input: .show(.stub))
    expect("settled abort ignores a later overview", theirs)
    check(machine.phase == .settled && !machine.openedByUs && !theirs.close, "a settled abort does not close a later overview")
  }

  do {
    let machine = job()
    opened(machine)
    let stopped = machine.abort(token: "1", now: 10.2, input: .unreadable)
    expect("abort while polling an unknown tree", stopped, aborted: true)
    check(!stopped.close && !stopped.restore && machine.held && !machine.openedByUs && machine.phase == .releasing, "an unknown abort does not toggle and does not keep ownership")
    let theirs = machine.tick(now: 10.3, input: .show(.stub))
    expect("visible after an unknown poll abort", theirs)
    check(!theirs.close && !theirs.restore && machine.held, "losing ownership during polling does not close a later overview")
    let done = machine.tick(now: 10.4, input: .show(.hidden))
    expect("hidden after an unknown poll abort", done, restore: true, switchReply: .fail("stale"))
    check(!done.close && !machine.held, "hidden recovery does not toggle")
  }
}

func rootTests() {
  check(IdentifierRead.interpret(.cannotComplete, text: nil) == .unreadable, "cannotComplete is unreadable")
  check(IdentifierRead.interpret(.invalidElement, text: nil) == .unreadable, "invalidUIElement is unreadable")
  check(IdentifierRead.interpret(.failed, text: "mc") == .unreadable, "a failed read is not its text")
  check(IdentifierRead.interpret(.noValue, text: nil) == .absent, "no value is absent")
  check(IdentifierRead.interpret(.unsupported, text: nil) == .absent, "an unsupported identifier is absent")
  check(IdentifierRead.interpret(.success, text: "mc") == .text("mc"), "a read identifier is kept")
  check(IdentifierRead.interpret(.success, text: "") == .absent, "an empty identifier is absent")
  check(IdentifierRead.interpret(.success, text: nil) == .absent, "success with no string is absent")

  check(RootChildren.indexes([.unreadable], equalTo: "mc") == nil, "cannotComplete on a Dock child is not an empty root")
  check(RootChildren.indexes([.unreadable], equalTo: "mc.display") == nil, "invalidUIElement on a WindowManager child is not hidden")
  check(RootChildren.indexes([.text("mc"), .unreadable], equalTo: "mc") == nil, "an unreadable sibling is not dropped")
  check(RootChildren.indexes([.text("mc.display"), .unreadable], equalTo: "mc.display") == nil, "a visible display beside an unreadable child stays unreadable")
  check(RootChildren.indexes([.absent, .text("other")], equalTo: "mc") == [], "readable roots with no mc can be hidden")
  check(RootChildren.indexes([.text("mc"), .text("dock")], equalTo: "mc") == [0], "the mc group is kept")
  check(RootChildren.indexes([.text("mc"), .text("mc")], equalTo: "mc") == [0, 1], "two mc groups stay visible to the ambiguous check")

  // Collapsing the error to absent is the old bug: classify then says hidden, and input resumes.
  check(RootChildren.indexes([.absent], equalTo: "mc") == [], "absent is an empty match")
  check(MissionControlPlan.classify(host()) == .show(.hidden), "empty roots are hidden")
  check(InputRecovery.allowRestore(phase: .releasing, input: .show(.hidden)), "a hidden read may restore")
  check(!InputRecovery.allowRestore(phase: nil, input: .unreadable), "an unreadable root does not restore with no attempt")
  check(!InputRecovery.allowRestore(phase: .releasing, input: .unreadable), "an unreadable root does not restore while releasing")
  check(!InputRecovery.allowRestore(phase: .settled, input: .unreadable), "an unreadable root does not restore after settle")
}

func overviewTests() {
  check(OverviewReport.token(.show(.hidden)) == "hidden", "only a hidden show is hidden")
  check(OverviewReport.token(.unreadable) == "unknown", "an unreadable tree fails closed")
  check(OverviewReport.token(.ambiguousHost) == "unknown", "an ambiguous host fails closed")
  check(OverviewReport.token(.show(.stub)) == "visible", "a Dock stub is visible")
  let tree = MCDisplay(displayID: 1, spaceGroups: 1, lists: [[true]])
  check(OverviewReport.token(.show(.tree([tree]))) == "visible", "a desktop tree is visible")
}

func recoveryTests() {
  check(InputRecovery.allowRestore(phase: nil, input: .show(.hidden)), "no machine and hidden may restore")
  check(InputRecovery.allowRestore(phase: .settled, input: .show(.hidden)), "settled and hidden may restore")
  check(InputRecovery.allowRestore(phase: .releasing, input: .show(.hidden)), "releasing and hidden may restore")
  check(!InputRecovery.allowRestore(phase: .idle, input: .show(.hidden)), "idle does not restore")
  check(!InputRecovery.allowRestore(phase: .polling, input: .show(.hidden)), "polling does not restore")
  check(!InputRecovery.allowRestore(phase: .armed, input: .show(.hidden)), "armed does not restore")
  check(!InputRecovery.allowRestore(phase: .committing, input: .show(.hidden)), "committing does not restore")
  let phases: [OverviewPhase?] = [nil, .idle, .polling, .armed, .committing, .releasing, .settled]
  for phase in phases {
    check(!InputRecovery.allowRestore(phase: phase, input: .unreadable), "unreadable does not restore")
    check(!InputRecovery.allowRestore(phase: phase, input: .ambiguousHost), "ambiguous does not restore")
    check(!InputRecovery.allowRestore(phase: phase, input: .show(.stub)), "a visible stub does not restore")
    check(!InputRecovery.allowRestore(phase: phase, input: readyPair()), "a visible tree does not restore")
  }

  do {
    let machine = job()
    opened(machine)
    let missed = machine.tick(now: 12, input: .unreadable)
    expect("unknown before recover", missed)
    check(machine.phase == .releasing && machine.held && !missed.close, "unknown timeout does not toggle before recover")
    let recovered = machine.recover(now: 12.2, input: .show(.hidden), move: .pending)
    expect("recover while releasing and hidden", recovered, restore: true, switchReply: .fail("unavailable"))
    check(!recovered.close && !recovered.open && !machine.pressed && !machine.held && machine.phase == .settled, "hidden recover does not press or toggle")
  }

  do {
    let machine = job()
    opened(machine)
    let recovered = machine.recover(now: 10.1, input: .show(.hidden), move: .pending)
    expect("recover while polling and hidden", recovered)
    check(!recovered.close && !recovered.restore && !recovered.open && machine.phase == .polling && machine.held, "polling hidden does not restore or close")
  }

  do {
    let machine = job()
    opened(machine)
    _ = machine.tick(now: 12, input: .unreadable)
    let recovered = machine.recover(now: 12.2, input: .unreadable, move: .pending)
    expect("recover while releasing and unreadable", recovered)
    check(!recovered.close && !recovered.restore && machine.phase == .releasing && machine.held, "unreadable recover does not restore or close")
    let visible = machine.recover(now: 12.3, input: .show(.stub), move: .pending)
    expect("recover does not close a visible overview", visible)
    check(!visible.close && !visible.restore && machine.openedByUs && machine.phase == .releasing && machine.held, "visible recover is not a toggle")
  }

  do {
    let machine = job()
    let pair = readyPair()
    arm(machine, pair)
    _ = machine.commit(token: "1", now: 10.4, input: pair)
    _ = machine.beginPress(now: 10.5, input: pair)
    _ = machine.finishPress(ok: true, now: 10.5, input: pair)
    let recovered = machine.recover(now: 10.6, input: .show(.hidden), move: .pending)
    expect("recover after press before the move", recovered)
    check(!recovered.restore && !recovered.close && !recovered.open && machine.pressed && machine.held && machine.phase == .releasing, "a hidden press still waits for the destination")
  }
}

@main
struct SpacesAXTest {
  static func main() {
    classifyTests()
    planTests()
    compositionTests()
    moveTests()
    rootTests()
    machineTests()
    recoveryTests()
    overviewTests()
    if failures != 0 {
      FileHandle.standardError.write(Data("spaces-ax-test: \(failures) failed\n".utf8))
      exit(1)
    }
    print("spaces-ax-test: classify, plan, composition, postcheck, root identifiers, overview machine, input recovery, and the preview overview word. No AX, no SkyLight, no notification. Not a live desktop switch.")
  }
}
