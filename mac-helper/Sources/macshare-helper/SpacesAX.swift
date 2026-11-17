// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which Mission Control thumbnail a desktop switch may press, and the lifetime of that
// attempt. No Accessibility call, no notification, no SkyLight symbol lives here: the
// helper feeds a snapshot in and performs only the effects this machine returns.
// mac-helper/dev/spaces-ax-test.swift drives it. Nothing here runs on a timer.
//
// macOS 27 (Hammerspoon hs.spaces, issue 3897 / PR 3904): the Dock's `mc` group is an
// empty stub while Mission Control is up. The real groups are direct children of
// WindowManager (com.apple.WindowManager): mc.display (AXDisplayID) → mc.spaces →
// mc.spaces.list → one AXButton per desktop, in the same order as the managed-space
// list. A press is AXPress on that button. Mission Control ignores a synthesized click.
//
// Fail closed. A missing id, a short list, or a tree still building is incomplete and
// may be polled. Two hosts, two displays with one id, two lists, or more buttons than
// desktops is ambiguous and stops at once. The button is the exact index, never a title.
//
// Mission Control is opened only after a read says it is hidden, and only the runner
// that sees `open` does that. It is closed only when this attempt opened it and the
// current read, not a cached one, still shows it. An unreadable tree is not that.
// A successful press does not toggle: the press dismisses the overview, and a second
// toggle would open it again.
//
// Closing is asynchronous. After AXPress, or after the close notification, remote
// input stays held until a fresh read says the overview is hidden. A cached "visible"
// is not a reason to toggle, and an unreadable or ambiguous read is not a hidden
// confirmation. confirmWindow does not end that hold. It only fails a press whose
// overview is already hidden when the destination desktop has not become current.
// A visible overview, or an unknown read, keeps the hold and does not toggle.
// Success is that hidden read plus a space check: the destination desktop is
// current, and every other display is still on the desktop it was on when this
// attempt started. Helper shutdown, a dropped connection, and spacesAbort once
// release has started all clear ownership. A fresh visible read may close once,
// when this attempt still owns the overview and has not pressed. An unknown read
// never toggles, and neither does a read after ownership was cleared. Input stays
// held until a fresh hidden read.
//
// A later look may resume that hold only through InputRecovery. Hidden, and only
// while no attempt is opening or pressing, may restore. Polling, armed, and
// committing stay held, because Mission Control may still be drawing. An
// unreadable or ambiguous read never resumes input and never toggles. That
// recovery does not open, close, or press.
//
// Not confirmed on a live desktop. screen.state keeps spaces false until someone sees
// the viewed display change. Reordering desktops without changing the count, while the
// overview is opening, can point this index at the wrong thumbnail; a count change is
// refused. Full-screen spaces count only as list entries. Reduce Motion is not changed.
import Foundation

enum MCShow: Equatable {
  case hidden
  case stub
  case tree([MCDisplay])
}

struct MCDisplay: Equatable {
  var displayID: UInt32?
  var spaceGroups: Int
  var lists: [[Bool]]
}

enum PollInput: Equatable {
  case unreadable
  case ambiguousHost
  case show(MCShow)
}

/// What one AX identifier read means. cannotComplete and invalidUIElement are not
/// "this element has no identifier": dropping them makes a visible overview look hidden.
enum AXTextCode: Equatable {
  case success
  case noValue
  case unsupported
  case cannotComplete
  case invalidElement
  case failed
}

enum IdentifierRead: Equatable {
  case text(String)
  case absent
  case unreadable

  static func interpret(_ code: AXTextCode, text: String?) -> IdentifierRead {
    switch code {
    case .success:
      guard let text, !text.isEmpty else { return .absent }
      return .text(text)
    case .noValue, .unsupported:
      return .absent
    case .cannotComplete, .invalidElement, .failed:
      return .unreadable
    }
  }
}

enum RootChildren {
  /// Indexes whose identifier equals `want`. Nil when any child cannot be read.
  /// The caller must not treat that nil as an empty list.
  static func indexes(_ ids: [IdentifierRead], equalTo want: String) -> [Int]? {
    var hit: [Int] = []
    for (index, id) in ids.enumerated() {
      switch id {
      case .unreadable:
        return nil
      case .absent:
        continue
      case .text(let value):
        if value == want { hit.append(index) }
      }
    }
    return hit
  }
}

/// The word a desktop preview may trust. Only a fresh hidden show is "hidden".
/// Unreadable and an ambiguous host are "unknown" and fail closed. A stub or a
/// tree means Mission Control is on screen, including the empty Dock stub macOS 27
/// leaves up while the overview is showing.
enum OverviewReport {
  static func token(_ input: PollInput) -> String {
    switch input {
    case .show(.hidden):
      return "hidden"
    case .unreadable, .ambiguousHost:
      return "unknown"
    case .show:
      return "visible"
    }
  }
}

enum MCPlan: Equatable {
  case incomplete
  case refuse(String)
  case ready(Int)
}

struct HostSnapshot: Equatable {
  var dockCount: Int
  var windowManagerCount: Int
  var dockMCCount: Int
  var dockHasMC: Bool
  var dockDisplays: [MCDisplay]
  var windowDisplays: [MCDisplay]
}

enum OverviewReply: Equatable {
  case armed(String)
  case ok
  case fail(String)
}

struct OverviewEffects: Equatable {
  var hold = false
  var open = false
  var close = false
  var restore = false
  var aborted = false
  var switchReply: OverviewReply? = nil
  var commitReply: OverviewReply? = nil
}

enum PressDecision: Equatable {
  case fire(Int)
  case settle(OverviewEffects)
}

enum OverviewPhase: Equatable {
  case idle, polling, armed, committing, releasing, settled
}

struct DisplayCurrent: Equatable {
  var displayId: UInt32
  var current: UInt64?
}

enum SpaceMove: Equatable {
  case unread
  case pending
  case confirmed
  /// "spans" when another display's desktop changed. "unavailable" or "ambiguous" otherwise.
  case refused(String)
}

enum SpaceMoveCheck {
  /// The list captured before Mission Control opens. The destination display is on a
  /// different desktop, and every other display has a current desktop we can compare.
  static func baseline(_ rows: [DisplayCurrent], displayId: UInt32, spaceId: UInt64) -> Bool {
    guard displayId != 0, spaceId != 0, unique(rows) else { return false }
    guard let mine = rows.first(where: { $0.displayId == displayId }),
          let current = mine.current, current != 0, current != spaceId else { return false }
    return rows.allSatisfy { $0.current != nil }
  }

  /// `after` nil means the read failed and may be tried again. A confirmed move is the
  /// destination desktop current on its display and every other display still current
  /// where `before` left it.
  static func judge(before: [DisplayCurrent], after: [DisplayCurrent]?, displayId: UInt32, spaceId: UInt64) -> SpaceMove {
    guard baseline(before, displayId: displayId, spaceId: spaceId),
          let previous = before.first(where: { $0.displayId == displayId })?.current else { return .refused("unavailable") }
    guard let after else { return .unread }
    guard unique(after) else { return .refused("ambiguous") }
    if Set(before.map(\.displayId)) != Set(after.map(\.displayId)) { return .refused("unavailable") }
    var unread = false
    for prior in before where prior.displayId != displayId {
      guard let now = after.first(where: { $0.displayId == prior.displayId }), let old = prior.current else {
        return .refused("unavailable")
      }
      if now.current == nil { unread = true; continue }
      if now.current != old { return .refused("spans") }
    }
    guard let target = after.first(where: { $0.displayId == displayId }) else { return .refused("unavailable") }
    if target.current == nil { return .unread }
    if unread { return target.current == previous || target.current == spaceId ? .unread : .refused("unavailable") }
    if target.current == spaceId { return .confirmed }
    if target.current == previous { return .pending }
    return .refused("unavailable")
  }

  private static func unique(_ rows: [DisplayCurrent]) -> Bool {
    var seen = Set<UInt32>()
    return rows.allSatisfy { $0.displayId != 0 && seen.insert($0.displayId).inserted }
  }
}

enum SpaceComposition {
  /// True when every on-screen window includes a desktop that is current on some display.
  /// `windows` nil, an empty space list, or two displays sharing one current desktop is not
  /// clean: those reads must not be treated as proof that the picture matches the space ids.
  /// An empty window list is clean. This does not move a window or a desktop.
  static func clean(current: [UInt64], windows: [[UInt64]]?) -> Bool {
    guard let windows, !current.isEmpty, current.allSatisfy({ $0 != 0 }) else { return false }
    var live = Set<UInt64>()
    for id in current where !live.insert(id).inserted { return false }
    for spaces in windows {
      if spaces.isEmpty || spaces.contains(0) { return false }
      if !spaces.contains(where: { live.contains($0) }) { return false }
    }
    return true
  }
}

enum MissionControlPlan {
  /// Dock `mc` with real `mc.display` children is the pre-27 tree. A Dock `mc` with no
  /// displays, plus WindowManager `mc.display` children, is the macOS 27 tree. Anything
  /// that has both, or more than one Dock or WindowManager, is not a tree we may press.
  static func classify(_ host: HostSnapshot) -> PollInput {
    if host.dockCount > 1 || host.windowManagerCount > 1 || host.dockMCCount > 1 { return .ambiguousHost }
    let dockTree = !host.dockDisplays.isEmpty
    let wmTree = !host.windowDisplays.isEmpty
    if host.windowManagerCount == 0 && wmTree { return .ambiguousHost }
    if host.dockCount == 0 && (dockTree || host.dockHasMC || host.dockMCCount > 0) { return .ambiguousHost }
    if dockTree && wmTree { return .ambiguousHost }
    if wmTree { return .show(.tree(host.windowDisplays)) }
    if dockTree { return .show(.tree(host.dockDisplays)) }
    if host.dockHasMC { return .show(.stub) }
    return .show(.hidden)
  }

  static func plan(show: MCShow, displayId: UInt32, spaceIndex: Int, spaceCount: Int) -> MCPlan {
    guard displayId != 0, spaceIndex >= 0, spaceCount > spaceIndex else { return .refuse("unavailable") }
    switch show {
    case .hidden, .stub:
      return .incomplete
    case .tree(let displays):
      if displays.isEmpty { return .incomplete }
      // An id that has not been filled in yet may be ours. Do not press a neighbour.
      if displays.contains(where: { $0.displayID == nil }) { return .incomplete }
      var seen = Set<UInt32>()
      for display in displays {
        guard let id = display.displayID else { return .incomplete }
        if !seen.insert(id).inserted { return .refuse("ambiguous") }
      }
      let mine = displays.filter { $0.displayID == displayId }
      if mine.count != 1 { return mine.isEmpty ? .incomplete : .refuse("ambiguous") }
      let display = mine[0]
      if display.spaceGroups == 0 { return .incomplete }
      if display.spaceGroups != 1 { return .refuse("ambiguous") }
      if display.lists.isEmpty { return .incomplete }
      if display.lists.count != 1 { return .refuse("ambiguous") }
      let buttons = display.lists[0]
      if buttons.isEmpty || buttons.count < spaceCount { return .incomplete }
      if buttons.count != spaceCount { return .refuse("ambiguous") }
      if buttons.contains(false) { return .incomplete }
      return .ready(spaceIndex)
    }
  }
}

enum InputRecovery {
  /// True only for a fresh hidden read when nothing is still opening or pressing.
  /// Polling stays held: Mission Control may not have drawn yet. This decision
  /// never presses, toggles, clicks, or posts a Dock notification.
  static func allowRestore(phase: OverviewPhase?, input: PollInput) -> Bool {
    guard case .show(.hidden) = input else { return false }
    switch phase {
    case nil, .releasing, .settled:
      return true
    case .idle, .polling, .armed, .committing:
      return false
    }
  }
}

final class OverviewMachine {
  let token: String
  let displayId: UInt32
  let spaceIndex: Int
  let spaceCount: Int
  let started: Double
  let deadline: Double
  let readyDelay: Double
  let armWindow: Double
  let commitWindow: Double
  let confirmWindow: Double

  private enum ReleaseKind {
    case unknown
    case close
    case press
  }

  private(set) var phase: OverviewPhase = .idle
  private(set) var openedByUs = false
  private(set) var held = false
  private(set) var pressed = false
  private(set) var cancelled = false
  private var stable = 0
  private var armDeadline = 0.0
  private var commitDeadline = 0.0
  private var switchOpen = true
  private var commitOpen = false
  private var accepted = false
  private var resultWhy: String? = nil
  private var releaseKind: ReleaseKind = .unknown
  private var releaseDeadline = 0.0
  private var closeSent = false
  private var pendingWhy: String? = nil
  private var pendingSwitch = false
  private var pendingCommit = false
  private var moveWhy: String? = nil

  var needsTick: Bool { phase == .polling || phase == .armed || phase == .committing || phase == .releasing }

  /// The press has landed. Ticks must bring a fresh space-list comparison until this attempt settles.
  var needsMoveCheck: Bool { phase == .releasing && releaseKind == .press }

  init(token: String, displayId: UInt32, spaceIndex: Int, spaceCount: Int, started: Double, deadline: Double, readyDelay: Double, armWindow: Double, commitWindow: Double, confirmWindow: Double) {
    self.token = token
    self.displayId = displayId
    self.spaceIndex = spaceIndex
    self.spaceCount = spaceCount
    self.started = started
    self.deadline = deadline
    self.readyDelay = readyDelay
    self.armWindow = armWindow
    self.commitWindow = commitWindow
    self.confirmWindow = confirmWindow
  }

  func start(input: PollInput) -> OverviewEffects {
    guard phase == .idle else { return finish(why: "unavailable", now: started, input: .unreadable) }
    switch input {
    case .unreadable:
      return finish(why: "unavailable", now: started, input: .unreadable)
    case .ambiguousHost:
      return finish(why: "ambiguous", now: started, input: .ambiguousHost)
    case .show(.hidden):
      phase = .polling
      held = true
      var effects = OverviewEffects()
      effects.hold = true
      effects.open = true
      return effects
    case .show:
      return finish(why: "overview", now: started, input: input)
    }
  }

  /// The runner has posted the open notification. Close is allowed only after this.
  func noteOpened() {
    if phase == .polling { openedByUs = true }
  }

  /// The second read, before any notification, no longer showed a hidden overview.
  /// Nothing was opened, so nothing is closed.
  func cancelOpen(why: String) -> OverviewEffects {
    openedByUs = false
    return finish(why: why, now: started, input: .show(.hidden))
  }

  /// The close notification was not delivered. Do not send it again, and do not treat
  /// the overview as already closed.
  func closeMissed() {
    guard phase == .releasing, releaseKind == .close else { return }
    releaseKind = .unknown
    closeSent = true
  }

  func tick(now: Double, input: PollInput, move: SpaceMove = .pending) -> OverviewEffects {
    switch phase {
    case .releasing:
      return tickRelease(now: now, input: input, move: move)
    case .polling:
      if cancelled { return finish(why: "stale", now: now, input: input) }
      if now >= deadline { return finish(why: "unavailable", now: now, input: input) }
      switch decide(input) {
      case .incomplete:
        stable = 0
        return OverviewEffects()
      case .refuse(let why):
        return finish(why: why, now: now, input: input)
      case .ready:
        stable += 1
        if stable < 2 || now < started + readyDelay { return OverviewEffects() }
        phase = .armed
        armDeadline = now + armWindow
        switchOpen = false
        var effects = OverviewEffects()
        effects.switchReply = .armed(token)
        return effects
      }
    case .armed:
      if cancelled { return finish(why: "stale", now: now, input: input) }
      if now >= armDeadline { return finish(why: "unavailable", now: now, input: input) }
      return OverviewEffects()
    case .committing:
      if pressed || accepted { return OverviewEffects() }
      if cancelled { return finish(why: "stale", now: now, input: input) }
      if now >= commitDeadline { return finish(why: "unavailable", now: now, input: input) }
      return OverviewEffects()
    default:
      return OverviewEffects()
    }
  }

  /// Resume remote input on a fresh hidden read during release. Any other phase
  /// or read returns no effects. Does not open, close, or press. A press still
  /// waits for the destination check inside the release tick.
  func recover(now: Double, input: PollInput, move: SpaceMove = .pending) -> OverviewEffects {
    guard phase == .releasing, InputRecovery.allowRestore(phase: phase, input: input) else {
      return OverviewEffects()
    }
    return tickRelease(now: now, input: input, move: move)
  }

  func commit(token: String, now: Double, input: PollInput) -> OverviewEffects {
    guard token == self.token else {
      var effects = OverviewEffects()
      effects.commitReply = .fail("stale")
      return effects
    }
    if phase == .settled {
      var effects = OverviewEffects()
      effects.commitReply = .fail(pressed ? "unavailable" : (resultWhy ?? "stale"))
      return effects
    }
    if phase == .releasing {
      var effects = OverviewEffects()
      effects.commitReply = .fail(pendingWhy ?? "stale")
      return effects
    }
    if phase != .armed || cancelled {
      commitOpen = true
      return finish(why: "stale", now: now, input: input)
    }
    phase = .committing
    commitOpen = true
    commitDeadline = now + commitWindow
    return OverviewEffects()
  }

  /// The next main-queue turn after commit. A cancel that was queued first has already
  /// settled this attempt, and this returns no press.
  func beginPress(now: Double, input: PollInput) -> PressDecision {
    if phase != .committing || accepted || pressed { return .settle(OverviewEffects()) }
    if cancelled || now >= commitDeadline {
      return .settle(finish(why: cancelled ? "stale" : "unavailable", now: now, input: input))
    }
    switch decide(input) {
    case .ready(let index) where index == spaceIndex:
      accepted = true
      return .fire(index)
    case .refuse(let why):
      return .settle(finish(why: why, now: now, input: input))
    case .incomplete, .ready:
      return .settle(finish(why: "unavailable", now: now, input: input))
    }
  }

  /// SkyLight's read-only snapshot no longer names this index. Do not press.
  func abandonPress(now: Double, input: PollInput) -> OverviewEffects {
    guard accepted, !pressed, phase == .committing else { return OverviewEffects() }
    return finish(why: "unavailable", now: now, input: input)
  }

  func finishPress(ok: Bool, now: Double, input: PollInput) -> OverviewEffects {
    guard accepted, !pressed, phase == .committing else { return OverviewEffects() }
    if !ok { return finish(why: "unavailable", now: now, input: input) }
    // The press dismisses Mission Control. Toggle here can open it again.
    // Input stays held until a fresh hidden read and the space-list postcheck.
    pressed = true
    phase = .releasing
    releaseKind = .press
    releaseDeadline = now + confirmWindow
    pendingWhy = nil
    pendingSwitch = false
    pendingCommit = true
    switchOpen = false
    commitOpen = false
    return OverviewEffects()
  }

  /// The viewer session is gone. Before release, this settles or starts the close
  /// the same way a failed attempt does. Once release has started, and when a
  /// failure left an unknown release, cancellation uses the same ownership-clearing
  /// cleanup as shutdown. One close is allowed only for an overview this read shows
  /// we still own. Unknown does not toggle. Input stays held until a fresh hidden
  /// read, so a later visible tick cannot close an overview the user opened.
  func abort(token: String, now: Double, input: PollInput) -> OverviewEffects {
    guard token == self.token, phase != .settled, phase != .idle else { return OverviewEffects() }
    // A press can have been accepted and then failed before release began. The
    // session still needs to relinquish ownership while release is in progress.
    if phase != .releasing && (pressed || accepted) { return OverviewEffects() }
    cancelled = true
    if phase == .releasing {
      pendingWhy = "stale"
    } else {
      var effects = finish(why: "stale", now: now, input: input)
      effects.aborted = true
      if effects.close { openedByUs = false }
      // A visible close, or a hidden settle, is finished. An unknown release would
      // still own the overview and could close a later one the user opened.
      if phase != .releasing || !openedByUs { return effects }
    }
    var effects = clearOwnership(now: now, input: input, move: .pending)
    effects.aborted = true
    return effects
  }

  /// The helper is exiting, or the connection that drove this attempt is gone.
  /// Ownership ends in this call, so a later visible read is not ours to close.
  /// One close is allowed only when this read is visible, we opened the overview,
  /// and we have not pressed and have not already sent that close. Unknown never
  /// toggles. Remote input stays held until a fresh hidden read, including when
  /// this read is already hidden and the press postcheck can settle now.
  func shutdown(now: Double, input: PollInput, move: SpaceMove = .pending) -> OverviewEffects {
    if phase == .idle || phase == .settled {
      openedByUs = false
      return OverviewEffects()
    }
    if phase != .releasing {
      let tellSwitch = switchOpen
      let tellCommit = commitOpen || phase == .committing
      switchOpen = false
      commitOpen = false
      cancelled = true
      accepted = false
      phase = .releasing
      pendingWhy = "unavailable"
      pendingSwitch = tellSwitch
      pendingCommit = tellCommit
      releaseKind = .unknown
      closeSent = false
      releaseDeadline = now + confirmWindow
    }
    return clearOwnership(now: now, input: input, move: move)
  }

  /// Drop ownership. Close once only when this read shows an overview we opened,
  /// we have not pressed, and we have not already sent that close. An unknown or
  /// ambiguous read does not toggle. After this returns, a later visible read is
  /// not ours. Input stays held unless this read is a fresh hidden confirmation.
  private func clearOwnership(now: Double, input: PollInput, move: SpaceMove) -> OverviewEffects {
    var effects = OverviewEffects()
    if openedByUs && !pressed && !closeSent && reliableVisible(input) {
      closeSent = true
      releaseKind = .close
      effects.close = true
    }
    openedByUs = false
    if effects.close { return effects }
    closeSent = true
    if reliableHidden(input) { return tickRelease(now: now, input: input, move: move) }
    return effects
  }

  private func decide(_ input: PollInput) -> MCPlan {
    switch input {
    case .unreadable:
      return .incomplete
    case .ambiguousHost:
      return .refuse("ambiguous")
    case .show(let show):
      return MissionControlPlan.plan(show: show, displayId: displayId, spaceIndex: spaceIndex, spaceCount: spaceCount)
    }
  }

  private func tickRelease(now: Double, input: PollInput, move: SpaceMove) -> OverviewEffects {
    if releaseKind == .press, case .refused(let why) = move, moveWhy == nil { moveWhy = why }
    // Close once only while this attempt still owns the overview. Unknown is not
    // a visible read. After abort or shutdown clears ownership, a later visible
    // tick must not toggle an overview the user opened.
    if openedByUs && releaseKind == .unknown && !closeSent && reliableVisible(input) {
      closeSent = true
      releaseKind = .close
      var effects = OverviewEffects()
      effects.close = true
      return effects
    }
    // Visible and unknown both fail closed. The confirm bound is not a hidden read.
    guard reliableHidden(input) else { return OverviewEffects() }
    if releaseKind == .press {
      if moveWhy == nil && move == .confirmed { return completeRelease(why: nil) }
      if moveWhy != nil { return completeRelease(why: moveWhy) }
      if now >= releaseDeadline { return completeRelease(why: "unavailable") }
      return OverviewEffects()
    }
    return completeRelease(why: pendingWhy ?? "unavailable")
  }

  /// A tree or a Dock stub is visible. Unreadable and an ambiguous host are not:
  /// toggling then can open an overview the user has already closed.
  private func reliableVisible(_ input: PollInput) -> Bool {
    switch input {
    case .show(.hidden), .unreadable, .ambiguousHost:
      return false
    case .show:
      return true
    }
  }

  /// Only this read. A cached visible answer is not evidence that the overview is gone.
  private func reliableHidden(_ input: PollInput) -> Bool {
    if case .show(.hidden) = input { return true }
    return false
  }

  private func finish(why: String?, now: Double, input: PollInput) -> OverviewEffects {
    if phase == .settled || phase == .releasing { return OverviewEffects() }
    let tellSwitch = switchOpen
    let tellCommit = commitOpen || phase == .committing
    switchOpen = false
    commitOpen = false
    if openedByUs && !pressed && !reliableHidden(input) {
      phase = .releasing
      pendingWhy = why
      pendingSwitch = tellSwitch
      pendingCommit = tellCommit
      releaseDeadline = now + confirmWindow
      if reliableVisible(input) {
        closeSent = true
        releaseKind = .close
        var effects = OverviewEffects()
        effects.close = true
        return effects
      }
      releaseKind = .unknown
      closeSent = false
      return OverviewEffects()
    }
    return settleNow(why: why, tellSwitch: tellSwitch, tellCommit: tellCommit)
  }

  private func completeRelease(why: String?) -> OverviewEffects {
    guard phase == .releasing else { return OverviewEffects() }
    let tellSwitch = pendingSwitch
    let tellCommit = pendingCommit
    pendingSwitch = false
    pendingCommit = false
    return settleNow(why: why, tellSwitch: tellSwitch, tellCommit: tellCommit)
  }

  private func settleNow(why: String?, tellSwitch: Bool, tellCommit: Bool) -> OverviewEffects {
    if phase == .settled { return OverviewEffects() }
    phase = .settled
    resultWhy = why
    var effects = OverviewEffects()
    if held {
      effects.restore = true
      held = false
    }
    if why == nil {
      if tellCommit { effects.commitReply = .ok }
    } else if tellSwitch {
      effects.switchReply = .fail(why!)
      if tellCommit { effects.commitReply = .fail(why!) }
    } else if tellCommit {
      effects.commitReply = .fail(why!)
    }
    return effects
  }
}
