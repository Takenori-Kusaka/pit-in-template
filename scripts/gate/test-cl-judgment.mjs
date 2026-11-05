// 安全重要度の判定の記録と確認(cl-judgment.mjs)の試験(process-compass #373 / ADR-0113。IMPL-0449・IMPL-0450・IMPL-0451)。
//
//   node scripts/gate/test-cl-judgment.mjs
//
// 固定する決定:
//   - 判定の記録(D-0 節16)の欄の空欄、判定者の記名の不備(D-0 表1「体制と運用形態」の決定者でない・AI の名義)、
//     記録の区分と構成の回答(仮の判定)の食い違いを、記録の不備として返す。D-0 の検査は G-1 の前なら失敗し、
//     G-1 を通過済みの旧い構成では注意にとどめる(IMPL-0449)
//   - 確認者の記名(判定者と別の名簿の人・AI の名義でない)と、求める段(下限と引き上げ)と記録した段の比較。
//     2名の体制の内の確認者は段1 として数える。届かない確認は未達。CL0 で規制業でない案件は欠落に数えず、
//     CL1 以上・規制業と、附属書F F.2 の Q1 が「はい」で段3 が欠ける案件は、出荷の証跡の集約が欠落に数える(IMPL-0450)
//   - 区分を下げる変化点を、記録の「区分の引き下げの根拠」と、根拠が引く ADR・機能仕様が実在する場合に限って受け付ける(IMPL-0451)
// 日付の fixture は過去の日付(TZ=UTC でも未来にならない)。人名は架空。一時の置き場で試し、GitHub へ問い合わせません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sealChangeLog } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';
import { clJudgmentState, clJudgmentText, reductionProblems, requiredStep, sraApprovalProblems, CL_RECORD_REQUIRED_SINCE } from './cl-judgment.mjs';

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
}
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

// 架空の人名。p4 が事業決裁者(D-0 表1「体制と運用形態」の決定者)、x は名簿の外部の確認者
const PEOPLE = [
  { id: 'p0', name: '青木 一郎', accounts: ['aoki'] },
  { id: 'p1', name: '井上 二郎', accounts: ['inoue'] },
  { id: 'p2', name: '上田 三郎', accounts: ['ueda'] },
  { id: 'p3', name: '江藤 四郎', accounts: ['eto'] },
  { id: 'p4', name: '大野 五郎', accounts: ['ono'] },
  { id: 'x', name: '加藤 六郎', external: true, accounts: ['kato'] },
];
const seatsOf = (map) => Object.entries(map).map(([role, accountable]) => ({ role, accountable }));
const SEATS = seatsOf({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' });
const ANSWERS = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9', 'q-biz-phase': 'mvp', 'q-external-reviewer': 'reviewer-yes',
};
const configOf = (answers = {}, { people = PEOPLE, seats = SEATS } = {}) =>
  quiet(() => buildConfig({ ...ANSWERS, ...answers }, { generatedAt: '2026-10-01T09:00:00+09:00', d0Version: null, people, seats }).config);

const FILLED = {
  判定した区分: 'CL0',
  対策を入れる前の最悪の帰結: '社内の集計ツール: 集計の誤りで業務が半日止まる',
  '1つ上の区分に当たらない理由': '個人の権利・利益に影響する判定を扱わない(人事評価・与信に使わない)',
  '附属書F F.2 の回答': 'いいえ。人身への危害が生じうる制御を持たない',
  判定者: '大野 五郎',
  判定日: '2026-10-01',
  確認者: '江藤 四郎',
  確認者の段: '段1',
  段の根拠: '判定者と別の自然人',
  確認日: '2026-10-02',
  区分の引き下げの根拠: '該当なし',
};
const d0 = (rows = {}, { drop = [] } = {}) => {
  const v = { ...FILLED, ...rows };
  const lines = Object.entries(v)
    .filter(([k]) => !drop.includes(k))
    .map(([k, val]) => `| ${k} | ${val} |`);
  return `# D-0\n\n## 15. 組織継続の状態の受容\n\n本文\n\n## 16. 安全重要度の判定の記録\n\n| 項目 | 記載 |\n| --- | --- |\n${lines.join('\n')}\n\n- 注記\n`;
};
// 判定の記録を求める前に G-1 を通過した旧い構成と、境界の後に通過した構成。境界は試験で差し替える(since。突合 X-15)。
// 境界の後の fixture も過去の日付にする(2026-09-15 の境界に対して 2026-09-20)。addedAt は判定記録を入れたコミットの時刻
const SINCE = '2026-09-15';
const G1_PASSED = [{ gate: 'G-1 企画承認', result: '通過', judgedAt: '2026-09-01 10:00', addedAt: '2026-09-01T10:00:00+09:00' }];
const G1_PASSED_AFTER = [{ gate: 'G-1 企画承認', result: '通過', judgedAt: '2026-09-20 10:00', addedAt: '2026-09-20T10:00:00+09:00' }];
// 自己申告の判定日時は境界の前でも、判定記録を入れたコミットが境界の後(突合 X-3)
const G1_BACKDATED = [{ gate: 'G-1 企画承認', result: '通過', judgedAt: '2026-09-01 10:00', addedAt: '2026-09-20T10:00:00+09:00' }];
const G1_NOCOMMIT = [{ gate: 'G-1 企画承認', result: '通過', judgedAt: '2026-09-01 10:00', addedAt: null }];
const G1_PASSED_NODATE = [{ gate: 'G-1 企画承認', result: '通過', judgedAt: '', addedAt: '2026-09-01T10:00:00+09:00' }];

// --- IMPL-0449: 判定の記録と判定者の記名 ---
{
  const config = configOf();
  // IMPL-0449:ng(違反と適合の対。標準の実装マーク。process-compass #373)
  let st = clJudgmentState(config, { text: '# D-0\n\n## 15. 組織継続の状態の受容\n' });
  check('記録: 節16 が無い D-0 は記録の不備(G-1 を止める)', !st.present && st.recordProblems.some((p) => /「安全重要度の判定の記録」の節がありません/.test(p)), JSON.stringify(st.recordProblems));
  st = clJudgmentState(config, { text: d0({ 対策を入れる前の最悪の帰結: '<構成要素ごとに、想定できる最悪の故障の帰結>', '1つ上の区分に当たらない理由': '' }) });
  check(
    '記録: 様式の説明のまま・空欄の欄を記録の不備にする',
    st.recordProblems.some((p) => /「対策を入れる前の最悪の帰結」が未記入/.test(p)) && st.recordProblems.some((p) => /「1つ上の区分に当たらない理由」が未記入/.test(p)),
    JSON.stringify(st.recordProblems)
  );
  st = clJudgmentState(config, { text: d0({ 判定者: '' }) });
  check('記録: 判定者の記名が無ければ記録の不備にする', st.recordProblems.some((p) => /「判定者」が未記入/.test(p)), JSON.stringify(st.recordProblems));
  st = clJudgmentState(config, { text: d0({ 判定者: '青木 一郎' }) });
  check(
    '記録: 構成の履歴を読む場所が無く、判定者が現在の決定者でなければ、照らしていないことを注意に出す',
    st.recordProblems.length === 0 && st.notes.some((n) => /照らしていません/.test(n) && /構成の履歴を読む場所が無い/.test(n)),
    JSON.stringify({ p: st.recordProblems, n: st.notes })
  );
  st = clJudgmentState(config, { text: d0({ 判定者: '佐藤 七郎' }) });
  check('記録: 判定者が人の名簿に無ければ記録の不備にする', st.recordProblems.some((p) => /人の名簿\(people\[\]\)にない/.test(p)), JSON.stringify(st.recordProblems));
  st = clJudgmentState(config, { text: d0({ 判定者: 'Claude' }) });
  check('記録: 判定者に AI の名義を受け付けない', st.recordProblems.some((p) => /AI の名義を受け付けない/.test(p)), JSON.stringify(st.recordProblems));
  st = clJudgmentState(config, { text: d0({ 判定した区分: 'CL1' }) });
  check('記録: 記録の区分と構成の回答(仮の判定)の食い違いを記録の不備にする', st.recordProblems.some((p) => /食い違います/.test(p)), JSON.stringify(st.recordProblems));
  st = clJudgmentState(configOf({ 'q-criticality': 'cl1' }), { text: d0({ 確認者: '未達' }) });
  check(
    '記録: 構成の回答が記録の区分より高い(区分を上げた後に記録を改めていない)向きは注意にとどめ、出荷は高いほうの区分で扱う',
    st.recordProblems.length === 0 && st.notes.some((n) => /食い違います/.test(n)) && st.shipBlocking,
    JSON.stringify({ p: st.recordProblems, n: st.notes, b: st.shipBlocking })
  );
  st = clJudgmentState(config, { text: d0({ '附属書F F.2 の回答': '人身への危害は無い' }) });
  check('記録: F.2 の回答は Q1 の答え(はい / いいえ)で始める', st.recordProblems.some((p) => /はい \/ いいえ/.test(p)), JSON.stringify(st.recordProblems));
  st = clJudgmentState(config, { text: d0({ 判定者: '' }), gateRecords: G1_PASSED, since: SINCE });
  check('記録: 判定の記録を求める前に G-1 を通過した CL0・F.2 の Q1「いいえ」の旧い構成は legacy(遡って止めず、欠落に数えない)', st.legacy === true && st.g1Passed === true && !st.shipBlocking, JSON.stringify(st));
  check('記録: 境界は ADR-0113 の採用日(既定)', clJudgmentState(config, { text: d0({ 判定者: '' }), gateRecords: G1_PASSED }).legacy === true && CL_RECORD_REQUIRED_SINCE === '2026-11-05');
  // 議長の裁定 J-10: 旧い構成のほかは、判定の記録と判定者の記名の不備を、出荷の証跡の集約で欠落に数える
  st = clJudgmentState(config, { text: d0({ 判定者: '' }), gateRecords: G1_PASSED_AFTER, since: SINCE });
  check('記録: 判定の記録を求めた日以後に G-1 を通過した構成は旧い構成に数えず、記録の不備を欠落に数える', st.legacy === false && st.g1Passed === true && st.shipBlocking && /判定者本人が書ける欠落/.test(st.shipBlockingReason), JSON.stringify({ l: st.legacy, b: st.shipBlocking, r: st.shipBlockingReason }));
  st = clJudgmentState(config, { text: d0({ 判定者: '' }), gateRecords: G1_PASSED_NODATE, since: SINCE });
  check('記録: G-1 の判定日時を読めない構成は旧い構成に数えない', st.legacy === false && st.shipBlocking, JSON.stringify({ l: st.legacy, b: st.shipBlocking }));
  // 議長の裁定 X-3: 旧い構成の境界を、自己申告の判定日時だけで決めない。判定記録を入れたコミットの時刻も境界の前であること
  st = clJudgmentState(config, { text: d0({ 判定者: '' }), gateRecords: G1_BACKDATED, since: SINCE });
  check('記録: 判定日時を境界の前へ遡らせても、判定記録を入れたコミットが境界の後なら旧い構成に数えない', st.legacy === false && st.shipBlocking, JSON.stringify({ l: st.legacy, b: st.shipBlocking }));
  st = clJudgmentState(config, { text: d0({ 判定者: '' }), gateRecords: G1_NOCOMMIT, since: SINCE });
  check('記録: 判定記録を入れたコミットの時刻を導けない構成は旧い構成に数えない', st.legacy === false && st.shipBlocking, JSON.stringify({ l: st.legacy, b: st.shipBlocking }));
  // 議長の裁定 X-1: 旧い構成でも、CL1 以上・規制業・F.2 の Q1「はい」の案件は、判定の記録の欠落を欠落に数える(記録を消して止めを外す経路を塞ぐ)
  const cl1 = configOf({ 'q-criticality': 'cl1' });
  st = clJudgmentState(cl1, { text: d0({ 判定した区分: 'CL1', 確認者: '未達', 判定者: '' }), gateRecords: G1_PASSED, since: SINCE });
  check('記録: 旧い構成の CL1 で判定者の欄を空にしても、出荷の止めは外れない', st.legacy === false && st.legacyConfig === true && st.shipBlocking, JSON.stringify({ l: st.legacy, b: st.shipBlocking }));
  st = clJudgmentState(cl1, { text: '# D-0\n', gateRecords: G1_PASSED, since: SINCE });
  check('記録: 旧い構成の CL1 で節16 が無くても、欠落に数える', st.legacy === false && st.shipBlocking, JSON.stringify({ l: st.legacy, b: st.shipBlocking }));
  st = clJudgmentState(config, { text: d0({ '附属書F F.2 の回答': 'はい。停止を制御する', 確認者の段: '段2', 判定者: '' }), gateRecords: G1_PASSED, since: SINCE });
  check('記録: 旧い構成の CL0 でも F.2 の Q1 が「はい」なら、記録の不備を欠落に数える', st.legacy === false && st.shipBlocking, JSON.stringify({ l: st.legacy, b: st.shipBlocking }));
  st = clJudgmentState(configOf({ 'q-quality': 'quality-regulated' }), { text: '# D-0\n', gateRecords: G1_PASSED, since: SINCE });
  check('記録: 旧い構成の規制業で節16 が無ければ、欠落に数える', st.legacy === false && st.shipBlocking, JSON.stringify({ l: st.legacy, b: st.shipBlocking }));
  st = clJudgmentState(config, { text: '# D-0\n', gateRecords: G1_PASSED, since: SINCE });
  check('記録: 旧い構成の CL0 でも、節16 が無く F.2 の回答を読めなければ、緩い扱いに当たらない(欠落に数える)', st.legacy === false && st.shipBlocking, JSON.stringify({ l: st.legacy, b: st.shipBlocking }));
  // 突合 X-2(b): 判定日の書き方
  st = clJudgmentState(config, { text: d0({ 判定日: '2026/10/01' }) });
  check('記録: 判定日が YYYY-MM-DD でなければ記録の不備にする', st.recordProblems.some((p) => /「判定日」\(2026\/10\/01\)を YYYY-MM-DD/.test(p)), JSON.stringify(st.recordProblems));
  st = clJudgmentState(config, { text: d0({ 判定者: '' }) });
  check('記録: G-1 の前の構成の記録の不備も、出荷の証跡の集約では欠落に数える', st.shipBlocking, JSON.stringify({ b: st.shipBlocking }));
  // IMPL-0449:ok(違反と適合の対。標準の実装マーク。process-compass #373)
  st = clJudgmentState(config, { text: d0() });
  check('記録: 欄がそろい、判定者が決定者で、区分が回答と一致すれば記録の不備なし', st.recordProblems.length === 0 && st.cls === 'cl0' && st.f2q1 === false, JSON.stringify(st.recordProblems));
  check('記録: CL3 の「外れる区分が無い」の記載を記入として受け付ける', clJudgmentState(configOf({ 'q-criticality': 'cl3' }), { text: d0({ 判定した区分: 'CL3', '1つ上の区分に当たらない理由': '外れる区分が無い(CL3)', '附属書F F.2 の回答': 'はい。車載の制御を持つ。安全関連部は制動の制御', 確認者: '加藤 六郎', 確認者の段: '段3', 段の根拠: '別の法人の評価部門' }) }).recordProblems.length === 0);
}

// --- IMPL-0450: 確認者の記名と段 ---
{
  check('段: 下限は判定で外れる区分の段(CL0 段1・CL1 段2・CL2 段3・CL3 段1)', ['cl0', 'cl1', 'cl2', 'cl3'].map((c) => requiredStep(c).step).join(',') === '1,2,3,1');
  check('段: F.2 の Q1 が「はい」なら判定に依らず段3', requiredStep('cl0', { f2q1: true }).step === 3 && requiredStep('cl3', { f2q1: true }).step === 3);
  check('段: 規制業の候補は少なくとも段2', requiredStep('cl0', { regulated: true }).step === 2 && requiredStep('cl2', { regulated: true }).step === 3);
  const config = configOf();
  // IMPL-0450:ng(違反と適合の対。標準の実装マーク。process-compass #373)
  let st = clJudgmentState(config, { text: d0({ 確認者: '未達', 確認者の段: '', 段の根拠: '', 確認日: '' }) });
  check('確認: 確認者が「未達」なら未達。CL0 で規制業でなければ欠落に数えない(G-8 の受容で出荷できる)', !st.confirmation.ok && st.recordProblems.length === 0 && !st.shipBlocking, JSON.stringify(st.confirmation));
  st = clJudgmentState(config, { text: d0({ 確認者: '大野 五郎' }) });
  check('確認: 判定者と同じ人の確認者は記録の不備にし、確認に数えない', st.recordProblems.some((p) => /判定者と同じ人/.test(p)) && !st.confirmation.ok, JSON.stringify(st));
  st = clJudgmentState(config, { text: d0({ 確認者: 'Claude' }) });
  check('確認: 確認者に AI の名義を受け付けない', st.recordProblems.some((p) => /確認者は自然人に限ります/.test(p)) && !st.confirmation.ok, JSON.stringify(st.recordProblems));
  st = clJudgmentState(config, { text: d0({ 確認者: '佐藤 七郎' }) });
  check('確認: 名簿に無い確認者は確認に数えない(未達)', !st.confirmation.ok && st.confirmation.unmet.some((u) => /人の名簿に無い/.test(u)), JSON.stringify(st.confirmation));
  const cl1 = configOf({ 'q-criticality': 'cl1' });
  st = clJudgmentState(cl1, { text: d0({ 判定した区分: 'CL1' }) });
  check('確認: CL1 の判定を段1 で確かめても段2 に届かず未達。CL1 は欠落に数える(未達のまま出荷しない)', !st.confirmation.ok && st.confirmation.required === 2 && st.shipBlocking, JSON.stringify(st.confirmation));
  st = clJudgmentState(config, { text: d0({ '附属書F F.2 の回答': 'はい。搬送機の停止の制御を持つ。安全関連部は停止の監視', 確認者の段: '段2' }) });
  check(
    '確認: F.2 の Q1 が「はい」で段3 の確認が欠ければ、CL0 でも欠落に数える(G-8 で受容しても出荷しない)',
    !st.confirmation.ok && st.confirmation.required === 3 && st.shipBlocking && /G-8 の受容で代えない/.test(st.shipBlockingReason),
    JSON.stringify(st)
  );
  const small = configOf({ 'q-team-size': 'size-1-2' }, { people: [PEOPLE[4], PEOPLE[3], PEOPLE[5]], seats: seatsOf({ 'biz-approver': 'p4', 'dev-verifier': 'p4', 'independent-reviewer': 'p3' }) });
  st = clJudgmentState(small, { text: d0({ 確認者の段: '段2' }) });
  check('確認: 2名の体制の内の相手は段1 として数える', st.confirmation.effective === 1 && st.confirmation.recorded === 2 && st.confirmation.ok, JSON.stringify(st.confirmation));
  st = clJudgmentState(small, { text: d0({ '附属書F F.2 の回答': 'はい。設備の非常停止を制御する', 確認者の段: '段3', 段の根拠: '別の指揮系統' }) });
  check('確認: 2名の体制の内の相手は、段3 を求める確認に数えない(未達。欠落に数える)', !st.confirmation.ok && st.shipBlocking, JSON.stringify(st.confirmation));
  // IMPL-0450:ok(違反と適合の対。標準の実装マーク。process-compass #373)
  st = clJudgmentState(config, { text: d0() });
  check('確認: 判定者と別の名簿の人が求める段で確かめれば確認あり', st.confirmation.ok && !st.shipBlocking && /段2 以上の距離は機械では確かめていない/.test(clJudgmentText(st)), clJudgmentText(st));
  st = clJudgmentState(small, { text: d0({ 確認者: '加藤 六郎', '附属書F F.2 の回答': 'はい。設備の非常停止を制御する', 確認者の段: '段3', 段の根拠: '別の法人の評価部門' }) });
  check('確認: 1〜2名の体制でも、名簿の外部の確認者は記録した段で数える', st.confirmation.ok && st.confirmation.effective === 3, JSON.stringify(st.confirmation));
  check('表示: 組織の外へ渡す文は氏名を出さない', !/大野|江藤/.test(clJudgmentText(clJudgmentState(config, { text: d0() }), { external: true })));
  // 突合 X-13: 確認日が判定日より前・読めない書き方の確認は、確認に数えない
  st = clJudgmentState(config, { text: d0({ 判定日: '2026-10-05', 確認日: '2026-01-01' }) });
  check('確認: 確認日が判定日より前なら未達', !st.confirmation.ok && st.confirmation.unmet.some((u) => /判定日\(2026-10-05\)より前/.test(u)), JSON.stringify(st.confirmation));
  st = clJudgmentState(config, { text: d0({ 確認日: '10月2日' }) });
  check('確認: 確認日を YYYY-MM-DD で読めなければ未達', !st.confirmation.ok && st.confirmation.unmet.some((u) => /YYYY-MM-DD の形で読めない/.test(u)), JSON.stringify(st.confirmation));
}

// --- IMPL-0453: テンプレ9 の承認の欄(突合 X-8) ---
{
  const config = configOf();
  const sra = (row) => `# AI エージェント安全リスクアセスメント\n\n## 5. 残留リスクの受容\n| Hz | 残留 SR | 受容の理由 | 決裁者 | 日付 |\n| --- | --- | --- | --- | --- |\n\n## 承認\n| 作成者 | 承認者(作成者と別の自然人) | 承認日 | 承認した版 |\n| --- | --- | --- | --- |\n${row}\n`;
  // IMPL-0453:ng(違反と適合の対。標準の実装マーク。process-compass #373 突合 X-8)
  let p = sraApprovalProblems(config, sra('| | | | |'));
  check('テンプレ9: 承認の欄が空なら問題にする', p.some((x) => /「承認」の欄が未記入/.test(x)), JSON.stringify(p));
  p = sraApprovalProblems(config, sra('| 青木 一郎 | 青木 一郎 | 2026-10-01 | 1.0 |'));
  check('テンプレ9: 承認者が作成者と同じ人なら問題にする', p.some((x) => /作成者と同じ人/.test(x)), JSON.stringify(p));
  p = sraApprovalProblems(config, sra('| 青木 一郎 | Claude | 2026-10-01 | 1.0 |'));
  check('テンプレ9: 承認者に AI の名義を受け付けない', p.some((x) => /AI の名義を受け付けない/.test(x)), JSON.stringify(p));
  p = sraApprovalProblems(config, sra('| 青木 一郎 | 大野 五郎 | 10月1日 | |'));
  check('テンプレ9: 承認日の書き方と承認した版の空欄を問題にする', p.some((x) => /承認日/.test(x)) && p.some((x) => /承認した版が未記入/.test(x)), JSON.stringify(p));
  check('テンプレ9: 承認の欄が無ければ問題にする', sraApprovalProblems(config, '# 表\n').some((x) => /「承認」の欄がありません/.test(x)));
  // IMPL-0453:ok(違反と適合の対。標準の実装マーク。process-compass #373 突合 X-8)
  p = sraApprovalProblems(config, sra('| 青木 一郎 | 大野 五郎 | 2026-10-01 | 1.0 |'));
  check('テンプレ9: 作成者と別の名簿の人が承認日と版を書けば問題なし', p.length === 0, JSON.stringify(p));
  const tpl = fs.readFileSync(path.join(ROOT, 'templates/09-safety-risk-assessment.md'), 'utf8');
  check('テンプレ9: 様式のままの表は承認の欄を未記入として読む', sraApprovalProblems(config, tpl).some((x) => /「承認」の欄が未記入/.test(x)), JSON.stringify(sraApprovalProblems(config, tpl)));
}

// --- 一時の置き場: D-0 の検査・区分を下げる変化点・出荷の証跡の集約 ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-cl-judgment-'));
try {
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  const cfgPath = path.join(dir, 'process.config.json');
  const d0Path = path.join(dir, 'docs/D-0-governance.md');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const writeD0 = (rows, opts) => {
    const base = fs.readFileSync(path.join(dir, 'templates/00-d0-governance.md'), 'utf8');
    const cut = base.split(/^## 16\. 安全重要度の判定の記録/m)[0];
    fs.writeFileSync(d0Path, cut + d0(rows, opts).split('## 16.').slice(1).map((s) => `## 16.${s}`).join(''));
  };
  const run = (script, args = []) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  // D-0 の検査: G-1 の前は、判定の記録の不備で失敗し、仮の判定である旨を出す。G-1 を通過済みなら注意にとどめる
  fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(configOf()), null, 2) + '\n');
  writeD0({ 判定者: '' });
  let r = run('scripts/gate/check-d0.mjs');
  check('IMPL-0449:ng D-0 の検査は、G-1 の前に判定者の記名が無ければ失敗し、仮の判定の旨を出す', r.status !== 0 && /「判定者」が未記入/.test(r.out) && /仮の判定/.test(r.out), r.out);
  r = run('scripts/gate/check-d0.mjs', ['--no-cl']);
  check('D-0 の検査: --no-cl では判定の記録を見ない(next.mjs が分けて出す)', !/「判定者」が未記入/.test(r.out), r.out);
  r = run('scripts/gate/next.mjs', ['--json']);
  check('next.mjs: 判定の記録と記名が無いことを人の判断待ちとして出す', /安全重要度の判定の記録と記名が無い\(仮の判定\)/.test(r.out), r.out.slice(0, 2000));
  // 旧い構成の境界は、G-1 の判定日時と、その判定記録を入れたコミットの時刻の両方で決める(議長の裁定 X-3)
  const commitAt = (when, msg) => {
    git('add', '-A');
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', msg], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, stdio: 'ignore' });
  };
  const G1_FORM = '# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | G-1 企画承認 |\n| 対象 | P-001 |\n| 判定者 | 大野 五郎 |\n| 判定日時 | 2026-09-01 10:00 |\n| 結果 | 通過 |\n';
  fs.mkdirSync(path.join(dir, 'docs/gates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/gates/g1-P-001-2026-09-01.md'), G1_FORM);
  r = run('scripts/gate/check-d0.mjs');
  check('D-0 の検査: G-1 の判定記録をまだコミットしていない構成は旧い構成に数えず、判定者の記名が無ければ失敗する', r.status !== 0 && /::error::.*「判定者」が未記入/.test(r.out), r.out);
  commitAt('2026-09-01T10:00:00+09:00', 'docs: G-1 の判定記録');
  r = run('scripts/gate/check-d0.mjs');
  const g1Passed = /「判定者」が未記入です[^\n]*判定の記録を求める前に G-1 を通過した旧い構成のため、遡って失敗させません/.test(r.out);
  check('IMPL-0449:ok 判定の記録を求める前に G-1 を通過した CL0・F.2 の Q1「いいえ」の旧い構成は、判定の記録の不備で D-0 の検査を失敗させず注意にする', g1Passed && !/::error::.*「判定者」が未記入/.test(r.out), r.out);
  // 判定日時を境界の前へ遡らせた判定記録を、境界の後(今)のコミットで入れた構成は、旧い構成に数えない(突合 X-3)
  git('rm', '-q', 'docs/gates/g1-P-001-2026-09-01.md');
  git('commit', '-q', '-m', 'docs: G-1 の記録を外す');
  fs.writeFileSync(path.join(dir, 'docs/gates/g1-P-001-2026-09-02.md'), G1_FORM);
  git('add', '-A');
  git('commit', '-q', '-m', 'docs: 判定日時を遡らせた G-1 の判定記録');
  r = run('scripts/gate/check-d0.mjs');
  check('D-0 の検査: 判定日時を遡らせても、判定記録を入れたコミットが境界の後なら旧い構成に数えず失敗する', r.status !== 0 && /::error::.*「判定者」が未記入/.test(r.out), r.out);
  git('rm', '-q', '-r', 'docs/gates');
  git('commit', '-q', '-m', 'docs: G-1 の記録を外す');
  writeD0({});
  r = run('scripts/gate/check-d0.mjs');
  check('D-0 の検査: 判定の記録がそろえば、判定の記録の不備を出さない', !/安全重要度の判定/.test(r.out.split('\n').filter((l) => /::error::/.test(l)).join('\n')), r.out);

  // 区分を下げる変化点(CL1 → CL0)。引き下げの根拠と、根拠が引く ADR・機能仕様が無ければ拒否する
  const cl1 = configOf({ 'q-criticality': 'cl1' });
  fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(cl1), null, 2) + '\n');
  writeD0({ 判定した区分: 'CL1', 区分の引き下げの根拠: '該当なし' });
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: init');
  const lower = () => {
    fs.writeFileSync(path.join(dir, 'change.json'), JSON.stringify({ kind: 'axis', summary: '設計で帰結を下げ、区分を CL0 へ', answers: { 'q-criticality': 'cl0' }, decidedBy: '大野 五郎', reason: '物理削除を取り消せる方式へ変えた' }));
    return run('scripts/init/generate-profile.mjs', ['--change', 'change.json']);
  };
  const before = fs.readFileSync(cfgPath, 'utf8');
  r = lower();
  // IMPL-0451:ng(違反と適合の対。標準の実装マーク。process-compass #373)
  check('IMPL-0451:ng 引き下げの根拠が無い区分を下げる変化点を拒否し、構成を書き換えない', r.status !== 0 && /引き下げの根拠/.test(r.out) && fs.readFileSync(cfgPath, 'utf8') === before, r.out);
  writeD0({ 判定した区分: 'CL0', 区分の引き下げの根拠: '低減の前 CL1 → 後 CL0。送金の確定を保留の後に人が確定する設計。ADR-0007、F-012' });
  check(
    '引き下げの根拠: 引く ADR・機能仕様が無ければ問題にする',
    (() => {
      const p = reductionProblems(cl1, { to: 'cl0', root: dir });
      return p.some((x) => /ADR-0007 が context\/decisions\/ に無い/.test(x)) && p.some((x) => /F-012 の機能仕様/.test(x));
    })()
  );
  fs.writeFileSync(path.join(dir, 'context/decisions/0007-reversible-transfer.md'), '# ADR-0007: 送金の確定を保留にする\n');
  fs.mkdirSync(path.join(dir, 'specs/F-012'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs/F-012/spec.md'), '# 機能仕様: 送金\n');
  // IMPL-0451:ok(違反と適合の対。標準の実装マーク。process-compass #373)
  check('IMPL-0451:ok 根拠の記入と、引く ADR・機能仕様がそろえば問題なし', reductionProblems(cl1, { to: 'cl0', root: dir }).length === 0, JSON.stringify(reductionProblems(cl1, { to: 'cl0', root: dir })));
  r = lower();
  check('区分を下げる変化点: 根拠がそろえば受け付ける', r.status === 0 && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).answers['q-criticality'] === 'cl0', r.out);
  // 議長の裁定 X-10: 仮の判定(初期化の回答 CL1)から最初の判定の記録(CL0)へ揃える変化点には、引き下げの根拠を求めない
  {
    fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(cl1), null, 2) + '\n');
    const base = fs.readFileSync(path.join(dir, 'templates/00-d0-governance.md'), 'utf8');
    fs.writeFileSync(d0Path, base); // 節16 は様式のまま(判定の記録はまだ成立していない)
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: 仮の判定 CL1');
    writeD0({ 判定した区分: 'CL0', 区分の引き下げの根拠: '該当なし' });
    check('引き下げの根拠: 最初の判定の記録へ揃えるときは求めない', reductionProblems(cl1, { to: 'cl0', from: 'cl1', root: dir }).length === 0, JSON.stringify(reductionProblems(cl1, { to: 'cl0', from: 'cl1', root: dir })));
    r = lower();
    check('区分を下げる変化点: 仮の判定を最初の判定の記録の区分へ揃える変化点は、引き下げの根拠なしで受け付ける', r.status === 0 && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).answers['q-criticality'] === 'cl0', r.out);
    writeD0({ 判定した区分: 'CL1', 区分の引き下げの根拠: '該当なし' });
    check('引き下げの根拠: 最初の記録でも、記録の区分が下げた後の区分でなければ問題にする', reductionProblems(cl1, { to: 'cl0', from: 'cl1', root: dir }).some((x) => /下げた後の区分/.test(x)));
  }

  // 議長の裁定 J-12・X-2・X-5・X-9: 判定者の記名は、記録が作られた時点の決定者と照らす。時点は自己申告の判定日ではなく、
  // 節16 の判定者・判定日の行を入れたコミットで決め、そのコミットの構成の決定者と照らす(同じ日の交代はコミットの順)
  {
    const hist = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-cl-history-'));
    const roots = [hist];
    try {
      const mk = (dirPath) => {
        const g = (...a) => execFileSync('git', a, { cwd: dirPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        g('init', '-q', '-b', 'main');
        g('config', 'user.email', 't@example.com');
        g('config', 'user.name', 'tester');
        g('config', 'core.autocrlf', 'false');
        const at = (when, msg, files) => {
          for (const [rel, body] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dirPath, rel)), { recursive: true });
            fs.writeFileSync(path.join(dirPath, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
          }
          g('add', '-A');
          execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dirPath, env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, stdio: 'ignore' });
        };
        return { g, at };
      };
      const ONO = configOf(); // 事業決裁者は大野
      const AOKI = configOf({}, { seats: seatsOf({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p0' }) });
      const EMPTY = configOf({}, { seats: seatsOf({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3' }) });
      const D0 = 'docs/D-0-governance.md';
      const judge = (cfg, root) => clJudgmentState(cfg, { text: fs.readFileSync(path.join(root, D0), 'utf8'), root });
      const fresh = () => {
        const p = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-cl-history-'));
        roots.push(p);
        return { p, ...mk(p) };
      };
      // (1) 交代の前に、その時点の決定者(大野)が記名して入れた記録は、交代の後も効力を保つ
      {
        const { at } = mk(hist);
        at('2026-09-15T10:00:00+09:00', 'chore: 大野が決定者', { 'process.config.json': ONO });
        at('2026-10-01T10:00:00+09:00', 'docs: 判定の記録', { [D0]: d0({ 判定者: '大野 五郎', 判定日: '2026-10-01' }) });
        at('2026-10-15T10:00:00+09:00', 'chore: 決定者を青木へ', { 'process.config.json': AOKI });
        // IMPL-0449:ok(違反と適合の対。記録の時点の決定者の記名。process-compass #373)
        const st = judge(AOKI, hist);
        check('判定者: 決定者の交代の前に、その時点の決定者が記名して入れた記録は効力を保つ', st.recordProblems.length === 0 && !st.notes.some((n) => /判定者/.test(n)) && st.point?.kind === 'commit', JSON.stringify({ p: st.recordProblems, n: st.notes, k: st.point?.kind }));
      }
      // (2) 前の決定者が、交代の後に入れた記録の判定日を在任中へ遡らせても、記録を入れたコミットの時点で照らして拒否する(X-2 c)
      {
        const { p, at: at2 } = fresh();
        at2('2026-09-15T10:00:00+09:00', 'chore: 大野が決定者', { 'process.config.json': ONO });
        at2('2026-10-15T10:00:00+09:00', 'chore: 決定者を青木へ', { 'process.config.json': AOKI });
        at2('2026-10-20T10:00:00+09:00', 'docs: 判定の記録', { [D0]: d0({ 判定者: '大野 五郎', 判定日: '2026-10-01', 確認者: '江藤 四郎' }) });
        // IMPL-0449:ng(違反と適合の対。記録の時点で決定者でなかった人の記名。process-compass #373)
        const st = judge(AOKI, p);
        check('判定者: 判定日を在任中へ遡らせても、記録を入れたコミットの時点の決定者(青木)でなければ拒否する', st.recordProblems.some((x) => /記録を入れたコミット [0-9a-f]{8}.*の D-0 表1「体制と運用形態」の決定者\(青木 一郎\)ではありません/.test(x)), JSON.stringify(st.recordProblems));
        // 一度も決定者でない江藤の記名と、構成の最初のコミットより前の判定日(X-2 a)
        at2('2026-10-21T10:00:00+09:00', 'docs: 判定の記録', { [D0]: d0({ 判定者: '江藤 四郎', 判定日: '2026-01-01', 確認者: '大野 五郎' }) });
        const st2 = judge(AOKI, p);
        check('判定者: 一度も決定者でない人の記名は、判定日を構成の最初のコミットより前にしても拒否する', st2.recordProblems.some((x) => /決定者\(青木 一郎\)ではありません/.test(x)) && !st2.notes.some((n) => /照らしていません/.test(n)), JSON.stringify({ p: st2.recordProblems, n: st2.notes }));
        // 判定日が記録を入れたコミットの日付より後
        at2('2026-10-22T10:00:00+09:00', 'docs: 判定の記録', { [D0]: d0({ 判定者: '青木 一郎', 判定日: '2026-10-30', 確認者: '江藤 四郎' }) });
        const st3 = judge(AOKI, p);
        check('判定者: 判定日が記録を入れたコミットの日付より後なら記録の不備にする', st3.recordProblems.some((x) => /「判定日」\(2026-10-30\)が、記録を入れたコミットの日付\(2026-10-22\)より後/.test(x)), JSON.stringify(st3.recordProblems));
        // まだコミットしていない記録は、今つくられている記録として現在の構成で照らす
        fs.writeFileSync(path.join(p, D0), d0({ 判定者: '大野 五郎', 判定日: '2026-10-01', 確認者: '江藤 四郎' }));
        const st4 = judge(AOKI, p);
        check('判定者: まだコミットしていない記録は、現在の構成の決定者と照らす', st4.point?.kind === 'working' && st4.recordProblems.some((x) => /未コミット/.test(x)), JSON.stringify({ k: st4.point?.kind, p: st4.recordProblems }));
      }
      // (3) 同じ日の交代は、コミットの順で決まる(X-5。時刻帯に依らない)
      {
        const { p, at } = fresh();
        at('2026-09-15T10:00:00+09:00', 'chore: 大野が決定者', { 'process.config.json': ONO });
        at('2026-10-15T08:00:00+09:00', 'docs: 判定の記録(交代の前)', { [D0]: d0({ 判定者: '大野 五郎', 判定日: '2026-10-15' }) });
        at('2026-10-15T15:00:00+09:00', 'chore: 決定者を青木へ', { 'process.config.json': AOKI });
        const st = judge(AOKI, p);
        check('判定者: 同じ日の交代の前に入れた前の決定者の記録は、コミットの順で効力を保つ', st.recordProblems.length === 0, JSON.stringify(st.recordProblems));
        const q = fresh();
        q.at('2026-09-15T10:00:00+09:00', 'chore: 大野が決定者', { 'process.config.json': ONO });
        q.at('2026-10-15T08:00:00+09:00', 'chore: 決定者を青木へ', { 'process.config.json': AOKI });
        q.at('2026-10-15T15:00:00+09:00', 'docs: 判定の記録(交代の後)', { [D0]: d0({ 判定者: '大野 五郎', 判定日: '2026-10-15' }) });
        const st2 = judge(AOKI, q.p);
        check('判定者: 同じ日の交代の後に入れた前の決定者の記録は、コミットの順で拒否する', st2.recordProblems.some((x) => /決定者\(青木 一郎\)ではありません/.test(x)), JSON.stringify(st2.recordProblems));
      }
      // (4) 記録の時点で決定者の席が空なら、記録の不備にする(X-9)
      {
        const { p, at } = fresh();
        at('2026-09-15T10:00:00+09:00', 'chore: 席が空', { 'process.config.json': EMPTY, [D0]: d0({ 判定者: '井上 二郎', 確認者: '江藤 四郎' }) });
        at('2026-10-15T10:00:00+09:00', 'chore: 決定者を青木へ', { 'process.config.json': AOKI });
        const st = judge(AOKI, p);
        check('判定者: 記録の時点で決定者の席が空なら、判定者を照らす決定者がいないとして記録の不備にする', st.recordProblems.some((x) => /照らす決定者がいません/.test(x)), JSON.stringify(st.recordProblems));
      }
      // (5) 浅い取得(CI の既定の depth 1)は、照合できなかったことを記録の不備にする(X-4)
      {
        const sh = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-cl-shallow-'));
        roots.push(sh);
        fs.rmSync(sh, { recursive: true, force: true });
        execFileSync('git', ['clone', '-q', '--depth', '1', `file://${hist.replace(/\\/g, '/')}`, sh], { stdio: 'ignore' });
        const st = judge(AOKI, sh);
        check('判定者: 浅い取得では照らせず、記録の不備にする(注意に落とさない)', st.point?.kind === 'shallow' && st.recordProblems.some((x) => /浅い取得/.test(x)), JSON.stringify({ k: st.point?.kind, p: st.recordProblems }));
      }
      // (6) リポジトリでない場所では、照らしていないことを注意に出す
      {
        const nr = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-cl-norepo-'));
        roots.push(nr);
        fs.mkdirSync(path.join(nr, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(nr, D0), d0({ 判定者: '大野 五郎' }));
        const st = judge(AOKI, nr);
        check('判定者: 構成の履歴そのものを読めない場合に限り、注意にとどめる', st.point?.kind === 'unknown' && st.recordProblems.length === 0 && st.notes.some((n) => /照らしていません/.test(n)), JSON.stringify({ k: st.point?.kind, p: st.recordProblems, n: st.notes }));
      }
    } finally {
      for (const r0 of roots) fs.rmSync(r0, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  // 出荷の証跡の集約: CL0 の確認の未達は欠落に数えず項目1 に出す。F.2 の Q1 が「はい」で段3 が欠ければ欠落に数える
  fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(configOf()), null, 2) + '\n');
  const aggregate = () => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'chore: fixture');
    const out = run('scripts/gate/aggregate-evidence.mjs');
    const rp = path.join(dir, 'evidence/quality-report.md');
    return { ...out, report: fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : '' };
  };
  const clRow = (report) => report.split('\n').find((l) => l.startsWith('| 安全重要度の判定の確認')) ?? '';
  const clGap = (out) => out.split('\n').some((l) => /::error::安全重要度の判定の確認/.test(l));
  writeD0({ 確認者: '未達', 確認者の段: '', 段の根拠: '', 確認日: '' });
  let a = aggregate();
  check('集約: CL0 の確認の未達は項目1 に未達と出し、欠落に数えない', /\*\*未達\*\*/.test(clRow(a.report)) && !clGap(a.out) && /未達: 安全重要度の判定の確認/.test(a.out), `${clRow(a.report)}\n${a.out.slice(-1500)}`);
  writeD0({ '附属書F F.2 の回答': 'はい。搬送機の停止の制御を持つ。安全関連部は停止の監視' });
  a = aggregate();
  check('集約: F.2 の Q1 が「はい」で段3 の確認が欠ければ、欠落に数える', clGap(a.out) && /G-8 の受容で代えない/.test(a.out), a.out.slice(-1500));
  writeD0({});
  a = aggregate();
  check('集約: 求める段で確かめた判定は、確認ありと出し欠落に数えない', /確認者: 江藤 四郎/.test(clRow(a.report)) && !/\*\*未達\*\*/.test(clRow(a.report)) && !clGap(a.out), clRow(a.report));
  const ext = fs.readFileSync(path.join(dir, 'evidence/assurance-disclosure.external.md'), 'utf8');
  check('集約: 組織の外へ渡す保証の開示は、判定者と確認者の氏名を出さない', /安全重要度の判定の確認/.test(ext) && !/江藤 四郎|大野 五郎/.test(clRow(ext)), clRow(ext));
  writeD0({ 判定者: '' });
  a = aggregate();
  check('集約: 旧い構成でなければ、判定者の記名の欠落を欠落に数える(G-1 の後に記録を空にする経路を塞ぐ)', clGap(a.out) && /判定者本人が書ける欠落/.test(a.out), a.out.slice(-1500));
  fs.rmSync(d0Path);
  a = aggregate();
  check('集約: 旧い構成でなければ、判定の記録が無い構成も欠落に数える', /判定の記録なし/.test(clRow(a.report)) && clGap(a.out), `${clRow(a.report)}\n${a.out.slice(-800)}`);
  fs.mkdirSync(path.join(dir, 'docs/gates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/gates/g1-P-001-2026-09-01.md'), G1_FORM);
  commitAt('2026-09-01T10:00:00+09:00', 'docs: G-1 の判定記録(判定の記録を求める前)');
  a = aggregate();
  check('集約: 旧い構成でも、節16 が無く F.2 の回答を読めなければ欠落に数える(議長の裁定 X-1)', clGap(a.out), `${clRow(a.report)}\n${a.out.slice(-800)}`);
  writeD0({ 判定者: '' });
  a = aggregate();
  check('集約: 判定の記録を求める前に G-1 を通過した CL0・F.2 の Q1「いいえ」の旧い構成は、判定者の記名の欠落を未達と出し、欠落に数えない', /\*\*未達\*\*/.test(clRow(a.report)) && !clGap(a.out), `${clRow(a.report)}\n${a.out.slice(-800)}`);
  fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(configOf({ 'q-criticality': 'cl1' })), null, 2) + '\n');
  writeD0({ 判定した区分: 'CL1', 判定者: '' });
  a = aggregate();
  check('集約: 旧い構成でも CL1 なら、判定者の記名の欠落を欠落に数える(記録を消して出荷の止めを外す経路を塞ぐ)', clGap(a.out), `${clRow(a.report)}\n${a.out.slice(-800)}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log('');
if (failures) {
  console.log(`安全重要度の判定の記録と確認の試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`安全重要度の判定の記録と確認の試験: ${checks} 件が期待と一致しました`);
