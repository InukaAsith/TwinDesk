// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This iPhone's microphone as a microphone on the computer (its Audio › Microphone, "Use the
// iPhone's microphone"): the computer asks (phone.mic.want {on}); we capture with AVAudioEngine and
// send 48 kHz stereo s16le, 20 ms a packet (phone.mic {codec: 'pcm', p}), which the computer plays
// into its TwinDesk Microphone (Linux) or a virtual audio cable (phoneview.js netMic there).
//
// iOS's own way to keep going in the background: recording is what the "audio" background mode is
// for (the orange dot shows), so once started it carries on with TwinDesk off screen. iOS doesn't let
// a recording start from the background, so that asks to open TwinDesk.
import Foundation
import AVFoundation
import UIKit

final class Mic: Feature {
    private let engine = AVAudioEngine()
    private(set) var running = false // main
    private var wanted = false // main
    private var converter: AVAudioConverter?
    private let mono = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48000, channels: 1, interleaved: true)!
    private let q = DispatchQueue(label: "td.mic")
    private var pending = Data() // q: interleaved stereo s16le not sent yet
    private static let packet = 960 * 2 * 2 // 20 ms at 48 kHz, two channels of 16 bits
    private static let perMessage = 3 // 60 ms a message

    override init(_ core: Core) {
        super.init(core)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        guard t == Proto.T.phoneMicWant else { return false }
        wanted = m.bool("on")
        if wanted { start() } else { stop(tell: true) }
        return true
    }

    override func onClosed() {
        wanted = false
        stop(tell: false)
    }

    private func tell(_ on: Bool, _ error: String = "") {
        core.send(["t": Proto.T.phoneMicState, "on": on, "error": error])
    }

    private func start() {
        guard wanted else { return }
        if running { return tell(true) }
        let s = AVAudioSession.sharedInstance()
        switch s.recordPermission {
        case .undetermined:
            s.requestRecordPermission { ok in
                DispatchQueue.main.async {
                    if ok { self.start() } else if self.wanted { self.tell(false, "The microphone is off for TwinDesk on the \(Device.word)") }
                }
            }
            return
        case .denied:
            return tell(false, "The microphone is off for TwinDesk: turn it on in the \(Device.word)’s Settings › TwinDesk")
        default: break
        }
        if UIApplication.shared.applicationState == .background {
            return tell(false, "Open TwinDesk on the \(Device.word) to start its microphone")
        }
        do {
            Background.shared.recording = true
            try s.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
            try s.setActive(true)
            let input = engine.inputNode
            let fmt = input.outputFormat(forBus: 0)
            guard fmt.sampleRate > 0, fmt.channelCount > 0, let conv = AVAudioConverter(from: fmt, to: mono) else {
                throw NSError(domain: "TwinDesk", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone"])
            }
            converter = conv
            q.sync { pending.removeAll() }
            input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buf, _ in self?.captured(buf) }
            engine.prepare()
            try engine.start()
            running = true
            NSLog("TwinDesk: microphone to the computer")
            tell(true)
        } catch {
            NSLog("TwinDesk: microphone: %@", error.localizedDescription)
            engine.inputNode.removeTap(onBus: 0)
            Background.shared.recording = false
            Background.shared.apply()
            tell(false, error.localizedDescription)
        }
        core.changed()
    }

    private func stop(tell say: Bool) {
        if running {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            running = false
            converter = nil
            Background.shared.recording = false
            Background.shared.apply() // the audio session back as it was (or let go)
            core.changed()
        }
        if say { tell(false) }
    }

    // The audio thread: to 48 kHz mono, then each sample twice (left, right) for the computer's player.
    private func captured(_ buf: AVAudioPCMBuffer) {
        guard let conv = converter else { return }
        let cap = AVAudioFrameCount(Double(buf.frameLength) * 48000 / buf.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: cap) else { return }
        var given = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true
            status.pointee = .haveData
            return buf
        }
        guard err == nil, out.frameLength > 0, let ch = out.int16ChannelData?[0] else { return }
        let n = Int(out.frameLength)
        var d = Data(count: n * 4)
        d.withUnsafeMutableBytes { raw in
            let o = raw.bindMemory(to: Int16.self)
            for i in 0..<n {
                let v = ch[i].littleEndian
                o[i * 2] = v
                o[i * 2 + 1] = v
            }
        }
        q.async { self.pending.append(d); self.flush() }
    }

    private func flush() {
        let size = Self.packet * Self.perMessage
        while pending.count >= size {
            var p: [String] = []
            for i in 0..<Self.perMessage {
                p.append(pending.subdata(in: (i * Self.packet)..<((i + 1) * Self.packet)).base64EncodedString())
            }
            pending.removeSubrange(0..<size)
            _ = core.send(["t": Proto.T.phoneMic, "codec": "pcm", "p": p])
        }
    }

    // A call or Siri took the microphone: back once it's over (if iOS lets us from where we are).
    @objc private func interrupted(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let t = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        DispatchQueue.main.async {
            guard self.running || self.wanted else { return }
            if t == .began {
                self.stop(tell: false)
                self.tell(false, "Paused: something else took the microphone")
            } else if self.wanted {
                self.start()
            }
        }
    }
}
