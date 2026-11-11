// 企画書の閾値の行の検査(brief-thresholds.mjs)の試験。process-compass #419 / ADR-0097
import { BRIEF_THRESHOLD_ROWS, briefThresholdProblems, briefThresholdMessage, BRIEF_STOP_ROW, briefStopConditionState, briefStopConditionMessages } from './brief-thresholds.mjs';
import { isFilledValue } from './config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { g1PassState } from './records.mjs';

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

// ---------------------------------------------------------------- 停止条件の値(標準 第3章 3.12.10 の要求事項4。process-compass #359 / IMPL-0280)
const stopBrief = (v) => ['## 指標の閾値と予算区分(G-1 基準4)', '', '| 項目 | 記載 |', '| --- | --- |', v === null ? '' : `| ${BRIEF_STOP_ROW} | ${v} |`].join('\n');
{
  // IMPL-0280:ng(違反と適合の対。標準の実装マーク)
  let s = briefStopConditionState(stopBrief(null), [], isFilledValue, {});
  check('停止条件の値: 行が無い企画書は、G-1 の前は問題にする', s.problem === 'missing' && briefStopConditionMessages(s).some((m) => m.level === 'problem'), JSON.stringify(s));
  s = briefStopConditionState(stopBrief('<標準 第3章 3.12.10 の停止条件の値>'), [], isFilledValue, {});
  check('停止条件の値: 様式の説明のままは、G-1 の前は問題にする', s.problem === 'blank' && s.state === 'required', JSON.stringify(s));
  s = briefStopConditionState(stopBrief(''), passedG1, isFilledValue, {});
  const ms = briefStopConditionMessages(s);
  check('停止条件の値: G-1 を通過済みは遡って失敗させず、欠落として注意にする', s.state === 'gap' && ms.length === 1 && ms[0].level === 'warn' && ms[0].text.includes('遡って失敗させません'), JSON.stringify(ms));
  s = briefStopConditionState(stopBrief('連続失敗の上限 5 回 / 無進捗の上限 2 回 / 累積消費の上限 採用者の手段(基盤の上限の設定)'), [], isFilledValue, { selfHealMaxIterations: 3 });
  const mm = briefStopConditionMessages(s);
  check('停止条件の値: 構成と異なる連続失敗の上限は、構成の値が効くことを注意にする(問題にしない)', s.problem === null && mm.length === 1 && mm[0].level === 'warn' && mm[0].text.includes('task.selfHealMaxIterations'), JSON.stringify(mm));
  // IMPL-0280:ok(違反と適合の対。標準の実装マーク)
  s = briefStopConditionState(stopBrief('連続失敗の上限 3 回 / 無進捗の上限 2 回 / 累積消費の上限 採用者の手段(基盤の上限の設定)'), [], isFilledValue, {});
  check('停止条件の値: 構成(既定 3・2)と揃った値は、何も出さない', s.problem === null && briefStopConditionMessages(s).length === 0, JSON.stringify(s));
}

// 様式(本体と3つのプロファイル)が2行を持ち、説明 <…> のままである(写した直後の企画書が G-1 の前に止まる)
for (const f of ['templates/06-project-brief.md', 'profiles/internal/templates/06-project-brief.md', 'profiles/oss/templates/06-project-brief.md', 'profiles/revenue/templates/06-project-brief.md']) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const q = briefThresholdProblems(text, [], isFilledValue);
  check(`${f} は停止条件の値の行を持ち、様式の説明のままである`, briefStopConditionState(text, [], isFilledValue, {}).problem === 'blank');
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
  check('入口: G-1 の前の企画書は、停止条件の値の説明のままで失敗する', !r.ok && r.out.includes('「停止条件の値」が未記入です'), r.out);
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

// ---------------------------------------------------------------- G-1 の通過を記録用ブランチからも読む(process-compass #359 の独立の突合 高-1)
// G-1 の様式の正本は記録用ブランチ records の records/gates/。基底ブランチへは出荷の PR が複製する。複製の前の案件を「G-1 の前」と
// 読み違えて遡って失敗させないこと、記録用ブランチを読めないときは「判定記録を読めない」として出すことを確かめる
const G1_FORM = ['# ゲート判定記録', '', '| 項目 | 値 |', '| --- | --- |', '| ゲート | G-1 企画承認 |', '| 対象 | P-001 |', '| 判定者 | 判定 花子 |', '| 判定日時 | 2026-11-04 10:00 |', '| 結果 | 通過 |', '| 確定の形態 | 人確定 |', '| 参照した D-0 の版 | v1.0 |', ''].join('\n');
check('g1PassState: 記録用ブランチの様式の G-1 の通過を通過済みと読む', g1PassState({ baseRecords: [], branch: { available: true, gates: [{ file: 'records/gates/g1.md', text: G1_FORM }] } }).passed === true);
check('g1PassState: 両方を読めて通過が無ければ G-1 の前', g1PassState({ baseRecords: [], branch: { available: true, gates: [] } }).passed === false);
check('g1PassState: 記録用ブランチを読めず基底にも無ければ、決めない(null と理由)', (() => { const r = g1PassState({ baseRecords: [], branch: { available: false, reason: 'テストの理由', gates: [] } }); return r.passed === null && r.reason.includes('テストの理由'); })());
check('g1PassState: 基底に通過があれば、記録用ブランチを読めなくても通過済み', g1PassState({ baseRecords: [{ gate: 'G-1 企画承認', result: '通過' }], branch: { available: false, reason: 'x', gates: [] } }).passed === true);
{
  const W = workspace();
  const form = fs.readFileSync(path.join(ROOT, 'templates/06-project-brief.md'), 'utf8');
  // 停止条件の値の行を消した企画書(#359 の前に G-1 を通過した企画書の形)
  W.write('docs/project-brief.md', form.split(/\r?\n/).filter((l) => !l.startsWith('| 停止条件の値 |')).join('\n'));
  const git = (...a) => execFileSync('git', a, { cwd: W.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // 名簿の事業決裁者の席の責任者を「判定 花子」にする(記録用ブランチの通過の記録の記名を照らすため。突合の再確認 新-2)
  W.write('process.config.json', JSON.stringify({ configured: true, people: [{ id: 'p1', name: '判定 花子', accounts: ['hanako'] }, { id: 'p2', name: '別 太郎', accounts: ['taro'] }], seats: [{ role: 'biz-approver', accountable: 'p1' }] }) + '\n');
  // 記録用ブランチを読めない(リポジトリでない置き場): 遡って失敗させず、黙って通さず、「判定記録を読めない」として出す
  let r = W.g1();
  check('入口: 記録用ブランチを読めず G-1 の通過を決められないとき、「判定記録を読めない」で失敗し、欠けた行を添える', !r.ok && r.out.includes('G-1 の通過を判定記録で決められない') && r.out.includes('記録用ブランチ records を読めない') && r.out.includes('「停止条件の値」がありません'), r.out);
  check('入口: 決められないとき、欠けた行を「G-1 の前の失敗」として単独では出さない', !/^.*「停止条件の値」がありません.*標準 第3章 3.12.10 の要求事項4\)\s*$/m.test(r.out.split('\n').filter((l) => !l.includes('判定記録を読めない')).join('\n')), r.out);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  // 記録用ブランチがあり、G-1 の通過が無い: G-1 の前として失敗させる(判定記録を読めないとは出さない)
  git('checkout', '-q', '--orphan', 'records');
  git('rm', '-rf', '--quiet', '.');
  fs.mkdirSync(path.join(W.dir, 'records/gates'), { recursive: true });
  fs.writeFileSync(path.join(W.dir, 'records/gates/README.md'), '# 記録\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'records');
  git('checkout', '-q', 'main');
  r = W.g1();
  check('入口: 記録用ブランチを読めて G-1 の通過が無ければ、欠けた行を G-1 の前の失敗にする', !r.ok && r.out.includes('「停止条件の値」がありません') && !r.out.includes('G-1 の通過を判定記録で決められない'), r.out);
  // 記録用ブランチに G-1 の通過の様式がある(基底ブランチへはまだ複製していない): 遡って失敗させず、欠落として出す
  git('checkout', '-q', 'records');
  fs.writeFileSync(path.join(W.dir, 'records/gates/g1-p001-2026-11-04.md'), G1_FORM);
  git('add', '-A');
  git('commit', '-q', '-m', 'G-1');
  git('checkout', '-q', 'main');
  r = W.g1();
  check('入口: 記録用ブランチにだけ G-1 の通過がある企画書は、停止条件の値の欠けを遡って失敗させず欠落として出す', r.out.includes('「停止条件の値」がありません') && r.out.includes('遡って失敗させません') && !r.out.includes('G-1 の通過を判定記録で決められない') && !/停止条件の値は案件ごとに定め/.test(r.out), r.out);
  check('入口: 同じ企画書で、閾値の行も記録用ブランチの通過で欠落として出す(#419 と同じ根)', /「エスカレーション閾値」が未記入です.*遡って失敗させません/.test(r.out), r.out);
  // 判定者が事業決裁者の席の責任者でない通過の記録は、通過済みに数えず、決められないとして出す(突合の再確認 新-2)
  git('checkout', '-q', 'records');
  fs.writeFileSync(path.join(W.dir, 'records/gates/g1-p001-2026-11-04.md'), G1_FORM.replace('| 判定者 | 判定 花子 |', '| 判定者 | 別 太郎 |'));
  git('add', '-A');
  git('commit', '-q', '-m', 'G-1 by other');
  git('checkout', '-q', 'main');
  r = W.g1();
  check('入口: 判定者が事業決裁者の席の責任者に対応づかない記録用ブランチの通過は数えず、決められないとして失敗する', !r.ok && r.out.includes('G-1 の通過を判定記録で決められない') && r.out.includes('名簿の事業決裁者の席の責任者に対応づかない'), r.out);
  // 出荷の PR で基底ブランチへ複製した後は、同じ記録を二重に数えない(突合の再確認 新-4)
  const dup = g1PassState({ baseRecords: [{ file: 'docs/gates/g1-p001-2026-11-04.md', gate: 'G-1 企画承認', result: '通過' }], branch: { available: true, gates: [{ file: 'records/gates/g1-p001-2026-11-04.md', text: G1_FORM }] } });
  check('g1PassState: 基底ブランチへ複製した記録を、記録用ブランチの側から二重に読まない', dup.passed === true && dup.records.length === 1, JSON.stringify(dup.records.map((x) => x.file)));
  fs.rmSync(W.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`test-brief-thresholds: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
