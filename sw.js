/* Service worker for Our Memory Book.
 *
 * Scope note: registered as './sw.js', so the scope is whatever directory the
 * site is served from — this works unchanged at https://user.github.io/memory-book/
 * and at http://localhost:8000/.
 *
 * Caching policy is an *allowlist*, deliberately. Only the app shell (this
 * origin) and the pinned Supabase library are ever cached. Every other request
 * — the Supabase REST API, auth endpoints, realtime, and the signed photo URLs
 * — falls through to the network untouched. That matters here: those responses
 * carry session tokens and private photos, and signed URLs expire after an
 * hour, so caching them would both leak data into on-disk storage and serve
 * dead links. Do not "optimise" this into a denylist.
 */

const VERSION = 'v1';
const SHELL_CACHE = `memory-book-shell-${VERSION}`;

const SUPABASE_LIB =
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3/dist/umd/supabase.js';

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_ASSETS);
      // Cross-origin, so request it explicitly in CORS mode: an opaque
      // response would break the page's integrity check on replay.
      await cache.add(new Request(SUPABASE_LIB, { mode: 'cors' })).catch(() => {
        // A CDN hiccup shouldn't fail the whole install; the page will fetch
        // it from the network and the next install attempt can cache it.
      });
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('memory-book-') && name !== SHELL_CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// The page asks for this once the user accepts an update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isLibrary = request.url === SUPABASE_LIB;

  if (!isSameOrigin && !isLibrary) return; // Supabase &c. — never touched.

  // Navigations: network first, so a deployed change is picked up immediately
  // and the OAuth callback always reaches the real page; fall back to the
  // cached shell so the app still opens with no connection.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch (err) {
          const cached = await caches.match('./index.html');
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  // Static shell assets: serve from cache for instant loads, refresh in the
  // background so the next visit gets any change.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);

      const network = fetch(request)
        .then(async (response) => {
          if (response && response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      return cached || (await network) || Response.error();
    })()
  );
});
