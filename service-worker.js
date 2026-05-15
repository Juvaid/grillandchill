const CACHE_NAME = 'gc-menu-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './assets/pizza.png',
  './assets/burger.png',
  './assets/shake.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
