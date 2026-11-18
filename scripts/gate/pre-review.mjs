// 事前レビュー期間の受付・起票・通知・集計(IMPL-0571・0210・0213・0219・0215・0216。束 B18 裁定 §3.9。process-compass #325)
//
// 運び手は Issue の様式 .github/ISSUE_TEMPLATE/pre-review.yml で起票した Issue(ラベル pre-review)である。
// 機械が決めるのは、日時の比較・件数・有無・欄の空だけである。コメントと記名(@login)で知らせるだけで、合否を持たない。
// 必須チェックにしない(ADR-0200 決定4。pre-review-closed・pre-review-all-responded は IMPL-0214 の重の審議に残す)。
// 内容の確定・意見の採否・措置(代理の指名)は人が行う。AI の担い手のコメントは、意見にも応答にも数えない(標準 3.10.1)。
//
//   - 0571 種別が B-1〜B-4 と工程ゲートの Issue を対象にし、標準変更を外す。工程ゲートは非同期コメント期間だけ(判定当日の手順を起動しない)
//   - 0210 判定予定日 T の5営業日前(R1 は10営業日前)に、判定資料の Issue を草案の印つきで起票し、3.10.3 の5項目の見出しを置く。
//          各項目の中身は起案者が書く。題名の先頭の「[草案] 」を起案者が外すまで「公開」に数えない
//   - 0213 締切(T−2営業日。R1 は T−5営業日)の2営業日前と前営業日に通知し、誰がいつ通知を受け、いつ最初に応答したかの一覧を残す
//   - 0219 通知の宛先を未応答の者に絞る(前営業日は D-0 節6 の判定する者にも)。締切を過ぎて未応答が残れば、3.9.3 の措置の宛先へ通知する
//   - 0215 意見のコメントの雛形(賛否:・理由:・代替案または充足条件:)の欄の空を示す。注意の喚起に限る(意見を応答の対象から外さない)
//   - 0217(検出と記載・通知の部分) 判定資料の所在が PR を指すとき、その変更ファイルに当たる CODEOWNERS の行の所有者を「必須応答」として記載し、
//          指名レビュアに含まれない者を示す。締切で記名の応答が無い必須の者を、0219 の宛先へ通知する。標準 3.10.9 の条文(記名の応答が揃うまで判定へ進めない)は有効だが、機械が止める強制は作らない(機械化は未決。IMPL-0214 と同じ重の審議)
//   - 0830(共通の部分) 判定資料の公開が T の5営業日前(R1 は10)より遅いものを「短縮」として検出し、対象を当該の Issue か PR とするファストトラックの行
//          (ADR-0200 の印)が台帳に無ければ、起案者と 0219 の宛先へ通知する。行があれば「短縮の経路と下限は未決」と表示し、通知しない・合格ともしない。
//          公開の時点は GitHub の上の値(資料の Issue の草案の印を外した時刻か作成の時刻。所在だけの上程は、上程と所在の PR の作成の時刻の遅い方を下限)で読む。
//          読めない所在(外部の URL など)は検出せず、「公開の時点を確かめていない」と出す
//   - 0216 月次で、応答が付いていない意見の比率などを集計し、指標の Issue へコメントする(個人の集計を出さない。3.10.11)
//
// 日付・時刻は引数で渡し、時計を読まない。暦の日は business-days.mjs(UTC の暦、明示した差で直す)で求める。
// GitHub への読み書きは差し替えられる(fetchIssues・postComment など)。通知は冪等である(同じ印のコメントがあれば出さない)。
//
// 使い方: node scripts/gate/pre-review.mjs [notify|metrics] [--month YYYY-MM] [--dry-run] [--now ISO] [--offset-minutes 540]
//   環境変数: GITHUB_REPOSITORY, GH_TOKEN, PRE_REVIEW_METRICS_ISSUE(指標の Issue の番号。月次の集計の宛先)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig, aiAccountCheck, dedicatedSeatOf, parseLedger, CODEOWNERS_PLACES } from './config.mjs';
import { addBusinessDays, dayOf, isRealDate, isBusinessDay, loadHolidays, HOLIDAYS_FILE, DEFAULT_OFFSET_MINUTES } from './business-days.mjs';
import { escalationTarget, ghCli, json, BOT_LOGIN } from './review-queue.mjs';
import { parseCodeowners, codeownersMatch } from './roster-ids.mjs';

const D0_FILE = 'docs/D-0-governance.md';
const LEDGER_FILE = 'docs/debt-ledger.md';
export const MARKER = 'pit-in:pre-review';
export const LABEL = 'pre-review';
export const MATERIAL_LABEL = 'pre-review-material';
export const DRAFT_PREFIX = '[草案] ';

/** Issue の様式の欄の見出し(pre-review.yml の label と一致させる) */
export const FIELDS = {
  kind: '種別',
  gate: '工程ゲート',
  risk: 'リスク区分',
  due: '判定予定日 T',
  author: '起案者',
  reviewers: '指名レビュア',
  material: '判定資料の所在',
};

const norm = (s) => String(s ?? '').normalize('NFKC').trim();

/** Issue の様式で起票された本文(### 見出し + 値)を欄ごとに読む。「_No response_」は空 */
export function parseIssueForm(body) {
  const out = {};
  const parts = String(body ?? '').replace(/\r\n/g, '\n').split(/^###\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const label = norm(nl < 0 ? part : part.slice(0, nl));
    const value = nl < 0 ? '' : part.slice(nl + 1).trim();
    out[label] = /^_?No response_?$/i.test(value) ? '' : value;
  }
  return out;
}

/** 記名(@login)を読む。電子メールの `@ドメイン` と、チームの `@組織/名前` は login に数えない */
const rawLoginTokens = (text) => [...String(text ?? '').matchAll(/(?<![A-Za-z0-9._%+-])@([A-Za-z0-9_-]+)(?![A-Za-z0-9_-]|\/)/g)].map((m) => m[1]);
/** GitHub の login は英数字とハイフンだけ(先頭は英数字、39 文字まで)。成り立たない綴り(`bob_x` など)は login と読まない */
const isLogin = (t) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(t);
const loginsOf = (text) => rawLoginTokens(text).filter(isLogin);
const badLoginsOf = (text) => rawLoginTokens(text).filter((t) => !isLogin(t));

/** 起票者の GitHub 上の関係のうち、機械が対象にするもの(公開リポジトリで外部の者の起票を対象にしない) */
export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
/** 月は YYYY-MM(月次の集計の引数) */
export const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v ?? ''));
const uniq = (list) => [...new Map(list.map((l) => [l.toLowerCase(), l])).values()];

/**
 * 事前レビュー期間の対象の選び方(IMPL-0571)。
 * 戻り値: { target: 'proposal'|'gate'|null, reason }。標準変更(3.7.4)は対象外。読めない種別は対象にせず理由に書く
 */
export function targetOf(fields) {
  const kind = norm(fields[FIELDS.kind]);
  if (/^B-[1-4](\D|$)/.test(kind)) return { target: 'proposal', reason: null };
  if (kind.startsWith('工程ゲート')) return { target: 'gate', reason: null };
  if (kind.startsWith('標準変更')) return { target: null, reason: '標準変更(3.7.4)は事前承認済みの経路のため、事前レビュー期間の対象にしない' };
  return { target: null, reason: `種別「${kind || '(空)'}」を読めない(B-1〜B-4・工程ゲート・標準変更のいずれか)` };
}

/** リスク区分の欄から R1〜R3 を読む。読めなければ null */
export function riskOf(fields) {
  const m = /^R([1-3])/.exec(norm(fields[FIELDS.risk]));
  return m ? `R${m[1]}` : null;
}

/** 3.10.2 の時点を営業日で求める。T は判定日。R1 は T−10 営業日の公開・T−5 営業日の締切、それ以外は T−5・T−2 */
export function timelineOf(T, risk, holidays = new Set()) {
  const r1 = risk === 'R1';
  const publishDay = addBusinessDays(T, r1 ? -10 : -5, holidays);
  const deadlineDay = addBusinessDays(T, r1 ? -5 : -2, holidays);
  return {
    publishDay,
    deadlineDay,
    notice2Day: addBusinessDays(deadlineDay, -2, holidays),
    notice1Day: addBusinessDays(deadlineDay, -1, holidays),
    answerDay: addBusinessDays(T, -1, holidays),
  };
}

/** 担い手(AI)のアカウントか。bot・AI を示す語・専用と申告した担い手のアカウントのいずれか */
export function isAiActor(config, c) {
  if (aiAccountCheck(config ?? {}, c.login ?? '', Boolean(c.bot)).reason) return true;
  return Boolean(dedicatedSeatOf(config ?? {}, { login: c.login, id: c.userId ?? null }));
}

const OPINION_LABELS = ['賛否', '理由', '代替案または充足条件'];

/** 意見のコメントか(欄の見出し「賛否:」の行がある)。欄の値を読む。値は見出しから次の見出しの前まで */
export function parseOpinion(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  if (!/^\s*賛否\s*[:：]/m.test(text)) return null;
  const out = {};
  const re = new RegExp(`^\\s*(${OPINION_LABELS.join('|')})\\s*[:：]`, 'gm');
  const hits = [...text.matchAll(re)];
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    out[m[1]] = text.slice(m.index + m[0].length, end).trim();
  });
  return { stance: out['賛否'] ?? '', reason: out['理由'] ?? '', alt: out['代替案または充足条件'] ?? '' };
}

/** 意見の様式の欄の空(0215)。賛否が反対のときだけ、代替案または充足条件の空も数える(標準 3.10.4) */
export function opinionGaps(op) {
  const gaps = [];
  if (!op.stance) gaps.push('賛否');
  if (!op.reason) gaps.push('理由');
  if (/^反対/.test(norm(op.stance)) && !op.alt) gaps.push('代替案または充足条件');
  return gaps;
}

const OWN_MARK = new RegExp(`<!-- ${MARKER}`);
/** 印は機械(github-actions)のコメントのものだけを読む。人が印を書いて通知を止めたり、一覧の時刻を偽ったりできないようにする */
export const isMachine = (c) => Boolean(c?.bot) && c.login === BOT_LOGIN;
const hasKey = (comments, key) => (comments ?? []).some((c) => isMachine(c) && typeof c.body === 'string' && c.body.includes(`<!-- ${MARKER} ${key} -->`));
const stamp = (key, text) => `<!-- ${MARKER} ${key} -->\n${text}`;

/** 起案者の応答の宣言行 `応答: <意見のコメントの URL>` が結ぶ意見のコメントの id の集合(0216) */
export function respondedIds(comments, author, config) {
  const ids = new Set();
  for (const c of comments) {
    if (!author || c.login?.toLowerCase() !== author.toLowerCase() || isAiActor(config, c)) continue;
    for (const m of String(c.body ?? '').matchAll(/^\s*応答\s*[:：]\s*(\S+)/gm)) {
      const id = /issuecomment-(\d+)/.exec(m[1]);
      if (id) ids.add(Number(id[1]));
    }
  }
  return ids;
}

/** 判定資料の所在が指す PR の番号(`.../pull/N` の URL か `PR #N`)。指していなければ null */
export function materialPrOf(text, repo = null) {
  return prRefOf(text, repo).number;
}

/** 所在の PR の読み。{ number, foreign }。URL の owner/repo が repo と違えば number は null で foreign に URL を入れる(repo を渡さないときは照らさない) */
export function prRefOf(text, repo = null) {
  const t = norm(text);
  const u = /https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?!\d)/i.exec(t);
  if (u) {
    if (repo && `${u[1]}/${u[2]}`.toLowerCase() !== String(repo).toLowerCase()) return { number: null, foreign: u[0] };
    return { number: Number(u[3]), foreign: null };
  }
  const m = /\/pull\/(\d+)(?!\d)/.exec(t) ?? /(?:^|[^A-Za-z])PR\s*#\s*(\d+)(?!\d)/i.exec(t);
  return { number: m ? Number(m[1]) : null, foreign: null };
}

/**
 * 変更ファイルに当たる CODEOWNERS の行の所有者(IMPL-0217)。GitHub と同じく、ファイルごとに最後に当たった行の所有者を使う。
 * logins: 個人の login(重複なし)、teams: チーム(個人に解決できない)、emails: 電子メールの所有者(個人の login に解決できない)、
 * unowned: どの行にも当たらないファイルと、最後に当たった行に所有者がないファイル(GitHub では所有者なし)
 */
export function requiredOwners(codeownersText, files) {
  const rows = parseCodeowners(codeownersText);
  const logins = new Map();
  const teams = new Set();
  const unowned = [];
  const emails = new Set();
  for (const f of files ?? []) {
    const hit = rows.filter((r) => codeownersMatch(r.pattern, f)).at(-1);
    if (!hit || !hit.owners.length) {
      unowned.push(f);
      continue;
    }
    for (const o of hit.owners) {
      const m = /^@([^/\s]+)(\/.+)?$/.exec(o);
      if (!m) {
        if (/^[^@\s]+@[^@\s]+$/.test(o)) emails.add(o);
        continue;
      }
      if (m[2]) teams.add(o);
      else if (isLogin(m[1]) && !/^OWNER$/i.test(m[1])) logins.set(m[1].toLowerCase(), m[1]);
    }
  }
  return { logins: [...logins.values()], teams: [...teams], emails: [...emails], unowned };
}

const FAST_TRACK_MARK = /^ファストトラック[((]\s*短縮\s*[::]\s*([^))]*)[))]/;
/** 台帳から、対象が #n を指すファストトラックの行(区分「例外」・内容の先頭が印 `ファストトラック(短縮: <ゲート>)`)を探す。行の有効性は問わない */
export function fastTrackRowsFor(ledgerText, numbers) {
  const wanted = (numbers ?? []).filter((n) => Number.isInteger(n));
  return parseLedger(ledgerText)
    .filter((r) => r.kind === '例外' && FAST_TRACK_MARK.test(String(r.content ?? '').normalize('NFKC').trim()))
    .filter((r) => wanted.some((n) => new RegExp(`(?:^|[^0-9])#\\s*${n}(?!\\d)`).test(String(r.target ?? '').normalize('NFKC'))))
    .map((r) => r.id);
}

/** 判定資料の Issue の履歴から、草案の印を外した(題名を改めた)時刻。外した記録が無ければ null。複数あれば最後(草案へ戻して公開し直したときは、最後の公開を採る。最初の公開より遅くなる) */
export function publishedAtOf(events) {
  const hit = (events ?? [])
    .filter((e) => e.event === 'renamed' && String(e.rename?.from ?? '').startsWith(DRAFT_PREFIX.trim()) && !String(e.rename?.to ?? '').startsWith(DRAFT_PREFIX.trim()) && Number.isFinite(Date.parse(e.created_at)))
    .map((e) => e.created_at)
    .sort()
    .at(-1);
  return hit ?? null;
}

/** Issue 1件の事前レビューの状態を読む(純関数) */
export function readProposal(issue, { config, holidays = new Set(), repo = null }) {
  const fields = parseIssueForm(issue.body);
  const t = targetOf(fields);
  const risk = riskOf(fields);
  const T = norm(fields[FIELDS.due]);
  const out = { number: issue.number, fields, ...t, risk, T: isRealDate(T) ? T : null, problems: [], cautions: [] };
  const ref = prRefOf(fields[FIELDS.material], repo);
  out.materialPr = ref.number;
  if (!t.target) return out;
  if (issue.association !== undefined && !TRUSTED_ASSOCIATIONS.includes(issue.association)) {
    return { ...out, target: null, reason: `起票者の関係(${issue.association || '不明'})が OWNER・MEMBER・COLLABORATOR ではないため、対象にしない(外部の者の起票で機械が通知を出さないため)` };
  }
  if (ref.foreign) out.cautions.push(`判定資料の所在が別のリポジトリの PR(${ref.foreign})を指すため、変更ファイルを読まず、必須応答を導出しない(別のリポジトリの同じ番号の PR と取り違えない)`);
  if (!risk) out.problems.push('リスク区分を読めない(R1〜R3)');
  if (!out.T) out.problems.push('判定予定日 T を読めない(YYYY-MM-DD)');
  else if (!isBusinessDay(out.T, holidays)) out.cautions.push(`判定予定日 T(${out.T})が営業日ではない(土日・祝日。祝日は ${HOLIDAYS_FILE} がある場合だけ数える)。意図した日かを起案者が確かめる(各時点は T から営業日を遡って求める)`);
  if (t.target === 'gate' && !/^G-[1-8]$/.test(norm(fields[FIELDS.gate]))) out.problems.push('工程ゲートの欄を読めない(G-1〜G-8)');
  for (const f of [FIELDS.author, FIELDS.reviewers]) {
    const bad = badLoginsOf(fields[f]);
    if (bad.length) out.cautions.push(`${f}の欄に login として成り立たない綴り(${bad.map((b) => '@' + b).join('・')})がある(login は英数字とハイフンだけ)。読まずに外す`);
  }
  out.author = loginsOf(fields[FIELDS.author])[0] ?? null;
  if (!out.author) out.problems.push('起案者を読めない(欄に @login を書く)');
  const named = uniq(loginsOf(fields[FIELDS.reviewers]));
  out.aiReviewers = named.filter((l) => isAiActor(config, { login: l }));
  out.reviewers = named.filter((l) => !out.aiReviewers.includes(l));
  if (!out.reviewers.length) out.problems.push('指名レビュアを読めない(@login)');
  if (out.risk && out.T) out.timeline = timelineOf(out.T, risk, holidays);
  const humans = (issue.comments ?? []).filter((c) => !(isMachine(c) && OWN_MARK.test(c.body ?? '')) && !isAiActor(config, c));
  out.opinions = humans
    .map((c) => ({ c, op: parseOpinion(c.body) }))
    .filter((x) => x.op && x.c.login?.toLowerCase() !== out.author?.toLowerCase())
    .map((x) => ({ id: x.c.id, login: x.c.login, at: x.c.at, ...x.op }));
  out.responded = new Set(out.opinions.filter((o) => o.stance).map((o) => o.login.toLowerCase()));
  out.firstResponse = new Map();
  for (const c of humans) {
    const op = parseOpinion(c.body);
    if (!op || !op.stance) continue;
    const k = c.login.toLowerCase();
    if (!out.firstResponse.has(k) || Date.parse(c.at) < Date.parse(out.firstResponse.get(k))) out.firstResponse.set(k, c.at);
  }
  out.answeredIds = respondedIds(humans, out.author, config);
  return out;
}

const mention = (l) => `@${l}`;
const draftBody = (p) =>
  [
    `<!-- ${MARKER} material of=#${p.number} -->`,
    '> 先頭の行(HTML コメント)と題名の「判定資料: #番号」は、機械がこの資料を見つける目印です。消さないでください。',
    `> **草案です。** 起案者が内容を確定したら、題名の先頭の「${DRAFT_PREFIX.trim()}」を外してください。外すまで「公開」に数えません。`,
    `> 対象: #${p.number} / 判定予定日 T: ${p.T} / リスク区分(申請 Issue の記載): ${p.risk}`,
    '> 各項目の中身は起案者が書きます。機械は見出しを置いただけで、記載の内容を埋めていません(標準 3.10.3)。経緯の記述は評価対象にしません。',
    '',
    '## 1. 判定基準の項目ごとの充足状況(充足・未充足・該当なし)',
    '',
    '(起案者が記入する)',
    '',
    '## 2. 未解決の論点と、それぞれの現時点の扱い',
    '',
    '(起案者が記入する)',
    '',
    '## 3. 自動検査が検出した高リスク事項(認証・認可・個人データ・不可逆な変更・基準の不充足)',
    '',
    '(起案者が記入する)',
    '',
    '## 4. リスク区分(R1〜R3)の判定と、その根拠となる事実',
    '',
    '(起案者が記入する)',
    '',
    '## 5. 決定者に求める判断の明示',
    '',
    '(起案者が記入する)',
    '',
  ].join('\n');

/** 判定資料の Issue を探す。本文の印か、題名の `判定資料: #N`(起案者が本文の先頭の印を消しても、もう1件起票しない) */
const materialOf = (materials, n) =>
  (materials ?? []).find((m) => new RegExp(`<!-- ${MARKER} material of=#${n} -->`).test(m.body ?? '') || new RegExp(`判定資料: #${n}(?!\\d)`).test(m.title ?? '')) ?? null;

/** 判定資料が公開されているか。資料の Issue があり題名に草案の印が無いか、申請 Issue の「判定資料の所在」が書かれている */
export function publishedState(p, materials) {
  const m = materialOf(materials, p.number);
  if (norm(p.fields[FIELDS.material])) return { published: true, why: '判定資料の所在が書かれている' };
  if (!m) return { published: false, why: '判定資料の Issue が無い' };
  if (String(m.title ?? '').startsWith(DRAFT_PREFIX.trim())) return { published: false, why: `判定資料 #${m.number} は草案の印が付いたまま` };
  return { published: true, why: `判定資料 #${m.number}` };
}

/** 一覧(0213): 誰がいつ通知を受け、いつ最初に応答したか。通知は印つきの通知コメントの「通知先:」の行から読む */
export function ledgerBody(p, { issue, materials, nowDay, holidaysNote }) {
  const notices = (issue.comments ?? []).filter((c) => isMachine(c) && /<!-- pit-in:pre-review (?:notice|measure)[: ]/.test(c.body ?? ''));
  const noticedAt = new Map();
  for (const c of notices) {
    const line = /^通知先:\s*(.*)$/m.exec(c.body ?? '')?.[1] ?? '';
    for (const l of loginsOf(line)) {
      const k = l.toLowerCase();
      noticedAt.set(k, [...(noticedAt.get(k) ?? []), c.at]);
    }
  }
  const pub = publishedState(p, materials);
  const rows = p.reviewers.map((l) => `| ${l} | ${(noticedAt.get(l.toLowerCase()) ?? []).join('<br>') || '(通知なし)'} | ${p.firstResponse.get(l.toLowerCase()) ?? '(応答なし)'} |`);
  return stamp(
    'ledger',
    [
      `事前レビューの記録(自動。${nowDay} 時点)。誰がいつ通知を受け、いつ最初に応答したかの一覧です。この一覧は個人の評価に使いません(標準 3.10.11)。`,
      '',
      `- 種別: ${p.target === 'gate' ? '工程ゲート(非同期コメント期間のみ)' : 'B-1〜B-4 の上程'} / リスク区分: ${p.risk} / 判定予定日 T: ${p.T}`,
      `- 判定資料の公開: ${p.timeline.publishDay} / 意見の受付の締切: ${p.timeline.deadlineDay} / 応答の確定: ${p.timeline.answerDay}`,
      `- 判定資料の状態: ${pub.published ? '公開' : '未公開'}(${pub.why})`,
      ...(holidaysNote ? [`- 注意: ${holidaysNote}`] : []),
      '',
      '| 指名レビュア | 通知を受けた時刻(UTC) | 最初の応答の時刻(UTC。賛否の欄が書かれた意見) |',
      '| --- | --- | --- |',
      ...rows,
      '',
    ].join('\n'),
  );
}

const SPLIT_PROMPT = '1つの論点につき1つのスレッドを立てます。複数の論点を1つの意見に混ぜているときは、分けてください(論点の数は機械が数えません)。';

/**
 * 事前レビューの起票・通知・一覧・注意を決める(純関数)。
 * issues: { number, state, title, body, labels[], comments:[{id, body, login, userId, bot, at}] }[](ラベル pre-review の Issue)
 * materials: 判定資料の Issue(ラベル pre-review-material)。{ number, title, body, publishedAt? }[]
 * prFiles: 判定資料の所在が指す PR の変更ファイル。{ [PR番号]: string[] | null }(null は読めなかった)。codeownersText: 既定ブランチの CODEOWNERS(無ければ null)
 * prCreated: 判定資料の所在が指す PR の作成の時刻。{ [PR番号]: ISO 時刻 }。repo: owner/name(別のリポジトリの PR の URL を読み分ける)
 * materials の createdAt: 判定資料の Issue の作成の時刻(公開の時刻の判定に使う。無ければ使わない)。issues の createdAt: 上程の作成の時刻
 * ledgerText: 技術負債台帳 docs/debt-ledger.md の本文(無ければ null)
 * 戻り値: { actions, notes }。action は { kind: 'create-issue'|'comment'|'update-comment', ... }
 */
export function planNotify({ issues, materials = [], now, config, d0Text = '', holidays = new Set(), offsetMinutes = DEFAULT_OFFSET_MINUTES, holidaysNote = null, prFiles = {}, prCreated = {}, repo = null, codeownersText = null, ledgerText = null }) {
  const nowDay = dayOf(now, offsetMinutes);
  const notes = [];
  const actions = [];
  if (holidaysNote) notes.push(holidaysNote);
  if (!nowDay) return { actions, notes: [...notes, '現在の時刻を読めない'] };
  const esc = escalationTarget(d0Text, config);
  for (const issue of issues.filter((i) => i.state === 'open')) {
    const p = readProposal(issue, { config, holidays, repo });
    if (!p.target) {
      notes.push(`#${issue.number}: ${p.reason}`);
      continue;
    }
    if (p.aiReviewers.length) notes.push(`#${issue.number}: 指名レビュアの ${p.aiReviewers.map(mention).join('・')} は AI の担い手の名義のため、通知と一覧に数えない(標準 3.10.1)`);
    if (p.problems.length) {
      notes.push(`#${issue.number}: ${p.problems.join('・')}。起票・通知をしない`);
      continue;
    }
    for (const c of p.cautions) notes.push(`#${issue.number}: ${c}`);
    const tl = p.timeline;
    const push = (key, text) => {
      if (!hasKey(issue.comments, key) && !actions.some((a) => a.issue === issue.number && a.key === key)) actions.push({ kind: 'comment', issue: issue.number, key, body: stamp(key, text) });
    };

    // 0210 判定資料の起票(T の5営業日前。R1 は10)。草案の印つき。同じ資料があれば作らない
    if (nowDay >= tl.publishDay && nowDay <= p.T && !materialOf(materials, p.number) && !actions.some((a) => a.kind === 'create-issue' && a.of === p.number)) {
      actions.push({ kind: 'create-issue', of: p.number, key: `material:#${p.number}`, title: `${DRAFT_PREFIX}判定資料: #${p.number}`, body: draftBody(p), labels: [MATERIAL_LABEL] });
    }

    // 0213・0219 締切の通知(2営業日前・前営業日)と、締切後の措置の宛先への通知
    const waiting = p.reviewers.filter((l) => !p.responded.has(l.toLowerCase()));
    const roster = p.reviewers.map((l) => (p.responded.has(l.toLowerCase()) ? `${l}(応答済み)` : mention(l))).join('、');
    const noticeText = (when) =>
      [
        `意見の受付の締切(${tl.deadlineDay})の${when}です。指名レビュア: ${roster}`,
        `通知先: ${waiting.map(mention).join(' ')}`,
        '意見は雛形(`賛否:`・`理由:`・`代替案または充足条件:`)で書いてください。賛否の欄が書かれたコメントを応答として数えます。',
      ].join('\n');
    if (waiting.length) {
      // 鍵に締切の日を含める: T を改めて締切が動いたら、新しい締切で一度ずつ出る(同じ締切では重ねて出さない)
      if (nowDay >= tl.notice2Day && nowDay < tl.notice1Day) push(`notice:n2:${tl.deadlineDay}`, noticeText('2営業日前'));
      if (nowDay >= tl.notice1Day && nowDay <= tl.deadlineDay) {
        const escLine = esc.login ? `\nD-0 節6「ゲート判定・会議体の決定が期限を超過」の判定する者: ${mention(esc.login)}` : '';
        push(`notice:n1:${tl.deadlineDay}`, `${noticeText('前営業日')}${escLine}`);
      }
      if (nowDay > tl.deadlineDay && nowDay <= p.T) {
        const effect =
          p.risk === 'R1'
            ? 'R1 は応答が揃うまで判定へ進めません(標準 3.10.5)。3.9.3 の措置(D-0 表3 に記名した者への通知と、代理の指名)を、宛先の方はお願いします。'
            : `${p.risk} は 3.10.5 により異議なしとして判定へ進めます(R2 は不応答を記録)。必須応答ロール(3.10.9)を含む案件は R1 と同じ扱いで、3.9.3 の措置(D-0 表3 に記名した者への通知と、代理の指名)が要るかを、宛先の方が判断してください。`;
        const escTo = esc.login ? `${mention(esc.login)} ` : '';
        push(
          `measure:${tl.deadlineDay}`,
          `${escTo}意見の受付の締切(${tl.deadlineDay})を過ぎても未応答の指名レビュアがいます: ${waiting.map(mention).join(' ')}\n${effect}指名は人が行います。自動の再割り当てはしません。\n通知先: ${waiting.map(mention).join(' ')}`,
        );
      }
    }
    if (!esc.login && waiting.length) notes.push(`#${issue.number}: D-0 節6 の宛先を解決できない(${esc.why})。記名なしで知らせる`);

    // 0217 必須応答(検出と記載・通知。判定へ進めない強制は作らない)。CODEOWNERS の行の所有者を、判定資料の所在が指す PR の変更ファイルから導く
    if (p.materialPr && nowDay >= tl.publishDay && nowDay <= p.T) {
      const files = prFiles?.[p.materialPr];
      if (!Array.isArray(files)) notes.push(`#${issue.number}: 判定資料の所在が指す PR #${p.materialPr} の変更ファイルを読めない。必須応答を導出しない`);
      else if (codeownersText === null || codeownersText === undefined) notes.push(`#${issue.number}: CODEOWNERS が既定ブランチに無い。必須応答を導出しない`);
      else {
        const own = requiredOwners(codeownersText, files);
        const authorKey = p.author?.toLowerCase();
        const required = own.logins.filter((l) => l.toLowerCase() !== authorKey && !isAiActor(config, { login: l }));
        const nominated = new Set(p.reviewers.map((l) => l.toLowerCase()));
        const missing = required.filter((l) => !nominated.has(l.toLowerCase()));
        if (own.teams.length) notes.push(`#${issue.number}: CODEOWNERS の所有者のうち、チーム(${own.teams.join('・')})は個人に解決できないため必須応答に数えない`);
        if (own.emails.length) notes.push(`#${issue.number}: CODEOWNERS の所有者のうち、電子メール(${own.emails.join('・')})は個人の login に解決できないため必須応答に数えない`);
        if (own.unowned.length) notes.push(`#${issue.number}: PR #${p.materialPr} の変更ファイルのうち、CODEOWNERS のどの行にも当たらないもの: ${own.unowned.slice(0, 3).join('、')}${own.unowned.length > 3 ? ` ほか ${own.unowned.length - 3} 件` : ''}`);
        if (required.length) {
          const sorted = required.map((l) => l.toLowerCase()).sort();
          push(
            `required:${p.materialPr}:${sorted.join(',')}${missing.length ? `:missing=${missing.map((l) => l.toLowerCase()).sort().join(',')}` : ''}`,
            [
              `必須応答(CODEOWNERS から導出。PR #${p.materialPr} の変更ファイル ${files.length} 件に当たる行の所有者): ${required.map(mention).join(' ')}`,
              missing.length ? `指名レビュアに含まれていません: ${missing.map(mention).join(' ')}。指名は人が行います(起案者は、指名レビュアの欄へ加えるかを決めてください)。` : '全員が指名レビュアに含まれています。',
              '記名の応答は、この Issue の意見のコメント(`賛否:` の欄が書かれたもの)だけを数えます。PR 上のレビューは読みません。',
              `通知先: ${missing.map(mention).join(' ')}`.trimEnd(),
              '標準 3.10.9 は、必須応答の者の記名の応答が揃うまで判定へ進めないと定めています。機械はこれを止めません(止める強制の機械化は未決)。進めてよいかは決定者が確かめてください。',
              '判定資料(3.10.3)への転記は起案者が行います。機械の記載はこの Issue のコメントに置き、判定資料の本文は編集しません。この記載は指名レビュアの時点のものです(指名を直したときは、新しい記載が出ます)。',
            ].join('\n'),
          );
        }
        // 締切で記名の応答が無い必須の者を、0219 の宛先へ通知する
        const silent = required.filter((l) => !p.responded.has(l.toLowerCase()));
        if (silent.length && nowDay > tl.deadlineDay) {
          const escTo = esc.login ? `${mention(esc.login)} ` : '';
          push(
            `required-miss:${tl.deadlineDay}`,
            `${escTo}意見の受付の締切(${tl.deadlineDay})を過ぎても、記名の応答が無い必須応答の者がいます: ${silent.map(mention).join(' ')}\n措置(3.9.3。D-0 表3 に記名した者への通知と、代理の指名)が要るかを、宛先の方が判断してください。標準 3.10.9 は記名の応答が揃うまで判定へ進めないと定めていますが、機械はこれを止めません(止める強制の機械化は未決)。進めてよいかは決定者が確かめてください。\n通知先: ${silent.map(mention).join(' ')}`,
          );
        }
      }
    }

    // 0830(共通の部分) 判定資料の公開が期日(T の5営業日前。R1 は10)より遅いものを短縮として検出する。行が無ければ通知、行があれば未決と表示するだけ
    {
      const pub = publishedState(p, materials);
      const mat = materialOf(materials, p.number);
      // 公開の時点を GitHub の上の値から読む: 判定資料の Issue の草案の印を外した時刻(印の履歴が無ければ作成の時刻)。
      // 判定資料の所在だけで公開した上程は、上程の作成の時刻と、所在の PR の作成の時刻の遅い方を下限とする(所在の欄を後から書いた時刻は読めない)
      let publishedDay = null;
      let basis = null;
      let unverified = null;
      if (pub.published) {
        if (mat && !String(mat.title ?? '').startsWith(DRAFT_PREFIX.trim()) && mat.publishedAt) {
          publishedDay = dayOf(mat.publishedAt, offsetMinutes);
          basis = `判定資料 #${mat.number} の公開`;
        } else if (norm(p.fields[FIELDS.material])) {
          const lows = [issue.createdAt, p.materialPr ? prCreated?.[p.materialPr] : null].filter((v) => Number.isFinite(Date.parse(v)));
          if (p.materialPr && lows.length) {
            publishedDay = dayOf(lows.sort().at(-1), offsetMinutes);
            basis = '上程と所在の PR の作成の時刻(所在の欄を書いた時刻の下限)';
            unverified = '所在の欄を書いた時刻は読めない(下限より前に公開されたかを確かめていない)';
          } else unverified = p.materialPr ? '所在の PR の作成の時刻を読めない' : '所在がこのリポジトリの PR を指さない(外部の URL など)ため、公開の時点を読めない';
        } else unverified = '判定資料の Issue の公開の時刻を読めない';
      }
      const late = (!pub.published && nowDay > tl.publishDay && nowDay <= p.T) || (publishedDay !== null && publishedDay > tl.publishDay);
      if (!late && unverified && nowDay >= tl.publishDay) notes.push(`#${issue.number}: 判定資料の公開の時点を確かめていない(${unverified})。公開の遅れ(短縮)を検出していない`);
      if (late) {
        const rows = ledgerText ? fastTrackRowsFor(ledgerText, [p.number, p.materialPr]) : [];
        if (rows.length) notes.push(`#${issue.number}: 事前レビュー期間が短縮になっている(公開が期日 ${tl.publishDay} より遅い)。ファストトラックの行あり(${rows.join('・')})。短縮の経路と下限は未決(EV-0281)。通知しない・合格ともしない`);
        else {
          const to = [p.author, esc.login].filter(Boolean).map(mention).join(' ');
          push(
            `shortened:${tl.publishDay}`,
            `${to} 判定資料の公開が期日(${tl.publishDay}。T の${p.risk === 'R1' ? '10' : '5'}営業日前)より遅れ、事前レビュー期間が短縮になっています(${pub.published ? `公開 ${publishedDay}。根拠: ${basis}` : '未公開'})。\n標準 3.10.2 は、短縮を第7章 7.4 のファストトラックを適用した場合に限ります。技術負債台帳${ledgerText === null || ledgerText === undefined ? '(docs/debt-ledger.md を読めません)' : ''}に、対象を #${p.number}${p.materialPr && p.materialPr !== p.number ? ` か #${p.materialPr}` : ''} とする印「ファストトラック(短縮: <ゲート>)」の行が見つかりません。\n短縮の可否は機械が決めません。判定者へ知らせ、期間どおりに戻すか、7.4 の手続を取るかを人が決めてください。\n通知先: ${to}`,
          );
        }
      }
    }

    // 0215 意見の様式の欄の空(注意の喚起に限る)
    for (const o of p.opinions) {
      const gaps = opinionGaps(o);
      if (gaps.length) push(`opinion:${o.id}`, `${mention(o.login)} さん、意見の欄が空です: ${gaps.join('・')}。埋めてください。${SPLIT_PROMPT}\nこれは注意の喚起です。意見として扱うかは機械が決めません(起案者が応答に理由を添えて記録し、決定者が判定記録で確かめます。標準 3.10.4)。`);
    }

    // 0213 一覧(1件のコメントを更新する。内容が変わらなければ何もしない)
    if (nowDay >= tl.publishDay) {
      const existing = (issue.comments ?? []).find((c) => isMachine(c) && (c.body ?? '').includes(`<!-- ${MARKER} ledger -->`));
      const strip = (b) => String(b ?? '').replace(/（自動。[^）]*時点）|\(自動。[^)]*時点\)/, '');
      const full = ledgerBody(p, { issue, materials, nowDay, holidaysNote });
      if (!existing) actions.push({ kind: 'comment', issue: issue.number, key: 'ledger', body: full });
      else if (strip(existing.body) !== strip(full)) actions.push({ kind: 'update-comment', issue: issue.number, key: 'ledger', commentId: existing.id, body: full });
    }
  }
  return { actions, notes };
}

/** 月次の集計(0216)。月は YYYY-MM。判定予定日 T がその月の事前レビュー Issue を数える。個人別の値は出さない */
export function metricsFor({ issues, month, config, holidays = new Set() }) {
  const rows = [];
  let excludedKinds = 0;
  for (const issue of issues) {
    const p = readProposal(issue, { config, holidays });
    if (!p.target) {
      excludedKinds++;
      continue;
    }
    if (!p.T || !p.T.startsWith(month)) continue;
    rows.push(p);
  }
  const opinions = rows.flatMap((p) => p.opinions.map((o) => ({ ...o, answered: p.answeredIds.has(o.id) })));
  const reviewerSlots = rows.reduce((n, p) => n + p.reviewers.length, 0);
  const respondedSlots = rows.reduce((n, p) => n + p.reviewers.filter((l) => p.responded.has(l.toLowerCase())).length, 0);
  const noOpinion = rows.filter((p) => p.opinions.length === 0).length;
  const unanswered = opinions.filter((o) => !o.answered).length;
  const pct = (a, b) => (b === 0 ? '算定できない(対象なし)' : `${Math.round((a / b) * 1000) / 10}%(${a}/${b})`);
  return {
    month,
    proposals: rows.length,
    noOpinionRatio: pct(noOpinion, rows.length),
    reviewerResponseRatio: pct(respondedSlots, reviewerSlots),
    unansweredOpinionRatio: pct(unanswered, opinions.length),
    excludedKinds,
  };
}

export function metricsBody(m) {
  return stamp(
    `metrics:${m.month}`,
    [
      `事前レビュー期間の形骸化の指標(自動。対象月 ${m.month}。判定予定日 T がその月の上程)。`,
      '',
      '| 指標 | 値 |',
      '| --- | --- |',
      `| 上程の数 | ${m.proposals} |`,
      `| 事前意見が0件の上程の比率 | ${m.noOpinionRatio} |`,
      `| 指名レビュアの応答率(指名の延べ数に対する、賛否の欄が書かれた意見のある者の割合) | ${m.reviewerResponseRatio} |`,
      `| 起案者の応答が付いていない意見の比率(宣言行 \`応答: <意見のコメントの URL>\` が結ぶものを応答とする) | ${m.unansweredOpinionRatio} |`,
      '',
      '- AI の担い手のコメントは、分子にも分母にも数えていません(標準 3.10.1)。',
      '- 個人別の値は出していません。応答率と応答の件数・速さを個人の評価指標にしません(標準 3.10.11)。警戒サインの解釈は人が行います(3.10.8)。',
      '- 集計していない指標: 判定当日に初めて出た論点の比率・資料公開から判定までの日数(Issue のコメントから決められない)。',
      '',
    ].join('\n'),
  );
}

// ---- GitHub からの読み取りと書き込み(差し替えられる) ----

// ページ送りは `gh api --paginate --slurp`(ページごとの配列を平らにする。本文の中の文字列は触らない。review-queue.mjs の json)
const parse = json;
const commentOf = (c) => ({ id: c.id, body: c.body ?? '', login: c.user?.login ?? '', userId: c.user?.id ?? null, bot: c.user?.type === 'Bot', at: c.created_at });

/** ラベルつきの Issue(PR を除く)をコメントつきで読む。gh は差し替えられる */
export function fetchIssues(gh, repo, { label, state = 'all' }) {
  const raw = parse(gh, [`repos/${repo}/issues?state=${state}&labels=${encodeURIComponent(label)}&per_page=100`]).filter((i) => !i.pull_request);
  return raw.map((i) => ({
    number: i.number,
    state: i.state,
    title: i.title,
    body: i.body ?? '',
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    association: i.author_association ?? '',
    createdAt: i.created_at ?? null,
    comments: parse(gh, [`repos/${repo}/issues/${i.number}/comments?per_page=100`]).map(commentOf),
  }));
}

/** 判定資料の所在が指す PR の変更ファイルのパスを読む。読めなければ null。gh は差し替えられる */
export function fetchPrFiles(gh, repo, n) {
  try {
    return parse(gh, [`repos/${repo}/pulls/${n}/files?per_page=100`]).flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])).filter(Boolean);
  } catch {
    return null;
  }
}

/** 判定資料の所在が指す PR の作成の時刻。読めなければ null。gh は差し替えられる */
export function fetchPrCreated(gh, repo, n) {
  try {
    const r = parse(gh, [`repos/${repo}/pulls/${n}`]);
    const at = (Array.isArray(r) ? r[0] : r)?.created_at;
    return Number.isFinite(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}

/** 判定資料の Issue に、草案の印を外した時刻 publishedAt を足す(題名の改めの履歴から。読めなければ足さない)。gh は差し替えられる */
export function withPublishedAt(gh, repo, materials) {
  return materials.map((m) => {
    if (String(m.title ?? '').startsWith(DRAFT_PREFIX.trim())) return m;
    try {
      const at = publishedAtOf(parse(gh, [`repos/${repo}/issues/${m.number}/events?per_page=100`]));
      // 草案の印を外した履歴が無い非草案の資料は、草案を経ずに作られた(作成の時刻が公開の時刻)。履歴を読めなかったときは足さない
      if (at) return { ...m, publishedAt: at };
      return Number.isFinite(Date.parse(m.createdAt)) ? { ...m, publishedAt: m.createdAt } : m;
    } catch {
      return m;
    }
  });
}

export function postComment(gh, repo, n, body) {
  gh(['api', '-X', 'POST', `repos/${repo}/issues/${n}/comments`, '--input', '-'], { input: JSON.stringify({ body }) });
}
export function patchComment(gh, repo, commentId, body) {
  gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${commentId}`, '--input', '-'], { input: JSON.stringify({ body }) });
}
export function createIssue(gh, repo, { title, body, labels }) {
  gh(['api', '-X', 'POST', `repos/${repo}/issues`, '--input', '-'], { input: JSON.stringify({ title, body, labels }) });
}

/** 計画を実行する。dry なら書かずに行を返すだけ。gh は差し替えられる */
export function applyActions(gh, repo, actions, { dry = false } = {}) {
  const lines = [];
  for (const a of actions) {
    lines.push(`${a.kind === 'create-issue' ? `判定資料の起票(#${a.of})` : `Issue #${a.issue}`}: ${a.key}${dry ? '(dry-run)' : ''}`);
    if (dry) continue;
    if (a.kind === 'create-issue') createIssue(gh, repo, a);
    else if (a.kind === 'update-comment') patchComment(gh, repo, a.commentId, a.body);
    else postComment(gh, repo, a.issue, a.body);
  }
  return lines;
}

/** now の暦の月の前の月(YYYY-MM)。now を読めなければ null */
export function previousMonth(now, offset = DEFAULT_OFFSET_MINUTES) {
  const day = dayOf(now, offset);
  if (!day) return null;
  const d = new Date(Date.parse(day));
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function main(argv) {
  const mode = argv.find((a) => a === 'notify' || a === 'metrics') ?? 'notify';
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('GITHUB_REPOSITORY が未設定です');
    process.exit(2);
  }
  const dry = argv.includes('--dry-run');
  const now = opt('--now') ?? new Date().toISOString();
  const offset = opt('--offset-minutes') !== null ? Number(opt('--offset-minutes')) : DEFAULT_OFFSET_MINUTES;
  const config = loadConfig();
  const hol = loadHolidays(ROOT);
  const issues = fetchIssues(ghCli, repo, { label: LABEL, state: mode === 'metrics' ? 'all' : 'open' });
  if (mode === 'metrics') {
    const month = opt('--month') ?? previousMonth(now, offset);
    if (!isMonth(month)) {
      console.error(`--month は YYYY-MM で渡してください: ${month}`);
      process.exit(2);
    }
    const m = metricsFor({ issues, month, config, holidays: hol.days });
    const body = metricsBody(m);
    const target = Number(process.env.PRE_REVIEW_METRICS_ISSUE) > 0 ? Number(process.env.PRE_REVIEW_METRICS_ISSUE) : null;
    console.log(body);
    if (hol.note) console.log(`注意: ${hol.note}`);
    if (!target) {
      console.log('注意: 指標の Issue(PRE_REVIEW_METRICS_ISSUE)が未設定のため、出力だけで書き込まない');
      return;
    }
    const existing = parse(ghCli, [`repos/${repo}/issues/${target}/comments?per_page=100`]).map(commentOf);
    if (hasKey(existing, `metrics:${month}`)) {
      console.log(`${month} の集計は指標の Issue #${target} に既にある。書かない`);
      return;
    }
    console.log(`指標の Issue #${target} へ ${month} の集計${dry ? '(dry-run)' : ''}`);
    if (!dry) postComment(ghCli, repo, target, body);
    return;
  }
  const materials = withPublishedAt(ghCli, repo, fetchIssues(ghCli, repo, { label: MATERIAL_LABEL, state: 'all' }));
  const prFiles = {};
  const prCreated = {};
  for (const i of issues) {
    const rp = readProposal(i, { config, holidays: hol.days, repo });
    // 対象でない上程(外部の者の起票を含む)の PR は読まない
    if (rp.target && rp.materialPr && !(rp.materialPr in prFiles)) {
      prFiles[rp.materialPr] = fetchPrFiles(ghCli, repo, rp.materialPr);
      prCreated[rp.materialPr] = fetchPrCreated(ghCli, repo, rp.materialPr);
    }
  }
  const coPlace = CODEOWNERS_PLACES.find((f) => fs.existsSync(path.join(ROOT, f)));
  const codeownersText = coPlace ? fs.readFileSync(path.join(ROOT, coPlace), 'utf8') : null;
  const ledgerPath = path.join(ROOT, LEDGER_FILE);
  const ledgerText = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : null;
  const d0 = path.join(ROOT, D0_FILE);
  const d0Text = fs.existsSync(d0) ? fs.readFileSync(d0, 'utf8') : '';
  const r = planNotify({ issues, materials, now, config, d0Text, holidays: hol.days, offsetMinutes: offset, holidaysNote: hol.note, prFiles, prCreated, repo, codeownersText, ledgerText });
  if (!issues.length) console.log(`注意: ラベル ${LABEL} の開いている Issue が無い(様式で起票していないか、ラベルが付いていない)`);
  for (const n of r.notes) console.log(`注意: ${n}`);
  for (const l of applyActions(ghCli, repo, r.actions, { dry })) console.log(l);
  console.log(`実行 ${r.actions.length} 件。措置(代理の指名)・判定資料の内容の確定・意見の採否は人が行う。実物の GitHub では確かめていない(束 B21 単位11・12)。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
