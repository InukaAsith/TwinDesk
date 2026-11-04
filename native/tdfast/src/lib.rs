// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// tdfast: the input lane (docs/protocol.md) for the helpers. The same wire as shared/inputlane.js,
// so a native peer and a JS peer always interoperate; a C ABI (tdfast.h) for Swift, C and C#.
pub mod ffi;
pub mod lane;
mod qos;
pub mod wire;
