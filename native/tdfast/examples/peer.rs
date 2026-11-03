// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A lane peer for shared/test/tdfast-interop.js: the C ABI, driven by JSON lines on stdin, the
// callbacks as JSON lines on stdout. Commands: {"op":"bind"} {"op":"start","role","key","ip","port"}
// {"op":"active","on"} {"op":"drive","route"} {"op":"move","dx","dy"} {"op":"event","json"}
// {"op":"driven","route","speed"} {"op":"fence","route","mn","cx","cy"} {"op":"done","es"} {"op":"hold","on"}.
use std::ffi::{c_void, CString};
use std::io::{BufRead, Write};
use std::sync::Mutex;
use tdfast::ffi::*;

static OUT: Mutex<()> = Mutex::new(());

fn say(v: serde_json::Value) {
    let _g = OUT.lock().unwrap();
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
}

extern "C" fn cb(_ctx: *mut c_void, kind: i32, dx: f64, dy: f64, json: *const u8, len: usize) {
    match kind {
        TD_MOVE => say(serde_json::json!({"ev":"move","dx":dx,"dy":dy})),
        TD_EVENT => {
            let s = unsafe { std::slice::from_raw_parts(json, len) };
            let msg: serde_json::Value = serde_json::from_slice(s).unwrap_or(serde_json::Value::Null);
            say(serde_json::json!({"ev":"event","msg":msg}));
        }
        TD_UP => say(serde_json::json!({"ev":"up","rtt":dx})),
        TD_DOWN => say(serde_json::json!({"ev":"down"})),
        _ => {}
    }
}

fn main() {
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(m) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let f = |k: &str| m[k].as_f64().unwrap_or(0.0);
        let u = |k: &str| m[k].as_u64().unwrap_or(0) as u32;
        match m["op"].as_str().unwrap_or("") {
            "bind" => say(serde_json::json!({"ev":"port","port":td_bind()})),
            "start" => {
                let key = CString::new(m["key"].as_str().unwrap_or("")).unwrap();
                let ip = CString::new(m["ip"].as_str().unwrap_or("")).unwrap();
                let ok = td_start(if m["role"] == "host" { 0 } else { 1 }, key.as_ptr(), ip.as_ptr(), u("port") as u16, Some(cb), std::ptr::null_mut());
                say(serde_json::json!({"ev":"started","ok":ok}));
            }
            "active" => td_active(m["on"].as_bool().unwrap_or(false) as i32),
            "drive" => td_drive_reset(u("route")),
            "move" => {
                let (mut r, mut mn, mut cx, mut cy) = (0u32, 0u32, 0f64, 0f64);
                let on = td_move(f("dx"), f("dy"), &mut r, &mut mn, &mut cx, &mut cy);
                if on != 1 { say(serde_json::json!({"ev":"wss","lane":on,"route":r,"mn":mn,"mc":[cx,cy]})); }
            }
            "event" => {
                let (mut r, mut mn, mut cx, mut cy) = (0u32, 0u32, 0f64, 0f64);
                let es = td_fence(&mut r, &mut mn, &mut cx, &mut cy);
                let json = m["json"].as_str().unwrap_or("{}");
                td_send_event(json.as_ptr(), json.len(), es);
                say(serde_json::json!({"ev":"fenced","es":es,"route":r,"mn":mn,"mc":[cx,cy]}));
            }
            "driven" => td_driven(u("route"), f("speed")),
            "hold" => td_hold(m["on"].as_bool().unwrap_or(false) as i32),
            "fence" => {
                let (mut dx, mut dy) = (0f64, 0f64);
                if td_fence_apply(u("route"), u("mn"), f("cx"), f("cy"), &mut dx, &mut dy) == 1 {
                    say(serde_json::json!({"ev":"move","dx":dx,"dy":dy,"fence":true}));
                }
            }
            "done" => td_done(u("es")),
            "stop" => td_stop(),
            _ => {}
        }
    }
}
