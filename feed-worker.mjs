// フィードの取得と解析を、画面とは別のスレッドで行う（feed-prepare.mjs）
import { prepareFeed } from './feed-prepare.mjs?v=2f35822-0643';

self.onmessage = async (e) => {
  const { id, url } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const { data, transfer } = prepareFeed(raw);
    self.postMessage({ id, data }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
