// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Compiles playfair C library (from UxPlay / AirBridge) for FairPlay decryption.

fn main() {
    cc::Build::new()
        .files([
            "vendor/playfair/playfair.c",
            "vendor/playfair/hand_garble.c",
            "vendor/playfair/modified_md5.c",
            "vendor/playfair/omg_hax.c",
            "vendor/playfair/sap_hash.c",
            "vendor/fp_tables.c",
        ])
        .warnings(false)
        .compile("playfair");

    println!("cargo:rerun-if-changed=vendor");
}
