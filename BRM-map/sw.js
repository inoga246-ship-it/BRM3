const APP_CACHE_NAME = "brm-map-app-v1";
const APP_SHELL_FILES = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/script.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== APP_CACHE_NAME && k !== "brm-map-tiles-v1").map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// アプリ本体（HTML/CSS/JS）はCache First。タイル画像はscript.js側のCache Storage APIで個別に管理しているため、
// ここではアプリシェルのみを対象にする（タイルURL=tile.openstreetmap.orgへのリクエストには介入しない）。
self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  if (url.includes("tile.openstreetmap.org")) return; // タイルはscript.js側のcaches.open(TILE_CACHE_NAME)で処理済み
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp.ok && event.request.url.startsWith(self.location.origin)) {
          const respClone = resp.clone();
          caches.open(APP_CACHE_NAME).then((cache) => cache.put(event.request, respClone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
