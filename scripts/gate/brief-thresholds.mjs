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

// 停止条件の値(標準 第3章 3.12.10 の要求事項4「停止条件の値は案件ごとに定め、企画承認(G-1)の時点で記録する」)。
// 企画書の「指標の閾値と予算区分」の行「停止条件の値」の欠けと空欄を、G-1 の前は問題、G-1 を通過済みは欠落(遡って失敗させない)として出す。
// 行に書いた連続失敗・無進捗の上限が、構成(task.selfHealMaxIterations・task.selfHealNoProgressLimit。既定 3・2)と異なれば、
// 効くのは構成の値であることを注意として出す(G-1 の後に /process-change で値を変えた案件を失敗させないため)。
// 累積消費の上限は準拠テンプレートが測らない(IMPL-0277)ので、値の中身を確かめない。process-compass #359 / IMPL-0280

/** 企画書の停止条件の値の行の鍵 */
export const BRIEF_STOP_ROW = '停止条件の値';

/**
 * @param {string} briefText 企画書の本文
 * @param {Array<{gate?: string, result?: string}>} records ゲートの判定記録
 * @param {(v: string) => boolean} isFilled 記入済みかの判定
 * @param {{selfHealMaxIterations?: number, selfHealNoProgressLimit?: number}} [task] 構成の task
 * @returns {{problem: null|'missing'|'blank', state: 'gap'|'required', mismatches: Array<{what: string, brief: number, config: number, key: string}>}}
 */
export function briefStopConditionState(briefText, records, isFilled, task = {}) {
  const g1Passed = (records ?? []).some((r) => /^G-1(?!\d)/.test(r.gate ?? '') && r.result === '通過');
  const state = g1Passed ? 'gap' : 'required';
  const lines = String(briefText ?? '').split(/\r?\n/);
  const row = lines.find((l) => l.replace(/\*/g, '').startsWith(`| ${BRIEF_STOP_ROW} |`));
  if (!row) return { problem: 'missing', state, mismatches: [] };
  const value = row.replace(/\*/g, '').slice(`| ${BRIEF_STOP_ROW} |`.length).replace(/\|\s*$/, '').trim();
  if (!isFilled(value)) return { problem: 'blank', state, mismatches: [] };
  const v = value.normalize('NFKC');
  const num = (re) => {
    const m = v.match(re);
    return m ? Number(m[1]) : null;
  };
  const mismatches = [];
  const pairs = [
    ['連続失敗の上限', num(/連続失敗[^0-9|]{0,12}?(\d+)\s*回/), task?.selfHealMaxIterations ?? 3, 'task.selfHealMaxIterations'],
    ['無進捗の上限', num(/無進捗[^0-9|]{0,12}?(\d+)\s*回/), task?.selfHealNoProgressLimit ?? 2, 'task.selfHealNoProgressLimit'],
  ];
  for (const [what, brief, config, key] of pairs) if (brief !== null && brief !== config) mismatches.push({ what, brief, config, key });
  return { problem: null, state, mismatches };
}

/** 停止条件の値の行の状態を、利用者へ出す文の一覧にする({ level: 'problem'|'warn', text }) */
export function briefStopConditionMessages(s) {
  const out = [];
  if (s.problem) {
    const what = s.problem === 'missing' ? 'がありません(templates/06-project-brief.md の様式から写す)' : 'が未記入です(空欄、または様式の説明 <…> のまま)';
    const tail =
      s.state === 'gap'
        ? '。G-1 を通過済みのため遡って失敗させません。記載の欠落です。値を定める者(G-1 の判定者)が記名して書きます'
        : '。停止条件の値は案件ごとに定め、G-1 の時点で記録します(標準 第3章 3.12.10 の要求事項4)';
    out.push({ level: s.state === 'gap' ? 'warn' : 'problem', text: `「指標の閾値と予算区分」の欄「${BRIEF_STOP_ROW}」${what}${tail}` });
  }
  for (const m of s.mismatches) {
    out.push({
      level: 'warn',
      text: `「${BRIEF_STOP_ROW}」の${m.what}(${m.brief} 回)が、構成の ${m.key}(${m.config} 回)と異なります。自己修正のループに効くのは構成の値です。G-1 の後に /process-change で変えたのなら、変化点の記録を確かめます。そうでなければ、どちらかを直します`,
    });
  }
  return out;
}
