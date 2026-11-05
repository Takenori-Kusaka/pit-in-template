// 基底から読む判定のワークフロー(gate-g5-base.yml)と、書き込みの権限を持つ record-copy.yml の定義の読み方
// (標準 第4章 G-5「判定のコードの読み元」、議長の裁定 AR-1・AR-2。process-compass #371 / ADR-0115)。
//
// 定義の静的な試験(test-base-judge-workflow.mjs)、実環境の統制の確認(adoption-trial.mjs の env-check)、出荷の証跡の集約の
// 保証の開示(aggregate-evidence.mjs の項目1 の層の行)が、同じ関数で読む。GitHub Security Lab「Preventing pwn requests」の注意に沿う:
// PR の先頭を checkout しない、PR の側のファイルを実行しない、題名・本文を run: へ式展開しない、権限を read に限り秘密情報を使わない、
// 結果をジョブの結果(check run)で出す。読むのは定義の文字列であり、GitHub 上の実際の振る舞いは確かめない

/** コメントを除いた本文 */
export const stripComments = (text) =>
  String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#\s.*$/, ''))
    .join('\n');
/** トップレベルの on: の直下の契機の名前 */
export function triggersOf(body) {
  const m = body.match(/^on:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!m) return [];
  return [...m[1].matchAll(/^ {2}([a-z_]+):/gm)].map((x) => x[1]);
}
/** permissions: のブロック(トップレベルとジョブの両方)の「名前: 値」 */
export function permissionsOf(body) {
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
export function checkoutsOf(body) {
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

/** 層ごとの不備。定義(起動の契機)・判定のスクリプト(checkout の読み元)・PR のコードの実行・結果の出し方と権限 */
export function baseJudgeLayerProblems(text) {
  const body = stripComments(text);
  const L = { definition: [], script: [], execution: [], result: [] };
  const tr = triggersOf(body);
  if (!tr.includes('pull_request_target')) L.definition.push('pull_request_target で起動しない');
  for (const bad of ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'workflow_dispatch', 'workflow_run', 'push']) if (tr.includes(bad)) L.definition.push(`契機 ${bad} がある(定義を既定ブランチから読む形でない)`);
  const cos = checkoutsOf(body);
  if (!cos.length) L.script.push('checkout の手順が無い');
  for (const c of cos) {
    if (!/ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/.test(c)) L.script.push('checkout の ref が既定ブランチでない');
    if (!/persist-credentials:\s*false/.test(c)) L.execution.push('checkout が資格情報を残す(persist-credentials が false でない)');
  }
  for (const l of body.split('\n')) {
    if (/^\s*ref:/.test(l) && /head|refs\/pull|merge_commit_sha|github\.sha/.test(l)) L.script.push(`ref に PR の先頭・マージのコミットを指定している(${l.trim()})`);
    if (/refs\/pull\//.test(l) && !/fetch|refs\/remotes\/pr\/head/.test(l)) L.script.push(`PR の参照を取得(fetch)以外で使っている(${l.trim()})`);
    if (/git\s+(checkout|switch|worktree|reset)\b/.test(l)) L.script.push(`作業ツリーを替える git の操作がある(${l.trim()})`);
  }
  if (!/node scripts\/gate\/check-pr\.mjs[^\n]*--head[^\n]*--require-control-approval/.test(body)) L.script.push('既定ブランチの check-pr.mjs を --head と --require-control-approval で呼んでいない');
  if (/uses:\s*\.\//.test(body)) L.execution.push('手元の action(uses: ./)を使う');
  if (/adapter\.mjs|npm (ci|install)|yarn|pnpm|pip install|setup-stack/.test(body)) L.execution.push('依存の導入・アダプタのコマンドを実行する(PR の側のファイルを実行しうる)');
  if (/secrets\./.test(body)) L.execution.push('秘密情報を参照する');
  for (const l of body.split('\n')) {
    const inEnv = /^\s+[A-Z_][A-Z0-9_]*:\s*\$\{\{/.test(l);
    if (!inEnv && /\$\{\{\s*github\.(event\.pull_request\.(title|body|head\.ref|head\.label)|head_ref)/.test(l)) L.execution.push(`PR の題名・本文・ブランチ名を式展開している(${l.trim()})`);
  }
  const perms = permissionsOf(body);
  if (!perms.length) L.result.push('permissions の宣言が無い(既定の権限で動く)');
  for (const x of perms) {
    if (x.scope === '(一括)') L.result.push(`permissions を一括で宣言している(${x.value})`);
    else if (x.value !== 'read' && x.value !== 'none') L.result.push(`permissions の ${x.scope} が ${x.value}(read を超える)`);
    if (x.scope === 'statuses') L.result.push('statuses の権限がある(結果を commit status で出す形になる)');
  }
  if (/\/statuses\/|commit status|gh api[^\n]*statuses/.test(body)) L.result.push('commit status を出す(結果は check run で出す)');
  if (!/^\s{4}name:\s*gate-g5-base\s*$/m.test(body)) L.result.push('ジョブの名前が gate-g5-base でない(ルールセットの必須チェックが指す名前)');
  if (/--comment/.test(body)) L.result.push('PR へコメントを書く(書き込みの権限を要する)');
  return L;
}

/** gate-g5-base.yml の不備(空なら適合) */
export function baseJudgeWorkflowProblems(text) {
  const L = baseJudgeLayerProblems(text);
  return [...L.definition, ...L.script, ...L.execution, ...L.result];
}

/**
 * 保証の開示の項目1 の層ごとの値(process-compass #371 突合 C-5)。text は出荷の時点の既定ブランチの gate-g5-base.yml(無ければ null)。
 * 各層は { state: 'satisfied' | 'unsatisfied' | 'unconfirmed', detail }。定義の文字列から読んだ値であり、GitHub 上の振る舞いではない
 */
export function baseJudgeLayers(text) {
  if (text === null || text === undefined) {
    const missing = { state: 'unsatisfied', detail: '既定ブランチに .github/workflows/gate-g5-base.yml が無い' };
    return { definition: missing, script: missing, execution: missing, result: missing };
  }
  const L = baseJudgeLayerProblems(text);
  const of = (probs, ok) => (probs.length ? { state: 'unsatisfied', detail: probs.join('。') } : { state: 'satisfied', detail: ok });
  return {
    definition: of(L.definition, '既定ブランチの定義(pull_request_target)'),
    script: of(L.script, '既定ブランチを checkout し、既定ブランチの check-pr.mjs で判定する(PR の先頭は fetch だけ)'),
    execution: of(L.execution, 'PR のコードを実行しない(手元の action・依存の導入・アダプタ・秘密情報なし)'),
    result: of(L.result, 'ジョブの結果(check run)gate-g5-base。権限は read だけ'),
  };
}

/** jobs: の直下のジョブごとの本文({ ジョブの ID: 本文 }) */
export function jobsOf(body) {
  const m = String(body).match(/^jobs:[ \t]*\n([\s\S]*)$/m);
  if (!m) return {};
  const out = {};
  let cur = null;
  for (const l of m[1].split('\n')) {
    if (/^\S/.test(l)) break;
    const h = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (h) {
      cur = h[1];
      out[cur] = '';
      continue;
    }
    if (cur) out[cur] += `${l}\n`;
  }
  return out;
}
/** ジョブの本文の手順(steps の各要素)の本文 */
const stepsOf = (job) => {
  const out = [];
  let cur = null;
  for (const l of job.split('\n')) {
    if (/^ {6}- /.test(l)) {
      if (cur !== null) out.push(cur);
      cur = `${l}\n`;
    } else if (cur !== null) {
      if (/^ {0,5}\S/.test(l)) {
        out.push(cur);
        cur = null;
      } else cur += `${l}\n`;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
};

/** AI レビューの指示の置き場(既定ブランチの版から読む。標準 第5章 5.8.6 の要求事項7。process-compass #369) */
export const AI_REVIEW_INSTRUCTIONS_DIR = '.github/ai-review/';

/**
 * ai-review.yml の不備(空なら適合。標準 第5章 5.8.6 の要求事項7、附属書H H.4 条件3。IMPL-0333。process-compass #369)。
 * #371 の「基底から読む」型(baseJudgeLayerProblems)に、プロンプトの注入の条件(#371 の申し送り)を足す:
 * pull_request_target で動き、checkout は既定ブランチだけ、指示は既定ブランチの作業ツリーの .github/ai-review/ から渡す、
 * AI レビューのジョブは read だけ、書き込みは別のジョブに分けて PR の内容に依らない入力(enabled)だけを渡す、
 * 題名・本文をどのジョブにも渡さない、PR のコードを checkout・実行しない、承認・commit status を出さない、AI の手順は continue-on-error。
 * 読むのは定義の文字列であり、GitHub 上の実際の振る舞いは確かめない
 */
export function aiReviewWorkflowProblems(text) {
  return [...new Set([...aiReviewAllowlistProblems(text), ...aiReviewDenylistProblems(text)])];
}
/** 否定のリストの検査(どの禁止に当たったかの説明。正は aiReviewAllowlistProblems) */
function aiReviewDenylistProblems(text) {
  const body = stripComments(text);
  const p = [];
  const tr = triggersOf(body);
  if (!tr.includes('pull_request_target')) p.push('pull_request_target で起動しない(指示とレビューの手順を PR の側の定義から読む)');
  for (const bad of ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment', 'workflow_dispatch', 'workflow_run', 'push']) if (tr.includes(bad)) p.push(`契機 ${bad} がある(定義を既定ブランチから読む形でない)`);
  const top = body.split(/^jobs:/m)[0];
  const topPerms = permissionsOf(top);
  if (!topPerms.length) p.push('トップレベルの permissions の宣言が無い(既定の権限で動く)');
  for (const x of topPerms) {
    if (x.scope === '(一括)') p.push(`トップレベルの permissions を一括で宣言している(${x.value})`);
    else if (x.value !== 'read' && x.value !== 'none') p.push(`トップレベルの permissions の ${x.scope} が ${x.value}(read を超える。書き込みはジョブに限って与える)`);
  }
  if (/github\.event\.pull_request\.(title|body)\b/.test(body)) p.push('PR の題名・本文をジョブへ渡している(入力の分離。標準 第3章 3.5.3)');
  const jobs = jobsOf(body);
  let reviewer = null;
  for (const [id, j] of Object.entries(jobs)) {
    const perms = permissionsOf(j);
    const writes = perms.filter((x) => x.scope === '(一括)' || (x.value !== 'read' && x.value !== 'none'));
    if (/^ {4}name:\s*ai-review\s*$/m.test(j)) reviewer = id;
    if (/gh pr review|--approve|event=APPROVE|"event"\s*:\s*"APPROVE"/.test(j)) p.push(`ジョブ ${id} が承認・レビューを出す(AI の確認を承認にしない)`);
    if (/\/statuses\/|gh api[^\n]*statuses/.test(j) || perms.some((x) => x.scope === 'statuses')) p.push(`ジョブ ${id} が commit status を出す(PR の側から上書きできる)`);
    if (/uses:\s*\.\//.test(j)) p.push(`ジョブ ${id} が手元の action(uses: ./)を使う`);
    // 依存の導入(npm ci など)は拒まない。作業ツリーは既定ブランチであり、PR のコードの実行にならない(#369 の突合 F-2 の誤検出)
    for (const l of j.split('\n')) {
      if (/^\s*repository:/.test(l)) p.push(`ジョブ ${id} の checkout が repository: を指定している(フォークの内容を取り出しうる。${l.trim()})`);
      if (/^\s*ref:/.test(l) && /head|refs\/pull|merge_commit_sha|github\.sha/.test(l)) p.push(`ジョブ ${id} の ref に PR の先頭・マージのコミットを指定している(${l.trim()})`);
      if (/refs\/pull\//.test(l) && !/fetch|refs\/remotes\/pr\/head/.test(l)) p.push(`ジョブ ${id} が PR の参照を取得(fetch)以外で使っている(${l.trim()})`);
      if (/git\s+(checkout|switch|worktree|reset|restore)\b/.test(l)) p.push(`ジョブ ${id} に作業ツリーを替える git の操作がある(${l.trim()})`);
      const inEnv = /^\s+[A-Z_][A-Z0-9_]*:\s*\$\{\{/.test(l);
      if (!inEnv && /\$\{\{\s*github\.(event\.pull_request\.(head\.ref|head\.label)|head_ref)/.test(l)) p.push(`ジョブ ${id} が PR のブランチ名を式展開している(${l.trim()})`);
      if (/secrets\./.test(l) && !/^\s+[A-Z_][A-Z0-9_]*:\s*\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}\s*$/.test(l)) p.push(`ジョブ ${id} が秘密情報を環境変数の外で参照する(${l.trim()})`);
    }
    if (writes.length) {
      for (const w of writes) if (w.scope !== 'pull-requests') p.push(`書き込みのジョブ ${id} の permissions の ${w.scope} が ${w.value}(書き込みは pull-requests に限る)`);
      if (/^ {4}name:\s*ai-review\s*$/m.test(j)) p.push('AI レビューのジョブ(ai-review)が書き込みの権限を持つ(書き込みは別のジョブに分ける)');
      if (checkoutsOf(j).length) p.push(`書き込みのジョブ ${id} が checkout する`);
      if (/secrets\./.test(j)) p.push(`書き込みのジョブ ${id} が秘密情報を参照する`);
      if (/github\.event\.pull_request\.head|github\.head_ref|refs\/pull\//.test(j)) p.push(`書き込みのジョブ ${id} が PR の先頭を入力にする`);
      for (const mm of j.matchAll(/needs\.[A-Za-z0-9_-]+\.outputs\.([A-Za-z0-9_-]+)/g)) if (mm[1] !== 'enabled') p.push(`書き込みのジョブ ${id} が前のジョブの出力 ${mm[1]} を入力にする(PR の内容に依らない入力は enabled だけ)`);
    } else {
      for (const c of checkoutsOf(j)) {
        if (!/ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/.test(c)) p.push(`ジョブ ${id} の checkout の ref が既定ブランチでない`);
        if (!/persist-credentials:\s*false/.test(c)) p.push(`ジョブ ${id} の checkout が資格情報を残す(persist-credentials が false でない)`);
      }
    }
  }
  if (!reviewer) {
    p.push('ジョブの名前 ai-review が無い');
    return p;
  }
  const j = jobs[reviewer];
  const rperms = permissionsOf(j);
  if (!rperms.length) p.push('AI レビューのジョブ(ai-review)に permissions の宣言が無い');
  const cos = checkoutsOf(j);
  if (!cos.length) p.push('AI レビューのジョブが既定ブランチを checkout しない(指示を既定ブランチの版から読めない)');
  const dir = AI_REVIEW_INSTRUCTIONS_DIR.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  for (const l of j.split('\n')) {
    if (/pr\/head|refs\/pull|head\.sha|head_ref/.test(l) && (new RegExp(dir).test(l) || /\.claude\//.test(l))) p.push(`指示を PR の先頭から読む(${l.trim()})`);
  }
  const steps = stepsOf(j);
  const ai = steps.filter((s) => /AI_REVIEW_INSTRUCTIONS:/.test(s));
  if (!ai.length) p.push('AI レビューの手順へ、指示の置き場(AI_REVIEW_INSTRUCTIONS)を渡していない');
  for (const s of ai) {
    if (!new RegExp(`AI_REVIEW_INSTRUCTIONS:\\s*\\.?\\/?${dir}`).test(s)) p.push(`指示の置き場が ${AI_REVIEW_INSTRUCTIONS_DIR} の既定ブランチの作業ツリーでない`);
    if (!/continue-on-error:\s*true/.test(s)) p.push('AI レビューの手順が continue-on-error でない(AI の確認を合否条件にしない)');
  }
  return p;
}
// ↑ 否定のリストの検査(禁止の列挙)。#369 の独立の突合 F-2 で、列挙の外の書き方(FETCH_HEAD、変数を経由した参照、checkout の
// repository:、toJSON、GITHUB_EVENT_PATH、artifact など)を見逃した。下の許す形の一覧の検査(aiReviewAllowlistProblems)を正とし、
// aiReviewWorkflowProblems はその結果と合わせて返す(否定のリストの文言は、どの禁止に当たったかの説明として残す)

/** 行の末尾の空白と空行を除く(字下げは残す。字下げを替えて YAML の構造を変える書き方を同じ形と読まないため) */
const normBlock = (s) => String(s).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).join('\n');

/**
 * ai-review.yml の決まった部分(process-compass #369 の突合 F-2)。採用者が書き換えてよいのは、手順「レビューの実行」の run: と、
 * その env の秘密情報の行(1つの名前ごとに secrets から)だけ。ほかはこの形と一致しなければならない。
 * 値は stripComments の後の本文(コメント行を除き、字下げを残す)
 */
const AI_REVIEW_FIXED = {
  checkout: "      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.repository.default_branch }}\n          persist-credentials: false\n          fetch-depth: 0\n          submodules: false",
  gate: "      - name: 有効かどうかを確認する\n        id: gate\n        env:\n          HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}\n          REPO: ${{ github.repository }}\n        run: |\n          enabled=$(node -e \"const c=require('./process.config.json');console.log(c.aiReview?.enabled ? 'yes':'no')\")\n          forks=$(node -e \"const c=require('./process.config.json');console.log(c.aiReview?.allowForks === true ? 'yes':'no')\")\n          run_ai=no\n          if [ \"$enabled\" = \"yes\" ]; then\n            if [ \"$HEAD_REPO\" = \"$REPO\" ] || [ \"$forks\" = \"yes\" ]; then\n              run_ai=yes\n            else\n              echo \"::notice::フォークからの PR のため、AI の手順を動かしません(既定。構成の aiReview.allowForks で変える)\"\n              echo \"フォークからの PR のため、AI の手順を動かしていません(aiReview.allowForks が true でない)\" >> \"$GITHUB_STEP_SUMMARY\"\n            fi\n          fi\n          echo \"enabled=$enabled\" >> \"$GITHUB_OUTPUT\"\n          echo \"run_ai=$run_ai\" >> \"$GITHUB_OUTPUT\"\n          echo \"AI レビューの指示の版(既定ブランチ): $(git rev-parse HEAD)\" >> \"$GITHUB_STEP_SUMMARY\"",
  fetch: "      - name: PR の先頭を取得する\n        if: steps.gate.outputs.run_ai == 'yes'\n        env:\n          GH_TOKEN: ${{ github.token }}\n          PR_NUMBER: ${{ github.event.pull_request.number }}\n          BASE_REF: ${{ github.base_ref }}\n        run: |\n          set -euo pipefail\n          auth=\"AUTHORIZATION: basic $(printf 'x-access-token:%s' \"$GH_TOKEN\" | base64 -w0)\"\n          git -c \"http.https://github.com/.extraheader=$auth\" fetch --no-tags --no-recurse-submodules origin \\\n            \"+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head\" \\\n            \"+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}\"",
  input: "      - name: 差分を書き出す\n        id: input\n        if: steps.gate.outputs.run_ai == 'yes'\n        env:\n          BASE_REF: ${{ github.base_ref }}\n        run: |\n          set -euo pipefail\n          mkdir -p \"$RUNNER_TEMP/ai-review\"\n          git diff --no-ext-diff --no-textconv \"origin/${BASE_REF}...refs/remotes/pr/head\" > \"$RUNNER_TEMP/ai-review/diff.patch\"\n          git diff --no-ext-diff --no-textconv --name-status \"origin/${BASE_REF}...refs/remotes/pr/head\" > \"$RUNNER_TEMP/ai-review/files.txt\"\n          if [ -f .github/ai-review/instructions.md ]; then\n            echo \"instructions=yes\" >> \"$GITHUB_OUTPUT\"\n          else\n            echo \"instructions=no\" >> \"$GITHUB_OUTPUT\"\n            echo \"::warning::既定ブランチに .github/ai-review/instructions.md がありません。指示の置き場を既定ブランチへ入れるまで、AI レビューを実行しません\"\n            echo \"既定ブランチに .github/ai-review/instructions.md が無いため、AI レビューを実行していません\" >> \"$GITHUB_STEP_SUMMARY\"\n          fi",
  failure: "      - name: レビューの失敗を表示する\n        if: steps.review.outcome == 'failure'\n        run: |\n          echo \"::warning::AI レビューの手順が失敗しました。指摘は出ていません。PR へコメントする実装は read の権限で失敗します。出し先をジョブの要約へ移してください\"\n          echo \"**AI レビューの手順が失敗しました。指摘は出ていません**(指摘が無いことと区別してください)。PR へコメントする実装は read の権限で失敗します\" >> \"$GITHUB_STEP_SUMMARY\"",
  head: "    name: ai-review\n    if: '!github.event.pull_request.draft'\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      pull-requests: read\n    outputs:\n      enabled: ${{ steps.gate.outputs.enabled }}",
  noticeHead: "    name: ai-review-notice\n    needs: ai-review\n    if: always() && needs.ai-review.outputs.enabled == 'yes'\n    runs-on: ubuntu-latest\n    permissions:\n      pull-requests: write",
  top: "name: ai-review\non:\n  pull_request_target:\n    types: [opened, synchronize, reopened, ready_for_review]\npermissions:\n  contents: read\n  pull-requests: read",
  reviewHead: [
    '        id: review',
    "        if: steps.gate.outputs.run_ai == 'yes' && steps.input.outputs.instructions == 'yes'",
    '        continue-on-error: true',
    '        env:',
    '          AI_REVIEW_INSTRUCTIONS: .github/ai-review/instructions.md',
    '          AI_REVIEW_DIFF: ${{ runner.temp }}/ai-review/diff.patch',
    '          AI_REVIEW_FILES: ${{ runner.temp }}/ai-review/files.txt',
  ],
  noticeEnv: ['        env:', '          GH_TOKEN: ${{ github.token }}', '          REPO: ${{ github.repository }}', '          PR_NUMBER: ${{ github.event.pull_request.number }}'],
  noticeRunFirst: '          gh pr comment "$PR_NUMBER" --repo "$REPO" --body "$(cat <<\'MD\'',
};
/** 式(${{ }})として許すもの。secrets.<名前> は手順「レビューの実行」の env の行でだけ許す */
const AI_REVIEW_EXPRESSIONS = new Set([
  'steps.gate.outputs.enabled', 'github.event.repository.default_branch', 'github.event.pull_request.head.repo.full_name', 'github.repository',
  'github.token', 'github.event.pull_request.number', 'github.base_ref', 'runner.temp',
]);
/** 手順「レビューの実行」の run: で拒む書き方(PR の先頭・PR のイベント・PR の API を読む、作業ツリーへ木を展開する、後の手順の環境を替える) */
const AI_REVIEW_RUN_FORBIDDEN = [
  [/refs\/remotes\/pr\b|refs\/pull\/|FETCH_HEAD|\bpr\/head\b/, 'PR の先頭の参照を読む'],
  [/GITHUB_EVENT_PATH|GITHUB_EVENT\b/, 'PR のイベント(題名・本文を含む)を読む'],
  [/\bgh\s+(pr|api|issue|run|search|repo|release|workflow|cache|secret|variable)\b/, 'gh で PR・リポジトリの API を呼ぶ(題名・本文の読み出しや書き込み)'],
  [/api\.github\.com|\/repos\/[^\s]*\/pulls/, 'GitHub の API を直接呼ぶ'],
  [/\bgit\s+(-c\s+\S+\s+)*(checkout|switch|worktree|reset|restore|read-tree|checkout-index|archive|stash|apply|am|merge|rebase|cherry-pick|show|cat-file|fetch|pull|clone|update-index|unpack-objects)\b/, '作業ツリーへ木を展開する・PR の内容を取り出す git の操作'],
  [/GITHUB_ENV|GITHUB_PATH/, '後の手順の環境を替える'],
  [/--approve|gh\s+pr\s+review/, '承認を出す'],
];
const ALLOWED_SETUP = /^ {6}- uses: actions\/setup-(node|python|go)@v\d+$/;
const ALLOWED_SETUP_WITH = /^ {10}(node|python|go)-version: [\w.'"-]+$/;

/**
 * ai-review.yml の許す形の一覧の検査(空なら適合。process-compass #369 の突合 F-2)。契機・トップの権限・ジョブの集合と各ジョブの
 * 見出し・決まった手順はこのファイルの形と一致すること。採用者が置ける手順は、actions/setup-* と、手順「レビューの実行」の run: と
 * 秘密情報の env の行だけ。式は一覧にあるものだけ。読むのは定義の文字列であり、GitHub 上の実際の振る舞いは確かめない
 */
export function aiReviewAllowlistProblems(text) {
  const body = stripComments(text);
  const p = [];
  const [topPart, ...rest] = body.split(/^jobs:[ \t]*$/m);
  if (!rest.length) return ['jobs: が無い'];
  if (normBlock(topPart) !== AI_REVIEW_FIXED.top) p.push('契機・名前・トップの権限が許す形と違う(契機は pull_request_target だけ、トップの権限は contents・pull-requests の read だけ)');
  const after = rest.join('jobs:').split('\n').slice(1);
  if (after.some((l) => /^\S/.test(l))) p.push('jobs: の後にトップレベルの鍵がある');
  // 式の一覧
  const lines = body.split('\n');
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
      const e = m[1].trim();
      if (AI_REVIEW_EXPRESSIONS.has(e)) continue;
      if (/^secrets\.[A-Za-z0-9_]+$/.test(e) && /^ {10}[A-Z][A-Z0-9_]*: \$\{\{ secrets\.[A-Za-z0-9_]+ \}\}$/.test(l)) continue;
      p.push(`許していない式 \${{ ${e} }}(${i + 1} 行。題名・本文・PR の先頭・秘密情報の一括の受け渡しを含む)`);
    }
    if (/\$\{\{/.test(l.replace(/\$\{\{[\s\S]*?\}\}/g, ''))) p.push(`閉じていない式(${i + 1} 行)`);
  });
  const jobs = jobsOf(body);
  const ids = Object.keys(jobs);
  if (ids.length !== 2 || !ids.includes('ai-review') || !ids.includes('ai-review-notice')) p.push(`ジョブは ai-review と ai-review-notice の2つだけ(実際: ${ids.join(', ') || 'なし'})`);
  // AI レビューのジョブ
  const rj = jobs['ai-review'];
  if (rj !== undefined) {
    const [h, ...st] = rj.split(/^ {4}steps:[ \t]*$/m);
    if (normBlock(h) !== AI_REVIEW_FIXED.head) p.push('ジョブ ai-review の見出し(名前・条件・権限・出力)が許す形と違う(権限は contents・pull-requests の read だけ、出力は enabled だけ)');
    if (st.length !== 1) p.push('ジョブ ai-review の steps: が1つでない');
    const steps = stepsOf(st.join('')).map(normBlock);
    const kinds = steps.map((s) => {
      for (const k of ['checkout', 'gate', 'fetch', 'input', 'failure']) if (s === AI_REVIEW_FIXED[k]) return k;
      const sl = s.split('\n');
      if (ALLOWED_SETUP.test(sl[0]) && (sl.length === 1 || (sl[1] === '        with:' && sl.slice(2).every((x) => ALLOWED_SETUP_WITH.test(x))))) return 'setup';
      if (/^ {6}- name: /.test(sl[0]) && sl[1] === AI_REVIEW_FIXED.reviewHead[0]) return 'review';
      return 'other';
    });
    steps.forEach((s, i) => {
      if (kinds[i] === 'other') p.push(`許していない手順(${s.split('\n')[0].trim()}。決まった手順は書き換えない。足せるのは actions/setup-* だけ)`);
    });
    const order = kinds.filter((k) => k !== 'setup' && k !== 'other');
    if (order.join(',') !== 'checkout,gate,fetch,input,review,failure') p.push(`決まった手順の並びが違う(期待: checkout・有効かどうか・PR の先頭の取得・差分の書き出し・レビューの実行・失敗の表示。実際: ${order.join('・')})`);
    if (kinds[0] !== 'checkout') p.push('最初の手順が既定ブランチの checkout でない');
    for (const s of steps.filter((_, i) => kinds[i] === 'review')) p.push(...reviewStepProblems(s));
  }
  // 書き込みのジョブ
  const nj = jobs['ai-review-notice'];
  if (nj !== undefined) {
    const [h, ...st] = nj.split(/^ {4}steps:[ \t]*$/m);
    if (normBlock(h) !== AI_REVIEW_FIXED.noticeHead) p.push('ジョブ ai-review-notice の見出しが許す形と違う(needs は ai-review、条件は enabled だけ、権限は pull-requests: write だけ)');
    const steps = stepsOf(st.join('')).map(normBlock);
    if (steps.length !== 1) p.push(`ジョブ ai-review-notice の手順は1つだけ(実際: ${steps.length})`);
    for (const s of steps) {
      const sl = s.split('\n');
      const envAt = sl.indexOf('        env:');
      const ok = /^ {6}- name: \S/.test(sl[0]) && envAt === 1 && AI_REVIEW_FIXED.noticeEnv.every((x, k) => sl[envAt + k] === x)
        && sl[envAt + 4] === '        run: |' && sl[envAt + 5] === AI_REVIEW_FIXED.noticeRunFirst && sl.at(-2) === '          MD' && sl.at(-1) === '          )"';
      if (!ok) p.push('ジョブ ai-review-notice の手順が許す形と違う(env は GH_TOKEN・REPO・PR_NUMBER だけ、run: は定型の文を引用つきのヒアドキュメントで gh pr comment へ渡すだけ)');
      const bodyLines = sl.slice(envAt + 6, -2);
      // 定型の文の要の行(位置づけ・承認しない・合否条件にしない)。stripComments は見出しの行(# で始まる)を除くため、箇条で確かめる
      for (const must of ['独立レビュー(G-6)の代替にはなりません', '承認(approve)は行いません', '合否条件にしていない']) {
        if (!bodyLines.some((x) => x.includes(must))) p.push(`ジョブ ai-review-notice の定型の文に「${must}」が無い`);
      }
      if (bodyLines.some((x) => x.trim() === 'MD')) p.push('ジョブ ai-review-notice の定型の文の中でヒアドキュメントを閉じている');
    }
  }
  return p;
}
/**
 * ai-review.yml の検査の対象か(#369 の突合 F-1)。/process-init は AI レビューを無効にした構成で ai-review.yml を消す。
 * 無効の構成でファイルが無ければ対象外(飛ばしたことを出す)、有効の構成でファイルが無ければ不備
 */
export function aiReviewCheckPlan({ exists, config }) {
  if (exists) return { plan: 'check' };
  if (config?.aiReview?.enabled === false) return { plan: 'skip', why: '構成で AI レビューを無効にし、ai-review.yml が無い' };
  return { plan: 'missing', why: '構成で AI レビューが有効なのに .github/workflows/ai-review.yml が無い' };
}

/** 手順「レビューの実行」の不備 */
function reviewStepProblems(s) {
  const p = [];
  const sl = s.split('\n');
  const head = AI_REVIEW_FIXED.reviewHead;
  if (!head.every((x, k) => sl[1 + k] === x)) p.push('手順「レビューの実行」の id・条件・continue-on-error・指示の置き場・差分の受け渡しが許す形と違う');
  let i = 1 + head.length;
  while (i < sl.length && /^ {10}[A-Z][A-Z0-9_]*: \$\{\{ secrets\.[A-Za-z0-9_]+ \}\}$/.test(sl[i])) i++;
  if (/^ {8}timeout-minutes: \d+$/.test(sl[i] ?? '')) i++;
  if (sl[i] !== '        run: |') p.push(`手順「レビューの実行」に、許していない鍵・env の行がある(${(sl[i] ?? '(なし)').trim()}。env に足せるのは、1つの名前ごとに secrets から渡す行だけ)`);
  const run = sl.slice(i + 1);
  if (run.some((x) => !/^ {10}/.test(x))) p.push('手順「レビューの実行」の run: の後に、別の鍵がある');
  const runText = run.join('\n');
  for (const [re, why] of AI_REVIEW_RUN_FORBIDDEN) {
    const hit = run.find((x) => re.test(x));
    if (hit) p.push(`手順「レビューの実行」の run: が${why}(${hit.trim()})`);
  }
  if (/secrets\./.test(runText)) p.push('手順「レビューの実行」の run: が秘密情報を参照する(env で渡す)');
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
