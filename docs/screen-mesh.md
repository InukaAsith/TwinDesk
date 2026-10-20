# Screen sharing in the mesh

Status: design, slices (a) to (e). Builds on `docs/mesh.md` (selected device, pooled features,
shared layout in `shared/layout.js`). Protocol v1 stays; everything here is additive.

## Problem

Screen sharing is one-to-one today and follows the selected device: the Share screen page shows one
display of this computer to one peer, and a Mac or Windows PC extends through the one virtual display
(`windows/vdd.js`). With several devices connected at once, each device may want a different picture:
the Mac gets display 2, the phone gets a new virtual display, a tablet gets nothing.

## Goals

1. **Who gets which screen.** For each connected target device the page offers one choice: nothing, a
   real display of this computer (shown as a mirror of that display), a new virtual display (an
   extended desktop), or a mirror of the whole set. Several targets at once, each with its own WebRTC
   link. No global "the" screen-share state.
2. **Display model.** Every device reports its displays: `{ id, name, x, y, w, h, scale, primary }`
   in its own physical pixels, positions relative to the primary display's top-left (so negative x and
   y are normal). The page draws them as boxes arranged as the OS arranges them (like Windows display
   settings). A virtual display is placed left, right, above or below an existing box, aligned to an
   edge, and never overlaps another box.
3. **Compatibility.** A device that knows nothing about this keeps the one-to-one behaviour. New
   messages are new types; new fields are optional. Mac and Windows keep working with older peers.

## Model (shared/screen-mesh.js, pure, tested)

- **Display**: `{ id: string, name: string, x, y, w, h, scale, primary }`. Integers for `x, y, w, h`
  within ±32768 (a 3-monitor PC with one at x = -1920 is valid), `w, h` ≥ 16, at most 8 displays per
  device. `scale` a number in (0, 4]. Untrusted input is normalised, bad entries dropped.
- **Arrangement**: `arrange(displays, box)` maps the union bounding box into a view of `box` pixels
  (uniform scale, origin at the minimum x and y). Returns one rectangle per display for the page.
- **Placement of a new virtual display**: `place(displays, anchorId, side, size)` returns
  `{ x, y, w, h }` for the new display on `side` (left | right | top | bottom) of the anchor, aligned to
  the anchor's near edge (top edge for left/right, left edge for top/bottom) like the OS does by default.
  It returns null when the spot overlaps an existing display (the page then shows the error).
  `nudge` moves a display along its edge by an offset and is validated the same way.
- **Stream table** (per target): `{ [deviceId]: { mode, displayId?, size? } }` where `mode` is one of
  `none`, `mirror` (a real display, `displayId` required), `virtual` (new display, `size` = [w, h], at
  most `VIRTUAL_LIMIT` = 1 per computer for now: one virtual display adapter), and `all` (the mirror of the whole
  arrangement, no `displayId`). `setChoice(table, deviceId, choice, knownIds)` validates the choice
  against the displays this computer reports and against the set of connected devices.
  `streams(table, knownIds)` returns the active streams in deterministic order, dropping targets that
  are no longer connected. A target with no stream is not contacted at all.
- Which device owns which display on the *receiving* side is not decided here: the receiver shows the
  stream in its own window per source device (the existing viewer), keyed by the sender's device id.

## Wire additions (optional, additive)

- `hello`/`welcome` may carry `displays: [ ... ]` (this device's display model, same shape as above,
  max 8). A peer that sends none is a legacy peer: no display model, and it can only be a mirror
  target for the default display (today's behaviour).
- `screen.want { mode, displayId?, size? }` from the viewer to the sharer, per link: the viewer's
  choice for this link. Legacy sharers ignore unknown types.
- `screen.stream` / `screen.stop` as today, one WebRTC session per link, keyed by the device pair.
- Display changes are sent as `displays {displays}` when they change (plug, unplug, rotate).

## Slices

- (a) This document.
- (b) `shared/screen-mesh.js` + `shared/test/screen-mesh.js`: display normalisation, arrange, place,
  overlap, the stream table. Covers this PC with three monitors (0,0 2560×1440 primary, two at x = -1920).
- (c) Windows: the main process builds the display model from `screen.getAllDisplays()`, runs one
  capture per active stream (a mirror of a display or the virtual display), and `ui-share.js` shows the
  arrangement and a per-target choice. Tests: `windows/test/screen-mesh.test.js` with fakes.
- (d) Mac: `mac/displays.js` reports the same model and `mac/stream.js` honours `screen.want`.
- (e) Android: receiving side only (it shows a stream per source device); no display model needed.

## Out of scope for this change

More than one virtual display per computer (needs one adapter per display), the phone as a monitor,
editing the arrangement from the phone, drag-to-reposition of an existing display's real position
(the OS owns real displays; only virtual ones are placed by TwinDesk).
