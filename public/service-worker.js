// Minimal service worker: exists mainly to satisfy PWA installability
// (Chrome/Android require a fetch handler) and to let the app shell boot
// from cache when offline. Deliberately does NOT cache /api/*, /smp-ws,
// or /ws — those are live/session/streaming endpoints and must always
// hit the network.

const CACHE_NAME = 'smp-shell-v1';
const SHELL_URLS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

function isBypassed(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/smp-ws' ||
    url.pathname === '/ws'
  );
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET' || url.origin !== self.location.origin || isBypassed(url)) {
    return; // let the browser handle it normally
  }

  // network-first for the app shell, falling back to cache when offline
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))
  );
});
