// 依存関係のライセンス検査の実施記録と、保証の開示 項目4 の表示を試験する(process-compass #330 T-8 / IMPL-0995)。
//
//   node scripts/gate/test-license-scan.mjs
//
// 固定する決定:
//   - アダプタの licenses は、コマンドが空・検査対象なしでも終了コード 0 で通る。その通過を「実施」と記録・表示しない
//     (記録は scanRun false と理由を持ち、項目4 は「未実施(理由)」と出す)
//   - 古い記録(scanRun: true)が残っていても、アダプタのコマンドが空なら集約は未実施と出す(両側で閉じる)
//   - 欠落にするのは記録が無いときだけ。構成で選んだ未実施(コマンドが空・検査対象なし)は欠落にしない(議長の裁定 2026-11-17。
//     ADR-0151 決定1・3)。欠落に数える決定へ反転するときは、下の「欠落にしない」の行を反転する
//   - 時計に依らない。記録の時刻は純関数へ引数で渡す

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';
import { buildLicenseScanRecord, REASON_NO_COMMAND, REASON_NO_TARGET } from './license-scan-record.mjs';
import { licenseScanStatus } from './aggregate-evidence.mjs';

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

const AT = '2026-11-17T09:00:00Z';
const effective = { effective: new Set(['ip-clearance']) };

// ---------------------------------------------------------------- 1. 記録の純関数
{
  const r = buildLicenseScanRecord({ outcome: 'success', command: '', target: true, at: AT });
  // IMPL-0995:ng(違反側。空のコマンドの通過を実施と記録しない形)
  check('IMPL-0995:ng コマンドが空: scanRun false・理由「コマンドが未設定」', r.scanRun === false && r.reason === REASON_NO_COMMAND && r.reason === 'コマンドが未設定', JSON.stringify(r));
  const u = buildLicenseScanRecord({ outcome: 'success', command: undefined, target: true, at: AT });
  check('IMPL-0995:ng コマンドが未定義でも scanRun false', u.scanRun === false && u.reason === 'コマンドが未設定', JSON.stringify(u));
  const n = buildLicenseScanRecord({ outcome: 'success', command: 'npx license-checker', target: false, at: AT });
  check('IMPL-0995:ng 検査対象なし: scanRun false・理由「検査対象が存在しない」', n.scanRun === false && n.reason === REASON_NO_TARGET && n.reason === '検査対象が存在しない', JSON.stringify(n));
  // IMPL-0995:ok(適合側。コマンドがあり対象がある通過は実施と記録する)
  const ok = buildLicenseScanRecord({ outcome: 'success', command: 'npx license-checker', target: true, at: AT });
  check('IMPL-0995:ok コマンドあり・対象あり・成功: scanRun true・result success', ok.scanRun === true && ok.result === 'success' && ok.scannedAt === AT, JSON.stringify(ok));
  const ng = buildLicenseScanRecord({ outcome: 'failure', command: 'npx license-checker', target: true, at: AT });
  check('IMPL-0995:ok 失敗は失敗として記録する(scanRun true・result failure)', ng.scanRun === true && ng.result === 'failure', JSON.stringify(ng));
}

// ---------------------------------------------------------------- 2. 集約の純関数
{
  const noCmd = licenseScanStatus({ licenseScan: { scanRun: true, result: 'success' }, phaseStatus: '未実施(コマンドが未設定)', aggregate: effective });
  check('IMPL-0995:ng 古い記録(scanRun true)でもアダプタのコマンドが空なら run false', noCmd.run === false && noCmd.text === '未実施(コマンドが未設定)' && noCmd.chosen === true, JSON.stringify(noCmd));
  const noTarget = licenseScanStatus({ licenseScan: { scanRun: true, result: 'success' }, phaseStatus: '未実施(検査対象が存在しない)', aggregate: effective });
  check('IMPL-0995:ng 古い記録でも検査対象が無ければ run false', noTarget.run === false && noTarget.text === '未実施(検査対象が存在しない)', JSON.stringify(noTarget));
  const rec = licenseScanStatus({ licenseScan: { scanRun: false, result: 'skipped', reason: 'コマンドが未設定' }, phaseStatus: '実施(結果は gate-g5 に含む)', aggregate: effective });
  check('IMPL-0995:ng 記録が scanRun false なら理由つきの未実施', rec.run === false && rec.text === '未実施(コマンドが未設定)' && rec.chosen === true, JSON.stringify(rec));
  const none = licenseScanStatus({ licenseScan: { scanRun: false }, phaseStatus: '実施(結果は gate-g5 に含む)', aggregate: effective });
  check('IMPL-0995:ng 記録が無ければ未実施(構成で選んだ未実施とは数えない)', none.run === false && none.text === '未実施' && none.chosen === false, JSON.stringify(none));
  const run = licenseScanStatus({ licenseScan: { scanRun: true, result: 'success' }, phaseStatus: '実施(結果は gate-g5 に含む)', aggregate: effective });
  check('IMPL-0995:ok コマンドあり・成功: run true・「実施(success)」', run.run === true && run.text === '実施(success)', JSON.stringify(run));
  const failed = licenseScanStatus({ licenseScan: { scanRun: true, result: 'failure' }, phaseStatus: '実施(結果は gate-g5 に含む)', aggregate: effective });
  check('IMPL-0995:ok 失敗の記録は「実施(failure)」', failed.run === true && failed.text === '実施(failure)', JSON.stringify(failed));
  const off = licenseScanStatus({ licenseScan: { scanRun: true, result: 'success' }, phaseStatus: '未実施(ジョブ ip-clearance を集約 gate-g5 が合否に使っていない)', aggregate: { effective: new Set() } });
  check('集約が ip-clearance を合否に使っていなければ、記録があっても未実施', off.run === false && /集約 gate-g5 が合否に使っていない/.test(off.text) && off.chosen === false, JSON.stringify(off));
}

// ---------------------------------------------------------------- 3. 記録の書き込みと集約の通し(一時の作業場)
const ANSWERS = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9', 'q-biz-phase': 'growth', 'q-external-reviewer': 'reviewer-yes',
};
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));

/** 一時のリポジトリ。stack と、アダプタの licenses のコマンドの上書き、製品のコードの目印、既存の記録を指定する */
function workspace({ stack = 'node', licenses = undefined, product = true, prior = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-license-scan-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const config = quiet(() => buildConfig(ANSWERS, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
  config.adapters = { ...(config.adapters ?? {}), stack };
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(config, null, 2) + '\n');
  if (licenses !== undefined) {
    const p = path.join(dir, 'adapters', `${stack}.json`);
    const a = JSON.parse(fs.readFileSync(p, 'utf8'));
    a.commands.licenses = licenses;
    fs.writeFileSync(p, JSON.stringify(a, null, 2));
  }
  if (product) fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "x" }\n');
  if (prior) {
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evidence/license-scan.json'), JSON.stringify(prior));
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  git('add', '-A', '-f');
  git('commit', '-q', '-m', 'chore: fixture');
  const record = (outcome) => {
    const r = spawnSync(process.execPath, ['scripts/gate/license-scan-record.mjs', '--outcome', outcome], { cwd: dir, encoding: 'utf8' });
    const p = path.join(dir, 'evidence/license-scan.json');
    return { code: r.status, json: fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const aggregate = () => {
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    const rp = path.join(dir, 'evidence/quality-report.md');
    const ep = path.join(dir, 'evidence/evidence.json');
    return {
      out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
      report: fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : '',
      evidence: fs.existsSync(ep) ? JSON.parse(fs.readFileSync(ep, 'utf8')) : null,
    };
  };
  return { dir, record, aggregate, done: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}
const row4 = (report) => report.split('\n').find((l) => l.startsWith('| 依存関係のライセンス |')) ?? '';
const gapOf = (e) => (e?.gaps ?? []).some((g) => /知財潔白性の検査記録がありません/.test(g));

{
  const W = workspace({ licenses: '' });
  const r = W.record('success');
  check('IMPL-0995:ng 記録の段: コマンドが空なら scanRun false・理由つきで書く', r.code === 0 && r.json?.scanRun === false && r.json?.reason === 'コマンドが未設定', r.out);
  const a = W.aggregate();
  check('IMPL-0995:ng 項目4: 空のコマンドは「未実施(コマンドが未設定)」(実施と出さない)', /未実施\(コマンドが未設定\)/.test(row4(a.report)) && !/実施\(success\)/.test(row4(a.report)), row4(a.report) || a.out);
  // 欠落にしない(議長の裁定 2026-11-17。反転するときはこの行を反転する)
  check('構成で選んだ未実施(コマンドが空)は、記載の欠落にしない', a.evidence && !gapOf(a.evidence), JSON.stringify(a.evidence?.gaps));
  check('記録の節は「未実施(理由)」と出す', /知財潔白性の検査: \*\*未実施\*\*\(コマンドが未設定\)/.test(a.report), a.report.split('\n').filter((l) => /知財潔白性/.test(l)).join('\n'));
  W.done();
}
{
  const W = workspace({ product: false });
  const r = W.record('success');
  check('IMPL-0995:ng 記録の段: 検査対象が無ければ scanRun false・理由「検査対象が存在しない」', r.code === 0 && r.json?.scanRun === false && r.json?.reason === '検査対象が存在しない', r.out);
  const a = W.aggregate();
  check('IMPL-0995:ng 項目4: 対象なしは「未実施(検査対象が存在しない)」', /未実施\(検査対象が存在しない\)/.test(row4(a.report)), row4(a.report) || a.out);
  check('構成で選んだ未実施(対象なし)は、記載の欠落にしない', a.evidence && !gapOf(a.evidence), JSON.stringify(a.evidence?.gaps));
  W.done();
}
{
  const W = workspace({ licenses: '', prior: { scanRun: true, result: 'success', scannedAt: AT } });
  const a = W.aggregate();
  check('IMPL-0995:ng 古い記録(scanRun true)が残っていても、コマンドが空なら項目4 は未実施', /未実施\(コマンドが未設定\)/.test(row4(a.report)) && !/実施\(success\)/.test(row4(a.report)), row4(a.report) || a.out);
  W.done();
}
{
  const W = workspace();
  const r = W.record('success');
  check('IMPL-0995:ok 記録の段: コマンドあり・対象あり・成功なら scanRun true・result success', r.code === 0 && r.json?.scanRun === true && r.json?.result === 'success', r.out);
  const a = W.aggregate();
  check('IMPL-0995:ok 項目4: 「実施(success)」と出す', /\| 実施\(success\) \|/.test(row4(a.report)), row4(a.report) || a.out);
  check('実施した記録があれば欠落にしない', a.evidence && !gapOf(a.evidence), JSON.stringify(a.evidence?.gaps));
  const f = W.record('failure');
  check('IMPL-0995:ok outcome failure: scanRun true・result failure', f.json?.scanRun === true && f.json?.result === 'failure', f.out);
  W.done();
}
{
  const W = workspace();
  const a = W.aggregate();
  check('記録が無い(license-scan.json が無い)ときは欠落に数える', a.evidence && gapOf(a.evidence), JSON.stringify(a.evidence?.gaps));
  check('記録が無いときの項目4 は「未実施」', row4(a.report).startsWith('| 依存関係のライセンス | 未実施') && !/未実施\(/.test(row4(a.report).split(' / ')[0]), row4(a.report) || a.out);
  W.done();
}
{
  const W = workspace();
  const r = spawnSync(process.execPath, ['scripts/gate/license-scan-record.mjs'], { cwd: W.dir, encoding: 'utf8' });
  check('--outcome が無ければ使い方を出して終了コード 2', r.status === 2, `${r.stdout}${r.stderr}`);
  W.done();
}

console.log('');
if (failures) {
  console.log(`ライセンス検査の記録と表示の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`ライセンス検査の記録と表示の試験: ${checks} 件が期待と一致しました`);
