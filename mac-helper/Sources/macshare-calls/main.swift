// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The calls' sound on this Mac over Bluetooth: this Mac as the phone's hands-free (a headset, as
// a car is), through IOBluetooth, which plays the call through the Mac's speakers and microphone
// itself. A process of its own, run by mac/callaudio.js only while Calls and its Bluetooth option
// are on with a phone connected: TwinDesk's helper never loads IOBluetooth for it.
//
// JSON lines. In:  {"cmd": "info"} | {"cmd": "connect", "id"} | {"cmd": "disconnect"}
//                  | {"cmd": "here"} | {"cmd": "phone"} | {"cmd": "mute", "on"}
// Out: {"ev": "info", "address", "power", "devices": [{id, name}]}
//      {"ev": "state", "state": "connecting"|"connected"|"disconnected", "error"?}
//      {"ev": "sco", "open"}   {"ev": "ring", "number"}
// stdin closed (TwinDesk gone): the phone gets its calls back and this exits.
import Foundation
import IOBluetooth

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ o: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) else { return }
    print(s)
}

// "aa-bb-cc-dd-ee-ff" -> "AA:BB:CC:DD:EE:FF" (the phone's way of writing it).
func colons(_ a: String) -> String { a.replacingOccurrences(of: "-", with: ":").uppercased() }

final class Calls: NSObject, IOBluetoothHandsFreeDeviceDelegate {
    var hf: IOBluetoothHandsFreeDevice?
    let gateway = IOBluetoothSDPUUID(uuid16: 0x111F) // Hands-Free Audio Gateway: what a phone offers

    func info() {
        let host = IOBluetoothHostController.default()
        let paired = (IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice]) ?? []
        let phones = paired.filter { d in
            d.isHandsFreeAudioGateway || d.getServiceRecord(for: gateway) != nil || d.deviceClassMajor == UInt32(kBluetoothDeviceClassMajorPhone)
        }
        emit([
            "ev": "info",
            "address": colons(host?.addressAsString() ?? ""),
            "power": host?.powerState == kBluetoothHCIPowerStateON,
            "devices": phones.map { ["id": $0.addressString ?? "", "name": $0.name ?? $0.addressString ?? "Phone"] },
        ])
    }

    func connect(_ id: String) {
        guard let d = IOBluetoothDevice(addressString: id) else { return emit(["ev": "state", "state": "disconnected", "error": "not found"]) }
        if let h = hf, h.device?.addressString == d.addressString, h.isConnected { return emit(["ev": "state", "state": "connected"]) }
        hf?.disconnect()
        guard let h = IOBluetoothHandsFreeDevice(device: d, delegate: self) else { return emit(["ev": "state", "state": "disconnected", "error": "not a phone"]) }
        // Caller ID, the call's status and volume from the phone.
        h.supportedFeatures = IOBluetoothHandsFreeDeviceFeatures.cliPresentation.rawValue
            | IOBluetoothHandsFreeDeviceFeatures.enhancedCallStatus.rawValue
            | IOBluetoothHandsFreeDeviceFeatures.remoteVolumeControl.rawValue
            | IOBluetoothHandsFreeDeviceFeatures.ecAndOrNRFunction.rawValue
        hf = h
        emit(["ev": "state", "state": "connecting"])
        h.connect()
    }

    func disconnect() {
        hf?.disconnect()
        hf = nil
    }

    func handle(_ o: [String: Any]) {
        switch o["cmd"] as? String ?? "" {
        case "info": info()
        case "connect": connect(o["id"] as? String ?? "")
        case "disconnect": disconnect(); emit(["ev": "state", "state": "disconnected"])
        case "here": hf?.transferAudioToComputer()
        case "phone": hf?.transferAudioToPhone()
        case "mute": hf?.isInputMuted = (o["on"] as? Bool) ?? false
        default: break
        }
    }

    // ---- IOBluetoothHandsFreeDeviceDelegate ----

    func handsFree(_ device: IOBluetoothHandsFree!, connected status: NSNumber!) {
        let ok = (status?.int32Value ?? -1) == kIOReturnSuccess
        if !ok { hf = nil }
        emit(ok ? ["ev": "state", "state": "connected"] : ["ev": "state", "state": "disconnected", "error": String(format: "0x%x", status?.int32Value ?? -1)])
    }

    func handsFree(_ device: IOBluetoothHandsFree!, disconnected status: NSNumber!) {
        if device === hf { hf = nil }
        emit(["ev": "state", "state": "disconnected"])
    }

    func handsFree(_ device: IOBluetoothHandsFree!, scoConnectionOpened status: NSNumber!) {
        emit(["ev": "sco", "open": (status?.int32Value ?? -1) == kIOReturnSuccess])
    }

    func handsFree(_ device: IOBluetoothHandsFree!, scoConnectionClosed status: NSNumber!) {
        emit(["ev": "sco", "open": false])
    }

    func handsFree(_ device: IOBluetoothHandsFreeDevice!, incomingCallFrom number: String!) {
        emit(["ev": "ring", "number": number ?? ""])
    }
}

let calls = Calls()
Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async { calls.handle(o) }
    }
    // TwinDesk is gone: let the phone go (its calls go back to it), then exit.
    DispatchQueue.main.async {
        calls.disconnect()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
    }
}
RunLoop.main.run()
