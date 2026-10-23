// next.mjs が判定記録の 3 つの出所を読む部分の試験(process-compass #321 / #54 段階 2)。
//
//   node scripts/gate/test-next-records.mjs
//
// git と GitHub を使いません。fixtures/gates/(基底ブランチの docs/gates/ の様式)と fixtures/records/(記録用ブランチの
// 様式と承認レビューの写し)を直接読み、readRecordsBranch の戻り値と同じ形を手で組み立てて collectRecords 以下に渡します。
// 写しの PR と機能の対応(PR 本文の Spec: トレーラ・タイトル・ブランチ名)は、prInfoOf を差し替えて与えます。
// 記録用ブランチの実際の読み取りは test-records.mjs、next.mjs の全体の段階の導出(構成・D-0・仕様)は、この試験では確かめていません。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRecords, recordsFromCopy, gateRecordFromText, featureOfPr, passed, recordIssues, recordRoute, g6Status } from './next.mjs';

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
    { id: 'p1', name: '山田 太郎', accounts: ['yamada'] },
    { id: 'p2', name: '鈴木 一郎', accounts: ['suzuki'] },
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
  const r14 = recordsFromCopy(copyOf(14), info, { config: { people: [{ id: 'p1', name: '山田 太郎', accounts: ['yamada'] }] } });
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

console.log('');
if (failures) {
  console.log(`next.mjs の判定記録の読み取りの試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`next.mjs の判定記録の読み取りの試験: ${n} 件が期待と一致しました`);
