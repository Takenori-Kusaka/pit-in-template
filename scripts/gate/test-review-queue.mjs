// 営業日の関数とレビューの滞留の通知の試験(IMPL-0680・0681・0682・0979・0136・0212。process-compass #445)。
// 時計と TZ に依らない: now は固定の時刻を渡し、子プロセスで TZ=UTC と TZ=Asia/Tokyo の結果が同じことを確かめる。
//
//   node scripts/gate/test-review-queue.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addBusinessDays, businessDaysBetween, dayOf, isBusinessDay, parseHolidays, loadHolidays, HOLIDAYS_UNCOUNTED_NOTE } from './business-days.mjs';
import { queueActions, riskLabelAction, parseDeadlines, escalationTarget, seatLogin, fetchSnapshot, DEFAULT_DEADLINES } from './review-queue.mjs';
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
check('IMPL-0681:ok 同じ通知は2回出さない(印)', queueActions({ ...base, now: '2026-11-19T03:00:00Z', prs: [mk({ requests: rq, comments: [{ body: nudge.body }] })] }).actions.every((x) => x.key !== nudge.key));
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

// 0682(上限3)
const heavy = [1, 2, 3, 4].map((n) => mk({ number: n, createdAt: NOW, requests: [{ login: 'busy', at: `2026-11-18T0${n}:00:00Z` }] }));
const h = queueActions({ ...base, prs: heavy });
check('IMPL-0682:ng 4件目の指名で知らせる(指名は外さない)', h.actions.filter((x) => x.key === 'load:busy').length === 1 && h.actions.find((x) => x.key === 'load:busy').pr === 4);
check('IMPL-0682:ok 3件目までは出ない', !queueActions({ ...base, prs: heavy.slice(0, 3) }).actions.some((x) => x.key === 'load:busy'));
check('IMPL-0682:ok 上限は引数で変えられる', queueActions({ ...base, loadLimit: 2, prs: heavy.slice(0, 3) }).actions.some((x) => x.key === 'load:busy'));

// 0136
const prose = ['README.md', 'CLAUDE.md'];
check('IMPL-0136:前提 試験の PR のファイルは散文のファイルである', prose.every((f) => isProseDocument(f)));
check('IMPL-0136:ng 散文だけを変える PR の超過でも催促が出る(外すと落ちる)', queueActions({ ...base, now: '2026-11-19T03:00:00Z', prs: [mk({ files: prose, requests: rq })] }).actions.some((x) => /^nudge:/.test(x.key)));

// 0212
const rules = config.riskFloor.rules;
const ra = riskLabelAction({ pr: mk({ changes: [{ path: 'src/auth/login.js', status: 'modified' }] }), rules });
check('IMPL-0212:ng R1 規則に当たる PR に risk/R1 が付く', ra?.label === 'risk/R1');
check('IMPL-0212:ok 当たらなければ risk/R3', riskLabelAction({ pr: mk({ changes: [{ path: 'src/b.js', status: 'added' }] }), rules })?.label === 'risk/R3');
check('IMPL-0212:ok 既存の risk/* のラベルを上書きしない', riskLabelAction({ pr: mk({ labels: ['risk/R2'], changes: [{ path: 'src/auth/login.js', status: 'modified' }] }), rules }) === null);

// 読み取りの整形(固定の応答)
const canned = (args) => {
  const p = args[args.length - 1];
  if (/pulls\?state=open/.test(p)) return JSON.stringify([{ number: 7, draft: false, created_at: '2026-11-10T00:00:00Z', requested_reviewers: [{ login: 'rev1' }], requested_teams: [{ slug: 'core' }], labels: [{ name: 'risk/R2' }] }]);
  if (/issues\/7\/events/.test(p)) return JSON.stringify([{ event: 'review_requested', requested_reviewer: { login: 'rev1' }, created_at: '2026-11-16T00:00:00Z' }]) + JSON.stringify([{ event: 'ready_for_review', created_at: '2026-11-11T00:00:00Z' }]);
  if (/pulls\/7\/files/.test(p)) return JSON.stringify([{ filename: 'a.md', status: 'modified' }]);
  if (/pulls\/7\/reviews/.test(p)) return '[]';
  if (/issues\/7\/comments/.test(p)) return JSON.stringify([{ body: 'x' }]);
  throw new Error(`想定外: ${p}`);
};
const snap = fetchSnapshot((a) => canned(a), 'o/r');
check('読み取り: ページ連結の応答と事象を PR の記録へ整える', snap.length === 1 && snap[0].requests[0].login === 'rev1' && snap[0].readyAt === '2026-11-11T00:00:00Z' && snap[0].requestedTeams[0] === 'core' && snap[0].labels[0] === 'risk/R2', JSON.stringify(snap));

console.log(failures ? `\nレビューの滞留の試験: ${checks} 件のうち ${failures} 件が期待と一致しません` : `\nレビューの滞留の試験: ${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
