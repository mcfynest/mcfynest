// Manifest service worker — caches the app shell so the UI still opens
// offline/on a flaky connection, but never caches API responses (orders
// and stock must always be fetched fresh).
const CACHE = 'manifest-shell-v1';
const SHELL_FILES = [
  './',
  'index.php',
  'assets/css/app.css',
  'assets/js/app.js',
  'manifest.json',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache API calls — always hit the network so order/stock data
  // stays current (this is the same "no stale data" principle behind the
  // manual "Check for new orders" flow).
  if (url.pathname.includes('/api/')) {
    return;
  }
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(res => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
