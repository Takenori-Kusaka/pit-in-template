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
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { baseJudgeWorkflowProblems, baseJudgeLayers, recordCopyWorkflowProblems, aiReviewWorkflowProblems, aiReviewAllowlistProblems, aiReviewCheckPlan } from './base-judge.mjs';
import { CONTROL_FILES, CONTROL_CONFIG_KEYS, controlTouchedOf } from './check-pr.mjs';
import crypto from 'node:crypto';
import { collectInputs, inputsSummary, toolInputsCheck, findingsCheck, findingsSummary, NOTE as RECORD_NOTE } from './ai-review-record.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

// 読み込みの側で改行を LF へ揃える(Windows の作業ツリーは CRLF で取り出される。照合の正規表現・置換の文字列は LF のまま緩めない。#360 H-8)
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
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
// AI レビューを無効にした構成(/process-init が ai-review.yml を消す)では、対象外として飛ばし、飛ばした件数を出す(#369 の突合 F-1)
check('CONTROL_FILES に AI レビューの指示の置き場(.github/ai-review/**)がある(指示を変える PR は統制の設定の変更)', CONTROL_FILES.includes('.github/ai-review/**') && controlTouchedOf([{ path: '.github/ai-review/instructions.md' }]).length === 1, JSON.stringify(CONTROL_FILES));
check('構成の aiReview(有効化・フォークの扱い)の変更は、承認を要する統制の設定に数える(#369 の突合 F-9)', CONTROL_CONFIG_KEYS.includes('aiReview'), JSON.stringify(CONTROL_CONFIG_KEYS));
check('対象の判定: ai-review.yml があれば検査する', aiReviewCheckPlan({ exists: true, config: { aiReview: { enabled: false } } }).plan === 'check');
check('対象の判定: 無効の構成で ai-review.yml が無ければ対象外', aiReviewCheckPlan({ exists: false, config: { aiReview: { enabled: false } } }).plan === 'skip');
check('対象の判定: 有効の構成で ai-review.yml が無ければ不備', aiReviewCheckPlan({ exists: false, config: { aiReview: { enabled: true } } }).plan === 'missing');
const arPath = path.join(ROOT, '.github/workflows/ai-review.yml');
const arPlan = aiReviewCheckPlan({ exists: fs.existsSync(arPath), config: (() => { try { return JSON.parse(read('process.config.json')); } catch { return null; } })() });
if (arPlan.plan === 'skip') console.log(`対象外 ai-review.yml の検査(${arPlan.why})。定義の試験と変異の試験を飛ばした`);
else check('ai-review.yml がある(構成で AI レビューが有効)', arPlan.plan === 'check', arPlan.why ?? '');
if (arPlan.plan === 'check') {
const arActual = read('.github/workflows/ai-review.yml').replace(/\r\n/g, '\n');
// IMPL-0333:ok
check('ai-review.yml: 既定ブランチの定義で動き、指示を既定ブランチの .github/ai-review/ から読み、書き込みを別のジョブに分ける', aiReviewWorkflowProblems(arActual).length === 0, aiReviewWorkflowProblems(arActual).join(' / '));
// 変異の足場。採用者が差し込みの手順の名前・run: を書き換えた案件でも変異の試験が足場を失わないよう、差し込みの手順の名前と run: を
// テンプレートの雛形へ戻した写しへ変異を入れる(2026-11-06 の実機の確認 probe-369 で、run: を置き換えた案件で変異の試験2件が足場を失った)
const ar = (() => {
  const L = arActual.split('\n');
  const at = L.indexOf('        id: review');
  if (at < 1) return arActual;
  L[at - 1] = '      - name: レビューの実行(未設定)';
  const r = L.indexOf('        run: |', at);
  if (r < 0) return arActual;
  let e = r + 1;
  while (e < L.length && (/^ {10}/.test(L[e]) || (L[e].trim() === '' && /^ {10}/.test(L[e + 1] ?? '')))) e++;
  L.splice(r + 1, e - r - 1, '          echo "::notice::AI レビューの実装は未設定です。使いたい仕組みをこのステップへ追加してください(指示: ${AI_REVIEW_INSTRUCTIONS})"');
  return L.join('\n');
})();
check('変異の足場: 差し込みの手順を雛形へ戻した写しも許す形に合う', aiReviewWorkflowProblems(ar).length === 0, aiReviewWorkflowProblems(ar).join(' / '));
{
  const replaced = ar.replace('          echo "::notice::AI レビューの実装は未設定です。', '          node tools/review.mjs\n          echo done\n          echo "::notice::AI レビューの実装は未設定です。');
  const L = replaced.split('\n');
  const at = L.indexOf('        id: review');
  L[at - 1] = '      - name: レビュー';
  const back = (() => { const M = [...L]; M[at - 1] = '      - name: レビューの実行(未設定)'; const r = M.indexOf('        run: |', at); let e = r + 1; while (e < M.length && /^ {10}/.test(M[e])) e++; M.splice(r + 1, e - r - 1, '          echo "::notice::AI レビューの実装は未設定です。使いたい仕組みをこのステップへ追加してください(指示: ${AI_REVIEW_INSTRUCTIONS})"'); return M.join('\n'); })();
  check('変異の足場: 差し込みの手順の名前と run: を替えた写しも、雛形へ戻せる', back === ar);
}
check('ai-review.yml: 指示の置き場(.github/ai-review/instructions.md)が既定ブランチの側にある', fs.existsSync(path.join(ROOT, '.github/ai-review/instructions.md')));
{
  // 許す形の範囲の内側の書き換え(誤検出しない側)
  const RUN = '          echo "::notice::AI レビューの実装は未設定です。';
  const KEY = '          AI_REVIEW_FINDINGS: ${{ runner.temp }}/ai-review/findings.json'; // 差し込みの手順の env の決まった行の最後
  const fine = [
    ['差し込みの run: で依存を導入して道具を動かす', ar.replace(RUN, `          npm ci\n          node tools/review.mjs "$AI_REVIEW_INSTRUCTIONS" "$AI_REVIEW_DIFF" >> "$GITHUB_STEP_SUMMARY"\n${RUN}`)],
    ['秘密情報を1つの名前ごとに env で渡す', ar.replace(KEY, `${KEY}\n          MODEL_API_KEY: \${{ secrets.MODEL_API_KEY }}`)],
    ['actions/setup-node を足す', ar.replace('      - name: レビューの実行(未設定)', '      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - name: レビューの実行(未設定)')],
  ];
  for (const [what, text] of fine) {
    // IMPL-0333:ok
    check(`ai-review.yml の許す書き換え(${what})を不備にしない`, text !== ar && aiReviewWorkflowProblems(text).length === 0, aiReviewWorkflowProblems(text).join(' / '));
  }
}
{
  const notice = '      - name: 位置づけを PR へ明記する\n        env:';
  const mutants = [
    ['pull_request で動く', ar.replace('  pull_request_target:', '  pull_request:'), /pull_request_target で起動しない/],
    ['PR の先頭を checkout する', ar.replace('ref: ${{ github.event.repository.default_branch }}', 'ref: ${{ github.event.pull_request.head.sha }}'), /ref に PR の先頭|ref が既定ブランチでない/],
    ['指示を PR の先頭から読む', ar.replace('          if [ -f .github/ai-review/instructions.md ]; then', '          git show refs/remotes/pr/head:.github/ai-review/instructions.md > "$RUNNER_TEMP/ai-review/instructions.md"\n          if [ -f .github/ai-review/instructions.md ]; then'), /指示を PR の先頭から読む/],
    ['指示の置き場を PR の作業の一時ファイルへ替える', ar.replace('AI_REVIEW_INSTRUCTIONS: .github/ai-review/instructions.md', 'AI_REVIEW_INSTRUCTIONS: ${{ runner.temp }}/ai-review/instructions.md'), /指示の置き場が/],
    ['AI レビューのジョブに書き込みの権限を与える', ar.replace('    permissions:\n      contents: read\n      pull-requests: read\n    outputs:', '    permissions:\n      contents: read\n      pull-requests: write\n    outputs:'), /AI レビューのジョブ\(ai-review\)が書き込みの権限/],
    ['トップレベルで書き込みの権限を与える', ar.replace('permissions:\n  contents: read\n  pull-requests: read\n\njobs:', 'permissions:\n  contents: read\n  pull-requests: write\n\njobs:'), /トップレベルの permissions/],
    ['書き込みのジョブへ AI の出力を渡す', ar.replace("    if: always() && needs.ai-review.outputs.enabled == 'yes'", "    if: always() && needs.ai-review.outputs.enabled == 'yes' && needs.ai-review.outputs.findings != ''"), /前のジョブの出力 findings/],
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
{
  // #369 の独立の突合 F-2・F-3・F-5 の変異。否定のリストの外の書き方を、許す形の一覧の検査(aiReviewAllowlistProblems)が検出する
  const RUN = '          echo "::notice::AI レビューの実装は未設定です。';
  const ins = (lines) => ar.replace(RUN, `${lines}\n${RUN}`);
  const KEY = '          AI_REVIEW_FINDINGS: ${{ runner.temp }}/ai-review/findings.json'; // 差し込みの手順の env の決まった行の最後
  const mutants = [
    ['FETCH_HEAD から PR の先頭の指示を読む', ins('          git show FETCH_HEAD:.github/ai-review/instructions.md > /tmp/i.md')],
    ['変数を経由して PR の先頭の指示を読む', ins('          F=.github/ai-review/instructions.md\n          R=refs/remotes/pr/head\n          git show "$R:$F" > /tmp/i.md')],
    ['PR の先頭の CLAUDE.md を読む', ins('          git show refs/remotes/pr/head:CLAUDE.md > /tmp/c.md')],
    ['指示の置き場の外へ辿る', ar.replace('AI_REVIEW_INSTRUCTIONS: .github/ai-review/instructions.md', 'AI_REVIEW_INSTRUCTIONS: .github/ai-review/../../../tmp/x.md')],
    ['git -c を挟んで PR の先頭を checkout する', ins('          git -c advice.detachedHead=false checkout refs/remotes/pr/head')],
    ['read-tree で PR の先頭を作業ツリーへ展開する', ins('          git read-tree -u --reset refs/remotes/pr/head')],
    ['archive で PR の先頭を展開する', ins('          git archive refs/remotes/pr/head | tar -x -C /tmp/pr')],
    ['checkout の repository: にフォークを指定する', ar.replace('          ref: ${{ github.event.repository.default_branch }}', '          repository: ${{ github.event.pull_request.head.repo.full_name }}\n          ref: ${{ github.event.repository.default_branch }}')],
    ['PR の先頭のスクリプトを書き出して実行する', ins('          git show refs/remotes/pr/head:tools/x.mjs > /tmp/x.mjs\n          node /tmp/x.mjs')],
    ['toJSON で PR のイベントを渡す', ar.replace(KEY, `${KEY}\n          PR_JSON: \${{ toJSON(github.event.pull_request) }}`)],
    ['添字の書き方で題名を渡す', ar.replace(KEY, `${KEY}\n          PR_T: \${{ github.event.pull_request['title'] }}`)],
    ['GITHUB_EVENT_PATH から本文を読む', ins('          jq -r .pull_request.body "$GITHUB_EVENT_PATH" > /tmp/b.txt')],
    ['gh pr view で題名と本文を読む', ins('          gh pr view "$PR_NUMBER" --json title,body > /tmp/b.json')],
    ['gh api で PR を読む', ins('          gh api repos/o/r/pulls/1 > /tmp/p.json')],
    ['artifact で AI の出力を書き込みのジョブへ渡す', ar.replace('      - name: 位置づけを PR へ明記する', '      - uses: actions/download-artifact@v4\n        with:\n          name: findings\n      - name: 位置づけを PR へ明記する')],
    ['artifact へ AI の出力を上げる', ar.replace('      - name: レビューの失敗を表示する', '      - uses: actions/upload-artifact@v4\n        with:\n          name: findings\n          path: /tmp/f.md\n      - name: レビューの失敗を表示する')],
    ['toJSON(secrets) で秘密情報を一括で渡す', ar.replace(KEY, `${KEY}\n          ALL: \${{ toJSON(secrets) }}`)],
    ['フォークからの PR でも AI の手順を動かす(既定の切り替え)', ar.replace('            if [ "$HEAD_REPO" = "$REPO" ] || [ "$forks" = "yes" ]; then', '            if true; then')],
    ['AI の手順の条件からフォークの判定を外す', ar.replace("        if: steps.gate.outputs.run_ai == 'yes' && steps.input.outputs.instructions == 'yes'", "        if: steps.gate.outputs.enabled == 'yes' && steps.input.outputs.instructions == 'yes'")],
    ['失敗の表示を消す(差し込みの失敗が黙って消える)', ar.replace(/ {6}- name: レビューの失敗を表示する\n[\s\S]*?(?=\n\n {2}# 位置づけ)/, '')],
    ['3つ目のジョブを足す', ar.replace('  ai-review-notice:\n', '  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n\n  ai-review-notice:\n')],
    ['差し込みの手順の env に PR の内容に依る値を足す', ar.replace(KEY, `${KEY}\n          HEAD_REF: \${{ github.head_ref }}`)],
    ['差し込みの run: が後の手順の環境を替える', ins('          echo "X=1" >> "$GITHUB_ENV"')],
    ['書き込みのジョブの定型の文の中でヒアドキュメントを閉じる', ar.replace('          ### AI レビューの位置づけ', "          MD\n          )\"\n          gh pr comment \"$PR_NUMBER\" --repo \"$REPO\" --body \"$(cat <<'MD'\n          ### AI レビューの位置づけ")],
    ['ジョブ ai-review が落ちたときに定型の文を出さない(always() を外す)', ar.replace("    if: always() && needs.ai-review.outputs.enabled == 'yes'", "    if: needs.ai-review.outputs.enabled == 'yes'")],
    ['定型の文から「承認しない」を消す', ar.replace('          - 承認(approve)は行いません\n', '')],
    ['書き込みのジョブの env を足す', ar.replace('          PR_NUMBER: ${{ github.event.pull_request.number }}\n        run: |\n          gh pr comment', '          PR_NUMBER: ${{ github.event.pull_request.number }}\n          HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}\n        run: |\n          gh pr comment')],
  ];
  for (const [what, text] of mutants) {
    const probs = aiReviewAllowlistProblems(text);
    // IMPL-0333:ng
    check(`ai-review.yml の変異(${what})を許す形の一覧の検査が検出する`, text !== ar && probs.length > 0, `変異が入っていない、または検出しない(${text === ar ? '変異なし' : '検出なし'})`);
  }
}
{
  // #360 論点C: 入力の記録(IMPL-0253)・その成果物・欠落の表示(IMPL-0155)の決まった手順。実物の定義にあり、許す形の外の書き換えと
  // 許す形の外の手順の追加は従来どおり拒む(違反と適合の対)
  const INPUTS = /( {6}- name: 入力を記録する\n[\s\S]*?ai-review-record\.mjs inputs --dir "\$RUNNER_TEMP\/ai-review"\n)/;
  const UPLOAD = /( {6}- uses: actions\/upload-artifact@v4\n[\s\S]*?if-no-files-found: warn\n)/;
  const FINDINGS = /( {6}- name: 道具の側の入力と指摘の欠落を表示する\n[\s\S]*?ai-review-record\.mjs findings --dir "\$RUNNER_TEMP\/ai-review"\n)/;
  const REVIEW_NAME = '      - name: レビューの実行(未設定)';
  const inputsStep = ar.match(INPUTS)?.[1] ?? '';
  // IMPL-0253:ok
  check('ai-review.yml: 差し込み口の前に入力の記録の手順と成果物の手順があり、差し込み口の後に欠落の表示の手順がある', inputsStep !== '' && UPLOAD.test(ar) && FINDINGS.test(ar)
    && ar.indexOf(inputsStep) < ar.indexOf(REVIEW_NAME) && ar.search(UPLOAD) < ar.indexOf(REVIEW_NAME) && ar.search(FINDINGS) > ar.indexOf(REVIEW_NAME));
  // IMPL-0253:ok
  check('ai-review.yml: 入力の記録の成果物は保持日数を明記し、上げるのはスクリプトが書いた入力の記録だけ', /retention-days: 90\n/.test(ar.match(UPLOAD)?.[1] ?? '') && /path: \$\{\{ runner\.temp \}\}\/ai-review\/record\/inputs\.json\n/.test(ar.match(UPLOAD)?.[1] ?? ''));
  // IMPL-0155:ok
  check('ai-review.yml: 差し込みの手順へ契約のファイルの置き場(AI_REVIEW_TOOL_INPUTS・AI_REVIEW_FINDINGS)を渡す', /AI_REVIEW_TOOL_INPUTS: \$\{\{ runner\.temp \}\}\/ai-review\/tool-inputs\.json\n {10}AI_REVIEW_FINDINGS: \$\{\{ runner\.temp \}\}\/ai-review\/findings\.json\n/.test(ar));
  const before = (re) => ar.replace(re, '').replace(REVIEW_NAME, `${ar.match(re)?.[1] ?? ''}${REVIEW_NAME}`);
  const mutants = [
    ['入力の記録の手順を消す', ar.replace(INPUTS, ''), /並びが違う/],
    ['入力の記録の手順を差し込み口の後へ動かす', ar.replace(INPUTS, '').replace('      - name: レビューの失敗を表示する', `${inputsStep}      - name: レビューの失敗を表示する`), /並びが違う/],
    ['入力の記録の手順を2つ置く', ar.replace(INPUTS, `$1$1`), /並びが違う/],
    ['入力の記録の失敗を黙って消す(|| true)', ar.replace('ai-review-record.mjs inputs --dir "$RUNNER_TEMP/ai-review"', 'ai-review-record.mjs inputs --dir "$RUNNER_TEMP/ai-review" || true'), /許していない手順/],
    ['入力の記録を PR の側のスクリプトで書く', ar.replace('run: node scripts/gate/ai-review-record.mjs inputs', 'run: node "$RUNNER_TEMP/pr/scripts/gate/ai-review-record.mjs" inputs'), /許していない手順/],
    ['成果物の保持日数を消す', ar.replace('          retention-days: 90\n', ''), /許していない手順/],
    ['成果物へ AI の出力(findings.json)を上げる', ar.replace('path: ${{ runner.temp }}/ai-review/record/inputs.json', 'path: ${{ runner.temp }}/ai-review/findings.json'), /許していない手順/],
    ['成果物を差し込み口の後で上げる(差し込んだ手順が記録を書き換えうる)', ar.replace(UPLOAD, '').replace('      - name: レビューの失敗を表示する', `${ar.match(UPLOAD)?.[1] ?? ''}      - name: レビューの失敗を表示する`), /並びが違う/],
    ['欠落の表示の手順を消す', ar.replace(FINDINGS, ''), /並びが違う/],
    ['欠落の表示を差し込み口の前へ動かす', before(FINDINGS), /並びが違う/],
    ['欠落の表示の結果を後のジョブへ出す(GITHUB_OUTPUT)', ar.replace('ai-review-record.mjs findings --dir "$RUNNER_TEMP/ai-review"', 'ai-review-record.mjs findings --dir "$RUNNER_TEMP/ai-review" >> "$GITHUB_OUTPUT"'), /許していない手順/],
    ['欠落の表示を合否に使う(欠落で落とす引数)', ar.replace('ai-review-record.mjs findings --dir "$RUNNER_TEMP/ai-review"', 'ai-review-record.mjs findings --dir "$RUNNER_TEMP/ai-review" --fail-on-gap'), /許していない手順/],
    ['差し込みの env から道具の側の入力の置き場を消す', ar.replace('          AI_REVIEW_TOOL_INPUTS: ${{ runner.temp }}/ai-review/tool-inputs.json\n', ''), /レビューの実行」の id・条件/],
    ['許す形の外の手順(任意の run:)を差し込み口の前に足す', ar.replace(REVIEW_NAME, `      - name: 前処理\n        run: echo x\n${REVIEW_NAME}`), /許していない手順/],
    ['許す形の外の手順を欠落の表示の後に足す', ar.replace(FINDINGS, '$1      - name: 後処理\n        run: echo x\n'), /許していない手順/],
  ];
  for (const [what, text, re] of mutants) {
    const probs = aiReviewAllowlistProblems(text);
    // IMPL-0253:ng
    check(`ai-review.yml の変異(${what})を許す形の一覧の検査が検出する`, text !== ar && probs.some((x) => re.test(x)), `変異が入っていない、または検出しない(${text === ar ? '変異なし' : probs.join(' / ') || '検出なし'})`);
  }
}
}

// #360 論点C: 決まった手順が呼ぶ記録のスクリプト(scripts/gate/ai-review-record.mjs)。違反と適合の対
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-ai-review-record-'));
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const put = (rel, s) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), s); };
  try {
    const root = path.join(tmp, 'root');
    const dir = path.join(tmp, 'ai-review');
    put('root/.github/ai-review/instructions.md', '指示');
    put('root/.github/ai-review/README.md', '契約');
    put('root/CLAUDE.md', 'c');
    put('root/sub/AGENTS.md', 'a');
    put('root/.claude/settings.json', '{}');
    put('root/node_modules/x/CLAUDE.md', 'n');
    put('root/src/a.ts', 'x');
    put('ai-review/diff.patch', 'diff');
    put('ai-review/files.txt', 'M\tsrc/a.ts');
    const shaOf = (ref) => ({ HEAD: 'b'.repeat(40), 'refs/remotes/origin/main': 'c'.repeat(40), 'refs/remotes/pr/head': 'd'.repeat(40) })[ref] ?? null;
    const rec = collectInputs({ root, dir, baseRef: 'main', shaOf });
    const paths = (xs) => xs.map((x) => x.path);
    const sum = inputsSummary(rec);
    // IMPL-0253:ok
    check('入力の記録: 指示の置き場・差分・ファイルの一覧・3つの SHA・自動読込の候補を、パスと sha256 で書く', JSON.stringify(paths(rec.instructions)) === JSON.stringify(['.github/ai-review/README.md', '.github/ai-review/instructions.md'])
      && rec.instructions.find((x) => x.path.endsWith('instructions.md')).sha256 === sha('指示')
      && rec.artifacts.every((x) => x.sha256) && rec.artifacts[0].sha256 === sha('diff')
      && rec.shas.defaultBranch === 'b'.repeat(40) && rec.shas.base === 'c'.repeat(40) && rec.shas.prHead === 'd'.repeat(40)
      && JSON.stringify(paths(rec.autoloadCandidates)) === JSON.stringify(['.claude/settings.json', 'CLAUDE.md', 'sub/AGENTS.md'])
      && rec.autoloadCandidates.find((x) => x.path === 'CLAUDE.md').sha256 === sha('c'), JSON.stringify(rec));
    // IMPL-0253:ok
    check('入力の記録: 要約に「候補は上限で、実際に読み込まれたものではない」「入力の記録は確かめたことを示さない」を定型で出す', sum.includes(RECORD_NOTE.candidates) && sum.includes(RECORD_NOTE.notVerified) && sum.includes('d'.repeat(40)), sum);
    {
      fs.rmSync(path.join(dir, 'diff.patch'));
      const r2 = collectInputs({ root, dir, baseRef: 'main', shaOf: () => null });
      // IMPL-0253:ng
      check('入力の記録: 差分が無い・SHA を取れない場合も、行を落とさず sha256 なしと理由・取得できない旨を出す', r2.artifacts.length === 2 && r2.artifacts[0].sha256 === null && /読めない/.test(r2.artifacts[0].note)
        && /PR の先頭: \(取得できない\)/.test(inputsSummary(r2)), JSON.stringify(r2.artifacts));
      put('ai-review/diff.patch', 'diff');
    }
    // 道具の側の入力(差し込み口の契約)
    const fullTool = JSON.stringify({ launch: { command: 'tool review', prompt: '.github/ai-review/instructions.md', sha256: sha('指示') }, tools: [], read: [{ path: 'CLAUDE.md', sha256: sha('c') }], source: 'run log' });
    const toolCases = [
      ['契約のファイルが無い', null, 'absent'],
      ['JSON として読めない', '{', 'unreadable'],
      ['起動の指示(launch)を欠く', JSON.stringify({ tools: [], read: [], source: 'x' }), 'incomplete'],
      ['実際に読んだファイル(read)を欠く', JSON.stringify({ launch: 'x', tools: [], source: 'x' }), 'incomplete'],
      ['道具の定義(tools)を欠く', JSON.stringify({ launch: 'x', read: [], source: 'x' }), 'incomplete'],
    ];
    for (const [what, text, state] of toolCases) {
      const t = toolInputsCheck(text);
      const s = findingsSummary(t, findingsCheck(null));
      // IMPL-0253:ng
      check(`道具の側の入力(${what}): 「道具の側の入力を列挙できない確認」と要約に出す`, t.state === state && s.includes(RECORD_NOTE.toolMissing) && !s.includes(RECORD_NOTE.toolSelfReport), `${t.state}: ${s}`);
    }
    {
      const t = toolInputsCheck(fullTool);
      const s = findingsSummary(t, findingsCheck(null));
      // IMPL-0253:ok
      check('道具の側の入力(契約の欄がそろう): 列挙できない旨を出さず、申告であって一致を確かめていない旨と読んだファイルを出す', t.state === 'present' && !s.includes(RECORD_NOTE.toolMissing) && s.includes(RECORD_NOTE.toolSelfReport) && s.includes(`${sha('c')}  CLAUDE.md`), s);
    }
    // 構造化された指摘の欠落(IMPL-0155)
    {
      const absent = findingsSummary(toolInputsCheck(fullTool), findingsCheck(null));
      // IMPL-0155:ok
      check('指摘の欠落: findings.json が無い(散文だけ)なら「構造が無いため欠落を検査していない」と出し、拒まない', absent.includes(RECORD_NOTE.noStructure) && absent.includes(RECORD_NOTE.structureNotBasis), absent);
      const bad = findingsSummary(toolInputsCheck(fullTool), findingsCheck('[oops'));
      // IMPL-0155:ng
      check('指摘の欠落: findings.json を JSON として読めないなら、構造が無いとして出す', bad.includes('JSON として読めない') && bad.includes(RECORD_NOTE.noStructure), bad);
    }
    const good = { location: 'src/a.ts:1', basis: { criterion: 'AC-1', fact: '戻り値が null' } };
    const gaps = [
      ['所在(location)を欠く', { basis: 'AC-1 に照らし、戻り値が null' }, /所在\(location\)/],
      ['根拠(basis)を欠く', { location: 'src/a.ts:1' }, /根拠\(basis\)/],
      ['根拠のうち見た事実を欠く', { location: 'src/a.ts:1', basis: { criterion: 'AC-1' } }, /見た事実\(basis\.fact\)/],
      ['実行の結果を述べるのに実行の記録の所在(run)を欠く', { ...good, execution: true }, /実行の記録の所在\(run\)/],
      ['実行の記録の所在の代わりにコマンドと観測を書く', { ...good, execution: true, command: 'npm test', observed: '1 failed' }, /実行で確かめたとは記録しない/],
    ];
    for (const [what, f, re] of gaps) {
      const input = JSON.stringify({ findings: [good, f, good] });
      const c = findingsCheck(input);
      const s = findingsSummary(toolInputsCheck(fullTool), c);
      // IMPL-0155:ng
      check(`指摘の欠落(${what}): 欠けた欄を表示し、指摘を消さない(3件のまま、欠くのは2件目だけ)`, c.state === 'checked' && c.items.length === 3 && c.items[1].missing.some((x) => re.test(x)) && !c.items[0].missing.length && !c.items[2].missing.length
        && s.includes('構造化された指摘 3 件のうち、欄を欠く指摘 1 件') && s.includes('#2') && s.includes(RECORD_NOTE.structureNotBasis), s);
    }
    {
      const c = findingsCheck(JSON.stringify([good, { ...good, execution: true, run: 'https://ci.example/run/1' }, { location: { file: 'src/a.ts', line: 3 }, basis: '基準と事実' }]));
      const s = findingsSummary(toolInputsCheck(fullTool), c);
      // IMPL-0155:ok
      check('指摘の欠落(欄がそろう): 欠落を出さず、構造を満たしたことは内容の根拠でない旨を定型で出す', c.items.length === 3 && c.items.every((x) => !x.missing.length) && s.includes('欄を欠く指摘 0 件') && s.includes(RECORD_NOTE.structureNotBasis), s);
    }
    {
      const c = findingsCheck(JSON.stringify([{ location: '```\n[承認](https://example.invalid)', execution: true }]));
      const s = findingsSummary(toolInputsCheck(fullTool), c);
      // IMPL-0155:ng
      check('指摘の欠落: 道具の書いた所在がコードブロックを閉じる文字列を持っても、要約の中で閉じさせない', !s.split('\n').some((l) => l.includes('[承認]') && !l.startsWith('#1')) && (s.match(/```/g) ?? []).length % 2 === 0 && !s.includes('```\n[承認]'), s);
    }
    {
      // 実行の入口: 欠落があっても終了コードは 0(合否に使わない)。findings.json を消さず書き換えない。inputs は record/inputs.json を書く
      put('ai-review/findings.json', JSON.stringify({ findings: [{ location: 'src/a.ts:1' }] }));
      const before = fs.readFileSync(path.join(dir, 'findings.json'), 'utf8');
      const summaryFile = path.join(tmp, 'summary.md');
      const script = path.join(ROOT, 'scripts/gate/ai-review-record.mjs');
      const r = spawnSync(process.execPath, [script, 'findings', '--dir', dir], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile } });
      const out = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '';
      // IMPL-0155:ng
      check('実行の入口(findings): 欠落と契約のファイルの不在があっても終了コード 0 で、要約へ出し、findings.json を書き換えない', r.status === 0 && out.includes('欄を欠く指摘 1 件') && out.includes(RECORD_NOTE.toolMissing) && fs.readFileSync(path.join(dir, 'findings.json'), 'utf8') === before, `${r.status} ${r.stderr}`);
      const r2 = spawnSync(process.execPath, [script, 'inputs', '--dir', dir], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile, BASE_REF: 'main' } });
      let ok = false;
      try { ok = r2.status === 0 && JSON.parse(fs.readFileSync(path.join(dir, 'record/inputs.json'), 'utf8')).kind === 'ai-review-inputs'; } catch { ok = false; }
      // IMPL-0253:ok
      check('実行の入口(inputs): record/inputs.json を書き、要約へ出す', ok && fs.readFileSync(summaryFile, 'utf8').includes(RECORD_NOTE.notVerified), `${r2.status} ${r2.stderr}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ai-review.yml が無い構成の場面(突合 F-1): 写しの上でこの試験を動かす。無効の構成なら通り、有効の構成なら落ちる
if (process.env.PIT_IN_AI_REVIEW_SUBTEST !== '1') {
  for (const [enabled, expectOk] of [[false, true], [true, false]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-ai-review-'));
    try {
      for (const d of ['scripts', '.github', 'adapters']) if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
      const cfg = JSON.parse(read('process.config.json'));
      cfg.aiReview = { ...(cfg.aiReview ?? {}), enabled };
      fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(cfg, null, 2));
      fs.rmSync(path.join(dir, '.github/workflows/ai-review.yml'));
      const r = spawnSync(process.execPath, ['scripts/gate/test-base-judge-workflow.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PIT_IN_AI_REVIEW_SUBTEST: '1' } });
      const ok = expectOk ? r.status === 0 && /対象外 ai-review\.yml/.test(r.stdout) : r.status !== 0 && /NG\s+ai-review\.yml がある/.test(r.stdout);
      check(`ai-review.yml を消した構成(aiReview.enabled = ${enabled})で、この試験が${expectOk ? '対象外として通る' : '不備として落ちる'}`, ok, `終了コード ${r.status}: ${(r.stdout + r.stderr).split('\n').filter((l) => /^NG|Error/.test(l)).slice(0, 3).join(' / ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
