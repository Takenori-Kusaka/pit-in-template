// 承認までの時間と規模の比の通しの試験(process-compass #355 束4。IMPL-0159・IMPL-0136 の観測)
//
//   node scripts/gate/test-approval-pace.mjs
//
// template の写しを一時のリポジトリへ作り、PR を4件マージし、偽の gh(PATH の先頭に置いた `gh`。test-g5-missing.mjs と同じ流儀)で
// 集約(aggregate-evidence.mjs)を実際に動かす。集約の本体と、size-observation.mjs の出力まで通す。
//   #1 製品のコード 50 行・人の承認が作成から 120 分後
//   #2 文書だけ(docs/)・人の承認が 50 時間後
//   #3 製品のコード 20 行・AI 名義(bot)の承認だけ
//   #4 製品のコード 200 行・人の承認が 600 分後、その後に AI 名義の承認が 5000 分後
// 固定する決定:
//   - 人の承認だけを数える(#3 は値を持たず unmeasured、#4 は 600 分)。AI 名義の承認を時間に数えない
//   - 比は規模の区間ごとに 100 行あたりの分で出す。文書だけの変更は比を持たず、件数と時間の区間だけ出す
//   - 承認者を特定する値(login)を evidence.json の観測・品質レポート・外へ渡す開示に出さない
// 偽の gh を PATH に置く形は Windows では動かせない。読み飛ばし、CI の Linux で確かめる。実機の GitHub の挙動は含まない。
//
// IMPL-0159・IMPL-0136 は check=manual のため、標準の実装マークは test= を持たない。ここの目印は通しの場面の対を示すだけで、
// check-impl.mjs が数える目印ではない

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : `\n       ${String(detail).slice(0, 700)}`}`);
  if (!cond) failed++;
}

if (process.platform === 'win32') {
  console.log('SKIP 集約の通し(PATH に偽の gh を置く形)は Windows では動かせないため行いません(CI の Linux で確かめる)');
  process.exit(0);
}

const lines = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};\n`).join('');
const PRS = [
  { n: 1, files: { 'src/a.js': lines(50) }, reviews: [{ login: 'alice', bot: false, min: 120 }] },
  { n: 2, files: { 'docs/guide.md': '# 手引き\n\n本文です。\n' }, reviews: [{ login: 'alice', bot: false, min: 3000 }] },
  { n: 3, files: { 'src/b.js': lines(20) }, reviews: [{ login: 'claude[bot]', bot: true, min: 1 }] },
  { n: 4, files: { 'src/c.js': lines(200) }, reviews: [{ login: 'alice', bot: false, min: 600 }, { login: 'review-bot[bot]', bot: true, min: 5000 }] },
];

function runAggregate() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-e2e-'));
  const work = path.join(tmp, 'repo');
  const root = path.join(here, '..', '..');
  const list = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\n').filter(Boolean);
  for (const f of list) {
    if (!fs.existsSync(path.join(root, f))) continue;
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(work, f));
  }
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: work, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main', '.');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('tag', 'v0');
  const body = '## 変更の概要\n\nx\n\n## 検証方法と結果\n\n単体テストを実行した\n\n## リスク区分\n\nR3\n';
  const state = { body, prs: {} };
  for (const p of PRS) {
    git('checkout', '-q', '-b', `feat${p.n}`, 'main');
    for (const [rel, text] of Object.entries(p.files)) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', `feat: pr${p.n}`);
    const F = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', `Merge pull request #${p.n} from o/feat${p.n}`, `feat${p.n}`);
    state.prs[p.n] = { F, MC: git('rev-parse', 'HEAD'), reviews: p.reviews };
  }
  const statePath = path.join(tmp, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
if (a[0] === 'pr' && a[1] === 'view') {
  const p = st.prs[a[2]];
  if (!p) { process.stderr.write('no pr'); process.exit(1); }
  const t0 = Date.parse('2026-03-01T00:00:00Z');
  const reviews = p.reviews.map((r, i) => ({ id: 'R' + a[2] + i, author: { login: r.login, is_bot: r.bot }, authorAssociation: 'MEMBER', state: 'APPROVED', body: '', submittedAt: new Date(t0 + r.min * 60000).toISOString(), commit: { oid: p.F } }));
  const full = { number: Number(a[2]), title: 'x', author: { login: 'author1' }, reviews, body: st.body, mergeCommit: { oid: p.MC }, commits: [{ oid: p.F }], labels: [], createdAt: '2026-03-01T00:00:00Z', mergedAt: '2026-04-01T00:00:00Z', headRefOid: p.F, headRefName: 'feat' + a[2] };
  process.stdout.write(JSON.stringify(a.includes('--json') && a[a.indexOf('--json') + 1].includes('statusCheckRollup') ? { ...full, statusCheckRollup: [] } : full));
  process.exit(0);
}
if (a[0] === 'api' && a[1].includes('check-runs')) { process.stdout.write(JSON.stringify({ check_runs: [] })); process.exit(0); }
if (a[0] === '--version') { process.stdout.write('gh version 2.0.0 (fake)\\n'); process.exit(0); }
process.stderr.write('fake gh: unsupported ' + a.join(' ')); process.exit(1);
`,
    { mode: 0o755 }
  );
  const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs', '--from', 'v0', '--to', 'main'], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, FAKE_STATE: statePath, GITHUB_REPOSITORY: 'o/r' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const readText = (n) => (fs.existsSync(path.join(work, 'evidence', n)) ? fs.readFileSync(path.join(work, 'evidence', n), 'utf8') : '');
  let ev = null;
  try {
    ev = JSON.parse(readText('evidence.json'));
  } catch {
    ev = null;
  }
  const out = { ev, log: `${r.stdout}${r.stderr}`.slice(-800), report: readText('quality-report.md'), external: readText('assurance-disclosure.external.md') };
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

const r = runAggregate();
const so = r.ev?.assurance?.sizeObservation ?? null;
const pace = so?.approvalPace ?? null;
check('試験の前提: 集約が最後まで走り、規模の観測が出る', so !== null && so.total === 4, r.log);
const byRange = Object.fromEntries((pace?.byLines ?? []).map((b) => [b.range, b]));

// IMPL-0159:ok(適合の場面。人の承認だけを数え、規模の区間ごとの比を出す)
check('IMPL-0159:ok 100 行以下の区間: #1 の 120 分 / 50 行 = 240 分 / 100 行(件数 1。AI 名義だけの #3 は数えない)', byRange['100 行以下']?.count === 1 && byRange['100 行以下']?.medianPer100 === 240 && byRange['100 行以下']?.minPer100 === 240, JSON.stringify(pace));
check('IMPL-0159:ok 101〜400 行の区間: #4 は人の承認の 600 分 / 200 行 = 300 分 / 100 行(後の AI 名義の承認 5000 分を数えない)', byRange['101〜400 行']?.count === 1 && byRange['101〜400 行']?.medianPer100 === 300, JSON.stringify(pace));
check('IMPL-0159:ok points は番号・算定行数・分だけ(#1 は 50 行 120 分、#4 は 200 行 600 分)', JSON.stringify(pace?.points) === JSON.stringify([{ number: 1, lines: 50, minutes: 120 }, { number: 4, lines: 200, minutes: 600 }]), JSON.stringify(pace?.points));
// IMPL-0159:ng(違反の場面。AI 名義の承認だけの PR は値を持たず、unmeasured に出る。数えれば 1 分の比が混ざって落ちる)
check('IMPL-0159:ng AI 名義の承認だけの #3 は値を持たず unmeasured に出る(1 分 / 20 行 = 5 分 / 100 行 が最小に混ざらない)', pace?.unmeasured === 1 && byRange['100 行以下']?.minPer100 === 240 && !pace?.points?.some((p) => p.number === 3), JSON.stringify(pace));
check('IMPL-0159:ng 承認者を特定する値(login)を観測・品質レポート・外へ渡す開示に出さない', !/alice|claude\[bot\]|review-bot/.test(JSON.stringify(so)) && !/alice/.test(r.external), JSON.stringify(so).slice(0, 300));
// IMPL-0136:ok(観測の場面。文書だけの変更は件数と時間の区間だけ。比を持たない)
check('IMPL-0136:ok 文書だけの #2(50 時間)は docOnly に 1 件、96 時間以内の区間。approvalPace に入らない', so?.docOnly?.count === 1 && so?.docOnly?.hours?.join() === '0,0,1,0' && pace?.noDenominator === 0, JSON.stringify(so?.docOnly));
check('IMPL-0136:ok 保証の開示に2つの見出し(観測。判定でない)を出す', /承認までの時間と規模の比\(観測。/.test(r.report) && /文書だけの変更の承認までの時間\(観測。SLA の判定ではない/.test(r.report), r.report.slice(0, 300));
// IMPL-0136:ng(違反の場面。「超過」の語と件数を出さない)
const section = r.report.split('\n').filter((l) => /承認までの時間|文書だけ/.test(l)).join('\n');
check('IMPL-0136:ng 文書だけの変更の観測に「超過」の語を出さず、前回との比較を出さない', !/(を超過|超過した|超過 [0-9])/.test(section.replace(/それを超える値から超過は読めない/g, '')) && !/前回/.test(section.replace(/前回との比較は出さない/g, '')), section);

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\n承認までの時間と規模の比の通しの試験: すべて通過');
