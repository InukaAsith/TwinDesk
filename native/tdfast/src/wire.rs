// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The input lane's wire, byte for byte as shared/inputlane.js (the reference):
//   0..2 'T''L' | 2 ver=1 | 3 type | 4..12 seq u64 LE | AES-256-GCM(body) | 16-byte tag
//   AAD = bytes 0..12, nonce = 00000000 ‖ seq (8 bytes LE).
//   keys = HKDF-SHA256(key, empty salt, "twindesk-il-v1 host" | "twindesk-il-v1 guest", 32).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;

pub const HDR: usize = 12;
pub const TAG: usize = 16;
pub const MAX_PACKET: usize = 1200;
pub const VER: u8 = 1;
pub const PING: u8 = 1;
pub const PONG: u8 = 2;
pub const MOVE: u8 = 3;
pub const EVENTS: u8 = 4;
pub const MOVE_BODY: usize = 28;
pub const EVENTS_KEEP: usize = 4;
pub const WINDOW: u64 = 64;

pub struct Keys {
    pub tx: Aes256Gcm,
    pub rx: Aes256Gcm,
    pub tx_raw: [u8; 32],
    pub rx_raw: [u8; 32],
}

fn derive(key: &[u8], role: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, key);
    let mut out = [0u8; 32];
    hk.expand(format!("twindesk-il-v1 {role}").as_bytes(), &mut out).expect("32 bytes");
    out
}

/// role: "host" | "guest" (which key we seal with).
pub fn derive_keys(key: &[u8; 32], role: &str) -> Keys {
    let other = if role == "host" { "guest" } else { "host" };
    let tx_raw = derive(key, role);
    let rx_raw = derive(key, other);
    Keys {
        tx: Aes256Gcm::new_from_slice(&tx_raw).expect("key"),
        rx: Aes256Gcm::new_from_slice(&rx_raw).expect("key"),
        tx_raw,
        rx_raw,
    }
}

fn nonce(seq: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&seq.to_le_bytes());
    n
}

pub fn seal(key: &Aes256Gcm, typ: u8, seq: u64, body: &[u8]) -> Vec<u8> {
    let mut hdr = [0u8; HDR];
    hdr[0] = b'T';
    hdr[1] = b'L';
    hdr[2] = VER;
    hdr[3] = typ;
    hdr[4..12].copy_from_slice(&seq.to_le_bytes());
    let n = nonce(seq);
    let ct = key.encrypt(Nonce::from_slice(&n), Payload { msg: body, aad: &hdr }).expect("seal");
    let mut out = Vec::with_capacity(HDR + ct.len());
    out.extend_from_slice(&hdr);
    out.extend_from_slice(&ct);
    out
}

/// (type, seq, body), or None (not ours, or not authentic).
pub fn open(key: &Aes256Gcm, pkt: &[u8]) -> Option<(u8, u64, Vec<u8>)> {
    if pkt.len() < HDR + TAG || pkt.len() > MAX_PACKET || pkt[0] != b'T' || pkt[1] != b'L' || pkt[2] != VER {
        return None;
    }
    let seq = u64::from_le_bytes(pkt[4..12].try_into().ok()?);
    let n = nonce(seq);
    let body = key.decrypt(Nonce::from_slice(&n), Payload { msg: &pkt[HDR..], aad: &pkt[..HDR] }).ok()?;
    Some((pkt[3], seq, body))
}

/// 64-wide sliding replay window: each slot holds the last seq seen there.
pub struct ReplayWindow {
    slots: [u64; WINDOW as usize],
    max: u64,
}

impl ReplayWindow {
    pub fn new() -> Self {
        ReplayWindow { slots: [0; WINDOW as usize], max: 0 }
    }
    pub fn ok(&self, seq: u64) -> bool {
        if seq < 1 {
            return false;
        }
        if seq > self.max {
            return true;
        }
        if self.max - seq >= WINDOW {
            return false;
        }
        self.slots[(seq % WINDOW) as usize] != seq
    }
    pub fn mark(&mut self, seq: u64) {
        self.slots[(seq % WINDOW) as usize] = seq;
        if seq > self.max {
            self.max = seq;
        }
    }
}

impl Default for ReplayWindow {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Move {
    pub route: u32,
    pub mn: u32,
    pub es: u32,
    pub cx: f64,
    pub cy: f64,
}

pub fn encode_move(s: &Move) -> [u8; MOVE_BODY] {
    let mut b = [0u8; MOVE_BODY];
    b[0..4].copy_from_slice(&s.route.to_le_bytes());
    b[4..8].copy_from_slice(&s.mn.to_le_bytes());
    b[8..12].copy_from_slice(&s.es.to_le_bytes());
    b[12..20].copy_from_slice(&s.cx.to_le_bytes());
    b[20..28].copy_from_slice(&s.cy.to_le_bytes());
    b
}

pub fn decode_move(b: &[u8]) -> Option<Move> {
    if b.len() != MOVE_BODY {
        return None;
    }
    let u = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let f = |o: usize| f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    let s = Move { route: u(0), mn: u(4), es: u(8), cx: f(12), cy: f(20) };
    if s.cx.is_finite() && s.cy.is_finite() {
        Some(s)
    } else {
        None
    }
}

/// events: (es, json) newest last; as many of the newest as fit, EVENTS_KEEP at most (as JS).
pub fn encode_events(events: &[(u32, Vec<u8>)]) -> Option<Vec<u8>> {
    let room = MAX_PACKET - HDR - TAG - 1;
    let mut picked: Vec<&(u32, Vec<u8>)> = Vec::new();
    let mut used = 0;
    for e in events.iter().rev() {
        if picked.len() >= EVENTS_KEEP {
            break;
        }
        let len = 6 + e.1.len();
        if used + len > room {
            break;
        }
        picked.push(e);
        used += len;
    }
    if picked.is_empty() {
        return None;
    }
    picked.reverse();
    let mut out = Vec::with_capacity(1 + used);
    out.push(picked.len() as u8);
    for (es, json) in picked {
        out.extend_from_slice(&es.to_le_bytes());
        out.extend_from_slice(&(json.len() as u16).to_le_bytes());
        out.extend_from_slice(json);
    }
    Some(out)
}

/// (es, json bytes) for each well-formed event.
pub fn decode_events(b: &[u8]) -> Vec<(u32, Vec<u8>)> {
    let mut out = Vec::new();
    if b.is_empty() {
        return out;
    }
    let n = b[0] as usize;
    let mut off = 1;
    for _ in 0..n {
        if off + 6 > b.len() {
            break;
        }
        let es = u32::from_le_bytes(b[off..off + 4].try_into().unwrap());
        let len = u16::from_le_bytes(b[off + 4..off + 6].try_into().unwrap()) as usize;
        off += 6;
        if off + len > b.len() {
            break;
        }
        out.push((es, b[off..off + len].to_vec()));
        off += len;
    }
    out
}

pub fn hex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}
