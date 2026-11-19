// 強制層の検査の棚卸しの入力を一覧に出す(標準 第3章 3.11.4 要求事項4。IMPL-0145。process-compass #326)。
//
// 出すのは入力の一覧だけである。解釈と、廃止の候補の選定は人(AI維持管理者)が四半期の棚卸しで行う。
//   (i)  欠陥の台帳(docs/defect-ledger.md)の節「是正の記録」のうち、四半期の窓の中の日付で、対象が検査装置
//        (scripts/gate/・.github/workflows/ のパス、または実行の記録にあるワークフロー・ジョブの名)を含む行
//   (ii) GitHub Actions の実行の記録から、ワークフロー・ジョブごとの失敗の回数と最後の失敗の日
// 合否に使わない。削除の候補を機械が選ばない。読み出せないとき(権限)は「読めない」と出し、0 件と読み違えさせない。
// 一覧の上限(1,000 件)に達した・総数より少ない場合は「一部しか読めていない」と出し、記録が欠けた可能性(最も古い実行が窓の始まりより後。実行が無かったか、実行の記録が保持期間または手で削除されたかは区別しない)も出す。数を確定の値にしない。
// 失敗した実行だけを詳しく読む(ジョブごとの失敗は、失敗した実行のジョブの記録から数える)。窓は UTC の暦で、時計は読まない(--now を渡さない)。
//
// 使い方: node scripts/gate/enforcement-inventory.mjs --quarter 2026Q4 [--repo owner/name]
//   環境変数: GITHUB_REPOSITORY, GH_TOKEN(Actions の読み取り権限)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './config.mjs';
import { ghCli, json } from './review-queue.mjs';

export const DEFECT_FILE = 'docs/defect-ledger.md';
export const CORRECTION_HEADING = '是正の記録';
/** 検査装置のパス(対象の欄にこの語があれば、検査装置を対象とする行とみなす) */
/** GitHub の REST API が絞り込みつきの実行の一覧で返す上限 */
export const RUNS_API_CAP = 1000;
export const DEVICE_PATHS =['scripts/gate/', '.github/workflows/'];

/** 四半期 'YYYYQn' の始まりと終わり(UTC の暦の日)。読めなければ null */
export function quarterWindow(q) {
  const m = /^(\d{4})Q([1-4])$/.exec(String(q ?? ''));
  if (!m) return null;
  const first = { 1: '01-01', 2: '04-01', 3: '07-01', 4: '10-01' }[m[2]];
  const last = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' }[m[2]];
  return { quarter: q, from: `${m[1]}-${first}`, to: `${m[1]}-${last}` };
}

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const dayIn = (text) => {
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(text ?? '').normalize('NFKC'));
  if (!m) return null;
  const day = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day ? day : null;
};

/** 欠陥の台帳の節「是正の記録」の行を読む(表の見出しの欄名で。空の雛形の行は除く)。{ date, day, target, cells, line }[] */
export function parseCorrections(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.includes(CORRECTION_HEADING));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
  if (end < 0) end = lines.length;
  let header = null;
  const rows = [];
  for (let i = start + 1; i < end; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) continue;
    const cells = cellsOf(l);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!header) {
      header = cells;
      continue;
    }
    if (cells.every((c) => c === '')) continue;
    const at = (name) => {
      const k = header.findIndex((h) => h.startsWith(name));
      return k >= 0 ? (cells[k] ?? '') : '';
    };
    rows.push({ date: at('日付'), day: dayIn(at('日付')), target: at('対象'), cells, line: i + 1 });
  }
  return rows;
}

/** 対象の欄が検査装置を含むか。パスの語か、実行の記録にあるワークフロー・ジョブの名(names)を含む */
export function isDeviceTarget(target, names = []) {
  const t = String(target ?? '');
  return DEVICE_PATHS.some((p) => t.includes(p)) || names.some((n) => nameIn(t, n));
}

/** 名が語として現れるか(前後が英数字・ハイフン・下線でない)。部分一致で製品の是正の行を検査装置の行に数えない */
export function nameIn(text, name) {
  if (!name) return false;
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_-])${esc}(?![A-Za-z0-9_-])`).test(String(text ?? ''));
}

/** 実行の記録から、ワークフローごと・ジョブごとの失敗の回数と最後の失敗の日を数える(純関数)。runs: { id, name, path, conclusion, created_at }[]、jobsOf(run): { name, conclusion }[] */
export function tally(runs, jobsOf) {
  const workflows = new Map();
  const jobs = new Map();
  let jobsUnread = 0;
  for (const r of runs) {
    const wf = String(r.path ?? '').replace(/@.*$/, '') || r.name || '(名前なし)';
    const w = workflows.get(wf) ?? { workflow: wf, name: r.name ?? '', runs: 0, failures: 0, lastFailure: null };
    w.runs++;
    workflows.set(wf, w);
    if (r.conclusion !== 'failure') continue;
    const day = String(r.created_at ?? '').slice(0, 10);
    w.failures++;
    if (day && (!w.lastFailure || day > w.lastFailure)) w.lastFailure = day;
    const jl = jobsOf(r);
    if (jl === null || jl === undefined) jobsUnread++;
    for (const j of jl ?? []) {
      if (j.conclusion !== 'failure') continue;
      const key = `${wf}\u0000${j.name}`;
      const e = jobs.get(key) ?? { workflow: wf, job: j.name, failures: 0, lastFailure: null };
      e.failures++;
      if (day && (!e.lastFailure || day > e.lastFailure)) e.lastFailure = day;
      jobs.set(key, e);
    }
  }
  const byName = (a, b) => (a.workflow + (a.job ?? '')).localeCompare(b.workflow + (b.job ?? ''));
  return { workflows: [...workflows.values()].sort(byName), jobs: [...jobs.values()].sort(byName), jobsUnread };
}

/** 実行の記録を窓の中(UTC の暦)で読む。読めなければ { error }。gh は差し替えられる */
export function fetchRuns(gh, repo, win) {
  try {
    const pages = json(gh, [`repos/${repo}/actions/runs?created=${win.from}..${win.to}&per_page=100`]);
    const runs = pages.flatMap((p) => (Array.isArray(p?.workflow_runs) ? p.workflow_runs : []));
    const totals = pages.map((p) => p?.total_count).filter((n) => Number.isInteger(n));
    const total = totals.length ? Math.max(...totals) : null;
    return { runs: runs.map((r) => ({ id: r.id, name: r.name, path: r.path, conclusion: r.conclusion, created_at: r.created_at })), total };
  } catch (e) {
    return { error: String(e?.stderr ?? e?.message ?? e).split('\n')[0].slice(0, 200) };
  }
}

/** 失敗した実行のジョブを読む。読めなければ null(そのジョブは数えず、一覧に「読めない」と出す)。gh は差し替えられる */
export function fetchJobs(gh, repo, runId) {
  try {
    return json(gh, [`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]).flatMap((p) => (Array.isArray(p?.jobs) ? p.jobs : [])).map((j) => ({ name: j.name, conclusion: j.conclusion }));
  } catch {
    return null;
  }
}

/** 一覧の本文を作る(純関数)。ledgerText が null なら台帳を読めない。runsResult は { runs } か { error }、jobsOf は tally と同じ */
export function inventory({ window: win, ledgerText, runsResult, jobsOf }) {
  const lines = [];
  const done = tally(runsResult?.runs ?? [], jobsOf ?? (() => []));
  const names = done.jobs.map((j) => j.job).filter(Boolean);
  const corrections = ledgerText === null || ledgerText === undefined ? null : parseCorrections(ledgerText);
  lines.push(`# 強制層の検査の棚卸しの入力(${win.quarter}。${win.from} 〜 ${win.to}、UTC の暦)`, '');
  lines.push('入力の一覧です。解釈と、廃止の候補の選定は、AI維持管理者が四半期の棚卸しで行います。機械は候補を選ばず、合否に使いません(標準 3.11.4 要求事項4)。', '');

  lines.push('## 1. 欠陥の台帳の「是正の記録」のうち、検査装置を対象とする行', '');
  let matched = [];
  if (corrections === null) lines.push(ledgerText === null || ledgerText === undefined ? `読めない: ${DEFECT_FILE} がありません。` : `読めない: ${DEFECT_FILE} に節「${CORRECTION_HEADING}」が見つかりません。`, '');
  else {
    const dev = corrections.filter((r) => isDeviceTarget(r.target, names));
    const inWin = dev.filter((r) => r.day && r.day >= win.from && r.day <= win.to);
    const unreadable = dev.filter((r) => !r.day);
    matched = inWin;
    lines.push(`検査装置を対象とする行: ${dev.length} 件(窓の中 ${inWin.length} 件、日付を読めない ${unreadable.length} 件)。是正の記録の全行は ${corrections.length} 件。`, '');
    if (inWin.length || unreadable.length) {
      lines.push('| 日付 | 台帳の行 | 対象 |', '| --- | --- | --- |');
      for (const r of [...inWin, ...unreadable]) lines.push(`| ${r.day ?? `${r.date || '(空)'}(日付を読めない)`} | ${r.line} 行目 | ${r.target.replace(/\|/g, '/')} |`);
      lines.push('');
    }
  }

  lines.push('## 2. GitHub Actions の実行の失敗(ワークフロー・ジョブごと)', '');
  if (runsResult?.error) lines.push(`読めない: 実行の記録を読み出せませんでした(${runsResult.error})。権限(Actions の読み取り)などの可能性があります。失敗が 0 件という意味ではありません。`, '');
  else if (!done.workflows.length) lines.push('窓の中の実行の記録が 0 件でした(窓の中に実行が無かったか、実行の記録が消えているかを、この出力からは区別できません)。', '');
  else {
    const rl = runsResult.runs;
    const got = rl.length;
    const total = runsResult.total ?? null;
    const capped = got >= RUNS_API_CAP;
    const short = total !== null && total > got;
    if (capped || short) lines.push(`**一部しか読めていません**: 実行の記録の一覧は 1 回の絞り込みで ${RUNS_API_CAP} 件までしか返りません。読めた ${got} 件${total !== null ? `(応答の総数 ${total} 件)` : ''}。以下の失敗・実行の数は確定の値ではなく、少なく出ている可能性があります。`, '');
    const oldest = rl.map((r) => String(r.created_at ?? '').slice(0, 10)).filter(Boolean).sort()[0];
    if (oldest && oldest > win.from) lines.push(`注意: 読めた最も古い実行は ${oldest} で、窓の始まり ${win.from} より後です。90 日はログと成果物の保持期間です。GitHub の文書は 2026-10-01 以降、実行の記録にも保持期間(既定 90 日)を適用すると書いています(保持期間を変えたときは新しい対象にだけ適用し、既存の対象には遡らない、とも書いています。2026-10-01 の適用が既存の実行に及ぶかは、書いていません)。その期間に実行が無かったか、実行の記録が保持期間または手で削除されたかを、この出力からは区別できません。数を確定の値として読まないでください。`, '');
    const rowsOf = (workflowPath, jobName) =>
      matched
        .filter((r) => r.target.includes(workflowPath) || (jobName && nameIn(r.target, jobName)))
        .map((r) => `${r.line} 行目`)
        .join('、') || '—';
    lines.push('| ワークフロー | ジョブ | 失敗 | 実行 | 最後の失敗の日(UTC) | 対応する是正の行 |', '| --- | --- | --- | --- | --- | --- |');
    for (const w of done.workflows) {
      lines.push(`| ${w.workflow} | (全体) | ${w.failures} | ${w.runs} | ${w.lastFailure ?? '—'} | ${rowsOf(w.workflow, null)} |`);
      for (const j of done.jobs.filter((x) => x.workflow === w.workflow)) lines.push(`| ${w.workflow} | ${j.job} | ${j.failures} | — | ${j.lastFailure ?? '—'} | ${rowsOf(w.workflow, j.job)} |`);
    }
    lines.push('');
  }
  lines.push('- ジョブの失敗は、失敗した実行のジョブの記録から数えます。ジョブの記録を読めなかった実行は、ワークフローの失敗にだけ数えます。');
  if (done.jobsUnread > 0) lines.push(`- ジョブの記録を読めなかった失敗した実行: ${done.jobsUnread} 件。ジョブごとの失敗は、この分だけ少なく出ています。`);
  lines.push('- 実行の一覧は各実行の最新の試行の結論だけを持ちます。再実行で成功した失敗(run_attempt が 2 以上)は数えません。');
  lines.push('- 是正の行との対応は、対象の欄にワークフローのパス、またはジョブの名が書かれているかの文字列の一致です。意味は読んでいません。');
  lines.push('- 失敗が多い・少ないことは、検査の要否を示しません。働いていない検査(失敗が一度も無い)かどうかは、人が判断します。', '');
  return lines.join('\n');
}

function main(argv) {
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const win = quarterWindow(opt('--quarter'));
  if (!win) {
    console.error('使い方: node scripts/gate/enforcement-inventory.mjs --quarter YYYYQn [--repo owner/name]');
    process.exit(2);
  }
  const repo = opt('--repo') ?? process.env.GITHUB_REPOSITORY;
  const ledgerPath = path.join(ROOT, DEFECT_FILE);
  const ledgerText = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : null;
  let runsResult = { error: 'リポジトリ(--repo か GITHUB_REPOSITORY)が未指定' };
  let jobsOf = () => [];
  if (repo) {
    runsResult = fetchRuns(ghCli, repo, win);
    const cache = new Map();
    jobsOf = (r) => {
      if (!cache.has(r.id)) cache.set(r.id, fetchJobs(ghCli, repo, r.id));
      return cache.get(r.id);
    };
  }
  console.log(inventory({ window: win, ledgerText, runsResult, jobsOf }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
