// 取り込む前に人が読む範囲(事業ステージ S2。標準 第8章 軸B・第4章 G-6)の外の変更を、承認を待たずに取り込み、出荷判定までに読む形を試験する。
//
//   node scripts/gate/test-deferred-review.mjs
//
// 確かめること:
//   - この形を使う構成の判定(S2・CL0 と記入・標準の品質・承認者 1 名・委任を適用しない・必須の承認数 0)。どれかを欠けば使わない(両方向)
//   - 取り込みが本番を直接起動する workflow の構文の検出
//   - 範囲の各行の当たりと外れ(R1・コア機能・判断記録の要否の規則・統制の設定・仕様・依存・テストの削除・依存するタスク)
//   - PR の検査(gate-g5-base): 範囲の中は承認が無ければ落ち、範囲の外は承認を求めず、R2 の確定者の記名も取り込む前には求めない
//   - 出荷判定の証跡の集約: 範囲の外の変更の識別、出荷の前の確認が済んでいない変更、R2 の確定者の記名の欠落、投影(模擬の gh。Windows では省く)
// GitHub へ問い合わせません。リポジトリの状態を変えません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePr, approverFindings, deployOnPushFindings, preReadRangeOf, unmergedDependencies, doneTaskKeysOf } from './check-pr.mjs';
import { approvalByPreRead, approvalByPathsOrRange, approvalByCorePaths, enforcedApprovalFindings } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';
import { copyTemplateTree } from './template-copy.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
};
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

// 名簿(架空の人名)
const UID = { yamada: 2001, suzuki: 2002, sato: 2003 };
const people = [
  { id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: UID.yamada }] },
  { id: 'p2', name: '鈴木 一郎', accounts: [{ login: 'suzuki', id: UID.suzuki }] },
  { id: 'p3', name: '佐藤 花子', accounts: [{ login: 'sato', id: UID.sato }] },
];
const seats = [
  { role: 'developer', accountable: '山田 太郎' },
  { role: 'ai-maintainer', accountable: '鈴木 一郎' },
];
const HEAD = 'a'.repeat(40);
const review = (login, body) => ({ id: Math.floor(Math.random() * 1e9), state: 'APPROVED', body, submitted_at: '2026-11-05T10:00:00Z', commit_id: HEAD, author_association: 'MEMBER', author: { login, id: UID[login], is_bot: false } });
const s2Cfg = (over = {}) => ({
  configured: true,
  people,
  seats,
  changeLog: [],
  answers: { 'q-biz-phase': 'growth', 'q-criticality': 'cl0', 'q-quality': 'quality-standard' },
  gates: { g6: { state: 'required', params: { scope: 'all' } } },
  review: { requiredApprovals: 0, reviewerCount: 1 },
  delegation: { protectedPaths: ['src/core/**'] },
  decisionRules: { rules: [{ id: 'api', paths: ['src/api/**'], why: '公開インタフェース' }] },
  adapters: { stack: 'node' },
  task: { maxChangedLines: 400, maxChangedFiles: 15 },
  ...over,
});

// ---------------------------------------------------------------- この形を使う構成の判定(両方向)
{
  check('使う構成: S2・CL0・標準の品質・承認者 1 名・必須の承認数 0 は真', approvalByPreRead(s2Cfg()) === true);
  check('使わない: 必須の承認数が 1 の構成', approvalByPreRead(s2Cfg({ review: { requiredApprovals: 1, reviewerCount: 1 } })) === false);
  check('使わない: 範囲を限る S1 の構成(core-only)', approvalByPreRead(s2Cfg({ gates: { g6: { state: 'required', params: { scope: 'core-only' } } } })) === false);
  check('使わない: 事業ステージ S0・S1(poc・mvp)と、事業ステージが未記入の構成', ['poc', 'mvp', undefined].every((p) => approvalByPreRead(s2Cfg({ answers: { 'q-biz-phase': p, 'q-criticality': 'cl0', 'q-quality': 'quality-standard' } })) === false));
  check('使わない: 安全重要度 CL1 以上', ['cl1', 'cl2', 'cl3'].every((c) => approvalByPreRead(s2Cfg({ answers: { 'q-biz-phase': 'growth', 'q-criticality': c, 'q-quality': 'quality-standard' } })) === false));
  check('使わない: 安全重要度が未記入(CL0 とみなさない)', approvalByPreRead(s2Cfg({ answers: { 'q-biz-phase': 'growth', 'q-quality': 'quality-standard' } })) === false);
  check('使わない: 品質「高」・規制業・品質が未記入', ['quality-high', 'quality-regulated', undefined].every((q) => approvalByPreRead(s2Cfg({ answers: { 'q-biz-phase': 'growth', 'q-criticality': 'cl0', 'q-quality': q } })) === false));
  check('使わない: 承認者 2 名', approvalByPreRead(s2Cfg({ review: { requiredApprovals: 0, reviewerCount: 2 } })) === false);
  check('使わない: 委任の規則を登録している構成(委任を使える上限だけでは使わない構成にしない)', approvalByPreRead(s2Cfg({ delegation: { allowed: true, rules: [{ id: 'r1' }], protectedPaths: ['src/core/**'] } })) === false && approvalByPreRead(s2Cfg({ delegation: { allowed: true, rules: [], protectedPaths: ['src/core/**'] } })) === true);
  check('使わない: G-6 が未達・簡略の構成', ['unmet', 'simplified', 'omitted'].every((s) => approvalByPreRead(s2Cfg({ gates: { g6: { state: s, params: { scope: 'all' } } } })) === false));
  check('S1 の形(コア機能のパス)と重ならない: S1 の構成は approvalByCorePaths だけが真', approvalByCorePaths(s2Cfg()) === false && approvalByPathsOrRange(s2Cfg()) === true);
  const f = enforcedApprovalFindings(s2Cfg(), { name: 'team-core', rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 0 } }] });
  check('ブランチ保護の必須の承認数 0 は、この形では下回りの問題にしない', f.required === 0 && f.problems.length === 0, JSON.stringify(f));
}

// ---------------------------------------------------------------- 取り込みが本番を直接起動する構成の検出(構文)
{
  const wf = (text) => deployOnPushFindings([{ path: '.github/workflows/w.yml', text }]);
  const BLOCK = 'name: d\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps: []\n';
  // IMPL-1071:ng(違反の入力: push で動き、配備の環境を宣言するジョブを持つ workflow は、取り込みが本番を直接起動する構成として検出し、範囲の外にしない)
  check('検出する: push で動き、environment を持つジョブがある(ブロックの書き方)', wf(BLOCK).length === 1);
  check('検出する: on: push(1 行の書き方)', wf('on: push\njobs:\n  d:\n    environment: staging\n').length === 1);
  check('検出する: on: [push, pull_request](配列の書き方)', wf('on: [push, pull_request]\njobs:\n  d:\n    environment:\n      name: prod\n').length === 1);
  check('検出する: on: の下の - push(リストの書き方)', wf('on:\n  - pull_request\n  - push\njobs:\n  d:\n    environment: prod\n').length === 1);
  // IMPL-1071:ok(適合の入力: pull_request だけで動く workflow は、配備の環境を宣言していても、取り込みが本番を直接起動する構成に数えない)
  check('検出しない: pull_request だけで動く(environment があっても)', wf(BLOCK.replace('push:\n    branches: [main]', 'pull_request:')).length === 0);
  check('検出しない: push で動くが environment を持つジョブが無い', wf(BLOCK.replace('    environment: production\n', '')).length === 0);
  check('検出しない: 手動の起動だけ', wf(BLOCK.replace('push:\n    branches: [main]', 'workflow_dispatch:')).length === 0);
  check('起動の契機を読めない workflow は、起動する側へ倒す(検出する)', wf('jobs:\n  d:\n    environment: prod\n').length === 1);
  check('workflow が無ければ検出しない', deployOnPushFindings([]).length === 0);
  // 見逃していた形(起動する側へ倒す)
  const JOB = 'jobs:\n  d:\n    runs-on: ubuntu-latest\n    environment: production\n    steps: []\n';
  check('検出する: workflow_run(CI の完了で配備する形)', wf(`on:\n  workflow_run:\n    workflows: [ci]\n    types: [completed]\n${JOB}`).length === 1);
  check('検出する: release', wf(`on:\n  release:\n    types: [published]\n${JOB}`).length === 1);
  check('検出する: schedule', wf(`on:\n  schedule:\n    - cron: '0 0 * * *'\n${JOB}`).length === 1);
  check('検出する: 1 行の書き方の workflow_run・release・schedule', ['workflow_run', 'release', 'schedule'].every((e) => wf(`on: ${e}\n${JOB}`).length === 1));
  check('検出する: 波括弧の書き方({ push: { branches: [main] } })と、リストの書き方の release', wf(`on: { push: { branches: [main] } }\n${JOB}`).length === 1 && wf(`on:\n- release\n${JOB}`).length === 1);
  check('検出する: 手動の起動と push の組(手動だけではない)', wf(`on:\n  workflow_dispatch:\n  push:\n    branches: [main]\n${JOB}`).length === 1);
  check('検出する: 手動の起動と pull_request の組(どちらか一方だけではない。起動する側へ倒す)', wf(`on: [workflow_dispatch, pull_request]\n${JOB}`).length === 1);
  check('検出する: on: の後の注釈と引用符つきの on', wf(`"on": # 契機\n  push:\n${JOB}`).length === 1);
  check('検出しない: pull_request_target だけ・pull_request の細かい指定・pull_request_review', ['on: pull_request_target', 'on:\n  pull_request:\n    branches: [main]\n    types: [opened]', 'on: [pull_request, pull_request_review]'].every((o) => wf(`${o}\n${JOB}`).length === 0));
  check('検出しない: 手動の起動だけ(波括弧の書き方・ブロックの書き方)', wf(`on: { workflow_dispatch: {} }\n${JOB}`).length === 0 && wf(`on:\n  workflow_dispatch:\n    inputs:\n      x:\n        required: false\n${JOB}`).length === 0);
  // 再利用の workflow を呼ぶジョブ
  const caller = (uses, on = 'on:\n  push:\n    branches: [main]') => `${on}\njobs:\n  call:\n    uses: ${uses}\n`;
  const calleeOk = { path: '.github/workflows/reuse.yml', text: 'on: workflow_call\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n' };
  const calleeEnv = { path: '.github/workflows/reuse.yml', text: `on: workflow_call\n${JOB}` };
  const calleeNested = { path: '.github/workflows/reuse.yml', text: 'on: workflow_call\njobs:\n  x:\n    uses: ./.github/workflows/other.yml\n' };
  const callerW = (uses, on) => ({ path: '.github/workflows/main.yml', text: caller(uses, on) });
  check('検出する: push の workflow が、読めない(リポジトリの外の)再利用の workflow を呼ぶ', deployOnPushFindings([callerW('org/shared/.github/workflows/deploy.yml@v1')]).length === 1);
  check('検出する: push の workflow が、リポジトリの中に無い再利用の workflow を呼ぶ(読めない)', deployOnPushFindings([callerW('./.github/workflows/missing.yml')]).length === 1);
  check('検出する: 呼ばれる側が配備の環境を持つ(呼ぶ側も、呼ばれる側も)', deployOnPushFindings([callerW('./.github/workflows/reuse.yml'), calleeEnv]).sort().join() === '.github/workflows/main.yml,.github/workflows/reuse.yml');
  check('検出する: 呼ばれる側が、さらに別の workflow を呼ぶ(確かめきれない)', deployOnPushFindings([callerW('./.github/workflows/reuse.yml'), calleeNested]).includes('.github/workflows/main.yml'));
  check('検出する: workflow_run で動く workflow が、読めない再利用の workflow を呼ぶ', deployOnPushFindings([callerW('org/shared/.github/workflows/deploy.yml@v1', 'on:\n  workflow_run:\n    workflows: [ci]')]).length === 1);
  check('検出しない: 呼ばれる側がリポジトリの中にあり、読め、配備の環境が無い', deployOnPushFindings([callerW('./.github/workflows/reuse.yml'), calleeOk]).length === 0);
  check('検出しない: pull_request だけで動く workflow が再利用の workflow を呼ぶ', deployOnPushFindings([callerW('org/shared/.github/workflows/deploy.yml@v1', 'on: pull_request')]).length === 0);
  check('検出しない: ステップの uses(actions/checkout など)は再利用の呼び出しに数えない', wf('on: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: x\n        uses: actions/setup-node@v4\n').length === 0);
  // テンプレート自身の委任のマージのジョブの環境(delegated-merge)は、本番への反映ではないため数えない。それ以外の環境・読めない書き方は数える
  const mergeEnv = (env) => `on:\n  workflow_run:\n    workflows: [gate-g5]\njobs:\n  merge:\n    runs-on: ubuntu-latest\n    ${env}\n    steps: []\n`;
  const delegationWf = (text) => deployOnPushFindings([{ path: '.github/workflows/delegation.yml', text }]);
  check('検出しない: 委任のマージのワークフロー(delegation.yml)が workflow_run で動き、環境が delegated-merge だけ(マージのトークンを置く環境)', delegationWf(mergeEnv('environment: delegated-merge')).length === 0 && delegationWf(mergeEnv("environment: 'delegated-merge' # マージ")).length === 0);
  check('検出する: 委任のマージのワークフロー以外が、同じ名の環境 delegated-merge を使う(名だけでは外さない)', wf(mergeEnv('environment: delegated-merge')).length === 1);
  check('検出する: 委任のマージのワークフローでも、環境がほかの名なら数える', delegationWf(mergeEnv('environment: production')).length === 1);
  check('検出する: 環境が delegated-merge 以外・式・オブジェクトの書き方(読めない値は配備の環境として数える)', ['environment: production', 'environment: ${{ inputs.env }}', 'environment:\n      name: delegated-merge'].every((e) => wf(mergeEnv(e)).length === 1));
  // PR を閉じた時に動く配備は、PR の検査ではない(起動する側)。動く場面の指定を読めて、閉じた時を含まないときだけ PR の検査
  const closedWf = (on) => wf(`${on}\n${JOB}`).length === 1;
  check('検出する: pull_request の types に closed(ブロックの書き方)', closedWf('on:\n  pull_request:\n    types: [closed]'));
  check('検出する: pull_request の types に closed(複数の場面・リストの書き方)', closedWf('on:\n  pull_request:\n    types: [opened, closed]') && closedWf('on:\n  pull_request:\n    types:\n      - opened\n      - closed'));
  check('検出する: pull_request_target の types に closed', closedWf('on:\n  pull_request_target:\n    types: [closed]'));
  check('検出する: 1 行の書き方({ pull_request: { types: [closed] } })と、リストの中の波括弧', closedWf('on: { pull_request: { types: [closed] } }') && closedWf('on: { pull_request_target: { types: [closed] } }') && closedWf('on:\n  - { pull_request: { types: [closed] } }'));
  check('検出する: 場面の指定を読めない(値が無い)', closedWf('on:\n  pull_request:\n    types:\n') && closedWf('on:\n  pull_request:\n    types:\n    branches: [main]'));
  check('検出する: closed を含む指定と push の組・手動の起動と closed の組', closedWf('on:\n  push:\n  pull_request:\n    types: [closed]') && closedWf('on:\n  workflow_dispatch:\n  pull_request:\n    types: [closed]'));
  check('検出しない: 閉じた時を含まない指定(ブロック・リスト・1 行の書き方)', !closedWf('on:\n  pull_request:\n    types: [opened, synchronize]') && !closedWf('on:\n  pull_request:\n    types:\n      - labeled') && !closedWf('on: { pull_request: { types: [opened] } }') && !closedWf('on: { pull_request_target: { types: [synchronize, reopened] } }'));
  check('検出しない: 指定が無い(既定の場面は開いた時・更新の時・開き直した時)', !closedWf('on: pull_request') && !closedWf('on: [pull_request, pull_request_target]') && !closedWf('on:\n  pull_request:\n    branches: [main]') && !closedWf('on: { pull_request: { branches: [main] } }') && !closedWf('on:\n  pull_request:'));
  check('検出しない: 閉じた時を含まない指定の pull_request と、既定の pull_request_target の組', !closedWf('on:\n  pull_request:\n    types: [opened]\n  pull_request_target:'));
  // 再利用の workflow の呼び出し(1 行の書き方)
  check('検出する: 1 行の書き方のジョブの uses(リポジトリの外の再利用の workflow)', deployOnPushFindings([{ path: '.github/workflows/main.yml', text: 'on: push\njobs:\n  call: { uses: org/x/.github/workflows/d.yml@v1 }\n' }]).length === 1);
  check('検出する: 1 行の書き方のジョブの uses(呼ばれる側が配備の環境を持つ)', deployOnPushFindings([{ path: '.github/workflows/main.yml', text: 'on: push\njobs:\n  call: { uses: ./.github/workflows/reuse.yml }\n' }, calleeEnv]).includes('.github/workflows/main.yml'));
  check('検出しない: 1 行の書き方のステップの uses は再利用の呼び出しに数えない', deployOnPushFindings([{ path: '.github/workflows/main.yml', text: 'on: push\njobs:\n  b:\n    steps:\n      - { uses: actions/checkout@v4 }\n' }]).length === 0);
  // 委任のマージのワークフローの環境を数えない除外は、環境の指定が 1 行だけで、ほかのワークフローから呼ばれていないときに限る
  const mergeFile = '.github/workflows/delegation.yml';
  const twoEnv = `${mergeEnv('environment: delegated-merge')}  extra:\n    runs-on: ubuntu-latest\n    environment: delegated-merge\n    steps:\n      - run: ./deploy.sh\n`;
  check('検出する: 委任のマージのワークフローへ 2 つ目の環境の指定を足す(同じ名でも数える)', delegationWf(twoEnv).length === 1);
  const callerOfDelegation = (uses) => ({ path: '.github/workflows/main.yml', text: `on: push\njobs:\n  call:\n    uses: ${uses}\n` });
  check('検出する: ほかのワークフローが委任のマージのワークフローを呼ぶ(ローカル・版つきの参照・1 行の書き方)', [
    './.github/workflows/delegation.yml',
    'org/repo/.github/workflows/delegation.yml@main',
  ].every((u) => deployOnPushFindings([{ path: mergeFile, text: mergeEnv('environment: delegated-merge') }, callerOfDelegation(u)]).includes(mergeFile)) && deployOnPushFindings([{ path: mergeFile, text: mergeEnv('environment: delegated-merge') }, { path: '.github/workflows/main.yml', text: 'on: push\njobs:\n  call: { uses: ./.github/workflows/delegation.yml }\n' }]).includes(mergeFile));
  check('検出しない: 委任のマージのワークフローを、ほかのワークフローが呼ばず、環境の指定が 1 行だけ', deployOnPushFindings([{ path: mergeFile, text: mergeEnv('environment: delegated-merge') }, { path: '.github/workflows/main.yml', text: 'on: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps: []\n' }]).length === 0);
  {
    const dir = new URL('../../.github/workflows/', import.meta.url);
    const real = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ path: `.github/workflows/${f}`, text: fs.readFileSync(new URL(f, dir), 'utf8') }));
    check('準拠テンプレートの実物の workflows には、起動する側の配備を検出しない(0 件)', real.length > 5 && deployOnPushFindings(real).length === 0, JSON.stringify(deployOnPushFindings(real)));
  }
  // 既定ブランチのコミットの一覧を読めないときは、ほかの読めない入力と同じく範囲の中へ倒す(読めない状況を作れないため、判定の組み立ての書き方で確かめる)
  {
    const src = fs.readFileSync(new URL('./check-pr.mjs', import.meta.url), 'utf8');
    check('既定ブランチのコミットの一覧を読めないときは、範囲の中へ倒す入力に数える', src.includes("if (log === null) cannot('既定ブランチのコミットを読めない"));
  }
  // 拾えない形(集約の限界の行に書く)
  check('拾えない形(開示済み): 配備の環境を指定せずに秘密情報で配備する push の workflow は検出しない', wf('on: push\njobs:\n  d:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./deploy.sh\n        env:\n          TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n').length === 0);
}

// ---------------------------------------------------------------- 構成の判定の入力(事業ステージの値、プロセスの構成のファイル、読めない入力)
{
  const cfgWith = (phase) => s2Cfg({ answers: { 'q-biz-phase': phase, 'q-criticality': 'cl0', 'q-quality': 'quality-standard' } });
  check('使う構成: 事業ステージは growth・stable だけ。未知の値(foo・S1・S2・大文字)は緩めない側(偽)', ['growth', 'stable'].every((p) => approvalByPreRead(cfgWith(p)) === true) && ['foo', 'S1', 'S2', 'Growth', '', null, 0].every((p) => approvalByPreRead(cfgWith(p)) === false));
  const cfg = s2Cfg();
  const tracked = ['src/core/pay.js', 'src/ui/page.js'];
  const rng = (files, over = {}) => preReadRangeOf(cfg, { files, changes: files.map((p) => ({ path: p, kind: 'modify' })), tracked, risk: 'R2', floor: 'R3', ...over });
  check('当たる: プロセスの構成のファイル(process.config.json)は、鍵を問わず統制の設定の行に当たる', (() => { const r = rng(['process.config.json']); return r.preRead && r.hits.some((h) => h.id === 'control' && h.files.includes('process.config.json')); })());
  check('範囲の外: 構成のファイルでない同名の別のパス(sub/process.config.json.bak)は当たらない', rng(['sub/process.config.json.bak']).preRead === false);
  const unread = rng(['src/ui/page.js'], { unreadable: ['実装計画を読めない'] });
  check('当たる: 判定の入力を読めなかったとき(範囲の外へ倒さず、範囲の中へ倒す)', unread.preRead === true && unread.hits.some((h) => h.id === 'unevaluated' && h.files.includes('実装計画を読めない')), JSON.stringify(unread));
  check('範囲の外: 読めなかった入力が無ければ、範囲の外のまま', rng(['src/ui/page.js'], { unreadable: [] }).preRead === false);
  check('範囲の行の見出しは、検出するものに合わせる(アサーションの行の削除。スキップへの書き換えは含めない)', /アサーションの行の削除/.test(rng(['t.js'], { testWeakened: ['t.js'] }).hits[0].label) && !/名前の変更・行の削除/.test(rng(['t.js'], { testWeakened: ['t.js'] }).hits[0].label));
}

// ---------------------------------------------------------------- 範囲の各行の当たりと外れ
{
  const cfg = s2Cfg();
  const tracked = ['src/core/pay.js', 'src/ui/page.js', 'src/api/x.js', 'specs/F-001/spec.md', 'package.json'];
  const rng = (files, over = {}) => preReadRangeOf(cfg, { files, changes: files.map((p) => ({ path: p, kind: 'modify' })), tracked, risk: 'R2', floor: 'R3', ...over });
  const ids = (r) => r.hits.map((h) => h.id).sort().join(',');
  check('範囲の外: 範囲のどの行にも当たらない R2', rng(['src/ui/page.js']).preRead === false && ids(rng(['src/ui/page.js'])) === '');
  check('範囲の外: 区分 R3 も当たらない', rng(['src/ui/page.js'], { risk: 'R3' }).preRead === false);
  check('当たる: 区分が R1', ids(rng(['src/ui/page.js'], { risk: 'R1' })) === 'risk');
  check('当たる: 記載が R2 でも区分の下限が R1', ids(rng(['src/ui/page.js'], { floor: 'R1' })) === 'risk');
  check('当たる: 区分を読めない(R1 かを確かめられない)', ids(rng(['src/ui/page.js'], { risk: null })) === 'risk-unknown');
  check('当たる: コア機能のパス', ids(rng(['src/core/pay.js'])) === 'core');
  check('当たる: コア機能のパスが未宣言なら、全変更(コア機能に触れるかを確かめられない)', (() => { const c = s2Cfg(); delete c.delegation; return preReadRangeOf(c, { files: ['src/ui/page.js'], tracked, risk: 'R2', floor: 'R3' }).hits.some((h) => h.id === 'core-undeclared'); })());
  check('当たる: 判断記録の要否の規則のパス', ids(rng(['src/api/x.js'])) === 'decision');
  check('当たる: 統制の設定・エージェントへの指示のファイル', ['.github/workflows/ci.yml', 'scripts/gate/check-pr.mjs', 'CLAUDE.md', '.claude/settings.json', '.mcp.json'].every((f) => ids(rng([f])) === 'control'));
  check('当たる: 機能仕様', ids(rng(['specs/F-001/spec.md'])) === 'spec');
  check('当たる: 依存の宣言・ロックファイル・.gitmodules', ['package.json', 'package-lock.json', 'go.sum', '.gitmodules', 'sub/requirements.txt'].every((f) => ids(rng([f])) === 'dependency'));
  check('当たる: 基底にあるテストの削除(呼び出し側が渡した一覧)', ids(rng(['test/a.test.js'], { testWeakened: ['test/a.test.js'] })) === 'test-weakened');
  check('当たる: 依存するタスクが取り込まれていない(呼び出し側が渡した一覧)', ids(rng(['src/ui/page.js'], { unmergedDeps: ['F-001/Task-1'] })) === 'task-dependency');
  check('当たる: 取り込みが本番を直接起動する構成(行ではなく構成全体)', rng(['src/ui/page.js'], { deploy: ['.github/workflows/d.yml'] }).preRead === true && rng(['src/ui/page.js'], { deploy: ['.github/workflows/d.yml'] }).deploy.length === 1);
  check('複数の行に当たれば、当たった行をすべて返す', ids(rng(['src/core/pay.js', 'package.json'])) === 'core,dependency');
  // 依存するタスクの照合
  const plan = '| ID | 内容 | 対象 | 基準 | 依存 | 状態 |\n| --- | --- | --- | --- | --- | --- |\n| Task-1 | a | x | y | なし | 未 |\n| Task-2 | b | x | y | Task-1 | 未 |\n';
  const done0 = doneTaskKeysOf(['feat: a\n\nSpec: F-001 / Task-1']);
  check('取り込み済みのタスクは、本文の末尾の段落のトレーラ Spec から読む', done0.has('F-001/Task-1'));
  check('段落の外の Spec は数えない', doneTaskKeysOf(['Spec: F-001 / Task-1\n\n説明の段落']).size === 0);
  check('依存するタスクが取り込み済みなら、未取り込みに数えない', unmergedDependencies({ specs: [{ feature: 'F-001', task: 'Task-2' }], planOf: () => plan, done: done0 }).length === 0);
  check('依存するタスクが取り込まれていなければ、未取り込みに数える', unmergedDependencies({ specs: [{ feature: 'F-001', task: 'Task-2' }], planOf: () => plan, done: new Set() }).join() === 'F-001/Task-1');
  check('依存の無いタスクは照らさない', unmergedDependencies({ specs: [{ feature: 'F-001', task: 'Task-1' }], planOf: () => plan, done: new Set() }).length === 0);
}

// ---------------------------------------------------------------- PR の検査(承認と区分の確定者)
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-deferred-'));
  const g = (...args) => execFileSync('git', args, { cwd: T, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(T, rel)), { recursive: true });
    fs.writeFileSync(path.join(T, rel), typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n');
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'tester');
  g('config', 'core.autocrlf', 'false');
  const PLAN = '| ID | 内容 | 対象 | 基準 | 依存 | 状態 |\n| --- | --- | --- | --- | --- | --- |\n| Task-1 | a | `src/ui/` | y | なし | 未 |\n| Task-2 | b | `src/ui/` | y | Task-1 | 未 |\n';
  w('src/core/pay.js', 'export const pay = 1;\n');
  w('src/ui/page.js', 'export const page = 1;\n');
  w('src/api/x.js', 'export const x = 1;\n');
  w('specs/F-001/spec.md', '# F-001\n\n## 受入基準\n\n- 条件 X のとき Y を返す\n');
  w('specs/F-001/plan.md', `# plan\n\n## タスク\n\n${PLAN}`);
  w('package.json', '{ "name": "x" }\n');
  w('test/a.test.js', "import assert from 'node:assert';\nassert.equal(1, 1);\nassert.equal(2, 2);\n");
  w('.claude/guard.json', { testPatterns: ['test/**'] });
  w('.github/workflows/ci.yml', 'name: ci\non: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: []\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'chore: base');
  let k = 0;
  const BODY = (risk, { confirm = null, spec = 'setup' } = {}) =>
    `## 変更の概要\n\n説明\n\n## 作成を指示した者\n\n山田 太郎\n\n## リスク区分\n\n${risk}\n\n${confirm ? `確定した者: ${confirm}\n\n` : ''}## トレーラ\n\n${spec === 'setup' ? 'Spec: setup' : spec}\n`;
  /** 構成を既定ブランチへ置き直し(必要なら基底の変更も)、edit を適用した PR を判定する */
  function run(config, edit, { risk = 'R2', confirm = null, reviews = [], gate = true, baseEdit = null, spec = 'setup', mainCommit = null } = {}) {
    g('switch', '-q', 'main');
    w('process.config.json', config);
    if (baseEdit) baseEdit();
    g('add', '-A');
    g('commit', '-q', '--allow-empty', '-m', `config ${k}`);
    if (mainCommit) g('commit', '-q', '--allow-empty', '-m', mainCommit);
    k++;
    g('switch', '-q', '-C', `c-${k}`, 'main');
    edit();
    g('add', '-A');
    g('commit', '-q', '-m', `change ${k}`);
    const head = g('rev-parse', 'HEAD').trim();
    g('switch', '-q', 'main');
    const pr = { number: 400 + k, title: 'feat: x', body: BODY(risk, { confirm, spec }), author: 'yamada', authorId: UID.yamada, reviews, head, hostingLookup: { prOfCommit: () => null } };
    return analyzePr({ root: T, base: 'main', pr, head: `refs/heads/c-${k}`, requireControlApproval: gate });
  }
  const ERR = /取り込む前に人が読む範囲の変更の承認/;
  const hasErr = (r, re) => r.errors.some((m) => re.test(m));
  const approve = (login, t) => review(login, `挙動要約: ${t}`);
  const sato = approve('sato', '差分を読み、画面の分岐を自分で確かめた');
  const edits = {
    ui: () => w('src/ui/page.js', 'export const page = 2;\n'),
    core: () => w('src/core/pay.js', 'export const pay = 2;\n'),
    api: () => w('src/api/x.js', 'export const x = 2;\n'),
    spec: () => w('specs/F-001/spec.md', '# F-001\n\n## 受入基準\n\n- 条件 X のとき Z を返す\n'),
    dep: () => w('package.json', '{ "name": "x", "dependencies": { "a": "1" } }\n'),
    control: () => w('.claude/settings.json', '{}\n'),
    delTest: () => fs.rmSync(path.join(T, 'test/a.test.js')),
    weakTest: () => w('test/a.test.js', "import assert from 'node:assert';\nassert.equal(1, 1);\n"),
    addTest: () => w('test/b.test.js', "import assert from 'node:assert';\nassert.equal(1, 1);\n"),
  };

  // 範囲の外
  const out = run(s2Cfg(), edits.ui);
  // IMPL-1069:ok(適合の入力: 範囲の外の R2 は、承認が無くても承認の検査で落ちず、確定者の記名も取り込む前には求めない)
  check('範囲の外の R2: 承認が無くても、承認の検査で落ちない(承認の要求は 0 名)', !hasErr(out, ERR) && out.approvers.required === 0 && out.preReadRange?.preRead === false, JSON.stringify([out.errors, out.approvers?.byRange]));
  check('範囲の外の R2: 取り込む前の承認を求めない旨と、出荷判定までに読む旨を出す', out.notices.some((m) => /取り込む前に人が読む範囲の外の変更のため、取り込む前の承認は求めない/.test(m) && /出荷判定までに/.test(m)), JSON.stringify(out.notices));
  check('範囲の外の R2: 確定者の記名が無くても、区分の確定者の検査で落とさない(出荷判定までに求める旨を出す)', !out.errors.some((m) => /リスク区分の確定者/.test(m)) && out.notices.some((m) => /リスク区分の確定者/.test(m) && /出荷判定\(G-7\)までに/.test(m)), JSON.stringify([out.errors, out.notices]));
  const outConf = run(s2Cfg(), edits.ui, { confirm: '佐藤 花子' });
  check('範囲の外の R2: 別の人の確定者の記名があれば、確定者の注記を出さない', !outConf.errors.some((m) => /リスク区分の確定者/.test(m)) && !outConf.notices.some((m) => /リスク区分の確定者/.test(m)), JSON.stringify([outConf.errors, outConf.notices]));
  const outR3 = run(s2Cfg(), edits.ui, { risk: 'R3' });
  check('範囲の外の R3: 承認を求めない', !hasErr(outR3, ERR) && outR3.approvers.required === 0);
  const outRule = run(s2Cfg(), edits.ui, { gate: false });
  check('PR の側で動く判定(--require-control-approval なし)は、範囲の外を落とさず、承認の警告も出さない', !hasErr(outRule, ERR) && outRule.approvers.required === 0 && !outRule.warnings.some((m) => /G-6 の承認者/.test(m)), JSON.stringify([outRule.errors, outRule.warnings]));

  // 範囲の中(承認が無ければ落ち、別人の承認があれば通る)
  const inRows = [
    ['R1', edits.ui, { risk: 'R1', confirm: '佐藤 花子' }, /リスク区分が R1/],
    ['コア機能', edits.core, {}, /コア機能・確約範囲のパス/],
    ['判断記録の要否の規則', edits.api, {}, /判断記録の要否の規則のパス/],
    ['統制の設定', edits.control, {}, /統制の設定\(プロセスの構成のファイルを含む\)・エージェントへの指示/],
    ['仕様', edits.spec, {}, /機能仕様/],
    ['依存の宣言', edits.dep, {}, /依存の宣言・ロックファイル/],
    ['テストの削除', edits.delTest, {}, /基底にあるテストの削除/],
    ['アサーションの行の削除', edits.weakTest, {}, /基底にあるテストの削除/],
  ];
  for (const [label, edit, opt, re] of inRows) {
    const bad = run(s2Cfg(), edit, opt);
    check(`範囲の中(${label}): 承認が無ければ落ちる(要求 1 名)。当たった行を出す`, hasErr(bad, ERR) && bad.approvers.required === 1 && re.test(bad.errors.join()), JSON.stringify([bad.errors, bad.approvers?.byRange]));
    const good = run(s2Cfg(), edit, { ...opt, reviews: [sato] });
    check(`範囲の中(${label}): 作成を指示した者と別の人の承認(挙動要約つき)があれば、承認の検査で通る`, !hasErr(good, ERR), JSON.stringify(good.errors));
  }
  const addTest = run(s2Cfg(), edits.addTest);
  check('範囲の外: テストの追加は範囲に当たらない(削除・行の削除だけが当たる)', !hasErr(addTest, ERR), JSON.stringify(addTest.errors));
  const selfOnly = run(s2Cfg(), edits.core, { reviews: [approve('yamada', '自分の変更を自分で確かめた')] });
  // IMPL-1069:ng(違反の入力: 範囲の中の変更が、作成を指示した者本人の承認だけでは通らない)
  check('範囲の中: 作成を指示した者本人の承認では通らない', hasErr(selfOnly, ERR), JSON.stringify(selfOnly.errors));
  const r1NoConfirm = run(s2Cfg(), edits.ui, { risk: 'R1', reviews: [sato] });
  check('範囲の中の R1: 確定者の記名は、取り込む前にも求める(R1 は範囲に入る)', r1NoConfirm.errors.some((m) => /リスク区分の確定者/.test(m)), JSON.stringify(r1NoConfirm.errors));

  // 依存するタスク
  const dep2 = run(s2Cfg(), edits.ui, { spec: 'Spec: F-001 / Task-2' });
  check('範囲の中(依存するタスクが未取り込み): Task-2 の PR は、Task-1 が取り込まれていなければ承認を求める', hasErr(dep2, ERR) && /依存するタスクが基底ブランチへ取り込まれていない/.test(dep2.errors.join()), JSON.stringify([dep2.errors, dep2.preReadRange]));
  const dep2ok = run(s2Cfg(), edits.ui, { spec: 'Spec: F-001 / Task-2', mainCommit: 'feat: task1\n\nSpec: F-001 / Task-1' });
  check('範囲の外(依存するタスクが取り込み済み): 範囲に当たらない', dep2ok.preReadRange?.hits.every((h) => h.id !== 'task-dependency') === true, JSON.stringify(dep2ok.preReadRange));
  check('トレーラ Spec の無い変更は依存を照らさず、照らしていない旨を出す', out.approvers.byRange.notEvaluated.some((m) => /照らしていない/.test(m)) && out.notices.some((m) => /照らせなかった範囲/.test(m)), JSON.stringify(out.approvers.byRange));

  // 取り込みが本番を直接起動する構成: 範囲の外の変更も取り込む前に読む側へ倒す
  const deployWf = () => w('.github/workflows/deploy.yml', 'name: deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps: []\n');
  const dep = run(s2Cfg(), edits.ui, { baseEdit: deployWf });
  check('取り込みが本番を直接起動する構成: 範囲の外の変更にも承認を求める(落ちる)', hasErr(dep, ERR) && dep.approvers.required === 1 && /本番への反映を直接起動する workflow/.test(dep.errors.join()), JSON.stringify([dep.errors, dep.approvers?.byRange]));
  const depOk = run(s2Cfg(), edits.ui, { baseEdit: deployWf, reviews: [sato] });
  check('取り込みが本番を直接起動する構成: 別の人の承認があれば通る', !hasErr(depOk, ERR), JSON.stringify(depOk.errors));
  const depConfirm = run(s2Cfg(), edits.ui, { baseEdit: deployWf });
  check('取り込みが本番を直接起動する構成: R2 の確定者の記名は、取り込む前に求める', depConfirm.errors.some((m) => /リスク区分の確定者/.test(m)) || depConfirm.preReadRange?.preRead === true, JSON.stringify(depConfirm.errors));
  const noDeploy = run(s2Cfg(), edits.ui, { baseEdit: () => fs.rmSync(path.join(T, '.github/workflows/deploy.yml'), { force: true }) });
  check('配備の workflow を外せば、範囲の外へ戻る', !hasErr(noDeploy, ERR) && noDeploy.approvers.required === 0, JSON.stringify(noDeploy.errors));
  // 起動の契機が workflow_run・release・schedule の配備の workflow、読めない再利用の workflow を呼ぶ push の workflow も、取り込む前に読む側へ倒す
  const wfOf = (on, tail) => () => w('.github/workflows/deploy.yml', `name: deploy\n${on}\njobs:\n${tail}`);
  const ENVJOB = '  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps: []\n';
  for (const [label, on, tail] of [
    ['workflow_run', 'on:\n  workflow_run:\n    workflows: [ci]\n    types: [completed]', ENVJOB],
    ['release', 'on:\n  release:\n    types: [published]', ENVJOB],
    ['schedule', "on:\n  schedule:\n    - cron: '0 0 * * *'", ENVJOB],
    ['読めない再利用の workflow を呼ぶ push', 'on:\n  push:\n    branches: [main]', '  call:\n    uses: org/shared/.github/workflows/deploy.yml@v1\n'],
  ]) {
    const r = run(s2Cfg(), edits.ui, { baseEdit: wfOf(on, tail) });
    check(`取り込みが本番を起動しうる構成(${label}): 範囲の外の変更にも承認を求める(落ちる)`, hasErr(r, ERR) && r.approvers.required === 1 && r.preReadRange?.deploy?.length === 1, JSON.stringify([r.errors, r.preReadRange?.deploy]));
  }
  const manual = run(s2Cfg(), edits.ui, { baseEdit: wfOf('on: workflow_dispatch', ENVJOB) });
  check('手動の起動だけの配備の workflow は、範囲の外のまま(承認を求めない)', !hasErr(manual, ERR) && manual.approvers.required === 0, JSON.stringify(manual.errors));
  run(s2Cfg(), edits.ui, { baseEdit: () => fs.rmSync(path.join(T, '.github/workflows/deploy.yml'), { force: true }) });

  // プロセスの構成のファイルを書き換える変更は、鍵を問わず範囲の中(範囲の宣言・判断記録の規則・名簿・回答を、承認なしで書き換えさせない)
  const cfgEdit = (mutate) => () => {
    const c = JSON.parse(JSON.stringify(s2Cfg()));
    mutate(c);
    w('process.config.json', c);
  };
  for (const [label, mutate] of [
    ['範囲の宣言(delegation.protectedPaths)を狭める', (c) => { c.delegation.protectedPaths = ['src/nothing/**']; }],
    ['判断記録の規則(decisionRules.rules)を空にする', (c) => { c.decisionRules.rules = []; }],
    ['名簿(people)へ人を足す', (c) => { c.people.push({ id: 'p9', name: '架空 人', accounts: [{ login: 'ghost', id: 2999 }] }); }],
    ['回答(answers.q-criticality)を書き換える', (c) => { c.answers['q-criticality'] = 'cl0 '; }],
    ['設定していなかった鍵(label)を足す', (c) => { c.label = 'x'; }],
  ]) {
    const bad = run(s2Cfg(), cfgEdit(mutate));
    check(`範囲の中(プロセスの構成のファイル: ${label}): 承認が無ければ落ちる。統制の設定の行に当たる`, hasErr(bad, ERR) && bad.approvers.required === 1 && bad.preReadRange?.hits.some((h) => h.id === 'control' && h.files.includes('process.config.json')), JSON.stringify([bad.errors, bad.preReadRange?.hits]));
  }

  // 読めない入力は、範囲の外へ倒さず、範囲の中へ倒し、照らせなかった旨を出す
  const noPatterns = run(s2Cfg(), edits.ui, { baseEdit: () => w('.claude/guard.json', {}) });
  check('範囲の中(テストのパターンが無い構成): 基底にあるテストを調べられないため、範囲の中へ倒し、旨を出す', hasErr(noPatterns, ERR) && noPatterns.preReadRange?.hits.some((h) => h.id === 'unevaluated') && noPatterns.approvers.byRange.notEvaluated.some((m) => /testPatterns/.test(m) && /範囲の中として扱う/.test(m)), JSON.stringify([noPatterns.errors, noPatterns.preReadRange]));
  const delNoPatterns = run(s2Cfg(), edits.delTest);
  check('テストのパターンが無い構成で、基底にあるテストを消す PR は、範囲の中(承認が要る)', hasErr(delNoPatterns, ERR), JSON.stringify(delNoPatterns.errors));
  const noPlan = run(s2Cfg(), edits.ui, { baseEdit: () => w('.claude/guard.json', { testPatterns: ['test/**'] }), spec: 'Spec: F-009 / Task-1' });
  check('範囲の中(実装計画を読めない): トレーラ Spec の指す機能の plan.md が無ければ、範囲の中へ倒し、旨を出す', hasErr(noPlan, ERR) && noPlan.preReadRange?.hits.some((h) => h.id === 'unevaluated' && /specs\/F-009\/plan\.md/.test(h.files.join())), JSON.stringify([noPlan.errors, noPlan.preReadRange]));
  const okPatterns = run(s2Cfg(), edits.ui);
  check('テストのパターンがあり、計画も読めるなら、範囲の外のまま(読めない入力の倒しは、読めたときに出ない)', !hasErr(okPatterns, ERR) && !okPatterns.preReadRange?.hits.some((h) => h.id === 'unevaluated'), JSON.stringify([okPatterns.errors, okPatterns.preReadRange]));

  // この形を使わない構成: 現行のまま(全 PR の承認の要求)
  const noUse = [
    ['必須の承認数 1', s2Cfg({ review: { requiredApprovals: 1, reviewerCount: 1 } })],
    ['CL1', s2Cfg({ answers: { 'q-biz-phase': 'growth', 'q-criticality': 'cl1', 'q-quality': 'quality-standard' } })],
    ['安全重要度が未記入', s2Cfg({ answers: { 'q-biz-phase': 'growth', 'q-quality': 'quality-standard' } })],
    ['規制業', s2Cfg({ answers: { 'q-biz-phase': 'growth', 'q-criticality': 'cl0', 'q-quality': 'quality-regulated' }, review: { requiredApprovals: 2, reviewerCount: 2 } })],
    ['品質「高」', s2Cfg({ answers: { 'q-biz-phase': 'growth', 'q-criticality': 'cl0', 'q-quality': 'quality-high' } })],
    ['委任の規則を登録', s2Cfg({ delegation: { allowed: true, rules: [{ id: 'r1' }], protectedPaths: ['src/core/**'] } })],
  ];
  for (const [label, c] of noUse) {
    const r = run(c, edits.ui, { confirm: null });
    check(`この形を使わない(${label}): 範囲の外の変更にも承認の要求が掛かったまま。範囲の判定を出さず、確定者の検査も取り込む前に掛かる`, r.approvers.required >= 1 && !r.approvers.byRange && r.preReadRange === null && r.errors.some((m) => /リスク区分の確定者/.test(m)) && !hasErr(r, ERR), JSON.stringify([r.errors, r.approvers]));
  }
  fs.rmSync(T, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 出荷判定の証跡の集約(模擬の gh。Windows では省く。CI は Linux で走る)
const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
if (process.platform === 'win32') {
  console.log('---- 出荷の前の確認の集約の場面(模擬の gh): Windows では省きます(CI で確かめる)');
} else {
  const ANSWERS = {
    'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
    'q-team-size': 'size-3-9', 'q-biz-phase': 'growth', 'q-external-reviewer': 'reviewer-yes',
  };
  // acc3 だけ数値の識別子を持つ(承認のレビューを独立した確認として数える場面に使う)
  const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [i === 3 ? { login: 'acc3', id: 903 } : i === 1 ? { login: 'acc1', id: 901 } : `acc${i}`] }));
  const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
  const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-fake-gh-deferred-'));
  fs.writeFileSync(
    path.join(BIN, 'gh'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "const map = JSON.parse(fs.readFileSync(process.env.FAKE_GH_MAP, 'utf8'));",
      "const target = args.find((a) => a.startsWith('repos/')) ?? '';",
      "if (args[0] === 'api' && Object.prototype.hasOwnProperty.call(map, target)) { process.stdout.write(JSON.stringify(map[target])); process.exit(0); }",
      "if (args[0] === 'api' && /\\/(pulls|reviews|commits)$/.test(target)) { process.stdout.write('[]'); process.exit(0); }",
      "if (args[0] === 'pr' && args[1] === 'view' && map[`pr/${args[2]}`]) { process.stdout.write(JSON.stringify(map[`pr/${args[2]}`])); process.exit(0); }",
      'process.exit(1);',
      '',
    ].join('\n')
  );
  fs.chmodSync(path.join(BIN, 'gh'), 0o755);
  const R = 'example/deferred';
  const cfgOf = (answers, edit = (c) => c) => edit(quiet(() => buildConfig({ ...ANSWERS, ...answers }, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config));
  const useForm = (c) => ({ ...c, review: { ...c.review, requiredApprovals: 0, reviewerCount: 1 }, delegation: { ...(c.delegation ?? {}), rules: [], protectedPaths: ['src/core/**'] }, gates: { ...c.gates, g6: { ...c.gates.g6, params: { ...c.gates.g6.params, scope: 'all' } } } });
  const body = (risk, confirm = null) => `## リスク区分\n\n- [x] ${risk}\n\n${confirm ? `確定した者: ${confirm}\n\n` : ''}`;
  /** steps: [{ file, pr, risk, confirm, workflow } | { file } (PR を経ないコミット)]。PR の変更は承認の無い 1 コミット */
  const history = (config, steps) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-deferred-agg-'));
    copyTemplateTree(dir, { skip: SKIP });
    const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    put('process.config.json', JSON.stringify(config, null, 2) + '\n');
    for (const f of ['src/core/a.js', 'src/ui/b.js', 'src/ui/d.js', 'src/misc/c.js']) put(f, 'export const v = 0;\n');
    g('init', '-q', '-b', 'main');
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'tester'], ['core.autocrlf', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false']]) g('config', k, v);
    g('add', '-A');
    g('commit', '-q', '-m', 'chore: fixture');
    const map = {};
    const shas = {};
    let seq = 0;
    for (const s of steps) {
      if (s.workflow) put('.github/workflows/deploy.yml', 'name: deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps: []\n');
      put(s.file, `export const v = ${++seq};\n`);
      g('add', '-A');
      g('commit', '-q', '-m', `feat: ${s.file} を変える\n\nRisk: ${s.risk ?? 'R2'}\nVerification: node --check を実行して通過${s.spec ? `\nSpec: ${s.spec}` : ''}`);
      const sha = g('rev-parse', 'HEAD');
      if (s.pr) {
        shas[s.pr] = sha;
        map[`repos/${R}/commits/${sha}/pulls`] = [{ number: s.pr, merged_at: s.mergedAt ?? '2026-11-05T00:00:00Z', merge_commit_sha: sha, head: { sha: `head-${s.pr}` }, user: { login: 'acc1', id: 901 } }];
        map[`repos/${R}/pulls/${s.pr}/reviews`] = (s.reviews ?? []).map((r, i) => ({ id: 9000 + s.pr * 10 + i, state: 'APPROVED', commit_id: `head-${s.pr}`, author_association: 'MEMBER', user: { login: r.login, id: r.id, type: 'User' }, body: r.body ?? '挙動要約: 差分を読み、分岐を自分で確かめた', submitted_at: r.at }));
        map[`repos/${R}/pulls/${s.pr}`] = { number: s.pr, merged_at: s.mergedAt ?? '2026-11-05T00:00:00Z', user: { login: 'acc1', id: 901 } };
        map[`repos/${R}/pulls/${s.pr}/commits`] = [{ author: { login: 'acc1', id: 901 } }];
        map[`pr/${s.pr}`] = {
          number: s.pr, title: `feat: ${s.file} を変える`, author: { login: 'acc1' }, reviews: [], statusCheckRollup: [], labels: [], createdAt: '2026-11-05T00:00:00Z',
          body: body(s.risk ?? 'R2', s.confirm), mergeCommit: { oid: sha }, commits: [{ oid: `head-${s.pr}`, messageHeadline: `feat: ${s.file} を変える`, authors: [{ login: 'acc1' }] }],
          headRefOid: `head-${s.pr}`, headRefName: `feature/pr-${s.pr}`,
        };
      } else shas[s.file] = sha;
    }
    const mapFile = path.join(BIN, `map-${path.basename(dir)}.json`);
    fs.writeFileSync(mapFile, JSON.stringify(map));
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_MAP: mapFile, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: R, GH_TOKEN: '', GITHUB_TOKEN: '' } });
    const evFile = path.join(dir, 'evidence/evidence.json');
    const ev = fs.existsSync(evFile) ? JSON.parse(fs.readFileSync(evFile, 'utf8')) : null;
    const reportPath = path.join(dir, 'evidence/quality-report.md');
    const report = (fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '').replace(/\r\n/g, '\n');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const gaps = (ev?.gaps ?? []).map(String);
    const prGap = (num) => gaps.find((x) => x.startsWith(`PR #${num}: 独立した人の確認を経ていません`)) ?? null;
    const confirmGap = (num) => gaps.find((x) => x.startsWith(`PR #${num}: リスク区分 R2 の確定者の記名がありません`)) ?? null;
    const pr = (num) => (ev?.prs ?? []).find((p) => p.number === num) ?? null;
    const commitGap = (file) => gaps.find((x) => shas[file] && x.includes(shas[file].slice(0, 7)) && /PR を経ておらず、独立した人の確認を経ていません/.test(x)) ?? null;
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ev, report, gaps, prGap, confirmGap, commitGap, pr };
  };
  const dbg = (h) => h.gaps.filter((x) => /独立した人の確認|確定者/.test(x)).join('\n') || h.out.slice(-1500);

  const cfg = cfgOf({}, useForm);
  check('試験の前提: 構成はこの形を使う', approvalByPreRead(cfg) === true, JSON.stringify([cfg.answers, cfg.review, cfg.gates?.g6]));
  {
    const h = history(cfg, [{ file: 'src/ui/b.js', pr: 1 }, { file: 'src/ui/d.js', pr: 2, confirm: '名簿 丙' }, { file: 'src/core/a.js', pr: 3 }, { file: 'src/ui/b.js', pr: 4, risk: 'R1', confirm: '名簿 丙' }, { file: 'src/misc/c.js' }]);
    check('集約の前提: 最後まで走り、PR を対応づける', Boolean(h.ev) && [1, 2, 3, 4].every((i) => Boolean(h.pr(i))), h.out.slice(-1500));
    // IMPL-1070:ok(適合の入力: 範囲の外の PR は、トレーラ Delegated: を使わず、パスと区分から範囲の外として識別する)
    check('範囲の外の PR は、範囲の外として識別する', h.pr(1)?.deferredReview?.applies === true && h.pr(1).deferredReview.preRead === false, JSON.stringify(h.pr(1)?.deferredReview));
    check('範囲の外の PR が承認を経ていなければ、出荷の前の確認が済んでいない欠落に数える(範囲の外である旨を添える)', /取り込む前に人が読む範囲の外の変更/.test(h.prGap(1) ?? '') && /出荷の前の確認が済んでいない/.test(h.prGap(1) ?? ''), dbg(h));
    // IMPL-1070:ng(違反の入力: 範囲の外の R2 に区分の確定者の記名が無い変更は、記録の欠落に数える)
    check('範囲の外の R2 に確定者の記名が無ければ、記録の欠落に数える', h.confirmGap(1) !== null, dbg(h));
    check('範囲の外の R2 に、作成を指示した者以外の名簿の人の確定者の記名があれば、記名の欠落に数えない', h.confirmGap(2) === null && h.prGap(2) !== null, dbg(h));
    check('コア機能に当たる PR は、取り込む前に人が読む範囲の変更として識別する(確定者の欠落には数えない)', h.pr(3)?.deferredReview?.preRead === true && /取り込む前に人が読む範囲の変更: コア機能・確約範囲のパス/.test(h.prGap(3) ?? '') && h.confirmGap(3) === null, dbg(h));
    check('R1 の PR は、範囲の内として識別する', h.pr(4)?.deferredReview?.preRead === true && h.pr(4).deferredReview.hits.some((x) => x.id === 'risk'), JSON.stringify(h.pr(4)?.deferredReview));
    check('PR を経ないコミットは、範囲の外に数えず、現行どおり欠落に数える', h.commitGap('src/misc/c.js') !== null, dbg(h));
    const line = (re) => h.report.split('\n').find((l) => re.test(l)) ?? '';
    check('保証の開示に、出荷の前の確認の件数・未確認の件数・最も古い経過日数・積み重なり・例外承認の件数を出す', /出荷の前の確認\(取り込む前に人が読む範囲の外で、承認を待たずに取り込んだ変更\): 2 件/.test(line(/^- 出荷の前の確認\(/)) && /出荷の前の確認が済んでいない変更.*: 2 件.*最も古い変更の取り込みからの経過 \d+ 日.*積み重なり/.test(line(/^- 出荷の前の確認が済んでいない変更/)) && /例外承認で出した変更: 0 件/.test(line(/^- 出荷の前の確認を例外承認で出した変更/)), h.report.split('\n').filter((l) => /出荷の前の確認/.test(l)).join('\n'));
    check('保証の開示に、範囲の外の R2 で確定者の記名が無い変更を出す', /確定者の記名が無い変更: 1 件\(#1\)/.test(line(/^- 範囲の外の R2 のうち/)), line(/^- 範囲の外の R2 のうち/));
    check('宣言の表(項目2)に、出荷の前の確認の行を出す', h.report.split('\n').some((l) => /^\| 出荷の前の確認\(取り込む前に人が読む範囲の外の変更\) \|/.test(l)), h.report.split('\n').filter((l) => /出荷の前の確認/.test(l)).join('\n'));
    check('保証の開示の項目1 の内訳に、出荷の前の確認が済んでいない変更を別に出す', /うち|出荷の前の確認が済んでいない変更 2 件/.test(h.report) && /取り込む前に人が読む範囲の外で取り込んだ変更 2 件のうち、出荷の前の確認が済んでいない変更 2 件/.test(h.report), h.report.split('\n').filter((l) => /出荷の前の確認が済んでいない変更 /.test(l)).join('\n').slice(0, 600));
    check('出力に、標準の内部の呼び名(採用チーム向けでない語)を出さない', !/案R|事前の範囲|記出/.test(h.report.split('\n').filter((l) => /出荷の前の確認|取り込む前に人が読む範囲/.test(l)).join('\n')));
  }
  {
    // 取り込みが本番を直接起動する構成(親の版の workflows)は、範囲の外にしない
    const h = history(cfg, [{ file: 'src/ui/b.js', pr: 1, workflow: true }, { file: 'src/ui/d.js', pr: 2 }]);
    check('取り込みが本番を直接起動する workflow を足した後の PR は、範囲の内として識別する(足した PR の親の版にはまだ無い)', h.pr(1)?.deferredReview?.preRead === true || h.pr(1)?.deferredReview?.hits?.some((x) => x.id === 'control'), JSON.stringify(h.pr(1)?.deferredReview));
    check('取り込みが本番を直接起動する workflow が親の版にある PR は、範囲の外にしない', h.pr(2)?.deferredReview?.preRead === true && h.pr(2).deferredReview.deploy.length === 1, JSON.stringify(h.pr(2)?.deferredReview));
  }
  {
    // 出荷の前の確認は、判定記録の様式で残す。取り込んだ後(マージの時刻より後)に付けた承認レビューは、独立した確認に数えない。
    // 対照: 取り込む前に付けた同じ承認レビューは数える(試験の前提の確認)
    const before = { login: 'acc3', id: 903, at: '2026-11-04T12:00:00Z' };
    const after = { login: 'acc3', id: 903, at: '2026-11-06T12:00:00Z' };
    const h = history(cfg, [{ file: 'src/ui/b.js', pr: 1, reviews: [before] }, { file: 'src/ui/d.js', pr: 2, reviews: [after] }]);
    check('前提の対照: 取り込む前に付けた別の人の承認レビューは、独立した確認に数える(欠落にしない)', h.prGap(1) === null && h.pr(1)?.g6?.independentHuman === true, `${dbg(h)}\n${JSON.stringify(h.pr(1)?.g6?.independent)}`);
    check('取り込んだ後に付けた承認レビューだけの PR は、出荷の前の確認が済んでいない欠落に数える(承認レビューでは残せない)', h.prGap(2) !== null && h.pr(2)?.g6?.independentHuman === false, `${dbg(h)}\n${JSON.stringify(h.pr(2)?.g6?.independent)}`);
  }
  {
    // 提出の時刻を読めない承認レビューは、取り込む前に付けたかを確かめられないため、独立した確認に数えない
    const untimed = { login: 'acc3', id: 903, at: undefined };
    const h = history(cfg, [{ file: 'src/ui/b.js', pr: 1, reviews: [untimed] }]);
    check('提出の時刻の無い承認レビューだけの PR は、出荷の前の確認が済んでいない欠落に数える', h.prGap(1) !== null && h.pr(1)?.g6?.independentHuman === false, `${dbg(h)}
${JSON.stringify(h.pr(1)?.g6?.independent)}`);
  }
  {
    // 積み重なりの前後は、時刻の書き方(Z と +09:00)に依らず時刻で比べる。仕様のトレーラの無い件数を出す
    const h = history(cfg, [{ file: 'src/ui/b.js', pr: 1, mergedAt: '2026-11-05T09:00:00+09:00' }, { file: 'src/ui/b.js', pr: 2, mergedAt: '2026-11-05T00:30:00Z', spec: 'F-001 / Task-1' }, { file: 'src/ui/d.js', pr: 3 }]);
    const line = (re) => h.report.split('\n').find((l) => re.test(l)) ?? '';
    check('積み重なり: 書き方が違う時刻(+09:00 と Z)でも、後に取り込んだ変更を時刻で数える(文字列の比較では 0 件になる形)', /同じファイルを触って取り込まれた変更 1 件/.test(line(/^- 出荷の前の確認が済んでいない変更/)), line(/^- 出荷の前の確認が済んでいない変更/));
    check('保証の開示に、範囲の外の変更のうち仕様のトレーラが無い件数を出す(トレーラのある PR は数えない)', /依存するタスクの取り込みを照らしていない変更: 2 件/.test(line(/^- 範囲の外の変更のうち、仕様のトレーラ/)), line(/^- 範囲の外の変更のうち、仕様のトレーラ/));
    check('集計の限界の行に、拾わない形(スキップへの書き換え・テストの設定による除外・環境を指定しない配備・workflows の外の配備)を書く', ['スキップへの書き換え', 'テストの設定', '配備の環境を指定せずに秘密情報で配備する', 'workflows の外の配備'].every((s) => line(/^- この集計の限界/).includes(s)), line(/^- この集計の限界/));
  }
  {
    // この形を使わない構成: 範囲の外の識別をしない(現行どおり全変更を欠落に数える)
    for (const [label, c] of [
      ['必須の承認数 1', cfgOf({}, (x) => ({ ...useForm(x), review: { ...x.review, requiredApprovals: 1, reviewerCount: 1 } }))],
      ['CL1', cfgOf({ 'q-criticality': 'cl1' }, useForm)],
      ['品質「高」', cfgOf({ 'q-quality': 'quality-high' }, useForm)],
    ]) {
      const h = history(c, [{ file: 'src/ui/b.js', pr: 1 }]);
      check(`この形を使わない(${label}): 範囲の外の識別も、確定者の欠落も出さず、現行どおり欠落に数える`, h.pr(1)?.deferredReview?.applies === false && h.prGap(1) !== null && !/出荷の前の確認が済んでいない/.test(h.prGap(1)) && h.confirmGap(1) === null, dbg(h));
    }
  }
  fs.rmSync(BIN, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`${failures} / ${n} 件が失敗しました`);
  process.exit(1);
}
console.log(`すべて通過しました(${n} 件)`);
