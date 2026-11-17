// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mission Control desktop switch for one display. SpacesAX decides; this file only
// reads the accessibility tree, calls CoreDockSendNotification, and AXPresses one
// button. It does not call a SkyLight setter, post a key, or synthesize a click.
//
// The open is Hammerspoon's Mission Control toggle: CoreDockSendNotification
// ("com.apple.expose.awake", 0) from ApplicationServices. That is not a
// distributed notification, and a missing symbol or a non-zero result does not
// post one instead. The call happens only when a second read, after remote input
// is held, still says the overview is hidden. A later read that shows it, and only
// if we opened it, calls it again to close. Tests do not construct this type.
//
// Work is scheduled on the main queue. `spacesSwitch` returns when the tree has
// matched twice, after readyDelay, and has not pressed. `spacesCommit` schedules
// the press on the next main-queue turn, so a `spacesAbort` already queued runs
// first and beginPress sees the cancel. Polling uses asyncAfter, not a busy wait,
// so the overview can finish drawing and stdin can deliver the abort.
//
// Lifetime: the tree must settle within 2s, the armed reply is waited on for 1s,
// and the commit may press only within 0.5s. After AXPress, or after the close
// call, remote input stays held until a fresh read says the overview is hidden.
// For a press, that read must also show the destination desktop current and every
// other display unchanged. The 1.5s bound only fails a press whose overview is
// already hidden when that desktop check has not arrived. A visible overview, or
// a read that is unreadable or ambiguous, does not resume input and does not
// toggle. AXPress runs only after MacSpaces.destination (a read of the managed-space
// list) still names that index. Helper shutdown, and spacesAbort once release has
// started, clear ownership: one close when a fresh read shows an overview this
// attempt opened and has not pressed, never a toggle on an unknown read or after
// ownership was cleared, and the hold remains until a hidden read.
//
// spacesLook may call recoverHidden. That resumes remote input only on a fresh
// hidden read, and only when no attempt is polling, armed, or committing. It
// does not open Mission Control, press a thumbnail, or post the Dock notification.
// An unknown or ambiguous read keeps the hold until a later hidden read. There
// is no other resume.
//
// One attempt at a time. A second spacesSwitch while this one is polling, armed,
// committing, or still holding for the close is refused and does not abort, close,
// or press the attempt already running.
//
// Limitations:
// - screen.state spaces is true only when the viewed display has its own other desktop
//   and MacSpaces.look says composed. A window still visible from another desktop keeps
//   it false, and destination refuses before this file opens Mission Control.
// - Accessibility must already be granted. This does not prompt.
// - An unreadable tree never toggles. A read that fails after we opened the overview
//   does not close it, because the user may already have closed it.
// - A successful AXPress is not followed by a toggle. Success waits until the
//   destination is current, other displays are unchanged, and the overview is hidden.
// - Button order is the managed-space order. Titles are not read. A reorder that
//   keeps the same count can press the wrong thumbnail; a different count refuses.
// - The overview is visible while it runs. Reduce Motion is left as the user set it.
// - Displays that share a space, and spans-displays with more than one display, are
//   refused before anything is opened.
import Cocoa

final class SpaceOverview {
  static let shared = SpaceOverview()

  private let pollS = 0.05
  private let limitS = 2.0
  private let readyDelayS = 0.3
  private let armWindowS = 1.0
  private let commitWindowS = 0.5
  private let confirmWindowS = 1.5

  private var machine: OverviewMachine?
  private var switchId: Any?
  private var commitId: Any?
  private var timer: DispatchWorkItem?
  private var displayId: UInt32 = 0
  private var spaceId: UInt64 = 0
  private var index = 0
  private var count = 0
  private var baseline: [DisplayCurrent] = []

  func begin(id: Any?, displayId: UInt32, spaceId: UInt64, index: Int, count: Int, token: String) {
    if machine?.needsTick == true {
      replyError(id, "unavailable")
      return
    }
    machine = nil
    guard tokenOK(token) else { replyError(id, "unavailable"); return }
    guard MissionControlAccess.canToggle else { replyError(id, "unavailable"); return }
    if let why = MacSpaces.destination(displayId: displayId, spaceId: spaceId, index: index, count: count) {
      replyError(id, why)
      return
    }
    guard let before = MacSpaces.currents(), SpaceMoveCheck.baseline(before, displayId: displayId, spaceId: spaceId) else {
      replyError(id, "unavailable")
      return
    }
    let now = ProcessInfo.processInfo.systemUptime
    let job = OverviewMachine(token: token, displayId: displayId, spaceIndex: index, spaceCount: count,
                              started: now, deadline: now + limitS, readyDelay: readyDelayS,
                              armWindow: armWindowS, commitWindow: commitWindowS, confirmWindow: confirmWindowS)
    machine = job
    switchId = id
    self.displayId = displayId
    self.spaceId = spaceId
    self.index = index
    self.count = count
    baseline = before
    let effects = job.start(input: MissionControlAccess.snapshot())
    guard effects.open else { apply(effects); return }
    injector.holdRemoteForOverview()
    let again = MissionControlAccess.snapshot()
    if case .show(.hidden) = again {
      if MissionControlAccess.toggle() {
        job.noteOpened()
        if job.needsTick { schedule(after: pollS) }
        return
      }
      var missed = job.cancelOpen(why: "unavailable")
      missed.hold = false
      apply(missed)
      return
    }
    // It was hidden, then it was not. We did not post the notification.
    let why = MissionControlAccess.clearlyVisible(again) ? "overview" : "unavailable"
    var undo = job.cancelOpen(why: why)
    undo.hold = false
    apply(undo)
  }

  func commit(id: Any?, token: String) {
    guard let machine else { replyError(id, "stale"); return }
    if machine.phase == .releasing {
      let effects = machine.commit(token: token, now: ProcessInfo.processInfo.systemUptime, input: MissionControlAccess.snapshot())
      replyCommit(id, effects.commitReply)
      return
    }
    commitId = id
    let effects = machine.commit(token: token, now: ProcessInfo.processInfo.systemUptime, input: MissionControlAccess.snapshot())
    apply(effects)
    if machine.phase == .releasing { schedule(after: pollS) }
    guard machine.phase == .committing else { return }
    DispatchQueue.main.async { [weak self] in self?.pressTurn() }
  }

  /// Stdin closed, or the helper is otherwise leaving the attempt behind. Clears
  /// ownership. Does not resume remote input unless this read is a fresh hidden
  /// confirmation, and does not toggle unless this read shows an overview we opened.
  func shutdown() {
    guard let machine else { return }
    let move = machine.needsMoveCheck
      ? SpaceMoveCheck.judge(before: baseline, after: MacSpaces.currents(), displayId: displayId, spaceId: spaceId)
      : SpaceMove.pending
    let effects = machine.shutdown(now: ProcessInfo.processInfo.systemUptime, input: MissionControlAccess.snapshot(), move: move)
    apply(effects)
    if machine.needsTick { schedule(after: pollS) }
  }

  /// A fresh hidden read may clear the remote-input hold. It does not open
  /// Mission Control, press a thumbnail, or post the Dock notification.
  /// Unknown, ambiguous, and visible reads leave the hold. Polling, armed, and
  /// committing leave it too, so a touch is not sent while the overview may
  /// still be drawing. A press that has not confirmed its destination keeps
  /// the hold. If no attempt remains, a hidden read only clears the flag.
  func recoverHidden() {
    guard injector.remoteOverview else { return }
    let input = MissionControlAccess.snapshot()
    let phase = machine?.phase
    guard InputRecovery.allowRestore(phase: phase, input: input) else { return }
    if let machine, machine.phase == .releasing {
      let move = machine.needsMoveCheck
        ? SpaceMoveCheck.judge(before: baseline, after: MacSpaces.currents(), displayId: displayId, spaceId: spaceId)
        : SpaceMove.pending
      apply(machine.recover(now: ProcessInfo.processInfo.systemUptime, input: input, move: move))
      if machine.needsTick { schedule(after: pollS) }
      return
    }
    injector.restoreRemoteAfterOverview()
  }

  func abort(id: Any?, token: String) {
    guard let machine else {
      reply(id, ["aborted": false, "beforePress": true])
      return
    }
    let effects = machine.abort(token: token, now: ProcessInfo.processInfo.systemUptime, input: MissionControlAccess.snapshot())
    apply(effects)
    if machine.needsTick { schedule(after: pollS) }
    reply(id, ["aborted": effects.aborted, "beforePress": effects.aborted])
  }

  private func pressTurn() {
    guard let machine, machine.phase == .committing else { return }
    let input = MissionControlAccess.snapshot()
    let now = ProcessInfo.processInfo.systemUptime
    switch machine.beginPress(now: now, input: input) {
    case .settle(let effects):
      apply(effects)
      if machine.needsTick { schedule(after: pollS) }
    case .fire(let index):
      if MacSpaces.destination(displayId: displayId, spaceId: spaceId, index: self.index, count: count) != nil || index != self.index {
        apply(machine.abandonPress(now: now, input: MissionControlAccess.snapshot()))
        if machine.needsTick { schedule(after: pollS) }
        return
      }
      log("spaces: ax-press \(displayId) \(index)")
      let ok = MissionControlAccess.press(displayId: displayId, index: index, count: count)
      apply(machine.finishPress(ok: ok, now: now, input: MissionControlAccess.snapshot()))
      if machine.needsTick { schedule(after: pollS) }
    }
  }

  private func onTick() {
    guard let machine, machine.needsTick else { return }
    let move = machine.needsMoveCheck
      ? SpaceMoveCheck.judge(before: baseline, after: MacSpaces.currents(), displayId: displayId, spaceId: spaceId)
      : SpaceMove.pending
    let effects = machine.tick(now: ProcessInfo.processInfo.systemUptime, input: MissionControlAccess.snapshot(), move: move)
    apply(effects)
    if machine.needsTick { schedule(after: pollS) }
  }

  private func schedule(after seconds: Double) {
    timer?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.onTick() }
    timer = work
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
  }

  private func apply(_ effects: OverviewEffects) {
    if effects.hold { injector.holdRemoteForOverview() }
    // Close while remote input is still dropped. Restore waits for a fresh hidden
    // read, so a click cannot land on a thumbnail that is still leaving. The confirm
    // bound is not that read, and an unknown tree is not a reason to toggle.
    if effects.close && !MissionControlAccess.toggle() { machine?.closeMissed() }
    if effects.restore { injector.restoreRemoteAfterOverview() }
    if let replyValue = effects.switchReply, let id = switchId {
      switch replyValue {
      case .armed(let token): reply(id, ["phase": "armed", "token": token])
      case .fail(let why):
        log("spaces: \(why)")
        replyError(id, why)
      case .ok:
        break
      }
      switchId = nil
    }
    if let replyValue = effects.commitReply, let id = commitId {
      replyCommit(id, replyValue)
      commitId = nil
    }
    if machine?.phase == .settled {
      timer?.cancel()
      timer = nil
      machine = nil
      baseline = []
    }
  }

  private func replyCommit(_ id: Any?, _ replyValue: OverviewReply?) {
    switch replyValue {
    case .ok: reply(id, ["switched": true])
    case .fail(let why):
      log("spaces: \(why)")
      replyError(id, why)
    case .armed, nil:
      break
    }
  }

  private func tokenOK(_ token: String) -> Bool {
    token.count >= 1 && token.count <= 64 && token.allSatisfy { $0.isNumber || $0.isLetter || $0 == "-" }
  }
}

enum MissionControlAccess {
  /// An unreadable or ambiguous host is not "the overview is up".
  static func clearlyVisible(_ input: PollInput) -> Bool {
    switch input {
    case .ambiguousHost, .show(.hidden), .unreadable: return false
    case .show: return true
    }
  }

  private typealias DockNotify = @convention(c) (CFString, Int32) -> Int32

  /// Hammerspoon `hs.spaces._coreDesktopNotification` resolves this in
  /// ApplicationServices and calls it with the name and 0. dlsym on this Mac finds
  /// that symbol there (and in HIServices); it is absent from SkyLight. A distributed
  /// notification of the same name is a different mechanism and is not used.
  private static let dockNotify: DockNotify? = {
    let path = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    guard let handle = dlopen(path, RTLD_LAZY) else { return nil }
    guard let symbol = dlsym(handle, "CoreDockSendNotification") else { return nil }
    return unsafeBitCast(symbol, to: DockNotify.self)
  }()

  static var canToggle: Bool { dockNotify != nil }

  /// CGError.success is 0. Any other result, or no symbol, fails closed.
  static func toggle() -> Bool {
    guard let dockNotify else { return false }
    return dockNotify("com.apple.expose.awake" as CFString, 0) == 0
  }

  static func snapshot() -> PollInput {
    guard AXIsProcessTrusted() else { return .unreadable }
    let docks = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock")
    let managers = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.WindowManager")
    if docks.count > 1 || managers.count > 1 { return .ambiguousHost }
    let dockChildren = childrenOf(docks.first)
    let managerChildren = childrenOf(managers.first)
    guard let dockChildren, let managerChildren else { return .unreadable }
    // An identifier that cannot be read is not "not mc". Treating the error as nil
    // drops a visible overview and the next hidden check resumes input.
    guard let dockMC = RootChildren.indexes(dockChildren.map { axIdentifier($0) }, equalTo: "mc") else { return .unreadable }
    if dockMC.count > 1 { return .ambiguousHost }
    let dockGroups = dockMC.map { dockChildren[$0] }
    let dockDisplays: [MCDisplay]
    if let group = dockGroups.first {
      guard let displays = readDisplays(group) else { return .unreadable }
      dockDisplays = displays
    } else {
      dockDisplays = []
    }
    guard let windowDisplays = readDisplays(of: managerChildren) else { return .unreadable }
    return MissionControlPlan.classify(HostSnapshot(
      dockCount: docks.count, windowManagerCount: managers.count, dockMCCount: dockGroups.count,
      dockHasMC: dockGroups.count == 1, dockDisplays: dockDisplays, windowDisplays: windowDisplays))
  }

  /// Fresh walk. AXPress only when one display has that id and its only list has `count` buttons.
  static func press(displayId: UInt32, index: Int, count: Int) -> Bool {
    guard index >= 0, count > index, AXIsProcessTrusted() else { return false }
    guard case .show(.tree(let displays)) = snapshot() else { return false }
    guard MissionControlPlan.plan(show: .tree(displays), displayId: displayId, spaceIndex: index, spaceCount: count) == .ready(index) else { return false }
    guard let button = button(displayId: displayId, index: index, count: count) else { return false }
    return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
  }

  /// nil only when the process is running and its children cannot be read. No process is an empty list.
  private static func childrenOf(_ running: NSRunningApplication?) -> [AXUIElement]? {
    guard let running else { return [] }
    return axChildren(app(running))
  }

  private static func app(_ running: NSRunningApplication) -> AXUIElement {
    let element = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 0.25)
    return element
  }

  private static func button(displayId: UInt32, index: Int, count: Int) -> AXUIElement? {
    let docks = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock")
    let managers = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.WindowManager")
    guard docks.count < 2, managers.count < 2 else { return nil }
    guard let dockChildren = childrenOf(docks.first), let managerChildren = childrenOf(managers.first) else { return nil }
    let groups = dockChildren.filter { axString($0, kAXIdentifierAttribute as CFString) == "mc" }
    guard groups.count < 2 else { return nil }
    let dockButtons = groups.first.flatMap { buttons(in: $0, displayId: displayId, count: count) }
    let managerButtons = buttons(inDisplays: managerChildren, displayId: displayId, count: count)
    let lists = [dockButtons, managerButtons].compactMap { $0 }
    guard lists.count == 1, let list = lists.first, list.count == count, index < list.count else { return nil }
    return list[index]
  }

  private static func buttons(in root: AXUIElement, displayId: UInt32, count: Int) -> [AXUIElement]? {
    guard let children = axChildren(root) else { return nil }
    return buttons(inDisplays: children, displayId: displayId, count: count)
  }

  private static func buttons(inDisplays children: [AXUIElement], displayId: UInt32, count: Int) -> [AXUIElement]? {
    let displays = children.filter { axString($0, kAXIdentifierAttribute as CFString) == "mc.display" }
    let mine = displays.filter { axDisplayID($0) == displayId }
    guard mine.count == 1, let display = mine.first, let kids = axChildren(display) else { return nil }
    let spaces = kids.filter { axString($0, kAXIdentifierAttribute as CFString) == "mc.spaces" }
    guard spaces.count == 1, let spaceKids = axChildren(spaces[0]) else { return nil }
    let lists = spaceKids.filter { axString($0, kAXIdentifierAttribute as CFString) == "mc.spaces.list" }
    guard lists.count == 1, let buttons = axChildren(lists[0]), buttons.count == count else { return nil }
    guard buttons.allSatisfy({ axString($0, kAXRoleAttribute as CFString) == (kAXButtonRole as String) }) else { return nil }
    return buttons
  }

  /// Nil when the element's children, or any of their identifiers, cannot be read.
  private static func readDisplays(_ root: AXUIElement) -> [MCDisplay]? {
    guard let children = axChildren(root) else { return nil }
    return readDisplays(of: children)
  }

  /// Nil when any root child's identifier cannot be read. An empty list is a real miss.
  private static func readDisplays(of children: [AXUIElement]) -> [MCDisplay]? {
    guard let indexes = RootChildren.indexes(children.map { axIdentifier($0) }, equalTo: "mc.display") else { return nil }
    return indexes.map { readDisplay(children[$0]) }
  }

  private static func readDisplay(_ display: AXUIElement) -> MCDisplay {
    let kids = axChildren(display) ?? []
    let spaces = kids.filter { axString($0, kAXIdentifierAttribute as CFString) == "mc.spaces" }
    let lists: [[Bool]] = spaces.flatMap { space -> [[Bool]] in
      let inner = axChildren(space) ?? []
      return inner.filter { axString($0, kAXIdentifierAttribute as CFString) == "mc.spaces.list" }.map { list in
        (axChildren(list) ?? []).map { axString($0, kAXRoleAttribute as CFString) == (kAXButtonRole as String) }
      }
    }
    return MCDisplay(displayID: axDisplayID(display), spaceGroups: spaces.count, lists: lists)
  }

  private static func axIdentifier(_ element: AXUIElement) -> IdentifierRead {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, kAXIdentifierAttribute as CFString, &value)
    switch err {
    case .success:
      guard let text = value as? String else { return value == nil ? .absent : .unreadable }
      return IdentifierRead.interpret(.success, text: text)
    case .noValue:
      return IdentifierRead.interpret(.noValue, text: nil)
    case .attributeUnsupported:
      return IdentifierRead.interpret(.unsupported, text: nil)
    case .cannotComplete:
      return IdentifierRead.interpret(.cannotComplete, text: nil)
    case .invalidUIElement:
      return IdentifierRead.interpret(.invalidElement, text: nil)
    default:
      return IdentifierRead.interpret(.failed, text: nil)
    }
  }

  private static func axChildren(_ element: AXUIElement) -> [AXUIElement]? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success else { return nil }
    return value as? [AXUIElement] ?? []
  }

  private static func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value as? String
  }

  private static func axDisplayID(_ element: AXUIElement) -> UInt32? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, "AXDisplayID" as CFString, &value) == .success else { return nil }
    guard let number = value as? NSNumber else { return nil }
    let id = number.uint32Value
    return id == 0 ? nil : id
  }
}
