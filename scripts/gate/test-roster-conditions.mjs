// 外部の確認者を置ける席・(イ)の条件の記録・確認者の力量・承認権限の一時制限・組織上の距離の段の反証・受託の価値責任者を試験する
// (標準 第3章 3.4.1・3.5、第7章 7.9、第1章 1.4、第8章 軸D・軸E。process-compass #357 / ADR-0127)。
//
//   node scripts/gate/test-roster-conditions.mjs
//
// 固定すること:
//   - 外部の確認者を独立レビュア以外の席の責任者に置く構成を拒む(IMPL-0463)。外部の確認者を独立レビュアの席の責任者に置くには、
//     名簿の reviewCompetence と席の agreement の記録を要する。3名以上の体制でも同じ(IMPL-0116。ADR-0127 決定2・3)
//   - 名簿の行の未知の欄、席の agreement を独立レビュア以外へ書く入力、範囲の無い制限の発動を、変化点の入口が拒む(決定5・10)
//   - 制限の発動と解除を記録へ残し、解除されていない制限の範囲に触れる変更だけに2名を求める(IMPL-0118)
//   - 段の反証(リリースの権限を持つ席、同じ所属)で記録した段を引き下げる。満たす向きには使わない(IMPL-0344・0452)
//   - 受託の価値責任者を様式 08 の行と照らす(IMPL-0462)
//   - 出荷の証跡の集約が、席の限定の違反と価値責任者の食い違いを記録の欠落にし、力量の件数の行と制限の行を保証の開示へ出す
// GitHub へ問い合わせません。リポジトリの状態を変えません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROOT,
  namingProblems,
  externalSeatProblems,
  reviewCompetenceProblems,
  restrictionState,
  restrictionHit,
  restrictionInputProblems,
  stepCeiling,
  valueOwnerAgreementState,
  sealChangeLog,
} from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-10).join('\n       ')}`}`);
}
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

const ANS = (o = {}) => ({
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9', 'q-biz-phase': 'growth', 'q-external-reviewer': 'reviewer-yes', ...o,
});
const A = { id: 'a', name: '山田 太郎', accounts: ['yamada'] };
const B = { id: 'b', name: '鈴木 花子', accounts: ['suzuki'] };
const C = { id: 'c', name: '佐藤 一郎', accounts: ['sato'] };
const COMP = { confirmedAt: '2026-11-01', confirmedBy: '山田 太郎', record: 'docs/review-competence/x.md' };
const X = { id: 'x', name: '高橋 次郎', external: true, accounts: ['takahashi'] };
const AGR = { at: '2026-11-01', record: 'docs/agreements/x.pdf' };
const seats = (map, extra = {}) => Object.entries(map).map(([role, accountable]) => ({ role, accountable, ...(extra[role] ?? {}) }));
const cfg = (answers, people, map, extra) => quiet(() => buildConfig(answers, { generatedAt: '2026-11-12T09:00:00+09:00', d0Version: null, people, seats: seats(map, extra) }).config);
const BASE3 = { 'value-owner': 'a', 'tech-lead': 'c', 'dev-verifier': 'b', 'independent-reviewer': 'c', 'qa-gatekeeper': 'a', 'biz-approver': 'c' };

// ---------------------------------------------------------------- 席の限定(IMPL-0463)
{
  // IMPL-0463:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const ng = cfg(ANS(), [A, B, C, X], { ...BASE3, 'value-owner': 'x' });
  const p = namingProblems(ng);
  check('席の限定: 外部の確認者を価値責任者の席の責任者に置く構成を拒む', p.some((x) => /価値責任者.*外部の確認者.*独立レビュアの席に限る/.test(x)), p.join('\n'));
  const ng2 = cfg(ANS(), [A, B, C, X], { ...BASE3, 'biz-approver': 'x' });
  check('席の限定: 事業決裁者(D-0 表1 の決定者)の席も拒む。外部の確認者が緩める向きの決定者になる経路を塞ぐ', namingProblems(ng2).some((x) => /事業決裁者.*独立レビュアの席に限る/.test(x)), namingProblems(ng2).join('\n'));
  const ng3 = cfg(ANS({ 'q-team-size': 'size-1-2', 'q-dev-form': 'vendor' }), [A, X], { 'value-owner': 'x', 'biz-approver': 'x', 'dev-verifier': 'a', 'independent-reviewer': 'a' });
  check('席の限定: 受託で発注側の席の人を外部の確認者として載せる構成を拒み、体制の内として載せるよう名指す', externalSeatProblems(ng3).some((x) => /発注側に置く席の人も体制の内/.test(x)), externalSeatProblems(ng3).join('\n'));
  // IMPL-0463:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const ok = cfg(ANS(), [A, B, C, { ...X, external: false }], { ...BASE3, 'value-owner': 'x' });
  check('席の限定: 同じ人を体制の内(external: false)として載せれば受け付ける', !externalSeatProblems(ok).length, externalSeatProblems(ok).join('\n'));
}

// ---------------------------------------------------------------- (イ)の条件の記録(IMPL-0116。3名以上を含む)
{
  // IMPL-0116:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const ng = cfg(ANS({ 'q-team-size': 'size-1-2' }), [A, X], { 'value-owner': 'a', 'dev-verifier': 'a', 'independent-reviewer': 'x', 'biz-approver': 'a' });
  const p = externalSeatProblems(ng);
  check('(イ): 力量の確認の記録と書面の合意の所在が無ければ拒む', p.some((x) => /力量の確認の記録.*書面の合意の所在/.test(x)), p.join('\n'));
  const half = cfg(ANS({ 'q-team-size': 'size-1-2' }), [A, { ...X, reviewCompetence: COMP }], { 'value-owner': 'a', 'dev-verifier': 'a', 'independent-reviewer': 'x', 'biz-approver': 'a' });
  check('(イ): 力量の記録だけでは足りない(書面の合意の所在を要する)', externalSeatProblems(half).some((x) => /書面の合意の所在/.test(x) && !/力量の確認の記録\(/.test(x)), externalSeatProblems(half).join('\n'));
  const three = cfg(ANS(), [A, B, C, X], { ...BASE3, 'independent-reviewer': 'x' });
  check('(イ): 3名以上の体制でも同じ条件を掛ける(ADR-0127 決定2)', externalSeatProblems(three).some((x) => /3\.5 の\(イ\)/.test(x)), externalSeatProblems(three).join('\n'));
  // IMPL-0116:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const ok = cfg(ANS(), [A, B, C, { ...X, reviewCompetence: COMP }], { ...BASE3, 'independent-reviewer': 'x' }, { 'independent-reviewer': { agreement: AGR } });
  check('(イ): 両方の記録があれば受け付ける(中身は確かめない)', !externalSeatProblems(ok).length, externalSeatProblems(ok).join('\n'));
  check('(イ): 席の agreement は構成へ残る(所在だけ)', ok.seats.find((s) => s.role === 'independent-reviewer')?.agreement?.record === AGR.record, JSON.stringify(ok.seats.find((s) => s.role === 'independent-reviewer')));
  // IMPL-0117:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const self = { ...X, reviewCompetence: { ...COMP, confirmedBy: '高橋 次郎' } };
  check('確認者の力量: 本人が確認した記録は受け付けない', reviewCompetenceProblems({ people: [A, self] }, self).some((x) => /本人/.test(x)));
  const ai = { ...X, reviewCompetence: { ...COMP, confirmedBy: 'Claude' } };
  // IMPL-0117:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('確認者の力量: 力量の記録を持つ確認者は受け付ける', !reviewCompetenceProblems({ people: [A, { ...X, reviewCompetence: COMP }] }, { ...X, reviewCompetence: COMP }).length);
  check('確認者の力量: AI の名義の確認した者は受け付けない', reviewCompetenceProblems({ people: [A, ai] }, ai).some((x) => /AI の名義/.test(x)));
}

// ---------------------------------------------------------------- 承認権限の一時制限(IMPL-0118)
{
  const base = cfg(ANS(), [A, B, C], BASE3);
  const R = { id: 'r1', person: '佐藤 一郎', paths: ['src/payments/**'], basis: 'docs/injection/2026-11.md', recordedBy: '鈴木 花子' };
  check('制限: 範囲(paths)の無い発動を拒む', restrictionInputProblems(base, { kind: 'notice', event: 'restriction', restriction: { ...R, paths: [] } }).some((x) => /paths/.test(x)));
  check('制限: 記録した者が AI の名義なら拒む(機械による発動は行わない)', restrictionInputProblems(base, { kind: 'notice', event: 'restriction', restriction: { ...R, recordedBy: 'Claude' } }).some((x) => /AI の名義/.test(x)));
  check('制限: 発動の記録の無い識別子の解除を拒む', restrictionInputProblems(base, { kind: 'notice', event: 'restriction-release', restriction: { id: 'r9', basis: '連続2回の検出', recordedBy: '鈴木 花子' } }).some((x) => /解除されていない制限/.test(x)));
  const log = [
    { kind: 'notice', date: '2026-11-02', event: 'restriction', restriction: R, notice: { reasons: ['承認権限の一時制限(標準 第7章 7.9)の発動'] } },
    { kind: 'notice', date: '2026-11-03', notice: { reasons: ['承認権限の一時制限(標準 第7章 7.9)の発動'] } },
  ];
  const withR = { ...base, changeLog: [...base.changeLog, ...log] };
  const st = restrictionState(withR);
  check('制限: 解除されていない制限と、範囲の無い旧い発動の記録を読む', st.active.length === 1 && st.legacy === 1, JSON.stringify(st));
  // IMPL-0118:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('制限: 範囲に触れる変更は制限に当たる(だれが承認したかに依らない)', restrictionHit(withR, ['src/payments/pay.js'], '2026-11-05').hit);
  // IMPL-0118:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('制限: 範囲の外の変更は当たらない', !restrictionHit(withR, ['src/ui/a.js'], '2026-11-05').hit);
  check('制限: 発動より前に取り込んだ変更は当たらない', !restrictionHit(withR, ['src/payments/pay.js'], '2026-11-01').hit);
  const released = { ...withR, changeLog: [...withR.changeLog, { kind: 'notice', date: '2026-11-10', event: 'restriction-release', restriction: { id: 'r1', basis: '連続2回の検出', recordedBy: '鈴木 花子' } }] };
  check('制限: 解除の後の変更は当たらず、解除の前の変更は当たる', !restrictionHit(released, ['src/payments/pay.js'], '2026-11-11').hit && restrictionHit(released, ['src/payments/pay.js'], '2026-11-09').hit);
  check('制限: 解除した識別子は再び使えない', restrictionInputProblems(released, { kind: 'notice', event: 'restriction', restriction: R }).some((x) => /既に使われています/.test(x)));
}

// ---------------------------------------------------------------- 段の反証(IMPL-0344・0452・0184)
{
  const c = cfg(ANS(), [{ ...A, team: '開発部' }, { ...B, team: '開発部' }, { ...C, team: '品質保証部' }], BASE3);
  // IMPL-0344:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const rel = stepCeiling(c, '山田 太郎', ['鈴木 花子']);
  check('段の反証: 出荷判定者の席の責任者は段2 以上に数えない(リリースの権限)', rel.ceiling === 1 && /リリースの権限/.test(rel.reasons.join()), JSON.stringify(rel));
  const same = stepCeiling({ ...c, seats: c.seats.map((s) => (s.role === 'qa-gatekeeper' || s.role === 'biz-approver' ? { ...s, accountable: 'c' } : s)) }, '山田 太郎', ['鈴木 花子']);
  check('段の反証: 実装の責任者と同じ所属(team)の人は段3 以上に数えない', same.ceiling === 2 && /同じ/.test(same.reasons.join()), JSON.stringify(same));
  // IMPL-0344:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const none = stepCeiling({ ...c, seats: c.seats.map((s) => (['qa-gatekeeper', 'biz-approver', 'value-owner'].includes(s.role) ? { ...s, accountable: 'a' } : s)) }, '佐藤 一郎', ['鈴木 花子']);
  check('段の反証: 反証が無ければ引き下げない(所属が別でも満たす向きには使わない。上限を変えないだけ)', none.ceiling === 4 && !none.reasons.length, JSON.stringify(none));
}

// ---------------------------------------------------------------- 受託の価値責任者(IMPL-0462)
{
  const v = cfg(ANS({ 'q-dev-form': 'vendor' }), [A, B, C], BASE3);
  const sla = (cell) => `## 9. 判定の置き先と結果の受け渡し\n\n| 項目 | 合意 |\n| --- | --- |\n| 価値責任者(発注側が選任した者) | ${cell} |\n`;
  check('価値責任者: 受託でない構成には掛けない', !valueOwnerAgreementState(cfg(ANS(), [A, B, C], BASE3), sla('鈴木 花子')).applies);
  check('価値責任者: 行が雛形のままなら空欄', valueOwnerAgreementState(v, sla('<発注側の氏名>')).state === 'blank');
  // IMPL-0462:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('価値責任者: 様式 08 の氏名と席の責任者が食い違えば mismatch', valueOwnerAgreementState(v, sla('鈴木 花子')).state === 'mismatch');
  // IMPL-0462:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const m = valueOwnerAgreementState(v, sla('山田 太郎(発注側 事業部)'));
  check('価値責任者: 一致すれば match。発注側の人であることは機械では確かめていないと出す', m.state === 'match' && /機械では確かめていない/.test(m.text), JSON.stringify(m));
}

// ---------------------------------------------------------------- 変化点の入口と、出荷の証跡の集約の通し
function workspace(config, extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-roster-cond-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('process.config.json', JSON.stringify(sealChangeLog(config), null, 2) + '\n');
  write('docs/D-0-governance.md', fs.readFileSync(path.join(dir, 'templates/00-d0-governance.md'), 'utf8'));
  for (const [rel, text] of Object.entries(extraFiles)) write(rel, text);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  // コミットの作成者を名簿の人(開発者の席の責任者)にする。作成を指示した者を名簿へ対応づけるため
  git('config', 'user.name', B.name);
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: fixture');
  const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  const change = (obj) => {
    write('change.json', JSON.stringify(obj));
    const r = spawnSync(process.execPath, ['scripts/init/generate-profile.mjs', '--change', 'change.json'], { cwd: dir, encoding: 'utf8', env });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const aggregate = () => {
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], { cwd: dir, encoding: 'utf8', env });
    const report = fs.existsSync(path.join(dir, 'evidence/quality-report.md')) ? fs.readFileSync(path.join(dir, 'evidence/quality-report.md'), 'utf8') : '';
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, report };
  };
  const cfgNow = () => JSON.parse(fs.readFileSync(path.join(dir, 'process.config.json'), 'utf8'));
  // PR を経ないコミットと、それを対象とする G-6 の判定記録(判定者と挙動要約)を積む
  const commitWithG6 = (rel, judge, extraRows = '') => {
    write(rel, `export const v = ${Math.random()};\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'fix: change\n\nRisk: R3\nVerification: 手元で試験を実行し、通過を確かめた');
    const hash = git('rev-parse', 'HEAD').trim().slice(0, 8);
    write(
      `docs/gates/g6-${hash}.md`,
      `# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | G-6 独立レビュー |\n| 対象 | コミット ${hash} |\n| 判定者 | ${judge} |\n| 判定日時 | 2026-11-12 10:00 |\n| 結果 | 通過 |\n| 変更のリスク区分 | R3 |\n${extraRows}\n## 挙動要約\n\n支払いの金額の丸めを、端数を切り捨てる挙動へ変えたことを差分で確かめた。\n`
    );
    git('add', '-A');
    git('commit', '-q', '-m', `docs: G-6 の判定記録 ${hash}`);
    return hash;
  };
  // KEEP_WORKSPACE=1 のときは作業場所を残して所在を出す(失敗の調べ方)
  const done = () => (process.env.KEEP_WORKSPACE ? console.log(`作業場所: ${dir}`) : fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { change, aggregate, cfgNow, commitWithG6, done };
}

{
  const w = workspace(cfg(ANS(), [A, B, C], BASE3));
  const unknown = w.change({ kind: 'accountable', summary: '名簿', people: [{ ...A, manager: '部長' }, B, C], decidedBy: C.name, reason: '試験' });
  check('入口: 名簿の行の未知の欄を、黙って捨てずに拒む(ADR-0127 決定10)', !unknown.ok && /people\[0\] に書けない欄があります\(manager\)/.test(unknown.out), unknown.out);
  const agrOther = w.change({ kind: 'accountable', summary: '合意', seats: { 'value-owner': { agreement: AGR } }, decidedBy: C.name, reason: '試験' });
  check('入口: 書面の合意の所在(agreement)は独立レビュアの席にだけ書ける', !agrOther.ok && /seats\.value-owner に書けない欄があります\(agreement\)/.test(agrOther.out), agrOther.out);
  const toExt = w.change({ kind: 'accountable', summary: '外部の確認者を価値責任者へ', people: [A, B, C, X], seats: { 'value-owner': { accountable: 'x' } }, decidedBy: C.name, reason: '試験' });
  check('入口: 外部の確認者を価値責任者に置く任免を拒む(IMPL-0463)', !toExt.ok && /独立レビュアの席に限る/.test(toExt.out), toExt.out);
  const noScope = w.change({ kind: 'notice', summary: '制限', event: 'restriction', notice: { to: A.name, at: '2026-11-12' } });
  check('入口: 範囲・対象の人の無い制限の発動を拒む', !noScope.ok && /restriction を/.test(noScope.out), noScope.out);
  const R = { id: 'pay-1', person: C.name, paths: ['src/payments/**'], basis: 'docs/injection/2026-11.md', recordedBy: B.name };
  const fire = w.change({ kind: 'notice', summary: '制限の発動', event: 'restriction', restriction: R, notice: { to: A.name, at: '2026-11-12' } });
  const rec = w.cfgNow().changeLog.at(-1);
  check('入口: 制限の発動の範囲・対象の人・根拠・記録した者を記録に残す(7.9.6)', fire.ok && rec.event === 'restriction' && rec.restriction?.paths?.[0] === 'src/payments/**' && rec.restriction?.recordedBy === B.name, `${fire.out}\n${JSON.stringify(rec)}`);
  const inRange = w.commitWithG6('src/payments/pay.js', C.name);
  const outRange = w.commitWithG6('src/ui/view.js', C.name);
  const agg = w.aggregate();
  const lineOf = (h) => agg.report.split('\n').filter((l) => l.startsWith(`| ${h} |`)).join('\n');
  check(
    '集約: 制限の範囲に触れ、独立レビュア1名の変更は、独立した人の確認に数えない(7.9.2・ADR-0067 決定2)',
    /要求 2 名.*承認権限の一時制限\(第7章 7\.9\.2\)の範囲に触れる: pay-1/.test(lineOf(inRange)) && !/review\.reviewerCount/.test(lineOf(inRange)) && /範囲に触れ、独立レビュア2名に満たず数えなかった変更 1 件/.test(agg.report),
    `${lineOf(inRange)}\n${agg.report.split('\n').filter((l) => /一時制限/.test(l)).join('\n')}`
  );
  check('集約: 範囲の外の変更は、1名の独立レビュアで数える', !/一時制限/.test(lineOf(outRange)), lineOf(outRange));
  check('集約: 保証の開示に、解除されていない制限の行を出す', /承認権限の一時制限\(第7章 7\.9\.2\) \| 解除されていない制限 1 件\(pay-1: src\/payments\/\*\*\)/.test(agg.report), agg.report.split('\n').filter((l) => /一時制限/.test(l)).join('\n') || agg.out.slice(-600));
  check('集約: 保証の開示に、力量の確認の記録が無い確認者・依頼した本人による確認の件数の行を出す(3.4.1)', /力量の確認の記録が無い確認者による確認/.test(agg.report) && /依頼した本人による確認/.test(agg.report), agg.report.slice(0, 600));
  const rel = w.change({ kind: 'notice', summary: '制限の解除', event: 'restriction-release', restriction: { id: 'pay-1', basis: '注入した欠陥を連続2回検出', recordedBy: B.name }, notice: { to: A.name, at: '2026-11-12' } });
  check('入口: 解除を記録できる(期間の経過では解除しない)', rel.ok && w.cfgNow().changeLog.at(-1).event === 'restriction-release', rel.out);
  w.done();
}
{
  // 既存の構成で外部の確認者を独立レビュア以外の席に置いたもの(変化点を経ずに保存された旧い構成)は、集約が記録の欠落にする
  const old = cfg(ANS(), [A, B, C, X], { ...BASE3, 'value-owner': 'x' });
  const w = workspace(old);
  const agg = w.aggregate();
  check('集約: 外部の確認者を独立レビュア以外の席に置いた既存の構成を、記録の欠落にする', /構成の整合: 記名を受け付けられません: 価値責任者.*独立レビュアの席に限る/.test(agg.out), agg.out.split('\n').filter((l) => /構成の整合/.test(l)).join('\n') || agg.out.slice(-600));
  w.done();
}
{
  // CL2 の独立した安全性の評価者の段(O-5 の解消。IMPL-0080・IMPL-0344)。記録した段を読み、反証で引き下げて求める段と比べる
  const D = { id: 'd', name: '田中 三郎', accounts: ['tanaka'] };
  const cl2 = cfg(ANS({ 'q-criticality': 'cl2' }), [A, B, C, D], BASE3);
  const w = workspace(cl2);
  const rows = (who, step) =>
    `| 安全性の評価者 | ${who} |\n| 安全性の評価の記録の所在 | docs/safety/2026-11.md |\n| 安全性の評価者の段 | ${step} |\n| 安全性の評価者の段の根拠 | 直属の上長が異なり、対象のリリースの権限を持たない |\n`;
  // IMPL-0344:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const ngC = w.commitWithG6('src/a.js', C.name, rows(A.name, '段2'));
  // IMPL-0344:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const okC = w.commitWithG6('src/b.js', C.name, rows(D.name, '段2'));
  // IMPL-0184:ng(違反と適合の対。標準の実装マーク。process-compass #314)段階「最強」の検証の担当者の段
  // IMPL-0184:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const sv = (who) => `| 最強の検証の担当者 | ${who} |\n| 最強の検証の担当者の段と根拠 | 段2。直属の上長が異なり、対象のリリースの権限を持たない |\n`;
  const ngS = w.commitWithG6('src/c.js', C.name, rows(D.name, '段2') + sv(A.name));
  const okS = w.commitWithG6('src/d.js', C.name, rows(D.name, '段2') + sv(D.name));
  const agg = w.aggregate();
  // 欠落の一覧は品質レポートに全件が出る(標準出力は件数が多いと省く)
  const all = `${agg.out}\n${agg.report}`.split('\n');
  const g = (h) => all.filter((l) => l.includes(`g6-${h}.md: 安全性の評価者`)).join('\n');
  const s = (h) => all.filter((l) => l.includes(`g6-${h}.md: 段階「最強」`)).join('\n');
  check('集約: 段階「最強」の検証の担当者の段を読み、リリースの権限を持つ人の段2 を段1 として数えて記録の欠落にする', /最強」の検証の担当者 "山田 太郎".*段1 として数えた.*届かない/.test(s(ngS)), s(ngS) || agg.out.slice(-600));
  check('集約: 反証の無い最強の検証の担当者の段2 は、CL2 の求める段に届く', !s(okS), s(okS));
  check('集約: 安全性の評価者の段を読み、リリースの権限を持つ席の責任者の段2 を段1 として数え、届かなければ記録の欠落にする', /段2.*段1 として数えた.*リリースの権限.*求める段 段2 に届かない/.test(g(ngC)), g(ngC) || agg.out.slice(-800));
  check('集約: 反証の無い評価者の段2 は、CL2 の求める段に届く(距離そのものは確かめない)', !/段/.test(g(okC)), g(okC));
  w.done();
}
{
  const vend = cfg(ANS({ 'q-dev-form': 'vendor' }), [A, B, C], BASE3);
  const w = workspace(vend, { 'docs/ai-sla.md': '## 9. 判定の置き先と結果の受け渡し\n\n| 項目 | 合意 |\n| --- | --- |\n| 価値責任者(発注側が選任した者) | 鈴木 花子 |\n' });
  const agg = w.aggregate();
  check('集約: 受託で、様式 08 の価値責任者と席の責任者が食い違えば記録の欠落にする(IMPL-0462)', /価値責任者の所属: .*一致しない/.test(agg.out), agg.out.split('\n').filter((l) => /価値責任者/.test(l)).join('\n') || agg.out.slice(-600));
  w.done();
}

console.log(`\n外部の確認者と制限と段の反証の試験: ${failures ? `${failures} 件の失敗(${checks} 件中)` : `${checks} 件が期待と一致しました`}`);
process.exit(failures ? 1 : 0);
