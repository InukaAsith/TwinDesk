// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 + Rust Proof-of-Concept: Shared thread-safe application state.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
    pub os: String,
    pub address: Option<String>,
    pub port: Option<u16>,
    #[serde(rename = "lastSeen")]
    pub last_seen: Option<u64>,
    pub invited: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutState {
    pub side: String, // "right" | "left" | "top" | "bottom"
}

impl Default for LayoutState {
    fn default() -> Self {
        Self {
            side: "right".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeysState {
    pub hotkey: String,
    #[serde(rename = "switchOnEdge")]
    pub switch_on_edge: bool,
}

impl Default for KeysState {
    fn default() -> Self {
        Self {
            hotkey: "AltRight".to_string(),
            switch_on_edge: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvmState {
    #[serde(rename = "whereInput")]
    pub where_input: String, // "home" | "driving" | "driven"
    pub locked: bool,
    pub mouse: bool,
    pub keyboard: bool,
    #[serde(rename = "hotkeySwitch")]
    pub hotkey_switch: bool,
    pub gestures: bool,
    pub ble: bool,
    pub speed: f32,
    #[serde(rename = "reverseScroll")]
    pub reverse_scroll: bool,
}

impl Default for KvmState {
    fn default() -> Self {
        Self {
            where_input: "home".to_string(),
            locked: false,
            mouse: true,
            keyboard: true,
            hotkey_switch: false,
            gestures: true,
            ble: true,
            speed: 1.0,
            reverse_scroll: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatesView {
    pub current: String,
    pub latest: Option<String>,
    pub available: bool,
    pub checking: bool,
    pub error: String,
    #[serde(rename = "checkedAt")]
    pub checked_at: u64,
    #[serde(rename = "releaseUrl")]
    pub release_url: String,
    #[serde(rename = "releaseNotes")]
    pub release_notes: String,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    pub skipped: bool,
    #[serde(rename = "skippedVersion")]
    pub skipped_version: String,
    #[serde(rename = "promptUpdate")]
    pub prompt_update: bool,
    pub auto: bool,
}

impl Default for UpdatesView {
    fn default() -> Self {
        Self {
            current: "2.3.0".to_string(),
            latest: None,
            available: false,
            checking: false,
            error: String::new(),
            checked_at: 0,
            release_url: "https://github.com/InukaAsith/TwinDesk/releases".to_string(),
            release_notes: String::new(),
            published_at: String::new(),
            skipped: false,
            skipped_version: String::new(),
            prompt_update: false,
            auto: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub version: String,
    pub name: String,
    pub arch: String,
    pub runtime: String, // "Tauri v2 + Rust"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcInfo {
    pub host: String,
    pub os: String,
    pub arch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AboutState {
    pub app: AppInfo,
    pub pc: PcInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullState {
    pub paired: Vec<PeerInfo>,
    pub found: Vec<PeerInfo>,
    pub client: Option<PeerInfo>,
    pub input: KvmState,
    pub layout: LayoutState,
    pub keys: KeysState,
    pub updates: UpdatesView,
    pub about: AboutState,
    #[serde(rename = "macName")]
    pub mac_name: String,
    #[serde(rename = "activeTab")]
    pub active_tab: String,
    pub version: String,
}

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<RwLock<FullState>>,
}

impl AppState {
    pub fn new() -> Self {
        let os_name = if cfg!(target_os = "windows") {
            "Windows"
        } else if cfg!(target_os = "macos") {
            "macOS"
        } else {
            "Linux"
        };

        let arch = std::env::consts::ARCH.to_string();
        let host = whoami_host();

        let initial_state = FullState {
            paired: Vec::new(),
            found: Vec::new(),
            client: None,
            input: KvmState::default(),
            layout: LayoutState::default(),
            keys: KeysState::default(),
            updates: UpdatesView::default(),
            about: AboutState {
                app: AppInfo {
                    version: "2.3.0".to_string(),
                    name: "TwinDesk (Tauri v2)".to_string(),
                    arch: arch.clone(),
                    runtime: "Tauri v2 + Rust (Native Webview)".to_string(),
                },
                pc: PcInfo {
                    host: host.clone(),
                    os: os_name.to_string(),
                    arch,
                },
            },
            mac_name: host,
            active_tab: "overview".to_string(),
            version: "2.3.0".to_string(),
        };

        Self {
            inner: Arc::new(RwLock::new(initial_state)),
        }
    }

    pub fn snapshot(&self) -> FullState {
        self.inner.read().clone()
    }

    pub fn update_found_peer(&self, peer: PeerInfo) -> bool {
        let mut s = self.inner.write();
        let now = chrono::Utc::now().timestamp_millis() as u64;
        let mut peer = peer;
        peer.last_seen = Some(now);

        if let Some(existing) = s.found.iter_mut().find(|p| p.id == peer.id) {
            existing.address = peer.address;
            existing.port = peer.port;
            existing.last_seen = Some(now);
            false
        } else {
            s.found.push(peer);
            true
        }
    }

    pub fn prune_stale_peers(&self, timeout_ms: u64) -> bool {
        let mut s = self.inner.write();
        let now = chrono::Utc::now().timestamp_millis() as u64;
        let initial_len = s.found.len();
        s.found.retain(|p| {
            if let Some(last) = p.last_seen {
                now.saturating_sub(last) < timeout_ms
            } else {
                false
            }
        });
        s.found.len() != initial_len
    }

    pub fn set_where_input(&self, where_val: &str) {
        let mut s = self.inner.write();
        s.input.where_input = where_val.to_string();
    }

    pub fn set_client(&self, client: Option<PeerInfo>) {
        let mut s = self.inner.write();
        s.client = client;
    }
}

pub fn whoami_host() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "TwinDesk-PC".to_string())
}
