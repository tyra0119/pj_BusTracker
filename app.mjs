// 全国バス・鉄道軌跡マップ: 地図（MapLibre）＋ deck.gl で、時刻表どおりのバスと軌跡を描く
import { Feed, Schedule, dayNumOf, dateKeyOf } from './engine.mjs?v=1fcc545-1123';
import { holidayName } from './holidays.mjs?v=1fcc545-1123';
import { Realtime } from './realtime.mjs?v=1fcc545-1123';

const { MapboxOverlay, TripsLayer, ScatterplotLayer, PathLayer, TextLayer, PolygonLayer, LineLayer, IconLayer } = deck;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (sec) => { sec = ((Math.floor(sec) % 86400) + 86400) % 86400; return `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`; };
const hhmmss = (sec) => `${hhmm(sec)}:${String(Math.floor(((sec % 60) + 60) % 60)).padStart(2, '0')}`;
const rgbCss = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const fmt = (n) => n.toLocaleString('ja-JP');
/** 暗い地図で映えるように、少し白に寄せる */
const bright = (c) => [Math.round(c[0] + (255 - c[0]) * 0.3), Math.round(c[1] + (255 - c[1]) * 0.3), Math.round(c[2] + (255 - c[2]) * 0.3), 255];

// ---------- 地図 ----------
const STYLES = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
};
let theme = 'dark';
try { theme = localStorage.getItem('bt.theme') || 'dark'; } catch { /* 使えなくてもよい */ }
document.documentElement.dataset.theme = theme;
$('theme').value = theme;
// スマホ（指で触る・狭い画面）: 見ている範囲だけ読み、描く量と画素を減らす
const MOBILE = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const map = new maplibregl.Map({
  container: 'map',
  pixelRatio: Math.min(devicePixelRatio || 1, MOBILE ? 1.5 : 2),
  style: STYLES[theme],
  center: [137.2, 36.6],
  zoom: 4.6,
  minZoom: 3.5,
  maxZoom: 18,
  hash: 'map',
  attributionControl: { compact: true, customAttribution: 'バス・鉄道: 各事業者・自治体の GTFS-JP ほか（「出典」）／線形: 国土数値情報、© OpenStreetMap contributors' },
  pitchWithRotate: false,
});
// 地名は日本語で: CARTO の地図は縮尺によって英語名（name_en）や現地名（name。海は英語）を出すので、日本語名（name:ja）に差し替える
function japaneseLabels() {
  for (const l of map.getStyle().layers) {
    if (l.type !== 'symbol') continue;
    const tf = map.getLayoutProperty(l.id, 'text-field');
    // 地名・海・道路・施設の名前はすべて日本語名（name:ja）を優先する。海（太平洋・日本海など）は name が英語だった
    if (tf && /name/.test(JSON.stringify(tf))) map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ja'], ['get', 'name'], ['get', 'name_en']]);
  }
}
map.on('style.load', japaneseLabels);
// 重ねる地図（国土地理院の地理院タイル）: 暗い地図だけでは地域が分かりにくいときに、地名・境界・航空写真を半透明で重ねる
// （利用者の指定。2026-10-05）。地図の切り替え（setStyle）で消えるので、読み込むたびに足し直す。選んだものは覚えておく
const GSI = {
  pale: { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', max: 18 },
  std: { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', max: 18 },
  photo: { url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', max: 18 },
};
let overlayMap = '', overlayOp = 45;
try { overlayMap = localStorage.getItem('bt.overlay') || ''; overlayOp = +(localStorage.getItem('bt.overlayOp') || 45); } catch { /* 使えなくてもよい */ }
if (!GSI[overlayMap]) overlayMap = '';
$('overlayMap').value = overlayMap; $('overlayOp').value = String(overlayOp); $('overlayOpWrap').hidden = !overlayMap;
function applyOverlay() {
  if (!map.getStyle()) return;
  if (map.getLayer('gsi')) map.removeLayer('gsi');
  if (map.getSource('gsi')) map.removeSource('gsi');
  const g = GSI[overlayMap];
  if (!g) return;
  map.addSource('gsi', { type: 'raster', tiles: [g.url], tileSize: 256, minzoom: 2, maxzoom: g.max, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>' });
  map.addLayer({ id: 'gsi', type: 'raster', source: 'gsi', paint: { 'raster-opacity': overlayOp / 100, 'raster-fade-duration': 0 } });
}
map.on('style.load', applyOverlay);
$('overlayMap').onchange = (e) => {
  overlayMap = e.target.value;
  $('overlayOpWrap').hidden = !overlayMap;
  try { localStorage.setItem('bt.overlay', overlayMap); } catch { /* 使えなくてもよい */ }
  applyOverlay();
};
$('overlayOp').oninput = (e) => {
  overlayOp = +e.target.value;
  try { localStorage.setItem('bt.overlayOp', String(overlayOp)); } catch { /* 使えなくてもよい */ }
  if (map.getLayer('gsi')) map.setPaintProperty('gsi', 'raster-opacity', overlayOp / 100);
};
// 地図のボタン: 拡大・縮小・方角（押すと北を上に戻す。右ドラッグ・2 本指で回せる）・現在地・全体表示
map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true }), 'top-right');
const JAPAN = [[122.9, 24.0], [146.0, 45.6]];
class FitAllControl {
  onAdd() {
    const div = document.createElement('div');
    div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    div.innerHTML = '<button type="button" class="fitall" title="全体表示（日本全体）" aria-label="全体表示"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/></svg></button>';
    div.querySelector('button').onclick = () => { follow = false; map.fitBounds(JAPAN, { padding: 30, bearing: 0, duration: 900 }); };
    return div;
  }
  onRemove() {}
}
map.addControl(new FitAllControl(), 'top-right');

const overlay = new MapboxOverlay({ interleaved: false, layers: [], pickingRadius: MOBILE ? 10 : 7, useDevicePixels: MOBILE ? 1 : true, onHover, onClick });
map.addControl(overlay);

// ---------- 状態 ----------
const schedule = new Schedule();
let index = null;
const feeds = [];          // i -> Feed
const clock = { day: 0, t: 0, speed: 1, playing: true, live: true };
let trailLen = 600;
// 線と点の表示（上の札）: 線路（全国の線路 N02）・バス路線（バス停を結んだ線）・停留所と駅（全国のバス停 P11 を含む）
const LINES = [
  { key: 'track', label: '線路', help: '全国の鉄道の線路を出します。押すと、列車が走っているか・走っていない理由が分かります' },
  { key: 'busline', label: '路線バスの路線', help: '路線バス（一般の路線・コミュニティバス）の通り道を出します。押すとその系統を選べます' },
  { key: 'hwline', label: '高速バスの路線', help: '高速バス・空港バスの通り道を出します。押すとその系統を選べます' },
  { key: 'stops', label: '停留所・駅', help: '駅とバス停を出します（拡大すると出ます）。押すと発車の予定や、時刻表が無い理由が分かります' },
];
const RT_HELP = 'バス・電車が配信している「今の本当の位置」を出します（「いま」のときだけ）。色は時刻表との差、押すとその車両を追いかけます';
// 開いたときは毎回すべてオフ（利用者の指定。2026-10-04）。前回の切り替えは覚えない
const lineOn = { track: false, busline: false, hwline: false, stops: false };
// 表示する乗り物: 0 路線バス / 1 高速バス / 2 鉄道 / 3 デマンド交通（上の札で切り替える）
const MODES = [
  { key: 'bus', label: '路線バス', unit: '台', color: [255, 196, 0] },
  { key: 'hw', label: '高速バス', unit: '台', color: [56, 214, 255] },
  { key: 'rail', label: '鉄道', unit: '本', color: [120, 255, 160] },
  { key: 'demand', label: 'デマンド', unit: '区域', color: [255, 140, 70] },
];
const modeOn = [true, true, true, true];
try { const v = JSON.parse(localStorage.getItem('bt.modes')); if (Array.isArray(v) && v.length === 4) v.forEach((x, i) => { modeOn[i] = !!x; }); } catch { /* 使えなくてもよい */ }
const kindOk = (rt) => modeOn[rt.mode];
let sel = null;            // 選んだ系統 { f, r, key }
let selTrip = null;        // 選んだ便 { f, k, at }（フィード・便番号・出発の日時。日をまたいでも同じ回の便を指す）
let selStop = null;        // 選んだ停留所 { f, s }
let follow = false;
let hoverRoute = null;     // ホバー中の路線 { f, r }

const jstNow = () => { const d = new Date(Date.now() + 9 * 3600e3); return { key: d.toISOString().slice(0, 10), sec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() + d.getUTCMilliseconds() / 1000 }; };
function goNow() {
  const n = jstNow();
  clock.live = true; clock.speed = 1; clock.playing = true;
  setDay(dayNumOf(n.key));
  clock.t = n.sec;
  syncControls();
}

// ---------- データ読み込み ----------
// パソコン: 全国分を全部読む。スマホ: 見ている範囲（少し広め）のデータだけを、合計の大きさに上限を設けて読み、
// 地図を動かしたら足りない分を読み、範囲から外れたものは手放す（全国 54 MB を一度に読むとスマホでは重い。2026-10-03）
// 読む単位は、近い場所のフィードをまとめたファイル（data/b/<k>.json、全国で 74 個。scripts/build-bundles.mjs）。
// フィードごとの 955 ファイルだと、GitHub Pages の中継サーバーにファイルが無いとき（しばらく誰も開かないと 10 分で消える）
// 1 ファイル約 0.2 秒かかり、全国分に 8〜30 秒かかった（2026-10-04）
const BUDGET = MOBILE ? 10 * 1048576 : Infinity;
let loadSeq = 0;
let units = [];               // まとまり { k, ids, bbox, size, trips }
const unitLoaded = new Set(); // 読み込んだまとまりの k
const loadingNow = new Set(); // 読み込み中のまとまりの k
async function loadAll() {
  const res = await fetch('./data/index.json?v=202610050209');
  index = await res.json();
  units = index.bundles ?? index.feeds.map((m) => ({ k: m.i, ids: [m.i], bbox: m.bbox, size: m.size, trips: m.trips, single: true }));
  renderSources();
  await syncFeeds();
  if (!MOBILE) $('load').textContent = `${fmt(index.feeds.length)} のデータ・${fmt(index.feeds.reduce((s, m) => s + m.trips, 0))} 便`;
  map.on('moveend', () => { if (MOBILE) { clearTimeout(syncTimer); syncTimer = setTimeout(syncFeeds, 700); } });
}
let syncTimer = null;
// フィードの取得と解析は Web Worker で（画面を止めない）。Worker が使えなければ画面側で
const workers = [];
const pending = new Map();
let reqId = 0;
try {
  for (let k = 0; k < (MOBILE ? 2 : 3); k++) {
    const w = new Worker('./feed-worker.mjs?v=1fcc545-1123', { type: 'module' });
    w.onmessage = (e) => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.data); };
    w.onerror = () => { w.broken = true; };
    workers.push(w);
  }
} catch { /* Worker が使えない */ }
/** まとまり u のフィードを、ids の順の配列で返す（Worker で詰めたもの、または JSON そのもの） */
function fetchUnit(u) {
  const url = new URL(u.single ? `./data/f/${u.k}.json` : `./data/b/${u.k}.json?v=202610050209`, location.href).href;
  const plain = () => fetch(url).then((r) => r.json()).then((x) => (Array.isArray(x) ? x : [x]));
  const w = workers.filter((x) => !x.broken)[reqId % Math.max(1, workers.length)];
  if (!w) return plain();
  const id = ++reqId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); w.postMessage({ id, url }); })
    .catch(plain); // Worker で失敗したら画面側で
}
function dropUnit(u) {
  for (const i of u.ids) {
    const f = feeds[i];
    if (!f) continue;
    if (sel?.f === i || selStop?.f === i) clearSelection();
    feeds[i] = undefined; schedule.feeds[i] = undefined;
  }
  unitLoaded.delete(u.k);
}
async function syncFeeds() {
  if (!index) return;
  const seq = ++loadSeq;
  const c = map.getCenter();
  const dist = (m) => { const x = (m.bbox[0] + m.bbox[2]) / 2 - c.lng, y = (m.bbox[1] + m.bbox[3]) / 2 - c.lat; return x * x + y * y; };
  let list = [...units].sort((a, b) => dist(a) - dist(b));
  if (MOBILE) {
    const v = viewBounds(0.5);
    const inView = list.filter((u) => boxHit(u.bbox, v));
    // 見ている範囲で、まだ読んでいないもの（近い順）を予算まで足す。
    // 読んだものは予算を超えるまで手放さない（拡大・縮小のたびに手放して読み直すと、そのたびに固まった。2026-10-04）
    const want = new Set(inView.map((u) => u.k));
    let bytes = 0;
    const add = [];
    for (const u of inView) { if (bytes + u.size > BUDGET && add.length) break; bytes += u.size; add.push(u.k); }
    const byK = new Map(units.map((u) => [u.k, u]));
    let held = [...unitLoaded].reduce((t, k) => t + byK.get(k).size, 0) + add.filter((k) => !unitLoaded.has(k)).reduce((t, k) => t + byK.get(k).size, 0);
    let dropped = 0;
    if (held > BUDGET) {
      // 見ている範囲の外を、中心から遠い順に手放す
      const far = [...unitLoaded].map((k) => byK.get(k)).filter((u) => !want.has(u.k)).sort((a, b) => dist(b) - dist(a));
      for (const u of far) {
        if (held <= BUDGET) break;
        held -= u.size; dropUnit(u); dropped++;
      }
    }
    if (dropped) scheduleRebuild(true); // 手放したフィードの便を一覧に残さない（残ると毎フレームの更新が止まっていた）
    list = list.filter((u) => add.includes(u.k));
    const partial = add.length < inView.length;
    $('load').textContent = `見ている範囲 ${fmt(inView.reduce((t, u) => t + u.ids.length, 0))} データ${partial ? '（広域は一部。拡大すると全部）' : ''}`;
  }
  const queue = list.filter((u) => !unitLoaded.has(u.k) && !loadingNow.has(u.k));
  // 広く見ているとき（縮尺 9 未満）は、便の多いまとまりから読む（近い順だと、全国表示では中心の小さなデータが先で、
  // 東京・大阪などの光が最後まで出なかった。2026-10-04）。拡大しているときは近い順のまま
  if (map.getZoom() < 9) queue.sort((a, b) => b.trips - a.trips);
  const total = queue.reduce((t, u) => t + u.ids.length, 0);
  let done = 0;
  const step = async () => {
    while (queue.length && seq === loadSeq) {
      const u = queue.shift();
      loadingNow.add(u.k);
      try {
        const raws = await fetchUnit(u);
        if (MOBILE && seq !== loadSeq) continue; // 待つ間に地図が動いた
        u.ids.forEach((i, n) => {
          if (feeds[i] || !raws[n]) return;
          try { const f = new Feed(index.feeds[i], raws[n]); feeds[i] = f; schedule.addFeed(f); } catch (e) { console.warn('feed', i, e); }
        });
        unitLoaded.add(u.k);
        if (MOBILE) await new Promise((r) => requestAnimationFrame(() => r()));
      } catch (e) { console.warn('bundle', u.k, e); } finally { loadingNow.delete(u.k); }
      done += u.ids.length;
      $('load').textContent = `データ ${fmt(done)} / ${fmt(total)}`;
      // 読み込みの途中も便の一覧を作り直して、読めた所から走らせる（3 秒に 1 回まで）。
      // スマホは地図を動かしている最中には作り直さない（拡大・縮小の引っかかりになっていた）。以前は最初の 1 件と読み終わったときだけで、
      // 開いてから 10 秒ほど数台しか走らなかった（2026-10-04）
      scheduleRebuild();
    }
  };
  // 同時に取りに行く数（まとまりは全国で 74 個）
  await Promise.all(Array.from({ length: MOBILE ? 6 : 16 }, step));
  if (seq === loadSeq) {
    scheduleRebuild(true);
    if (MOBILE) $('load').textContent = `見ている範囲 ${fmt(feeds.filter(Boolean).length)} データ`;
  }
}
let rebuildTimer = null, lastRebuild = 0;
// 読み込み中の作り直しは 3 秒に 1 回まで（全国分の便の一覧を作り直すのは重い。1 件ごとに作り直すと読み込みが 30 秒を超えた）
function scheduleRebuild(now) {
  if (now) { clearTimeout(rebuildTimer); rebuildTimer = null; lastRebuild = Date.now(); rebuildDay(); return; }
  if (rebuildTimer) return;
  const wait = Math.max(50, lastRebuild + 3000 - Date.now());
  const fire = () => {
    if (MOBILE && map.isMoving()) { rebuildTimer = setTimeout(fire, 400); return; } // 動かし終わってから
    rebuildTimer = null; lastRebuild = Date.now(); rebuildDay();
  };
  rebuildTimer = setTimeout(fire, wait);
}
function rebuildDay() {
  schedIndex = null;
  const _t0 = performance.now();
  schedule.build(clock.day);
  trails.dirty = true;
  routesLayerDirty = true;
  drawHist();
  if (sel) refreshPanel();
  perf.log.push(['day', Math.round(performance.now() - _t0)]);
}
function setDay(day) {
  if (day === clock.day && schedule.day === day) return;
  clock.day = day;
  $('date').value = dateKeyOf(day);
  const k = dateKeyOf(day), dow = '月火水木金土日'[(new Date(`${k}T12:00:00Z`).getUTCDay() + 6) % 7];
  const hn = holidayName(k);
  $('dayType').textContent = hn ? `${dow}・${hn}` : dow;
  rebuildDay();
}

// ---------- 走っているバス ----------
let runBuf = new Int32Array(1 << 16);
let posBuf = new Float64Array(2 << 16);
let colBuf = new Uint8Array(4 << 16);
let radBuf = new Float32Array(1 << 16);
let runIdx = new Int32Array(1 << 16); // 描いた点 → 便
let nRun = 0, nAll = 0;
const nMode = [0, 0, 0, 0];   // 画面の中で走っている数（乗り物ごと）
const nModeAll = [0, 0, 0, 0]; // 読み込んだ全データの中
let nView = 0;
const tmp = [0, 0, 0];
function updateHeads() {
  if (runBuf.length < schedule.n) { const cap = 1 << Math.ceil(Math.log2(schedule.n + 1)); runBuf = new Int32Array(cap); runIdx = new Int32Array(cap); posBuf = new Float64Array(cap * 2); colBuf = new Uint8Array(cap * 4); radBuf = new Float32Array(cap); }
  const m = schedule.running(clock.t, runBuf);
  const z = map.getZoom();
  const r = z < 6 ? 1.6 : z < 8 ? 2.2 : z < 11 ? 3 : z < 14 ? 4.5 : 6;
  let q = 0;
  nMode.fill(0); nModeAll.fill(0); nView = 0;
  // 数は「画面の中」で数える（全国分を読んでいると、見ていない地域の列車で数が増減して分かりにくかった）
  const vb = map.getBounds(), vw = vb.getWest(), ve = vb.getEast(), vs = vb.getSouth(), vn = vb.getNorth();
  for (let k = 0; k < m; k++) {
    const j = runBuf[k];
    const fi = schedule.tf[j], feed = feeds[fi];
    if (!feed) continue;
    const pat = feed.pats[feed.trips[schedule.ti[j] * 4]];
    const rt = feed.routes[pat.r];
    nModeAll[rt.mode]++;
    schedule.position(j, clock.t, tmp);
    const inView = tmp[0] >= vw && tmp[0] <= ve && tmp[1] >= vs && tmp[1] <= vn;
    if (inView) nMode[rt.mode]++;
    if (!kindOk(rt)) continue;
    if (inView) nView++;
    runIdx[q] = j;
    posBuf[q * 2] = tmp[0]; posBuf[q * 2 + 1] = tmp[1];
    const c = rt.rgb;
    const on = !sel || (sel.f === fi && sel.r === pat.r);
    colBuf[q * 4] = c[0]; colBuf[q * 4 + 1] = c[1]; colBuf[q * 4 + 2] = c[2]; colBuf[q * 4 + 3] = on ? 255 : 40;
    radBuf[q] = rt.mode === 1 ? r * 1.7 + 1 : rt.mode === 2 ? r * 1.35 + 0.5 : r;
    q++;
  }
  nRun = q;
  nAll = m;
}

// ---------- 軌跡（時間の窓ごとに作り直す） ----------
const trails = { data: [], w0: 0, w1: -1, base: 0, dirty: true, zoomKey: '', bounds: null };
// 縮尺ごとの軌跡の細かさ（この距離 m 未満の点は間引く）。形状に沿ったまま間引くので、点（バス）と軌跡がずれない
const zoomTrail = (z) => Math.min(1.5, Math.max(0.12, 2 ** ((10 - z) * 0.8)));
// 軌跡の点の間隔: 1 画素の 0.6 倍（画面で見えない細かさは描かない）。整数の縮尺ごとに段階を分ける。
// 以前は縮尺 8〜10 で 80 m おき（1 画素は約 350 m）で、Android 実機・×300・関東で 11 fps だった（2026-10-05）
function lod(z) { const zi = Math.floor(z), gap = Math.round((128000 / 2 ** zi) * 0.6); return gap < 4 ? ['f', 0] : ['s', Math.min(1500, gap)]; }
function viewBounds(pad) {
  const b = map.getBounds();
  const dx = (b.getEast() - b.getWest()) * pad, dy = (b.getNorth() - b.getSouth()) * pad;
  return [b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy];
}
const boxHit = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
function buildTrails() {
  const _t0 = performance.now();
  // 早送りのときは軌跡を伸ばす（画面の上で 1.2 秒ぶんの尾になるように）
  // 尾の長さは縮尺に合わせる（画面の上でほぼ同じ長さに見えるように。拡大すると短く）
  const t = clock.t, L = trailLen ? Math.max(trailLen * zoomTrail(map.getZoom()), clock.speed * 1.2) : 0;
  trails.dirty = false;
  if (!L) { trails.data = []; trails.w0 = t; trails.w1 = t + 3600; return; }
  // 先の何秒ぶんまで作っておくか（作り直しの回数と、描く点の数のつり合い）。スマホは描く点を減らすため半分
  const H = Math.min(5400, Math.max(600, clock.speed * (MOBILE ? 4 : 8)));
  const z = map.getZoom();
  const [mode, gap] = lod(z);
  const bounds = MOBILE ? viewBounds(0.25) : z >= 7 ? viewBounds(0.6) : null;
  const w0 = clock.speed >= 0 ? t : t - H, w1 = w0 + H;
  const base = w0 - L;
  const data = [];
  for (const j of schedule.overlapping(w0 - L, w1)) {
    const fi = schedule.tf[j];
    if (!feeds[fi]) continue;
    if (bounds && !boxHit(feeds[fi].meta.bbox, bounds)) continue;
    { const fd = feeds[fi]; if (!kindOk(fd.routes[fd.pats[fd.trips[schedule.ti[j] * 4]].r])) continue; }
    const p = schedule.trailPath(j, Math.max(schedule.ts[j], w0 - L), Math.min(schedule.te[j], w1), base, false, gap);
    if (!p) continue;
    const feed = feeds[fi], pat = feed.pats[feed.trips[schedule.ti[j] * 4]];
    data.push({ path: p.path, ts: p.ts, c: feed.routes[pat.r].rgb, f: fi, r: pat.r, m: feed.routes[pat.r].mode });
  }
  perf.log.push(['trails', Math.round(performance.now() - _t0)]);
  Object.assign(trails, { data, w0, w1, base, L, zoomKey: mode + gap + (MOBILE ? '' : Math.round(map.getZoom())), bounds, version: (trails.version ?? 0) + 1 });
}
function ensureTrails() {
  const t = clock.t;
  if (trails.dirty || t < trails.w0 - 1 || t > trails.w1) buildTrails();
}
map.on('moveend', () => {
  const z = map.getZoom();
  const [mode, gap] = lod(z);
  if (mode + gap + (MOBILE ? '' : Math.round(z)) !== trails.zoomKey) trails.dirty = true;
  else if (trails.bounds) {
    const v = viewBounds(0);
    if (v[0] < trails.bounds[0] || v[1] < trails.bounds[1] || v[2] > trails.bounds[2] || v[3] > trails.bounds[3]) trails.dirty = true;
  } else if (z >= 7) trails.dirty = true;
  routesLayerDirty = true;
});

// ---------- 路線の線・停留所（見ている範囲の分だけ） ----------
let routesLayerDirty = true;
let routesPending = false;
// バスの路線の線は、背景の地図（MapLibre）の側で描く。バスを動かす描画部品（deck.gl）は毎フレーム画面全体を描き直すので、
// そこに動かない線を置くと、数十万点を毎フレーム描き直すことになった（Android 実機で ×300・東京 32 → 16 fps）。
// 背景の地図は地図を動かしたときだけ描き直す。作り直しはフレームごとに少しずつ（lineJob）（2026-10-05）
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const lineFC = { bus: EMPTY_FC, hw: EMPTY_FC }; // 最後に作った線（地図の切り替えで足し直すため）
let lineJob = null;   // 作り直しの途中（フレームごとに少しずつ）
let busLinesKey = '';
let stopPts = [];      // { p, f, s }（時刻表のある停留所・駅。見ている範囲）
let p11Pts = [];       // { p, name, op }（全国のバス停。見ている範囲）
/** バス路線の線: 全フィードの系統パターンの形状（同じ形は 1 本）。読み込みや表示の切り替えのときだけ作り直す */
// フィードごとに一度だけ作って覚えておき、表示の切り替えや読み込みのたびには並べ直すだけにする
// バス路線の線は重い（全国で数百万点）ので、縮尺で点を間引き（間隔 m）、見ている範囲のデータの分だけ描く（2026-10-04）
const busLod = (z) => (z < 7 ? 1500 : z < 9 ? 400 : z < 11 ? 80 : z < 14 ? 15 : 0);
function feedBusLines(feed, gap) {
  feed.busLines ??= {};
  if (feed.busLines[gap]) return feed.busLines[gap];
  // 系統パターンの形（同じ形は 1 本）を縮尺に合わせて間引き、座標を 1 本の配列に並べる（starts: 各線の始まりの点の番号）
  const out = { pos: null, starts: [], meta: [], n: 0 };
  const seen = new Set(), g2 = (gap / 111000) ** 2, xs = [];
  for (const p of feed.pats) {
    const m = feed.routes[p.r].mode;
    if (m > 1 || seen.has(p.g)) continue;
    seen.add(p.g);
    const sh = feed.shape(p.g), n = sh.lat.length;
    out.starts.push(xs.length / 2); out.meta.push({ f: feed.i, r: p.r, m });
    let lx = Infinity, ly = Infinity;
    for (let v = 0; v < n; v++) {
      const x = sh.lon[v] * Math.cos(sh.lat[v] * Math.PI / 180), y = sh.lat[v];
      if (v === 0 || v === n - 1 || (x - lx) ** 2 + (y - ly) ** 2 >= g2) { xs.push(sh.lon[v], sh.lat[v]); lx = x; ly = y; }
    }
  }
  out.pos = Float32Array.from(xs); out.n = xs.length / 2;
  return (feed.busLines[gap] = out);
}
let busLinesBounds = null;
function buildBusLines() {
  const z = map.getZoom(), gap = busLod(z);
  // 範囲は少し広めに取り、そこから出たときだけ作り直す
  const v = viewBounds(0);
  const inside = busLinesBounds && v[0] >= busLinesBounds[0] && v[1] >= busLinesBounds[1] && v[2] <= busLinesBounds[2] && v[3] <= busLinesBounds[3];
  const key = `${schedule.day}|${lastRebuild}|${modeOn[0]}|${modeOn[1]}|${lineOn.busline}|${lineOn.hwline}|${gap}`;
  if (!(key === busLinesKey && inside)) {
    busLinesKey = key;
    busLinesBounds = viewBounds(0.6);
    // 作り直しを始める（できるまでは前の線を出したまま）
    lineJob = { gap, queue: feeds.filter((f) => f && boxHit(f.meta.bbox, busLinesBounds)), parts: [], t0: performance.now() };
  }
  if (!lineJob) return;
  // 1 フレームに 6 ミリ秒まで、フィードごとに間引いた線を作る
  const until = performance.now() + 6;
  while (lineJob.queue.length && performance.now() < until) lineJob.parts.push(feedBusLines(lineJob.queue.shift(), lineJob.gap));
  if (lineJob.queue.length) return;
  // そろったら、路線バスと高速バスに分けて GeoJSON にし、背景の地図の線に渡す（タイルへの切り分けは地図の Worker で）
  const fc = (want) => {
    const features = [];
    for (const pt of lineJob.parts) for (let k = 0; k < pt.meta.length; k++) {
      if (!want(pt.meta[k].m)) continue;
      const a = pt.starts[k], b = k + 1 < pt.starts.length ? pt.starts[k + 1] : pt.n;
      if (b - a < 2) continue;
      const c = new Array(b - a);
      for (let v = a; v < b; v++) c[v - a] = [pt.pos[v * 2], pt.pos[v * 2 + 1]];
      features.push({ type: 'Feature', properties: { f: pt.meta[k].f, r: pt.meta[k].r }, geometry: { type: 'LineString', coordinates: c } });
    }
    return { type: 'FeatureCollection', features };
  };
  lineFC.bus = lineOn.busline && modeOn[0] ? fc((m) => m === 0) : EMPTY_FC;
  lineFC.hw = lineOn.hwline && modeOn[1] ? fc((m) => m === 1) : EMPTY_FC;
  map.getSource('bt-buslines')?.setData(lineFC.bus);
  map.getSource('bt-hwlines')?.setData(lineFC.hw);
  perf.log.push(['buslines', Math.round(performance.now() - lineJob.t0)]);
  lineJob = null;
}
// 背景の地図の線の層（地図の切り替えで消えるので、そのたびに足し直す）。地名の文字より下に
function addMapLineLayers() {
  if (!map.getStyle() || map.getSource('bt-buslines')) return;
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  const dark = theme === 'dark';
  map.addSource('bt-buslines', { type: 'geojson', data: lineFC.bus, tolerance: 0.5 });
  map.addSource('bt-hwlines', { type: 'geojson', data: lineFC.hw, tolerance: 0.5 });
  map.addLayer({ id: 'bt-buslines', type: 'line', source: 'bt-buslines', layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' }, paint: { 'line-color': dark ? '#ebc378' : '#965a00', 'line-opacity': dark ? 0.07 : 0.12, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.1, 14, 1.6] } }, firstSymbol);
  map.addLayer({ id: 'bt-hwlines', type: 'line', source: 'bt-hwlines', layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' }, paint: { 'line-color': dark ? '#5acdff' : '#006eaa', 'line-opacity': dark ? 0.25 : 0.4, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.9, 10, 1.4, 14, 2] } }, firstSymbol);
  // 線路: 新幹線は青、在来線は明るい灰青（バスの路線より上に）
  map.addSource('bt-tracks', { type: 'geojson', data: trackFC, tolerance: 0.5 });
  map.addLayer({ id: 'bt-tracks', type: 'line', source: 'bt-tracks', layout: { 'line-join': 'round', visibility: 'none' }, paint: {
    'line-color': ['case', ['==', ['get', 'kind'], 1], dark ? '#6ec3ff' : '#195ac8', dark ? '#c3d2e1' : '#465564'],
    'line-opacity': ['case', ['==', ['get', 'kind'], 1], 0.92, dark ? 0.78 : 0.82],
    'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['==', ['get', 'kind'], 1], 2.4, 1.8], 10, ['case', ['==', ['get', 'kind'], 1], 2.9, 2.2], 13, ['case', ['==', ['get', 'kind'], 1], 3.6, 2.7]] } }, firstSymbol);
  map.addLayer({ id: 'bt-tracks-hl', type: 'line', source: 'bt-tracks', filter: ['==', ['get', 'li'], -1], paint: { 'line-color': dark ? '#dcffe6' : '#005a3c', 'line-opacity': 0.85, 'line-width': 3.5 } }, firstSymbol);
  // 乗せた系統を白く
  map.addLayer({ id: 'bt-lines-hl', type: 'line', source: 'bt-buslines', filter: ['==', ['get', 'f'], -1], paint: { 'line-color': dark ? '#ffffff' : '#005a96', 'line-opacity': 0.85, 'line-width': 2.5 } }, firstSymbol);
  map.addLayer({ id: 'bt-hwlines-hl', type: 'line', source: 'bt-hwlines', filter: ['==', ['get', 'f'], -1], paint: { 'line-color': dark ? '#ffffff' : '#005a96', 'line-opacity': 0.85, 'line-width': 2.5 } }, firstSymbol);
  mapLinesDim = null; mapLinesHl = ''; mapTrackHl = -2;
}
let mapTrackHl = -2, hoverTrack = -1;
map.on('style.load', addMapLineLayers);
let mapLinesDim = null, mapLinesHl = '';
/** 毎フレーム: 選んでいる系統があれば線を暗く、乗せている系統を白く、札に合わせて出し入れ（変わったときだけ地図に伝える） */
function syncMapLines(dim) {
  if (!map.getLayer('bt-buslines')) { if (map.getStyle()) addMapLineLayers(); return; }
  if (hoverTrack !== mapTrackHl) { mapTrackHl = hoverTrack; map.setFilter('bt-tracks-hl', ['==', ['get', 'li'], hoverTrack]); }
  if (map.getLayoutProperty('bt-tracks', 'visibility') !== (lineOn.track ? 'visible' : 'none')) map.setLayoutProperty('bt-tracks', 'visibility', lineOn.track ? 'visible' : 'none');
  if (dim !== mapLinesDim) {
    mapLinesDim = dim;
    const dark = theme === 'dark';
    map.setPaintProperty('bt-tracks', 'line-opacity', dim ? 0.35 : ['case', ['==', ['get', 'kind'], 1], 0.92, dark ? 0.78 : 0.82]);
    map.setPaintProperty('bt-buslines', 'line-opacity', dim ? (dark ? 0.03 : 0.05) : (dark ? 0.07 : 0.12));
    map.setPaintProperty('bt-hwlines', 'line-opacity', dim ? (dark ? 0.08 : 0.12) : (dark ? 0.25 : 0.4));
  }
  const hl = hoverRoute ? `${hoverRoute.f}:${hoverRoute.r}` : '';
  if (hl !== mapLinesHl) {
    mapLinesHl = hl;
    const flt = hoverRoute ? ['all', ['==', ['get', 'f'], hoverRoute.f], ['==', ['get', 'r'], hoverRoute.r]] : ['==', ['get', 'f'], -1];
    map.setFilter('bt-lines-hl', flt); map.setFilter('bt-hwlines-hl', flt);
  }
  const vis = (on) => (on ? 'visible' : 'none');
  if (map.getLayoutProperty('bt-buslines', 'visibility') !== vis(lineOn.busline)) map.setLayoutProperty('bt-buslines', 'visibility', vis(lineOn.busline));
  if (map.getLayoutProperty('bt-hwlines', 'visibility') !== vis(lineOn.hwline)) map.setLayoutProperty('bt-hwlines', 'visibility', vis(lineOn.hwline));
}
/** 画面の点 (x, y) にあるバスの路線の線 { f, r, hw }。路線バスの線は縮尺 12 以上、高速バスは 9 以上で（広域で調べると重い） */
function mapLineAt(x, y) {
  const z = map.getZoom(), layers = [];
  if (lineOn.track && z >= 9 && map.getLayer('bt-tracks')) layers.push('bt-tracks');
  if (lineOn.hwline && z >= 9 && map.getLayer('bt-hwlines')) layers.push('bt-hwlines');
  if (lineOn.busline && z >= 12 && map.getLayer('bt-buslines')) layers.push('bt-buslines');
  if (!layers.length) return null;
  const r = MOBILE ? 10 : 5;
  const f = map.queryRenderedFeatures([[x - r, y - r], [x + r, y + r]], { layers })[0];
  if (!f) return null;
  if (f.layer.id === 'bt-tracks') return { track: true, li: f.properties.li, kind: f.properties.kind };
  return { f: f.properties.f, r: f.properties.r, hw: f.layer.id === 'bt-hwlines' };
}
function buildRouteLines() {
  const _t0 = performance.now();
  queueMicrotask(() => perf.log.push(['lines', Math.round(performance.now() - _t0)]));
  routesLayerDirty = false;
  stopPts = []; p11Pts = [];
  const z = map.getZoom();
  stationView = [];
  if (lineOn.stops && z >= 10) {
    const vb = viewBounds(0.3);
    for (const st of stations) if (st.p[0] >= vb[0] && st.p[0] <= vb[2] && st.p[1] >= vb[1] && st.p[1] <= vb[3]) stationView.push(st);
  }
  if (!lineOn.stops || z < 13) return;
  const bounds = viewBounds(0.3);
  for (const feed of feeds) {
    if (!feed || !boxHit(feed.meta.bbox, bounds)) continue;
    for (let s = 0; s < feed.stopLat.length; s++) {
      const lon = feed.stopLon[s], lat = feed.stopLat[s];
      if (lon < bounds[0] || lon > bounds[2] || lat < bounds[1] || lat > bounds[3]) continue;
      stopPts.push({ p: [lon, lat], f: feed.i, s });
    }
  }
  // 全国のバス停（国土数値情報 P11）。0.5 度の格子を見ている範囲だけ読む
  for (let y = Math.floor(bounds[1] * 2); y <= Math.floor(bounds[3] * 2); y++) {
    for (let x = Math.floor(bounds[0] * 2); x <= Math.floor(bounds[2] * 2); x++) {
      const c = p11Cell(`${y}_${x}`);
      if (!c) continue;
      for (let i = 0; i < c.lat.length; i++) {
        const lon = c.lon[i], lat = c.lat[i];
        if (lon < bounds[0] || lon > bounds[2] || lat < bounds[1] || lat > bounds[3]) continue;
        p11Pts.push({ p: [lon, lat], name: c.names[i], op: c.ops[c.op[i]] });
      }
    }
  }
}
const p11Cells = new Map();
let p11Index = null;
function p11Cell(k) {
  if (!p11Index || !p11Index.has(k)) return null;
  const c = p11Cells.get(k);
  if (c && c !== 'loading') return c;
  if (!c) {
    p11Cells.set(k, 'loading');
    fetch(`./data/p11/${k}.json`).then((r) => r.json()).then((d) => {
      const pts = decodePoly(d.pts);
      p11Cells.set(k, { lat: pts.lat, lon: pts.lon, names: d.names, ops: d.ops, op: d.op });
      routesLayerDirty = true;
    }).catch(() => p11Cells.delete(k));
  }
  return null;
}
// 線路（国土数値情報 N02）
let trackLines = [];
// 線路も背景の地図の側で描く（動かない線を描画部品に置くと毎フレーム描き直し、Android 実機で ×300・東京 29 → 17 fps に落ちた。2026-10-05）
const trackFC = { type: 'FeatureCollection', features: [] };
let stations = [];  // 全国の駅（国土数値情報 N02）{ p, name, lines: [[会社, 路線]] }
let stationView = []; // 見ている範囲の駅
let railStatus = {};
// リアルタイムの位置（GTFS-RT）。「いま」のときだけ
const rt = new Realtime();
// 開いたときは毎回オフ（利用者の指定。2026-10-04）。前回の切り替えは覚えない
let rtOn = false;
let rtData = [];      // { lon, lat, sp: [lon,lat]|null, delay: 秒|null, j, v }
let rtTick = 0;
let schedIndex = null; // `${フィード}:${便番号}` → 便の通し番号（その日） // N02 の会社名 → { name, status, reason, contact, where }（scripts/build-rail-status.mjs）
let trackMeta = [];
async function loadStatic() {
  try {
    const r = await fetch('./data/rail-lines.json');
    const d = await r.json();
    trackMeta = d.lines.map(([name, op, kind]) => ({ name, op, kind }));
    d.lines.forEach(([, , kind, segs], li) => {
      for (const sgm of segs) {
        const pts = decodePoly(sgm);
        const path = new Float64Array(pts.lat.length * 2);
        for (let v = 0; v < pts.lat.length; v++) { path[v * 2] = pts.lon[v]; path[v * 2 + 1] = pts.lat[v]; }
        trackLines.push({ path, li, kind });
        const c = new Array(pts.lat.length);
        for (let v = 0; v < pts.lat.length; v++) c[v] = [pts.lon[v], pts.lat[v]];
        trackFC.features.push({ type: 'Feature', properties: { li, kind }, geometry: { type: 'LineString', coordinates: c } });
      }
    });
    map.getSource('bt-tracks')?.setData(trackFC);
  } catch (e) { console.warn('rail-lines', e); }
  try {
    await rt.load();
    const sr = await fetch('./data/stations.json');
    if (sr.ok) stations = (await sr.json()).stations.map(([name, lat, lon, lines]) => ({ p: [lon, lat], name, lines }));
    routesLayerDirty = true;
  } catch (e) { console.warn('stations', e); }
  try {
    const rs = await fetch('./data/rail-status.json');
    if (rs.ok) railStatus = await rs.json();
  } catch (e) { console.warn('rail-status', e); }
  try {
    const r = await fetch('./data/p11-index.json');
    p11Index = new Set((await r.json()).cells);
    routesLayerDirty = true;
  } catch (e) { console.warn('p11', e); }
}
function decodePoly(str) {
  const lat = [], lon = [];
  let i = 0, a = 0, b = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, c;
      do { c = str.charCodeAt(i++) - 63; result |= (c & 0x1f) << shift; shift += 5; } while (c >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) { a += d; lat.push(a / 1e5); } else { b += d; lon.push(b / 1e5); }
    }
  }
  return { lat, lon };
}

// ---------- 選んだ系統 ----------
let selGeom = null; // { lines: [{path}], stops: [{p, name}] }
function selectRoute(f, r, opts = {}) {
  sel = { f, r };
  const feed = feeds[f];
  const lines = [], stops = new Map();
  const seen = new Set();
  for (const p of feed.pats) {
    if (p.r !== r) continue;
    if (!seen.has(p.g)) {
      seen.add(p.g);
      const sh = feed.shape(p.g);
      const path = new Float64Array(sh.lat.length * 2);
      for (let v = 0; v < sh.lat.length; v++) { path[v * 2] = sh.lon[v]; path[v * 2 + 1] = sh.lat[v]; }
      lines.push({ path });
    }
    for (const s of p.s) if (!stops.has(s)) stops.set(s, { p: [feed.stopLon[s], feed.stopLat[s]], name: feed.stopNames[s], s });
  }
  selGeom = { lines, stops: [...stops.values()], c: feed.routes[r].rgb };
  if (!opts.keepTrip) selTrip = null;
  if (!opts.keepStop) selStop = null;
  if (opts.fit) fitRoute();
  refreshPanel();
}
const areaName = (feed, rt) => (rt.short || rt.long || feed.meta.name);
let panelArea = null;
function showArea(d) {
  sel = null; selGeom = null; selTrip = null; selStop = null;
  const feed = feeds[d.f], rt = feed.routes[d.r];
  $('panel').hidden = false;
  $('panelBody').innerHTML = `<h2><i class="sw" style="background:rgb(255,140,70)"></i>${esc(areaName(feed, rt))}<span class="badge m3">デマンド交通</span></h2>
    <p class="op">${esc(agencyName(feed, rt))}</p>
    <dl class="kv"><dt>いま</dt><dd>${d.on ? '受付中の時間帯' : '時間外'}</dd><dt>この日の時間帯</dt><dd>${d.wins.map(([a, b]) => `${hhmm(a)}〜${hhmm(b)}`).join('<br>')}</dd></dl>
    <p class="note">予約して乗る乗り物です。決まった時刻・経路で走らないので、地図には乗れる区域（停留所を囲んだ範囲）を、受付の時間帯に光らせて出しています。乗り方は事業者の案内で確かめてください。</p>
    <p class="note">出典: ${esc(feed.meta.name)}（${esc(feed.meta.src)}・${esc(feed.meta.license)}）</p>`;
  panelArea = d;
}
// 線路を押したとき: その近くを時刻表のデータのある列車が走っているか。走っていなければ、データが無い理由
function showTrack(t, coord) {
  const m = trackMeta[t.li];
  const [x, y] = coord ?? [0, 0];
  // 押した点から 300 m 以内を通る鉄道の系統（読み込んであるもの）
  const near = new Map();
  const tol = 0.003;
  for (const feed of feeds) {
    if (!feed || !feed.routes.some((r) => r.mode === 2)) continue;
    const bb = feed.meta.bbox;
    if (x < bb[0] - 0.05 || x > bb[2] + 0.05 || y < bb[1] - 0.05 || y > bb[3] + 0.05) continue;
    const seen = new Set();
    for (const p of feed.pats) {
      if (feed.routes[p.r].mode !== 2 || seen.has(p.g)) continue;
      seen.add(p.g);
      const sh = feed.shape(p.g);
      for (let v = 0; v < sh.lat.length; v++) {
        if (Math.abs(sh.lon[v] - x) < tol && Math.abs(sh.lat[v] - y) < tol) { near.set(`${feed.i}:${p.r}`, { f: feed.i, r: p.r }); break; }
      }
    }
  }
  sel = null; selGeom = null; selTrip = null; selStop = null; panelArea = { track: true };
  let h = `<h2><i class="sw" style="background:#96afa5"></i>${esc(m.name)}</h2><p class="op">${esc(m.op)}</p>`;
  if (near.size) {
    h += '<p>この線路では、時刻表どおりに列車を走らせています。路線を押すと選べます。</p><div class="rt-pick">';
    for (const { f, r } of near.values()) {
      const rt = feeds[f].routes[r];
      h += `<button type="button" data-route="${f}:${r}"><i class="sw" style="background:${rgbCss(rt.rgb)}"></i>${esc(routeName(rt))}<small>${esc(feeds[f].meta.name.replace(/（.*$/, ''))}</small></button>`;
    }
    h += '</div>';
  } else {
    const st = railStatus[m.op];
    h += '<p><b>この路線は、時刻表のデータが無いため列車を走らせていません。</b></p>';
    if (!st) {
      h += '<p class="note">公開されている時刻表のオープンデータ（GTFS など）が見つかっていません。会社のサイトの時刻表を使ってよいかは、まだ詳しく調べていません。</p>';
    } else if (st.status === 'prohibited') {
      h += '<p class="note">この会社の時刻表は、公開元の利用規約や robots.txt で、機械的な取得・加工・二次利用が禁じられています。そのため使っていません。</p>';
    } else if (st.status === 'unknown') {
      h += '<p class="note">公開されている時刻表をこの地図で使ってよいか、利用規約からは判断できません（「無断複製の禁止」などの一般的な定めだけ、または規約が見つからない）。会社に確認できれば使える可能性があります。</p>';
    } else {
      h += '<p class="note">時刻表は使ってよいと判断しましたが、まだ取り込めていません（PDF の文字が読み取れないなど）。</p>';
    }
    if (st) {
      const linkify = (txt) => esc(txt).replace(/https?:\/\/[^\s）)」<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
      h += `<dl class="kv"><dt>調べた会社</dt><dd>${esc(st.name)}</dd><dt>根拠</dt><dd>${linkify(st.reason)}</dd>`;
      if (st.where) h += `<dt>公式の時刻表</dt><dd><a href="${esc(st.where)}" target="_blank" rel="noopener">${esc(st.where)}</a></dd>`;
      if (st.contact && st.status !== 'prohibited') h += `<dt>問い合わせ先</dt><dd>${/^https?:/.test(st.contact) ? `<a href="${esc(st.contact)}" target="_blank" rel="noopener">${esc(st.contact)}</a>` : esc(st.contact)}</dd>`;
      h += '</dl>';
    }
    h += '<p class="note">線路の位置は国土数値情報（鉄道データ）です。調査日 2026-10-03。</p>';
  }
  $('panel').hidden = false;
  $('panelBody').innerHTML = h;
}
// 駅を押したとき: 通る路線ごとに、時刻表どおりに列車を走らせているか。走らせていれば発車の予定、無ければ理由
// 会社の名前（N02 の正式な社名）と、データの事業者名（GTFS の agency・データの名前）を結ぶための通称
const OP_ALIAS = { 東日本旅客鉄道: ['JR東日本', 'JR東'], 東京地下鉄: ['東京メトロ'], 東京都: ['都営', '東京都交通局'], 横浜市: ['横浜市営', '横浜市交通局'], 京都市: ['京都市営', '京都市交通局'], 名古屋市: ['名古屋市営', '名古屋市交通局'], 札幌市: ['札幌市営', '札幌市交通局'], 仙台市: ['仙台市地下鉄', '仙台市交通局'], 福岡市: ['福岡市地下鉄', '福岡市交通局'], 鹿児島市: ['鹿児島市電', '鹿児島市交通局'], 熊本市: ['熊本市電', '熊本市交通局'], 函館市: ['函館市電', '函館市企業局'], 首都圏新都市鉄道: ['つくばエクスプレス', 'MIR'], 東京臨海高速鉄道: ['りんかい', 'TWR'], 多摩都市モノレール: ['多摩モノレール'], 京浜急行電鉄: ['京急'], 東急電鉄: ['東急'], 沖縄都市モノレール: ['ゆいレール'], 高松琴平電気鉄道: ['ことでん'], とさでん交通: ['とさでん'] };
function opServedBy(op, feed) {
  const core = op.replace(/株式会社|（株）/g, '').trim();
  const names = [feed.meta.name, feed.meta.org, ...(feed.meta.agencies ?? []), ...feed.agencies.map((a) => a[0])].filter(Boolean).join(' ');
  return names.includes(core) || (OP_ALIAS[core] ?? []).some((a) => names.includes(a));
}
function showStation(st) {
  const [x, y] = st.p;
  // 300 m 以内の、時刻表のある鉄道の駅（読み込んであるもの）
  let best = null;
  const served = new Map(); // N02 の会社 → [{ f, r }]
  for (const feed of feeds) {
    if (!feed || !feed.routes.some((r) => r.mode === 2)) continue;
    const bb = feed.meta.bbox;
    if (x < bb[0] - 0.01 || x > bb[2] + 0.01 || y < bb[1] - 0.01 || y > bb[3] + 0.01) continue;
    const near = new Set();
    for (let s = 0; s < feed.stopLat.length; s++) {
      const dx = (feed.stopLon[s] - x) * 0.82, dy = feed.stopLat[s] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.0027 ** 2) continue;
      near.add(s);
      if (!best || d2 < best.d2) best = { f: feed.i, s, d2 };
    }
    if (!near.size) continue;
    const routes = new Set();
    for (const p of feed.pats) if (feed.routes[p.r].mode === 2) for (const s of p.s) if (near.has(s)) { routes.add(p.r); break; }
    for (const [op] of st.lines) if (opServedBy(op, feed)) for (const r of routes) { if (!served.has(op)) served.set(op, []); served.get(op).push({ f: feed.i, r }); }
  }
  sel = null; selGeom = null; selTrip = null; selStop = null; panelArea = { station: true };
  let h = `<h2><i class="sw" style="background:#ebf0f5;border:1px solid #888"></i>${esc(st.name)}駅</h2>`;
  const ops = [...new Set(st.lines.map(([o]) => o))];
  for (const op of ops) {
    const ls = st.lines.filter(([o]) => o === op).map(([, l]) => l);
    h += `<h3>${esc(op)}　${esc(ls.join('・'))}</h3>`;
    const sv = served.get(op);
    if (sv?.length) {
      h += '<p class="note">時刻表どおりに列車を走らせています。</p><div class="rt-pick">';
      const seen = new Set();
      for (const { f, r } of sv) {
        if (seen.has(`${f}:${r}`)) continue;
        seen.add(`${f}:${r}`);
        const rt = feeds[f].routes[r];
        h += `<button type="button" data-route="${f}:${r}"><i class="sw" style="background:${rgbCss(rt.rgb)}"></i>${esc(routeName(rt))}</button>`;
      }
      h += '</div>';
    } else {
      const rs = railStatus[op];
      const why = !rs ? '時刻表のオープンデータが見つかっていません（まだ詳しく調べていません）。'
        : rs.status === 'prohibited' ? '時刻表は、公開元の利用規約や robots.txt で機械的な取得・加工が禁じられているため使っていません。'
        : rs.status === 'unknown' ? '公開されている時刻表を使ってよいか規約から判断できないため、使っていません（会社への確認が必要）。'
        : '時刻表は使ってよいと判断しましたが、まだ取り込めていません。';
      h += `<p class="note"><b>列車を走らせていません。</b>${why}</p>`;
      if (rs?.contact && rs.status !== 'prohibited') h += `<p class="note">問い合わせ先: ${/^https?:/.test(rs.contact) ? `<a href="${esc(rs.contact)}" target="_blank" rel="noopener">${esc(rs.contact)}</a>` : esc(rs.contact)}</p>`;
    }
  }
  if (best && served.size) {
    // 時刻表のある駅なら、この先の発車も出す
    selStop = { f: best.f, s: best.s };
    h += stopSection().replace(/<h2>.*?<\/h2>/, '').replace(/<p class="op">.*?<\/p>/, '');
    selStop = null;
  }
  h += '<p class="note">駅の位置・名前・路線は国土数値情報（鉄道データ）です。</p>';
  $('panel').hidden = false;
  $('panelBody').innerHTML = h;
}
// 時刻表のデータが無いバス停（国土数値情報 P11）を押したとき
function showP11(o) {
  sel = null; selGeom = null; selTrip = null; selStop = null; panelArea = { p11: true };
  $('panel').hidden = false;
  $('panelBody').innerHTML = `<h2><i class="sw" style="background:#7a828c"></i>${esc(o.name)}</h2><p class="op">${esc(o.op)}</p>
    <p><b>このバス停は、時刻表のデータが無いためバスを走らせていません。</b></p>
    <p class="note">この事業者の時刻表（GTFS など）が公開されていないか、まだ見つかっていません。公開されている事業者の時刻表を使ってよいかは、事業者ごとに利用規約を確かめています。</p>
    <p class="note">バス停の位置と名前は国土数値情報（バス停留所データ P11、2022 年）です。今は廃止されている・名前が変わっている場合があります。</p>`;
}
function clearSelection() {
  panelArea = null;
  rtFollow = null;
  sel = null; selGeom = null; selTrip = null; selStop = null; follow = false;
  $('panel').hidden = true;
}
function fitRoute() {
  if (!selGeom) return;
  let b = [180, 90, -180, -90];
  for (const s of selGeom.stops) { b = [Math.min(b[0], s.p[0]), Math.min(b[1], s.p[1]), Math.max(b[2], s.p[0]), Math.max(b[3], s.p[1])]; }
  const narrow = innerWidth < 760;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: narrow ? { top: 120, bottom: 360, left: 30, right: 30 } : { top: 100, bottom: 160, left: 60, right: 420 }, maxZoom: 15, duration: 900 });
}
// 乗り物ごとの言葉（鉄道は 列車・駅・本、ほかは バス・停留所・台）
const words = (rt) => (rt?.mode === 2 ? { v: '列車', stop: '駅', unit: '本', line: '路線' } : { v: 'バス', stop: '停留所', unit: '台', line: '系統' });
const routeName = (rt) => rt.short || rt.long || '（系統名なし）';
const agencyName = (feed, rt) => (feed.agencies[rt.ai]?.[0] || feed.meta.agencies?.[0] || feed.meta.org || feed.meta.name);

/** 今日のこの系統の便: [{ j, pat, start, end }] */
function routeTrips(f, r) {
  const out = [];
  const feed = feeds[f];
  for (let j = 0; j < schedule.n; j++) {
    if (schedule.tf[j] !== f) continue;
    const pat = feed.pats[feed.trips[schedule.ti[j] * 4]];
    if (pat.r === r) out.push({ j, pat, start: schedule.ts[j], end: schedule.te[j] });
  }
  return out;
}
// 選んだ便を、いまの便の一覧から探す。同じ便（f, k）は、その日の便と前日の便（−24 時間）の 2 回入ることがあるので、
// 選んだときの出発の日時（at = 日 × 86400 + 出発の秒）で同じ回を探す。日付をまたぐと、前日 22:40 発の夜行バスを
// 追いかけているのに、その日の 22:40 発（まだ出ていない）を選んで追いかけが外れていた（シルクライナー。2026-10-04）
function findTripIndex(f, k, at) {
  if (at != null) {
    const ts = at - schedule.day * 86400;
    for (let j = 0; j < schedule.n; j++) if (schedule.tf[j] === f && schedule.ti[j] === k && schedule.ts[j] === ts) return j;
  }
  for (let j = 0; j < schedule.n; j++) if (schedule.tf[j] === f && schedule.ti[j] === k && schedule.ts[j] <= clock.t && schedule.te[j] >= clock.t) return j;
  for (let j = 0; j < schedule.n; j++) if (schedule.tf[j] === f && schedule.ti[j] === k && schedule.ts[j] >= 0) return j;
  for (let j = 0; j < schedule.n; j++) if (schedule.tf[j] === f && schedule.ti[j] === k) return j;
  return -1;
}

// ---------- 情報欄 ----------
let panelTimer = 0;
function refreshPanel() {
  const body = $('panelBody');
  if (panelArea && !sel && !selStop) return;
  panelArea = null;
  if (!sel && !selStop) { $('panel').hidden = true; return; }
  $('panel').hidden = false;
  let h = '';
  if (selStop) h += stopSection();
  if (sel) h += routeSection();
  body.innerHTML = h;
}
function stopSection() {
  const feed = feeds[selStop.f], s = selStop.s;
  const name = feed.stopNames[s];
  // この停留所を通る系統と、この先の発車時刻
  const byRoute = new Map();
  for (let j = 0; j < schedule.n; j++) {
    if (schedule.tf[j] !== selStop.f) continue;
    const k = schedule.ti[j];
    const pat = feed.pats[feed.trips[k * 4]], prof = feed.profs[feed.trips[k * 4 + 1]];
    for (let q = 0; q < pat.s.length - 1; q++) {
      if (pat.s[q] !== s) continue;
      const dep = schedule.ts[j] + prof.dep[q];
      if (!byRoute.has(pat.r)) byRoute.set(pat.r, { n: 0, next: [] });
      const e = byRoute.get(pat.r);
      e.n++;
      if (dep >= clock.t - 30) e.next.push([dep, pat.h]);
    }
  }
  const routes = [...byRoute.entries()].sort((a, b) => b[1].n - a[1].n);
  let h = `<h2>${esc(name)}</h2><p class="op">${esc(feed.meta.name)}</p>`;
  const isRail = routes.length && routes.every(([r]) => feed.routes[r].mode === 2);
  const W = isRail ? words({ mode: 2 }) : words(null);
  if (!routes.length) return h + '<p class="note">この日にここを出るバス・列車はありません。</p>';
  h += `<h3>この${W.stop}を通る${W.line}（押すと選べます）</h3><div class="rt-pick">`;
  for (const [r, e] of routes) {
    const rt = feed.routes[r];
    h += `<button type="button" data-route="${selStop.f}:${r}" aria-pressed="${!!sel && sel.f === selStop.f && sel.r === r}"><i class="sw" style="background:${rgbCss(rt.rgb)}"></i>${esc(routeName(rt))}<small>${e.n}便</small></button>`;
  }
  h += '</div><h3>この先の発車</h3><div class="deps">';
  const all = routes.flatMap(([r, e]) => e.next.map(([d, hs]) => [d, r, hs])).sort((a, b) => a[0] - b[0]).slice(0, 8);
  h += all.length ? all.map(([d, r, hs]) => `${hhmm(d)}　${esc(routeName(feed.routes[r]))}　${esc(hs)} 行`).join('<br>') : 'この日の発車はもうありません';
  h += '</div>';
  return h;
}
function routeSection() {
  const feed = feeds[sel.f], rt = feed.routes[sel.r];
  const trips = routeTrips(sel.f, sel.r);
  const running = trips.filter((x) => x.start <= clock.t && x.end >= clock.t).length;
  const sub = schedule.substitutes.get(sel.f);
  let h = `<h2><i class="sw" style="background:${rgbCss(rt.rgb)}"></i>${esc(routeName(rt))}${rt.mode ? `<span class="badge m${rt.mode}">${MODES[rt.mode].label}</span>` : ''}</h2>`;
  const unofficial = /非公式/.test(feed.meta.license || '');
  h += `<p class="op">${unofficial ? '<span class="badge">非公式</span> ' : ''}${esc(agencyName(feed, rt))}${rt.long && rt.short ? `　${esc(rt.long)}` : ''}${sub != null ? `<span class="badge" title="時刻表の期間外なので ${dateKeyOf(sub)} のダイヤで走らせています">代わりのダイヤ</span>` : ''}</p>`;
  const W = words(rt);
  h += `<dl class="kv"><dt>この日の便</dt><dd>${fmt(trips.length)} ${rt.mode === 2 ? '本' : '便'}</dd><dt>いま走行中</dt><dd>${fmt(running)} ${W.unit}</dd>`;
  // 前日の深夜便（−24 時間して入れている）は除いて、この日の始発・最終
  const own = trips.filter((x) => x.start >= 0).map((x) => x.start);
  const day = own.filter((x) => x >= 3 * 3600);
  const late = (sec) => (sec >= 86400 ? `翌 ${hhmm(sec)}` : hhmm(sec));
  if (own.length) h += `<dt>始発・最終</dt><dd>${hhmm(Math.min(...(day.length ? day : own)))} 〜 ${late(Math.max(...own))} 発</dd>`;
  h += '</dl>';
  // 「追う」は、選んだ便がいま走っているときだけ（終点に着いた・まだ出ていない便は追えない）
  const tj = selTrip ? findTripIndex(selTrip.f, selTrip.k, selTrip.at) : -1;
  const tripRunning = tj >= 0 && schedule.ts[tj] <= clock.t && schedule.te[tj] >= clock.t;
  h += `<div class="act"><button type="button" data-act="fit">この${W.line}に寄る</button>${tripRunning ? `<button type="button" data-act="follow" aria-pressed="${follow}">${follow ? `追いかけ中（押すとやめる）` : `この${W.v}を追う`}</button>` : ''}<button type="button" data-act="close">閉じる</button></div>`;
  if (selTrip) h += tripSection();
  // 行先ごとの便数
  const byHead = new Map();
  for (const x of trips) { const k = x.pat.h; byHead.set(k, (byHead.get(k) ?? 0) + 1); }
  if (byHead.size) {
    h += '<h3>行先</h3><table class="pats">';
    for (const [hs, n] of [...byHead.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) h += `<tr><td>${esc(hs)} 行</td><td class="n">${n} 便</td></tr>`;
    h += '</table>';
  }
  if (feed.meta.note) h += `<p class="note">${esc(feed.meta.note)}</p>`;
  if (unofficial) h += '<p class="note"><b>非公式・非商用の表示です。この表示について事業者へ問い合わせないでください。</b>最新の時刻は事業者の案内で確かめてください。</p>';
  h += `<p class="note">出典: ${esc(feed.meta.name)}（${esc(feed.meta.src)}・${esc(feed.meta.license)}）。時刻表どおりの位置で、遅れや運休は入っていません。</p>`;
  return h;
}
function tripSection() {
  const j = findTripIndex(selTrip.f, selTrip.k, selTrip.at);
  if (j < 0) return '<p class="note">選んだ便は、この日は走りません。</p>';
  const { feed, pat, prof, start, end } = schedule.tripInfo(j);
  const t = clock.t;
  const state = t < start ? `${hhmm(start)} 発（まだ出ていません）` : t > end ? `${hhmm(end)} に到着しました` : '走行中';
  let h = `<h3>この${words(feed.routes[pat.r]).v}　${esc(pat.h)} 行 <span style="font-weight:400">— ${state}</span></h3><ol class="stops" style="--rc:${rgbCss(feed.routes[pat.r].rgb)}">`;
  let nextShown = false;
  for (let q = 0; q < pat.s.length; q++) {
    const tm = start + (q === 0 ? prof.dep[0] : prof.arr[q]);
    const past = tm < t;
    const next = !past && !nextShown && t >= start - 1800;
    if (next) nextShown = true;
    h += `<li class="${past ? 'past' : next ? 'next' : ''}"><span class="tm">${hhmm(tm)}</span><button type="button" data-stop="${feed.i}:${pat.s[q]}">${esc(feed.stopNames[pat.s[q]])}</button></li>`;
  }
  return h + '</ol>';
}
$('panelBody').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.route) { const [f, r] = b.dataset.route.split(':').map(Number); selectRoute(f, r, { keepStop: true }); }
  else if (b.dataset.stop) { const [f, s] = b.dataset.stop.split(':').map(Number); follow = false; map.easeTo({ center: [feeds[f].stopLon[s], feeds[f].stopLat[s]], zoom: Math.max(map.getZoom(), 15) }); }
  else if (b.dataset.act === 'fit') { follow = false; fitRoute(); }
  else if (b.dataset.act === 'follow') { follow = !follow; refreshPanel(); }
  else if (b.dataset.act === 'close') clearSelection();
  else if (b.dataset.act === 'rtfollow' && rtPanel) { rtFollow = rtFollow === rtPanel.key ? null : rtPanel.key; showRtVehicle(rtData.find((x) => x.key === rtPanel.key) ?? rtPanel, true); }
  else if (b.dataset.act === 'rtroute' && rtPanel?.j >= 0) { rtFollow = null; }
  if (b.dataset.act === 'rtroute' && rtPanel?.j >= 0) { const { feed, pat } = schedule.tripInfo(rtPanel.j); selTrip = { f: feed.i, k: schedule.ti[rtPanel.j], at: schedule.day * 86400 + schedule.ts[rtPanel.j] }; selectRoute(feed.i, pat.r, { keepTrip: true }); }
});
$('panelClose').onclick = clearSelection;

// ---------- ホバー・クリック ----------
const tip = $('tip');
/** バスの路線の線（binary）を押した・乗せたときの系統 { f, r } */
const lineObj = (info) => info.mapLine ?? null;
/** 描画部品の上に何も無いときは、背景の地図のバスの路線の線を調べる */
function withMapLine(info) {
  if (info.object || (info.layer?.id === 'buses' && info.index >= 0) || info.x == null) return info;
  const ml = mapLineAt(info.x, info.y);
  if (!ml) return info;
  if (ml.track) return { ...info, object: { li: ml.li, kind: ml.kind }, layer: { id: 'tracks' } };
  return { ...info, mapLine: ml, layer: { id: ml.hw ? 'hwroutes' : 'routes' } };
}
// 吹き出しはマウスを乗せたときの案内。指で触ったときは出さない（タップの直後にも「乗せた」扱いの呼び出しが来て、
// 選んだあとに吹き出しがまた出て情報欄に重なった。2026-10-04）
let touchedAt = 0;
addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { touchedAt = Date.now(); tip.hidden = true; } }, true);
map.on('movestart', () => { tip.hidden = true; });
function onHover(info) {
  info = withMapLine(info);
  hoverTrack = info.layer?.id === 'tracks' && info.object ? info.object.li : -1;
  map.getCanvas().style.cursor = info.object || info.mapLine || (info.layer?.id === 'buses' && info.index >= 0) ? 'pointer' : '';
  const lo = lineObj(info);
  const hr = lo ? { f: lo.f, r: lo.r } : null;
  if ((hr?.f !== hoverRoute?.f) || (hr?.r !== hoverRoute?.r)) hoverRoute = hr;
  if (Date.now() - touchedAt < 1500) { tip.hidden = true; return; }
  const o = describe(info);
  if (!o) { tip.hidden = true; return; }
  tip.innerHTML = o;
  tip.hidden = false;
  const x = Math.min(info.x + 14, innerWidth - 290), y = Math.max(8, info.y - 10 - tip.offsetHeight);
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
function describe(info) {
  if (!info.layer) return null;
  if (info.layer.id === 'buses' && info.index >= 0 && info.index < nRun) {
    const j = runIdx[info.index];
    const { feed, pat } = schedule.tripInfo(j);
    const rt = feed.routes[pat.r];
    return `<b>${rt.mode ? `${MODES[rt.mode].label}　` : ''}${esc(routeName(rt))}　${esc(pat.h)} 行</b><span>${esc(agencyName(feed, rt))}</span>`;
  }
  if (lineObj(info)) {
    const lo = lineObj(info), feed = feeds[lo.f], rt = feed.routes[lo.r];
    return `<b>${esc(routeName(rt))}</b><span>${esc(agencyName(feed, rt))}　押すと選べます</span>`;
  }
  if (info.layer.id === 'tracks' && info.object) {
    const m = trackMeta[info.object.li];
    return `<b>${esc(m.name)}</b><span>${esc(m.op)}　押すと列車の有無と理由が出ます</span>`;
  }
  if (info.layer.id === 'rt' && info.object) {
    const o = info.object;
    const name = o.j >= 0 ? (() => { const { pat, route } = schedule.tripInfo(o.j); return `${routeName(route)}　${pat.h} 行`; })() : feeds[o.v.i]?.meta.name ?? '';
    return `<b>実際の位置　${esc(name)}</b><span>${delayText(o.delay)}</span>`;
  }
  if (info.layer.id === 'stations' && info.object) {
    const st = info.object;
    return `<b>${esc(st.name)}駅</b><span>${esc([...new Set(st.lines.map(([o, l]) => l))].join('・'))}　押すと詳しく</span>`;
  }
  if (info.layer.id === 'p11' && info.object) {
    return `<b>${esc(info.object.name)}</b><span>${esc(info.object.op)}　時刻表のデータがまだ無いバス停（押すと説明）</span>`;
  }
  if (info.layer.id === 'areas' && info.object) {
    const d = info.object, feed = feeds[d.f], rt = feed.routes[d.r];
    return `<b>デマンド交通　${esc(areaName(feed, rt))}</b><span>${d.on ? '受付中の時間帯' : '時間外'}　${d.wins.map(([a, b]) => `${hhmm(a)}〜${hhmm(b)}`).join('、')}</span>`;
  }
  if ((info.layer.id === 'stops' || info.layer.id === 'selStops') && info.object) {
    const o = info.object, feed = feeds[o.f ?? sel?.f];
    return `<b>${esc(feed.stopNames[o.s])}</b><span>停留所・駅　押すと通る系統・路線が出ます</span>`;
  }
  return null;
}
function onClick(info) {
  tip.hidden = true;
  info = withMapLine(info);
  if (info.layer?.id === 'buses' && info.index >= 0 && info.index < nRun) {
    const j = runIdx[info.index];
    const fi = schedule.tf[j], k = schedule.ti[j];
    const feed = feeds[fi], pat = feed.pats[feed.trips[k * 4]];
    selTrip = { f: fi, k, at: schedule.day * 86400 + schedule.ts[j] };
    selectRoute(fi, pat.r, { keepTrip: true });
    return;
  }
  if (lineObj(info)) { const lo = lineObj(info); selectRoute(lo.f, lo.r); return; }
  if (info.layer?.id === 'areas' && info.object) { showArea(info.object); return; }
  if (info.layer?.id === 'tracks' && info.object) { showTrack(info.object, info.coordinate); return; }
  if (info.layer?.id === 'p11' && info.object) { showP11(info.object); return; }
  if (info.layer?.id === 'stations' && info.object) { showStation(info.object); return; }
  if (info.layer?.id === 'rt' && info.object) { showRtVehicle(info.object); return; }
  if ((info.layer?.id === 'stops' || info.layer?.id === 'selStops') && info.object) {
    const f = info.object.f ?? sel.f;
    selStop = { f, s: info.object.s };
    refreshPanel();
    return;
  }
  // 何も無い所を押したら選択を外す
  if (sel || selStop) clearSelection();
}

// ---------- リアルタイムの位置 ----------
// 印の絵（白で描き、色は deck の mask で付ける）: ひし形 = バス（時刻表のバスの丸と見分けるため）、角の丸い四角 = 電車
const RT_ICONS = (() => {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(32, 1); g.lineTo(63, 32); g.lineTo(32, 63); g.lineTo(1, 32); g.closePath(); g.fill();
  g.beginPath(); if (g.roundRect) g.roundRect(66, 2, 60, 60, 14); else g.rect(66, 2, 60, 60); g.fill();
  return { url: c.toDataURL(), mapping: { bus: { x: 0, y: 0, width: 64, height: 64, mask: true }, train: { x: 64, y: 0, width: 64, height: 64, mask: true } } };
})();
function schedLookup(f, k) {
  if (!schedIndex) {
    schedIndex = new Map();
    for (let j = 0; j < schedule.n; j++) { const key = `${schedule.tf[j]}:${schedule.ti[j]}`; if (!schedIndex.has(key) || schedule.ts[j] >= 0) schedIndex.set(key, j); }
  }
  return schedIndex.get(`${f}:${k}`);
}
/** 実際の位置が、時刻表ではいつの位置か → 遅れ（秒。正なら遅れ）。形状上のいちばん近い点で見る */
function delayOf(j, lon, lat, at = clock.t) {
  const { feed, pat, prof, start } = schedule.tripInfo(j);
  const sh = feed.shape(pat.g);
  const kx = Math.cos(lat * Math.PI / 180);
  let best = 0, bd = Infinity;
  for (let v = 0; v < sh.lat.length; v++) { const dx = (sh.lon[v] - lon) * kx, dy = sh.lat[v] - lat; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = v; } }
  if (Math.sqrt(bd) * 111000 > 800) return null; // 経路から 800 m 以上離れている: 便の結びつけが怪しい
  const dist = sh.cum[best], d = pat.d, arr = prof.arr, dep = prof.dep, n = d.length;
  let k = 0;
  while (k < n - 2 && d[k + 1] < dist) k++;
  const f = d[k + 1] > d[k] ? Math.min(1, Math.max(0, (dist - d[k]) / (d[k + 1] - d[k]))) : 0;
  const tAt = start + dep[k] + f * (arr[k + 1] - dep[k]);
  const delay = at - tAt;
  return Math.abs(delay) > 3 * 3600 ? null : delay;
}
const rtFeedOk = (i) => { const f = feeds[i]; if (!f) return false; const v = viewBounds(0.2); return boxHit(f.meta.bbox, v); };
function updateRealtime() {
  if (!rtOn || !clock.live) { rtData = []; return; }
  rt.poll(rtFeedOk);
  const out = [];
  for (const v of rt.vehicles(rtFeedOk)) {
    const map_ = rt.tripMap(v.i);
    const k = map_?.get(v.tripId);
    const j = k != null ? schedLookup(v.i, k) : undefined;
    let delay = null;
    // 位置を測った時刻（その日の 0 時からの秒）。無ければいま
    let at = clock.t;
    if (v.ts) { at = ((v.ts + 9 * 3600) % 86400); if (at - clock.t > 43200) at -= 86400; if (clock.t - at > 43200) at += 86400; }
    if (j != null) delay = delayOf(j, v.lon, v.lat, at);
    const feed = feeds[v.i];
    const rail = j != null ? schedule.tripInfo(j).route.mode === 2 : !!feed && feed.routes.some((r) => r.mode === 2) && !feed.routes.some((r) => r.mode !== 2);
    const key = `${v.name}|${v.id || v.tripId}`;
    out.push({ key, lon: v.lon, lat: v.lat, rlon: v.lon, rlat: v.lat, sp: null, delay, j: j ?? -1, v, rail });
  }
  rtData = out;
}
// 毎フレーム: 時刻表に結べた車両は、測った位置から求めた遅れの分だけずらして時刻表に沿って動かす（位置の配信は 30 秒ごとなので、そのままだと飛ぶ）
const rtTmp = [0, 0, 0];
function moveRealtime() {
  for (const d of rtData) {
    d.sp = null;
    if (d.j < 0) continue;
    const ts = schedule.ts[d.j], te = schedule.te[d.j];
    if (ts <= clock.t && te >= clock.t) { schedule.position(d.j, clock.t, rtTmp); d.sp = [rtTmp[0], rtTmp[1]]; }
    if (d.delay == null) continue;
    const tt = clock.t - d.delay;
    if (tt >= ts && tt <= te) { schedule.position(d.j, tt, rtTmp); d.lon = rtTmp[0]; d.lat = rtTmp[1]; }
  }
  if (rtFollow) {
    const d = rtData.find((x) => x.key === rtFollow);
    if (d) followTo(d.lon, d.lat);
  }
}
let rtFollow = null; // 追いかけている車両の key
const delayColor = (d) => (d == null ? [200, 205, 215] : d > 300 ? [255, 80, 80] : d > 120 ? [255, 200, 0] : d < -60 ? [90, 170, 255] : [80, 225, 130]);
const delayText = (d) => (d == null ? '時刻表の便と結べませんでした' : Math.abs(d) < 60 ? 'ほぼ時刻表どおり' : d > 0 ? `約 ${Math.round(d / 60)} 分遅れ` : `約 ${Math.round(-d / 60)} 分早い`);
function showRtVehicle(o, keepFollow) {
  sel = null; selGeom = null; selTrip = null; selStop = null; panelArea = { rt: true };
  if (!keepFollow) { rtFollow = o.key; follow = false; }
  const feed = feeds[o.v.i];
  let h = `<h2><i class="sw" style="background:${rgbCss(delayColor(o.delay))};border-radius:${o.rail ? '3px' : '1px'};${o.rail ? '' : 'transform:rotate(45deg) scale(.85);'}"></i>実際の位置（${o.rail ? '電車' : 'バス'}）</h2>`;
  if (o.j >= 0) {
    const { pat, route } = schedule.tripInfo(o.j);
    h += `<p class="op">${esc(agencyName(feed, route))}　${esc(routeName(route))}　${esc(pat.h)} 行</p>`;
    h += `<dl class="kv"><dt>時刻表との差</dt><dd><b>${delayText(o.delay)}</b></dd>`;
  } else {
    h += `<p class="op">${esc(feed?.meta.name ?? '')}</p><dl class="kv"><dt>時刻表との差</dt><dd>${delayText(null)}</dd>`;
  }
  const at = o.v.ts ? new Date(o.v.ts * 1000 + 9 * 3600e3).toISOString().slice(11, 19) : '—';
  h += `<dt>位置の時刻</dt><dd>${at}</dd>${o.v.label ? `<dt>車両</dt><dd>${esc(o.v.label)}</dd>` : ''}</dl>`;
  const gone = !rtData.some((x) => x.key === o.key);
  if (gone) h += `<p class="note" style="margin-top:0">この車両の位置が届かなくなりました（運行を終えたか、配信が途絶えました）。追いかけるのをやめました。</p>`;
  h += `<div class="act">${gone ? '' : `<button type="button" data-act="rtfollow" aria-pressed="${rtFollow === o.key}">${rtFollow === o.key ? '追いかけ中（押すとやめる）' : 'この車両を追いかける'}</button>`}${o.j >= 0 ? `<button type="button" data-act="rtroute">この${o.rail ? '路線' : '系統'}を見る</button>` : ''}<button type="button" data-act="close">閉じる</button></div>`;
  h += `<p class="note">実際の位置は、公共交通オープンデータセンターが配信する GTFS リアルタイム（車両位置）を中継サーバ経由で 30 秒ごとに読んだものです。${o.j >= 0 && o.delay != null ? '次の位置が届くまでは、測った位置から求めた遅れの分だけ時刻表に沿って動かしています（届いたら補正）。' : ''}細い線の先が、同じ便の時刻表どおりの位置です。遅れは、実際の位置を時刻表で通る時刻と比べた目安です。地図を手で動かすと追いかけるのをやめます。</p>`;
  $('panel').hidden = false;
  $('panelBody').innerHTML = h;
  rtPanel = o;
  rtPanelAt = performance.now();
}
let rtPanelAt = 0;
let rtPanel = null;

// ---------- デマンド交通の区域 ----------
let activeAreas = [];
let areaData = [];
function updateAreas() {
  const t = clock.t;
  const byKey = new Map();
  for (const x of schedule.flexToday ?? []) {
    const k = `${x.f}:${x.a}`;
    const on = x.s <= t && t <= x.e;
    const cur = byKey.get(k);
    if (!cur) byKey.set(k, { f: x.f, a: x.a, r: x.r, on, wins: [[x.s, x.e]] });
    else { cur.on ||= on; cur.wins.push([x.s, x.e]); }
  }
  areaData = [...byKey.values()].map((d) => ({ ...d, poly: feeds[d.f].areas[d.a] })).filter((d) => d.poly?.length >= 3);
  activeAreas = areaData.filter((d) => d.on);
}

// ---------- 描画 ----------
function layers() {
  const z = map.getZoom();
  const out = [];
  const dim = !!sel;
  const dark = theme === 'dark';
  if (routesLayerDirty && !routesPending) {
    routesPending = true;
    (window.requestIdleCallback ?? ((f) => setTimeout(f, 50)))(() => { routesPending = false; buildRouteLines(); }, { timeout: 500 });
  }
  if (lineOn.busline || lineOn.hwline || lineJob) buildBusLines();
  syncMapLines(dim);
  if (selGeom) {
    out.push(new PathLayer({ id: 'selHalo', data: selGeom.lines, getPath: (d) => d.path, positionFormat: 'XY', getColor: [255, 255, 255, 200], getWidth: 7, widthUnits: 'pixels', capRounded: true, jointRounded: true }));
    out.push(new PathLayer({ id: 'selLine', data: selGeom.lines, getPath: (d) => d.path, positionFormat: 'XY', getColor: [...selGeom.c, 255], getWidth: 3.5, widthUnits: 'pixels', capRounded: true, jointRounded: true }));
  }
  if (trailLen && trails.data.length) {
    // 軌跡 = 動いた跡が徐々に消えていく残像。長さの違う細い尾を 3 本重ねる（長く淡い・中くらい・短く明るい）。
    // 重なる先頭ほど明るく、離れるほど急に暗くなるので、1 本の直線的なフェードより「消えていく」感じが出る
    const dark = theme === 'dark';
    const L = trails.L || trailLen;
    const off = (d) => dim && !(d.f === sel.f && d.r === sel.r);
    const w = z < 6 ? 0.7 : z < 8 ? 0.85 : z < 11 ? 1 : z < 14 ? 1.2 : 1.5;
    const add = dark ? { blend: true, blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one', blendAlphaOperation: 'add', blendAlphaSrcFactor: 'one', blendAlphaDstFactor: 'one-minus-src-alpha' } : {};
    const tiers = MOBILE ? [
      { id: 'trailLong', k: 1, a: dark ? 0.4 : 0.4, wd: 1.6 },
      { id: 'trailHead', k: 0.2, a: 1, wd: 2.4 },
    ] : [
      { id: 'trailLong', k: 1, a: dark ? 0.32 : 0.35, wd: 1.4 },
      { id: 'trailMid', k: 0.35, a: dark ? 0.55 : 0.55, wd: 1.8 },
      { id: 'trailHead', k: 0.1, a: 1, wd: 2.4 },
    ];
    for (const tr of tiers) {
      out.push(new TripsLayer({
        id: tr.id,
        data: trails.data,
        getPath: (d) => d.path,
        positionFormat: 'XY',
        getTimestamps: (d) => d.ts,
        getColor: (d) => (off(d) ? [...d.c, tr.k === 1 ? 40 : 0] : dark ? bright(d.c) : d.c),
        getWidth: (d) => (d.m === 1 ? 1.5 : d.m === 2 ? 1.35 : 1) * tr.wd,
        widthScale: w,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        capRounded: true,
        jointRounded: true,
        fadeTrail: true,
        trailLength: Math.max(1, L * tr.k),
        currentTime: clock.t - trails.base,
        opacity: tr.a,
        parameters: { ...add, depthWriteEnabled: false, depthCompare: 'always' },
        updateTriggers: { getColor: [sel?.f, sel?.r, trails.version, dark] },
      }));
    }
  }
  if (modeOn[3] && areaData.length) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 600);
    out.push(new PolygonLayer({
      id: 'areas',
      data: areaData,
      getPolygon: (d) => d.poly,
      getFillColor: (d) => (d.on ? [255, 140, 70, 22 + 30 * pulse] : [160, 160, 170, 14]),
      getLineColor: (d) => (d.on ? [255, 160, 90, 230] : [160, 160, 170, 90]),
      lineWidthUnits: 'pixels',
      getLineWidth: (d) => (d.on ? 2 : 1),
      stroked: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 60],
      updateTriggers: { getFillColor: [pulse.toFixed(2), activeAreas.length], getLineColor: [activeAreas.length], getLineWidth: [activeAreas.length] },
    }));
  }
  if (lineOn.stops && stationView.length && z >= 10) {
    // 全国の駅（時刻表の無い路線の駅も）。白い縁の四角っぽい点で、バス停より目立たせる
    out.push(new ScatterplotLayer({
      id: 'stations', data: stationView, getPosition: (d) => d.p, radiusUnits: 'pixels', getRadius: z >= 14 ? 5.5 : z >= 12 ? 4.2 : 3,
      getFillColor: dark ? [235, 240, 245, 230] : [40, 50, 60, 230], stroked: true, getLineColor: dark ? [20, 26, 34, 255] : [255, 255, 255, 255],
      lineWidthUnits: 'pixels', getLineWidth: 1.5, pickable: true, autoHighlight: true, highlightColor: [255, 196, 0, 255],
    }));
    if (z >= 13.5) {
      out.push(new TextLayer({
        id: 'stationNames', data: stationView, getPosition: (d) => d.p, getText: (d) => d.name, characterSet: 'auto',
        getSize: 12, getColor: dark ? [225, 232, 240] : [25, 30, 36], getPixelOffset: [0, -13], fontWeight: 700,
        fontFamily: '"Hiragino Sans","Noto Sans JP","Yu Gothic UI",sans-serif', outlineWidth: 3, outlineColor: dark ? [10, 14, 18, 255] : [255, 255, 255, 255],
        fontSettings: { sdf: true },
      }));
    }
  }
  if (lineOn.stops && p11Pts.length && z >= 13) {
    // 全国のバス停（時刻表のデータが無いものも）。小さく淡く
    out.push(new ScatterplotLayer({
      id: 'p11', data: p11Pts, getPosition: (d) => d.p, radiusUnits: 'pixels', getRadius: 2.2,
      getFillColor: dark ? [120, 130, 140, 110] : [130, 140, 150, 140], stroked: false, pickable: true,
    }));
  }
  if (lineOn.stops && stopPts.length && z >= 13) {
    out.push(new ScatterplotLayer({
      id: 'stops', data: stopPts, getPosition: (d) => d.p, radiusUnits: 'pixels', getRadius: 3.2,
      getFillColor: theme === 'dark' ? [20, 26, 34] : [255, 255, 255], stroked: true, getLineColor: theme === 'dark' ? [200, 210, 220] : [60, 70, 80], lineWidthUnits: 'pixels', getLineWidth: 1.2, pickable: true,
    }));
  }
  if (selGeom) {
    out.push(new ScatterplotLayer({
      id: 'selStops', data: selGeom.stops, getPosition: (d) => d.p, radiusUnits: 'pixels', getRadius: 4.5,
      getFillColor: [255, 255, 255], stroked: true, getLineColor: [...selGeom.c, 255], lineWidthUnits: 'pixels', getLineWidth: 2, pickable: true,
    }));
    if (z >= 12.5) {
      out.push(new TextLayer({
        id: 'selStopNames', data: selGeom.stops, getPosition: (d) => d.p, getText: (d) => d.name, characterSet: 'auto',
        getSize: 12, getColor: theme === 'dark' ? [235, 240, 245] : [20, 25, 30], getPixelOffset: [0, -14],
        fontFamily: '"Hiragino Sans","Noto Sans JP","Yu Gothic UI",sans-serif', outlineWidth: 3, outlineColor: theme === 'dark' ? [10, 14, 18, 255] : [255, 255, 255, 255],
        fontSettings: { sdf: true }, background: false,
      }));
    }
  }
  const busData = { length: nRun, attributes: { getPosition: { value: posBuf.subarray(0, nRun * 2), size: 2 }, getFillColor: { value: colBuf.subarray(0, nRun * 4), size: 4 }, getRadius: { value: radBuf.subarray(0, nRun), size: 1 } } };
  if (theme === 'dark' && z >= 12 && !MOBILE) {
    out.push(new ScatterplotLayer({
      id: 'busGlow', data: busData, radiusUnits: 'pixels', radiusScale: 2.1, opacity: 0.16,
      parameters: { blend: true, blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one', blendAlphaOperation: 'add', blendAlphaSrcFactor: 'one', blendAlphaDstFactor: 'one-minus-src-alpha', depthWriteEnabled: false, depthCompare: 'always' },
    }));
  }
  out.push(new ScatterplotLayer({
    id: 'buses',
    data: busData,
    radiusUnits: 'pixels',
    stroked: z >= 11,
    getLineColor: theme === 'dark' ? [255, 255, 255, 220] : [20, 20, 20, 200],
    lineWidthUnits: 'pixels',
    getLineWidth: 1.2,
    pickable: true,
  }));
  if (rtOn && clock.live && rtData.length) {
    // 時刻表の位置 → 実際の位置 を細い線で結ぶ（ずれが見える）
    out.push(new LineLayer({
      id: 'rtLinks', data: rtData.filter((d) => d.sp), getSourcePosition: (d) => d.sp, getTargetPosition: (d) => [d.lon, d.lat],
      getColor: dark ? [255, 255, 255, 120] : [20, 30, 40, 140], getWidth: 1.2, widthUnits: 'pixels',
    }));
    // 配信中の本物の位置であることを示す、ゆっくり明滅する輪
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 500);
    out.push(new ScatterplotLayer({
      id: 'rtPulse', data: rtData, getPosition: (d) => [d.lon, d.lat], radiusUnits: 'pixels', getRadius: (z < 9 ? 9 : z < 13 ? 12 : 15) * (0.9 + 0.25 * pulse),
      filled: false, stroked: true, getLineColor: (d) => [...delayColor(d.delay), Math.round(60 + 120 * pulse)], lineWidthUnits: 'pixels', getLineWidth: 1.5,
      updateTriggers: { getLineColor: [pulse.toFixed(2), rtTick] },
    }));
    // 電車は角の丸い四角、バスはひし形。白い縁（下の層）＋遅れの色（上の層）
    const sz = z < 9 ? 9 : z < 13 ? 12 : 15;
    const common = { data: rtData, iconAtlas: RT_ICONS.url, iconMapping: RT_ICONS.mapping, getIcon: (d) => (d.rail ? 'train' : 'bus'), getPosition: (d) => [d.lon, d.lat], sizeUnits: 'pixels', billboard: false };
    out.push(new IconLayer({ ...common, id: 'rtEdge', getSize: (d) => (d.rail ? sz * 0.95 : sz * 1.2) + 4, getColor: dark ? [255, 255, 255, 255] : [20, 20, 20, 255], updateTriggers: { getSize: [sz] } }));
    out.push(new IconLayer({
      ...common, id: 'rt', getSize: (d) => (d.rail ? sz * 0.95 : sz * 1.2), getColor: (d) => [...delayColor(d.delay), 255], pickable: true,
      updateTriggers: { getColor: [rtTick], getSize: [sz] },
    }));
    if (rtFollow) {
      const d = rtData.find((x) => x.key === rtFollow);
      if (d) out.push(new ScatterplotLayer({ id: 'rtFollowRing', data: [d], getPosition: (x) => [x.lon, x.lat], radiusUnits: 'pixels', getRadius: sz * 1.4, filled: false, stroked: true, getLineColor: [255, 196, 0, 255], lineWidthUnits: 'pixels', getLineWidth: 2.5 }));
    }
  }
  if (selTrip) {
    const j = findTripIndex(selTrip.f, selTrip.k, selTrip.at);
    if (j >= 0 && schedule.ts[j] <= clock.t && schedule.te[j] >= clock.t) {
      const p = [0, 0, 0];
      schedule.position(j, clock.t, p);
      out.push(new ScatterplotLayer({ id: 'selBus', data: [p], getPosition: (d) => [d[0], d[1]], radiusUnits: 'pixels', getRadius: 9, getFillColor: [...selGeom.c, 255], stroked: true, getLineColor: [255, 255, 255], lineWidthUnits: 'pixels', getLineWidth: 3 }));
      if (follow) followTo(p[0], p[1]);
    } else if (follow) {
      // 追っている便が終点に着いた（または時刻を戻して、まだ出ていない）: 追いかけるのをやめる（2026-10-04）
      follow = false;
      refreshPanel();
    }
  }
  return out;
}

// ---------- 時計 ----------
let last = performance.now(), uiTick = 0;
const perf = { ms: 0, log: [] };
setInterval(() => { if (perf.log.length > 100) perf.log.splice(0, perf.log.length - 100); }, 10000);
function frame(now) {
  requestAnimationFrame(frame); // 先に次を頼む（途中でエラーが出ても動き続ける）
  try { frameBody(now); } catch (e) { console.error(e); }
}
let wasLive = true;
function leaveLive() {
  if (!(panelArea?.rt && rtPanel)) { rtFollow = null; return; }
  const j = rtPanel.j, following = rtFollow === rtPanel.key;
  rtFollow = null;
  if (j >= 0) {
    // 早送り・時刻の移動では実際の位置は出せないので、同じ便の時刻表どおりの動きに切り替えて追いかけ続ける
    const { feed, pat } = schedule.tripInfo(j);
    selTrip = { f: feed.i, k: schedule.ti[j], at: schedule.day * 86400 + schedule.ts[j] };
    follow = following;
    selectRoute(feed.i, pat.r, { keepTrip: true });
  } else clearSelection();
}
function frameBody(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (wasLive && !clock.live) leaveLive();
  wasLive = clock.live;
  if (clock.live) {
    const n = jstNow();
    const d = dayNumOf(n.key);
    if (d !== clock.day) setDay(d);
    clock.t = n.sec;
  } else if (clock.playing) {
    clock.t += dt * clock.speed;
  }
  if (clock.t >= 86400) { clock.t -= 86400; setDay(clock.day + 1); trails.dirty = true; }
  if (clock.t < 0) { clock.t += 86400; setDay(clock.day - 1); trails.dirty = true; }
  if (schedule.day != null) {
    const w0 = performance.now();
    updateHeads();
    syncFollowZoom();
    if (rtData.length) moveRealtime();
    updateAreas();
    ensureTrails();
    overlay.setProps({ layers: layers() });
    perf.ms = perf.ms * 0.95 + (performance.now() - w0) * 0.05;
  }
  if (now - uiTick > 120) {
    uiTick = now;
    $('time').textContent = hhmmss(clock.t);
    if (!sliderDragging) $('slider').value = Math.floor(clock.t);
    $('nRun').textContent = fmt(nView);
    if (now - rtTick > 1000) {
      rtTick = now; updateRealtime();
      // 追っている車両の位置が届かなくなった（運行を終えた・配信が途絶えた）: 追いかけるのをやめる（2026-10-04）
      if (rtFollow && !rtData.some((x) => x.key === rtFollow)) { const gone = rtFollow; rtFollow = null; if (panelArea?.rt && rtPanel?.key === gone) showRtVehicle(rtPanel, true); }
      if (panelArea?.rt && rtPanel && now - rtPanelAt > 5000) { const d = rtData.find((x) => x.key === rtPanel.key); if (d) showRtVehicle(d, true); }
    }
    $('nAllRun').textContent = fmt(nModeAll.reduce((a, x, i) => a + (modeOn[i] ? x : 0), 0)); // 画面の中の数と同じく、表示中の乗り物すべて（デマンド交通の車両も）
    renderChips();
    if (selTrip || selStop || sel) {
      panelTimer++;
      if (panelTimer % 8 === 0 && !$('panel').matches(':hover')) refreshPanel();
    }
  }
}

// ---------- 操作 ----------
let sliderDragging = false;
$('slider').addEventListener('pointerdown', () => { sliderDragging = true; });
addEventListener('pointerup', () => { sliderDragging = false; });
$('slider').addEventListener('input', (e) => {
  clock.live = false;
  clock.t = +e.target.value;
  trails.dirty = true;
  syncControls();
});
$('play').onclick = () => {
  if (clock.live) { clock.live = false; clock.playing = false; } else clock.playing = !clock.playing;
  syncControls();
};
document.querySelectorAll('.speeds button').forEach((b) => {
  b.onclick = () => {
    clock.speed = +b.dataset.s;
    clock.playing = true;
    if (clock.speed !== 1) clock.live = false;
    trails.dirty = true;
    syncControls();
  };
});
$('now').onclick = () => { goNow(); trails.dirty = true; };
$('date').addEventListener('change', (e) => {
  if (!e.target.value) return;
  clock.live = false;
  setDay(dayNumOf(e.target.value));
  syncControls();
});
function syncControls() {
  $('play').textContent = clock.playing || clock.live ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', clock.playing || clock.live ? '一時停止' : '再生');
  $('live').hidden = !clock.live;
  document.querySelectorAll('.speeds button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.s === clock.speed && (clock.playing || clock.live))));
}
addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  if (e.key === 'Escape') clearSelection();
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { clock.live = false; clock.t += (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 3600 : 600); trails.dirty = true; syncControls(); }
});

// 表示の設定
// 「表示」の設定欄は、ボタンのすぐ下に右端をそろえて開く（決まった高さに出していて、上の欄が折り返すとボタンに重なった）
function placeSettings() {
  const p = $('settings');
  if (p.hidden) return;
  const r = $('btnSettings').getBoundingClientRect();
  // スマホでは地図のボタンがすぐ下に横一列に並ぶので、その下に
  const tr = innerWidth < 760 ? document.querySelector('.maplibregl-ctrl-top-right') : null;
  p.style.top = `${Math.round(Math.max(r.bottom, tr ? tr.getBoundingClientRect().bottom : 0) + 6)}px`;
  p.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
}
$('btnSettings').onclick = () => { const p = $('settings'); p.hidden = !p.hidden; $('btnSettings').setAttribute('aria-expanded', String(!p.hidden)); placeSettings(); };
addEventListener('resize', placeSettings);
$('trailLen').onchange = (e) => { trailLen = +e.target.value; trails.dirty = true; };
// 乗り物の札（数を出しつつ、押すと表示を切り替える）
function renderChips() {
  const el = $('chips');
  if (!el.children.length) {
    el.innerHTML = MODES.map((m, i) => `<button type="button" data-m="${i}" aria-pressed="${modeOn[i]}"><i style="background:${rgbCss(m.color)}"></i>${m.label}<b>0</b></button>`).join('');
    el.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const i = +b.dataset.m;
      modeOn[i] = !modeOn[i];
      b.setAttribute('aria-pressed', String(modeOn[i]));
      try { localStorage.setItem('bt.modes', JSON.stringify(modeOn)); } catch { /* 使えなくてもよい */ }
      trails.dirty = true; routesLayerDirty = true;
    };
  }
  if (!$('lineChips').children.length) {
    $('lineChips').innerHTML = LINES.map((l) => `<button type="button" class="line" data-l="${l.key}" aria-pressed="${!!lineOn[l.key]}" title="${l.help}"><i class="ln ln-${l.key}"></i>${l.label}</button>`).join('');
    $('lineChips').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      hideHint();
      const k = b.dataset.l;
      lineOn[k] = !lineOn[k];
      b.setAttribute('aria-pressed', String(lineOn[k]));
      routesLayerDirty = true;
    };
  }
  if (!$('rtChip').children.length) {
    $('rtChip').innerHTML = '<button type="button" class="rtc" aria-pressed="false"><i></i>実際の位置<b>0</b></button>';
    $('rtChip').onclick = () => {
      hideHint();
      rtOn = !rtOn;
      if (rtOn && !clock.live) { goNow(); trails.dirty = true; }
      updateRealtime();
    };
  }
  {
    const b = $('rtChip').firstChild;
    b.setAttribute('aria-pressed', String(rtOn));
    b.querySelector('b').textContent = rtOn && clock.live ? fmt(rtData.length) : '—';
    b.title = !rtOn ? RT_HELP : !clock.live ? '実際の位置は「いま」のときだけ見られます（押すと「いま」に戻ります）' : `実際の位置（GTFS リアルタイム） ${rtData.length} 台。色: 緑 ほぼ時刻表どおり／黄 2〜5 分遅れ／赤 5 分以上遅れ／青 早い`;
  }
  const vb = map.getBounds();
  const counts = [nMode[0], nMode[1], nMode[2], activeAreas.filter((d) => { const [x, y] = d.poly[0]; return x >= vb.getWest() && x <= vb.getEast() && y >= vb.getSouth() && y <= vb.getNorth(); }).length];
  [...el.children].forEach((b, i) => { b.querySelector('b').textContent = fmt(counts[i]); b.title = `画面の中: ${MODES[i].label} ${fmt(counts[i])} ${MODES[i].unit}（全体 ${fmt(i < 3 ? nModeAll[i] : activeAreas.length)}）${modeOn[i] ? '' : '（非表示）'}`; });
}
$('theme').onchange = (e) => {
  theme = e.target.value;
  try { localStorage.setItem('bt.theme', theme); } catch { /* 使えなくてもよい */ }
  document.documentElement.dataset.theme = theme;
  // 切り替えでは style.load が来ないことがある（差分で入れ替えるため）。読み込み終わったら日本語名と重ねる地図をかけ直す
  map.setStyle(STYLES[theme]);
  map.once('idle', () => { japaneseLabels(); applyOverlay(); });
  drawHist();
};
$('btnSources').onclick = () => $('dlgSources').showModal();
$('btnHelp').onclick = () => $('dlgHelp').showModal();
map.on('zoomend', () => { routesLayerDirty = true; });
// 追いかける: 地図の中心を車両に合わせる。拡大・縮小・回転の動きのあいだは合わせ直さない（毎フレーム合わせると拡大・縮小が打ち消された）
// スマホでは情報欄が地図の下半分を覆うので、情報欄の上に見えている地図の真ん中に車両を置く（地図の padding。
// 画面の真ん中に置いていて、情報欄の裏に隠れて見えなかった。2026-10-04）
const NO_PAD = { top: 0, bottom: 0, left: 0, right: 0 };
function followPadding() {
  if (innerWidth >= 760 || $('panel').hidden) return NO_PAD;
  const cr = map.getCanvas().getBoundingClientRect(), pr = $('panel').getBoundingClientRect();
  const tr = document.querySelector('.maplibregl-ctrl-top-right')?.getBoundingClientRect();
  const top = Math.max(0, Math.round((tr ? tr.bottom : $('head').getBoundingClientRect().bottom) - cr.top));
  const bottom = Math.max(0, Math.round(cr.bottom - pr.top));
  return top + bottom > cr.height - 80 ? NO_PAD : { top, bottom, left: 0, right: 0 };
}
const hasPad = () => { const q = map.getPadding(); return q.top || q.bottom || q.left || q.right; };
function followTo(lon, lat) {
  if (map.isZooming() || map.isRotating()) return;
  map.jumpTo({ center: [lon, lat], padding: followPadding() });
}
// 追いかけるのをやめたら padding を戻す。見えている範囲は動かさない（画面の真ん中の地点を、padding 0 の中心にする）
function releaseFollowPadding() {
  if (!hasPad() || map.isMoving()) return;
  const c = map.getCanvas();
  map.jumpTo({ center: map.unproject([c.clientWidth / 2, c.clientHeight / 2]), padding: NO_PAD });
}
// 追いかけているあいだは、ホイール・ピンチの拡大・縮小を画面の中心（＝車両）を基準にする
let followZoomMode = false;
function syncFollowZoom() {
  const on = !!(rtFollow || follow);
  if (!on) releaseFollowPadding();
  if (on === followZoomMode) return;
  followZoomMode = on;
  placePanel(); // スマホでは追いかけるあいだ情報欄を低く
  const around = on ? 'center' : undefined;
  map.scrollZoom.disable(); map.scrollZoom.enable(around ? { around } : undefined);
  map.touchZoomRotate.disable(); map.touchZoomRotate.enable(around ? { around } : undefined);
}
// 1 本指・マウスで地図を動かしたら追いかけるのをやめる（2 本指の拡大・縮小ではやめない）
map.on('dragstart', (e) => { if ((e.originalEvent?.touches?.length ?? 1) > 1) return; if (rtFollow || follow) { rtFollow = null; follow = false; if (panelArea?.rt && rtPanel) showRtVehicle(rtData.find((x) => x.key === rtPanel.key) ?? rtPanel, true); } });

// ---------- 走っている台数のグラフ（時刻のつまみの下） ----------
function drawHist() {
  const cv = $('hist'), r = cv.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const h = schedule.hist;
  const max = Math.max(1, ...h);
  const w = cv.width / h.length;
  g.fillStyle = theme === 'dark' ? 'rgba(56,214,255,0.35)' : 'rgba(0,119,182,0.3)';
  for (let q = 0; q < h.length; q++) {
    const bh = (h[q] / max) * cv.height;
    g.fillRect(q * w, cv.height - bh, Math.max(1, w - 0.5 * dpr), bh);
  }
}
addEventListener('resize', drawHist);
// 情報欄は上の欄（折り返すと高さが変わる）のすぐ下から
// 開いたときの説明: オフになっている札を押すと何が出るか（利用者の指定。2026-10-04）。×・札を押す・地図を動かすと消える。
// 一度消えたら次からは出さない（「使い方」の「札の説明を出す」でいつでも出せる）
function showHint() {
  const el = $('hint');
  el.innerHTML = `<button type="button" class="close" aria-label="閉じる">×</button>
    <b>上の札を押すと、地図に足せます（今はオフ）</b>
    <dl>
      <dt><i class="hk rt"></i>実際の位置</dt><dd>${RT_HELP}</dd>
      ${LINES.map((l) => `<dt><i class="hk ln-${l.key}"></i>${l.label}</dt><dd>${l.help}</dd>`).join('')}
    </dl>
    <small>この説明は「使い方」からいつでも出せます</small>`;
  el.hidden = false;
  document.body.classList.add('hinting');
  el.querySelector('.close').onclick = hideHint;
  placePanel();
  map.once('dragstart', hideHint);
  map.once('zoomstart', (e) => { if (e.originalEvent) hideHint(); });
}
function hideHint() {
  if ($('hint').hidden) return;
  $('hint').hidden = true;
  document.body.classList.remove('hinting');
  try { localStorage.setItem('bt.hintSeen', '1'); } catch { /* 使えなくてもよい */ }
}
$('btnHint').onclick = () => { $('dlgHelp').close(); showHint(); };
// 上の欄・下の欄（折り返しで高さが変わる）に合わせて、地図のボタン・地図の出典・情報欄を置き直す（重なっていた）
function placePanel() {
  const narrow = innerWidth < 760;
  const head = $('head').getBoundingClientRect(), bar = $('bar').getBoundingClientRect();
  const tr = document.querySelector('.maplibregl-ctrl-top-right'), br = document.querySelector('.maplibregl-ctrl-bottom-right');
  if (tr) tr.style.top = `${Math.ceil(head.bottom + 6)}px`;
  if (br) br.style.bottom = `${Math.ceil(innerHeight - bar.top + 6)}px`;
  const ctrlBottom = tr ? tr.getBoundingClientRect().bottom : head.bottom;
  const hint = $('hint');
  if (hint && !hint.hidden) hint.style.top = `${Math.ceil((narrow ? Math.max(ctrlBottom, head.bottom) : head.bottom) + 8)}px`;
  const p = $('panel').style;
  // 情報欄の下端は、下の欄と地図の出典の表示のうち上にある方の上で止める
  const at = document.querySelector('.maplibregl-ctrl-attrib')?.getBoundingClientRect();
  const floor = at && at.height ? Math.min(bar.top, at.top) : bar.top;
  const gapBottom = Math.ceil(innerHeight - floor + 8);
  if (narrow) {
    // スマホ: 地図のボタン（横一列）の下から、下の欄の上まで
    const top = Math.ceil(Math.max(ctrlBottom, head.bottom) + 8);
    // 高さは画面の 45% まで。追いかけているあいだは、上の欄と下の欄のあいだの地図の 4 割まで（残りの地図の真ん中に車両を置く。
    // スマホは上下の欄で画面の 6 割近くを使うので、情報欄がその間をほぼ覆い、追いかける車両が見えなかった。2026-10-04）
    const avail = innerHeight - gapBottom - top;
    const h = rtFollow || follow ? Math.max(110, Math.round(avail * 0.4)) : Math.max(120, Math.min(avail, Math.round(innerHeight * 0.45)));
    p.top = ''; p.bottom = `${gapBottom}px`; p.maxHeight = `${h}px`;
  } else {
    // パソコン: 上の欄の下から、下の欄の上まで。右の地図のボタンを隠さないよう、ボタンの幅だけ左に寄せる
    const top = Math.ceil(head.bottom + 8);
    p.top = `${top}px`; p.bottom = ''; p.maxHeight = `${Math.max(160, innerHeight - gapBottom - top)}px`;
  }
}
addEventListener('resize', placePanel);
new ResizeObserver(placePanel).observe($('head'));
new ResizeObserver(placePanel).observe($('bar'));
map.on('load', () => {
  // スマホでは地図の出典は「i」に畳んでおく（開いたままだと横幅いっぱいで情報欄に重なった）。押すと開く
  const attrib = document.querySelector('.maplibregl-ctrl-attrib');
  if (MOBILE) attrib?.classList.remove('maplibregl-compact-show');
  if (attrib) new ResizeObserver(placePanel).observe(attrib); // 出典を開いたり畳んだりしたら置き直す
  placePanel();
  let seen = false;
  try { seen = localStorage.getItem('bt.hintSeen') === '1'; } catch { /* 使えなくてもよい */ }
  if (!seen) showHint();
});

// ---------- 検索 ----------
let qItems = [];
function search(q) {
  q = q.trim().toLowerCase();
  const out = [];
  if (!q) return out;
  for (const feed of feeds) {
    if (!feed) continue;
    feed.routes.forEach((rt, r) => {
      const text = `${rt.short} ${rt.long} ${agencyName(feed, rt)} ${feed.meta.name}`.toLowerCase();
      if (text.includes(q)) out.push({ kind: 'route', f: feed.i, r, label: routeName(rt), sub: `${agencyName(feed, rt)}${rt.long && rt.short ? `　${rt.long}` : ''}`, rank: (rt.short.toLowerCase() === q ? 0 : 1) });
    });
    if (out.length > 400) break;
  }
  const seenStop = new Set();
  for (const feed of feeds) {
    if (!feed) continue;
    feed.stopNames.forEach((n, s) => {
      if (!n.toLowerCase().includes(q)) return;
      const key = `${n}|${feed.i}`;
      if (seenStop.has(key)) return;
      seenStop.add(key);
      out.push({ kind: 'stop', f: feed.i, s, label: n, sub: `停留所　${feed.meta.name}`, rank: n.toLowerCase() === q ? 0 : 2 });
    });
    if (out.length > 800) break;
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, 60);
}
let qTimer;
$('q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    qItems = search(e.target.value);
    const ul = $('qres');
    ul.hidden = !qItems.length;
    ul.innerHTML = qItems.map((it, i) => `<li data-i="${i}">${esc(it.label)}<small>${esc(it.sub)}</small></li>`).join('');
  }, 150);
});
$('qres').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const it = qItems[+li.dataset.i];
  $('qres').hidden = true;
  if (it.kind === 'route') selectRoute(it.f, it.r, { fit: true });
  else {
    const feed = feeds[it.f];
    selStop = { f: it.f, s: it.s };
    sel = null; selGeom = null; selTrip = null;
    map.flyTo({ center: [feed.stopLon[it.s], feed.stopLat[it.s]], zoom: 15.5 });
    refreshPanel();
  }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('qres').hidden = true; if (!e.target.closest('#settings, #btnSettings')) $('settings').hidden = true; });

// ---------- 出典 ----------
function renderSources() {
  const list = index.feeds;
  const bySrc = (s) => list.filter((m) => m.src === s);
  const row = (m) => `<tr><td>${esc(m.name)}${m.agencies?.length && m.agencies[0] !== m.name ? `<br><small>${esc(m.agencies.join('・'))}</small>` : ''}</td><td>${m.page ? `<a href="${esc(m.page)}" target="_blank" rel="noopener">${esc(m.src)}</a>` : esc(m.src)}</td><td>${m.licenseUrl ? `<a href="${esc(m.licenseUrl)}" target="_blank" rel="noopener">${esc(m.license)}</a>` : esc(m.license)}</td><td>${fmt(m.trips)}</td></tr>`;
  // 事業者の公式サイトの時刻表から組み直したもの（神姫バス・鹿児島市電・伊予鉄など）: 非公式・非商用と、事業者へ問い合わせないことを出す
  const x = list.filter((m) => /非公式/.test(m.license || ''));
  const hoda = list.filter((m) => /HODA/.test(m.src));
  const unl = bySrc('公開の案内なし');
  $('sourcesBody').innerHTML = `
    <p>バスの時刻・停留所・経路は、各事業者・自治体が公開している GTFS-JP（標準的なバス情報フォーマット）を加工して使っています。
    位置は時刻表から計算したもので、実際の運行とは異なります。<b>最新の時刻は各事業者の案内で確かめてください。</b></p>
    <ul>
      <li>gtfs-data.jp（GTFSデータリポジトリ）に登録されたデータ: ${fmt(bySrc('gtfs-data.jp').length)} 件</li>
      <li>公共交通オープンデータセンター（ODPT）のデータ: ${fmt(bySrc('ODPT').length)} 件 — 「出典：公共交通オープンデータセンター」。公共交通オープンデータ基本ライセンスのものを含みます</li>
      ${x.length ? `<li>GTFS を公開していない事業者の、公式サイトの時刻表から組み直したもの（非公式・非商用）: ${fmt(x.length)} 件</li>` : ''}
    </ul>
    ${hoda.length ? `<p>北海道オープンデータプラットフォーム（HODA）のデータ（${fmt(hoda.length)} 件）: このアプリは、以下の著作物を改変して利用しています。${hoda.map((m) => esc(m.name)).join('、')}、北海道オープンデータ推進協議会、<a href="http://creativecommons.org/licenses/by/2.1/jp/" target="_blank" rel="noopener">クリエイティブ・コモンズ・ライセンス 表示 2.1 日本</a>。</p>` : ''}
    ${unl.length ? `<p>公開の案内が無いがインターネット上で取得できる GTFS の配信（${unl.map((m) => esc(m.name.replace(/（.*$/, ''))).join('・')}）も使っています。ライセンスは確認できていません。</p>` : ''}
    ${x.length ? `<div class="warn">${x.map((m) => `<b>${esc(m.name)}</b>: ${esc(m.license)}。${esc(m.note || '')}。この表示について事業者へ問い合わせないでください。`).join('<br>')}</div>` : ''}
    <p>地図: © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>、© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>。祝日は内閣府の「国民の祝日」から計算。</p>
    <p>線形と背景のデータ:</p>
    <ul>
      <li>バスの走る道（形状の無いデータを道路に沿わせたもの）: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>（ODbL）</li>
      <li>鉄道の線路・列車の走る線: 国土数値情報（鉄道データ N02-24）国土交通省（CC BY 4.0）</li>
      <li>全国のバス停留所: 国土数値情報（バス停留所データ P11-22）国土交通省（CC BY 4.0）</li>
      <li>重ねる地図（「表示」で選んだとき）: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>（国土地理院。淡色地図・標準地図・全国最新写真（シームレス））</li>
    </ul>
    <p>データの作成日: ${esc(index.generated.slice(0, 10))}</p>
    <table><thead><tr><th>データ</th><th>入手先</th><th>ライセンス</th><th>便</th></tr></thead><tbody>${[...list].sort((a, b) => b.trips - a.trips).map(row).join('')}</tbody></table>`;
}

// ---------- 開始 ----------
// 時刻表のデータは、地図（背景）の読み込みを待たずにすぐ読み始める（以前は地図の読み込みが終わってからで、スマホでは 3 秒ほど遅れた。2026-10-04）
goNow();
const loading = loadAll().catch((e) => { $('load').textContent = 'データを読み込めませんでした'; console.error(e); });
// 線路・駅・実際の位置の対応表は、札がオフの初期表示では使わない。スマホでは時刻表のデータの取得と回線を取り合わないよう後から
if (MOBILE) Promise.race([loading, new Promise((r) => setTimeout(r, 5000))]).then(loadStatic);
else loadStatic();
map.on('load', () => {
  syncControls();
  requestAnimationFrame(frame);
});
// 確認用（開発者ツールから状態を見る）
window.__bt = { map, schedule, clock, trails, feeds, buildTrails, perf, overlay };
