// MIN-Tube-Pro Service Worker
const CACHE_NAME = 'min-wlyt-plus-v3';
const PRECACHE = [
  '/youtube-pro',
  '/manifest.json',
  '/min-img.png',
  '/classroom.192',
  '/classroom.512',
];

// API・再生・巨大ファイルはキャッシュしない。貯まると cache.match 自体が遅くなる。
const DYNAMIC = /^\/(api\/|video\/|healthz|360\/|rapid\/|sia-dl\/|ai-fetch\/|short-check\/|stream|pro-stream|scratch-edu\/|kahoot-edu\/|nocookie\/|version|check-version)/;
const SKIP_STORE = /^\/(game\/fun\/|proxy\/)/;
const MAX_CACHED_BYTES = 700000;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => (key === 'min-wlyt-plus' || key.startsWith('min-wlyt-plus-')) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (DYNAMIC.test(url.pathname) || SKIP_STORE.test(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const isStatic = /\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i.test(url.pathname)
      || url.pathname === '/manifest.json'
      || url.pathname === '/min-img.png'
      || url.pathname === '/classroom.192'
      || url.pathname === '/classroom.512';

    if (isStatic && cached) return cached;

    try {
      const response = await fetch(request);
      const len = Number(response.headers.get('content-length') || 0);
      const storeable = response && response.status === 200 && response.type === 'basic'
        && (len === 0 || len < MAX_CACHED_BYTES)
        && !url.pathname.endsWith('.html');
      if (storeable) {
        cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const fallback = await cache.match('/youtube-pro');
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
