// ステージの途中の必達基準の判定記録の「到達の見込み」の欠落を、出荷判定の証跡の集約(aggregate-evidence.mjs)が
// 記載の欠落に数えることを、通しで試験する(標準 第7章 7.7.3 必達基準2 / テンプレ4。process-compass #359 / IMPL-0381)。
//
//   node scripts/gate/test-reach-forecast-record.mjs
//
// テンプレートの全ファイルを一時のディレクトリへ写し、ゲート欄が「必達基準の判定(ステージの途中)」の判定記録を置いて集約を実行します。
// 次を確かめます。
//   - 節「到達の見込み」の無い記録と、空欄・様式の説明のままの欄のある記録を、記載の欠落にする
//   - 欄をすべて書いた記録は通す
//   - ステージ移行ゲートの記録には、この検査を掛けない(process-compass #415 の裁定 M2-9)
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

const FULL = {
  判定の契機: '7.7.4 の上程',
  比べる対象: 'SC-M の未完了 12 件',
  実測スループットの端: '窓 6 期(2週間)。最小 2 件・最大 5 件',
  期間の見込み: '遅い側 6 期 / 速い側 3 期',
  費用の見込み: '単位期間あたり 40 万円。確定済みの未発生 30 万円',
  比べる残り: '直近の SG(2026-09-01)から期日まで 5 期。期間予算 400 万円',
  区分: '期間 乙 / 期間予算 甲 / 要員予算 甲。案件 乙',
  端の取り方: '既定',
  '7.7.5 の回数': '0 回',
  確かめた者: '名簿 甲',
};
const header = (gate, day) =>
  `# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | ${gate} |\n| 対象 | 案件 |\n| 判定者 | 名簿 戊 |\n| 判定日時 | ${day} 10:00 |\n| 結果 | 通過 |\n\n`;
const reach = (rows) => '## 到達の見込み(適用: ステージの途中)\n\n| 欄 | 記載 |\n| --- | --- |\n' + Object.entries(rows).map(([k, v]) => `| ${k} | ${v} |\n`).join('');

function run(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-reach-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const config = quiet(() => buildConfig(ANSWERS, { generatedAt: '2026-08-01T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('process.config.json', JSON.stringify(config, null, 2) + '\n');
  for (const [rel, text] of Object.entries(records)) write(rel, text);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', 'chore: fixture'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-02T09:00:00+09:00', GIT_COMMITTER_DATE: '2026-11-02T09:00:00+09:00' },
  });
  const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

const MID = '必達基準の判定(ステージの途中)';
const reachLines = (out) => out.split('\n').filter((l) => /到達の見込み/.test(l) && /記載の欠落/.test(l));
{
  const { 確かめた者: _omit, ...withoutSigner } = FULL;
  const out = run({
    'docs/gates/mc-a-2026-10-01.md': header(MID, '2026-10-01') + '## 決断の記録\n\n| 欄 | 記載 |\n| --- | --- |\n| 確認した事項 | 見込みの報告の Issue |\n',
    'docs/gates/mc-b-2026-10-08.md': header(MID, '2026-10-08') + reach({ ...withoutSigner, 確かめた者: '<価値責任者の記名>', 区分: '' }),
    'docs/gates/mc-c-2026-10-15.md': header(MID, '2026-10-15') + reach(FULL),
    'docs/gates/sg-2026-10-20.md': header('ステージ移行', '2026-10-20'),
    'docs/gates/mc-d-2026-10-22.md': header(MID, '2026-10-22') + reach({ ...FULL, 区分: '算定できない(窓の単位期間が2つ)', 期間の見込み: '該当なし(算定できない)', 費用の見込み: '該当なし(算定できない)', 比べる残り: '該当なし(算定できない)' }),
    'docs/gates/mc-e-2026-10-23.md': header(MID, '2026-10-23') + reach({ ...FULL, 区分: '期間 乙 / 期間予算 対象外 / 要員予算 対象外。案件 乙', 期間の見込み: '該当なし(対象外)' }),
    'docs/gates/mc-g-2026-10-25.md': header(MID, '2026-10-25') + reach({ ...FULL, 区分: '期間 甲 / 期間予算 算定できない / 要員予算 甲。案件 算定できない', 費用の見込み: '該当なし(期間予算が未確定)' }),
    'docs/gates/mc-f-2026-10-24.md': header(MID, '2026-10-24') + reach({ ...FULL, 区分: '算定できない', 期間の見込み: '該当なし' }),
  });
  const ls = reachLines(out);
  check('試験の前提: 集約が最後まで走る', /を出力しました/.test(out), out.slice(-1200));
  // IMPL-0381:ng(違反と適合の対。標準の実装マーク)
  check('節「到達の見込み」の無い途中の判定記録を、必達基準2 を満たさない記載の欠落にする', ls.some((l) => /mc-a-2026-10-01\.md: ステージの途中の必達基準の判定記録に「到達の見込み」の節がありません/.test(l)), ls.join('\n') || out.slice(-1500));
  check('空欄と様式の説明のままの欄を、欄の名で欠落にする', ls.some((l) => /mc-b-2026-10-08\.md: 「到達の見込み」に空欄の欄があります\(区分 \/ 確かめた者\)/.test(l)), ls.join('\n'));
  // IMPL-0381:ok(違反と適合の対。標準の実装マーク)
  check('欄をすべて書いた途中の判定記録は通す', !ls.some((l) => /mc-c-2026-10-15\.md/.test(l)), ls.join('\n'));
  check('区分が「算定できない」の記録は、見込みと残りを「該当なし(理由)」と書いても欠落にしない(7.7.3。突合 低-1)', !ls.some((l) => /mc-d-2026-10-22\.md/.test(l)), ls.join('\n'));
  check('組の1つが乙の記録は、対象外の組があっても見込みの「該当なし」を欠落にする(突合の再確認 新-5)', ls.some((l) => /mc-e-2026-10-23\.md: 「到達の見込み」に空欄の欄があります\(期間の見込み\)/.test(l)), ls.join('\n'));
  check('理由の無い「該当なし」は、区分が算定できないでも欠落にする(突合の再確認 新-5)', ls.some((l) => /mc-f-2026-10-24\.md: 「到達の見込み」に空欄の欄があります\(期間の見込み\)/.test(l)), ls.join('\n'));
  check('組に甲があっても案件の区分が算定できないなら、理由つきの該当なしを欠落にしない(7.7.3。突合の再確認 2回目 中)', !ls.some((l) => /mc-g-2026-10-25/.test(l)), ls.join(String.fromCharCode(10)));
  check('ステージ移行ゲートの記録には、到達の見込みの検査を掛けない(#415 の M2-9)', !ls.some((l) => /sg-2026-10-20\.md/.test(l)), ls.join('\n'));
}

console.log('');
if (failures) {
  console.error(`test-reach-forecast-record: ${failures}/${checks} 件が失敗`);
  process.exit(1);
}
console.log(`test-reach-forecast-record: ${checks} 件すべて通過`);
