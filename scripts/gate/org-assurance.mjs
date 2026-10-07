// 組織として品質を保証する主張と、組織継続の側の状態の材料を、記録から読む(process-compass #288)。
//
// 出荷判定の証跡の集約(aggregate-evidence.mjs)と、G-5 の PR 単位の検査(check-pr.mjs)が使う。
// 読むものは既存の記録だけであり、人に新しい台帳を書かせない(標準 附属書H H.6、第3章 3.12.11)。
//
//   層1   docs/quality-assurance-policy.md(テンプレ11。品質保証の方針と受容の基準)
//   層2   docs/project-brief.md の「品質の約束と保証範囲」(テンプレ6)
//   継続  docs/D-0-governance.md の節9(代理者の確認の状態)・節12(縮退の3列)・節7(有事の決定者)・節15(受容)、
//         docs/handover.md の節2(コア機能の理解保持者)、docs/exit-rehearsal.json(退出の予行の記録)、
//         process.config.json の seats[](担い手・AI が使えないときの扱い・責任者)
//
// 第2巡: 層1 の冒頭欄(適用範囲の組織単位・保証の相手・記名者の3つの権限・連署・全社の品質方針との関係・委譲の根拠)と
// 項目4 の必須行の空欄で層1 を無効にする。「確認の周期と後継」の間隔・頻度・周期を過ぎた記録(退出の予行・縮退の実測・
// 後継候補と理解の保持者の確認)を失効させ、組織継続の側の状態を不利な側へ倒す。
//
// 機械が判定するのは記載の有無・日付・記名の名義と席の一致・語の一致までである。記述の妥当性、受容の水準が
// 層1 の段階に収まるか、記載が事実と合うかは判定しない(出荷判定者と内部監査が確かめる)。

//
// 単体の実行(#288 第5巡): 層1 の有効性・必須行の空欄・成立条件のうち構成と記録だけから出せるもの・組織継続の状態を出す。
// 出荷の集約と同じ読み取り(readPolicy・continuityState)を使う。変更ごとの条件(3〜6)は出荷の集約(aggregate-evidence)が出す。
//
//   node scripts/gate/org-assurance.mjs [--json]      層1 が無効、または D-0 表4 の有事の決定者に空欄があれば exit 1

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, isFilledValue, isRealDay, nameProblems, resolveSigner, signerKey, loadConfig, localDay, aiNameReason } from './config.mjs';

export const POLICY_FILE = 'docs/quality-assurance-policy.md';
export const BRIEF_FILE = 'docs/project-brief.md';
export const D0_FILE = 'docs/D-0-governance.md';
export const HANDOVER_FILE = 'docs/handover.md';
export const EXIT_REHEARSAL_FILE = 'docs/exit-rehearsal.json';

const readText = (rel, root = ROOT) => {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null;
};
const clean = (v) => String(v ?? '').replace(/\*\*/g, '').replace(/`/g, '').trim();
const nfkc = (v) => clean(v).normalize('NFKC');

/** 見出し(## の行)が re に当たる節の行。次の ## の見出しまで */
function sectionLines(text, re) {
  if (!text) return [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s/.test(l) && re.test(l));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    out.push(l);
  }
  return out;
}

/** 表の行(見出しの行と区切りの行を除く)。連続した表を1つとして読む。first: 最初の表だけ */
function tableRows(lines, { after = null } = {}) {
  let i = 0;
  if (after) {
    i = lines.findIndex((l) => after.test(l));
    if (i < 0) return [];
  }
  while (i < lines.length && !lines[i].trimStart().startsWith('|')) i++;
  const rows = [];
  let header = true;
  for (; i < lines.length && lines[i].trimStart().startsWith('|'); i++) {
    const l = lines[i].trim();
    if (/^\|[\s|:-]+\|$/.test(l)) continue;
    const cells = l.slice(1, l.endsWith('|') ? -1 : undefined).split('|').map((c) => clean(c));
    if (header) {
      header = false;
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

/** 2列の表(| 項目 | 値 |)から、項目が key で始まる行の値 */
function rowValue(text, key) {
  if (!text) return null;
  for (const l of text.split('\n')) {
    const m = l.match(/^\|\s*\**([^|]*?)\**\s*\|\s*(.*?)\s*\|\s*$/);
    if (m && clean(m[1]).startsWith(key)) return clean(m[2]);
  }
  return null;
}

/** 2列の表から、項目が re に当たる最初の行の値。行が無ければ null */
function rowValueRe(text, re) {
  if (!text) return null;
  for (const l of text.split('\n')) {
    const m = l.match(/^\|\s*\**([^|]*?)\**\s*\|\s*(.*?)\s*\|\s*$/);
    if (m && re.test(nfkc(m[1]))) return clean(m[2]);
  }
  return null;
}

/** 表の見出しの行と本体の行。after で始点を指定する。見出しの列名から列の位置を引くために使う */
function tableWithHeader(lines, { after = null } = {}) {
  let i = 0;
  if (after) {
    i = lines.findIndex((l) => after.test(l));
    if (i < 0) return { header: [], rows: [] };
  }
  while (i < lines.length && !lines[i].trimStart().startsWith('|')) i++;
  const split = (l) => {
    const t = l.trim();
    return t.slice(1, t.endsWith('|') ? -1 : undefined).split('|').map((c) => clean(c));
  };
  let header = null;
  const rows = [];
  for (; i < lines.length && lines[i].trimStart().startsWith('|'); i++) {
    const l = lines[i].trim();
    if (/^\|[\s|:-]+\|$/.test(l)) continue;
    if (!header) header = split(l).map((c) => nfkc(c));
    else rows.push(split(l));
  }
  return { header: header ?? [], rows };
}
const colOf = (header, re) => header.findIndex((h) => re.test(h));

/**
 * 層1 の「確認の周期と後継」の間隔・頻度・周期を読む(例: 12か月、半年に1回、90日、四半期、毎年)。
 * 読めない値と空欄は null(空欄の扱いになる)
 */
export function parseInterval(raw) {
  const s = nfkc(raw);
  if (!isFilledValue(s)) return null;
  if (/半年/.test(s)) return { raw: s, n: 6, unit: 'month' };
  if (/四半期/.test(s)) return { raw: s, n: 3, unit: 'month' };
  const m = s.match(/(\d+)\s*(日|週|か月|ヶ月|カ月|ケ月|箇月|月|年)/);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === '日') return { raw: s, n, unit: 'day' };
    if (m[2] === '週') return { raw: s, n: n * 7, unit: 'day' };
    if (m[2] === '年') return { raw: s, n: n * 12, unit: 'month' };
    return { raw: s, n, unit: 'month' };
  }
  if (/毎年|年に?\s*1\s*回/.test(s)) return { raw: s, n: 12, unit: 'month' };
  if (/毎月|月に?\s*1\s*回/.test(s)) return { raw: s, n: 1, unit: 'month' };
  return null;
}

/** 記録の日(YYYY-MM-DD)から間隔を足した失効の日。間隔が無ければ null */
export function intervalEnd(since, interval) {
  if (!interval || !isRealDay(since)) return null;
  const [y, mo, d] = since.split('-').map(Number);
  const t = interval.unit === 'day' ? new Date(Date.UTC(y, mo - 1, d + interval.n)) : new Date(Date.UTC(y, mo - 1 + interval.n, d));
  return t.toISOString().slice(0, 10);
}

/** 記録の日が、判定の日に間隔の内か。日付でない記録、間隔の無い場合は false */
export function withinInterval(since, interval, day) {
  const end = intervalEnd(since, interval);
  if (!end) return false;
  return !day || day <= end;
}

/** 役割名から席の ID。席に当たらない役割(事業部長など)は null */
const ROLE_SEATS = [
  [/事業決裁者/, 'biz-approver'],
  [/出荷判定者/, 'qa-gatekeeper'],
  [/価値責任者/, 'value-owner'],
  [/技術判断者/, 'tech-lead'],
  [/独立レビュア/, 'independent-reviewer'],
  [/開発者/, 'dev-verifier'],
  [/AI\s*運用担当者|AIOps/i, 'ai-ops'],
  [/AI\s*維持管理者|AI Maintainer/i, 'ai-maintainer'],
  [/コンテキストオーナー|文脈オーナー/, 'context-owner'],
];
export function seatOfRole(role) {
  const s = nfkc(role);
  if (!s || /品質保証部門/.test(s)) return null;
  return ROLE_SEATS.find(([re]) => re.test(s))?.[1] ?? null;
}

/** 同じ人の記名か。名簿へ対応づけば id で、対応づかなければ記名の照合キーで比べる */
export function samePerson(config, a, b) {
  if (!isFilledValue(a) || !isFilledValue(b)) return false;
  const pa = resolveSigner(config, a);
  const pb = resolveSigner(config, b);
  if (pa && pb) return pa.id === pb.id;
  return signerKey(a) === signerKey(b);
}

// ---------------------------------------------------------------- 層1(テンプレ11)

/** 機械で照合できる「受容しない条件」の印(テンプレ11 の項目2) */
export const CONDITION_TAGS = ['R1未確認', '未達ゲート', '逸脱', '未回収の例外', '未測定'];

/**
 * [未測定] の条件の文に、量を伴う期間の表現(「出荷 2 回」「90 日」「3 か月を超えて」)があれば返す。印は層1 項目1 の
 * 許容期間を読まず、未測定の最初の出荷から当たる(#288 第7巡 S)。文が機械と同じこと(期間に依らない・即時・猶予を与えない)
 * を述べていれば、期間の語があっても食い違いではないので null(#288 第8巡 W7・Z8)。語「期間」「超えて」だけでは判定しない
 */
export function periodExpression(text) {
  const s = nfkc(text ?? '');
  if (/依らず|よらず|関わらず|かかわらず|即時|猶予(?:は|を)?(?:与えない|なし|無し)|適用しない|問わず/.test(s)) return null;
  return s.match(/(?:出荷\s*)?\d+\s*(?:回|日|週|か月|ヶ月|カ月|ケ月|箇月|月)(?:\s*を?超えて)?/)?.[0] ?? null;
}

/** 層1 項目4 の必須行「AI の利用の拡大」の受容できる水準の欄に書く、機械が読む印。委任の登録を構成で拒否する(#288 第8巡 Y7) */
export const DELEGATION_LOCK_WORD = '認めない';
export function delegationLockOf(authority) {
  const row = (authority ?? []).find((r) => /AI\s*の利用の拡大/.test(nfkc(r.target ?? '')));
  if (!row) return { locked: false, unclear: false, level: null };
  const level = nfkc(row.level ?? '').trim();
  const locked = /^(?:委任(?:の登録|の範囲の登録)?(?:を|は)?)?認めない/.test(level);
  // 語「認めない」を含むが機械が読む形(欄の先頭)でない。錠は掛けず、人が確かめる注記にとどめる
  const unclear = !locked && level.includes(DELEGATION_LOCK_WORD);
  return { locked, unclear, level: level || null, role: row.role ?? null };
}

/**
 * 検出能力の未測定を許容する期間を読む。日数(か月は30日に換算)か、出荷の回数。読めない値と未記入は
 * 「許容しない」として扱う(成立条件5 を満たすのは測定済みの場合だけになる)
 */
export function parseTolerance(raw) {
  const s = nfkc(raw);
  if (!isFilledValue(s) || /許容しない/.test(s)) return { raw: s || null, days: null, releases: 0, note: isFilledValue(s) ? null : '未記入(許容しないとして扱う)' };
  let m = s.match(/(\d+)\s*(日|週|か月|ヶ月|カ月|ケ月|箇月|月)/);
  if (m) {
    const n = Number(m[1]);
    const days = m[2] === '日' ? n : m[2] === '週' ? n * 7 : n * 30;
    return { raw: s, days, releases: null, note: m[2].includes('月') ? '月は30日として数えた' : null };
  }
  m = s.match(/(\d+)\s*(回|出荷)/) ?? s.match(/出荷\s*(\d+)/);
  if (m) return { raw: s, days: null, releases: Number(m[1]), note: null };
  return { raw: s, days: null, releases: 0, note: '期間として読めない(許容しないとして扱う)' };
}

/** 未測定の継続(起点の日付と回数)が、許容する期間に収まるか。測定済み(回数 0)は収まる */
export function withinTolerance(tol, streak, releaseDay) {
  if (!streak || !streak.releases) return true;
  if (tol.releases !== null && tol.releases !== undefined) return streak.releases <= tol.releases;
  if (tol.days !== null && tol.days !== undefined && streak.since && releaseDay) {
    const d = (Date.parse(releaseDay) - Date.parse(streak.since)) / 86400000;
    return Number.isFinite(d) && d <= tol.days;
  }
  return false;
}

/**
 * 層1 の項目4 の必須行(標準 第6章 テンプレ11 の要求事項6)。受容者が1つでも空欄の層1 は有効にしない。
 * 行の受容の対象に当たる語で探す(行頭の「(必須)」の印の有無は問わない)
 */
export const REQUIRED_AUTHORITY_ROWS = [
  ['組織継続の状態: 代替の無い依存先', /代替の無い依存先/],
  ['組織継続の状態: 退出を試していない依存先', /退出を試していない/],
  ['組織継続の状態: 縮退の能力を確かめていない業務', /縮退/],
  ['組織継続の状態: 後継のいない判断の席、理解の保持者が1名以下のコア機能', /後継のいない|理解の保持者/],
  ['停止の申し立ての解除', /停止の申し立ての解除/],
  ['AI の利用の拡大', /AI\s*の利用の拡大/],
  ['AI の利用の縮小・停止(組織全体)', /AI\s*の利用の縮小/],
  ['有事の決定: 重大事故', /有事の決定\s*[::]\s*重大事故/],
  ['有事の決定: 情報漏えい', /有事の決定\s*[::]\s*情報漏えい/],
  ['有事の決定: 契約変更', /有事の決定\s*[::]\s*契約変更/],
  ['有事の決定: 規制変更', /有事の決定\s*[::]\s*規制変更/],
];

/** 記名者の3つの権限(テンプレ11 の要求事項3)。値は「有」「連署者: <氏名>」「上申先とする」のいずれか */
const AUTHORITY_POWERS = [
  ['ア', '単位の予算と要員の配置', /記名者の権限\s*[((]ア[))]/],
  ['イ', '単位の構成員の評価の方針', /記名者の権限\s*[((]イ[))]/],
  ['ウ', '保証の相手への出荷を止める権限', /記名者の権限\s*[((]ウ[))]/],
];

/** 判断の席の名前(層1 の「判断の席ごとの後継候補の最低数」の書き方。QA は出荷判定者) */
const SUCCESSOR_SEAT_WORDS = [
  ['価値責任者', /価値責任者/],
  ['技術判断者', /技術判断者/],
  ['独立レビュア', /独立レビュア/],
  ['出荷判定者', /出荷判定者|QA/i],
];

/** 「判断の席ごとの後継候補の最低数」を読む。席ごとの数か、全席に共通の1つの数。読めなければ null */
export function parseSuccessorMin(raw) {
  const s = nfkc(raw);
  if (!isFilledValue(s)) return null;
  const out = {};
  for (const [label, re] of SUCCESSOR_SEAT_WORDS) {
    const m = s.match(new RegExp(`(?:${re.source})\\s*[::]?\\s*(\\d+)`, 'i'));
    if (m) out[label] = Number(m[1]);
  }
  if (Object.keys(out).length) return out;
  const one = s.match(/^(\d+)\s*(名|人)?$/);
  if (one) return Object.fromEntries(SUCCESSOR_SEAT_WORDS.map(([label]) => [label, Number(one[1])]));
  return null;
}

/** 層1 の「確認の周期と後継」の表(テンプレ11 の要求事項7)。空欄は null */
function readCycle(text) {
  const rows = tableRows(sectionLines(text, /4\.\s*受容の権限の段階/), { after: /^###\s*確認の周期と後継/ });
  const find = (re) => rows.find((r) => re.test(nfkc(r[0])))?.[1] ?? null;
  const drillRaw = find(/演習/);
  const exitRaw = find(/退出の予行/);
  const degRaw = find(/縮退の実測/);
  const compRaw = find(/力量の確認/);
  const minRaw = find(/後継候補の最低数/);
  const trainerRaw = find(/育成の担当/);
  const remeasureRaw = find(/人の層の再測定の契機/);
  return {
    present: rows.length > 0,
    drill: parseInterval(drillRaw),
    drillRaw: isFilledValue(drillRaw) ? clean(drillRaw) : null,
    exit: parseInterval(exitRaw),
    degradation: parseInterval(degRaw),
    competence: parseInterval(compRaw),
    successorMin: parseSuccessorMin(minRaw),
    trainer: isFilledValue(trainerRaw) ? clean(trainerRaw) : null,
    // 人の層の検出率の再測定の契機(#288 第6巡 O)。組織が定める。空欄は「全員が離れたときだけ失効」
    humanRemeasure: parseHumanRemeasure(remeasureRaw),
  };
}
const NO_CYCLE = { present: false, drill: null, drillRaw: null, exit: null, degradation: null, competence: null, successorMin: null, trainer: null, humanRemeasure: parseHumanRemeasure(null) };

/**
 * 層1 の「人の層の再測定の契機」を読む(#288 第6巡 O)。本標準は値を定めない。
 *   accountable  独立レビュアの席の責任者の交代で、測定値を失効させる
 *   departure    測定した見つける者の1人でも名簿(体制の内)から離れたら、測定値を失効させる
 * 両方を書いてよい。空欄・読めない値は「全員が離れたときだけ失効(それ以外は注記)」として扱う
 */
export function parseHumanRemeasure(raw) {
  const s = nfkc(raw);
  if (!isFilledValue(s)) return { raw: null, accountable: false, departure: false, blank: true };
  return {
    raw: clean(raw),
    accountable: /責任者の交代|席の交代/.test(s),
    departure: /離脱|見つける者の交代|見つける者が.*離れ/.test(s),
    blank: false,
  };
}

/** 層1 を読み、記名で有効かを確かめる(成立条件1) */
export function readPolicy(config, { root = ROOT, today = null, text: given } = {}) {
  // text を渡すと、ファイルの代わりにその本文を読む(G-5 が基底ブランチの層1 を読む場合)。null は「層1 なし」
  const text = given === undefined ? readText(POLICY_FILE, root) : given === null ? null : String(given).replace(/\r\n/g, '\n');
  if (!text) {
    return { present: false, valid: false, problems: [`${POLICY_FILE} が無い(層1 なし)`], version: null, signer: null, signedAt: null, label: '層1 なし', conditions: [], authority: [], escalation: [], tolerance: parseTolerance(null), cycle: NO_CYCLE, requiredBlank: [], signerIsBizApprover: false, delegationLock: { locked: false, unclear: false, level: null } };
  }
  const version = rowValueRe(text, /^版$/);
  const signer = rowValueRe(text, /^記名(\s*[((][^))]*[))])?$/);
  const signedAt = rowValueRe(text, /^記名日$/);
  const item1 = Object.fromEntries(tableRows(sectionLines(text, /1\.\s*保証の相手と範囲の方針/)).map((r) => [r[0], r[1] ?? '']));
  // 冒頭の欄(テンプレ11 の要求事項1〜4)。保証の相手は、旧い様式の項目1 の行も読む
  const orgUnit = rowValueRe(text, /^適用範囲の組織単位/);
  const assuredParty = rowValueRe(text, /^保証の相手$/) ?? item1['保証の相手'] ?? null;
  const powers = AUTHORITY_POWERS.map(([id, label, re]) => ({ id, label, value: rowValueRe(text, re) }));
  const cosign = rowValueRe(text, /^連署$/);
  const qmsRelation = rowValueRe(text, /^全社の品質方針との関係/);
  const delegationBasis = rowValueRe(text, /^権限の委譲の根拠/);
  const conditions = sectionLines(text, /2\.\s*受容しない条件/)
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => clean(l.replace(/^\s*[-*]\s+/, '')))
    .filter((t) => isFilledValue(t))
    .map((t) => {
      const m = nfkc(t).match(/^\[([^\]]+)\]\s*(.*)$/);
      if (!m) return { text: t, tag: null, kind: 'unchecked', word: null };
      const tag = m[1].trim();
      // [未測定] は層を指定できる(#288 第8巡 X7): [未測定:人] は人の層だけ、[未測定:AI] は AI の層だけ、無印の [未測定] は両層
      const um = tag.match(/^未測定(?:\s*[:：]\s*(人|人の層|AI|ai|AI の層|AIの層))?$/);
      if (um) {
        const layer = !um[1] ? null : /^人/.test(um[1]) ? 'human' : 'ai';
        return { text: m[2] || t, tag, kind: '未測定', layer, word: null, periodWords: periodExpression(m[2] ?? '') };
      }
      if (CONDITION_TAGS.includes(tag)) return { text: m[2] || t, tag, kind: tag, word: null, periodWords: null };
      const ledger = tag.match(/^台帳\s*[:：]\s*(.+)$/);
      if (ledger) return { text: m[2] || t, tag, kind: 'ledger', word: ledger[1].trim() };
      return { text: t, tag, kind: 'unknown', word: null };
    });
  const frame = tableRows(sectionLines(text, /3\.\s*外枠/)).filter((r) => isFilledValue(r[1]));
  const authority = tableRows(sectionLines(text, /4\.\s*受容の権限の段階/)).map((r) => ({ target: r[0] ?? '', level: r[1] ?? '', role: r[2] ?? '', deadline: r[3] ?? '' }));
  const escalation = tableRows(sectionLines(text, /5\.\s*上申先/)).map((r) => ({ kind: r[0] ?? '', to: r[1] ?? '' }));

  const problems = [];
  if (!isFilledValue(version)) problems.push('版が未記入');
  if (!isFilledValue(orgUnit)) problems.push('冒頭の「適用範囲の組織単位」が未記入(テンプレ11 の要求事項1)');
  if (!isFilledValue(assuredParty)) problems.push('冒頭の「保証の相手」が未記入(テンプレ11 の要求事項1)');
  if (!isFilledValue(signer)) problems.push('記名者(適用範囲の組織単位を最高位で指揮し管理する者)の記名が無い');
  else problems.push(...nameProblems(config, signer, { checkRoster: false }).map((p) => `記名: ${p}`));
  if (!isRealDay(signedAt)) problems.push('記名日が日付(YYYY-MM-DD)でない');
  else if (today && signedAt > today) problems.push(`記名日 ${signedAt} が、判定の日(${today})より後`);
  // 記名者の3つの権限(要求事項3)。持たない権限は、連署か上申先の指定に結びつける。どれでもない権限は約束できない
  const cosignFilled = isFilledValue(cosign);
  const cosignNone = /^なし$/.test(nfkc(cosign));
  for (const p of powers) {
    const v = nfkc(p.value);
    if (/^有/.test(v)) continue;
    if (/^連署/.test(v)) {
      if (!cosignFilled) problems.push(`記名者の権限(${p.id})${p.label}を連署で補うが、「連署」の欄に連署者の氏名と連署日が無い`);
      continue;
    }
    if (/上申先/.test(v)) continue;
    problems.push(`記名者の権限(${p.id})${p.label}が「有」「連署者: <氏名>」「上申先とする」のいずれでもない(${p.value === null ? '欄が無い' : clean(p.value) || '空欄'})。連署も上申先の指定も無い権限は、この方針で約束できない(要求事項3)`);
  }
  if (cosign === null) problems.push('冒頭の「連署」の欄が無い(連署が無ければ「なし」と書く)');
  else if (!cosignFilled && !cosignNone) problems.push('冒頭の「連署」が未記入(連署が無ければ「なし」と書く)');
  else if (cosignFilled) {
    if (!/\d{4}-\d{2}-\d{2}/.test(nfkc(cosign))) problems.push('「連署」に連署日(YYYY-MM-DD)が無い');
    problems.push(...nameProblems(config, nfkc(cosign).replace(/\d{4}-\d{2}-\d{2}.*$/, '').replace(/[、,]\s*$/, ''), { checkRoster: false }).filter((x) => /AI/.test(x)).map((x) => `連署: ${x}`));
  }
  if (!isFilledValue(qmsRelation)) problems.push('冒頭の「全社の品質方針との関係」が未記入(全社の品質マネジメントシステムが無ければ「全社の品質マネジメントシステムなし」と書く。要求事項4)');
  else if (/下位文書/.test(nfkc(qmsRelation)) && !/\d{4}-\d{2}-\d{2}/.test(nfkc(qmsRelation))) problems.push('「全社の品質方針との関係」が下位文書だが、整合を確認した全社の品質保証部門の者と確認日が無い(要求事項4)');
  if (delegationBasis === null || (!isFilledValue(delegationBasis) && !/^なし$/.test(nfkc(delegationBasis)))) problems.push('冒頭の「権限の委譲の根拠」が未記入(委譲を受けていなければ「なし」と書く。要求事項4)');
  if (!isFilledValue(item1['組織として品質を保証する対象'])) problems.push('項目1 の保証する対象が未記入');
  if (!conditions.length) problems.push('項目2 の受容しない条件が1件も無い(<例: …> の行は記入に数えない)');
  if (!frame.length) problems.push('項目3 の外枠が未記入');
  // 必須行(要求事項6)。行が無い、または受容者が空欄の行が1つでもあれば、層1 を有効にしない
  const requiredBlank = REQUIRED_AUTHORITY_ROWS.filter(([, re]) => !authority.some((r) => re.test(nfkc(r.target)) && isFilledValue(r.role))).map(([label]) => label);
  if (requiredBlank.length) problems.push(`項目4 の必須行の受容者が空欄(${requiredBlank.join(' / ')})。必須行が1つでも空欄の層1 は有効にならない(要求事項6)`);
  if (!escalation.some((r) => isFilledValue(r.to))) problems.push('項目5 の上申先が未記入');
  // 記名者が事業決裁者の席の責任者と同一(要求事項5)。無効にはしない。保証の開示の項目1 に出す
  const biz = (config.seats ?? []).find((s) => s.role === 'biz-approver')?.accountable ?? null;
  const signerIsBizApprover = isFilledValue(signer) && Boolean(biz) && samePerson(config, signer, biz);
  return {
    present: true,
    valid: problems.length === 0,
    problems,
    version: isFilledValue(version) ? version : null,
    signer: isFilledValue(signer) ? signer : null,
    signedAt: isRealDay(signedAt) ? signedAt : null,
    label: `${isFilledValue(version) ? version : '版の記載なし'}(記名日 ${isRealDay(signedAt) ? signedAt : '記載なし'})`,
    orgUnit: isFilledValue(orgUnit) ? orgUnit : null,
    assuredParty: isFilledValue(assuredParty) ? assuredParty : null,
    powers: powers.map((p) => ({ id: p.id, label: p.label, value: p.value })),
    cosign: cosignFilled ? cosign : null,
    signerIsBizApprover,
    guaranteed: item1['組織として品質を保証する対象'] ?? null,
    notGuaranteed: item1['組織として品質を保証しない対象'] ?? null,
    tolerance: parseTolerance(item1['検出能力の未測定を許容する期間']),
    conditions,
    authority,
    // 項目4「AI の利用の拡大」の受容できる水準が「認めない」で始まる層1 は、委任の登録を構成で拒否する(#288 第8巡 Y7)
    delegationLock: delegationLockOf(authority),
    requiredBlank,
    escalation,
    cycle: readCycle(text),
  };
}

/**
 * 記名した者が、層1 の項目4 の行(受容の対象が re に当たる行)の受容者かを確かめる。
 * 受容者が席の名前なら、その席の責任者と照合する。席に当たらない役割なら、自然人の記名であることだけを確かめる。
 * 層1 が無い、または行の受容者が空欄なら、fallbackSeat の席の責任者と照合し、その旨を note に出す
 */
export function checkAuthority(config, policy, re, signer, { fallbackSeat = null, requireRoster = false } = {}) {
  const problems = [];
  const notes = [];
  if (!isFilledValue(signer)) return { ok: false, problems: ['記名が無い'], notes, role: null };
  problems.push(...nameProblems(config, signer, { requireRoster, checkRoster: requireRoster }));
  const row = (policy?.authority ?? []).find((r) => re.test(nfkc(r.target)));
  const role = row && isFilledValue(row.role) ? row.role : null;
  let seatId = role ? seatOfRole(role) : null;
  if (!role) {
    seatId = fallbackSeat;
    if (fallbackSeat) notes.push(`層1 の項目4 に受容者の記載が無い${policy?.present ? '' : '(層1 なし)'}ため、${SEAT_LABEL[fallbackSeat] ?? fallbackSeat}の席の責任者を権限者とみなした`);
  }
  if (seatId) {
    const acc = (config.seats ?? []).find((s) => s.role === seatId)?.accountable;
    if (!acc) problems.push(`権限者の席(${SEAT_LABEL[seatId] ?? seatId})の責任者が未記入`);
    else if (!samePerson(config, signer, acc)) problems.push(`記名した "${clean(signer)}" は、権限者(${role ?? SEAT_LABEL[seatId] ?? seatId}の席の責任者 ${acc})でない`);
  } else if (role) {
    notes.push(`受容者の役割「${role}」は席に当たらないため、記名した者が権限者かは確かめていない`);
  }
  return { ok: problems.length === 0, problems, notes, role: role ?? (seatId ? SEAT_LABEL[seatId] : null) };
}
const SEAT_LABEL = {
  'biz-approver': '事業決裁者',
  'qa-gatekeeper': '出荷判定者',
  'value-owner': '価値責任者',
  'tech-lead': '技術判断者',
  'independent-reviewer': '独立レビュア',
  'dev-verifier': '開発者',
  'ai-ops': 'AI運用担当者',
  'ai-maintainer': 'AI維持管理者',
  'context-owner': 'コンテキストオーナー',
};

// ---------------------------------------------------------------- 層2(テンプレ6)

const SCOPE_KEYS = ['想定する利用者・目的・利用状況・制約', '壊してはならない品質条件', '保証範囲と範囲外', 'この案件に掛かる外枠'];

/** 企画書の「品質の約束と保証範囲」の4欄。保証範囲を宣言しているか(成立条件2 の企画書の側) */
export function readBriefScope({ root = ROOT } = {}) {
  const text = readText(BRIEF_FILE, root);
  if (!text) return { present: false, declared: false, reason: `企画書(${BRIEF_FILE})が無い` };
  const values = Object.fromEntries(SCOPE_KEYS.map((k) => [k, rowValue(text, k)]));
  const blank = SCOPE_KEYS.filter((k) => !isFilledValue(values[k]));
  const scope = nfkc(values['保証範囲と範囲外']);
  if (blank.length) return { present: true, declared: false, reason: `企画書の「品質の約束と保証範囲」の欄が未記入(${blank.join(' / ')})`, values };
  if (/組織として保証しない/.test(scope)) return { present: true, declared: false, reason: '企画書の保証範囲の欄に「組織として保証しない」と書かれている', values };
  if (/層1\s*なし/.test(scope)) return { present: true, declared: false, reason: '企画書の保証範囲の欄に「層1 なし」と書かれている', values };
  return { present: true, declared: true, reason: null, values };
}

// ---------------------------------------------------------------- 組織継続の側の状態

const JUDGE_SEATS = [
  ['価値責任者', 'value-owner'],
  ['技術判断者', 'tech-lead'],
  ['独立レビュア', 'independent-reviewer'],
  ['出荷判定者', 'qa-gatekeeper'],
];
export const CONTINUITY_STATES = ['代替の無い依存先', '退出を試していない依存先', '縮退を確かめていない業務', '止める席', '後継不在の席', 'コア理解の保持者が1名以下', '自組織に無い資産', '通知の期間またはデータが空欄の依存先'];
const AUTHORITY_OF_STATE = {
  代替の無い依存先: /代替の無い依存先/,
  通知の期間またはデータが空欄の依存先: /代替の無い依存先/,
  退出を試していない依存先: /退出を試していない/,
  縮退を確かめていない業務: /縮退/,
  止める席: /縮退/,
  後継不在の席: /後継のいない|理解の保持者/,
  コア理解の保持者が1名以下: /後継のいない|理解の保持者/,
  自組織に無い資産: /自組織に無い資産/,
};
const normKey = (s) => nfkc(s).toLowerCase().replace(/[\s()]/g, '');

/** 退出の予行の記録(docs/exit-rehearsal.json)。読めない記録は problems に出す */
export function readExitRehearsals({ root = ROOT } = {}) {
  const p = path.join(root, EXIT_REHEARSAL_FILE);
  if (!fs.existsSync(p)) return { present: false, records: [], problems: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = Array.isArray(j) ? j : Array.isArray(j?.rehearsals) ? j.rehearsals : null;
    const baselineScope = j && !Array.isArray(j) && j.baselineScope && typeof j.baselineScope === 'object' ? j.baselineScope : null;
    if (!list) return { present: true, records: [], problems: [`${EXIT_REHEARSAL_FILE} に rehearsals[] が無い`], baselineScope };
    return { present: true, records: list, problems: [], baselineScope };
  } catch (e) {
    return { present: true, records: [], problems: [`${EXIT_REHEARSAL_FILE} を JSON として読めない(${e.message})`] };
  }
}

/**
 * 依存先の一覧と単一障害点の一覧を、構成と記録から生成する(標準 第3章 3.12.11)。受容の記録(D-0 節15)と
 * 照合し、期限を過ぎた受容(状態が解消していないもの)を expired に出す。day は判定の日(出荷の終点の日付)
 */
export function continuityState(config, policy, { root = ROOT, day = null } = {}) {
  const d0 = readText(D0_FILE, root);
  const seats = config.seats ?? [];
  const aiSeats = seats.filter((s) => s.performer);
  const problems = [];

  // 層1 の版(D-0 冒頭の行)
  const d0Policy = d0?.match(/品質保証の方針と受容の基準\(テンプレ11\)の版[::]\s*(.*)$/m)?.[1]?.trim() ?? null;

  const cycle = policy?.cycle ?? NO_CYCLE;

  // 後継(節9 の代理者=後継候補。席ごとに複数の行を書いてよい。第3章 3.4.3)。確認済みで、確認日が層1 の
  // 力量の確認の周期の内の候補を数え、層1 の「判断の席ごとの後継候補の最低数」と比べる。周期・最低数が空欄なら、
  // 候補を数えず全席を後継不在とする(テンプレ11「確認の周期と後継」の空欄の扱い)
  const dep = tableWithHeader(sectionLines(d0, /9\.\s*代行者/));
  const iStatus = colOf(dep.header, /確認の状態/);
  const iDay = colOf(dep.header, /確認日/);
  const successors = JUDGE_SEATS.map(([label, id]) => {
    const rows = dep.rows.filter((r) => nfkc(r[0]).includes(label));
    const candidates = rows
      .filter((r) => isFilledValue(r[1]) || isFilledValue(r[iStatus >= 0 ? iStatus : 3]))
      .map((r) => {
        const status = nfkc(r[iStatus >= 0 ? iStatus : 3]);
        const at = iDay >= 0 ? clean(r[iDay]) : '';
        const state = status === '確認済み' ? 'confirmed' : status === '暫定任命' ? 'provisional' : status === 'なし' ? 'none' : 'unrecorded';
        let why = null;
        // 候補に数えるのは、人の名簿(people[])の人へ対応づく氏名だけ。役割名(「品質保証部 課長」)や名簿に無い名義は数えない(#288 第3巡)
        const np = state === 'none' || !isFilledValue(r[1]) ? [] : nameProblems(config, r[1]);
        if (state !== 'confirmed') why = { provisional: '暫定任命(確認を経ていない)', none: '代理者なし', unrecorded: '確認の状態の記載が無い' }[state];
        else if (np.length) why = `${np[0]}。役割名や名簿に無い名義は候補に数えない(候補は名簿の人の氏名で書く)`;
        else if (!isRealDay(at)) why = '確認日(YYYY-MM-DD)が無い';
        else if (!cycle.competence) why = '層1 の AI を使わない力量の確認の周期が空欄のため、確認の有効性を判定できない';
        else if (!withinInterval(at, cycle.competence, day)) why = `確認日 ${at} が力量の確認の周期(${cycle.competence.raw})を過ぎている`;
        return { name: isFilledValue(r[1]) ? r[1] : null, state, at: isRealDay(at) ? at : null, counted: !why, why };
      });
    const counted = candidates.filter((c) => c.counted).length;
    const min = cycle.successorMin ? (cycle.successorMin[label] ?? null) : null;
    const state = candidates.some((c) => c.state === 'confirmed') ? 'confirmed' : candidates.some((c) => c.state === 'provisional') ? 'provisional' : candidates.some((c) => c.state === 'none') ? 'none' : 'unrecorded';
    const vacant = min === null ? true : counted < min;
    const reason = !vacant
      ? null
      : min === null
        ? `層1 の判断の席ごとの後継候補の最低数が${cycle.successorMin ? `この席について` : ''}空欄(確認済みの候補 ${counted} 名)`
        : `確認済みで周期内の候補 ${counted} 名 < 最低数 ${min} 名${candidates.filter((c) => !c.counted).length ? `(数えなかった候補: ${candidates.filter((c) => !c.counted).map((c) => `${c.name ?? '氏名なし'}: ${c.why}`).join(' / ')})` : ''}`;
    return { seat: label, role: id, deputy: candidates.find((c) => c.name)?.name ?? null, state, candidates, counted, min, vacant, reason };
  });

  // 縮退の3列(節12 の手で書く表)。実測の日が層1 の縮退の実測の頻度を過ぎた量、頻度が空欄の量は「未確認」へ戻す
  const deg = tableWithHeader(sectionLines(d0, /12\.\s*担い手と運用形態/), { after: /^###\s*縮退の3列/ });
  const iQty = colOf(deg.header, /処理できる量/);
  const iMeasured = colOf(deg.header, /実測の日/);
  const iStops = colOf(deg.header, /止める業務/);
  const iRecovery = colOf(deg.header, /復旧/);
  const degradation = aiSeats.map((s) => {
    const base = normKey(String(s.name ?? s.role).split(/[((]/)[0]);
    const row = deg.rows.find((r) => normKey(r[0]) === normKey(s.name) || (base && normKey(r[0]).startsWith(base)));
    const qty = row?.[iQty >= 0 ? iQty : 1] ?? null;
    const at = row && iMeasured >= 0 ? clean(row[iMeasured]) : '';
    const written = isFilledValue(qty) && !/未確認/.test(nfkc(qty));
    let lapse = null;
    if (written) {
      if (!isRealDay(at)) lapse = '実測の日(YYYY-MM-DD)が無い';
      else if (!cycle.degradation) lapse = '層1 の縮退の実測の頻度が空欄';
      else if (!withinInterval(at, cycle.degradation, day)) lapse = `実測の日 ${at} が縮退の実測の頻度(${cycle.degradation.raw})を過ぎている`;
    }
    const measured = written && !lapse;
    return {
      seat: s.name ?? s.role,
      role: s.role,
      fallback: s.fallback === 'stop' ? '止める' : s.fallback === 'human' ? '人へ戻す' : '未記入',
      quantity: !row ? '記載なし(未確認として扱う)' : !written ? '未確認' : lapse ? `未確認(${lapse}。記載: ${qty})` : qty,
      measuredAt: isRealDay(at) ? at : null,
      measured,
      stops: row && isFilledValue(row[iStops >= 0 ? iStops : 2]) ? row[iStops >= 0 ? iStops : 2] : null,
      recovery: row && isFilledValue(row[iRecovery >= 0 ? iRecovery : 3]) ? row[iRecovery >= 0 ? iRecovery : 3] : null,
    };
  });

  // 有事の決定者(節7 の有事の事象の表)。4つの事象 × 3つの決定の12欄。空欄は記載の欠落(テンプレ0「有事の決定者を
  // 決めておく」)。「層1 の項目4 による」は記入として受け付け、層1 の該当行の受容者が空欄でないことを確かめる
  const EMERGENCY_EVENTS = [
    ['重大事故', /重大事故/],
    ['情報漏えい', /情報漏えい/],
    ['契約変更', /契約変更/],
    ['規制変更', /規制変更/],
  ];
  const DECISIONS = ['停止の決定者', '切替の決定者', '顧客説明の決定者'];
  const emergencyRows = tableRows(sectionLines(d0, /7\.\s*障害時の指揮系統/), { after: /^\|\s*有事の事象/ });
  const emergencyMissing = [];
  if (d0) {
    for (const [ev, re] of EMERGENCY_EVENTS) {
      const row = emergencyRows.find((r) => re.test(nfkc(r[0])));
      DECISIONS.forEach((dec, i) => {
        const cell = row ? row[i + 1] : null;
        if (!row) emergencyMissing.push(`${ev}: ${dec}(行が無い)`);
        else if (/層1\s*の?\s*項目\s*4\s*による/.test(nfkc(cell))) {
          const pRow = (policy?.authority ?? []).find((a) => new RegExp(`有事の決定\\s*[::]\\s*${ev}`).test(nfkc(a.target)));
          if (!pRow || !isFilledValue(pRow.role)) emergencyMissing.push(`${ev}: ${dec}(「層1 の項目4 による」と書かれているが、層1 の項目4 の「有事の決定: ${ev}」の受容者が空欄)`);
        } else if (!isFilledValue(cell)) emergencyMissing.push(`${ev}: ${dec}`);
      });
    }
  }
  const emergencyBlank = emergencyMissing.length;

  // コア機能の理解保持者(運用引き継ぎ文書の節2)。本人以外の者が日付を付けて確認した記録を持つ人だけを数える
  // (第3章 3.4.3 の要求事項8)。確認日が層1 の力量の確認の周期を過ぎた行、周期が空欄の場合は数えない
  const handover = readText(HANDOVER_FILE, root);
  const ho = tableWithHeader(sectionLines(handover, /2\.\s*コア機能/));
  const iHolder = colOf(ho.header, /理解保持者|保持者/);
  const iBy = colOf(ho.header, /確認した者/);
  const iRec = colOf(ho.header, /確認の記録|確認日/);
  const coreMap = new Map();
  for (const r of ho.rows.filter((x) => isFilledValue(x[0]))) {
    const name = r[0];
    if (!coreMap.has(name)) coreMap.set(name, { name, holders: [], uncounted: [] });
    const c = coreMap.get(name);
    const by = iBy >= 0 ? r[iBy] : null;
    const rec = iRec >= 0 ? nfkc(r[iRec]) : '';
    const at = rec.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
    for (const h of clean(r[iHolder >= 0 ? iHolder : 1]).split(/[、,，・/／]|\s+と\s+/).map((x) => x.trim()).filter((x) => isFilledValue(x))) {
      let why = null;
      if (iBy < 0) why = '確認した者と確認日の列が無い(旧い様式。名前だけでは数えない)';
      else if (!isFilledValue(by)) why = '確認した者が空欄';
      else if (signerKey(by) === signerKey(h) || samePerson(config, by, h)) why = '確認した者が保持者本人';
      else if (!at || !isRealDay(at)) why = '確認日(YYYY-MM-DD)が無い';
      else if (!cycle.competence) why = '層1 の AI を使わない力量の確認の周期が空欄';
      else if (!withinInterval(at, cycle.competence, day)) why = `確認日 ${at} が力量の確認の周期(${cycle.competence.raw})を過ぎている`;
      const key = signerKey(h);
      if (why) c.uncounted.push({ name: h, why });
      else if (!c.holders.includes(key)) c.holders.push(key);
    }
  }
  const core = [...coreMap.values()];

  // 退出の予行
  const ex = readExitRehearsals({ root });
  problems.push(...ex.problems);
  const opsAccountable = seats.find((s) => s.role === 'ai-ops')?.accountable ?? null;
  const rehearsals = ex.records.map((r) => {
    const why = [];
    const provider = clean(r?.provider);
    const alt = clean(r?.alternative?.provider);
    if (!isFilledValue(r?.model)) why.push('model が未記入');
    if (!isFilledValue(provider)) why.push('provider(現行の提供者)が未記入');
    if (!isFilledValue(alt)) why.push('alternative.provider(試した提供者)が未記入');
    else if (normKey(alt) === normKey(provider)) why.push('同じ提供者の世代交代は、退出の予行に数えない');
    if (!isRealDay(r?.at)) why.push('at(実施日)が日付でない');
    else if (day && r.at > day) why.push(`実施日 ${r.at} が判定の日より後`);
    const approved =
      isFilledValue(r?.approvedBy) && !nameProblems(config, r.approvedBy, { checkRoster: false }).length && (!opsAccountable || samePerson(config, r.approvedBy, opsAccountable));
    const baseline = clean(r?.baseline);
    const baselineInRepo = isFilledValue(baseline) && !/^[a-z]+:\/\//i.test(baseline) && fs.existsSync(path.join(root, baseline));
    return { model: clean(r?.model), provider, alternative: { provider: alt, model: clean(r?.alternative?.model) }, at: r?.at ?? null, valid: !why.length, why, approved, baseline: baseline || null, baselineInRepo };
  });
  for (const r of rehearsals) if (!r.valid) problems.push(`退出の予行の記録(${r.model || 'model 未記入'} / ${r.at ?? '日付なし'})を数えない: ${r.why.join('。')}`);
  // 評価用の基準集合の範囲の承認(第3章 3.12.3 の要求事項10。AI運用担当者が起案し、技術判断者が記名で承認する)
  const scope = ex.baselineScope ?? null;
  const techAccountable = seats.find((s) => s.role === 'tech-lead')?.accountable ?? null;
  const scopeWhy = [];
  if (!scope) scopeWhy.push(`${EXIT_REHEARSAL_FILE} に baselineScope(基準集合の範囲の承認の記録)が無い`);
  else {
    if (!isFilledValue(scope.scope)) scopeWhy.push('baselineScope.scope(含める機能と含めない機能、含めない理由)が未記入');
    if (!isFilledValue(scope.draftedBy)) scopeWhy.push('baselineScope.draftedBy(起案した AI運用担当者)が未記入');
    else if (opsAccountable && !samePerson(config, scope.draftedBy, opsAccountable)) scopeWhy.push(`起案した "${clean(scope.draftedBy)}" が AI運用担当者の席の責任者でない`);
    if (!isFilledValue(scope.approvedBy)) scopeWhy.push('baselineScope.approvedBy(承認した技術判断者)が未記入');
    else if (nameProblems(config, scope.approvedBy, { checkRoster: false }).length) scopeWhy.push(`承認: ${nameProblems(config, scope.approvedBy, { checkRoster: false })[0]}`);
    else if (techAccountable && !samePerson(config, scope.approvedBy, techAccountable)) scopeWhy.push(`承認した "${clean(scope.approvedBy)}" が技術判断者の席の責任者でない`);
    // 起案した者と承認した者が同一人物なら、承認に数えない。基準集合の十分性を一人で判断させない(第3章 3.12.3 の要求事項10)。
    // AI運用担当者と技術判断者の席を同じ人が担う体制では、別の自然人の記名を承認に要する(#288 第3巡)
    if (isFilledValue(scope.draftedBy) && isFilledValue(scope.approvedBy) && samePerson(config, scope.draftedBy, scope.approvedBy)) {
      scopeWhy.push(`起案した者と承認した者が同一人物("${clean(scope.approvedBy)}")。承認に数えない(基準集合の十分性を一人で判断させない。第3章 3.12.3 の要求事項10)。別の自然人の記名を要する`);
    }
    if (!isRealDay(scope.at)) scopeWhy.push('baselineScope.at(承認日)が日付でない');
  }
  const baselineScope = { approved: aiSeats.length > 0 && !scopeWhy.length, why: aiSeats.length ? scopeWhy : [] };

  // 依存先の欄(第3章 3.12.11 の要求事項2)。通知の期間とデータは記録から導けないため、AI運用担当者が構成の
  // dependencies[] へ書く(/process-change の種別 settings)。提供者の名前か models[] でモデルと対応づける
  const depEntries = Array.isArray(config.dependencies) ? config.dependencies : [];

  // 依存先の一覧
  const models = [...new Map(aiSeats.map((s) => [normKey(s.performer.model ?? ''), s.performer.model ?? null])).values()];
  const matchModel = (m, r) => {
    const a = normKey(m);
    const b = normKey(r.model);
    return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
  };
  const dependencies = [];
  for (const m of models) {
    const own = rehearsals.filter((r) => r.valid && m && matchModel(m, r));
    const last = own.map((r) => r.at).sort().at(-1) ?? null;
    const alt = own.filter((r) => r.approved);
    const provider = own[0]?.provider ?? rehearsals.find((r) => m && matchModel(m, r))?.provider ?? null;
    const entry =
      depEntries.find((d) => Array.isArray(d?.models) && d.models.some((x) => m && matchModel(m, { model: x }))) ??
      depEntries.find((d) => provider && normKey(d?.provider) === normKey(provider)) ??
      null;
    // 退出の予行は1回で永続しない(第3章 3.12.3 の要求事項9)。間隔が空欄なら記録があっても試していない
    const exitLapse = !own.length ? null : !cycle.exit ? '層1 の退出の予行の間隔が空欄' : !withinInterval(last, cycle.exit, day) ? `最後の予行 ${last} が退出の予行の間隔(${cycle.exit.raw})を過ぎている` : null;
    const notice = isFilledValue(entry?.noticePeriod) ? clean(entry.noticePeriod) : null;
    const data = isFilledValue(entry?.data) ? clean(entry.data) : null;
    dependencies.push({
      kind: 'モデル',
      name: m ?? '未記入',
      provider: provider ?? (isFilledValue(entry?.provider) ? clean(entry.provider) : '未記録'),
      seats: aiSeats.filter((s) => (s.performer.model ?? null) === m).map((s) => s.name ?? s.role),
      alternative: alt.length ? `あり(別の提供者 ${[...new Set(alt.map((r) => r.alternative.provider))].join(' / ')}。AI運用担当者の承認あり)` : 'なし',
      lastExitRehearsal: last ?? '未実施',
      exitLapse,
      noticePeriod: notice ?? '記録なし(構成の dependencies[] に通知の期間が無い)',
      data: data ?? '記録なし(構成の dependencies[] にデータの種別と保持の条件が無い)',
      fieldsBlank: [notice ? null : '通知の期間', data ? null : 'データ'].filter(Boolean),
      hasAlternative: alt.length > 0,
      exitTried: own.length > 0 && !exitLapse,
    });
  }
  const instructions = [...new Set(aiSeats.map((s) => s.performer.instructions).filter((v) => isFilledValue(v)))];
  dependencies.push({ kind: '指示資産', name: instructions.join(' / ') || 'CLAUDE.md・.claude/', inRepo: !instructions.some((v) => /^[a-z]+:\/\//i.test(clean(v))) });
  const baselines = [...new Set(rehearsals.filter((r) => r.baseline).map((r) => r.baseline))];
  if (aiSeats.length) dependencies.push({ kind: '評価用の基準集合', name: baselines.join(' / ') || '所在の記録なし', inRepo: baselines.length > 0 && rehearsals.filter((r) => r.baseline).every((r) => r.baselineInRepo), scopeApproved: baselineScope.approved, scopeWhy: baselineScope.why });
  const keyPeople = [...new Set(seats.map((s) => s.accountable).filter(Boolean))];
  dependencies.push({ kind: '鍵となる個人', name: `席の責任者 ${keyPeople.length} 名、コア機能の理解保持者(本人以外の確認つき)${new Set(core.flatMap((c) => c.holders)).size} 名` });
  const dataRows = depEntries.filter((d) => isFilledValue(d?.data)).map((d) => `${clean(d.provider) || '提供者未記入'}: ${clean(d.data)}`);
  dependencies.push({ kind: 'データ', name: dataRows.join(' / ') || '記録なし(構成の dependencies[] に記載が無い)' });

  // 単一障害点の一覧(人に書かせない)
  const spof = [];
  for (const d of dependencies.filter((x) => x.kind === 'モデル')) {
    if (!d.hasAlternative) spof.push({ state: '代替の無い依存先', subject: d.name, detail: `提供者 ${d.provider}。3.12.3 を通過した別の提供者の代替が無い` });
    if (!d.exitTried) spof.push({ state: '退出を試していない依存先', subject: d.name, detail: d.exitLapse ? `${d.exitLapse}(第3章 3.12.3 の要求事項9)` : '別の提供者での回帰評価(退出の予行)の記録が無い' });
    if (d.fieldsBlank.length) spof.push({ state: '通知の期間またはデータが空欄の依存先', subject: d.name, detail: `構成の依存先の欄が空欄(${d.fieldsBlank.join('・')})。単一障害点の候補(第3章 3.12.11 の要求事項4 の(7))`, candidate: true });
  }
  for (const g of degradation) {
    if (g.fallback === '止める') spof.push({ state: '止める席', subject: g.seat, detail: 'AI が使えないときの扱いが「止める」' });
    if (!g.measured) spof.push({ state: '縮退を確かめていない業務', subject: g.seat, detail: `人へ戻したときに処理できる量: ${g.quantity}` });
  }
  for (const s of successors) if (s.vacant) spof.push({ state: '後継不在の席', subject: s.seat, detail: s.reason });
  if (!handover) spof.push({ state: 'コア理解の保持者が1名以下', subject: 'コア機能', detail: `${HANDOVER_FILE} が無く、理解保持者を確かめられない` });
  else if (!core.length) spof.push({ state: 'コア理解の保持者が1名以下', subject: 'コア機能', detail: `${HANDOVER_FILE} の節2 にコア機能の記載が無い` });
  for (const c of core) {
    if (c.holders.length <= 1) {
      spof.push({ state: 'コア理解の保持者が1名以下', subject: c.name, detail: `理解保持者 ${c.holders.length} 名(本人以外の確認つき)${c.uncounted.length ? `。数えなかった名前: ${c.uncounted.map((u) => `${u.name}(${u.why})`).join(' / ')}` : ''}` });
    }
  }
  for (const d of dependencies) {
    if (d.inRepo === false) spof.push({ state: '自組織に無い資産', subject: d.kind, detail: `${d.name}(自組織の管理するリポジトリで所在を確かめられない)` });
  }
  // 確認の周期と後継の表の、組織継続の側の状態へ倒さない欄(項目7 に出す)
  const cycleNotices = [];
  if (!cycle.drill) cycleNotices.push('演習の頻度を定めていない(層1 の「確認の周期と後継」の演習の頻度が空欄)');
  if (!cycle.trainer) cycleNotices.push('育成の担当(役割)が空欄。後継不在の受容を更新できない');

  // 受容の記録(D-0 節15)と照合する
  const acceptRows = tableRows(sectionLines(d0, /15\.\s*組織継続の状態の受容/)).filter((r) => r.some((c) => isFilledValue(c)));
  const acceptances = acceptRows.map((r) => {
    const [state, subject, by, until, version] = r;
    const why = [];
    const re = AUTHORITY_OF_STATE[nfkc(state)];
    if (!re) why.push(`状態「${state}」は、一覧の語に当たらない`);
    if (!isRealDay(until)) why.push('受容の期限が日付(YYYY-MM-DD)でない(期限の無い受容は数えない)');
    if (!isFilledValue(version)) why.push('照らした層1 の版が未記入');
    const auth = checkAuthority(config, policy, re ?? /^$/, by, {});
    why.push(...auth.problems);
    // 育成の担当が空欄の層1 では、後継不在の受容を更新できない(テンプレ11「確認の周期と後継」の空欄の扱い)
    if (nfkc(state) === '後継不在の席' && !cycle.trainer) why.push('層1 の育成の担当(役割)が空欄のため、後継不在の受容を受け付けない');
    return { state: nfkc(state), subject, by, until, version, valid: !why.length, why, notes: auth.notes };
  });
  const expired = [];
  for (const item of spof) {
    const subj = normKey(item.subject);
    const own = acceptances.filter((a) => a.state === item.state && subj && (normKey(a.subject).includes(subj) || subj.includes(normKey(a.subject))) && isFilledValue(a.subject));
    const valid = own.filter((a) => a.valid);
    const current = valid.filter((a) => !day || a.until >= day);
    if (current.length) item.acceptance = { status: 'accepted', by: current[0].by, until: current[0].until, version: current[0].version, notes: current[0].notes };
    else if (valid.length) {
      const last = valid.map((a) => a.until).sort().at(-1);
      item.acceptance = { status: 'expired', until: last, by: valid.find((a) => a.until === last).by };
      expired.push(item);
    } else if (own.length) item.acceptance = { status: 'invalid', why: own.flatMap((a) => a.why) };
    else item.acceptance = { status: 'none' };
  }

  return {
    d0Present: Boolean(d0),
    d0Policy,
    successors,
    degradation,
    emergencyBlank: d0 ? emergencyBlank : null,
    emergencyMissing,
    baselineScope,
    cycle: { drill: cycle.drill?.raw ?? null, exit: cycle.exit?.raw ?? null, degradation: cycle.degradation?.raw ?? null, competence: cycle.competence?.raw ?? null, successorMin: cycle.successorMin, trainer: cycle.trainer },
    cycleNotices,
    core,
    rehearsals,
    dependencies,
    spof,
    acceptances,
    expired,
    problems,
  };
}

// ---------------------------------------------------------------- 測定の記録・席の責任者の力量・実環境の統制(#288 第6巡)
//
// 出荷の集約(aggregate-evidence)と次の一手(next.mjs)と導入前の検証(adoption-trial)が同じ読み取りを使う。
// 変化点の後の失効・後継不在・未確認が、出荷の直前の集約でしか現れない状態(第5巡の穴N)を無くすため、
// 読み取りをここへ置き、next.mjs が注記として出す。要約・評価は足さない

/** 検出能力の測定の記録。記録の置き場(導入前の検証の tally が書き、コミットされる)を先に読む。evidence/ は記録の置き場が空のときの経路 */
export const SEEDED_SOURCES = ['docs/adoption-trial/seeded-errors.json', 'evidence/seeded-errors.json'];
/** 実環境の統制の確認の記録(附属書I I.11 の要件⑦。adoption-trial env-check が書く) */
export const ENV_CHECK_FILE = 'docs/adoption-trial/env-check.json';
export { JUDGE_SEATS };

/** 測定の記録を読む。採った出所と、読まなかった記録(記録の置き場に記録があるときの evidence/)を返す */
export function readSeededRecord({ root = ROOT } = {}) {
  const candidates = SEEDED_SOURCES.filter((p) => fs.existsSync(path.join(root, p)))
    .map((p) => {
      try {
        return { source: p, value: JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')) };
      } catch (e) {
        return { source: p, value: null, error: e.message };
      }
    })
    .filter((c) => c.value && typeof c.value === 'object');
  const pick = candidates.find((c) => c.source === SEEDED_SOURCES[0]) ?? candidates[0] ?? null;
  const value = pick?.value ?? null;
  return {
    source: pick?.source ?? null,
    value,
    ignored: candidates.filter((c) => c !== pick),
    human: value ? (value.human ?? (value.ai === undefined ? value : null)) : null,
    ai: value?.ai ?? null,
  };
}

/** AI の担い手の識別(モデル / 指示資産の版)。測定の記録の performers[] と現在の構成を同じ形で比べる */
export const performerIdentity = (p) => `${p?.model ?? '(モデル未記入)'} / ${p?.instructions ?? '(指示資産の版 未記入)'}`;

/**
 * AI の層の測定した担い手の識別(記録の performers[])と、現在の構成の識別の差。記録に識別が無ければ null
 * (日付の比較で補うのは呼び出し側)。差が1つでもあれば、その層の値は失効している(附属書H H.6 項目6。#288 第5巡 I)
 */
export function aiIdentityMismatch(config, seededAi) {
  const recorded = Array.isArray(seededAi?.performers) ? seededAi.performers : null;
  if (!seededAi || !recorded) return null;
  const performerSeats = (config.seats ?? []).filter((s) => s.performer);
  const now = performerSeats.map((s) => ({ seat: s.name ?? s.role, role: s.role, id: performerIdentity(s.performer) }));
  const rec = recorded.map((p) => ({ seat: p.seat ?? p.role ?? null, role: p.role ?? null, id: performerIdentity(p) }));
  const diffs = [];
  for (const n of now) {
    const r = rec.find((x) => (x.role && x.role === n.role) || (x.seat && x.seat === n.seat));
    if (!r) diffs.push(`${n.seat}: 測定の記録に無い席(現在 ${n.id})`);
    else if (r.id !== n.id) diffs.push(`${n.seat}: 測定 ${r.id} → 現在 ${n.id}`);
  }
  for (const r of rec) if (!now.some((n) => (r.role && r.role === n.role) || (r.seat && r.seat === n.seat))) diffs.push(`${r.seat ?? '(席の記録なし)'}: 測定した席が現在の構成に無い`);
  return diffs;
}

/** 名簿の体制の内の人か(外部の確認者と組織上の任命権者は体制の内に数えない) */
function inRosterInside(config, name) {
  const p = resolveSigner(config, name);
  return Boolean(p) && p.external !== true && p.appointer !== true;
}

/**
 * 人の層の測定した見つける者と、現在の独立レビュアの席の責任者・名簿の対応(#288 第6巡 O)。
 *
 * 人の層の検出率は、測定した見つける者(個人の集合)の能力の値である。測定の後に見つける者が席を離れれば、値は
 * 現在の体制の検出能力を示さない。AI の層の失効(担い手の識別の不一致)と同じ理屈が当たる。規則は次のとおり。
 *   (a) 測定した見つける者の全員が、名簿(体制の内)にも独立レビュアの席にも居なければ、失効
 *   (b) 一部が名簿から離れた場合、記録に各人の指摘(perFinder[].hits)があれば、残る者の指摘の和集合で値を読み直す
 *       (読み直した値も目隠しの測定である)。無ければ失効(離れた者の指摘を除いた値を読み直せない)
 *   (c) 現在の独立レビュアの席の責任者が測定した見つける者に含まれなければ、注記(再測定の契機)。層1 の「人の層の
 *       再測定の契機」に「席の責任者の交代」とあれば失効。「見つける者の離脱」とあれば、(b) の読み直しをせず失効
 * 旧い記録(finders が無い)は対応を出せない。その旨を返す(失効にはしない。測定時点の体制を機械で示せないため)
 */
export function humanFinderState(config, policy, seededHuman) {
  if (!seededHuman || typeof seededHuman !== 'object') return null;
  const finders = [...new Set([...(Array.isArray(seededHuman.finders) ? seededHuman.finders : []), ...(isFilledValue(seededHuman.finder) && !Array.isArray(seededHuman.finders) ? [seededHuman.finder] : [])].map((x) => String(x ?? '').trim()).filter(Boolean))];
  const seat = (config.seats ?? []).find((s) => s.role === 'independent-reviewer');
  const accountable = seat?.accountable ? resolveSigner(config, seat.accountable)?.name ?? seat.accountable : null;
  const trigger = policy?.cycle?.humanRemeasure ?? parseHumanRemeasure(null);
  if (!finders.length) {
    return { recorded: false, finders: [], accountable, accountableIncluded: null, departed: [], remaining: [], expired: false, why: null, recomputed: null, trigger, notes: ['測定した見つける者の記録が無い(旧い記録)。現在の席の責任者・名簿との対応を出せない。tally をやり直すと記録に見つける者が入る'] };
  }
  const mapping = finders.map((name) => ({ name, isAccountable: Boolean(accountable) && samePerson(config, name, accountable), inRoster: inRosterInside(config, name) }));
  const accountableIncluded = Boolean(accountable) && mapping.some((m) => m.isAccountable);
  const departed = mapping.filter((m) => !m.inRoster && !m.isAccountable).map((m) => m.name);
  const remaining = mapping.filter((m) => m.inRoster || m.isAccountable).map((m) => m.name);
  const notes = [];
  let expired = false;
  let why = null;
  let recomputed = null;
  if (!remaining.length) {
    expired = true;
    why = `測定した見つける者(${finders.join('・')})の全員が、名簿(体制の内)にも独立レビュアの席にも居ない`;
  } else if (accountable && !accountableIncluded && trigger.accountable) {
    expired = true;
    why = `層1 の「人の層の再測定の契機」(${trigger.raw})に当たる。現在の独立レビュアの席の責任者 ${accountable} が、測定した見つける者(${finders.join('・')})に含まれない`;
  } else if (departed.length && trigger.departure) {
    expired = true;
    why = `層1 の「人の層の再測定の契機」(${trigger.raw})に当たる。測定した見つける者のうち ${departed.join('・')} が名簿(体制の内)から離れた`;
  } else if (departed.length) {
    // (b) 残る者の指摘の和集合で読み直す。各人の指摘(hits: 注入の添字)が記録に無い旧い記録は読み直せない
    const per = seededHuman.perFinder && typeof seededHuman.perFinder === 'object' ? seededHuman.perFinder : {};
    const hitsOf = (who) => {
      const key = Object.keys(per).find((k) => samePerson(config, k, who)) ?? null;
      return key && Array.isArray(per[key]?.hits) ? per[key].hits : null;
    };
    const lists = remaining.map(hitsOf);
    if (lists.every((l) => Array.isArray(l))) {
      const union = new Set(lists.flat().map((x) => String(x)));
      const seeded = Number(seededHuman.seeded ?? seededHuman.injected ?? seededHuman.total ?? 0);
      recomputed = { detected: union.size, seeded, rate: seeded ? union.size / seeded : null, finders: remaining, departed };
      notes.push(`測定した見つける者のうち ${departed.join('・')} が名簿(体制の内)から離れた。値は、残る見つける者(${remaining.join('・')})の指摘の和集合(検出 ${union.size} 件 / 注入 ${seeded} 件)で読み直した。再測定の契機`);
    } else {
      expired = true;
      why = `測定した見つける者のうち ${departed.join('・')} が名簿(体制の内)から離れ、記録に各人の指摘(perFinder[].hits)が無いため、残る者の値を読み直せない`;
    }
  }
  if (accountable && !accountableIncluded && !expired) {
    notes.push(`現在の独立レビュアの席の責任者 ${accountable} は、測定した見つける者(${finders.join('・')})に含まれない。測定値は測定した見つける者の値であり、現在の責任者の検出能力を示さない(再測定の契機。層1 の「人の層の再測定の契機」は${trigger.blank ? '空欄' : `「${trigger.raw}」`})`);
  }
  if (!accountable) notes.push('独立レビュアの席の責任者が未記入のため、席の責任者との対応を出せない');
  return { recorded: true, finders, mapping, accountable, accountableIncluded, departed, remaining, expired, why, recomputed, trigger, notes };
}

/**
 * 席の責任者本人の、AI を使わずに判断できる力量の確認(第3章 3.4.3 要求事項1。#288 第6巡 R)。
 * 記録は構成の seats[].competence(/process-change の種別 accountable で、任命と同時か後に書く)。
 * 確認日が層1 の「AI を使わない力量の確認の周期」を過ぎた確認は失効。周期が空欄なら有効性を判定できない。
 * 記録の無い任命は「確認を経ない任命」(3.4.3 要求事項3。暫定任命として扱う)
 */
export function competenceState(config, policy, { day = null } = {}) {
  const cycle = policy?.cycle ?? NO_CYCLE;
  return JUDGE_SEATS.map(([label, role]) => {
    const seat = (config.seats ?? []).find((s) => s.role === role);
    const accountable = seat?.accountable ? resolveSigner(config, seat.accountable)?.name ?? seat.accountable : null;
    const c = seat?.competence && typeof seat.competence === 'object' ? seat.competence : null;
    let status = 'valid';
    let why = null;
    let nextDue = null;
    if (!accountable) {
      status = 'no-accountable';
      why = '席の責任者が未記入';
    } else if (!c) {
      status = 'missing';
      why = '任命時の力量の確認の記録が無い(確認を経ない任命。暫定任命として扱う。3.4.3 要求事項1・3)';
    } else if (c.person && !samePerson(config, c.person, accountable)) {
      status = 'missing';
      why = `記録は前任(${c.person})のもの。現在の責任者 ${accountable} の確認の記録が無い`;
    } else if (!isRealDay(c.confirmedAt)) {
      status = 'invalid';
      why = '確認日(YYYY-MM-DD)が無い';
    } else if (!isFilledValue(c.confirmedBy) || samePerson(config, c.confirmedBy, accountable)) {
      status = 'invalid';
      why = isFilledValue(c.confirmedBy) ? '確認した者が本人(自己申告は認めない。3.4.3 要求事項2)' : '確認した者が未記入';
    } else if (!cycle.competence) {
      status = 'cycle-blank';
      why = '層1 の AI を使わない力量の確認の周期が空欄のため、確認の有効性を判定できない';
    } else {
      nextDue = intervalEnd(c.confirmedAt, cycle.competence);
      if (!withinInterval(c.confirmedAt, cycle.competence, day)) {
        status = 'expired';
        why = `確認日 ${c.confirmedAt} が力量の確認の周期(${cycle.competence.raw})を過ぎている(失効。期限 ${nextDue})`;
      }
    }
    // 確認した者が人の名簿の外(外部の研修機関・前任の部門長など)の記録は受け付け、注記を付ける(#288 第7巡 T)。
    // 名簿の外の名前は機械で突合できないため、確認の記録に所属・役職を書き、内部監査の観点6(名簿の実在)で確かめる
    const judged = ['valid', 'expired', 'cycle-blank'].includes(status);
    const outsideRoster = judged && isFilledValue(c?.confirmedBy) && !resolveSigner(config, c.confirmedBy);
    const note = outsideRoster ? `確認した者 ${c.confirmedBy} は名簿の外(受け付ける。所属・役職は確認の記録 ${c.record ?? '所在なし'} で示す。内部監査の観点6 で名簿と突合する)` : null;
    return { seat: label, role, accountable, record: c, status, why, nextDue, ok: status === 'valid', outsideRoster, note };
  });
}

/** 名簿の外の確認した者の注記の短い形(D-0 節9・集約・次の一手で同じ語) */
export const OUTSIDE_ROSTER = '(名簿の外)';

/** 実環境の統制の確認の項目(附属書I I.11 要件⑦) */
export const ENV_CHECK_ITEMS = [
  ['ruleset', 'ルールセットの適用(要求する承認の数・最後の push の後の承認・コードオーナー・必須チェック)'],
  ['prReviews', 'PR のレビューの取得(gate-g5 が PR_REVIEWS に渡す gh api …/pulls/N/reviews)'],
  ['shipEvidence', 'ship-evidence の成果物の取得(gate-g5 の実行の license-scan・test-results)'],
];

/**
 * 確認済みの項目が伴うべき、実環境の API の応答の識別(#288 第7巡 V)。確認した者の記名だけでは、固定の応答で作った記録と
 * 実環境で作った記録を区別できない。査察で GitHub の画面と突合できる鍵(ルールセットの id、レビューの id、実行の id と URL)を
 * 記録に要し、無い確認済みは「実環境の証拠を欠く」として未確認に倒す
 */
export const ENV_EVIDENCE_KEYS = {
  ruleset: [['rulesetIds', (v) => Array.isArray(v) && v.length > 0]],
  prReviews: [
    ['pr', (v) => Number.isFinite(Number(v)) && Number(v) > 0],
    ['reviewIds', (v) => Array.isArray(v) && v.length > 0],
  ],
  shipEvidence: [
    ['runId', (v) => Number.isFinite(Number(v)) && Number(v) > 0],
    ['runUrl', (v) => typeof v === 'string' && /^https?:\/\//.test(v)],
  ],
};

/** 項目 id の確認済みに欠けている識別の鍵の一覧(空なら足りている) */
export function envEvidenceMissing(id, evidence) {
  const keys = ENV_EVIDENCE_KEYS[id] ?? [];
  if (!evidence || typeof evidence !== 'object') return keys.map(([k]) => k);
  return keys.filter(([k, ok]) => !ok(evidence[k])).map(([k]) => k);
}

/** 記録の実環境の識別を1行で(記録の節3・集約の項目4・次の一手で同じ文)。識別が1つも無ければ null */
export function envEvidenceText(env) {
  if (!env?.record) return null;
  const parts = [];
  if (env.record.repoUrl) parts.push(`リポジトリ ${env.record.repoUrl}`);
  for (const i of env.items ?? []) {
    const e = i.evidence;
    if (!e || typeof e !== 'object') continue;
    if (i.id === 'ruleset' && Array.isArray(e.rulesetIds) && e.rulesetIds.length) parts.push(`ルールセット id ${e.rulesetIds.join('・')}`);
    if (i.id === 'prReviews' && Array.isArray(e.reviewIds) && e.reviewIds.length) parts.push(`PR #${e.pr} のレビュー id ${e.reviewIds.join('・')}${e.lastSubmittedAt ? `(最後の提出 ${e.lastSubmittedAt})` : ''}`);
    if (i.id === 'shipEvidence' && e.runId) parts.push(`gate-g5 の実行 ${e.runId}(${e.runUrl ?? 'URL なし'}${Array.isArray(e.artifactIds) && e.artifactIds.length ? `。成果物 id ${e.artifactIds.join('・')}` : ''})`);
  }
  const fetched = (env.items ?? []).map((i) => i.evidence?.fetchedAt).filter((v) => typeof v === 'string').sort();
  if (fetched.length) parts.push(`応答の取得 ${fetched[0].slice(0, 19)}${fetched.length > 1 && fetched.at(-1) !== fetched[0] ? `〜${fetched.at(-1).slice(0, 19)}` : ''}`);
  return parts.length ? parts.join(' / ') : null;
}

/**
 * 実環境の統制の確認の記録を読む(#288 第6巡)。記録が無い・項目が確認済みでない・記録の対象のリポジトリや
 * 構成が現在と違う場合は「未確認」として表示し続ける(未達のゲートと同じ扱い。消さない)
 */
export function readEnvCheck(config, { root = ROOT } = {}) {
  const p = path.join(root, ENV_CHECK_FILE);
  const out = { present: fs.existsSync(p), record: null, items: [], confirmed: false, problems: [], committed: null, summary: '' };
  if (!out.present) {
    out.summary = `未確認(${ENV_CHECK_FILE} が無い。採用者が実環境の gh で node scripts/gate/adoption-trial.mjs env-check --by <氏名> を実行し、記録をコミットする)`;
    out.items = ENV_CHECK_ITEMS.map(([id, label]) => ({ id, label, status: 'unconfirmed', detail: '記録なし' }));
    return out;
  }
  try {
    out.record = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    out.problems.push(`${ENV_CHECK_FILE} を JSON として読めない(${e.message})`);
    out.summary = `未確認(${out.problems[0]})`;
    out.items = ENV_CHECK_ITEMS.map(([id, label]) => ({ id, label, status: 'unconfirmed', detail: '記録を読めない' }));
    return out;
  }
  const r = out.record;
  out.items = ENV_CHECK_ITEMS.map(([id, label]) => {
    const it = r.items?.[id] ?? null;
    let status = it?.status === 'confirmed' ? 'confirmed' : it?.status === 'mismatch' ? 'mismatch' : 'unconfirmed';
    let detail = it?.detail ?? '記録に項目が無い';
    // 確認済みは、実環境の API の応答の識別を伴う(構成が確かめる項目を要しない「確かめる項目なし」は除く)。
    // 識別の無い確認済みは実環境の証拠を欠くため未確認に倒す(#288 第7巡 V)。第6巡の記録(識別なし)もここで未確認になる
    if (status === 'confirmed' && it?.notApplicable !== true) {
      const missing = envEvidenceMissing(id, it?.evidence);
      if (missing.length) {
        status = 'unconfirmed';
        detail = `実環境の証拠を欠く(記録に応答の識別 ${missing.join('・')} が無い。第7巡より前の記録、または識別を返さない gh。env-check を実行し直す)。元の記載: ${detail}`;
      }
    }
    return { id, label, status, detail, evidence: it && typeof it.evidence === 'object' ? it.evidence : null, notApplicable: it?.notApplicable === true };
  });
  if (!isFilledValue(r.checkedBy) || aiNameReason(String(r.checkedBy))) out.problems.push('確認した者(checkedBy)が未記入、または AI の名義');
  if (!isRealDay(String(r.checkedAt ?? '').slice(0, 10))) out.problems.push('確認日(checkedAt)が日付でない');
  const want = Math.max(1, Number(config.review?.reviewerCount ?? config.review?.requiredApprovals ?? 1) || 1);
  if (r.config && Number(r.config.reviewerCount) !== want) out.problems.push(`記録の時点の承認者の数(${r.config.reviewerCount})が現在の構成(${want})と違う。確認し直す`);
  if (r.config && (config.ruleset ?? null) && r.config.ruleset !== config.ruleset) out.problems.push(`記録の時点のルールセット(${r.config.ruleset ?? 'なし'})が現在の構成(${config.ruleset})と違う。確認し直す`);
  try {
    const committed = execFileSync('git', ['log', '-1', '--format=%cI', '--', ENV_CHECK_FILE], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ENV_CHECK_FILE], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    out.committed = Boolean(committed) && !dirty;
    if (!committed) out.problems.push(`${ENV_CHECK_FILE} がコミットされていない`);
    else if (dirty) out.problems.push(`${ENV_CHECK_FILE} にコミットの後の変更がある`);
  } catch {
    out.committed = null;
  }
  const allOk = out.items.every((i) => i.status === 'confirmed');
  out.confirmed = allOk && !out.problems.length;
  const itemText = out.items.map((i) => `${i.label.split('(')[0]} ${i.status === 'confirmed' ? '確認済み' : i.status === 'mismatch' ? '**構成と一致しない**' : '**未確認**'}(${i.detail})`).join(' / ');
  out.evidenceText = envEvidenceText(out);
  out.summary = out.confirmed
    ? `確認済み(${String(r.checkedAt).slice(0, 10)} ${r.checkedBy}。対象 ${r.repo ?? 'リポジトリ未記録'})。${itemText}${out.evidenceText ? `。実環境の識別: ${out.evidenceText}` : ''}`
    : `未確認(${[...out.items.filter((i) => i.status !== 'confirmed').map((i) => `${i.label.split('(')[0]}: ${i.detail}`), ...out.problems].join(' / ')})`;
  return out;
}

// ---------------------------------------------------------------- 10名以上の規則(第8章 軸A)の項目1 の文

/**
 * コア機能の独立レビューに別チームを含むか(構成 review.mode: internal-plus-core-external)の値の文。
 * 出荷の集約の項目1 と次の一手(/pit)で同じ文を出す(#288 第7巡 U)。cr は集約が出す independence.coreReview
 */
export function coreReviewText(cr) {
  if (!cr) return null;
  if (cr.why) return `判定できない(${cr.why})`;
  const same = Array.isArray(cr.sameTeamOnly) ? cr.sameTeamOnly : [];
  const und = Array.isArray(cr.undetermined) ? cr.undetermined : [];
  return `コア機能(確約範囲・コア指定のパス)に触れ、独立した人の確認に数えた変更 ${cr.coreChanges} 件のうち、作成を指示した者と別の所属の承認者を含む ${cr.withOtherTeam} 件 / 同じ所属の承認者だけ ${same.length} 件${same.length ? `(${same.join(', ')})` : ''} / 判定できない ${und.length} 件${und.length ? `(${und.join(', ')})` : ''}`;
}

/** 出荷判定は QA 部門・専任者か(構成 approverMode: dedicated-qa)の値の文。qa は集約が出す independence.qaAffiliation */
export function qaAffiliationText(qa) {
  if (!qa) return null;
  if (qa.why) return `確かめられない(${qa.why})`;
  return qa.separate
    ? `出荷判定者 ${qa.qa} の所属 ${qa.qaTeam}(開発者の席の責任者の所属 ${qa.devTeam} と別)`
    : `**出荷判定者 ${qa.qa} の所属 ${qa.qaTeam} が、開発者の席の責任者の所属と同じ**(QA 部門・専任の形でない)`;
}

// ---------------------------------------------------------------- 停止の申し立て(第7章 7.11)

export const STOP_LABEL = 'state:stop-requested';
export const STOP_GATE = '停止の申し立ての解除';

/**
 * 解除の記録(ゲート判定記録の様式で、ゲート欄が「停止の申し立ての解除」のもの)を読む。text は記録の本文。
 * 解除を受け付けない理由を problems に出す
 */
export function parseStopRelease(config, policy, file, text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  const gate = rowValue(t, 'ゲート');
  if (!gate || !nfkc(gate).includes(STOP_GATE)) return null;
  const target = rowValue(t, '対象');
  const judge = rowValue(t, '判定者');
  const at = rowValue(t, '判定日時');
  const result = clean(rowValue(t, '結果'));
  const requester = rowValue(t, '申し立てた者');
  const reason = rowValue(t, '解除の理由');
  const rejected = nfkc(rowValue(t, '申し立てた者の見解を退けたか'));
  const escalation = rowValue(t, '上申先と日付');
  const problems = [];
  if (result !== '通過') problems.push(`結果が「通過」(解除する)でない(${result || '未記入'})`);
  if (!isFilledValue(judge)) problems.push('解除した者(判定者)の記名が無い');
  if (!isFilledValue(reason)) problems.push('解除の理由が未記入');
  if (!isFilledValue(requester)) problems.push('申し立てた者が未記入');
  const day = String(at ?? '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  if (!isRealDay(day)) problems.push('判定日時(解除の日時)が日付で始まらない');
  const declined = /^退けた/.test(rejected);
  if (!/^退けた|^退けていない/.test(rejected)) problems.push('「申し立てた者の見解を退けたか」が「退けた」「退けていない」のどちらでもない');
  if (declined && !(isFilledValue(escalation) && /\d{4}-\d{2}-\d{2}/.test(nfkc(escalation)))) problems.push('申し立てた者の見解を退けた解除に、上申先と日付の記録が無い');
  const auth = isFilledValue(judge) ? checkAuthority(config, policy, /停止の申し立ての解除/, judge, { fallbackSeat: 'biz-approver', requireRoster: true }) : { problems: [], notes: [] };
  problems.push(...auth.problems);
  const selfReleased = isFilledValue(judge) && isFilledValue(requester) && samePerson(config, judge, requester);
  return { file, target, judge, at, day, requester, declined, escalation, valid: problems.length === 0, problems, notes: auth.notes, selfReleased };
}

// ---------------------------------------------------------------- 単体の実行(#288 第5巡)
//
// 層1 の有効性・必須行の空欄・成立条件のうち構成と記録から出せるもの(条件1、条件6 のうち D-0 表4 の空欄)・
// 組織継続の状態(単一障害点の一覧と受容の状態)を出す。変更ごとの条件(2〜6 の残り)は出荷の集約が出す。
// 要約・評価は足さない。読むのは出荷の集約と同じ関数である

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const config = loadConfig();
  const today = localDay();
  const policy = readPolicy(config, { today });
  const ct = continuityState(config, policy, { day: today });
  const acceptanceText = (a) => {
    if (!a || a.status === 'none') return '受容なし';
    if (a.status === 'accepted') return `受容あり(${a.by}。期限 ${a.until})`;
    if (a.status === 'expired') return `受容の期限切れ(${a.until}。記載の欠落)`;
    return `受容が成立しない(${(a.why ?? []).join('。')})`;
  };
  const summary = {
    policy: { file: POLICY_FILE, present: policy.present, valid: policy.valid, label: policy.label, signer: policy.signer ?? null, problems: policy.problems, requiredBlank: policy.requiredBlank ?? [], tolerance: policy.tolerance?.raw ?? null },
    conditions: [
      { id: 1, label: '層1 の方針と受容の基準が、トップマネジメントの記名で有効である', ok: policy.valid, reason: policy.valid ? null : policy.problems.join(' / ') },
      { id: 6, label: '(一部)D-0 表4 の有事の決定者に空欄が無い(記載の欠落。全体は出荷の集約が出す)', ok: !ct.emergencyMissing.length, reason: ct.emergencyMissing.length ? `空欄 ${ct.emergencyMissing.length} 欄: ${ct.emergencyMissing.slice(0, 6).join(' / ')}${ct.emergencyMissing.length > 6 ? ' ほか' : ''}` : null },
    ],
    notMachineHere: '成立条件2〜5 と条件6 の残り(記録の欠落・受容しない条件に当たる事実)は、出荷の集約(node scripts/gate/aggregate-evidence.mjs)が変更ごとに出す',
    continuity: {
      d0Present: ct.d0Present,
      d0Policy: ct.d0Policy,
      spof: ct.spof.map((s) => ({ state: s.state, subject: s.subject, detail: s.detail, candidate: s.candidate === true, acceptance: acceptanceText(s.acceptance) })),
      expired: ct.expired.map((s) => `${s.state}: ${s.subject}`),
      cycle: ct.cycle,
      cycleNotices: ct.cycleNotices ?? [],
      problems: ct.problems,
    },
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const L = [];
    L.push('## 層1(品質保証の方針と受容の基準)と組織継続の状態(単体の読み取り。出荷の集約と同じ関数)');
    L.push('');
    L.push(`- 層1: ${policy.present ? `${POLICY_FILE}(版 ${policy.label}。記名者 ${policy.signer ?? '未記入'})` : `無し(${POLICY_FILE} が無い)`} → ${policy.valid ? '有効' : '**無効**'}`);
    for (const p of policy.problems) L.push(`  - ${p}`);
    L.push(`- 項目4 の必須行の空欄: ${(policy.requiredBlank ?? []).length ? `**${policy.requiredBlank.length} 行**(${policy.requiredBlank.join(' / ')})` : 'なし'}`);
    L.push(`- 検出能力の未測定を許容する期間(項目1): ${policy.tolerance?.raw ?? '未記入(許容しないとして扱う)'}`);
    L.push(`- 項目4「AI の利用の拡大」の水準: ${policy.delegationLock?.locked ? `**委任の登録を認めない(構成の錠。/process-change の種別 mode・performer は委任の登録を拒否する)**` : policy.delegationLock?.unclear ? `「${policy.delegationLock.level}」(語「認めない」を含むが、機械が読む形(欄の先頭が「認めない」)でない。錠は掛からない。意図が「認めない」なら欄の先頭に書く)` : policy.delegationLock?.level ? `「${policy.delegationLock.level}」(委任の登録は構成で拒否しない。登録には項目4 の受容者の受容を要する)` : '未記入'}`);
    for (const c of policy.conditions.filter((x) => x.kind === '未測定')) L.push(`- 印 [${c.tag}]: ${c.layer === 'human' ? '人の層だけに当たる' : c.layer === 'ai' ? 'AI の層だけに当たる' : '人の層・AI の層の両方に当たる'}(項目1 の許容期間に依らず、未測定の最初の出荷から)${c.periodWords ? `。文に期間の表現(「${c.periodWords}」)がある。意図が猶予なら印を外し、即時なら「依らず」と書く(人が確かめる)` : ''}`);
    L.push('');
    L.push('### 成立条件(構成と記録だけから出せるもの)');
    L.push('');
    for (const c of summary.conditions) L.push(`- 条件${c.id} ${c.label}: ${c.ok ? '満たす' : `**満たさない**(${c.reason})`}`);
    L.push(`- ${summary.notMachineHere}`);
    L.push('');
    L.push('### 組織継続の状態(単一障害点の一覧と受容)');
    L.push('');
    if (!ct.d0Present) L.push(`- D-0(${D0_FILE})が無い。節9・節12・節15 を読めない`);
    if (!ct.spof.length) L.push('- 単一障害点なし');
    for (const s of summary.continuity.spof) L.push(`- ${s.state}: ${s.subject}(${s.detail})${s.candidate ? '【候補】' : ''} → ${s.acceptance}`);
    if (summary.continuity.expired.length) L.push(`- 期限を過ぎた受容(記載の欠落): ${summary.continuity.expired.join(' / ')}`);
    for (const n of summary.continuity.cycleNotices) L.push(`- 注記: ${n}`);
    for (const p of ct.problems) L.push(`- 問題: ${p}`);
    L.push('');
    L.push('要約・評価は出しません。受容は層1 の項目4 の権限者が D-0 節15 に記名します。出荷の判断は出荷の集約の出力によります。');
    console.log(L.join('\n'));
  }
  process.exit(policy.valid && !ct.emergencyMissing.length ? 0 : 1);
}
