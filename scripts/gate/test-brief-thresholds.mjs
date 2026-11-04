// 企画書の閾値の行の検査(brief-thresholds.mjs)の試験。process-compass #419 / ADR-0097
import { BRIEF_THRESHOLD_ROWS, briefThresholdProblems, briefThresholdMessage } from './brief-thresholds.mjs';
import { isFilledValue } from './config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`);
  }
}

const passedG1 = [{ gate: 'G-1 企画承認', result: '通過' }];
const brief = (esc, auto) =>
  ['## 指標の閾値と予算区分(G-1 基準4)', '', '| 項目 | 記載 |', '| --- | --- |', esc === null ? '' : `| エスカレーション閾値 | ${esc} |`, auto === null ? '' : `| 自動的な上程の閾値 | ${auto} |`].join('\n');

// 違反: 様式のまま(説明 <…> が残る)
let p = briefThresholdProblems(brief('<第7章 7.6 の値>', '<第7章 7.7.4 の値>'), [], isFilledValue);
check('様式の説明のままの2行は、G-1 の前は失敗にする', p.length === 2 && p.every((x) => x.problem === 'blank' && x.state === 'required'), JSON.stringify(p));
// 違反: 空欄
p = briefThresholdProblems(brief('', ''), [], isFilledValue);
check('空欄の2行は、G-1 の前は失敗にする', p.length === 2 && p.every((x) => x.state === 'required'), JSON.stringify(p));
// 違反: 行が無い
p = briefThresholdProblems(brief(null, null), [], isFilledValue);
check('行が無い企画書は、行の欠落として失敗にする', p.length === 2 && p.every((x) => x.problem === 'missing'), JSON.stringify(p));
// G-1 を通過済み: 遡って失敗させず欠落にする
p = briefThresholdProblems(brief('', null), passedG1, isFilledValue);
check('G-1 を通過済みの企画書は、欠落(gap)として出す', p.length === 2 && p.every((x) => x.state === 'gap'), JSON.stringify(p));
check('欠落の文は、遡って失敗させないことを書く', briefThresholdMessage(p[0]).includes('遡って失敗させません'), briefThresholdMessage(p[0]));
// 適合: 値を書いた
p = briefThresholdProblems(brief('予算 10%・20%・30% の見込み、SC-M 量を問わない・15%・25%、日程 1週間・2週間・主要工程', '消化進捗比 1.3 超が2期連続、残20%未満、150%超、上限の2倍超が3期連続'), [], isFilledValue);
check('値を書いた2行は、問題にしない', p.length === 0, JSON.stringify(p));
// 企画書が無い
check('企画書が無いときは、何も出さない', briefThresholdProblems(null, [], isFilledValue).length === 0);

// 様式(本体と3つのプロファイル)が2行を持ち、説明 <…> のままである(写した直後の企画書が G-1 の前に止まる)
for (const f of ['templates/06-project-brief.md', 'profiles/internal/templates/06-project-brief.md', 'profiles/oss/templates/06-project-brief.md', 'profiles/revenue/templates/06-project-brief.md']) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const q = briefThresholdProblems(text, [], isFilledValue);
  check(`${f} は閾値の2行を持ち、様式の説明のままである`, BRIEF_THRESHOLD_ROWS.every((k) => q.some((x) => x.key === k && x.problem === 'blank')), JSON.stringify(q));
}

// ---------------------------------------------------------------- 入口(check-g1)を一時の置き場で通す
// 規定は G-1 の検査という入口についてのものなので、関数だけでなく node scripts/gate/check-g1.mjs を走らせる(実装マークの規約「machine の要件」)
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-g1-thresholds-'));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'templates'), path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify({ configured: true }) + '\n');
  fs.mkdirSync(path.join(dir, 'docs/gates'), { recursive: true });
  const write = (rel, t) => fs.writeFileSync(path.join(dir, rel), t);
  const g1 = () => {
    const r = spawnSync(process.execPath, ['scripts/gate/check-g1.mjs'], { cwd: dir, encoding: 'utf8' });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { dir, write, g1 };
}
{
  const W = workspace();
  const form = fs.readFileSync(path.join(ROOT, 'templates/06-project-brief.md'), 'utf8');
  W.write('docs/project-brief.md', form);
  // IMPL-0371:ng(G-1 の前の企画書は、閾値の2行の説明のままで失敗する)
  let r = W.g1();
  check('入口: G-1 の前の企画書は、閾値の2行の説明のままで失敗し、2行を出す', !r.ok && r.out.includes('「エスカレーション閾値」が未記入です') && r.out.includes('「自動的な上程の閾値」が未記入です') && r.out.includes('閾値は組織が定める値です'), r.out);
  // IMPL-0371:ok(値を書いた企画書は、閾値の2行を指摘しない)
  W.write('docs/project-brief.md', form.replace(/^\| エスカレーション閾値 \| .*$/m, '| エスカレーション閾値 | 予算 10%・20%・30% の見込み |').replace(/^\| 自動的な上程の閾値 \| .*$/m, '| 自動的な上程の閾値 | 消化進捗比 1.3 超が2期連続 |'));
  r = W.g1();
  check('入口: 閾値の2行に値を書いた企画書は、その欄を指摘しない', !r.out.includes('閾値」が未記入') && !r.out.includes('閾値」がありません'), r.out);
  // IMPL-0371:ok(G-1 を通過済みの企画書は、遡って失敗に数えず欠落として出す)
  W.write('docs/project-brief.md', form);
  W.write('docs/gates/g1.md', ['# ゲート判定記録', '', '| 項目 | 値 |', '| --- | --- |', '| ゲート | G-1 企画承認 |', '| 対象 | P-001 |', '| 判定者 | 判定 花子 |', '| 判定日時 | 2026-11-04 10:00 |', '| 結果 | 通過 |', '| 確定の形態 | 人確定 |', '| 参照した D-0 の版 | v1.0 |', ''].join('\n'));
  r = W.g1();
  check('入口: G-1 を通過済みの企画書は、閾値の2行を欠落として出し、問題に数えない', r.out.includes('遡って失敗させません') && !r.out.includes('閾値は組織が定める値です'), r.out);
  fs.rmSync(W.dir, { recursive: true, force: true });
}

console.log(`test-brief-thresholds: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
