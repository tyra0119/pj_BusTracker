// 地形の立体（利用者の指定。2026-10-12）: 国土地理院の標高タイル（DEM10B、10 m 間隔）を MapLibre の地形にする。
//  - 地理院の標高 PNG は MapLibre の形式（Terrarium）と違うので、読み込むときに変換する（btdem://）
//  - バス・軌跡・停留所（deck.gl）は地図の外の部品で、地形の高さを知らない。同じタイルの標高を elevAt() で引いて、
//    点に高さ（m、強調する前）を持たせる。強調の倍率は deck.gl の層の modelMatrix（高さだけを伸ばす）で掛ける

const TILE = 256;
const GSI_DEM = 'cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
export const DEM_MAX_ZOOM = 14;
export const DEM_CREDIT = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル（標高）</a>';

// 地理院の値 → 標高 m（海などの「値なし」は null）
function gsiHeight(r, g, b) {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null;
  return (x > 8388608 ? x - 16777216 : x) * 0.01;
}

function makeCanvas() {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(TILE, TILE);
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  return c;
}
async function canvasToPng(canvas) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return blob.arrayBuffer();
}

// 読んだタイルの標高（m、Int16）。点の高さを引くのに使う。古いものから捨てる
const heights = new Map(); // key(z,x,y) → Int16Array(256*256)
const MAX_TILES = matchMedia('(pointer: coarse)').matches ? 80 : 200;
const keyOf = (z, x, y) => (z * 16384 + y) * 16384 + x;
let version = 0;
const listeners = new Set();
let notifyTimer = 0;
/** 新しいタイルが読めたとき（まとめて 0.4 秒ごと）に呼ぶ */
export function onElevationChange(fn) { listeners.add(fn); }
export const elevationVersion = () => version;

let flatTile = null;
function getFlatTile() {
  if (!flatTile) {
    const canvas = makeCanvas();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(128,0,0)'; // Terrarium で 0 m
    ctx.fillRect(0, 0, TILE, TILE);
    flatTile = canvasToPng(canvas);
  }
  return flatTile;
}

// 変換したタイル。地形用と陰影用の 2 つの source が同じタイルを読むので、取得と変換は 1 回にして使い回す（2026-10-12。
// 前は 2 回ずつ取って変換していて、山の多い所では読み終わるまで 10 秒以上かかり、その間は 0 m の平らな所が崖のように見えた）
const done = new Map();    // url → 変換した PNG（ArrayBuffer）。古いものから捨てる
const pending = new Map(); // url → { promise, ctrl, refs }（読み込み中。待っている source がみな取りやめたら取得もやめる）

async function loadTile(url, signal) {
  const m = /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
  const res = await fetch(url, { signal });
  // 0 m の平らなタイルにするのは「タイルが無い」（海の上など、404）ときだけ。サーバーの一時的な失敗（5xx・429）や通信の失敗は
  // 失敗のまま返す（0 m で埋めると、その場所が開き直すまで崖のまま残る。失敗なら MapLibre が次に見たとき取り直す）
  if (res.status === 404) return getFlatTile();
  if (!res.ok) throw new Error(`標高タイル ${res.status} ${url}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const img = ctx.getImageData(0, 0, TILE, TILE);
  const d = img.data;
  const h16 = new Int16Array(TILE * TILE);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const h = gsiHeight(d[i], d[i + 1], d[i + 2]) ?? 0;
    h16[p] = Math.round(h);
    const v = h + 32768, whole = Math.floor(v);
    d[i] = whole >> 8; d[i + 1] = whole & 255; d[i + 2] = Math.floor((v - whole) * 256); d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (m) {
    const k = keyOf(+m[1], +m[2], +m[3]);
    heights.delete(k);
    heights.set(k, h16);
    if (heights.size > MAX_TILES) heights.delete(heights.keys().next().value);
    version++;
    if (!notifyTimer) notifyTimer = setTimeout(() => { notifyTimer = 0; for (const fn of listeners) fn(); }, 400);
  }
  return canvasToPng(canvas);
}

maplibregl.addProtocol('btdem', async (params, abort) => {
  const url = params.url.replace('btdem://', 'https://');
  // MapLibre は受け取った ArrayBuffer を処理用のスレッドへ渡して使えなくするので、写しを返す
  if (done.has(url)) { const buf = done.get(url); done.delete(url); done.set(url, buf); return { data: buf.slice(0) }; }
  let e = pending.get(url);
  if (!e) {
    const ctrl = new AbortController();
    e = { ctrl, refs: 0, promise: null };
    e.promise = loadTile(url, ctrl.signal).then((buf) => {
      done.set(url, buf);
      if (done.size > MAX_TILES) done.delete(done.keys().next().value);
      return buf;
    }).finally(() => { if (pending.get(url) === e) pending.delete(url); });
    pending.set(url, e);
  }
  e.refs++;
  // みな取りやめたら取得もやめる。すぐ一覧から外すので、そのあと同じタイルを頼まれたら取り直す
  const onAbort = () => { if (--e.refs <= 0) { if (pending.get(url) === e) pending.delete(url); e.ctrl.abort(); } };
  abort.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return { data: (await e.promise).slice(0) };
  } finally {
    abort.signal.removeEventListener('abort', onAbort);
  }
});

/** 地形の元（MapLibre の source）。地形用と陰影用は別にする（同じだと MapLibre が警告し、陰影が粗くなる） */
export const demSource = () => ({
  type: 'raster-dem', tiles: [`btdem://${GSI_DEM}`], tileSize: TILE, minzoom: 1, maxzoom: DEM_MAX_ZOOM, encoding: 'terrarium', attribution: DEM_CREDIT,
});

// いま地図が使っていそうなズーム（256 画素のタイルは地図の縮尺 + 1）。ここから粗いほうへ探す
let prefZoom = 6;
export function setViewZoom(z) { prefZoom = Math.max(1, Math.min(DEM_MAX_ZOOM, Math.floor(z) + 1)); }

/** 標高（m、強調する前）。読んでいないところ・海は 0 */
export function elevAt(lon, lat) {
  const xn = (lon + 180) / 360;
  const s = Math.sin(lat * Math.PI / 180);
  const yn = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  for (let z = prefZoom; z >= 1; z--) {
    const n = 1 << z;
    const xf = xn * n, yf = yn * n;
    const tx = Math.floor(xf), ty = Math.floor(yf);
    const h = heights.get(keyOf(z, tx, ty));
    if (!h) continue;
    const px = Math.min(TILE - 1, Math.floor((xf - tx) * TILE)), py = Math.min(TILE - 1, Math.floor((yf - ty) * TILE));
    return h[py * TILE + px];
  }
  return 0;
}

/** [lon, lat, ...] の並び → [lon, lat, 高さ, ...] */
export function withHeights(flat) {
  const n = flat.length >> 1, out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const lon = flat[i * 2], lat = flat[i * 2 + 1];
    out[i * 3] = lon; out[i * 3 + 1] = lat; out[i * 3 + 2] = elevAt(lon, lat);
  }
  return out;
}

// 引いて見るほど山は平たく見えるので、縮尺が小さいときは高さを強める（縮尺 10 以上は 1.5 倍、日本全体でおよそ 20 倍）
export const exaggerationFor = (z) => 1.5 * Math.min(16, Math.max(1, 2 ** ((10 - z) / 1.2)));
/** deck.gl の層に渡す、高さだけを k 倍にする行列 */
export const zScale = (k) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];
