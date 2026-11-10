/* MORES RAB ROT service worker - makes the app installable as a desktop app.
   Deliberately caches NO data: every page and API call goes to the local
   server. Its one job: when the server is not running, a page load shows a
   "start MORES RAB ROT" screen instead of the browser's error. */
const CACHE = "rab-rot-shell-v1";
const OFFLINE = "/static/pwa/offline.html";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([OFFLINE])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.mode !== "navigate") return;            // everything else: straight to the server
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
