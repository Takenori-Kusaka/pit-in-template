// next.mjs が判定記録の 3 つの出所を読む部分の試験(process-compass #321 / #54 段階 2)。
//
//   node scripts/gate/test-next-records.mjs
//
// git と GitHub を使いません。fixtures/gates/(基底ブランチの docs/gates/ の様式)と fixtures/records/(記録用ブランチの
// 様式と承認レビューの写し)を直接読み、readRecordsBranch の戻り値と同じ形を手で組み立てて collectRecords 以下に渡します。
// 写しの PR と機能の対応(PR 本文の Spec: トレーラ・タイトル・ブランチ名)は、prInfoOf を差し替えて与えます。
// 記録用ブランチの実際の読み取りは test-records.mjs、next.mjs の全体の段階の導出(構成・D-0・仕様)は、この試験では確かめていません。
// 着手の前の判定記録の確認(next.mjs --pickup。process-compass #368)は、入口を一時の置き場で --offline で通します(git と GitHub を
// 使いません)。開いている PR のレビューの gh api での読み出し(openPrRecords)は、この試験では確かめていません。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRecords, recordsFromCopy, gateRecordFromText, featureOfPr, passed, recordIssues, recordRoute, g6Status, pickupCheck, renderPickup, PICKUP_EXIT } from './next.mjs';
import { doneConditionSource, flowSection, doneTasksOf, specOutsideLastParagraph, doneTasks, outsideSpecNote } from './next.mjs';
import { specTrailersOf } from './autonomy.mjs';
import { DEFAULT_DONE_CONDITION } from './brief-estimates.mjs';
import { fetchScMItems, completionThroughput, reachForecast, scMChanges, scMVariationRate, flowReportText, adjustmentRecordCount, pickupUndecidedLine, countPickupUndecided, pickupUndecidedNote, pickupIssueNumber, recordPickupUndecided, countUnwrittenPickup } from './next.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const readFixture = (...rel) => fs.readFileSync(path.join(FIXTURES, ...rel), 'utf8');
const copyOf = (n) => JSON.parse(readFixture('records', 'reviews', `pr-${n}.json`));

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 基底ブランチの docs/gates/(出所 a)。readGateRecords と同じ形(gateRecordFromText は同じ読み方)
const baseRecords = ['g2-F-001-2026-10-19.md', 'g4-F-005-2026-10-20.md'].map((f) => gateRecordFromText(readFixture('gates', f), `docs/gates/${f}`, 'base'));

// 記録用ブランチ(出所 b・c)。readRecordsBranch の戻り値と同じ形
const branchOf = ({ prs = [12, 13, 14, 16], gates = ['g4-F-002-2026-10-22.md'], skipped = [] } = {}) => ({
  available: true,
  reason: null,
  ref: 'records',
  head: 'abcdef0123456789abcdef0123456789abcdef01',
  reviews: new Map(prs.map((p) => [p, copyOf(p)])),
  gates: gates.map((f) => ({ file: `records/gates/${f}`, text: readFixture('records', 'gates', f), commit: null })),
  skipped,
});

// 写しの PR と機能の対応(PR 本文のトレーラ / タイトル / ブランチ名)。pr-14 は本文を取れない場面に使う
const PR_INFO = {
  12: { info: { body: '## 変更の概要\n\n仕様\n\nSpec: F-001 / Task-1\n', title: 'spec: 招待の一覧', headRef: 'spec/invite-list' }, from: '写し', failed: null },
  13: { info: { body: '本文', title: 'feat: 招待の失効の表示', headRef: 'feature/F-001-task-2' }, from: 'gh api', failed: null },
  14: { info: null, from: null, failed: 'gh api で PR #14 を読めない(オフライン)' },
  16: { info: { body: 'Spec: F-003 / Task-1', title: 'spec: F-003', headRef: 'spec/F-003' }, from: '取り込んだコミット 3c4d5e6 のメッセージ', failed: null },
};
const prInfoOf = (copy) => PR_INFO[copy.pr] ?? { info: null, from: null, failed: '対応なし' };
const CONFIG = {
  people: [
    // 名簿の数値の識別子は fixtures/records/reviews/ の写しの user.id と同じ値(名簿の照合は識別子で行う。process-compass #430)
    { id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: 22556919 }] },
    { id: 'p2', name: '鈴木 一郎', accounts: [{ login: 'suzuki', id: 30000001 }] },
  ],
};

// ---------------------------------------------------------------- 機能 ID の手がかり
{
  check('機能 ID: Spec トレーラ(タスクも)', same(featureOfPr({ body: 'x\n\nSpec: F-012 / Task-3\n' }), { feature: 'F-012', task: 'Task-3', from: 'Spec トレーラ' }));
  check('機能 ID: トレーラが無ければタイトル', same(featureOfPr({ body: '本文', title: 'spec: F-007 の受入基準' }), { feature: 'F-007', task: null, from: 'タイトル' }));
  check('機能 ID: ブランチ名 feature/F-001-task-2(タスクも)', same(featureOfPr({ headRef: 'feature/F-001-task-2' }), { feature: 'F-001', task: 'Task-2', from: 'ブランチ名' }));
  check('機能 ID: 手がかりが無ければ null(推測しない)', featureOfPr({ body: '本文', title: 'fix: typo', headRef: 'fix/typo' }) === null && featureOfPr(null) === null);
  check('機能 ID: 英数字に続く F-NNN(REF-001 など)は機能 ID と読まない', featureOfPr({ title: 'REF-001 を直す' }) === null);
}

// ---------------------------------------------------------------- 3 つの出所から成立を読む
{
  const c = collectRecords({ gateRecords: baseRecords, branch: branchOf(), prInfoOf, config: CONFIG });
  const R = c.records;
  check('(a) 基底の docs/gates/ の様式: G-2 F-001 が成立', passed(R, 'g2', 'F-001') && R.find((r) => r.file === 'docs/gates/g2-F-001-2026-10-19.md')?.source === 'base');
  check('(b) 記録用ブランチの様式: G-4 F-002 が成立', passed(R, 'g4', 'F-002') && R.find((r) => r.file === 'records/gates/g4-F-002-2026-10-22.md')?.source === 'records-branch');
  check('(c) 写しの宣言行つきの判定: G-4 F-001(pr-12。commit_id == head)が成立', passed(R, 'g4', 'F-001'));
  const j12 = R.find((r) => r.source === 'copy' && r.prNumber === 12 && r.gate === 'G-4');
  check('(c) 写しから起こした記録の欄(所在・対象・判定者・commit_id・提出日時)', j12?.file === 'records/reviews/pr-12.json#5627536939' && j12.target === 'F-001 / Task-1 / PR #12' && j12.login === 'yamada' && j12.userId === 22556919 && j12.commitId === 'bc4ea26f0e1d2c3b4a5968778695a4b3c2d1e0f9' && j12.submittedAt === '2026-10-23T11:22:51Z' && j12.result === '通過' && j12.issue === null, JSON.stringify(j12));
  check('(c) 同じ人の差し戻し → 通過は、提出の最後の 1 件だけ(差し戻しの記録は残らない)', R.filter((r) => r.prNumber === 12 && r.gate === 'G-4').length === 1);
  check('記録が無い = 未判定: どの出所にも無い G-4 F-009 は成立しない(理由も無い)', !passed(R, 'g4', 'F-009') && recordIssues(R, 'g4', 'F-009').length === 0);
  check('要約: 件数', c.summary.base === 2 && c.summary.branch.available === true && c.summary.branch.gates === 1 && c.summary.branch.copies === 4 && c.summary.branch.judgements > 0, JSON.stringify(c.summary));
  check('写しの PR と機能の対応の一覧', same(c.prs.map((p) => [p.pr, p.feature, p.task]), [[12, 'F-001', 'Task-1'], [13, 'F-001', 'Task-2'], [14, null, null], [16, 'F-003', 'Task-1']]), JSON.stringify(c.prs));

  // commit_id のずれ
  check('commit_id のずれ: G-4 F-003(pr-16。レビューの commit_id が取り込んだ版と異なる)は未判定に戻る', !passed(R, 'g4', 'F-003'));
  const issues16 = recordIssues(R, 'g4', 'F-003');
  check('commit_id のずれ: 理由「確定していない版を取り込んだ」と次の一手「版を特定し直して宣言し直す」', issues16.length === 1 && /確定していない版を取り込んだ/.test(issues16[0]) && /0000000.*f1e2d3c/.test(issues16[0]) && /版を特定し直して宣言し直す/.test(issues16[0]), JSON.stringify(issues16));
  check('commit_id のずれ: 受け皿の案内は、その PR への判定者本人のレビュー', /^PR #16 に判定者本人のレビューを出す\(1 行目 `G-4: 通過`/.test(recordRoute('g4', 'F-003', R)), recordRoute('g4', 'F-003', R));

  // 宣言行なし
  check('宣言行なし: 注記を足した宣言(pr-14「G-4: 通過(判定者の申告を転記)」)は判定に数えない', !R.some((r) => r.prNumber === 14 && r.gate === 'G-4'));
  check('宣言行なし: 基底の様式の結果欄の注記つきの値(docs/gates/ F-005)も通過に数えず、理由を出す', !passed(R, 'g4', 'F-005') && /結果欄が「通過」「差し戻し」のどちらでもない/.test(recordIssues(R, 'g4', 'F-005')[0] ?? ''), JSON.stringify(recordIssues(R, 'g4', 'F-005')));

  // 対応づけ不能
  check('対応づけ不能: PR 本文を取れない写し(pr-14)は注記に出し、機能へ割り当てない', c.notes.some((x) => /pr-14\.json を機能へ対応づけられない/.test(x) && /オフライン/.test(x)) && R.filter((r) => r.prNumber === 14).every((r) => r.feature === null && r.target === 'PR #14'), JSON.stringify(c.notes));

  // G-6
  const g6 = g6Status(R, c.prs);
  const st = (pr) => g6.find((s) => s.pr === pr);
  check('G-6: 挙動要約つきの承認(pr-14 suzuki。commit_id == head)は成立', st(14)?.passed === true, JSON.stringify(st(14)));
  check('G-6: 承認の語だけ(pr-12 suzuki「LGTM」)は数えず、理由を出す', st(12)?.passed === false && st(12).issues.some((x) => /挙動要約が無い/.test(x) && /承認の語だけ/.test(x)), JSON.stringify(st(12)));
  check('G-6: 宣言行つきの変更要求(pr-13)は差し戻しの記録(基準 3, 5・期限)', st(13)?.passed === false && R.some((r) => r.prNumber === 13 && r.gate === 'G-6' && r.result === '差し戻し' && same(r.criteria, [3, 5]) && r.deadline === '2026-10-30'), JSON.stringify(R.filter((r) => r.prNumber === 13)));
  check('G-6: 差し戻しの記録の理由に基準と期限を添える', recordIssues(R, 'g6', 'F-001').some((x) => /差し戻しの記録 records\/reviews\/pr-13\.json#5627540001 がある\(基準 3, 5。期限 2026-10-30\)/.test(x)), JSON.stringify(recordIssues(R, 'g6', 'F-001')));
  check('様式の対象「F-001 / 1a2b3c4」(機能 ID / 確定した版)は機能 ID で引ける', baseRecords[0].target === 'F-001 / 1a2b3c4' && baseRecords[0].gate === 'G-2 要件合意' && baseRecords[0].result === '通過', JSON.stringify(baseRecords[0]));
  check('G-6: G-2 の宣言行つきの承認(pr-16 suzuki APPROVED)は G-2 の記録であり、G-6 に数えない', passed(R, 'g2', 'F-003') && !R.some((r) => r.prNumber === 16 && r.gate === 'G-6' && r.login === 'suzuki'), JSON.stringify(R.filter((r) => r.prNumber === 16)));
  check('G-6: user.type が Bot の承認(pr-16 dependabot[bot])は数えない', !R.some((r) => r.prNumber === 16 && r.login === 'dependabot[bot]'));
  check('G-6: 承認の後に push があった承認(pr-16 sato。commit_id != head)は失効として数えず、理由を出す', st(16)?.passed === false && st(16).issues.some((x) => /失効した/.test(x) && /sato/.test(x)), JSON.stringify(st(16)));
  check('G-6: pr-16 は G-6 の成立した記録を持たない(未判定)', !passed(R, 'g6', 'F-003'));
  check('G-6: 対象が PR を指す様式も G-6 の記録に数える', g6Status([{ gate: 'G-6 独立レビュー', target: 'PR #40', result: '通過', issue: null }], [{ pr: 40, task: null }])[0].passed === true);
}

// ---------------------------------------------------------------- 写し 1 件の読み方の細部
{
  const info = { body: 'Spec: F-001 / Task-1' };
  // 写しに取り込んだ版が無い
  const noHead = { ...copyOf(12) };
  delete noHead.head_sha_at_merge;
  const rn = recordsFromCopy(noHead, info);
  check('写しに head が無ければ、通過を確かめられないとして数えない', rn.filter((r) => r.gate === 'G-4').every((r) => /確かめられない/.test(r.issue ?? '')) && !passed(rn, 'g4', 'F-001'), JSON.stringify(rn));
  // 名簿との対応づけ(config を渡したときだけ)
  const r14 = recordsFromCopy(copyOf(14), info, { config: { people: [{ id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: 22556919 }] }] } });
  check('名簿を渡し、承認者が名簿に無ければ数えず、理由を出す', !passed(r14, 'g6', 'F-001') && r14.some((r) => /名簿/.test(r.issue ?? '')), JSON.stringify(r14));
  check('名簿を渡さなければ、対応づけは行わない', passed(recordsFromCopy(copyOf(14), info), 'g6', 'F-001'));
  // 宣言行 G-6: 通過 が承認でない
  const commented = { pr: 50, head_sha_at_merge: 'a', reviews: [{ id: 1, state: 'COMMENTED', commit_id: 'a', submitted_at: '2026-10-01T00:00:00Z', user: { id: 1, login: 'suzuki' }, body: 'G-6: 通過\n挙動要約: 一覧に失効の表示を足す変更。' }] };
  const rc = recordsFromCopy(commented, info);
  check('G-6 の通過の宣言が承認(APPROVED)でなければ数えず、理由を出す', !passed(rc, 'g6', 'F-001') && rc.length === 1 && /承認\(APPROVED\)でない/.test(rc[0].issue), JSON.stringify(rc));
  // 宣言行の無い変更要求
  const cr = { pr: 51, head_sha_at_merge: 'a', reviews: [{ id: 1, state: 'CHANGES_REQUESTED', commit_id: 'a', submitted_at: '2026-10-01T00:00:00Z', user: { id: 1, login: 'suzuki' }, body: 'テストが足りない' }] };
  const rr = recordsFromCopy(cr, info);
  check('宣言行の無い変更要求は、理由の無い差し戻しとして出す', rr.length === 1 && rr[0].result === null && /宣言行.*が無い/.test(rr[0].issue), JSON.stringify(rr));
  // 承認者ごとの最後の状態
  const flip = { pr: 52, head_sha_at_merge: 'a', reviews: [
    { id: 1, state: 'APPROVED', commit_id: 'a', submitted_at: '2026-10-01T00:00:00Z', user: { id: 1, login: 'suzuki' }, body: '挙動要約: 一覧に失効の表示を足す変更。' },
    { id: 2, state: 'CHANGES_REQUESTED', commit_id: 'a', submitted_at: '2026-10-02T00:00:00Z', user: { id: 1, login: 'suzuki' }, body: 'G-6: 差し戻し / 基準 3 / 期限 2026-10-30' },
  ] };
  check('承認の後の変更要求は、承認を取り下げたものとして読む(最後の状態)', !passed(recordsFromCopy(flip, info), 'g6', 'F-001'));
  const reflip = { ...flip, reviews: [...flip.reviews, { id: 3, state: 'APPROVED', commit_id: 'a', submitted_at: '2026-10-03T00:00:00Z', user: { id: 1, login: 'suzuki' }, body: '挙動要約: 失効の境界のテストを足した後の版。409 を返す。' }] };
  check('変更要求の後の承認で記録し直せる', passed(recordsFromCopy(reflip, info), 'g6', 'F-001'));
  check('写しでないものは空', recordsFromCopy(null, info).length === 0 && recordsFromCopy({}, null).length === 0);
}

// ---------------------------------------------------------------- 記録用ブランチが無い構成
{
  const c = collectRecords({ gateRecords: baseRecords, branch: { available: false, reason: '記録用ブランチ records が手元に無い' }, prInfoOf, config: CONFIG });
  check('ブランチ無し: 基底の様式だけで従来どおり動く(G-2 F-001 は成立、G-4 F-001 は未判定)', passed(c.records, 'g2', 'F-001') && !passed(c.records, 'g4', 'F-001') && c.records.length === 2);
  check('ブランチ無し: 要約に理由を持ち、注記は増やさない', c.summary.branch.available === false && /手元に無い/.test(c.summary.branch.reason) && c.notes.length === 0 && c.prs.length === 0, JSON.stringify(c.summary));
  const c2 = collectRecords({ gateRecords: baseRecords });
  check('ブランチを渡さなくても動く', c2.summary.branch.available === false && c2.records.length === 2);
  const c3 = collectRecords({ gateRecords: [], branch: branchOf({ prs: [12], gates: [], skipped: [{ file: 'records/reviews/pr-15.json', reason: 'JSON として読めない' }] }), prInfoOf });
  check('読めない写しは注記に出す(黙って落とさない)', c3.notes.some((x) => /pr-15\.json を読めない/.test(x)), JSON.stringify(c3.notes));
}

// ---------------------------------------------------------------- 受け皿の案内
{
  check('受け皿: 写しの無い G-4 は、PR のレビューと様式の両方の経路を出す', /対象が PR として存在するなら、その PR に判定者本人のレビューを出す\(1 行目 `G-4: 通過`/.test(recordRoute('g4', 'F-009', [])) && /records\/gates\/ へ置いて records ブランチへ push/.test(recordRoute('g4', 'F-009', [])), recordRoute('g4', 'F-009', []));
  check('受け皿: G-7 は様式だけ', /^様式を records\/gates\/ へ置いて records ブランチへ push する\(`\/gate G-7`/.test(recordRoute('g7', null, [])), recordRoute('g7', null, []));
  check('受け皿: G-6 は承認者本人の挙動要約つきの承認レビュー', /承認者本人の挙動要約つきの承認レビュー/.test(recordRoute('g6', 'F-001', [])));
}

// ---------------------------------------------------------------- 最新の判定で読む(process-compass #368 の突合 X-2)
{
  const form = (gate, target, result, judgedAt, extra = {}) => ({ file: `docs/gates/${gate}-${judgedAt}.md`, source: 'base', gate, target, result, resultRaw: result, judgedAt, issue: null, ...extra });
  const passThenReject = [form('G-4 機能仕様承認', 'F-001', '通過', '2026-10-20 09:00'), form('G-4 機能仕様承認', 'F-001', '差し戻し', '2026-10-21 09:00')];
  check('最新の判定: 通過の後に差し戻しがあれば、通過は効いていない(次の一手の G-4 待ち)', !passed(passThenReject, 'g4', 'F-001'));
  check('最新の判定: 差し戻しの後の通過は効く', passed([...passThenReject, form('G-4 機能仕様承認', 'F-001', '通過', '2026-10-22 09:00')], 'g4', 'F-001'));
  check('最新の判定: 同じ時刻の通過と差し戻しは、差し戻しを効かせる(安全側)', !passed([form('G-4', 'F-001', '通過', '2026-10-20 09:00'), form('G-4', 'F-001', '差し戻し', '2026-10-20 09:00')], 'g4', 'F-001'));
  check('最新の判定: 通過の後に結果欄が2値でない記録があれば、通過は効いていない', !passed([form('G-4', 'F-001', '通過', '2026-10-20 09:00'), form('G-4', 'F-001', null, '2026-10-21 09:00', { resultRaw: '保留' })], 'g4', 'F-001'));
  check('最新の判定: 別の機能の差し戻しは打ち消さない', passed([form('G-4', 'F-001', '通過', '2026-10-20 09:00'), form('G-4', 'F-002', '差し戻し', '2026-10-21 09:00')], 'g4', 'F-001'));
  const g6 = [form('G-6 独立レビュー', 'PR #40', '通過', '2026-10-20 09:00'), form('G-6 独立レビュー', 'PR #40', '差し戻し', '2026-10-21 09:00')];
  check('最新の判定: g6Status も、通過の後に差し戻しのある PR を未判定とする', g6Status(g6, [{ pr: 40, task: 'Task-1' }])[0].passed === false);
  // 写しの承認で通過に数えなかったもの(挙動要約なし)は、判定のやり直しではない。先の有効な承認を打ち消さない
  const twoApprovers = { pr: 41, head_sha: 'h', reviews: [
    { id: 1, state: 'APPROVED', commit_id: 'h', submitted_at: '2026-10-20T00:00:00Z', user: { id: 30000001, login: 'suzuki' }, body: '挙動要約: 一覧に失効の表示を足す変更。' },
    { id: 2, state: 'APPROVED', commit_id: 'h', submitted_at: '2026-10-21T00:00:00Z', user: { id: 22556919, login: 'yamada' }, body: 'LGTM' },
  ] };
  check('最新の判定: 後の承認に挙動要約が無くても、先の有効な承認は打ち消さない', passed(recordsFromCopy(twoApprovers, null), 'g6'));
}

// ---------------------------------------------------------------- 着手の前の判定記録の確認(標準 第3章 3.5.5 要求事項5。process-compass #368 / IMPL-0331)
// 関数の場面と、入口(node scripts/gate/next.mjs --pickup)を一時の置き場で通す場面の両方を持つ
{
  const ICONFIG = {
    configured: true,
    gates: {
      g2: { state: 'required', label: 'G-2 要件合意' },
      g3: { state: 'required', label: 'G-3 技術設計判断' },
      g4: { state: 'required', label: 'G-4 機能仕様承認' },
      g6: { state: 'required', label: 'G-6 独立レビュー' },
    },
    roles: [
      { id: 'value-owner', name: '価値責任者', gatesOwned: ['g2', 'g4'] },
      { id: 'tech-lead', name: '技術判断者', gatesOwned: ['g3'] },
      { id: 'dev-verifier', name: '開発者', gatesOwned: [] },
      { id: 'independent-reviewer', name: '独立レビュア', gatesOwned: ['g6'] },
      { id: 'qa-gatekeeper', name: '出荷判定者', gatesOwned: ['g7'] },
    ],
    seats: [{ role: 'value-owner', accountable: 'p1' }, { role: 'independent-reviewer', accountable: 'p2' }, { role: 'tech-lead', accountable: 'p2' }],
    people: CONFIG.people,
  };
  const R = collectRecords({ gateRecords: baseRecords, branch: branchOf(), prInfoOf, config: CONFIG }).records;
  const g3F001 = { file: 'docs/gates/g3-F-001.md', source: 'base', gate: 'G-3 技術設計判断', target: 'F-001', result: '通過', resultRaw: '通過', judgedAt: '2026-10-21 09:00', issue: null };
  const approval = (body, commit = 'h1') => ({ pr: 30, head_sha: 'h1', reviews: [{ id: 9, state: 'APPROVED', commit_id: commit, submitted_at: '2026-10-24T00:00:00Z', user: { id: 30000001, login: 'suzuki' }, body }] });
  const open = (copy) => ({ available: true, reason: null, records: recordsFromCopy(copy, null, { config: ICONFIG }) });
  const PO = 'state:needs-po';
  // 価値責任者の判断の記録(テンプレ4 のゲート欄「価値責任者の判断」。標準 第3章 3.5.5 要求事項9。process-compass #359 / IMPL-0467)
  const poDecision = (target, result = '通過', at = '2026-10-22 09:00') => ({ file: `docs/gates/po-${target.replace(/\s+/g, '-')}.md`, source: 'base', gate: '価値責任者の判断', target, result, resultRaw: result, judgedAt: at, issue: null });
  const RP = [...R, poDecision('F-001'), poDecision('F-009')];

  const ng1 = pickupCheck({ label: 'state:needs-dev', target: 'F-009', from: PO, records: R, config: ICONFIG });
  check('IMPL-0331:ng state:needs-dev でも G-2・G-4 の通過の記録が無い機能には着手しない(判定者の受信箱へ差し戻す)', ng1.decision === 'hold' && same(ng1.missing, ['G-2', 'G-4']) && ng1.returnTo?.role === 'value-owner' && same(ng1.returnTo.labels, ['state:needs-po']) && /要求事項5/.test(ng1.reason), JSON.stringify(ng1));
  const ng2 = pickupCheck({ label: 'state:needs-dev', target: 'F-002', from: PO, records: R, config: ICONFIG });
  check('着手の確認: G-4 だけ通過し G-2 の記録が無い機能も着手しない', ng2.decision === 'hold' && same(ng2.missing, ['G-2']), JSON.stringify(ng2));
  const ok1 = pickupCheck({ label: 'state:needs-dev', target: 'F-001 / Task-1', from: PO, records: RP, config: ICONFIG });
  check('IMPL-0331:ok G-2・G-4 の通過と価値責任者の判断の記録がある機能は、state:needs-po からの state:needs-dev で着手してよい', ok1.decision === 'start' && same(ok1.required, ['G-2', 'G-4']) && /価値責任者の判断の通過が記録にある/.test(ok1.reason), JSON.stringify(ok1));
  // IMPL-0467:ng(違反と適合の対。標準の実装マーク)。G-2・G-4 が通っていても、needs-po を経た作業単位に価値責任者の判断の記録が無ければ着手しない
  const noDecision = pickupCheck({ label: 'state:needs-dev', target: 'F-001', from: PO, records: R, config: ICONFIG });
  check('IMPL-0467:ng needs-po を経た needs-dev に価値責任者の判断の記録が無ければ、G-2・G-4 が通っていても着手せず価値責任者へ差し戻す', noDecision.decision === 'hold' && same(noDecision.missing, ['価値責任者の判断']) && noDecision.returnTo?.role === 'value-owner', JSON.stringify(noDecision));
  check('IMPL-0467:ng 価値責任者の判断の後に差し戻しがあれば着手しない', pickupCheck({ label: 'state:needs-dev', target: 'F-001', from: PO, records: [...RP, poDecision('F-001', '差し戻し', '2099-01-01 09:00')], config: ICONFIG }).decision === 'hold');
  // IMPL-0467:ok(違反と適合の対)。機能へ対応づけない作業単位は、価値責任者が前もって記録した類型の判断の通過で着手してよい
  const TY = poDecision('類型 依存の更新');
  const typeOk = pickupCheck({ label: 'state:needs-dev', target: 'Issue #77 / 類型 依存の更新', from: PO, records: [...R, TY], config: ICONFIG });
  const typeNg = pickupCheck({ label: 'state:needs-dev', target: 'Issue #77 / 類型 依存の更新', from: PO, records: R, config: ICONFIG });
  check('IMPL-0467:ok 類型の判断の記録がある機能へ対応づけない作業単位(Issue #N / 類型)は着手してよく、記録が無ければ判定できない(価値責任者へ確かめる)', typeOk.decision === 'start' && typeNg.decision === 'undetermined' && typeNg.returnTo?.role === 'value-owner', JSON.stringify([typeOk, typeNg]));
  // 重の実装の突合 中-3・低-1: 類型だけ・作業単位だけの指定は判定できない。--from の経路の前提も照らす
  check('IMPL-0467:ng 類型だけ(作業単位の無い指定)・作業単位だけ(類型の無い指定)・--from の無い指定は判定できない', ['類型 依存の更新', 'Issue #77'].every((tg) => pickupCheck({ label: 'state:needs-dev', target: tg, from: PO, records: [...R, TY], config: ICONFIG }).decision === 'undetermined') && pickupCheck({ label: 'state:needs-dev', target: 'Issue #77 / 類型 依存の更新', records: [...R, TY], config: ICONFIG }).decision === 'undetermined');
  const ownerNg = pickupCheck({ label: 'state:needs-dev', target: 'Issue #77 / 類型 依存の更新', from: 'state:needs-owner', records: [...R, TY], config: ICONFIG });
  const ownerDecision = { file: 'docs/gates/owner-77.md', source: 'base', gate: '事業決裁者の決裁', target: 'Issue #77', result: '通過', resultRaw: '通過', judgedAt: '2026-10-23 09:00', issue: null };
  const ownerOk = pickupCheck({ label: 'state:needs-dev', target: 'Issue #77 / 類型 依存の更新', from: 'state:needs-owner', records: [...R, TY, ownerDecision], config: ICONFIG });
  check('IMPL-0467:ng/ok needs-owner を経た類型の作業単位は、作業単位の事業決裁者の決裁が無ければ着手せず、あれば着手してよい', ownerNg.decision === 'hold' && ownerOk.decision === 'start', JSON.stringify([ownerNg, ownerOk]));
  const techNg = pickupCheck({ label: 'state:needs-dev', target: 'Issue #77 / 類型 依存の更新', from: 'state:needs-tech', records: [...R, TY], config: ICONFIG });
  check('IMPL-0467:ng needs-tech を経た類型の作業単位は、作業単位の G-3 の通過が無ければ着手しない', techNg.decision === 'hold' && same(techNg.missing, ['G-3']), JSON.stringify(techNg));
  const unitReject = pickupCheck({ label: 'state:needs-dev', target: 'Issue #77 / 類型 依存の更新', from: PO, records: [...R, TY, poDecision('Issue #77', '差し戻し', '2099-01-01 09:00')], config: ICONFIG });
  check('IMPL-0467:ng 類型の判断があっても、作業単位の価値責任者の判断が差し戻しなら着手しない', unitReject.decision === 'hold', JSON.stringify(unitReject));
  // X-1: 技術判断者を経た作業単位は G-3 の記録も見る
  const tech = pickupCheck({ label: 'state:needs-dev', target: 'F-001', from: 'state:needs-tech', records: R, config: ICONFIG });
  check('着手の確認: state:needs-tech を経た needs-dev は、G-2・G-4 が通っていても G-3 の記録が無ければ着手しない(技術判断者へ差し戻す)', tech.decision === 'hold' && same(tech.missing, ['G-3']) && tech.returnTo?.role === 'tech-lead' && same(tech.returnTo.labels, ['state:needs-tech']), JSON.stringify(tech));
  check('着手の確認: state:needs-tech を経て G-3 の記録もあれば着手してよい', pickupCheck({ label: 'state:needs-dev', target: 'F-001', from: 'state:needs-tech', records: [...R, g3F001], config: ICONFIG }).decision === 'start');
  check('着手の確認: --from の無い needs-dev は判定できない(経路で前提が違う)', pickupCheck({ label: 'state:needs-dev', target: 'F-001', records: R, config: ICONFIG }).decision === 'undetermined');
  const g3Off = { ...ICONFIG, gates: { ...ICONFIG.gates, g3: { state: 'omitted' } } };
  check('着手の確認: G-3 が省略の構成で needs-tech を経たなら判定できない', pickupCheck({ label: 'state:needs-dev', target: 'F-001', from: 'state:needs-tech', records: R, config: g3Off }).decision === 'undetermined');
  // X-2: 最新の判定で読む
  const g4Reject = { file: 'docs/gates/g4-F-001-r.md', source: 'base', gate: 'G-4 機能仕様承認', target: 'F-001', result: '差し戻し', resultRaw: '差し戻し', judgedAt: '2099-01-01 09:00', issue: null };
  check('着手の確認: G-4 の通過の後に差し戻しがある機能は着手しない', pickupCheck({ label: 'state:needs-dev', target: 'F-001', from: PO, records: [...R, g4Reject], config: ICONFIG }).decision === 'hold');
  // X-3: 構成にゲートのキーが無い
  check('着手の確認: 構成に gates が無い、または g2 のキーだけが無いときは判定できない', pickupCheck({ label: 'state:needs-dev', target: 'F-001', from: PO, records: R, config: { ...ICONFIG, gates: undefined } }).decision === 'undetermined' && pickupCheck({ label: 'state:needs-dev', target: 'F-009', from: PO, records: R, config: { ...ICONFIG, gates: { g4: ICONFIG.gates.g4, g6: ICONFIG.gates.g6 } } }).decision === 'undetermined' && pickupCheck({ label: 'state:ready-to-merge', target: 'PR #30', records: R, config: { ...ICONFIG, gates: { g6: { state: 'maybe' } } } }).decision === 'undetermined');
  check('着手の確認: G-2・G-4 を明示して省略した構成では、ゲートの記録を求めずに着手してよい(価値責任者の判断の記録は要る)', pickupCheck({ label: 'state:needs-dev', target: 'F-009', from: PO, records: RP, config: { ...ICONFIG, gates: { ...ICONFIG.gates, g2: { state: 'omitted' }, g4: { state: 'unmet' } } } }).decision === 'start' && pickupCheck({ label: 'state:needs-dev', target: 'F-009', from: PO, records: R, config: { ...ICONFIG, gates: { ...ICONFIG.gates, g2: { state: 'omitted' }, g4: { state: 'unmet' } } } }).decision === 'hold');

  const ng3 = pickupCheck({ label: 'state:ready-to-merge', target: 'PR #30', records: R, config: ICONFIG, openPr: open(approval('LGTM')) });
  check('着手の確認: 挙動要約の無い承認だけの PR は、state:ready-to-merge でも受け取らない(独立レビュアへ差し戻す)', ng3.decision === 'hold' && ng3.returnTo?.role === 'independent-reviewer' && ng3.issues.some((x) => /挙動要約が無い/.test(x)), JSON.stringify(ng3));
  const ng4 = pickupCheck({ label: 'state:ready-to-merge', target: 'PR #30', records: R, config: ICONFIG, openPr: open(approval('挙動要約: 一覧に失効の表示を足す変更。', 'old')) });
  check('着手の確認: 承認の後に push があり失効した PR も受け取らない', ng4.decision === 'hold', JSON.stringify(ng4));
  const ok2 = pickupCheck({ label: 'state:ready-to-merge', target: '#30', records: R, config: ICONFIG, openPr: open(approval('挙動要約: 一覧に失効の表示を足す変更。')) });
  check('着手の確認: 挙動要約つきの承認がある PR は受け取ってよい', ok2.decision === 'start', JSON.stringify(ok2));
  const laterReject = { pr: 30, head_sha: 'h1', reviews: [...approval('挙動要約: 一覧に失効の表示を足す変更。').reviews, { id: 10, state: 'CHANGES_REQUESTED', commit_id: 'h1', submitted_at: '2026-10-25T00:00:00Z', user: { id: 22556919, login: 'yamada' }, body: 'G-6: 差し戻し / 基準 3 / 期限 2026-10-30' }] };
  check('着手の確認: G-6 の通過の後に差し戻しがある PR は、state:ready-to-merge でも受け取らない', pickupCheck({ label: 'state:ready-to-merge', target: 'PR #30', records: R, config: ICONFIG, openPr: open(laterReject) }).decision === 'hold');
  const off = pickupCheck({ label: 'state:ready-to-merge', target: 'PR #30', records: R, config: ICONFIG, openPr: { available: false, reason: '--offline のため読んでいない', records: [] } });
  check('着手の確認: PR のレビューを読めず記録も見つからなければ、判定できない(着手しない)', off.decision === 'undetermined' && /推測で着手しない/.test(off.reason), JSON.stringify(off));
  const qmNg = pickupCheck({ label: 'state:qm-blocked', target: 'PR #30', records: R, config: ICONFIG, openPr: open(approval('挙動要約: 一覧に失効の表示を足す変更。')) });
  const qmOk = pickupCheck({ label: 'state:qm-blocked', target: 'PR #31', records: R, config: ICONFIG, openPr: open({ pr: 31, head_sha: 'h1', reviews: [{ id: 8, state: 'CHANGES_REQUESTED', commit_id: 'h1', submitted_at: '2026-10-24T00:00:00Z', user: { id: 30000001, login: 'suzuki' }, body: 'G-6: 差し戻し / 基準 3 / 期限 2026-10-30' }] }) });
  check('着手の確認: state:qm-blocked は G-6 の差し戻しの記録があれば着手し、無ければ判定できない', qmOk.decision === 'start' && qmNg.decision === 'undetermined', JSON.stringify([qmOk, qmNg]));
  check('着手の確認: 特定の判定記録を前提にしないラベル(dev-done・needs-po など)は記録を求めない', ['state:dev-done', 'state:needs-po', 'state:needs-platform'].every((l) => pickupCheck({ label: l, target: 'PR #30', config: ICONFIG }).decision === 'start'));
  check('着手の確認: 語彙に無いラベル・機能 ID の無い needs-dev・構成なしは判定できない', pickupCheck({ label: 'state:done', target: 'F-001', config: ICONFIG }).decision === 'undetermined' && pickupCheck({ label: 'state:needs-dev', target: 'Issue #4', from: PO, config: ICONFIG }).decision === 'undetermined' && pickupCheck({ label: 'state:needs-dev', target: 'F-001', from: PO, records: R, config: null }).decision === 'undetermined');
  const omitted = { ...ICONFIG, gates: { ...ICONFIG.gates, g6: { state: 'omitted' } } };
  check('着手の確認: G-6 が省略の構成では state:ready-to-merge を使わない(判定できない)', pickupCheck({ label: 'state:ready-to-merge', target: 'PR #30', records: R, config: omitted, openPr: open(approval('LGTM')) }).decision === 'undetermined');
  // IMPL-0467:ok / ng(a)。G-6 が省略の構成の state:qm-blocked は、出荷判定者の G-7 の差し戻しの記録を前提とする
  const g7Reject = { file: 'docs/gates/g7-pr30.md', source: 'base', gate: 'G-7 出荷判定', target: 'PR #30', result: '差し戻し', resultRaw: '差し戻し', judgedAt: '2026-10-25 09:00', issue: null };
  const qmG7ok = pickupCheck({ label: 'state:qm-blocked', target: 'PR #30', records: [...R, g7Reject], config: omitted });
  const qmG7ng = pickupCheck({ label: 'state:qm-blocked', target: 'PR #30', records: R, config: omitted });
  check('IMPL-0467:ok G-6 が省略の構成の qm-blocked は、G-7 の差し戻しの記録があれば着手し、無ければ着手せず出荷判定者へ差し戻す', qmG7ok.decision === 'start' && qmG7ng.decision === 'hold' && qmG7ng.returnTo?.role === 'qa-gatekeeper', JSON.stringify([qmG7ok, qmG7ng]));
  check('着手の確認: 出力の見出しと終了コード', /^\[着手しない\]/.test(renderPickup(ng1)) && /判定者へ差し戻す\(価値責任者\(山田 太郎\)。受信箱 `state:needs-po`\)/.test(renderPickup(ng1)) && PICKUP_EXIT.start === 0 && PICKUP_EXIT.hold === 3 && PICKUP_EXIT.undetermined === 4, renderPickup(ng1));

  // 入口: 一時の置き場に scripts と構成と docs/gates/ を置き、next.mjs --pickup を --offline で実行する(git と GitHub を使わない)
  const ROOT_DIR = path.resolve(HERE, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-pickup-'));
  try {
    fs.cpSync(path.join(ROOT_DIR, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(ICONFIG, null, 2));
    fs.mkdirSync(path.join(dir, 'docs', 'gates'), { recursive: true });
    const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '', GIT_CEILING_DIRECTORIES: path.dirname(dir) };
    const run = (...a) => {
      const r = spawnSync(process.execPath, ['scripts/gate/next.mjs', '--pickup', ...a, '--offline'], { cwd: dir, encoding: 'utf8', env });
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    let r = run('state:needs-dev', 'F-001', '--from', PO);
    check('IMPL-0331:ng 入口: 判定記録の無い機能の state:needs-dev に、next.mjs --pickup は「着手しない」を出し、終了コード 3 で終える', r.status === 3 && /^\[着手しない\] state:needs-dev F-001/.test(r.out) && /判定者へ差し戻す/.test(r.out), `${r.status}\n${r.out}`);
    r = run('state:ready-to-merge', 'PR #30');
    check('入口: --offline で PR の判定記録が見つからなければ「判定できない」(終了コード 4)', r.status === 4 && /^\[判定できない\]/.test(r.out), `${r.status}\n${r.out}`);
    const form = readFixture('gates', 'g4-F-005-2026-10-20.md');
    fs.copyFileSync(path.join(FIXTURES, 'gates', 'g2-F-001-2026-10-19.md'), path.join(dir, 'docs', 'gates', 'g2-F-001-2026-10-19.md'));
    fs.writeFileSync(path.join(dir, 'docs', 'gates', 'g4-F-001-2026-10-20.md'), form.replace('F-005 / 9d8c7b6', 'F-001 / 9d8c7b6').replace('通過(判定者の申告を転記)', '通過'));
    fs.writeFileSync(path.join(dir, 'docs', 'gates', 'g6-PR-30-2026-10-24.md'), form.replace('G-4 機能仕様承認', 'G-6 独立レビュー').replace('F-005 / 9d8c7b6', 'F-001 / Task-1 / PR #30').replace('通過(判定者の申告を転記)', '通過'));
    r = run('state:needs-dev', 'F-001', '--from', PO);
    check('IMPL-0467:ng 入口: G-2・G-4 の判定記録があっても、needs-po を経た needs-dev に価値責任者の判断の記録が無ければ「着手しない」', r.status === 3 && /価値責任者の判断の記録/.test(r.out), `${r.status}
${r.out}`);
    // 価値責任者の判断の記録(テンプレ4 のゲート欄「価値責任者の判断」。標準 第3章 3.5.5 要求事項9)
    fs.writeFileSync(path.join(dir, 'docs', 'gates', 'po-F-001-2026-10-21.md'), form.replace('G-4 機能仕様承認', '価値責任者の判断').replace('F-005 / 9d8c7b6', 'F-001').replace('通過(判定者の申告を転記)', '通過'));
    r = run('state:needs-dev', 'F-001', '--from', PO);
    check('IMPL-0331:ok 入口: G-2・G-4 と価値責任者の判断の記録がある機能の state:needs-dev は「着手してよい」(終了コード 0)', r.status === 0 && /^\[着手してよい\] state:needs-dev F-001/.test(r.out), `${r.status}\n${r.out}`);
    r = run('--from', PO, 'state:needs-dev', 'F-001');
    check('入口: --from を先に書いても同じに読む', r.status === 0, `${r.status}\n${r.out}`);
    r = run('state:needs-dev', 'F-001', '--from', 'state:needs-tech');
    check('入口: needs-tech を経た needs-dev は、G-3 の記録が無ければ「着手しない」', r.status === 3 && /G-3/.test(r.out), `${r.status}\n${r.out}`);
    r = run('state:ready-to-merge', 'PR #30');
    check('入口: 様式の G-6 の通過の記録がある PR は、--offline でも受け取ってよい', r.status === 0 && /^\[着手してよい\]/.test(r.out), `${r.status}\n${r.out}`);
    fs.writeFileSync(path.join(dir, 'docs', 'gates', 'g4-F-001-2026-10-21.md'), form.replace('F-005 / 9d8c7b6', 'F-001 / 9d8c7b6').replace('2026-10-20 09:00', '2026-10-21 09:00').replace('通過(判定者の申告を転記)', '差し戻し'));
    r = run('state:needs-dev', 'F-001', '--from', PO);
    check('入口: G-4 の通過の後に差し戻しの様式があれば「着手しない」', r.status === 3, `${r.status}\n${r.out}`);
    fs.mkdirSync(path.join(dir, 'docs', 'gates', 'broken.md'));
    r = run('state:needs-dev', 'F-001', '--from', PO);
    check('入口: 記録の置き場を読めないときも「判定できない」(終了コード 4)で終える', r.status === 4 && /^\[判定できない\]/.test(r.out), `${r.status}\n${r.out}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


// ---- フローの集計(IMPL-0374・0614)と --pickup が止めた件数(IMPL-0500)。純粋関数と注入した gh だけ。GitHub の読み出し(fetch*)は確かめていない ----
{
  const D = DEFAULT_DONE_CONDITION;
  const closed = (n, day, completed) => ({ number: n, closedAt: `${day}T09:00:00Z`, completed });
  // 窓 2 か月・単位期間 14 日 → 今日 2026-11-18 から遡って 4 期(11-06〜11-18 は 13 日分…ではなく 14 日刻みで 2026-09-23 以降を 4 期)
  const units = [closed(1, '2026-11-17', true), closed(2, '2026-11-16', true), closed(3, '2026-11-10', false), closed(4, '2026-10-20', true), closed(5, '2026-09-30', true), closed(6, '2026-09-29', true), closed(7, '2026-09-28', true)];
  const base = { units, today: '2026-11-18', periodDays: 14, windowMonths: 2 };
  const ng = completionThroughput({ ...base, doneCondition: '作業単位を指す変更が取り込まれ、受入基準を満たした記録がある' });
  check('IMPL-0374:ng 完了の条件が既定の文と違う案件は算定できない', ng.computable === false && /一致しない/.test(ng.reason), JSON.stringify(ng));
  check('IMPL-0374:ng 欄が無い案件は算定できない', completionThroughput({ ...base, doneCondition: null }).computable === false);
  check('IMPL-0374:ng 単位期間の長さを読めない案件は算定できない', completionThroughput({ ...base, doneCondition: D, periodDays: null }).computable === false);
  const ok = completionThroughput({ ...base, doneCondition: D });
  check('IMPL-0374:ok 既定の文と一致する案件は、単位期間ごとの完了の個数を数える(完了が 0 の期も除かない)', ok.computable && ok.n === 4 && same(ok.periods.map((p) => p.completed), [3, 1, 0, 2]) && ok.min === 0 && ok.max === 3, JSON.stringify(ok));
  check('IMPL-0374:ok 同じ期間に閉じたが完了に当たらない個数を並べる', ok.notCompleted === 1, JSON.stringify(ok));
  check('IMPL-0374:ok 末尾の句点だけの違いは同じ文として読む', completionThroughput({ ...base, doneCondition: `${D}。` }).computable === true);
  // 様式 04 の欄「作業単位の完了の条件」(ステージ移行ゲートの後の正本)
  {
    const form = (gate, judged, dc, result = '通過', period = '2週間') => gateRecordFromText(`| 項目 | 値 |\n| --- | --- |\n| ゲート | ${gate} |\n| 対象 | S1 |\n| 結果 | ${result} |\n| 判定日時 | ${judged} |\n| 作業単位の完了の条件 | ${dc} |\n| 単位期間の長さ | ${period} |\n`, 'x.md', 'base');
    const brief = `- 作業単位の完了の条件: 企画書の条件\n- 単位期間の長さ: 1週間\n`;
    const sgOk = form('SG', '2026-10-01 10:00', D);
    check('IMPL-0374:ok 様式 04 の欄を読む', sgOk.doneCondition === D, JSON.stringify(sgOk));
    check('IMPL-0374:ng 様式の文言のままの欄は未記入として読む', form('SG', '2026-10-01 10:00', '<ステージ移行ゲートのみ。条件>').doneCondition === null);
    const s0 = doneConditionSource({ brief, records: [] });
    check('IMPL-0374:ok SG の通過が無ければ企画書の欄を読む', s0.source === 'brief' && s0.value === '企画書の条件');
    const s1 = doneConditionSource({ brief, records: [sgOk] });
    check('IMPL-0374:ok SG の通過の後は判定記録の欄を読み、企画書の欄は使わない', s1.source === 'sg' && s1.value === D && !s1.reason, JSON.stringify(s1));
    check('IMPL-0374:ok 最新の通過の記録の欄を読む', doneConditionSource({ brief, records: [sgOk, form('SG', '2026-11-01 10:00', 'あとの条件')] }).value === 'あとの条件');
    const s2 = doneConditionSource({ brief, records: [form('SG', '2026-10-01 10:00', '<ステージ移行ゲートのみ>')] });
    check('IMPL-0374:ng SG の通過の後で欄が未記入なら算定できない(企画書の欄へ戻らない)', s2.value === null && /未記入/.test(s2.reason), JSON.stringify(s2));
    // 単位期間の長さ: SG の後は様式 04 の行(企画書の欄を読まない)、SG の前は企画書の欄(見込み)
    check('IMPL-0374:ok SG の前は企画書の単位期間の長さを読む', s0.periodDays === 7, JSON.stringify(s0));
    check('IMPL-0374:ok SG の後は判定記録の単位期間の長さを読み、企画書の欄は使わない', s1.periodDays === 14, JSON.stringify(s1));
    const s3 = doneConditionSource({ brief, records: [form('SG', '2026-10-01 10:00', D, '通過', '<ステージ移行ゲートのみ>')] });
    check('IMPL-0374:ng SG の後で単位期間の長さが未記入なら算定できない(企画書の欄へ戻らない)', s3.periodDays === null && /単位期間の長さ/.test(s3.reason ?? ''), JSON.stringify(s3));
    const s4 = doneConditionSource({ brief, records: [form('SG', '2026-10-01 10:00', D, '通過', '隔週')] });
    check('IMPL-0374:ng SG の後で単位期間の長さが読めない書き方なら算定できない', s4.periodDays === null && !!s4.reason, JSON.stringify(s4));
    const s5 = doneConditionSource({ brief, records: [sgOk, form('SG', '2026-11-01 10:00', 'あとの条件', '差し戻し')] });
    check('IMPL-0374:ng 通過の後に別の SG の差し戻しがあっても、企画書の欄へ戻らず最新の通過の記録を読む', s5.source === 'sg' && s5.value === D && s5.periodDays === 14, JSON.stringify(s5));
    check('IMPL-0374:ng 差し戻しの SG は通過に数えず企画書の欄を読む', doneConditionSource({ brief, records: [form('SG', '2026-10-01 10:00', D, '差し戻し')] }).source === 'brief');
    check('IMPL-0377:ok SG の欄の既定の文なら、見込みの区分まで出せる', reachForecast({ throughput: completionThroughput({ ...base, doneCondition: s1.value }), remainingUnits: 2, remainingPeriods: 9 }).klass !== '算定できない');
    check('IMPL-0377:ng SG の欄が未記入なら、見込みは算定できない組', reachForecast({ throughput: { computable: false, reason: s2.reason }, remainingUnits: 2, remainingPeriods: 9 }).klass === '算定できない');
    check('IMPL-0374:ok SG の欄の既定の文は算定できる', completionThroughput({ ...base, doneCondition: s1.value }).computable === true);
  }
  check('IMPL-0374:ng 窓の外で閉じたものは数えない', completionThroughput({ ...base, doneCondition: D, units: [closed(9, '2026-01-05', true)] }).periods.every((p) => p.completed === 0));

  // IMPL-0614: 材料の文面と SC-M の変動率
  const items = [
    { number: 10, open: true, events: [{ type: 'labeled', at: '2026-09-01T00:00:00Z' }] },
    { number: 11, open: true, events: [{ type: 'labeled', at: '2026-09-01T00:00:00Z' }, { type: 'unlabeled', at: '2026-10-05T00:00:00Z' }] },
    { number: 12, open: false, events: [{ type: 'labeled', at: '2026-09-01T00:00:00Z' }] },
    { number: 13, open: true, events: [{ type: 'labeled', at: '2026-10-10T00:00:00Z' }] },
  ];
  const ch = scMChanges(items, '2026-09-30');
  check('IMPL-0614:ok SC-M の確定時の個数・追加・削除(SC-P・SC-B へ移すこと=ラベルを外すことは削除)・未完了の個数を数える', same(ch, { baseline: 3, added: 1, removed: 1, remaining: 2 }), JSON.stringify(ch));
  check('IMPL-0614:ok 変動率 = (追加 + 削除)の累計 ÷ 確定時の個数', Math.abs(scMVariationRate(ch) - 2 / 3) < 1e-9);
  check('IMPL-0614:ng 確定時が 0 件なら変動率は算定できない', scMVariationRate({ baseline: 0, added: 1, removed: 0 }) === null);
  // H-2: ラベルを外した Issue を、出来事の記録から削除に数える(gh は固定の入力に差し替える)
  const ev = (t, at) => ({ __typename: t === 'labeled' ? 'LabeledEvent' : 'UnlabeledEvent', createdAt: at, label: { name: 'SC-M' } });
  const node = (number, state, events, closedAt = null) => ({ number, state, closedAt, timelineItems: { pageInfo: { hasNextPage: false }, nodes: events } });
  const seen = [];
  const fakeRun = (args) => {
    const q = args[args.indexOf('-f', 3) + 1];
    seen.push(q);
    const nodes = /is:issue label:"SC-M"/.test(q)
      ? [node(10, 'OPEN', [ev('labeled', '2026-09-01T00:00:00Z')]), node(12, 'CLOSED', [ev('labeled', '2026-09-01T00:00:00Z')], '2026-09-10T00:00:00Z')]
      : [node(10, 'OPEN', [ev('labeled', '2026-09-01T00:00:00Z')]), node(11, 'OPEN', [ev('labeled', '2026-09-01T00:00:00Z'), ev('unlabeled', '2026-10-05T00:00:00Z')])];
    return { data: { search: { pageInfo: { hasNextPage: false }, nodes } } };
  };
  const fetched = fetchScMItems({ confirmedOn: '2026-09-30', run: fakeRun, repo: 'o/r' });
  const ch2 = scMChanges(fetched, '2026-09-30');
  check('IMPL-0614:ng ラベルを外した Issue(検索の結果に入らない)も、更新の検索から拾って削除に数える', fetched.some((i) => i.number === 11) && ch2.removed === 1 && ch2.baseline === 2, JSON.stringify(ch2));
  check('IMPL-0614:ok 確定の日以前に閉じた Issue は確定時の母集団に入れない', ch2.baseline === 2 && fetched.some((i) => i.number === 12));
  check('IMPL-0614:ok 更新の検索は今付いている Issue を除く(範囲を狭める)', seen.some((q) => /updated:>=2026-09-30 -label:"SC-M"/.test(q)));
  // 中2: 確定の日以前に閉じた Issue のラベルの整理は、追加にも削除にも数えない
  const tidy = scMChanges([
    { number: 30, open: true, events: [{ type: 'labeled', at: '2026-09-01T00:00:00Z' }] },
    { number: 31, open: false, closedAt: '2026-09-10T00:00:00Z', events: [{ type: 'labeled', at: '2026-09-01T00:00:00Z' }, { type: 'unlabeled', at: '2026-10-05T00:00:00Z' }] },
    { number: 32, open: false, closedAt: '2026-09-12T00:00:00Z', events: [{ type: 'labeled', at: '2026-10-06T00:00:00Z' }] },
  ], '2026-09-30');
  check('IMPL-0614:ng 確定の日以前に閉じた Issue のラベルの整理を、追加・削除に数えない', tidy.baseline === 1 && tidy.added === 0 && tidy.removed === 0, JSON.stringify(tidy));
  // 低1: 出来事の時刻は手元の暦の日付で比べる(確定の日の前日の UTC の夜が手元で確定の日の翌日に当たる場合)
  const lateUtc = new Date(2026, 9, 1, 8, 30).toISOString();
  const lc = scMChanges([{ number: 40, open: true, events: [{ type: 'labeled', at: '2026-09-01T00:00:00Z' }, { type: 'unlabeled', at: lateUtc }] }], '2026-09-30');
  check('IMPL-0614:ok 出来事の時刻を手元の暦に直して比べる(手元の 10-01 08:30 は確定の後の削除)', lc.removed === 1 && lc.baseline === 1, JSON.stringify(lc));
  // 低3: 出来事が読めなくても、ラベルの検索で返った開いた Issue は残る個数に数える
  const noEv = scMChanges([{ number: 41, open: true, hasLabel: true, events: [] }], '2026-09-30');
  check('IMPL-0614:ok 出来事が読めなくても今ラベルが付いた開いた Issue は残る個数に数える', noEv.remaining === 1, JSON.stringify(noEv));
  // 中1: 検索の上限は、黙って落とさず読めないと出す
  const pageRun = () => ({ data: { search: { issueCount: 5000, pageInfo: { hasNextPage: true, endCursor: 'c' }, nodes: [] } } });
  let cap = null;
  try { fetchScMItems({ confirmedOn: '2026-09-30', repo: 'o/r', run: pageRun }); } catch (e) { cap = e.message; }
  check('IMPL-0614:ng 検索が上限の 1000 件を超えたら、黙って小さく出さず読めないと出す', /上限/.test(cap ?? ''), String(cap));
  let cap2 = null;
  try { fetchScMItems({ confirmedOn: null, repo: 'o/r', run: () => ({ data: { search: { issueCount: 900, pageInfo: { hasNextPage: true, endCursor: 'c' }, nodes: [] } } }) }); } catch (e) { cap2 = e.message; }
  check('IMPL-0614:ng ページの上限(20 ページ)に達して続きがあれば、読めないと出す', /20 ページ/.test(cap2 ?? ''), String(cap2));
  const errText = flowReportText({ throughput: ng, forecast: null, changes: null, confirmedOn: '2026-09-30', changesError: '検索の結果が上限' });
  check('IMPL-0614:ng 履歴を読めないとき、変動率は算定できないと理由つきで出す', /変動率: 算定できない\(SC-M の履歴を読めない: 検索の結果が上限/.test(errText), errText);
  check('IMPL-0614:ok 同じ Issue は重ねて数えない', fetched.filter((i) => i.number === 10).length === 1 && seen.length === 2);
  let big = null;
  try { fetchScMItems({ confirmedOn: null, repo: 'o/r', run: () => ({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [{ number: 5, state: 'OPEN', timelineItems: { pageInfo: { hasNextPage: true }, nodes: [] } }] } } }) }); } catch (e) { big = e.message; }
  check('IMPL-0614:ng 出来事が 100 件を超える Issue は、黙って欠かず読めないと出す', /100 件を超える/.test(big ?? ''), String(big));
  const fc = reachForecast({ throughput: { ...ok, min: 1 }, remainingUnits: 6, remainingPeriods: 7 });
  const text = flowReportText({ throughput: ok, forecast: fc, changes: ch, confirmedOn: '2026-09-30' });
  check('IMPL-0614:ok 材料(残る作業単位・実測スループット・残る期間・変動率)を出し、評価と発火の判断は書かない', /残る作業単位[^\n]*6 件/.test(text) && /最小 0・最大 3/.test(text) && /残る期間の見込み/.test(text) && /66\.7%/.test(text) && !/発火(する|しない|すべき)/.test(text), text);
  check('IMPL-0614:ng 算定できない案件は、算定できない旨を出す', /算定できない/.test(flowReportText({ throughput: ng, forecast: reachForecast({ throughput: ng, remainingUnits: 1 }) })));

  // IMPL-0954(/pit の側): 観測の窓の中の「価値責任者の調整」の判定記録の件数
  const adj = (day, file, gate = '価値責任者の調整') => gateRecordFromText(`# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | ${gate} |\n| 対象 | SC-B の削除 |\n| 判定者 | 山田 太郎 |\n| 判定日時 | ${day} |\n| 結果 | 通過 |\n`, file, 'base');
  const adjRecs = [adj('2026-10-20 10:00', 'a.md'), adj('2026-09-01 10:00', 'b.md'), adj('2025-01-05 10:00', 'c.md'), adj('2026-10-21 10:00', 'd.md', 'G-2 要件合意'), adj('', 'e.md'), adj('2026-10-20 10:00', 'a.md')];
  const ac = adjustmentRecordCount(adjRecs, { today: '2026-11-19', windowMonths: 3 });
  check('IMPL-0954:ok 窓(3 か月)の中の調整の記録だけを数える。窓の外・別のゲート・同じ所在の重複は数えない', ac.count === 2 && ac.windowMonths === 3, JSON.stringify(ac));
  check('IMPL-0954:ng 判定日時を読めない調整の記録は、窓の件数に入れず別に数える(黙って落とさない)', ac.undated === 1);
  const acF = adjustmentRecordCount([adj('2026-11-20 10:00', 'f.md'), adj('2026-11-19 10:00', 'g.md')], { today: '2026-11-19', windowMonths: 3 });
  check('IMPL-0954:ng 判定日時が今日より後の調整の記録は、窓の件数に入れず別に数えて出す(黙って落とさない)', acF.count === 1 && acF.future === 1 && /今日より後の記録 1 件/.test(flowReportText({ throughput: ng, forecast: null, changes: null, adjustments: acF })), JSON.stringify(acF));
  // 低-5: /pit の節「フロー」(flowSection)が調整の記録の件数を flowReportText へ渡す(結線)。--offline 相当(network:false)で通す
  const fs5 = flowSection({ config: {}, records: adjRecs, today: '2026-11-19', network: false, forecastInput: {} });
  check('IMPL-0954:ok 入口の側: flowSection は records から数えた調整の記録の件数(既定の窓 2 か月では 1 件、読めない記録 1 件)を節の本文に出す', /価値責任者の調整の判定記録[^\n]*: 1 件\(判定日時を読めない記録 1 件/.test(String(fs5?.text)), String(fs5?.text));
  check('IMPL-0954:ok 調整の記録が無ければ 0 件と出る', adjustmentRecordCount([], { today: '2026-11-19', windowMonths: 3 }).count === 0 && adjustmentRecordCount(undefined, { today: '2026-11-19', windowMonths: 3 }).count === 0);
  const adjText = flowReportText({ throughput: ng, forecast: null, changes: null, adjustments: ac });
  check('IMPL-0954:ok フローの節に件数を出し、種別は本文に書かれ機械は読まないと書く', /価値責任者の調整の判定記録[^\n]*2 件/.test(adjText) && /種別[^\n]*機械は読まない/.test(adjText) && /読めない記録 1 件/.test(adjText), adjText);
  check('IMPL-0954:ok 入力が無い(adjustments なし)呼び出しは、既存の出力のまま', !/価値責任者の調整/.test(flowReportText({ throughput: ng, forecast: null, changes: null })));

  // IMPL-0500
  const line = pickupUndecidedLine('2026-11-18', 'state:needs-dev');
  check('IMPL-0500:ok 宣言行の形は「pit-in: pickup-undecided <日付> <ラベル>」', line === 'pit-in: pickup-undecided 2026-11-18 state:needs-dev', line);
  const cnt = countPickupUndecided([{ issue: 77, body: line }, { issue: 77, body: `理由は…\n${line}` }, { issue: 78, body: '宣言行ではない pit-in: pickup-undecided と書いただけ' }]);
  check('IMPL-0500:ng 宣言行 2 件は 2 と出る(形の違うコメントは数えない)', same(cnt, { 77: 2 }), JSON.stringify(cnt));
  check('IMPL-0500:ok 0 件なら 0 件と出る', /0 件/.test(pickupUndecidedNote({ byIssue: countPickupUndecided([]) })));
  check('IMPL-0500:ok 作業単位ごとの件数を出す', /#77: 2/.test(pickupUndecidedNote({ byIssue: cnt })));
  check('IMPL-0500:ok 指定から Issue の番号を導ける(Issue #N・PR #N・#N)。F-NNN は導けない', pickupIssueNumber('Issue #77 / 類型 依存の更新') === 77 && pickupIssueNumber('PR #30') === 30 && pickupIssueNumber('F-001') === null);
  const calls = [];
  const kept = [];
  check('IMPL-0500:ok 書けたときは Issue へコメントする', recordPickupUndecided({ label: 'state:needs-dev', target: 'Issue #77', day: '2026-11-18', run: (a) => { calls.push(a); return ''; }, appendFile: (r) => kept.push(r) }) === 'written' && calls[0].includes('77') && calls[0].includes(line.replace('needs-dev', 'needs-dev')) && kept.length === 0, JSON.stringify(calls));
  check('IMPL-0500:ng 権限が無く書けないときは、別に数える', recordPickupUndecided({ label: 'state:needs-dev', target: 'Issue #77', day: '2026-11-18', run: () => { throw new Error('HTTP 403'); }, appendFile: (r) => kept.push(r) }) === 'unwritten' && kept.length === 1 && /403/.test(kept[0]), JSON.stringify(kept));
  check('IMPL-0500:ng Issue の番号を導けない指定(F-NNN)は、書かずに別に数える', recordPickupUndecided({ label: 'state:needs-dev', target: 'F-001', day: '2026-11-18', run: () => { throw new Error('呼ばれてはならない'); }, appendFile: (r) => kept.push(r) }) === 'unwritten' && kept.length === 2);
  check('IMPL-0500:ok 書けなかった件数を数えて出す', countUnwrittenPickup(kept.join('\n')) === 2 && /書けず[^\n]*2 件/.test(pickupUndecidedNote({ unwritten: 2 })));
  // 入口: 判定できずに止めた --offline は、書けなかった旨を出す(手元の記録は一時の置き場の evidence/ に作られる)

  // IMPL-0517(次の一手の側。process-compass #441 / ADR-0172 決定3): 済みのタスクは本文の末尾の段落のトレーラ Spec: だけを数える
  const midBody = '機能 A を足す\n\nSpec: F-001 / Task-1\n\nCo-Authored-By: someone <a@example.com>';
  const lastBody = '機能 A を足す\n\nSpec: F-001 / Task-1';
  const squashBody = '* 機能 A を足す\n\n  Spec: F-001 / Task-1\n\n* 機能 B を足す\n\nSpec: F-001 / Task-2';
  const d1 = doneTasksOf([midBody]);
  check('IMPL-0517:ng 中の段落の Spec: は済みのタスクに数えない(旧い読みは Task-1 を済みにした)', d1.size === 0 && specOutsideLastParagraph([midBody]) === 1, JSON.stringify([...d1]));
  const d2 = doneTasksOf([lastBody]);
  check('IMPL-0517:ok 末尾の段落の Spec: は Task-1 を済みにする(段落の外の件数は 0)', same([...d2], ['F-001/Task-1']) && specOutsideLastParagraph([lastBody]) === 0, JSON.stringify([...d2]));
  const d3 = doneTasksOf([squashBody]);
  check('IMPL-0517:ok スカッシュの箇条に似た本文は、末尾の段落の Task-2 だけを数え、外の件数は 1', same([...d3], ['F-001/Task-2']) && specOutsideLastParagraph([squashBody]) === 1, JSON.stringify([...d3]));
  check('IMPL-0517:ok 3つの本文で doneTasksOf と手戻り率の specTrailersOf が一致する', [midBody, lastBody, squashBody].every((b) => same([...doneTasksOf([b])].sort(), [...new Set(specTrailersOf(b))].sort())));
  // 突合の直し: 段落の外の件数は、末尾の段落にあれば済みに数えた形(F-NNN / Task-N)の行だけを数える
  const setupBody = 'セットアップ\n\nSpec: setup\n\nCo-Authored-By: someone <a@example.com>';
  check('IMPL-0517:ng 中の段落の Spec: setup は、段落の外の件数に数えない', specOutsideLastParagraph([setupBody]) === 0 && doneTasksOf([setupBody]).size === 0);
  check('IMPL-0517:ok Spec: setup と Spec: F-001 / Task-1 の本文が混ざっても、タスクの形の1件だけを数える', specOutsideLastParagraph([setupBody, midBody]) === 1);
  // 結線: doneTasks は偽の git の出力から { done, outside } を作る(読めなければ null)
  const fakeLog = [lastBody, midBody, setupBody].join(String.fromCharCode(0));
  let seenArgs = null;
  const dt = doneTasks('main', (a) => { seenArgs = a; return fakeLog; });
  check('IMPL-0517:ok doneTasks は git log の本文から済みのタスクと段落の外の件数を作る', dt && same([...dt.done], ['F-001/Task-1']) && dt.outside === 1 && seenArgs[0] === 'log' && seenArgs[1] === 'main', JSON.stringify(dt));
  check('IMPL-0517:ng doneTasks は git を読めなければ null', doneTasks('main', () => null) === null);
  check('IMPL-0517:ok 注記の文は件数から作り、0 件なら出さない。段落の読み方だけが手戻り率と同じと言う', outsideSpecNote(0) === null && /3 件/.test(outsideSpecNote(3)) && /段落の読み方は手戻り率と同じ/.test(outsideSpecNote(3)));
  // 入口: 関数を直接呼ぶ試験では、注記を出す結線(computeNext)を外しても通る。一時の git リポジトリで /pit(next.mjs --offline)を通す
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl0517-entry-'));
    try {
      fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), path.join(dir, 'scripts'), { recursive: true, filter: (src) => !/[\\/]fixtures([\\/]|$)/.test(src) });
      fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify({
        configured: true,
        gates: { g2: { state: 'required', label: 'G-2 要件合意' } },
        roles: [{ id: 'value-owner', name: '価値責任者', gatesOwned: ['g2'] }],
        seats: [{ role: 'value-owner', accountable: 'p1' }],
        people: [],
      }, null, 2));
      const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '', GIT_CEILING_DIRECTORIES: path.dirname(dir) };
      const g = (args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8', env });
      g(['init', '-q', '-b', 'main']);
      g(['add', '-A']);
      g(['commit', '-q', '-m', 'a\n\nSpec: F-001 / Task-1\n\nCo-Authored-By: x <x@example.com>', '--allow-empty']);
      const pit = () => { const r = spawnSync(process.execPath, ['scripts/gate/next.mjs', '--offline'], { cwd: dir, encoding: 'utf8', env }); return `${r.stdout ?? ''}${r.stderr ?? ''}`; };
      check('IMPL-0517:ng 入口: 末尾の段落の外の Spec: F-001 / Task-1 は、/pit の注記に件数と理由が出る', /1 件は、トレーラ[^\n]*末尾の段落の外/.test(pit()));
      g(['commit', '-q', '--allow-empty', '-m', 'b\n\nSpec: setup\n\nCo-Authored-By: x <x@example.com>']);
      check('IMPL-0517:ok 入口: Spec: setup だけを段落の外に持つコミットは、件数を増やさない(1 件のまま)', /1 件は、トレーラ/.test(pit()) && !/2 件は、トレーラ/.test(pit()));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
console.log('');
if (failures) {
  console.log(`next.mjs の判定記録の読み取りの試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`next.mjs の判定記録の読み取りの試験: ${n} 件が期待と一致しました`);
