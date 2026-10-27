// 委任した変更のマージの経路の判定(check-delegation)を、フィクスチャで試験する。
//
//   node scripts/gate/test-check-delegation.mjs
//
// 該当する場面1つと、該当しない場面を、入力を1か所ずつ変えて確かめます。GitHub へ問い合わせません。
// あわせて、ワークフロー(delegation.yml)が PR の先頭を checkout していないこと、承認を付けていない
// ことを、定義の文字列で確かめます。実際の GitHub 上での動作は、この試験では確かめていません。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { judgeDelegatedMerge } from './delegation.mjs';
import { autonomyCap, autonomyState, autonomyNoteLines, rejectionText, stopsText, parseDefectRows, parseRejection, capRefusal, readHistory, readHandoverVersions, rejectionsFromReviewCopies, readRejectionRecords } from './autonomy.mjs';
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
      i.reviews = [{ login: 'yamada-taro', state: 'APPROVED' }];
    },
    true,
    [],
  ],
  [
    '独立レビュアの席の規則だけに該当し、開発者の席の責任者が承認の後に変更を要求した',
    (i) => {
      reviewerOnly(i);
      i.reviews = [{ login: 'yamada-taro', state: 'APPROVED' }, { login: 'yamada-taro', state: 'CHANGES_REQUESTED' }];
    },
    false,
    ['開発者の席'],
  ],
  [
    '独立レビュアの席の規則だけに該当し、開発者の席の責任者でない人が承認している',
    (i) => {
      reviewerOnly(i);
      i.reviews = [{ login: 'suzuki-ichiro', state: 'APPROVED' }];
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
  const table = renderAutonomyTable(base().config).join('\n');
  check('生成: D-0 の表に、登録した変更種別の L3 と、それ以外の L1 と、計測の所在を出す', /表示文言 \| L3/.test(table) && /\| それ以外 \| L1/.test(table) && /最小標本数 30 件/.test(table) && /準拠テンプレートの外/.test(table) && !/\| L3 \|[^\n]*未計測/.test(table));
  {
    const nr = base();
    delete nr.config.delegation.changeTypes[0].basis.detection.reworkRate;
    const t2 = renderAutonomyTable(nr.config).join('\n');
    check('生成: 手戻り率の根拠が未記入の種別は、L3 と「未計測」を同じ行に出さない(L1 と出す。突合 X-4)', t2.includes('L1(手戻り率が未計測)') && !/\| L3 \|[^\n]*未計測/.test(t2));
  }
  const s0 = autonomyState(base().config, base().records);
  check('導出: 登録した変更種別は L3、それ以外は L1', s0.types[0].level === 'L3' && s0.otherLevel === 'L1');
  check('導出: 手戻り率は降りていないと出す', /集計していない/.test(s0.rework));
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
  check('表示: 停止の無い種別でも「異常なし」と書かず、手戻り率を集計していないと出す', /停止なし/.test(lines0) && !/異常なし/.test(lines0) && !/判定不能/.test(lines0) && /集計していない/.test(lines0));
  // 保証の開示の項目3 が使う1行の表示(aggregate-evidence.mjs の rejectionText・stopsText)
  const rej1 = `${rejectionText(rs1.types[0])} / ${stopsText(rs1.types[0])}`;
  // IMPL-0288:ng(違反の入力: 判定不能の窓。開示の行に判定不能と出し、「異常なし」と書かない)
  check('開示の行: 判定不能の窓を判定不能と出し、「異常なし」と書かない', /判定不能/.test(rej1) && !/異常なし/.test(rej1), rej1);
  const rej0 = `${rejectionText(sOk.types[0])} / ${stopsText(sOk.types[0])}`;
  // IMPL-0288:ok(適合の入力: 判定可能で停止の無い種別。判定不能と出さない)
  check('開示の行: 判定可能で停止の無い種別は、判定不能と出さず停止なしと出す', !/判定不能/.test(rej0) && !/異常なし/.test(rej0) && /なし$/.test(rej0), rej0);
  // 上限の理由(突合 X-16)
  const capNoQ = autonomyCap({ configured: true, answers: {} });
  check('上限: 回答に安全重要度の無い構成は L1 とし、理由を出す', capNoQ.level === 'L1' && /q-criticality/.test(capNoQ.reason));
  check('上限: CL2 の L2 は、安全関連部の範囲を持たないため案件の全体へ掛ける旨を出す', /案件の全体/.test(autonomyCap({ configured: true, answers: { 'q-criticality': 'cl2' } }).reason ?? ''));
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

console.log('');
if (failed) {
  console.log(`::error::委任の経路の試験: ${failed} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`委任の経路の試験: ${cases.length} 場面と付随の確認が、期待と一致しました`);
