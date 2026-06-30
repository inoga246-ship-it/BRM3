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
let routeDirectionMarkers = [];
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

// ルート逸脱通知（音）：逸脱した瞬間に1回、その後は一定間隔で再通知する（鳴り続けて煩わしくならないように抑制）
let audioCtx = null;
let lastOffRouteAlertTime = 0;
let wasOffRoute = false;
const OFF_ROUTE_ALERT_INTERVAL_MS = 30000; // 再通知の間隔（30秒）
let offRouteSoundEnabled = true;
const offRouteSoundToggle = document.getElementById("offRouteSoundToggle");

function loadOffRouteSoundSetting() {
  const raw = localStorage.getItem("offRouteSoundEnabled");
  offRouteSoundEnabled = raw === null ? true : raw === "true";
  offRouteSoundToggle.checked = offRouteSoundEnabled;
}
offRouteSoundToggle.addEventListener("change", () => {
  offRouteSoundEnabled = offRouteSoundToggle.checked;
  localStorage.setItem("offRouteSoundEnabled", String(offRouteSoundEnabled));
});

function playOffRouteBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [0, 0.18].forEach((offset) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.15);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(now + offset); osc.stop(now + offset + 0.16);
    });
  } catch (e) { /* AudioContext未対応・ユーザー操作前の自動再生制限などは無視する */ }
}

function notifyOffRouteIfNeeded(isOffRoute) {
  const now = Date.now();
  if (isOffRoute && offRouteSoundEnabled) {
    if (!wasOffRoute || (now - lastOffRouteAlertTime) >= OFF_ROUTE_ALERT_INTERVAL_MS) {
      playOffRouteBeep();
      lastOffRouteAlertTime = now;
    }
  }
  wasOffRoute = isOffRoute;
}

// 表示設定（マーカー色・ルート線の色/太さ/透過度）
const DEFAULT_DISPLAY_SETTINGS = { markerColor: "#00d2ff", markerShape: "arrow", routeColor: "#ff8c00", routeWidth: 4, routeOpacity: 0.85 };
let displaySettings = { ...DEFAULT_DISPLAY_SETTINGS };

// ===== DOM参照 =====
const statusText = document.getElementById("statusText");
const backBtn = document.getElementById("backBtn");
const menuBtn = document.getElementById("menuBtn");
const menuCloseBtn = document.getElementById("menuCloseBtn");
const mapMenuModal = document.getElementById("mapMenuModal");
const downloadAreaBtn = document.getElementById("downloadAreaBtn");
const wakeLockToggle = document.getElementById("wakeLockToggle");
const orientationModeBtn = document.getElementById("orientationModeBtn");
const recenterBtn = document.getElementById("recenterBtn");
const mapEl = document.getElementById("map");
const downloadProgressOverlay = document.getElementById("downloadProgressOverlay");
const downloadProgressText = document.getElementById("downloadProgressText");
const downloadProgressFill = document.getElementById("downloadProgressFill");
const cancelDownloadBtn = document.getElementById("cancelDownloadBtn");
const markerColorInput = document.getElementById("markerColorInput");
const markerShapeOptions = Array.from(document.querySelectorAll(".marker-shape-option"));
const routeColorInput = document.getElementById("routeColorInput");
const routeWidthInput = document.getElementById("routeWidthInput");
const routeWidthValue = document.getElementById("routeWidthValue");
const routeOpacityInput = document.getElementById("routeOpacityInput");
const routeOpacityValue = document.getElementById("routeOpacityValue");
const resetDisplaySettingsBtn = document.getElementById("resetDisplaySettingsBtn");
const resetIconPositionsBtn = document.getElementById("resetIconPositionsBtn");
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

function drawRoute(skipFitBounds) {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (routeLatLngs.length === 0) return;
  routeLine = L.polyline(routeLatLngs, { color: displaySettings.routeColor, weight: displaySettings.routeWidth, opacity: displaySettings.routeOpacity }).addTo(map);
  if (!skipFitBounds) map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
}

// 2地点間の方位角(度、北=0、時計回り)を計算
function calcBearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ルートの進行方向を示す小さな矢印を、間隔を空けて控えめに表示する（邪魔にならない程度の本数・透過度）
function renderRouteDirectionArrows() {
  routeDirectionMarkers.forEach(m => map.removeLayer(m));
  routeDirectionMarkers = [];
  if (routePoints.length < 2) return;

  const totalDist = routePoints[routePoints.length - 1].dist;
  if (!totalDist || totalDist <= 0) return;
  // ルート全長に応じて間隔を調整し、矢印が密集しすぎないようにする（最大40本程度を目安）
  const spacingKm = Math.max(2, totalDist / 40);

  let nextTargetDist = spacingKm;
  for (let i = 1; i < routePoints.length; i++) {
    if (routePoints[i].dist < nextTargetDist) continue;
    const prev = routePoints[i - 1], cur = routePoints[i];
    const bearing = calcBearing(prev.lat, prev.lon, cur.lat, cur.lon);
    const icon = L.divIcon({
      className: "route-direction-arrow-wrapper",
      html: `<div class="route-direction-arrow" style="transform: rotate(${bearing}deg);"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });
    const marker = L.marker([cur.lat, cur.lon], { icon, interactive: false, keyboard: false }).addTo(map);
    routeDirectionMarkers.push(marker);
    nextTargetDist += spacingKm;
  }
}

// ===== 地図の表示位置（中心座標・ズームレベル）の保持 =====
// MAIN画面⇔地図画面を行き来した際に、毎回ルート全体表示に戻ってしまわないよう、
// 直前の表示位置をlocalStorageに保存し、次回はそれを復元する。
function saveMapViewState() {
  if (!map) return;
  try {
    const center = map.getCenter();
    localStorage.setItem("mapViewState", JSON.stringify({ lat: center.lat, lng: center.lng, zoom: map.getZoom() }));
  } catch (e) {}
}
function loadMapViewState() {
  try {
    const raw = localStorage.getItem("mapViewState");
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (typeof state.lat === "number" && typeof state.lng === "number" && typeof state.zoom === "number") return state;
  } catch (e) {}
  return null;
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
  markerShapeOptions.forEach(btn => btn.classList.toggle("selected", btn.dataset.shape === displaySettings.markerShape));
}
function applyDisplaySettingsToMap() {
  document.documentElement.style.setProperty("--marker-color", displaySettings.markerColor);
  document.documentElement.style.setProperty("--route-arrow-color", displaySettings.routeColor);
  if (routeLine) routeLine.setStyle({ color: displaySettings.routeColor, weight: displaySettings.routeWidth, opacity: displaySettings.routeOpacity });
  if (currentMarker) currentMarker.setIcon(buildCurrentMarkerIcon());
}

markerColorInput.addEventListener("input", () => {
  displaySettings.markerColor = markerColorInput.value;
  applyDisplaySettingsToMap(); saveDisplaySettings();
});
markerShapeOptions.forEach(btn => {
  btn.addEventListener("click", () => {
    displaySettings.markerShape = btn.dataset.shape;
    applyDisplaySettingsToUI(); applyDisplaySettingsToMap(); saveDisplaySettings();
  });
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
resetIconPositionsBtn.addEventListener("click", () => {
  resetFloatingIconPositions();
  alert("地図上アイコンの位置を初期状態に戻しました。");
});

// ===== 地図上に浮かぶアイコン/ボタン群の長押しフリー移動（汎用） =====
const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 8;
const draggableRegistry = []; // resize時の一括再クランプ・初期化用にまとめて保持

function clampPosition(el, left, top) {
  const rect = el.getBoundingClientRect();
  const w = rect.width || 44, h = rect.height || 44;
  const maxLeft = window.innerWidth - w - 4;
  const maxTop = window.innerHeight - h - 4;
  return { left: Math.min(Math.max(4, left), Math.max(4, maxLeft)), top: Math.min(Math.max(4, top), Math.max(4, maxTop)) };
}

// el: 対象要素（単体ボタンでも、複数ボタンをまとめたラッパーでも可）
// storageKey: 位置保存用のlocalStorageキー
// onTap: 長押し(ドラッグ)に至らなかった通常タップ時に呼ぶコールバック（任意）
function makeFloatingDraggable(el, storageKey, onTap) {
  function applyPos(left, top) {
    el.style.right = "auto";
    el.style.transform = "none";
    el.style.left = left + "px";
    el.style.top = top + "px";
  }
  function restore() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const pos = JSON.parse(raw);
      if (typeof pos.left !== "number" || typeof pos.top !== "number") return;
      const clamped = clampPosition(el, pos.left, pos.top);
      applyPos(clamped.left, clamped.top);
    } catch (e) {}
  }
  function reset() {
    localStorage.removeItem(storageKey);
    el.style.left = ""; el.style.top = ""; el.style.right = ""; el.style.transform = "";
  }
  function reclamp() {
    if (el.style.left && el.style.left !== "auto") {
      const rect = el.getBoundingClientRect();
      const clamped = clampPosition(el, rect.left, rect.top);
      applyPos(clamped.left, clamped.top);
    }
  }

  let suppressClick = false;
  el.addEventListener("pointerdown", (e) => {
    const startX = e.clientX, startY = e.clientY;
    let moved = false, dragging = false, elStartLeft = 0, elStartTop = 0;

    const longPressTimer = setTimeout(() => {
      if (moved) return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      elStartLeft = rect.left; elStartTop = rect.top;
      applyPos(elStartLeft, elStartTop);
      el.classList.add("dragging");
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) {} }
    }, LONG_PRESS_MS);

    function onMove(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && (Math.abs(dx) > MOVE_CANCEL_PX || Math.abs(dy) > MOVE_CANCEL_PX)) {
        moved = true;
        if (!dragging) clearTimeout(longPressTimer);
      }
      if (dragging) {
        ev.preventDefault();
        const clamped = clampPosition(el, elStartLeft + dx, elStartTop + dy);
        applyPos(clamped.left, clamped.top);
      }
    }
    function onUp() {
      clearTimeout(longPressTimer);
      if (dragging) {
        dragging = false;
        suppressClick = true;
        el.classList.remove("dragging");
        const rect = el.getBoundingClientRect();
        localStorage.setItem(storageKey, JSON.stringify({ left: rect.left, top: rect.top }));
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });

  if (onTap) {
    el.addEventListener("click", () => {
      if (suppressClick) { suppressClick = false; return; }
      onTap();
    });
  }

  draggableRegistry.push({ reclamp, restore, reset });
  return { restore, reset };
}

window.addEventListener("resize", () => { draggableRegistry.forEach(d => d.reclamp()); });

function restoreFloatingIconPositions() { draggableRegistry.forEach(d => d.restore()); }
function resetFloatingIconPositions() {
  draggableRegistry.forEach(d => d.reset());
}

// ----- ズームボタン（2個セット） -----
const centerZoomControls = document.querySelector(".center-zoom-controls");
let suppressZoomBtnClick = false;
zoomInBtn.addEventListener("click", () => { if (suppressZoomBtnClick) { suppressZoomBtnClick = false; return; } map.zoomIn(); });
zoomOutBtn.addEventListener("click", () => { if (suppressZoomBtnClick) { suppressZoomBtnClick = false; return; } map.zoomOut(); });
makeFloatingDraggable(centerZoomControls, "mapZoomBtnPos", null);

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
  orientationModeBtn.title = mode === "heading" ? "地図の向き：進行方向が上（タップで北が上に切替）" : "地図の向き：北が上（タップで進行方向が上に切替）";
  if (mode === "north") {
    map.dragging.enable();
    applyMapRotation(0);
  } else {
    // 進行方向不明（停止中など）の間は北上のまま、headingが得られたら回転を適用する
    map.dragging.disable();
  }
}

makeFloatingDraggable(orientationModeBtn, "mapOrientationBtnPos", () => {
  setOrientationMode(mapOrientationMode === "north" ? "heading" : "north");
});

// ===== 現在地マーカーのアイコン生成（形状：矢印／丸／自転車／ピンから選択可能） =====
function buildCurrentMarkerIcon() {
  const shape = displaySettings.markerShape || "arrow";
  let html, size, anchor;
  if (shape === "circle") {
    html = '<div class="current-location-circle"></div>';
    size = [18, 18]; anchor = [9, 9];
  } else if (shape === "bike") {
    html = '<div class="current-location-emoji">🚲</div>';
    size = [26, 26]; anchor = [13, 18];
  } else if (shape === "pin") {
    html = '<div class="current-location-emoji">📍</div>';
    size = [26, 26]; anchor = [13, 24];
  } else {
    html = '<div class="current-location-arrow-outer"><div class="arrow-shape"></div></div>';
    size = [26, 26]; anchor = [13, 13];
  }
  return L.divIcon({ className: "current-location-wrapper", html, iconSize: size, iconAnchor: anchor });
}

// ===== 現在地マーカー（進行方向矢印付き） =====
function updateCurrentMarker(lat, lon, headingDeg) {
  const latlng = [lat, lon];
  if (!currentMarker) {
    currentMarker = L.marker(latlng, { icon: buildCurrentMarkerIcon(), zIndexOffset: 1000 }).addTo(map);
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
      notifyOffRouteIfNeeded(false);
    } else {
      setStatus("ルートから離れています");
      notifyOffRouteIfNeeded(true);
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
  if (!("wakeLock" in navigator)) { wakeLockEnabled = false; updateWakeLockToggleUI(); return; }
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockEnabled = true;
    wakeLockSentinel.addEventListener("release", () => { wakeLockEnabled = false; updateWakeLockToggleUI(); });
  } catch (e) {
    wakeLockEnabled = false;
  }
  updateWakeLockToggleUI();
}
function releaseWakeLock() {
  if (wakeLockSentinel) { wakeLockSentinel.release().catch(() => {}); wakeLockSentinel = null; }
  wakeLockEnabled = false;
  updateWakeLockToggleUI();
}
function updateWakeLockToggleUI() {
  wakeLockToggle.checked = wakeLockEnabled;
}
wakeLockToggle.addEventListener("change", () => {
  localStorage.setItem("wakeLockPreferred", String(wakeLockToggle.checked));
  if (wakeLockToggle.checked) requestWakeLock(); else releaseWakeLock();
});
// 画面が再びアクティブになった際（バックグラウンドから復帰等）、希望がONならWake Lockを再取得する
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && localStorage.getItem("wakeLockPreferred") !== "false" && !wakeLockEnabled) {
    requestWakeLock();
  }
});


// ===== 地図の手動操作でフォロー解除 =====
function setFollowMode(on) {
  followMode = on;
  recenterBtn.style.display = on ? "none" : "flex";
}

// ===== 戻るボタン =====
// フォルダ配置を固定（BRM-main / BRM-map が兄弟フォルダ）としているため、
// 履歴の有無に依存せず、常に直接アドレスへ遷移する。
backBtn.addEventListener("click", () => {
  stopContinuousGps();
  releaseWakeLock();
  saveMapViewState();
  window.location.href = "../BRM-main/index.html";
});

makeFloatingDraggable(recenterBtn, "mapRecenterBtnPos", () => {
  setFollowMode(true);
  if (currentMarker) map.setView(currentMarker.getLatLng(), map.getZoom(), { animate: true });
});

// ===== 初期化 =====
function initMap() {
  loadDisplaySettings();
  applyDisplaySettingsToUI();
  document.documentElement.style.setProperty("--marker-color", displaySettings.markerColor);
  document.documentElement.style.setProperty("--route-arrow-color", displaySettings.routeColor);
  loadOffRouteSoundSetting();
  restoreFloatingIconPositions();

  map = L.map("map", { zoomControl: false, attributionControl: true }).setView([35.681, 139.767], 13);
  const offlineLayer = new OfflineTileLayer({
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
  offlineLayer.addTo(map);

  map.on("dragstart", () => setFollowMode(false));

  const hasRoute = loadRouteFromLocalStorage();
  const savedView = loadMapViewState();
  if (hasRoute) {
    drawRoute(!!savedView); // 保存済みの表示位置がある場合は、ルート全体表示への自動fitを行わない
    renderPcShopMarkers();
    setStatus(`ルート読込済（全長 ${routePoints[routePoints.length - 1].dist.toFixed(1)}km）`);
  } else {
    setStatus("ルート未読込（BRM PACE MANAGER側でGPXを読込んでください）");
  }
  if (savedView) {
    map.setView([savedView.lat, savedView.lng], savedView.zoom, { animate: false });
  }

  startContinuousGps();
  if (localStorage.getItem("wakeLockPreferred") !== "false") requestWakeLock();
  renderRouteDirectionArrows();
}

// Service Worker登録（対応環境のみ。アプリ本体ファイルをオフラインキャッシュし、次回以降はネット接続なしでも起動できるようにする）
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

initMap();

// 音通知のブラウザ自動再生制限を回避するため、最初のタップでAudioContextを初期化/再開しておく
document.addEventListener("pointerdown", function unlockAudioOnce() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
  document.removeEventListener("pointerdown", unlockAudioOnce);
}, { once: true });

// ページを離れる際はGPS・WakeLockを確実に解放してバッテリーを保護する
window.addEventListener("pagehide", () => { saveMapViewState(); stopContinuousGps(); releaseWakeLock(); });
