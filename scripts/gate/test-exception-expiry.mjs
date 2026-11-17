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
import { buildConfig } from '../init/generate-profile.mjs';
import { exceptionStanding, lapsedExceptions, lapsedGapText, countRangeExceptions, overdueExceptionNote, unjudgedGateExceptions } from './exception-expiry.mjs';

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
  check('集約 IMPL-0996:ng 他の機能(F-002)の記録だけでは、G-4 F-001 の行は成立しない', gapOf(c.ev, new RegExp(`${c.id(0)}\\(G-4 F-001\\).*G-4 の判定記録.*無い`)).length === 1, JSON.stringify(c.ev?.gaps?.filter((g) => /例外承認/.test(g))));
  const d = scene(['G-4 F-001'], { 'g4-f001.md': form('G-4 機能仕様承認', 'F-001 / 1a2b3c4', '差し戻し') });
  check('集約 IMPL-0996:ok G-4 F-001 の判定記録(差し戻し)がある行は、欠落に出ず、例外承認として数える', gapOf(d.ev, new RegExp(`${d.id(0)}\\(G-4 F-001\\)`)).length === 0 && shows(d.ev, `${d.id(0)}(G-4 F-001)`), JSON.stringify(d.ev?.gaps?.filter((g) => /例外承認/.test(g))));
  w.done();
}

console.log(`\n${checks - failures}/${checks} 合格`);
process.exit(failures ? 1 : 0);
