// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This iPhone as a host for another phone (Peer.swift; Android's PeerServer.kt, the same wire): TLS on
// 47806 (else any port; the beacon says which) with PeerKey's identity. One socket is the session, a
// WebSocket (RFC 6455, text frames); the others are HTTP/1.1 requests for the bytes that shouldn't go
// through it (files, the screen), each checked by Peer with the session's key. Each request's
// connection closes after it (Connection: close), which every client here takes.
import Foundation
import Network
import CryptoKit

protocol PeerServerHandler: AnyObject {
    func wsOpen(_ ws: PeerServer.Ws)
    func wsText(_ ws: PeerServer.Ws, _ text: String)
    func wsClose(_ ws: PeerServer.Ws)
    func request(_ r: PeerServer.Request)
}

final class PeerServer {
    static let port: UInt16 = 47806
    static let maxPayload = 32 * 1024 * 1024
    weak var handler: PeerServerHandler?
    let q = DispatchQueue(label: "td.peer.server")
    private var listener: NWListener?
    private(set) var port: UInt16 = 0 // q: 0 while not listening
    var running: Bool { listener != nil }

    // On its own port (or any): calls back with the port, 0 when it can't.
    func start(_ done: @escaping (UInt16) -> Void) {
        q.async {
            if self.listener != nil, self.port > 0 { return DispatchQueue.main.async { done(self.port) } }
            guard let (id, _) = PeerKey.identity(), let sid = sec_identity_create(id) else {
                NSLog("TwinDesk: peer: no identity to host with")
                return DispatchQueue.main.async { done(0) }
            }
            self.listen(sid, Self.port, done)
        }
    }

    private func listen(_ sid: sec_identity_t, _ p: UInt16, _ done: @escaping (UInt16) -> Void) {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, sid)
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: tls, tcp: tcp)
        params.allowLocalEndpointReuse = true
        let l: NWListener
        do { l = p > 0 ? try NWListener(using: params, on: NWEndpoint.Port(rawValue: p)!) : try NWListener(using: params) } catch {
            if p > 0 { return listen(sid, 0, done) }
            return DispatchQueue.main.async { done(0) }
        }
        var answered = false
        l.stateUpdateHandler = { [weak self] st in
            guard let self = self else { return }
            switch st {
            case .ready:
                self.port = l.port?.rawValue ?? 0
                NSLog("TwinDesk: peer: hosting on %d", Int(self.port))
                if !answered { answered = true; let port = self.port; DispatchQueue.main.async { done(port) } }
            case .failed:
                l.cancel()
                if self.listener === l { self.listener = nil; self.port = 0 }
                if !answered { answered = true; if p > 0 { self.listen(sid, 0, done) } else { DispatchQueue.main.async { done(0) } } }
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        listener = l
        l.start(queue: q)
    }

    func stop() {
        q.async {
            self.listener?.cancel()
            self.listener = nil
            self.port = 0
        }
    }

    // ---- one connection: a request, or the WebSocket ----

    final class Conn {
        let c: NWConnection
        let q: DispatchQueue
        var buf = Data()
        var address: String {
            if case .hostPort(let h, _) = c.endpoint {
                switch h {
                case .ipv4(let a): return "\(a)".components(separatedBy: "%").first ?? ""
                case .ipv6(let a): return "\(a)".components(separatedBy: "%").first ?? ""
                case .name(let n, _): return n
                @unknown default: return ""
                }
            }
            return ""
        }
        init(_ c: NWConnection, _ q: DispatchQueue) { self.c = c; self.q = q }

        // At least n bytes in buf (false: it closed first).
        func need(_ n: Int, _ done: @escaping (Bool) -> Void) {
            if buf.count >= n { return done(true) }
            c.receive(minimumIncompleteLength: 1, maximumLength: max(65536, n - buf.count)) { d, _, end, err in
                if let d = d { self.buf.append(d) }
                if self.buf.count >= n { return done(true) }
                if end || err != nil { return done(false) }
                self.need(n, done)
            }
        }

        // Some bytes: what's in buf, else what comes next (nil: closed).
        func some(_ max: Int, _ done: @escaping (Data?) -> Void) {
            if !buf.isEmpty {
                let n = min(max, buf.count)
                let d = Data(buf.prefix(n))
                buf = Data(buf.dropFirst(n))
                return done(d)
            }
            c.receive(minimumIncompleteLength: 1, maximumLength: max) { d, _, end, err in
                if let d = d, !d.isEmpty { return done(d) }
                done(end || err != nil ? nil : Data())
            }
        }

        func take(_ n: Int) -> Data {
            let d = Data(buf.prefix(n))
            buf = Data(buf.dropFirst(n))
            return d
        }

        // Up to "\r\n\r\n" (at most 16 KB).
        func head(_ done: @escaping (String?) -> Void) {
            if let r = buf.range(of: Data("\r\n\r\n".utf8)) {
                let h = String(decoding: buf[buf.startIndex..<r.lowerBound], as: UTF8.self)
                buf = Data(buf[r.upperBound...])
                return done(h)
            }
            if buf.count > 16384 { return done(nil) }
            c.receive(minimumIncompleteLength: 1, maximumLength: 16384) { d, _, end, err in
                if let d = d { self.buf.append(d) }
                if self.buf.range(of: Data("\r\n\r\n".utf8)) == nil, end || err != nil { return done(nil) }
                self.head(done)
            }
        }

        func write(_ d: Data, _ done: ((Bool) -> Void)? = nil) {
            c.send(content: d, completion: .contentProcessed { e in done?(e == nil) })
        }

        func close() { c.cancel() }
    }

    private func accept(_ c: NWConnection) {
        let conn = Conn(c, q)
        c.stateUpdateHandler = { st in if case .failed = st { c.cancel() } }
        c.start(queue: q)
        conn.head { [weak self] h in
            guard let self = self, let h = h else { return conn.close() }
            var lines = h.components(separatedBy: "\r\n")
            let first = lines.removeFirst().split(separator: " ")
            guard first.count >= 3 else { return conn.close() }
            var headers: [String: String] = [:]
            for l in lines.prefix(64) {
                guard let i = l.firstIndex(of: ":") else { continue }
                headers[l[..<i].trimmingCharacters(in: .whitespaces).lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
            }
            if headers["upgrade"]?.lowercased() == "websocket" { return self.websocket(conn, headers) }
            let r = Request(conn, method: String(first[0]).uppercased(), path: String(first[1]), headers: headers)
            if let h = self.handler { DispatchQueue.main.async { h.request(r) } } else { r.respond(404) }
        }
    }

    // ---- HTTP ----

    final class Request {
        let conn: Conn
        let method: String
        let path: String
        let headers: [String: String]
        private let chunked: Bool
        private var left: Int64 // bytes of the body (or of the chunk) still to come
        private var done: Bool
        init(_ conn: Conn, method: String, path: String, headers: [String: String]) {
            self.conn = conn; self.method = method; self.path = path; self.headers = headers
            chunked = headers["transfer-encoding"]?.lowercased().contains("chunked") == true
            left = chunked ? 0 : Int64(headers["content-length"] ?? "0") ?? 0
            done = !chunked && left == 0
        }
        var length: Int64 { chunked ? -1 : left }
        var address: String { conn.address }

        // The body's next bytes on the server's queue (nil: it's over; error: closed early).
        func read(_ cb: @escaping (Data?, Bool) -> Void) {
            conn.q.async { self.next(cb) }
        }

        private func next(_ cb: @escaping (Data?, Bool) -> Void) {
            if done { return cb(nil, false) }
            if left == 0 && chunked { return chunkSize(cb) }
            conn.some(Int(min(left, 1 << 20))) { d in
                guard let d = d else { return cb(nil, true) }
                if d.isEmpty { return self.next(cb) }
                self.left -= Int64(d.count)
                if self.left == 0 && !self.chunked { self.done = true }
                if self.left == 0 && self.chunked { // the chunk's CRLF
                    self.conn.need(2) { ok in _ = self.conn.take(2); ok ? cb(d, false) : cb(nil, true) }
                    return
                }
                cb(d, false)
            }
        }

        private func chunkSize(_ cb: @escaping (Data?, Bool) -> Void) {
            func line(_ got: @escaping (String?) -> Void) {
                if let i = conn.buf.range(of: Data("\r\n".utf8)) {
                    let s = String(decoding: conn.buf[conn.buf.startIndex..<i.lowerBound], as: UTF8.self)
                    conn.buf = Data(conn.buf[i.upperBound...])
                    return got(s)
                }
                conn.need(conn.buf.count + 1) { ok in ok ? line(got) : got(nil) }
            }
            line { s in
                guard let s = s else { return cb(nil, true) }
                let n = Int64(s.split(separator: ";").first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? "", radix: 16) ?? 0
                if n == 0 {
                    func trailers() { line { t in if let t = t, !t.isEmpty { trailers() } else { self.done = true; cb(nil, false) } } }
                    return trailers()
                }
                self.left = n
                self.next(cb)
            }
        }

        static let reasons = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error"]

        func respond(_ code: Int, _ body: Data = Data()) {
            var h = "HTTP/1.1 \(code) \(Self.reasons[code] ?? "OK")\r\nContent-Type: text/plain\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
            if body.isEmpty { h += "" }
            conn.write(Data(h.utf8) + body) { _ in self.conn.close() }
        }

        // A body of its own: its head (length < 0: until the connection closes), then write() it.
        func streamHead(_ length: Int64 = -1) {
            let h = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n" + (length >= 0 ? "Content-Length: \(length)\r\n" : "") + "Connection: close\r\n\r\n"
            conn.write(Data(h.utf8))
        }

        func write(_ d: Data, _ done: ((Bool) -> Void)? = nil) { conn.write(d, done) }
        func close() { conn.close() }
    }

    // ---- WebSocket ----

    final class Ws {
        let conn: Conn
        var lastRx = Date()
        private(set) var closed = false
        private var queued = 0 // bytes handed to the socket, not sent yet
        init(_ conn: Conn) { self.conn = conn }
        var address: String { conn.address }

        func send(_ text: String) { conn.q.async { self.frame(0x1, Data(text.utf8)) } }

        func frame(_ op: UInt8, _ p: Data) {
            if closed { return }
            var h = Data([0x80 | op])
            if p.count < 126 { h.append(UInt8(p.count)) }
            else if p.count < 65536 { h.append(contentsOf: [126, UInt8(p.count >> 8), UInt8(p.count & 255)]) }
            else { h.append(127); for i in (0..<8).reversed() { h.append(UInt8((p.count >> (i * 8)) & 255)) } }
            queued += h.count + p.count
            let n = h.count + p.count
            conn.write(h + p) { _ in self.conn.q.async { self.queued -= n } }
        }

        var backlog: Int { conn.q.sync { queued } }

        func close() {
            conn.q.async {
                if self.closed { return }
                self.frame(0x8, Data())
                self.closed = true
                self.conn.q.asyncAfter(deadline: .now() + 0.3) { self.conn.close() }
            }
        }
    }

    private func websocket(_ conn: Conn, _ headers: [String: String]) {
        guard let key = headers["sec-websocket-key"] else { return Request(conn, method: "GET", path: "/", headers: [:]).respond(400) }
        let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
        conn.write(Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8))
        let ws = Ws(conn)
        if let h = handler { DispatchQueue.main.async { h.wsOpen(ws) } }
        var msg = Data()
        var msgOp: UInt8 = 0
        let gone = { [weak self] in
            conn.close()
            if let h = self?.handler { DispatchQueue.main.async { h.wsClose(ws) } }
        }
        conn.c.stateUpdateHandler = { st in
            switch st { case .failed, .cancelled: gone(); default: break }
        }
        var ended = false
        func end() { if !ended { ended = true; gone() } }
        func frame() {
            conn.need(2) { ok in
                guard ok else { return end() }
                let b = conn.take(2)
                let fin = b[0] & 0x80 != 0, op = b[0] & 0x0f, masked = b[1] & 0x80 != 0
                let l7 = Int(b[1] & 0x7f)
                let extra = l7 == 126 ? 2 : l7 == 127 ? 8 : 0
                conn.need(extra + (masked ? 4 : 0)) { ok in
                    guard ok else { return end() }
                    var len = l7
                    if extra > 0 { len = conn.take(extra).reduce(0) { $0 << 8 | Int($1) } }
                    guard len >= 0, len <= Self.maxPayload, msg.count + len <= Self.maxPayload else { return end() }
                    let mask = masked ? [UInt8](conn.take(4)) : []
                    conn.need(len) { ok in
                        guard ok else { return end() }
                        var data = [UInt8](conn.take(len))
                        if !mask.isEmpty { for i in data.indices { data[i] ^= mask[i & 3] } }
                        ws.lastRx = Date()
                        switch op {
                        case 0x8: ws.close(); return end()
                        case 0x9: ws.frame(0xA, Data(data))
                        case 0xA: break
                        case 0x0, 0x1, 0x2:
                            if op != 0 { msg = Data(); msgOp = op }
                            msg.append(contentsOf: data)
                            if fin {
                                if msgOp == 1, let h = self.handler {
                                    let text = String(decoding: msg, as: UTF8.self)
                                    DispatchQueue.main.async { h.wsText(ws, text) }
                                }
                                msg = Data()
                                msgOp = 0
                            }
                        default: return end()
                        }
                        frame()
                    }
                }
            }
        }
        frame()
    }
}
