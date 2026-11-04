// 当初の見積りの保存と、見積りと実績の差の記録の検査(brief-estimates.mjs、check-g1、出荷の証跡の集約)の試験。
// process-compass #416 / ADR-0093(標準 第7章 7.7.9 の要求事項3・4)
import { g1EstimateBlank, g1EstimateChanges, briefVersionOf, estimateGapBlank } from './brief-estimates.mjs';
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

console.log(`test-brief-estimates: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
