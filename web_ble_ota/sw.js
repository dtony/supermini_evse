const CACHE_NAME = 'supermini-evse-cache-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './power_selection.js',
  './manifest.json',
  './icon.png'
];

// Installation: Mise en cache des ressources nécessaires
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching assets...');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activation: Nettoyage des anciens caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('Deleting old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

// Interception des requêtes: Stratégie Cache-First (pour le mode offline)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Retourne la réponse du cache si elle existe, sinon tente le réseau
      return response || fetch(event.request).then((fetchResponse) => {
        // Optionnel: On pourrait ajouter ici une logique pour mettre en cache 
        // les nouvelles ressources dynamiquement.
        return fetchResponse;
      });
    }).catch(() => {
      // En cas d'échec réseau et pas de cache, on peut retourner une page erreur si besoin
      console.error('Fetch failed; not in cache');
    })
  );
});
