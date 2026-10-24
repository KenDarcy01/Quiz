// Offline support: the app shell is cached on install; question sheets and the database are always fetched fresh
// (the app keeps its own copy of the last sheet in localStorage).
const CACHE = 'fq-shell-v31';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'js/csv.js',
  'js/questions.js',
  'js/supabase.js',
  'js/vendor/supabase.js',
  'js/account.js',
  'js/multiplayer.js',
  'js/app.js',
  'questions/questions.csv',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'docs.google.com') return; // let the network handle sheet requests

  // Fonts: cache after first use so the theme still looks right offline.
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Same-origin files: network first so updates arrive, cache when offline. "no-cache" makes the
  // browser check with the server instead of reusing its own HTTP cache (GitHub Pages allows 10 minutes).
  event.respondWith(
    fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
