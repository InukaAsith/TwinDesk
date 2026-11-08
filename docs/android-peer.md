# Connect with Android: phone to phone

Two Android devices with TwinDesk, connected to each other. This runs beside the computer's session,
never in place of it: a phone can be connected to a computer and to another phone at the same time.

## What it does

- **Files**, both ways, into Download/TwinDesk. Use Send files on the Android page, or share from any
  app to TwinDesk while no computer is connected.
- **Clipboard** text, both ways.
- **Notifications**, both ways. Sending this phone's own notifications needs notification access
  (the full build).
- **The other phone's Messages, Photos and Files**: read and answer texts, look at photos and save
  them, browse its storage and save files. Each needs that phone's permission, and Allow asks it there.
- **Screen**: the other phone's screen, to look at only. There is no control. The other phone taps
  Start (Android's own prompt).

## Who hosts

The phone that taps Connect is the guest, and the other phone is the host.

- **Host for other phones** on: the phone runs its server (TLS, port 47806) all the time.
- Off: a phone near it sends `peer.ask` over discovery. A paired phone starts hosting at once. A new
  phone gets an Allow / Not now prompt, then hosting runs for two minutes or for as long as a session
  lasts.

Phones find each other through the existing discovery beacons. A phone's beacon now carries
`ap: 1`, plus `phost: <port>` while it hosts. Computers ignore both fields, and older phones ignore
other phones' beacons, so nothing changes for them.

## The session

- **Pairing and hello** are the computers' own protocol: numeric comparison with a 6-digit code on
  both phones, a token, and the certificate pinned. The guest uses a second `Link` instance with its
  own paired list (`peerHosts`). The host's key is ShareKey (Android Keystore).
- After the first session, the guest gives the host a token and certificate of its own (`peer.rev`).
  Either phone can then connect to the other later without pairing again.
- **Messages on the session:**
  - `clip`, `notif`
  - `f.offer` / `f.accept` / `f.done` / `f.cancel`
  - `q` → `r` requests, matched by `qid`
  - `screen.ready` / `screen.state` / `screen.stop`
- **Bytes travel outside the session**, as HTTPS to the host, checked with the session's key
  (`x-twindesk-peer`, sent in `peer.key`) and the session's address:
  - `PUT|GET /peer/f/<id>`: the guest PUTs what it sends and GETs what the host sends.
  - `POST|GET /peer/screen`: the guest POSTs its screen and GETs the host's. The packets are
    `ScreenStreamer`'s (scrcpy's 12-byte headers) with H.264. A new stream starts at a keyframe.

## Code

| File | Role |
|---|---|
| `Peer.kt` | Both roles, pairing as the host, the features |
| `PeerServer.kt` | TLS, WebSocket and HTTP/1.1 |
| `PeerScreen.kt` | Capture service, encoder, viewer |
| `PeerUi.kt` | The Android page, its dialogs, the other phone's Messages, Photos and Files |
