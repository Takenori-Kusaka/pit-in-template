// 上積みとして示した品質の活動(第7章 7.7.8 の要求事項11 (b))の一覧を、出荷判定の証跡の集約(aggregate-evidence.mjs)が技術負債台帳と
// 履歴に突き合わせることを、通しで試験する(process-compass #412 / ADR-0092。IMPL-0363)。
//
//   node scripts/gate/test-uplift-evidence.mjs
//
// テンプレートの全ファイルを一時のディレクトリへ写し、日付を固定したコミットで技術負債台帳の行を足し、G-1 とステージ移行ゲートの
// 判定記録を置いて集約を実行します。次を確かめます。
//   - 評価の期間の開始(初回は G-1 の判定の日)より前に台帳へ足した、区分「負債」の返却済みの行で、返却の変更を履歴から引ける行は通す
//   - 期間の開始より後に足した行、区分が「負債」「未解決」でない行、返却済みでない行、台帳に無い行、引けない返却の変更を、記載の欠落にする
//   - 「なし」は通す
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
  'q-team-size': 'size-3-9', 'q-biz-phase': 'growth', 'q-external-reviewer': 'reviewer-yes',
};
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
const HEAD = '# 技術負債台帳\n\n| ID | 区分 | 対象 | 内容 | 受容した理由 | 顕在化の兆候 | 返却の目安 | 状態 | 記録者 | 承認した者 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
const row = (id, kind, state) => `| ${id} | ${kind} | — | 内容 ${id} | 理由 | 兆候 | S2 移行時 | ${state} | 名簿 甲 | — |\n`;
const record = (gate, day, uplift) =>
  `# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | ${gate} |\n| 対象 | 案件 |\n| 判定者 | 名簿 戊 |\n| 判定日時 | ${day} 10:00 |\n| 結果 | 通過 |\n\n` +
  (uplift === null
    ? ''
    : '## AI の利用の評価\n\n| 欄 | 記載 |\n| --- | --- |\n| 評価の単位 | 案件 |\n| 下流の指標と比較の基準値 | 変更の失敗率 5% / 基準値 8% / 過去案件の実績 / 運用メトリクス |\n| 総費用の内訳 | 実行 10 万円(実績)ほか |\n| 評価に用いなかった入力 | 自己申告の速度、AI の利用量 |\n' +
      `| 上積みとして示した品質の活動 | ${uplift} |\n| 判定 | 継続 |\n| 縮小・停止の基準に当たる状態での継続 | 該当なし |\n`);

function run(uplift) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-uplift-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const config = quiet(() => buildConfig(ANSWERS, { generatedAt: '2026-08-01T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('process.config.json', JSON.stringify(config, null, 2) + '\n');
  const git = (env, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const at = (day) => ({ GIT_AUTHOR_DATE: `${day}T09:00:00+09:00`, GIT_COMMITTER_DATE: `${day}T09:00:00+09:00` });
  git({}, 'init', '-q', '-b', 'main');
  git({}, 'config', 'user.email', 't@example.com');
  git({}, 'config', 'user.name', 'tester');
  git({}, 'config', 'core.autocrlf', 'false');
  git({}, 'config', 'gc.auto', '0');
  git({}, 'config', 'maintenance.auto', 'false');
  const commit = (day, msg) => {
    git({}, 'add', '-A');
    git(at(day), 'commit', '-q', '-m', msg);
    return git({}, 'rev-parse', 'HEAD').trim().slice(0, 8);
  };
  write('docs/debt-ledger.md', HEAD + row('D-001', '負債', '未返却') + row('D-003', '例外', '未返却') + row('D-004', '負債', '未返却'));
  commit('2026-08-20', 'chore: fixture');
  write('docs/gates/2026-09-01-g1.md', record('G-1 企画承認', '2026-09-01', null));
  commit('2026-09-01', 'docs: G-1');
  write('docs/debt-ledger.md', HEAD + row('D-001', '負債', '未返却') + row('D-002', '負債', '未返却') + row('D-003', '例外', '未返却') + row('D-004', '負債', '未返却'));
  commit('2026-10-10', 'docs: D-002 を足す');
  write('src/a.js', 'export const a = 1;\n');
  const ret = commit('2026-10-20', 'fix: 招待の一覧を分割して取得する (#5)\n\nRisk: R3\nVerification: 手元で試験を通した');
  write('docs/debt-ledger.md', HEAD + row('D-001', '負債', '返却済み') + row('D-002', '負債', '返却済み') + row('D-003', '例外', '返却済み') + row('D-004', '負債', '未返却'));
  commit('2026-10-21', 'docs: 返却を記録する');
  write('docs/gates/2026-11-01-sg.md', record('ステージ移行', '2026-11-01', uplift(ret)));
  commit('2026-11-01', 'docs: SG');
  const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

const lines = (out) => out.split('\n').filter((l) => /上積みとして示した品質の活動」/.test(l));
{
  const out = run((ret) => `D-001(返却の変更 #5)、D-002(返却の変更 ${ret})、D-003、D-004、D-009、#77`);
  const ls = lines(out);
  check('試験の前提: 集約が最後まで走る', /を出力しました/.test(out), out.slice(-1200));
  // IMPL-0363:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('期間の開始より前に足した返却済みの「負債」の行(D-001)は通す', !ls.some((l) => /D-001 /.test(l)), ls.join('\n'));
  check('引ける返却の変更(#5、コミットの識別子)は通す', !ls.some((l) => /返却の変更 (#5|[0-9a-f]{8}) を履歴から確かめられません/.test(l)), ls.join('\n'));
  // IMPL-0363:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('期間の開始(G-1 の判定の日)より後に足した行(D-002)を欠落にする', ls.some((l) => /D-002 を台帳へ足したのは 2026-10-10 で、評価の期間の開始\(2026-09-01\)より前ではありません/.test(l)), ls.join('\n') || out.slice(-1200));
  check('区分が「負債」「未解決」でない行(D-003)を欠落にする', ls.some((l) => /D-003 の区分は「例外」/.test(l)), ls.join('\n'));
  check('返却済みでない行(D-004)を欠落にする', ls.some((l) => /D-004 の状態は「未返却」/.test(l)), ls.join('\n'));
  check('台帳に無い行(D-009)を欠落にする', ls.some((l) => /D-009 が技術負債台帳/.test(l)), ls.join('\n'));
  check('引けない返却の変更(#77)を欠落にする', ls.some((l) => /返却の変更 #77 を履歴から確かめられません/.test(l)), ls.join('\n'));
}
{
  const out = run(() => 'なし');
  check('「なし」は通す', !lines(out).length, lines(out).join('\n'));
}

console.log('');
if (failures) {
  console.log(`上積みの一覧の突合の通しの試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`上積みの一覧の突合の通しの試験: ${checks} 件が期待と一致しました`);
