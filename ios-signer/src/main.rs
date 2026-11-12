// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The iOS signing helper. One run does one thing, asked for by one line of JSON on stdin and
// answered by lines of JSON on stdout (the app's shared/iossign.js is the other end):
//
//   {"op":"info"}                  what this build does (anyIpa) and its default anisette server
//   {"op":"devices"}               the iPhones and iPads usbmuxd sees
//   {"op":"apps","udid":…}         the sideloaded apps on a device and when each expires
//   {"op":"appids","state":{…}}    the Apple ID's app IDs, with a kept developer session (no password)
//   {"op":"install","udid":…[,"ipa":path][,"twindesk_ipa":path][,"save_ipa":path][,"profile_only":bundleId[,"no_ipa":true]][,"new_cert":true][,"anisette":url] and either
//        "sealed":true             the Apple ID comes from the iPhone, sealed for this run (below)
//     or "email":…,"password":…[,"state":{…}]   typed on this computer, for this run only}
//
// install signs in to Apple (GrandSlam, as Xcode does), makes or reuses a development certificate
// named "TwinDesk", registers the device and the app's ids, signs the app and installs it. While it
// runs it may ask: {"ev":"need2fa",…} wants {"code":"123456"} (or {"sms":id}, {"devices":true},
// {"resend":true}, {"abort":true}); {"ev":"needcert","certs":[…]} (no free certificate slot) wants
// {"revoke":["serial",…]} or {"abort":true}. A certificate is only ever revoked by that answer, or
// with "new_cert" (Start over: TwinDesk's own, asked for by the person).
//
// NOTHING IS KEPT ON THE COMPUTER. No keychain, no file, no log: this process has what it needs
// while it runs and then it is gone. What has to last from one refresh to the next (the
// certificate's private key and the anisette identity: "state") is handed back in {"ev":"state"}
// for the iPhone to keep in its own Keychain, next to the Apple ID, and comes in again with the
// next request. So the same iPhone refreshed from a Mac one day and a PC the next uses one
// certificate and one identity, and a computer that is sold or stolen holds nothing.
//
// Sealed: the app that runs this is a pipe, and its console goes to a log file, so the Apple ID
// never passes through it in the clear. This prints {"ev":"key","pub":…} (X25519, made for this run);
// the iPhone answers {"pub":…,"box":…}: its own key for this run and {"email","password","state"}
// under ChaCha20-Poly1305, the keys from HKDF-SHA256 over the shared secret (salt: both public keys;
// one key each way; the nonce counts messages). Every answer after that is {"box":…} too, and the
// state goes back the same way. ios/TwinDesk/Core/Signer.swift is the other end.
//
// What goes where: the Apple ID and the password's proof go to Apple (gsa.apple.com) and nowhere
// else; the anisette server gets the state's random identifier and Apple's provisioning blob for
// it, never the Apple ID, the password, a code or a token.
//
// Without the any-ipa feature the only app this signs is TwinDesk's own, which it downloads itself
// from the project's releases; a path from outside is refused. twindesk_ipa: a copy of TwinDesk the
// app keeps (checked: its main app must be com.twindesk.ios), used in place of the download;
// save_ipa: where a download is copied to, so the next refresh needn't download it again.
// profile_only: the app is installed and this is a refresh. As AltStore does, only new provisioning
// profiles are installed (the app and its data stay as they are) when Apple's new profiles still hold
// the certificate the app was signed with; otherwise the app is signed and installed again.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::prelude::*;
use futures_util::StreamExt;
use idevice::{
    IdeviceService,
    installation_proxy::InstallationProxyClient,
    misagent::MisagentClient,
    provider::UsbmuxdProvider,
    usbmuxd::{Connection, UsbmuxdAddr, UsbmuxdConnection},
};
use isideload::{
    SideloadError,
    anisette::remote_v3::{DEFAULT_ANISETTE_V3_URL, RemoteV3AnisetteProvider},
    auth::apple_account::{AppToken, AppleAccount, TwoFactorCallbackParams, TwoFactorCallbackResponse},
    dev::{
        certificates::DevelopmentCertificate, developer_session::DeveloperSession,
        app_ids::AppIdsApi, certificates::CertificatesApi, devices::DevicesApi, teams::TeamsApi,
    },
    sideload::{SideloaderBuilder, TeamSelection, builder::MaxCertsBehavior, install},
    util::{
        callbacks::ExtensionsBehaviorCallbackBox, device::IdeviceInfo, storage::SideloadingStorage,
    },
};
use ring::{
    aead, agreement, hkdf,
    rand::{SecureRandom, SystemRandom},
};
use rootcause::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::{Mutex, mpsc},
};
use zeroize::Zeroizing;

const MACHINE_NAME: &str = "TwinDesk";
const TWINDESK_IPA: &str = "https://github.com/InukaAsith/TwinDesk/releases/latest/download/TwinDesk.ipa";
const MAX_IPA: u64 = 1 << 30;
const MAX_LINE: usize = 64 * 1024;
const ASK_SECS: u64 = 10 * 60;
const KEY_ANISETTE_URL: &str = "anisette_url";
const KEY_ANISETTE_STATE: &str = "anisette_state"; // isideload's name for it
// The developer session, kept in the state in place of the password: Apple's token for Xcode's
// services (certificates, app ids, devices: nothing else of the account), good for about a year.
const KEY_EMAIL: &str = "email";
const KEY_ADSID: &str = "adsid";
const KEY_TOKEN: &str = "xcode_token";
const KEY_TOKEN_EXPIRY: &str = "xcode_token_expiry"; // ms since 1970, as Apple gives it
const KEY_TOKEN_DURATION: &str = "xcode_token_duration";
const INFO_IN: &[u8] = b"TwinDesk iOS signing 1: phone to helper";
const INFO_OUT: &[u8] = b"TwinDesk iOS signing 1: helper to phone";

type State = BTreeMap<String, String>;

#[derive(Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    udid: String,
    #[serde(default)]
    sealed: bool,
    #[serde(default)]
    email: String,
    password: Option<String>,
    state: Option<State>,
    ipa: Option<String>,
    twindesk_ipa: Option<String>,
    save_ipa: Option<String>,
    profile_only: Option<String>,
    #[serde(default)]
    no_ipa: bool,
    #[serde(default)]
    new_cert: bool,
    anisette: Option<String>,
}

// What only the iPhone (or the person typing) knows.
#[derive(Deserialize, Default)]
struct Secret {
    #[serde(default)]
    email: String,
    password: Option<String>,
    state: Option<State>,
}

fn emit(v: Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

// The state while this runs: isideload's storage, in memory.
#[derive(Clone, Default)]
struct Mem(Arc<std::sync::Mutex<State>>);

impl Mem {
    fn map(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn get(&self, key: &str) -> Option<String> {
        self.map().get(key).filter(|v| !v.is_empty()).cloned()
    }
}

impl SideloadingStorage for Mem {
    fn store(&self, key: &str, value: &str) -> Result<(), Report> {
        self.map().insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn retrieve(&self, key: &str) -> Result<Option<String>, Report> {
        Ok(self.get(key))
    }
    fn delete(&self, key: &str) -> Result<(), Report> {
        self.map().remove(key);
        Ok(())
    }
}

// The two keys of a sealed run and how many messages each has carried.
struct Sealed {
    opens: aead::LessSafeKey,
    seals: aead::LessSafeKey,
    opened: u64,
    sealed: u64,
}

fn nonce(n: u64) -> aead::Nonce {
    let mut b = [0u8; 12];
    b[4..].copy_from_slice(&n.to_be_bytes());
    aead::Nonce::assume_unique_for_key(b)
}

impl Sealed {
    fn open(&mut self, b64: &str) -> Result<Zeroizing<Vec<u8>>, Report> {
        let mut buf = Zeroizing::new(BASE64_STANDARD.decode(b64).map_err(|_| report!("The sealed message didn't open"))?);
        let n = self.opened;
        self.opened += 1;
        let len = self
            .opens
            .open_in_place(nonce(n), aead::Aad::empty(), &mut buf)
            .map_err(|_| report!("The sealed message didn't open"))?
            .len();
        buf.truncate(len);
        Ok(buf)
    }

    fn seal(&mut self, plain: &[u8]) -> Result<String, Report> {
        let mut buf = Zeroizing::new(plain.to_vec());
        let n = self.sealed;
        self.sealed += 1;
        self.seals
            .seal_in_place_append_tag(nonce(n), aead::Aad::empty(), &mut *buf)
            .map_err(|_| report!("Couldn't seal"))?;
        Ok(BASE64_STANDARD.encode(&*buf))
    }
}

type Lines = Arc<Mutex<mpsc::Receiver<String>>>;

async fn line(lines: &Lines) -> Option<Value> {
    let line = Zeroizing::new(lines.lock().await.recv().await?);
    serde_json::from_str(&line).ok()
}

// Whoever answers this run's questions: the app in the clear, or the iPhone through it, sealed.
#[derive(Clone)]
struct Io {
    lines: Lines,
    seal: Option<Arc<std::sync::Mutex<Sealed>>>,
}

impl Io {
    // In a sealed run only a sealed answer counts: the pipe in between can't answer for the iPhone
    // (which certificate to revoke, say). Anything else reads as no answer, and that as "stop".
    // Unanswered for ASK_SECS (nobody at either screen): no answer, and the run ends.
    async fn ask(&self) -> Option<Value> {
        let v = tokio::time::timeout(std::time::Duration::from_secs(ASK_SECS), line(&self.lines)).await.ok()??;
        match &self.seal {
            None => Some(v),
            Some(s) => {
                let plain = s.lock().unwrap_or_else(|e| e.into_inner()).open(v.get("box")?.as_str()?).ok()?;
                serde_json::from_slice(&plain).ok()
            }
        }
    }

    fn state(&self, state: &State) -> Result<(), Report> {
        match &self.seal {
            None => emit(json!({"ev": "state", "state": state})),
            Some(s) => {
                let plain = Zeroizing::new(serde_json::to_vec(state)?);
                emit(json!({"ev": "state", "box": s.lock().unwrap_or_else(|e| e.into_inner()).seal(&plain)?}));
            }
        }
        Ok(())
    }
}

// This run's key out, the iPhone's key and first box in: the two keys, and what the box held.
async fn handshake(lines: &Lines) -> Result<(Sealed, Secret), Report> {
    let bad = || report!("The sealed request didn't open");
    let mine = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &SystemRandom::new()).map_err(|_| report!("No key"))?;
    let my_pub = mine.compute_public_key().map_err(|_| report!("No key"))?;
    emit(json!({"ev": "key", "pub": BASE64_STANDARD.encode(my_pub.as_ref())}));

    let first = line(lines).await.ok_or_else(|| report!("No sealed request"))?;
    let their = first
        .get("pub")
        .and_then(|v| v.as_str())
        .and_then(|s| BASE64_STANDARD.decode(s).ok())
        .filter(|b| b.len() == 32)
        .ok_or_else(bad)?;
    let mut salt = my_pub.as_ref().to_vec();
    salt.extend_from_slice(&their);
    let (opens, seals) = agreement::agree_ephemeral(mine, &agreement::UnparsedPublicKey::new(&agreement::X25519, &their), |shared| {
        let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt).extract(shared);
        let key = |info: &[u8]| -> Result<aead::LessSafeKey, ring::error::Unspecified> {
            let info = [info];
            let okm = prk.expand(&info, &aead::CHACHA20_POLY1305)?;
            Ok(aead::LessSafeKey::new(aead::UnboundKey::from(okm)))
        };
        Ok::<_, ring::error::Unspecified>((key(INFO_IN)?, key(INFO_OUT)?))
    })
    .map_err(|_| bad())?
    .map_err(|_| bad())?;
    let mut sealed = Sealed { opens, seals, opened: 0, sealed: 0 };
    let plain = sealed.open(first.get("box").and_then(|v| v.as_str()).ok_or_else(bad)?)?;
    let secret: Secret = serde_json::from_slice(&plain).map_err(|_| bad())?;
    Ok((sealed, secret))
}

// The top of an error and Apple's code for it, without the attachments (those can hold what Apple
// answered: nothing of it belongs in the app's log).
fn fail(e: &Report) -> Value {
    let found = e
        .iter_reports()
        .find_map(|n| n.downcast_current_context::<SideloadError>().map(|c| match c {
            SideloadError::AuthWithMessage(code, m) => ("auth", Some(*code), m.clone()),
            SideloadError::DeveloperError(code, m) => ("developer", Some(*code), m.clone()),
            SideloadError::IdeviceError(d) => ("device", None, d.to_string()),
            other => ("app", None, other.to_string()),
        }));
    let chain: Vec<String> = e.iter_reports().map(|n| n.format_current_context().to_string()).collect();
    let first = chain.first().cloned().unwrap_or_default();
    match found {
        Some((kind, code, detail)) => json!({"ev": "error", "kind": kind, "code": code, "message": first, "detail": detail}),
        None => json!({"ev": "error", "kind": "other", "message": first, "detail": chain.last().cloned().unwrap_or_default()}),
    }
}

async fn devices() -> Result<Value, Report> {
    let mut mux = UsbmuxdConnection::default().await.map_err(SideloadError::IdeviceError)?;
    let list = mux.get_devices().await.map_err(SideloadError::IdeviceError)?;
    // One device can be there twice (its cable and Wi-Fi): one entry, with the address it has on Wi-Fi.
    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    for d in &list {
        let e = out.entry(d.udid.clone()).or_insert_with(|| json!({"udid": d.udid, "usb": false, "ip": "", "name": ""}));
        match &d.connection_type {
            Connection::Usb => e["usb"] = json!(true),
            Connection::Network(ip) => e["ip"] = json!(ip.to_string()),
            Connection::Unknown(_) => {}
        }
    }
    for (udid, e) in out.iter_mut() {
        let name = async { IdeviceInfo::from_device(&provider(udid).await?).await };
        if let Ok(Ok(info)) = tokio::time::timeout(std::time::Duration::from_secs(4), name).await {
            e["name"] = json!(info.name);
        }
    }
    Ok(json!({"ev": "devices", "devices": out.into_values().collect::<Vec<_>>()}))
}

async fn provider(udid: &str) -> Result<UsbmuxdProvider, Report> {
    let mut mux = UsbmuxdConnection::default().await.map_err(SideloadError::IdeviceError)?;
    let list = mux.get_devices().await.map_err(SideloadError::IdeviceError)?;
    let mut found: Vec<_> = list.into_iter().filter(|d| d.udid == udid).collect();
    found.sort_by_key(|d| d.connection_type != Connection::Usb); // the cable first
    let dev = found.into_iter().next().ok_or_else(|| report!("That device isn't connected"))?;
    Ok(dev.to_provider(UsbmuxdAddr::default(), "TwinDesk"))
}

// A provisioning profile is a signed (CMS) envelope around an XML property list.
fn profile_plist(raw: &[u8]) -> Option<plist::Dictionary> {
    let find = |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).position(|w| w == needle);
    let start = find(raw, b"<?xml")?;
    let end = start + find(&raw[start..], b"</plist>")? + b"</plist>".len();
    plist::from_bytes(&raw[start..end]).ok()
}

fn secs(d: &plist::Date) -> u64 {
    SystemTime::from(*d).duration_since(UNIX_EPOCH).map(|x| x.as_secs()).unwrap_or(0)
}

async fn apps(udid: &str) -> Result<Value, Report> {
    let p = provider(udid).await?;
    let mut mis = MisagentClient::connect(&p).await.map_err(SideloadError::IdeviceError)?;
    let profiles = mis.copy_all().await.map_err(SideloadError::IdeviceError)?;
    let mut proxy = InstallationProxyClient::connect(&p).await.map_err(SideloadError::IdeviceError)?;
    let installed = proxy.get_apps(Some("User"), None).await.map_err(SideloadError::IdeviceError)?;

    let mut out = BTreeMap::new();
    for raw in profiles {
        let Some(d) = profile_plist(&raw) else { continue };
        let ent = d.get("Entitlements").and_then(|v| v.as_dictionary());
        let app_id = ent.and_then(|e| e.get("application-identifier")).and_then(|v| v.as_string()).unwrap_or("");
        let team = ent.and_then(|e| e.get("com.apple.developer.team-identifier")).and_then(|v| v.as_string()).unwrap_or("");
        // "TEAMID.bundle.id": the app this profile is for, when it is installed
        let bundle = app_id.split_once('.').map(|(_, b)| b).unwrap_or("");
        let Some(info) = installed.get(bundle).and_then(|v| v.as_dictionary()) else { continue };
        let name = ["CFBundleDisplayName", "CFBundleName"]
            .iter()
            .find_map(|k| info.get(k).and_then(|v| v.as_string()))
            .unwrap_or(bundle);
        // An app refreshed before leaves its older profiles behind: the newest one counts.
        let expires = d.get("ExpirationDate").and_then(|v| v.as_date()).map(|x| secs(&x)).unwrap_or(0);
        if out.get(bundle).and_then(|v: &Value| v.get("expires")).and_then(|v| v.as_u64()).is_some_and(|e| e >= expires) {
            continue;
        }
        out.insert(bundle.to_string(), json!({
            "bundleId": bundle,
            "name": name,
            "version": info.get("CFBundleShortVersionString").and_then(|v| v.as_string()).unwrap_or(""),
            "team": team,
            "teamName": d.get("TeamName").and_then(|v| v.as_string()).unwrap_or(""),
            "expires": expires,
        }));
    }
    Ok(json!({"ev": "apps", "apps": out.into_values().collect::<Vec<_>>()}))
}

async fn download(to: &Path) -> Result<(), Report> {
    use tokio::io::AsyncWriteExt;
    let client = reqwest::Client::builder().https_only(true).build()?;
    let resp = client.get(TWINDESK_IPA).send().await?.error_for_status()?;
    if resp.content_length().is_some_and(|n| n > MAX_IPA) {
        bail!("The download is too large");
    }
    let mut file = tokio::fs::File::create(to).await?;
    let mut got = 0u64;
    let mut body = resp.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        got += chunk.len() as u64;
        if got > MAX_IPA {
            bail!("The download is too large");
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(())
}

// A refresh without reinstalling: Apple's current profile for the app and each of its extensions,
// installed on the device. Some(expiry) when done; None when it can't be done that way (no profile on
// the device, an app ID missing, or the new profiles no longer hold the certificate the app was signed
// with: a revoked or replaced certificate needs the app signed again).
async fn profiles_only(
    device: &UsbmuxdProvider,
    dev: &mut DeveloperSession,
    team: &isideload::dev::teams::DeveloperTeam,
    udid: &str,
    bundle: &str,
) -> Result<Result<u64, &'static str>, Report> {
    let mut mis = MisagentClient::connect(device).await.map_err(SideloadError::IdeviceError)?;
    let installed = mis.copy_all().await.map_err(SideloadError::IdeviceError)?;
    let ours = |id: &str| id == bundle || id.strip_prefix(bundle).is_some_and(|r| r.starts_with('.'));
    // On the device: the newest profile per app ID of this app, and the certificates in them.
    let mut old: BTreeMap<String, (u64, Vec<Vec<u8>>)> = BTreeMap::new();
    for raw in installed {
        let Some(d) = profile_plist(&raw) else { continue };
        let Some(id) = d
            .get("Entitlements")
            .and_then(|v| v.as_dictionary())
            .and_then(|e| e.get("application-identifier"))
            .and_then(|v| v.as_string())
            .and_then(|s| s.split_once('.').map(|(_, b)| b.to_string()))
        else { continue };
        if !ours(&id) {
            continue;
        }
        let expires = d.get("ExpirationDate").and_then(|v| v.as_date()).map(|x| secs(&x)).unwrap_or(0);
        let certs = certs_of(&d);
        if old.get(&id).is_none_or(|(e, _)| *e < expires) {
            old.insert(id, (expires, certs));
        }
    }
    let Some((old_main, signed_with)) = old.get(bundle).cloned() else { return Ok(Err("Its provisioning profile isn’t on the device.")) };

    emit(json!({"ev": "step", "step": "profile"}));
    let ids = dev.list_app_ids(team, None).await.context("Apple didn't list the app IDs")?;
    let mut fresh = Vec::new();
    let mut main = 0;
    for id in old.keys() {
        let Some(app_id) = ids.app_ids.iter().find(|a| &a.identifier == id) else {
            return Ok(Err("It was signed with another Apple ID, or its app ID was removed."));
        };
        let profile = dev.download_team_provisioning_profile(team, app_id, None).await.context("Apple didn't give the provisioning profile")?;
        let raw: Vec<u8> = profile.encoded_profile.into();
        let Some(d) = profile_plist(&raw) else { return Ok(Err("Apple’s profile couldn’t be read.")) };
        let devices = d.get("ProvisionedDevices").and_then(|v| v.as_array());
        let has_device = devices.is_some_and(|a| a.iter().any(|v| v.as_string() == Some(udid)));
        let has_cert = certs_of(&d).iter().any(|c| signed_with.contains(c));
        if !has_device {
            return Ok(Err("Apple’s profile doesn’t include this device."));
        }
        if !has_cert {
            return Ok(Err("The certificate it was signed with is no longer valid."));
        }
        if id == bundle {
            main = d.get("ExpirationDate").and_then(|v| v.as_date()).map(|x| secs(&x)).unwrap_or(0);
        }
        fresh.push(raw);
    }
    // Apple gave nothing newer: signing again wouldn't either, but it's the only other way.
    if main <= old_main {
        return Ok(Err("Apple gave no newer profile."));
    }
    emit(json!({"ev": "step", "step": "installprofile"}));
    for raw in fresh {
        mis.install(raw).await.map_err(SideloadError::IdeviceError).context("The device didn't take the profile")?;
    }
    Ok(Ok(main))
}

fn certs_of(d: &plist::Dictionary) -> Vec<Vec<u8>> {
    d.get("DeveloperCertificates")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|c| c.as_data().map(<[u8]>::to_vec)).collect())
        .unwrap_or_default()
}

enum Source {
    Ipa(PathBuf),
    Nothing,
    TwinDesk { cached: Option<PathBuf>, save: Option<PathBuf> },
}

// An IPA whose main app is TwinDesk: com.twindesk.ios as built, or com.twindesk.ios.TEAMID signed before.
fn is_twindesk(path: &Path) -> bool {
    let check = || -> Option<bool> {
        let file = std::fs::File::open(path).ok()?;
        if file.metadata().ok()?.len() > MAX_IPA {
            return Some(false);
        }
        let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).ok()?;
        let name = (0..zip.len()).filter_map(|i| zip.name_for_index(i).map(str::to_string)).find(|n| {
            let parts: Vec<&str> = n.split('/').collect();
            parts.len() == 3 && parts[0] == "Payload" && parts[1].ends_with(".app") && parts[2] == "Info.plist"
        })?;
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(zip.by_name(&name).ok()?, 4 << 20), &mut raw).ok()?;
        let info: plist::Dictionary = plist::from_bytes(&raw).ok()?;
        // As built (com.twindesk.ios), or a copy signed before (com.twindesk.ios.TEAMID).
        let id = info.get("CFBundleIdentifier").and_then(|v| v.as_string()).unwrap_or("");
        Some(id == "com.twindesk.ios" || id.strip_prefix("com.twindesk.ios.").is_some_and(|t| !t.is_empty() && !t.contains('.')))
    };
    check().unwrap_or(false)
}

// TwinDesk signed here carries "TDInstalledBy": "TwinDesk" in its Info.plist (added before signing,
// so the signature covers it). The app reads it to know a computer's TwinDesk installed it, not
// AltStore or SideStore: its Overview refresh card and its update through the computer show only then.
const MARK_KEY: &str = "TDInstalledBy";

fn marked(src: &Path, tmp: &Path) -> Option<PathBuf> {
    use std::io::{Read, Write};
    let mut zin = zip::ZipArchive::new(std::io::BufReader::new(std::fs::File::open(src).ok()?)).ok()?;
    let out = tmp.join("TwinDesk-marked.ipa");
    let mut zout = zip::ZipWriter::new(std::fs::File::create(&out).ok()?);
    let mut done = false;
    for i in 0..zin.len() {
        let name = zin.name_for_index(i)?.to_string();
        let parts: Vec<&str> = name.split('/').collect();
        if parts.len() == 3 && parts[0] == "Payload" && parts[1].ends_with(".app") && parts[2] == "Info.plist" {
            let mut raw = Vec::new();
            zin.by_index(i).ok()?.take(4 << 20).read_to_end(&mut raw).ok()?;
            let mut info: plist::Dictionary = plist::from_bytes(&raw).ok()?;
            info.insert(MARK_KEY.into(), plist::Value::String(MACHINE_NAME.into()));
            let mut buf = Vec::new();
            plist::to_writer_binary(&mut buf, &info).ok()?;
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).unix_permissions(0o644);
            zout.start_file(name, opts).ok()?;
            zout.write_all(&buf).ok()?;
            done = true;
        } else {
            zout.raw_copy_file(zin.by_index_raw(i).ok()?).ok()?;
        }
    }
    zout.finish().ok()?;
    done.then_some(out)
}

fn cert_view(c: &DevelopmentCertificate) -> Value {
    json!({
        "serial": c.serial_number,
        "name": c.name,
        "machine": c.machine_name,
        "expires": c.expiration_date.as_ref().map(secs),
        "ours": c.machine_name.as_deref() == Some(MACHINE_NAME),
    })
}

async fn install_op(req: Request, lines: Lines, tmp: &Path) -> Result<Value, Report> {
    #[cfg(not(feature = "any-ipa"))]
    if req.ipa.is_some() {
        bail!("This build only installs TwinDesk");
    }
    if req.udid.is_empty() {
        bail!("A device is needed");
    }
    let (io, secret) = if req.sealed {
        let (sealed, secret) = handshake(&lines).await?;
        (Io { lines, seal: Some(Arc::new(std::sync::Mutex::new(sealed))) }, secret)
    } else {
        (Io { lines, seal: None }, Secret { email: req.email, password: req.password, state: req.state })
    };
    let mem = Mem(Arc::new(std::sync::Mutex::new(secret.state.unwrap_or_default())));
    let password = secret.password.map(Zeroizing::new);
    let email = Some(secret.email.trim().to_string()).filter(|e| !e.is_empty()).or_else(|| mem.get(KEY_EMAIL)).unwrap_or_default();
    let source = match req.ipa {
        Some(p) => Source::Ipa(PathBuf::from(p)),
        None if req.no_ipa => Source::Nothing,
        None => Source::TwinDesk { cached: req.twindesk_ipa.map(PathBuf::from), save: req.save_ipa.map(PathBuf::from) },
    };
    let result = sign_and_install(&io, &mem, &email, password, &req.udid, source, if req.new_cert { None } else { req.profile_only }, req.new_cert, req.anisette, tmp).await;
    // Whatever happened: a certificate made, or an identity Apple now knows, has to be kept.
    let state = mem.map().clone();
    if !state.is_empty() {
        io.state(&state)?;
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn sign_and_install(
    io: &Io,
    mem: &Mem,
    email: &str,
    password: Option<Zeroizing<String>>,
    udid: &str,
    source: Source,
    profile_only: Option<String>,
    new_cert: bool,
    anisette: Option<String>,
    tmp: &Path,
) -> Result<Value, Report> {
    // Signed in before: the session kept in the state, for as long as Apple takes it. Else the password.
    let password = password.filter(|p| !p.is_empty());
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let kept = match (mem.get(KEY_TOKEN), mem.get(KEY_ADSID), mem.get(KEY_TOKEN_EXPIRY).and_then(|e| e.parse::<u64>().ok())) {
        (Some(token), Some(adsid), Some(expiry)) if password.is_none() && expiry > now_ms + 86_400_000 => {
            let duration = mem.get(KEY_TOKEN_DURATION).and_then(|d| d.parse().ok()).unwrap_or(0);
            Some((AppToken { token, duration, expiry }, adsid))
        }
        _ => None,
    };
    if email.is_empty() || (password.is_none() && kept.is_none()) {
        return Ok(json!({"ev": "error", "kind": "password", "message": "Sign in with the Apple ID and its password"}));
    }

    let device = provider(udid).await?;
    let info = IdeviceInfo::from_device(&device).await.context("Couldn't talk to the device: unlock it and tap Trust")?;


    // The anisette identity belongs to the server it was made with: another server, another identity.
    let https = |u: &String| u.starts_with("https://");
    let url = match (anisette.filter(https), mem.get(KEY_ANISETTE_URL).filter(https)) {
        (Some(want), Some(have)) if want != have => {
            mem.delete(KEY_ANISETTE_STATE)?;
            want
        }
        (Some(want), _) => want,
        (None, Some(have)) => have,
        (None, None) => DEFAULT_ANISETTE_V3_URL.to_string(),
    };
    mem.store(KEY_ANISETTE_URL, &url)?;

    let anisette = RemoteV3AnisetteProvider::new(&url, Box::new(mem.clone()), "0".to_string())?;
    let with_session = kept.is_some();
    let session = if let Some((token, adsid)) = kept {
        emit(json!({"ev": "step", "step": "session"}));
        let account = AppleAccount::builder(email).anisette_provider(anisette).err_429_retries(Some(2)).build().await?;
        DeveloperSession::new(token, adsid, account.grandslam_client.clone(), account.anisette_generator.clone())
    } else {
        let password = password.unwrap_or_default();
        emit(json!({"ev": "step", "step": "signin"}));
        let io2 = io.clone();
        let two_factor = move |p: TwoFactorCallbackParams| {
            let io = io2.clone();
            async move {
                emit(json!({
                    "ev": "need2fa", "sms": p.sms, "unknown": p.unknown, "error": p.last_error,
                    "selected": p.selected_number_id,
                    "numbers": p.numbers.iter().map(|n| json!({"id": n.id, "number": n.number_with_dial_code})).collect::<Vec<_>>(),
                }));
                let Some(a) = io.ask().await else { return Ok(TwoFactorCallbackResponse::Abort) };
                if let Some(code) = a.get("code").and_then(|v| v.as_str()) {
                    let code: String = code.chars().filter(|c| c.is_ascii_digit()).take(8).collect();
                    return Ok(TwoFactorCallbackResponse::SubmitCode(code));
                }
                if let Some(id) = a.get("sms").and_then(|v| v.as_u64()) {
                    return Ok(TwoFactorCallbackResponse::SendSms(id as u32));
                }
                if a.get("devices").and_then(|v| v.as_bool()) == Some(true) {
                    return Ok(TwoFactorCallbackResponse::SendToDevices);
                }
                if a.get("resend").and_then(|v| v.as_bool()) == Some(true) {
                    return Ok(TwoFactorCallbackResponse::ResendCode);
                }
                Ok(TwoFactorCallbackResponse::Abort)
            }
        };
        // Apple's sign-in is tried once: a refusal is shown, never retried on its own (retries are
        // what gets an account locked). Only "too many requests" is waited out, twice at most.
        let mut account = AppleAccount::builder(email)
            .anisette_provider(anisette)
            .err_429_retries(Some(2))
            .login(&password, two_factor)
            .await
            .context("Apple didn't accept the sign-in")?;
        drop(password);

        // The password's work is done. What is kept from here on is the developer session.
        let token = account.get_app_token("xcode.auth").await.context("Apple didn't open a developer session")?;
        let adsid = account
            .spd
            .as_ref()
            .and_then(|d| d.get("adsid"))
            .and_then(|v| v.as_string())
            .ok_or_else(|| report!("Apple's sign-in answer is missing the account's id"))?
            .to_string();
        mem.store(KEY_EMAIL, email)?;
        mem.store(KEY_ADSID, &adsid)?;
        mem.store(KEY_TOKEN, &token.token)?;
        mem.store(KEY_TOKEN_EXPIRY, &token.expiry.to_string())?;
        mem.store(KEY_TOKEN_DURATION, &token.duration.to_string())?;
        emit(json!({"ev": "step", "step": "signedin", "sessionUntil": token.expiry}));
        DeveloperSession::new(token, adsid, account.grandslam_client.clone(), account.anisette_generator.clone())
    };

    // No free certificate: the person picks one to revoke, never this on its own. Another tool's
    // (AltStore's, Sideloadly's, Xcode's) stops the apps it signed: the app warns before sending that.
    let io3 = io.clone();
    let declined = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let declined2 = declined.clone();
    let pick_certs = move |certs: Vec<DevelopmentCertificate>| {
        let io = io3.clone();
        let declined = declined2.clone();
        async move {
            emit(json!({"ev": "needcert", "certs": certs.iter().map(cert_view).collect::<Vec<_>>()}));
            let chosen: Vec<String> = match io.ask().await {
                // Only serials that were offered.
                Some(a) => a.get("revoke").and_then(|v| v.as_array()).map(|list| {
                    list.iter()
                        .filter_map(|v| v.as_str())
                        .filter(|s| certs.iter().any(|c| c.serial_number.as_deref() == Some(*s)))
                        .map(str::to_string)
                        .collect()
                }).unwrap_or_default(),
                None => Vec::new(),
            };
            if chosen.is_empty() {
                declined.store(true, std::sync::atomic::Ordering::Relaxed);
                return Ok(None);
            }
            Ok(Some(chosen))
        }
    };

    let mut sideloader = SideloaderBuilder::<_, ExtensionsBehaviorCallbackBox>::new(session, email.to_string())
        .team_selection(TeamSelection::First)
        .max_certs_behavior(MaxCertsBehavior::Prompt(pick_certs))
        .storage(Box::new(mem.clone()))
        .machine_name(MACHINE_NAME.to_string())
        .build();

    let team = match sideloader.get_team().await {
        Ok(team) => team,
        // Apple no longer takes the kept session (the password changed, or it was ended there):
        // it goes, and the answer is to sign in again.
        Err(e) if with_session && e.iter_reports().any(|n| n.downcast_current_context::<SideloadError>().is_some_and(|c| matches!(c, SideloadError::DeveloperError(..) | SideloadError::AuthWithMessage(..)))) => {
            for k in [KEY_TOKEN, KEY_TOKEN_EXPIRY, KEY_TOKEN_DURATION] {
                mem.delete(k)?;
            }
            return Ok(json!({"ev": "error", "kind": "session", "message": "Apple ended the session: sign in again", "detail": fail(&e)["detail"]}));
        }
        Err(e) => return Err(e),
    };
    emit(json!({"ev": "step", "step": "register", "team": team.team_id, "teamName": team.name}));
    sideloader
        .get_dev_session()
        .ensure_device_registered(&team, &info.name, &info.udid, None)
        .await
        .context("Apple didn't register the device")?;

    // Start over: TwinDesk's certificates at Apple are revoked and the key kept for them is dropped,
    // so a new certificate is made below (apps signed with the old one need signing again).
    if new_cert {
        emit(json!({"ev": "step", "step": "revoke"}));
        let dev = sideloader.get_dev_session();
        let certs = dev.list_all_development_certs(&team, None).await.context("Apple didn't list the certificates")?;
        for c in certs.iter().filter(|c| c.machine_name.as_deref() == Some(MACHINE_NAME)) {
            if let Some(serial) = &c.serial_number {
                dev.revoke_development_cert(&team, serial, None).await.context("Apple didn't revoke the certificate")?;
            }
        }
        let hash = hex::encode(ring::digest::digest(&ring::digest::SHA256, email.as_bytes()));
        mem.delete(&format!("{hash}/key"))?;
    }

    // A refresh: new profiles only, when they can be (the app keeps running as it is).
    let mut why = "";
    if let Some(bundle) = profile_only.filter(|b| !b.is_empty()) {
        match profiles_only(&device, sideloader.get_dev_session(), &team, &info.udid, &bundle).await {
            Ok(Ok(expires)) => {
                return Ok(json!({"ev": "done", "bundleId": bundle, "expires": expires, "team": team.team_id, "device": info.name, "profileOnly": true}));
            }
            Ok(Err(reason)) => why = reason,
            Err(e) => {
                why = "Installing the new profiles didn’t work.";
                emit(json!({"ev": "note", "message": why, "detail": fail(&e)["detail"]}));
            }
        }
    }

    let twindesk = match &source {
        Source::TwinDesk { .. } => true,
        Source::Ipa(p) => is_twindesk(p),
        Source::Nothing => false,
    };
    let ipa: PathBuf = match source {
        Source::Ipa(path) => path,
        // A refresh of an app whose IPA isn't kept: its profiles were all there was to do.
        Source::Nothing => {
            return Ok(json!({"ev": "error", "kind": "needipa", "message": "This app has to be signed again, and its IPA isn’t stored on this computer",
                "detail": format!("{why} Install it again from its IPA.").trim().to_string()}));
        }
        Source::TwinDesk { cached: Some(path), .. } if is_twindesk(&path) => {
            emit(json!({"ev": "step", "step": "cached"}));
            path
        }
        Source::TwinDesk { cached, save } => {
            if cached.is_some() {
                emit(json!({"ev": "note", "message": "The stored TwinDesk IPA isn't TwinDesk: downloading the release"}));
            }
            emit(json!({"ev": "step", "step": "download"}));
            let to = tmp.join("TwinDesk.ipa");
            download(&to).await.context("Couldn't download TwinDesk for iPhone")?;
            if let Some(save) = save {
                // Kept for the next refresh; a failed copy only means downloading again then.
                let part = save.with_extension("part");
                if save.parent().is_some_and(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::copy(&to, &part).is_ok() {
                    let _ = std::fs::rename(&part, &save);
                }
            }
            to
        }
    };

    let ipa = if twindesk { marked(&ipa, tmp).unwrap_or(ipa) } else { ipa };

    // Signing is several of Apple's steps and then the signature itself: each is said as it starts,
    // so a slow one shows where it is (isideload calls back at 0.1, 0.15, 0.2, then 0.3 … 1).
    emit(json!({"ev": "step", "step": "cert"}));
    let said = std::sync::atomic::AtomicU32::new(0);
    let progress = |f: f32| {
        let (step, percent) = match f {
            f if f < 0.15 => ("appid", 0),
            f if f < 0.2 => ("profile", 0),
            f => ("sign", (((f - 0.3).max(0.0) / 0.7) * 100.0).round() as u32),
        };
        let key = match step { "appid" => 1000, "profile" => 2000, _ => 3000 + percent };
        if said.swap(key, std::sync::atomic::Ordering::Relaxed) != key {
            emit(json!({"ev": "progress", "step": step, "percent": percent}));
        }
        std::future::ready(())
    };
    let signed = sideloader
        .sign_app(ipa, Some(team.clone()), false, Some(progress), None, Some(&info.udid))
        .await;
    let (signed, _) = match signed {
        Err(_) if declined.load(std::sync::atomic::Ordering::Relaxed) => {
            return Ok(json!({"ev": "error", "kind": "certs", "message": "This Apple ID has no free certificate",
                "detail": "No certificate was revoked. Try again and revoke one, free one in the tool that made it, or use another Apple ID."}));
        }
        r => r?,
    };

    let profile = std::fs::read(signed.join("embedded.mobileprovision")).ok().and_then(|raw| profile_plist(&raw));
    let expires = profile.as_ref().and_then(|d| d.get("ExpirationDate")).and_then(|v| v.as_date()).map(|x| secs(&x)).unwrap_or(0);
    let bundle_id = profile
        .as_ref()
        .and_then(|d| d.get("Entitlements"))
        .and_then(|v| v.as_dictionary())
        .and_then(|e| e.get("application-identifier"))
        .and_then(|v| v.as_string())
        .and_then(|s| s.split_once('.').map(|(_, b)| b.to_string()))
        .unwrap_or_default();

    emit(json!({"ev": "step", "step": "install"}));
    let last = std::sync::atomic::AtomicU64::new(0);
    let installed = install::install_app(&device, &signed, |p| {
        if p >= last.load(std::sync::atomic::Ordering::Relaxed) + 5 {
            last.store(p, std::sync::atomic::Ordering::Relaxed);
            emit(json!({"ev": "progress", "step": "install", "percent": p}));
        }
    })
    .await;
    let _ = std::fs::remove_dir_all(&signed);
    installed.context("The device didn't install the app")?;

    Ok(json!({"ev": "done", "bundleId": bundle_id, "expires": expires, "team": team.team_id, "device": info.name}))
}

// The app IDs registered for this Apple ID, read with the developer session kept in the state (only
// that: no password, no question, nothing changed at Apple). The state comes back, as the anisette
// identity in it can change.
async fn appids_op(req: Request) -> Result<Value, Report> {
    let mem = Mem(Arc::new(std::sync::Mutex::new(req.state.unwrap_or_default())));
    let result = list_ids(&mem).await;
    let state = mem.map().clone();
    if !state.is_empty() {
        emit(json!({"ev": "state", "state": state}));
    }
    result
}

async fn list_ids(mem: &Mem) -> Result<Value, Report> {
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let (Some(email), Some(token), Some(adsid), Some(expiry)) =
        (mem.get(KEY_EMAIL), mem.get(KEY_TOKEN), mem.get(KEY_ADSID), mem.get(KEY_TOKEN_EXPIRY).and_then(|e| e.parse::<u64>().ok()))
    else {
        return Ok(json!({"ev": "error", "kind": "password", "message": "No developer session is stored"}));
    };
    if expiry <= now_ms {
        return Ok(json!({"ev": "error", "kind": "session", "message": "The developer session has expired: sign in again"}));
    }
    let duration = mem.get(KEY_TOKEN_DURATION).and_then(|d| d.parse().ok()).unwrap_or(0);
    let url = mem.get(KEY_ANISETTE_URL).filter(|u| u.starts_with("https://")).unwrap_or_else(|| DEFAULT_ANISETTE_V3_URL.to_string());
    let anisette = RemoteV3AnisetteProvider::new(&url, Box::new(mem.clone()), "0".to_string())?;
    let account = AppleAccount::builder(&email).anisette_provider(anisette).err_429_retries(Some(2)).build().await?;
    let mut session = DeveloperSession::new(AppToken { token, duration, expiry }, adsid, account.grandslam_client.clone(), account.anisette_generator.clone());
    let teams = session.list_teams().await.context("Apple didn't list the developer teams")?;
    let Some(team) = teams.into_iter().next() else { bail!("This Apple ID has no developer team") };
    let list = session.list_app_ids(&team, None).await.context("Apple didn't list the app IDs")?;
    Ok(json!({
        "ev": "appids",
        "team": team.team_id,
        "teamName": team.name,
        "max": list.max_quantity,
        "available": list.available_quantity,
        "ids": list.app_ids.iter().map(|a| json!({
            "id": a.identifier,
            "name": a.name,
            "expires": a.expiration_date.as_ref().map(secs),
        })).collect::<Vec<_>>(),
    }))
}

async fn run(tmp: &Path) -> Result<Value, Report> {
    let (tx, rx) = mpsc::channel::<String>(4);
    tokio::spawn(async move {
        let mut reader = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line.len() > MAX_LINE || tx.send(line).await.is_err() {
                break;
            }
        }
    });
    let lines: Lines = Arc::new(Mutex::new(rx));
    let first = Zeroizing::new(lines.lock().await.recv().await.ok_or_else(|| report!("No request"))?);
    let req: Request = serde_json::from_str(&first).map_err(|_| report!("Bad request"))?;
    drop(first);

    match req.op.as_str() {
        "info" => Ok(json!({
            "ev": "info",
            "version": env!("CARGO_PKG_VERSION"),
            "anyIpa": cfg!(feature = "any-ipa"),
            "anisette": DEFAULT_ANISETTE_V3_URL,
        })),
        "devices" => devices().await,
        "apps" => apps(&req.udid).await,
        "install" => install_op(req, lines, tmp).await,
        "appids" => appids_op(req).await,
        _ => Err(report!("Unknown request")),
    }
}

// A directory of this run's own (0700) for the download and the app being signed, in place of the
// shared temporary directory, where another user could have put a link in the way.
fn private_tmp() -> std::io::Result<PathBuf> {
    let mut name = [0u8; 12];
    SystemRandom::new().fill(&mut name).map_err(|_| std::io::Error::other("no random"))?;
    let dir = std::env::temp_dir().join(format!("twindesk-signer-{}", hex::encode(name)));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir(&dir)?;
    Ok(dir)
}

fn main() {
    // Before any thread: nothing sensitive in an error's text, and this run's own temporary directory.
    let tmp = private_tmp().ok();
    unsafe {
        std::env::remove_var("DEBUG_SENSITIVE");
        if let Some(t) = &tmp {
            for k in ["TMPDIR", "TMP", "TEMP"] {
                std::env::set_var(k, t);
            }
        }
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _ = isideload::init();
    if std::env::args().any(|a| a == "--log") {
        let _ = tracing::subscriber::set_global_default(
            tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_writer(std::io::stderr).finish(),
        );
    }

    let code = match &tmp {
        None => {
            emit(json!({"ev": "error", "kind": "other", "message": "No temporary directory"}));
            1
        }
        Some(t) => {
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("runtime");
            let result = rt.block_on(run(t));
            rt.shutdown_background();
            match result {
                Ok(v) => {
                    let failed = v.get("ev").and_then(|e| e.as_str()) == Some("error");
                    emit(v);
                    failed as i32
                }
                Err(e) => {
                    emit(fail(&e));
                    1
                }
            }
        }
    };
    if let Some(t) = &tmp {
        let _ = std::fs::remove_dir_all(t);
    }
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    // An IPA of TwinDesk gets the mark in its main app's Info.plist; every other entry is copied as it is.
    #[test]
    fn marks_twindesk() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("td-mark-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.ipa");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&src).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        let mut d = plist::Dictionary::new();
        d.insert("CFBundleIdentifier".into(), plist::Value::String("com.twindesk.ios".into()));
        let mut b = Vec::new();
        plist::to_writer_xml(&mut b, &d).unwrap();
        z.start_file("Payload/TwinDesk.app/Info.plist", o).unwrap();
        z.write_all(&b).unwrap();
        z.start_file("Payload/TwinDesk.app/TwinDesk", o).unwrap();
        z.write_all(b"bin").unwrap();
        z.finish().unwrap();
        let out = super::marked(&src, &dir).unwrap();
        assert!(super::is_twindesk(&out));
        let mut zin = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut zin.by_name("Payload/TwinDesk.app/Info.plist").unwrap(), &mut raw).unwrap();
        let info: plist::Dictionary = plist::from_bytes(&raw).unwrap();
        assert_eq!(info.get(super::MARK_KEY).and_then(|v| v.as_string()), Some(super::MACHINE_NAME));
        assert_eq!(zin.len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    // TWINDESK_TEST_IPA=path/to/TwinDesk.ipa cargo test: that one is TwinDesk, nothing else is.
    #[test]
    fn twindesk_ipa() {
        if let Ok(p) = std::env::var("TWINDESK_TEST_IPA") {
            assert!(super::is_twindesk(std::path::Path::new(&p)));
        }
        assert!(!super::is_twindesk(std::path::Path::new("Cargo.toml")));
    }
}
