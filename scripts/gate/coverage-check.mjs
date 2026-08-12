// カバレッジの下限を検査する(G-5 基準3)。
//
//   node scripts/gate/coverage-check.mjs
//
// アダプタの coverageSummary が指すファイルを読み、process.config.json の下限と比べます。
// coverageSummary が null の場合、判定を実施しない扱いとして記録します(通過させます)。
// 「検査していない」ことと「基準を満たした」ことを、記録の上で区別するためです。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadAdapter, ROOT, fail, notice, warn, hasTarget } from './config.mjs';

const config = loadConfig();
const adapter = loadAdapter(config);
const threshold = config.ci?.coverageThreshold ?? 80;

if (!hasTarget(adapter)) {
  notice(`カバレッジ判定: 対象プロジェクトが見つかりません。未実施として記録します`);
  writeResult({ measured: false, reason: 'No target project found' });
  process.exit(0);
}

const rel = adapter.coverageSummary;
if (!rel) {
  warn(`アダプタ ${adapter.id} はカバレッジの集計ファイルを持ちません。判定を実施しない扱いで記録します`);
  writeResult({ measured: false, reason: 'coverageSummary が null' });
  process.exit(0);
}

const p = path.join(ROOT, rel);
if (!fs.existsSync(p)) {
  fail(`カバレッジの集計ファイルがありません: ${rel}。テストの実行設定を確認してください`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
let pct = null;

// istanbul(coverage-summary.json)形式
if (raw.total?.lines?.pct !== undefined) pct = raw.total.lines.pct;
// pytest-cov(coverage.json)形式
else if (raw.totals?.percent_covered !== undefined) pct = raw.totals.percent_covered;

if (pct === null) {
  fail(`${rel} からカバレッジを読み取れません。istanbul 形式または pytest-cov 形式に対応しています`);
  process.exit(1);
}

const ok = pct >= threshold;
writeResult({ measured: true, pct, threshold, ok });

if (!ok) {
  fail(`カバレッジ ${pct}% が下限 ${threshold}% を下回っています`);
  process.exit(1);
}
notice(`カバレッジ ${pct}%(下限 ${threshold}%)`);

function writeResult(o) {
  const dir = path.join(ROOT, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'coverage-result.json'), JSON.stringify(o, null, 2) + '\n', 'utf8');
}
