// 確認を求める項目の並びの周期的な変更(標準 第5章 5.7.5。IMPL-0175。process-compass #443)。
//
// 同じ並びに慣れて確認が形骸化するのを遅らせるため、承認時に確認を求める項目の並びを、ISO 週ごとに決定的に入れ替える。
// 対象は提示の層だけである(/gate のレビュー本文の雛形と、判定記録の草案で確認を求める項目)。
//   - 見出し・欄・項目の文は変えない。入れ替えるのは項目の順だけで、項目の番号や識別(「基準2」など)は付け替えない
//   - /human-verify の検証の順序は検証の論理であり、回さない(このスクリプトの対象外)
//   - リスク区分 R3 は回さない(摩擦を一律に課さない。5.7.5 の2点目)
//   - 同じ入力(ゲート・対象・リスク区分・ISO 週・項目)なら必ず同じ並びになる。隣り合う週で並びが同じにならないよう、同じになる週は回転して変える
//     (項目が同じ集合のまま続く間の保証。項目の数や文が週の間で変われば、その週の間は保証しない)。関数は時計を読まず、日付は引数で渡す(命令行で --date を省くと今日(UTC)を使う)
// 強調の様式も、並びと同じ種(ゲート・対象・ISO 週)から1つ決め、全部の項目へ同じ様式で付ける(束 B26 の裁定。所有者の回答 Q-B26-1)。
//   - 特定の1項目を選んで強調しない(項目の間の重みを変えない)。様式は週ごとに変わり、隣り合う週では必ず変わる(項目の文・番号・識別は変えない。強調の印を除けば入力と同じ)
//   - 様式は 4 つ: 先頭の識別を太字 / 1行目を太字 / 行頭に ▶ / 行頭に ◆。R3 は付けない(並びと同じ)。項目がすでに ** を含むときは太字を足さない
// 表現(確認を求める前置きの文の言い回し)は機械で回さない。手引き(/gate の SKILL.md)で起案者が変える。標準 5.7.5 の「表現・強調」のうち、強調はここで、表現は手引きで降ろす。
// 慣れが遅れる効果は機械で確かめない(根拠水準マークで開示する)。合否を持たない。
//
// 使い方: node scripts/gate/review-order.mjs --gate G-6 --target PR-123 --risk R2 [--date YYYY-MM-DD] < 項目の一覧
//   項目は行頭から始まる塊ごと(字下げした行・空行は直前の項目の続き)。--date を省くと今日(UTC)の日付を使う

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GATES = ['G-1', 'G-2', 'G-3', 'G-4', 'G-5', 'G-6', 'G-7', 'G-8', 'SG'];
export const RISKS = ['R1', 'R2', 'R3'];
/** 回さないリスク区分 */
export const NOT_ROTATED = ['R3'];

const pad = (n) => String(n).padStart(2, '0');

/** 実在する YYYY-MM-DD か */
export function isRealDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** ISO 週(YYYY-Www)。UTC の暦で求める。月曜始まり、その週の木曜が属する年 */
export function isoWeekOf(day) {
  if (!isRealDay(day)) throw new Error(`日付を読めない: ${day}`);
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 月曜 = 0
  d.setUTCDate(d.getUTCDate() - dow + 3); // その週の木曜
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4dow = (jan4.getUTCDay() + 6) % 7;
  const week1Thu = new Date(Date.UTC(year, 0, 4 - jan4dow + 3));
  const week = 1 + Math.round((d.getTime() - week1Thu.getTime()) / (7 * 24 * 3600 * 1000));
  return `${year}-W${pad(week)}`;
}

/** 種(ゲート・対象・ISO 週)から、決定的な乱数列を作る(sha256 を計数器つきで引き伸ばす) */
function stream(seedText) {
  let counter = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;
  return () => {
    if (pos + 4 > buf.length) {
      buf = crypto.createHash('sha256').update(`${seedText}|${counter++}`).digest();
      pos = 0;
    }
    const v = buf.readUInt32BE(pos);
    pos += 4;
    return v;
  };
}

/**
 * 項目を並べ替える(純関数)。
 * items: 項目の文字列の配列(複数行の項目は改行を含む1つの文字列)
 * 戻り値: { items: 並べた配列, rotated: 回したか, week, reason }
 */
export function orderItems(items, { gate, target, risk, day }) {
  if (!Array.isArray(items)) throw new Error('items が配列ではない');
  if (!GATES.includes(gate)) throw new Error(`ゲートを読めない: ${gate}`);
  if (typeof target !== 'string' || !target.trim()) throw new Error('対象の識別子が空');
  if (!RISKS.includes(risk)) throw new Error(`リスク区分を読めない(R1〜R3): ${risk}`);
  const week = isoWeekOf(day);
  if (NOT_ROTATED.includes(risk)) return { items: [...items], rotated: false, week, reason: `${risk} は回さない(5.7.5)` };
  if (items.length < 2) return { items: [...items], rotated: false, week, reason: '項目が1つ以下' };
  const tgt = target.trim();
  const mon = mondayOf(day);
  const first = (mon - EPOCH_MONDAY) / WEEK_MS;
  if (first < 0) return { items: shuffled(items, gate, tgt, week), rotated: true, week, reason: `ISO 週 ${week} の種で並べた(${EPOCH_DAY} より前の日付のため、前の週との違いは保証しない)` };
  // 起点の週から現在の週まで順に決める。前の週の並びと同じになるときは、同じにならない最初の回転へ替える(週ごとに並びが変わることを決定的に保証する)
  let prev = null;
  let out = null;
  for (let k = 0; k <= first; k++) {
    const w = isoWeekOf(new Date(EPOCH_MONDAY + k * WEEK_MS).toISOString().slice(0, 10));
    const base = shuffled(items, gate, tgt, w);
    out = base;
    if (prev && same(base, prev)) {
      for (let r = 1; r < base.length; r++) {
        const cand = [...base.slice(r), ...base.slice(0, r)];
        if (!same(cand, prev)) {
          out = cand;
          break;
        }
      }
    }
    prev = out;
  }
  return { items: out, rotated: true, week, reason: `ISO 週 ${week} の種で並べた(前の週と同じ並びになるときは回転して変える。項目の文が同一のものがあるときを除く)` };
}

const WEEK_MS = 7 * 24 * 3600 * 1000;
const EPOCH_DAY = '2000-01-03'; // 月曜
const EPOCH_MONDAY = Date.parse(`${EPOCH_DAY}T00:00:00Z`);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** その日を含む週の月曜(UTC の暦)の時刻 */
function mondayOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * 24 * 3600 * 1000;
}
/** 種(ゲート・対象・ISO 週)からの一様なシャッフル */
function shuffled(items, gate, tgt, week) {
  const next = stream(`${gate}|${tgt}|${week}`);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 強調の様式(4 つ)。添字が様式の番号 */
export const EMPHASIS_STYLES = ['先頭の識別を太字', '1行目を太字', '行頭に ▶', '行頭に ◆'];
const MARKS = ['▶', '◆'];

/**
 * 強調の様式の番号(純関数)。種(ゲート・対象)から決めた起点に、起点の週(2000-01-03)からの週の数を足して 4 で割った余り。
 * ISO 週で変わり、隣り合う週では必ず変わる。R3 は付けない(null)。
 */
export function emphasisStyleOf({ gate, target, risk, day }) {
  if (!GATES.includes(gate)) throw new Error(`ゲートを読めない: ${gate}`);
  if (typeof target !== 'string' || !target.trim()) throw new Error('対象の識別子が空');
  if (!RISKS.includes(risk)) throw new Error(`リスク区分を読めない(R1〜R3): ${risk}`);
  isoWeekOf(day);
  if (NOT_ROTATED.includes(risk)) return null;
  const h = crypto.createHash('sha256').update(`${gate}|${target.trim()}|emphasis`).digest().readUInt32BE(0);
  const k = Math.round((mondayOf(day) - EPOCH_MONDAY) / WEEK_MS);
  return (((h + k) % 4) + 4) % 4;
}

const BULLET = /^(\s*(?:[-*+]\s+|・\s*)?)(.*)$/;
/** 項目の1行目の先頭の識別(最初の「:」「：」まで。無ければ最初の空白まで、無ければ最初の「、」「。」まで、無ければ1行目の全部) */
function headOf(text) {
  const m = text.match(/^[^:：]+(?=[:：])/) ?? text.match(/^\S+(?=[\s\u3000])/) ?? text.match(/^[^、。]+(?=[、。])/);
  return m ? m[0] : text;
}

/** 項目1つへ様式を付ける(項目の文・番号・識別は変えない)。style が null なら何もしない */
export function emphasizeItem(item, style) {
  if (style == null) return item;
  const lines = String(item).split('\n');
  const m = lines[0].match(BULLET);
  const [, lead, body] = m;
  if (body === '') return item;
  if (style >= 2) {
    lines[0] = `${lead}${MARKS[style - 2]} ${body}`;
  } else {
    const part = style === 0 ? headOf(body) : body;
    if (part.includes('**') || part.trim() === '') return item;
    lines[0] = `${lead}**${part}**${body.slice(part.length)}`;
  }
  return lines.join('\n');
}

/** 強調の印(** と行頭の ▶ ◆)を除く。強調の前後で項目の文が同じことを確かめるために使う */
export function stripEmphasis(item) {
  return String(item)
    .split('\n')
    .map((l, i) => (i === 0 ? l.replace(/^(\s*(?:[-*+]\s+|・\s*)?)[▶◆] /, '$1') : l))
    .join('\n')
    .replace(/\*\*/g, '');
}

/** 全部の項目へ同じ様式を付ける(純関数)。戻り値: { items, style, label } */
export function emphasizeItems(items, opts) {
  const style = emphasisStyleOf(opts);
  return { items: items.map((x) => emphasizeItem(x, style)), style, label: style == null ? '付けない(R3)' : EMPHASIS_STYLES[style] };
}

/** 行の列を項目の塊にする(行頭が空白でも空行でもない行が、新しい項目の始まり) */
export function splitItems(text) {
  const items = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (line === '' || /^\s/.test(line)) {
      if (items.length) items[items.length - 1] += `\n${line}`;
      continue;
    }
    items.push(line);
  }
  return items.map((s) => s.replace(/\n+$/, ''));
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
  }
  return o;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const day = a.date ?? new Date().toISOString().slice(0, 10);
  let items;
  try {
    items = splitItems(fs.readFileSync(0, 'utf8'));
    const opts = { gate: a.gate, target: a.target, risk: a.risk, day };
    const r = orderItems(items, opts);
    const e = emphasizeItems(r.items, opts);
    process.stdout.write(`${e.items.join('\n')}\n`);
    process.stderr.write(`並び: ${r.reason}。強調: ${e.label}(全部の項目へ同じ様式)。項目の文と番号は変えていない。/human-verify の検証の順序は回さない\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n使い方: node scripts/gate/review-order.mjs --gate G-6 --target PR-123 --risk R2 [--date YYYY-MM-DD] < 項目の一覧\n`);
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
