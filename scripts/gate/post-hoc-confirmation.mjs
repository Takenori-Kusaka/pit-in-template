// 事後の確認の記録の月ごとの件数(標準 第5章 5.5.4 条件6・第8章「事後監査の手続」)。
//
// 委任の判定(autonomy.mjs)と証跡の集約(aggregate-evidence.mjs)の両方が同じ導き方で数えるための共通のモジュール。
// どちらも読む側なので、このモジュールは autonomy.mjs・aggregate-evidence.mjs を読まない(循環させない)。
//
//   事後へ移した変更 = 既定ブランチの第1親の履歴の、トレーラ `Delegated: <規則ID>` を持つ変更(委任のマージの経路が付ける)。
//                      規則 ID から変更種別を引く(delegation.rules[].changeType)
//   事後の確認の記録 = G-6 の判定記録で、確定の形態が「委任」、対象が当該の変更の PR を指し、判定者が独立レビュアの席の責任者のもの
//   月ごとに、種類ごとの n(事後へ移した変更)と k(確認の記録のある変更)を数える
//
// 数えるのは記録の件数だけで、確認の中身・抜き取りの選び方・記録を足した者が判定者本人かは確かめない。
// 記録を足した時点が出荷判定の前か後かも問わない(事後の確認は、取り込みの後に行うものである)

import { execFileSync } from 'node:child_process';
import { personKey, MODE_LABEL } from './config.mjs';
import { recordFromForm, judgeOfForm } from './records.mjs';

/**
 * 月の件数 n に対する確認の定め。構成 delegation.sampling.perMonth を採用者が定めていれば perMonth と n の小さいほう。
 * 定めていない(perMonth が null)とき、または判定の材料が揃っていない月(full)は、当月の全件(一律の既定の件数は置かない)
 */
export function requiredCount(n, { perMonth = null, full = false } = {}) {
  if (full) return n;
  return Number.isInteger(perMonth) && perMonth >= 1 ? Math.min(n, perMonth) : n;
}

/**
 * 事後の確認の記録の月ごとの件数。items = 事後へ移した変更ごとの { month(YYYY-MM。読めなければ null), sampled(独立レビュアの席の責任者の確認の記録があるか), type(任意) }。
 * type があれば、月と種類ごとに数える。fullMonths は判定不能の月で、配列(すべての種類に当てる)か { 種類: [月] }(その種類だけ)。
 * 合否・記載の欠落には数えない(止めるのは委任の判定の側で、記録から導く)
 */
export function samplingMonthly(items, { perMonth = null, reviewerResolved = true, fullMonths = [] } = {}) {
  const source = Number.isInteger(perMonth) && perMonth >= 1 ? 'config' : 'undefined';
  // 独立レビュアの席の責任者を名簿から引けないとき、記録があっても k=0 になり全ての月が不足に見える(誤報)。件数を数えず、その旨を返す
  if (!reviewerResolved) return { months: [], short: [], undated: 0, source, unresolved: true };
  const by = new Map();
  let undated = 0;
  for (const it of items ?? []) {
    if (!it.month) {
      undated += 1;
      continue;
    }
    const key = `${it.month}\u0000${it.type ?? ''}`;
    const e = by.get(key) ?? { month: it.month, type: it.type ?? null, n: 0, k: 0 };
    e.n += 1;
    if (it.sampled) e.k += 1;
    by.set(key, e);
  }
  const fullOf = (e) => (Array.isArray(fullMonths) ? fullMonths : (fullMonths?.[e.type] ?? [])).includes(e.month);
  const months = [...by.values()]
    .sort((a, b) => a.month.localeCompare(b.month) || String(a.type ?? '').localeCompare(String(b.type ?? '')))
    .map((e) => {
      const full = fullOf(e);
      const required = requiredCount(e.n, { perMonth, full });
      return { ...e, required, full, short: e.k < required };
    });
  return { months, short: months.filter((m) => m.short), undated, source };
}

/** 事後の確認の記録の件数の表示(表の下に添える文)。判定ではない。「確認が行われた」とは書かず、記録の件数が揃っているかだけを出す */
export function samplingMonthlyText(m) {
  if (m.unresolved) return '独立レビュアの席の責任者を名簿から引けず、事後の確認の記録の件数を数えていません。確認が行われていないことを意味しません。席の責任者を記録すると、月ごとの件数を表示します(この表示は合否にも記載の欠落にも数えません)';
  const basis = m.source === 'config' ? '構成 delegation.sampling.perMonth' : '抜き取りの件数を定めていないため、当月の全件';
  const label = (x) => `${x.month}${x.type ? `・種類 ${x.type}` : ''}`;
  const head = m.short.length
    ? `事後の確認の記録の件数が定めに満たない月: ${m.short.map((x) => `${label(x)}(事後へ移した変更 ${x.n} 件・記録 ${x.k} 件・定め ${x.required} 件${x.full ? '。判定の材料が揃っていない月のため全件' : ''})`).join(' / ')}。翌月の末までに埋まらない月がある種類は、委任の判定が止める`
    : '事後の確認の記録の件数が定めに満たない月はありません(記録の件数が揃っていることを示すだけで、確認が行われたことは示さない)';
  const counting = '事後へ移した変更の数え方: 委任の判定は、トレーラ Delegated を持ち、取り込む前の承認の記録が無い変更を数える。この集計は、独立した人の事前の承認が無い委任の変更を数える。承認した者が独立した人かの確認の有無だけ違い、取り込む前に独立でない人だけが承認した変更は、判定の側が数えない';
  return `${head}。${counting}。定めの出所: ${basis}。この表示は合否にも記載の欠落にも数えません。確認の選び方(当事者に選ばせない)・確認の中身・記録を足した者が判定者本人かは機械で確かめていません(確かめる者: プロセス内部監査)${m.undated ? `。マージの時刻を読めない変更 ${m.undated} 件は月ごとの表示に含めていません` : ''}`;
}

/** PR の番号への参照を含むか。「PR #12」・前に語の無い「#12」・PR の URL(…/pull/12)に限る。「Issue #12」「org/repo#12」は PR を指さない */
export function refersToPr(text, n) {
  const s = String(text ?? '');
  if (new RegExp(`/pull/${n}(?!\\d)`).test(s)) return true;
  for (const m of s.matchAll(new RegExp(`#${n}(?!\\d)`, 'g'))) {
    const before = s.slice(0, m.index).replace(/\s+$/, '');
    if (/(?:^|[^A-Za-z])(?:PR|pull request|プルリクエスト)$/i.test(before)) return true;
    if (!/[\p{L}\p{N}_/.-]$/u.test(before)) return true;
  }
  return false;
}

/** 規則 ID から変更種別の ID を引く(delegation.rules[].changeType)。無ければ null */
export function typeOfRule(config, ruleId) {
  const t = String((config?.delegation?.rules ?? []).find((r) => r?.id === ruleId)?.changeType ?? '').trim();
  return t || null;
}

/**
 * 導出(純粋な関数)。moved = [{ ref, date(YYYY-MM-DD), pr(番号か null), rule }]、forms = [{ file, text }](G-6 を含む判定記録の様式の本文)。
 * 返り値: { available, reason?, byType: { 種類: [{ month, n, k }] }, sampledPrs: [番号], unattributed: 規則から種類を引けない変更の件数 }
 * 独立レビュアの席の責任者を名簿から引けないときは available=false(読めない)。席の責任者本人が確認の記録の判定者である体制も数える
 */
export function derivePostHoc({ config, moved, forms, approvedPrs = null }) {
  const seat = (config?.seats ?? []).find((s) => s?.role === 'independent-reviewer');
  const reviewerKey = personKey(config ?? {}, seat?.accountable);
  if (!reviewerKey) return { available: false, reason: '独立レビュアの席の責任者を名簿から引けない', byType: {}, sampledPrs: [], unattributed: 0 };
  const targets = [];
  for (const f of forms ?? []) {
    const rec = recordFromForm(f.text, f.file, 'base');
    if (!/^G-6\b/.test(String(rec.gate ?? '')) || rec.mode !== MODE_LABEL.delegated) continue;
    const judge = judgeOfForm(f.text);
    if (!judge || personKey(config, judge) !== reviewerKey) continue;
    targets.push(rec.target ?? '');
  }
  const sampledPrs = new Set();
  const byType = {};
  let unattributed = 0;
  for (const c of moved ?? []) {
    // 取り込む前に人の承認を受けた変更は、事後へ移した変更に数えない(出荷の証跡の集約が「独立した人の事前の承認が無い委任の変更」だけを数えるのに揃える)。
    // 承認の記録を読めたときだけ除く。承認した者が独立した人かは、ここでは確かめない
    if (approvedPrs && c.pr != null && approvedPrs.has(String(c.pr))) continue;
    const type = typeOfRule(config, c.rule);
    if (!type) {
      unattributed += 1;
      continue;
    }
    const sampled = c.pr != null && targets.some((t) => refersToPr(t, c.pr));
    if (sampled) sampledPrs.add(String(c.pr));
    const month = /^\d{4}-\d{2}/.test(String(c.date ?? '')) ? String(c.date).slice(0, 7) : null;
    if (!month) continue;
    const list = (byType[type] ??= []);
    let row = list.find((x) => x.month === month);
    if (!row) list.push((row = { month, n: 0, k: 0 }));
    row.n += 1;
    if (sampled) row.k += 1;
  }
  return { available: true, byType, sampledPrs: [...sampledPrs], unattributed };
}

/**
 * 既定ブランチの第1親の履歴から、トレーラ Delegated を持つ変更を読み、forms と合わせて導出する。浅い取得・git でない場合は読めないものとする
 */
export function readPostHocRecords({ config, root, forms = [], approvedPrs = null } = {}) {
  try {
    const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    if (run(['rev-parse', '--is-shallow-repository']).trim() === 'true') return { available: false, reason: '浅い取得(shallow)で、履歴の全体を読めない', byType: {}, sampledPrs: [], unattributed: 0 };
    const out = run(['log', '--first-parent', '--no-renames', '--format=%x1e%H%x09%cs%x09%s%x1f%(trailers:key=Delegated,valueonly,separator=%x2C)', 'HEAD']);
    const moved = [];
    for (const block of out.split('\x1e').filter((b) => b.trim())) {
      const [head, trailer = ''] = block.split('\x1f');
      const rule = trailer.trim().split(',')[0].trim();
      if (!rule) continue;
      const [ref, date, subject] = head.split('\t');
      moved.push({ ref, date, pr: subject?.match(/\(#(\d+)\)\s*$/)?.[1] ?? null, rule });
    }
    return derivePostHoc({ config, moved, forms, approvedPrs });
  } catch (e) {
    return { available: false, reason: `git の履歴を読めない(${String(e.message).split('\n')[0]})`, byType: {}, sampledPrs: [], unattributed: 0 };
  }
}
