// 依存関係の追加・更新を一覧にする(G-5 基準8)。
//
//   node scripts/gate/dependency-diff.mjs --base origin/main
//
// 合否は判定しません。**一覧を機械が出力する**ことが規定です。
// 依存の追加は独立レビューの必須確認事項になります(G-6 判定基準5)。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, notice, DEPENDENCY_MANIFESTS as MANIFESTS } from './config.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const base = arg('--base', 'origin/main');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
const touched = changed.filter((f) => MANIFESTS.includes(path.basename(f)));

const result = { base, manifestsChanged: touched, details: [] };

for (const f of touched) {
  const diff = git(['diff', `${base}...HEAD`, '--unified=0', '--', f]);
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);
  const removed = diff
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);
  result.details.push({ file: f, added: added.slice(0, 200), removed: removed.slice(0, 200) });
}

fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'evidence/dependency-diff.json'),
  JSON.stringify(result, null, 2) + '\n',
  'utf8'
);

if (!touched.length) {
  notice('依存関係の変更はありません');
  process.exit(0);
}

const md = [];
md.push('## 依存関係の変更');
md.push('');
md.push('独立レビュー(G-6)の必須確認事項です。**追加が必要であることの確認**を行ってください。');
md.push('');
for (const d of result.details) {
  md.push(`### \`${d.file}\``);
  md.push('');
  md.push('```diff');
  for (const l of d.removed.slice(0, 40)) md.push(`- ${l}`);
  for (const l of d.added.slice(0, 40)) md.push(`+ ${l}`);
  md.push('```');
  md.push('');
}
const out = md.join('\n');
fs.writeFileSync(path.join(ROOT, 'evidence/dependency-diff.md'), out, 'utf8');
console.log(out);

// GitHub Actions のジョブサマリへも出す
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
}
