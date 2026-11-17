// 項目4 の未実施・未測定の継続期間を試験する(process-compass #330 T-1・T-2 / ADR-0151。IMPL-0993)。
//
//   node scripts/gate/test-unrun-streak.mjs
//
// 固定する決定:
//   - 値が「未実施」または「未測定」で始まる検査(test・coverage・staticAnalysis・dependencyAudit・licenses・secretScan)に、
//     起点と連続した出荷の回数を machineChecks.unrunStreaks として出す。カバレッジの「未測定(…)」も数える。値の文字列は変えない
//   - 理由が変わっても未実施・未測定が続く限り途切れない。実施に戻れば消え、再び未実施なら起点は新しくなる。検査ごとに独立して数える
//   - 同じ出荷の再集計では回数を進めない。前回が旧い形式(unrunStreaks なし)で値が未実施なら、前回の出荷を起点にする
//   - 期間の指定(--period-*)では前回を読まないため、常に「前回の出力なし」になる(項目6 と同じ挙動)
//   - 継続が長くても合否に使わない(集約の problems・gaps は増えない。閾値を課さないと決めた)
//   - 項目6 の継続(unrunStreak を共有)の挙動は切り出しの前と変わらない
//   - 時計に依らない。日付は引数で渡す

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';
import { unrunStreak, computeUnrunStreaks, isUnrunValue, streakText, UNRUN_CHECKS } from './unrun-streak.mjs';

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

const DAY = { r1: '2026-09-01', r2: '2026-10-01', r3: '2026-11-01' };
const dayOfRef = (ref) => ({ v1: DAY.r1, v2: DAY.r2 })[ref] ?? null;
const UNRUN = '未実施(コマンドが未設定)';
const OK = '実施(結果は gate-g5 に含む)';

// ---------------------------------------------------------------- 1. 純関数
{
  check('値の前置き: 未実施・未測定は数え、実施・記録なしは数えない', isUnrunValue('未実施(理由)') && isUnrunValue('未測定(集計ファイルがありません)') && !isUnrunValue(OK) && !isUnrunValue('記録なし') && !isUnrunValue(undefined), '');
  check('対象は6つの検査(gate-g5 の集計は含めない)', UNRUN_CHECKS.join() === 'test,coverage,staticAnalysis,dependencyAudit,licenses,secretScan', UNRUN_CHECKS.join());

  const first = computeUnrunStreaks({ machineChecks: { licenses: UNRUN, test: OK }, prevMachineChecks: null, previous: null, sameRelease: false, releaseDay: DAY.r1, dayOfRef });
  // IMPL-0993:ok(出す形。未実施の検査に起点と回数を出す)
  check('IMPL-0993:ok 初回: 未実施の検査に起点と 1 回を出し、実施の検査には出さない', first.licenses?.since === DAY.r1 && first.licenses.releases === 1 && first.licenses.note === '前回の出力なし。起点は今回' && !('test' in first), JSON.stringify(first));

  const prev1 = { range: { to: 'v1' }, licenses: UNRUN, test: OK, unrunStreaks: first };
  const second = computeUnrunStreaks({ machineChecks: { licenses: UNRUN, test: OK }, prevMachineChecks: prev1, previous: { range: { to: 'v1' } }, sameRelease: false, releaseDay: DAY.r2, dayOfRef });
  check('IMPL-0993:ok 2回目: 起点を保ち回数を進める', second.licenses?.since === DAY.r1 && second.licenses.releases === 2 && second.licenses.note === null, JSON.stringify(second));

  const third = computeUnrunStreaks({ machineChecks: { licenses: UNRUN }, prevMachineChecks: { licenses: UNRUN, unrunStreaks: second }, previous: { range: { to: 'v2' } }, sameRelease: false, releaseDay: DAY.r3, dayOfRef });
  check('IMPL-0993:ok 3回目: 3 回', third.licenses?.releases === 3 && third.licenses.since === DAY.r1, JSON.stringify(third));

  const again = computeUnrunStreaks({ machineChecks: { licenses: UNRUN }, prevMachineChecks: { licenses: UNRUN, unrunStreaks: second }, previous: { range: { to: 'v2' } }, sameRelease: true, releaseDay: DAY.r3, dayOfRef });
  check('同じ出荷の再集計: 回数を進めない', again.licenses?.releases === 2, JSON.stringify(again));

  const reasonChanged = computeUnrunStreaks({
    machineChecks: { licenses: '未実施(検査対象が存在しない)' },
    prevMachineChecks: { licenses: UNRUN, unrunStreaks: second },
    previous: { range: { to: 'v2' } }, sameRelease: false, releaseDay: DAY.r3, dayOfRef,
  });
  check('理由が変わっても未実施が続く限り途切れない', reasonChanged.licenses?.releases === 3 && reasonChanged.licenses.since === DAY.r1, JSON.stringify(reasonChanged));

  const back = computeUnrunStreaks({ machineChecks: { licenses: OK }, prevMachineChecks: { licenses: UNRUN, unrunStreaks: second }, previous: { range: { to: 'v2' } }, sameRelease: false, releaseDay: DAY.r3, dayOfRef });
  check('実施に戻れば消える', !('licenses' in back), JSON.stringify(back));
  const again2 = computeUnrunStreaks({ machineChecks: { licenses: UNRUN }, prevMachineChecks: { licenses: OK, unrunStreaks: back }, previous: { range: { to: 'v2' } }, sameRelease: false, releaseDay: '2026-12-01', dayOfRef });
  check('再び未実施になれば起点は新しくなる', again2.licenses?.since === '2026-12-01' && again2.licenses.releases === 1 && again2.licenses.note === '今回の出荷から', JSON.stringify(again2));

  const independent = computeUnrunStreaks({
    machineChecks: { licenses: UNRUN, staticAnalysis: '未実施(コマンドが未設定)' },
    prevMachineChecks: { licenses: UNRUN, staticAnalysis: OK, unrunStreaks: { licenses: { since: DAY.r1, releases: 4, note: null } } },
    previous: { range: { to: 'v2' } }, sameRelease: false, releaseDay: DAY.r3, dayOfRef,
  });
  check('検査ごとに独立して数える', independent.licenses.releases === 5 && independent.staticAnalysis.releases === 1 && independent.staticAnalysis.since === DAY.r3, JSON.stringify(independent));

  // IMPL-0993:ok(旧い形式。unrunStreaks が無い前回の出力で値が未実施なら、前回の出荷を起点にする)
  const legacy = computeUnrunStreaks({ machineChecks: { licenses: UNRUN }, prevMachineChecks: { licenses: UNRUN }, previous: { range: { to: 'v1' }, generatedAt: '2026-09-02T00:00:00Z' }, sameRelease: false, releaseDay: DAY.r2, dayOfRef });
  check('旧い形式の前回(unrunStreaks なし)で値が未実施: 前回の出荷を起点に 2 回', legacy.licenses?.since === DAY.r1 && legacy.licenses.releases === 2, JSON.stringify(legacy));
  const legacyOk = computeUnrunStreaks({ machineChecks: { licenses: UNRUN }, prevMachineChecks: { licenses: OK }, previous: { range: { to: 'v1' } }, sameRelease: false, releaseDay: DAY.r2, dayOfRef });
  check('旧い形式の前回で値が実施だった: 今回から 1 回', legacyOk.licenses?.releases === 1 && legacyOk.licenses.since === DAY.r2, JSON.stringify(legacyOk));

  // 旧い集約は空のライセンス検査も「実施」と出した。前回が実施と読めても、確かめたようには出さない
  const legacyRun = computeUnrunStreaks({ machineChecks: { licenses: UNRUN }, prevMachineChecks: { licenses: '実施(success)' }, previous: { range: { to: 'v1' } }, sameRelease: false, releaseDay: DAY.r2, dayOfRef });
  check('旧い形式の前回で licenses が実施: 旧い形式であることを note に開示する', legacyRun.licenses?.releases === 1 && /旧い形式/.test(legacyRun.licenses.note ?? ''), JSON.stringify(legacyRun));

  const cov = computeUnrunStreaks({ machineChecks: { coverage: '未測定(集計ファイルがありません)' }, prevMachineChecks: { coverage: '未測定(別の理由)', unrunStreaks: { coverage: { since: DAY.r1, releases: 1, note: null } } }, previous: { range: { to: 'v1' } }, sameRelease: false, releaseDay: DAY.r2, dayOfRef });
  check('カバレッジの「未測定(…)」が継続の対象になる(理由が変わっても続く)', cov.coverage?.releases === 2 && cov.coverage.since === DAY.r1, JSON.stringify(cov));

  const none = computeUnrunStreaks({ machineChecks: { test: '記録なし', licenses: '記録なし' }, prevMachineChecks: null, previous: null, sameRelease: false, releaseDay: DAY.r1, dayOfRef });
  check('「記録なし」(アダプタが無い)は対象外', Object.keys(none).length === 0, JSON.stringify(none));

  // IMPL-0993:ng(違反側。未実施なのに継続を出さない形は、起点が無い・回数が 0 になる。出す形と対にして固定する)
  const ng = computeUnrunStreaks({ machineChecks: { licenses: UNRUN }, prevMachineChecks: null, previous: null, sameRelease: false, releaseDay: DAY.r1, dayOfRef });
  check('IMPL-0993:ng 未実施なのに継続を出さない形(欄なし・起点なし・回数 0)を取らない', ng.licenses && ng.licenses.since && ng.licenses.releases >= 1, JSON.stringify(ng));

  let acc = null;
  let prevStreaks = null;
  for (let i = 1; i <= 100; i++) {
    acc = computeUnrunStreaks({ machineChecks: { licenses: UNRUN }, prevMachineChecks: prevStreaks ? { licenses: UNRUN, unrunStreaks: prevStreaks } : null, previous: prevStreaks ? { range: { to: 'v1' } } : null, sameRelease: false, releaseDay: DAY.r2, dayOfRef });
    prevStreaks = acc;
  }
  check('100 回連続でも欄は 1 つで、回数が 100 になる(閾値で打ち切らない)', acc.licenses?.releases === 100 && Object.keys(acc).length === 1, JSON.stringify(acc));
  check('継続の文: 起点と回数を出す', streakText({ since: DAY.r1, releases: 3, note: null }) === `${DAY.r1} の出荷から 3 回連続`, '');
}

// ---------------------------------------------------------------- 2. 項目6 の継続(切り出した関数を共有)。挙動は切り出しの前と変わらない
{
  const base = { releaseDay: DAY.r2, dayOfRef, sameRelease: false, previous: { range: { to: 'v1' } } };
  check('項目6: 測定できていれば継続なし', JSON.stringify(unrunStreak({ ...base, measured: true })) === JSON.stringify({ since: null, releases: 0, note: null }), '');
  check('項目6: 前回の起点を保ち回数を進める', (() => { const r = unrunStreak({ ...base, measured: false, prevSince: DAY.r1, prevReleases: 2 }); return r.since === DAY.r1 && r.releases === 3; })(), '');
  check('項目6: 同じ出荷の再集計は進めない', (() => { const r = unrunStreak({ ...base, sameRelease: true, measured: false, prevSince: DAY.r1, prevReleases: 2 }); return r.releases === 2; })(), '');
  check('項目6: 起点を持たない旧い形式の前回が未測定なら前回の出荷を起点に 2 回', (() => { const r = unrunStreak({ ...base, measured: false, prevWasUnmeasured: true }); return r.since === DAY.r1 && r.releases === 2; })(), '');
  check('項目6: 前回の出力なしなら今回を起点に 1 回', (() => { const r = unrunStreak({ ...base, previous: null, measured: false }); return r.since === DAY.r2 && r.releases === 1 && r.note === '前回の出力なし。起点は今回'; })(), '');
}

// ---------------------------------------------------------------- 3. 集約の通し(一時のリポジトリ)
const ANSWERS = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9', 'q-biz-phase': 'growth', 'q-external-reviewer': 'reviewer-yes',
};
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-unrun-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const config = quiet(() => buildConfig(ANSWERS, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
  config.adapters = { ...(config.adapters ?? {}), stack: 'node' };
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(config, null, 2) + '\n');
  const ap = path.join(dir, 'adapters/node.json');
  const a = JSON.parse(fs.readFileSync(ap, 'utf8'));
  a.commands.licenses = '';
  fs.writeFileSync(ap, JSON.stringify(a, null, 2));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "x" }\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  git('add', '-A', '-f');
  git('commit', '-q', '-m', 'chore: fixture');
  const aggregate = (extraArgs = []) => {
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs', ...extraArgs], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    const ep = path.join(dir, 'evidence/evidence.json');
    const rp = path.join(dir, 'evidence/quality-report.md');
    return {
      out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
      evidence: fs.existsSync(ep) ? JSON.parse(fs.readFileSync(ep, 'utf8')) : null,
      report: fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : '',
    };
  };
  const placePrevious = (evidence) => {
    fs.mkdirSync(path.join(dir, 'evidence/previous'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence/previous/evidence.json'), JSON.stringify(evidence));
  };
  const commit = (msg) => git('commit', '-q', '--allow-empty', '-m', msg);
  return { dir, aggregate, placePrevious, commit, done: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}
const row4 = (report) => report.split('\n').find((l) => l.startsWith('| 依存関係のライセンス |')) ?? '';

{
  const W = workspace();
  const a1 = W.aggregate();
  const s1 = a1.evidence?.assurance?.machineChecks?.unrunStreaks?.licenses;
  check('通し: 初回、ライセンス検査の未実施に継続(1 回・前回の出力なし)が出る', s1?.releases === 1 && s1.note === '前回の出力なし。起点は今回', JSON.stringify(a1.evidence?.assurance?.machineChecks?.unrunStreaks) || a1.out);
  check('通し: 値の文字列は変えない(未実施(コマンドが未設定))', a1.evidence?.assurance?.machineChecks?.licenses === '未実施(コマンドが未設定)', String(a1.evidence?.assurance?.machineChecks?.licenses));
  check('通し: 品質レポートの項目4 の行に継続を添える', /未実施\(コマンドが未設定\) \/ .+ の出荷から 1 回連続/.test(row4(a1.report)), row4(a1.report));
  const gaps1 = a1.evidence?.gaps?.length;
  const problems1 = JSON.stringify(a1.evidence?.assurance?.machineChecks?.aggregateProblems);

  // 同じ出荷の再集計
  W.placePrevious(a1.evidence);
  const a1b = W.aggregate();
  check('通し: 同じ出荷の再集計は回数を進めない', a1b.evidence?.assurance?.machineChecks?.unrunStreaks?.licenses?.releases === 1, JSON.stringify(a1b.evidence?.assurance?.machineChecks?.unrunStreaks));

  // 次の出荷
  W.commit('chore: 次の出荷');
  const a2 = W.aggregate();
  const s2 = a2.evidence?.assurance?.machineChecks?.unrunStreaks?.licenses;
  check('通し: 次の出荷で 2 回連続になり、起点を保つ', s2?.releases === 2 && s2.since === s1?.since, JSON.stringify(s2));

  // 100 回連続の前回を置いても、problems・gaps が増えない
  const long = JSON.parse(JSON.stringify(a2.evidence));
  long.assurance.machineChecks.unrunStreaks.licenses = { since: '2020-01-01', releases: 100, note: null };
  W.placePrevious(long);
  W.commit('chore: 100 回目の出荷');
  const a100 = W.aggregate();
  check('通し: 100 回連続になっても継続を出す', a100.evidence?.assurance?.machineChecks?.unrunStreaks?.licenses?.releases === 101, JSON.stringify(a100.evidence?.assurance?.machineChecks?.unrunStreaks));
  check('通し: 継続が長くても集約の欠落・問題は増えない(閾値を課さない)', a100.evidence?.gaps?.length === gaps1 && JSON.stringify(a100.evidence?.assurance?.machineChecks?.aggregateProblems) === problems1, `${a100.evidence?.gaps?.length} vs ${gaps1}`);

  // 実施に戻る(コマンドを入れる)と消える
  const ap = path.join(W.dir, 'adapters/node.json');
  const ad = JSON.parse(fs.readFileSync(ap, 'utf8'));
  ad.commands.licenses = 'npx license-checker';
  fs.writeFileSync(ap, JSON.stringify(ad, null, 2));
  fs.mkdirSync(path.join(W.dir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(W.dir, 'evidence/license-scan.json'), JSON.stringify({ scanRun: true, result: 'success', scannedAt: '2026-11-17T00:00:00Z' }));
  W.placePrevious(a100.evidence);
  W.commit('chore: コマンドを入れた');
  const a3 = W.aggregate();
  check('通し: 実施に戻れば継続の欄から消える', !('licenses' in (a3.evidence?.assurance?.machineChecks?.unrunStreaks ?? { licenses: 1 })), JSON.stringify(a3.evidence?.assurance?.machineChecks?.unrunStreaks));
  W.done();
}
{
  // 期間の指定では前回を読まない(項目6 と同じ。常に「前回の出力なし」)
  const W = workspace();
  const a1 = W.aggregate();
  W.placePrevious(a1.evidence);
  W.commit('chore: 次の出荷');
  const p = W.aggregate(['--period-from', '2020-01-01', '--period-to', '2999-01-01']);
  const s = p.evidence?.assurance?.machineChecks?.unrunStreaks?.licenses;
  check('通し: 期間の指定では前回を読まず、前回の出力なしになる', s?.releases === 1 && s.note === '前回の出力なし。起点は今回', JSON.stringify(s) || p.out);
  W.done();
}

console.log('');
if (failures) {
  console.log(`未実施の継続期間の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`未実施の継続期間の試験: ${checks} 件が期待と一致しました`);
