// 初期化した直後に、G-5 の手元で確かめられる検査が通ることを試験する(#286 の通しの検証で、初期化の直後から
// G-5 が落ちた事例の回帰の試験)。
//
//   node scripts/gate/test-init-g5.mjs
//
// テンプレートの全ファイルを一時のディレクトリへ写し、1名と3名で初期化して、次を確かめます。
//   - spec-lint(引数なし = CI と同じ範囲)が通る。様式から作る機能仕様・実装計画・D-0・企画書を置いた後も通る
//   - 契約検査(verify-gate-contract)と生成区間の検査(check-process-rules)が通る
//   - node の基盤(package.json の test と coverage、秘匿情報の検査の設定、テストの置き場)が作られ、既存のファイルを書き換えない
//   - 初期化の PR(生成物と基盤だけ。トレーラ Spec: setup)が pr-rules(check-pr)を通る。製品のコードを足すと落ちる。
//     リスク区分の節が無い本文は落ちる
//   - カバレッジの測定対象が0行のとき、製品のコードが無ければ通し、あれば落とす
//   - 初期化の出力が、PR を経て main へ入れる案内と、ほかのスタックで作るべきファイルを出す
//
// ネットワークを使う検査(依存の取得・脆弱性・ライセンス・秘匿情報)は、この試験では実行しません。手元では
// node scripts/gate/g5-local.mjs で、CI と同じ範囲を実行します。
// 構成が設定済みのリポジトリ(テンプレートから作り、初期化した後)では、テンプレートの初期の状態が無いため省きます。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';

const own = JSON.parse(fs.readFileSync(path.join(ROOT, 'process.config.json'), 'utf8'));
if (own.configured !== false) {
  console.log('初期化の試験: 構成が設定済みのため省きます(テンプレートの初期の状態でだけ実行します)');
  process.exit(0);
}

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
}

function copyTemplate(dst) {
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dst, e.name), { recursive: true });
  }
}

function workspace(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pit-in-init-${label}-`));
  copyTemplate(dir);
  const run = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '' }, ...opts });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const node = (script, ...a) => run(process.execPath, [script, ...a]);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const exists = (rel) => fs.existsSync(path.join(dir, rel));
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: template');
  return { dir, run, git, node, write, exists, read };
}

const ANSWERS = {
  1: { 'q-team-size': 'size-1-2', 'q-biz-phase': 'poc', 'q-external-reviewer': 'reviewer-no' },
  3: { 'q-team-size': 'size-3-9', 'q-biz-phase': 'mvp' },
};
const COMMON = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free' };
const dirs = [];

for (const n of [1, 3]) {
  const W = workspace(`${n}`);
  dirs.push(W.dir);
  const tag = `${n}名`;
  // 既存のファイルを書き換えないこと(3名では package.json を先に置いておく)
  if (n === 3) W.write('package.json', '{ "name": "kept", "private": true, "scripts": { "test": "node --test \\"tests/**/*.test.*\\"" } }\n');
  W.write('answers.json', JSON.stringify({ ...ANSWERS[n], ...COMMON }));
  const init = W.node('scripts/init/generate-profile.mjs', '--answers', 'answers.json', '--stack', 'node');
  check(`${tag}: 初期化が通る`, init.ok, init.out);
  fs.rmSync(path.join(W.dir, 'answers.json'));

  // 基盤
  if (n === 1) {
    const pkg = JSON.parse(W.read('package.json'));
    check(`${tag}: package.json に test と coverage のスクリプトがある`, Boolean(pkg.scripts?.test && pkg.scripts?.coverage), JSON.stringify(pkg));
    check(`${tag}: coverage が istanbul の要約(json-summary)を出す`, /--reporter=json-summary/.test(pkg.scripts?.coverage ?? ''));
  } else {
    check(`${tag}: 既存の package.json を書き換えない`, JSON.parse(W.read('package.json')).name === 'kept');
    check(`${tag}: 既存のファイルを変更しなかったことを出力に出す`, /既にあるため変更せず: package\.json/.test(init.out), init.out);
  }
  check(`${tag}: 秘匿情報の検査の設定(.secretlintrc.json)がある`, W.exists('.secretlintrc.json'));
  check(`${tag}: テストの置き場(tests/)がある`, W.exists('tests/README.md'));
  check(`${tag}: ロックファイルを npm install で作る案内が出る`, /npm install/.test(init.out), init.out);
  check(`${tag}: 最初のコミットを PR 経由で入れる案内(Spec: setup)が出る`, /\[最初のコミット\].*PR.*Spec: setup/.test(init.out), init.out);
  check(`${tag}: 手元の G-5 の検査のコマンドが出る`, /g5-local\.mjs/.test(init.out));

  // spec-lint(CI と同じ範囲)
  let r = W.node('scripts/gate/spec-lint.mjs');
  check(`${tag}: 初期化の直後に spec-lint(引数なし)が通る`, r.ok, r.out);
  W.write('docs/D-0-governance.md', W.read('templates/00-d0-governance.md'));
  W.write('docs/project-brief.md', W.read('templates/06-project-brief.md'));
  W.write('specs/F-001/spec.md', W.read('templates/01-feature-spec.md'));
  W.write('specs/F-001/plan.md', W.read('templates/07-implementation-plan.md'));
  r = W.node('scripts/gate/spec-lint.mjs');
  check(`${tag}: 様式から機能仕様・実装計画・D-0・企画書を作った直後も spec-lint が通る`, r.ok, r.out);
  W.write('specs/F-001/spec.md', W.read('specs/F-001/spec.md') + '\n| 9 | 事象駆動 | 入力が空の場合など、エラーを返す |\n');
  r = W.node('scripts/gate/spec-lint.mjs');
  check(`${tag}: 機能仕様に曖昧語を足すと spec-lint が落ちる`, !r.ok && /specs.F-001.spec\.md/.test(r.out), r.out);
  for (const f of ['docs/D-0-governance.md', 'docs/project-brief.md']) fs.rmSync(path.join(W.dir, f));
  fs.rmSync(path.join(W.dir, 'specs/F-001'), { recursive: true });

  // 契約検査と生成区間
  r = W.node('scripts/gate/verify-gate-contract.mjs');
  check(`${tag}: verify-gate-contract が通る`, r.ok, r.out);
  r = W.node('scripts/gate/check-process-rules.mjs');
  check(`${tag}: check-process-rules が通る`, r.ok, r.out);

  // 初期化の PR(生成物と基盤だけ)
  W.git('switch', '-q', '-c', 'chore/process-init');
  W.write('package-lock.json', '{ "lockfileVersion": 3 }\n');
  W.git('add', '-A');
  W.git('commit', '-q', '-m', 'chore: プロセス構成を初期化する');
  // 本文は PR の様式どおり、リスク区分を1つ残す(区分は Spec: setup の PR にも要る。#286 N7)
  const body = (trailers, risk = 'R2') => `## 変更の概要\n\n初期化\n\n${risk === null ? '' : `## リスク区分\n\n${risk}\n\n`}## トレーラ\n\n${trailers}\n`;
  const pr = (trailers, risk) => {
    W.write('.git/pit-pr.json', JSON.stringify({ number: 1, title: 'chore: 初期化', body: body(trailers, risk), author: 'tester' }));
    return W.node('scripts/gate/check-pr.mjs', '--base', 'main', '--pr', path.join(W.dir, '.git/pit-pr.json'));
  };
  r = pr('Spec: setup');
  check(`${tag}: 初期化の PR が Spec: setup で pr-rules を通る`, r.ok, r.out);
  r = pr('Spec: setup', null);
  check(`${tag}: 初期化の PR でもリスク区分が無ければ pr-rules が落ちる`, !r.ok && /リスク区分: PR の本文に「## リスク区分」の節がありません/.test(r.out), r.out);
  r = W.node('scripts/gate/verify-gate-contract.mjs', '--base', 'main');
  check(`${tag}: 初期化の PR が基底(未設定の構成)と比べた契約検査を通る`, r.ok, r.out);
  W.write('src/index.js', 'module.exports = 1;\n');
  W.git('add', '-A');
  W.git('commit', '-q', '-m', 'feat: x');
  r = pr('Spec: setup');
  check(`${tag}: 製品のコードを含めると Spec: setup では pr-rules が落ちる`, !r.ok && /Spec: setup は/.test(r.out), r.out);

  // カバレッジの測定対象が0行
  W.write('coverage/coverage-summary.json', JSON.stringify({ total: { lines: { total: 0, covered: 0, skipped: 0, pct: 'Unknown' } } }));
  r = W.node('scripts/gate/coverage-check.mjs');
  check(`${tag}: 測定対象が0行で、製品のコードがあれば coverage-check が落ちる`, !r.ok, r.out);
  W.git('rm', '-q', 'src/index.js');
  W.git('commit', '-q', '-m', 'revert');
  r = W.node('scripts/gate/coverage-check.mjs');
  check(`${tag}: 測定対象が0行で、製品のコードが無ければ coverage-check は対象なしで通る`, r.ok, r.out);

  // テストの実行(0件で通る)。npm が無い環境では省く
  if (n === 1) {
    const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (npm.status === 0) {
      r = W.run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--silent'], { shell: process.platform === 'win32' });
      check(`${tag}: テストが0件の段階で npm test が通る`, r.ok, r.out);
    } else console.log('skip npm が無いため、npm test を省きます');
  }
}

// ほかのスタックの初期化の出力
for (const stack of ['python', 'go', 'none', 'undetermined']) {
  const W = workspace(stack);
  dirs.push(W.dir);
  W.write('answers.json', JSON.stringify({ ...ANSWERS[1], ...COMMON }));
  const init = W.node('scripts/init/generate-profile.mjs', '--answers', 'answers.json', '--stack', stack);
  check(`${stack}: 初期化が通る`, init.ok, init.out);
  check(`${stack}: package.json を作らない`, !W.exists('package.json'));
  check(`${stack}: 初回の G-5 までに作るものを列挙する`, /初回の G-5 を通すまでに作るもの/.test(init.out), init.out);
  if (stack === 'python' || stack === 'go') check(`${stack}: 秘匿情報の検査の設定を作る`, W.exists('.secretlintrc.json'));
  const r = W.node('scripts/gate/spec-lint.mjs');
  check(`${stack}: 初期化の直後に spec-lint(引数なし)が通る`, r.ok, r.out);
}

// ワークフローの定義
const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/gate-g5.yml'), 'utf8');
check('ワークフロー: spec-lint ジョブは引数なしで実行する(手元の既定の範囲と同じ)', /run: node scripts\/gate\/spec-lint\.mjs\s*$/m.test(wf));
check('ワークフロー: contract で、この試験を実行する', /node scripts\/gate\/test-init-g5\.mjs/.test(wf));

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`初期化の試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`初期化の試験: ${checks} 件が期待と一致しました`);
