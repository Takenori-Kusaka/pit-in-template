// G-1(企画書・事業意図)の前提条件を検査する。
//
// 企画承認(G-1)の審議開始前に、観点1(戦略整合)および観点2(自社が勝てる理由)の空欄検査を機械が行います。
// 品質の約束と保証範囲(層2)の4欄と、AI の利用の評価の3行(標準 第4章 G-1・第6章 テンプレ6)も、空欄と
// 様式の説明(<…>)を残したままの欄を検出します。壊してはならない品質条件の識別子(QC-NN)の欠落と重複、
// 総費用の内訳の5区分の空欄も検出します。記述の内容は判定しません(第5章 5.7.4)。
// (scripts/gate/check-g1.mjs としてコピーして使用してください)

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, fail, notice, warn, isFilledValue } from './config.mjs';
import { readBriefQuality } from './verification-trace.mjs';

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
];
for (const [section, key] of REQUIRED_ROWS) {
  const row = lines.find((l) => l.replace(/\*/g, '').startsWith(`| ${key} |`));
  if (!row) {
    problems.push(`「${section}」の欄「${key}」がありません(templates/06-project-brief.md の様式から写す)`);
    continue;
  }
  const value = row.replace(/\*/g, '').slice(`| ${key} |`.length).replace(/\|\s*$/, '').trim();
  if (!isFilledValue(value)) problems.push(`「${section}」の欄「${key}」が未記入です(空欄、または様式の説明 <…> のまま)`);
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
