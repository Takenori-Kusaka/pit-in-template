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
  check('S1 で G-6 の範囲をコア機能に限る構成は、項目2 に範囲の限定として載る', rows.some((l) => /^\| G-6 独立レビュー \| 範囲の限定\(コア機能\)/.test(l)), rows.join('\n'));
  // #435 の裁定6: 項目2 の文は集約の数え方と一致させる。この構成はコア機能のパスを宣言しないため、集約は全変更を数える
  check(
    '項目2: コア機能のパスが未宣言の構成は、集約が範囲を限らず全変更を数えた旨を状態に出し、数え方とブランチ保護の承認数との差を理由に載せる',
    rows.some((l) => /^\| G-6 独立レビュー \| 範囲の限定\(コア機能\)。コア機能のパスが未宣言のため、集約は範囲を限らず全変更を数えた \|.*集約の数え方: .*ブランチ保護の必須の承認数はパスで分けられない/.test(l)),
    rows.join('\n')
  );
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

// ---------------------------------------------------------------- G-6 の範囲(コア機能)を集約が読む(process-compass #435)
// S1 の期間の PR の変更は、コア機能に当たらなければ独立した人の確認の欠落に数えない。歯止めの4点(パスの未宣言、親の版と HEAD の版の
// パスの和、S0 から移った後の最初の出荷、PR を経ないコミット)と、S0 の期間の変更(前提3)は全変更で数える。
// 模擬の gh を PATH の先頭に置く(Windows では置き方が異なるため省く。CI は Linux で走る)。PR の対応づけ(commits/<sha>/pulls)だけを返す
if (process.platform === 'win32') {
  console.log('---- G-6 の範囲の集約の場面(模擬の gh): Windows では省きます(CI で確かめる)');
} else {
  const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-fake-gh-scope-'));
  fs.writeFileSync(
    path.join(BIN, 'gh'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "const map = JSON.parse(fs.readFileSync(process.env.FAKE_GH_MAP, 'utf8'));",
      "const target = args.find((a) => a.startsWith('repos/')) ?? '';",
      "if (args[0] === 'api' && Object.prototype.hasOwnProperty.call(map, target)) { process.stdout.write(JSON.stringify(map[target])); process.exit(0); }",
      "if (args[0] === 'api' && /\\/(pulls|reviews|commits)$/.test(target)) { process.stdout.write('[]'); process.exit(0); }",
      "if (args[0] === 'pr' && args[1] === 'view' && map[`pr/${args[2]}`]) { process.stdout.write(JSON.stringify(map[`pr/${args[2]}`])); process.exit(0); }",
      'process.exit(1);',
      '',
    ].join('\n')
  );
  fs.chmodSync(path.join(BIN, 'gh'), 0o755);
  const R = 'example/scope';
  const cfgOf = (answers, edit = (c) => c) => edit(quiet(() => buildConfig({ ...ANSWERS, ...answers }, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config));
  const withPaths = (paths) => (c) => ({ ...c, delegation: { ...(c.delegation ?? {}), protectedPaths: paths } });
  /**
   * 履歴を作って集約する。steps: [{ config } | { file, pr } | { file } (PR を経ないコミット) | { tag }]。
   * PR の変更は承認の無い1コミット(模擬の gh がそのコミットを PR のマージコミットとして返す)
   */
  const history = (first, steps) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-g6-scope-'));
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
    }
    const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    put('process.config.json', JSON.stringify(first, null, 2) + '\n');
    for (const f of ['src/core/a.js', 'src/ui/b.js', 'src/misc/c.js']) put(f, 'export const v = 0;\n');
    g('init', '-q', '-b', 'main');
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'tester'], ['core.autocrlf', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false']]) g('config', k, v);
    g('add', '-A');
    g('commit', '-q', '-m', 'chore: fixture');
    const map = {};
    const shas = {};
    let n = 0;
    for (const s of steps) {
      if (s.tag) {
        g('tag', s.tag);
        continue;
      }
      if (s.config) put('process.config.json', JSON.stringify(s.config, null, 2) + '\n');
      else put(s.file, `export const v = ${++n};\n`);
      g('add', '-A');
      g('commit', '-q', '-m', `${s.config ? 'chore: 構成を差し替える' : `feat: ${s.file} を変える`}\n\nRisk: R3\nVerification: node --check を実行して通過`);
      const sha = g('rev-parse', 'HEAD');
      if (s.pr) {
        shas[s.pr] = sha;
        map[`repos/${R}/commits/${sha}/pulls`] = [{ number: s.pr, merged_at: '2026-11-05T00:00:00Z', merge_commit_sha: sha, head: { sha: `head-${s.pr}` }, user: { login: 'acc1', id: null } }];
        map[`repos/${R}/pulls/${s.pr}/reviews`] = [];
        map[`repos/${R}/pulls/${s.pr}/commits`] = [{ author: { login: 'acc1', id: null } }];
        map[`pr/${s.pr}`] = {
          number: s.pr, title: `feat: ${s.file} を変える`, author: { login: 'acc1' }, reviews: [], statusCheckRollup: [], labels: [], createdAt: '2026-11-05T00:00:00Z',
          body: '## リスク区分\n\n- [x] R3\n', mergeCommit: { oid: sha }, commits: [{ oid: `head-${s.pr}`, messageHeadline: `feat: ${s.file} を変える`, authors: [{ login: 'acc1' }] }],
          headRefOid: `head-${s.pr}`, headRefName: `feature/pr-${s.pr}`,
        };
      } else if (s.file) shas[s.file] = sha;
    }
    const mapFile = path.join(BIN, `map-${path.basename(dir)}.json`);
    fs.writeFileSync(mapFile, JSON.stringify(map));
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_MAP: mapFile, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: R, GH_TOKEN: '', GITHUB_TOKEN: '' } });
    const evFile = path.join(dir, 'evidence/evidence.json');
    const ev = fs.existsSync(evFile) ? JSON.parse(fs.readFileSync(evFile, 'utf8')) : null;
    const reportPath = path.join(dir, 'evidence/quality-report.md');
    const report = (fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '').replace(/\r\n/g, '\n');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const gaps = (ev?.gaps ?? []).map(String);
    const prGap = (num) => gaps.find((x) => x.startsWith(`PR #${num}: 独立した人の確認を経ていません`)) ?? null;
    const commitGap = (file) => gaps.find((x) => shas[file] && x.includes(shas[file].slice(0, 7)) && /PR を経ておらず、独立した人の確認を経ていません/.test(x)) ?? null;
    const pr = (num) => (ev?.prs ?? []).find((p) => p.number === num) ?? null;
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ev, report, gaps, prGap, commitGap, pr };
  };
  const indepGaps = (h) => h.gaps.filter((x) => /独立した人の確認/.test(x)).join('\n') || h.out.slice(-1500);
  const S1 = cfgOf({}, withPaths(['src/core/**']));

  {
    // 適合: S1・CL0・コア機能のパスを宣言。PR を経たコア機能でない変更は欠落に数えない。コア機能の PR と PR を経ないコミットは数える
    const h = history(S1, [{ file: 'src/ui/b.js', pr: 1 }, { file: 'src/core/a.js', pr: 2 }, { file: 'src/misc/c.js' }]);
    check('G-6 の範囲の前提: 集約が最後まで走り、PR を対応づける', Boolean(h.ev) && Boolean(h.pr(1)) && Boolean(h.pr(2)), h.out.slice(-1500));
    // IMPL-0469:ok(違反と適合の対。標準の実装マーク。process-compass #435)
    check('S1 の期間の、PR を経たコア機能でない変更は、独立した人の確認の欠落に数えない', h.prGap(1) === null && h.pr(1)?.g6Scope?.outOfScope === true, indepGaps(h));
    // IMPL-0469:ng(違反と適合の対。標準の実装マーク。process-compass #435)
    check('S1 の期間の、コア機能の PR の変更は欠落に数え、当たったファイルを添える', /G-6 の範囲\(コア機能\)に当たる変更: src\/core\/a\.js/.test(h.prGap(2) ?? '') && h.prGap(1) === null, indepGaps(h));
    // 歯止め4: PR を経ないコミットは範囲を限らない
    // IMPL-0470:ng(違反と適合の対。標準の実装マーク。process-compass #435)
    check('歯止め4: PR を経ない、コア機能でない変更のコミットは、範囲を限らず欠落に数える', h.commitGap('src/misc/c.js') !== null && h.prGap(1) === null, indepGaps(h));
    const g6 = item2(h.report).find((l) => /^\| G-6 /.test(l)) ?? '';
    // IMPL-0471:ok(違反と適合の対。標準の実装マーク。process-compass #435)
    check('項目2: 集約が範囲を限った出荷は「範囲の限定(コア機能)」とし、数え方とブランチ保護の承認数との差を理由に載せる', /^\| G-6 独立レビュー \| 範囲の限定\(コア機能\) \|/.test(g6) && /集約の数え方: /.test(g6) && /PR の経路では全変更に承認が掛かる/.test(g6), g6 || item2(h.report).join('\n'));
  }
  {
    // 歯止め1: コア機能のパスが未宣言なら全変更を数え、理由を添える
    const h = history(cfgOf({}), [{ file: 'src/ui/b.js', pr: 1 }]);
    // IMPL-0470:ng(違反と適合の対。標準の実装マーク。process-compass #435)
    check('歯止め1: コア機能のパスが未宣言の構成は、コア機能でない PR の変更も欠落に数え、未宣言の理由を添える', /コア機能のパス.*未宣言のため、範囲を限らずに数えた/.test(h.prGap(1) ?? ''), indepGaps(h));
    const g6 = item2(h.report).find((l) => /^\| G-6 /.test(l)) ?? '';
    // IMPL-0471:ng(違反と適合の対。標準の実装マーク。process-compass #435)
    check('項目2: パスが未宣言の構成は、集約が範囲を限らず全変更を数えた旨を状態に出す', /範囲の限定\(コア機能\)。コア機能のパスが未宣言のため、集約は範囲を限らず全変更を数えた/.test(g6), g6 || item2(h.report).join('\n'));
  }
  {
    // 歯止め2: 親の版と HEAD の版のパスの和で判定する。後から狭めた宣言で、過去の変更を範囲の外へ出さない
    const wide = cfgOf({}, withPaths(['src/core/**', 'src/ui/**']));
    const h = history(wide, [{ file: 'src/ui/b.js', pr: 1 }, { config: S1 }, { file: 'src/misc/c.js', pr: 2 }]);
    // IMPL-0470:ng(違反と適合の対。標準の実装マーク。process-compass #435)
    check('歯止め2: 変更の親の版でコア機能に当たる変更は、HEAD で宣言を狭めても欠落に数える(対照のコア機能でない PR は数えない)', /G-6 の範囲\(コア機能\)に当たる変更: src\/ui\/b\.js/.test(h.prGap(1) ?? '') && h.pr(1)?.g6Scope?.core?.atParent === true && h.pr(1)?.g6Scope?.core?.atHead === false && h.prGap(2) === null, indepGaps(h));
  }
  {
    // 歯止め3 と前提3: S0 の期間の変更は全変更で数え、S0 から移った後の最初の出荷は全変更で数える
    const S0 = cfgOf({ 'q-biz-phase': 'poc' }, withPaths(['src/core/**']));
    const first = history(S0, [{ file: 'src/ui/b.js', pr: 1 }, { config: S1 }, { file: 'src/misc/c.js', pr: 2 }]);
    // IMPL-0470:ng(違反と適合の対。標準の実装マーク。process-compass #435)
    check('前提3: S0 の期間のコア機能でない PR の変更は、S1 へ移った後の出荷で欠落に数える', /変更の親の版の構成が事業ステージ S0 のため/.test(first.prGap(1) ?? ''), indepGaps(first));
    // IMPL-0470:ng(違反と適合の対。標準の実装マーク。process-compass #435)
    check('歯止め3: S0 から移った後の最初の出荷では、S1 の期間のコア機能でない PR の変更も欠落に数える', /S0 から移った後の最初の出荷/.test(first.prGap(2) ?? ''), indepGaps(first));
    const g6 = item2(first.report).find((l) => /^\| G-6 /.test(l)) ?? '';
    check('項目2: S0 から移った後の最初の出荷は、集約が範囲を限らず全変更を数えた旨を状態に出す', /S0 から移った後の最初の出荷のため、集約は範囲を限らず全変更を数えた/.test(g6), g6 || item2(first.report).join('\n'));
    const second = history(S0, [{ file: 'src/ui/b.js', pr: 1 }, { config: S1 }, { tag: 'v1' }, { file: 'src/misc/c.js', pr: 2 }, { tag: 'v2' }]);
    // IMPL-0470:ok(違反と適合の対。標準の実装マーク。process-compass #435)
    check('歯止め3: 移行の後の2回目の出荷では、S1 の期間のコア機能でない PR の変更を欠落に数えない', Boolean(second.pr(2)) && second.prGap(2) === null && second.pr(2)?.g6Scope?.outOfScope === true, indepGaps(second));
  }
  {
    // 対照: CL1 は G-6 を全変更に適用する(エンジンが scope all)。範囲の限定は効かない
    const h = history(cfgOf({ 'q-criticality': 'cl1' }, withPaths(['src/core/**'])), [{ file: 'src/ui/b.js', pr: 1 }]);
    check('CL1 の構成は、コア機能でない PR の変更も欠落に数える(範囲 all)', h.prGap(1) !== null && h.pr(1)?.g6Scope?.limited === false, indepGaps(h));
  }
  fs.rmSync(BIN, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`${failures} / ${checks} 件が失敗しました`);
  process.exit(1);
}
console.log(`すべて通過しました(${checks} 件)`);
