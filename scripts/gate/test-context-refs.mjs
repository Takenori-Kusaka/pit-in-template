// G-5 基準6 の参照切れの検査(check-context-refs.mjs)の試験(process-compass #314 / ADR-0084 決定3)。
//
//   node scripts/gate/test-context-refs.mjs
//
// 固定する決定:
//   - 文脈ファイルの相対リンクと取り込み(@path)の先が無ければ、参照切れとして数える(IMPL-0269:ng)
//   - 先が在る参照、スキームつきの宛先、見出しだけのアンカーは数えない(IMPL-0269:ok)
//   - 逆引用符・コードブロック・HTML コメントの中は読まない(テンプレートの例のパスで誤検出しない)
//   - テンプレート自身の文脈ファイルに参照切れが無い(G-5 の原則: 既存の違反を解消してから載せる)
// GitHub へ問い合わせません。リポジトリの状態を変えません。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { contextFiles, referencesOf, brokenReferences } from './check-context-refs.mjs';
import { aggregateFindings } from './g5-aggregate.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
}

const FILES = {
  'CLAUDE.md': '',
  'context/glossary.md': '# 用語\n',
  '.claude/skills/x/SKILL.md': '',
  '.claude/skills/x/reference/a.md': '# a\n',
};
const run = (claude, skill = '') => {
  const files = { ...FILES, 'CLAUDE.md': claude, '.claude/skills/x/SKILL.md': skill };
  return brokenReferences(Object.keys(files), (f) => files[f], (rel) => rel in files || rel === 'context' || rel === '.claude/skills/x/reference');
};

// IMPL-0269:ng 先の無い相対リンクと取り込みを、参照切れとして数える
{
  const r = run('用語は [用語集](context/glossry.md) を読む。\n\n@context/standards/review.md\n');
  check('IMPL-0269:ng 先の無い相対リンクを参照切れに数える', r.broken.some((b) => b.kind === 'link' && b.resolved === 'context/glossry.md'), JSON.stringify(r.broken));
  check('IMPL-0269:ng 先の無い取り込み(@path)を参照切れに数える', r.broken.some((b) => b.kind === 'import' && b.resolved === 'context/standards/review.md'), JSON.stringify(r.broken));
  const s = run('', '詳細は [参照](reference/b.md)。\n');
  check('IMPL-0269:ng スキルからの相対リンクは、そのファイルの置き場から読む', s.broken.length === 1 && s.broken[0].resolved === '.claude/skills/x/reference/b.md', JSON.stringify(s.broken));
  const out = run('[外](../../outside.md)\n');
  check('IMPL-0269:ng リポジトリの外を指す相対リンクも参照切れに数える', out.broken.length === 1, JSON.stringify(out.broken));
}

// IMPL-0269:ok 先の在る参照、スキームつき、アンカーだけの宛先は数えない
{
  const r = run(
    '用語は [用語集](context/glossary.md#用語) と [直下から](/context/glossary.md) を読む。\n' +
      '@context/glossary.md\n[標準](https://example.com/x) [節](#迷ったら) 連絡は user@example.com へ。\n',
    '詳細は [参照](reference/a.md)。\n'
  );
  check('IMPL-0269:ok 先の在る参照・スキームつき・アンカーだけの宛先は数えない', r.broken.length === 0 && r.checked === 4, JSON.stringify(r));
}

// 範囲の外(降りていない残り): 逆引用符・コードブロック・HTML コメントの中
{
  const r = run(
    '例: `docs/D-0-governance.md` を作る。\n\n```\n[x](nothing.md)\n@nothing/here.md\n```\n\n<!-- [y](nothing.md) -->\n'
  );
  check('逆引用符・コードブロック・HTML コメントの中は読まない', r.broken.length === 0 && r.checked === 0, JSON.stringify(r));
  const refs = referencesOf('CLAUDE.md', '`[z](nothing.md)` と [w](<context/glossary.md>)');
  check('山括弧で囲んだ宛先を読む', refs.length === 1 && refs[0].resolved === 'context/glossary.md', JSON.stringify(refs));
}

// テンプレート自身
{
  const files = contextFiles(ROOT);
  const r = brokenReferences(files, (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'), (rel) => fs.existsSync(path.join(ROOT, rel)));
  check('テンプレートの文脈ファイルに参照切れが無い', files.includes('CLAUDE.md') && r.broken.length === 0, JSON.stringify(r.broken));
}

// ワークフロー: 基準6 のジョブが集約の合否に使われる
{
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/gate-g5.yml'), 'utf8');
  check('ワークフロー: context-format ジョブが check-context-refs を呼ぶ', /node scripts\/gate\/check-context-refs\.mjs/.test(wf));
  const f = aggregateFindings(wf);
  check('ワークフロー: 集約(gate-g5)が context-format を合否に使う', f.effective.has('context-format') && f.problems.length === 0, f.problems.join(' / '));
  check('ワークフロー: contract で、この試験を実行する', /node scripts\/gate\/test-context-refs\.mjs/.test(wf));
}

if (failures) {
  console.error(`\n参照切れの検査の試験: ${failures} 件の失敗`);
  process.exit(1);
}
console.log('\n参照切れの検査の試験: すべて通過');
