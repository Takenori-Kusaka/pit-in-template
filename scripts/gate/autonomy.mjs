// AI自律レベルの導出と、登録した変更種別の停止(標準 第5章 5.4.4・5.4.6)。
//
// 準拠テンプレートが支える AI自律レベルは2つだけである。登録した変更種別(delegation.changeTypes[])は L3、
// それ以外は L1。L2 を支えない。レベルを書く欄を構成に持たず、委任の登録から導く(5.4.4 は、委任・標準変更・
// L3 を同じ登録と定める。欄を持つと、登録とレベルの正本が2つになり食い違う)。
//
// 5.4.6 の引き下げは、登録した変更種別の停止として実装する。停止は、委任を判定するたびに記録から導く。
// 停止を記録する手順を別に持たない(状態を持つと、記録と食い違う)。
//
//   第1区分(記録の存在で判定する。数えるのは出荷の後に発生した事象だけ。検出の時点が「出荷前」の行は数えない)
//     - AI が起因となった Sev1・Sev2(欠陥の台帳の「AI 起因」が「あり」)。事象の日より後の登録日で戻る
//     - 原因を特定できない Sev1・Sev2(「特定できない」・空欄)。適用の条件の欠落として止め、原因を特定する
//       (「あり」か「なし」へ改める)まで戻らない。登録し直しでは戻らない
//     - コア機能の理解保持者数が1名以下(運用引き継ぎ文書の節2)。運用引き継ぎ文書の履歴から1名以下だった時点を導き、
//       2名以上へ回復した日より後の登録日で戻る。履歴を読めない(浅い取得等)場合は、判定できないものとして止める
//   第2区分(期間ごとに集計する)
//     - 差し戻し率: 毎月、直近の観測の窓(構成の observationWindow。既定2か月・下限2。評価の日に効く値を当て、遡らない)で評価する。母数は既定ブランチの履歴のうち種別の規則の範囲に入る変更、
//       分子は判定基準の番号を引いた G-6 の差し戻しの判定記録。判定記録は様式(docs/gates/・記録用ブランチの records/gates/)と、
//       レビューを媒体とした判定(記録用ブランチの records/reviews/ と基底ブランチの docs/records/reviews/ の写しの宣言行)の両方を読む。
//       宣言行(G-6: 差し戻し / 基準 N)の無い承認レビューは判定記録ではなく、分子に数えない(CHANGES_REQUESTED だけのものを含む)。
//       数えていない件数(宣言行の無い CHANGES_REQUESTED)は、窓ごと・種別ごとに表示する。記録用ブランチを読めないときは「読めない」と出す
//       最小標本数(30件)以上で0件の評価は、
//       評価の日より後の登録日まで種別を止める。最新の窓が最小標本数に満たない場合は判定不能とし、
//       判定可能な窓が得られるまで止める(適用の条件の欠落。判定を待たずに戻る)
//     - 手戻り率: 毎月、差し戻し率と同じ評価の日・同じ窓で評価する。母数は窓の中に、登録した種別の範囲に入る取り込みの変更を持つタスク
//       (トレーラ Spec: F-NNN / Task-N)。分子はそのうち、(1) 既定ブランチの第1親の履歴に同じタスクを指すトレーラの取り込みが2つ以上ある、
//       (2) 実装計画(specs/*/plan.md)の履歴のいずれかの版で状態が「やり直し」だった、のどちらかに当たるもの(和。重複は1つに数える)。
//       基準値は構成の reworkBaseline(既定値なし。効力日は観測の窓と同じ)。評価の日 m では prevDay(m) 以前の記録だけで数える。
//       最小標本数(30件)以上で比が基準値を超えた評価は、評価の日より後の登録日まで種別を止める。窓の母数が最小標本数に満たない(判定不能)・
//       評価の日に効く基準値が無い(未設定)・手戻り率の記録を読めない(浅い取得を含む)ときも、適用の条件の欠落として種別を止める(ADR-0158)。
//       判定を待たずに戻る(両方の窓が判定可能になった評価の日 / 基準値を記録した日より後の評価の日)。計画表に書かれない不採用の後の再作成は数えていない旨を、常に表示する
//   登録日(registeredAt)の無い種別は、判定できないものとして止める。上限が L3 未満の構成では、すべての種別を止める
//
// 純粋な関数(autonomyState)と、記録を読む関数(readAutonomyRecords)を分ける。委任の判定(delegation.mjs)は
// 前者だけを使い、フィクスチャで試験できる。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reworkBaselineAt, reworkBaselineInfo } from './config.mjs';
import { readF2Q1 } from './cl-judgment.mjs';
import { lastParagraph } from './check-pr.mjs';
import { detectionFilled, CHANGE_TYPE_DETECTION, CHANGE_TYPE_ENFORCEMENT, enforcementFilled, ROOT, observationWindowAt,observationWindowInfo, observationWindowPending, windowLengthText, OBSERVATION_WINDOW_DEFAULT, isFilledValue, isRealDay, matchGlob, NEVER_DELEGATED, localDay, aiNameBlocked, identifyAccount, numericAccountId, resolveSigner, hasWriteAssociation, dedicatedSeatOf, sharingOf } from './config.mjs';
import { evaluate } from '../vendor/tailoring-engine.mjs';
import { continuityState, readPolicy } from './org-assurance.mjs';
import { readRecordsBranch, parseCopy, judgementsFromCopy, parseDeclaration, judgeOfForm, REVIEWS_DIR as BRANCH_REVIEWS_DIR } from './records.mjs';
import { ghHosting, introducedBacking, lastCommitOfFile, signerSharing } from './material-attribution.mjs';

/** 準拠テンプレートが支えるレベル。L2 は上限の値としてだけ現れる */
export const LEVELS = ['L1', 'L2', 'L3'];
export const levelRank = (l) => LEVELS.indexOf(l);
/** 観測の窓(月)の既定。第5章 5.4.6 の「2か月継続」(EV-0146)。組織の値は構成の observationWindow(config.mjs の observationWindowAt)が持つ */
export const WINDOW_MONTHS = OBSERVATION_WINDOW_DEFAULT;
/** 窓の中の最小標本数(変更の件数)。第4章「閾値の設定と較正」の要求事項3 の既定値 */
export const MIN_SAMPLE = 30;
/**
 * 手戻り率の算出が数えていない残り。常に表示する(標準の実装マーク IMPL-0517 が降ろしたのは算出と停止。計画表に書かれない
 * 不採用の後の再作成は、機械で閉じない。IMPL-0518 は採用者の手段)。表示と実態を食い違わせないため、省かない
 */
export const REWORK_UNCOUNTED =
  '数えていない残り: 計画表に「やり直し」と書かれず、トレーラの取り込みも1回だけの、不採用(マージされずに閉じた PR)の後の再作成。' +
  '採用者が登録の根拠 basis.detection.reworkRate に書いた手段で補う。その手段の内容は機械で確かめていない(内部監査で確かめる)。' +
  'トレーラは、第1親のコミットの本文の末尾の段落のものだけを読む(トレーラの後に段落が続くもの、マージコミットで取り込んだ第2親の側のトレーラは数えない)';

export const DETECTION_UNVERIFIED = '記入の有無は機械が確かめた。内容は機械で確かめていない';
/** 登録の根拠の記入の表示。記入のある検知条件だけを名指す。内容の確認の結果を含まないことを内外とも同じ文で出す */
export function detectionBasisText(type) {
  const keys = type?.detectionFilled ?? [];
  // 検知条件に未記入がある構成は登録の検査が拒否する。拒否される登録について「確かめた」と出さない
  if (!keys.length || keys.length < CHANGE_TYPE_DETECTION.length) return '';
  const names = CHANGE_TYPE_DETECTION.filter(([k]) => keys.includes(k)).map(([k, label]) => `${label} ${k}`).join('・');
  const enf = (type?.enforcementFilled ?? []).length === CHANGE_TYPE_ENFORCEMENT.length ? ' / 4点目(basis.enforcement の強制の手段の所在。実行の単位ごと)も同じ: 記入の有無だけを確かめ、手段が停止を強制するかは確かめていない' : '';
  return `登録の根拠(basis.detection の算出の所在: ${names}): ${DETECTION_UNVERIFIED}${enf}。内容は登録する者が登録の時に判定する。適用中のレベルが計測する手段に裏づけられているかの確認は標準の内部監査の観点23 に委ね、この出力はその結果を含まない`;
}

export const DEFECT_FILE = 'docs/defect-ledger.md';
export const HANDOVER_FILE = 'docs/handover.md';
const GATES_DIR = 'docs/gates';
/** 承認レビューの写しの基底ブランチの複製(出荷の PR が運ぶ。aggregate-evidence.mjs の BASE_COPIES_DIR と同じ) */
const BASE_COPIES_DIR = 'docs/records/reviews';

/** 停止の性質。downgrade は引き下げ(登録の判定で戻る)、それ以外は適用の条件の欠落(条件が戻れば戻る) */
export const STOP_KIND = {
  downgrade: '引き下げ',
  'cause-unknown': '適用の条件の欠落(原因を特定できない)',
  unmeasurable: '適用の条件の欠落(判定できない)',
  cap: '適用の条件の欠落(上限)',
  'safety-part': '適用の条件の欠落(安全関連部)',
  enforcement: '適用の条件の欠落(登録の根拠の4点目)',
};

/**
 * 安全関連部の判定の唯一の所在(IMPL-0919。ADR-0220)。D-0 表10 の F.2 の Q1(読めた値: 真=はい、偽=いいえ、読めなければ null)を受け、
 * 委任を止めるかを返す。止めないのは「いいえ」と読めたときだけである。「はい」・未記入・様式のまま・読めない・D-0 が無い、はすべて止める。
 * 種別の停止(autonomyState)・登録の拒否(capRefusal)・D-0 の表の生成と L3 の範囲(renderAutonomyTable・l3ScopeIds)が、この関数だけを通る。
 * 準拠テンプレートは安全関連部の範囲を持たないため、止めるのは案件の全体である(標準が求めるのは安全関連部の L1 固定まで)。
 * Q1 の答えの正しさは機械で閉じない(確かめる者: 判定者と確認者)
 */
export function safetyPartStop(q1) {
  if (q1 === false) return null;
  const why =
    q1 === true
      ? 'D-0 表10 の F.2 の Q1 が「はい」である。安全関連部は附属書F F.3 により AI自律レベル L1 固定で、準拠テンプレートは安全関連部の範囲を持たないため、委任を案件の全体で止める'
      : 'D-0 表10 の F.2 の Q1 を「いいえ」と読めない(D-0 が無い・未記入・様式のまま・読めない)。判定できないものとして、委任を案件の全体で止める';
  return { kind: 'safety-part', reason: why };
}

let kbCache = null;
function loadKB() {
  if (!kbCache) kbCache = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/vendor/tailoring-kb.json'), 'utf8'));
  return kbCache;
}

/** テーラリングの規則から、回答に対する AI自律レベルの上限を導く。規則が上限を置かない回答は L3 */
export function capFromAnswers(answers, kb = null) {
  const r = evaluate(kb ?? loadKB(), answers ?? {});
  const v = r.profile?.process?.params?.maxAutonomyLevel;
  return LEVELS.includes(v) ? v : 'L3';
}

/**
 * 上限の理由。CL2 の上限 L2 は、テーラリングの規則では安全関連部の上限である。準拠テンプレートの構成は安全関連部の
 * 範囲を持たないため、案件の全体へ掛ける(厳しくする側)。その旨を表示する
 */
export function capReason(level) {
  if (level === 'L2') {
    return 'テーラリングの規則の上限 L2(CL2)は案件の上限である。安全関連部は附属書F F.3 により L1 固定で、準拠テンプレートは範囲を持たないため、登録を適用しない';
  }
  if (level === 'L1') return 'テーラリングの規則の上限 L1(CL3。引き上げの対象にしない)';
  return null;
}

/**
 * 構成の AI自律レベルの上限。構成の autonomy.maxLevel を読む。欄の無い旧い構成は、回答からテーラリングの規則で導く。
 * 未設定の構成、回答に安全重要度(q-criticality)の無い構成、導けない場合は L1 とする(止まる側へ倒し、理由を出す)
 */
export function autonomyCap(config, { kb = null } = {}) {
  if (!config || config.configured === false) return { level: 'L1', source: 'unconfigured', reason: 'プロセス構成が未設定である' };
  const v = config.autonomy?.maxLevel;
  if (LEVELS.includes(v)) return { level: v, source: 'config', reason: capReason(v) };
  if (!config.answers?.['q-criticality']) {
    return { level: 'L1', source: 'answers-missing', reason: '回答に安全重要度(q-criticality)が無く、上限を導けない。止まる側(L1)へ倒す' };
  }
  try {
    const level = capFromAnswers(config.answers, kb);
    return { level, source: 'answers', reason: capReason(level) };
  } catch (e) {
    return { level: 'L1', source: 'error', error: e.message, reason: `上限を導けない(${e.message})。止まる側(L1)へ倒す` };
  }
}

/**
 * 「L2 以上を適用する範囲」= D-0 の「AI自律レベルの適用」の表が現在のレベルを L3 と書く行の変更種別の id(IMPL-1021・1022。標準 第5章 5.4.7)。
 * 表(renderAutonomyTable)と保証の開示の項目7 の判定が同じ導き方を使い、食い違わないようにする。
 * 委任が許されていない・上限が L3 未満・手戻り率が未計測の種別は L1 と書かれるので含めない。
 * 停止中(「L3(停止中は L1)」の行)は含める(表の静的な文字列で決まる決定可能な条件にそろえる)。種別の id の配列だけを返す
 */
export function l3ScopeIds(config, { q1 = null } = {}) {
  if (!config) return [];
  if (safetyPartStop(q1)) return [];
  const d = config.delegation ?? {};
  const types = d.allowed ? (d.changeTypes ?? []) : [];
  if (!types.length) return [];
  if (levelRank(autonomyCap(config).level) < levelRank('L3')) return [];
  return types.filter((t) => detectionFilled(t.basis).includes('reworkRate')).map((t) => String(t.id ?? ''));
}

/** 登録の拒否に使う。上限が L3 未満なら、その理由を返す(準拠テンプレートは L2 を支えないため、登録は L3 の扱い) */
export function capRefusal(config, { q1 = null } = {}) {
  const cap = autonomyCap(config);
  if (levelRank(cap.level) >= levelRank('L3')) {
    const sp = safetyPartStop(q1);
    return sp ? `${sp.reason}。変更種別の登録は L3 の適用であり、止める案件では登録しない(附属書F F.3。標準 第5章 5.4.4・5.4.5)` : null;
  }
  return (
    `AI自律レベルの上限が ${cap.level} である(${cap.source === 'config' ? '構成の autonomy.maxLevel' : 'テーラリングの規則'}。${cap.reason ?? '理由の記録なし'})。` +
    '変更種別の登録は L3 の適用であり、準拠テンプレートは L2 を支えないため、上限が L3 未満の構成では登録しない(標準 第5章 5.4.4・5.4.5)'
  );
}

// ---------------------------------------------------------------- 期間

const monthStart = (day) => `${String(day).slice(0, 7)}-01`;
function addMonths(first, n) {
  const [y, m] = first.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return t.toISOString().slice(0, 10);
}
const prevDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

/** 評価の日 m(月初)の窓。[from, m)。months は、その評価の日に効く観測の窓(observationWindowAt)を渡す。省くと既定 */
export function windowOf(m, months = WINDOW_MONTHS) {
  return { from: addMonths(m, -months), to: prevDay(m), evaluatedAt: m, months };
}

// ---------------------------------------------------------------- 種別への帰属

/**
 * 変更(ファイルの一覧)が、登録した変更種別の範囲に入るか。種別を指す規則のいずれかの範囲に、すべてのファイルが
 * 入ること。強制層・構成の正本・判定の記録、確約範囲とコア指定のパスに触れる変更は、どの種別にも入らない
 */
export function changeInType(config, typeId, files) {
  const list = (files ?? []).filter(Boolean);
  if (!list.length) return false;
  if (list.some((f) => NEVER_DELEGATED.some((g) => matchGlob(g, f)))) return false;
  const protectedPaths = (config.delegation?.protectedPaths ?? []).filter((g) => typeof g === 'string' && g.trim());
  if (list.some((f) => protectedPaths.some((g) => matchGlob(g, f)))) return false;
  const rules = (config.delegation?.rules ?? []).filter((r) => String(r.changeType ?? '').trim() === typeId);
  if (!rules.length) return false;
  return list.every((f) => rules.some((r) => (r.paths ?? []).some((g) => matchGlob(g, f)) && !(r.excludePaths ?? []).some((g) => matchGlob(g, f))));
}

/** 差し戻しの判定記録の対象(「PR #12」・コミットの識別子)を、履歴の変更へ対応づける */
function changeOfTarget(changes, target) {
  const t = String(target ?? '').normalize('NFKC');
  const pr = t.match(/#\s*(\d+)/)?.[1];
  if (pr) return changes.find((c) => String(c.pr ?? '') === pr) ?? null;
  const sha = t.match(/\b[0-9a-f]{7,40}\b/i)?.[0]?.toLowerCase();
  if (sha) return changes.find((c) => String(c.ref ?? '').toLowerCase().startsWith(sha)) ?? null;
  return null;
}

// ---------------------------------------------------------------- 導出(純粋な関数)

/**
 * 登録した変更種別ごとの現在のレベルと停止を導く。records は readAutonomyRecords の返り値と同じ形:
 *   asOf        判定の日(YYYY-MM-DD)
 *   defects     { present, rows: [{ id, severity: 'Sev1'|'Sev2'|..., date, aiCause: 'あり'|'なし'|'特定できない'|'', changeTypes: [..]|null,
 *                 phase: '出荷前'|'運用'|'' }] }
 *   core        { present, rows: [{ name, holders: 数, changeTypes: [..]|null, lowUntil: 回復の日|null }],
 *                 history: { available, reason? } }  運用引き継ぎ文書の履歴を読めたか
 *   history     { available, reason?, changes: [{ ref, date, pr, files: [..] }] }
 *   rejections  [{ file, date, target, cited, source? }]  G-6 の差し戻しの判定記録。cited は判定基準の番号を引いているか。
 *               source は 'form'(様式)か 'review'(レビューを媒体とした判定の写し)
 *   notes       [文]  評価の時点の注記
 * records が無い場合は、すべての登録した変更種別を判定できないものとして止める
 */
export function autonomyState(config, records) {
  const cap = autonomyCap(config);
  const types = Array.isArray(config?.delegation?.changeTypes) ? config.delegation.changeTypes : [];
  const asOf = records?.asOf && isRealDay(records.asOf) ? records.asOf : null;
  const out = {
    asOf,
    cap,
    window: { ...(asOf ? observationWindowInfo(config, monthStart(asOf)) : { months: WINDOW_MONTHS, longer: false }), pending: asOf ? observationWindowPending(config, monthStart(asOf)) : null, minSample: MIN_SAMPLE },
    reworkUncounted: REWORK_UNCOUNTED,
    otherLevel: 'L1',
    types: [],
    unattributedRejections: [],
    // 評価の時点の注記(出荷の終点で評価し直す場合に、現在の版を読んだ記録を示す)
    notes: [...(records?.notes ?? [])],
  };
  // 判定の日より後の記録は数えない(出荷の終点で評価し直す場合。突合 X-10)
  const notAfter = (d) => !asOf || d <= asOf;
  const changes = records?.history?.available ? (records.history.changes ?? []).filter((c) => isRealDay(c.date) && notAfter(c.date)) : [];
  const cited = (records?.rejections ?? []).filter((r) => r.cited && isRealDay(r.date) && notAfter(r.date));
  for (const r of cited) {
    const c = changeOfTarget(changes, r.target);
    if (!c) out.unattributedRejections.push(r);
  }
  // 運用引き継ぎ文書の節2 の「関わる登録した変更種別」のうち、登録の一覧に無い ID(K-4)。書き誤りで止まるべき種別が止まらない経路を作らないため、
  // その機能は空欄と同じ扱い(すべての種別を止める側)にする。どの機能のどの ID かを出力に出す
  const registeredIds = new Set(types.map((t) => String(t?.id ?? '').trim()).filter(Boolean));
  const unregisteredIdsOf = (list) => (Array.isArray(list) ? [...new Set(list.map((x) => String(x ?? '').trim()).filter((x) => x && !registeredIds.has(x)))] : []);
  out.coreUnregistered = (records?.core?.present ? records.core.rows ?? [] : []).map((c) => ({ name: c.name, ids: unregisteredIdsOf(c.changeTypes) })).filter((x) => x.ids.length);
  // 欠陥の台帳の「登録した変更種別」の列に、登録の一覧に無い ID を含む Sev1・Sev2 の行(process-compass #348・#441・#450)。
  // 運用引き継ぎ文書の節2(K-4)と同じ向きで、空欄と同じ扱い(すべての種別を止める側)にする。書き誤りで AI 起因の事象が委任を1つも止めない経路を作らない
  out.defectUnregistered = (records?.defects?.present ? records.defects.rows ?? [] : [])
    .filter((d) => ['Sev1', 'Sev2'].includes(d.severity))
    .map((d) => ({ id: d.id, ids: unregisteredIdsOf(d.changeTypes) }))
    .filter((x) => x.ids.length);
  // 宣言行の無い CHANGES_REQUESTED(分子に入れない。件数の表示だけ)。記録を渡していない・読めないときは null(0 件と出さない)
  const undeclaredAll = records?.undeclared?.available ? (records.undeclared.items ?? []).filter((r) => isRealDay(r.date) && notAfter(r.date)) : null;

  for (const t of types) {
    const id = String(t?.id ?? '').trim();
    if (!id) continue;
    const registeredAt = isRealDay(t.registeredAt) ? t.registeredAt : null;
    const stops = [];
    const stop = (category, kind, reason) => stops.push({ category, kind, reason });
    // 安全関連部(IMPL-0919)。D-0 表10 の Q1 を判定のたびに読んだ値(records.f2q1)で止める。記録が無い・値が無いときは null として止める
    const sp = safetyPartStop(records?.f2q1 ?? null);
    if (sp) stop('安全関連部', sp.kind, sp.reason);
    if (levelRank(cap.level) < levelRank('L3')) stop('上限', 'cap', `AI自律レベルの上限が ${cap.level} である。L3 を適用できない(${cap.reason ?? '理由の記録なし'})`);
    // 登録の根拠の4点目(IMPL-0834。標準 5.5.4)。実行の単位ごとの記入が欠けた種別は、登録が完了していないものとして止める。記入の内容は確かめない(ADR-0158)
    const enfMissing = CHANGE_TYPE_ENFORCEMENT.filter(([k]) => !enforcementFilled(t?.basis).includes(k));
    if (enfMissing.length) stop('登録の根拠', 'enforcement', `登録の根拠の4点目(basis.enforcement。${enfMissing.map(([k, label]) => `${label} ${k}`).join('・')})の記入が無く、登録が完了していない。4点目を記録した時点で戻る`);
    // 登録日の無い種別は、登録の判定と事象・窓の前後を確かめられない(突合 X-9)
    if (!registeredAt) stop('記録', 'unmeasurable', '登録日(registeredAt)が無く、登録の判定と事象・窓の前後を確かめられない。登録が完了していないものとして止める');
    if (!records || !asOf) {
      stop('記録', 'unmeasurable', '検知の記録を読んでいない(判定の日が無い)。判定できないものとして止める');
      out.types.push({ id, registeredAt, level: 'L1', stops, rejection: null, rework: null, detectionFilled: detectionFilled(t?.basis), enforcementFilled: enforcementFilled(t?.basis) });
      continue;
    }
    const applies = (list) => list === null || list === undefined || list.includes(id);

    // 第1区分: Sev1・Sev2
    if (!records.defects?.present) {
      stop('第1区分', 'unmeasurable', `${DEFECT_FILE} が無く、Sev1・Sev2 の AI 起因を確かめられない`);
    } else {
      for (const d of records.defects.rows ?? []) {
        if (!['Sev1', 'Sev2'].includes(d.severity)) continue;
        const unregD = unregisteredIdsOf(d.changeTypes);
        if (!unregD.length && !applies(d.changeTypes)) continue;
        // 停止に数えるのは、出荷の後に発生した事象(事後検証の対象)だけである。出荷前のゲートで検出した欠陥は数えない(突合 X-6)
        if (d.phase === '出荷前') continue;
        if (isRealDay(d.date) && !notAfter(d.date)) continue;
        const cause = String(d.aiCause ?? '').trim();
        if (cause === 'なし') continue;
        const ai = cause === 'あり';
        const phaseNote = d.phase === '運用' ? '' : '。検出の時点が空欄のため、運用の事象として数える';
        const label = `${d.id || '(ID なし)'} ${d.severity}(AI 起因: ${cause || '空欄'}${phaseNote})`;
        // 登録外の ID の行は空欄と同じ扱い。機械は書き誤りと種別の取り下げを見分けられないため、戻し方を理由に書く
        const unregDText = unregD.length ? `。この行の変更種別の列に登録の一覧に無い ID「${unregD.join('・')}」があり、空欄と同じ扱い(すべての種別を止める)にしている。書き誤りなら直す。${cause === 'あり' ? '取り下げた種別の行なら、残りの種別は事象の日より後の登録の判定で戻る' : '取り下げた種別の行でも、原因を特定するまで止まる(特定した後は、残りの種別は事象の日より後の登録の判定で戻る)'}。行の記録は書き換えない` : '';
        if (!ai) {
          // 原因を特定できない事象は、原因を特定する(AI 起因を「あり」か「なし」にする)まで止める。登録し直しでは解かない(N-6 の5。突合 X-3)
          stop('第1区分', 'cause-unknown', `${label}${isRealDay(d.date) ? `が ${d.date} に発生し、` : '。'}原因を特定できていない。特定できない事象を AI 起因でないものとして扱わない。原因を特定するまで止める${unregDText}`);
        } else if (!isRealDay(d.date)) {
          stop('第1区分', 'downgrade', `${label}。発生日が無く、登録の判定との前後を確かめられない${unregDText}`);
        } else if (!(registeredAt && registeredAt > d.date)) {
          stop('第1区分', 'downgrade', `${label}が ${d.date} に発生した。事象の日より後の登録の判定まで止める${unregDText}`);
        }
      }
    }

    // 第1区分: コア機能の理解保持者数
    if (!records.core?.present) {
      stop('第1区分', 'unmeasurable', `${HANDOVER_FILE} が無く、コア機能の理解保持者数を確かめられない`);
    } else if (!(records.core.rows ?? []).length) {
      stop('第1区分', 'unmeasurable', `${HANDOVER_FILE} の節2 にコア機能の記載が無く、理解保持者数を確かめられない`);
    } else {
      const coreHistory = records.core.history ?? { available: false, reason: '引き継ぎ文書の履歴を渡していない' };
      for (const c of records.core.rows) {
        const unregistered = unregisteredIdsOf(c.changeTypes);
        if (!unregistered.length && !applies(c.changeTypes)) continue;
        const unregisteredText = unregistered.length ? `。関わる登録した変更種別に登録の一覧に無い ID「${unregistered.join('・')}」があるため、空欄と同じ扱い(すべての種別を止める)にしている` : '';
        if ((Number(c.holders) || 0) <= 1) {
          stop('第1区分', 'downgrade', `コア機能「${c.name}」の理解保持者数が ${Number(c.holders) || 0} 名(1名以下)である${unregisteredText}`);
        } else if (!coreHistory.available) {
          // 保持者が1名以下だった時点を履歴から確かめられない。登録の判定の後に回復したかを判定できない(突合 X-2)
          stop('第1区分', 'unmeasurable', `${HANDOVER_FILE} の履歴を読めず(${coreHistory.reason ?? '理由の記録なし'})、コア機能「${c.name}」の理解保持者数が1名以下だった時点を確かめられない`);
        } else if (c.lowUntil && !(registeredAt && registeredAt > c.lowUntil)) {
          // 保持者数が回復しても、回復の後の登録の判定があるまで戻さない(5.4.6 の後段。突合 X-2)
          stop('第1区分', 'downgrade', `コア機能「${c.name}」の理解保持者数は ${c.lowUntil} まで1名以下だった。回復の後の登録の判定まで止める`);
        }
      }
    }

    // 第2区分: 差し戻し率
    let rejection = null;
    if (!records.history?.available) {
      stop('第2区分', 'unmeasurable', `既定ブランチの履歴を読めない(${records.history?.reason ?? '理由の記録なし'})。差し戻し率を判定できない`);
    } else {
      const own = changes.filter((c) => changeInType(config, id, c.files));
      const ownRefs = new Set(own.map((c) => c.ref));
      const ownRejections = cited.filter((r) => {
        const c = changeOfTarget(changes, r.target);
        return c && ownRefs.has(c.ref);
      });
      // 種別の範囲に入る変更の PR に対する、宣言行の無い CHANGES_REQUESTED
      const ownUndeclared = undeclaredAll === null ? null : undeclaredAll.filter((r) => {
        const c = changeOfTarget(changes, r.target);
        return c && ownRefs.has(c.ref);
      });
      // 評価の日ごとに、その日に効く窓を当てる(記録した日 < 評価の日。前の評価の日へ遡って当てない)
      const count = (m, months) => {
        const w = windowOf(m, months);
        const inW = (d) => d >= w.from && d <= w.to;
        return { ...w, n: own.filter((c) => inW(c.date)).length, rejected: ownRejections.filter((r) => inW(r.date)).length, undeclared: ownUndeclared === null ? null : ownUndeclared.filter((r) => inW(r.date)).length };
      };
      // 現在の状態は、直近の評価の日(monthStart(asOf))に効く窓で数える。窓を長くした日から次の評価の日までは前の値で数え、
      // 判定不能の停止も残る(記録した日より後の評価の日から当てる。窓の効く日を差し戻し率と手戻り率で揃える)
      const latest = count(monthStart(asOf), observationWindowAt(config, monthStart(asOf)));
      latest.windowText = windowLengthText(observationWindowInfo(config, monthStart(asOf)), observationWindowPending(config, monthStart(asOf)));
      latest.state = latest.n < MIN_SAMPLE ? '判定不能' : latest.rejected === 0 ? '0%' : '判定可能';
      rejection = latest;
      // 登録より後の評価の日ごとに、0% の窓を探す
      if (registeredAt) {
        for (let m = addMonths(monthStart(registeredAt), 1); m <= monthStart(asOf); m = addMonths(m, 1)) {
          const w = count(m, observationWindowAt(config, m));
          if (w.n >= MIN_SAMPLE && w.rejected === 0) {
            stop('第2区分', 'downgrade', `${m} の評価(窓 ${w.from}〜${w.to}、変更 ${w.n} 件)で、判定基準の番号を引いた差し戻しが0件だった(差し戻し率0%の${w.months}か月継続。観測の窓 ${w.months}か月。${undeclaredText(w.undeclared)})`);
            break;
          }
        }
      }
      if (latest.n < MIN_SAMPLE) {
        stop('第2区分', 'unmeasurable', `差し戻し率の窓(${latest.from}〜${latest.to})の変更が ${latest.n} 件で、最小標本数 ${MIN_SAMPLE} 件に満たない(判定不能。0% の継続は判定しない。適用の条件の欠落として止める)`);
      }
    }
    // 第2区分: 手戻り率(差し戻し率と同じ評価の日・同じ窓。記録は評価の日の前日以前だけで数える)
    let rework = null;
    const rr = records.rework;
    if (!records.history?.available) {
      rework = { state: '読めない', reason: `既定ブランチの履歴を読めない(${records.history?.reason ?? '理由の記録なし'})` };
      const shallow0 = /浅い|shallow/i.test(rework.reason) ? '。浅い取得のときは fetch-depth: 0 で取得する' : '';
      stop('第2区分', 'unmeasurable', `手戻り率の記録を読めない(${rework.reason}${shallow0})。判定できないものとして止める`);
    } else if (!rr || !rr.available) {
      rework = { state: '読めない', reason: rr?.reason ?? '手戻り率の記録(トレーラと実装計画の履歴)を渡していない' };
      const shallow = /浅い|shallow/i.test(rework.reason) ? '。浅い取得のときは fetch-depth: 0 で取得する' : '';
      stop('第2区分', 'unmeasurable', `手戻り率の記録を読めない(${rework.reason}${shallow})。判定できないものとして止める`);
    } else {
      const reworkAt = (m) => {
        const c = reworkCount(config, id, rr, m, observationWindowAt(config, m));
        const b = reworkBaselineInfo(config, m);
        const state = c.n < MIN_SAMPLE ? '判定不能' : b.percent === null ? '基準値未設定' : c.numerator * 100 > b.percent * c.n ? '基準値超過' : '基準値以内';
        return { ...c, baseline: b.percent, baselineBy: b.decidedBy, baselineAt: b.recordedAt, state };
      };
      rework = reworkAt(monthStart(asOf));
      rework.pendingBaseline = pendingBaselineOf(config, monthStart(asOf));
      if (rework.state === '判定不能') {
        stop('第2区分', 'unmeasurable', `手戻り率の窓(${rework.from}〜${rework.to})の母数が ${rework.n} 件で、最小標本数 ${MIN_SAMPLE} 件に満たない(判定不能。適用の条件の欠落として止める)。両方の窓が判定可能になった評価の日に、判定を待たずに戻る。母数が貯まらないなら観測の窓を長くする(種別 settings。緩める向きの決定者の記名と理由)`);
      } else if (rework.state === '基準値未設定') {
        const pb = rework.pendingBaseline;
        const pbText = pb ? `。記録済みの基準値 ${pb.percent}%(記録した日 ${pb.recordedAt})は、次の評価の日 ${pb.effectiveFrom} から効く(記録し直さなくてよい)` : '';
        stop('第2区分', 'unmeasurable', `評価の日 ${monthStart(asOf)} に効く手戻り率の基準値が無い(適用の条件の欠落として止める)${pbText}。${pb ? '' : '種別 settings で基準値を記録すると、'}記録した日より後の評価の日(次は ${addMonths(monthStart(asOf), 1)})から戻る`);
      }
      if (registeredAt) {
        for (let m = addMonths(monthStart(registeredAt), 1); m <= monthStart(asOf); m = addMonths(m, 1)) {
          const w = reworkAt(m);
          if (w.state === '基準値超過') {
            stop('第2区分', 'downgrade', `${m} の評価(窓 ${w.from}〜${w.to}、母数 ${w.n} 件のうち手戻り ${w.numerator} 件 = ${ratioText(w)})で、手戻り率が基準値 ${w.baseline}% を超えた。評価の日より後の登録の判定まで止める`);
            break;
          }
        }
      }
    }
    // 窓の長さは、履歴を読めないときも出す(rejection が null でも)
    const windowText = asOf ? windowLengthText(observationWindowInfo(config, monthStart(asOf)), observationWindowPending(config, monthStart(asOf))) : windowLengthText({ months: WINDOW_MONTHS, longer: false });
    out.types.push({ id, registeredAt, level: stops.length ? 'L1' : 'L3', stops, rejection, rework, windowText, detectionFilled: detectionFilled(t?.basis), enforcementFilled: enforcementFilled(t?.basis) });
  }
  return out;
}

/** 種別の停止を1行の文にする(表示に使う) */
export function stopsText(type) {
  if (!type.stops.length) return 'なし';
  return type.stops.map((s) => `${STOP_KIND[s.kind] ?? s.kind}: ${s.reason}`).join(' / ');
}

/** 差し戻し率の窓を1行の文にする。判定不能を「異常なし」と書かない */
export function rejectionText(type) {
  const r = type.rejection;
  if (!r) return `判定できない(履歴を読めない)(${type.windowText})`;
  const head = `窓 ${r.from}〜${r.to}: 変更 ${r.n} 件、差し戻し ${r.rejected} 件(${r.windowText ?? `観測の窓 ${r.months ?? WINDOW_MONTHS}か月`})`;
  const und = `。${undeclaredText(r.undeclared)}`;
  return r.state === '判定不能' ? `${head}。判定不能(0% の継続は判定しない。適用の条件の欠落として止める。最小標本数 ${MIN_SAMPLE} 件に満たない)${und}` : `${head}(${r.state})${und}`;
}

// ---------------------------------------------------------------- 手戻り率(第5章 5.4.6。process-compass #348)

/** トレーラの1行(trim した後)が `Spec: F-NNN / Task-N` の形なら `F-NNN/Task-N`、そうでなければ null。手戻り率と次の一手の済みのタスクが共有する唯一の定義 */
export function specTaskOfLine(line) {
  const m = /^Spec:\s*(F-\d+)\s*\/\s*(Task-\d+)\s*$/.exec(String(line ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** 本文の末尾の段落(check-pr.mjs の lastParagraph と同じ読み方)のうち、`Spec:` で始まる行(trim した後)。値の形は問わない */
export function specLinesOf(body) {
  return lastParagraph(body).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('Spec:'));
}

/** 本文の末尾の段落のトレーラ `Spec: F-NNN / Task-N` を、`F-NNN/Task-N` の形で重複なく取り出す */
export function specTrailersOf(body) {
  return [...new Set(specLinesOf(body).map(specTaskOfLine).filter(Boolean))];
}

/**
 * 1つのコミットの差分(git の -p の出力)から、実装計画(specs/<機能>/plan.md)の追加された行のうち、状態が「やり直し」のタスクを
 * `F-NNN/Task-N` の形で取り出す。履歴の各版を読むため、のちに「着手」「完了」へ進んだ行や、行ごと消された版の後でも、
 * 「やり直し」だった事実は消えない
 */
export function planReworkTasks(patch) {
  const out = new Set();
  let feature = null;
  for (const raw of String(patch ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('+++ ')) {
      feature = /^\+\+\+ b\/specs\/(F-\d+)[^/]*\/plan\.md$/.exec(line)?.[1] ?? null;
      continue;
    }
    if (!feature || !line.startsWith('+|')) continue;
    const cells = line.slice(1).trim().replace(/^\||\|$/g, '').split('|').map((c) => clean(c));
    if (cells.length < 2 || !/^Task-\d+$/.test(cells[0])) continue;
    if (nfkc(cells[cells.length - 1]) === 'やり直し') out.add(`${feature}/${cells[0]}`);
  }
  return [...out];
}

/** 比の文。母数が 0 のときは出さない */
function ratioText(c) {
  return c.n > 0 ? `${((c.numerator * 100) / c.n).toFixed(1)}%` : '—';
}

/**
 * 評価の日 m の窓(months か月)の手戻りの数。records.rework は readReworkRecords と同じ形:
 *   trailers [{ ref, date, tasks: ['F-001/Task-1'], files: [..] }]  既定ブランチの第1親の履歴の、トレーラ Spec を持つ取り込み
 *   plan     [{ date, task }]                                       実装計画の履歴の版のうち、状態が「やり直し」だったタスク
 * 母数: 窓の中に、登録した種別の範囲に入る取り込みの変更を持つタスク。分子: そのうち (1) 評価の日の前日以前に、同じタスクを指す
 * トレーラの取り込みが2つ以上ある、(2) 評価の日の前日以前の計画表の版のいずれかで「やり直し」だった、のどちらか(和。重複は1つ)
 */
function reworkCount(config, typeId, rr, m, months) {
  const w = windowOf(m, months);
  const inW = (d) => d >= w.from && d <= w.to;
  const upto = (d) => isRealDay(d) && d <= w.to;
  const byTask = new Map();
  for (const c of rr.trailers ?? []) {
    if (!upto(c.date)) continue;
    for (const task of c.tasks ?? []) {
      const e = byTask.get(task) ?? { commits: 0, own: false };
      e.commits += 1;
      if (inW(c.date) && changeInType(config, typeId, c.files)) e.own = true;
      byTask.set(task, e);
    }
  }
  const planTasks = new Set((rr.plan ?? []).filter((p) => upto(p.date)).map((p) => p.task));
  let n = 0;
  let trailer = 0;
  let plan = 0;
  let both = 0;
  for (const [task, e] of byTask) {
    if (!e.own) continue;
    n += 1;
    const t = e.commits >= 2;
    const p = planTasks.has(task);
    if (t && p) both += 1;
    else if (t) trailer += 1;
    else if (p) plan += 1;
  }
  return { ...w, n, numerator: trailer + plan + both, trailer, plan, both };
}

/**
 * 手戻り率を1行の文にする(/pit の注記と保証の開示の項目3)。算出した値・母数・分子の内訳・基準値・判定の状態を出し、
 * 判定不能と基準値の未設定を「異常なし」と書かない。数えていない残りは、読めないときも含めて常に出す
 */
export function reworkText(type) {
  const body = reworkTextBody(type);
  const basis = detectionBasisText(type);
  return basis ? `${body}。${basis}` : body;
}

/** 評価の日 day にまだ効いていない記録済みの基準値(recordedAt が day 以後で最後の、値のある記録)。無ければ null。config.mjs は変えず、ここで履歴を読む */
function pendingBaselineOf(config, day) {
  const h = Array.isArray(config?.reworkBaseline?.history) ? config.reworkBaseline.history : [];
  let e = null;
  for (const x of h) {
    if (typeof x?.percent === 'number' && Number.isFinite(x.percent) && x.percent >= 0 && x.percent <= 100 && isRealDay(x?.recordedAt) && String(x.recordedAt) >= String(day)) e = x;
  }
  return e ? { percent: e.percent, recordedAt: String(e.recordedAt), effectiveFrom: addMonths(monthStart(String(e.recordedAt)), 1) } : null;
}

function reworkTextBody(type) {
  const r = type.rework;
  if (!r) return `手戻り率: 判定できない(検知の記録を読んでいない)。${REWORK_UNCOUNTED}`;
  if (r.state === '読めない') return `手戻り率: 読めない(${r.reason})。${REWORK_UNCOUNTED}`;
  const head = `手戻り率: 窓 ${r.from}〜${r.to}: 母数 ${r.n} 件(タスク)のうち手戻り ${r.numerator} 件 = ${ratioText(r)}(内訳: トレーラの取り込みが2回以上のみ ${r.trailer} 件 / 計画表の「やり直し」のみ ${r.plan} 件 / 両方 ${r.both} 件)`;
  const pend = r.pendingBaseline ? `。記録済みの基準値 ${r.pendingBaseline.percent}%(記録した日 ${r.pendingBaseline.recordedAt})は、次の評価の日 ${r.pendingBaseline.effectiveFrom} から効く` : '';
  const baseline = r.baseline === null ? `基準値が未設定(適用の条件の欠落として止めている)${pend}` : `基準値 ${r.baseline}%(決定: ${r.baselineBy ?? '記録なし'}、記録した日 ${r.baselineAt ?? '記録なし'})`;
  const state =
    r.state === '判定不能'
      ? `判定不能(適用の条件の欠落として止めている。最小標本数 ${MIN_SAMPLE} 件に満たない)。${baseline}`
      : r.state === '基準値未設定'
        ? baseline
        : r.state === '基準値超過'
          ? `${baseline}を超えている(止める)`
          : `${baseline}以内`;
  return `${head}。${state}。${REWORK_UNCOUNTED}`;
}

// ---------------------------------------------------------------- 記録を読む

const clean =(v) => String(v ?? '').replace(/\*\*/g, '').replace(/`/g, '').trim();
const nfkc = (v) => clean(v).normalize('NFKC');

function readText(rel, root) {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null;
}

function typesOf(cell) {
  const v = nfkc(cell);
  if (/^(なし|無し)$/.test(v)) return [];
  if (!isFilledValue(v)) return null;
  return v
    .split(/[、,，/／]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 欠陥の台帳の表から、Sev1・Sev2 の判定に使う列を読む。AI 起因・発生日・変更種別の列が無い旧い台帳は空欄として読む */
export function parseDefectRows(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => l.trimStart().startsWith('|'));
  if (start < 0) return [];
  const split = (l) => {
    const t = l.trim();
    return t
      .slice(1, t.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => clean(c));
  };
  const header = split(lines[start]).map((h) => nfkc(h));
  const col = (re) => header.findIndex((h) => re.test(h));
  const iSev = col(/重大度/);
  const iAi = col(/AI\s*起因/);
  const iDate = col(/発生日/);
  const iTypes = col(/変更種別/);
  const iPhase = col(/検出の時点/);
  const rows = [];
  for (let i = start + 1; i < lines.length && lines[i].trimStart().startsWith('|'); i++) {
    const l = lines[i].trim();
    if (/^\|[\s|:-]+\|$/.test(l)) continue;
    const r = split(l);
    if (!isFilledValue(r[0]) && !isFilledValue(r[1])) continue;
    const sev = iSev >= 0 ? nfkc(r[iSev]).match(/Sev\s*([123])/i) : null;
    const ai = iAi >= 0 ? nfkc(r[iAi]) : '';
    rows.push({
      id: r[0],
      severity: sev ? `Sev${sev[1]}` : null,
      date: iDate >= 0 ? (nfkc(r[iDate]).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null) : null,
      // 「あり」「なし」「特定できない」のいずれか。それ以外の記入(空欄を含む)は「特定できない」と同じく扱う
      aiCause: /^あり$/.test(ai) ? 'あり' : /^なし$/.test(ai) ? 'なし' : /特定できない/.test(ai) ? '特定できない' : '',
      changeTypes: iTypes >= 0 ? typesOf(r[iTypes]) : null,
      // 検出の時点(出荷前 / 運用)。空欄と列の無い旧い台帳は ''(運用として数え、その旨を表示する)
      phase: iPhase >= 0 ? (/出荷前/.test(nfkc(r[iPhase])) ? '出荷前' : /運用/.test(nfkc(r[iPhase])) ? '運用' : '') : '',
    });
  }
  return rows;
}

/** 判定記録の様式に載っている例の文(差し戻しの理由の書き方の例)。判定基準の番号の引用に数えない */
const TEMPLATE_EXAMPLE = '項目2を満たしていません。受入基準3に対応するテストが見つかりません。';

/** G-6 の判定記録から、差し戻しの日・対象・判定基準の番号を引いているかを読む。G-6 の差し戻しでなければ null */
export function parseRejection(text, file = null) {
  const t = String(text ?? '');
  const cell = (key) => t.match(new RegExp(`^\\|\\s*${key}\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'm'))?.[1]?.trim() ?? '';
  if (!/^G-6\b/.test(nfkc(cell('ゲート')))) return null;
  if (nfkc(cell('結果')) !== '差し戻し') return null;
  const date = nfkc(cell('判定日時')).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const lines = t.split('\n');
  const start = lines.findIndex((l) => /^##\s*差し戻し/.test(l));
  let reason = '';
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (/^##\s/.test(l)) break;
      reason += `${l}\n`;
    }
  }
  reason = reason.replace(/<!--[\s\S]*?-->/g, '').split(TEMPLATE_EXAMPLE).join('');
  const cited = /(項目|基準)\s*\d+/.test(reason.normalize('NFKC'));
  return { file, date, target: cell('対象'), cited };
}

/**
 * 承認レビューの写しから、レビューを媒体とした G-6 の差し戻しの判定を読む(標準 第4章 G-6「承認レビューを判定記録とする条件」)。
 * 宣言行(`G-6: 差し戻し / 基準 N`)を持つレビューだけを数える。宣言行の無いレビューは判定に数えない(様式の差し戻しと同じく、
 * 判定記録の無い差し戻しは数えない)。cited は宣言行が満たさない基準の項目番号を引いているか。
 * copies は [{ file, copy }]。同じ PR に複数の判定者の差し戻しがあれば、判定者ごとに数える(様式が判定者ごとに1件であるのと同じ)
 */
export function rejectionsFromReviewCopies(copies) {
  const out = [];
  for (const { file, copy } of copies ?? []) {
    const pr = copy?.pr ?? String(file ?? '').match(/pr-(\d+)\.json$/)?.[1] ?? null;
    for (const j of judgementsFromCopy(copy)) {
      if (j.gate !== 'G-6' || j.result !== '差し戻し') continue;
      const t = Date.parse(j.submittedAt ?? '');
      out.push({
        file,
        date: Number.isNaN(t) ? null : localDay(new Date(t)),
        target: pr !== null ? `PR #${pr}` : '',
        cited: j.criteria.length > 0,
        source: 'review',
        // 帰属の照合の入力(写しの値。ホスティングの記録に照らす。process-compass #379)
        pr: pr !== null ? Number(pr) : null,
        reviewId: j.reviewId,
        login: j.login,
        userId: j.userId,
        commitId: j.commitId,
        submittedAt: j.submittedAt,
      });
    }
  }
  return out;
}

/**
 * 承認レビューの写しから、宣言行の無い CHANGES_REQUESTED のレビューを取り出す(process-compass #350)。宣言行の読み方は
 * records.mjs の parseDeclaration だけを使い、読み方を増やさない。宣言行の無いレビューは判定記録ではないため、差し戻し率の分子に
 * 数えない。ここで取り出すのは数えていない件数の表示のためで、分子には入れない
 */
export function undeclaredChangeRequests(copies) {
  const out = [];
  for (const { file, copy } of copies ?? []) {
    const pr = copy?.pr ?? String(file ?? '').match(/pr-(\d+)\.json$/)?.[1] ?? null;
    for (const r of Array.isArray(copy?.reviews) ? copy.reviews : []) {
      if (String(r?.state ?? '').toUpperCase() !== 'CHANGES_REQUESTED') continue;
      if (parseDeclaration(r?.body)) continue;
      const t = Date.parse(r?.submitted_at ?? '');
      out.push({ file, date: Number.isNaN(t) ? null : localDay(new Date(t)), target: pr !== null ? `PR #${pr}` : '', reviewId: r?.id ?? null });
    }
  }
  return out;
}

/** 数えていない差し戻しの要求の件数の文。n が null のときは読めないと出し、0 件と出さない */
export function undeclaredText(n) {
  return n === null || n === undefined
    ? '数えていない差し戻しの要求は読めない(記録用ブランチを読めない)'
    : `数えていない差し戻しの要求 ${n} 件(宣言行が無く判定記録ではない。書き手の名義・席を問わない)`;
}

/** 手元の作業木のリポジトリ(owner/name)。GITHUB_REPOSITORY、無ければ git remote の GitHub の URL。特定できなければ null */
function repoOf(root) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

/**
 * 委任の判定が数える G-6 の差し戻しの記録の帰属(標準 第4章「判定記録を基底ブランチへ入れる操作」の効力を持つ記録。
 * process-compass #379 / ADR-0109 決定4)。数えるのは、判定の時点にホスティングの記録で帰属を確かめたものだけである。
 * 帰属を確かめられない記録(偽の差し戻しを含む)は数えない。数えないことは差し戻し率を下げ、5.4.6 の引き下げの側へ倒れる。
 *   レビューを媒体とする差し戻し: 写しではなく、対象の PR の上のレビュー(hosting.pullOf の REST の記録)で確かめる。レビューの識別子・
 *     書き手の数値の識別子・対象のコミットが写しと一致し、ホスティングの本文の宣言行も G-6 の差し戻しで、書き手が名簿の人(AI・bot・
 *     担い手の専用の名義でなく、書き込みの権限を持つ関係)で、PR の作成者と異なること。G-6 の承認の数え方と対称に、席の責任者に限らない
 *     (突合 M-3)。書き手が名義を共有する場合は、記名者以外で名義を共有していない人の承認を要する(ADR-0107。突合 M-2)
 *   様式の差し戻し: 判定記録の帰属の裏づけ(introducedBacking)。記録用ブランチの様式は様式を足したコミット(hosting.commitOf。署名を
 *     検証した、committer・author とも記名者のコミット)、基底ブランチの様式は今の中身を入れた変更(hosting.prOfCommit)。帰属の確認者を
 *     置けない体制の自己申告は数えない
 * 返り値: { counted: boolean, why }
 */
export function attributeRejection(rej, { config, hosting, text = null, addedSha = null, baseSha = null } = {}) {
  if (!hosting) return { counted: false, why: 'ホスティングの記録を読めない実行(帰属を確かめられない)' };
  if (rej.source === 'review') {
    const pull = rej.pr != null ? hosting.pullOf?.(rej.pr) : null;
    if (!pull || !Array.isArray(pull.reviews)) return { counted: false, why: `PR #${rej.pr ?? '?'} をホスティングで引けない(存在しない PR 番号の写しを含む)` };
    const h = pull.reviews.find((r) => r?.id != null && String(r.id) === String(rej.reviewId));
    if (!h) return { counted: false, why: `レビュー ${rej.reviewId ?? '(id なし)'} がホスティングの記録に無い(写しにだけあるレビュー)` };
    const hId = numericAccountId(h.user?.id ?? null);
    if (hId === null || hId !== numericAccountId(rej.userId ?? null)) return { counted: false, why: `レビュー ${rej.reviewId} の書き手の数値の識別子が、ホスティングの記録と一致しない、または読めない` };
    if ((h.commit_id ?? h.commitId ?? null) !== (rej.commitId ?? null)) return { counted: false, why: `レビュー ${rej.reviewId} の対象のコミットが、ホスティングの記録と一致しない` };
    const d = parseDeclaration(h.body);
    if (!d || d.gate !== 'G-6' || d.result !== '差し戻し') return { counted: false, why: `レビュー ${rej.reviewId} のホスティングの本文の宣言行が G-6 の差し戻しでない` };
    const login = h.user?.login ?? null;
    if (String(h.user?.type ?? '') === 'Bot' || aiNameBlocked(config, login)) return { counted: false, why: `書き手 @${login ?? '?'} が AI・bot の名義` };
    const who = identifyAccount(config, { login, id: hId });
    if (!who.person || who.person.appointer === true) return { counted: false, why: `書き手 @${login ?? '?'} が人の名簿の人へ対応づかない${who.problem ? `(${who.problem})` : ''}` };
    // 書き込みの権限を持たない関係のアカウントのレビューは数えない(G-6 の承認の数え方と対称。IMPL-0425。突合 M-3)
    if (hasWriteAssociation(h) === false) return { counted: false, why: `書き手 @${login} のリポジトリとの関係が ${h.author_association}(書き込みの権限を持たない)` };
    if (dedicatedSeatOf(config, { login, id: hId })) return { counted: false, why: `書き手 @${login} が AI の担い手の専用の名義` };
    const authorId = numericAccountId(pull.author?.id ?? null);
    if (authorId === null || authorId === hId) return { counted: false, why: authorId === null ? `PR #${rej.pr} の作成者を読めない` : `書き手 @${login} が PR #${rej.pr} の作成者である` };
    // 名義の共有(標準 第3章 3.5.3、ADR-0107。突合 M-2): 書き手が AI の担い手と名義を共有する場合、書き手のアカウントの操作だけでは
    // 帰属に数えない。記名者以外で名義を共有していない人の承認(帰属の確認。対象の PR の上の承認)を要する。確認者を置けない体制の
    // 自己申告は数えない
    const sh = signerSharing(config, who.person);
    if (sh) {
      const confirmer = pull.reviews.some((r) => {
        if (String(r?.state ?? '').toUpperCase() !== 'APPROVED' || String(r?.user?.type ?? '') === 'Bot' || hasWriteAssociation(r) === false) return false;
        const rid = numericAccountId(r?.user?.id ?? null);
        if (rid === null || rid === hId || rid === authorId) return false;
        const p = identifyAccount(config, { login: r?.user?.login ?? '', id: rid }).person;
        return Boolean(p) && p.appointer !== true && p.id !== who.person.id && !sharingOf(config, p) && !aiNameBlocked(config, r?.user?.login ?? '');
      });
      if (!confirmer) return { counted: false, why: `書き手 ${who.person.name} は AI の担い手と名義を共有し、記名者以外で名義を共有していない人の承認(帰属の確認)が PR #${rej.pr} に無い${sh.confirmable ? '' : '(確認者を置けない体制の自己申告は数えない)'}` };
    }
    return { counted: true, why: null };
  }
  const name = text !== null ? judgeOfForm(text) : null;
  const signer = name ? resolveSigner(config, name) : null;
  if (!signer) return { counted: false, why: `判定者 "${name ?? '未記入'}" が人の名簿の人へ対応づかない` };
  const info = addedSha ? hosting.commitOf?.(addedSha) : baseSha ? hosting.prOfCommit?.(baseSha) : null;
  const b = introducedBacking(config, signer, info, { what: '差し戻しの判定記録' });
  if (b.backed && !b.selfAttested) return { counted: true, why: null };
  return { counted: false, why: b.backed ? `記名が自己申告(${b.note})` : b.why };
}

/**
 * G-6 の差し戻しの判定記録を、4つの置き場から読む。様式は docs/gates/ と記録用ブランチの records/gates/(同じファイル名は
 * 1件に数える。ship-evidence.yml は basename のまま複製する)。写しは記録用ブランチの records/reviews/ と基底ブランチの
 * docs/records/reviews/(同じ PR 番号は1件に数える。記録用ブランチを優先する)。記録用ブランチを読めなければ、その旨を notes へ出す。
 * config を渡すと、各記録の帰属を attributeRejection で確かめ、確かめたものだけを rejections に入れる(数えなかったものは
 * unattributed と notes に件数を出す)。hosting を省くと、gh(GITHUB_REPOSITORY または git remote のリポジトリ)で引く。
 * config を渡さない呼び出し(試験の読み取りの確認)は、帰属を確かめずに返す
 */
export function readRejectionRecords({ root = ROOT, fetch = true, branch = null, config = null, hosting = undefined } = {}) {
  const notes = [];
  const rejections = [];
  const unattributed = [];
  const forms = new Map();
  const dir = path.join(root, GATES_DIR);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) forms.set(f, { file: `${GATES_DIR}/${f}`, text: fs.readFileSync(path.join(dir, f), 'utf8'), base: true });
  }
  let rb = branch;
  if (!rb) {
    try {
      rb = readRecordsBranch({ cwd: root, fetch });
    } catch (e) {
      rb = { available: false, reason: `記録用ブランチを読めない(${String(e.message).split('\n')[0]})`, reviews: new Map(), gates: [] };
    }
  }
  const copies = new Map();
  const baseDir = path.join(root, BASE_COPIES_DIR);
  if (fs.existsSync(baseDir)) {
    for (const f of fs.readdirSync(baseDir).filter((x) => x.endsWith('.json')).sort()) {
      const file = `${BASE_COPIES_DIR}/${f}`;
      const { copy, prNumber } = parseCopy(file, fs.readFileSync(path.join(baseDir, f), 'utf8'));
      if (copy) copies.set(prNumber, { file, copy });
    }
  }
  if (rb?.available) {
    for (const g of rb.gates ?? []) {
      const base = g.file.split('/').pop();
      if (!forms.has(base)) forms.set(base, { file: g.file, text: g.text, addedSha: g.added?.hash ?? null });
    }
    for (const [n, copy] of rb.reviews ?? []) copies.set(n, { file: `${BRANCH_REVIEWS_DIR}/pr-${n}.json`, copy });
  } else {
    notes.push(
      `記録用ブランチを読めないため(${rb?.reason ?? '理由の記録なし'})、G-6 の差し戻しの判定記録は基底ブランチ(${GATES_DIR}/・${BASE_COPIES_DIR}/)だけを数えた。出荷前のレビューを媒体とした差し戻しは数えていない(数え漏れは差し戻し率を下げ、停止の側へ倒れる)`,
    );
  }
  const found = [];
  for (const f of forms.values()) {
    const r = parseRejection(f.text, f.file);
    if (r) found.push({ rej: { ...r, source: 'form' }, form: f });
  }
  for (const r of rejectionsFromReviewCopies([...copies.values()])) found.push({ rej: r, form: null });
  // 宣言行の無い CHANGES_REQUESTED(数えない。件数の表示だけに使う)。記録用ブランチを読めないときは読めないものとする
  const undeclared = { available: Boolean(rb?.available), items: rb?.available ? undeclaredChangeRequests([...copies.values()]) : [] };
  if (!config) return { rejections: found.map((x) => x.rej), unattributed, undeclared, notes };
  const host = hosting === undefined ? (() => { const repo = repoOf(root); return repo ? ghHosting(repo) : null; })() : hosting;
  const gitRun = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  for (const { rej, form } of found) {
    const a = attributeRejection(rej, { config, hosting: host, text: form?.text ?? null, addedSha: form?.addedSha ?? null, baseSha: form?.base ? lastCommitOfFile(gitRun, 'HEAD', form.file) : null });
    if (a.counted) rejections.push(rej);
    else unattributed.push({ file: rej.file, target: rej.target, source: rej.source, why: a.why });
  }
  if (unattributed.length) {
    notes.push(
      `G-6 の差し戻しの記録のうち ${unattributed.length} 件は、帰属をホスティングの記録で確かめられず、差し戻し率に数えていない(${unattributed.slice(0, 3).map((u) => `${u.file}: ${u.why}`).join(' / ')}${unattributed.length > 3 ? ' ほか' : ''})。` +
        '数えないことは差し戻し率を下げ、引き下げの側へ倒れる(第4章「判定記録を基底ブランチへ入れる操作」の効力を持つ記録)'
    );
  }
  return { rejections, unattributed, undeclared, notes };
}

function git(args, root) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

/** 既定ブランチ(作業ツリーの HEAD)の第1親の履歴を、変更ごとに読む。浅い取得では読めないものとする */
export function readHistory({ root = ROOT, since = null, until = null } = {}) {
  try {
    if (git(['rev-parse', '--is-shallow-repository'], root).trim() === 'true') {
      return { available: false, reason: '浅い取得(shallow)で、履歴の全体を読めない', changes: [] };
    }
    const out = git(['log', '--first-parent', '--no-renames', '--format=%x1e%H%x09%cs%x09%s', '--name-only', ...(since ? [`--since=${since}T00:00:00`] : []), ...(until ? [`--until=${until}T23:59:59`] : []), 'HEAD'], root);
    const changes = [];
    for (const block of out.split('\x1e').filter((b) => b.trim())) {
      const [head, ...rest] = block.split('\n');
      const [ref, date, subject] = head.split('\t');
      changes.push({ ref, date, pr: subject?.match(/\(#(\d+)\)\s*$/)?.[1] ?? null, files: rest.map((x) => x.trim()).filter(Boolean) });
    }
    return { available: true, changes };
  } catch (e) {
    return { available: false, reason: `git の履歴を読めない(${String(e.message).split('\n')[0]})`, changes: [] };
  }
}

/**
 * 判定に使う記録を読む。欠陥の台帳、運用引き継ぎ文書の節2(コア機能の理解保持者。数え方は org-assurance の
 * continuityState と同じ)、既定ブランチの履歴、G-6 の差し戻しの判定記録(様式とレビューの写し。readRejectionRecords)
 */
export function readAutonomyRecords({ config, root = ROOT, today = null, fetch = true } = {}) {
  const now = localDay();
  const asOf = today ?? now;
  const past = asOf < now;
  const notes = [];
  const defectText = readText(DEFECT_FILE, root);
  const defects = { present: Boolean(defectText), rows: defectText ? parseDefectRows(defectText) : [] };
  if (past && defectText) {
    notes.push(`${DEFECT_FILE} と G-6 の判定記録は現在の版を読み、${asOf} より後の日付の行を除いた。AI 起因・検出の時点の欄は現在の記入による(評価の時点が異なる)`);
  }

  // コア機能の理解保持者(現在の版、または判定の日の時点の版)と、履歴の各版での保持者数(突合 X-2・X-10)
  const policy = readPolicy(config, { root, today: asOf });
  const versions = readHandoverVersions({ root, until: asOf });
  let currentText = readText(HANDOVER_FILE, root);
  if (past && versions.available) {
    const at = versions.list.filter((v) => v.date <= asOf).pop();
    currentText = at ? at.text : null;
    if (at) notes.push(`${HANDOVER_FILE} は ${asOf} 時点の版(${at.ref.slice(0, 8)})を読んだ`);
  }
  let core = { present: false, rows: [], history: { available: versions.available, reason: versions.reason ?? null } };
  if (currentText) {
    const countsOf = (text, day) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-'));
      try {
        fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(tmp, HANDOVER_FILE), text);
        return continuityState(config, policy, { root: tmp, day }).core ?? [];
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    };
    const current = countsOf(currentText, asOf);
    // 版を古い順に並べ、保持者数が1名以下の版の次に2名以上の版が来た日を、回復の日(lowUntil)とする
    const series = versions.available ? versions.list.filter((v) => v.date <= asOf).map((v) => ({ date: v.date, core: countsOf(v.text, v.date) })) : [];
    series.push({ date: asOf, core: current });
    const lowUntilOf = (name) => {
      let last = null;
      let prevLow = false;
      for (const v of series) {
        const c = v.core.find((x) => x.name === name);
        const low = c ? c.holders.length <= 1 : false;
        if (prevLow && c && !low) last = v.date;
        prevLow = low;
      }
      return last;
    };
    core = {
      present: true,
      rows: current.map((c) => ({ name: c.name, holders: c.holders.length, changeTypes: c.changeTypes ?? null, lowUntil: versions.available ? lowUntilOf(c.name) : null })),
      history: { available: versions.available, reason: versions.reason ?? null },
    };
  }

  const types = Array.isArray(config?.delegation?.changeTypes) ? config.delegation.changeTypes : [];
  const earliest = types
    .map((t) => (isRealDay(t.registeredAt) ? t.registeredAt : null))
    .filter(Boolean)
    .sort()[0];
  // 履歴の読み出しの起点は、記録した最長の窓から導く(窓を長くしても、窓の始まりまで履歴を読む)
  const maxMonths = Math.max(WINDOW_MONTHS, observationWindowAt(config, asOf), ...(Array.isArray(config?.observationWindow?.history) ? config.observationWindow.history.map((e) => (Number.isInteger(e?.months) ? e.months : 0)) : []));
  const latestFrom = addMonths(monthStart(asOf), -maxMonths);
  const firstFrom = earliest ? addMonths(monthStart(earliest), 1 - maxMonths) : latestFrom;
  const history = types.length ? readHistory({ root, since: firstFrom < latestFrom ? firstFrom : latestFrom, until: asOf }) : { available: true, changes: [] };

  // G-6 の差し戻しの判定記録(様式と、レビューを媒体とした判定の写し)。登録した種別が無ければ読まない
  let rejections = [];
  let undeclared = { available: false, items: [] };
  if (types.length) {
    const rr = readRejectionRecords({ root, fetch, config });
    rejections = rr.rejections;
    undeclared = rr.undeclared;
    notes.push(...rr.notes);
  }
  const rework = types.length ? readReworkRecords({ root, until: asOf }) : { available: true, trailers: [], plan: [] };
  // D-0 表10 の F.2 の Q1(IMPL-0919)。判定のたびに読む。構成へ写さない(写すと D-0 と食い違う。ADR-0171 決定4)
  return { asOf, f2q1: readF2Q1({ root }), defects, core, history, rejections, undeclared, rework, notes };
}

/**
 * 手戻り率の記録を読む。既定ブランチの第1親の履歴の全体(until まで。同じタスクを指すトレーラの取り込みが2つ以上かを数えるため、
 * 窓の始まりで切らない)から、トレーラ Spec を持つ取り込みと、実装計画(specs/<機能>/plan.md)の各版で「やり直し」だったタスクを読む。
 * 浅い取得・git でない場合は読めないものとする
 */
export function readReworkRecords({ root = ROOT, until = null } = {}) {
  try {
    if (git(['rev-parse', '--is-shallow-repository'], root).trim() === 'true') {
      return { available: false, reason: '浅い取得(shallow)で、履歴の全体を読めない', trailers: [], plan: [] };
    }
    const untilArgs = until ? [`--until=${until}T23:59:59`] : [];
    const out = git(['log', '--first-parent', '--no-renames', '--format=%x1e%H%x09%cs%n%B%x1f', '--name-only', ...untilArgs, 'HEAD'], root);
    const trailers = [];
    for (const block of out.split('\x1e').filter((b) => b.trim())) {
      const nl = block.indexOf('\n');
      const [ref, date] = block.slice(0, nl).split('\t');
      const [body, files = ''] = block.slice(nl + 1).split('\x1f');
      const tasks = specTrailersOf(body);
      if (tasks.length) trailers.push({ ref, date, tasks, files: files.split('\n').map((x) => x.trim()).filter(Boolean) });
    }
    const patches = git(['log', '--first-parent', '-m', '--no-renames', '--unified=0', '--format=%x1e%H%x09%cs', '-p', ...untilArgs, 'HEAD', '--', 'specs/*/plan.md'], root);
    const plan = [];
    for (const block of patches.split('\x1e').filter((b) => b.trim())) {
      const nl = block.indexOf('\n');
      const [, date] = block.slice(0, nl).split('\t');
      for (const task of planReworkTasks(block.slice(nl + 1))) plan.push({ date, task });
    }
    return { available: true, trailers, plan };
  } catch (e) {
    return { available: false, reason: `git の履歴を読めない(${String(e.message).split('\n')[0]})`, trailers: [], plan: [] };
  }
}

/** 運用引き継ぎ文書の版を、古い順に読む(コミットの日付と本文)。浅い取得・git でない場合は読めないものとする */
export function readHandoverVersions({ root = ROOT, until = null } = {}) {
  try {
    if (git(['rev-parse', '--is-shallow-repository'], root).trim() === 'true') {
      return { available: false, reason: '浅い取得(shallow)で、履歴の全体を読めない', list: [] };
    }
    const out = git(['log', '--format=%H%x09%cs', ...(until ? [`--until=${until}T23:59:59`] : []), 'HEAD', '--', HANDOVER_FILE], root);
    const list = [];
    for (const line of out.split('\n').filter(Boolean).reverse()) {
      const [ref, date] = line.split('\t');
      let text = null;
      try {
        text = git(['show', `${ref}:${HANDOVER_FILE}`], root);
      } catch {
        text = null; // 削除した版
      }
      if (text !== null) list.push({ ref, date, text });
    }
    return { available: true, list };
  } catch (e) {
    return { available: false, reason: `git の履歴を読めない(${String(e.message).split('\n')[0]})`, list: [] };
  }
}

/**
 * 登録した変更種別ごとの注記の文(次の一手と保証の開示の内側で使う)。判定不能を「異常なし」と書かない。
 * external を真にすると、停止の原因を区分だけで示す
 */
export function autonomyNoteLines(state, { external = false } = {}) {
  const out = [];
  for (const t of state.types) {
    const head = `AI自律レベル: 登録した変更種別「${t.id}」は ${t.level}`;
    if (!t.stops.length) {
      out.push(`${head}(停止なし。変更のリスク区分が R1・R2 の変更は、種別が L3 でも委任で進まない(条件2))。差し戻し率: ${rejectionText(t)}。${reworkText(t)}`);
      continue;
    }
    const kinds = [...new Set(t.stops.map((x) => STOP_KIND[x.kind] ?? x.kind))].join('・');
    const why = external ? [...new Set(t.stops.map((x) => x.category))].join('・') : stopsText(t);
    const back = t.stops.some((x) => x.kind === 'downgrade')
      ? '引き下げは、事象・評価・回復の日より後の変更種別の登録の判定(/process-change)で戻る'
      : '適用の条件が戻れば(記録が揃う・判定可能な窓が得られる・原因を特定する)、判定を待たずに戻る';
    out.push(`${head}(委任を止めている。この種別の変更は協働で扱う。${kinds})。原因: ${why}。差し戻し率: ${rejectionText(t)}。${back}。${reworkText(t)}`);
  }
  if (state.unattributedRejections?.length) {
    out.push(`AI自律レベル: 判定基準の番号を引いた G-6 の差し戻しのうち ${state.unattributedRejections.length} 件は、対象(PR・コミット)を既定ブランチの履歴へ対応づけられず、どの変更種別の差し戻し率にも数えていない`);
  }
  for (const u of state.coreUnregistered ?? []) {
    out.push(`AI自律レベル: ${HANDOVER_FILE} の節2 のコア機能「${u.name}」の「関わる登録した変更種別」に、登録の一覧に無い ID「${u.ids.join('・')}」がある(書き誤りの疑い)。この機能は空欄と同じ扱いで、理解保持者数が1名以下のあいだ、すべての登録した変更種別を止める`);
  }
  for (const u of state.defectUnregistered ?? []) {
    out.push(`AI自律レベル: 欠陥の台帳(${DEFECT_FILE})の ${u.id || '(ID なし)'} の「登録した変更種別」に、登録の一覧に無い ID「${u.ids.join('・')}」がある(書き誤りの疑い、または取り下げた種別)。この行は空欄と同じ扱いで、AI 起因の運用の事象なら、すべての登録した変更種別を止める。書き誤りなら直す。AI 起因が「あり」の行で取り下げた種別なら、残りの種別は事象の日より後の登録の判定で戻る(原因を特定できない行は、原因を特定するまで止まる)。行の記録は書き換えない`);
  }
  for (const n of state.notes ?? []) out.push(`AI自律レベル(評価の時点): ${n}`);
  return out;
}
