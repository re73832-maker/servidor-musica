const CACHE_NAME = 'app-musica-v5.1.0';
const MEDIA_CACHE_NAME = 'app-musica-media-v5.1.0';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png'
];

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== MEDIA_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Helper NetworkFirst con timeout máximo de 2.5 segundos y fallback inmediato a CacheFirst
function fetchWithTimeoutAndCache(request, cacheName, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      caches.match(request).then((cached) => {
        if (!settled && cached) {
          settled = true;
          resolve(cached);
        }
      });
    }, timeoutMs);

    fetch(request)
      .then((networkResponse) => {
        clearTimeout(timer);
        if (networkResponse && (networkResponse.status === 200 || networkResponse.status === 0)) {
          const respClone = networkResponse.clone();
          caches.open(cacheName).then((cache) => cache.put(request, respClone)).catch(() => {});
          if (!settled) {
            settled = true;
            resolve(networkResponse);
          }
          return;
        }
        throw new Error('Bad network response');
      })
      .catch(() => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        caches.match(request).then((cached) => {
          if (cached) {
            resolve(cached);
          } else if (request.mode === 'navigate') {
            caches.match('/index.html').then((idx) => resolve(idx || caches.match('/')));
          } else {
            resolve(new Response('', { status: 504, statusText: 'Offline' }));
          }
        });
      });
  });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
    return;
  }

  // Las llamadas a la API y descargas van directas a la red
  if (
    event.request.url.includes('/api/') ||
    event.request.url.includes('/descargar') ||
    event.request.url.includes('/stream') ||
    event.request.url.includes('/health')
  ) {
    return;
  }

  const dest = event.request.destination;
  const url = new URL(event.request.url);

  // 1. Imágenes, fuentes y carátulas: CacheFirst para carga instantánea sin red
  if (
    dest === 'image' ||
    dest === 'font' ||
    /\.(png|jpg|jpeg|svg|webp|gif|woff2?|ttf|otf)$/i.test(url.pathname)
  ) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && (networkResponse.status === 200 || networkResponse.status === 0)) {
              const respClone = networkResponse.clone();
              caches.open(MEDIA_CACHE_NAME).then((cache) => cache.put(event.request, respClone)).catch(() => {});
            }
            return networkResponse;
          })
          .catch(() => new Response('', { status: 504, statusText: 'Offline' }));
      })
    );
    return;
  }

  // 2. HTML y bundles JS/CSS: NetworkFirst con timeout máximo de 2.5s y fallback inmediato a caché local
  if (
    event.request.mode === 'navigate' ||
    dest === 'document' ||
    dest === 'script' ||
    dest === 'style' ||
    dest === 'worker' ||
    /\.(js|css|html|json|webmanifest)$/i.test(url.pathname)
  ) {
    event.respondWith(fetchWithTimeoutAndCache(event.request, CACHE_NAME, 2500));
    return;
  }

  // 3. Cualquier otro recurso estático: CacheFirst con fallback a red
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetchWithTimeoutAndCache(event.request, CACHE_NAME, 2500))
  );
});
