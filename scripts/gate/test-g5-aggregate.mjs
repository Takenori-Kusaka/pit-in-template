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
import { spawnSync } from 'node:child_process';
import { aggregateFindings, needsOf, jobsOf, machineCheckStatus, successCheckedJobs, G5_WORKFLOW } from './g5-aggregate.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail)}`}`);
}

const wf = fs.readFileSync(path.join(ROOT, G5_WORKFLOW), 'utf8');
const NEEDS = 'needs: [config, contract, test, static-analysis, spec-lint, context-format, ip-clearance, secret-scan, pr-rules, mutation, regulatory]';
check('テンプレートのワークフローに、集約の needs の行がある(試験の目印)', wf.includes(NEEDS));

// 1. テンプレートのワークフローそのもの
{
  const f = aggregateFindings(wf);
  // IMPL-0142:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('テンプレートの gate-g5.yml は不備 0 件', f.problems.length === 0, f.problems.join(' / '));
  check('集約の needs を 11 件読む(段 mutation・regulatory を含む)', f.needs.length === 11 && f.needs.includes('mutation') && f.needs.includes('regulatory'), JSON.stringify(f.needs));
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
  const list = wf.replace(NEEDS, 'needs:\n      - config\n      - contract\n      - test\n      - static-analysis\n      - spec-lint\n      - context-format\n      - ip-clearance\n      - secret-scan\n      - pr-rules\n      - mutation\n      - regulatory');
  const f = aggregateFindings(list);
  check('needs を箇条で書いても読む(不備 0 件)', f.problems.length === 0 && f.needs.length === 11, f.problems.join(' / '));
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
  // 集約の中の needs.*.result と needs.<job>.result の参照をすべて外す(env の受け渡しも含める)
  const blind = wf.replace(/\n {2}gate-g5:\n[\s\S]*$/, (blk) => blk.replace(/needs\.(\*|[A-Za-z0-9-]+)\.result/g, 'x'));
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

// 9b. 製品のコードの無い構成の項目4(process-compass #330 T-5)。対象なしの検査は検査ごとに「未実施(検査対象が存在しない)」と出し、
// 秘匿情報の検査(基準7)は対象なしを認めないのでそう出さない。出荷ごとの継続は IMPL-0993(test-unrun-streak.mjs)が固定する。
// 判定の時刻は記録していない(IMPL-0239 は降りていない規定のまま)
{
  const full = { effective: new Set(['test', 'static-analysis', 'secret-scan', 'ip-clearance']) };
  const adapter = { id: 'node', commands: { test: 'npm test', lint: 'npm run lint', audit: 'npm audit', licenses: 'npx license-checker', secretScan: 'npx secretlint' } };
  const st = (name, job) => machineCheckStatus({ adapter, hasTarget: false, aggregate: full, name, job, noRecord: '記録なし' });
  for (const [name, job] of [['test', 'test'], ['lint', 'static-analysis'], ['audit', 'static-analysis'], ['licenses', 'ip-clearance']]) {
    check(`項目4: 製品のコードが無ければ ${name} は「未実施(検査対象が存在しない)」`, st(name, job) === '未実施(検査対象が存在しない)', st(name, job));
  }
  check('項目4: 製品のコードが無くても秘匿情報の検査は「検査対象が存在しない」と出さない', /^実施/.test(st('secretScan', 'secret-scan')), st('secretScan', 'secret-scan'));
}

// 9c. 依存の取得の失敗が黙って続かない(process-compass #330 T-7)。setup-stack の install の段に continue-on-error を置かない。
// 検査器(npm audit・license-checker 等)が入力の欠落で失敗するかは道具の実装で、ここでは保証しない(降ろさないと決めた)
{
  const setup = fs.readFileSync(path.join(ROOT, '.github/actions/setup-stack/action.yml'), 'utf8');
  const step = setup.split(/\r?\n/).join('\n').split(/\n    - name: /).find((b) => b.includes('adapter.mjs run install')) ?? '';
  check('setup-stack: 依存の取得の段(adapter.mjs run install)がある', step.length > 0);
  check('setup-stack: 依存の取得の段に continue-on-error を置かない(失敗が黙って続かない)', step.length > 0 && !/continue-on-error/.test(step), step);
}

// 9d. 段 mutation・regulatory が needs にあり、集約が success を確かめる(process-compass #326 項目9 b・c。ADR-0224 決定8)
const wfLf = wf.replace(/\r\n/g, '\n');
const aggBody = jobsOf(wf).get('gate-g5');
{
  const checked = successCheckedJobs(aggBody);
  check('success を確かめるジョブに mutation・regulatory が入る', checked.has('mutation') && checked.has('regulatory'), [...checked].join(','));
  check('success を確かめるジョブは基準・規則のジョブ 10 件', checked.size === 10, [...checked].join(','));
  // 陰性: needs から段を外す
  for (const job of ['mutation', 'regulatory']) {
    const cut = wf.replace(NEEDS, NEEDS.replace(`, ${job}`, ''));
    const f = aggregateFindings(cut);
    check(`needs から ${job} を外すと不備が出る`, f.problems.some((x) => x.includes(`"${job}"`) && /needs にありません/.test(x)), f.problems.join(' / '));
  }
  // 陰性: success を確かめる組を落とす(env の変数は残す)
  const noPair = wf.replace(/ "mutation:\$R_MUTATION"/, '');
  const f1 = aggregateFindings(noPair);
  check('手順の組から mutation を落とすと「success を確かめていません」の不備が出る', noPair !== wf && f1.problems.some((x) => /"mutation".*success/.test(x)), f1.problems.join(' / '));
  // 陰性: success でなければ失敗にする行を外す
  const noSucc = wf.replace(/\[ "\$res" = "success" \] && continue/, 'true');
  const f2 = aggregateFindings(noSucc);
  check('success を求める行を外すと、全ジョブで不備が出る', noSucc !== wf && f2.problems.filter((x) => /success であることを/.test(x)).length === 10, f2.problems.join(' / '));
  // 陰性: 変数が別のジョブの結果を指している(式の取り違え)
  const swapped = wf.replace('R_MUTATION: ${{ needs.mutation.result }}', 'R_MUTATION: ${{ needs.test.result }}');
  const f3 = aggregateFindings(swapped);
  check('変数が別のジョブの結果を指すと mutation の不備が出る', swapped !== wf && f3.problems.some((x) => /"mutation".*success/.test(x)), f3.problems.join(' / '));
}

// 9e. 集約の手順のシェルを実際に流す(skipped・failure・cancelled・success の場面)
{
  const m = wfLf.match(/\n {2}gate-g5:\n[\s\S]*?\n {8}run: \|\n([\s\S]*)$/);
  const script = m ? m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n') : '';
  check('集約の手順の本文を取り出せる', script.includes('G-5 通過'));
  const names = { contract: 'R_CONTRACT', test: 'R_TEST', 'static-analysis': 'R_STATIC', 'spec-lint': 'R_SPEC', 'context-format': 'R_CTX', 'ip-clearance': 'R_IP', 'secret-scan': 'R_SECRET', 'pr-rules': 'R_PR', mutation: 'R_MUTATION', regulatory: 'R_REGULATORY' };
  const run = ({ configured = 'true', event = 'pull_request', over = {} } = {}) => {
    const env = { ...process.env, CONFIGURED: configured, EVENT: event, ANY_BAD: 'false' };
    for (const [job, v] of Object.entries(names)) env[v] = 'success';
    for (const [job, res] of Object.entries(over)) {
      env[names[job]] = res;
      if (res === 'failure' || res === 'cancelled') env.ANY_BAD = 'true'; // GitHub の式が与える値を模す
    }
    const r = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  if (spawnSync('bash', ['-c', 'true']).status !== 0) {
    check('bash が使えない環境のため、集約の手順の実行は試験しない', false, 'bash を用意して再実行');
  } else {
    check('全ジョブが success なら通る', run().code === 0);
    for (const job of ['mutation', 'regulatory', 'test', 'secret-scan', 'contract']) {
      const r = run({ over: { [job]: 'skipped' } });
      check(`構成済みで ${job} が skipped なら落ちる`, r.code === 1 && r.out.includes(`検査 ${job} の結果が skipped`), r.out);
    }
    for (const res of ['failure', 'cancelled']) {
      check(`mutation が ${res} なら落ちる`, run({ over: { mutation: res } }).code === 1);
      check(`regulatory が ${res} なら落ちる`, run({ over: { regulatory: res } }).code === 1);
    }
    check('pr-rules は PR 以外の契機で skipped でも通る', run({ event: 'push', over: { 'pr-rules': 'skipped' } }).code === 0);
    check('pr-rules は PR の契機で skipped なら落ちる', run({ event: 'pull_request', over: { 'pr-rules': 'skipped' } }).code === 1);
    check('push の契機でも mutation が skipped なら落ちる(例外は pr-rules だけ)', run({ event: 'push', over: { mutation: 'skipped' } }).code === 1);
    check('構成が未設定なら、全ジョブが skipped でも警告で通る', run({ configured: 'false', over: Object.fromEntries(Object.keys(names).map((j) => [j, 'skipped'])) }).code === 0);
  }
}

// 9b. 段のジョブの中身の結線(束 B28 の独立の突合 H-2・M-4)。ジョブ mutation・regulatory が adapter.mjs を呼び、
// 判定の入力(経路・比較の起点・PR の本文・基底の構成)を渡し、全履歴を取得することを、値の一致で固定する。
// 字面の `if: false` などは固定しない(実行時は集約の success の検査が止める。b26 の裁定 2.4)
{
  const lf = wf.replace(/\r\n/g, '\n');
  const jobBlock = (text, job) => {
    const m = new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|\\n[A-Za-z]|$)`).exec(text);
    return m ? m[1] : null;
  };
  const stageProblems = (text, job) => {
    const b = jobBlock(text, job);
    if (b === null) return [`ジョブ ${job} がありません`];
    const out = [];
    if (!/^ {8}run: node scripts\/gate\/adapter\.mjs run ([a-z]+)$/m.test(b) || /run: node scripts\/gate\/adapter\.mjs run ([a-z]+)/.exec(b)[1] !== job) out.push(`手順が adapter.mjs run ${job} を呼びません`);
    if (!/uses: actions\/checkout@v4\n {8}with:\n {10}fetch-depth: 0\n/.test(b)) out.push('checkout が fetch-depth: 0 ではありません');
    if (job === 'mutation') {
      if (!/^ {10}PIT_IN_PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}$/m.test(b)) out.push('PIT_IN_PR_BODY が PR の本文のペイロードを渡していません');
      if (!b.includes('echo "PIT_IN_EVENT=${EVENT_NAME}" >> "$GITHUB_ENV"')) out.push('PIT_IN_EVENT を渡していません');
      if (!b.includes('EVENT_NAME: ${{ github.event_name }}')) out.push('EVENT_NAME が github.event_name ではありません');
      if (!b.includes('echo "PIT_IN_DIFF_BASE=${base}" >> "$GITHUB_ENV"')) out.push('PIT_IN_DIFF_BASE を渡していません');
      if (!b.includes('echo "PIT_IN_BASE_CONFIG=${RUNNER_TEMP}/base-process.config.json" >> "$GITHUB_ENV"')) out.push('PIT_IN_BASE_CONFIG を渡していません');
      if (!b.includes('git show "${base}:process.config.json" > "${RUNNER_TEMP}/base-process.config.json"')) out.push('基底の process.config.json を書き出していません');
      if (!b.includes('base="origin/${BASE_REF}"')) out.push('PR の比較の起点が基底ブランチではありません');
    }
    return out;
  };
  for (const job of ['mutation', 'regulatory']) {
    const ps = stageProblems(lf, job);
    check(`IMPL-0930:ok ジョブ ${job} は adapter.mjs run ${job} を呼び、全履歴を取得する${job === 'mutation' ? '(経路・比較の起点・PR の本文・基底の構成も渡す)' : ''}`, ps.length === 0, ps.join(' / '));
  }
  const mut = (from, to) => lf.replace(from, to);
  check('IMPL-0930:ng 段 mutation の呼び出しを `run: "true"` へ替えると不備が出る', stageProblems(mut('run: node scripts/gate/adapter.mjs run mutation', 'run: "true"'), 'mutation').some((p) => /adapter\.mjs run mutation を呼びません/.test(p)));
  check('IMPL-0836:ng 段 regulatory の呼び出しを `run: "true"` へ替えると不備が出る', stageProblems(mut('run: node scripts/gate/adapter.mjs run regulatory', 'run: "true"'), 'regulatory').some((p) => /adapter\.mjs run regulatory を呼びません/.test(p)));
  check('IMPL-0930:ng 段 mutation が別の段(regulatory)を呼ぶ形も不備にする', stageProblems(mut('run: node scripts/gate/adapter.mjs run mutation', 'run: node scripts/gate/adapter.mjs run regulatory'), 'mutation').length > 0);
  check('IMPL-0930:ng 基底の構成の書き出しを外すと不備が出る(M-4)', stageProblems(mut('echo "PIT_IN_BASE_CONFIG=${RUNNER_TEMP}/base-process.config.json" >> "$GITHUB_ENV"', 'true'), 'mutation').some((p) => /PIT_IN_BASE_CONFIG/.test(p)));
  check('IMPL-0930:ng PR の本文を渡さないと不備が出る', stageProblems(mut('PIT_IN_PR_BODY: ${{ github.event.pull_request.body }}', 'PIT_IN_PR_BODY: ""'), 'mutation').some((p) => /PIT_IN_PR_BODY/.test(p)));
  check('IMPL-0930:ng 経路・比較の起点を渡さないと不備が出る', stageProblems(mut('echo "PIT_IN_EVENT=${EVENT_NAME}" >> "$GITHUB_ENV"', 'true'), 'mutation').some((p) => /PIT_IN_EVENT/.test(p)) && stageProblems(mut('echo "PIT_IN_DIFF_BASE=${base}" >> "$GITHUB_ENV"', 'true'), 'mutation').some((p) => /PIT_IN_DIFF_BASE/.test(p)));
  check('IMPL-0930:ng 浅い取得(fetch-depth を外す)にすると不備が出る', stageProblems(mut(/(  mutation:[\s\S]*?)fetch-depth: 0/.exec(lf)[0], /(  mutation:[\s\S]*?)fetch-depth: 0/.exec(lf)[0].replace('fetch-depth: 0', 'fetch-depth: 1')), 'mutation').some((p) => /fetch-depth/.test(p)));
}

// 10. ワークフロー: contract でこの試験を実行する
check('ワークフロー: contract で、この試験を実行する', /node scripts\/gate\/test-g5-aggregate\.mjs/.test(wf));

console.log('');
if (failures) {
  console.log(`集約の検査の試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`集約の検査の試験: ${checks} 件が期待と一致しました`);
