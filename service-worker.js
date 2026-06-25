const CACHE_NAME = 'gc-menu-v7'; // Version bump forces cache refresh
const ASSETS = [
  './',
  './index.html',
  './admin.html',
  './admin.js',
  './admin.js?v=6',
  './admin.css',
  './admin.css?v=6',
  './privacy.html',
  './terms.html',
  './styles.css',
  './styles.css?v=6',
  './manifest.json',
  './env.js',
  './assets/logo-transparent.png',
  './assets/logo.png',
  './assets/logo.svg',
  './assets/burger.png',
  './assets/woody_bg.webp',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/dexie@3/dist/dexie.js',
  'https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js',
  'https://cdn.jsdelivr.net/npm/lucide@0.344.0/dist/umd/lucide.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
];

// 1. Install & Cache core assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching core assets...');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting(); // Force activate new worker immediately
});

// 2. Activate & Clear OLD Caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
            .map((key) => {
              console.log('[Service Worker] Removing old cache:', key);
              return caches.delete(key);
            })
      );
    })
  );
  self.clients.claim(); // Take control of all pages immediately
});

// 3. Fetch handler with static asset dynamic caching
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // For navigate requests, try network first, then fall back to cache
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .catch(() => caches.match(e.request, { ignoreSearch: true }) || caches.match('./index.html', { ignoreSearch: true }))
    );
    return;
  }

  // Cacheable domains/sources (Local, Google Fonts, CDNs, Supabase static libraries)
  const isCacheable = (
    url.origin === self.location.origin ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('jsdelivr.net') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    (url.hostname.includes('supabase.co') && !url.pathname.includes('/rest/v1/'))
  );

  // Dynamically cache GET requests for static resources
  if (e.request.method === 'GET' && isCacheable) {
    e.respondWith(
      caches.match(e.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(e.request).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
            return networkResponse;
          }
          // Clone and cache the response
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
          return networkResponse;
        });
      })
    );
  } else {
    // Perform standard fetch for APIs and other requests (POST, PATCH, DELETE)
    e.respondWith(fetch(e.request));
  }
});

// 4. Background Push Notification Event Listener
self.addEventListener('push', (e) => {
  let data = { title: 'New Order Received! 🍕', body: 'A new customer has placed an order.' };
  if (e.data) {
    try {
      data = e.data.json();
    } catch (err) {
      data = { title: 'New Order Received! 🍕', body: e.data.text() };
    }
  }
  
  const options = {
    body: data.body,
    icon: './assets/logo-transparent.png',
    badge: './assets/logo-transparent.png',
    vibrate: [200, 100, 200, 100, 400],
    data: {
      url: './admin.html'
    }
  };
  
  e.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 5. Notification Click Handler
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const urlToOpen = new URL(e.notification.data.url, self.location.origin).href;
  
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If an admin tab is already open, focus it
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise, open a new tab
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
