// アダプタの対象の扱いを、一時のリポジトリで試験する(標準 第4章 G-5「検査対象が存在しない場合の扱い」。process-compass #363)。
//
//   node scripts/gate/test-adapter.mjs
//
// 確かめること:
//   - 秘匿情報の検査(secretScan。基準7)は、製品のコードが無くても実行される(node・python・go・undetermined・none・
//     python-poetry・python-uv)。検査が落ちれば G-5 の段も落ちる。「対象なし」で通さない(#363 の欠陥①の再現)
//   - 目印がリポジトリの直下に無く下の階層にある(services/api/pyproject.toml・web/package.json)と、install・test・coverage・lint は
//     「対象なし」で通らず失敗する。アダプタの projectDir に所在を書くと、そこでコマンドを実行する(#363 の欠陥②)
//   - 目印がどこにも無ければ、従来どおり「対象なし」で通す(基準1・2・3・5・8 は対象なしを認める)
//   - projectDir は直下の外を指せない。カバレッジの集計ファイルは所在の下から読む
//   - python の依存の取得(python-install.mjs)の入れ方の決め方(build-system の有無、extras dev・PEP 735 の群、poetry の群)
//   - 保証の開示 項目4 は、秘匿情報の検査を「検査対象が存在しない」と出さない
//
// 検査の道具(npx・python)は PATH の先頭に置いた代役で置き換える(ネットワークを使わない)。代役は、呼ばれた所在に印を書き、
// 環境変数 FAKE_EXIT の終了コードで終わる。

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { planInstall } from './python-install.mjs';
import { machineCheckStatus } from './g5-aggregate.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
}

const dirs = [];
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-adapter-bin-'));
dirs.push(BIN);
// 代役: 呼ばれた所在(作業ディレクトリ)に .fake-<名> を書き、FAKE_EXIT で終わる
for (const name of ['npx', 'python', 'poetry', 'uv']) {
  // 環境変数 UV_PYTHON も印に書く(python-uv が runtimeVersion の python を使うか。突合 X-4)
  fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\necho "$@" > ".fake-${name}"\necho "UV_PYTHON=$UV_PYTHON" >> ".fake-${name}"\necho "ALLOWED=$PIT_IN_ALLOWED_LICENSES" >> ".fake-${name}"\nexit \${FAKE_EXIT:-0}\n`);
  fs.chmodSync(path.join(BIN, name), 0o755);
  fs.writeFileSync(path.join(BIN, `${name}.cmd`), `@echo off\r\necho %* > ".fake-${name}"\r\necho UV_PYTHON=%UV_PYTHON%>> ".fake-${name}"\r\necho ALLOWED=%PIT_IN_ALLOWED_LICENSES%>> ".fake-${name}"\r\nif "%FAKE_EXIT%"=="" exit /b 0\r\nexit /b %FAKE_EXIT%\r\n`);
}

const SECRETLINT_RC = '{ "rules": [{ "id": "@secretlint/secretlint-rule-preset-recommend" }] }\n';
// 既定では秘匿情報の検査の設定を置く(初期化が作る)。noRc で置かない場合を試す
function workspace(stack, files = {}, adapterPatch = null, { noRc = false } = {}) {
  if (!noRc && !('.secretlintrc.json' in files)) files = { '.secretlintrc.json': SECRETLINT_RC, ...files };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pit-in-adapter-${stack}-`));
  dirs.push(dir);
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'adapters'), path.join(dir, 'adapters'), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'process.config.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify({ ...cfg, adapters: { ...(cfg.adapters ?? {}), stack } }, null, 2));
  if (adapterPatch) {
    const p = path.join(dir, 'adapters', `${stack}.json`);
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), ...adapterPatch }, null, 2));
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const run = (script, args, exit = '0', extraEnv = {}) => {
    const r = spawnSync(process.execPath, [path.join(dir, script), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_EXIT: exit, ...extraEnv },
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { dir, run, adapter: (phase, exit, extraEnv = {}) => run('scripts/gate/adapter.mjs', ['run', phase], exit, extraEnv), ran: (rel, name) => fs.existsSync(path.join(dir, rel, `.fake-${name}`)) };
}

// ---------------------------------------------------------------- 1. 秘匿情報の検査は対象なしで通さない(欠陥①)
// 製品のコードの無いリポジトリ(テンプレートだけ)で、アダプタを切り替えて secretScan を実行する。修正の前は、4つのアダプタ
// (node・python・go・undetermined)で「プロジェクト対象が存在しないため実施しません」として終了コード 0 で通っていた
for (const stack of ['node', 'python', 'go', 'undetermined', 'none', 'python-poetry', 'python-uv']) {
  const W = workspace(stack);
  // IMPL-0474:ng(違反と適合の対。標準の実装マーク。process-compass #363)
  const ng = W.adapter('secretScan', '3');
  check(`${stack}: 製品のコードが無くても秘匿情報の検査を実行し、検査が落ちれば段も落ちる`, ng.code === 3 && W.ran('.', 'npx') && !/実施しません/.test(ng.out), ng.out);
  // IMPL-0474:ok(違反と適合の対。標準の実装マーク。process-compass #363)
  const ok = W.adapter('secretScan', '0');
  check(`${stack}: 製品のコードが無く、秘匿情報の検査が通れば段も通る`, ok.code === 0 && W.ran('.', 'npx'), ok.out);
  if (stack !== 'undetermined' && stack !== 'none') {
    const t = W.adapter('test', '0');
    check(`${stack}: 目印がどこにも無ければ、test は従来どおり対象なしで通す`, t.code === 0 && /対象が存在しないため/.test(t.out), t.out);
  }
}
{
  // 製品のコードが下の階層にあるのに python アダプタを選んだ場合(調査 5.4)も、秘匿情報の検査は走る
  const W = workspace('python', { 'services/api/pyproject.toml': '[project]\nname = "api"\n' });
  const r = W.adapter('secretScan', '3');
  check('python: 製品のコードが下の階層にあっても、秘匿情報の検査はリポジトリの直下で実行する', r.code === 3 && W.ran('.', 'npx') && !W.ran('services/api', 'npx'), r.out);
}

// ---------------------------------------------------------------- 2. 下の階層の製品のコードを対象なしにしない(欠陥②)
{
  const files = { 'services/api/pyproject.toml': '[project]\nname = "api"\n', 'services/api/api/handler.py': 'def h(x):\n    return x\n' };
  const W = workspace('python', files);
  // IMPL-0475:ng(違反と適合の対。標準の実装マーク。process-compass #363)
  for (const phase of ['install', 'test', 'coverage', 'lint']) {
    const r = W.adapter(phase, '0');
    check(`python: 目印が下の階層(services/api)にだけあると、${phase} を対象なしで通さず失敗させる`, r.code === 1 && /services\/api\/pyproject\.toml/.test(r.out) && /projectDir/.test(r.out) && !W.ran('.', 'python'), r.out);
  }
  const cc = W.run('scripts/gate/coverage-check.mjs', []);
  check('python: カバレッジの判定も、目印が下の階層にだけあると未実施として通さない', cc.code === 1 && /下の階層/.test(cc.out), cc.out);

  // IMPL-0475:ok(違反と適合の対。標準の実装マーク。process-compass #363)
  const P = workspace('python', { ...files, 'services/api/coverage.json': JSON.stringify({ meta: { format: 3 }, files: { 'api/handler.py': { executed_lines: [1, 2, 3, 4, 5, 6, 7, 8, 9], missing_lines: [10], excluded_lines: [] } }, totals: { percent_covered: 90, num_statements: 10 } }) }, { projectDir: 'services/api' });
  const t = P.adapter('test', '0');
  check('python: projectDir に所在を書くと、test をそこで実行する', t.code === 0 && P.ran('services/api', 'python') && !P.ran('.', 'python'), t.out);
  const tf = P.adapter('test', '1');
  check('python: projectDir の下のテストが落ちれば、test の段も落ちる', tf.code === 1, tf.out);
  const s = P.adapter('secretScan', '0');
  check('python: projectDir を書いても、秘匿情報の検査はリポジトリの直下で実行する', s.code === 0 && P.ran('.', 'npx') && !P.ran('services/api', 'npx'), s.out);
  const lic = P.run('scripts/gate/adapter.mjs', ['print', 'licenses']);
  check('python: コマンドの {root} をリポジトリの直下の絶対パスに置き換える', lic.code === 0 && lic.out.includes(`${P.dir.replace(/\\/g, '/')}/scripts/gate/ip-clearance-python.mjs`) && !lic.out.includes('{root}'), lic.out);
  const cov = P.run('scripts/gate/coverage-check.mjs', []);
  check('python: カバレッジの集計ファイルを所在(services/api)の下から読む', cov.code === 0 && /90/.test(cov.out), cov.out);
}
{
  const W = workspace('node', { 'web/package.json': '{ "name": "web" }\n' });
  const r = W.adapter('test', '0');
  check('node: package.json が下の階層(web)にだけあると、test を対象なしで通さず失敗させる', r.code === 1 && /web\/package\.json/.test(r.out), r.out);
  const N = workspace('node', { 'web/package.json': '{ "name": "web" }\n' }, { projectDir: 'web' });
  const t = N.adapter('test', '0');
  check('node: projectDir に所在を書くと、そこでコマンドを実行する(代役の npx は呼ばれず、npm test の結果に依る)', t.code !== null && !/対象が存在しないため/.test(t.out) && !/下の階層/.test(t.out), t.out);
}
{
  const W = workspace('go', { 'cmd/svc/go.mod': 'module x\n' });
  const r = W.adapter('lint', '0');
  check('go: go.mod が下の階層にだけあると、lint を対象なしで通さず失敗させる', r.code === 1 && /cmd\/svc\/go\.mod/.test(r.out), r.out);
}
{
  const W = workspace('python', { 'node_modules/x/pyproject.toml': '[project]\nname = "x"\n', '.venv/lib/pyproject.toml': '' });
  const r = W.adapter('test', '0');
  check('python: 依存の置き場(node_modules・.venv)の中の目印は、製品のコードに数えない', r.code === 0 && /対象が存在しないため/.test(r.out), r.out);
}
for (const bad of ['../outside', '/abs/path']) {
  const W = workspace('python', {}, { projectDir: bad });
  const r = W.adapter('test', '0');
  check(`projectDir "${bad}" は直下の外を指すため失敗させる`, r.code === 1 && /直下の外|相対のパス/.test(r.out), r.out);
}
// projectDir の書き誤り(突合 X-1)。所在のディレクトリが無ければ、目印が直下にあっても失敗させる
{
  // IMPL-0475:ng(違反と適合の対。標準の実装マーク。process-compass #363 の突合 X-1)
  const W = workspace('python', { 'pyproject.toml': '[project]\nname = "a"\n' }, { projectDir: 'srv' });
  for (const phase of ['test', 'install']) {
    const r = W.adapter(phase, '0');
    check(`python: projectDir "srv" が無いディレクトリなら、目印が直下にあっても ${phase} を対象なしにせず失敗させる`, r.code === 1 && /projectDir "srv" のディレクトリがありません/.test(r.out) && !W.ran('.', 'python'), r.out);
  }
  const cc = W.run('scripts/gate/coverage-check.mjs', []);
  check('python: projectDir が無いディレクトリなら、カバレッジの判定も未実施にせず失敗させる', cc.code === 1 && /ディレクトリがありません/.test(cc.out), cc.out);
  // 契約検査が落ちることは、構成を設定した複製で test-init-g5.mjs が確かめる
  // 所在のディレクトリはあるが目印が無く、目印が直下にある
  const D = workspace('python', { 'pyproject.toml': '[project]\nname = "a"\n', 'srv/x.py': 'x = 1\n' }, { projectDir: 'srv' });
  const r = D.adapter('test', '0');
  check('python: 所在(srv)に目印が無く直下にあれば、直下の目印を所在の外の目印として数え、失敗させる', r.code === 1 && /pyproject\.toml/.test(r.out) && /所在の外/.test(r.out), r.out);
}
// 旧い構成で秘匿情報の検査の設定が無い(突合 X-3)
for (const stack of ['undetermined', 'none', 'node']) {
  const W = workspace(stack, {}, null, { noRc: true });
  const r = W.adapter('secretScan', '0');
  check(`${stack}: .secretlintrc.json が無ければ、秘匿情報の検査を落とし、--scaffold で作れることを日本語で出す`, r.code === 1 && /\.secretlintrc\.json/.test(r.out) && /--scaffold/.test(r.out) && !W.ran('.', 'npx'), r.out);
}
// python-uv は runtimeVersion の python を uv に使わせる(突合 X-4)
{
  const W = workspace('python-uv', { 'pyproject.toml': '[project]\nname = "a"\n' });
  W.adapter('test', '0');
  const mark = path.join(W.dir, '.fake-uv');
  const text = fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '';
  check('python-uv: uv に UV_PYTHON=runtimeVersion(3.12)を渡す', /UV_PYTHON=3\.12/.test(text), text);
}

// ---------------------------------------------------------------- 3. python の依存の取得の入れ方(python アダプタ)
{
  const withBuild = planInstall({ project: { name: 'a', 'optional-dependencies': { dev: ['pytest'] } }, 'build-system': { requires: ['setuptools'] } });
  check('python-install: build-system と extras dev があれば editable で .[dev] を入れる', !withBuild.problem && withBuild.steps.length === 1 && withBuild.steps[0][0].join(' ') === '-m pip install -e .[dev]');
  const uvShape = planInstall({ project: { name: 'a', dependencies: ['requests'] }, 'dependency-groups': { dev: ['pytest', 'pytest-cov'] } });
  const uvArgs = uvShape.steps.map((s) => s[0].join(' '));
  check(
    'python-install: build-system が無い形(uv の既定)は、組まずに宣言した依存と PEP 735 の群 dev を入れる(setuptools の自動の検出に頼らない)',
    !uvShape.problem && uvArgs.length === 2 && uvArgs[0] === '-m pip install requests' && uvArgs[1] === '-m pip install --group dev' && !uvArgs.some((a) => / -e /.test(` ${a} `)),
    JSON.stringify(uvArgs)
  );
  const poetry = planInstall({ tool: { poetry: { group: { dev: { dependencies: { pytest: '*' } } } } }, 'build-system': {} });
  check('python-install: 開発用の依存が poetry の群にだけあれば失敗させ、python-poetry を案内する', poetry.problem && /python-poetry/.test(poetry.problem));
  const none = planInstall({ project: { name: 'a' }, 'build-system': {} });
  check('python-install: 開発用の依存が無ければ失敗させる(警告だけで通して、次の段で落とさない)', Boolean(none.problem) && /開発用の依存/.test(none.problem));
}
for (const id of ['python-poetry', 'python-uv']) {
  const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', `${id}.json`), 'utf8'));
  const lock = id === 'python-poetry' ? /poetry check --lock && poetry sync/ : /uv sync --locked/;
  check(`${id}: install はロックファイルどおりに入れ、ロックとの不一致で失敗する`, lock.test(a.commands.install));
  check(`${id}: thresholdFiles に pyproject.toml の閾値の表を持つ`, a.thresholdFiles.includes('pyproject.toml#tool.ruff') && a.thresholdFiles.includes('pyproject.toml#tool.coverage'));
}

// ---------------------------------------------------------------- 4. 保証の開示 項目4
{
  const adapter = { commands: { test: 'pytest', secretScan: 'npx secretlint' } };
  const aggregate = { effective: new Set(['test', 'secret-scan']) };
  const st = (name, job) => machineCheckStatus({ adapter, hasTarget: false, aggregate, name, job, noRecord: '記録なし' });
  check('項目4: 製品のコードが無くても、秘匿情報の検査を「検査対象が存在しない」と出さない', /^実施/.test(st('secretScan', 'secret-scan')), st('secretScan', 'secret-scan'));
  check('項目4: 製品のコードが無ければ、テストは従来どおり「検査対象が存在しない」', st('test', 'test') === '未実施(検査対象が存在しない)');
}

// ---------------------------------------------------------------- 5. 空のコマンドの扱い(標準 第4章 G-5「構成で選んだ未実施」、ADR-0151。process-compass #330 T-4 / IMPL-0992)
// 任意の段(lint・audit・licenses・install)が空なら実施せず通す(証跡へ残す)。必須の段(test・secretScan)が空なら失敗させる。
// coverage が空のときの失敗は coverage-check.mjs の側で、test-coverage-scope.mjs が固定している(ここでは足さない)
{
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'node.json'), 'utf8')).commands;
  const withCommands = (patch) => ({ commands: { ...base, ...patch } });
  const product = { 'package.json': '{ "name": "x" }\n' };
  for (const phase of ['lint', 'audit', 'licenses', 'install']) {
    const W = workspace('node', product, withCommands({ [phase]: '' }));
    // IMPL-0992:ok(適合側。構成で選んだ未実施は失敗にしない)
    const r = W.adapter(phase, '1');
    check(`IMPL-0992:ok node: ${phase} が空なら実施せず、終了コード 0 で通す(代役が失敗しても落ちない)`, r.code === 0 && /実施しません。この事実は証跡へ残ります/.test(r.out) && !W.ran('.', 'npx'), r.out);
  }
  for (const phase of ['test', 'secretScan']) {
    const W = workspace('node', product, withCommands({ [phase]: '' }));
    // IMPL-0992:ng(違反側。必須の段が空のまま通ることを許さない)
    const r = W.adapter(phase, '0');
    check(`IMPL-0992:ng node: ${phase} が空なら失敗させる`, r.code === 1 && /が空です/.test(r.out), r.out);
  }
  for (const phase of ['lint', 'audit', 'licenses']) {
    const W = workspace('node', product, withCommands({ [phase]: 'npx fake-tool' }));
    const r = W.adapter(phase, '1');
    check(`node: ${phase} のコマンドの終了コードを段へ伝える(失敗なら 1)`, r.code === 1 && W.ran('.', 'npx'), r.out);
    const ok = W.adapter(phase, '0');
    check(`node: ${phase} のコマンドが通れば段も通る`, ok.code === 0, ok.out);
  }
}

// ---------------------------------------------------------------- 6. 暫定のライセンスの許可(ci.provisionalLicenses。IMPL-0683。#447)
// 期限の内の暫定の許可だけが許可リストに入る。期限を過ぎた許可・必須の欄の欠けた許可は入らず、基準5 が再び止める
{
  const { effectiveAllowedLicenses, provisionalLicenseProblems } = await import('./license-allowlist.mjs');
  const perm = ['MIT', 'Apache-2.0'];
  const entry = (o = {}) => ({ license: 'GPL-3.0-only', expires: '2030-06-30', approvedBy: '法務 山田', reason: '移行の間だけ', ...o });
  const cfg = (list) => ({ ci: { allowedLicenses: perm, provisionalLicenses: list } });
  const eff = (list, day) => effectiveAllowedLicenses(cfg(list), day);
  // IMPL-0683:ng(違反側。期限を過ぎた許可・欄の欠けた許可が一覧へ入ることを許さない)
  check('IMPL-0683:ng 期限の翌日に、暫定の許可が一覧から外れる', !eff([entry()], '2030-07-01').allowed.includes('GPL-3.0-only') && eff([entry()], '2030-07-01').expired.length === 1);
  for (const k of ['license', 'expires', 'approvedBy', 'reason']) {
    const e = entry({ [k]: '' });
    check(`IMPL-0683:ng ${k} の欠けた暫定の許可は一覧へ入らず、検査が拒否する`, !eff([e], '2030-01-01').allowed.some((x) => x === 'GPL-3.0-only') && provisionalLicenseProblems(cfg([e])).length > 0, JSON.stringify(provisionalLicenseProblems(cfg([e]))));
  }
  check('IMPL-0683:ng 実在しない日付の期限を拒否する', provisionalLicenseProblems(cfg([entry({ expires: '2030-02-31' })])).length > 0);
  check('IMPL-0683:ng 暫定の許可は恒久の一覧 allowedLicenses へ混ざらない(設定の配列を書き換えない)', (() => { eff([entry()], '2030-01-01'); return perm.length === 2; })());
  check('IMPL-0683:ng アダプタを経ない Python の経路(ip-clearance-python.mjs)は暫定の許可を読まない(止める側に倒れる)', !/provisional/i.test(fs.readFileSync(path.join(ROOT, 'scripts/gate/ip-clearance-python.mjs'), 'utf8')));
  for (const [label, expires, want] of [['期限が過ぎた許可', '2000-01-01', false], ['期限の内の許可', '2999-12-31', true]]) {
    const W = workspace('node', { 'package.json': '{ "name": "x" }\n' });
    const p = path.join(W.dir, 'process.config.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    c.ci = { ...c.ci, provisionalLicenses: [entry({ expires })] };
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
    W.adapter('licenses', '0');
    const args = fs.existsSync(path.join(W.dir, '.fake-npx')) ? fs.readFileSync(path.join(W.dir, '.fake-npx'), 'utf8') : '';
    check(`${want ? 'IMPL-0683:ok' : 'IMPL-0683:ng'} node: ${label}は、検査器へ渡す許可リストに${want ? '入る' : '入らない'}`, args.includes('GPL-3.0-only') === want && args.includes('MIT'), args);
  }
  // IMPL-0683:ok(適合側)
  check('IMPL-0683:ok 期限の日までは一覧に入る', eff([entry()], '2030-06-30').allowed.includes('GPL-3.0-only') && eff([entry()], '2030-06-30').active.length === 1);
  check('IMPL-0683:ok 恒久の一覧は期限に依らず常に入る', ['2000-01-01', '2999-01-01'].every((d) => perm.every((l) => eff([entry()], d).allowed.includes(l))));
  check('IMPL-0683:ok 欄がそろった暫定の許可は検査を通る', provisionalLicenseProblems(cfg([entry()])).length === 0 && provisionalLicenseProblems({ ci: {} }).length === 0);
}

// ---------------------------------------------------------------- 7. 段 mutation・regulatory(附属書F F.6・附属書H H.1。ADR-0244。process-compass #445)
// 必須 =「案件の条件(Q1 が「はい」・CL3)」または「R1 の変更」。必須で空・キーなしなら失敗。出力の約束は
// `mutation-result: score=<数値|none> survivors=<所在>`。閾値は基底の構成から読み、設定があるときだけ合否に使う
{
  const baseCmds = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'node.json'), 'utf8')).commands;
  const { mutation: _m, regulatory: _r, ...withoutKeys } = baseCmds;
  const emit = (line) => `node -e "console.log('${line}')"`;
  const OKLINE = emit('mutation-result: score=90 survivors=reports/survivors.json');
  const product = { 'package.json': '{ "name": "x" }\n' };
  const R1BODY = '## リスク区分\n\nR1\n';
  const R2BODY = '## リスク区分\n\nR2\n';
  const sh = (W, ...a) => execFileSync('git', a, { cwd: W.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // 基底のコミットの後に、ファイルを足したコミットを作る。返す値は基底のコミット
  const change = (W, rel = 'src/a.js', msg = 'change') => {
    const base = sh(W, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.dirname(path.join(W.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(W.dir, rel), 'x = 1;\n');
    sh(W, 'add', '-A');
    sh(W, 'commit', '-q', '-m', msg);
    return base;
  };
  const cfgOf = (W) => JSON.parse(fs.readFileSync(path.join(W.dir, 'process.config.json'), 'utf8'));
  const baseCfg = (W, patch) => {
    const f = path.join(W.dir, 'base-config.json');
    fs.writeFileSync(f, JSON.stringify({ ...cfgOf(W), ...patch }));
    return f;
  };
  const setConfig = (W, patch) => fs.writeFileSync(path.join(W.dir, 'process.config.json'), JSON.stringify({ ...cfgOf(W), ...patch }, null, 2));
  const pr = (base, body, extra = {}) => ({ PIT_IN_EVENT: 'pull_request', PIT_IN_DIFF_BASE: base, PIT_IN_PR_BODY: body, ...extra });
  const mk = (mutation, { keyless = false } = {}) => workspace('node', product, { commands: keyless ? withoutKeys : { ...baseCmds, mutation } });
  const AUTH_FLOOR = { riskFloor: { rules: [{ id: 'auth', paths: ['src/auth/**'], floor: 'R1', why: '認証' }] } };

  // --- R1 の PR: 段が空・キーが無ければ失敗
  {
    const W = mk('');
    const base = change(W);
    const r = W.adapter('mutation', '0', pr(base, R1BODY));
    check('IMPL-1029:ng R1 の PR で mutation が空なら G-5 の段を失敗させる', r.code === 1 && /"mutation" が空です/.test(r.out) && /R1/.test(r.out) && /7\.3 の例外承認は使えません/.test(r.out), r.out);
    const reg = W.adapter('regulatory', '0', pr(base, R1BODY));
    check('IMPL-1029:ok R1 の PR でも、規制業でなければ regulatory が空で通る', reg.code === 0 && /実施しません/.test(reg.out), reg.out);
  }
  {
    const W = mk('', { keyless: true });
    const base = change(W);
    const r = W.adapter('mutation', '0', pr(base, R1BODY));
    check('IMPL-1029:ng R1 の PR で mutation のキーが無くても(空と同じに扱い)失敗させる。終了コード 2 の落ち方にしない', r.code === 1 && /が空です/.test(r.out), r.out);
    const r3 = W.adapter('mutation', '0', pr(base, R2BODY));
    check('IMPL-1029:ok R2 の PR ならキーが無くても通り、R1 の PR では失敗する旨を注意に出す', r3.code === 0 && /R1 の変更の PR では、この段が空だと G-5 が失敗します/.test(r3.out), r3.out);
  }
  // --- R1 の判定の源
  {
    const W = mk('');
    const base = change(W, 'src/auth/login.js');
    const bc = baseCfg(W, AUTH_FLOOR);
    const lo = W.adapter('mutation', '0', pr(base, R2BODY, { PIT_IN_BASE_CONFIG: bc }));
    check('IMPL-1029:ng 本文が R2 でも、基底の構成の下限が R1 なら必須(高いほうを採る)', lo.code === 1 && /区分の下限が R1/.test(lo.out), lo.out);
    const none = W.adapter('mutation', '0', pr(base, R2BODY));
    check('IMPL-1029:ok 本文が R2 で下限の規則も無ければ、空でも通る', none.code === 0, none.out);
    const un = W.adapter('mutation', '0', { PIT_IN_EVENT: 'pull_request', PIT_IN_DIFF_BASE: base, PIT_IN_PR_BODY: undefined });
    check('IMPL-1029:ng PR の本文が渡されなければ判定できず、必須の側に倒れて失敗する', un.code === 1 && /判定できない/.test(un.out) && /PIT_IN_PR_BODY/.test(un.out), un.out);
    const un2 = W.adapter('mutation', '0', {});
    check('IMPL-1029:ng 起動の経路が分からなければ(手元の実行を含む)必須の側に倒れて失敗する', un2.code === 1 && /判定できない/.test(un2.out), un2.out);
    const un3 = W.adapter('mutation', '0', pr('0000000000000000000000000000000000000000', R2BODY));
    check('IMPL-1029:ng 比較の起点から差分を取れなければ(浅い取得)必須の側に倒れて失敗する', un3.code === 1 && /差分を取れない/.test(un3.out), un3.out);
  }
  // --- push の経路: トレーラ Risk: と下限の高いほう
  {
    const W = mk('');
    const base = change(W, 'src/a.js', 'feat: a\n\nRisk: R1\nVerification: test');
    const r = W.adapter('mutation', '0', { PIT_IN_EVENT: 'push', PIT_IN_DIFF_BASE: base });
    check('IMPL-1029:ng push でトレーラ Risk: R1 があれば必須(空なら失敗)', r.code === 1 && /トレーラ Risk: R1/.test(r.out), r.out);
    const W2 = mk('');
    const base2 = change(W2, 'src/a.js', 'feat: a\n\nRisk: R2\nVerification: test');
    const r2 = W2.adapter('mutation', '0', { PIT_IN_EVENT: 'push', PIT_IN_DIFF_BASE: base2 });
    check('IMPL-1029:ok push でトレーラが R2 で下限も無ければ、空でも通る', r2.code === 0, r2.out);
    const W3 = mk('');
    const base3 = change(W3, 'src/auth/x.js', 'feat: a\n\nRisk: R2\nVerification: test');
    const bc3 = baseCfg(W3, AUTH_FLOOR);
    const r3 = W3.adapter('mutation', '0', { PIT_IN_EVENT: 'push', PIT_IN_DIFF_BASE: base3, PIT_IN_BASE_CONFIG: bc3 });
    check('IMPL-1029:ng push でトレーラが R2 でも、下限が R1 なら必須(トレーラを省く・低く書く経路を塞ぐ)', r3.code === 1 && /区分の下限が R1/.test(r3.out), r3.out);
  }
  // --- 区分の下限: 名前の変更の規則(check-pr と同じ変更の一覧を使う。束 B28 の突合 M-3)
  {
    const RENAME_FLOOR = { riskFloor: { rules: [{ id: 'auth-rename', paths: ['src/auth/**'], kinds: ['rename'], floor: 'R1', why: '認証の名前の変更' }] } };
    const body = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n';
    const scene = (op, trailer) => {
      const W = mk('');
      fs.mkdirSync(path.join(W.dir, 'src/auth'), { recursive: true });
      fs.writeFileSync(path.join(W.dir, 'src/auth/a.js'), body);
      sh(W, 'add', '-A');
      sh(W, 'commit', '-q', '-m', 'seed');
      const base = sh(W, 'rev-parse', 'HEAD');
      if (op === 'rename') sh(W, 'mv', 'src/auth/a.js', 'src/auth/b.js');
      else fs.writeFileSync(path.join(W.dir, 'src/auth/a.js'), body + 'export const f = 6;\n');
      sh(W, 'add', '-A');
      sh(W, 'commit', '-q', '-m', `change\n\n${trailer}`);
      return { W, base, bc: baseCfg(W, RENAME_FLOOR) };
    };
    const a = scene('rename', 'Risk: R2\nVerification: test');
    const push = a.W.adapter('mutation', '0', { PIT_IN_EVENT: 'push', PIT_IN_DIFF_BASE: a.base, PIT_IN_BASE_CONFIG: a.bc });
    check('IMPL-1029:ng push で kinds: [rename] の規則に名前の変更が当たれば、トレーラが R2 でも必須(check-pr と同じ変更の一覧)', push.code === 1 && /区分の下限が R1/.test(push.out), push.out);
    const prr = a.W.adapter('mutation', '0', pr(a.base, R2BODY, { PIT_IN_BASE_CONFIG: a.bc }));
    check('IMPL-1029:ng PR でも kinds: [rename] の規則に名前の変更が当たれば必須', prr.code === 1 && /区分の下限が R1/.test(prr.out), prr.out);
    const m = scene('modify', 'Risk: R2\nVerification: test');
    const modPush = m.W.adapter('mutation', '0', { PIT_IN_EVENT: 'push', PIT_IN_DIFF_BASE: m.base, PIT_IN_BASE_CONFIG: m.bc });
    check('IMPL-1029:ok kinds: [rename] の規則は、名前の変更でない変更(modify)には当たらない', modPush.code === 0 && /必須ではありません/.test(modPush.out), modPush.out);
  }
  // --- 必須でない変更(R2・R3)では、コマンドを書いても走らせず、注意で通す(束 B28 の突合 H-1。附属書H H.1: R2 は合否条件にしない)
  {
    const FLAG = `node -e "require('fs').writeFileSync('ran.flag','1')"`;
    const ranOf = (W) => fs.existsSync(path.join(W.dir, 'ran.flag'));
    const W = mk(FLAG);
    const base = change(W);
    const bc = baseCfg(W, { ci: { ...cfgOf(W).ci, mutationThreshold: 80 } });
    const r2 = W.adapter('mutation', '0', pr(base, R2BODY, { PIT_IN_BASE_CONFIG: bc }));
    check('IMPL-1029:ok R2 の PR では、コマンドがあっても走らせず、注意を出して終了 0 にする', r2.code === 0 && !ranOf(W) && /この変更では必須ではありません/.test(r2.out) && /走らせません/.test(r2.out), r2.out);
    const r1 = W.adapter('mutation', '0', pr(base, R1BODY, { PIT_IN_BASE_CONFIG: bc }));
    check('IMPL-1029:ng R1 の PR ではコマンドを走らせる(出力の行が無いので失敗する)', r1.code === 1 && ranOf(W) && /mutation-result: score=/.test(r1.out), r1.out);
    fs.rmSync(path.join(W.dir, 'ran.flag'), { force: true });
    const low = mk(emit('mutation-result: score=10 survivors=s.json'));
    const lbase = change(low);
    const lbc = baseCfg(low, { ci: { ...cfgOf(low).ci, mutationThreshold: 80 } });
    const lr = low.adapter('mutation', '0', pr(lbase, R2BODY, { PIT_IN_BASE_CONFIG: lbc }));
    check('IMPL-1029:ok R2 の PR・閾値 80・スコア 10 でも終了 0(合否条件にしない)', lr.code === 0 && !/届きません/.test(lr.out), lr.out);
    const lp = low.adapter('mutation', '0', pr(lbase, R1BODY, { PIT_IN_BASE_CONFIG: lbc }));
    check('IMPL-0930:ng 同じ出力でも R1 の PR なら閾値割れで失敗する', lp.code === 1 && /10 が閾値 80 に届きません/.test(lp.out), lp.out);
    const noline = mk('node -e "console.log(1)"');
    const nbase = change(noline);
    const nr = noline.adapter('mutation', '0', pr(nbase, R2BODY));
    check('IMPL-1029:ok R2 の PR・出力の行なしでも終了 0', nr.code === 0 && /この変更では必須ではありません/.test(nr.out), nr.out);
    const cl3 = mk(FLAG);
    setConfig(cl3, { answers: { ...cfgOf(cl3).answers, 'q-criticality': 'cl3' }, ci: { ...cfgOf(cl3).ci, mutationThreshold: 80 } });
    const cbase = change(cl3);
    const cr = cl3.adapter('mutation', '0', pr(cbase, R2BODY));
    check('IMPL-0763:ng 案件の条件(CL3)に当たる構成は、R2 の PR でも走らせる(区分に依らず必須。ADR-0224)', ranOf(cl3) && /mutation-result: score=/.test(cr.out), cr.out);
  }
  // --- 起動の経路の理由(束 B28 の突合 M-2)
  {
    const W = mk('');
    const base = change(W);
    const wd = W.adapter('mutation', '0', { PIT_IN_EVENT: 'workflow_dispatch', PIT_IN_DIFF_BASE: base });
    check('IMPL-1029:ng workflow_dispatch では必須の側に倒れ、理由に起動の経路の名を出す(「分からず」としない)', wd.code === 1 && /この起動の経路\(workflow_dispatch\)ではリスク区分を判定しない/.test(wd.out) && !/PIT_IN_EVENT\)が分からず/.test(wd.out), wd.out);
  }
  // --- 案件の条件
  {
    const W = mk('');
    setConfig(W, { answers: { ...cfgOf(W).answers, 'q-criticality': 'cl3' } });
    const base = change(W);
    const r = W.adapter('mutation', '0', pr(base, R2BODY));
    check('IMPL-0763:ng CL3 の案件では、R2 の PR でも mutation が空なら失敗させる', r.code === 1 && /安全重要度 CL3/.test(r.out), r.out);
    const W2 = mk(OKLINE);
    setConfig(W2, { answers: { ...cfgOf(W2).answers, 'q-criticality': 'cl3' } });
    const base2 = change(W2);
    const nt = W2.adapter('mutation', '0', pr(base2, R2BODY));
    check('IMPL-0763:ng CL3 の案件で閾値が未設定なら、段を失敗させる(ADR-0224 決定6)', nt.code === 1 && /ci\.mutationThreshold が未設定/.test(nt.out), nt.out);
    setConfig(W2, { ci: { ...cfgOf(W2).ci, mutationThreshold: 80 } });
    const ok = W2.adapter('mutation', '0', pr(base2, R2BODY));
    check('IMPL-0763:ok CL3 の案件で閾値 80 を定め、スコア 90 なら通る', ok.code === 0 && /閾値 80 以上/.test(ok.out), ok.out);
  }
  {
    const W = mk('');
    setConfig(W, { answers: { ...cfgOf(W).answers, 'q-quality': 'quality-regulated' } });
    const base = change(W);
    const r = W.adapter('regulatory', '0', pr(base, R2BODY));
    check('IMPL-0836:ng 規制業の案件で regulatory が空なら失敗させる', r.code === 1 && /"regulatory" が空です/.test(r.out) && /規制業/.test(r.out), r.out);
  }
  // --- 出力の約束
  {
    const cases = [
      ['行が無い', 'node -e "console.log(1)"', 1, /mutation-result: score=/],
      ['行頭でない行(先頭に空白)は読まない', emit(' mutation-result: score=90 survivors=s.json'), 1, /mutation-result: score=/],
      ['行頭でない行(前に語がある)は読まない', emit('x mutation-result: score=90 survivors=s.json'), 1, /mutation-result: score=/],
      ['スコアが数値でも none でもない', emit('mutation-result: score=abc survivors=s.json'), 1, /数値でも none でもありません/],
      ['スコアが範囲外', emit('mutation-result: score=150 survivors=s.json'), 1, /数値でも none でもありません/],
      ['所在が空', emit('mutation-result: score=90 survivors='), 1, /所在\(survivors=\)が空/],
      ['コマンドの終了コードが 0 でない', 'node -e "process.exit(3)"', 3, /./],
      ['対象の変異体なし(none)', emit('mutation-result: score=none survivors=-'), 0, /対象の変異体なし/],
      ['スコアと所在が出る', OKLINE, 0, /閾値なしで通過.*検出力が足りるとは主張しません/],
    ];
    for (const [label, cmd, code, re] of cases) {
      const W = mk(cmd);
      const base = change(W);
      const r = W.adapter('mutation', '0', pr(base, R1BODY));
      check(`IMPL-1029:${code === 0 ? 'ok' : 'ng'} R1 の PR の出力の約束: ${label}`, r.code === code && re.test(r.out), r.out);
    }
  }
  // --- 閾値(基底の構成から。設定があるときだけ比較する)
  {
    for (const [label, cmd, v, code, re] of [
      ['閾値 80・スコア 70 は失敗', emit('mutation-result: score=70 survivors=s.json'), 80, 1, /70 が閾値 80 に届きません/],
      ['閾値 80・スコア 85 は通る', emit('mutation-result: score=85 survivors=s.json'), 80, 0, /閾値 80 以上/],
      ['閾値 80・スコア 80(境界)は通る', emit('mutation-result: score=80 survivors=s.json'), 80, 0, /閾値 80 以上/],
      ['閾値 80・スコア 79.9 は失敗', emit('mutation-result: score=79.9 survivors=s.json'), 80, 1, /79\.9 が閾値 80 に届きません/],
      ['閾値があっても none は比較せず通る', emit('mutation-result: score=none survivors=-'), 80, 0, /閾値の比較はしません/],
      ['閾値が数値でなければ失敗', OKLINE, '80', 1, /0〜100 の数値ではありません/],
    ]) {
      const W = mk(cmd);
      const base = change(W);
      const bc = baseCfg(W, { ci: { ...cfgOf(W).ci, mutationThreshold: v } });
      const r = W.adapter('mutation', '0', pr(base, R1BODY, { PIT_IN_BASE_CONFIG: bc }));
      if (code === 1) check(`IMPL-0930:ng 閾値の合否: R1 の PR で${label}`, r.code === code && re.test(r.out), r.out);
      else check(`IMPL-0930:ok 閾値の合否: R1 の PR で${label}`, r.code === code && re.test(r.out), r.out);
    }
  }
  // 基底と作業ツリーで閾値が違う組(束 B28 の突合 M-4)。閾値は基底の構成から読む。PR 側で外す・下げる経路を段が許さない
  {
    const seven = emit('mutation-result: score=70 survivors=s.json');
    for (const [label, headCi] of [['作業ツリーに閾値が無い', (ci) => { const { mutationThreshold: _x, ...rest } = ci; return rest; }], ['作業ツリーの閾値が 50', (ci) => ({ ...ci, mutationThreshold: 50 })]]) {
      const W = mk(seven);
      const base = change(W);
      const bc = baseCfg(W, { ci: { ...cfgOf(W).ci, mutationThreshold: 80 } });
      setConfig(W, { ci: headCi(cfgOf(W).ci) });
      const r = W.adapter('mutation', '0', pr(base, R1BODY, { PIT_IN_BASE_CONFIG: bc }));
      check(`IMPL-0930:ng 基底の閾値 80 を使う: ${label}・スコア 70 は失敗`, r.code === 1 && /70 が閾値 80 に届きません/.test(r.out), r.out);
    }
    // 基底の構成が渡されない(push・手元)ときは作業ツリーの構成の閾値を使う
    const W = mk(seven);
    const base = change(W);
    setConfig(W, { ci: { ...cfgOf(W).ci, mutationThreshold: 80 } });
    const r = W.adapter('mutation', '0', pr(base, R1BODY));
    check('IMPL-0930:ng 基底の構成が渡されないときは作業ツリーの閾値 80 を使い、スコア 70 は失敗', r.code === 1 && /70 が閾値 80 に届きません/.test(r.out), r.out);
  }
  // 閾値の型の契約(verify-gate-contract.mjs が使う)
  {
    const { thresholdProblems } = await import('./mutation-stage.mjs');
    check('IMPL-0763:ng 閾値が文字列なら問題にする', thresholdProblems({ ci: { mutationThreshold: '80' }, answers: {} }, null).length === 1);
    check('IMPL-0763:ng CL3 で閾値が未設定なら問題にする', thresholdProblems({ ci: {}, answers: { 'q-criticality': 'cl3' } }, null).length === 1);
    check('IMPL-0763:ok CL3 でも数値の閾値があれば問題にしない。R1 だけに当たる構成は閾値を求めない', thresholdProblems({ ci: { mutationThreshold: 80 }, answers: { 'q-criticality': 'cl3' } }, null).length === 0 && thresholdProblems({ ci: {}, answers: { 'q-criticality': 'cl0' } }, null).length === 0);
  }
  for (const id of ['go', 'node', 'none', 'python-poetry', 'python-uv', 'python', 'undetermined']) {
    const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', `${id}.json`), 'utf8')).commands;
    check(`${id}: アダプタは空の mutation・regulatory を持つ(既定のコマンドは置かない)`, a.mutation === '' && a.regulatory === '');
  }

  // --- 週次の型(附属書H H.1 の R2 の週次の定期実行。ADR-0243。IMPL-1036)。schedule・workflow_dispatch のときだけ有効。合否にしない
  {
    const { weeklyModeOf, evaluateWeeklyMutation } = await import('./mutation-stage.mjs');
    const wk = (event, extra = {}) => ({ PIT_IN_EVENT: event, PIT_IN_MUTATION_MODE: 'weekly', ...extra });
    const LOW = emit('mutation-result: score=70 survivors=s.json');
    const withCi = (W, v) => setConfig(W, { ci: { ...cfgOf(W).ci, mutationThreshold: v } });
    const sumOf = (W) => {
      const p = path.join(W.dir, 'summary.md');
      return { path: p, read: () => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '') };
    };
    check('IMPL-1036:ok weeklyModeOf は schedule・workflow_dispatch のときだけ有効', weeklyModeOf(wk('schedule')) && weeklyModeOf(wk('workflow_dispatch')));
    check('IMPL-1036:ng weeklyModeOf は pull_request・push・イベント不明・型の指定なしでは無効', !weeklyModeOf(wk('pull_request')) && !weeklyModeOf(wk('push')) && !weeklyModeOf({ PIT_IN_MUTATION_MODE: 'weekly' }) && !weeklyModeOf({ PIT_IN_EVENT: 'schedule' }) && !weeklyModeOf({ PIT_IN_EVENT: 'schedule', PIT_IN_MUTATION_MODE: 'daily' }));
    for (const ev of ['schedule', 'workflow_dispatch']) {
      // 空のコマンド: 必須の判定をせず、何も測っていないと出して終了 0
      {
        const W = mk('');
        const r = W.adapter('mutation', '0', wk(ev));
        check(`IMPL-1036:ok 週次の型(${ev})で mutation が空なら、何も測っていないと注意を出して終了 0`, r.code === 0 && /週次/.test(r.out) && /何も測っていません/.test(r.out), r.out);
      }
      // 閾値割れ: 終了 0 で、段の出力の1行とジョブの要約へ出す(失敗にしない)
      {
        const W = mk(LOW);
        withCi(W, 80);
        const sm = sumOf(W);
        const r = W.adapter('mutation', '0', wk(ev, { GITHUB_STEP_SUMMARY: sm.path }));
        check(`IMPL-1036:ok 週次の型(${ev})で閾値割れは終了 0。段の出力の1行とジョブの要約へ出す`, r.code === 0 && /スコア 70 が閾値 80 を下回っています/.test(r.out) && /合否にはしません/.test(r.out) && /スコア 70 が閾値 80 を下回っています/.test(sm.read()), r.out + sm.read());
      }
      // 閾値以上
      {
        const W = mk(OKLINE);
        withCi(W, 80);
        const sm = sumOf(W);
        const r = W.adapter('mutation', '0', wk(ev, { GITHUB_STEP_SUMMARY: sm.path }));
        check(`IMPL-1036:ok 週次の型(${ev})でスコアが閾値以上なら終了 0`, r.code === 0 && /閾値 80 以上/.test(r.out) && /閾値 80 以上/.test(sm.read()), r.out);
      }
      // 実行できなかった事実は失敗
      for (const [label, cmd, code, re] of [
        ['コマンドの終了コードが 0 でない', 'node -e "process.exit(3)"', 3, /./],
        ['出力の行が無い', 'node -e "console.log(1)"', 1, /mutation-result: score=/],
        ['スコアが数値でも none でもない', emit('mutation-result: score=abc survivors=s.json'), 1, /数値でも none でもありません/],
        ['所在が空', emit('mutation-result: score=90 survivors='), 1, /所在\(survivors=\)が空/],
      ]) {
        const W = mk(cmd);
        withCi(W, 80);
        const r = W.adapter('mutation', '0', wk(ev));
        check(`IMPL-1036:ng 週次の型(${ev})でも、${label}なら失敗にする(実行できなかった事実)`, r.code === code && re.test(r.out), r.out);
      }
    }
    // 比較の起点を置かない: 週次の型は PIT_IN_DIFF_BASE を要さず、壊れた値が渡されても読まない
    {
      const W = mk(OKLINE);
      const r = W.adapter('mutation', '0', wk('schedule', { PIT_IN_DIFF_BASE: 'no-such-ref' }));
      check('IMPL-1036:ok 週次の型は比較の起点を置かず、起点が壊れていても走る', r.code === 0 && /スコア 90|score=90/.test(r.out), r.out);
    }
    // 週次の型は pull_request・push では無視して通常の判定に戻る(PR の必須の判定を緩められない)
    {
      const W = mk('');
      const base = change(W);
      const r = W.adapter('mutation', '0', { ...pr(base, R1BODY), PIT_IN_MUTATION_MODE: 'weekly' });
      check('IMPL-1036:ng pull_request では週次の型を無視する。R1 の PR で mutation が空なら失敗のまま', r.code === 1 && /"mutation" が空です/.test(r.out), r.out);
      const rp = W.adapter('mutation', '0', { PIT_IN_EVENT: 'push', PIT_IN_MUTATION_MODE: 'weekly' });
      check('IMPL-1036:ng push でも週次の型を無視する(R1 かを判定できず必須の側に倒れる)', rp.code === 1 && /"mutation" が空です/.test(rp.out), rp.out);
      const low = mk(LOW);
      const lbase = change(low);
      const lbc = baseCfg(low, { ci: { ...cfgOf(low).ci, mutationThreshold: 80 } });
      const lr = low.adapter('mutation', '0', { ...pr(lbase, R1BODY, { PIT_IN_BASE_CONFIG: lbc }), PIT_IN_MUTATION_MODE: 'weekly' });
      check('IMPL-1036:ng pull_request では週次の型を無視する。閾値割れは失敗のまま', lr.code === 1 && /70 が閾値 80 に届きません/.test(lr.out), lr.out);
    }
    // 型の指定が無い schedule は、通常の判定(イベントを判定できず必須の側に倒れる)
    {
      const W = mk('');
      const r = W.adapter('mutation', '0', { PIT_IN_EVENT: 'schedule' });
      check('IMPL-1036:ng 型の指定が無ければ schedule でも通常の判定(空は失敗)', r.code === 1 && /"mutation" が空です/.test(r.out), r.out);
    }
    // 評価関数の単体
    {
      const none = evaluateWeeklyMutation({ out: 'mutation-result: score=none survivors=-', threshold: 80 });
      const noTh = evaluateWeeklyMutation({ out: 'mutation-result: score=10 survivors=s', threshold: undefined });
      const badTh = evaluateWeeklyMutation({ out: 'mutation-result: score=10 survivors=s', threshold: undefined, thresholdProblem: '閾値が不正' });
      check('IMPL-1036:ok 評価: none・閾値なし・閾値の型の不正は合否にしない(ok のまま、要約は出さない)', none.ok && noTh.ok && badTh.ok && none.summary === null && noTh.summary === null && badTh.summary === null);
    }
    // workflow の形(定義を静的に読む)
    {
      const dir = path.join(ROOT, '.github', 'workflows');
      const read = (n) => fs.readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n');
      const noCmt = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      const w = noCmt(read('mutation-weekly.yml'));
      check('IMPL-1036:ok mutation-weekly.yml は schedule(週1回)と workflow_dispatch を契機に持つ', /^on:\n {2}schedule:\n {4}- cron: '\S+ \S+ \S+ \* [0-6]'\n {2}workflow_dispatch:/m.test(w), w.slice(0, 300));
      check('IMPL-1036:ng mutation-weekly.yml は pull_request・push・workflow_call を契機に持たない', !/^ {2}(pull_request|pull_request_target|push|workflow_call):/m.test(w));
      check('IMPL-1036:ok 週次の型の環境変数を渡し、イベント名を PIT_IN_EVENT へ渡す', /PIT_IN_MUTATION_MODE: weekly/.test(w) && /PIT_IN_EVENT: \$\{\{ github\.event_name \}\}/.test(w) && /adapter\.mjs run mutation/.test(w));
      check('IMPL-1036:ng ジョブの ID・名を gate-g5 にしない。権限は contents: read だけ。ジョブの失敗を握りつぶさない', !/^ {2}gate-g5:/m.test(w) && !/name: gate-g5\s*$/m.test(w) && /permissions:\n {2}contents: read\n/.test(w) && !/continue-on-error|\|\| true/.test(w), w);
      const g5 = noCmt(read('gate-g5.yml'));
      check('IMPL-1036:ng gate-g5 の集約に週次を入れない', !/mutation-weekly|weekly/.test(g5));
    }
  }
}

// 8. 出荷の集約へ出す、構成に閾値が無いことの注意(ruling-1 §1.1。構成の値を読むだけ)
{
  const { mutationThresholdNote } = await import('./mutation-stage.mjs');
  const absent = mutationThresholdNote({ ci: {} });
  check('IMPL-0763:ng 構成に閾値が無ければ、閾値なしで通過する注意を出す', typeof absent === 'string' && /ci.mutationThreshold/.test(absent) && /閾値なしで通過/.test(absent), absent);
  check('構成に ci が無くても注意を出す', mutationThresholdNote({}) === absent && mutationThresholdNote(undefined) === absent);
  check('IMPL-0763:ok 閾値が数値で在れば注意を出さない(0 も在る扱い)', mutationThresholdNote({ ci: { mutationThreshold: 80 } }) === null && mutationThresholdNote({ ci: { mutationThreshold: 0 } }) === null);
  const bad = mutationThresholdNote({ ci: { mutationThreshold: '80' } });
  check('閾値の型が不正なら、不正と注意を出す', typeof bad === 'string' && /0〜100 の数値ではありません/.test(bad), bad);
  // 案件の条件(CL3・Q1「はい」)に当たる構成では、段も契約検査も閾値なしを失敗にする。文は「通過する」と言わない(束 B28 の突合 L-5)
  const caseNote = mutationThresholdNote({ ci: {}, answers: { 'q-criticality': 'cl3' } });
  check('IMPL-0763:ng 案件の条件(CL3)で閾値が無ければ、段と契約検査が失敗にする旨の注意を出す(通過するとは言わない)', typeof caseNote === 'string' && /閾値が未設定のため、段と契約検査が失敗にします/.test(caseNote) && !/「閾値なしで通過」/.test(caseNote), caseNote);
  check('IMPL-0763:ok 案件の条件に当たらない構成(CL0)では、従来どおり閾値なしで通過する旨の注意', /「閾値なしで通過」/.test(mutationThresholdNote({ ci: {}, answers: { "q-criticality": "cl0" } })));
  const ev = fs.readFileSync(path.join(ROOT, 'scripts/gate/aggregate-evidence.mjs'), 'utf8');
  check('出荷の集約が、この注意を機械検査の表へ出す', ev.includes('mutationThresholdNote: mutationThresholdNote(config,') && ev.includes('A.machineChecks.mutationThresholdNote'));
}

// ---------------------------------------------------------------- 8. 閾値割れを台帳の行(G-5 PR-<番号>)で受ける(ADR-0243。process-compass #445)
// 期限は固定の日付(2099 年=期限内、2000 年=期限切れ)で書く。実行の時計に依らない。段の実行を作業ツリーで流し、台帳・PR の記録(JSON)・基底の構成を渡す
{
  const baseCmds = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'node.json'), 'utf8')).commands;
  const sh = (W, ...a) => execFileSync('git', a, { cwd: W.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const R1BODY = '## リスク区分\n\nR1\n';
  const R2BODY = '## リスク区分\n\nR2\n';
  const PEOPLE = [
    { id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: 1001 }] },
    { id: 'p2', name: '鈴木 一郎', accounts: [{ login: 'suzuki', id: 1002 }] },
    { id: 'p3', name: '佐藤 花子', accounts: [{ login: 'sato', id: 1003 }] },
  ];
  const PRHEAD = 'a'.repeat(40);
  const LH = '| ID | 区分 | 対象 | 内容 | 受容した理由 | 顕在化の兆候 | 返却の目安 | 状態 | 記録者 | 承認した者 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
  const lrow = (o = {}) => {
    const r = { id: 'D-012', kind: '例外', target: 'G-5 PR-12', content: '変異試験の閾値割れ(スコア 70 を受容)', reason: '期限を優先する', due: '2099-01-01 まで', state: '未返却', approver: '鈴木 一郎', ...o };
    return `| ${r.id} | ${r.kind} | ${r.target} | ${r.content} | ${r.reason} | 不具合 | ${r.due} | ${r.state} | 山田 太郎 | ${r.approver} |\n`;
  };
  const rev = (o = {}) => ({ id: 1, state: 'COMMENTED', body: '例外承認: D-012\n\nスコアを読んだ', submitted_at: '2026-11-05T10:00:00Z', commit_id: PRHEAD, author_association: 'MEMBER', author: { login: 'suzuki', id: 1002, is_bot: false }, edited_by: null, ...o });
  // 1 場面: 閾値 80(基底)・スコア 70 の段を、台帳と PR の記録つきで流す。返す値は段の終了コードと出力
  const scene = (o = {}) => {
    const { rows = [lrow()], inBase = true, reviews = [rev()], prNum = 12, event = 'pull_request', author = { login: 'yamada', id: 1001 }, body = R2BODY, ctxExtra = {}, headCi = null, headPeople = null, envDrop = [], envOver = {}, cl3 = true, noCtx = false, cmd = null, ledgerHead = null, postBase = null } = o;
    const W = workspace('node', { 'package.json': '{ "name": "x" }\n' }, { commands: { ...baseCmds, mutation: cmd ?? `node -e "console.log('mutation-result: score=70 survivors=s.json')"` } });
    const cfgF = path.join(W.dir, 'process.config.json');
    const cfg0 = JSON.parse(fs.readFileSync(cfgF, 'utf8'));
    const cfg = { ...cfg0, people: PEOPLE, aiNames: ['Claude'], answers: { ...cfg0.answers, ...(cl3 ? { 'q-criticality': 'cl3' } : {}) }, ci: { ...cfg0.ci, mutationThreshold: 80 } };
    fs.writeFileSync(cfgF, JSON.stringify(cfg, null, 2));
    const ledgerPath = path.join(W.dir, 'docs', 'debt-ledger.md');
    const writeLedger = (text) => {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.writeFileSync(ledgerPath, text);
      sh(W, 'add', '-A');
      sh(W, 'commit', '-q', '-m', 'ledger');
    };
    const commitChange = () => {
      fs.mkdirSync(path.join(W.dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(W.dir, 'src/a.js'), 'x = 1;\n');
      sh(W, 'add', '-A');
      sh(W, 'commit', '-q', '-m', 'change');
    };
    let base;
    if (inBase) {
      writeLedger(`# 技術負債台帳\n\n${LH}${rows.join('')}`);
      base = sh(W, 'rev-parse', 'HEAD');
      commitChange();
    } else {
      base = sh(W, 'rev-parse', 'HEAD');
      commitChange();
      writeLedger(`# 技術負債台帳\n\n${LH}${rows.join('')}`);
    }
    if (ledgerHead) writeLedger(`# 技術負債台帳\n\n${LH}${ledgerHead.join('')}`);
    if (postBase) postBase(W);
    const bcF = path.join(W.dir, 'base-config.json');
    fs.writeFileSync(bcF, JSON.stringify(cfg));
    if (headCi || headPeople) fs.writeFileSync(cfgF, JSON.stringify({ ...cfg, ...(headPeople ? { people: headPeople } : {}), ci: { ...cfg.ci, ...(headCi ?? {}) } }, null, 2));
    const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-ctx-'));
    dirs.push(cdir);
    const ctxF = path.join(cdir, 'pr-context.json');
    fs.writeFileSync(ctxF, JSON.stringify({ route: event === 'push' ? 'push' : 'pull_request', pr: { number: prNum, authorLogin: author.login, authorId: author.id, headSha: PRHEAD, body, baseRef: 'main' }, reviews, problem: null, ...ctxExtra }));
    const env = event === 'push' ? { PIT_IN_EVENT: 'push', PIT_IN_DIFF_BASE: base } : { PIT_IN_EVENT: 'pull_request', PIT_IN_DIFF_BASE: base, PIT_IN_PR_BODY: body };
    Object.assign(env, { PIT_IN_BASE_CONFIG: bcF, PIT_IN_POLICY_BASE: base });
    if (!noCtx) env.PIT_IN_PR_CONTEXT = ctxF;
    Object.assign(env, envOver);
    for (const k of envDrop) delete env[k];
    return W.adapter('mutation', '0', env);
  };
  const okScene = (name, o) => {
    const r = scene(o);
    check(`IMPL-0931:ok ${name}`, r.code === 0 && /閾値割れを第7章 7\.3 の例外承認 D-012 で受けた/.test(r.out) && /閾値 80/.test(r.out), r.out);
  };
  const ngScene = (name, o, re = null) => {
    const r = scene(o);
    check(`IMPL-0931:ng ${name}`, r.code === 1 && /スコア 70 が閾値 80 に届きません/.test(r.out) && !/で受けた/.test(r.out) && (re ? re.test(r.out) : true), r.out);
  };

  // --- ok
  okScene('案件の条件(CL3)・基底の台帳の行・承認した者本人の宣言行のレビュー(先頭一致)で閾値割れを受ける(下限は無い)');
  okScene('R1 の PR(案件の条件に当たらない構成)でも同じ行で受ける', { cl3: false, body: R1BODY });
  okScene('PR の中で足した行も、(A) のレビューがあれば受ける', { inBase: false });
  okScene('印の強調(太字・全角)を正規化して読む', { rows: [lrow({ content: '**変異試験の閾値割れ** スコア 70' })] });
  okScene('印の後ろは自由(スコアの下限を書かなくてもよい)', { rows: [lrow({ content: '変異試験の閾値割れ' })] });
  okScene('閾値を変える PR で行を足しても、基底の構成の閾値 80 で読む(PR の側の閾値 50 でも 70 は割れで、行で受ける)', { headCi: { mutationThreshold: 50 }, inBase: false });
  okScene('push の経路: PR の先頭が HEAD と異なっても(squash)、PR の先頭に対するレビューで (A) が通る', { event: 'push', inBase: false });

  // --- ng(条件ごとに1つ)
  ngScene('台帳に行が無い(案内を出す)', { rows: [] }, /G-5 PR-<この PR の番号>/);
  ngScene('レビューが無い', { reviews: [] }, /帰属を確かめられない/);
  ngScene('レビューの対象が PR の先頭でない(先頭が変わった)', { reviews: [rev({ commit_id: 'c'.repeat(40) })] }, /先頭が変わった/);
  ngScene('承認した者が PR の作成者', { author: { login: 'suzuki', id: 1002 } }, /PR の作成者/);
  ngScene('承認した者が空欄', { rows: [lrow({ approver: '' })] }, /承認した者が未記入/);
  ngScene('承認した者が名簿に無い', { rows: [lrow({ approver: '外部 太郎' })] }, /名簿の人へ対応づかない/);
  ngScene('承認した者が AI の名義', { rows: [lrow({ approver: 'Claude' })] }, /AI の名義/);
  ngScene('状態が返却済み', { rows: [lrow({ state: '返却済み' })] }, /状態が有効を示す値でない/);
  ngScene('期限が過去(2000 年)', { rows: [lrow({ due: '2000-01-01 まで' })] }, /期限.*を過ぎている/);
  ngScene('期限が日付として読めない', { rows: [lrow({ due: 'いつか' })] }, /日付として解釈できない/);
  ngScene('対象が G-5 PR-13(別の PR)', { rows: [lrow({ target: 'G-5 PR-13' })] }, /G-5 PR-<この PR の番号>/);
  ngScene('対象が G-5 PR-120(番号は完全一致)', { rows: [lrow({ target: 'G-5 PR-120' })] });
  ngScene('対象が PR #12 の形', { rows: [lrow({ target: 'PR #12' })] });
  ngScene('対象が別のゲート(G-6 PR-12)', { rows: [lrow({ target: 'G-6 PR-12' })] });
  ngScene('区分が例外でない', { rows: [lrow({ kind: '負債' })] });
  ngScene('印が無い(先頭一致でない。内容の途中に書いても受けない)', { rows: [lrow({ content: 'スコア 70 を受容(変異試験の閾値割れ)' })] }, /印「変異試験の閾値割れ」でない/);
  ngScene('受容した理由が空', { rows: [lrow({ reason: '' })] }, /理由/);
  ngScene('作成を指示した者が承認した者本人', { body: '## 作成を指示した者\n\n鈴木 一郎\n' }, /作成を指示した者/);
  ngScene('作成を指示した者が @アカウント(段はトークンを持たず識別子で確かめられない)', { body: '## 作成を指示した者\n\n@yamada\n' }, /識別子で確かめられない/);
  ngScene('基底の行の期限を PR の中で未来へ書き換えても、基底の内容(期限切れ)で読んで受けない', { rows: [lrow({ due: '2000-01-01 まで' })], ledgerHead: [lrow({ due: '2099-01-01 まで' })] }, /を過ぎている/);
  // 基底から読む入力が取れないときは、作業ツリーの側へ倒れず受けない(中2)
  const EXTRA = { id: 'p4', name: '外部 太郎', accounts: [{ login: 'gaibu', id: 1004 }] };
  const extraRev = [rev({ author: { login: 'gaibu', id: 1004, is_bot: false } })];
  ngScene('基底の構成が渡されない(PIT_IN_BASE_CONFIG なし)は、作業ツリーの構成で照らさず受けない', { envDrop: ['PIT_IN_BASE_CONFIG'] }, /基底の構成/);
  ngScene('PR の側の構成に名簿の人を足して承認した者にしても、基底の構成が取れなければ受けない', { rows: [lrow({ approver: '外部 太郎' })], headPeople: [...PEOPLE, EXTRA], reviews: extraRev, envDrop: ['PIT_IN_BASE_CONFIG'] }, /基底の構成/);
  ngScene('PR の側の構成に名簿の人を足しても、基底の構成の名簿で読んで受けない', { rows: [lrow({ approver: '外部 太郎' })], headPeople: [...PEOPLE, EXTRA], reviews: extraRev }, /名簿の人へ対応づかない/);
  ngScene('基底の台帳を読む点(PIT_IN_POLICY_BASE)が渡されない(基底の行の期限を書き換えても受けない)', { rows: [lrow({ due: '2000-01-01 まで' })], ledgerHead: [lrow({ due: '2099-01-01 まで' })], envDrop: ['PIT_IN_POLICY_BASE'] }, /PIT_IN_POLICY_BASE/);
  ngScene('基底の台帳を読む点が引けない(存在しない参照)は受けない', { envOver: { PIT_IN_POLICY_BASE: 'no-such-ref-xyz' } }, /引けない/);
  ngScene('起動の経路が workflow_dispatch なら、整った記録(route 一致)があっても受けない', { envOver: { PIT_IN_EVENT: 'workflow_dispatch' }, ctxExtra: { route: 'workflow_dispatch' } }, /この起動の経路/);
  {
    const r = scene({ rows: [lrow({ state: '返却済み' })] });
    check('IMPL-0931:ng 状態が返却済みの行には、期限切れの理由を出さない(期限内の日付)', r.code === 1 && /状態が有効を示す値でない/.test(r.out) && !/を過ぎている/.test(r.out), r.out);
  }
  ngScene('レビューを読めない(取得の失敗)', { reviews: null }, /読めない/);
  ngScene('レビューの本文を書き手以外が編集した', { reviews: [rev({ edited_by: 'yamada' })] }, /編集/);
  ngScene('宣言行が別の行の ID', { reviews: [rev({ body: '例外承認: D-013' })] }, /帰属を確かめられない/);
  {
    const r = scene({ cmd: `node -e "console.log('mutation-result: score=70 survivors=s.json');process.exit(1)"` });
    check('IMPL-0931:ng コマンドの終了コードが 0 でなければ、行が正しくても受けない(閾値割れの評価の前に失敗する)', r.code === 1 && !/で受けた/.test(r.out), r.out);
  }
  ngScene('PR の記録が渡されない(PIT_IN_PR_CONTEXT なし)', { noCtx: true }, /PIT_IN_PR_CONTEXT/);
  ngScene('PR の記録の取得に失敗した(problem つき)', { ctxExtra: { problem: 'PR のレビューを取得できない' } }, /取得できなかった/);
  ngScene('push の経路で PR の記録が経路と一致しない', { event: 'push', ctxExtra: { route: 'pull_request' } }, /経路が起動の経路と一致しない/);
  ngScene('push の経路で、マージの照合が取れない(0件・2件・base の不一致)ときの problem', { event: 'push', ctxExtra: { pr: null, reviews: null, problem: '先頭 aaaaaaa をマージのコミットとする PR が無い' } }, /取得できなかった/);

  // 段の失敗の種別は変えない: 閾値が未設定・段が空・出力の行が無いときは、行があっても受けない(スコアの評価に届かない)
  {
    const r = scene({ cmd: `node -e "console.log('x')"` });
    check('IMPL-0931:ng 出力の行が無ければ、行があっても受けない', r.code === 1 && /mutation-result: score=/.test(r.out) && !/で受けた/.test(r.out), r.out);
    const e = scene({ cmd: '' });
    check('IMPL-0931:ng 段が空なら、行があっても受けない(7.3 は段が空のままの通過に使えない)', e.code === 1 && /が空です/.test(e.out) && !/で受けた/.test(e.out), e.out);
  }
}

// ---------------------------------------------------------------- 9. PR の記録の取得(mutation-pr-context.mjs)と push の経路のマージの照合
{
  const { pickMergedPr, buildContext, fetchReviews, REVIEWS_JQ } = await import('./mutation-pr-context.mjs');
  const SHA = 'f'.repeat(40);
  const P = (o = {}) => ({ number: 12, merged: true, merge_commit_sha: SHA, base: { ref: 'main' }, user: { login: 'yamada', id: 1001 }, head: { sha: 'a'.repeat(40) }, body: '本文', ...o });
  check('pickMergedPr:ok マージ済み・先頭がマージのコミット・base が既定ブランチの PR がちょうど1件', pickMergedPr([P()], { sha: SHA, defaultBranch: 'main' }).pr?.number === 12);
  check('pickMergedPr:ng 0件は受けない', !!pickMergedPr([], { sha: SHA, defaultBranch: 'main' }).problem);
  check('pickMergedPr:ng 2件以上は受けない', /2 件/.test(pickMergedPr([P(), P({ number: 13 })], { sha: SHA, defaultBranch: 'main' }).problem ?? ''));
  check('pickMergedPr:ng base.ref が既定ブランチでない(スタックの中間の層)', !!pickMergedPr([P({ base: { ref: 'feature/x' } })], { sha: SHA, defaultBranch: 'main' }).problem);
  check('pickMergedPr:ng merge_commit_sha が先頭と一致しない', !!pickMergedPr([P({ merge_commit_sha: 'e'.repeat(40) })], { sha: SHA, defaultBranch: 'main' }).problem);
  check('pickMergedPr:ng マージされていない(merged が偽)', !!pickMergedPr([P({ merged: false })], { sha: SHA, defaultBranch: 'main' }).problem);
  check('pickMergedPr:ng 一覧を読めない(null)・先頭か既定ブランチが無い', !!pickMergedPr(null, { sha: SHA, defaultBranch: 'main' }).problem && !!pickMergedPr([P()], { sha: SHA, defaultBranch: '' }).problem);
  check('pickMergedPr:ok 一覧の記録が merged を持たず merged_at だけを持つ場合も、候補にする(1件の記録で確かめ直す)', pickMergedPr([{ ...P(), merged: undefined, merged_at: '2026-11-20T00:00:00Z' }], { sha: SHA, defaultBranch: 'main' }).pr?.number === 12);

  const REV_LINES = JSON.stringify({ id: 7, state: 'COMMENTED', body: '例外承認: D-012', submitted_at: 't', commit_id: 'a'.repeat(40), author_association: 'MEMBER', author: { login: 'suzuki', id: 1002, is_bot: false } });
  const fakeGh = (over = {}) => (args) => {
    const key = args.join(' ');
    for (const [re, v] of Object.entries(over)) if (new RegExp(re).test(key)) return typeof v === 'function' ? v(args) : v;
    if (/commits\/.*\/pulls/.test(key)) return JSON.stringify([{ ...P(), merged: undefined, merged_at: 't' }]);
    if (/pulls\/12\/reviews/.test(key)) return `${REV_LINES}\n`;
    if (/pulls\/12$/.test(key)) return JSON.stringify(P());
    if (/graphql/.test(key)) return JSON.stringify({ 7: '' });
    return null;
  };
  const PUSH_ENV = { EVENT_NAME: 'push', REPO: 'o/r', SHA, DEFAULT_BRANCH: 'main' };
  const c = buildContext(PUSH_ENV, fakeGh());
  check('buildContext:ok push の経路で PR 12 の記録とレビュー(edited_by つき)を作る。PR の先頭は HEAD(squash の SHA)と異なる', c.problem === null && c.pr.number === 12 && c.pr.headSha === 'a'.repeat(40) && c.pr.headSha !== SHA && c.reviews.length === 1 && c.reviews[0].edited_by === null, JSON.stringify(c));
  check('buildContext:ng push の経路で候補が0件なら problem', !!buildContext(PUSH_ENV, fakeGh({ 'commits/.*/pulls': '[]' })).problem);
  check('buildContext:ng push の経路で候補が2件なら problem', !!buildContext(PUSH_ENV, fakeGh({ 'commits/.*/pulls': JSON.stringify([P(), P({ number: 13 })]) })).problem);
  check('buildContext:ng push の経路で base.ref が既定ブランチでなければ problem', !!buildContext(PUSH_ENV, fakeGh({ 'commits/.*/pulls': JSON.stringify([P({ base: { ref: 'dev' } })]) })).problem);
  check('buildContext:ng push の経路で PR の取得に失敗すれば problem', !!buildContext(PUSH_ENV, () => null).problem);
  check('buildContext:ng push の経路で PR 1件の記録が merged でなければ problem', !!buildContext(PUSH_ENV, fakeGh({ 'pulls/12$': JSON.stringify(P({ merged: false })) })).problem);
  check('buildContext:ng push の経路でレビューを取得できなければ problem(reviews は null)', (() => { const x = buildContext(PUSH_ENV, fakeGh({ 'pulls/12/reviews': () => null })); return !!x.problem && x.reviews === null; })());
  const PR_ENV = { EVENT_NAME: 'pull_request', REPO: 'o/r', PR_NUMBER: '12', PR_AUTHOR: 'yamada', PR_AUTHOR_ID: '1001', PR_HEAD_SHA: 'a'.repeat(40), PR_BASE_REF: 'main', PR_BODY: '本文' };
  const pc = buildContext(PR_ENV, fakeGh());
  check('buildContext:ok PR の経路で、イベントの値とレビューから記録を作る', pc.problem === null && pc.pr.authorId === 1001 && pc.pr.headSha === 'a'.repeat(40) && pc.reviews.length === 1, JSON.stringify(pc));
  check('buildContext:ng PR の経路で番号か先頭が無ければ problem・workflow_dispatch など他の経路は problem', !!buildContext({ ...PR_ENV, PR_NUMBER: '' }, fakeGh()).problem && !!buildContext({ ...PR_ENV, EVENT_NAME: 'workflow_dispatch' }, fakeGh()).problem);
  check('fetchReviews:ng editor を引けないレビューには edited_by を足さない(検査は編集の記録を読めないとして数えない側に倒れる)', fetchReviews('o/r', 12, fakeGh({ graphql: () => null }))[0].edited_by === undefined);
  check('fetchReviews:ng 整形の結果が壊れていれば null', fetchReviews('o/r', 12, fakeGh({ 'pulls/12/reviews': 'not json\n' })) === null);
  // pr-rules の「PR のレビュー」ステップと同じ整形(2か所が食い違うと edited_by が欠けて (A) が全て落ちる)
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'gate-g5.yml'), 'utf8').replace(/\r\n/g, '\n');
  check('PR のレビューの整形の式は、gate-g5.yml の pr-rules のステップと一致する', yml.includes(`--jq '${REVIEWS_JQ}'`));
  // 段のステップ(変異試験)へ GH_TOKEN を渡さない: 取得は別のステップで、GH_TOKEN を付けるのはそのステップだけ
  const noComment = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const mutJob = noComment(yml.split(/^  mutation:\n/m)[1]?.split(/^  regulatory:\n/m)[0] ?? '');
  const stageStep = mutJob.split('      - name: 変異試験\n')[1] ?? '';
  const fetchStep = mutJob.split('      - name: PR の記録の取得\n')[1]?.split(/^      - /m)[0] ?? '';
  check('workflow: 段 mutation のコマンドのステップに GH_TOKEN を渡さず、取得の別のステップだけが持つ', stageStep.length > 0 && !/GH_TOKEN|github\.token/.test(stageStep) && /GH_TOKEN: \$\{\{ github\.token \}\}/.test(fetchStep) && !/GH_TOKEN/.test(mutJob.replace(fetchStep, '')), stageStep.slice(0, 200));
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`アダプタの対象の試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`アダプタの対象の試験: ${checks} 件が期待と一致しました`);
