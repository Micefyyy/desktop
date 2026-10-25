/* Liner web app service worker.
 * Pre-caches the shell so the PWA opens offline on iOS, then serves hashed
 * build assets cache-first with a background refresh. Cross-origin media,
 * API calls and range requests are never intercepted.
 */
const VERSION = "v1";
const PRECACHE = `liner-shell-${VERSION}`;
const RUNTIME = `liner-assets-${VERSION}`;

const SCOPE = self.registration.scope;
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      await Promise.all(
        APP_SHELL.map((path) =>
          cache.add(new Request(new URL(path, SCOPE), { cache: "reload" })).catch(() => {}),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== PRECACHE && key !== RUNTIME && key.startsWith("liner-"))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function isSameOrigin(url) {
  return new URL(url).origin === self.location.origin;
}

async function networkFirst(request) {
  const cache = await caches.open(PRECACHE);
  try {
    // bypass the HTTP cache so a fresh deploy is picked up immediately
    const response = await fetch(request, { cache: "reload" });
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (error) {
    const cached =
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match(new URL("./index.html", SCOPE), { ignoreSearch: true }));
    if (cached) return cached;
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const network = fetch(request, { cache: "no-cache" })
    .then((response) => {
      if (response.ok && response.type === "basic") {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => undefined);
  return cached || (await network) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (!isSameOrigin(request.url)) return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);
  if (url.pathname.endsWith("/sw.js")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  if (/\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|svg|gif|ico|wasm|json|webmanifest)$/i.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
