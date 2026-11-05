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
