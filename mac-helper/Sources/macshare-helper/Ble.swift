// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Bluetooth LE for when the other device isn't on this Mac's network: this Mac (the host) is a
// GATT peripheral that advertises the TwinDesk service. A guest (the phone, a PC) connects, reads
// INFO (this Mac's beacon), says who it is on CTRL, and opens a byte pipe: it writes UP, we notify
// DOWN. main pipes that to the session server on 127.0.0.1 (shared/blepipe.js), so the session runs
// through Bluetooth exactly as over the network: the same TLS, pinned certificate and token.
//
// Commands: bleStart {info}, bleStop, bleSend {dev, data (base64)}, bleCtrl {dev, msg (JSON text)}.
// Events: ble.state {state: on|off|unauthorized|unsupported}, ble.guest {dev, hello}, ble.open {dev},
//         ble.data {dev, data}, ble.close {dev} (its pipe closed), ble.gone {dev} (it went away),
//         ble.sent {dev, bytes}.
import CoreBluetooth
import Foundation

final class BlePeripheral: NSObject, CBPeripheralManagerDelegate {
  static let shared = BlePeripheral()

  static let serviceId = CBUUID(string: "B7F30001-2C4E-4D1A-9A57-3E8C2F6D0A91")
  static let infoId = CBUUID(string: "B7F30002-2C4E-4D1A-9A57-3E8C2F6D0A91")
  static let ctrlId = CBUUID(string: "B7F30003-2C4E-4D1A-9A57-3E8C2F6D0A91")
  static let upId = CBUUID(string: "B7F30004-2C4E-4D1A-9A57-3E8C2F6D0A91")
  static let downId = CBUUID(string: "B7F30005-2C4E-4D1A-9A57-3E8C2F6D0A91")

  private let queue = DispatchQueue(label: "macshare.ble")
  private var pm: CBPeripheralManager?
  private var wanted = false
  private var info = Data()
  private var ctrl: CBMutableCharacteristic?
  private var down: CBMutableCharacteristic?
  private var centrals = [UUID: CBCentral]()
  // Per central, in order: what's waiting to go out (ctrl or down, so a ctrl after data stays after it).
  private var out = [UUID: [(CBMutableCharacteristic, Data)]]()
  private var sentBytes = [UUID: Int]()
  private var lastState = ""

  func start(info: Data) {
    queue.async {
      self.info = info
      self.wanted = true
      if self.pm == nil {
        self.pm = CBPeripheralManager(delegate: self, queue: self.queue)
      } else {
        self.publish()
      }
    }
  }

  func stop() {
    queue.async {
      self.wanted = false
      self.pm?.stopAdvertising()
      self.pm?.removeAllServices()
      self.out.removeAll()
      for dev in self.centrals.keys { emit(["event": "ble.gone", "dev": dev.uuidString]) }
      self.centrals.removeAll()
    }
  }

  func send(dev: String, data: Data) {
    queue.async { self.enqueue(dev: dev, chr: self.down, data: data) }
  }

  func ctrl(dev: String, text: String) {
    queue.async { self.enqueue(dev: dev, chr: self.ctrl, data: Data(text.utf8)) }
  }

  // MARK: - internals (on `queue`)

  private func publish() {
    guard let pm = pm, pm.state == .poweredOn, wanted else { return }
    pm.stopAdvertising()
    pm.removeAllServices()
    let infoChr = CBMutableCharacteristic(type: Self.infoId, properties: [.read], value: info, permissions: [.readable])
    let ctrlChr = CBMutableCharacteristic(type: Self.ctrlId, properties: [.write, .notify], value: nil, permissions: [.writeable])
    let upChr = CBMutableCharacteristic(type: Self.upId, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
    let downChr = CBMutableCharacteristic(type: Self.downId, properties: [.notify], value: nil, permissions: [.readable])
    let svc = CBMutableService(type: Self.serviceId, primary: true)
    svc.characteristics = [infoChr, ctrlChr, upChr, downChr]
    ctrl = ctrlChr
    down = downChr
    pm.add(svc)
  }

  private func setState(_ s: String) {
    if s == lastState { return }
    lastState = s
    emit(["event": "ble.state", "state": s])
  }

  func peripheralManagerDidUpdateState(_ p: CBPeripheralManager) {
    switch p.state {
    case .poweredOn:
      setState("on")
      publish()
    case .unauthorized: setState("unauthorized")
    case .unsupported: setState("unsupported")
    default:
      setState("off")
      out.removeAll()
      for dev in centrals.keys { emit(["event": "ble.gone", "dev": dev.uuidString]) }
      centrals.removeAll()
    }
  }

  func peripheralManager(_ p: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error = error { return log("ble: add service: \(error.localizedDescription)") }
    p.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [Self.serviceId], CBAdvertisementDataLocalNameKey: "TwinDesk"])
  }

  func peripheralManagerDidStartAdvertising(_ p: CBPeripheralManager, error: Error?) {
    if let error = error { log("ble: advertise: \(error.localizedDescription)") }
  }

  func peripheralManager(_ p: CBPeripheralManager, central: CBCentral, didSubscribeTo chr: CBCharacteristic) {
    centrals[central.identifier] = central
  }

  // The central went away (or stopped listening): its pipe is over. CoreBluetooth has no
  // disconnect callback for a peripheral; DOWN's unsubscribe is the sign.
  func peripheralManager(_ p: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom chr: CBCharacteristic) {
    guard chr.uuid == Self.downId else { return }
    centrals.removeValue(forKey: central.identifier)
    out.removeValue(forKey: central.identifier)
    emit(["event": "ble.gone", "dev": central.identifier.uuidString])
  }

  func peripheralManager(_ p: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    var answer: CBATTRequest?
    for r in requests {
      let dev = r.central.identifier
      centrals[dev] = r.central
      let value = r.value ?? Data()
      if answer == nil { answer = r } // one answer covers every request in the batch (UP and CTRL are written with response)
      if r.characteristic.uuid == Self.upId {
        if !value.isEmpty { emit(["event": "ble.data", "dev": dev.uuidString, "data": value.base64EncodedString()]) }
      } else if r.characteristic.uuid == Self.ctrlId {
        guard let o = (try? JSONSerialization.jsonObject(with: value)) as? [String: Any], let op = o["op"] as? String else { continue }
        switch op {
        case "hello": emit(["event": "ble.guest", "dev": dev.uuidString, "hello": o])
        case "open":
          out.removeValue(forKey: dev) // a new pipe: nothing from the old one goes out
          emit(["event": "ble.open", "dev": dev.uuidString])
        case "close": emit(["event": "ble.close", "dev": dev.uuidString])
        default: break
        }
      }
    }
    if let a = answer { p.respond(to: a, withResult: .success) }
  }

  func peripheralManagerIsReady(toUpdateSubscribers p: CBPeripheralManager) {
    for dev in Array(out.keys) { pump(dev) }
  }

  private func enqueue(dev: String, chr: CBMutableCharacteristic?, data: Data) {
    guard let chr = chr, let id = UUID(uuidString: dev), let c = centrals[id] else { return }
    let max = Swift.max(20, c.maximumUpdateValueLength)
    var q = out[id] ?? []
    var i = 0
    while i < data.count {
      let n = Swift.min(max, data.count - i)
      q.append((chr, data.subdata(in: i..<(i + n))))
      i += n
    }
    out[id] = q
    pump(id)
  }

  private func pump(_ id: UUID) {
    guard let pm = pm, let c = centrals[id], var q = out[id] else { return }
    var bytes = 0
    while let (chr, chunk) = q.first {
      if !pm.updateValue(chunk, for: chr, onSubscribedCentrals: [c]) { break } // full: peripheralManagerIsReady
      q.removeFirst()
      if chr === down { bytes += chunk.count }
    }
    out[id] = q.isEmpty ? nil : q
    if bytes > 0 { emit(["event": "ble.sent", "dev": id.uuidString, "bytes": bytes]) }
  }
}
