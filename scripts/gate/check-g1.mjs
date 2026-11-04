// G-1(企画書・事業意図)の前提条件を検査する。
//
// 企画承認(G-1)の審議開始前に、観点1(戦略整合)および観点2(自社が勝てる理由)の空欄検査を機械が行います。
// 品質の約束と保証範囲(層2)の4欄と、AI の利用の評価の3行(標準 第4章 G-1・第6章 テンプレ6)も、空欄と
// 様式の説明(<…>)を残したままの欄を検出します。壊してはならない品質条件の識別子(QC-NN)の欠落と重複、
// 総費用の内訳の5区分の空欄も検出します。記述の内容は判定しません(第5章 5.7.4)。
// (scripts/gate/check-g1.mjs としてコピーして使用してください)

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, fail, notice, warn, isFilledValue, readGateRecords } from './config.mjs';
import { readBriefQuality } from './verification-trace.mjs';
import { BRIEF_SCOPE_ROW, briefScopeRowState, BRIEF_SCOPE_GAP_TEXT } from './coverage-check.mjs';
import { briefThresholdProblems, briefThresholdMessage } from './brief-thresholds.mjs';
import { g1EstimateBlank, briefVersionOf, g1EstimateChanges, fileAtVersion } from './brief-estimates.mjs';

const config = loadConfig();
const G1 = path.join(ROOT, 'docs/project-brief.md');

if (config.configured === false) {
  notice('プロセス構成が未設定のため、G-1 の検査は実施しません');
  process.exit(0);
}

if (!fs.existsSync(G1)) {
  fail('docs/project-brief.md がありません。templates/06-project-brief.md を写して作成してください');
  process.exit(1);
}

const text = fs.readFileSync(G1, 'utf8');
const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);

const fm = {};
for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
  const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
  if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
}

// frontmatter が無くても、以降の欄の検査を続けて、不備をまとめて出す(#288)
const problems = [];
if (!m) problems.push('G-1 企画書に frontmatter がありません(先頭に project_id・version・approver・status を書く)');
else {
  for (const k of ['project_id', 'version', 'approver', 'status']) {
    if (!fm[k]) problems.push(`frontmatter の ${k} が空です`);
  }
}

const lines = text.split(/\r?\n/);

let inView1 = false;
let inView2 = false;
let view1Lines = [];
let view2Lines = [];

for (const line of lines) {
  if (/^##\s+.*観点1/i.test(line)) {
    inView1 = true;
    inView2 = false;
    continue;
  }
  if (/^##\s+.*観点2/i.test(line)) {
    inView1 = false;
    inView2 = true;
    continue;
  }
  if (/^##\s+/i.test(line)) {
    inView1 = false;
    inView2 = false;
  }

  if (inView1) view1Lines.push(line);
  if (inView2) view2Lines.push(line);
}

// 観点1と観点2の特定の空欄チェック
const emptyView1Cells = view1Lines
  .filter((l) => /^\|/.test(l) && !/^[|:-]+$/.test(l) && /\|\s*(TBD|未定|\?\?\?|)\s*\|/i.test(l));
const emptyView2Cells = view2Lines
  .filter((l) => /^\|/.test(l) && !/^[|:-]+$/.test(l) && /\|\s*(TBD|未定|\?\?\?|)\s*\|/i.test(l));

if (emptyView1Cells.length) {
  problems.push(`観点1(戦略整合)に未記入の欄があります(TBD / 未定 / ??? / 空欄)`);
}
if (emptyView2Cells.length) {
  problems.push(`観点2(自社が勝てる理由)に未記入の欄があります(TBD / 未定 / ??? / 空欄)`);
}

// 品質の約束と保証範囲(層2)の4欄と、AI の利用の評価の3行。行が無い、空欄、様式の説明を残したままの欄を検出する。
// 「組織として保証しない」「層1 なし」「基準値なし」は記入として受け付ける(その案件の変更は保証の主張の成立条件を満たさない)
const REQUIRED_ROWS = [
  ['品質の約束と保証範囲', '想定する利用者・目的・利用状況・制約'],
  ['品質の約束と保証範囲', '壊してはならない品質条件'],
  ['品質の約束と保証範囲', '保証範囲と範囲外'],
  ['品質の約束と保証範囲', 'この案件に掛かる外枠'],
  ['投資対効果', 'AI の利用で期待する成果'],
  ['投資対効果', 'AI を使わない場合との比較の基準値'],
  ['投資対効果', 'AI の利用の拡大と停止の基準'],
  // 基準3 の基準値は、測る範囲を併せて企画時に決めて記録する(標準 第4章 G-5。#296)。構成との一致は契約検査が確かめる。
  // G-1 を通過済みの企画書に行が無い場合は、遡って失敗させず欠落として出す(突合 X-4)
  ['指標の閾値と予算区分', BRIEF_SCOPE_ROW],
];
const scopeRowState = briefScopeRowState(text, readGateRecords());
for (const [section, key] of REQUIRED_ROWS) {
  const row = lines.find((l) => l.replace(/\*/g, '').startsWith(`| ${key} |`));
  if (!row && key === BRIEF_SCOPE_ROW && scopeRowState === 'gap') {
    warn(BRIEF_SCOPE_GAP_TEXT);
    continue;
  }
  if (!row) {
    problems.push(`「${section}」の欄「${key}」がありません(templates/06-project-brief.md の様式から写す)`);
    continue;
  }
  const value = row.replace(/\*/g, '').slice(`| ${key} |`.length).replace(/\|\s*$/, '').trim();
  if (!isFilledValue(value)) problems.push(`「${section}」の欄「${key}」が未記入です(空欄、または様式の説明 <…> のまま)`);
}

// 7.6 のエスカレーション閾値と 7.7.4 の自動的な上程の閾値(組織が定める値。標準 第1章 1.7.7、第7章 7.6・7.7.2。#419 / ADR-0097)。
// 記録の無い企画書は G-1 の基準4 を満たさない。G-1 を通過済みの企画書は遡って失敗させず、欠落として出す
for (const p of briefThresholdProblems(text, readGateRecords(), isFilledValue)) {
  if (p.state === 'gap') warn(briefThresholdMessage(p));
  else problems.push(briefThresholdMessage(p));
}

// 壊してはならない品質条件の識別子(QC-NN)と、総費用の内訳(5区分)。標準 第6章 テンプレ6、第4章 G-7
// 「壊してはならない品質条件の突合」、第7章 7.7.8 の要求事項4。識別子の欠落と重複、5区分の空欄を検出する
const quality = readBriefQuality({ text });
if (quality.missingIds.length) {
  problems.push(
    `「壊してはならない品質条件」に識別子(QC-NN)を持たない条件があります(${quality.missingIds.slice(0, 3).map((t) => t.slice(0, 40)).join(' / ')})。` +
      '「壊してはならない品質条件(識別子)」の表で、条件ごとに QC-01 の形の識別子を振ります(識別子の無い条件は、出荷判定で記載の欠落になる)'
  );
}
if (quality.duplicates.length) problems.push(`「壊してはならない品質条件」の識別子が重複しています(${[...new Set(quality.duplicates)].join(', ')})`);
if (!quality.cost.present) problems.push('「総費用の内訳」の表がありません(templates/06-project-brief.md の様式から写す。AI の実行・検証・修正・教育・管理の5区分)');
else if (quality.cost.blank.length) problems.push(`「総費用の内訳」に記入の無い区分があります(${quality.cost.blank.join(' / ')})。記録から取れない区分は「見積り」と書き、算定の方法を出所へ書く`);

// 総費用の内訳の「G-1 の時点の見積り」の列(標準 第7章 7.7.9 の要求事項3。process-compass #416 / ADR-0093)。
// 空欄は G-1 の前は失敗、G-1 を通過済みは欠落として出す。通過済みの企画書は、G-1 の判定記録の「参照した企画書の版」と比べ、
// 列が書き換えられていれば失敗させる(当初の見積りを上書きしない)。版を読めなければ、確かめられないことを出す
{
  const g1Recs = readGateRecords().filter((r) => /^G-1(?!d)/.test(r.gate ?? '') && r.result === '通過');
  const blankG1 = g1EstimateBlank(text, isFilledValue);
  if (blankG1 === null && quality.cost.present) {
    const msg = '「総費用の内訳」に列「G-1 の時点の見積り」がありません(templates/06-project-brief.md の様式から写す。標準 第7章 7.7.9 の要求事項3)';
    if (g1Recs.length) warn(`${msg}。G-1 を通過済みのため遡って失敗させません。記載の欠落です`);
    else problems.push(msg);
  } else if (blankG1 && blankG1.length) {
    const msg = `「総費用の内訳」の列「G-1 の時点の見積り」に空欄の区分があります(${blankG1.join(' / ')})。G-1 の時点では「値」と同じ値を書きます(標準 第7章 7.7.9 の要求事項3)`;
    if (g1Recs.length) warn(`${msg}。G-1 を通過済みのため遡って失敗させません。記載の欠落です`);
    else problems.push(msg);
  }
  for (const r of g1Recs) {
    const ver = briefVersionOf(fs.readFileSync(path.join(ROOT, r.file), 'utf8'));
    if (!ver) {
      warn(`${r.file}: 「参照した企画書の版」にコミットの識別子が無いため、G-1 の時点の見積りが書き換えられていないかを確かめられません(標準 第7章 7.7.9 の要求事項3)`);
      continue;
    }
    const base = fileAtVersion(ROOT, ver, 'docs/project-brief.md');
    if (base === null) {
      warn(`${r.file}: 参照した企画書の版 ${ver} の docs/project-brief.md を読めません。G-1 の時点の見積りが書き換えられていないかを確かめられません`);
      continue;
    }
    const changed = g1EstimateChanges(base, text);
    if (changed.length) {
      problems.push(`総費用の内訳の「G-1 の時点の見積り」が、G-1 の判定(${r.file}。参照した企画書の版 ${ver})の後に書き換えられています(${changed.map((c) => `${c.label}: ${c.before} → ${c.after || '空欄'}`).join(' / ')})。当初の見積りは上書きしません。実績は「値」と「実績 / 見積り」の列へ書きます(標準 第7章 7.7.9 の要求事項3)`);
    }
  }
}

// 本文全体での TBD / 未定 / ??? 検査
const generalEmpty = lines
  .filter((l) => /^\|/.test(l) && !/^[|:-]+$/.test(l) && /\|\s*(TBD|未定|\?\?\?)\s*\|/i.test(l));
if (generalEmpty.length) {
  problems.push(`企画書本文に未記入の欄が ${generalEmpty.length} 件あります(TBD / 未定 / ???)`);
}

for (const p of problems) fail(p);
if (problems.length) {
  console.log('');
  console.log('G-1 企画書の前提条件検査に不合格でした。内容を埋めてから再度お試しください');
  process.exit(1);
}

notice(`G-1 企画書は機械検査を通過しました(承認予定者: ${fm.approver})`);
