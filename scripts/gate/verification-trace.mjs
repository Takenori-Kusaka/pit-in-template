// 検証への降ろし方を記録から数える(process-compass #288 第2巡)。出荷判定の証跡の集約(aggregate-evidence.mjs)、
// G-1 の検査(check-g1.mjs)、導入前の検証(adoption-trial.mjs)が使う。
//
//   壊してはならない品質条件(企画書の QC-NN)と、受入基準・テストからの参照の突合   標準 第4章 G-7「壊してはならない品質条件の突合」
//   G-7 基準1 計画したテストの数と消化(受入基準 F-NNN/AC-N とテストの対応、G-5 の実行の記録)   第4章 G-7「基準1・2 の記録」
//   G-7 基準2 欠陥の台帳(docs/defect-ledger.md)の取り込みと、欠陥トリアージ基準の区分ごとの未解決の件数
//   企画書の総費用の内訳(5区分 × 値・実績 / 見積り・出所)                    第6章 テンプレ6、第7章 7.7.8
//
// 機械が数えるのは参照の有無と件数までである。参照したテストが条件や受入基準を確かめているか、計画したテストが
// 十分かは判定しない(G-6 の独立レビュアと出荷判定者が確かめる)。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, isFilledValue, matchGlob } from './config.mjs';

export const BRIEF_FILE = 'docs/project-brief.md';
export const DEFECT_FILE = 'docs/defect-ledger.md';
export const TEST_RESULTS_FILE = 'evidence/test-results.json';

const clean = (v) => String(v ?? '').replace(/\*\*/g, '').replace(/`/g, '').trim();
const nfkc = (v) => clean(v).normalize('NFKC');
const readText = (rel, root) => {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null;
};

/** 見出し(# の数を問わない)が re に当たる節の行。同じ深さ以上の次の見出しまで */
function headingLines(text, re) {
  if (!text) return [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && re.test(l));
  if (start < 0) return [];
  const depth = lines[start].match(/^#+/)[0].length;
  const out = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^(#+)\s/);
    if (m && m[1].length <= depth) break;
    out.push(l);
  }
  return out;
}

/** 最初の表の見出しと本体 */
function firstTable(lines) {
  let i = 0;
  while (i < lines.length && !lines[i].trimStart().startsWith('|')) i++;
  const split = (l) => {
    const t = l.trim();
    return t.slice(1, t.endsWith('|') ? -1 : undefined).split('|').map((c) => clean(c));
  };
  let header = null;
  const rows = [];
  for (; i < lines.length && lines[i].trimStart().startsWith('|'); i++) {
    const l = lines[i].trim();
    if (/^\|[\s|:-]+\|$/.test(l)) continue;
    if (!header) header = split(l).map((c) => nfkc(c));
    else rows.push(split(l));
  }
  return { header: header ?? [], rows };
}

function rowValue(text, key) {
  if (!text) return null;
  for (const l of text.split('\n')) {
    const m = l.match(/^\|\s*\**([^|]*?)\**\s*\|\s*(.*?)\s*\|\s*$/);
    if (m && clean(m[1]).startsWith(key)) return clean(m[2]);
  }
  return null;
}

const QC_ID = /\bQC-\d+\b/g;

/**
 * 企画書の壊してはならない品質条件(識別子 QC-NN)と総費用の内訳を読む。
 * conditions: 識別子を持つ条件。missingIds: 識別子を持たない条件(記載の欠落)。duplicates: 重複した識別子
 */
export function readBriefQuality({ root = ROOT, text: given } = {}) {
  const text = given === undefined ? readText(BRIEF_FILE, root) : given;
  const out = { present: Boolean(text), conditions: [], missingIds: [], duplicates: [], cell: null, tablePresent: false, cost: { present: false, rows: [], blank: [] } };
  if (!text) return out;
  out.cell = rowValue(text, '壊してはならない品質条件');
  const qc = firstTable(headingLines(text, /壊してはならない品質条件\s*[((]識別子[))]/));
  out.tablePresent = qc.header.length > 0 && /識別子/.test(qc.header[0] ?? '');
  const seen = new Map();
  if (out.tablePresent) {
    for (const r of qc.rows) {
      const id = nfkc(r[0]);
      const body = r[1] ?? '';
      if (!isFilledValue(id) && !isFilledValue(body)) continue;
      if (!/^QC-\d+$/.test(id)) {
        if (isFilledValue(body)) out.missingIds.push(clean(body));
        continue;
      }
      if (!isFilledValue(body)) continue;
      if (seen.has(id)) out.duplicates.push(id);
      seen.set(id, body);
    }
  }
  // 表が無い、または表に条件が無い場合は、欄の記載から識別子を読む。識別子の無い記載は識別子を持たない条件
  if (!seen.size && !out.missingIds.length && isFilledValue(out.cell) && !/表による/.test(nfkc(out.cell))) {
    const ids = [...new Set(nfkc(out.cell).match(QC_ID) ?? [])];
    if (ids.length) for (const id of ids) seen.set(id, out.cell);
    else if (!/^(条件なし|該当する条件なし)/.test(nfkc(out.cell))) out.missingIds.push(out.cell);
  }
  out.conditions = [...seen.entries()].map(([id, body]) => ({ id, text: clean(body) }));
  // 総費用の内訳(5区分)
  const cost = firstTable(headingLines(text, /総費用の内訳/));
  out.cost.present = cost.header.length > 0;
  if (out.cost.present) {
    const iVal = cost.header.findIndex((h) => /^値$/.test(h));
    const iKind = cost.header.findIndex((h) => /実績/.test(h));
    const iSrc = cost.header.findIndex((h) => /出所/.test(h));
    for (const label of ['AI の実行', '検証', '修正', '教育', '管理']) {
      const r = cost.rows.find((x) => nfkc(x[0]).startsWith(label.normalize('NFKC')));
      const value = r && iVal >= 0 ? r[iVal] : null;
      const kind = r && iKind >= 0 ? nfkc(r[iKind]) : '';
      const src = r && iSrc >= 0 ? r[iSrc] : null;
      out.cost.rows.push({ label, value: isFilledValue(value) ? value : null, kind: /^実績$|^見積り$|^見積$/.test(kind) ? kind : null, source: isFilledValue(src) ? src : null });
      const why = [];
      if (!r) why.push('行が無い');
      else {
        if (!isFilledValue(value)) why.push('値が空欄');
        if (!/^実績$|^見積り$|^見積$/.test(kind)) why.push('「実績」「見積り」のどちらでもない');
        if (!isFilledValue(src)) why.push('出所が空欄');
      }
      if (why.length) out.cost.blank.push(`${label}(${why.join('・')})`);
    }
  }
  return out;
}

/** リポジトリの追跡中のファイル(git ls-files)。git が無ければ空 */
function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** テストのファイルに数えない拡張子(文書・データ・画像・生成物)。testPatterns が tests/** のように広いとき、README やフィクスチャを数えない */
const NON_TEST_EXT = /\.(md|mdx|markdown|txt|rst|adoc|json|ya?ml|toml|ini|cfg|csv|tsv|xml|html?|css|svg|png|jpe?g|gif|webp|ico|pdf|lock|snap|map|log)$/i;

/** テストのファイル(.claude/guard.json の testPatterns に当たる追跡中のファイル。拡張子を持ち、文書・データ・画像でないもの) */
export function testFiles(root = ROOT) {
  let patterns = [];
  try {
    patterns = JSON.parse(fs.readFileSync(path.join(root, '.claude/guard.json'), 'utf8')).testPatterns ?? [];
  } catch {
    patterns = [];
  }
  return trackedFiles(root).filter(
    (f) => !/^(templates|profiles|scripts\/gate|scripts\/init|\.claude|docs|specs)\//.test(f) && /\.[A-Za-z0-9]+$/.test(f) && !NON_TEST_EXT.test(f) && patterns.some((g) => matchGlob(g, f))
  );
}

/** 受入基準(specs/F-NNN/spec.md の「受入基準」の表の各行) */
export function readAcceptanceCriteria(root = ROOT) {
  const dir = path.join(root, 'specs');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^F-\d+$/.test(x)).sort()) {
    const text = readText(`specs/${f}/spec.md`, root);
    if (!text) continue;
    const t = firstTable(headingLines(text, /受入基準/));
    for (const r of t.rows) {
      const n = nfkc(r[0]);
      if (!/^\d+$/.test(n)) continue;
      const body = r.slice(1).join(' ');
      out.push({ id: `${f}/AC-${n}`, feature: f, n: Number(n), text: clean(body), qc: [...new Set(nfkc(body).match(QC_ID) ?? [])] });
    }
  }
  return out;
}

const AC_REF = /\b(F-\d+)\s*[/#:]?\s*AC-?(\d+)\b/g;

/**
 * 壊してはならない品質条件の突合と、G-7 基準1 の件数。conditions は readBriefQuality の conditions
 */
export function traceVerification({ root = ROOT, conditions = [] } = {}) {
  const acs = readAcceptanceCriteria(root);
  const tests = testFiles(root).map((f) => {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      text = '';
    }
    const ac = [...new Set([...text.normalize('NFKC').matchAll(AC_REF)].map((m) => `${m[1]}/AC-${Number(m[2])}`))];
    return { file: f, ac, qc: [...new Set(text.normalize('NFKC').match(QC_ID) ?? [])] };
  });
  // 壊してはならない品質条件
  const qc = conditions.map((c) => {
    const fromAc = acs.filter((a) => a.qc.includes(c.id)).map((a) => a.id);
    const fromTests = tests.filter((t) => t.qc.includes(c.id)).map((t) => t.file);
    const state = fromAc.length && fromTests.length ? 'verified' : fromAc.length ? 'no-test' : fromTests.length ? 'no-ac' : 'none';
    return { id: c.id, text: c.text, acceptance: fromAc, tests: fromTests, state };
  });
  // G-7 基準1: 計画したテストの数(受入基準を参照するテスト)と、対応するテストの無い受入基準
  const planned = tests.filter((t) => t.ac.some((id) => acs.some((a) => a.id === id)));
  const acWithoutTest = acs.filter((a) => !tests.some((t) => t.ac.includes(a.id))).map((a) => a.id);
  // G-5 の実行の記録(evidence/test-results.json)。passed / failed の配列か、tests[{ file, passed }]
  let results = null;
  const rp = path.join(root, TEST_RESULTS_FILE);
  if (fs.existsSync(rp)) {
    try {
      const j = JSON.parse(fs.readFileSync(rp, 'utf8'));
      const passed = new Set(Array.isArray(j.passed) ? j.passed : Array.isArray(j.tests) ? j.tests.filter((t) => t.passed).map((t) => t.file) : []);
      const failed = new Set(Array.isArray(j.failed) ? j.failed : Array.isArray(j.tests) ? j.tests.filter((t) => !t.passed).map((t) => t.file) : []);
      results = { runAt: j.runAt ?? j.measuredAt ?? null, passed: planned.filter((t) => passed.has(t.file)).length, failed: planned.filter((t) => failed.has(t.file)).length, notRun: planned.filter((t) => !passed.has(t.file) && !failed.has(t.file)).map((t) => t.file) };
    } catch (e) {
      results = { error: `${TEST_RESULTS_FILE} を読めない(${e.message})` };
    }
  }
  return {
    qc,
    qcVerified: qc.filter((x) => x.state === 'verified').map((x) => x.id),
    qcNoTest: qc.filter((x) => x.state === 'no-test').map((x) => x.id),
    qcUnreferenced: qc.filter((x) => x.state === 'none' || x.state === 'no-ac').map((x) => x.id),
    criterion1: {
      acceptanceCriteria: acs.length,
      plannedTests: planned.length,
      plannedFiles: planned.map((t) => t.file),
      acWithoutTest,
      results,
    },
  };
}

/** 事業ステージ(構成の回答 q-biz-phase から)。S0 / S1 / S2 */
export function stageOf(config) {
  const p = config?.answers?.['q-biz-phase'];
  return p === 'poc' ? 'S0' : p === 'mvp' ? 'S1' : p ? 'S2' : null;
}

/** 欠陥トリアージ基準(第4章「事業ステージ別のトリアージマトリクス」)の区分。機械は区分を引くだけで、出荷の可否を判定しない */
const TRIAGE = {
  S0: { Sev1: '回避策を文書化すれば継続可', Sev2: '記録のみ', Sev3: '記録のみ' },
  S1: { Sev1: 'コア機能は出荷不可。非コアは既知の不具合として公開すれば可', Sev2: '記録し次サイクルで返却', Sev3: '記録のみ' },
  S2: { Sev1: '出荷不可(例外なし)', Sev2: '出荷不可。例外承認の対象', Sev3: '記録し計画返却' },
};

/** 欠陥の台帳(G-7 基準2)を読み、区分ごとの未解決の件数を出す。台帳が無ければ present: false */
export function readDefectLedger(config, { root = ROOT } = {}) {
  const text = readText(DEFECT_FILE, root);
  if (!text) return { present: false, file: DEFECT_FILE };
  const stage = stageOf(config);
  const t = firstTable(headingLines(text, /台帳|欠陥/).length ? headingLines(text, /台帳|欠陥/) : text.split('\n'));
  const col = (re) => t.header.findIndex((h) => re.test(h));
  const iSev = col(/重大度/);
  const iPri = col(/優先度/);
  const iState = col(/状態/);
  const iCore = col(/コア/);
  const rows = t.rows.filter((r) => isFilledValue(r[0]) || isFilledValue(r[1]));
  const problems = [];
  if (iSev < 0 || iPri < 0 || iState < 0) problems.push('台帳の表に重大度・優先度・状態の列が無い');
  const open = [];
  for (const r of rows) {
    const state = nfkc(r[iState]);
    if (/解決済み|クローズ|closed|resolved|done|却下|取り下げ/i.test(state)) continue;
    const sev = nfkc(r[iSev]).match(/Sev\s*([123])/i);
    open.push({ id: clean(r[0]), severity: sev ? `Sev${sev[1]}` : null, priority: clean(r[iPri]), state: clean(r[iState]), core: iCore >= 0 ? /はい|コア|yes|✓/i.test(nfkc(r[iCore])) : null });
  }
  const noKnown = !rows.length && /既知の欠陥なし/.test(text);
  if (!rows.length && !noKnown) problems.push('台帳に行が無く、「既知の欠陥なし」の記載も無い');
  const bySeverity = ['Sev1', 'Sev2', 'Sev3'].map((s) => {
    const list = open.filter((d) => d.severity === s);
    const triage = stage ? TRIAGE[stage][s] : '事業ステージが不明';
    const core = stage === 'S1' && s === 'Sev1' ? { core: list.filter((d) => d.core === true).length, nonCore: list.filter((d) => d.core !== true).length } : null;
    return { severity: s, open: list.length, ids: list.map((d) => d.id), triage, ...(core ? { split: core } : {}) };
  });
  const unknownSeverity = open.filter((d) => !d.severity).map((d) => d.id);
  if (unknownSeverity.length) problems.push(`重大度(Sev1 / Sev2 / Sev3)の無い未解決の行: ${unknownSeverity.join(', ')}`);
  return { present: true, file: DEFECT_FILE, stage, noKnown, open: open.length, bySeverity, problems };
}
