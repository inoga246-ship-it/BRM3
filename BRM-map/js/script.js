// ===== 定数 =====
const TILE_SUBDOMAINS = ["a", "b", "c"];
const TILE_CACHE_NAME = "brm-map-tiles-v1";
const DOWNLOAD_ZOOM_LEVELS = [13, 14, 15, 16]; // ダウンロード対象のズームレベル
const ROUTE_BUFFER_TILES = 1; // ルート沿いの各タイルの周囲(隣接タイル数)もまとめてダウンロード
const DOWNLOAD_CONCURRENCY = 8; // 同時ダウンロード数（速度と負荷のバランス）
const GPS_SEARCH_WINDOW_KM = 8;   // 直前にマッチした距離から±この範囲内のみを探索（往復ルートの取り違え防止）
const GPS_MAX_MATCH_DIST_KM = 0.3; // 最も近い点でも300m以上離れている場合は信頼しない

// ===== 状態 =====
let map = null;
let routeLatLngs = [];   // [[lat,lon], ...] 表示用
let routePoints = [];    // [{lat, lon, dist}, ...] 距離マッチング用
let routeLine = null;
let passedLine = null;  // 通過済み区間（グレー）
let aheadLine = null;   // 未通過区間（設定色）
let routeDirectionMarkers = [];
let currentMarker = null;
let pcMarkers = [];
let shopMarkers = [];
let pcList = [];   // [{dist, label}, ...] ヘッダーの「次のPCまでの距離」計算にも使う
let shopList = []; // [{dist, label}, ...] ヘッダーの「次のコンビニまでの距離」計算にも使う
let followMode = true;
let watchId = null;
let wakeLockSentinel = null;
let wakeLockEnabled = false;
let lastMatchedDist = null;
let maxMatchedDist = 0;  // 通過済み表示（グレー）用の最大到達距離（後退しても縮まない）
let hasElevationData = false;  // ルートに標高(ele)データが含まれているか
let downloadCancelled = false;
let isDownloading = false;
let mapOrientationMode = "north"; // "north"（北が上） | "heading"（進行方向が上）
let currentRotationDeg = 0; // 現在の地図回転角（heading-upモード用）

// 瞬間速度の計算に使う直近のGPS履歴
let gpsHistory = []; // [{lat, lon, time}] 直近GPS点の履歴
const GPS_SPEED_WINDOW_SEC = 30; // 直近何秒分のGPS点で速度を計算するか

// ルート逸脱通知（音）：逸脱した瞬間に1回、その後は一定間隔で再通知する（鳴り続けて煩わしくならないように抑制）
let audioCtx = null;
let lastOffRouteAlertTime = 0;
let wasOffRoute = false;
const OFF_ROUTE_ALERT_INTERVAL_MS = 30000; // 再通知の間隔（30秒）
let offRouteSoundEnabled = true;
const offRouteSoundToggle = document.getElementById("offRouteSoundToggle");

// ===== ヘッダー2段目の表示項目管理 =====
// HDR2_ITEMSはDOM参照(hdr2SpeedToggle等)がすべて確定した後に定義する
let HDR2_ITEMS;
function initHdr2Items() {
  HDR2_ITEMS = [
    { toggle: hdr2SpeedToggle, el: hdr2Speed, sep: ".hdr2-speed-sep", key: "hdr2Speed" },
    { toggle: hdr2ElapsedToggle, el: hdr2Elapsed, sep: ".hdr2-elapsed-sep", key: "hdr2Elapsed" },
    { toggle: hdr2RemainTimeToggle, el: hdr2RemainTime, sep: ".hdr2-remaintime-sep", key: "hdr2RemainTime" },
    { toggle: hdr2NeedToggle, el: hdr2Need, sep: ".hdr2-need-sep", key: "hdr2Need" },
    { toggle: hdr2SavingToggle, el: hdr2Saving, sep: ".hdr2-saving-sep", key: "hdr2Saving" },
    { toggle: hdr2PcToggle, el: hdr2Pc, sep: ".hdr2-pc-sep", key: "hdr2Pc" },
    { toggle: hdr2ShopToggle, el: hdr2Shop, sep: null, key: "hdr2Shop" },
  ];
}

function saveHdr2Settings() {
  const obj = {};
  HDR2_ITEMS.forEach(item => { obj[item.key] = item.toggle.checked; });
  localStorage.setItem("mapHdr2Settings", JSON.stringify(obj));
}
function loadHdr2Settings() {
  try {
    const raw = localStorage.getItem("mapHdr2Settings");
    if (!raw) return;
    const obj = JSON.parse(raw);
    HDR2_ITEMS.forEach(item => { if (obj[item.key] !== undefined) item.toggle.checked = !!obj[item.key]; });
  } catch (e) {}
}
function applyHdr2Visibility() {
  HDR2_ITEMS.forEach(item => {
    item.el.style.display = item.toggle.checked ? "inline-flex" : "none";
  });
  // 各セパレータはDOM上でitem[idx]の直後・item[idx+1]の直前にあるため、その両隣が表示されている時だけ表示する
  HDR2_ITEMS.forEach((item, idx) => {
    if (!item.sep) return;
    const sepEl = headerRow2.querySelector(item.sep);
    if (!sepEl) return;
    const leftVisible = item.toggle.checked;
    const rightVisible = (idx + 1 < HDR2_ITEMS.length) && HDR2_ITEMS[idx + 1].toggle.checked;
    sepEl.style.display = (leftVisible && rightVisible) ? "inline" : "none";
  });
  const anyVisible = HDR2_ITEMS.some(i => i.toggle.checked);
  headerRow2.style.display = anyVisible ? "flex" : "none";
}
function setupHdr2Listeners() {
  HDR2_ITEMS.forEach(item => {
    item.toggle.addEventListener("change", () => { applyHdr2Visibility(); saveHdr2Settings(); });
  });
}

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
const headerGross = document.getElementById("headerGross");
const headerRemain = document.getElementById("headerRemain");
const headerRow2 = document.getElementById("headerRow2");
const hdr2Speed = document.getElementById("hdr2Speed");
const hdr2Elapsed = document.getElementById("hdr2Elapsed");
const hdr2RemainTime = document.getElementById("hdr2RemainTime");
const hdr2Need = document.getElementById("hdr2Need");
const hdr2Saving = document.getElementById("hdr2Saving");
const hdr2Pc = document.getElementById("hdr2Pc");
const hdr2Shop = document.getElementById("hdr2Shop");
const hdr2SpeedVal = document.getElementById("hdr2SpeedVal");
const hdr2ElapsedVal = document.getElementById("hdr2ElapsedVal");
const hdr2RemainTimeVal = document.getElementById("hdr2RemainTimeVal");
const hdr2NeedVal = document.getElementById("hdr2NeedVal");
const hdr2SavingVal = document.getElementById("hdr2SavingVal");
const hdr2PcVal = document.getElementById("hdr2PcVal");
const hdr2ShopVal = document.getElementById("hdr2ShopVal");
const hdr2SpeedToggle = document.getElementById("hdr2SpeedToggle");
const hdr2ElapsedToggle = document.getElementById("hdr2ElapsedToggle");
const hdr2RemainTimeToggle = document.getElementById("hdr2RemainTimeToggle");
const hdr2NeedToggle = document.getElementById("hdr2NeedToggle");
const hdr2SavingToggle = document.getElementById("hdr2SavingToggle");
const hdr2PcToggle = document.getElementById("hdr2PcToggle");
const hdr2ShopToggle = document.getElementById("hdr2ShopToggle");
const layerRouteToggle = document.getElementById("layerRouteToggle");
const layerArrowToggle = document.getElementById("layerArrowToggle");
const layerPcToggle = document.getElementById("layerPcToggle");
const layerShopToggle = document.getElementById("layerShopToggle");
const layerElevToggle = document.getElementById("layerElevToggle");
const elevationPanel = document.getElementById("elevationPanel");
const elevationSvg = document.getElementById("elevationSvg");
const elevMinLabel = document.getElementById("elevMinLabel");
const elevMaxLabel = document.getElementById("elevMaxLabel");
const elevCurLabel = document.getElementById("elevCurLabel");
const elevFromLabel = document.getElementById("elevFromLabel");
const elevToLabel = document.getElementById("elevToLabel");
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
    routePoints = points.map(p => {
      const eleRaw = p.ele !== undefined ? p.ele : (p.elevation !== undefined ? p.elevation : (p.alt !== undefined ? p.alt : (p.altitude !== undefined ? p.altitude : null)));
      const ele = eleRaw === null || eleRaw === undefined || eleRaw === "" ? null : parseFloat(eleRaw);
      return { lat: p.lat, lon: p.lon, dist: p.dist, ele: (ele === null || isNaN(ele)) ? null : ele };
    });
    routeLatLngs = routePoints.map(p => [p.lat, p.lon]);
    hasElevationData = routePoints.some(p => p.ele !== null);
    return true;
  } catch (e) { return false; }
}

function drawRoute(skipFitBounds) {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (passedLine) { map.removeLayer(passedLine); passedLine = null; }
  if (aheadLine) { map.removeLayer(aheadLine); aheadLine = null; }
  if (routeLatLngs.length === 0) return;
  // 初期描画は全区間を未通過色で1本描く（通過距離が0のため）
  aheadLine = L.polyline(routeLatLngs, { color: displaySettings.routeColor, weight: displaySettings.routeWidth, opacity: displaySettings.routeOpacity }).addTo(map);
  routeLine = aheadLine; // fitBounds用の参照として保持
  if (!skipFitBounds) map.fitBounds(aheadLine.getBounds(), { padding: [30, 30] });
}

// GPS位置が更新されるたびに通過済み区間（グレー）と未通過区間（設定色）に分割して再描画する
function updatePassedLine(currentDistKm) {
  if (routePoints.length === 0 || !currentDistKm || currentDistKm <= 0) return;

  // 現在距離に最も近いルート点のインデックスを探す
  let splitIdx = 0;
  for (let i = 0; i < routePoints.length; i++) {
    if (routePoints[i].dist <= currentDistKm) splitIdx = i;
    else break;
  }

  const passedLatLngs = routeLatLngs.slice(0, splitIdx + 1);
  const aheadLatLngs = routeLatLngs.slice(splitIdx);

  if (passedLine) map.removeLayer(passedLine);
  if (aheadLine) map.removeLayer(aheadLine);

  if (passedLatLngs.length >= 2) {
    passedLine = L.polyline(passedLatLngs, {
      color: "#6b7280",
      weight: displaySettings.routeWidth,
      opacity: 0.55
    }).addTo(map);
  }
  if (aheadLatLngs.length >= 1) {
    aheadLine = L.polyline(aheadLatLngs, {
      color: displaySettings.routeColor,
      weight: displaySettings.routeWidth,
      opacity: displaySettings.routeOpacity
    }).addTo(map);
  }
}

// ===== 標高グラフ（現在地の手前1km〜先9kmを表示し、GPS位置と連動して自動スクロール） =====
const ELEV_BEHIND_KM = 1;
const ELEV_AHEAD_KM = 9;

function renderElevationProfile(currentDistKm) {
  if (!layerElevToggle.checked || !hasElevationData || routePoints.length < 2 || currentDistKm === null || currentDistKm === undefined) {
    elevationPanel.style.display = "none";
    return;
  }

  const totalDist = routePoints[routePoints.length - 1].dist;
  let fromDist = currentDistKm - ELEV_BEHIND_KM;
  let toDist = currentDistKm + ELEV_AHEAD_KM;
  // ルートの端では表示幅を保ったままウィンドウをスライドさせる（グラフの見た目の幅を一定に保つ）
  if (fromDist < 0) { toDist -= fromDist; fromDist = 0; }
  if (toDist > totalDist) { fromDist -= (toDist - totalDist); toDist = totalDist; }
  fromDist = Math.max(0, fromDist);

  // 表示範囲内の点を抽出（前後1点余分に含めて線を範囲端まで届かせる）
  let startIdx = routePoints.findIndex(p => p.dist >= fromDist);
  if (startIdx === -1) startIdx = 0;
  if (startIdx > 0) startIdx -= 1;
  let endIdx = startIdx;
  while (endIdx < routePoints.length - 1 && routePoints[endIdx].dist < toDist) endIdx++;

  const windowPoints = routePoints.slice(startIdx, endIdx + 1).filter(p => p.ele !== null);
  if (windowPoints.length < 2) {
    elevationPanel.style.display = "none";
    return;
  }

  let minEle = Infinity, maxEle = -Infinity;
  windowPoints.forEach(p => { if (p.ele < minEle) minEle = p.ele; if (p.ele > maxEle) maxEle = p.ele; });
  if (minEle === maxEle) { minEle -= 5; maxEle += 5; } // 平坦区間でも山なりに潰れないよう余白を確保

  const padY = (maxEle - minEle) * 0.12;
  const eleTop = maxEle + padY;
  const eleBottom = minEle - padY;

  const VBW = 1000, VBH = 100;
  const xOf = (d) => ((d - fromDist) / (toDist - fromDist)) * VBW;
  const yOf = (e) => VBH - ((e - eleBottom) / (eleTop - eleBottom)) * VBH;

  const linePts = windowPoints.map(p => `${xOf(p.dist).toFixed(1)},${yOf(p.ele).toFixed(1)}`);
  const areaPts = `0,${VBH} ${linePts.join(" ")} ${VBW},${VBH}`;

  // 現在地の標高（ウィンドウ内で最も近い点から線形補間）
  let curEle = null;
  for (let i = 0; i < windowPoints.length - 1; i++) {
    const a = windowPoints[i], b = windowPoints[i + 1];
    if (currentDistKm >= a.dist && currentDistKm <= b.dist) {
      const t = b.dist === a.dist ? 0 : (currentDistKm - a.dist) / (b.dist - a.dist);
      curEle = a.ele + (b.ele - a.ele) * t;
      break;
    }
  }
  if (curEle === null) curEle = windowPoints[windowPoints.length - 1].ele;
  const curX = xOf(currentDistKm);
  const curY = yOf(curEle);

  elevationSvg.innerHTML =
    `<polygon points="${areaPts}" fill="rgba(0, 210, 255, 0.18)"></polygon>` +
    `<polyline points="${linePts.join(" ")}" fill="none" stroke="#00d2ff" stroke-width="2" vector-effect="non-scaling-stroke"></polyline>` +
    `<line x1="${curX.toFixed(1)}" y1="0" x2="${curX.toFixed(1)}" y2="${VBH}" stroke="#ffcc00" stroke-width="1.5" stroke-dasharray="4,3" vector-effect="non-scaling-stroke"></line>` +
    `<circle cx="${curX.toFixed(1)}" cy="${curY.toFixed(1)}" r="4" fill="#ffcc00" stroke="#04222b" stroke-width="1.5"></circle>`;

  elevMinLabel.textContent = `${Math.round(minEle)}m`;
  elevMaxLabel.textContent = `${Math.round(maxEle)}m`;
  elevCurLabel.textContent = `現在 ${Math.round(curEle)}m`;
  elevFromLabel.textContent = fromDist <= 0 ? "0km" : `${(currentDistKm - fromDist).toFixed(1)}km手前`;
  elevToLabel.textContent = toDist >= totalDist ? `${totalDist.toFixed(1)}km（終点）` : `${(toDist - currentDistKm).toFixed(1)}km先`;

  elevationPanel.style.display = "";
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

  // 現在のズームレベルから「画面に映るおおよその距離(km)」を算出する
  // Leafletのズームレベルは1段階ごとに縮尺が2倍になる。zoom13≒画面幅10km前後を基準に計算。
  const zoom = map.getZoom();
  // zoom16で画面幅約0.6km程度を基準に計算（zoom13≒10km、1段階ごとに1/2）
  const approxScreenWidthKm = 10 * Math.pow(2, 13 - zoom);
  // 画面内に3〜4本表示されるよう間隔を設定
  const spacingKm = Math.max(0.05, approxScreenWidthKm / 3.5);

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
    localStorage.setItem("mapViewState", JSON.stringify({ lat: center.lat, lng: center.lng, zoom: map.getZoom(), orientationMode: mapOrientationMode }));
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

  const pcList2 = parseSimpleList(localStorage.getItem("pcList3") || "", true);
  const shopList2 = parseSimpleList(localStorage.getItem("shopList3") || "", false);
  pcList = pcList2;
  shopList = shopList2;

  pcList2.forEach(item => {
    const latlon = findLatLonAtDistance(item.dist);
    if (!latlon) return;
    const icon = L.divIcon({ className: "pc-marker-icon", html: `<div class="pc-marker-dot">${escapeHtml(item.label).slice(0, 8)}</div>`, iconSize: [0, 0] });
    const marker = L.marker(latlon, { icon }).bindPopup(`${escapeHtml(item.label)}（${item.dist.toFixed(1)}km）`);
    marker.addTo(map);
    pcMarkers.push(marker);
  });

  shopList2.forEach(item => {
    const latlon = findLatLonAtDistance(item.dist);
    if (!latlon) return;
    const icon = L.divIcon({ className: "shop-marker-icon", html: `<div class="shop-marker-dot">🏪</div>`, iconSize: [0, 0] });
    const marker = L.marker(latlon, { icon }).bindPopup(`${escapeHtml(item.label)}（${item.dist.toFixed(1)}km）`);
    marker.addTo(map);
    shopMarkers.push(marker);
  });
}

// 現在距離(currentDistKm)より先にある最も近い地点までの残り距離(km)を返す（無ければnull）
function getNextPointRemainKm(list, currentDistKm) {
  if (!list || list.length === 0 || currentDistKm === null || currentDistKm === undefined) return null;
  let nearestDist = null;
  list.forEach(item => {
    if (item.dist >= currentDistKm - 0.05 && (nearestDist === null || item.dist < nearestDist)) {
      nearestDist = item.dist;
    }
  });
  if (nearestDist === null) return null;
  return Math.max(0, nearestDist - currentDistKm);
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
  if (aheadLine) aheadLine.setStyle({ color: displaySettings.routeColor, weight: displaySettings.routeWidth, opacity: displaySettings.routeOpacity });
  if (passedLine) passedLine.setStyle({ weight: displaySettings.routeWidth });
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

// ===== レイヤー表示ON/OFFトグル =====
function applyLayerVisibility() {
  // ルート線
  if (routeLine) { routeLine.getElement && (routeLine.getElement() ? routeLine.getElement().style.display = layerRouteToggle.checked ? "" : "none" : null); if (!layerRouteToggle.checked) { if (routeLine) map.removeLayer(routeLine); routeLine = null; } else if (!routeLine && routeLatLngs.length > 0) { drawRoute(true); } }
  // ルート線の表示/非表示はaddLayer/removeLayerでないと確実に反映されないため、より確実な方法を使う
}

function setLayerVisible(markers, visible) {
  markers.forEach(m => { const el = m.getElement ? m.getElement() : null; if (el) el.style.display = visible ? "" : "none"; });
}

layerRouteToggle.addEventListener("change", () => {
  localStorage.setItem("layerRoute", layerRouteToggle.checked);
  if (layerRouteToggle.checked) { if (!routeLine && routeLatLngs.length > 0) drawRoute(true); }
  else { if (routeLine) { map.removeLayer(routeLine); routeLine = null; } }
});
layerArrowToggle.addEventListener("change", () => {
  localStorage.setItem("layerArrow", layerArrowToggle.checked);
  if (layerArrowToggle.checked) { if (routeDirectionMarkers.length === 0 && routePoints.length > 0) renderRouteDirectionArrows(); else setLayerVisible(routeDirectionMarkers, true); }
  else { setLayerVisible(routeDirectionMarkers, false); }
});
layerPcToggle.addEventListener("change", () => {
  localStorage.setItem("layerPc", layerPcToggle.checked);
  if (layerPcToggle.checked) { if (pcMarkers.length === 0 && routePoints.length > 0) renderPcShopMarkers(); else setLayerVisible(pcMarkers, true); }
  else { setLayerVisible(pcMarkers, false); }
});
layerShopToggle.addEventListener("change", () => {
  localStorage.setItem("layerShop", layerShopToggle.checked);
  if (layerShopToggle.checked) { if (shopMarkers.length === 0 && routePoints.length > 0) renderPcShopMarkers(); else setLayerVisible(shopMarkers, true); }
  else { setLayerVisible(shopMarkers, false); }
});
layerElevToggle.addEventListener("change", () => {
  localStorage.setItem("layerElev", layerElevToggle.checked);
  if (layerElevToggle.checked) { renderElevationProfile(lastMatchedDist); }
  else { elevationPanel.style.display = "none"; }
});
// レイヤーのON/OFF設定をlocalStorageから復元する
function loadLayerSettings() {
  const load = (key, toggle, defaultVal) => {
    const raw = localStorage.getItem(key);
    toggle.checked = raw === null ? defaultVal : raw === "true";
  };
  load("layerRoute", layerRouteToggle, true);
  load("layerArrow", layerArrowToggle, true);
  load("layerPc", layerPcToggle, true);
  load("layerShop", layerShopToggle, true);
  load("layerElev", layerElevToggle, true);
}

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
  // 長押しで出るOSのコンテキストメニュー（コピー・共有など）を抑制する
  el.addEventListener("contextmenu", (e) => e.preventDefault());

  function applyPos(left, top) {
    el.style.right = "auto";
    el.style.transform = "none";
    el.style.bottom = "auto";
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
function applyMapRotation(headingDeg) {
  // headingDeg: GPSのheading（北=0、時計回り）。nullなら直前の値を維持。
  if (headingDeg !== null) currentRotationDeg = headingDeg;
  const h = currentRotationDeg;

  if (mapOrientationMode === "heading") {
    // 進行方向が上：地図をheading分だけ逆回転させる（heading方向が画面上部に来る）
    mapEl.style.transform = `rotate(${-h}deg)`;
    // 矢印は地図と一緒に逆回転するので、打ち消して常に上を向くよう0degに固定
    const outer = currentMarker && currentMarker.getElement() && currentMarker.getElement().querySelector(".current-location-arrow-outer");
    if (outer) outer.style.transform = `rotate(${h}deg)`;
  } else {
    // 北が上：地図は回転しない
    mapEl.style.transform = "rotate(0deg)";
    // 矢印はheading方向を向く（北=0=上、東=90=右など）
    const outer = currentMarker && currentMarker.getElement() && currentMarker.getElement().querySelector(".current-location-arrow-outer");
    if (outer) outer.style.transform = `rotate(${h}deg)`;
  }
}

function setOrientationMode(mode) {
  mapOrientationMode = mode;
  orientationModeBtn.classList.toggle("heading-mode", mode === "heading");
  orientationModeBtn.title = mode === "heading" ? "地図の向き：進行方向が上（タップで北が上に切替）" : "地図の向き：北が上（タップで進行方向が上に切替）";
  if (mode === "north") {
    map.dragging.enable();
    applyMapRotation(null); // 現在のheadingで矢印を向けつつ地図はnorth固定
  } else {
    map.dragging.disable();
    applyMapRotation(null); // 現在のheadingで地図を回転（heading不明なら現状維持）
  }
}

makeFloatingDraggable(orientationModeBtn, "mapOrientationBtnPos", () => {
  setOrientationMode(mapOrientationMode === "north" ? "heading" : "north");
});

// ===== 現在地マーカーのアイコン生成（形状：矢印／丸／自転車／ピンから選択可能） =====
// SVGで描く➡型の太矢印（進行方向が分かりやすいように先端が太く、胴が細い形状）
// 上が進行方向。rotate()で実際の方向に合わせて回転させる。
function buildArrowSvgHtml(size, color) {
  const c = color || "var(--marker-color)";
  const s = size || 32;
  // viewBox="-16 -16 32 32" で中心を(0,0)に設定。
  // 先端が上(y=-16)を向く矢印型パス
  return `<svg viewBox="-16 -16 32 32" width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg" overflow="visible">
    <path class="arrow-svg-outline" d="M0,-15 L10,8 L3,4 L3,14 L-3,14 L-3,4 L-10,8 Z" transform="scale(1.08)"/>
    <path class="arrow-svg-body" d="M0,-15 L10,8 L3,4 L3,14 L-3,14 L-3,4 L-10,8 Z" fill="${c}"/>
  </svg>`;
}

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
    html = `<div class="current-location-arrow-outer">${buildArrowSvgHtml(32)}</div>`;
    size = [32, 32]; anchor = [16, 16];
  }
  return L.divIcon({ className: "current-location-wrapper", html, iconSize: size, iconAnchor: anchor });
}

// ===== 現在地マーカー（進行方向矢印付き） =====
// FOLLOW_OFFSET_RATIO: 現在地を画面の何割下に配置するか（0=中央、0.3=中央より30%下）
const FOLLOW_OFFSET_RATIO = 0.12;

function getOffsetCenter(latlng) {
  // 北が上モードは中央に表示、進行方向が上モードのみ下寄りオフセットを適用する
  if (mapOrientationMode === "north") return latlng;

  const mapSize = map.getSize();
  const offsetPx = Math.round(mapSize.y * FOLLOW_OFFSET_RATIO);
  const markerPoint = map.latLngToContainerPoint(latlng);

  // heading-upモード（地図が回転中）のため、オフセット方向を回転角に合わせて補正する
  const rad = -currentRotationDeg * Math.PI / 180;
  const dx = Math.round(offsetPx * Math.sin(rad));
  const dy = Math.round(offsetPx * Math.cos(rad));
  const targetPoint = markerPoint.subtract([dx, dy]);
  return map.containerPointToLatLng(targetPoint);
}

function updateCurrentMarker(lat, lon, headingDeg) {
  const latlng = [lat, lon];
  if (!currentMarker) {
    currentMarker = L.marker(latlng, { icon: buildCurrentMarkerIcon(), zIndexOffset: 1000 }).addTo(map);
  } else {
    currentMarker.setLatLng(latlng);
  }
  if (followMode) {
    // 現在地が画面の下寄り（中央から28%下）に来るよう地図中心をオフセットして追従する
    const center = getOffsetCenter(latlng);
    map.setView(center, map.getZoom(), { animate: true });
  }

  if (mapOrientationMode === "heading") {
    if (headingDeg !== null && !isNaN(headingDeg)) {
      applyMapRotation(headingDeg);
    } else {
      applyMapRotation(null);
    }
  } else {
    applyMapRotation(headingDeg);
  }
}

// ===== GPS常時追従（地図モード表示中のみ。ページを離れたら停止する） =====
// ヘッダーとウィジェットのペース・速度表示を更新する
function updatePaceDisplay(latitude, longitude) {
  const now = Date.now();

  // 瞬間速度の計算：直近GPS_SPEED_WINDOW_SEC秒以内のGPS点との移動距離÷時間
  gpsHistory.push({ lat: latitude, lon: longitude, time: now });
  const cutoff = now - GPS_SPEED_WINDOW_SEC * 1000;
  gpsHistory = gpsHistory.filter(p => p.time >= cutoff);
  let instantSpeedKph = null;
  if (gpsHistory.length >= 2) {
    const oldest = gpsHistory[0], newest = gpsHistory[gpsHistory.length - 1];
    const distKm = calcHaversineDistance(oldest.lat, oldest.lon, newest.lat, newest.lon);
    const elapsedHour = (newest.time - oldest.time) / 3600000;
    if (elapsedHour > 0) instantSpeedKph = distKm / elapsedHour;
  }

  // グロス速度・残り距離の計算（BRM-mainとlocalStorageを共有）
  let grossKph = null, remainKm = null;
  try {
    const startTimeStr = localStorage.getItem("startTime");
    const brmVal = localStorage.getItem("brm") || "200,13.5";
    const targetDistance = parseFloat(brmVal.split(",")[0]) || 200;
    const currentDist = lastMatchedDist !== null ? lastMatchedDist : parseFloat(localStorage.getItem("distance") || "0") || 0;
    if (startTimeStr) {
      const start = new Date(startTimeStr);
      const elapsedHour = (now - start.getTime()) / 3600000;
      if (elapsedHour > 0 && currentDist > 0) grossKph = currentDist / elapsedHour;
    }
    remainKm = Math.max(0, targetDistance - (lastMatchedDist || 0));
  } catch (e) {}

  // ヘッダー更新（1段目）
  headerGross.innerText = grossKph !== null ? `G:${grossKph.toFixed(1)}km/h` : "G:--";
  headerRemain.innerText = remainKm !== null ? `残${remainKm.toFixed(1)}km` : "残--km";

  // ヘッダー2段目の各項目を更新（ON表示のものだけ値を計算）
  if (hdr2SpeedToggle.checked) {
    hdr2SpeedVal.innerText = instantSpeedKph !== null ? instantSpeedKph.toFixed(1) : "--";
  }
  if (hdr2PcToggle.checked) {
    const nextPcKm = getNextPointRemainKm(pcList, lastMatchedDist);
    hdr2PcVal.innerText = nextPcKm !== null ? nextPcKm.toFixed(1) : "--";
  }
  if (hdr2ShopToggle.checked) {
    const nextShopKm = getNextPointRemainKm(shopList, lastMatchedDist);
    hdr2ShopVal.innerText = nextShopKm !== null ? nextShopKm.toFixed(1) : "--";
  }
  try {
    const startTimeStr = localStorage.getItem("startTime");
    const brmVal2 = localStorage.getItem("brm") || "200,13.5";
    const [targetDist2, limitHour2] = brmVal2.split(",").map(Number);
    if (startTimeStr) {
      const start = new Date(startTimeStr);
      const elapsedMs = now - start.getTime();
      const elapsedHr = elapsedMs / 3600000;

      if (hdr2ElapsedToggle.checked) {
        const eh = Math.floor(elapsedHr), em = Math.floor((elapsedHr % 1) * 60);
        hdr2ElapsedVal.innerText = elapsedHr >= 0 ? `${eh}h${String(em).padStart(2,"0")}m` : "--";
      }
      if (hdr2RemainTimeToggle.checked) {
        const remainHr = limitHour2 - elapsedHr;
        if (remainHr >= 0) {
          const rh = Math.floor(remainHr), rm = Math.floor((remainHr % 1) * 60);
          hdr2RemainTimeVal.innerText = `${rh}h${String(rm).padStart(2,"0")}m`;
        } else {
          hdr2RemainTimeVal.innerText = "超過";
        }
      }
      if (hdr2NeedToggle.checked) {
        const remKm2 = Math.max(0, targetDist2 - (lastMatchedDist || 0));
        const remHr = limitHour2 - elapsedHr;
        hdr2NeedVal.innerText = (remHr > 0 && remKm2 > 0) ? (remKm2 / remHr).toFixed(1) : "--";
      }
      if (hdr2SavingToggle.checked && grossKph !== null) {
        const savingHr = limitHour2 - (targetDist2 / grossKph);
        const sign = savingHr >= 0 ? "+" : "-";
        const sh = Math.floor(Math.abs(savingHr)), sm = Math.floor((Math.abs(savingHr) % 1) * 60);
        hdr2SavingVal.innerText = `${sign}${sh}h${String(sm).padStart(2,"0")}m`;
      }
    }
  } catch (e) {}
}

function onGpsPosition(pos) {
  const { latitude, longitude, heading } = pos.coords;
  updateCurrentMarker(latitude, longitude, (heading === undefined ? null : heading));
  updatePaceDisplay(latitude, longitude);
  if (routePoints.length > 0) {
    const matched = matchPositionToRoute(latitude, longitude, lastMatchedDist);
    if (matched !== null) {
      lastMatchedDist = matched;
      // 通過済み（グレー）表示は最大到達距離を基準にする。同じ道を戻っても既にグレー化した区間がオレンジに戻らないようにするため。
      if (matched > maxMatchedDist) maxMatchedDist = matched;
      setStatus(`現在 ${matched.toFixed(1)} km地点`);
      try { localStorage.setItem("distance", matched.toFixed(1)); } catch (e) {}
      updatePassedLine(maxMatchedDist);
      renderElevationProfile(matched);
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
  if (currentMarker) {
    const center = getOffsetCenter(currentMarker.getLatLng());
    map.setView(center, map.getZoom(), { animate: true });
  }
});

// ===== 初期化 =====
function initMap() {
  loadDisplaySettings();
  applyDisplaySettingsToUI();
  document.documentElement.style.setProperty("--marker-color", displaySettings.markerColor);
  document.documentElement.style.setProperty("--route-arrow-color", displaySettings.routeColor);
  loadOffRouteSoundSetting();
  initHdr2Items();
  loadHdr2Settings();
  applyHdr2Visibility();
  setupHdr2Listeners();
  const arrowPreview = document.querySelector(".shape-preview-arrow");
  if (arrowPreview) arrowPreview.innerHTML = buildArrowSvgHtml(14);
  loadLayerSettings();
  restoreFloatingIconPositions();

  map = L.map("map", { zoomControl: false, attributionControl: true }).setView([35.681, 139.767], 16);
  const offlineLayer = new OfflineTileLayer({
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
  offlineLayer.addTo(map);

  map.on("dragstart", () => setFollowMode(false));
  map.on("zoomend", () => {
    if (layerArrowToggle.checked && routePoints.length >= 2) renderRouteDirectionArrows();
  });

  const hasRoute = loadRouteFromLocalStorage();
  const savedView = loadMapViewState();
  if (hasRoute) {
    drawRoute(!!savedView);
    renderPcShopMarkers();
    // レイヤー設定に応じて初期表示状態を適用
    if (!layerRouteToggle.checked && routeLine) { map.removeLayer(routeLine); routeLine = null; }
    if (!layerPcToggle.checked) setLayerVisible(pcMarkers, false);
    if (!layerShopToggle.checked) setLayerVisible(shopMarkers, false);
    setStatus(`ルート読込済（全長 ${routePoints[routePoints.length - 1].dist.toFixed(1)}km）`);
    const savedDist = parseFloat(localStorage.getItem("distance") || "");
    if (!isNaN(savedDist)) { lastMatchedDist = savedDist; maxMatchedDist = savedDist; updatePassedLine(maxMatchedDist); renderElevationProfile(savedDist); }
  } else {
    setStatus("ルート未読込（BRM PACE MANAGER側でGPXを読込んでください）");
  }
  if (savedView) {
    map.setView([savedView.lat, savedView.lng], savedView.zoom, { animate: false });
    if (savedView.orientationMode === "heading") {
      setOrientationMode("heading");
    }
  }

  startContinuousGps();
  if (localStorage.getItem("wakeLockPreferred") !== "false") requestWakeLock();

  if (layerArrowToggle.checked) renderRouteDirectionArrows();
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
