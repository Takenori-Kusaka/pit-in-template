// AI の担い手の名義(seats[].performerAccount)の試験(標準 第3章 3.5.3「人と AI の担い手の名義」、第4章 G-6 の数え方と
// 「判定記録を基底ブランチへ入れる操作」。process-compass #430 / ADR-0107・ADR-0108)。
//
//   node scripts/gate/test-performer-account.mjs
//
// 固定する決定:
//   - 名義は dedicated(専用。account の login と正の整数の id)/ shared(共有。person は名簿の id)/ 無記入(未申告)。契約検査が
//     kind の値・id・名簿の人のアカウントとの重なり・person の実在を確かめる(IMPL-0420)
//   - 名義は担い手の識別(performerKey)に含めない(ADR-0107 決定4)
//   - 共有と未申告(担い手を宣言した席)は列挙に無い離脱。担い手のいない席の未申告は数えない
//   - G-6: 専用のアカウントの承認は AI を示す語の有無に依らず数値の識別子で数えない。名義を共有する人の承認は数えて印を付ける(IMPL-0423)
//   - 効力を持つ記録: 名義を共有する記名者の操作だけでは帰属に数えず、名義を共有していない人の帰属の確認を要する。その人が名簿に
//     いなければ、名義の共有を理由とする自己申告として区別して受け付ける(IMPL-0427)
//   - env-check の照合: 認証したアカウントが名簿の人に当たり、申告が専用・未申告なら一致しない所見。照合の範囲を出す(IMPL-0421)
//   - PR 本文の @アカウントを、検査の時点に数値の識別子へ解決して名簿と照合し、解決した値と時点を残す(ADR-0108 決定1 / IMPL-0426)
// GitHub へ問い合わせません。

import {
  performerAccountProblems,
  performerAccountStates,
  performerAccountOf,
  sharingOf,
  dedicatedSeatOf,
  performerKey,
  claimStatus,
  performerAccountEnvFinding,
  PERFORMER_ENV_SCOPE,
  parsePagedJson,
} from './config.mjs';
import { approverFindings, instructorTokensOf, fixedUserLookup, accountLookup } from './check-pr.mjs';
import { introducedBacking, exceptionReviewBacking, stopReviewCandidates } from './material-attribution.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 600)}`}`);
}

const UID = { yamada: 1001, suzuki: 1002, sato: 1003, 'pit-bot-acct': 5005, 'helper-acct': 5006 };
const acct = (login) => ({ login, id: UID[login] ?? null });
const PERFORMER = { model: 'm-1', instructions: 'v1', permissions: 'p' };
const people = [
  { id: 'p1', name: '山田 太郎', accounts: [acct('yamada')] },
  { id: 'p2', name: '鈴木 一郎', accounts: [acct('suzuki')] },
  { id: 'p3', name: '佐藤 花子', accounts: [acct('sato')] },
];
const cfgOf = (seats, extra = {}) => ({ gates: { g6: { state: 'required' } }, review: { reviewerCount: 1 }, people, seats, ...extra });
// 開発者の席の担い手が、席の責任者(山田)のアカウントで動く(共有)
const SHARED = cfgOf([
  { role: 'dev-verifier', name: '開発者', accountable: 'p1', performer: PERFORMER, performerAccount: { kind: 'shared', person: 'p1' } },
  { role: 'independent-reviewer', name: '独立レビュア', accountable: 'p2' },
]);
// 開発者の席の担い手が専用のアカウント(pit-bot-acct。AI を示す語を含まない)で動く
const DEDICATED = cfgOf([
  { role: 'dev-verifier', name: '開発者', accountable: 'p1', performer: PERFORMER, performerAccount: { kind: 'dedicated', account: acct('pit-bot-acct') } },
  { role: 'independent-reviewer', name: '独立レビュア', accountable: 'p2' },
]);
// 担い手を宣言して名義を申告していない(未申告。席の責任者 = 鈴木と共有として扱う)
const UNDECLARED = cfgOf([
  { role: 'dev-verifier', name: '開発者', accountable: 'p1' },
  { role: 'independent-reviewer', name: '独立レビュア', accountable: 'p2', performer: PERFORMER },
]);

// ---------------------------------------------------------------- 1. 名義の欄と契約検査(IMPL-0420)
{
  const probe = (pa, roster = people) => performerAccountProblems({ people: roster, seats: [{ role: 'dev-verifier', name: '開発者', accountable: 'p1', performer: PERFORMER, performerAccount: pa }] });
  // IMPL-0420:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('契約検査: kind が dedicated / shared 以外なら落とす', probe({ kind: 'personal' }).problems.length === 1, JSON.stringify(probe({ kind: 'personal' })));
  check('契約検査: 専用の account の id が正の整数でなければ落とす(文字列・0・小数)', ['5005', 0, 1.5].every((id) => probe({ kind: 'dedicated', account: { login: 'pit-bot-acct', id } }).problems.some((p) => /正の整数/.test(p))));
  check('契約検査: 専用で account が無ければ落とす', probe({ kind: 'dedicated' }).problems.some((p) => /account/.test(p)));
  check('契約検査: 専用と申告したアカウントの id が名簿の人のアカウントにあれば落とす(共有で申告する)', probe({ kind: 'dedicated', account: { login: 'other-name', id: 1001 } }).problems.some((p) => /山田 太郎/.test(p) && /shared/.test(p)));
  check('契約検査: 専用と申告したアカウントのログイン名が名簿の人のアカウントと同じなら落とす', probe({ kind: 'dedicated', account: { login: 'Suzuki', id: 9999 } }).problems.some((p) => /鈴木 一郎/.test(p)));
  check('契約検査: 共有の person が名簿に無ければ落とす', probe({ kind: 'shared', person: 'p9' }).problems.some((p) => /p9/.test(p)));
  check('契約検査: 知らない欄を落とす', probe({ kind: 'shared', person: 'p1', login: 'x' }).problems.some((p) => /知らない欄/.test(p)));
  // IMPL-0420:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('契約検査: 専用(名簿と重ならない login と id)と共有(名簿の id)は通る', !probe({ kind: 'dedicated', account: acct('pit-bot-acct') }).problems.length && !probe({ kind: 'shared', person: 'p1' }).problems.length);
  check('契約検査: 共有の相手が未記入(初期化の回答)は失敗にせず、注記で person の記入を促す', !probe({ kind: 'shared' }).problems.length && probe({ kind: 'shared' }).notes.some((n) => /person/.test(n)));
  check('契約検査: 無記入(未申告)は契約の問題にしない', !performerAccountProblems(UNDECLARED).problems.length);
  // 名義は担い手の識別に含めない(ADR-0107 決定4)
  const seatA = { ...SHARED.seats[0] };
  const seatB = { ...seatA, performerAccount: { kind: 'dedicated', account: acct('pit-bot-acct') } };
  check('識別: 名義を変えても担い手の識別(performerKey)は変わらない', performerKey(seatA.performer) === performerKey(seatB.performer) && !performerKey(seatA.performer).includes('performerAccount') && !performerKey({ ...PERFORMER, performerAccount: 'x' }).includes('x'));
  // 状態の読み方
  check('状態: 共有・専用・未申告を読み分ける(未申告は席の責任者を相手に補う)', performerAccountOf(SHARED, SHARED.seats[0]).kind === 'shared' && performerAccountOf(DEDICATED, DEDICATED.seats[0]).kind === 'dedicated' && performerAccountOf(UNDECLARED, UNDECLARED.seats[1]).person?.id === 'p2');
  check('状態: 担い手のいない席の未申告は、名義の申告が意味を持つ席に数えない', performerAccountStates(UNDECLARED).length === 1 && performerAccountStates(UNDECLARED)[0].role === 'independent-reviewer');
  check('名義を共有する人: 共有の相手と、未申告の席の責任者', sharingOf(SHARED, people[0]) && !sharingOf(SHARED, people[1]) && sharingOf(UNDECLARED, people[1]) && !sharingOf(UNDECLARED, people[0]));
  check('専用のアカウントの照合は数値の識別子で行う(ログイン名だけでは当てない)', dedicatedSeatOf(DEDICATED, { login: 'renamed', id: 5005 })?.role === 'dev-verifier' && !dedicatedSeatOf(DEDICATED, { login: 'pit-bot-acct', id: null }));
  // 列挙に無い離脱(第1章 1.10.2。IMPL-0430 の続き)
  check('離脱: 共有と未申告は列挙に無い離脱、専用は離脱にしない', claimStatus(SHARED).unlisted.some((d) => d.derived === 'performer-account') && claimStatus(UNDECLARED).unlisted.some((d) => d.derived === 'performer-account') && !claimStatus(DEDICATED).unlisted.some((d) => d.derived === 'performer-account'));
  check('離脱: 担い手を宣言していない席でも、共有と申告した席は離脱に数える(安全側)', claimStatus(cfgOf([{ role: 'dev-verifier', name: '開発者', accountable: 'p1', performerAccount: { kind: 'shared', person: 'p1' } }])).unlisted.some((d) => d.derived === 'performer-account'));
}

// ---------------------------------------------------------------- 2. G-6 の数え方(IMPL-0423)
{
  const body = (instr) => `## 作成を指示した者\n\n${instr}\n`;
  const approval = (login, text = '招待の期限切れで 410 を返すことを確かめた') => ({ author: acct(login), state: 'APPROVED', body: text, author_association: 'COLLABORATOR' });
  // 専用のアカウント(AI を示す語を含まない)の承認
  const d = approverFindings(DEDICATED, { body: body('佐藤 花子'), author: 'sato', reviews: [approval('pit-bot-acct')] });
  // IMPL-0423:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('G-6: 専用と申告したアカウントの承認は、AI を示す語を含まなくても数えない(数値の識別子で照合)', d.counted === 0 && d.notCounted.some((x) => /専用の名義/.test(x)), JSON.stringify(d));
  // 名義を共有する人(山田)の承認は数え、印を付ける
  const s = approverFindings(SHARED, { body: body('佐藤 花子'), author: 'sato', reviews: [approval('yamada')] });
  // IMPL-0423:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('G-6: 名義を共有する人の承認は、条件を満たせば数え、印(sharedApprovals)を付ける', s.counted === 1 && s.sharedApprovals.length === 1 && s.sharedApprovals[0].name === '山田 太郎', JSON.stringify(s));
  const u = approverFindings(UNDECLARED, { body: body('山田 太郎'), author: 'yamada', reviews: [approval('suzuki')] });
  check('G-6: 未申告の担い手の席の責任者の承認にも印を付ける', u.counted === 1 && u.sharedApprovals.length === 1);
  const n = approverFindings(SHARED, { body: body('佐藤 花子'), author: 'sato', reviews: [approval('suzuki')] });
  check('G-6: 名義を共有しない人の承認には印を付けない', n.counted === 1 && n.sharedApprovals.length === 0);
}

// ---------------------------------------------------------------- 3. 効力を持つ記録の帰属(IMPL-0427)
{
  const signer = people[0]; // 山田(SHARED で名義を共有する)
  const pr = (o) => ({ number: 7, author: 'yamada', authorId: 1001, approvers: [], commitAuthors: [acct('yamada')], ...o });
  // 記名者が作成者 + 名義を共有していない人(鈴木)の承認 → 帰属の確認で裏づける
  const a = introducedBacking(SHARED, signer, pr({ approvers: [acct('suzuki')] }));
  // IMPL-0427:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('帰属: 名義を共有する記名者の PR に、名義を共有していない人の承認があれば裏づける(sharedAccount の印)', a.backed && a.sharedAccount === true && !a.selfAttested, JSON.stringify(a));
  // 記名者本人の承認だけ(作成者は別の人で名義を共有する佐藤)→ 数えない
  const both = cfgOf([...SHARED.seats, { role: 'tech-lead', name: '技術判断者', accountable: 'p3', performer: PERFORMER, performerAccount: { kind: 'shared', person: 'p3' } }]);
  const b = introducedBacking(both, signer, pr({ author: 'sato', authorId: 1003, approvers: [acct('yamada')], commitAuthors: [acct('sato')] }));
  // IMPL-0427:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('帰属: 名義を共有する記名者本人の承認だけでは数えない(名義を共有していない人の承認が無い)', !b.backed && /名義を共有/.test(b.why), JSON.stringify(b));
  const c = introducedBacking(both, signer, pr({ approvers: [acct('sato')] }));
  check('帰属: 帰属の確認者も名義を共有する人(佐藤)なら数えない(名義を共有していない鈴木が名簿にいる)', !c.backed, JSON.stringify(c));
  const signed = introducedBacking(SHARED, signer, { number: null, verified: true, authorLogin: 'yamada', authorId: 1001, committerLogin: 'yamada', committerId: 1001 });
  check('帰属: 名義を共有する記名者の署名を検証したコミットだけでは数えない', !signed.backed && /署名/.test(signed.why), JSON.stringify(signed));
  // 名簿の全員が名義を共有する体制 → 名義の共有を理由とする自己申告として受け付ける
  const allShared = cfgOf([
    { role: 'dev-verifier', name: '開発者', accountable: 'p1', performer: PERFORMER, performerAccount: { kind: 'shared', person: 'p1' } },
    { role: 'independent-reviewer', name: '独立レビュア', accountable: 'p2', performer: PERFORMER },
    { role: 'tech-lead', name: '技術判断者', accountable: 'p3', performer: PERFORMER },
  ]);
  const d = introducedBacking(allShared, signer, pr({ approvers: [acct('suzuki')] }));
  check('帰属: 記名者以外で名義を共有していない人が名簿にいない体制では、名義の共有を理由とする自己申告として受け付け、区別する', d.backed && d.selfAttested && d.sharedAccount && /名義の共有を理由とする自己申告/.test(d.note), JSON.stringify(d));
  const e = introducedBacking(allShared, signer, { number: null, verified: true, authorLogin: 'yamada', authorId: 1001, committerLogin: 'yamada', committerId: 1001 });
  check('帰属: 同じ体制の署名コミットも、名義の共有を理由とする自己申告として受け付ける', e.backed && e.selfAttested && e.sharedAccount);
  // 名義を共有しない記名者(鈴木)は従来どおり
  const f = introducedBacking(SHARED, people[1], pr({ author: 'suzuki', authorId: 1002, approvers: [acct('yamada')], commitAuthors: [acct('suzuki')] }));
  check('帰属: 名義を共有しない記名者は従来どおり(作成者 + 記名者以外の承認)。印を付けない', f.backed && !f.sharedAccount, JSON.stringify(f));

  // (A) 対象の PR の上のレビュー
  const HEAD = 'a'.repeat(40);
  const row = { id: 'D-012', approver: '山田 太郎' };
  const decl = { id: 1, user: { login: 'yamada', id: 1001, type: 'User' }, state: 'COMMENTED', body: '例外承認: D-012\n\n理由は台帳の行のとおり', submitted_at: '2026-11-05T10:00:00Z', commit_id: HEAD, edited_by: null, author_association: 'MEMBER' };
  const conf = (login, o = {}) => ({ id: 2, user: { login, id: UID[login], type: 'User' }, state: 'APPROVED', body: '帰属の確認', submitted_at: '2026-11-05T11:00:00Z', commit_id: HEAD, edited_by: null, author_association: 'MEMBER', ...o });
  const A = (cfg, reviews) => exceptionReviewBacking(cfg, row, signer, { reviews, author: 'sato', head: HEAD, instructorIds: [] });
  check('A: 名義を共有する記名者の宣言行のレビューだけでは数えない', !A(SHARED, [decl]).backed && /名義を共有/.test(A(SHARED, [decl]).why.join('')), JSON.stringify(A(SHARED, [decl])));
  check('A: 先頭に対する、名義を共有していない人の承認(帰属の確認)があれば数える', A(SHARED, [decl, conf('suzuki')]).backed && A(SHARED, [decl, conf('suzuki')]).sharedAccount);
  check('A: 帰属の確認の承認が先頭より前の版なら数えない', !A(SHARED, [decl, conf('suzuki', { commit_id: 'b'.repeat(40) })]).backed);
  check('A: 確認者を置けない体制では、名義の共有を理由とする自己申告として受け付ける', A(allShared, [decl]).backed && A(allShared, [decl]).selfAttested && A(allShared, [decl]).sharedAccount);
  const stopBody = '停止の解除: 解除\n\n| 欄 | 記載 |\n| --- | --- |\n| 申し立てた者 | 佐藤 花子 |\n| 解除の理由 | 原因を除いた |\n';
  const st = (reviews) => stopReviewCandidates(SHARED, { reviews, author: 'sato', head: HEAD, labeledAt: '2026-11-05T09:00:00Z' });
  check('停止の解除: 名義を共有する解除した者のレビューだけでは候補にしない', st([{ ...decl, body: stopBody }]).candidates.length === 0 && st([{ ...decl, body: stopBody }]).rejected.some((x) => /名義を共有/.test(x)));
  check('停止の解除: 名義を共有していない人の帰属の確認があれば候補にし、注記を付ける', st([{ ...decl, body: stopBody }, conf('suzuki')]).candidates.length === 1 && /帰属の確認/.test(st([{ ...decl, body: stopBody }, conf('suzuki')]).candidates[0].note));
}

// ---------------------------------------------------------------- 6. env-check の照合(IMPL-0421)
{
  const f1 = performerAccountEnvFinding(DEDICATED, { login: 'yamada', id: 1001 }, { seatRoles: ['dev-verifier'] });
  // IMPL-0421:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('env-check: 認証したアカウントが名簿の人で、申告が専用なら一致しない所見(専用として扱わない)', f1.status === 'mismatch' && f1.seats[0].status === 'mismatch' && /共有/.test(f1.seats[0].detail), JSON.stringify(f1));
  const f2 = performerAccountEnvFinding(UNDECLARED, { login: 'suzuki', id: 1002 }, { seatRoles: ['independent-reviewer'] });
  check('env-check: 申告が未申告で、名簿の人に当たれば一致しない所見(共有として申告する)', f2.status === 'mismatch' && /kind: "shared"/.test(f2.seats[0].detail));
  const f3 = performerAccountEnvFinding(DEDICATED, { login: 'pit-bot-acct', id: 5005 }, { seatRoles: ['dev-verifier'] });
  // IMPL-0421:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('env-check: 認証したアカウントが専用と申告したアカウント(識別子が一致)なら確認済み', f3.status === 'confirmed', JSON.stringify(f3));
  const f4 = performerAccountEnvFinding(SHARED, { login: 'yamada', id: 1001 }, { seatRoles: ['dev-verifier'] });
  check('env-check: 共有の申告と認証したアカウントの人が一致すれば確認済み', f4.status === 'confirmed');
  const f5 = performerAccountEnvFinding(DEDICATED, null, { seatRoles: ['dev-verifier'] });
  check('env-check: 認証したアカウントを読めなければ未確認(通過にしない)', f5.status === 'unconfirmed');
  check('env-check: 照合が実行した環境と時点に限ることを結果に書く', [f1, f3, f5].every((f) => f.scope === PERFORMER_ENV_SCOPE) && /環境/.test(PERFORMER_ENV_SCOPE) && /時点/.test(PERFORMER_ENV_SCOPE));
  const f6 = performerAccountEnvFinding(DEDICATED, { login: 'yamada', id: 1001 }, { seatRoles: ['independent-reviewer'] });
  check('env-check: --seat で、この環境で動く担い手の席を限る(名義を申告していない席だけなら対象外)', f6.status === 'notApplicable' && f6.seats.length === 0);
  // --seat を省いた照合は、席ごとの判定に使わない(#430 突合 L-6)
  const f8 = performerAccountEnvFinding(DEDICATED, { login: 'yamada', id: 1001 });
  check('env-check(L-6): --seat を省いた照合は、どの席の環境かを指定していない所見だけを出し、席ごとに判定しない', f8.status === 'notSpecified' && !f8.seats.length, JSON.stringify(f8));
  // 照合の結果を、述べられる名・G-6 の印・帰属の確認が読む(#430 突合 H-1)
  const envOf = (role, f) => ({ [role]: { checkedAt: '2026-11-05T10:00:00+09:00', account: f.account, person: f.person, status: f.seats.find((x) => x.role === role)?.status, declared: f.seats.find((x) => x.role === role)?.declared } });
  const hitEnv = { ...DEDICATED, performerEnvCheck: envOf('dev-verifier', f1) };
  check('照合(H-1): 照合で名簿の人に当たった席は、申告が専用でも、その人と名義を共有する席として扱う', sharingOf(hitEnv, people[0])?.length === 1 && claimStatus(hitEnv).unlisted.some((d) => d.derived === 'performer-account'), JSON.stringify(claimStatus(hitEnv).unlisted));
  const hitAp = approverFindings(hitEnv, { body: `## 作成を指示した者\n\n佐藤 花子\n`, author: 'sato', reviews: [{ author: acct('yamada'), state: 'APPROVED', body: '招待の期限切れで 410 を返すことを確かめた', author_association: 'MEMBER' }] });
  check('照合(H-1): 照合で共有へ倒した席の人の G-6 の承認に印を付ける', hitAp.sharedApprovals.length === 1, JSON.stringify(hitAp));
  const hitBack = introducedBacking(hitEnv, people[0], { number: 7, author: 'yamada', authorId: 1001, approvers: [acct('sato')], commitAuthors: [acct('yamada')] });
  check('照合(H-1): 照合で共有へ倒した席の人の効力を持つ記録は、名義を共有していない人の承認で裏づけ、印を付ける', hitBack.backed && hitBack.sharedAccount, JSON.stringify(hitBack));
  check('照合(H-1): 照合の記録の無い専用の申告は、述べられる名で「名義の照合が無い」列挙に無い離脱に数える(名義の数え方では専用のまま)', claimStatus(DEDICATED).unlisted.some((d) => d.derived === 'performer-account-unverified') && dedicatedSeatOf(DEDICATED, acct('pit-bot-acct')));
  const okEnv = { ...DEDICATED, performerEnvCheck: envOf('dev-verifier', f3) };
  check('照合(H-1): 申告と同じ専用のアカウントの照合が確認済みなら、名義の照合が無い離脱を持たない', !claimStatus(okEnv).unlisted.some((d) => String(d.derived).startsWith('performer-account')), JSON.stringify(claimStatus(okEnv).unlisted));
  const staleEnv = { ...DEDICATED, seats: DEDICATED.seats.map((s) => (s.role === 'dev-verifier' ? { ...s, performerAccount: { kind: 'dedicated', account: acct('helper-acct') } } : s)), performerEnvCheck: envOf('dev-verifier', f3) };
  check('照合(H-1): 照合の後に専用のアカウントの申告を変えたら、前の照合を確認に数えない', claimStatus(staleEnv).unlisted.some((d) => d.derived === 'performer-account-unverified'));
  const noId = { ...DEDICATED, people: [{ id: 'p1', name: '山田 太郎', accounts: ['yamada'] }, ...people.slice(1)] };
  const f7 = performerAccountEnvFinding(noId, { login: 'yamada', id: 1001 }, { seatRoles: ['dev-verifier'] });
  check('env-check: 名簿のログイン名に識別子が無ければ、識別子を入れる提案だけを出す(名簿を書き換えない)', /提案/.test(f7.proposal ?? '') && noId.people[0].accounts[0] === 'yamada');
}

// ---------------------------------------------------------------- 8. PR 本文の @アカウントの解決(ADR-0108 決定1 / IMPL-0426)
{
  const body = (instr) => `## 作成を指示した者\n\n${instr}\n`;
  const cfg = cfgOf([]);
  const lk = fixedUserLookup({ yamada: 1001, 'yamada-new': 1001, suzuki: 7777 }, { at: '2026-11-05T09:00:00+09:00' });
  const r = instructorTokensOf(cfg, body('@yamada-new / @suzuki / @ghost'), { login: 'sato', id: 1003 }, lk);
  check('解決: @アカウントを数値の識別子で名簿と照合する(改名したログイン名でも識別子で同じ人)', r.resolved.some((p) => p.id === 'p1'), JSON.stringify(r));
  check('解決: ログイン名が一致し識別子が異なるアカウントは、名簿に対応づかない指示者に入れる', r.unresolved.some((x) => /@suzuki/.test(x) && /識別子が異なる/.test(x)), JSON.stringify(r.unresolved));
  check('解決: 識別子へ解決できないアカウントは、名簿に対応づかない指示者に入れる', r.unresolved.some((x) => /@ghost/.test(x) && /解決できない/.test(x)));
  check('解決: 解決した値と時点を残す', lk.at === '2026-11-05T09:00:00+09:00' && [...lk.entries.values()].some((e) => e.token === '@yamada-new' && e.id === 1001) && [...lk.entries.values()].some((e) => e.token === '@ghost' && e.id === null));
  const plain = instructorTokensOf(cfg, body('@yamada'), { login: 'sato', id: 1003 });
  check('解決: トークンの無い手元の実行(lookup なし)は、従来の名の解決(ログイン名)のまま', plain.resolved.some((p) => p.id === 'p1') && !plain.unresolved.length);
  let calls = 0;
  const once = accountLookup(() => {
    calls++;
    return { login: 'yamada', id: 1001 };
  });
  once.resolve('@yamada');
  once.resolve('@Yamada');
  check('解決: 同じログイン名は1回だけ引く', calls === 1);
  const thrown = accountLookup(() => {
    throw new Error('HTTP 404');
  });
  check('解決: 引けなかった理由を残す', thrown.resolve('@x') === null && /404/.test([...thrown.entries.values()][0].error));
  // @ を付けないログイン名も、アカウントの記載として識別子で解決する(#430 突合 L-2)
  const bare = instructorTokensOf(cfg, body('suzuki'), { login: 'sato', id: 1003 }, lk);
  check('解決(L-2): @ の無いログイン名(名簿の氏名・id に当たらない)も識別子で照合する', bare.unresolved.some((x) => /suzuki/.test(x) && /識別子が異なる/.test(x)) && !bare.resolved.length, JSON.stringify(bare));
  const byName = instructorTokensOf(cfg, body('鈴木 一郎'), { login: 'sato', id: 1003 }, lk);
  check('解決(L-2): 氏名の記載は従来どおり名で解決する', byName.resolved.some((p) => p.id === 'p2'));
}

// ---------------------------------------------------------------- その他の訂正(#430 突合 C-3・L-3)
{
  check('C-3: --paginate の頁ごとの配列の連結を、1つの配列に戻して読む(文字列の中の ][ に惑わされない)', JSON.stringify(parsePagedJson('[{"a":"]["}][{"b":1}]')) === '[{"a":"]["},{"b":1}]' && JSON.stringify(parsePagedJson('{"x":1}')) === '{"x":1}');
  const blank = performerAccountProblems(cfgOf([{ role: 'dev-verifier', name: '開発者', performer: PERFORMER }]));
  check('L-3: 未申告の席で席の責任者が未記入なら、名義を共有する人が分からない旨を注記に出す', blank.notes.some((n) => /名義を共有する人が分からない/.test(n)), JSON.stringify(blank));
}

console.log(failures ? `\n担い手の名義の試験: ${checks} 件のうち ${failures} 件が期待と一致しません` : `\n担い手の名義の試験: ${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
