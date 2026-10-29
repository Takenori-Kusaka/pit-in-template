// 外部の確認者が席の責任者である独立レビュアの席を、緩める向きに変える変化点の入口の試験
// (標準 第3章 3.13.3。process-compass #314 / ADR-0084 決定6。IMPL-0115)。
//
//   node scripts/gate/test-loosening-decider.mjs
//
// 固定する決定:
//   - 変化点の入口(generate-profile.mjs --change)が、外部の確認者(独立レビュアの席の責任者)の記名による
//     緩める向きの決定(独立レビュアの席の運用形態を人確定から協働へ上げる)を拒否し、構成を書き換えない(IMPL-0115:ng)
//   - 同じ変化点を、D-0 表1 の決定者(事業決裁者の席の責任者)の記名なら受け付ける(IMPL-0115:ok)
// 関数の単位の試験(test-roster-rules.mjs)に加えて、入口を通して確かめる。一時の置き場で試し、GitHub へ問い合わせません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sealChangeLog } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
function check(name, ok, detail = '') {
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

const A = { id: 'a', name: '山田 太郎', accounts: ['yamada'] };
const X = { id: 'x', name: '高橋 次郎', external: true, accounts: ['takahashi-j'] };
const seatsOf = (map) => Object.entries(map).map(([role, accountable]) => ({ role, accountable }));
const answers = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-1-2', 'q-biz-phase': 'mvp', 'q-external-reviewer': 'reviewer-yes',
};
const config = quiet(
  () =>
    buildConfig(answers, {
      generatedAt: '2026-10-24T09:00:00+09:00',
      d0Version: null,
      people: [A, X],
      seats: seatsOf({ 'biz-approver': 'a', 'dev-verifier': 'a', 'independent-reviewer': 'x' }),
    }).config
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-loosen-'));
try {
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  const cfgPath = path.join(dir, 'process.config.json');
  // 独立レビュアの席を人確定にしておき、協働へ上げる(上限の宣言を上げる = 緩める向き)
  const initial = JSON.parse(JSON.stringify(config));
  initial.seats.find((s) => s.role === 'independent-reviewer').mode = 'human';
  fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(initial), null, 2) + '\n');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'templates/00-d0-governance.md'), path.join(dir, 'docs/D-0-governance.md'));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: init');
  const before = fs.readFileSync(cfgPath, 'utf8');
    const change = (decidedBy) => {
    fs.writeFileSync(
      path.join(dir, 'change.json'),
      JSON.stringify({ kind: 'mode', summary: '独立レビュアの席の運用形態を上げる', seats: { 'independent-reviewer': { mode: 'collab' } }, decidedBy, reason: '試験' })
    );
    const r = spawnSync(process.execPath, ['scripts/init/generate-profile.mjs', '--change', 'change.json'], { cwd: dir, encoding: 'utf8', env });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  // IMPL-0115:ng 外部の確認者(独立レビュアの席の責任者)の記名では受け付けない
  const ng = change(X.name);
  check(
    'IMPL-0115:ng 外部の確認者の記名による、独立レビュアの席を緩める変化点を、入口が拒否する',
    !ng.ok && /外部の確認者であり/.test(ng.out) && /席の責任者の記名では受け付けません/.test(ng.out),
    ng.out
  );
  check('拒否した変化点は、構成を書き換えない', fs.readFileSync(cfgPath, 'utf8') === before);

  // IMPL-0115:ok D-0 表1 の決定者(事業決裁者の席の責任者)の記名なら受け付ける
  const ok = change(A.name);
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const last = after.changeLog.at(-1);
  check(
    'IMPL-0115:ok 同じ変化点を、D-0 表1 の決定者の記名なら受け付け、記名が変化点に残る',
    ok.ok && last.kind === 'mode' && last.decidedBy === A.name && after.changeLog.length === initial.changeLog.length + 1 && after.seats.find((s) => s.role === 'independent-reviewer').mode === 'collab',
    `${ok.out}\n${JSON.stringify(last)}`
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n緩める向きの決定者の入口の試験: ${failures} 件の失敗`);
  process.exit(1);
}
console.log('\n緩める向きの決定者の入口の試験: すべて通過');
