// ===== 定数 =====
const TILE_SUBDOMAINS = ["a", "b", "c"];
const TILE_CACHE_NAME = "brm-map-tiles-v1";
const DOWNLOAD_ZOOM_LEVELS = [13, 14, 15, 16]; // ダウンロード対象のズームレベル
const ROUTE_BUFFER_TILES = 1; // ルート沿いの各タイルの周囲(隣接タイル数)もまとめてダウンロード
const GPS_SEARCH_WINDOW_KM = 8;   // 直前にマッチした距離から±この範囲内のみを探索（往復ルートの取り違え防止）
const GPS_MAX_MATCH_DIST_KM = 0.3; // 最も近い点でも300m以上離れている場合は信頼しない

// ===== 状態 =====
let map = null;
let routeLatLngs = [];   // [[lat,lon], ...] 表示用
let routePoints = [];    // [{lat, lon, dist}, ...] 距離マッチング用
let routeLine = null;
let currentMarker = null;
let followMode = true;
let watchId = null;
let wakeLockSentinel = null;
let wakeLockEnabled = false;
let lastMatchedDist = null;
let downloadCancelled = false;
let isDownloading = false;

// ===== DOM参照 =====
const statusText = document.getElementById("statusText");
const backBtn = document.getElementById("backBtn");
const gpxFileInput = document.getElementById("gpxFileInput");
const loadGpxBtn = document.getElementById("loadGpxBtn");
const downloadAreaBtn = document.getElementById("downloadAreaBtn");
const wakeLockBtn = document.getElementById("wakeLockBtn");
const recenterBtn = document.getElementById("recenterBtn");
const downloadProgressOverlay = document.getElementById("downloadProgressOverlay");
const downloadProgressText = document.getElementById("downloadProgressText");
const downloadProgressFill = document.getElementById("downloadProgressFill");
const cancelDownloadBtn = document.getElementById("cancelDownloadBtn");

function setStatus(text) { statusText.innerText = text; }

// ===== 距離計算（ハーバサイン公式） =====
function calcHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ===== ルート読み込み =====
// BRM PACE MANAGER（メイン側）と同一オリジンに配置している場合、localStorageを共有してGPXデータを引き継ぐ
function loadRouteFromLocalStorage() {
  try {
    const raw = localStorage.getItem("gpxTrackPoints");
    if (!raw) return false;
    const points = JSON.parse(raw);
    if (!Array.isArray(points) || points.length === 0) return false;
    routePoints = points.map(p => ({ lat: p.lat, lon: p.lon, dist: p.dist }));
    routeLatLngs = routePoints.map(p => [p.lat, p.lon]);
    return true;
  } catch (e) { return false; }
}

function parseGpxText(text) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, "text/xml");
  const trkpts = xmlDoc.getElementsByTagName("trkpt");
  if (trkpts.length === 0) return null;
  const points = [];
  let totalDist = 0;
  for (let i = 0; i < trkpts.length; i++) {
    const lat = parseFloat(trkpts[i].getAttribute("lat"));
    const lon = parseFloat(trkpts[i].getAttribute("lon"));
    if (i > 0) {
      const prev = points[i - 1];
      totalDist += calcHaversineDistance(prev.lat, prev.lon, lat, lon);
    }
    points.push({ lat, lon, dist: totalDist });
  }
  return points;
}

function applyRoute(points) {
  routePoints = points;
  routeLatLngs = points.map(p => [p.lat, p.lon]);
  drawRoute();
  lastMatchedDist = null;
  setStatus(`ルート読込済（全長 ${points[points.length - 1].dist.toFixed(1)}km）`);
}

function drawRoute() {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (routeLatLngs.length === 0) return;
  routeLine = L.polyline(routeLatLngs, { color: "#ff8c00", weight: 4, opacity: 0.85 }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
}

// ===== GPS位置とルートのマッチング（往復ルート対策：直前距離からの連続性ウィンドウ探索） =====
function matchPositionToRoute(lat, lon, lastDist) {
  if (routePoints.length === 0) return null;
  let candidates = routePoints;
  if (lastDist !== null && !isNaN(lastDist)) {
    const windowed = routePoints.filter(p => Math.abs(p.dist - lastDist) <= GPS_SEARCH_WINDOW_KM);
    if (windowed.length > 0) candidates = windowed;
  }
  let best = null, bestDist = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const d = calcHaversineDistance(lat, lon, candidates[i].lat, candidates[i].lon);
    if (d < bestDist) { bestDist = d; best = candidates[i]; }
  }
  if (!best || bestDist > GPS_MAX_MATCH_DIST_KM) return null;
  return best.dist;
}

// ===== オフラインタイルレイヤー（Cache Storage APIでタイル画像を保存・再利用） =====
function getSubdomain(x, y) { return TILE_SUBDOMAINS[Math.abs(x + y) % TILE_SUBDOMAINS.length]; }
function buildTileUrl(z, x, y) { return `https://${getSubdomain(x, y)}.tile.openstreetmap.org/${z}/${x}/${y}.png`; }

async function loadTileWithCache(url) {
  if (!("caches" in window)) {
    // Cache Storage APIが使えない環境(file://等)では通常のURLを直接使う(オフライン保存はできない)
    return url;
  }
  const cache = await caches.open(TILE_CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    const blob = await cached.blob();
    return URL.createObjectURL(blob);
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("tile fetch failed: " + resp.status);
  await cache.put(url, resp.clone());
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

const OfflineTileLayer = L.GridLayer.extend({
  createTile: function (coords, done) {
    const tile = document.createElement("img");
    tile.setAttribute("role", "presentation");
    const url = buildTileUrl(coords.z, coords.x, coords.y);
    loadTileWithCache(url).then(srcUrl => {
      tile.src = srcUrl;
      done(null, tile);
    }).catch(err => {
      done(err, tile);
    });
    return tile;
  }
});

// ===== 緯度経度 → スリッピーマップ タイル座標 =====
function latLonToTile(lat, lon, z) {
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ===== ルート周辺タイルの一括ダウンロード（事前にWi-Fi環境で実行する想定） =====
async function downloadRouteArea() {
  if (isDownloading) return;
  if (routeLatLngs.length === 0) { alert("先にルートを読み込んでください。"); return; }
  if (!("caches" in window)) { alert("この環境ではオフライン保存（Cache Storage API）が利用できません。httpsまたはlocalhost経由でアクセスしてください。"); return; }

  const tileSet = new Set();
  DOWNLOAD_ZOOM_LEVELS.forEach(z => {
    routeLatLngs.forEach(([lat, lon]) => {
      const { x, y } = latLonToTile(lat, lon, z);
      for (let dx = -ROUTE_BUFFER_TILES; dx <= ROUTE_BUFFER_TILES; dx++) {
        for (let dy = -ROUTE_BUFFER_TILES; dy <= ROUTE_BUFFER_TILES; dy++) {
          tileSet.add(`${z}/${x + dx}/${y + dy}`);
        }
      }
    });
  });
  const tileKeys = Array.from(tileSet);
  if (!confirm(`約${tileKeys.length}枚のタイル画像をダウンロードします。Wi-Fi環境での実行をおすすめします。続けますか？`)) return;

  isDownloading = true;
  downloadCancelled = false;
  downloadProgressOverlay.style.display = "flex";
  downloadProgressFill.style.width = "0%";
  downloadProgressText.innerText = `0 / ${tileKeys.length} タイル`;

  const cache = await caches.open(TILE_CACHE_NAME);
  let done = 0, failed = 0;
  for (let i = 0; i < tileKeys.length; i++) {
    if (downloadCancelled) break;
    const [zStr, xStr, yStr] = tileKeys[i].split("/");
    const z = Number(zStr), x = Number(xStr), y = Number(yStr);
    const url = buildTileUrl(z, x, y);
    try {
      const already = await cache.match(url);
      if (!already) {
        const resp = await fetch(url);
        if (resp.ok) await cache.put(url, resp.clone());
        else failed++;
      }
    } catch (e) { failed++; }
    done++;
    downloadProgressFill.style.width = Math.round((done / tileKeys.length) * 100) + "%";
    downloadProgressText.innerText = `${done} / ${tileKeys.length} タイル`;
    await sleep(60); // タイルサーバーへの負荷を抑えるための小休止
  }

  downloadProgressOverlay.style.display = "none";
  isDownloading = false;
  if (downloadCancelled) { alert("ダウンロードを中止しました。"); }
  else { alert(`ダウンロード完了：${done - failed}枚を保存しました${failed > 0 ? `（失敗: ${failed}枚）` : ""}。`); }
}

cancelDownloadBtn.addEventListener("click", () => { downloadCancelled = true; });

// ===== 現在地マーカー =====
function updateCurrentMarker(lat, lon) {
  const latlng = [lat, lon];
  if (!currentMarker) {
    const icon = L.divIcon({ className: "current-location-dot", iconSize: [16, 16] });
    currentMarker = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(map);
  } else {
    currentMarker.setLatLng(latlng);
  }
  if (followMode) map.setView(latlng, map.getZoom(), { animate: true });
}

// ===== GPS常時追従（地図モード表示中のみ。ページを離れたら停止する） =====
function onGpsPosition(pos) {
  const { latitude, longitude } = pos.coords;
  updateCurrentMarker(latitude, longitude);
  if (routePoints.length > 0) {
    const matched = matchPositionToRoute(latitude, longitude, lastMatchedDist);
    if (matched !== null) {
      lastMatchedDist = matched;
      setStatus(`現在 ${matched.toFixed(1)} km地点`);
      // BRM PACE MANAGER側（同一オリジン）にも現在距離を反映しておく
      try { localStorage.setItem("distance", matched.toFixed(1)); } catch (e) {}
    } else {
      setStatus("ルートから離れています");
    }
  } else {
    setStatus("ルート未読込（現在地のみ表示）");
  }
}

function onGpsError(err) {
  setStatus("GPS取得待ち…");
}

function startContinuousGps() {
  if (!navigator.geolocation) { setStatus("位置情報未対応の端末です"); return; }
  watchId = navigator.geolocation.watchPosition(onGpsPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
}
function stopContinuousGps() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}

// ===== 画面の自動消灯防止（Wake Lock API） =====
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) { wakeLockEnabled = false; updateWakeLockBtnUI(); return; }
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockEnabled = true;
    wakeLockSentinel.addEventListener("release", () => { wakeLockEnabled = false; updateWakeLockBtnUI(); });
  } catch (e) {
    wakeLockEnabled = false;
  }
  updateWakeLockBtnUI();
}
function releaseWakeLock() {
  if (wakeLockSentinel) { wakeLockSentinel.release().catch(() => {}); wakeLockSentinel = null; }
  wakeLockEnabled = false;
  updateWakeLockBtnUI();
}
function updateWakeLockBtnUI() {
  wakeLockBtn.classList.toggle("active", wakeLockEnabled);
  wakeLockBtn.innerText = wakeLockEnabled ? "🔒 画面ON中" : "🔓 画面OFF可";
}
wakeLockBtn.addEventListener("click", () => {
  if (wakeLockEnabled) releaseWakeLock(); else requestWakeLock();
});
// Wake LockはタブやWebViewが非アクティブになると自動的に解除されるため、復帰時に再取得する
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wakeLockEnabled === false && wakeLockSentinel === null) {
    // ユーザーが手動でOFFにした場合は再取得しない。OS側の自動解除からの復帰のみ再取得したいが区別が難しいため、
    // ここでは安全側に倒して「明示的にONにしていた場合のみ」復帰時に再取得する設計とする。
  }
});

// ===== 地図の手動操作でフォロー解除 =====
function setFollowMode(on) {
  followMode = on;
  recenterBtn.style.display = on ? "none" : "inline-block";
}

// ===== ボタン類 =====
backBtn.addEventListener("click", () => {
  stopContinuousGps();
  releaseWakeLock();
  // BRM PACE MANAGER（メイン側）が同一階層に配置されている前提のパス
  window.location.href = "../BRM-main/index.html";
});

loadGpxBtn.addEventListener("click", () => { gpxFileInput.click(); });
gpxFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const points = parseGpxText(evt.target.result);
      if (!points) { alert("GPXファイル内にトラックデータが見つかりませんでした。"); return; }
      applyRoute(points);
    } catch (err) {
      alert("GPXファイルの解析中にエラーが発生しました。");
    } finally {
      gpxFileInput.value = "";
    }
  };
  reader.readAsText(file);
});

downloadAreaBtn.addEventListener("click", () => { downloadRouteArea(); });

recenterBtn.addEventListener("click", () => {
  setFollowMode(true);
  if (currentMarker) map.setView(currentMarker.getLatLng(), map.getZoom(), { animate: true });
});

// ===== 初期化 =====
function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([35.681, 139.767], 13);
  const offlineLayer = new OfflineTileLayer({
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
  offlineLayer.addTo(map);

  map.on("dragstart", () => setFollowMode(false));
  map.on("zoomstart", (e) => { /* ズーム操作自体はフォロー解除しない（拡大縮小しつつ追従も可能にする） */ });

  const hasRoute = loadRouteFromLocalStorage();
  if (hasRoute) {
    drawRoute();
    setStatus(`ルート読込済（全長 ${routePoints[routePoints.length - 1].dist.toFixed(1)}km）`);
  } else {
    setStatus("ルート未読込（🗺️GPXから読み込めます）");
  }

  startContinuousGps();
  requestWakeLock();
}

// Service Worker登録（対応環境のみ。アプリ本体ファイルをオフラインキャッシュし、次回以降はネット接続なしでも起動できるようにする）
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

initMap();

// ページを離れる際はGPS・WakeLockを確実に解放してバッテリーを保護する
window.addEventListener("pagehide", () => { stopContinuousGps(); releaseWakeLock(); });
