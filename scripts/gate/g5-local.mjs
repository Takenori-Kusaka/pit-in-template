// G-5 の検査を、手元で CI(.github/workflows/gate-g5.yml)と同じ範囲で実行する(#286)。
//
//   node scripts/gate/g5-local.mjs [--base <比較の起点。例: origin/main>] [--pr <PR の JSON>] [--no-install]
//
// 実行するもの(gate-g5.yml のジョブと同じコマンド):
//   contract        verify-gate-contract(--base を渡せば基底の構成と比べる)・test-check-delegation・test-check-pr・test-init-g5
//   spec-lint       spec-lint(引数なし。CI と同じ範囲 = 機能仕様の置き場)
//   構成が設定済みの場合だけ:
//   test            アダプタの install → test → coverage → coverage-check
//   static-analysis アダプタの lint → audit
//   ip-clearance    アダプタの licenses
//   secret-scan     アダプタの secretScan(CI と同じく、依存の取得を前提にしない)
//   pr-rules        --base を渡した場合だけ check-pr(PR の題名・本文は --pr の JSON か、環境変数 PR_*)
//
// 実行しないもの: dependency-diff(合否を判定しない)。--base が無い場合の pr-rules(出力に「実施しない」と出す)。
// 手元の結果は CI の結果の代わりにならない。マージを止めるのは CI の必須チェック gate-g5 である。
//
// --no-install は依存の取得を省く(取得済みの依存で繰り返し確かめる場合)。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

const argv = process.argv.slice(2);
const arg = (k) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null);
const base = arg('--base');
const prFile = arg('--pr');
const noInstall = argv.includes('--no-install');

const node = (script, ...args) => [process.execPath, [path.join(ROOT, 'scripts/gate', script), ...args]];
const results = [];

function run(job, label, [cmd, args], { skip = null } = {}) {
  if (skip) {
    results.push({ job, label, status: 'skip', why: skip });
    console.log(`\n--- ${job} / ${label}: 実施しない(${skip})`);
    return false;
  }
  console.log(`\n--- ${job} / ${label}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, GITHUB_BASE_REF: '' } });
  const ok = r.status === 0;
  results.push({ job, label, status: ok ? 'pass' : 'fail' });
  return ok;
}

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, 'process.config.json'), 'utf8'));
} catch (e) {
  console.error(`process.config.json を読めません(${e.message.split('\n')[0]})`);
  process.exit(2);
}
const configured = config.configured !== false;

// --- contract ---
run('contract', 'verify-gate-contract', node('verify-gate-contract.mjs', ...(base ? ['--base', base] : [])));
run('contract', 'test-check-delegation', node('test-check-delegation.mjs'));
run('contract', 'test-check-pr', node('test-check-pr.mjs'));
run('contract', 'test-init-g5', node('test-init-g5.mjs'));

// --- spec-lint ---
run('spec-lint', 'spec-lint', node('spec-lint.mjs'));

// --- 構成に依存する検査 ---
const notConfigured = configured ? null : 'プロセス構成が未設定。CI も実施しない';
const adapter = (phase) => node('adapter.mjs', 'run', phase);
let installFailed = null;
if (!notConfigured && !noInstall) {
  // node でロックファイルが無いと、CI の npm ci は失敗する。原因を先に出す
  const stack = config.adapters?.stack;
  if (stack === 'node' && fs.existsSync(path.join(ROOT, 'package.json')) && !['package-lock.json', 'npm-shrinkwrap.json'].some((f) => fs.existsSync(path.join(ROOT, f)))) {
    results.push({ job: 'test', label: 'install', status: 'fail', why: 'package-lock.json が無い' });
    console.log('\n--- test / install: package-lock.json がありません。CI の `npm ci` はロックファイルを要します。`npm install` で作り、基盤のファイルと同じ PR に含めてください');
    installFailed = '依存の取得が失敗した。CI でも各ジョブの準備で失敗する';
  } else if (!run('test', 'install', adapter('install'))) {
    installFailed = '依存の取得が失敗した。CI でも各ジョブの準備で失敗する';
  }
}
const needsDeps = notConfigured ?? installFailed;
run('test', 'test', adapter('test'), { skip: needsDeps });
run('test', 'coverage', adapter('coverage'), { skip: needsDeps });
run('test', 'coverage-check', node('coverage-check.mjs'), { skip: needsDeps });
run('static-analysis', 'lint', adapter('lint'), { skip: needsDeps });
run('static-analysis', 'audit', adapter('audit'), { skip: needsDeps });
run('ip-clearance', 'licenses', adapter('licenses'), { skip: needsDeps });
run('secret-scan', 'secretScan', adapter('secretScan'), { skip: notConfigured });

// --- pr-rules ---
run('pr-rules', 'check-pr', node('check-pr.mjs', '--base', base ?? '', ...(prFile ? ['--pr', prFile] : [])), {
  skip: !configured ? notConfigured : !base ? '--base が無い。PR の検査は、比較の起点(例: --base origin/main)と PR の本文(--pr)を渡すと実施する' : null,
});

// --- 突合 ---
console.log('\n## G-5 の手元の検査(CI と同じ範囲。マージを止めるのは CI の gate-g5)\n');
console.log('| ジョブ | 検査 | 結果 |');
console.log('| --- | --- | --- |');
const LABEL = { pass: '通過', fail: '失敗', skip: '実施しない' };
for (const r of results) console.log(`| ${r.job} | ${r.label} | ${LABEL[r.status]}${r.why ? `(${r.why})` : ''} |`);
const failed = results.filter((r) => r.status === 'fail');
// 依存の取得の失敗で実施しなかった検査は、CI では失敗になる
const blocked = results.filter((r) => r.status === 'skip' && r.why === installFailed && installFailed);
console.log('');
if (failed.length || blocked.length) {
  console.log(`G-5 は通過しません: 失敗 ${failed.length} 件${blocked.length ? `、依存の取得の失敗で実施できない検査 ${blocked.length} 件` : ''}`);
  process.exit(1);
}
console.log(`G-5 の手元の検査を通過しました(実施しない ${results.filter((r) => r.status === 'skip').length} 件。理由は表のとおり)`);
