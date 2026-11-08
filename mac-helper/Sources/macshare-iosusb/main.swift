// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An iPhone's or iPad's screen over its USB cable, the way QuickTime shows it: macOS itself offers a
// cabled, trusted iOS device as a capture device once screen-capture devices are allowed
// (CoreMediaIO's kCMIOHardwarePropertyAllowScreenCaptureDevices). No app on the phone.
// mac/iosusb.js runs this on demand:
//   macshare-iosusb list                         -> one JSON line: [{id, name, model}]
//   macshare-iosusb capture <id> <maxSize> <bitrate>
//        stdout: the picture as H.264 in scrcpy's packets (as shared/nativescreen.js reads them)
//        stderr: {"event": "size"|"error"|"ended", ...} lines, and logs
// Exits when its stdin closes (the window closed).
import AVFoundation
import CoreMediaIO
import VideoToolbox
import Foundation

func note(_ o: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: o) {
        FileHandle.standardError.write(d)
        FileHandle.standardError.write(Data([0x0A]))
    }
}

func allowScreenDevices() {
    var addr = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
                                         mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
                                         mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var allow: UInt32 = 1
    CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &addr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
}

// The iOS devices on a cable (muxed: picture and sound). They show up a moment after allowing.
func devices(wait: TimeInterval) -> [AVCaptureDevice] {
    let until = Date().addingTimeInterval(wait)
    var list: [AVCaptureDevice] = []
    repeat {
        let types: [AVCaptureDevice.DeviceType]
        if #available(macOS 14.0, *) { types = [.external] } else { types = [.externalUnknown] }
        list = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .muxed, position: .unspecified).devices
        if !list.isEmpty { break }
        RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    } while Date() < until
    return list
}

final class Capture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let q = DispatchQueue(label: "iosusb.capture")
    let out = FileHandle.standardOutput
    var enc: VTCompressionSession?
    var src = (w: 0, h: 0)
    var maxSize: Int
    var bitrate: Int
    var sentConfig: Data?
    var t0: CMTime = .invalid

    init(maxSize: Int, bitrate: Int) {
        self.maxSize = maxSize
        self.bitrate = bitrate
    }

    func start(_ dev: AVCaptureDevice) throws {
        let input = try AVCaptureDeviceInput(device: dev)
        guard session.canAddInput(input) else { throw NSError(domain: "iosusb", code: 1, userInfo: [NSLocalizedDescriptionKey: "can’t use the device"]) }
        session.addInput(input)
        let o = AVCaptureVideoDataOutput()
        o.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        o.alwaysDiscardsLateVideoFrames = true
        o.setSampleBufferDelegate(self, queue: q)
        guard session.canAddOutput(o) else { throw NSError(domain: "iosusb", code: 2, userInfo: [NSLocalizedDescriptionKey: "can’t read the picture"]) }
        session.addOutput(o)
        NotificationCenter.default.addObserver(forName: .AVCaptureDeviceWasDisconnected, object: dev, queue: nil) { _ in
            note(["event": "ended", "why": "unplugged"])
            exit(0)
        }
        session.startRunning()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let px = CMSampleBufferGetImageBuffer(sb) else { return }
        let w = CVPixelBufferGetWidth(px), h = CVPixelBufferGetHeight(px)
        if enc == nil || w != src.w || h != src.h { make(w, h) } // turned: a new size
        guard let e = enc else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if !t0.isValid { t0 = pts }
        VTCompressionSessionEncodeFrame(e, imageBuffer: px, presentationTimeStamp: pts, duration: .invalid, frameProperties: nil, infoFlagsOut: nil) { [weak self] st, _, out in
            guard st == noErr, let out = out, let self = self else { return }
            self.q.async { self.encoded(out) }
        }
    }

    func make(_ w: Int, _ h: Int) {
        if let e = enc { VTCompressionSessionInvalidate(e) }
        enc = nil
        src = (w, h)
        let k = maxSize > 0 ? min(1.0, Double(maxSize) / Double(max(w, h))) : 1.0
        let tw = Int(Double(w) * k) & ~1, th = Int(Double(h) * k) & ~1
        var s: VTCompressionSession?
        let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue] as CFDictionary
        if VTCompressionSessionCreate(allocator: nil, width: Int32(tw), height: Int32(th), codecType: kCMVideoCodecType_H264, encoderSpecification: spec,
                                      imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &s) != noErr {
            _ = VTCompressionSessionCreate(allocator: nil, width: Int32(tw), height: Int32(th), codecType: kCMVideoCodecType_H264, encoderSpecification: nil,
                                           imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        }
        guard let e = s else { note(["event": "error", "message": "no H.264 encoder"]); return }
        VTSessionSetProperty(e, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(e, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(e, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(e, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
        VTSessionSetProperty(e, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 240 as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(e)
        enc = e
        sentConfig = nil
        var head = Data(count: 12)
        head[0] = 0x80
        head.replaceSubrange(4..<8, with: be32(UInt32(tw)))
        head.replaceSubrange(8..<12, with: be32(UInt32(th)))
        out.write(head)
        note(["event": "size", "w": tw, "h": th, "sw": w, "sh": h])
    }

    func encoded(_ sb: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sb) else { return }
        let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
        let key = !(att?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        if key, let fmt = CMSampleBufferGetFormatDescription(sb) {
            var cfg = Data()
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
            for i in 0..<count {
                var p: UnsafePointer<UInt8>?
                var n = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &n, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let p = p {
                    cfg.append(contentsOf: [0, 0, 0, 1])
                    cfg.append(p, count: n)
                }
            }
            if !cfg.isEmpty && cfg != sentConfig { sentConfig = cfg; packet(1 << 62, 0, cfg) }
        }
        var len = 0
        var ptr: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr) == noErr, let base = ptr else { return }
        var d = Data(capacity: len + 16)
        var off = 0
        base.withMemoryRebound(to: UInt8.self, capacity: len) { b in
            while off + 4 <= len {
                let n = Int(b[off]) << 24 | Int(b[off + 1]) << 16 | Int(b[off + 2]) << 8 | Int(b[off + 3])
                off += 4
                if n <= 0 || off + n > len { break }
                d.append(contentsOf: [0, 0, 0, 1])
                d.append(b + off, count: n)
                off += n
            }
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        let us = UInt64(max(0, CMTimeGetSeconds(CMTimeSubtract(pts, t0)) * 1_000_000))
        packet(key ? 1 << 61 : 0, us, d)
    }

    func packet(_ flags: UInt64, _ pts: UInt64, _ data: Data) {
        var h = Data(count: 12)
        let v = flags | (pts & ((1 << 61) - 1))
        for i in 0..<8 { h[i] = UInt8(truncatingIfNeeded: v >> (56 - 8 * UInt64(i))) }
        h.replaceSubrange(8..<12, with: be32(UInt32(data.count)))
        out.write(h + data)
    }

    func be32(_ v: UInt32) -> Data { Data([UInt8(v >> 24), UInt8(v >> 16 & 255), UInt8(v >> 8 & 255), UInt8(v & 255)]) }
}

signal(SIGPIPE, SIG_IGN)
allowScreenDevices()
let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "list":
    let list = devices(wait: 2).map { ["id": $0.uniqueID, "name": $0.localizedName, "model": $0.modelID] }
    let d = (try? JSONSerialization.data(withJSONObject: list)) ?? Data("[]".utf8)
    FileHandle.standardOutput.write(d)
    FileHandle.standardOutput.write(Data([0x0A]))
case "capture":
    let id = args.count > 2 ? args[2] : ""
    let maxSize = args.count > 3 ? Int(args[3]) ?? 0 : 0
    let bitrate = args.count > 4 ? Int(args[4]) ?? 8_000_000 : 8_000_000
    guard let dev = devices(wait: 4).first(where: { id.isEmpty || $0.uniqueID == id }) else {
        note(["event": "error", "message": "No iPhone or iPad on a cable. Plug it in, unlock it and tap Trust."])
        exit(3)
    }
    let c = Capture(maxSize: maxSize, bitrate: bitrate)
    do { try c.start(dev) } catch {
        note(["event": "error", "message": error.localizedDescription])
        exit(4)
    }
    note(["event": "started", "name": dev.localizedName])
    // The window closed (stdin went): stop.
    DispatchQueue.global().async {
        while !FileHandle.standardInput.availableData.isEmpty {}
        c.session.stopRunning()
        exit(0)
    }
    RunLoop.main.run()
default:
    FileHandle.standardError.write(Data("usage: macshare-iosusb list | capture <id> <maxSize> <bitrate>\n".utf8))
    exit(2)
}
