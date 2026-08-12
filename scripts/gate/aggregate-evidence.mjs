// 出荷判定(G-7)の証跡を集約する。
//
//   node scripts/gate/aggregate-evidence.mjs --from v1.3.0 --to v1.4.0
//
// 出力: evidence/evidence.json(機械可読)と evidence/quality-report.md(人が読む)
//
// G-7 は再テスト・再レビューを行いません。**記録と基準の突合**に限ります。
// したがってここで集めるのは「実施した記録」であって、品質の再判定ではありません。
// 記録が欠けていれば gaps へ入れ、ジョブを失敗させます。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, fail, notice, warn } from './config.mjs';

const config = loadConfig();

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function gh(args) {
  try {
    return JSON.parse(execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8' }));
  } catch {
    return null;
  }
}

const to = arg('--to', git(['describe', '--tags', '--abbrev=0']) || 'HEAD');
const from = arg('--from', git(['describe', '--tags', '--abbrev=0', `${to}^`]) || '');

const range = from ? `${from}..${to}` : to;
const commits = git(['log', '--format=%H%x09%s', range]).split('\n').filter(Boolean);

// --- PR とゲート判定記録 --------------------------------------------------

const prNumbers = new Set();
for (const c of commits) {
  const m = c.match(/\(#(\d+)\)/);
  if (m) prNumbers.add(Number(m[1]));
}

const repo = process.env.GITHUB_REPOSITORY ?? '';
const prs = [];
for (const n of prNumbers) {
  const d = repo
    ? gh(['pr', 'view', String(n), '--repo', repo, '--json', 'number,title,reviews,statusCheckRollup,body'])
    : null;
  const approved = (d?.reviews ?? []).filter((r) => r.state === 'APPROVED');
  const g5 = (d?.statusCheckRollup ?? []).find((s) => s.name === 'gate-g5' || s.context === 'gate-g5');
  const summaryPresent = /##\s*検証方法と結果/.test(d?.body ?? '') && !/検証方法と結果\s*\n\s*$/.test(d?.body ?? '');
  prs.push({
    number: n,
    title: d?.title ?? null,
    g5: g5 ? (g5.conclusion ?? g5.state ?? 'unknown').toLowerCase() : 'unknown',
    g6: {
      approver: approved[0]?.author?.login ?? null,
      approvals: approved.length,
      summaryPresent,
    },
  });
}

// --- 成果物の記録 ----------------------------------------------------------

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}
function listDir(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => f.endsWith('.md')) : [];
}

const gateRecords = listDir('docs/gates');
const adrs = listDir('context/decisions');
const debtFile = 'docs/debt-ledger.md';
const handoverFile = 'docs/handover.md';

const coverage = exists('evidence/coverage-result.json')
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/coverage-result.json'), 'utf8'))
  : { measured: false, reason: '集計ファイルがありません' };

const depDiff = exists('evidence/dependency-diff.json')
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/dependency-diff.json'), 'utf8'))
  : null;

const licenseScan = exists('evidence/license-scan.json')
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/license-scan.json'), 'utf8'))
  : { scanRun: false };

// --- 突合と gaps -----------------------------------------------------------

const gaps = [];

if (config.gates.g6?.state === 'required') {
  for (const p of prs) {
    if (!p.g6.approvals) gaps.push(`PR #${p.number}: 独立レビューの承認記録がありません`);
    if (!p.g6.summaryPresent) gaps.push(`PR #${p.number}: 検証方法と結果の記入がありません`);
  }
}
for (const p of prs) {
  if (p.g5 !== 'success' && p.g5 !== 'unknown') gaps.push(`PR #${p.number}: gate-g5 が ${p.g5} です`);
}
if (config.gates.g7?.state !== 'omitted') {
  if (!exists(handoverFile)) gaps.push('運用引き継ぎ文書(docs/handover.md)がありません');
  if (!exists(debtFile)) gaps.push('技術負債台帳(docs/debt-ledger.md)がありません');
  if (!gateRecords.length) gaps.push('ゲート判定記録(docs/gates/)が1件もありません');
}
if (!licenseScan.scanRun) {
  gaps.push('知財潔白性の検査記録がありません。判定するのは検査を実施し記録したことです');
}

// --- 未達(隠す経路を持たない) --------------------------------------------

const unmet = (config.unmet ?? []).map((u) => ({
  gate: u.gate,
  label: u.label ?? u.gate,
  reason: u.reason,
  compensation: u.compensation ?? [],
  reviewSourcing: u.reviewSourcing ?? null,
}));

// --- 代償措置つきの逸脱(未達と区別して載せる) ------------------------------

const deviations = (config.deviations ?? []).map((d) => ({
  gate: d.gate,
  label: d.label ?? d.gate,
  rule: d.rule ?? null,
  reason: d.reason,
  compensation: d.compensation ?? [],
  resolveWhen: d.resolveWhen ?? null,
}));

const evidence = {
  range: { from: from || null, to },
  generatedAt: new Date().toISOString(),
  profile: {
    projectId: config.projectId,
    answers: config.answers ?? null,
    gates: Object.fromEntries(Object.entries(config.gates).map(([k, g]) => [k, g.state])),
  },
  prs,
  commits: commits.length,
  tests: { coverage },
  dependencies: depDiff ? { manifestsChanged: depDiff.manifestsChanged } : null,
  debt: { ledgerPresent: exists(debtFile) },
  handover: { updated: exists(handoverFile) },
  gateRecords,
  adrs,
  ipClearance: licenseScan,
  unmet,
  deviations,
  gaps,
};

fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evidence/evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');

// --- 人が読むレポート ------------------------------------------------------

const R = [];
R.push(`# 品質レポート ${range}`);
R.push('');
R.push(`生成: ${evidence.generatedAt}`);
R.push('');

if (unmet.length) {
  R.push('## 未達のゲート');
  R.push('');
  R.push('**目的を達成する構成を示せていないゲートがあります。省略ではありません。**');
  R.push('');
  R.push('| ゲート | 理由 | 代償措置 | 外部レビューの調達先 |');
  R.push('| --- | --- | --- | --- |');
  for (const u of unmet) {
    R.push(`| ${u.label} | ${u.reason} | ${u.compensation.join(' / ') || '—'} | ${u.reviewSourcing ?? '**未記入**'} |`);
  }
  R.push('');
}

if (deviations.length) {
  R.push('## 代償措置つきの逸脱');
  R.push('');
  R.push('**実施したうえで、標準が要求する属性を欠いているゲートがあります。未達ではありません。**');
  R.push('');
  R.push('| ゲート | 抵触する規則 | 欠けるもの | 代償措置 | 解消の時点 |');
  R.push('| --- | --- | --- | --- | --- |');
  for (const d of deviations) {
    R.push(
      `| ${d.label} | ${d.rule ?? '—'} | ${d.reason} | ${d.compensation.join(' / ') || '**なし**'} | ${d.resolveWhen ?? '**未記入**'} |`
    );
  }
  R.push('');
}

R.push('## ゲートの構成');
R.push('');
R.push('| ゲート | 状態 |');
R.push('| --- | --- |');
for (const [k, g] of Object.entries(config.gates)) R.push(`| ${g.label} | ${g.state} |`);
R.push('');

R.push('## 変更単位');
R.push('');
R.push(`- コミット: ${commits.length} 件`);
R.push(`- PR: ${prs.length} 件`);
R.push('');
if (prs.length) {
  R.push('| PR | G-5 | G-6 承認 | 検証結果の記入 |');
  R.push('| --- | --- | --- | --- |');
  for (const p of prs) {
    R.push(`| #${p.number} | ${p.g5} | ${p.g6.approvals} | ${p.g6.summaryPresent ? 'あり' : '**なし**'} |`);
  }
  R.push('');
}

R.push('## 記録');
R.push('');
R.push(`- カバレッジ: ${coverage.measured ? `${coverage.pct}%(下限 ${coverage.threshold}%)` : `未測定(${coverage.reason})`}`);
R.push(`- ゲート判定記録: ${gateRecords.length} 件`);
R.push(`- 判断記録(ADR): ${adrs.length} 件`);
R.push(`- 技術負債台帳: ${exists(debtFile) ? 'あり' : '**なし**'}`);
R.push(`- 運用引き継ぎ文書: ${exists(handoverFile) ? 'あり' : '**なし**'}`);
R.push(`- 知財潔白性の検査: ${licenseScan.scanRun ? '実施' : '**未実施**'}`);
R.push('');

if (gaps.length) {
  R.push('## 欠落');
  R.push('');
  for (const g of gaps) R.push(`- ${g}`);
  R.push('');
}

R.push('---');
R.push('');
R.push('このレポートは記録の突合です。品質の再判定ではありません。');
R.push('出荷判定者は数値の十分性を判定しません。閾値の充足は G-5 が機械で判定済みです。');

fs.writeFileSync(path.join(ROOT, 'evidence/quality-report.md'), R.join('\n') + '\n', 'utf8');

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, R.join('\n') + '\n');
}

console.log(`evidence/evidence.json と evidence/quality-report.md を出力しました(${range})`);

for (const u of unmet) warn(`未達: ${u.label} — ${u.reason}`);
for (const g of gaps) fail(g);

if (gaps.length) {
  console.log('');
  console.log(`記録の欠落が ${gaps.length} 件あります。出荷判定(G-7)は通過できません`);
  process.exit(1);
}
notice('記録は完備しています');
