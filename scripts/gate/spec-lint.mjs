// 受入基準の曖昧語を検出する(G-5 基準4)。
//
//   node scripts/gate/spec-lint.mjs [対象ディレクトリ...]
//
// 既定の対象は機能仕様の置き場(specs/F-NNN/ の .md)だけです。1件でも検出したら失敗させます。
// 曖昧語が残った受入基準は、実装されるか否かが不定になるためです。
//
// CI(gate-g5 の spec-lint ジョブ)は引数なしで実行します。手元でも引数なしで実行すれば、CI と同じ範囲を見ます。
// 様式(templates/)・判定記録や体制図(docs/)・生成物は対象にしません。受入基準を持たない文書の語を
// G-5 の失敗にすると、初期化した直後から G-5 が落ち、受入基準の曖昧さを検出する目的から外れるためです(#286)。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, fail, notice } from './config.mjs';

/** 第4章 G-2 の禁止語(初期値)。組織で追加してよい */
const BANNED = [
  '適切に',
  '柔軟に',
  '可能な限り',
  'など',
  '必要に応じて',
  '基本的に',
  '原則として',
  '速やかに',
  '十分に',
  'なるべく',
];

const explicit = process.argv.slice(2);
/** 既定の対象: 機能仕様の置き場 specs/F-NNN/(specs/README.md のような案内は含めない) */
const DEFAULT_ROOT = 'specs';
const FEATURE_DIR = /^specs\/F-\d+\//;
const targets = explicit.length ? explicit : [DEFAULT_ROOT];

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
let inFence = false;

for (const f of files) {
  const rel = path.relative(ROOT, f);
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (/<!--\s*spec-lint-ok/.test(line)) return;
    for (const w of BANNED) {
      let idx = line.indexOf(w);
      while (idx >= 0) {
        hits++;
        fail(`${rel}:${i + 1}:${idx + 1} 曖昧語 "${w}" があります。条件と期待動作で書き直してください`);
        idx = line.indexOf(w, idx + w.length);
      }
    }
  });
}

console.log(`spec-lint: ${files.length} ファイルを検査、${hits} 件検出`);
process.exit(hits ? 1 : 0);
