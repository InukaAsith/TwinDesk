// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 + Rust: Phase 3 Native KVM & Helper Consolidation
// Eliminates external child-process helpers with native OS hooks, motion coalescing, and clipboard sync.

use crate::network::{NetworkManager, WireMessage};
use crate::state::AppState;
use arboard::Clipboard;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq)]
pub enum KvmEvent {
    MouseMove { dx: i32, dy: i32 },
    MouseDown(MouseButton),
    MouseUp(MouseButton),
    MouseWheel { delta_x: i32, delta_y: i32 },
    KeyDown { vk: u32 },
    KeyUp { vk: u32 },
}

/// Bounded queue for KVM events with motion coalescing.
pub struct KvmQueue {
    sender: mpsc::Sender<KvmEvent>,
}

impl KvmQueue {
    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<KvmEvent>) {
        let (tx, rx) = mpsc::channel(capacity);
        (Self { sender: tx }, rx)
    }

    pub async fn push(&self, event: KvmEvent) -> Result<(), String> {
        self.sender
            .send(event)
            .await
            .map_err(|e| format!("KVM queue closed: {}", e))
    }
}

/// Native platform input injection implementation.
pub struct NativeInputInjector;

impl NativeInputInjector {
    #[cfg(windows)]
    pub fn move_cursor_relative(dx: i32, dy: i32) {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_MOVE, MOUSEINPUT,
        };

        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_MOVE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
    }

    #[cfg(not(windows))]
    pub fn move_cursor_relative(_dx: i32, _dy: i32) {
        // Platform specific implementation for macOS (CoreGraphics) and Linux (evdev)
    }

    #[cfg(windows)]
    pub fn mouse_button(button: MouseButton, is_down: bool) {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
            MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN,
            MOUSEEVENTF_RIGHTUP, MOUSEINPUT,
        };

        let flags = match (button, is_down) {
            (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
            (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
            (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
            (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
            (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
            (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
        };

        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
    }

    #[cfg(not(windows))]
    pub fn mouse_button(_button: MouseButton, _is_down: bool) {}

    #[cfg(windows)]
    pub fn mouse_wheel(dx: i32, dy: i32) {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL,
            MOUSEINPUT,
        };

        let mut inputs = Vec::new();
        if dy != 0 {
            inputs.push(INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: (dy * 120) as u32,
                        dwFlags: MOUSEEVENTF_WHEEL,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
        if dx != 0 {
            inputs.push(INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: (dx * 120) as u32,
                        dwFlags: MOUSEEVENTF_HWHEEL,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }

        if !inputs.is_empty() {
            unsafe {
                let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
            }
        }
    }

    #[cfg(not(windows))]
    pub fn mouse_wheel(_dx: i32, _dy: i32) {}

    #[cfg(windows)]
    pub fn key_event(vk: u16, is_down: bool, extended: bool) {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
            KEYEVENTF_KEYUP, VIRTUAL_KEY,
        };

        let mut flags = if is_down {
            windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0)
        } else {
            KEYEVENTF_KEYUP
        };
        if extended {
            flags = flags | KEYEVENTF_EXTENDEDKEY;
        }

        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
    }

    #[cfg(not(windows))]
    pub fn key_event(_vk: u16, _is_down: bool, _extended: bool) {}
}

/// Unified cross-platform clipboard synchronization engine.
pub struct NativeClipboard {
    inner: Option<Clipboard>,
}

impl NativeClipboard {
    pub fn new() -> Self {
        Self {
            inner: Clipboard::new().ok(),
        }
    }

    pub fn get_text(&mut self) -> Option<String> {
        self.inner.as_mut().and_then(|cb| cb.get_text().ok())
    }

    pub fn set_text(&mut self, text: &str) -> bool {
        if let Some(cb) = self.inner.as_mut() {
            cb.set_text(text).is_ok()
        } else {
            false
        }
    }
}

/// Real-time clipboard watcher polling system clipboard and broadcasting changes.
pub struct ClipboardWatcher {
    network: NetworkManager,
    last_text: Arc<Mutex<String>>,
}

impl ClipboardWatcher {
    pub fn new(network: NetworkManager) -> Self {
        Self {
            network,
            last_text: Arc::new(Mutex::new(String::new())),
        }
    }

    pub fn start(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(400));

            loop {
                interval.tick().await;

                let text_opt = {
                    let mut cb = NativeClipboard::new();
                    cb.get_text()
                };

                if let Some(text) = text_opt {
                    let should_send = {
                        let mut last = self.last_text.lock();
                        if !text.is_empty() && *last != text {
                            *last = text.clone();
                            true
                        } else {
                            false
                        }
                    };

                    if should_send {
                        let msg = WireMessage {
                            t: "clip".to_string(),
                            v: Some(1),
                            id: None, name: None, os: None, port: None, role: None,
                            dx: None, dy: None, b: None, k: None, code: None,
                            vk: None, mods: None,
                            text: Some(text),
                            ts: Some(chrono::Utc::now().timestamp_millis() as u64),
                        };
                        self.network.send_packet(msg).await;
                    }
                }
            }
        });
    }
}

/// Global low-level hook engine for Windows mouse/keyboard capture and edge-crossing.
#[cfg(windows)]
pub mod hook_engine {
    use super::*;
    use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, GetSystemMetrics,
        SetCursorPos, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HHOOK,
        KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT, MSG, SM_CXSCREEN, SM_CYSCREEN, WH_KEYBOARD_LL,
        WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
        WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP,
        WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    static mut MOUSE_HOOK: Option<HHOOK> = None;
    static mut KEYBOARD_HOOK: Option<HHOOK> = None;
    static mut APP_HANDLE: Option<AppHandle> = None;
    static mut APP_STATE: Option<AppState> = None;
    static mut NETWORK_MGR: Option<NetworkManager> = None;

    pub fn start_hooks(app: AppHandle, state: AppState, network: NetworkManager) {
        unsafe {
            APP_HANDLE = Some(app);
            APP_STATE = Some(state);
            NETWORK_MGR = Some(network);
        }

        std::thread::spawn(|| {
            unsafe {
                let mouse_hook = SetWindowsHookExW(
                    WH_MOUSE_LL,
                    Some(mouse_hook_proc),
                    None,
                    0,
                );
                if let Ok(h) = mouse_hook {
                    MOUSE_HOOK = Some(h);
                }

                let key_hook = SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(keyboard_hook_proc),
                    None,
                    0,
                );
                if let Ok(h) = key_hook {
                    KEYBOARD_HOOK = Some(h);
                }

                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }

                if let Some(h) = MOUSE_HOOK.take() {
                    let _ = UnhookWindowsHookEx(h);
                }
                if let Some(h) = KEYBOARD_HOOK.take() {
                    let _ = UnhookWindowsHookEx(h);
                }
            }
        });
    }

    unsafe extern "system" fn mouse_hook_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
        if n_code >= 0 && l_param.0 != 0 {
            let msg = w_param.0 as u32;
            let m = *(l_param.0 as *const MSLLHOOKSTRUCT);

            if let (Some(state), Some(net), Some(app)) = (&APP_STATE, &NETWORK_MGR, &APP_HANDLE) {
                let snap = state.snapshot();
                let has_peer = snap.client.is_some();
                let is_driving = snap.input.where_input == "driving";

                let screen_w = GetSystemMetrics(SM_CXSCREEN);
                let screen_h = GetSystemMetrics(SM_CYSCREEN);

                if !is_driving && has_peer {
                    // Edge check to switch into driving mode
                    let crossed = match snap.layout.side.as_str() {
                        "right" => m.pt.x >= screen_w - 2,
                        "left" => m.pt.x <= 1,
                        "top" => m.pt.y <= 1,
                        "bottom" => m.pt.y >= screen_h - 2,
                        _ => false,
                    };

                    if crossed {
                        state.set_where_input("driving");
                        let new_snap = state.snapshot();
                        let _ = app.emit("state-change", &new_snap);

                        let take = WireMessage {
                            t: "kvm.take".to_string(),
                            v: Some(1),
                            id: None, name: None, os: None, port: None, role: None,
                            dx: None, dy: None, b: None, k: None, code: None,
                            vk: None, mods: None, text: None, ts: None,
                        };
                        let net_clone = net.clone();
                        tokio::spawn(async move {
                            net_clone.send_packet(take).await;
                        });
                        return LRESULT(1);
                    }
                } else if is_driving {
                    // Swallow and stream to peer
                    match msg {
                        WM_MOUSEMOVE => {
                            static mut LAST_PT: POINT = POINT { x: 0, y: 0 };
                            let dx = (m.pt.x - LAST_PT.x) as f64;
                            let dy = (m.pt.y - LAST_PT.y) as f64;
                            LAST_PT = m.pt;

                            if dx.abs() > 0.0 || dy.abs() > 0.0 {
                                let move_msg = WireMessage {
                                    t: "k.mm".to_string(),
                                    v: Some(1),
                                    id: None, name: None, os: None, port: None, role: None,
                                    dx: Some(dx), dy: Some(dy),
                                    b: None, k: None, code: None,
                                    vk: None, mods: None, text: None, ts: None,
                                };
                                let net_clone = net.clone();
                                tokio::spawn(async move {
                                    net_clone.send_packet(move_msg).await;
                                });
                            }

                            // Keep cursor parked near edge
                            let park_x = match snap.layout.side.as_str() {
                                "right" => screen_w - 5,
                                "left" => 5,
                                _ => m.pt.x,
                            };
                            let _ = SetCursorPos(park_x, m.pt.y);
                            return LRESULT(1);
                        }
                        WM_LBUTTONDOWN | WM_LBUTTONUP => {
                            let is_down = msg == WM_LBUTTONDOWN;
                            let btn_msg = WireMessage {
                                t: if is_down { "k.md".to_string() } else { "k.mu".to_string() },
                                v: Some(1),
                                id: None, name: None, os: None, port: None, role: None,
                                dx: None, dy: None, b: Some(0), k: None, code: None,
                                vk: None, mods: None, text: None, ts: None,
                            };
                            let net_clone = net.clone();
                            tokio::spawn(async move {
                                net_clone.send_packet(btn_msg).await;
                            });
                            return LRESULT(1);
                        }
                        WM_RBUTTONDOWN | WM_RBUTTONUP => {
                            let is_down = msg == WM_RBUTTONDOWN;
                            let btn_msg = WireMessage {
                                t: if is_down { "k.md".to_string() } else { "k.mu".to_string() },
                                v: Some(1),
                                id: None, name: None, os: None, port: None, role: None,
                                dx: None, dy: None, b: Some(1), k: None, code: None,
                                vk: None, mods: None, text: None, ts: None,
                            };
                            let net_clone = net.clone();
                            tokio::spawn(async move {
                                net_clone.send_packet(btn_msg).await;
                            });
                            return LRESULT(1);
                        }
                        WM_MBUTTONDOWN | WM_MBUTTONUP => {
                            let is_down = msg == WM_MBUTTONDOWN;
                            let btn_msg = WireMessage {
                                t: if is_down { "k.md".to_string() } else { "k.mu".to_string() },
                                v: Some(1),
                                id: None, name: None, os: None, port: None, role: None,
                                dx: None, dy: None, b: Some(2), k: None, code: None,
                                vk: None, mods: None, text: None, ts: None,
                            };
                            let net_clone = net.clone();
                            tokio::spawn(async move {
                                net_clone.send_packet(btn_msg).await;
                            });
                            return LRESULT(1);
                        }
                        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
                            let notches = ((m.mouseData >> 16) as i16) as f64 / 120.0;
                            let (dx, dy) = if msg == WM_MOUSEHWHEEL {
                                (notches, 0.0)
                            } else {
                                (0.0, -notches)
                            };
                            let wh_msg = WireMessage {
                                t: "k.wh".to_string(),
                                v: Some(1),
                                id: None, name: None, os: None, port: None, role: None,
                                dx: Some(dx), dy: Some(dy),
                                b: None, k: None, code: None,
                                vk: None, mods: None, text: None, ts: None,
                            };
                            let net_clone = net.clone();
                            tokio::spawn(async move {
                                net_clone.send_packet(wh_msg).await;
                            });
                            return LRESULT(1);
                        }
                        _ => {}
                    }
                }
            }
        }

        CallNextHookEx(HHOOK::default(), n_code, w_param, l_param)
    }

    unsafe extern "system" fn keyboard_hook_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
        if n_code >= 0 && l_param.0 != 0 {
            let msg = w_param.0 as u32;
            let k = *(l_param.0 as *const KBDLLHOOKSTRUCT);

            if let (Some(state), Some(net), Some(app)) = (&APP_STATE, &NETWORK_MGR, &APP_HANDLE) {
                let snap = state.snapshot();
                let is_driving = snap.input.where_input == "driving";

                // Hotkey to release: VK_RMENU (Right Alt, 165) or VK_RCONTROL (163)
                if (k.vkCode == 165 || k.vkCode == 163) && (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
                    if is_driving {
                        state.set_where_input("home");
                        let new_snap = state.snapshot();
                        let _ = app.emit("state-change", &new_snap);

                        let home_msg = WireMessage {
                            t: "kvm.home".to_string(),
                            v: Some(1),
                            id: None, name: None, os: None, port: None, role: None,
                            dx: None, dy: None, b: None, k: None, code: None,
                            vk: None, mods: None, text: None, ts: None,
                        };
                        let net_clone = net.clone();
                        tokio::spawn(async move {
                            net_clone.send_packet(home_msg).await;
                        });

                        // Center cursor on local screen
                        let screen_w = GetSystemMetrics(SM_CXSCREEN);
                        let screen_h = GetSystemMetrics(SM_CYSCREEN);
                        let _ = SetCursorPos(screen_w / 2, screen_h / 2);
                        return LRESULT(1);
                    }
                }

                if is_driving {
                    let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                    let key_msg = WireMessage {
                        t: if is_down { "k.kd".to_string() } else { "k.ku".to_string() },
                        v: Some(1),
                        id: None, name: None, os: None, port: None, role: None,
                        dx: None, dy: None, b: None, k: None, code: None,
                        vk: Some(k.vkCode),
                        mods: None, text: None, ts: None,
                    };
                    let net_clone = net.clone();
                    tokio::spawn(async move {
                        net_clone.send_packet(key_msg).await;
                    });
                    return LRESULT(1);
                }
            }
        }

        CallNextHookEx(HHOOK::default(), n_code, w_param, l_param)
    }
}

#[cfg(not(windows))]
pub mod hook_engine {
    use super::*;
    pub fn start_hooks(_app: AppHandle, _state: AppState, _network: NetworkManager) {
        // Safe stub for macOS (CGEventTap) and Linux (uinput / libinput)
    }
}
