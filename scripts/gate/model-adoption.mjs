// モデルの導入の記録・評価用の基準集合の正解の目録・AI の採点者の較正の記録を読み、標準の要求事項に照らして欠けを出す
// (標準 第3章 3.12.3 の要求事項1〜4・11〜16、3.12.13。process-compass #426 / ADR-0104・ADR-0105。IMPL-0405〜0407・0410・0411)。
//
// 読む記録(どれも AI運用担当者が PR で入れる。構成を変えないため /process-change を経ない):
//   docs/model-adoption.json   { "adoptions": [ 導入の記録 ] }
//   <基準集合の所在>/answers.json   { "cases": [ 事例ごとの正解の確定 ], "blindConfirmation": { "count", "agreement" } | "なし" }
//   docs/exit-rehearsal.json の rehearsals[] のうち grading が "ai" のものの judge(較正の記録)
//
// 機械が確かめるのは記録の欄の有無・記名が人であること・席の責任者との一致・日付の前後だけである。
// 正解が正しいか、事例を人が実際に見たか、一致の値が十分かは確かめない(読み方は組織が定める値。標準 第1章 1.7.7)。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, isFilledValue, isRealDay, nameProblems } from './config.mjs';

export const MODEL_ADOPTION_FILE = 'docs/model-adoption.json';

const clean = (v) => String(v ?? '').trim();
const norm = (v) => clean(v).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const KINDS = ['expected-output', 'verdict', 'rubric'];
const SOURCES = ['external', 'past-judgment', 'new'];

/** 席の責任者の氏名(seats[].accountable は名簿の id か氏名) */
function accountableOf(config, role) {
  const s = (config.seats ?? []).find((x) => x.role === role);
  if (!s?.accountable) return null;
  const p = (config.people ?? []).find((x) => x.id === s.accountable || x.name === s.accountable);
  return p?.name ?? s.accountable;
}
const same = (a, b) => Boolean(norm(a)) && norm(a) === norm(b);
const humanProblems = (config, name) => (isFilledValue(name) ? nameProblems(config, clean(name), { checkRoster: false }) : ['記名がない']);

/**
 * AI の採点者の較正の記録(3.12.13 の要求事項2〜8)を確かめる。
 * @returns {{ status: '有効'|'未測定', why: string[] }}
 */
export function calibrationFindings(config, judge, { evaluatedAt = null, compared = [] } = {}) {
  const why = [];
  if (!judge || typeof judge !== 'object') return { status: '未測定', why: ['較正の記録(judge)が無い'] };
  const id = judge.identity ?? {};
  if (!isFilledValue(id.model)) why.push('採点者の識別の model(採点のモデルの版)が無い');
  else if (/^(latest|default|既定)$/i.test(clean(id.model))) why.push(`採点のモデルの版が別名(${clean(id.model)})。固定した版で書く`);
  if (!isFilledValue(id.prompt)) why.push('採点者の識別の prompt(採点の指示の版)が無い');
  if (!isFilledValue(id.settings)) why.push('採点者の識別の settings(推論の設定)が無い');
  const rr = judge.readingRule ?? {};
  if (!isFilledValue(rr.rule)) why.push('一致の読み方(readingRule.rule)が無い');
  const tech = accountableOf(config, 'tech-lead');
  if (!isFilledValue(rr.decidedBy)) why.push('一致の読み方を定めた技術判断者(readingRule.decidedBy)が無い');
  else if (humanProblems(config, rr.decidedBy).length) why.push(`読み方の記名: ${humanProblems(config, rr.decidedBy)[0]}`);
  else if (tech && !same(rr.decidedBy, tech)) why.push(`読み方を定めた "${clean(rr.decidedBy)}" が技術判断者の席の責任者でない`);
  if (!isRealDay(rr.at)) why.push('一致の読み方を定めた日(readingRule.at)が日付でない');
  const s = judge.sample ?? {};
  if (!['random', 'stratified'].includes(clean(s.method))) why.push('部分集合の選び方(sample.method: random / stratified)が無い');
  if (!isFilledValue(s.sizeRule)) why.push('件数の決め方(sample.sizeRule)が無い');
  const raters = Array.isArray(judge.raters) ? judge.raters : [];
  if (!raters.length) why.push('人の採点者(raters[])が無い');
  for (const r of raters) {
    const p = humanProblems(config, r?.name);
    if (p.length) why.push(`人の採点者の記名: ${p[0]}`);
  }
  const arms = judge.arms && typeof judge.arms === 'object' ? judge.arms : {};
  const names = Object.keys(arms);
  if (!names.length) why.push('比べるモデルごとの一致(arms)が無い');
  for (const n of compared.filter(Boolean)) if (!names.some((a) => same(a, n) || same(arms[a]?.model, n))) why.push(`比べるモデル ${n} の一致が arms に無い(双方に分けて書く)`);
  for (const a of names) {
    const x = arms[a] ?? {};
    if (!x.table || typeof x.table !== 'object' || !Object.keys(x.table).length) why.push(`${a}: 人の採点と AI の採点の組ごとの件数(table)が無い`);
    if (!isFilledValue(x.indicator?.name) || typeof x.indicator?.value !== 'number') why.push(`${a}: 偶然の一致を除く指標の名と値(indicator)が無い。単純な一致の割合だけの記録は未測定とする`);
    if (!isFilledValue(x.interval)) why.push(`${a}: 指標の区間(interval)が無い`);
  }
  // 評価の結果を見た後に読み方を改めた(緩める向き)。導入の評価の日より後に定めた読み方
  const loosened = isRealDay(rr.at) && isRealDay(evaluatedAt) && rr.at > evaluatedAt;
  return { status: why.length ? '未測定' : '有効', why, loosened, model: clean(id.model) || null };
}

/** 正解の目録(3.12.3 の要求事項11〜14・16)を確かめる */
export function answersFindings(config, catalog, { approvedBy = null } = {}) {
  const why = [];
  const notes = [];
  if (!catalog || !Array.isArray(catalog.cases)) return { confirmed: 0, unconfirmed: [], why: ['正解の目録に cases[] が無い'], notes };
  const tech = accountableOf(config, 'tech-lead');
  const unconfirmed = [];
  let confirmed = 0;
  let separation = 0;
  for (const c of catalog.cases) {
    const id = clean(c?.id) || '(id なし)';
    const own = [];
    if (!KINDS.includes(clean(c?.kind))) own.push('kind(expected-output / verdict / rubric)が無い');
    if (!SOURCES.includes(clean(c?.source))) own.push('source(external / past-judgment / new)が無い');
    else if (clean(c.source) !== 'new' && !isFilledValue(c?.sourceRef)) own.push('出所の所在(sourceRef)が無い');
    const fromRecord = ['external', 'past-judgment'].includes(clean(c?.source)) && isFilledValue(c?.sourceRef);
    if (!fromRecord) {
      // 新たに確定した正解は、事例が再現する席の責任者(席が無い・AI運用担当者の席は技術判断者)が事例ごとに記名する
      const seat = clean(c?.seat);
      const want = !seat || seat === 'ai-ops' ? tech : accountableOf(config, seat);
      if (!isFilledValue(c?.confirmedBy)) own.push('確定した者(confirmedBy)が無い');
      else if (humanProblems(config, c.confirmedBy).length) own.push(`確定した者: ${humanProblems(config, c.confirmedBy)[0]}`);
      else if (want && !same(c.confirmedBy, want)) own.push(`確定した "${clean(c.confirmedBy)}" が${seat && seat !== 'ai-ops' ? `席 ${seat}` : '技術判断者'}の責任者でない`);
      if (!isRealDay(c?.at)) own.push('確定の日(at)が日付でない');
      if (c?.draft !== null && c?.draft !== undefined && !isFilledValue(c?.draft?.model)) own.push('草案(draft)に草案を作ったモデルの版が無い(草案が無ければ null)');
      if (approvedBy && isFilledValue(c?.confirmedBy) && same(c.confirmedBy, approvedBy)) separation++;
    }
    for (const r of Array.isArray(c?.revisions) ? c.revisions : []) {
      if (!isFilledValue(r?.from) || !isFilledValue(r?.to) || !isFilledValue(r?.reason) || !isRealDay(r?.at) || humanProblems(config, r?.confirmedBy).length) own.push('正解の改め(revisions[])に from・to・reason・confirmedBy(人)・at のいずれかが無い');
    }
    if (own.length) unconfirmed.push(`${id}: ${own.join('、')}`);
    else confirmed++;
  }
  const blind = catalog.blindConfirmation;
  if (blind === undefined || blind === null) why.push('盲検の確定の記録(blindConfirmation: { count, agreement } または "なし")が無い');
  if (separation) notes.push(`確定した者と導入を承認した AI運用担当者が同一人物の事例 ${separation} 件(分離が成り立たない。層1 の権限者の期限つきの受容が要る)`);
  return { confirmed, unconfirmed, why, notes };
}

/** 導入の記録を読み、モデルごとの状態を返す。day は判定の日 */
export function modelAdoptionState(config, { root = ROOT } = {}) {
  const p = path.join(root, MODEL_ADOPTION_FILE);
  if (!fs.existsSync(p)) return { present: false, adoptions: [], problems: [], notes: [] };
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { present: true, adoptions: [], problems: [`${MODEL_ADOPTION_FILE} を JSON として読めない(${e.message})`], notes: [] };
  }
  const list = Array.isArray(j?.adoptions) ? j.adoptions : null;
  if (!list) return { present: true, adoptions: [], problems: [`${MODEL_ADOPTION_FILE} に adoptions[] が無い`], notes: [] };
  const ops = accountableOf(config, 'ai-ops');
  const problems = [];
  const notes = [];
  const adoptions = list.map((a) => {
    const model = clean(a?.model) || '(model 未記入)';
    const why = [];
    // 3.12.3 の要求事項1〜4
    const baseline = clean(a?.baseline);
    if (!isFilledValue(baseline)) why.push('基準集合の所在(baseline)が無い');
    else if (!/^[a-z]+:\/\//i.test(baseline) && !fs.existsSync(path.join(root, baseline))) why.push(`基準集合の所在 ${baseline} がリポジトリに無い`);
    if (!isRealDay(a?.evaluatedAt)) why.push('回帰評価の日(evaluatedAt)が日付でない');
    if (!isFilledValue(a?.diff)) why.push('現行モデルとの差分の記録(diff)が無い');
    if (!isFilledValue(a?.approvedBy)) why.push('導入を承認した AI運用担当者(approvedBy)が無い');
    else if (humanProblems(config, a.approvedBy).length) why.push(`承認: ${humanProblems(config, a.approvedBy)[0]}`);
    else if (ops && !same(a.approvedBy, ops)) why.push(`承認した "${clean(a.approvedBy)}" が AI運用担当者の席の責任者でない`);
    if (!isRealDay(a?.approvedAt)) why.push('承認の日(approvedAt)が日付でない');
    else if (isRealDay(a?.evaluatedAt) && a.approvedAt < a.evaluatedAt) why.push('承認の日が回帰評価の日より前');
    if (!isFilledValue(a?.change)) why.push('差し替えの変更の記録(change: PR の番号かコミット)が無い');
    // 3.12.3 の要求事項11〜14・16(正解の目録)
    let answers = null;
    if (isFilledValue(baseline) && !/^[a-z]+:\/\//i.test(baseline)) {
      const abs = path.join(root, baseline);
      const file = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(abs, 'answers.json') : path.join(path.dirname(abs), 'answers.json');
      if (!fs.existsSync(file)) why.push(`正解の目録 ${path.relative(root, file).replace(/\\/g, '/')} が無い(事例ごとの確定の記録。3.12.3 の要求事項13)`);
      else {
        try {
          answers = answersFindings(config, JSON.parse(fs.readFileSync(file, 'utf8')), { approvedBy: a?.approvedBy });
          why.push(...answers.why);
          if (answers.unconfirmed.length) why.push(`確定なしの事例 ${answers.unconfirmed.length} 件(${answers.unconfirmed.slice(0, 3).join(' / ')}${answers.unconfirmed.length > 3 ? ' ほか' : ''})`);
          notes.push(...answers.notes.map((n) => `${model}: ${n}`));
        } catch (e) {
          why.push(`正解の目録を JSON として読めない(${e.message})`);
        }
      }
    }
    // 3.12.3 の要求事項15・3.12.13(AI の採点)
    let judge = null;
    if (clean(a?.grading) === 'ai') {
      judge = calibrationFindings(config, a?.judge, { evaluatedAt: a?.evaluatedAt, compared: [a?.model, a?.replaces] });
      const sameModel = judge.model && (same(judge.model, a?.model) || same(judge.model, a?.replaces));
      if (judge.status === '未測定') {
        if (sameModel) why.push('AI の採点が未測定で、比べるモデルと同じモデル・版で採点した。差分を導入の根拠に数えない(3.12.3 の要求事項15)');
        else if (!isFilledValue(a?.unmeasuredAcceptance?.by) || !isRealDay(a?.unmeasuredAcceptance?.until)) why.push(`AI の採点が未測定(${judge.why.slice(0, 2).join('、')})。層1 の権限者の期限つきの受容(unmeasuredAcceptance: { by, until })が無い`);
        else notes.push(`${model}: AI の採点が未測定のまま、${clean(a.unmeasuredAcceptance.by)} が ${a.unmeasuredAcceptance.until} まで受容した`);
      } else if (sameModel) notes.push(`${model}: 比べるモデルと同じモデル・版(${judge.model})で採点した`);
      if (judge.loosened) why.push('一致の読み方を、回帰評価の日より後に定めた(評価の結果を見た後の改めは統制を緩める向きの変更。3.12.13 の要求事項2)');
    } else if (!['deterministic', 'human'].includes(clean(a?.grading))) why.push('採点の方法(grading: ai / deterministic / human)が無い');
    // 結果を見た後に改めた正解の一覧と、改める前の結果の併記(要求事項16)
    for (const r of Array.isArray(a?.revisedAfterResults) ? a.revisedAfterResults : []) {
      if (!isFilledValue(r?.case) || !isFilledValue(r?.beforeResult)) why.push('結果を見た後に改めた正解(revisedAfterResults[])に事例(case)か改める前の結果(beforeResult)が無い');
      if (r?.failToPass === true || r?.removed === true) notes.push(`${model}: 事例 ${clean(r?.case)} は${r.removed ? '除いた' : '不合格を合格へ改めた'}(統制を緩める向きの変更。3.12.3 の要求事項16)`);
    }
    const approved = !why.length;
    if (why.length) problems.push(`導入の記録 ${model}: ${why.join('。')}`);
    return { model, provider: clean(a?.provider) || null, approved, why, answers, judge };
  });
  return { present: true, adoptions, problems, notes };
}

/** 退出の予行のうち AI の採点を用いた記録の較正(3.12.13 の要求事項1 (a)) */
export function rehearsalJudgeFindings(config, rehearsals) {
  const out = [];
  for (const r of Array.isArray(rehearsals) ? rehearsals : []) {
    if (clean(r?.grading) !== 'ai') continue;
    const f = calibrationFindings(config, r?.judge, { evaluatedAt: r?.at, compared: [r?.model, r?.alternative?.model] });
    if (f.status === '未測定') out.push(`退出の予行(${clean(r?.model) || 'model 未記入'} / ${r?.at ?? '日付なし'})の AI の採点が未測定: ${f.why.slice(0, 3).join('、')}`);
  }
  return out;
}
