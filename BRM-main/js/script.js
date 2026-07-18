const brm = document.getElementById("brm");
const customLimitHours = document.getElementById("customLimitHours");
const startTime = document.getElementById("startTime");
const distance = document.getElementById("distance");
const pcInput = document.getElementById("pcInput");
const shopInput = document.getElementById("shopInput");
const menuTrigger = document.getElementById("menuTrigger");
const menuContent = document.getElementById("menuContent");
const menuCloseBtn = document.getElementById("menuCloseBtn");
const resetBtn = document.getElementById("resetBtn");
const shopToggle = document.getElementById("shopToggle");
const mapDblClickToggle = document.getElementById("mapDblClickToggle");
const shopCard = document.getElementById("shopCard");

const convenienceBtnToggle = document.getElementById("convenienceBtnToggle");
const convenienceBtnWrapper = document.getElementById("convenienceBtnWrapper");
const convenienceBtn = document.getElementById("convenienceBtn");
const topRowGrid = document.getElementById("topRowGrid");

const helpTrigger = document.getElementById("helpTrigger");
const helpModal = document.getElementById("helpModal");
const modalCloseBtn = document.getElementById("modalCloseBtn");

const pcPrevBtn = document.getElementById("pcPrevBtn");
const pcNextBtn = document.getElementById("pcNextBtn");
const pcRemainDist = document.getElementById("pcRemainDist");
const pcTitleRow = document.getElementById("pcTitleRow");

const shopPrevBtn = document.getElementById("shopPrevBtn");
const shopNextBtn = document.getElementById("shopNextBtn");
const shopRemainDist = document.getElementById("shopRemainDist");
const shopTitleRow = document.getElementById("shopTitleRow");

const graphBar = document.getElementById("graphBar");
const graphScale = document.getElementById("graphScale");
const elevationSvg = document.getElementById("elevationSvg");
const progressBarTrack = document.getElementById("progressBarTrack");
const gpsTrackBtn = document.getElementById("gpsTrackBtn");
const mapModeBtn = document.getElementById("mapModeBtn");

// 🗺️ 地図モード（BRM-map、同階層に配置する想定）への切り替え
// 実際のホスティング構成がこれと異なる場合は、このパスを実際の配置に合わせて調整してください。
mapModeBtn.addEventListener("click", () => {
  window.location.href = "../BRM-map/index.html";
});

// GPS距離取得（📍ボタンを押した時だけ1回だけ取得するワンショット方式。電池消耗を抑えるため常時監視はしない）
let gpsIsFetching = false;
let gpsLastMatchedDist = null; // 直前にマッチした距離（往復ルートでの誤判定を防ぐための連続性チェックに使用）
const GPS_SEARCH_WINDOW_KM = 8;   // 直前距離から±この範囲内の点のみを探索対象にする（往路/復路の取り違え防止）
const GPS_MAX_MATCH_DIST_KM = 0.3; // 最も近い点でも300m以上離れている場合は採用しない（コースアウト時の誤反映防止）

const saveName = document.getElementById("saveName");
const saveBtn = document.getElementById("saveBtn");
const savedListsSelect = document.getElementById("savedListsSelect");
const deleteBtn = document.getElementById("deleteBtn");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const importFileInput = document.getElementById("importFileInput");

// GPX関連の要素
const gpxBtn = document.getElementById("gpxBtn");
const gpxFileInput = document.getElementById("gpxFileInput");

const circleNumbers = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

const defaultPCList = "PC1, 御幸橋, 24.9km\nPC2, 山城大橋, 68.0km";
const defaultShopList = "ローソン 八幡南店, 32.1\nセブン 宇治川店, 50.4";

let globalPCList = [];   
let globalShopList = []; 
let gpxTrackPoints = []; // GPXから解析した全トラックポイント [{lat, lon, ele, dist, gain}]

// ===== BRM以外のイベントにも対応：目標距離・制限時間の取得 =====
// brm.value が "custom,0" の場合、GPXの実測距離を目標距離として使い、
// 制限時間はユーザーが customLimitHours に入力した値を使う。
// それ以外（通常のBRM選択）の場合は従来どおり "距離,制限時間" をパースする。
function getBrmTargetAndLimit() {
  const brmVal = brm.value || "200,13.5";
  if (brmVal.startsWith("custom")) {
    const targetDistance = gpxTrackPoints.length > 0
      ? gpxTrackPoints[gpxTrackPoints.length - 1].dist
      : 0;
    const limitHours = parseFloat(customLimitHours.value) || 0;
    return [targetDistance, limitHours];
  }
  return brmVal.split(",").map(Number);
}

// 「GPX距離を使用」選択時だけ制限時間の自由入力欄を表示する
function updateCustomLimitVisibility() {
  customLimitHours.style.display = brm.value.startsWith("custom") ? "block" : "none";
}
brm.addEventListener("change", () => {
  updateCustomLimitVisibility();
  update(true);
});
customLimitHours.addEventListener("input", () => {
  localStorage.setItem("customLimitHours", customLimitHours.value);
  update(true);
});

// 進捗バー拡大表示用の状態（0:全体表示 / 1:前2km+後38km＝計40km / 2:前2km+後18km＝計20km）
let zoomLevel = 0;
let zoomBaseStart = 0;
let zoomBaseEnd = 0;
let zoomPanOffsetKm = 0; // クリックしながら横にスライドした分の追加オフセット(km)
const ZOOM_BEFORE_KM = 2;
const ZOOM_LEVEL_AFTER_KM = { 1: 38, 2: 18 };

let pcDisplayIdx = -1; 
let pcAutoTrackIdx = -1;        
let isPcUserNavigating = false; 

let shopDisplayIdx = -1;
let shopAutoTrackIdx = -1;
let isShopUserNavigating = false;

let tempDistanceValue = ""; 

let lastPcInputText = null;
let lastShopInputText = null;

function toHalfWidthAlphaNum(str) {
  if (!str) return "";
  return str.replace(/[！-～]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  }).replace(/[\s ]+/g, '').toUpperCase();
}

startTime.value = localStorage.getItem("startTime") || "";
brm.value = localStorage.getItem("brm") || "200,13.5";
distance.value = localStorage.getItem("distance") || "";
pcInput.value = localStorage.getItem("pcList3") || "";
shopInput.value = localStorage.getItem("shopList3") || "";
customLimitHours.value = localStorage.getItem("customLimitHours") || "";
updateCustomLimitVisibility();

// GPXトラックデータの復元
try {
  const cachedGpx = localStorage.getItem("gpxTrackPoints");
  if (cachedGpx) gpxTrackPoints = JSON.parse(cachedGpx);
} catch(e) { gpxTrackPoints = []; }

const savedToggleState = localStorage.getItem("shopToggleState");
if (savedToggleState === "false") {
  shopToggle.checked = false;
  document.body.classList.add("shop-off");
  shopCard.style.display = "none";
} else {
  shopToggle.checked = true;
  document.body.classList.remove("shop-off");
  shopCard.style.display = "block";
}

const savedMapDblClickState = localStorage.getItem("mapDblClickState");
if (savedMapDblClickState === "false") {
  mapDblClickToggle.checked = false;
} else {
  mapDblClickToggle.checked = true;
}

const savedConvenienceBtnState = localStorage.getItem("convenienceBtnState");
if (savedConvenienceBtnState === "false") {
  convenienceBtnToggle.checked = false;
  convenienceBtnWrapper.style.display = "none";
  topRowGrid.classList.add("convenience-off");
} else {
  convenienceBtnToggle.checked = true;
  convenienceBtnWrapper.style.display = "block";
  topRowGrid.classList.remove("convenience-off");
}

menuTrigger.addEventListener("click", () => menuContent.classList.add("open"));
menuCloseBtn.addEventListener("click", () => menuContent.classList.remove("open"));
menuContent.addEventListener("click", (e) => { if (e.target === menuContent) { menuContent.classList.remove("open"); } });

helpTrigger.addEventListener("click", () => { helpModal.classList.add("open"); });
modalCloseBtn.addEventListener("click", () => { helpModal.classList.remove("open"); });
helpModal.addEventListener("click", (e) => { if (e.target === helpModal) { helpModal.classList.remove("open"); } });

shopToggle.addEventListener("change", () => {
  localStorage.setItem("shopToggleState", shopToggle.checked);
  if (shopToggle.checked) {
    document.body.classList.remove("shop-off");
    shopCard.style.display = "block";
  } else {
    document.body.classList.add("shop-off");
    shopCard.style.display = "none";
  }
  const [targetDistance] = getBrmTargetAndLimit();
  renderGraphScale(targetDistance);
  updateDisplayOnly();
});

mapDblClickToggle.addEventListener("change", () => { localStorage.setItem("mapDblClickState", mapDblClickToggle.checked); });

convenienceBtnToggle.addEventListener("change", () => {
  localStorage.setItem("convenienceBtnState", convenienceBtnToggle.checked);
  if (convenienceBtnToggle.checked) {
    convenienceBtnWrapper.style.display = "block";
    topRowGrid.classList.remove("convenience-off");
  } else {
    convenienceBtnWrapper.style.display = "none";
    topRowGrid.classList.add("convenience-off");
  }
});

distance.addEventListener("focus", () => { tempDistanceValue = distance.value; distance.value = ""; });
distance.addEventListener("blur", () => { if (distance.value === "") { distance.value = tempDistanceValue; update(false); } });

// ===== 地図アプリの起動 =====
function openNativeMap(url) {
  if (window.cordova) {
    // Cordova/Monaca環境：'_system' を指定してOSにURLを渡す
    // → geo: URIならAndroidのマップアプリ（Google Maps等）がintentで起動する
    // InAppBrowserプラグインがwindow.open自体を上書きしているため、
    // cordova.InAppBrowser等のオブジェクト存在チェックは行わない
    // （バージョンによってはこのチェックがfalsyになり、意図せず
    //   アプリ内蔵ブラウザ（"_blank"）に落ちてしまう不具合があったため）
    window.open(url, "_system");
  } else {
    // 通常ブラウザ：新規タブで開く
    window.open(url, "_blank");
  }
}

function searchOnGoogleMap(keyword) {
  if (!keyword || keyword.includes("ゴール") || keyword.includes("登録なし") || keyword.includes("---")) return;
  const enc = encodeURIComponent(keyword);
  if (window.cordova) {
    // Monacaアプリ：geo: URI でOSのデフォルト地図アプリ（Google Maps）を起動
    openNativeMap("geo:0,0?q=" + enc);
  } else {
    // 通常ブラウザ：HTTPS URL で新しいタブを開く
    openNativeMap("https://www.google.com/maps/search/?api=1&query=" + enc);
  }
}

function searchOnGoogleMapNearby(keyword, lat, lng) {
  const enc = encodeURIComponent(keyword);
  if (window.cordova) {
    // 現在地の座標付きで検索（geo:緯度,経度?q=キーワード）
    openNativeMap("geo:" + lat + "," + lng + "?q=" + enc);
  } else {
    openNativeMap("https://www.google.com/maps/search/?api=1&query=" + enc + "&center=" + lat + "," + lng);
  }
}

convenienceBtn.addEventListener("click", () => {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => { searchOnGoogleMapNearby("コンビニ", pos.coords.latitude, pos.coords.longitude); },
      () => { searchOnGoogleMap("コンビニ"); },
      { timeout: 5000, maximumAge: 60000 }
    );
  } else {
    searchOnGoogleMap("コンビニ");
  }
});

pcRemainDist.addEventListener("dblclick", (e) => { e.stopPropagation(); exitZoomView(); if (isPcUserNavigating) { isPcUserNavigating = false; pcDisplayIdx = pcAutoTrackIdx; } update(true); });
pcTitleRow.addEventListener("dblclick", (e) => { e.stopPropagation(); if (!mapDblClickToggle.checked) return; if (globalPCList.length > 0 && pcDisplayIdx !== -1) { const item = globalPCList[pcDisplayIdx]; searchOnGoogleMap(item.id + " " + item.name); } });
shopRemainDist.addEventListener("dblclick", (e) => { e.stopPropagation(); exitZoomView(); if (isShopUserNavigating) { isShopUserNavigating = false; shopDisplayIdx = shopAutoTrackIdx; } update(true); });
shopTitleRow.addEventListener("dblclick", (e) => { e.stopPropagation(); if (!mapDblClickToggle.checked) return; if (globalShopList.length > 0 && shopDisplayIdx !== -1) { searchOnGoogleMap(globalShopList[shopDisplayIdx].name); } });

// --- GPXパーサー実装部分 ---
gpxBtn.addEventListener("click", () => gpxFileInput.click());
// 進捗バー周辺：タップ(移動なし)でズーム段階を循環、クリック(タップ)しながら横にスライドでパン移動
let panPointerId = null;
let panStartClientX = 0;
let panStartOffsetKm = 0;
let panMoved = false;
const PAN_DRAG_THRESHOLD_PX = 6;

graphScale.addEventListener("pointerdown", (e) => {
  panPointerId = e.pointerId; panStartClientX = e.clientX; panStartOffsetKm = zoomPanOffsetKm; panMoved = false;
});
graphScale.addEventListener("pointermove", (e) => {
  if (panPointerId === null || e.pointerId !== panPointerId) return;
  const dx = e.clientX - panStartClientX;
  if (!panMoved && Math.abs(dx) < PAN_DRAG_THRESHOLD_PX) return;
  panMoved = true;
  if (zoomLevel === 0) return; // 全体表示中はパン操作なし
  e.preventDefault();
  const rect = graphScale.getBoundingClientRect(); const widthPx = rect.width || 1;
  const spanKm = zoomBaseEnd - zoomBaseStart;
  const deltaKm = (dx / widthPx) * spanKm;
  // 指を左にドラッグ(dx<0)すると先(GOAL方向)の情報が見えるようにする
  zoomPanOffsetKm = panStartOffsetKm - deltaKm;
  const [targetDistance] = getBrmTargetAndLimit();
  renderGraphScale(targetDistance);
});
graphScale.addEventListener("pointerup", (e) => {
  if (panPointerId !== e.pointerId) return;
  if (!panMoved) { cycleZoomLevel(); }
  panPointerId = null;
});
graphScale.addEventListener("pointercancel", () => { panPointerId = null; });
gpxFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(evt.target.result, "text/xml");
      
      const trkpts = xmlDoc.getElementsByTagName("trkpt");
      if (trkpts.length === 0) { alert("GPXファイル内にトラックデータ(ルート線)が見つかりませんでした。"); return; }
      
      gpxTrackPoints = [];
      let totalDist = 0;
      let totalGain = 0;
      
      const ELE_THRESHOLD = 1.5; 
      let lastCountedEle = null; 
      
      function calcDistance(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      }
      
      for (let i = 0; i < trkpts.length; i++) {
        const lat = parseFloat(trkpts[i].getAttribute("lat"));
        const lon = parseFloat(trkpts[i].getAttribute("lon"));
        const eleEl = trkpts[i].getElementsByTagName("ele")[0];
        const ele = eleEl ? parseFloat(eleEl.textContent) : 0;
        
        if (i === 0) {
          lastCountedEle = ele;
        } else {
          const prev = gpxTrackPoints[i - 1];
          const d = calcDistance(prev.lat, prev.lon, lat, lon);
          totalDist += d;
          
          const dEle = ele - lastCountedEle;
          if (dEle >= ELE_THRESHOLD) {
            totalGain += dEle;
            lastCountedEle = ele; 
          } else if (dEle <= -ELE_THRESHOLD) {
            lastCountedEle = ele;
          }
        }
        gpxTrackPoints.push({ lat, lon, ele, dist: totalDist, gain: totalGain });
      }
      localStorage.setItem("gpxTrackPoints", JSON.stringify(gpxTrackPoints));

      const wpts = xmlDoc.getElementsByTagName("wpt");
      let pcTextLines = [];
      let shopTextLines = [];
      
      for (let i = 0; i < wpts.length; i++) {
        const wLat = parseFloat(wpts[i].getAttribute("lat"));
        const wLon = parseFloat(wpts[i].getAttribute("lon"));
        const nameEl = wpts[i].getElementsByTagName("name")[0];
        const name = nameEl ? nameEl.textContent.trim() : `Point ${i+1}`;
        const nameLower = name.toLowerCase();
        
        let minDist = Infinity;
        let matchedPoint = gpxTrackPoints[0];
        for (let j = 0; j < gpxTrackPoints.length; j++) {
          const d = calcDistance(wLat, wLon, gpxTrackPoints[j].lat, gpxTrackPoints[j].lon);
          if (d < minDist) { minDist = d; matchedPoint = gpxTrackPoints[j]; }
        }
        
        const ptDistStr = matchedPoint.dist.toFixed(1);
        
        if (nameLower.includes("pc") || nameLower.includes("check") || nameLower.includes("チェック") || nameLower.includes("start") || nameLower.includes("goal") || nameLower.includes("finish") || nameLower.includes("通過")) {
          let cleanName = name.replace(/^(pc\d*|通過チェック[①-⑳\d]*|start|goal|finish|チェック)\s*[\s ,，、_\-]/i, "").trim();
          cleanName = cleanName.replace(/^(通過チェック[①-⑳\d]*|ｐｃ\d*)/i, "").trim();
          
          let label = "PC";
          if (nameLower.includes("start")) label = "START";
          else if (nameLower.includes("goal") || nameLower.includes("finish")) label = "GOAL";
          else if (nameLower.includes("通過") || nameLower.includes("check")) label = "通過チェック";
          
          pcTextLines.push({ d: matchedPoint.dist, text: `${label}, ${cleanName}, ${ptDistStr}km` });
        } else {
          shopTextLines.push({ d: matchedPoint.dist, text: `${name}, ${ptDistStr}` });
        }
      }
      
      pcTextLines.sort((a,b) => a.d - b.d);
      shopTextLines.sort((a,b) => a.d - b.d);
      
      let pcIdx = 1;
      let chkIdx = 1;
      const formattedPcLines = pcTextLines.map(item => {
        let t = item.text;
        if (t.startsWith("PC,")) { t = t.replace("PC,", `PC${pcIdx},`); pcIdx++; }
        else if (t.startsWith("通過チェック,")) { t = t.replace("通過チェック,", `通過チェック${circleNumbers[chkIdx-1]||chkIdx},`); chkIdx++; }
        return t;
      });

      if (formattedPcLines.length > 0) pcInput.value = formattedPcLines.join("\n");
      if (shopTextLines.length > 0) shopInput.value = shopTextLines.map(item => item.text).join("\n");
      
      const finalRouteDist = Math.ceil(totalDist);
      if (finalRouteDist > 50 && !brm.value.startsWith("custom")) {
        // 「GPX距離を使用」モード選択中はBRM標準距離への自動置き換えを行わない
        let matchedBrmVal = "200,13.5";
        if (finalRouteDist > 550) matchedBrmVal = "600,40";
        else if (finalRouteDist > 350) matchedBrmVal = "400,27";
        else if (finalRouteDist > 250) matchedBrmVal = "300,20";
        brm.value = matchedBrmVal;
      }
      updateCustomLimitVisibility();
      
      isPcUserNavigating = false;
      isShopUserNavigating = false;
      persistInputs();
      update(true);
      alert(`GPXデータの解析に成功しました！\n総距離: ${totalDist.toFixed(1)}km\n総獲得標高: ${Math.round(totalGain)}m\nチェックポイントを自動登録しました。`);
    } catch(err) {
      alert("GPXファイルの解析中にエラーが発生しました。");
    } finally {
      gpxFileInput.value = "";
    }
  };
  reader.readAsText(file);
});

// 2点間の距離(km)を計算（ハーバサイン公式）
function calcHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 現在のGPS座標をGPXルート上の距離(km)にマッチングする。
// ・往復ルートや並走区間での誤判定を防ぐため、直前にマッチした距離の±GPS_SEARCH_WINDOW_KM以内の点だけを探索対象にする（連続性チェック）
// ・コースから大きく外れている場合（GPS_MAX_MATCH_DIST_KM超）は信頼できないとみなしnullを返す（更新しない）
function matchPositionToRoute(lat, lon, lastDist) {
  if (gpxTrackPoints.length === 0) return null;
  let candidates = gpxTrackPoints;
  if (lastDist !== null && !isNaN(lastDist)) {
    const windowed = gpxTrackPoints.filter(p => Math.abs(p.dist - lastDist) <= GPS_SEARCH_WINDOW_KM);
    if (windowed.length > 0) candidates = windowed;
  }
  let best = null, bestDist = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    const d = calcHaversineDistance(lat, lon, p.lat, p.lon);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  if (!best || bestDist > GPS_MAX_MATCH_DIST_KM) return null;
  return best.dist;
}

function setGpsButtonState(state) {
  // state: "idle" | "fetching" | "error"
  gpsTrackBtn.classList.remove("active", "searching");
  if (state === "fetching") gpsTrackBtn.classList.add("searching");
  else if (state === "error") gpsTrackBtn.classList.add("error-flash");
}

// 📍ボタンを押した時だけ1回だけGPSを取得する（常時監視はしないため電池消耗を抑えられる）
function fetchGpsDistanceOnce() {
  if (gpsIsFetching) return; // 取得中は多重実行しない
  if (gpxTrackPoints.length === 0) { alert("GPSで距離を取得するには、先にGPXファイルを読み込んでください。"); return; }
  if (!navigator.geolocation) { alert("この端末・ブラウザは位置情報の取得に対応していません。"); return; }

  gpsIsFetching = true;
  setGpsButtonState("fetching");

  const seedDist = parseFloat(distance.value);
  const lastDistForMatching = isNaN(seedDist) ? gpsLastMatchedDist : seedDist;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const matchedDist = matchPositionToRoute(pos.coords.latitude, pos.coords.longitude, lastDistForMatching);
      gpsIsFetching = false;
      if (matchedDist === null) {
        setGpsButtonState("error");
        setTimeout(() => setGpsButtonState("idle"), 1500);
        alert("現在地がルートから離れているため、距離を更新できませんでした。");
        return;
      }
      gpsLastMatchedDist = matchedDist;
      distance.value = matchedDist.toFixed(1);
      persistInputs();
      exitZoomView();
      update(true);
      setGpsButtonState("idle");
    },
    (err) => {
      gpsIsFetching = false;
      setGpsButtonState("error");
      setTimeout(() => setGpsButtonState("idle"), 1500);
      alert("GPS位置情報の取得に失敗しました。電波状況の良い場所で再度お試しください。");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

gpsTrackBtn.addEventListener("click", () => { fetchGpsDistanceOnce(); });

function getGpxGainAtDistance(dist) {
  if (gpxTrackPoints.length === 0) return 0;
  if (dist <= 0) return 0;
  for (let i = 0; i < gpxTrackPoints.length; i++) {
    if (gpxTrackPoints[i].dist >= dist) return gpxTrackPoints[i].gain;
  }
  return gpxTrackPoints[gpxTrackPoints.length - 1].gain;
}

function getGpxElevationAtDistance(dist) {
  if (gpxTrackPoints.length === 0) return null;
  for (let i = 0; i < gpxTrackPoints.length; i++) {
    if (gpxTrackPoints[i].dist >= dist) {
      // 前後2点で線形補間してより正確な標高を返す
      if (i === 0) return Math.round(gpxTrackPoints[0].ele);
      const p0 = gpxTrackPoints[i - 1], p1 = gpxTrackPoints[i];
      const t = (p1.dist > p0.dist) ? (dist - p0.dist) / (p1.dist - p0.dist) : 0;
      return Math.round(p0.ele + (p1.ele - p0.ele) * t);
    }
  }
  return Math.round(gpxTrackPoints[gpxTrackPoints.length - 1].ele);
}

function loadSavedListsDropdown() {
  const savedData = localStorage.getItem("customBRMDataSets3");
  let lists = savedData ? JSON.parse(savedData) : {};
  savedListsSelect.innerHTML = "";
  const keys = Object.keys(lists);
  if (keys.length === 0) {
    const opt = document.createElement("option"); opt.value = ""; opt.innerText = "-- 保存データがありません --"; savedListsSelect.appendChild(opt); return;
  }
  const defaultOpt = document.createElement("option"); defaultOpt.value = ""; defaultOpt.innerText = "-- リストを選択して呼び出し --"; savedListsSelect.appendChild(defaultOpt);
  keys.forEach(key => { const opt = document.createElement("option"); opt.value = key; opt.innerText = key; savedListsSelect.appendChild(opt); });
}

saveBtn.addEventListener("click", () => {
  const name = saveName.value.trim(); if (!name) { alert("保存する名前を入力してください。"); return; }
  const savedData = localStorage.getItem("customBRMDataSets3"); let lists = savedData ? JSON.parse(savedData) : {};
  if (lists[name] && !confirm("「" + name + "」は既に保存されています。上書きしますか？")) { return; }
  lists[name] = { pc: pcInput.value.trim(), shop: shopInput.value.trim() };
  localStorage.setItem("customBRMDataSets3", JSON.stringify(lists));
  saveName.value = ""; loadSavedListsDropdown(); alert("セット「" + name + "」を保存しました。");
});

savedListsSelect.addEventListener("change", () => {
  const selectedName = savedListsSelect.value; if (!selectedName) return;
  const savedData = localStorage.getItem("customBRMDataSets3"); let lists = savedData ? JSON.parse(savedData) : {};
  if (lists[selectedName]) {
    const data = lists[selectedName]; pcInput.value = data.pc || ""; shopInput.value = data.shop || "";
    isPcUserNavigating = false; isShopUserNavigating = false; persistInputs(); update(true); alert("「" + selectedName + "」のデータを読み込みました。");
  }
});

deleteBtn.addEventListener("click", () => {
  const selectedName = savedListsSelect.value; if (!selectedName) { alert("削除したいリストを選択してください。"); return; }
  if (confirm("リスト「" + selectedName + "」を削除してもよろしいですか？")) {
    const savedData = localStorage.getItem("customBRMDataSets3"); let lists = savedData ? JSON.parse(savedData) : {};
    delete lists[selectedName]; localStorage.setItem("customBRMDataSets3", JSON.stringify(lists));
    loadSavedListsDropdown(); alert("削除しました。");
  }
});

const BACKUP_KEYS = ["startTime", "brm", "distance", "pcList3", "shopList3", "customBRMDataSets3", "shopToggleState", "mapDblClickState", "convenienceBtnState", "gpxTrackPoints", "customLimitHours"];

exportBtn.addEventListener("click", () => {
  const backupData = {};
  BACKUP_KEYS.forEach(key => { const v = localStorage.getItem(key); if (v !== null) backupData[key] = v; });
  const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const now = new Date();
  const stamp = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0') + "_" + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
  a.href = url; a.download = "brm_pace_manager_backup_" + stamp + ".json";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  alert("バックアップファイルを書き出しました。");
});

importBtn.addEventListener("click", () => { importFileInput.click(); });

importFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      const validKeys = Object.keys(parsed).filter(k => BACKUP_KEYS.includes(k));
      if (validKeys.length === 0) { alert("このファイルには有効なバックアップデータが見つかりませんでした。"); return; }
      if (!confirm("現在の設定・リストをすべて上書きして読み込みます。よろしいですか？")) return;
      validKeys.forEach(key => { localStorage.setItem(key, parsed[key]); });

      startTime.value = localStorage.getItem("startTime") || "";
      brm.value = localStorage.getItem("brm") || "200,13.5";
      distance.value = localStorage.getItem("distance") || "";
      pcInput.value = localStorage.getItem("pcList3") || "";
      shopInput.value = localStorage.getItem("shopList3") || "";
      customLimitHours.value = localStorage.getItem("customLimitHours") || "";
      updateCustomLimitVisibility();

      try {
        const cachedGpx = localStorage.getItem("gpxTrackPoints");
        gpxTrackPoints = cachedGpx ? JSON.parse(cachedGpx) : [];
      } catch(e) { gpxTrackPoints = []; }

      const toggleState = localStorage.getItem("shopToggleState");
      shopToggle.checked = toggleState !== "false";
      document.body.classList.toggle("shop-off", !shopToggle.checked);
      shopCard.style.display = shopToggle.checked ? "block" : "none";

      const dblClickState = localStorage.getItem("mapDblClickState");
      mapDblClickToggle.checked = dblClickState !== "false";

      const convState = localStorage.getItem("convenienceBtnState");
      convenienceBtnToggle.checked = convState !== "false";
      convenienceBtnWrapper.style.display = convenienceBtnToggle.checked ? "block" : "none";
      topRowGrid.classList.toggle("convenience-off", !convenienceBtnToggle.checked);

      isPcUserNavigating = false; isShopUserNavigating = false;
      loadSavedListsDropdown();
      update(true);
      alert("バックアップを読み込みました。");
    } catch (err) {
      alert("ファイルの読み込みに失敗しました。");
    } finally {
      importFileInput.value = "";
    }
  };
  reader.readAsText(file);
});

pcPrevBtn.addEventListener("click", () => { if (globalPCList.length === 0) return; if (pcDisplayIdx > 0) { isPcUserNavigating = true; pcDisplayIdx--; const [targetDistance] = getBrmTargetAndLimit(); renderGraphScale(targetDistance); updateDisplayOnly(); } });
pcNextBtn.addEventListener("click", () => { if (globalPCList.length === 0) return; if (pcDisplayIdx < globalPCList.length - 1) { isPcUserNavigating = true; pcDisplayIdx++; const [targetDistance] = getBrmTargetAndLimit(); renderGraphScale(targetDistance); updateDisplayOnly(); } });
shopPrevBtn.addEventListener("click", () => { if (globalShopList.length === 0) return; if (shopDisplayIdx > 0) { isShopUserNavigating = true; shopDisplayIdx--; const [targetDistance] = getBrmTargetAndLimit(); renderGraphScale(targetDistance); updateDisplayOnly(); } });
shopNextBtn.addEventListener("click", () => { if (globalShopList.length === 0) return; if (shopDisplayIdx < globalShopList.length - 1) { isShopUserNavigating = true; shopDisplayIdx++; const [targetDistance] = getBrmTargetAndLimit(); renderGraphScale(targetDistance); updateDisplayOnly(); } });

function formatArrivalDate(targetDate, startStr) {
  if (!startStr) return "--:--"; const start = new Date(startStr); const hrs = String(targetDate.getHours()).padStart(2, '0'); const mins = String(targetDate.getMinutes()).padStart(2, '0');
  if (targetDate.getDate() !== start.getDate() || targetDate.getMonth() !== start.getMonth()) { return ["日", "月", "火", "水", "木", "金", "土"][targetDate.getDay()] + ")" + hrs + ":" + mins; }
  return hrs + ":" + mins;
}

// ★今回の調整対象：表示HTML構築処理 (括弧の削除)
function updateDisplayOnly() {
  const currentDist = parseFloat(distance.value) || 0;
  let startReady = false; let start = null; if (startTime.value) { start = new Date(startTime.value); if (!isNaN(start.getTime())) startReady = true; }

  const currentGain = getGpxGainAtDistance(currentDist);

  if (globalPCList.length > 0 && pcDisplayIdx !== -1) {
    const selectedPC = globalPCList[pcDisplayIdx]; const diffDist = selectedPC.dist - currentDist;
    let prefix = (pcDisplayIdx === pcAutoTrackIdx) ? "次: " : (pcDisplayIdx < pcAutoTrackIdx ? "通過: " : "先々: ");
    document.getElementById("pcLabel").innerText = prefix + selectedPC.id + " " + selectedPC.name + "（" + selectedPC.dist.toFixed(1) + "km）";
    
    let gainStr = "--m";
    if (gpxTrackPoints.length > 0) {
      const pcGain = getGpxGainAtDistance(selectedPC.dist);
      const remGain = Math.max(0, Math.round(pcGain - currentGain));
      gainStr = remGain + "m";
    }
    // 【修正】（獲得標高 ○○m）の「（）」を削除しました
    pcRemainDist.innerHTML = diffDist >= 0 
      ? `残り ${diffDist.toFixed(1)} km<span class="ele-small">獲得標高 ${gainStr}</span>` 
      : `通過後 ${Math.abs(diffDist).toFixed(1)} km<span class="ele-small">獲得標高 --m</span>`;
    
    [15, 16, 17, 18, 19, 20].forEach(speed => {
      const el = document.getElementById("pc_sp" + speed);
      if (startReady) { el.innerText = formatArrivalDate(new Date(start.getTime() + (selectedPC.dist / speed) * 3600000), startTime.value); } else { el.innerText = "--:--"; }
    });
  } else {
    document.getElementById("pcLabel").innerText = "次: ゴール"; pcRemainDist.innerHTML = '残り 0.0 km<span class="ele-small">獲得標高 --m</span>'; ["15","16","17","18","19","20"].forEach(s => document.getElementById("pc_sp" + s).innerText = "--:--");
  }

  if (shopToggle.checked && globalShopList.length > 0 && shopDisplayIdx !== -1) {
    const selectedShop = globalShopList[shopDisplayIdx]; const diffDist = selectedShop.dist - currentDist;
    let prefix = (shopDisplayIdx === shopAutoTrackIdx) ? "次休憩: " : (shopDisplayIdx < shopAutoTrackIdx ? "通過休憩: " : "先々休憩: ");
    document.getElementById("shopLabel").innerText = prefix + selectedShop.id + " " + selectedShop.name + "（" + selectedShop.dist.toFixed(1) + "km）";
    
    let gainStr = "--m";
    if (gpxTrackPoints.length > 0) {
      const shopGain = getGpxGainAtDistance(selectedShop.dist);
      const remGain = Math.max(0, Math.round(shopGain - currentGain));
      gainStr = remGain + "m";
    }
    // 【修正】（獲得標高 ○○m）の「（）」を削除しました
    shopRemainDist.innerHTML = diffDist >= 0 
      ? `残り ${diffDist.toFixed(1)} km<span class="ele-small">獲得標高 ${gainStr}</span>` 
      : `通過後 ${Math.abs(diffDist).toFixed(1)} km<span class="ele-small">獲得標高 --m</span>`;
  } else {
    document.getElementById("shopLabel").innerText = "次休憩: 登録なし"; shopRemainDist.innerHTML = '残り -- km<span class="ele-small">獲得標高 --m</span>';
  }
}

// 現在のズーム段階・パンオフセットに応じた表示範囲[viewStart, viewEnd]を計算する
function getViewRange(targetDistance) {
  if (zoomLevel === 0) return [0, targetDistance];
  const span = zoomBaseEnd - zoomBaseStart;
  let start = zoomBaseStart + zoomPanOffsetKm;
  let end = zoomBaseEnd + zoomPanOffsetKm;
  // スタート以前・ゴール以降へのパンを無効にする
  if (start < 0) { end -= start; start = 0; }
  if (end > targetDistance) { start -= (end - targetDistance); end = targetDistance; if (start < 0) start = 0; }
  if (end <= start) end = start + 0.1;
  return [start, end];
}

function renderGraphScale(targetDistance) {
  if (!targetDistance || targetDistance <= 0) return;

  const [viewStart, viewEnd] = getViewRange(targetDistance);
  const viewSpan = viewEnd - viewStart;

  // START/GOALラベルは横ずれなし（左端=0%・右端=100%）なので、
  // グラフ本体（標高SVG・進捗バー）は端から端まで100%幅で使用する
  graphScale.style.setProperty("--graph-left", "0%");
  graphScale.style.setProperty("--graph-width", "100%");

  // 簡易工程図：ズーム中は表示範囲(viewStart〜viewEnd)、非ズーム時はGPXの実測距離全体を使って描画する
  if (zoomLevel !== 0) {
    renderElevationProfile(viewStart, viewEnd);
  } else {
    const actualTotalDist = gpxTrackPoints.length > 0 ? gpxTrackPoints[gpxTrackPoints.length - 1].dist : targetDistance;
    renderElevationProfile(0, actualTotalDist > 0 ? actualTotalDist : targetDistance);
  }

  const items = graphScale.querySelectorAll(".scale-point"); items.forEach(el => el.remove());

  // STARTラベル（左揃え・1.25em左にずれ）＋START地点の標高を上に表示
  const startEle = getGpxElevationAtDistance(viewStart);
  const startEleHtml = startEle !== null ? `<span class="neutral-ele">${startEle}m</span><br>` : "";
  const startLabel = viewStart <= 0.01 ? "START" : viewStart.toFixed(1) + "km";
  createScalePoint(0, startEleHtml + startLabel, "neutral-type start-label", "2px", null);

  // GOALラベル（右揃え・1.25em右にずれ）
  const goalEle = getGpxElevationAtDistance(viewEnd);
  const goalEleHtml = goalEle !== null ? `<span class="neutral-ele">${goalEle}m</span><br>` : "";
  const goalLabel = viewEnd >= targetDistance - 0.01 ? "GOAL" : viewEnd.toFixed(1) + "km";
  createScalePoint(100, goalEleHtml + goalLabel, "neutral-type goal-label", "2px", null);

  // 中間ポイントは表示範囲の中間地点（距離＋標高を表示）
  const midDist = (viewStart + viewEnd) / 2;
  if (midDist > viewStart + 0.5 && midDist < viewEnd - 0.5) {
    const midPct = ((midDist - viewStart) / viewSpan) * 100;
    const midEle = getGpxElevationAtDistance(midDist);
    const midEleHtml = midEle !== null ? `<span class="mid-ele">${midEle}m</span><br>` : "";
    createScalePoint(midPct, midEleHtml + midDist.toFixed(1) + "km", "mid-type", "2px", null);
  }

  let lastPctPC = -999; let useUpperRowPC = false;
  globalPCList.forEach((p, idx) => {
    if (p.dist < targetDistance && p.dist >= viewStart - 0.001 && p.dist <= viewEnd + 0.001) {
      const pct = ((p.dist - viewStart) / viewSpan) * 100; let label = String(p.id).split(/[\s,，、]/)[0]; if (label.length > 6) { label = label.substring(0, 4); }
      if (pct - lastPctPC < 4.5) { useUpperRowPC = !useUpperRowPC; } else { useUpperRowPC = false; }
      let typeClass = "pc-type " + (useUpperRowPC ? "pc-type-row1" : "pc-type-row0"); if (idx === pcDisplayIdx) typeClass += " active-pc";
      createScalePoint(pct, label, typeClass, useUpperRowPC ? "1px" : "10px", null); lastPctPC = pct;
    }
  });
  if (shopToggle.checked) {
    let lastPctShop = -999; let useLowerRowShop = false;
    globalShopList.forEach((s, idx) => {
      if (s.dist < targetDistance && s.dist >= viewStart - 0.001 && s.dist <= viewEnd + 0.001) {
        const pct = ((s.dist - viewStart) / viewSpan) * 100; let label = String(s.id).split(/[\s,，、]/)[0]; if (label.length > 6) { label = label.substring(0, 4); }
        if (pct - lastPctShop < 4.5) { useLowerRowShop = !useLowerRowShop; } else { useLowerRowShop = false; }
        let typeClass = "shop-type " + (useLowerRowShop ? "shop-type-row1" : "shop-type-row0"); if (idx === shopDisplayIdx) typeClass += " active-shop";
        createScalePoint(pct, label, typeClass, null, useLowerRowShop ? "1px" : "10px"); lastPctShop = pct;
      }
    });
  }
}

function createScalePoint(leftPct, label, className, topStyle, bottomStyle) {
  const div = document.createElement("div"); div.className = "scale-point " + className; div.style.left = leftPct + "%"; div.innerHTML = label;
  if (topStyle !== null) div.style.top = topStyle; if (bottomStyle !== null) div.style.bottom = bottomStyle; graphScale.appendChild(div);
}

// 進捗バー（とその周辺）のタップで、全体表示→前2km+後38km(計40km)→前2km+後18km(計20km)→全体表示...の3段階を循環する
function cycleZoomLevel() {
  const [targetDistance] = getBrmTargetAndLimit();
  zoomLevel = (zoomLevel + 1) % 3;
  zoomPanOffsetKm = 0;
  if (zoomLevel !== 0) {
    const currentDist = parseFloat(distance.value) || 0;
    const afterKm = ZOOM_LEVEL_AFTER_KM[zoomLevel];
    zoomBaseStart = Math.max(0, currentDist - ZOOM_BEFORE_KM);
    zoomBaseEnd = currentDist + afterKm;
  }
  renderGraphScale(targetDistance);
}

// 現在距離の更新や残り距離のダブルクリックなど、全体表示に戻すべき操作で呼び出す
function exitZoomView() {
  if (zoomLevel !== 0) { zoomLevel = 0; zoomPanOffsetKm = 0; return true; }
  return false;
}

// 簡易工程図：GPXの標高データを使い、指定した距離範囲(viewStart〜viewEnd)を0%〜100%に正規化して
// 既存のSTART/GOALグラフ枠（graph-scale-container）の背面いっぱいに勾配プロファイルを描画する
function renderElevationProfile(viewStart, viewEnd) {
  if (!elevationSvg) return;
  if (gpxTrackPoints.length === 0 || viewEnd <= viewStart) { elevationSvg.innerHTML = ""; return; }

  const W = 1000, H = 100;

  let minEle = Infinity, maxEle = -Infinity;
  for (let i = 0; i < gpxTrackPoints.length; i++) {
    const e = gpxTrackPoints[i].ele;
    if (e < minEle) minEle = e; if (e > maxEle) maxEle = e;
  }
  if (!isFinite(minEle) || !isFinite(maxEle) || maxEle <= minEle) { maxEle = minEle + 1; }

  // 表示範囲(viewStart〜viewEnd)に含まれる点を抽出する（境界の前後を補完するため一点ずつ余分に含める）
  let inRange = [];
  for (let i = 0; i < gpxTrackPoints.length; i++) {
    const p = gpxTrackPoints[i];
    if (p.dist < viewStart) { inRange = [p]; continue; }
    inRange.push(p);
    if (p.dist > viewEnd) break;
  }
  if (inRange.length < 2) { elevationSvg.innerHTML = ""; return; }

  const rangeSpan = viewEnd - viewStart;
  // 描画負荷軽減のため、範囲内の点数が多い場合は最大200点程度にダウンサンプリングする
  const step = Math.max(1, Math.floor(inRange.length / 200));
  let pts = [];
  for (let i = 0; i < inRange.length; i += step) {
    const p = inRange[i];
    const x = Math.min(W, Math.max(0, ((p.dist - viewStart) / rangeSpan) * W));
    const y = H - ((p.ele - minEle) / (maxEle - minEle)) * H;
    pts.push(x.toFixed(1) + "," + y.toFixed(1));
  }
  const lastP = inRange[inRange.length - 1];
  const lastX = Math.min(W, Math.max(0, ((lastP.dist - viewStart) / rangeSpan) * W));
  const lastY = H - ((lastP.ele - minEle) / (maxEle - minEle)) * H;
  const lastPtStr = lastX.toFixed(1) + "," + lastY.toFixed(1);
  if (pts[pts.length - 1] !== lastPtStr) pts.push(lastPtStr);
  if (pts.length < 2) { elevationSvg.innerHTML = ""; return; }

  const lineD = "M " + pts.join(" L ");
  const lastX2 = pts[pts.length - 1].split(",")[0];
  const firstX2 = pts[0].split(",")[0];
  const areaD = lineD + ` L ${lastX2},${H} L ${firstX2},${H} Z`;

  elevationSvg.innerHTML = `<path d="${areaD}" class="elevation-area"></path><path d="${lineD}" class="elevation-line"></path>`;
}

function parseTextList(textData, isPCMode = false) {
  if (!textData) return [];
  const lines = textData.split("\n").filter(line => line.trim() !== ""); const tempResult = [];
  for (let line of lines) {
    const columns = line.split(/[,,、，]/).map(c => c.trim()); if (columns.length < 2) continue;
    let idOrName = columns[0]; let secondVal = columns[1]; let distStr = ""; let finalName = "";
    if (isPCMode) { if (columns.length >= 3) { distStr = columns[2]; finalName = secondVal; } else { distStr = secondVal; finalName = idOrName; } } else { distStr = secondVal; finalName = idOrName; }
    const itemDist = parseFloat(distStr.replace(/[^\d.]/g, "")); if (!isNaN(itemDist)) { tempResult.push({ rawId: idOrName, name: finalName, dist: itemDist }); }
  }
  tempResult.sort((a, b) => a.dist - b.dist); let genericCounter = 0;
  return tempResult.map(item => {
    let finalId = "";
    if (isPCMode) {
      let cleanId = toHalfWidthAlphaNum(item.rawId);
      if (cleanId.includes("PC")) { finalId = cleanId.match(/PC\d+/)?.[0] || cleanId; } else if (cleanId.includes("GOAL") || cleanId.includes("FINISH")) { finalId = "GOAL"; } else { finalId = circleNumbers[genericCounter] || `（${genericCounter + 1}）`; genericCounter++; }
    } else { finalId = circleNumbers[genericCounter] || `（${genericCounter + 1}）`; genericCounter++; }
    return { id: finalId, name: item.name, dist: item.dist };
  });
}

function persistInputs() {
  localStorage.setItem("startTime", startTime.value); localStorage.setItem("brm", brm.value); localStorage.setItem("distance", distance.value); localStorage.setItem("pcList3", pcInput.value); localStorage.setItem("shopList3", shopInput.value); localStorage.setItem("customLimitHours", customLimitHours.value);
}

function update(isDistanceOrInputChanged = false) {
  const now = new Date(); document.getElementById("currentTime").innerText = String(now.getHours()).padStart(2, '0') + ":" + String(now.getMinutes()).padStart(2, '0') + ":" + String(now.getSeconds()).padStart(2, '0');
  const currentDist = parseFloat(distance.value) || 0; 
  const [targetDistance, limitHours] = getBrmTargetAndLimit();
  
  if (pcInput.value !== lastPcInputText) { globalPCList = parseTextList(pcInput.value, true); lastPcInputText = pcInput.value; }
  if (shopInput.value !== lastShopInputText) { globalShopList = parseTextList(shopInput.value, false); lastShopInputText = shopInput.value; }
  const [viewStart, viewEnd] = getViewRange(targetDistance);
  let progressPct = (viewEnd > viewStart) ? Math.min(100, Math.max(0, ((currentDist - viewStart) / (viewEnd - viewStart)) * 100)) : 0; 
  graphBar.style.width = progressPct + "%";

  let detectedPcIdx = globalPCList.length > 0 ? globalPCList.length - 1 : -1;
  for (let i = 0; i < globalPCList.length; i++) { if (globalPCList[i].dist > currentDist) { detectedPcIdx = i; break; } }
  pcAutoTrackIdx = detectedPcIdx; if (isDistanceOrInputChanged || !isPcUserNavigating || pcDisplayIdx === -1 || pcDisplayIdx >= globalPCList.length) { if (isDistanceOrInputChanged) isPcUserNavigating = false; pcDisplayIdx = pcAutoTrackIdx; }

  let detectedShopIdx = globalShopList.length > 0 ? globalShopList.length - 1 : -1;
  for (let i = 0; i < globalShopList.length; i++) { if (globalShopList[i].dist > currentDist) { detectedShopIdx = i; break; } }
  shopAutoTrackIdx = detectedShopIdx; if (isDistanceOrInputChanged || !isShopUserNavigating || shopDisplayIdx === -1 || shopDisplayIdx >= globalShopList.length) { if (isDistanceOrInputChanged) isShopUserNavigating = false; shopDisplayIdx = shopAutoTrackIdx; }

  renderGraphScale(targetDistance); updateDisplayOnly();
  if (!startTime.value) return; let start = new Date(startTime.value);
  if (isNaN(start.getTime())) return;
  if (now < start) {
    document.getElementById("elapsed").innerText = "スタート前"; document.getElementById("remainTime").innerText = "スタート前"; document.getElementById("gross").innerText = "--";
    document.getElementById("remainDistance").innerText = targetDistance.toFixed(1) + " km"; document.getElementById("finish").innerText = "--"; document.getElementById("needSpeed").innerText = "--";
    document.getElementById("saving").innerText = "--"; document.getElementById("saving").className = "big-value"; return;
  }
  let elapsed = (now - start) / 1000 / 3600; if (elapsed <= 0 || !distance.value) return;
  const gross = currentDist / elapsed; document.getElementById("elapsed").innerText = Math.floor(elapsed) + "時間" + Math.floor((elapsed - Math.floor(elapsed)) * 60) + "分";
  const totalRemainTime = limitHours - elapsed; document.getElementById("remainTime").innerText = totalRemainTime > 0 ? Math.floor(totalRemainTime) + "時間" + Math.floor((totalRemainTime - Math.floor(totalRemainTime)) * 60) + "分" : "タイムアウト";
  document.getElementById("gross").innerText = gross.toFixed(2) + " km/h"; const remainDist = targetDistance - currentDist; document.getElementById("remainDistance").innerText = Math.max(0, remainDist).toFixed(1) + " km";
  document.getElementById("finish").innerText = new Date(start.getTime() + (targetDistance / gross) * 3600000).toLocaleDateString("ja-JP", { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  document.getElementById("needSpeed").innerText = (remainDist > 0 && totalRemainTime > 0) ? (remainDist / totalRemainTime).toFixed(1) + " km/h" : "---";
  
  const saving = limitHours - (targetDistance / gross); const savSign = saving >= 0 ? "+" : "-"; const savH = Math.floor(Math.abs(saving)); const savM = Math.floor((Math.abs(saving) % 1) * 60);
  let statusIcon = "🔴", statusClass = "big-value red"; if (saving >= 2) { statusIcon = "🟢"; statusClass = "big-value green"; } else if (saving >= 1) { statusIcon = "🟡"; statusClass = "big-value yellow"; }
  const savingElement = document.getElementById("saving"); savingElement.innerText = statusIcon + " " + savSign + savH + "時間" + savM + "分"; savingElement.className = statusClass;
}

resetBtn.addEventListener("click", () => {
  if (confirm("すべての設定、リスト、走行データをリセットしますか？")) {
    gpsLastMatchedDist = null;
    localStorage.removeItem("startTime"); localStorage.removeItem("distance"); localStorage.removeItem("pcList3"); localStorage.removeItem("shopList3");
    localStorage.removeItem("convenienceBtnState"); localStorage.removeItem("gpxTrackPoints");
    gpxTrackPoints = [];
    startTime.value = ""; distance.value = ""; pcInput.value = ""; shopInput.value = ""; saveName.value = ""; tempDistanceValue = ""; graphBar.style.width = "0%";
    ["elapsed", "remainTime", "gross", "remainDistance", "finish", "needSpeed", "saving"].forEach(id => document.getElementById(id).innerText = "--");
    document.getElementById("saving").className = "big-value"; isPcUserNavigating = false; isShopUserNavigating = false; zoomLevel = 0; zoomPanOffsetKm = 0; menuContent.classList.remove("open");
    loadSavedListsDropdown(); savedListsSelect.selectedIndex = 0; shopToggle.checked = true; localStorage.setItem("shopToggleState", "true");
    document.body.classList.remove("shop-off"); shopCard.style.display = "block"; mapDblClickToggle.checked = true; localStorage.setItem("mapDblClickState", "true");
    convenienceBtnToggle.checked = true; convenienceBtnWrapper.style.display = "block"; topRowGrid.classList.remove("convenience-off");
    update(true); alert("リセットが完了しました。");
  }
});

setInterval(() => update(false), 1000);
distance.addEventListener("input", () => { exitZoomView(); persistInputs(); update(true); });
pcInput.addEventListener("input", () => { persistInputs(); update(true); });
shopInput.addEventListener("input", () => { persistInputs(); update(true); });
startTime.addEventListener("change", () => { persistInputs(); update(false); });
brm.addEventListener("change", () => { persistInputs(); update(false); });
document.addEventListener("resume", () => update(false), false);
loadSavedListsDropdown();
update(true);
