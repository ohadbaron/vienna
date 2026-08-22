/* ------------------------------------------------------------------
 * Service worker — makes the app work with no signal.
 *
 * Practical reason: you'll be using this in alpine valleys and on
 * roaming data. Once loaded on wifi, everything (including the Tailwind
 * CDN script) is cached and the app opens offline.
 *
 * Strategy:
 *   local files (index/app/data) -> network first, cache fallback
 *                                   (so edits to data.js show up online)
 *   cross-origin (Tailwind CDN)  -> cache first (it never changes)
 *
 * Bump CACHE when you deploy, so old shells get evicted.
 * ------------------------------------------------------------------ */
const CACHE = 'austria26-v9';

const SHELL = [
  './',
  './index.html',
  './app.js',
  './data.js',
  './i18n.js',
  './manifest.webmanifest',
  'https://cdn.tailwindcss.com',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Individual addAll failures shouldn't abort the whole install.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  // Never cache map links or anything we don't own beyond the CDN.
  const url = new URL(request.url);
  if (url.hostname.endsWith('google.com')) return;

  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    // Network first: you always get the latest itinerary when you have signal.
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html')))
    );
  } else {
    // Cache first for the CDN: offline styling depends on this.
    e.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      }))
    );
  }
});
