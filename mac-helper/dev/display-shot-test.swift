// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ShotFit only. No ScreenCaptureKit call, no window server, no permission prompt.
import Foundation

@main
struct DisplayShotFitTest {
  static func main() {
    var failures = 0
    func check(_ ok: Bool, _ name: String) {
      if ok { return }
      failures += 1
      FileHandle.standardError.write(Data("fail: \(name)\n".utf8))
    }

    let hd = ShotFit.fit(width: 1920, height: 1080)
    check(hd?.width == 480 && hd?.height == 270, "1920x1080 fits the long side to 480")
    let small = ShotFit.fit(width: 100, height: 80)
    check(small?.width == 100 && small?.height == 80, "a side under the cap stays")
    check(ShotFit.fit(width: 0, height: 10) == nil, "a zero side is not a display")
    check(ShotFit.fit(width: 100, height: 100, maxEdge: 10000) == nil, "the caller cannot raise the cap")
    check(ShotFit.fit(width: 1, height: 100_000) == nil, "a fitted side of zero is refused")
    check(ShotFit.maxEdge == 480 && ShotFit.maxBytes == 24 * 1024, "the cap matches the phone and the Node policy")

    let first = ShotEpoch.begin()
    check(ShotEpoch.owns(first), "begin owns its token")
    check(!ShotEpoch.owns(0), "zero is not a generation")
    let second = ShotEpoch.begin()
    check(second != first && ShotEpoch.owns(second), "a second begin owns only itself")
    check(!ShotEpoch.owns(first), "a later begin invalidates the earlier token")
    ShotEpoch.cancel()
    check(!ShotEpoch.owns(second), "cancel makes the in-flight token stale")
    let third = ShotEpoch.begin()
    check(ShotEpoch.owns(third) && !ShotEpoch.owns(second), "the token after cancel is a new generation")

    if failures != 0 {
      FileHandle.standardError.write(Data("display-shot-fit: \(failures) failed\n".utf8))
      exit(1)
    }
    print("display-shot-fit: edge fit only. No capture.")
  }
}
