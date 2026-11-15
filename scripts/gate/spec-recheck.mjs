// 確定した版の再確認(出荷の証跡の集約。標準 第4章 G-7 基準5 の補足 / IMPL-0241 / process-compass #355)。
// 出荷の範囲で spec.md が変わった機能について、効いている G-4 の通過の記録のいずれかが対象とする版と、範囲の先端とで、
// 受入基準・前提・スコープ外の3節の本文(改行・行末の空白・端の空行だけを揃えた文字列)が一致するかを3値で返す。
// 純関数である。git も gh も呼ばない(版の本文の取得は呼び出し側が行い、取れなければ unresolved にする)。
//
// 結果: 'match'(一致) / 'mismatch'(不一致。記載の欠落) / 'unconfirmed'(未確認。欠落にしない。出荷判定者が突合する)。
// 機械が確かめるのは文字列の一致までで、変更が意味を変えるかは確かめない。整形だけの変更も不一致になる
// (戻り幅は G-4 の判定者が決める。第4章「確定した版を変える場合」)。判定済みの古い版へ戻した変更は一致になる(限界)。

import { CONFIRMED_SECTIONS, compareSpecSections } from './spec-sections.mjs';

/**
 * 様式の「対象」の欄から、機能 ID と版の指し方を解析する。
 *   `F-012 / 1a2b3c4` → { feature: 'F-012', kind: 'commit', commit: '1a2b3c4' }
 *   `F-012 / PR #34`(機械の併記つきを含む) → { kind: 'pr', pr: 34 }
 *   `F-012`(版なし) → { kind: 'none' }
 */
export function targetVersionOfForm(cell) {
  const text = String(cell ?? '');
  const feature = text.match(/(?<![A-Za-z0-9])(F-\d+)(?!\d)/)?.[1] ?? null;
  const i = text.indexOf('/');
  const rest = i >= 0 ? text.slice(i + 1) : '';
  const pr = rest.match(/PR\s*#(\d+)/i);
  if (pr) return { feature, kind: 'pr', pr: Number(pr[1]) };
  // 機械の併記(括弧・「。」以降)は読まない
  const head = rest.replace(/[((].*$/s, '').replace(/。.*$/s, '');
  const commit = head.match(/(?<![0-9a-f])([0-9a-f]{7,40})(?![0-9a-f])/i);
  if (commit) return { feature, kind: 'commit', commit: commit[1].toLowerCase() };
  return { feature, kind: 'none' };
}

function judgePass(pass, tipText) {
  if (pass.unresolved || pass.text === null || pass.text === undefined) {
    return { verdict: 'unreachable', reason: pass.unresolved ?? '判定の版の本文を取得できない', differing: [] };
  }
  const c = compareSpecSections(pass.text, tipText);
  const differing = CONFIRMED_SECTIONS.filter((s) => c.sections[s] === 'mismatch');
  if (differing.length) return { verdict: 'mismatch', differing, sections: c.sections };
  if (c.fullMatch) return { verdict: 'match', differing: [], sections: c.sections };
  if (CONFIRMED_SECTIONS.some((s) => c.sections[s] === 'unreadable')) {
    return { verdict: 'unreadable', reason: '3節のうち取り出せない節があり、全文も一致しない', differing: [], sections: c.sections };
  }
  return { verdict: 'match', differing: [], sections: c.sections };
}

/**
 * features: [{ id, tipText }](tipText は範囲の先端の spec.md の本文。無ければ null)
 * passes: [{ feature, source, ref, text, unresolved }](効いている G-4 の通過。text は判定の版の本文、取れなければ unresolved に理由)
 * 返り値: 機能ごとの { id, result, sections, record, reason }
 */
export function specRecheck({ features, passes }) {
  return (features ?? []).map((f) => {
    const mine = (passes ?? []).filter((p) => p.feature === f.id);
    if (f.tipText === null || f.tipText === undefined) {
      return { id: f.id, result: 'unconfirmed', sections: [], record: null, reason: '範囲の先端の spec.md を読めない' };
    }
    if (!mine.length) {
      return { id: f.id, result: 'unconfirmed', sections: [], record: null, reason: '効いている G-4 の通過の記録が無い(G-7 基準5 の欠落が数える)' };
    }
    const judged = mine.map((p) => ({ p, j: judgePass(p, f.tipText) }));
    const ok = judged.find((x) => x.j.verdict === 'match');
    if (ok) return { id: f.id, result: 'match', sections: [], record: ok.p.source, reason: null };
    const bad = judged.filter((x) => x.j.verdict === 'mismatch').sort((a, b) => a.j.differing.length - b.j.differing.length);
    if (bad.length) {
      return { id: f.id, result: 'mismatch', sections: bad[0].j.differing, record: bad[0].p.source, reason: null };
    }
    const why = [...new Set(judged.map((x) => x.j.reason))].join(' / ');
    return { id: f.id, result: 'unconfirmed', sections: [], record: judged[0].p.source, reason: why };
  });
}

/** 不一致を記載の欠落にする文。機能・節の名・判定記録の所在・直し方を出す */
export function specRecheckGapText(item) {
  return (
    `仕様 ${item.id}: 確定した版から ${item.sections.join('・')} の本文が変わっています(判定記録 ${item.record ?? '(所在不明)'} が対象とする版と、出荷の範囲の先端が一致しません)。` +
    '直し方: G-4 の判定者が、変更後の版を対象とする判定記録を書きます(元の記録は残す)。整形だけの変更でも、戻り幅は判定者が決めるため記録が要ります(第4章「確定した版を変える場合」)'
  );
}

/** 3値の件数と、未確認の理由ごとの件数(保証の開示と evidence.json に出す。外部向けは件数だけ) */
export function specRecheckSummary(items) {
  const count = (r) => items.filter((i) => i.result === r).length;
  const reasons = {};
  for (const i of items) if (i.result === 'unconfirmed') reasons[i.reason] = (reasons[i.reason] ?? 0) + 1;
  return { match: count('match'), mismatch: count('mismatch'), unconfirmed: count('unconfirmed'), unconfirmedReasons: reasons };
}
