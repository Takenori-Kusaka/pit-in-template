// 証跡の一式の写しと digest の一覧の試験(process-compass #333 / ADR-0135。IMPL-0521)
//
//   node scripts/gate/test-evidence-manifest.mjs
//
// 固定する決定:
//   - 一式のファイルを変える・消す・manifest に無いファイルを足すと、verify が不一致を出す(違反側)
//   - ship-evidence.yml から写しの手順・retention-days・verify の呼び出しを抜くと、workflowProblems が出す(違反側)
//   - 変えていない一式で verify が通り、今の ship-evidence.yml で workflowProblems が空(適合側)
// 写しは保管期間の充足を示さない(IMPL-0243)。ここで確かめるのは、存在・digest の一致・追加だけであること。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeManifest, verifyManifest, workflowProblems } from './evidence-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
}

function freshBundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evman-'));
  fs.writeFileSync(path.join(dir, 'evidence.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(dir, 'assurance-disclosure.external.md'), '# 開示\n');
  fs.writeFileSync(path.join(dir, 'inputs.json'), JSON.stringify({ gateG5Run: '123', headSha: 'abc' }));
  writeManifest({ dir, run: '9', target: 'abc', range: 'start..HEAD', now: new Date('2026-11-15T00:00:00Z') });
  return dir;
}

// --- 適合側 ---
{
  const dir = freshBundle();
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  check('IMPL-0521:ok manifest は 3 件の digest と注記を持つ', m.files.length === 3 && /保管期間の充足は示さない/.test(m.note) && m.schemaVersion === 1);
  check('IMPL-0521:ok manifest の inputs は inputs.json の内容', m.inputs?.headSha === 'abc');
  check('IMPL-0521:ok 変えていない一式で verify が通る', verifyManifest(dir).length === 0);
}
{
  const text = fs.readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'ship-evidence.yml'), 'utf8');
  const ps = workflowProblems(text);
  // IMPL-0246:ok(適合側。今の ship-evidence.yml は coverage-result を取り込み、headSha を照合する)
  check(`IMPL-0521:ok 今の ship-evidence.yml で workflowProblems が空${ps.length ? `(${ps.join(' / ')})` : ''}`, ps.length === 0);
}

// --- 違反側 ---
{
  const dir = freshBundle();
  fs.writeFileSync(path.join(dir, 'evidence.json'), '{"a":2}\n');
  check('IMPL-0521:ng ファイルを 1 つ変えると verify が不一致を出す', verifyManifest(dir).some((p) => /evidence\.json.*sha256/.test(p)));
}
{
  const dir = freshBundle();
  fs.unlinkSync(path.join(dir, 'assurance-disclosure.external.md'));
  check('IMPL-0521:ng ファイルを 1 つ消すと verify が不一致を出す', verifyManifest(dir).some((p) => /assurance-disclosure.*ファイルがありません/.test(p)));
}
{
  const dir = freshBundle();
  fs.writeFileSync(path.join(dir, 'extra.json'), '{}');
  check('IMPL-0521:ng manifest に無いファイルを足すと verify が不一致を出す', verifyManifest(dir).some((p) => /extra\.json.*一覧にありません/.test(p)));
}
{
  const dir = freshBundle();
  fs.unlinkSync(path.join(dir, 'manifest.json'));
  check('IMPL-0521:ng manifest が無いと verify が不一致を出す', verifyManifest(dir).length === 1);
}
{
  const text = fs.readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'ship-evidence.yml'), 'utf8');
  const drop = (re) => text.split(/\r?\n/).filter((l) => !re.test(l)).join('\n');
  check('IMPL-0521:ng retention-days を抜くと workflowProblems が出す', workflowProblems(drop(/retention-days:/)).some((p) => /retention-days/.test(p)));
  check('IMPL-0521:ng 写しの手順を抜くと workflowProblems が出す', workflowProblems(drop(/evidence-manifest\.mjs write/)).some((p) => /写す手順/.test(p)));
  check('IMPL-0521:ng verify の呼び出しを抜くと workflowProblems が出す', workflowProblems(drop(/evidence-manifest\.mjs verify/)).some((p) => /verify/.test(p)));
  // IMPL-0246:ng(違反側。coverage-result の取り込みと headSha の照合を抜いた ship-evidence.yml)
  check('IMPL-0521:ng coverage-result の取り込みを抜くと workflowProblems が出す', workflowProblems(drop(/--name coverage-result/)).some((p) => /coverage-result/.test(p)));
  check('IMPL-0521:ng headSha の照合を抜くと workflowProblems が出す', workflowProblems(drop(/--json headSha/)).some((p) => /headSha/.test(p)));
  check('IMPL-0521:ng 前回の証跡の写しからの読み先を抜くと workflowProblems が出す', workflowProblems(drop(/docs\/evidence\/\*\/manifest\.json/)).some((p) => /前回/.test(p)));
}

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\n証跡の一式の写しの試験: すべて通過');
