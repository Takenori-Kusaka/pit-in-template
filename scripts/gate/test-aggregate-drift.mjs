// 宣言と実態のずれ(標準 第3章 3.13.5)の検出 declarationDrift の試験。IMPL-0023 / IMPL-NEW2 / process-compass #355。
//
//   node scripts/gate/test-aggregate-drift.mjs
//
// 検出の範囲と限界(偽の合格・偽の検出の経路)を固定する。起票は人が行い、機械は起票しない。ずれは警告で、記載の欠落に数えない。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarationDrift, agentRunModelIdGaps } from './aggregate-evidence.mjs';
import { ROOT } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

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
t('担い手(偽の合格の固定): 版の一部だけの共著者「Claude Opus 4」は宣言「claude-opus-4-5」を通す(宣言の一部分に当たる)', d({ declaredModels: ['claude-opus-4-5'], coAuthors: ['Claude Opus 4 <noreply@anthropic.com>'] }).length === 0);
t('担い手(偽の合格の固定): 宣言の文字列に含まれる1文字の名「a」は宣言「claude-opus-4-5」を通す', d({ declaredModels: ['claude-opus-4-5'], coAuthors: ['a <a@example.com>'] }).length === 0);
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

// --- 集約の本体を通しで流す(IMPL-0023。#355 独立の突合 1巡目 R1-02 の場面 N)。ずれは警告で、記載の欠落に数えない ---
{
  const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
  const ANSWERS = {
    'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
    'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes', 'q-biz-phase': 'growth',
  };
  const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [{ login: `acc${i}`, id: 10 + i }] }));
  const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
  const runWith = (coAuthor, extra = []) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-drift-agg-'));
    try {
      for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
      }
      const log = console.log;
      console.log = () => {};
      let config;
      try {
        config = buildConfig(ANSWERS, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config;
      } finally {
        console.log = log;
      }
      fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(config, null, 2) + '\n');
      const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git('init', '-q', '-b', 'main');
      for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'tester'], ['core.autocrlf', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false']]) git('config', k, v);
      git('add', '-A');
      git('commit', '-q', '-m', 'chore: fixture');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/x.js'), 'export const x = 1;\n');
      git('add', '-A');
      git('commit', '-q', '-m', `feat: x\n\nRisk: R3\nVerification: 手元で確かめた${coAuthor ? `\nCo-authored-by: ${coAuthor}` : ''}`);
      extra.forEach((msg, i) => {
        fs.writeFileSync(path.join(dir, `src/e${i}.js`), `export const e${i} = ${i};\n`);
        git('add', '-A');
        git('commit', '-q', '-m', msg);
      });
      const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' } });
      const rd = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
      return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, report: rd('evidence/quality-report.md'), external: rd('evidence/assurance-disclosure.external.md') };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
  const lines = (r) => r.out.split(/\r?\n/);
  const ng = runWith('Claude Sonnet 4 <noreply@anthropic.com>');
  const okRun = runWith(null);
  t('通し: 集約が最後まで走る', /を出力しました/.test(ng.out) && /を出力しました/.test(okRun.out), ng.out.slice(-300));
  // IMPL-0023:ng(違反と適合の対。標準の実装マーク。process-compass #355)
  t('通し N(違反): 宣言にない共著者のコミットは、警告「宣言と実態のずれ: 担い手の識別」を出す', lines(ng).some((l) => /宣言と実態のずれ: 担い手の識別/.test(l) && !/::error::/.test(l)), ng.out.slice(-400));
  const errCount = (r) => lines(r).filter((l) => /::error::/.test(l)).length;
  t('通し N: ずれは記載の欠落に数えない(::error:: にずれの本文が無い。品質レポートの「欠落」の節にも出ない。::error:: の件数は適合の実行と等しい)', !lines(ng).some((l) => /::error::/.test(l) && /担い手の識別: 宣言にない/.test(l)) && !/## 欠落[\s\S]*担い手の識別: 宣言にない/.test(ng.report) && errCount(ng) === errCount(okRun), `ng=${errCount(ng)} ok=${errCount(okRun)}`);
  t('通し N: 品質レポートに見出し(機械は起票しません)と種別 performer・補助ファイルの所在を出す', /機械は起票しません。起票されたかは出荷判定者が確かめます/.test(ng.report) && /種別 performer/.test(ng.report) && /kinds\/performer\.md/.test(ng.report));
  t('通し N: 外部向けの開示はずれの件数だけ(ずれの文・種別を出さない)', /1 件\(内容は組織の内側の開示にある\)/.test(ng.external) && !/担い手の識別: 宣言にない/.test(ng.external) && !/種別 performer/.test(ng.external), ng.external.split('\n').filter((l) => /件\(内容/.test(l)).join('\n'));
  // IMPL-0023:ok(違反と適合の対。標準の実装マーク。process-compass #355)
  t('通し N(適合): 共著者の記録が無ければ、ずれの警告を出さない', !lines(okRun).some((l) => /宣言と実態のずれ/.test(l)) && !/宣言と実態のずれ\*\*/.test(okRun.report));

  // --- モデルの識別(#326 項目6・7。トレーラ Agent-Run を持つコミットの行A・行B。警告で、欠落に数えない) ---
  {
    const c = (agentRun, ...coAuthors) => ({ hash: 'h'.repeat(12), agentRun, coAuthors });
    const g = (...cs) => agentRunModelIdGaps(cs);
    const A = (r) => r.noCoAuthor.length;
    const B = (r) => r.noVersion.length;
    t('行A(ng): Agent-Run あり・共著者なし → 行A に数える', A(g(c('r1'))) === 1 && B(g(c('r1'))) === 0);
    t('行B(ng): Agent-Run あり・共著者「Claude <…>」(数字なし) → 行B に数える', B(g(c('r1', 'Claude <noreply@anthropic.com>'))) === 1 && A(g(c('r1', 'Claude <noreply@anthropic.com>'))) === 0);
    t('行B: 角括弧の中のメールの数字は版に数えない', B(g(c('r1', 'Claude <123+x@users.noreply.github.com>'))) === 1);
    t('行A・B(ok): Agent-Run あり・「Claude Opus 4.5 <…>」 → 数えない', A(g(c('r1', 'Claude Opus 4.5 <noreply@anthropic.com>'))) + B(g(c('r1', 'Claude Opus 4.5 <noreply@anthropic.com>'))) === 0);
    t('行A・B(ok・限界の固定): Agent-Run なし・共著者なし → 数えない', A(g(c(null))) + B(g(c(null))) === 0);
    t('行A・B(ok・限界の固定): Agent-Run なし・人の共著者 → 数えない', A(g(c(null, 'Hanako Sato <h@example.com>'))) + B(g(c(null, 'Hanako Sato <h@example.com>'))) === 0);
    t('行B(ok・限界の固定): 人の共著者の名に数字があれば通る(Agent-Run あり・「Taro2」)', B(g(c('r1', 'Taro2 <t@example.com>'))) === 0);
    t('行B(ok): 共著者の1つでも数字があれば通る', B(g(c('r1', 'Claude <x@y>', 'Claude Opus 4.5 <x@y>'))) === 0);
    // 集約の入口(命令行)を通して、別々の警告の行が出る。欠落(::error::)には数えない
    const msg = (n, co) => `feat: ${n}\n\nRisk: R3\nVerification: 手元で確かめた\nAgent-Run: run-${n}${co ? `\nCo-authored-by: ${co}` : ''}`;
    const withRuns = runWith(null, [msg('a', null), msg('b', 'Claude <noreply@anthropic.com>'), msg('c', 'Claude Opus 4.5 <noreply@anthropic.com>')]);
    const wa = lines(withRuns).filter((l) => /モデルの識別\(5\.8\.2\)/.test(l));
    t('通し(ng): Agent-Run あり・共著者なしは行A の警告を出す(1 件)', wa.some((l) => /Co-Authored-By が無いコミット 1 件/.test(l)) && wa.every((l) => !/::error::/.test(l)), withRuns.out.slice(-500));
    t('通し(ng): 数字の無い共著者は行B の警告を別の行で出す(1 件。計 2 行)', wa.some((l) => /数字\(版\)を含む名称が無いコミット 1 件/.test(l)) && wa.length === 2, wa.join('\n'));
    t('通し: 説明に限界(Agent-Run の無いコミットは数えない・5.8.2 の自動の記録の代わりではない)を書く', wa.length > 0 && wa.every((l) => /Agent-Run を持つコミットだけ/.test(l) && /代わりではありません/.test(l)));
    t('通し: 欠落に数えない(::error:: の行にモデルの識別の本文が無い)', !lines(withRuns).some((l) => /::error::/.test(l) && /モデルの識別\(5\.8\.2\)/.test(l)) && !/## 欠落[\s\S]*モデルの識別\(5\.8\.2\)/.test(withRuns.report));
    t('通し(ok): Agent-Run の無い実行では警告を出さない', !lines(okRun).some((l) => /モデルの識別\(5\.8\.2\)/.test(l)));
    t('通し: 品質レポートにも行A・行B を出す', /Co-Authored-By が無いコミット 1 件/.test(withRuns.report) && /数字\(版\)を含む名称が無いコミット 1 件/.test(withRuns.report));
    {
      const agg = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'aggregate-evidence.mjs'), 'utf8');
      t('項目8: 「作成側の検証の記載」の説明に、有無だけを見て中身を確かめない旨がある', /「作成側の検証の記載」は、有無だけを見ます。中身は確かめません/.test(agg));
      t('項目9 e: 保証の開示の項目4 に、過去の時点の定義は読まない旨と項目1 を見る旨が出る', /過去の時点の定義は読みません/.test(okRun.external) && /期間中の gate-g5\.yml の変更は項目1/.test(okRun.external), okRun.external.split(String.fromCharCode(10)).filter((l) => /gate-g5/.test(l)).join(' ').slice(0, 300));
    }
  }
}

console.log(`\n宣言と実態のずれの試験: ${failed ? `${failed} 件が期待と一致しません` : `${total} 件が期待と一致しました`}`);
process.exit(failed ? 1 : 0);
