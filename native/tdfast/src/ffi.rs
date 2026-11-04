// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The C ABI (tdfast.h), one to one with lane.rs. Strings are NUL-terminated UTF-8; the callback runs
// on the lane's thread (or the caller's, for td_driven / td_hold / td_done): the helper hops to its
// own queue.
use crate::lane::{self, Out};
use std::ffi::{c_char, c_void, CStr};

pub const TD_MOVE: i32 = 1; // dx, dy: inject (driven)
pub const TD_EVENT: i32 = 2; // json, len: an event from the lane ({"es":N,…})
pub const TD_UP: i32 = 3; // dx = the RTT in ms
pub const TD_DOWN: i32 = 4;

pub type TdCallback = extern "C" fn(ctx: *mut c_void, kind: i32, dx: f64, dy: f64, json: *const u8, len: usize);

struct Ctx(*mut c_void);
unsafe impl Send for Ctx {}
unsafe impl Sync for Ctx {}

fn cstr<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(p) }.to_str().ok()
}

#[no_mangle]
pub extern "C" fn td_bind() -> u16 {
    lane::bind()
}

/// role: 0 host, 1 guest. 1: started, 0: can't (bad key, address, or no socket).
#[no_mangle]
pub extern "C" fn td_start(role: i32, key_hex: *const c_char, ip: *const c_char, port: u16, cb: Option<TdCallback>, ctx: *mut c_void) -> i32 {
    let (key, ip) = match (cstr(key_hex), cstr(ip)) {
        (Some(k), Some(i)) => (k, i),
        _ => return 0,
    };
    match cb {
        Some(cb) => {
            let c = Ctx(ctx);
            lane::set_sink(Some(Box::new(move |o: Out| {
                let c = &c;
                match o {
                    Out::Move(dx, dy) => cb(c.0, TD_MOVE, dx, dy, std::ptr::null(), 0),
                    Out::Event(j) => cb(c.0, TD_EVENT, 0.0, 0.0, j.as_ptr(), j.len()),
                    Out::Up(rtt) => cb(c.0, TD_UP, rtt, 0.0, std::ptr::null(), 0),
                    Out::Down => cb(c.0, TD_DOWN, 0.0, 0.0, std::ptr::null(), 0),
                }
            })));
        }
        None => lane::set_sink(None),
    }
    lane::start(if role == 0 { "host" } else { "guest" }, key, ip, port) as i32
}

#[no_mangle]
pub extern "C" fn td_stop() {
    lane::stop();
}

#[no_mangle]
pub extern "C" fn td_close() {
    lane::stop();
    lane::set_sink(None);
}

#[no_mangle]
pub extern "C" fn td_up() -> i32 {
    lane::is_up() as i32
}

#[no_mangle]
pub extern "C" fn td_rtt_ms() -> f64 {
    lane::rtt_ms()
}

#[no_mangle]
pub extern "C" fn td_active(on: i32) {
    lane::active(on != 0);
}

#[no_mangle]
pub extern "C" fn td_drive_reset(route: u32) {
    lane::drive_reset(route);
}

/// A move while driving. 1: on the lane (write nothing); 0: the lane is down, send k.mm with the
/// totals (route, mn, cx, cy); -1: no lane for it, send k.mm as always.
#[no_mangle]
pub extern "C" fn td_move(dx: f64, dy: f64, route: *mut u32, mn: *mut u32, cx: *mut f64, cy: *mut f64) -> i32 {
    match lane::move_by(dx, dy) {
        None => -1,
        Some((on_lane, m)) => {
            unsafe {
                if !route.is_null() { *route = m.route; }
                if !mn.is_null() { *mn = m.mn; }
                if !cx.is_null() { *cx = m.cx; }
                if !cy.is_null() { *cy = m.cy; }
            }
            on_lane as i32
        }
    }
}

/// A click, key, wheel or gesture while driving: its es (0: no lane) and its fence.
#[no_mangle]
pub extern "C" fn td_fence(route: *mut u32, mn: *mut u32, cx: *mut f64, cy: *mut f64) -> u32 {
    match lane::fence() {
        None => 0,
        Some((es, m)) => {
            unsafe {
                if !route.is_null() { *route = m.route; }
                if !mn.is_null() { *mn = m.mn; }
                if !cx.is_null() { *cx = m.cx; }
                if !cy.is_null() { *cy = m.cy; }
            }
            es
        }
    }
}

#[no_mangle]
pub extern "C" fn td_send_event(json: *const u8, len: usize, es: u32) {
    if json.is_null() {
        return;
    }
    let s = unsafe { std::slice::from_raw_parts(json, len) };
    lane::send_event(s, es);
}

#[no_mangle]
pub extern "C" fn td_driven(route: u32, speed: f64) {
    lane::driven(route, speed);
}

#[no_mangle]
pub extern "C" fn td_hold(on: i32) {
    lane::hold(on != 0);
}

/// 1 and the delta (speed applied) to inject before the event, 0: nothing to move.
#[no_mangle]
pub extern "C" fn td_fence_apply(route: u32, mn: u32, cx: f64, cy: f64, dx: *mut f64, dy: *mut f64) -> i32 {
    match lane::fence_apply(route, mn, cx, cy) {
        Some((x, y)) => {
            unsafe {
                if !dx.is_null() { *dx = x; }
                if !dy.is_null() { *dy = y; }
            }
            1
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn td_done(es: u32) {
    lane::done(es);
}
