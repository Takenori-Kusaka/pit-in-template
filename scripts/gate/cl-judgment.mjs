// 安全重要度(CL)の判定の記録と確認(D-0 の節16。標準 第6章 テンプレ0 表10、第8章 軸E「判定の記録と確認」。
// process-compass #373 / ADR-0113)。
//
// 初期化の回答 q-criticality は仮の判定である。判定の記録と判定者の記名がそろうまで、G-1 の審議を開始しない
// (D-0 の検査 check-d0.mjs が失敗させる。/pit は人の判断待ちとして出す)。確認者の欠落は他の人の手が要るため止めず、
// 未達として表示する(出荷の証跡の集約)。CL1 以上・規制業の案件と、附属書F F.2 の Q1 が「はい」で段3 の確認が欠ける
// 案件は、記載の欠落として出荷させない。
//
// 機械が確かめるもの: 欄の空欄と様式の説明のまま、判定者が記録の時点(判定日)の D-0 表1「体制と運用形態」の決定者で
// あること(構成の履歴から導く。導けなければ注意)、判定者・確認者が AI の名義でないこと、確認者が判定者と別の名簿の人で
// あること、記録した段と求める段の比較、区分を下げる操作の引き下げの根拠(記入と、引く ADR・機能仕様の実在)。
// 確かめないもの: 理由・帰結・F.2 の回答の中身の妥当性、段2 以上の距離そのもの(名簿に直属の上長・法人・部門・
// リリースの権限の欄が無い。#357 / IMPL-0452)
//
// 旧い構成(判定の記録を求める前、CL_RECORD_REQUIRED_SINCE より前に G-1 を通過した案件)は遡って止めない。記録がそろうまで、
// 判定の確認を未達として表示し続ける(legacy)。それ以外の構成の判定の記録と判定者の記名の不備は、G-1 の前は D-0 の検査が、
// G-1 の後は出荷の証跡の集約が欠落として止める(議長の裁定 J-10)。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  isFilledValue,
  resolveSigner,
  nameProblems,
  personName,
  structureDeciderSeat,
  structureDeciderLabel,
  aiNameBlocked,
  readGateRecords,
} from './config.mjs';
import { readRecordsBranch, recordFromForm } from './records.mjs';

/** D-0 の節の見出し(番号の有無に依らず名で読む) */
export const CL_SECTION_HEADING = /^##\s+(?:\d+\.\s*)?安全重要度の判定の記録/;

/** 記録の欄(D-0 節16 の表の「項目」の列)。標準 第6章 テンプレ0 表10 と同じ名 */
export const CL_FIELDS = {
  cls: '判定した区分',
  worst: '対策を入れる前の最悪の帰結',
  notUpper: '1つ上の区分に当たらない理由',
  f2: '附属書F F.2 の回答',
  judge: '判定者',
  judgedAt: '判定日',
  confirmer: '確認者',
  step: '確認者の段',
  stepBasis: '段の根拠',
  confirmedAt: '確認日',
  reduction: '区分の引き下げの根拠',
};

/** 判定者が書ける欄(欠けると G-1 を止める) */
const JUDGE_FIELDS = ['cls', 'worst', 'notUpper', 'f2', 'judge', 'judgedAt'];

const CL_ORDER = ['cl0', 'cl1', 'cl2', 'cl3'];
const CL_LABEL = { cl0: 'CL0', cl1: 'CL1', cl2: 'CL2', cl3: 'CL3' };

/**
 * 確認者に求める段の下限。判定で外れる1つ上の区分が評価者に求める段(第8章 軸E)。
 * CL0 は CL1(段を求めない)を外すため段1、CL1 は CL2 の段2、CL2 は CL3 の段3。CL3 は外れる区分が無いため段1
 */
export const BASE_STEP = { cl0: 1, cl1: 2, cl2: 3, cl3: 1 };

const clean = (v) => String(v ?? '').replace(/\*/g, '').trim();

/** D-0 の本文から節16 の表を読む。節が無ければ present: false */
export function parseClRecord(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => CL_SECTION_HEADING.test(l));
  if (start < 0) return { present: false, values: {}, missingRows: Object.keys(CL_FIELDS) };
  const values = {};
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s/.test(l)) break;
    if (!/^\|/.test(l) || /^\|[\s|:-]+\|?\s*$/.test(l)) continue;
    const cells = l.split('|').slice(1, -1).map((c) => clean(c));
    if (cells.length < 2) continue;
    const key = Object.keys(CL_FIELDS).find((k) => CL_FIELDS[k] === cells[0]);
    if (key && !(key in values)) values[key] = cells.slice(1).join(' | ').trim();
  }
  const missingRows = Object.keys(CL_FIELDS).filter((k) => !(k in values));
  return { present: true, values, missingRows };
}

/** 区分の欄から cl0〜cl3 を1つだけ読む。複数・無しは null */
export function classOf(value) {
  const hits = [...new Set([...String(value ?? '').normalize('NFKC').matchAll(/CL\s*([0-3])/gi)].map((m) => `cl${m[1]}`))];
  return hits.length === 1 ? hits[0] : null;
}

/** F.2 の回答の Q1。先頭の「はい」「いいえ」を読む。読めなければ null */
export function f2Q1Of(value) {
  const s = String(value ?? '').normalize('NFKC').replace(/^Q1\s*[::]?\s*/i, '').trim();
  if (/^いいえ/.test(s)) return false;
  if (/^はい/.test(s)) return true;
  return null;
}

/** 段の欄から 1〜4 を読む。読めなければ null */
export function stepOf(value) {
  const m = String(value ?? '').normalize('NFKC').match(/段\s*([1-4])/);
  return m ? Number(m[1]) : null;
}

const isUnmetText = (v) => /^未達/.test(clean(v));

/**
 * 確認者に求める段(下限と引き上げ)。判定の結果に依らない入力で引き上げる(第8章 軸E)
 *   - 附属書F F.2 の Q1 が「はい」: 段3
 *   - 規制業の候補(構成の品質要求が規制業): 少なくとも段2
 */
export function requiredStep(cls, { f2q1 = null, regulated = false } = {}) {
  const reasons = [];
  let step = BASE_STEP[cls] ?? 1;
  reasons.push(`${CL_LABEL[cls] ?? '区分不明'} の判定で外れる区分の段(段${step})`);
  if (regulated && step < 2) {
    step = 2;
    reasons.push('規制業の候補に当たる(段2 以上)');
  }
  if (f2q1 === true && step < 3) {
    step = 3;
    reasons.push('附属書F F.2 の Q1 が「はい」(段3)');
  }
  return { step, reasons };
}

function g1PassedIn(gateRecords) {
  return (gateRecords ?? []).some((r) => /^G-1(?!\d)/.test(r.gate ?? '') && r.result === '通過');
}

/**
 * 判定の記録を求めた日(ADR-0113 の採用日)。この日より前に G-1 を通過した構成だけを旧い構成として扱い、判定の記録の欠落を
 * 未達として表示する(議長の裁定 J-10)。この日以後に G-1 を通過した構成と、G-1 の判定日時を読めない構成は、旧い構成に数えない
 */
export const CL_RECORD_REQUIRED_SINCE = '2026-11-05';

/** G-1 を、判定の記録を求める前(CL_RECORD_REQUIRED_SINCE より前の判定日時)に通過したか */
function g1PassedBeforeRule(gateRecords) {
  return (gateRecords ?? []).some((r) => {
    if (!/^G-1(?!\d)/.test(r.gate ?? '') || r.result !== '通過') return false;
    const d = String(r.judgedAt ?? '').normalize('NFKC').match(/(\d{4})-(\d{2})-(\d{2})/);
    return Boolean(d) && `${d[1]}-${d[2]}-${d[3]}` < CL_RECORD_REQUIRED_SINCE;
  });
}

/**
 * 判定日の時点の D-0 表1「体制と運用形態」の決定者(構成の履歴から導く。議長の裁定 J-12、ADR-0111 決定6 と同じ原則)。
 * 判定日の終わりまでに process.config.json を最後に変えたコミットの構成を読む。導けなければ null(理由つき)
 */
export function deciderAt(root, date) {
  const d = String(date ?? '').normalize('NFKC').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return { person: null, why: `判定日(${date ?? '未記入'})を日付として読めない` };
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const rev = git(['log', '-1', '--format=%H', `--until=${d[1]}-${d[2]}-${d[3]} 23:59:59`, '--', 'process.config.json']);
  if (!rev) return { person: null, why: `判定日 ${d[0]} までに構成(process.config.json)を記録したコミットが無い` };
  const text = git(['show', `${rev}:process.config.json`]);
  let cfg = null;
  try {
    cfg = JSON.parse(text);
  } catch {
    return { person: null, why: `判定日の時点の構成(${rev.slice(0, 8)})を読めない` };
  }
  const seat = (cfg.seats ?? []).find((s) => s.role === structureDeciderSeat(cfg));
  const person = seat?.accountable ? resolveSigner(cfg, seat.accountable) : null;
  if (!person) return { person: null, why: `判定日の時点の構成(${rev.slice(0, 8)})に決定者の席の責任者が無い` };
  return { person, config: cfg, rev, why: null };
}

/**
 * 判定の記録と確認の状態。
 *   text: D-0 の本文(null は D-0 が無い)。gateRecords: readGateRecords() の結果
 * 返す値:
 *   present / values / cls / f2q1
 *   recordProblems: 判定者が書ける欄の欠落・記名の不備・区分の食い違い(G-1 の前は D-0 の検査を失敗させる)
 *   confirmation: { ok, required, reasons, recorded, effective, unmet: [理由] }
 *   g1Passed / legacy(G-1 を通過済みで記録に不備がある旧い構成。遡って止めない)
 *   shipBlocking: 確認の欠落を記載の欠落に数えるか(CL1 以上・規制業、または F.2 の Q1 が「はい」で段3 が欠ける)
 */
export function clJudgmentState(config, { text = null, gateRecords = [], root = null } = {}) {
  const parsed = text === null ? { present: false, values: {}, missingRows: Object.keys(CL_FIELDS) } : parseClRecord(text);
  const v = parsed.values;
  const answer = config?.answers?.['q-criticality'] ?? null;
  const regulated = config?.answers?.['q-quality'] === 'quality-regulated';
  const g1Passed = g1PassedIn(gateRecords);
  const recordProblems = [];

  if (text === null) recordProblems.push('D-0(docs/D-0-governance.md)が無く、安全重要度の判定の記録を読めない');
  else if (!parsed.present) {
    recordProblems.push(
      'D-0 に「安全重要度の判定の記録」の節がありません。templates/00-d0-governance.md の節16 を写し、判定者(D-0 表1「体制と運用形態」の決定者)が記入します(標準 第6章 テンプレ0 表10、第8章 軸E)'
    );
  } else {
    for (const k of JUDGE_FIELDS) {
      if (!(k in v)) recordProblems.push(`安全重要度の判定の記録に欄「${CL_FIELDS[k]}」がありません(templates/00-d0-governance.md の節16 から写す)`);
      else if (!isFilledValue(v[k])) recordProblems.push(`安全重要度の判定の記録の「${CL_FIELDS[k]}」が未記入です(空欄、または様式の説明 <…> のまま)`);
    }
  }

  const cls = parsed.present && isFilledValue(v.cls) ? classOf(v.cls) : null;
  if (parsed.present && isFilledValue(v.cls) && !cls) recordProblems.push(`安全重要度の判定の記録の「判定した区分」(${v.cls})を、CL0〜CL3 のどれか1つとして読めません`);
  // 記録の区分と構成の回答の食い違い。構成が判定より低い区分で動く向き(判定 CL1・構成 CL0 など)は、判定で外した守りが
  // 構成で外れたままになるため記録の不備にする。構成が判定より高い向き(変化点で区分を上げた後に記録を改めていない)は、
  // 統制が厳しい側に倒れているため注意にとどめる
  const notes = [];
  if (cls && answer && CL_ORDER.includes(answer) && cls !== answer) {
    const text =
      `安全重要度の判定の記録の区分(${CL_LABEL[cls]})と、構成の回答 q-criticality(${CL_LABEL[answer]}。初期化の回答は仮の判定)が食い違います。` +
      '区分を変えるなら /process-change(種別 axis)で構成へ反映し、記録を改めます。区分を下げる場合は、記録の「区分の引き下げの根拠」を先に書きます';
    if (CL_ORDER.indexOf(answer) < CL_ORDER.indexOf(cls)) recordProblems.push(text);
    else notes.push(`${text}(構成が記録より厳しい区分で動いているため止めません)`);
  }
  const f2q1 = parsed.present && isFilledValue(v.f2) ? f2Q1Of(v.f2) : null;
  if (parsed.present && isFilledValue(v.f2) && f2q1 === null) recordProblems.push(`安全重要度の判定の記録の「附属書F F.2 の回答」を、Q1 の答え(はい / いいえ)で始めてください(${v.f2.slice(0, 40)})`);

  // 判定者: D-0 表1「体制と運用形態」の決定者の席の責任者。AI の名義・名簿に無い記名を受け付けない
  let judgePerson = null;
  if (parsed.present && isFilledValue(v.judge)) {
    judgePerson = resolveSigner(config, v.judge);
    const deciderSeat = (config?.seats ?? []).find((s) => s.role === structureDeciderSeat(config));
    const decider = deciderSeat?.accountable ? resolveSigner(config, deciderSeat.accountable) : null;
    // 判定者の記名は、記録が作られた時点(判定日)の D-0 表1「体制と運用形態」の決定者と照らす(議長の裁定 J-12、ADR-0111 決定6 と同じ原則)。
    // 現在の決定者と一致すれば足りる。一致しなければ、判定日の時点の構成から決定者を導く。決定者の交代の前に正しく作られた記録は
    // 効力を保つ(現在の名簿に居なくてよい)。記録の時点で決定者でなかった人の記名は拒否する。時点を導けない場合に限り注意にする
    let historic = null;
    if (decider && judgePerson && decider.id === judgePerson.id) historic = null;
    else if (decider) {
      const at = root ? deciderAt(root, v.judgedAt) : { person: null, why: '構成の履歴を読む場所が無い' };
      if (at.person) {
        const same = resolveSigner(at.config, v.judge);
        if (same && same.id === at.person.id) historic = at;
        else {
          recordProblems.push(
            `安全重要度の判定の判定者(${v.judge})は、記録の時点(判定日 ${v.judgedAt}。構成 ${at.rev.slice(0, 8)})の D-0 表1「体制と運用形態」の決定者(${at.person.name})ではありません。` +
              '判定者は、記録を作る時点の決定者です(第8章 軸E)'
          );
        }
      } else {
        notes.push(
          `安全重要度の判定の判定者(${v.judge})が、現在の${structureDeciderLabel(config)}(${decider.name})ではありません。記録の時点の決定者を構成の履歴から導けないため、照らしていません(${at.why})。` +
            '判定者は記録を作る時点の D-0 表1「体制と運用形態」の決定者です(第8章 軸E)'
        );
      }
    }
    // 名簿が未記入の間(初期化の直後)は名簿と照合しない。記録の時点の決定者と照らせた記名は、現在の名簿と照らし直さない
    const problems = historic ? nameProblems(historic.config, v.judge) : nameProblems(config, v.judge);
    for (const p of problems) recordProblems.push(`安全重要度の判定の判定者の記名を受け付けられません: ${p}`);
    if (historic && !judgePerson) judgePerson = resolveSigner(historic.config, v.judge);
  }

  // 確認者: 判定者と別の自然人。AI の名義と判定者本人の記名は、記録の誤りとして止める。名簿に無い記名は確認に数えない(未達)
  const req = requiredStep(cls ?? answer ?? 'cl0', { f2q1, regulated });
  const unmet = [];
  let recorded = null;
  let effective = null;
  if (!parsed.present || !isFilledValue(v.confirmer) || isUnmetText(v.confirmer)) {
    unmet.push(parsed.present ? '確認者が未記入(未達)' : '判定の記録が無い');
  } else {
    const confirmer = resolveSigner(config, v.confirmer);
    const ai = aiNameBlocked(config, v.confirmer);
    if (ai) recordProblems.push(`安全重要度の判定の確認者 "${v.confirmer}" は ${ai}。確認者は自然人に限ります。AI の担い手の確認と、理由の記述を、確認者の代わりにしません`);
    if (confirmer && judgePerson && confirmer.id === judgePerson.id) {
      recordProblems.push(`安全重要度の判定の確認者(${v.confirmer})が判定者と同じ人です。確認者は判定者と別の自然人です。置けない間は「未達」と書きます`);
    }
    if (!confirmer) unmet.push(`確認者 "${v.confirmer}" が人の名簿に無い(チームの外の確認者は /process-change の種別 accountable で外部の確認者として名簿へ載せる)`);
    if (ai || (confirmer && judgePerson && confirmer.id === judgePerson.id)) unmet.push('確認者の記名を確認に数えない');
    recorded = stepOf(v.step);
    if (recorded === null) unmet.push('確認者の段が未記入');
    if (!isFilledValue(v.stepBasis)) unmet.push('段の根拠が未記入');
    if (!isFilledValue(v.confirmedAt)) unmet.push('確認日が未記入');
    effective = recorded;
    // 2名の体制で、体制の内の相手を確認者に数えてよいのは段1 に限る(第8章 軸E)
    if (confirmer && confirmer.external !== true && config?.answers?.['q-team-size'] === 'size-1-2' && effective !== null && effective > 1) effective = 1;
    if (effective !== null && effective < req.step) {
      unmet.push(
        `記録した段 段${recorded}${effective !== recorded ? `(1〜2名の体制の内の確認者は段1 として数える)` : ''} が、求める段 段${req.step}(${req.reasons.join('。')})に届かない`
      );
    }
  }
  const ok = unmet.length === 0 && recordProblems.length === 0;
  // 出荷で欠落に数えるかは、記録の区分と構成の回答の高いほうで決める(構成が区分を上げた後も、CL1 以上の未達は出荷しない)
  const effCls = [cls, answer].filter((c) => CL_ORDER.includes(c)).sort((a, b) => CL_ORDER.indexOf(b) - CL_ORDER.indexOf(a))[0] ?? null;
  // 旧い構成(判定の記録を求める前に G-1 を通過した構成)だけが、判定の記録の不備を未達として表示する。それ以外は、判定の記録と
  // 判定者の記名の不備を出荷の証跡の集約で欠落に数える(議長の裁定 J-10。G-1 の後に記録を消す・書き換える経路を塞ぐ)
  const legacy = g1PassedBeforeRule(gateRecords) && recordProblems.length > 0;
  const recordGap = recordProblems.length > 0 && !legacy;
  const confirmGap = parsed.present && recordProblems.length === 0 && !ok && (f2q1 === true || ['cl1', 'cl2', 'cl3'].includes(effCls) || regulated);
  const shipBlocking = recordGap || confirmGap;
  return {
    present: parsed.present,
    values: v,
    cls,
    answer,
    f2q1,
    regulated,
    judge: judgePerson?.name ?? (isFilledValue(v.judge) ? clean(v.judge) : null),
    confirmer: isFilledValue(v.confirmer) && !isUnmetText(v.confirmer) ? personName(config, v.confirmer) : null,
    recordProblems,
    notes,
    confirmation: { ok, required: req.step, reasons: req.reasons, recorded, effective, unmet },
    g1Passed,
    legacy,
    shipBlocking,
    shipBlockingReason: !shipBlocking
      ? null
      : recordGap
        ? `判定の記録または判定者の記名に不備がある(${recordProblems.length} 件。${recordProblems[0]})。判定者本人が書ける欠落であり、記載の欠落に数える(第8章 軸E「判定の記録と確認」)`
        : f2q1 === true
        ? '附属書F F.2 の Q1 が「はい」の案件で、段3 の確認が欠けている。G-8 の受容で代えない(第4章 G-7 の記載の欠落)'
        : '安全重要度 CL1 以上、または規制業の案件で、判定の確認が未達である。未達のまま出荷しない(第8章「再実行の時点と向き」)',
  };
}

/**
 * G-1 を通過済みかを決めるための判定記録。基底ブランチの docs/gates/ に加えて、記録用ブランチの様式も読む
 * (G-1 の様式は記録用ブランチへ置き、出荷の PR が基底ブランチへ複製する。複製の前の旧い構成を、G-1 の前と読み違えないため)。
 * branch を渡さなければ記録用ブランチを読む(手元に無ければ origin から1回取りに行く。読めなければ基底ブランチだけ)
 */
export function gateRecordsForCl({ root = ROOT, branch = undefined } = {}) {
  const base = readGateRecords();
  let b = branch;
  if (b === undefined) {
    try {
      b = readRecordsBranch({ cwd: root, fetch: true });
    } catch {
      b = null;
    }
  }
  const forms = (b?.available ? b.gates : []).map((g) => recordFromForm(g.text, g.file, 'branch'));
  return [...base, ...forms];
}

/** 案件の D-0 を読んで状態を出す(root は一時の置き場の試験のため) */
export function readClJudgment(config, { root = ROOT, gateRecords = [] } = {}) {
  const file = path.join(root, 'docs/D-0-governance.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  return clJudgmentState(config, { text, gateRecords, root });
}

/** 判定の確認の状態を1行の文にする(保証の開示の項目1・/pit の注記)。external は氏名を出さない */
export function clJudgmentText(st, { external = false } = {}) {
  if (!st.present || (st.recordProblems.length && !st.cls)) {
    return `**未達**(判定の記録なし。初期化の回答 ${CL_LABEL[st.answer] ?? '未記入'} は仮の判定のまま${st.legacy ? '。判定の記録を求める前に G-1 を通過した旧い構成' : ''})`;
  }
  const who = (n) => (external ? (n ? '記名あり' : '記名なし') : (n ?? '記名なし'));
  const head = `判定 ${CL_LABEL[st.cls] ?? '不明'}(判定者: ${who(st.judge)})`;
  if (st.recordProblems.length) return `${head}。**未達**(記録の不備 ${st.recordProblems.length} 件)`;
  const c = st.confirmation;
  const recordedText = c.recorded ? `段${c.recorded}${c.effective !== c.recorded ? `(段${c.effective} として数えた)` : ''}` : '記載なし';
  const base = `${head} / 確認者: ${st.confirmer ? who(st.confirmer) : 'なし'} / 求める段 段${c.required}(${c.reasons.join('。')}) / 記録した段 ${recordedText}`;
  if (c.ok) return `${base}。段2 以上の距離は機械では確かめていない`;
  return `${base}。**未達**(${c.unmet.join('。')})${st.shipBlocking ? `。**${st.shipBlockingReason}**` : ''}`;
}

/** ADR の識別子(ADR-NNNN)が context/decisions/ に実在するか */
function adrExists(root, id) {
  const n = Number(id);
  const dir = path.join(root, 'context/decisions');
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => /\.md$/.test(f) && Number((f.match(/^(\d+)-/) ?? [])[1]) === n);
}

/** 機能仕様の識別子(F-NNN)が specs/ に実在するか */
function specExists(root, id) {
  return fs.existsSync(path.join(root, 'specs', id, 'spec.md'));
}

/**
 * 区分を下げる操作の引き下げの根拠(第8章 軸E「設計によって区分を下げる」。process-compass #373 / IMPL-0451)。
 * 下げた後の区分が記録の区分と一致し、「区分の引き下げの根拠」の欄に記入があり、欄が引く ADR と機能仕様が実在すること。
 * 設計が実際に帰結を下げたか、ADR が採らなかった選択肢を含むか、必須制約が設計を表すかは確かめない
 */
export function reductionProblems(config, { to, root = ROOT } = {}) {
  const file = path.join(root, 'docs/D-0-governance.md');
  if (!fs.existsSync(file)) return ['D-0(docs/D-0-governance.md)が無く、安全重要度の判定の記録の「区分の引き下げの根拠」を読めない'];
  const parsed = parseClRecord(fs.readFileSync(file, 'utf8'));
  if (!parsed.present) return ['D-0 に「安全重要度の判定の記録」の節が無い。引き下げの根拠(低減の前後の区分と根拠となる設計)を、区分を下げる前に記録へ書く'];
  const out = [];
  const v = parsed.values;
  const cls = classOf(v.cls);
  if (cls !== to) out.push(`安全重要度の判定の記録の「判定した区分」(${v.cls ?? '欄なし'})が、下げた後の区分(${CL_LABEL[to] ?? to})ではない。記録を先に改める`);
  const r = clean(v.reduction);
  if (!isFilledValue(r) || /^該当なし/.test(r)) {
    out.push('安全重要度の判定の記録の「区分の引き下げの根拠」が未記入(低減の前後の区分、根拠となる設計、判断記録 ADR-NNNN、必須制約を書いた機能仕様 F-NNN を書く)');
    return out;
  }
  const adrs = [...r.matchAll(/ADR-(\d{1,4})/g)].map((m) => m[1]);
  const specs = [...r.matchAll(/\bF-\d{3,}\b/g)].map((m) => m[0]);
  if (!adrs.length) out.push('「区分の引き下げの根拠」が判断記録(ADR-NNNN)を引いていない(第8章 軸E の要求事項3)');
  for (const id of adrs) if (!adrExists(root, id)) out.push(`「区分の引き下げの根拠」が引く ADR-${id} が context/decisions/ に無い`);
  if (!specs.length) out.push('「区分の引き下げの根拠」が、必須制約を書いた機能仕様(F-NNN)を引いていない(第8章 軸E の要求事項2)');
  for (const id of specs) if (!specExists(root, id)) out.push(`「区分の引き下げの根拠」が引く ${id} の機能仕様(specs/${id}/spec.md)が無い`);
  return out;
}
