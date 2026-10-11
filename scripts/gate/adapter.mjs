// アダプタのコマンドを実行する。
//
//   node scripts/gate/adapter.mjs run <phase>     コマンドを実行する
//   node scripts/gate/adapter.mjs print <phase>   コマンドを表示するだけ
//   node scripts/gate/adapter.mjs runtime         セットアップに要る実行環境を JSON で出す
//
// phase: install / test / coverage / lint / audit / licenses / secretScan
//
// コマンドが空の場合は失敗させます。「検査したことにする」経路を作らないためです。

import { spawnSync } from 'node:child_process';
import { loadConfig, loadAdapter, ROOT, fail, notice, hasTarget } from './config.mjs';

const [, , mode, phase] = process.argv;
const config = loadConfig();
const adapter = loadAdapter(config);

if (mode === 'runtime') {
  process.stdout.write(
    JSON.stringify({
      stack: adapter.id,
      runtime: adapter.runtime,
      runtimeVersion: adapter.runtimeVersion,
    })
  );
  process.exit(0);
}

if (!phase) {
  console.error('使い方: node scripts/gate/adapter.mjs <run|print|runtime> [phase]');
  process.exit(2);
}

const cmd = (adapter.commands ?? {})[phase];

if (cmd === undefined) {
  fail(`アダプタ ${adapter.id} に phase "${phase}" の定義がありません`);
  process.exit(2);
}

if (!hasTarget(adapter)) {
  notice(`アダプタ ${adapter.id}: プロジェクト対象が存在しないため、"${phase}" は実施しません。この事実は証跡へ残ります`);
  process.exit(0);
}

// 任意の検査は空でも通す。必須の検査は空を許さない
const OPTIONAL = new Set(['lint', 'audit', 'licenses', 'coverage', 'install']);

if (!cmd.trim()) {
  if (OPTIONAL.has(phase)) {
    notice(`アダプタ ${adapter.id}: "${phase}" のコマンドが空のため実施しません。この事実は証跡へ残ります`);
    process.exit(0);
  }
  fail(
    `アダプタ ${adapter.id} の "${phase}" が空です。adapters/${adapter.id}.json へ実行コマンドを書いてください。` +
      '空のまま通すと、検査を実施していない状態を通過した記録として残ります'
  );
  process.exit(1);
}

if (mode === 'print') {
  process.stdout.write(cmd);
  process.exit(0);
}

// 構成 ci.failOnSeverity を、アダプタの audit コマンドへ渡す(#295 T-19)。npm audit は最小の重大度を取るため、
// 失敗させる重大度のうち最も低いものを渡す(critical・high なら high)。値が無ければ high
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, medium: 2, high: 3, critical: 4 };
const failLevels = (Array.isArray(config.ci?.failOnSeverity) ? config.ci.failOnSeverity : ['critical', 'high']).map((s) => String(s).toLowerCase()).filter((s) => s in SEVERITY_RANK);
const auditLevel = failLevels.length ? failLevels.reduce((a, b) => (SEVERITY_RANK[b] < SEVERITY_RANK[a] ? b : a)) : 'high';

const env = {
  ...process.env,
  PIT_IN_FAIL_ON_SEVERITY: failLevels.join(';'),
  PIT_IN_AUDIT_LEVEL: auditLevel === 'medium' ? 'moderate' : auditLevel,
  PIT_IN_ALLOWED_LICENSES: (config.ci?.allowedLicenses ?? []).join(';'),
  PIT_IN_COVERAGE_THRESHOLD: String(config.ci?.coverageThreshold ?? 80),
};

console.log(`$ ${cmd}`);
const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, env });
process.exit(r.status ?? 1);
