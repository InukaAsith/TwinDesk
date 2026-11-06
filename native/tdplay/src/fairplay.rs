// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Based on AirBridge (by Jannik Beyerstein, GPL-3.0) and UxPlay (GPL-3.0).

use anyhow::{bail, Result};

unsafe extern "C" {
    static fp_reply: [[u8; 142]; 4];
    fn playfair_decrypt(message3: *mut u8, cipher_text: *mut u8, key_out: *mut u8);
}

const FP_HEADER: [u8; 12] = [
    0x46, 0x50, 0x4c, 0x59, 0x03, 0x01, 0x04, 0x00, 0x00, 0x00, 0x00, 0x14,
];

#[derive(Default)]
pub struct FairPlay {
    keymsg: Option<[u8; 164]>,
}

impl FairPlay {
    pub fn setup(&mut self, req: &[u8]) -> Result<Vec<u8>> {
        if req.len() != 16 || req[4] != 3 {
            bail!("fp-setup step 1: invalid request");
        }
        let mode = req[14] as usize;
        if mode >= 4 {
            bail!("fp-setup: unknown mode {mode}");
        }
        self.keymsg = None;
        Ok(unsafe { fp_reply[mode] }.to_vec())
    }

    pub fn handshake(&mut self, req: &[u8]) -> Result<Vec<u8>> {
        if req.len() != 164 || req[4] != 3 {
            bail!("fp-setup step 2: invalid request");
        }
        self.keymsg = Some(req.try_into()?);
        let mut res = FP_HEADER.to_vec();
        res.extend_from_slice(&req[144..164]);
        Ok(res)
    }

    pub fn decrypt_key(&self, ekey: &[u8]) -> Result<[u8; 16]> {
        let Some(mut keymsg) = self.keymsg else {
            bail!("ekey before fp-setup stage 2");
        };
        let mut input: [u8; 72] = ekey.try_into()?;
        let mut out = [0u8; 16];
        unsafe { playfair_decrypt(keymsg.as_mut_ptr(), input.as_mut_ptr(), out.as_mut_ptr()) };
        Ok(out)
    }
}
