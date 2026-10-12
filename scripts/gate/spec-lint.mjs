// 受入基準の曖昧語を検出する(G-5 基準4)。
//
//   node scripts/gate/spec-lint.mjs [対象ディレクトリ...]
//   node scripts/gate/spec-lint.mjs --terms     検出語の一覧を出す
//
// 既定の対象は機能仕様の置き場(specs/F-NNN/ の .md)の、受入基準の節(見出しが「受入基準」で始まる節)だけです。
// 1件でも検出したら失敗させます。曖昧語が残った受入基準は、実装されるか否かが不定になるためです。
//
// 検出語の正本は、標準 第4章 G-2 の検出語の表です。本スクリプトは、その表を複製した知識ベース
// (scripts/vendor/tailoring-kb.json の ambiguousTerms)を読みます。語をここへ書き写しません。
// 標準の規範は語ではなく類(逃げ道になる句・程度を定めない副詞と形容詞・末尾を開いた列挙)です。
// 検出語は、機械が落とす最低限の語です。表に無い語が類に当たるかは、G-2 の判定者が判定します。
//
// 検査するのは受入基準の節だけです(標準 第4章 G-2)。スコープ外の節、前提の節、実装計画は検査しません。
// CI(gate-g5 の spec-lint ジョブ)は引数なしで実行します。手元でも引数なしで実行すれば、CI と同じ範囲を見ます。
// 様式(templates/)・判定記録や体制図(docs/)・生成物は対象にしません。受入基準を持たない文書の語を
// G-5 の失敗にすると、初期化した直後から G-5 が落ち、受入基準の曖昧さを検出する目的から外れるためです(#286)。
//
// 除外の印(標準 第4章 G-2): 検出語が、合否を一意に判定できる文の一部として現れる行は、行末に
//   <!-- spec-lint-ok: 理由 -->
// を書いて検出から外せます。理由の無い印は無効です(検出します)。除外した行の件数と所在を、結果に出します。
//
// 機械の限界: 語の部分一致で検出します。言い換え、表記の違い(ひらがな書きなど)、文脈は判定しません。
// コードブロックの中は検査しません。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, fail, notice } from './config.mjs';

/** 標準 第4章 G-2 の検出語(知識ベースへ複製したもの)。減らさない */
const KB_FILE = path.join(ROOT, 'scripts/vendor/tailoring-kb.json');
const KB_TERMS = (JSON.parse(fs.readFileSync(KB_FILE, 'utf8')).ambiguousTerms ?? []).map((t) => t.term);
if (!KB_TERMS.length) {
  fail('scripts/vendor/tailoring-kb.json に検出語(ambiguousTerms)がありません。知識ベースを標準から複製し直してください');
  process.exit(1);
}

/** 組織が足す検出語(テンプレート独自の置き場。標準 第4章 G-2 は、足すことを許容し、減らすことを禁じる) */
const EXTRA_TERMS = [];

const TERMS = [...new Set([...KB_TERMS, ...EXTRA_TERMS])];

const args = process.argv.slice(2);
if (args.includes('--terms')) {
  console.log(TERMS.join(' / '));
  process.exit(0);
}

const explicit = args.filter((a) => !a.startsWith('--'));
/** 既定の対象: 機能仕様の置き場 specs/F-NNN/(specs/README.md のような案内は含めない) */
const DEFAULT_ROOT = 'specs';
const FEATURE_DIR = /^specs\/F-\d+\//;
const targets = explicit.length ? explicit : [DEFAULT_ROOT];

/** 受入基準の節の見出し(様式 templates/01-feature-spec.md の「## 受入基準」。見出しの階層は問わない) */
const AC_HEADING = /^(#{1,6})\s*受入基準/;
const ANY_HEADING = /^(#{1,6})\s+\S/;
/** 除外の印。理由(コロンの後ろ)が空の印は無効 */
const EXEMPT = /<!--\s*spec-lint-ok\s*(?:[::]\s*(.*?))?\s*-->/;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  if (fs.statSync(dir).isFile()) {
    if (dir.endsWith('.md')) out.push(dir);
    return;
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
}

const found = [];
for (const t of targets) walk(path.join(ROOT, t), found);
const files = explicit.length ? found : found.filter((f) => FEATURE_DIR.test(path.relative(ROOT, f).split(path.sep).join('/')));

if (!files.length) {
  notice(`検査対象がありません(${explicit.length ? targets.join(', ') : '機能仕様 specs/F-NNN/'})`);
  process.exit(0);
}

let hits = 0;
let sections = 0;
const exempted = [];

for (const f of files) {
  const rel = path.relative(ROOT, f);
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  let inFence = false;
  // 受入基準の節の見出しの階層。null は節の外
  let level = null;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const ac = AC_HEADING.exec(line);
    if (ac) {
      level = ac[1].length;
      sections++;
      return;
    }
    const h = ANY_HEADING.exec(line);
    if (h && level !== null && h[1].length <= level) level = null;
    if (level === null) return;

    const found = [];
    for (const w of TERMS) {
      let idx = line.indexOf(w);
      while (idx >= 0) {
        found.push([w, idx]);
        idx = line.indexOf(w, idx + w.length);
      }
    }
    if (!found.length) return;

    const mark = EXEMPT.exec(line);
    // 印の中の語は数えない(理由の文に検出語が入ることがある)
    const outside = mark ? found.filter(([, idx]) => idx < mark.index || idx >= mark.index + mark[0].length) : found;
    if (!outside.length) return;
    const reason = (mark?.[1] ?? '').trim();
    if (mark && reason) {
      exempted.push({ rel, line: i + 1, terms: [...new Set(outside.map(([w]) => w))], reason });
      return;
    }
    for (const [w, idx] of outside) {
      hits++;
      fail(
        `${rel}:${i + 1}:${idx + 1} 曖昧語 "${w}" があります。条件と期待動作で書き直してください` +
          (mark ? '(除外の印に理由がありません。<!-- spec-lint-ok: 理由 --> の形で理由を書いた印だけが有効です)' : '')
      );
    }
  });
}

for (const e of exempted) {
  notice(`${e.rel}:${e.line} 除外の印で検出から外しました(語: ${e.terms.join('・')}。理由: ${e.reason})`);
}
console.log(
  `spec-lint: ${files.length} ファイルの受入基準の節 ${sections} 個を検査、${hits} 件検出、除外の印で外した行 ${exempted.length} 件` +
    (exempted.length ? '(除外した行が類に当たらないことは、G-2・G-4 の判定者が確かめます)' : '')
);
process.exit(hits ? 1 : 0);
