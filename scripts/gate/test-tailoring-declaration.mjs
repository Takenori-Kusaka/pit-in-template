// 保証の開示の項目2(テーラリングの宣言)を、出荷判定の証跡の集約(aggregate-evidence.mjs)の通しで試験する
// (process-compass #374 / ADR-0112 決定1・決定4)。
//
//   node scripts/gate/test-tailoring-declaration.mjs
//
// テンプレートの全ファイルを一時のディレクトリへ写し、事業ステージ S1・安全重要度 CL0 の構成で集約を実行し、品質レポートの項目2 を確かめます。
//   - S1 で独立レビュー(G-6)の範囲をコア機能に限る構成は、項目2 に「範囲の限定(コア機能)」として載る
//   - S1 の出荷判定(G-7)は適用であり、項目2 に載らない
//   - 旧い構成(簡略で記録された S1 の G-7)は、項目2 に「未適用の厳格化」として載る。CL0 では欠落に数えない
// GitHub へ問い合わせません。リポジトリの状態を変えません。

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
  'q-team-size': 'size-3-9', 'q-biz-phase': 'mvp', 'q-external-reviewer': 'reviewer-yes',
};
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));

/** 構成を書き換えて集約を実行し、品質レポートと集約の出力を返す */
function run(edit = (c) => c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-tailoring-declaration-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const config = edit(quiet(() => buildConfig(ANSWERS, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config));
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(config, null, 2) + '\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: fixture');
  const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  const reportPath = path.join(dir, 'evidence/quality-report.md');
  const report = (fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '').replace(/\r\n/g, '\n');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, report };
}
/** 項目2 の節の行 */
const item2 = (report) => {
  const lines = report.split('\n');
  const i = lines.findIndex((l) => l.startsWith('### 2. テーラリングの宣言'));
  if (i < 0) return [];
  const end = lines.findIndex((l, j) => j > i && l.startsWith('### '));
  return lines.slice(i + 1, end < 0 ? undefined : end).filter((l) => l.trim());
};
/** 出荷の証跡の欠落の行(G-7 の未適用の厳格化を欠落に数えたか) */
const gapLines = (r) => `${r.report}\n${r.out}`.split('\n').filter((l) => /未適用の厳格化/.test(l) && /欠落として数える|::error::/.test(l));

{
  const r = run();
  const rows = item2(r.report);
  check('試験の前提: 品質レポートに項目2 の節が出る', rows.length > 0, r.out.slice(-1200));
  // 項目2 に範囲の限定を載せる(process-compass #374 / ADR-0112 決定1)
  // IMPL-0448:ok(違反と適合の対。標準の実装マーク。process-compass #374)
  check('S1 で G-6 の範囲をコア機能に限る構成は、項目2 に範囲の限定として載る', rows.some((l) => /^\| G-6 独立レビュー \| 範囲の限定\(コア機能\) \|/.test(l)), rows.join('\n'));
  check('S1 の G-7 は適用であり、項目2 に載らない', !rows.some((l) => /^\| G-7 /.test(l)), rows.join('\n'));
  // 突合 X-7: 範囲の限定の行の理由は、範囲の設定の注記だけ。レビューの方式など別の設定の注記を混ぜない
  const g6 = rows.find((l) => /^\| G-6 /.test(l)) ?? '';
  check('範囲の限定の行の理由は、範囲の設定の注記だけ', /コア機能のみ実施する/.test(g6) && !/作成者と分離して実施する/.test(g6), g6);
}
{
  const r = run((c) => ({ ...c, gates: { ...c.gates, g7: { ...c.gates.g7, state: 'simplified' } } }));
  const rows = item2(r.report);
  // 突合 X-5: 状態は日本語の語で出す(内部の値 required を出さない)
  // IMPL-0448:ng(違反と適合の対。旧い構成の G-7 の簡略を、未適用の厳格化として表示する。process-compass #374)
  check(
    '旧い構成(簡略で記録された S1 の G-7)は、項目2 に未適用の厳格化として載る',
    rows.some((l) => /^\| G-7 出荷判定 \| 簡略化。未適用の厳格化: 現行の規則の再導出では適用。欠落には数えない \|/.test(l)) && !rows.some((l) => /required/.test(l)),
    rows.join('\n')
  );
  check('CL0 の旧い構成の G-7 の未適用の厳格化は、欠落に数えない', gapLines(r).length === 0, gapLines(r).join('\n'));
}
{
  // 突合 X-3: 項目2 に未適用の厳格化を添えるのは、簡略で記録された G-7 に限る。ほかのゲートの旧い状態には添えない
  const r = run((c) => ({ ...c, gates: { ...c.gates, g2: { ...c.gates.g2, state: 'omitted' } } }));
  const g2 = item2(r.report).find((l) => /^\| G-2 /.test(l)) ?? '';
  check('G-7 以外のゲートの旧い状態には、項目2 で未適用の厳格化を添えない', /^\| G-2 要件合意 \| 省略 \|/.test(g2) && !/未適用の厳格化/.test(g2), g2 || item2(r.report).join('\n'));
}
{
  const r = run((c) => ({ ...c, gates: { ...c.gates, g6: { ...c.gates.g6, params: { ...c.gates.g6.params, scope: 'all' } } } }));
  check('G-6 を全変更に適用する構成は、項目2 に G-6 の行を出さない', !item2(r.report).some((l) => /^\| G-6 /.test(l)), item2(r.report).join('\n'));
}

console.log('');
if (failures) {
  console.error(`${failures} / ${checks} 件が失敗しました`);
  process.exit(1);
}
console.log(`すべて通過しました(${checks} 件)`);
