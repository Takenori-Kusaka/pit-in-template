// 検知・知らせ・抜き取りを起動する値(最小標本数・観測の窓・同時保有の上限・事後の抜き取りの件数・手戻り率の基準値)の読み取りと、
// 事故の後の警告の適用範囲の線。
//
// 本標準は、これらの値に一律の既定値を課さない。値は採用者が自社の過去のトラブルとプロダクトの特性に合わせて定義する。
// 定義が無い(欄が無い、または履歴の最新が null)ときは、止めずに進め、働いていない検知の名を出す。
// 値の欄の形(最小標本数・同時保有の上限): 整数(1 以上)、または { history: [{ value, recordedAt, decidedBy, reason }] }。
// 履歴の最新の value が null のときは「外した記録」であり、未定義と同じ扱いにする。欄に直接 null は書かない(同じ状態を 2 形で書かせない)

import { aiNameReason, isRealDay } from './config.mjs';

const isPosInt = (v) => Number.isInteger(v) && v >= 1;

/**
 * 値の欄(整数、または履歴つきのオブジェクト)から、効く値を返す。未定義なら null。
 * 履歴は観測の窓と同じ型で読む: 記録した日(recordedAt)が実在する日付で、決定した者が AI の名義でない記録だけを効かせる。
 * day(評価の日)を渡したときは、記録した日が day より前の記録だけを当てる(遡って当てない)。整数だけの形は、常に効く
 */
export function definedValue(field, day = null) {
  if (isPosInt(field)) return field;
  const h = field && typeof field === 'object' && !Array.isArray(field) && Array.isArray(field.history) ? field.history : null;
  if (!h || !h.length) return null;
  let v = null;
  for (const e of h) {
    if (!(e?.value === null || isPosInt(e?.value))) continue;
    if (!isRealDay(e?.recordedAt)) continue;
    if (typeof e?.decidedBy !== 'string' || !e.decidedBy.trim() || aiNameReason(e.decidedBy, { account: true })) continue;
    if (day !== null && !(String(e.recordedAt) < String(day))) continue;
    v = e.value;
  }
  return isPosInt(v) ? v : null;
}

/** 最小標本数(窓の中の変更の件数)。未定義なら null */
export const minSampleOf = (config, day = null) => definedValue(config?.detection?.minSample, day);

/** 同時保有の上限(1人あたりの未応答の指名の件数)。未定義なら null */
export const loadLimitOf = (config, day = null) => definedValue(config?.reviewQueue?.loadLimit, day);

/** 観測の窓が定義されているか(構成の observationWindow の履歴に、整数の months がある) */
export function observationWindowDefined(config, day = null) {
  const h = config?.observationWindow?.history;
  return Array.isArray(h) && h.some((e) => Number.isInteger(e?.months) && e.months >= 1 && isRealDay(e?.recordedAt) && !(typeof e?.decidedBy === 'string' && aiNameReason(e.decidedBy, { account: true })) && (day === null || String(e.recordedAt) < String(day)));
}

/** 事後の抜き取りの件数(月ごと)。未定義なら null(当月の全件を事後に確かめる) */
export const samplingPerMonthOf = (config) => (isPosInt(config?.delegation?.sampling?.perMonth) ? config.delegation.sampling.perMonth : null);

/** 手戻り率の基準値が定義されているか(評価の日に効く値は reworkBaselineInfo が持つ。ここは欄の有無だけ) */
export const reworkBaselineDefined = (config) => {
  const h = config?.reworkBaseline?.history;
  return Array.isArray(h) && h.some((e) => typeof e?.percent === 'number');
};

/** 安全重要度が CL1 以上、または規制業か(第5章 5.5.4 の委任の適用の条件1 と同じ読み。未記入は CL0 とみなさない) */
export function safetyOrRegulated(config) {
  const a = config?.answers ?? {};
  return a['q-criticality'] !== 'cl0' || a['q-quality'] === 'quality-regulated';
}

/**
 * 定義されていない値と、そのために働いていない検知の名を返す。
 * 各要素: { key: 構成の欄, label: 値の名, idle: 働いていない検知・代わりの行為の文 }
 */
export function undefinedValues(config) {
  const out = [];
  if (!observationWindowDefined(config)) out.push({ key: 'observationWindow', label: '観測の窓', idle: '差し戻し率 0% の継続の検知と手戻り率の検知は働いていない。委任した種類は、当月の全件を事後に確かめる' });
  if (minSampleOf(config) === null) out.push({ key: 'detection.minSample', label: '最小標本数', idle: '差し戻し率 0% の継続の検知と手戻り率の検知は働いていない(件数が足りるかを判断できない)。委任した種類は、当月の全件を事後に確かめる' });
  if (loadLimitOf(config) === null) out.push({ key: 'reviewQueue.loadLimit', label: '同時保有の上限', idle: '同時保有の上限を超えた知らせは出ていない(期限超過の催促は出る)' });
  if (config?.delegation?.allowed === true && samplingPerMonthOf(config) === null) out.push({ key: 'delegation.sampling.perMonth', label: '事後の抜き取りの件数', idle: '抜き取りの定めが無いため、委任した種類は当月の全件を事後に確かめる' });
  if (config?.delegation?.allowed === true && !reworkBaselineDefined(config)) out.push({ key: 'reworkBaseline', label: '手戻り率の基準値', idle: '手戻り率の検知は働いていない。委任した種類は、当月の全件を事後に確かめる' });
  return out;
}

/** 定義されていない値の文(1 行)。無ければ null */
export function undefinedValuesText(config) {
  const u = undefinedValues(config);
  if (!u.length) return null;
  return `定めていない値が ${u.length} 件ある。働いていない検知: ${u.map((x) => `${x.label}(${x.idle})`).join(' / ')}。値は自社の過去のトラブルとプロダクトの特性に合わせて決める(種別 settings で記録する)`;
}

/** 値の欄の形の検査。整数 1 以上、または履歴つき。欄に直接 null は拒む */
export function detectionValueProblems(config) {
  const out = [];
  const check = (name, field) => {
    if (field === undefined) return;
    if (field === null) return out.push(`${name} に直接 null は書かない(外すときは履歴の最後に value: null を、記名と理由とともに足す)`);
    if (isPosInt(field)) return;
    if (typeof field !== 'object' || Array.isArray(field) || !Array.isArray(field.history)) return out.push(`${name} は 1 以上の整数か、history(値・記録した日・決定した者・理由)を持つオブジェクトで書く`);
    let prev = null;
    field.history.forEach((e, i) => {
      if (!(e?.value === null || isPosInt(e?.value))) out.push(`${name}.history[${i}].value は 1 以上の整数か null(外した記録)で書く`);
      if (!isRealDay(e?.recordedAt)) out.push(`${name}.history[${i}].recordedAt は実在する日付(YYYY-MM-DD)で書く`);
      else if (prev !== null && String(e.recordedAt) < prev) out.push(`${name}.history[${i}].recordedAt が前の記録より前の日付である(日付の順に並べる)`);
      if (isRealDay(e?.recordedAt)) prev = String(e.recordedAt);
      if (typeof e?.decidedBy !== 'string' || !e.decidedBy.trim()) out.push(`${name}.history[${i}].decidedBy(決定した者の記名)が無い`);
      else if (aiNameReason(e.decidedBy, { account: true })) out.push(`${name}.history[${i}].decidedBy "${e.decidedBy}" は ${aiNameReason(e.decidedBy, { account: true })}。値の決定は人が記名する`);
      if (typeof e?.reason !== 'string' || !e.reason.trim()) out.push(`${name}.history[${i}].reason(理由)が無い`);
    });
  };
  check('detection.minSample', config?.detection?.minSample);
  check('reviewQueue.loadLimit', config?.reviewQueue?.loadLimit);
  return out;
}
