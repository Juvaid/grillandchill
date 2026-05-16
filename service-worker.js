const CACHE_NAME = 'gc-menu-v2'; // Version bump forces update
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './assets/logo.svg'
];

// 1. Install & Cache core assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting(); // Force activate new worker immediately
});

// 2. Activate & Clear OLD Caches (Fixes "Old Deployment" issue)
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim(); // Take control of all pages immediately
});

// 3. Smart Fetching: Network-First for HTML/Data, Cache-First for Images
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // For HTML files and API calls, try network FIRST, fallback to cache
  if (e.request.mode === 'navigate' || url.hostname.includes('supabase.co')) {
    e.respondWith(
      fetch(e.request)
        .catch(() => caches.match(e.request))
    );
  } else {
    // For images, fonts, and CSS, try cache FIRST
    e.respondWith(
      caches.match(e.request).then((res) => res || fetch(e.request))
    );
  }
});
