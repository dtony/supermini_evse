// ⚠️ Incrémenter CACHE_VERSION à chaque déploiement pour forcer la mise à jour
const CACHE_VERSION = 'v3';
const CACHE_NAME = `supermini-evse-cache-${CACHE_VERSION}`;

// Ressources à précacher au premier lancement
const ASSETS_TO_PRECACHE = [
  './',
  './index.html',
  './power_selection.js',
  './manifest.json',
  './icon.png'
];

// Assets statiques (ne changent pas souvent) → stratégie Cache-First
const CACHE_FIRST_EXTENSIONS = /\.(png|ico|jpg|woff2?)$/;

// Installation: précache + activation immédiate sans attendre la fermeture des onglets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Précache des ressources...');
        return cache.addAll(ASSETS_TO_PRECACHE);
      })
      .then(() => self.skipWaiting()) // Activation immédiate du nouveau SW
  );
});

// Activation: suppression des anciens caches + prise de contrôle des onglets ouverts
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Suppression ancien cache:', name);
            return caches.delete(name);
          })
      ))
      .then(() => self.clients.claim()) // Prend le contrôle sans rechargement
  );
});

// Fetch: Network-First pour HTML/JS, Cache-First pour les assets statiques
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ignorer les requêtes non-GET et les ressources cross-origin (CDN fonts, Tailwind…)
  if (event.request.method !== 'GET' || url.origin !== location.origin) {
    return;
  }

  if (CACHE_FIRST_EXTENSIONS.test(url.pathname)) {
    // Cache-First: images et fonts locales — pas besoin d'aller sur le réseau à chaque fois
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
    );
  } else {
    // Network-First: HTML et JS — toujours tenter le réseau pour avoir la dernière version
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => {
          // Hors ligne: fallback sur le cache
          return caches.match(event.request).then((cached) => {
            return cached || new Response('Hors ligne — ressource non disponible', { status: 503 });
          });
        })
    );
  }
});

// Permet à la page de demander l'activation forcée (utilisé par la bannière de MAJ)
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
