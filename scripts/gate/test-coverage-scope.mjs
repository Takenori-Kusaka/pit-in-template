// カバレッジの測る範囲(G-5 基準3)の試験(process-compass #296)。
//
//   node scripts/gate/test-coverage-scope.mjs
//
// 一時のリポジトリに、基底のコミットと変更のコミットを作り、istanbul 形式の被覆の記録(coverage-final.json と
// coverage-summary.json)を置いて、coverage-check の判定を呼びます。GitHub へ問い合わせません。
// 固定する決定:
//   - 新しく生成する構成の既定は変更で加えた・変えた行の範囲(changed)。構成に範囲が無い既存の構成は従来どおり whole で測り、
//     既定から補った旨を出す(突合 X-4)。分母は追加行のうち実行できる行。全体の被覆で変更の未被覆を薄めない
//   - 全体(whole)で判定する場合は、薄まる旨(dilution)と、測っていない製品のファイルの数を結果に出す
//   - 変更した製品のファイルが被覆の記録に無ければ失敗させる(分母から黙って落とさない)
//   - 比較の起点を解決できなければ失敗させる。行単位の被覆を持たないアダプタで changed を選べば失敗させる
//   - 結果には範囲・分母・測っていない製品のファイルの数を書く
//   - 企画書の記録と構成の範囲の照合(briefCoverageScope)
//   - 引用符で囲まれる(ASCII 以外を含む)パスを読み、測れない拡張子の製品のファイルを測っていない数に入れる(突合 X-5)
//   - python(coverage.py の coverage json)と go(coverprofile)でも変更の範囲を測る(IMPL-0259。process-compass #360)。
//     #360 より前の「python は whole」の決定(新しく生成する構成の既定と、python で changed を選ぶと落ちること)は改めた
//   - go の全体の割合は coverage.out の文の数の割合(go tool cover -func の合計と同じ)
//   - 言語のアダプタで集計の記録が無い(coverageSummary が null・記録が出ない)なら未実施として落とす(IMPL-0495)。none・undetermined は通知して通す
//   - python の全体の割合からテストのファイル(guard.json の testPatterns)を除く(IMPL-0496)
//   - go の構文木の部分は go がある場合に実際に流す。無ければ「未確認」と出す(失敗に数えない)

import { execFileSync, spawnSync } from 'node:child_process';
import { diffConfig } from '../init/generate-profile.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateCoverage,
  parseAddedLines,
  lineHits,
  briefCoverageScope,
  coverageScopeOf,
  changedScopeCoverage,
  derivedCoverageScope,
  unquoteGitPath,
  briefScopeRowState,
  readCoveragePy,
  parseCoverprofile,
  coverprofileTotals,
  goModulePath,
  goProfilePath,
  goLineHits,
  coverageFormatOf,
} from './coverage-check.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

const NODE = { id: 'node', coverageSummary: 'coverage/coverage-summary.json', coverageDetail: 'coverage/coverage-final.json', thresholdFiles: [] };
// python・go は実際のアダプタのファイルを読む(アダプタの形式と行単位の被覆の置き場の結線を確かめる)
const TPL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readAdapter = (id) => JSON.parse(fs.readFileSync(path.join(TPL, 'adapters', `${id}.json`), 'utf8'));
const PY = readAdapter('python');
const GO = readAdapter('go');
/** #360 より前の形(行単位の被覆を持たない)の手書きのアダプタ */
const LEGACY = { id: 'custom', coverageSummary: 'coverage.json', coverageDetail: null, thresholdFiles: [] };
const GUARD = JSON.stringify({ testPatterns: ['**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/*.test.*', '**/*.spec.*', '**/*_test.go', '**/test_*.py', '**/*_test.py', '**/conftest.py'] });

// ---------------------------------------------------------------- 純関数
{
  const diff = ['diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,0 +2,3 @@', '+x', '+y', '+z', '@@ -9 +12 @@', '-old', '+new', 'diff --git a/src/gone.js b/src/gone.js', '--- a/src/gone.js', '+++ /dev/null', '@@ -1,2 +0,0 @@'].join('\n');
  const added = parseAddedLines(diff);
  check('差分: 追加行(2〜4 行目と 12 行目)を読み、削除だけのファイルを含めない', JSON.stringify([...added.get('src/a.js')]) === '[2,3,4,12]' && !added.has('src/gone.js'), JSON.stringify([...added]));
  const fc = { statementMap: { 0: { start: { line: 2 } }, 1: { start: { line: 2 } }, 2: { start: { line: 3 } } }, s: { 0: 0, 1: 4, 2: 0 } };
  const hits = lineHits(fc);
  check('行の実行回数: 文の開始行の最大値(istanbul と同じ)', hits.get(2) === 4 && hits.get(3) === 0 && !hits.has(4), JSON.stringify([...hits]));
  const c = changedScopeCoverage({ added, coverage: new Map([['src/a.js', fc]]), isTarget: () => true });
  check('変更の範囲: 実行できる追加行だけを分母にする(2 行中 1 行)', c.denominator === 2 && c.covered === 1 && c.pct === 50, JSON.stringify(c));
}
check('企画書: 「変更で加えた・変えたコード」は changed', briefCoverageScope('| カバレッジの測る範囲(G-5 基準3) | 変更で加えた・変えたコード |\n')?.scope === 'changed');
check('企画書: 「全体」は whole', briefCoverageScope('| **カバレッジの測る範囲(G-5 基準3)** | 全体 |\n')?.scope === 'whole');
check('企画書: 様式の説明のまま(<…>)は未記入', briefCoverageScope('| カバレッジの測る範囲(G-5 基準3) | <変更で加えた・変えたコード / 全体 のいずれか> |\n')?.blank === true);
check('企画書: 両方を書いた記載は範囲を読み取れない', briefCoverageScope('| カバレッジの測る範囲(G-5 基準3) | 変更と全体 |\n')?.scope === null);
check('企画書: 行が無ければ null', briefCoverageScope('| 安定性指標の閾値 | 80 |\n') === null);
{
  const pass = [{ gate: 'G-1 企画承認', result: '通過' }];
  check('企画書の範囲の行: G-1 を通過済みの企画書に無ければ欠落(遡って失敗させない)', briefScopeRowState('| 安定性指標の閾値 | 80 |\n', pass) === 'gap');
  check('企画書の範囲の行: G-1 を通過する前の企画書に無ければ必須(失敗させる)', briefScopeRowState('| 安定性指標の閾値 | 80 |\n', [{ gate: 'G-1', result: '差し戻し' }]) === 'required');
  check('企画書の範囲の行: 行があれば扱わない。G-10 の類を G-1 と読まない', briefScopeRowState('| カバレッジの測る範囲(G-5 基準3) | 全体 |\n', pass) === null && briefScopeRowState('x', [{ gate: 'G-10', result: '通過' }]) === 'required');
  const scopeLoosens = (b, a) => diffConfig({ configured: true, gates: {}, ci: b }, { configured: true, gates: {}, ci: a }).loosenItems.some((x) => /カバレッジの測る範囲/.test(x.line));
  check('範囲の変更の向き: 値の無い構成(実効 whole)から whole を書くのは緩める向きでない', !scopeLoosens({}, { coverageScope: 'whole' }));
  check('範囲の変更の向き: changed から値を消す(実効 whole)のは緩める向き(記名を要する)', scopeLoosens({ coverageScope: 'changed' }, {}));
  check('範囲の変更の向き: changed → whole は緩める向き', scopeLoosens({ coverageScope: 'changed' }, { coverageScope: 'whole' }));
}
check('構成に範囲が無ければ、従来どおり whole で測り、既定から補ったと記録する(既存の構成を壊さない)', coverageScopeOf({ ci: {} }, NODE).scope === 'whole' && coverageScopeOf({ ci: {} }, NODE).defaulted === true && !coverageScopeOf({ ci: {} }, NODE).declared);
// #360 で改めた決定: python・go も行単位の被覆を持つため、新しく生成する構成の既定は changed。行単位の被覆を持たないアダプタだけ whole
check(
  '新しく生成する構成の既定: node・python(3つ)・go は changed、行単位の被覆を持たないアダプタは whole',
  derivedCoverageScope(NODE) === 'changed' &&
    ['python', 'python-poetry', 'python-uv'].every((id) => derivedCoverageScope(readAdapter(id)) === 'changed' && coverageFormatOf(readAdapter(id)) === 'coverage-py') &&
    derivedCoverageScope(GO) === 'changed' &&
    coverageFormatOf(GO) === 'go-coverprofile' &&
    derivedCoverageScope(LEGACY) === 'whole'
);
check('アダプタの形式: coverageFormat が無ければ istanbul、未知の値は null', coverageFormatOf(NODE) === 'istanbul' && coverageFormatOf({ coverageFormat: 'lcov' }) === null);
check('go のアダプタ: 誤った note(ワークフロー側の go tool cover の出力で行う)を持たず、coverage.out を集計の記録にする', GO.coverageSummary === 'coverage.out' && GO.coverageDetail === 'coverage.out' && !/ワークフロー側/.test(GO.note));
check('差分: 引用符で囲まれた ASCII 以外のパスを戻す', unquoteGitPath('"b/src/\\346\\227\\245\\346\\234\\254.js"') === 'b/src/日本.js' && [...parseAddedLines('+++ "b/src/\\346\\227\\245.js"\n@@ -0,0 +1,2 @@\n').keys()][0] === 'src/日.js');

// ---------------------------------------------------------------- 一時のリポジトリ
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-coverage-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'tester');
// 既存のコード 100 行(よく被覆されている)
write('src/old.js', Array.from({ length: 100 }, (_, i) => `const a${i} = ${i};`).join('\n') + '\n');
write('.gitignore', 'coverage/\nevidence/\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
git('switch', '-q', '-c', 'feature');
// 変更: 新しいファイル 10 行(被覆なし)
write('src/new.js', Array.from({ length: 10 }, (_, i) => `const b${i} = ${i};`).join('\n') + '\n');
git('add', '-A');
git('commit', '-q', '-m', 'feat');

const stmts = (file, lines, hitFn) => ({
  path: path.join(dir, file),
  statementMap: Object.fromEntries(Array.from({ length: lines }, (_, i) => [i, { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 10 } }])),
  s: Object.fromEntries(Array.from({ length: lines }, (_, i) => [i, hitFn(i + 1)])),
});
const writeCoverage = (files, summaryPct, total) => {
  write('coverage/coverage-final.json', JSON.stringify(Object.fromEntries(files.map((f) => [f.path, f]))));
  write('coverage/coverage-summary.json', JSON.stringify({ total: { lines: { total, covered: Math.round((total * summaryPct) / 100), pct: summaryPct } } }));
};
const cfg = (ci) => ({ ci: { coverageThreshold: 80, ...ci } });

// 既存 100 行は全行被覆、新しい 10 行は未被覆 → 全体は 100/110 = 90.9%、変更の範囲は 0%
writeCoverage([stmts('src/old.js', 100, () => 1), stmts('src/new.js', 10, () => 0)], 90.91, 110);
let r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'changed' }), adapter: NODE, base: 'main' });
// IMPL-0245:ng(違反と適合の対。標準の実装マーク。process-compass #314)
check('changed: 全体が 90.9% でも、変更の範囲が 0%(分母 10 行)なら落とす', r.code === 1 && r.result.scope === 'changed' && r.result.denominator === 10 && r.result.pct === 0, JSON.stringify(r.result));
check('changed: 結果に範囲・分母・測っていない製品のファイルの数を書く', r.result.scopeLabel === '変更で加えた・変えたコード' && r.result.unmeasuredProductFiles === 0 && r.result.whole.pct === 90.91, JSON.stringify(r.result));
const changedResult = r;
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'whole' }), adapter: NODE, base: 'main' });
// IMPL-0260:ng(違反の入力: 全体で判定し、変更の未被覆が全体の被覆で薄まる。薄まる旨・分母を結果に書く。process-compass #314)
check('whole: 全体 90.9% は通るが、変更の未被覆が薄まる旨(dilution)と分母を出す', r.code === 0 && r.result.dilution === true && r.result.denominator === 110 && r.result.scope === 'whole', JSON.stringify(r.result));
// IMPL-0260:ok(適合の入力: 変更の範囲で判定する。薄まる旨を書かない)
check('changed: 変更の範囲で判定した結果には、薄まる旨を書かない', changedResult.result.dilution !== true && !changedResult.messages.some((m) => /薄まります/.test(m.text)), JSON.stringify(changedResult.result));
check('whole: 薄まる旨を通知に出す', r.messages.some((m) => /薄まります/.test(m.text)), JSON.stringify(r.messages));

// 新しい 10 行のうち 9 行を被覆 → 90%
writeCoverage([stmts('src/old.js', 100, () => 1), stmts('src/new.js', 10, (l) => (l === 10 ? 0 : 3))], 99.09, 110);
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'changed' }), adapter: NODE, base: 'main' });
// IMPL-0245:ok(違反と適合の対。標準の実装マーク。process-compass #314)
check('changed: 変更の範囲 90%(10 行中 9 行)は基準値 80% を通る', r.code === 0 && r.result.pct === 90 && r.result.covered === 9 && r.result.ok === true, JSON.stringify(r.result));
r = evaluateCoverage({ root: dir, config: cfg({}), adapter: NODE, base: 'main' });
check('構成に範囲が無い node は従来どおり whole で測り、既定から補った旨と移行の手順(--reporter=json)を出す', r.code === 0 && r.result.scope === 'whole' && r.result.scopeDeclared === false && r.result.scopeDefaulted === true && r.messages.some((m) => /ci\.coverageScope/.test(m.text) && /--reporter=json/.test(m.text)), JSON.stringify(r.messages));

// 変更した製品のファイルが被覆の記録に無い(--include で外した)
write('lib/extra.js', 'module.exports = 1;\n');
git('add', '-A');
git('commit', '-q', '-m', 'lib');
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'changed' }), adapter: NODE, base: 'main' });
check('changed: 変更した製品のファイルが被覆の記録に無ければ落とし、数を出す(分母から黙って落とさない)', r.code === 1 && r.result.unmeasuredProductFiles === 1 && r.result.unmeasured[0] === 'lib/extra.js', JSON.stringify(r.result));
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'whole' }), adapter: NODE, base: 'main' });
check('whole: 被覆の記録に無い製品のファイルの数を出す(通過は全体の割合で決まる)', r.code === 0 && r.result.unmeasuredProductFiles === 1, JSON.stringify(r.result));
git('rm', '-q', 'lib/extra.js');
git('commit', '-q', '-m', 'drop lib');

// 起点を解決できない・アダプタが測れない・行単位の記録が無い・値が不正
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'changed' }), adapter: NODE, base: 'no-such-ref' });
check('changed: 比較の起点を解決できなければ落とす(測っていない状態を通過として残さない)', r.code === 1 && r.result.measured === false, JSON.stringify(r.result));
write('coverage.json', JSON.stringify({ totals: { num_statements: 10, percent_covered: 95 } }));
// #360 で改めた決定: python は行単位の被覆を持つ。行単位の被覆を持たないのは #360 より前の形の手書きのアダプタ
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'changed' }), adapter: LEGACY, base: 'main' });
check('changed: 行単位の被覆を持たないアダプタ(#360 より前の形)では落とし、whole へ揃える案内を出す', r.code === 1 && r.messages.some((m) => /whole/.test(m.text)), JSON.stringify(r.messages));
r = evaluateCoverage({ root: dir, config: cfg({}), adapter: LEGACY, base: 'main' });
check('構成に範囲が無い、行単位の被覆を持たないアダプタは whole で測る', r.code === 0 && r.result.scope === 'whole' && r.result.unmeasuredProductFiles === null, JSON.stringify(r.result));
r = evaluateCoverage({ root: dir, config: cfg({}), adapter: PY, base: 'main' });
check('python: files の無い coverage.json(coverage.py の形式でない)は読めないとして落とす', r.code === 1 && /files が無い/.test(r.messages.map((m) => m.text).join('\n')), JSON.stringify(r.messages));
fs.rmSync(path.join(dir, 'coverage/coverage-final.json'));
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'changed' }), adapter: NODE, base: 'main' });
check('changed: 行単位の被覆の記録が無ければ落とす', r.code === 1 && /行単位/.test(r.result.reason), JSON.stringify(r.result));
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'all' }), adapter: NODE, base: 'main' });
check('構成の範囲の値が changed / whole 以外なら落とす', r.code === 1, JSON.stringify(r.result));

// 変更が実行できる行を含まない(コメントだけ)
git('switch', '-q', 'main');
git('switch', '-q', '-c', 'comment');
write('src/old.js', fs.readFileSync(path.join(dir, 'src/old.js'), 'utf8') + '// 注記\n');
git('add', '-A');
git('commit', '-q', '-m', 'comment');
writeCoverage([stmts('src/old.js', 100, () => 1)], 100, 100);
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'changed' }), adapter: NODE, base: 'main' });
check('changed: 追加行に実行できる行が無ければ、対象なしとして記録する(分母 0)', r.code === 0 && r.result.noTarget === true && r.result.denominator === 0, JSON.stringify(r.result));

// ASCII 以外を含むパスと、アダプタが測れない拡張子の製品のファイル(突合 X-5)
git('switch', '-q', 'main');
git('switch', '-q', '-c', 'jp');
write('src/日本 語.js', Array.from({ length: 4 }, (_, i) => `const c${i} = ${i};`).join('\n') + '\n');
write('src/tool.py', 'print(1)\n');
git('add', '-A');
git('commit', '-q', '-m', 'jp');
writeCoverage([stmts('src/old.js', 100, () => 1), stmts('src/日本 語.js', 4, (l) => (l === 4 ? 0 : 1))], 99, 104);
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'changed' }), adapter: NODE, base: 'main' });
check('changed: ASCII 以外と空白を含むパスの製品のファイルを分母に入れる(4 行中 3 行)', r.result.denominator === 4 && r.result.covered === 3, JSON.stringify(r.result));
check('changed: 測れない拡張子の製品のファイル(.py)を、測っていない製品のファイルの数に入れ、警告を出す', r.result.unmeasuredProductFiles === 1 && r.result.notMeasurableFiles === 1 && r.result.unmeasured.includes('src/tool.py') && r.messages.some((m) => /測れない拡張子/.test(m.text)), JSON.stringify(r.result));
check('changed: 複数行の文の継続行が分母に入らない近似を結果に出す', /複数行/.test(r.result.approximation ?? ''), JSON.stringify(r.result));
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'whole' }), adapter: NODE, base: 'main' });
check('whole: 測れない拡張子の製品のファイルも、測っていない製品のファイルの数に入れる', r.result.unmeasuredProductFiles === 1 && r.result.notMeasurableFiles === 1, JSON.stringify(r.result));

// ---------------------------------------------------------------- 集計の記録の無い言語のアダプタ(IMPL-0495。process-compass #360)
{
  // IMPL-0495:ng(違反の入力: 言語のアダプタで集計の記録が無い。#360 より前は code 0 で通っていた)
  const noSummary = ['go', 'python', 'node'].map((id) => evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'whole' }), adapter: { id, coverageSummary: null, thresholdFiles: [] }, base: 'main' }));
  check('言語のアダプタ(go・python・node)で coverageSummary が null なら、未実施として落とす', noSummary.every((x) => x.code === 1 && x.result.measured === false && x.messages.some((m) => m.level === 'fail' && /未実施/.test(m.text))), JSON.stringify(noSummary.map((x) => x.result)));
  // IMPL-0495:ok(適合の入力: none(手書きの要素の無い場合)・undetermined は対象なしの扱いの規定どおり通知して通す)
  const passThrough = ['none', 'undetermined'].map((id) => evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'whole' }), adapter: { id, coverageSummary: null, thresholdFiles: [] }, base: 'main' }));
  check('none(手書きの要素なし)・undetermined で coverageSummary が null なら、従来どおり通知して通す', passThrough.every((x) => x.code === 0 && x.result.measured === false), JSON.stringify(passThrough.map((x) => x.result)));
}

// ---------------------------------------------------------------- python(coverage.py の coverage json。IMPL-0259・IMPL-0496)
const mkRepo = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), text);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'tester');
  g('config', 'core.autocrlf', 'false');
  return { d, g, w, commit: (m) => (g('add', '-A'), g('commit', '-q', '-m', m)) };
};
{
  const P = mkRepo('pit-in-coverage-py-');
  P.w('.claude/guard.json', GUARD);
  P.w('.gitignore', 'coverage.json\nevidence/\n');
  P.w('pkg/mod.py', 'def f(x):\n    return x + 1\n');
  P.commit('base');
  P.g('switch', '-q', '-c', 'feature');
  // 3〜11 行目を足す。文の開始行は 3・4・8・10・11(5 行目は 4 行目の文の継続)、6・7 行目は # pragma: no cover で除外
  P.w('pkg/mod.py', 'def f(x):\n    return x + 1\ndef g(x):\n    y = (x +\n         1)\n    if x:  # pragma: no cover\n        return 0\n    return y\n\ndef h():\n    return 2\n');
  P.w('tests/test_mod.py', Array.from({ length: 20 }, (_, i) => `a${i} = ${i}`).join('\n') + '\n');
  P.commit('feat');
  // キーは pytest を実行した所在(projectDir)からの相対で、区切りは OS のもの(Windows の \ を混ぜる)
  const pyJson = ({ executed, missing, branch = false, pct = 92.59 }) =>
    JSON.stringify({
      meta: { format: 3, version: '7.16.2', branch_coverage: branch },
      files: {
        'pkg\\mod.py': { executed_lines: executed, missing_lines: missing, excluded_lines: [6, 7] },
        'tests/test_mod.py': { executed_lines: Array.from({ length: 20 }, (_, i) => i + 1), missing_lines: [], excluded_lines: [] },
      },
      totals: { percent_covered: pct, num_statements: executed.length + missing.length + 20 },
    });
  P.w('coverage.json', pyJson({ executed: [1, 2, 3, 4, 8], missing: [10, 11] }));
  let q = evaluateCoverage({ root: P.d, config: cfg({ coverageScope: 'changed' }), adapter: PY, base: 'main' });
  // IMPL-0259:ng(違反の入力: python の変更の範囲が基準値を下回る。#360 より前は python で changed を選ぶと測らずに落ちていた)
  check(
    'python changed: 文の開始行(3・4・8・10・11)だけを分母にし、5 行中 3 行の 60% を落とす(継続行・除外の行は分母の外)',
    q.code === 1 && q.result.format === 'coverage-py' && q.result.denominator === 5 && q.result.covered === 3 && q.result.pct === 60 && JSON.stringify(q.result.uncovered) === JSON.stringify([{ file: 'pkg/mod.py', lines: [10, 11] }]),
    JSON.stringify(q.result)
  );
  check(
    'python changed: # pragma: no cover の除外(変更の行のうち 2 行)と branch の限界を結果の limits と通知に出す',
    q.result.excludedChangedLines === 2 && q.result.limits.some((l) => /pragma: no cover/.test(l) && /変更の行のうち 2 行/.test(l)) && q.result.limits.some((l) => /branch/.test(l)) && q.messages.some((m) => /測り方の限界/.test(m.text)),
    JSON.stringify(q.result.limits)
  );
  check('python changed: テストのファイル(tests/test_mod.py)の追加行は分母に入れない', !q.result.uncovered.some((u) => /tests\//.test(u.file)) && q.result.denominator === 5, JSON.stringify(q.result));
  P.w('coverage.json', pyJson({ executed: [1, 2, 3, 4, 8, 10, 11], missing: [] }));
  q = evaluateCoverage({ root: P.d, config: cfg({ coverageScope: 'changed' }), adapter: PY, base: 'main' });
  // IMPL-0259:ok(適合の入力: python の変更の範囲を測り、基準値以上なら通す)
  check('python changed: 変更の文をすべて被覆すれば通す(5 行中 5 行)', q.code === 0 && q.result.pct === 100 && q.result.denominator === 5, JSON.stringify(q.result));

  // 全体の割合: totals.percent_covered(92.59%)はテストのファイルの 20 文で押し上げられている。製品だけなら 7 文中 5 文
  P.w('coverage.json', pyJson({ executed: [1, 2, 3, 4, 8], missing: [10, 11] }));
  q = evaluateCoverage({ root: P.d, config: cfg({ coverageScope: 'whole' }), adapter: PY, base: 'main' });
  // IMPL-0496:ng(違反の入力: テストのファイルが全体の割合を押し上げる。#360 より前は 92.59% で通っていた)
  check(
    'python whole: テストのファイルを除いて数え(7 文中 5 文 = 71.43%)、totals の 92.59% で通さない',
    q.code === 1 && q.result.pct === 71.43 && q.result.denominator === 7 && q.result.testFilesExcluded === 1 && q.result.limits.some((l) => /テストのファイル/.test(l)),
    JSON.stringify(q.result)
  );
  P.w('coverage.json', pyJson({ executed: [1, 2, 3, 4, 8, 10, 11], missing: [] }));
  q = evaluateCoverage({ root: P.d, config: cfg({ coverageScope: 'whole' }), adapter: PY, base: 'main' });
  // IMPL-0496:ok(適合の入力: 製品のファイルの文の割合が基準値以上)
  check('python whole: 製品のファイルの文の割合が基準値以上なら通し、分母は製品の文の数(7)', q.code === 0 && q.result.pct === 100 && q.result.denominator === 7, JSON.stringify(q.result));

  // branch を有効にした記録: percent_covered は文と分岐の合算(50%)。本判定は文の割合で数え、その旨を出す
  P.w('coverage.json', pyJson({ executed: [1, 2, 3, 4, 8, 10, 11], missing: [], branch: true, pct: 50 }));
  q = evaluateCoverage({ root: P.d, config: cfg({ coverageScope: 'whole' }), adapter: PY, base: 'main' });
  check('python whole: branch を有効にした記録でも文の割合で数え、分岐を判定しない旨を出す', q.code === 0 && q.result.pct === 100 && q.result.branchCoverage === true && q.result.limits.some((l) => /branch を有効にした記録/.test(l)), JSON.stringify(q.result));

  // 記録に無い製品のファイル(source を書かず、テストから import されない)
  P.w('pkg/unused.py', 'def u():\n    return 1\n');
  P.commit('unused');
  q = evaluateCoverage({ root: P.d, config: cfg({ coverageScope: 'changed' }), adapter: PY, base: 'main' });
  check('python changed: 記録に無い変更した製品のファイルは落とし、source の案内を出す', q.code === 1 && q.result.unmeasured.includes('pkg/unused.py') && q.messages.some((m) => /source/.test(m.text)), JSON.stringify(q.messages));
  q = evaluateCoverage({ root: P.d, config: cfg({ coverageScope: 'whole' }), adapter: PY, base: 'main' });
  check('python whole: 記録に無い製品のファイルの数を出す', q.result.unmeasuredProductFiles === 1, JSON.stringify(q.result));
  fs.rmSync(path.join(P.d, 'coverage.json'));
  q = evaluateCoverage({ root: P.d, config: cfg({ coverageScope: 'whole' }), adapter: PY, base: 'main' });
  // IMPL-0495:ng(違反の入力: 集計の記録が出ない)
  check('python: coverage.json が出なければ未実施として落とす', q.code === 1 && q.result.reason === '集計ファイルが無い', JSON.stringify(q.result));
  fs.rmSync(P.d, { recursive: true, force: true });

  // 所在(projectDir)が直下でない場合: キーは所在からの相対
  const py = readCoveragePy({ files: { 'api\\h.py': { executed_lines: [1], missing_lines: [2], excluded_lines: [] }, 'tests/test_h.py': { executed_lines: [1, 2, 3], missing_lines: [] } } }, { projBase: path.join(os.tmpdir(), 'r', 'svc'), root: path.join(os.tmpdir(), 'r'), isTest: (f) => /(^|\/)tests\//.test(f) });
  check('python: 記録のキーを所在からの相対として repo 相対(svc/api/h.py)へ寄せ、テストを全体から除く', py.files.has('svc/api/h.py') && py.statements === 2 && py.covered === 1 && py.pct === 50 && py.testFiles[0] === 'svc/tests/test_h.py', JSON.stringify([...py.files.keys()]));
}

// ---------------------------------------------------------------- go(coverprofile。IMPL-0259 と全体の割合)
{
  const prof = parseCoverprofile('mode: set\nexample.com/m/a.go:1.1,2.2 1 0\nexample.com/m/a.go:1.1,2.2 1 1\nexample.com/m/a.go:3.1,4.2 2 0\n');
  check('go: coverprofile の重複したブロックを1つにまとめる(mode set は最大)', prof.blocks.length === 2 && prof.blocks[0].count === 1 && coverprofileTotals(prof).pct === 33.33, JSON.stringify(prof));
  check('go: 形式でない記録は null', parseCoverprofile('not a profile') === null && parseCoverprofile('mode: set\nbroken line') === null);
  check('go: go.mod の module 行を読む(引用符・行末の注釈)', goModulePath('// c\nmodule "example.com/x" // note\n\ngo 1.23\n') === 'example.com/x' && goModulePath('go 1.23\n') === null);
  const root = path.join(os.tmpdir(), 'r');
  check(
    'go: 記録のパス(import のパス)を module 行で repo 相対へ戻し、module の外は戻さない',
    goProfilePath('example.com/x/calc/c.go', { module: 'example.com/x', projBase: path.join(root, 'svc'), root }) === 'svc/calc/c.go' && goProfilePath('other.org/y/z.go', { module: 'example.com/x', projBase: root, root }) === null
  );
  const h = goLineHits(
    [
      { sl: 1, sc: 10, el: 9, ec: 2, numStmt: 2, count: 1 },
      { sl: 3, sc: 12, el: 5, ec: 3, numStmt: 1, count: 0 },
    ],
    [
      [2, 2, 2, 9],
      [3, 2, 5, 3],
      [4, 3, 4, 9],
      [12, 1, 12, 5],
    ]
  );
  check('go: 文の開始位置を含む最も内側のブロックの回数を開始行に当て、どのブロックにも入らない文を数える', h.hits.get(2) === 1 && h.hits.get(3) === 1 && h.hits.get(4) === 0 && h.mismatched === 0 && h.unassigned === 1, JSON.stringify([...h.hits]));

  const G = mkRepo('pit-in-coverage-go-');
  G.w('.claude/guard.json', GUARD);
  G.w('.gitignore', 'coverage.out\nevidence/\n');
  G.w('go.mod', 'module example.com/demo\n\ngo 1.21\n');
  G.w('other/other.go', 'package other\n\nfunc O() int {\n\treturn 1\n}\n');
  G.commit('base');
  G.g('switch', '-q', '-c', 'feature');
  G.w(
    'calc/calc.go',
    'package calc\n\nfunc F(x int) int {\n\tif x > 0 {\n\t\ty := x +\n\t\t\t1\n\t\treturn y\n\t}\n\treturn 0\n}\n\nfunc G(a,\n\tb int) int {\n\ttotal := a + b\n\tfor i := 0; i < 3; i++ { total++ }\n\tswitch total {\n\tcase 1:\n\t\ttotal = 2\n\tdefault:\n\t\tf := func() int { return 3 }\n\t\ttotal = f()\n\t}\n\treturn total\n}\n'
  );
  G.w('calc/calc_test.go', 'package calc\n\nimport "testing"\n\nfunc TestF(t *testing.T) {\n\tif F(1) != 2 {\n\t\tt.Fatal()\n\t}\n}\n');
  G.commit('feat');
  // go 1.26 の go test -coverprofile が出した記録の写し(go tool cover -func の合計は 21.4%)
  const BLOCKS = [
    ['calc/calc.go:3.19,4.11', 1, 1],
    ['calc/calc.go:4.11,8.3', 2, 1],
    ['calc/calc.go:9.2,9.10', 1, 0],
    ['calc/calc.go:13.13,15.25', 2, 0],
    ['calc/calc.go:15.25,15.36', 1, 0],
    ['calc/calc.go:16.2,16.15', 1, 0],
    ['calc/calc.go:17.9,18.12', 1, 0],
    ['calc/calc.go:19.10,20.19', 1, 0],
    ['calc/calc.go:20.19,20.31', 1, 0],
    ['calc/calc.go:21.3,21.14', 1, 0],
    ['calc/calc.go:23.2,23.14', 1, 0],
    ['other/other.go:3.14,5.2', 1, 0],
  ];
  const profile = (countOf = (c) => c, extra = []) => 'mode: set\n' + [...BLOCKS.map(([b, n, c]) => `example.com/demo/${b} ${n} ${countOf(c)}`), ...extra].join('\n') + '\n';
  G.w('coverage.out', profile());
  let q = evaluateCoverage({ root: G.d, config: cfg({ coverageScope: 'whole' }), adapter: GO, base: 'main' });
  check('go whole: 全体の割合は文の数の割合(14 文中 3 文 = 21.43%。go tool cover -func の 21.4% と一致)し、基準値 80% を下回れば落とす', q.code === 1 && q.result.measured === true && q.result.pct === 21.43 && q.result.denominator === 14 && q.result.format === 'go-coverprofile', JSON.stringify(q.result));
  q = evaluateCoverage({ root: G.d, config: { ci: { coverageThreshold: 20, coverageScope: 'whole' } }, adapter: GO, base: 'main' });
  check('go whole: 基準値以上なら通し、測り方を limits に出す(#360 より前は測らずに通っていた)', q.code === 0 && q.result.limits.some((l) => /go tool cover -func/.test(l)) && q.result.unmeasuredProductFiles === 0, JSON.stringify(q.result));

  // go が無い・構文木を得られない場合は、構文木を使わない代替へ落とさず、測っていないとして落とす
  const saved = process.env.PIT_IN_GO;
  process.env.PIT_IN_GO = path.join(os.tmpdir(), 'no-such-go-binary');
  q = evaluateCoverage({ root: G.d, config: cfg({ coverageScope: 'changed' }), adapter: GO, base: 'main' });
  if (saved === undefined) delete process.env.PIT_IN_GO;
  else process.env.PIT_IN_GO = saved;
  check('go changed: go が無ければ構文木を使わない代替を採らず、未実施として落とす', q.code === 1 && q.result.reason === 'go の構文木を得られない', JSON.stringify(q.result));

  // 変更した製品のファイルが記録に無い(module の外のパスは戻さない)
  G.w('coverage.out', 'mode: set\nexample.com/demo/other/other.go:3.14,5.2 1 1\nelsewhere.org/x/y.go:1.1,2.2 1 1\n');
  q = evaluateCoverage({ root: G.d, config: cfg({ coverageScope: 'changed' }), adapter: GO, base: 'main' });
  check('go changed: 変更した製品のファイルが記録に無ければ落とし、module 行で戻せない記録の数を出す', q.code === 1 && q.result.unmeasured.includes('calc/calc.go') && q.result.unmappedProfileFiles === 1 && q.messages.some((m) => /go\.mod の module 行/.test(m.text)), JSON.stringify(q.result));
  fs.rmSync(path.join(G.d, 'coverage.out'));
  q = evaluateCoverage({ root: G.d, config: cfg({ coverageScope: 'whole' }), adapter: GO, base: 'main' });
  // IMPL-0495:ng(違反の入力: go で coverage.out が出ない)
  check('go: coverage.out が出なければ未実施として落とす', q.code === 1 && q.result.reason === '集計ファイルが無い', JSON.stringify(q.result));

  const goVersion = spawnSync(process.env.PIT_IN_GO ?? 'go', ['version'], { encoding: 'utf8' });
  if (goVersion.status !== 0) {
    console.log('未確認 go が無いため、構文木(scripts/gate/_go-stmt-lines)で文の開始行を得る場面を流していません(変更の範囲の go の割合)');
  } else {
    G.w('coverage.out', profile());
    q = evaluateCoverage({ root: G.d, config: cfg({ coverageScope: 'changed' }), adapter: GO, base: 'main' });
    // IMPL-0259:ng(違反の入力: go の変更の範囲が基準値を下回る。#360 より前は go の基準3 を測らずに通していた)
    check(
      'go changed: 構文木の文の開始行(11 行)を分母にし、3 行の被覆(27.27%)を落とす。継続行・シグネチャの継続・テストのファイルは分母の外',
      q.code === 1 && q.result.denominator === 11 && q.result.covered === 3 && q.result.pct === 27.27 && q.result.goBlocksMismatched === 0 && q.result.goStatementsUnassigned === 0 && /構文木/.test(q.result.approximation),
      JSON.stringify(q.result)
    );
    check('go changed: 構文木の文とブロックの対応の近似を通知に出す', q.messages.some((m) => /測り方の近似/.test(m.text) && /食い違うブロック 0 件/.test(m.text)), JSON.stringify(q.messages));
    G.w('coverage.out', profile(() => 1));
    q = evaluateCoverage({ root: G.d, config: cfg({ coverageScope: 'changed' }), adapter: GO, base: 'main' });
    // IMPL-0259:ok(適合の入力: go の変更の範囲を測り、基準値以上なら通す)
    check('go changed: 変更の文をすべて被覆すれば通す(11 行中 11 行)', q.code === 0 && q.result.pct === 100 && q.result.denominator === 11, JSON.stringify(q.result));
  }
  fs.rmSync(G.d, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`カバレッジの測る範囲の試験: ${failures} / ${n} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`カバレッジの測る範囲の試験: ${n} 件が期待と一致しました`);
