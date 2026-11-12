// 書き込みの遮断(.claude/hooks/guard-write.mjs)の試験(process-compass #358。IMPL-0187・IMPL-0198)。
//
// フックを一時の置き場へ写し、guard.json を置いて、Claude Code の PreToolUse の入力(tool_input.file_path)を標準入力で渡す。
// 終了コード 2 が遮断、0 が通過。遮断した操作が .claude/denied.log へ残ることも確かめる。
// 確かめるのは、このテンプレートの構成の生成(generate-profile.mjs)が書く guard.json の形(protectedPatterns・
// appendOnlyPatterns・testPatterns・selfHealLockFile)での判定まで。Claude Code がフックを実際に呼ぶこと、
// Edit・Write 以外の経路(Bash からの書き込み、手動の git 操作)は確かめない(フックの冒頭の限界の注記)。
//
//   node scripts/gate/test-guard-write.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tailorGuardAndSettings } from '../init/generate-profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, '.claude/hooks/guard-write.mjs');
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 400)}`}`);
}

// 構成の生成(generate-profile.mjs の tailorGuardAndSettings)が書く guard.json を、そのまま使う(guard.enabled が真の既定)。
// 保護の型を試験の中に別に持たない(構成の生成から型が落ちたら、この試験が落ちる。突合 X-7)
const tplGuardText = fs.readFileSync(path.join(ROOT, '.claude/guard.json'), 'utf8');
const tplSettingsText = fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8');
const GUARD = JSON.parse(tailorGuardAndSettings({}, tplGuardText, tplSettingsText).guardText);
const patternOf = (x) => (typeof x === 'object' && x !== null ? x.pattern : x);
check('構成の生成が書く guard.json は enabled が真で、保護の型を持つ', GUARD.enabled === true && (GUARD.protectedPatterns ?? []).length >= 10, JSON.stringify(GUARD).slice(0, 200));
const TMP_DIRS = [];

function sandbox(guard = GUARD) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-write-'));
  TMP_DIRS.push(dir);
  fs.mkdirSync(path.join(dir, '.claude/hooks'), { recursive: true });
  fs.copyFileSync(HOOK, path.join(dir, '.claude/hooks/guard-write.mjs'));
  fs.writeFileSync(path.join(dir, '.claude/guard.json'), JSON.stringify(guard, null, 2));
  return dir;
}
function run(dir, rel, tool = 'Write') {
  const input = tool === 'NotebookEdit' ? { tool_name: tool, tool_input: { notebook_path: path.join(dir, rel) } } : { tool_name: tool, tool_input: { file_path: path.join(dir, rel) } };
  const r = spawnSync(process.execPath, [path.join(dir, '.claude/hooks/guard-write.mjs')], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}
const logOf = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, '.claude/denied.log'), 'utf8');
  } catch {
    return '';
  }
};

// ---- 強制層への書き込み(IMPL-0198。5.8.6 要求事項5・6)
{
  const dir = sandbox();
  // IMPL-0198:ng(違反と適合の対。強制層への書き込みは遮断し、記録へ残す)
  const concrete = (p) => p.split('**').join('x/y').split('*').join('z');
  const denied = GUARD.protectedPatterns.map((x) => concrete(patternOf(x)));
  for (const rel of denied) {
    const r = run(dir, rel, 'Edit');
    check(`強制層の遮断: ${rel}`, r.code === 2 && /強制層/.test(r.err), `code=${r.code} ${r.err}`);
  }
  const log = logOf(dir);
  check('強制層の型に 8 件以上(.claude/settings.json・scripts/gate/**・process.config.json を含む)', denied.length >= 8 && denied.includes('.claude/settings.json') && denied.includes('process.config.json'), denied.join(','));
  check('遮断した操作が denied.log に残る(件数)', log.trim().split('\n').filter(Boolean).length === denied.length, log);
  check('denied.log の行に規則(protected)とパスがある', denied.every((rel) => log.includes(`\tprotected\t${rel}`)), log);
  check('NotebookEdit の notebook_path も遮断する', run(dir, 'scripts/gate/x.ipynb', 'NotebookEdit').code === 2);
  // 大文字と小文字を変えたパス(NTFS・APFS では同じファイル)も遮断する(#358)
  for (const rel of ['.CLAUDE/Settings.json', '.github/Workflows/x.yml', 'Scripts/Gate/check-pr.mjs']) check(`大文字と小文字を変えても遮断: ${rel}`, run(dir, rel, 'Edit').code === 2);
  // 別の綴りで同じファイルを指す経路(NTFS の代替データストリーム・8.3 の短い名前・末尾のドット。突合 X-1)も遮断する
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), '{}');
  // `:` の除去は Windows のときだけ(POSIX では `:` は名前に使える文字で、別のファイルである。Y-5)
  const streams = process.platform === 'win32' ? ['.claude/settings.json::$DATA', '.claude/settings.json:x', 'scripts/gate/new.mjs:evil'] : [];
  for (const rel of [...streams, '.claude/SETTIN~1.JSO', '.claude/hooks/GUARD-~1.MJS', 'scripts/gate/CHECK-P~1.MJS']) {
    const r = run(dir, rel, 'Write');
    check(`別の綴りでも遮断: ${rel}`, r.code === 2, `code=${r.code} ${r.err}`);
  }
  // 末尾のドットは、Windows の API の正規化に頼る道具に備えた安全側の拒否(この環境の Node の fs は別のファイルとして作る。Y-6)
  if (process.platform === 'win32') check('末尾のドットも安全側で遮断: .claude/settings.json.', run(dir, '.claude/settings.json.', 'Write').code === 2);
  // 保護の型のディレクトリがリンクのとき、解決先がリポジトリの外でも、字面のパスで遮断する(Y-1)
  {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-write-out-'));
    TMP_DIRS.push(out);
    fs.mkdirSync(path.join(out, 'workflows'));
    try {
      fs.symlinkSync(out, path.join(dir, '.github'), 'junction');
      for (const rel of ['.github/workflows/ci.yml', '.github/workflows/new.yml']) {
        const r = run(dir, rel, 'Write');
        check(`リンクの先がリポジトリの外でも字面で遮断: ${rel}`, r.code === 2, `code=${r.code} ${r.err}`);
      }
    } catch (e) {
      console.log(`skip リンクの試験(作れない環境: ${e.code})`);
    }
  }
  // IMPL-0198:ok(強制層の外は遮断しない。記録も増やさない)
  const before = logOf(dir);
  const allowed = ['src/app.js', 'docs/design.md', 'specs/F-001/spec.md', 'scripts/build.mjs', '.claude/skills/pit/SKILL.md', 'CLAUDE.md', 'scripts/build~2.mjs', '.claude/skills/v~2/SKILL.md'];
  for (const rel of allowed) {
    const r = run(dir, rel);
    check(`強制層の外は通す: ${rel}`, r.code === 0, `code=${r.code} ${r.err}`);
  }
  if (process.platform !== 'win32') check('POSIX では `:` を含む名前は別のファイルとして通す: scripts/build.mjs:x', run(dir, 'scripts/build.mjs:x').code === 0);
  check('通した操作は denied.log に残さない', logOf(dir) === before);
  check('リポジトリの外は対象にしない', run(dir, '../outside.txt').code === 0);
  // guard.enabled が偽(期限つきの一時緩和)では強制層の遮断を外す
  const dirOff = sandbox({ ...GUARD, enabled: false });
  check('guard.enabled が偽では強制層を遮断しない', run(dirOff, 'scripts/gate/check-pr.mjs').code === 0);
}

// ---- 自己修正のロック中のテストへの書き込み(IMPL-0187。5.8.5 の禁止事項3)
{
  const dir = sandbox();
  // ロックの外: テストを先に書く作業は遮断しない
  // IMPL-0187:ok(ロックの外のテストと、ロック中のテスト以外のパスは遮断しない)
  for (const rel of ['src/__tests__/a.test.js', 'tests/test_a.py', 'pkg/a_test.go']) check(`ロックの外のテストは通す: ${rel}`, run(dir, rel).code === 0);
  fs.writeFileSync(path.join(dir, '.claude/.self-heal'), JSON.stringify({ spec: 'F-001', task: 'Task-1' }));
  for (const rel of ['src/app.js', 'src/lib/util.ts', 'docs/self-heal/F-001.md']) check(`ロック中もテスト以外は通す: ${rel}`, run(dir, rel).code === 0);
  // IMPL-0187:ng(ロック中のテストへの書き込みと、ロックのファイルそのものへの書き込みは遮断する)
  for (const rel of ['src/__tests__/a.test.js', 'src/a.spec.ts', 'tests/test_a.py', 'tests/conftest.py', 'pkg/a_test.go', 'test/fixtures/x.json']) {
    const r = run(dir, rel);
    check(`ロック中のテストを遮断: ${rel}`, r.code === 2, `code=${r.code} ${r.err}`);
  }
  check('ロックのファイルの書き換えを遮断', run(dir, '.claude/.self-heal').code === 2);
  check('ロックのファイルの書き換えを遮断(大文字と小文字を変えたパス)', run(dir, '.Claude/.Self-Heal').code === 2);
  check('ロック中のテストを遮断(大文字と小文字を変えたパス)', run(dir, 'src/__TESTS__/A.Test.js').code === 2);
  check('ロック中の遮断が denied.log に self-heal-test で残る', /\tself-heal-test\tsrc\/__tests__\/a\.test\.js/.test(logOf(dir)), logOf(dir));
  // guard.enabled に依らない(#286)
  const dirOff = sandbox({ ...GUARD, enabled: false });
  fs.writeFileSync(path.join(dirOff, '.claude/.self-heal'), '{}');
  check('guard.enabled が偽でもロック中のテストを遮断', run(dirOff, 'src/a.test.js').code === 2);
  check('guard.enabled が偽でもロック中のテスト以外は通す', run(dirOff, 'src/a.js').code === 0);
}

// ---- 追記だけの置き場(既にある記録の書き換えだけを遮断する)
{
  const dir = sandbox();
  check('追記だけの置き場の新しいファイルは通す', run(dir, 'records/gates/G-2-F-001.md').code === 0);
  fs.mkdirSync(path.join(dir, 'records/gates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'records/gates/G-2-F-001.md'), '# 判定');
  check('追記だけの置き場の既存のファイルは遮断', run(dir, 'records/gates/G-2-F-001.md', 'Edit').code === 2);
}

// ---- 権限設定の結線(フックが Edit・Write・MultiEdit・NotebookEdit で呼ばれる登録が、テンプレートの設定にあること)
{
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  const pre = settings?.hooks?.PreToolUse ?? [];
  const entry = pre.find((h) => (h.hooks ?? []).some((x) => x.command === 'node .claude/hooks/guard-write.mjs'));
  const tools = new Set(String(entry?.matcher ?? '').split('|'));
  check('settings.json の PreToolUse に guard-write の登録がある', Boolean(entry));
  check('登録の matcher が Edit・Write・MultiEdit・NotebookEdit を含む', ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].every((t) => tools.has(t)), entry?.matcher);
  check('settings.json がフックをすべて止めていない(disableAllHooks)', settings.disableAllHooks !== true);
}

console.log(`\n${checks - failures}/${checks} 件が期待どおり`);
for (const d of TMP_DIRS) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* 消せなくても試験の結果には影響しない */
  }
}
process.exit(failures ? 1 : 0);
