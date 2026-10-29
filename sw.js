// ScrubUp offline support.
// The app opens from the phone's saved copy first (works with no data), then quietly
// fetches a fresh copy in the background when there is a connection.
// Change VERSION whenever you upload new files, so phones pick up the update.
const VERSION = "scrubup-v6";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/content.json", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).pathname.startsWith("/api/")) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const saved = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r && (r.ok || r.type === "opaque")) cache.put(e.request, r.clone()); return r; }).catch(() => saved);
    return saved || fresh;
  }));
});
