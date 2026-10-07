// G-5 のテストの実行の記録を evidence/test-results.json へ書く(#288 第2巡。標準 第4章 G-7「基準1・2 の記録」)。
//
//   node scripts/gate/test-results.mjs --outcome <success | failure | skipped>
//
// 出荷判定の証跡の集約(aggregate-evidence.mjs → verification-trace.mjs)が、G-7 基準1 の「実行して通過した数」を
// この記録から数えます。記録するのは、強制層の testPatterns に当たる追跡中のテストのファイルの一覧と、テストの
// 実行の結果(ジョブの成否)です。テストの実行の道具はスタックごとに違い、ファイルごとの結果の形を1つに定められない
// ため、結果は実行の単位(すべて通過 / 失敗あり)で記録します。失敗した実行では、どのファイルが通過したかを
// 記録しません(通過に数えない)。
//
// CI では gate-g5 の test ジョブが書いて成果物 test-results に上げ、ship-evidence が license-scan と同じ経路で
// 取り込みます。手元では g5-local.mjs がテストの後に書きます。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, notice, warn } from './config.mjs';
import { testFiles, TEST_RESULTS_FILE } from './verification-trace.mjs';

const argv = process.argv.slice(2);
const outcome = argv[argv.indexOf('--outcome') + 1] ?? null;
if (!['success', 'failure', 'skipped', 'cancelled'].includes(outcome)) {
  console.error('使い方: node scripts/gate/test-results.mjs --outcome <success | failure | skipped>');
  process.exit(2);
}

let commit = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  commit = null;
}
const files = testFiles();
const passed = outcome === 'success';
const record = {
  runAt: new Date().toISOString(),
  commit,
  outcome,
  note: passed
    ? 'テストの実行が通過した。追跡中のテストのファイルをすべて通過として記録する(実行の単位の記録。ファイルごとの結果ではない)'
    : 'テストの実行が通過していない。どのファイルが通過したかは記録せず、通過に数えない',
  tests: files.map((file) => ({ file, passed })),
};
fs.mkdirSync(path.join(ROOT, path.dirname(TEST_RESULTS_FILE)), { recursive: true });
fs.writeFileSync(path.join(ROOT, TEST_RESULTS_FILE), JSON.stringify(record, null, 2) + '\n');
if (!files.length) warn(`テストのファイル(.claude/guard.json の testPatterns に当たる追跡中のファイル)がありません。${TEST_RESULTS_FILE} は空の一覧で書きました`);
notice(`${TEST_RESULTS_FILE} を書きました(${outcome}。テストのファイル ${files.length} 件)`);
