// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Based on AirBridge (by Jannik Beyerstein, GPL-3.0).

use crate::fairplay::FairPlay;
use crate::mirror::{Slot, StreamKeys};
use crate::ntp;
use anyhow::{anyhow, Result};
use plist::{Dictionary, Value};
use sha2::{Digest, Sha512};
use std::io::Cursor;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Default)]
pub struct StreamState {
    aes_key: Option<[u8; 16]>,
    aes_iv: Option<[u8; 16]>,
    _sockets: Vec<UdpSocket>,
    stop: Arc<AtomicBool>,
}

impl Drop for StreamState {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn sha512(parts: &[&[u8]]) -> [u8; 64] {
    let mut h = Sha512::new();
    for p in parts {
        h.update(p);
    }
    let digest = h.finalize();
    let mut out = [0u8; 64];
    out.copy_from_slice(&digest);
    out
}

fn num(v: u64) -> Value {
    Value::Integer(v.into())
}

pub fn setup(
    st: &mut StreamState,
    fp: &FairPlay,
    ecdh_secret: Option<[u8; 32]>,
    peer_ip: Option<IpAddr>,
    mirror: &Slot,
    mirror_port: u16,
    body: &[u8],
) -> Result<Vec<u8>> {
    let req = Value::from_reader(Cursor::new(body))?;
    let dict = req
        .as_dictionary()
        .ok_or_else(|| anyhow!("SETUP body is not a Dictionary"))?;
    let mut res = Dictionary::new();

    // --- SETUP 1: keys ---
    if let (Some(ekey), Some(eiv)) = (
        dict.get("ekey").and_then(|v| v.as_data()),
        dict.get("eiv").and_then(|v| v.as_data()),
    ) {
        let text = |key: &str| {
            dict.get(key)
                .and_then(|v| v.as_string())
                .map(str::to_string)
        };
        let ip = peer_ip.map(|i| i.to_string()).unwrap_or_default();
        let device_name = text("name").unwrap_or_else(|| format!("Apple Device ({ip})"));
        let device_id = text("deviceID")
            .or_else(|| text("macAddress"))
            .unwrap_or_else(|| ip.clone());

        let _ = crate::ipc::send_event(&serde_json::json!({
            "event": "client_connecting",
            "name": device_name,
            "deviceId": device_id,
            "ip": ip
        }));

        let fp_key = fp.decrypt_key(ekey)?;
        let key: [u8; 16] = match ecdh_secret {
            Some(secret) => sha512(&[&fp_key, &secret])[..16].try_into()?,
            None => fp_key,
        };
        st.aes_key = Some(key);
        st.aes_iv = Some(
            eiv.try_into()
                .map_err(|_| anyhow!("eiv does not have 16 bytes"))?,
        );

        let socket = UdpSocket::bind(("0.0.0.0", 0))?;
        let timing = socket.local_addr()?.port();
        let remote_port = dict.get("timingPort").and_then(|v| v.as_unsigned_integer());
        if let (Some(ip), Some(rport)) = (peer_ip, remote_port) {
            ntp::start(
                socket.try_clone()?,
                SocketAddr::new(ip, rport as u16),
                Arc::clone(&st.stop),
            );
        }
        st._sockets.push(socket);
        res.insert("timingPort".into(), num(timing as u64));
        res.insert("eventPort".into(), num(0));
    }

    // --- SETUP 2: streams ---
    if let Some(streams) = dict.get("streams").and_then(|v| v.as_array()) {
        let mut out = Vec::new();
        for s in streams {
            let d = s
                .as_dictionary()
                .ok_or_else(|| anyhow!("stream is not a Dictionary"))?;
            let ty = d
                .get("type")
                .and_then(|v| v.as_unsigned_integer())
                .unwrap_or(0);
            let mut entry = Dictionary::new();
            match ty {
                110 => {
                    let id = d
                        .get("streamConnectionID")
                        .and_then(|v| {
                            v.as_unsigned_integer()
                                .or_else(|| v.as_signed_integer().map(|i| i as u64))
                        })
                        .ok_or_else(|| anyhow!("streamConnectionID missing"))?;
                    let base = st
                        .aes_key
                        .ok_or_else(|| anyhow!("stream setup before key setup"))?;
                    let key = sha512(&[format!("AirPlayStreamKey{id}").as_bytes(), &base]);
                    let iv = sha512(&[format!("AirPlayStreamIV{id}").as_bytes(), &base]);
                    *mirror.lock().unwrap() = Some(StreamKeys {
                        key: key[..16].try_into()?,
                        iv: iv[..16].try_into()?,
                    });
                    entry.insert("dataPort".into(), num(mirror_port as u64));
                    entry.insert("type".into(), num(110));
                }
                _ => {}
            }
            out.push(Value::Dictionary(entry));
        }
        res.insert("streams".into(), Value::Array(out));
    }

    let mut out = Vec::new();
    Value::Dictionary(res).to_writer_binary(&mut out)?;
    Ok(out)
}
