// 能力依存の定数の再評価待ち(recalibration.mjs)の試験。
//
//   node scripts/gate/test-recalibration.mjs
//
// 契機は、changeLog の performer と暦(最初の記録の日付から半期)だけである。config.generatedAt は /process-change のたびに
// 更新されるため基準日に使わない。GitHub へ問い合わせない。

import { recalibrationState, recalibrationNote, readRegistry } from './recalibration.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

const people = [{ id: 'p1', name: '山田 太郎', accounts: ['yamada'] }, { id: 'p2', name: '鈴木 一郎', accounts: ['suzuki'] }];
const init = { kind: 'init', date: '2026-10-01' };
// generatedAt は、無関係な settings の変更で今日へ更新された値(基準日に使うと契機を失う)
const cfg = (extra = [], generatedAt = '2026-10-10T09:00:00+09:00') => ({ generatedAt, people, changeLog: [init, ...extra] });
const ids = (st) => st.pending.map((p) => p.id).join(',');
const ALL = 'RC-01,RC-02,RC-03,RC-04,RC-05,RC-06,RC-07,RC-08';
const registry = readRegistry();

const base = recalibrationState(cfg(), { today: '2026-10-11', recordsText: '' });
check('初期: 契機が無ければ 0 件', base.count === 0, ids(base));

const p1 = recalibrationState(cfg([{ kind: 'performer', date: '2026-10-05' }]), { today: '2026-10-11', recordsText: '' });
check('performer の変更(generatedAt が新しくても)で RC-01〜08 が出る', ids(p1) === ALL, ids(p1));
check('能力に依らない RC-09〜11 は数えない', p1.notDependent.join(',') === 'RC-09,RC-10,RC-11' && !p1.pending.some((p) => /RC-(09|10|11)/.test(p.id)), ids(p1));

const same = recalibrationState(cfg([{ kind: 'performer', date: '2026-10-01' }]), { today: '2026-10-02', recordsText: '' });
check('最初の記録と同じ日の performer の変更も拾う', ids(same) === ALL, ids(same));

const other = recalibrationState(cfg([{ kind: 'axis', date: '2026-10-05' }, { kind: 'mode', date: '2026-10-06' }]), { today: '2026-10-11', recordsText: '' });
check('performer 以外の変化点は契機にならない', other.count === 0, ids(other));

const rec = (rows) => `| ID | 判断 | 日付 | 記名 | 移した先の保証 |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
const solved = recalibrationState(cfg([{ kind: 'performer', date: '2026-10-05' }]), { today: '2026-10-11', recordsText: rec(['| RC-01 | 残す | 2026-10-08 | 山田 太郎 | |', '| RC-05 | 移す | 2026-10-08 | 鈴木 一郎 | 層1 の停止条件 |']) });
check('人の「残す」「移す」の記録で、その定数だけ解ける', ids(solved) === 'RC-02,RC-03,RC-04,RC-06,RC-07,RC-08', ids(solved));
const again = recalibrationState(cfg([{ kind: 'performer', date: '2026-10-05' }, { kind: 'performer', date: '2026-10-09' }]), { today: '2026-10-11', recordsText: rec(['| RC-01 | 残す | 2026-10-08 | 山田 太郎 | |']) });
check('記録の後の performer の変更で、解けた定数が再び出る', again.pending.some((p) => p.id === 'RC-01'), ids(again));

const bad = recalibrationState(cfg([{ kind: 'performer', date: '2026-10-05' }]), {
  today: '2026-10-11',
  recordsText: rec(['| RC-01 | 残す | 2026-10-08 | Claude | |', '| RC-02 | 外す | 2026-10-08 | 見知らぬ人 | |', '| RC-03 | 移す | 2026-10-08 | 山田 太郎 | |', '| RC-04 | 残す | 2026/10/08 | 山田 太郎 | |']),
});
check('AI の名義・名簿外・移した先なし・日付の形違いの記録は数えない(4 件を無視として出す)', bad.count === 8 && bad.ignored.length === 4, `${bad.count} / ${bad.ignored.length}`);

const day182 = recalibrationState(cfg(), { today: '2027-04-01', recordsText: '' });
const day183 = recalibrationState(cfg(), { today: '2027-04-02', recordsText: '' });
check('暦: 最初の記録から 182 日では出ない', day182.count === 0, ids(day182));
check('暦: 183 日で RC-01〜08 が出る(generatedAt が最近でも動かない)', ids(day183) === ALL, ids(day183));
const calSolved = recalibrationState(cfg(), { today: '2027-04-05', recordsText: rec(['| RC-01 | 残す | 2027-04-04 | 山田 太郎 | |']) });
check('暦: 記録の日から半期は、その定数を出さない', !calSolved.pending.some((p) => p.id === 'RC-01') && calSolved.count === 7, ids(calSolved));

const note = recalibrationNote(p1) ?? '';
check('注記: 人の帯域の定数(RC-01・02・04)は能力が上がったことを理由に緩めない旨を出す', /RC-01・RC-02・RC-04 は人の帯域に由来する。\*\*能力が上がったことを理由に緩めない\*\*/.test(note), note.slice(0, 400));
check('注記: 件数と記録の置き場を出す', /8 件/.test(note) && /docs\/calibration-register\.md/.test(note), note.slice(0, 200));
check('登録簿: RC-01・02・04 に noRelaxByCapability がある', ['RC-01', 'RC-02', 'RC-04'].every((id) => registry.constants.find((c) => c.id === id)?.noRelaxByCapability === true), '');

console.log('');
if (failures) {
  console.log(`再評価待ちの試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`再評価待ちの試験: ${n} 件が期待と一致しました`);
