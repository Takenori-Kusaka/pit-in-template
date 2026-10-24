// 曖昧語の検査(spec-lint.mjs)の、検出語の知識ベースの読み込みの試験(process-compass #314)。
//
//   node scripts/gate/test-spec-lint.mjs
//
// 固定する決定(標準 第4章 G-2 の検出語。知識ベースへ複製したもの。減らさない):
//   - 知識ベース(scripts/vendor/tailoring-kb.json)が無ければ、読み込みで失敗する(IMPL-0227:ng)
//   - 検出語(ambiguousTerms)が空なら失敗する(IMPL-0227:ng)
//   - 検出語があれば読み込みは通り、語を出す。検査の対象が無いときだけ、対象なしとして通知して通る(IMPL-0227:ok)
// scripts/ を一時の置き場へ写して実行します。リポジトリの状態を変えません。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
}

const KB = 'scripts/vendor/tailoring-kb.json';
const original = fs.readFileSync(path.join(ROOT, KB), 'utf8');

function workspace(kbText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-lint-'));
  fs.cpSync(path.join(ROOT, 'scripts', 'gate'), path.join(dir, 'scripts', 'gate'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts', 'vendor'), { recursive: true });
  if (kbText !== null) fs.writeFileSync(path.join(dir, KB), kbText);
  const run = (...a) => {
    const r = spawnSync(process.execPath, ['scripts/gate/spec-lint.mjs', ...a], { cwd: dir, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { run, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

{
  const w = workspace(null);
  const r = w.run('--terms');
  // IMPL-0227:ng(違反の入力: 知識ベースが無い。標準の実装マーク)
  check('知識ベースが無ければ、読み込みで失敗する', r.code !== 0, r.out.slice(0, 400));
  w.done();
}
{
  const kb = JSON.parse(original);
  kb.ambiguousTerms = [];
  const w = workspace(JSON.stringify(kb));
  const r = w.run('--terms');
  // IMPL-0227:ng(違反の入力: 検出語が空)
  check('検出語が空なら失敗し、知識ベースの複製し直しを求める', r.code === 1 && /ambiguousTerms/.test(r.out), r.out.slice(0, 400));
  w.done();
}
{
  const w = workspace(original);
  const r = w.run('--terms');
  const first = JSON.parse(original).ambiguousTerms?.[0]?.term;
  // IMPL-0227:ok(適合の入力: 標準から複製した知識ベース)
  check('検出語があれば読み込みは通り、語を出す', r.code === 0 && Boolean(first) && r.out.includes(first), r.out.slice(0, 400));
  const none = w.run();
  // IMPL-0227:ok(適合の入力: 検査の対象の機能仕様が無い。対象なしとして通知して通る)
  check('検査の対象が無いときは、対象なしとして通知して通る', none.code === 0 && /::notice::/.test(none.out), none.out.slice(0, 400));
  w.done();
}

if (failures) {
  console.error(`\n曖昧語の検査の知識ベースの試験: ${failures} 件の失敗`);
  process.exit(1);
}
console.log('\n曖昧語の検査の知識ベースの試験: すべて通過');
