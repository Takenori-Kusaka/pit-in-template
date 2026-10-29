// 集約ジョブ(gate-g5)が合否に使う検査の読み方(g5-aggregate.mjs)を、ワークフローの定義の写しで試験する。
//
//   node scripts/gate/test-g5-aggregate.mjs
//
// 標準 第4章 G-5「判定基準を実装する検査と集約」と、附属書H H.6 保証の開示 項目4(process-compass #290 / ADR-0074)。
// 契約検査と出荷判定の証跡の集約が同じ関数を使います。テンプレートのワークフローそのものが通ること、needs から
// ジョブを外す・ジョブを消す・continue-on-error を足す・集約が結果を見ない、の各場面で不備が出ることを確かめます。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { aggregateFindings, needsOf, jobsOf, machineCheckStatus, G5_WORKFLOW } from './g5-aggregate.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail)}`}`);
}

const wf = fs.readFileSync(path.join(ROOT, G5_WORKFLOW), 'utf8');
const NEEDS = 'needs: [config, contract, test, static-analysis, spec-lint, context-format, ip-clearance, secret-scan, pr-rules]';
check('テンプレートのワークフローに、集約の needs の行がある(試験の目印)', wf.includes(NEEDS));

// 1. テンプレートのワークフローそのもの
{
  const f = aggregateFindings(wf);
  // IMPL-0142:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('テンプレートの gate-g5.yml は不備 0 件', f.problems.length === 0, f.problems.join(' / '));
  check('集約の needs を 9 件読む', f.needs.length === 9, JSON.stringify(f.needs));
  check('基準6 のうち確かめていない部分(アンカー・逆引用符・分量の上限)を注意として出す', f.notes.some((n) => /基準6.*分量の上限/.test(n)));
}

// 2. needs から 5 つのジョブを外す(秘匿情報の検査を含む。品質保証の委員が実行して確かめた場面)
{
  const f = aggregateFindings(wf.replace(NEEDS, 'needs: [config, contract, pr-rules]'));
  const crit = (n) => f.problems.some((p) => new RegExp(`G-5 基準${n}\\(`).test(p));
  // IMPL-0142:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('needs から外すと、基準1・2・3・4・5・6・7 の不備が出る', [1, 2, 3, 4, 5, 6, 7].every(crit), f.problems.join(' / '));
  check('秘匿情報の検査を外した不備が「第8章の調整だけ」を案内する', f.problems.some((p) => /基準7.*第8章の調整だけ/.test(p)));
}

// 3. pr-rules・contract を外す
{
  const f = aggregateFindings(wf.replace(NEEDS, 'needs: [config, test, static-analysis, spec-lint, ip-clearance, secret-scan]'));
  check('PR 単位の検査(pr-rules)と契約検査(contract)を外すと不備が出る', f.problems.some((p) => /pr-rules/.test(p)) && f.problems.some((p) => /contract/.test(p)), f.problems.join(' / '));
}

// 4. needs の箇条の書き方も読む
{
  const list = wf.replace(NEEDS, 'needs:\n      - config\n      - contract\n      - test\n      - static-analysis\n      - spec-lint\n      - context-format\n      - ip-clearance\n      - secret-scan\n      - pr-rules');
  const f = aggregateFindings(list);
  check('needs を箇条で書いても読む(不備 0 件)', f.problems.length === 0 && f.needs.length === 9, f.problems.join(' / '));
  check('needsOf は 1 語の needs を読む', JSON.stringify(needsOf('    needs: config\n')) === '["config"]');
}

// 5. needs にあるがジョブの定義が無い
{
  const jobs = jobsOf(wf);
  const body = jobs.get('secret-scan');
  check('ジョブの本文を切り出せる(secret-scan)', Boolean(body && /secretScan/.test(body)));
  const removed = wf.replace(/\n {2}secret-scan:\n[\s\S]*?(?=\n {2}[A-Za-z0-9_-]+:\n)/, '\n');
  const f = aggregateFindings(removed);
  check('needs にあるジョブを消すと「定義されていません」の不備が出る', f.problems.some((p) => /基準7.*"secret-scan" が定義されていません/.test(p)), f.problems.join(' / '));
}

// 6. ジョブの単位の continue-on-error
{
  const coe = wf.replace(/(\n {2}secret-scan:\n {4}name: secret-scan\n)/, '$1    continue-on-error: true\n');
  check('continue-on-error を足す試験の目印がある', coe !== wf);
  const f = aggregateFindings(coe);
  check('continue-on-error のジョブは合否に使われていない扱いになる', f.problems.some((p) => /基準7.*continue-on-error/.test(p)) && !f.effective.has('secret-scan'), f.problems.join(' / '));
}

// 7. 集約が needs の結果を見ない
{
  const blind = wf.replace(/contains\(needs\.\*\.result, 'failure'\) \|\| contains\(needs\.\*\.result, 'cancelled'\)/, 'false');
  check('集約の判定を書き換える試験の目印がある', blind !== wf);
  const f = aggregateFindings(blind);
  check('集約が needs の結果を見ないと不備が出て、合否に使う検査は 0 件', f.problems.some((p) => /needs\.\*\.result/.test(p)) && f.effective.size === 0, f.problems.join(' / '));
}

// 8. 集約ジョブが無い
{
  const f = aggregateFindings(wf.replace(/\n {2}gate-g5:\n/, '\n  gate-x:\n'));
  check('集約ジョブ gate-g5 が無いと不備が出る', f.problems.some((p) => /集約ジョブ "gate-g5" がありません/.test(p)));
}

// 9. 保証の開示 項目4 の表示(設計の有効性で「実施」と出さない)
{
  const adapter = { commands: { test: 'npm test', secretScan: 'npx secretlint' } };
  const full = aggregateFindings(wf);
  const cut = aggregateFindings(wf.replace(NEEDS, 'needs: [config, contract, pr-rules]'));
  const st = (o) => machineCheckStatus({ adapter, hasTarget: true, noRecord: '記録なし', ...o });
  // IMPL-0147:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('項目4: 集約が使うジョブは「実施」', /^実施/.test(st({ aggregate: full, name: 'secretScan', job: 'secret-scan' })));
  // IMPL-0147:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('項目4: コマンドがあっても集約が使わなければ「未実施」', /^未実施\(ジョブ secret-scan を集約 gate-g5 が合否に使っていない\)/.test(st({ aggregate: cut, name: 'secretScan', job: 'secret-scan' })));
  check('項目4: コマンドが無ければ「未実施(コマンドが未設定)」', st({ aggregate: full, name: 'lint', job: 'static-analysis' }) === '未実施(コマンドが未設定)');
  check('項目4: 集約の定義が無ければ「未実施」', /^未実施\(集約 gate-g5 の定義/.test(st({ aggregate: null, name: 'test', job: 'test' })));
  check('項目4: 検査対象が無ければ従来どおり', st({ aggregate: full, hasTarget: false, name: 'test', job: 'test' }) === '未実施(検査対象が存在しない)');
  check('項目4: アダプタが読めなければ記録なし', machineCheckStatus({ adapter: null, hasTarget: false, aggregate: full, name: 'test', job: 'test', noRecord: '記録なし' }) === '記録なし');
}

// 10. ワークフロー: contract でこの試験を実行する
check('ワークフロー: contract で、この試験を実行する', /node scripts\/gate\/test-g5-aggregate\.mjs/.test(wf));

console.log('');
if (failures) {
  console.log(`集約の検査の試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`集約の検査の試験: ${checks} 件が期待と一致しました`);
