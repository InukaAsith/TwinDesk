// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// System audio capture for "Mac sound on the PC" with ScreenCaptureKit (macOS 13+;
// needs only Screen Recording). Writes raw PCM — 48 kHz, stereo, float32 interleaved — to fd 3
// (a pipe main opened next to stdout), so audio never mixes with the JSON lines.
import Cocoa
import ScreenCaptureKit
import CoreMedia

final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
  static let shared = AudioCapture()
  private var stream: SCStream?
  private let queue = DispatchQueue(label: "macshare.audio")
  private var scratch = [Float]()

  /// write(2) to fd 3; a closed pipe just drops audio (SIGPIPE is ignored in main.swift).
  private func put(_ p: UnsafeRawPointer, _ n: Int) {
    var off = 0
    while off < n {
      let w = Darwin.write(3, p + off, n - off)
      if w <= 0 { return }
      off += w
    }
  }

  private func putScratch() {
    scratch.withUnsafeBytes { put($0.baseAddress!, $0.count) }
  }

  func set(on: Bool, done: @escaping (String?) -> Void) {
    if !on {
      stop()
      return done(nil)
    }
    if stream != nil { return done(nil) }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
      DispatchQueue.main.async {
        guard let display = content?.displays.first else {
          return done("no display to capture audio from: \(error?.localizedDescription ?? "Screen Recording?")")
        }
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        cfg.width = 2 // ScreenCaptureKit always captures video too: keep it tiny and slow
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        // TwinDesk's own processes left out (the app and its Electron helpers, which play the other
        // computer's sound): sharing sound both ways would otherwise send that sound straight back.
        let me = NSRunningApplication(processIdentifier: getppid())?.bundleIdentifier
        let ours = (content?.applications ?? []).filter { a in
          a.processID == getppid() || (me != nil && (a.bundleIdentifier == me! || a.bundleIdentifier.hasPrefix(me! + ".")))
        }
        let filter = SCContentFilter(display: display, excludingApplications: ours, exceptingWindows: [])
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        do {
          try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.queue)
        } catch {
          return done("audio output: \(error.localizedDescription)")
        }
        s.startCapture { err in
          DispatchQueue.main.async {
            if let err = err { return done("audio capture: \(err.localizedDescription)") }
            self.stream = s
            log("audio capture on, leaving out \(ours.map { "\($0.bundleIdentifier) (\($0.processID))" })")
            done(nil)
          }
        }
      }
    }
  }

  func stop() {
    guard let s = stream else { return }
    stream = nil
    s.stopCapture { _ in }
    log("audio capture off")
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    DispatchQueue.main.async {
      self.stream = nil
      emit(["event": "audioStopped", "error": error.localizedDescription])
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sb.isValid else { return }
    let frames = CMSampleBufferGetNumSamples(sb)
    guard frames > 0 else { return }
    var blockBuffer: CMBlockBuffer?
    var abl = AudioBufferList()
    let st = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sb, bufferListSizeNeededOut: nil, bufferListOut: &abl, bufferListSize: MemoryLayout<AudioBufferList>.size,
      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &blockBuffer)
    // Stereo arrives non-interleaved (one buffer per channel), which needs a bigger list.
    if st == kCMSampleBufferError_ArrayTooSmall || abl.mNumberBuffers > 1 || st != noErr {
      writePlanar(sb, frames: frames)
      return
    }
    // One buffer: already interleaved (or mono).
    let b = abl.mBuffers
    guard let p = b.mData else { return }
    if b.mNumberChannels == 2 {
      put(p, Int(b.mDataByteSize))
    } else {
      let mono = p.assumingMemoryBound(to: Float.self)
      scratch = (0..<frames).flatMap { [mono[$0], mono[$0]] }
      putScratch()
    }
  }

  private func writePlanar(_ sb: CMSampleBuffer, frames: Int) {
    var size = 0
    CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: &size, bufferListOut: nil,
                                                            bufferListSize: 0, blockBufferAllocator: nil,
                                                            blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
    let mem = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 16)
    defer { mem.deallocate() }
    let list = mem.bindMemory(to: AudioBufferList.self, capacity: 1)
    var block: CMBlockBuffer?
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sb, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: size,
      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &block) == noErr else { return }
    let bufs = UnsafeMutableAudioBufferListPointer(list)
    guard let l = bufs.first?.mData?.assumingMemoryBound(to: Float.self) else { return }
    let r = (bufs.count > 1 ? bufs[1].mData : bufs[0].mData)!.assumingMemoryBound(to: Float.self)
    if scratch.count != frames * 2 { scratch = [Float](repeating: 0, count: frames * 2) }
    for i in 0..<frames {
      scratch[2 * i] = l[i]
      scratch[2 * i + 1] = r[i]
    }
    putScratch()
  }
}
