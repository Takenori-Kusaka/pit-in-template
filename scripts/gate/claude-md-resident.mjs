// CLAUDE.md の常駐の規則(構成依存部分の外)を、節と規則ごとに照合する。
//
// CLAUDE.md は規則の索引であり、構成依存部分(目印の区間)の外に、標準の規定を常駐させています。
// 既存のリポジトリへ持ち込むとき、既存の CLAUDE.md を残して区間の目印だけを足すと、常駐の規則が
// 1 つも無いまま、構成依存部分の検査は通ります(process-compass #306 の調査で確かめた経路)。
// check-process-rules.mjs が、この一覧の節と規則が案件の CLAUDE.md にあることを確かめます。
//
// 照合の単位は規則(1行が1つの規則。process-compass #314 / ADR-0083 決定2)。一覧は規則ごとに
// 識別子・節・核の文言を持ちます。照合は正規化(太字・逆引用符・リンクの記法・HTML コメント・空白の違いを除く)
// したうえで、核の文言が同じ節のいずれかの行に含まれることを確かめます。
// HTML コメントは、行に分ける前に、複数行にわたるものも行番号を保って空行へ置き換えます。描画されない
// コメントの中の規則を、規則があると数えないためです(process-compass #314 の突合 X-5)。
//   - 案件が行の前後へ書き足すこと、節の中で行を並べ替えること、節へ行を足すことは妨げません
//   - 核の文言を変えること(否定を除く等)は標準の規定の書き換えであり、照合が落ちるのは真の検出です
//   - 表の行の核は、列の見出しが「#」「止める仕組み」「例」以外の升です(止める仕組みは案件の CI に合わせて書き換えてよい)
//
// 一覧の正本は、テンプレートの CLAUDE.md です。CLAUDE.md の規則を足したら、次で一覧へ追加します。
//   node scripts/gate/check-process-rules.mjs --write-resident
// 作り直しは追加だけです。一覧から規則を除くことは強制層の縮小であり、`state:needs-platform` を経て、
// 除いた規則を omit へ移します(手で編集する。作り直しは omit の規則を足し戻しません)。
// omit の各項目には reason(除く理由)と approvedBy(承認した AI維持管理者の氏名。AI の名義は受け付けない)が要ります。
// check-process-rules.mjs が、欠けた項目を落とします(process-compass #314 の突合 X-12)。
// test-init-g5.mjs が、一覧とテンプレートの CLAUDE.md の一致を確かめ、
// test-claude-md-resident.mjs が、試験の中に持つ固定の写しへの変異(行の削除・節の置き換え・否定の除去・
// 複数行のコメントで囲む)で落ちることを確かめます。
//
// 機械で止まらないこと(ADR-0083 決定2 の限界): 案件が CLAUDE.md の行と一覧の規則を同じ変更で消すこと
// (差分のレビューだけが拾う)、行末へ打ち消し(「当社では適用しない」等)を書き足すこと。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

export const RESIDENT_FILE = path.join(ROOT, 'scripts', 'gate', 'claude-md-resident.json');

// 構成依存部分を置く節。目印の区間は check-process-rules.mjs が別に確かめる
const GENERATED_HEADING = 'このプロジェクトの構成(自動生成)';

/** HTML コメント(複数行にわたるものを含む)を、改行だけを残して消す。行番号は保たれる */
export function blankComments(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

/** 見出し(## と ###)と、その下に本文があるかを返す。コードブロックの中は見出しとして数えない */
export function parseSections(text) {
  const sections = [];
  let inFence = false;
  let current = null;
  for (const raw of blankComments(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      if (current) current.hasBody = true;
      continue;
    }
    const m = inFence ? null : /^(#{2,3})\s+(.+?)\s*$/.exec(raw);
    if (m) {
      current = { level: m[1].length, heading: m[2], hasBody: false };
      sections.push(current);
      continue;
    }
    // HTML コメントだけの行(目印など)は本文に数えない
    if (current && raw.trim() !== '' && !/^\s*<!--.*-->\s*$/.test(raw)) current.hasBody = true;
  }
  return sections;
}

/** 照合のための正規化。HTML コメント・太字と斜体の記号・逆引用符・リンクの記法・全角半角と空白の違いを除く */
export function normalizeRule(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/<!--.*?-->/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 表の列のうち、核に含めないもの(行の番号と、案件の CI・例に合わせて書き換えてよい列)
const NON_CORE_COLUMNS = new Set(['#', '止める仕組み', '例']);
// 規則ではなく所在だけを示す行
const POINTER_LINE = /^(?:理由|詳細)(?:\([^)]*\))?\s*[::]/;

const cellsOf = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

/**
 * 構成依存部分の外の、節ごとの規則の核の文言を返す。{ section, core } の一覧(出現の順)。
 *   - 箇条書きの行と、太字で始まる段落の行: 行の文。`[機械]` の注記と、行の中の所在(詳細: / 理由:)より前。所在だけの行は除く
 *   - 表の行: 核に含める列の升を「 / 」でつなぐ
 * 節の外(最初の ## より前)と構成依存部分の節は含めない。コードブロックの中は読まない
 */
export function extractRules(text) {
  const rules = [];
  let inFence = false;
  let section = null;
  let header = null;
  for (const raw of blankComments(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{2,3})\s+(.+?)\s*$/.exec(raw);
    if (h) {
      section = h[2] === GENERATED_HEADING ? null : h[2];
      header = null;
      continue;
    }
    if (section === null) continue;
    const line = raw.replace(/<!--.*?-->/g, '').trim();
    if (!line) {
      header = null;
      continue;
    }
    if (line.startsWith('|')) {
      const cells = cellsOf(line);
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
      if (header === null) {
        header = cells.map(normalizeRule);
        continue;
      }
      const core = cells
        .filter((_, i) => !NON_CORE_COLUMNS.has(header[i] ?? ''))
        .map(normalizeRule)
        .filter(Boolean)
        .join(' / ');
      if (core) rules.push({ section, core });
      continue;
    }
    header = null;
    const item = /^(?:[-*]|\d+\.)\s+/.test(line);
    // 段落の行は、太字で始まるもの(規則の文)だけを数える。説明の段落は規則ではない
    if (!item && !line.startsWith('**')) continue;
    let body = line.replace(/^(?:[-*]|\d+\.)\s+/, '');
    if (POINTER_LINE.test(normalizeRule(body))) continue;
    body = body.split('`[機械]`')[0];
    const core = normalizeRule(body)
      .split(/\s*(?:詳細|理由)(?:\([^)]*\))?\s*[::]/)[0]
      .replace(/。\s*$/, '')
      .trim();
    if (core) rules.push({ section, core });
  }
  return rules;
}

/** 案件の CLAUDE.md の節ごとの、正規化した行(表の行は核に含める列の升をつないだもの)の一覧 */
function linesBySection(text) {
  const map = new Map();
  let inFence = false;
  let section = null;
  let header = null;
  for (const raw of blankComments(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{2,3})\s+(.+?)\s*$/.exec(raw);
    if (h) {
      section = h[2];
      header = null;
      if (!map.has(section)) map.set(section, []);
      continue;
    }
    if (section === null) continue;
    const line = raw.replace(/<!--.*?-->/g, '').trim();
    if (!line) {
      header = null;
      continue;
    }
    if (line.startsWith('|')) {
      const cells = cellsOf(line);
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
      if (header === null) {
        header = cells.map(normalizeRule);
        continue;
      }
      map.get(section).push(cells.filter((_, i) => !NON_CORE_COLUMNS.has(header[i] ?? '')).map(normalizeRule).filter(Boolean).join(' / '));
      continue;
    }
    header = null;
    map.get(section).push(normalizeRule(line));
  }
  return map;
}

/**
 * テンプレートの CLAUDE.md から、常駐の規則の一覧を作る。追加だけ:
 * 既存の一覧(previous)の節と規則は残し、無い規則に次の番号を振って足す。omit にある核の文言は足し戻さない
 */
export function buildManifest(text, previous = null) {
  const sections = [...(previous?.sections ?? [])];
  const seenSec = new Set(sections.map((s) => `${s.level}:${s.heading}`));
  for (const s of parseSections(text)) {
    if (s.heading === GENERATED_HEADING) continue;
    const key = `${s.level}:${s.heading}`;
    if (seenSec.has(key)) continue;
    seenSec.add(key);
    sections.push({ level: s.level, heading: s.heading });
  }
  const rules = [...(previous?.rules ?? [])];
  const omit = [...(previous?.omit ?? [])];
  const known = new Set([...rules, ...omit].map((r) => `${r.section}\u0000${r.core}`));
  let next = Math.max(0, ...[...rules, ...omit].map((r) => Number(/^CR-(\d+)$/.exec(r.id)?.[1] ?? 0))) + 1;
  for (const r of extractRules(text)) {
    const key = `${r.section}\u0000${r.core}`;
    if (known.has(key)) continue;
    known.add(key);
    rules.push({ id: `CR-${String(next++).padStart(3, '0')}`, section: r.section, core: r.core });
  }
  return {
    schemaVersion: 1,
    note:
      'CLAUDE.md の常駐の規則の一覧(節と、規則ごとの核の文言)。正本はテンプレートの CLAUDE.md。' +
      '追加: node scripts/gate/check-process-rules.mjs --write-resident(追加だけ)。' +
      '規則を除くのは強制層の縮小であり、state:needs-platform を経て omit へ移す。' +
      'omit の各項目には reason(理由)と approvedBy(承認した AI維持管理者の氏名。AI の名義は不可)を書く',
    sections,
    rules,
    omit,
  };
}

/**
 * omit の項目の不備を返す。各項目に reason と approvedBy が要り、approvedBy は AI の名義であってはならない。
 * aiReason(name) は、AI の名義なら理由の文、そうでなければ null を返す関数
 */
export function omitProblems(manifest, aiReason) {
  const out = [];
  for (const o of manifest?.omit ?? []) {
    const id = o?.id ?? '(識別子なし)';
    if (!o || typeof o.reason !== 'string' || !o.reason.trim()) out.push(`${id}: reason(除く理由)がありません`);
    if (!o || typeof o.approvedBy !== 'string' || !o.approvedBy.trim()) out.push(`${id}: approvedBy(承認した AI維持管理者の氏名)がありません`);
    else {
      const why = aiReason(o.approvedBy);
      if (why) out.push(`${id}: approvedBy "${o.approvedBy}" は ${why}。AI の名義の承認を受け付けません`);
    }
  }
  return out;
}

export function loadManifest() {
  if (!fs.existsSync(RESIDENT_FILE)) return null;
  return JSON.parse(fs.readFileSync(RESIDENT_FILE, 'utf8'));
}

/**
 * 一覧の節のうち、CLAUDE.md に見出しが無いもの、見出しはあるが本文が無いもの、
 * 一覧の規則のうち、同じ節のどの行にも核の文言が含まれないものを返す
 */
export function missingResident(text, manifest) {
  const found = new Map();
  for (const s of parseSections(text)) {
    const key = `${s.level}:${s.heading}`;
    found.set(key, (found.get(key) ?? false) || s.hasBody);
  }
  const absent = [];
  const empty = [];
  for (const s of manifest.sections ?? []) {
    const key = `${s.level}:${s.heading}`;
    if (!found.has(key)) absent.push(s);
    else if (!found.get(key)) empty.push(s);
  }
  const lines = linesBySection(text);
  const rules = [];
  for (const r of manifest.rules ?? []) {
    const ls = lines.get(r.section) ?? [];
    const core = normalizeRule(r.core);
    if (!ls.some((l) => l.includes(core))) rules.push(r);
  }
  return { absent, empty, rules };
}
