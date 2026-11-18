// 実行の記録(標準 第5章 5.8.2 の生成の条件。IMPL-0207・IMPL-1019・IMPL-0743・IMPL-0828。ADR-0222)
//
//   node scripts/gate/agent-run-record.mjs record          SessionStart のフック。標準入力の JSON(session_id・source)を読み、記録を書く
//   node scripts/gate/agent-run-record.mjs assets <id>      commit-msg のフックが、トレーラ Agent-Assets の値を得る
//
// 観測の記録とフックのトレーラで運ぶ(ADR-0126 決定5)。道具の入力を書き換える形と、履歴からの導出は採らない。
//   - record: 実行の識別子ごとに .claude/agent-runs/<id>.json へ、開始の時点の HEAD・指示資産の要約値・コミットに無い変更の有無を書く。
//     再開(同じ識別子が既にある)は、元の記録を書き換えない。core.hooksPath が未設定なら .githooks にする(別の値があれば変えず、効かない旨を出す)
//   - .githooks/commit-msg: 環境変数 CLAUDE_CODE_SESSION_ID があるときだけ、Agent-Run と Agent-Assets を足す(git interpret-trailers --if-exists doNothing)
// 要約値の対象は CLAUDE.md・AGENTS.md・.claude・context。.claude/agent-runs/・.claude/settings.local.json・context/_archive/ は除く。
// dirty は指示資産のパスだけで判定する。製品のコードの未コミットの変更は版の特定に関わらない(5.8.2 の「指示資産の版」)。
// 見えないもの: --no-verify、別の core.hooksPath、AI の印も付かないコミット、別のセッションの amend(元の識別子が残る。R8)、
//   利用者の範囲の指示(版を記録できない。user-scope=unrecorded)

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ASSET_ROOTS = ['CLAUDE.md', 'AGENTS.md', '.claude', 'context'];
export const ASSET_EXCLUDES = ['.claude/agent-runs/', '.claude/settings.local.json', 'context/_archive/'];
export const RUN_DIR = '.claude/agent-runs';

const excluded = (rel) => ASSET_EXCLUDES.some((x) => (x.endsWith('/') ? rel === x.slice(0, -1) || rel.startsWith(x) : rel === x));
const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== '.' && id !== '..';

function git(args, cwd = ROOT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function walk(abs, rel, out) {
  if (excluded(rel)) return;
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(path.join(abs, name), `${rel}/${name}`, out);
  } else if (st.isFile()) {
    out.push([rel, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')]);
  }
}

/** 指示資産の要約値(パスと内容の sha256 を、パスの順に並べて要約する) */
export function assetsDigest(cwd = ROOT) {
  const files = [];
  for (const r of ASSET_ROOTS) walk(path.join(cwd, r), r, files);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const [rel, d] of files) h.update(`${rel}\0${d}\n`);
  return h.digest('hex');
}

/** 指示資産のパスに、コミットに無い変更(追跡の変更・未追跡)があるか。製品のコードは見ない */
export function assetsDirty(cwd = ROOT) {
  return assetsStatusLines(cwd, () => true);
}

/** status の行のうち pred(行) を満たすものが、除外の外の指示資産のパスに当たるか。状態を読めなければ null(clean と偽らない。R1-16) */
function assetsStatusLines(cwd, pred) {
  const out = git(['status', '--porcelain=v1', '-uall', '--', ...ASSET_ROOTS], cwd);
  if (out === null) return null;
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(pred)
    .some((l) => {
      const paths = l.slice(3).split(' -> ').map((p) => p.replace(/^"|"$/g, ''));
      return paths.some((p) => !excluded(p));
    });
}

/**
 * コミットに入らない指示資産の変更(作業ツリーの未ステージの変更と未追跡)があるか。読めなければ null(R1-03・R1-16)。
 * ステージ済みの変更は、そのコミットに入るので数えない
 */
export function assetsUncommitted(cwd = ROOT) {
  return assetsStatusLines(cwd, (l) => l[1] !== ' ');
}

export function recordPath(id, cwd = ROOT) {
  return path.join(cwd, RUN_DIR, `${id}.json`);
}

/** SessionStart の記録を書く。既にあれば(再開)書き換えない */
export function writeRunRecord(id, cwd = ROOT, now = new Date()) {
  if (!safeId(id)) return { written: false, reason: 'invalid-id' };
  const file = recordPath(id, cwd);
  if (fs.existsSync(file)) return { written: false, reason: 'exists' };
  const head = (git(['rev-parse', 'HEAD'], cwd) ?? '').trim() || 'none';
  const rec = {
    runId: id,
    startedAt: now.toISOString(),
    base: head,
    digest: assetsDigest(cwd),
    assets: (() => {
      const d = assetsDirty(cwd);
      return d === null ? 'unknown' : d ? 'dirty' : 'clean';
    })(),
    userScope: 'unrecorded',
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return { written: true, record: rec };
}

/** トレーラ Agent-Assets の値。記録が無い・読めない実行は、版を特定できない旨を出し、要約値を出さない */
export function assetsTrailerValue(id, cwd = ROOT) {
  if (!safeId(id) || !fs.existsSync(recordPath(id, cwd))) return 'unknown(no-run-record)';
  try {
    const r = JSON.parse(fs.readFileSync(recordPath(id, cwd), 'utf8'));
    if (!/^[0-9a-f]{64}$/.test(r.digest ?? '') || !['clean', 'dirty', 'unknown'].includes(r.assets) || typeof r.base !== 'string') return 'unknown(unreadable-run-record)';
    // コミットの時点の状態(R1-03)。実行の途中で指示資産を変えた(要約値が開始と違う)か、コミットに入らない変更が残るなら dirty。
    // 途中で変えたときは開始の要約値を start= に残す。状態を読めなければ clean と偽らない(R1-16)
    const pending = assetsUncommitted(cwd);
    if (pending === null || r.assets === 'unknown') return 'unknown(assets-unreadable)';
    const now = assetsDigest(cwd);
    const changed = now !== r.digest;
    const state = r.assets === 'dirty' || pending || changed ? 'dirty' : 'clean';
    return `sha256:${now}; base=${r.base}; assets=${state}; user-scope=unrecorded${changed ? `; start=sha256:${r.digest}` : ''}`;
  } catch {
    return 'unknown(unreadable-run-record)';
  }
}

// ---------------------------------------------------------------- 監査・集約が使う分類(IMPL-0743・IMPL-0828。対立 4)
//   clean / dirty       版を特定できる(入力に用いる。dirty は件数を別に出す)
//   unknown             Agent-Assets が unknown(...)。版を特定できない(外す対象)
//   no-trailer          AI の印はあるが、フックの導入後なのにトレーラが無い。版を特定できない(外す対象)
//   pre-hook            AI の印はあるが、フックの導入より前のコミット。規定の取り込みの前(外す対象に数えない。件数を別に出す)
export const AGENT_CLASSES = ['clean', 'dirty', 'unknown', 'no-trailer', 'pre-hook'];

/** @param {{ aiMarked: boolean, assets: string|null, afterHook: boolean }} c  AI の印が無いコミットは null */
export function classifyAgentCommit({ aiMarked, assets, afterHook }) {
  const v = typeof assets === 'string' ? assets.trim() : '';
  if (!aiMarked && !v) return null;
  if (v.startsWith('unknown(')) return 'unknown';
  if (/^sha256:[0-9a-f]{64};/.test(v)) return /;\s*assets=dirty\b/.test(v) ? 'dirty' : /;\s*assets=clean\b/.test(v) ? 'clean' : 'unknown';
  if (v) return 'unknown';
  return afterHook ? 'no-trailer' : 'pre-hook';
}

/** 5 区分の件数と、外す対象の一覧(監査人が外す。機械は一覧を出すだけ) */
export function summarizeAgentCommits(list) {
  const counts = Object.fromEntries(AGENT_CLASSES.map((k) => [k, 0]));
  const excludeCandidates = [];
  for (const c of list) {
    const k = classifyAgentCommit(c);
    if (!k) continue;
    counts[k]++;
    if (k === 'unknown' || k === 'no-trailer') excludeCandidates.push({ hash: c.hash, class: k });
  }
  return { counts, excludeCandidates, total: AGENT_CLASSES.reduce((s, k) => s + counts[k], 0) };
}

/** 切り替えの期間(outage.switched)に生成された、AI の印のあるコミット(IMPL-0828)。day は YYYY-MM-DD */
export function switchedPeriodCommits(commits, outages) {
  const periods = (outages ?? []).filter((o) => o?.switched);
  return {
    periods: periods.length,
    commits: commits.filter((c) => c.aiMarked && periods.some((o) => c.day >= o.from && (!o.to || c.day <= o.to))),
  };
}

// ---------------------------------------------------------------- CLI
async function main() {
  const [, , cmd, arg] = process.argv;
  if (cmd === 'assets') {
    process.stdout.write(assetsTrailerValue(arg));
    return;
  }
  if (cmd === 'record') {
    let input = {};
    try {
      if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
      input = {};
    }
    const id = input.session_id || process.env.CLAUDE_CODE_SESSION_ID;
    if (!id) {
      console.log('(実行の識別子を得られないため、実行の記録を書きません)');
    } else {
      const r = writeRunRecord(id);
      if (r.reason === 'invalid-id') console.log('(実行の識別子の形が不正なため、実行の記録を書きません)');
    }
    // core.hooksPath は未設定のときだけ .githooks にする。別の値があれば変えず、効かないことを出す
    if (fs.existsSync(path.join(ROOT, '.githooks', 'commit-msg'))) {
      const cur = (git(['config', '--get', 'core.hooksPath']) ?? '').trim();
      if (!cur) git(['config', 'core.hooksPath', '.githooks']);
      else if (cur !== '.githooks') console.log(`(core.hooksPath が ${cur} のため、.githooks/commit-msg が走らず、コミットにトレーラ Agent-Run・Agent-Assets が付きません。版を特定できない実行として扱われます)`);
    }
    return;
  }
  console.error('使い方: node scripts/gate/agent-run-record.mjs <record|assets <id>>');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
