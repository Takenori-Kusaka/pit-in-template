// 例外承認(標準 第7章 7.3)の回収の期限と、範囲の件数の算出(process-compass #353 / ADR-0134)。
//
// 機械で決めるのは、決定可能な条件(日付の比較・状態の値・件数・有無)だけである。
//   - 期限の比較: 状態が有効のまま、期限の日が突合の日より前の行は、期限の翌日から効力を失う。失効の行も同じく効力が無い
//   - 承認し直し: 元の行の本文に、承認し直した行の識別(D-NNN)が書かれ、その行が有効で期限内なら、元の行は数えない
// 例外承認の当否、期限の妥当性、承認し直しの識別が正しい行を指すか(意味)は、機械では確かめない(出荷判定者・内部監査)。
// 日付は引数で渡す。この関数は時計を読まない(回帰の時計依存を避ける)。

import { ACTIVE_EXCEPTION_STATES, dueDayOf, isRealDay, parseLedger } from './config.mjs';

/** 状態の値の正規化(強調の `*`、全角、前後の空白を除く) */
export function stateOf(row) {
  return String(row?.state ?? '').replace(/\*/g, '').normalize('NFKC').trim();
}

/** 突合の日(YYYY-MM-DD)として使える値か */
export const validDay = (v) => typeof v === 'string' && isRealDay(v);

/**
 * 例外承認の行の効力。
 *   'active'   状態が有効で、期限の日までである(期限の日は効力がある)
 *   'overdue'  状態が有効のまま、期限の日が突合の日より前である
 *   'lapsed'   状態が失効である
 *   'undated'  状態が有効で、期限が日付として読めない(比べられない)
 *   'closed'   返却済み・取り下げなど、有効でも失効でもない
 */
export function exceptionStanding(row, day) {
  const st = stateOf(row);
  if (st.startsWith('失効')) return 'lapsed';
  if (!ACTIVE_EXCEPTION_STATES.includes(st)) return 'closed';
  const due = dueDayOf(row.due);
  if (!due) return 'undated';
  return due < day ? 'overdue' : 'active';
}

/** 効力を失った行(有効のまま期限を過ぎた行と、失効の行) */
export const isLapsed = (row, day) => ['overdue', 'lapsed'].includes(exceptionStanding(row, day));

/** 本文に別の行の識別(D-NNN)を書いて、承認し直された元の行か。承認し直した行は、有効で期限内でなければならない */
export function reapprovedBy(row, rows, day) {
  const text = String(row.text ?? '').normalize('NFKC');
  const ids = new Set([...text.matchAll(/\bD-\d+/g)].map((m) => m[0]));
  ids.delete(row.id);
  return rows.find((r) => r.kind === '例外' && ids.has(r.id) && exceptionStanding(r, day) === 'active') ?? null;
}

/**
 * 効力を失った例外承認の行の一覧(台帳全体。対象が出荷の範囲の外の行、ゲートの判定を対象とする行を含む)。
 * 承認し直された元の行は含めない
 */
export function lapsedExceptions(rows, day) {
  const ex = (rows ?? []).filter((r) => r.kind === '例外');
  return ex
    .filter((r) => isLapsed(r, day) && !reapprovedBy(r, ex, day))
    .map((r) => ({ id: r.id, target: String(r.target ?? '').trim() || '(対象の欄なし)', due: String(r.due ?? '').trim(), state: stateOf(r), standing: exceptionStanding(r, day) }));
}

/** 記録の欠落の文(集約の gaps へ出す) */
export function lapsedGapText(x, day) {
  const why = x.standing === 'lapsed' ? `状態が失効です` : `状態が有効のまま、回収の期限(${x.due})を突合の日(${day})が過ぎています`;
  return (
    `例外承認 ${x.id}(対象 ${x.target}): ${why}。期限の翌日から効力を失っており、記録の欠落です(第7章 7.3)。` +
    '回収して状態を「返却済み」にするか、権限を持つ者が新しい行で承認し直し、元の行にその行の識別を書いてください。期限の書き換えは承認のし直しではありません'
  );
}

const ledgerOf = (text) => (text ? parseLedger(text) : []);

/**
 * 範囲の例外承認の件数(標準 第1章 1.10.2)。
 *   件数: 範囲の始点で状態が有効だった区分「例外」の行と、範囲の中で足された行(始点の台帳に無い識別)
 *   未回収: 件数に数えた行のうち、終点の台帳で状態が有効または失効の行(回収の記録が無く、取り下げていない)
 *   期限超過: 未回収のうち、状態が有効のまま期限を過ぎた行と、失効の行
 *   承認し直された元の行は、未回収と期限超過のどちらにも数えない。終点の台帳から消えた行は、未回収に数える
 * 独立した人の確認を経ない出荷の件数(withoutIndependentConfirmation)は、集約の突合の結果を呼び出し側が渡す
 */
export function countRangeExceptions({ startText, endText, day, ledger, withoutIndependentConfirmation = 0 }) {
  const start = ledgerOf(startText).filter((r) => r.kind === '例外');
  const end = ledgerOf(endText).filter((r) => r.kind === '例外');
  const startIds = new Set(start.map((r) => r.id));
  const counted = [
    ...start.filter((r) => ACTIVE_EXCEPTION_STATES.includes(stateOf(r)) || stateOf(r).startsWith('失効')).map((r) => r.id),
    ...end.filter((r) => !startIds.has(r.id)).map((r) => r.id),
  ];
  const ids = [...new Set(counted)];
  const endById = new Map(end.map((r) => [r.id, r]));
  let uncollected = 0;
  let overdue = 0;
  let undated = 0;
  for (const id of ids) {
    const row = endById.get(id);
    if (!row) {
      uncollected++;
      continue;
    }
    const s = exceptionStanding(row, day);
    if (s === 'closed') continue;
    if (reapprovedBy(row, end, day)) continue;
    uncollected++;
    if (s === 'overdue' || s === 'lapsed') overdue++;
    if (s === 'undated') undated++;
  }
  return { day, ledger, inRange: ids.length, uncollected, overdue, withoutIndependentConfirmation, undatedDue: undated };
}

/**
 * 次の一手の注記(next.mjs)。期限を過ぎた未返却の例外の行を、出荷の直前まで気づけない状態にしないために出す。
 * 台帳が無い・該当が無ければ null。今日の日付は引数で渡す
 */
export function overdueExceptionNote({ ledgerText, today }) {
  if (!ledgerText || !validDay(today)) return null;
  const xs = lapsedExceptions(parseLedger(ledgerText), today);
  if (!xs.length) return null;
  return (
    `期限を過ぎた例外承認が ${xs.length} 件(${xs.slice(0, 4).map((x) => `${x.id} 期限 ${x.due || '—'}${x.standing === 'lapsed' ? '・失効' : ''}`).join(' / ')}${xs.length > 4 ? ' ほか' : ''})。` +
    '期限の翌日から効力を失い、記録の欠落になる(第7章 7.3)。出荷判定(G-7)で差し戻しになる前に、回収して状態を「返却済み」にするか、' +
    '権限を持つ者が新しい行で承認し直す(期限の書き換えは承認のし直しでない)。AI が承認し直さない'
  );
}
