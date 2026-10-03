// 日本の祝日（国民の祝日に関する法律）を計算で求める。土日と合わせて「土休日ダイヤ」の判定に使う
// 対応: 固定日、ハッピーマンデー、春分・秋分（近似式）、振替休日、国民の休日。2000 年以降を想定

const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const key = (dt) => dt.toISOString().slice(0, 10);
const nthMonday = (y, m, n) => { const first = D(y, m, 1).getUTCDay(); const d = 1 + ((8 - first) % 7) + (n - 1) * 7; return D(y, m, d); };
// 春分・秋分の日（2000〜2099 年の近似式。天文台の暦要項と一致する）
const vernal = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnal = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

/** その年の祝日（振替休日・国民の休日を含む）を Map<'YYYY-MM-DD', 名前> で返す */
export function holidaysOfYear(y) {
  const base = new Map();
  const add = (dt, name) => base.set(key(dt), name);
  add(D(y, 1, 1), '元日');
  add(nthMonday(y, 1, 2), '成人の日');
  add(D(y, 2, 11), '建国記念の日');
  add(D(y, 2, 23), '天皇誕生日');
  add(D(y, 3, vernal(y)), '春分の日');
  add(D(y, 4, 29), '昭和の日');
  add(D(y, 5, 3), '憲法記念日');
  add(D(y, 5, 4), 'みどりの日');
  add(D(y, 5, 5), 'こどもの日');
  add(nthMonday(y, 7, 3), '海の日');
  add(D(y, 8, 11), '山の日');
  add(nthMonday(y, 9, 3), '敬老の日');
  add(D(y, 9, autumnal(y)), '秋分の日');
  add(nthMonday(y, 10, 2), 'スポーツの日');
  add(D(y, 11, 3), '文化の日');
  add(D(y, 11, 23), '勤労感謝の日');
  const out = new Map(base);
  // 振替休日: 祝日が日曜なら、その後の最初の「祝日でない日」
  for (const [k] of base) {
    const dt = new Date(k);
    if (dt.getUTCDay() !== 0) continue;
    let n = new Date(dt.getTime() + 86400e3);
    while (base.has(key(n))) n = new Date(n.getTime() + 86400e3);
    out.set(key(n), '振替休日');
  }
  // 国民の休日: 祝日に挟まれた平日（敬老の日と秋分の日の間など）
  for (const [k] of base) {
    const dt = new Date(k);
    const mid = new Date(dt.getTime() + 86400e3), next = new Date(dt.getTime() + 2 * 86400e3);
    if (base.has(key(next)) && !out.has(key(mid)) && mid.getUTCDay() !== 0) out.set(key(mid), '国民の休日');
  }
  return out;
}

const cache = new Map();
/** 'YYYY-MM-DD' が祝日なら名前、そうでなければ null */
export function holidayName(dateKey) {
  const y = Number(dateKey.slice(0, 4));
  if (!cache.has(y)) cache.set(y, holidaysOfYear(y));
  return cache.get(y).get(dateKey) ?? null;
}

/** 土曜・日曜・祝日（土休日ダイヤの日）か。年末年始（12/30〜1/3）は多くの事業者が休日ダイヤなので含める */
export function isHolidayDia(dateKey) {
  const dow = new Date(`${dateKey}T12:00:00+09:00`).getDay();
  if (dow === 0 || dow === 6) return true;
  if (holidayName(dateKey)) return true;
  const md = dateKey.slice(5);
  return md === '12-30' || md === '12-31' || md === '01-02' || md === '01-03';
}
