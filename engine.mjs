// 時刻表どおりのバスの位置を計算する（地図や画面には触らない）
//  - フィード（build-data.mjs の出力）を読み、選んだ日に走る便を集める
//  - 時刻 t（その日の 0 時からの秒）で、走っている便の位置を形状に沿って補間する
//  - 軌跡（TripsLayer）用に、時間の窓の中の経路と通過時刻を作る
import { holidayName } from './holidays.mjs?v=10869d0-1330';
import { prepareFeed } from './feed-prepare.mjs?v=10869d0-1330';

const DAY = 86400;
const EPOCH = Date.UTC(2000, 0, 1);
export const dayNumOf = (dateKey) => Math.round((Date.UTC(+dateKey.slice(0, 4), +dateKey.slice(5, 7) - 1, +dateKey.slice(8, 10)) - EPOCH) / 864e5);
export const dateKeyOf = (n) => new Date(EPOCH + n * 864e5).toISOString().slice(0, 10);
const weekdayOf = (n) => (new Date(EPOCH + n * 864e5).getUTCDay() + 6) % 7; // 0 = 月曜
/** 土休日ダイヤの日か（日曜・祝日・年末年始） */
const isRestDay = (n) => {
  const k = dateKeyOf(n), md = k.slice(5);
  return weekdayOf(n) === 6 || !!holidayName(k) || md >= '12-30' || md <= '01-03';
};

// ---------- 復号 ----------
function decodePolyline(str) {
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
  return { lat: Float64Array.from(lat), lon: Float64Array.from(lon) };
}
const RAD = Math.PI / 180;
function cumDist(lat, lon) {
  const n = lat.length, c = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dl = (lat[i] - lat[i - 1]) * RAD, dn = (lon[i] - lon[i - 1]) * RAD * Math.cos(((lat[i] + lat[i - 1]) / 2) * RAD);
    c[i] = c[i - 1] + 6371008.8 * Math.sqrt(dl * dl + dn * dn);
  }
  return c;
}

// 路線の色が無いとき: 事業者ごとに見分けやすい明るい色
// 点と軌跡の色は乗り物の種類で決める（上の札と同じ色。app.mjs の MODES）。以前は事業者の系統の色・データごとの色で、
// 札の「高速バス」と同じシアンの路線バスがあり紛らわしかった（利用者の指定。2026-10-04）。事業者の色は route.color に残す
const MODE_RGB = [[255, 196, 0], [56, 214, 255], [120, 255, 160], [255, 140, 70]];
function hexColor(hex) {
  if (!hex) return null;
  const v = parseInt(hex, 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  // 暗い地図の上で見えるように、暗すぎる色は明るくする
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  if (lum < 90) { const k = 90 / Math.max(lum, 10); return c.map((x) => Math.min(255, Math.round(x * k + 60))); }
  return c;
}

export class Feed {
  // raw: feed-worker.mjs が詰めたもの（packed）か、JSON そのもの（Worker が使えないとき。ここで詰める）
  constructor(meta, raw) {
    const d = raw.packed ? raw : prepareFeed(raw).data;
    this.meta = meta;
    this.i = meta.i;
    this.agencies = d.agencies;
    // mode: 0 路線バス / 1 高速バス / 2 鉄道 / 3 デマンド交通
    this.routes = d.routes.map(([short, long, color, ai, mode]) => ({ short, long, color: hexColor(color), ai, mode: mode ?? 0, hw: mode === 1 }));
    for (const r of this.routes) r.rgb = MODE_RGB[r.mode] ?? MODE_RGB[0];
    this.svc = d.svc;
    this.stopLat = d.stopLat; this.stopLon = d.stopLon; this.stopNames = d.stopNames;
    this.shapesRaw = d.shapes;
    this.shapes = new Array(d.shapes.length);
    // 1 本の配列の一部を指す（コピーしない）
    this.pats = Array.from(d.patR, (r, i) => ({ r, h: d.patH[i], g: d.patG[i], s: d.patS.subarray(d.patOff[i], d.patOff[i + 1]), d: d.patD.subarray(d.patOff[i], d.patOff[i + 1]) }));
    this.profs = Array.from({ length: d.profOff.length - 1 }, (_, i) => ({ arr: d.profArr.subarray(d.profOff[i], d.profOff[i + 1]), dep: d.profDep.subarray(d.profOff[i], d.profOff[i + 1]) }));
    this.trips = d.trips;
    this.nTrips = this.trips.length / 4;
    // デマンド交通の区域（凸包）と、乗れる時間帯 [系統, 運行日, 始, 終, 区域]
    this.areas = d.areas.map((a) => { const p = decodePolyline(a); return Array.from(p.lat, (lat, i) => [p.lon[i], lat]); });
    this.flex = d.flex;
  }
  shape(g) {
    let s = this.shapes[g];
    if (!s) { s = decodePolyline(this.shapesRaw[g]); s.cum = cumDist(s.lat, s.lon); this.shapes[g] = s; }
    return s;
  }
  /** その日に動く運行日（service）の印。範囲外の日は同じ曜日（土休日）の日を代わりに使う */
  activeFor(day) {
    const [lo, hi] = this.meta.range;
    let use = day, substitute = false;
    if (lo > -1e6 && (day < lo || day > hi)) {
      const want = weekdayOf(day), rest = isRestDay(day);
      const from = day > hi ? hi : lo, step = day > hi ? -1 : 1;
      for (let k = 0; k < 120; k++) {
        const d = from + step * k;
        if (weekdayOf(d) === want && isRestDay(d) === rest) { use = d; substitute = true; break; }
      }
    }
    const wd = weekdayOf(use);
    const mask = new Uint8Array(this.svc.length);
    this.svc.forEach(([s, e, w, add, rem], i) => {
      if (add.includes(use)) { mask[i] = 1; return; }
      if (s >= 0 && use >= s && use <= e && (w >> wd) & 1 && !rem.includes(use)) mask[i] = 1;
    });
    return { mask, substitute: substitute ? use : null };
  }
}

/**
 * 走る便の一覧（その日）と、時刻 t の位置。
 * 便 = (フィード, 便番号, 始発の秒, 終着の秒)。前日の 24 時を過ぎる便は −24 時間して入れる
 */
export class Schedule {
  constructor() {
    this.feeds = [];
    this.day = null;
    this.substitutes = new Map(); // feed.i -> 代わりに使った日
    this.reset();
  }
  reset() {
    this.n = 0;
    this.tf = new Int32Array(0); this.ti = new Int32Array(0); this.ts = new Int32Array(0); this.te = new Int32Array(0);
    this.buckets = [];
    this.hist = new Uint32Array(144);
  }
  addFeed(feed) { this.feeds[feed.i] = feed; }
  /** 日を決めて便の一覧を作り直す */
  build(day) {
    this.day = day;
    this.substitutes.clear();
    const F = [], I = [], S = [], E = [];
    for (const feed of this.feeds) {
      if (!feed) continue;
      for (const [d, shift] of [[day, 0], [day - 1, -DAY]]) {
        const { mask, substitute } = feed.activeFor(d);
        if (shift === 0 && substitute != null) this.substitutes.set(feed.i, substitute);
        const T = feed.trips;
        for (let k = 0; k < feed.nTrips; k++) {
          if (!mask[T[k * 4 + 2]]) continue;
          const start = T[k * 4 + 3] + shift;
          const prof = feed.profs[T[k * 4 + 1]];
          const end = start + prof.dep[prof.dep.length - 1];
          if (end < 0 || start >= DAY + 3 * 3600) continue;
          F.push(feed.i); I.push(k); S.push(start); E.push(end);
        }
      }
    }
    // デマンド交通: その日に乗れる区域と時間帯
    this.flexToday = [];
    for (const feed of this.feeds) {
      if (!feed || !feed.flex.length) continue;
      const { mask } = feed.activeFor(day);
      for (let k = 0; k < feed.flex.length; k += 5) {
        if (mask[feed.flex[k + 1]]) this.flexToday.push({ f: feed.i, r: feed.flex[k], s: feed.flex[k + 2], e: feed.flex[k + 3], a: feed.flex[k + 4] });
      }
    }
    this.n = F.length;
    this.tf = Int32Array.from(F); this.ti = Int32Array.from(I); this.ts = Int32Array.from(S); this.te = Int32Array.from(E);
    // 10 分ごとの入れ物（その 10 分に走っている便）
    const nb = 28 * 6;
    const lists = Array.from({ length: nb }, () => []);
    const hist = new Uint32Array(144);
    for (let j = 0; j < this.n; j++) {
      const a = Math.max(0, Math.floor(this.ts[j] / 600)), b = Math.min(nb - 1, Math.floor(this.te[j] / 600));
      for (let q = a; q <= b; q++) { lists[q].push(j); if (q < 144) hist[q]++; }
    }
    this.buckets = lists.map((l) => Int32Array.from(l));
    this.hist = hist;
  }
  /** 時刻 t に走っている便の番号（this の通し番号）を out に入れ、数を返す */
  running(t, out) {
    const b = this.buckets[Math.max(0, Math.min(this.buckets.length - 1, Math.floor(t / 600)))];
    if (!b) return 0;
    let m = 0;
    for (let q = 0; q < b.length; q++) { const j = b[q]; if (this.ts[j] <= t && this.te[j] >= t) out[m++] = j; }
    return m;
  }
  /** 範囲 [a, b] に少しでも走る便 */
  overlapping(a, b) {
    const out = [], seen = new Set();
    const qa = Math.max(0, Math.floor(a / 600)), qb = Math.min(this.buckets.length - 1, Math.floor(b / 600));
    for (let q = qa; q <= qb; q++) for (const j of this.buckets[q] ?? []) if (!seen.has(j) && this.ts[j] <= b && this.te[j] >= a) { seen.add(j); out.push(j); }
    return out;
  }
  tripInfo(j) {
    const feed = this.feeds[this.tf[j]], k = this.ti[j], T = feed.trips;
    const pat = feed.pats[T[k * 4]], prof = feed.profs[T[k * 4 + 1]];
    return { feed, pat, prof, start: this.ts[j], end: this.te[j], route: feed.routes[pat.r] };
  }
  /** 便 j の時刻 t の位置。out = [lon, lat, 向き(度)]。stopIdx も返す（次の停留所） */
  position(j, t, out) {
    const { feed, pat, prof, start } = this.tripInfo(j);
    const rel = t - start, arr = prof.arr, dep = prof.dep, n = arr.length;
    // 区間を二分探索: dep[k] <= rel < arr[k+1]
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid] <= rel) lo = mid; else hi = mid - 1; }
    let dist, next;
    if (rel <= dep[lo] || lo === n - 1) { dist = pat.d[lo]; next = lo; }
    else {
      const f = (rel - dep[lo]) / Math.max(1, arr[lo + 1] - dep[lo]);
      dist = pat.d[lo] + f * (pat.d[lo + 1] - pat.d[lo]);
      next = lo + 1;
    }
    const sh = feed.shape(pat.g);
    const c = sh.cum;
    let a = 0, b = c.length - 1;
    if (dist >= c[b]) { out[0] = sh.lon[b]; out[1] = sh.lat[b]; out[2] = bearing(sh, b - 1); return next; }
    while (a < b - 1) { const m = (a + b) >> 1; if (c[m] <= dist) a = m; else b = m; }
    const f = (dist - c[a]) / Math.max(1e-6, c[b] - c[a]);
    out[0] = sh.lon[a] + f * (sh.lon[b] - sh.lon[a]);
    out[1] = sh.lat[a] + f * (sh.lat[b] - sh.lat[a]);
    out[2] = bearing(sh, a);
    return next;
  }
  /**
   * 軌跡用の経路: 便ごとに [lon,lat] の並びと、各点を通る時刻（base からの秒）。
   * 時刻 [t0, t1] の部分だけ。coarse = 停留所だけを結ぶ（広域表示用、minGap m 未満の点は飛ばす）
   */
  trailPath(j, t0, t1, base, coarse, minGap) {
    const { feed, pat, prof, start } = this.tripInfo(j);
    const arr = prof.arr, dep = prof.dep, n = arr.length, d = pat.d;
    const sh = feed.shape(pat.g);
    const path = [], ts = [];
    const r0 = t0 - start, r1 = t1 - start;
    let lastD = -Infinity;
    const push = (lon, lat, tt, dd, force) => {
      if (!force && dd - lastD < minGap) return;
      path.push(lon, lat); ts.push(tt + start - base); lastD = dd;
    };
    // 距離 → 位置
    let cursor = 0;
    const at = (dist) => {
      const c = sh.cum;
      while (cursor < c.length - 2 && c[cursor + 1] < dist) cursor++;
      const a = cursor, b = Math.min(cursor + 1, c.length - 1);
      const f = c[b] > c[a] ? Math.min(1, Math.max(0, (dist - c[a]) / (c[b] - c[a]))) : 0;
      return [sh.lon[a] + f * (sh.lon[b] - sh.lon[a]), sh.lat[a] + f * (sh.lat[b] - sh.lat[a])];
    };
    for (let k = 0; k < n - 1; k++) {
      const ta = dep[k], tb = arr[k + 1];
      if (tb < r0) continue;
      if (ta > r1) break;
      const da = d[k], db = d[k + 1];
      const timeAt = (dd) => (db > da ? ta + ((dd - da) / (db - da)) * (tb - ta) : ta);
      const distAt = (tt) => (tb > ta ? da + ((tt - ta) / (tb - ta)) * (db - da) : da);
      const sa = Math.max(ta, r0), sb = Math.min(tb, r1);
      const dsa = distAt(sa), dsb = distAt(sb);
      if (!path.length) { const p = at(dsa); push(p[0], p[1], sa, dsa, true); }
      if (!coarse) {
        const c = sh.cum;
        for (let v = cursor; v < c.length; v++) {
          if (c[v] <= dsa) continue;
          if (c[v] >= dsb) break;
          cursor = v;
          push(sh.lon[v], sh.lat[v], timeAt(c[v]), c[v], false);
        }
      }
      const p = at(dsb);
      push(p[0], p[1], sb, dsb, sb === tb || sb === r1);
    }
    return path.length >= 4 ? { path, ts } : null;
  }
}
function bearing(sh, a) {
  const b = Math.min(a + 1, sh.lat.length - 1);
  if (a < 0 || a === b) return 0;
  const dy = sh.lat[b] - sh.lat[a], dx = (sh.lon[b] - sh.lon[a]) * Math.cos(sh.lat[a] * RAD);
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}
