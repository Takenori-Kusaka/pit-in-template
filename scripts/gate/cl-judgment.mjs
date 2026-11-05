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

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** YYYY-MM-DD だけの日付。ほかの書き方は null(判定者・確認者が直せる記録の欠陥として扱う。突合 X-2・X-13) */
export function dateOnly(v) {
  const s = clean(v).normalize('NFKC');
  return DATE_ONLY.test(s) ? s : null;
}
/** ISO の日時(コミットの %cI)の日付の部分 */
const dayOfIso = (iso) => String(iso ?? '').slice(0, 10);

/**
 * G-1 を、判定の記録を求める前に通過したか。判定記録の自己申告の判定日時に加えて、記録を入れたコミットの時刻(addedAt)も
 * 境界より前であることを要件にする(議長の裁定 X-3。ADR-0109 の検出の原則)。コミットの時刻を導けない記録は数えない
 */
function g1PassedBeforeRule(gateRecords, since) {
  return (gateRecords ?? []).some((r) => {
    if (!/^G-1(?!\d)/.test(r.gate ?? '') || r.result !== '通過') return false;
    const d = String(r.judgedAt ?? '').normalize('NFKC').match(/(\d{4})-(\d{2})-(\d{2})/);
    const added = dayOfIso(r.addedAt);
    return Boolean(d) && `${d[1]}-${d[2]}-${d[3]}` < since && /^\d{4}-\d{2}-\d{2}$/.test(added) && added < since;
  });
}

function gitIn(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** 構成の決定者(D-0 表1「体制と運用形態」の決定者の席の責任者)。席が空なら null */
function deciderOf(cfg) {
  const seat = (cfg?.seats ?? []).find((s) => s.role === structureDeciderSeat(cfg));
  return seat?.accountable ? resolveSigner(cfg, seat.accountable) : null;
}

/**
 * 判定の記録が作られた時点(議長の裁定 J-12・X-2・X-5)。自己申告の判定日ではなく、基底ブランチの履歴から導く。
 * D-0 の節16 の「判定者」「判定日」の行を最後に変えたコミット(git blame)を記録の時点とし、そのコミットの構成
 * (process.config.json)の決定者と照らす。同じ日の交代も、コミットの順で決まる。
 *   - 行がまだコミットされていない: 記録は今つくられている。現在の構成で照らす(kind: 'working')
 *   - 浅い取得: 履歴が欠けて照合できない。記録の欠落として扱う(kind: 'shallow'。議長の裁定 X-4)
 *   - リポジトリが無い・D-0 を読めない: 導けない(kind: 'unknown'。注意)
 */
export function recordPoint(root, rowTexts) {
  if (!root) return { kind: 'unknown', why: '構成の履歴を読む場所が無い' };
  if (gitIn(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { kind: 'unknown', why: 'git のリポジトリではない' };
  if (gitIn(root, ['rev-parse', '--is-shallow-repository']) === 'true') {
    return { kind: 'shallow', why: '浅い取得(shallow clone)のため、記録を入れたコミットと、その時点の構成を確かめられない。履歴をすべて取得する(actions/checkout の fetch-depth: 0)' };
  }
  const blame = gitIn(root, ['blame', '--porcelain', '--', 'docs/D-0-governance.md']);
  if (blame === null) return { kind: 'working', why: null };
  // porcelain の出力: 行ごとに「<sha> <元の行> <行> [<数>]」の見出し、続く属性、タブで始まる本文
  const shas = [];
  let cur = null;
  for (const l of blame.split('\n')) {
    const h = l.match(/^([0-9a-f]{40}) \d+ \d+/);
    if (h) cur = h[1];
    else if (l.startsWith('\t') && rowTexts.some((t) => clean(l.slice(1)) === clean(t))) shas.push(cur);
  }
  if (!shas.length || shas.some((s) => /^0+$/.test(s))) return { kind: 'working', why: null };
  // 複数の行が別のコミットなら、後のコミット(子孫)を記録の時点にする
  let sha = shas[0];
  for (const s of shas.slice(1)) if (s !== sha && gitIn(root, ['merge-base', '--is-ancestor', sha, s]) !== null) sha = s;
  const at = gitIn(root, ['show', '-s', '--format=%cI', sha]);
  const cfgAt = (rev) => {
    const t = gitIn(root, ['show', `${rev}:process.config.json`]);
    try {
      return t ? JSON.parse(t) : null;
    } catch {
      return null;
    }
  };
  // 照らす構成は、基底ブランチ(HEAD)の第1親の連鎖にあるコミットの構成に限る(再確認 N-1)。PR の途中のコミットで構成を
  // 書き換えて元へ戻す経路を塞ぐ。記録の行を含む最初の第1親のコミット(取り込みのコミット)から始め、変化点の記録
  // (changeLog)が同じままの後続の第1親のコミットのうち、最後のものの構成で照らす。構成を変える正規の経路(/process-change)は
  // 必ず変化点の記録を足すため、変化点の記録を足さずに書き換えた構成(手の書き換え)は、戻した後の構成に置き換わる
  const chain = (gitIn(root, ['rev-list', '--first-parent', '--reverse', 'HEAD']) ?? '').split('\n').filter(Boolean);
  let i = chain.indexOf(sha);
  if (i < 0) i = chain.findIndex((c) => gitIn(root, ['merge-base', '--is-ancestor', sha, c]) !== null);
  if (i < 0) return { kind: 'commit', sha, at, config: null, why: '記録を入れたコミットが基底ブランチの第1親の連鎖に無い' };
  let via = chain[i];
  let cfg = cfgAt(via);
  const logOf = (c) => JSON.stringify(c?.changeLog ?? null);
  for (let j = i + 1; j < chain.length && cfg; j++) {
    const next = cfgAt(chain[j]);
    if (!next || logOf(next) !== logOf(cfg)) break;
    via = chain[j];
    cfg = next;
  }
  return { kind: 'commit', sha, at, via, config: cfg };
}

/** G-1 の判定記録を入れたコミットの時刻(基底ブランチの docs/gates/。最初に足したコミット) */
function addedAtOf(root, file) {
  const out = gitIn(root, ['log', '--diff-filter=A', '--format=%cI', '--', file]);
  if (!out) return null;
  const lines = out.split('\n').filter(Boolean);
  return lines.at(-1) ?? null;
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
export function clJudgmentState(config, { text = null, gateRecords = [], root = null, since = CL_RECORD_REQUIRED_SINCE } = {}) {
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

  // 判定日は YYYY-MM-DD に限る(読めない書き方は判定者が直せる欠陥。突合 X-2)
  const judgedAt = parsed.present && isFilledValue(v.judgedAt) ? dateOnly(v.judgedAt) : null;
  if (parsed.present && isFilledValue(v.judgedAt) && !judgedAt) recordProblems.push(`安全重要度の判定の記録の「判定日」(${clean(v.judgedAt)})を YYYY-MM-DD の形で書いてください`);

  // 判定者: 記録が作られた時点の D-0 表1「体制と運用形態」の決定者(議長の裁定 J-12・X-2・X-5・X-9、ADR-0111 決定6 と同じ原則)。
  // 記録の時点は、自己申告の判定日ではなく、節16 の判定者・判定日の行を入れたコミットから導く。決定者の交代の前に正しく
  // 作られた記録は効力を保つ(現在の名簿に居なくてよい)。時点で決定者でなかった人の記名と、時点で決定者の席が空の記名は拒否する。
  // 浅い取得は欠落にする。履歴そのものを読めない場合に限り注意にする
  let judgePerson = null;
  let point = null;
  if (parsed.present && isFilledValue(v.judge)) {
    judgePerson = resolveSigner(config, v.judge);
    const rows = String(text ?? '').split(/\r?\n/).filter((l) => /^\|\s*(判定者|判定日)\s*\|/.test(l));
    point = recordPoint(root, rows);
    let pointConfig = null;
    if (point.kind === 'working') pointConfig = config;
    else if (point.kind === 'commit') pointConfig = point.config;
    if (point.kind === 'shallow') recordProblems.push(`安全重要度の判定の判定者を、記録の時点の決定者と照らせません: ${point.why}`);
    else if (point.kind === 'unknown') {
      const decider = deciderOf(config);
      if (!decider || !judgePerson || decider.id !== judgePerson.id) {
        notes.push(`安全重要度の判定の判定者(${v.judge})を、記録の時点の決定者と照らしていません(${point.why})。判定者は記録を作る時点の D-0 表1「体制と運用形態」の決定者です(第8章 軸E)`);
      }
    } else {
      const decider = deciderOf(pointConfig);
      const where =
        point.kind === 'commit'
          ? `記録を入れたコミット ${point.sha.slice(0, 8)}(${point.at})の時点${point.via && point.via !== point.sha ? `(照らした構成は、基底ブランチの第1親の連鎖のコミット ${point.via.slice(0, 8)} のもの)` : ''}${point.why ? `(${point.why})` : ''}`
          : '記録の時点(未コミット。現在の構成)';
      if (!decider) {
        // 初期化の直後(席が全部空)は、席の責任者の任免が先に人の判断待ちに出る。記録の側の不備としては出す(突合 X-9)
        recordProblems.push(`安全重要度の判定の判定者(${v.judge})を照らす決定者がいません(${where}に D-0 表1「体制と運用形態」の決定者の席が空、または構成が無い)。席を埋めてから記名します`);
      } else {
        const same = resolveSigner(pointConfig, v.judge);
        if (!same || same.id !== decider.id) {
          recordProblems.push(`安全重要度の判定の判定者(${v.judge})は、${where}の D-0 表1「体制と運用形態」の決定者(${decider.name})ではありません。判定者は、記録を作る時点の決定者です(第8章 軸E)`);
        }
        if (!judgePerson && same) judgePerson = same;
      }
      // 判定日は、記録を入れたコミットの日付より後にならない(遡らせるのは構わないが、記録の時点はコミットで決まる)
      if (point.kind === 'commit' && judgedAt && judgedAt > dayOfIso(point.at)) {
        recordProblems.push(`安全重要度の判定の記録の「判定日」(${judgedAt})が、記録を入れたコミットの日付(${dayOfIso(point.at)})より後です`);
      }
    }
    // 記録の時点の構成の名簿で照らす(交代・離任の後も、時点で正しい記名を照らし直さない)。名簿が未記入の間は照合しない
    for (const p of nameProblems(pointConfig ?? config, v.judge)) recordProblems.push(`安全重要度の判定の判定者の記名を受け付けられません: ${p}`);
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
    else if (!dateOnly(v.confirmedAt)) unmet.push(`確認日(${clean(v.confirmedAt)})を YYYY-MM-DD の形で読めない`);
    else if (judgedAt && dateOnly(v.confirmedAt) < judgedAt) unmet.push(`確認日(${dateOnly(v.confirmedAt)})が判定日(${judgedAt})より前(判定より前の確認は、その判定の確認に数えない)`);
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
  // 旧い構成(判定の記録を求める前に G-1 を通過した構成。判定日時とそれを入れたコミットの時刻の両方で決める)のうち、
  // CL0 で規制業でなく、F.2 の Q1 が「いいえ」と読める案件だけが、判定の記録の不備を未達として表示する。それ以外は、判定の記録と
  // 判定者の記名の不備を出荷の証跡の集約で欠落に数える(議長の裁定 J-10・X-1。記録を消して出荷の止めを外す経路を塞ぐ)。
  // 記録が無く F.2 の回答を読めない旧い構成は、緩い扱いに当たらない
  const legacyConfig = g1PassedBeforeRule(gateRecords, since);
  const legacy = legacyConfig && recordProblems.length > 0 && effCls === 'cl0' && !regulated && f2q1 === false;
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
    legacyConfig,
    legacy,
    point,
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
  // 記録を入れたコミットの時刻(旧い構成の境界を自己申告の判定日時だけで決めない。議長の裁定 X-3)
  const g1 = (r) => /^G-1(?!\d)/.test(r.gate ?? '');
  const baseWithTime = base.map((r) => (g1(r) ? { ...r, addedAt: addedAtOf(root, r.file) } : r));
  const forms = (b?.available ? b.gates : []).map((g) => {
    const r = recordFromForm(g.text, g.file, 'branch');
    return g1(r) ? { ...r, addedAt: g.added ? gitIn(root, ['show', '-s', '--format=%cI', g.added]) : null } : r;
  });
  return [...baseWithTime, ...forms];
}

/** 案件の D-0 を読んで状態を出す(root は一時の置き場の試験のため) */
export function readClJudgment(config, { root = ROOT, gateRecords = [] } = {}) {
  const file = path.join(root, 'docs/D-0-governance.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  return clJudgmentState(config, { text, gateRecords, root });
}

/**
 * 判定の記録の不備で止めた理由と次の一手(議長の「修正の帰結への裁定」)。旧い構成でも、節16 を持たない・F.2 を読めない・
 * CL1 以上・規制業・F.2 の Q1 が「はい」の案件は止まる。止めた理由と、節16 を書くという次の一手を、/pit と拒否の文に出す
 */
export function clStopText(st) {
  if (!st.recordProblems.length || st.legacy) return null;
  const head = '初期化の回答 q-criticality は仮の判定です。安全重要度の判定の記録と判定者の記名がそろうまで、G-1 の審議を開始できません(標準 第2章 2.8、第8章 軸E)';
  const why = st.legacyConfig
    ? `${head}。判定の記録を求める前(2026-11-05 より前)に G-1 を通過した構成ですが、旧い構成を緩く扱うのは、節16 の判定の記録があり、CL0 で規制業でなく、附属書F F.2 の Q1 が「いいえ」の案件に限ります。この構成は当たらないため止めます(ADR-0113)`
    : st.g1Passed
      ? `${head}。G-1 を通過済みでも、判定の記録と判定者の記名の欠落は止めます(G-1 の後に記録を消す・書き換える経路を塞ぐため。ADR-0113)`
      : head;
  const next = st.present
    ? '次の一手: D-0 の節16 の欄を埋め、D-0 表1「体制と運用形態」の決定者が判定者として記名する(判定者・判定日の行を入れたコミットの時点の決定者で照らす)'
    : '次の一手: templates/00-d0-governance.md の節16「安全重要度の判定の記録」を docs/D-0-governance.md へ写し、D-0 表1「体制と運用形態」の決定者が欄を埋めて判定者として記名する';
  return `${why}。${next}`;
}

/** 判定の確認の状態を1行の文にする(保証の開示の項目1・/pit の注記)。external は氏名を出さない */
export function clJudgmentText(st, { external = false } = {}) {
  if (!st.present || (st.recordProblems.length && !st.cls)) {
    return `**未達**(判定の記録なし。初期化の回答 ${CL_LABEL[st.answer] ?? '未記入'} は仮の判定のまま${st.legacy ? '。判定の記録を求める前に G-1 を通過した旧い構成' : ''})`;
  }
  const who = (n) => (external ? (n ? '記名あり' : '記名なし') : (n ?? '記名なし'));
  const head = `判定 ${CL_LABEL[st.cls] ?? '不明'}(判定者: ${who(st.judge)})`;
  if (st.recordProblems.length) {
    // 旧い構成として緩く扱った場合は、その旨と、境界が判定記録を入れたコミットの時刻(書き手が偽れる)に依ることを開示する(再確認 N-2)
    const legacyNote = st.legacy
      ? '。判定の記録を求める前に G-1 を通過した旧い構成(CL0・規制業でない・F.2 の Q1「いいえ」)として未達の表示にとどめた。旧い構成かは G-1 の判定記録を入れたコミットの時刻で決め、その時刻は書き手が偽れる'
      : '';
    return `${head}。**未達**(記録の不備 ${st.recordProblems.length} 件${legacyNote})`;
  }
  const c = st.confirmation;
  const recordedText = c.recorded ? `段${c.recorded}${c.effective !== c.recorded ? `(段${c.effective} として数えた)` : ''}` : '記載なし';
  const base = `${head} / 確認者: ${st.confirmer ? who(st.confirmer) : 'なし'} / 求める段 段${c.required}(${c.reasons.join('。')}) / 記録した段 ${recordedText}`;
  if (c.ok) return `${base}。段2 以上の距離は機械では確かめていない`;
  return `${base}。**未達**(${c.unmet.join('。')})${st.shipBlocking ? `。**${st.shipBlockingReason}**` : ''}`;
}

/**
 * テンプレ9(docs/safety-risk-assessment.md)の「承認」の欄(標準 第6章「AIエージェント安全リスクアセスメント」。#373 突合 X-8 / IMPL-0453)。
 * 承認者が記入され、作成者と別の名簿の人で、AI の名義でなく、承認日が YYYY-MM-DD で、承認した版が書かれていること。
 * 表の要否(第6章の4条件)と、危険源の洗い出しの中身は確かめない(人が判定する)
 */
export function sraApprovalProblems(config, text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+承認\s*$/.test(l));
  if (start < 0) return ['安全リスクアセスメント表に「承認」の欄がありません(templates/09-safety-risk-assessment.md の様式から写す)'];
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) || /^```/.test(lines[i])) break;
    if (!/^\|/.test(lines[i]) || /^\|[\s|:-]+\|?\s*$/.test(lines[i])) continue;
    rows.push(lines[i].split('|').slice(1, -1).map((c) => clean(c)));
  }
  const data = rows.filter((r) => r[0] !== '作成者');
  const row = data.find((r) => r.some((c) => isFilledValue(c)));
  if (!row) return ['安全リスクアセスメント表の「承認」の欄が未記入です(作成者・承認者・承認日・承認した版)'];
  const [creator, approver, approvedAt, version] = row;
  const out = [];
  if (!isFilledValue(creator)) out.push('安全リスクアセスメント表の「承認」の作成者が未記入です');
  if (!isFilledValue(approver)) out.push('安全リスクアセスメント表の承認者が未記入です(作成者と別の自然人)');
  else {
    for (const p of nameProblems(config, approver)) out.push(`安全リスクアセスメント表の承認者の記名を受け付けられません: ${p}`);
    const a = resolveSigner(config, approver);
    const c = isFilledValue(creator) ? resolveSigner(config, creator) : null;
    if ((a && c && a.id === c.id) || clean(approver) === clean(creator)) out.push(`安全リスクアセスメント表の承認者(${approver})が作成者と同じ人です。承認者は作成者と別の自然人です`);
  }
  if (!dateOnly(approvedAt)) out.push(`安全リスクアセスメント表の承認日(${approvedAt || '未記入'})を YYYY-MM-DD の形で書いてください`);
  if (!isFilledValue(version)) out.push('安全リスクアセスメント表の承認した版が未記入です');
  return out;
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
function establishedAt(root, from) {
  if (!from) return true;
  const committed = gitIn(root, ['show', 'HEAD:docs/D-0-governance.md']);
  if (committed === null) return false;
  const p = parseClRecord(committed);
  if (!p.present) return false;
  return classOf(p.values.cls) === from && isFilledValue(p.values.judge);
}

export function reductionProblems(config, { to, from = null, root = ROOT } = {}) {
  const file = path.join(root, 'docs/D-0-governance.md');
  if (!fs.existsSync(file)) return ['D-0(docs/D-0-governance.md)が無く、安全重要度の判定の記録の「区分の引き下げの根拠」を読めない'];
  const parsed = parseClRecord(fs.readFileSync(file, 'utf8'));
  if (!parsed.present) return ['D-0 に「安全重要度の判定の記録」の節が無い。引き下げの根拠(低減の前後の区分と根拠となる設計)を、区分を下げる前に記録へ書く'];
  const out = [];
  const v = parsed.values;
  const cls = classOf(v.cls);
  if (cls !== to) out.push(`安全重要度の判定の記録の「判定した区分」(${v.cls ?? '欄なし'})が、下げた後の区分(${CL_LABEL[to] ?? to})ではない。記録を先に改める`);
  // 仮の判定(初期化の回答)から最初の判定の記録へ移るときは、引き下げの根拠を求めない。最初の記録はすでに「1つ上の区分に
  // 当たらない理由」を持つ。求めるのは、判定の記録が成立した後(基底ブランチの D-0 に、下げる前の区分の判定の記録と判定者の
  // 記名がある)の引き下げに限る(議長の裁定 X-10)
  if (!establishedAt(root, from)) return out;
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
