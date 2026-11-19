// 確認を求める項目の並びの試験(IMPL-0175。process-compass #443)。
// 時計と TZ に依らない: 日付は引数で渡す。子プロセスで TZ=UTC と TZ=Asia/Tokyo の同一を確かめる。
//
//   node scripts/gate/test-review-order.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { orderItems, isoWeekOf, splitItems, isRealDay, emphasizeItems, emphasizeItem, emphasisStyleOf, stripEmphasis } from './review-order.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 500)}`}`);
}

const items = ['基準1 受入基準との対応', '基準2 テストの削除の有無', '基準3 判断記録の添付', '基準4 外部インタフェース', '基準5 依存の追加', '基準6 検証の記録'];
const base = { gate: 'G-6', target: 'PR-123', risk: 'R2', day: '2026-11-18' };
const order = (o = {}) => orderItems(items, { ...base, ...o });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- ISO 週 ----
check('ISO 週: 2026-11-18(水)は 2026-W47', isoWeekOf('2026-11-18') === '2026-W47');
check('ISO 週: 年またぎ 2027-01-01(金)は 2026-W53、2024-12-30(月)は 2025-W01', isoWeekOf('2027-01-01') === '2026-W53' && isoWeekOf('2024-12-30') === '2025-W01');
check('ISO 週: 同じ週の月曜と日曜は同じ', isoWeekOf('2026-11-16') === isoWeekOf('2026-11-22') && isoWeekOf('2026-11-22') !== isoWeekOf('2026-11-23'));
check('日付: 実在しない日は読めない', !isRealDay('2026-02-30') && !isRealDay('2026-11-18T00:00') && isRealDay('2026-02-28'));

// ---- 並び ----
const r1 = order();
check('IMPL-0175:ok 同じ種(ゲート・対象・週・リスク区分)で同じ並びになる', same(r1.items, order().items) && r1.rotated === true && r1.week === '2026-W47');
check('IMPL-0175:ok 同じ週の別の日でも同じ並びになる', same(r1.items, order({ day: '2026-11-22' }).items) && same(r1.items, order({ day: '2026-11-16' }).items));
check('IMPL-0175:ok 項目の集合は変わらない(入れ替えるだけ。文も番号も変えない)', same([...r1.items].sort(), [...items].sort()) && r1.items.length === items.length);
const weeks = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21'];
const orders = new Set(weeks.map((day) => JSON.stringify(order({ day }).items)));
check('IMPL-0175:ok 週が変われば並びが変わる(8週で 2 通り以上、隣り合う週が同じ並びなのは半数未満)', orders.size >= 2 && weeks.slice(1).filter((day, i) => same(order({ day }).items, order({ day: weeks[i] }).items)).length < 4, orders.size);
{
  // 隣り合う週は常に違う並びになる(項目 2・3・4 個、2026 年の全週。年またぎを含む)
  const mondays = Array.from({ length: 106 }, (_, k) => new Date(Date.parse('2026-01-05T00:00:00Z') + k * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10));
  for (const n of [2, 3, 4]) {
    const its = items.slice(0, n);
    const seq = mondays.map((day) => orderItems(its, { ...base, day }).items);
    const bad = seq.filter((s, i) => i > 0 && same(s, seq[i - 1])).length;
    check(`IMPL-0175:ng 項目 ${n} 個で、隣り合う週が同じ並びになる週は無い(106 週)`, bad === 0, bad);
  }
}
check('IMPL-0175:ok 同じ週は日が違っても同じ並び(連鎖を使っても決定的)', same(order({ day: '2026-11-17' }).items, order({ day: '2026-11-21' }).items));
check('IMPL-0175:ok 起点(2000-01-03)より前の日付は保証しないと理由に書いて並べる', /保証しない/.test(order({ day: '1999-12-01' }).reason));
check('IMPL-0175:ok 対象・ゲートが違えば種が変わる', !same(order({ target: 'PR-124' }).items, r1.items) || !same(order({ gate: 'G-3' }).items, r1.items));
check('IMPL-0175:ng R3 は回さない(入力の順のまま)', same(order({ risk: 'R3' }).items, items) && order({ risk: 'R3' }).rotated === false);
check('IMPL-0175:ok R1 は回す', order({ risk: 'R1' }).rotated === true);
check('項目が1つ以下なら回さない', orderItems(['a'], base).rotated === false && orderItems([], base).items.length === 0);
check('入力の配列を書き換えない', (() => { const c = [...items]; orderItems(c, base); return same(c, items); })());

// ---- 強調の様式(全部の項目へ同じ様式。IMPL-0175・束 B26) ----
const thr = (f) => { try { f(); return false; } catch { return true; } };
const ebase = { gate: 'G-6', target: 'PR-123', risk: 'R2' };
const eitems = ['- 基準1 受入基準との対応\n  続きの行', '- 基準2: テストの削除の有無', '基準3 判断記録の添付', '・基準4、外部インタフェース'];
const em = (day, o = {}) => emphasizeItems(eitems, { ...ebase, day, ...o });
const eDays = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21'];
check('IMPL-0175:ok 同じ種(ゲート・対象・週)で同じ強調の出力になる(同じ週の別の日でも)', same(em('2026-11-18').items, em('2026-11-18').items) && same(em('2026-11-16').items, em('2026-11-22').items));
check('IMPL-0175:ok 強調の印を除けば、項目の文と番号は入力と同じ(全週・全様式)', eDays.every((d) => same(em(d).items.map(stripEmphasis), eitems)));
check('IMPL-0175:ok 隣り合う週は必ず様式が変わり、4 週で 4 つの様式が出る(週が変われば様式が変わる)', eDays.slice(1).every((d, i) => em(d).style !== em(eDays[i]).style) && new Set(eDays.slice(0, 4).map((d) => em(d).style)).size === 4);
check('IMPL-0175:ok 全部の項目へ同じ様式を付ける(特定の1項目を選ばない)。どの様式でも全項目の1行目に印がある', eDays.slice(0, 4).every((d) => { const r = em(d); return r.items.every((x, i) => x !== eitems[i]) && r.items.length === eitems.length; }));
const byStyle = Object.fromEntries(eDays.slice(0, 4).map((d) => [em(d).style, em(d).items]));
check('IMPL-0175:ok 様式 0 は先頭の識別、1 は1行目、2・3 は行頭の印(続きの行と字下げは変えない)', byStyle[0][0] === '- **基準1** 受入基準との対応\n  続きの行' && byStyle[0][1] === '- **基準2**: テストの削除の有無' && byStyle[0][3] === '・**基準4**、外部インタフェース' && byStyle[1][0] === '- **基準1 受入基準との対応**\n  続きの行' && byStyle[2][2] === '▶ 基準3 判断記録の添付' && byStyle[3][0] === '- ◆ 基準1 受入基準との対応\n  続きの行', JSON.stringify(byStyle));
check('IMPL-0175:ng R3 は強調を付けない(入力のまま)', same(em('2026-11-18', { risk: 'R3' }).items, eitems) && em('2026-11-18', { risk: 'R3' }).style === null);
check('IMPL-0175:ok 対象が違えば様式の起点が変わりうる(100 対象で 2 通り以上)', new Set(Array.from({ length: 100 }, (_, i) => em('2026-11-18', { target: `PR-${i}` }).style)).size >= 2);
check('IMPL-0175:ok すでに ** を含む項目には太字を足さない(様式 0)', emphasizeItem('- **基準1** 文', 0) === '- **基準1** 文');
check('IMPL-0175:ng 強調でも不正なゲート・リスク区分・日付は例外', thr(() => emphasisStyleOf({ ...ebase, gate: 'G-9', day: '2026-11-18' })) && thr(() => emphasisStyleOf({ ...ebase, risk: 'R4', day: '2026-11-18' })) && thr(() => emphasisStyleOf({ ...ebase, day: '2026-02-30' })));
check('IMPL-0175:ok 並びは強調に影響されない(orderItems の出力は強調前のまま)', same(order().items.map(stripEmphasis), order().items));

// ---- 入力の検査 ----
const throws = (f) => { try { f(); return false; } catch { return true; } };
check('IMPL-0175:ng ゲート・リスク区分・日付・対象が不正なら例外', throws(() => order({ gate: 'G-9' })) && throws(() => order({ risk: 'R4' })) && throws(() => order({ day: 'x' })) && throws(() => order({ target: ' ' })));

// ---- 項目の塊 ----
const text = '- 項目A\n  続きの行\n\n- 項目B\n- 項目C\n';
const sp = splitItems(text);
check('項目の塊: 字下げした行・空行は直前の項目の続き', sp.length === 3 && sp[0].includes('続きの行') && sp[1] === '- 項目B', JSON.stringify(sp));

// ---- 見出しと機械が読む欄は変えない: 雛形を渡しても見出し・欄の行は動かさない前提で、項目の行だけを入力にする ----
const gateMd = fs.readFileSync(fileURLToPath(new URL('../../.claude/skills/gate/SKILL.md', import.meta.url)), 'utf8');
check('SKILL.md が review-order.mjs を案内し、/human-verify と R3 を回さないと書く', /review-order\.mjs/.test(gateMd) && /human-verify/.test(gateMd) && /R3/.test(gateMd));

// ---- 時計と TZ に依らない ----
const run = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e', `import { orderItems } from ${JSON.stringify(new URL('./review-order.mjs', import.meta.url).href)}; console.log(JSON.stringify(orderItems(${JSON.stringify(items)}, ${JSON.stringify(base)}).items))`], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();
check('TZ=UTC と TZ=Asia/Tokyo で同じ並び', run('UTC') === run('Asia/Tokyo') && run('UTC') === JSON.stringify(r1.items));

// ---- 命令行 ----
const cli = (args, input) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [fileURLToPath(new URL('./review-order.mjs', import.meta.url)), ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: String(e.stderr) };
  }
};
const c1 = cli(['--gate', 'G-6', '--target', 'PR-123', '--risk', 'R2', '--date', '2026-11-18'], items.join('\n'));
check('命令行: 標準入力の項目を同じ並びで出し、強調の印を除けば文は同じ(全部の項目に同じ様式)', c1.code === 0 && same(c1.out.trimEnd().split('\n').map(stripEmphasis), r1.items) && same(c1.out.trimEnd().split('\n'), emphasizeItems(r1.items, { gate: 'G-6', target: 'PR-123', risk: 'R2', day: '2026-11-18' }).items), c1.out);
check('命令行: 引数が足りなければ終了コード 2', cli(['--gate', 'G-6'], 'a').code === 2);

console.log(failures ? `\n${failures} 件が期待と異なる` : '\n確認を求める項目の並びの試験: すべて期待どおり');
process.exit(failures ? 1 : 0);
