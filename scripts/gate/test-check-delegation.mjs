// 委任した変更のマージの経路の判定(check-delegation)を、フィクスチャで試験する。
//
//   node scripts/gate/test-check-delegation.mjs
//
// 該当する場面1つと、該当しない場面を、入力を1か所ずつ変えて確かめます。GitHub へ問い合わせません。
// あわせて、ワークフロー(delegation.yml)が PR の先頭を checkout していないこと、承認を付けていない
// ことを、定義の文字列で確かめます。実際の GitHub 上での動作は、この試験では確かめていません。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, observationWindowAt, observationWindowProblems, reworkBaselineAt, reworkBaselineProblems } from './config.mjs';
import { judgeDelegatedMerge } from './delegation.mjs';
import { readF2Q1, readF2Q1Text } from './cl-judgment.mjs';
import { l3ScopeIds, autonomyCap, autonomyState, autonomyNoteLines, rejectionText, undeclaredChangeRequests, undeclaredText, stopsText, parseDefectRows, parseRejection, capRefusal, readHistory, readHandoverVersions, rejectionsFromReviewCopies, readRejectionRecords, reworkText, planReworkTasks, specTrailersOf, readReworkRecords, REWORK_UNCOUNTED, DETECTION_UNVERIFIED, detectionBasisText } from './autonomy.mjs';
import { buildDelegation, renderAutonomyTable } from '../init/generate-profile.mjs';

const FIXTURE = path.join(ROOT, 'scripts/gate/fixtures/delegation-eligible.json');
const base = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const seat = (input, role) => input.config.seats.find((s) => s.role === role);
const rule = (input, id) => input.config.delegation.rules.find((r) => r.id === id);
const setRisk = (input, value) => {
  input.pr.body = input.pr.body.replace(/(## リスク区分\n\n)R3/, `$1${value}`);
};

// 開発者の席の規則を外し、トレーラを独立レビュアの席の規則(DR-002)へ向ける
const reviewerOnly = (input) => {
  input.config.delegation.rules = input.config.delegation.rules.filter((r) => r.id !== 'DR-001');
  for (const c of input.commits) c.message = c.message.replace('DR-001', 'DR-002');
};

// 欠陥の台帳の行(Sev1・Sev2 の AI 起因。第5章 5.4.6)
const sev = (severity, aiCause, date, changeTypes = null) => ({ id: 'BUG-9', severity, aiCause, date, changeTypes });

// 承認レビューの写し(record-copy.yml の形)。レビューを媒体とした G-6 の判定(標準 第4章 G-6「承認レビューを判定記録とする条件」)
const reviewCopy = (body, pr = 45, submittedAt = '2026-08-07T01:00:00Z') => ({
  file: `records/reviews/pr-${pr}.json`,
  copy: { pr, head_sha: 'a'.repeat(40), reviews: [{ id: 7, user: { login: 'reviewer-a', id: 9 }, body, state: 'CHANGES_REQUESTED', commit_id: 'a'.repeat(40), submitted_at: submittedAt }] },
});

// [場面, 入力を変える関数, 該当するか(G-6 を事後へ移す委任), 満たさないはずの条件, 扱い(省略時は該当=post-hoc / 該当しない=collab)]
const cases = [
  // IMPL-0285:ok IMPL-0286:ok IMPL-0020:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  ['該当する(規則の範囲・R3・G-5 通過・トレーラあり)', () => {}, true, []],
  ['範囲外のファイルを含む', (i) => i.files.push({ path: 'src/pay.js', additions: 1, deletions: 0 }), false, ['条件2']],
  ['強制層に触れる(.github/**)', (i) => i.files.push({ path: '.github/workflows/gate-g5.yml', additions: 1, deletions: 1 }), false, ['条件2']],
  ['強制層に触れる(process.config.json)', (i) => (i.files = [{ path: 'process.config.json', additions: 1, deletions: 1 }]), false, ['条件2']],
  ['強制層に触れる(判定記録の置き場)', (i) => i.files.push({ path: 'docs/gates/g6-x.md', additions: 5, deletions: 0 }), false, ['条件2']],
  // 検知の入力となる記録(欠陥の台帳・運用引き継ぎ文書)は、規則の範囲に入れても委任しない(突合 X-1)
  ...['docs/defect-ledger.md', 'docs/handover.md'].map((f) => [
    `検知の入力となる記録に触れる(${f}。規則の範囲が docs/** でも)`,
    (i) => {
      for (const r of i.config.delegation.rules) r.paths.push('docs/**');
      i.files = [{ path: f, additions: 1, deletions: 1 }];
    },
    false,
    ['条件2'],
  ]),
  ['名前の変更で、元のパスが範囲外', (i) => (i.files[0].previousPath = 'src/pay.json'), false, ['条件2']],
  // IMPL-0594:ng(R1・R2 の変更は、種別が L3 でも委任で進まない。L3 の効果は委任の経路だけで、条件2 が R3 を求める)
  ['リスク区分が R1', (i) => setRisk(i, 'R1'), false, ['条件2']],
  ['リスク区分が R2', (i) => setRisk(i, 'R2'), false, ['条件2']],
  ['リスク区分が未記入(選択肢のまま)', (i) => setRisk(i, 'R1 / R2 / R3'), false, ['条件2']],
  ['トレーラなし', (i) => (i.commits[0].message = 'fix: 文言\n\nSpec: F-012 / Task-3'), false, ['条件2', '条件7']],
  [
    'トレーラの無いコミットが混ざる',
    (i) => i.commits.push({ sha: '2222222222222222', message: 'fix: 追加の修正\n\nSpec: F-012 / Task-3' }),
    false,
    ['条件2', '条件7'],
  ],
  ['トレーラが指す規則が無い', (i) => (i.commits[0].message = i.commits[0].message.replace('DR-001', 'DR-999')), false, ['条件2']],
  ['未承認の規則(AI維持管理者の承認なし)', (i) => delete rule(i, 'DR-001').approvedBy, false, ['条件2']],
  ['規則の承認者が AI維持管理者の席の責任者でない', (i) => (rule(i, 'DR-001').approvedBy = '山田 太郎'), false, ['条件2']],
  ['登録されていない変更種別', (i) => (i.config.delegation.changeTypes = []), false, ['条件2']],
  ['変更種別の一覧を持たない旧い構成', (i) => delete i.config.delegation.changeTypes, false, ['条件2']],
  // 登録の根拠の detection は、検知条件ごとに算出の所在を書く(標準 第5章 5.5.4)。1つの文にまとめた記入は、記入なしとして扱う
  ['登録の根拠の detection が1つの文(検知条件ごとでない)', (i) => (i.config.delegation.changeTypes[0].basis.detection = '計測している'), false, ['条件2']],
  ['登録の根拠の detection の検知条件が1つ欠ける', (i) => delete i.config.delegation.changeTypes[0].basis.detection.reworkRate, false, ['条件2']],
  ['開発者の席の規則にだけ該当する(独立レビュアの席の規則なし)', (i) => i.config.delegation.rules.pop(), false, ['G-6'], 'performer-verified'],
  ['独立レビュアの席が委任を宣言していない', (i) => (seat(i, 'independent-reviewer').mode = 'collab'), false, ['G-6'], 'performer-verified'],
  [
    '開発者の席の規則にだけ該当するが、G-5 が未通過',
    (i) => {
      i.config.delegation.rules.pop();
      i.checks[0].conclusion = 'failure';
    },
    false,
    ['G-6', '条件3'],
    'collab',
  ],
  // IMPL-0020:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  ['適合性確認が失効している(担い手の識別が変わった)', (i) => (seat(i, 'dev-verifier').performer.model = 'model-x-2'), false, ['条件2']],
  ['変更行数が上限を超える', (i) => (i.files[0].additions = 500), false, ['条件2']],
  ['CL1', (i) => (i.config.answers['q-criticality'] = 'cl1'), false, ['条件1']],
  ['規制業', (i) => (i.config.answers['q-quality'] = 'quality-regulated'), false, ['条件1']],
  ['構成が委任を許していない', (i) => (i.config.delegation.allowed = false), false, ['条件1', '条件2']],
  [
    '出荷できない状態',
    (i) => (i.config.shipBlocked = { reason: 'CL1 以上・規制業で体制が3名を割った', since: '2026-09-30' }),
    false,
    ['条件1'],
  ],
  ['G-5 未通過(失敗)', (i) => (i.checks[0].conclusion = 'failure'), false, ['条件3']],
  ['G-5 未完了', (i) => (i.checks[0] = { name: 'gate-g5', status: 'in_progress', conclusion: null }), false, ['条件3']],
  ['G-5 の結果が無い', (i) => (i.checks = []), false, ['条件3']],
  [
    '確約範囲・コア指定のパスに触れる(規則の範囲の内側でも対象外)',
    (i) => {
      i.files = [{ path: 'src/core/a.js', additions: 1, deletions: 0 }];
      for (const r of i.config.delegation.rules) r.paths = ['src/**'];
    },
    false,
    ['条件2', '条件5'],
  ],
  ['変更種別を登録した者が、登録の権限を持つ席の責任者でない', (i) => (i.config.delegation.changeTypes[0].registeredBy = '山田 太郎'), false, ['条件2']],
  // G-6 を事後へ移す委任で、開発者の席がこの変更について協働(独立レビュアの席の規則だけ)の場合は、
  // 開発者の席の責任者(人)の承認を要する(第5章 5.5.6)
  ['独立レビュアの席の規則だけに該当し、開発者の席の責任者の承認が無い', (i) => reviewerOnly(i), false, ['開発者の席']],
  [
    '独立レビュアの席の規則だけに該当し、開発者の席の責任者が承認している',
    (i) => {
      reviewerOnly(i);
      i.reviews = [{ login: 'yamada-taro', id: 2001, state: 'APPROVED' }];
    },
    true,
    [],
  ],
  [
    '独立レビュアの席の規則だけに該当し、開発者の席の責任者が承認の後に変更を要求した',
    (i) => {
      reviewerOnly(i);
      i.reviews = [{ login: 'yamada-taro', id: 2001, state: 'APPROVED' }, { login: 'yamada-taro', id: 2001, state: 'CHANGES_REQUESTED' }];
    },
    false,
    ['開発者の席'],
  ],
  [
    '独立レビュアの席の規則だけに該当し、開発者の席の責任者でない人が承認している',
    (i) => {
      reviewerOnly(i);
      i.reviews = [{ login: 'suzuki-ichiro', id: 2003, state: 'APPROVED' }];
    },
    false,
    ['開発者の席'],
  ],
  ['Draft の PR', (i) => (i.pr.draft = true), false, ['前提']],
  ['基底が既定ブランチでない', (i) => (i.pr.baseRef = 'release'), false, ['前提']],
  ['フォークからの PR', (i) => (i.pr.fromFork = true), false, ['前提']],
  ['プロセス構成が未設定', (i) => (i.config.configured = false), false, ['前提', '5.4.6']],
  // 第5章 5.4.6。登録した変更種別の停止(第1区分・第2区分・上限)。止まった種別の変更は協働で扱う
  // IMPL-0284:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  ['5.4.6: AI 起因の Sev1(登録の判定より後)', (i) => i.records.defects.rows.push(sev('Sev1', 'あり', '2026-10-05')), false, ['5.4.6']],
  ['5.4.6: 原因を特定できない Sev2', (i) => i.records.defects.rows.push(sev('Sev2', '特定できない', '2026-10-05')), false, ['5.4.6']],
  ['5.4.6: AI 起因の欄が空欄の Sev1(特定できないと同じく扱う)', (i) => i.records.defects.rows.push(sev('Sev1', '', '2026-10-05')), false, ['5.4.6']],
  ['5.4.6: 発生日の無い AI 起因の Sev1', (i) => i.records.defects.rows.push(sev('Sev1', 'あり', null)), false, ['5.4.6']],
  // IMPL-0284:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  ['5.4.6: AI 起因でない Sev1 は止めない', (i) => i.records.defects.rows.push(sev('Sev1', 'なし', '2026-10-05')), true, []],
  ['5.4.6: AI 起因の Sev3 は止めない', (i) => i.records.defects.rows.push(sev('Sev3', 'あり', '2026-10-05')), true, []],
  ['5.4.6: 登録の判定より前の AI 起因の Sev1 は止めない(登録し直した)', (i) => i.records.defects.rows.push(sev('Sev1', 'あり', '2026-09-01')), true, []],
  ['5.4.6: ほかの変更種別だけの AI 起因の Sev1 は止めない', (i) => i.records.defects.rows.push(sev('Sev1', 'あり', '2026-10-05', ['決済'])), true, []],
  ['5.4.6: 欠陥の台帳が無い(判定できない)', (i) => (i.records.defects = { present: false, rows: [] }), false, ['5.4.6']],
  ['5.4.6: コア機能の理解保持者数が1名', (i) => (i.records.core.rows[0].holders = 1), false, ['5.4.6']],
  ['5.4.6: コア機能の理解保持者数が0名(2名から一度に減った)', (i) => (i.records.core.rows[0].holders = 0), false, ['5.4.6']],
  ['5.4.6: 関わらない種別のコア機能の保持者1名は止めない', (i) => Object.assign(i.records.core.rows[0], { holders: 1, changeTypes: [] }), true, []],
  ['5.4.6: 運用引き継ぎ文書が無い(判定できない)', (i) => (i.records.core = { present: false, rows: [] }), false, ['5.4.6']],
  // IMPL-0285:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  ['5.4.6: 差し戻し率0%の2か月継続(最小標本数以上)', (i) => (i.records.rejections = []), false, ['5.4.6']],
  ['5.4.6: 判定基準の番号を引かない差し戻しは数えない(0%の継続を切らない)', (i) => (i.records.rejections[0].cited = false), false, ['5.4.6']],
  // レビューを媒体とした G-6 の差し戻し(写しの宣言行)も判定記録として数える(process-compass #321 の突合 F-3)
  // IMPL-0285:ok
  ['5.4.6: レビューを媒体とした差し戻し(宣言行が基準の番号を引く)を数える', (i) => (i.records.rejections = rejectionsFromReviewCopies([reviewCopy('G-6: 差し戻し / 基準 2 / 期限 2026-08-14\n\n境界の値のテストが無い。')])), true, []],
  // IMPL-0285:ng
  ['5.4.6: 宣言行が基準の番号を引かないレビューの差し戻しは数えない', (i) => (i.records.rejections = rejectionsFromReviewCopies([reviewCopy('G-6: 差し戻し')])), false, ['5.4.6']],
  ['5.4.6: 宣言行の無いレビューは判定に数えない(本文に基準の番号があっても)', (i) => (i.records.rejections = rejectionsFromReviewCopies([reviewCopy('基準2を満たしていません。')])), false, ['5.4.6']],
  ['5.4.6: ほかのゲートの宣言行の差し戻しは G-6 に数えない', (i) => (i.records.rejections = rejectionsFromReviewCopies([reviewCopy('G-4: 差し戻し / 基準 2')])), false, ['5.4.6']],
  ['5.4.6: 判定の日より後のレビューの差し戻しは数えない', (i) => (i.records.rejections = rejectionsFromReviewCopies([reviewCopy('G-6: 差し戻し / 基準 2', 45, '2026-10-25T01:00:00Z')])), false, ['5.4.6']],
  // IMPL-0286:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  ['5.4.6: 窓が最小標本数に満たない(判定不能)', (i) => (i.records.history.changes = i.records.history.changes.slice(0, 29)), false, ['5.4.6']],
  ['5.4.6: 範囲外の変更は母数に数えない(判定不能)', (i) => i.records.history.changes.slice(0, 3).forEach((c) => (c.files = ['src/pay.js'])), false, ['5.4.6']],
  ['5.4.6: 既定ブランチの履歴を読めない(浅い取得)', (i) => (i.records.history = { available: false, reason: '浅い取得', changes: [] }), false, ['5.4.6']],
  ['5.4.6: 検知の記録を渡していない', (i) => delete i.records, false, ['5.4.6']],
  // IMPL-0289:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  ['5.4.6: AI自律レベルの上限が L2(構成)', (i) => (i.config.autonomy = { maxLevel: 'L2', source: 'tailoring' }), false, ['5.4.6']],
  // IMPL-0289:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  ['5.4.6: 上限の欄の無い旧い構成は回答から導く(CL0 は L3)', (i) => delete i.config.autonomy, true, []],
  // 検知条件から外した欄が残る旧い構成は、読まずに受け付ける(登録の要件にも数えない)
  ['旧い構成の外した検知条件の欄は読まない', (i) => (i.config.delegation.changeTypes[0].basis.detection.duplicationRate = '旧い記入'), true, []], // retired-ok: 外した旧い欄の後方互換を試す
];

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'NG  '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

for (const [label, mutate, eligible, unmetIds, handling = eligible ? 'post-hoc' : 'collab'] of cases) {
  const input = base();
  mutate(input);
  const r = judgeDelegatedMerge(input);
  const unmet = r.conditions.filter((c) => !c.ok).map((c) => c.id);
  const same = unmet.length === unmetIds.length && unmetIds.every((id) => unmet.includes(id));
  check(label, r.eligible === eligible && same && r.handling === handling, `${r.eligible ? '該当' : '該当しない'}${unmet.length ? `(${unmet.join('・')})` : ''}`);
  // 該当しない変更へ、先へ進めた記録の文を出さない
  if (!r.eligible && (r.rule !== null || r.record !== null)) check(`${label}: 該当しないのに規則または記録を返している`, false);
}

// 条件4・6 を判定していない旨が、出力に必ず載る
const r0 = judgeDelegatedMerge(base());
check('条件4・条件6 を判定していない旨を出力する', r0.notJudged.map((n) => n.id).join() === '条件4,条件6');
// 確約範囲とコア指定のパスのキーが無い構成は、条件5 を判定できないため該当しない。空の配列は宣言として通す
{
  const absent = base();
  delete absent.config.delegation.protectedPaths;
  const r1 = judgeDelegatedMerge(absent);
  const c5 = r1.conditions.find((c) => c.id === '条件5');
  check('確約範囲・コア指定: パスのキーが無い構成は、判定できないものとして該当しない', !r1.eligible && r1.handling === 'collab' && c5 && !c5.ok && /判定できない/.test(c5.problems[0]));
  const declared = base();
  declared.config.delegation.protectedPaths = [];
  const r2 = judgeDelegatedMerge(declared);
  check('確約範囲・コア指定: 空の配列は「なし」の宣言として通す', r2.eligible && /宣言済み/.test(r2.conditions.find((c) => c.id === '条件5').label));
}
check('先へ進めた記録の文が「承認ではない」を含む', /承認ではない/.test(r0.record ?? ''));

// 入口(--input)の終了コード
const run = (file) => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/gate/check-delegation.mjs'), '--input', file, '--json'], { encoding: 'utf8' });
    return 0;
  } catch (e) {
    return e.status;
  }
};
check('入口: 該当する入力で 0 を返す', run(FIXTURE) === 0);
const tmp = path.join(ROOT, 'evidence/.delegation-test-input.json');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
const ng = base();
setRisk(ng, 'R1');
fs.writeFileSync(tmp, JSON.stringify(ng));
check('入口: 該当しない入力で 1 を返す', run(tmp) === 1);
fs.rmSync(tmp, { force: true });

// ワークフローの定義。PR の側のコードを実行しない、承認を付けない、マージは既定で無効
const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/delegation.yml'), 'utf8');
const body = wf
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
check('ワークフロー: PR の先頭(head)を checkout していない', !/pull_request\.head|head_ref|refs\/pull/.test(body));
check('ワークフロー: checkout の ref が既定ブランチである', /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/.test(body));
check('ワークフロー: 承認のレビューを付けない', !/--approve|pulls\/[^\s]*\/reviews/.test(body));
check('ワークフロー: PR の題名・本文・ブランチ名をシェルへ展開していない', !/pull_request\.(title|body)|head_branch/.test(body));
check('ワークフロー: マージの実行は、変数とシークレットが揃った場合に限る', /vars\.DELEGATED_MERGE_ENABLED/.test(body) && /secrets\.DELEGATED_MERGE_TOKEN/.test(body));
const jobBlock = (name) => (body.split(/^  (?=[a-z-]+:\s*$)/m).find((b) => b.startsWith(`${name}:`)) ?? '');
check('ワークフロー: 判定のジョブは Environment を参照しない(有効化していない採用者に、保護の無い Environment を作らせない)', jobBlock('eligibility') !== '' && !/environment:/.test(jobBlock('eligibility')) && !/DELEGATED_MERGE_TOKEN/.test(jobBlock('eligibility')));
check('ワークフロー: マージのジョブだけが、既定ブランチに限った Environment の秘密情報からトークンを読み、有効化の変数で動く', /^\s{4}environment:\s*delegated-merge\s*$/m.test(jobBlock('merge')) && /vars\.DELEGATED_MERGE_ENABLED == 'true'/.test(jobBlock('merge')) && /secrets\.DELEGATED_MERGE_TOKEN/.test(jobBlock('merge')));
check('ワークフロー: pull_request_review で動かない(PR の側の定義で動くため)', !/^\s{2}pull_request_review:/m.test(body));
check('ワークフロー: pull_request ではなく pull_request_target で動く(定義を基底ブランチから読む)', /^\s{2}pull_request_target:/m.test(body) && !/^\s{2}pull_request:/m.test(body));

check('ワークフロー: 履歴の全体を取得する(差し戻し率の窓。浅い取得では判定できない)', (body.match(/fetch-depth:\s*0/g) ?? []).length === 2);

// AI自律レベルの上限と導出(第5章 5.4.4・5.4.6)
{
  const cfg = (answers) => ({ configured: true, answers });
  check('上限: 欄の無い旧い構成の CL0 は L3', autonomyCap(cfg({ 'q-criticality': 'cl0' })).level === 'L3');
  check('上限: 欄の無い旧い構成の CL2 は L2(登録を拒む)', autonomyCap(cfg({ 'q-criticality': 'cl2' })).level === 'L2' && capRefusal(cfg({ 'q-criticality': 'cl2' })) !== null);
  check('上限: 欄の無い旧い構成の CL3 は L1', autonomyCap(cfg({ 'q-criticality': 'cl3' })).level === 'L1');
  check('上限: 未設定の構成は L1', autonomyCap({ configured: false }).level === 'L1');
  check('生成: 上限が L3 の回答では委任を許す', buildDelegation({ 'q-criticality': 'cl0', 'q-quality': 'quality-standard' }).allowed === true);
  check('生成: 上限が L3 未満の回答では委任を許さない(理由に上限を出す)', buildDelegation({ 'q-criticality': 'cl3' }).blockedBy.some((b) => /上限が L1/.test(b)));
  const table = renderAutonomyTable(base().config, false, { q1: false }).join('\n');
  check('生成: D-0 の表に、登録した変更種別の L3 と、それ以外の L1 と、計測の所在を出す', /表示文言 \| L3/.test(table) && /\| それ以外 \| L1/.test(table) && /最小標本数 30 件/.test(table) && /準拠テンプレートが算出する/.test(table) && /数えていない/.test(table) && !/\| L3 \|[^\n]*未計測/.test(table));
  {
    const nr = base();
    delete nr.config.delegation.changeTypes[0].basis.detection.reworkRate;
    const t2 = renderAutonomyTable(nr.config, false, { q1: false }).join('\n');
    check('生成: 手戻り率の根拠が未記入の種別は、L3 と「未計測」を同じ行に出さない(L1 と出す。突合 X-4)', t2.includes('L1(手戻り率が未計測)') && !/\| L3 \|[^\n]*未計測/.test(t2));
  }
  const s0 = autonomyState(base().config, base().records);
  check('導出: 登録した変更種別は L3、それ以外は L1', s0.types[0].level === 'L3' && s0.otherLevel === 'L1');
  check('導出: 手戻り率の記録を渡さない入力は「読めない」と出し、止めず、数えていない残りを出す', s0.types[0].rework.state === '読めない' && s0.types[0].level === 'L3' && /数えていない/.test(s0.reworkUncounted) && /数えていない/.test(reworkText(s0.types[0])));
  // 差し戻し率0%で止めた種別は、評価の日より後の登録で戻る
  const z = base();
  z.records.rejections = [];
  check('差し戻し率0%: 評価の日(2026-10-01)より前の登録では止まる', autonomyState(z.config, z.records).types[0].level === 'L1');
  z.config.delegation.changeTypes[0].registeredAt = '2026-10-02';
  const zs = autonomyState(z.config, z.records).types[0];
  check('差し戻し率0%: 評価の日より後に登録し直すと、引き下げは戻る(最新の窓は0%と表示する)', zs.level === 'L3' && zs.rejection.state === '0%');
  // 判定不能は、判定可能な窓が得られた時点で戻る(登録の判定を待たない)
  const u = base();
  u.records.history.changes = u.records.history.changes.slice(0, 20);
  const us = autonomyState(u.config, u.records).types[0];
  check('判定不能: 適用の条件の欠落として止め、「判定不能」と表示する', us.level === 'L1' && us.rejection.state === '判定不能' && us.stops.every((x) => x.kind === 'unmeasurable'));
  // 原因を特定できない事象は、「なし」へ改めれば戻る
  const c = base();
  c.records.defects.rows.push({ id: 'BUG-1', severity: 'Sev1', aiCause: '特定できない', date: '2026-10-05', changeTypes: null });
  check('原因を特定できない: 止まる', autonomyState(c.config, c.records).types[0].stops.some((x) => x.kind === 'cause-unknown'));
  c.records.defects.rows[0].aiCause = 'なし';
  check('原因を特定できない: 特定して AI 起因でないと分かれば戻る', autonomyState(c.config, c.records).types[0].level === 'L3');
  // 原因を特定できない事象は、事象の日より後に登録し直しても戻らない(突合 X-3)
  c.records.defects.rows[0].aiCause = '特定できない';
  c.config.delegation.changeTypes[0].registeredAt = '2026-10-10';
  check('原因を特定できない: 事象の日より後に登録し直しても止まったまま', autonomyState(c.config, c.records).types[0].level === 'L1');
  c.records.defects.rows[0].aiCause = 'あり';
  check('AI 起因あり: 事象の日より後の登録の判定で戻る', autonomyState(c.config, c.records).types[0].level === 'L3');
  c.config.delegation.changeTypes[0].registeredAt = '2026-09-30';
  check('AI 起因あり: 事象の日より前の登録のままなら止まる(引き下げ)', autonomyState(c.config, c.records).types[0].stops.some((x) => x.kind === 'downgrade'));
  // 出荷前に検出した欠陥は数えない(突合 X-6)
  c.records.defects.rows[0].phase = '出荷前';
  check('出荷前に検出した Sev1 は停止に数えない', autonomyState(c.config, c.records).types[0].level === 'L3');
  // 判定の日より後の事象は数えない(突合 X-10)
  c.records.defects.rows[0].phase = '運用';
  c.records.defects.rows[0].date = '2026-10-25';
  check('判定の日(2026-10-20)より後の事象は数えない', autonomyState(c.config, c.records).types[0].level === 'L3');
  // 登録日の無い種別は止まる(突合 X-9)
  const nd = base();
  delete nd.config.delegation.changeTypes[0].registeredAt;
  const nds = autonomyState(nd.config, nd.records).types[0];
  check('登録日の無い種別は、理由を付けて止める', nds.level === 'L1' && nds.stops.some((x) => /registeredAt/.test(x.reason)));
  // コア機能の理解保持者数(突合 X-2)
  const h = base();
  h.records.core.rows[0].holders = 1;
  check('保持者1名: 止まる(引き下げ)', autonomyState(h.config, h.records).types[0].stops.some((x) => x.kind === 'downgrade'));
  h.records.core.rows[0].holders = 2;
  h.records.core.rows[0].lowUntil = '2026-10-05';
  check('保持者が回復しても、回復の後の登録の判定が無ければ止まる', autonomyState(h.config, h.records).types[0].stops.some((x) => x.kind === 'downgrade' && /2026-10-05/.test(x.reason)));
  h.config.delegation.changeTypes[0].registeredAt = '2026-10-06';
  check('保持者の回復の後に登録し直すと戻る', autonomyState(h.config, h.records).types[0].level === 'L3');
  h.records.core.history = { available: false, reason: '浅い取得' };
  const hs = autonomyState(h.config, h.records).types[0];
  check('運用引き継ぎ文書の履歴を読めない: 判定できないものとして止め、理由を出す', hs.level === 'L1' && hs.stops.some((x) => x.kind === 'unmeasurable' && /浅い取得/.test(x.reason)));
  // 登録より後の、最新でない評価の日の0%の窓でも止まる(突合 X-15)
  const e = base();
  const july = Array.from({ length: 16 }, (_, k) => ({ ref: `00000000000000000000000000000000000001${String(k).padStart(2, '0')}`, date: `2026-07-${String(k + 1).padStart(2, '0')}`, pr: String(100 + k), files: ['src/i18n/ja.json'] }));
  e.records.history.changes = [...july, ...e.records.history.changes];
  e.records.rejections = [{ file: 'docs/gates/g6-PR-56.md', date: '2026-09-05', target: 'PR #56', cited: true }];
  e.config.delegation.changeTypes[0].registeredAt = '2026-07-15';
  const es = autonomyState(e.config, e.records).types[0];
  check('差し戻し率0%: 最新の窓は判定可能でも、登録より後の前の月(2026-09-01)の0%の窓で止まる', es.level === 'L1' && es.rejection.state === '判定可能' && es.stops.some((x) => x.kind === 'downgrade' && /2026-09-01/.test(x.reason)));
  e.config.delegation.changeTypes[0].registeredAt = '2026-09-02';
  check('差し戻し率0%: その評価の日より後に登録し直すと戻る', autonomyState(e.config, e.records).types[0].level === 'L3');
  // 判定不能は、判定可能な窓が得られた時点で、登録し直さずに戻る(突合 X-15)
  const r = base();
  r.config.delegation.changeTypes[0].registeredAt = '2026-08-20';
  r.records.asOf = '2026-09-20';
  const rs1 = autonomyState(r.config, r.records);
  check('判定不能からの回復: 窓が最小標本数に満たない間は止める', rs1.types[0].level === 'L1' && rs1.types[0].rejection.state === '判定不能');
  r.records.asOf = '2026-10-20';
  check('判定不能からの回復: 判定可能な窓が得られると、登録し直さずに戻る', autonomyState(r.config, r.records).types[0].level === 'L3');
  // 表示は判定不能を「異常なし」と書かない(突合 X-15)
  const lines1 = autonomyNoteLines(rs1).join('\n');
  // IMPL-0287:ng(違反の入力: 窓が最小標本数に満たない判定不能。/pit の注記に判定不能と出す。process-compass #314)
  check('表示: 判定不能を出し、「異常なし」と書かない', /判定不能/.test(lines1) && !/異常なし/.test(lines1) && /判定を待たずに戻る/.test(lines1));
  const sOk = autonomyState(base().config, base().records);
  const lines0 = autonomyNoteLines(sOk).join('\n');
  // IMPL-0287:ok(適合の入力: 判定可能で停止の無い種別。判定不能と出さない)
  check('表示: 停止の無い種別でも「異常なし」と書かず、手戻り率の数えていない残りを出す', /停止なし/.test(lines0) && !/異常なし/.test(lines0) && !/判定不能/.test(lines0) && /手戻り率: 読めない/.test(lines0) && /数えていない/.test(lines0));
  // 保証の開示の項目3 が使う1行の表示(aggregate-evidence.mjs の rejectionText・stopsText)
  const rej1 = `${rejectionText(rs1.types[0])} / ${stopsText(rs1.types[0])}`;
  // IMPL-0288:ng(違反の入力: 判定不能の窓。開示の行に判定不能と出し、「異常なし」と書かない)
  check('開示の行: 判定不能の窓を判定不能と出し、「異常なし」と書かない', /判定不能/.test(rej1) && !/異常なし/.test(rej1), rej1);
  const rej0 = `${rejectionText(sOk.types[0])} / ${stopsText(sOk.types[0])}`;
  // IMPL-0288:ok(適合の入力: 判定可能で停止の無い種別。判定不能と出さない)
  check('開示の行: 判定可能で停止の無い種別は、判定不能と出さず停止なしと出す', !/判定不能/.test(rej0) && !/異常なし/.test(rej0) && /なし$/.test(rej0), rej0);
  // 観測の窓(process-compass #349。IMPL-0516)。構成の欄 observationWindow = { months, history: [{ months, recordedAt, decidedBy, reason }] }。
  // 評価の日ごとに、記録した日 < 評価の日の最後の値を当てる。遡って当てない。欄の無い構成は既定の 2
  {
    const withWindow = (cfg, history) => {
      cfg.observationWindow = { months: history.at(-1).months, history };
      return cfg;
    };
    const h4 = (recordedAt) => [{ months: 4, recordedAt, decidedBy: '山田 太郎', reason: '件数が少ない種別のため' }];
    const c0 = base().config;
    check('観測の窓: 欄の無い構成は既定の 2 か月', observationWindowAt(c0, '2026-10-01') === 2 && observationWindowAt({}, '2026-10-01') === 2);
    // D-0 の生成区間(renderAutonomyTable は日付を取らない。履歴の固定の値だけで決まる)。process-compass #349 突合2巡目 高-1・中-1・低-3。
    // 「効く評価の日」の表示は正規表現の \d 落ちで常に「記録なし」と出ていた。停止の残りは本ファイルの IMPL-0516:ng の場面が覆う
    {
      const entry = (months, recordedAt) => ({ months, recordedAt, decidedBy: '山田 太郎', reason: 'x' });
      const tbl = (history) => renderAutonomyTable(withWindow(base().config, history), false, { q1: false }).join('\n');
      const tLong = tbl([entry(4, '2026-10-10')]);
      check('D-0 の窓(長くした): 最新の値 4か月・2026-11-01 の評価から・前の値 2か月・記録した日を出す', /最新の値は 4か月で、2026-11-01 の評価から効く/.test(tLong) && /前の値\(2か月\)で数える/.test(tLong) && /記録した日 2026-10-10/.test(tLong) && !/記録なし/.test(tLong));
      const tShort = tbl([entry(4, '2026-09-01'), entry(2, '2026-10-10')]);
      check('D-0 の窓(短くした): 効いている長い値(4か月)と、次に効く短い値(2か月)・効く評価の日(2026-11-01)を出す', /最新の値は 2か月で、2026-11-01 の評価から効く/.test(tShort) && /前の値\(4か月\)で数える/.test(tShort) && /直近、評価の日に効く観測の窓/.test(tShort) && !/毎月、直近2か月の窓/.test(tShort));
      check('D-0 の窓(年をまたぐ): 12 月に記録した値は翌年 1 月 1 日の評価から効く', /2027-01-01 の評価から効く/.test(tbl([entry(3, '2026-12-20')])));
      const tDef = renderAutonomyTable(base().config, false, { q1: false }).join('\n');
      check('D-0 の窓(既定): 窓の変更の開示は出さず、「直近2か月の窓」と書く', /毎月、直近2か月の窓\(/.test(tDef) && !/評価から効く/.test(tDef));
      check('D-0 の手戻り率の欄: 差し戻し率と共通の観測の窓であることを書く', /毎月、[^|]*\(差し戻し率と共通の観測の窓/.test(tLong.split('\n').find((l) => l.includes('表示文言')).split('|')[5] ?? ''));
    }
    const c4 = withWindow(base().config, h4('2026-10-10'));
    check(
      '観測の窓: 記録した日より後の評価の日から当てる(同じ日は前の値。前の評価の日へ遡らない)',
      observationWindowAt(c4, '2026-10-10') === 2 && observationWindowAt(c4, '2026-10-11') === 4 && observationWindowAt(c4, '2026-10-01') === 2
    );
    check('観測の窓: 下限・記名・理由・日付の順・最後の値の一致を検査する', observationWindowProblems(c4).length === 0 && observationWindowProblems({ observationWindow: { months: 1, history: [] } }).length > 0 && observationWindowProblems({ observationWindow: { months: 4, history: [{ months: 4, recordedAt: '2026-10-10', reason: 'x' }] } }).some((p) => /decidedBy/.test(p)) && observationWindowProblems({ observationWindow: { months: 4, history: [{ months: 4, recordedAt: '2026-10-10', decidedBy: 'Claude', reason: 'x' }] } }).length > 0 && observationWindowProblems({ observationWindow: { months: 5, history: h4('2026-10-10') } }).some((p) => /一致しない/.test(p)) && observationWindowProblems({ observationWindow: { months: 3, history: [...h4('2026-10-10'), { months: 3, recordedAt: '2026-09-01', decidedBy: '山田 太郎', reason: 'x' }] } }).some((p) => /日付の順/.test(p)));
    // IMPL-0516:ng(違反の入力: 窓を長くした日より前の評価の日。前の値(2)が効き、過去の 0% の停止が残る)
    const zz = base();
    zz.records.rejections = [];
    zz.config.delegation.changeTypes[0].registeredAt = '2026-08-20';
    withWindow(zz.config, h4('2026-10-10'));
    const zzs = autonomyState(zz.config, zz.records).types[0];
    check('観測の窓: 長くした日(2026-10-10)より前の評価の日(2026-10-01)には 2 か月が効き、過去の 0% の停止が残る', zzs.level === 'L1' && zzs.stops.some((x) => x.kind === 'downgrade' && /2026-10-01/.test(x.reason) && /2か月継続/.test(x.reason)), JSON.stringify(zzs.stops));
    // IMPL-0516:ok(適合の入力: 窓を長くした日より後の評価の日には長い窓が効く)
    const zy = base();
    zy.records.rejections = [];
    zy.config.delegation.changeTypes[0].registeredAt = '2026-08-20';
    withWindow(zy.config, h4('2026-09-01'));
    const zys = autonomyState(zy.config, zy.records);
    check('観測の窓: 長くした日より後の評価の日(2026-10-01)には 4 か月が効く(停止の理由と表示に出る)', zys.types[0].stops.some((x) => x.kind === 'downgrade' && /4か月継続/.test(x.reason)) && zys.types[0].rejection.months === 4 && zys.window.months === 4, JSON.stringify(zys.types[0].stops));
    // 判定不能の停止は、新しい窓が当たる最初の評価の日から解ける(現在の状態は直近の評価の日に効く窓で数える)
    const jf = base();
    jf.config.delegation.changeTypes[0].registeredAt = '2026-08-20';
    jf.records.asOf = '2026-09-20';
    jf.records.history.changes = jf.records.history.changes.filter((c) => c.date >= '2026-08-01');
    const before4 = autonomyState(jf.config, jf.records).types[0];
    withWindow(jf.config, h4('2026-09-01'));
    jf.records.history.changes = [
      ...Array.from({ length: 16 }, (_, k) => ({ ref: `00000000000000000000000000000000000002${String(k).padStart(2, '0')}`, date: `2026-06-${String(k + 1).padStart(2, '0')}`, pr: String(300 + k), files: ['src/i18n/ja.json'] })),
      ...jf.records.history.changes,
    ];
    // 記録した日(09-01)から次の評価の日(10-01)までは、前の値(2)で数える。判定の日が 09-20 でも判定不能の停止は残る
    const same4 = autonomyState(jf.config, jf.records).types[0];
    check('観測の窓: 記録した日から次の評価の日までは前の値で数え、判定不能の停止が残る(判定の日 09-20・記録 09-01)', before4.rejection.state === '判定不能' && same4.rejection.state === '判定不能' && same4.rejection.months === 2 && same4.level === 'L1' && /次の評価の日\(2026-10-01\)から 4か月/.test(same4.rejection.windowText), `${same4.rejection.n} ${same4.rejection.state} ${same4.rejection.windowText}`);
    // 次の評価の日(10-01 以降)には新しい窓(4 か月)が当たり、判定不能の停止が解ける
    jf.records.asOf = '2026-10-05';
    const after4 = autonomyState(jf.config, jf.records).types[0];
    check('観測の窓: 判定不能の停止が、次の評価の日(2026-10-01)から新しい窓(4 か月)で判定可能になると解ける', before4.rejection.state === '判定不能' && after4.rejection.state !== '判定不能' && after4.rejection.n >= 30 && after4.rejection.months === 4 && !/次の評価の日/.test(after4.rejection.windowText), `${before4.rejection.n} -> ${after4.rejection.n} ${after4.rejection.state}`);
    // 表示: 窓の長さを常に出し、既定より長いときは決定した者と日付を併記する
    const textDef = rejectionText(autonomyState(base().config, base().records).types[0]);
    const textLong = rejectionText(zys.types[0]);
    check('観測の窓: 長さを常に出し、既定より長いときは決定した者と日付を併記する', /観測の窓 2か月\(既定\)/.test(textDef) && /観測の窓 4か月\(既定 2か月より長い。決定: 山田 太郎、記録した日 2026-09-01\)/.test(textLong), `${textDef} | ${textLong}`);
    check('観測の窓: 次の一手の注記にも窓の長さを出す', autonomyNoteLines(zys).join('\n').includes('観測の窓 4か月'));
    // 履歴を読めないときも、窓の長さと決定した者を出す
    const noh = base();
    withWindow(noh.config, h4('2026-09-01'));
    noh.records.history = { available: false, reason: '試験' };
    const nohT = rejectionText(autonomyState(noh.config, noh.records).types[0]);
    check('観測の窓: 履歴を読めないときも、窓の長さと決定した者を出す', /判定できない\(履歴を読めない\)/.test(nohT) && /観測の窓 4か月\(既定 2か月より長い。決定: 山田 太郎/.test(nohT), nohT);
  }
  // 宣言行の無い CHANGES_REQUESTED(process-compass #350)。判定記録ではないため分子に数えず、件数だけを表示する
  {
    const rv = (id, state, body) => ({ id, user: { login: 'reviewer-a', id: 9 }, body, state, commit_id: 'a'.repeat(40), submitted_at: '2026-08-10T01:00:00Z' });
    const ux = undeclaredChangeRequests([
      { file: 'records/reviews/pr-40.json', copy: { pr: 40, reviews: [rv(1, 'CHANGES_REQUESTED', '直してください'), rv(2, 'CHANGES_REQUESTED', 'G-6: 差し戻し / 基準 1'), rv(3, 'APPROVED', 'よい')] } },
      { file: 'records/reviews/pr-41.json', copy: { pr: 41, reviews: [rv(4, 'CHANGES_REQUESTED', '')] } },
    ]);
    // IMPL-0285:ok(適合の入力: 宣言行の有る差し戻しと承認は、宣言行の無い差し戻しの要求に入れない)
    check('宣言行の無い差し戻し: 宣言行の有る CHANGES_REQUESTED と APPROVED を除き、無いものだけを取り出す', ux.length === 2 && ux.map((x) => x.target).join() === 'PR #40,PR #41', JSON.stringify(ux));
    const u1 = base();
    u1.records.rejections = [];
    u1.records.undeclared = { available: true, items: [{ file: 'records/reviews/pr-40.json', date: '2026-08-10', target: 'PR #40', reviewId: 1 }, { file: 'records/reviews/pr-9999.json', date: '2026-08-10', target: 'PR #9999', reviewId: 2 }] };
    const t1 = autonomyState(u1.config, u1.records).types[0];
    // IMPL-0285:ng(違反の入力: 宣言行の無い差し戻しの要求。分子に入れず、0% の判定を変えない)
    check('宣言行の無い差し戻し: 分子に入らない(差し戻し 0 件のまま 0% と判定し、停止の理由に件数を出す)', t1.rejection.rejected === 0 && t1.rejection.state === '0%' && t1.stops.some((x) => x.kind === 'downgrade' && /数えていない差し戻しの要求 1 件/.test(x.reason)), JSON.stringify(t1.stops));
    check('宣言行の無い差し戻し: 窓ごとの件数を、種別の範囲に入る変更の PR に限って数える(対応づかない PR は入れない)', t1.rejection.undeclared === 1, String(t1.rejection.undeclared));
    check('宣言行の無い差し戻し: 開示の行と次の一手に件数を出す', /数えていない差し戻しの要求 1 件\(宣言行が無く判定記録ではない。書き手の名義・席を問わない\)/.test(rejectionText(t1)) && autonomyNoteLines(autonomyState(u1.config, u1.records)).join('\n').includes('数えていない差し戻しの要求 1 件'));
    const u2 = base();
    u2.records.undeclared = { available: false, items: [] };
    const t2 = autonomyState(u2.config, u2.records).types[0];
    check('宣言行の無い差し戻し: 記録用ブランチを読めないときは「読めない」と出し、0 件と出さない', t2.rejection.undeclared === null && /読めない/.test(rejectionText(t2)) && !/要求 0 件/.test(rejectionText(t2)) && undeclaredText(0) === '数えていない差し戻しの要求 0 件(宣言行が無く判定記録ではない。書き手の名義・席を問わない)');
  }
  // 上限の理由(突合 X-16)
  const capNoQ = autonomyCap({ configured: true, answers: {} });
  check('上限: 回答に安全重要度の無い構成は L1 とし、理由を出す', capNoQ.level === 'L1' && /q-criticality/.test(capNoQ.reason));
  check('上限: CL2 の L2 は案件の上限で、安全関連部は F.3 により L1 固定、準拠テンプレートは範囲を持たないため登録を適用しない旨を出す', /案件の上限/.test(autonomyCap({ configured: true, answers: { 'q-criticality': 'cl2' } }).reason ?? '') && /L1 固定/.test(autonomyCap({ configured: true, answers: { 'q-criticality': 'cl2' } }).reason ?? ''));
}

// 手戻り率(標準 第5章 5.4.6。process-compass #348)。母数は窓の中に種別の範囲の取り込みを持つタスク。分子はトレーラの取り込み2回以上と
// 実装計画の履歴の「やり直し」の和。評価の日(2026-10-01)の窓は 2026-08-01〜2026-09-30。日付は固定で、実行日に依らない
{
  const changes0 = base().records.history.changes;
  const baseline = (pct, at = '2026-09-01') => ({ percent: pct, history: [{ percent: pct, recordedAt: at, decidedBy: '鈴木 一郎', reason: '直近の実績から置く' }] });
  const mk = ({ doubles = 0, plan = [], pct = 20, at, late = 0, outside = 0, count = 32, rework } = {}) => {
    const i = base();
    const trailers = changes0.slice(0, count).map((c, k) => ({ ref: c.ref, date: c.date, tasks: [`F-001/Task-${k + 1}`], files: c.files }));
    for (let k = 0; k < doubles; k++) trailers.push({ ref: `d${k}`, date: '2026-09-20', tasks: [`F-001/Task-${k + 1}`], files: ['src/i18n/ja.json'] });
    for (let k = 0; k < late; k++) trailers.push({ ref: `l${k}`, date: '2026-10-05', tasks: [`F-001/Task-${k + 20}`], files: ['src/i18n/ja.json'] });
    for (let k = 0; k < outside; k++) for (const d of ['2026-08-10', '2026-08-20']) trailers.push({ ref: `o${k}${d}`, date: d, tasks: [`F-002/Task-${k + 1}`], files: ['src/other.js'] });
    if (pct !== null) i.config.reworkBaseline = baseline(pct, at);
    i.records.rework = rework ?? { available: true, trailers, plan };
    return i;
  };
  const tOf = (i) => autonomyState(i.config, i.records).types[0];
  const stopsRework = (t) => t.stops.some((x) => x.kind === 'downgrade' && /手戻り率/.test(x.reason));

  const r6 = tOf(mk({ doubles: 6 }));
  // IMPL-0517:ok(適合の入力: 母数 32 件のうち手戻り 6 件 = 18.8%。基準値 20% 以内で止めない)
  check('手戻り率: 母数 32 件のうち 6 件(18.8%)は基準値 20% 以内で、止めない', r6.rework.state === '基準値以内' && r6.rework.n === 32 && r6.rework.numerator === 6 && r6.level === 'L3', JSON.stringify(r6.rework));
  const r7 = tOf(mk({ doubles: 7 }));
  // IMPL-0517:ng(違反の入力: 母数 32 件のうち手戻り 7 件 = 21.9%。基準値 20% を超え、評価の日より後の登録の判定まで止める)
  check('手戻り率: トレーラの取り込みが2回以上のタスクが基準値を超えると、種別を止める(引き下げ)', r7.rework.state === '基準値超過' && r7.level === 'L1' && stopsRework(r7) && r7.rework.trailer === 7, JSON.stringify(r7.rework));
  check('手戻り率: 比が基準値と等しいだけでは止めない(超えたときだけ)', tOf(mk({ doubles: 8, pct: 25 })).level === 'L3');

  const rPlanNew = tOf(mk({ doubles: 6, plan: [{ date: '2026-09-10', task: 'F-001/Task-20' }] }));
  check('手戻り率: 計画表の履歴の「やり直し」は分子に入る(和)', rPlanNew.rework.numerator === 7 && rPlanNew.rework.plan === 1 && rPlanNew.rework.state === '基準値超過', JSON.stringify(rPlanNew.rework));
  const rPlanDup = tOf(mk({ doubles: 6, plan: [{ date: '2026-09-10', task: 'F-001/Task-1' }, { date: '2026-09-12', task: 'F-001/Task-1' }] }));
  check('手戻り率: トレーラと計画表の両方に当たるタスクは1件に数える(和の重複排除)', rPlanDup.rework.numerator === 6 && rPlanDup.rework.both === 1 && rPlanDup.rework.trailer === 5 && rPlanDup.level === 'L3', JSON.stringify(rPlanDup.rework));
  check('手戻り率: 評価の日より後の計画表の版は数えない(遡らない)', tOf(mk({ doubles: 6, plan: [{ date: '2026-10-05', task: 'F-001/Task-20' }] })).rework.numerator === 6);
  check('手戻り率: 評価の日より後のトレーラの取り込みは数えない(遡らない)', tOf(mk({ doubles: 6, late: 3 })).rework.numerator === 6);
  const rOut = tOf(mk({ doubles: 6, outside: 4 }));
  check('手戻り率: 種別の範囲に入らない変更のタスクは、母数にも分子にも入れない', rOut.rework.n === 32 && rOut.rework.numerator === 6, JSON.stringify(rOut.rework));

  const rSmall = tOf(mk({ doubles: 20, count: 29 }));
  // IMPL-0517:ng(違反の入力: 母数 29 件。最小標本数 30 件に満たない窓を、異常なしと書かない)
  check('手戻り率: 母数 29 件は判定不能で、発火せず止めない(「異常なし」と書かない)', rSmall.rework.state === '判定不能' && !stopsRework(rSmall) && /判定不能/.test(reworkText(rSmall)) && !/異常なし/.test(reworkText(rSmall)), JSON.stringify(rSmall.rework));
  const rUnset = tOf(mk({ doubles: 12, pct: null }));
  check('手戻り率: 基準値が未設定なら発火せず、「基準値が未設定(発火しない)」と出す(止めない)', rUnset.rework.state === '基準値未設定' && rUnset.level === 'L3' && /基準値が未設定\(発火しない\)/.test(reworkText(rUnset)), reworkText(rUnset));

  // 基準値の効力日: 記録した日が評価の日より前の値を当てる。同じ日・後の記録は、その評価の日には効かない
  const cfgTwo = (secondAt) => ({ percent: 25, history: [{ percent: 20, recordedAt: '2026-09-01', decidedBy: '鈴木 一郎', reason: '置く' }, { percent: 25, recordedAt: secondAt, decidedBy: '鈴木 一郎', reason: '上げる' }] });
  const twoSame = mk({ doubles: 7 });
  twoSame.config.reworkBaseline = cfgTwo('2026-10-01');
  const twoBefore = mk({ doubles: 7 });
  twoBefore.config.reworkBaseline = cfgTwo('2026-09-30');
  check('手戻り率の基準値: 上げた日が評価の日と同じなら、その評価には前の値(20%)が効き、止まる', reworkBaselineAt(twoSame.config, '2026-10-01') === 20 && reworkBaselineAt(twoSame.config, '2026-10-02') === 25 && tOf(twoSame).level === 'L1');
  check('手戻り率の基準値: 上げた日が評価の日より前なら、その評価には新しい値(25%)が効き、止めない', reworkBaselineAt(twoBefore.config, '2026-10-01') === 25 && tOf(twoBefore).level === 'L3');
  const reReg = mk({ doubles: 7 });
  reReg.config.delegation.changeTypes[0].registeredAt = '2026-10-02';
  check('手戻り率: 評価の日より後に登録し直すと、引き下げは戻る(現在の窓の状態は超過と表示する)', tOf(reReg).level === 'L3' && tOf(reReg).rework.state === '基準値超過');

  const rBad = tOf(mk({ rework: { available: false, reason: '浅い取得(shallow)で、履歴の全体を読めない', trailers: [], plan: [] } }));
  check('手戻り率: 履歴を読めないときは「読めない」と出し、手戻り率では止めない', rBad.rework.state === '読めない' && !stopsRework(rBad) && /読めない/.test(reworkText(rBad)));

  // 表示と実態: どの状態でも、数えていない残りを省かない。/pit の注記と保証の開示の行に同じ文が出る
  for (const [name, t] of [['超過', r7], ['以内', r6], ['判定不能', rSmall], ['基準値未設定', rUnset], ['読めない', rBad], ['記録なし', tOf(base())]]) {
    check(`手戻り率の表示(${name}): 数えていない残り(不採用の後の再作成)を省かない`, reworkText(t).includes(REWORK_UNCOUNTED) && /不採用/.test(reworkText(t)) && !/異常なし/.test(reworkText(t)));
  }
  const sNote = autonomyState(mk({ doubles: 7 }).config, mk({ doubles: 7 }).records);
  check('手戻り率の表示: /pit の注記に、算出した値・母数・内訳・基準値・数えていない残りが出る', (() => { const l = autonomyNoteLines(sNote).join('\n'); return /母数 32 件のうち手戻り 7 件/.test(l) && /基準値 20%/.test(l) && /トレーラの取り込みが2回以上のみ 7 件/.test(l) && /数えていない残り/.test(l); })());

  // IMPL-0983:ok(登録の根拠の記入の表示。次の一手・保証の開示・D-0 の表の4出口が同じ文を出す。process-compass #339)
  {
    const okB = base();
    const nGate = '保証の開示と次の一手';
    const lines = [autonomyNoteLines(autonomyState(okB.config, okB.records)).join(' '), autonomyNoteLines(autonomyState(mk({ doubles: 7 }).config, mk({ doubles: 7 }).records)).join(' ')];
    const tbl = renderAutonomyTable(base().config, false, { q1: false }).join(' ');
    const rt = reworkText(tOf(base()));
    check(`IMPL-0983 ok: ${nGate}: 次の一手(停止なし・停止あり)・reworkText・D-0 の表が「内容は機械で確かめていない」を出し、結果を含まない旨も出す`,
      lines.every((l) => l.includes(DETECTION_UNVERIFIED) && l.includes('この出力はその結果を含まない')) &&
        rt.includes(DETECTION_UNVERIFIED) && rt.includes('この出力はその結果を含まない') && rt.includes(REWORK_UNCOUNTED) &&
        tbl.includes(DETECTION_UNVERIFIED));
  }
  // IMPL-0983:ng(記入が無い検知条件を、記入済みとして表示しない。登録の検査が拒否する入力)
  {
    const ng = base();
    delete ng.config.delegation.changeTypes[0].basis.detection.reworkRate;
    const j = judgeDelegatedMerge(ng);
    const t = autonomyState(ng.config, ng.records).types[0];
    check('IMPL-0983 ng: reworkRate が未記入なら、登録の検査が拒否し(条件2)、reworkText は reworkRate を名指さず、D-0 の表は「記入の有無は機械が確かめた」を出さない',
      !j.eligible && j.conditions.some((c) => c.id === '条件2' && !c.ok) && !reworkText(t).includes('手戻り率 reworkRate') && !renderAutonomyTable(ng.config, false, { q1: false }).join(' ').includes(DETECTION_UNVERIFIED));
  }
  {
    // 拒否される構成(rejectionRate 未記入)では、reworkRate が記入済みでも「確かめた」と出さない
    const rj = base();
    delete rj.config.delegation.changeTypes[0].basis.detection.rejectionRate;
    const j = judgeDelegatedMerge(rj);
    const t = autonomyState(rj.config, rj.records).types[0];
    check('IMPL-0983 ng: rejectionRate が未記入(登録は拒否される)なら、reworkRate が記入済みでも reworkText と D-0 の表は「確かめた」と出さない',
      !j.eligible && j.conditions.some((c) => c.id === '条件2' && !c.ok) && !reworkText(t).includes(DETECTION_UNVERIFIED) && !renderAutonomyTable(rj.config, false, { q1: false }).join(' ').includes(DETECTION_UNVERIFIED));
  }
  {
    const num = base();
    num.config.delegation.changeTypes[0].basis.detection.reworkRate = 1;
    const j = judgeDelegatedMerge(num);
    check('登録の根拠の判定の一致: reworkRate が数値なら、登録の検査が拒否し(条件2)、D-0 の表も「未計測」と出す', !j.eligible && j.conditions.some((c) => c.id === '条件2' && !c.ok) && /未計測/.test(renderAutonomyTable(num.config, false, { q1: false }).join(' ')));
  }
  check('文言: REWORK_UNCOUNTED は手段の内容を機械で確かめていないと書き、reworkText を保証の開示の行で呼ぶ', REWORK_UNCOUNTED.includes('内容は機械で確かめていない') && fs.readFileSync(path.join(ROOT, 'scripts/gate/aggregate-evidence.mjs'), 'utf8').includes('reworkText(t)') && detectionBasisText({}) === '');

  // 構成の欄の検査(範囲・記名と理由・順序・最後の値との一致・AI の名義)
  check('手戻り率の基準値の欄: 欄が無い構成・正しい欄は問題なし', reworkBaselineProblems({}).length === 0 && reworkBaselineProblems({ reworkBaseline: baseline(20) }).length === 0);
  check('手戻り率の基準値の欄: 範囲外・記名と理由の欠落・AI の名義・最後の値との不一致を問題にする',
    reworkBaselineProblems({ reworkBaseline: { percent: 120, history: [{ percent: 120, recordedAt: '2026-09-01', decidedBy: '', reason: '' }] } }).length >= 3 &&
      reworkBaselineProblems({ reworkBaseline: { percent: 20, history: [{ percent: 20, recordedAt: '2026-09-01', decidedBy: 'Claude', reason: '置く' }] } }).some((p) => /Claude/.test(p)) &&
      reworkBaselineProblems({ reworkBaseline: { percent: 30, history: [{ percent: 20, recordedAt: '2026-09-01', decidedBy: '鈴木 一郎', reason: '置く' }] } }).some((p) => /一致しない/.test(p)));

  // 読み方: トレーラは本文の末尾の段落だけ。計画表は「追加された行」の状態を、版ごとに読む
  check('手戻り率の読み方: トレーラは末尾の段落だけを読み、重複を1つに数える', specTrailersOf('fix: a\n\nSpec: F-001 / Task-1\nSpec: F-001 / Task-1\nSpec: F-001 / Task-2').join() === 'F-001/Task-1,F-001/Task-2' && specTrailersOf('fix: a\n\nSpec: F-001 / Task-9\n\n説明').length === 0);
  const addRow = (st, task = 'Task-3') => `diff --git a/specs/F-001/plan.md b/specs/F-001/plan.md\n--- a/specs/F-001/plan.md\n+++ b/specs/F-001/plan.md\n@@ -3 +3 @@\n+| ${task} | 内容 | 1 | \`src/**\` | — | 可 | ${st} |\n`;
  check('手戻り率の読み方: 計画表の追加された行の状態が「やり直し」のタスクだけを取り出す(着手・完了・削除は取り出さない)',
    planReworkTasks(addRow('やり直し')).join() === 'F-001/Task-3' && planReworkTasks(addRow('完了')).length === 0 &&
      planReworkTasks(addRow('やり直し').replace('+| Task-3', '-| Task-3')).length === 0 && planReworkTasks(addRow('やり直し').replace(/specs\/F-001\/plan\.md/g, 'docs/other.md')).length === 0);
}

// 手戻り率の記録の読み方(実際の git)。トレーラの取り込み2回、計画表の版(やり直し → 完了 → 行の削除)、末尾の段落でないトレーラ
{
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rework-git-'));
  const g = (args, date = null) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: `${date}T12:00:00`, GIT_COMMITTER_DATE: `${date}T12:00:00` } : {}) },
    });
  try {
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 't']);
    g(['config', 'commit.gpgsign', 'false']);
    const commit = (date, file, text, ...msgs) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
      g(['add', '-A']);
      g(['commit', '-q', ...msgs.flatMap((m) => ['-m', m])], date);
    };
    const plan = (row) => `| ID | 内容 | 状態 |\n| --- | --- | --- |\n${row}`;
    commit('2026-08-05', 'src/i18n/ja.json', '1', 'fix: a (#1)', 'Spec: F-001 / Task-1');
    commit('2026-08-10', 'src/i18n/ja.json', '2', 'fix: b (#2)', 'Spec: F-001 / Task-2');
    commit('2026-08-12', 'specs/F-001/plan.md', plan('| Task-2 | b | やり直し |\n'), 'docs: 計画');
    commit('2026-08-20', 'src/i18n/ja.json', '3', 'fix: a2 (#3)', 'Spec: F-001 / Task-1');
    commit('2026-08-25', 'specs/F-001/plan.md', plan('| Task-2 | b | 完了 |\n'), 'docs: 計画を完了へ');
    commit('2026-08-28', 'specs/F-001/plan.md', plan(''), 'docs: 計画から行を消す');
    commit('2026-09-02', 'src/i18n/ja.json', '4', 'fix: c (#4)', 'Spec: F-001 / Task-9', '説明の段落(トレーラは末尾の段落でない)');
    const rr = readReworkRecords({ root: dir, until: '2026-09-30' });
    const cnt = (t) => rr.trailers.filter((x) => x.tasks.includes(t)).length;
    // IMPL-0517:ok(適合の入力: 実際の git の第1親の履歴から、トレーラの取り込みと計画表の各版の「やり直し」を読む)
    check('手戻り率の記録(実 git): トレーラの取り込みを数え、末尾の段落でないトレーラは読まない', rr.available && cnt('F-001/Task-1') === 2 && cnt('F-001/Task-2') === 1 && cnt('F-001/Task-9') === 0, JSON.stringify(rr));
    check('手戻り率の記録(実 git): 計画表の「やり直し」だった版を読み、のちに完了へ進んでも、行を消した後でも残る', rr.plan.length === 1 && rr.plan[0].task === 'F-001/Task-2' && rr.plan[0].date === '2026-08-12', JSON.stringify(rr.plan));
    const early = readReworkRecords({ root: dir, until: '2026-08-15' });
    check('手戻り率の記録(実 git): --until で判定の日までに限る', early.trailers.length === 2 && early.plan.length === 1, JSON.stringify(early));
    // 算出まで通す(母数 2 件は最小標本数に満たないが、内訳は数える)
    const i = base();
    i.config.reworkBaseline = { percent: 20, history: [{ percent: 20, recordedAt: '2026-09-01', decidedBy: '鈴木 一郎', reason: '置く' }] };
    i.records.rework = rr;
    const t = autonomyState(i.config, i.records).types[0];
    check('手戻り率(実 git): 窓の中の2タスクのうち、トレーラの2回(Task-1)と計画表(Task-2)の2件を、内訳つきで数える', t.rework.n === 2 && t.rework.numerator === 2 && t.rework.trailer === 1 && t.rework.plan === 1 && t.rework.state === '判定不能', JSON.stringify(t.rework));
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'rework-shallow-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow], { stdio: 'ignore' });
      const sh = readReworkRecords({ root: shallow });
      check('手戻り率の記録(実 git): 浅い取得(shallow)は読めないものとし、理由を出す', !sh.available && /浅い取得/.test(sh.reason));
    } finally {
      fs.rmSync(shallow, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 履歴の読み方(実際の git。突合 X-15)
{
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-git-'));
  const g = (args, date = null) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: `${date}T12:00:00`, GIT_COMMITTER_DATE: `${date}T12:00:00` } : {}) },
    });
  try {
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 't']);
    g(['config', 'commit.gpgsign', 'false']);
    const commit = (date, file, text, msg) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
      g(['add', '-A']);
      g(['commit', '-q', '-m', msg], date);
    };
    commit('2026-07-01', 'src/i18n/ja.json', '1', 'fix: 文言 (#10)');
    commit('2026-08-01', 'docs/handover.md', 'v1', 'docs: 引き継ぎ');
    commit('2026-09-01', 'src/i18n/ja.json', '2', 'fix: 文言 (#11)');
    commit('2026-10-01', 'docs/handover.md', 'v2', 'docs: 引き継ぎ');
    const all = readHistory({ root: dir });
    check('履歴: 実際の git から変更の日付・PR 番号((#N))・ファイルを読む', all.available && all.changes.length === 4 && all.changes.some((c) => c.pr === '11' && c.date === '2026-09-01' && c.files.join() === 'src/i18n/ja.json'));
    const ranged = readHistory({ root: dir, since: '2026-08-01', until: '2026-09-15' });
    check('履歴: --since と --until で期間を絞る', ranged.changes.map((c) => c.date).sort().join() === '2026-08-01,2026-09-01', ranged.changes.map((c) => c.date).join());
    const hv = readHandoverVersions({ root: dir, until: '2026-09-15' });
    check('履歴: 運用引き継ぎ文書の版を古い順に、判定の日までに限って読む', hv.available && hv.list.length === 1 && hv.list[0].text === 'v1' && hv.list[0].date === '2026-08-01');
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-shallow-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow], { stdio: 'ignore' });
      const sh = readHistory({ root: shallow });
      const shv = readHandoverVersions({ root: shallow });
      check('履歴: 浅い取得(shallow)は読めないものとし、理由を出す', !sh.available && /浅い取得/.test(sh.reason) && !shv.available && /浅い取得/.test(shv.reason));
    } finally {
      fs.rmSync(shallow, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 記録の読み方(欠陥の台帳と G-6 の判定記録)
{
  const ledger = [
    '| ID | 現象 | 重大度(Sev1 / Sev2 / Sev3) | 優先度 | 状態(未解決 / 解決済み) | コア機能(はい / いいえ) | 回避策(文書の所在) | 発生日 | AI 起因(あり / なし / 特定できない) | 原因の変更 | 登録した変更種別 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| BUG-1 | 停止 | Sev1 | 高 | 解決済み | はい | — | 2026-10-05 | あり | PR #50 | 表示文言 |',
    '| BUG-2 | 遅延 | Sev2 | 中 | 未解決 | いいえ | docs/x.md | 2026-10-06 | | | なし |',
  ].join('\n');
  const rows = parseDefectRows(ledger);
  check('欠陥の台帳: AI 起因・発生日・変更種別の列を読む', rows[0].aiCause === 'あり' && rows[0].date === '2026-10-05' && rows[0].changeTypes.join() === '表示文言');
  check('欠陥の台帳: 空欄の AI 起因は空欄として読み、「なし」の変更種別は関わる種別なしと読む', rows[1].aiCause === '' && rows[1].changeTypes.length === 0);
  const old = parseDefectRows('| ID | 現象 | 重大度 | 優先度 | 状態 |\n| --- | --- | --- | --- | --- |\n| BUG-3 | 停止 | Sev1 | 高 | 未解決 |');
  check('欠陥の台帳: 列の無い旧い台帳は、AI 起因を空欄・すべての種別として読む', old[0].aiCause === '' && old[0].changeTypes === null);
  const gate = (reason) =>
    ['| 項目 | 値 |', '| --- | --- |', '| ゲート | G-6 独立レビュー |', '| 対象 | PR #45 |', '| 判定日時 | 2026-08-07 10:00 |', '| 結果 | 差し戻し |', '', '## 差し戻しの理由', '', reason].join('\n');
  check('判定記録: 判定基準の番号を引いた差し戻しを数える', parseRejection(gate('基準3を満たしていません。境界の値のテストが無い。')).cited === true);
  check('判定記録: 番号を引かない差し戻しは数えない', parseRejection(gate('全体的に見直してください。')).cited === false);
  check('判定記録: 様式の例の文は番号の引用に数えない', parseRejection(gate('> 項目2を満たしていません。受入基準3に対応するテストが見つかりません。')).cited === false);
  check('判定記録: 通過の記録は差し戻しに数えない', parseRejection(gate('').replace('差し戻し |', '通過 |')) === null);
}

// G-6 の差し戻しの判定記録の4つの置き場(様式: docs/gates/・records/gates/、写し: records/reviews/・docs/records/reviews/)
{
  const tmpRoot = fs.mkdtempSync(path.join(ROOT, 'evidence/.rejection-test-'));
  try {
    const gateForm = (target, reason) =>
      ['| 項目 | 値 |', '| --- | --- |', '| ゲート | G-6 独立レビュー |', `| 対象 | ${target} |`, '| 判定日時 | 2026-08-07 10:00 |', '| 結果 | 差し戻し |', '', '## 差し戻しの理由', '', reason].join('\n');
    fs.mkdirSync(path.join(tmpRoot, 'docs/gates'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'docs/records/reviews'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'docs/gates/g6-PR-45-2026-08-07.md'), gateForm('PR #45', '基準3を満たしていません。'));
    fs.writeFileSync(path.join(tmpRoot, 'docs/records/reviews/pr-50.json'), JSON.stringify(reviewCopy('G-6: 差し戻し / 基準 1', 50).copy));
    fs.writeFileSync(path.join(tmpRoot, 'docs/records/reviews/pr-51.json'), JSON.stringify(reviewCopy('G-6: 差し戻し / 基準 1', 51).copy));
    const branch = {
      available: true,
      // 基底ブランチと同じ名前の様式は1件に数える。記録用ブランチだけにある様式も読む
      gates: [
        { file: 'records/gates/g6-PR-45-2026-08-07.md', text: gateForm('PR #45', '基準3を満たしていません。') },
        { file: 'records/gates/g6-PR-46-2026-08-08.md', text: gateForm('PR #46', '基準1を満たしていません。') },
      ],
      // 基底ブランチと同じ PR 番号の写しは1件に数える(記録用ブランチを優先する)
      reviews: new Map([
        [51, reviewCopy('G-6: 差し戻し / 基準 1', 51).copy],
        [52, reviewCopy('G-6: 差し戻し / 基準 4', 52).copy],
      ]),
    };
    const rr = readRejectionRecords({ root: tmpRoot, branch });
    const keys = rr.rejections.map((r) => `${r.source}:${r.target}`).sort();
    check(
      '差し戻しの判定記録: 様式と写しを4つの置き場から読み、同じファイル名・同じ PR 番号を1件に数える',
      keys.join() === ['form:PR #45', 'form:PR #46', 'review:PR #50', 'review:PR #51', 'review:PR #52'].sort().join() && rr.notes.length === 0,
      keys.join(),
    );
    const off = readRejectionRecords({ root: tmpRoot, branch: { available: false, reason: '手元に無い' } });
    check(
      '差し戻しの判定記録: 記録用ブランチを読めなければ、基底ブランチだけを数え、その旨を注記に出す',
      off.rejections.length === 3 && off.notes.length === 1 && /記録用ブランチを読めない/.test(off.notes[0]),
      off.rejections.map((r) => r.target).join(),
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// 委任の判定が数える G-6 の差し戻しの記録の帰属(効力を持つ記録。process-compass #379 / ADR-0109 決定4)。
// 帰属をホスティングの記録で確かめた記録だけを差し戻し率に数える。偽の差し戻し(写しにだけあるレビュー・書き手の食い違い・
// 帰属の無い様式)を数えないことは差し戻し率を下げ、引き下げの側へ倒れる
{
  const tmpRoot = fs.mkdtempSync(path.join(ROOT, 'evidence/.rejection-attr-test-'));
  try {
    const cfg = {
      people: [
        { id: 'p1', name: 'レビュア 甲', accounts: [{ login: 'reviewer-a', id: 9 }] },
        { id: 'p2', name: '開発 乙', accounts: [{ login: 'dev-b', id: 11 }] },
      ],
      roles: [{ id: 'independent-reviewer', gatesOwned: ['g6'] }],
      seats: [{ role: 'independent-reviewer', accountable: 'p1' }],
    };
    const form = (target, judge) => ['| 項目 | 値 |', '| --- | --- |', '| ゲート | G-6 独立レビュー |', `| 対象 | ${target} |`, `| 判定者 | ${judge} |`, '| 判定日時 | 2026-08-07 10:00 |', '| 結果 | 差し戻し |', '', '## 差し戻しの理由', '', '基準3を満たしていません。'].join('\n');
    const hostReview = (over = {}) => ({ id: 7, user: { login: 'reviewer-a', id: 9, type: 'User' }, body: 'G-6: 差し戻し / 基準 1', state: 'CHANGES_REQUESTED', commit_id: 'a'.repeat(40), submitted_at: '2026-08-07T01:00:00Z', ...over });
    const pulls = {
      60: { author: { login: 'dev-b', id: 11 }, reviews: [hostReview()] },
      61: { author: { login: 'dev-b', id: 11 }, reviews: [hostReview({ user: { login: 'reviewer-a', id: 4242, type: 'User' } })] },
      63: { author: { login: 'reviewer-a', id: 9 }, reviews: [hostReview()] },
      64: { author: { login: 'dev-b', id: 11 }, reviews: [hostReview({ body: 'G-6: 通過' })] },
    };
    const hosting = {
      pullOf: (n) => (pulls[n] ? { number: n, ...pulls[n] } : null),
      commitOf: (sha) => (sha === 's'.repeat(40) ? { number: null, verified: true, authorLogin: 'reviewer-a', authorId: 9, committerLogin: 'reviewer-a', committerId: 9 } : sha === 'u'.repeat(40) ? { number: null, verified: false, authorLogin: 'reviewer-a', authorId: 9, committerLogin: 'reviewer-a', committerId: 9 } : null),
      prOfCommit: () => null,
    };
    const branch = {
      available: true,
      gates: [
        { file: 'records/gates/g6-PR-70-2026-08-07.md', text: form('PR #70', 'レビュア 甲'), added: { hash: 's'.repeat(40) } },
        { file: 'records/gates/g6-PR-71-2026-08-07.md', text: form('PR #71', 'レビュア 甲'), added: { hash: 'u'.repeat(40) } },
      ],
      reviews: new Map([60, 61, 62, 63, 64].map((n) => [n, reviewCopy('G-6: 差し戻し / 基準 1', n).copy])),
    };
    const rr = readRejectionRecords({ root: tmpRoot, branch, config: cfg, hosting });
    const counted = rr.rejections.map((r) => r.target).sort();
    // IMPL-0440:ok(違反と適合の対。標準の実装マーク。process-compass #314)
    check('差し戻しの帰属: ホスティングのレビュー(識別子・書き手・対象のコミット・宣言行が写しと一致し、書き手が G-6 の席の責任者で PR の作成者と異なる)と、署名を検証した様式を数える', counted.join() === ['PR #60', 'PR #70'].sort().join(), counted.join());
    // IMPL-0440:ng(違反と適合の対。標準の実装マーク。process-compass #314)
    const why = Object.fromEntries(rr.unattributed.map((u) => [u.target, u.why]));
    check('差し戻しの帰属: 書き手の数値の識別子がホスティングと食い違う写し(偽の差し戻し)は数えない', /数値の識別子/.test(why['PR #61'] ?? ''), JSON.stringify(why));
    check('差し戻しの帰属: ホスティングで PR を引けない写し(存在しない PR 番号を含む)は数えない', /引けない/.test(why['PR #62'] ?? ''), JSON.stringify(why));
    check('差し戻しの帰属: PR の作成者自身のレビューは数えない', /作成者/.test(why['PR #63'] ?? ''), JSON.stringify(why));
    check('差し戻しの帰属: ホスティングの本文の宣言行が差し戻しでないレビューは数えない', /宣言行/.test(why['PR #64'] ?? ''), JSON.stringify(why));
    check('差し戻しの帰属: 署名をホスティングが検証していない様式は数えない', Boolean(why['PR #71']), JSON.stringify(why));
    check('差し戻しの帰属: 数えなかった件数を注記に出す(引き下げの側へ倒れる旨)', rr.notes.some((x) => /5 件/.test(x) && /引き下げの側へ倒れる/.test(x)), JSON.stringify(rr.notes));
    const offline = readRejectionRecords({ root: tmpRoot, branch, config: cfg, hosting: null });
    check('差し戻しの帰属: ホスティングを読めない実行では、どの記録も数えない(停止の側へ倒れる)', offline.rejections.length === 0 && offline.unattributed.length === 7);

    // 書き手を G-6 の席の責任者に限らない(承認の数え方と対称。突合 M-3)。名義の共有は帰属の確認を要する(ADR-0107。突合 M-2)
    const cfg2 = {
      people: [...cfg.people, { id: 'p3', name: 'レビュア 丙', accounts: [{ login: 'reviewer-c', id: 13 }] }, { id: 'p4', name: '確認 丁', accounts: [{ login: 'confirm-d', id: 14 }] }],
      roles: cfg.roles,
      seats: [
        { role: 'independent-reviewer', accountable: 'p1' },
        { role: 'dev-verifier', name: '開発者', accountable: 'p3', performer: { model: 'm-1', instructions: 'v1', permissions: 'p' }, performerAccount: { kind: 'shared', person: 'p3' } },
      ],
    };
    const byC = (over = {}) => hostReview({ user: { login: 'reviewer-c', id: 13, type: 'User' }, author_association: 'COLLABORATOR', ...over });
    const pulls2 = {
      80: { author: { login: 'dev-b', id: 11 }, reviews: [hostReview({ author_association: 'COLLABORATOR' })] },
      81: { author: { login: 'dev-b', id: 11 }, reviews: [byC()] },
      82: { author: { login: 'dev-b', id: 11 }, reviews: [byC(), { id: 99, user: { login: 'confirm-d', id: 14, type: 'User' }, state: 'APPROVED', author_association: 'COLLABORATOR', commit_id: 'a'.repeat(40), body: '挙動要約: 確認した' }] },
      83: { author: { login: 'dev-b', id: 11 }, reviews: [hostReview({ author_association: 'NONE' })] },
    };
    const hosting2 = { pullOf: (n) => (pulls2[n] ? { number: n, ...pulls2[n] } : null), commitOf: () => null, prOfCommit: () => null };
    const copyBy = (n, user) => {
      const c = reviewCopy('G-6: 差し戻し / 基準 1', n).copy;
      c.reviews[0].user = user;
      return c;
    };
    const branch2 = {
      available: true,
      gates: [],
      reviews: new Map([
        [80, reviewCopy('G-6: 差し戻し / 基準 1', 80).copy],
        [81, copyBy(81, { login: 'reviewer-c', id: 13 })],
        [82, copyBy(82, { login: 'reviewer-c', id: 13 })],
        [83, reviewCopy('G-6: 差し戻し / 基準 1', 83).copy],
      ]),
    };
    const rr2 = readRejectionRecords({ root: tmpRoot, branch: branch2, config: cfg2, hosting: hosting2 });
    const why2 = Object.fromEntries(rr2.unattributed.map((u) => [u.target, u.why]));
    const counted2 = rr2.rejections.map((r) => r.target).sort();
    check('差し戻しの帰属: G-6 の席の責任者でない名簿の人の差し戻しも数える(承認の数え方と対称)', counted2.includes('PR #80') || counted2.includes('PR #82'), JSON.stringify({ counted2, why2 }));
    check('差し戻しの帰属: 書き手が AI の担い手と名義を共有し、帰属の確認(名義を共有していない人の承認)が無ければ数えない', /名義を共有/.test(why2['PR #81'] ?? ''), JSON.stringify(why2));
    check('差し戻しの帰属: 名義を共有する書き手でも、名義を共有していない人の承認があれば数える', counted2.includes('PR #82'), JSON.stringify({ counted2, why2 }));
    check('差し戻しの帰属: 書き込みの権限を持たない関係の書き手の差し戻しは数えない', /関係/.test(why2['PR #83'] ?? ''), JSON.stringify(why2));
    check('差し戻しの帰属: 席の責任者の差し戻しは数える', counted2.includes('PR #80'), JSON.stringify({ counted2, why2 }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// 安全関連部の委任の停止(IMPL-0919。ADR-0220)。D-0 表10 の F.2 の Q1 を判定のたびに読み、「いいえ」と読めないときは止める。
// 委任の判定(autonomyState・judgeDelegatedMerge)・登録の拒否(capRefusal)・D-0 の表の生成(renderAutonomyTable・l3ScopeIds)が同じ関数(safetyPartStop)を通ることを確かめる
{
  const d0 = (f2) => `# D-0\n\n## 16. 安全重要度の判定の記録\n\n| 項目 | 内容 |\n| --- | --- |\n| 附属書F F.2 の回答 | ${f2} |\n`;
  const withQ1 = (q1) => ({ ...base(), records: { ...base().records, f2q1: q1 } });
  const stoppedBy = (input) => {
    const st = autonomyState(input.config, input.records);
    return st.types.length > 0 && st.types.every((t) => t.stops.some((s) => s.kind === 'safety-part'));
  };
  const rowLevels = (config, q1) => renderAutonomyTable(config, false, { q1 }).filter((l) => /^\| 登録した変更種別 /.test(l)).map((l) => l.split('|')[2].trim());

  // IMPL-0919:ng
  // CL0 × Q1「はい」: 登録の拒否・D-0 の表が L1・委任の判定が不可、の3つが同時に成り立つ
  {
    const yes = withQ1(true);
    check('安全関連部: Q1「はい」(CL0)では登録を拒む', capRefusal({ configured: true, answers: { 'q-criticality': 'cl0' } }, { q1: true }) !== null);
    check('安全関連部: Q1「はい」(CL0)では D-0 の表が L3 と書かず L1 と出す', rowLevels(yes.config, true).length > 0 && rowLevels(yes.config, true).every((l) => /^L1/.test(l)));
    check('安全関連部: Q1「はい」(CL0)では登録済みの種別が止まり、委任の判定が不可になる', stoppedBy(yes) && !judgeDelegatedMerge(yes).eligible);
    check('安全関連部: Q1「はい」では L3 の範囲(l3ScopeIds)が空になる', l3ScopeIds(yes.config, { q1: true }).length === 0);
  }
  // IMPL-0919:ng
  // 読めない値は「いいえ」と読まず、止める側へ倒す
  for (const [label, text, q1] of [
    ['未記入', d0(''), null],
    ['様式のまま', d0('<はい / いいえ で始める。Q1(人身への危害が生じうる制御があるか)の答えと理由>'), null],
    ['「未定」', d0('未定'), null],
    ['D-0 に節が無い', '# D-0\n', null],
    ['D-0 が無い', null, null],
  ]) {
    const read = readF2Q1Text(text);
    check(`安全関連部: Q1 が「${label}」のとき null と読む`, read === q1, String(read));
    const input = withQ1(read);
    check(`安全関連部: Q1 が「${label}」のとき委任が止まる(判定・表・登録の拒否)`, stoppedBy(input) && !judgeDelegatedMerge(input).eligible && rowLevels(input.config, read).every((l) => /^L1/.test(l)) && capRefusal(input.config, { q1: read }) !== null);
  }
  // 値が records に無い(readAutonomyRecords を通らない)入力も止める
  {
    const noValue = base();
    delete noValue.records.f2q1;
    check('安全関連部: 記録に Q1 の値が無い入力は止まる', stoppedBy(noValue) && !judgeDelegatedMerge(noValue).eligible);
  }
  // IMPL-0919:ng
  // いいえで登録した後に「はい」へ改めると、登録済みの種別が止まる
  {
    const before = base();
    const after = withQ1(readF2Q1Text(d0('はい。人身への危害が生じうる制御がある')));
    check('安全関連部: 「いいえ」で委任できた同じ入力が、D-0 を「はい」へ改めると止まる', judgeDelegatedMerge(before).eligible && !judgeDelegatedMerge(after).eligible && stoppedBy(after));
  }
  // IMPL-0919:ok
  // CL0 × 「いいえ」は現行のとおり委任できる。判定・表・登録が同じ結果になる
  {
    const no = withQ1(readF2Q1Text(d0('いいえ。人身への危害は生じない')));
    check('安全関連部: Q1「いいえ」(CL0)では委任できる', no.records.f2q1 === false && judgeDelegatedMerge(no).eligible && !stoppedBy(no));
    check('安全関連部: Q1「いいえ」では登録を拒まず、D-0 の表は L3 と書く', capRefusal({ configured: true, answers: { 'q-criticality': 'cl0' } }, { q1: false }) === null && rowLevels(no.config, false).some((l) => /^L3/.test(l)));
    // 表の L3 の行と l3ScopeIds が、Q1 のどの値でも一致する(同じ関数を通る)
    for (const q1 of [false, true, null]) {
      const ids = l3ScopeIds(no.config, { q1 });
      const tableL3 = renderAutonomyTable(no.config, false, { q1 }).filter((l) => /^\| 登録した変更種別 /.test(l) && /\| L3/.test(l)).length;
      check(`安全関連部: Q1=${q1} で L3 の範囲と表の L3 の行が一致する`, ids.length === tableL3);
    }
  }
  // D-0 の本文から読む(ファイルの経路)
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q1-'));
    try {
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
      check('安全関連部: D-0 のファイルが無い案件は null', readF2Q1({ root: dir }) === null);
      fs.writeFileSync(path.join(dir, 'docs/D-0-governance.md'), d0('Q1: はい'));
      check('安全関連部: D-0 のファイルの「Q1: はい」を真と読む', readF2Q1({ root: dir }) === true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// IMPL-0594(リスク区分ごとの最大レベル)。実行で確かめた範囲: L3 の導出(autonomyState)は種別の単位で、変更ごとのリスク区分を読まない。
// L3 を読む箇所は委任の判定(delegation.mjs)・D-0 の表・保証の開示・次の一手の表示で、変更ごとに効くのは委任の判定だけであり、その条件2 が R3 を求める
{
  for (const risk of ['R1', 'R2']) {
    // IMPL-0594:ng
    const input = base();
    setRisk(input, risk);
    const judged = judgeDelegatedMerge(input);
    check(`IMPL-0594: 種別が L3 でも、リスク区分が ${risk} の変更は委任で進まない(条件2)`, judged.autonomy?.level === 'L3' && !judged.eligible && judged.reasons.some((r) => r.startsWith('条件2')));
  }
  // IMPL-0594:ok
  const okInput = base();
  const okJudged = judgeDelegatedMerge(okInput);
  check('IMPL-0594: リスク区分が R3 なら、同じ種別の変更が委任で進む', okJudged.autonomy?.level === 'L3' && okJudged.eligible);
}

console.log('');
if (failed) {
  console.log(`::error::委任の経路の試験: ${failed} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`委任の経路の試験: ${cases.length} 場面と付随の確認が、期待と一致しました`);
