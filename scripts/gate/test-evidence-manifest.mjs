// 証跡の一式の写しと digest の一覧の試験(process-compass #333 / ADR-0135。IMPL-0522)
//
//   node scripts/gate/test-evidence-manifest.mjs
//
// 固定する決定:
//   - 一式のファイルを変える・消す・manifest に無いファイルを足すと、verify が不一致を出す(違反側)
//   - verify ジョブの検査(evidenceChangeProblems)は、追加以外の変更・出荷の PR 以外が足した一式・出荷の PR の一式の欠け・
//     digest の不一致を失敗にし、一致する一式の追加では空を返す(違反と適合の対。ワークフローの本文を動かす試験は
//     test-ship-evidence-steps.mjs)
//   - 一覧の range・target は、置き場の evidence.json(集約の出力)から取る。読めなければ null
//   - 前回の証跡を写しから選ぶとき、一覧と一致しない置き場は読まない
//   - ship-evidence.yml の文字列の確認(workflowProblems): retention-days を明示しない・写しの手順・verify の呼び出し・取り込み・前回の読み先
// 一覧が示すのは置き場の自己整合だけで、保管期間の充足を示さない(IMPL-0243)。ワークフローが出した一式であることも示さない。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeManifest, verifyManifest, workflowProblems, evidenceChangeProblems, rangeFromEvidence, selectPreviousFromCopies } from './evidence-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
}

function freshBundle(parent = os.tmpdir(), name = null, at = '2026-11-15T00:00:00Z') {
  const dir = name ? path.join(parent, name) : fs.mkdtempSync(path.join(parent, 'evman-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence.json'), `${JSON.stringify({ a: 1, range: { from: 'v0', to: 'v1', toCommit: 'abc123' } })}\n`);
  fs.writeFileSync(path.join(dir, 'assurance-disclosure.external.md'), '# 開示\n');
  fs.writeFileSync(path.join(dir, 'inputs.json'), JSON.stringify({ gateG5Run: '123', headSha: 'abc' }));
  writeManifest({ dir, run: '9', now: new Date(at) });
  return dir;
}

// --- 適合側 ---
{
  const dir = freshBundle();
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  check('IMPL-0522:ok manifest は 3 件の digest と注記を持つ', m.files.length === 3 && /保管期間の充足は示さない/.test(m.note) && m.schemaVersion === 1);
  check('IMPL-0522:ok manifest の inputs は inputs.json の内容', m.inputs?.headSha === 'abc');
  check('IMPL-0522:ok manifest の range・target は置き場の evidence.json の実際の範囲と終点', m.range === 'v0..v1' && m.target === 'abc123');
  check('IMPL-0522:ok 変えていない一式で verify が通る', verifyManifest(dir).length === 0);
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evman-'));
  fs.writeFileSync(path.join(dir, 'evidence.json'), '{"a":1}\n');
  const r = rangeFromEvidence(dir);
  check('IMPL-0522:ok evidence.json に範囲が無ければ range・target は null(推定しない)', r.range === null && r.target === null);
}
{
  const text = fs.readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'ship-evidence.yml'), 'utf8');
  const ps = workflowProblems(text);
  // IMPL-0246:ok(適合側。今の ship-evidence.yml は coverage-result を取り込み、headSha を照合する。動作は test-ship-evidence-steps.mjs)
  check(`IMPL-0522:ok 今の ship-evidence.yml で workflowProblems が空${ps.length ? `(${ps.join(' / ')})` : ''}`, ps.length === 0);
  check('IMPL-0522:ok verify の検査の手順が evidence-manifest.mjs changes を呼ぶ', /evidence-manifest\.mjs changes --changes/.test(text));
}

// --- 違反側 ---
{
  const dir = freshBundle();
  fs.writeFileSync(path.join(dir, 'evidence.json'), '{"a":2}\n');
  check('IMPL-0522:ng ファイルを 1 つ変えると verify が不一致を出す', verifyManifest(dir).some((p) => /evidence\.json.*sha256/.test(p)));
}
{
  const dir = freshBundle();
  fs.unlinkSync(path.join(dir, 'assurance-disclosure.external.md'));
  check('IMPL-0522:ng ファイルを 1 つ消すと verify が不一致を出す', verifyManifest(dir).some((p) => /assurance-disclosure.*ファイルがありません/.test(p)));
}
{
  const dir = freshBundle();
  fs.writeFileSync(path.join(dir, 'extra.json'), '{}');
  check('IMPL-0522:ng manifest に無いファイルを足すと verify が不一致を出す', verifyManifest(dir).some((p) => /extra\.json.*一覧にありません/.test(p)));
}
{
  const dir = freshBundle();
  fs.unlinkSync(path.join(dir, 'manifest.json'));
  check('IMPL-0522:ng manifest が無いと verify が不一致を出す', verifyManifest(dir).length === 1);
}
{
  const text = fs.readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'ship-evidence.yml'), 'utf8');
  const drop = (re) => text.split(/\r?\n/).filter((l) => !re.test(l)).join('\n');
  check('IMPL-0522:ng retention-days を明示すると workflowProblems が出す(リポジトリの設定より短くなりうる)', workflowProblems(text.replace(/(name: ship-evidence\r?\n(?:.*\r?\n)*?)(\s+if-no-files-found: error)/, '$1$2\n          retention-days: 90')).some((p) => /retention-days/.test(p)));
  check('IMPL-0522:ng 写しの手順を抜くと workflowProblems が出す', workflowProblems(drop(/evidence-manifest\.mjs write/)).some((p) => /写す手順/.test(p)));
  check('IMPL-0522:ng 一式の git add を抜くと workflowProblems が出す', workflowProblems(drop(/git add -f "\$bundle"/)).some((p) => /git add/.test(p)));
  check('IMPL-0522:ng verify ジョブの changes の呼び出しを抜くと workflowProblems が出す', workflowProblems(drop(/evidence-manifest\.mjs changes --changes/)).some((p) => /changes/.test(p)));
  // IMPL-0246:ng(違反側。coverage-result の取り込みと headSha の照合を抜いた ship-evidence.yml。動作は test-ship-evidence-steps.mjs)
  check('IMPL-0522:ng coverage-result の取り込みを抜くと workflowProblems が出す', workflowProblems(drop(/--name coverage-result/)).some((p) => /coverage-result/.test(p)));
  check('IMPL-0522:ng headSha の照合を抜くと workflowProblems が出す', workflowProblems(drop(/--json headSha/)).some((p) => /headSha/.test(p)));
  check('IMPL-0522:ng 前回の証跡の写しからの読み先を抜くと workflowProblems が出す', workflowProblems(drop(/evidence-manifest\.mjs previous/)).some((p) => /前回/.test(p)));
}

// --- verify ジョブの検査(evidenceChangeProblems)---
{
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'evchg-'));
  const name = '2026-11-15-start..v1';
  freshBundle(path.join(parent, 'docs', 'evidence'), name);
  const files = fs.readdirSync(path.join(parent, 'docs', 'evidence', name));
  const adds = files.map((f) => ({ status: 'A', path: `docs/evidence/${name}/${f}` }));
  const md = { status: 'A', path: `docs/evidence/${name}.md` };
  const bundleDir = (d) => path.join(parent, d);
  check('IMPL-0522:ok 出荷の PR が一致する一式を追加すると失敗の一覧は空', evidenceChangeProblems({ changes: [md, ...adds], ship: true, bundleDir }).length === 0);
  check('IMPL-0522:ng 追加以外の変更(M)は失敗', evidenceChangeProblems({ changes: [{ status: 'M', path: `docs/evidence/${name}/evidence.json` }], ship: true, bundleDir }).some((f) => /追加以外の変更\(M\)/.test(f)));
  check('IMPL-0522:ng 削除(D)は失敗', evidenceChangeProblems({ changes: [{ status: 'D', path: `docs/evidence/${name}/manifest.json` }], ship: true, bundleDir }).some((f) => /追加以外の変更\(D\)/.test(f)));
  check('IMPL-0522:ng 出荷の PR 以外が一式を足すと失敗', evidenceChangeProblems({ changes: adds, ship: false, bundleDir }).some((f) => /運ぶのは出荷の PR/.test(f)));
  check('IMPL-0522:ng 出荷の PR に一式が無い(品質レポートだけ)と失敗', evidenceChangeProblems({ changes: [md], ship: true, bundleDir }).some((f) => /一式の欠け/.test(f)));
  fs.writeFileSync(path.join(parent, 'docs', 'evidence', name, 'evidence.json'), '{"changed":true}\n');
  check('IMPL-0522:ng 一覧と食い違う一式は失敗', evidenceChangeProblems({ changes: adds, ship: true, bundleDir }).some((f) => /digest の一覧と一致しない/.test(f)));
  // CLI(ワークフローが呼ぶ形)。終了コードと出力
  const cf = path.join(parent, 'changes.txt');
  fs.writeFileSync(cf, `${adds.map((a) => `${a.status}\t${a.path}`).join('\n')}\n`);
  const cli = (ship) => spawnSync(process.execPath, [path.join(here, 'evidence-manifest.mjs'), 'changes', '--changes', cf, '--pr-root', parent, '--ship', ship], { encoding: 'utf8' });
  check('IMPL-0522:ng CLI changes は一覧と食い違う一式で終了コード 1 と理由を出す', cli('true').status === 1 && /digest の一覧と一致しない/.test(cli('true').stdout));
}

// --- 一覧の形が壊れているとき、検査は失敗の側へ倒れる(例外で黙って通らない。H2-1) ---
{
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'evbad-'));
  const name = '2026-11-15-start..v1';
  const bundleDir = (d) => path.join(parent, d);
  const dir = freshBundle(path.join(parent, 'docs', 'evidence'), name);
  const adds = fs.readdirSync(dir).map((f) => ({ status: 'A', path: `docs/evidence/${name}/${f}` }));
  const mp = path.join(dir, 'manifest.json');
  const good = fs.readFileSync(mp, 'utf8');
  const cf = path.join(parent, 'changes.txt');
  fs.writeFileSync(cf, `${adds.map((a) => `${a.status}\t${a.path}`).join('\n')}\n`);
  const cli = () => spawnSync(process.execPath, [path.join(here, 'evidence-manifest.mjs'), 'changes', '--changes', cf, '--pr-root', parent, '--ship', 'true'], { encoding: 'utf8' });
  const shapes = {
    'files に null': '{"files":[null]}',
    'files が配列でない': '{"files":{"a":1}}',
    '要素が文字列': '{"files":["evidence.json"]}',
    '要素に path が無い': '{"files":[{"sha256":"x","bytes":1}]}',
    'path がディレクトリ': '{"files":[{"path":".","sha256":"x","bytes":1}]}',
    'path が置き場の外': '{"files":[{"path":"../x","sha256":"x","bytes":1}]}',
    'JSON として壊れている': '{broken',
    '空のファイル': '',
  };
  for (const [label, body] of Object.entries(shapes)) {
    fs.writeFileSync(mp, body);
    let threw = false;
    let ps = [];
    try {
      ps = evidenceChangeProblems({ changes: adds, ship: true, bundleDir });
    } catch {
      threw = true;
    }
    const r = cli();
    check(`IMPL-0522:ng 一覧の形が壊れている(${label})と失敗の一覧に入り、CLI は 0 を返さない`, !threw && ps.length > 0 && r.status !== 0 && (r.stdout ?? '').trim() !== '', `${JSON.stringify(ps)} rc=${r.status} ${r.stdout}${r.stderr}`);
  }
  const subdir = path.join(dir, 'sub');
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(mp, '{"files":[{"path":"sub","sha256":"x","bytes":1}]}');
  check('IMPL-0522:ng path が通常のファイルでない一覧は不一致を返す(例外にしない)', verifyManifest(dir).some((p) => /通常のファイルではありません/.test(p)));
  fs.rmSync(subdir, { recursive: true, force: true });
  fs.writeFileSync(cf, '');
  check('IMPL-0522:ng 変更の一覧が空でも、出荷の PR に一式が無ければ CLI は失敗する', cli().status === 1);
  fs.rmSync(cf);
  const missing = cli();
  check('IMPL-0522:ng 変更の一覧を読めないとき CLI は成功にせず、理由を出す(終了コード 3)', missing.status === 3 && /実行できません/.test(missing.stdout));
  fs.writeFileSync(mp, good);
  fs.writeFileSync(cf, `${adds.map((a) => `${a.status}\t${a.path}`).join('\n')}\n`);
  check('IMPL-0522:ok 正しい一覧の追加だけなら CLI は 0 を返し何も出さない', cli().status === 0 && (cli().stdout ?? '').trim() === '');
}

// --- 前回の証跡を写しから選ぶ ---
{
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'evprev-'));
  const root = path.join(parent, 'docs', 'evidence');
  freshBundle(root, 'b1', '2026-08-01T00:00:00Z');
  const b2 = freshBundle(root, 'b2', '2026-09-01T00:00:00Z');
  const out = path.join(parent, 'out');
  const ok = selectPreviousFromCopies(root, out);
  check('IMPL-0522:ok 一覧と一致する置き場のうち recordedAt が最も新しいものを選ぶ', ok.used === 'b2' && fs.existsSync(path.join(out, 'evidence.json')));
  fs.appendFileSync(path.join(b2, 'evidence.json'), ' ');
  const out2 = path.join(parent, 'out2');
  const ng = selectPreviousFromCopies(root, out2);
  check('IMPL-0522:ng 一覧と一致しない新しい置き場は読まず、理由を残して古い側を選ぶ', ng.used === 'b1' && ng.looked.some((l) => l.dir === 'b2' && !l.ok && l.problems.length > 0));
}

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\n証跡の一式の写しの試験: すべて通過');
