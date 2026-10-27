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
//     - 差し戻し率: 毎月、直近2か月の窓で評価する。母数は既定ブランチの履歴のうち種別の規則の範囲に入る変更、
//       分子は判定基準の番号を引いた G-6 の差し戻しの判定記録。判定記録は様式(docs/gates/・記録用ブランチの records/gates/)と、
//       レビューを媒体とした判定(記録用ブランチの records/reviews/ と基底ブランチの docs/records/reviews/ の写しの宣言行)の両方を読む。
//       最小標本数(30件)以上で0件の評価は、
//       評価の日より後の登録日まで種別を止める。最新の窓が最小標本数に満たない場合は判定不能とし、
//       判定可能な窓が得られるまで止める(適用の条件の欠落。判定を待たずに戻る)
//     - 手戻り率: 集計しない(降りていない)。表示し続ける
//   登録日(registeredAt)の無い種別は、判定できないものとして止める。上限が L3 未満の構成では、すべての種別を止める
//
// 純粋な関数(autonomyState)と、記録を読む関数(readAutonomyRecords)を分ける。委任の判定(delegation.mjs)は
// 前者だけを使い、フィクスチャで試験できる。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, isFilledValue, isRealDay, matchGlob, NEVER_DELEGATED, localDay } from './config.mjs';
import { evaluate } from '../vendor/tailoring-engine.mjs';
import { continuityState, readPolicy } from './org-assurance.mjs';
import { readRecordsBranch, parseCopy, judgementsFromCopy, REVIEWS_DIR as BRANCH_REVIEWS_DIR } from './records.mjs';

/** 準拠テンプレートが支えるレベル。L2 は上限の値としてだけ現れる */
export const LEVELS = ['L1', 'L2', 'L3'];
export const levelRank = (l) => LEVELS.indexOf(l);
/** 差し戻し率の観測の窓(月)。第5章 5.4.6 の「2か月継続」(EV-0146)。組織の値を構成に持たない */
export const WINDOW_MONTHS = 2;
/** 窓の中の最小標本数(変更の件数)。第4章「閾値の設定と較正」の要求事項3 の初期値 */
export const MIN_SAMPLE = 30;
/** 手戻り率は集計しない。表示し続ける(標準の実装マーク IMPL-0291 は降りていない) */
export const REWORK_UNDELIVERED =
  '手戻り率は集計していない(降りていない)。採用者が登録の根拠 basis.detection.reworkRate に書いた手段で集計し、発火の有無は内部監査で確かめる';

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
};

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
    return 'テーラリングの規則の上限 L2(CL2)は安全関連部の上限である。準拠テンプレートの構成は安全関連部の範囲を持たないため、案件の全体へ掛ける';
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

/** 登録の拒否に使う。上限が L3 未満なら、その理由を返す(準拠テンプレートは L2 を支えないため、登録は L3 の扱い) */
export function capRefusal(config) {
  const cap = autonomyCap(config);
  if (levelRank(cap.level) >= levelRank('L3')) return null;
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

/** 評価の日 m(月初)の窓。[from, m) */
export function windowOf(m) {
  return { from: addMonths(m, -WINDOW_MONTHS), to: prevDay(m), evaluatedAt: m };
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
    window: { months: WINDOW_MONTHS, minSample: MIN_SAMPLE },
    rework: REWORK_UNDELIVERED,
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

  for (const t of types) {
    const id = String(t?.id ?? '').trim();
    if (!id) continue;
    const registeredAt = isRealDay(t.registeredAt) ? t.registeredAt : null;
    const stops = [];
    const stop = (category, kind, reason) => stops.push({ category, kind, reason });
    if (levelRank(cap.level) < levelRank('L3')) stop('上限', 'cap', `AI自律レベルの上限が ${cap.level} である。L3 を適用できない(${cap.reason ?? '理由の記録なし'})`);
    // 登録日の無い種別は、登録の判定と事象・窓の前後を確かめられない(突合 X-9)
    if (!registeredAt) stop('記録', 'unmeasurable', '登録日(registeredAt)が無く、登録の判定と事象・窓の前後を確かめられない。登録が完了していないものとして止める');
    if (!records || !asOf) {
      stop('記録', 'unmeasurable', '検知の記録を読んでいない(判定の日が無い)。判定できないものとして止める');
      out.types.push({ id, registeredAt, level: 'L1', stops, rejection: null });
      continue;
    }
    const applies = (list) => list === null || list === undefined || list.includes(id);

    // 第1区分: Sev1・Sev2
    if (!records.defects?.present) {
      stop('第1区分', 'unmeasurable', `${DEFECT_FILE} が無く、Sev1・Sev2 の AI 起因を確かめられない`);
    } else {
      for (const d of records.defects.rows ?? []) {
        if (!['Sev1', 'Sev2'].includes(d.severity) || !applies(d.changeTypes)) continue;
        // 停止に数えるのは、出荷の後に発生した事象(事後検証の対象)だけである。出荷前のゲートで検出した欠陥は数えない(突合 X-6)
        if (d.phase === '出荷前') continue;
        if (isRealDay(d.date) && !notAfter(d.date)) continue;
        const cause = String(d.aiCause ?? '').trim();
        if (cause === 'なし') continue;
        const ai = cause === 'あり';
        const phaseNote = d.phase === '運用' ? '' : '。検出の時点が空欄のため、運用の事象として数える';
        const label = `${d.id || '(ID なし)'} ${d.severity}(AI 起因: ${cause || '空欄'}${phaseNote})`;
        if (!ai) {
          // 原因を特定できない事象は、原因を特定する(AI 起因を「あり」か「なし」にする)まで止める。登録し直しでは解かない(N-6 の5。突合 X-3)
          stop('第1区分', 'cause-unknown', `${label}${isRealDay(d.date) ? `が ${d.date} に発生し、` : '。'}原因を特定できていない。特定できない事象を AI 起因でないものとして扱わない。原因を特定するまで止める`);
        } else if (!isRealDay(d.date)) {
          stop('第1区分', 'downgrade', `${label}。発生日が無く、登録の判定との前後を確かめられない`);
        } else if (!(registeredAt && registeredAt > d.date)) {
          stop('第1区分', 'downgrade', `${label}が ${d.date} に発生した。事象の日より後の登録の判定まで止める`);
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
        if (!applies(c.changeTypes)) continue;
        if ((Number(c.holders) || 0) <= 1) {
          stop('第1区分', 'downgrade', `コア機能「${c.name}」の理解保持者数が ${Number(c.holders) || 0} 名(1名以下)である`);
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
      const count = (m) => {
        const w = windowOf(m);
        const inW = (d) => d >= w.from && d <= w.to;
        return { ...w, n: own.filter((c) => inW(c.date)).length, rejected: ownRejections.filter((r) => inW(r.date)).length };
      };
      const latest = count(monthStart(asOf));
      latest.state = latest.n < MIN_SAMPLE ? '判定不能' : latest.rejected === 0 ? '0%' : '判定可能';
      rejection = latest;
      // 登録より後の評価の日ごとに、0% の窓を探す
      if (registeredAt) {
        for (let m = addMonths(monthStart(registeredAt), 1); m <= monthStart(asOf); m = addMonths(m, 1)) {
          const w = count(m);
          if (w.n >= MIN_SAMPLE && w.rejected === 0) {
            stop('第2区分', 'downgrade', `${m} の評価(窓 ${w.from}〜${w.to}、変更 ${w.n} 件)で、判定基準の番号を引いた差し戻しが0件だった(差し戻し率0%の2か月継続)`);
            break;
          }
        }
      }
      if (latest.n < MIN_SAMPLE) {
        stop('第2区分', 'unmeasurable', `差し戻し率の窓(${latest.from}〜${latest.to})の変更が ${latest.n} 件で、最小標本数 ${MIN_SAMPLE} 件に満たない(判定不能。発火しない)`);
      }
    }
    out.types.push({ id, registeredAt, level: stops.length ? 'L1' : 'L3', stops, rejection });
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
  if (!r) return '判定できない(履歴を読めない)';
  const head = `窓 ${r.from}〜${r.to}: 変更 ${r.n} 件、差し戻し ${r.rejected} 件`;
  return r.state === '判定不能' ? `${head}。判定不能(発火しない。最小標本数 ${MIN_SAMPLE} 件に満たない)` : `${head}(${r.state})`;
}

// ---------------------------------------------------------------- 記録を読む

const clean = (v) => String(v ?? '').replace(/\*\*/g, '').replace(/`/g, '').trim();
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
      out.push({ file, date: Number.isNaN(t) ? null : localDay(new Date(t)), target: pr !== null ? `PR #${pr}` : '', cited: j.criteria.length > 0, source: 'review' });
    }
  }
  return out;
}

/**
 * G-6 の差し戻しの判定記録を、4つの置き場から読む。様式は docs/gates/ と記録用ブランチの records/gates/(同じファイル名は
 * 1件に数える。ship-evidence.yml は basename のまま複製する)。写しは記録用ブランチの records/reviews/ と基底ブランチの
 * docs/records/reviews/(同じ PR 番号は1件に数える。記録用ブランチを優先する)。記録用ブランチを読めなければ、その旨を notes へ出す
 */
export function readRejectionRecords({ root = ROOT, fetch = true, branch = null } = {}) {
  const notes = [];
  const rejections = [];
  const forms = new Map();
  const dir = path.join(root, GATES_DIR);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) forms.set(f, { file: `${GATES_DIR}/${f}`, text: fs.readFileSync(path.join(dir, f), 'utf8') });
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
      if (!forms.has(base)) forms.set(base, { file: g.file, text: g.text });
    }
    for (const [n, copy] of rb.reviews ?? []) copies.set(n, { file: `${BRANCH_REVIEWS_DIR}/pr-${n}.json`, copy });
  } else {
    notes.push(
      `記録用ブランチを読めないため(${rb?.reason ?? '理由の記録なし'})、G-6 の差し戻しの判定記録は基底ブランチ(${GATES_DIR}/・${BASE_COPIES_DIR}/)だけを数えた。出荷前のレビューを媒体とした差し戻しは数えていない(数え漏れは差し戻し率を下げ、停止の側へ倒れる)`,
    );
  }
  for (const { file, text } of forms.values()) {
    const r = parseRejection(text, file);
    if (r) rejections.push({ ...r, source: 'form' });
  }
  rejections.push(...rejectionsFromReviewCopies([...copies.values()]));
  return { rejections, notes };
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
  const latestFrom = addMonths(monthStart(asOf), -WINDOW_MONTHS);
  const firstFrom = earliest ? addMonths(monthStart(earliest), 1 - WINDOW_MONTHS) : latestFrom;
  const history = types.length ? readHistory({ root, since: firstFrom < latestFrom ? firstFrom : latestFrom, until: asOf }) : { available: true, changes: [] };

  // G-6 の差し戻しの判定記録(様式と、レビューを媒体とした判定の写し)。登録した種別が無ければ読まない
  let rejections = [];
  if (types.length) {
    const rr = readRejectionRecords({ root, fetch });
    rejections = rr.rejections;
    notes.push(...rr.notes);
  }
  return { asOf, defects, core, history, rejections, notes };
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
      out.push(`${head}(停止なし)。差し戻し率: ${rejectionText(t)}。${state.rework}`);
      continue;
    }
    const kinds = [...new Set(t.stops.map((x) => STOP_KIND[x.kind] ?? x.kind))].join('・');
    const why = external ? [...new Set(t.stops.map((x) => x.category))].join('・') : stopsText(t);
    const back = t.stops.some((x) => x.kind === 'downgrade')
      ? '引き下げは、事象・評価・回復の日より後の変更種別の登録の判定(/process-change)で戻る'
      : '適用の条件が戻れば(記録が揃う・判定可能な窓が得られる・原因を特定する)、判定を待たずに戻る';
    out.push(`${head}(委任を止めている。この種別の変更は協働で扱う。${kinds})。原因: ${why}。差し戻し率: ${rejectionText(t)}。${back}。${state.rework}`);
  }
  if (state.unattributedRejections?.length) {
    out.push(`AI自律レベル: 判定基準の番号を引いた G-6 の差し戻しのうち ${state.unattributedRejections.length} 件は、対象(PR・コミット)を既定ブランチの履歴へ対応づけられず、どの変更種別の差し戻し率にも数えていない`);
  }
  for (const n of state.notes ?? []) out.push(`AI自律レベル(評価の時点): ${n}`);
  return out;
}
