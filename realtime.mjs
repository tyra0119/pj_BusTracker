// リアルタイムの位置（GTFS-RT VehiclePosition）。公共交通オープンデータセンター（ODPT）の配信を、
// 中継サーバ（https://tyra.jp/odpt/api/ 。トークンはサーバ側。GitHub/call/proxy/USAGE.md）を通して読む。
//  - 見ている範囲の事業者だけ、1 事業者 30 秒に 1 回まで。中継は 1 IP 60 回/分なので、1 回の巡回は 8 件まで
//  - 便の ID（trip_id）で時刻表の便に結び、実際の位置が時刻表では何時の位置かを求めて、遅れを出す
// protobuf は最小のデコーダを自前で持つ（iss/web/gtfsrt.mjs と同じ）

const RELAY = 'https://tyra.jp/odpt/api';
const INTERVAL = 30e3;
const PER_ROUND = 8;

function decode(buf, off = 0, end = buf.length) {
  const out = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (off < end) {
    let key = 0, shift = 0, b;
    do { b = buf[off++]; key |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const field = key >>> 3, wt = key & 7;
    if (wt === 0) { let v = 0, m = 1; do { b = buf[off++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80); out.push([field, v]); }
    else if (wt === 1) { out.push([field, dv.getFloat64(off, true)]); off += 8; }
    else if (wt === 5) { out.push([field, dv.getFloat32(off, true)]); off += 4; }
    else if (wt === 2) { let len = 0, s = 0; do { b = buf[off++]; len |= (b & 0x7f) << s; s += 7; } while (b & 0x80); out.push([field, buf.subarray(off, off + len)]); off += len; }
    else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}
const td = new TextDecoder();
const str = (u8) => (u8 ? td.decode(u8) : '');
const get = (fields, n) => fields.find((f) => f[0] === n)?.[1];

/** FeedMessage → 車両の一覧 { tripId, routeId, lat, lon, bearing, ts, label, id } */
export function parseVehicles(buf) {
  const msg = decode(buf);
  const header = decode(get(msg, 1) ?? new Uint8Array());
  const feedTs = get(header, 3) ?? 0;
  const list = [];
  for (const e of msg) {
    if (e[0] !== 2) continue;
    const fe = decode(e[1]);
    const vpb = get(fe, 4);
    if (!vpb) continue;
    const v = decode(vpb);
    const trip = get(v, 1) ? decode(get(v, 1)) : [];
    const pos = get(v, 2) ? decode(get(v, 2)) : [];
    const veh = get(v, 8) ? decode(get(v, 8)) : [];
    const lat = get(pos, 1), lon = get(pos, 2);
    if (!lat || !lon) continue;
    list.push({
      tripId: str(get(trip, 1)), routeId: str(get(trip, 5)),
      lat, lon, bearing: get(pos, 3) ?? null,
      ts: get(v, 5) ?? feedTs, id: str(get(veh, 1)) || str(get(fe, 1)), label: str(get(veh, 2)),
    });
  }
  return { feedTs, list };
}

export class Realtime {
  constructor() {
    this.list = [];          // rt.json: { name, side, i }
    this.state = new Map();  // name -> { at, vehicles, error }
    this.tripMaps = new Map(); // feed i -> Map(tripId -> 便番号 k) | 'loading'
    this.pausedUntil = 0;
    this.busy = false;
  }
  async load() {
    try { const r = await fetch('./data/rt.json'); if (r.ok) this.list = await r.json(); } catch { /* 無くてもよい */ }
  }
  tripMap(i) {
    const m = this.tripMaps.get(i);
    if (m && m !== 'loading') return m;
    if (!m) {
      this.tripMaps.set(i, 'loading');
      fetch(`./data/rt/${i}.json`).then((r) => r.json()).then((d) => { this.tripMaps.set(i, new Map(d.trips.map((t, k) => [t, k]))); }).catch(() => this.tripMaps.delete(i));
    }
    return null;
  }
  /** 見ている範囲の配信（feedOk(i) が真のもの）のうち、古いものから取りに行く */
  async poll(feedOk) {
    if (this.busy || Date.now() < this.pausedUntil) return;
    const now = Date.now();
    const due = this.list.filter((x) => feedOk(x.i) && now - (this.state.get(x.name)?.at ?? 0) >= INTERVAL)
      .sort((a, b) => (this.state.get(a.name)?.at ?? 0) - (this.state.get(b.name)?.at ?? 0)).slice(0, PER_ROUND);
    if (!due.length) return;
    this.busy = true;
    try {
      for (const x of due) {
        this.tripMap(x.i);
        try {
          const res = await fetch(`${RELAY}/${x.side}/v4/gtfs/realtime/${x.name}`);
          if (res.status === 429 || res.status === 503) { this.pausedUntil = Date.now() + (Number(res.headers.get('Retry-After')) || 60) * 1000; break; }
          if (!res.ok) { this.state.set(x.name, { at: Date.now(), vehicles: [], error: `HTTP ${res.status}`, i: x.i }); continue; }
          const { feedTs, list } = parseVehicles(new Uint8Array(await res.arrayBuffer()));
          this.state.set(x.name, { at: Date.now(), feedTs, vehicles: list, i: x.i });
        } catch (e) { this.state.set(x.name, { at: Date.now(), vehicles: [], error: String(e.message ?? e), i: x.i }); }
      }
    } finally { this.busy = false; }
  }
  /** いまの車両を全部（{ ...v, i: フィード, name: 配信 }） */
  vehicles(feedOk) {
    const out = [];
    for (const [name, st] of this.state) {
      if (!feedOk(st.i)) continue;
      // 5 分より古い位置は出さない（止まった配信）
      const fresh = Date.now() / 1000 - 300;
      for (const v of st.vehicles) if (!v.ts || v.ts >= fresh) out.push({ ...v, i: st.i, name });
    }
    return out;
  }
}
