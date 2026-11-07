# AirPlay receiver

Receive AirPlay screen mirroring (picture and sound) from an iPhone, iPad or Mac on a PC or Linux
computer: AirPlay & SMB › Receive AirPlay. The Mac has Apple's own receiver.

**This is UxPlay's work.** The protocol, the handshakes and the choices here come from
[UxPlay](https://github.com/FDH2/UxPlay) (GPL-3.0; F. Duncanh and contributors, after antimof's
original), followed closely and rewritten in JavaScript, and from the projects UxPlay grew from:
[RPiPlay](https://github.com/FD-/RPiPlay) (Florian Draschbacher),
[AirplayServer](https://github.com/dsafa22/AirplayServer) (dsafa22),
[shairplay](https://github.com/juhovh/shairplay) (Juho Vähä-Herttua) and
[playfair](https://github.com/EstebanKubata/playfair) (EstebanKubata). `playfair/` is UxPlay's
`lib/playfair`, unchanged. See THIRD_PARTY_NOTICES for which file adapts which part.

| File | What | From UxPlay |
| --- | --- | --- |
| `receiver.js` | RTSP control, SETUP, stream keys, mirror (H.264) and audio (AAC-ELD) streams, timing | `lib/raop*.c`, `mirror_buffer.c` |
| `pairing.js` | legacy pair-setup / pair-verify (Ed25519, X25519) | `lib/pairing.c` |
| `fairplay.js`, `fp-replies.js`, `playfair.wasm` | FairPlay setup and the key unwrap | `lib/fairplay_playfair.c`, `lib/playfair` |
| `advertise.js` | `_airplay._tcp` / `_raop._tcp` over mDNS | `lib/dnssd.c` |
| `bplist.js` | binary property lists | (libplist's job in UxPlay) |
| `viewer.js`, `viewer-renderer.js`, `viewer.html` | the window: WebCodecs H.264 and AAC-ELD | |

Test: `node shared/test/airplay.js` (a sender's side over loopback). Rebuild the wasm:
`playfair/build.sh`.

AirPlay, Apple TV, iPhone, iPad and Mac are trademarks of Apple Inc. TwinDesk is not affiliated
with or endorsed by Apple.
