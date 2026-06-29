// ===== 定数 =====
const TILE_SUBDOMAINS = ["a", "b", "c"];
const TILE_CACHE_NAME = "brm-map-tiles-v1";
const DOWNLOAD_ZOOM_LEVELS = [13, 14, 15, 16]; // ダウンロード対象のズームレベル
const ROUTE_BUFFER_TILES = 1; // ルート沿いの各タイルの周囲(隣接タイル数)もまとめてダウンロード
const DOWNLOAD_CONCURRENCY = 4; // 同時ダウンロード数（速度と負荷のバランス）
const GPS_SEARCH_WINDOW_KM = 8;   // 直前にマッチした距離から±この範囲内のみを探索（往復ルートの取り違え防止）
const GPS_MAX_MATCH_DIST_KM = 0.3; // 最も近い点でも300m以上離れている場合は信頼しない

// ===== 状態 =====
let map = null;
let routeLatLngs = [];   // [[lat,lon], ...] 表示用
let routePoints = [];    // [{lat, lon, dist}, ...] 距離マッチング用
let routeLine = null;
let currentMarker = null;
let pcMarkers = [];
let shopMarkers = [];
let followMode = true;
let watchId = null;
let wakeLockSentinel = null;
let wakeLockEnabled = false;
let lastMatchedDist = null;
let downloadCancelled = false;
let isDownloading = false;
let mapOrientationMode = "north"; // "north"（北が上） | "heading"（進行方向が上）
let currentRotationDeg = 0; // 現在の地図回転角（heading-upモード用）

// 表示設定（マーカー色・ルート線の色/太さ/透過度）
const DEFAULT_DISPLAY_SETTINGS = { markerColor: "#00d2ff", routeColor: "#ff8c00", routeWidth: 4, routeOpacity: 0.85 };
let displaySettings = { ...DEFAULT_DISPLAY_SETTINGS };

// ===== DOM参照 =====
const statusText = document.getElementById("statusText");
const backBtn = document.getElementById("backBtn");
const menuBtn = document.getElementById("menuBtn");
const menuCloseBtn = document.getElementById("menuCloseBtn");
const mapMenuModal = document.getElementById("mapMenuModal");
const downloadAreaBtn = document.getElementById("downloadAreaBtn");
const wakeLockBtn = document.getElementById("wakeLockBtn");
const orientationModeBtn = document.getElementById("orientationModeBtn");
const recenterBtn = document.getElementById("recenterBtn");
const mapEl = document.getElementById("map");
const downloadProgressOverlay = document.getElementById("downloadProgressOverlay");
const downloadProgressText = document.getElementById("downloadProgressText");
const downloadProgressFill = document.getElementById("downloadProgressFill");
const cancelDownloadBtn = document.getElementById("cancelDownloadBtn");
const markerColorInput = document.getElementById("markerColorInput");
const routeColorInput = document.getElementById("routeColorInput");
const routeWidthInput = document.getElementById("routeWidthInput");
const routeWidthValue = document.getElementById("routeWidthValue");
const routeOpacityInput = document.getElementById("routeOpacityInput");
const routeOpacityValue = document.getElementById("routeOpacityValue");
const resetDisplaySettingsBtn = document.getElementById("resetDisplaySettingsBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");

function setStatus(text) { statusText.innerText = text; }

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ===== 距離計算（ハーバサイン公式） =====
function calcHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ===== ルート読み込み（GPXはBRM PACE MANAGER側で読み込んだものをlocalStorage経由で共有する。地図側に読込UIは置かない） =====
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

function drawRoute() {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (routeLatLngs.length === 0) return;
  routeLine = L.polyline(routeLatLngs, { color: displaySettings.routeColor, weight: displaySettings.routeWidth, opacity: displaySettings.routeOpacity }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
}

// ===== ①PC・②休憩スポットの簡易パース（BRM PACE MANAGER本体のリスト書式に対応） =====
function parseSimpleList(text, isPcMode) {
  if (!text) return [];
  const lines = text.split("\n").map(l => l.trim()).filter(l => l !== "");
  const result = [];
  for (const line of lines) {
    const cols = line.split(/[,，、]/).map(c => c.trim());
    if (cols.length < 2) continue;
    let label, distStr;
    if (isPcMode && cols.length >= 3) { label = cols[0] + " " + cols[1]; distStr = cols[2]; }
    else { label = cols[0]; distStr = cols[1]; }
    const dist = parseFloat(String(distStr).replace(/[^\d.]/g, ""));
    if (!isNaN(dist)) result.push({ label, dist });
  }
  return result;
}

// ルート上の指定距離(km)に最も近い緯度経度を返す
function findLatLonAtDistance(dist) {
  if (routePoints.length === 0) return null;
  let best = routePoints[0], bestDiff = Math.abs(routePoints[0].dist - dist);
  for (let i = 1; i < routePoints.length; i++) {
    const diff = Math.abs(routePoints[i].dist - dist);
    if (diff < bestDiff) { bestDiff = diff; best = routePoints[i]; }
  }
  return [best.lat, best.lon];
}

// ===== PC（チェックポイント）・休憩スポットのマーカーを描画 =====
function renderPcShopMarkers() {
  pcMarkers.forEach(m => map.removeLayer(m)); pcMarkers = [];
  shopMarkers.forEach(m => map.removeLayer(m)); shopMarkers = [];
  if (routePoints.length === 0) return;

  const pcList = parseSimpleList(localStorage.getItem("pcList3") || "", true);
  const shopList = parseSimpleList(localStorage.getItem("shopList3") || "", false);

  pcList.forEach(item => {
    const latlon = findLatLonAtDistance(item.dist);
    if (!latlon) return;
    const icon = L.divIcon({ className: "pc-marker-icon", html: `<div class="pc-marker-dot">${escapeHtml(item.label).slice(0, 8)}</div>`, iconSize: [0, 0] });
    const marker = L.marker(latlon, { icon }).bindPopup(`${escapeHtml(item.label)}（${item.dist.toFixed(1)}km）`);
    marker.addTo(map);
    pcMarkers.push(marker);
  });

  shopList.forEach(item => {
    const latlon = findLatLonAtDistance(item.dist);
    if (!latlon) return;
    const icon = L.divIcon({ className: "shop-marker-icon", html: `<div class="shop-marker-dot">🏪</div>`, iconSize: [0, 0] });
    const marker = L.marker(latlon, { icon }).bindPopup(`${escapeHtml(item.label)}（${item.dist.toFixed(1)}km）`);
    marker.addTo(map);
    shopMarkers.push(marker);
  });
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

// ===== ルート周辺タイルの一括ダウンロード（事前にWi-Fi環境で実行する想定。並列ダウンロードで高速化） =====
async function downloadRouteArea() {
  if (isDownloading) return;
  if (routeLatLngs.length === 0) { alert("ルートが読み込まれていません。先にBRM PACE MANAGER側でGPXを読み込んでください。"); return; }
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

  closeMapMenu();
  isDownloading = true;
  downloadCancelled = false;
  downloadProgressOverlay.style.display = "flex";
  downloadProgressFill.style.width = "0%";
  downloadProgressText.innerText = `0 / ${tileKeys.length} タイル`;

  const cache = await caches.open(TILE_CACHE_NAME);
  let done = 0, failed = 0;

  async function downloadOne(key) {
    if (downloadCancelled) return;
    const [zStr, xStr, yStr] = key.split("/");
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
  }

  // DOWNLOAD_CONCURRENCY件ずつ並列実行（タイルサーバーへの負荷を抑えつつ速度を確保）
  for (let i = 0; i < tileKeys.length; i += DOWNLOAD_CONCURRENCY) {
    if (downloadCancelled) break;
    const batch = tileKeys.slice(i, i + DOWNLOAD_CONCURRENCY);
    await Promise.all(batch.map(key => downloadOne(key)));
  }

  downloadProgressOverlay.style.display = "none";
  isDownloading = false;
  if (downloadCancelled) { alert("ダウンロードを中止しました。"); }
  else { alert(`ダウンロード完了：${done - failed}枚を保存しました${failed > 0 ? `（失敗: ${failed}枚）` : ""}。`); }
}

cancelDownloadBtn.addEventListener("click", () => { downloadCancelled = true; });

// ===== メニュー（エリア保存ボタンの誤操作防止のためここに収納） =====
function openMapMenu() { mapMenuModal.classList.add("open"); }
function closeMapMenu() { mapMenuModal.classList.remove("open"); }
menuBtn.addEventListener("click", openMapMenu);
menuCloseBtn.addEventListener("click", closeMapMenu);
mapMenuModal.addEventListener("click", (e) => { if (e.target === mapMenuModal) closeMapMenu(); });
downloadAreaBtn.addEventListener("click", () => { downloadRouteArea(); });

// ===== 表示設定（マーカー色・ルート線の色/太さ/透過度） =====
function loadDisplaySettings() {
  try {
    const raw = localStorage.getItem("mapDisplaySettings");
    if (raw) displaySettings = { ...DEFAULT_DISPLAY_SETTINGS, ...JSON.parse(raw) };
  } catch (e) { displaySettings = { ...DEFAULT_DISPLAY_SETTINGS }; }
}
function saveDisplaySettings() {
  localStorage.setItem("mapDisplaySettings", JSON.stringify(displaySettings));
}
function applyDisplaySettingsToUI() {
  markerColorInput.value = displaySettings.markerColor;
  routeColorInput.value = displaySettings.routeColor;
  routeWidthInput.value = displaySettings.routeWidth;
  routeWidthValue.innerText = displaySettings.routeWidth;
  routeOpacityInput.value = Math.round(displaySettings.routeOpacity * 100);
  routeOpacityValue.innerText = Math.round(displaySettings.routeOpacity * 100);
}
function applyDisplaySettingsToMap() {
  document.documentElement.style.setProperty("--marker-color", displaySettings.markerColor);
  if (routeLine) routeLine.setStyle({ color: displaySettings.routeColor, weight: displaySettings.routeWidth, opacity: displaySettings.routeOpacity });
}

markerColorInput.addEventListener("input", () => {
  displaySettings.markerColor = markerColorInput.value;
  applyDisplaySettingsToMap(); saveDisplaySettings();
});
routeColorInput.addEventListener("input", () => {
  displaySettings.routeColor = routeColorInput.value;
  applyDisplaySettingsToMap(); saveDisplaySettings();
});
routeWidthInput.addEventListener("input", () => {
  displaySettings.routeWidth = Number(routeWidthInput.value);
  routeWidthValue.innerText = displaySettings.routeWidth;
  applyDisplaySettingsToMap(); saveDisplaySettings();
});
routeOpacityInput.addEventListener("input", () => {
  displaySettings.routeOpacity = Number(routeOpacityInput.value) / 100;
  routeOpacityValue.innerText = Number(routeOpacityInput.value);
  applyDisplaySettingsToMap(); saveDisplaySettings();
});
resetDisplaySettingsBtn.addEventListener("click", () => {
  displaySettings = { ...DEFAULT_DISPLAY_SETTINGS };
  applyDisplaySettingsToUI(); applyDisplaySettingsToMap(); saveDisplaySettings();
});

// ===== 画面中央付近のズームボタン =====
zoomInBtn.addEventListener("click", () => { map.zoomIn(); });
zoomOutBtn.addEventListener("click", () => { map.zoomOut(); });

// ===== 地図の向き（北が上 / 進行方向が上） =====
function applyMapRotation(angleDeg) {
  currentRotationDeg = angleDeg;
  mapEl.style.transform = `rotate(${-angleDeg}deg)`;
  if (currentMarker) {
    const el = currentMarker.getElement();
    if (el) {
      const inner = el.querySelector(".arrow-shape");
      if (inner) {
        // heading-upモードでは常に上向き(矢印そのものは回転しない)、north-upモードでは実際の進行方向角度を反映する
        const arrowAngle = mapOrientationMode === "heading" ? 0 : angleDeg;
        inner.style.transform = `rotate(${arrowAngle}deg)`;
      }
    }
  }
}

function setOrientationMode(mode) {
  mapOrientationMode = mode;
  orientationModeBtn.classList.toggle("heading-mode", mode === "heading");
  orientationModeBtn.innerText = mode === "heading" ? "🧭 進行方向が上" : "🧭 北が上";
  if (mode === "north") {
    map.dragging.enable();
    applyMapRotation(0);
  } else {
    // 進行方向不明（停止中など）の間は北上のまま、headingが得られたら回転を適用する
    map.dragging.disable();
  }
}

orientationModeBtn.addEventListener("click", () => {
  setOrientationMode(mapOrientationMode === "north" ? "heading" : "north");
});

// ===== 現在地マーカー（進行方向矢印付き） =====
function updateCurrentMarker(lat, lon, headingDeg) {
  const latlng = [lat, lon];
  if (!currentMarker) {
    const icon = L.divIcon({
      className: "current-location-wrapper",
      html: '<div class="current-location-arrow-outer"><div class="arrow-shape"></div></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
    currentMarker = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(map);
  } else {
    currentMarker.setLatLng(latlng);
  }
  if (followMode) map.setView(latlng, map.getZoom(), { animate: true });

  if (mapOrientationMode === "heading") {
    if (headingDeg !== null && !isNaN(headingDeg)) {
      applyMapRotation(-headingDeg);
    }
    // headingDeg が null（停止中等）の場合は、直前の回転角をそのまま維持する
  } else {
    applyMapRotation(0);
  }
}

// ===== GPS常時追従（地図モード表示中のみ。ページを離れたら停止する） =====
function onGpsPosition(pos) {
  const { latitude, longitude, heading } = pos.coords;
  updateCurrentMarker(latitude, longitude, (heading === undefined ? null : heading));
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

// ===== 地図の手動操作でフォロー解除 =====
function setFollowMode(on) {
  followMode = on;
  recenterBtn.style.display = on ? "none" : "inline-block";
}

// ===== 戻るボタン =====
// BRM PACE MANAGER側から遷移してきた場合はブラウザ履歴で戻るのが最も確実（配置場所によらず正しく戻れる）。
// 履歴がない場合（直接このURLを開いた場合など）のみ、同階層の index.html への遷移を試みる。
backBtn.addEventListener("click", () => {
  stopContinuousGps();
  releaseWakeLock();
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = "../index.html";
  }
});

recenterBtn.addEventListener("click", () => {
  setFollowMode(true);
  if (currentMarker) map.setView(currentMarker.getLatLng(), map.getZoom(), { animate: true });
});

// ===== 初期化 =====
function initMap() {
  loadDisplaySettings();
  applyDisplaySettingsToUI();
  document.documentElement.style.setProperty("--marker-color", displaySettings.markerColor);

  map = L.map("map", { zoomControl: false, attributionControl: true }).setView([35.681, 139.767], 13);
  const offlineLayer = new OfflineTileLayer({
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
  offlineLayer.addTo(map);

  map.on("dragstart", () => setFollowMode(false));

  const hasRoute = loadRouteFromLocalStorage();
  if (hasRoute) {
    drawRoute();
    renderPcShopMarkers();
    setStatus(`ルート読込済（全長 ${routePoints[routePoints.length - 1].dist.toFixed(1)}km）`);
  } else {
    setStatus("ルート未読込（BRM PACE MANAGER側でGPXを読込んでください）");
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
