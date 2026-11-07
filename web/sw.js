// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web's service worker (only on the secure page: browsers keep them off plain http).
//  - The page itself, kept: it opens at once (and says it's looking for the computer) when the
//    computer is off or on another network, instead of the browser's error page.
//  - Push (shared/web/webpush.js): the computer's alerts as notifications, and the app icon's badge,
//    with the page closed. A tap opens the page on what it's about.
//  - Android's share menu (the manifest's share_target): what's shared is held here and handed to the
//    page, which sends it to the computer (it has the device's token; this doesn't).
'use strict';

const SHELL = 'twindesk-shell-v1';
const FILES = ['/', '/app.css', '/app.js', '/icon.png', '/touch-icon.png', '/logo-light.png', '/logo-dark.png',
  '/td/viewer.html', '/td/viewer.js', '/td/viewer.css', '/td/remote.html', '/td/remote.js', '/td/remote.css', '/td-bridge.js', '/td-bridge.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(FILES.map((f) => c.add(f).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k.startsWith('twindesk-shell')) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The network first (the computer has the newest page); the copy here when it doesn't answer soon.
async function fresh(req) {
  const c = await caches.open(SHELL);
  // The page by its path ('/' whatever came after it); a frame's page (the viewer) by its own.
  const key = req.mode === 'navigate' && req.destination === 'document' ? '/' : new URL(req.url).pathname;
  try {
    const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 3500))]);
    if (res.ok && res.type === 'basic') c.put(key, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await c.match(key, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

let shared = null; // {title, text, url, files} from Android's share menu, until the page takes it
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (e.request.method === 'POST' && u.pathname === '/share-target') {
    e.respondWith((async () => {
      const f = await e.request.formData();
      shared = { title: f.get('title') || '', text: f.get('text') || '', url: f.get('url') || '', files: f.getAll('files').filter((x) => x && x.size), at: Date.now() };
      return Response.redirect('/?shared=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/') || u.pathname === '/ws' || u.pathname === '/sw.js') return;
  if (e.request.mode === 'navigate' || FILES.includes(u.pathname)) e.respondWith(fresh(e.request));
});

self.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.t === 'take-shared') {
    const s = shared && Date.now() - shared.at < 10 * 60000 ? shared : null;
    shared = null;
    e.source && e.source.postMessage({ t: 'shared', item: s });
  }
  if (m.t === 'badge') setBadge(m.n);
});

function setBadge(n) {
  try {
    if (n > 0 && self.navigator.setAppBadge) self.navigator.setAppBadge(n);
    else if (self.navigator.clearAppBadge) self.navigator.clearAppBadge();
  } catch (_) {}
}

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (_) { m = { title: 'TwinDesk', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    // A page in front shows it itself (the computer only pushes when none is: this is a race).
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible') && m.kind !== 'test') return;
    if (typeof m.badge === 'number') setBadge(m.badge);
    await self.registration.showNotification(m.title || 'TwinDesk', {
      body: m.body || '', tag: m.tag || undefined, renotify: m.kind === 'clip', icon: '/icon.png', badge: '/icon.png',
      data: { go: m.go || '', kind: m.kind || '' }, timestamp: Date.now(),
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const go = (e.notification.data && e.notification.data.go) || '';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins[0];
    if (w) {
      w.postMessage({ t: 'go', go });
      return w.focus ? w.focus() : null;
    }
    return self.clients.openWindow(go ? `/?go=${encodeURIComponent(go)}` : '/');
  })());
});
