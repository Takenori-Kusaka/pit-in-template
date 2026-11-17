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
import { ROOT, sealChangeLog, parseLedger } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';
import { exceptionStanding, lapsedExceptions, countRangeExceptions, overdueExceptionNote } from './exception-expiry.mjs';

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

console.log(`\n${checks - failures}/${checks} 合格`);
process.exit(failures ? 1 : 0);
