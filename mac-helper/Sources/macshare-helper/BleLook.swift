// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Bluetooth LE, the other way round from Ble.swift: this Mac looks for PCs that advertise the
// TwinDesk service, so one that isn't on this network (and not paired yet) shows in its list, and
// asks one to connect (an invite, like the network's). The PC then connects to us (Ble.swift).
//
// Commands: bleLook {on}, bleInvite {dev, msg (JSON text)}.
// Events: ble.seen {dev, info (its INFO JSON text)}.
import CoreBluetooth
import Foundation

final class BleLook: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  static let shared = BleLook()

  private let queue = DispatchQueue(label: "macshare.blelook")
  private var cm: CBCentralManager?
  private var wanted = false
  private var known = [UUID: CBPeripheral]()
  private var infos = [UUID: String]()
  private var told = [UUID: Date]()
  private var reading = [UUID: Date]() // connecting to read INFO (or tried lately)
  private var invites = [UUID: Data]() // CTRL write waiting for the connection

  func look(_ on: Bool) {
    queue.async {
      self.wanted = on
      if on && self.cm == nil { self.cm = CBCentralManager(delegate: self, queue: self.queue) }
      self.apply()
    }
  }

  func invite(dev: String, text: String) {
    queue.async {
      guard let id = UUID(uuidString: dev), let cm = self.cm,
            let p = self.known[id] ?? cm.retrievePeripherals(withIdentifiers: [id]).first else { return }
      self.known[id] = p
      self.invites[id] = Data(text.utf8)
      p.delegate = self
      if p.state == .connected { p.discoverServices([BlePeripheral.serviceId]) } else { cm.connect(p) }
    }
  }

  private func apply() {
    guard let cm = cm, cm.state == .poweredOn else { return }
    if wanted { cm.scanForPeripherals(withServices: [BlePeripheral.serviceId], options: nil) } else { cm.stopScan() }
  }

  func centralManagerDidUpdateState(_ c: CBCentralManager) {
    apply()
  }

  func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
    let id = p.identifier
    known[id] = p
    if let info = infos[id] {
      if let last = told[id], Date().timeIntervalSince(last) < 3 { return }
      told[id] = Date()
      emit(["event": "ble.seen", "dev": id.uuidString, "info": info])
      return
    }
    if let started = reading[id], Date().timeIntervalSince(started) < 15 { return }
    reading[id] = Date()
    p.delegate = self
    c.connect(p)
  }

  func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
    p.discoverServices([BlePeripheral.serviceId])
  }

  func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
    invites.removeValue(forKey: p.identifier)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    guard let svc = p.services?.first(where: { $0.uuid == BlePeripheral.serviceId }) else { return done(p) }
    p.discoverCharacteristics([BlePeripheral.infoId, BlePeripheral.ctrlId], for: svc)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor svc: CBService, error: Error?) {
    let chrs = svc.characteristics ?? []
    if let text = invites.removeValue(forKey: p.identifier), let ctrl = chrs.first(where: { $0.uuid == BlePeripheral.ctrlId }) {
      p.writeValue(text, for: ctrl, type: .withResponse)
      return
    }
    guard infos[p.identifier] == nil, let info = chrs.first(where: { $0.uuid == BlePeripheral.infoId }) else { return done(p) }
    p.readValue(for: info)
  }

  func peripheral(_ p: CBPeripheral, didUpdateValueFor chr: CBCharacteristic, error: Error?) {
    if chr.uuid == BlePeripheral.infoId, error == nil, let v = chr.value, let text = String(data: v, encoding: .utf8) {
      infos[p.identifier] = text
      told[p.identifier] = Date()
      emit(["event": "ble.seen", "dev": p.identifier.uuidString, "info": text])
    }
    done(p)
  }

  func peripheral(_ p: CBPeripheral, didWriteValueFor chr: CBCharacteristic, error: Error?) {
    if let error = error { log("ble: invite: \(error.localizedDescription)") }
    done(p)
  }

  // Nothing more to do with it: let the connection go (the PC connects to us for the session).
  private func done(_ p: CBPeripheral) {
    if invites[p.identifier] != nil { return }
    cm?.cancelPeripheralConnection(p)
  }
}
