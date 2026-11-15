// 確定した版の再確認(出荷の証跡の集約。標準 第4章 G-7 基準5 の補足 / IMPL-0241 / process-compass #355)。
// 出荷の範囲で spec.md が変わった機能について、その機能の G-4 の通過の記録(効いているものと、後の差し戻しで打ち消されたもの)と範囲の先端とで、
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
 * passes: [{ feature, source, ref, text, unresolved, effective }](その機能の G-4 の通過の記録。text は判定の版の本文、取れなければ
 *   unresolved に理由。effective は「後の差し戻しに打ち消されていない」。偽なら打ち消された通過。省略は効いている扱い。
 *   判定する席の責任者でない者の通過と headMatch が偽の写しは、呼び出し側が渡さない(通過の記録に数えない))
 * 返り値: 機能ごとの { id, result, sections, record, reason, cancelled }
 *
 * 式(#355 束3 議長の裁定 R1-01):
 *   1. 効いている通過のうち版を読めたものの1件でも先端と一致 → 一致
 *   2. 一致する通過が無く(打ち消された通過も含めて)、版を読めた通過の記録が1件でも在り、読めた通過の全件が先端と一致しない → 不一致
 *      (確定した版が在り、先端はそこから変わり、変更後の版を対象とすると確かめられる効いている通過が無い)。
 *      版を読めない効いている通過が在っても、不一致にする(版を書かない通過の記録で欠落を消させないため)。その通過が先端の版を対象とするなら、
 *      判定者が判定記録の対象へ版を書くと一致になる
 *   3. 打ち消された通過の版が先端と一致し、効いている通過に一致が無い → 未確認(先端の版の通過が差し戻しで打ち消されている)
 *   4. 通過の記録が1件も無い → 未確認(機械は欠落にしない。トレーラ Spec が指す場合に限り G-7 基準5 が欠落に数える)
 */
export function specRecheck({ features, passes }) {
  return (features ?? []).map((f) => {
    const mine = (passes ?? []).filter((p) => p.feature === f.id);
    if (f.tipText === null || f.tipText === undefined) {
      return { id: f.id, result: 'unconfirmed', sections: [], record: null, reason: '範囲の先端の spec.md を読めない' };
    }
    if (!mine.length) {
      return { id: f.id, result: 'unconfirmed', sections: [], record: null, reason: NO_PASS_REASON };
    }
    const judged = mine.map((p) => ({ p, j: judgePass(p, f.tipText), effective: p.effective !== false }));
    const ok = judged.find((x) => x.effective && x.j.verdict === 'match');
    if (ok) return { id: f.id, result: 'match', sections: [], record: ok.p.source, reason: null };
    const cancelledMatch = judged.find((x) => !x.effective && x.j.verdict === 'match');
    if (cancelledMatch) {
      return { id: f.id, result: 'unconfirmed', sections: [], record: cancelledMatch.p.source, reason: CANCELLED_REASON, cancelled: true };
    }
    // 版を読めない通過(効いているか否かを問わない)は、一致の根拠にも、不一致を妨げる根拠にも数えない
    // (版を書かない通過の記録で欠落を消させないため。議長の裁定 R2-01)
    const bad = judged
      .filter((x) => x.j.verdict === 'mismatch')
      .sort((a, b) => Number(b.effective) - Number(a.effective) || a.j.differing.length - b.j.differing.length);
    if (bad.length) {
      const unseen = judged.filter((x) => x.effective && (x.j.verdict === 'unreachable' || x.j.verdict === 'unreadable')).map((x) => x.p.source);
      return { id: f.id, result: 'mismatch', sections: bad[0].j.differing, record: bad[0].p.source, reason: null, cancelled: !bad[0].effective, unseen };
    }
    // 理由は、理由のある判定だけから作る。記録の所在は、未確認の理由になった記録(効いているものを先に)を指す
    const withReason = judged.filter((x) => x.j.reason);
    const why = [...new Set(withReason.map((x) => x.j.reason))].join(' / ');
    const src = (withReason.find((x) => x.effective) ?? withReason[0] ?? judged[0]).p.source;
    return { id: f.id, result: 'unconfirmed', sections: [], record: src, reason: why };
  });
}

export const NO_PASS_REASON =
  'この機能を対象とする G-4 の通過の記録が無い。コミットまたは PR のトレーラ Spec がこの機能を指す場合に限り、G-7 基準5 が欠落に数える。指さない場合、機械は欠落にしない';
export const CANCELLED_REASON = '先端の版の通過が、後の差し戻しで打ち消されている(または判定日時が空で前後が決まらない)';

/** 不一致を記載の欠落にする文。機能・節の名・判定記録の所在・直し方を出す */
export function specRecheckGapText(item) {
  return (
    `仕様 ${item.id}: 確定した版から ${item.sections.join('・')} の本文が変わっています(判定記録 ${item.record ?? '(所在不明)'}${item.cancelled ? '(後の差し戻しで打ち消されている)' : ''} が対象とする版と、出荷の範囲の先端が一致せず、変更後の版を対象とすると確かめられる効いている通過もありません)。` +
    (item.unseen?.length ? `版を読めない効いている通過があります(判定記録 ${item.unseen.join('、')})。その通過が先端の版を対象とするなら、判定記録の「対象」へ版を書くと比べられます。` : '') +
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
