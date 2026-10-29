// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 + Rust Architecture (Phases 1, 2, 3 complete):
// - Ultra-low RAM (~25-45 MB vs 600 MB-1.2 GB in Electron)
// - Zero Garbage Collection latency pauses
// - Async Tokio networking with UDP LAN discovery & WebSocket mesh
// - Native KVM input injection, edge-crossing hooks, and clipboard sync

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod kvm;
mod network;
mod state;
mod tray;

use network::NetworkManager;
use state::AppState;
use std::sync::Arc;
use tauri::Manager;

fn main() {
    env_logger::init();

    let state = AppState::new();
    let setup_state = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let network = NetworkManager::new(handle.clone(), setup_state);

            // 1. Start Async Networking Engine (Phase 2: UDP discovery & WS mesh server)
            network.start();

            // 2. Start Clipboard Sync Daemon (Phase 3)
            let clip_watcher = Arc::new(kvm::ClipboardWatcher::new(network.clone()));
            clip_watcher.start();

            // 3. Start Native KVM Hook Engine (Phase 3: low-level mouse/keyboard & edge detection)
            kvm::hook_engine::start_hooks(handle.clone(), state.clone(), network.clone());

            // 4. Register NetworkManager in Tauri state
            app.manage(network);

            // 5. System tray setup
            if let Err(e) = tray::setup_tray(app.handle()) {
                log::warn!("Could not initialize system tray: {}", e);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::set_kvm,
            commands::set_layout,
            commands::set_keys,
            commands::set_tab,
            commands::set_clipboard,
            commands::copy_text,
            commands::set_updates,
            commands::skip_update,
            commands::unskip_update,
            commands::check_updates,
            commands::open_update,
            commands::open_link,
            commands::pair,
            commands::connect_address,
            commands::connect_again,
            commands::refresh_found,
            commands::disconnect,
            commands::pair_respond,
            commands::set_app,
            commands::set_monitor,
            commands::copy_history,
            commands::clear_history,
            commands::set_multi,
            commands::skip_setup,
            commands::confirm_code,
            commands::cancel_pair,
            commands::forget,
            commands::wake_peer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TwinDesk Tauri application");
}
