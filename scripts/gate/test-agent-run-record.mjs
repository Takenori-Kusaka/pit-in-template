// 実行の記録(SessionStart の記録と commit-msg のトレーラ)の試験。IMPL-0207・IMPL-1019。標準 第5章 5.8.2・ADR-0222
//
//   node scripts/gate/test-agent-run-record.mjs
//
// 実物のフックを、git の履歴を持つ一時の置き場で走らせる(関数の試験にしない)。固定するのは、フックの振る舞いまでである:
//   - Claude Code の実行(環境変数 CLAUDE_CODE_SESSION_ID)のコミットにだけ Agent-Run と Agent-Assets を 1 度だけ足す
//   - SessionStart の記録は、開始の時点の HEAD・指示資産の要約値・指示資産のコミットに無い変更の有無を、実行の識別子ごとに残す
//   - 記録が無い・読めない実行は、版を特定できない旨(unknown)を出し、要約値を出さない
//   - 製品のコードの未コミットの変更は dirty に数えない。指示資産(CLAUDE.md・AGENTS.md・.claude・context)の変更だけが dirty
//   - 再開(source: resume)は、元の記録を書き換えない
// 確かめないこと: AI のコミットが必ずフックを通ること(--no-verify・別の core.hooksPath・AI の印も付かないコミットは見えない)、
//   Claude Code の実機で SessionStart が走ること・下位の担当の起動で走ること(実機の確認は research/444-verification/)

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
};

const GIT_C = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
const dirs = [];
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-agent-run-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'gate'), path.join(dir, 'scripts', 'gate'), { recursive: true });
  if (fs.existsSync(path.join(ROOT, '.githooks'))) fs.cpSync(path.join(ROOT, '.githooks'), path.join(dir, '.githooks'), { recursive: true });
  for (const [rel, t] of Object.entries({ 'CLAUDE.md': '# 規則\n', 'AGENTS.md': '# 指示\n', '.claude/note.md': 'n\n', 'context/glossary.md': 'g\n', 'src/app.js': 'a\n' })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), t);
  }
  const git = (...a) => execFileSync('git', [...GIT_C, ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  // 記録の実行。入力は SessionStart の標準入力(JSON)。環境変数 CLAUDE_CODE_SESSION_ID は付けない
  const record = (id, source = 'startup') => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    return spawnSync(process.execPath, ['scripts/gate/agent-run-record.mjs', 'record'], { cwd: dir, encoding: 'utf8', input: JSON.stringify({ session_id: id, source }), env });
  };
  // コミット。envId があれば Claude Code の実行として commit-msg を通す
  const commit = (msg, envId, extra = []) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    if (envId) env.CLAUDE_CODE_SESSION_ID = envId;
    return spawnSync('git', [...GIT_C, 'commit', '-q', ...extra, '-m', msg], { cwd: dir, encoding: 'utf8', env });
  };
  const amend = (envId) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    if (envId) env.CLAUDE_CODE_SESSION_ID = envId;
    return spawnSync('git', [...GIT_C, 'commit', '-q', '--amend', '--no-edit'], { cwd: dir, encoding: 'utf8', env });
  };
  const body = (rev = 'HEAD') => git('log', '-1', '--format=%B', rev);
  const trailer = (key, rev = 'HEAD') =>
    git('log', '-1', `--format=%(trailers:key=${key},valueonly,separator=%x1F)`, rev)
      .split('\x1f')
      .map((s) => s.trim())
      .filter(Boolean);
  const touch = (rel, t) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), t);
  };
  const recordFile = (id) => path.join(dir, '.claude', 'agent-runs', `${id}.json`);
  const readRecord = (id) => {
    try {
      return JSON.parse(fs.readFileSync(recordFile(id), 'utf8'));
    } catch {
      return null;
    }
  };
  return { dir, git, record, commit, amend, body, trailer, touch, recordFile, readRecord };
}

// ---------------------------------------------------------------- IMPL-0207 トレーラ
{
  const W = repo();
  const r = W.record('sess-1');
  W.touch('src/app.js', 'b\n');
  W.git('add', '-A');
  // IMPL-0207:ok(Claude Code の実行のコミットに、実行の識別子が 1 度だけ付く)
  W.commit('feat: x', 'sess-1');
  check('IMPL-0207:ok 環境変数のある実行のコミットに Agent-Run が 1 度だけ付く', JSON.stringify(W.trailer('Agent-Run')) === JSON.stringify(['sess-1']), `${r.stderr}\n${W.body()}`);
  check('IMPL-0207:ok 同じコミットに Agent-Assets も付く', W.trailer('Agent-Assets').length === 1, W.body());
  // IMPL-0207:ng(amend で二重に付かない)
  W.touch('src/app.js', 'c\n');
  W.git('add', '-A');
  W.amend('sess-1');
  check('IMPL-0207:ng amend で Agent-Run が二重に付かない', W.trailer('Agent-Run').length === 1 && W.trailer('Agent-Assets').length === 1, W.body());
  // 別のセッションの amend は、元の識別子が残る(R8。付け替えない)
  W.record('sess-2');
  W.touch('src/app.js', 'd\n');
  W.git('add', '-A');
  W.amend('sess-2');
  check('IMPL-0207:ng 別のセッションの amend は元の識別子を残し、付け替えない', JSON.stringify(W.trailer('Agent-Run')) === JSON.stringify(['sess-1']), W.body());
  // IMPL-0207:ng(人のコミットに付かない)
  W.touch('src/app.js', 'e\n');
  W.git('add', '-A');
  W.commit('fix: human', null);
  check('IMPL-0207:ng 環境変数の無い(人の)コミットには足さない', W.trailer('Agent-Run').length === 0 && W.trailer('Agent-Assets').length === 0, W.body());
  fs.rmSync(W.dir, { recursive: true, force: true });
}
{
  // 既存のトレーラ(Co-Authored-By)を壊さない。メッセージの末尾の段落に足す
  const W = repo();
  W.record('sess-3');
  W.touch('src/app.js', 'b\n');
  W.git('add', '-A');
  W.commit('feat: y\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>', 'sess-3');
  check('IMPL-0207:ok 既存の Co-Authored-By を残し、同じ末尾の段落へ Agent-Run を足す', W.trailer('Co-Authored-By').length === 1 && W.trailer('Agent-Run').length === 1, W.body());
  fs.rmSync(W.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- IMPL-1019 指示資産の版の記録
{
  const W = repo();
  const head = W.git('rev-parse', 'HEAD');
  W.record('sess-a');
  const rec = W.readRecord('sess-a');
  check('IMPL-1019:ok 記録に開始の時点の HEAD・要約値・assets の状態・user-scope を残す', rec && rec.base === head && /^[0-9a-f]{64}$/.test(rec.digest ?? '') && rec.assets === 'clean' && rec.userScope === 'unrecorded', JSON.stringify(rec));
  W.touch('src/app.js', 'b\n');
  W.git('add', '-A');
  W.commit('feat: z', 'sess-a');
  const v = W.trailer('Agent-Assets')[0] ?? '';
  check('IMPL-1019:ok 記録のある実行は sha256・base・assets=clean・user-scope=unrecorded の形で出る', v === `sha256:${rec?.digest}; base=${head}; assets=clean; user-scope=unrecorded`, v);

  // IMPL-1019:ng(製品のコードの未コミットだけでは dirty にならない)
  W.touch('src/app.js', 'dirty-product\n');
  W.record('sess-b');
  const b = W.readRecord('sess-b');
  check('IMPL-1019:ng 製品のコードの未コミットの変更だけでは dirty に数えない', b?.assets === 'clean', JSON.stringify(b));
  // IMPL-1019:ok(指示資産の変更は dirty)
  W.touch('CLAUDE.md', '# 規則 変更\n');
  W.record('sess-c');
  const c = W.readRecord('sess-c');
  check('IMPL-1019:ok 指示資産の未コミットの変更は dirty に数える', c?.assets === 'dirty' && c.digest !== b?.digest, JSON.stringify(c));
  // 要約値の対象外(settings.local.json・agent-runs)は、要約値を変えない
  W.git('checkout', '--', 'CLAUDE.md');
  W.touch('.claude/settings.local.json', '{"x":1}\n');
  W.record('sess-d');
  const d = W.readRecord('sess-d');
  check('IMPL-1019:ok settings.local.json と agent-runs は要約値・dirty の対象外', d?.digest === b?.digest && d?.assets === 'clean', JSON.stringify(d));

  // IMPL-1019:ng(記録が無いのに要約値が出ない)
  W.git('add', '-A');
  W.commit('feat: no record', 'sess-none');
  const none = W.trailer('Agent-Assets')[0] ?? '';
  check('IMPL-1019:ng 記録の無い実行は unknown(no-run-record) と出し、要約値を出さない', none === 'unknown(no-run-record)' && !none.includes('sha256'), W.body());
  fs.mkdirSync(path.dirname(W.recordFile('sess-bad')), { recursive: true });
  fs.writeFileSync(W.recordFile('sess-bad'), '{ not json');
  W.touch('src/app.js', 'f\n');
  W.git('add', '-A');
  W.commit('feat: bad record', 'sess-bad');
  check('IMPL-1019:ng 読めない記録の実行は unknown(unreadable-run-record) と出す', (W.trailer('Agent-Assets')[0] ?? '') === 'unknown(unreadable-run-record)', W.body());

  // 再開は、元の記録を書き換えない
  const before = fs.readFileSync(W.recordFile('sess-a'), 'utf8');
  W.touch('CLAUDE.md', '# 規則 再開の前に変えた\n');
  W.record('sess-a', 'resume');
  check('IMPL-1019:ok 再開(resume)は元の記録を書き換えない(値が保たれる)', fs.readFileSync(W.recordFile('sess-a'), 'utf8') === before);
  fs.rmSync(W.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- core.hooksPath
{
  const W = repo();
  const get = (d) => spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: d, encoding: 'utf8' }).stdout.trim();
  W.record('sess-h');
  check('IMPL-0207:ok core.hooksPath が未設定なら .githooks にする', get(W.dir) === '.githooks', get(W.dir));
  const W2 = repo();
  W2.git('config', 'core.hooksPath', 'other-hooks');
  const r = W2.record('sess-h2');
  const text = `${r.stdout}${r.stderr}`;
  check('IMPL-0207:ng 別の core.hooksPath があれば変えず、トレーラが付かない旨を起動の出力に出す', get(W2.dir) === 'other-hooks' && /core\.hooksPath/.test(text) && /Agent-Run|トレーラ/.test(text), `${get(W2.dir)}\n${text}`);
  fs.rmSync(W.dir, { recursive: true, force: true });
  fs.rmSync(W2.dir, { recursive: true, force: true });
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`実行の記録の試験: ${failures} / ${n} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`実行の記録の試験: ${n} 件が期待と一致しました`);
