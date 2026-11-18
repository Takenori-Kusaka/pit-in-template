// 当初の見積りの保存と、見積りと実績の差の記録を確かめる(標準 第7章 7.7.9 の要求事項3・4。process-compass #416 / ADR-0093)。
//   - 総費用の内訳の「G-1 の時点の見積り」の列が埋まっているか(G-1 の前は失敗。通過済みは欠落として出す)
//   - G-1 の判定記録の「参照した企画書の版」の企画書と比べ、その列が G-1 の後に書き換えられていないか
//   - ステージ移行ゲートの判定記録の「見積りと実績の差」の3欄が書かれているか
import { execFileSync } from 'node:child_process';

export const COST_LABELS = ['AI の実行', '検証', '修正', '教育', '管理'];
export const ESTIMATE_GAP_ROWS = ['当初の見積り', '実績', '差と主な原因'];

const nfkc = (s) => String(s ?? '').normalize('NFKC').trim();
const unstar = (s) => String(s ?? '').replace(/\*/g, '');

/** 見出し(# の数を問わない)の下の最初の表。header と rows(セルの配列)を返す */
function tableUnder(text, headingRe) {
  const lines = String(text ?? '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^#{1,6}\s/.test(l) && headingRe.test(l));
  if (i < 0) return { header: [], rows: [] };
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (/^#{1,6}\s/.test(l)) break;
    if (/^\s*\|/.test(l)) out.push(l);
    else if (out.length && l.trim() !== '' && !/^<!--/.test(l.trim())) break;
  }
  const cells = (l) => unstar(l).trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const rows = out.filter((l) => !/^\s*\|[\s|:-]+\|\s*$/.test(l)).map(cells);
  return { header: rows[0] ?? [], rows: rows.slice(1) };
}

/** 総費用の内訳の「G-1 の時点の見積り」の列。present は列の有無、values は区分ごとの値(空欄は '') */
export function g1EstimateColumn(briefText) {
  const t = tableUnder(briefText, /総費用の内訳/);
  const i = t.header.findIndex((h) => /G-1\s*の時点の見積り/.test(nfkc(h)));
  const values = {};
  for (const label of COST_LABELS) {
    const r = t.rows.find((x) => nfkc(x[0]).startsWith(label.normalize('NFKC')));
    values[label] = r && i >= 0 ? (r[i] ?? '') : '';
  }
  return { tablePresent: t.header.length > 0, present: i >= 0, values };
}

/** G-1 の時点の見積りの列の空欄(区分の名の一覧)。isFilled は config.mjs の isFilledValue */
export function g1EstimateBlank(briefText, isFilled) {
  const c = g1EstimateColumn(briefText);
  if (!c.tablePresent || !c.present) return null;
  return COST_LABELS.filter((l) => !isFilled(c.values[l]));
}

/** 判定記録の「参照した企画書の版」。コミットの識別子(7〜40 桁の16進)だけを返す */
export function briefVersionOf(recordText) {
  const m = String(recordText ?? '').match(/^\|\s*参照した企画書の版\s*\|\s*([^|]*)\|/m);
  const v = nfkc(m?.[1] ?? '').replace(/`/g, '');
  return /^[0-9a-f]{7,40}$/i.test(v) ? v : null;
}

/** 2 つの企画書の G-1 の時点の見積りの列を比べ、書き換えられた区分を返す */
export function g1EstimateChanges(baseText, currentText) {
  const a = g1EstimateColumn(baseText);
  const b = g1EstimateColumn(currentText);
  if (!a.present) return [];
  return COST_LABELS.filter((l) => nfkc(a.values[l]) !== '' && nfkc(a.values[l]) !== nfkc(b.values[l])).map((l) => ({ label: l, before: nfkc(a.values[l]), after: nfkc(b.values[l]) }));
}

/** git の版のファイル。読めなければ null */
export function fileAtVersion(root, version, rel) {
  try {
    return execFileSync('git', ['show', `${version}:${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** ステージ移行ゲートの判定記録の「見積りと実績の差」の空欄。節が無ければ null */
export function estimateGapBlank(recordText, isFilled) {
  const t = tableUnder(recordText, /見積りと実績の差/);
  if (!t.header.length && !t.rows.length) return null;
  return ESTIMATE_GAP_ROWS.filter((k) => {
    const r = t.rows.find((x) => nfkc(x[0]) === k);
    return !r || !isFilled(r[1]);
  });
}

// ---- 完了スループットの集計の入力(標準 第2章 2.10.2 要求事項4・5。IMPL-0374 / ADR-0173) ----

/**
 * 既定の完了の条件の文(ADR-0173 決定2)。企画書の欄「作業単位の完了の条件」がこの文と完全に一致する案件でだけ、
 * next.mjs は完了スループットを算定する。意味が同じでも文が違えば算定しない(文の意味は機械が読まない)
 */
export const DEFAULT_DONE_CONDITION = '既定ブランチへ取り込んだ PR が closes で結び付き、完了の理由で閉じた作業単位';

/** 企画書の行「- <見出し>: <値>」の値(前後の空白と ** を除く)。行が無ければ null */
function bulletValue(text, label) {
  const re = new RegExp(`^\\s*[-*]\\s*${label}\\s*[:：]\\s*(.*)$`, 'm');
  const m = String(text ?? '').match(re);
  return m ? unstar(m[1]).trim() : null;
}

/** 企画書の欄「作業単位の完了の条件」の値。欄が無ければ null */
export function doneConditionOf(briefText) {
  return bulletValue(briefText, '作業単位の完了の条件');
}

/** 完了の条件が既定の文と完全に一致するか(NFKC・前後の空白・末尾の句点だけは同一視する) */
export function isDefaultDoneCondition(value) {
  if (value == null) return false;
  const norm = (s) => nfkc(s).replace(/[。.]$/, '');
  return norm(value) === norm(DEFAULT_DONE_CONDITION);
}

/** 企画書の欄「単位期間の長さ」を日数へ。「N日」「N週間」「N週」だけを読む(それ以外は null)。 */
export function unitPeriodDaysOf(briefText) {
  const v = bulletValue(briefText, '単位期間の長さ');
  if (v == null) return null;
  const m = nfkc(v).match(/^(\d+)\s*(日|週間|週)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n * (m[2] === '日' ? 1 : 7) : null;
}
