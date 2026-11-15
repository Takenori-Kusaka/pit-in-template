// 確定した版の再確認(spec-recheck.mjs / spec-sections.mjs の3値の比較)の試験。IMPL-0241 / process-compass #355。
//
//   node scripts/gate/test-spec-recheck.mjs
//
// 違反(不一致 = 欠落)と適合(一致・未確認)の対で置く。実物の git の場面(squash で取り込んだ後、判定の版のオブジェクトが無い)は、
// 一時のリポジトリを作って確かめる。GitHub へ問い合わせない。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { specSections, compareSpecSections, changedSpecSections } from './spec-sections.mjs';
import { specRecheck, specRecheckGapText, specRecheckSummary, targetVersionOfForm } from './spec-recheck.mjs';

let failed = 0;
let total = 0;
const t = (name, ok, detail = '') => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : detail ? ` -- ${detail}` : ''}`);
};

const SPEC = (o = {}) =>
  `# 機能仕様: 招待\n\n## 背景\n\n招待する。\n\n## ${o.premiseHead ?? '前提'}\n\n${o.premise ?? '- 利用者は登録済み'}\n\n## ${o.scopeHead ?? 'スコープ外'}\n\n${o.scope ?? '- 一括招待'}\n\n## 受入基準\n\n${o.ac ?? '| # | 型 | 受入基準 |\n| --- | --- | --- |\n| 1 | 常時 | x |'}\n\n## 承認\n\n${o.approval ?? '未判定'}\n`;
const feat = (id, tipText) => ({ id, tipText });
const pass = (text, extra = {}) => ({ feature: 'F-001', source: 'docs/gates/g4-F-001.md', ref: '1a2b3c4', text, unresolved: null, ...extra });
const run = (judged, tip, extra) => specRecheck({ features: [feat('F-001', tip)], passes: Array.isArray(judged) ? judged : [pass(judged, extra)] })[0];

const base = SPEC();

// --- 一致 ---
t('一致: 変わっていない', run(base, base).result === 'match');
t('一致: 承認欄(3節の外)だけの変更は一致', run(base, SPEC({ approval: '通過' })).result === 'match');
t('一致: 行末の空白と CRLF だけの変更', run(base, base.replace(/\n/g, '  \r\n')).result === 'match');
t('一致: 端の空行だけの変更', run(base, `\n\n${base}\n\n`).result === 'match');

// --- 不一致(節ごと) ---
const ac2 = '| # | 型 | 受入基準 |\n| --- | --- | --- |\n| 1 | 常時 | y |';
{
  const r = run(base, SPEC({ ac: ac2 }));
  t('不一致: 受入基準の変更', r.result === 'mismatch' && r.sections.join() === '受入基準' && r.record === 'docs/gates/g4-F-001.md', JSON.stringify(r));
}
{
  const r = run(base, SPEC({ premise: '- 利用者は未登録' }));
  t('不一致: 前提の変更', r.result === 'mismatch' && r.sections.join() === '前提', JSON.stringify(r));
}
{
  const r = run(base, SPEC({ scope: '- 一括削除' }));
  t('不一致: スコープ外の変更', r.result === 'mismatch' && r.sections.join() === 'スコープ外', JSON.stringify(r));
}
{
  const r = run(base, SPEC({ ac: ac2, scope: '- 一括削除' }));
  t('不一致: 複数の節は節の名を全部出す', r.result === 'mismatch' && r.sections.join() === '受入基準,スコープ外', JSON.stringify(r));
}

// --- 厳しい側を固定: 行内の空白・表の整形だけでも不一致 ---
t('不一致(厳しい側): 行内の空白だけの変更(`- A` → `-  A`)', run(base, SPEC({ premise: '-  利用者は登録済み' })).result === 'mismatch');
t(
  '不一致(厳しい側): 表の整形だけの変更',
  run(base, SPEC({ ac: '|#|型|受入基準|\n|---|---|---|\n|1|常時|x|' })).result === 'mismatch'
);
t('不一致(厳しい側): 節の途中の空行の追加', run(base, SPEC({ premise: '- 利用者は登録済み\n\n- 追加' })).result === 'mismatch');

// --- 前方一致の見出し ---
{
  const judged = SPEC({ premiseHead: '前提条件', scopeHead: 'スコープ外(やらないこと)' });
  t('前方一致: 「前提条件」「スコープ外(やらないこと)」を節として読む', specSections(judged).前提 !== null && specSections(judged).スコープ外 !== null);
  const rp = run(judged, SPEC({ premiseHead: '前提条件', scopeHead: 'スコープ外(やらないこと)', premise: '- 変更' }));
  t('不一致: 「前提条件」の本文の変更', rp.result === 'mismatch' && rp.sections.join() === '前提', JSON.stringify(rp));
  const rs = run(judged, SPEC({ premiseHead: '前提条件', scopeHead: 'スコープ外(やらないこと)', scope: '- 変更' }));
  t('不一致: 「スコープ外(やらないこと)」の本文の変更', rs.result === 'mismatch' && rs.sections.join() === 'スコープ外', JSON.stringify(rs));
  t('適合: 見出しの表記が同じで本文が同じなら一致', run(judged, judged).result === 'match');
  t('空白なしの「##前提」は見出しに数えない', specSections('##前提\n\na\n').前提 === null);
}

// --- null の扱い ---
{
  const a = '# 仕様\n\n## 背景\n\nあ\n';
  const b = '# 仕様\n\n## 背景\n\nい\n';
  const r = run(a, b);
  t('未確認: 両側とも3節が無く、全文が違う(一致に数えない)', r.result === 'unconfirmed' && /取り出せない/.test(r.reason), JSON.stringify(r));
  t('適合: 両側とも3節が無いが、全文が同じ(一致)', run(a, a).result === 'match');
  t('適合: 全文が同じなら CRLF 差も一致', run(a, a.replace(/\n/g, '\r\n')).result === 'match');
  const c = compareSpecSections(a, b);
  t('compareSpecSections: 両側 null の節は unreadable', Object.values(c.sections).every((v) => v === 'unreadable') && c.fullMatch === false);
  t('changedSpecSections(表示用)は両側 null を変更に数えない(変えていない)', changedSpecSections(a, b).length === 0);
}
{
  // 「前提条件」だけを持つ側と、「前提」の本文が全く違う側は、前方一致でともに読め、本文の差が不一致になる
  const r = run(SPEC({ premise: '- A' }), SPEC({ premise: '- 全く別の本文' }));
  t('不一致: 同じ見出しで本文が全く違う', r.result === 'mismatch');
}
{
  // 片側だけ null(節を足した・消した・見出しを変えた)
  const noScope = base.replace(/## スコープ外\n\n- 一括招待\n\n/, '');
  const r1 = run(base, noScope);
  t('不一致: 節を消した(片側だけ null)', r1.result === 'mismatch' && r1.sections.join() === 'スコープ外', JSON.stringify(r1));
  const r2 = run(noScope, base);
  t('不一致: 節を足した(片側だけ null)', r2.result === 'mismatch' && r2.sections.join() === 'スコープ外', JSON.stringify(r2));
  const r3 = run(base, base.replace('## スコープ外', '## 対象外'));
  t('不一致: 見出しの語を変えて節が読めなくなった', r3.result === 'mismatch', JSON.stringify(r3));
}

// --- 通過が複数 ---
{
  const old = SPEC({ ac: ac2 });
  const r = run([pass(old, { source: 'docs/gates/old.md', ref: 'aaaaaaa' }), pass(base, { source: 'docs/gates/new.md', ref: 'bbbbbbb' })], base);
  t('一致: 通過が2件で片方だけ一致', r.result === 'match' && r.record === 'docs/gates/new.md', JSON.stringify(r));
  const r2 = run([pass(old, { source: 'docs/gates/old.md' }), pass(base, { source: 'docs/gates/new.md' })], SPEC({ ac: ac2 }));
  t('一致(限界の固定): 判定済みの古い版へ戻した変更は一致になる', r2.result === 'match' && r2.record === 'docs/gates/old.md', JSON.stringify(r2));
  const tip = SPEC({ ac: ac2, scope: '- 別', premise: '- 別' });
  const r3 = run([pass(old, { source: 'docs/gates/old.md' }), pass(base, { source: 'docs/gates/new.md' })], tip);
  t('不一致: 通過が2件ともに一致しない。節の差が少ない記録を出す', r3.result === 'mismatch' && r3.record === 'docs/gates/old.md' && r3.sections.length === 2, JSON.stringify(r3));
  const r4 = run([pass(null, { source: 'docs/gates/x.md', unresolved: 'オブジェクトを取得できない' }), pass(base, { source: 'docs/gates/new.md' })], base);
  t('一致: 届かない通過があっても、届く通過が一致なら一致', r4.result === 'match');
  const r5 = run([pass(null, { source: 'docs/gates/x.md', unresolved: 'オブジェクトを取得できない' }), pass(old, { source: 'docs/gates/old.md' })], base);
  t('不一致: 届く通過が不一致で、届かない通過がある(未確認にしない)', r5.result === 'mismatch', JSON.stringify(r5));
}

// --- 版に届かない場合は未確認(欠落にしない) ---
{
  const r = run([pass(null, { unresolved: '様式の「対象」に版が無い' })], base);
  t('未確認: 対象に版が無い', r.result === 'unconfirmed' && /版が無い/.test(r.reason), JSON.stringify(r));
  const r2 = run([pass(null, { unresolved: '判定の版 1a2b3c4 のオブジェクトを取得できない' })], base);
  t('未確認: 判定の版のオブジェクトが無い', r2.result === 'unconfirmed', JSON.stringify(r2));
  const r3 = run([], base);
  t('未確認: 通過の記録が無い(G-7 基準5 の欠落が別に数える)', r3.result === 'unconfirmed' && /基準5/.test(r3.reason));
  const r4 = specRecheck({ features: [feat('F-001', null)], passes: [pass(base)] })[0];
  t('未確認: 範囲の先端の spec.md を読めない', r4.result === 'unconfirmed');
  const items = [r, r2, run(base, SPEC({ ac: ac2 })), run(base, base)];
  const sum = specRecheckSummary(items);
  t('件数: 欠落は不一致だけ。未確認は理由つきで数える', sum.match === 1 && sum.mismatch === 1 && sum.unconfirmed === 2 && Object.keys(sum.unconfirmedReasons).length === 2, JSON.stringify(sum));
  const gaps = items.filter((i) => i.result === 'mismatch').map(specRecheckGapText);
  t('欠落の文: 機能・節の名・判定記録の所在・直し方を出す', gaps.length === 1 && /F-001/.test(gaps[0]) && /受入基準/.test(gaps[0]) && /docs\/gates\/g4-F-001\.md/.test(gaps[0]) && /変更後の版を対象とする判定記録/.test(gaps[0]) && /元の記録は残す/.test(gaps[0]), gaps[0]);
}

// --- 差し戻しで打ち消された通過は数えない(集約が効いている通過だけを渡す。渡さなければ未確認) ---
{
  // 効いている通過が無い(全部打ち消された)機能は passes に現れない
  const r = specRecheck({ features: [feat('F-001', base)], passes: [] })[0];
  t('打ち消された通過は数えない: 効いている通過が0件なら一致にならない', r.result !== 'match');
  const agg = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'aggregate-evidence.mjs'), 'utf8');
  t('静的確認: 集約は supersededByLater と reviewSupersededByLater で効いている通過だけを集める', /specRecheckItems/.test(agg) && /supersededByLater\(g, gateDetails, \(o\) => specRe\(f\.id\)/.test(agg) && /reviewSupersededByLater\(j, reviewJudgements, f\.id\)/.test(agg));
}

// --- 様式の「対象」の解析 ---
{
  const v = (s) => targetVersionOfForm(s);
  t('対象の解析: F-012 / 1a2b3c4', JSON.stringify(v('F-012 / 1a2b3c4')) === JSON.stringify({ feature: 'F-012', kind: 'commit', commit: '1a2b3c4' }));
  t('対象の解析: F-012 / PR #34', JSON.stringify(v('F-012 / PR #34')) === JSON.stringify({ feature: 'F-012', kind: 'pr', pr: 34 }));
  t('対象の解析: 版なし(F-012)', v('F-012').kind === 'none' && v('F-012').feature === 'F-012');
  t('対象の解析: 機械の併記つき(PR)', v('F-012 / PR #34(マージ後 abcdef1234)').kind === 'pr' && v('F-012 / PR #34(マージ後 abcdef1234)').pr === 34);
  t('対象の解析: 機械の併記つき(コミット)', v('F-012 / 1a2b3c4(レビュー 5627536939 の対象)').commit === '1a2b3c4');
  t('対象の解析: 機能 ID だけの欄は版なし。ID の数字を版に数えない', v('F-1234567').kind === 'none');
}

// --- check-pr.mjs と集約が同じ spec-sections.mjs を import する ---
{
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const pr = fs.readFileSync(path.join(dir, 'check-pr.mjs'), 'utf8');
  const rc = fs.readFileSync(path.join(dir, 'spec-recheck.mjs'), 'utf8');
  const agg = fs.readFileSync(path.join(dir, 'aggregate-evidence.mjs'), 'utf8');
  t('静的確認: check-pr.mjs が spec-sections.mjs を import する', /from '\.\/spec-sections\.mjs'/.test(pr));
  t('静的確認: spec-recheck.mjs が spec-sections.mjs を import し、集約が spec-recheck.mjs を import する', /from '\.\/spec-sections\.mjs'/.test(rc) && /from '\.\/spec-recheck\.mjs'/.test(agg));
  t('静的確認: 節の取り出しを2か所に持たない(集約・spec-recheck に見出しの正規表現が無い)', !/前提\|スコープ外/.test(rc) && !/前提\|スコープ外/.test(agg));
}

// --- 実物の git: squash で取り込み、判定の版(commit_id)のオブジェクトが無い → 未確認(欠落にしない) ---
{
  const mk = (name) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `pit-in-recheck-${name}-`));
    const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'tester');
    g('config', 'core.autocrlf', 'false');
    return { d, g };
  };
  const readAt = (d, ref, f) => {
    try {
      return execFileSync('git', ['show', `${ref}:specs/${f}/spec.md`], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  let ok = true;
  let detail = '';
  try {
    // 作成側のリポジトリ: PR のブランチで、判定の版 J を作る
    const A = mk('author');
    fs.mkdirSync(path.join(A.d, 'specs/F-001'), { recursive: true });
    fs.writeFileSync(path.join(A.d, 'specs/F-001/spec.md'), base);
    A.g('add', '-A');
    A.g('commit', '-q', '-m', 'base');
    A.g('switch', '-q', '-c', 'pr');
    fs.writeFileSync(path.join(A.d, 'specs/F-001/spec.md'), SPEC({ ac: ac2 }));
    A.g('add', '-A');
    A.g('commit', '-q', '-m', 'judged version');
    const J = A.g('rev-parse', 'HEAD');
    // 集約の環境のリポジトリ: squash で取り込んだ1コミットだけを持つ(PR のブランチの履歴を持たない)
    const B = mk('aggregator');
    fs.mkdirSync(path.join(B.d, 'specs/F-001'), { recursive: true });
    fs.writeFileSync(path.join(B.d, 'specs/F-001/spec.md'), base);
    B.g('add', '-A');
    B.g('commit', '-q', '-m', 'base');
    fs.writeFileSync(path.join(B.d, 'specs/F-001/spec.md'), SPEC({ ac: ac2 }));
    B.g('add', '-A');
    B.g('commit', '-q', '-m', 'squash merge (#1)');
    const tipText = readAt(B.d, 'HEAD', 'F-001');
    const judgedText = readAt(B.d, J, 'F-001');
    const unresolved = judgedText === null ? `判定の版 ${J.slice(0, 7)} のオブジェクトを取得できない` : null;
    const item = specRecheck({ features: [feat('F-001', tipText)], passes: [{ feature: 'F-001', source: 'PR #1 のレビュー', ref: J, text: judgedText, unresolved }] })[0];
    ok = judgedText === null && item.result === 'unconfirmed' && /オブジェクトを取得できない/.test(item.reason) && specRecheckSummary([item]).mismatch === 0;
    detail = `judgedText=${judgedText === null ? 'null' : 'あり'} result=${item.result}`;
    // 対の適合: 判定の版が取得できる場合(同じリポジトリに J がある)は、本文が一致して一致になる
    const itemOk = specRecheck({ features: [feat('F-001', readAt(A.d, 'HEAD', 'F-001'))], passes: [{ feature: 'F-001', source: 'x', ref: J, text: readAt(A.d, J, 'F-001'), unresolved: null }] })[0];
    t('実物の git(適合): 判定の版が取得できて本文が同じなら一致', itemOk.result === 'match', JSON.stringify(itemOk));
    // 対の違反: 取得できる判定の版が先端と違えば不一致
    const itemNg = specRecheck({ features: [feat('F-001', tipText)], passes: [{ feature: 'F-001', source: 'x', ref: 'base', text: readAt(B.d, 'HEAD~1', 'F-001'), unresolved: null }] })[0];
    t('実物の git(違反): 取得できる判定の版が先端と違えば不一致', itemNg.result === 'mismatch' && itemNg.sections.join() === '受入基準', JSON.stringify(itemNg));
    fs.rmSync(A.d, { recursive: true, force: true });
    fs.rmSync(B.d, { recursive: true, force: true });
  } catch (e) {
    ok = false;
    detail = String(e.message ?? e).slice(0, 200);
  }
  t('実物の git: squash で取り込み、commit_id のオブジェクトが無い → 未確認(欠落にしない)', ok, detail);
}

console.log(`\n確定した版の再確認の試験: ${failed ? `${failed} 件が期待と一致しません` : `${total} 件が期待と一致しました`}`);
process.exit(failed ? 1 : 0);
