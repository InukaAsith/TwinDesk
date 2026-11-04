// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The input lane in the helper (docs/protocol.md): what shared/inputlane.js's InputLane, MoveTotals,
// MoveApply and LaneDriven do for moves, with the same timings, so a native peer and a JS peer behave
// alike. One thread: recv with a 1 ms timeout drives the throttle, the tail resends and the pings.
// td_move runs on the event tap's thread: a short lock and a send, never a wait.

use crate::wire::*;
use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MOVE_GAP: Duration = Duration::from_millis(2);
const TAILS: [u64; 2] = [8, 24];
const PING_UP: u64 = 100;
const PING_ACTIVE: u64 = 250;
const PING_IDLE: u64 = 1000;
const DOWN_AFTER: u64 = 3;
const RESEND_FOR: Duration = Duration::from_secs(3);
const RTT_EVERY: Duration = Duration::from_secs(5);

/// What the lane tells the helper (outside the lock).
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    /// Driven: a delta to inject (speed applied; deduplicated; in order with the events).
    Move(f64, f64),
    /// An event from the lane: its JSON with "es" in it.
    Event(Vec<u8>),
    /// Up, with the rtt (ms): when it comes up, then again every RTT_EVERY with the latest.
    Up(f64),
    Down,
}

pub type Sink = Box<dyn Fn(Out) + Send + Sync>;

struct Session {
    keys: Keys,
    peer: SocketAddr,
    qos: Option<crate::qos::Flow>, // Windows: the voice flow to peer (qos.rs)
    seq: u64,
    win: ReplayWindow,
    up: bool,
    rtt_ms: f64,
    rtt_told: Option<Instant>,
    last_pong: Option<Instant>,
    ping_every: u64,
    next_ping: Instant,
    // driving
    drive_route: u32,
    mn: u32,
    cx: f64,
    cy: f64,
    es: u32,
    mv: Option<Move>,
    move_at: Option<Instant>,
    move_due: Option<Instant>,
    move_tails: Vec<Instant>,
    events: VecDeque<(u32, Vec<u8>)>,
    event_tails: Vec<Instant>,
    // driven
    d_route: u32,
    speed: f64,
    hold: bool,
    held_d: (f64, f64),
    ma_mn: u32,
    ma_cx: f64,
    ma_cy: f64,
    done: u32,
    held: Option<Move>,
    early: Option<Move>,
}

pub struct Lane {
    sock: Option<Arc<UdpSocket>>,
    sock4: Option<Arc<UdpSocket>>, // Windows: IPv4 on the same port (qWAVE can't flow a dual-stack socket's IPv4)
    v6: bool,
    port: u16,
    active: bool,
    sess: Option<Session>,
    sink: Option<Arc<Sink>>,
    loss: f64,
    rng: u64,
    epoch: Instant,
    pub sent: u64,
    pub received: u64,
}

fn now_us(epoch: Instant) -> u64 {
    epoch.elapsed().as_micros() as u64
}

impl Lane {
    fn new() -> Self {
        let loss = std::env::var("TWINDESK_LANE_LOSS").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        Lane {
            sock: None, sock4: None, v6: true, port: 0, active: false, sess: None, sink: None, loss,
            rng: 0x9E3779B97F4A7C15 ^ (std::process::id() as u64), epoch: Instant::now(), sent: 0, received: 0,
        }
    }

    fn rand(&mut self) -> f64 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        (self.rng >> 11) as f64 / (1u64 << 53) as f64
    }

    fn target(&self, ip: &str) -> Option<IpAddr> {
        let ip = ip.trim_start_matches("::ffff:");
        let ip = ip.split('%').next().unwrap_or(ip);
        match ip.parse::<IpAddr>().ok()? {
            IpAddr::V4(v4) => Some(if self.v6 && self.sock4.is_none() { IpAddr::V6(v4.to_ipv6_mapped()) } else { IpAddr::V4(v4) }),
            IpAddr::V6(v6) => if self.v6 { Some(IpAddr::V6(v6)) } else { None },
        }
    }

    // The socket that reaches peer: the IPv4 one for an IPv4 peer when there are two.
    fn sock_for(&self, peer: SocketAddr) -> Option<Arc<UdpSocket>> {
        match &self.sock4 {
            Some(s4) if peer.is_ipv4() => Some(s4.clone()),
            _ => self.sock.clone(),
        }
    }

    fn send(&mut self, typ: u8, body: &[u8]) {
        let peer = match &self.sess { Some(s) => s.peer, None => return };
        let (sock, s) = match (self.sock_for(peer), &mut self.sess) {
            (Some(sock), Some(s)) => (sock, s),
            _ => return,
        };
        s.seq += 1;
        let pkt = seal(&s.keys.tx, typ, s.seq, body);
        if self.loss > 0.0 && self.rand() < self.loss {
            return;
        }
        self.sent += 1;
        let _ = sock.send_to(&pkt, peer);
    }

    fn set_up(&mut self, up: bool, out: &mut Vec<Out>) {
        let active = self.active;
        let s = match &mut self.sess { Some(s) => s, None => return };
        let now = Instant::now();
        if s.up == up {
            // Up again every RTT_EVERY with the latest rtt: the helpers pass it on, and Node's [link] line has it.
            if up && s.rtt_told.map_or(true, |t| now.duration_since(t) >= RTT_EVERY) {
                s.rtt_told = Some(now);
                out.push(Out::Up(s.rtt_ms));
            }
            return;
        }
        s.up = up;
        s.ping_every = if up { if active { PING_ACTIVE } else { PING_IDLE } } else { PING_UP };
        s.next_ping = now; // a ping at once, as the JS _pingLoop
        if up {
            s.rtt_told = Some(now);
        }
        out.push(if up { Out::Up(s.rtt_ms) } else { Out::Down });
    }

    fn ping(&mut self, now: Instant, out: &mut Vec<Out>) {
        let (up, overdue) = match &self.sess {
            Some(s) => (s.up, s.last_pong.map_or(true, |t| now.duration_since(t) > Duration::from_millis(DOWN_AFTER * s.ping_every + 50))),
            None => return,
        };
        if up && overdue {
            self.set_up(false, out);
        }
        let t = now_us(self.epoch);
        self.send(PING, &t.to_le_bytes());
        let active = self.active;
        let resend = match &self.sess {
            Some(s) if s.up && active => match (s.mv, s.move_at) {
                (Some(m), Some(at)) if now.duration_since(at) < RESEND_FOR => Some(m),
                _ => None,
            },
            _ => None,
        };
        if let Some(m) = resend {
            self.send(MOVE, &encode_move(&m));
        }
        if let Some(s) = &mut self.sess {
            s.next_ping = now + Duration::from_millis(s.ping_every);
        }
    }

    fn flush_move(&mut self, now: Instant) {
        let m = match &mut self.sess {
            Some(s) => {
                s.move_due = None;
                match s.mv { Some(m) => { s.move_at = Some(now); s.move_tails = TAILS.iter().map(|ms| now + Duration::from_millis(*ms)).collect(); m } None => return }
            }
            None => return,
        };
        self.send(MOVE, &encode_move(&m));
    }

    fn send_events(&mut self) {
        let body = match &mut self.sess {
            Some(s) => encode_events(s.events.make_contiguous()),
            None => None,
        };
        if let Some(b) = body {
            self.send(EVENTS, &b);
        }
    }

    /// Timers due: the throttled move, the tails, the ping.
    fn tick(&mut self, now: Instant, out: &mut Vec<Out>) {
        let (due, mtail, etail, ping) = match &mut self.sess {
            Some(s) => {
                let due = s.move_due.map_or(false, |t| now >= t);
                let mt = s.move_tails.first().map_or(false, |t| now >= *t);
                if mt { s.move_tails.remove(0); }
                let et = s.event_tails.first().map_or(false, |t| now >= *t);
                if et { s.event_tails.remove(0); }
                (due, mt, et, now >= s.next_ping)
            }
            None => return,
        };
        if due {
            self.flush_move(now);
        }
        if mtail {
            if let Some(m) = self.sess.as_ref().and_then(|s| s.mv) {
                self.send(MOVE, &encode_move(&m));
            }
        }
        if etail {
            self.send_events();
        }
        if ping {
            self.ping(now, out);
        }
    }

    fn packet(&mut self, pkt: &[u8], from: SocketAddr, out: &mut Vec<Out>) {
        let reply = self.sock_for(from);
        let (typ, body) = {
            let s = match &mut self.sess { Some(s) => s, None => return };
            let (typ, seq, body) = match open(&s.keys.rx, pkt) { Some(p) => p, None => return };
            if !s.win.ok(seq) {
                return;
            }
            s.win.mark(seq);
            if s.peer != from {
                s.peer = from; // the lane follows a switch between Wi-Fi and cable
                if let Some(sock) = &reply {
                    s.qos = None;
                    s.qos = crate::qos::Flow::add(sock, from);
                }
            }
            (typ, body)
        };
        self.received += 1;
        match typ {
            PING if body.len() == 8 => self.send(PONG, &body),
            PONG if body.len() == 8 => {
                let t = u64::from_le_bytes(body[..8].try_into().unwrap());
                let rtt = (now_us(self.epoch) as f64 - t as f64) / 1000.0;
                if let Some(s) = &mut self.sess {
                    if (0.0..10000.0).contains(&rtt) {
                        s.rtt_ms = rtt;
                    }
                    s.last_pong = Some(Instant::now());
                }
                self.set_up(true, out);
            }
            MOVE => {
                if let Some(m) = decode_move(&body) {
                    if let Some(s) = &mut self.sess {
                        s.driven_move(m, out);
                    }
                }
            }
            EVENTS => {
                for (es, json) in decode_events(&body) {
                    if let Some(j) = with_es(&json, es) {
                        out.push(Out::Event(j));
                    }
                }
            }
            _ => {}
        }
    }
}

// {"es":N, …the event's fields} (the JSON lane copy, as inputlane.js's decodeEvents gives it).
fn with_es(json: &[u8], es: u32) -> Option<Vec<u8>> {
    if json.len() < 2 || json[0] != b'{' || json[json.len() - 1] != b'}' {
        return None;
    }
    let rest = &json[1..];
    let mut v = format!("{{\"es\":{es}").into_bytes();
    if rest != b"}" {
        v.push(b',');
    }
    v.extend_from_slice(rest);
    Some(v)
}

impl Session {
    // LaneDriven.move: totals for this crossing, after the event they name.
    fn driven_move(&mut self, m: Move, out: &mut Vec<Out>) {
        if m.route != self.d_route {
            if m.route > self.d_route && self.early.map_or(true, |e| e.route != m.route || m.mn > e.mn) {
                self.early = Some(m);
            }
            return;
        }
        if m.es > self.done {
            if self.held.map_or(true, |h| m.mn > h.mn) {
                self.held = Some(m);
            }
            return;
        }
        if let Some((dx, dy)) = self.take(m) {
            self.inject(dx, dy, out);
        }
    }

    // MoveApply.take: what's new in a total, once (only a newer mn counts), speed applied.
    fn take(&mut self, m: Move) -> Option<(f64, f64)> {
        if m.route != self.d_route || m.mn <= self.ma_mn {
            return None;
        }
        let d = ((m.cx - self.ma_cx) * self.speed, (m.cy - self.ma_cy) * self.speed);
        self.ma_mn = m.mn;
        self.ma_cx = m.cx;
        self.ma_cy = m.cy;
        if d.0 == 0.0 && d.1 == 0.0 { None } else { Some(d) }
    }

    fn inject(&mut self, dx: f64, dy: f64, out: &mut Vec<Out>) {
        if self.hold {
            self.held_d.0 += dx;
            self.held_d.1 += dy;
        } else {
            out.push(Out::Move(dx, dy));
        }
    }
}

// ---- the one lane of the process ----

static LANE: OnceLock<Mutex<Lane>> = OnceLock::new();

fn lane() -> &'static Mutex<Lane> {
    LANE.get_or_init(|| Mutex::new(Lane::new()))
}

fn with<R>(f: impl FnOnce(&mut Lane, &mut Vec<Out>) -> R) -> R {
    let mut out = Vec::new();
    let (r, sink) = {
        let mut l = lane().lock().unwrap_or_else(|e| e.into_inner());
        let r = f(&mut l, &mut out);
        (r, l.sink.clone())
    };
    if let Some(sink) = sink {
        for o in out {
            sink(o);
        }
    }
    r
}

// The lane's socket: dual-stack where it can be, IPv4 otherwise. On Windows, an IPv6-only socket and
// an IPv4 one on the same port instead, as qWAVE (qos.rs) can't put a dual-stack socket's IPv4 in a flow.
fn make_socket() -> Option<(UdpSocket, bool, Option<UdpSocket>)> {
    use socket2::{Domain, Protocol, Socket, Type};
    #[cfg(windows)]
    for _ in 0..8 {
        let v6 = match Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP)) { Ok(s) => s, Err(_) => break };
        if v6.set_only_v6(true).is_err() || v6.bind(&SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0).into()).is_err() {
            break;
        }
        let port = match v6.local_addr().ok().and_then(|a| a.as_socket()) { Some(a) => a.port(), None => break };
        let v4 = match Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)) { Ok(s) => s, Err(_) => break };
        if v4.bind(&SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port).into()).is_ok() {
            return Some((tune(v6, true), true, Some(tune(v4, false))));
        } // that port is taken on IPv4: another one
    }
    let v6 = Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP)).ok().and_then(|s| {
        s.set_only_v6(false).ok()?;
        s.bind(&SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0).into()).ok()?;
        Some(s)
    });
    let (s, is6) = match v6 {
        Some(s) => (s, true),
        None => {
            let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).ok()?;
            s.bind(&SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0).into()).ok()?;
            (s, false)
        }
    };
    Some((tune(s, is6), is6, None))
}

fn tune(s: socket2::Socket, is6: bool) -> UdpSocket {
    let _ = s.set_send_buffer_size(256 * 1024);
    // DSCP EF (voice): Wi-Fi's WMM voice queue sends input ahead of screen video and files. Best effort.
    let _ = s.set_tos(0xB8);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if is6 {
        let _ = s.set_tclass_v6(0xB8);
    }
    let _ = is6; // Windows: qWAVE instead (qos.rs)
    let _ = s.set_read_timeout(Some(Duration::from_millis(1)));
    s.into()
}

fn run(sock: Arc<UdpSocket>) {
    let mut buf = [0u8; 2048];
    loop {
        let got = sock.recv_from(&mut buf);
        with(|l, out| {
            if let Ok((n, from)) = got {
                if n <= MAX_PACKET {
                    l.packet(&buf[..n], from, out);
                }
            }
            l.tick(Instant::now(), out);
        });
    }
}

// ---- the API (ffi.rs wraps it for C) ----

/// The socket (once, dual-stack where it can be) and its thread: the port, 0 when there's none.
pub fn bind() -> u16 {
    with(|l, _| {
        if l.port != 0 {
            return l.port;
        }
        let (s, v6, s4) = match make_socket() { Some(x) => x, None => return 0 };
        let port = s.local_addr().map(|a| a.port()).unwrap_or(0);
        let s = Arc::new(s);
        l.sock = Some(s.clone());
        l.v6 = v6;
        l.port = port;
        std::thread::Builder::new().name("tdfast-lane".into()).spawn(move || run(s)).ok();
        if let Some(s4) = s4 {
            let s4 = Arc::new(s4);
            l.sock4 = Some(s4.clone());
            std::thread::Builder::new().name("tdfast-lane4".into()).spawn(move || run(s4)).ok();
        }
        port
    })
}

pub fn set_sink(sink: Option<Sink>) {
    with(|l, _| l.sink = sink.map(Arc::new));
}

/// A session: role "host" | "guest", the welcome's key (64 hex), the peer's address. false: can't.
pub fn start(role: &str, key_hex: &str, ip: &str, port: u16) -> bool {
    with(|l, out| {
        let key = match hex32(key_hex) { Some(k) => k, None => return false };
        let addr = match l.target(ip) { Some(a) => a, None => return false };
        if l.sock.is_none() || port == 0 {
            return false;
        }
        stop_in(l, out);
        let now = Instant::now();
        let peer = SocketAddr::new(addr, port);
        let qos = l.sock_for(peer).and_then(|sock| crate::qos::Flow::add(&sock, peer));
        l.sess = Some(Session {
            keys: derive_keys(&key, if role == "host" { "host" } else { "guest" }),
            peer, qos, seq: 0, win: ReplayWindow::new(), up: false, rtt_ms: -1.0, rtt_told: None, last_pong: None,
            ping_every: PING_UP, next_ping: now,
            drive_route: 0, mn: 0, cx: 0.0, cy: 0.0, es: 0, mv: None, move_at: None, move_due: None, move_tails: vec![],
            events: VecDeque::new(), event_tails: vec![],
            d_route: 0, speed: 1.0, hold: false, held_d: (0.0, 0.0), ma_mn: 0, ma_cx: 0.0, ma_cy: 0.0, done: 0, held: None, early: None,
        });
        l.ping(now, out);
        true
    })
}

fn stop_in(l: &mut Lane, out: &mut Vec<Out>) {
    if let Some(s) = l.sess.take() {
        if s.up {
            out.push(Out::Down);
        }
    }
}

/// The session ended: no keys, no pings; the socket stays for the next one.
pub fn stop() {
    with(|l, out| stop_in(l, out));
}

pub fn is_up() -> bool {
    with(|l, _| l.sess.as_ref().map_or(false, |s| s.up))
}

pub fn rtt_ms() -> f64 {
    with(|l, _| l.sess.as_ref().map_or(-1.0, |s| s.rtt_ms))
}

pub fn active(on: bool) {
    with(|l, _| {
        if l.active == on {
            return;
        }
        l.active = on;
        if let Some(s) = &mut l.sess {
            if s.up {
                s.ping_every = if on { PING_ACTIVE } else { PING_IDLE };
                s.next_ping = Instant::now();
            }
        }
    })
}

/// Driving from this crossing (route 0: not driving).
pub fn drive_reset(route: u32) {
    with(|l, _| {
        if let Some(s) = &mut l.sess {
            s.drive_route = route;
            s.mn = 0;
            s.cx = 0.0;
            s.cy = 0.0;
            s.mv = None;
            s.move_due = None;
            s.move_tails.clear();
        }
    })
}

/// A move while driving: (sent on the lane, the totals). None: not driving on a lane (as always).
pub fn move_by(dx: f64, dy: f64) -> Option<(bool, Move)> {
    with(|l, _| {
        let now = Instant::now();
        let (up, m, flush_now) = {
            let s = l.sess.as_mut()?;
            if s.drive_route == 0 {
                return None;
            }
            s.mn += 1;
            s.cx += dx;
            s.cy += dy;
            let m = Move { route: s.drive_route, mn: s.mn, es: s.es, cx: s.cx, cy: s.cy };
            if !s.up {
                return Some((false, m));
            }
            s.mv = Some(m);
            let mut flush_now = false;
            if s.move_due.is_none() {
                match s.move_at {
                    Some(at) if now.duration_since(at) < MOVE_GAP => s.move_due = Some(at + MOVE_GAP),
                    _ => flush_now = true,
                }
            }
            (true, m, flush_now)
        };
        if flush_now {
            l.flush_move(now);
        }
        Some((up, m))
    })
}

/// A click, key, wheel or gesture while driving: its event number and fence (where the moves took the
/// pointer). None: no session.
pub fn fence() -> Option<(u32, Move)> {
    with(|l, _| {
        let s = l.sess.as_mut()?;
        s.es += 1;
        Some((s.es, Move { route: s.drive_route, mn: s.mn, es: s.es, cx: s.cx, cy: s.cy }))
    })
}

/// An event (its JSON without es; es from fence()) on the lane, with the few before it.
pub fn send_event(json: &[u8], es: u32) {
    with(|l, _| {
        if json.len() > MAX_PACKET - HDR - TAG - 7 {
            return; // too big: its WSS copy is enough
        }
        let now = Instant::now();
        match &mut l.sess {
            Some(s) if s.up => {
                s.events.push_back((es, json.to_vec()));
                while s.events.len() > EVENTS_KEEP {
                    s.events.pop_front();
                }
                s.event_tails = TAILS.iter().map(|ms| now + Duration::from_millis(*ms)).collect();
            }
            _ => return,
        }
        l.send_events();
    })
}

/// Driven by this crossing (kvm.take), with this speed; route 0: not driven.
pub fn driven(route: u32, speed: f64) {
    with(|l, out| {
        if let Some(s) = &mut l.sess {
            s.d_route = route;
            s.speed = if speed.is_finite() && speed > 0.0 { speed } else { 1.0 };
            s.ma_mn = 0;
            s.ma_cx = 0.0;
            s.ma_cy = 0.0;
            s.held = None;
            s.hold = false;
            s.held_d = (0.0, 0.0);
            if let Some(e) = s.early.take() {
                if e.route == route {
                    s.driven_move(e, out);
                }
            }
        }
    })
}

/// Hold the moves (a drag from the other computer starts where the pointer came in): summed, then
/// injected as one when it ends.
pub fn hold(on: bool) {
    with(|l, out| {
        if let Some(s) = &mut l.sess {
            s.hold = on;
            if !on && (s.held_d.0 != 0.0 || s.held_d.1 != 0.0) {
                out.push(Out::Move(s.held_d.0, s.held_d.1));
                s.held_d = (0.0, 0.0);
            }
        }
    })
}

/// A fence (an event's, or a WSS k.mm's totals): the delta to inject first (speed applied), if any.
pub fn fence_apply(route: u32, mn: u32, cx: f64, cy: f64) -> Option<(f64, f64)> {
    with(|l, _| {
        let s = l.sess.as_mut()?;
        let d = s.take(Move { route, mn, es: 0, cx, cy })?;
        if s.hold {
            s.held_d.0 += d.0;
            s.held_d.1 += d.1;
            return None;
        }
        Some(d)
    })
}

/// Every event up to es is through (after it was injected): a move that waited for it goes now.
pub fn done(es: u32) {
    with(|l, out| {
        if let Some(s) = &mut l.sess {
            if es > s.done {
                s.done = es;
            }
            if let Some(h) = s.held {
                if h.es <= s.done {
                    s.held = None;
                    s.driven_move(h, out);
                }
            }
        }
    })
}

pub fn counts() -> (u64, u64) {
    with(|l, _| (l.sent, l.received))
}
