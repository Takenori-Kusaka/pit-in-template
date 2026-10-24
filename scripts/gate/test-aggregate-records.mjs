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
  machineFields,
  copyCoverage,
  formAttribution,
  prRecordFromCopy,
  targetOfForm,
  judgeOfForm,
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

// 構成(手で起こしたもの)。山田が価値責任者(G-2・G-4 を判定する席)、鈴木が独立レビュア(G-6)
const config = {
  people: [
    { id: 'p1', name: '山田 太郎', accounts: ['yamada'] },
    { id: 'p2', name: '鈴木 一郎', accounts: ['suzuki'] },
    { id: 'p3', name: '佐藤 花子', accounts: ['sato'] },
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
  check('突合: 内容が違う写し(13)は「写しの不一致」になり、突合の先は記録用ブランチの写し', m.mismatches.some((x) => x.kind === 'review' && x.pr === 13 && /写しの不一致/.test(x.text)) && m.copies.get(13).sources[0] === 'records/reviews/pr-13.json' && m.copies.get(13).mismatch === `${BASE_COPIES_DIR}/pr-13.json`, JSON.stringify(m.mismatches));
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
  check('承認の数: 承認者ごとの最後の状態(承認の後の変更要求は数えない)', approvalCountOfCopy(withdrew) === 1);
}

// ---------------------------------------------------------------- 写しと PR の記録(API)の突合
{
  const api = JSON.parse(readFixture('api', 'pr-14.json'));
  const f = reconcileCopy(copyOf(14), api, { pr: 14 });
  check('突合(API): 本文の編集・dismiss を所見に出す', f.some((x) => /5627550001/.test(x) && /本文が写しと違う/.test(x)) && f.some((x) => /5627550001/.test(x) && /DISMISSED/.test(x)), JSON.stringify(f));
  check('突合(API): ログイン名の変化(ghost 化)を所見に出す', f.some((x) => /5627550002/.test(x) && /ログイン名が写しと違う/.test(x) && /ghost/.test(x)), JSON.stringify(f));
  check('突合(API): 写しの後に提出されたレビューを所見に出す(写しの対象外)', f.some((x) => /sato/.test(x) && /写しに無い/.test(x)), JSON.stringify(f));
  check('突合(API): 所見は 4 件(編集・dismiss・ghost・写しに無い)', f.length === 4, JSON.stringify(f));
  const sameApi = copyOf(12).reviews.map((r) => ({ author: { login: r.user.login }, state: r.state, submittedAt: r.submitted_at, body: r.body }));
  check('突合(API): 一致していれば所見なし', reconcileCopy(copyOf(12), sameApi).length === 0);
  check('突合(API): PR の記録が読めなければ所見なし(突合しない)', reconcileCopy(copyOf(12), null).length === 0 && reconcileCopy(copyOf(12), undefined).length === 0);
  const deleted = reconcileCopy(copyOf(12), sameApi.slice(1));
  check('突合(API): 写しにあって記録に無いレビューを所見に出す', deleted.length === 1 && /PR の記録\(API\)に無い/.test(deleted[0]), JSON.stringify(deleted));
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
  const other = { pr: 17, merge_commit_sha: 'm', head_sha: 'h', reviews: [{ id: 1, state: 'APPROVED', commit_id: 'h', submitted_at: '2026-10-01T00:00:00Z', user: { id: 3, login: 'sato' }, body: 'G-4: 通過\n確認した項目: 基準1' }] };
  const jo = gateJudgementsOfCopy(other, config);
  check('G-4(pr-17): 判定する席の責任者でない者(@sato)の宣言行は judgeOk=false(数えない)', jo.length === 1 && jo[0].judgeOk === false && /席の責任者/.test(jo[0].judgeNote), JSON.stringify(jo));
  const ju = gateJudgementsOfCopy(copyOf(12), { people: config.people });
  check('G-4: 席が構成に無ければ judgeOk=null と注記(数えたうえで本人かを確かめられないと出す)', ju.length === 1 && ju[0].judgeOk === null && /確かめられない/.test(ju[0].judgeNote), JSON.stringify(ju));
  const noAcc = { ...config, people: config.people.map((p) => (p.id === 'p1' ? { id: 'p1', name: '山田 太郎' } : p)) };
  const jn = gateJudgementsOfCopy(copyOf(12), noAcc);
  check('G-4: 責任者のアカウントが名簿に無ければ judgeOk=null(accounts を要する旨の注記)', jn[0].judgeOk === null && /accounts/.test(jn[0].judgeNote), JSON.stringify(jn[0].judgeNote));
  check('G-4(pr-14): 注記を足した結果(通過(…))は宣言行でない', gateJudgementsOfCopy(copyOf(14), config).length === 0);
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
{
  const g7 = gateText('g7-v1.2.0-2026-10-20.md');
  check('様式の欄: 対象と判定者', targetOfForm(g7) === 'v1.2.0' && judgeOfForm(g7) === '鈴木 一郎');
  check('様式の欄: 様式の説明を残した欄は未記入', judgeOfForm('| 判定者 | <氏名>。AI を書かない |') === null && targetOfForm('# x') === null);
  check('様式の欄: 判定者の注記(。以降)は読まない', judgeOfForm('| 判定者 | 鈴木 一郎。レビュー 5627536939 の user.id から |') === '鈴木 一郎');

  const suzuki = config.people[1];
  const base = { hash: 'abcdef0123456789', authorName: '鈴木 一郎', authorEmail: '30000001+suzuki@users.noreply.github.com', authorLogin: 'suzuki', date: '2026-10-20T14:00:00+09:00' };
  const rec = (commit) => ({ file: 'docs/gates/g7-v1.2.0-2026-10-20.md', text: g7, commit });
  // 記録だけの PR を、記名者本人が承認した(承認者 = 記名者)
  const a1 = formAttribution(rec({ ...base, authorName: 'pit-in-bot', authorEmail: 'bot@example.com', authorLogin: null, signed: false }), { judgeName: '鈴木 一郎', person: suzuki, approvers: ['suzuki'] });
  check('帰属: 記名者本人の承認レビュー → backed(approval-review)。事務の承認者なし', a1.backed === true && a1.how === 'approval-review' && a1.clerical.length === 0 && a1.selfAttested === false, JSON.stringify(a1));
  // 記名者以外が承認した(取り込みの事務)。コミットの author は草案の文脈(bot)
  const a2 = formAttribution(rec({ ...base, authorName: 'pit-in-bot', authorEmail: 'bot@example.com', authorLogin: null, signed: false }), { judgeName: '鈴木 一郎', person: suzuki, approvers: ['yamada'] });
  check('帰属: 記名者以外の承認だけ → 自己申告。承認者は取り込みの事務(clerical)に出す', a2.backed === false && a2.selfAttested === true && same(a2.clerical, ['yamada']), JSON.stringify(a2));
  // 記名者以外の承認でも、コミットの author が記名者なら弱い裏づけ
  const a3 = formAttribution(rec({ ...base, signed: false }), { judgeName: '鈴木 一郎', person: suzuki, approvers: ['yamada'] });
  check('帰属: 承認は別人でも author の login が記名者 → backed(author-login)。別人の承認は事務', a3.backed === true && a3.how === 'author-login' && same(a3.clerical, ['yamada']), JSON.stringify(a3));
  // 記録用ブランチ(PR を経ない)の署名コミット
  const a4 = formAttribution(rec({ ...base, signed: true }), { judgeName: '鈴木 一郎', person: suzuki, approvers: null });
  check('帰属: PR を経ない署名コミットで author が記名者 → signed-commit', a4.backed === true && a4.how === 'signed-commit' && a4.clerical.length === 0, JSON.stringify(a4));
  // 名前だけ一致(名簿に無い人、または別人の操作)
  const a5 = formAttribution(rec({ ...base, authorEmail: 'someone@example.com', authorLogin: null, signed: false }), { judgeName: '鈴木 一郎', person: null, approvers: null });
  check('帰属: 名簿に無い記名者。author の名前だけ一致 → 自己申告(author-name)', a5.backed === false && a5.how === 'author-name' && a5.selfAttested === true, JSON.stringify(a5));
  const a6 = formAttribution(rec({ ...base, authorName: '佐藤 花子', authorEmail: 'sato@example.com', authorLogin: null, signed: false }), { judgeName: '鈴木 一郎', person: suzuki, approvers: [] });
  check('帰属: 何も一致しない → 自己申告(how=null)', a6.backed === false && a6.how === null, JSON.stringify(a6));
  const a7 = formAttribution(rec(null), { judgeName: '鈴木 一郎', person: suzuki });
  check('帰属: コミットを読めない → 自己申告', a7.backed === false && /読めない/.test(a7.note));
  const a8 = formAttribution(rec({ ...base, signed: true }), { judgeName: null, person: null, approvers: ['suzuki'] });
  check('帰属: 記名が無ければ裏づけられない(承認があっても)', a8.backed === false && /記名が無い/.test(a8.note));
  // 名簿のアカウントが複数ある人
  const multi = { id: 'p2', name: '鈴木 一郎', accounts: ['suzuki-old', 'suzuki'] };
  const a9 = formAttribution(rec({ ...base, signed: false }), { judgeName: '鈴木 一郎', person: multi, approvers: ['SUZUKI-OLD'] });
  check('帰属: 名簿の複数のアカウント(大文字小文字を問わない)のいずれかで裏づける', a9.backed === true && a9.how === 'approval-review', JSON.stringify(a9));
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

console.log('');
if (failures) {
  console.log(`承認レビューの写しと記録用ブランチの集約の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`承認レビューの写しと記録用ブランチの集約の試験: ${n} 件が期待と一致しました`);
