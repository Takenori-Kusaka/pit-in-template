// 滞留期間の観測と通知の試験(IMPL-0283。process-compass #443)。
// 時計と TZ に依らない: now は固定の時刻を渡し、差は UTC のミリ秒で測る。子プロセスで TZ=UTC と TZ=Asia/Tokyo の結果が同じことを確かめる。
//
//   node scripts/gate/test-flow-observation.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flowActions, percentile, startOf, fetchUnits } from './flow-observation.mjs';

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
check('IMPL-0283:ok 同じ超過で2回目は出さない', flowActions({ open: [unit({ comments: [{ body: r.actions[0].body }] })], closed: closedOf(10), now: NOW, config }).actions.length === 0);
const noOwner = flowActions({ open: [unit({})], closed: closedOf(10), now: NOW, config: { ...config, seats: [] } });
check('価値責任者を解決できなければ担当者だけを記名し、注意に書く', noOwner.actions.length === 1 && !/@alice/.test(noOwner.actions[0].body) && noOwner.notes.some((n) => /価値責任者/.test(n)));
check('着手の時点が無い作業単位は数えない', flowActions({ open: [unit({ startAt: null })], closed: closedOf(10), now: NOW, config }).actions.length === 0);

// 着手の時点の定義
const tl = [
  { event: 'labeled', label: { name: 'state:in-progress' }, created_at: '2026-11-05T00:00:00Z' },
  { event: 'cross-referenced', source: { issue: { pull_request: {}, created_at: '2026-11-07T00:00:00Z' } } },
  { event: 'cross-referenced', source: { issue: { created_at: '2026-11-01T00:00:00Z' } } },
];
check('着手の時点: 最初の PR が開かれた時点(Issue の参照・ラベルより優先)', startOf(tl) === '2026-11-07T00:00:00Z');
check('着手の時点: PR が無ければ state:in-progress を最初に付けた時点', startOf([tl[0], { event: 'labeled', label: { name: 'state:in-progress' }, created_at: '2026-11-09T00:00:00Z' }]) === '2026-11-05T00:00:00Z');
check('着手の時点: どちらも無ければ null', startOf([{ event: 'labeled', label: { name: 'bug' }, created_at: '2026-11-05T00:00:00Z' }]) === null);

// 読み取りの整形(固定の応答。PR と、完了以外の理由で閉じた Issue は数えない)
const canned = (args) => {
  const p = args[args.length - 1];
  if (/issues\?state=open/.test(p)) return JSON.stringify([{ number: 5, assignees: [{ login: 'bob' }] }, { number: 6, pull_request: {} }]);
  if (/issues\?state=closed/.test(p)) return JSON.stringify([{ number: 8, state_reason: 'completed', closed_at: '2026-11-10T00:00:00Z' }, { number: 9, state_reason: 'not_planned', closed_at: '2026-11-10T00:00:00Z' }]);
  if (/issues\/\d+\/timeline/.test(p)) return JSON.stringify([{ event: 'labeled', label: { name: 'state:in-progress' }, created_at: '2026-11-01T00:00:00Z' }]);
  if (/issues\/5\/comments/.test(p)) return JSON.stringify([{ body: 'x' }]);
  throw new Error(`想定外: ${p}`);
};
const u = fetchUnits((a) => canned(a), 'o/r', { now: NOW });
check('読み取り: PR と完了以外の理由で閉じた Issue を除き、着手の時点を付ける', u.open.length === 1 && u.open[0].startAt === '2026-11-01T00:00:00Z' && u.closed.length === 1 && u.closed[0].number === 8, JSON.stringify(u));

// TZ に依らない
const snippet = "import('./scripts/gate/flow-observation.mjs').then(m=>{const D=86400000,n=Date.parse('2026-11-18T00:00:00Z');const c=Array.from({length:10},(_,i)=>({number:i,startAt:new Date(n-(i+2)*D).toISOString(),closedAt:new Date(n-D).toISOString()}));const r=m.flowActions({open:[{number:1,startAt:'2026-10-01T00:00:00Z',assignees:[],comments:[]}],closed:c,now:'2026-11-18T00:00:00Z',config:{}});console.log(JSON.stringify([r.thresholdMs,r.actions.length]))})";
const run = (tz) => execFileSync(process.execPath, ['-e', snippet], { env: { ...process.env, TZ: tz }, cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' }).trim();
const [a, b] = [run('UTC'), run('Asia/Tokyo')];
check('TZ に依らない: TZ=UTC と TZ=Asia/Tokyo で同じ結果', a === b && /^\[\d+,1\]$/.test(a), `${a} / ${b}`);

console.log(failures ? `\n滞留期間の観測の試験: ${checks} 件のうち ${failures} 件が期待と一致しません` : `\n滞留期間の観測の試験: ${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
