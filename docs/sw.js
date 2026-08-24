// Service worker: NETWORK-FIRST con fallback su cache.
// Online → sempre l'ultima versione (app). Offline → ultima copia salvata + dati da localStorage.
const VERSION = "v1";
const CACHE = "ctvm-" + VERSION;
const SHELL_ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./engine.js", "./sync.js",
  "./manifest.webmanifest", "./data/ricette.seed.json",
  "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ctvm-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // NON intercettare le richieste cross-origin (Firebase: stream SSE + REST) → sync realtime intatta
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-store" })
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match("./index.html")))
  );
});
