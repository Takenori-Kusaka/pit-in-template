// 既定ブランチへの push の契機の形(push-trigger.mjs)と、/pit の既定ブランチの読み方を試験する
// (標準 第3章 3.13.5、第5章 準拠テンプレート「既存のリポジトリへの持ち込み」。process-compass #362 / ADR-0123)。
//
//   node scripts/gate/test-push-trigger.mjs
//
// 確かめること:
//   - テンプレートの実物(gate-g5.yml・gate-g5-push.yml ほか)が形の約束を満たす
//   - 写しへ入れた変異を検出する(gate-g5.yml へ push を戻す・workflow_call を外す、gate-g5-push.yml を消す・絞りを外す・
//     タグを足す・条件を ref_name にする・呼び先を変える・ジョブの名や ID を gate-g5 にする・名を式にする、
//     ほかのワークフローへ名が gate-g5 のジョブを足す)
//   - next.mjs の既定ブランチの読み方が、既定ブランチが trunk のリポジトリで trunk を返す
// GitHub 上の振る舞い(skipped の呼び出し側のジョブの check run の名など)は確かめない(EV-0245。実機の観測は
// process-compass research/362-deliberation/)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { pushTriggerProblems, readWorkflows, G5_WORKFLOW_FILE, PUSH_WORKFLOW_FILE } from './push-trigger.mjs';
import { defaultBranchOf } from './next.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

// 写しは LF に揃える(Windows の作業ツリーの CRLF で変異の置換が空振りしないため)
const real = Object.fromEntries(Object.entries(readWorkflows(ROOT)).map(([k, v]) => [k, v.replace(/\r\n/g, '\n')]));
const g5 = real[G5_WORKFLOW_FILE];
const push = real[PUSH_WORKFLOW_FILE];
// IMPL-0485:ok
check('テンプレートの実物: push の契機の形の約束を満たす', pushTriggerProblems(real).length === 0, pushTriggerProblems(real).join(' / '));
check('試験の前提: gate-g5.yml と gate-g5-push.yml を読めた', typeof g5 === 'string' && typeof push === 'string');

const withFiles = (patch) => {
  const f = { ...real, ...patch };
  for (const [k, v] of Object.entries(f)) if (v === null) delete f[k];
  return f;
};
const sub = (text, a, b) => {
  if (!text.includes(a)) throw new Error(`変異の置換元が無い: ${a}`);
  return text.replace(a, b);
};
const mutants = [
  ['gate-g5.yml へ push(branches: [main])を戻す', { [G5_WORKFLOW_FILE]: sub(g5, '  workflow_call:', '  push:\n    branches: [main]\n  workflow_call:') }, /gate-g5\.yml が push を契機に持つ/],
  ['gate-g5.yml の workflow_call を外す', { [G5_WORKFLOW_FILE]: sub(g5, '  workflow_call:\n', '').replace('  workflow_call:\r\n', '') }, /workflow_call を持たない/],
  ['gate-g5-push.yml を消す', { [PUSH_WORKFLOW_FILE]: null }, /gate-g5-push\.yml が無い/],
  ['push の絞りを外す(タグでも起動する)', { [PUSH_WORKFLOW_FILE]: sub(push, "    branches: ['**']", '') }, /branches: \['\*\*'\] でない/],
  ['push の絞りを main に固定する', { [PUSH_WORKFLOW_FILE]: sub(push, "    branches: ['**']", '    branches: [main]') }, /branches: \['\*\*'\] でない/],
  ['push にタグの絞りを足す', { [PUSH_WORKFLOW_FILE]: sub(push, "    branches: ['**']", "    branches: ['**']\n    tags: ['v*']") }, /branches のほかの絞り/],
  ['push のほかの契機を足す(workflow_dispatch)', { [PUSH_WORKFLOW_FILE]: sub(push, "    branches: ['**']", "    branches: ['**']\n  workflow_dispatch:") }, /push のほかの契機/],
  ['条件を ref_name で書く', { [PUSH_WORKFLOW_FILE]: sub(push, "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)", 'github.ref_name == github.event.repository.default_branch') }, /ジョブの条件が/],
  ['条件を外す', { [PUSH_WORKFLOW_FILE]: sub(push, "    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)\n", '').replace("    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)\r\n", '') }, /ジョブの条件が/],
  ['呼び先を変える', { [PUSH_WORKFLOW_FILE]: sub(push, 'uses: ./.github/workflows/gate-g5.yml', 'uses: ./.github/workflows/other.yml') }, /gate-g5\.yml を呼ばない/],
  ['呼び出し側のジョブの名を gate-g5 にする', { [PUSH_WORKFLOW_FILE]: sub(push, '    name: default-push', '    name: gate-g5') }, /必須チェックの名 gate-g5 を持つ/],
  ['呼び出し側のジョブの ID を gate-g5 にする', { [PUSH_WORKFLOW_FILE]: sub(push, '  default-push:', '  gate-g5:') }, /必須チェックの名 gate-g5 を持つ/],
  ['呼び出し側のジョブの名を式にする', { [PUSH_WORKFLOW_FILE]: sub(push, '    name: default-push', "    name: ${{ github.event_name == 'push' && 'default-push' || 'gate-g5' }}") }, /名が default-push でない|必須チェックの名 gate-g5/],
  ['ほかのワークフローへ名が gate-g5 のジョブを足す', { '.github/workflows/extra.yml': 'name: extra\non:\n  push:\njobs:\n  check:\n    name: gate-g5\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n' }, /extra\.yml のジョブ check/],
  ['gate-g5.yml の集約以外のジョブの名を gate-g5 にする', { [G5_WORKFLOW_FILE]: sub(g5, '    name: gate-contract', '    name: gate-g5') }, /gate-g5\.yml のジョブ contract/],
];
for (const [name, patch, re] of mutants) {
  let probs;
  try {
    probs = pushTriggerProblems(withFiles(patch));
  } catch (e) {
    check(`変異: ${name}`, false, String(e.message));
    continue;
  }
  // IMPL-0485:ng
  check(`変異: ${name} を検出する`, probs.some((p) => re.test(p)), probs.join(' / ') || '検出なし');
}

// next.mjs の既定ブランチの読み方(一時のリポジトリ。既定ブランチが trunk で、origin の HEAD を持つ)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-push-trigger-'));
try {
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = path.join(TMP, 'origin.git');
  const work = path.join(TMP, 'work');
  fs.mkdirSync(work);
  g(work, 'init', '-q', '-b', 'trunk');
  g(work, 'config', 'user.email', 't@example.invalid');
  g(work, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  g(work, 'add', '-A');
  g(work, 'commit', '-qm', 'init');
  g(TMP, 'init', '-q', '--bare', '-b', 'trunk', origin);
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', 'origin', 'trunk');
  g(work, 'remote', 'set-head', 'origin', 'trunk');
  g(work, 'checkout', '-q', '-b', 'feature/F-001-task-1');
  const gitIn = (dir) => (args) => {
    try {
      return g(dir, ...args);
    } catch {
      return null;
    }
  };
  // /pit の既定ブランチの読み方は規定を運ばない欠陥の修正のため、実装マークを付けない(process-compass #362 implementation.md)
  check('/pit: 既定ブランチが trunk(origin の HEAD)なら trunk を読む', defaultBranchOf(gitIn(work)) === 'trunk', String(defaultBranchOf(gitIn(work))));
  g(work, 'branch', '-q', '-D', 'trunk');
  check('/pit: 手元に trunk が無ければ origin/trunk を読む', defaultBranchOf(gitIn(work)) === 'origin/trunk', String(defaultBranchOf(gitIn(work))));
  // origin の HEAD を持たず、手元に main が無いリポジトリでは null(従来どおり。作業ブランチを既定ブランチとみなさない)
  g(work, 'remote', 'set-head', 'origin', '--delete');
  check('/pit: origin の HEAD も main・master も無ければ既定ブランチを読まない(作業ブランチを既定ブランチとみなさない)', defaultBranchOf(gitIn(work)) === null, String(defaultBranchOf(gitIn(work))));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${n - failures}/${n} 件 通過`);
process.exit(failures ? 1 : 0);
