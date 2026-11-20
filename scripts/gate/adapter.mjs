// アダプタのコマンドを実行する。
//
//   node scripts/gate/adapter.mjs run <phase>     コマンドを実行する
//   node scripts/gate/adapter.mjs print <phase>   コマンドを表示するだけ
//   node scripts/gate/adapter.mjs runtime         セットアップに要る実行環境を JSON で出す
//
// phase: install / test / coverage / lint / audit / licenses / secretScan
//
// コマンドが空の場合の扱いは、段で分ける(標準 第4章 G-5「構成で選んだ未実施」、ADR-0151。process-compass #330 T-3)。
//   - 任意の段(lint・audit・licenses・install)が空: 実施せず終了コード 0 で通す。この事実は証跡へ残る(保証の開示 項目4 が
//     「未実施(コマンドが未設定)」と継続期間を出す)。通過と取り違えさせないのは、項目4 の表示と、ライセンス検査の記録(license-scan-record.mjs)の役目
//   - 必須の段(test・secretScan)が空: 失敗させる。「検査したことにする」経路を作らないため
//   - coverage は任意の検査ではないが、このアダプタは空を通す(ADR-0151 決定1)。失敗にするのは coverage-check.mjs(基準3)で、test-coverage-scope.mjs が固定している
//
// 対象の扱い(標準 第4章 G-5「検査対象が存在しない場合の扱い」。process-compass #363):
//   - 秘匿情報の検査(secretScan。基準7)は、製品のコードの有無に依らず、リポジトリの直下で実行する。対象なしを認めない
//   - ほかの段は、アダプタの projectDir(製品のコードの所在。既定は直下)で実行する。所在に目印が無ければ「対象なし」として通す。
//     ただし、目印が下の階層にあれば、製品のコードがあるため対象なしにせず失敗させる
//   - コマンドの中の {root} は、リポジトリの直下の絶対パスに置き換える(所在の下からテンプレートのスクリプトを呼ぶため)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadAdapter, ROOT, fail, notice, targetState, nestedTargetProblem, ALWAYS_PHASES, localDay } from './config.mjs';
import { effectiveAllowedLicenses } from './license-allowlist.mjs';
import { decideStage, evaluateMutation } from './mutation-stage.mjs';

const [, , mode, phase] = process.argv;
const config = loadConfig();
const adapter = loadAdapter(config);

if (mode === 'runtime') {
  process.stdout.write(
    JSON.stringify({
      stack: adapter.id,
      runtime: adapter.runtime,
      runtimeVersion: adapter.runtimeVersion,
    })
  );
  process.exit(0);
}

if (!phase) {
  console.error('使い方: node scripts/gate/adapter.mjs <run|print|runtime> [phase]');
  process.exit(2);
}

// 段 mutation・regulatory は、キーが無いことを空と同じに扱う(既存の採用者のアダプタは持たない。必須かは下で判定する)
const STAGE_PHASES = new Set(['mutation', 'regulatory']);
const rawCmd = (adapter.commands ?? {})[phase];
const cmd = STAGE_PHASES.has(phase) && rawCmd === undefined ? '' : rawCmd;

if (cmd === undefined) {
  fail(`アダプタ ${adapter.id} に phase "${phase}" の定義がありません`);
  process.exit(2);
}

const always = ALWAYS_PHASES.has(phase);
let state;
try {
  state = targetState(adapter);
} catch (e) {
  fail(e.message);
  process.exit(1);
}

if (!always && !state.present) {
  const nested = nestedTargetProblem(adapter, state);
  if (nested) {
    fail(nested);
    process.exit(1);
  }
  notice(`アダプタ ${adapter.id}: プロジェクト対象が存在しないため、"${phase}" は実施しません。この事実は証跡へ残ります`);
  process.exit(0);
}

// 任意の検査は空でも通す。必須の検査は空を許さない
const OPTIONAL = new Set(['lint', 'audit', 'licenses', 'coverage', 'install']);

const stage = STAGE_PHASES.has(phase) ? decideStage({ phase, config }) : null;

if (!cmd.trim()) {
  if (stage) {
    // 必須の段が空なら失敗。必須でなければ注意で通す(標準 附属書F F.6・附属書H H.1。ADR-0244)
    if (stage.required) {
      fail(
        `アダプタ ${adapter.id} の "${phase}" が空です(必須の理由: ${stage.reasons.join('、')})。adapters/${adapter.id}.json の commands.${phase} へ実行コマンドを書いてください。` +
          (phase === 'mutation'
            ? '道具の無い言語では、外部で実行した記録を照らすコマンドを置けます。どちらも `mutation-result: score=<数値|none> survivors=<所在>` の行を出します。段が空のままの通過に、第7章 7.3 の例外承認は使えません'
            : '空のまま通すと、検査を実施していない状態を通過した記録として残ります')
      );
      process.exit(1);
    }
    notice(
      `アダプタ ${adapter.id}: "${phase}" のコマンドが空のため実施しません(この変更では必須ではありません)。この事実は証跡へ残ります` +
        (phase === 'mutation' ? '。R1 の変更の PR では、この段が空だと G-5 が失敗します' : '')
    );
    if (stage.q1Unreadable) notice('附属書F F.2 の Q1 の記録を読めないため、案件の条件では必須にしていません(D-0 の記入は check-d0 と出荷の集約が止めます)');
    process.exit(0);
  }
  if (OPTIONAL.has(phase)) {
    notice(`アダプタ ${adapter.id}: "${phase}" のコマンドが空のため実施しません。この事実は証跡へ残ります`);
    process.exit(0);
  }
  fail(
    `アダプタ ${adapter.id} の "${phase}" が空です。adapters/${adapter.id}.json へ実行コマンドを書いてください。` +
      '空のまま通すと、検査を実施していない状態を通過した記録として残ります'
  );
  process.exit(1);
}

// secretlint の設定が無いと、secretlint は英語の「config is not found」だけを出して落ちる。何をすればよいかを先に出す。
// 旧い初期化は undetermined・none で設定を作らなかったため、更新の後に落ちる採用者がいる(process-compass #363 の突合 X-3)。
// 落ちる向きは変えない(基準7 は対象なしを認めない)
if (phase === 'secretScan' && /\bsecretlint\b/.test(cmd) && !fs.readdirSync(ROOT).some((f) => /^\.secretlintrc(\..+)?$/.test(f))) {
  fail(
    '秘匿情報の検査の設定(.secretlintrc.json)がリポジトリの直下にありません。秘匿情報の検査は、製品のコードの有無やスタックの確定に依らず実行します(第4章 G-5 基準7 は「対象なし」を認めません)。' +
      '`node scripts/init/generate-profile.mjs --scaffold` を実行すると、無いファイルだけを作ります(既存のファイルは書き換えません)。作った設定は、統制の設定の初回の設定として PR で取り込みます'
  );
  process.exit(1);
}

const rootPosix = ROOT.replace(/\\/g, '/');
const command = cmd.replaceAll('{root}', rootPosix);

if (mode === 'print') {
  process.stdout.write(command);
  process.exit(0);
}

// 構成 ci.failOnSeverity を、アダプタの audit コマンドへ渡す(#295 T-19)。npm audit は最小の重大度を取るため、
// 失敗させる重大度のうち最も低いものを渡す(critical・high なら high)。値が無ければ high
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, medium: 2, high: 3, critical: 4 };
const failLevels = (Array.isArray(config.ci?.failOnSeverity) ? config.ci.failOnSeverity : ['critical', 'high']).map((s) => String(s).toLowerCase()).filter((s) => s in SEVERITY_RANK);
const auditLevel = failLevels.length ? failLevels.reduce((a, b) => (SEVERITY_RANK[b] < SEVERITY_RANK[a] ? b : a)) : 'high';

const cwd = always ? ROOT : path.join(ROOT, state.dir);
const env = {
  ...process.env,
  PIT_IN_FAIL_ON_SEVERITY: failLevels.join(';'),
  PIT_IN_AUDIT_LEVEL: auditLevel === 'medium' ? 'moderate' : auditLevel,
  // 恒久の一覧に、期限の内の暫定の許可を足した一覧(license-allowlist.mjs。期限を過ぎた許可は入らない。IMPL-0683)
  PIT_IN_ALLOWED_LICENSES: effectiveAllowedLicenses(config, localDay()).allowed.join(';'),
  // 値の有無は coverage-check と契約検査が確かめて落とす。ここは子の検査器へ渡すだけ(#337 項目2)
  PIT_IN_COVERAGE_THRESHOLD: String(config.ci?.coverageThreshold ?? 80),
  PIT_IN_ROOT: rootPosix,
  PIT_IN_PROJECT_DIR: cwd.replace(/\\/g, '/'),
};
// uv は PATH の python と別の版を選びうる。アダプタの runtimeVersion の python を使わせる(既に指定があれば変えない。
// process-compass #363 の突合 X-4)
if (adapter.runtime === 'python' && adapter.runtimeVersion && !process.env.UV_PYTHON) env.UV_PYTHON = String(adapter.runtimeVersion);

// 段 mutation は、必須でない変更(案件の条件にも R1 にも当たらない)ではコマンドを走らせず、注意で通す。
// 附属書H H.1: R2 は週次の定期実行で合否条件にしない、R3 は任意。コマンドを書いたことで全ての PR の合否条件にしない(束 B28 の突合 H-1)
if (phase === 'mutation' && stage && !stage.required) {
  notice(`アダプタ ${adapter.id}: "mutation" のコマンドはこの変更では必須ではありません。走らせません(R1 の変更の PR と、案件の条件に当たる構成では走らせます)。この事実は証跡へ残ります`);
  if (stage.q1Unreadable) notice('附属書F F.2 の Q1 の記録を読めないため、案件の条件では必須にしていません(D-0 の記入は check-d0 と出荷の集約が止めます)');
  process.exit(0);
}

if (!always && state.dir !== '.') console.log(`(所在: ${state.dir})`);
if (always && !state.present) console.log(`(製品のコードの有無に依らず実施する検査です。リポジトリの直下で実行します)`);
console.log(`$ ${command}`);
if (phase === 'mutation') {
  // 閾値(基底ブランチの構成から。無ければ渡さない)と比較の起点をコマンドへ渡す。出力の約束は mutation-stage.mjs
  if (stage.threshold !== undefined) env.PIT_IN_MUTATION_THRESHOLD = String(stage.threshold);
  if (stage.reasons.length) console.log(`(必須の理由: ${stage.reasons.join('、')})`);
  const m = spawnSync(command, { shell: true, stdio: ['inherit', 'pipe', 'inherit'], cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(m.stdout ?? '');
  if ((m.status ?? 1) !== 0) process.exit(m.status ?? 1);
  const ev = evaluateMutation({ out: m.stdout ?? '', stage });
  for (const x of ev.messages) (x.level === 'error' ? fail : notice)(x.text);
  process.exit(ev.ok ? 0 : 1);
}
const r = spawnSync(command, { shell: true, stdio: 'inherit', cwd, env });
process.exit(r.status ?? 1);
