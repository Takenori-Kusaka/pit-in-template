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

// [場面, 入力を変える関数, 該当するか(G-6 を事後へ移す委任), 満たさないはずの条件, 扱い(省略時は該当=post-hoc / 該当しない=collab)]
const cases = [
  ['該当する(規則の範囲・R3・G-5 通過・トレーラあり)', () => {}, true, []],
  ['範囲外のファイルを含む', (i) => i.files.push({ path: 'src/pay.js', additions: 1, deletions: 0 }), false, ['条件2']],
  ['強制層に触れる(.github/**)', (i) => i.files.push({ path: '.github/workflows/gate-g5.yml', additions: 1, deletions: 1 }), false, ['条件2']],
  ['強制層に触れる(process.config.json)', (i) => (i.files = [{ path: 'process.config.json', additions: 1, deletions: 1 }]), false, ['条件2']],
  ['強制層に触れる(判定記録の置き場)', (i) => i.files.push({ path: 'docs/gates/g6-x.md', additions: 5, deletions: 0 }), false, ['条件2']],
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
  ['プロセス構成が未設定', (i) => (i.config.configured = false), false, ['前提']],
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
check('ワークフロー: pull_request_review で動かない(PR の側の定義で動くため)', !/^\s{2}pull_request_review:/m.test(body));
check('ワークフロー: pull_request ではなく pull_request_target で動く(定義を基底ブランチから読む)', /^\s{2}pull_request_target:/m.test(body) && !/^\s{2}pull_request:/m.test(body));

console.log('');
if (failed) {
  console.log(`::error::委任の経路の試験: ${failed} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`委任の経路の試験: ${cases.length} 場面と付随の確認が、期待と一致しました`);
