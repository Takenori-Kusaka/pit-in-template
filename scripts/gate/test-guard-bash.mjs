// ホスティングへの書き込みの操作の遮断(.claude/hooks/guard-bash.mjs)の試験
// (標準 第3章 3.5.3「人と AI の担い手の名義」。process-compass #429 / ADR-0107。IMPL-0418)。
// AI の担い手による PR のマージの拒否(手動のスタックの中間の層のマージを含む。process-compass #360 H-5 / IMPL-0255)も固定する。
//
//   node scripts/gate/test-guard-bash.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostingWriteOf, segmentsOf } from '../../.claude/hooks/guard-bash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 400)}`}`);
}

// IMPL-0418:ng(違反と適合の対。標準の実装マーク。process-compass #314)
const denied = [
  'gh pr review 12 --approve',
  'gh pr review 12 --comment -b "例外承認: D-001"',
  'gh pr merge 12 --squash',
  'gh auth token',
  'gh api repos/o/r/pulls/12/reviews -f event=APPROVE',
  'gh api -X POST repos/o/r/pulls/12/reviews',
  'gh api --method=PUT repos/o/r/pulls/12/merge',
  'gh api repos/o/r/pulls/12/reviews --input body.json',
  'gh api graphql -f query=\'mutation { addPullRequestReview(input: {}) { clientMutationId } }\'',
  'cd x && GH_TOKEN=abc gh api repos/o/r/issues/1/comments -F body=@c.md',
  'curl -X POST https://api.github.com/repos/o/r/pulls/12/reviews -d \'{"event":"APPROVE"}\'',
  'curl -H "Authorization: token $(gh auth token)" https://api.github.com/user',
  'git status; gh pr merge 3',
  'bash -c "gh pr merge 1 --squash"',
  '(gh pr merge 1)',
  'gh pr -R o/r merge 1',
  'timeout 30 gh pr review 1 --approve',
  'gh pr merge 1 &',
  'if true; then gh pr merge 1; fi',
  'curl -d@body.json https://api.github.com/repos/o/r/pulls/1/reviews',
  'curl --request=POST https://api.github.com/repos/o/r/pulls/1/merge',
  'gh api graphql --input q.json',
  'gh api graphql -F query=@q.graphql',
  'gh auth status --show-token',
  'echo $GH_TOKEN',
  'echo "${GITHUB_TOKEN}"',
  'printenv GITHUB_TOKEN',
  'git push origin records',
  'git push origin HEAD:records',
  'eval "gh pr merge 1"',
];
for (const c of denied) check(`拒否: ${c}`, Boolean(hostingWriteOf(c)), String(hostingWriteOf(c)));

// IMPL-0418:ok(違反と適合の対。標準の実装マーク。process-compass #314)
const allowed = [
  'gh pr view 12 --json reviews',
  'gh api repos/o/r/pulls/12/reviews',
  'gh api --paginate repos/o/r/pulls/12/commits',
  'gh api -X GET search/issues -f q=repo:o/r',
  'gh api graphql -f query=\'query { viewer { login } }\'',
  'gh issue list --label state:needs-dev',
  'curl -s https://api.github.com/repos/o/r',
  'git commit -m "gh pr merge は人が行う"',
  'node scripts/gate/next.mjs --brief',
  'echo "gh api -f x" > notes.txt',
  'git commit -m "gh auth token と gh pr merge は使わない"',
  'git push origin main',
  'git push origin feature/x',
  "echo '$GH_TOKEN を使わない'",
  'gh pr list -R o/r',
];
for (const c of allowed) check(`通す: ${c}`, !hostingWriteOf(c), String(hostingWriteOf(c)));

// AI の担い手による PR のマージの拒否(第4章 G-5「取り込み先が既定ブランチになるマージだけを行う」。process-compass #360 H-5)。
// フックは guard.enabled に依らず、gh pr merge と gh api による PR のマージ(REST の pulls/N/merge への書き込み、GraphQL の mutation)を
// 基底に依らず拒否する。中間の層へのマージもこの経路では行えない。
// IMPL-0255:ng(違反と適合の対。標準の実装マーク。process-compass #314)
const mergeDenied = [
  'gh pr merge 12 --squash',
  'gh pr merge --auto 3',
  'gh pr merge 5 --admin --merge',
  'gh pr merge',
  'gh api -X PUT repos/o/r/pulls/5/merge',
  'gh api -XPUT repos/o/r/pulls/5/merge',
  'gh api /repos/o/r/pulls/5/merge -X PUT',
  'gh api --method put repos/{owner}/{repo}/pulls/5/merge',
  'gh api repos/o/r/pulls/5/merge --method PUT -f merge_method=squash',
  'gh api repos/o/r/pulls/5/merge -f merge_method=squash',
  'gh api repos/o/r/pulls/5/merge --input m.json',
  'gh api graphql -f query=\'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }\'',
  'gh api graphql -f query=\'mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }\'',
];
for (const c of mergeDenied) check(`マージの拒否: ${c}`, Boolean(hostingWriteOf(c)), String(hostingWriteOf(c)));

// IMPL-0255:ok(違反と適合の対。標準の実装マーク。process-compass #314)
// 読み取り(マージ済みかの確認)と、手動のスタックの正当な操作(基底の付け替え)は通す。
// 注: `git merge` と `git push` の組は拒否しない。手元で上の層を下の層へ併合して push する経路は中間の層への取り込みと同じ効果を持つが、
// 既定ブランチからの同期(正当な操作)とフックの側で区別できないため(#360 H-5。この経路とスクリプトからの API の呼び出しは
// IMPL-0491 で undelivered。出荷の集約のマージの後の検出(IMPL-0248)も、PR を経ない push の取り込みは拾わない)
const mergeAllowed = [
  'gh api repos/o/r/pulls/5/merge',
  'gh pr view 5 --json baseRefName,mergedAt',
  'gh pr create --base feature/a --title t --body b',
  'gh pr edit 5 --base feature/a',
  'git merge feature/b && git push origin feature/a',
  'git merge origin/main && git push origin feature/a',
];
for (const c of mergeAllowed) check(`マージの拒否の外: ${c}`, !hostingWriteOf(c), String(hostingWriteOf(c)));
{
  const hook = path.join(ROOT, '.claude/hooks/guard-bash.mjs');
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command: 'gh pr merge 7 --squash' } }), encoding: 'utf8', env: { ...process.env } });
  check('フック: gh pr merge は終了コード 2 と理由(変更のマージ)を返す', r.status === 2 && /マージ/.test(r.stderr), `${r.status} ${r.stderr}`);
}

check('区画: 引用符の中の区切りで分けない', segmentsOf('git commit -m "a; b && c" && gh pr view 1').length === 2);
check('区画: 二重引用符の中の $( ) は別の区画として見る', segmentsOf('curl -H "Authorization: token $(gh auth token)" x').some((s) => s.startsWith('gh auth token')));

// フックとして起動したときの終了コード(2 = 拒否)と標準エラー
{
  const hook = path.join(ROOT, '.claude/hooks/guard-bash.mjs');
  const run = (command) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8', env: { ...process.env } });
  const ng = run('gh pr review 1 --approve');
  check('フック: 拒否は終了コード 2 と理由を返す', ng.status === 2 && /拒否しました/.test(ng.stderr), `${ng.status} ${ng.stderr}`);
  const ok = run('gh pr view 1');
  check('フック: 読み取りは終了コード 0', ok.status === 0, `${ok.status} ${ok.stderr}`);
}

console.log(failures ? `\nホスティングへの書き込みの遮断の試験: ${checks} 件のうち ${failures} 件が期待と一致しません` : `\nホスティングへの書き込みの遮断の試験: ${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
