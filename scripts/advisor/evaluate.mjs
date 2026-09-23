// phase-advisor の適合性評価(標準 3.12.3)。モデルの採用時と、版や送信先を切り替えるたびに人が実行します
//
// 送るのは評価セット(scripts/advisor/eval-set.jsonl。合成した発話)だけで、案件のデータは送りません。
// フックと同じ前処理・リクエスト・閾値で測ります。フックが送らない発話(スキル呼び出し・6文字未満)は採点から除きます。
// 既定は偶数番(閾値を決めるのに使わなかった側)で、scripts/advisor/README.md の表と同じ母集団です。
//
// 実行: TYPESAFE_API_KEY=... node scripts/advisor/evaluate.mjs [--split even|odd|all] [--repeats 3] [--json out.json]
// 結果は判定ではなく、採用・閾値の判断(AI運用担当者 / 技術判断者)の材料です。閾値を自動で更新しません。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_KEY_ENV, allowedEndpoint, buildRequest, DEFAULT_CONFIG, FLAGS, localOnly } from '../../.claude/hooks/phase-advisor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const REPEATS = Number(arg('--repeats', '1'));
const SPLIT = arg('--split', 'even');
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'process.config.json'), 'utf8')).phaseAdvisor ?? {}; } catch { /* 既定値で測る */ }
const cfg = { ...DEFAULT_CONFIG, ...fileCfg, flagThresholds: { ...DEFAULT_CONFIG.flagThresholds, ...fileCfg.flagThresholds } };
const key = process.env[API_KEY_ENV];
if (!key) { console.error(`環境変数 ${API_KEY_ENV} がありません`); process.exit(2); }
if (!allowedEndpoint(cfg.endpoint)) { console.error(`送信先 ${cfg.endpoint} はフックの許可リストにありません`); process.exit(2); }

const parity = { even: 0, odd: 1 }[SPLIT];
const items = fs.readFileSync(path.join(ROOT, 'scripts/advisor/eval-set.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .filter(it => parity === undefined || Number(it.id.split('-')[1]) % 2 === parity)
  .filter(it => !localOnly(it.text.trim()));

async function call(text) {
  const t0 = performance.now();
  try {
    const r = await fetch(cfg.endpoint, {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequest(text.trim(), cfg)), signal: AbortSignal.timeout(15000),
    });
    const ms = performance.now() - t0;
    if (!r.ok) return { ms, error: `http-${r.status}` };
    const res = await r.json();
    return res.model === cfg.model ? { ms, ...res } : { ms, error: `model-mismatch:${res.model}` };
  } catch (e) { return { ms: performance.now() - t0, error: e.name }; }
}

const runs = Array.from({ length: REPEATS }, () => new Map());
const queue = runs.flatMap((m, rep) => items.map(it => ({ it, rep })));
await Promise.all(Array.from({ length: 3 }, async () => {
  while (queue.length) { const { it, rep } = queue.shift(); runs[rep].set(it.id, await call(it.text)); }
}));

const A = (rep, it) => runs[rep].get(it.id)?.answers;
const ok = items.filter(it => A(0, it));
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');
const shown = (a) => (a.phase.confidence >= cfg.phaseMinConfidence ? a.phase.choice : null);
const raised = (a, k) => a[k].noul >= cfg.flagThresholds[k];
const correct = ok.filter(it => A(0, it).phase.choice === it.phase).length;
const gated = ok.filter(it => shown(A(0, it)));
const gatedOk = gated.filter(it => A(0, it).phase.choice === it.phase).length;
const bins = Array.from({ length: 10 }, () => ({ n: 0, c: 0, s: 0 }));
for (const it of ok) { const p = A(0, it).phase, b = bins[Math.min(9, Math.floor(p.confidence * 10))]; b.n++; b.s += p.confidence; b.c += p.choice === it.phase ? 1 : 0; }
const ece = bins.reduce((e, b) => e + (b.n ? (b.n / ok.length) * Math.abs(b.c / b.n - b.s / b.n) : 0), 0);
const flags = Object.fromEntries(Object.keys(FLAGS).map(k => {
  const tp = ok.filter(it => it.flags[k] && raised(A(0, it), k)).length, fp = ok.filter(it => !it.flags[k] && raised(A(0, it), k)).length, pos = ok.filter(it => it.flags[k]).length;
  return [k, { threshold: cfg.flagThresholds[k], positives: pos, tp, fp }];
}));
const clean = ok.filter(it => !Object.values(it.flags).some(Boolean));
const falseAlarm = clean.filter(it => Object.keys(FLAGS).some(k => raised(A(0, it), k))).length;
const lat = [...runs[0].values()].filter(r => r.answers).map(r => r.ms).sort((a, b) => a - b);
const q = p => (lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]) : '-');
let flips = null;
if (REPEATS > 1) {
  const all = ok.filter(it => runs.every((m, rep) => A(rep, it)));
  const varies = f => all.filter(it => new Set(runs.map((m, rep) => JSON.stringify(f(A(rep, it))))).size > 1).length;
  flips = { compared: all.length, phase: varies(a => a.phase.choice), shown: varies(shown), flags: varies(a => Object.keys(FLAGS).filter(k => raised(a, k))) };
}

const summary = {
  model: cfg.model, endpoint: cfg.endpoint, split: SPLIT, items: items.length, answered: ok.length,
  errors: [...runs[0].values()].filter(r => r.error).map(r => r.error),
  phaseAccuracy: correct / (ok.length || 1), ece, gate: { minConfidence: cfg.phaseMinConfidence, coverage: gated.length / (ok.length || 1), accuracy: gatedOk / (gated.length || 1) },
  flags, cleanPromptFalseAlarm: { raised: falseAlarm, clean: clean.length }, latencyMs: { p50: q(0.5), p95: q(0.95), max: q(1) }, flipsAcrossRepeats: flips,
};
console.log(`モデル ${cfg.model} / 母集団 ${SPLIT}(フックが送らない発話を除く)${items.length} 件、応答 ${ok.length} 件、失敗 ${summary.errors.length} 件`);
console.log(`工程の正解率 ${pct(correct, ok.length)}、ECE ${ece.toFixed(3)} / 確信度 ${cfg.phaseMinConfidence} 以上: 対象 ${pct(gated.length, ok.length)}、正解率 ${pct(gatedOk, gated.length)}`);
for (const [k, m] of Object.entries(flags)) console.log(`  ${k.padEnd(19)} 閾値 ${m.threshold} 正例 ${m.positives} 適合率 ${pct(m.tp, m.tp + m.fp)} 再現率 ${pct(m.tp, m.positives)}`);
console.log(`注意が不要な発話で注意が出た割合 ${pct(falseAlarm, clean.length)}(${falseAlarm}/${clean.length}) / 遅延 p50 ${summary.latencyMs.p50}ms p95 ${summary.latencyMs.p95}ms`);
if (flips) console.log(`${REPEATS} 回の揺れ(${flips.compared} 件): 工程 ${flips.phase} 件、工程を出す/出さない ${flips.shown} 件、注意の組み合わせ ${flips.flags} 件`);
const out = arg('--json', null);
if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
