// 強制層の検査の棚卸しの入力の試験(IMPL-0145。process-compass #326)。
// 時計と TZ に依らない: 窓は引数の四半期、GitHub の入出力は差し替える。子プロセスで TZ=UTC と TZ=Asia/Tokyo の同一を確かめる。
//
//   node scripts/gate/test-enforcement-inventory.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quarterWindow, parseCorrections, isDeviceTarget, tally, fetchRuns, fetchJobs, inventory } from './enforcement-inventory.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 700)}`}`);
}

const win = quarterWindow('2026Q4');
const ledger = [
  '# 欠陥の台帳',
  '',
  '## 台帳',
  '',
  '| ID | 現象 |',
  '| --- | --- |',
  '| D1 | 台帳の表の行は読まない |',
  '',
  '## 是正の記録(標準 第4章 G-5「是正の起動」)',
  '',
  '| 日付 | 起点 | 対象(見逃した類型と注入の記録) | 同じ条件で再び起こりうるか |',
  '| --- | --- | --- | --- |',
  '| | | | |',
  '| 2026-10-14 | 欠陥注入の見逃し | .github/workflows/gate-g5.yml の gate-contract が落とす類型 | はい |',
  '| 2026-11-03 | 統制の弱化の検知 | PR #120(scripts/gate/check-pr.mjs の閾値の緩和) | いいえ |',
  '| 2026-11-20 | 統制の弱化の検知 | 製品のコード src/app.ts の変更 | いいえ |',
  '| 2026-07-02 | 欠陥注入の見逃し | scripts/gate/spec-lint.mjs の語 | はい |',
  '| 令和の日付 | 欠陥注入の見逃し | scripts/gate/next.mjs の表示 | はい |',
  '| 2026-12-05 | 統制の弱化の検知 | ジョブ lint-docs の除外 | はい |',
  '',
  '- 注記',
  '',
  '## 引き下げの点検の記録',
  '',
  '| 日付 | 対象 |',
  '| --- | --- |',
  '| 2026-11-01 | scripts/gate/xxx.mjs |',
].join('\n');

// ---- 窓 ----
check('窓: 四半期を UTC の暦の日で求める(2026Q4 は 10-01〜12-31)。読めなければ null', win.from === '2026-10-01' && win.to === '2026-12-31' && quarterWindow('2026Q1').to === '2026-03-31' && quarterWindow('2026Q5') === null && quarterWindow('') === null);

// ---- 是正の記録の読み ----
const rows = parseCorrections(ledger);
check('是正の記録: 節の中の表だけを読む(台帳の表・次の節の表・空の雛形の行は除く)', rows.length === 6 && rows.every((r) => !/xxx|台帳の表/.test(r.target)), JSON.stringify(rows.map((r) => r.target)));
check('是正の記録: 節が無ければ null', parseCorrections('# 欠陥の台帳\n\n## 台帳\n') === null);
check('是正の記録: 日付を読めない行は day が null', rows.find((r) => r.date === '令和の日付').day === null);
check('検査装置の対象: パスの語・ジョブ名を含む行だけ', isDeviceTarget('scripts/gate/a.mjs') && isDeviceTarget('.github/workflows/x.yml') && isDeviceTarget('ジョブ lint-docs の除外', ['lint-docs']) && !isDeviceTarget('製品のコード src/app.ts') && !isDeviceTarget('ジョブ lint-docs の除外'));

// ---- 失敗の集計 ----
const R = (id, p, conclusion, day) => ({ id, name: p.split('/').pop(), path: `${p}@refs/heads/main`, conclusion, created_at: `${day}T03:00:00Z` });
const runs = [
  R(1, '.github/workflows/gate-g5.yml', 'failure', '2026-10-12'),
  R(2, '.github/workflows/gate-g5.yml', 'failure', '2026-11-08'),
  R(3, '.github/workflows/gate-g5.yml', 'failure', '2026-11-30'),
  R(4, '.github/workflows/gate-g5.yml', 'success', '2026-12-01'),
  R(5, '.github/workflows/docs.yml', 'success', '2026-11-02'),
  R(6, '.github/workflows/docs.yml', 'success', '2026-11-03'),
];
const jobsByRun = { 1: [{ name: 'gate-contract', conclusion: 'failure' }, { name: 'pr-rules', conclusion: 'success' }], 2: [{ name: 'gate-contract', conclusion: 'failure' }], 3: [{ name: 'pr-rules', conclusion: 'failure' }] };
const jobsOf = (r) => jobsByRun[r.id] ?? [];
const t = tally(runs, jobsOf);
const g5 = t.workflows.find((w) => w.workflow === '.github/workflows/gate-g5.yml');
check('IMPL-0145:ok 失敗 3 件のワークフローが、回数・実行数・最後の失敗の日つきで出る', g5.failures === 3 && g5.runs === 4 && g5.lastFailure === '2026-11-30', JSON.stringify(g5));
check('IMPL-0145:ok 失敗の無いワークフローも、失敗 0 件として出る(働いていない検査の入力)', t.workflows.find((w) => w.workflow === '.github/workflows/docs.yml').failures === 0);
check('IMPL-0145:ok ジョブごとの失敗の回数と最後の失敗の日', JSON.stringify(t.jobs.map((j) => [j.job, j.failures, j.lastFailure])) === JSON.stringify([['gate-contract', 2, '2026-11-08'], ['pr-rules', 1, '2026-11-30']]), JSON.stringify(t.jobs));
check('ジョブを読めない実行(null)は、ワークフローの失敗にだけ数える', (() => { const x = tally([R(9, 'a.yml', 'failure', '2026-11-01')], () => null); return x.workflows[0].failures === 1 && x.jobs.length === 0; })());

// ---- 一覧 ----
const text = inventory({ window: win, ledgerText: ledger, runsResult: { runs }, jobsOf });
check('IMPL-0145:ok 一覧に、窓の中の検査装置の是正の行だけが出る(窓の外・製品のコードの行は出ない)', /2026-10-14/.test(text) && /2026-11-03/.test(text) && !/2026-07-02/.test(text) && !/src\/app\.ts/.test(text) && !/2026-11-01/.test(text), text);
check('IMPL-0145:ok ジョブ名を対象に書いた行(窓の外の 2026-12-05 は日付の窓の内。lint-docs は実行の記録に無いので出ない)', !/2026-12-05/.test(text));
check('日付を読めない行も落とさず、読めないと出す', /日付を読めない/.test(text) && /令和の日付/.test(text));
check('IMPL-0145:ok 是正の行が、ワークフローのパスで失敗の行に対応づく', /gate-g5\.yml \| \(全体\) \| 3 \| 4 \| 2026-11-30 \| \d+ 行目/.test(text) && /docs\.yml \| \(全体\) \| 0 \| 2 \| — \| —/.test(text), text);
check('一覧は合否を持たず、候補を選ばない旨を書く', /候補を選ばず、合否に使いません/.test(text) && /人が判断します/.test(text));
const jobText = inventory({ window: win, ledgerText: ledger, runsResult: { runs: [R(1, '.github/workflows/gate-g5.yml', 'failure', '2026-12-04')] }, jobsOf: () => [{ name: 'lint-docs', conclusion: 'failure' }] });
check('IMPL-0145:ok ジョブの名を対象に書いた是正の行が、そのジョブに対応づく', /2026-12-05/.test(jobText) && /\| lint-docs \| 1 \| — \| 2026-12-04 \| \d+ 行目/.test(jobText), jobText);

// ---- 読めないとき ----
const unreadable = inventory({ window: win, ledgerText: ledger, runsResult: { error: 'HTTP 403' }, jobsOf });
check('IMPL-0145:ng 実行の記録を読めなければ「読めない」と出し、失敗 0 件と読み違えさせない', /読めない: 実行の記録を読み出せませんでした\(HTTP 403\)/.test(unreadable) && /0 件という意味ではありません/.test(unreadable) && !/\| 失敗 \|/.test(unreadable));
check('IMPL-0145:ng 台帳が無い・節が無ければ「読めない」と出す', /読めない: docs\/defect-ledger\.md がありません/.test(inventory({ window: win, ledgerText: null, runsResult: { runs: [] }, jobsOf })) && /節「是正の記録」が見つかりません/.test(inventory({ window: win, ledgerText: '# x\n', runsResult: { runs: [] }, jobsOf })));
check('実行が 0 件なら、0 件と保持期間の注意を出す', /0 件でした\(保持期間/.test(inventory({ window: win, ledgerText: ledger, runsResult: { runs: [] }, jobsOf })));

// ---- GitHub の入力の差し替え ----
const calls = [];
const gh = (args) => {
  calls.push(args.join(' '));
  if (/actions\/runs\?/.test(args.join(' '))) return JSON.stringify([{ total_count: 2, workflow_runs: [{ id: 1, name: 'g5', path: '.github/workflows/gate-g5.yml', conclusion: 'failure', created_at: '2026-10-12T00:00:00Z' }] }, { total_count: 2, workflow_runs: [{ id: 2, name: 'g5', path: '.github/workflows/gate-g5.yml', conclusion: 'success', created_at: '2026-10-13T00:00:00Z' }] }]);
  if (/runs\/1\/jobs/.test(args.join(' '))) return JSON.stringify([{ total_count: 1, jobs: [{ name: 'gate-contract', conclusion: 'failure' }] }]);
  throw new Error('404');
};
const fr = fetchRuns(gh, 'o/r', win);
check('実行の記録の読み取り: ページ送りの応答を平らにし、窓を渡す。読み取りの API だけ', fr.runs.length === 2 && /created=2026-10-01\.\.2026-12-31/.test(calls[0]) && calls.every((c) => !/-X/.test(c)), JSON.stringify(fr));
check('ジョブの読み取り: 読めなければ null', fetchJobs(gh, 'o/r', 1)[0].name === 'gate-contract' && fetchJobs(gh, 'o/r', 2) === null);
check('実行の記録を読めない例外は error に包む', Boolean(fetchRuns(() => { throw Object.assign(new Error('x'), { stderr: 'HTTP 403: Forbidden\nmore' }); }, 'o/r', win).error) && fetchRuns(() => { throw Object.assign(new Error('x'), { stderr: 'HTTP 403: Forbidden\nmore' }); }, 'o/r', win).error === 'HTTP 403: Forbidden');

// ---- TZ に依らない ----
if (process.argv.includes('--emit')) {
  console.log(text);
  process.exit(0);
}
const run = (tz) => execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--emit'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
check('TZ に依らない: TZ=UTC と TZ=Asia/Tokyo で同じ一覧', run('UTC') === run('Asia/Tokyo') && run('UTC').length > 200);

// ---- 命令行 ----
const cli = (args) => {
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('./enforcement-inventory.mjs', import.meta.url)), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return 0;
  } catch (e) {
    return e.status;
  }
};
check('命令行: 四半期が読めなければ終了コード 2', cli(['--quarter', 'x']) === 2 && cli([]) === 2);

console.log(failures ? `\n${failures} 件が期待と異なる` : '\n強制層の検査の棚卸しの入力の試験: すべて期待どおり');
process.exit(failures ? 1 : 0);
