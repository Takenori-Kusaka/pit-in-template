// 未登録の名前が依存の解決で失敗し、G-5 が落ちることを試験する(標準 ADR-0044 決定5 の前提。process-compass #455 / ADR-0261 IMPL-E)。
//
//   node scripts/gate/test-unregistered-name.mjs
//
// ネットワークを使わない。レジストリの 404 は、PATH の先頭に置いた代役の npm で再現する(npm は 404 を出して終了コード 1 で終わる)。
// 実レジストリでの確認(乱数の名前を足した package.json・package-lock.json で `npm ci` が 404・終了コード 1 になること)は、
// ADR-0261 決定1 に記録した。この試験が固定するのは、その失敗が段・ジョブ・集約の失敗として伝わる結線である:
//   アダプタ node の install が空でない → 段の失敗が終了コードで出る → 依存の取得の手順が失敗を握りつぶさない → 集約が拾う
// 守る範囲: 依存の解決が走る構成だけ。install が空の構成(ADR-0151)、アダプタ none・undetermined では解決が走らないため、捕まらない。
// 解決の成功は、名前が登録済みであることしか示さない。悪性でないことを示さない。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { aggregateFindings, jobsOf, G5_WORKFLOW } from './g5-aggregate.mjs';
import { DEFAULT_CONFIG_FILE } from './template-copy.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-6).join('\n       ')}`}`);
}

const dirs = [];
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-unreg-bin-'));
dirs.push(BIN);
// 代役の npm: レジストリの 404 を出して終了コード 1 で終わる(未登録の名前の install の挙動)。FAKE_NPM=ok なら成功する
fs.writeFileSync(path.join(BIN, 'npm'), '#!/bin/sh\nif [ "$FAKE_NPM" = "ok" ]; then exit 0; fi\necho "npm error 404 The requested resource could not be found" >&2\nexit 1\n');
fs.chmodSync(path.join(BIN, 'npm'), 0o755);
fs.writeFileSync(path.join(BIN, 'npm.cmd'), '@echo off\r\nif "%FAKE_NPM%"=="ok" exit /b 0\r\necho npm error 404 The requested resource could not be found 1>&2\r\nexit /b 1\r\n');

function workspace(stack) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pit-in-unreg-${stack}-`));
  dirs.push(dir);
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'adapters'), path.join(dir, 'adapters'), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8'));
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify({ ...cfg, adapters: { ...(cfg.adapters ?? {}), stack } }, null, 2));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', dependencies: { 'zz-not-registered-0000': '^1.0.0' } }));
  return (env = {}) => {
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts/gate/adapter.mjs'), 'run', 'install'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, ...env },
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
}

// ---------------------------------------------------------------- 1. アダプタ node: install の失敗が段の失敗になる
{
  const adapter = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters/node.json'), 'utf8'));
  check('アダプタ node の install は空でなく、npm ci である(解決が走る構成)', adapter.commands.install === 'npm ci', adapter.commands.install);
  const run = workspace('node');
  // IMPL-E:ng(違反と適合の対。未登録の名前を足した構成で、依存の取得の段が失敗する)
  const ng = run();
  check('未登録の名前(レジストリが 404)で、install の段は 0 以外の終了コードで終わる', ng.code !== 0 && /404/.test(ng.out), ng.out);
  // IMPL-E:ok
  const ok = run({ FAKE_NPM: 'ok' });
  check('名前が解決できる構成では、install の段は通る(対の確認)', ok.code === 0, ok.out);
}

// ---------------------------------------------------------------- 2. 解決が走らない構成は、捕まらないことを固定する(開示の根拠)
for (const stack of ['none', 'undetermined']) {
  const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', `${stack}.json`), 'utf8'));
  check(`アダプタ ${stack}: install が空で依存の解決が走らない(未登録の名前は G-5 で捕まらない。一覧の「依存の解決」の状態行に出る)`, !String(a.commands.install ?? '').trim(), String(a.commands.install));
}

// ---------------------------------------------------------------- 3. 段の失敗が集約の失敗になる結線(ワークフローの定義)
{
  const stack = fs.readFileSync(path.join(ROOT, '.github/actions/setup-stack/action.yml'), 'utf8');
  const step = stack.split('- name: 依存関係の取得')[1] ?? '';
  check('setup-stack の依存の取得は、失敗を握りつぶさない(continue-on-error も || true も無い)', /run: node scripts\/gate\/adapter\.mjs run install/.test(step) && !/continue-on-error|\|\|\s*true/.test(step), step);
  const wf = fs.readFileSync(path.join(ROOT, G5_WORKFLOW), 'utf8');
  const jobs = jobsOf(wf);
  for (const job of ['test', 'static-analysis', 'ip-clearance']) {
    const body = jobs.get(job) ?? '';
    check(`gate-g5.yml: ジョブ ${job} は依存の取得(setup-stack)を含み、失敗を許さない`, /uses: \.\/\.github\/actions\/setup-stack/.test(body) && !/continue-on-error/.test(body), body.slice(0, 200));
  }
  check('gate-g5.yml: 集約は failure・cancelled を落とし、success でなければ失敗にする(段の失敗が G-5 の失敗になる)', /contains\(needs\.\*\.result, 'failure'\)/.test(wf) && /\[ "\$res" = "success" \] && continue/.test(wf));
  check('gate-g5.yml: 集約が基準のジョブの結果を使っている(不備なし)', aggregateFindings(wf).problems.length === 0, JSON.stringify(aggregateFindings(wf).problems));
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`未登録の名前の試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`未登録の名前の試験: ${checks} 件が期待と一致しました`);
