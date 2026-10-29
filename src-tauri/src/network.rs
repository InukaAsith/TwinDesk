// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tauri v2 + Rust: Phase 2 Async Networking & Mesh Engine
// Replaces Node.js WebSocket with native async Tokio + Tungstenite (zero-GC latency, bounded backpressure).

use crate::state::{AppState, PeerInfo};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, Mutex};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, connect_async};

pub const DEFAULT_PORT: u16 = 47800;
pub const DISCOVERY_PORT: u16 = 47801;
pub const BEACON_INTERVAL: Duration = Duration::from_millis(2000);
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(1000);
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(12000);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessage {
    pub t: String,
    #[serde(default)]
    pub v: Option<u32>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub role: Option<String>,
    // Input / KVM fields
    #[serde(default)]
    pub dx: Option<f64>,
    #[serde(default)]
    pub dy: Option<f64>,
    #[serde(default)]
    pub b: Option<i32>,
    #[serde(default)]
    pub k: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub vk: Option<u32>,
    #[serde(default)]
    pub mods: Option<u32>,
    // Clipboard fields
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub ts: Option<u64>,
}

pub struct HeartbeatTracker {
    last_received: Instant,
}

impl HeartbeatTracker {
    pub fn new() -> Self {
        Self {
            last_received: Instant::now(),
        }
    }

    pub fn record_ping(&mut self) {
        self.last_received = Instant::now();
    }

    pub fn is_stale(&self) -> bool {
        self.last_received.elapsed() > HEARTBEAT_TIMEOUT
    }
}

/// UDP LAN Discovery: broadcasts our beacon and discovers nearby TwinDesk peers.
pub struct DiscoveryService {
    app: AppHandle,
    state: AppState,
    local_id: String,
    local_name: String,
    port: u16,
}

impl DiscoveryService {
    pub fn new(app: AppHandle, state: AppState, local_id: String, local_name: String, port: u16) -> Self {
        Self {
            app,
            state,
            local_id,
            local_name,
            port,
        }
    }

    pub fn start(self: Arc<Self>) {
        let s1 = Arc::clone(&self);
        tokio::spawn(async move {
            s1.run_listener().await;
        });

        let s2 = Arc::clone(&self);
        tokio::spawn(async move {
            s2.run_broadcaster().await;
        });

        let s3 = Arc::clone(&self);
        tokio::spawn(async move {
            s3.run_pruner().await;
        });
    }

    async fn run_listener(&self) {
        let bind_addr = SocketAddr::from(([0, 0, 0, 0], DISCOVERY_PORT));
        let socket = match UdpSocket::bind(bind_addr).await {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[Discovery] Failed to bind primary UDP port {}: {}. Trying random port...", DISCOVERY_PORT, e);
                match UdpSocket::bind("0.0.0.0:0").await {
                    Ok(s) => s,
                    Err(e) => {
                        log::error!("[Discovery] Failed to bind any UDP socket: {}", e);
                        return;
                    }
                }
            }
        };

        let _ = socket.set_broadcast(true);
        let mut buf = [0u8; 4096];
        log::info!("[Discovery] UDP listener running on {:?}", socket.local_addr());

        loop {
            if let Ok((len, src_addr)) = socket.recv_from(&mut buf).await {
                if let Ok(msg) = serde_json::from_slice::<WireMessage>(&buf[..len]) {
                    if msg.id.as_deref() == Some(&self.local_id) {
                        continue; // Ignore our own beacon
                    }

                    match msg.t.as_str() {
                        "beacon" => {
                            if let (Some(id), Some(name)) = (msg.id, msg.name) {
                                let peer = PeerInfo {
                                    id,
                                    name,
                                    os: msg.os.unwrap_or_else(|| "unknown".to_string()),
                                    address: Some(src_addr.ip().to_string()),
                                    port: msg.port.or(Some(DEFAULT_PORT)),
                                    last_seen: None,
                                    invited: None,
                                };
                                if self.state.update_found_peer(peer) {
                                    let snap = self.state.snapshot();
                                    let _ = self.app.emit("state-change", &snap);
                                }
                            }
                        }
                        "probe" => {
                            // Unicast answer to probe
                            let reply = WireMessage {
                                t: "beacon".to_string(),
                                v: Some(1),
                                id: Some(self.local_id.clone()),
                                name: Some(self.local_name.clone()),
                                os: Some("win".to_string()),
                                port: Some(self.port),
                                role: Some("host".to_string()),
                                dx: None, dy: None, b: None, k: None, code: None,
                                vk: None, mods: None, text: None, ts: None,
                            };
                            if let Ok(bytes) = serde_json::to_vec(&reply) {
                                let _ = socket.send_to(&bytes, src_addr).await;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    async fn run_broadcaster(&self) {
        let socket = match UdpSocket::bind("0.0.0.0:0").await {
            Ok(s) => s,
            Err(e) => {
                log::error!("[Discovery] Broadcaster failed to bind: {}", e);
                return;
            }
        };
        let _ = socket.set_broadcast(true);
        let broadcast_addr: SocketAddr = "255.255.255.255:47801".parse().unwrap();

        let beacon = WireMessage {
            t: "beacon".to_string(),
            v: Some(1),
            id: Some(self.local_id.clone()),
            name: Some(self.local_name.clone()),
            os: Some("win".to_string()),
            port: Some(self.port),
            role: Some("host".to_string()),
            dx: None, dy: None, b: None, k: None, code: None,
            vk: None, mods: None, text: None, ts: None,
        };

        let mut interval = tokio::time::interval(BEACON_INTERVAL);
        loop {
            interval.tick().await;
            if let Ok(bytes) = serde_json::to_vec(&beacon) {
                let _ = socket.send_to(&bytes, broadcast_addr).await;
            }
        }
    }

    async fn run_pruner(&self) {
        let mut interval = tokio::time::interval(Duration::from_millis(3000));
        loop {
            interval.tick().await;
            if self.state.prune_stale_peers(10000) {
                let snap = self.state.snapshot();
                let _ = self.app.emit("state-change", &snap);
            }
        }
    }
}

/// Mesh WebSocket Server listening for incoming KVM sessions.
pub struct MeshServer {
    app: AppHandle,
    state: AppState,
    port: u16,
    local_id: String,
    local_name: String,
}

impl MeshServer {
    pub fn new(app: AppHandle, state: AppState, port: u16, local_id: String, local_name: String) -> Self {
        Self {
            app,
            state,
            port,
            local_id,
            local_name,
        }
    }

    pub fn start(self: Arc<Self>) {
        tokio::spawn(async move {
            if let Err(e) = self.run().await {
                log::warn!("[MeshServer] Server stopped: {}", e);
            }
        });
    }

    async fn run(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let addr = SocketAddr::from(([0, 0, 0, 0], self.port));
        let listener = TcpListener::bind(&addr).await?;
        log::info!("[MeshServer] WebSocket server listening on {}", addr);

        while let Ok((stream, peer_addr)) = listener.accept().await {
            let app = self.app.clone();
            let state = self.state.clone();
            let local_id = self.local_id.clone();
            let local_name = self.local_name.clone();

            tokio::spawn(async move {
                if let Err(e) = Self::handle_session(stream, peer_addr, app, state, local_id, local_name).await {
                    log::info!("[MeshServer] Peer {} disconnected: {}", peer_addr, e);
                }
            });
        }

        Ok(())
    }

    async fn handle_session(
        stream: TcpStream,
        peer_addr: SocketAddr,
        app: AppHandle,
        state: AppState,
        local_id: String,
        local_name: String,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut ws = accept_async(stream).await?;
        let mut tracker = HeartbeatTracker::new();

        // Send welcome
        let welcome = WireMessage {
            t: "welcome".to_string(),
            v: Some(1),
            id: Some(local_id),
            name: Some(local_name),
            os: Some("win".to_string()),
            port: None, role: None,
            dx: None, dy: None, b: None, k: None, code: None,
            vk: None, mods: None, text: None, ts: None,
        };
        let welcome_str = serde_json::to_string(&welcome)?;
        ws.send(Message::Text(welcome_str)).await?;

        while let Some(msg_res) = ws.next().await {
            let msg = msg_res?;
            tracker.record_ping();

            match msg {
                Message::Text(txt) => {
                    if let Ok(pkt) = serde_json::from_str::<WireMessage>(&txt) {
                        Self::dispatch_incoming(&pkt, &peer_addr, &app, &state).await;
                    }
                }
                Message::Binary(bin) => {
                    if let Ok(pkt) = serde_json::from_slice::<WireMessage>(&bin) {
                        Self::dispatch_incoming(&pkt, &peer_addr, &app, &state).await;
                    }
                }
                Message::Ping(payload) => {
                    ws.send(Message::Pong(payload)).await?;
                }
                Message::Close(_) => break,
                _ => {}
            }

            if tracker.is_stale() {
                log::warn!("[MeshServer] Peer {} heartbeat timeout", peer_addr);
                break;
            }
        }

        state.set_client(None);
        state.set_where_input("home");
        let snap = state.snapshot();
        let _ = app.emit("state-change", &snap);

        Ok(())
    }

    async fn dispatch_incoming(pkt: &WireMessage, peer_addr: &SocketAddr, app: &AppHandle, state: &AppState) {
        match pkt.t.as_str() {
            "hello" => {
                let info = PeerInfo {
                    id: pkt.id.clone().unwrap_or_else(|| peer_addr.to_string()),
                    name: pkt.name.clone().unwrap_or_else(|| "Remote Peer".to_string()),
                    os: pkt.os.clone().unwrap_or_else(|| "unknown".to_string()),
                    address: Some(peer_addr.ip().to_string()),
                    port: pkt.port.or(Some(peer_addr.port())),
                    last_seen: Some(chrono::Utc::now().timestamp_millis() as u64),
                    invited: None,
                };
                state.set_client(Some(info));
                let snap = state.snapshot();
                let _ = app.emit("state-change", &snap);
            }
            "k.mm" => {
                // Inbound relative mouse move
                if let (Some(dx), Some(dy)) = (pkt.dx, pkt.dy) {
                    crate::kvm::NativeInputInjector::move_cursor_relative(dx as i32, dy as i32);
                }
            }
            "k.md" => {
                // Mouse down
                if let Some(b) = pkt.b {
                    let btn = match b {
                        0 => crate::kvm::MouseButton::Left,
                        1 => crate::kvm::MouseButton::Right,
                        _ => crate::kvm::MouseButton::Middle,
                    };
                    crate::kvm::NativeInputInjector::mouse_button(btn, true);
                }
            }
            "k.mu" => {
                // Mouse up
                if let Some(b) = pkt.b {
                    let btn = match b {
                        0 => crate::kvm::MouseButton::Left,
                        1 => crate::kvm::MouseButton::Right,
                        _ => crate::kvm::MouseButton::Middle,
                    };
                    crate::kvm::NativeInputInjector::mouse_button(btn, false);
                }
            }
            "k.wh" => {
                // Mouse wheel
                let dx = pkt.dx.unwrap_or(0.0) as i32;
                let dy = pkt.dy.unwrap_or(0.0) as i32;
                crate::kvm::NativeInputInjector::mouse_wheel(dx, dy);
            }
            "k.kd" => {
                if let Some(vk) = pkt.vk {
                    crate::kvm::NativeInputInjector::key_event(vk as u16, true, false);
                }
            }
            "k.ku" => {
                if let Some(vk) = pkt.vk {
                    crate::kvm::NativeInputInjector::key_event(vk as u16, false, false);
                }
            }
            "clip" => {
                if let Some(ref text) = pkt.text {
                    let mut cb = crate::kvm::NativeClipboard::new();
                    cb.set_text(text);
                }
            }
            "kvm.take" => {
                state.set_where_input("driven");
                let snap = state.snapshot();
                let _ = app.emit("state-change", &snap);
            }
            "kvm.home" | "kvm.release" => {
                state.set_where_input("home");
                let snap = state.snapshot();
                let _ = app.emit("state-change", &snap);
            }
            _ => {}
        }
    }
}

/// Active client connection to a remote host.
pub struct ActiveClientSession {
    pub tx: mpsc::Sender<WireMessage>,
}

#[derive(Clone)]
pub struct NetworkManager {
    app: AppHandle,
    state: AppState,
    active_client: Arc<Mutex<Option<ActiveClientSession>>>,
    local_id: String,
    local_name: String,
}

impl NetworkManager {
    pub fn new(app: AppHandle, state: AppState) -> Self {
        let local_id = state.inner.read().about.pc.host.to_lowercase();
        let local_name = state.inner.read().about.pc.host.clone();

        Self {
            app,
            state,
            active_client: Arc::new(Mutex::new(None)),
            local_id,
            local_name,
        }
    }

    pub fn start(&self) {
        let local_id = self.local_id.clone();
        let local_name = self.local_name.clone();

        // 1. Start UDP discovery
        let discovery = Arc::new(DiscoveryService::new(
            self.app.clone(),
            self.state.clone(),
            local_id.clone(),
            local_name.clone(),
            DEFAULT_PORT,
        ));
        discovery.start();

        // 2. Start WebSocket server
        let server = Arc::new(MeshServer::new(
            self.app.clone(),
            self.state.clone(),
            DEFAULT_PORT,
            local_id,
            local_name,
        ));
        server.start();
    }

    pub async fn connect_to(&self, target_addr: &str) -> Result<(), String> {
        let url = if target_addr.starts_with("ws://") || target_addr.starts_with("wss://") {
            target_addr.to_string()
        } else if target_addr.contains(':') {
            format!("ws://{}", target_addr)
        } else {
            format!("ws://{}:{}", target_addr, DEFAULT_PORT)
        };

        log::info!("[NetworkManager] Connecting to {}", url);
        let (ws, _) = connect_async(&url).await.map_err(|e| format!("Failed to connect: {}", e))?;
        let (mut write, mut read) = ws.split();

        let (out_tx, mut out_rx) = mpsc::channel::<WireMessage>(256);
        {
            let mut guard = self.active_client.lock().await;
            *guard = Some(ActiveClientSession { tx: out_tx.clone() });
        }

        // Send hello
        let hello = WireMessage {
            t: "hello".to_string(),
            v: Some(1),
            id: Some(self.local_id.clone()),
            name: Some(self.local_name.clone()),
            os: Some("win".to_string()),
            port: Some(DEFAULT_PORT),
            role: Some("guest".to_string()),
            dx: None, dy: None, b: None, k: None, code: None,
            vk: None, mods: None, text: None, ts: None,
        };
        let hello_str = serde_json::to_string(&hello).map_err(|e| e.to_string())?;
        write.send(Message::Text(hello_str)).await.map_err(|e| e.to_string())?;

        let app = self.app.clone();
        let state = self.state.clone();
        let client_lock = Arc::clone(&self.active_client);

        tokio::spawn(async move {
            let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
            let mut tracker = HeartbeatTracker::new();

            loop {
                tokio::select! {
                    _ = heartbeat.tick() => {
                        if tracker.is_stale() {
                            log::warn!("[MeshClient] Remote peer heartbeat timeout");
                            break;
                        }
                        let ping = WireMessage {
                            t: "ping".to_string(),
                            v: Some(1),
                            id: None, name: None, os: None, port: None, role: None,
                            dx: None, dy: None, b: None, k: None, code: None,
                            vk: None, mods: None, text: None, ts: None,
                        };
                        if let Ok(json) = serde_json::to_string(&ping) {
                            let _ = write.send(Message::Text(json)).await;
                        }
                    }

                    Some(pkt) = out_rx.recv() => {
                        if let Ok(json) = serde_json::to_string(&pkt) {
                            if write.send(Message::Text(json)).await.is_err() {
                                break;
                            }
                        }
                    }

                    Some(msg_res) = read.next() => {
                        match msg_res {
                            Ok(msg) => {
                                tracker.record_ping();
                                match msg {
                                    Message::Text(txt) => {
                                        if let Ok(pkt) = serde_json::from_str::<WireMessage>(&txt) {
                                            MeshServer::dispatch_incoming(&pkt, &"127.0.0.1:0".parse().unwrap(), &app, &state).await;
                                        }
                                    }
                                    Message::Close(_) => break,
                                    _ => {}
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
            }

            let mut guard = client_lock.lock().await;
            *guard = None;
            state.set_client(None);
            state.set_where_input("home");
            let snap = state.snapshot();
            let _ = app.emit("state-change", &snap);
        });

        Ok(())
    }

    pub async fn send_packet(&self, pkt: WireMessage) {
        let guard = self.active_client.lock().await;
        if let Some(ref session) = *guard {
            let _ = session.tx.send(pkt).await;
        }
    }

    pub async fn disconnect(&self) {
        let mut guard = self.active_client.lock().await;
        if let Some(session) = guard.take() {
            let bye = WireMessage {
                t: "bye".to_string(),
                v: Some(1),
                id: Some(self.local_id.clone()),
                name: None, os: None, port: None, role: None,
                dx: None, dy: None, b: None, k: None, code: None,
                vk: None, mods: None, text: None, ts: None,
            };
            let _ = session.tx.send(bye).await;
        }
        self.state.set_client(None);
        self.state.set_where_input("home");
        let snap = self.state.snapshot();
        let _ = self.app.emit("state-change", &snap);
    }
}
