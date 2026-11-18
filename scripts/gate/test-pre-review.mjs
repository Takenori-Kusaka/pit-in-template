// 事前レビュー期間の受付・起票・通知・集計の試験(IMPL-0571・0210・0213・0219・0215・0216。process-compass #325)
// 時計と TZ に依らない: now は固定の時刻を渡し、子プロセスで TZ=UTC と TZ=Asia/Tokyo の結果が同じことを確かめる。
//
//   node scripts/gate/test-pre-review.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseHolidays } from './business-days.mjs';
import { parseIssueForm, targetOf, riskOf, timelineOf, planNotify, metricsFor, metricsBody, parseOpinion, opinionGaps, publishedState, fetchIssues, applyActions, readProposal, isMonth, previousMonth, DRAFT_PREFIX, MARKER, materialPrOf, prRefOf, fetchPrCreated, requiredOwners, publishedAtOf, withPublishedAt, fetchPrFiles } from './pre-review.mjs';

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
const issue = (o = {}) => ({ number: 5, state: 'open', title: '事前レビュー: x', labels: ['pre-review'], body: form(), comments: [], association: 'OWNER', ...o });
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
const gt = plan({ issues: [issue({ body: form({ 種別: '工程ゲート', 工程ゲート: 'G-3' }) })], now: at('2026-11-24') });
check('IMPL-0571:ok 工程ゲートは通知を出す。起票と通知の他の行為(判定当日の手順)を持たない', gt.actions.some((a) => a.key.startsWith('notice:n1')) && gt.actions.every((a) => ['comment', 'create-issue', 'update-comment'].includes(a.kind)));

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

// ---- 0213・0219 締切の通知 ----
const n2 = plan({ now: at('2026-11-23') });
check('IMPL-0213:ok 締切の2営業日前に通知を出す(記名)', kinds(n2).some((k) => k.startsWith('comment:notice:n2')) && /通知先: @bob @carol/.test(n2.actions.find((a) => a.key.startsWith('notice:n2')).body));
const n1 = plan({ now: at('2026-11-24') });
check('IMPL-0213:ng 前営業日に通知が出る(2営業日前の通知は遅れて出さない)', kinds(n1).some((k) => k.startsWith('comment:notice:n1')) && !kinds(n1).some((k) => k.startsWith('comment:notice:n2')));
check('IMPL-0213:ok 期間の外では出ない(締切の3営業日前)', !kinds(plan({ now: at('2026-11-20') })).some((k) => /notice/.test(k)));
const bobOp = cm('bob', op(), at('2026-11-22'));
const part = plan({ issues: [issue({ comments: [bobOp] })], now: at('2026-11-24') });
const n1body = part.actions.find((a) => a.key.startsWith('notice:n1')).body;
check('IMPL-0219:ng 通知の宛先は未応答の者に絞る(応答済みの bob は記名のみ・通知先に入れない)', /通知先: @carol\s*$/m.test(n1body) && /bob\(応答済み\)/.test(n1body) && !/通知先:.*@bob/.test(n1body), n1body);
check('IMPL-0219:ok 前営業日は D-0 節6 の判定する者(席 → 名簿 → login)へも知らせる', /@boss/.test(n1body));
check('IMPL-0219:ok 全員応答済みなら通知を出さない', !kinds(plan({ issues: [issue({ comments: [bobOp, cm('carol', op('反対', '懸念', '案X'), at('2026-11-22'))] })] })).some((k) => /notice|measure/.test(k)));
check('IMPL-0219:ok AI の担い手(bot)の意見は応答に数えない', /通知先: @bob @carol/.test(plan({ issues: [issue({ comments: [cm('bob', op(), at('2026-11-22'), { bot: true })] })] }).actions.find((a) => a.key.startsWith('notice:n1')).body));
check('IMPL-0219:ok 賛否の欄が空のコメントは応答に数えない', /通知先: @bob @carol/.test(plan({ issues: [issue({ comments: [cm('bob', '賛否:\n理由: x', at('2026-11-22'))] })] }).actions.find((a) => a.key.startsWith('notice:n1')).body));
const late = plan({ issues: [issue({ comments: [bobOp] })], now: at('2026-11-26') });
const meas = late.actions.find((a) => a.key.startsWith('measure'));
check('IMPL-0219:ng 締切を過ぎて未応答が残れば、3.9.3 の措置の宛先へ通知する', Boolean(meas) && /@boss/.test(meas.body) && /通知先: @carol/.test(meas.body) && /3\.9\.3/.test(meas.body), meas?.body);
check('IMPL-0219:ok 措置は人が行う旨を書く(代理の指名・自動の再割り当てをしない)', /指名は人が行います/.test(meas.body));
check('IMPL-0219:ok R1 は判定へ進めない旨を出す', /進めません/.test(plan({ issues: [issue({ body: form({ リスク区分: 'R1' }) })], now: at('2026-11-23') }).actions.find((a) => a.key.startsWith('measure')).body));
check(
  'IMPL-0219:ok 宛先を解決できなければ記名なしで知らせ、注意に書く',
  (() => {
    const r = plan({ now: at('2026-11-24'), config: { ...config, seats: [] } });
    return r.actions.some((a) => a.key.startsWith('notice:n1')) && r.notes.some((n) => /宛先を解決できない/.test(n));
  })(),
);

// 冪等: 出した通知を取り込んで再実行すると、同じ通知を重ねて出さない
const absorb = (iss, r, t) => ({ ...iss, comments: [...iss.comments, ...r.actions.filter((a) => a.kind === 'comment').map((a) => cm('github-actions[bot]', a.body, t, { bot: true }))] });
const round1 = absorb(issue(), n1, at('2026-11-24'));
const mat1 = [{ number: 9, title: created.title, body: created.body }];
// 一覧は通知の時刻を取り込むため、1回目の後に1度更新される。更新を取り込んだ後は何も出ない
const r2 = plan({ issues: [round1], materials: mat1, now: at('2026-11-24', '09:00:00') });
const round2 = { ...round1, comments: round1.comments.map((c) => { const u = r2.actions.find((a) => a.kind === 'update-comment' && a.commentId === c.id); return u ? { ...c, body: u.body } : c; }) };
const again = plan({ issues: [round2], materials: mat1, now: at('2026-11-24', '11:00:00') });
check('通知は冪等: 同じ印の通知があれば重ねて出さない(一覧は内容が同じなら更新しない)', !r2.actions.some((a) => a.kind === 'comment' && /notice/.test(a.key)) && again.actions.length === 0, kinds(r2).join() + ' / ' + kinds(again).join());

// ---- 0213 一覧 ----
const noticeComment = cm('github-actions[bot]', n1body, at('2026-11-24', '01:00:00'), { bot: true });
const ledgerRun = plan({ issues: [issue({ comments: [noticeComment, bobOp] })], now: at('2026-11-24', '05:00:00') });
const ledger = ledgerRun.actions.find((a) => a.key === 'ledger');
check('IMPL-0213:ok 一覧に、通知を受けた時刻と最初の応答の時刻を残す', Boolean(ledger) && /\| carol \| 2026-11-24T01:00:00Z \| \(応答なし\) \|/.test(ledger.body) && /\| bob \| \(通知なし\) \| 2026-11-22T03:00:00Z \|/.test(ledger.body), ledger?.body);
check('IMPL-0213:ok 一覧は個人の評価に使わない旨を書く', /個人の評価に使いません/.test(ledger.body));
const ledgerComment = cm('github-actions[bot]', ledger.body, at('2026-11-24', '05:00:00'), { bot: true });
const upd = plan({ issues: [issue({ comments: [noticeComment, bobOp, ledgerComment, cm('carol', op(), at('2026-11-24', '06:00:00'))] })], now: at('2026-11-24', '07:00:00') });
check('IMPL-0213:ok 応答が付いたら一覧のコメントを更新する(新しいコメントを重ねない)', upd.actions.some((a) => a.kind === 'update-comment' && a.commentId === ledgerComment.id && /\| carol \| 2026-11-24T01:00:00Z \| 2026-11-24T06:00:00Z \|/.test(a.body)), JSON.stringify(kinds(upd)));
check('IMPL-0213:ok 時刻だけが違う再実行では一覧を更新しない', !plan({ issues: [issue({ comments: [noticeComment, bobOp, ledgerComment] })], now: at('2026-11-24', '09:00:00') }).actions.some((a) => a.key === 'ledger'));

// ---- 0215 意見の様式 ----
check('意見の読み: 欄の値を見出しから次の見出しまで読む', JSON.stringify(parseOpinion('賛否: 反対\n理由: 遅い\n続き\n代替案または充足条件: 案X')) === JSON.stringify({ stance: '反対', reason: '遅い\n続き', alt: '案X' }) && parseOpinion('ただのコメント') === null);
check('意見の欄の空: 反対のときだけ代替案の空を数える', JSON.stringify(opinionGaps(parseOpinion('賛否: 賛成\n理由: 良い\n代替案または充足条件:'))) === '[]' && JSON.stringify(opinionGaps(parseOpinion('賛否: 反対\n理由: x\n代替案または充足条件:'))) === '["代替案または充足条件"]');
const bad = cm('carol', '賛否: 賛成\n理由:\n代替案または充足条件:', at('2026-11-21'));
const o1 = plan({ issues: [issue({ comments: [bad] })], now: at('2026-11-21') });
const note = o1.actions.find((a) => a.key === `opinion:${bad.id}`);
check('IMPL-0215:ng 理由が空の意見に、空の欄を示す注意が出る', Boolean(note) && /理由/.test(note.body) && /@carol/.test(note.body) && /1つの論点につき1つのスレッド/.test(note.body), note?.body);
check('IMPL-0215:ok 注意の喚起に限る(意見として扱うかを機械が決めないと書き、応答の対象から外さない)', /機械が決めません/.test(note.body) && !/無効|却下|除外/.test(note.body));
check('IMPL-0215:ok 欄が埋まっていれば注意は出ない', !kinds(plan({ issues: [issue({ comments: [cm('carol', op(), at('2026-11-21'))] })], now: at('2026-11-21') })).some((k) => /opinion:/.test(k)));
check('IMPL-0215:ok 同じ意見への注意は重ねて出さない', !plan({ issues: [issue({ comments: [bad, cm('github-actions[bot]', note.body, at('2026-11-21'), { bot: true })] })], now: at('2026-11-21') }).actions.some((a) => a.key === `opinion:${bad.id}`));

// ---- 0216 月次の集計 ----
const op1 = cm('bob', op(), at('2026-11-21'));
const op2 = cm('carol', op('反対', '懸念', '案X'), at('2026-11-22'));
const reply = cm('alice', `応答: https://github.com/o/r/issues/5#issuecomment-${op1.id}\n採用します`, at('2026-11-23'));
const aiOp = cm('claude-bot', op('反対', 'x', 'y'), at('2026-11-22'), { bot: true });
const i5 = issue({ comments: [op1, op2, reply, aiOp] });
const i6 = issue({ number: 6, body: form({ '判定予定日 T': '2026-11-30', 指名レビュア: '@bob' }) });
const i7 = issue({ number: 7, body: form({ '判定予定日 T': '2026-12-10' }) });
const i8 = issue({ number: 8, body: form({ 種別: '標準変更(対象外)' }) });
const m = metricsFor({ issues: [i5, i6, i7, i8], month: '2026-11', config });
check('IMPL-0216:ng 応答の無い意見が比率に入る(応答の宣言行が結ぶ意見は入らない)', m.unansweredOpinionRatio.startsWith('50%') && m.unansweredOpinionRatio.includes('1/2'), JSON.stringify(m));
check('IMPL-0216:ok AI の担い手のコメントを分子にも分母にも数えない', m.unansweredOpinionRatio.includes('/2') && m.reviewerResponseRatio.includes('2/3'), JSON.stringify(m));
check('IMPL-0216:ok 月と対象の絞り込み: T が別の月の上程・標準変更を数えない', m.proposals === 2 && m.noOpinionRatio.startsWith('50%'), JSON.stringify(m));
const body = metricsBody(m);
check('IMPL-0216:ok 個人別の値を出さない(ログイン名が本文に無い)・個人の評価に使わない旨を書く', !/bob|carol|alice/.test(body) && /個人の評価指標にしません/.test(body));
check('IMPL-0216:ok 対象が無い月は算定できないと出す(0 で割らない)', metricsFor({ issues: [], month: '2026-10', config }).unansweredOpinionRatio.includes('算定できない'));
check('IMPL-0216:ok 応答の宣言行は起案者のコメントだけが結ぶ', metricsFor({ issues: [issue({ comments: [op1, cm('bob', `応答: https://github.com/o/r/issues/5#issuecomment-${op1.id}`, at('2026-11-23'))] })], month: '2026-11', config }).unansweredOpinionRatio.startsWith('100%'));

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
check('通知の印は固定の語を持つ', n1.actions[0].body.includes(`<!-- ${MARKER} `));

// ---- 突合 1巡目の直し(単位11・12) ----
check('IMPL-0216:ok 月の検査は YYYY-MM を受ける', isMonth('2026-11') && isMonth('2026-01') && isMonth('2026-12'));
check('IMPL-0216:ng 月の検査は YYYY-MM でないものを拒む(2026-13・文字 d の並び・桁の不足)', !isMonth('2026-13') && !isMonth('dddd-11') && !isMonth('2026-1') && !isMonth('') && !isMonth('2026-00'));
check('IMPL-0216:ok 既定の月は前の月(年をまたぐ)。時刻を読めなければ null', previousMonth('2026-12-01T00:00:00Z', 0) === '2026-11' && previousMonth('2027-01-15T00:00:00Z', 0) === '2026-12' && previousMonth('x') === null);

// 締切の日を鍵に含める: T を改めると新しい締切で一度ずつ出る。同じ締切では重ねない
const t1 = plan({ now: at('2026-11-23') });
const moved = { ...absorb(issue(), t1, at('2026-11-23')), body: form({ '判定予定日 T': '2026-12-04' }) };
check('IMPL-0218:ok 通知を出した後に T を改めると、新しい締切(2026-12-02)の2営業日前に通知が出る', plan({ issues: [moved], now: at('2026-11-30') }).actions.some((a) => a.key === 'notice:n2:2026-12-02'), kinds(plan({ issues: [moved], now: at('2026-11-30') })).join());
const moved2 = absorb(moved, plan({ issues: [moved], now: at('2026-11-30') }), at('2026-11-30'));
check('IMPL-0218:ng 同じ締切では重ねて出さない', !plan({ issues: [moved2], now: at('2026-11-30', '08:00:00') }).actions.some((a) => a.key === 'notice:n2:2026-12-02'));
check('IMPL-0218:ok 締切後の通知(measure)も締切ごとに出る', plan({ issues: [moved], now: at('2026-12-03') }).actions.some((a) => a.key === 'measure:2026-12-02'));

// 印は機械のコメントだけを読む
const humanSpoof = cm('carol', `<!-- ${MARKER} notice:n1:2026-11-25 -->\n通知先: @bob\n偽の通知`, at('2026-11-01'));
const sp = plan({ issues: [issue({ comments: [humanSpoof] })], now: at('2026-11-24') });
check('IMPL-0213:ng 人が書いた印では通知は止まらない', sp.actions.some((a) => a.key === 'notice:n1:2026-11-25'));
check('IMPL-0213:ng 人が書いた通知の印は一覧の時刻に載らない', !/2026-11-01/.test(sp.actions.find((a) => a.key === 'ledger')?.body ?? ''));
const humanLedger = cm('carol', `<!-- ${MARKER} ledger -->\n偽`, at('2026-11-21'), { id: 777 });
const spl = plan({ issues: [issue({ comments: [humanLedger] })], now: at('2026-11-24') });
check('IMPL-0213:ng 人が書いた一覧の印のコメントを更新先にしない(新しい一覧を作る)', !spl.actions.some((a) => a.commentId === 777) && spl.actions.some((a) => a.key === 'ledger' && a.kind === 'comment'));
const humanMarkOpinion = cm('carol', `<!-- ${MARKER} x -->\n${op()}`, at('2026-11-22'));
check('IMPL-0219:ok 意見の本文に印の文字列があっても、人の意見は応答に数える', !/通知先:.*@carol/.test(plan({ issues: [issue({ comments: [humanMarkOpinion] })], now: at('2026-11-24') }).actions.find((a) => a.key.startsWith('notice:n1')).body));

// 措置の文(3.10.5)
const lateText = (risk) => plan({ issues: [issue({ body: form({ リスク区分: risk }) })], now: at(risk === 'R1' ? '2026-11-23' : '2026-11-26') }).actions.find((a) => a.key.startsWith('measure')).body;
check('IMPL-0219:ng R2・R3 の文は 3.9.3 の措置を求めず、異議なしとして進む旨と必須応答ロールの判断を書く', /異議なしとして判定へ進めます/.test(lateText('R3')) && /必須応答ロール/.test(lateText('R3')) && !/お願いします/.test(lateText('R3')) && !/お願いします/.test(lateText('R2')));
check('IMPL-0219:ok R1 は判定へ進めない旨と措置の依頼を書く', /進めません/.test(lateText('R1')) && /お願いします/.test(lateText('R1')));

// 欄の読み
const noAt = plan({ issues: [issue({ body: form({ 起案者: 'alice' }) })] });
check('起案者の欄に @ が無いときは注意に出し、起票も通知もしない', noAt.actions.length === 0 && noAt.notes.some((n) => /起案者を読めない/.test(n)));
const ext = (assoc) => plan({ issues: [issue({ association: assoc })], now: at('2026-11-24') });
check('起票者の関係が OWNER・MEMBER・COLLABORATOR 以外なら対象にせず、注意に出す', ext('NONE').actions.length === 0 && ext('FIRST_TIME_CONTRIBUTOR').notes.some((n) => /COLLABORATOR/.test(n)) && ext('COLLABORATOR').actions.length > 0 && ext('MEMBER').actions.length > 0);
check('外部の起票は月次の集計にも数えない', metricsFor({ issues: [issue({ association: 'NONE' })], month: '2026-11', config }).proposals === 0 && metricsFor({ issues: [issue()], month: '2026-11', config }).proposals === 1);
check('工程ゲートの欄が G-1〜G-8 でなければ対象にせず注意に出す', plan({ issues: [issue({ body: form({ 種別: '工程ゲート', 工程ゲート: 'G-99' }) })] }).notes.some((n) => /工程ゲートの欄/.test(n)) && plan({ issues: [issue({ body: form({ 種別: '工程ゲート', 工程ゲート: 'G-5' }) })], now: at('2026-11-24') }).actions.length > 0);
const sat = plan({ issues: [issue({ body: form({ '判定予定日 T': '2026-11-28' }) })], now: at('2026-11-24') });
check('T が営業日でないときは注意に出す(通知は止めない)', sat.notes.some((n) => /営業日ではない/.test(n)));
const rp = readProposal(issue({ body: form({ 指名レビュア: '@bob bob@example.com @org/team @carol-x' }) }), { config });
const rpBad = readProposal(issue({ body: form({ 指名レビュア: '@bob_x @bob/ @carol' }) }), { config });
check('login として成り立たない綴り(bob_x)は読まず、注意に出す', JSON.stringify(rpBad.reviewers) === '["carol"]' && rpBad.cautions.some((c) => /@bob_x/.test(c)), JSON.stringify(rpBad.reviewers));
check('記名は電子メールのドメイン・チーム名を login に数えない', JSON.stringify(rp.reviewers) === '["bob","carol-x"]', JSON.stringify(rp.reviewers));

// 判定資料の探索・一覧に締切後の通知を載せる
const noMark = { number: 9, title: `${DRAFT_PREFIX}判定資料: #5`, body: '先頭の印を消した本文' };
check('IMPL-0210:ok 本文の印を消されても、題名の「判定資料: #N」で見つけて再び起票しない', !kinds(plan({ now: at('2026-11-20'), materials: [noMark] })).some((k) => k.startsWith('create-issue')) && !kinds(plan({ issues: [issue({ number: 55 })], now: at('2026-11-20'), materials: [noMark] })).every((k) => !k.startsWith('create-issue')));
const measComment = cm('github-actions[bot]', late.actions.find((a) => a.key.startsWith('measure')).body, at('2026-11-26', '01:00:00'), { bot: true });
const lr = plan({ issues: [issue({ comments: [bobOp, measComment] })], now: at('2026-11-26', '05:00:00') }).actions.find((a) => a.key === 'ledger');
check('IMPL-0213:ok 一覧に締切後の通知(measure)の時刻も載せる', /\| carol \| 2026-11-26T01:00:00Z \|/.test(lr?.body ?? ''), lr?.body);

// ページ送り(--slurp)で本文が壊れない
const slurped = (args) => {
  const p = args[args.length - 1];
  if (!args.includes('--slurp')) return '[[BROKEN]]';
  if (/issues\?state=all&labels=pre-review/.test(p)) return JSON.stringify([[{ number: 5, state: 'open', title: 't', body: '案 [A] [B]', labels: [], author_association: 'OWNER' }], [{ number: 7, state: 'open', title: 't', body: 'x', labels: [] }]]);
  return JSON.stringify([[{ id: 1, body: '[a] [b]', user: { login: 'bob', id: 3, type: 'User' }, created_at: at('2026-11-22') }], []]);
};
const sf = fetchIssues(slurped, 'o/r', { label: 'pre-review' });
check('ページ送りは --slurp で平らにし、本文の「] [」を壊さない。起票者の関係を読む', sf.length === 2 && sf[0].body === '案 [A] [B]' && sf[0].comments[0].body === '[a] [b]' && sf[0].association === 'OWNER' && sf[1].association === '');

// ---- 0217 必須応答(CODEOWNERS から導出。検出と記載・通知だけ) ----
const PR_URL = 'https://github.com/o/r/pull/77';
const coText = '* @boss\n/src/ @bob @dave\ndocs/ @carol @org/team\n';
const withPr = (o = {}) => issue({ body: form({ 判定資料の所在: PR_URL, ...(o.fields ?? {}) }), comments: o.comments ?? [] });
const reqPlan = (o = {}) => plan({ issues: [withPr(o)], now: at('2026-11-23'), prFiles: { 77: ['src/a.ts', 'docs/x.md'] }, codeownersText: coText, ...o.plan });
check('判定資料の所在から PR の番号を読む(URL と PR #N。PR でなければ null)', materialPrOf(PR_URL) === 77 && materialPrOf('PR #12 の本文') === 12 && materialPrOf('https://example.com/x') === null && materialPrOf('') === null);
const own = requiredOwners(coText, ['src/a.ts', 'docs/x.md', 'README.md', 'other/y.txt']);
check('IMPL-0217:ok 変更ファイルごとに最後に当たった行の所有者を使う(チームは個人に解決しない)', JSON.stringify(own.logins) === JSON.stringify(['bob', 'dave', 'carol', 'boss']) && JSON.stringify(own.teams) === JSON.stringify(['@org/team']) && own.unowned.length === 0, JSON.stringify(own));
check('IMPL-0217:ok どの行にも当たらないファイルは unowned に出す', JSON.stringify(requiredOwners('docs/ @carol\n', ['src/a.ts']).unowned) === JSON.stringify(['src/a.ts']));
const rq = reqPlan();
const rqBody = rq.actions.find((a) => a.key.startsWith('required:'))?.body ?? '';
check('IMPL-0217:ng CODEOWNERS の所有者が指名レビュアに無ければ、必須応答として記載し、含まれない者を示す', /必須応答/.test(rqBody) && /@bob @dave @carol/.test(rqBody) && /指名レビュアに含まれていません: @dave。/.test(rqBody) && /通知先: @dave$/m.test(rqBody), rqBody);
check('IMPL-0217:ok 条文は有効で、機械が止めないのは強制の機械化が未決のためだと書く(条文の要求を未決と読ませない)', /3\.10\.9 は、必須応答の者の記名の応答が揃うまで判定へ進めないと定めています/.test(rqBody) && /機械はこれを止めません\(止める強制の機械化は未決\)/.test(rqBody) && !/扱いは、機械では決めていません/.test(rqBody) && /PR 上のレビューは読みません/.test(rqBody));
check('IMPL-0217:ok 判定資料への転記は起案者が行い、機械の記載は上程の Issue に置くと書く', /判定資料\(3\.10\.3\)への転記は起案者が行います/.test(rqBody) && /判定資料の本文は編集しません/.test(rqBody));
const allNom = reqPlan({ fields: { 指名レビュア: '@bob @carol @dave @boss' } });
check('IMPL-0217:ok 全員が指名レビュアに含まれていれば、含まれない者を示さない', (() => { const b = allNom.actions.find((a) => a.key.startsWith('required:')).body; return /全員が指名レビュアに含まれています/.test(b) && /通知先:\s*$/m.test(b); })());
check('IMPL-0217:ok 起案者本人は必須応答に数えない', !/@alice/.test(reqPlan({ plan: { codeownersText: '* @alice @bob\n' } }).actions.find((a) => a.key.startsWith('required:')).body.split('\n')[0].split(':').slice(1).join(':')));
check('IMPL-0217:ok 判定資料の所在が PR でなければ導出しない', !kinds(plan({ issues: [issue({ body: form({ 判定資料の所在: 'https://example.com/x' }) })], now: at('2026-11-23'), codeownersText: coText })).some((k) => k.includes('required')));
check('IMPL-0217:ok 変更ファイルを読めなければ導出せず、注意に書く', reqPlan({ plan: { prFiles: { 77: null } } }).notes.some((n) => /変更ファイルを読めない/.test(n)) && !kinds(reqPlan({ plan: { prFiles: { 77: null } } })).some((k) => k.includes('required:')));
check('IMPL-0217:ok CODEOWNERS が無ければ導出せず、注意に書く', reqPlan({ plan: { codeownersText: null } }).notes.some((n) => /CODEOWNERS が既定ブランチに無い/.test(n)));
check('IMPL-0217:ok チームだけの所有者は注意に出す', rq.notes.some((n) => /@org\/team/.test(n)));
const rqAbsorbed = withPr({ comments: [cm('github-actions[bot]', rqBody, at('2026-11-23'), { bot: true })] });
check('IMPL-0217:ok 同じ必須応答の記載は重ねて出さない(冪等)', !kinds(plan({ issues: [rqAbsorbed], now: at('2026-11-24'), prFiles: { 77: ['src/a.ts', 'docs/x.md'] }, codeownersText: coText })).some((k) => k.includes('required:')));
const missPlan = (comments) => plan({ issues: [withPr({ comments, fields: { 指名レビュア: '@bob @carol @dave @boss' } })], now: at('2026-11-26'), prFiles: { 77: ['src/a.ts', 'docs/x.md'] }, codeownersText: coText });
const miss = missPlan([cm('bob', op(), at('2026-11-22'))]).actions.find((a) => a.key.startsWith('required-miss'));
check('IMPL-0217:ng 締切で記名の応答が無い必須の者(dave・carol)を、0219 の宛先(節6 の判定する者 @boss)へ通知する', Boolean(miss) && /^@boss /.test(miss.body.split('\n')[1]) && /無い必須応答の者がいます: @dave @carol/.test(miss.body) && !/通知先:.*@bob/.test(miss.body), miss?.body);
check('IMPL-0217:ng 通知は判定を止めない旨を書く(条文は有効・機械化は未決)', /機械はこれを止めません\(止める強制の機械化は未決\)/.test(miss?.body ?? '') && /定めていますが/.test(miss?.body ?? '') && !/この通知は判定を止めません/.test(miss?.body ?? ''));
check('IMPL-0217:ok 全員が記名で応答していれば通知しない', !missPlan(['bob', 'carol', 'dave', 'boss'].map((l) => cm(l, op(), at('2026-11-22')))).actions.some((a) => a.key.startsWith('required-miss')));
check('IMPL-0217:ok 締切の前には通知しない', !plan({ issues: [withPr()], now: at('2026-11-24'), prFiles: { 77: ['src/a.ts'] }, codeownersText: coText }).actions.some((a) => a.key.startsWith('required-miss')));
check('IMPL-0217:ok AI の名義(bot)の所有者は必須応答に数えない', !/ci-bot/.test(reqPlan({ plan: { codeownersText: '* @ci-bot @bob\n' } }).actions.find((a) => a.key.startsWith('required:')).body.split('\n')[0]));

// ---- 0830(共通の部分) 行の無い短縮は通知する。行のある短縮の当否と下限は未決 ----
const ledgerHead = '| ID | 区分 | 対象 | 内容 | 受容した理由 | 返却の目安 | 状態 | 承認した者 | 記録者 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
const ftRow = (target) => `| D-001 | 例外 | ${target} | ファストトラック(短縮: G-6)。事前レビューの短縮 | 期日 | 2026-12-01 | 未返却 | 山田 太郎 | 鈴木 一郎 |\n`;
const pubTitle = '判定資料: #5';
const published = (day) => [{ number: 9, title: pubTitle, body: '', publishedAt: at(day, '01:00:00') }];
const shortPlan = (o = {}) => plan({ issues: [o.issue ?? issue()], materials: o.materials ?? published('2026-11-24'), now: at('2026-11-25'), ledgerText: ledgerHead, ...o.plan });
const sh = shortPlan().actions.find((a) => a.key.startsWith('shortened'));
check('IMPL-0830:ng 公開が T−3 の営業日(期日 T−5 より遅い)で、台帳に行が無ければ、起案者と節6 の宛先へ通知する', Boolean(sh) && /@alice/.test(sh.body) && /@boss/.test(sh.body) && /3\.10\.2/.test(sh.body) && sh.key === 'shortened:2026-11-20', sh?.body);
check('IMPL-0830:ng 通知は可否を決めず、人が決める旨を書く', /機械が決めません/.test(sh?.body ?? ''));
check('IMPL-0830:ok 期間どおり(公開が T−5 の営業日以前)なら通知しない', !shortPlan({ materials: published('2026-11-20') }).actions.some((a) => a.key.startsWith('shortened')) && !shortPlan({ materials: published('2026-11-19') }).actions.some((a) => a.key.startsWith('shortened')));
const ftPlan = shortPlan({ plan: { ledgerText: ledgerHead + ftRow('PR #5') } });
check('IMPL-0830:ok 対象を当該の Issue とするファストトラックの行があれば、通知せず「経路と下限は未決」と出す', !ftPlan.actions.some((a) => a.key.startsWith('shortened')) && ftPlan.notes.some((n) => /ファストトラックの行あり\(D-001\)/.test(n) && /短縮の経路と下限は未決\(EV-0281\)/.test(n) && /通知しない・合格ともしない/.test(n)), JSON.stringify(ftPlan.notes));
check('IMPL-0830:ok 対象を判定資料の PR とする行も当たる', shortPlan({ issue: withPr(), plan: { ledgerText: ledgerHead + ftRow('PR #77') } }).notes.some((n) => /D-001/.test(n)));
check('IMPL-0830:ng 別の対象の行・印の無い行は当たらず、通知する', shortPlan({ plan: { ledgerText: ledgerHead + ftRow('PR #99') } }).actions.some((a) => a.key.startsWith('shortened')) && shortPlan({ plan: { ledgerText: ledgerHead + ftRow('PR #5').replace('ファストトラック(短縮: G-6)。', '') } }).actions.some((a) => a.key.startsWith('shortened')));
check('IMPL-0830:ng 草案の印のまま期日(T−5)を過ぎれば、短縮として通知する。期日の当日は通知しない', plan({ issues: [issue()], materials: [{ number: 9, title: `${DRAFT_PREFIX}判定資料: #5`, body: '' }], now: at('2026-11-23'), ledgerText: ledgerHead }).actions.some((a) => a.key.startsWith('shortened')) && !plan({ issues: [issue()], materials: [{ number: 9, title: `${DRAFT_PREFIX}判定資料: #5`, body: '' }], now: at('2026-11-20'), ledgerText: ledgerHead }).actions.some((a) => a.key.startsWith('shortened')));
check('IMPL-0830:ok 台帳を読めないときは行が無いものとして通知し、読めない旨を書く', /docs\/debt-ledger\.md を読めません/.test(shortPlan({ plan: { ledgerText: null } }).actions.find((a) => a.key.startsWith('shortened')).body));
const shR1 = plan({ issues: [issue({ body: form({ リスク区分: 'R1' }) })], materials: published('2026-11-16'), now: at('2026-11-17'), ledgerText: ledgerHead }).actions.find((a) => a.key.startsWith('shortened'));
check('IMPL-0830:ng R1 は T−10 営業日(2026-11-13)が期日', Boolean(shR1) && shR1.key === 'shortened:2026-11-13' && /10営業日前/.test(shR1.body));
check('IMPL-0830:ok 同じ短縮の通知は重ねて出さない(冪等)', !shortPlan({ issue: issue({ comments: [cm('github-actions[bot]', sh.body, at('2026-11-25'), { bot: true })] }) }).actions.some((a) => a.key.startsWith('shortened')));
check('公開の時刻: 草案の印を外した題名の改めの履歴から読む', publishedAtOf([{ event: 'renamed', created_at: '2026-11-20T01:00:00Z', rename: { from: '[草案] 判定資料: #5', to: '判定資料: #5' } }]) === '2026-11-20T01:00:00Z' && publishedAtOf([{ event: 'labeled', created_at: '2026-11-20T01:00:00Z' }]) === null);
const eventsGh = (args) => (/issues\/9\/events/.test(args.join(' ')) ? JSON.stringify([[{ event: 'renamed', created_at: '2026-11-24T01:00:00Z', rename: { from: '[草案] 判定資料: #5', to: '判定資料: #5' } }]]) : '[[]]');
const wp = withPublishedAt(eventsGh, 'o/r', [{ number: 9, title: '判定資料: #5', body: '' }, { number: 10, title: '[草案] 判定資料: #6', body: '' }]);
check('公開の時刻を足す(草案のままの資料には足さない)', wp[0].publishedAt === '2026-11-24T01:00:00Z' && wp[1].publishedAt === undefined);
const prGh = (args) => JSON.stringify([[{ filename: 'src/a.ts' }, { filename: 'docs/b.md', previous_filename: 'docs/a.md' }]]);
check('変更ファイルの読み取り: 改名前のパスも含める。読めなければ null', JSON.stringify(fetchPrFiles(prGh, 'o/r', 77)) === JSON.stringify(['src/a.ts', 'docs/b.md', 'docs/a.md']) && fetchPrFiles(() => { throw new Error('404'); }, 'o/r', 77) === null);
const ghCalls = [];
fetchPrFiles((args) => { ghCalls.push(args.join(' ')); return '[[]]'; }, 'o/r', 77);
check('変更ファイルの読み取りは読み取りの API だけ', ghCalls.length === 1 && /repos\/o\/r\/pulls\/77\/files/.test(ghCalls[0]) && !/-X/.test(ghCalls[0]));

// ---- 突合 1巡目の直し ----
check('M-3 別のリポジトリの PR の URL は、このリポジトリの同じ番号と読まない(repo を渡したとき)', materialPrOf('https://github.com/other/repo/pull/77', 'o/r') === null && materialPrOf('https://github.com/O/R/pull/77', 'o/r') === 77 && materialPrOf('PR #5', 'o/r') === 5 && prRefOf('https://github.com/other/repo/pull/77', 'o/r').foreign === 'https://github.com/other/repo/pull/77');
check('M-3b スキームの無い別のリポジトリの URL も読まない。同じリポジトリのものは読む', materialPrOf('github.com/other/repo/pull/77', 'o/r') === null && prRefOf('github.com/other/repo/pull/77', 'o/r').foreign === 'github.com/other/repo/pull/77' && materialPrOf('github.com/o/r/pull/77', 'o/r') === 77 && materialPrOf('[x](https://github.com/other/repo/pull/77)', 'o/r') === null && materialPrOf('<https://github.com/o/r/pull/9>', 'o/r') === 9 && materialPrOf('/pull/12', 'o/r') === 12);
{
  const fp = plan({ issues: [withPr({ fields: { 判定資料の所在: 'https://github.com/other/repo/pull/77' } })], now: at('2026-11-23'), prFiles: { 77: ['src/a.ts'] }, codeownersText: coText, repo: 'o/r' });
  check('M-3 別のリポジトリの PR は必須応答を導出せず、注意に出す', !fp.actions.some((a) => a.key.startsWith('required')) && fp.notes.some((n) => /別のリポジトリの PR/.test(n)), JSON.stringify(fp.notes));
}
const ow2 = requiredOwners('* dev@example.com @bob\n', ['a.ts']);
check('L-1 電子メールの所有者は個人に解決できないと注意に出す', JSON.stringify(ow2.emails) === JSON.stringify(['dev@example.com']) && JSON.stringify(ow2.logins) === JSON.stringify(['bob']) && plan({ issues: [withPr()], now: at('2026-11-23'), prFiles: { 77: ['a.ts'] }, codeownersText: '* dev@example.com @bob\n' }).notes.some((n) => /電子メール\(dev@example\.com\)/.test(n)));
check('L-2 後の行が所有者の無い行なら、unowned に出す', JSON.stringify(requiredOwners('* @bob\nsrc/gen/\n', ['src/gen/x.ts']).unowned) === JSON.stringify(['src/gen/x.ts']));
{
  const k1 = reqPlan().actions.find((a) => a.key.startsWith('required:')).key;
  const k2 = reqPlan({ fields: { 指名レビュア: '@bob @carol @dave @boss' } }).actions.find((a) => a.key.startsWith('required:')).key;
  const k3 = reqPlan({ fields: { 指名レビュア: '@bob @boss' } }).actions.find((a) => a.key.startsWith('required:')).key;
  check('L-3 指名レビュアを直して未指名の者が変われば、新しい記載の印になる', k1 !== k3 && k2 !== k3 && /:missing=/.test(k1) && !/:missing=/.test(k2), [k1, k2, k3].join(' | '));
}
// H-1 0830: 判定資料の所在だけで公開した上程
const locIssue = (created) => issue({ body: form({ 判定資料の所在: PR_URL }), createdAt: created });
{
  const lateLoc = plan({ issues: [locIssue(at('2026-11-24'))], now: at('2026-11-25'), prFiles: { 77: ['src/a.ts'] }, prCreated: { 77: at('2026-11-20') }, codeownersText: coText, ledgerText: ledgerHead, repo: 'o/r' });
  const shL = lateLoc.actions.find((a) => a.key.startsWith('shortened'));
  check('H-1 IMPL-0830:ng 所在(同じリポジトリの PR)だけの上程でも、上程の作成が期日より遅ければ短縮として通知する(下限であることを書く)', Boolean(shL) && /下限/.test(shL.body), JSON.stringify(lateLoc.notes));
  const prLate = plan({ issues: [locIssue(at('2026-11-10'))], now: at('2026-11-25'), prFiles: { 77: ['src/a.ts'] }, prCreated: { 77: at('2026-11-24') }, codeownersText: coText, ledgerText: ledgerHead, repo: 'o/r' });
  check('H-1 IMPL-0830:ng 所在の PR の作成が期日より遅くても短縮として通知する', prLate.actions.some((a) => a.key.startsWith('shortened')));
  const okLoc = plan({ issues: [locIssue(at('2026-11-10'))], now: at('2026-11-25'), prFiles: { 77: ['src/a.ts'] }, prCreated: { 77: at('2026-11-11') }, codeownersText: coText, ledgerText: ledgerHead, repo: 'o/r' });
  check('H-1 IMPL-0830:ok 下限が期日以前なら通知せず、「公開の時点を確かめていない」を出す', !okLoc.actions.some((a) => a.key.startsWith('shortened')) && okLoc.notes.some((n) => /公開の時点を確かめていない/.test(n) && /所在の欄を書いた時刻は読めない/.test(n)), JSON.stringify(okLoc.notes));
  const ext = plan({ issues: [issue({ body: form({ 判定資料の所在: 'https://example.com/doc' }), createdAt: at('2026-11-24') })], now: at('2026-11-25'), ledgerText: ledgerHead, repo: 'o/r' });
  check('H-1 IMPL-0830:ng 読めない所在(外部の URL)は検出せず、「公開の時点を確かめていない」を出す', !ext.actions.some((a) => a.key.startsWith('shortened')) && ext.notes.some((n) => /公開の時点を確かめていない/.test(n) && /外部の URL/.test(n)), JSON.stringify(ext.notes));
  const lateMat = plan({ issues: [issue()], materials: [{ number: 9, title: pubTitle, body: '', publishedAt: at('2026-11-24') }], now: at('2026-11-25'), ledgerText: ledgerHead });
  check('H-1 判定資料の Issue があれば、その公開の時刻を使う(従来どおり)', lateMat.actions.some((a) => a.key.startsWith('shortened')));
  const noAt = plan({ issues: [issue()], materials: [{ number: 9, title: pubTitle, body: '' }], now: at('2026-11-25'), ledgerText: ledgerHead });
  check('H-1 公開の時刻を読めない資料は、確かめていないと出す', noAt.notes.some((n) => /公開の時点を確かめていない/.test(n)));
}
{
  const evGh = () => '[[]]';
  const wm = withPublishedAt(evGh, 'o/r', [{ number: 9, title: pubTitle, body: '', createdAt: '2026-11-24T01:00:00Z' }]);
  check('H-1 草案の印を外した履歴が無い非草案の資料は、作成の時刻を公開の時刻にする。履歴を読めなければ足さない', wm[0].publishedAt === '2026-11-24T01:00:00Z' && withPublishedAt(() => { throw new Error('x'); }, 'o/r', [{ number: 9, title: pubTitle, body: '', createdAt: '2026-11-24T01:00:00Z' }])[0].publishedAt === undefined);
  const prc = fetchPrCreated(() => JSON.stringify([{ created_at: '2026-11-20T00:00:00Z' }]), 'o/r', 77);
  check('所在の PR の作成の時刻の読み取り(読み取りの API だけ。読めなければ null)', prc === '2026-11-20T00:00:00Z' && fetchPrCreated(() => { throw new Error('404'); }, 'o/r', 77) === null);
}

// ---- TZ に依らない ----
if (process.argv.includes('--emit')) {
  const r = plan({ issues: [issue({ comments: [bobOp] })], now: at('2026-11-24', '15:30:00') });
  console.log(JSON.stringify({ actions: r.actions, notes: r.notes, m: metricsFor({ issues: [i5], month: '2026-11', config }) }));
  process.exit(0);
}
const run = (tz) => execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--emit'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();
const [a, b] = [run('UTC'), run('Asia/Tokyo')];
check('TZ に依らない: TZ=UTC と TZ=Asia/Tokyo で同じ結果', a === b && a.length > 100, `${a.slice(0, 200)} / ${b.slice(0, 200)}`);

console.log(failures === 0 ? '\n事前レビューの試験: すべて期待どおり' : `\n事前レビューの試験: ${failures} 件が期待と違う`);
process.exit(failures === 0 ? 0 : 1);
