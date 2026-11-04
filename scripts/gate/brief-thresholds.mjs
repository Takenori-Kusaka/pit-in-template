// 企画書の閾値の行(標準 第7章 7.6 のエスカレーション閾値、7.7.4 の自動的な上程の閾値)の記入を確かめる。
// 閾値は組織が定める値であり(標準 第1章 1.7.7)、記録の無い企画書は G-1 の基準4 を満たさない(ADR-0095 決定5・ADR-0097)。
// G-1 を通過済みの企画書は遡って失敗させず、欠落として出す(カバレッジの測る範囲の行と同じ扱い。#296 の突合 X-4)。
// process-compass #419

/** 企画書の「指標の閾値と予算区分」の節で確かめる行 */
export const BRIEF_THRESHOLD_ROWS = ['エスカレーション閾値', '自動的な上程の閾値'];

/**
 * 閾値の行ごとの状態を返す。
 * @param {string} briefText 企画書の本文
 * @param {Array<{gate?: string, result?: string}>} records ゲートの判定記録(config.mjs の readGateRecords() の戻り値)
 * @param {(v: string) => boolean} isFilled 記入済みかの判定(config.mjs の isFilledValue)
 * @returns {Array<{key: string, problem: 'missing'|'blank', state: 'gap'|'required'}>} 問題のある行だけ
 */
export function briefThresholdProblems(briefText, records, isFilled) {
  if (briefText === null || briefText === undefined) return [];
  const lines = String(briefText).split(/\r?\n/);
  const g1Passed = (records ?? []).some((r) => /^G-1(?!\d)/.test(r.gate ?? '') && r.result === '通過');
  const state = g1Passed ? 'gap' : 'required';
  const out = [];
  for (const key of BRIEF_THRESHOLD_ROWS) {
    const row = lines.find((l) => l.replace(/\*/g, '').startsWith(`| ${key} |`));
    if (!row) {
      out.push({ key, problem: 'missing', state });
      continue;
    }
    const value = row.replace(/\*/g, '').slice(`| ${key} |`.length).replace(/\|\s*$/, '').trim();
    if (!isFilled(value)) out.push({ key, problem: 'blank', state });
  }
  return out;
}

/** 問題の行を、利用者へ出す文にする */
export function briefThresholdMessage(p) {
  const what = p.problem === 'missing' ? 'がありません(templates/06-project-brief.md の様式から写す)' : 'が未記入です(空欄、または様式の説明 <…> のまま)';
  const tail =
    p.state === 'gap'
      ? '。G-1 を通過済みのため遡って失敗させません。記載の欠落です。値を定める者(G-1 の判定者)が記名して書きます'
      : '。閾値は組織が定める値です。参考の値を用いる場合も値を書きます(標準 第7章 7.6・7.7.2)';
  return `「指標の閾値と予算区分」の欄「${p.key}」${what}${tail}`;
}
