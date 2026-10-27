// 記録の無い非推奨の兼務を、出荷判定の証跡の集約(aggregate-evidence.mjs)が記載の欠落にすることを、通しで試験する
// (標準 第3章 3.5、第4章 G-7 基準9、第6章 テンプレ0 表5。process-compass #312 の IMPL-0298。突合 5節の推奨)。
//
//   node scripts/gate/test-discouraged-evidence.mjs
//
// テンプレートの全ファイルを一時のディレクトリへ写し、3〜9名で価値責任者と技術判断者を同じ人にした構成を置いて、
// 集約を実行します。次を確かめます。
//   - D-0 節2「非推奨の兼務の記録」に行が無ければ、集約が欠落を出して失敗する。欠落の文が写す元を示す
//   - 組・責任者・理由のある行を書けば、その欠落は出ない
//   - 兼務していない構成では、この欠落は出ない
// 欠落の件数そのもの(ほかの記録の欠落)は確かめません。この試験が見るのは、非推奨の兼務の行だけです。
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
  'q-quality': 'quality-standard',
  'q-criticality': 'cl0',
  'q-dev-form': 'inhouse',
  'q-existing-gates': 'gates-none',
  'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9',
  'q-biz-phase': 'growth',
  'q-external-reviewer': 'reviewer-yes',
};
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const seatsOf = (map) => Object.entries(map).map(([role, accountable]) => ({ role, accountable }));
const SHARED = seatsOf({ 'value-owner': 'p0', 'tech-lead': 'p0', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' });
const SEPARATE = seatsOf({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' });
const RECORD_ROW = '| 価値責任者 × 技術判断者 | 名簿 甲 | 技術判断を担える人が他にいない | 2026-10-23 |';
const PATTERN = /非推奨の兼務です.*記載の欠落です/;

function workspace(seats, recordRow) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-discouraged-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const config = quiet(() => buildConfig(ANSWERS, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, people: PEOPLE, seats }).config);
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(config, null, 2) + '\n');
  let d0 = fs.readFileSync(path.join(dir, 'templates/00-d0-governance.md'), 'utf8');
  if (recordRow) d0 = d0.replace(/(\| 兼務する組 \| 責任者 \| 兼務を選んだ理由 \| 記録日 \|\n\| --- \| --- \| --- \| --- \|\n)\| \| \| \| \|/, `$1${recordRow}`);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/D-0-governance.md'), d0);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  // コミットの後に git が裏で走らせる自動の保守(gc・maintenance)が .git/objects へ書き込み、後片付けの削除と競合する(CI の git 2.55 で ENOTEMPTY)
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: fixture');
  const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, recorded: Boolean(recordRow) && d0.includes(recordRow) };
}

{
  const r = workspace(SHARED, null);
  const lines = r.out.split('\n').filter((l) => PATTERN.test(l));
  // IMPL-0298:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('記録が無ければ、集約が非推奨の兼務を記載の欠落として出す', lines.length === 1, r.out);
  check('欠落があるとき、集約は失敗する(G-7 を通過できない)', r.status === 1 && /出荷判定\(G-7\)は通過できません/.test(r.out), r.out);
  check('欠落の文が、写す元(templates/00-d0-governance.md の節2)を示す', lines.some((l) => /templates\/00-d0-governance\.md の節2/.test(l)), lines.join('\n'));
}
{
  const r = workspace(SHARED, RECORD_ROW);
  check('試験の前提: D-0 の記録の表へ行を書き込めた', r.recorded);
  check('記録のある構成でも集約は最後まで走る(試験の前提)', /を出力しました/.test(r.out), r.out);
  // IMPL-0298:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('組・責任者・理由のある行があれば、非推奨の兼務の欠落は出ない', !r.out.split('\n').some((l) => PATTERN.test(l)), r.out);
}
{
  const r = workspace(SEPARATE, null);
  check('兼務していない構成でも集約は最後まで走る(試験の前提)', /を出力しました/.test(r.out), r.out);
  check('兼務していない構成では、非推奨の兼務の欠落は出ない', !r.out.split('\n').some((l) => PATTERN.test(l)), r.out);
}

console.log('');
if (failures) {
  console.log(`非推奨の兼務の欠落の通しの試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`非推奨の兼務の欠落の通しの試験: ${checks} 件が期待と一致しました`);
