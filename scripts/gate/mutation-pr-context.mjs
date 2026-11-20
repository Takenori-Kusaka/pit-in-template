// G-5 の段 mutation が閾値割れを台帳の行で受けるときの、PR の記録(作成者・先頭・本文・レビュー)の取得(ADR-0243。process-compass #445)。
//
//   node scripts/gate/mutation-pr-context.mjs --out <出力の JSON の所在>
//
// 取得は、段のコマンドを走らせるステップとは別のステップで行う。GH_TOKEN を付けるのはこのステップだけで、段のコマンド(PR 側のテスト)へは
// 渡さない。段へ渡すのは出力の JSON の所在(PIT_IN_PR_CONTEXT)だけ。取得に失敗したときも終了コード 0 で、problem を書いた JSON を出す
// (段は「読めない」として閾値割れを受けない。失敗の側に倒す)。
//
// 入力(環境変数):
//   EVENT_NAME      pull_request | push(それ以外は problem)
//   REPO            owner/name
//   PR の経路:      PR_NUMBER・PR_AUTHOR・PR_AUTHOR_ID・PR_HEAD_SHA・PR_BASE_REF・PR_BODY(イベントのペイロードの値)
//   push の経路:    SHA(push の先頭)・DEFAULT_BRANCH。ホスティングの記録で、先頭がマージのコミットの PR を1件だけ引く
// 出力: { route, pr: { number, authorLogin, authorId, headSha, body, baseRef }, reviews: [...] | null, problem: string | null }
//
// push の経路の照合(squash のマージが対象。merge commit・rebase・merge queue は照合が取れたときだけ受け、取れなければ受けない):
//   merged == true かつ merge_commit_sha == push の先頭 かつ base.ref == 既定ブランチ の PR が、ちょうど1件。推測(コミットの題の (#N) など)はしない

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** レビューの整形(pr-rules の「PR のレビュー」ステップと同じもの。gate-g5.yml)。試験が、2か所の式が一致することを確かめる */
export const REVIEWS_JQ = '.[] | {id, state, body, submitted_at, commit_id, author_association, author: {login: .user.login, id: .user.id, is_bot: (.user.type == "Bot")}}';
/** レビューの本文の編集者(editor)の取得。書き手以外が編集したレビューを数えないため(EV-0220) */
export const EDITORS_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviews(first:100){nodes{databaseId editor{login}}}}}}';
export const EDITORS_JQ = '[.data.repository.pullRequest.reviews.nodes[] | {key: (.databaseId | tostring), value: (.editor.login // "")}] | from_entries';

/** gh を呼んで標準出力を返す。失敗したら null */
export function defaultGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout : null;
}

const parseJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const lines = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

/** PR のレビューの一覧。取得か解釈に失敗したら null。editor を引けたレビューにだけ edited_by を足す(引けなければ足さない) */
export function fetchReviews(repo, number, gh = defaultGh) {
  const raw = gh(['api', `repos/${repo}/pulls/${number}/reviews`, '--paginate', '--jq', REVIEWS_JQ]);
  if (raw === null) return null;
  const list = lines(raw).map(parseJson);
  if (list.some((x) => x === undefined || x === null || typeof x !== 'object')) return null;
  const [owner, name] = String(repo).split('/');
  const ed = gh(['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`, '-f', `query=${EDITORS_QUERY}`, '--jq', EDITORS_JQ]);
  const map = ed === null ? undefined : parseJson(ed);
  if (!map || typeof map !== 'object') return list;
  return list.map((r) => {
    const k = String(r.id);
    return Object.prototype.hasOwnProperty.call(map, k) ? { ...r, edited_by: map[k] === '' ? null : map[k] } : r;
  });
}

/**
 * push の先頭をマージのコミットとする PR を、ホスティングの記録の候補から1件だけ選ぶ。
 * 条件は merged == true・merge_commit_sha == sha・base.ref == 既定ブランチ。ちょうど1件でなければ { problem }
 */
export function pickMergedPr(prs, { sha, defaultBranch }) {
  if (!Array.isArray(prs)) return { problem: 'コミットに結びつく PR の一覧を読めない' };
  if (!sha || !defaultBranch) return { problem: 'push の先頭のコミットか既定ブランチの名が分からない' };
  const hit = prs.filter((p) => (p?.merged === true || (p?.merged === undefined && p?.merged_at)) && p?.merge_commit_sha === sha && p?.base?.ref === defaultBranch);
  if (hit.length === 0) return { problem: `先頭 ${String(sha).slice(0, 7)} をマージのコミットとする PR(base が ${defaultBranch}、マージ済み)が無い。PR を経ない push か、マージの方式で照合が取れない` };
  if (hit.length > 1) return { problem: `先頭 ${String(sha).slice(0, 7)} をマージのコミットとする PR が ${hit.length} 件ある(${hit.map((p) => `#${p.number}`).join('、')})。1件に定まらない` };
  return { pr: hit[0] };
}

const recordOf = (p) => ({ number: p.number, authorLogin: p.user?.login ?? null, authorId: p.user?.id ?? null, headSha: p.head?.sha ?? null, body: p.body ?? '', baseRef: p.base?.ref ?? null });

/** 環境から PR の記録とレビューを作る。gh は差し替えられる(試験) */
export function buildContext(env = process.env, gh = defaultGh) {
  const out = (route, pr, reviews, problem) => ({ route, pr, reviews, problem });
  const event = env.EVENT_NAME;
  const repo = env.REPO;
  if (event === 'pull_request') {
    const number = Number(env.PR_NUMBER);
    if (!Number.isInteger(number) || number <= 0 || !env.PR_HEAD_SHA) return out('pull_request', null, null, 'PR の番号か先頭のコミットが渡されない');
    const pr = { number, authorLogin: env.PR_AUTHOR || null, authorId: env.PR_AUTHOR_ID ? Number(env.PR_AUTHOR_ID) : null, headSha: env.PR_HEAD_SHA, body: env.PR_BODY ?? '', baseRef: env.PR_BASE_REF || null };
    const reviews = repo ? fetchReviews(repo, number, gh) : null;
    return out('pull_request', pr, reviews, reviews === null ? 'PR のレビューを取得できない' : null);
  }
  if (event === 'push') {
    if (!repo) return out('push', null, null, 'リポジトリの名が渡されない');
    const raw = gh(['api', `repos/${repo}/commits/${env.SHA}/pulls`, '--paginate']);
    // --paginate は配列を連結して出す(][ の継ぎ目)。1ページ分は JSON 配列そのものとして読む
    const listed = raw === null ? undefined : parseJson(raw.replace(/\]\s*\[/g, ','));
    const first = pickMergedPr(listed, { sha: env.SHA, defaultBranch: env.DEFAULT_BRANCH });
    if (first.problem) return out('push', null, null, first.problem);
    // 一覧の記録は merged の欄を持たないことがある。PR 1件の記録で merged を確かめ直す
    const one = parseJson(gh(['api', `repos/${repo}/pulls/${first.pr.number}`]) ?? '');
    const again = pickMergedPr(one ? [one] : null, { sha: env.SHA, defaultBranch: env.DEFAULT_BRANCH });
    if (again.problem) return out('push', null, null, `PR #${first.pr.number} の記録を確かめ直せない: ${again.problem}`);
    const pr = recordOf(again.pr);
    const reviews = fetchReviews(repo, pr.number, gh);
    return out('push', pr, reviews, reviews === null ? `PR #${pr.number} のレビューを取得できない` : null);
  }
  return out(event ?? null, null, null, `この起動の経路(${event ?? '不明'})では PR の記録を取得しない`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const outPath = i >= 0 ? process.argv[i + 1] : null;
  if (!outPath) {
    console.error('使い方: node scripts/gate/mutation-pr-context.mjs --out <所在>');
    process.exit(2);
  }
  let ctx;
  try {
    ctx = buildContext();
  } catch (e) {
    ctx = { route: process.env.EVENT_NAME ?? null, pr: null, reviews: null, problem: `PR の記録の取得で例外: ${e.message}` };
  }
  fs.writeFileSync(outPath, JSON.stringify(ctx));
  console.log(ctx.problem ? `PR の記録: 取得できなかった(${ctx.problem})。段 mutation は閾値割れを台帳の行で受けません` : `PR の記録: #${ctx.pr.number} とレビュー ${ctx.reviews.length} 件を取得した(経路 ${ctx.route})`);
}
