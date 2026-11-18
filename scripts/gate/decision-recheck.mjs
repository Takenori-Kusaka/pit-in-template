// 判断記録の再検査(出荷の証跡の集約。標準 第4章 G-3 / IMPL-0523 / process-compass #355 / 束 B20)。純関数である。git も gh も呼ばない。
// 出荷の範囲で変わった判断記録(context/decisions/・context/_archive/decisions/)について、G-3 の通過の記録が対象とする版と
// 範囲の先端の本文が、状態の行だけを除いて(改行・行末の空白・端の空行を揃えた)文字列として一致するかを 3 値で返す。
// spec-recheck.mjs(ADR-0136 決定1)と同じ 3 値: match(一致) / mismatch(不一致。記載の欠落) / unconfirmed(未確認。欠落にしない)。
//
// 限界(根拠水準マーク EV で開示): 文字列の一致が書き換えを過不足なく拾うという前提は実証していない(E0)。
// 誤字の修正も不一致になる(様式 02「書き換えてよいのは、状態の行だけ」の字義のとおり)。意味を変える差だけを選ぶ定義は機械で閉じないので採らない。
// 範囲の外の履歴の書き換えは見ない(出荷の範囲で変わったファイルだけを比べる)。

/** 比べる前の正規化: LF・行末の空白除去・端の空行除去。状態の行(「- 状態:」の行、旧い様式は「## ステータス」の節の最初の行)を除く */
export function normalizeDecisionText(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''));
  const bullet = lines.findIndex((l) => /^\s*[-*]\s*状態\s*[::]/.test(l));
  if (bullet >= 0) {
    lines.splice(bullet, 1);
  } else {
    const h = lines.findIndex((l) => /^##\s*ステータス\s*$/.test(l));
    if (h >= 0) {
      const body = lines.findIndex((l, i) => i > h && l.trim() !== '' && !/^##\s/.test(l));
      if (body >= 0 && !lines.slice(h + 1, body).some((l) => /^##\s/.test(l))) lines.splice(body, 1);
    }
  }
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

export const NO_PASS_REASON = 'この判断記録を対象とする G-3 の通過の記録が無い。機械は欠落にしない(置き換える決定を持つ場合は replacementWithoutG3 が別に欠落にする)';

/**
 * decisions: [{ id, tipText, passes: [{ source, text, unresolved }] }](tipText は範囲の先端の本文。読めなければ null)
 * 式: 読めた通過の 1 件でも先端と一致 → 一致 / 読めた通過があり全件が一致しない → 不一致 / それ以外 → 未確認
 */
export function decisionRecheck({ decisions }) {
  return (decisions ?? []).map((d) => {
    if (d.tipText === null || d.tipText === undefined) return { id: d.id, result: 'unconfirmed', record: null, reason: '範囲の先端の判断記録を読めない' };
    const tip = normalizeDecisionText(d.tipText);
    const readable = (d.passes ?? []).filter((p) => p.text !== null && p.text !== undefined && !p.unresolved);
    if (!(d.passes ?? []).length) return { id: d.id, result: 'unconfirmed', record: null, reason: NO_PASS_REASON };
    if (!readable.length) return { id: d.id, result: 'unconfirmed', record: d.passes[0].source, reason: d.passes[0].unresolved ?? '判定した版の本文を取得できない' };
    const ok = readable.find((p) => normalizeDecisionText(p.text) === tip);
    if (ok) return { id: d.id, result: 'match', record: ok.source, reason: null };
    return { id: d.id, result: 'mismatch', record: readable[0].source, reason: null };
  });
}

/** 置き換える決定を持つのに G-3 の通過の記録が無い判断記録の ID の一覧 */
export function replacementWithoutG3({ decisions }) {
  return (decisions ?? []).filter((d) => (d.replaces ?? []).length > 0 && !d.hasG3).map((d) => d.id);
}

/** 不一致を記載の欠落にする文。解く道を書く */
export function decisionRecheckGapText(item) {
  return (
    `判断記録 ${item.id}: G-3 で判定した版(判定記録 ${item.record ?? '(所在不明)'})から本文が変わっています(状態の行を除く)。採用した判断記録は書き換えません(様式 02)。記載の欠落です。` +
    '解く道: 変更を置き換える判断記録として起こす(「置き換える決定」に元の ID を書き、G-3 を受ける)。採用の前の変更なら、変更後の版で G-3 を受け直す'
  );
}

export function replacementWithoutG3GapText(id) {
  return `判断記録 ${id}: 「置き換える決定」を持つのに、この判断記録を対象とする G-3 の通過の記録がありません。記載の欠落です。解く道: 置き換える判断記録で G-3 を受ける`;
}

export function decisionRecheckSummary(items) {
  const count = (r) => items.filter((i) => i.result === r).length;
  return { match: count('match'), mismatch: count('mismatch'), unconfirmed: count('unconfirmed') };
}
