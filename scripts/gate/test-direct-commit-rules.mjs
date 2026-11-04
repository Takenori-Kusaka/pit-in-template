// PR を経ないコミットに、区分の下限の規則と判断記録の要否の規則を当てることを、出荷判定の証跡の集約(aggregate-evidence.mjs)の
// 通しで試験する(標準 第3章 3.8.1 の要求事項2・6、第2章 2.6 の要求事項2・6。process-compass #423 / ADR-0101。IMPL-0389・IMPL-0391)。
//
//   node scripts/gate/test-direct-commit-rules.mjs
//
// テンプレートの全ファイルを一時のディレクトリへ写し、区分の下限の規則(src/auth/** → R1)と判断記録の要否の規則(src/api/**)を
// 置いた構成で、PR を経ないコミットを積んで集約を実行します。次を確かめます。
//   - 下限より低い区分のトレーラ Risk を持つコミットを、記載の欠落にする。下限以上なら出さない
//   - 規則に当たりトレーラ ADR が無い(または指す判断記録がそのコミットに無い)コミットを、記載の欠落にする。実在する判断記録を指せば出さない
//   - 規則と製品のコードを同じコミットで変えたら、記載の欠落にする
//   - 事業ステージ S0 では、判断記録の要否の当たりを欠落にせず、品質レポートの注意に出す
// 欠落の件数そのもの(ほかの記録の欠落)は確かめません。GitHub へ問い合わせません。リポジトリの状態を変えません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

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
  'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes',
};
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
const RULES = {
  riskFloor: { rules: [{ id: 'auth', paths: ['src/auth/**'], floor: 'R1', why: '認証・認可' }] },
  decisionRules: { rules: [{ id: 'public-api', paths: ['src/api/**'], why: '公開インタフェース' }] },
};

function workspace(phase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-direct-rules-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const config = quiet(() => buildConfig({ ...ANSWERS, 'q-biz-phase': phase }, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('process.config.json', JSON.stringify({ ...config, ...RULES }, null, 2) + '\n');
  write('src/auth/login.js', 'export const a = 1;\n');
  write('src/api/handler.js', 'export const h = 1;\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: fixture');
  const commit = (subject, trailers, files) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git('add', '-A');
    git('commit', '-q', '-m', `${subject}\n\n${trailers}\nVerification: 手元で試験を実行し、通過を確かめた`);
    return git('rev-parse', 'HEAD').trim().slice(0, 8);
  };
  const run = () => {
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    const report = fs.existsSync(path.join(dir, 'evidence/quality-report.md')) ? fs.readFileSync(path.join(dir, 'evidence/quality-report.md'), 'utf8') : '';
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, report };
  };
  const done = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { commit, run, done, read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8') };
}

const linesOf = (out, id) => out.split('\n').filter((l) => l.includes(`コミット ${id}`));
{
  const w = workspace('growth');
  const low = w.commit('fix: auth', 'Risk: R3', { 'src/auth/login.js': 'export const a = 2;\n' });
  const ok1 = w.commit('fix: auth again', 'Risk: R1', { 'src/auth/login.js': 'export const a = 3;\n' });
  const noAdr = w.commit('feat: api', 'Risk: R2', { 'src/api/handler.js': 'export const h = 2;\n' });
  const ghost = w.commit('feat: api ghost', 'Risk: R2\nADR: ADR-0009', { 'src/api/handler.js': 'export const h = 3;\n' });
  const withAdr = w.commit('feat: api adr', 'Risk: R2\nADR: ADR-0001', { 'src/api/handler.js': 'export const h = 4;\n', 'context/decisions/0001-api-shape.md': '# ADR-0001: 公開インタフェースの形\n' });
  const cfg = JSON.parse(w.read('process.config.json'));
  cfg.riskFloor = { rules: [] };
  const both = w.commit('chore: rules and code', 'Risk: R2', { 'process.config.json': JSON.stringify(cfg, null, 2) + '\n', 'src/a.js': 'export const x = 1;\n' });
  const r = w.run();
  check('試験の前提: 集約が最後まで走る', /を出力しました/.test(r.out), r.out);
  // IMPL-0391:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('区分の下限: 規則(src/auth/**、下限 R1)に当たる R3 のコミットを欠落にする', linesOf(r.out, low).some((l) => /区分 R3 は、変更の対象から導いた下限 R1 より低い/.test(l)), linesOf(r.out, low).join('\n') || r.out);
  // IMPL-0391:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('区分の下限: 下限以上(R1)のコミットには出さない', !linesOf(r.out, ok1).some((l) => /下限/.test(l)), linesOf(r.out, ok1).join('\n'));
  // IMPL-0389:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('判断記録の要否: 規則に当たりトレーラ ADR の無いコミットを欠落にする', linesOf(r.out, noAdr).some((l) => /判断記録の要否の規則に当たります.*トレーラ ADR が無い/.test(l)), linesOf(r.out, noAdr).join('\n') || r.out);
  check('判断記録の要否: 指す判断記録がそのコミットに無ければ欠落にする', linesOf(r.out, ghost).some((l) => /ADR-0009\)が、そのコミットの context\/decisions\/ に無い/.test(l)), linesOf(r.out, ghost).join('\n') || r.out);
  // IMPL-0389:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('判断記録の要否: 実在する判断記録を指すコミットには出さない', !linesOf(r.out, withAdr).some((l) => /判断記録の要否/.test(l)), linesOf(r.out, withAdr).join('\n'));
  check('規則と製品のコードを同じコミットで変えたら欠落にする', linesOf(r.out, both).some((l) => /区分の下限の規則\(process\.config\.json の riskFloor\)と製品のコード/.test(l)), linesOf(r.out, both).join('\n') || r.out);
  w.done();
}
{
  const w = workspace('poc');
  const noAdr = w.commit('feat: api', 'Risk: R2', { 'src/api/handler.js': 'export const h = 2;\n' });
  const r = w.run();
  check('S0: 判断記録の要否の当たりを欠落にしない', !linesOf(r.out, noAdr).some((l) => /判断記録の要否/.test(l)), linesOf(r.out, noAdr).join('\n'));
  check('S0: 品質レポートに注意として出す', /注意: コミット [0-9a-f]{8}: .*判断記録の要否の規則に当たります.*S0 のため欠落にしない/.test(r.report), r.report.split('\n').filter((l) => /注意/.test(l)).join('\n') || r.out.slice(-800));
  w.done();
}

console.log('');
if (failures) {
  console.log(`PR を経ないコミットの規則の通しの試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`PR を経ないコミットの規則の通しの試験: ${checks} 件が期待と一致しました`);
