// python アダプタ(pip)の依存の取得。adapters/python.json の install から、製品のコードの所在(projectDir)で呼ばれる。
//
//   node "{root}/scripts/gate/python-install.mjs"
//
// pyproject.toml の宣言を読み、次のとおり入れる(ツールを推測しない。宣言に無い形は失敗させる。process-compass #363):
//   - [build-system] がある: `pip install -e .`(extras dev があれば `.[dev]`)。PEP 735 の [dependency-groups] dev があれば `pip install --group dev` も行う
//   - [build-system] が無い: パッケージとして組まない(uv の既定のアプリの形と同じ扱い)。[project] の dependencies と、
//     extras dev と、[dependency-groups] dev だけを入れる。組まずに pip の既定(setuptools)へ倒すと、setuptools の自動の検出が
//     準拠テンプレートのディレクトリ(specs・context・adapters・profiles・templates)を最上位のパッケージとして拾い、失敗するため
//   - 開発用の依存(extras dev・[dependency-groups] dev)が無ければ失敗させる。poetry の依存の群([tool.poetry.group.dev])は
//     pip では入らないため、python-poetry のアダプタを選ぶよう案内する
//   - pyproject.toml が無く setup.py・setup.cfg がある: `pip install -e ".[dev]"`(従来どおり)
//   - requirements*.txt だけの形: 失敗させる(どのファイルを入れるかを推測しない)
// pyproject.toml の読み取りは python の tomllib(3.11 以降)で行う。
// ロックファイル(poetry.lock・uv.lock)は読まない。ロックどおりに入れるには python-poetry・python-uv のアダプタを選ぶ

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = process.cwd();
const py = process.env.PIT_IN_PYTHON || 'python';

function run(args, label) {
  console.log(`$ ${py} ${args.join(' ')}`);
  const r = spawnSync(py, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.log(`::error::python アダプタの依存の取得に失敗しました(${label})`);
    process.exit(r.status ?? 1);
  }
}
function stop(msg) {
  console.log(`::error::${msg}`);
  process.exit(1);
}

const has = (f) => fs.existsSync(path.join(cwd, f));

/** pyproject.toml を python の tomllib で読む(手書きの読み取りで宣言を取り違えないため) */
export function readPyproject(dir = cwd) {
  const r = spawnSync(py, ['-c', 'import json,sys,tomllib;print(json.dumps(tomllib.load(open("pyproject.toml","rb"))))'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) stop(`pyproject.toml を読めません(python 3.11 以降の tomllib を使います): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0]}`);
  return JSON.parse(r.stdout);
}

/** 宣言から、入れ方を決める。試験から呼べるよう純粋な関数にする。{ steps: [[pip の引数, 表示]], problem } */
export function planInstall(meta) {
  const extrasDev = meta?.project?.['optional-dependencies']?.dev;
  const groupDev = meta?.['dependency-groups']?.dev;
  const poetryGroup = meta?.tool?.poetry?.group?.dev;
  if (!Array.isArray(extrasDev) && !Array.isArray(groupDev)) {
    return {
      steps: [],
      problem: poetryGroup
        ? 'pyproject.toml の開発用の依存が poetry の依存の群([tool.poetry.group.dev])にあり、pip では入りません。アダプタ python-poetry を /process-change(種別 settings の settings.stack)で選んでください'
        : 'pyproject.toml に開発用の依存(extras dev の [project.optional-dependencies] dev、または PEP 735 の [dependency-groups] dev)がありません。テスト・カバレッジ・静的解析の道具(pytest・pytest-cov・ruff・pip-audit・pip-licenses)をそこへ書いてください',
    };
  }
  const steps = [];
  if (meta['build-system']) {
    steps.push([['-m', 'pip', 'install', '-e', Array.isArray(extrasDev) ? '.[dev]' : '.'], '製品を editable で入れる']);
  } else {
    const deps = [...(Array.isArray(meta?.project?.dependencies) ? meta.project.dependencies : []), ...(Array.isArray(extrasDev) ? extrasDev : [])].filter((d) => typeof d === 'string' && d.trim());
    if (deps.length) steps.push([['-m', 'pip', 'install', ...deps], '[build-system] が無いため、パッケージとして組まず、宣言した依存だけを入れる']);
  }
  if (Array.isArray(groupDev)) steps.push([['-m', 'pip', 'install', '--group', 'dev'], 'PEP 735 の依存の群 dev を入れる(pip 25.1 以降)']);
  return { steps, problem: null };
}

function main() {
  run(['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip の更新');
  if (has('pyproject.toml')) {
    const meta = readPyproject();
    const { steps, problem } = planInstall(meta);
    if (problem) stop(problem);
    if (!meta['build-system']) console.log('::notice::pyproject.toml に [build-system] が無いため、製品をパッケージとして組まずに、宣言した依存だけを入れます。テストは python -m pytest で実行します(所在が sys.path に入る)');
    for (const [args, label] of steps) run(args, label);
    return;
  }
  if (has('setup.py') || has('setup.cfg')) {
    run(['-m', 'pip', 'install', '-e', '.[dev]'], '製品を editable で入れる');
    return;
  }
  stop('python アダプタは、pyproject.toml か setup.py・setup.cfg を要します。requirements*.txt だけの形では、どのファイルを入れるかを推測しません。adapters/python.json の install を、使うファイルに合わせて書き換えてください(統制の設定の変更)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
