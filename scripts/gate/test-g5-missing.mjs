// ホスティングから gate-g5 の結果を読めない PR の欠落の文の試験(process-compass #333 / ADR-0135。IMPL-0244)
//
//   node scripts/gate/test-g5-missing.mjs
//
// 固定する決定:
//   - 写しが gate-g5 の結論を持つ(found: true)なら保持切れの可能性、写しにも check run が無い(found: false)なら
//     必須チェックを経ていない可能性、写しの欄が無い・読めなかった(found: null)なら区別できない旨を出す
//   - どの場合も欠落に数える。写しの値で G-5 の充足に数えない(文にそう書く)
//   - 日数は表示にだけ使う(分岐に使わない)。時刻は引数で渡す(時計に依らない)
//   - record-copy.yml は checks: read を持ち、head の gate-g5 の check run を読み、読めなくても写しの手順を失敗させない

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { g5MissingText, g5TriggerVerdict, g5TriggerGapText } from './aggregate-evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
}

const base = { number: 12, recordFound: true, mergedAt: '2026-08-01T00:00:00Z', now: '2026-11-15T00:00:00Z' };

// IMPL-0244:ng(違反側。読めない G-5 を書き分けず、または充足に数える形を出さない)
{
  const t = g5MissingText({ ...base, copyG5: { found: true, id: 99, status: 'completed', conclusion: 'success', completed_at: '2026-08-01T00:10:00Z', head_sha: 'abc' } });
  check('IMPL-0244:ng 写しに結論がある: 保持切れの可能性の文が出る', /保持期間を過ぎて消えた可能性/.test(t) && /success/.test(t) && /check run 99/.test(t));
  check('IMPL-0244:ng 写しに結論がある: 充足に数えない旨が出る', /充足には数えません/.test(t) && /マージから 106 日/.test(t));
}
{
  const t = g5MissingText({ ...base, copyG5: { found: false } });
  check('IMPL-0244:ng 写しにも check run が無い: 必須チェックを経ていない可能性の文が出る', /必須チェックを経ずにマージされた可能性/.test(t) && /写しにも gate-g5 の check run がありません/.test(t) && !/保持期間を過ぎて消えた可能性があります/.test(t));
}
{
  const t = g5MissingText({ ...base, copyG5: null });
  check('IMPL-0244:ng 写しの欄が無い: 区別できない旨が出る', /区別できません/.test(t) && /写しが無い/.test(t));
  const t2 = g5MissingText({ ...base, copyG5: { found: null, read_error: 'HTTP 403' } });
  check('IMPL-0244:ng 写しの取り出しで読めなかった: 区別できない旨が出る', /区別できません/.test(t2));
}
{
  const t = g5MissingText({ number: 7, recordFound: false, fetchError: 'HTTP 502', copyG5: { found: true, conclusion: 'success' } });
  check('IMPL-0244:ng PR の記録を取得できない場合の文は従来どおり(写しで分岐しない)', /PR の記録を gh で取得できず\(HTTP 502\)/.test(t) && !/保持期間/.test(t));
}
{
  const t = g5MissingText({ ...base, mergedAt: null, copyG5: { found: true, conclusion: 'success' } });
  check('IMPL-0244:ng マージの時刻が無ければ日数の括弧を省く(分岐に使わない)', /保持期間を過ぎて消えた可能性があります。/.test(t) && !/マージから/.test(t));
}

{
  const t = g5MissingText({ ...base, copyG5: { found: true, id: 5, status: 'in_progress', conclusion: null } });
  check('IMPL-0244:ng 写しの結論が null(実行中)なら状態を文に出す', /状態 in_progress/.test(t) && /充足には数えません/.test(t));
}

// 集約の通し。template の写しを一時のリポジトリへ作り、PR #7 のマージと記録用ブランチの写しを置き、偽の gh(PATH の先頭に置いた `gh`。
// test-material-records-more.mjs と同じ流儀。集約のコードには試験用の分岐を持たせない)で集約を実際に動かす。ホスティングの rollup と check-runs の応答、写しの checks.gate_g5 を変えて、欠落と集計を確かめる。
// 実装を壊すと落ちること(写しの値で充足に数える・欠落に入れない・書き分けをやめる)は、この通しが確かめる
// PATH に偽の gh を置く形は Windows では動かせない。既存の試験と同じく読み飛ばし、CI の Linux で確かめる
const CAN_E2E = process.platform !== 'win32';
function runAggregate({ copy, rollup, prevSource = null, runs = 'pr' }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g5e2e-'));
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
  git('checkout', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(work, 'notes-feat.txt'), 'x\n');
  git('add', 'notes-feat.txt');
  git('commit', '-q', '-m', 'feat: x');
  const F = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from o/feat', 'feat');
  const MC = git('rev-parse', 'HEAD');
  const body = '## 変更の概要\n\nx\n\n## 検証方法と結果\n\n単体テストを実行した\n\n## リスク区分\n\nR3\n';
  const state = path.join(tmp, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ MC, F, body, rollup, runs }));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  const fake = path.join(binDir, 'gh');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
if (a[0] === 'pr' && a[1] === 'view') {
  const full = { number: 7, title: 'x', author: { login: 'u' }, reviews: [], body: st.body, mergeCommit: { oid: st.MC }, commits: [{ oid: st.F }], labels: [], createdAt: '2026-01-01T00:00:00Z', mergedAt: '2026-08-01T00:00:00Z', headRefOid: st.F, headRefName: 'feat' };
  const roll = st.rollup === 'ok' ? [{ name: 'gate-g5', conclusion: 'SUCCESS' }] : st.rollup === 'fail' ? [{ name: 'gate-g5', conclusion: 'FAILURE' }] : [];
  if (a.includes('--json') && !a[a.indexOf('--json') + 1].includes('statusCheckRollup')) process.stdout.write(JSON.stringify(full));
  else process.stdout.write(JSON.stringify({ ...full, statusCheckRollup: roll }));
  process.exit(0);
}
if (a[0] === 'api' && a[1].includes('check-runs')) { process.stdout.write(JSON.stringify({ check_runs: [] })); process.exit(0); }
if (a[0] === 'api' && a[1].includes('actions/runs')) {
  // gate-g5 のワークフローの実行(起動の事象つき)。pr: pull_request の成功 / dispatch: 手動の起動の成功だけ / none: 読めない
  if (st.runs === 'none') { process.stderr.write('fake gh: HTTP 403'); process.exit(1); }
  const ev = st.runs === 'dispatch' ? 'workflow_dispatch' : 'pull_request';
  process.stdout.write(JSON.stringify({ workflow_runs: [{ id: 501, path: '.github/workflows/gate-g5.yml', event: ev, status: 'completed', conclusion: 'success' }, { id: 502, path: '.github/workflows/other.yml', event: 'pull_request', status: 'completed', conclusion: 'success' }] }));
  process.exit(0);
}
if (a[0] === '--version') { process.stdout.write('gh version 2.0.0 (fake)\\n'); process.exit(0); }
process.stderr.write('fake gh: unsupported ' + a.join(' ')); process.exit(1);
`,
    { mode: 0o755 },
  );
  if (copy !== 'nocopy') {
    git('checkout', '-q', '--orphan', 'records');
    git('rm', '-rfq', '.');
    spawnSync('git', ['clean', '-fdxq'], { cwd: work });
    const g = { success: { found: true, id: 99, status: 'completed', conclusion: 'success', completed_at: '2026-08-01T00:10:00Z', head_sha: F }, found_false: { found: false }, read_error: { found: null, read_error: 'HTTP 403' } }[copy];
    const c = { repository: 'o/r', pr: 7, title: 'x', body, head_ref: 'feat', merge_commit_sha: MC, head_sha: F, author: { id: 1, login: 'u' }, merged_at: '2026-08-01T00:00:00Z', merged_by: { login: 'm' }, base: { ref: 'main' }, default_branch: 'main', copied_at: '2026-08-01T00:01:00Z', copied_by: 'record-copy workflow (GITHUB_TOKEN)', reviews: [], audit_log: 'x' };
    if (g) c.checks = { gate_g5: g };
    fs.mkdirSync(path.join(work, 'records', 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(work, 'records', 'reviews', 'pr-7.json'), JSON.stringify(c, null, 2));
    git('add', '-f', 'records');
    git('commit', '-q', '-m', 'records: PR #7 の承認レビューの写し');
    git('checkout', '-q', 'main');
  }
  fs.mkdirSync(path.join(work, 'evidence'), { recursive: true });
  if (prevSource) fs.writeFileSync(path.join(work, 'evidence', 'previous-source.json'), JSON.stringify(prevSource));
  const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs', '--from', 'v0', '--to', 'main'], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, FAKE_STATE: state, GITHUB_REPOSITORY: 'o/r' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const readText = (n) => (fs.existsSync(path.join(work, 'evidence', n)) ? fs.readFileSync(path.join(work, 'evidence', n), 'utf8') : '');
  let ev = null;
  try {
    ev = JSON.parse(fs.readFileSync(path.join(work, 'evidence', 'evidence.json'), 'utf8'));
  } catch {
    ev = null;
  }
  const find = (o, k, acc = []) => {
    if (o && typeof o === 'object') for (const [a, b] of Object.entries(o)) {
      if (a === k) acc.push(b);
      find(b, k, acc);
    }
    return acc;
  };
  const out = { ev, gaps: (find(ev, 'gaps')[0] ?? []).filter((x) => typeof x === 'string'), gateG5: find(ev, 'gateG5')[0] ?? null, log: `${r.stdout}${r.stderr}`.slice(-800), report: readText('quality-report.md'), external: readText('assurance-disclosure.external.md') };
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}
const g5Gap = (gaps) => gaps.filter((x) => /^PR #7: gate-g5/.test(x));

if (!CAN_E2E) console.log('SKIP 集約の通し(PATH に偽の gh を置く形)は Windows では動かせないため行いません(CI の Linux で確かめる)');
if (CAN_E2E) {
  // IMPL-0244:ok(適合側。ホスティングが gate-g5 の成功を返す PR は、写しの値に依らず文を出さず、充足に数える)
  {
    const r = runAggregate({ copy: 'success', rollup: 'ok' });
    check('IMPL-0244:ok 集約の通し: ホスティングが成功を返す PR は欠落にならず success に数える', r.ev !== null && g5Gap(r.gaps).length === 0 && r.gateG5?.success === 1 && r.gateG5?.notRecorded === 0, `${JSON.stringify(r.gateG5)} ${r.log}`);
  }
  // IMPL-0244:ng(違反側。読めない G-5 を、写しの値で充足に数える・欠落に入れない・書き分けない、のいずれかになると落ちる)
  {
    const r = runAggregate({ copy: 'success', rollup: 'empty' });
    check('IMPL-0244:ng 集約の通し: 写しが success でも、ホスティングから読めない G-5 は欠落に数え、充足に数えない', g5Gap(r.gaps).length === 1 && /保持期間を過ぎて消えた可能性/.test(g5Gap(r.gaps)[0]) && r.gateG5?.success === 0 && r.gateG5?.notRecorded === 1, `${JSON.stringify(r.gateG5)} ${r.gaps.slice(0, 3).join(' | ')} ${r.log}`);
    const f = runAggregate({ copy: 'found_false', rollup: 'empty' });
    check('IMPL-0244:ng 集約の通し: 写しにも check run が無ければ、必須チェックを経ていない可能性の文で欠落に数える', g5Gap(f.gaps).length === 1 && /必須チェックを経ずにマージされた可能性/.test(g5Gap(f.gaps)[0]) && f.gateG5?.success === 0, `${JSON.stringify(f.gateG5)} ${f.log}`);
    const n = runAggregate({ copy: 'nocopy', rollup: 'empty' });
    check('IMPL-0244:ng 集約の通し: 写しが無ければ区別できない旨の文で欠落に数える', g5Gap(n.gaps).length === 1 && /区別できません/.test(g5Gap(n.gaps)[0]) && n.gateG5?.success === 0, `${JSON.stringify(n.gateG5)} ${n.log}`);
    const x = runAggregate({ copy: 'success', rollup: 'fail' });
    check('IMPL-0244:ng 集約の通し: ホスティングが failure を返す PR は、写しが success でも failure として欠落に数える', g5Gap(x.gaps).some((t) => /gate-g5 が failure です/.test(t)) && x.gateG5?.success === 0, `${JSON.stringify(x.gateG5)} ${x.log}`);
  }

  // IMPL-0987:ng(違反側。ホスティングの rollup が成功でも、起動が手動だけ・読めない PR は、通過に数えず欠落にする)
  // IMPL-0987:ok(適合側。pull_request の成功がある PR は、上の IMPL-0244:ok が通過に数える)
  {
    const d = runAggregate({ copy: 'success', rollup: 'ok', runs: 'dispatch' });
    check('IMPL-0987:ng 集約の通し: 手動の起動の成功だけの PR は、success に数えず欠落にする', d.gateG5?.success === 0 && g5Gap(d.gaps).length === 1 && /workflow_dispatch/.test(g5Gap(d.gaps)[0]), JSON.stringify([d.gateG5, d.gaps]));
    const u = runAggregate({ copy: 'success', rollup: 'ok', runs: 'none' });
    check('IMPL-0987:ng 集約の通し: 起動の事象を読めない PR は、「未確認(起動の事象を読めない)」として欠落にする', u.gateG5?.success === 0 && g5Gap(u.gaps).length === 1 && /未確認\(起動の事象を読めない\)/.test(g5Gap(u.gaps)[0]), JSON.stringify([u.gateG5, u.gaps]));
  }

  // 前回の証跡が無いとき、見た場所と理由を品質レポートと外へ渡す開示の両方に出す(evidence.json の previousSource だけにしない)
  const ps = { source: 'none', artifact: { status: 'failed', run: '77' }, copies: { root: 'docs/evidence', used: null, looked: [{ dir: 'b2', ok: false, problems: ['sha256 が一覧と一致しません'] }] } };
  const p = runAggregate({ copy: 'success', rollup: 'ok', prevSource: ps });
  const has = (t) => /前回の証跡: なし/.test(t) && /成果物: 実行 77 から取得できず/.test(t) && /読まなかった理由: b2 sha256/.test(t);
  check('IMPL-0244:ng 集約の通し: 前回の証跡が無いとき、見た場所と理由が品質レポートに出る', has(p.report), p.report.slice(0, 300));
  check('IMPL-0244:ng 集約の通し: 前回の証跡が無いとき、見た場所と理由が外へ渡す開示にも出る', has(p.external), p.external.slice(0, 300));
  check('IMPL-0244:ng 集約の通し: evidence.json の previousSource にも出る', p.ev?.previousSource?.source === 'none');
  const line = p.report.split(/\r?\n/).find((l) => l.startsWith('前回の証跡: なし')) ?? '';
  check('IMPL-0244:ng 出力の文は原因を断定しない(見た場所に無かった事実だけ)', line !== '' && !/(消えた|改ざん|失われた)/.test(line));
  const q = runAggregate({ copy: 'success', rollup: 'ok' });
  check('IMPL-0244:ng 読み先の記録が無いときも、記録が無い旨を両方に出す', /previous-source\.json が無く/.test(q.report) && /previous-source\.json が無く/.test(q.external));
}

// 起動の事象による通過の判定(IMPL-0987。process-compass #329 / ADR-0165)
// IMPL-0987:ng(違反の入力: 手動の起動(workflow_dispatch)の成功だけを持つ PR は通過に数えない。起動の事象を読めないものも数えない)
{
  const dispatchOnly = g5TriggerVerdict([{ id: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }]);
  check('IMPL-0987:ng workflow_dispatch の成功だけの PR は、通過に数えず欠落にする', dispatchOnly.verdict === 'not-pr' && /workflow_dispatch/.test(g5TriggerGapText({ number: 5, ...dispatchOnly })) && /通過に数えません/.test(g5TriggerGapText({ number: 5, ...dispatchOnly })));
  const failedPr = g5TriggerVerdict([{ event: 'pull_request', conclusion: 'failure' }, { event: 'workflow_dispatch', conclusion: 'success' }]);
  check('IMPL-0987:ng pull_request が失敗で workflow_dispatch が成功の PR は、通過に数えない', failedPr.verdict === 'not-pr');
  const pushOnly = g5TriggerVerdict([{ event: 'push', conclusion: 'success' }]);
  check('IMPL-0987:ng PR を評価していない起動(push)の成功だけの PR は、通過に数えない', pushOnly.verdict === 'not-pr');
  for (const [label, runs] of [['読めない(null)', null], ['実行が1件も無い', []]]) {
    const v = g5TriggerVerdict(runs);
    const t = g5TriggerGapText({ number: 6, ...v });
    check(`IMPL-0987:ng 起動の事象を${label}PR は、未確認として通過に数えない`, v.verdict === 'unverified' && /未確認\(起動の事象を読めない\)/.test(t) && /通過に数えません/.test(t));
  }
}
// IMPL-0987:ok(適合の入力: PR を評価した起動(pull_request・pull_request_target)の成功がある PR は通過に数える)
{
  check('IMPL-0987:ok pull_request の成功は通過に数える', g5TriggerVerdict([{ event: 'pull_request', conclusion: 'success' }]).verdict === 'pr');
  check('IMPL-0987:ok pull_request_target の成功は通過に数える', g5TriggerVerdict([{ event: 'pull_request_target', conclusion: 'success' }]).verdict === 'pr');
  check('IMPL-0987:ok 手動の起動が混じっても、pull_request の成功があれば通過に数える', g5TriggerVerdict([{ event: 'workflow_dispatch', conclusion: 'success' }, { event: 'pull_request', conclusion: 'success' }]).verdict === 'pr');
}

// record-copy.yml の静的な確認
{
  const y = fs.readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'record-copy.yml'), 'utf8');
  check('record-copy.yml: permissions に checks: read がある', /^ {2}checks:\s*read\s*$/m.test(y));
  check('record-copy.yml: head の gate-g5 の check-runs を読む', /commits\/\$HEAD_SHA\/check-runs\?check_name=gate-g5/.test(y));
  check('record-copy.yml: 写しへ checks.gate_g5 を足す', /checks:\s*\{gate_g5:\s*\$g5\}/.test(y));
  check('record-copy.yml: 読めなかったとき found: null を写し、手順を失敗させない', /found: null, read_error/.test(y) && !/g5raw=.*\|\| exit/.test(y));
  check('record-copy.yml: permissions に actions: read がある(gate-g5 の実行の起動の事象を読む)', /^ {2}actions:\s*read\s*$/m.test(y));
  check('record-copy.yml: head の gate-g5 のワークフローの実行を読み、読めなければ runs: null を写す', y.includes('actions/runs?head_sha=$HEAD_SHA') && y.includes('runs: null'));
  check('record-copy.yml: 比べる欄(shape)に checks を入れない', !/shape='[^']*checks/.test(y));
}

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\ngate-g5 を読めない PR の欠落の文の試験: すべて通過');
