// TwinDesk tdplay — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Based on AirBridge (by Jannik Beyerstein, GPL-3.0) and UxPlay (GPL-3.0).

use crate::config;
use crate::fairplay::FairPlay;
use crate::identity::Identity;
use crate::mirror::Slot;
use crate::pairing::{self, VerifySession};
use crate::stream::{self, StreamState};
use anyhow::{anyhow, Result};
use plist::{Dictionary, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

struct Request {
    method: String,
    path: String,
    proto: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct Response {
    code: u16,
    text: &'static str,
    content_type: Option<&'static str>,
    extra: Vec<(&'static str, &'static str)>,
    body: Vec<u8>,
}

impl Response {
    fn ok(content_type: &'static str, body: Vec<u8>) -> Self {
        Self {
            code: 200,
            text: "OK",
            content_type: Some(content_type),
            extra: Vec::new(),
            body,
        }
    }
    fn empty() -> Self {
        Self::status(200, "OK")
    }
    fn status(code: u16, text: &'static str) -> Self {
        Self {
            code,
            text,
            content_type: None,
            extra: Vec::new(),
            body: Vec::new(),
        }
    }
    fn header(mut self, name: &'static str, value: &'static str) -> Self {
        self.extra.push((name, value));
        self
    }
}

pub fn serve(identity: Arc<Identity>, mirror: Slot, name: String, port: u16, mirror_port: u16) -> Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port))?;
    eprintln!("[tdplay] RTSP server listening on port {port}");
    for stream in listener.incoming() {
        let stream = stream?;
        let identity = Arc::clone(&identity);
        let mirror = Arc::clone(&mirror);
        let name = name.clone();
        thread::spawn(move || {
            let _ = handle(stream, &identity, &mirror, &name, mirror_port);
        });
    }
    Ok(())
}

struct Conn {
    peer_ip: Option<IpAddr>,
    verify: Option<VerifySession>,
    fairplay: FairPlay,
    stream: StreamState,
}

impl Default for Conn {
    fn default() -> Self {
        Self {
            peer_ip: None,
            verify: None,
            fairplay: FairPlay::default(),
            stream: StreamState::default(),
        }
    }
}

fn handle(stream: TcpStream, identity: &Identity, mirror: &Slot, name: &str, mirror_port: u16) -> Result<()> {
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut conn = Conn {
        peer_ip: writer.peer_addr().ok().map(|a| a.ip()),
        ..Default::default()
    };

    while let Some(req) = read_request(&mut reader)? {
        let cseq = req.headers.get("cseq").cloned();
        let res = route(&req, &mut conn, identity, mirror, name, mirror_port)?;

        let mut header = format!("{} {} {}\r\n", req.proto, res.code, res.text);
        if let Some(cseq) = cseq {
            header.push_str(&format!("CSeq: {cseq}\r\n"));
        }
        header.push_str("Server: AirTunes/220.68\r\n");
        for (k, v) in &res.extra {
            header.push_str(&format!("{k}: {v}\r\n"));
        }
        if let Some(ct) = res.content_type {
            header.push_str(&format!("Content-Type: {ct}\r\n"));
        }
        header.push_str(&format!("Content-Length: {}\r\n", res.body.len()));
        header.push_str("\r\n");

        writer.write_all(header.as_bytes())?;
        if !res.body.is_empty() {
            writer.write_all(&res.body)?;
        }
        writer.flush()?;

        if req.method == "TEARDOWN" {
            break;
        }
    }
    Ok(())
}

fn route(
    req: &Request,
    conn: &mut Conn,
    id: &Identity,
    mirror: &Slot,
    name: &str,
    mirror_port: u16,
) -> Result<Response> {
    match (req.method.as_str(), req.path.as_str()) {
        ("SETUP", _) => {
            let secret = conn.verify.as_ref().map(|v| v.shared);
            let reply = stream::setup(
                &mut conn.stream,
                &conn.fairplay,
                secret,
                conn.peer_ip,
                mirror,
                mirror_port,
                &req.body,
            )?;
            Ok(Response::ok("application/x-apple-binary-plist", reply))
        }
        ("OPTIONS", _) => Ok(Response::empty().header(
            "Public",
            "SETUP, RECORD, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER",
        )),
        ("RECORD", _) => Ok(Response::empty()
            .header("Audio-Latency", "0")
            .header("Audio-Jack-Status", "connected; type=analog")),
        ("GET_PARAMETER", _) => Ok(Response::ok("text/parameters", b"volume: 0.000000\r\n".to_vec())),
        ("SET_PARAMETER", _) | ("FLUSH", _) | ("TEARDOWN", _) => Ok(Response::empty()),
        ("POST", "/feedback" | "/command") => Ok(Response::empty()),
        ("POST", "/fp-setup") => {
            let reply = match req.body.len() {
                16 => conn.fairplay.setup(&req.body)?,
                164 => conn.fairplay.handshake(&req.body)?,
                n => return Err(anyhow!("fp-setup with invalid length {n}")),
            };
            Ok(Response::ok("application/octet-stream", reply))
        }
        ("GET", "/info") => Ok(Response::ok(
            "application/x-apple-binary-plist",
            info_plist(id, name)?,
        )),
        ("POST", "/pair-setup") => Ok(Response::ok(
            "application/octet-stream",
            id.public().to_vec(),
        )),
        ("POST", "/pair-verify") => match req.body.first() {
            Some(1) => {
                let (session, reply) = pairing::verify_step1(id, &req.body)?;
                conn.verify = Some(session);
                Ok(Response::ok("application/octet-stream", reply))
            }
            Some(0) => {
                let session = conn
                    .verify
                    .as_mut()
                    .ok_or_else(|| anyhow!("pair-verify step 2 without step 1"))?;
                pairing::verify_step2(session, &req.body)?;
                Ok(Response::ok("application/octet-stream", Vec::new()))
            }
            _ => Err(anyhow!("empty pair-verify body")),
        },
        _ => Ok(Response::status(501, "Not Implemented")),
    }
}

fn info_plist(id: &Identity, name: &str) -> Result<Vec<u8>> {
    let s = |v: &str| Value::String(v.to_string());
    let n = |v: u64| Value::Integer(v.into());
    let dict = |items: Vec<(&str, Value)>| {
        let mut d = Dictionary::new();
        for (k, v) in items {
            d.insert(k.to_string(), v);
        }
        Value::Dictionary(d)
    };
    let display = dict(vec![
        ("uuid", s("e0ff8a27-6738-3d56-8a16-cc53aacee925")),
        ("width", n(1920)),
        ("height", n(1080)),
        ("widthPixels", n(1920)),
        ("heightPixels", n(1080)),
        ("rotation", Value::Boolean(false)),
        ("refreshRate", Value::Real(1.0 / 60.0)),
        ("maxFPS", n(60)),
        ("overscanned", Value::Boolean(false)),
        ("features", n(14)),
    ]);
    let root = dict(vec![
        ("deviceID", s(&id.device_id())),
        ("macAddress", s(&id.device_id())),
        ("pk", Value::Data(id.public().to_vec())),
        ("features", n(config::FEATURES)),
        ("name", s(name)),
        ("pi", s(&id.pi())),
        ("vv", n(2)),
        ("statusFlags", n(68)),
        ("sourceVersion", s(config::SRCVERS)),
        ("model", s(config::MODEL)),
        ("displays", Value::Array(vec![display])),
    ]);
    let mut out = Vec::new();
    root.to_writer_binary(&mut out)?;
    Ok(out)
}

fn read_request<R: BufRead>(reader: &mut R) -> Result<Option<Request>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let parts: Vec<&str> = line.trim().split_whitespace().collect();
    if parts.len() < 3 {
        return Ok(None);
    }
    let (method, path, proto) = (parts[0].to_string(), parts[1].to_string(), parts[2].to_string());

    let mut headers = HashMap::new();
    let mut content_length = 0usize;
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_lowercase();
            let val = v.trim().to_string();
            if key == "content-length" {
                content_length = val.parse().unwrap_or(0);
            }
            headers.insert(key, val);
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    Ok(Some(Request {
        method,
        path,
        proto,
        headers,
        body,
    }))
}
