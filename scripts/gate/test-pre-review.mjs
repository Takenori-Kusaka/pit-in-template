// 事前レビュー期間の受付・起票・通知・集計の試験(IMPL-0571・0210・0213・0219・0215・0216。process-compass #325)
// 時計と TZ に依らない: now は固定の時刻を渡し、子プロセスで TZ=UTC と TZ=Asia/Tokyo の結果が同じことを確かめる。
//
//   node scripts/gate/test-pre-review.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseHolidays } from './business-days.mjs';
import { parseIssueForm, targetOf, riskOf, timelineOf, planNotify, parseOpinion, opinionGaps, publishedState, fetchIssues, applyActions, DRAFT_PREFIX, MARKER } from './pre-review.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 700)}`}`);
}

const d0Text = `
## 3. 決定の権限

| 決定の種類 | 決定(1名) | 同意 |
| --- | --- | --- |
| 体制と運用形態(責任者の任免) | 事業決裁者 | |

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
  seats: [{ role: 'biz-approver', accountable: 'p1' }],
};

const form = (o = {}) => {
  const f = { 種別: 'B-2', 工程ゲート: '', リスク区分: 'R3', '判定予定日 T': '2026-11-27', 起案者: '@alice', 指名レビュア: '@bob @carol', 判定資料の所在: '', ...o };
  return Object.entries(f)
    .map(([k, v]) => `### ${k}\n\n${v || '_No response_'}\n`)
    .join('\n');
};
let cid = 1000;
const cm = (login, body, at, o = {}) => ({ id: ++cid, login, body, at, userId: null, bot: false, ...o });
const issue = (o = {}) => ({ number: 5, state: 'open', title: '事前レビュー: x', labels: ['pre-review'], body: form(), comments: [], ...o });
const op = (stance = '賛成', reason = '妥当', alt = '') => `賛否: ${stance}\n理由: ${reason}\n代替案または充足条件: ${alt}`;
// 2026-11-16 は月曜。T=11-27(金)・R3: 公開 11-20、締切 11-25、締切の2営業日前 11-23、前営業日 11-24
const at = (d, t = '03:00:00') => `${d}T${t}Z`;
const plan = (o) => planNotify({ issues: [issue()], now: at('2026-11-24'), config, d0Text, ...o });
const kinds = (r) => r.actions.map((a) => `${a.kind}:${a.key}`);

// ---- 欄の読み・時点 ----
const pf = parseIssueForm(form());
check('Issue の様式: 欄を見出しごとに読み、_No response_ は空', pf['種別'] === 'B-2' && pf['工程ゲート'] === '' && pf['判定予定日 T'] === '2026-11-27');
check(
  'リスク区分と時点: R3 は T−5 公開・T−2 締切、R1 は T−10・T−5',
  JSON.stringify(timelineOf('2026-11-27', 'R3')) === JSON.stringify({ publishDay: '2026-11-20', deadlineDay: '2026-11-25', notice2Day: '2026-11-23', notice1Day: '2026-11-24', answerDay: '2026-11-26' }) &&
    timelineOf('2026-11-27', 'R1').publishDay === '2026-11-13' &&
    timelineOf('2026-11-27', 'R1').deadlineDay === '2026-11-20' &&
    riskOf({ リスク区分: 'R1' }) === 'R1' &&
    riskOf({ リスク区分: '?' }) === null,
);
const hol = parseHolidays('2026-11-23\n');
check('祝日を渡すと時点がずれる', timelineOf('2026-11-27', 'R3', hol.days).notice2Day === '2026-11-20');

// ---- 0571 対象の選び方 ----
check('IMPL-0571:ok B-2 を対象にする', targetOf({ 種別: 'B-2' }).target === 'proposal' && targetOf({ 種別: 'B-1' }).target === 'proposal' && targetOf({ 種別: 'B-4' }).target === 'proposal');
check('IMPL-0571:ok 工程ゲートは非同期コメント期間だけ(target=gate)', targetOf({ 種別: '工程ゲート' }).target === 'gate');
check('IMPL-0571:ng 標準変更を対象にしない', targetOf({ 種別: '標準変更(対象外)' }).target === null && /3\.7\.4/.test(targetOf({ 種別: '標準変更(対象外)' }).reason));
const sc = plan({ issues: [issue({ body: form({ 種別: '標準変更(対象外)' }) })], now: at('2026-11-24') });
check('IMPL-0571:ng 標準変更の Issue には起票も通知も出ない', sc.actions.length === 0 && sc.notes.some((n) => /標準変更/.test(n)));
check('IMPL-0571:ng 種別を読めない Issue は対象にしない', plan({ issues: [issue({ body: form({ 種別: 'B-9' }) })] }).actions.length === 0);
const gt = plan({ issues: [issue({ body: form({ 種別: '工程ゲート', 工程ゲート: 'G-3' }) })], now: at('2026-11-20') });
check('IMPL-0571:ok 工程ゲートも判定資料を起票する。起票と通知の他の行為(判定当日の手順)を持たない', gt.actions.some((a) => a.kind === 'create-issue') && gt.actions.every((a) => ['comment', 'create-issue', 'update-comment'].includes(a.kind)));

// ---- 0210 判定資料の起票 ----
const before = plan({ now: at('2026-11-19') });
check('IMPL-0210:ng T の5営業日前より前には起票しない', !kinds(before).some((k) => k.startsWith('create-issue')));
const mk = plan({ now: at('2026-11-20') });
const created = mk.actions.find((a) => a.kind === 'create-issue');
check('IMPL-0210:ok T−5 営業日に、草案の印つきで判定資料の Issue を起票する', Boolean(created) && created.title.startsWith(DRAFT_PREFIX) && created.labels.includes('pre-review-material'), JSON.stringify(kinds(mk)));
check('IMPL-0210:ok 3.10.3 の5項目の見出しを置き、中身は埋めない', created && [1, 2, 3, 4, 5].every((n) => created.body.includes(`## ${n}. `)) && (created.body.match(/\(起案者が記入する\)/g) ?? []).length === 5);
const r1 = (d) => plan({ issues: [issue({ body: form({ リスク区分: 'R1' }) })], now: at(d) });
check('IMPL-0210:ok R1 は T−10 営業日(2026-11-13)に起票する', r1('2026-11-13').actions.some((a) => a.kind === 'create-issue') && !r1('2026-11-12').actions.some((a) => a.kind === 'create-issue'));
const material = { number: 9, title: created.title, body: created.body };
check('IMPL-0210:ok 同じ資料があれば再び起票しない(冪等)', !kinds(plan({ now: at('2026-11-20'), materials: [material] })).some((k) => k.startsWith('create-issue')));
const p5 = { number: 5, fields: pf };
check(
  'IMPL-0210:ok 草案の印を起案者が外すまで「公開」に数えない',
  publishedState(p5, [material]).published === false && publishedState(p5, [{ ...material, title: material.title.replace(DRAFT_PREFIX, '') }]).published === true && publishedState(p5, []).published === false,
);
check('IMPL-0210:ok 判定資料の所在が書かれていれば公開に数える', publishedState({ number: 5, fields: { ...pf, 判定資料の所在: 'https://example.com/x' } }, []).published === true);

// ---- 0215 意見の様式 ----
check('意見の読み: 欄の値を見出しから次の見出しまで読む', JSON.stringify(parseOpinion('賛否: 反対\n理由: 遅い\n続き\n代替案または充足条件: 案X')) === JSON.stringify({ stance: '反対', reason: '遅い\n続き', alt: '案X' }) && parseOpinion('ただのコメント') === null);
check('意見の欄の空: 反対のときだけ代替案の空を数える', JSON.stringify(opinionGaps(parseOpinion('賛否: 賛成\n理由: 良い\n代替案または充足条件:'))) === '[]' && JSON.stringify(opinionGaps(parseOpinion('賛否: 反対\n理由: x\n代替案または充足条件:'))) === '["代替案または充足条件"]');
const bad = cm('carol', '賛否: 賛成\n理由:\n代替案または充足条件:', at('2026-11-21'));
const o1 = plan({ issues: [issue({ comments: [bad] })], now: at('2026-11-21') });
const note = o1.actions.find((a) => a.key === `opinion:${bad.id}`);
check('IMPL-0215:ng 理由が空の意見に、空の欄を示す注意が出る', Boolean(note) && /理由/.test(note.body) && /@carol/.test(note.body) && /1つの論点につき1つのスレッド/.test(note.body), note?.body);
check('IMPL-0215:ok 注意の喚起に限る(意見として扱うかを機械が決めないと書き、応答の対象から外さない)', /機械が決めません/.test(note.body) && !/無効|却下|除外/.test(note.body));
check('IMPL-0215:ok 欄が埋まっていれば注意は出ない', !kinds(plan({ issues: [issue({ comments: [cm('carol', op(), at('2026-11-21'))] })], now: at('2026-11-21') })).some((k) => /opinion:/.test(k)));
check('IMPL-0215:ok 同じ意見への注意は重ねて出さない', !plan({ issues: [issue({ comments: [bad, cm('github-actions', note.body, at('2026-11-21'), { bot: true })] })], now: at('2026-11-21') }).actions.some((a) => a.key === `opinion:${bad.id}`));

// ---- 読み取り・書き込みの差し替え ----
const canned = (args) => {
  const p = args[args.length - 1];
  if (/issues\?state=all&labels=pre-review/.test(p)) return JSON.stringify([{ number: 5, state: 'open', title: 't', body: form(), labels: [{ name: 'pre-review' }] }, { number: 6, pull_request: {} }]);
  if (/issues\/5\/comments/.test(p)) return JSON.stringify([{ id: 1, body: op(), user: { login: 'bob', id: 3, type: 'User' }, created_at: at('2026-11-22') }]);
  return '[]';
};
const fetched = fetchIssues(canned, 'o/r', { label: 'pre-review' });
check('読み取りの整形: PR を除き、コメントの投稿者・識別子・bot を持つ', fetched.length === 1 && fetched[0].comments[0].login === 'bob' && fetched[0].comments[0].bot === false && fetched[0].labels[0] === 'pre-review');
const calls = [];
const fakeGh = (args, { input } = {}) => {
  calls.push([args.join(' '), input]);
  return '';
};
applyActions(fakeGh, 'o/r', [
  { kind: 'comment', issue: 5, key: 'k', body: 'b' },
  { kind: 'create-issue', of: 5, key: 'm', title: 't', body: 'b', labels: ['x'] },
  { kind: 'update-comment', issue: 5, key: 'ledger', commentId: 7, body: 'u' },
]);
check('書き込み: コメントの投稿・資料の起票・一覧の更新の各 API', calls.length === 3 && /POST repos\/o\/r\/issues\/5\/comments/.test(calls[0][0]) && /POST repos\/o\/r\/issues --input/.test(calls[1][0]) && /PATCH repos\/o\/r\/issues\/comments\/7/.test(calls[2][0]), JSON.stringify(calls));
calls.length = 0;
applyActions(fakeGh, 'o/r', [{ kind: 'comment', issue: 5, key: 'k', body: 'b' }], { dry: true });
check('dry-run は書き込まない', calls.length === 0);
check('通知の印は固定の語を持つ', o1.actions[0].body.includes(`<!-- ${MARKER} `));

// ---- TZ に依らない ----
if (process.argv.includes('--emit')) {
  const r = plan({ issues: [issue({ comments: [bad] })], now: at('2026-11-20', '15:30:00') });
  console.log(JSON.stringify({ actions: r.actions, notes: r.notes }));
  process.exit(0);
}
const run = (tz) => execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--emit'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();
const [a, b] = [run('UTC'), run('Asia/Tokyo')];
check('TZ に依らない: TZ=UTC と TZ=Asia/Tokyo で同じ結果', a === b && a.length > 100, `${a.slice(0, 200)} / ${b.slice(0, 200)}`);

console.log(failures === 0 ? '\n事前レビューの試験: すべて期待どおり' : `\n事前レビューの試験: ${failures} 件が期待と違う`);
process.exit(failures === 0 ? 0 : 1);
