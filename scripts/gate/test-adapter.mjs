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
  fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\necho "$@" > ".fake-${name}"\necho "UV_PYTHON=$UV_PYTHON" >> ".fake-${name}"\nexit \${FAKE_EXIT:-0}\n`);
  fs.chmodSync(path.join(BIN, name), 0o755);
  fs.writeFileSync(path.join(BIN, `${name}.cmd`), `@echo off\r\necho %* > ".fake-${name}"\r\necho UV_PYTHON=%UV_PYTHON%>> ".fake-${name}"\r\nif "%FAKE_EXIT%"=="" exit /b 0\r\nexit /b %FAKE_EXIT%\r\n`);
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
  const run = (script, args, exit = '0') => {
    const r = spawnSync(process.execPath, [path.join(dir, script), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_EXIT: exit },
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { dir, run, adapter: (phase, exit) => run('scripts/gate/adapter.mjs', ['run', phase], exit), ran: (rel, name) => fs.existsSync(path.join(dir, rel, `.fake-${name}`)) };
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
  const P = workspace('python', { ...files, 'services/api/coverage.json': JSON.stringify({ totals: { percent_covered: 90, num_statements: 10 } }) }, { projectDir: 'services/api' });
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

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`アダプタの対象の試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`アダプタの対象の試験: ${checks} 件が期待と一致しました`);
