// 期間ごとの保証の開示(標準 第4章 G-7・G-8「期間ごとの保証の開示」/ 第5章 5.5.4)が要るかを判定する。
//
//   node scripts/gate/period-needed.mjs --period-from 2026-09-01 --period-to 2026-09-30
//
// 期間の開示は、委任で先へ進めた変更を期間ごとに開示するためのものである。構成に委任の席、または承認済みの
// 委任の規則がある場合に限り要る。無い構成では「委任を使っていないため、期間の開示は要らない」と出して成功で終える。
//
// 見る構成は、期間の起点の時点の構成、期間中に書き換えられた構成、現在(HEAD)の構成のすべてである。期間の途中で
// 委任をやめた構成も、期間の開示を要する。期間中のコミットにトレーラ Delegated がある場合も要るとする(安全側)。
// 結果は GITHUB_OUTPUT の needed(true / false)へ書く。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { ROOT, fail, notice, isRealDay, localDay } from './config.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const from = arg('--period-from');
const to = arg('--period-to');
if (!(isRealDay(from) && isRealDay(to) && from <= to)) {
  fail('--period-from と --period-to には、実在する日付(YYYY-MM-DD)を、起点 ≦ 終点で指定してください');
  process.exit(2);
}

/** 委任を使っている構成か。委任の席、または承認済みの委任の規則がある */
function delegationInUse(config) {
  if (!config || config.configured !== true) return false;
  const seats = Array.isArray(config.seats) ? config.seats : [];
  const rules = Array.isArray(config.delegation?.rules) ? config.delegation.rules : [];
  return seats.some((s) => s?.mode === 'delegated') || rules.some((r) => Boolean(r?.approvedBy));
}

const configAt = (rev) => {
  try {
    return JSON.parse(git(['show', `${rev}:process.config.json`]));
  } catch {
    return null;
  }
};

// 手元の時刻帯の日付で切る(集約と同じ切り方)
const dayOf = (iso) => localDay(new Date(iso));
const history = git(['log', '--format=%H%x09%cI', 'HEAD'])
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('\t'));
const inPeriod = history.filter(([, at]) => dayOf(at) >= from && dayOf(at) <= to).map(([h]) => h);
const beforeStart = history.find(([, at]) => dayOf(at) < from)?.[0] ?? null;
const touched = new Set(git(['log', '--format=%H', 'HEAD', '--', 'process.config.json']).split('\n').filter(Boolean));

const reasons = [];
const candidates = [['HEAD', 'HEAD'], ...(beforeStart ? [[beforeStart, `起点の時点(${beforeStart.slice(0, 8)})`]] : []), ...inPeriod.filter((h) => touched.has(h)).map((h) => [h, `期間中の ${h.slice(0, 8)}`])];
for (const [rev, label] of candidates) {
  if (delegationInUse(configAt(rev))) reasons.push(`${label} の構成に、委任の席または承認済みの委任の規則がある`);
}
const delegatedCommits = inPeriod.filter((h) => git(['log', '-1', '--format=%(trailers:key=Delegated,valueonly)', h]));
if (delegatedCommits.length) reasons.push(`期間中にトレーラ Delegated を持つコミットが ${delegatedCommits.length} 件ある`);

const needed = reasons.length > 0;
if (needed) notice(`期間(${from}〜${to})の保証の開示を出します: ${reasons.join(' / ')}`);
else notice(`委任を使っていないため、期間(${from}〜${to})の開示は要りません(起点の時点・期間中・現在の構成に、委任の席も承認済みの委任の規則も無く、トレーラ Delegated を持つコミットも無い)`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
