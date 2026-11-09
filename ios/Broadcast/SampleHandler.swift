// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Screen sharing (Meet-style: the whole screen, every app), as a ReplayKit broadcast extension.
// iOS gives us the screen's frames; VideoToolbox makes H.264 of them; it goes to TwinDesk (the app,
// on 127.0.0.1:47830), which sends it to the computer over the session (Mirror.swift, the
// computer's shared/nativescreen.js), where the phone window shows it as it shows an Android
// phone's. Through the app, not straight to the computer: the extension then needs no pairing of
// its own, no App Group and no certificate pinning, and it stays inside its 50 MB.
//
// Frames to the app: [u8 type][u32 BE length][payload]
//   1  JSON  {hello: 1, w, h} | {stopped: 1}
//   2  bytes a scrcpy packet as nativescreen.js reads it (12-byte header, then Annex B)
// From the app: type 1 JSON {ack: 1} (it has us) | {maxSize, bitrate, fps, want: 1} | {want: 0} | {sync: 1}
// (a keyframe now) | {stop: 1}. No ack within a few seconds (TwinDesk isn't running, or iOS holds it
// suspended): the broadcast ends saying so, rather than recording for nothing. Until something
// watches (want), frames aren't encoded: the screen is only sized, which costs next to nothing.
import ReplayKit
import VideoToolbox
import Network
import CoreMedia

final class SampleHandler: RPBroadcastSampleHandler {
    private let q = DispatchQueue(label: "td.broadcast")
    private var conn: NWConnection?
    private var session: VTCompressionSession?
    private var size = (w: 0, h: 0)
    private var srcSize = (w: 0, h: 0)
    private var maxSize = 1920
    private var bitrate = 8_000_000
    private var fps = 30
    private var lastFrame: CMTime = .invalid
    private var forceKey = true
    private var sentConfig: Data?
    private var inflight = 0 // bytes handed to the socket not yet sent
    private var rx = Data()
    private var started = false
    private var acked = false // the app answered: it has the screen
    private var wanted = false // a computer or phone watches: encode
    // Landscape (an iPad, mostly): iOS hands the frames upright as in portrait, with how the device
    // is held beside them. Scaled down to the size we send, then turned, so the computer gets the
    // picture the right way up (and the extension stays inside its 50 MB).
    private var scaler: VTPixelTransferSession?
    private var rotator: VTPixelRotationSession?
    private var scaledPool: CVPixelBufferPool?
    private var turnedPool: CVPixelBufferPool?
    private var poolKey = ""

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        let c = NWConnection(host: "127.0.0.1", port: 47830, using: .tcp)
        conn = c
        c.stateUpdateHandler = { [weak self] st in
            guard let self = self else { return }
            switch st {
            case .ready:
                self.started = true
                self.read()
                self.q.asyncAfter(deadline: .now() + 5) { [weak self] in
                    guard let self = self, !self.acked else { return }
                    self.finishBroadcastWithError(NSError(domain: "TwinDesk", code: 4, userInfo: [NSLocalizedDescriptionKey:
                        tr("Open TwinDesk and connect to a computer, then share the screen again.")]))
                }
            case .failed, .waiting:
                if !self.started {
                    self.finishBroadcastWithError(NSError(domain: "TwinDesk", code: 1, userInfo: [NSLocalizedDescriptionKey:
                        tr("Open TwinDesk and connect to a computer, then share the screen again.")]))
                }
            default: break
            }
        }
        c.start(queue: q)
    }

    override func broadcastFinished() {
        q.sync {
            send(1, json: ["stopped": 1])
            if let s = session { VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(s) }
            session = nil
            conn?.cancel()
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video, started, let raw = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let orient = (CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber)
            .flatMap { CGImagePropertyOrientation(rawValue: $0.uint32Value) } ?? .up
        q.sync {
            // At most `fps`, and never while the socket is backed up (frames dropped, not queued).
            if lastFrame.isValid, CMTimeGetSeconds(CMTimeSubtract(pts, lastFrame)) < 1.0 / Double(fps) - 0.002 { return }
            if inflight > 3 << 20 { forceKey = true; return }
            if !wanted && session != nil { return } // sized and said (hello); nothing to encode for
            lastFrame = pts
            guard let px = upright(raw, orient) else { return }
            let w = CVPixelBufferGetWidth(px), h = CVPixelBufferGetHeight(px)
            if session == nil || w != srcSize.w || h != srcSize.h { makeSession(w, h) }
            guard let s = session, wanted else { return }
            var props: CFDictionary?
            if forceKey {
                forceKey = false
                props = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
            }
            VTCompressionSessionEncodeFrame(s, imageBuffer: px, presentationTimeStamp: pts, duration: .invalid,
                                            frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sb in
                guard status == noErr, let sb = sb, let self = self else { return }
                self.q.async { self.encoded(sb) }
            }
        }
    }

    // ---- turning ----

    private func upright(_ px: CVPixelBuffer, _ o: CGImagePropertyOrientation) -> CVPixelBuffer? {
        let rotation: CFString
        switch o {
        case .left, .leftMirrored: rotation = kVTRotation_CW90
        case .right, .rightMirrored: rotation = kVTRotation_CCW90
        case .down, .downMirrored: rotation = kVTRotation_180
        default: return px // portrait: as it is (the encoder scales it)
        }
        let sw = CVPixelBufferGetWidth(px), sh = CVPixelBufferGetHeight(px)
        let k = maxSize > 0 ? min(1.0, Double(maxSize) / Double(max(sw, sh))) : 1.0
        let w = Int(Double(sw) * k) & ~1, h = Int(Double(sh) * k) & ~1
        let fmt = CVPixelBufferGetPixelFormatType(px)
        let quarter = rotation != kVTRotation_180
        let key = "\(w)x\(h)/\(fmt)/\(rotation)"
        if key != poolKey {
            poolKey = key
            scaledPool = Self.pool(w, h, fmt)
            turnedPool = quarter ? Self.pool(h, w, fmt) : Self.pool(w, h, fmt)
            if scaler == nil { VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &scaler) }
            if rotator == nil { VTPixelRotationSessionCreate(nil, &rotator) }
            if let r = rotator { VTSessionSetProperty(r, key: kVTPixelRotationPropertyKey_Rotation, value: rotation) }
        }
        guard let sp = scaledPool, let tp = turnedPool, let s = scaler, let r = rotator else { return px }
        var small: CVPixelBuffer?
        var turned: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, sp, &small)
        CVPixelBufferPoolCreatePixelBuffer(nil, tp, &turned)
        guard let a = small, let b = turned,
              VTPixelTransferSessionTransferImage(s, from: px, to: a) == noErr,
              VTPixelRotationSessionRotateImage(r, a, b) == noErr else { return px }
        return b
    }

    private static func pool(_ w: Int, _ h: Int, _ fmt: OSType) -> CVPixelBufferPool? {
        var p: CVPixelBufferPool?
        let attrs: [String: Any] = [kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
                                    kCVPixelBufferPixelFormatTypeKey as String: fmt, kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey as String: 2] as CFDictionary, attrs as CFDictionary, &p)
        return p
    }

    // ---- encoding ----

    private func makeSession(_ w: Int, _ h: Int) {
        if let s = session { VTCompressionSessionInvalidate(s) }
        session = nil
        srcSize = (w, h)
        // The long side at most maxSize, even sizes (the encoder wants them).
        let k = maxSize > 0 ? min(1.0, Double(maxSize) / Double(max(w, h))) : 1.0
        let tw = Int(Double(w) * k) & ~1, th = Int(Double(h) * k) & ~1
        var s: VTCompressionSession?
        let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue] as CFDictionary
        guard VTCompressionSessionCreate(allocator: nil, width: Int32(tw), height: Int32(th), codecType: kCMVideoCodecType_H264,
                                         encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                         outputCallback: nil, refcon: nil, compressionSessionOut: &s) == noErr, let s = s else {
            // Without low-latency rate control (older phones).
            var s2: VTCompressionSession?
            guard VTCompressionSessionCreate(allocator: nil, width: Int32(tw), height: Int32(th), codecType: kCMVideoCodecType_H264,
                                             encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                             outputCallback: nil, refcon: nil, compressionSessionOut: &s2) == noErr, let s2 = s2 else { return }
            configure(s2, tw, th)
            return
        }
        configure(s, tw, th)
    }

    private func configure(_ s: VTCompressionSession, _ w: Int, _ h: Int) {
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (fps * 4) as CFNumber)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(s)
        session = s
        size = (w, h)
        forceKey = true
        sentConfig = nil
        // The session packet: the picture's size (top bit set).
        var head = Data(count: 12)
        head[0] = 0x80
        head.replaceSubrange(4..<8, with: be32(UInt32(w)))
        head.replaceSubrange(8..<12, with: be32(UInt32(h)))
        send(2, head)
        send(1, json: ["hello": 1, "w": w, "h": h, "sw": srcSize.w, "sh": srcSize.h])
    }

    private func encoded(_ sb: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sb) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
        let key = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        let us = UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000))
        if key, let fmt = CMSampleBufferGetFormatDescription(sb) {
            // SPS and PPS as their own config packet whenever they change.
            var cfg = Data()
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
                                                               parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
            for i in 0..<count {
                var p: UnsafePointer<UInt8>?
                var n = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &n,
                                                                      parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let p = p {
                    cfg.append(contentsOf: [0, 0, 0, 1])
                    cfg.append(p, count: n)
                }
            }
            if !cfg.isEmpty && cfg != sentConfig {
                sentConfig = cfg
                packet(flags: 1 << 62, pts: 0, cfg)
            }
        }
        // AVCC (4-byte lengths) to Annex B (start codes).
        var len = 0
        var ptr: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr) == noErr, let base = ptr else { return }
        var out = Data(capacity: len + 16)
        var off = 0
        base.withMemoryRebound(to: UInt8.self, capacity: len) { b in
            while off + 4 <= len {
                let n = Int(b[off]) << 24 | Int(b[off + 1]) << 16 | Int(b[off + 2]) << 8 | Int(b[off + 3])
                off += 4
                if n <= 0 || off + n > len { break }
                out.append(contentsOf: [0, 0, 0, 1])
                out.append(b + off, count: n)
                off += n
            }
        }
        packet(flags: key ? 1 << 61 : 0, pts: us, out)
    }

    private func packet(flags: UInt64, pts: UInt64, _ data: Data) {
        var h = Data(count: 12)
        let v = flags | (pts & ((1 << 61) - 1))
        for i in 0..<8 { h[i] = UInt8(truncatingIfNeeded: v >> (56 - 8 * UInt64(i))) }
        h.replaceSubrange(8..<12, with: be32(UInt32(data.count)))
        send(2, h + data)
    }

    // ---- to and from the app ----

    private func send(_ type: UInt8, json: [String: Any]) {
        if let d = try? JSONSerialization.data(withJSONObject: json) { send(type, d) }
    }

    private func send(_ type: UInt8, _ payload: Data) {
        guard let c = conn else { return }
        var f = Data([type])
        f.append(be32(UInt32(payload.count)))
        f.append(payload)
        let n = f.count
        inflight += n
        c.send(content: f, completion: .contentProcessed { [weak self] _ in self?.q.async { self?.inflight -= n } })
    }

    private func read() {
        conn?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
            guard let self = self else { return }
            if let d = data { self.rx.append(d); self.parse() }
            if done || err != nil {
                self.finishBroadcastWithError(NSError(domain: "TwinDesk", code: 2, userInfo: [NSLocalizedDescriptionKey: tr("TwinDesk stopped sharing the screen.")]))
                return
            }
            self.read()
        }
    }

    private func parse() {
        while rx.count >= 5 {
            let n = Int(rx[rx.startIndex + 1]) << 24 | Int(rx[rx.startIndex + 2]) << 16 | Int(rx[rx.startIndex + 3]) << 8 | Int(rx[rx.startIndex + 4])
            guard rx.count >= 5 + n else { return }
            let type = rx[rx.startIndex]
            let body = rx.subdata(in: (rx.startIndex + 5)..<(rx.startIndex + 5 + n))
            rx = rx.subdata(in: (rx.startIndex + 5 + n)..<rx.endIndex)
            guard type == 1, let m = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { continue }
            if m["stop"] != nil {
                finishBroadcastWithError(NSError(domain: "TwinDesk", code: 3, userInfo: [NSLocalizedDescriptionKey: tr("Stopped from the computer.")]))
                return
            }
            if m["ack"] != nil { acked = true }
            if let w = m["want"] as? Int { wanted = w != 0; if wanted { forceKey = true; sentConfig = nil } }
            if m["sync"] != nil { forceKey = true; sentConfig = nil }
            var changed = false
            if let v = m["maxSize"] as? Int, v >= 0, v != maxSize { maxSize = v; changed = true }
            if let v = m["bitrate"] as? Int, v > 0, v != bitrate { bitrate = min(v, 40_000_000); changed = true }
            if let v = m["fps"] as? Int, v > 0 { fps = min(60, v) }
            if changed, srcSize.w > 0 { makeSession(srcSize.w, srcSize.h) }
            else if m["want"] != nil { forceKey = true; sentConfig = nil }
        }
    }

    private func be32(_ v: UInt32) -> Data { Data([UInt8(v >> 24), UInt8(v >> 16 & 255), UInt8(v >> 8 & 255), UInt8(v & 255)]) }
}
