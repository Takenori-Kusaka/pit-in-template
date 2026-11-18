// 案件の登録の検査(check-g1.mjs。IMPL-0883。標準 第5章 5.7 案件の登録 手順1)の試験。
//
//   node scripts/gate/test-project-id.mjs
//
// 確かめること:
//   - 企画書の project_id が構成の projectId と違えば失敗する
//   - 案件の記録 context/projects/<案件ID>.md が無ければ、G-1 の前は失敗し、G-1 を通過済みの案件は注意にとどめる(遡って失敗させない)
// 入口(check-g1)を一時の置き場で走らせる。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-6).join('\n       ')}`}`);
}

function workspace(projectId = 'P-001') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-project-id-'));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'templates'), path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify({ configured: true, projectId }) + '\n');
  fs.mkdirSync(path.join(dir, 'docs/gates'), { recursive: true });
  const write = (rel, t) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), t);
  };
  const g1 = () => {
    const r = spawnSync(process.execPath, ['scripts/gate/check-g1.mjs'], { cwd: dir, encoding: 'utf8' });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { dir, write, g1 };
}
const form = fs.readFileSync(path.join(ROOT, 'templates/06-project-brief.md'), 'utf8');
const brief = (id) => `---\nproject_id: ${id}\nversion: 1\napprover: 承認 太郎\nstatus: draft\n---\n\n${form}`;
const PASSED = ['# ゲート判定記録', '', '| 項目 | 値 |', '| --- | --- |', '| ゲート | G-1 企画承認 |', '| 対象 | P-001 |', '| 判定者 | 判定 花子 |', '| 判定日時 | 2026-11-04 10:00 |', '| 結果 | 通過 |', ''].join('\n');

{
  const W = workspace('P-001');
  W.write('docs/project-brief.md', brief('P-002'));
  W.write('context/projects/P-001.md', '# 案件\n');
  // IMPL-0883:ng(企画書の案件 ID が構成と違う)
  let r = W.g1();
  check('IMPL-0883:ng 企画書の project_id が構成の projectId と違えば失敗する', !r.ok && /案件 ID/.test(r.out) && r.out.includes('P-002') && r.out.includes('P-001'), r.out);
  W.write('docs/project-brief.md', brief('P-001'));
  fs.rmSync(path.join(W.dir, 'context/projects/P-001.md'));
  // IMPL-0883:ng(G-1 の前で記録ファイルが無い)
  r = W.g1();
  check('IMPL-0883:ng G-1 の前に context/projects/<案件ID>.md が無ければ失敗する', !r.ok && r.out.includes('context/projects/P-001.md'), r.out);
  // IMPL-0883:ok(一致して実在する)
  W.write('context/projects/P-001.md', '# 案件\n');
  r = W.g1();
  check('IMPL-0883:ok 一致して実在すれば、案件の登録の指摘を出さない', !/案件 ID/.test(r.out) && !r.out.includes('context/projects/P-001.md'), r.out);
  // IMPL-0883:ok(G-1 を通過済みの既存の案件は、ファイルの不在を注意にとどめる)
  fs.rmSync(path.join(W.dir, 'context/projects/P-001.md'));
  W.write('docs/gates/g1.md', PASSED);
  r = W.g1();
  check('IMPL-0883:ok G-1 を通過済みの案件は、記録ファイルの不在を注意にとどめ、この指摘では失敗させない', r.out.includes('context/projects/P-001.md') && r.out.includes('遡って失敗させません'), r.out);
  W.write('docs/project-brief.md', brief('P-002'));
  r = W.g1();
  check('IMPL-0883:ng G-1 を通過済みでも、企画書の案件 ID が構成と違えば失敗する', !r.ok && /案件 ID/.test(r.out), r.out);
  fs.rmSync(W.dir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`案件の登録の試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`案件の登録の試験: ${checks} 件が期待と一致しました`);
