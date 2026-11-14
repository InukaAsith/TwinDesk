// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// A queued placement must not move the cursor after the requester has timed out.
func portalPlacementIsFresh(deadlineMs: Double, nowMs: Double) -> Bool {
  deadlineMs.isFinite && nowMs.isFinite && deadlineMs > nowMs && deadlineMs - nowMs <= 1000
}
