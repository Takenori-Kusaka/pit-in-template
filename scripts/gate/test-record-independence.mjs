// 取り込んだ後に作った G-6 の判定記録の独立性を、出荷判定の証跡の集約(aggregate-evidence.mjs)の通しで試験する(標準 第4章 G-6「記録」、G-7 基準5)。
//
//   node scripts/gate/test-record-independence.mjs
//
// テンプレートの全ファイルを一時のディレクトリへ写し、PR を経ないコミットと G-6・G-7 の判定記録を積んで集約を実行する。次を確かめる。
//   - G-7 の判定記録より前に足した記録は、独立した人の確認に数える
//   - G-7 の判定記録より後に足した記録は数えない(記録用ブランチを経る記録は、記録用ブランチの祖先の関係で照らす。コミットの日付で照らさない)
//   - 記録を足したコミットのアカウントが判定者と対応づかない記録は数えない。署名を要する構成で署名を確かめられない記録も数えない
//   - 承認権限の一時制限は、記録を足した時点でも照らす(取り込んだ時点で制限が無くても、記録を足した時点で範囲に触れていれば2名を要する)
//   - 署名の無い構成では、作成者の名義で照らしたことと、その名義が書き手の設定で偽れることを保証の開示に出す
//   - PR の経路(偽の gh を PATH の先頭に置く。Windows では読み飛ばし、Linux で確かめる)
// GitHub へ問い合わせない。リポジトリの状態を変えない。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig } from '../init/generate-profile.mjs';
import { copyTemplateTree } from './template-copy.mjs';

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
}
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

const ANSWERS = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes', 'q-biz-phase': 'growth',
};
// 乙(p1)が開発者の席(作成を指示した者)、丙(p2)が独立レビュアの席、丁(p3)が出荷判定者
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
const WHO = { 乙: { name: '名簿 乙', email: 'acc1@example.com' }, 丙: { name: '名簿 丙', email: 'acc2@example.com' }, 丁: { name: '名簿 丁', email: 'acc3@example.com' }, bot: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' } };

const g6 = (target, judge) =>
  `# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | G-6 独立レビュー |\n| 対象 | ${target} |\n| 判定者 | ${judge} |\n| 判定日時 | 2026-11-20 10:00 |\n| 結果 | 通過 |\n| 確定の形態 | 協働 |\n| 参照した D-0 の版 | 該当なし |\n| 変更のリスク区分 | R2 |\n| リスク区分を確定した者 | 名簿 丁 |\n| 期限内か | はい |\n\n## 挙動要約\n\n一覧の絞り込みに状態の項目が増え、既存の並びは変わらないことを確かめた。\n`;
const g7 = '# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | G-7 出荷判定 |\n| 対象 | v1.0.0 |\n| 判定者 | 名簿 丁 |\n| 判定日時 | 2026-11-10 10:00 |\n| 結果 | 通過 |\n| 確定の形態 | 人確定 |\n| 参照した D-0 の版 | 該当なし |\n';

function workspace({ answers = {}, mutate = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-record-indep-'));
  copyTemplateTree(dir, { skip: SKIP });
  const config = quiet(() => buildConfig({ ...ANSWERS, ...answers }, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
  if (mutate) mutate(config);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('process.config.json', JSON.stringify(config, null, 2) + '\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  // 統合のコミットには committer の名義が要る。名義を設定していない環境(CI)でも動くよう、試験の場所にだけ置く(各コミットの名義は commit が環境変数で渡す)
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  git('add', '-A');
  execFileSync('git', ['-c', 'user.name=名簿 乙', '-c', 'user.email=acc1@example.com', 'commit', '-q', '-m', 'chore: fixture'], { cwd: dir });
  // by: WHO のキー。date は作成者・コミッタの日付(記録の前後の判定には使わないことを、日付を逆にして確かめる)
  const commit = (subject, trailers, files, by, date = '2026-11-01T10:00:00+09:00') => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git('add', '-A');
    const env = { ...process.env, GIT_AUTHOR_NAME: WHO[by].name, GIT_AUTHOR_EMAIL: WHO[by].email, GIT_COMMITTER_NAME: WHO[by].name, GIT_COMMITTER_EMAIL: WHO[by].email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    execFileSync('git', ['commit', '-q', '-m', trailers ? `${subject}\n\n${trailers}` : subject], { cwd: dir, env });
    return git('rev-parse', 'HEAD').trim();
  };
  const run = () => {
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' } });
    const report = fs.existsSync(path.join(dir, 'evidence/quality-report.md')) ? fs.readFileSync(path.join(dir, 'evidence/quality-report.md'), 'utf8') : '';
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, report };
  };
  return { dir, git, write, commit, run, done: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

const gapOf = (out, sha) => out.split('\n').filter((l) => l.includes(sha.slice(0, 7)) && /独立した人の確認を経ていません/.test(l));
const change = (w) => w.commit('feat: filter', 'Risk: R2\nVerification: 手元で試験を実行し、通過を確かめた', { 'src/list.js': 'export const f = 1;\n' }, '乙');
const g6File = (x) => `docs/gates/g6-${x.slice(0, 7)}.md`;

// --- PR を経ないコミットの経路 ---
{
  // G-7 の前に足した記録は数える(対照)。コミットの日付は G-7 より後にして、日付で照らしていないことも確かめる
  const w = workspace();
  const x = change(w);
  check('試験の前提: 記録が無ければ、独立した人の確認を経ていない変更になる', gapOf(w.run().out, x).length === 1);
  w.commit('docs: g6', '', { [g6File(x)]: g6(x.slice(0, 8), '名簿 丙') }, '丙', '2026-12-01T10:00:00+09:00');
  w.commit('docs: g7', '', { 'docs/gates/g7-v1.0.0.md': g7 }, '丁', '2026-11-10T10:00:00+09:00');
  const r = w.run();
  // IMPL-1068:ok(適合の入力: 出荷判定の記録より前に、判定者本人が足した G-6 の判定記録は、独立した人の確認に数える)
  check('G-7 の前に足した記録は数える(コミットの日付が G-7 より後でも、履歴の前後で照らす)', gapOf(r.out, x).length === 0, gapOf(r.out, x).join('\n') || r.out.slice(-600));
  check('署名の無い構成: 足し手を作成者の名義で照らしたことと、その名義が書き手の設定で偽れることを保証の開示に出す', /作成者の名義は書き手が設定できるため、署名の無い構成の一致は他人の名義を使った書き込みを防がない/.test(r.report) && /署名者 0 件 \/ 作成者の名義 1 件/.test(r.report), r.report.split('\n').filter((l) => /足したコミット/.test(l)).join('\n') || 'no row');
  w.done();
}
{
  // G-7 の後に足した記録は数えない。コミットの日付は G-7 より前にして、日付で照らしていないことも確かめる
  const w = workspace();
  const x = change(w);
  w.commit('docs: g7', '', { 'docs/gates/g7-v1.0.0.md': g7 }, '丁', '2026-11-10T10:00:00+09:00');
  w.commit('docs: g6 after shipment', '', { [g6File(x)]: g6(x.slice(0, 8), '名簿 丙') }, '丙', '2026-11-02T10:00:00+09:00');
  const r = w.run();
  // IMPL-1068:ng(違反の入力: 出荷判定の記録より後に足した G-6 の判定記録は、独立した人の確認に数えない)
  check('G-7 の後に足した記録は数えない(日付が G-7 より前でも)', gapOf(r.out, x).length === 1 && /出荷判定\(G-7\)の記録 docs\/gates\/g7-v1\.0\.0\.md より後に足されている/.test(r.out), gapOf(r.out, x).join('\n') || r.out.slice(-600));
  w.done();
}
{
  // 足し手が判定者と対応づかない記録(判定者の欄に別の人を書く)は数えない
  const w = workspace();
  const x = change(w);
  w.commit('docs: g6 by someone else', '', { [g6File(x)]: g6(x.slice(0, 8), '名簿 丙') }, '乙');
  const r = w.run();
  check('記録を足したコミットの作成者が判定者と違えば数えない', gapOf(r.out, x).length === 1 && /作成者\(名簿 乙\)が、判定者 名簿 丙 と対応づかない/.test(r.out), gapOf(r.out, x).join('\n') || r.out.slice(-600));
  w.done();
}
{
  // 署名を要する構成(規制業)では、署名をホスティングの検証で確かめられない記録は数えない(ホスティングを読めない実行)
  const w = workspace({ answers: { 'q-quality': 'quality-regulated' } });
  const x = change(w);
  w.commit('docs: g6', '', { [g6File(x)]: g6(x.slice(0, 8), '名簿 丙') }, '丙');
  const r = w.run();
  check('署名を要する構成で署名を確かめられない記録は数えない', gapOf(r.out, x).length === 1 && /署名を、ホスティングの検証で確かめられない/.test(r.out), gapOf(r.out, x).join('\n') || r.out.slice(-600));
  w.done();
}
{
  // 承認権限の一時制限: 取り込んだ時点では制限が無く、記録を足した時点で範囲に触れていれば、2名を要する(厳しいほうを採る)
  const restrictionAt = '2026-11-15T09:00:00+09:00';
  const w = workspace({
    mutate: (c) => {
      c.changeLog = [...(c.changeLog ?? []), { kind: 'notice', date: '2026-11-15', at: restrictionAt, event: 'restriction', notice: { reasons: ['一時制限の発動'], to: '名簿 丁' }, restriction: { id: 'R-1', cause: '7.9.1-1', paths: ['src/**'], basis: 'evidence/miss.md' } }];
    },
  });
  const x = change(w); // 2026-11-01 に取り込み。制限の発動(11-15)より前
  w.commit('docs: g6 after restriction', '', { [g6File(x)]: g6(x.slice(0, 8), '名簿 丙') }, '丙', '2026-11-20T10:00:00+09:00');
  const r = w.run();
  check('制限は記録を足した時点でも照らす: 取り込んだ後・記録の前に制限を受けた範囲の記録は、単独で数えない', gapOf(r.out, x).length === 1 && /承認権限の一時制限/.test(r.out.split('\n').filter((l) => l.includes(x.slice(0, 7))).join('\n')), r.out.split('\n').filter((l) => l.includes(x.slice(0, 7))).join('\n') || r.out.slice(-600));
  w.done();
}
{
  // 記録用ブランチを経る記録: 基底ブランチの複製は出荷の取り込みで同じコミットに入る。前後は記録用ブランチの祖先の関係で照らす
  const build = (order) => {
    const w = workspace();
    const x = change(w);
    const shot = (label) => w.git('rev-parse', label).trim();
    const g6Rel = `docs/gates/g6-${x.slice(0, 7)}.md`;
    const g6Text = g6(x.slice(0, 8), '名簿 丙');
    // 記録用ブランチ(孤立)。足し手は、G-6 は丙、G-7 は丁
    w.git('checkout', '-q', '--orphan', 'records');
    w.git('rm', '-rfq', '.');
    spawnSync('git', ['clean', '-fdxq'], { cwd: w.dir });
    const putG6 = () => w.commit('records: g6', '', { [`records/gates/g6-${x.slice(0, 7)}.md`]: g6Text }, '丙');
    const putG7 = () => w.commit('records: g7', '', { 'records/gates/g7-v1.0.0.md': g7 }, '丁');
    if (order === 'g6-first') { putG6(); putG7(); } else { putG7(); putG6(); }
    w.git('checkout', '-q', 'main');
    // 出荷の取り込み: 2 つの複製を 1 つのコミット(機械の複製)で基底ブランチへ入れる
    w.commit('chore: copy gate records', '', { [g6Rel]: g6Text, 'docs/gates/g7-v1.0.0.md': g7 }, 'bot');
    void shot;
    return { w, x };
  };
  const a = build('g6-first');
  const ra = a.w.run();
  check('記録用ブランチ: G-6 が G-7 より前なら数える(基底ブランチの複製は同じコミットでも、足し手は記録用ブランチのコミットで照らす)', gapOf(ra.out, a.x).length === 0, gapOf(ra.out, a.x).join('\n') || ra.out.slice(-600));
  a.w.done();
  const b = build('g7-first');
  const rb = b.w.run();
  check('記録用ブランチ: G-6 が G-7 より後なら数えない(基底ブランチの複製が同じコミットでも)', gapOf(rb.out, b.x).length === 1 && /出荷判定\(G-7\)の記録 docs\/gates\/g7-v1\.0\.0\.md より後に足されている/.test(rb.out), gapOf(rb.out, b.x).join('\n') || rb.out.slice(-600));
  b.w.done();
}

{
  // 出荷判定(G-7)の記録のコミットを引けない(統合のコミットだけが足した記録。どの親にも無いので足したコミットを引けない)。前後を読めないので、足した記録は数えない側へ倒す
  const w = workspace();
  const x = change(w);
  w.commit('docs: g6', '', { [g6File(x)]: g6(x.slice(0, 8), '名簿 丙') }, '丙');
  w.git('checkout', '-q', '-b', 'side');
  w.commit('docs: side', '', { 'docs/side.md': '# side\n' }, '丁');
  w.git('checkout', '-q', 'main');
  w.commit('docs: main', '', { 'docs/main.md': '# main\n' }, '丁');
  w.git('merge', '-q', '--no-commit', '--no-ff', 'side');
  w.commit('merge: side', '', { 'docs/gates/g7-v1.0.0.md': g7 }, '丁');
  const r = w.run();
  check('G-7 の記録のコミットを引けないときは、足した G-6 の記録を数えない(履歴から読めない)', gapOf(r.out, x).length === 1 && /履歴から読めない/.test(r.out), gapOf(r.out, x).join('\n') || r.out.slice(-600));
  w.done();
}
{
  // まだコミットしていない G-7 の記録(作業ツリーにだけある)は、前後を照らす相手が無いものとして従来どおり扱う(G-6 の記録の数え方を変えない)
  const w = workspace();
  const x = change(w);
  w.commit('docs: g6', '', { [g6File(x)]: g6(x.slice(0, 8), '名簿 丙') }, '丙');
  w.write('docs/gates/g7-v1.0.0.md', g7);
  const r = w.run();
  check('コミットしていない G-7 の記録があっても、足した G-6 の記録の数え方は従来どおり(数える)', gapOf(r.out, x).length === 0, gapOf(r.out, x).join('\n') || r.out.slice(-600));
  w.done();
}

// --- PR の経路(偽の gh。Windows では PATH の先頭に置いた gh を実行できないため読み飛ばし、Linux で確かめる) ---
const CAN_E2E = process.platform !== 'win32';
function prWorkspace(order) {
  const w = workspace();
  const git = w.git;
  git('checkout', '-q', '-b', 'feat');
  w.write('src/list.js', 'export const f = 1;\n');
  git('add', '-A');
  execFileSync('git', ['-c', 'user.name=名簿 乙', '-c', 'user.email=acc1@example.com', 'commit', '-q', '-m', 'feat: filter'], { cwd: w.dir });
  const F = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from o/feat', 'feat');
  const MC = git('rev-parse', 'HEAD').trim();
  const g6Text = g6('PR #7', '名簿 丙');
  if (order === 'g6-first') {
    w.commit('docs: g6', '', { 'docs/gates/g6-pr7.md': g6Text }, '丙');
    w.commit('docs: g7', '', { 'docs/gates/g7-v1.0.0.md': g7 }, '丁');
  } else {
    w.commit('docs: g7', '', { 'docs/gates/g7-v1.0.0.md': g7 }, '丁');
    w.commit('docs: g6 after shipment', '', { 'docs/gates/g6-pr7.md': g6Text }, '丙');
  }
  const body = '## 変更の概要\n\nx\n\n## 検証方法と結果\n\n単体テストを実行した\n\n## リスク区分\n\nR2\n\n## 作成を指示した者\n\n名簿 乙\n';
  const bin = path.join(w.dir, '..', `${path.basename(w.dir)}-bin`);
  fs.mkdirSync(bin, { recursive: true });
  const state = path.join(bin, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ MC, F, body }));
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
if (a[0] === 'pr' && a[1] === 'view') {
  const full = { number: 7, title: 'feat: filter', author: { login: 'acc1' }, reviews: [], body: st.body, mergeCommit: { oid: st.MC }, commits: [{ oid: st.F }], labels: [], createdAt: '2026-11-01T00:00:00Z', mergedAt: '2026-11-01T01:00:00Z', headRefOid: st.F, headRefName: 'feat' };
  process.stdout.write(JSON.stringify({ ...full, statusCheckRollup: [] }));
  process.exit(0);
}
if (a[0] === '--version') { process.stdout.write('gh version 2.0.0 (fake)\\n'); process.exit(0); }
process.stderr.write('fake gh: unsupported ' + a.join(' ')); process.exit(1);
`,
    { mode: 0o755 }
  );
  const run = () => {
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], { cwd: w.dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_STATE: state, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'x', GITHUB_TOKEN: 'x' } });
    return `${r.stdout ?? ''}${r.stderr ?? ''}`;
  };
  return { w, run, bin };
}
if (CAN_E2E) {
  const a = prWorkspace('g6-first');
  const oa = a.run();
  check('PR の経路: G-7 の前に足した記録は数える', !/PR #7[^\n]*独立した人の確認を経ていません/.test(oa), oa.split('\n').filter((l) => /#7/.test(l)).join('\n') || oa.slice(-600));
  a.w.done();
  fs.rmSync(a.bin, { recursive: true, force: true });
  const b = prWorkspace('g7-first');
  const ob = b.run();
  check('PR の経路: G-7 の後に足した記録は数えない', /PR #7[^\n]*独立した人の確認を経ていません/.test(ob), ob.split('\n').filter((l) => /#7/.test(l)).join('\n') || ob.slice(-600));
  b.w.done();
  fs.rmSync(b.bin, { recursive: true, force: true });
} else {
  console.log('skip PR の経路の通し(Windows では偽の gh を実行できない。Linux の CI で確かめる)');
}

console.log('');
if (failures) {
  console.log(`取り込んだ後の G-6 の判定記録の独立性の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`取り込んだ後の G-6 の判定記録の独立性の試験: ${checks} 件が期待と一致しました`);
