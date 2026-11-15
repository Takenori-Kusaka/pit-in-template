// 宣言と実態のずれ(標準 第3章 3.13.5)の検出 declarationDrift の試験。IMPL-0023 / IMPL-NEW2 / process-compass #355。
//
//   node scripts/gate/test-aggregate-drift.mjs
//
// 検出の範囲と限界(偽の合格・偽の検出の経路)を固定する。起票は人が行い、機械は起票しない。ずれは警告で、記載の欠落に数えない。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarationDrift } from './aggregate-evidence.mjs';

let failed = 0;
let total = 0;
const t = (name, ok, detail = '') => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : detail ? ` -- ${detail}` : ''}`);
};

const d = (o) => declarationDrift({ sizeAnswer: undefined, sizeLabel: undefined, approvers: [], declaredModels: [], coAuthors: [], ...o });
const kinds = (o) => d(o).map((x) => x.kind).join();

// --- 人数 ---
t('人数(違反): size-1-2 で承認者が 3 名 → 1件', kinds({ sizeAnswer: 'size-1-2', sizeLabel: '1〜2名', approvers: ['a', 'b', 'c'] }) === 'headcount');
t('人数(適合): size-1-2 で承認者が 2 名 → 0件', d({ sizeAnswer: 'size-1-2', approvers: ['a', 'b'] }).length === 0);
t('人数(違反): size-3-9 で承認者が 10 名 → 1件', kinds({ sizeAnswer: 'size-3-9', approvers: Array.from({ length: 10 }, (_, i) => `p${i}`) }) === 'headcount');
t('人数(適合): size-3-9 で承認者が 9 名 → 0件', d({ sizeAnswer: 'size-3-9', approvers: Array.from({ length: 9 }, (_, i) => `p${i}`) }).length === 0);
t('人数(限界の固定): size-10plus は上限が無く、何名でも検出しない', d({ sizeAnswer: 'size-10plus', approvers: Array.from({ length: 50 }, (_, i) => `p${i}`) }).length === 0);
t('人数(限界の固定): 下回る向き(size-3-9 で承認者 1 名)は検出しない', d({ sizeAnswer: 'size-3-9', approvers: ['a'] }).length === 0);
t('人数: 同じ承認者の重複は 1 名に数える', d({ sizeAnswer: 'size-1-2', approvers: ['a', 'a', 'b', 'b'] }).length === 0);
{
  const x = d({ sizeAnswer: 'size-1-2', sizeLabel: '1〜2名', approvers: ['a', 'b', 'c'] })[0];
  t('文に種別と補助ファイルの所在がある(人数)', /\/process-change の種別 headcount/.test(x.text) && /kinds\/headcount\.md/.test(x.text) && /3 名/.test(x.text), x.text);
}

// --- 担い手の識別 ---
t('担い手(違反): 別の版の共著者(宣言 claude-opus-4-5 / 共著者 Claude Sonnet 4) → 検出', kinds({ declaredModels: ['claude-opus-4-5'], coAuthors: ['Claude Sonnet 4 <noreply@anthropic.com>'] }) === 'performer');
t('担い手(適合): 宣言と同じ版の共著者 → 0件', d({ declaredModels: ['claude-opus-4-5'], coAuthors: ['Claude Opus 4.5 <noreply@anthropic.com>'] }).length === 0);
t('担い手(偽の合格の固定): 宣言「claude」は別の版の「Claude Opus 4.5」を通す', d({ declaredModels: ['claude'], coAuthors: ['Claude Opus 4.5 <noreply@anthropic.com>'] }).length === 0);
t('担い手(偽の合格の固定): 版の無い共著者「Claude」は宣言「claude-opus-4-5」を通す', d({ declaredModels: ['claude-opus-4-5'], coAuthors: ['Claude <noreply@anthropic.com>'] }).length === 0);
t('担い手(偽の検出の固定): 人の共著者は検出する(人の共著者を含む場合があると文に書く)', (() => {
  const r = d({ declaredModels: ['claude-opus-4-5'], coAuthors: ['Hanako Sato <hanako@example.com>'] });
  return r.length === 1 && r[0].kind === 'performer' && /人の共著者を含む場合がある/.test(r[0].text);
})());
t('担い手: 宣言が空なら、共著者の記録はすべて検出する', kinds({ declaredModels: [], coAuthors: ['Claude Opus 4.5 <x@y>'] }) === 'performer');
{
  const x = d({ declaredModels: ['claude-opus-4-5'], coAuthors: ['Claude Sonnet 4 <x@y>'] })[0];
  t('文に種別と補助ファイルの所在がある(担い手)', /種別 performer/.test(x.text) && /kinds\/performer\.md/.test(x.text), x.text);
}
t('2組が同時に出ても、それぞれ1件', kinds({ sizeAnswer: 'size-1-2', approvers: ['a', 'b', 'c'], declaredModels: ['claude-opus-4-5'], coAuthors: ['Claude Sonnet 4'] }) === 'headcount,performer');

// --- 静的確認: ずれは欠落に数えない / 機械は起票しない ---
{
  const agg = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'aggregate-evidence.mjs'), 'utf8');
  t('静的確認: ずれは warn で出し、fail(欠落)にしない', /for \(const d of assurance\.drift\) warn\(/.test(agg) && !/for \(const d of assurance\.drift\) fail\(/.test(agg) && !/gaps\.push\([^)]*drift/.test(agg));
  t('静的確認: レポートの見出しが「機械は起票しません。起票されたかは出荷判定者が確かめます」を言う', /機械は起票しません。起票されたかは出荷判定者が確かめます/.test(agg));
  t('静的確認: 集約は Issue を作らない(gh issue create / issues への POST が無い)', !/'issue',\s*'(create|edit|comment)'/.test(agg) && !/issues'?\s*,\s*'-X'/.test(agg));
}

console.log(`\n宣言と実態のずれの試験: ${failed ? `${failed} 件が期待と一致しません` : `${total} 件が期待と一致しました`}`);
process.exit(failed ? 1 : 0);
