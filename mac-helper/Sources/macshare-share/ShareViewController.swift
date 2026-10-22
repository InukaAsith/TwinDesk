// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The "TwinDesk" entry in the macOS Share menu (Finder and any app that shares files).
// It shows no sheet: it collects the shared file URLs and hands them to TwinDesk as
// macshare://send?p=<path>&p=…, which sends them to the connected computer (Send files flow).
import AppKit

@objc(ShareViewController)
class ShareViewController: NSViewController {
    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        let group = DispatchGroup()
        var paths: [String] = []
        let lock = NSLock()
        for p in providers where p.hasItemConformingToTypeIdentifier("public.file-url") {
            group.enter()
            p.loadItem(forTypeIdentifier: "public.file-url", options: nil) { item, _ in
                var url: URL?
                if let d = item as? Data { url = URL(dataRepresentation: d, relativeTo: nil) }
                else if let u = item as? URL { url = u }
                if let u = url, u.isFileURL {
                    lock.lock(); paths.append(u.path); lock.unlock()
                }
                group.leave()
            }
        }
        group.notify(queue: .main) { [weak self] in
            if !paths.isEmpty {
                var c = URLComponents()
                c.scheme = "macshare"
                c.host = "send"
                c.queryItems = paths.prefix(1000).map { URLQueryItem(name: "p", value: $0) }
                if let u = c.url { NSWorkspace.shared.open(u) }
            }
            self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        }
    }
}
