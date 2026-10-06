// Offline support: app files are network-first (so updates show up).
// CDN libraries are left to the browser's own cache: modules served through a service worker lose their
// base URL, which breaks the root-relative imports that jsDelivr and esm.sh use.

const CACHE = 'tansen-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'text.js',
  'store.js',
  'extract.js',
  'neural.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === location.origin && !url.pathname.startsWith('/api/')) {
    e.respondWith(fetchAndCache(request).catch(() => caches.match(request, { ignoreSearch: true })));
  }
});

async function fetchAndCache(request) {
  const res = await fetch(request);
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(request, copy));
  }
  return res;
}
