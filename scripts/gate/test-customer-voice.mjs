// 顧客の声の検証の体制と裏づけの出所の検査(customer-voice.mjs)の試験(process-compass #411 / ADR-0091。IMPL-0360)。
//
//   node scripts/gate/test-customer-voice.mjs

import { d0VerificationProblems, briefEvidenceProblems } from './customer-voice.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
}
const config = { aiNames: ['Claude'] };
const d0 = (rows) => `## 3. 決定の権限\n\n| 決定の種類 | 決定(1名) | 同意(拒否権あり) | 起案 | 意見 | 実行 |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n本文\n`;
const VERIFY = (decide, exec, consent = '') => `| 市場・顧客仮説の検証の実施 | ${decide} | ${consent} | 営業 | 企画 | ${exec} |`;

// IMPL-0360:ng(違反と適合の対。標準の実装マーク。process-compass #314)
let r = d0VerificationProblems(d0(['| 投資の継続・中止 | 事業決裁者 | | | | |']), config);
check('D-0: 検証の行が無ければ問題にする', r.problems.some((p) => /「市場・顧客仮説の検証の実施」の行がありません/.test(p)), JSON.stringify(r));
r = d0VerificationProblems(d0([VERIFY('', '')]), config);
check('D-0: 検証の行の決定と実行の空欄を問題にする', r.problems.some((p) => /「決定」が未記入/.test(p)) && r.problems.some((p) => /「実行」が未記入/.test(p)), JSON.stringify(r));
r = d0VerificationProblems(d0([VERIFY('価値責任者', 'AI の担い手(調査)、Claude')]), config);
check('D-0: 実行が AI の担い手だけなら問題にする', r.problems.some((p) => /AI の担い手だけです/.test(p)), JSON.stringify(r));
r = d0VerificationProblems(d0([VERIFY('営業部長', '価値責任者', '調査の委託先')]), config);
check('D-0: 決定・同意の列の、席・会議体の名でない記載を照合できない記載として返す(失敗にしない)', !r.problems.length && r.unmatched.some((u) => /決定」の 営業部長/.test(u)) && r.unmatched.some((u) => /同意」の 調査の委託先/.test(u)), JSON.stringify(r));
// IMPL-0360:ok(違反と適合の対。標準の実装マーク。process-compass #314)
r = d0VerificationProblems(d0([VERIFY('価値責任者', '価値責任者、AI の担い手(質問の準備)', 'ステアリングコミッティ(B-2)'), '| 投資の継続・中止 | 投資委員会(B-1) | | | | |']), config);
check('D-0: 決定が席・実行に人がいれば通す', !r.problems.length && !r.unmatched.length, JSON.stringify(r));
r = d0VerificationProblems(d0([VERIFY('価値責任者', 'AI運用担当者')]), config);
check('D-0: AI運用担当者(人の席)を AI の担い手と取り違えない', !r.problems.length, JSON.stringify(r));

const brief = (rows) => `## 目的と価値仮説(観点3)\n\n| 裏づけ | 出所の区分 | 観測の記録への到達先 |\n| --- | --- | --- |\n${rows.join('\n')}\n\n## 次\n`;
// IMPL-0397:ng(違反と適合の対。標準の実装マーク。process-compass #314)
let b = briefEvidenceProblems(brief(['| 利用者 5 名が手作業で集計している | | なし |', '| 市場は伸びている | 推測 | なし |', '| 担当者が困っている | 実在の顧客・利用者の観測 | なし |']));
check('企画書: 出所の区分の未記入・語彙の外・観測の到達先なしを問題にする', b.problems.length === 3 && /未記入/.test(b.problems[0]) && /いずれでもありません/.test(b.problems[1]) && /到達先がありません/.test(b.problems[2]), JSON.stringify(b));
b = briefEvidenceProblems(brief(['| <価値仮説を支える事実> | <実在の顧客・利用者の観測 / 二次資料 / AI の生成物> | <所在> |']));
check('企画書: 様式のままの表は、行が無いものとして問題にする', b.problems.some((p) => /行がありません/.test(p)), JSON.stringify(b));
// IMPL-0397:ok(違反と適合の対。標準の実装マーク。process-compass #314)
b = briefEvidenceProblems(brief(['| 担当者 5 名への聞き取り | 実在の顧客・利用者の観測 | docs/interviews/2026-10.md |', '| 業界の調査報告 | 二次資料 | なし |', '| AI が想定した利用者像 | AI の生成物 | なし |']));
check('企画書: 区分と到達先のそろった表は通す', !b.problems.length && !b.missing, JSON.stringify(b));
check('企画書: 表の無い旧い様式は missing を返す', briefEvidenceProblems('# 企画書\n').missing === true);

console.log('');
if (failures) {
  console.log(`顧客の声の検証の検査の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`顧客の声の検証の検査の試験: ${checks} 件が期待と一致しました`);
