// 規模の観測の試験(標準 第4章「基準値を超えた変更の扱い」の観測。process-compass #296 L-8)。
//
//   node scripts/gate/test-size-observation.mjs
//
// 固定する決定:
//   - 同じ入力からは同じ出力を返す(決定性)。入力の並びに依らない
//   - 超過の理由の内訳(行・ファイル・別集計・ファイル数だけ・理由不明)を数える
//   - 別集計の基準行数に対する倍率を、1 倍超・2 倍超・5 倍超で数える
//   - 前回の集約との比較は出さない(課さないと決めた)

import { summarizeSizeObservation, renderSizeObservation } from './size-observation.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${String(detail).slice(0, 600)}`}`);
};

const pr = (number, size, extra = {}) => ({ number, size, riskClass: 'R2', reviewMinutes: 30, ...extra });
const prs = [
  pr(3, { lines: 50, files: 2, testLines: 10, over: false, overReasons: { lines: false, files: false, test: false }, testRatio: 0.03 }),
  pr(1, { lines: 500, files: 3, testLines: 900, over: true, overReasons: { lines: true, files: false, test: false }, testRatio: 2.25 }, { sizeAttestation: { readAll: 'yes' } }),
  pr(2, { lines: 100, files: 20, testLines: 0, over: true, overReasons: { lines: false, files: true, test: false }, testRatio: 0 }, { sizeAttestation: { readAll: 'no' } }),
  pr(5, { lines: 10, files: 1, testLines: 2100, over: true, overReasons: { lines: false, files: false, test: true }, testRatio: 5.25 }),
  pr(4, { lines: 410, files: 1, over: true }),
  pr(6, null),
];

const a = summarizeSizeObservation(prs);
const b = summarizeSizeObservation([...prs].reverse());
check('決定性: 同じ入力を2回与えると同じ出力', JSON.stringify(summarizeSizeObservation(prs)) === JSON.stringify(a));
check('決定性: 入力の並びに依らない', JSON.stringify(a) === JSON.stringify(b), JSON.stringify([a.overPrs, b.overPrs]));
check('決定性: 表の文字列も同じ', renderSizeObservation(a).join('\n') === renderSizeObservation(b).join('\n'));
check('内訳: 行・ファイル・別集計・ファイル数だけ・理由不明', JSON.stringify(a.overReasons) === JSON.stringify({ lines: 1, files: 1, test: 1, filesOnly: 1, unknown: 1 }), JSON.stringify(a.overReasons));
const ratio = Object.fromEntries(a.testRatio.over.map((o) => [o.factor, o.count]));
check('倍率: 1 倍超 2 件・2 倍超 2 件・5 倍超 1 件(倍率の無い PR は数えない)', ratio[1] === 2 && ratio[2] === 2 && ratio[5] === 1 && a.testRatio.measured === 4, JSON.stringify(a.testRatio));
check('読めない PR は別に数える', a.unreadable.length === 1 && a.unreadable[0] === 6 && a.measured === 5);
check('超過の件数', a.over === 4);
const text = renderSizeObservation(a).join('\n');
check('表: 超過の理由の内訳と倍率を出す', /ファイル/.test(text) && /5 倍/.test(text), text.slice(0, 800));
check('表: 前回との比較を出さない', !/前回/.test(text.replace(/前回の集約との比較は出さない[^\n]*/g, '')), text.slice(0, 800));

console.log('');
if (failures) {
  console.log(`規模の観測の試験: ${failures} / ${n} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`規模の観測の試験: ${n} 件が期待と一致しました`);
