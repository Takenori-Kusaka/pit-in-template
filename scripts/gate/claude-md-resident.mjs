// CLAUDE.md の常駐の規則(構成依存部分の外)の節を数える。
//
// CLAUDE.md は規則の索引であり、構成依存部分(目印の区間)の外に、標準の規定を常駐させています。
// 既存のリポジトリへ持ち込むとき、既存の CLAUDE.md を残して区間の目印だけを足すと、常駐の規則が
// 1 つも無いまま、構成依存部分の検査は通ります(process-compass #306 の調査で確かめた経路)。
// check-process-rules.mjs が、この一覧の節が案件の CLAUDE.md にあることを確かめます。
//
// 確かめるのは、節の見出しがあることと、見出しの下に本文があることまでです。
// 節の中の個々の行(1行が1つの規則)の有無は確かめません。案件が節を足すこと、節の中へ行を足すことは妨げません。
//
// 一覧の正本は、テンプレートの CLAUDE.md です。CLAUDE.md の節を変えたら、次で一覧を作り直します。
//   node scripts/gate/check-process-rules.mjs --write-resident
// test-init-g5.mjs が、一覧とテンプレートの CLAUDE.md の一致を確かめます。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

export const RESIDENT_FILE = path.join(ROOT, 'scripts', 'gate', 'claude-md-resident.json');

// 構成依存部分を置く節。目印の区間は check-process-rules.mjs が別に確かめる
const GENERATED_HEADING = 'このプロジェクトの構成(自動生成)';

/** 見出し(## と ###)と、その下に本文があるかを返す。コードブロックの中は見出しとして数えない */
export function parseSections(text) {
  const sections = [];
  let inFence = false;
  let current = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
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

/** テンプレートの CLAUDE.md から、常駐の規則の節の一覧を作る */
export function buildManifest(text) {
  return {
    schemaVersion: 0,
    note:
      'CLAUDE.md の常駐の規則の節の一覧。正本はテンプレートの CLAUDE.md。' +
      '作り直し: node scripts/gate/check-process-rules.mjs --write-resident',
    sections: parseSections(text)
      .filter((s) => s.heading !== GENERATED_HEADING)
      .map((s) => ({ level: s.level, heading: s.heading })),
  };
}

export function loadManifest() {
  if (!fs.existsSync(RESIDENT_FILE)) return null;
  return JSON.parse(fs.readFileSync(RESIDENT_FILE, 'utf8'));
}

/** 一覧の節のうち、CLAUDE.md に見出しが無いもの、見出しはあるが本文が無いものを返す */
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
  return { absent, empty };
}
