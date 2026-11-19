// 滞留期間の観測と通知の試験(IMPL-0283。process-compass #443)。
// 時計と TZ に依らない: now は固定の時刻を渡し、差は UTC のミリ秒で測る。子プロセスで TZ=UTC と TZ=Asia/Tokyo の結果が同じことを確かめる。
//
//   node scripts/gate/test-flow-observation.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flowActions, percentile, startOf, fetchUnits, main as flowMain } from './flow-observation.mjs';
import { isCompletedUnit } from './next.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 600)}`}`);
}

const DAY = 86400000;
const NOW = '2026-11-18T00:00:00Z';
const config = {
  people: [{ id: 'p2', name: '鈴木 一郎', accounts: [{ login: 'alice', id: 2 }] }],
  seats: [{ role: 'value-owner', accountable: 'p2' }],
};
const iso = (ms) => new Date(ms).toISOString();
const t0 = Date.parse(NOW);
// 閉じた作業単位 n 件。サイクルタイムは 1,2,…,n 日
const closedOf = (n) => Array.from({ length: n }, (_, i) => ({ number: 100 + i, startAt: iso(t0 - (i + 2) * DAY), closedAt: iso(t0 - DAY) })).map((c, i) => ({ ...c, startAt: iso(Date.parse(c.closedAt) - (i + 1) * DAY) }));
const unit = (o) => ({ number: 1, startAt: iso(t0 - 30 * DAY), assignees: ['bob'], comments: [], ...o });

check('85パーセンタイル: 最近順位法', percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.85) === 9 && percentile([], 0.85) === null);

const r = flowActions({ open: [unit({})], closed: closedOf(10), now: NOW, config });
check('IMPL-0283:ng 超過で、担当者と価値責任者を記名した通知の文が出る', r.actions.length === 1 && /@bob/.test(r.actions[0].body) && /@alice/.test(r.actions[0].body) && /85パーセンタイル/.test(r.actions[0].body), JSON.stringify(r));
check('IMPL-0283:ok 85パーセンタイルは 9 日(10件の 1〜10 日)', r.thresholdMs === 9 * DAY && r.n === 10);
check('IMPL-0283:ok 超過していなければ出ない', flowActions({ open: [unit({ startAt: iso(t0 - 5 * DAY) })], closed: closedOf(10), now: NOW, config }).actions.length === 0);
const few = flowActions({ open: [unit({})], closed: closedOf(9), now: NOW, config });
check('IMPL-0283:ok 標本が足りない → 算定できない・通知なし', few.actions.length === 0 && few.thresholdMs === null && few.notes.some((n) => /算定できない/.test(n)));
check('IMPL-0283:ok 最小の標本数は引数で変えられる', flowActions({ open: [unit({})], closed: closedOf(5), now: NOW, config, minSample: 5 }).actions.length === 1);
check('IMPL-0283:ok 窓の外に閉じたものは数えない', flowActions({ open: [unit({})], closed: closedOf(10).map((c) => ({ ...c, closedAt: iso(t0 - 200 * DAY), startAt: iso(t0 - 201 * DAY) })), now: NOW, config }).thresholdMs === null);
check('IMPL-0283:ok 観測の窓は月数(単位8 と同じ読み方)。既定は config の observationWindow', flowActions({ open: [unit({})], closed: closedOf(10).map((c) => ({ ...c, closedAt: iso(t0 - 100 * DAY), startAt: iso(t0 - 105 * DAY) })), now: NOW, config, windowMonths: 6 }).thresholdMs === 5 * DAY && flowActions({ open: [unit({})], closed: closedOf(10).map((c) => ({ ...c, closedAt: iso(t0 - 100 * DAY), startAt: iso(t0 - 105 * DAY) })), now: NOW, config, windowMonths: 2 }).thresholdMs === null);
check('IMPL-0283:ok 同じ超過で2回目は出さない', flowActions({ open: [unit({ comments: [{ body: r.actions[0].body, login: 'github-actions[bot]' }] })], closed: closedOf(10), now: NOW, config }).actions.length === 0);
check('IMPL-0283:ng 印は機械のコメントだけを数える(人が印を書いても通知は止まらない)', flowActions({ open: [unit({ comments: [{ body: r.actions[0].body, login: 'someone' }] })], closed: closedOf(10), now: NOW, config }).actions.length === 1);
const noOwner = flowActions({ open: [unit({})], closed: closedOf(10), now: NOW, config: { ...config, seats: [] } });
check('価値責任者を解決できなければ担当者だけを記名し、注意に書く', noOwner.actions.length === 1 && !/@alice/.test(noOwner.actions[0].body) && noOwner.notes.some((n) => /価値責任者/.test(n)));
check('着手の時点が無い作業単位は数えない', flowActions({ open: [unit({ startAt: null })], closed: closedOf(10), now: NOW, config }).actions.length === 0);

// 合意した値(企画書の欄「滞留と判定する経過時間」。IMPL-0283)
const A3 = { kind: 'agreed', days: 3, raw: '3日' };
const ag0 = flowActions({ open: [unit({ startAt: iso(t0 - 4 * DAY) })], closed: [], now: NOW, config, agreed: A3 });
check('IMPL-0283:ok 合意した値 3日 は、標本 0 件でも 4日経過の作業単位に通知する(最小の標本数を求めない)', ag0.actions.length === 1 && ag0.thresholdMs === 3 * DAY && ag0.source === 'agreed' && ag0.p85Ms === null, JSON.stringify(ag0));
check('IMPL-0283:ok 通知の文に閾値の出所(合意した値)が入り、85パーセンタイルが算定できないことも書く', /G-1 で合意した値/.test(ag0.actions[0].body) && /算定できない/.test(ag0.actions[0].body) && ag0.notes.some((n) => /合意した値/.test(n)));
check('IMPL-0283:ok 合意した値 3日 は、2日経過の作業単位に通知しない', flowActions({ open: [unit({ startAt: iso(t0 - 2 * DAY) })], closed: [], now: NOW, config, agreed: A3 }).actions.length === 0);
const ag10 = flowActions({ open: [unit({ startAt: iso(t0 - 4 * DAY) })], closed: closedOf(10), now: NOW, config, agreed: A3 });
check('IMPL-0283:ok 合意した値と85パーセンタイル(9日)が両方算定できるとき、閾値は合意した値で、出力と通知の文に両方の値を並べる', ag10.thresholdMs === 3 * DAY && ag10.p85Ms === 9 * DAY && ag10.actions.length === 1 && /3 日/.test(ag10.actions[0].body) && /9 日/.test(ag10.actions[0].body) && ag10.notes.some((n) => /3 日/.test(n) && /9 日/.test(n)), JSON.stringify(ag10));
const ag14 = flowActions({ open: [unit({ startAt: iso(t0 - 10 * DAY) })], closed: closedOf(10), now: NOW, config, agreed: { kind: 'agreed', days: 14, raw: '2週間' } });
check('IMPL-0283:ok 合意した値の方が長いときは短い方へ読み替えない(10日経過は85パーセンタイル 9日 を超えるが通知しない)', ag14.actions.length === 0 && ag14.thresholdMs === 14 * DAY);
const bad = flowActions({ open: [unit({})], closed: closedOf(10), now: NOW, config, agreed: { kind: 'unreadable', raw: 'しばらく' } });
check('IMPL-0283:ng 書式が読めない値は注意を出して85パーセンタイルへ戻る(通知の文は85パーセンタイル)', bad.source === 'p85' && bad.thresholdMs === 9 * DAY && bad.notes.some((n) => /合意した値を読めない/.test(n)) && /85パーセンタイル\(9 日\)/.test(bad.actions[0].body), JSON.stringify(bad));
check('IMPL-0283:ok 欄が空・85パーセンタイルの語・企画書なしは現行の挙動(通知の文は85パーセンタイル)', [null, { kind: 'none' }, { kind: 'percentile' }].every((a) => { const x = flowActions({ open: [unit({})], closed: closedOf(10), now: NOW, config, agreed: a }); return x.source === 'p85' && x.thresholdMs === 9 * DAY && !x.notes.some((n) => /合意した値/.test(n)); }));
check('IMPL-0283:ok 合意した値のとき、通知の1回だけの印は変わらない', flowActions({ open: [unit({ startAt: iso(t0 - 4 * DAY), comments: [{ body: ag10.actions[0].body, login: 'github-actions[bot]' }] })], closed: closedOf(10), now: NOW, config, agreed: A3 }).actions.length === 0);

// 着手の時点の定義
const tl = [
  { event: 'labeled', label: { name: 'state:in-progress' }, created_at: '2026-11-05T00:00:00Z' },
  { event: 'cross-referenced', source: { issue: { pull_request: {}, created_at: '2026-11-07T00:00:00Z' } } },
  { event: 'cross-referenced', source: { issue: { created_at: '2026-11-01T00:00:00Z' } } },
];
check('着手の時点: 最初の PR が開かれた時点(Issue の参照・ラベルより優先)', startOf(tl) === '2026-11-07T00:00:00Z');
check('着手の時点: PR が無ければ state:in-progress を最初に付けた時点', startOf([tl[0], { event: 'labeled', label: { name: 'state:in-progress' }, created_at: '2026-11-09T00:00:00Z' }]) === '2026-11-05T00:00:00Z');
check('着手の時点: どちらも無ければ null', startOf([{ event: 'labeled', label: { name: 'bug' }, created_at: '2026-11-05T00:00:00Z' }]) === null);

// 着手の時点: 同じリポジトリの PR に限り、Issue の作成より前には遡らない(M4)
const xr = (created, full) => ({ event: 'cross-referenced', source: { issue: { pull_request: {}, created_at: created, repository: { full_name: full } } } });
check('着手の時点: Issue の作成より前に作られた PR の言及は、Issue の作成の時点を下限にする', startOf([xr('2026-01-01T00:00:00Z', 'o/r')], { repo: 'o/r', issueCreatedAt: '2026-11-01T00:00:00Z' }) === '2026-11-01T00:00:00Z');
check('着手の時点: 他のリポジトリの PR は数えない', startOf([xr('2026-11-02T00:00:00Z', 'x/y')], { repo: 'o/r', issueCreatedAt: '2026-11-01T00:00:00Z' }) === null);
check('着手の時点: Issue より後に作られた同じリポジトリの PR はその時点', startOf([xr('2026-11-05T00:00:00Z', 'o/r')], { repo: 'o/r', issueCreatedAt: '2026-11-01T00:00:00Z' }) === '2026-11-05T00:00:00Z');

// 読み取りの整形(固定の応答。PR・完了以外の理由で閉じた Issue・PR が既定ブランチへ取り込まれていない Issue は数えない)
let slurped = true;
const canned = (args) => {
  const p = args[args.length - 1];
  if (args[1] === 'graphql') {
    const node = (number, stateReason, merged, base) => ({ number, createdAt: '2026-11-01T00:00:00Z', closedAt: '2026-11-10T00:00:00Z', stateReason, closedByPullRequestsReferences: { nodes: [{ merged, baseRefName: base }] } });
    return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [node(8, 'COMPLETED', true, 'main'), node(9, 'NOT_PLANNED', true, 'main'), node(10, 'COMPLETED', false, 'main'), node(11, 'COMPLETED', true, 'dev')] } } });
  }
  if (!args.includes('--slurp')) slurped = false;
  if (p === "repos/o/r") return JSON.stringify([{ default_branch: 'main' }]);
  if (p.includes("issues?state=open")) return JSON.stringify([[{ number: 5, created_at: '2026-10-01T00:00:00Z', assignees: [{ login: 'bob' }] }, { number: 6, pull_request: {} }]]);
  if (p.includes("/timeline")) return JSON.stringify([[{ event: 'labeled', label: { name: 'state:in-progress' }, created_at: '2026-11-01T00:00:00Z' }]]);
  if (p.includes("issues/5/comments")) return JSON.stringify([[{ body: 'x', user: { login: 'bob' } }]]);
  throw new Error(`想定外: ${p}`);
};
const u = fetchUnits((a) => canned(a), 'o/r', { now: NOW });
check('読み取り: PR と完了でない Issue を除き(完了の判定は next.mjs と同じ)、着手の時点を付ける', u.open.length === 1 && u.open[0].startAt === '2026-11-01T00:00:00Z' && u.closed.length === 1 && u.closed[0].number === 8 && u.closed[0].closedAt === '2026-11-10T00:00:00Z' && u.truncated === false, JSON.stringify(u));
check('読み取り: --paginate --slurp で呼ぶ', slurped);
check('完了の判定は next.mjs の isCompletedUnit と同じ', isCompletedUnit({ stateReason: 'COMPLETED', prs: [{ merged: true, baseRefName: 'main' }], base: 'main' }) && !isCompletedUnit({ stateReason: 'COMPLETED', prs: [], base: 'main' }));

// 入口(main): 企画書の欄(PIT_IN_BRIEF の指す一時の企画書)を読んで閾値に使う結線。gh と出力は差し替える(独立の突合 1 巡目 高-3)。
// 作業単位 #5 は着手から 17 日。閉じた作業単位は 1 件(最小標本 10 件に足りない)なので、合意した値を読まなければ算定できず通知しない
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-main-'));
  try {
    const write = (name, row) => { fs.writeFileSync(path.join(dir, name), `# 企画書\n\n- 滞留と判定する経過時間: ${row}\n`); return path.join(dir, name); };
    const run = (briefPath) => {
      const out = [];
      flowMain(['--dry-run', '--now', NOW], { gh: (a) => canned(a), env: { GITHUB_REPOSITORY: 'o/r', ...(briefPath ? { PIT_IN_BRIEF: briefPath } : {}) }, config, log: (l) => out.push(l) });
      return out.join('\n');
    };
    const withAgreed = run(write('agreed.md', '3日'));
    check('IMPL-0283:ng 入口: 企画書に合意した値(3日)があると、標本が足りなくても main が読んで通知する(結線)', /Issue #5: 滞留の通知\(dry-run\)/.test(withAgreed) && /通知 1 件/.test(withAgreed) && /G-1 で合意した値/.test(withAgreed), withAgreed);
    const none = run(path.join(dir, 'no-such-brief.md'));
    check('IMPL-0283:ok 入口: 企画書が無ければ 85 パーセンタイルのまま。標本が足りなければ算定できず通知しない', /通知 0 件/.test(none) && /算定できない/.test(none), none);
    const empty = run(write('empty.md', ''));
    check('IMPL-0283:ok 入口: 欄が空なら通知しない(標本が足りない)', /通知 0 件/.test(empty), empty);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// TZ に依らない
const snippet = "import('./scripts/gate/flow-observation.mjs').then(m=>{const D=86400000,n=Date.parse('2026-11-18T00:00:00Z');const c=Array.from({length:10},(_,i)=>({number:i,startAt:new Date(n-(i+2)*D).toISOString(),closedAt:new Date(n-D).toISOString()}));const r=m.flowActions({open:[{number:1,startAt:'2026-10-01T00:00:00Z',assignees:[],comments:[]}],closed:c,now:'2026-11-18T00:00:00Z',config:{}});console.log(JSON.stringify([r.thresholdMs,r.actions.length]))})";
const run = (tz) => execFileSync(process.execPath, ['-e', snippet], { env: { ...process.env, TZ: tz }, cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' }).trim();
const [a, b] = [run('UTC'), run('Asia/Tokyo')];
check('TZ に依らない: TZ=UTC と TZ=Asia/Tokyo で同じ結果', a === b && /^\[\d+,1\]$/.test(a), `${a} / ${b}`);

console.log(failures ? `\n滞留期間の観測の試験: ${checks} 件のうち ${failures} 件が期待と一致しません` : `\n滞留期間の観測の試験: ${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
