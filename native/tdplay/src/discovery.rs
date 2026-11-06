// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Based on AirBridge (by Jannik Beyerstein, GPL-3.0).

use crate::config::*;
use crate::identity::{Identity, hex};
use anyhow::Result;
use mdns_sd::{ServiceDaemon, ServiceInfo};

pub fn announce(id: &Identity, name: &str, rtsp_port: u16) -> Result<ServiceDaemon> {
    let daemon = ServiceDaemon::new()?;
    let host = "twindesk.local.";
    let pk = hex(&id.public());
    let device_id = id.device_id();
    let pi = id.pi();

    // --- _airplay._tcp ---
    let airplay_txt = [
        ("deviceid", device_id.as_str()),
        ("features", FEATURES_TXT),
        ("model", MODEL),
        ("srcvers", SRCVERS),
        ("flags", "0x4"),
        ("pk", pk.as_str()),
        ("pi", pi.as_str()),
        ("vv", "2"),
    ];
    let airplay = ServiceInfo::new(
        "_airplay._tcp.local.",
        name,
        host,
        "",
        rtsp_port,
        &airplay_txt[..],
    )?
    .enable_addr_auto();
    daemon.register(airplay)?;

    // --- _raop._tcp --- (instance name: <MAC without colons>@<name>)
    let raop_name = format!("{}@{}", device_id.replace(':', ""), name);
    let raop_txt = [
        ("txtvers", "1"),
        ("ch", "2"),
        ("cn", AUDIO_CN),
        ("da", "true"),
        ("et", "0,3,5"),
        ("md", "0,1,2"),
        ("pw", "false"),
        ("sv", "false"),
        ("sr", "44100"),
        ("ss", "16"),
        ("tp", "UDP"),
        ("vn", "65537"),
        ("vs", SRCVERS),
        ("am", MODEL),
        ("sf", "0x4"),
        ("ft", FEATURES_TXT),
        ("pk", pk.as_str()),
    ];
    let raop = ServiceInfo::new(
        "_raop._tcp.local.",
        &raop_name,
        host,
        "",
        rtsp_port,
        &raop_txt[..],
    )?
    .enable_addr_auto();
    daemon.register(raop)?;

    eprintln!("[tdplay] Advertised AirPlay mDNS service as '{name}' on port {rtsp_port}");
    Ok(daemon)
}
