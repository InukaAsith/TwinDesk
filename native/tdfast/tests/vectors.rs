// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The golden vectors of shared/inputlane.js (shared/test/inputlane-vectors.json): the same keys, the
// same bytes on the wire, both ways.
use tdfast::wire::*;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn golden_vectors() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../shared/test/inputlane-vectors.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let key = hex32(v["key"].as_str().unwrap()).unwrap();
    let host = derive_keys(&key, "host");
    let guest = derive_keys(&key, "guest");
    assert_eq!(to_hex(&host.tx_raw), v["hostTx"].as_str().unwrap());
    assert_eq!(to_hex(&guest.tx_raw), v["guestTx"].as_str().unwrap());
    assert_eq!(host.rx_raw, guest.tx_raw);
    let packets = v["packets"].as_array().unwrap();
    assert!(packets.len() >= 4);
    for p in packets {
        let role = p["role"].as_str().unwrap();
        let (me, them) = if role == "host" { (&host, &guest) } else { (&guest, &host) };
        let typ = p["type"].as_u64().unwrap() as u8;
        let seq = p["seq"].as_u64().unwrap();
        let body = hex(p["body"].as_str().unwrap());
        // the body as the JS encoders make it
        if let Some(m) = p.get("move") {
            let mv = Move {
                route: m["route"].as_u64().unwrap() as u32, mn: m["mn"].as_u64().unwrap() as u32, es: m["es"].as_u64().unwrap() as u32,
                cx: m["cx"].as_f64().unwrap(), cy: m["cy"].as_f64().unwrap(),
            };
            assert_eq!(encode_move(&mv).to_vec(), body, "move body");
            assert_eq!(decode_move(&body), Some(mv));
        }
        if let Some(evs) = p.get("events") {
            let list: Vec<(u32, Vec<u8>)> = evs.as_array().unwrap().iter()
                .map(|e| (e["es"].as_u64().unwrap() as u32, e["json"].as_str().unwrap().as_bytes().to_vec())).collect();
            assert_eq!(encode_events(&list).unwrap(), body, "events body");
            assert_eq!(decode_events(&body), list);
        }
        let wire = seal(&me.tx, typ, seq, &body);
        assert_eq!(to_hex(&wire), p["wire"].as_str().unwrap(), "seal: type {typ} seq {seq}");
        let (t, s, b) = open(&them.rx, &wire).expect("the peer opens it");
        assert_eq!((t, s, b), (typ, seq, body.clone()));
        assert!(open(&me.rx, &wire).is_none(), "our own key doesn't open our packets");
        let mut bad = wire.clone();
        let n = bad.len();
        bad[n - 1] ^= 1;
        assert!(open(&them.rx, &bad).is_none(), "tampered: dropped");
        let mut aad = wire.clone();
        aad[3] ^= 7;
        assert!(open(&them.rx, &aad).is_none(), "header is authenticated");
    }
}

#[test]
fn replay_window() {
    let mut w = ReplayWindow::new();
    assert!(!w.ok(0));
    for s in [5u64, 3, 4, 100] {
        assert!(w.ok(s));
        w.mark(s);
        assert!(!w.ok(s), "a replay of {s}");
    }
    assert!(!w.ok(36), "older than the window");
    assert!(w.ok(37) && w.ok(99));
}

#[test]
fn events_keep_four() {
    let list: Vec<(u32, Vec<u8>)> = (1..=6).map(|i| (i, format!("{{\"t\":\"k.kd\",\"code\":\"Key{i}\"}}").into_bytes())).collect();
    let d = decode_events(&encode_events(&list).unwrap());
    assert_eq!(d.iter().map(|e| e.0).collect::<Vec<_>>(), vec![3, 4, 5, 6]);
}
