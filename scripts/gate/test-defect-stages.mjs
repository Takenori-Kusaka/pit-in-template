// 確定した欠陥の検出工程(運用メトリクス「欠陥の検出工程」「重大欠陥の流出」)を、出荷判定の証跡の集約(aggregate-evidence.mjs)が
// 欠陥の台帳から数えることを、通しで試験する(process-compass #413 / ADR-0102。IMPL-0392)。
//
//   node scripts/gate/test-defect-stages.mjs
//
// テンプレートの全ファイルを一時のディレクトリへ写し、欠陥の台帳に行を置いて集約を実行し、品質レポートの行を確かめます。
//   - 処分が「欠陥」で、確定した者が人・確定日のある行だけを、検出した工程ごとに数える
//   - 確定した者が AI の名義の行、確定した者の無い行、未処分の行、「欠陥でない」の行は数えない(未処分は件数だけを出す)
//   - 検出の時点と検出した工程の食い違いを示す。起票の経路ごとの件数は出さない
//   - 列の無い旧い台帳は「未測定」と出す
// GitHub へ問い合わせません。リポジトリの状態を変えません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
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

const ANSWERS = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9', 'q-biz-phase': 'growth', 'q-external-reviewer': 'reviewer-yes',
};
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));

// 列: ID | 現象 | 重大度 | 優先度 | 状態 | コア機能 | 回避策 | 検出の時点 | 発生日 | AI 起因 | 原因の変更 | 登録した変更種別 | レビューで示した箇所 | 検出した工程 | 起票の経路 | 処分 | 確定した者 | 確定日
const row = (id, { sev = 'Sev3', when = '出荷前', stage = '', origin = '人', disp = '', by = '', at = '', cause = '#1' } = {}) =>
  `| ${id} | 現象 ${id} | ${sev} | 中 | 解決済み | いいえ | — | ${when} | 2026-10-20 | なし | ${cause} | — | 提示なし | ${stage} | ${origin} | ${disp} | ${by} | ${at} |`;
// 範囲の終点(この試験の唯一のコミットの日)より後の確定日。範囲の外として数えない
const FUTURE = '2999-01-01';
const ROWS = [
  row('D-1', { sev: 'Sev1', when: '運用', stage: '運用', origin: '運用の事象', disp: '欠陥', by: '名簿 甲', at: '2026-10-21' }),
  row('D-2', { stage: '出荷前の検証', origin: 'AI の層', disp: '欠陥', by: 'Claude', at: '2026-10-21' }),
  row('D-3', { stage: '出荷前の検証', origin: 'AI の層' }),
  row('D-4', { when: '運用', stage: '出荷前の検証', origin: '人', disp: '欠陥', by: '名簿 乙', at: '2026-10-22' }),
  row('D-5', { stage: '出荷判定', origin: 'AI の層', disp: '欠陥でない', by: '名簿 乙', at: '2026-10-22' }),
  row('D-6', { stage: '出荷判定', origin: '人', disp: '欠陥' }),
  row('D-7', { when: '運用', stage: '運用', origin: '運用の事象', disp: '欠陥', by: '名簿 甲', at: FUTURE }),
  row('D-8', { when: '', stage: '運用', origin: '利用者' }),
  row('D-9', { when: '運用', stage: '運用', origin: '利用者', disp: '欠陥でない', by: '名簿 甲', at: '2026-10-22', cause: 'abc1234' }),
];

function run(ledger) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-defect-stages-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const config = quiet(() => buildConfig(ANSWERS, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(config, null, 2) + '\n');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/defect-ledger.md'), ledger);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: fixture');
  const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  const reportPath = path.join(dir, 'evidence/quality-report.md');
  const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, report };
}

const template = fs.readFileSync(path.join(ROOT, 'templates/defect-ledger.md'), 'utf8').replace(/\r\n/g, '\n');
const emptyRow = template.split('\n').find((l) => /^\|(\s*\|)+\s*$/.test(l));
{
  check('試験の前提: 台帳の様式に空の行がある', Boolean(emptyRow));
  const r = run(template.replace(emptyRow, ROWS.join('\n')));
  const line = r.report.split('\n').find((l) => l.includes('確定した欠陥の検出工程')) ?? '';
  const notes = r.report.split('\n').find((l) => l.includes('注記:') && l.includes('検出した工程')) ?? '';
  check('試験の前提: 品質レポートに行が出る', Boolean(line), r.out.slice(-1200));
  // IMPL-0392:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('確定した行(人の確定者・確定日)だけを、検出した工程ごとに数える', /出荷前の検証 1 件 \/ 出荷判定 0 件 \/ 運用 1 件 \/ 特定できない 0 件。合計 2 件/.test(line), line);
  check('検出の時点が運用で確定した Sev1・Sev2 を数える', /検出の時点が運用の Sev1・Sev2 1 件/.test(line), line);
  // IMPL-0392:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('確定した者が AI の名義の行は数えず、注記に出す', /確定した者が AI の名義の行 D-2/.test(notes), notes);
  check('確定した者の無い「欠陥」の行は数えず、注記に出す', /確定した者・確定日の無い行 D-6/.test(notes), notes);
  check('検出の時点と検出した工程の食い違いを注記に出す', /食い違う行 D-4/.test(notes), notes);
  check('確定日が範囲の外の行(D-7)は数えない(累計にしない)', /運用 1 件/.test(line) && /合計 2 件/.test(line), line);
  check('検出の時点が空欄の行を、処分の有無によらず注記に出す', /検出の時点が空欄の行 D-8/.test(notes), notes);
  check('未処分の件数は、範囲によらず現時点の行数を出す', /現時点の未処分の報告 2 件/.test(line), line);
  check('作成を指示した者を確かめられない運用の処分を、黙って落とさず注記に出す', /確かめられない行 D-9/.test(notes), notes);
  check('起票の経路ごとの件数は出さない', !/AI の層 \d+ 件|経路.*\d+ 件/.test(line), line);
}
{
  const old = '# 欠陥の台帳\n\n| ID | 現象 | 重大度(Sev1 / Sev2 / Sev3) | 優先度 | 状態(未解決 / 解決済み) |\n| --- | --- | --- | --- | --- |\n| D-1 | x | Sev3 | 中 | 解決済み |\n';
  const r = run(old);
  check('列の無い旧い台帳は「未測定」と出す', /確定した欠陥の検出工程: 未測定\(台帳に列「検出した工程」「処分」「確定した者」「確定日」が無い/.test(r.report), r.report.split('\n').filter((l) => /検出工程/.test(l)).join('\n') || r.out.slice(-800));
}

console.log('');
if (failures) {
  console.log(`確定した欠陥の検出工程の通しの試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`確定した欠陥の検出工程の通しの試験: ${checks} 件が期待と一致しました`);
