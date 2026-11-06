// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Based on AirBridge (by Jannik Beyerstein, GPL-3.0).

use aes::Aes128;
use anyhow::Result;
use ctr::Ctr128BE;
use ctr::cipher::{KeyIvInit, StreamCipher};
use std::io::{ErrorKind, Read};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

type AesCtr = Ctr128BE<Aes128>;

#[derive(Clone)]
pub struct StreamKeys {
    pub key: [u8; 16],
    pub iv: [u8; 16],
}

pub type Slot = Arc<Mutex<Option<StreamKeys>>>;

const START_CODE: [u8; 4] = [0, 0, 0, 1];

pub fn spawn(slot: Slot, port: u16) -> Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port))?;
    eprintln!("[tdplay] Mirror channel listening on port {port}");
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let keys = slot.lock().unwrap().clone();
            thread::spawn(move || match keys {
                Some(keys) => {
                    let _ = crate::ipc::send_event(&serde_json::json!({
                        "event": "mirror_start",
                        "port": port
                    }));
                    if let Err(e) = handle(stream, keys) {
                        eprintln!("[tdplay] Mirror error: {e:#}");
                    }
                    let _ = crate::ipc::send_event(&serde_json::json!({
                        "event": "mirror_stop"
                    }));
                }
                None => eprintln!("[tdplay] Mirror connection without keys, dropped"),
            });
        }
    });
    Ok(())
}

fn handle(mut stream: TcpStream, keys: StreamKeys) -> Result<()> {
    eprintln!("[tdplay] iPhone video stream connected");
    let mut cipher = AesCtr::new(&keys.key.into(), &keys.iv.into());
    let mut sps_pps: Vec<u8> = Vec::new();
    let mut frames = 0u32;

    loop {
        let mut header = [0u8; 128];
        match stream.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        }
        let size = u32::from_le_bytes(header[0..4].try_into()?) as usize;
        if size > 16 * 1024 * 1024 {
            anyhow::bail!("implausible packet size {size}");
        }
        let mut payload = vec![0u8; size];
        stream.read_exact(&mut payload)?;

        match header[4] {
            0 => {
                cipher.apply_keystream(&mut payload);
                if !to_annex_b(&mut payload) {
                    continue;
                }
                frames += 1;
                let mut picture = std::mem::take(&mut sps_pps);
                picture.extend_from_slice(&payload);
                if let Err(_) = crate::ipc::send_frame(crate::ipc::TYPE_VIDEO, &picture) {
                    break;
                }
            }
            1 => {
                if let Some(p) = parse_avcc(&payload) {
                    sps_pps = p;
                }
            }
            _ => {} // heartbeat / report
        }
    }
    eprintln!("[tdplay] iPhone video stream disconnected ({frames} frames delivered)");
    Ok(())
}

fn to_annex_b(buf: &mut [u8]) -> bool {
    let mut pos = 0;
    while pos < buf.len() {
        if pos + 4 > buf.len() {
            return false;
        }
        let len = u32::from_be_bytes(buf[pos..pos + 4].try_into().unwrap()) as usize;
        if len == 0 || len > buf.len() - pos - 4 {
            return false;
        }
        buf[pos..pos + 4].copy_from_slice(&START_CODE);
        pos += 4;
        if buf[pos] & 0x80 != 0 {
            return false;
        }
        pos += len;
    }
    !buf.is_empty()
}

fn parse_avcc(p: &[u8]) -> Option<Vec<u8>> {
    let sps_len = u16::from_be_bytes(p.get(6..8)?.try_into().ok()?) as usize;
    let sps = p.get(8..8 + sps_len)?;
    let pps_len = u16::from_be_bytes(p.get(9 + sps_len..11 + sps_len)?.try_into().ok()?) as usize;
    let pps = p.get(11 + sps_len..11 + sps_len + pps_len)?;
    let sps = crate::sps::low_latency(sps).unwrap_or_else(|| sps.to_vec());
    let mut out = Vec::new();
    out.extend_from_slice(&START_CODE);
    out.extend_from_slice(&sps);
    out.extend_from_slice(&START_CODE);
    out.extend_from_slice(pps);
    Some(out)
}
