// 判定記録の記述の内容の四半期ごとの抽出(標準 第5章 5.7.4「四半期の抽出の要求事項」。process-compass #359 / IMPL-0174)
//
//   node scripts/gate/content-sampling.mjs --quarter 2026Q4 [--count <N>] [--seed <照合する種>] [--today YYYY-MM-DD]
//   node scripts/gate/content-sampling.mjs --verify 2026Q4
//
// 母集団は、その四半期に作成した判定記録の人が書く欄を持つ記録(様式: 基底ブランチの docs/gates/ と記録用ブランチの records/gates/、
// 承認レビューの写し: 記録用ブランチの records/reviews/ の本文のあるレビュー)。
// 種は実行者が選べない値から導く: 四半期の識別と、四半期の締めの時点の母集団の記録の識別子の一覧(並べ替えたもの)のハッシュ。
// 四半期が締まる前は抽出しない。--seed は照合の用途に限り、導いた種と違えば拒否する(標準 要求事項2。当事者に抽出を選ばせない)。
// 件数は5件(母集団が5件以下なら全件)。前の四半期の記録に所見があれば10件。--count は増やす向きだけ受け付ける。
// docs/content-sampling/<四半期>.md を templates/content-sampling.md から起こし、種・母集団の一覧・抽出した記録を書く。
// 抽出の記録は1回だけコミットする。履歴(git log)にその四半期の記録が既にあれば、起こし直さない(消した後も同じ)。
// --verify は、記録が1回のコミットで入ったこと、種が母集団から導いたものと一致すること、抽出が種と件数から再現できること、
// 母集団の一覧がいまの母集団と一致すること、確かめた者と所見が記入されていることを確かめる。
// 確かめた者・所見は人が書く(AI が書かない)。件数の値は外部の目安だけに依る(標準の EV-0249)。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, readGateRecords } from './config.mjs';
import { readRecordsBranch, recordFromForm } from './records.mjs';

export const BASE_COUNT = 5;
export const RECORD_DIR = 'docs/content-sampling';
/** 規定(四半期の抽出の要求事項)を準拠テンプレートが運び始めた四半期。これより前の四半期には遡って抽出を求めない */
export const EFFECTIVE_QUARTER = '2026Q4';

/** 'YYYY-MM-DD…' の日付が属する四半期('2026Q4') */
export function quarterOf(day) {
  const m = String(day ?? '').match(/(\d{4})-(\d{2})-\d{2}/);
  return m ? `${m[1]}Q${Math.floor((Number(m[2]) - 1) / 3) + 1}` : null;
}
/** 直前の四半期 */
export function prevQuarter(q) {
  const m = String(q).match(/^(\d{4})Q([1-4])$/);
  if (!m) return null;
  const y = Number(m[1]);
  const n = Number(m[2]);
  return n === 1 ? `${y - 1}Q4` : `${y}Q${n - 1}`;
}
/** 四半期の比較('2026Q3' < '2026Q4') */
export const quarterLess = (a, b) => String(a) < String(b);
/** 四半期の末日('2026-12-31') */
export function quarterEnd(q) {
  const m = String(q).match(/^(\d{4})Q([1-4])$/);
  if (!m) return null;
  const last = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' }[m[2]];
  return `${m[1]}-${last}`;
}

/**
 * 母集団の記録 [{ id, quarter }]。gateRecords は { file, judgedAt }、reviews は Map<PR 番号, 写し>
 */
export function population({ gateRecords = [], reviews = new Map() } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of gateRecords) {
    const name = String(r.file ?? '').split('/').pop();
    if (seen.has(name)) continue; // 出荷の PR で複製した同じ様式は1件に数える
    seen.add(name);
    out.push({ id: name, quarter: quarterOf(r.judgedAt) });
  }
  for (const [pr, copy] of reviews) {
    for (const rv of copy?.reviews ?? []) {
      if (!String(rv?.body ?? '').trim()) continue;
      out.push({ id: `PR #${pr} review ${rv.id}`, quarter: quarterOf(rv.submitted_at) });
    }
  }
  return out;
}

/** 種を導く(四半期の識別と、母集団の識別子の一覧の並べ替えたもののハッシュ)。実行者は選べない */
export function deriveSeed(q, ids) {
  return crypto.createHash('sha256').update(`${q}\n${[...ids].sort().join('\n')}`).digest('hex');
}

/** 種による無作為の抽出(種と記録の識別子のハッシュで並べ、先頭から count 件)。同じ種と母集団なら同じ結果になる */
export function sample(items, seed, count) {
  const keyed = items.map((it) => ({ it, k: crypto.createHash('sha256').update(`${seed}\u0000${it.id}`).digest('hex') }));
  keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return keyed.slice(0, Math.min(count, keyed.length)).map((x) => x.it);
}

/** 見出しに key を持つ表の行(見出しの次から、表が途切れるまで)を、セルの配列で返す */
function tableRows(text, key) {
  const lines = String(text ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^\|/.test(l) && l.split('|').map((c) => c.trim()).includes(key));
  if (at < 0) return { head: [], rows: [] };
  const head = lines[at].split('|').map((c) => c.trim());
  const rows = [];
  for (const l of lines.slice(at + 1)) {
    if (!/^\|/.test(l)) break;
    if (!/^\|\s*[-:]+\s*\|/.test(l)) rows.push(l.split('|').map((c) => c.trim()));
  }
  return { head, rows };
}
const filledCell = (v) => Boolean(v) && !/^(—|-)$/.test(v) && !v.startsWith('<');

/** 記録の「所見」の欄に、なし以外の記載がある行があるか */
export function hadFindings(text) {
  const { head, rows } = tableRows(text, '所見');
  const col = head.indexOf('所見');
  if (col < 0) return false;
  return rows.some((r) => {
    const v = r[col] ?? '';
    return filledCell(v) && !/^(なし|無し)$/.test(v);
  });
}

/** 件数(前の四半期の記録に所見があれば倍)。requested は増やす向きだけ受け付ける */
export function sampleCount({ prevText = null, requested = null } = {}) {
  const base = hadFindings(prevText) ? BASE_COUNT * 2 : BASE_COUNT;
  if (requested === null || requested === undefined) return { count: base, problem: null };
  if (!Number.isInteger(requested) || requested < base) return { count: base, problem: `--count ${requested} は ${base} 件を下回る。件数は増やしてよく、減らさない(標準 第5章 5.7.4)` };
  return { count: requested, problem: null };
}

/** 記録から、種・母集団の一覧・抽出した記録・確かめた者・所見を読む */
export function parseRecord(text) {
  const seed = (String(text ?? '').match(/^\| 種 \| ([^|]*) \|/m)?.[1] ?? '').trim();
  const popRows = tableRows(text, '母集団の記録');
  const pc = popRows.head.indexOf('母集団の記録');
  const populationIds = pc < 0 ? [] : popRows.rows.map((r) => r[pc]).filter((v) => v && v !== '—');
  const pick = tableRows(text, '抽出した記録');
  const ic = pick.head.indexOf('抽出した記録');
  const wc = pick.head.indexOf('確かめた者');
  const fc = pick.head.indexOf('所見');
  const picked = ic < 0 ? [] : pick.rows.filter((r) => r[ic] && r[ic] !== '—' && !/^母集団が0件/.test(r[ic])).map((r) => ({ id: r[ic], who: r[wc] ?? '', finding: r[fc] ?? '' }));
  return { seed, populationIds, picked };
}

/** 記録を足した・変えたコミット(古い順)。リポジトリでなければ null */
export function recordCommits(root, rel) {
  try {
    const out = execFileSync('git', ['log', '--format=%H', '--', rel], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * 記録の検証。problems が空なら、抽出を済ませたものとして数える
 * @param {{ text: string, quarter: string, items: Array<{id: string, quarter: string}>, commits: string[]|null, prevText?: string|null }} a
 */
export function verifyRecord({ text, quarter, items, commits, prevText = null }) {
  const problems = [];
  if (commits === null) problems.push('履歴を読めない(git log が失敗)。1回のコミットで入ったかを確かめられない');
  else if (commits.length === 0) problems.push('記録がコミットされていない。確かめた者と所見を書いてから、1回のコミットで入れる');
  else if (commits.length > 1) problems.push(`記録が ${commits.length} 回のコミットで変わっている。抽出の記録は1回だけコミットする(起こし直し・書き換えをしない)`);
  const r = parseRecord(text);
  const derived = deriveSeed(quarter, r.populationIds);
  if (r.seed !== derived) problems.push('種が、記録の母集団の一覧から導いた種と一致しない(種を選び直した記録は受け付けない)');
  const now = new Set(items.filter((i) => i.quarter === quarter).map((i) => i.id));
  const listed = new Set(r.populationIds);
  const missing = [...now].filter((id) => !listed.has(id));
  const extra = [...listed].filter((id) => !now.has(id));
  if (missing.length || extra.length) problems.push(`母集団の一覧が、いまの ${quarter} の判定記録と一致しない(一覧に無い記録 ${missing.length} 件・いまは無い記録 ${extra.length} 件)`);
  const { count } = sampleCount({ prevText });
  const expected = sample(r.populationIds.map((id) => ({ id })), r.seed, count).map((x) => x.id);
  const got = r.picked.map((p) => p.id);
  if (JSON.stringify(expected) !== JSON.stringify(got)) problems.push(`抽出した記録が、種と件数(${count} 件)から再現した抽出と一致しない`);
  const blank = r.picked.filter((p) => !filledCell(p.who) || !filledCell(p.finding));
  if (blank.length) problems.push(`確かめた者か所見の記入が無い行が ${blank.length} 件ある(記入の無い記録は、抽出を済ませたことに数えない)`);
  return problems;
}

/**
 * /pit の注記。直前の四半期に母集団があり、その四半期の抽出の記録が無いか、検証を通らなければ文を返す(無ければ null)。
 * 規定を運び始めた四半期(EFFECTIVE_QUARTER)と、案件の開始の四半期(startQuarter)より前には、遡って出さない
 */
export function samplingOverdueNote({ root = ROOT, today, items, startQuarter = null, commitsOf = recordCommits }) {
  const prev = prevQuarter(quarterOf(today));
  if (!prev) return null;
  if (quarterLess(prev, EFFECTIVE_QUARTER)) return null;
  if (startQuarter && quarterLess(prev, startQuarter)) return null;
  const n = items.filter((i) => i.quarter === prev).length;
  if (!n) return null;
  const rel = `${RECORD_DIR}/${prev}.md`;
  const file = path.join(root, rel);
  const cmd = `\`node scripts/gate/content-sampling.mjs --quarter ${prev}\``;
  if (!fs.existsSync(file)) return `判定記録の記述の内容の四半期の抽出(標準 第5章 5.7.4)が、${prev} について記録されていない(母集団 ${n} 件)。${cmd} で抽出し、判定者以外の人が確かめて所見を書く`;
  const prevPrev = path.join(root, RECORD_DIR, `${prevQuarter(prev)}.md`);
  const problems = verifyRecord({ text: fs.readFileSync(file, 'utf8'), quarter: prev, items, commits: commitsOf(root, rel), prevText: fs.existsSync(prevPrev) ? fs.readFileSync(prevPrev, 'utf8') : null });
  if (!problems.length) return null;
  return `判定記録の記述の内容の四半期の抽出(標準 第5章 5.7.4)の ${prev} の記録が、抽出を済ませたことに数えられない: ${problems.join(' / ')}(\`node scripts/gate/content-sampling.mjs --verify ${prev}\`)`;
}

/** リポジトリから母集団を読む */
export function readPopulation(root = ROOT, { fetch = true } = {}) {
  let branch = { available: false, gates: [], reviews: new Map() };
  try {
    branch = readRecordsBranch({ cwd: root, fetch });
  } catch {
    // 読めなければ基底ブランチだけ
  }
  const forms = [...readGateRecords(), ...(branch.available ? branch.gates.map((g) => recordFromForm(g.text, g.file, 'records-branch')) : [])];
  return { items: population({ gateRecords: forms, reviews: branch.available ? branch.reviews : new Map() }), branchAvailable: branch.available, branchReason: branch.reason ?? null };
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const verifyQ = arg('--verify');
  if (verifyQ) {
    const rel = `${RECORD_DIR}/${verifyQ}.md`;
    if (!fs.existsSync(path.join(ROOT, rel))) {
      console.error(`${rel} がありません`);
      process.exit(1);
    }
    const prevFile = path.join(ROOT, RECORD_DIR, `${prevQuarter(verifyQ)}.md`);
    const problems = verifyRecord({ text: fs.readFileSync(path.join(ROOT, rel), 'utf8'), quarter: verifyQ, items: readPopulation(ROOT).items, commits: recordCommits(ROOT, rel), prevText: fs.existsSync(prevFile) ? fs.readFileSync(prevFile, 'utf8') : null });
    for (const p of problems) console.log(`- ${p}`);
    if (problems.length) {
      console.log(`${rel}: ${problems.length} 件。抽出を済ませたことに数えない`);
      process.exit(1);
    }
    console.log(`${rel}: 種・母集団・抽出・記入を確かめた(記述の中身と、確かめた者が判定者以外であることは確かめない)`);
    process.exit(0);
  }
  const q = arg('--quarter');
  if (!/^\d{4}Q[1-4]$/.test(q ?? '')) {
    console.error('--quarter YYYYQn(例: 2026Q4)か --verify YYYYQn を渡します');
    process.exit(2);
  }
  const today = arg('--today') ?? localToday();
  if (today <= quarterEnd(q)) {
    console.error(`${q} はまだ締まっていない(末日 ${quarterEnd(q)})。四半期の締めの後に、締めの時点の母集団から抽出する`);
    process.exit(1);
  }
  const rel = `${RECORD_DIR}/${q}.md`;
  const out = path.join(ROOT, rel);
  const commits = recordCommits(ROOT, rel);
  if (fs.existsSync(out) || (commits && commits.length)) {
    console.error(`${rel} は既にある(履歴を含む)。抽出の記録は1回だけコミットする。起こし直さない`);
    process.exit(1);
  }
  const prevFile = path.join(ROOT, RECORD_DIR, `${prevQuarter(q)}.md`);
  const req = arg('--count');
  const { count, problem } = sampleCount({ prevText: fs.existsSync(prevFile) ? fs.readFileSync(prevFile, 'utf8') : null, requested: req === null ? null : Number(req) });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const { items, branchAvailable, branchReason } = readPopulation(ROOT);
  const pop = items.filter((i) => i.quarter === q);
  const seed = deriveSeed(q, pop.map((p) => p.id));
  const given = arg('--seed');
  if (given !== null && given !== seed) {
    console.error(`--seed は照合の用途に限る。渡した種は、${q} の母集団から導いた種(${seed})と一致しない。種を選ばない(標準 第5章 5.7.4 要求事項2)`);
    process.exit(1);
  }
  const picked = sample(pop, seed, count);
  const form = fs.readFileSync(path.join(ROOT, 'templates/content-sampling.md'), 'utf8');
  const rows = picked.map((p, i) => `| ${i + 1} | ${p.id} | | |`).join('\n');
  const popRows = pop.length ? [...pop].sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => `| ${p.id} |`).join('\n') : '| — |';
  const text = form
    .replaceAll('<四半期>', q)
    .replace('<種>', seed)
    .replace('<母集団の件数>', String(pop.length))
    .replace('<件数>', String(picked.length))
    .replace('<記録用ブランチ>', branchAvailable ? '読んだ' : `読めない(${branchReason ?? '理由不明'}。基底ブランチの docs/gates/ だけを母集団にした)`)
    .replace(/^\| 1 \| <抽出した記録> \| \| \|$/m, rows || '| — | 母集団が0件 | | |')
    .replace(/^\| <母集団の記録> \|$/m, popRows);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`${rel} を起こしました(母集団 ${pop.length} 件から ${picked.length} 件。種 ${seed})。判定者以外の人が確かめ、確かめた者と所見を書いてから、1回のコミットで入れます`);
}
