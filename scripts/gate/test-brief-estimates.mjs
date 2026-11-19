// 当初の見積りの保存と、見積りと実績の差の記録の検査(brief-estimates.mjs、check-g1、出荷の証跡の集約)の試験。
// process-compass #416 / ADR-0093(標準 第7章 7.7.9 の要求事項3・4)
import { g1EstimateBlank, g1EstimateChanges, briefVersionOf, estimateGapBlank, DEFAULT_DONE_CONDITION, doneConditionOf, isDefaultDoneCondition, unitPeriodDaysOf } from './brief-estimates.mjs';
import { isFilledValue } from './config.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`);
  }
}

const costTable = (g1) =>
  [
    '## 総費用の内訳',
    '',
    '| 区分 | 内容 | 値 | 実績 / 見積り | 出所 | G-1 の時点の見積り |',
    '| --- | --- | --- | --- | --- | --- |',
    ...['AI の実行', '検証', '修正', '教育', '管理'].map((l) => `| ${l} | 内容 | 10時間 | 見積り | 見積りの方法 | ${g1[l] ?? '10時間'} |`),
    '',
  ].join('\n');

// 関数
check('G-1 の時点の見積りが埋まっていれば空欄は無い', g1EstimateBlank(costTable({}), isFilledValue).length === 0);
check('G-1 の時点の見積りの空欄を区分の名で返す', g1EstimateBlank(costTable({ 教育: '' }), isFilledValue).join(',') === '教育');
check('列が無ければ null を返す', g1EstimateBlank('## 総費用の内訳\n\n| 区分 | 値 |\n| --- | --- |\n| AI の実行 | 1 |\n', isFilledValue) === null);
check('書き換えた区分を返す', g1EstimateChanges(costTable({}), costTable({ 検証: '20時間' })).map((c) => c.label).join(',') === '検証');
check('書き換えが無ければ空', g1EstimateChanges(costTable({}), costTable({})).length === 0);
check('参照した企画書の版からコミットの識別子を読む', briefVersionOf('| 参照した企画書の版 | `a1b2c3d` |') === 'a1b2c3d' && briefVersionOf('| 参照した企画書の版 | 該当なし |') === null);
const gap = (rows) => `## 見積りと実績の差(適用: ステージ移行ゲート)\n\n| 欄 | 記載 |\n| --- | --- |\n${rows}\n`;
check('見積りと実績の差の3欄が書かれていれば空欄は無い', estimateGapBlank(gap('| 当初の見積り | 100時間 |\n| 実績 | 130時間 |\n| 差と主な原因 | +30時間。範囲の変更 |'), isFilledValue).length === 0);
check('見積りと実績の差の空欄と説明のままを返す', estimateGapBlank(gap('| 当初の見積り | <企画書の見積り値> |\n| 実績 | |\n| 差と主な原因 | +30時間 |'), isFilledValue).join(',') === '当初の見積り,実績');
check('節が無ければ null を返す', estimateGapBlank('# ゲート判定記録\n', isFilledValue) === null);

// 入口(check-g1)を、git の履歴を持つ一時の置き場で通す
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-g1-estimates-'));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'templates'), path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify({ configured: true }) + '\n');
  fs.mkdirSync(path.join(dir, 'docs/gates'), { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  const write = (rel, t) => fs.writeFileSync(path.join(dir, rel), t);
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD').trim();
  };
  const g1 = () => {
    const r = spawnSync(process.execPath, ['scripts/gate/check-g1.mjs'], { cwd: dir, encoding: 'utf8' });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { dir, write, commit, g1 };
}
const brief = (g1) => `---\nproject_id: P-001\nversion: v1\napprover: 承認 花子\nstatus: 承認待ち\n---\n\n# 企画書\n\n${costTable(g1)}`;
const g1Record = (ver) => ['# ゲート判定記録', '', '| 項目 | 値 |', '| --- | --- |', '| ゲート | G-1 企画承認 |', '| 対象 | P-001 |', '| 判定者 | 承認 花子 |', '| 判定日時 | 2026-11-04 10:00 |', '| 結果 | 通過 |', '| 確定の形態 | 人確定 |', '| 参照した D-0 の版 | v1.0 |', `| 参照した企画書の版 | ${ver} |`, ''].join('\n');
{
  const W = workspace();
  // IMPL-0366:ng(G-1 の前に G-1 の時点の見積りが空欄の企画書は失敗する)
  W.write('docs/project-brief.md', brief({ 教育: '' }));
  let r = W.g1();
  check('入口: G-1 の前は、G-1 の時点の見積りの空欄で失敗する', !r.ok && r.out.includes('「G-1 の時点の見積り」に空欄の区分があります(教育)'), r.out);
  // G-1 を通過した企画書の版を記録する
  W.write('docs/project-brief.md', brief({}));
  const ver = W.commit('docs: 企画書');
  W.write('docs/gates/g1.md', g1Record(ver));
  W.commit('docs: G-1 の判定記録');
  // IMPL-0366:ok(書き換えていない企画書は、上書きを指摘しない)
  r = W.g1();
  check('入口: G-1 の後に列を書き換えていなければ、上書きを指摘しない', !r.out.includes('書き換えられています'), r.out);
  // IMPL-0366:ng(G-1 の後に G-1 の時点の見積りを書き換えた企画書は失敗する)
  W.write('docs/project-brief.md', brief({ 検証: '25時間' }));
  r = W.g1();
  check('入口: G-1 の後に列を書き換えると失敗し、区分と前後の値を出す', !r.ok && r.out.includes('書き換えられています(検証: 10時間 → 25時間)'), r.out);
  // 参照した企画書の版が無い判定記録は、確かめられないことを出す
  W.write('docs/gates/g1.md', g1Record('該当なし'));
  r = W.g1();
  check('入口: 参照した企画書の版が無ければ、確かめられないことを出す', r.out.includes('確かめられません') && !r.out.includes('書き換えられています'), r.out);
  fs.rmSync(W.dir, { recursive: true, force: true });
}

// IMPL-0374: 完了の条件の欄の読み(既定の文との完全な一致だけを見る。文の意味は読まない)
{
  const row = (v) => `- 作業単位の完了の条件: ${v}
- 単位期間の長さ: 2週間
`;
  check('IMPL-0374:ok 既定の文と一致する欄は既定として読む', isDefaultDoneCondition(doneConditionOf(row(DEFAULT_DONE_CONDITION))));
  check('IMPL-0374:ng 別の文の欄は既定として読まない', !isDefaultDoneCondition(doneConditionOf(row('作業単位を指す変更が取り込まれ、受入基準を満たした記録がある'))));
  check('IMPL-0374:ng 様式のままの欄(<…>)・欄なしは既定として読まない', !isDefaultDoneCondition(doneConditionOf(row('<閉じた者の申告以外の記録で示せる条件>'))) && !isDefaultDoneCondition(doneConditionOf('欄なし')));
  check('IMPL-0374:ok 単位期間の長さを日数へ読む(2週間=14、3日=3)。読めない書き方は null', unitPeriodDaysOf(row('x')) === 14 && unitPeriodDaysOf('- 単位期間の長さ: 3日') === 3 && unitPeriodDaysOf('- 単位期間の長さ: 隔週') === null);
}

// IMPL-0801・IMPL-0878・IMPL-0884: 企画書の一般語のみの欄、前案件との同一、立ち上げの順序(入口 check-g1 を一時の git で通す)
{
  const view = (goal, win, alt) => `## 戦略整合(観点1)

| 項目 | 記載 |
| --- | --- |
| 対応する戦略目標 | ${goal} |
| 対応が成立しなくなる条件 | 前提が変わる |

## 自社が勝てる理由(観点2)

| 項目 | 内容 |
| --- | --- |
| 資産・能力 | ${win} |
| 現在の代替手段 | ${alt} |

`;
  const brief2 = (goal, win, alt) => `---
project_id: P-001
version: v1
approver: 承認 花子
status: 承認待ち
---

# 企画書

${view(goal, win, alt)}${costTable({})}`;
  const GOOD = ['成長(中期経営計画 2027 の目標 G3)', '決済基盤の運用実績(2019 年から)', '手作業の表計算'];
  const W = workspace();
  const run = (env = {}) => {
    const r = spawnSync(process.execPath, ['scripts/gate/check-g1.mjs'], { cwd: W.dir, encoding: 'utf8', env: { ...process.env, ...env } });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  // IMPL-0801
  W.write('docs/project-brief.md', brief2('成長', GOOD[1], GOOD[2]));
  let r = run();
  check('IMPL-0801:ng 戦略目標が「成長」のみなら失敗する', !r.ok && r.out.includes('一般語「成長」のみ'), r.out);
  W.write('docs/project-brief.md', brief2(GOOD[0], '知見がある', GOOD[2]));
  r = run();
  check('IMPL-0801:ng 観点2が「知見がある」のみなら失敗する', !r.ok && r.out.includes('一般語「知見がある」のみ'), r.out);
  W.write('docs/project-brief.md', brief2(GOOD[0], GOOD[1], 'ない'));
  r = run();
  check('IMPL-0801:ng 代替手段が「ない」のみなら失敗する', !r.ok && r.out.includes('「ない」のみ'), r.out);
  W.write('docs/project-brief.md', brief2('「成長」。', GOOD[1], '（無し）'));
  r = run();
  check('IMPL-0801:ng 句読点・括弧・全角を除いて一致すれば同じ扱い', !r.ok && r.out.includes('「成長」のみ') && r.out.includes('「ない」のみ'), r.out);
  W.write('docs/project-brief.md', brief2(...GOOD));
  r = run();
  check('IMPL-0801:ok 具体を書いた欄は通る(一般語の検査で止めない)', !r.out.includes('のみです'), r.out);
  const ver0 = W.commit('docs: 企画書');
  // IMPL-0878
  check('IMPL-0878:ok 前案件を与えないときは、確認していない旨を出す', r.out.includes('PREVIOUS_BRIEF') && r.out.includes('確認をしていません'), r.out);
  fs.mkdirSync(path.join(W.dir, 'prev'), { recursive: true });
  W.write('prev/brief.md', brief2('別の戦略目標', '別の資産', '別の手段'));
  r = run({ PREVIOUS_BRIEF: 'prev/brief.md' });
  check('IMPL-0878:ok 異なる文の欄は同一として出さない', !r.out.includes('欄「対応する戦略目標」が前案件') && !r.out.includes('欄「資産・能力」が前案件') && !r.out.includes('欄「現在の代替手段」が前案件'), r.out);
  W.write('prev/brief.md', brief2(GOOD[0], GOOD[1], '別の手段'));
  r = run({ PREVIOUS_BRIEF: 'prev/brief.md' });
  check('IMPL-0878:ng 前案件と同じ文の欄は警告に出し、失敗にはしない', r.out.includes('欄「対応する戦略目標」が前案件の企画書') && r.out.includes('欄「資産・能力」が前案件の企画書') && !r.out.includes('欄「現在の代替手段」が前案件'), r.out);
  W.commit('docs: 前案件');
  r = run({ PREVIOUS_BRIEF: `${ver0}:docs/project-brief.md` });
  check('IMPL-0878:ng git の版(<ref>:<path>)でも読める', r.out.includes('欄「現在の代替手段」が前案件の企画書'), r.out);
  r = run({ PREVIOUS_BRIEF: 'prev/ない.md' });
  check('IMPL-0878:ng 読めない所在は、確認していない旨を出す', r.out.includes('読めないため'), r.out);
  // IMPL-0884: 最初の G-1(通過の記録が無い)だけ順序を比べる。D-0 と企画書を同じコミットに入れて版を作る
  const d0 = (approved, judged) => `---
project_id: P-001
version: v1
approver: 承認 花子
approved_at: ${approved}
approval_scope: x
next_review: 2027-05-01
---

# D-0

## 16. 安全重要度の判定の記録

| 項目 | 値 |
| --- | --- |
| 判定日 | ${judged} |
`;
  let seqNo = 0;
  const versionWith = (approved, judged) => {
    W.write('docs/D-0-governance.md', d0(approved, judged));
    W.write('docs/project-brief.md', `${brief2(...GOOD)}\n<!-- 版 ${++seqNo} -->\n`);
    return W.commit(`docs: D-0 と企画書 ${seqNo}`);
  };
  // 企画書の最後のコミットの日付(今日)より後の判定日を持つ D-0: 逆
  versionWith('2026-01-01', '2999-01-01');
  r = run();
  check('IMPL-0884:ng 節16 の判定日が企画書のコミットの日付より後なら失敗する', !r.ok && r.out.includes('立ち上げの順序が逆です') && r.out.includes('2999-01-01'), r.out);
  versionWith('2026-01-01', '2026-01-02');
  r = run();
  check('IMPL-0884:ok 承認日 ≤ 判定日 ≤ 企画書のコミットの日付なら順序で止めない', !r.out.includes('立ち上げの順序が逆です') && !r.out.includes('確かめられません'), r.out);
  versionWith('2026-03-01', '2026-01-02');
  r = run();
  check('IMPL-0884:ng D-0 の承認日が節16 の判定日より後なら失敗する', !r.ok && r.out.includes('立ち上げの順序が逆です') && r.out.includes('2026-03-01'), r.out);
  versionWith('日付ではない', '日付ではない');
  r = run();
  check('IMPL-0884:ok 読めない日付は確認できないと出し、失敗にしない', !r.out.includes('立ち上げの順序が逆です') && r.out.includes('確認できない日付があります'), r.out);
  // G-1 の通過の記録がある: 順序を機械で比べない。承認し直した D-0・様式 09 で失敗にしない。表示の行を出す
  const NOTE = '立ち上げの順序を機械で比べない';
  const verOk = versionWith('2026-01-01', '2026-01-02');
  W.write('docs/gates/g1.md', g1Record(verOk));
  W.write('docs/D-0-governance.md', d0('2026-03-01', '2026-01-02'));
  W.commit('docs: G-1 と、変化点で承認日を改めた D-0');
  r = run();
  check('IMPL-0884:ok 通過の記録があり、変化点で D-0 を承認し直しても失敗にしない。表示の行が出る', !r.out.includes('立ち上げの順序が逆です') && !r.out.includes('確かめられません') && r.out.includes(NOTE), r.out);
  W.write('docs/safety-risk-assessment.md', '# 安全リスクアセスメント\n\n## 承認\n\n| 作成者 | 承認者 | 承認日 |\n| --- | --- | --- |\n| 作成 太郎 | 承認 花子 | 2999-12-31 |\n');
  W.commit('docs: 通過の後に様式 09 を承認し直す');
  r = run();
  check('IMPL-0884:ok 通過の記録があり、様式 09 を承認し直しても失敗にしない。表示の行が出る', !r.out.includes('立ち上げの順序が逆です') && !r.out.includes('確かめられません') && r.out.includes(NOTE), r.out);
  // 通過の記録が無く、様式 09 の承認日が企画書より後: 逆
  fs.rmSync(path.join(W.dir, 'docs/gates/g1.md'));
  W.commit('docs: G-1 の記録を外す');
  r = run();
  check('IMPL-0884:ng 通過の記録が無く、様式 09 の承認日が企画書のコミットの日付より後なら失敗する', !r.ok && r.out.includes('立ち上げの順序が逆です') && r.out.includes('2999-12-31') && !r.out.includes(NOTE), r.out);
  fs.rmSync(W.dir, { recursive: true, force: true });
}

console.log(`test-brief-estimates: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
