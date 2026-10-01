// 委任した変更のマージの経路(標準 第5章 5.5.4)。該当の判定と、有効化されている場合のマージの実行。
//
//   node scripts/gate/check-delegation.mjs --input <入力.json>
//     フィクスチャで判定する。GitHub へ問い合わせない。入力の形は delegation.mjs の judgeDelegatedMerge による。
//     入力に config が無ければ、手元の process.config.json を使う。該当すれば 0、該当しなければ 1 で終了する
//
//   node scripts/gate/check-delegation.mjs --pr <番号> [--repo owner/repo] [--status] [--merge]
//   node scripts/gate/check-delegation.mjs --head-sha <sha> [--repo owner/repo] [--status] [--merge]
//     PR の変更ファイル一覧・本文・コミットのトレーラ・必須チェックの結果を gh で集めて判定する。
//     構成と判定のコードは、手元の作業ツリーから読む。**作業ツリーは基底ブランチでなければならない**。
//     PR の側のコードと構成で判定すると、行為する側が判定を書き換えられる。
//     --status  判定の結果を、必須でないコミットステータス(delegation-eligibility)として出す
//     --merge   有効化されている場合に限り、マージを実行する。既定は無効。次の2つが揃ったときだけ動く
//                 環境変数 DELEGATED_MERGE_ENABLED=true(リポジトリの変数)
//                 環境変数 DELEGATED_MERGE_TOKEN(必須承認を回避できる権限の、専用のトークン)
//
// 機械は承認のレビューを付けない。先へ進めた変更には「人の事前確認を経ていない変更(G-6 の判定を事後の
// 抜き取りへ移した変更)として、規則 <ID> により先へ進めた。承認ではない」と PR へ記録し、スカッシュした
// コミットへトレーラ Delegated: <規則ID> と Risk: R3 を残す。証跡の集約は、この変更を G-6 を事後へ移した変更に数える。
// G-6 を事後へ移す変更で、開発者の席がその変更について協働である場合は、開発者の席の責任者(人)の承認が
// あるときだけマージする(第5章 5.5.6)。承認の後の判定し直しは、ワークフローの手動実行(PR の番号を指定)による。
//
// 条件4(取り消しの実績)と条件6(事後の抜き取り)は、ここでは判定しない。判定していない条件は出力へ載せる。
// 条件5(確約範囲とコア指定)は、構成にパス(delegation.protectedPaths)のキーが無ければ、判定できないものとして
// 該当しない。空の配列は「確約範囲・コア指定なし」の宣言として通す。
//
// 2026-09-30 時点で、--pr・--head-sha・--status・--merge の経路は、実際の GitHub 上で実行して確かめていない。
// 確かめたのは、--input による判定と、模擬の gh による手順に留まる。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, ROOT, fail, notice, warn } from './config.mjs';
import { judgeDelegatedMerge, trailerValues, recordText } from './delegation.mjs';

const STATUS_CONTEXT = 'delegation-eligibility';
const MAX_COMMITS = 250; // GitHub の API が返すコミットの上限。超える PR は判定できない
const MAX_FILES = 3000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(name);

function gh(args, { token = null, input = null } = {}) {
  return execFileSync('gh', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input: input ?? undefined,
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
const ghJson = (args) => JSON.parse(gh(args));
/** --paginate と --jq で、1行1件の JSON を受け取る */
const ghLines = (args) =>
  gh(args)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** 判定の結果の見出し。扱いは3つある(delegation.mjs の handling) */
const HEADLINE = {
  'post-hoc': (r) =>
    r.developerSeatCollab
      ? `**該当(G-6 を事後へ移す委任)**: 規則 ${r.rule}(独立レビュアの席の規則 ${r.reviewerRule})。開発者の席はこの変更について協働のため、開発者の席の責任者(人)の検証と承認を経ています。独立レビュー(G-6)の判定を事後の抜き取りへ移します。`
      : `**該当(G-6 を事後へ移す委任)**: 規則 ${r.rule}(独立レビュアの席の規則 ${r.reviewerRule})。独立レビュー(G-6)の判定を事後の抜き取りへ移せる変更です(人の事前確認を経ていない変更として記録します)。`,
  'performer-verified': (r) =>
    `**開発者の席の委任に該当**: 規則 ${r.actingRule}。変更ごとの検証は担い手が行います。独立レビュー(G-6)は、独立レビュアが人として事前に承認します。現在のブランチ保護のままマージできます。人の事前確認を経ていない変更ではありません。`,
  collab: (r) =>
    r.developerSeatCollab
      ? '**該当しない(開発者の席の責任者の承認待ち)**: G-6 を事後へ移す委任の範囲ですが、開発者の席はこの変更について協働です。開発者の席の責任者(人)が変更を検証して承認するまで、協働として扱います。承認の後、ワークフロー delegation を手動で実行する(PR の番号を指定)か、PR を更新すると判定し直します。'
      : '**該当しない**: 協働として扱い、人の確定を受けます。',
};
const STATUS_TEXT = {
  'performer-verified': (r) => `開発者の席の委任に該当: 規則 ${r.actingRule}。独立レビュアの事前の承認でマージする`,
  collab: (r) =>
    r.developerSeatCollab ? `該当しない(開発者の席の責任者の承認待ち): ${r.reasons[0] ?? ''}` : `該当しない(協働。人の確定を受ける): ${r.reasons[0] ?? ''}`,
};

/** 判定の結果を人が読める行にする */
function render(result, { number = null, merge = null } = {}) {
  const L = [];
  L.push(`### 委任の範囲への該当${number ? `(PR #${number})` : ''}`);
  L.push('');
  L.push(HEADLINE[result.handling](result));
  L.push('');
  L.push('| 条件 | 内容 | 結果 |');
  L.push('| --- | --- | --- |');
  for (const c of result.conditions) L.push(`| ${c.id} | ${c.label} | ${c.ok ? '満たす' : `**満たさない**: ${c.problems.join(' / ')}`} |`);
  for (const n of result.notJudged) L.push(`| ${n.id} | ${n.text} | 機械では判定していない |`);
  L.push('');
  L.push('この判定は承認ではありません。機械は承認のレビューを付けません。リスク区分は PR の記載(自己記載)によります。');
  if (merge) {
    L.push('');
    L.push(`マージの実行: ${merge}`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- フィクスチャによる判定

const inputPath = arg('--input');
if (inputPath) {
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const result = judgeDelegatedMerge({ ...input, config: input.config ?? loadConfig() });
  if (has('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(render(result, { number: input.pr?.number }));
  process.exit(result.eligible ? 0 : 1);
}

// ---------------------------------------------------------------- GitHub から入力を集めて判定する

const repo = arg('--repo') ?? process.env.GITHUB_REPOSITORY ?? '';
let number = arg('--pr');
const headShaArg = arg('--head-sha');

if (!repo || (!number && !headShaArg)) {
  fail('使い方: check-delegation.mjs --input <入力.json> | --pr <番号> [--repo owner/repo] [--status] [--merge]');
  process.exit(2);
}
if (number && !/^\d+$/.test(number)) {
  fail(`PR の番号が数値ではありません: ${number}`);
  process.exit(2);
}
if (headShaArg && !/^[0-9a-f]{7,64}$/i.test(headShaArg)) {
  fail('--head-sha が コミットの識別子ではありません');
  process.exit(2);
}

/** 判定できなかったとき。該当しないものとして扱い、協働として人の承認を待つ */
function cannotJudge(message, sha = null) {
  warn(`委任の範囲への該当を判定できません。協働として扱い、人の承認を待ちます: ${message}`);
  if (has('--status') && sha) postStatus(sha, `判定できない(協働。人の承認を待つ): ${message}`);
  process.exit(has('--status') ? 0 : 2);
}

function postStatus(sha, description) {
  try {
    gh([
      'api',
      '-X',
      'POST',
      `repos/${repo}/statuses/${sha}`,
      '-f',
      'state=success',
      '-f',
      `context=${STATUS_CONTEXT}`,
      '-f',
      `description=${description.slice(0, 138)}`,
      ...(process.env.GITHUB_RUN_ID
        ? ['-f', `target_url=${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`]
        : []),
    ]);
  } catch (e) {
    warn(`コミットステータスを出せませんでした: ${String(e.stderr ?? e.message).trim().split('\n')[0]}`);
  }
}

function comment(body) {
  gh(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]);
}

let prData;
try {
  if (!number) {
    // workflow_run から呼ばれた場合。先頭のコミットから、open の PR を引く
    const found = ghLines(['api', `repos/${repo}/commits/${headShaArg}/pulls`, '--jq', '.[] | {number, state, head: .head.sha}']).filter(
      (p) => p.state === 'open' && p.head.toLowerCase().startsWith(headShaArg.toLowerCase())
    );
    if (found.length !== 1) {
      notice(`コミット ${headShaArg.slice(0, 8)} を先頭に持つ open の PR が ${found.length} 件のため、判定しません`);
      process.exit(0);
    }
    number = String(found[0].number);
  }
  prData = ghJson(['api', `repos/${repo}/pulls/${number}`]);
} catch (e) {
  cannotJudge(`PR の取得に失敗した(${String(e.stderr ?? e.message).trim().split('\n')[0]})`);
}

const headSha = prData.head?.sha ?? null;
if (!headSha) cannotJudge('PR の先頭のコミットを特定できない');

// 判定のコードと構成は基底ブランチから読む。PR の先頭を checkout した作業ツリーでは判定しない
const localHead = git(['rev-parse', 'HEAD']);
if (localHead && localHead === headSha) {
  cannotJudge('作業ツリーが PR の先頭のコミットである。判定のコードと構成は基底ブランチから読む(PR の側のコードで判定しない)', headSha);
}

let config;
let files;
let commits;
let checks;
let reviews;
try {
  config = loadConfig();
  files = ghLines([
    'api',
    '--paginate',
    `repos/${repo}/pulls/${number}/files?per_page=100`,
    '--jq',
    '.[] | {path: .filename, previousPath: .previous_filename, additions, deletions}',
  ]);
  commits = ghLines([
    'api',
    '--paginate',
    `repos/${repo}/pulls/${number}/commits?per_page=100`,
    '--jq',
    '.[] | {sha, message: .commit.message}',
  ]);
  checks = ghLines([
    'api',
    '--paginate',
    `repos/${repo}/commits/${headSha}/check-runs?per_page=100`,
    '--jq',
    '.check_runs[] | {name, status, conclusion}',
  ]);
  // 開発者の席が協働の変更で、開発者の席の責任者の承認を確かめるために使う(レビュアごとの最後の状態)
  reviews = ghLines([
    'api',
    '--paginate',
    `repos/${repo}/pulls/${number}/reviews?per_page=100`,
    '--jq',
    '.[] | {login: .user.login, state, isBot: (.user.type == "Bot")}',
  ]);
} catch (e) {
  cannotJudge(`入力の取得に失敗した(${String(e.stderr ?? e.message).trim().split('\n')[0]})`, headSha);
}

const pr = {
  number: Number(number),
  title: prData.title ?? '',
  body: prData.body ?? '',
  state: prData.state,
  draft: prData.draft === true,
  baseRef: prData.base?.ref ?? null,
  defaultBranch: prData.base?.repo?.default_branch ?? null,
  headSha,
  fromFork: (prData.head?.repo?.full_name ?? null) !== (prData.base?.repo?.full_name ?? null),
  truncated: commits.length >= MAX_COMMITS || files.length >= MAX_FILES || (prData.changed_files ?? files.length) !== files.length,
};

const result = judgeDelegatedMerge({ config, pr, files, commits, checks, reviews });

// ---------------------------------------------------------------- マージの実行(既定で無効)

const enabled = process.env.DELEGATED_MERGE_ENABLED === 'true';
const token = process.env.DELEGATED_MERGE_TOKEN ?? '';
let mergeNote = null;

if (!result.eligible) {
  // 開発者の席だけの委任は、独立レビュアが事前に承認する。機械はマージしない
  mergeNote =
    result.handling === 'performer-verified'
      ? '実行しない(独立レビュアの事前の承認でマージする)'
      : result.developerSeatCollab
        ? '実行しない(開発者の席の責任者の承認を待つ)'
        : '実行しない(該当しない)';
} else if (!has('--merge')) {
  mergeNote = '実行しない(判定だけを行った)';
} else if (!enabled || !token) {
  mergeNote =
    '無効(組織がリポジトリの変数 DELEGATED_MERGE_ENABLED と、専用のトークンのシークレット DELEGATED_MERGE_TOKEN で有効化していない)。協働として人の承認を待つ';
} else {
  const record =
    `${recordText(result.rule)}\n\n` +
    `- 先頭のコミット: ${headSha}\n` +
    `- 独立レビュー(G-6)は、独立レビュアの席の責任者が事後の抜き取りで判定します(規則 ${result.reviewerRule})\n` +
    `- 機械が判定したのは、${result.conditions.map((c) => c.id).join('・')} です。${result.notJudged.map((n) => n.id).join('・')} は判定していません\n` +
    '- この記録は機械が残しました。承認のレビューではありません';
  // スカッシュしたコミットへ、変更単位の識別(トレーラ)を残す。証跡の集約はこのトレーラで数える
  const keep = (key) => [...new Set(commits.flatMap((c) => trailerValues(c.message, key)))].map((v) => `${key}: ${v}`);
  const message = [
    `委任の範囲の変更(規則 ${result.rule})。G-6 の判定を事後の抜き取りへ移した(人の事前確認を経ていない変更)。`,
    '',
    [...keep('Spec'), ...keep('ADR'), ...keep('Co-Authored-By'), `Delegated: ${result.rule}`].join('\n'),
  ].join('\n');
  try {
    gh(
      [
        'api',
        '-X',
        'PUT',
        `repos/${repo}/pulls/${number}/merge`,
        '-f',
        'merge_method=squash',
        '-f',
        `sha=${headSha}`,
        '-f',
        `commit_title=${pr.title} (#${number})`,
        '-f',
        `commit_message=${message}`,
      ],
      { token }
    );
    mergeNote = `実行した(${recordText(result.rule)})`;
    // 記録は、先へ進めた後に残す。進めていない変更へ「先へ進めた」と書かない。
    // PR への記録に失敗しても、スカッシュしたコミットのトレーラと本文に識別が残る
    try {
      comment(record);
    } catch (e) {
      warn(`PR へ記録を残せませんでした(${String(e.stderr ?? e.message).trim().split('\n')[0]})。コミットのトレーラ Delegated: ${result.rule} は残っています`);
      mergeNote += '。PR への記録に失敗した';
    }
  } catch (e) {
    const why = String(e.stderr ?? e.message).trim().split('\n')[0];
    mergeNote = `失敗した(${why})。協働として人の承認を待つ`;
  }
}

// ---------------------------------------------------------------- 出力

const text = render(result, { number, merge: mergeNote });
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);

if (has('--status')) {
  postStatus(
    headSha,
    result.eligible
      ? `該当(G-6 を事後へ移す委任): 規則 ${result.rule}。マージの実行: ${mergeNote.split('(')[0].split('。')[0]}`
      : STATUS_TEXT[result.handling](result)
  );
  process.exit(0);
}
process.exit(result.eligible ? 0 : 1);
