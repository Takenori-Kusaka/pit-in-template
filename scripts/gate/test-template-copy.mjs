// 自己試験の複製の補助(template-copy.mjs)の試験(process-compass #361 D-1)。
//
//   node scripts/gate/test-template-copy.mjs
//
// 固定する決定:
//   - 採用者の製品のコード(go.mod・cmd/**/*.go など)は複製に入れない。検査の道具(scripts/・.github/ ほか)は、採用者が書き換えていても複製に入れる(除外式。足し忘れが緑のまま欠けない)
//   - 複製の `process.config.json` は、道具が持つ未設定の既定になる(採用者の構成を持ち込まない)
//   - 既定は、テンプレート自身の未設定の `process.config.json` と一致する(同期。採用者のリポジトリでは構成済みのため確かめない)
// GitHub へ問い合わせません。リポジトリの状態を変えません。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { copyTemplateTree, DEFAULT_CONFIG_FILE, isAdopterProductFile, COPY_SKIP } from './template-copy.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
}
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const has = (dir, rel) => fs.existsSync(path.join(dir, rel));

// ---------------------------------------------------------------- 採用者の状態を模した作業ツリー
const adopter = tmp('pit-in-copy-from-');
put(adopter, 'process.config.json', JSON.stringify({ configured: true, adapters: { stack: 'go' } }));
put(adopter, 'go.mod', 'module example.com/app\n');
put(adopter, 'cmd/app/main.go', 'package main\n');
put(adopter, '.secretlintrc.json', '{}\n');
put(adopter, 'tests/README.md', '# t\n');
put(adopter, 'scripts/gate/check-pr.mjs', '// 採用者が書き換えた検査装置\n');
put(adopter, '.github/workflows/gate-g5.yml', 'name: g5\n');
put(adopter, 'docs/D-0-governance.md', '# D-0\n');
put(adopter, 'node_modules/x/index.js', 'x\n');
put(adopter, 'evidence/e.json', '{}\n');

const dest = tmp('pit-in-copy-to-');
const { skippedProduct } = copyTemplateTree(dest, { from: adopter });
const cfg = JSON.parse(fs.readFileSync(path.join(dest, 'process.config.json'), 'utf8'));
const dflt = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8'));

check('製品のコード(go.mod・cmd の .go)は複製に入らず、外した一覧に出る', !has(dest, 'go.mod') && !has(dest, 'cmd/app/main.go') && skippedProduct.includes('go.mod') && skippedProduct.includes('cmd/app/main.go'), JSON.stringify(skippedProduct));
check('初期化が足す開発の基盤(.secretlintrc.json・tests/README.md)は複製に入らない', !has(dest, '.secretlintrc.json') && !has(dest, 'tests/README.md'));
check('検査の道具・ワークフロー・文書は複製に入る(除外式)', has(dest, 'scripts/gate/check-pr.mjs') && has(dest, '.github/workflows/gate-g5.yml') && has(dest, 'docs/D-0-governance.md'));
check('採用者が書き換えた検査の道具は、書き換えたまま複製される(複製が書き換えを隠さない)', fs.readFileSync(path.join(dest, 'scripts/gate/check-pr.mjs'), 'utf8').includes('書き換えた'));
check('置き場の除外(node_modules・evidence)は従来どおり', !has(dest, 'node_modules') && !has(dest, 'evidence'));
check('複製の process.config.json は未設定の既定で、採用者の構成を持ち込まない', cfg.configured === false && JSON.stringify(cfg) === JSON.stringify(dflt));
check('追加の除外(skip)を渡せる', (() => {
  const d = tmp('pit-in-copy-skip-');
  copyTemplateTree(d, { from: adopter, skip: new Set([...COPY_SKIP, 'docs']) });
  const ok = !has(d, 'docs') && has(d, 'scripts/gate/check-pr.mjs');
  fs.rmSync(d, { recursive: true, force: true });
  return ok;
})());
check('製品のコードの判定: 検査の道具の .mjs は製品でない・go.mod と .go は製品', !isAdopterProductFile('scripts/gate/x.mjs') && isAdopterProductFile('go.mod') && isAdopterProductFile('internal/a/b.go'));
fs.rmSync(adopter, { recursive: true, force: true });
fs.rmSync(dest, { recursive: true, force: true });

// ---------------------------------------------------------------- この作業ツリーそのもの
const real = tmp('pit-in-copy-real-');
const r = copyTemplateTree(real);
const bad = r.skippedProduct.filter((f) => /^(scripts|\.github|\.claude|templates|adapters|docs|context|profiles|specs)\//.test(f));
check('この作業ツリーでは、外した製品のコードが道具の置き場に無い', bad.length === 0, bad.join('\n'));
check('この作業ツリーの道具(scripts/gate/config.mjs・templates/・adapters/go.json)が複製に入る', has(real, 'scripts/gate/config.mjs') && has(real, 'adapters/go.json') && fs.existsSync(path.join(real, 'templates')));
fs.rmSync(real, { recursive: true, force: true });

// ---------------------------------------------------------------- 既定の構成の同期(テンプレート自身だけ)
const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'process.config.json'), 'utf8'));
if (live.configured === false) {
  check('既定の構成は、テンプレート自身の未設定の process.config.json と一致する', JSON.stringify(live) === JSON.stringify(dflt), '未設定の構成を変えたら fixtures/process.config.default.json も同じ内容へ更新する');
} else {
  console.log('note 構成済みのリポジトリのため、既定の構成の同期は確かめません(テンプレート自身の CI が確かめる)');
}
check('既定の構成は未設定(configured: false)', dflt.configured === false);

console.log(`\ntemplate-copy の試験: ${checks - failures}/${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
