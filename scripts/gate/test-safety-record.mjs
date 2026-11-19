// 安全関連部の検証の記録の検査の試験(IMPL-1007・0925・0927・0934。ADR-0221)。
//   node scripts/gate/test-safety-record.mjs
//
// 違反(ng)と適合(ok)を対で確かめる。検査が確かめるのは記入の形だけで、内容の妥当性・環境が本番でないこと・
// 試験を行ったこと・推奨度が規格の表のとおりかは機械で閉じない(確かめる者: 独立した評価者と G-7 の判定者)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import {
  ROW_ITEMS,
  METHOD_COLUMNS,
  isBlankCell,
  envProblem,
  safetyRecordProblems,
  safetyRecordApplies,
  checkSafetyRecord,
  safetyRecordResultText,
} from './check-safety-record.mjs';

let failed = 0;
let total = 0;
const check = (label, ok, detail = '') => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${label}${ok ? '' : ` — ${detail}`}`);
};

const GOOD_ITEMS = {
  安全関連部の切り分け: '制動の制御部。入出力の境界で切り分けた',
  適用規格と安全度水準: 'ISO 13849-1 / PLr d / 機械の危険源の分析による',
  'AI の利用': 'モデル甲の版 3 / リポジトリの指示ファイル / 段階2 / 担当者乙(段2)',
  独立した評価: '評価者丙 / 段3 / 適合',
};
const GOOD_METHOD = ['静的解析', 'HR', '規格X 版Y 表Z', '適用', ''];
const goodFaults = () => Array.from({ length: 7 }, (_, i) => ['模擬環境(HIL-2)', i === 1 ? '不一致(時間窓なし。早い応答を通す)' : '一致']);

const render = ({ items = GOOD_ITEMS, methods = [GOOD_METHOD], faults = goodFaults(), extra = '' } = {}) => {
  const L = ['# 安全文書', '', '## 安全関連部の検証の記録(適用: 例)', '', '| 項目 | 記入 |', '| --- | --- |'];
  for (const [k, v] of Object.entries(items)) L.push(`| ${k} | ${v} |`);
  L.push(`| 適用した手法 | 下の手法の表 |`, `| 故障挿入の結果 | 下の表 |`, extra);
  L.push('', `| ${METHOD_COLUMNS.join(' | ')} |`, '| --- | --- | --- | --- | --- |');
  for (const m of methods) L.push(`| ${m.join(' | ')} |`);
  L.push('', '| # | 故障挿入の試験項目 | 挿入した環境 | 結果と期待との一致 |', '| --- | --- | --- | --- |');
  faults.forEach((f, i) => L.push(`| ${i + 1} | 項目${i + 1} | ${f[0]} | ${f[1]} |`));
  L.push('', '## 記入時の注意', '');
  return L.join('\n');
};
const problems = (text, opts) => safetyRecordProblems(text, opts).problems;
const withFault = (n, env, result) => {
  const f = goodFaults();
  f[n - 1] = [env ?? f[n - 1][0], result ?? f[n - 1][1]];
  return render({ faults: f });
};

// ---- IMPL-1007: 6項目の置き場と空欄
// IMPL-1007:ng
{
  check('1007 違反: 記録のファイルが無い', problems(null).some((p) => /がありません/.test(p)));
  check('1007 違反: 節が無い', problems('# x\n\n## 別の節\n').some((p) => /節「?安全関連部の検証の記録」?がありません|がありません/.test(p)));
  const noRow = { ...GOOD_ITEMS };
  delete noRow['独立した評価'];
  check('1007 違反: 6項目の行が欠ける(独立した評価)', problems(render({ items: noRow })).some((p) => /「独立した評価」の行がありません/.test(p)));
  for (const v of ['', 'TBD', 'なし', '未定', '後日', '不明', '—', 'N/A', '<記入>']) {
    check(`1007 違反: 空欄に数える値「${v}」`, problems(render({ items: { ...GOOD_ITEMS, 独立した評価: v } })).some((p) => /「独立した評価」が未記入/.test(p)));
  }
  check('1007 違反: 様式の初期の文のまま', problems(render({ items: { ...GOOD_ITEMS, 独立した評価: ROW_ITEMS['独立した評価'] } })).some((p) => /「独立した評価」が未記入/.test(p)));
  check('1007 違反: 欠落の文に項目名と行の番号を書く', problems(withFault(3, '', '')).some((p) => /試験項目3\(\d+行\)/.test(p)));
}
// IMPL-1007:ok
{
  check('1007 適合: 6項目が記入済みで、条件つきの行が無い', problems(render()).length === 0, problems(render()).join(' / '));
  check('1007 適合: 条件つきの行が空でも欠落に数えない', problems(render({ extra: '| 監視の実装 | |\n| 実行時の不変条件の確認 | TBD |' })).length === 0);
  check('1007 適合: 理由を添えた「なし(…)」は通る', !isBlankCell('なし(時間窓を持たない監視を用いない)'));
}

// ---- IMPL-0925: 故障挿入の環境の形
// IMPL-0925:ng
for (const [v, label] of [['模擬環境', '種別だけ'], ['本番機', '3種でない語'], ['模擬環境と本番の併用', '併用'], ['本番の模擬環境(X)', '前方が3種でない'], ['', '空欄'], ['模擬環境()', '識別が空'], ['例外承認: D-1', '例外承認の ID'], ['模擬環境(HIL-2)(本番)', '括弧を2組(丸括弧)'], ['模擬環境: HIL-2(本番機)', 'コロンの形に括弧を含む']]) {
  check(`0925 違反: 環境「${v}」(${label})`, problems(withFault(1, v, null)).some((p) => /試験項目1.*挿入した環境/.test(p)));
}
// IMPL-0925:ok
for (const v of ['模擬環境(HIL-2)', '試験台の実機: 台3', '専門部門の設備(設備 A-3)', '実行前の挿入']) {
  check(`0925 適合: 環境「${v}」`, envProblem(v) === null && problems(withFault(1, v, null)).length === 0);
}

// ---- IMPL-0927: 結果の欄の形
const LEDGER = [
  { id: 'D-5', kind: '例外', target: '基準7', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-6', kind: '例外', target: '基準7', state: '失効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-7', kind: '例外', target: '基準7', state: '有効', due: '2020-01-01', approver: '甲', text: '' },
  { id: 'D-10', kind: '例外', target: '基準7', state: '有効', due: '2099-12-31', approver: '', text: '' },
  { id: 'D-11', kind: '例外', target: '基準7', state: '有効', due: '2099-12-31', approver: 'Claude Code', text: '' },
  { id: 'D-12', kind: '例外', target: '基準7', state: '有効', due: '2099-12-31', approver: '名簿の外の者', text: '' },
  { id: 'D-20', kind: '例外', target: 'PR #12', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-21', kind: '例外', target: '基準 7(試験項目2)', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-22', kind: '例外', target: '安全関連部の検証の記録 項目2', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-23', kind: '例外', target: null, state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-24', kind: '例外', target: '基準70', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-25', kind: '例外', target: 'G-5 基準7', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-26', kind: '例外', target: 'SG の基準7', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-27', kind: '例外', target: '基準７(試験項目2)', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-28', kind: '例外', target: 'G-7 の基準7', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-29', kind: '例外', target: 'G-7 基準7', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-30', kind: '例外', target: 'G-5 基準7 と 基準7', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
  { id: 'D-31', kind: '例外', target: '', state: '有効', due: '2099-12-31', approver: '甲', text: '' },
];
const isValidApprover = (n) => n === '甲';
const ctx = { ledgerRows: LEDGER, day: '2026-11-18', isValidApprover };
// IMPL-0927:ng
for (const v of ['', '省略', '該当なし(時間窓なし)', '未実施', '例外承認: D-9', '例外承認: D-6', '例外承認: D-7']) {
  check(`0927 違反: 項目2 の結果「${v}」`, problems(withFault(2, null, v), ctx).some((p) => /試験項目2.*結果/.test(p)));
}
for (const [id, why] of [['D-10', '承認者が空'], ['D-11', 'AI の名義'], ['D-12', '名簿の外']]) {
  check(`0927 違反: 例外承認 ${id}(${why})`, problems(withFault(2, null, `例外承認: ${id}`), ctx).some((p) => /試験項目2.*結果.*承認/.test(p)));
}
for (const [id, why] of [['D-20', 'PR の番号'], ['D-24', '基準70'], ['D-25', 'G-5 基準7'], ['D-26', 'SG の基準7'], ['D-31', '空欄']]) check(`0927 違反: 対象に基準7 の語が無い行 ${id}(${why})`, problems(withFault(2, null, `例外承認: ${id}`), ctx).some((p) => /試験項目2.*結果.*対象.*基準7/.test(p)));
check('0927 違反: 対象の欄が無い台帳は、語が無いとは別の理由を出す', (() => { const ps = problems(withFault(2, null, '例外承認: D-23'), ctx); return ps.some((p) => /試験項目2.*結果.*技術負債台帳に対象の欄が無い/.test(p)) && !ps.some((p) => /語が無い/.test(p)); })());
check('0927 違反: 対象の語が無い理由に行の ID を出す', problems(withFault(2, null, '例外承認: D-20'), ctx).some((p) => /D-20/.test(p)));
check('0927 違反: 承認者の照合の手段が渡されない', problems(withFault(2, null, '例外承認: D-5'), { ledgerRows: LEDGER, day: '2026-11-18' }).some((p) => /試験項目2.*結果/.test(p)));
check('0927 違反: 例外承認の台帳を読めない(ID を確かめられない)', problems(withFault(2, null, '例外承認: D-5'), { ledgerRows: null, day: '2026-11-18', isValidApprover }).some((p) => /試験項目2.*結果/.test(p)));
check('0927 違反: 項目2 以外の行でも「省略」は通らない', problems(withFault(5, null, '省略'), ctx).some((p) => /試験項目5.*結果/.test(p)));
// IMPL-0927:ok
for (const v of ['一致', '不一致(時間窓なし。早い応答を通す)', '例外承認: D-5', '例外承認: D-21', '例外承認: D-22', '例外承認: D-27', '例外承認: D-28', '例外承認: D-29', '例外承認: D-30']) {
  check(`0927 適合: 項目2 の結果「${v}」`, problems(withFault(2, null, v), ctx).length === 0, problems(withFault(2, null, v), ctx).join(' / '));
}

// ---- IMPL-0934: 手法の表
// IMPL-0934:ng
{
  check('0934 違反: 手法の表が無い', problems(render().replace(/\| 手法 \|[\s\S]*?\n\n/, '\n')).some((p) => /手法の表/.test(p)));
  check('0934 違反: 行が 0 件', problems(render({ methods: [] })).some((p) => /行がありません/.test(p)));
  for (const [k, label] of [[1, '推奨度'], [2, '出典'], [3, '適用']]) {
    const m = [...GOOD_METHOD];
    m[k] = '';
    check(`0934 違反: ${label}が空欄`, problems(render({ methods: [m] })).some((p) => new RegExp(label).test(p)));
  }
  check('0934 違反: 適用が「適用」「しない」でない', problems(render({ methods: [['静的解析', 'HR', '規格X 表Z', '一部', '']] })).some((p) => /適用が/.test(p)));
  check('0934 違反: HR で「しない」のに理由が空欄', problems(render({ methods: [['形式検証', 'HR', '規格X 表Z', 'しない', '']] })).some((p) => /しない理由が空欄/.test(p)));
  check('0934 違反: HR で「しない」のに理由が「なし」', problems(render({ methods: [['形式検証', 'HR', '規格X 表Z', 'しない', 'なし']] })).some((p) => /しない理由が空欄/.test(p)));
}
// IMPL-0934:ok
{
  const ok = render({ methods: [GOOD_METHOD, ['形式検証', 'HR(原記号: ++)', '規格X 表Z', 'しない', '対象の規模が大きく、同等の効果を試験で確かめた'], ['レビュー', 'R', '規格X 表Z', 'しない', '']] });
  const r = safetyRecordProblems(ok);
  check('0934 適合: 理由ありの HR 不適用は通る(R の不適用は理由不要)', r.problems.length === 0, r.problems.join(' / '));
  check('0934 適合: HR の行 2 件・うち不適用 1 件を出す', r.hr?.n === 2 && r.hr?.m === 1);
  check('0934 適合: 結果の文に申告であることと妥当性を確かめていないことを書く', /推奨度は記入者の申告/.test(safetyRecordResultText({ applies: true, why: 'x', problems: [], hr: r.hr })) && /内容の妥当性は確かめていない/.test(safetyRecordResultText({ applies: true, why: 'x', problems: [], hr: r.hr })));
}

// ---- 適用の判定(U2 の共通の形)
// IMPL-1007:ng
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
  try {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    const r0 = checkSafetyRecord({ root: tmp, config: { answers: { 'q-criticality': 'cl1' } } });
    check('適用 違反: D-0 が無い案件は適用として欠落になる', r0.applies && r0.problems.length > 0);
    const d0 = (f2, cls) => `## 16. 安全重要度の判定の記録\n\n| 項目 | 内容 |\n| --- | --- |\n| 判定した区分 | ${cls} |\n| 附属書F F.2 の回答 | ${f2} |\n`;
    fs.writeFileSync(path.join(tmp, 'docs/D-0-governance.md'), d0('はい。人身への危害', 'CL1'));
    check('適用 違反: Q1 はい(CL1)は適用', checkSafetyRecord({ root: tmp, config: { answers: { 'q-criticality': 'cl1' } } }).applies);
    fs.writeFileSync(path.join(tmp, 'docs/D-0-governance.md'), d0('未定', 'CL1'));
    check('適用 違反: Q1 が読めないときは適用として扱う', checkSafetyRecord({ root: tmp, config: { answers: { 'q-criticality': 'cl1' } } }).applies);
    fs.writeFileSync(path.join(tmp, 'docs/D-0-governance.md'), d0('いいえ', 'CL1') + '| 附属書F F.2 の回答 | はい |\n');
    check('適用 違反: F.2 の行が「いいえ」「はい」と食い違えば Q1 を読めず、適用として扱う(R2-03)', checkSafetyRecord({ root: tmp, config: { answers: { 'q-criticality': 'cl1' } } }).applies);
    fs.writeFileSync(path.join(tmp, 'docs/D-0-governance.md'), d0('いいえ', 'CL2'));
    check('適用 違反: CL2 は Q1 いいえでも適用', checkSafetyRecord({ root: tmp, config: { answers: { 'q-criticality': 'cl1' } } }).applies);
    fs.writeFileSync(path.join(tmp, 'docs/D-0-governance.md'), d0('いいえ', 'CL1'));
    check('適用 違反: 構成の回答が CL3 なら記録が CL1 でも適用(高いほう)', checkSafetyRecord({ root: tmp, config: { answers: { 'q-criticality': 'cl3' } } }).applies);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
// IMPL-1007:ok
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
  try {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/D-0-governance.md'), '## 16. 安全重要度の判定の記録\n\n| 項目 | 内容 |\n| --- | --- |\n| 判定した区分 | CL1 |\n| 附属書F F.2 の回答 | いいえ |\n');
    const r = checkSafetyRecord({ root: tmp, config: { answers: { 'q-criticality': 'cl1' } } });
    check('適用 適合: Q1 いいえ・CL1 は「適用外」と出す(黙って通さない)', !r.applies && /適用外\(Q1 いいえ・CL0\/CL1\)/.test(safetyRecordResultText(r)));
    check('適用 適合: 適用外の文にも妥当性を確かめていないことを書く', /内容の妥当性は確かめていない/.test(safetyRecordResultText(r)));
    fs.writeFileSync(path.join(tmp, 'docs/safety-risk-assessment.md'), render());
    fs.writeFileSync(path.join(tmp, 'docs/D-0-governance.md'), '## 16. 安全重要度の判定の記録\n\n| 項目 | 内容 |\n| --- | --- |\n| 判定した区分 | CL2 |\n| 附属書F F.2 の回答 | はい |\n');
    const r2 = checkSafetyRecord({ root: tmp, config: { answers: { 'q-criticality': 'cl2' } } });
    check('適用 適合: 適用で記入済みの記録は欠落なし', r2.applies && r2.problems.length === 0, r2.problems.join(' / '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  check('適用: 判定の純関数(区分が読めず Q1 いいえ)は適用として扱う', safetyRecordApplies({ q1: false, classes: [null] }).applies === true);
}
// IMPL-0761:ng
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
  try {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/D-0-governance.md'), '## 16. 安全重要度の判定の記録\n\n| 項目 | 内容 |\n| --- | --- |\n| 判定した区分 | CL1 |\n| 附属書F F.2 の回答 | いいえ |\n');
    const cfg = (v) => ({ answers: { 'q-criticality': 'cl1' }, gates: { g7: { state: 'required', params: v === undefined ? {} : { safetyVerificationRecord: v } } } });
    const r = checkSafetyRecord({ root: tmp, config: cfg('required') });
    check('0761 違反: 構成の g7 が required でも、Q1 いいえ・CL1・記録なしなら適用として欠落に数える', r.applies && r.problems.length > 0, JSON.stringify(r));
    check('0761 違反: 純関数も required を適用の和として扱う', safetyRecordApplies({ q1: false, classes: ['cl1'], required: true }).applies === true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
// IMPL-0761:ok
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
  try {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/D-0-governance.md'), '## 16. 安全重要度の判定の記録\n\n| 項目 | 内容 |\n| --- | --- |\n| 判定した区分 | CL1 |\n| 附属書F F.2 の回答 | いいえ |\n');
    const cfg = (v) => ({ answers: { 'q-criticality': 'cl1' }, gates: { g7: { state: 'required', params: v === undefined ? {} : { safetyVerificationRecord: v } } } });
    check('0761 適合: 構成の値が無い・Q1 いいえ・CL1 は適用外のまま', !checkSafetyRecord({ root: tmp, config: cfg(undefined) }).applies);
    check('0761 適合: 値が required 以外(none)なら適用外のまま', !checkSafetyRecord({ root: tmp, config: cfg('none') }).applies);
    fs.writeFileSync(path.join(tmp, 'docs/safety-risk-assessment.md'), render());
    const r = checkSafetyRecord({ root: tmp, config: cfg('required') });
    check('0761 適合: 値が required でも、記入済みの記録なら欠落なし', r.applies && r.problems.length === 0, r.problems.join(' / '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- IMPL-0927: 承認者の照合を実物の名簿から作る(checkSafetyRecord)
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
  try {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs/D-0-governance.md'), '## 16. 安全重要度の判定の記録\n\n| 項目 | 内容 |\n| --- | --- |\n| 判定した区分 | CL2 |\n| 附属書F F.2 の回答 | はい |\n');
    fs.writeFileSync(path.join(tmp, 'docs/safety-risk-assessment.md'), withFault(2, null, '例外承認: D-5'));
    const ledger = (who) => `| ID | 区分 | 対象 | 内容 | 受容した理由 | 顕在化の兆候 | 返却の目安 | 状態 | 記録者 | 承認した者 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| D-5 | 例外 | 基準7 | 省く | 理由 | — | 2099-12-31 | 有効 | 乙 | ${who} |\n`;
    const config = { answers: { 'q-criticality': 'cl2' }, people: [{ id: 'p-ko', name: '甲' }, { id: 'p-ai', name: 'Claude Code' }] };
    const run = (who) => checkSafetyRecord({ root: tmp, config, day: '2026-11-18' }).problems.filter((p) => /試験項目2/.test(p));
    // IMPL-0927:ng
    for (const [who, label] of [['', '空'], ['Claude Code', 'AI の名義(名簿にあっても)'], ['丙', '名簿の外']]) {
      fs.writeFileSync(path.join(tmp, 'docs/debt-ledger.md'), ledger(who));
      check(`0927 違反(実物の名簿): 承認者が${label}`, run(who).length > 0, run(who).join(' / '));
    }
    // IMPL-0927:ok
    fs.writeFileSync(path.join(tmp, 'docs/debt-ledger.md'), ledger('甲'));
    check('0927 適合(実物の名簿): 名簿の人が承認した成立した行', run('甲').length === 0, run('甲').join(' / '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 様式との一致(初期の文は定数で持ち、様式と一致を固定する)
{
  const tpl = fs.readFileSync(path.join(ROOT, 'templates/09-safety-risk-assessment.md'), 'utf8').replace(/\r\n/g, '\n');
  for (const [k, v] of Object.entries(ROW_ITEMS)) check(`様式: 初期の文「${k}」が様式の09 と一致する`, tpl.includes(`| ${k} | ${v} |`));
  check('様式: 手法の表の5列が様式の09 にある', tpl.includes(`| ${METHOD_COLUMNS.join(' | ')} |`) || /\| 手法 \| 推奨度/.test(tpl));
  // 様式のまま(記入を足さない)の記録は欠落 19 件(4 項目 + 手法の表の行 + 試験項目 7 行 × 環境と結果)
  const sec = tpl.slice(tpl.indexOf('## 安全関連部の検証の記録'));
  const r = safetyRecordProblems(sec.slice(0, sec.indexOf('\n## 記入時の注意')));
  check('様式: 様式のままの記録は欠落 19 件', r.problems.length === 19, `${r.problems.length}: ${r.problems.join(' / ')}`);
}

console.log('');
if (failed) {
  console.log(`::error::安全関連部の検証の記録の検査の試験: ${failed} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`安全関連部の検証の記録の検査の試験: ${total} 件が期待と一致しました`);
