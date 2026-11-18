// 滞留期間の観測と通知(IMPL-0283。束 B18 裁定 §3.8。process-compass #443)。
//
// 開いた作業単位(Issue)ごとに、着手した時点からの経過を測る。閉じた作業単位の実測サイクルタイムの85パーセンタイル
// (観測の窓の中。標本が足りなければ「算定できない」として通知しない)を超えたら、作業単位の Issue へ
// 担当者と価値責任者(席 → 名簿 → login)を記名したコメントを1回だけ出す。他の席のラベルを遷移させない。
//
// 着手した時点は、このテンプレートの定義である(ADR-0173): 作業単位を指す最初の PR が開かれた時点。無ければ、受信箱のラベル
// state:in-progress を最初に付けた時点。PR は同じリポジトリのものに限り、PR の作成と Issue の作成の遅い方を取る(Issue より前には遡らない)。
// 「指す」は、タイムラインの cross-referenced(言及)で近似している。言及しただけの PR も数えるため、近似である。
// 企画書の G-1 で合意した値は、様式に欄が無いため使わない(欄を足すときに追う)。
// 観測の窓は、単位8(next.mjs)と同じ読み方(config の observationWindow。月数)で、完了した作業単位の判定も next.mjs の isCompletedUnit を使う
// (完了の理由で閉じ、closes で結び付いた PR が既定ブランチへ取り込まれている)。最小の標本数だけが、このテンプレートの既定値(暫定)である。
// 合否を持たない。通知は GitHub の上のコメントまで。時計を読まない(now は引数)。差は UTC のミリ秒で測るため、TZ に依らない。
//
// 使い方: node scripts/gate/flow-observation.mjs [--dry-run] [--now ISO] [--min-sample 10]
//   環境変数: GITHUB_REPOSITORY, GH_TOKEN

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, observationWindowAt, OBSERVATION_WINDOW_DEFAULT } from './config.mjs';
import { seatLogin, ghCli, postComment, json as parse, isBotComment } from './review-queue.mjs';
import { isCompletedUnit } from './next.mjs';

export const MARKER = 'pit-in:flow-observation';
/** 最小の標本数。標準に値が無く、実証もない暫定の既定値(IMPL-0283 の note に開示)。採用者が --min-sample で変える */
export const DEFAULT_MIN_SAMPLE = 10;
export const IN_PROGRESS_LABEL = 'state:in-progress';
const DAY_MS = 86400000;

/** 昇順の配列の p 分位(最近順位法。p は 0〜1)。空なら null */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** now から months か月前の時刻(ms)。UTC の暦で求める */
export function monthsBeforeMs(now, months) {
  const d = new Date(Date.parse(now));
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

/** Issue のタイムラインの事象から、着手した時点(ISO)を求める。無ければ null。repo を渡すと、他のリポジトリの PR は数えない。issueCreatedAt を渡すと、それより前には遡らない */
export function startOf(timeline, { repo = null, issueCreatedAt = null } = {}) {
  const prs = [];
  const labeled = [];
  for (const e of timeline ?? []) {
    if (e.event === 'cross-referenced' && e.source?.issue?.pull_request && e.source.issue.created_at) {
      const from = e.source.issue.repository?.full_name;
      if (repo && from && from.toLowerCase() !== repo.toLowerCase()) continue;
      const created = Date.parse(e.source.issue.created_at);
      const floor = Date.parse(issueCreatedAt);
      prs.push(Number.isFinite(floor) && floor > created ? issueCreatedAt : e.source.issue.created_at);
    }
    if (e.event === 'labeled' && e.label?.name === IN_PROGRESS_LABEL && e.created_at) labeled.push(e.created_at);
  }
  const first = (a) => a.filter((t) => Number.isFinite(Date.parse(t))).sort((x, y) => Date.parse(x) - Date.parse(y))[0] ?? null;
  return first(prs) ?? first(labeled);
}

/**
 * 通知を決める(純関数)。
 * open: [{ number, startAt, assignees[], comments:[{body}] }]  closed: [{ number, startAt, closedAt }](完了の理由で閉じたもの)
 */
export function flowActions({ open, closed, now, config, minSample = DEFAULT_MIN_SAMPLE, windowMonths = OBSERVATION_WINDOW_DEFAULT }) {
  const nowMs = Date.parse(now);
  const notes = [];
  const durations = closed
    .filter((c) => Date.parse(c.closedAt) >= monthsBeforeMs(now, windowMonths))
    .map((c) => Date.parse(c.closedAt) - Date.parse(c.startAt))
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  const thresholdMs = durations.length >= minSample ? percentile(durations, 0.85) : null;
  if (thresholdMs === null) {
    notes.push(`算定できない: 観測の窓(${windowMonths} か月)の完了した作業単位が ${durations.length} 件(最小 ${minSample} 件)。通知しない`);
    return { thresholdMs, n: durations.length, actions: [], notes };
  }
  const owner = seatLogin(config, 'value-owner');
  if (!owner.login) notes.push(`価値責任者のログイン名を解決できない(${owner.why})。担当者だけを記名する`);
  const actions = [];
  for (const u of open) {
    if (!u.startAt || !Number.isFinite(Date.parse(u.startAt))) continue;
    const key = `<!-- ${MARKER} issue=${u.number} -->`;
    if ((u.comments ?? []).some((c) => isBotComment(c) && typeof c.body === 'string' && c.body.includes(key))) continue;
    const elapsed = nowMs - Date.parse(u.startAt);
    if (elapsed <= thresholdMs) continue;
    const who = [...(u.assignees ?? []), owner.login].filter(Boolean).map((l) => `@${l}`);
    const days = (ms) => (Math.round((ms / DAY_MS) * 10) / 10).toString();
    actions.push({
      issue: u.number,
      body: `${key}\n${who.join(' ')} この作業単位は、着手(${u.startAt})から ${days(elapsed)} 日が経ち、観測の窓(${windowMonths} か月)に完了した ${durations.length} 件の実測サイクルタイムの85パーセンタイル(${days(thresholdMs)} 日)を超えました。滞留していないか確かめてください。このコメントは1回だけ出します。ラベルは変えません。`,
    });
  }
  return { thresholdMs, n: durations.length, actions, notes };
}

/** GitHub から作業単位を読む。gh は差し替えられる。閉じた作業単位は窓の中の最新 maxClosed 件まで(超えたら truncated)。完了の判定は next.mjs の isCompletedUnit */
export function fetchUnits(gh, repo, { now, windowMonths = OBSERVATION_WINDOW_DEFAULT, maxClosed = 100 }) {
  const sinceDay = new Date(monthsBeforeMs(now, windowMonths)).toISOString().slice(0, 10);
  const isIssue = (i) => !i.pull_request;
  const openRaw = parse(gh, [`repos/${repo}/issues?state=open&per_page=100`]).filter(isIssue);
  const base = parse(gh, [`repos/${repo}`])[0]?.default_branch ?? 'main';
  const q = 'query($q:String!){search(query:$q,type:ISSUE,first:100){pageInfo{hasNextPage}nodes{...on Issue{number createdAt closedAt stateReason closedByPullRequestsReferences(first:5,includeClosedPrs:true){nodes{merged baseRefName}}}}}}';
  const res = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`, '-f', `q=repo:${repo} is:issue is:closed closed:>=${sinceDay} sort:updated-desc`])).data.search;
  const closedRaw = res.nodes.filter((n) => n?.number && isCompletedUnit({ stateReason: n.stateReason, prs: n.closedByPullRequestsReferences?.nodes ?? [], base })).slice(0, maxClosed);
  const timeline = (n) => parse(gh, [`repos/${repo}/issues/${n}/timeline?per_page=100`]);
  const open = openRaw.map((i) => ({
    number: i.number,
    startAt: startOf(timeline(i.number), { repo, issueCreatedAt: i.created_at }),
    assignees: (i.assignees ?? []).map((a) => a.login),
    comments: parse(gh, [`repos/${repo}/issues/${i.number}/comments?per_page=100`]).map((c) => ({ body: c.body, login: c.user?.login ?? '' })),
  }));
  const closed = closedRaw.map((i) => ({ number: i.number, startAt: startOf(timeline(i.number), { repo, issueCreatedAt: i.createdAt }), closedAt: i.closedAt })).filter((c) => c.startAt);
  return { open, closed, truncated: Boolean(res.pageInfo?.hasNextPage) };
}

function main(argv) {
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('GITHUB_REPOSITORY が未設定です');
    process.exit(2);
  }
  const dry = argv.includes('--dry-run');
  const now = opt('--now') ?? new Date().toISOString();
  const config = loadConfig();
  const windowMonths = observationWindowAt(config, now.slice(0, 10));
  const minSample = opt('--min-sample') ? Number(opt('--min-sample')) : DEFAULT_MIN_SAMPLE;
  const { open, closed, truncated } = fetchUnits(ghCli, repo, { now, windowMonths });
  const r = flowActions({ open, closed, now, config, minSample, windowMonths });
  if (truncated) console.log('注意: 窓の中の閉じた作業単位が最初の 100 件を超えた。読んだ範囲だけで算定した');
  for (const n of r.notes) console.log(`注意: ${n}`);
  for (const a of r.actions) {
    console.log(`Issue #${a.issue}: 滞留の通知${dry ? '(dry-run)' : ''}`);
    if (!dry) postComment(ghCli, repo, a.issue, a.body);
  }
  console.log(`通知 ${r.actions.length} 件。着手の時点はテンプレートの定義(ADR-0173)。実物の GitHub では確かめていない(束 B18 単位10)。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
