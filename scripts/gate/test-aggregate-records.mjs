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
//   - 既定ブランチ以外へ取り込んだマージの、写しの base.ref による検出(process-compass #360 H-4 / IMPL-0248)
// 記録用ブランチの git からの読み取りそのものは test-records.mjs が確かめます。GitHub へ問い合わせません。

import * as JR from './judgement-records.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  g7StatusText,
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
  offDefaultMerges,
  offDefaultMergesText,
  OFF_DEFAULT_MERGE_LIMIT_TEXT,
  formAttribution,
  prRecordFromCopy,
  targetOfForm,
  judgeOfForm,
  supersededByLater,
  reviewSupersededByLater,
  verificationSectionDiffers,
  verificationDiffText,
  r2G6UnmetOf,
  r2G6UnmetLine,
  inputRecordGaps,
  stackedLayerCheck,
  stackedLayerText,
  samplingMonthly,
  samplingMonthlyText,
} from './aggregate-evidence.mjs';
import { stopFindings } from './check-pr.mjs';
import { fastTrackMarkOf, fastTrackMetrics, fastTrackMetricsText, restrictedStateExceptions, exceptionQuotaText } from './exception-expiry.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import { ROOT, sealChangeLog, unmetShipGaps, derivedUnmet, delegationSamplingProblems } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

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

// ---------------------------------------------------------------- 既定ブランチ以外へ取り込んだマージ(process-compass #360 H-4 / IMPL-0248)
// 出荷の範囲の写しの base.ref を既定ブランチと比べ、検出あり / 0 件 / 未確認 の3値で出す。合否・欠落に使わない(返り値に gaps を持たない)
{
  const cp = (pr, base, extra = {}) => [pr, { copy: { pr, merged_at: '2026-11-01T00:00:00Z', base: base === undefined ? undefined : { ref: base }, default_branch: 'main', ...extra } }];
  const MAIN = { name: 'main', how: 'ホスティング' };

  // IMPL-0248:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  // 手動のスタックの中間の層(feature/a)へ取り込んだマージを、PR 番号と base.ref で出す
  const ng = offDefaultMerges({ copies: new Map([cp(21, 'main'), cp(22, 'feature/a')]), defaultBranch: MAIN });
  check('中間の層のマージ: 写しの base.ref が既定ブランチでなければ「検出あり」', ng.status === 'detected', JSON.stringify(ng));
  check('中間の層のマージ: PR 番号と base.ref の一覧を出す', same(ng.detected.map((d) => [d.pr, d.baseRef, d.defaultBranch]), [[22, 'feature/a', 'main']]), JSON.stringify(ng.detected));
  check('中間の層のマージ: 検出しても欠落・失敗の値を持たない(合否に使わない)', !('gaps' in ng) && !('errors' in ng) && !('ok' in ng));
  check('中間の層のマージ: 開示の文に PR 番号・base.ref と定型の限界の文を出す', /検出あり 1 件/.test(offDefaultMergesText(ng)) && /#22\(base\.ref feature\/a\)/.test(offDefaultMergesText(ng)) && offDefaultMergesText(ng).includes(OFF_DEFAULT_MERGE_LIMIT_TEXT));

  // IMPL-0248:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const ok = offDefaultMerges({ copies: new Map([cp(21, 'main'), cp(23, 'main')]), defaultBranch: MAIN });
  check('既定ブランチへのマージだけ: 「0 件」', ok.status === 'none' && ok.detected.length === 0 && ok.checked === 2, JSON.stringify(ok));
  check('0 件でも「PR を経ない push による取り込みは拾わない」の定型の文を出す', /PR を経ない push による取り込み/.test(offDefaultMergesText(ok)) && /^0 件/.test(offDefaultMergesText(ok)));

  // 未確認: 写しが読めない・base.ref が無い・写しが無い・既定ブランチの名前が読めない
  const noBase = offDefaultMerges({ copies: new Map([cp(24, undefined)]), defaultBranch: MAIN });
  check('base.ref の無い写しは「未確認」(既定ブランチへのマージに数えない)', noBase.status === 'unconfirmed' && noBase.unconfirmed[0]?.pr === 24 && /base\.ref が無い/.test(noBase.unconfirmed[0]?.reason), JSON.stringify(noBase));
  const unread = offDefaultMerges({ copies: new Map(), available: false });
  check('写しの置き場を読めなければ「未確認」(0 件と出さない)', unread.status === 'unconfirmed' && /読めない/.test(unread.reason) && /^\*\*未確認\*\*/.test(offDefaultMergesText(unread)));
  const skipped = offDefaultMerges({ copies: new Map([cp(21, 'main')]), skipped: [{ file: 'records/reviews/pr-25.json', reason: 'JSON として読めない' }], defaultBranch: MAIN });
  check('読めない写しのファイルは「未確認」に数える', skipped.status === 'unconfirmed' && skipped.unconfirmed.some((u) => u.pr === 25), JSON.stringify(skipped));
  const missing = offDefaultMerges({ copies: new Map([cp(21, 'main')]), missing: [26], defaultBranch: MAIN });
  check('範囲のマージで写しの無いものは「未確認」に数える', missing.status === 'unconfirmed' && missing.unconfirmed.some((u) => u.pr === 26 && /写しが無い/.test(u.reason)));
  const noDef = offDefaultMerges({ copies: new Map([cp(27, 'feature/a', { default_branch: undefined })]), defaultBranch: null });
  check('写しにも集約にも既定ブランチの名前が無ければ、推測せず「未確認」', noDef.status === 'unconfirmed' && noDef.detected.length === 0, JSON.stringify(noDef));
  const fb = offDefaultMerges({ copies: new Map([cp(28, 'feature/a', { default_branch: undefined })]), defaultBranch: MAIN });
  check('写しに default_branch が無い古い写しは、集約の既定ブランチで比べる(出所を併記)', fb.status === 'detected' && fb.detected[0]?.defaultFrom === 'ホスティング', JSON.stringify(fb));
  const own = offDefaultMerges({ copies: new Map([cp(29, 'develop', { default_branch: 'develop' })]), defaultBranch: MAIN });
  check('写しの default_branch(マージの時点の既定ブランチ)を集約の値より先に使う', own.status === 'none', JSON.stringify(own));
  const both = offDefaultMerges({ copies: new Map([cp(22, 'feature/a'), cp(24, undefined)]), defaultBranch: MAIN });
  check('検出と未確認が並べば「検出あり」とし、未確認の写しも併記する', both.status === 'detected' && both.unconfirmed.length === 1 && /確かめられない写し 1 件/.test(offDefaultMergesText(both)));
  const range = offDefaultMerges({ copies: new Map([cp(22, 'feature/a'), cp(30, 'feature/b')]), inRange: (n) => n === 30, skipped: [{ file: 'records/reviews/pr-22.json', reason: 'x' }], defaultBranch: MAIN });
  check('出荷の範囲の外の写し・読めないファイルは数えない', same(range.detected.map((d) => d.pr), [30]) && range.unconfirmed.length === 0 && range.checked === 1, JSON.stringify(range));
}

// 「検証方法と結果」の節の、写し(マージの時点)と今の本文の比較(process-compass #333 / ADR-0135 決定5。所見であり欠落にしない。実装マークは付けない)
{
  const body = (v) => `## 変更の概要\n\nx\n\n## 検証方法と結果\n\n${v}\n\n## リスク区分\n\nR3\n`;
  const d1 = verificationSectionDiffers(body('単体テストを実行した'), body('単体テストを実行した。全件成功'));
  check('検証の節の比較: 節が食い違えば不一致(compared)', d1.compared && d1.differs, JSON.stringify(d1));
  const d2 = verificationSectionDiffers(body('単体テストを実行した  '), body('単体テストを実行した').replace(/\n/g, '\r\n'));
  check('検証の節の比較: 行末の空白と改行の違いは一致とする', d2.compared && !d2.differs, JSON.stringify(d2));
  const d3 = verificationSectionDiffers(body('a'), body('a').replace('リスク区分\n\nR3', 'リスク区分\n\nR2'));
  check('検証の節の比較: 別の節の編集は不一致にしない', d3.compared && !d3.differs, JSON.stringify(d3));
  const d4 = verificationSectionDiffers(null, body('a'));
  check('検証の節の比較: 写しの本文が無ければ比べない', !d4.compared && !d4.differs, JSON.stringify(d4));
  const d5 = verificationSectionDiffers(body('a'), undefined);
  check('検証の節の比較: ホスティングの本文を読めなければ比べない', !d5.compared && !d5.differs, JSON.stringify(d5));
  const txt = verificationDiffText(12);
  check('検証の節の所見の文: 限定を同じ文に書く(マージより前の編集・書き換え・妥当性は見ない。欠落にしない)', /マージより前の編集/.test(txt) && /写しの書き換え/.test(txt) && /内容の妥当性も見ない/.test(txt) && /欠落にしない/.test(txt), txt);
}

// ---------------------------------------------------------------- G-7 の成立の表示は、構成と同じ席で語る(IMPL-0988。process-compass #351)
{
  const mk = (merged, map) => {
    const seats = Object.entries(map).map(([role, accountable]) => ({ role, accountable }));
    const who = (role) => seats.find((x) => x.role === role)?.accountable ?? null;
    return g7StatusText({ config: { gates: { g7: { params: { approverMode: merged ? 'value-owner-merged' : 'dedicated-qa' } } } }, seats, deviation: null, active: true, omitted: '省略', whoKey: who, whoName: who });
  };
  // IMPL-0988:ok(適合の入力: 価値責任者の兼務の構成で、判定する席 value-owner が別の人なら、qa-gatekeeper の席が未割当・同一でも成立の側)
  check('G-7 の成立: 兼務の構成では価値責任者の席で判定する(qa-gatekeeper が未割当でも成立)', /^成立\(/.test(mk(true, { 'value-owner': 'b', 'dev-verifier': 'a' })));
  check('G-7 の成立: 兼務の構成では価値責任者の席で判定する(qa-gatekeeper が開発者と同じでも成立)', /^成立\(/.test(mk(true, { 'value-owner': 'b', 'dev-verifier': 'a', 'qa-gatekeeper': 'a' })));
  // IMPL-0988:ng(違反の入力: 判定する席が未記入・開発者と同一なら成立と言わない)
  check('G-7 の成立: 兼務の構成で価値責任者の席が未記入なら成立を確認できない', /成立を確認できない.*価値責任者の席/.test(mk(true, { 'dev-verifier': 'a', 'qa-gatekeeper': 'b' })));
  check('G-7 の成立: 兼務の構成で価値責任者が開発者と同一なら成立しない(qa-gatekeeper が別の人でも)', /^成立しない/.test(mk(true, { 'value-owner': 'a', 'dev-verifier': 'a', 'qa-gatekeeper': 'b' })));
  check('G-7 の成立: 兼務でない構成は qa-gatekeeper の席で判定する(未記入なら確認できない・同一なら成立しない)', /成立を確認できない.*出荷判定者の席/.test(mk(false, { 'value-owner': 'b', 'dev-verifier': 'a' })) && /^成立しない/.test(mk(false, { 'value-owner': 'b', 'dev-verifier': 'a', 'qa-gatekeeper': 'a' })));
}

// ---------------------------------------------------------------- 開示の表示(IMPL-0739・IMPL-0631・IMPL-0687)
{
  const unit = (label, riskClass, counted) => ({ label, riskClass, independent: { counted } });
  // IMPL-0739:ng(違反の入力。G-6 未達の R2 が 2 件あるのに数えない)
  const labels = r2G6UnmetOf([unit('PR #1', 'R2', false), unit('PR #2', 'R2', false), unit('PR #3', 'R2', true), unit('PR #4', 'R1', false), unit('PR #5', 'R3', false)]);
  check('IMPL-0739:ng G-6 未達のまま入った R2 の変更だけを数える(確認済みの R2・R1・R3 は数えない)', labels.join() === 'PR #1,PR #2', labels.join());
  // IMPL-0739:ok(適合の入力。行があり件数が出る。0 件も行を出す)
  check('IMPL-0739:ok 項目3 の行に件数が出る(2 件。0 件も行を出し、止めない旨を添える)', /^- G-6 未達のまま入った R2.*止めない.*: 2 件\(PR #1, PR #2\)/.test(r2G6UnmetLine(labels, '値なし')) && /: 0 件 \(/.test(r2G6UnmetLine([], '0 件')));
  // IMPL-0631:ng(違反の入力。ラベルの付いた PR は停止の申し立てとして保留に数える)
  const gitNone = () => null;
  check('IMPL-0631:ng 停止のラベル state:stop-requested が付いた PR は申し立てとして数える', stopFindings({ git: gitNone, base: 'HEAD', pr: { number: 5, labels: ['state:stop-requested'] } }).requested === true);
  // IMPL-0631:ok(適合の入力。G-8 の異議の記入だけでは、停止の申し立ての保留にならない)
  check('IMPL-0631:ok ラベルが無い PR は、G-8 の「出荷判定者の異議」を記入しても申し立てに数えない', stopFindings({ git: gitNone, base: 'HEAD', pr: { number: 5, labels: [], reviews: [{ state: 'COMMENTED', body: '出荷判定者の異議: 異議あり' }] } }).requested === false);
  // IMPL-0687:ng(違反の入力。D-0 も変更記録も無いのに欠落が 0 件)
  check('IMPL-0687:ng D-0 の不在と構成の変更記録の不在を、記載の欠落にする', inputRecordGaps({ d0Present: false, changeLogCount: 0 }).length === 2);
  // IMPL-0687:ok(適合の入力)
  check('IMPL-0687:ok D-0 と変更記録がそろえば欠落は出ない', inputRecordGaps({ d0Present: true, changeLogCount: 3 }).length === 0);
}
{
  // 入力を欠いた出力でも、7 つの見出しと成立判定が本文つきで出る(IMPL-0687)。D-0 を取り除いた一時の置き場で集約を動かす
  const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-agg-rec-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const co = path.join(dir, '.github/CODEOWNERS');
  fs.writeFileSync(co, fs.readFileSync(co, 'utf8').replace(/@OWNER\b/g, '@tester'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  const COMMON = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free', 'q-biz-phase': 'growth', 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' };
  const PEOPLE = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊己'[i]}`, accounts: [`acc${i}`] }));
  const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p5', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
  const log = console.log;
  console.log = () => {};
  let cfg;
  try {
    cfg = buildConfig(COMMON, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config;
  } finally {
    console.log = log;
  }
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(sealChangeLog(JSON.parse(JSON.stringify(cfg))), null, 2) + '\n');
  fs.rmSync(path.join(dir, 'docs/D-0-governance.md'), { force: true });
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: init');
  const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs', '--exception-day', '2026-11-20'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' } });
  let ev = null;
  let report = '';
  try {
    ev = JSON.parse(fs.readFileSync(path.join(dir, 'evidence/evidence.json'), 'utf8'));
    const rf = ['evidence/report.md', 'evidence/quality-report.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    report = rf ? fs.readFileSync(rf, 'utf8') : '';
  } catch {
    // 読めなければ空
  }
  fs.rmSync(dir, { recursive: true, force: true });
  check('IMPL-0687:ng 集約(D-0 なし): D-0 の不在が記載の欠落に出る', (ev?.gaps ?? []).some((g) => /D-0\(docs\/D-0-governance\.md\)がありません/.test(g)), `${r.status} ${(r.stdout + r.stderr).slice(-300)}`);
  const body = (n) => {
    const m = new RegExp(`^### ${n}\\. .*\\n([\\s\\S]*?)(?=^### \\d\\. |^## |$(?![\\s\\S]))`, 'm').exec(report);
    return (m?.[1] ?? '').trim();
  };
  check('IMPL-0687:ok 入力を欠いた出力でも、項目1〜7 の見出しが在り、本文が空でない', [1, 2, 3, 4, 5, 6, 7].every((k) => body(k).length > 0), [1, 2, 3, 4, 5, 6, 7].map((k) => `${k}:${body(k).length}`).join(' '));
  check('IMPL-0687:ok 入力を欠いた出力でも、保証の主張の成立判定の見出しが本文つきで出る', /### 保証の主張の成立判定\n+\S/.test(report));
}

// ---------------------------------------------------------------- 実行の記録の集計(IMPL-0828・IMPL-0743・IMPL-1019。ADR-0222)
// AI の印のあるコミットを、指示資産の版の特定の可否で 5 区分に分けて件数を出し、外す対象の一覧と切り替えの期間のコミットの一覧を出す。
// 実物の集約を、トレーラ付きのコミットを持つ一時の置き場で動かす
{
  const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-agg-run-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const co = path.join(dir, '.github/CODEOWNERS');
  fs.writeFileSync(co, fs.readFileSync(co, 'utf8').replace(/@OWNER\b/g, '@tester'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  const COMMON = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free', 'q-biz-phase': 'growth', 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' };
  const PEOPLE = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊己'[i]}`, accounts: [`acc${i}`] }));
  const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p5', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
  const log = console.log;
  console.log = () => {};
  let cfg;
  try {
    cfg = buildConfig(COMMON, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config;
  } finally {
    console.log = log;
  }
  fs.rmSync(path.join(dir, 'docs/D-0-governance.md'), { force: true });
  const cfgPath = path.join(dir, 'process.config.json');
  cfg = JSON.parse(JSON.stringify(sealChangeLog(JSON.parse(JSON.stringify(cfg)))));
  cfg.changeLog = [...(Array.isArray(cfg.changeLog) ? cfg.changeLog : []), { kind: 'outage', date: '2026-11-01', summary: '切り替え', result: 'no-change', outage: { from: '2000-01-01', handling: 'human', switched: true } }];
  fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(JSON.parse(JSON.stringify(cfg))), null, 2) + '\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: init');
  const SHA = 'a'.repeat(64);
  const mk = (name, msg) => {
    fs.writeFileSync(path.join(dir, name), name + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', msg);
  };
  mk('c1.txt', 'feat: clean\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nAgent-Run: r1\nAgent-Assets: sha256:' + SHA + '; base=' + 'b'.repeat(40) + '; assets=clean; user-scope=unrecorded');
  mk('c2.txt', 'feat: dirty\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nAgent-Run: r2\nAgent-Assets: sha256:' + SHA + '; base=' + 'b'.repeat(40) + '; assets=dirty; user-scope=unrecorded');
  mk('c3.txt', 'feat: unknown\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nAgent-Run: r3\nAgent-Assets: unknown(no-run-record)');
  mk('c4.txt', 'feat: no trailer\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>');
  mk('c5.txt', 'fix: human');
  const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs', '--exception-day', '2026-11-20'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' } });
  let report = '';
  try {
    const rf = ['evidence/report.md', 'evidence/quality-report.md'].map((f2) => path.join(dir, f2)).find((f2) => fs.existsSync(f2));
    report = rf ? fs.readFileSync(rf, 'utf8') : '';
  } catch {
    // 読めなければ空
  }
  const hashes = git('log', '--format=%h %s').split('\n');
  const short = (subj) => (hashes.find((l) => l.endsWith(' ' + subj)) ?? '').slice(0, 7);
  fs.rmSync(dir, { recursive: true, force: true });
  const line = (report.split('\n').find((l) => l.includes('AI の印のあるコミットの指示資産の版')) ?? '');
  // IMPL-0828:ng(切り替えの期間があるのに一覧が出ない)
  const sw = (report.split('\n').find((l) => l.includes('切り替えの期間(1 件)に生成された')) ?? '');
  check('IMPL-0828:ng 切り替えの期間があれば、AI の印のあるコミットの一覧を出す(4 件)', /AI の印のあるコミット 4 件/.test(sw) && sw.includes(short('feat: no trailer')), sw || (r.stdout + r.stderr).slice(-300));
  // IMPL-0828:ok(期間の件数と一覧)
  check('IMPL-0828:ok 人のコミットは切り替えの期間の一覧に入らない', sw !== '' && !sw.includes(short('fix: human')), sw);
  check('IMPL-1019:ok 5 区分の件数を出す(特定できる 2 件・うち変更あり 1 件・特定できない 2 件)', /AI の印 4 件\): 版を特定できる 2 件\(うち指示資産にコミットに無い変更あり 1 件\)\/ 特定できない 2 件\(記録なし・読めない 1 件、トレーラなし 1 件\)/.test(line), line);
  // IMPL-0743:ng の入力(unknown が外す対象の一覧に出ない)を見る
  const ex = (report.split('\n').find((l) => l.includes('監査の抽出から外す対象')) ?? '');
  check('IMPL-0743 の入力: unknown とトレーラなしが外す対象の一覧に出て、版を特定できるものは出ない', ex.includes(short('feat: unknown')) && ex.includes(short('feat: no trailer')) && !ex.includes(short('feat: clean')) && !ex.includes(short('feat: dirty')), ex);
}

// ---------------------------------------------------------------- 第7章の行使(IMPL-0612・IMPL-0628・IMPL-0669)
{
  const ex = (id, target, content, state = '未返却', due = '2026-12-31 まで。回収責任者 名簿 丙', approver = '名簿 乙') => ({ id, kind: '例外', target, content, state, due, approver });
  // IMPL-0612:ng(違反の入力。太字・バッククォート・括弧の前の空白の印を読めない)
  const forms = ['ファストトラック(短縮: G-6)', '**ファストトラック(短縮: G-6)**', '`ファストトラック(短縮: G-6)`', 'ファストトラック (短縮: G-6)', 'ファストトラック（短縮：G-6）'];
  check('IMPL-0612:ng 太字・バッククォート囲み・括弧の前の空白・全角の印を、同じ印として読む', forms.every((f) => fastTrackMarkOf(f + ' 内容')?.scope === 'G-6'), forms.map((f) => fastTrackMarkOf(f)?.scope).join());
  check('IMPL-0612:ng 太字の印が G-5 を名指す行も scope に G-5 が出る(check-pr の拒否に届く)', /G-?5/.test(fastTrackMarkOf('**ファストトラック(短縮: G-5)** 内容')?.scope ?? ''));
  // IMPL-0612:ok(適合の入力。印の無い行・別の語は印にならない。発生率と回収完了率が出る)
  check('IMPL-0612:ok 印の無い行と別の語は印として読まない', fastTrackMarkOf('G-6 基準4 を満たさない') === null && fastTrackMarkOf('急ぎのファストトラック(短縮: G-6)') === null);
  const rows = [ex('D-1', 'PR #1', 'ファストトラック(短縮: G-6) 急ぎ', '返却済み(2026-11-18)'), ex('D-2', 'PR #2', '**ファストトラック(短縮: G-6)** 急ぎ'), ex('D-3', 'PR #3', '印なしの例外')];
  const defects = '| ID | 現象 | 原因の変更 | 処分 | 確定した者 | 確定日 |\n| --- | --- | --- | --- | --- | --- |\n| X-1 | a | PR #1 | 欠陥 | 名簿 甲 | 2026-11-10 |\n| X-2 | b | | 欠陥 | 名簿 甲 | 2026-11-10 |\n| X-3 | c | PR #9 | 欠陥 | 名簿 甲 | 2026-11-10 |\n| X-4 | d | PR #2 | 欠陥 | | |\n';
  const m = fastTrackMetrics({ rows, changeTotal: 4, defectText: defects });
  check('IMPL-0612:ok 印 2 件・回収 1 件(回収完了率 50%)。欠陥は結べた件数と空欄の件数を併記する(確定していない行は数えない)', m.marked === 2 && m.closed === 1 && m.defects.confirmed === 3 && m.defects.linked === 1 && m.defects.causeBlank === 1 && /回収完了率 50%/.test(fastTrackMetricsText(m)) && /発生率 50%/.test(fastTrackMetricsText(m)) && /結べた 1 件.*空欄で結べない 1 件/.test(fastTrackMetricsText(m)), JSON.stringify(m) + fastTrackMetricsText(m));
  // IMPL-0628:ng(違反の入力。7.9.4 の行の承認者が B-2 の決定者でない。回収責任者が無い)
  const units = [{ label: '#10', independent: { restrictionTouched: true, by: ['a'] } }, { label: '#11', independent: { restrictionTouched: true, by: ['a', 'b'] } }, { label: '#12', independent: { restrictionTouched: false, by: [] } }, { label: 'コミット abcdef12', independent: { restrictionTouched: true, by: [] } }];
  const isDecider = (a) => (a === '名簿 乙' ? true : a === '名簿 丁' ? false : null);
  const bad = restrictedStateExceptions({ rows: [ex('D-10', 'PR #10', 'ファストトラック(短縮: G-6) 急ぎ', '未返却', '2026-12-31 まで', '名簿 丁')], units, isDecider });
  check('IMPL-0628:ng 7.9.4 の行の承認者が B-2 の決定者でない・回収責任者が無いとき、欠落にする', bad.found.length === 1 && bad.gaps.length === 2 && /B-2 の決定者/.test(bad.gaps[0]) && /回収責任者/.test(bad.gaps[1]), bad.gaps.join('\n'));
  // IMPL-0628:ok(適合の入力。B-2 の決定者の記名・期限と回収責任者あり。印の無い行は件数に出るが通る。2 名の承認がある変更・制限に触れない変更は 7.9.4 でない)
  const good = restrictedStateExceptions({ rows: [ex('D-10', 'PR #10', '印なしの例外'), ex('D-11', 'PR #11', 'x'), ex('D-12', 'PR #12', 'x'), ex('D-13', 'abcdef1234', 'x')], units, isDecider });
  check('IMPL-0628:ok B-2 の決定者の記名と期限・回収責任者があれば欠落なし。印の無い行は件数に出る。2 名承認・制限外の変更は対象でない', good.gaps.length === 0 && good.found.map((x) => x.id).join() === 'D-10,D-13' && good.unmarked.join() === 'D-10,D-13', JSON.stringify(good));
  check('IMPL-0628:ok 承認した者が B-2 の決定者かを確認できない(isDecider が null)とき、欠落にせず未確認に出す', restrictedStateExceptions({ rows: [ex('D-10', 'PR #10', 'x', '未返却', '2026-12-31 まで。回収責任者 名簿 丙', '外部の人')], units, isDecider }).unconfirmed.join() === 'D-10');
  // IMPL-0669:ng(違反の入力。枠 2・行使 3 で残りが出ない)
  const brief = '| 項目 | 内容 |\n| --- | --- |\n| 例外の枠(事業ステージあたり) | 2 |\n';
  check('IMPL-0669:ng 枠 2・行使 3 で「残り -1(超過)」を出し、止めない旨を添える', /枠 2・行使 3・残り -1\(超過\).*止めない/.test(exceptionQuotaText({ briefText: brief, used: 3 })), exceptionQuotaText({ briefText: brief, used: 3 }));
  // IMPL-0669:ok(適合の入力。枠が読めない・累計が読めないときは「確認できない」)
  check('IMPL-0669:ok 枠が件数として読めない、またはステージの累計を読めないとき、確認できないと出す', /枠: 確認できない/.test(exceptionQuotaText({ briefText: '| 例外の枠(事業ステージあたり) | <件数> |', used: 1 })) && /累計を確認できない/.test(exceptionQuotaText({ briefText: brief, used: 0, usedReadable: false })));
}

// ---------------------------------------------------------------- 判定記録(IMPL-0667・IMPL-0622・IMPL-0638)
{
  const rec = (file, judgedAt, cls, verdict, declared = null, inRange = true) => ({ file, judgedAt, cls, verdict, declared, inRange, readable: true });
  // IMPL-0667:ng(違反の入力。乙の継続が 4 件目。先行の計数 3 件なのに欄が「通算 1 回」)
  const four = [rec('a', '2026-01-01 10:00', '乙', '継続', null, false), rec('b', '2026-02-01 10:00', '丙', '保留', null, false), rec('c', '2026-03-01 10:00', '乙', '継続', null, false), rec('d', '2026-04-01 10:00', '乙', '継続')];
  const r4 = JR.reachCounts(four);
  check('IMPL-0667:ng 乙・丙の継続・保留が 4 件目の記録(範囲の中)を欠落にする', r4.gaps.length === 1 && /d/.test(r4.gaps[0]) && /4 回目/.test(r4.gaps[0]), JSON.stringify(r4.gaps));
  const low = JR.reachCounts([...four.slice(0, 2), rec('c', '2026-03-01 10:00', '乙', '継続', 1)]);
  check('IMPL-0667:ng 欄の「通算 1 回」が数えた回数 3 より小さい記録を欠落にする(人が書いた回数を下げる向きに使えない)', low.gaps.length === 1 && /通算 1 回/.test(low.gaps[0]), JSON.stringify(low.gaps));
  // IMPL-0667:ok(適合の入力。3 件目の継続。甲へ戻した継続・中止は数えない。欄が大きければ欄を使う。読めない判定は件数に出す)
  const three = JR.reachCounts(four.slice(0, 3).map((r) => ({ ...r, inRange: true })));
  check('IMPL-0667:ok 3 件目の継続は欠落にならない', three.gaps.length === 0 && three.total === 3, JSON.stringify(three));
  const mixed = JR.reachCounts([rec('a', '2026-01-01 10:00', '乙', '継続'), rec('b', '2026-02-01 10:00', '甲', '継続'), rec('c', '2026-03-01 10:00', '丙', '中止'), rec('d', '2026-04-01 10:00', '乙', '保留'), rec('e', '2026-05-01 10:00', '乙', '継続')]);
  check('IMPL-0667:ok 甲の継続と中止は数えない(乙・丙の継続・保留の 3 件)', mixed.total === 3 && mixed.gaps.length === 0, JSON.stringify(mixed));
  const carry = JR.reachCounts([rec('a', '2026-01-01 10:00', '乙', '継続', 2), rec('b', '2026-02-01 10:00', '乙', '継続'), rec('c', '2026-03-01 10:00', '乙', '継続')]);
  check('IMPL-0667:ok 欄の値が数えた回数より大きければ欄の値から続けて数える(欄「通算 2 回」の次の 2 件で 4 回目)', carry.gaps.length === 1 && /c/.test(carry.gaps[0]), JSON.stringify(carry.gaps));
  const unread = JR.reachCounts([{ file: 'x', judgedAt: '2026-01-01 10:00', cls: null, verdict: null, declared: null, inRange: true, readable: false }]);
  check('IMPL-0667:ok 判定の欄が読めない記録は未確認として件数に出し、欠落にしない', unread.unreadable.length === 1 && unread.gaps.length === 0 && /未確認 1 件/.test(JR.reachCountsText(unread)), JR.reachCountsText(unread));
  const parsed = JR.reachRecordOf({ file: 'docs/gates/p.md', judgedAt: '2026-03-01 10:00', inRange: true, text: '| 判定 | 継続 |\n| 7.7.5 の回数 | 通算 2 回。丙のまま |\n\n## 到達の見込み\n\n| 区分 | 期間 丙 / 案件 乙 |\n' });
  check('IMPL-0667:ok 判定記録の本文から、案件の区分・判定・欄の「通算 N 回」を読む', parsed?.cls === '乙' && parsed.verdict === '継続' && parsed.declared === 2, JSON.stringify(parsed));
  // F-01: 実物の様式 04 の全文を入力にする(冒頭の表の「判定者」「判定日時」が「判定」より先にある配置)
  {
    const form = fs.readFileSync(path.join(ROOT, 'templates/04-gate-record.md'), 'utf8').replace(/\r\n/g, '\n');
    const filled = (verdict) => form
      .replace(/^\| 判定 \| 継続 \/ 中止[^\n]*$/m, `| 判定 | ${verdict} |`)
      .replace(/^\| 区分 \| <組ごとの区分[^\n]*$/m, '| 区分 | 期間 乙 / 案件 乙 |');
    const real = JR.reachRecordOf({ file: 'docs/gates/real.md', judgedAt: '2026-03-01 10:00', inRange: true, text: filled('継続') });
    check('IMPL-0667:ng 様式 04 の全文を埋めた記録から、判定(継続)と区分(乙)を読める(判定者の行に当たらない)', real.verdict === '継続' && real.cls === '乙' && real.readable === true, JSON.stringify(real));
    const four = [1, 2, 3, 4].map((i) => JR.reachRecordOf({ file: 'r' + i, judgedAt: '2026-0' + i + '-01 10:00', inRange: true, text: filled('継続') }));
    const cnt = JR.reachCounts(four);
    check('IMPL-0667:ng 様式 04 の全文を埋めた乙の継続 4 件で、4 回目が欠落になる', cnt.total === 4 && cnt.gaps.length === 1 && cnt.unreadable.length === 0, JSON.stringify(cnt));
    const blank = JR.reachRecordOf({ file: 'docs/gates/blank.md', judgedAt: '2026-03-01 10:00', inRange: true, text: form.replace(/^\| 区分 \| <組ごとの区分[^\n]*$/m, '| 区分 | 期間 乙 / 案件 乙 |') });
    check('IMPL-0667:ok 様式のままの判定の行(継続 / 中止 / 保留 / 差し戻し)は継続と読まず、未確認に数える', blank.verdict === null && blank.readable === false, JSON.stringify(blank));
    check('IMPL-0667:ok 判定と同時に確定した事項の行を判定として読まない', JR.reachRecordOf({ file: 'x', judgedAt: '2026-03-01 10:00', inRange: true, text: '| 判定者 | 甲 |\n| 判定と同時に確定した事項 | 継続 |\n\n## 到達の見込み\n\n| 区分 | 案件 乙 |\n' }).verdict === null);
  }
  // IMPL-0622:ng(違反の入力。S1 で記録なしなのに注意が出ない)
  const none = JR.inventoryNotice({ records: [{ gate: '必達基準の判定(ステージの途中)', judgedAt: '2026-01-01 10:00' }], stage: 'S1', day: '2026-11-18' });
  check('IMPL-0622:ng S1 以降で棚卸しの判定記録が無いとき、注意を出す(止めない)', none.level === 'attention' && /記録なし/.test(none.text) && /止めない/.test(none.text), JSON.stringify(none));
  const old = JR.inventoryNotice({ records: [{ gate: '棚卸し', judgedAt: '2025-10-01 10:00' }], stage: 'S2', day: '2026-11-18' });
  check('IMPL-0622:ng 最終の棚卸しから 365 日を超えたとき、経過日数とともに注意を出す', old.level === 'attention' && /最終 2025-10-01/.test(old.text) && /413 日/.test(old.text), JSON.stringify(old));
  // IMPL-0622:ok(適合の入力。最終 2026-03-01、経過 262 日。S0 は対象外)
  const okN = JR.inventoryNotice({ records: [{ gate: '棚卸し', judgedAt: '2026-03-01 10:00' }, { gate: '棚卸し', judgedAt: '2025-01-01 10:00' }], stage: 'S1', day: '2026-11-18' });
  check('IMPL-0622:ok 最終 2026-03-01、経過 262 日と出る。注意にしない', okN.level === 'ok' && /最終 2026-03-01/.test(okN.text) && /262 日/.test(okN.text), JSON.stringify(okN));
  check('IMPL-0622:ok S0 は対象外と出す(S1 以降の規定)', JR.inventoryNotice({ records: [], stage: 'S0', day: '2026-11-18' }).level === 'na');
  // IMPL-0638:ng(違反の入力。暫定任命の期間内の G-3 に併記が無い。AI の名義・判定者本人・名簿の人でない)
  const d0 = [
    '## 9. 代行者(代理者)と後継', '',
    '| 役割 | 代行者(後継候補) | 代行できる範囲 | 代理者の確認の状態 | 確認日 |', '| --- | --- | --- | --- | --- |', '| 技術判断者 | 名簿 戊 | 全て | 暫定任命 | |', '',
    '**暫定任命の期間(標準 第3章 3.4.1)**', '',
    '| 役割 | 暫定任命の対象(責任者 / 代理者) | 暫定任命の期間(開始日〜満了日) | 満了時の扱い | 延長の決裁 |', '| --- | --- | --- | --- | --- |',
    '| 技術判断者 | 責任者 | 2026-10-01〜2026-12-31 | 任命を解く | |', '| 価値責任者 | 責任者 | いつか | 任命を解く | |', '',
  ].join('\n');
  const ids = new Map([['名簿 甲', 'p1'], ['名簿 乙', 'p2'], ['名簿 戊', 'p5'], ['AI 担い手', 'ai']]);
  const resolve = (n) => ids.get(String(n ?? '').trim()) ?? null;
  const isAi = (n) => /AI/.test(String(n));
  const holderOf = (role) => (role === '技術判断者' ? 'p1' : role === '価値責任者' ? 'p2' : null);
  const roleOfGate = (gate) => (/G-?3/.test(gate) ? ['技術判断者'] : /G-?6/.test(gate) ? ['独立レビュア'] : []);
  const rs = [
    { file: 'g3-nocosign', gate: 'G-3 判断記録', judge: '名簿 甲', judgedAt: '2026-11-01 10:00', coSign: '' },
    { file: 'g3-ai', gate: 'G-3', judge: '名簿 甲', judgedAt: '2026-11-02 10:00', coSign: 'AI 担い手' },
    { file: 'g3-self', gate: 'G-3', judge: '名簿 甲', judgedAt: '2026-11-03 10:00', coSign: '名簿 甲' },
    { file: 'g3-notroster', gate: 'G-3', judge: '名簿 甲', judgedAt: '2026-11-04 10:00', coSign: '外部 某' },
  ];
  const bad = JR.provisionalGaps({ d0Text: d0, records: rs, resolve, isAi, holderOf, roleOfGate });
  check('IMPL-0638:ng 暫定任命の期間内の判定で、併記が無い・AI の名義・判定者本人・名簿の人でないものを未達として出す', bad.unmet.length === 4 && ['g3-nocosign', 'g3-ai', 'g3-self', 'g3-notroster'].every((f) => bad.unmet.some((u) => u.file === f)), JSON.stringify(bad.unmet));
  // IMPL-0638:ok(適合の入力。併記あり・期間の外・G-6 は対象外・読めない期間は確認できない)
  const good = JR.provisionalGaps({
    d0Text: d0,
    records: [
      { file: 'ok', gate: 'G-3', judge: '名簿 甲', judgedAt: '2026-11-01 10:00', coSign: '名簿 乙' },
      { file: 'outside', gate: 'G-3', judge: '名簿 甲', judgedAt: '2027-01-02 10:00', coSign: '' },
      { file: 'g6', gate: 'G-6', judge: '名簿 甲', judgedAt: '2026-11-01 10:00', coSign: '' },
    ],
    resolve, isAi, holderOf, roleOfGate,
  });
  check('IMPL-0638:ok 併記あり・期間の外・G-6 は未達にしない', good.unmet.length === 0 && good.checked === 1, JSON.stringify(good));
  check('IMPL-0638:ok 期間が日付として読めない行は「確認できない」と出し、未達にしない', good.unconfirmed.some((u) => /価値責任者/.test(u)) && good.unmet.length === 0, JSON.stringify(good.unconfirmed));
}

// IMPL-0738(CL1 以上と規制業は、人の確認の未達を集約の欠落に数える。G-3 は開示だけ。手書きの構成でも G-3 の未達を導き直す)
{
  const BASE = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free', 'q-biz-phase': 'growth', 'q-team-size': 'size-3-5', 'q-external-reviewer': 'reviewer-yes' };
  const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
  const built = (over, stack) => {
    const answers = { ...BASE, ...over };
    try { return quiet(() => buildConfig(answers, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, stack }).config); } catch { return null; }
  };
  const gapsOf = (cfg) => unmetShipGaps(cfg);
  const cl1 = built({ 'q-criticality': 'cl1' }, 'undetermined');
  check('IMPL-0738:ok(前提) 構成を作れて G-3 が未達になる', Boolean(cl1) && (cl1.unmet ?? []).some((u) => u.gate === 'g3'), JSON.stringify(cl1?.unmet?.map((u) => u.gate)));
  // 案B(所有者の決定 2026-11-18): 止めるのは人の確認の未達。G-3 など体制に由来しない未達は止めず、開示の未達に出す
  check('IMPL-0738:ok CL1 × G-3 未達は欠落にしない(開示と G-8 の受容。案 A は採らない)', gapsOf(cl1).length === 0, JSON.stringify(gapsOf(cl1)));
  check('IMPL-0738:ok CL1 × G-3 未達は開示の未達に出る', derivedUnmet(cl1).some((u) => u.gate === 'g3'), JSON.stringify(derivedUnmet(cl1).map((u) => u.gate)));
  const reg = built({ 'q-quality': 'quality-regulated' }, 'undetermined');
  check('IMPL-0738:ok CL0 × 規制業 × G-3 未達は欠落にしない', gapsOf(reg).length === 0 && derivedUnmet(reg).some((u) => u.gate === 'g3'), JSON.stringify(gapsOf(reg)));
  const hand = cl1 ? JSON.parse(JSON.stringify(cl1)) : null;
  if (hand) { hand.unmet = []; hand.gates.g3.state = 'omitted'; }
  check('IMPL-0738:ok 手で unmet: []・g3: omitted と書いても、導き直した G-3 が開示の未達に出る(欠落には数えない)', hand && gapsOf(hand).length === 0 && derivedUnmet(hand).some((u) => u.gate === 'g3'), JSON.stringify(hand && derivedUnmet(hand).map((u) => u.gate)));
  check('IMPL-0738:ok CL0 × 標準 × G-3 未達は欠落にしない(開示と G-8 の受容)', gapsOf(built({}, 'undetermined')).length === 0);
  check('IMPL-0738:ok CL1 × スタック確定は欠落なし', gapsOf(built({ 'q-criticality': 'cl1' }, 'node')).length === 0);
  check('IMPL-0738:ok CL1 × PoC × スタック未確定は欠落なし', gapsOf(built({ 'q-criticality': 'cl1', 'q-biz-phase': 'poc' }, 'undetermined')).length === 0);
  // 人の確認の未達(G-6)は止める。手書きの構成の unmet[] に載る
  const g6Entry = { gate: 'g6', label: 'G-6 独立レビュー', reason: '作成を指示した本人以外の確認者がいない', howToResolve: ['作成を指示した本人以外の確認者を名簿と席へ置く'] };
  const withUnmet = (cfg, list) => (cfg ? { ...JSON.parse(JSON.stringify(cfg)), unmet: list } : null);
  const cl1Node = built({ 'q-criticality': 'cl1' }, 'node');
  const cl1G6 = withUnmet(cl1Node, [g6Entry]);
  check('IMPL-0738:ng CL1 × G-6 未達は欠落(文に未達の名と解き方の先頭)', gapsOf(cl1G6).length === 1 && /G-6 独立レビュー/.test(gapsOf(cl1G6)[0]) && /確認者を名簿と席へ置く/.test(gapsOf(cl1G6)[0]), JSON.stringify(gapsOf(cl1G6)));
  const regG6 = withUnmet(built({ 'q-quality': 'quality-regulated' }, 'node'), [g6Entry]);
  check('IMPL-0738:ng CL0 × 規制業 × G-6 未達は欠落', gapsOf(regG6).length === 1, JSON.stringify(gapsOf(regG6)));
  check('IMPL-0738:ok CL0 × 標準 × G-6 未達は欠落にしない(開示と G-8 の受容)', gapsOf(withUnmet(built({}, 'node'), [g6Entry])).length === 0);
  check('IMPL-0738:ng 表に無い gate の値は止める側に倒す(手書きの構成)', gapsOf(withUnmet(cl1Node, [{ gate: 'x9', label: '未知の未達', reason: 'r' }])).length === 1);
  check('IMPL-0738:ng 止める未達と G-3 が並ぶとき、止める未達の分だけが欠落になる', gapsOf(withUnmet(cl1, [g6Entry, ...(cl1?.unmet ?? [])])).length === 1);
  // G-2(価値責任者を置かない委託。集約が様式 08 から導く)は extra で渡す
  const g2Entry = { gate: 'g2', label: 'G-2 要件合意(価値責任者を置かない委託。様式 08)', reason: '価値責任者を置かない', howToResolve: ['価値責任者を置く'] };
  check('IMPL-0738:ng CL1 × 委託 × 「置かない」は欠落', unmetShipGaps(cl1Node, { extra: [g2Entry] }).length === 1 && /G-2/.test(unmetShipGaps(cl1Node, { extra: [g2Entry] })[0]));
  check('IMPL-0738:ng 規制業 × 委託 × 「置かない」は欠落', unmetShipGaps(built({ 'q-quality': 'quality-regulated' }, 'node'), { extra: [g2Entry] }).length === 1);
  check('IMPL-0738:ok CL0 × 標準 × 委託 × 「置かない」は欠落にしない', unmetShipGaps(built({}, 'node'), { extra: [g2Entry] }).length === 0);
  // IMPL-0638 の併記の未達(範囲の中の判定だけが止める)
  {
    const rsAll = [
      { file: 'in', gate: 'G-3 判断記録', judge: '名簿 甲', judgedAt: '2026-11-01 10:00', coSign: '', inRange: true },
      { file: 'out', gate: 'G-3 判断記録', judge: '名簿 甲', judgedAt: '2026-11-02 10:00', coSign: '', inRange: false },
    ];
    const d0c = ['## 9. 代行者(代理者)と後継', '', '**暫定任命の期間(標準 第3章 3.4.1)**', '',
      '| 役割 | 暫定任命の対象(責任者 / 代理者) | 暫定任命の期間(開始日〜満了日) | 満了時の扱い | 延長の決裁 |', '| --- | --- | --- | --- | --- |',
      '| 技術判断者 | 責任者 | 2026-10-01〜2026-12-31 | 任命を解く | |', ''].join('\n');
    const idm = new Map([['名簿 甲', 'p1']]);
    const pg = JR.provisionalGaps({ d0Text: d0c, records: rsAll, resolve: (n) => idm.get(String(n ?? '').trim()) ?? null, isAi: () => false, holderOf: () => 'p1', roleOfGate: () => ['技術判断者'] });
    const cos = JR.cosignShipEntries(pg.unmet);
    check('IMPL-0738:ng CL1 × 範囲の中の判定に併記なし(IMPL-0638)は欠落', cos.length === 1 && unmetShipGaps(cl1Node, { extra: cos }).length === 1 && /in/.test(cos[0].label), JSON.stringify(cos));
    check('IMPL-0738:ok CL1 × 範囲の外の判定に併記なしは欠落にしない', !cos.some((c) => /out/.test(c.label)) && pg.unmet.length === 2);
    check('IMPL-0738:ok CL0 × 標準 × 範囲の中の併記なしは欠落にしない', unmetShipGaps(built({}, 'node'), { extra: cos }).length === 0);
    const unread = JR.provisionalGaps({ d0Text: d0c.replace('2026-10-01〜2026-12-31', 'いつか'), records: rsAll, resolve: (n) => idm.get(String(n ?? '').trim()) ?? null, isAi: () => false, holderOf: () => 'p1', roleOfGate: () => ['技術判断者'] });
    check('IMPL-0738:ok CL1 × 併記の期間が読めない行は欠落にしない(確認できないと表示)', JR.cosignShipEntries(unread.unmet).length === 0 && unread.unconfirmed.length === 1 && /確認できない/.test(JR.provisionalUnmetText(unread) ?? ''), JSON.stringify(unread));
  }
  // 典型の初期状態で出荷が永久に止まらない(P1 の固定): スタックが確定している(node・none)か PoC なら、CL・事業段階・体制の組のすべてで欠落が出ない
  const stuck = [];
  for (const cl of ['cl0', 'cl1', 'cl2', 'cl3']) for (const phase of ['poc', 'mvp', 'growth']) for (const stack of ['node', 'none', 'undetermined']) {
    const c = built({ 'q-criticality': cl, 'q-biz-phase': phase }, stack);
    if (!c) continue;
    const resolved = stack !== 'undetermined' || phase === 'poc';
    if (resolved && unmetShipGaps(c).length) stuck.push(`${cl}/${phase}/${stack}`);
  }
  check('IMPL-0738:ok スタックが確定しているか PoC なら、CL0〜3 × 事業段階のどの組でも欠落が出ない(永久に止まらない)', stuck.length === 0, stuck.join(', '));
  }

// IMPL-0498(層の合わさり: 承認の無い下の層が、既定ブランチへ入った PR の先頭の祖先なら、その PR を確認ありに数えない)
// 使い捨ての git リポジトリで動かす。GitHub の実機(refs/pull/N/head の公開・verify ジョブ)では確かめていない
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-'));
  const run = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const up = path.join(tmp, 'up');
  fs.mkdirSync(up);
  run(up, 'init', '-q', '-b', 'main');
  const commit = (cwd, f, m) => { fs.writeFileSync(path.join(cwd, f), m + '\n'); run(cwd, 'add', '-A'); run(cwd, 'commit', '-q', '-m', m); return run(cwd, 'rev-parse', 'HEAD'); };
  commit(up, 'a.txt', 'c0');
  run(up, 'checkout', '-q', '-b', 'L1'); commit(up, 'l1.txt', 'c1');
  run(up, 'checkout', '-q', '-b', 'L2'); commit(up, 'l2.txt', 'c2');
  run(up, 'checkout', '-q', '-b', 'L3'); commit(up, 'l3.txt', 'c3');
  run(up, 'checkout', '-q', 'L2'); run(up, 'merge', '-q', '--no-ff', '-m', 'merge L3 into L2', 'L3');
  const mX = run(up, 'rev-parse', 'HEAD');
  run(up, 'checkout', '-q', 'L1'); run(up, 'merge', '-q', '--no-ff', '-m', 'merge L2 into L1', 'L2');
  const yHead = run(up, 'rev-parse', 'HEAD');
  run(up, 'update-ref', 'refs/pull/2/head', yHead);
  // 無関係な Y: 既定ブランチから別に切った変更
  run(up, 'checkout', '-q', 'main'); run(up, 'checkout', '-q', '-b', 'other'); const otherHead = commit(up, 'o.txt', 'other');
  run(up, 'update-ref', 'refs/pull/3/head', otherHead);
  run(up, 'checkout', '-q', 'main');
  const clone = (name, ...opt) => { const d = path.join(tmp, name); run(tmp, 'clone', '-q', '--no-tags', '--single-branch', '--branch', 'main', ...opt, 'file://' + up.split(path.sep).join('/'), d); return d; };
  const gitOf = (cwd) => { const calls = []; const f = (args) => { calls.push(args.join(' ')); const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return { status: r.status ?? 1, out: (r.stdout ?? '').trim() }; }; f.calls = calls; return f; };
  const copy = (n, over = {}) => ({ copy: { number: n, base: { ref: 'main' }, default_branch: 'main', head_sha: null, merge_commit_sha: null, merged_at: `2026-11-0${n}T00:00:00Z`, reviews: [], ...over } });
  const approved = [{ user: { login: 'someone', id: 5 }, state: 'APPROVED' }];
  const mk = (over = {}) => new Map([
    [1, copy(1, { base: { ref: 'L2' }, merge_commit_sha: mX, ...(over.x ?? {}) })],
    [2, copy(2, { head_sha: yHead, ...(over.y ?? {}) })],
    [3, copy(3, { head_sha: otherHead })],
  ]);
  // 有効な承認の述語。実物の集約は independentConfirmation を X の写しへ当てる。ここでは写しの承認者が someone のときだけ有効とする
  const valid = (_n, c) => (c.reviews ?? []).some((r) => r.state === 'APPROVED' && r.user?.login === 'someone');
  const botApproved = [{ user: { login: 'github-actions[bot]', id: 41898282 }, state: 'APPROVED' }];
  const full = clone('full');
  const g1 = gitOf(full);
  const r1 = stackedLayerCheck({ copies: mk(), git: g1, hasValidApproval: valid });
  check('IMPL-0498:ng 手動のスタック(承認の無い X が Y の先頭の祖先)は数えない(refs/pull/N/head を取得して判定)', r1.verdicts.get(2)?.reason === 'stackedLayer', JSON.stringify([...r1.verdicts]));
  check('IMPL-0498:ok 無関係な Y(X が祖先でない)は数える', !r1.verdicts.has(3), JSON.stringify([...r1.verdicts]));
  check('IMPL-0498:ok 取得は承認の無い X があるときだけ、Y ごとに refs/pull/<Y>/head を --no-tags で行う', g1.calls.filter((c) => /^fetch /.test(c)).every((c) => /--no-tags origin refs\/pull\/\d+\/head/.test(c)) && g1.calls.some((c) => /refs\/pull\/2\/head/.test(c)), g1.calls.join(' | '));
  const g2 = gitOf(full);
  const r2 = stackedLayerCheck({ copies: mk({ x: { reviews: approved } }), git: g2, hasValidApproval: valid });
  check('IMPL-0498:ok X に有効な承認がある層は数える(取得もしない)', r2.verdicts.size === 0 && !g2.calls.some((c) => /^fetch /.test(c)), JSON.stringify([...r2.verdicts]) + g2.calls.join('|'));
  const lower = new Map([[1, copy(1, { base: { ref: 'main' }, merge_commit_sha: mX })], [2, copy(2, { head_sha: yHead })]]);
  const g3 = gitOf(full);
  const r3 = stackedLayerCheck({ copies: lower, git: g3, hasValidApproval: valid });
  check('IMPL-0498:ok 下から順に既定ブランチへ入れるスタック(X の基底も既定ブランチ)は数える', r3.verdicts.size === 0 && !g3.calls.some((c) => /^fetch /.test(c)));
  const shallow = clone('shallow', '--depth', '1');
  const r4 = stackedLayerCheck({ copies: mk(), git: gitOf(shallow), hasValidApproval: valid });
  check('IMPL-0498:ng 浅い取得は数えない(未確認)', r4.verdicts.get(2)?.reason === 'stackedUnconfirmed', JSON.stringify([...r4.verdicts]));
  const r5 = stackedLayerCheck({ copies: mk({ y: { head_sha: '0123456789012345678901234567890123456789' } }), git: gitOf(clone('nohead')), hasValidApproval: valid });
  check('IMPL-0498:ng Y の head を取得できないときは数えない(未確認)', r5.verdicts.get(2)?.reason === 'stackedUnconfirmed', JSON.stringify([...r5.verdicts]));
  const r6 = stackedLayerCheck({ copies: mk({ x: { merge_commit_sha: '1111111111111111111111111111111111111111' } }), git: gitOf(clone('xmissing')), hasValidApproval: valid });
  check('IMPL-0498:ok Y の head があり X の版が無いときは数える', !r6.verdicts.has(2), JSON.stringify([...r6.verdicts]));
  const late = mk({ x: { merged_at: '2026-11-09T00:00:00Z' } });
  const r7 = stackedLayerCheck({ copies: late, git: gitOf(full), hasValidApproval: valid });
  check('IMPL-0498:ok Y のマージより後に入った X は候補にしない', r7.verdicts.size === 0, JSON.stringify([...r7.verdicts]));
  // F-04: 承認の件数ではなく有効な承認で判定する(bot の承認だけの X は承認なし)
  const rBot = stackedLayerCheck({ copies: mk({ x: { reviews: botApproved } }), git: gitOf(full), hasValidApproval: valid });
  check('IMPL-0498:ng X の承認が bot だけ(有効な承認でない)なら、承認の件数が 1 でも Y を数えない', rBot.verdicts.get(2)?.reason === 'stackedLayer', JSON.stringify([...rBot.verdicts]));
  const rThrow = stackedLayerCheck({ copies: mk({ x: { reviews: approved } }), git: gitOf(full), hasValidApproval: () => { throw new Error('x'); } });
  check('IMPL-0498:ng 有効な承認を判定できない(例外)ときは承認なしに倒し、Y を数えない', rThrow.verdicts.get(2)?.reason === 'stackedLayer', JSON.stringify([...rThrow.verdicts]));
  let noFn = null;
  try { stackedLayerCheck({ copies: mk(), git: gitOf(full) }); } catch (e) { noFn = e; }
  check('IMPL-0498:ng hasValidApproval は必須(渡さなければ件数だけの判定へ戻らず例外)', noFn instanceof TypeError);
  check('IMPL-0498:ok 開示の行に、数えなかった件数・未確認の件数・見逃す場面(取り込みの後の rebase)を出す', /承認の無い層 1 件/.test(stackedLayerText(r1)) && /数えなかった PR 1 件/.test(stackedLayerText(r1)) && /履歴を読めず数えなかった PR 2 件/.test(stackedLayerText(r4)) && /rebase/.test(stackedLayerText(r1)), stackedLayerText(r1));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 委任の条件6 の事後の抜き取りの件数(IMPL-0597)。月ごとに、G-6 を事後へ移した変更 n 件と、独立レビュアの席の責任者の名義の抜き取り k 件を数える
{
  const rows = (month, nAll, k) => Array.from({ length: nAll }, (_, i) => ({ month, sampled: i < k }));
  // IMPL-0597:ng
  const ng = samplingMonthly([...rows('2026-10', 8, 3), ...rows('2026-11', 3, 3)]);
  check('IMPL-0597:ng n=8・k=3 の月が不足と出る(既定は n と 5 のうち小さいほう)', ng.short.length === 1 && ng.short[0].month === '2026-10' && ng.short[0].n === 8 && ng.short[0].k === 3 && ng.short[0].required === 5);
  // IMPL-0597:ok
  check('IMPL-0597:ok n=3・k=3 の月は不足と出ない', ng.months.find((m) => m.month === '2026-11').short === false);
  // IMPL-0597:ng
  const cfg = samplingMonthly(rows('2026-10', 8, 3), { perMonth: 2 });
  const cfg4 = samplingMonthly(rows('2026-10', 8, 3), { perMonth: 4 });
  check('IMPL-0597:ng 構成の perMonth を使う(2 なら k=3 は足り、4 なら足りない)', cfg.short.length === 0 && cfg4.short.length === 1 && cfg4.short[0].required === 4 && cfg4.source === 'config');
  check('IMPL-0597:ok perMonth が月の件数を上回る月は、月の件数を上限にする', samplingMonthly(rows('2026-10', 2, 2), { perMonth: 5 }).short.length === 0);
  check('IMPL-0597:ok マージの時刻を読めない変更は月ごとの表に含めず、件数を出す', samplingMonthly([{ month: null, sampled: false }, ...rows('2026-10', 1, 1)]).undated === 1);
  const text = samplingMonthlyText(ng);
  check('IMPL-0597:ok 表示は合否に数えない旨と、確かめない範囲(選び方・中身・実績の中身。内部監査)を出す', /2026-10/.test(text) && /合否にも記載の欠落にも数えません/.test(text) && /内部監査/.test(text));
  // IMPL-0597:ng(席の責任者を引けない構成。記録があっても k=0 となり全ての月が不足に見える誤報を出さない)
  const unres = samplingMonthly(rows('2026-10', 8, 0), { reviewerResolved: false });
  check('IMPL-0597:ng 独立レビュアの席の責任者を引けないときは、月ごとの不足を出さず、数えていない旨を出す', unres.short.length === 0 && unres.unresolved === true && /名簿から引けず/.test(samplingMonthlyText(unres)) && samplingMonthly(rows('2026-10', 8, 0)).short.length === 1);
  // IMPL-0597:ng
  check('IMPL-0597:ng perMonth は1以上の整数(0・小数・文字列を構成の検査が拒む)', [0, 1.5, '3'].every((v) => delegationSamplingProblems({ delegation: { sampling: { perMonth: v } } }).length === 1) && delegationSamplingProblems({ delegation: { sampling: { perMonth: 3 } } }).length === 0 && delegationSamplingProblems({ delegation: {} }).length === 0);
}

console.log('');
if (failures) {
  console.log(`承認レビューの写しと記録用ブランチの集約の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`承認レビューの写しと記録用ブランチの集約の試験: ${n} 件が期待と一致しました`);
