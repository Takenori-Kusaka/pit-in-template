// 基底から読む判定のワークフロー(gate-g5-base.yml)と、書き込みの権限を持つ record-copy.yml の定義を静的に試験する
// (標準 第4章 G-5「判定のコードの読み元」、議長の裁定 AR-1・AR-2。process-compass #371 / ADR-0115)。
//
//   node scripts/gate/test-base-judge-workflow.mjs
//
// 確かめること(GitHub Security Lab「Preventing pwn requests」の注意に沿う形):
//   - pull_request_target で動き、pull_request・pull_request_review・workflow_dispatch・workflow_run で動かない(定義を既定ブランチから読む)
//   - checkout の ref が既定ブランチで、PR の先頭(head.sha・head.ref・refs/pull/N/*)を ref に指定しない。PR の先頭は git fetch で取得するだけ
//   - PR の側のファイルを実行しない(手元の action・依存の導入・アダプタのコマンドを使わない)
//   - permissions が最小(contents・pull-requests・issues の read だけ。write も statuses も無い)。秘密情報を参照しない
//   - 結果をジョブの結果(check run)で出す。commit status(statuses の API)で出さない。ジョブの名前は gate-g5-base
//   - PR の題名・本文を run: へ式展開しない(環境変数で渡す)
//   - 判定は既定ブランチの check-pr.mjs を --head と --require-control-approval で呼ぶ
//   - record-copy.yml は pull_request_target の closed で動き、既定ブランチを checkout する(PR の側の定義で contents: write を動かさない)
//   - ルールセットの雛形の必須チェックに gate-g5-base がある
// 試験の写しへ変異を入れ、検出することも確かめる(違反と適合の対)。実際の GitHub 上の振る舞いは 2026-11-05 の実機の確認
// (process-compass research/371-deliberation/probe-371.md の E-4・E-5・E-11・E-15)に依り、この試験では確かめていない。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

/** コメントを除いた本文 */
const stripComments = (text) =>
  String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#\s.*$/, ''))
    .join('\n');
/** トップレベルの on: の直下の契機の名前 */
function triggersOf(body) {
  const m = body.match(/^on:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!m) return [];
  return [...m[1].matchAll(/^ {2}([a-z_]+):/gm)].map((x) => x[1]);
}
/** permissions: のブロック(トップレベルとジョブの両方)の「名前: 値」 */
function permissionsOf(body) {
  const out = [];
  for (const m of body.matchAll(/^( *)permissions:[ \t]*(\S.*)?\n((?:\1 {2,}.*\n?)*)/gm)) {
    if (m[2]) out.push({ scope: '(一括)', value: m[2].trim() });
    for (const l of m[3].split('\n')) {
      const kv = l.match(/^\s+([a-z-]+):\s*(\S+)/);
      if (kv) out.push({ scope: kv[1], value: kv[2] });
    }
  }
  return out;
}
/** actions/checkout の手順の with: の中身 */
function checkoutsOf(body) {
  const lines = body.split('\n');
  const out = [];
  lines.forEach((l, i) => {
    if (!/uses:\s*actions\/checkout@/.test(l)) return;
    const indent = l.match(/^(\s*)/)[1].length;
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const li = lines[j];
      const ind = li.match(/^(\s*)/)[1].length;
      if (li.trim() && (ind < indent || (ind === indent && /^\s*-\s/.test(li)))) break;
      block.push(li);
    }
    out.push(block.join('\n'));
  });
  return out;
}

/** gate-g5-base.yml の不備(空なら適合) */
export function baseJudgeWorkflowProblems(text) {
  const body = stripComments(text);
  const p = [];
  const tr = triggersOf(body);
  if (!tr.includes('pull_request_target')) p.push('pull_request_target で起動しない');
  for (const bad of ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'workflow_dispatch', 'workflow_run', 'push']) if (tr.includes(bad)) p.push(`契機 ${bad} がある(定義を既定ブランチから読む形でない)`);
  const cos = checkoutsOf(body);
  if (!cos.length) p.push('checkout の手順が無い');
  for (const c of cos) {
    if (!/ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/.test(c)) p.push('checkout の ref が既定ブランチでない');
    if (!/persist-credentials:\s*false/.test(c)) p.push('checkout が資格情報を残す(persist-credentials が false でない)');
  }
  for (const l of body.split('\n')) {
    if (/^\s*ref:/.test(l) && /head|refs\/pull|merge_commit_sha|github\.sha/.test(l)) p.push(`ref に PR の先頭・マージのコミットを指定している(${l.trim()})`);
    if (/refs\/pull\//.test(l) && !/fetch|refs\/remotes\/pr\/head/.test(l)) p.push(`PR の参照を取得(fetch)以外で使っている(${l.trim()})`);
    if (/git\s+(checkout|switch|worktree|reset)\b/.test(l)) p.push(`作業ツリーを替える git の操作がある(${l.trim()})`);
  }
  if (/uses:\s*\.\//.test(body)) p.push('手元の action(uses: ./)を使う');
  if (/adapter\.mjs|npm (ci|install)|yarn|pnpm|pip install|setup-stack/.test(body)) p.push('依存の導入・アダプタのコマンドを実行する(PR の側のファイルを実行しうる)');
  if (/secrets\./.test(body)) p.push('秘密情報を参照する');
  const perms = permissionsOf(body);
  if (!perms.length) p.push('permissions の宣言が無い(既定の権限で動く)');
  for (const x of perms) {
    if (x.scope === '(一括)') p.push(`permissions を一括で宣言している(${x.value})`);
    else if (x.value !== 'read' && x.value !== 'none') p.push(`permissions の ${x.scope} が ${x.value}(read を超える)`);
    if (x.scope === 'statuses') p.push('statuses の権限がある(結果を commit status で出す形になる)');
  }
  if (/\/statuses\/|commit status|gh api[^\n]*statuses/.test(body)) p.push('commit status を出す(結果は check run で出す)');
  if (!/^\s{4}name:\s*gate-g5-base\s*$/m.test(body)) p.push('ジョブの名前が gate-g5-base でない(ルールセットの必須チェックが指す名前)');
  for (const l of body.split('\n')) {
    const inEnv = /^\s+[A-Z_][A-Z0-9_]*:\s*\$\{\{/.test(l);
    if (!inEnv && /\$\{\{\s*github\.(event\.pull_request\.(title|body|head\.ref|head\.label)|head_ref)/.test(l)) p.push(`PR の題名・本文・ブランチ名を式展開している(${l.trim()})`);
  }
  if (!/node scripts\/gate\/check-pr\.mjs[^\n]*--head[^\n]*--require-control-approval/.test(body)) p.push('既定ブランチの check-pr.mjs を --head と --require-control-approval で呼んでいない');
  if (/--comment/.test(body)) p.push('PR へコメントを書く(書き込みの権限を要する)');
  return p;
}

/** record-copy.yml の不備(空なら適合) */
export function recordCopyWorkflowProblems(text) {
  const body = stripComments(text);
  const p = [];
  const tr = triggersOf(body);
  if (!tr.includes('pull_request_target')) p.push('pull_request_target で起動しない');
  if (tr.includes('pull_request')) p.push('契機 pull_request がある(マージせずに閉じた PR が PR の側の定義で contents: write を動かす。実機の確認 E-5)');
  if (!/pull_request_target:\s*\n\s+types:\s*\[\s*closed\s*\]/.test(body)) p.push('closed だけを契機にしていない');
  const cos = checkoutsOf(body);
  if (!cos.length) p.push('checkout の手順が無い');
  for (const c of cos) if (!/ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/.test(c)) p.push('checkout の ref が既定ブランチでない');
  for (const l of body.split('\n')) if (/^\s*ref:/.test(l) && /head|refs\/pull|merge_commit_sha/.test(l)) p.push(`ref に PR の先頭・マージのコミットを指定している(${l.trim()})`);
  if (!/if:\s*github\.event\.pull_request\.merged == true/.test(body)) p.push('マージした PR に限っていない');
  if (/uses:\s*\.\//.test(body)) p.push('手元の action(uses: ./)を使う');
  return p;
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const wf = read('.github/workflows/gate-g5-base.yml');
// IMPL-0455:ok
check('gate-g5-base.yml: 既定ブランチの定義で動き、PR のコードを checkout せず、最小の権限で、check run で結果を出す', baseJudgeWorkflowProblems(wf).length === 0, baseJudgeWorkflowProblems(wf).join(' / '));
{
  const mutants = [
    ['PR の先頭を checkout する', wf.replace('ref: ${{ github.event.repository.default_branch }}', 'ref: ${{ github.event.pull_request.head.sha }}'), /ref に PR の先頭|ref が既定ブランチでない/],
    ['pull_request で動く', wf.replace('  pull_request_target:', '  pull_request:'), /pull_request_target で起動しない/],
    ['write の権限を持つ', wf.replace('  pull-requests: read', '  pull-requests: write'), /read を超える/],
    ['statuses の権限で commit status を出す', wf.replace('  issues: read', '  issues: read\n  statuses: write'), /statuses/],
    ['資格情報を残す', wf.replace('persist-credentials: false', 'persist-credentials: true'), /資格情報を残す/],
    ['PR の側の action を使う', wf.replace('      - uses: actions/setup-node@v4', '      - uses: ./.github/actions/setup-stack\n      - uses: actions/setup-node@v4'), /手元の action/],
    ['題名を run へ式展開する', wf.replace('run: node scripts/gate/check-pr.mjs', 'run: echo "${{ github.event.pull_request.title }}" && node scripts/gate/check-pr.mjs'), /式展開/],
    ['ジョブの名前を変える', wf.replace('    name: gate-g5-base', '    name: base'), /ジョブの名前/],
    ['承認の照合を外す', wf.replace(' --require-control-approval', ''), /--require-control-approval/],
    ['PR の作業ツリーへ切り替える', wf.replace('"+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}"', '"+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}"\n          git checkout refs/remotes/pr/head'), /作業ツリーを替える/],
  ];
  for (const [what, text, re] of mutants) {
    const probs = baseJudgeWorkflowProblems(text);
    // IMPL-0455:ng
    check(`gate-g5-base.yml の変異(${what})を検出する`, text !== wf && probs.some((x) => re.test(x)), `変異が入っていない、または検出しない: ${probs.join(' / ')}`);
  }
}

const rc = read('.github/workflows/record-copy.yml');
// IMPL-0459:ok
check('record-copy.yml: pull_request_target の closed で、既定ブランチを checkout する(書き込みの権限を PR の側の定義で動かさない)', recordCopyWorkflowProblems(rc).length === 0, recordCopyWorkflowProblems(rc).join(' / '));
{
  // IMPL-0459:ng
  const m1 = rc.replace('  pull_request_target:\n    types: [closed]', '  pull_request:\n    types: [closed]');
  check('record-copy.yml の変異(pull_request の closed で動く)を検出する', m1 !== rc && recordCopyWorkflowProblems(m1).some((x) => /pull_request_target で起動しない|契機 pull_request/.test(x)));
  const m2 = rc.replace('ref: ${{ github.event.repository.default_branch }}', 'ref: ${{ github.event.pull_request.head.sha }}');
  check('record-copy.yml の変異(PR の先頭を checkout する)を検出する', m2 !== rc && recordCopyWorkflowProblems(m2).length > 0);
  check('record-copy.yml: 誤ったコメント(pull_request の closed はマージ後の基底ブランチの定義を読む)が残っていない', !/pull_request の closed は、マージ後の基底ブランチの定義を読む/.test(rc));
}

for (const f of ['checks-only.json', 'team.json', 'safety.json', 'regulated.json']) {
  const rs = JSON.parse(read(`.github/rulesets/${f}`));
  const names = (rs.rules ?? []).filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context);
  check(`ルールセットの雛形 ${f}: 必須チェックに gate-g5 と gate-g5-base がある`, names.includes('gate-g5') && names.includes('gate-g5-base'), JSON.stringify(names));
}

console.log(`\n${n - failures} / ${n} 件が期待どおり`);
process.exit(failures ? 1 : 0);
