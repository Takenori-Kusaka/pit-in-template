// 基底から読む判定のワークフロー(gate-g5-base.yml)と、書き込みの権限を持つ record-copy.yml の定義を静的に試験する
// (標準 第4章 G-5「判定のコードの読み元」、議長の裁定 AR-1・AR-2。process-compass #371 / ADR-0115)。
//
//   node scripts/gate/test-base-judge-workflow.mjs
//
// 確かめること(GitHub Security Lab「Preventing pwn requests」の注意に沿う形。読み方の本体は base-judge.mjs):
//   - pull_request_target で動き、pull_request・pull_request_review・workflow_dispatch・workflow_run で動かない(定義を既定ブランチから読む)
//   - checkout の ref が既定ブランチで、PR の先頭(head.sha・head.ref・refs/pull/N/*)を ref に指定しない。PR の先頭は git fetch で取得するだけ
//   - PR の側のファイルを実行しない(手元の action・依存の導入・アダプタのコマンドを使わない)
//   - permissions が最小(contents・pull-requests・issues の read だけ。write も statuses も無い)。秘密情報を参照しない
//   - 結果をジョブの結果(check run)で出す。commit status(statuses の API)で出さない。ジョブの名前は gate-g5-base
//   - PR の題名・本文を run: へ式展開しない(環境変数で渡す)
//   - 判定は既定ブランチの check-pr.mjs を --head と --require-control-approval で呼ぶ
//   - 保証の開示の層の値(baseJudgeLayers)が、ファイルが無い・書き換えた定義で未達を出す
//   - record-copy.yml は pull_request_target の closed で動き、既定ブランチを checkout する(PR の側の定義で contents: write を動かさない)
//   - ルールセットの雛形の必須チェックに gate-g5-base があり、ai-review が無い(AI の確認を合否条件にしない)
//   - ai-review.yml が、AI レビューの指示を既定ブランチの .github/ai-review/ から読む(標準 第5章 5.8.6 の要求事項7。#369)。
//     pull_request_target、checkout は既定ブランチだけ、AI レビューのジョブは read だけ、書き込みは別のジョブで PR の内容に依らない
//     入力(enabled)だけ、題名・本文を渡さない、秘密情報は環境変数でだけ、承認・commit status を出さない、AI の手順は continue-on-error。
//     指示の置き場は CONTROL_FILES に入る。ai-review.yml そのものは実機で動かしていない(同じ型の gate-g5-base.yml の確認に依る)
// 試験の写しへ変異を入れ、検出することも確かめる(違反と適合の対)。実装した版の GitHub 上の振る舞いは 2026-11-05 の実機の確認
// (process-compass research/371-deliberation/probe-371b.md の F-1a・F-1b・F-3)に依り、この試験では確かめていない。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { baseJudgeWorkflowProblems, baseJudgeLayers, recordCopyWorkflowProblems, aiReviewWorkflowProblems } from './base-judge.mjs';
import { CONTROL_FILES, controlTouchedOf } from './check-pr.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

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
{
  // 保証の開示の層の値(突合 C-5)
  const ok = baseJudgeLayers(wf);
  check('層の値: 実物の定義では4層とも満たす', Object.values(ok).every((x) => x.state === 'satisfied'), JSON.stringify(ok));
  const none = baseJudgeLayers(null);
  check('層の値: 既定ブランチにファイルが無ければ4層とも満たさない', Object.values(none).every((x) => x.state === 'unsatisfied'));
  const pr = baseJudgeLayers(wf.replace('  pull_request_target:', '  pull_request:'));
  check('層の値: pull_request で動く定義は、定義の層を満たさない', pr.definition.state === 'unsatisfied' && pr.script.state === 'satisfied', JSON.stringify(pr));
  const head = baseJudgeLayers(wf.replace('ref: ${{ github.event.repository.default_branch }}', 'ref: ${{ github.event.pull_request.head.sha }}'));
  check('層の値: PR の先頭を checkout する定義は、判定のスクリプトの層を満たさない', head.script.state === 'unsatisfied');
  const exec = baseJudgeLayers(wf.replace('      - uses: actions/setup-node@v4', '      - uses: ./.github/actions/setup-stack\n      - uses: actions/setup-node@v4'));
  check('層の値: 手元の action を使う定義は、PR のコードの実行の層を満たさない', exec.execution.state === 'unsatisfied');
  const st = baseJudgeLayers(wf.replace('  issues: read', '  issues: read\n  statuses: write'));
  check('層の値: statuses の権限を持つ定義は、結果の層を満たさない', st.result.state === 'unsatisfied');
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

// AI レビューの指示を既定ブランチの版から読む(標準 第5章 5.8.6 の要求事項7、附属書H H.4 条件3。process-compass #369)。
// #371 の「基底から読む」型に、プロンプトの注入の条件(read だけ、書き込みは別のジョブ、題名・本文を渡さない、PR のコードを
// checkout しない、承認・合否条件にしない)を足した定義を、違反と適合の対で確かめる
const ar = read('.github/workflows/ai-review.yml');
// IMPL-0333:ok
check('ai-review.yml: 既定ブランチの定義で動き、指示を既定ブランチの .github/ai-review/ から読み、書き込みを別のジョブに分ける', aiReviewWorkflowProblems(ar).length === 0, aiReviewWorkflowProblems(ar).join(' / '));
check('ai-review.yml: 指示の置き場(.github/ai-review/instructions.md)が既定ブランチの側にある', fs.existsSync(path.join(ROOT, '.github/ai-review/instructions.md')));
check('CONTROL_FILES に AI レビューの指示の置き場(.github/ai-review/**)がある(指示を変える PR は統制の設定の変更)', CONTROL_FILES.includes('.github/ai-review/**') && controlTouchedOf([{ path: '.github/ai-review/instructions.md' }]).length === 1, JSON.stringify(CONTROL_FILES));
{
  const notice = '      - name: 位置づけを PR へ明記する\n        env:';
  const mutants = [
    ['pull_request で動く', ar.replace('  pull_request_target:', '  pull_request:'), /pull_request_target で起動しない/],
    ['PR の先頭を checkout する', ar.replace('ref: ${{ github.event.repository.default_branch }}', 'ref: ${{ github.event.pull_request.head.sha }}'), /ref に PR の先頭|ref が既定ブランチでない/],
    ['指示を PR の先頭から読む', ar.replace('          if [ -f .github/ai-review/instructions.md ]; then', '          git show refs/remotes/pr/head:.github/ai-review/instructions.md > "$RUNNER_TEMP/ai-review/instructions.md"\n          if [ -f .github/ai-review/instructions.md ]; then'), /指示を PR の先頭から読む/],
    ['指示の置き場を PR の作業の一時ファイルへ替える', ar.replace('AI_REVIEW_INSTRUCTIONS: .github/ai-review/instructions.md', 'AI_REVIEW_INSTRUCTIONS: ${{ runner.temp }}/ai-review/instructions.md'), /指示の置き場が/],
    ['AI レビューのジョブに書き込みの権限を与える', ar.replace('    permissions:\n      contents: read\n      pull-requests: read\n    outputs:', '    permissions:\n      contents: read\n      pull-requests: write\n    outputs:'), /AI レビューのジョブ\(ai-review\)が書き込みの権限/],
    ['トップレベルで書き込みの権限を与える', ar.replace('permissions:\n  contents: read\n  pull-requests: read\n\njobs:', 'permissions:\n  contents: read\n  pull-requests: write\n\njobs:'), /トップレベルの permissions/],
    ['書き込みのジョブへ AI の出力を渡す', ar.replace("    if: needs.ai-review.outputs.enabled == 'yes'", "    if: needs.ai-review.outputs.enabled == 'yes' && needs.ai-review.outputs.findings != ''"), /前のジョブの出力 findings/],
    ['書き込みのジョブが checkout する', ar.replace('    steps:\n      - name: 位置づけを PR へ明記する', '    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.repository.default_branch }}\n          persist-credentials: false\n      - name: 位置づけを PR へ明記する'), /書き込みのジョブ ai-review-notice が checkout する/],
    ['書き込みのジョブが秘密情報を参照する', ar.replace(notice, `${notice}\n          MODEL_KEY: \${{ secrets.MODEL_API_KEY }}`), /書き込みのジョブ ai-review-notice が秘密情報/],
    ['題名を run へ式展開する', ar.replace('          echo "::notice::AI レビューの実装は未設定です。', '          echo "${{ github.event.pull_request.title }}"\n          echo "::notice::AI レビューの実装は未設定です。'), /題名・本文/],
    ['本文を環境変数でモデルへ渡す', ar.replace('          AI_REVIEW_FILES: ${{ runner.temp }}/ai-review/files.txt', '          AI_REVIEW_FILES: ${{ runner.temp }}/ai-review/files.txt\n          PR_BODY: ${{ github.event.pull_request.body }}'), /題名・本文/],
    ['秘密情報を run の中で参照する', ar.replace('          echo "::notice::AI レビューの実装は未設定です。', '          curl -H "x-api-key: ${{ secrets.MODEL_API_KEY }}" https://example.invalid\n          echo "::notice::AI レビューの実装は未設定です。'), /秘密情報を環境変数の外で参照/],
    ['AI の確認を合否条件にする', ar.replace('        continue-on-error: true\n', ''), /continue-on-error/],
    ['AI に承認させる', ar.replace('          gh pr comment "$PR_NUMBER"', '          gh pr review "$PR_NUMBER" --approve\n          gh pr comment "$PR_NUMBER"'), /承認/],
    ['commit status で結果を出す', ar.replace('    permissions:\n      pull-requests: write', '    permissions:\n      pull-requests: write\n      statuses: write'), /commit status/],
    ['資格情報を残す', ar.replace('persist-credentials: false', 'persist-credentials: true'), /資格情報を残す/],
    ['PR の側の action を使う', ar.replace('      - name: 有効かどうかを確認する', '      - uses: ./.github/actions/setup-stack\n      - name: 有効かどうかを確認する'), /手元の action/],
    ['PR の作業ツリーへ切り替える', ar.replace('            "+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"', '            "+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"\n          git checkout refs/remotes/pr/head'), /作業ツリーを替える/],
  ];
  for (const [what, text, re] of mutants) {
    const probs = aiReviewWorkflowProblems(text);
    // IMPL-0333:ng
    check(`ai-review.yml の変異(${what})を検出する`, text !== ar && probs.some((x) => re.test(x)), `変異が入っていない、または検出しない: ${probs.join(' / ')}`);
  }
}

for (const f of ['checks-only.json', 'team.json', 'safety.json', 'regulated.json']) {
  const rs = JSON.parse(read(`.github/rulesets/${f}`));
  const names = (rs.rules ?? []).filter((r) => r.type === 'required_status_checks').flatMap((r) => r.parameters?.required_status_checks ?? []).map((c) => c.context);
  check(`ルールセットの雛形 ${f}: 必須チェックに gate-g5 と gate-g5-base がある`, names.includes('gate-g5') && names.includes('gate-g5-base'), JSON.stringify(names));
  // AI の確認を合否条件にしない(標準 第5章 5.5.4、附属書H H.4)
  check(`ルールセットの雛形 ${f}: 必須チェックに ai-review・ai-review-notice が無い`, !names.some((x) => /^ai-review/.test(x)), JSON.stringify(names));
}

console.log(`\n${n - failures} / ${n} 件が期待どおり`);
process.exit(failures ? 1 : 0);
