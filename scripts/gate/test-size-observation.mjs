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
// IMPL-0270:ok(違反と適合の対。標準の実装マーク。process-compass #314)
check('内訳: 行・ファイル・別集計・ファイル数だけ・理由不明', JSON.stringify(a.overReasons) === JSON.stringify({ lines: 1, files: 1, test: 1, filesOnly: 1, unknown: 1 }), JSON.stringify(a.overReasons));
const ratio = Object.fromEntries(a.testRatio.over.map((o) => [o.factor, o.count]));
check('倍率: 1 倍超 2 件・2 倍超 2 件・5 倍超 1 件(倍率の無い PR は数えない)', ratio[1] === 2 && ratio[2] === 2 && ratio[5] === 1 && a.testRatio.measured === 4, JSON.stringify(a.testRatio));
check('読めない PR は別に数える', a.unreadable.length === 1 && a.unreadable[0] === 6 && a.measured === 5);
check('超過の件数', a.over === 4);
const text = renderSizeObservation(a).join('\n');
check('表: 超過の理由の内訳と倍率を出す', /ファイル/.test(text) && /5 倍/.test(text), text.slice(0, 800));
// IMPL-0270:ng(違反と適合の対。標準の実装マーク。process-compass #314)
check('表: 前回との比較を出さない', !/前回/.test(text.replace(/前回の集約との比較は出さない[^\n]*/g, '')), text.slice(0, 800));

// 承認までの時間と規模の比(IMPL-0159)と、文書だけの変更の承認までの時間(IMPL-0136 の観測)。純関数の確認。通しは test-approval-pace.mjs
{
  const sz = (lines) => ({ lines, files: 1, testLines: 0, over: false, overReasons: { lines: false, files: false, test: false }, testRatio: 0 });
  const set = [
    pr(1, sz(50), { reviewMinutes: 100 }), // 200 分 / 100 行
    pr(2, sz(80), { reviewMinutes: 40 }), // 50 分 / 100 行
    pr(3, sz(100), { reviewMinutes: 400 }), // 400 分 / 100 行
    pr(4, sz(10), { reviewMinutes: 10 }), // 100 分 / 100 行
    pr(5, sz(200), { reviewMinutes: 20 }), // 10 分 / 100 行(別の区間)
    pr(6, sz(30), { reviewMinutes: null }), // 人の承認なし
    pr(7, sz(0), { reviewMinutes: 5 }), // 算定行数 0
    pr(8, sz(0), { reviewMinutes: 60 * 50, docOnly: true }),
    pr(9, sz(0), { reviewMinutes: 60 * 100, docOnly: true }),
    pr(10, sz(0), { reviewMinutes: null, docOnly: true }),
  ];
  const s = summarizeSizeObservation(set);
  const ap = s.approvalPace;
  const small = ap.byLines[0];
  // IMPL-0159:ok(区間ごとの値。100 行以下は 4 件で昇順 50, 100, 200, 400)
  check('比: 100 行以下の区間は件数 4(#1〜#4)で、最小 50・下位四分位 50・中央値 100(分 / 100 行)', small.count === 4 && small.minPer100 === 50 && small.q1Per100 === 50 && small.medianPer100 === 100, JSON.stringify(small));
  check('比: 101〜400 行の区間は #5 だけ(10 分 / 100 行)', ap.byLines[1].count === 1 && ap.byLines[1].medianPer100 === 10, JSON.stringify(ap.byLines[1]));
  check('比: 承認なしは unmeasured、算定行数 0 は noDenominator(文書だけの変更は入らない)', ap.unmeasured === 1 && ap.noDenominator === 1, JSON.stringify(ap));
  check('比: points は番号・算定行数・分だけ', ap.points.length === 5 && ap.points.every((p) => JSON.stringify(Object.keys(p)) === '["number","lines","minutes"]'), JSON.stringify(ap.points));
  // IMPL-0136:ok(観測。文書だけの変更は件数と時間の区間だけ)
  check('文書だけ: 3 件、50 時間は 96 時間以内、100 時間は 96 時間超、取れなかった 1 件', s.docOnly.count === 3 && s.docOnly.hours.join() === '0,0,1,1' && s.docOnly.unmeasured === 1, JSON.stringify(s.docOnly));
  // IMPL-0159:ng(承認者を特定する値を出さない。入力に login があっても、出力に持ち越さない)
  const leak = summarizeSizeObservation([pr(1, sz(50), { reviewMinutes: 100, approvers: ['alice'], g6: { approver: 'alice' } })]);
  check('比: 出力のどこにも login が無い', !/alice/.test(JSON.stringify(leak)) && !/alice/.test(renderSizeObservation(leak).join('\n')));
  check('比: 同じ入力から同じ出力・入力の並びに依らない', JSON.stringify(summarizeSizeObservation([...set].reverse())) === JSON.stringify(s));
  const t2 = renderSizeObservation(s).join('\n');
  check('表: 2つの見出しに「観測」と「合否にも警戒の条件にも使わない」「SLA の判定ではない」を書く', /承認までの時間と規模の比\(観測。.*合否にも警戒の条件にも使わない\)/.test(t2) && /SLA の判定ではない/.test(t2), t2.slice(-900));
}

console.log('');
if (failures) {
  console.log(`規模の観測の試験: ${failures} / ${n} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`規模の観測の試験: ${n} 件が期待と一致しました`);
