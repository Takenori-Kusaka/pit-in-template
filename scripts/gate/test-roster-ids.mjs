// アカウントと人の対応表(名簿の数値の識別子による照合)の試験
// (標準 第4章「判定の成立」の保全の条件「アカウントと人の対応表」。process-compass #430 / ADR-0108 / IMPL-0426)。
//   - identifyAccount の各分岐(識別子の一致・改名・識別子の食い違い・ログイン名だけの一致・名簿に当たらない)
//   - rosterProblems の { login, id } の要素(正の整数、重複なし、同じ login に別の id なし)
//   - roster-ids.mjs の提案(写しから集め、写しどうし・写しと現在の値が食い違うアカウントを提案しない)
//   - ログイン名だけで対応づけた承認者・判定者・作成者を数えないこと(check-pr・material-attribution・集約の関数)
//
//   node scripts/gate/test-roster-ids.mjs

import { identifyAccount, identifyWhy, rosterProblems, accountKey, accountLoginOf, accountIdOf, accountRefOf, accountsWithoutId, findPersonByAccount, numericAccountId } from './config.mjs';
import { proposeRosterIds, rosterWithProposals, observationsOfCopy } from './roster-ids.mjs';
import { approverFindings, instructorTokensOf } from './check-pr.mjs';
import { introducedBacking, exceptionReviewBacking } from './material-attribution.mjs';
import { gateJudgementsOfCopy, lastReviewStates } from './aggregate-evidence.mjs';
import { diffConfig } from '../init/generate-profile.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 600)}`}`);
}

const config = {
  people: [
    { id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: 1001 }] },
    { id: 'p2', name: '鈴木 一郎', accounts: [{ login: 'suzuki', id: 1002 }] },
    // 識別子の無い(ログイン名だけの)要素。移行前の名簿
    { id: 'p3', name: '佐藤 花子', accounts: ['sato'] },
  ],
  roles: [{ id: 'value-owner', name: '価値責任者', gatesOwned: ['g4'] }],
  seats: [{ role: 'value-owner', accountable: '佐藤 花子' }],
  gates: { g6: { state: 'required' } },
  review: { reviewerCount: 1 },
};

// ---------------------------------------------------------------- 要素の読み方
check('要素: 文字列と { login, id } の両方からログイン名の鍵を作る', accountKey('@Yamada') === 'yamada' && accountKey({ login: 'Yamada', id: 1 }) === 'yamada' && accountLoginOf({ login: '@x', id: 2 }) === 'x');
check('要素: 数値の識別子は正の整数だけ(文字列の要素・0・小数・ノードの識別子は null)', accountIdOf({ login: 'a', id: 5 }) === 5 && accountIdOf('a') === null && accountIdOf({ login: 'a', id: 0 }) === null && accountIdOf({ login: 'a', id: 1.5 }) === null && numericAccountId('MDQ6VXNlcjE=') === null && numericAccountId('42') === 42);
check('要素: 記録の書き手を読む(REST の user、gh の author、写し)。レビューの id を書き手の識別子と取り違えない', (() => {
  const a = accountRefOf({ id: 777, user: { login: 'suzuki', id: 1002 } });
  const b = accountRefOf({ id: 777, author: { login: 'suzuki' } });
  return a.login === 'suzuki' && a.id === 1002 && b.login === 'suzuki' && b.id === null;
})());
check('要素: 識別子の無いアカウントを数える(/pit と roster-ids.mjs の入力)', accountsWithoutId(config).length === 1 && accountsWithoutId(config)[0].login === 'sato');

// ---------------------------------------------------------------- identifyAccount の分岐
// IMPL-0426:ok(違反と適合の対。標準の実装マーク。process-compass #314)
{
  const r = identifyAccount(config, { login: 'suzuki', id: 1002 });
  check('照合: 識別子とログイン名が名簿と一致 → 対応づける(how=id、所見なし)', r.person?.id === 'p2' && r.how === 'id' && r.problem === null, JSON.stringify(r));
  const renamed = identifyAccount(config, { login: 'suzuki-new', id: 1002 });
  check('照合: 識別子が一致しログイン名が違う(改名) → 同じ人として対応づけ、改名の所見を出す', renamed.person?.id === 'p2' && renamed.how === 'id' && /改名/.test(renamed.problem), JSON.stringify(renamed));
}
// IMPL-0426:ng(違反と適合の対。標準の実装マーク。process-compass #314)
{
  const mm = identifyAccount(config, { login: 'suzuki', id: 9999 });
  check('照合: ログイン名が一致し識別子が異なる → 対応づけず、他人の取得の疑いを出す', mm.person === null && mm.how === 'mismatch' && /数値の識別子が異なる/.test(mm.problem) && mm.candidate?.id === 'p2', JSON.stringify(mm));
  const noRecId = identifyAccount(config, { login: 'suzuki' });
  check('照合: 記録に識別子が無い(gh pr view の reviews など) → ログイン名が一致しても対応づけない', noRecId.person === null && noRecId.how === 'login-only' && /記録に数値の識別子が無い/.test(noRecId.problem), JSON.stringify(noRecId));
  const noRosterId = identifyAccount(config, { login: 'sato', id: 1003 });
  check('照合: 名簿に識別子が無い → ログイン名が一致しても対応づけない', noRosterId.person === null && noRosterId.how === 'login-only' && /名簿に数値の識別子が無い/.test(noRosterId.problem), JSON.stringify(noRosterId));
  const none = identifyAccount(config, { login: 'stranger', id: 5 });
  check('照合: 名簿に当たらない → how=none、所見なし', none.person === null && none.how === 'none' && none.problem === null && /対応づかない/.test(identifyWhy(none)));
  check('照合: 人が書いた記載の名の解決(findPersonByAccount)はログイン名で引く(PR の本文の @アカウントなど)', findPersonByAccount(config, '@sato')?.id === 'p3' && findPersonByAccount(config, 'suzuki')?.id === 'p2');
}

// ---------------------------------------------------------------- rosterProblems の { login, id }
{
  const base = (accountsA, accountsB = [{ login: 'b', id: 2 }]) => ({ people: [{ id: 'p1', name: '山田 太郎', accounts: accountsA }, { id: 'p2', name: '鈴木 一郎', accounts: accountsB }] });
  // IMPL-0426:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('名簿: { login, id } と文字列の要素を混ぜた名簿を受け付ける', rosterProblems(base([{ login: 'a', id: 1 }, 'a-old'])).length === 0, JSON.stringify(rosterProblems(base([{ login: 'a', id: 1 }, 'a-old']))));
  // IMPL-0426:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('名簿: id が正の整数でない要素を拒否する', rosterProblems(base([{ login: 'a', id: '1' }])).some((x) => /正の整数/.test(x)) && rosterProblems(base([{ login: 'a', id: -3 }])).some((x) => /正の整数/.test(x)) && rosterProblems(base([{ login: 'a' }])).some((x) => /正の整数/.test(x)));
  check('名簿: login の無い要素を拒否する', rosterProblems(base([{ id: 1 }])).some((x) => /login/.test(x)));
  check('名簿: 名簿の中で識別子が重なる(別のアカウントに同じ id)ことを拒否する', rosterProblems(base([{ login: 'a', id: 7 }], [{ login: 'b', id: 7 }])).some((x) => /両方に書かれている/.test(x)));
  check('名簿: 同じログイン名に別の識別子を書くことを拒否する', rosterProblems(base([{ login: 'a', id: 1 }, { login: 'A', id: 3 }])).some((x) => /別の数値の識別子/.test(x)));
  check('名簿: 知らない欄を持つ要素を拒否する', rosterProblems(base([{ login: 'a', id: 1, name: 'x' }])).some((x) => /知らない欄/.test(x)));
  check('名簿: { login, id } の要素も AI・bot の名義の検査に掛かる', rosterProblems(base([{ login: 'claude-bot', id: 1 }])).some((x) => /人のアカウントに限る/.test(x)));
}

// ---------------------------------------------------------------- 照合を使う箇所(ログイン名だけでは数えない)
{
  const body = '## 作成を指示した者\n\n山田 太郎\n';
  const ok = approverFindings(config, { body, author: 'yamada', authorId: 1001, reviews: [{ author: { login: 'suzuki', id: 1002 }, state: 'APPROVED', body: '挙動要約: 招待の期限切れで 410 を返すことを確かめた' }] });
  // IMPL-0426:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('G-6 の承認者(PR の検査): 識別子で対応づいた承認を数える', ok.counted === 1 && !ok.accountFindings.length, JSON.stringify(ok));
  const loginOnly = approverFindings(config, { body, author: 'yamada', authorId: 1001, reviews: [{ author: { login: 'suzuki' }, state: 'APPROVED', body: '挙動要約: 招待の期限切れで 410 を返すことを確かめた' }] });
  // IMPL-0426:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('G-6 の承認者(PR の検査): ログイン名だけの承認は数えず、理由を出す', loginOnly.counted === 0 && loginOnly.notCounted.some((x) => /記録に数値の識別子が無い/.test(x)), JSON.stringify(loginOnly.notCounted));
  const mismatch = approverFindings(config, { body, author: 'yamada', authorId: 1001, reviews: [{ author: { login: 'suzuki', id: 4242 }, state: 'APPROVED', body: '挙動要約: 招待の期限切れで 410 を返すことを確かめた' }] });
  check('G-6 の承認者(PR の検査): ログイン名が一致し識別子が異なる承認は数えず、所見(accountFindings)に出す', mismatch.counted === 0 && mismatch.accountFindings.some((x) => /数値の識別子が異なる/.test(x)), JSON.stringify(mismatch));
  const byDefault = instructorTokensOf(config, '', { login: 'yamada', id: null });
  check('作成を指示した者(既定値は PR の作成者): 作成者の識別子が無ければ名簿へ対応づけず、対応づかない指示者に入れる', byDefault.resolved.length === 0 && byDefault.unresolved.some((x) => /記録に数値の識別子が無い/.test(x)), JSON.stringify(byDefault));
  check('作成を指示した者(既定値): 作成者の識別子で対応づける', instructorTokensOf(config, '', { login: 'yamada', id: 1001 }).resolved[0]?.id === 'p1');
}
{
  const signer = config.people[1];
  // 記録を入れた PR の承認者がログイン名だけ(識別子なし)。記名者本人の承認に数えない
  const b1 = introducedBacking(config, signer, { number: 5, author: 'yamada', authorId: 1001, approvers: ['suzuki'] });
  check('効力を持つ記録の帰属: 承認者がログイン名だけなら記名者本人の承認に数えない', !b1.backed, JSON.stringify(b1));
  const b2 = introducedBacking(config, signer, { number: 5, author: 'yamada', authorId: 1001, approvers: [{ login: 'suzuki', id: 4242 }] });
  check('効力を持つ記録の帰属: ログイン名が一致し識別子が異なる承認者は数えず、理由を出す', !b2.backed && /数値の識別子が異なる/.test(b2.why), JSON.stringify(b2));
  const b3 = introducedBacking(config, signer, { number: 5, author: 'yamada', authorId: 1001, approvers: [{ login: 'suzuki-renamed', id: 1002 }] });
  check('効力を持つ記録の帰属: 改名した記名者の承認(識別子が一致)は数える', b3.backed && b3.how === 'approval', JSON.stringify(b3));
  const HEAD = 'a'.repeat(40);
  const rv = (user) => ({ id: 1, user, state: 'COMMENTED', body: '例外承認: D-012', submitted_at: '2026-11-05T10:00:00Z', commit_id: HEAD, edited_by: null });
  const a1 = exceptionReviewBacking(config, { id: 'D-012' }, signer, { reviews: [rv({ login: 'suzuki' })], author: 'yamada', head: HEAD });
  check('効力を持つ記録の帰属(対象の PR の上のレビュー): 書き手の識別子が無ければ数えない', !a1.backed && a1.why.some((x) => /記録に数値の識別子が無い/.test(x)), JSON.stringify(a1));
  check('効力を持つ記録の帰属(対象の PR の上のレビュー): 書き手の識別子で対応づければ数える', exceptionReviewBacking(config, { id: 'D-012' }, signer, { reviews: [rv({ login: 'suzuki', id: 1002 })], author: 'yamada', head: HEAD }).backed);
}
{
  // 判定者本人のレビュー(写し)。席の責任者(佐藤)の名簿の要素に識別子が無い
  const copy = { pr: 1, merge_commit_sha: 'm', head_sha: 'h', reviews: [{ id: 1, state: 'COMMENTED', commit_id: 'h', submitted_at: '2026-10-01T00:00:00Z', user: { id: 1003, login: 'sato' }, body: 'G-4: 通過' }] };
  const [j] = gateJudgementsOfCopy(copy, config);
  check('判定者のレビュー(集約): 席の責任者の名簿の要素に識別子が無ければ、判定者本人のレビューに数えない(judgeOk=false と理由)', j.judgeOk === false && /名簿に数値の識別子が無い/.test(j.judgeNote), JSON.stringify(j));
  const withId = { ...config, people: config.people.map((p) => (p.id === 'p3' ? { ...p, accounts: [{ login: 'sato', id: 1003 }] } : p)) };
  check('判定者のレビュー(集約): 識別子を名簿へ書けば数える', gateJudgementsOfCopy(copy, withId)[0].judgeOk === true);
  const st = lastReviewStates([{ author: { login: 'suzuki', id: 1002 }, state: 'APPROVED', body: '挙動要約: 確かめた内容を書く' }, { author: { login: 'suzuki-renamed', id: 1002 }, state: 'CHANGES_REQUESTED', body: '基準 1' }]);
  check('G-6 の数え方(集約): レビュアを識別子で区別する(改名の前後の同じ人の承認と変更要求を同じレビュアとして読む)', st.last.size === 1 && [...st.last.values()][0].state === 'CHANGES_REQUESTED' && st.withdrawn === 1, JSON.stringify([...st.last]));
}

// ---------------------------------------------------------------- roster-ids.mjs の提案
{
  const roster = {
    people: [
      { id: 'p1', name: '山田 太郎', accounts: ['yamada'] },
      { id: 'p2', name: '鈴木 一郎', accounts: ['suzuki'] },
      { id: 'p3', name: '佐藤 花子', accounts: ['sato'] },
      { id: 'p4', name: '高橋 次郎', accounts: ['takahashi'] },
      { id: 'p5', name: '伊藤 三郎', accounts: [{ login: 'ito', id: 5005 }] },
    ],
  };
  const copy = (n, author, reviewers) => ({ where: `records:records/reviews/pr-${n}.json`, copy: { pr: n, author, reviews: reviewers.map((u, i) => ({ id: i + 1, user: u, state: 'APPROVED' })) } });
  const sources = [
    copy(1, { login: 'yamada', id: 1001 }, [{ login: 'suzuki', id: 1002 }, { login: 'ito', id: 7777 }]),
    copy(2, { login: 'yamada', id: 1001 }, [{ login: 'sato', id: 1003 }]),
    // 同じログイン名 sato に別の識別子(改名の後に他人が取得した疑い)
    { where: 'docs/records/reviews/pr-3.json', copy: { pr: 3, reviews: [{ id: 9, user: { login: 'sato', id: 8888 }, state: 'APPROVED' }] } },
  ];
  check('提案: 写しの reviews[].user と author から (login, id) を集める', observationsOfCopy(sources[0].copy, 'x').length === 3);
  const r = proposeRosterIds(roster, { sources });
  const prop = (login) => r.proposals.find((x) => x.login === login);
  // IMPL-0426:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('提案: 写しに1つの識別子で現れるアカウントを提案する', prop('yamada')?.id === 1001 && prop('suzuki')?.id === 1002, JSON.stringify(r.proposals));
  // IMPL-0426:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('提案: 写しどうしで識別子が食い違うアカウントは提案せず、所見に出す', !prop('sato') && r.findings.some((x) => /@sato/.test(x) && /提案しない/.test(x)), JSON.stringify(r));
  check('提案: 写しに現れないアカウントは、--lookup が無ければ提案しない(理由を出す)', !prop('takahashi') && r.unresolved.some((x) => x.login === 'takahashi' && /--lookup/.test(x.why)));
  check('提案: 名簿に識別子を持つアカウントで、写しに同じログイン名の別の識別子が現れたら所見に出す', r.findings.some((x) => /@ito/.test(x) && /7777/.test(x)));
  const looked = proposeRosterIds(roster, { sources, lookup: (login) => ({ takahashi: 4004, yamada: 1001, suzuki: 2222 })[login] ?? null });
  const lp = (login) => looked.proposals.find((x) => x.login === login);
  check('提案(--lookup): 写しに現れないアカウントを gh api users/<login> の値で提案する(出所を書く)', lp('takahashi')?.id === 4004 && /gh api users/.test(lp('takahashi').from));
  check('提案(--lookup): 写しの値と現在の値が異なるアカウントは提案せず、所見に出す', !lp('suzuki') && looked.findings.some((x) => /@suzuki/.test(x) && /現在の値 2222/.test(x)) && lp('yamada')?.id === 1001, JSON.stringify(looked));
  const people = rosterWithProposals(roster, r.proposals);
  check('提案: 提案を当てた名簿の全体(/process-change の people に渡す形)。提案の無い要素は変えない', JSON.stringify(people[0].accounts) === '[{"login":"yamada","id":1001}]' && people[2].accounts[0] === 'sato' && people.length === 5 && rosterProblems({ people }).length === 0, JSON.stringify(people));
}

// ---------------------------------------------------------------- 名簿へ識別子を書く経路(/process-change の種別 accountable)
{
  const before = { people: [{ id: 'p1', name: '山田 太郎', accounts: ['yamada'] }], seats: [], gates: {} };
  const after = { people: [{ id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: 1001 }] }], seats: [], gates: {} };
  const d = diffConfig(before, after);
  const lines = JSON.stringify(d);
  check('名簿の変更: 識別子を足すことはアカウントの表記の変更として差分に出し、別の人への差し替えに数えない', /yamada → yamada\(#1001\)/.test(lines) && !(d.rosterSwaps ?? []).length, lines.slice(0, 600));
}

// ---------------------------------------------------------------- 突合の後の訂正(process-compass #430 突合 M-3・H-3)
{
  const roster = { people: [{ id: 'p1', name: '山田 太郎', accounts: ['yamada'] }] };
  const src = (assoc) => [{ where: 'records:records/reviews/pr-9.json', copy: { pr: 9, reviews: [{ id: 1, user: { login: 'yamada', id: 9999 }, state: 'COMMENTED', ...(assoc ? { author_association: assoc } : {}) }] } }];
  const none = proposeRosterIds(roster, { sources: src('NONE') });
  check('提案(M-3): リポジトリとの関係が書き込みの権限を持たない書き手の観測を、提案の根拠にしない', !none.proposals.length && none.excluded === 1, JSON.stringify(none));
  const member = proposeRosterIds(roster, { sources: src('MEMBER') });
  check('提案(M-3): 関係が MEMBER の書き手の観測は提案する', member.proposals[0]?.id === 9999 && member.excluded === 0);
  const old = proposeRosterIds(roster, { sources: src(null) });
  check('提案(M-3): 関係の値の無い古い写しはそのまま読み、件数を返す(出力の注記)', old.proposals[0]?.id === 9999 && old.unassociated === 1);
}
{
  // 1名の体制で、決定者本人が自分の行の既存のログイン名に数値の識別子を足すだけの変化点(H-3)
  const { deciderProblems } = await import('../init/generate-profile.mjs');
  const seats = ['biz-approver', 'dev-verifier', 'independent-reviewer'].map((role) => ({ role, accountable: 'p1' }));
  const before = { people: [{ id: 'p1', name: '山田 太郎', accounts: ['yamada'] }], seats, gates: {}, changeLog: [{ diff: ['開発者: 責任者 未記入 → 山田 太郎'] }] };
  const after = { ...before, people: [{ id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: 1001 }] }] };
  const d = diffConfig(before, after);
  const p = deciderProblems(after, d, '山田 太郎', before);
  check('名簿の変更(H-3): 1名の体制では、決定者本人の記名で自分の行に識別子を足す変化点を受け付ける', !p.length, JSON.stringify(p));
  check('名簿の変更(H-3): 変化点の記録に、本人の記名による識別子の追加を区別して残す', d.rosterEdits?.[0]?.selfIdAddition === true && /本人の記名による数値の識別子の追加/.test(JSON.stringify(d.renameItems)), JSON.stringify(d.rosterEdits));
  const renamed = { ...before, people: [{ id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada2', id: 1001 }] }] };
  const d2 = diffConfig(before, renamed);
  check('名簿の変更(H-3): ログイン名を変える変化点は、本人の記名では受け付けない(識別子の追加だけに限る)', deciderProblems(renamed, d2, '山田 太郎', before).length > 0);
  const two = { ...before, people: [...before.people, { id: 'p2', name: '鈴木 一郎', accounts: ['suzuki'] }] };
  const twoAfter = { ...two, people: [{ id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: 1001 }] }, two.people[1]] };
  check('名簿の変更(H-3): 2名以上の体制では、決定者本人の行の識別子の追加も本人の記名では受け付けない', deciderProblems(twoAfter, diffConfig(two, twoAfter), '山田 太郎', two).length > 0);
}

console.log(failures ? `\nアカウントと人の対応表の試験: ${checks} 件のうち ${failures} 件が期待と一致しません` : `\nアカウントと人の対応表の試験: ${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
