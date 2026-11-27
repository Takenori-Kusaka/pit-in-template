// 営業日の関数とレビューの滞留の通知の試験(IMPL-0680・0681・0682・0979・0136・0212。process-compass #445)。
// 時計と TZ に依らない: now は固定の時刻を渡し、子プロセスで TZ=UTC と TZ=Asia/Tokyo の結果が同じことを確かめる。
//
//   node scripts/gate/test-review-queue.mjs

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addBusinessDays, businessDaysBetween, dayOf, isBusinessDay, parseHolidays, loadHolidays, HOLIDAYS_UNCOUNTED_NOTE } from './business-days.mjs';
import { DELEGATION_STATUS_CONTEXT, DELEGATION_ELIGIBLE_PREFIX, queueActions, riskLabelAction, parseDeadlines, escalationTarget, seatLogin, fetchSnapshot, isApproved, DEFAULT_DEADLINES } from './review-queue.mjs';
import { isProseDocument } from './check-pr.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 600)}`}`);
}

// ---- 営業日 ----
// 2026-11-16 は月曜
check('営業日: 金曜 + 1 営業日は月曜', addBusinessDays('2026-11-13', 1) === '2026-11-16');
check('営業日: 月曜 + 5 営業日は翌月曜', addBusinessDays('2026-11-16', 5) === '2026-11-23');
check('営業日: 土曜 + 1 営業日は月曜', addBusinessDays('2026-11-14', 1) === '2026-11-16');
check('営業日: 月曜 - 2 営業日は前の木曜', addBusinessDays('2026-11-16', -2) === '2026-11-12');
const hol = parseHolidays('# 祝日\n2026-11-23 # 勤労感謝の日\n\nabc\n2026-02-30\n');
check('祝日: コメント・空行を除き、実在しない日付は読めない行に返す', hol.days.has('2026-11-23') && hol.days.size === 1 && hol.invalid.length === 2, JSON.stringify([...hol.days, hol.invalid]));
check('祝日: 祝日は営業日に数えない', addBusinessDays('2026-11-20', 1, hol.days) === '2026-11-24' && !isBusinessDay('2026-11-23', hol.days));
check('営業日: 期間の営業日の数', businessDaysBetween('2026-11-13', '2026-11-17') === 2 && businessDaysBetween('2026-11-17', '2026-11-13') === 0);
check('祝日のファイルが無ければ、祝日を数えていない旨を返す', loadHolidays('/nonexistent-root').counted === false && loadHolidays('/nonexistent-root').note === HOLIDAYS_UNCOUNTED_NOTE && /祝日を数えていない/.test(HOLIDAYS_UNCOUNTED_NOTE));
check('暦の日: 明示した差で直す(UTC 15:30 は日本では翌日)', dayOf('2026-11-13T15:30:00Z', 540) === '2026-11-14' && dayOf('2026-11-13T15:30:00Z', 0) === '2026-11-13' && dayOf('x') === null);

// TZ に依らない(子プロセスで TZ を変えて同じ結果)
const snippet = "import('./scripts/gate/business-days.mjs').then(m=>console.log(JSON.stringify([m.addBusinessDays('2026-11-13',3),m.dayOf('2026-11-13T23:30:00Z'),m.businessDaysBetween('2026-11-01','2026-11-30'),m.weekdayOf('2026-11-16')])))";
const run = (tz) => execFileSync(process.execPath, ['-e', snippet], { env: { ...process.env, TZ: tz }, cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' }).trim();
const [a, b] = [run('UTC'), run('Asia/Tokyo')];
check('TZ に依らない: TZ=UTC と TZ=Asia/Tokyo で同じ結果', a === b && a === '["2026-11-18","2026-11-14",21,1]', `${a} / ${b}`);

// ---- D-0 の読み ----
const d0 = `
## 3. 決定の権限

| 決定の種類 | 決定(1名) | 同意 |
| --- | --- | --- |
| 体制と運用形態(責任者の任免) | 事業決裁者 | |

## 5. 判定の期限

| ゲート | 期限の目安 | 超過したときの扱い |
| --- | --- | --- |
| G-2 要件合意 | 48時間 | x |
| G-3 技術設計判断 | 24時間 | 同上 |
| G-4 機能仕様承認 | 12時間 | 同上 |
| G-6 独立レビュー | 応答2営業日 / 判定3営業日 | 同上 |

## 6. 平常時のエスカレーション

| 発火条件 | 判定する者(席・会議体) | 写しの宛先 | 応答期限 |
| --- | --- | --- | --- |
| ゲート判定・会議体の決定が期限を超過(標準 7.5) | 節3「体制と運用形態」の決定者 | | |
`;
const config = {
  people: [
    { id: 'p1', name: '山田 太郎', accounts: [{ login: 'boss', id: 1 }] },
    { id: 'p2', name: '鈴木 一郎', accounts: [{ login: 'alice', id: 2 }] },
  ],
  seats: [
    { role: 'biz-approver', accountable: 'p1' },
    { role: 'value-owner', accountable: 'p2' },
  ],
  riskFloor: { rules: [{ id: 'auth', paths: ['src/auth/**'], floor: 'R1', why: 'x' }] },
};
const pd = parseDeadlines(d0);
check('期限: 節5 の表を読む', pd.deadlines['G-6'].responseBd === 2 && pd.deadlines['G-6'].judgeBd === 3 && pd.deadlines['G-3'].hours === 24 && pd.defaulted.length === 0, JSON.stringify(pd));
const pdBad = parseDeadlines('## 5. 判定の期限\n\n| ゲート | 期限の目安 | x |\n| --- | --- | --- |\n| G-6 独立レビュー | 未定 | x |\n');
check('期限: 読めない値は標準の既定を使い、その旨を返す', pdBad.deadlines['G-6'].responseBd === DEFAULT_DEADLINES['G-6'].responseBd && pdBad.defaulted.includes('G-6'));
const esc = escalationTarget(d0, config);
check('宛先: 節6 → 節3 の決定者 → 席 → 名簿 → login', esc.login === 'boss' && esc.role === 'biz-approver', JSON.stringify(esc));
check('宛先: 席に責任者がいなければ解決できない旨を返す', escalationTarget(d0, { ...config, seats: [] }).login === null && Boolean(seatLogin({ seats: [] }, 'value-owner').why));

// ---- 通知(固定の時刻) ----
const mk = (o) => ({ number: 1, draft: false, createdAt: '2026-11-10T00:00:00Z', readyAt: null, files: ['src/a.js'], requestedTeams: [], requests: [], reviews: [], comments: [], labels: [], changes: [], ...o });
const NOW = '2026-11-18T03:00:00Z'; // 水曜 12:00 JST
const base = { now: NOW, config, d0Text: d0 };

// 0680
const t1 = queueActions({ ...base, prs: [mk({ requestedTeams: ['core'] })] });
check('IMPL-0680:ng チームだけの指名で個人の指名を求める', t1.actions.some((x) => x.key === 'team-only' && /個人/.test(x.body)));
const t2 = queueActions({ ...base, prs: [mk({ requestedTeams: ['core'], requests: [{ login: 'rev1', at: NOW }] })] });
check('IMPL-0680:ok 個人の指名があれば出ない', !t2.actions.some((x) => x.key === 'team-only'));
check('IMPL-0680:ng 判定は requested_reviewers を見る(事象が欠けても、個人の指名が無ければ出る)', queueActions({ ...base, prs: [mk({ requestedTeams: ['core'], requests: [{ login: 'rev1', at: NOW }], requestedReviewers: [] })] }).actions.some((x) => x.key === 'team-only') && !queueActions({ ...base, prs: [mk({ requestedTeams: ['core'], requests: [], requestedReviewers: ['rev1'] })] }).actions.some((x) => x.key === 'team-only'));

// 0681(応答2営業日。月曜 09:00 JST の指名 → 期限は水曜まで。水曜は期限内。木曜に超過)
const rq = [{ login: 'rev1', at: '2026-11-16T00:00:00Z' }];
const inTime = queueActions({ ...base, prs: [mk({ requests: rq })] });
check('IMPL-0681:ok 期限内は催促が出ない', !inTime.actions.some((x) => /^nudge/.test(x.key)));
const late = queueActions({ ...base, now: '2026-11-19T03:00:00Z', prs: [mk({ requests: rq })] });
const nudge = late.actions.find((x) => /^nudge:/.test(x.key));
check('IMPL-0681:ng 応答の期限の超過で、指名した者へ記名の催促が出る', Boolean(nudge) && /@rev1/.test(nudge.body));
check('IMPL-0681:ok 2倍に届かなければ宛先へ通知しない', !late.actions.some((x) => /^nudge2:/.test(x.key)));
const late2 = queueActions({ ...base, now: '2026-11-24T03:00:00Z', prs: [mk({ requests: rq })] });
const n2 = late2.actions.find((x) => /^nudge2:/.test(x.key));
check('IMPL-0681:ng 2倍の超過で D-0 節6 の宛先へ記名で通知', Boolean(n2) && /@boss/.test(n2.body));
check('IMPL-0681:ok 応答済みなら催促しない', !queueActions({ ...base, now: '2026-11-24T03:00:00Z', prs: [mk({ requests: rq, reviews: [{ login: 'Rev1', state: 'COMMENTED', at: NOW }] })] }).actions.some((x) => /^nudge/.test(x.key)));
check('IMPL-0681:ok 同じ通知は2回出さない(印)', queueActions({ ...base, now: '2026-11-19T03:00:00Z', prs: [mk({ requests: rq, comments: [{ body: nudge.body, login: 'github-actions[bot]' }] })] }).actions.every((x) => x.key !== nudge.key));
check('IMPL-0681:ng 印は機械(github-actions)のコメントだけを数える(人が印を書いても通知は止まらない)', queueActions({ ...base, now: '2026-11-19T03:00:00Z', prs: [mk({ requests: rq, comments: [{ body: nudge.body, login: 'someone' }] })] }).actions.some((x) => x.key === nudge.key));
check('IMPL-0681:ok 催促の文に、祝日を数えていない旨が出る', /祝日を数えていない/.test(queueActions({ ...base, now: '2026-11-19T03:00:00Z', holidaysNote: HOLIDAYS_UNCOUNTED_NOTE, prs: [mk({ requests: rq })] }).actions.find((x) => /^nudge:/.test(x.key)).body));
// 依頼の付け直し: 過去のレビューは、新しい依頼への応答に数えない
const re = [{ login: 'rev1', at: '2026-11-09T00:00:00Z' }];
check('IMPL-0681:ng 付け直した依頼では、過去のレビューを応答に数えず、催促が出る', queueActions({ ...base, now: '2026-11-19T03:00:00Z', prs: [mk({ requests: re, reviews: [{ login: 'rev1', state: 'COMMENTED', at: '2026-11-02T00:00:00Z' }] })] }).actions.some((x) => /^nudge:/.test(x.key)));
check('IMPL-0681:ok 依頼より後のレビューは応答に数える', !queueActions({ ...base, now: '2026-11-19T03:00:00Z', prs: [mk({ requests: re, reviews: [{ login: 'rev1', state: 'COMMENTED', at: '2026-11-10T00:00:00Z' }] })] }).actions.some((x) => /^nudge:/.test(x.key)));
check('IMPL-0681:ok 祝日は営業日に数えない', !queueActions({ ...base, now: '2026-11-19T03:00:00Z', holidays: new Set(['2026-11-17']), prs: [mk({ requests: rq })] }).actions.some((x) => /^nudge:/.test(x.key)));
check('IMPL-0681:ok ドラフトは対象にしない', queueActions({ ...base, now: '2026-11-24T03:00:00Z', prs: [mk({ draft: true, requests: rq })] }).actions.length === 0);

// 0979(判定 3 営業日。作成 2026-11-10 火 → 期限 11-13 金。NOW は超過)
const j = queueActions({ ...base, prs: [mk({})] });
const jo = j.actions.find((x) => x.key === 'judge-overdue');
check('IMPL-0979:ng 判定の期限の超過で、宛先へ通知し代理の指名を求める', Boolean(jo) && /@boss/.test(jo.body) && /代理/.test(jo.body));
check('IMPL-0979:ok 期限内は出ない', !queueActions({ ...base, prs: [mk({ createdAt: '2026-11-17T00:00:00Z' })] }).actions.some((x) => x.key === 'judge-overdue'));
check('IMPL-0979:ok 承認が付いていれば出ない', !queueActions({ ...base, prs: [mk({ reviews: [{ login: 'x', state: 'APPROVED', at: NOW }] })] }).actions.some((x) => x.key === 'judge-overdue'));
check('IMPL-0979:ng G-3(context/decisions/ だけ)は時間で見る(24時間)', queueActions({ ...base, prs: [mk({ createdAt: '2026-11-17T00:00:00Z', files: ['context/decisions/0001.md'] })] }).actions.some((x) => x.key === 'judge-overdue'));
check('IMPL-0979:ok G-3 と混ざる PR は G-6 で見る', !queueActions({ ...base, prs: [mk({ createdAt: '2026-11-17T00:00:00Z', files: ['context/decisions/0001.md', 'src/a.js'] })] }).actions.some((x) => x.key === 'judge-overdue'));
check('宛先を解決できないときは記名なしで出し、注意に書く', (() => {
  const r = queueActions({ ...base, config: { ...config, seats: [] }, prs: [mk({})] });
  return r.actions.some((x) => x.key === 'judge-overdue') && r.notes.some((n) => /宛先を解決できない/.test(n));
})());

// 判定完了時間の起点と終点(第4章「2つの時刻を分ける」)
const J = { ...base, now: '2026-11-18T03:00:00Z' };
check('IMPL-0979:ng 差し戻し(CHANGES_REQUESTED)が承認の後に付けば、確定とみなさず通知が出る', queueActions({ ...J, prs: [mk({ reviews: [{ login: 'x', state: 'APPROVED', at: '2026-11-11T00:00:00Z' }, { login: 'x', state: 'CHANGES_REQUESTED', at: '2026-11-12T00:00:00Z' }] })] }).actions.some((x) => x.key === 'judge-overdue'));
check('IMPL-0979:ng ボットの承認では確定とみなさない', queueActions({ ...J, prs: [mk({ reviews: [{ login: 'dependabot[bot]', state: 'APPROVED', at: '2026-11-11T00:00:00Z', bot: true }] })] }).actions.some((x) => x.key === 'judge-overdue'));
check('IMPL-0979:ng 書き込み権限のない者の承認・古い commit の承認は確定とみなさない', queueActions({ ...J, prs: [mk({ reviews: [{ login: 'x', state: 'APPROVED', at: '2026-11-11T00:00:00Z', assoc: 'NONE' }] })] }).actions.some((x) => x.key === 'judge-overdue') && queueActions({ ...J, prs: [mk({ headSha: 'b', reviews: [{ login: 'x', state: 'APPROVED', at: '2026-11-11T00:00:00Z', commit: 'a' }] })] }).actions.some((x) => x.key === 'judge-overdue'));
check('IMPL-0979:ok 書き込み権限のある者の最新の commit への承認は確定', isApproved(mk({ headSha: 'b', reviews: [{ login: 'x', state: 'APPROVED', at: '2026-11-11T00:00:00Z', assoc: 'MEMBER', commit: 'b' }] })));
check('IMPL-0979:ng 起点は最初のレビュー依頼。作成が古くても、依頼が新しければ期限内', !queueActions({ ...J, prs: [mk({ createdAt: '2026-11-02T00:00:00Z', firstRequestAt: '2026-11-17T00:00:00Z' })] }).actions.some((x) => x.key === 'judge-overdue') && queueActions({ ...J, prs: [mk({ createdAt: '2026-11-17T00:00:00Z', firstRequestAt: '2026-11-10T00:00:00Z' })] }).actions.some((x) => x.key === 'judge-overdue'));

// 0682(上限3)
const heavy = [1, 2, 3, 4].map((n) => mk({ number: n, createdAt: NOW, requests: [{ login: 'busy', at: `2026-11-18T0${n}:00:00Z` }] }));
const h = queueActions({ ...base, loadLimit: 3, prs: heavy });
check('IMPL-0682:ng 4件目の指名で知らせる(指名は外さない)', h.actions.filter((x) => x.key === 'load:busy').length === 1 && h.actions.find((x) => x.key === 'load:busy').pr === 4);
const reHeavy = [1, 2, 3, 4].map((n) => mk({ number: n, createdAt: NOW, requests: [{ login: 'busy', at: `2026-11-18T0${n}:00:00Z` }], reviews: [{ login: 'busy', state: 'COMMENTED', at: '2026-11-01T00:00:00Z' }] }));
check('IMPL-0682:ng 付け直した依頼は、過去のレビューがあっても同時保有に数える', queueActions({ ...base, loadLimit: 3, prs: reHeavy }).actions.some((x) => x.key === 'load:busy'));
check('IMPL-0682:ok 3件目までは出ない', !queueActions({ ...base, loadLimit: 3, prs: heavy.slice(0, 3) }).actions.some((x) => x.key === 'load:busy'));
check('IMPL-0682:ok 同時保有の上限を採用者が定めていないとき(構成に欄が無い)は、上限の知らせを出さない', !queueActions({ ...base, prs: heavy }).actions.some((x) => x.key === 'load:busy'));
check('IMPL-0682:ok 上限は引数で変えられる', queueActions({ ...base, loadLimit: 2, prs: heavy.slice(0, 3) }).actions.some((x) => x.key === 'load:busy'));

// 0136
const prose = ['README.md', 'CLAUDE.md'];
check('IMPL-0136:前提 試験の PR のファイルは散文のファイルである', prose.every((f) => isProseDocument(f)));
check('IMPL-0136:ng 散文だけを変える PR の超過でも催促が出る(外すと落ちる)', queueActions({ ...base, now: '2026-11-19T03:00:00Z', prs: [mk({ files: prose, requests: rq })] }).actions.some((x) => /^nudge:/.test(x.key)));

check('IMPL-0136:ok 散文だけを変える PR でも、期限内は催促が出ない', !queueActions({ ...base, prs: [mk({ files: prose, requests: rq })] }).actions.some((x) => /^nudge:/.test(x.key)));

// 0212
const rules = config.riskFloor.rules;
const ra = riskLabelAction({ pr: mk({ changes: [{ path: 'src/auth/login.js', status: 'modified' }] }), rules });
check('IMPL-0212:ng R1 規則に当たる PR に risk/R1 が付く', ra?.label === 'risk/R1');
check('IMPL-0212:ok 当たらなければ risk/R3', riskLabelAction({ pr: mk({ changes: [{ path: 'src/b.js', status: 'added' }] }), rules })?.label === 'risk/R3');
const authChange = [{ path: 'src/auth/login.js', status: 'modified' }];
check('IMPL-0212:ng 機械が付けた risk/R3 は、下限が R1 に上がれば R1 へ引き上げる(R3 を外す)', (() => { const a = riskLabelAction({ pr: mk({ labels: ['risk/R3'], machineRiskLabels: ['risk/R3'], changes: authChange }), rules }); return a?.label === 'risk/R1' && a.remove?.[0] === 'risk/R3'; })());
check('IMPL-0212:ok 機械が付けたラベルを、下げる方へは変えない', riskLabelAction({ pr: mk({ labels: ['risk/R1'], machineRiskLabels: ['risk/R1'], changes: [{ path: 'src/b.js', status: 'added' }] }), rules }) === null);
check('IMPL-0212:ok 人が付けたラベルには、下限が厳しくても触れない', riskLabelAction({ pr: mk({ labels: ['risk/R3'], machineRiskLabels: [], changes: authChange }), rules }) === null);
check('IMPL-0212:ok 既存の risk/* のラベルを上書きしない', riskLabelAction({ pr: mk({ labels: ['risk/R2'], changes: [{ path: 'src/auth/login.js', status: 'modified' }] }), rules }) === null);

// 読み取りの整形(固定の応答)
let slurped = true;
const canned = (args) => {
  if (!args.includes('--slurp') || !args.includes('--paginate')) slurped = false;
  const p = args[args.length - 1];
  if (/pulls\?state=open/.test(p)) return JSON.stringify([[{ number: 7, draft: false, created_at: '2026-11-10T00:00:00Z', requested_reviewers: [{ login: 'rev1' }], requested_teams: [{ slug: 'core' }], labels: [{ name: 'risk/R2' }], head: { sha: 'h1' } }]]);
  if (/issues\/7\/events/.test(p)) return JSON.stringify([[{ event: 'review_requested', requested_reviewer: { login: 'rev1' }, created_at: '2026-11-16T00:00:00Z' }, { event: 'labeled', label: { name: 'risk/R2' }, actor: { login: 'github-actions[bot]' }, created_at: '2026-11-10T00:00:00Z' }], [{ event: 'ready_for_review', created_at: '2026-11-11T00:00:00Z' }]]);
  if (/pulls\/7\/files/.test(p)) return JSON.stringify([[{ filename: 'a.md', status: 'modified' }]]);
  if (/pulls\/7\/reviews/.test(p)) return '[[]]';
  if (/commits\/h1\/statuses/.test(p)) return JSON.stringify([[{ context: 'delegation-eligibility', state: 'success', description: '該当(G-6 を事後へ移す委任): 規則 r1。マージの実行: 有効' }]]);
  if (/issues\/7\/comments/.test(p)) return JSON.stringify([[{ body: 'x[a][b]', user: { login: 'github-actions[bot]' } }]]);
  throw new Error(`想定外: ${p}`);
};
const snap = fetchSnapshot((a) => canned(a), 'o/r');
check('読み取り: ページ連結の応答と事象を PR の記録へ整える', snap.length === 1 && snap[0].requests[0].login === 'rev1' && snap[0].readyAt === '2026-11-11T00:00:00Z' && snap[0].requestedTeams[0] === 'core' && snap[0].labels[0] === 'risk/R2' && snap[0].firstRequestAt === '2026-11-16T00:00:00Z' && snap[0].headSha === 'h1' && snap[0].machineRiskLabels[0] === 'risk/R2' && snap[0].requestedReviewers[0] === 'rev1' && snap[0].comments[0].body === 'x[a][b]' && snap[0].comments[0].login === 'github-actions[bot]', JSON.stringify(snap));
check('読み取り: --paginate --slurp で呼び、本文の中の ][ を壊さない', slurped);
check('読み取り: head のコミットの委任の判定のステータスが「該当」なら delegated を立てる', snap[0].delegated === true);
// 一次判定のラベルのジョブは、コミットのステータスを読む権限を持たない。その経路ではステータスを読まずに整える
const snapNoStatus = fetchSnapshot((a) => { if (a[a.length - 1].includes('/statuses')) throw new Error('ステータスを読んだ'); return canned(a); }, 'o/r', { statuses: false });
check('読み取り: ステータスを読まない指定では、コミットのステータスを呼ばずに PR の記録へ整える(delegated は立てない)', snapNoStatus.length === 1 && snapNoStatus[0].delegated === false && snapNoStatus[0].files[0] === 'a.md');
check('読み取り: 一次判定のラベルの経路(risk)は、ステータスを読まない指定で呼ぶ', fs.readFileSync(new URL('./review-queue.mjs', import.meta.url), 'utf8').includes("statuses: mode !== 'risk'"));

// 委任した PR(判定が該当)は、マージの経路を有効にしているときに限り、同時保有数から除く。催促からは除かない
const deleg = [1, 2, 3, 4].map((n) => mk({ number: n, createdAt: NOW, labels: ['risk/R3'], delegated: true, requests: [{ login: 'busy', at: `2026-11-18T0${n}:00:00Z` }] }));
check('同時保有: マージの経路が有効でない間は、委任の判定が該当でも同時保有に数える(人の承認を待つため。従来どおり)', queueActions({ ...base, loadLimit: 3, prs: deleg }).actions.some((x) => x.key === 'load:busy'));
check('同時保有: マージの経路が有効なら、該当の PR 4 件で同時保有の通知が出ない', !queueActions({ ...base, loadLimit: 3, prs: deleg, excludeDelegated: true }).actions.some((x) => x.key === 'load:busy'));
check('同時保有: 該当でない PR は、有効でも数える(3件の該当 + 該当でない 2 件ならば 2 件だけ)', (() => {
  const mixed = [...deleg.slice(0, 3), ...[5, 6, 7, 8].map((n) => mk({ number: n, createdAt: NOW, requests: [{ login: 'busy', at: `2026-11-18T0${n}:00:00Z` }] }))];
  const a = queueActions({ ...base, loadLimit: 3, prs: mixed, excludeDelegated: true }).actions.filter((x) => x.key === 'load:busy');
  return a.length === 1 && a[0].pr === 8;
})());
check('同時保有: 該当の PR は、有効でも応答の催促からは除かない', (() => {
  const one = [mk({ number: 9, createdAt: NOW, labels: ['risk/R3'], delegated: true, requests: [{ login: 'late', at: '2026-10-01T00:00:00Z' }] })];
  return queueActions({ ...base, loadLimit: 3, prs: one, excludeDelegated: true }).actions.some((x) => x.key.startsWith('nudge:late'));
})());
check('同時保有: 状態の文字列は check-delegation.mjs と同じ値', DELEGATION_STATUS_CONTEXT === 'delegation-eligibility' && fs.readFileSync(new URL('./check-delegation.mjs', import.meta.url), 'utf8').includes(DELEGATION_ELIGIBLE_PREFIX) && fs.readFileSync(new URL('./check-delegation.mjs', import.meta.url), 'utf8').includes(`'${DELEGATION_STATUS_CONTEXT}'`));

// 同時保有の上限の既定の読みは評価の日(now)に効く記録だけ当てる。未来の日付の記録は効かない
{
  const lim = (recordedAt) => ({ ...config, reviewQueue: { loadLimit: { history: [{ value: 3, recordedAt, decidedBy: '山田 太郎', reason: '試験' }] } } });
  const busy = (c) => queueActions({ ...base, config: c, prs: heavy }).actions.some((x) => x.key === 'load:busy');
  check('同時保有の上限: 評価の日より前の記録は効く', busy(lim('2026-11-01')));
  check('同時保有の上限: 評価の日より後(未来)の日付の記録は効かない', !busy(lim('2099-01-01')));
}
console.log(failures ? `\nレビューの滞留の試験: ${checks} 件のうち ${failures} 件が期待と一致しません` : `\nレビューの滞留の試験: ${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
