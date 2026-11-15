// 確定した版の再確認(spec-recheck.mjs / spec-sections.mjs の3値の比較)の試験。IMPL-0241 / process-compass #355。
//
//   node scripts/gate/test-spec-recheck.mjs
//
// 違反(不一致 = 欠落)と適合(一致・未確認)の対で置く。実物の git の場面(squash で取り込んだ後、判定の版のオブジェクトが無い)は、
// 一時のリポジトリを作って確かめる。GitHub へ問い合わせない。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';
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

// --- 打ち消された通過の扱い(議長の裁定 R1-01。effective: false = 後の差し戻しに打ち消された通過) ---
{
  const v2 = SPEC({ ac: ac2 });
  const cancelledV1 = pass(base, { effective: false });
  const cancelledV2 = pass(v2, { effective: false, source: 'docs/gates/g4-old.md' });
  const r1 = run([cancelledV1], v2);
  t('打ち消し(D): 通過(v1)が打ち消され、先端は変更後の v2 → 不一致(確定した版が在り、先端が変わり、効いている通過が無い)', r1.result === 'mismatch' && r1.cancelled === true && /受入基準/.test(r1.sections.join()), JSON.stringify(r1));
  const r2 = run([cancelledV2], v2);
  t('打ち消し: 先端の版の通過が差し戻しで打ち消されている → 未確認(理由の文に「打ち消されている」)', r2.result === 'unconfirmed' && /差し戻しで打ち消されている/.test(r2.reason), JSON.stringify(r2));
  t('打ち消しの未確認は欠落に数えない(不一致 0)', specRecheckSummary([r2]).mismatch === 0);
  const r3 = run([cancelledV2, pass(base)], v2);
  t('打ち消し: 打ち消された一致があり、効いている通過は一致しない → 未確認(不一致にしない)', r3.result === 'unconfirmed' && r3.cancelled === true, JSON.stringify(r3));
  const r4 = run([cancelledV1, pass(v2)], v2);
  t('打ち消し: 効いている通過が先端と一致するなら、打ち消された古い通過があっても一致', r4.result === 'match', JSON.stringify(r4));
  const r5 = run([cancelledV1, pass(null, { unresolved: '判定の版 1a2b3c4 のオブジェクトを取得できない' })], v2);
  t('打ち消し: 効いている通過の版を読めないときは、打ち消された通過の不一致だけで不一致にしない', r5.result === 'unconfirmed', JSON.stringify(r5));
  const r6 = run([], v2);
  t('記録なし(C): 通過の記録が1件も無い → 未確認。理由は実態の文(トレーラ Spec が指す場合に限り基準5 が欠落に数える。指さない場合は欠落にしない)', r6.result === 'unconfirmed' && /トレーラ Spec がこの機能を指す場合に限り/.test(r6.reason) && /指さない場合、機械は欠落にしない/.test(r6.reason) && !/がそのまま当たる/.test(r6.reason), JSON.stringify(r6));
  const gap = specRecheckGapText({ ...r1, id: 'F-001' });
  t('欠落の文: 打ち消された記録が根拠のときはその旨を出す', /打ち消されている/.test(gap), gap);
  // 集約の側は g4Passes(1つの一覧)で、基準5 の g4Approved と再確認の両方が同じ「効いている」を使う
  const agg = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'aggregate-evidence.mjs'), 'utf8');
  t('静的確認: 効いている通過の条件は g4Passes の1か所。g4Approved と再確認が使う', /const g4Passes = \(spec\)/.test(agg) && /const g4Approved = \(spec\) => g4Passes\(spec\)\.some\(\(p\) => p\.effective\)/.test(agg) && /for \(const p of g4Passes\(f\.id\)\)/.test(agg) && (agg.match(/reviewSupersededByLater\(j, reviewJudgements/g) ?? []).length === 1);
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

// --- 集約の本体を通しで流す(IMPL-0241。#355 独立の突合 1巡目 R1-02)。一時リポジトリで aggregate-evidence.mjs を実行する ---
{
  const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
  const quiet = (fn) => {
    const log = console.log;
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.log = log;
    }
  };
  const ANSWERS = {
    'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
    'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes',
  };
  const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [{ login: `acc${i}`, id: 10 + i }] }));
  const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
  const S3 = (o = {}) => SPEC({ ac: `| # | 型 | 受入基準 |\n| --- | --- | --- |\n| 1 | 常時 | ${o.ac ?? 'x'} |`, premise: o.premise, scope: o.scope }).replace('招待する。', o.bg ?? '招待する。');

  function workspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-recheck-agg-'));
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
    }
    const config = quiet(() => buildConfig({ ...ANSWERS, 'q-biz-phase': 'growth' }, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write('process.config.json', JSON.stringify(config, null, 2) + '\n');
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'tester'], ['core.autocrlf', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false']]) git('config', k, v);
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: fixture');
    const commit = (subject, files, trailers = 'Risk: R3') => {
      for (const [rel, text] of Object.entries(files)) {
        if (text === null) fs.rmSync(path.join(dir, rel));
        else write(rel, text);
      }
      git('add', '-A');
      git('commit', '-q', '-m', `${subject}\n\n${trailers}\nVerification: 手元で確かめた`);
      return git('rev-parse', 'HEAD').trim();
    };
    const tpl = fs.readFileSync(path.join(ROOT, 'templates/04-gate-record.md'), 'utf8');
    const form = (target, result, at) =>
      tpl
        .replace(/^\| 対象 \|.*$/m, `| 対象 | ${target} |`)
        .replace(/^\| 判定者 \|.*$/m, '| 判定者 | 名簿 戊 |')
        .replace(/^\| 判定日時 \|.*$/m, `| 判定日時 | ${at} |`)
        .replace(/^\| 結果 \|.*$/m, `| 結果 | ${result} |`);
    const run = () => {
      const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' } });
      const rd = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
      let ev = null;
      try {
        ev = JSON.parse(rd('evidence/evidence.json'));
      } catch {
        ev = null;
      }
      const sr = ev?.specRecheck ?? { match: -1, mismatch: -1, unconfirmed: -1, unconfirmedReasons: {}, items: [] };
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ev, sr, report: rd('evidence/quality-report.md'), external: rd('evidence/assurance-disclosure.external.md') };
    };
    return { dir, git, commit, form, run, done: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
  }

  const scene = (name, fn) => {
    const w = workspace();
    try {
      fn(w);
    } catch (e) {
      t(`通し ${name}: 例外なく走る`, false, String(e.message ?? e).slice(0, 300));
    } finally {
      w.done();
    }
  };
  const ran = (name, r) => t(`通し ${name}: 集約が最後まで走る`, /を出力しました/.test(r.out), r.out.split('\n').slice(-6).join(' | '));
  const recGap = (r, id) => r.out.split('\n').filter((l) => l.includes(`仕様 ${id}: 確定した版から`));
  const base5Gap = (r, id) => r.out.split('\n').filter((l) => l.includes(`仕様 ${id}: 変更(`));
  const merge = (w, branch, n) => w.git('merge', '-q', '--no-ff', '-m', `Merge pull request #${n} from o/${branch}`, branch);
  const copyOf = (n, mc, head, reviews = []) =>
    JSON.stringify({ repository: 'o/r', pr: n, title: 'x', body: '## リスク区分\n\nR3\n', head_ref: 'feat', merge_commit_sha: mc, head_sha: head, author: { id: 11, login: 'acc1' }, merged_at: '2026-11-03T00:00:00Z', merged_by: { login: 'acc1' }, base: { ref: 'main' }, default_branch: 'main', copied_at: '2026-11-03T00:01:00Z', copied_by: 'record-copy workflow (GITHUB_TOKEN)', reviews, audit_log: 'x' }, null, 2) + '\n';
  const G4 = (w, id, c, result = '通過', at = '2026-11-01 10:00') => ({ [`docs/gates/g4-${id}-${at.slice(0, 10)}-${result === '通過' ? 'p' : 'r'}.md`]: w.form(`${id} / ${c.slice(0, 7)}`, result, at) });
  const review = (h, id = 2, uid = 10) => [{ id, state: 'APPROVED', commit_id: h, submitted_at: '2026-11-02T00:00:00Z', user: { id: uid, login: `acc${uid - 10}` }, body: 'G-4: 通過\n確認した項目: 基準1' }];

  // A / B: 判定の版の後に受入基準を変更 → 不一致(::error:: と evidence.json の specRecheck、終了コード)。変更なし → 一致
  scene('A/B', (w) => {
    const c1 = w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.commit('docs: g4', G4(w, 'F-001', c1));
    const rb = w.run();
    ran('B', rb);
    // IMPL-0241:ok(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し B(適合): 変更が無ければ一致。欠落にしない', rb.sr.match === 1 && rb.sr.mismatch === 0 && recGap(rb, 'F-001').length === 0, JSON.stringify(rb.sr));
    w.commit('docs: spec v2', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
    const ra = w.run();
    ran('A', ra);
    // IMPL-0241:ng(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し A(違反): 判定の版の後に受入基準を変更すると、::error:: の欠落と evidence.json の specRecheck.mismatch', ra.sr.mismatch === 1 && ra.sr.items[0]?.sections?.join() === '受入基準' && recGap(ra, 'F-001').some((l) => /::error::/.test(l)), JSON.stringify(ra.sr) + ra.out.slice(-300));
    const errs = (r) => r.out.split(/\r?\n/).filter((l) => /::error::/.test(l)).length;
    t('通し A: B より ::error:: が増え、終了コードは 0 でない(B は無関係の欠落で既に 0 でないため、増分で確かめる)', ra.status !== 0 && errs(ra) > errs(rb), `A=${ra.status}/${errs(ra)} B=${rb.status}/${errs(rb)}`);
  });

  // D: 通過(v1) → 変更(v2) → 差し戻し(v2)。先端は差し戻された v2。通過は打ち消され、変更後の版を対象とする効いている通過が無い → 不一致
  scene('D', (w) => {
    const c1 = w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.commit('docs: g4 pass', G4(w, 'F-001', c1));
    const c2 = w.commit('docs: spec v2', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
    w.commit('docs: g4 reject', G4(w, 'F-001', c2, '差し戻し', '2026-11-02 10:00'));
    const r = w.run();
    ran('D', r);
    // IMPL-0241:ng(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し D(違反): 通過(v1)が打ち消され、先端は差し戻された v2 → 不一致の欠落', r.sr.mismatch === 1 && recGap(r, 'F-001').length === 1 && /打ち消されている/.test(recGap(r, 'F-001')[0]) && r.sr.items[0]?.cancelled === true, JSON.stringify(r.sr));
  });
  // D2 / M: 先端の版の通過が差し戻しで打ち消されている(判定日時が空で前後が決まらない場合を含む) → 未確認。欠落 0
  scene('D2', (w) => {
    const c1 = w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.commit('docs: g4 pass', G4(w, 'F-001', c1));
    w.commit('docs: g4 reject', G4(w, 'F-001', c1, '差し戻し', '2026-11-02 10:00'));
    const r = w.run();
    ran('D2', r);
    // IMPL-0241:ok(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し D2(適合): 先端の版の通過が後の差し戻しで打ち消されている → 未確認。欠落に数えない', r.sr.unconfirmed === 1 && r.sr.mismatch === 0 && recGap(r, 'F-001').length === 0 && Object.keys(r.sr.unconfirmedReasons).some((k) => /差し戻しで打ち消されている/.test(k)), JSON.stringify(r.sr));
  });
  scene('M', (w) => {
    const c1 = w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.commit('docs: g4 reject', G4(w, 'F-001', c1, '差し戻し', '2026-11-01 10:00'));
    w.commit('docs: g4 pass no date', { 'docs/gates/g4-F-001-nodate.md': w.form(`F-001 / ${c1.slice(0, 7)}`, '通過', '') });
    const r = w.run();
    ran('M', r);
    t('通し M: 判定日時が空の通過は前後が決まらず打ち消し扱い → 未確認。欠落 0', r.sr.unconfirmed === 1 && r.sr.mismatch === 0 && recGap(r, 'F-001').length === 0, JSON.stringify(r.sr));
  });

  // E: 版の無い対象(F-001 だけ) → 未確認で欠落 0。R1-06: 品質レポートに機能・記録の所在・理由を出し、外部向けは件数だけ
  scene('E', (w) => {
    w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.commit('docs: g4', { 'docs/gates/g4-F-001-2026-11-01.md': w.form('F-001', '通過', '2026-11-01 10:00') });
    w.commit('docs: spec v2', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
    const r = w.run();
    ran('E', r);
    // IMPL-0241:ok(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し E(適合): 対象に版が無ければ未確認。欠落 0、不一致 0', r.sr.unconfirmed === 1 && r.sr.mismatch === 0 && recGap(r, 'F-001').length === 0, JSON.stringify(r.sr));
    t('通し E(R1-06): 品質レポートが未確認の機能・判定記録の所在・理由を一覧に出す', /- 未確認 F-001\(判定記録: docs\/gates\/g4-F-001-2026-11-01\.md\): .*版が無い/.test(r.report), r.report.split('\n').filter((l) => /未確認/.test(l)).join('\n'));
    t('通し E(R1-06): 外部向けの開示は件数だけ(機能 ID・理由の文を出さない)', /確定した版の再確認.*未確認 1/.test(r.external) && !/- 未確認 F-001/.test(r.external) && !/版が無い/.test(r.external), r.external.split('\n').filter((l) => /確定した版/.test(l)).join('\n'));
  });

  // C / C2: G-4 の通過の記録が1件も無い → 未確認。理由の文は実態(トレーラ Spec が指す場合に限り基準5)。トレーラ Spec があれば基準5 の欠落
  scene('C', (w) => {
    w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.commit('docs: spec v2', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
    const r = w.run();
    ran('C', r);
    // IMPL-0241:ok(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し C(適合): 記録もトレーラ Spec も無い → 未確認。理由の文は「指さない場合、機械は欠落にしない」。欠落 0', r.sr.unconfirmed === 1 && recGap(r, 'F-001').length === 0 && base5Gap(r, 'F-001').length === 0 && Object.keys(r.sr.unconfirmedReasons).some((k) => /トレーラ Spec がこの機能を指す場合に限り.*指さない場合、機械は欠落にしない/.test(k)), JSON.stringify(r.sr));
  });
  scene('C2', (w) => {
    w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.commit('docs: spec v2', { 'specs/F-001/spec.md': S3({ ac: 'y' }) }, 'Risk: R3\nSpec: F-001');
    const r = w.run();
    ran('C2', r);
    // IMPL-0241:ng(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し C2(違反): トレーラ Spec が指す機能に記録が無ければ、G-7 基準5 の欠落が当たる(再確認は未確認のまま)', base5Gap(r, 'F-001').length === 1 && r.sr.unconfirmed === 1 && r.sr.mismatch === 0, JSON.stringify(r.sr) + r.out.slice(-200));
  });

  // H: スコープ外の節だけが無い仕様で、背景(3節の外)だけ変更 → 未確認(一致にならない。R1-05: 両側で取り出せない節が在れば、全文が違う限り未確認)
  scene('H', (w) => {
    const noScope = (bg) => S3({ bg }).replace(/## スコープ外\n\n- 一括招待\n\n/, '');
    const c1 = w.commit('docs: spec v1', { 'specs/F-001/spec.md': noScope('招待する。') });
    w.commit('docs: g4', G4(w, 'F-001', c1));
    w.commit('docs: spec v2', { 'specs/F-001/spec.md': noScope('招待を送る。') });
    const r = w.run();
    ran('H', r);
    t('通し H: 3節のうち両側で取り出せない節が在る仕様は、3節に不一致が無くても全文が違えば未確認(欠落 0)', r.sr.unconfirmed === 1 && r.sr.match === 0 && r.sr.mismatch === 0 && recGap(r, 'F-001').length === 0, JSON.stringify(r.sr));
  });

  // Q1 / Q1b: PR の経路も、再確認の対象は spec.md の変更に限る(R1-03)
  scene('Q1', (w) => {
    const c1 = w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3(), 'specs/F-001/plan.md': 'a\n' });
    w.commit('docs: g4', G4(w, 'F-001', c1));
    w.commit('docs: spec v2 (before range)', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
    w.git('tag', 'v1.0.0');
    w.git('switch', '-q', '-c', 'b1');
    const h = w.commit('docs: plan', { 'specs/F-001/plan.md': 'b\n' });
    w.git('switch', '-q', 'main');
    merge(w, 'b1', 1);
    const mc = w.git('rev-parse', 'HEAD').trim();
    w.commit('docs: copy', { 'docs/records/reviews/pr-1.json': copyOf(1, mc, h) });
    w.git('tag', 'v1.1.0');
    const r = w.run();
    ran('Q1', r);
    // IMPL-0241:ok(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し Q1(適合): 範囲の PR が plan.md だけを変える → 再確認の項目なし(範囲の前の変更を見ない)', r.sr.items.length === 0 && r.sr.mismatch === 0 && recGap(r, 'F-001').length === 0, JSON.stringify(r.sr));
  });
  scene('Q1b', (w) => {
    const c1 = w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.commit('docs: g4', G4(w, 'F-001', c1));
    w.git('tag', 'v1.0.0');
    w.git('switch', '-q', '-c', 'b1');
    const h = w.commit('docs: ac', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
    w.git('switch', '-q', 'main');
    merge(w, 'b1', 1);
    const mc = w.git('rev-parse', 'HEAD').trim();
    w.commit('docs: copy', { 'docs/records/reviews/pr-1.json': copyOf(1, mc, h) });
    w.git('tag', 'v1.1.0');
    const r = w.run();
    ran('Q1b', r);
    // IMPL-0241:ng(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し Q1b(違反): 範囲の PR が spec.md の受入基準を変える → 不一致の欠落', r.sr.mismatch === 1 && recGap(r, 'F-001').length === 1, JSON.stringify(r.sr));
  });

  // Q2 / Q3 / Q2b / Q2c: 写し(判定者本人のレビュー)の経路
  scene('Q2', (w) => {
    const c0 = w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.git('switch', '-q', '-c', 'b1');
    const h = w.commit('docs: ac', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
    w.git('switch', '-q', 'main');
    merge(w, 'b1', 2);
    const mc = w.git('rev-parse', 'HEAD').trim();
    w.commit('docs: copy', { 'docs/records/reviews/pr-2.json': copyOf(2, mc, h, review(h)) });
    const r2 = w.run();
    ran('Q2', r2);
    // IMPL-0241:ok(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し Q2(適合): 写しの G-4 の通過(commit_id = head)の版が先端と同じ → 一致', r2.sr.match === 1 && r2.sr.mismatch === 0 && recGap(r2, 'F-001').length === 0, JSON.stringify(r2.sr));
    w.commit('docs: ac again', { 'specs/F-001/spec.md': S3({ ac: 'z' }) });
    const r3 = w.run();
    // IMPL-0241:ng(違反と適合の対。標準の実装マーク。process-compass #355)
    t('通し Q3(違反): その後に判定なしで受入基準を変更 → 不一致。記録は写しの所在(PR #2 のレビュー)', r3.sr.mismatch === 1 && /PR #2 のレビュー/.test(r3.sr.items[0]?.record ?? '') && recGap(r3, 'F-001').length === 1, JSON.stringify(r3.sr));
    void c0;
  });
  scene('Q2b', (w) => {
    w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.git('switch', '-q', '-c', 'b1');
    const h = w.commit('docs: ac', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
    w.git('switch', '-q', 'main');
    merge(w, 'b1', 2);
    const mc = w.git('rev-parse', 'HEAD').trim();
    // 判定する席の責任者(acc0)でない者(acc1)の宣言行 → 通過の記録に数えない(未確認。欠落 0)
    w.commit('docs: copy', { 'docs/records/reviews/pr-2.json': copyOf(2, mc, h, review(h, 2, 11)) });
    const r = w.run();
    ran('Q2b', r);
    t('通し Q2b: 判定する席の責任者でない者の通過は通過の記録に数えない → 未確認(不一致にも一致にもならない)', r.sr.match === 0 && r.sr.mismatch === 0 && r.sr.unconfirmed === 1, JSON.stringify(r.sr));
  });

  // Q2c / Q2d: headMatch が偽の写し(commit_id がマージ時の head でない)・結果が通過でない宣言行は、通過の記録に数えない
  for (const [name, mkReview, why] of [
    ['Q2c', (h, c0) => review(c0), 'commit_id がマージ時の head と違う写し(headMatch 偽)'],
    ['Q2d', (h) => [{ ...review(h)[0], body: 'G-4: 差し戻し\n理由: 基準1' }], '結果が通過でない宣言行'],
  ]) {
    scene(name, (w) => {
      const c0 = w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
      w.git('switch', '-q', '-c', 'b1');
      const h = w.commit('docs: ac', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
      w.git('switch', '-q', 'main');
      merge(w, 'b1', 2);
      const mc = w.git('rev-parse', 'HEAD').trim();
      w.commit('docs: copy', { 'docs/records/reviews/pr-2.json': copyOf(2, mc, h, mkReview(h, c0)) });
      const r = w.run();
      ran(name, r);
      t(`通し ${name}: ${why}は通過の記録に数えない → 未確認(一致にならない)`, r.sr.match === 0 && r.sr.unconfirmed === 1 && recGap(r, 'F-001').length === 0, JSON.stringify(r.sr));
    });
  }

  // Q4: 限界の固定。写しの通過(v2)の後に、様式で同じ版を差し戻しても、媒体をまたぐ前後は比べないため一致のまま
  scene('Q4', (w) => {
    w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.git('switch', '-q', '-c', 'b1');
    const h = w.commit('docs: ac', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
    w.git('switch', '-q', 'main');
    merge(w, 'b1', 2);
    const mc = w.git('rev-parse', 'HEAD').trim();
    w.commit('docs: copy', { 'docs/records/reviews/pr-2.json': copyOf(2, mc, h, review(h)) });
    w.commit('docs: g4 reject', G4(w, 'F-001', h, '差し戻し', '2026-11-05 10:00'));
    const r = w.run();
    ran('Q4', r);
    t('通し Q4(限界の固定): 写しの通過の後に様式で同じ版を差し戻しても一致のまま(様式と写しの間の前後は比べない)', r.sr.match === 1 && r.sr.mismatch === 0, JSON.stringify(r.sr));
  });

  // P2: 限界の固定。2つの変更が別の節を変え、それぞれの head で通過しても、合流後の版は誰も判定していないので不一致
  scene('P2', (w) => {
    w.commit('docs: spec v1', { 'specs/F-001/spec.md': S3() });
    w.git('switch', '-q', '-c', 'a');
    const ha = w.commit('docs: premise', { 'specs/F-001/spec.md': S3({ premise: '- 利用者は未登録' }) });
    w.git('switch', '-q', 'main');
    w.git('switch', '-q', '-c', 'b');
    const hb = w.commit('docs: ac', { 'specs/F-001/spec.md': S3({ ac: 'y' }) });
    w.git('switch', '-q', 'main');
    merge(w, 'a', 1);
    merge(w, 'b', 2);
    w.commit('docs: g4 a', G4(w, 'F-001', ha, '通過', '2026-11-01 10:00'));
    w.commit('docs: g4 b', G4(w, 'F-001', hb, '通過', '2026-11-02 10:00'));
    const r = w.run();
    ran('P2', r);
    t('通し P2(限界の固定): 各 head で通過しても、合流後の版はどちらとも一致せず不一致', r.sr.mismatch === 1 && recGap(r, 'F-001').length === 1, JSON.stringify(r.sr));
  });
}

console.log(`\n確定した版の再確認の試験: ${failed ? `${failed} 件が期待と一致しません` : `${total} 件が期待と一致しました`}`);
process.exit(failed ? 1 : 0);
