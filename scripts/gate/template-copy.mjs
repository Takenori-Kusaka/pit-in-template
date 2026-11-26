// 自己試験が使う、作業ツリーの複製の補助(`test-` で始めないので試験としては走らない。process-compass #361 D-1)。
//
// 自己試験は、道具(scripts/・.github/・templates/ ほか)を一時の置き場へ写し、初期化し直したり、集約を動かしたりする。
// 採用者のリポジトリで流すとき、作業ツリーをそのまま写すと、採用者の状態が試験の前提を壊す:
//   - 採用者の `process.config.json`(configured: true)が入り、「未設定のテンプレートから初期化する」前提が崩れる
//   - 採用者の製品のコード(go.mod・cmd/ など)が入り、初期化が「宣言していないスタック」で止まる
// そこで、写すときに次の2つだけを採用者の状態から外す(除外式。それ以外は従来どおり写す):
//   1. 製品のコード(stack-coverage.mjs の stackOfFile・isProductCandidate が製品のコードと数えるファイル)と、初期化が足す開発の基盤のファイル
//   2. `process.config.json` は、道具が持つ未設定の既定(fixtures/process.config.default.json)に置き換える
// 除外式のままにする理由: 足し忘れた置き場の検査が、緑のまま欠ける向き(fail-open)へ倒れない。
// 既定の構成の正本は、テンプレート自身の `process.config.json`(未設定)。同期は test-template-copy.mjs が確かめる。
//
// GitHub へ問い合わせません。リポジトリの状態を変えません。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from './config.mjs';
import { scaffoldStack } from '../init/generate-profile.mjs';
import { isProductCandidate, stackOfFile } from './stack-coverage.mjs';

/** 複製しない置き場(従来の各試験の SKIP と同じ) */
export const COPY_SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);

/** 道具が持つ未設定の既定の構成の置き場 */
export const DEFAULT_CONFIG_FILE = path.join(ROOT, 'scripts/gate/fixtures/process.config.default.json');

/**
 * 初期化が開発の基盤として足すファイル(.secretlintrc.json・tests/README.md ほか)。scaffoldStack を空の置き場で
 * 動かして導く(一覧を手で持たない)。採用者の作業ツリーでは、これらが「既存の統制の資産」として事前点検に数えられ、
 * 初期化し直す試験が止まる
 */
export function scaffoldFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-scaffold-'));
  const names = new Set();
  try {
    for (const stack of ['node', 'python', 'python-poetry', 'python-uv', 'go', 'none', 'undetermined']) {
      for (const rel of scaffoldStack(stack, dir).created) names.add(rel);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return names;
}

/** 採用者の製品のコードか(複製から外す) */
export function isAdopterProductFile(rel) {
  const p = rel.replace(/\\/g, '/');
  return stackOfFile(p) !== null && isProductCandidate(p);
}

/**
 * 作業ツリー(from。既定は ROOT)を dir へ写す。
 *   skip   最上位で写さない名の集合(既定は COPY_SKIP。試験が追加の除外を持つときに渡す)
 *   戻り値  { skippedProduct: 外した製品のコードの相対パス }
 */
export function copyTemplateTree(dir, { from = ROOT, skip = COPY_SKIP } = {}) {
  const skippedProduct = [];
  const scaffold = scaffoldFiles();
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && skip.has(e.name)) continue;
      if (e.isDirectory()) {
        walk(r);
      } else if (isAdopterProductFile(r) || scaffold.has(r)) {
        skippedProduct.push(r);
      } else {
        fs.mkdirSync(path.join(dir, rel), { recursive: true });
        fs.cpSync(path.join(from, r), path.join(dir, r));
      }
    }
  };
  walk('');
  fs.writeFileSync(path.join(dir, 'process.config.json'), fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8'));
  return { skippedProduct };
}
