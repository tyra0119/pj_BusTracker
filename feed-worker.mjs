// フィードの取得と解析を、画面とは別のスレッドで行う（feed-prepare.mjs）
// 取るのは地域ごとにまとめたファイル（data/b/<k>.json。フィードの JSON を並べた配列。scripts/build-bundles.mjs）。
// フィードごとに詰めて、まとめて渡す（配列はコピーせずに渡す）
import { prepareFeed } from './feed-prepare.mjs?v=91a8013-1612';

self.onmessage = async (e) => {
  const { id, url } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : [raw];
    const data = [], transfer = [];
    for (const r of list) { const p = prepareFeed(r); data.push(p.data); transfer.push(...p.transfer); }
    self.postMessage({ id, data }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
