// G-1(企画書・事業意図)の前提条件を検査する。
//
// 企画承認(G-1)の審議開始前に、観点1(戦略整合)および観点2(自社が勝てる理由)の空欄検査を機械が行います。
// 品質の約束と保証範囲(層2)の4欄と、AI の利用の評価の3行(標準 第4章 G-1・第6章 テンプレ6)も、空欄と
// 様式の説明(<…>)を残したままの欄を検出します。壊してはならない品質条件の識別子(QC-NN)の欠落と重複、
// 総費用の内訳の5区分の空欄も検出します。記述の内容は判定しません(第5章 5.7.4)。
// (scripts/gate/check-g1.mjs としてコピーして使用してください)

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadConfig, ROOT, fail, notice, warn, isFilledValue, readGateRecords, resolveSigner, aiNameBlocked } from './config.mjs';
import { readBriefQuality } from './verification-trace.mjs';
import { BRIEF_SCOPE_ROW, briefScopeRowState, BRIEF_SCOPE_GAP_TEXT, BRIEF_BASELINE_ROW } from './coverage-check.mjs';
import { briefThresholdProblems, briefThresholdMessage, briefStopConditionState, briefStopConditionMessages } from './brief-thresholds.mjs';
import { g1EstimateBlank, briefVersionOf, g1EstimateChanges, fileAtVersion } from './brief-estimates.mjs';
import { briefEvidenceProblems } from './customer-voice.mjs';
import { sraApprovalProblems, sraResidualProblems, parseClRecord, dateOnly } from './cl-judgment.mjs';
import { g1PassState } from './records.mjs';

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
  // 基準値の行(#337 項目1)。G-1 の前の企画書では行と記入を必須にする。G-1 を通過済みの企画書に行が無い場合は、warn も gaps も出さずに飛ばす
  // (基準値は既に自由記述で記録されている。構造化のために既存の採用者の G-7 を落とさない)
  ['指標の閾値と予算区分', BRIEF_BASELINE_ROW],
];
// G-1 を通過済みか。基底ブランチの docs/gates/ と、記録用ブランチ records の records/gates/(判定記録の正本)の両方を読む
// (process-compass #359 の独立の突合 高-1)。記録用ブランチを読めず、基底ブランチにも通過の記録が無い間は、G-1 の前とも通過済みとも
// 扱わない。G-1 の前なら失敗になる欠けは undecided へ集め、最後に「判定記録を読めない」という1つの失敗として理由を添えて出す
// 判定者の記名は名簿の人へ対応づけ、AI の名義は除く(G-1 は人確定。突合の再確認 3回目)
const g1 = g1PassState({ cwd: ROOT, baseRecords: readGateRecords(), resolveJudge: (name) => (name && !aiNameBlocked(config, name) ? resolveSigner(config, name) : null) });
const gateRecs = g1.records;
const undecided = [];
const g1Dependent = (msg) => {
  if (g1.passed === null) undecided.push(msg);
  else problems.push(msg);
};
// 案件の登録(標準 第5章 5.7 案件の登録 手順1。IMPL-0883)。企画書の project_id が構成の projectId と一致すること、
// 案件の記録 context/projects/<案件ID>.md が実在すること。G-1 を通過済みの既存の案件は、記録ファイルの不在を注意にとどめる(遡って失敗させない)。
// 一致の検査は通過済みでも失敗にする(別の案件の企画書を指している)。機械が見るのは値の一致とファイルの実在だけで、記録の内容は見ない
{
  const cfgId = typeof config.projectId === 'string' ? config.projectId.trim() : '';
  if (cfgId && fm.project_id && fm.project_id !== cfgId) {
    problems.push(`企画書の案件 ID(project_id: ${fm.project_id})が構成の projectId(${cfgId})と一致しません。案件の登録の記録は構成の案件 ID で作ります`);
  } else if (cfgId) {
    const rel = `context/projects/${cfgId}.md`;
    if (!fs.existsSync(path.join(ROOT, rel))) {
      const msg = `案件の記録 ${rel} がありません(案件の登録。S0 の開始時に案件 ID を付けて残す。context/projects/README.md の項目で作る)`;
      if (g1.passed === true) warn(`${msg}(G-1 を通過済みのため、遡って失敗させません)`);
      else g1Dependent(msg);
    }
  }
}
const scopeRowState = briefScopeRowState(text, gateRecs);
for (const [section, key] of REQUIRED_ROWS) {
  const row = lines.find((l) => l.replace(/\*/g, '').startsWith(`| ${key} |`));
  if (!row && key === BRIEF_SCOPE_ROW && scopeRowState === 'gap') {
    warn(BRIEF_SCOPE_GAP_TEXT);
    continue;
  }
  if (!row && key === BRIEF_BASELINE_ROW && g1.passed === true) continue;
  if (!row) {
    const msg = `「${section}」の欄「${key}」がありません(templates/06-project-brief.md の様式から写す)`;
    if (key === BRIEF_SCOPE_ROW || key === BRIEF_BASELINE_ROW) g1Dependent(msg);
    else problems.push(msg);
    continue;
  }
  const value = row.replace(/\*/g, '').slice(`| ${key} |`.length).replace(/\|\s*$/, '').trim();
  if (!isFilledValue(value)) problems.push(`「${section}」の欄「${key}」が未記入です(空欄、または様式の説明 <…> のまま)`);
}

// 7.6 のエスカレーション閾値と 7.7.4 の自動的な上程の閾値(組織が定める値。標準 第1章 1.7.7、第7章 7.6・7.7.2。#419 / ADR-0097)。
// 記録の無い企画書は G-1 の基準4 を満たさない。G-1 を通過済みの企画書は遡って失敗させず、欠落として出す
for (const p of briefThresholdProblems(text, gateRecs, isFilledValue)) {
  if (p.state === 'gap') warn(briefThresholdMessage(p));
  else g1Dependent(briefThresholdMessage(p));
}

// 停止条件の値(標準 第3章 3.12.10 の要求事項4。process-compass #359 / IMPL-0280)。G-1 を通過済みの企画書は遡って失敗させず、欠落として出す。
// 構成の自己修正の上限と異なる値は注意にする(効くのは構成の値)
for (const m of briefStopConditionMessages(briefStopConditionState(text, gateRecs, isFilledValue, config.task ?? {}))) {
  if (m.level === 'problem') g1Dependent(m.text);
  else warn(m.text);
}

// 観点3 の裏づけの出所の区分(標準 第6章 テンプレ6 観点3、ADR-0091。process-compass #411)。G-1 を通過済みの企画書は遡って失敗させず注意にする
{
  const g1Passed = g1.passed === true;
  const ev = briefEvidenceProblems(text);
  if (ev.missing) warn('観点3 の裏づけの表(裏づけ / 出所の区分 / 観測の記録への到達先)がありません(旧い様式)。templates/06-project-brief.md の観点3 から表を写してください(標準 第6章 テンプレ6 観点3)');
  for (const p of ev.problems) {
    if (g1Passed) warn(`${p}(G-1 を通過済みのため、遡って失敗させません。次の改訂で直す)`);
    else g1Dependent(`${p}(標準 第6章 テンプレ6 観点3、ADR-0091)`);
  }
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
  const g1Recs = gateRecs.filter((r) => /^G-1(?!\d)/.test(r.gate ?? '') && r.result === '通過');
  const blankG1 = g1EstimateBlank(text, isFilledValue);
  if (blankG1 === null && quality.cost.present) {
    const msg = '「総費用の内訳」に列「G-1 の時点の見積り」がありません(templates/06-project-brief.md の様式から写す。標準 第7章 7.7.9 の要求事項3)';
    if (g1Recs.length) warn(`${msg}。G-1 を通過済みのため遡って失敗させません。記載の欠落です`);
    else g1Dependent(msg);
  } else if (blankG1 && blankG1.length) {
    const msg = `「総費用の内訳」の列「G-1 の時点の見積り」に空欄の区分があります(${blankG1.join(' / ')})。G-1 の時点では「値」と同じ値を書きます(標準 第7章 7.7.9 の要求事項3)`;
    if (g1Recs.length) warn(`${msg}。G-1 を通過済みのため遡って失敗させません。記載の欠落です`);
    else g1Dependent(msg);
  }
  for (const r of g1Recs) {
    const ver = briefVersionOf(r.text ?? fs.readFileSync(path.join(ROOT, r.file), 'utf8'));
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

// 禁止した一般語のみの欄と、前案件の企画書との同一(標準 第6章 テンプレ6。IMPL-0801・IMPL-0878)。
// 見るのは形式だけ: 欄の値を NFKC にし、空白・句読点・括弧を除いた文字列が様式の名指す語と完全に一致するか、前案件の同じ欄と完全に一致するか。
// 意味は読まない。ほかの一般語のみの記述は G-1 の判定者が確かめる。同一は警告で、承認可否に使わない(同じ組織で目標が同じことがある)
{
  const squash = (s) => String(s ?? '').replace(/\*/g, '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
  const cellsOf = (l) => l.split('|').slice(1, -1).map((c) => c.replace(/\*/g, '').trim());
  const dataRows = (ls) => ls.filter((l) => /^\|/.test(l) && !/^[|:\-\s]+$/.test(l)).map(cellsOf).filter((c) => c.length >= 2);
  const viewsOf = (all) => {
    const v = { 1: [], 2: [] };
    let cur = 0;
    for (const l of all) {
      if (/^##\s+.*観点1/.test(l)) cur = 1;
      else if (/^##\s+.*観点2/.test(l)) cur = 2;
      else if (/^##\s+/.test(l)) cur = 0;
      else if (cur) v[cur].push(l);
    }
    return v;
  };
  const GOAL = '対応する戦略目標';
  const ALT = '現在の代替手段';
  const v = viewsOf(lines);
  const goalRow = dataRows(v[1]).find((c) => c[0] === GOAL);
  if (goalRow && squash(goalRow[1]) === '成長') problems.push(`観点1「${GOAL}」が一般語「成長」のみです。組織が定めた目標を識別できる形で書いてください(標準 第6章 テンプレ6。一般語は様式が名指す語に限って検査します)`);
  for (const c of dataRows(v[2])) {
    if (c[0] === ALT || c[0] === '項目') continue;
    for (const cell of c.slice(1)) {
      if (['知見がある', '実績がある'].includes(squash(cell))) problems.push(`観点2「${c[0]}」が一般語「${squash(cell)}」のみです。何の知見・何の実績かを書いてください(標準 第6章 テンプレ6)`);
    }
  }
  const altRow = lines.map((l) => (/^\|/.test(l) ? cellsOf(l) : [])).find((c) => c[0] === ALT);
  if (altRow && ['ない', 'なし', '無い', '無し'].includes(squash(altRow[1]))) problems.push(`「${ALT}」が「ない」のみです。手作業でも代替手段です。何で代替しているかを書いてください(標準 第6章 テンプレ6)`);

  // 前案件の企画書は採用者が環境変数 PREVIOUS_BRIEF で与える(リポジトリの中のパス、または git show で読める <ref>:<path>)
  const prevSpec = (process.env.PREVIOUS_BRIEF ?? '').trim();
  if (!prevSpec) {
    notice('前案件の企画書(環境変数 PREVIOUS_BRIEF)を与えていないため、前案件の記述との同一の確認をしていません');
  } else {
    let prev = null;
    try {
      const abs = path.resolve(ROOT, prevSpec);
      if (abs.startsWith(ROOT) && fs.existsSync(abs) && fs.statSync(abs).isFile()) prev = fs.readFileSync(abs, 'utf8');
      else prev = execFileSync('git', ['show', prevSpec], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      prev = null;
    }
    if (prev === null) warn(`PREVIOUS_BRIEF(${prevSpec})を読めないため、前案件の記述との同一の確認をしていません`);
    else {
      const pl = prev.split(/\r?\n/);
      const pv = viewsOf(pl);
      const fieldsOf = (ls, vs) => {
        const map = new Map();
        for (const c of [...dataRows(vs[1]), ...dataRows(vs[2]), ...ls.filter((l) => /^\|/.test(l)).map(cellsOf).filter((c) => c[0] === ALT)]) {
          if (c[0] !== '項目' && c.length >= 2) map.set(c[0], squash(c[1]));
        }
        return map;
      };
      const cur = fieldsOf(lines, v);
      const old = fieldsOf(pl, pv);
      for (const [k, val] of cur) {
        if (val && isFilledValue(val) && old.get(k) === val) warn(`欄「${k}」が前案件の企画書(${prevSpec})と同一です。写しのまま判定を受けていないか確かめてください(同一を承認可否に使いません)`);
      }
    }
  }
}

// 立ち上げの順序(標準 第2章 2.8・第5章 5.7 案件の立ち上げ手順。IMPL-0884)。日付の前後だけを見る:
// (a) D-0 の承認日 ≤ (b) 節16 の判定日 ≤ (c) 様式 09 の承認日(表を置いた案件だけ) ≤ (d) G-1 で判定する企画書の版のコミットの日付。
// 読めない日付は「確認できない」と注意に出し、失敗にしない(欠落は check-d0 などが別に落とす)。案件の登録(組織の台帳)はリポジトリの外で確かめない。
// G-1 を通過済みの案件は、D-0 や判定の記録が変化点で改められた日付が企画書より後になり得るため、遡って失敗させず注意にする
{
  const day = (s) => dateOnly(String(s ?? '').trim().replace(/^["']|["']$/g, ''));
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const seq = [];
  const unknown = [];
  const push = (label, d) => (d ? seq.push([label, d]) : unknown.push(label));
  const d0Path = path.join(ROOT, 'docs/D-0-governance.md');
  if (fs.existsSync(d0Path)) {
    const d0 = fs.readFileSync(d0Path, 'utf8');
    push('D-0 の承認日(節11。frontmatter の approved_at)', day(d0.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]?.match(/^approved_at:\s*(.*)$/m)?.[1]));
    push('安全重要度の判定の記録の判定日(D-0 節16)', day(parseClRecord(d0).values.judgedAt));
  } else {
    unknown.push('D-0 の承認日(節11)', '安全重要度の判定の記録の判定日(D-0 節16)');
  }
  const sraPath = path.join(ROOT, 'docs/safety-risk-assessment.md');
  if (fs.existsSync(sraPath)) {
    // sraApprovalProblems と同じ読み方: 節「承認」の表の、記入のあるデータ行の3列目
    const sl = fs.readFileSync(sraPath, 'utf8').split(/\r?\n/);
    const st = sl.findIndex((l) => /^##\s+承認\s*$/.test(l));
    let approvedAt = null;
    for (let i = st + 1; st >= 0 && i < sl.length; i++) {
      if (/^##\s/.test(sl[i])) break;
      if (!/^\|/.test(sl[i]) || /^\|[\s|:-]+\|?\s*$/.test(sl[i])) continue;
      const c = sl[i].split('|').slice(1, -1).map((x) => x.trim());
      if (c[0] !== '作成者' && c.some((x) => isFilledValue(x))) {
        approvedAt = c[2];
        break;
      }
    }
    push('安全リスクアセスメント表の承認日(様式 09)', day(approvedAt));
  }
  const latestG1 = gateRecs.filter((r) => /^G-1(?!\d)/.test(r.gate ?? '') && r.result === '通過').sort((a, b) => String(b.judgedAt ?? '').localeCompare(String(a.judgedAt ?? '')))[0];
  let ver = null;
  if (latestG1) {
    try {
      ver = briefVersionOf(latestG1.text ?? fs.readFileSync(path.join(ROOT, latestG1.file), 'utf8'));
    } catch {
      ver = null;
    }
  }
  const iso = ver ? git(['log', '-1', '--format=%cI', ver]) : git(['log', '-1', '--format=%cI', '--', 'docs/project-brief.md']);
  push(ver ? `G-1 で判定する企画書の版(${ver})のコミットの日付` : '企画書(docs/project-brief.md)の最後のコミットの日付', day(String(iso ?? '').slice(0, 10)));
  if (unknown.length) notice(`立ち上げの順序のうち、確認できない日付があります(${unknown.join(' / ')})。読めた日付の間だけ前後を確かめました`);
  for (let i = 1; i < seq.length; i++) {
    if (seq[i - 1][1] > seq[i][1]) {
      const msg = `立ち上げの順序が逆です: ${seq[i - 1][0]} ${seq[i - 1][1]} が ${seq[i][0]} ${seq[i][1]} より後です。D-0 の承認 → 安全重要度の判定 → 安全リスクアセスメント → 企画書の順に進めます(標準 第2章 2.8・第5章 5.7)`;
      if (g1.passed === true) warn(`${msg}(G-1 を通過済みのため、遡って失敗させません)`);
      else g1Dependent(msg);
    }
  }
}

// テンプレ9(安全リスクアセスメント表)の承認の欄(標準 第6章、第2章 2.8 の手順3b。process-compass #373 突合 X-8 / IMPL-0453)。
// 表を置いた案件で、承認者が作成者と別の名簿の人で AI の名義でないことを確かめる。表の要否(第6章の4条件)は人が判定する。
// G-1 を通過済みの案件は遡って失敗させず注意にする
{
  const sra = path.join(ROOT, 'docs/safety-risk-assessment.md');
  if (fs.existsSync(sra)) {
    const g1Passed = g1.passed === true;
    for (const p of sraApprovalProblems(config, fs.readFileSync(sra, 'utf8'))) {
      if (g1Passed) warn(`${p}(G-1 を通過済みのため、遡って失敗させません)`);
      else g1Dependent(`${p}(承認済みの安全リスクアセスメント表が G-1 の前提条件です。標準 第2章 2.8)`);
    }
    // SR4 が残る間は G-1 の審議を開始できない(第4章 G-1 前提条件3・第2章 2.8。IMPL-0849)。危険源ごとの最新の値の一致だけを見る
    const residual = sraResidualProblems(fs.readFileSync(sra, 'utf8'));
    if (residual.length) {
      const msg = `安全リスクアセスメント表に SR4 の危険源が残っています(Hz: ${residual.join('、')})。SR4 が残る間は G-1 の審議を開始できません(標準 第4章 G-1 前提条件3・第2章 2.8)`;
      if (g1Passed) warn(`${msg}(G-1 を通過済みのため、遡って失敗させません)`);
      else g1Dependent(msg);
    }
  }
}

if (undecided.length) {
  problems.push(
    `G-1 の通過を判定記録で決められない: ${g1.reason}。G-1 を通過済みかを判定記録で確かめられないため、次の欠けを「G-1 の前の失敗」とも「通過済みの欠落」とも決められません` +
      `(遡って失敗させず、黙って通しません)。理由に書いた原因を解いてから実行し直します(記録用ブランチがまだ無い最初の判定の前の案件は、欄を埋めれば解けます): ${undecided.join(' / ')}`
  );
}

for (const p of problems) fail(p);
if (problems.length) {
  console.log('');
  console.log('G-1 企画書の前提条件検査に不合格でした。内容を埋めてから再度お試しください');
  process.exit(1);
}

notice(`G-1 企画書は機械検査を通過しました(承認予定者: ${fm.approver})`);
