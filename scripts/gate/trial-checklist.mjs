// 試行前チェックリスト(T-1 開始条件。標準 第8章「社会実装の段階の調整」)の形を検査する。process-compass #359 / IMPL-0465・IMPL-0466
//
//   node scripts/gate/trial-checklist.mjs [--today YYYY-MM-DD]
//
// docs/trial-checklist.md を読み、次を出します。1つでもあれば終了コード 1 です(試行を始めない)。
//   - 様式(templates/trial-checklist.md)の項目のうち、写しに無い項目
//   - チェックの無い項目(「該当なし: <理由>」のある行を除く)と、理由の無い「該当なし」(確認済みとして扱わない)
//   - サンドボックスによる免除の行で、免除の期限(YYYY-MM-DD)が無い行
//   - 延長の決定の無いまま、免除の期限を過ぎた行(期限は自動では延びない)
//   - 「既存規程の免除を要する場合」の項目に印を付けたのに、免除の行が無い
// 機械が見るのは形だけです。項目が実際に満たされているか、試行を始めた時点は、試行の責任者が確かめます。
// 申請の様式・承認者は採用組織が定めるので、確かめません(標準 ADR-0116 決定4)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT } from './config.mjs';

const ITEM_RE = /^\s*-\s*\[([ xX])\]\s*(.+?)\s*$/;
const NA_RE = /該当なし\s*[::]?\s*(.*)$/;

/**
 * 照合に使う項目の本文。様式の項目の括弧の注記(「(見込み工数と確保時間を数値で記載)」など)より前を鍵にする。
 * 写しの行は、鍵で始まれば同じ項目と読む(注記の中や行末へ数値・所在・「該当なし: …」を書き足してよい。突合 中-2)
 */
function itemKey(text) {
  return text.normalize('NFKC').replace(/\s+/g, '').replace(/[((][\s\S]*$/, '').replace(/該当なし[\s\S]*$/, '');
}

function section(text, headingRe) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s/.test(l) && headingRe.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** チェックリストの節の項目({ checked, text, key }) */
export function checklistItems(text) {
  const sec = section(text, /試行前チェックリスト/) ?? [];
  return sec.map((l) => ITEM_RE.exec(l)).filter(Boolean).map((m) => ({ checked: m[1] !== ' ', text: m[2], key: itemKey(m[2]) }));
}

/** 免除の表の行({ clause, deadline, approval, extension }) */
export function sandboxRows(text) {
  const sec = section(text, /サンドボックスによる免除/);
  if (!sec) return [];
  const rows = sec.filter((l) => /^\|/.test(l) && !/^\|\s*[-:]+\s*\|/.test(l));
  return rows
    .slice(1)
    .map((l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()))
    .filter((c) => c.some((x) => x))
    .map(([clause = '', deadline = '', approval = '', extension = '']) => ({ clause, deadline, approval, extension }));
}

const DATE_RE = /\d{4}-\d{2}-\d{2}/g;

/**
 * 形の問題の一覧を返す。
 * @param {string} text 写し(docs/trial-checklist.md)
 * @param {string} formText 様式(templates/trial-checklist.md)
 * @param {string} today YYYY-MM-DD
 * @returns {string[]}
 */
export function trialChecklistProblems(text, formText, today) {
  const problems = [];
  const items = checklistItems(text);
  for (const f of checklistItems(formText)) {
    if (!items.some((i) => i.key.startsWith(f.key))) problems.push(`項目が写しにありません: 「${f.text}」(様式 templates/trial-checklist.md の項目を消さない。該当しない項目は「該当なし: <理由>」と書く)`);
  }
  for (const i of items) {
    const na = NA_RE.exec(i.text);
    if (!na) {
      if (!i.checked) problems.push(`未確認の項目: 「${i.text}」(未充足の項目がある状態で、試行を始めない)`);
      continue;
    }
    // 印の有無によらず、理由の無い「該当なし」は確認済みとして扱わない(突合 中-1)
    const reason = na[1].replace(/^<[^>]*>$/, '').replace(/[))]\s*$/, '').trim();
    if (!reason) problems.push(`理由の無い「該当なし」: 「${i.text}」(理由の無い「該当なし」を確認済みとして扱わない)`);
  }
  const rows = sandboxRows(text);
  for (const r of rows) {
    const label = r.clause || '(条項の欄が空)';
    const deadline = (r.deadline.match(DATE_RE) ?? [])[0] ?? null;
    if (!deadline) {
      problems.push(`サンドボックスの免除「${label}」に、免除の期限(YYYY-MM-DD)がありません`);
      continue;
    }
    // 延長の決定は、元の期限より後の日付だけを延長として読む(前の日付は延長に当たらない。突合 低-7)
    const ext = (r.extension.match(DATE_RE) ?? []).filter((d) => d > deadline).sort();
    const effective = ext.length ? ext[ext.length - 1] : deadline;
    if (effective < today) {
      problems.push(
        ext.length
          ? `サンドボックスの免除「${label}」は、延長した期限 ${effective} を過ぎています。期限は自動では延びません。延ばすなら、新しい期限を記録した決定を「延長の決定」へ書き足します`
          : `サンドボックスの免除「${label}」は、期限 ${deadline} を過ぎています。期限は自動では延びません。延ばすなら、元の期限を書き換えず、新しい期限を記録した決定を「延長の決定」へ書き足します`
      );
    }
  }
  const sandboxItem = items.find((i) => /サンドボックス申請/.test(i.text));
  if (sandboxItem?.checked && !rows.length) problems.push('「既存規程の免除を要する場合」の項目に印を付けていますが、「サンドボックスによる免除」の表に行がありません(免除の期限を記録する)');
  return problems;
}

function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** リポジトリの写しを読み、{ present, problems } を返す(/pit から呼ぶ) */
export function readTrialChecklist(root, today = localToday()) {
  const file = path.join(root, 'docs/trial-checklist.md');
  if (!fs.existsSync(file)) return { present: false, problems: [] };
  const formFile = path.join(root, 'templates/trial-checklist.md');
  const form = fs.existsSync(formFile) ? fs.readFileSync(formFile, 'utf8') : '';
  return { present: true, problems: trialChecklistProblems(fs.readFileSync(file, 'utf8'), form, today) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = ROOT;
  const i = process.argv.indexOf('--today');
  const today = i >= 0 ? process.argv[i + 1] : localToday();
  const r = readTrialChecklist(root, today);
  if (!r.present) {
    console.log('docs/trial-checklist.md がありません。T-1 の限定試行を始める前に、templates/trial-checklist.md を写して全項目を確認します(標準 第8章)');
    process.exit(1);
  }
  for (const p of r.problems) console.log(`- ${p}`);
  if (r.problems.length) {
    console.log(`試行前チェックリスト: ${r.problems.length} 件。試行を始めません(標準 第8章「社会実装の段階の調整」)`);
    process.exit(1);
  }
  console.log('試行前チェックリスト: 形の問題はありません(項目が満たされているかは、試行の責任者が確かめます)');
}
