// 製品のすべてのスタックの突き合わせ(stack-coverage.mjs)を試験する(標準 第4章 G-5「製品のすべてのスタック」。process-compass #363 / ADR-0121)。
//
//   node scripts/gate/test-stack-coverage.mjs
//
// 確かめること:
//   - 混在のリポジトリ(node のアダプタ + services/api の python)は、宣言の外のスタックとして失敗する。表示は「基準1 未充足」と
//     「未実施(構成のアダプタの外)」。目印の無い .py の寄せ集めも、拡張子の集計で見つける
//   - 宣言(アダプタのスタック × projectDir、none の stacks)の中のスタックは通る。旧い構成(アダプタ1つ)は値を変えずに宣言として読む
//   - アダプタの外の言語は none の手書きの要素(stacks)で受ける。手書きの要素が無ければ失敗する
//   - 除外(.github/stack-exclusions.json)は、区分 non-product・パス・理由・人の記名を要する。記名の欠け・AI の名義・区分の外・
//     ワイルドカード・全体・宣言した作業の場所を覆う除外は受けない
//   - 強制層(scripts/gate など)と文書は製品のコードに数えない。除外は秘匿情報の検査(基準7)に効かない
//   - 除外の記名は nameProblems で確かめる(担い手の識別と同じ文字列・名簿にない名前を受けない。突合 X3-2)
//   - 手書きの要素は要素ごとにカバレッジを報告し、要素ごとに基準値と比べる。報告が無ければ基準3 の未実施で失敗(突合 X3-1)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stackOfFile, declaredStacks, parseStackExclusions, matchStacks, uncoveredProblems, stackCoverageReport, isProductCandidate, STACK_EXCLUSIONS_FILE } from './stack-coverage.mjs';
import { ALWAYS_PHASES } from './config.mjs';
import { evaluateHandwrittenStacks, evaluateCoverage } from './coverage-check.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
}

const CONFIG = { configured: true, people: [{ id: 'p1', name: '鈴木 一郎' }] };
const NODE = { id: 'node', runtime: 'node', commands: { test: 'npm test' } };
const PY_API = { id: 'python', runtime: 'python', projectDir: 'services/api', commands: { test: 'python -m pytest' } };
const NONE = (stacks) => ({ id: 'none', runtime: null, commands: { test: 'make test' }, stacks });
const EXCL = (x) => JSON.stringify({ exclusions: Array.isArray(x) ? x : [x] });
const OK_EX = { path: 'tools', category: 'non-product', reason: '文書の生成に使う道具', decidedBy: '鈴木 一郎' };

// ---------------------------------------------------------------- 1. 検出(目印と拡張子)
check('検出: package.json は node の目印', stackOfFile('web/package.json')?.stack === 'node' && stackOfFile('web/package.json').via === 'marker');
check('検出: requirements-dev.txt は python の目印', stackOfFile('requirements-dev.txt')?.stack === 'python');
check('検出: 目印の無い .py は拡張子で python', stackOfFile('scripts/etl/load.py')?.stack === 'python' && stackOfFile('scripts/etl/load.py').via === 'extension');
check('検出: .rs は rust、Cargo.toml は rust の目印', stackOfFile('crates/a/src/lib.rs')?.stack === 'rust' && stackOfFile('Cargo.toml')?.via === 'marker');
check('検出: 文書・データは数えない', stackOfFile('README.md') === null && stackOfFile('data/a.csv') === null);
check('製品の候補: 強制層(scripts/gate・.github)と依存の置き場は数えない', !isProductCandidate('scripts/gate/check-pr.mjs') && !isProductCandidate('.github/actions/x/index.js') && !isProductCandidate('node_modules/a/index.js') && !isProductCandidate('.venv/lib/a.py'));
check('製品の候補: 文書の置き場のコード(docs/conf.py)は数える', isProductCandidate('docs/conf.py'));

// ---------------------------------------------------------------- 2. 宣言
{
  const d = declaredStacks(PY_API).declared;
  check('宣言: 言語のアダプタはスタック × projectDir(旧い構成の1つのアダプタをそのまま宣言として読む)', d.length === 1 && d[0].stack === 'python' && d[0].place === 'services/api', JSON.stringify(d));
  check('宣言: undetermined は宣言を持たない', declaredStacks({ id: 'undetermined', runtime: null, commands: {} }).declared.length === 0);
  const n = declaredStacks(NONE([{ stack: 'rust', path: '.' }, { stack: 'python', path: 'services/api' }]));
  check('宣言: none の手書きの要素(stacks)', n.problems.length === 0 && n.declared.map((x) => `${x.stack}@${x.place}`).join() === 'rust@.,python@services/api', JSON.stringify(n));
  check('宣言: none の stacks の知らないスタックを受けない', declaredStacks(NONE([{ stack: 'cobol', path: '.' }])).problems.some((p) => /cobol/.test(p)));
  check('宣言: none の stacks の作業の場所が無いディレクトリなら失敗', declaredStacks(NONE([{ stack: 'python', path: 'nope' }]), { dirExists: () => false }).problems.some((p) => /ディレクトリがありません/.test(p)));
  check('宣言: 言語のアダプタに stacks を書くと失敗(複数のアダプタは第2段で、無い)', declaredStacks({ ...NODE, stacks: [{ stack: 'python', path: '.' }] }).problems.some((p) => /none\.json だけ/.test(p)));
}

// ---------------------------------------------------------------- 3. 突き合わせ(混在の場面)
const MIXED = ['package.json', 'src/index.ts', 'services/api/pyproject.toml', 'services/api/app.py', 'services/api/tests/test_app.py'];
{
  const decl = declaredStacks(NODE).declared;
  const r = matchStacks(MIXED, decl, []);
  const msgs = uncoveredProblems(r.uncovered, 'node');
  // IMPL-0476:ng(違反と適合の対。標準の実装マーク。process-compass #363)
  check('混在: node のアダプタで services/api の python は宣言の外として失敗', Object.keys(r.uncovered).join() === 'python' && r.uncovered.python.length === 3, JSON.stringify(r.uncovered));
  check('混在: 表示はゲートの単位で「基準1 未充足」、検査の単位で「未実施(構成のアダプタの外)」', msgs.length === 1 && /G-5 基準1 未充足/.test(msgs[0]) && /未実施\(構成のアダプタの外\)/.test(msgs[0]) && /services\/api\/pyproject\.toml/.test(msgs[0]), msgs.join('\n'));
  const loose = matchStacks(['package.json', 'src/index.ts', 'scripts/etl/load.py'], decl, []);
  check('混在: 目印の無い .py の寄せ集めも拡張子の集計で見つけて失敗', loose.uncovered.python?.[0]?.via === 'extension', JSON.stringify(loose.uncovered));
  // IMPL-0476:ok(違反と適合の対。標準の実装マーク。process-compass #363)
  const both = matchStacks(MIXED, declaredStacks(NONE([{ stack: 'node', path: '.' }, { stack: 'python', path: 'services/api' }])).declared, []);
  check('混在: none の手書きの要素で node と python を宣言すれば通る', Object.keys(both.uncovered).length === 0, JSON.stringify(both.uncovered));
  const single = matchStacks(['package.json', 'src/index.ts', 'tests/a.test.ts'], decl, []);
  check('単一のスタック: 旧い構成(node のアダプタ1つ)はそのまま通る', Object.keys(single.uncovered).length === 0);
  const outside = matchStacks(['services/api/pyproject.toml', 'services/api/app.py', 'tools/gen.py'], declaredStacks(PY_API).declared, []);
  check('作業の場所: 宣言した場所の外の同じスタックは宣言の外', outside.uncovered.python?.map((x) => x.path).join() === 'tools/gen.py', JSON.stringify(outside.uncovered));
  // アダプタの外の言語(none の経路)
  const rust = ['Cargo.toml', 'src/main.rs'];
  check('none の経路: rust を手書きの要素で宣言すれば通る', Object.keys(matchStacks(rust, declaredStacks(NONE([{ stack: 'rust', path: '.' }])).declared, []).uncovered).length === 0);
  check('none の経路: 手書きの要素(stacks)が無ければ rust は失敗', Object.keys(matchStacks(rust, declaredStacks(NONE([])).declared, []).uncovered).join() === 'rust');
}

// ---------------------------------------------------------------- 4. 除外
{
  const decl = declaredStacks(NODE).declared;
  const parse = (x) => parseStackExclusions(EXCL(x), { config: CONFIG, declared: decl });
  // IMPL-0477:ok(違反と適合の対。標準の実装マーク。process-compass #363)
  const ok = parse(OK_EX);
  check('除外: パス・区分 non-product・理由・人の記名があれば受ける', ok.problems.length === 0 && ok.exclusions.length === 1, ok.problems.join('\n'));
  const r = matchStacks(['package.json', 'src/a.ts', 'tools/gen.py', 'tools/requirements.txt'], decl, ok.exclusions);
  check('除外: 除外したパスの下のスタックは突き合わせから外れ、件数を数える', Object.keys(r.uncovered).length === 0 && r.excludedHits.tools === 2, JSON.stringify(r));
  // IMPL-0477:ng(違反と適合の対。標準の実装マーク。process-compass #363)
  check('除外: 記名の欠けを受けない', parse({ ...OK_EX, decidedBy: '' }).problems.some((p) => /記名\(decidedBy\)が未記入/.test(p)));
  check('除外: AI の名義の記名を受けない', parse({ ...OK_EX, decidedBy: 'Claude' }).problems.some((p) => /AI の名義/.test(p)), parse({ ...OK_EX, decidedBy: 'Claude' }).problems.join('\n'));
  // 記名は nameProblems で確かめる(突合 X3-2): 担い手の識別と同じ文字列、名簿にない名前を受けない
  const withSeat = { ...CONFIG, seats: [{ id: 'dev', performer: { account: 'pitcrew-dev' } }] };
  const perf = parseStackExclusions(EXCL({ ...OK_EX, decidedBy: 'pitcrew-dev' }), { config: withSeat, declared: decl });
  check('除外: 担い手の識別(performer)と同じ文字列の記名を受けない', perf.problems.some((p) => /担い手の識別/.test(p)) && perf.exclusions.length === 0, perf.problems.join('\n'));
  const off = parse({ ...OK_EX, decidedBy: '佐藤 次郎' });
  check('除外: 名簿(people[])にない名前の記名を受けない', off.problems.some((p) => /名簿/.test(p)) && off.exclusions.length === 0, off.problems.join('\n'));
  check('除外: 理由の欠けを受けない', parse({ ...OK_EX, reason: '' }).problems.some((p) => /理由/.test(p)));
  check('除外: 区分は non-product だけ(製品のスタックの除外の区分は無い)', parse({ ...OK_EX, category: 'product' }).problems.some((p) => /区分/.test(p)));
  check('除外: ワイルドカード(拡張子の単位 = スタックの単位)を受けない', parse({ ...OK_EX, path: '**/*.py' }).problems.some((p) => /ワイルドカード/.test(p)));
  check('除外: 直下の全体を受けない', parse({ ...OK_EX, path: '.' }).problems.some((p) => /全体/.test(p)));
  check('除外: 直下の外を受けない', parse({ ...OK_EX, path: '../x' }).problems.some((p) => /直下の外/.test(p)));
  const covering = parseStackExclusions(EXCL({ ...OK_EX, path: 'services' }), { config: CONFIG, declared: declaredStacks(PY_API).declared });
  check('除外: 宣言した作業の場所を覆う除外を受けない(製品のスタックは除外できない)', covering.problems.some((p) => /宣言した作業の場所/.test(p)), covering.problems.join('\n'));
  check('除外: 受けなかった除外は効かない(突き合わせに使わない)', parse({ ...OK_EX, decidedBy: '' }).exclusions.length === 0);
  check('除外: 一覧が JSON として読めなければ失敗', parseStackExclusions('{', { config: CONFIG }).problems.length === 1);
  check('除外: 除外は秘匿情報の検査(基準7)に効かない(secretScan は所在・除外に依らず直下で全体を検査する)', ALWAYS_PHASES.has('secretScan'));
}

// ---------------------------------------------------------------- 5. リポジトリの上での突き合わせ(stackCoverageReport)
const dirs = [];
function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-stacks-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  return dir;
}
{
  const base = { 'package.json': '{}', 'src/index.ts': 'export {}\n', 'scripts/gate/x.mjs': '//\n', 'docs/a.md': '# a\n', 'services/api/pyproject.toml': '[project]\nname="api"\n', 'services/api/app.py': 'x = 1\n' };
  let r = stackCoverageReport(CONFIG, NODE, repo(base));
  check('リポジトリ: 混在(node + services/api の python)は失敗、強制層の .mjs は数えない', r.problems.length === 1 && /スタック python/.test(r.problems[0]) && !r.problems.some((p) => /スタック node/.test(p)), r.problems.join('\n'));
  r = stackCoverageReport(CONFIG, NODE, repo({ ...base, [STACK_EXCLUSIONS_FILE]: EXCL({ ...OK_EX, path: 'services/api' }) }));
  check('リポジトリ: services/api を製品でないとして除外すれば通り、除外の件数を注記に出す', r.problems.length === 0 && r.notes.some((n) => /services\/api: 2 件/.test(n)), [...r.problems, ...r.notes].join('\n'));
  r = stackCoverageReport(CONFIG, NODE, repo({ ...base, [STACK_EXCLUSIONS_FILE]: EXCL({ ...OK_EX, path: 'services/api', decidedBy: '' }) }));
  check('リポジトリ: 記名の無い除外では、除外の不備と宣言の外のスタックの両方で失敗', r.problems.some((p) => /記名/.test(p)) && r.problems.some((p) => /基準1 未充足/.test(p)), r.problems.join('\n'));
  r = stackCoverageReport(CONFIG, NONE([{ stack: 'node', path: '.' }, { stack: 'python', path: 'services/api' }]), repo(base));
  check('リポジトリ: none の手書きの要素で両方を宣言すれば通る', r.problems.length === 0, r.problems.join('\n'));
  r = stackCoverageReport(CONFIG, NODE, repo({ ...base, [STACK_EXCLUSIONS_FILE]: EXCL([{ ...OK_EX, path: 'services/api' }, { ...OK_EX, path: 'unused' }]) }));
  check('リポジトリ: 当たらない除外は注記に出す', r.notes.some((n) => /unused/.test(n) && /効いていない/.test(n)), r.notes.join('\n'));
}

// ---------------------------------------------------------------- 6. 手書きの要素のカバレッジ(基準3。突合 X3-1)
// none の経路で通る混在のリポジトリでも、基準3 は未実施のまま通さない。要素ごとに集計ファイルを読み、要素ごとに比べる(合算しない)
{
  const SUM = (pct, total = 10) => JSON.stringify({ total: { lines: { pct, total, covered: Math.round((pct * total) / 100) } } });
  const PYSUM = (pct, n = 10) => JSON.stringify({ totals: { percent_covered: pct, num_statements: n } });
  const root = repo({ 'coverage/coverage-summary.json': SUM(95), 'services/api/coverage.json': PYSUM(90), 'services/api/low.json': PYSUM(50) });
  const run = (stacks) => evaluateHandwrittenStacks({ root, adapter: NONE(stacks), threshold: 80 });
  // IMPL-0476:ng(違反と適合の対。標準の実装マーク。process-compass #363 の突合 X3-1)
  let r = run([{ stack: 'node', path: '.' }, { stack: 'python', path: 'services/api' }]);
  check('手書きの要素: カバレッジを報告しない要素があれば、基準3 の未実施として失敗', r.code === 1 && r.result.perStack.every((s) => !s.measured) && r.result.ok === false, JSON.stringify(r.result));
  r = run([{ stack: 'node', path: '.', coverageSummary: 'coverage/coverage-summary.json' }, { stack: 'python', path: 'services/api' }]);
  const viaEval = evaluateCoverage({ root, config: { ci: { coverageThreshold: 80, coverageScope: 'whole' } }, adapter: NONE([{ stack: 'node', path: '.' }, { stack: 'python', path: 'services/api' }]) });
  check('手書きの要素: カバレッジの判定(evaluateCoverage)も、none の coverageSummary が null のまま通さない', viaEval.code === 1 && Array.isArray(viaEval.result.perStack), JSON.stringify(viaEval.result));
  check('手書きの要素: 一部の要素だけが報告しても、報告しない要素で失敗', r.code === 1 && r.result.perStack[0].ok === true && r.result.perStack[1].measured === false, JSON.stringify(r.result));
  // IMPL-0476:ok(違反と適合の対。標準の実装マーク。process-compass #363 の突合 X3-1)
  r = run([{ stack: 'node', path: '.', coverageSummary: 'coverage/coverage-summary.json' }, { stack: 'python', path: 'services/api', coverageSummary: 'coverage.json' }]);
  check('手書きの要素: 要素ごとに集計ファイルを報告し、どれも基準値以上なら通る(istanbul・pytest-cov の形)', r.code === 0 && r.result.ok && r.result.pct === 90, JSON.stringify(r.result));
  r = run([{ stack: 'node', path: '.', coverageSummary: 'coverage/coverage-summary.json' }, { stack: 'python', path: 'services/api', coverageSummary: 'low.json' }]);
  check('手書きの要素: 合算しない(95% と 50% の組は、50% の要素で失敗)', r.code === 1 && r.result.perStack[1].ok === false, JSON.stringify(r.result));
  r = run([{ stack: 'python', path: 'services/api', coverageSummary: 'missing.json' }]);
  check('手書きの要素: 書いた集計ファイルが無ければ失敗', r.code === 1 && r.result.perStack[0].reason === '集計ファイルが無い', JSON.stringify(r.result));
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`スタックの突き合わせの試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`スタックの突き合わせの試験: ${checks} 件すべて期待と一致しました`);
