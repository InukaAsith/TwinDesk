// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 + Rust Proof-of-Concept: IPC commands matching window.macshare contract.

use crate::network::NetworkManager;
use crate::state::{AppState, FullState};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;

#[tauri::command]
pub fn get_state(state: State<'_, AppState>) -> FullState {
    state.snapshot()
}

#[tauri::command]
pub fn set_kvm(partial: Value, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        if let Some(locked) = partial.get("locked").and_then(|v| v.as_bool()) {
            s.input.locked = locked;
        }
        if let Some(mouse) = partial.get("mouse").and_then(|v| v.as_bool()) {
            s.input.mouse = mouse;
        }
        if let Some(keyboard) = partial.get("keyboard").and_then(|v| v.as_bool()) {
            s.input.keyboard = keyboard;
        }
        if let Some(gestures) = partial.get("gestures").and_then(|v| v.as_bool()) {
            s.input.gestures = gestures;
        }
        if let Some(speed) = partial.get("speed").and_then(|v| v.as_f64()) {
            s.input.speed = speed as f32;
        }
        if let Some(rev) = partial.get("reverseScroll").and_then(|v| v.as_bool()) {
            s.input.reverse_scroll = rev;
        }
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_layout(side: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        s.layout.side = side;
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_keys(partial: Value, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        if let Some(hotkey) = partial.get("hotkey").and_then(|v| v.as_str()) {
            s.keys.hotkey = hotkey.to_string();
        }
        if let Some(edge) = partial.get("switchOnEdge").and_then(|v| v.as_bool()) {
            s.keys.switch_on_edge = edge;
        }
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_tab(tab: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        s.active_tab = tab;
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_clipboard(partial: Value, network: State<'_, NetworkManager>) -> Result<(), String> {
    if let Some(text) = partial.get("text").and_then(|v| v.as_str()) {
        let mut cb = crate::kvm::NativeClipboard::new();
        cb.set_text(text);

        let msg = crate::network::WireMessage {
            t: "clip".to_string(),
            v: Some(1),
            id: None, name: None, os: None, port: None, role: None,
            dx: None, dy: None, b: None, k: None, code: None,
            vk: None, mods: None,
            text: Some(text.to_string()),
            ts: Some(chrono::Utc::now().timestamp_millis() as u64),
        };
        let net = network.inner().clone();
        tokio::spawn(async move {
            net.send_packet(msg).await;
        });
    }
    Ok(())
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    let mut cb = crate::kvm::NativeClipboard::new();
    cb.set_text(&text);
    Ok(())
}

#[tauri::command]
pub fn set_updates(partial: Value, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        if let Some(auto) = partial.get("auto").and_then(|v| v.as_bool()) {
            s.updates.auto = auto;
        }
        if let Some(skipped) = partial.get("skipped").and_then(|v| v.as_str()) {
            s.updates.skipped_version = skipped.to_string();
            s.updates.skipped = !skipped.is_empty();
        }
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn skip_update(version: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let clean = version.trim().trim_start_matches('v').to_string();
    {
        let mut s = state.inner.write();
        s.updates.skipped_version = clean;
        s.updates.skipped = true;
        s.updates.prompt_update = false;
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn unskip_update(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        s.updates.skipped_version.clear();
        s.updates.skipped = false;
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn check_updates(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        s.updates.checking = true;
        s.updates.error.clear();
    }
    push_state(&app, &state);

    tokio::time::sleep(tokio::time::Duration::from_millis(600)).await;

    {
        let mut s = state.inner.write();
        s.updates.checking = false;
        s.updates.checked_at = chrono::Utc::now().timestamp_millis() as u64;
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn open_update(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let url = state.inner.read().updates.release_url.clone();
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_link(key: String, app: AppHandle) -> Result<(), String> {
    let url = match key.as_str() {
        "portfolio" => "https://inukaasith.vercel.app",
        "github" => "https://github.com/InukaAsith/TwinDesk",
        "releases" => "https://github.com/InukaAsith/TwinDesk/releases",
        "licence" => "https://github.com/InukaAsith/TwinDesk/blob/main/LICENSE",
        _ => "https://github.com/InukaAsith/TwinDesk",
    };
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pair(host: String, network: State<'_, NetworkManager>) -> Result<(), String> {
    network.connect_to(&host).await
}

#[tauri::command]
pub async fn connect_address(addr: String, network: State<'_, NetworkManager>) -> Result<(), String> {
    network.connect_to(&addr).await
}

#[tauri::command]
pub async fn connect_again(network: State<'_, NetworkManager>, state: State<'_, AppState>) -> Result<(), String> {
    let target = {
        let s = state.inner.read();
        s.paired.first().and_then(|p| p.address.clone())
    };
    if let Some(addr) = target {
        network.connect_to(&addr).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn refresh_found(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        s.found.clear();
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn disconnect(network: State<'_, NetworkManager>) -> Result<(), String> {
    network.disconnect().await;
    Ok(())
}

#[tauri::command]
pub fn pair_respond(allowed: bool, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    log::info!("Pair response: allowed = {}", allowed);
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn set_app(_partial: Value) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn set_monitor(_partial: Value) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn copy_history(_index: usize) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn clear_history() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn set_multi(_on: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn skip_setup() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn confirm_code() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn cancel_pair() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn forget(id: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let mut s = state.inner.write();
        s.paired.retain(|p| p.id != id);
    }
    push_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn wake_peer(_id: String) -> Result<(), String> {
    Ok(())
}

pub fn push_state(app: &AppHandle, state: &AppState) {
    let snapshot = state.snapshot();
    let _ = app.emit("state-change", &snapshot);
}
