// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Standard binary framing over stdout to TwinDesk host process:
//   [4B magic: 'T', 'D', 'P', '1']
//   [1B packet type: 0 = JSON event, 1 = H.264 Annex-B Video frame, 2 = Audio]
//   [4B length (BE u32)]
//   [payload...]

use std::io::{self, Write};
use std::sync::Mutex;
use serde::Serialize;

pub const MAGIC: [u8; 4] = *b"TDP1";
pub const TYPE_EVENT: u8 = 0;
pub const TYPE_VIDEO: u8 = 1;
#[allow(dead_code)]
pub const TYPE_AUDIO: u8 = 2;

static STDOUT_LOCK: Mutex<()> = Mutex::new(());

pub fn send_frame(packet_type: u8, payload: &[u8]) -> io::Result<()> {
    let _guard = STDOUT_LOCK.lock().unwrap();
    let mut stdout = io::stdout().lock();
    stdout.write_all(&MAGIC)?;
    stdout.write_all(&[packet_type])?;
    stdout.write_all(&(payload.len() as u32).to_be_bytes())?;
    stdout.write_all(payload)?;
    stdout.flush()
}

pub fn send_event<T: Serialize>(event: &T) -> io::Result<()> {
    if let Ok(json) = serde_json::to_vec(event) {
        send_frame(TYPE_EVENT, &json)?;
    }
    Ok(())
}
