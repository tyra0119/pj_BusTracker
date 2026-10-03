// フィード（data/f/<n>.json）を、画面のスレッドで使う形の数値配列に詰める。
// Web Worker（feed-worker.mjs）で動かし、配列はコピーせずに渡す（transfer）。
// スマホで大きく移動したとき、数 MB の JSON の解析で画面が固まっていた（2026-10-04）
// 形（shapes）は符号化した文字列のまま渡し、使うときに画面側で展開する（全部展開するとメモリが大きい）

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

/** JSON のフィード → { data, transfer }。data は Feed のコンストラクタにそのまま渡せる */
export function prepareFeed(raw) {
  const st = decodePolyline(raw.stops);
  // 系統パターン: 停留所と距離は 1 本の配列に並べ、始まりの位置（off）で引く
  const np = raw.pats.length;
  const patR = new Int32Array(np), patG = new Int32Array(np), patOff = new Int32Array(np + 1);
  const patH = new Array(np);
  let total = 0;
  for (let i = 0; i < np; i++) { patOff[i] = total; total += raw.pats[i][3].length; }
  patOff[np] = total;
  const patS = new Int32Array(total), patD = new Float64Array(total);
  raw.pats.forEach(([r, h, g, s, d], i) => {
    patR[i] = r; patG[i] = g; patH[i] = h;
    patS.set(s, patOff[i]); patD.set(d, patOff[i]);
  });
  // 時間の型 → 最初の停留所の着からの、各停留所の着・発（秒）
  const nf = raw.profs.length, profOff = new Int32Array(nf + 1);
  let tp = 0;
  for (let i = 0; i < nf; i++) { profOff[i] = tp; tp += raw.profs[i][0].length + 1; }
  profOff[nf] = tp;
  const profArr = new Int32Array(tp), profDep = new Int32Array(tp);
  raw.profs.forEach(([run, dwell], i) => {
    const o = profOff[i], n = run.length + 1;
    profDep[o] = dwell ? dwell[0] : 0;
    for (let k = 1; k < n; k++) { profArr[o + k] = profDep[o + k - 1] + run[k - 1]; profDep[o + k] = profArr[o + k] + (dwell ? dwell[k] : 0); }
  });
  const trips = Int32Array.from(raw.trips);
  const flex = Int32Array.from(raw.flex ?? []);
  const data = {
    packed: true,
    agencies: raw.agencies, routes: raw.routes, svc: raw.svc,
    stopLat: st.lat, stopLon: st.lon, stopNames: raw.stopNames,
    shapes: raw.shapes, areas: raw.areas ?? [],
    patR, patG, patH, patOff, patS, patD,
    profOff, profArr, profDep,
    trips, flex,
  };
  const transfer = [st.lat.buffer, st.lon.buffer, patR.buffer, patG.buffer, patOff.buffer, patS.buffer, patD.buffer, profOff.buffer, profArr.buffer, profDep.buffer, trips.buffer, flex.buffer];
  return { data, transfer };
}
