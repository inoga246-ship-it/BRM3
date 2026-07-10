const APP_CACHE_NAME = "brm-map-app-v2";
const APP_SHELL_FILES = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/script.js",
  "./js/vendor/leaflet/leaflet.js",
  "./js/vendor/leaflet/leaflet.css",
  "./js/vendor/leaflet/images/marker-icon.png",
  "./js/vendor/leaflet/images/marker-icon-2x.png",
  "./js/vendor/leaflet/images/marker-shadow.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE_NAME).then((cache) =>
      // addAllは1件でも404だとinstall全体が失敗するため、1件ずつ個別に試行する
      // （vendor配置前の初回インストール時などに全体が壊れないようにするため）
      Promise.all(
        APP_SHELL_FILES.map((file) =>
          cache.add(file).catch((err) => {
            console.warn("[sw] precache failed (will retry on next fetch):", file, err);
          })
        )
      )
    )
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

// アプリ本体（HTML/CSS/JS/vendorのLeaflet）はCache First。タイル画像はscript.js側のCache Storage APIで個別に管理しているため、
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
