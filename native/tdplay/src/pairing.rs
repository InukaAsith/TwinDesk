// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Based on AirBridge (by Jannik Beyerstein, GPL-3.0).

use crate::identity::{Identity, random32};
use aes::Aes128;
use anyhow::{bail, Result};
use ctr::Ctr128BE;
use ctr::cipher::{KeyIvInit, StreamCipher};
use ed25519_dalek::{Signature, Signer, Verifier, VerifyingKey};
use sha2::{Digest, Sha512};
use x25519_dalek::{x25519, X25519_BASEPOINT_BYTES};

type AesCtr = Ctr128BE<Aes128>;

pub struct VerifySession {
    ecdh_ours: [u8; 32],
    ecdh_theirs: [u8; 32],
    ed_theirs: [u8; 32],
    key: [u8; 16],
    iv: [u8; 16],
    pub shared: [u8; 32],
}

fn derive(label: &str, shared: &[u8; 32]) -> [u8; 16] {
    let mut h = Sha512::new();
    h.update(label.as_bytes());
    h.update(shared);
    let digest = h.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    out
}

pub fn verify_step1(id: &Identity, body: &[u8]) -> Result<(VerifySession, Vec<u8>)> {
    if body.len() != 68 || body[0] != 1 {
        bail!("pair-verify step 1: unexpected format ({} bytes)", body.len());
    }
    let ecdh_theirs: [u8; 32] = body[4..36].try_into()?;
    let ed_theirs: [u8; 32] = body[36..68].try_into()?;

    let secret = random32()?;
    let ecdh_ours = x25519(secret, X25519_BASEPOINT_BYTES);
    let shared = x25519(secret, ecdh_theirs);

    let key = derive("Pair-Verify-AES-Key", &shared);
    let iv = derive("Pair-Verify-AES-IV", &shared);
    let mut cipher = AesCtr::new(&key.into(), &iv.into());

    let mut msg = Vec::with_capacity(64);
    msg.extend_from_slice(&ecdh_ours);
    msg.extend_from_slice(&ecdh_theirs);
    let mut sig = id.signing.sign(&msg).to_bytes();
    cipher.apply_keystream(&mut sig);

    let mut reply = Vec::with_capacity(96);
    reply.extend_from_slice(&ecdh_ours);
    reply.extend_from_slice(&sig);

    Ok((
        VerifySession {
            ecdh_ours,
            ecdh_theirs,
            ed_theirs,
            key,
            iv,
            shared,
        },
        reply,
    ))
}

pub fn verify_step2(session: &mut VerifySession, body: &[u8]) -> Result<()> {
    if body.len() != 68 {
        bail!("pair-verify step 2: unexpected format ({} bytes)", body.len());
    }
    let mut cipher = AesCtr::new(&session.key.into(), &session.iv.into());
    cipher.apply_keystream(&mut [0u8; 64]);

    let mut sig: [u8; 64] = body[4..68].try_into()?;
    cipher.apply_keystream(&mut sig);

    let mut msg = Vec::with_capacity(64);
    msg.extend_from_slice(&session.ecdh_theirs);
    msg.extend_from_slice(&session.ecdh_ours);
    let vk = VerifyingKey::from_bytes(&session.ed_theirs)?;
    let parsed_sig = Signature::from_bytes(&sig);
    vk.verify(&msg, &parsed_sig)?;
    Ok(())
}
