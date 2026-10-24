// 構成ファイルとアダプタの読み込み。ゲートのスクリプトが共通で使う。
// 依存パッケージなし。

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadConfig() {
  const p = path.join(ROOT, 'process.config.json');
  if (!fs.existsSync(p)) {
    throw new Error('process.config.json がありません。/process-init を実行してください');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function loadAdapter(config) {
  const stack = config.adapters?.stack ?? 'none';
  const p = path.join(ROOT, 'adapters', `${stack}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`adapters/${stack}.json がありません。process.config.json の adapters.stack を確認してください`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** ゲートが有効か(required / simplified を有効とみなす) */
export function isGateActive(config, key) {
  const s = config.gates?.[key]?.state;
  return s === 'required' || s === 'simplified';
}

export function gateState(config, key) {
  return config.gates?.[key]?.state ?? 'required';
}

// ---------------------------------------------------------------- 席と運用形態

/** 運用形態の語彙(標準 第5章 5.5.2)。並びは統制の厳しい順 */
export const SEAT_MODES = ['human', 'collab', 'delegated'];
export const MODE_LABEL = { human: '人確定', collab: '協働', delegated: '委任' };

/**
 * 席ごとの運用形態の上限(標準 第5章 5.5.6)。ここに無い席の上限は delegated。
 *
 * 構成ファイルではなく検査の側に置く。構成に書いた上限は書き換えられるため、
 * 案件単位で上限を引き上げる経路になる(第8章 テーラリングの禁止事項)。
 */
export const SEAT_CEILING = {
  'biz-approver': 'human',
  'ai-ops': 'human',
  'qa-gatekeeper': 'collab',
  'ai-maintainer': 'collab',
};

/**
 * 体制の変化点の種別と、標準の番号(第3章 3.13.1)。番号を持たない種別は null。
 * schedule-only と outage は変化点に数えない。記録のためだけに置く(第3章 3.13.2)
 */
export const CHANGE_KINDS = {
  init: null,
  accountable: 1,
  headcount: 2,
  mode: 3,
  performer: 4,
  axis: 5,
  'schedule-only': null,
  outage: null,
  settings: null,
  notice: null,
  // 従う本標準の版の切り替え(標準 第1章 1.10.3)と、適用の終了(同 1.10.4)。体制の変化点に数えない。
  // どちらも適用の開始を動かさない(同 1.10.1)。process-compass #313 / ADR-0082
  edition: null,
  end: null,
  // 構成の形式の移行と、取り込んだ準拠テンプレートの記録(process-compass #315 / ADR-0084)。体制の変化点に数えない。値を変えない
  migrate: null,
};

/** 変化点に数えない種別の表示名 */
export const KIND_NOTE = {
  'schedule-only': '納期だけの変更(変化点に数えない)',
  outage: 'AI が使えない期間(変化点に数えない)',
  settings: '個別の値の変更(変化点に数えない)',
  notice: '即時通知の記録(変化点に数えない)',
  edition: '従う本標準の版の切り替え(変化点に数えない。適用の開始を動かさない)',
  end: '適用の終了(変化点に数えない)',
  migrate: '構成の形式の移行・取り込んだテンプレートの記録(変化点に数えない。値を変えない)',
};

// ---------------------------------------------------------------- 本標準の版・適用の終了・主張の名(標準 第1章 1.10。process-compass #313 / ADR-0082)
//
// 版は、標準の保守者が発行したものだけを指す(「第N版」、要求事項を変えない改訂は「第N版 修正M」)。
// 発行していない状態は作業中の版で、適用の表明に限りコミットとともに名指せる。2つの適合の主張は発行した版を要する。構成の standard.edition が
// 無い旧い構成と null の構成は、作業中の版に従うものとして読む(後方互換。欄を足さない)

/** 版の書式。第N版、または 第N版 修正M */
export const EDITION_PATTERN = /^第([1-9][0-9]*)版( 修正([1-9][0-9]*))?$/;
/** 発行していない状態の表示 */
export const WORKING_DRAFT = '作業中の版(未発行)';

/** 構成が従う版。発行した版でなければ null(作業中の版) */
export function standardEdition(config) {
  const e = config?.standard?.edition ?? null;
  return typeof e === 'string' && EDITION_PATTERN.test(e) ? e : null;
}

/**
 * 作業中の版の表示。複製した知識ベースの source(edition が null のとき)から、最後に発行した版(basedOn)と
 * 生成元のコミットを添える。作業中の版は、適用の表明に限り、コミットとともに名指せる(標準 第1章 1.10.3。ADR-0082 X-4)
 */
export function workingDraftLabel(kbSource) {
  const after = kbSource?.basedOn ? `${kbSource.basedOn}の後` : '未発行';
  const commit = typeof kbSource?.commit === 'string' && /^[0-9a-f]{7,40}$/.test(kbSource.commit) ? `。標準のコミット ${kbSource.commit.slice(0, 12)}` : '';
  return `作業中の版(${after}${commit})`;
}

/** 版の表示。作業中の版は「作業中の版(未発行。標準のコミット …)」 */
export function editionLabel(config, kbSource = null) {
  return standardEdition(config) ?? (kbSource ? workingDraftLabel(kbSource) : WORKING_DRAFT);
}

/** 適用の終了の理由の区分(標準 第1章 1.10.4) */
export const END_REASONS = {
  closed: '案件の完了・中止',
  'operation-ended': '運用の終了',
  withdrawn: '採用の取り下げ',
};

/** 適用の終了の記録。最後の end の記録を返す。無ければ null(適用を続けているものとして扱う) */
export function applicationEnd(config) {
  const log = Array.isArray(config?.changeLog) ? config.changeLog : [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === 'end') {
      return { index: i, date: String(e.date ?? '').slice(0, 10), reason: e.end?.reason ?? null, reasonLabel: END_REASONS[e.end?.reason] ?? '理由の区分なし', decidedBy: e.decidedBy ?? null };
    }
  }
  return null;
}

/**
 * 逸脱の閉じた列挙(標準 第1章 1.10.2)。本標準が条項で条件と代償措置を定めて認めた離脱に限る。
 * 構成の deviations[] には、条件と代償措置を定めていない兼務(1〜2名の体制で成立しない兼務禁止)も入る。
 * 構成の形は変えず(旧い構成の要約値を保つため)、読むときにこの列挙で分ける
 */
export const CLOSED_DEVIATIONS = [
  { id: 'D-1', label: '開発ライン × 出荷判定者の兼務', clause: '第3章 3.5.2', match: (d) => d?.gate === 'g7' },
];

/** 構成の deviations[] を、閉じた列挙の逸脱(listed)と、列挙に無い離脱(unlisted)に分ける */
export function classifyDeviations(config) {
  const listed = [];
  const unlisted = [];
  for (const d of config?.deviations ?? []) {
    const hit = CLOSED_DEVIATIONS.find((c) => c.match(d));
    if (hit) listed.push({ ...d, closedListId: hit.id, clause: hit.clause });
    else unlisted.push(d);
  }
  return { listed, unlisted };
}

/**
 * 構成だけから決まる、述べられる表明と主張(標準 第1章 1.10.2・1.10.3・1.10.4)。
 * 記録の欠落は出荷の証跡の集約が数えるため、ここでは判定しない(「記録の欠落が無い範囲に限る」と添える)。
 * 表明・主張の文そのものは出力しない(IMPL-0120。降りていない)
 */
export function claimStatus(config, { kbSource = null, ignoreEnd = false } = {}) {
  const edition = standardEdition(config);
  const ended = applicationEnd(config);
  const { listed, unlisted } = classifyDeviations(config);
  const unmet = (config?.unmet ?? []).map((u) => u.label ?? u.gate);
  const blockers = [];
  // 作業中の版は、適用の表明に限り、コミットとともに名指せる。2つの適合の主張は発行した版を要する(第1章 1.10.2・1.10.3)
  if (!edition) blockers.push(`従う版が作業中の版です。適用の表明は作業中の版をコミットとともに名指せますが、適合の主張と逸脱を伴う適合の主張は発行した版を要します(第1章 1.10.3)`);
  if (ended && !ignoreEnd) blockers.push(`適用を終えています(${ended.date}。${ended.reasonLabel})。現在形の適用の表明をしません(第1章 1.10.4)`);
  if (unmet.length) blockers.push(`未達のゲートがあります(${unmet.join(' / ')})。適合の主張を述べられません`);
  if (unlisted.length) blockers.push(`逸脱の閉じた列挙に無い離脱があります(${unlisted.map((d) => d.label).join(' / ')})。適合の主張を述べられません`);
  let name;
  if (ended && !ignoreEnd) name = null;
  else if (!edition || unmet.length || unlisted.length) name = '適用の表明';
  else if (listed.length) name = '逸脱を伴う適合の主張';
  else name = '適合の主張';
  return { edition, editionLabel: editionLabel(config, kbSource), ended, unmet, listed, unlisted, blockers, name };
}

/**
 * 適用の開始のコミット(configured が true になった最初のコミット)の構成が、構成の初期化の記録
 * (changeLog[0] の init)を持つか(標準 第1章 1.10.1)。持たなければ問題の文を返す。境は動かさない
 */
export function initRecordProblem(configAtInit) {
  const first = Array.isArray(configAtInit?.changeLog) ? configAtInit.changeLog[0] : undefined;
  if (first?.kind === 'init') return null;
  return first
    ? `適用の開始のコミットの構成の changeLog[0] が、構成の初期化の記録(種別 init)ではありません(種別 "${first.kind}")`
    : '適用の開始のコミットの構成に、構成の初期化の記録(changeLog[0] の種別 init)がありません';
}

/** AI が使えない期間の扱い(D-0 節12「AI が使えないときの扱い」と同じ語彙) */
export const OUTAGE_HANDLING = { human: '人へ戻した', stop: '止めた' };

/**
 * 変化点の向きの表示名。arising は、未達・逸脱の発生(決定ではなく事実。第3章 3.13.3)。
 * 人が実際に減った変化点に限って付く。人が減っていないのに統制を下げる変更は loosen である
 */
export const DIRECTION_LABEL = {
  loosen: '緩める',
  // 席の責任者の任免。統制の向きにかかわらず決定として扱い、決定者の記名と理由を要する(第3章 3.13.3)
  appoint: '任免の決定',
  tighten: '厳しくする',
  arising: '未達・逸脱の発生',
  none: '—',
};

/** 決定した者の記名と理由を要する向き */
export const SIGNED_DIRECTIONS = ['loosen', 'appoint'];

export function modeRank(mode) {
  return SEAT_MODES.indexOf(mode);
}

/** 担い手の識別(モデルの版・指示資産の版・権限の組)を比較できる形にする */
export function performerKey(p) {
  return p ? JSON.stringify([p.model ?? null, p.instructions ?? null, p.permissions ?? null]) : null;
}

// ---------------------------------------------------------------- 人の名簿
//
// 責任者・決定者・承認者は記名の自然人である(標準 第5章 5.5.1 / 5.5.7)。
// 構成は人の名簿(people[])を持ち、記名の欄を名簿と照合する。名簿は人が D-0 体制図の
// 節1 と合わせて記入する。AI を示す名義は、名簿に書かれていても受け付けない。

/** 全角の英数字・記号と半角の片仮名は、互換の形へ寄せてから比べる(NFKC) */
const normName = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

/** AI を示す語。名義に含まれていれば、自然人の記名として受け付けない */
const AI_NAME_RULES = [
  [/(?<![A-Za-z])AI(?![A-Za-z])|ＡＩ|人工知能/, 'AI の表記を含む'],
  [/(?<![A-Za-z])agent(?![A-Za-z])|エージェント/i, 'agent の表記を含む'],
  [/Agent(?![a-z])/, 'agent の表記を含む'],
  [/(?<![A-Za-z])bot(?![A-Za-z])|ボット|dependabot|renovate|github-actions/i, 'bot の表記を含む'],
  [/Bot(?![a-z])/, 'bot の表記を含む'],
  [
    /(?<![A-Za-z])(claude|anthropic|gpt|chatgpt|openai|gemini|copilot|codex|llama|mistral|grok|deepseek|qwen|sonnet|opus|haiku|fable|mythos|llm|assistant|model|devin|cursor|windsurf|cline|aider|replit|tabnine|codewhisperer|kiro|perplexity)(?![A-Za-z])|モデル/i,
    'モデル名または提供者名を含む',
  ],
  // 片仮名の読み。語の一致であり、別の文字種・役職名による回避は閉じない(監査観点6 で確かめる)
  [/エーアイ/, 'AI の表記を含む'],
  [
    /クロード|デビン|ウィンドサーフ|アンソロピック|チャットジーピーティー|ジーピーティー|オープンエーアイ|ジェミニ|コパイロット|コーデックス|ミストラル|グロック|ディープシーク|ソネット|オーパス|フェイブル|ミトス|アシスタント/,
    'モデル名または提供者名を含む',
  ],
];

/**
 * 名義が AI を示す語を含む場合、その理由を返す。含まなければ null。
 *
 * 語の一致による機械検査であり、同じ語を含む実在の氏名も当たる。名簿の該当者に、人が確認した旨
 * (people[].nameConfirmed)がある場合の扱いは aiNameBlocked による。
 * account を真にすると、ホスティングのアカウント名の表記([bot])も見る
 */
export function aiNameReason(name, { account = false } = {}) {
  const n = normName(name);
  if (account && /\[bot\]$/i.test(n)) return 'bot の表記を含む';
  for (const [re, why] of AI_NAME_RULES) if (re.test(n)) return why;
  return null;
}

/** 名簿から人を引く。id または氏名で一致させる */
export function findPerson(config, ref) {
  const n = normName(ref);
  if (!n) return null;
  const roster = Array.isArray(config.people) ? config.people : [];
  return roster.find((p) => p?.id === n || normName(p?.name) === n) ?? null;
}

/** 同一人物かを比べるためのキー。名簿にあれば id、無ければ氏名の文字列 */
export function personKey(config, ref) {
  const n = normName(ref);
  if (!n) return null;
  return findPerson(config, n)?.id ?? n;
}

/** 表示に使う氏名。名簿にあれば名簿の氏名 */
export function personName(config, ref) {
  return findPerson(config, ref)?.name ?? normName(ref);
}

/** 名簿の体制の内の人(外部の確認者・任命権者を除く)の数。氏名の確認で本人の記名を受け付けるかに使う */
export function insiderCount(config) {
  return (Array.isArray(config?.people) ? config.people : []).filter((p) => p && p.external !== true).length;
}

/**
 * 氏名の確認(nameConfirmed)の記録。変化点の記録(changeLog[].nameConfirmations の { id } と decidedBy)のうち、AI の名義でない
 * 名簿の人が記名したもの。キーは名簿の id、値は { decidedBy, date, self }。self は確認された本人の記名(自己申告)。
 * 本人の記名を有効に数えるのは、体制の内の人が1名の名簿に限る(nameConfirmationState。process-compass #296 裁定 8 の付記と追加の裁定)
 */
export function confirmedNames(config) {
  const out = new Map();
  for (const e of config?.changeLog ?? []) {
    for (const c of Array.isArray(e?.nameConfirmations) ? e.nameConfirmations : []) {
      if (!c?.id || !e.decidedBy) continue;
      const by = findPerson(config, e.decidedBy)?.id ?? null;
      if (!by) continue;
      const self = by === c.id;
      // 本人以外の記名は、AI を示す語を含まない名義に限る。本人の記名は、確認される氏名そのものが語を含むため、語では落とさない
      if (!self && aiNameReason(e.decidedBy)) continue;
      const prev = out.get(c.id);
      // 本人以外の記名があれば、それを優先する
      if (!prev || (prev.self && !self)) out.set(c.id, { decidedBy: e.decidedBy, date: e.date ?? null, self });
    }
  }
  return out;
}

/**
 * 名簿の人の氏名の確認の状態。nameConfirmed: true でなければ null。
 *   'other'       本人以外が記名した記録がある(効く)
 *   'self'        本人が記名した記録がある。体制の内の人が1名の名簿でだけ効き、自己申告の氏名として開示する
 *   'unrecorded'  記録が無い(#296 より前に書いた確認を含む)。体制の内の人が1名の名簿では効かせ、未記録として出す
 *   'invalid'     2名以上の名簿で、本人以外の記名の記録が無い(効かない。契約検査が落とす)
 */
export function nameConfirmationState(config, person) {
  if (person?.nameConfirmed !== true || !person.id) return null;
  const rec = confirmedNames(config).get(person.id);
  if (rec && !rec.self) return 'other';
  const single = insiderCount(config) === 1;
  if (!single) return 'invalid';
  return rec ? 'self' : 'unrecorded';
}

/** 名簿の人の氏名の確認が効くか */
export function nameConfirmedValid(config, person) {
  const st = nameConfirmationState(config, person);
  return st === 'other' || st === 'self' || st === 'unrecorded';
}

const RECORD_NAME_CONFIRMATION = '/process-change(種別 accountable)で、名簿をそのまま渡し、決定した者の記名(decidedBy)と理由を付けて記録します';

/** 名簿の nameConfirmed のうち、2名以上の名簿で本人以外の記名の記録が無い確認(契約検査が落とす) */
export function nameConfirmationProblems(config) {
  const out = [];
  for (const p of config?.people ?? []) {
    if (p?.nameConfirmed !== true || !aiNameReason(p.name)) continue;
    if (nameConfirmationState(config, p) === 'invalid') {
      out.push(
        `人の名簿 ${p.name} の氏名の確認(nameConfirmed)に、本人以外が記名した変化点の記録がありません。体制の内の人が2名以上の名簿では、この確認は効かず、名義は AI の名義として拒否されます。` +
          `${RECORD_NAME_CONFIRMATION}。記名するのは本人以外の名簿の人です(#296 より前に書いた確認も、記名し直します)`
      );
    }
  }
  return out;
}

/** 落とさないが知らせる氏名の確認(体制の内の人が1名の名簿の、自己申告の確認と記録の無い確認)。/pit と契約検査の注記へ出す */
export function nameConfirmationNotices(config) {
  const out = [];
  for (const p of config?.people ?? []) {
    if (p?.nameConfirmed !== true || !aiNameReason(p.name)) continue;
    const st = nameConfirmationState(config, p);
    if (st === 'unrecorded') {
      out.push(`人の名簿 ${p.name} の氏名の確認(nameConfirmed)に、変化点の記録がありません(未記録の確認)。1名の体制のため効かせていますが、記録してください: ${RECORD_NAME_CONFIRMATION}`);
    } else if (st === 'self') {
      out.push(`人の名簿 ${p.name} の氏名は、本人の記名による確認です(自己申告の氏名。1名の体制のため受け付けています)。2人目が名簿に加わったら、本人以外が記名し直します`);
    }
  }
  return out;
}

/** 名義の機械検査を上書きした確認の内訳。{ name, how }。how は 'other' / 'self'(自己申告)/ 'unrecorded'(未記録) */
export function nameOverrideDetails(config) {
  const roster = Array.isArray(config?.people) ? config.people : [];
  return roster
    .filter((p) => aiNameReason(p?.name) && nameConfirmedValid(config, p))
    .map((p) => ({ name: normName(p.name), how: nameConfirmationState(config, p) }));
}

/**
 * 記名として受け付けない理由を返す。受け付ける場合は null。
 *
 * AI を示す語に当たった名義は、既定では拒否する。名簿の該当者に、人が確認した旨(nameConfirmed: true)があり、
 * その確認を本人以外が記名した記録がある場合(体制の内の人が1名の名簿では、本人の記名と未記録も)に限り通す(nameConfirmedValid)。通した名義は nameOverrides が返し、出力へ表示する。
 * 担い手の識別と同じ文字列と、名簿に無い名義の拒否は、上書きできない(nameProblems)
 */
export function aiNameBlocked(config, name) {
  const person = findPerson(config, name);
  const why = aiNameReason(person?.name ?? name);
  if (!why) return null;
  return nameConfirmedValid(config, person) ? null : why;
}

/** 名義の機械検査を、人が上書きした名簿の人(氏名の一覧。効いている確認に限る。内訳は nameOverrideDetails) */
export function nameOverrides(config) {
  const roster = Array.isArray(config.people) ? config.people : [];
  return roster.filter((p) => nameConfirmedValid(config, p) && aiNameReason(p.name)).map((p) => normName(p.name));
}

/** 担い手の識別に使われている文字列の一覧。責任者の欄へ同じ文字列を書く経路を塞ぐ */
function performerStrings(config) {
  const out = new Set();
  for (const s of config.seats ?? []) {
    for (const p of [s.performer, s.qualification?.performer]) {
      for (const v of Object.values(p ?? {})) if (v) out.add(normName(v));
    }
  }
  return out;
}

/**
 * 記名の欄に書かれた名義の問題を返す。空なら自然人の記名として受け付ける。
 *
 * requireRoster が真のときは、名簿に無い名義を拒否する。名簿が1件でも記入されていれば、
 * requireRoster によらず照合する。名簿が空のあいだは、未記入として表示するにとどめる。
 */
export function nameProblems(config, name, { requireRoster = false, checkRoster = true } = {}) {
  const n = normName(name);
  if (!n) return ['記名がない'];
  const out = [];
  // 名簿の id で書かれた記名は、名簿の氏名で確かめる
  const ai = aiNameBlocked(config, n);
  if (ai) {
    out.push(
      `"${n}" は ${ai}。記名は自然人の氏名に限る。AI の名義を受け付けない` +
        '(同じ語を含む実在の氏名の場合は、人が確認したうえで、名簿の該当者へ nameConfirmed: true を書く)'
    );
  }
  if (performerStrings(config).has(n)) {
    out.push(`"${n}" は担い手の識別(performer)と同じ文字列である。担い手を責任者・決定者・承認者にできない`);
  }
  const roster = Array.isArray(config.people) ? config.people : [];
  // checkRoster を偽にすると、記録時点の記名(離任した適合性確認の実施者など)を現在の名簿と照合しない
  if (checkRoster && (requireRoster || roster.length) && !findPerson(config, n)) {
    out.push(
      roster.length
        ? `"${n}" は人の名簿(people[])にない`
        : `人の名簿(people[])が未記入のため、"${n}" を照合できない。名簿は人が /process-change の people で記入する`
    );
  }
  return out;
}

/** 名簿そのものの問題を返す */
export function rosterProblems(config) {
  const roster = config.people;
  if (roster === undefined) return [];
  if (!Array.isArray(roster)) return ['people が配列ではない'];
  const out = [];
  const ids = new Set();
  const names = new Set();
  const accounts = new Set();
  const performers = performerStrings(config);
  roster.forEach((p, i) => {
    const at = `people[${i}]`;
    if (!p?.id || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(p.id)) out.push(`${at}: id がない、または英数字の識別子ではない`);
    else if (ids.has(p.id)) out.push(`${at}: id "${p.id}" が重複している`);
    ids.add(p?.id);
    const n = normName(p?.name);
    if (!n) {
      out.push(`${at}: 氏名(name)がない`);
      return;
    }
    if (names.has(n)) out.push(`${at}: 氏名 "${n}" が重複している。同姓同名は区別できる表記にする`);
    names.add(n);
    const ai = aiNameReason(n);
    if (ai && p.nameConfirmed !== true) {
      out.push(
        `${at}: "${n}" は ${ai}。名簿に書けるのは自然人だけである` +
          '(同じ語を含む実在の氏名の場合は、人が確認したうえで nameConfirmed: true を書く)'
      );
    }
    if (p.nameConfirmed !== undefined && typeof p.nameConfirmed !== 'boolean') out.push(`${at}: nameConfirmed は true / false で書く`);
    if (p.accountsConfirmed !== undefined) {
      if (!Array.isArray(p.accountsConfirmed) || p.accountsConfirmed.some((c) => typeof c !== 'string' || !accountKey(c))) out.push(`${at}: accountsConfirmed はアカウント名の配列で書く`);
      else {
        const own = new Set((Array.isArray(p.accounts) ? p.accounts : []).map(accountKey));
        for (const c of p.accountsConfirmed) if (!own.has(accountKey(c))) out.push(`${at}: accountsConfirmed の "${c}" は、この人の accounts に無い`);
      }
    }
    if (performers.has(n)) out.push(`${at}: "${n}" は担い手の識別(performer)と同じ文字列である`);
    if (p.external !== undefined && typeof p.external !== 'boolean') out.push(`${at}: external は true / false で書く`);
    // 組織上の任命権者(第3章 3.13.3)。体制の外の人として記載する。実際に任命の権限を持つかは、機械で確かめない
    if (p.appointer !== undefined && typeof p.appointer !== 'boolean') out.push(`${at}: appointer は true / false で書く`);
    else if (p.appointer === true && p.external !== true) {
      out.push(`${at}: "${n}" を組織上の任命権者(appointer: true)とするなら、体制の外の人(external: true)として記載する(標準 第3章 3.13.3)`);
    }
    // リポジトリ上のアカウント。承認したアカウントを名簿の人へ対応づけるために使う。
    // 記載が正しいかは機械で確かめない(架空の2人目を書ける)。監査観点6 で確かめる
    if (p.accounts !== undefined) {
      if (!Array.isArray(p.accounts)) out.push(`${at}: accounts は配列で書く(リポジトリ上のアカウント名)`);
      else {
        for (const a of p.accounts) {
          const key = accountKey(a);
          if (typeof a !== 'string' || !key) {
            out.push(`${at}: accounts に空の値、または文字列でない値がある`);
            continue;
          }
          const bot = aiNameReason(a, { account: true });
          // 人が確認したアカウント(accountsConfirmed)は、AI を示す語に当たっても名簿に置ける。ただし [bot] の表記は上書きしない。
          // 確認は名簿の変更として、本人以外が記名した変化点の記録を要する(accountConfirmationProblems。#296)
          const confirmed = Array.isArray(p.accountsConfirmed) && p.accountsConfirmed.some((c) => accountKey(c) === key) && !/\[bot\]$/i.test(a.trim());
          if (bot && !confirmed) {
            out.push(
              `${at}: アカウント "${a}" は ${bot}。人のアカウントに限る。AI・bot のアカウントを、人の名簿へ書かない` +
                '(同じ語を含む実在の人のアカウントは、本人以外の記名で accountsConfirmed へ書く)'
            );
          }
          if (accounts.has(key)) out.push(`${at}: アカウント "${a}" が重複している。1つのアカウントは1人に対応づける`);
          accounts.add(key);
        }
      }
    }
  });
  // 記名の照合(resolveSigner)は、氏名・名簿の id・アカウントを同じ並びで引く。ある人の氏名と別の人のアカウント、
  // アカウントと別の人の id のように、別の人の識別と重なる記入は、記名を1人へ対応づけられないため拒否する(K75)。
  // 同じ種類どうしの重複は上で数える。氏名どうしは、空白・括弧書き・敬称を落として初めて重なる場合だけをここで数える
  const owners = new Map();
  roster.forEach((p, i) => {
    const keys = [
      ['id', typeof p?.id === 'string' ? p.id.toLowerCase() : '', p?.id],
      ['氏名', signerKey(p?.name), p?.name],
      ...(Array.isArray(p?.accounts) ? p.accounts : []).filter((a) => typeof a === 'string').map((a) => ['アカウント', accountKey(a), a]),
    ];
    for (const [what, key, raw] of keys) {
      if (!key) continue;
      const o = owners.get(key);
      if (!o) owners.set(key, { i, what, raw });
      else if (o.i !== i && (o.what !== what || (what === '氏名' && normName(o.raw) !== normName(raw)))) {
        out.push(`people[${i}]: ${what} "${raw}" が、people[${o.i}] の${o.what} "${o.raw}" と重なる。記名を1人へ対応づけられないため、別の人の氏名・id・アカウントと重ならない表記にする`);
      }
    }
  });
  return out;
}

/** アカウント名を比べるためのキー(大文字と小文字を区別しない。先頭の @ は落とす) */
export function accountKey(account) {
  return typeof account === 'string' ? account.normalize('NFKC').trim().replace(/^@/, '').toLowerCase() : '';
}

/** アカウントから名簿の人を引く。対応づかなければ null */
export function findPersonByAccount(config, account) {
  const key = accountKey(account);
  if (!key) return null;
  const roster = Array.isArray(config.people) ? config.people : [];
  return roster.find((p) => (Array.isArray(p?.accounts) ? p.accounts : []).some((a) => accountKey(a) === key)) ?? null;
}

/**
 * 記名を照合するためのキー。空白・括弧書き(肩書きなど)・末尾の敬称・先頭の @ を落とす。
 * 「山田太郎」「山田　太郎」「山田 太郎(開発)」「山田 太郎 様」を同じ記名として扱う
 */
export function signerKey(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[(][^()]*[)]/g, '')
    .replace(/\s+/g, '')
    .replace(/^@/, '')
    .replace(/(さん|さま|様|殿|氏|くん|君)$/u, '')
    .toLowerCase();
}

/**
 * 記名(氏名・名簿の id・アカウント)を名簿の人へ対応づける。対応づかない、または複数の人に当たる記名は null。
 * 例外承認の承認した者、作成を指示した者、即時通知の通知先の照合に使う(文字列の完全一致で比べない)
 */
export function resolveSigner(config, ref) {
  const direct = findPerson(config, ref);
  if (direct) return direct;
  const key = signerKey(ref);
  if (!key) return null;
  const roster = Array.isArray(config.people) ? config.people : [];
  const hits = new Set(roster.filter((p) => p?.id?.toLowerCase() === key || signerKey(p?.name) === key));
  const byAccount = findPersonByAccount(config, key);
  if (byAccount) hits.add(byAccount);
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * 記入があるか。空欄、「—」「-」、「未定」「未記入」「なし」などの記入でない値、様式の説明(<…>)を残した値は、
 * 記入なしとして扱う。変更種別の登録の根拠(basis)と、例外承認の記録の欄で、同じ判定を使う
 */
export function isFilledValue(v) {
  const s = String(v ?? '').replace(/\*/g, '').normalize('NFKC').trim();
  if (!s) return false;
  if (/^[—\-–ー―‐_.。・?]+$/.test(s)) return false;
  if (/^(未定|未記入|未作成|なし|無し|特になし|該当なし|不明|空欄|tbd|todo|n\/?a|none|null|undefined|x+)$/i.test(s)) return false;
  // 様式の置き場の文字列(<…>)。全体が置き場のもの、または日本語の置き場を含むもの
  if (/^<.*>$/.test(s) || /<[^<>]*[^\x00-\x7F][^<>]*>/.test(s)) return false;
  return true;
}

/**
 * 例外承認の「対象」が、変更でなくゲートの判定を指すか(#286)。`G-2 F-001`・`G-1 P-001` の形(ゲートと、判定記録の
 * 対象)。この形の行は、変更(PR・コミット)の例外承認として対応づけない。指さなければ null
 */
export function gateExceptionTarget(target) {
  const m = /^(G-[1-8]|SG\d?)\s+([A-Za-z]+-\d+|v?\d+(?:\.\d+)*[\w.-]*)$/i.exec(String(target ?? '').replace(/[*`]/g, '').normalize('NFKC').trim());
  return m ? { gate: m[1].toUpperCase(), subject: m[2] } : null;
}

/** 例外承認の行が有効を示す状態の値。完全一致で判定する(前方一致で判定しない) */
export const ACTIVE_EXCEPTION_STATES = ['未返却', '未回収', '有効'];

// 技術負債台帳(テンプレ3)の欄は見出し行の欄名で読む。見出し行に「区分」と「状態」を持たない旧い台帳は、
// 位置で読む(区分=2列目、内容=3列目、状態=最後の列)。旧い台帳は「対象」と「承認した者」の欄を持たない
const LEDGER_COLUMNS = {
  kind: ['区分'],
  target: ['対象'],
  content: ['内容'],
  reason: ['受容した理由', '受容理由'],
  due: ['返却の目安', '返却目安'],
  state: ['状態'],
  approver: ['承認した者'],
  recorder: ['記録者'],
};

/**
 * 技術負債台帳の本文から、全行を読む。出荷判定の証跡の集約(例外承認の対応づけ)と、G-5 の PR の検査
 * (基底ブランチの台帳にある例外承認)が、同じ読み方を使う
 */
export function parseLedger(text) {
  const rows = [];
  let header = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (cells.includes('区分') && cells.includes('状態')) {
      header = cells;
      continue;
    }
    if (!/^\**D-\d+/.test(cells[0] ?? '')) continue;
    const at = (key) => {
      if (!header) return null;
      const i = header.findIndex((h) => LEDGER_COLUMNS[key].includes(h.replace(/\*/g, '')));
      return i >= 0 ? (cells[i] ?? '') : null;
    };
    rows.push(
      header
        ? {
            id: cells[0].replace(/\*/g, ''),
            kind: String(at('kind') ?? '').replace(/\*/g, ''),
            target: at('target'),
            content: at('content') ?? '',
            reason: at('reason'),
            due: at('due'),
            state: at('state') ?? '',
            approver: at('approver'),
            recorder: at('recorder'),
            text: cells.join(' '),
          }
        : {
            id: cells[0].replace(/\*/g, ''),
            kind: String(cells[1] ?? '').replace(/\*/g, ''),
            target: null,
            content: cells[2] ?? '',
            reason: null,
            due: null,
            state: cells[cells.length - 1] ?? '',
            approver: null,
            recorder: null,
            text: cells.join(' '),
          }
    );
  }
  return rows;
}

/** 期限の欄から日付(YYYY-MM-DD または YYYY/MM/DD)を取り出す。実在する日付として解釈できなければ null */
export function dueDayOf(v) {
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(v ?? '').normalize('NFKC'));
  if (!m) return null;
  const day = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return isRealDay(day) ? day : null;
}

/** 名簿の人が、組織上の任命権者(体制の外の人。appointer: true)か */
export function isAppointer(config, ref) {
  const p = findPerson(config, ref);
  return p?.external === true && p?.appointer === true;
}

/**
 * 出荷判定者 × 事業決裁者の兼務禁止(標準 第3章 3.5)。異議を書く者と、残存リスクを受容する者が
 * 同一になり、受容が自己完結する。3名以上は拒否、1〜2名は逸脱として記録する。
 *
 * 知識ベース(scripts/vendor/tailoring-kb.json の separations)が同じ2席の組を持てば、そちらを使う。
 * 持たない版の知識ベースでも働くよう、構成の生成が足す(generate-profile.mjs の buildConfig)
 */
export const SHIPPING_BUSINESS_SEPARATION = {
  id: 'sep-shipping-business',
  roles: ['qa-gatekeeper', 'biz-approver'],
  scope: 'same-project',
  reason: '異議を書く者と、残存リスクを受容する者が同一である(G-8 の受容が自己完結する)',
  exception: '1〜2名体制で分離が成立しない場合に限り、逸脱として記録し、保証の開示の項目1 へ表示する(第3章 3.5)',
  gate: null,
  source: 'https://takenori-kusaka.github.io/process-compass/phase4-process-design/roles-responsibilities/',
};

/**
 * 独立レビュー(G-6)が成立しているか。適用する状態で、未達の記録が無い場合に限る。
 * 成立から未達・成立しないへ変わる変化は、即時通知の対象である(標準 第3章 3.13.6 の事象5)
 */
export function g6Established(config) {
  const s = config?.gates?.g6?.state;
  return (s === 'required' || s === 'simplified') && !(config?.unmet ?? []).some((u) => u.gate === 'g6');
}

/**
 * D-0 表1「体制と運用形態」の決定者の席(標準 第5章 5.5.4 / 第3章 3.13.3)。既定は事業決裁者。
 * 構成(governance.structureDecider)を正とし、D-0 の検査が表1 の記入との一致を確かめる
 */
export const DEFAULT_STRUCTURE_DECIDER = 'biz-approver';
export function structureDeciderSeat(config) {
  const role = config.governance?.structureDecider;
  return (config.seats ?? []).some((s) => s.role === role) ? role : DEFAULT_STRUCTURE_DECIDER;
}

/** 表示に使う、決定者の席の呼び名 */
export function structureDeciderLabel(config) {
  const role = structureDeciderSeat(config);
  const name = (config.seats ?? []).find((s) => s.role === role)?.name ?? '事業決裁者';
  return `${name}の席の責任者(D-0 表1「体制と運用形態」の決定者)`;
}

/**
 * 統制を緩める向きの決定をしてよい人(標準 第5章 5.5.7 / 第3章 3.13.3)。
 * 対象の席の責任者、または D-0 表1「体制と運用形態」の決定者(既定は事業決裁者の席の責任者)に限る。
 * 席を特定できない決定(ゲートの状態、軸の入力)は、後者に限る。
 */
export function allowedDeciders(config, seatRole = null) {
  const keys = new Set();
  for (const role of [seatRole, structureDeciderSeat(config)]) {
    const seat = role ? (config.seats ?? []).find((s) => s.role === role) : null;
    const key = personKey(config, seat?.accountable);
    // 独立レビュアの席の責任者に置いた外部の確認者には、その席の統制を緩める向きの決定権を与えない
    // (標準 第3章 3.5・3.13.3。#307 / ADR-0060 決定2)。決定できるのは D-0 表1「体制と運用形態」の決定者である
    if (role === 'independent-reviewer' && role === seatRole && findPerson(config, seat?.accountable)?.external === true) continue;
    if (key) keys.add(key);
  }
  return keys;
}

/** 委任の規則を決定した者が、現在の席の責任者、または D-0 表1「体制と運用形態」の決定者かを確かめる */
export function ruleDeciderProblems(config, rule) {
  const out = [];
  if (!rule?.decidedBy || !rule?.reason) {
    out.push('決定した者(decidedBy)または理由(reason)がない。委任の範囲は人が記名で定める');
    return out;
  }
  const hint = `責任者が交代したときは、新しい責任者が規則を確かめて記名し直す(/process-change の入力へ "takeover": "${rule.seat}" と、新しい責任者の decidedBy・reason を書くと、規則の記名のし直し・適合性確認の承認し直し・委任への復帰を1つの入力で受け付ける)`;
  const named = nameProblems(config, rule.decidedBy, { requireRoster: true });
  out.push(...named.map((p) => `決定した者の記名を受け付けられない(${p})。${hint}`));
  if (named.length) return out;
  if (!allowedDeciders(config, rule.seat).has(personKey(config, rule.decidedBy))) {
    out.push(
      `決定した者 "${rule.decidedBy}" は、対象の席の責任者でも、${structureDeciderLabel(config)}でもない。` +
        hint
    );
  }
  return out;
}

/** 委任の規則の変更を承認する席(標準 第3章 3.11.2: 指示資産・強制層の承認権限) */
export const RULE_APPROVER_SEAT = 'ai-maintainer';

/**
 * 委任の規則に、AI維持管理者の承認があるかを確かめる(標準 第5章 5.5.7 / ADR-0038)。
 *
 * 委任の該当を判定する機械の規則は強制層である。規則の追加と範囲の拡大は、事前の承認という
 * 遮断を外す変更であり、統制の弱化として扱う。委任するという決定(席の責任者)とは別に、
 * 規則そのものの変更を AI維持管理者の席の責任者が承認する。席の責任者と同一人物でもよい。
 * その場合も、どの席で判断したかを記録に残す。承認の無い規則では、委任を有効にしない。
 */
export function ruleApprovalProblems(config, rule) {
  if (!rule?.approvedBy) {
    return ['AI維持管理者の承認(approvedBy)がない。規則の追加・拡大は統制の弱化であり、AI維持管理者の席の責任者が承認する(state:needs-platform)'];
  }
  const out = nameProblems(config, rule.approvedBy, { requireRoster: true }).map((p) => `規則の承認者の記名を受け付けられない(${p})`);
  const maintainer = (config.seats ?? []).find((s) => s.role === RULE_APPROVER_SEAT)?.accountable;
  if (!maintainer) out.push('AI維持管理者の席の責任者が未記入のため、規則の承認者を照合できない');
  else if (personKey(config, maintainer) !== personKey(config, rule.approvedBy)) {
    out.push(
      `規則の承認者 "${rule.approvedBy}" は、AI維持管理者の席の責任者ではない。` +
        '責任者が交代したときは、新しい責任者が規則を確かめて承認し直す'
    );
  }
  return out;
}

/**
 * 構成に書かれた記名(席の責任者、適合性確認の承認者)の問題を返す。
 * 名簿との照合は、委任を宣言した席で必須にする。名簿が記入済みなら、すべての席で照合する。
 */
export function namingProblems(config) {
  const out = rosterProblems(config).map((p) => `人の名簿: ${p}`);
  for (const s of config.seats ?? []) {
    const label = s.name ?? s.role;
    const requireRoster = s.mode === 'delegated';
    if (s.accountable) {
      for (const p of nameProblems(config, s.accountable, { requireRoster })) out.push(`${label} の責任者: ${p}`);
      if (isAppointer(config, s.accountable)) {
        out.push(`${label} の責任者: "${personName(config, s.accountable)}" は組織上の任命権者(体制の外の人)として名簿にある。任命権者を席の責任者にしない(標準 第3章 3.13.3)`);
      }
    }
    // 承認者が離脱して失効した確認は、記録として残す。離任した人の記名を、現在の名簿と照合しない
    if (s.qualification?.approvedBy && !s.qualification.lapsed) {
      for (const p of nameProblems(config, s.qualification.approvedBy, { requireRoster })) {
        out.push(`${label} の適合性確認の承認者: ${p}`);
      }
    }
  }
  return out;
}

/**
 * 適合性確認の実施者と承認者が、標準の定める者かを確かめる(標準 第3章 3.4.2 の要求事項4)。
 * 実施は AI維持管理者の席の責任者、承認は当該の席の責任者に限る。
 *
 * 失効の契機は2つある。確認の記録(事例と結果)の失効は、担い手の識別の変化による。承認の失効は、
 * 承認した席の責任者の交代による(離脱を含む。前の責任者が名簿に残るかどうかに依らない。要求事項9)。
 * 承認は新しい責任者へ引き継がれない。記録は有効なまま残り、新しい責任者が承認し直すまで協働を上限とする。
 * 失効の印(qualification.lapsed)は /process-change が付け、qualificationProblems が失効として返す
 */
export function qualificationAuthorityProblems(config, seat, { reapproval = false } = {}) {
  const q = seat?.qualification;
  if (!q) return [];
  const out = [];
  const label = seat.name ?? seat.role;
  const maintainer = (config.seats ?? []).find((s) => s.role === RULE_APPROVER_SEAT)?.accountable;
  // 承認し直し(責任者の交代で失効した承認を、新しい責任者が書く)では、確認の記録は当時のままであり、
  // 実施者を現在の席と照合しない
  // 承認し直しでも、実施者の名義が AI を示す語を含む記録は受け付けない(名簿とは照合しない)
  for (const p of nameProblems(config, q.performedBy, { requireRoster: true, checkRoster: !reapproval })) out.push(`${label} の適合性確認の実施者: ${p}`);
  for (const p of nameProblems(config, q.approvedBy, { requireRoster: true })) out.push(`${label} の適合性確認の承認者: ${p}`);
  if (out.length) return out;
  if (reapproval) {
    // 実施者は照合しない
  } else if (!maintainer) out.push(`${label} の適合性確認: AI維持管理者の席の責任者が未記入のため、実施者を照合できない`);
  else if (personKey(config, maintainer) !== personKey(config, q.performedBy)) {
    out.push(`${label} の適合性確認の実施者 "${q.performedBy}" は、AI維持管理者の席の責任者ではない(標準 第3章 3.4.2: 実施は AI維持管理者が行う)`);
  }
  if (!seat.accountable) out.push(`${label} の適合性確認: 席の責任者が未記入のため、承認者を照合できない`);
  else if (personKey(config, seat.accountable) !== personKey(config, q.approvedBy)) {
    out.push(`${label} の適合性確認の承認者 "${q.approvedBy}" は、この席の責任者ではない(標準 第3章 3.4.2: 承認は席の責任者が行う)`);
  }
  return out;
}

/**
 * 最小体制を割っている理由を返す。割っていなければ null(標準 第8章 軸A・軸E)。
 *
 * 安全重要度 CL1 以上と規制業は、1〜2名の体制で成立しない。初期化では拒否する。
 * 設定済みの構成で人の離脱などにより生じた場合は、拒否せずに反映し、出荷できない状態
 * (shipBlocked)として表示する。旧い構成のまま止めると、実態と構成が食い違う(第3章 3.13.3)
 */
export function belowMinimumStaffing(answers, cause = 'headcount') {
  if (answers?.['q-team-size'] !== 'size-1-2') return null;
  const why = [];
  const cl = answers['q-criticality'];
  if (['cl1', 'cl2', 'cl3'].includes(cl)) why.push(`安全重要度 ${cl.toUpperCase()}`);
  if (answers['q-quality'] === 'quality-regulated') why.push('規制業');
  if (!why.length) return null;
  // 原因で書き分ける。人数の減少(headcount)と、1〜2名の体制のまま区分が上がった場合(criticality)
  return cause === 'criticality'
    ? `1〜2名の体制のまま、案件が CL1 以上・規制業になった(${why.join('、')}。体制は 1〜2名)。出荷できない(第5章 5.5.7、ADR-0028)`
    : `CL1 以上・規制業で体制が3名を割った(${why.join('、')}。体制は 1〜2名)。出荷できない(第5章 5.5.7、ADR-0028)`;
}

/** 出荷できない状態の記録と、回答の整合を確かめる */
export function shipBlockedProblems(config) {
  const reason = belowMinimumStaffing(config.answers);
  const sb = config.shipBlocked ?? null;
  if (reason && !sb) {
    return ['安全重要度 CL1 以上または規制業を 1〜2名の体制で扱う構成ですが、出荷できない状態(shipBlocked)の記録がありません(第8章 軸A・軸E)'];
  }
  if (!reason && sb) return ['shipBlocked がありますが、回答は最小体制を割っていません。/process-change で構成を再生成してください'];
  if (sb && !(sb.reason && sb.since)) return ['shipBlocked に理由(reason)または発生日(since)がありません'];
  return [];
}

/**
 * 体制の人数と、チーム規模の回答のずれを返す(標準 第3章 3.13.1 の変化点2)。
 *
 * 体制の内の人は、席の責任者と人の名簿から数える。外部の確認者(external)は数えない。
 * 人が離れて3名を割ったのに回答が3名以上のままの構成は、成立しない分離を成立と表示する。
 */
export function headcountProblems(config) {
  const out = [];
  const size = config.answers?.['q-team-size'];
  const insiders = new Set(
    (config.seats ?? [])
      .map((s) => s.accountable)
      .filter((n) => n && findPerson(config, n)?.external !== true)
      .map((n) => personKey(config, n))
  ).size;
  const rosterInsiders = (Array.isArray(config.people) ? config.people : []).filter((p) => p?.external !== true).length;
  const headcount = Math.max(insiders, rosterInsiders);
  if (size === 'size-1-2' && headcount >= 3) {
    out.push(
      `体制の内の人が ${headcount} 名いますが(席の責任者と人の名簿から数えた)、チーム規模の回答は 1〜2名のままです。人数の境界の通過は体制の変化点です(answers の q-team-size を改めます)`
    );
  }
  // 10名の境界。レビューの方式、出荷判定者の方式、分離を必須とする組が変わる(第8章 軸A)
  if (size === 'size-3-9' && headcount >= 10) {
    out.push(
      `体制の内の人が ${headcount} 名いますが(席の責任者と人の名簿から数えた)、チーム規模の回答は 3〜9名のままです。10名の境界の通過は体制の変化点です(answers の q-team-size を size-10plus へ改めます)`
    );
  }
  if (size === 'size-10plus' && rosterInsiders >= 3 && rosterInsiders < 10) {
    out.push(
      `人の名簿の体制の内の人は ${rosterInsiders} 名ですが、チーム規模の回答は 10名以上のままです。10名の境界の通過は体制の変化点です(answers の q-team-size を size-3-9 へ改めます。席の責任者でない担い手も、名簿へ記入します)`
    );
  }
  if (size && size !== 'size-1-2' && rosterInsiders > 0 && rosterInsiders < 3) {
    out.push(
      `人の名簿の体制の内の人は ${rosterInsiders} 名ですが、チーム規模の回答は 3名以上のままです。人の離脱で成立しなくなった統制は、未達・逸脱として即時に反映します(answers の q-team-size を size-1-2 へ改めます。席の責任者でない担い手も、名簿へ記入します)`
    );
  }
  return out;
}

/**
 * 回答と、席・名簿の記入の矛盾を返す(標準 第3章 3.13.5)。
 *
 * 1〜2名の体制で「作成を指示した本人以外の確認者はいない」と回答した構成は、独立レビュー(G-6)を
 * 未達として表示する。その構成で、独立レビュアの席に開発者の席と別の人を記入すると、表示は未達の
 * まま、変更ごとの集計では「独立した人の確認あり」に数えられる。どちらかが実態と合っていない
 */
export function answersRosterProblems(config) {
  const out = [];
  const a = config.answers ?? {};
  const seat = (role) => (config.seats ?? []).find((s) => s.role === role);
  const dev = seat('dev-verifier')?.accountable;
  const rev = seat('independent-reviewer')?.accountable;
  if (
    a['q-team-size'] === 'size-1-2' &&
    a['q-external-reviewer'] === 'reviewer-no' &&
    personKey(config, dev) &&
    personKey(config, rev) &&
    personKey(config, dev) !== personKey(config, rev)
  ) {
    out.push(
      `回答は「作成を指示した本人以外の確認者はいない」(q-external-reviewer: reviewer-no)ですが、独立レビュアの席の責任者(${personName(config, rev)}${
        findPerson(config, rev)?.external ? '。外部の確認者' : ''
      })は、開発者の席の責任者(${personName(config, dev)})と別の人です。` +
        '確認できる人がいるなら、回答を reviewer-yes へ改めます(G-6 が成立し、承認を強制する設定が入ります)。いないなら、独立レビュアの席へ別の人を記入しません'
    );
  }
  return out;
}

/**
 * 1〜2名の体制で、作成を指示した本人以外の確認者を、人の名簿と席から確かめられるか
 * (標準 第4章 G-6。#302 / ADR-0065 決定5)。
 *
 * 確かめられるのは、開発者の席と独立レビュアの席の責任者がどちらも記入されており、別の人である場合に限る。
 * テーラリングの設問(q-external-reviewer)への回答は、判定の根拠にしない。席が未記入のあいだは、確かめられない側
 * (未達)へ倒す。3名以上の体制には当てない(applies: false)
 */
export function confirmerOnRoster(config) {
  if (config?.answers?.['q-team-size'] !== 'size-1-2') return { applies: false, shown: true, why: null, blank: [] };
  const seat = (role) => (config.seats ?? []).find((s) => s.role === role);
  const dev = personKey(config, seat('dev-verifier')?.accountable);
  const rev = personKey(config, seat('independent-reviewer')?.accountable);
  const blank = [!dev ? '開発者' : null, !rev ? '独立レビュア' : null].filter(Boolean);
  if (blank.length) return { applies: true, shown: false, why: 'blank', blank };
  if (dev === rev) return { applies: true, shown: false, why: 'same', blank: [] };
  return { applies: true, shown: true, why: null, blank: [] };
}

/**
 * 回答と名簿の食い違いのうち、「確認者がいる」と回答して、名簿と席からは確認者を確かめられない向き
 * (標準 第4章 G-6。#302 / ADR-0065 決定5)。
 *
 * 逆の向き(「いない」と回答して、席へ別の人を記入)は answersRosterProblems が拒否する。この向きは拒否しない。
 * 人の離脱で確認者がいなくなった構成を、回答の書き換えを待たずに未達へ反映するためである(第3章 3.13.3)。
 * 独立レビュー(G-6)は未達として表示され、ここで返す文は注記として出る
 */
export function answersRosterNotices(config) {
  const c = confirmerOnRoster(config);
  if (!c.applies || c.shown || config.answers?.['q-external-reviewer'] !== 'reviewer-yes') return [];
  const why = c.why === 'same' ? '独立レビュアの席の責任者が、開発者の席の責任者と同一人物' : `${c.blank.join('・')}の席の責任者が未記入`;
  return [
    `回答は「作成を指示した本人以外の確認者がいる」(q-external-reviewer: reviewer-yes)ですが、人の名簿と席からは確認者を確かめられません(${why})。` +
      '回答は判定の根拠にしません。独立レビュー(G-6)は未達として表示します。確認できる人がいるなら、人の名簿へ記入し、独立レビュアの席の責任者にします。いないなら、回答を reviewer-no へ改めます',
  ];
}

/**
 * 構成だけから確かめられる整合を、まとめて返す(契約検査のうち、リポジトリの設定ファイルに依らない部分)。
 *
 * 出荷の証跡の集約が呼ぶ。PR を経ない体制では、契約検査が走らないまま出荷へ進む場合があるため、
 * 集約の時点でも、変化点を経ない書き換え(要約値の連鎖)と、回答・名簿・席の食い違いを確かめる。
 * 返した問題は、記録の欠落として扱う。要約値ごと書き換えた偽造は、ここでも検出できない
 */
export function configIntegrityProblems(config) {
  if (!config || config.configured === false) return [];
  const out = [];
  const chain = chainProblems(config);
  if (chain.legacy) {
    out.push('変化点の記録(changeLog[])に要約値がありません(旧い構成)。構成が変化点を経ずに書き換えられていないかを確かめられません。/process-change を1回実行すると、要約値の連鎖が始まります');
  }
  out.push(...chain.problems);
  out.push(...answersRosterProblems(config), ...headcountProblems(config), ...shipBlockedProblems(config));
  for (const p of namingProblems(config)) out.push(`記名を受け付けられません: ${p}`);
  for (const s of config.seats ?? []) {
    const ceiling = SEAT_CEILING[s.role] ?? 'delegated';
    if (!SEAT_MODES.includes(s.mode) || modeRank(s.mode) > modeRank(ceiling)) {
      out.push(`${s.name ?? s.role}: 運用形態「${MODE_LABEL[s.mode] ?? s.mode}」は、席の上限「${MODE_LABEL[ceiling]}」を超えています(第5章 5.5.6)`);
    }
  }
  const a = config.answers ?? {};
  if ((a['q-criticality'] !== 'cl0' || a['q-quality'] === 'quality-regulated') && config.delegation?.allowed === true) {
    out.push('delegation.allowed が true ですが、安全重要度 CL1 以上、または規制業では委任を適用しません(第5章 5.5.4 条件1)');
  }
  for (const p of changeTypeProblems(config, { checkRegistrant: false })) out.push(`標準変更カタログ: ${p}`);
  out.push(...protectedPathsProblems(config));
  (Array.isArray(config.changeLog) ? config.changeLog : []).forEach((e, i) => {
    if (SIGNED_DIRECTIONS.includes(e?.direction) && !(e.decidedBy && e.reason)) {
      out.push(`changeLog[${i}]: ${DIRECTION_LABEL[e.direction]}向きの変更に、決定した者の記名または理由がありません(第3章 3.13.3)`);
    }
  });
  return out;
}

// ---------------------------------------------------------------- 委任の規則

/**
 * 委任の規則が対象にできないパス。強制層・構成の正本・判定の記録は、規則に当たっても
 * 委任の範囲へ入れない(標準 第5章 5.5.5: 委任の範囲の決定と指示資産の確定は、人が行う)
 */
export const NEVER_DELEGATED = [
  'process.config.json',
  'PROCESS-PROFILE.md',
  'CLAUDE.md',
  'AGENTS.md',
  'CODEOWNERS',
  '.claude/**',
  '.github/**',
  'adapters/**',
  'scripts/gate/**',
  'scripts/init/**',
  'scripts/vendor/**',
  'docs/gates/**',
  'docs/D-0-governance.md',
  // 第5章 5.4.6 の停止を導く元の記録。委任された変更が自らの停止を解けないようにする(process-compass #311 X-1)
  'docs/defect-ledger.md',
  'docs/handover.md',
];

/**
 * 対象のパスの指定が広すぎる場合、その理由を返す。
 *
 * 委任の範囲は、標準変更カタログに登録した変更種別に当たる変更に限る(標準 第3章 3.7.4)。
 * リポジトリの全域、ルート直下の全体、先頭の階層を特定しない指定は、種別を特定しない。
 */
export function broadPathReason(glob) {
  const g = String(glob ?? '').trim().replace(/\\/g, '/').replace(/^(\.?\/)+/, '');
  if (!g) return '空の指定である';
  if (g.split('/').includes('..')) return '上位の階層を指している';
  if (g.split('/')[0].includes('*')) {
    return 'リポジトリの全域またはルート直下の全体に当たる。先頭の階層を特定する(例: src/i18n/**)';
  }
  return null;
}

/**
 * 標準変更カタログへ登録した変更種別の一覧(delegation.changeTypes[])の問題を返す(標準 第3章 3.7.4)。
 *
 * 登録するのはリリース判定会(B-4)、置かない体制では D-0 表1「体制と運用形態」の決定者である
 * (governance.catalogRegistrar。'b4' は会議体を指し、構成員かどうかは機械で確かめない)。
 * 登録した者は記名の自然人とし、名簿と照合する。checkRegistrant を偽にすると、過去の登録者を
 * 現在の名簿・席と照合しない(離任した人の登録を残すため。AI の名義だけを拒否する)
 */
/**
 * 変更種別の登録の根拠(標準 第5章 5.5.4「登録の根拠の記録」)。3点の記録が無い種別は登録しない。
 * 機械が確かめるのは記入の有無だけである。内容は、登録する者が判定する
 */
export const CHANGE_TYPE_BASIS = [
  ['detection', '第5章 5.4.6 の第2区分の検知条件ごとの、算出の所在'],
  ['rollback', '取り消しを実行した実績の所在'],
  ['tests', '既存のテストで検出できることの根拠'],
];

/**
 * basis.detection に書く検知条件(標準 第5章 5.4.6 の第2区分)。検知条件ごとに、算出の所在
 * (算出元の記録と、算出する手段の置き場)を書く。1つの文にまとめた記入は、記入なしとして扱う
 */
export const CHANGE_TYPE_DETECTION = [
  ['rejectionRate', '差し戻し率'],
  ['reworkRate', '手戻り率'],
];

/**
 * 検知条件から外した欄(process-compass ADR-0080)。旧い構成に残っていても読まない。登録の要件にも数えない。
 * 残っている種別を、次の一手の注記へ出す(消すかどうかは /process-change で人が決める)
 */
export const RETIRED_DETECTION = ['duplicationRate']; // retired-ok: 外した旧い欄の名を、読まずに警告するために持つ

/** 外した検知条件の欄が残っている変更種別の ID */
export function retiredDetectionTypes(config) {
  const list = Array.isArray(config?.delegation?.changeTypes) ? config.delegation.changeTypes : [];
  return list
    .filter((t) => t?.basis?.detection && typeof t.basis.detection === 'object' && RETIRED_DETECTION.some((k) => k in t.basis.detection))
    .map((t) => String(t.id ?? '').trim());
}

/** 登録の根拠のうち、記入が無いものを [キー, 名前] の配列で返す */
function missingBasis(basis) {
  const out = [];
  const d = basis?.detection;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) {
    out.push(['detection', `${CHANGE_TYPE_BASIS[0][1]}(${CHANGE_TYPE_DETECTION.map(([k, label]) => `${k}: ${label}`).join('・')} を、それぞれ書く)`]);
  } else {
    for (const [k, label] of CHANGE_TYPE_DETECTION) {
      if (typeof d[k] !== 'string' || !isFilledValue(d[k])) out.push([`detection.${k}`, `${label}の算出の所在`]);
    }
  }
  for (const [k, label] of CHANGE_TYPE_BASIS.slice(1)) {
    if (typeof basis?.[k] !== 'string' || !isFilledValue(basis[k])) out.push([k, label]);
  }
  return out;
}

export function changeTypeProblems(config, { checkRegistrant = true, only = null } = {}) {
  const list = config.delegation?.changeTypes;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['delegation.changeTypes が配列ではない'];
  const out = [];
  const ids = new Set();
  const registrar = config.governance?.catalogRegistrar ?? structureDeciderSeat(config);
  list.forEach((t, i) => {
    const id = String(t?.id ?? '').trim();
    const at = `delegation.changeTypes[${i}]`;
    if (!id) {
      out.push(`${at}: 変更種別の名称(id)がない`);
      return;
    }
    if (ids.has(id)) out.push(`${at}: 変更種別 "${id}" が重複している`);
    ids.add(id);
    if (!t.registeredBy || !isRealDay(t.registeredAt)) {
      out.push(`${at}: 変更種別 "${id}" に、登録した者(registeredBy)または登録日(registeredAt。実在する日付を YYYY-MM-DD で書く)がない`);
      return;
    }
    if (aiNameBlocked(config, t.registeredBy)) {
      out.push(`${at}: 変更種別 "${id}" を登録した者 "${t.registeredBy}" は ${aiNameBlocked(config, t.registeredBy)}。AI の名義の記名を受け付けない`);
      return;
    }
    if (only && !only.has(id)) return;
    // 様式の文言(<…>)や「—」「未定」などの記入でない値は、記入なしとして扱う(例外承認の記録の判定と同じ関数)
    const missing = missingBasis(t.basis);
    if (missing.length) {
      out.push(
        `${at}: 変更種別 "${id}" に、登録の根拠(basis)がない(${missing.map(([k, label]) => `${k}: ${label}`).join(' / ')})。` +
          '3点の記録が無い種別は登録しない(標準 第5章 5.5.4)。detection は、検知条件(差し戻し率・手戻り率)ごとに算出の所在を書く。' +
          '様式の文言(<…>)、「—」「未定」「なし」などは記入として扱わない。' +
          '機械が確かめるのは記入の有無だけであり、内容は登録する者が判定する'
      );
    }
    if (!checkRegistrant) return;
    for (const p of nameProblems(config, t.registeredBy, { requireRoster: true })) {
      out.push(`${at}: 変更種別 "${id}" を登録した者の記名を受け付けられない(${p})`);
    }
    if (registrar !== 'b4') {
      const seat = (config.seats ?? []).find((s) => s.role === registrar);
      if (!seat?.accountable || personKey(config, seat.accountable) !== personKey(config, t.registeredBy)) {
        out.push(
          `${at}: 変更種別 "${id}" を登録した者 "${t.registeredBy}" は、${seat?.name ?? registrar}の席の責任者ではない。` +
            '標準変更カタログへの登録は、D-0 表1「標準変更カタログへの登録」の決定者が行う'
        );
      }
    }
  });
  return out;
}

/** 確約範囲とコア指定のパス(delegation.protectedPaths[])の形式上の問題を返す。キーが無い構成は未宣言 */
export function protectedPathsProblems(config) {
  const list = config.delegation?.protectedPaths;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['delegation.protectedPaths が配列ではない'];
  return list.filter((p) => typeof p !== 'string' || !p.trim()).map(() => 'delegation.protectedPaths に空の値、または文字列でない値がある');
}

/**
 * 委任の規則1件の、形式上の問題を返す。決定した者の照合は呼び出し側で行う。
 * config を渡すと、変更種別が標準変更カタログ(delegation.changeTypes[])に登録されているかも確かめる
 */
export function delegationRuleProblems(rule, config = null) {
  const out = [];
  if (!rule?.id) out.push('id がない');
  const changeType = String(rule?.changeType ?? '').trim();
  if (!changeType) {
    out.push('変更種別(changeType)がない。標準変更カタログ(標準 第3章 3.7.4)に登録した変更種別を書く');
  } else if (config && !(config.delegation?.changeTypes ?? []).some((t) => String(t?.id ?? '').trim() === changeType)) {
    out.push(
      `変更種別 "${changeType}" は、標準変更カタログ(delegation.changeTypes[])に登録されていない。` +
        '登録するのはリリース判定会(B-4)、置かない体制では D-0 表1「体制と運用形態」の決定者である(標準 第3章 3.7.4)'
    );
  }
  if (!Array.isArray(rule?.paths) || !rule.paths.length) {
    out.push('対象のパス(paths)がない。該当は観測できる属性で登録する');
  } else {
    for (const p of rule.paths) {
      const why = broadPathReason(p);
      if (why) out.push(`対象のパス "${p}" は${why}`);
    }
  }
  if (rule?.excludePaths !== undefined && !Array.isArray(rule.excludePaths)) out.push('excludePaths が配列ではない');
  return out;
}

/** 旧い指定 olds が、新しい指定 p を覆うか。ワイルドカードは代表値へ展開して確かめる */
function coveredBy(olds, p) {
  if (olds.includes(p)) return true;
  const probes = [
    p.replace(/\*\*/g, 'zq9').replace(/\*/g, 'zq8'),
    p.replace(/\*\*/g, 'zq9/zq7/zq6').replace(/\*/g, 'zq8'),
  ];
  return olds.some((g) => probes.every((x) => matchGlob(g, x)));
}

/**
 * 規則の変更の向きを返す(標準 第5章 5.5.7)。
 *   'same'    対象は変わらない(記名・理由だけの変更)
 *   'narrow'  対象が狭まる。厳しくする向きであり、即時に適用する
 *   'widen'   それ以外。狭まると示せない変更は、広がるものとして扱う
 */
export function ruleChangeDirection(before, after) {
  const bp = before.paths ?? [];
  const ap = after.paths ?? [];
  const be = before.excludePaths ?? [];
  const ae = after.excludePaths ?? [];
  if (before.seat !== after.seat || (before.changeType ?? null) !== (after.changeType ?? null)) return 'widen';
  const same = (x, y) => x.length === y.length && x.every((v) => y.includes(v));
  if (same(bp, ap) && same(be, ae)) return 'same';
  const pathsNarrow = ap.length > 0 && ap.every((p) => coveredBy(bp, p));
  const excludesKept = be.every((e) => coveredBy(ae, e));
  return pathsNarrow && excludesKept ? 'narrow' : 'widen';
}

// ---------------------------------------------------------------- 指示資産の版

/**
 * 指示資産(CLAUDE.md・AGENTS.md・.claude/)の内容から導いた識別子を返す。
 *
 * 担い手の識別のうち「指示資産の版」は自己申告の文字列であり、実ファイルと食い違っても
 * 分からない。performer.instructions の末尾へ `@<この値>` を書いておくと、契約検査が
 * 実ファイルと照合する。構成から生成する区間は、構成の変更記録で追えるため除く。
 */
export function instructionAssetsDigest() {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (!/\/(\.self-heal|settings\.local\.json)$/.test(r)) files.push(r);
    }
  };
  walk('.claude');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) {
    let text = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    if (f === 'CLAUDE.md') {
      text = text.replace(/<!-- generated:process-rules start -->[\s\S]*?<!-- generated:process-rules end -->/, '');
    }
    h.update(f).update('\0').update(text).update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

/**
 * performer.instructions の申告と、実ファイルの照合。
 * 末尾が `@<16進7桁以上>` でない申告は照合できない(match: null)
 */
export function instructionsCheck(performer) {
  const declared = String(performer?.instructions ?? '').match(/@([0-9a-f]{7,64})$/)?.[1] ?? null;
  if (!declared) return { declared: null, actual: null, match: null };
  const actual = instructionAssetsDigest();
  return { declared, actual, match: actual.startsWith(declared) || declared.startsWith(actual) };
}

/**
 * 適合性確認の記録に欠けているものを返す(標準 第3章 3.4.2)。空なら有効。
 * 担い手の識別が確認時と異なる場合は失効として扱う。
 */
export function qualificationProblems(seat) {
  const q = seat.qualification;
  if (!q) return ['適合性確認の記録がない'];
  // 承認者が名簿から外れた確認は失効として扱う。離脱の変化点を止めない(第3章 3.13.3 / 第5章 5.5.7)
  if (q.lapsed) return [`適合性確認が失効している(${q.lapsed.reason ?? '失効'})`];
  const out = [];
  for (const [k, label] of [
    ['confirmedAt', '実施日'],
    ['performedBy', '実施者'],
    ['approvedBy', '承認者'],
    ['cases', '用いた事例'],
    ['result', '結果'],
  ]) {
    if (!q[k]) out.push(`適合性確認の${label}(${k})がない`);
  }
  if (performerKey(q.performer) !== performerKey(seat.performer)) {
    out.push('適合性確認が失効している(確認した担い手の識別と、現在の担い手の識別が異なる)');
  }
  return out;
}

/** パスが glob に当たるか。** と * だけを解釈する */
export function matchGlob(glob, file) {
  const re = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${re}$`).test(file.replace(/\\/g, '/'));
}

// ---------------------------------------------------------------- 挙動要約の最低限の形(第4章 G-6 基準2・条件4。#288 第8巡 X8)
//
// 承認レビューの本文、または判定記録の「挙動要約」の節が、承認した者自身の挙動要約として数えられる最低限の形。
// 機械が確かめるのは形だけであり、中身(変更の挙動を述べているか、自分の言葉か)は確かめない(内部監査の抜き取り)。
//   - 承認の語だけの本文(LGTM / OK / approve / 承認 / 問題なし など)は数えない
//   - 見出し語「挙動要約」とコメント・記号を除いた本文が、SUMMARY_MIN_CHARS 文字(空白と句読点を除く)以上あること(1〜2文の下限)
export const SUMMARY_MIN_CHARS = 8;
const SUMMARY_STOCK_PHRASES = /^(lgtm|ok|okay|good|fine|approve[d]?|approval|ship ?it|\+1|👍|承認|承認します|問題なし|問題ありません|良い|よい|良さそう|よさそう|確認しました|確認済み|見ました|ok です|okです|了解|rgr)$/i;
/** 本文が挙動要約の最低限の形を満たすか。満たさない理由を返す(満たせば null) */
export function behaviorSummaryShortfall(text) {
  const raw = String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .normalize('NFKC');
  const body = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[#>*\-・]+\s*)?(?:\*\*)?挙動要約(?:\*\*)?\s*[::]?\s*/u, '').trim())
    .filter(Boolean)
    .join(' ');
  const letters = body.replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!letters) return '本文が空(見出し語だけ)';
  if (SUMMARY_STOCK_PHRASES.test(letters.toLowerCase().replace(/\s+/g, ' '))) return `承認の語だけ(「${body.slice(0, 20)}」)`;
  if ([...letters].length < SUMMARY_MIN_CHARS) return `${[...letters].length} 文字(${SUMMARY_MIN_CHARS} 文字未満。1〜2文の挙動要約に満たない)`;
  return null;
}
export const hasBehaviorSummary = (text) => behaviorSummaryShortfall(text) === null;

/**
 * 2件の挙動要約が同一の文かを比べるための形(第4章 G-6。#305 / ADR-0067 決定3)。見出し語「挙動要約」・コメント・空白・記号を除き、
 * 英字の大小をそろえた文字の並び。最低限の形を満たさない本文は null(数えないので比べない)。
 * 機械が見るのは文の同一だけであり、言い換えた写しは検出しない(内部監査の抜き取り)
 */
export function behaviorSummaryKey(text) {
  if (behaviorSummaryShortfall(text) !== null) return null;
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .normalize('NFKC')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[#>*\-・]+\s*)?(?:\*\*)?挙動要約(?:\*\*)?\s*[::]?\s*/u, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

// ---------------------------------------------------------------- コア機能のパスと、コア機能の変更に要する承認者の数(第8章 軸C 高。#288 第8巡 Z7)
//
// 「コア機能」の機械の判定は、構成に既にある2つの宣言だけから導く(新しい欄を作らない)。
//   - 確約範囲・コア指定のパス(delegation.protectedPaths。委任を適用しない案件でも種別 mode で宣言できる)
//   - 区分の下限の規則のパス(riskFloor.rules[].paths。下限 R1・R2 のいずれも。kinds は見ない)
// どちらも無い構成では「未宣言」であり、コア機能の変更を判定できない(黙って通さず、未宣言と表示する)
// 宣言したパスが追跡中のファイルに1件も当たらなければ、そのパスは効いていない(誤記・移動の取り残し)。
// tracked(追跡中のファイルの一覧)を渡すと、当たるパスだけを数え、当たらないパスを unmatched に出す。
// 当たるパスが1件も無ければ「未宣言」とする(宣言が空振りしているのを、宣言済みとして扱わない。#296 L-9)。
// tracked を渡さない呼び出し(一覧を得られない場面)は、従来どおり宣言の有無だけで判定する
export function corePathsOf(config, { tracked = null } = {}) {
  const fromProtected = Array.isArray(config?.delegation?.protectedPaths) ? config.delegation.protectedPaths.filter((p) => typeof p === 'string' && p.trim()) : null;
  const fromFloor = (Array.isArray(config?.riskFloor?.rules) ? config.riskFloor.rules : []).flatMap((r) => (Array.isArray(r?.paths) ? r.paths.filter((p) => typeof p === 'string' && p.trim()) : []));
  const declaredPaths = [...new Set([...(fromProtected ?? []), ...fromFloor])];
  const sources = { protectedPaths: fromProtected, riskFloorRules: (config?.riskFloor?.rules ?? []).length };
  if (!Array.isArray(tracked)) {
    const declared = fromProtected !== null || fromFloor.length > 0;
    return { declared, paths: declaredPaths, declaredPaths, unmatched: [], trackedChecked: false, sources };
  }
  const paths = declaredPaths.filter((g) => tracked.some((f) => matchGlob(g, f)));
  const unmatched = declaredPaths.filter((g) => !paths.includes(g));
  return { declared: paths.length > 0, paths, declaredPaths, unmatched, trackedChecked: true, sources };
}
/** 追跡中のファイルの一覧(rev を渡せばその版の一覧)。得られなければ null */
export function trackedFiles(root = ROOT, rev = null) {
  try {
    const out = rev
      ? execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', rev], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })
      : execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}
/** 当たらないパスの表示(空なら空文字) */
export function unmatchedCoreText(core) {
  return core?.unmatched?.length ? `追跡中のファイルに1件も当たらない宣言のパス(効いていない): ${core.unmatched.map((g) => `\`${g}\``).join(' ')}` : '';
}
/** G-6 に要する独立した人の承認者の数。全変更の数(review.reviewerCount)と、コア機能の変更の数(gates.g6.params.coreReviewerCount)。大きいほうが掛かる */
export function reviewersRequiredOf(config) {
  const all = Math.max(1, Number(config?.review?.reviewerCount ?? config?.review?.requiredApprovals ?? 1) || 1);
  const coreParam = Number(config?.gates?.g6?.params?.coreReviewerCount);
  const core = Number.isFinite(coreParam) && coreParam > 0 ? Math.max(all, coreParam) : all;
  return { all, core, coreDeclared: Number.isFinite(coreParam) && coreParam > 0, coreParam: Number.isFinite(coreParam) ? coreParam : null };
}
/** 変更したファイルがコア機能のパスに当たるか。未宣言なら null(判定できない) */
export function touchesCore(config, files, { tracked = null } = {}) {
  const core = corePathsOf(config, { tracked });
  if (!core.declared) return null;
  const hit = (files ?? []).filter((f) => core.paths.some((g) => matchGlob(g, f)));
  return { hit: hit.length > 0, files: hit, paths: core.paths, unmatched: core.unmatched };
}

// ---------------------------------------------------------------- 規模の基準値と担保水準の宣言(#295 / ADR-0058)
//
// task.maxChangedLines / maxChangedFiles は「超過で規模の確認を要する基準」であり、遮断の上限ではない。
// 値の域に null(基準なし)を持つ。null は、担保水準 L2 の宣言と根拠が実在し、R1・R2 の変更・確約範囲・コア指定の
// パスに触れない変更だけに効く。それ以外は既定値を使う。
export const DEFAULT_MAX_CHANGED_LINES = 400;
export const DEFAULT_MAX_CHANGED_FILES = 15;
export const ASSURANCE_LEVELS = ['L0', 'L1', 'L2'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 構成 task.assurance({ level, basis, declaredBy, declaredAt, reviewAt })の実効の水準を返す。宣言は記録であり、
 * 緩和を自動で与えない。確かめるのは根拠(basis)の実在と見直し日(reviewAt)だけである。満たさなければ L0 として扱う。
 * exists(path) は、根拠のパスの実在を返す関数(PR の検査では基底ブランチ、手元ではファイルシステム)
 */
export function assuranceOf(config, { exists = () => false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const a = config?.task?.assurance;
  const declared = a && typeof a === 'object' && typeof a.level === 'string' ? a.level : 'L0';
  if (declared === 'L0') return { declared: 'L0', level: 'L0', valid: false, problems: [] };
  const problems = [];
  if (!ASSURANCE_LEVELS.includes(declared)) problems.push(`水準 ${declared} は L0・L1・L2 のいずれでもない`);
  const basis = typeof a.basis === 'string' ? a.basis.trim() : '';
  if (!basis) problems.push('根拠(basis)が未記入');
  else if (!exists(basis)) problems.push(`根拠 ${basis} が実在しない`);
  if (!DAY_RE.test(String(a.reviewAt ?? ''))) problems.push('見直し日(reviewAt)が YYYY-MM-DD でない');
  else if (a.reviewAt < today) problems.push(`見直し日 ${a.reviewAt} を過ぎている`);
  return { declared, level: problems.length ? 'L0' : declared, valid: !problems.length, basis, reviewAt: a.reviewAt ?? null, problems };
}

/** 規模の基準値。null(基準なし)は、呼び出し側が条件(L2 の宣言と根拠、R3、コア外)を確かめたうえで使う */
export function sizeLimitsOf(config) {
  const read = (v, d) => (v === null ? { value: null, explicitNull: true } : Number.isInteger(v) && v > 0 ? { value: v, explicitNull: false } : { value: d, explicitNull: false });
  const l = read(config?.task?.maxChangedLines, DEFAULT_MAX_CHANGED_LINES);
  const f = read(config?.task?.maxChangedFiles, DEFAULT_MAX_CHANGED_FILES);
  return { lines: l.value, files: f.value, nullLines: l.explicitNull, nullFiles: f.explicitNull };
}

/** git の --numstat の出力から、変更行数(追加 + 削除)を合計する */
export function sumNumstat(text) {
  return (text ?? '')
    .split('\n')
    .map((l) => l.split('\t'))
    .reduce((n, [add, del]) => n + (Number(add) || 0) + (Number(del) || 0), 0);
}

/**
 * 変更したファイルの組が委任の範囲に当たるかを、機械の規則で判定する(標準 第5章 5.5.4 条件2)。
 *
 * 1つの規則がすべてのファイルを覆う場合に限り、該当とする。規則で分類できない変更は
 * 該当なし(協働)へ落とす。行為する AI 自身に該当を判定させないための関数であり、
 * 条件3・4(G-5 の全通過、取り消しの実績)はここでは判定しない。条件5 は、構成に登録された
 * 確約範囲とコア指定のパス(delegation.protectedPaths[])に触れる変更を対象外にする。
 * キーが無い構成は未宣言であり、ここでは条件5 を判定しない(protectedPathsChecked: false)。
 * 未宣言の構成を該当なしとする判定は、delegation.mjs が行う。空の配列は「確約範囲・コア指定なし」の宣言
 */
export function classifyDelegation(config, files, ruleId = null, changedLines = null, { seat: seatRole = null } = {}) {
  const d = config.delegation ?? {};
  if (d.allowed !== true) return { rule: null, reasons: ['委任を適用できない構成である'] };
  if (!files.length) return { rule: null, reasons: ['変更したファイルがない'] };
  const guarded = files.filter((f) => NEVER_DELEGATED.some((g) => matchGlob(g, f)));
  if (guarded.length) {
    return {
      rule: null,
      reasons: [`強制層・構成の正本・判定の記録を含む(${guarded.slice(0, 5).join(', ')})。これらは委任の範囲へ入れない`],
    };
  }
  const protectedPaths = (d.protectedPaths ?? []).filter((g) => typeof g === 'string' && g.trim());
  const touched = files.filter((f) => protectedPaths.some((g) => matchGlob(g, f)));
  if (touched.length) {
    return {
      rule: null,
      reasons: [`確約範囲またはコア指定のパスに触れる(${touched.slice(0, 5).join(', ')})。委任の対象にできない(第5章 5.5.4 条件5)`],
    };
  }
  // 委任は変更単位の規模の上限を緩めない(第8章「対象にできる変更の境界」)
  // 委任は自動マージのため、規模の基準値の超過に規模の確認を要する形に代えられない。null(基準なし)でも既定値で縛る(#295)
  const maxFiles = Number.isInteger(config.task?.maxChangedFiles) ? config.task.maxChangedFiles : DEFAULT_MAX_CHANGED_FILES;
  const maxLines = Number.isInteger(config.task?.maxChangedLines) ? config.task.maxChangedLines : DEFAULT_MAX_CHANGED_LINES;
  if (maxFiles && files.length > maxFiles) {
    return { rule: null, reasons: [`変更ファイル数 ${files.length} が上限 ${maxFiles} を超えている`] };
  }
  if (maxLines && changedLines !== null && changedLines > maxLines) {
    return { rule: null, reasons: [`変更行数 ${changedLines} が上限 ${maxLines} を超えている`] };
  }
  const candidates = (d.rules ?? []).filter((r) => (!ruleId || r.id === ruleId) && (!seatRole || r.seat === seatRole));
  if (!candidates.length) {
    const why = ruleId
      ? `規則 ${ruleId} が delegation.rules にない`
      : seatRole
        ? `席 ${seatRole} の委任の規則が登録されていない`
        : '委任の規則が登録されていない';
    return { rule: null, reasons: [why] };
  }
  const reasons = [];
  for (const r of candidates) {
    const seat = (config.seats ?? []).find((s) => s.role === r.seat);
    const formal = delegationRuleProblems(r, config);
    if (formal.length) {
      reasons.push(`${r.id}: 規則が登録の要件を満たしていない(${formal[0]})`);
      continue;
    }
    // 承認待ち・決定した者を欠く規則は無効である。同じ席に有効な規則があっても、無効な規則では該当としない
    // 変更種別の登録(登録の根拠と、登録した者)を欠く規則も有効でない(第5章 5.5.4。生成側の ruleStanding と同じ)
    const standing = [
      ...ruleDeciderProblems(config, r),
      ...ruleApprovalProblems(config, r),
      ...changeTypeProblems(config, { only: new Set([String(r.changeType ?? '').trim()]) }),
    ];
    if (standing.length) {
      reasons.push(`${r.id}: 規則が有効でない(${standing[0]})`);
      continue;
    }
    if (seat?.mode !== 'delegated') {
      reasons.push(`${r.id}: ${seat?.name ?? r.seat} は委任を宣言していない`);
      continue;
    }
    if (qualificationProblems(seat).length) {
      reasons.push(`${r.id}: ${seat.name} の適合性確認が未実施または失効している`);
      continue;
    }
    const outside = files.filter(
      (f) => !(r.paths ?? []).some((g) => matchGlob(g, f)) || (r.excludePaths ?? []).some((g) => matchGlob(g, f))
    );
    if (outside.length) {
      reasons.push(`${r.id}: 規則の対象外のファイルを含む(${outside.slice(0, 5).join(', ')})`);
      continue;
    }
    return { rule: r.id, seat: seat.name, reasons: [], protectedPathsChecked: Array.isArray(d.protectedPaths) };
  }
  return { rule: null, reasons };
}

/**
 * ゲート判定記録(docs/gates/*.md)の冒頭の表から欄を読む。
 * 様式の選択肢を残したままの欄(「人確定 / 協働 / 委任」など)は未記入として扱う。
 */
export function readGateRecords() {
  const dir = path.join(ROOT, 'docs/gates');
  if (!fs.existsSync(dir)) return [];
  const raw = (text, key) => text.match(new RegExp(`^\\|\\s*${key}\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'm'))?.[1]?.trim() ?? null;
  const cell = (text, key) => {
    const v = raw(text, key) ?? '';
    return v && !v.includes(' / ') && !v.startsWith('<') ? v : null;
  };
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      return {
        file: `docs/gates/${f}`,
        gate: cell(text, 'ゲート'),
        target: cell(text, '対象'),
        result: cell(text, '結果'),
        // 結果欄の記載そのもの(様式の文言を残したままの値を含む)。2値のどちらとも読めない理由を示すために使う
        resultRaw: raw(text, '結果'),
        mode: cell(text, '確定の形態'),
        riskConfirmedBy: cell(text, 'リスク区分を確定した者'),
        d0Version: cell(text, '参照した D-0 の版'),
        judgedAt: cell(text, '判定日時'),
      };
    });
}

// ---------------------------------------------------------------- 変化点の記録の連鎖
//
// 構成(process.config.json)を書き換えるのは /process-change だけである。手で書き換えた構成を
// 検出するため、changeLog[] の各記録へ、適用後の構成の要約値(stateHash)と、直前の記録の
// 要約値(prevHash)を持たせる。最後の記録の stateHash が現在の構成と一致しなければ、構成は
// 変化点を経ずに書き換えられている。記録の切り詰め・差し替えは、連鎖の不一致として現れる。
//
// 限界: 要約値ごと書き換える改ざんは、ローカルだけでは検出できない。PR では基底ブランチの
// 構成と比べる(baseChainProblems)。過去の記録の書き換えはそこで止まるが、構成を手で書き換えて
// 要約値を計算し直した記録を追記する偽造は通る。要約値は鍵を持たず、記名した本人の決定を証明しない。
// 止めるのは、構成が強制層であること(変更は AI維持管理者の承認を要する)と、人による確認である。

/** 連鎖を持つ構成の schemaVersion。0 は連鎖を持たない旧い構成 */
export const CHAINED_SCHEMA_VERSION = 1;

/** キーの並びに依らない JSON の表現。要約値の計算に使う */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** changeLog を除いた構成の要約値 */
export function configDigest(config) {
  const { changeLog, ...rest } = config ?? {};
  return sha256(canonicalJson(rest));
}

/** 変化点の記録1件の要約値(記録の全体。stateHash と prevHash を含む) */
export function recordDigest(entry) {
  return sha256(canonicalJson(entry));
}

/**
 * 記録 i が持つべき prevHash。直前の記録が要約値を持てば、その記録の要約値(連鎖)。
 * 持たなければ(連鎖の起点)、それより前の旧い記録の全体の要約値とし、旧い記録の書き換えも検出する
 */
function prevDigest(log, i) {
  if (i === 0) return null;
  return log[i - 1]?.stateHash ? recordDigest(log[i - 1]) : sha256(canonicalJson(log.slice(0, i)));
}

/** 連鎖が始まっているか(要約値を持つ記録が1件でもあるか) */
export function chainStarted(config) {
  return (config?.changeLog ?? []).some((e) => e?.stateHash);
}

/**
 * 最後の記録へ要約値を書く。構成を書き出す直前に呼ぶ。
 * 旧い構成(要約値なし)へ最初に追記する記録は、連鎖の起点(chainStart)になる
 */
export function sealChangeLog(config) {
  const log = config.changeLog ?? [];
  const last = log.at(-1);
  if (!last) return config;
  const prev = log.at(-2) ?? null;
  if (prev && !prev.stateHash) last.chainStart = true;
  last.prevHash = prevDigest(log, log.length - 1);
  config.schemaVersion = CHAINED_SCHEMA_VERSION;
  last.stateHash = configDigest(config);
  return config;
}

/** 連鎖の検査。問題の一覧を返す。連鎖が始まっていない構成は legacy を真にして返す */
export function chainProblems(config) {
  const log = Array.isArray(config?.changeLog) ? config.changeLog : [];
  const first = log.findIndex((e) => e?.stateHash);
  if (first < 0) return { legacy: true, problems: [] };
  const problems = [];
  if ((config.schemaVersion ?? 0) < CHAINED_SCHEMA_VERSION) {
    problems.push(`schemaVersion が ${config.schemaVersion ?? 0} です。要約値の連鎖を持つ構成は ${CHAINED_SCHEMA_VERSION} 以上です`);
  }
  for (let i = first; i < log.length; i++) {
    const e = log[i];
    if (!e?.stateHash) {
      problems.push(`changeLog[${i}]: 要約値(stateHash)がありません。連鎖の途中の記録が差し替えられています`);
      continue;
    }
    if ((e.prevHash ?? null) !== prevDigest(log, i)) {
      problems.push(`changeLog[${i}]: 直前の記録の要約値(prevHash)が一致しません。記録の書き換え・切り詰め・差し替えの疑いがあります`);
    }
    if (i === first && first > 0 && e.chainStart !== true) {
      problems.push(`changeLog[${i}]: 連鎖の起点(chainStart)の印がありません。これより前の記録が差し替えられた疑いがあります`);
    }
  }
  const last = log.at(-1);
  if (last?.stateHash && last.stateHash !== configDigest(config)) {
    problems.push(
      '構成が、変化点の記録を経ずに書き換えられています(最後の記録の要約値と、現在の構成が一致しません)。' +
        '構成を書き換えるのは /process-change だけです。手での編集を戻し、/process-change で変化点として反映してください'
    );
  }
  return { legacy: false, problems };
}

/**
 * 基底ブランチの構成との比較(PR で使う)。問題の一覧を返す。
 *
 * 構成が変わっているのに changeLog の追記が無い場合と、基底の changeLog が先頭部分として
 * 保たれていない場合(書き換え・切り詰め)を検出する。要約値ごと書き換えた構成も、ここで止まる
 */
export function baseChainProblems(base, head) {
  if (!base || base.configured !== true) return [];
  const problems = [];
  if (head?.configured !== true) {
    return ['基底ブランチの構成は設定済みですが、この変更は構成を未設定へ戻しています'];
  }
  const bl = Array.isArray(base.changeLog) ? base.changeLog : [];
  const hl = Array.isArray(head.changeLog) ? head.changeLog : [];
  const broken = bl.findIndex((e, i) => i >= hl.length || canonicalJson(e) !== canonicalJson(hl[i]));
  if (broken >= 0) {
    problems.push(
      `基底ブランチの changeLog[${broken}] が保たれていません。変化点の記録は追記だけを認めます(書き換え・切り詰め・差し替えを認めません)`
    );
  }
  if (configDigest(base) !== configDigest(head) && hl.length <= bl.length) {
    problems.push('基底ブランチから構成が変わっていますが、changeLog への追記がありません。構成を書き換えるのは /process-change だけです');
  }
  if (chainStarted(base) && !chainStarted(head)) {
    problems.push('基底ブランチの構成は要約値の連鎖を持ちますが、この変更は連鎖を外しています');
  }
  return problems;
}

/**
 * AI が使えない期間の一覧を返す(保証の開示の項目7 へ出す)。
 *
 * 開始だけを記録した期間は、後の記録(outage.closes が添字を指す)で終了日を書いて閉じる。
 * 過去の記録は書き換えない。閉じていない期間は to が null(継続中)
 */
export function outagePeriods(config) {
  const log = Array.isArray(config?.changeLog) ? config.changeLog : [];
  const closer = new Map(log.filter((e) => e?.kind === 'outage' && Number.isInteger(e.outage?.closes)).map((e) => [e.outage.closes, e.outage]));
  return log
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e?.kind === 'outage' && e.outage && !Number.isInteger(e.outage.closes))
    .map(({ e, index }) => {
      const c = e.outage.to ? null : closer.get(index);
      return {
        index,
        from: e.outage.from,
        to: e.outage.to ?? c?.to ?? null,
        handling: c?.handling ?? e.outage.handling,
        switched: e.outage.switched === true,
        ongoing: !(e.outage.to ?? c?.to),
      };
    });
}

/**
 * 即時通知(標準 第3章 3.13.6)の記録が済んでいない変化点を返す。
 *
 * 即時通知の対象になった記録は notice: { to, at, reasons } を持つ。通知先と通知日が未記入の
 * 記録は、後から追記された種別 notice の記録(noticeFor が添字を指す)で埋まる。
 * 過去の記録は書き換えない
 */
export function pendingNotices(config) {
  const log = Array.isArray(config?.changeLog) ? config.changeLog : [];
  const filled = (n) => Boolean(n?.to && n?.at);
  const later = new Set(log.filter((e) => e?.kind === 'notice' && Number.isInteger(e.noticeFor) && filled(e.notice)).map((e) => e.noticeFor));
  return log
    .map((e, index) => ({ e, index }))
    .filter(({ e, index }) => e?.notice && !filled(e.notice) && !later.has(index))
    .map(({ e, index }) => ({ index, date: e.date ?? null, kind: e.kind, reasons: e.notice.reasons ?? [] }));
}

// ---------------------------------------------------------------- 日付と時刻
//
// スクリプトが自動で書く日付は、手元の時刻帯の日付で書く。協定世界時の日付で書くと、人が書く日付
// (判定記録の判定日時など)と、時刻帯によって1日ずれる。順序の比較には、オフセットつきの時刻を使う。

/** 手元の時刻帯の、オフセットつきの時刻(ISO 8601。例 2026-10-01T08:30:00+09:00) */
export function localIso(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 手元の時刻帯の日付(YYYY-MM-DD) */
export function localDay(d = new Date()) {
  return localIso(d).slice(0, 10);
}

/** 実在する日付(YYYY-MM-DD)か。2026-02-31 のような、暦に無い日付を受け付けない */
export function isRealDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** GitHub Actions の注釈として出す(ローカル実行では素の行として出る) */
export function notice(msg) {
  console.log(`::notice::${msg}`);
}
export function warn(msg) {
  console.log(`::warning::${msg}`);
}
export function fail(msg) {
  console.log(`::error::${msg}`);
}

export function hasTarget(adapter) {
  const adapterId = adapter.id;
  if (adapterId === 'node') {
    return fs.existsSync(path.join(ROOT, 'package.json'));
  }
  if (adapterId === 'python') {
    const pyFiles = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
    return pyFiles.some((f) => fs.existsSync(path.join(ROOT, f)));
  }
  if (adapterId === 'go') {
    return fs.existsSync(path.join(ROOT, 'go.mod'));
  }
  if (adapterId === 'none') {
    const cmds = Object.values(adapter.commands ?? {});
    return cmds.some((c) => (c ?? '').trim().length > 0);
  }
  if (adapterId === 'undetermined') {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 承認と承認した版(標準 第4章 G-6。process-compass #296)
//
// 承認は、承認した差分に対して数える。差分を変える更新の後は数えない。差分が同一であることを機械で確かめられない
// 更新は、差分を変える更新として扱う。ここでは、承認したコミット(レビューの commit)と、取り込んだ PR の先頭のコミットを
// 比べる。異なれば、承認の後に更新があった(差分の同一を確かめていない)として数えない。承認の版が記録に無ければ、
// 確かめられないとして数えない。

/** 承認が取り込んだ版に対するものか。'bound'(同じ版)/ 'stale'(承認の後に更新があった)/ 'unknown'(承認の版を確かめられない) */
export function approvalBinding(review, headOid) {
  const oid = review?.commit?.oid ?? review?.commit_id ?? null;
  if (!headOid || !oid) return 'unknown';
  return String(oid).toLowerCase() === String(headOid).toLowerCase() ? 'bound' : 'stale';
}

/**
 * gh がレビューの承認した版(reviews[].commit.oid)を返す最初の版。cli/cli の api/query_builder.go の prReviews の断片が
 * v2.30.0 から commit{oid} を含む(v2.20.0 には無い。2026-10-23 に確かめた。process-compass #296 突合 X-7)
 */
export const GH_MIN_REVIEW_COMMIT = '2.30.0';
/** `gh --version` の出力から版を読む。読めなければ null */
export function parseGhVersion(text) {
  return String(text ?? '').match(/gh version (\d+\.\d+\.\d+)/)?.[1] ?? null;
}
/** 版 v が min より前か。v が null なら null(判定できない) */
export function versionBelow(v, min) {
  if (!v) return null;
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}
/** 承認した版を確かめられない承認(unknown)の原因の文。gh の版が古い・読めない場合に、その旨を返す。問題が無ければ null */
export function unboundCauseText(ghVersion) {
  const below = versionBelow(ghVersion, GH_MIN_REVIEW_COMMIT);
  if (below === false) return null;
  return below === null
    ? `gh の版を読めません。gh ${GH_MIN_REVIEW_COMMIT} より前の gh はレビューの承認した版(commit.oid)を返さず、すべての承認が「確かめられない」になります。gh --version を確かめてください`
    : `gh ${ghVersion} は ${GH_MIN_REVIEW_COMMIT} より前の版で、レビューの承認した版(commit.oid)を返しません。すべての承認が「確かめられない」として数えられません。gh を ${GH_MIN_REVIEW_COMMIT} 以上へ上げてください`;
}

// ---------------------------------------------------------------- アカウント名の確認済みの上書き(#296)
//
// アカウント名が AI を示す語(Devin・Kiro・Cline など)に当たる実在の人のアカウントは、機械の検査では AI と区別できない。
// 名簿の人の accountsConfirmed に書いたアカウントを、人のアカウントとして扱う。ただし、確認は名簿の変更として、
// そのアカウントの本人以外が記名した変化点の記録(changeLog[].accountConfirmations と decidedBy)に限る。
// 本人の記名・AI の名義・記録の無い確認は効かない。[bot] の表記と、ホスティングが bot と返す名義(is_bot)は上書きしない。
// 上書きで数えた承認の件数は、出荷の証跡の集約が保証の開示へ出す。名簿の記載が正しいかは監査の観点6 で確かめる

/** 変化点の記録から、有効なアカウントの確認(本人以外の記名)を引く。キーは accountKey、値は { id, decidedBy, date } */
export function confirmedAccounts(config) {
  const out = new Map();
  for (const e of config?.changeLog ?? []) {
    for (const c of Array.isArray(e?.accountConfirmations) ? e.accountConfirmations : []) {
      const key = accountKey(c?.account);
      if (!key || !c?.id || !e.decidedBy) continue;
      if (aiNameReason(e.decidedBy)) continue;
      const by = personKey(config, e.decidedBy);
      if (!by || by === c.id) continue;
      out.set(key, { id: c.id, decidedBy: e.decidedBy, date: e.date ?? null });
    }
  }
  return out;
}

/** 名簿の accountsConfirmed のうち、本人以外の記名の記録が無い確認(契約検査が落とす) */
export function accountConfirmationProblems(config) {
  const valid = confirmedAccounts(config);
  const out = [];
  for (const p of config?.people ?? []) {
    for (const a of Array.isArray(p?.accountsConfirmed) ? p.accountsConfirmed : []) {
      const v = valid.get(accountKey(a));
      if (!v || v.id !== p.id) {
        out.push(
          `人の名簿 ${p.name} のアカウント "${a}" の確認(accountsConfirmed)に、本人以外が記名した変化点の記録がありません。` +
            '確認は /process-change(種別 accountable)で、本人以外の決定した者の記名(decidedBy)を付けて行います'
        );
      }
    }
  }
  return out;
}

/**
 * アカウントが AI・bot の名義か。理由を返す(人のアカウントなら null)。bot はホスティングが返す is_bot。
 * 名簿で本人以外が確認したアカウントは、語の一致を上書きする(overridden: true を返す呼び出しは aiAccountCheck)
 */
export function aiAccountCheck(config, login, bot = false) {
  if (bot) return { reason: 'bot の表記を含む(ホスティングの bot)', overridden: false };
  const reason = aiNameReason(login ?? '', { account: true });
  if (!reason) return { reason: null, overridden: false };
  if (/\[bot\]$/i.test(String(login ?? '').trim())) return { reason, overridden: false };
  const key = accountKey(login);
  const person = findPersonByAccount(config, login);
  const listed = Boolean(person) && (Array.isArray(person.accountsConfirmed) ? person.accountsConfirmed : []).some((c) => accountKey(c) === key);
  const v = confirmedAccounts(config).get(key);
  if (listed && v && v.id === person.id) return { reason: null, overridden: true, by: v.decidedBy };
  return { reason, overridden: false };
}

/**
 * 適用の開始のコミット。process.config.json の configured が true になった最初のコミット(標準 第1章 1.10.1)。
 * changeLog は読まずに境を決める(changeLog[0] は切り詰め・書き換えができ、境を後から動かせるため。ADR-0082)。
 * 返す config は、そのコミットの構成。初期化の記録の有無は initRecordProblem で確かめる。
 * 境は、HEAD(既定ブランチ)の第1親の連鎖の上で探す(process-compass #315 / ADR-0084 決定3)。併合した別の履歴の中の
 * configured が true のコミットを境にしない。全履歴を歩くと、併合した別の履歴の古いコミットが先に見つかり、
 * 境が別の履歴へ移る(品質保証の委員の V-4。test-adoption.mjs が再現する)
 */
export function findInitCommit(cwd = ROOT) {
  let hashes = [];
  try {
    hashes = execFileSync('git', ['log', '--first-parent', '--reverse', '--format=%H', '--', 'process.config.json'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
  for (const h of hashes) {
    try {
      const c = JSON.parse(execFileSync('git', ['show', `${h}:process.config.json`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      if (c?.configured === true) return { hash: h, config: c };
    } catch {
      // 読めない版は飛ばす
    }
  }
  return null;
}

// ---------------------------------------------------------------- 構成の形式の版と移行(process-compass #315 / ADR-0084 決定5)
//
// 構成は形式の版(formatVersion)を持つ。schemaVersion(要約値の連鎖の有無)の意味は変えない。
// 欄の無い構成は形式の版 0 として読む。読み込み時に既定値で補うのは、判定の結果が補う前と同じか、より厳しくなる場合に限る
// (版 0 → 1 は欄を足すだけで、判定に効く値を持たない)。緩める向きの補いは置かない。補いが必要な値は、移行の PR で人が確定する。
// 知らない版(この準拠テンプレートが知るより大きい版)の構成は、読まずに失敗にする。黙って通さない(外部の前例はどれも未知の版を拒む)。
// 移行は /process-change の種別 migrate で、版ごとに現行の版への直接の変換を1つずつ持つ(連鎖しない)。
// 移行は、ゲートの状態・席・名簿・閾値などの値を変えない。値を変える必要がある構成(規則の強化で落ちる構成)は、
// 移行の後も契約の検査で落ち、記名を伴う構成の変更(accountable・settings など)で直す。猶予の期間は置かない

/** 現行の形式の版 */
export const FORMAT_VERSION = 1;

/** 構成の形式の版。欄の無い構成は 0 */
export function formatVersionOf(config) {
  return config?.formatVersion === undefined ? 0 : config.formatVersion;
}

/** 版の欄の検査。知らない版(既知より大きい formatVersion・schemaVersion)、整数でない値を問題として返す */
export function versionProblems(config) {
  const out = [];
  const fv = formatVersionOf(config);
  if (!Number.isInteger(fv) || fv < 0) out.push(`formatVersion "${config.formatVersion}" は 0 以上の整数で書きます`);
  else if (fv > FORMAT_VERSION) {
    out.push(
      `構成の形式の版(formatVersion ${fv})は、この準拠テンプレートが知る版(${FORMAT_VERSION})より新しいです。知らない版の構成を読まずに失敗にします。` +
        '構成を生成した版の準拠テンプレートを取り込んでから検査します'
    );
  }
  const sv = config?.schemaVersion ?? 0;
  if (!Number.isInteger(sv) || sv < 0) out.push(`schemaVersion "${config?.schemaVersion}" は 0 以上の整数で書きます`);
  else if (sv > CHAINED_SCHEMA_VERSION) {
    out.push(`構成の schemaVersion ${sv} は、この準拠テンプレートが知る版(${CHAINED_SCHEMA_VERSION})より新しいです。知らない版の構成を読まずに失敗にします`);
  }
  return out;
}

/**
 * 版ごとの、現行の版への直接の変換。キーは移行元の版。各変換は現行の版の構成を返し、値を変えない。
 * 形式の版を上げる更新は、ここへ旧い版ごとの変換を足す(保守者の義務。community/standard-editions の「既存の採用者を落とす変更」)
 */
export const MIGRATIONS = {
  // 版 0 → 1: 形式の版の欄を足す。取り込んだテンプレートの記録(template)は、移行の入口が別に書く
  0: (c) => ({ ...c, formatVersion: FORMAT_VERSION }),
};

/** 移行で変わってよい欄。これ以外の欄が変われば、移行は値を変えている */
export const MIGRATION_FREE_KEYS = ['formatVersion', 'schemaVersion', 'template', 'changeLog'];

/** 構成を現行の形式の版へ移す。変換の無い版・知らない版は例外 */
export function migrateConfig(config) {
  const from = formatVersionOf(config);
  if (from === FORMAT_VERSION) return { ...JSON.parse(JSON.stringify(config)), formatVersion: FORMAT_VERSION };
  const fn = MIGRATIONS[from];
  if (!fn) throw new Error(`形式の版 ${from} から現行の版 ${FORMAT_VERSION} への移行の手段がありません`);
  return fn(JSON.parse(JSON.stringify(config)));
}

/** 移行の前後で値が変わった欄(移行で変わってよい欄を除く) */
export function migrationValueChanges(before, after) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => !MIGRATION_FREE_KEYS.includes(k));
  return keys.filter((k) => canonicalJson(before?.[k] ?? null) !== canonicalJson(after?.[k] ?? null));
}

// ---------------------------------------------------------------- 取り込んだ準拠テンプレートの記録(process-compass #315 / ADR-0084 決定6)
//
// 構成の template は、取り込んだ準拠テンプレートのコミット(commit)と、記録の時点の強制層のファイルの要約値(digests)を持つ。
// 書くのは初期化と /process-change の種別 migrate だけで、手で書かない。記録は来歴の主張であって、配布したファイルと
// 一致することの証明ではない(要約値も同じリポジトリの中の値であり、改ざんを止めない)。要約値と現在のファイルの不一致は
// 表示に使い、合否に使わない。採用者の正当な書き足し(常駐の規則の前後への追記など)があるため

/** 要約値を記録する強制層のファイル。初期化と変化点が案件ごとに書き換えるファイル(.claude/settings.json・guard.json)は含めない */
export const ENFORCEMENT_DIGEST_GLOBS = ['.claude/hooks/**', '.github/workflows/**', '.github/rulesets/**', 'scripts/gate/**', 'scripts/init/**', 'scripts/vendor/**', 'adapters/**'];

/** 強制層のファイルの要約値。{ 相対パス: SHA-256 }。キーは並べて返す */
export function enforcementDigests(root = ROOT) {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${e}` : e);
      return;
    }
    if (ENFORCEMENT_DIGEST_GLOBS.some((g) => matchGlob(g, rel))) out[rel] = sha256(fs.readFileSync(abs));
  };
  for (const top of ['.claude', '.github', 'scripts', 'adapters']) walk(top);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** テンプレートのコミットの識別の書式(7〜40 桁の16進) */
export const TEMPLATE_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/** 取り込みの記録を作る。commit は人が渡す識別(分からなければ null) */
export function templateRecord(commit, root = ROOT, at = null) {
  return { commit: commit ?? null, recordedAt: at, digests: enforcementDigests(root) };
}

/**
 * 記録した要約値と現在のファイルの差。{ recorded, changed: [パス], missing: [パス], added: [パス] }。記録が無ければ null。
 * 表示に使い、合否に使わない
 */
export function templateDrift(config, root = ROOT) {
  const rec = config?.template;
  if (!rec || typeof rec !== 'object' || !rec.digests || typeof rec.digests !== 'object') return null;
  const now = enforcementDigests(root);
  const changed = [];
  const missing = [];
  for (const [p, d] of Object.entries(rec.digests)) {
    if (!(p in now)) missing.push(p);
    else if (now[p] !== d) changed.push(p);
  }
  const added = Object.keys(now).filter((p) => !(p in rec.digests));
  return { commit: rec.commit ?? null, recordedAt: rec.recordedAt ?? null, changed, missing, added };
}

/** 準拠テンプレートの検査が実装する本標準の版(複製した知識ベースの source による)。{ edition, basedOn, commit } */
export function templateImplements(root = ROOT) {
  try {
    const kb = JSON.parse(fs.readFileSync(path.join(root, 'scripts/vendor/tailoring-kb.json'), 'utf8'));
    const s = kb.source ?? {};
    return { edition: s.edition ?? null, basedOn: s.basedOn ?? null, commit: typeof s.commit === 'string' ? s.commit : null };
  } catch {
    return { edition: null, basedOn: null, commit: null };
  }
}

// ---------------------------------------------------------------- フックの登録と CODEOWNERS(process-compass #315 / ADR-0084 決定2)

/**
 * テンプレートのフックの登録。既存の .claude/settings.json を持つリポジトリへ持ち込むと、上書きしない複製では既存の側が残り、
 * 登録が黙って外れる(禁止事項3 の機械の遮断が効かない)。初期化はこの登録を併合し、契約の検査は required の登録を確かめる
 */
export const TEMPLATE_HOOKS = [
  { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit', command: 'node .claude/hooks/guard-write.mjs', timeout: 15, required: true },
  { event: 'SessionStart', matcher: null, command: 'node scripts/gate/next.mjs --brief', timeout: 15, required: false },
];

/** settings に、フックの登録 h があるか(同じ事象で、コマンドが一致する登録。PreToolUse は書き込みの道具をすべて覆う照合子) */
function hookRegistered(settings, h) {
  const groups = settings?.hooks?.[h.event];
  if (!Array.isArray(groups)) return false;
  return groups.some((g) => {
    const cmds = Array.isArray(g?.hooks) ? g.hooks : [];
    if (!cmds.some((x) => x?.type === 'command' && String(x.command ?? '').trim() === h.command)) return false;
    if (!h.matcher) return true;
    const m = String(g?.matcher ?? '');
    if (m === '' || m === '*') return true;
    return h.matcher.split('|').every((tool) => m.split('|').map((t) => t.trim()).includes(tool));
  });
}

/** 登録の欠け。{ problems: [必須の登録の欠け・読めない設定], missing: [欠けた登録(必須以外を含む)] } */
export function hookRegistrationProblems(settings) {
  const problems = [];
  if (!settings || typeof settings !== 'object') return { problems: ['.claude/settings.json を読めない(無い、または JSON でない)'], missing: TEMPLATE_HOOKS };
  if (settings.disableAllHooks === true) problems.push('.claude/settings.json の disableAllHooks が true です。フックがすべて止まります');
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) problems.push('.claude/settings.json の hooks がオブジェクトでない');
  const missing = TEMPLATE_HOOKS.filter((h) => !hookRegistered(settings, h));
  for (const h of missing.filter((x) => x.required)) problems.push(`.claude/settings.json に、テンプレートのフックの登録(${h.event}: ${h.command})が無い。禁止事項3 の機械の遮断が効かない`);
  return { problems, missing };
}

/** フックの登録を併合した settings を返す(既存の登録は残し、欠けた登録だけを足す)。元の値は変えない */
export function mergeHookRegistration(settings) {
  const out = JSON.parse(JSON.stringify(settings ?? {}));
  if (!out.hooks || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) out.hooks = {};
  for (const h of TEMPLATE_HOOKS) {
    if (hookRegistered(out, h)) continue;
    if (!Array.isArray(out.hooks[h.event])) out.hooks[h.event] = [];
    out.hooks[h.event].push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: h.command, timeout: h.timeout }] });
  }
  return out;
}

/** CODEOWNERS の置き場。GitHub は、この順で最初に見つけた1つだけを使う */
export const CODEOWNERS_PLACES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** CODEOWNERS の状態。{ places: [あるファイル], effective: 効くファイル, owner: 雛形の所有者 @OWNER が残る行 } */
export function codeownersState(root = ROOT) {
  const places = CODEOWNERS_PLACES.filter((p) => fs.existsSync(path.join(root, p)));
  const effective = places[0] ?? null;
  const owner = [];
  if (effective) {
    fs.readFileSync(path.join(root, effective), 'utf8')
      .split(/\r?\n/)
      .forEach((l, i) => {
        const body = l.replace(/#.*$/, '').trim();
        if (body && /(^|\s)@OWNER(\s|$)/.test(body)) owner.push(i + 1);
      });
  }
  return { places, effective, owner };
}
