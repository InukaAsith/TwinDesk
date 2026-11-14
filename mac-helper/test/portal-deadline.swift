// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
@main
struct PortalDeadlineTest {
  static func main() {
    precondition(portalPlacementIsFresh(deadlineMs: 1700, nowMs: 1000))
    precondition(!portalPlacementIsFresh(deadlineMs: 1000, nowMs: 1000))
    precondition(!portalPlacementIsFresh(deadlineMs: 999, nowMs: 1000))
    precondition(!portalPlacementIsFresh(deadlineMs: 2001, nowMs: 1000))
    precondition(!portalPlacementIsFresh(deadlineMs: .nan, nowMs: 1000))
    precondition(!portalPlacementIsFresh(deadlineMs: .infinity, nowMs: 1000))
    print("portal placement deadline: ok")
  }
}
