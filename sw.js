/* Minimal app-shell service worker (cache static assets for offline use). */

const CACHE_NAME = "roo-static-v1";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(ASSETS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Single-page app shell: always serve index for navigations (offline-friendly).
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const res = await fetch(request);
          if (res.ok) cache.put("./index.html", res.clone());
          return res;
        } catch {
          return (await cache.match("./index.html")) || (await cache.match("./"));
        }
      })()
    );
    return;
  }

  // Static assets: cache-first, then update in the background.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) {
        event.waitUntil(
          fetch(request)
            .then((res) => {
              if (res.ok) cache.put(request, res.clone());
            })
            .catch(() => {})
        );
        return cached;
      }

      try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      } catch {
        return (await cache.match("./index.html")) || new Response("Offline", { status: 503 });
      }
    })()
  );
});

