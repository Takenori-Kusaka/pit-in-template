// 初期化した直後に、G-5 の手元で確かめられる検査が通ることを試験する(#286 の通しの検証で、初期化の直後から
// G-5 が落ちた事例の回帰の試験)。
//
//   node scripts/gate/test-init-g5.mjs
//
// テンプレートの全ファイルを一時のディレクトリへ写し、1名と3名で初期化して、次を確かめます。
//   - spec-lint(引数なし = CI と同じ範囲)が通る。様式から作る機能仕様・実装計画・D-0・企画書を置いた後も通る
//   - 契約検査(verify-gate-contract)と生成区間の検査(check-process-rules)が通る。集約の needs から基準を実装するジョブを外すと、契約検査が落ちる
//   - フックの保護と権限設定の遮断が、事業ステージ(1名は S0)に依らず有効である(#290)
//   - 既存の CLAUDE.md に区間の目印だけを足した状態(常駐の規則が無い)では、check-process-rules が落ちる。
//     既存の内容を残してテンプレートの節を含めれば通る。常駐の規則の節の一覧は、テンプレートの CLAUDE.md と一致する
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
import { buildManifest, loadManifest, missingResident } from './claude-md-resident.mjs';

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
  // 雛形の所有者(@OWNER)は採用者が置き換える(置き換えないと事前点検が止める。process-compass #315 R-2)
  write('.github/CODEOWNERS', read('.github/CODEOWNERS').replace(/@OWNER\b/g, '@tester'));
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
/** 回答の JSON を作業の場所の外へ置く(作業の場所に置くと、事前点検が既存のファイルとして数える) */
function answersFile(obj) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-answers-'));
  dirs.push(d);
  const p = path.join(d, 'answers.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
/** 事前点検の下書きから一覧を作り、人が扱いと記名を書いた状態にする(試験のための記名) */
function signInventory(W) {
  const draft = W.node('scripts/gate/preflight.mjs', '--draft');
  const text = draft.out
    .replace('<氏名>', '名簿 戊')
    .replace('<YYYY-MM-DD>', '2026-10-24')
    .replace(/^(\| (?!資産 |---|\(検出)[^|]+\| [^|]+\| [^|]+\| ) \|  \|$/gm, '$1取り込む | 試験 |');
  W.write('docs/adoption-inventory.md', text);
}

// 常駐の規則の一覧が、テンプレートの CLAUDE.md と一致する(節・規則を足したのに一覧へ追加していない状態と、
// 一覧の規則がテンプレートから消えた状態を落とす。process-compass #306・#314)
{
  const text = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const stored = loadManifest();
  const built = buildManifest(text, stored);
  check(
    '常駐の規則の一覧(claude-md-resident.json)に、テンプレートの CLAUDE.md の節と規則がすべてある',
    stored !== null && JSON.stringify(stored.sections) === JSON.stringify(built.sections) && JSON.stringify(stored.rules) === JSON.stringify(built.rules) && built.rules.length > 0,
    '追加: node scripts/gate/check-process-rules.mjs --write-resident'
  );
  const m = stored ? missingResident(text, stored) : { absent: [1], empty: [], rules: [] };
  check(
    'テンプレートの CLAUDE.md が、常駐の規則の一覧のすべての節と規則を満たす',
    m.absent.length === 0 && m.empty.length === 0 && m.rules.length === 0,
    JSON.stringify(m.rules.map((r) => r.id))
  );
}

for (const n of [1, 3]) {
  const W = workspace(`${n}`);
  dirs.push(W.dir);
  const tag = `${n}名`;
  // 既存のファイルを書き換えないこと(3名では package.json を先に置いておく)
  if (n === 3) W.write('package.json', '{ "name": "kept", "private": true, "scripts": { "test": "node --test \\"tests/**/*.test.*\\"" } }\n');
  const answers = answersFile({ ...ANSWERS[n], ...COMMON });
  if (n === 3) {
    // 既存の package.json は既存の資産。一覧が無ければ事前点検が止め、初期化は構成を書かない(process-compass #315 R-1・R-2)
    const stopped = W.node('scripts/init/generate-profile.mjs', '--answers', answers, '--stack', 'node');
    check(`${tag}: 既存の資産があり一覧が無ければ、初期化は止まり構成を書かない`, !stopped.ok && /adoption-inventory/.test(stopped.out) && JSON.parse(W.read('process.config.json')).configured === false, stopped.out);
    signInventory(W);
  }
  const init = W.node('scripts/init/generate-profile.mjs', '--answers', answers, '--stack', 'node');
  check(`${tag}: 初期化が通る`, init.ok, init.out);

  // 基盤
  if (n === 1) {
    const pkg = JSON.parse(W.read('package.json'));
    check(`${tag}: package.json に test と coverage のスクリプトがある`, Boolean(pkg.scripts?.test && pkg.scripts?.coverage), JSON.stringify(pkg));
    check(`${tag}: coverage が istanbul の要約(json-summary)を出す`, /--reporter=json-summary/.test(pkg.scripts?.coverage ?? ''));
  } else {
    check(`${tag}: 既存の package.json を書き換えない`, JSON.parse(W.read('package.json')).name === 'kept');
    check(`${tag}: 既存のファイルを変更しなかったことを出力に出す`, /既にあるため変更せず: package\.json/.test(init.out), init.out);
  }
  // 保管領域の読み込みの拒否は、ステージ(1名は S0、3名は S1)に依らず残る(標準 第3章 3.11.4 要求事項7)
  const deny = JSON.parse(W.read('.claude/settings.json')).permissions?.deny ?? [];
  check(`${tag}: 権限設定が保管領域(context/_archive/)の読み込みを拒否する`, deny.includes('Read(./context/_archive/**)'), JSON.stringify(deny));
  // 組織の管理外への送信を既定で止める(標準 第5章 5.8.6、ADR-0103 決定2。process-compass #425)
  const settingsAfter = JSON.parse(W.read('.claude/settings.json'));
  check(`${tag}: 道具の利用統計を既定で送らない(env の DO_NOT_TRACK)`, settingsAfter.env?.DO_NOT_TRACK === '1', JSON.stringify(settingsAfter.env));
  check(`${tag}: ソース・パス・シンボルを LLM の提供者へ送る graft のコマンドを拒否する`, ['build --deep', 'blast --name'].every((c) => deny.includes(`Bash(npx -y @nanonets/graft@0.12.1 ${c}:*)`)), JSON.stringify(deny));
  // 強制層は事業ステージで外さない(標準 第8章 軸B、ADR-0050 決定1。#290 / ADR-0074)。1名は S0(PoC)、3名は S1
  const guard = JSON.parse(W.read('.claude/guard.json'));
  check(`${tag}: フックの保護(guard.enabled)がステージに依らず有効`, guard.enabled === true, JSON.stringify({ enabled: guard.enabled }));
  for (const rule of ['Edit(./.github/workflows/**)', 'Edit(./scripts/gate/**)', 'Edit(./.claude/settings.json)', 'Bash(gh pr merge:*)']) {
    check(`${tag}: 権限設定が ${rule} を拒否する(ステージに依らない)`, deny.includes(rule), JSON.stringify(deny));
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
  // 未確定事項(G-2・G-4 の前提条件1)と、受入基準 → タスクの対応の一覧(G-4 基準6)。process-compass #291
  {
    r = W.node('scripts/gate/spec-lint.mjs', '--gate', 'G-2', 'specs/F-001');
    check(`${tag}: 様式のままの機能仕様は、未確定事項の印が残るため spec-lint --gate G-2 が落ちる`, !r.ok && /未確定事項が 1 件/.test(r.out), r.out);
    const closed = W.read('specs/F-001/spec.md').replace(/^- \[NEEDS CLARIFICATION\].*$/m, '(なし)');
    W.write('specs/F-001/spec.md', closed);
    r = W.node('scripts/gate/spec-lint.mjs', '--gate', 'G-4', 'specs/F-001');
    check(`${tag}: 閉じた機能仕様と様式の実装計画では、未確定事項 0 件、対応の無い受入基準なし`, r.ok && /未確定事項 0 件/.test(r.out) && /合否は出さない\): なし/.test(r.out), r.out);
    const acRow0 = '| 3 | 常時 | システムは招待トークンをログへ出力してはならない |';
    W.write('specs/F-001/spec.md', closed.replace(acRow0, `${acRow0}\n| 4 | 常時 | システムは招待の一覧を 50 件ずつ表示しなければならない |`));
    r = W.node('scripts/gate/spec-lint.mjs', '--gate', 'G-4', 'specs/F-001');
    check(`${tag}: タスクに現れない受入基準 AC-4 を一覧に出し、合否には使わない`, r.ok && /F-001\/AC-4/.test(r.out), r.out);
    W.write('specs/F-001/spec.md', W.read('templates/01-feature-spec.md'));
  }
  // 検査の範囲は受入基準の節(標準 第4章 G-2)。節の外の語は検出しない
  const specBase = W.read('specs/F-001/spec.md');
  const acRow = '| 3 | 常時 | システムは招待トークンをログへ出力してはならない |';
  const withRow = (row) => specBase.replace(acRow, `${acRow}\n${row}`);
  check(`${tag}: 様式の受入基準の表に、行を足す目印がある`, specBase.includes(acRow));
  W.write('specs/F-001/spec.md', specBase + '\n| 9 | 事象駆動 | 入力が空の場合など、エラーを返す |\n');
  r = W.node('scripts/gate/spec-lint.mjs');
  // IMPL-0106:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check(`${tag}: 受入基準の節の外の語では spec-lint が落ちない`, r.ok, r.out);
  W.write('specs/F-001/spec.md', withRow('| 9 | 事象駆動 | 入力が空の場合など、エラーを返す |'));
  r = W.node('scripts/gate/spec-lint.mjs');
  // IMPL-0106:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check(`${tag}: 機能仕様に曖昧語を足すと spec-lint が落ちる`, !r.ok && /specs.F-001.spec\.md/.test(r.out), r.out);
  W.write('specs/F-001/spec.md', withRow('| 9 | 常時 | システムは一覧を高速に表示しなければならない |'));
  r = W.node('scripts/gate/spec-lint.mjs');
  check(`${tag}: 標準の表に足した検出語(高速に)で spec-lint が落ちる`, !r.ok && /高速に/.test(r.out), r.out);
  W.write('specs/F-001/spec.md', withRow('| 9 | 望まない挙動 | 不適切に操作した場合、システムはエラー E-01 を返さなければならない <!-- spec-lint-ok --> |'));
  r = W.node('scripts/gate/spec-lint.mjs');
  check(`${tag}: 理由の無い除外の印は無効(spec-lint が落ちる)`, !r.ok && /理由がありません/.test(r.out), r.out);
  W.write('specs/F-001/spec.md', withRow('| 9 | 望まない挙動 | 不適切に操作した場合、システムはエラー E-01 を返さなければならない <!-- spec-lint-ok: 「不適切に操作」は条件の名前で、E-01 の定義に閉じている --> |'));
  r = W.node('scripts/gate/spec-lint.mjs');
  check(`${tag}: 理由を書いた除外の印の行は検出から外し、件数と所在を出す`, r.ok && /除外の印で外した行 1 件/.test(r.out) && /specs.F-001.spec\.md:\d+ 除外の印/.test(r.out), r.out);
  r = W.node('scripts/gate/spec-lint.mjs', ['--terms']);
  check(`${tag}: spec-lint --terms が、標準の表の検出語(11語)を出す`, r.ok && r.out.trim().split(' / ').length === 11 && /高速に/.test(r.out), r.out);
  for (const f of ['docs/D-0-governance.md', 'docs/project-brief.md']) fs.rmSync(path.join(W.dir, f));
  fs.rmSync(path.join(W.dir, 'specs/F-001'), { recursive: true });

  // 契約検査と生成区間
  r = W.node('scripts/gate/verify-gate-contract.mjs');
  // IMPL-0264:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check(`${tag}: verify-gate-contract が通る`, r.ok, r.out);
  // 集約(gate-g5)の needs から G-5 の基準を実装するジョブを外すと、契約検査が落ちる(標準 第4章 G-5「判定基準を実装する検査と集約」。#290)
  {
    const wfPath = '.github/workflows/gate-g5.yml';
    const wfText = W.read(wfPath);
    const cut = wfText.replace(/needs: \[config, contract, test, static-analysis, spec-lint, context-format, ip-clearance, secret-scan, pr-rules\]/, 'needs: [config, contract, pr-rules]');
    check(`${tag}: 集約の needs を書き換える試験の目印がある`, cut !== wfText);
    W.write(wfPath, cut);
    r = W.node('scripts/gate/verify-gate-contract.mjs');
    check(
      `${tag}: 集約の needs から 5 つのジョブ(秘匿情報の検査を含む)を外すと、契約検査が落ちる`,
      !r.ok && /基準7\(秘匿情報の混入検査\)/.test(r.out) && /基準1\(全テスト\)/.test(r.out) && /基準4\(曖昧語チェック\)/.test(r.out),
      r.out
    );
    W.write(wfPath, wfText);
  }
  // 製品のコードに宣言していないスタックがあると、契約検査が落ちる(標準 第4章 G-5「製品のすべてのスタック」。process-compass #363 / ADR-0121)
  {
    const stack = JSON.parse(W.read('process.config.json')).adapters.stack;
    const other = stack === 'python' ? ['services/api/package.json', 'services/api/index.js'] : ['services/api/pyproject.toml', 'services/api/app.py'];
    W.write(other[0], other[0].endsWith('.json') ? '{}\n' : '[project]\nname = "api"\n');
    W.write(other[1], 'x = 1\n');
    r = W.node('scripts/gate/verify-gate-contract.mjs');
    check(`${tag}: 宣言していないスタック(services/api)の製品のコードがあると、契約検査が「基準1 未充足」で落ちる`, !r.ok && /G-5 基準1 未充足/.test(r.out) && /未実施\(構成のアダプタの外\)/.test(r.out), r.out);
    W.write('.github/stack-exclusions.json', JSON.stringify({ exclusions: [{ path: 'services/api', category: 'non-product', reason: '試験の材料', decidedBy: '' }] }));
    r = W.node('scripts/gate/verify-gate-contract.mjs');
    check(`${tag}: 記名の無い除外では、契約検査が落ちる`, !r.ok && /記名\(decidedBy\)が未記入/.test(r.out), r.out);
    W.write('.github/stack-exclusions.json', JSON.stringify({ exclusions: [{ path: 'services/api', category: 'non-product', reason: '試験の材料', decidedBy: '名簿 外子' }] }));
    r = W.node('scripts/gate/verify-gate-contract.mjs');
    // 初期化の直後は名簿(people[])が未記入。除外は緩める向きの決定であり、名簿で照らせない記名を受けない(突合 X3-2。
    // 名簿にある人の記名で通ることは test-stack-coverage.mjs が確かめる)
    check(`${tag}: 名簿で照らせない名前の記名の除外では、契約検査が落ちる(突合 X3-2)`, !r.ok && /名簿/.test(r.out) && /基準1 未充足/.test(r.out), r.out);
    for (const f of [...other, '.github/stack-exclusions.json']) fs.rmSync(path.join(W.dir, f));
    fs.rmSync(path.join(W.dir, 'services'), { recursive: true, force: true });
    r = W.node('scripts/gate/verify-gate-contract.mjs');
    check(`${tag}: 宣言の外のスタックが無くなれば、契約検査が通る`, r.ok, r.out);
  }
  // アダプタの projectDir が無いディレクトリを指すと、契約検査が落ちる(process-compass #363 の突合 X-1)
  {
    const stack = JSON.parse(W.read('process.config.json')).adapters.stack;
    const aPath = `adapters/${stack}.json`;
    const aText = W.read(aPath);
    W.write(aPath, JSON.stringify({ ...JSON.parse(aText), projectDir: 'no-such-dir' }, null, 2));
    r = W.node('scripts/gate/verify-gate-contract.mjs');
    check(`${tag}: アダプタの projectDir が無いディレクトリを指すと、契約検査が落ちる`, !r.ok && /projectDir "no-such-dir" のディレクトリがありません/.test(r.out), r.out);
    W.write(aPath, aText);
  }
  // 承認は承認した差分に対して数える(標準 第4章 G-6。#296 L-2)。適用するルールセットの dismiss_stale_reviews_on_push を外すと契約検査が落ちる
  {
    const cfg = JSON.parse(W.read('process.config.json'));
    const rsPath = `.github/rulesets/${cfg.ruleset}.json`;
    if (cfg.ruleset && W.exists(rsPath) && cfg.gates?.g5?.state !== 'omitted') {
      const rsText = W.read(rsPath);
      const cut = rsText.replace('"dismiss_stale_reviews_on_push": true', '"dismiss_stale_reviews_on_push": false');
      check(`${tag}: ルールセット ${cfg.ruleset} に dismiss_stale_reviews_on_push がある`, cut !== rsText);
      W.write(rsPath, cut);
      r = W.node('scripts/gate/verify-gate-contract.mjs');
      // IMPL-0264:ng(違反と適合の対。標準の実装マーク。process-compass #314)
      check(`${tag}: ルールセット ${cfg.ruleset} の dismiss_stale_reviews_on_push を外すと、契約検査が落ちる`, !r.ok && /dismiss_stale_reviews_on_push/.test(r.out), r.out);
      W.write(rsPath, rsText);
    }
    // カバレッジの測る範囲(G-5 基準3。#296 L-1): node の既定は「変更で加えた・変えたコード」。企画書の記録と食い違えば契約検査が落ちる
    check(`${tag}: node の構成のカバレッジの測る範囲の既定は changed`, cfg.ci?.coverageScope === 'changed', JSON.stringify(cfg.ci));
    const brief = W.read('templates/06-project-brief.md');
    const row = (v) => brief.replace(/^\| カバレッジの測る範囲\(G-5 基準3\) \|.*$/m, `| カバレッジの測る範囲(G-5 基準3) | ${v} |`);
    check(`${tag}: 企画書の様式に「カバレッジの測る範囲」の行がある`, row('全体') !== brief, brief.split('\n').filter((l) => l.includes('カバレッジ')).join(' / '));
    W.write('docs/project-brief.md', row('全体'));
    r = W.node('scripts/gate/verify-gate-contract.mjs');
    // IMPL-0261:ng(違反と適合の対。標準の実装マーク。process-compass #314)
    check(`${tag}: 企画書の範囲(全体)と構成の範囲(変更)が食い違えば、契約検査が落ちる`, !r.ok && /企画書に記録したカバレッジの測る範囲/.test(r.out), r.out);
    W.write('docs/project-brief.md', row('変更で加えた・変えたコード'));
    r = W.node('scripts/gate/verify-gate-contract.mjs');
    // IMPL-0261:ok(違反と適合の対。標準の実装マーク。process-compass #314)
    check(`${tag}: 企画書の範囲と構成の範囲が一致すれば、契約検査が通る`, r.ok, r.out);
    fs.rmSync(path.join(W.dir, 'docs/project-brief.md'));
  }
  r = W.node('scripts/gate/check-process-rules.mjs');
  check(`${tag}: check-process-rules が通る`, r.ok, r.out);

  // 既存のリポジトリへの持ち込み(process-compass #306): 既存の CLAUDE.md を残し、区間の目印だけを足した状態
  {
    const full = W.read('CLAUDE.md');
    const begin = '<!-- generated:process-rules start -->';
    const end = '<!-- generated:process-rules end -->';
    const region = full.slice(full.indexOf(begin), full.indexOf(end) + end.length);
    const own = '# 既存の規約\n\n- 変数名はキャメルケースで書く\n';
    W.write('CLAUDE.md', `${own}\n## このプロジェクトの構成(自動生成)\n\n${region}\n`);
    r = W.node('scripts/gate/check-process-rules.mjs');
    // IMPL-0123:ng(違反と適合の対。標準の実装マーク。process-compass #314)
    check(
      `${tag}: 区間の目印だけを足した既存の CLAUDE.md では check-process-rules が落ちる(常駐の規則が無い)`,
      !r.ok && /常駐の規則の節が 18 件、規則が \d+ 件ありません/.test(r.out) && /見出しが無い: ### 行ってはならない作業/.test(r.out),
      r.out
    );
    // 見出しだけを足して本文を持たない節は、あるものとして数えない
    W.write('CLAUDE.md', `${full.replace(/(### 停止の申し立てと品質保証の層1\r?\n)[\s\S]*?(\r?\n### 標準の条項を課すとき)/, '$1$2')}`);
    r = W.node('scripts/gate/check-process-rules.mjs');
    check(
      `${tag}: 見出しだけで本文の無い節は check-process-rules が落とす`,
      !r.ok && /本文が無い: ### 停止の申し立てと品質保証の層1/.test(r.out),
      r.out
    );
    // 既存の内容を残して、テンプレートの節を含めれば通る
    W.write('CLAUDE.md', `${own}\n${full}\n## 案件で足した節\n\n- 案件の規則\n`);
    r = W.node('scripts/gate/check-process-rules.mjs');
    // IMPL-0123:ok(違反と適合の対。標準の実装マーク。process-compass #314)
    check(`${tag}: 既存の内容を残してテンプレートの節を含めた CLAUDE.md は check-process-rules が通る`, r.ok, r.out);
    W.write('CLAUDE.md', full);
  }

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
for (const stack of ['python', 'python-poetry', 'python-uv', 'go', 'none', 'undetermined']) {
  const W = workspace(stack);
  dirs.push(W.dir);
  const init = W.node('scripts/init/generate-profile.mjs', '--answers', answersFile({ ...ANSWERS[1], ...COMMON }), '--stack', stack);
  check(`${stack}: 初期化が通る`, init.ok, init.out);
  check(`${stack}: package.json を作らない`, !W.exists('package.json'));
  check(`${stack}: 初回の G-5 までに作るものを列挙する`, /初回の G-5 を通すまでに作るもの/.test(init.out), init.out);
  // 秘匿情報の検査は、スタックに依らず、製品のコードが無くても実行する(G-5 基準7。process-compass #363)
  check(`${stack}: 秘匿情報の検査の設定を作る`, W.exists('.secretlintrc.json'));
  const r = W.node('scripts/gate/spec-lint.mjs');
  check(`${stack}: 初期化の直後に spec-lint(引数なし)が通る`, r.ok, r.out);
}

// 初期化の問い「AI に GitHub を操作させるとき、どのアカウントで動かすか」(標準 第3章 3.5.3 要求事項1。process-compass #430 / IMPL-0428)。
// 全規模で問い、回答から seats[].performerAccount を生成し、PROCESS-PROFILE.md に名義と、共有・未申告なら列挙に無い離脱を出す
{
  const initWith = (label, pa, n = 1) => {
    const W = workspace(`pa-${label}`);
    dirs.push(W.dir);
    const init = W.node('scripts/init/generate-profile.mjs', '--answers', answersFile({ ...ANSWERS[n], ...COMMON, ...(pa === undefined ? {} : { performerAccount: pa }) }), '--stack', 'node');
    const cfg = init.ok ? JSON.parse(W.read('process.config.json')) : null;
    return { W, init, cfg, profile: init.ok ? W.read('PROCESS-PROFILE.md') : '' };
  };
  const dedicated = initWith('dedicated', { kind: 'dedicated', account: { login: 'pit-agent-acct', id: 7001 } }, 3);
  const nonHuman = (cfg) => cfg.seats.filter((s) => s.modeCeiling !== 'human');
  // IMPL-0428:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check(
    '名義の問い: 専用の回答(login と id は人が書く)から、AI の担い手を置ける席へ performerAccount を生成する(人確定の席には書かない)',
    dedicated.init.ok && nonHuman(dedicated.cfg).every((s) => s.performerAccount?.kind === 'dedicated' && s.performerAccount.account.id === 7001) && dedicated.cfg.seats.filter((s) => s.modeCeiling === 'human').every((s) => !s.performerAccount),
    dedicated.init.out
  );
  check('名義の問い: 専用は PROCESS-PROFILE.md に名義として出て、列挙に無い離脱にしない', /### AI の担い手の名義/.test(dedicated.profile) && /pit-agent-acct/.test(dedicated.profile) && !/\*\*列挙に無い離脱\*\*: /.test(dedicated.profile), dedicated.profile.slice(0, 400));
  const contract = dedicated.W.node('scripts/gate/verify-gate-contract.mjs');
  check('名義の問い: 専用の回答で初期化した構成は契約検査を通る', contract.ok, contract.out);
  const shared = initWith('shared', { kind: 'shared' });
  check(
    '名義の問い: 自分たちのアカウントの回答は shared(名簿が空のため person なし)。PROCESS-PROFILE.md に列挙に無い離脱として出す',
    shared.init.ok && nonHuman(shared.cfg).every((s) => s.performerAccount?.kind === 'shared' && s.performerAccount.person === undefined) && /\*\*列挙に無い離脱\*\*: /.test(shared.profile),
    shared.init.out
  );
  const undecided = initWith('undecided', 'undecided');
  check('名義の問い: まだ決めていない回答は無記入(未申告)で、出力に未申告と出す', undecided.init.ok && undecided.cfg.seats.every((s) => !('performerAccount' in s)) && /\[名義\].*まだ決めていない/.test(undecided.init.out), undecided.init.out);
  const absent = initWith('absent', undefined);
  check('名義の問い: 回答が無い初期化も受け付け、問いの回答が無い旨を出す(旧い回答ファイル)', absent.init.ok && /\[名義\].*問いの回答が無い/.test(absent.init.out), absent.init.out);
  // IMPL-0428:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const badId = initWith('bad-id', { kind: 'dedicated', account: { login: 'pit-agent-acct', id: '7001' } });
  check('名義の問い: 専用の id が数値の識別子でない回答を拒否し、構成を書かない', !badId.init.ok && /正の整数/.test(badId.init.out) && JSON.parse(badId.W.read('process.config.json')).configured === false, badId.init.out);
  const withPerson = initWith('with-person', { kind: 'shared', person: 'p1' });
  check('名義の問い: 名簿が空の初期化で共有の相手(person)を書いた回答を拒否する', !withPerson.init.ok && /person/.test(withPerson.init.out), withPerson.init.out);
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
