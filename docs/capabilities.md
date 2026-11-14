# Capabilities: what a pair of devices can do

Two TwinDesk devices can differ in what they can do: a different version, a different kind of device
(a computer, an Android phone, an iPhone, a browser), a different OS, or a setting or permission that
one side doesn't have. This page lists every capability the apps tell each other today, where each
one is sent, and what it switches on.

**The rule:** a page, a switch or a button is offered only when both devices can do it. When one
side can't, the app says which side and what would enable it (update it, grant a permission, turn on
wireless debugging), instead of offering something that won't work.

This page goes with the wire protocol in [protocol.md](protocol.md). New capabilities are added here
in the same change that adds them to the code.

## Versions

| What | Where | Value now |
|---|---|---|
| Protocol version | `PROTOCOL_VERSION` in `shared/protocol.js`, sent as `v` in `hello`, `welcome` and beacons | `1` |
| App version | `app.v` in `dev.state` (`shared/appinfo.js`), and `app` in `phone.info` | the app's version, e.g. `3.1.0` |

The protocol version changes only for a change an older app can't ignore. Everything else is
added as a new field or a new message, which an app that doesn't know it ignores. So new features
are found by capability, not by comparing version numbers. The app version is for people:
Overview shows the other side's version, in red when it's older.

## Session capabilities (hello and welcome)

The device that dials sends `hello`, and the one that answers sends `welcome`. Each new
capability is a field in one or both. A missing field means "can't", so an older app gets the
old behaviour.

| Field | Sent in | Meaning | Falls back to |
|---|---|---|---|
| `fx: 1` / `fx: token` | hello / welcome | Fast files: file bytes over HTTPS on the session's port | `file.chunk` on the session |
| `fx2: 1` | hello and welcome | fx2: the file engine in its own process, parallel ranges | fx, then `file.chunk` |
| `fxPlain: 1` | hello and welcome | Unencrypted file bytes allowed on the local network (Files › Encrypt file transfers off on both) | encrypted fx2 |
| `il: {…}` | hello and welcome | tdv2: the encrypted UDP input lane, with its port | tdv1 (input on the session) |
| `rc: 1` | hello / welcome | A paired phone may return to its session without taking it over | plain hello (takes the session) |
| `resume: key` | welcome, then hello | The session may move to another path (Bluetooth to Wi-Fi, the cable) without ending | a new session |
| `tail: [addresses]` | welcome | This computer's Tailscale addresses, for reaching it away from home (#161) | local discovery only |
| `takeover: true` | hello | Take the session from the device that holds it | refused while busy |

## Features in dev.state

Each side lists the features that need TwinDesk on both sides in `dev.state` as `app.f`
(`shared/appinfo.js`). When the other side lacks one this side has, the app says so once per
session, naming the feature.

| Id | Feature |
|---|---|
| `lane` | Faster mouse and keyboard (tdv2) |
| `fastFiles` | Faster file transfers (fx2) |
| `h265` | H.265 screen sharing |
| `chats` | Chat apps in Messages |

A device that sends no `app` at all is older than 2.5, and the app can't tell which features it
lacks, so it shows only that it's older.

## Features that say hello on their own

Some features don't wait for hello and welcome. They send their own first message once switched on,
and start only when the other side answers.

| Message | Feature | An app without it |
|---|---|---|
| `drive.hello {v: 1}` | TwinDesk Drive ([drive.md](drive.md)), both sides switched on | ignores it, so Drive never starts |

## Phone capabilities

| Message | Field | Values | Used for |
|---|---|---|---|
| `phone.info` (phone to computer) | `caps` | `mirror.native`: the phone can share its own screen without wireless debugging | the Screen page offers mirroring in Limited mode |
| `peer.info` (phone to phone) | `caps` | `clip`, `notifs`, `files`, `screen`, `photos`, `sound`, and `messages` and `fs` only while that permission is granted | the pages a phone shows for the other phone |

A phone that sends no `caps` is older. For phone to phone, an older Android phone is taken to have
all of them, and an older iPhone has no `messages`, `fs` or `sound`.

## Link capabilities

| Message | Fields | Used for |
|---|---|---|
| `net.caps` | `host`, `join`, `hotspot`, `band5` | Which side can host a Wi-Fi Direct group or a hotspot, and whether it joins 5 GHz, when a Bluetooth session needs more bandwidth (`shared/netlink.js`) |
| `deck.layout` | `can`, `caps` | Which Deck actions this computer can run, so the phone's tile editor offers only those |

## Per-device pages

Pages are chosen by the kind of device in session (`shared/ui-kinds.js`): `computer`, `android` or
`ios`, plus TwinDesk Web's own pages. A page lists the kinds it's for: Calls, Messages and Mount are
`for: ['android']`, because iOS gives no app its calls or texts and Mount goes through adb. On top of that, each page can hide itself when its
feature can't run (a permission, the OS, wireless debugging).

## Two-way switches

`pair.sync` keeps the switches that belong to the pair (Clipboard, Notifications, Sound and the
rest, each way on its own) the same on both devices. A switch for a feature the other side can't do
should show dimmed with the reason, not as on (see What's still to do).

## Adding a capability

1. Add the field or the id to the right table here, with what it means and what it falls back to.
2. Send it from every app that has the feature: Mac, Windows and Linux (`shared/`), Android
   (Kotlin) and iPhone (Swift), and TwinDesk Web where it applies.
3. Gate the page, switch or button on both sides having it, and say what's missing when one doesn't.
4. Keep the old path working for an app that doesn't send it.
5. Add a test with an older peer (no field) and a newer one.

## What's still to do

The pieces above grew one feature at a time, so they're in several places. The next step is one
capability list per device, sent once in `welcome` and `hello` (`caps: [...]`), from which every page,
switch and button decides whether to show. The fields above stay for older apps.
