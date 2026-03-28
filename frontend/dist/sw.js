// Minimal service worker — satisfies Chrome's PWA installability requirement.
// Pass-through fetch handler; no caching to keep alerts always fresh.

const CACHE_VERSION = 'lwa-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  // Remove old caches
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  // Always go to network — weather data must be live
  event.respondWith(fetch(event.request))
})
