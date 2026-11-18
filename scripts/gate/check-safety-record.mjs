// 安全関連部の検証の記録(附属書F F.7)の記載の欠落の検査(G-7 基準7。IMPL-1007・0925・0927・0934。ADR-0221)。
//
// 機械で閉じるのは、記入の形だけである。
//   - F.7 の6項目の置き場の有無と空欄(適用した手法は手法の表、故障挿入の結果は試験項目の表の7行で見る)
//   - 故障挿入の環境の欄の形(種別と識別。実行前の挿入はその旨)
//   - 結果の欄の形(「一致」「不一致」で始める。省く場合は例外承認の ID)
//   - 手法の表の推奨度・出典・適用の記入と、HR の不適用の理由の有無
// 機械で閉じないもの(確かめる者: 独立した評価者と G-7 の判定者):
//   - 内容の妥当性、環境が本番でないこと、試験を実際に行ったこと
//   - 推奨度が規格の表のとおりか、HR の行を表から外していないか(推奨度は記入者の申告)
// この検査を通ったことは、安全の検証が妥当であることを示さない。規格の表は転載しない(出典の欄に番号だけを書かせる)。
//
// 適用は D-0 表10 の F.2 の Q1(はい)か、安全重要度 CL2・CL3(記録の区分と回答の高いほう)。判定できないときは適用として扱う。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, parseLedger, resolveSigner, aiNameBlocked } from './config.mjs';
import { parseClRecord, classOf, f2Q1OfParsed } from './cl-judgment.mjs';
import { exceptionStanding } from './exception-expiry.mjs';

export const SAFETY_RECORD_FILE = 'docs/safety-risk-assessment.md';
export const SAFETY_RECORD_HEADING = /^##\s+安全関連部の検証の記録/;

/** F.7 の6項目のうち、行の有無と空欄を見る4項目。値は様式の初期の文(templates/09-safety-risk-assessment.md と一致を試験で固定する) */
export const ROW_ITEMS = {
  安全関連部の切り分け: '範囲 / そう判断した根拠',
  適用規格と安全度水準: '特定した規格 / 要求される水準 / 特定の根拠',
  'AI の利用': 'モデルの版 / 指示の保存場所 / テスト生成の分離の段階 / 段階「最強」の検証の担当者と、その組織上の距離の段と段の根拠',
  独立した評価: '評価者 / 評価者の組織上の距離の段と段の根拠 / 評価の結論',
};
/** 機械では見ない条件つきの行(F.7 の6項目に無い) */
export const NOT_CHECKED_ITEMS = ['安全関連ソフトウェアの区分(機械類の制御)', '実行時の不変条件の確認', '監視の実装', '生成された行の検証'];
export const FAULT_ITEM_COUNT = 7;
export const ENV_KINDS = ['試験台の実機', '模擬環境', '専門部門の設備'];
export const PRE_EXECUTION = '実行前の挿入';
export const METHOD_COLUMNS = ['手法', '推奨度', '出典', '適用', 'しない理由'];

const norm = (v) => String(v ?? '').replace(/\*/g, '').normalize('NFKC').trim();

/**
 * 空欄に数える値。セル全体が一致するときだけ数える(理由を添えた「なし(…)」は通す)。
 * 空白・ダッシュ・TBD・未定・後日・不明・なし・無し・該当なし・N/A・<…>・様式の初期の文
 */
export function isBlankCell(v, initial = []) {
  const s = norm(v);
  if (!s) return true;
  if (/^[—\-–ー―‐_.。・?]+$/.test(s)) return true;
  if (/^(tbd|todo|n\/?a|未定|後日|不明|なし|無し|該当なし|未記入|空欄)$/i.test(s)) return true;
  if (/^<.*>$/.test(s)) return true;
  return initial.some((i) => norm(i) === s);
}

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

/** 記録の節(見出しから次の「## 」まで)を読む */
export function parseSafetyRecord(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => SAFETY_RECORD_HEADING.test(l));
  if (start < 0) return { present: false, items: new Map(), faults: new Map(), methods: { present: false, rows: [] } };
  const items = new Map();
  const faults = new Map();
  const methods = { present: false, rows: [] };
  let table = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) break;
    if (!/^\s*\|/.test(l)) {
      if (table && l.trim() !== '' && !/^```/.test(l.trim())) table = null;
      continue;
    }
    const c = cellsOf(l);
    if (c.every((x) => /^:?-+:?$/.test(x))) continue;
    const head = norm(c[0]);
    if (head === '項目') { table = 'items'; continue; }
    if (head === '#') { table = 'faults'; continue; }
    if (head === '手法') { table = 'methods'; methods.present = true; continue; }
    if (table === 'items') {
      if (!items.has(head)) items.set(head, c.slice(1).join(' | '));
    } else if (table === 'faults') {
      const n = Number(head);
      if (Number.isInteger(n) && !faults.has(n)) faults.set(n, { env: c[2] ?? '', result: c[3] ?? '', line: i + 1 });
    } else if (table === 'methods') {
      methods.rows.push({ cells: METHOD_COLUMNS.map((_, k) => c[k] ?? ''), line: i + 1 });
    }
  }
  return { present: true, items, faults, methods };
}

/** 環境の欄の形。通れば null、通らなければ理由 */
export function envProblem(env) {
  const s = norm(env);
  if (isBlankCell(s)) return '未記入';
  if (s === PRE_EXECUTION) return null;
  const kinds = ENV_KINDS.join('|');
  // 識別は括弧を含まない(括弧を2組持つ形は、後ろの括弧に別の語を足せるため通さない。R1-01)
  const m = s.match(new RegExp(`^(${kinds})\\s*(?:[(（]\\s*([^()（）]+?)\\s*[)）]|[:：]\\s*([^()（）]+))$`));
  if (m) return isBlankCell(m[2] ?? m[3]) ? '識別が空欄' : null;
  if (ENV_KINDS.includes(s)) return '種別だけで識別がない(F.7 は環境の識別を求める)';
  return `「${ENV_KINDS.join('・')}(識別)」か「${PRE_EXECUTION}」の形でない`;
}

const EXCEPTION_RE = /^例外承認\s*[:：]\s*(D-\d+)/;

/** 結果の欄の形。通れば null、通らなければ理由。ledgerRows は技術負債台帳の行(null なら例外承認の ID を確かめられない) */
export function resultProblem(result, { ledgerRows = null, day = null, isValidApprover = null } = {}) {
  const s = norm(result);
  if (isBlankCell(s)) return '未記入';
  if (/^(一致|不一致)/.test(s)) return null;
  const m = s.match(EXCEPTION_RE);
  if (m) {
    const row = (ledgerRows ?? []).find((r) => r.id === m[1] && r.kind === '例外');
    if (!row) return `例外承認の ID ${m[1]} が技術負債台帳の区分「例外」に無い`;
    const st = exceptionStanding(row, day ?? new Date().toISOString().slice(0, 10));
    if (st !== 'active') return `例外承認 ${m[1]} が成立していない(効力: ${st})`;
    // 承認者(様式 03 が区分「例外」の行で必須とする欄)。空欄・名簿の外・AI の名義は成立させない(R1-02)。照合の手段が無ければ確かめられないので通さない
    const who = norm(row.approver);
    if (isBlankCell(who)) return `例外承認 ${m[1]} の承認者が空欄`;
    if (typeof isValidApprover !== 'function') return `例外承認 ${m[1]} の承認者を確かめられない(名簿との照合の手段が無い)`;
    return isValidApprover(who) ? null : `例外承認 ${m[1]} の承認者「${who}」が名簿の人でない、または AI の名義`;
  }
  return '「一致」「不一致」で始まらない(項目を省く場合は「例外承認: <行の ID>」)';
}

/** 記録の本文から記載の欠落を出す。text が null なら記録のファイルが無い */
export function safetyRecordProblems(text, { ledgerRows = null, day = null, isValidApprover = null } = {}) {
  const out = [];
  const where = '節「安全関連部の検証の記録」';
  if (text === null || text === undefined) return { problems: [`${SAFETY_RECORD_FILE} がありません`], hr: null };
  const rec = parseSafetyRecord(text);
  if (!rec.present) return { problems: [`${SAFETY_RECORD_FILE} に${where}がありません`], hr: null };
  for (const [label, initial] of Object.entries(ROW_ITEMS)) {
    if (!rec.items.has(label)) out.push(`${where}の項目「${label}」の行がありません`);
    else if (isBlankCell(rec.items.get(label), [initial])) out.push(`${where}の項目「${label}」が未記入です`);
  }
  // 適用した手法(手法の表)
  let hr = null;
  if (!rec.methods.present) {
    out.push(`${where}の項目「適用した手法」の手法の表がありません`);
  } else {
    const rows = rec.methods.rows.filter((r) => r.cells.some((c) => !isBlankCell(c)));
    if (!rows.length) out.push(`${where}の項目「適用した手法」の手法の表に行がありません`);
    let n = 0;
    let m = 0;
    rows.forEach((r, k) => {
      const [name, level, source, apply, reason] = r.cells;
      const at = `手法の表の${k + 1}行目(${r.line}行)`;
      if (isBlankCell(name)) out.push(`${at}の手法が空欄です`);
      if (isBlankCell(level)) out.push(`${at}の推奨度が空欄です`);
      if (isBlankCell(source)) out.push(`${at}の出典が空欄です`);
      const a = norm(apply);
      if (a !== '適用' && a !== 'しない') out.push(`${at}の適用が「適用」「しない」のどちらでもありません`);
      const isHr = /^HR/i.test(norm(level));
      if (isHr) n++;
      if (isHr && a === 'しない') {
        m++;
        if (isBlankCell(reason)) out.push(`${at}は推奨度が HR で適用が「しない」のに、しない理由が空欄です`);
      }
    });
    hr = { n, m };
  }
  // 故障挿入の結果(試験項目の表の7行)
  for (let n = 1; n <= FAULT_ITEM_COUNT; n++) {
    const f = rec.faults.get(n);
    if (!f) {
      out.push(`${where}の故障挿入の試験項目の表に、項目${n}の行がありません`);
      continue;
    }
    const e = envProblem(f.env);
    if (e) out.push(`故障挿入の試験項目${n}(${f.line}行)の挿入した環境: ${e}`);
    const r = resultProblem(f.result, { ledgerRows, day, isValidApprover });
    if (r) out.push(`故障挿入の試験項目${n}(${f.line}行)の結果: ${r}`);
  }
  return { problems: out, hr };
}

/**
 * 適用の判定。q1: 真=はい・偽=いいえ・null=読めない。cls: D-0 の記録の区分と構成の回答の区分(cl0〜cl3 か null)。
 * 適用外にするのは、Q1 が「いいえ」と読め、かつ区分が読めて CL0・CL1 のときだけ。判定できないときは適用として扱う
 */
export function safetyRecordApplies({ q1, classes = [] }) {
  const ranks = classes.filter(Boolean).map((c) => Number(String(c).slice(2)));
  const high = ranks.length ? Math.max(...ranks) : null;
  if (q1 === true) return { applies: true, why: 'D-0 表10 の F.2 の Q1 が「はい」' };
  if (high !== null && high >= 2) return { applies: true, why: `安全重要度 CL${high}` };
  if (q1 === false && high !== null) return { applies: false, why: '適用外(Q1 いいえ・CL0/CL1)' };
  return { applies: true, why: '適用を判定できない(Q1 または区分を読めない)ため適用として扱う' };
}

/** 案件の D-0 と記録を読んで検査する */
export function checkSafetyRecord({ root = ROOT, config = null, day = null } = {}) {
  const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : null);
  const d0 = read('docs/D-0-governance.md');
  let q1 = null;
  const classes = [classOf(config?.answers?.['q-criticality'])];
  if (d0 !== null) {
    const p = parseClRecord(d0);
    if (p.present) {
      q1 = f2Q1OfParsed(p);
      classes.push(classOf(p.values.cls));
    }
  }
  // 承認者は名簿の人で、AI の名義でないこと(resolveSigner と aiNameBlocked。構成が無ければ名簿の人と確かめられない)
  const isValidApprover = (name) => {
    if (!config) return false;
    const p = resolveSigner(config, name);
    return !!p && !aiNameBlocked(config, p.name) && !aiNameBlocked(config, name);
  };
  const ap = safetyRecordApplies({ q1, classes });
  if (!ap.applies) return { applies: false, why: ap.why, problems: [], hr: null };
  const ledgerText = read('docs/debt-ledger.md');
  const { problems, hr } = safetyRecordProblems(read(SAFETY_RECORD_FILE), { ledgerRows: ledgerText ? parseLedger(ledgerText) : null, day, isValidApprover });
  return { applies: true, why: ap.why, problems, hr };
}

/** 基準7 の結果の文。内容の妥当性は確かめていないことを同じ文に書く */
export function safetyRecordResultText(r) {
  const tail = '記載の欠落の検査のみ。内容の妥当性は確かめていない';
  if (!r.applies) return `${r.why}。${tail}`;
  const hr = r.hr ? `。HR の行 ${r.hr.n} 件・うち不適用 ${r.hr.m} 件(推奨度は記入者の申告)` : '';
  return `適用(${r.why})。記載の欠落 ${r.problems.length} 件${hr}。${tail}`;
}
