/*
 * ParcelClarity service worker: deliberately minimal.
 *  - Makes the app installable and shows a friendly page when offline.
 *  - NEVER caches pages, API responses or uploads: rate cards, order files and forecasts are
 *    confidential business data and must not persist on shared or lost devices.
 */
const OFFLINE_CACHE = "pc-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.add(OFFLINE_URL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
