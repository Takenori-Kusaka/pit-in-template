// モデルの導入の記録・正解の目録・AI の採点者の較正の記録の検査(model-adoption.mjs)の試験
// (標準 第3章 3.12.3 の要求事項1〜4・11〜16、3.12.13。process-compass #426 / ADR-0104・ADR-0105。IMPL-0405〜0407・0410・0411)。
//
//   node scripts/gate/test-model-adoption.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelAdoptionState, answersFindings, calibrationFindings, rehearsalJudgeFindings, MODEL_ADOPTION_FILE } from './model-adoption.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 600)}`}`);
}

const config = {
  aiNames: ['Claude'],
  people: [
    { id: 'p1', name: '山田 太郎' },
    { id: 'p2', name: '鈴木 一郎' },
    { id: 'p3', name: '佐藤 花子' },
  ],
  seats: [
    { role: 'ai-ops', accountable: 'p1' },
    { role: 'tech-lead', accountable: 'p2' },
    { role: 'independent-reviewer', accountable: 'p3' },
  ],
};
const goodJudge = (over = {}) => ({
  identity: { model: 'judge-model-2026-10-01', prompt: 'v3', settings: 'temperature=0' },
  readingRule: { rule: 'κ が 0.6 に届かなければ用いない', draftedBy: '山田 太郎', decidedBy: '鈴木 一郎', at: '2026-10-01' },
  sample: { method: 'random', sizeRule: '区間の幅 ±0.1 から決めた', upweighted: 0 },
  raters: [{ name: '佐藤 花子', at: '2026-10-02' }],
  arms: {
    current: { model: 'model-a', table: { pp: 40, pf: 3, fp: 2, ff: 15 }, indicator: { name: 'kappa', value: 0.78 }, interval: '0.62-0.90', simple: 0.92 },
    candidate: { model: 'model-b', table: { pp: 38, pf: 4, fp: 3, ff: 15 }, indicator: { name: 'kappa', value: 0.71 }, interval: '0.55-0.85', simple: 0.88 },
  },
  swapChanges: null,
  lengthControl: 'なし',
  reached: true,
  ...over,
});
const goodCase = (over = {}) => ({ id: 'C-1', kind: 'verdict', source: 'new', seat: 'independent-reviewer', confirmedBy: '佐藤 花子', at: '2026-09-20', draft: { model: 'drafter-1' }, revisions: [], ...over });

// ---------------------------------------------------------------- 3.12.13(IMPL-0410)
// IMPL-0410:ok(違反と適合の対。標準の実装マーク。process-compass #314)
let f = calibrationFindings(config, goodJudge(), { evaluatedAt: '2026-10-03', compared: ['model-a', 'model-b'] });
check('較正: 欄のそろった記録は有効', f.status === '有効', JSON.stringify(f.why));
// IMPL-0410:ng(違反と適合の対。標準の実装マーク。process-compass #314)
const j1 = goodJudge();
delete j1.arms.candidate.indicator;
f = calibrationFindings(config, j1, { compared: ['model-a', 'model-b'] });
check('較正: 偶然の一致を除く指標の無い記録(単純な一致率だけ)は未測定', f.status === '未測定' && f.why.some((w) => /偶然の一致を除く指標/.test(w)), JSON.stringify(f.why));
f = calibrationFindings(config, goodJudge({ arms: { current: goodJudge().arms.current } }), { compared: ['model-a', 'model-b'] });
check('較正: 比べる双方の一方の一致が無ければ未測定', f.status === '未測定' && f.why.some((w) => /model-b の一致が arms に無い/.test(w)), JSON.stringify(f.why));
f = calibrationFindings(config, goodJudge({ readingRule: { rule: 'x', decidedBy: 'Claude', at: '2026-10-01' } }));
check('較正: 読み方の記名が AI の名義なら未測定', f.status === '未測定' && f.why.some((w) => /読み方の記名/.test(w)), JSON.stringify(f.why));
f = calibrationFindings(config, goodJudge({ readingRule: { rule: 'x', decidedBy: '佐藤 花子', at: '2026-10-01' } }));
check('較正: 読み方を定めたのが技術判断者でなければ未測定', f.why.some((w) => /技術判断者の席の責任者でない/.test(w)), JSON.stringify(f.why));
f = calibrationFindings(config, goodJudge({ identity: { model: 'latest', prompt: 'v3', settings: 't=0' } }));
check('較正: 採点のモデルの版を別名(latest)で書いたら未測定', f.why.some((w) => /別名/.test(w)), JSON.stringify(f.why));
f = calibrationFindings(config, goodJudge({ raters: [{ name: 'Claude', at: '2026-10-02' }] }));
check('較正: 人の採点者が AI の名義なら未測定', f.why.some((w) => /人の採点者の記名/.test(w)), JSON.stringify(f.why));
f = calibrationFindings(config, goodJudge({ readingRule: { rule: 'x', decidedBy: '鈴木 一郎', at: '2026-10-05' } }), { evaluatedAt: '2026-10-03' });
check('較正: 回帰評価の日より後に定めた読み方を緩める向きとして示す', f.loosened === true);

// ---------------------------------------------------------------- 正解の目録(IMPL-0406)
// IMPL-0406:ok(違反と適合の対。標準の実装マーク。process-compass #314)
let a = answersFindings(config, { cases: [goodCase(), goodCase({ id: 'C-2', source: 'past-judgment', sourceRef: 'docs/gates/2026-09-01-g6.md', confirmedBy: undefined, at: undefined, seat: undefined })], blindConfirmation: 'なし' });
check('正解: 席の責任者が確定した事例と、人の過去の判定を引く事例は確定に数える', a.confirmed === 2 && !a.unconfirmed.length && !a.why.length, JSON.stringify(a));
// IMPL-0406:ng(違反と適合の対。標準の実装マーク。process-compass #314)
a = answersFindings(config, { cases: [goodCase({ confirmedBy: 'Claude' }), goodCase({ id: 'C-3', confirmedBy: '鈴木 一郎' }), goodCase({ id: 'C-4', confirmedBy: undefined })] });
check('正解: AI の名義・席の責任者でない者・記名の無い事例は確定なし', a.confirmed === 0 && a.unconfirmed.length === 3, JSON.stringify(a.unconfirmed));
check('正解: 盲検の確定の記録が無ければ出す', a.why.some((w) => /盲検の確定/.test(w)), JSON.stringify(a.why));
a = answersFindings(config, { cases: [goodCase({ seat: 'ai-ops', confirmedBy: '鈴木 一郎' })], blindConfirmation: { count: 0, agreement: null } });
check('正解: AI運用担当者の席の判断を再現する事例は技術判断者が確定する', a.confirmed === 1, JSON.stringify(a.unconfirmed));
a = answersFindings(config, { cases: [goodCase({ seat: 'ai-ops', confirmedBy: '鈴木 一郎' })], blindConfirmation: 'なし' }, { approvedBy: '鈴木 一郎' });
check('正解: 確定した者と導入を承認した者が同じなら分離の不成立を示す', a.notes.some((n) => /分離が成り立たない/.test(n)), JSON.stringify(a.notes));
a = answersFindings(config, { cases: [goodCase({ revisions: [{ from: '合格', to: '不合格', reason: '', confirmedBy: '佐藤 花子', at: '2026-09-25' }] })], blindConfirmation: 'なし' });
check('正解: 理由の無い正解の改めは確定なし', a.unconfirmed.length === 1, JSON.stringify(a.unconfirmed));

// ---------------------------------------------------------------- 導入の記録(IMPL-0405・0407)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-model-adoption-'));
const write = (rel, v) => {
  fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true });
  fs.writeFileSync(path.join(TMP, rel), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
};
write('docs/eval-baseline/cases.json', '[]');
write('docs/eval-baseline/answers.json', { cases: [goodCase()], blindConfirmation: 'なし' });
const adoption = (over = {}) => ({
  model: 'model-b', provider: 'p', replaces: 'model-a', baseline: 'docs/eval-baseline/', evaluatedAt: '2026-10-03', diff: 'docs/eval-baseline/diff-2026-10-03.md',
  approvedBy: '山田 太郎', approvedAt: '2026-10-04', change: '#42', grading: 'ai', judge: goodJudge(), ...over,
});
const run = (adoptions) => {
  write(MODEL_ADOPTION_FILE, { adoptions });
  return modelAdoptionState(config, { root: TMP });
};
// IMPL-0405:ok(違反と適合の対。標準の実装マーク。process-compass #314)
let s = run([adoption()]);
check('導入: 欄のそろった記録は承認ありとする', s.adoptions[0].approved === true, JSON.stringify(s.problems));
// IMPL-0405:ng(違反と適合の対。標準の実装マーク。process-compass #314)
s = run([adoption({ approvedBy: '鈴木 一郎', diff: '' })]);
check('導入: AI運用担当者でない承認と差分の欠けを出す', !s.adoptions[0].approved && s.problems.some((p) => /AI運用担当者の席の責任者でない/.test(p) && /差分の記録/.test(p)), JSON.stringify(s.problems));
s = run([adoption({ approvedAt: '2026-10-01' })]);
check('導入: 回帰評価より前の承認を出す', s.problems.some((p) => /承認の日が回帰評価の日より前/.test(p)), JSON.stringify(s.problems));
// IMPL-0407:ng(違反と適合の対。標準の実装マーク。process-compass #314)
s = run([adoption({ judge: goodJudge({ identity: { model: 'model-b', prompt: 'v3', settings: 't=0' }, arms: {} }) })]);
check('導入: 未測定かつ比べるモデルと同じ版で採点した差分は根拠に数えない', s.problems.some((p) => /同じモデル・版で採点した。差分を導入の根拠に数えない/.test(p)), JSON.stringify(s.problems));
s = run([adoption({ judge: goodJudge({ arms: {} }) })]);
check('導入: 未測定で受容の記録が無ければ出す', s.problems.some((p) => /期限つきの受容/.test(p)), JSON.stringify(s.problems));
// IMPL-0407:ok(違反と適合の対。標準の実装マーク。process-compass #314)
s = run([adoption({ judge: goodJudge({ arms: {} }), unmeasuredAcceptance: { by: '佐藤 花子', until: '2026-12-31' } })]);
check('導入: 未測定でも受容の記録があれば承認ありとし、注記に出す', s.adoptions[0].approved && s.notes.some((n) => /受容した/.test(n)), JSON.stringify(s));
s = run([adoption({ revisedAfterResults: [{ case: 'C-1', beforeResult: '' }] })]);
check('導入: 結果を見た後に改めた正解に、改める前の結果の併記が無ければ出す', s.problems.some((p) => /改める前の結果/.test(p)), JSON.stringify(s.problems));
s = run([adoption({ revisedAfterResults: [{ case: 'C-1', beforeResult: '不合格 3 件', failToPass: true }] })]);
check('導入: 不合格を合格へ改めた事例を緩める向きとして注記に出す', s.notes.some((n) => /不合格を合格へ改めた/.test(n)), JSON.stringify(s.notes));
write('docs/eval-baseline/answers.json', { cases: [goodCase({ confirmedBy: 'Claude' })], blindConfirmation: 'なし' });
s = run([adoption()]);
check('導入: 正解の目録に確定なしの事例があれば承認なし', !s.adoptions[0].approved && s.problems.some((p) => /確定なしの事例 1 件/.test(p)), JSON.stringify(s.problems));
fs.rmSync(path.join(TMP, 'docs/eval-baseline/answers.json'));
s = run([adoption()]);
check('導入: 正解の目録が無ければ出す', s.problems.some((p) => /正解の目録 .* が無い/.test(p)), JSON.stringify(s.problems));
check('導入: 記録の無い構成は present: false', modelAdoptionState(config, { root: os.tmpdir() + '/nonexistent-pit-in' }).present === false);

// ---------------------------------------------------------------- 退出の予行(IMPL-0411)
// IMPL-0411:ng(違反と適合の対。標準の実装マーク。process-compass #314)
let r = rehearsalJudgeFindings(config, [{ model: 'model-a', alternative: { model: 'other-1' }, at: '2026-10-01', grading: 'ai' }]);
check('退出の予行: AI の採点で較正の記録の無い予行を未測定と出す', r.length === 1 && /未測定/.test(r[0]), JSON.stringify(r));
// IMPL-0411:ok(違反と適合の対。標準の実装マーク。process-compass #314)
r = rehearsalJudgeFindings(config, [{ model: 'model-a', alternative: { model: 'model-b' }, at: '2026-10-03', grading: 'ai', judge: goodJudge() }, { model: 'x', at: '2026-10-01' }]);
check('退出の予行: 較正の記録のそろった予行と、AI の採点を用いない予行は出さない', r.length === 0, JSON.stringify(r));

fs.rmSync(TMP, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`モデルの導入と評価の物差しの検査の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`モデルの導入と評価の物差しの検査の試験: ${checks} 件が期待と一致しました`);
