// 例外承認(標準 第7章 7.3)の回収の期限と、範囲の件数の算出(process-compass #353 / ADR-0134)。
//
// 機械で決めるのは、決定可能な条件(日付の比較・状態の値・件数・有無)だけである。
//   - 期限の比較: 状態が有効のまま、期限の日が突合の日より前の行は、期限の翌日から効力を失う。失効の行も同じく効力が無い
//   - 閉じた値: 状態が「返却済み」で始まる値と「取り下げ」だけを、回収の済んだ行とする。それ以外(誤記・空欄・「未返却(延長申請中)」など)は未回収として数える
//   - 承認し直し: 元の行の本文に、承認し直した行の識別(D-NNN)が書かれ、その行が(1)元の行と対象が一致し、(2)元の行より後に足され、
//     (3)有効で期限内で、(4)それ自身が別の行の承認し直しとして外された行でないとき、元の行は数えない
// 例外承認の当否、期限の妥当性、承認し直しの識別が正しい行を指すか(意味)は、機械では確かめない(出荷判定者・内部監査)。
// 日付は引数で渡す。この関数は時計を読まない(回帰の時計依存を避ける)。

import { ACTIVE_EXCEPTION_STATES, dueDayOf, isRealDay, parseLedger } from './config.mjs';

/** 状態の値の正規化(強調の `*`、全角、前後の空白を除く) */
export function stateOf(row) {
  return String(row?.state ?? '').replace(/\*/g, '').normalize('NFKC').trim();
}

/** 突合の日(YYYY-MM-DD)として使える値か */
export const validDay = (v) => typeof v === 'string' && isRealDay(v);

/** 閉じた値(回収の済んだ行)の状態か。「返却済み」で始まる値と「取り下げ」だけ */
export function isClosedState(row) {
  const st = stateOf(row);
  return st.startsWith('返却済み') || st === '取り下げ' || st.startsWith('取り下げ(') || st.startsWith('取り下げ（');
}

/** 状態が有効の値でも失効でも閉じた値でもない(閉じた値でない)か */
export const isUnclosedState = (row) => !ACTIVE_EXCEPTION_STATES.includes(stateOf(row)) && !stateOf(row).startsWith('失効') && !isClosedState(row);

/**
 * 例外承認の行の効力。
 *   'active'   状態が有効で、期限の日までである(期限の日は効力がある)
 *   'overdue'  状態が有効のまま、期限の日が突合の日より前である
 *   'lapsed'   状態が失効である
 *   'undated'  状態が有効で、期限が日付として読めない(比べられない)
 *   'closed'   状態が「返却済み」で始まる、または「取り下げ」(回収の済んだ行)
 * 有効・失効・閉じた値のいずれでもない状態(誤記・空欄など)は、未回収の行として期限で比べる(期限内は 'active'、超過は 'overdue'。isUnclosedState で見分ける)
 */
export function exceptionStanding(row, day) {
  const st = stateOf(row);
  if (st.startsWith('失効')) return 'lapsed';
  if (isClosedState(row)) return 'closed';
  const due = dueDayOf(row.due);
  if (!due) return 'undated';
  return due < day ? 'overdue' : 'active';
}

/** 効力を失った行(有効のまま期限を過ぎた行と、失効の行) */
export const isLapsed = (row, day) => ['overdue', 'lapsed'].includes(exceptionStanding(row, day));

const idNum = (id) => Number(String(id ?? '').replace(/\D/g, ''));
const targetKey = (r) => String(r.target ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * 本文に別の行の識別(D-NNN)を書いて名指した、承認し直した行(新しい行)。次のすべてを満たす行だけを返す。無ければ null
 *   (1) 対象が元の行と一致する(対象の欄が空の行は一致としない)
 *   (2) 元の行より後に足された行である(識別の番号が大きい。または、始点の台帳を渡したとき、元の行は始点にあり、その行は始点に無い)
 *   (3) 状態が有効の値で、期限内である
 */
export function reapproverOf(row, rows, day, startIds = null) {
  const text = String(row.text ?? '').normalize('NFKC');
  const ids = new Set([...text.matchAll(/\bD-\d+/g)].map((m) => m[0]));
  ids.delete(row.id);
  const key = targetKey(row);
  if (!key) return null;
  const later = (r) => idNum(r.id) > idNum(row.id) || (startIds instanceof Set && startIds.has(row.id) && !startIds.has(r.id));
  return (
    rows.find(
      (r) => r.kind === '例外' && ids.has(r.id) && targetKey(r) === key && later(r) && ACTIVE_EXCEPTION_STATES.includes(stateOf(r)) && exceptionStanding(r, day) === 'active'
    ) ?? null
  );
}

/**
 * 承認し直された元の行の識別の集合。新しい行と判定された行は、元の行として外さない(相互の名指しで両方が外れるのを断つ)
 */
export function reapprovedIds(rows, day, startIds = null) {
  const ex = (rows ?? []).filter((r) => r.kind === '例外');
  const pairs = ex.map((r) => [r, reapproverOf(r, ex, day, startIds)]).filter(([, n]) => n);
  const newIds = new Set(pairs.map(([, n]) => n.id));
  return new Set(pairs.filter(([r]) => !newIds.has(r.id)).map(([r]) => r.id));
}

/**
 * 効力を失った例外承認の行の一覧(台帳全体。対象が出荷の範囲の外の行、ゲートの判定を対象とする行を含む)。
 * 承認し直された元の行は含めない
 */
export function lapsedExceptions(rows, day, startIds = null) {
  const ex = (rows ?? []).filter((r) => r.kind === '例外');
  const re = reapprovedIds(ex, day, startIds);
  return ex
    .filter((r) => isLapsed(r, day) && !re.has(r.id))
    .map((r) => ({ id: r.id, unclosed: isUnclosedState(r), target: String(r.target ?? '').trim() || '(対象の欄なし)', due: String(r.due ?? '').trim(), state: stateOf(r) || '(未記入)', standing: exceptionStanding(r, day) }));
}

/** 記録の欠落の文(集約の gaps へ出す) */
export function lapsedGapText(x, day) {
  const why = x.standing === 'lapsed' ? `状態が失効です` : x.unclosed ? `状態が「${x.state}」で、閉じた値(「返却済み」で始まる値・「取り下げ」)でなく、未回収のまま回収の期限(${x.due})を突合の日(${day})が過ぎています` : `状態が有効のまま、回収の期限(${x.due})を突合の日(${day})が過ぎています`;
  return (
    `例外承認 ${x.id}(対象 ${x.target}): ${why}。期限の翌日から効力を失っており、記録の欠落です(第7章 7.3)。` +
    '回収して状態を「返却済み」にするか、権限を持つ者が新しい行で承認し直し、元の行にその行の識別を書いてください(連鎖では、有効で期限内の最新の行の識別を書く)。期限の書き換えは承認のし直しではありません'
  );
}

const ledgerOf = (text) => (text ? parseLedger(text) : []);

/**
 * 範囲の例外承認の件数(標準 第1章 1.10.2)。
 *   件数: 範囲の始点で回収の済んでいなかった(閉じた値でない)区分「例外」の行と、範囲の中で足された行(始点の台帳に無い識別)
 *   未回収: 件数に数えた行のうち、終点の台帳で閉じた値(「返却済み」で始まる値・「取り下げ」)でない行(回収の記録が無く、取り下げていない)
 *   期限超過: 未回収のうち、状態が有効のまま期限を過ぎた行と、失効の行
 *   承認し直された元の行は、未回収と期限超過のどちらにも数えない。終点の台帳から消えた行は、未回収に数える
 * 独立した人の確認を経ない出荷の件数(withoutIndependentConfirmation)は、集約の突合の結果を呼び出し側が渡す
 */
export function countRangeExceptions({ startText, endText, day, ledger, withoutIndependentConfirmation = 0 }) {
  const start = ledgerOf(startText).filter((r) => r.kind === '例外');
  const end = ledgerOf(endText).filter((r) => r.kind === '例外');
  const startIds = new Set(start.map((r) => r.id));
  const counted = [
    ...start.filter((r) => !isClosedState(r)).map((r) => r.id),
    ...end.filter((r) => !startIds.has(r.id)).map((r) => r.id),
  ];
  const ids = [...new Set(counted)];
  const endById = new Map(end.map((r) => [r.id, r]));
  const re = reapprovedIds(end, day, startIds);
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
    if (re.has(row.id)) continue;
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
