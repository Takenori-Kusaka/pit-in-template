// 欠陥注入の標識の走査(seeded-error-scan.mjs)と、集約の走査の記録の検査(readSeededScan)の試験
// (標準 第5章 5.6.2 の第3層・第4層。process-compass #356 / IMPL-0047・IMPL-0192)
//
//   node scripts/gate/test-seeded-error-scan.mjs
//
// 固定する決定:
//   - 走査は、範囲の全コミットの本文(%B)に標識の行があるかを見る。merge・rebase・squash(既定の文)・cherry-pick の4通りで拾う。
//     標識の無い範囲は通る(ok と ng の対)
//   - 台帳は --ledger で渡したときだけ読む。未回収の識別子が差分にある・期限を超えた未回収は失敗。渡さなければ ledgerChecked は false
//   - 集約は、記録の欠落・scanRun が true でない・residual が 0 でない・範囲の不一致を欠落にする(4つの ng と ok)
//   - 壊して確かめる: 標識の照合を外した版・集約の欠落の判定を外した版では、ng の場面が通ってしまう(試験が照合を確かめている証拠)
// 違反と適合の対(標準の実装マーク。process-compass #356):
//   IMPL-0047:ng 標識を持つコミットを merge・rebase・squash・cherry-pick で運んだ範囲は、走査が失敗する(T-1)。台帳の未回収・期限超過も失敗する(T-2)
//   IMPL-0047:ok 標識の無い範囲は通る。台帳の回収済み・期限内も通る
//   IMPL-0192:ng 走査の記録の欠落・scanRun が true でない・residual が 0 でない・範囲の不一致は、集約の欠落になる(T-5)
//   IMPL-0192:ok 正しい記録は集約を通る
// 確かめていないこと: GitHub 上の squash(文を書き換えたもの)。手元の git の既定の文だけを確かめる。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(here, 'seeded-error-scan.mjs');
const AGG = path.join(here, 'aggregate-evidence.mjs');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seedscan-'));
let failed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : `\n       ${String(detail).slice(0, 500)}`}`);
  if (!cond) failed++;
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
let n = 0;
function mkRepo() {
  const d = path.join(tmpRoot, `r${++n}`);
  fs.mkdirSync(d);
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 't');
  git(d, 'config', 'core.autocrlf', 'false');
  git(d, 'config', 'commit.gpgsign', 'false');
  commit(d, 'a.txt', 'a\n', 'init');
  git(d, 'tag', 'v1');
  return d;
}
function commit(d, file, text, msg) {
  fs.writeFileSync(path.join(d, file), text);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', msg);
}
const MARK = 'Seeded-Error: INJ-0001';
function runScan(d, script, extra = []) {
  const out = path.join(d, 'scan-out.json');
  const r = spawnSync(process.execPath, [script, '--from', 'v1', '--to', 'v2', '--out', out, ...extra], { cwd: d, encoding: 'utf8' });
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch {
    rec = null;
  }
  return { code: r.status, rec, err: r.stderr, out: r.stdout };
}

/** 標識を持つ変更を、取り込みの方法ごとに v2 まで運ぶリポジトリを作る */
const WAYS = {
  merge(d) {
    git(d, 'checkout', '-q', '-b', 'feat');
    commit(d, 'f.txt', 'f\n', `feat: x\n\n${MARK}`);
    git(d, 'checkout', '-q', 'main');
    commit(d, 'm.txt', 'm\n', 'chore: main moves');
    git(d, 'merge', '--no-ff', '-q', '-m', 'Merge feat', 'feat');
  },
  rebase(d) {
    git(d, 'checkout', '-q', '-b', 'feat');
    commit(d, 'f.txt', 'f\n', `feat: x\n\n${MARK}`);
    git(d, 'checkout', '-q', 'main');
    commit(d, 'm.txt', 'm\n', 'chore: main moves');
    git(d, 'checkout', '-q', 'feat');
    git(d, 'rebase', '-q', 'main');
    git(d, 'checkout', '-q', 'main');
    git(d, 'merge', '--ff-only', '-q', 'feat');
  },
  squash(d) {
    git(d, 'checkout', '-q', '-b', 'feat');
    commit(d, 'f.txt', 'f\n', `feat: x\n\n${MARK}`);
    git(d, 'checkout', '-q', 'main');
    git(d, 'merge', '--squash', '-q', 'feat');
    // 既定の文(Squashed commit of the following: …)をそのまま使う
    const msg = fs.readFileSync(path.join(d, '.git', 'SQUASH_MSG'), 'utf8');
    git(d, 'commit', '-q', '-F', path.join(d, '.git', 'SQUASH_MSG'));
    return msg;
  },
  cherry(d) {
    git(d, 'checkout', '-q', '-b', 'feat');
    commit(d, 'f.txt', 'f\n', `feat: x\n\n${MARK}`);
    const sha = git(d, 'rev-parse', 'HEAD');
    git(d, 'checkout', '-q', 'main');
    git(d, 'cherry-pick', sha);
  },
};

for (const [way, fn] of Object.entries(WAYS)) {
  const d = mkRepo();
  fn(d);
  git(d, 'tag', 'v2');
  const r = runScan(d, SCAN);
  check(`T-1 ${way}: 標識を拾って失敗する(ng)`, r.code === 1 && r.rec?.residual >= 1 && r.rec?.scanRun === true && /Seeded-Error:/.test(r.err), `code=${r.code} ${JSON.stringify(r.rec?.residual)} ${r.err}`);
  check(`T-1 ${way}: 失敗の文に偽の失敗への手当て(本文から語を外す・例外承認)を出す`, /本文から語を外すか、第7章の例外承認/.test(r.err));
}

// ok: 標識の無い範囲。インデントや大文字小文字を変えた行は標識として拾う(行頭の空白を許す)
{
  const d = mkRepo();
  commit(d, 'f.txt', 'f\n', 'feat: clean\n\n説明だけ。seeded-error という語は文中なら拾わない');
  git(d, 'tag', 'v2');
  const r = runScan(d, SCAN);
  check('T-1 標識の無い範囲は通る(ok)', r.code === 0 && r.rec?.residual === 0 && r.rec?.scanRun === true && r.rec?.statement === '標識の残存なし(手で写した変更は走査の対象外)', JSON.stringify(r.rec));
  check('T-3 記録に scanRun・residual・ledgerChecked・range・scannedAt があり、「流出なし」と書かない', ['scanRun', 'residual', 'ledgerChecked', 'range', 'scannedAt'].every((k) => k in r.rec) && !/流出なし/.test(JSON.stringify(r.rec).replace(/流出がないとは記録しない/g, '')) && r.rec.ledgerChecked === false && /台帳と照合していない/.test(r.rec.ledgerNote));
}
{
  const d = mkRepo();
  commit(d, 'f.txt', 'f\n', `feat: indented\n\n    ${MARK}`);
  git(d, 'tag', 'v2');
  const r = runScan(d, SCAN);
  check('T-1 行頭に空白がある標識の行も拾う', r.code === 1 && r.rec?.residual === 1);
}

// T-2 台帳
{
  const d = mkRepo();
  commit(d, 'f.txt', 'line INJ-7777 here\n', 'feat: x');
  git(d, 'tag', 'v2');
  const outside = path.join(tmpRoot, 'ledger-ng1.json');
  fs.writeFileSync(outside, JSON.stringify([{ id: 'INJ-7777', expiresAt: '2999-01-01', reclaimedAt: null }]));
  const r = runScan(d, SCAN, ['--ledger', outside]);
  check('T-2 未回収の識別子が差分にある台帳は失敗する(ng)', r.code === 1 && r.rec?.ledgerChecked === true && r.rec?.residual === 1 && /範囲の差分/.test(r.err), r.err);

  const expired = path.join(tmpRoot, 'ledger-ng2.json');
  fs.writeFileSync(expired, JSON.stringify([{ id: 'INJ-0042', expiresAt: '2020-01-01', reclaimedAt: null }]));
  const r2 = runScan(d, SCAN, ['--ledger', expired]);
  check('T-2 期限を超えた未回収は失敗する(ng)', r2.code === 1 && /期限\(2020-01-01\)を超えた未回収/.test(r2.err), r2.err);

  const okLedger = path.join(tmpRoot, 'ledger-ok.json');
  fs.writeFileSync(okLedger, JSON.stringify([{ id: 'INJ-7777', expiresAt: '2020-01-01', reclaimedAt: '2020-01-02' }, { id: 'INJ-0042', expiresAt: '2999-01-01', reclaimedAt: null }]));
  const r3 = runScan(d, SCAN, ['--ledger', okLedger]);
  check('T-2 回収済み・期限内で差分に無い台帳は通る(ok)', r3.code === 0 && r3.rec?.ledgerChecked === true && r3.rec?.residual === 0, r3.err);

  const r4 = runScan(d, SCAN);
  check('T-2 台帳なしは失敗にせず「台帳と照合していない」を出す', r4.code === 0 && r4.rec?.ledgerChecked === false && /台帳と照合していない/.test(r4.out));

  const inRepo = path.join(d, 'ledger-in.json');
  fs.writeFileSync(inRepo, '[]');
  const r5 = runScan(d, SCAN, ['--ledger', inRepo]);
  check('T-2 リポジトリの中の台帳は拒否する', r5.code === 1 && /リポジトリの中/.test(r5.err));
  check('T-2 台帳を渡したのに読めないときは、走査を成立させない(scanRun false・failures あり。残存なしと書かない)(ng)', r5.rec?.scanRun === false && r5.rec?.failures?.length > 0 && !/残存なし/.test(r5.out + JSON.stringify(r5.rec.statement)));
  const bad = path.join(tmpRoot, 'ledger-bad.json');
  fs.writeFileSync(bad, '{ not json');
  const r6 = runScan(d, SCAN, ['--ledger', bad]);
  check('T-2 壊れた台帳は失敗し、scanRun は false', r6.code === 1 && r6.rec?.scanRun === false && /台帳を読めません/.test(r6.err));
  const sid = path.join(tmpRoot, 'ledger-sid.json');
  fs.writeFileSync(sid, JSON.stringify([{ id: '1', expiresAt: '2999-01-01' }, { id: 'SE-1', expiresAt: '2999-01-01' }]));
  const r7 = runScan(d, SCAN, ['--ledger', sid]);
  check('T-2 識別子は追加の行を語の境界で照合する(ハンクの見出しの数字や SE-10 の部分一致で偽の失敗にしない)', r7.code === 0 && r7.rec?.residual === 0, r7.err);
}

// 識別子の境界は英数字だけ。- と _ は境界に数える(ファイル名・変数名に含めた識別子を拾う)
for (const [name, file, want] of [['SE-1-fix.js', 'SE-1-fix.js', 1], ['inject_SE-1', 'inject_SE-1', 1], ['SE-10 は SE-1 として拾わない', 'SE-10.js', 0]]) {
  const d = mkRepo();
  commit(d, 'g.txt', `seeded/${file}\n`, 'feat: add');
  git(d, 'tag', 'v2');
  const led = path.join(tmpRoot, `ledger-b${n}.json`);
  fs.writeFileSync(led, JSON.stringify([{ id: 'SE-1', expiresAt: '2999-01-01' }]));
  const r = runScan(d, SCAN, ['--ledger', led]);
  check(`T-2 識別子の境界: ${name}`, want ? r.code === 1 && r.rec?.ledgerFindings?.length >= 1 : r.code === 0 && r.rec?.ledgerFindings?.length === 0, `code=${r.code} ${r.err}`);
}

// 浅い clone では走査を成立させず失敗する(ng)
{
  const d = mkRepo();
  commit(d, 'f.txt', 'f\n', 'feat: a');
  commit(d, 'g.txt', 'g\n', 'feat: b');
  git(d, 'tag', 'v2');
  const sh = path.join(tmpRoot, `shallow${n}`);
  git(tmpRoot, 'clone', '-q', '--depth', '1', 'file://' + d.replace(/\\/g, '/'), sh);
  git(sh, 'fetch', '-q', '--depth=1', 'origin', 'refs/tags/v1:refs/tags/v1', 'refs/tags/v2:refs/tags/v2');
  const r = runScan(sh, SCAN);
  check('T-4 浅い clone は走査を成立させず失敗する(scanRun false・failures あり)(ng)', r.code === 1 && r.rec?.scanRun === false && r.rec?.failures?.length > 0 && /浅い clone/.test(r.err), `code=${r.code} ${r.err}`);
}

// 壊して確かめる(1): 標識の照合を外した版では、4通りの ng が通ってしまう
{
  const src = fs.readFileSync(SCAN, 'utf8');
  const needle = 'record.markerCommits = commits.filter((c) => hasMarker(c.body)).map((c) => c.sha);';
  check('壊す箇所(標識の照合)が走査の中にある', src.includes(needle));
  const mutant = path.join(here, 'seeded-error-scan.mutant.tmp.mjs');
  fs.writeFileSync(mutant, src.replace(needle, 'record.markerCommits = [];'));
  try {
    for (const [way, fn] of Object.entries(WAYS)) {
      const d = mkRepo();
      fn(d);
      git(d, 'tag', 'v2');
      const r = runScan(d, mutant);
      check(`壊した版(標識の照合を外す)では ${way} の ng が通ってしまう(試験が照合を確かめている)`, r.code === 0 && r.rec?.residual === 0);
    }
  } finally {
    fs.rmSync(mutant, { force: true });
  }
}

// T-5 集約の検査
const { readSeededScan } = await import(pathToFileURL(AGG).href);
function aggCheck(d, rec, mod = readSeededScan) {
  fs.mkdirSync(path.join(d, 'evidence'), { recursive: true });
  const f = path.join(d, 'evidence', 'seeded-error-scan.json');
  fs.rmSync(f, { force: true });
  if (rec !== undefined) fs.writeFileSync(f, typeof rec === 'string' ? rec : JSON.stringify(rec));
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: d, encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
  };
  return mod({ exists: (p) => fs.existsSync(path.join(d, p)), root: d, git: g, to: 'v2', from: 'v1', period: null });
}
{
  const d = mkRepo();
  commit(d, 'f.txt', 'f\n', 'feat: clean');
  git(d, 'tag', 'v2');
  const good = runScan(d, SCAN).rec;
  const ok = aggCheck(d, good);
  check('T-5 正しい記録は通る(ok)', ok.problems.length === 0 && /標識の残存なし/.test(ok.line) && /流出がないことは示さない/.test(ok.line), JSON.stringify(ok));
  check('T-5 項目6(検出率)とは別の行に出す(「標識の走査」の行・summary)', /^標識の残存なし/.test(ok.line) && ok.summary.scanRun === true);
  const ngs = {
    '記録の欠落': undefined,
    '読めない JSON': '{not json',
    'scanRun が true でない': { ...good, scanRun: false },
    '失敗の理由(failures)がある': { ...good, failures: ['台帳を読めません'] },
    'residual が 0 でない': { ...good, residual: 1 },
    'residual が整数でない': { ...good, residual: '0' },
    '終点の SHA が合わない': { ...good, range: { ...good.range, toSha: 'deadbeef' } },
    '起点の SHA が合わない': { ...good, range: { ...good.range, fromSha: null } },
  };
  for (const [name, rec] of Object.entries(ngs)) {
    const r = aggCheck(d, rec);
    check(`T-5 ${name}は欠落になる(ng)`, r.problems.length >= 1 && /欠陥注入の標識の走査/.test(r.problems[0]), JSON.stringify(r.problems));
  }
  const per = readSeededScan({ exists: () => false, root: d, git: () => null, to: 'v2', from: 'v1', period: { from: '2026-01-01', to: '2026-01-31' } });
  check('T-5 期間の集約は対象外(走査の記録を要求しない)', per.problems.length === 0);

  // 壊して確かめる(2): 集約の欠落の判定を外した版では、欠落・residual・範囲の ng が通ってしまう
  const src = fs.readFileSync(AGG, 'utf8');
  const cuts = [
    ["if (!exists(file)) why.push(`走査の記録 ${file} がありません`);", 'if (false) why.push("");'],
    ["if (rec.scanRun !== true) why.push(", 'if (false) why.push('],
    ["if (!Number.isInteger(rec.residual) || rec.residual !== 0) why.push(", 'if (false) why.push('],
    ["if (!toSha || rec.range?.toSha !== toSha) why.push(", 'if (false) why.push('],
  ];
  const caseFor = [undefined, { ...good, scanRun: false }, { ...good, residual: 1 }, { ...good, range: { ...good.range, toSha: 'deadbeef' } }];
  const names = ['記録の欠落', 'scanRun', 'residual', '範囲の終点'];
  for (let i = 0; i < cuts.length; i++) {
    check(`壊す箇所(${names[i]}の判定)が集約の中にある`, src.includes(cuts[i][0]));
    const mutant = path.join(here, 'aggregate-evidence.mutant.tmp.mjs');
    // 記録の欠落の判定は、読めない JSON の判定が二重に守っている。壊す版は両方を外す
    let mut = src.replace(cuts[i][0], cuts[i][1]);
    if (i === 0) mut = mut.replace('why.push(`走査の記録 ${file} を JSON として読めません`);', ';');
    fs.writeFileSync(mutant, mut);
    try {
      const mod = (await import(pathToFileURL(mutant).href + `?m=${i}`)).readSeededScan;
      const r = aggCheck(d, caseFor[i], mod);
      check(`壊した版(${names[i]}の判定を外す)では ng が通ってしまう(試験が判定を確かめている)`, r.problems.length === 0, JSON.stringify(r.problems));
    } finally {
      fs.rmSync(mutant, { force: true });
    }
  }
}


// T-4 ワークフロー: タグの実行(evidence ジョブ)で、集約の前に、条件なしで走査を走らせる。verify ジョブも集約の前に走査し直す
{
  const NL = String.fromCharCode(10);
  const wf = fs.readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'ship-evidence.yml'), 'utf8').split(String.fromCharCode(13)).join('');
  const lines = wf.split(NL);
  const idx = (name, from = 0) => lines.findIndex((l, i) => i >= from && l.trim() === `- name: ${name}`);
  const verifyAt = lines.findIndex((l) => l.startsWith('  verify:'));
  const scan1 = idx('標識の残存を走査する');
  const agg1 = idx('証跡を集約する');
  check('T-4 evidence ジョブ: 走査の手順が集約の手順より前にあり、verify ジョブより前にある', scan1 > 0 && agg1 > scan1 && agg1 < verifyAt);
  const block = lines.slice(scan1, scan1 + 9);
  check('T-4 走査の手順に if: 条件が無い(演習の有無に依らず毎回走る)・continue-on-error も無い', !block.some((l) => l.trim().startsWith('if:')) && !block.some((l) => l.includes('continue-on-error')));
  const scan2 = idx('標識の残存を走査し直す', verifyAt);
  const agg2 = idx('証跡を集約し直す', verifyAt);
  check('T-4 verify ジョブ: 集約の再実行の前に走査し直す', scan2 > verifyAt && agg2 > scan2);
  // 手順の本文を bash で動かす(走査の記録が集約の読む場所に出る)
  const body = [];
  for (let i = scan1; i < lines.length; i++) {
    if (lines[i].trim() === 'run: |') {
      for (let j = i + 1; lines[j].startsWith('          '); j++) body.push(lines[j].slice(10));
      break;
    }
  }
  const d = mkRepo();
  commit(d, 'f.txt', 'f' + NL, 'feat: clean');
  git(d, 'tag', 'v2');
  fs.mkdirSync(path.join(d, 'scripts', 'gate'), { recursive: true });
  fs.copyFileSync(SCAN, path.join(d, 'scripts', 'gate', 'seeded-error-scan.mjs'));
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const r = spawnSync('bash', ['-e', '-c', body.join(NL)], { cwd: d, encoding: 'utf8', env: { ...process.env, FROM: 'v1', TO: 'v2' } });
    check('T-4 手順の本文を bash -e で動かすと evidence/seeded-error-scan.json ができ、residual は 0(演習をしない採用者の出荷が通る)', r.status === 0 && JSON.parse(fs.readFileSync(path.join(d, 'evidence', 'seeded-error-scan.json'), 'utf8')).residual === 0, r.stderr);
  } else console.log('SKIP bash が使えないため、手順の本文を動かす場面を省く');
}

// T-7 基準の様式の行「注入の事前周知の記録の所在」: 未記入(様式の説明のまま)なら run の基準の読み取りが問題を返し、実行を止める。
// 記入済みなら問題にしない。行を持たない旧い様式は止めない(env の行と同じ扱い。記録の節に「様式に行なし」と出る)
{
  const { readCriteria } = await import(pathToFileURL(path.join(here, 'adoption-trial.mjs')).href);
  const tpl = fs.readFileSync(path.join(here, '..', '..', 'templates', 'adoption-trial-criteria.md'), 'utf8').split(String.fromCharCode(13)).join('');
  const NOTICE = '注入の事前周知の記録の所在';
  const problemsFor = (text) => {
    const d = mkRepo();
    fs.mkdirSync(path.join(d, 'docs', 'adoption-trial'), { recursive: true });
    fs.writeFileSync(path.join(d, 'docs', 'adoption-trial', 'criteria.md'), text);
    git(d, 'add', '-A');
    git(d, 'commit', '-q', '-m', 'docs: criteria');
    return readCriteria({ root: d }).problems.filter((p) => p.includes(NOTICE));
  };
  const rowLine = tpl.split(String.fromCharCode(10)).find((l) => l.startsWith(`| ${NOTICE} |`));
  check('T-7 様式に行「注入の事前周知の記録の所在」がある', Boolean(rowLine));
  check('T-7 行が様式の説明のまま(未記入)なら、基準の読み取りが問題を返す(run を止める)(ng)', problemsFor(tpl).length === 1, JSON.stringify(problemsFor(tpl)));
  const filled = tpl.replace(rowLine, `| ${NOTICE} | docs/adoption-trial/notice.md |`);
  check('T-7 行が記入済みなら問題を返さない(ok)', problemsFor(filled).length === 0);
  const absent = tpl.split(String.fromCharCode(10)).filter((l) => !l.startsWith(`| ${NOTICE} |`)).join(String.fromCharCode(10));
  check('T-7 行を持たない旧い様式は止めない', problemsFor(absent).length === 0);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(failed ? `\n${failed} 件失敗` : '\nすべて通った');
process.exit(failed ? 1 : 0);
