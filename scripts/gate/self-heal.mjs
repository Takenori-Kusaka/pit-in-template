// 自己修正ループのロックを始めて終える(標準 第5章 5.8.5 禁止事項3、第3章 3.12.10 実行の強制停止)。
//
//   node scripts/gate/self-heal.mjs start --spec F-012 --task Task-3   ロックを始める
//   node scripts/gate/self-heal.mjs iterate                             修正の後に実行する。テストを実行し、失敗したテストを記録する。
//                                                                       停止条件に当たれば保留にする。通ればロックを終える
//   node scripts/gate/self-heal.mjs stop --reason pass                  テストを実行し、通ればロックを終える
//   node scripts/gate/self-heal.mjs stop --reason limit|test-change     保留にする(人の判断待ち。テストの遮断は続く)
//   node scripts/gate/self-heal.mjs release --by "<氏名>"               保留を解く(人の操作。名簿の人に限る)
//   node scripts/gate/self-heal.mjs status [--json]                     状態を出す
//
// 停止条件は第3章 3.12.10 による。回数だけの遮断を採らない(同節)。
//   - 無進捗: 失敗したテストの集合が、直前の反復と同一のまま task.selfHealNoProgressLimit 回(既定 2)続いたら保留にする。
//             同一かは、スクリプト自身がテストを実行して読んだ失敗したテストの識別で比べる(担い手の申告を使わない)。
//             識別を読めない失敗は、同一と確かめられないため無進捗に数えない(連続失敗の上限は効く)
//   - 連続失敗: 失敗の反復が task.selfHealMaxIterations 回(既定 3)に達したら保留にする。失敗の内容が毎回変わる振動を
//             止める歯止めであり、費用の歯止めでもある(上限を外さない。process-compass #296)
//   - 単一タスクの累積消費: このスクリプトは消費量を読まない(未達。標準 第3章 3.12.10 の実装マークに表示)
//
// ロックがある間、.claude/hooks/guard-write.mjs がテストへの書き込みを拒否する。この遮断は
// guard.enabled に依らず有効である。ロックのファイルそのものへの書き込みもフックが拒否する。
//
// 保留(held)は、停止条件に当たった、またはテストの修正を要すると判明した状態である。
// 受入基準へ戻る判断は人が行うため、保留を解くまでテストの遮断を続ける。保留を解く名義は、人の名簿の人に限り、
// AI の名義を受け付けない。
//
// 操作は docs/self-heal-log.tsv へ追記する(git で追跡する。停止の記録は 3.12.10 の閾値の較正の入力になる)。
// ロックのファイル(.claude/.self-heal)は端末ごとの状態であり、追跡しない。
//
// 限界: フックは Claude Code の Edit/Write だけを遮断する。シェルからのファイル削除・書き込みは止めない。
// 保留の解除(release)を、担い手が人の氏名を書いて実行することも、機械では止められない。記録に残して人が確かめる。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig, aiNameBlocked, resolveSigner, aiNameReason } from './config.mjs';

const GUARD = path.join(ROOT, '.claude/guard.json');
const lockRel = () => {
  try {
    return JSON.parse(fs.readFileSync(GUARD, 'utf8')).selfHealLockFile ?? '.claude/.self-heal';
  } catch {
    return '.claude/.self-heal';
  }
};
export const LOCK = path.join(ROOT, lockRel());
/** 操作の記録。追跡する置き場(以前の .claude/self-heal.log は *.log として git から外れていた。#296) */
export const LOG_REL = 'docs/self-heal-log.tsv';
const LOG = path.join(ROOT, LOG_REL);

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

const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
function log(event, lock, detail = '') {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, '日時\t操作\t機能\tタスク\t反復\t内容\n', 'utf8');
    fs.appendFileSync(LOG, `${new Date().toISOString()}\t${event}\t${clean(lock?.spec)}\t${clean(lock?.task)}\t${lock?.iterations ?? ''}\t${clean(detail)}\n`);
  } catch {
    /* 記録に失敗しても操作は続ける */
  }
}

function limits() {
  let task = {};
  try {
    task = loadConfig().task ?? {};
  } catch {
    task = {};
  }
  return { max: task.selfHealMaxIterations ?? 3, noProgress: task.selfHealNoProgressLimit ?? 2 };
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

/**
 * テストの出力から、失敗したテストの識別を読む。読めなければ空の配列。並びを揃え、重複を除く。
 * 対応する形: node --test(TAP の `not ok`、spec の `✖`)、jest(`●`)、vitest(`FAIL`・`×`)、pytest(`FAILED`)、go(`--- FAIL:`)
 */
export function failingTestIds(output) {
  const ids = new Set();
  const text = String(output ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#\s*(time|duration)[=:].*$/i, '');
    let m;
    if ((m = line.match(/^\s*not ok \d+ - (.+?)\s*$/))) ids.add(m[1]);
    else if ((m = line.match(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/))) {
      if (!/^failing tests:?$/i.test(m[1])) ids.add(m[1]);
    } else if ((m = line.match(/^\s*● (.+?)\s*$/))) ids.add(m[1]);
    else if ((m = line.match(/^\s*(?:FAIL|×)\s+(.+?)(?: \d+m?s)?\s*$/))) ids.add(m[1]);
    else if ((m = line.match(/^FAILED (\S+)/))) ids.add(m[1]);
    else if ((m = line.match(/^\s*--- FAIL: (\S+)/))) ids.add(m[1]);
  }
  return [...ids].sort();
}

const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 反復の結果から次の状態を決める(純関数)。failures は失敗したテストの識別の配列(識別できない失敗は null)。
 * 戻り値の lock.state が held なら保留。reason に発火した条件を書く
 */
export function nextIteration(lock, failures, { max, noProgress }) {
  const prev = lock.history?.at(-1) ?? null;
  const streak = failures && prev && sameSet(prev.failures, failures) ? (prev.streak ?? 1) + 1 : 1;
  const iterations = (lock.iterations ?? 0) + 1;
  const entry = { n: iterations, failures, streak: failures ? streak : 0, at: new Date().toISOString() };
  const next = { ...lock, iterations, max, noProgress, history: [...(lock.history ?? []), entry] };
  if (failures && streak >= noProgress) {
    return { ...next, state: 'held', condition: 'no-progress', reason: `無進捗: 同じ失敗したテストの集合が ${streak} 回続いた(${failures.slice(0, 3).join(', ')}${failures.length > 3 ? ' ほか' : ''})`, heldAt: entry.at };
  }
  if (iterations >= max) {
    return { ...next, state: 'held', condition: 'consecutive-failures', reason: `連続失敗: 失敗の反復が上限(${max}回)に達した`, heldAt: entry.at };
  }
  return next;
}

/** 保留を解く名義の問題。名簿の人で、AI の名義でないこと。問題が無ければ null */
export function releaseProblem(config, by) {
  const name = String(by ?? '').trim();
  if (!name) return '保留を解く人の氏名を --by で書いてください';
  if (aiNameReason(name) && aiNameBlocked(config, name)) return `"${name}" は AI の名義です(${aiNameReason(name)})。保留を解くのは人です`;
  const roster = Array.isArray(config?.people) ? config.people : [];
  if (!roster.length) return '人の名簿(people[])が未記入のため、保留を解く人を確かめられません。/process-change で名簿へ記入してから解きます';
  const person = resolveSigner(config, name.replace(/^@/, ''));
  if (!person) return `"${name}" は人の名簿(people[])の人へ対応づきません。保留を解くのは名簿の人です`;
  if (aiNameBlocked(config, person.name)) return `"${name}" は AI の名義です。保留を解くのは人です`;
  return null;
}

const HOLD_NEXT =
  '人の判断待ち: 受入基準へ戻るかどうかは人が決めます。受信箱のラベル `state:needs-po` を付け、' +
  'どの受入基準で失敗し続けているか・その基準が実装可能な粒度か・分割すべき点を提示してください。' +
  '同じタスクで保留が繰り返されるなら、原因はタスクの分解として実装計画へ差し戻します(標準 第3章 3.12.10)。' +
  '保留を解くのは名簿の人です(`node scripts/gate/self-heal.mjs release --by "<氏名>"`)。テストへの書き込みの遮断は続きます';

function describe(lock) {
  if (!lock) return 'ロックなし(テストへの書き込みは遮断されていません)';
  const target = [lock.spec, lock.task].filter(Boolean).join(' / ') || '対象不明';
  const it = `失敗の反復 ${lock.iterations ?? 0} / ${lock.max ?? '—'}`;
  const last = lock.history?.at(-1);
  const lastText = last ? `。直前の失敗 ${last.failures === null ? '識別できない' : `${last.failures.length} 件`}${last.streak > 1 ? `(同じ集合が ${last.streak} 回)` : ''}` : '';
  if (lock.state === 'held') return `保留(${target}。${it}${lastText}。理由: ${lock.reason ?? '—'})。${HOLD_NEXT}`;
  return `実行中(${target}。${it}${lastText})。テストへの書き込みは遮断されています`;
}

/** テストを実行する。出力は端末へも出し、失敗したテストの識別を読むために受け取る */
function runTests() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/gate/adapter.mjs'), 'run', 'test'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  return { ok: r.status === 0, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
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
    const { max, noProgress } = limits();
    const next = { state: 'active', spec, task, iterations: 0, max, noProgress, history: [], startedAt: new Date().toISOString() };
    writeLock(next);
    log('start', next);
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
    // 反復の結果は担い手の申告でなく、テストの実行で確かめる
    const t = runTests();
    if (t.ok) {
      fs.rmSync(LOCK, { force: true });
      log('stop', lock, 'pass(iterate でテストが通った)');
      console.log('[self-heal] テストが通ったため、ロックを終えました');
      process.exit(0);
    }
    const ids = failingTestIds(t.output);
    const failures = ids.length ? ids : null;
    const { max, noProgress } = { ...limits(), ...(lock.max ? { max: lock.max } : {}), ...(lock.noProgress ? { noProgress: lock.noProgress } : {}) };
    const next = nextIteration(lock, failures, { max, noProgress });
    writeLock(next);
    log(next.state === 'held' ? 'hold' : 'iterate', next, `${failures ? failures.join(' | ') : '失敗したテストを識別できない'}${next.state === 'held' ? ` / ${next.reason}` : ''}`);
    if (!failures) console.error('[self-heal] テストは失敗したが、失敗したテストを出力から識別できない。無進捗の判定はこの反復で行わない(連続失敗の上限は効く)');
    if (next.state === 'held') {
      console.error(`[self-heal] ${describe(next)}`);
      process.exit(3);
    }
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
      const t = runTests();
      if (!t.ok) {
        log('stop-refused', lock, 'test failed');
        console.error('[self-heal] テストが通らないため、ロックを終えません。修正して `iterate` を実行するか、`stop --reason limit` で保留にします');
        process.exit(1);
      }
      fs.rmSync(LOCK, { force: true });
      log('stop', lock, 'pass');
      console.log('[self-heal] テストが通ったため、ロックを終えました');
      process.exit(0);
    }
    if (reason === 'limit' || reason === 'test-change') {
      const why = reason === 'limit' ? '担い手が反復の上限と判断した' : 'テストの修正を要すると判明した';
      const held = { ...lock, state: 'held', condition: reason, reason: why, heldAt: new Date().toISOString() };
      writeLock(held);
      log('hold', held, reason);
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
    let config = {};
    try {
      config = loadConfig();
    } catch {
      config = {};
    }
    const problem = releaseProblem(config, by);
    if (problem) {
      log('release-refused', lock, `${clean(by)}: ${problem}`);
      console.error(`[self-heal] 保留を解きません: ${problem}`);
      process.exit(2);
    }
    fs.rmSync(LOCK, { force: true });
    log('release', lock, `${by}(${lock.reason ?? '理由なし'})`);
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
