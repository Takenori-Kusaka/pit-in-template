// G-1(企画書・事業意図)の前提条件を検査する。
//
// 企画承認(G-1)の審議開始前に、観点1(戦略整合)および観点2(自社が勝てる理由)の空欄検査を機械が行います。
// (scripts/gate/check-g1.mjs としてコピーして使用してください)

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, fail, notice, warn } from './config.mjs';

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
if (!m) {
  fail('G-1 企画書に frontmatter がありません');
  process.exit(1);
}

const fm = {};
for (const line of m[1].split(/\r?\n/)) {
  const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
  if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
}

const problems = [];
for (const k of ['project_id', 'version', 'approver', 'status']) {
  if (!fm[k]) problems.push(`frontmatter の ${k} が空です`);
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
