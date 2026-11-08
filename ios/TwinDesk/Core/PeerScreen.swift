// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An Android phone's screen here (Peer.swift, Android's PeerScreen.kt): one HTTPS GET to it, pinned
// like the session, whose body is scrcpy's packets: a session packet at each new size (12 bytes,
// the top bit set, then width and height), and the encoder's (8 bytes of flags and time, 4 of length,
// then H.264 in Annex B). Decoded by AVSampleBufferDisplayLayer: the parameter sets make the format,
// each frame goes in as AVCC (4-byte lengths instead of start codes).
import Foundation
import AVFoundation
import CoreMedia
import UIKit

final class PeerScreenFeed: NSObject, URLSessionDataDelegate {
    let layer = AVSampleBufferDisplayLayer()
    private(set) var size = CGSize.zero // main
    var onSize: (CGSize) -> Void = { _ in }
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var pin = ""
    private var ended: () -> Void = {}
    private var buf = Data()
    private var format: CMVideoFormatDescription?
    private var sps: Data?
    private var pps: Data?
    private let q = DispatchQueue(label: "td.peerscreen")

    override init() {
        super.init()
        layer.videoGravity = .resizeAspect
        layer.backgroundColor = UIColor.black.cgColor
    }

    func fetch(_ r: URLRequest, pin: String, ended: @escaping () -> Void) {
        stop()
        self.pin = pin
        self.ended = ended
        let oq = OperationQueue()
        oq.underlyingQueue = q
        oq.maxConcurrentOperationCount = 1
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 24 * 3600
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: oq)
        session = s
        let t = s.dataTask(with: r)
        task = t
        t.resume()
    }

    // Pushed instead (a phone's POST to our server, Peer.screenIn): begin, push its bytes, finished.
    func begin(_ ended: @escaping () -> Void) {
        stop()
        self.ended = ended
    }

    func push(_ d: Data) { q.async { self.buf.append(d); self.parse() } }

    func finished() { let e = ended; ended = {}; e() }

    func stop() {
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        q.async { self.buf.removeAll(); self.format = nil; self.sps = nil; self.pps = nil }
        DispatchQueue.main.async { self.layer.flushAndRemoveImage() }
    }

    func urlSession(_ s: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust, Link.leafFingerprint(trust) == pin else {
            return completionHandler(.cancelAuthenticationChallenge, nil)
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        completionHandler((response as? HTTPURLResponse)?.statusCode == 200 ? .allow : .cancel)
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buf.append(data)
        parse()
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task else { return }
        let e = ended
        DispatchQueue.main.async { e() }
    }

    private func be32(_ d: Data, _ at: Int) -> Int {
        let i = d.startIndex + at
        return Int(d[i]) << 24 | Int(d[i + 1]) << 16 | Int(d[i + 2]) << 8 | Int(d[i + 3])
    }

    private func parse() {
        while buf.count >= 12 {
            let s = buf.startIndex
            if buf[s] & 0x80 != 0 { // a session packet: the size
                let w = be32(buf, 4), h = be32(buf, 8)
                buf = Data(buf[(s + 12)...])
                if w > 0 && h > 0 { DispatchQueue.main.async { self.size = CGSize(width: w, height: h); self.onSize(self.size) } }
                continue
            }
            let len = be32(buf, 8)
            if len <= 0 || len > 8 * 1024 * 1024 { task?.cancel(); buf.removeAll(); return }
            guard buf.count >= 12 + len else { return }
            let config = buf[s] & 0x40 != 0
            let body = Data(buf[(s + 12)..<(s + 12 + len)])
            buf = Data(buf[(s + 12 + len)...])
            frame(body, config: config)
        }
    }

    // Annex B NAL units.
    private func nals(_ d: Data) -> [Data] {
        var out: [Data] = []
        let b = [UInt8](d)
        var i = 0, start = -1
        while i + 3 <= b.count {
            if b[i] == 0, b[i + 1] == 0, b[i + 2] == 1 {
                if start >= 0 { var e = i; if e > start, b[e - 1] == 0 { e -= 1 }; out.append(Data(b[start..<e])) }
                i += 3
                start = i
            } else { i += 1 }
        }
        if start >= 0, start < b.count { out.append(Data(b[start...])) }
        return out
    }

    private func frame(_ d: Data, config: Bool) {
        var avcc = Data()
        var key = false
        for n in nals(d) where !n.isEmpty {
            switch n[n.startIndex] & 0x1f {
            case 7: sps = n; format = nil
            case 8: pps = n; format = nil
            default:
                if n[n.startIndex] & 0x1f == 5 { key = true }
                var l = UInt32(n.count).bigEndian
                avcc.append(Data(bytes: &l, count: 4))
                avcc.append(n)
            }
        }
        if format == nil, let sps = sps, let pps = pps { makeFormat(sps, pps) }
        guard !avcc.isEmpty, let fmt = format else { return }
        var block: CMBlockBuffer?
        let n = avcc.count
        guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: n, blockAllocator: nil, customBlockSource: nil,
                                                 offsetToData: 0, dataLength: n, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
              let bb = block else { return }
        _ = avcc.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: bb, offsetIntoDestination: 0, dataLength: n) }
        var sample: CMSampleBuffer?
        var sizes = [n]
        guard CMSampleBufferCreateReady(allocator: nil, dataBuffer: bb, formatDescription: fmt, sampleCount: 1, sampleTimingEntryCount: 0,
                                        sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &sizes, sampleBufferOut: &sample) == noErr,
              let sb = sample else { return }
        if let a = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: true), CFArrayGetCount(a) > 0 {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(a, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dict, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
            if !key { CFDictionarySetValue(dict, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()) }
        }
        DispatchQueue.main.async {
            if self.layer.status == .failed { self.layer.flush() }
            self.layer.enqueue(sb)
        }
    }

    private func makeFormat(_ sps: Data, _ pps: Data) {
        let s = [UInt8](sps), p = [UInt8](pps)
        var f: CMFormatDescription?
        s.withUnsafeBufferPointer { sp in
            p.withUnsafeBufferPointer { pp in
                let ptrs: [UnsafePointer<UInt8>] = [sp.baseAddress!, pp.baseAddress!]
                let sizes = [s.count, p.count]
                _ = CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: nil, parameterSetCount: 2, parameterSetPointers: ptrs,
                                                                         parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &f)
            }
        }
        format = f
    }
}
