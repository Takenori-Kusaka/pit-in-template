// 自己修正ループのロックを始めて終える(禁止事項3。附属書E E.7)。
//
//   node scripts/gate/self-heal.mjs start --spec F-012 --task Task-3   ロックを始める
//   node scripts/gate/self-heal.mjs iterate                             反復を1回数える。上限に達したら保留にする
//   node scripts/gate/self-heal.mjs stop --reason pass                  テストを実行し、通ればロックを終える
//   node scripts/gate/self-heal.mjs stop --reason limit|test-change     保留にする(人の判断待ち。テストの遮断は続く)
//   node scripts/gate/self-heal.mjs release --by "<氏名>"               保留を解く(人の操作)
//   node scripts/gate/self-heal.mjs status [--json]                     状態を出す
//
// ロックがある間、.claude/hooks/guard-write.mjs がテストへの書き込みを拒否する。この遮断は
// guard.enabled に依らず有効である。ロックのファイルそのものへの書き込みもフックが拒否する。
//
// 保留(held)は、反復上限に達した、またはテストの修正を要すると判明した状態である。
// 受入基準へ戻る判断は人が行うため、保留を解くまでテストの遮断を続ける。
//
// 操作はすべて .claude/self-heal.log へ追記する(git 追跡しない)。
//
// 限界: フックは Claude Code の Edit/Write だけを遮断する。シェルからのファイル削除・書き込みは止めない。
// 保留の解除(release)を担い手が実行することも、機械では止められない。記録に残して人が確かめる。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig } from './config.mjs';

const GUARD = path.join(ROOT, '.claude/guard.json');
const lockRel = () => {
  try {
    return JSON.parse(fs.readFileSync(GUARD, 'utf8')).selfHealLockFile ?? '.claude/.self-heal';
  } catch {
    return '.claude/.self-heal';
  }
};
export const LOCK = path.join(ROOT, lockRel());
const LOG = path.join(ROOT, '.claude/self-heal.log');

/** ロックの状態を読む。無ければ null。旧い形(空のファイル)は、対象不明の実行中として読む */
export function readLock() {
  if (!fs.existsSync(LOCK)) return null;
  const text = fs.readFileSync(LOCK, 'utf8').trim();
  if (!text) return { state: 'active', spec: null, task: null, iterations: 0, max: null, legacy: true };
  try {
    return JSON.parse(text);
  } catch {
    return { state: 'active', spec: null, task: null, iterations: 0, max: null, legacy: true };
  }
}

function writeLock(lock) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n', 'utf8');
}

function log(event, detail = '') {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()}\t${event}\t${detail}\n`);
  } catch {
    /* 記録に失敗しても操作は続ける */
  }
}

function maxIterations() {
  try {
    return loadConfig().task?.selfHealMaxIterations ?? 3;
  } catch {
    return 3;
  }
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

const HOLD_NEXT =
  '人の判断待ち: 受入基準へ戻るかどうかは人が決めます。受信箱のラベル `state:needs-po` を付け、' +
  'どの受入基準で失敗し続けているか・その基準が実装可能な粒度か・分割すべき点を提示してください。' +
  '保留を解くのは人です(`node scripts/gate/self-heal.mjs release --by "<氏名>"`)。テストへの書き込みの遮断は続きます';

function describe(lock) {
  if (!lock) return 'ロックなし(テストへの書き込みは遮断されていません)';
  const target = [lock.spec, lock.task].filter(Boolean).join(' / ') || '対象不明';
  const it = `反復 ${lock.iterations ?? 0} / ${lock.max ?? '—'}`;
  if (lock.state === 'held') return `保留(${target}。${it}。理由: ${lock.reason ?? '—'})。${HOLD_NEXT}`;
  return `実行中(${target}。${it})。テストへの書き込みは遮断されています`;
}

function main() {
  const [, , cmd] = process.argv;
  const lock = readLock();

  if (cmd === 'start') {
    if (lock) {
      console.error(`[self-heal] すでにロックがあります: ${describe(lock)}`);
      process.exit(1);
    }
    const spec = arg('--spec');
    const task = arg('--task');
    if (!spec || !task) {
      console.error('使い方: node scripts/gate/self-heal.mjs start --spec F-012 --task Task-3');
      process.exit(2);
    }
    const next = { state: 'active', spec, task, iterations: 0, max: maxIterations(), startedAt: new Date().toISOString() };
    writeLock(next);
    log('start', `${spec} / ${task}`);
    console.log(`[self-heal] ロックを始めました: ${describe(next)}`);
    process.exit(0);
  }

  if (cmd === 'iterate') {
    if (!lock) {
      console.error('[self-heal] ロックがありません。`start` で始めてから反復します');
      process.exit(1);
    }
    if (lock.state === 'held') {
      console.error(`[self-heal] ${describe(lock)}`);
      process.exit(3);
    }
    const max = lock.max ?? maxIterations();
    if ((lock.iterations ?? 0) >= max) {
      const held = { ...lock, state: 'held', reason: `反復上限(${max}回)に達した`, heldAt: new Date().toISOString() };
      writeLock(held);
      log('hold', `limit ${max}`);
      console.error(`[self-heal] ${describe(held)}`);
      process.exit(3);
    }
    const next = { ...lock, iterations: (lock.iterations ?? 0) + 1, max };
    writeLock(next);
    log('iterate', String(next.iterations));
    console.log(`[self-heal] ${describe(next)}`);
    process.exit(0);
  }

  if (cmd === 'stop') {
    const reason = arg('--reason');
    if (!lock) {
      console.error('[self-heal] ロックがありません');
      process.exit(1);
    }
    if (lock.state === 'held') {
      console.error(`[self-heal] 保留中のロックは stop で終えられません。${HOLD_NEXT}`);
      process.exit(3);
    }
    if (reason === 'pass') {
      // 通過は担い手の申告ではなく、テストの実行結果で確かめる
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/gate/adapter.mjs'), 'run', 'test'], { cwd: ROOT, stdio: 'inherit' });
      if (r.status !== 0) {
        log('stop-refused', 'test failed');
        console.error('[self-heal] テストが通らないため、ロックを終えません。反復を続けるか(`iterate`)、上限なら `stop --reason limit` で保留にします');
        process.exit(1);
      }
      fs.rmSync(LOCK, { force: true });
      log('stop', 'pass');
      console.log('[self-heal] テストが通ったため、ロックを終えました');
      process.exit(0);
    }
    if (reason === 'limit' || reason === 'test-change') {
      const why = reason === 'limit' ? '反復上限に達した' : 'テストの修正を要すると判明した';
      const held = { ...lock, state: 'held', reason: why, heldAt: new Date().toISOString() };
      writeLock(held);
      log('hold', reason);
      console.log(`[self-heal] ${describe(held)}`);
      process.exit(0);
    }
    console.error('使い方: node scripts/gate/self-heal.mjs stop --reason pass|limit|test-change');
    process.exit(2);
  }

  if (cmd === 'release') {
    const by = arg('--by');
    if (!lock) {
      console.error('[self-heal] ロックがありません');
      process.exit(1);
    }
    if (!by) {
      console.error('使い方: node scripts/gate/self-heal.mjs release --by "<氏名>"(保留を解くのは人です)');
      process.exit(2);
    }
    fs.rmSync(LOCK, { force: true });
    log('release', by);
    console.log(`[self-heal] ロックを解きました(${by})`);
    process.exit(0);
  }

  if (cmd === 'status') {
    if (process.argv.includes('--json')) console.log(JSON.stringify(lock));
    else console.log(`[self-heal] ${describe(lock)}`);
    process.exit(0);
  }

  console.error('使い方: node scripts/gate/self-heal.mjs <start|iterate|stop|release|status>');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
