// 出荷判定の証跡の集約(aggregate-evidence.mjs)のうち、承認レビューの写しと記録用ブランチを読む部分の試験
// (process-compass #321 D2〜D6 / #54 段階 2)。
//
//   node scripts/gate/test-aggregate-records.mjs
//
// 集約の本体(git・gh を呼び、evidence/ を書く)は動かしません。本体より前に置いた関数だけを import し、fixtures/records/ の
// 写し・様式・PR の記録(API の形)と、手で起こした構成を渡して、期待と比べます。
//   - 2 つの読み取り元(基底ブランチの複製と記録用ブランチ)の突合と「写しの不一致」
//   - 機械が出す欄(欄ごとの出所。人が書く欄は所在だけ)
//   - G-2・G-4 の判定者本人のレビューと、commit_id とマージ時の head の一致
//   - G-6 の承認を写しから読む形と、写しと PR の記録の突合(本文の編集・dismiss・ghost 化)
//   - 様式の帰属(記名者本人の承認レビュー / 署名コミット / 自己申告)と、記名者以外の承認(取り込みの事務)
//   - 出荷の範囲のマージと写しの件数の一致
// 記録用ブランチの git からの読み取りそのものは test-records.mjs が確かめます。GitHub へ問い合わせません。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_COPIES_DIR,
  parseCopy,
  readBaseCopies,
  mergeRecordSources,
  reviewsOfCopy,
  approvalCountOfCopy,
  reconcileCopy,
  judgeLoginsOf,
  gateJudgementsOfCopy,
  unconfirmedVersionGaps,
  lastReviewStates,
  machineFields,
  copyCoverage,
  formAttribution,
  prRecordFromCopy,
  targetOfForm,
  judgeOfForm,
  supersededByLater,
  reviewSupersededByLater,
} from './aggregate-evidence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'records');
const readFixture = (...rel) => fs.readFileSync(path.join(FIXTURES, ...rel), 'utf8');
const copyOf = (n) => JSON.parse(readFixture('reviews', `pr-${n}.json`));
const gateText = (name) => readFixture('gates', name);

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 構成(手で起こしたもの)。山田が価値責任者(G-2・G-4 を判定する席)、鈴木が独立レビュア(G-6)。
// 名簿の数値の識別子は fixtures/records/reviews/ の写しの user.id と同じ値(名簿の照合は識別子で行う。process-compass #430)
const UID = { yamada: 22556919, suzuki: 30000001, sato: 40000002 };
const config = {
  people: [
    { id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: UID.yamada }] },
    { id: 'p2', name: '鈴木 一郎', accounts: [{ login: 'suzuki', id: UID.suzuki }] },
    { id: 'p3', name: '佐藤 花子', accounts: [{ login: 'sato', id: UID.sato }] },
    { id: 'p4', name: '高橋 次郎' },
  ],
  roles: [
    { id: 'value-owner', name: '価値責任者', gatesOwned: ['g1', 'g2', 'g4'] },
    { id: 'independent-reviewer', name: '独立レビュア', gatesOwned: ['g6'] },
    { id: 'qa-gatekeeper', name: '出荷判定者', gatesOwned: ['g7'] },
  ],
  seats: [
    { role: 'value-owner', accountable: '山田 太郎' },
    { role: 'independent-reviewer', accountable: '鈴木 一郎' },
    { role: 'qa-gatekeeper', accountable: '高橋 次郎' },
  ],
};

// ---------------------------------------------------------------- 写しの読み取り
{
  const ok = parseCopy('records/reviews/pr-12.json', readFixture('reviews', 'pr-12.json'));
  check('parseCopy: 写しを読む(pr と番号)', ok.copy?.pr === 12 && ok.prNumber === 12 && ok.reason === null);
  check('parseCopy: 名前の形が違う', parseCopy('records/reviews/notes.json', '{}').copy === null && /pr-<番号>/.test(parseCopy('x/notes.json', '{}').reason));
  check('parseCopy: 壊れた JSON', /JSON/.test(parseCopy('pr-15.json', '{ "pr": 15, "reviews": [').reason));
  check('parseCopy: reviews の配列が無い', /reviews/.test(parseCopy('pr-15.json', '{ "pr": 15 }').reason));
  check('parseCopy: ファイル名と pr の不一致', /一致しない/.test(parseCopy('pr-15.json', '{ "pr": 16, "reviews": [] }').reason));
  check('parseCopy: Windows の区切りでも basename を読む', parseCopy('docs\\records\\reviews\\pr-12.json', readFixture('reviews', 'pr-12.json')).prNumber === 12);

  const base = readBaseCopies(path.join(FIXTURES, 'base'));
  check(`readBaseCopies: ${BASE_COPIES_DIR} から写し 2 件(12・13)と skipped 1 件(notes.json)`, base.present && base.reviews.size === 2 && base.reviews.has(12) && base.reviews.has(13) && base.skipped.length === 1 && base.skipped[0].file === `${BASE_COPIES_DIR}/notes.json`, JSON.stringify({ size: base.reviews.size, skipped: base.skipped }));
  const none = readBaseCopies(path.join(FIXTURES, 'api'));
  check('readBaseCopies: 置き場が無ければ present=false で空', none.present === false && none.reviews.size === 0);
}

// ---------------------------------------------------------------- 2 つの読み取り元の突合
{
  // fixtures は LF で保存しているが、autocrlf の checkout では CRLF で読まれる。改行の形式の違いを作る前に LF へ揃える
  const g7 = gateText('g7-v1.2.0-2026-10-20.md').replace(/\r\n/g, '\n');
  const g8 = gateText('g8-v1.2.0-2026-10-21.md').replace(/\r\n/g, '\n');
  const branch = {
    available: true,
    ref: 'records',
    head: 'abc',
    reviews: new Map([[12, copyOf(12)], [13, copyOf(13)], [14, copyOf(14)]]),
    gates: [
      { file: 'records/gates/g7-v1.2.0-2026-10-20.md', text: g7, commit: null },
      { file: 'records/gates/g8-v1.2.0-2026-10-21.md', text: g8, commit: null },
      { file: 'records/gates/g1-P-001-2026-10-01.md', text: '# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | G-1 企画承認 |\n| 対象 | P-001 |\n| 判定者 | 山田 太郎 |\n', commit: null },
    ],
    skipped: [],
  };
  const base = readBaseCopies(path.join(FIXTURES, 'base'));
  const baseGates = [
    // 基底へ複製済み(同じ内容。改行の形式と行末の空白は違ってよい)
    { file: 'docs/gates/g7-v1.2.0-2026-10-20.md', text: g7.replace(/\n/g, '\r\n').replace('| G-7 出荷判定 |', '| G-7 出荷判定 |  ') },
    // 基底の側で書き換えられている
    { file: 'docs/gates/g8-v1.2.0-2026-10-21.md', text: g8.replace('異議なし', '異議あり') },
  ];
  const m = mergeRecordSources({ branch, base, baseGates });
  check('突合: 写しは 3 件(12・13 は両方、14 は記録用ブランチだけ)', m.copies.size === 3 && m.copies.has(14), [...m.copies.keys()].join(','));
  check('突合: 同じ内容の写し(12)は出所を 2 つ持ち、記録用ブランチを先に書く', same(m.copies.get(12).sources, ['records/reviews/pr-12.json', `${BASE_COPIES_DIR}/pr-12.json`]), JSON.stringify(m.copies.get(12).sources));
  // IMPL-0436:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check(
    '突合: 内容が違う写し(13)は「写しの不一致」になり、正は出荷で基底ブランチへ入った複製(記録用ブランチの側の書き換え)',
    m.mismatches.some((x) => x.kind === 'review' && x.pr === 13 && /写しの不一致/.test(x.text) && /基底ブランチへ入った複製を正/.test(x.text)) &&
      m.copies.get(13).sources[0] === `${BASE_COPIES_DIR}/pr-13.json` &&
      m.copies.get(13).mismatch === 'records/reviews/pr-13.json' &&
      m.copies.get(13).copy === base.reviews.get(13),
    JSON.stringify(m.mismatches)
  );
  // IMPL-0436:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('突合: 同じ内容の写し(12)は不一致に数えない', !m.mismatches.some((x) => x.pr === 12));
  check('突合: 記録用ブランチだけの写し(14)の出所は 1 つ', same(m.copies.get(14).sources, ['records/reviews/pr-14.json']));
  const g7m = m.gates.find((g) => g.name === 'g7-v1.2.0-2026-10-20.md');
  const g8m = m.gates.find((g) => g.name === 'g8-v1.2.0-2026-10-21.md');
  const g1m = m.gates.find((g) => g.name === 'g1-P-001-2026-10-01.md');
  check('突合: 様式は basename で対応づけ、改行の形式と行末の空白の違いは一致とみなす', g7m?.sameAsBase === true && g7m.baseFile === 'docs/gates/g7-v1.2.0-2026-10-20.md', JSON.stringify(g7m));
  check('突合: 基底の側で書き換えられた様式(g8)は「写しの不一致」', g8m?.sameAsBase === false && m.mismatches.some((x) => x.kind === 'gate' && x.file === 'records/gates/g8-v1.2.0-2026-10-21.md'), JSON.stringify(m.mismatches.filter((x) => x.kind === 'gate')));
  check('突合: 基底に無い様式(g1)は baseFile=null, sameAsBase=null', g1m?.baseFile === null && g1m.sameAsBase === null);
  check('突合: 不一致は 2 件(写し 13、様式 g8)', m.mismatches.length === 2, JSON.stringify(m.mismatches.map((x) => x.kind)));

  // 記録用ブランチが無い構成(available=false): 基底の複製だけで動き、不一致は出ない
  const off = mergeRecordSources({ branch: { available: false, reason: '無い', reviews: new Map(), gates: [], skipped: [] }, base, baseGates });
  check('突合: 記録用ブランチが無ければ、基底の複製だけ(2 件)で、不一致なし・様式なし', off.copies.size === 2 && off.mismatches.length === 0 && off.gates.length === 0 && off.copies.get(12).sources[0] === `${BASE_COPIES_DIR}/pr-12.json`);
  const nothing = mergeRecordSources({ branch: { available: false }, base: { reviews: new Map() } });
  check('突合: 両方とも空なら空', nothing.copies.size === 0 && nothing.mismatches.length === 0);
}

// ---------------------------------------------------------------- G-6 の承認を写しから読む形
{
  const r14 = reviewsOfCopy(copyOf(14));
  check('reviewsOfCopy: PR の記録と同じ形(author.login・state・body・submittedAt)', r14.reviews.length === 2 && r14.reviews[0].author.login === 'suzuki' && r14.reviews[0].state === 'APPROVED' && r14.reviews[0].submittedAt === '2026-10-24T01:00:00Z' && /挙動要約/.test(r14.reviews[0].body), JSON.stringify(r14.reviews[0]));
  check('reviewsOfCopy: commit_id == head の承認は失効していない', r14.stale.length === 0 && r14.head === copyOf(14).head_sha_at_merge);
  const stale = { pr: 20, head_sha: 'bbbb', reviews: [{ id: 1, state: 'APPROVED', commit_id: 'aaaa', submitted_at: '2026-10-01T00:00:00Z', user: { id: 2, login: 'suzuki' }, body: '挙動要約: 失効する前の承認。head は進んでいる。' }] };
  const rs = reviewsOfCopy(stale);
  check('reviewsOfCopy: commit_id != head の承認は失効(STALE)として数えない', rs.reviews[0].state === 'STALE' && rs.stale.length === 1 && rs.stale[0].login === 'suzuki', JSON.stringify(rs));
  const bot = { pr: 21, head_sha: 'a', reviews: [{ id: 1, state: 'APPROVED', commit_id: 'a', submitted_at: '2026-10-01T00:00:00Z', user: { id: 9, login: 'reviewer-app', type: 'Bot' }, body: '挙動要約: 自動の承認である。中身は見ていない。' }] };
  check('reviewsOfCopy: 写しの user.type が Bot なら is_bot', reviewsOfCopy(bot).reviews[0].author.is_bot === true);
  const noType = { pr: 21, head_sha: 'a', reviews: [{ id: 1, state: 'APPROVED', commit_id: 'a', submitted_at: '2026-10-01T00:00:00Z', user: { id: 9, login: 'reviewer-app' }, body: '挙動要約: 自動の承認である。中身は見ていない。' }] };
  check('reviewsOfCopy: user.type が無ければ PR の記録の is_bot で補う', reviewsOfCopy(noType, { apiReviews: [{ author: { login: 'reviewer-app', is_bot: true }, state: 'APPROVED' }] }).reviews[0].author.is_bot === true && reviewsOfCopy(noType).reviews[0].author.is_bot === false);
  check('reviewsOfCopy: 写しでないものは空', reviewsOfCopy(null).reviews.length === 0 && reviewsOfCopy({}).reviews.length === 0);

  check('承認の数: pr-12 は承認者 1 名(宣言行の COMMENTED は数えない)', approvalCountOfCopy(copyOf(12)) === 1);
  check('承認の数: pr-13(変更要求だけ)は 0', approvalCountOfCopy(copyOf(13)) === 0);
  const withdrew = { reviews: [
    { state: 'APPROVED', submitted_at: '2026-10-01T00:00:00Z', user: { login: 'suzuki' } },
    { state: 'CHANGES_REQUESTED', submitted_at: '2026-10-02T00:00:00Z', user: { login: 'suzuki' } },
    { state: 'APPROVED', submitted_at: '2026-10-02T00:00:00Z', user: { login: 'sato' } },
  ] };
  // 写しの欄(承認の数)の数え方。集約の G-6 の数え方(lastReviewStates)とは別の経路
  check('承認の数: 承認者ごとの最後の状態(承認の後の変更要求は数えない)', approvalCountOfCopy(withdrew) === 1);
  check('承認の数: 変更要求の後に承認し直した承認者は数える', approvalCountOfCopy({ reviews: [...withdrew.reviews, { state: 'APPROVED', submitted_at: '2026-10-03T00:00:00Z', user: { login: 'suzuki' } }] }) === 2);
}

// ---------------------------------------------------------------- G-6 の承認の数え方(集約の本体が呼ぶ lastReviewStates)
{
  const summary = '挙動要約: 境界の値で入力を拒む挙動を確かめた。';
  const rv = (login, state, body = summary) => ({ author: { login, is_bot: false }, state, body });
  // IMPL-0357:ng
  const ng = lastReviewStates([rv('suzuki', 'APPROVED'), rv('suzuki', 'CHANGES_REQUESTED', '基準2 を満たさない'), rv('sato', 'APPROVED')]);
  check('G-6 の数え方: 承認の後に同じ人が変更要求を出した承認は数えない(取り下げ)', ng.last.get('suzuki').state === 'CHANGES_REQUESTED' && ng.withdrawn === 1 && ng.last.get('sato').state === 'APPROVED', JSON.stringify([...ng.last]));
  const cm = lastReviewStates([rv('suzuki', 'APPROVED'), rv('suzuki', 'COMMENTED', '追記')]);
  // IMPL-0357:ok
  const ok = lastReviewStates([rv('suzuki', 'CHANGES_REQUESTED', '基準2 を満たさない'), rv('suzuki', 'APPROVED')]);
  check('G-6 の数え方: 変更要求の後に承認し直した承認者は、最後の状態の承認で数える', ok.last.get('suzuki').state === 'APPROVED' && ok.last.get('suzuki').summary === true && ok.withdrawn === 0, JSON.stringify([...ok.last]));
  check('G-6 の数え方: COMMENTED は最後の状態を変えない', cm.last.get('suzuki').state === 'APPROVED' && cm.withdrawn === 0);
}

// ---------------------------------------------------------------- 写しとホスティングの記録(REST)の突合(process-compass #379 / ADR-0109 決定2)
{
  // 不変の欄(レビューの識別子・user.id・commit_id・submitted_at)はホスティングの記録を正とし、不一致と写しにだけあるレビューは欠落。
  // 本文・状態の変化は所見。書き手のアカウントの削除(ghost)は照合できなかったもの。ホスティングを読めなければ突合しない(G-6 を数えない)
  const rest = JSON.parse(readFixture('api', 'pr-14.rest.json'));
  const r14 = reconcileCopy(copyOf(14), rest, { pr: 14, mergedAt: '2026-10-24T02:00:00Z' });
  // IMPL-0435:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('突合: 不変の欄が一致し、写しにだけあるレビューが無ければ欠落なし', r14.readable === true && r14.defects.length === 0, JSON.stringify(r14.defects));
  check('突合: 本文の編集・取り下げ(dismiss)は所見(写しを取った時点の値が記録)', r14.findings.some((x) => /5627550001/.test(x) && /本文が写しと違う/.test(x)) && r14.findings.some((x) => /5627550001/.test(x) && /DISMISSED/.test(x)), JSON.stringify(r14.findings));
  check('突合: 書き手のアカウントの削除(ghost)は欠落にせず、照合できなかったもの(G-6 に数えない)', r14.unverifiable.length === 1 && /5627550002/.test(r14.unverifiable[0]) && r14.unverifiableIds.has('5627550002'), JSON.stringify(r14.unverifiable));
  check('突合: マージの後に提出されたレビューは所見(写しの対象外)', r14.findings.some((x) => /sato/.test(x) && /写しの後に提出された/.test(x)), JSON.stringify(r14.findings));
  check('突合: 所見は 3 件(編集・dismiss・写しに無い)', r14.findings.length === 3, JSON.stringify(r14.findings));
  const r14b = reconcileCopy(copyOf(14), rest, { pr: 14, mergedAt: '2026-10-24T06:00:00Z' });
  check('突合: マージより前に提出され、ホスティングにあり写しに無いレビュー(写しから落としたレビュー)は欠落(突合 H-2)', r14b.defects.some((x) => /sato/.test(x) && /写しから落とした/.test(x)), JSON.stringify(r14b));
  check('突合: G-6 の承認はホスティングの記録の状態で数える(stateById。写しが APPROVED でも記録が DISMISSED なら DISMISSED)', r14.stateById.get('5627550001') === 'DISMISSED' && reviewsOfCopy(copyOf(14), { stateById: r14.stateById }).reviews.find((x) => x.id === 5627550001)?.state === 'DISMISSED', JSON.stringify([...r14.stateById]));
  const restOf = (copy) => copy.reviews.map((r) => ({ id: r.id, user: { login: r.user.login, id: r.user.id }, state: r.state, commit_id: r.commit_id, submitted_at: r.submitted_at, body: r.body }));
  const c12 = copyOf(12);
  const ok12 = reconcileCopy(c12, restOf(c12));
  check('突合: 一致していれば欠落も所見もない', ok12.readable && !ok12.defects.length && !ok12.findings.length && !ok12.unverifiable.length, JSON.stringify(ok12));
  const tampered = (fn) => {
    const c = JSON.parse(JSON.stringify(c12));
    fn(c);
    return reconcileCopy(c, restOf(c12), { pr: 12 });
  };
  // IMPL-0435:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const ngCommit = tampered((c) => (c.reviews[0].commit_id = 'f'.repeat(40)));
  check('突合: 写しの commit_id を書き換えたら欠落', ngCommit.defects.length === 1 && /commit_id/.test(ngCommit.defects[0]), JSON.stringify(ngCommit.defects));
  const ngUser = tampered((c) => (c.reviews[0].user.id = 99999999));
  check('突合: 写しの user.id を書き換えたら欠落', ngUser.defects.length === 1 && /数値の識別子/.test(ngUser.defects[0]), JSON.stringify(ngUser.defects));
  const ngTime = tampered((c) => (c.reviews[0].submitted_at = '2020-01-01T00:00:00Z'));
  check('突合: 写しの提出日時を書き換えたら欠落', ngTime.defects.length === 1 && /提出日時/.test(ngTime.defects[0]), JSON.stringify(ngTime.defects));
  const ngOnly = tampered((c) => c.reviews.push({ id: 777, state: 'APPROVED', commit_id: c.head_sha_at_merge, submitted_at: '2026-10-23T12:00:00Z', user: { id: UID.sato, login: 'sato' }, body: '挙動要約: 偽の承認。写しにだけある。' }));
  check('突合: 写しにだけあるレビュー(先取り・偽の承認)は欠落', ngOnly.defects.length === 1 && /写しにだけ/.test(ngOnly.defects[0]), JSON.stringify(ngOnly.defects));
  const unread = reconcileCopy(c12, null, { pr: 12 });
  check('突合: ホスティングの記録を読めなければ readable=false(呼び出し側は写しで G-6 を数えない)', unread.readable === false && !unread.defects.length && reconcileCopy(c12, undefined).readable === false);
  // gh pr view の形(author・submittedAt・commit.oid)も読める
  const ghForm = c12.reviews.map((r) => ({ id: r.id, author: { login: r.user.login, id: r.user.id }, state: r.state, commit: { oid: r.commit_id }, submittedAt: r.submitted_at, body: r.body }));
  check('突合: 集約が REST を直した形(author・commit.oid・submittedAt)でも同じ', reconcileCopy(c12, ghForm).defects.length === 0);
}

// ---------------------------------------------------------------- 判定者本人のレビュー(G-2・G-4)
{
  const w4 = judgeLoginsOf(config, 'G-4');
  check('判定する席: G-4 は価値責任者(山田 @yamada)', w4.role === 'value-owner' && w4.person?.id === 'p1' && same([...w4.logins], ['yamada']), JSON.stringify({ role: w4.role, logins: [...(w4.logins ?? [])] }));
  check('判定する席: g6 の形でも引ける', judgeLoginsOf(config, 'g6').role === 'independent-reviewer');
  check('判定する席: 席が無いゲート(G-8)は logins=null', judgeLoginsOf(config, 'G-8').logins === null);
  check('判定する席: 責任者にアカウントが無ければ空の Set(G-7 の高橋)', judgeLoginsOf(config, 'G-7').logins?.size === 0 && judgeLoginsOf(config, 'G-7').person?.id === 'p4');
  check('判定する席: 構成が空なら null', judgeLoginsOf({}, 'G-4').logins === null);

  const j12 = gateJudgementsOfCopy(copyOf(12), config);
  check('G-4(pr-12): 判定者本人(@yamada)の最後の宣言行 1 件。judgeOk=true、commit_id == head', j12.length === 1 && j12[0].gate === 'G-4' && j12[0].result === '通過' && j12[0].judgeOk === true && j12[0].headMatch === true && j12[0].person?.id === 'p1' && j12[0].mergeCommit === copyOf(12).merge_commit_sha, JSON.stringify(j12));
  check('G-4(pr-12): 宣言行の無い承認(suzuki の LGTM)は判定でない', !j12.some((j) => j.login === 'suzuki'));
  const j13 = gateJudgementsOfCopy(copyOf(13), config);
  check('G-6(pr-13): 判定者本人(@suzuki)の差し戻し。commit_id != head(確定していない版)', j13.length === 1 && j13[0].judgeOk === true && j13[0].headMatch === false && j13[0].result === '差し戻し' && same(j13[0].criteria, [3, 5]), JSON.stringify(j13));
  const other = { pr: 17, merge_commit_sha: 'm', head_sha: 'h', reviews: [{ id: 1, state: 'APPROVED', commit_id: 'h', submitted_at: '2026-10-01T00:00:00Z', user: { id: UID.sato, login: 'sato' }, body: 'G-4: 通過\n確認した項目: 基準1' }] };
  const jo = gateJudgementsOfCopy(other, config);
  check('G-4(pr-17): 判定する席の責任者でない者(@sato)の宣言行は judgeOk=false(数えない)', jo.length === 1 && jo[0].judgeOk === false && /席の責任者/.test(jo[0].judgeNote), JSON.stringify(jo));
  const ju = gateJudgementsOfCopy(copyOf(12), { people: config.people });
  check('G-4: 席が構成に無ければ judgeOk=null と注記(数えたうえで本人かを確かめられないと出す)', ju.length === 1 && ju[0].judgeOk === null && /確かめられない/.test(ju[0].judgeNote), JSON.stringify(ju));
  const noAcc = { ...config, people: config.people.map((p) => (p.id === 'p1' ? { id: 'p1', name: '山田 太郎' } : p)) };
  const jn = gateJudgementsOfCopy(copyOf(12), noAcc);
  check('G-4: 責任者のアカウントが名簿に無ければ judgeOk=null(accounts を要する旨の注記)', jn[0].judgeOk === null && /accounts/.test(jn[0].judgeNote), JSON.stringify(jn[0].judgeNote));
  check('G-4(pr-14): 注記を足した結果(通過(…))は宣言行でない', gateJudgementsOfCopy(copyOf(14), config).length === 0);

  // 確定していない版を取り込んだ変更を欠落に数える(標準 第4章 G-2。G-2・G-3・G-4 を判定者本人のレビューで記録した変更)
  const versioned = (gate, commitId, login = 'yamada') => ({
    pr: 18,
    merge_commit_sha: 'm'.repeat(40),
    head_sha: 'h'.repeat(40),
    reviews: [{ id: 2, state: 'COMMENTED', commit_id: commitId, submitted_at: '2026-10-01T00:00:00Z', user: { id: UID[login], login }, body: `${gate}: 通過\n確認した項目: 基準1` }],
  });
  const gapsOf = (copy) => unconfirmedVersionGaps(gateJudgementsOfCopy(copy, config).map((j) => ({ ...j, pr: copy.pr })));
  // IMPL-0129:ng
  const ngG2 = gapsOf(versioned('G-2', 'c'.repeat(40)));
  check('版の一致: G-2 の commit_id がマージ時の head とずれた変更を、確定していない版を取り込んだ欠落に数える', ngG2.length === 1 && /確定していない版/.test(ngG2[0]) && /PR #18: G-2/.test(ngG2[0]), JSON.stringify(ngG2));
  // IMPL-0352:ng
  const ngG3 = gapsOf(versioned('G-3', 'c'.repeat(40)));
  check('版の一致: G-3 の判定もずれを欠落に数える', ngG3.length === 1 && /PR #18: G-3/.test(ngG3[0]), JSON.stringify(ngG3));
  // IMPL-0352:ok
  check('版の一致: G-3 の commit_id がマージ時の head と一致すれば欠落に数えない', gapsOf(versioned('G-3', 'h'.repeat(40))).length === 0);
  check('版の一致: 宣言行の無いレビューは G-3 に数えない', gateJudgementsOfCopy({ ...versioned('G-3', 'c'.repeat(40)), reviews: [{ ...versioned('G-3', 'c'.repeat(40)).reviews[0], body: '判断記録を確認しました' }] }, config).length === 0);
  // IMPL-0129:ok
  check('版の一致: commit_id がマージ時の head と一致すれば欠落に数えない', gapsOf(versioned('G-2', 'h'.repeat(40))).length === 0 && gapsOf(versioned('G-4', 'h'.repeat(40))).length === 0);
  check('版の一致: 判定する席の責任者でない者の宣言行と、G-6 は、版のずれを見ない', gapsOf(versioned('G-4', 'c'.repeat(40), 'sato')).length === 0 && gapsOf(versioned('G-6', 'c'.repeat(40), 'suzuki')).length === 0);
}

// ---------------------------------------------------------------- 機械が出す欄
{
  const copy = copyOf(12);
  const [j] = gateJudgementsOfCopy(copy, config);
  const src = 'records/reviews/pr-12.json';
  const f = machineFields(j, copy, {
    source: src,
    pr: { createdAt: '2026-10-22T08:00:00Z', authorLogin: 'pit-in-bot' },
    instructors: { known: new Map([['p1', '山田 太郎']]), unresolved: [], byDefault: false },
    d0: { version: '3', source: 'process.config.json#d0Version(マージ前の基底 9f1c2d3e^ の構成)' },
    seatName: '価値責任者',
  });
  const field = (name) => f.fields.find((x) => x.field === name);
  check('欄: 8 つの機械が出す欄', same(f.fields.map((x) => x.field), ['判定者', '提出日時', '判定日時', '対象', '結果', '参照した D-0 の版', '承認の数', '作成を指示した者との別']), JSON.stringify(f.fields.map((x) => x.field)));
  check('欄: 判定者は user.id とログイン名、名簿の人と席。出所は写しの reviews[1].user と構成', /user\.id 22556919/.test(field('判定者').value) && /@yamada/.test(field('判定者').value) && /山田 太郎/.test(field('判定者').value) && /席: 価値責任者/.test(field('判定者').value) && field('判定者').source.startsWith(`${src}#reviews[1].user`) && /people\[p1\]/.test(field('判定者').source), JSON.stringify(field('判定者')));
  check('欄: 提出日時は PR の作成(gh)。出所に review_requested を読んでいない旨', field('提出日時').value === '2026-10-22T08:00:00Z' && /createdAt/.test(field('提出日時').source) && /review_requested/.test(field('提出日時').source), JSON.stringify(field('提出日時')));
  check('欄: 判定日時は submitted_at', field('判定日時').value === '2026-10-23T11:22:51Z' && field('判定日時').source === `${src}#reviews[1].submitted_at`);
  check('欄: 対象は PR 番号・commit_id・レビューの id・マージ後のコミット(出所つき)', /PR #12/.test(field('対象').value) && /commit_id bc4ea26f/.test(field('対象').value) && /レビュー 5627536939/.test(field('対象').value) && /マージ後 9f1c2d3e/.test(field('対象').value) && /merge_commit_sha/.test(field('対象').source), JSON.stringify(field('対象')));
  check('欄: 結果は宣言行から', field('結果').value === 'G-4: 通過' && /1 行目/.test(field('結果').source));
  check('欄: D-0 の版は基底ブランチの構成から', field('参照した D-0 の版').value === '3' && /d0Version/.test(field('参照した D-0 の版').source));
  check('欄: 承認の数は写しの APPROVED(承認者ごとの最後の状態)', field('承認の数').value === '1' && /state=APPROVED/.test(field('承認の数').source));
  check('欄: 判定者が作成を指示した者本人(PR 本文の欄から)', field('作成を指示した者との別').value === '作成を指示した者本人' && /本文「作成を指示した者」/.test(field('作成を指示した者との別').source), JSON.stringify(field('作成を指示した者との別')));
  check('欄: 人が書く欄は本文の所在だけ(本文を写さない)', f.humanFields.location === `${src}#reviews[1].body` && !JSON.stringify(f.fields).includes('確認した項目'), JSON.stringify(f.humanFields));
  check('欄: 要約の節(gate・result・pr・reviewId・headMatch)', f.gate === 'G-4' && f.result === '通過' && f.pr === 12 && f.reviewId === 5627536939 && f.headMatch === true);

  const f2 = machineFields(j, copy, { source: src, pr: { createdAt: null, authorLogin: 'yamada' }, instructors: { known: new Map([['p2', '鈴木 一郎']]), unresolved: [], byDefault: true } });
  const rel2 = f2.fields.find((x) => x.field === '作成を指示した者との別');
  check('欄: 指示した者が別人なら「作成を指示した者でない」。PR の作成者本人のレビューはその旨を添える。既定値の出所', /作成を指示した者でない/.test(rel2.value) && /PR の作成者本人/.test(rel2.value) && /既定値/.test(rel2.source) && /@yamada/.test(rel2.source), JSON.stringify(rel2));
  check('欄: 提出日時が取れなければ「取れない」(推定しない)', /取れない/.test(f2.fields.find((x) => x.field === '提出日時').value));
  check('欄: D-0 の版が無ければ「構成に無い」', f2.fields.find((x) => x.field === '参照した D-0 の版').value === '構成に無い');
  const f3 = machineFields(j, copy, { source: src, instructors: { known: new Map(), unresolved: ['@unknown-user'], byDefault: true } });
  check('欄: 指示した者を名簿と対応づけられなければ「判定できない」', /判定できない/.test(f3.fields.find((x) => x.field === '作成を指示した者との別').value));
  const f4 = machineFields(j, copy, { source: src, instructors: null });
  check('欄: PR の記録が無ければ別は「判定できない(PR の記録を取得できない)」', /PR の記録を取得できない/.test(f4.fields.find((x) => x.field === '作成を指示した者との別').value));
  const [jo] = gateJudgementsOfCopy({ pr: 17, merge_commit_sha: 'm', head_sha: 'h', reviews: [{ id: 1, state: 'COMMENTED', commit_id: 'h', submitted_at: '2026-10-01T00:00:00Z', user: { id: 99, login: 'stranger' }, body: 'G-4: 通過' }] }, config);
  const f5 = machineFields(jo, { pr: 17, reviews: [] }, { source: 'records/reviews/pr-17.json', instructors: { known: new Map([['p1', '山田 太郎']]), unresolved: [], byDefault: false } });
  check('欄: 名簿に無い判定者は「名簿に無い」と出し、別は「判定できない」', /名簿に無い/.test(f5.fields.find((x) => x.field === '判定者').value) && /判定者を名簿と対応づけられない/.test(f5.fields.find((x) => x.field === '作成を指示した者との別').value));
}

// ---------------------------------------------------------------- 出荷の範囲のマージと写しの件数
{
  const copies = new Map([[12, {}], [13, {}], [14, {}]]);
  const c = copyCoverage([14, 12, 15, 13, 12], copies);
  check('件数の一致: 範囲内のマージ 4 件 / 写し 3 件 / 欠け 1 件(#15)。重複は 1 件に数える', c.merged === 4 && c.copied === 3 && same(c.missing, [15]), JSON.stringify(c));
  check('件数の一致: マージが無ければ 0 / 0 / 0', same(copyCoverage([], copies), { merged: 0, copied: 0, missing: [] }));
  check('件数の一致: 写しが無ければ全件が欠け', same(copyCoverage([1, 2], new Map()).missing, [1, 2]));
}

// ---------------------------------------------------------------- 様式の帰属(記名者本人の裏づけ)
//
// 裏づけは、記名者本人のアカウントの操作をホスティングの記録で確かめたものに限る(process-compass #379 / ADR-0109 決定3)。
// 様式の今の中身を基底ブランチへ入れた変更(introduced。hosting.prOfCommit の形)の作成者・承認者、または記録用ブランチで様式を
// 足したコミット(added。hosting.commitOf の形。ホスティングが署名を検証し、committer・author とも記名者)。署名の無い author の一致は数えない
{
  const g7 = gateText('g7-v1.2.0-2026-10-20.md');
  check('様式の欄: 対象と判定者', targetOfForm(g7) === 'v1.2.0' && judgeOfForm(g7) === '鈴木 一郎');
  check('様式の欄: 様式の説明を残した欄は未記入', judgeOfForm('| 判定者 | <氏名>。AI を書かない |') === null && targetOfForm('# x') === null);
  check('様式の欄: 判定者の注記(。以降)は読まない', judgeOfForm('| 判定者 | 鈴木 一郎。レビュー 5627536939 の user.id から |') === '鈴木 一郎');

  const suzuki = config.people[1];
  const base = { hash: 'abcdef0123456789', authorName: '鈴木 一郎', authorEmail: '30000001+suzuki@users.noreply.github.com', authorLogin: 'suzuki', date: '2026-10-20T14:00:00+09:00' };
  const rec = (commit) => ({ file: 'docs/gates/g7-v1.2.0-2026-10-20.md', text: g7, commit });
  const bot = { ...base, authorName: 'pit-in-bot', authorEmail: 'bot@example.com', authorLogin: null, signed: false };
  const pull = (o) => ({ number: 30, author: 'yamada', authorId: UID.yamada, approvers: [], commitAuthors: [{ login: 'yamada', id: UID.yamada }], headRef: 'feature/x', ...o });
  // 記録だけの PR を、記名者本人が承認した(承認者 = 記名者)
  const a1 = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: suzuki, config, introduced: pull({ approvers: [{ login: 'suzuki', id: UID.suzuki }] }) });
  check('帰属: 様式を入れた PR の記名者本人の承認 → backed(approval-review)。事務の承認者なし', a1.backed === true && a1.how === 'approval-review' && a1.clerical.length === 0 && a1.selfAttested === false, JSON.stringify(a1));
  // 記名者以外が承認した(取り込みの事務)。コミットの author は草案の文脈(bot)
  const a2 = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: suzuki, config, introduced: pull({ approvers: [{ login: 'sato', id: UID.sato }] }) });
  check('帰属: 記名者以外の承認だけ → 自己申告。承認者は取り込みの事務(clerical)に出す', a2.backed === false && a2.selfAttested === true && same(a2.clerical, ['sato']), JSON.stringify(a2));
  // IMPL-0128:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const a3 = formAttribution(rec({ ...base, signed: false }), { judgeName: '鈴木 一郎', person: suzuki, config, introduced: pull({ approvers: [{ login: 'sato', id: UID.sato }] }) });
  check('帰属: コミットの author の login が記名者でも、署名の無い author の一致は数えない(自己申告。弱い裏づけを置かない)', a3.backed === false && a3.selfAttested === true && a3.how === 'author-login' && same(a3.clerical, ['sato']), JSON.stringify(a3));
  const a3b = formAttribution(rec({ ...base, signed: true }), { judgeName: '鈴木 一郎', person: suzuki, config });
  check('帰属: 手元の署名の検証(%G?)だけでは数えない(ホスティングの記録が無い)', a3b.backed === false && a3b.selfAttested === true, JSON.stringify(a3b));
  // IMPL-0128:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const signedAdd = { number: null, verified: true, authorLogin: 'suzuki', authorId: UID.suzuki, committerLogin: 'suzuki', committerId: UID.suzuki };
  const a4 = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: suzuki, config, added: signedAdd });
  check('帰属: 記録用ブランチで様式を足したコミットを、ホスティングが署名を検証し committer・author とも記名者 → signed-commit', a4.backed === true && a4.how === 'signed-commit' && a4.clerical.length === 0, JSON.stringify(a4));
  const a4b = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: suzuki, config, added: { ...signedAdd, committerLogin: 'web-flow', committerId: 19864447 } });
  check('帰属: 署名を検証したコミットでも committer が記名者でなければ数えない', a4b.backed === false && a4b.selfAttested === true, JSON.stringify(a4b));
  const a4c = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: suzuki, config, added: { ...signedAdd, verified: false } });
  check('帰属: ホスティングが署名を検証していないコミットは、committer・author が記名者でも数えない', a4c.backed === false && a4c.selfAttested === true, JSON.stringify(a4c));
  // 出荷の PR の作成者が記名者でも、機械の複製のコミット(github-actions[bot])は記名者以外のコミットに数える。出荷の PR を開いたことは、
  // 記録用ブランチへ誰が様式を足したかを示さない(突合 M-1)。様式は記録用ブランチで様式を足したコミット(a4)か、記名者本人の承認で裏づける
  const shipPull = pull({ number: 31, author: 'suzuki', authorId: UID.suzuki, approvers: [{ login: 'sato', id: UID.sato }], commitAuthors: [{ login: 'github-actions[bot]', id: 41898282 }], headRef: 'ship/2026-10-25' });
  const a11 = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: suzuki, config, introduced: shipPull });
  check('帰属: 出荷の PR の作成者が記名者でも、機械の複製のコミットを含む PR の作成では裏づけない(自己申告)', a11.backed === false && a11.selfAttested === true && same(a11.clerical, ['sato']) && /記名者以外のコミット/.test(a11.note), JSON.stringify(a11));
  const a12 = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: suzuki, config, introduced: { ...shipPull, author: 'sato', authorId: UID.sato, approvers: [{ login: 'suzuki', id: UID.suzuki }] } });
  check('帰属: 出荷の PR を記名者本人が承認すれば裏づける(approval-review)', a12.backed === true && a12.how === 'approval-review', JSON.stringify(a12));
  const a13 = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: suzuki, config, introduced: { ...shipPull, commitAuthors: [{ login: 'suzuki', id: UID.suzuki }], approvers: [] } });
  check('帰属: 作成者が記名者でも、記名者以外の人の承認が無ければ裏づけない', a13.backed === false && a13.selfAttested === true, JSON.stringify(a13));
  // 帰属の確認者を置けない体制(名簿が記名者1名)は、判定記録では自己申告に数える
  const alone = { people: [suzuki] };
  const a14 = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: suzuki, config: alone, introduced: { ...shipPull, commitAuthors: [{ login: 'suzuki', id: UID.suzuki }], approvers: [] } });
  check('帰属: 帰属の確認者を置けない体制で受け付けた記録は、自己申告(how=self-attested)', a14.backed === false && a14.selfAttested === true && a14.how === 'self-attested', JSON.stringify(a14));
  // 名前だけ一致(名簿に無い人)
  const a5 = formAttribution(rec({ ...base, authorEmail: 'someone@example.com', authorLogin: null, signed: false }), { judgeName: '鈴木 一郎', person: null, approvers: null });
  check('帰属: 名簿に無い記名者 → 自己申告(名簿へ対応づかない旨)', a5.backed === false && a5.selfAttested === true && /対応づかない/.test(a5.note), JSON.stringify(a5));
  const a6 = formAttribution(rec({ ...base, authorName: '佐藤 花子', authorEmail: 'sato@example.com', authorLogin: null, signed: false }), { judgeName: '鈴木 一郎', person: suzuki, config, approvers: [] });
  check('帰属: 何も一致しない → 自己申告(how=null)', a6.backed === false && a6.how === null, JSON.stringify(a6));
  const a7 = formAttribution(rec(null), { judgeName: '鈴木 一郎', person: suzuki, config });
  check('帰属: ホスティングの記録が無い → 自己申告(確かめられない旨)', a7.backed === false && /確かめられない/.test(a7.note), JSON.stringify(a7));
  const a8 = formAttribution(rec({ ...base, signed: true }), { judgeName: null, person: null, approvers: ['suzuki'] });
  check('帰属: 記名が無ければ裏づけられない(承認があっても)', a8.backed === false && /記名が無い/.test(a8.note));
  // 名簿のアカウントが複数ある人
  const multi = { id: 'p2', name: '鈴木 一郎', accounts: [{ login: 'suzuki-old', id: 30000009 }, { login: 'suzuki', id: UID.suzuki }] };
  const multiConfig = { ...config, people: config.people.map((p) => (p.id === 'p2' ? multi : p)) };
  const a9 = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: multi, config: multiConfig, introduced: pull({ approvers: [{ login: 'SUZUKI-OLD', id: 30000009 }] }) });
  check('帰属: 名簿の複数のアカウントのいずれか(数値の識別子で照合)で裏づける', a9.backed === true && a9.how === 'approval-review', JSON.stringify(a9));
  // IMPL-0426:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const a10 = formAttribution(rec(bot), { judgeName: '鈴木 一郎', person: suzuki, config, approvers: ['suzuki', { login: 'suzuki', id: 99999999 }] });
  check('帰属: ログイン名だけの承認者・ログイン名が一致し数値の識別子が異なる承認者は、記名者本人の承認に数えない', a10.backed === false && a10.how !== 'approval-review', JSON.stringify(a10));
}

// ---------------------------------------------------------------- PR の記録を gh で取得できないときの後退経路(写しの本文)
{
  const copy = { pr: 7, title: 'feat: x', body: '## 検証方法と結果\n\n- 通過\n\n## リスク区分\n\nR3\n', author: { id: 1, login: 'suzuki' }, merge_commit_sha: 'abc', reviews: [] };
  const r = prRecordFromCopy(copy);
  check('prRecordFromCopy: 題名・本文・作成者・マージコミットを写しから起こし、fromCopy の印を付ける', r.number === 7 && r.title === 'feat: x' && /検証方法と結果/.test(r.body) && r.author.login === 'suzuki' && r.mergeCommit.oid === 'abc' && r.fromCopy === true, JSON.stringify(r));
  check('prRecordFromCopy: gate-g5 の結果・ラベル・作成日時・レビューは写しに無い(null・空)', r.statusCheckRollup === null && r.labels.length === 0 && r.createdAt === null && r.reviews === null);
  check('prRecordFromCopy: 本文の無い写し(旧い形)と写し無しは null', prRecordFromCopy({ pr: 7, reviews: [] }) === null && prRecordFromCopy(null) === null);
  check('prRecordFromCopy: 作成者の無い写しは author=null', prRecordFromCopy({ pr: 7, body: 'x', reviews: [] }).author === null);
}

// ---------------------------------------------------------------- 最新の判定で読む(process-compass #368 の突合 X-2)
{
  const g = (gate, target, result, judgedAt) => ({ file: `docs/gates/${gate}-${judgedAt}.md`, gate, target, result, judgedAt });
  const pass = g('G-4 機能仕様承認', 'F-001 / abc', '通過', '2026-10-20 09:00');
  const reject = g('G-4 機能仕様承認', 'F-001 / def', '差し戻し', '2026-10-21 09:00');
  const onF001 = (o) => /F-001(?!\d)/.test(String(o.target ?? ''));
  check('集約: G-4 の通過の後に同じ仕様の差し戻しがあれば、通過は打ち消される', supersededByLater(pass, [pass, reject], onF001) === true);
  check('集約: 差し戻しの後の通過は打ち消されない', supersededByLater(g('G-4', 'F-001', '通過', '2026-10-22 09:00'), [pass, reject], onF001) === false);
  check('集約: 別の仕様・別のゲートの差し戻しは打ち消さない', supersededByLater(pass, [pass, g('G-4', 'F-002', '差し戻し', '2026-10-21 09:00'), g('G-6', 'F-001', '差し戻し', '2026-10-21 09:00')], onF001) === false);
  check('集約: 同じ時刻の差し戻しは打ち消す(安全側)', supersededByLater(pass, [pass, g('G-4', 'F-001', '差し戻し', '2026-10-20 09:00')], onF001) === true);
  const rj = (result, at, specs = ['F-001'], judgeOk = true) => ({ gate: 'G-4', result, submittedAt: at, specs, judgeOk });
  const rp = rj('通過', '2026-10-20T00:00:00Z');
  check('集約: 写しの G-4 の通過の後に同じ仕様の差し戻しの宣言があれば、打ち消される', reviewSupersededByLater(rp, [rp, rj('差し戻し', '2026-10-21T00:00:00Z')], 'F-001') === true);
  check('集約: 写しの差し戻しが前か、別の仕様か、判定する席の責任者でない者のものなら打ち消さない', reviewSupersededByLater(rp, [rp, rj('差し戻し', '2026-10-19T00:00:00Z'), rj('差し戻し', '2026-10-21T00:00:00Z', ['F-002']), rj('差し戻し', '2026-10-21T00:00:00Z', ['F-001'], false)], 'F-001') === false);
}

console.log('');
if (failures) {
  console.log(`承認レビューの写しと記録用ブランチの集約の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`承認レビューの写しと記録用ブランチの集約の試験: ${n} 件が期待と一致しました`);
