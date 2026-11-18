// 営業日の関数(ADR-0200 決定3 / 束 B18 裁定 §2.4。process-compass #445)。
//
// 営業日は土日を除いて数える。祝日は任意のファイル .github/business-holidays.txt(1行に YYYY-MM-DD。# から行末まではコメント)から読む。
// ファイルが無いときは土日だけを除き、出力に「祝日を数えていない」と必ず書く(HOLIDAYS_UNCOUNTED_NOTE)。
//
// 関数は時計を読まない。日付は引数で渡す(回帰の時計依存を避ける)。日付の計算は UTC の暦で行い、実行環境の TZ に依らない。
// 時刻(ISO 8601)を暦の日へ直すときは、明示した UTC からの差(分。既定は日本時間の +540)で直す(dayOf)。

import fs from 'node:fs';
import path from 'node:path';

/** 祝日のファイルの所在(リポジトリの根からの相対) */
export const HOLIDAYS_FILE = '.github/business-holidays.txt';
/** 祝日のファイルを読めなかったときに、出力へ必ず書く文 */
export const HOLIDAYS_UNCOUNTED_NOTE = `祝日を数えていない(${HOLIDAYS_FILE} が無い。土日だけを除いた営業日で数えた)`;
/** 暦の日へ直すときの既定の UTC からの差(分)。日本時間 */
export const DEFAULT_OFFSET_MINUTES = 540;

const DAY_MS = 86400000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD として実在する日か */
export function isRealDate(v) {
  const m = DAY_RE.exec(String(v ?? ''));
  if (!m) return false;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const toMs = (day) => {
  const m = DAY_RE.exec(day);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
};
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);

/** 祝日のファイルの本文から、祝日の集合を返す。読めない行は invalid に返す(捨てない) */
export function parseHolidays(text) {
  const days = new Set();
  const invalid = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (isRealDate(line)) days.add(line);
    else invalid.push(line);
  }
  return { days, invalid };
}

/** 祝日のファイルを読む。無ければ counted: false(土日だけを除く) */
export function loadHolidays(root) {
  const file = path.join(root, HOLIDAYS_FILE);
  if (!fs.existsSync(file)) return { days: new Set(), invalid: [], counted: false, note: HOLIDAYS_UNCOUNTED_NOTE };
  const r = parseHolidays(fs.readFileSync(file, 'utf8'));
  return { ...r, counted: true, note: r.invalid.length ? `祝日のファイルに読めない行がある(${r.invalid.join(', ')})。その行は祝日に数えていない` : null };
}

/** 曜日(0=日 … 6=土)。UTC の暦で求める */
export function weekdayOf(day) {
  return new Date(toMs(day)).getUTCDay();
}

/** 営業日か(土日でも祝日でもない) */
export function isBusinessDay(day, holidays = new Set()) {
  const w = weekdayOf(day);
  return w !== 0 && w !== 6 && !holidays.has(day);
}

/** day から n 営業日後(n が負なら前)の日。day が営業日でなくても、次(前)の営業日から数える。n=0 は day 以後で最初の営業日 */
export function addBusinessDays(day, n, holidays = new Set()) {
  let ms = toMs(day);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  if (n === 0) {
    while (!isBusinessDay(fromMs(ms), holidays)) ms += DAY_MS;
    return fromMs(ms);
  }
  while (left > 0) {
    ms += step * DAY_MS;
    if (isBusinessDay(fromMs(ms), holidays)) left--;
  }
  return fromMs(ms);
}

/** from の翌日から to までに含まれる営業日の数(from が to 以後なら 0) */
export function businessDaysBetween(from, to, holidays = new Set()) {
  let n = 0;
  for (let ms = toMs(from) + DAY_MS; ms <= toMs(to); ms += DAY_MS) if (isBusinessDay(fromMs(ms), holidays)) n++;
  return n;
}

/** ISO 8601 の時刻を、UTC からの差 offsetMinutes の暦の日(YYYY-MM-DD)へ直す。読めなければ null */
export function dayOf(iso, offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return fromMs(t + offsetMinutes * 60000);
}
