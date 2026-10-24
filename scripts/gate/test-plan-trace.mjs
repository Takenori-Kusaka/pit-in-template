// 受入基準 → タスクの対応の一覧(G-4 基準6)と、未確定事項の印の件数(G-2・G-4 の前提条件1)を、一時の置き場の
// 機能仕様と実装計画で試験する。
//
//   node scripts/gate/test-plan-trace.mjs
//
// 標準 第4章 G-4「受入基準とタスクの対応(基準6)」と G-2「未確定事項(前提条件1)」(process-compass #291 / ADR-0074)。
// 一覧は判定の材料で、合否を出さない。未確定事項は 1 件でも残れば判定を開始しない(spec-lint --gate が失敗する)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { criterionNumbers, readPlanMappings, unmappedCriteria, countClarifications, readClarifications } from './verification-trace.mjs';
import { clarificationStep, withG4Material } from './next.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail)}`}`);
}

const SPEC = (rows, extra = '') => `# F-001 招待

## 受入基準

| # | 型 | 受入基準 |
| --- | --- | --- |
${rows.map((n) => `| ${n} | 常時 | システムは基準 ${n} を満たさなければならない |`).join('\n')}

## 未確定事項

${extra}
`;
const PLAN = (rows, header = '| ID | 内容 | 対応する受入基準 | 変更の対象パス | 依存 | 並列可 |') => `# 実装計画

## タスク

${header}
| --- | --- | --- | --- | --- | --- |
${rows.map(([id, ac]) => `| ${id} | 作業 | ${ac} | \`src/**\` | — | 可 |`).join('\n')}

## テストの方針

| 受入基準 | テストの種類 | どこに置くか |
| --- | --- | --- |
| 9 | 単体 | |
`;

const dirs = [];
function root(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-plan-trace-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

// 1. 升の読み方
check('「1, 2」を 1 と 2 に読む', JSON.stringify(criterionNumbers('1, 2')) === '[1,2]');
check('AC-1・CR-2・「、」区切りを読む', JSON.stringify(criterionNumbers('AC-1、CR-2')) === '[1,2]');
check('同じ機能の F-001/AC-4 を読み、別の機能の F-002/AC-9 を数えない', JSON.stringify(criterionNumbers('F-001/AC-4 F-002/AC-9', 'F-001')) === '[4]');
check('範囲(1〜3)は読まず、両端も数えない(一覧に出て判定者が見る)', JSON.stringify(criterionNumbers('1〜3, 5')) === '[5]');
check('「—」は対応なし', criterionNumbers('—').length === 0);
check('ハイフンの範囲(1-3)は読まず、両端も数えない', criterionNumbers('1-3').length === 0 && criterionNumbers('1 - 3').length === 0, JSON.stringify(criterionNumbers('1-3')));
check('タスクの ID や文中の数を含む升(Task-2 の後で 4)は1つも読まない', criterionNumbers('Task-2 の後で 4').length === 0, JSON.stringify(criterionNumbers('Task-2 の後で 4')));
check('区切りの前後の空白(F-001 / AC-2)を1つの識別子に読む', JSON.stringify(criterionNumbers('F-001 / AC-2', 'F-001')) === '[2]');

// 2. 全部の受入基準がいずれかのタスクに現れる
{
  const r = root({ 'specs/F-001/spec.md': SPEC([1, 2, 3]), 'specs/F-001/plan.md': PLAN([['Task-1', '1, 2'], ['Task-2', '3']]) });
  const u = unmappedCriteria('F-001', { root: r });
  // IMPL-0150:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('全部が対応に現れる計画は、一覧が空', u.unmapped.length === 0 && u.criteria.length === 3 && u.tasks.length === 2 && u.problem === null, JSON.stringify(u));
}

// 3. タスクに現れない受入基準を一覧に出す
{
  const r = root({ 'specs/F-001/spec.md': SPEC([1, 2, 3, 4]), 'specs/F-001/plan.md': PLAN([['Task-1', '1'], ['Task-2', '3']]) });
  const u = unmappedCriteria('F-001', { root: r });
  // IMPL-0150:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('どのタスクにも現れない受入基準 AC-2・AC-4 を一覧に出す', JSON.stringify(u.unmapped) === '["F-001/AC-2","F-001/AC-4"]', JSON.stringify(u));
}

// 4. テストの方針の表など、タスクの表の外の対応を数えない
{
  const r = root({ 'specs/F-001/spec.md': SPEC([1, 9]), 'specs/F-001/plan.md': PLAN([['Task-1', '1']]) });
  const u = unmappedCriteria('F-001', { root: r });
  check('テストの方針の表に現れても、タスクに無い受入基準は一覧に出る', JSON.stringify(u.unmapped) === '["F-001/AC-9"]', JSON.stringify(u));
}

// 5. すべてを1つのタスクに束ねた計画も、基準6 の一覧は空(束ね方は基準2・4 で判定する)
{
  const r = root({ 'specs/F-001/spec.md': SPEC([1, 2, 3]), 'specs/F-001/plan.md': PLAN([['Task-1', '1, 2, 3']]) });
  check('1つのタスクに全部を束ねた計画も一覧は空(束ね方は本基準で見ない)', unmappedCriteria('F-001', { root: r }).unmapped.length === 0);
}

// 6. 標準のテンプレ7 の列名(対応CR)と CR-N の書き方も読む
{
  const r = root({
    'specs/F-001/spec.md': SPEC([1, 2]),
    'specs/F-001/plan.md': PLAN([['Task-1', 'CR-1'], ['Task-2', 'CR-2']], '| Task | 内容 | 対応CR | 依存 | 並列可否 | 見積 |'),
  });
  const p = readPlanMappings('F-001', { root: r });
  check('列名「対応CR」と CR-N を読む', p.column && unmappedCriteria('F-001', { root: r }).unmapped.length === 0, JSON.stringify(p));
}

// 7. 計画が無い・列が無い場合は、全部の受入基準を一覧に出し、理由を添える
{
  const r1 = root({ 'specs/F-001/spec.md': SPEC([1, 2]) });
  const u1 = unmappedCriteria('F-001', { root: r1 });
  check('実装計画が無い場合は、全部を一覧に出し理由を添える', u1.unmapped.length === 2 && /plan\.md がない/.test(u1.problem ?? ''), JSON.stringify(u1));
  const r2 = root({ 'specs/F-001/spec.md': SPEC([1, 2]), 'specs/F-001/plan.md': PLAN([['Task-1', '1']], '| ID | 内容 | 変更の対象パス | 依存 | 並列可 | 備考 |') });
  const u2 = unmappedCriteria('F-001', { root: r2 });
  check('「対応する受入基準」の列が無い場合は、全部を一覧に出し理由を添える', u2.unmapped.length === 2 && /列がない/.test(u2.problem ?? ''), JSON.stringify(u2));
}

// 8. 未確定事項の印
{
  const text = [
    '## 未確定事項',
    '- [NEEDS CLARIFICATION] 招待の有効期限は何日か',
    '本文で `[NEEDS CLARIFICATION]` の書き方を説明する(数えない)',
    '<!-- [NEEDS CLARIFICATION] 注記の中は数えない -->',
    '<!-- 複数行の注記',
    '[NEEDS CLARIFICATION] 数えない',
    '-->',
    '```',
    '- [NEEDS CLARIFICATION] コードブロックの中は数えない',
    '```',
    '- [needs clarification] 小文字も数える',
  ].join('\n');
  const c = countClarifications(text);
  check('未確定事項の印を数える(注記・インラインコード・コードブロックの中を除く)', c.count === 2 && JSON.stringify(c.lines) === '[2,11]', JSON.stringify(c));
  check('印の無い仕様は 0 件', countClarifications('## 未確定事項\n\n(なし)\n').count === 0);
  const r = root({ 'specs/F-001/spec.md': SPEC([1], '- [NEEDS CLARIFICATION] 期限') });
  const rc = readClarifications('F-001', { root: r });
  check('readClarifications が機能仕様の件数を読む', rc.spec && rc.count === 1, JSON.stringify(rc));
  check('readClarifications は機能仕様が無いことを示す', readClarifications('F-404', { root: r }).spec === false);
}

// 9. spec-lint --gate(テンプレートの scripts を一時の置き場へ写して実行する。ROOT は写した先になる)
{
  const dir = root({});
  for (const d of ['scripts/gate', 'scripts/vendor']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  const run = (...args) => {
    const r = spawnSync(process.execPath, ['scripts/gate/spec-lint.mjs', ...args], { cwd: dir, encoding: 'utf8' });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('specs/F-001/spec.md', SPEC([1, 2, 3], '- [NEEDS CLARIFICATION] 期限'));
  put('specs/F-001/plan.md', PLAN([['Task-1', '1'], ['Task-2', '3']]));
  let r = run('specs/F-001');
  check('--gate を付けない spec-lint(CI と同じ)は、未確定事項で落ちない', r.ok, r.out);
  r = run('--gate', 'G-2', 'specs/F-001');
  // IMPL-0142:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('spec-lint --gate G-2 は、未確定事項が残ると落ち、件数と G-2 前提条件1 を出す', !r.ok && /未確定事項が 1 件/.test(r.out) && /G-2 前提条件1/.test(r.out), r.out);
  put('specs/F-001/spec.md', SPEC([1, 2, 3], '(なし)'));
  r = run('--gate', 'G-2', 'specs/F-001');
  // IMPL-0142:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('未確定事項を閉じると spec-lint --gate G-2 が通る', r.ok && /未確定事項 0 件/.test(r.out), r.out);
  r = run('--gate', 'G-4', 'specs/F-001');
  check('spec-lint --gate G-4 は、どのタスクにも現れない受入基準を一覧に出し、合否に使わない', r.ok && /G-4 基準6 の材料/.test(r.out) && /F-001\/AC-2/.test(r.out), r.out);
  r = run('--gate', 'G-9', 'specs/F-001');
  check('--gate に G-2・G-4 以外を渡すと落ちる', !r.ok && /G-2 か G-4/.test(r.out), r.out);
  r = run('--gate', 'G-4', 'specs/F-404');
  check('--gate で機能仕様が無いと落ちる', !r.ok && /spec\.md がありません/.test(r.out), r.out);
}

// 10. next.mjs の段階(未確定事項が残る機能を判定待ちへ進めない。G-4 待ちに一覧を添える)
{
  const spec = SPEC([1, 2], '- [NEEDS CLARIFICATION] 期限');
  const s2 = clarificationStep('F-001', spec, { gate: 'g2', waiting: true });
  check('next.mjs: 未確定事項が残り G-2 を待つ機能は「未確定事項が残る」(G-2 前提条件1)で止まる', s2?.stage === '未確定事項が残る' && s2.kind === 'command' && /G-2 前提条件1/.test(s2.reason) && /\/spec-write F-001/.test(s2.command), JSON.stringify(s2));
  const s4 = clarificationStep('F-001', spec, { gate: 'g4', waiting: true });
  check('next.mjs: G-2 を通過した後の G-4 待ちでも止まる(G-4 前提条件1)', s4?.stage === '未確定事項が残る' && /G-4 前提条件1/.test(s4.reason), JSON.stringify(s4));
  check('next.mjs: 判定を待っていないゲートでは止めない', clarificationStep('F-001', spec, { gate: 'g4', waiting: false }) === null);
  check('next.mjs: 未確定事項が無ければ止めない', clarificationStep('F-001', SPEC([1, 2], '(なし)'), { gate: 'g2', waiting: true }) === null);
  const r = root({ 'specs/F-001/spec.md': SPEC([1, 2, 3]), 'specs/F-001/plan.md': PLAN([['Task-1', '1']]) });
  const w = withG4Material({ kind: 'human-wait', detail: '記録の注記' }, 'F-001', { root: r });
  check(
    'next.mjs: G-4 の判定待ちの詳細に、どのタスクにも現れない受入基準を添え、既存の詳細を残す(段階は human-wait のまま)',
    w.kind === 'human-wait' && /G-4 基準6 の材料/.test(w.detail) && /F-001\/AC-2, F-001\/AC-3/.test(w.detail) && /記録の注記/.test(w.detail) && w.unmappedCriteria.length === 2,
    JSON.stringify(w)
  );
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${checks - failures} / ${checks} 件一致`);
process.exit(failures ? 1 : 0);
