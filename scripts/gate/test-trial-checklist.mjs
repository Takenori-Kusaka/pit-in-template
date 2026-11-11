// 試行前チェックリストの検査(trial-checklist.mjs)と /pit の注記の試験。process-compass #359 / IMPL-0465・IMPL-0466
//
//   node scripts/gate/test-trial-checklist.mjs
//
// 日付は --today と関数の引数で固定する(時計に依らない)。/pit の注記は、写しの有無と G-1 の通過で出し分けることを、
// 一時の置き場で next.mjs --offline を走らせて確かめる。GitHub へ問い合わせません。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { trialChecklistProblems, checklistItems, sandboxRows } from './trial-checklist.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? `\n  ${String(detail).slice(0, 1500)}` : ''}`);
  }
}

const FORM = fs.readFileSync(path.join(ROOT, 'templates/trial-checklist.md'), 'utf8');
const TODAY = '2026-11-12';
const checkedAll = FORM.replace(/^(\s*-\s*)\[ \]/gm, '$1[x]');
// 免除の項目だけは「該当なし: 理由」(既存の規程を持たない体制)。免除の行を書く試験では、印を付けた形(checkedAll)に行を足す
const allChecked = checkedAll.replace(/^- \[x\] (既存規程の免除を要する場合.*)$/m, '- [ ] $1 該当なし: 既存の規程を持たない');
const setRow = (text, row) => text.replace(/^\| \| \| \| \|$/m, row);

check('様式は第8章の5群の項目を持つ(16件)', checklistItems(FORM).length === 16, String(checklistItems(FORM).length));
// IMPL-0466:ng(違反と適合の対。標準の実装マーク)
let p = trialChecklistProblems(FORM, FORM, TODAY);
check('写した直後の様式は、16件の未確認の項目を出す', p.filter((x) => x.startsWith('未確認の項目')).length === 16, p.join('\n'));
p = trialChecklistProblems(allChecked.replace(/^- \[x\] (中止の条件が事前に定められている)$/m, '- [ ] $1 該当なし'), FORM, TODAY);
check('理由の無い「該当なし」を確認済みとして扱わない', p.length === 1 && p[0].startsWith('理由の無い「該当なし」'), p.join('\n'));
p = trialChecklistProblems(allChecked.replace(/^- \[x\] 中止した場合に元の手順へ戻す方法が定められている\r?\n/m, ''), FORM, TODAY);
check('項目を消した写しは、消した項目を出す(撤退の条件を外して始めない)', p.length === 1 && p[0].includes('項目が写しにありません') && p[0].includes('元の手順へ戻す方法'), p.join('\n'));
// IMPL-0466:ok(違反と適合の対。標準の実装マーク)
p = trialChecklistProblems(
  allChecked.replace(/^- \[x\] (支援担当\(EN-1\)が割り当てられ、関与の期間が定められている)$/m, '- [ ] $1 該当なし: 1名の体制で、外部の助言者が支援担当を代替する'),
  FORM,
  TODAY
);
check('理由のある「該当なし」は、確認済みとして扱う', p.length === 0, p.join('\n'));
check('全項目を確認した写し(免除なし)は、問題を出さない', trialChecklistProblems(allChecked, FORM, TODAY).length === 0);
// 突合 中-1: 印を付けた行の理由の無い「該当なし」も、確認済みとして扱わない
p = trialChecklistProblems(allChecked.replace(/^- \[x\] (中止の条件が事前に定められている)$/m, '- [x] $1 該当なし'), FORM, TODAY);
check('印を付けた行の理由の無い「該当なし」も出す', p.length === 1 && p[0].startsWith('理由の無い「該当なし」'), p.join('\n'));
// 突合 中-2: 項目の行へ数値・所在を書き足した写しを、項目の欠けと読まない
p = trialChecklistProblems(
  allChecked
    .replace('参加者の稼働時間が公式に確保されている(見込み工数と確保時間を数値で記載)', '参加者の稼働時間が公式に確保されている(見込み工数 40 時間 / 確保 40 時間)')
    .replace('- [x] 中止の条件が事前に定められている', '- [x] 中止の条件が事前に定められている(docs/trial-exit.md)'),
  FORM,
  TODAY
);
check('項目の行へ数値と所在を書き足した写しは、項目の欠けと読まない', p.length === 0, p.join('\n'));
// 突合の再確認 2回目: 括弧の中の「該当なし」で未確認の検出を逃れない
p = trialChecklistProblems(FORM.replace('参加者の稼働時間が公式に確保されている(見込み工数と確保時間を数値で記載)', '参加者の稼働時間が公式に確保されている(外部委託分は該当なし、専任3名)'), FORM, TODAY);
check('印の無い行の括弧の中の「該当なし」は、該当なしに数えず未確認として出す', p.some((x) => x.startsWith('未確認の項目') && x.includes('専任3名')), p.join(String.fromCharCode(10)));
// 突合の再確認 新-1: 括弧の外の文を書き換えた行・消した行は、様式の項目の欠けとして出す
p = trialChecklistProblems(allChecked.replace(/^- \[x\] 支援担当\(EN-1\)が割り当てられ、関与の期間が定められている\r?\n/m, ''), FORM, TODAY);
check('EN-1 の項目を消した写しは、似た書き出しの別の項目があっても欠けとして出す', p.length === 1 && p[0].includes('支援担当(EN-1)が割り当てられ'), p.join('\n'));
p = trialChecklistProblems(allChecked.replace('支援担当(EN-1)が割り当てられ、関与の期間が定められている', '支援担当(EN-1)は置かない'), FORM, TODAY);
check('括弧の後ろの文を書き換えた項目は、様式の項目の欠けとして出す', p.length === 1 && p[0].includes('項目が写しにありません'), p.join('\n'));
p = trialChecklistProblems(allChecked.replace('対象範囲(対象・環境・変更種別・リスク区分)が文書で確定している', '対象範囲(対象のみ)は未確定'), FORM, TODAY);
check('括弧の外の文を否定へ書き換えた項目は、様式の項目の欠けとして出す', p.length === 1 && p[0].includes('対象範囲'), p.join('\n'));

// IMPL-0465:ng(違反と適合の対。標準の実装マーク)
p = trialChecklistProblems(setRow(checkedAll, '| 品質規程 4.2 の承認の手続 |  | 申請 SB-1 | |'), FORM, TODAY);
check('免除の期限の無いサンドボックスの行を出す', p.length === 1 && p[0].includes('免除の期限(YYYY-MM-DD)がありません'), p.join('\n'));
p = trialChecklistProblems(setRow(checkedAll, '| 品質規程 4.2 の承認の手続 | 2026-10-31 | 申請 SB-1 | |'), FORM, TODAY);
check('延長の決定の無いまま期限を過ぎた免除を出す(期限は自動では延びない)', p.length === 1 && p[0].includes('期限 2026-10-31 を過ぎています'), p.join('\n'));
p = trialChecklistProblems(setRow(checkedAll, '| 品質規程 4.2 の承認の手続 | 2026-09-30 | 申請 SB-1 | 2026-10-31(決定 D-12) |'), FORM, TODAY);
check('延長した期限も過ぎた免除を出す', p.length === 1 && p[0].includes('延長した期限 2026-10-31 を過ぎています'), p.join('\n'));
p = trialChecklistProblems(checkedAll, FORM, TODAY);
check('免除の項目に印を付けて、免除の行が無い写しを出す', p.length === 1 && p[0].includes('免除」の表に行がありません'), p.join('\n'));
// IMPL-0465:ok(違反と適合の対。標準の実装マーク)
p = trialChecklistProblems(setRow(checkedAll, '| 品質規程 4.2 の承認の手続 | 2026-10-31 | 申請 SB-1 | 2027-01-31(決定 D-12) |'), FORM, TODAY);
check('元の期限を残し、新しい期限の決定を書き足した免除は通す', p.length === 0, p.join('\n'));
// 突合 低-7: 元の期限より前の日付は、延長として読まない
p = trialChecklistProblems(setRow(checkedAll, '| 品質規程 4.2 の承認の手続 | 2026-12-31 | 申請 SB-1 | 2026-09-30(決定 D-12) |'), FORM, TODAY);
check('元の期限より前の日付の「延長」は延長として読まず、元の期限で判定する(期限の内なら通す)', p.length === 0, p.join('\n'));
p = trialChecklistProblems(setRow(checkedAll, '| 品質規程 4.2 の承認の手続 | 2026-12-31 | 申請 SB-1 | |'), FORM, TODAY);
check('期限の内の免除は通す', p.length === 0, p.join('\n'));
check('免除の表の行を読む', sandboxRows(setRow(FORM, '| 条項 | 2026-12-31 | 所在 | |')).length === 1);

// ---------------------------------------------------------------- 入口(trial-checklist.mjs と next.mjs)を一時の置き場で通す
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-trial-checklist-'));
  for (const d of ['scripts', 'templates', '.claude']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  for (const f of ['process.config.json', 'CLAUDE.md', 'PROCESS-PROFILE.md']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'docs/gates'), { recursive: true });
  const write = (rel, t) => fs.writeFileSync(path.join(dir, rel), t);
  const node = (...a) => {
    const r = spawnSync(process.execPath, a, { cwd: dir, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { dir, write, node };
}
{
  const W = workspace();
  let r = W.node('scripts/gate/trial-checklist.mjs', '--today', TODAY);
  check('入口: 写しが無ければ終了コード 1', r.status === 1 && r.out.includes('docs/trial-checklist.md がありません'), r.out);
  W.write('docs/trial-checklist.md', FORM);
  r = W.node('scripts/gate/trial-checklist.mjs', '--today', TODAY);
  check('入口: 未確認の項目のある写しは終了コード 1 で、試行を始めないと出す', r.status === 1 && r.out.includes('試行を始めません'), r.out);
  W.write('docs/trial-checklist.md', allChecked);
  r = W.node('scripts/gate/trial-checklist.mjs', '--today', TODAY);
  check('入口: 全項目を確認した写しは終了コード 0', r.status === 0, r.out);
  fs.rmSync(W.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
{
  // /pit(next.mjs --offline)の注記
  const W = workspace();
  const log = console.log;
  console.log = () => {};
  let config;
  try {
    const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
    const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
    const ANSWERS = {
      'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
      'q-team-size': 'size-3-9', 'q-biz-phase': 'growth', 'q-external-reviewer': 'reviewer-yes',
    };
    config = buildConfig(ANSWERS, { generatedAt: '2026-08-01T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config;
  } finally {
    console.log = log;
  }
  W.write('process.config.json', JSON.stringify(config, null, 2) + '\n');
  const NOTE_ABSENT = '試行前チェックリスト(docs/trial-checklist.md)がありません';
  let r = W.node('scripts/gate/next.mjs', '--offline');
  check('/pit: 写しが無いことは注記に出さない(T-1 を済ませた組織の案件に写しを求めない。突合 中-3)', !r.out.includes(NOTE_ABSENT) && !r.out.includes('試行前チェックリスト('), r.out.slice(-1500));
  W.write('docs/trial-checklist.md', FORM);
  r = W.node('scripts/gate/next.mjs', '--offline');
  check('/pit: 未確認の項目のある写しは、件数と始めないことを注記に出す', /試行前チェックリスト\(docs\/trial-checklist\.md\)に 16 件/.test(r.out) && r.out.includes('T-1 の限定試行を始めない'), r.out.slice(-1500));
  W.write('docs/trial-checklist.md', allChecked);
  r = W.node('scripts/gate/next.mjs', '--offline');
  check('/pit: 問題の無い写しは、注記を出さない', !r.out.includes('試行前チェックリスト('), r.out.slice(-1500));
  fs.rmSync(W.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`test-trial-checklist: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
