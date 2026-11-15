// ship-evidence.yml の手順の本文を取り出し、偽の gh で実際に動かす試験(process-compass #333 / ADR-0135。IMPL-0246・IMPL-0521)
//
//   node scripts/gate/test-ship-evidence-steps.mjs
//
// 文字列の有無ではなく、手順の `run:` の本文を bash -e(GitHub Actions が shell を指定しない run に使う既定。
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax の jobs.<job_id>.steps[*].shell)で動かし、
// 出力と作られたファイルを確かめる。実機の GitHub では確かめていない(偽の gh の応答は試験が決める)。
//
// 固定する決定:
//   - 前回の証跡: 前回の実行の成果物を取れなくても手順は終わらず、基底ブランチの写しを digest の一覧と照合して読む。
//     一覧と一致しない写しは読まず理由を出す。読めるものが無いときは、見た場所と理由を出し、previous-source.json に残す(IMPL-0521)
//   - 取り込み: 実行の headSha が対象のコミットと一致するときだけ coverage-result を取り込む。license-scan が無くても
//     coverage-result の取り込みへ進む。dependency-diff は取り込まない(IMPL-0246)
//   - verify の検査: 追加だけ・出荷の PR だけが運ぶ・出荷の PR には一式がある・digest の一覧との一致(IMPL-0521)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ship-evidence.yml'), 'utf8').replace(/\r\n/g, '\n');
const MANIFEST_SCRIPT = path.join(here, 'evidence-manifest.mjs');

let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : `\n       ${String(detail).slice(0, 600)}`}`);
  if (!cond) failed++;
}

const bashProbe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
if (bashProbe.status !== 0 || !/ok/.test(bashProbe.stdout ?? '')) {
  console.log('SKIP bash が使えないため、手順の本文を動かす試験を行いません(CI の ubuntu-latest では動く)');
  process.exit(0);
}

/** `- name: <name>` の手順(n 番目。0 起点)の run の本文を返す。${{ }} は試験の値へ置き換え、知らない式は例外にする */
function stepBody(name, nth = 0) {
  const lines = WF.split('\n');
  const idxs = lines.map((l, i) => (l.trim() === `- name: ${name}` ? i : -1)).filter((i) => i >= 0);
  if (idxs[nth] === undefined) throw new Error(`手順 ${name} (${nth}) がありません`);
  let i = idxs[nth];
  while (i < lines.length && !/^\s+run: \|\s*$/.test(lines[i])) i++;
  const body = [];
  for (i++; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      body.push('');
      continue;
    }
    if (!lines[i].startsWith('          ')) break;
    body.push(lines[i].slice(10));
  }
  const text = body.join('\n').replace(/\$\{\{\s*github\.repository\s*\}\}/g, 'o/r').replace(/\$\{\{\s*github\.run_id\s*\}\}/g, '999');
  const unknown = text.match(/\$\{\{[^}]*\}\}/);
  if (unknown) throw new Error(`手順 ${name}: 試験が置き換えられない式 ${unknown[0]}`);
  return text;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipsteps-'));
const binDir = path.join(tmpRoot, 'bin');
fs.mkdirSync(binDir);
// 偽の gh。run list は FAKE_RUN を、run view は FAKE_SHA を返し、run download は FAKE_ARTIFACTS に名前があるときだけ成功する
fs.writeFileSync(
  path.join(binDir, 'gh'),
  `#!/usr/bin/env bash
case "$1 $2" in
  "run list") [ -n "$FAKE_RUN" ] && echo "$FAKE_RUN"; exit 0 ;;
  "run view") [ "$FAKE_VIEW_FAIL" = 1 ] && exit 1; echo "$FAKE_SHA"; exit 0 ;;
  "run download")
    name=''; dir=''
    while [ $# -gt 0 ]; do case "$1" in --name) name=$2; shift ;; --dir) dir=$2; shift ;; esac; shift; done
    case " $FAKE_ARTIFACTS " in *" $name "*) mkdir -p "$dir"; echo '{}' > "$dir/$name.json"; [ "$name" = ship-evidence ] && echo '{"from":"artifact"}' > "$dir/evidence.json"; exit 0 ;; esac
    echo "no artifact $name" >&2; exit 1 ;;
esac
exit 1
`,
  { mode: 0o755 },
);

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** scripts/gate/evidence-manifest.mjs を持つ作業用のリポジトリを作る */
function mkRepo() {
  const d = fs.mkdtempSync(path.join(tmpRoot, 'w-'));
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 't');
  git(d, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(d, 'scripts', 'gate'), { recursive: true });
  fs.copyFileSync(MANIFEST_SCRIPT, path.join(d, 'scripts', 'gate', 'evidence-manifest.mjs'));
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}

function runStep(cwd, body, env = {}) {
  const f = path.join(tmpRoot, `step-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(f, body);
  const r = spawnSync('bash', ['-e', f.replace(/\\/g, '/')], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, GH_TOKEN: 'x', TO: '', FAKE_RUN: '', FAKE_SHA: '', FAKE_VIEW_FAIL: '', FAKE_ARTIFACTS: '', ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 置き場 docs/evidence/<name>/ に evidence.json と manifest.json を作る(recordedAt を差し替える) */
function bundle(cwd, name, recordedAt, content) {
  const d = path.join(cwd, 'docs', 'evidence', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'evidence.json'), `${JSON.stringify({ ...content, range: { from: 'v0', to: 'v1', toCommit: 'abc' } })}\n`);
  const r = spawnSync(process.execPath, [MANIFEST_SCRIPT, 'write', '--dir', d, '--run', '1'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const mp = path.join(d, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.recordedAt = recordedAt;
  fs.writeFileSync(mp, `${JSON.stringify(m, null, 2)}\n`);
}
const readPrev = (cwd) => {
  const p = path.join(cwd, 'evidence', 'previous', 'evidence.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
const readSource = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, 'evidence', 'previous-source.json'), 'utf8'));

// --- 前回の証跡(IMPL-0521:ng / IMPL-0521:ok) ---
const prevBody = stepBody('前回の出荷の証跡を取り込む');
{
  const d = mkRepo();
  bundle(d, 'b1', '2026-08-01T00:00:00.000Z', { from: 'copy-old' });
  bundle(d, 'b2', '2026-09-01T00:00:00.000Z', { from: 'copy-new' });
  const r = runStep(d, prevBody, { FAKE_RUN: '123', FAKE_ARTIFACTS: '' });
  // IMPL-0521:ng(違反側。前回の実行の成果物を取れないと手順が終わり、写しを読まない形)
  check('IMPL-0521:ng 前回の実行の成果物を取れなくても手順は終わらず、新しい側の写しを読む', r.status === 0 && readPrev(d)?.from === 'copy-new' && /リポジトリの写し\(docs\/evidence\/b2\)/.test(r.out), r.out);
  check('IMPL-0521:ng 成果物を取れなかった旨を警告に出す', /実行 123 の成果物 ship-evidence を取得できません/.test(r.out) && readSource(d).source === 'copy', r.out);
}
{
  const d = mkRepo();
  bundle(d, 'b1', '2026-08-01T00:00:00.000Z', { from: 'copy-old' });
  bundle(d, 'b2', '2026-09-01T00:00:00.000Z', { from: 'copy-new' });
  fs.writeFileSync(path.join(d, 'docs', 'evidence', 'b2', 'manifest.json'), '{broken');
  const r = runStep(d, prevBody, { FAKE_RUN: '' });
  check('IMPL-0521:ng 新しい側の一覧が壊れていれば、黙って古い側へ進まず、読まなかった理由を警告に出す', r.status === 0 && readPrev(d)?.from === 'copy-old' && /b2 は読みませんでした/.test(r.out), r.out);
}
{
  const d = mkRepo();
  bundle(d, 'b2', '2026-09-01T00:00:00.000Z', { from: 'copy-new' });
  fs.writeFileSync(path.join(d, 'docs', 'evidence', 'b2', 'evidence.json'), '{"from":"TAMPERED"}\n');
  const r = runStep(d, prevBody, { FAKE_RUN: '' });
  const s = readSource(d);
  check('IMPL-0521:ng 一覧と一致しない写しは読まず、見た場所と理由を出す', r.status === 0 && readPrev(d) === null && s.source === 'none' && /b2/.test(r.out) && /sha256/.test(r.out) && s.copies.looked.length === 1, r.out);
}
{
  const d = mkRepo();
  const r = runStep(d, prevBody, { FAKE_RUN: '' });
  check('IMPL-0521:ng 写しも無いときは、見た場所(置き場 0 件)を警告に出す', r.status === 0 && readPrev(d) === null && /置き場 0 件を見て、読めるものがありません/.test(r.out) && readSource(d).source === 'none', r.out);
}
{
  const d = mkRepo();
  bundle(d, 'b2', '2026-09-01T00:00:00.000Z', { from: 'copy-new' });
  const r = runStep(d, prevBody, { FAKE_RUN: '123', FAKE_ARTIFACTS: 'ship-evidence' });
  check('IMPL-0521:ok 前回の実行の成果物を取れたら成果物を読む(写しは読まない)', r.status === 0 && readPrev(d)?.from === 'artifact' && readSource(d).source === 'artifact', r.out);
}

// --- 取り込み(IMPL-0246:ng / IMPL-0246:ok) ---
const intakeBody = stepBody('知財潔白性の検査記録を gate-g5 の実行から取り込む', 0);
const verifyIntakeBody = stepBody('知財潔白性の検査記録を gate-g5 の実行から取り込む', 1);
for (const [label, body] of [['evidence ジョブ', intakeBody], ['verify ジョブ', verifyIntakeBody]]) {
  const files = (d) => (fs.existsSync(path.join(d, 'evidence')) ? fs.readdirSync(path.join(d, 'evidence')).sort().join(',') : '');
  {
    const d = mkRepo();
    const sha = git(d, 'rev-parse', 'HEAD');
    const r = runStep(d, body, { FAKE_RUN: '55', FAKE_SHA: sha, FAKE_ARTIFACTS: 'license-scan test-results coverage-result dependency-diff' });
    check(`IMPL-0246:ok ${label}: headSha が一致すれば coverage-result を取り込み、dependency-diff は取り込まない`, r.status === 0 && /coverage-result\.json/.test(files(d)) && !/dependency-diff/.test(files(d)), `${files(d)}\n${r.out}`);
  }
  {
    const d = mkRepo();
    const r = runStep(d, body, { FAKE_RUN: '55', FAKE_SHA: 'deadbeef', FAKE_ARTIFACTS: 'license-scan test-results coverage-result' });
    check(`IMPL-0246:ng ${label}: headSha が対象と一致しなければ何も取り込まない`, r.status === 0 && files(d) === '' && /一致しません/.test(r.out), `${files(d)}\n${r.out}`);
  }
  {
    const d = mkRepo();
    const r = runStep(d, body, { FAKE_RUN: '55', FAKE_VIEW_FAIL: '1', FAKE_ARTIFACTS: 'license-scan test-results coverage-result' });
    check(`IMPL-0246:ng ${label}: 実行の headSha を読めなければ何も取り込まない`, r.status === 0 && files(d) === '', `${files(d)}\n${r.out}`);
  }
  {
    const d = mkRepo();
    const sha = git(d, 'rev-parse', 'HEAD');
    const r = runStep(d, body, { FAKE_RUN: '55', FAKE_SHA: sha, FAKE_ARTIFACTS: 'test-results coverage-result' });
    check(`IMPL-0246:ok ${label}: license-scan が無くても coverage-result の取り込みへ進む`, r.status === 0 && /coverage-result\.json/.test(files(d)) && /license-scan がありません/.test(r.out), `${files(d)}\n${r.out}`);
  }
}
{
  const d = mkRepo();
  const sha = git(d, 'rev-parse', 'HEAD');
  runStep(d, intakeBody, { FAKE_RUN: '55', FAKE_SHA: sha, FAKE_ARTIFACTS: 'license-scan coverage-result' });
  const inputs = JSON.parse(fs.readFileSync(path.join(d, 'evidence', 'inputs.json'), 'utf8'));
  check('IMPL-0246:ok 取り込み元(実行の識別と headSha)を inputs.json に残す', inputs.gateG5Run === '55' && inputs.headSha === sha);
}

// --- verify の一式の検査(IMPL-0521:ng / IMPL-0521:ok)。手順の本文を、基底ブランチ(origin/main)と PR の head(pr-head)の間で動かす ---
const compareBody = stepBody('複製が記録用ブランチと一致することを検査する');
function shipScenario({ ship, prepare }) {
  const d = mkRepo();
  git(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(d, 'checkout', '-q', '-b', 'pr-head');
  prepare(d);
  git(d, 'add', '-A', '-f');
  git(d, 'commit', '-q', '-m', 'pr');
  git(d, 'checkout', '-q', 'main');
  const out = path.join(d, 'gh-output.txt');
  fs.writeFileSync(out, '');
  // 手順は /tmp を使う(ワークフローの実行環境の既定)。Windows の bash でも /tmp は使える
  return runStep(d, compareBody, { BASE: 'main', SHIP: ship ? 'true' : 'false', GITHUB_OUTPUT: out.replace(/\\/g, '/'), RECORDS_BRANCH: 'records' });
}
const addShipFiles = (d, name = '2026-11-15-start..v1', { mdOnly = false } = {}) => {
  fs.mkdirSync(path.join(d, 'docs', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs', 'evidence', `${name}.md`), '# 品質レポート\n');
  if (!mdOnly) bundle(d, name, '2026-11-15T00:00:00.000Z', { x: 1 });
};
{
  const r = shipScenario({ ship: true, prepare: (d) => addShipFiles(d) });
  check('IMPL-0521:ok 出荷の PR が一式と一致する digest の一覧を追加すると通る', r.status === 0, r.out);
}
{
  const r = shipScenario({
    ship: true,
    prepare: (d) => {
      addShipFiles(d);
      fs.appendFileSync(path.join(d, 'docs', 'evidence', '2026-11-15-start..v1', 'evidence.json'), ' ');
    },
  });
  check('IMPL-0521:ng 一式の中身を一覧と食い違わせると失敗する', r.status !== 0 && /digest の一覧と一致しない/.test(r.out), r.out);
}
{
  const r = shipScenario({ ship: true, prepare: (d) => addShipFiles(d, 'x', { mdOnly: true }) });
  check('IMPL-0521:ng 出荷の PR に一式の置き場が無いと失敗する(写しの存在)', r.status !== 0 && /一式の欠け/.test(r.out), r.out);
}
{
  const r = shipScenario({
    ship: true,
    prepare: (d) => {
      addShipFiles(d);
      fs.unlinkSync(path.join(d, 'docs', 'evidence', '2026-11-15-start..v1', 'evidence.json'));
      spawnSync(process.execPath, [MANIFEST_SCRIPT, 'write', '--dir', path.join(d, 'docs', 'evidence', '2026-11-15-start..v1'), '--run', '1']);
    },
  });
  check('IMPL-0521:ng 一覧を作り直しても evidence.json が無い一式は失敗する(一式の欠け)', r.status !== 0 && /evidence\.json がありません/.test(r.out), r.out);
}
{
  const r = shipScenario({ ship: false, prepare: (d) => addShipFiles(d) });
  check('IMPL-0521:ng 出荷の PR 以外が一式を足すと失敗する', r.status !== 0 && /運ぶのは出荷の PR/.test(r.out), r.out);
}
{
  const d0 = mkRepo();
  bundle(d0, 'old', '2026-10-01T00:00:00.000Z', { x: 0 });
  git(d0, 'add', '-A', '-f');
  git(d0, 'commit', '-q', '-m', 'old bundle');
  git(d0, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(d0, 'checkout', '-q', '-b', 'pr-head');
  fs.writeFileSync(path.join(d0, 'docs', 'evidence', 'old', 'evidence.json'), '{"x":9}\n');
  git(d0, 'add', '-A', '-f');
  git(d0, 'commit', '-q', '-m', 'edit');
  git(d0, 'checkout', '-q', 'main');
  const out = path.join(d0, 'gh-output.txt');
  fs.writeFileSync(out, '');
  const r = runStep(d0, compareBody, { BASE: 'main', SHIP: 'true', GITHUB_OUTPUT: out.replace(/\\/g, '/'), RECORDS_BRANCH: 'records' });
  check('IMPL-0521:ng 基底ブランチにある一式の変更(追加以外)は失敗する', r.status !== 0 && /追加以外の変更\(M\)/.test(r.out), r.out);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\nship-evidence の手順の本文の試験: すべて通過');
