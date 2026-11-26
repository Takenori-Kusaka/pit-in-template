// 例外承認の回収の期限と、範囲の件数の試験(標準 第7章 7.3・第1章 1.10.2。process-compass #353 / ADR-0134。IMPL-0573・IMPL-0574)
//
//   node scripts/gate/test-exception-expiry.mjs
//
// 固定する決定:
//   - 状態が有効のまま期限の日が突合の日より前の行と、失効の行は、効力を失い、記録の欠落に数える。期限の日の当日は効力がある
//   - 新しい行で承認し直された元の行(本文に、有効で期限内の行の識別がある)は数えない。期限の書き換えは承認のし直しでない
//   - 対象が変更の行・ゲートの判定の行・出荷の範囲の外の行を、区別せず台帳全体で数える
//   - 範囲の件数は、始点で有効だった行と範囲で足された行。未回収と期限超過は終点の台帳で数える。claimStatus は変えない
//   - 日付は引数(--exception-day)で渡す。実行の時計に依らない(全場面が固定の日付)
// GitHub へ問い合わせません。リポジトリの状態を変えません(一時の置き場で集約を動かす)。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sealChangeLog, parseLedger, gateExceptionTarget } from './config.mjs';
import { ghHosting } from './material-attribution.mjs';
import { buildConfig } from '../init/generate-profile.mjs';
import { exceptionStanding, lapsedExceptions, lapsedGapText, countRangeExceptions, overdueExceptionNote, unjudgedGateExceptions, extendedDueRows, lapsedSimilarRows, extensionVerdict, fastTrackMarkOf, fastTrackMetrics, fastTrackMetricsText, stageQuotaFindings, quotaRefillProblem, quotaOfBrief, latestStageGatePass, exceptionQuotaText, mutationBreachExceptionFor, mutationBreachMarkOf } from './exception-expiry.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-6).join('\n       ')}`}`);
}

const DAY = '2026-11-20';
const HEAD = '| ID | 区分 | 対象 | 内容 | 受容した理由 | 顕在化の兆候 | 返却の目安 | 状態 | 記録者 | 承認した者 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
const row = (id, target, due, state, content = 'G-6 基準4 を満たさない') => `| ${id} | 例外 | ${target} | ${content} | 復旧を急ぐ | 不具合 | ${due} | ${state} | 名簿 甲 | 名簿 乙 |\n`;
const ledger = (...rows) => `# 技術負債台帳\n\n${HEAD}${rows.join('')}`;
const rowsOf = (text) => parseLedger(text);
const ids = (text, day = DAY) => lapsedExceptions(rowsOf(text), day).map((x) => x.id);

// ---- 期限の比較(期限内・期限の日の当日・超過・失効)
// IMPL-0574:ok(適合の入力。期限内の有効の行は欠落に数えない)
check('期限内の有効の行は、効力がある', ids(ledger(row('D-001', 'PR #12', '2026-11-30 まで', '未返却'))).length === 0);
check('期限の日の当日は、効力がある(期限の翌日から失効)', exceptionStanding(rowsOf(ledger(row('D-001', 'PR #12', '2026-11-20 まで', '未返却')))[0], DAY) === 'active');
// IMPL-0574:ng(違反の入力。期限を過ぎた有効の行・失効の行を欠落に数える)
check('期限の翌日は、有効のままでも効力を失う', ids(ledger(row('D-001', 'PR #12', '2026-11-19 まで', '未返却'))).join() === 'D-001');
check('状態が失効の行は、期限内でも欠落に数える', ids(ledger(row('D-001', 'PR #12', '2026-12-31', '失効'))).join() === 'D-001');
check('返却済み・取り下げの行は数えない', ids(ledger(row('D-001', 'PR #12', '2026-01-01', '返却済み(2026-02-01)'), row('D-002', 'PR #13', '2026-01-01', '取り下げ'))).length === 0);
check('期限が日付として読めない有効の行は、比べられないため期限超過に数えない(undated)', exceptionStanding(rowsOf(ledger(row('D-001', 'PR #12', '未定', '未返却')))[0], DAY) === 'undated');
check('ゲートの判定を対象とする行も、期限を過ぎれば数える', ids(ledger(row('D-009', 'G-2 F-001', '2026-11-01', '未返却'))).join() === 'D-009');
check('出荷の範囲の外の行(対象が過去のコミット)も数える', ids(ledger(row('D-010', 'abcdef1234', '2026-05-01', '未返却'))).join() === 'D-010');
// ---- 承認のし直し
{
  const re = ledger(row('D-004', 'PR #14', '2026-11-01', '未返却', 'G-6 基準4 を満たさない。D-005 で承認し直した'), row('D-005', 'PR #14', '2026-12-31', '未返却'));
  check('新しい行で承認し直された元の行は、欠落に数えない', ids(re).length === 0);
  const noRef = ledger(row('D-004', 'PR #14', '2026-11-01', '未返却'), row('D-005', 'PR #14', '2026-12-31', '未返却'));
  check('元の行に識別を書かなければ、承認し直しに数えない', ids(noRef).join() === 'D-004');
  const rewritten = ledger(row('D-004', 'PR #14', '2026-11-01', '未返却', 'D-005 で承認し直した'), row('D-005', 'PR #14', '2026-11-05', '未返却'));
  check('承認し直した行も期限を過ぎていれば、両方を数える', ids(rewritten).sort().join() === 'D-004,D-005');
  // 突合の1巡目 H-1: 名指された行は、対象が一致し、元の行より後に足され、有効で期限内でなければならない
  const mutual = ledger(row('D-002', 'PR #14', '2026-11-01', '未返却', 'D-003 で承認し直した'), row('D-003', 'PR #14', '2026-12-31', '未返却', 'D-002 の承認し直し'));
  check('相互に名指す2行: 元の行(D-002)だけを外し、新しい行(D-003)は未回収に数える', ids(mutual).length === 0 && countRangeExceptions({ startText: null, endText: mutual, day: DAY, ledger: 'x' }).uncollected === 1);
  // 突合の2巡目 M2-2: 両方が有効で互いを名指す場面(1巡目の欠陥では両方が未回収から外れた)
  const mutualActive = ledger(row('D-002', 'PR #14', '2026-12-25', '未返却', 'D-003 で承認し直した'), row('D-003', 'PR #14', '2026-12-31', '未返却', 'D-002 の承認し直し'));
  const ma = countRangeExceptions({ startText: null, endText: mutualActive, day: DAY, ledger: 'x' });
  check('相互に名指す2行が両方有効: 新しい行(D-003)は未回収から外れない', ma.inRange === 2 && ma.uncollected === 1 && ids(mutualActive).length === 0, JSON.stringify(ma));
  const mention = ledger(row('D-010', 'G-2 F-001', '2026-11-01', '未返却', 'D-011 と同じ事情'), row('D-011', 'PR #30', '2026-12-31', '未返却'));
  check('付け足しの名指し(対象の異なる有効な行の識別が内容に出るだけ)は、承認し直しに数えない', ids(mention).join() === 'D-010');
  const mentionActive = ledger(row('D-020', 'PR #31', '2026-12-31', '未返却', 'D-021 と同じ事情'), row('D-021', 'PR #32', '2026-12-31', '未返却'));
  const mc = countRangeExceptions({ startText: null, endText: mentionActive, day: DAY, ledger: 'x' });
  check('有効な行が別の対象の行を名指しても、未回収から外れない', mc.inRange === 2 && mc.uncollected === 2, JSON.stringify(mc));
  const older = ledger(row('D-001', 'PR #14', '2026-12-31', '未返却'), row('D-005', 'PR #14', '2026-11-01', '未返却', 'D-001 で承認し直した'));
  check('名指された行が元の行より前に足された行なら、承認し直しに数えない', ids(older).join() === 'D-005');
  const chain = ledger(row('D-001', 'PR #14', '2026-11-01', '未返却', 'D-002 で承認し直した'), row('D-002', 'PR #14', '2026-11-05', '未返却', 'D-003 で承認し直した'), row('D-003', 'PR #14', '2026-12-31', '未返却'));
  check('連鎖: 期限を過ぎた中間の行(D-002)を名指した最初の行(D-001)は、有効で期限内の行を名指していないため数える', ids(chain).join() === 'D-001', ids(chain).join());
  const sameStart = ledger(row('D-050', 'PR #40', '2026-11-01', '未返却', 'D-009 で承認し直した'), row('D-009', 'PR #40', '2026-12-31', '未返却'));
  const ss = lapsedExceptions(rowsOf(sameStart), DAY, new Set(['D-050']));
  check('識別の番号が小さくても、始点の台帳に無い行(範囲で足された行)は新しい行として名指せる', ss.length === 0);
  check('対象の欄が無い行(旧い様式)は、対象の一致を確かめられず、承認し直しに数えない', lapsedExceptions([{ id: 'D-001', kind: '例外', due: '2026-11-01', state: '未返却', text: 'D-002' }, { id: 'D-002', kind: '例外', due: '2026-12-31', state: '未返却', text: '' }], DAY).length === 1);
}
// ---- 閉じた値(突合の1巡目 M-1)。「返却済み」で始まる値と「取り下げ」だけ。それ以外は未回収
{
  const odd = ledger(row('D-001', 'PR #1', '2026-11-01', '未返却(延長申請中)'), row('D-002', 'PR #2', '2026-11-01', '誤記'), row('D-003', 'PR #3', '2026-11-01', ''), row('D-004', 'PR #4', '2026-12-31', '保留'), row('D-005', 'PR #5', '2026-11-01', '返却済み(2026-11-02)'), row('D-006', 'PR #6', '2026-11-01', '取り下げ'));
  check('閉じた値でない状態の行は、期限を過ぎれば欠落に出す(返却済み・取り下げは出さない)', ids(odd).sort().join() === 'D-001,D-002,D-003', ids(odd).join());
  const c = countRangeExceptions({ startText: null, endText: odd, day: DAY, ledger: 'x' });
  check('閉じた値でない状態の行は未回収に数える(期限内の保留 D-004 も)', c.inRange === 6 && c.uncollected === 4 && c.overdue === 3, JSON.stringify(c));
  const gap = lapsedExceptions(rowsOf(odd), DAY).find((x) => x.id === 'D-002');
  check('欠落の文に、閉じた値でない旨が出る', /閉じた値/.test(lapsedGapText(gap, DAY)), lapsedGapText(gap, DAY));
  const startOdd = countRangeExceptions({ startText: odd, endText: ledger(), day: DAY, ledger: 'x' });
  check('始点で閉じた値でなかった行は、終点の台帳から消えても未回収に数える', startOdd.inRange === 4 && startOdd.uncollected === 4, JSON.stringify(startOdd));
  check('返却の目安に日付が複数あるとき、「まで」の前の日付を期限とする', exceptionStanding(rowsOf(ledger(row('D-001', 'PR #1', '2026-10-01 承認。2026-11-30 まで', '未返却')))[0], DAY) === 'active');
}
// ---- 件数
{
  const start = ledger(row('D-006', 'PR #20', '2026-12-31', '未返却'), row('D-008', 'PR #21', '2026-12-31', '取り下げ'));
  const end = ledger(
    row('D-006', 'PR #20', '2026-12-31', '返却済み(2026-11-18)'),
    row('D-008', 'PR #21', '2026-12-31', '取り下げ'),
    row('D-001', 'PR #12', '2026-11-30', '未返却'),
    row('D-002', 'PR #13', '2026-11-10', '未返却'),
    row('D-003', 'PR #14', '2026-12-31', '失効'),
    row('D-004', 'PR #15', '2026-11-01', '未返却', 'D-005 で承認し直した'),
    row('D-005', 'PR #15', '2026-12-31', '未返却'),
    row('D-007', 'PR #16', '2026-12-31', '未返却'),
    row('D-009', 'G-2 F-001', '2026-11-01', '未返却')
  );
  const c = countRangeExceptions({ startText: start, endText: end, day: DAY, ledger: 'docs/debt-ledger.md', withoutIndependentConfirmation: 2 });
  check('範囲の件数: 始点で有効だった行と範囲で足された行(取り下げ済みの始点の行は数えない)', c.inRange === 8, JSON.stringify(c));
  check('未回収: 終点で有効・失効の行(返却済みと承認し直された元の行を除く)', c.uncollected === 6, JSON.stringify(c));
  check('期限超過: 有効のまま期限を過ぎた行と失効の行', c.overdue === 3, JSON.stringify(c));
  check('独立した人の確認を経ない出荷は、渡された件数のまま', c.withoutIndependentConfirmation === 2 && c.day === DAY && c.ledger === 'docs/debt-ledger.md');
  const zero = countRangeExceptions({ startText: null, endText: null, day: DAY, ledger: 'docs/debt-ledger.md' });
  check('台帳が無い範囲は 0 件(0 件も出す)', zero.inRange === 0 && zero.uncollected === 0 && zero.overdue === 0 && zero.withoutIndependentConfirmation === 0);
  const gone = countRangeExceptions({ startText: start, endText: ledger(), day: DAY, ledger: 'x' });
  check('終点の台帳から消えた始点の有効の行は、未回収に数える', gone.inRange === 1 && gone.uncollected === 1, JSON.stringify(gone));
}
// ---- 次の一手の注記
{
  const text = ledger(row('D-002', 'PR #13', '2026-11-10', '未返却'), row('D-001', 'PR #12', '2026-11-30', '未返却'));
  const note = overdueExceptionNote({ ledgerText: text, today: DAY });
  check('次の一手: 期限を過ぎた未返却の行を注記に出す(1件のみ)', /1 件/.test(note ?? '') && /D-002/.test(note) && !/D-001/.test(note), note);
  check('次の一手: 該当が無ければ注記を出さない', overdueExceptionNote({ ledgerText: ledger(row('D-001', 'PR #12', '2026-11-30', '未返却')), today: DAY }) === null);
  check('次の一手: 同じ台帳でも日付が進めば期限超過になる(日付は引数)', overdueExceptionNote({ ledgerText: ledger(row('D-001', 'PR #12', '2026-11-30', '未返却')), today: '2026-12-01' }) !== null);
}

// ---- 返却目安の延長(IMPL-0787)と区分「類似検知」の期限超過(IMPL-1008)
const simRow = (id, target, due, state) => `| ${id} | 類似検知 | ${target} | 類似の疑い | 当該の変更単位で処理できない | 不具合 | ${due} | ${state} | 名簿 甲 | — |\n`;
{
  const s0 = ledger(row('D-070', 'PR #70', '2026-10-01', '未返却'), row('D-071', 'PR #71', '2026-12-31', '未返却'), row('D-072', 'PR #72', '2026-12-31', '未返却'), row('D-073', 'PR #73', '2026-12-31', '未返却'));
  // IMPL-0787:ng(違反の入力。期限を延ばす・日付を読めない値へ変える書き換えを返す)
  const e1 = ledger(row('D-070', 'PR #70', '2027-03-01', '未返却'), row('D-071', 'PR #71', '2026-12-31', '未返却'), row('D-072', 'PR #72', 'S2 移行時', '未返却'), row('D-073', 'PR #73', '2026-12-31', '未返却'));
  check('IMPL-0787:ng 返却の目安を後の日付へ変えた行と、日付を読めない値へ変えた行を返す', extendedDueRows({ startText: s0, endText: e1 }).extended.map((x) => x.id).join() === 'D-070,D-072', JSON.stringify(extendedDueRows({ startText: s0, endText: e1 })));
  // IMPL-0787:ok(適合の入力。目安は同じで状態だけ返却済み、または目安を早める)
  const e2 = ledger(row('D-070', 'PR #70', '2026-10-01', '未返却'), row('D-071', 'PR #71', '2026-12-01', '未返却'), row('D-072', 'PR #72', '2026-12-31', '返却済み(2026-11-10)'), row('D-073', 'PR #73', '2026-12-31', '未返却'));
  check('IMPL-0787:ok 目安が同じで状態だけ変わった行、目安を早めた行は返さない', extendedDueRows({ startText: s0, endText: e2 }).extended.length === 0);
  const u = extendedDueRows({ startText: null, endText: e1 });
  check('IMPL-0787:ok 始点の台帳が読めないときは比べず、欠落にしない(unverifiable)', u.unverifiable === true && u.extended.length === 0);
  check('IMPL-0787:ok 範囲で足された行(始点に無い行)は返さない', extendedDueRows({ startText: s0, endText: e1 + row('D-099', 'PR #99', '2030-01-01', '未返却') }).extended.every((x) => x.id !== 'D-099'));
  // 区分「類似検知」(IMPL-1008)
  const ext = (target, due, state = '未返却', approver = '名簿 乙') => `| D-082 | 例外 | ${target} | 類似検知の延長 | 処理に日数が要る | 不具合 | ${due} | ${state} | 名簿 甲 | ${approver} |\n`;
  const sim = ledger(simRow('D-080', 'PR #80', '2026-11-01', '未返却'), simRow('D-081', 'PR #81', '2026-11-01', '未返却'), simRow('D-083', 'PR #83', '未定', '未返却'), simRow('D-084', 'PR #84', '2026-12-31', '未返却'), simRow('D-085', 'PR #85', '2026-11-01', '返却済み(2026-11-02)'));
  const okExt = (_s, e) => e.approver === '名簿 乙' && stateOf0(e) === '未返却' && exceptionStanding(e, DAY) === 'active';
  // IMPL-1008:ng(違反の入力。期限超過で未返却・延長の行なし・目安が日付として読めない行を返す)
  check('IMPL-1008:ng 期限超過で未返却の行と、目安が日付として読めない行を返す(延長なし)', lapsedSimilarRows(rowsOf(sim), DAY, okExt).map((x) => x.id).join() === 'D-080,D-081,D-083', lapsedSimilarRows(rowsOf(sim), DAY, okExt).map((x) => x.id).join());
  // IMPL-1008:ok(適合の入力。有効な延長の行がある・期限内・返却済みは返さない)
  const withExt = sim + ext('D-081', '2026-12-31');
  check('IMPL-1008:ok 対象に当該の行の識別を書いた有効な区分「例外」の行がある類似検知は返さない。期限内・返却済みも返さない', lapsedSimilarRows(rowsOf(withExt), DAY, okExt).map((x) => x.id).join() === 'D-080,D-083', lapsedSimilarRows(rowsOf(withExt), DAY, okExt).map((x) => x.id).join());
  const badExt = sim + ext('D-081', '2026-12-31', '未返却', '名簿 甲');
  check('IMPL-1008:ng 延長の行が成立しない(呼び出し側の条件を満たさない)とき、類似検知を返す', lapsedSimilarRows(rowsOf(badExt), DAY, okExt).some((x) => x.id === 'D-081'));
  const cnt = (t) => JSON.stringify(countRangeExceptions({ startText: null, endText: t, day: DAY, ledger: 'x' }));
  check('IMPL-1008:fix 区分「類似検知」の行の有無で、範囲の例外承認の件数は変わらない', cnt(ext('PR #1', '2026-12-31')) === cnt(ext('PR #1', '2026-12-31') + sim.split('\n').filter((l) => /類似検知/.test(l) && /^\| D-0/.test(l)).join('\n') + '\n'));
}
function stateOf0(e) {
  return String(e.state ?? '').replace(/\*/g, '').normalize('NFKC').trim();
}

// ---- 集約の通し(一時の置き場。日付は --exception-day で固定)
const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-exc-expiry-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const co = path.join(dir, '.github/CODEOWNERS');
  fs.writeFileSync(co, fs.readFileSync(co, 'utf8').replace(/@OWNER\b/g, '@tester'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  const node = (script, ...a) => {
    const r = spawnSync(process.execPath, [script, ...a], { cwd: dir, encoding: 'utf8', env });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD').trim();
  };
  return { dir, git, node, commit, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
{
  const COMMON = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free', 'q-biz-phase': 'growth', 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' };
  const PEOPLE = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊己'[i]}`, accounts: [`acc${i}`] }));
  const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p5', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
  const log = console.log;
  console.log = () => {};
  let cfg;
  try {
    cfg = buildConfig(COMMON, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config;
  } finally {
    console.log = log;
  }
  const w = workspace();
  w.commit('chore: template');
  fs.writeFileSync(path.join(w.dir, 'process.config.json'), JSON.stringify(sealChangeLog(JSON.parse(JSON.stringify(cfg))), null, 2) + '\n');
  w.commit('chore: init');
  const start = ledger(row('D-006', 'PR #20', '2026-12-31', '未返却'), row('D-008', 'PR #21', '2026-12-31', '取り下げ'));
  fs.mkdirSync(path.join(w.dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'docs/debt-ledger.md'), start);
  const from = w.commit('docs: 台帳(範囲の始点)');
  fs.writeFileSync(
    path.join(w.dir, 'docs/debt-ledger.md'),
    ledger(
      row('D-006', 'PR #20', '2026-12-31', '返却済み(2026-11-18)'),
      row('D-008', 'PR #21', '2026-12-31', '取り下げ'),
      row('D-001', 'PR #12', '2026-11-30', '未返却'),
      row('D-002', 'PR #13', '2026-11-10', '未返却'),
      row('D-003', 'PR #14', '2026-12-31', '失効'),
      row('D-004', 'PR #15', '2026-11-01', '未返却', 'D-005 で承認し直した'),
      row('D-005', 'PR #15', '2026-12-31', '未返却'),
      row('D-007', 'PR #16', '2026-12-31', '未返却'),
      row('D-009', 'G-2 F-001', '2026-11-01', '未返却')
    )
  );
  const to = w.commit('docs: 台帳(範囲の終点)');
  const run = (day) => {
    const r = w.node('scripts/gate/aggregate-evidence.mjs', '--from', from, '--to', to, ...(day ? ['--exception-day', day] : []));
    let ev = null;
    try {
      ev = JSON.parse(fs.readFileSync(path.join(w.dir, 'evidence/evidence.json'), 'utf8'));
    } catch {
      // 読めなければ null
    }
    return { r, ev };
  };
  const gapIdsOf = (ev) => (ev?.gaps ?? []).filter((g) => /^例外承認 D-\d+/.test(g)).map((g) => g.match(/^例外承認 (D-\d+)/)[1]).sort();
  const { r, ev } = run(DAY);
  check('通し: 集約が動き、evidence.json を出す', ev !== null, r.out);
  check('通し: 期限超過(D-002)・失効(D-003)・ゲートの判定の行(D-009)が欠落に出る。承認し直した D-004 と期限内の行は出ない', gapIdsOf(ev).join() === 'D-002,D-003,D-009', gapIdsOf(ev).join());
  const x = ev?.claim?.exceptions;
  check('通し: claim.exceptions の件数(範囲 8・未回収 6・期限超過 3・独立した人の確認を経ない出荷 0)', x && x.inRange === 8 && x.uncollected === 6 && x.overdue === 3 && x.withoutIndependentConfirmation === 0 && x.day === DAY, JSON.stringify(x));
  check('通し: 欠落があるため、主張を述べられない理由に出る', (ev?.claim?.blockers ?? []).some((b) => /欠落/.test(b)));
  const reportFile = ['evidence/report.md', 'evidence/quality-report.md'].map((f) => path.join(w.dir, f)).find((f) => fs.existsSync(f));
  const report = reportFile ? fs.readFileSync(reportFile, 'utf8') : '';
  check('通し: 品質レポートに件数の句が出る(0 件も出す形)', /範囲の第7章の例外承認の件数.*8 件\(未回収 6 件、うち回収の期限を過ぎた 3 件。独立した人の確認を経ない出荷 0 件\)/.test(report), `${reportFile}\n${report.slice(0, 200)}`);
  const early = run('2026-10-01');
  check('通し: 突合の日が期限より前なら、有効の行は欠落に出ない(失効の行だけ)', gapIdsOf(early.ev).join() === 'D-003', gapIdsOf(early.ev).join());
  check('通し: 突合の日は引数で渡せる(件数の日が変わる)', early.ev?.claim?.exceptions?.day === '2026-10-01' && early.ev.claim.exceptions.overdue === 1, JSON.stringify(early.ev?.claim?.exceptions));
  const bad = run('2026-13-45');
  check('通し: 日付として読めない引数は、使わず欠落に出す', (bad.ev?.gaps ?? []).some((g) => /--exception-day/.test(g)));
  check('通し: 突合の日の出どころを件数に残す(引数で渡した判定の日)', /--exception-day/.test(ev?.claim?.exceptions?.daySource ?? '') && /突合の日の出どころ: 引数/.test(report), ev?.claim?.exceptions?.daySource);
  check('通し: 品質レポートに、対応づく経路の件数を試験で確かめていない旨を開示する', /対応づく経路の件数を試験で確かめていない/.test(report));
  const dflt = run(null);
  check('通し: 引数が無ければ範囲の終点のコミットの日で比べ、出どころにそう出る', /終点のコミットの日/.test(dflt.ev?.claim?.exceptions?.daySource ?? '') && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dflt.ev?.claim?.exceptions?.day ?? ''), JSON.stringify(dflt.ev?.claim?.exceptions));
  // 突合の1巡目 M-2: --to を HEAD より前にしたとき、欠落も件数も範囲の終点のコミットの台帳で読む
  fs.writeFileSync(
    path.join(w.dir, 'docs/debt-ledger.md'),
    ledger(row('D-002', 'PR #13', '2026-11-10', '返却済み(2026-11-19)'), row('D-011', 'PR #17', '2026-11-01', '未返却'), row('D-012', 'PR #18', '2026-11-01', '誤記'))
  );
  w.commit('docs: 台帳(終点より後。作業ツリーと HEAD だけが変わる)');
  const past = run(DAY);
  check('通し(--to を HEAD より前): 欠落は終点のコミットの台帳で読む(後の D-011・D-012 は出ず、D-002 は出る)', gapIdsOf(past.ev).join() === 'D-002,D-003,D-009', gapIdsOf(past.ev).join());
  const px = past.ev?.claim?.exceptions;
  check('通し(--to を HEAD より前): 件数も同じ台帳で、欠落と食い違わない', px && px.inRange === 8 && px.uncollected === 6 && px.overdue === 3, JSON.stringify(px));
  // 突合の1巡目 H-1: 相互の名指し・付け足しの名指しを、集約の通しでも固定する
  fs.writeFileSync(
    path.join(w.dir, 'docs/debt-ledger.md'),
    ledger(
      row('D-021', 'PR #30', '2026-11-01', '未返却', 'D-022 で承認し直した'),
      row('D-022', 'PR #30', '2026-12-31', '未返却', 'D-021 の承認し直し'),
      row('D-023', 'G-2 F-001', '2026-11-01', '未返却', 'D-024 と同じ事情'),
      row('D-024', 'PR #31', '2026-12-31', '未返却')
    )
  );
  const to3 = w.commit('docs: 台帳(承認し直しの場面)');
  const r3 = w.node('scripts/gate/aggregate-evidence.mjs', '--from', from, '--to', to3, '--exception-day', DAY);
  const ev3 = JSON.parse(fs.readFileSync(path.join(w.dir, 'evidence/evidence.json'), 'utf8'));
  check('通し(承認し直し): 相互の名指しで両方を外さず、付け足しの名指しで期限超過の行を外さない', gapIdsOf(ev3).join() === 'D-023' && ev3.claim.exceptions.uncollected === 4, `${r3.out.slice(-200)}
${gapIdsOf(ev3).join()}
${JSON.stringify(ev3.claim.exceptions)}`);
  // 返却目安の延長・類似検知の期限超過を、集約の通しで固定する(IMPL-0787・IMPL-1008)
  {
    const s0 = ledger(row('D-070', 'PR #70', '2026-10-01', '未返却'), row('D-071', 'PR #71', '2026-12-31', '未返却'), row('D-072', 'PR #72', '2026-12-31', '未返却'), row('D-073', 'PR #73', '2026-12-31', '未返却'));
    fs.writeFileSync(path.join(w.dir, 'docs/debt-ledger.md'), s0);
    const from4 = w.commit('docs: 台帳(延長の場面の始点)');
    const e1 =
      ledger(row('D-070', 'PR #70', '2027-03-01', '未返却'), row('D-071', 'PR #71', '2026-12-01', '未返却'), row('D-072', 'PR #72', 'S2 移行時', '未返却'), row('D-073', 'PR #73', '2026-12-31', '返却済み(2026-11-10)')) +
      simRow('D-080', 'PR #80', '2026-11-01', '未返却') +
      simRow('D-081', 'PR #81', '2026-11-01', '未返却') +
      row('D-082', 'D-081', '2026-12-31', '未返却') +
      simRow('D-083', 'PR #83', '未定', '未返却') +
      simRow('D-084', 'PR #84', '2026-12-31', '未返却');
    fs.writeFileSync(path.join(w.dir, 'docs/debt-ledger.md'), e1);
    const to4 = w.commit('docs: 台帳(延長の場面の終点)');
    const r4 = w.node('scripts/gate/aggregate-evidence.mjs', '--from', from4, '--to', to4, '--exception-day', DAY);
    const ev4 = JSON.parse(fs.readFileSync(path.join(w.dir, 'evidence/evidence.json'), 'utf8'));
    const g4 = (re) => (ev4.gaps ?? []).filter((g) => re.test(g)).map((g) => g.match(/(D-\d+)/)[1]).sort().join();
    check('通し IMPL-0787:ng 目安を延ばした行(D-070)と日付を読めない値へ変えた行(D-072)が欠落に出る。早めた行(D-071)・返却済みにした行(D-073)は出ない', g4(/^返却目安の書き換え/) === 'D-070,D-072', `${r4.out.slice(-200)}\n${g4(/^返却目安の書き換え/)}`);
    check('通し IMPL-1008:ng 期限超過の類似検知(D-080)・目安が読めない行(D-083)が欠落に出る。有効な延長のある D-081、期限内の D-084 は出ない', g4(/^類似検知 D-/) === 'D-080,D-083', g4(/^類似検知 D-/));
    check('通し IMPL-1008:fix 区分「類似検知」の行は、例外承認の件数(範囲の件数)に数えない', ev4.claim.exceptions.inRange <= 6, JSON.stringify(ev4.claim.exceptions));
  }
  w.done();
  // 変更の例外承認の対応づけ(PR を経ないコミット。作成を指示した者は Author)。期限内なら対応づき、期限を過ぎれば対応づかない
  const w2 = workspace();
  w2.commit('chore: template');
  fs.writeFileSync(path.join(w2.dir, 'process.config.json'), JSON.stringify(sealChangeLog(JSON.parse(JSON.stringify(cfg))), null, 2) + '\n');
  const from2 = w2.commit('chore: init');
  w2.git('config', 'user.name', '名簿 甲');
  w2.git('config', 'user.email', 'acc0@example.com');
  fs.writeFileSync(path.join(w2.dir, 'a.txt'), 'x\n');
  const changed = w2.commit('feat: 変更\n\nRisk: R2\nVerification: 手元で確認した');
  const short = changed.slice(0, 8);
  const ex = (due) => ledger(`| D-001 | 例外 | ${short} | G-6 基準4 を満たさない | 復旧を急ぐ | 不具合 | ${due} まで。回収責任者 名簿 丙 | 未返却 | 名簿 甲 | 名簿 丁 |\n`);
  const runAt = (due, day) => {
    fs.mkdirSync(path.join(w2.dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(w2.dir, 'docs/debt-ledger.md'), ex(due));
    const to2 = w2.commit(`docs: 台帳 ${due}`);
    w2.node('scripts/gate/aggregate-evidence.mjs', '--from', from2, '--to', to2, '--exception-day', day);
    return JSON.parse(fs.readFileSync(path.join(w2.dir, 'evidence/evidence.json'), 'utf8'));
  };
  const ok = runAt('2026-11-30', DAY);
  const gapFor = (e) => (e.gaps ?? []).find((g) => g.includes(short));
  // 帰属の確認(台帳の行を入れた変更の作成者・承認者)はホスティングの記録を要し、この通しでは読めない。対応づく場合の出荷の件数は、偽の gh を置ける CI の Linux でなければ確かめない
  check('通し(変更): 期限内の例外承認は、期限の理由で対応づけない行にならない(帰属の理由で落ちる。期限は理由に出ない)', !/効力を失って/.test(gapFor(ok) ?? '') && /帰属を確かめられない/.test(gapFor(ok) ?? '') && ok.claim.exceptions.overdue === 0, gapFor(ok));
  const late = runAt('2026-11-19', DAY);
  check('通し(変更): 期限を過ぎた例外承認は変更へ対応づかず、期限超過の理由が出る', /効力を失って/.test(gapFor(late) ?? '') && late.claim.exceptions.withoutIndependentConfirmation === 0 && late.claim.exceptions.overdue === 1, `${gapFor(late)}
${JSON.stringify(late.claim.exceptions)}`);
  w2.done();
}

// ---- ゲートの判定を対象とする例外承認の照合(G-4・G-5。IMPL-0996 / ADR-0153 決定2)。G-4 は当該の機能仕様の判定記録が無ければ、G-5 は常に、成立させない
// 関数の試験(時計・ホスティングに依らない)
{
  const rowsOf2 = (...targets) => targets.map((t, i) => ({ label: `D-00${i + 1}(${t})`, t: gateExceptionTarget(t) }));
  const judgedOnly = (...specs) => (s) => specs.includes(s);
  // IMPL-0996:ng(違反の入力。G-4 の判定記録が無い G-4 の行)
  const ng1 = unjudgedGateExceptions(rowsOf2('G-4 F-001'), judgedOnly());
  check('IMPL-0996:ng G-4 の判定記録が無い G-4 の行は、成立させず、欠落の文を返す', ng1.length === 1 && /G-4 の判定記録.*無い/.test(ng1[0].text), JSON.stringify(ng1));
  // IMPL-0996:ng(別の行・別の場面。G-5 の行)
  const ng2 = unjudgedGateExceptions(rowsOf2('G-5 P-001'), judgedOnly('F-001', 'P-001'));
  check('IMPL-0996:ng G-5 の行は、判定の記録の有無に依らず常に成立させない', ng2.length === 1 && /gate-g5/.test(ng2[0].text), JSON.stringify(ng2));
  const ng3 = unjudgedGateExceptions(rowsOf2('G-4 F-001'), judgedOnly('F-002'));
  check('IMPL-0996:ng 他の機能(F-002)の G-4 の記録だけでは、G-4 F-001 の行は成立しない(ADR-0153 決定2)', ng3.length === 1, JSON.stringify(ng3));
  // IMPL-0996:ok(適合の入力。当該の G-4 の判定記録がある行)
  const ok1 = unjudgedGateExceptions(rowsOf2('G-4 F-001'), judgedOnly('F-001'));
  check('IMPL-0996:ok 当該の G-4 の判定記録がある G-4 の行は、成立させる(欠落の文を返さない)', ok1.length === 0, JSON.stringify(ok1));
  // 回帰(目印なし): 他のゲートの行は変えない
  const reg = unjudgedGateExceptions(rowsOf2('G-2 F-001', 'G-1 P-001', 'G-7 v1.0.0', 'SG P-001', 'G-3 ADR-0001'), judgedOnly());
  check('回帰: G-4・G-5 以外のゲートの行は、判定の記録の有無に依らず従来どおり(返さない)', reg.length === 0, JSON.stringify(reg));
}
// 集約の通し(模擬の gh を PATH の先頭に置く。Windows では置き方が異なるため省く。CI は Linux で走る)。台帳の行の帰属を裏づけて、ゲートの判定の行を成立させたうえで確かめる
if (process.platform === 'win32') {
  console.log('---- 集約の通し(ゲートの判定の行。模擬の gh): Windows では省きます(CI で確かめる)');
} else {
  const R = 'example/exc';
  const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-fake-gh-exc-'));
  fs.writeFileSync(
    path.join(BIN, 'gh'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "const map = JSON.parse(fs.readFileSync(process.env.FAKE_GH_MAP, 'utf8'));",
      "const target = args.find((a) => a.startsWith('repos/')) ?? '';",
      "if (args[0] === 'pr' && args[1] === 'view' && Object.prototype.hasOwnProperty.call(map, 'pr:' + args[2])) { process.stdout.write(JSON.stringify(map['pr:' + args[2]])); process.exit(0); }",
      "if (args[0] === 'api' && Object.prototype.hasOwnProperty.call(map, target)) { process.stdout.write(JSON.stringify(map[target])); process.exit(0); }",
      "if (args[0] === 'api' && /\\/(pulls|reviews|commits)$/.test(target)) { process.stdout.write('[]'); process.exit(0); }",
      'process.exit(1);',
      '',
    ].join('\n')
  );
  fs.chmodSync(path.join(BIN, 'gh'), 0o755);
  const COMMON = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free', 'q-biz-phase': 'growth', 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' };
  const PEOPLE = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊己'[i]}`, accounts: [{ login: `acc${i}`, id: 3000 + i }] }));
  const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p5', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
  const log = console.log;
  console.log = () => {};
  let cfg;
  try {
    cfg = buildConfig(COMMON, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config;
  } finally {
    console.log = log;
  }
  const w = workspace();
  w.commit('chore: template');
  fs.writeFileSync(path.join(w.dir, 'process.config.json'), JSON.stringify(sealChangeLog(JSON.parse(JSON.stringify(cfg))), null, 2) + '\n');
  const from = w.commit('chore: init');
  const form = (gate, target, result) =>
    `# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | ${gate} |\n| 対象 | ${target} |\n| 判定者 | 名簿 甲 |\n| 判定日時 | 2026-11-10 10:00 |\n| 結果 | ${result} |\n| 確定の形態 | 人確定 |\n`;
  const user = (login) => ({ login, id: PEOPLE.flatMap((p) => p.accounts).find((a) => a.login === login)?.id ?? null });
  const map = {};
  let prNo = 100;
  const scene = (targets, forms) => {
    prNo += 1;
    fs.rmSync(path.join(w.dir, 'docs/gates'), { recursive: true, force: true });
    fs.mkdirSync(path.join(w.dir, 'docs/gates'), { recursive: true });
    for (const [f, t] of Object.entries(forms)) fs.writeFileSync(path.join(w.dir, 'docs/gates', f), t);
    fs.mkdirSync(path.join(w.dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(w.dir, 'docs/debt-ledger.md'), ledger(...targets.map((t, i) => row(`D-${prNo}${i}`, t, '2026-12-31', '未返却', '基準を満たさない'))));
    const to = w.commit(`docs: 場面 ${prNo}\n\nRisk: R3\nVerification: 手元で試験を実行した`);
    // 台帳の行を入れた PR: 作成者は記録者(名簿 甲)、承認した者本人(名簿 乙 acc1)が承認する
    map[`repos/${R}/commits/${to}/pulls`] = [{ number: prNo, merged_at: '2026-11-01T00:00:00Z', merge_commit_sha: to, head: { sha: `head-${prNo}` }, user: user('acc0') }];
    map[`repos/${R}/pulls/${prNo}/reviews`] = ['acc1', 'acc3'].map((l, i) => ({ id: 800 + i, user: { ...user(l), type: 'User' }, state: 'APPROVED', commit_id: `head-${prNo}`, body: '' }));
    map[`repos/${R}/pulls/${prNo}/commits`] = [{ author: user('acc0') }];
    const mapFile = path.join(BIN, `map-${prNo}.json`);
    fs.writeFileSync(mapFile, JSON.stringify(map));
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs', '--from', from, '--to', to, '--exception-day', DAY], { cwd: w.dir, encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_MAP: mapFile, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: R, GH_TOKEN: '', GITHUB_TOKEN: '' } });
    let ev = null;
    try {
      ev = JSON.parse(fs.readFileSync(path.join(w.dir, 'evidence/evidence.json'), 'utf8'));
    } catch {
      // 読めなければ null
    }
    return { r: { out: `${r.stdout ?? ''}${r.stderr ?? ''}` }, ev, id: (i) => `D-${prNo}${i}` };
  };
  const gapOf = (ev, re) => (ev?.gaps ?? []).filter((g) => re.test(g));
  const shows = (ev, label) => JSON.stringify({ ...ev, gaps: undefined }).includes(label);
  // 前提: 帰属を裏づけた G-2 の行は成立する(以下の場面の対照)
  const base = scene(['G-2 F-001'], {});
  check('集約(模擬の gh)の前提: 帰属を裏づけた G-2 F-001 の行は成立する', base.ev !== null && shows(base.ev, `${base.id(0)}(G-2 F-001)`) && gapOf(base.ev, /ゲートの判定を対象とする例外承認/).length === 0, base.r.out.slice(-800) + JSON.stringify(base.ev?.gaps?.filter((g) => /例外承認/.test(g))));
  const a = scene(['G-4 F-001'], {});
  check('集約 IMPL-0996:ng G-4 の判定記録が無い G-4 の行は、欠落に出て、例外承認として数えない', gapOf(a.ev, new RegExp(`${a.id(0)}\\(G-4 F-001\\).*G-4 の判定記録.*無い`)).length === 1 && !shows(a.ev, `${a.id(0)}(G-4 F-001)`), JSON.stringify(a.ev?.gaps?.filter((g) => /例外承認/.test(g))));
  const b = scene(['G-5 P-001'], { 'g5.md': form('G-5 品質ゲート', 'P-001', '通過') });
  check('集約 IMPL-0996:ng G-5 の行は、記録があっても常に成立させない', gapOf(b.ev, new RegExp(`${b.id(0)}\\(G-5 P-001\\).*gate-g5`)).length === 1 && !shows(b.ev, `${b.id(0)}(G-5 P-001)`), JSON.stringify(b.ev?.gaps?.filter((g) => /例外承認/.test(g))));
  const c = scene(['G-4 F-001'], { 'g4-f002.md': form('G-4 機能仕様承認', 'F-002 / 1a2b3c4', '通過') });
  check('集約 IMPL-0996:ng 他の機能(F-002)の記録だけでは、G-4 F-001 の行は成立しない', gapOf(c.ev, new RegExp(`${c.id(0)}\\(G-4 F-001\\).*G-4 の判定記録.*無い`)).length === 1 && !shows(c.ev, `${c.id(0)}(G-4 F-001)`), JSON.stringify(c.ev?.gaps?.filter((g) => /例外承認/.test(g))));
  const d = scene(['G-4 F-001'], { 'g4-f001.md': form('G-4 機能仕様承認', 'F-001 / 1a2b3c4', '差し戻し') });
  check('集約 IMPL-0996:ok G-4 F-001 の判定記録(差し戻し)がある行は、欠落に出ず、例外承認として数える', gapOf(d.ev, new RegExp(`${d.id(0)}\\(G-4 F-001\\)`)).length === 0 && shows(d.ev, `${d.id(0)}(G-4 F-001)`), JSON.stringify(d.ev?.gaps?.filter((g) => /例外承認/.test(g))));
  // U6c: 段 mutation が閾値割れを受ける行(G-5 PR-<番号>・印あり)を、集約が帰属まで見て欠落にしない。
  // 行の承認した者は名簿 己(acc5)。行を入れた PR(別の番号)の作成者でも承認者でもないので、(B) では裏づかず、対象の PR の上の宣言行のレビュー (A) だけが帰属になる
  const breach = (target, { declare = true, mark = true, pr = 301, inRange = true, approver = '名簿 己' } = {}) => {
    fs.rmSync(path.join(w.dir, 'docs/gates'), { recursive: true, force: true });
    fs.writeFileSync(path.join(w.dir, 'u6c.txt'), `${pr}\n`);
    const target1 = w.commit(`feat: 変更 ${pr}\n\nRisk: R3\nVerification: 手元で試験を実行した`);
    const id = `D-${pr}`;
    fs.mkdirSync(path.join(w.dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(w.dir, 'docs/debt-ledger.md'), ledger(`| ${id} | 例外 | ${target} | ${mark ? '変異試験の閾値割れ(スコア 40・閾値 60)' : 'スコア低下'} | 閾値を暫定で受ける | 品質の低下 | 2026-12-31 まで | 未返却 | 名簿 甲 | ${approver} |\n`));
    // 対象の PR の写し(承認レビューの写し。本文の編集者 edited_by を持つ)。帰属 (A) は写しのレビューで数える
    if (inRange) {
      fs.mkdirSync(path.join(w.dir, 'docs/records/reviews'), { recursive: true });
      fs.writeFileSync(path.join(w.dir, `docs/records/reviews/pr-${pr}.json`), JSON.stringify({ repository: R, pr, title: `変更 ${pr}`, body: 'Risk: R3', head_ref: 'feat', merge_commit_sha: target1, head_sha: `head-${pr}`, author: user('acc0'), merged_at: '2026-11-01T00:00:00Z', merged_by: { login: 'acc3' }, base: { ref: 'main' }, default_branch: 'main', reviews: [{ id: 900, user: { ...user('acc5'), type: 'User' }, state: 'COMMENTED', commit_id: `head-${pr}`, body: declare ? `例外承認: D-${pr}` : '確認した', edited_by: null, submitted_at: '2026-10-31T00:00:00Z' }] }));
    }
    const to = w.commit(`docs: 台帳 ${pr}\n\nRisk: R3\nVerification: 手元で試験を実行した`);
    map[`repos/${R}/commits/${target1}/pulls`] = [{ number: pr, merged_at: '2026-11-01T00:00:00Z', merge_commit_sha: target1, head: { sha: `head-${pr}` }, user: user('acc0') }];
    map[`repos/${R}/pulls/${pr}/reviews`] = [{ id: 900, user: { ...user('acc5'), type: 'User' }, state: 'COMMENTED', commit_id: `head-${pr}`, submitted_at: '2026-10-31T00:00:00Z', body: declare ? `例外承認: ${id}` : '確認した' }];
    map[`repos/${R}/pulls/${pr}/commits`] = [{ author: user('acc0') }];
    map[`repos/${R}/pulls/${pr}`] = { number: pr, merged_at: '2026-11-01T00:00:00Z', user: user('acc0') };
    if (inRange) map[`pr:${pr}`] = { number: pr, title: `変更 ${pr}`, author: { login: 'acc0' }, reviews: [], statusCheckRollup: [], body: 'Risk: R3', mergeCommit: { oid: target1 }, commits: [{ oid: target1, authors: [{ login: 'acc0' }] }], labels: [], createdAt: '2026-10-30T00:00:00Z', mergedAt: '2026-11-01T00:00:00Z', headRefOid: `head-${pr}`, headRefName: 'feat' };
    map[`repos/${R}/commits/${to}/pulls`] = [{ number: pr + 1, merged_at: '2026-11-02T00:00:00Z', merge_commit_sha: to, head: { sha: `head-${pr + 1}` }, user: user('acc0') }];
    map[`repos/${R}/pulls/${pr + 1}/reviews`] = ['acc1', 'acc3'].map((l, i) => ({ id: 910 + i, user: { ...user(l), type: 'User' }, state: 'APPROVED', commit_id: `head-${pr + 1}`, body: '' }));
    map[`repos/${R}/pulls/${pr + 1}/commits`] = [{ author: user('acc0') }];
    const mapFile = path.join(BIN, `map-breach-${pr}.json`);
    fs.writeFileSync(mapFile, JSON.stringify(map));
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs', '--from', from, '--to', to, '--exception-day', DAY], { cwd: w.dir, encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_MAP: mapFile, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: R, GH_TOKEN: '', GITHUB_TOKEN: '' } });
    let ev = null;
    try {
      ev = JSON.parse(fs.readFileSync(path.join(w.dir, 'evidence/evidence.json'), 'utf8'));
    } catch {
      // 読めなければ null
    }
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ev, id };
  };
  const exGaps = (x) => JSON.stringify((x.ev?.gaps ?? []).filter((g) => new RegExp(x.id).test(g)));
  const u1 = breach('G-5 PR-301', { pr: 301 });
  check('集約 IMPL-0931:ok G-5 PR-301 で印あり・PR-301 に承認した者本人の宣言行のレビューがある行は、欠落にならず例外承認として数える', u1.ev !== null && exGaps(u1) === '[]' && shows(u1.ev, `${u1.id}(G-5 PR-301)`), u1.out.slice(-600) + exGaps(u1));
  const hasGap = (x, label, re) => (x.ev?.gaps ?? []).some((g) => g.includes(`${x.id}(${label})`) && re.test(g));
  const u2 = breach('G-5 PR-311', { pr: 311, mark: false, approver: '名簿 乙' });
  check('集約 IMPL-0931:ng 印の無い G-5 PR-311 の行は欠落のまま', hasGap(u2, 'G-5 PR-311', /gate-g5/) && !shows(u2.ev, `${u2.id}(G-5 PR-311)`), exGaps(u2));
  const u3 = breach('G-5 PR-321', { pr: 321, declare: false });
  check('集約 IMPL-0931:ng 対象の PR に宣言行のレビューが無い行は、帰属を確かめられない欠落になる', hasGap(u3, 'G-5 PR-321', /帰属を確かめられない/), exGaps(u3));
  const u4 = breach('G-5 PR-399', { pr: 331, inRange: false });
  check('集約 IMPL-0931:ng 対象の PR の写しが範囲に無い行は、帰属を確かめられない欠落になり、理由に写しが無いことを出す', hasGap(u4, 'G-5 PR-399', /写しが出荷の範囲に無い/), exGaps(u4));
  const u5 = breach('G-5 P-001', { pr: 341, approver: '名簿 乙' });
  check('集約 IMPL-0996:ng 印があっても G-5 P-001 の行は欠落のまま', hasGap(u5, 'G-5 P-001', /gate-g5/) && !shows(u5.ev, `${u5.id}(G-5 P-001)`), exGaps(u5));
  w.done();
}

// ---- F-09 延長の成立に、検知した変更の作成を指示した者との照合を足す(IMPL-0786 と同じ条件)
{
  const sim9 = ledger(simRow('D-095', 'PR #95', '2026-11-01', '未返却'));
  const ex9 = (approver) => `| D-096 | 例外 | D-095 | 類似検知の延長 | 処理に日数が要る | 不具合 | 2026-12-31 | 未返却 | 名簿 甲 | ${approver} |\n`;
  const mkValid = (instructorIds) => (_s, e) => extensionVerdict({ approverId: e.approver === '名簿 乙' ? 'p-otsu' : 'p-kou', instructorIds }) !== 'self';
  const all = sim9 + ex9('名簿 乙');
  check('IMPL-1008:ng 指示者本人(乙)が承認した延長は成立せず、類似検知を欠落に返す', lapsedSimilarRows(rowsOf(all), DAY, mkValid(['p-otsu'])).map((x) => x.id).join() === 'D-095', lapsedSimilarRows(rowsOf(all), DAY, mkValid(['p-otsu'])).map((x) => x.id).join());
  check('IMPL-1008:ok 指示者でない別の人(乙)が承認した延長は成立する', lapsedSimilarRows(rowsOf(all), DAY, mkValid(['p-kou'])).length === 0);
  check('IMPL-1008:ok 対象を指示者へ解決できない延長は unverified(成立に数え、件数を表示する)', extensionVerdict({ approverId: 'p-otsu', instructorIds: null }) === 'unverified' && lapsedSimilarRows(rowsOf(all), DAY, mkValid(null)).length === 0);
}

// ---- 段 1 の直し(束 B20 突合 1巡目 F-05・F-10・F-11・F-12)
{
  // IMPL-1008:ng 状態を「失効」と書いても期限超過の類似検知を止める(F-05)
  const simL = ledger(simRow('D-090', 'PR #90', '2026-11-01', '失効'), simRow('D-091', 'PR #91', '2026-11-01', '返却済み(2026-11-02)'));
  check('IMPL-1008:ng 状態「失効」の期限超過の類似検知は 1 件返す', lapsedSimilarRows(rowsOf(simL), DAY).map((x) => x.id).join() === 'D-090', lapsedSimilarRows(rowsOf(simL), DAY).map((x) => x.id).join());
  check('IMPL-1008:ok 状態「返却済み」の類似検知は 0 件', lapsedSimilarRows(rowsOf(ledger(simRow('D-091', 'PR #91', '2026-11-01', '返却済み(2026-11-02)'))), DAY).length === 0);
  // IMPL-0787:ng 区分を変えて期限を延ばしても検出する(F-11)
  const k0 = ledger(row('D-092', 'PR #92', '2026-12-01', '未返却'));
  const k1 = ledger(simRow('D-092', 'PR #92', '2027-03-01', '未返却').replace('| 類似検知 |', '| 前提の受容 |'));
  check('IMPL-0787:ng 区分を例外から別の区分へ変えて期限を延ばした行を返す', extendedDueRows({ startText: k0, endText: k1 }).extended.map((x) => x.id).join() === 'D-092', JSON.stringify(extendedDueRows({ startText: k0, endText: k1 })));
  const k2 = ledger(simRow('D-092', 'PR #92', '2026-12-01', '未返却').replace('| 類似検知 |', '| 前提の受容 |'));
  check('IMPL-0787:ok 区分を変えても期限が同じなら返さない', extendedDueRows({ startText: k0, endText: k2 }).extended.length === 0);
  // IMPL-0612:ng 下線の強調の印を読む(F-12)
  check('IMPL-0612:ng 下線で囲んだ印 __ファストトラック(短縮: G-5)__ を印として読む', fastTrackMarkOf('__ファストトラック(短縮: G-5)__ 内容')?.scope === 'G-5', JSON.stringify(fastTrackMarkOf('__ファストトラック(短縮: G-5)__ 内容')));
  // IMPL-0612:ng 発生率の分子は範囲の変更へ対応づく印の行に限る(F-10)
  const exr = (id, target) => ({ id, kind: '例外', target, content: 'ファストトラック(短縮: G-6) 急ぎ', state: '未返却', due: '2026-12-31', approver: '名簿 乙' });
  const five = [exr('D-1', 'PR #1'), exr('D-2', 'PR #2'), exr('D-3', 'PR #3'), exr('D-4', 'PR #4'), exr('D-5', 'PR #5')];
  const mm = fastTrackMetrics({ rows: five, changeTotal: 2, inRange: (r) => r.target === 'PR #1' });
  const tx = fastTrackMetricsText(mm);
  check('IMPL-0612:ng 印 5 件・範囲に対応 1 件・変更 2 件で発生率 50%(250% にしない)', mm.markedInRange === 1 && /発生率 50%/.test(tx) && !/250%/.test(tx), tx);
  check('IMPL-0612:ok 全体 5 件の表示と、範囲へ対応づかない行 4 件の併記が残る', /印のある行 5 件/.test(tx) && /範囲へ対応づかない行 4 件/.test(tx), tx);
}

// ---- 7.9.5 の枠の拒否と補充の検査(IMPL-0630。束 B28 U5)
{
  const ex = (id, target) => ({ id, kind: '例外', target, content: '印なしの例外', state: '未返却', due: '2026-12-31 まで。回収責任者 名簿 丙', approver: '名簿 乙' });
  const brief = (n) => `| 項目 | 内容 |\n| --- | --- |\n| 例外の枠(事業ステージあたり) | ${n} |\n`;
  const hit = (label, by = []) => ({ label, independent: { restrictionTouched: true, by } });
  const noHit = (label) => ({ label, independent: { restrictionTouched: false, by: [] } });
  const past = { '#5': hit('#5'), '#6': noHit('#6'), '#7': hit('#7', ['a', 'b']) };
  const find = (o) => stageQuotaFindings({ prNumber: 20, thisUnit: hit('#20'), pastUnitOf: (l) => past[l] ?? null, briefText: brief(1), ...o });
  // ng: 枠 1・行使 1 の段で、7.9.4 に当たる新しい行(印の無い行。ADR-0217 決定2)は拒む
  const ng = find({ rows: [ex('D-5', 'PR #5'), ex('D-20', 'PR #20')] });
  check('IMPL-0630:ng 枠 1・行使 1 の段で 7.9.4 に当たる新しい行(印なし)は拒む', ng.errors.length === 1 && /枠を使い切って/.test(ng.errors[0]) && ng.used === 1, JSON.stringify(ng));
  // ok: 枠 2・行使 1 は通り、残りを注意に出す
  const ok2 = find({ rows: [ex('D-5', 'PR #5'), ex('D-20', 'PR #20')], briefText: brief(2) });
  check('IMPL-0630:ok 枠 2・行使 1 は通り、残り 1 を注意に出す', ok2.errors.length === 0 && /残り 1/.test(ok2.notices.join()), JSON.stringify(ok2));
  // ok: 制限の範囲に触れない行・2 名の承認がある行は 7.9.4 でなく、行使に数えない
  const notCounted = find({ rows: [ex('D-6', 'PR #6'), ex('D-7', 'PR #7'), ex('D-20', 'PR #20')] });
  check('IMPL-0630:ok 範囲に触れない行・2 名承認の行は行使に数えず、枠 1 でも通る', notCounted.errors.length === 0 && notCounted.used === 0, JSON.stringify(notCounted));
  // ok: この PR の行が 7.9.4 に当たらなければ(範囲に触れない)、枠を使い切っていても拒まない
  const notThis = find({ rows: [ex('D-5', 'PR #5'), ex('D-20', 'PR #20')], thisUnit: noHit('#20') });
  check('IMPL-0630:ok この PR の行が 7.9.4 に当たらなければ、枠を使い切っていても拒まない', notThis.errors.length === 0 && notThis.thisHit === false, JSON.stringify(notThis));
  // ok: 直前のステージ移行ゲートの通過の時点の台帳にある行は、ステージの累計に数えない
  const carried = find({ rows: [ex('D-5', 'PR #5'), ex('D-20', 'PR #20')], startIds: new Set(['D-5']) });
  check('IMPL-0630:ok ステージ移行ゲートの通過の時点の台帳にある行は行使に数えない(枠 1 でも通る)', carried.errors.length === 0 && carried.used === 0, JSON.stringify(carried));
  // ok: 過去の行の PR を読めない → 注意で通る(確定できた行使は下限)。枠・累計が読めない場合も同様
  const unres = find({ rows: [ex('D-9', 'PR #9'), ex('D-20', 'PR #20')] });
  check('IMPL-0630:ok 過去の行の PR を読めないときは、枠の行使を確定できないと注意に出して通る', unres.errors.length === 0 && /D-9.*確定できない/.test(unres.notices.join()), JSON.stringify(unres));
  const noQuota = find({ rows: [ex('D-5', 'PR #5'), ex('D-20', 'PR #20')], briefText: '| 例外の枠(事業ステージあたり) | <件数> |' });
  const noRead = find({ rows: [ex('D-5', 'PR #5'), ex('D-20', 'PR #20')], usedReadable: false });
  check('IMPL-0630:ok 枠が件数として読めない・累計を読めないときは、注意に出して拒まない', noQuota.errors.length === 0 && noRead.errors.length === 0 && /読めない/.test(noQuota.notices.join()) && /読めず/.test(noRead.notices.join()));
  const noUnit = find({ rows: [ex('D-5', 'PR #5'), ex('D-20', 'PR #20')], thisUnit: null });
  check('IMPL-0630:ok この PR のレビューを読めない(thisUnit が null)ときは、注意に出して拒まない', noUnit.errors.length === 0 && /確定できない/.test(noUnit.notices.join()));
  // ok: この PR を対象とする行が無ければ何も出さない。ゲートの判定を対象とする行は数えない
  check('IMPL-0630:ok この PR を対象とする例外の行が無ければ何も出さない', find({ rows: [ex('D-5', 'PR #5')] }).errors.length === 0 && find({ rows: [ex('D-5', 'PR #5')] }).notices.length === 0);
  // 補充: 枠を増やす変更にステージ移行ゲートの通過が無ければ失敗。ある・初めて書く・減らすは通す
  check('IMPL-0630:ng 枠を 2 から 3 に増やし、この変更にステージ移行ゲートの通過が無ければ問題を返す', /2 から 3/.test(quotaRefillProblem({ baseBrief: brief(2), headBrief: brief(3), stagePassInPr: false }) ?? ''));
  check('IMPL-0630:ok 通過の記録が同じ変更にあれば通す', quotaRefillProblem({ baseBrief: brief(2), headBrief: brief(3), stagePassInPr: true }) === null);
  check('IMPL-0630:ok 数値が無い状態から初めて書くのは補充に数えない。減らす変更も通す', quotaRefillProblem({ baseBrief: '| 例外の枠(事業ステージあたり) | <件数> |', headBrief: brief(3), stagePassInPr: false }) === null && quotaRefillProblem({ baseBrief: brief(3), headBrief: brief(2), stagePassInPr: false }) === null);
  // 集約の表示と同じ定義(quotaOfBrief・stageQuotaUse・latestStageGatePass)
  check('IMPL-0630:共有 quotaOfBrief は全角の数字・行が無いときの扱いを集約の表示(exceptionQuotaText)と揃える', quotaOfBrief(brief(2)) === 2 && quotaOfBrief('| 例外の枠 | 3件 |') === 3 && quotaOfBrief('x') === null && /枠 2・行使 1/.test(exceptionQuotaText({ briefText: brief(2), used: 1 })));
  const recs = [{ gate: 'ステージ移行ゲート', result: '通過', judgedAt: '2026-01-01 10:00', file: 'a' }, { gate: 'SG-2', result: '**通過**', judgedAt: '2026-03-01 10:00', file: 'b' }, { gate: 'SG-3', result: '差し戻し', judgedAt: '2026-05-01 10:00', file: 'c' }, { gate: 'G-5', result: '通過', judgedAt: '2026-06-01 10:00', file: 'd' }];
  check('IMPL-0630:共有 latestStageGatePass は通過のステージ移行ゲートのうち判定日時が最後の記録を返す', latestStageGatePass(recs)?.file === 'b' && latestStageGatePass([]) === undefined);
  // ホスティングの読み(gh)。過去の行の PR の変更ファイルを、rename の旧い名も含めて返す。読めなければ null(注意で通る側へ倒れる)
  const calls = [];
  const hosted = ghHosting('o/r', { run: (args) => { calls.push(args.join(' ')); return [{ filename: 'src/pay/new.js', previous_filename: 'src/pay/old.js' }, { filename: 'src/b.js' }]; } });
  check('IMPL-0630:ok ghHosting.pullFilesOf は PR の変更ファイル(rename の旧い名を含む)を返し、同じ PR を引き直さない', hosted.pullFilesOf(5).join() === 'src/pay/new.js,src/pay/old.js,src/b.js' && hosted.pullFilesOf(5).length === 3 && calls.length === 1 && /pulls\/5\/files/.test(calls[0]), calls.join('|'));
  check('IMPL-0630:ok ghHosting.pullFilesOf は gh が失敗したら null を返す(拒まず注意に出す側)', ghHosting('o/r', { run: () => { throw new Error('x'); } }).pullFilesOf(5) === null && ghHosting('', { run: () => [] }).pullFilesOf(5) === null);
}

// ---- 閾値割れを台帳の行で受ける約束(ADR-0243。mutationBreachExceptionFor)。日付は引数。期限は固定の日付(2099 年=期限内、2000 年=期限切れ)
{
  const PEOPLE = [
    { id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: 1001 }] },
    { id: 'p2', name: '鈴木 一郎', accounts: [{ login: 'suzuki', id: 1002 }] },
  ];
  const cfg = { aiNames: ['Claude'], people: PEOPLE };
  const PRHEAD = 'a'.repeat(40);
  const rowB = (o = {}) => {
    const r = { id: 'D-012', kind: '例外', target: 'G-5 PR-12', content: '変異試験の閾値割れ', reason: '期限を優先する', due: '2099-01-01 まで', state: '未返却', approver: '鈴木 一郎', ...o };
    return `| ${r.id} | ${r.kind} | ${r.target} | ${r.content} | ${r.reason} | 不具合 | ${r.due} | ${r.state} | 山田 太郎 | ${r.approver} |\n`;
  };
  const rv = (o = {}) => ({ id: 1, state: 'COMMENTED', body: '例外承認: D-012', submitted_at: 't', commit_id: PRHEAD, author_association: 'MEMBER', author: { login: 'suzuki', id: 1002, is_bot: false }, edited_by: null, ...o });
  const run = (o = {}) => {
    const { rows = [rowB()], headRows = null, ...rest } = o;
    return mutationBreachExceptionFor({ config: cfg, baseLedgerText: ledger(...rows), headLedgerText: headRows ? ledger(...headRows) : null, prNumber: 12, day: DAY, author: { login: 'yamada', id: 1001 }, reviews: [rv()], head: PRHEAD, instructorIds: ['p1'], ...rest });
  };
  const ok = (r) => r.matched.length === 1 && r.matched[0].id === 'D-012';
  const ng = (r, re = null) => r.matched.length === 0 && (re ? re.test(r.rejected.join('\n') + (r.reason ?? '')) : true);
  check('IMPL-0931:ok 行の約束を満たす閾値割れの行は受ける(下限は無い)', ok(run()));
  check('IMPL-0931:ok 期限の日の当日は受ける(期限の比較は exceptionStanding と同じ)', ok(run({ rows: [rowB({ due: '2026-11-20 まで' })] })));
  check('IMPL-0931:ok 印の強調・全角を正規化して先頭一致で読む', ok(run({ rows: [rowB({ content: '**変異試験の閾値割れ**(スコア 60)' })] })) && mutationBreachMarkOf('`変異試験の閾値割れ` 70') !== null);
  check('IMPL-0931:ok PR の中で足した行も、(A) のレビューがあれば受ける', ok(run({ rows: [], headRows: [rowB()] })));
  check('IMPL-0931:ng 印が先頭でない', ng(run({ rows: [rowB({ content: '受容(変異試験の閾値割れ)' })] }), /印/) && mutationBreachMarkOf('スコア低下') === null);
  check('IMPL-0931:ng 期限が過去(2000 年)', ng(run({ rows: [rowB({ due: '2000-01-01 まで' })] }), /を過ぎている/));
  check('IMPL-0931:ng 期限の翌日は受けない(日付は引数で渡し、時計を読まない)', ng(run({ rows: [rowB({ due: '2026-11-19 まで' })] }), /を過ぎている/) && ok(run({ rows: [rowB({ due: '2026-11-19 まで' })], day: '2026-11-19' })));
  check('IMPL-0931:ng 承認した者が PR の作成者(排除)', ng(run({ author: { login: 'suzuki', id: 1002 }, reviews: [rv()] }), /PR の作成者/));
  check('IMPL-0931:ng 承認した者が AI の名義・名簿に無い・空', ng(run({ rows: [rowB({ approver: 'Claude' })] }), /AI の名義/) && ng(run({ rows: [rowB({ approver: '外部 太郎' })] }), /名簿/) && ng(run({ rows: [rowB({ approver: '' })] }), /未記入/));
  check('IMPL-0931:ng 状態が返却済みで期限内の行は、期限切れの理由を出さない', (() => { const r = run({ rows: [rowB({ state: '返却済み' })] }); const t = JSON.stringify(r); return /状態/.test(t) && !/を過ぎている/.test(t); })());
  check('IMPL-0931:ng 状態が有効の値でない', ng(run({ rows: [rowB({ state: '取り下げ' })] }), /状態/));
  check('IMPL-0931:ng 対象が別の PR・別のゲート・PR #12・番号の前方一致', [ 'G-5 PR-13', 'G-5 PR-120', 'G-6 PR-12', 'PR #12', 'G-5 P-001' ].every((t) => ng(run({ rows: [rowB({ target: t })] }))));
  check('IMPL-0931:ng 区分が例外でない', ng(run({ rows: [rowB({ kind: '負債' })] })));
  check('IMPL-0931:ng (A) のレビューが無い・先頭が変わった・読めない', ng(run({ reviews: [] }), /帰属/) && ng(run({ reviews: [rv({ commit_id: 'c'.repeat(40) })] }), /先頭が変わった/) && ng(run({ reviews: null }), /読めない/));
  check('IMPL-0931:ng 作成を指示した者が承認した者本人・名簿に対応づかない', ng(run({ instructorIds: ['p2'] }), /指示した者/) && ng(run({ instructorUnresolved: ['@x'] }), /指示した者/));
  check('IMPL-0931:ng 基底にある ID は基底の内容で読む(PR の中で期限を未来へ書き換えても効かない)', ng(run({ rows: [rowB({ due: '2000-01-01 まで' })], headRows: [rowB({ due: '2099-01-01 まで' })] }), /を過ぎている/));
  check('IMPL-0931:ng PR の番号・実行の日・台帳が無いときは理由つきで受けない', ng(run({ prNumber: null }), /PR の番号/) && ng(run({ day: 'x' }), /実行の日/) && ng(mutationBreachExceptionFor({ config: cfg, prNumber: 12, day: DAY }), /台帳/));
  // U6c: 集約の照合(unjudgedGateExceptions)は、段と同じ関数の読みで、対象が G-5 PR-<番号> で印のある行だけを欠落にしない
  const MARK = '変異試験の閾値割れ(スコア 40・閾値 60)';
  const g5 = (label, target, content) => ({ label, t: gateExceptionTarget(target), ...(content === undefined ? {} : { content }) });
  const un = unjudgedGateExceptions([g5('D-012', 'G-5 PR-12', MARK), g5('D-013', 'G-5 P-001', MARK), g5('D-014', 'G-5 PR-12', 'スコア低下'), g5('D-015', 'G-5 PR-12')], () => true);
  check('IMPL-0931:ok G-5 PR-12 で印のある行は欠落にしない(段が受ける行)', !un.some((x) => x.label === 'D-012'), JSON.stringify(un));
  check('IMPL-0931:ng 印の無い G-5 PR-12 の行は欠落のまま', un.some((x) => x.label === 'D-014' && /gate-g5/.test(x.text)));
  check('IMPL-0931:ng 内容が渡されない G-5 PR-12 の行は、subject の形だけでは判定せず欠落のまま', un.some((x) => x.label === 'D-015'));
  check('IMPL-0996:ng 印があっても G-5 P-001 などほかの G-5 の行は欠落のまま', un.some((x) => x.label === 'D-013') && un.length === 3, JSON.stringify(un.map((x) => x.label)));
  check('IMPL-0931:ok 強調の印も段と同じ読みで受ける(欠落にしない)', unjudgedGateExceptions([g5('D-1', 'G-5 PR-12', '**変異試験の閾値割れ**')], () => true).length === 0);
}

console.log(`\n${checks - failures}/${checks} 合格`);
process.exit(failures ? 1 : 0);
