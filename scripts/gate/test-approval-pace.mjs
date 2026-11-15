// 承認までの時間と規模の比の通しの試験(process-compass #355 束4。IMPL-0159・IMPL-0136 の観測)
//
//   node scripts/gate/test-approval-pace.mjs
//
// template の写しを一時のリポジトリへ作り、PR を7件マージし、偽の gh(PATH の先頭に置いた `gh`。test-g5-missing.mjs と同じ流儀)で
// 集約(aggregate-evidence.mjs)を実際に動かす。集約の本体と、size-observation.mjs の出力まで通す。
//   #1 製品のコード 50 行・人の承認が作成から 120 分後
//   #2 文書だけ(docs/)・人の承認が 50 時間後
//   #3 製品のコード 20 行・AI 名義(bot)の承認だけ
//   #4 製品のコード 200 行・人の承認が 600 分後、その後に AI 名義の承認が 5000 分後
//   #5 ワークフロー(強制層)だけ・人の承認が 3 分後。文書だけに数えず、算定行数 0 として比を持たない側へ
//   #6 文書(docs/)と製品のコード 450 行を両方変える・人の承認が 60 分後と 900 分後(最後の人の承認は 900 分)・その後に AI 名義の承認
//   #7 PR の記録(gh)が壊れた応答を返す。観測の母数から黙って消さず、番号で開示する
// 固定する決定:
//   - 人の承認だけを数える(#3 は値を持たず unmeasured、#4 は 600 分)。AI 名義の承認を時間に数えない
//   - 比は規模の区間ごとに 100 行あたりの分で出す。文書だけの変更は比を持たず、件数と時間の区間だけ出す
//   - 承認者を特定する値(login)を evidence.json の観測・品質レポート・外へ渡す開示に出さない
// 偽の gh を PATH に置く形は Windows では動かせない。読み飛ばす(終了コード 0)。Windows の自前の環境では、この通しが黙って抜ける。
// login を観測に出さないことは、Windows でも動く純関数の試験(test-size-observation.mjs)が確かめる。CI の Linux で通しを確かめる。実機の GitHub の挙動は含まない。
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
  { n: 5, files: { '.github/workflows/zz.yml': 'name: zz\non: workflow_dispatch\njobs: {}\n' }, reviews: [{ login: 'alice', bot: false, min: 3 }] },
  { n: 6, files: { 'docs/mixed.md': '# 混在\n\n本文です。\n', 'src/d.js': lines(450) }, reviews: [{ login: 'alice', bot: false, min: 60 }, { login: 'bob', bot: false, min: 900 }, { login: 'review-bot[bot]', bot: true, min: 5000 }] },
  { n: 7, files: { 'src/e.js': lines(10) }, reviews: [{ login: 'alice', bot: false, min: 10 }], broken: true },
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
    state.prs[p.n] = { F, MC: git('rev-parse', 'HEAD'), reviews: p.reviews, broken: p.broken === true };
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
  if (p.broken) { process.stdout.write('{broken'); process.exit(0); }
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
check('試験の前提: 集約が最後まで走り、規模の観測が出る', so !== null && so.total === 6, r.log);
const byRange = Object.fromEntries((pace?.byLines ?? []).map((b) => [b.range, b]));

// IMPL-0159:ok(適合の場面。人の承認だけを数え、規模の区間ごとの比を出す)
check('IMPL-0159:ok 100 行以下の区間: #1 の 120 分 / 50 行 = 240 分 / 100 行(件数 1。AI 名義だけの #3 は数えない)', byRange['100 行以下']?.count === 1 && byRange['100 行以下']?.medianPer100 === 240 && byRange['100 行以下']?.minPer100 === 240, JSON.stringify(pace));
check('IMPL-0159:ok 101〜400 行の区間: #4 は人の承認の 600 分 / 200 行 = 300 分 / 100 行(後の AI 名義の承認 5000 分を数えない)', byRange['101〜400 行']?.count === 1 && byRange['101〜400 行']?.medianPer100 === 300, JSON.stringify(pace));
check('IMPL-0159:ok points は番号・算定行数・分だけ(#1 は 50 行 120 分、#4 は 200 行 600 分、#6 は 450 行 900 分)', JSON.stringify(pace?.points) === JSON.stringify([{ number: 1, lines: 50, minutes: 120 }, { number: 4, lines: 200, minutes: 600 }, { number: 6, lines: 450, minutes: 900 }]), JSON.stringify(pace?.points));
// IMPL-0159:ng(違反の場面。AI 名義の承認だけの PR は値を持たず、unmeasured に出る。数えれば 1 分の比が混ざって落ちる)
check('IMPL-0159:ng AI 名義の承認だけの #3 は値を持たず unmeasured に出る(1 分 / 20 行 = 5 分 / 100 行 が最小に混ざらない)', pace?.unmeasured === 1 && byRange['100 行以下']?.minPer100 === 240 && !pace?.points?.some((p) => p.number === 3), JSON.stringify(pace));
const obsSections = r.report.split('\n####').filter((b) => /^ (承認までの時間と規模の比|文書だけの変更の承認)/.test(b)).map((b) => b.split(/\n#{1,6} /)[0]).join('\n');
check('IMPL-0159:ng 承認者を特定する値(login)を観測・品質レポートの観測の2節・外へ渡す開示に出さない', obsSections.length > 0 && !/alice|bob|claude\[bot\]|review-bot/.test(JSON.stringify(so) + obsSections) && !/alice|bob/.test(r.external), obsSections.length + ' ' + /alice|bob|claude[bot]|review-bot/.exec(JSON.stringify(so) + obsSections)?.[0] + ' ' + /alice|bob/.exec(r.external)?.[0]);
// 最後の人の承認(#6。人の承認が 60 分後と 900 分後の2件。最後は 900 分 / 450 行 = 200 分 / 100 行。最小の 60 分を取ると 13.3 になる)
check('IMPL-0159:ok 人の承認が2件の #6 は最後の承認(900 分)で数える: 401〜1000 行の区間に 1 件、200 分 / 100 行', byRange['401〜1000 行']?.count === 1 && byRange['401〜1000 行']?.medianPer100 === 200, JSON.stringify(pace));
// 文書と製品のコードが混ざった変更(#6)は、文書だけに数えず、比に出る
check('IMPL-0136:ng 文書と製品のコードが混ざった #6 は docOnly に入らず、比に出る(docOnly は #2 の 1 件のまま)', so?.docOnly?.count === 1 && pace?.points?.some((p) => p.number === 6 && p.lines === 450 && p.minutes === 900), JSON.stringify({ doc: so?.docOnly, points: pace?.points }));
// 強制層・構成だけの変更(#5)は、文書だけに数えない。算定行数 0 として比を持たない側に出る
check('IMPL-0136:ng ワークフローだけの #5 は docOnly に入らず、算定行数 0 の側(noDenominator)に数える', so?.docOnly?.count === 1 && pace?.noDenominator === 1 && !pace?.points?.some((p) => p.number === 5), JSON.stringify({ doc: so?.docOnly, pace }));
check('IMPL-0136:ng 品質レポートの文書だけの行に、強制層・構成を含まない旨と件数 1 を出す', /散文の文書だけの変更\(文書の置き場と直下の \*\.md。強制層・構成は含まない\) 1 件/.test(r.report), r.report.slice(0, 300));
// PR の記録を読めなかった #7 は、母数から黙って消さず、番号で開示する
check('IMPL-0159:ng PR の記録を読めなかった #7 は、観測に入らなかったものとして番号で開示する(evidence.json と品質レポート)', JSON.stringify(so?.notObserved) === '[7]' && /観測に入らなかったもの 1 件\(#7\)/.test(r.report), JSON.stringify({ n: so?.notObserved, log: r.log.slice(-200) }));

// IMPL-0136:ok(観測の場面。文書だけの変更は件数と時間の区間だけ。比を持たない)
check('IMPL-0136:ok 文書だけの #2(50 時間)は docOnly に 1 件、96 時間以内の区間。approvalPace に入らない(noDenominator の 1 件は #5 のワークフローだけの変更)', so?.docOnly?.count === 1 && so?.docOnly?.hours?.join() === '0,0,1,0' && pace?.noDenominator === 1, JSON.stringify(so?.docOnly));
check('IMPL-0136:ok 保証の開示に2つの見出し(観測。判定でない)を出す', /承認までの時間と規模の比\(観測。/.test(r.report) && /文書だけの変更の承認までの時間\(観測。SLA の判定ではない/.test(r.report), r.report.slice(0, 300));
// IMPL-0136:ng(違反の場面。「超過」の語と件数を出さない)
const section = r.report.split('\n').filter((l) => /承認までの時間|文書だけ/.test(l)).join('\n');
check('IMPL-0136:ng 文書だけの変更の観測に「超過」の語を(見出しの定型句を除いて)出さず、前回との比較を出さない', section.length > 0 && !/超過/.test(section.replace(/それを超える値から超過は読めない/g, '')) && !/前回/.test(section.replace(/前回との比較は出さない/g, '')), section);

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\n承認までの時間と規模の比の通しの試験: すべて通過');
