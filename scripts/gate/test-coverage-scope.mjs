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

import { execFileSync } from 'node:child_process';
import { diffConfig } from '../init/generate-profile.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateCoverage, parseAddedLines, lineHits, briefCoverageScope, coverageScopeOf, changedScopeCoverage, derivedCoverageScope, unquoteGitPath, briefScopeRowState } from './coverage-check.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

const NODE = { id: 'node', coverageSummary: 'coverage/coverage-summary.json', coverageDetail: 'coverage/coverage-final.json', thresholdFiles: [] };
const PY = { id: 'python', coverageSummary: 'coverage.json', coverageDetail: null, thresholdFiles: [] };

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
check('新しく生成する構成の既定: node は changed、python は whole', derivedCoverageScope(NODE) === 'changed' && derivedCoverageScope(PY) === 'whole');
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
// IMPL-0239:ng(違反と適合の対。標準の実装マーク。process-compass #314)
check('changed: 全体が 90.9% でも、変更の範囲が 0%(分母 10 行)なら落とす', r.code === 1 && r.result.scope === 'changed' && r.result.denominator === 10 && r.result.pct === 0, JSON.stringify(r.result));
check('changed: 結果に範囲・分母・測っていない製品のファイルの数を書く', r.result.scopeLabel === '変更で加えた・変えたコード' && r.result.unmeasuredProductFiles === 0 && r.result.whole.pct === 90.91, JSON.stringify(r.result));
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'whole' }), adapter: NODE, base: 'main' });
check('whole: 全体 90.9% は通るが、変更の未被覆が薄まる旨(dilution)と分母を出す', r.code === 0 && r.result.dilution === true && r.result.denominator === 110 && r.result.scope === 'whole', JSON.stringify(r.result));
check('whole: 薄まる旨を通知に出す', r.messages.some((m) => /薄まります/.test(m.text)), JSON.stringify(r.messages));

// 新しい 10 行のうち 9 行を被覆 → 90%
writeCoverage([stmts('src/old.js', 100, () => 1), stmts('src/new.js', 10, (l) => (l === 10 ? 0 : 3))], 99.09, 110);
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'changed' }), adapter: NODE, base: 'main' });
// IMPL-0239:ok(違反と適合の対。標準の実装マーク。process-compass #314)
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
r = evaluateCoverage({ root: dir, config: cfg({ coverageScope: 'changed' }), adapter: PY, base: 'main' });
check('changed: 行単位の被覆を持たないアダプタ(python)では落とし、whole へ揃える案内を出す', r.code === 1 && r.messages.some((m) => /whole/.test(m.text)), JSON.stringify(r.messages));
r = evaluateCoverage({ root: dir, config: cfg({}), adapter: PY, base: 'main' });
check('構成に範囲が無い python は whole で測る', r.code === 0 && r.result.scope === 'whole' && r.result.unmeasuredProductFiles === null, JSON.stringify(r.result));
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

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`カバレッジの測る範囲の試験: ${failures} / ${n} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`カバレッジの測る範囲の試験: ${n} 件が期待と一致しました`);
