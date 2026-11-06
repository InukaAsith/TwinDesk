// Minimal NTP client for AirPlay. In AirPlay the RECEIVER is the one asking:
// it regularly sends 32-byte requests to the iPhone's "timingPort".
// If the requests stop, iOS tends to drop the connection.
// We do not evaluate the replies yet (audio/video sync is on the roadmap).
use std::net::{SocketAddr, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// NTP time: 32 bits of seconds since 1900 + 32 bits of fraction, big endian.
fn ntp_now() -> [u8; 8] {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs() + 2_208_988_800;
    let frac = ((d.subsec_nanos() as u64) << 32) / 1_000_000_000;
    let mut b = [0u8; 8];
    b[..4].copy_from_slice(&(secs as u32).to_be_bytes());
    b[4..].copy_from_slice(&(frac as u32).to_be_bytes());
    b
}

pub fn start(socket: UdpSocket, remote: SocketAddr, stop: Arc<AtomicBool>) {
    thread::spawn(move || {
        let _ = socket.set_read_timeout(Some(Duration::from_millis(250)));
        let mut request = [0u8; 32];
        request[0] = 0x80;
        request[1] = 0xd2;
        request[3] = 0x07;
        let mut buf = [0u8; 128];
        let (mut sent, mut replies) = (0u32, 0u32);

        while !stop.load(Ordering::Relaxed) {
            request[24..32].copy_from_slice(&ntp_now());
            let _ = socket.send_to(&request, remote);
            sent += 1;
            if let Ok(n) = socket.recv(&mut buf) {
                if n >= 32 {
                    replies += 1;
                    if replies == 1 {
                        eprintln!("[tdplay] NTP: first response from iOS after {sent} requests");
                    }
                }
            }
            // Four times per second at first, then every 3 seconds.
            let pause_ms = if sent > 30 { 3000 } else { 250 };
            for _ in 0..(pause_ms / 50) {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    });
}
