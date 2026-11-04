// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Windows: the lane's socket in a qWAVE voice flow (docs/protocol.md, DSCP). Windows ignores
// IP_TOS from programs, so this is what puts input in Wi-Fi's WMM voice queue there: qWAVE tags the
// flow's packets (802.1p, and DSCP where Windows allows it). A flow is per destination, so a new one
// when the peer moves. Best effort: no qWAVE (Server without it), or a refusal, and the lane is as before.
// Elsewhere IP_TOS in make_socket does it, and Flow is never made.

use std::net::{SocketAddr, UdpSocket};

#[cfg(windows)]
pub struct Flow {
    handle: windows_sys::Win32::Foundation::HANDLE,
    socket: usize,
    id: u32,
}

#[cfg(windows)]
unsafe impl Send for Flow {}

#[cfg(windows)]
impl Flow {
    pub fn add(sock: &UdpSocket, peer: SocketAddr) -> Option<Flow> {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::NetworkManagement::QoS::*;
        let version = QOS_VERSION { MajorVersion: 1, MinorVersion: 0 };
        let mut handle = std::ptr::null_mut();
        // SAFETY: plain qWAVE calls on our own socket; the address outlives the call.
        unsafe {
            if QOSCreateHandle(&version, &mut handle) == 0 {
                return None;
            }
            let socket = sock.as_raw_socket() as usize;
            let addr = socket2::SockAddr::from(peer);
            let mut id = 0u32;
            if QOSAddSocketToFlow(handle, socket, addr.as_ptr() as *const _, QOSTrafficTypeVoice, QOS_NON_ADAPTIVE_FLOW, &mut id) == 0 {
                QOSCloseHandle(handle);
                return None;
            }
            Some(Flow { handle, socket, id })
        }
    }
}

#[cfg(windows)]
impl Drop for Flow {
    fn drop(&mut self) {
        use windows_sys::Win32::NetworkManagement::QoS::*;
        // SAFETY: the handle and flow are ours, removed once.
        unsafe {
            QOSRemoveSocketFromFlow(self.handle, self.socket, self.id, 0);
            QOSCloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
pub struct Flow;

#[cfg(not(windows))]
impl Flow {
    pub fn add(_sock: &UdpSocket, _peer: SocketAddr) -> Option<Flow> {
        None
    }
}
