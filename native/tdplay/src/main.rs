// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Headless AirPlay receiver helper based on AirBridge (Jannik Beyerstein) & UxPlay.

mod config;
mod discovery;
mod fairplay;
mod identity;
mod ipc;
mod mirror;
mod ntp;
mod pairing;
mod sps;
mod stream;
mod rtsp;

use anyhow::Result;
use identity::Identity;
use std::io::{self, BufRead};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

fn main() -> Result<()> {
    let mut name = config::DEFAULT_NAME.to_string();
    let mut port = config::DEFAULT_RTSP_PORT;
    let mut mirror_port = config::DEFAULT_MIRROR_PORT;
    let mut key_path_opt: Option<PathBuf> = None;

    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--name" if i + 1 < args.len() => {
                name = args[i + 1].clone();
                i += 2;
            }
            "--port" if i + 1 < args.len() => {
                port = args[i + 1].parse().unwrap_or(config::DEFAULT_RTSP_PORT);
                i += 2;
            }
            "--mirror-port" if i + 1 < args.len() => {
                mirror_port = args[i + 1].parse().unwrap_or(config::DEFAULT_MIRROR_PORT);
                i += 2;
            }
            "--key" if i + 1 < args.len() => {
                key_path_opt = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            _ => {
                i += 1;
            }
        }
    }

    let key_file = identity::key_path(key_path_opt.as_deref());
    let id = Arc::new(Identity::load_or_create(&key_file)?);

    // Announce via mDNS
    let _daemon = discovery::announce(&id, &name, port)?;

    // Shared mirror slot for AES keys
    let slot: mirror::Slot = Arc::new(Mutex::new(None));
    mirror::spawn(Arc::clone(&slot), mirror_port)?;

    // Signal ready to TwinDesk
    let _ = ipc::send_event(&serde_json::json!({
        "event": "ready",
        "name": name,
        "deviceId": id.device_id(),
        "port": port,
        "mirrorPort": mirror_port
    }));

    // Start RTSP server on background thread
    let rtsp_id = Arc::clone(&id);
    let rtsp_slot = Arc::clone(&slot);
    let rtsp_name = name.clone();
    thread::spawn(move || {
        if let Err(e) = rtsp::serve(rtsp_id, rtsp_slot, rtsp_name, port, mirror_port) {
            eprintln!("[tdplay] RTSP server error: {e:#}");
            let _ = ipc::send_event(&serde_json::json!({
                "event": "error",
                "error": e.to_string()
            }));
        }
    });

    // Wait on stdin EOF: when TwinDesk kills/closes the process or pipe, exit cleanly
    let stdin = io::stdin();
    for _ in stdin.lock().lines() {}

    eprintln!("[tdplay] Shutting down AirPlay receiver helper");
    Ok(())
}
