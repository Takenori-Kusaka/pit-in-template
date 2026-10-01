// D-0(意思決定・エスカレーション体制図)の前提条件を検査する。
//
//   node scripts/gate/check-d0.mjs
//
// D-0 は規模によらず必須で、企画承認(G-1)の前提条件です。
// 未承認・期限切れの状態では、G-1 の審議を開始できません。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, fail, notice, warn, chainStarted } from './config.mjs';
import { d0SectionProblems, d0GovernanceProblems, D0_VERSION_FORMAT } from '../init/generate-profile.mjs';

const config = loadConfig();
const D0 = path.join(ROOT, 'docs/D-0-governance.md');

if (config.configured === false) {
  notice('プロセス構成が未設定のため、D-0 の検査は実施しません');
  process.exit(0);
}

if (!fs.existsSync(D0)) {
  fail(
    'docs/D-0-governance.md がありません。templates/00-d0-governance.md を写して作成してください。' +
      '責任者の表・担い手と運用形態・改訂履歴(生成区間)は、`node scripts/init/generate-profile.mjs --answers process.config.json` と /process-change が書き込みます'
  );
  process.exit(1);
}

const text = fs.readFileSync(D0, 'utf8');
const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!m) {
  fail('D-0 に frontmatter がありません');
  process.exit(1);
}

/** 依存パッケージを持たないため、frontmatter は key: value の平坦な形だけを読む */
const fm = {};
for (const line of m[1].split(/\r?\n/)) {
  const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
  if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
}

const problems = [];
for (const k of ['project_id', 'version', 'approver', 'approved_at', 'approval_scope', 'next_review']) {
  if (!fm[k]) problems.push(`frontmatter の ${k} が空です`);
}

if (fm.next_review) {
  const due = Date.parse(fm.next_review);
  if (Number.isNaN(due)) problems.push(`next_review "${fm.next_review}" を日付として読めません`);
  else if (due < Date.now()) problems.push(`next_review ${fm.next_review} が過ぎています。体制図の見直しを行ってください`);
}

// 版の形式は N.N に限る(構成を生成する側と同じ検査。1.0.0・v1.1 は前後を比べられない)
if (fm.version && !D0_VERSION_FORMAT.test(fm.version)) {
  problems.push(`frontmatter の version "${fm.version}" は、版の形式(N.N。例: 1.3)ではありません`);
}

// 構成が追随している D-0 の版とのずれ(標準 第3章 3.13.5)。D-0 を改訂したら、
// 最初のゲート判定より前に構成を再生成する。ずれたままの構成は、改訂前の体制で判定させる
if (fm.version && config.d0Version && String(config.d0Version) !== fm.version) {
  problems.push(
    `D-0 の版(${fm.version})と、構成が追随している版(${config.d0Version})が一致しません。` +
      '体制の変化点として /process-change で構成を再生成してください'
  );
} else if (fm.version && !config.d0Version) {
  warn(
    '構成が D-0 の版に追随していません(d0Version が未取得)。D-0 を作成した直後は、`node scripts/init/generate-profile.mjs --answers process.config.json` を実行すると、版を取得し、生成区間を書き込みます。席の責任者と人の名簿は /process-change(種別 accountable)で反映します'
  );
}

// 生成区間(席・責任者・担い手・運用形態の表、委任の範囲、改訂履歴)が、構成と一致するか。
// 構成から導ける欄は /process-change が書く。構成を正とし、体制図との二重記入を無くす。
// D-0 を改訂せずに変化点を適用した状態と、D-0 だけを手で書き換えた状態を、ここで検出する。
// 要約値の連鎖を持たない旧い構成は、最初の /process-change までは注意にとどめる
const generated = [...d0SectionProblems(text, config), ...d0GovernanceProblems(text, config)];
if (chainStarted(config)) problems.push(...generated);
else for (const p of generated) warn(`${p}(旧い構成のため注意にとどめています。最初の /process-change の後は失敗します)`);

// 本文の表に空欄が残っていないか(| — | や | | を空欄とみなす)
const emptyCells = text
  .split(/\r?\n/)
  .filter((l) => /^\|/.test(l) && /\|\s*(TBD|未定|\?\?\?)\s*\|/i.test(l));
if (emptyCells.length) {
  problems.push(`本文に未記入の欄が ${emptyCells.length} 件あります(TBD / 未定 / ???)`);
}

// 出荷できない状態は、体制図の検査でも表示する(体制が最小体制を割っている)
if (config.shipBlocked) warn(`出荷できない状態です(${config.shipBlocked.since} から): ${config.shipBlocked.reason}`);

for (const p of problems) fail(p);
if (problems.length) {
  console.log('');
  console.log('D-0 が承認済みでない状態では、企画承認(G-1)の審議を開始できません');
  process.exit(1);
}

const days = Math.round((Date.parse(fm.next_review) - Date.now()) / 86400000);
if (days < 30) warn(`D-0 の見直し期限まで ${days} 日です`);
notice(`D-0 は承認済みです(承認者: ${fm.approver} / 見直し: ${fm.next_review})`);
