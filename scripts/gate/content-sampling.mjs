// 判定記録の記述の内容の四半期ごとの抽出(標準 第5章 5.7.4「四半期の抽出」。process-compass #359 / IMPL-0174)
//
//   node scripts/gate/content-sampling.mjs --quarter 2026Q4 [--seed <文字列>] [--count <N>]
//
// 母集団は、その四半期に作成した判定記録の人が書く欄を持つ記録(様式: 基底ブランチの docs/gates/ と記録用ブランチの records/gates/、
// 承認レビューの写し: 記録用ブランチの records/reviews/ の本文のあるレビュー)。機械が種で無作為に選ぶ(記録の当事者に選ばせない)。
// 件数は5件(母集団が5件以下なら全件)。前の四半期の記録に所見があれば10件。--count は増やす向きだけ受け付ける。
// docs/content-sampling/<四半期>.md を templates/content-sampling.md から起こし、種・母集団の件数・抽出した記録を書く。
// 確かめた者・所見は人が書く(AI が書かない)。同じ四半期の記録があれば上書きせずに止まる。
// 件数の値は外部の目安だけに依る(標準の EV-0251)。5件で見つかるのは広がった形骸化だけで、結果を母集団へ一般化しない。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, readGateRecords } from './config.mjs';
import { readRecordsBranch, recordFromForm } from './records.mjs';

export const BASE_COUNT = 5;
export const RECORD_DIR = 'docs/content-sampling';

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
    out.push({ id: r.file, quarter: quarterOf(r.judgedAt) });
  }
  for (const [pr, copy] of reviews) {
    for (const rv of copy?.reviews ?? []) {
      if (!String(rv?.body ?? '').trim()) continue;
      out.push({ id: `PR #${pr} review ${rv.id}`, quarter: quarterOf(rv.submitted_at) });
    }
  }
  return out;
}

/** 種による無作為の抽出(種と記録の識別子のハッシュで並べ、先頭から count 件)。同じ種と母集団なら同じ結果になる */
export function sample(items, seed, count) {
  const keyed = items.map((it) => ({ it, k: crypto.createHash('sha256').update(`${seed}\u0000${it.id}`).digest('hex') }));
  keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return keyed.slice(0, Math.min(count, keyed.length)).map((x) => x.it);
}

/** 記録の「所見」の欄に、なし以外の記載がある行があるか */
export function hadFindings(text) {
  // 見出しに「所見」を持つ表を探し、その表の行だけを読む(冒頭の項目の表を読まない)
  const lines = String(text ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^\|/.test(l) && l.split('|').map((c) => c.trim()).includes('所見'));
  if (at < 0) return false;
  const col = lines[at].split('|').map((c) => c.trim()).indexOf('所見');
  const rows = [];
  for (const l of lines.slice(at + 1)) {
    if (!/^\|/.test(l)) break;
    if (!/^\|\s*[-:]+\s*\|/.test(l)) rows.push(l);
  }
  return rows.some((l) => {
    const v = (l.split('|')[col] ?? '').trim();
    return v && !/^(なし|無し|—|-)$/.test(v) && !v.startsWith('<');
  });
}

/** 件数(前の四半期の記録に所見があれば倍)。requested は増やす向きだけ受け付ける */
export function sampleCount({ prevText = null, requested = null } = {}) {
  const base = hadFindings(prevText) ? BASE_COUNT * 2 : BASE_COUNT;
  if (requested === null || requested === undefined) return { count: base, problem: null };
  if (!Number.isInteger(requested) || requested < base) return { count: base, problem: `--count ${requested} は ${base} 件を下回る。件数は増やしてよく、減らさない(標準 第5章 5.7.4)` };
  return { count: requested, problem: null };
}

/**
 * /pit の注記。直前の四半期に母集団があり、その四半期の抽出の記録が無ければ文を返す(無ければ null)
 */
export function samplingOverdueNote({ root = ROOT, today, items }) {
  const prev = prevQuarter(quarterOf(today));
  if (!prev) return null;
  const n = items.filter((i) => i.quarter === prev).length;
  if (!n) return null;
  if (fs.existsSync(path.join(root, RECORD_DIR, `${prev}.md`))) return null;
  return `判定記録の記述の内容の四半期の抽出(標準 第5章 5.7.4)が、${prev} について記録されていない(母集団 ${n} 件)。\`node scripts/gate/content-sampling.mjs --quarter ${prev}\` で抽出し、判定者以外の人が確かめて所見を書く`;
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const q = arg('--quarter');
  if (!/^\d{4}Q[1-4]$/.test(q ?? '')) {
    console.error('--quarter YYYYQn(例: 2026Q4)を渡します');
    process.exit(2);
  }
  const out = path.join(ROOT, RECORD_DIR, `${q}.md`);
  if (fs.existsSync(out)) {
    console.error(`${RECORD_DIR}/${q}.md が既にあります。上書きしません(抽出をやり直さない)`);
    process.exit(1);
  }
  const prevFile = path.join(ROOT, RECORD_DIR, `${prevQuarter(q)}.md`);
  const req = arg('--count');
  const { count, problem } = sampleCount({ prevText: fs.existsSync(prevFile) ? fs.readFileSync(prevFile, 'utf8') : null, requested: req === null ? null : Number(req) });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  let seed = arg('--seed');
  if (!seed) {
    try {
      seed = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      seed = new Date().toISOString();
    }
  }
  const { items, branchAvailable, branchReason } = readPopulation(ROOT);
  const pop = items.filter((i) => i.quarter === q);
  const picked = sample(pop, seed, count);
  const form = fs.readFileSync(path.join(ROOT, 'templates/content-sampling.md'), 'utf8');
  const rows = picked.map((p, i) => `| ${i + 1} | ${p.id} | | |`).join('\n');
  const text = form
    .replaceAll('<四半期>', q)
    .replace('<種>', seed)
    .replace('<母集団の件数>', String(pop.length))
    .replace('<件数>', String(picked.length))
    .replace('<記録用ブランチ>', branchAvailable ? '読んだ' : `読めない(${branchReason ?? '理由不明'}。基底ブランチの docs/gates/ だけを母集団にした)`)
    .replace(/^\| 1 \| <抽出した記録> \| \| \|$/m, rows || '| — | 母集団が0件 | | |');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`${RECORD_DIR}/${q}.md を起こしました(母集団 ${pop.length} 件から ${picked.length} 件。種 ${seed})。判定者以外の人が確かめ、確かめた者と所見を書きます`);
}
