// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Based on AirBridge (by Jannik Beyerstein, GPL-3.0).

use anyhow::{anyhow, Result};
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha512};
use std::fs;
use std::path::{Path, PathBuf};

pub fn random32() -> Result<[u8; 32]> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| anyhow!("RNG unavailable: {e}"))?;
    Ok(buf)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub struct Identity {
    pub signing: SigningKey,
}

pub fn key_path(custom: Option<&Path>) -> PathBuf {
    if let Some(p) = custom {
        return p.to_path_buf();
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("TwinDesk");
    dir.join(crate::config::KEY_FILE)
}

impl Identity {
    pub fn load_or_create(path: &Path) -> Result<Self> {
        let seed: [u8; 32] = match fs::read(path) {
            Ok(bytes) => bytes
                .try_into()
                .map_err(|_| anyhow!("Corrupted key file at {}", path.display()))?,
            Err(_) => {
                let seed = random32()?;
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::write(path, seed);
                seed
            }
        };
        Ok(Self {
            signing: SigningKey::from_bytes(&seed),
        })
    }

    pub fn public(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    fn fingerprint(&self, label: &str) -> [u8; 16] {
        let mut h = Sha512::new();
        h.update(label.as_bytes());
        h.update(self.public());
        let mut out = [0u8; 16];
        out.copy_from_slice(&h.finalize()[..16]);
        out
    }

    pub fn device_id(&self) -> String {
        let mut mac: [u8; 6] = self.fingerprint("TwinDesk-AirPlay-DeviceID")[..6]
            .try_into()
            .unwrap();
        mac[0] = (mac[0] | 0x02) & 0xFE; // Local, unicast
        format!(
            "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
            mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
        )
    }

    pub fn pi(&self) -> String {
        let fp = self.fingerprint("TwinDesk-AirPlay-Pi");
        format!(
            "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            fp[0], fp[1], fp[2], fp[3], fp[4], fp[5], fp[6], fp[7], fp[8], fp[9], fp[10], fp[11], fp[12], fp[13], fp[14], fp[15]
        )
    }
}
