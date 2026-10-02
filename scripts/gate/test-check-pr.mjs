// G-5 の PR 単位の検査(check-pr)を、一時のリポジトリで試験する。
//
//   node scripts/gate/test-check-pr.mjs
//
// 基底ブランチを1つ作り、場面ごとに PR のブランチを切って変更を積み、analyzePr の結果を期待と比べます。
// 通る場面(誤検出の候補)と落ちる場面の両方を置きます。GitHub へ問い合わせません。PR のコメントへの書き込み
// (--comment)と、実際の GitHub 上での動作は、この試験では確かめていません。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { analyzePr, renderTestChanges } from './check-pr.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-check-pr-'));
const git = (...args) => execFileSync('git', args, { cwd: TMP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true });
  fs.writeFileSync(path.join(TMP, rel), typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n');
};
const remove = (rel) => fs.rmSync(path.join(TMP, rel));
const read = (rel) => fs.readFileSync(path.join(TMP, rel), 'utf8');
const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `export const ${prefix}${i} = ${i};`).join('\n') + '\n';

const LEDGER_HEAD = '# 技術負債台帳\n\n| ID | 区分 | 対象 | 内容 | 受容した理由 | 顕在化の兆候 | 返却の目安 | 状態 | 記録者 | 承認した者 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
const exceptionRow = (id, pr, { state = '未返却', approver = '鈴木 一郎' } = {}) =>
  `| ${id} | 例外 | PR #${pr} | 変更規模の上限(400行)を超える | 一括の移行で分割すると単独で動かない | 移行後の不具合 | 2026-12-31 まで。回収責任者 佐藤 花子 | ${state} | 山田 太郎 | ${approver} |\n`;
const RISK = (v = 'R3') => `## リスク区分\n\n<!-- R1: 事後の取り消しを前提にできない / R2 / R3 -->\n\n${v}\n\n`;
const BODY = (trailers = 'Spec: F-001 / Task-1', risk = RISK()) => `## 変更の概要\n\n説明\n\n## 作成を指示した者\n\n山田 太郎\n\n${risk}## トレーラ(スカッシュのメッセージの末尾になる。消さない)\n\n${trailers}\n`;

// --- 基底ブランチ ---
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'tester');
git('config', 'core.autocrlf', 'false');
const config = {
  configured: true,
  adapters: { stack: 'node' },
  ci: { coverageThreshold: 80 },
  task: { maxChangedLines: 400, maxChangedFiles: 15, selfHealMaxIterations: 3 },
  people: [
    { id: 'p1', name: '山田 太郎', accounts: ['yamada'] },
    { id: 'p2', name: '鈴木 一郎', accounts: ['suzuki'] },
    { id: 'p3', name: '佐藤 花子', accounts: ['sato'] },
  ],
  changeLog: [],
};
write('process.config.json', config);
write('adapters/node.json', fs.readFileSync(path.join(ROOT, 'adapters/node.json'), 'utf8'));
write('.claude/guard.json', fs.readFileSync(path.join(ROOT, '.claude/guard.json'), 'utf8'));
write('.gitattributes', 'src/gen/** linguist-generated\n');
write('.eslintrc.json', '{ "rules": { "no-unused-vars": "error" } }\n');
write('specs/F-001/spec.md', '# 機能仕様: 招待\n');
write('specs/F-001/plan.md', '| ID | 内容 |\n| --- | --- |\n| Task-1 | 招待 |\n| Task-2 | 一覧 |\n');
write('docs/debt-ledger.md', LEDGER_HEAD + exceptionRow('D-001', 7));
write('src/a.js', lines(20));
write('src/fmt.js', lines(50, 'f'));
write('src/gen/old.js', '// @generated\n' + lines(10, 'g'));
write('test/a.test.js', "import { line1 } from '../src/a.js';\ntest('a', () => {\n  expect(line1).toBe(1);\n});\ntest('b', () => {\n  expect(2).toBe(2);\n});\n");
write('test/old.test.js', "test('old', () => {\n  expect(true).toBe(true);\n});\n");
git('add', '-A');
git('commit', '-q', '-m', 'chore: base');

let failures = 0;
let n = 0;
function scenario(name, pr, mutate, expect) {
  n++;
  git('switch', '-q', '-C', `pr-${n}`, 'main');
  mutate();
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', `change ${n}`);
  const r = analyzePr({ root: TMP, base: 'main', pr: { number: 100 + n, title: 'feat: x', body: BODY(), author: 'yamada', ...pr } });
  const problems = expect(r);
  const ok = !problems.length;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${problems.join('\n       ')}\n       errors: ${JSON.stringify(r.errors)}`}`);
  return r;
}
const has = (r, re) => r.errors.some((e) => re.test(e));
const passes = (...extra) => (r) => [...(r.errors.length ? ['失敗するはずがない'] : []), ...extra.flatMap((f) => f(r))];
const failsWith = (re, ...extra) => (r) => [...(has(r, re) ? [] : [`${re} の失敗が出ていない`]), ...extra.flatMap((f) => f(r))];
const testListed = (count) => (r) => (r.testChanges.length === count ? [] : [`既存のテストの変更の件数 ${r.testChanges.length}(期待 ${count})`]);

// ---------------------------------------------------------------- 通る場面(誤検出の候補)
scenario('テストを先に書いた PR(新しいテストの追加だけ。既存のテストは変えない)', {}, () => {
  write('test/b.test.js', "test('new', () => {\n  expect(1).toBe(1);\n});\n");
  write('src/b.js', lines(5, 'b'));
}, passes(testListed(0)));
scenario('閾値だけの PR(既存の除外設定だけを変える)', { body: `閾値の変更\n\n${RISK('R2')}` }, () => {
  write('.eslintrc.json', '{ "rules": { "no-unused-vars": "warn" } }\n');
}, passes((r) => (r.thresholds.changed.length === 1 ? [] : ['閾値の変更として識別していない'])));
scenario('初回の設定(基底に無い閾値のファイルを足し、製品のコードも変える)', {}, () => {
  write('vitest.config.js', 'export default { test: { coverage: { exclude: [] } } };\n');
  write('src/a.js', lines(21));
}, passes((r) => (r.thresholds.initial.includes('vitest.config.js') ? [] : ['初回の設定として識別していない'])));
scenario('生成物・ロックファイル・一括整形を含む大きな PR(算定の対象は上限以内)', {}, () => {
  write('package-lock.json', JSON.stringify({ lock: Array.from({ length: 2000 }, (_, i) => i) }, null, 2));
  write('src/gen/new.js', lines(900, 'n'));
  write('src/gen/old.js', '// @generated\n' + lines(600, 'g'));
  write('src/fmt.js', lines(50, 'f').replace(/ = /g, '  =  '));
  write('src/a.js', lines(30));
}, passes((r) => (r.size.lines <= 400 && r.size.excluded.length >= 4 ? [] : [`算定 ${r.size.lines} 行 / 除外 ${r.size.excluded.length} 件`])));
scenario('上限を超えるが、基底ブランチの台帳にこの PR の例外承認がある', { number: 7 }, () => {
  write('src/big.js', lines(450, 'x'));
}, passes((r) => (r.size.exception?.matched.includes('D-001') ? [] : ['例外承認の行に対応づいていない'])));
scenario('製品のコードを変えない PR(記録だけ)にトレーラ Spec が無い', { body: `判定記録の追加\n\n${RISK()}` }, () => {
  write('docs/gates/g4-F-001.md', '# 判定\n');
}, passes((r) => (r.spec?.skipped ? [] : ['対象外として扱っていない'])));
scenario('依存の更新の bot の PR にトレーラ Spec が無い(人がリスク区分を記入した)', { body: `Bumps x\n\n${RISK('R2')}`, author: 'dependabot[bot]' }, () => {
  write('package.json', '{ "dependencies": { "x": "2.0.0" } }\n');
}, passes());
scenario('トレーラ Spec が末尾の段落にあり、Co-Authored-By と並ぶ', { body: BODY('Spec: F-001 / Task-2\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>') }, () => {
  write('src/a.js', lines(22));
}, passes());
scenario('名前の変更だけの PR(内容は変わらない)', {}, () => {
  git('mv', 'src/fmt.js', 'src/format.js');
}, passes((r) => (r.size.lines === 0 ? [] : [`算定 ${r.size.lines} 行`])));
scenario('基盤だけの PR(package.json・秘匿情報の検査の設定・ロックファイル・雛形)に Spec: setup', { body: BODY('Spec: setup\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>') }, () => {
  write('package.json', '{ "scripts": { "test": "node --test" }, "devDependencies": { "c8": "12.0.0" } }\n');
  write('package-lock.json', '{ "lockfileVersion": 3 }\n');
  write('.secretlintrc.json', '{ "rules": [] }\n');
  write('tests/.gitkeep', '');
}, passes((r) => (r.spec?.setup?.length ? [] : ['Spec: setup の経路として扱っていない'])));

// ---------------------------------------------------------------- 落ちる場面(リスク区分。変更の種類に依らない。#286 N7)
scenario('記録だけの PR にリスク区分の節が無い', { body: '判定記録の追加' }, () => {
  write('docs/gates/g2-F-001.md', '# 判定\n');
}, failsWith(/リスク区分: PR の本文に「## リスク区分」の節がありません/, (r) => (r.spec?.skipped ? [] : ['Spec の検査の対象外として扱っていない'])));
scenario('文書だけの PR で、リスク区分の選択肢を残したまま', { body: BODY('Spec: F-001 / Task-1', RISK('R1 / R2 / R3')) }, () => {
  write('docs/notes.md', '# メモ\n');
}, failsWith(/区分が 3 つ残っています/));
scenario('Spec: setup の PR でリスク区分の記載が無い', { body: BODY('Spec: setup', RISK('')) }, () => {
  write('package.json', '{ "scripts": { "test": "node --test" } }\n');
}, failsWith(/R1 \/ R2 \/ R3 の記載がありません/, (r) => (r.spec?.setup?.length ? [] : ['Spec: setup の経路として扱っていない'])));
scenario('依存の更新の bot の PR にリスク区分が無い', { body: 'Bumps x', author: 'dependabot[bot]' }, () => {
  write('package.json', '{ "dependencies": { "x": "3.0.0" } }\n');
}, failsWith(/リスク区分/));
scenario('製品のコードの PR でリスク区分が無い(トレーラは正しい)', { body: BODY('Spec: F-001 / Task-1', '') }, () => write('src/a.js', lines(21)), failsWith(/リスク区分/));
scenario('リスク区分がコメントの中だけにある', { body: BODY('Spec: F-001 / Task-1', '## リスク区分\n\n<!-- R3 -->\n\n') }, () => write('docs/x.md', 'x\n'), failsWith(/リスク区分/));

// ---------------------------------------------------------------- 落ちる場面(Spec: setup)
scenario('Spec: setup に製品のコードを含める', { body: BODY('Spec: setup') }, () => {
  write('package.json', '{ "scripts": { "test": "node --test" } }\n');
  write('src/a.js', lines(21));
}, failsWith(/Spec: setup は、変更が開発の基盤.*src\/a\.js/));
scenario('基盤だけの PR にトレーラ Spec が無い(Spec: setup の経路を示す)', { body: '## 変更の概要\n\n説明\n' }, () => {
  write('package.json', '{ "scripts": { "test": "node --test" } }\n');
}, failsWith(/`Spec: setup` と書く/));
scenario('Spec: setup が本文の途中にあり、末尾の段落に無い', { body: '## トレーラ\n\nSpec: setup\n\n## 補足\n\n説明\n' }, () => {
  write('package.json', '{ "scripts": { "test": "node --test" } }\n');
}, failsWith(/トレーラ Spec/));

// ---------------------------------------------------------------- 落ちる場面
scenario('上限を超え、同じ PR で台帳に例外承認を足した(基底に無い)', {}, () => {
  write('src/big.js', lines(450, 'x'));
  write('docs/debt-ledger.md', read('docs/debt-ledger.md') + exceptionRow('D-002', 100 + n));
}, failsWith(/変更規模: 変更行数 450/));
scenario('上限を超え、例外承認が無い', {}, () => write('src/big.js', lines(401, 'x')), failsWith(/変更規模/));
scenario('ファイル数の上限を超える', {}, () => {
  for (let i = 0; i < 16; i++) write(`src/m${i}.js`, lines(1, `m${i}_`));
}, failsWith(/変更ファイル数 16/));
scenario('上限を超え、基底の例外承認の行が返却済み', { number: 7 }, () => {
  write('docs/debt-ledger.md', LEDGER_HEAD + exceptionRow('D-001', 7, { state: '返却済' }));
  git('add', '-A');
  git('commit', '-q', '-m', 'ledger');
  git('switch', '-q', 'main');
  git('merge', '-q', '--ff-only', `pr-${n}`);
  git('switch', '-q', `pr-${n}`);
  write('src/big.js', lines(450, 'x'));
}, failsWith(/状態が有効を示す値でない/));
git('reset', '-q', '--hard', 'HEAD');
git('switch', '-q', 'main');
git('reset', '-q', '--hard', 'HEAD~1');
scenario('上限を超え、例外承認の承認した者が PR の作成者', { number: 7, author: 'suzuki' }, () => write('src/big.js', lines(450, 'x')), failsWith(/承認した者が PR の作成者/));
scenario('閾値・除外設定と製品のコードを同じ PR で変える', {}, () => {
  write('.eslintrc.json', '{ "rules": {} }\n');
  write('src/a.js', lines(21));
}, failsWith(/禁止事項6/));
scenario('構成のカバレッジの下限と製品のコードを同じ PR で変える', {}, () => {
  write('process.config.json', { ...config, ci: { coverageThreshold: 60 } });
  write('src/a.js', lines(21));
}, failsWith(/禁止事項6.*process\.config\.json\(ci\)/));
scenario('トレーラ Spec が無い', { body: '## 変更の概要\n\n説明\n' }, () => write('src/a.js', lines(21)), failsWith(/トレーラ `Spec: F-NNN \/ Task-N` が PR の本文にありません/));
scenario('トレーラ Spec が本文の途中にある(様式の冒頭のまま)', { body: '## 対応タスク\n\nSpec: F-001 / Task-1\n\n## 変更の概要\n\n説明\n' }, () => write('src/a.js', lines(21)), failsWith(/末尾の段落にありません/));
scenario('トレーラ Spec が様式の置き場のまま', { body: BODY('Spec: F-xxx / Task-N') }, () => write('src/a.js', lines(21)), failsWith(/形式が違います/));
scenario('トレーラ Spec が実装計画に無いタスクを指す', { body: BODY('Spec: F-001 / Task-9') }, () => write('src/a.js', lines(21)), failsWith(/実装計画 specs\/F-001\/plan.md の表にありません/));
scenario('トレーラ Spec が無い仕様を指す', { body: BODY('Spec: F-404 / Task-1') }, () => write('src/a.js', lines(21)), failsWith(/仕様 specs\/F-404\/spec.md がありません/));

// ---------------------------------------------------------------- 既存のテストの変更(一覧。失敗にしない)
const r1 = scenario('既存のテストの期待値を書き換える(一覧に出る。失敗にはしない)', {}, () => {
  write('test/a.test.js', read('test/a.test.js').replace('expect(line1).toBe(1)', 'expect(line1).toBe(2)'));
  write('src/a.js', lines(21));
}, passes(testListed(1), (r) => (r.testChanges[0]?.assertions.length ? [] : ['期待値の変更の候補が出ていない'])));
scenario('既存のテストを削除する(一覧に出る)', {}, () => {
  remove('test/old.test.js');
  write('src/a.js', lines(21));
}, passes(testListed(1), (r) => (r.testChanges[0]?.kind === '削除' ? [] : [`種別 ${r.testChanges[0]?.kind}`])));
const md = renderTestChanges(r1.testChanges);
if (!md.startsWith('<!-- pit-in:g6-test-changes -->') || !md.includes('test/a.test.js')) {
  failures++;
  console.log('NG   一覧の Markdown に印とファイルが出ていない');
} else console.log('ok   一覧の Markdown に印とファイルが出る');

// ---------------------------------------------------------------- ワークフローの定義
const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/gate-g5.yml'), 'utf8');
const defs = [
  ['ワークフロー: pr-rules が check-pr を呼ぶ', /node scripts\/gate\/check-pr\.mjs/.test(wf)],
  ['ワークフロー: PR の題名と本文を環境変数で渡し、シェルへ展開しない', /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/.test(wf) && !/run:.*github\.event\.pull_request\.(body|title)/.test(wf)],
  ['ワークフロー: 集約(gate-g5)が pr-rules を待つ', /needs: \[[^\]]*pr-rules[^\]]*\]/.test(wf)],
  ['ワークフロー: contract で、この試験を実行する', /node scripts\/gate\/test-check-pr\.mjs/.test(wf)],
  ['ワークフロー: PR の本文の編集(edited)で再実行する', /^\s*pull_request:[^\n]*\r?\n(?:\s*#[^\n]*\n)*\s*types: \[[^\]]*\bedited\b[^\]]*\]/m.test(wf)],
];
for (const [name, ok] of defs) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`PR の検査の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`PR の検査の試験: ${n} 場面と付随の確認が、期待と一致しました`);
