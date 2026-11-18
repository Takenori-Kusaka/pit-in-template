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

/**
 * 範囲の中で返却の目安(期限)を延ばした行(IMPL-0787。第7章 7.3「期限の書き換えは承認のし直しでない」)。
 * 区分「例外」「類似検知」の行を、始点と終点の台帳で識別が同じものについて比べ、次を返す。
 *   終点の期限が始点の期限より後の日付である行 / 始点が日付で、終点が日付として読めない行
 * 期限を早める向き、状態だけの変更、始点に無い行(範囲で足された行)は返さない。
 * 始点の台帳が無い・読めないときは比べられないため { unverifiable: true, extended: [] } を返し、欠落にしない。
 * 範囲の外の履歴の書き換え、行の消去(未回収に数える)は、この関数で見ない
 */
export function extendedDueRows({ startText, endText }) {
  if (!startText || !String(startText).trim()) return { unverifiable: true, extended: [] };
  const kinds = ['例外', '類似検知'];
  const start = ledgerOf(startText).filter((r) => kinds.includes(r.kind));
  // 終点の行は区分で絞らない(区分を変えて期限を延ばしても見つける。IMPL-0787)
  const endById = new Map(ledgerOf(endText).map((r) => [r.id, r]));
  const extended = [];
  for (const s of start) {
    const e = endById.get(s.id);
    if (!e) continue;
    const a = dueDayOf(s.due);
    if (!a) continue;
    const b = dueDayOf(e.due);
    if (!b || b > a) extended.push({ id: s.id, kind: e.kind, from: String(s.due ?? '').trim(), to: String(e.due ?? '').trim() || '(未記入)' });
  }
  return { unverifiable: false, extended };
}

/** 期限を延ばした行の欠落の文 */
export function extendedDueGapText(x) {
  return (
    `返却目安の書き換え ${x.id}(区分「${x.kind}」): 範囲の始点の台帳で「${x.from}」だった返却の目安が、終点で「${x.to}」に変わっています。` +
    '期限を延ばす書き換えは承認のし直しではなく、記録の欠落です(第7章 7.3)。元の行は書き換えず、権限を持つ者が新しい行で承認し直し、元の行にその行の識別を書いてください'
  );
}

/**
 * 区分「類似検知」の行のうち、返却の目安が過ぎた未返却の行と、期限が日付として読めない未返却の行(IMPL-1008。G-7 基準8)。
 * 有効な延長の行(区分「例外」で、対象に当該の行の識別を書いたもの)が成立していれば数えない。
 * 成立の判定(IMPL-0786 と同じ条件)は呼び出し側から isValidExtension(similarRow, exceptionRow) で渡す。
 * 区分「例外」の行は lapsedExceptions が数えるので、ここでは数えない(countRangeExceptions の件数も変えない)
 */
export function lapsedSimilarRows(rows, day, isValidExtension = () => false) {
  const all = rows ?? [];
  const ex = all.filter((r) => r.kind === '例外');
  const out = [];
  for (const r of all.filter((x) => x.kind === '類似検知')) {
    if (isClosedState(r)) continue;
    const due = dueDayOf(r.due);
    if (due && due >= day) continue;
    const idRe = new RegExp(`(^|[^\\d])${r.id}(?!\\d)`);
    if (ex.some((e) => idRe.test(String(e.target ?? '').normalize('NFKC')) && isValidExtension(r, e))) continue;
    out.push({ id: r.id, target: String(r.target ?? '').trim() || '(対象の欄なし)', due: String(r.due ?? '').trim() || '(未記入)', readable: !!due });
  }
  return out;
}

/** 期限を過ぎた類似検知の行の欠落の文 */
export function lapsedSimilarGapText(x, day) {
  const why = x.readable ? `返却の目安(${x.due})を突合の日(${day})が過ぎ、未返却のままです` : `返却の目安(${x.due})が日付として読めず、期限を比べられません。期限のない記録は認めません`;
  return (
    `類似検知 ${x.id}(検知した変更 ${x.target}): ${why}。` +
    `期限を過ぎた未処理項目が残る出荷は止めます(第4章 G-7 基準8)。処理を完了して状態を「返却済み」にするか、有効な区分「例外」の行(対象に ${x.id} を書く)で延長してください`
  );
}

/**
 * 台帳の行の印(ADR-0200 決定2): 区分「例外」の行の内容の先頭が `ファストトラック(短縮: <ゲート>)` の行をファストトラックの適用とする。
 * 強調の `*`・`` ` `` と括弧の前の空白は、印の読みから除く(太字にした印が G-4・G-5 を名指す行の拒否を素通りしないため。IMPL-0612)。
 * 印を書かない行は、機械が当該の種類の行として見分けられない(印の付け忘れは機械で捕まえない)。check-pr.mjs と集約が同じ関数を使う
 */
export function fastTrackMarkOf(content) {
  const t = String(content ?? '').normalize('NFKC').replace(/[*`_]/g, '').trim();
  const m = /^ファストトラック\s*[(（]\s*短縮\s*[:：]\s*([^)）]*)[)）]/.exec(t);
  return m ? { scope: m[1].trim() } : null;
}

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const blankCell = (v) => !String(v ?? '').normalize('NFKC').replace(/[—\-–\s]/g, '');

/** 対象の欄(PR の番号またはコミットの識別子)が、原因の変更の欄と同じ変更を指すか */
function sameChange(target, cause) {
  const t = String(target ?? '').normalize('NFKC');
  const c = String(cause ?? '').normalize('NFKC');
  const prs = [...t.matchAll(/PR\s*#\s*(\d+)/gi)].map((m) => m[1]);
  if (prs.some((n) => new RegExp('(?:PR\\s*)?#\\s*' + n + '(?!\\d)', 'i').test(c))) return true;
  const hexes = [...t.matchAll(/\b[0-9a-f]{7,40}\b/gi)].map((m) => m[0].toLowerCase());
  const chexes = [...c.matchAll(/\b[0-9a-f]{7,40}\b/gi)].map((m) => m[0].toLowerCase());
  return hexes.some((h) => chexes.some((x) => x.startsWith(h) || h.startsWith(x)));
}

/**
 * ファストトラック(7.4)の指標(IMPL-0612。乱用を防ぐ制約5)。印のある区分「例外」の行から数える。
 *   発生率: 印の行の数 ÷ 範囲の変更数 / 回収完了率: 状態が閉じた値(返却済み・取り下げ)の印の行 ÷ 印の行
 *   適用後の欠陥: 欠陥の台帳の処分が「欠陥」で確定した者と確定日のある行のうち、原因の変更が印の行の対象と結べた件数と、
 *   原因の変更の欄が空欄の件数を併記する(空欄は結べない。結べた件数は下限であり、楽観へ偏る)
 * 印の付け忘れは数えられない。会議体へ報告するふるまいは見ない
 */
export function fastTrackMetrics({ rows, changeTotal, defectText = null, inRange = null }) {
  const marked = (rows ?? []).filter((r) => r.kind === '例外' && fastTrackMarkOf(r.content));
  const closed = marked.filter((r) => isClosedState(r)).length;
  // 発生率の分子は、範囲の変更へ対応づく印の行に限る(分母と範囲を揃える。IMPL-0612)。inRange を渡さなければ全体
  const markedInRange = inRange ? marked.filter((r) => inRange(r)).length : marked.length;
  const out = { marked: marked.length, markedInRange, outOfRange: marked.length - markedInRange, closed, changeTotal: changeTotal ?? 0, defects: null };
  if (defectText == null) return out;
  const lines = String(defectText).split(/\r?\n/).filter((l) => /^\s*\|/.test(l));
  const hi = lines.findIndex((l) => l.includes('原因の変更') && l.includes('処分'));
  if (hi < 0) return { ...out, defects: { readable: false } };
  const head = cellsOf(lines[hi]);
  const iCause = head.findIndex((h) => h.includes('原因の変更'));
  const iDisp = head.findIndex((h) => h.includes('処分'));
  const iBy = head.findIndex((h) => h.includes('確定した者'));
  const iDay = head.findIndex((h) => h.includes('確定日'));
  let confirmed = 0;
  let linked = 0;
  let causeBlank = 0;
  for (const l of lines.slice(hi + 1)) {
    const c = cellsOf(l);
    if (c.every((x) => /^:?-+:?$/.test(x))) continue;
    if (String(c[iDisp] ?? '').normalize('NFKC').trim() !== '欠陥' || blankCell(c[iBy]) || blankCell(c[iDay])) continue;
    confirmed++;
    if (blankCell(c[iCause])) causeBlank++;
    else if (marked.some((m) => sameChange(m.target, c[iCause]))) linked++;
  }
  return { ...out, defects: { readable: true, confirmed, linked, causeBlank } };
}

/** 指標の行の文(項目7)。 */
export function fastTrackMetricsText(m) {
  const pct = (a, b) => (b ? ' ' + Math.round((a / b) * 100) + '%' : ' —');
  const d = m.defects;
  const defect = d == null ? '欠陥の台帳が無く、適用後の欠陥は数えていない' : !d.readable ? '欠陥の台帳の表を読めず、適用後の欠陥は数えていない' : '適用後の欠陥: 確定した欠陥 ' + d.confirmed + ' 件のうち、原因の変更を印の行の対象と結べた ' + d.linked + ' 件 / 原因の変更の欄が空欄で結べない ' + d.causeBlank + ' 件(空欄は結べないため、結べた件数は楽観へ偏る)';
  return (
    'ファストトラック(7.4)の指標: 印のある行 ' + m.marked + ' 件(うち範囲の変更へ対応づく ' + (m.markedInRange ?? m.marked) + ' 件 / 範囲へ対応づかない行 ' + (m.outOfRange ?? 0) + ' 件。範囲の変更 ' + m.changeTotal + ' 件に対する発生率' + pct(m.markedInRange ?? m.marked, m.changeTotal) + ') / 回収完了 ' + m.closed + ' 件(回収完了率' + pct(m.closed, m.marked) + ') / ' + defect +
    '。印の付け忘れは数えられず、会議体への報告のふるまいは見ない'
  );
}

/**
 * 制限された状態での例外決裁(7.9.4。IMPL-0628)の行。区分「例外」の行のうち、対象の変更が承認権限の一時制限の範囲に触れ(restrictionTouched)、
 * 数えた承認が 2 名に満たないものとする。units は { label: '#12' | 'コミット abcdef12', independent: { restrictionTouched, by } } の配列。
 * 欠落: (a) 承認した者が B-2 の決定者でない(isDecider(承認した者) が false。null は未確認として欠落にしない) (b) 返却の目安に日付か回収責任者が無い。
 * 印(ファストトラック)の無い行の件数は出す(欠落にしない。ADR-0200 決定5(a))
 */
export function restrictedStateExceptions({ rows, units, isDecider = () => null }) {
  const found = [];
  const gaps = [];
  const unconfirmed = [];
  for (const r of (rows ?? []).filter((x) => x.kind === '例外')) {
    const t = String(r.target ?? '').normalize('NFKC');
    if (!t.trim() || /^\s*(G|SG)-?\d/.test(t)) continue;
    const pr = /PR\s*#\s*(\d+)/i.exec(t)?.[1];
    const hexes = [...t.matchAll(/\b[0-9a-f]{7,40}\b/gi)].map((m) => m[0].toLowerCase());
    const unit = (units ?? []).find((u) => {
      const l = String(u.label ?? '');
      if (pr && l === '#' + pr) return true;
      const h = /コミット\s*([0-9a-f]+)/i.exec(l)?.[1]?.toLowerCase();
      return Boolean(h) && hexes.some((x) => x.startsWith(h) || h.startsWith(x));
    });
    if (!unit || unit.independent?.restrictionTouched !== true || (unit.independent?.by ?? []).length >= 2) continue;
    found.push({ id: r.id, target: t.trim(), marked: Boolean(fastTrackMarkOf(r.content)) });
    const dec = isDecider(r.approver);
    if (dec === false) gaps.push('制限された状態での例外決裁 ' + r.id + '(対象 ' + t.trim() + '): 承認した者「' + String(r.approver ?? '').trim() + '」が、D-0 の会議体の表の B-2 の決定者(B-2 が該当なしなら事業決裁者の席の責任者)でありません。記録の欠落です(第7章 7.9.4 要求事項2)');
    else if (dec == null) unconfirmed.push(r.id);
    const due = String(r.due ?? '').normalize('NFKC');
    if (!dueDayOf(due) || !/回収責任者\s*[:：]?\s*[^\s|]/.test(due)) {
      gaps.push('制限された状態での例外決裁 ' + r.id + '(対象 ' + t.trim() + '): 返却の目安に、回収の期限の日付か回収責任者がありません。記録の欠落です(第7章 7.9.4 要求事項4)');
    }
  }
  return { found, gaps, unconfirmed, unmarked: found.filter((x) => !x.marked).map((x) => x.id) };
}

/**
 * 7.9.5 の枠と行使の件数(IMPL-0669)。briefText は企画書、used は当該ステージで行使した 7.9.4 の行の数、usedReadable は累計を読めたか。
 * 枠が読めなければ「確認できない」を出す。止めない
 */
export function exceptionQuotaText({ briefText, used, usedReadable = true }) {
  const line = String(briefText ?? '').split(/\r?\n/).find((l) => l.includes('例外の枠'));
  const cell = line ? (cellsOf(line)[1] ?? '') : '';
  const m = /^\s*(\d+)/.exec(cell.normalize('NFKC'));
  const quota = m ? Number(m[1]) : null;
  const base = '制限された状態での例外決裁(7.9.4)の対応づけは 7.9.4 の条件による';
  if (!usedReadable) return base + '。ステージの累計を確認できない(直前のステージ移行ゲートの通過のコミットの台帳を読めない)';
  if (quota === null) return base + '。枠: 確認できない(企画書の「例外の枠」が件数として読めない) / 行使 ' + used + ' 件';
  const rest = quota - used;
  return base + '。枠 ' + quota + '・行使 ' + used + '・残り ' + rest + (rest < 0 ? '(超過)' : '') + '。止めない。累計は範囲の中で 7.9.4 の条件に当たる行の数(範囲の外で足された行は再判定できず、下限の値)';
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

/**
 * ゲートの判定を対象とする例外承認の行のうち、判定を行わないまま 7.3 で進めるものを選ぶ(IMPL-0996 / ADR-0153 決定2)。
 *   G-4: 当該の機能仕様の G-4 の判定記録が無い行(judged(subject) が偽)。判定を行った証跡を見る
 *   G-5: 常に。準拠テンプレートの G-5 は PR ごとの gate-g5 で、その失敗は例外承認で解かず、台帳の行を当該の集約の結果へ機械は結べない
 *   それ以外のゲートは変えない。rows は { label, t: { gate, subject } } の配列。戻りは { label, text } の配列
 */
export function unjudgedGateExceptions(rows, judged) {
  const out = [];
  for (const { label, t } of rows) {
    if (t.gate === 'G-4' && !judged(t.subject)) {
      out.push({ label, text: `ゲートの判定を対象とする例外承認 ${label}: 当該の機能仕様の G-4 の判定記録(様式、または判定者本人のレビューの宣言行)が無い。判定を行わないまま 7.3 で進めることはできない(第7章 7.3・7.4、ADR-0153 決定2)。G-4 を判定してから記録し直すか、状態を「取り下げ」にする` });
    } else if (t.gate === 'G-5') {
      out.push({ label, text: `ゲートの判定を対象とする例外承認 ${label}: 準拠テンプレートの G-5 は PR ごとの gate-g5 で、その失敗は例外承認で解かない。台帳の行を当該の集約の結果へ機械は結べない(第7章 7.3、ADR-0153 決定2)。状態を「取り下げ」にする` });
    }
  }
  return out;
}
