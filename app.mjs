// 全国バス軌跡マップ: 地図（MapLibre）＋ deck.gl で、時刻表どおりのバスと軌跡を描く
import { Feed, Schedule, dayNumOf, dateKeyOf } from './engine.mjs?v=53d491e-2320';
import { holidayName } from './holidays.mjs?v=53d491e-2320';

const { MapboxOverlay, TripsLayer, ScatterplotLayer, PathLayer, TextLayer, PolygonLayer } = deck;
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
// 地名は日本語で: CARTO の地図は縮尺によって英語名（name_en）を出すので、現地名（name。日本では日本語）に差し替える
function japaneseLabels() {
  for (const l of map.getStyle().layers) {
    if (l.type !== 'symbol') continue;
    const tf = map.getLayoutProperty(l.id, 'text-field');
    if (tf && JSON.stringify(tf).includes('name_en')) map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ja'], ['get', 'name'], ['get', 'name_en']]);
  }
}
map.on('style.load', japaneseLabels);
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
  { key: 'track', label: '線路' },
  { key: 'busline', label: 'バス路線' },
  { key: 'stops', label: '停留所・駅' },
];
const lineOn = { track: true, busline: false, stops: true };
try { Object.assign(lineOn, JSON.parse(localStorage.getItem('bt.lines')) ?? {}); } catch { /* 使えなくてもよい */ }
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
let selTrip = null;        // 選んだ便 { f, k }（フィードと便番号。日をまたいでも同じ便を指す）
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
// パソコン: 全国分を近い順に全部読む。スマホ: 見ている範囲（少し広め）のデータだけを、合計の大きさに上限を設けて読み、
// 地図を動かしたら足りない分を読み、範囲から外れたものは手放す（全国 54 MB を一度に読むとスマホでは重い。2026-10-03）
const BUDGET = MOBILE ? 16 * 1048576 : Infinity;
let loadedBytes = 0, loadSeq = 0;
const loadingNow = new Set();
async function loadAll() {
  const res = await fetch('./data/index.json?v=202610031413');
  index = await res.json();
  renderSources();
  await syncFeeds();
  if (!MOBILE) $('load').textContent = `${fmt(index.feeds.length)} のデータ・${fmt(index.feeds.reduce((s, m) => s + m.trips, 0))} 便`;
  map.on('moveend', () => { if (MOBILE) { clearTimeout(syncTimer); syncTimer = setTimeout(syncFeeds, 400); } });
}
let syncTimer = null;
async function syncFeeds() {
  if (!index) return;
  const seq = ++loadSeq;
  const c = map.getCenter();
  const dist = (m) => { const x = (m.bbox[0] + m.bbox[2]) / 2 - c.lng, y = (m.bbox[1] + m.bbox[3]) / 2 - c.lat; return x * x + y * y; };
  let list = [...index.feeds].sort((a, b) => dist(a) - dist(b));
  if (MOBILE) {
    const v = viewBounds(0.5);
    const inView = list.filter((m) => boxHit(m.bbox, v));
    // 予算に収まるだけ（近い順）
    const want = new Set();
    let bytes = 0;
    for (const m of inView) { if (bytes + m.size > BUDGET && want.size) break; want.add(m.i); bytes += m.size; }
    // 範囲から外れたものを手放す
    let dropped = 0;
    for (const f of feeds) {
      if (f && !want.has(f.i)) { if (sel?.f === f.i || selStop?.f === f.i) clearSelection(); loadedBytes -= f.meta.size; feeds[f.i] = undefined; schedule.feeds[f.i] = undefined; dropped++; }
    }
    if (dropped) scheduleRebuild();
    list = list.filter((m) => want.has(m.i));
    const partial = want.size < inView.length;
    $('load').textContent = `見ている範囲 ${fmt(want.size)} データ${partial ? '（広域は一部。拡大すると全部）' : ''}`;
  }
  const queue = list.filter((m) => !feeds[m.i] && !loadingNow.has(m.i));
  const total = queue.length;
  let done = 0;
  const step = async () => {
    while (queue.length && seq === loadSeq) {
      const m = queue.shift();
      loadingNow.add(m.i);
      try {
        const r = await fetch(`./data/f/${m.i}.json?v=202610031413`);
        const raw = await r.json();
        if (MOBILE && seq !== loadSeq) continue; // 待つ間に地図が動いた
        const f = new Feed(m, raw);
        feeds[m.i] = f;
        schedule.addFeed(f);
        loadedBytes += m.size;
      } catch (e) { console.warn('feed', m.i, e); } finally { loadingNow.delete(m.i); }
      done++;
      if (!MOBILE || total > 3) $('load').textContent = `データ ${done} / ${total}`;
      scheduleRebuild();
    }
  };
  await Promise.all(Array.from({ length: MOBILE ? 3 : 6 }, step));
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
  rebuildTimer = setTimeout(() => { rebuildTimer = null; lastRebuild = Date.now(); rebuildDay(); }, wait);
}
function rebuildDay() {
  schedule.build(clock.day);
  trails.dirty = true;
  routesLayerDirty = true;
  drawHist();
  if (sel) refreshPanel();
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
const nMode = [0, 0, 0, 0];
const tmp = [0, 0, 0];
function updateHeads() {
  if (runBuf.length < schedule.n) { const cap = 1 << Math.ceil(Math.log2(schedule.n + 1)); runBuf = new Int32Array(cap); runIdx = new Int32Array(cap); posBuf = new Float64Array(cap * 2); colBuf = new Uint8Array(cap * 4); radBuf = new Float32Array(cap); }
  const m = schedule.running(clock.t, runBuf);
  const z = map.getZoom();
  const r = z < 6 ? 1.6 : z < 8 ? 2.2 : z < 11 ? 3 : z < 14 ? 4.5 : 6;
  let q = 0;
  nMode.fill(0);
  for (let k = 0; k < m; k++) {
    const j = runBuf[k];
    const fi = schedule.tf[j], feed = feeds[fi];
    const pat = feed.pats[feed.trips[schedule.ti[j] * 4]];
    const rt = feed.routes[pat.r];
    nMode[rt.mode]++;
    if (!kindOk(rt)) continue;
    schedule.position(j, clock.t, tmp);
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
function lod(z) { return z < 6 ? ['s', 1500] : z < 8 ? ['s', 400] : z < 10 ? ['s', 80] : z < 13 ? ['s', 15] : ['f', 0]; }
function viewBounds(pad) {
  const b = map.getBounds();
  const dx = (b.getEast() - b.getWest()) * pad, dy = (b.getNorth() - b.getSouth()) * pad;
  return [b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy];
}
const boxHit = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
function buildTrails() {
  // 早送りのときは軌跡を伸ばす（画面の上で 1.2 秒ぶんの尾になるように）
  // 尾の長さは縮尺に合わせる（画面の上でほぼ同じ長さに見えるように。拡大すると短く）
  const t = clock.t, L = trailLen ? Math.max(trailLen * zoomTrail(map.getZoom()), clock.speed * 1.2) : 0;
  trails.dirty = false;
  if (!L) { trails.data = []; trails.w0 = t; trails.w1 = t + 3600; return; }
  const H = Math.min(5400, Math.max(600, clock.speed * 8));
  const z = map.getZoom();
  const [mode, gap] = lod(z);
  const bounds = z >= 7 ? viewBounds(0.6) : null;
  const w0 = clock.speed >= 0 ? t : t - H, w1 = w0 + H;
  const base = w0 - L;
  const data = [];
  for (const j of schedule.overlapping(w0 - L, w1)) {
    const fi = schedule.tf[j];
    if (bounds && !boxHit(feeds[fi].meta.bbox, bounds)) continue;
    { const fd = feeds[fi]; if (!kindOk(fd.routes[fd.pats[fd.trips[schedule.ti[j] * 4]].r])) continue; }
    const p = schedule.trailPath(j, Math.max(schedule.ts[j], w0 - L), Math.min(schedule.te[j], w1), base, false, gap);
    if (!p) continue;
    const feed = feeds[fi], pat = feed.pats[feed.trips[schedule.ti[j] * 4]];
    data.push({ path: p.path, ts: p.ts, c: feed.routes[pat.r].rgb, f: fi, r: pat.r, m: feed.routes[pat.r].mode });
  }
  Object.assign(trails, { data, w0, w1, base, L, zoomKey: mode + gap + Math.round(map.getZoom()), bounds, version: (trails.version ?? 0) + 1 });
}
function ensureTrails() {
  const t = clock.t;
  if (trails.dirty || t < trails.w0 - 1 || t > trails.w1) buildTrails();
}
map.on('moveend', () => {
  const z = map.getZoom();
  const [mode, gap] = lod(z);
  if (mode + gap + Math.round(z) !== trails.zoomKey) trails.dirty = true;
  else if (trails.bounds) {
    const v = viewBounds(0);
    if (v[0] < trails.bounds[0] || v[1] < trails.bounds[1] || v[2] > trails.bounds[2] || v[3] > trails.bounds[3]) trails.dirty = true;
  } else if (z >= 7) trails.dirty = true;
  routesLayerDirty = true;
});

// ---------- 路線の線・停留所（見ている範囲の分だけ） ----------
let routesLayerDirty = true;
let busLines = [];     // { path, f, r }（バス停を結んだ線。読み込んだ全フィード）
let busLinesKey = '';
let stopPts = [];      // { p, f, s }（時刻表のある停留所・駅。見ている範囲）
let p11Pts = [];       // { p, name, op }（全国のバス停。見ている範囲）
/** バス路線の線: 全フィードの系統パターンの形状（同じ形は 1 本）。読み込みや表示の切り替えのときだけ作り直す */
// フィードごとに一度だけ作って覚えておき、表示の切り替えや読み込みのたびには並べ直すだけにする
function feedBusLines(feed) {
  if (feed.busLines) return feed.busLines;
  const out = [], seen = new Set();
  for (const p of feed.pats) {
    const m = feed.routes[p.r].mode;
    if (m > 1 || seen.has(p.g)) continue;
    seen.add(p.g);
    const sh = feed.shape(p.g);
    const path = new Float64Array(sh.lat.length * 2);
    for (let v = 0; v < sh.lat.length; v++) { path[v * 2] = sh.lon[v]; path[v * 2 + 1] = sh.lat[v]; }
    out.push({ path, f: feed.i, r: p.r, m });
  }
  return (feed.busLines = out);
}
function buildBusLines() {
  // 読み込み中は rebuildDay（3 秒に 1 回）のときだけ増やす
  const key = `${schedule.day}|${lastRebuild}|${modeOn[0]}|${modeOn[1]}`;
  if (key === busLinesKey) return;
  busLinesKey = key;
  busLines = [];
  for (const feed of feeds) {
    if (!feed) continue;
    for (const l of feedBusLines(feed)) if (modeOn[l.m]) busLines.push(l);
  }
}
function buildRouteLines() {
  routesLayerDirty = false;
  stopPts = []; p11Pts = [];
  const z = map.getZoom();
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
      }
    });
  } catch (e) { console.warn('rail-lines', e); }
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
function clearSelection() {
  panelArea = null;
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
function findTripIndex(f, k) {
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
  h += `<p class="op">${esc(agencyName(feed, rt))}${rt.long && rt.short ? `　${esc(rt.long)}` : ''}${sub != null ? `<span class="badge" title="時刻表の期間外なので ${dateKeyOf(sub)} のダイヤで走らせています">代わりのダイヤ</span>` : ''}</p>`;
  const W = words(rt);
  h += `<dl class="kv"><dt>この日の便</dt><dd>${fmt(trips.length)} ${rt.mode === 2 ? '本' : '便'}</dd><dt>いま走行中</dt><dd>${fmt(running)} ${W.unit}</dd>`;
  // 前日の深夜便（−24 時間して入れている）は除いて、この日の始発・最終
  const own = trips.filter((x) => x.start >= 0).map((x) => x.start);
  if (own.length) h += `<dt>始発・最終</dt><dd>${hhmm(Math.min(...own))} 〜 ${hhmm(Math.max(...own))} 発</dd>`;
  h += '</dl>';
  h += `<div class="act"><button type="button" data-act="fit">この${W.line}に寄る</button>${selTrip ? `<button type="button" data-act="follow" aria-pressed="${follow}">この${W.v}を追う</button>` : ''}<button type="button" data-act="close">閉じる</button></div>`;
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
  h += `<p class="note">出典: ${esc(feed.meta.name)}（${esc(feed.meta.src)}・${esc(feed.meta.license)}）。時刻表どおりの位置で、遅れや運休は入っていません。</p>`;
  return h;
}
function tripSection() {
  const j = findTripIndex(selTrip.f, selTrip.k);
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
});
$('panelClose').onclick = clearSelection;

// ---------- ホバー・クリック ----------
const tip = $('tip');
function onHover(info) {
  map.getCanvas().style.cursor = info.object || (info.layer?.id === 'buses' && info.index >= 0) ? 'pointer' : '';
  const o = describe(info);
  const hr = info.layer?.id === 'routes' && info.object ? { f: info.object.f, r: info.object.r } : null;
  if ((hr?.f !== hoverRoute?.f) || (hr?.r !== hoverRoute?.r)) hoverRoute = hr;
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
  if (info.layer.id === 'routes' && info.object) {
    const feed = feeds[info.object.f], rt = feed.routes[info.object.r];
    return `<b>${esc(routeName(rt))}</b><span>${esc(agencyName(feed, rt))}　押すと選べます</span>`;
  }
  if (info.layer.id === 'tracks' && info.object) {
    const m = trackMeta[info.object.li];
    return `<b>${esc(m.name)}</b><span>${esc(m.op)}　線路（国土数値情報）</span>`;
  }
  if (info.layer.id === 'p11' && info.object) {
    return `<b>${esc(info.object.name)}</b><span>${esc(info.object.op)}　バス停（国土数値情報 P11）。時刻表のデータはまだありません</span>`;
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
  if (info.layer?.id === 'buses' && info.index >= 0 && info.index < nRun) {
    const j = runIdx[info.index];
    const fi = schedule.tf[j], k = schedule.ti[j];
    const feed = feeds[fi], pat = feed.pats[feed.trips[k * 4]];
    selTrip = { f: fi, k };
    selectRoute(fi, pat.r, { keepTrip: true });
    return;
  }
  if (info.layer?.id === 'routes' && info.object) { selectRoute(info.object.f, info.object.r); return; }
  if (info.layer?.id === 'areas' && info.object) { showArea(info.object); return; }
  if ((info.layer?.id === 'stops' || info.layer?.id === 'selStops') && info.object) {
    const f = info.object.f ?? sel.f;
    selStop = { f, s: info.object.s };
    refreshPanel();
    return;
  }
  // 何も無い所を押したら選択を外す
  if (sel || selStop) clearSelection();
}

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
  if (routesLayerDirty) buildRouteLines();
  const dark = theme === 'dark';
  if (lineOn.track && trackLines.length) {
    // 線路は背景。新幹線は少し明るく
    out.push(new PathLayer({
      id: 'tracks',
      data: trackLines,
      getPath: (d) => d.path,
      positionFormat: 'XY',
      getColor: (d) => (dark ? (d.kind === 1 ? [150, 200, 255, 120] : [150, 175, 165, 90]) : (d.kind === 1 ? [40, 90, 170, 150] : [70, 90, 85, 110])),
      getWidth: (d) => (d.kind === 1 ? 1.6 : 1.2) * (z >= 13 ? 1.6 : z >= 10 ? 1.2 : 1),
      widthUnits: 'pixels',
      widthMinPixels: 0.8,
      opacity: dim ? 0.4 : 1,
      pickable: z >= 9,
      autoHighlight: true,
      highlightColor: dark ? [220, 255, 230, 200] : [0, 90, 60, 200],
      updateTriggers: { getColor: [dark], getWidth: [z >= 13, z >= 10] },
    }));
  }
  if (lineOn.busline) {
    buildBusLines();
    // バス停を結んだ線。押すと系統を選ぶ（odpt の地図と同じく、ホバーで白く光る）
    out.push(new PathLayer({
      id: 'routes',
      data: busLines,
      getPath: (d) => d.path,
      positionFormat: 'XY',
      getColor: dark ? [255, 214, 120, dim ? 14 : z >= 13 ? 60 : z >= 9 ? 42 : 30] : [150, 90, 0, dim ? 18 : z >= 13 ? 90 : 55],
      getWidth: z >= 14 ? 2.2 : z >= 10 ? 1.4 : 1,
      widthUnits: 'pixels',
      widthMinPixels: 0.6,
      pickable: z >= 9,
      autoHighlight: true,
      highlightColor: dark ? [255, 255, 255, 220] : [0, 90, 150, 220],
      updateTriggers: { getColor: [dim, z >= 13, z >= 9, dark] },
    }));
  }
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
        getWidth: (d) => (d.m === 1 ? 1.5 : d.m === 2 ? 1.35 : 1) * tr.wd * w,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        capRounded: true,
        jointRounded: true,
        fadeTrail: true,
        trailLength: Math.max(1, L * tr.k),
        currentTime: clock.t - trails.base,
        opacity: tr.a,
        parameters: { ...add, depthWriteEnabled: false, depthCompare: 'always' },
        updateTriggers: { getColor: [sel?.f, sel?.r, trails.version, dark], getWidth: [w] },
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
  if (selTrip) {
    const j = findTripIndex(selTrip.f, selTrip.k);
    if (j >= 0 && schedule.ts[j] <= clock.t && schedule.te[j] >= clock.t) {
      const p = [0, 0, 0];
      schedule.position(j, clock.t, p);
      out.push(new ScatterplotLayer({ id: 'selBus', data: [p], getPosition: (d) => [d[0], d[1]], radiusUnits: 'pixels', getRadius: 9, getFillColor: [...selGeom.c, 255], stroked: true, getLineColor: [255, 255, 255], lineWidthUnits: 'pixels', getLineWidth: 3 }));
      if (follow) map.jumpTo({ center: [p[0], p[1]] });
    }
  }
  return out;
}

// ---------- 時計 ----------
let last = performance.now(), uiTick = 0;
const perf = { ms: 0 };
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
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
    updateAreas();
    ensureTrails();
    overlay.setProps({ layers: layers() });
    perf.ms = perf.ms * 0.95 + (performance.now() - w0) * 0.05;
  }
  if (now - uiTick > 120) {
    uiTick = now;
    $('time').textContent = hhmmss(clock.t);
    if (!sliderDragging) $('slider').value = Math.floor(clock.t);
    $('nRun').textContent = fmt(nRun);
    renderChips();
    if (selTrip || selStop || sel) {
      panelTimer++;
      if (panelTimer % 8 === 0 && !$('panel').matches(':hover')) refreshPanel();
    }
  }
  requestAnimationFrame(frame);
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
$('btnSettings').onclick = () => { const p = $('settings'); p.hidden = !p.hidden; $('btnSettings').setAttribute('aria-expanded', String(!p.hidden)); };
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
    $('lineChips').innerHTML = LINES.map((l) => `<button type="button" class="line" data-l="${l.key}" aria-pressed="${!!lineOn[l.key]}"><i class="ln ln-${l.key}"></i>${l.label}</button>`).join('');
    $('lineChips').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const k = b.dataset.l;
      lineOn[k] = !lineOn[k];
      b.setAttribute('aria-pressed', String(lineOn[k]));
      try { localStorage.setItem('bt.lines', JSON.stringify(lineOn)); } catch { /* 使えなくてもよい */ }
      routesLayerDirty = true;
    };
  }
  const counts = [nMode[0], nMode[1], nMode[2], activeAreas.length];
  [...el.children].forEach((b, i) => { b.querySelector('b').textContent = fmt(counts[i]); b.title = `${MODES[i].label} ${fmt(counts[i])} ${MODES[i].unit}${modeOn[i] ? '' : '（非表示）'}`; });
}
$('theme').onchange = (e) => {
  theme = e.target.value;
  try { localStorage.setItem('bt.theme', theme); } catch { /* 使えなくてもよい */ }
  document.documentElement.dataset.theme = theme;
  map.setStyle(STYLES[theme]);
  drawHist();
};
$('btnSources').onclick = () => $('dlgSources').showModal();
$('btnHelp').onclick = () => $('dlgHelp').showModal();
map.on('zoomend', () => { routesLayerDirty = true; });

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
function placePanel() {
  const narrow = innerWidth < 760;
  const top = narrow ? null : Math.ceil($('head').getBoundingClientRect().bottom + 8);
  $('panel').style.top = top ? `${top}px` : '';
  $('panel').style.maxHeight = top ? `calc(100vh - ${top}px - 150px)` : '';
}
addEventListener('resize', placePanel);
new ResizeObserver(placePanel).observe($('head'));

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
  const x = bySrc('事業者サイト');
  const hoda = list.filter((m) => /HODA/.test(m.src));
  const unl = bySrc('公開の案内なし');
  $('sourcesBody').innerHTML = `
    <p>バスの時刻・停留所・経路は、各事業者・自治体が公開している GTFS-JP（標準的なバス情報フォーマット）を加工して使っています。
    位置は時刻表から計算したもので、実際の運行とは異なります。<b>最新の時刻は各事業者の案内で確かめてください。</b></p>
    <ul>
      <li>gtfs-data.jp（GTFSデータリポジトリ）に登録されたデータ: ${fmt(bySrc('gtfs-data.jp').length)} 件</li>
      <li>公共交通オープンデータセンター（ODPT）のデータ: ${fmt(bySrc('ODPT').length)} 件 — 「出典：公共交通オープンデータセンター」。公共交通オープンデータ基本ライセンスのものを含みます</li>
      ${x.length ? `<li>GTFS を公開していない事業者の、事業者サイトの時刻表から組み直したもの（非公式）: ${fmt(x.length)} 件</li>` : ''}
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
    </ul>
    <p>データの作成日: ${esc(index.generated.slice(0, 10))}</p>
    <table><thead><tr><th>データ</th><th>入手先</th><th>ライセンス</th><th>便</th></tr></thead><tbody>${[...list].sort((a, b) => b.trips - a.trips).map(row).join('')}</tbody></table>`;
}

// ---------- 開始 ----------
map.on('load', () => {
  goNow();
  syncControls();
  requestAnimationFrame(frame);
  loadStatic();
  loadAll().catch((e) => { $('load').textContent = 'データを読み込めませんでした'; console.error(e); });
});
// 確認用（開発者ツールから状態を見る）
window.__bt = { map, schedule, clock, trails, feeds, buildTrails, perf, overlay };
