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
import { ROOT, loadConfig, aiAccountCheck, dedicatedSeatOf } from './config.mjs';
import { addBusinessDays, dayOf, isRealDate, isBusinessDay, loadHolidays, HOLIDAYS_FILE, DEFAULT_OFFSET_MINUTES } from './business-days.mjs';
import { escalationTarget, ghCli, json, BOT_LOGIN } from './review-queue.mjs';

const D0_FILE = 'docs/D-0-governance.md';
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

/** Issue 1件の事前レビューの状態を読む(純関数) */
export function readProposal(issue, { config, holidays = new Set() }) {
  const fields = parseIssueForm(issue.body);
  const t = targetOf(fields);
  const risk = riskOf(fields);
  const T = norm(fields[FIELDS.due]);
  const out = { number: issue.number, fields, ...t, risk, T: isRealDate(T) ? T : null, problems: [], cautions: [] };
  if (!t.target) return out;
  if (issue.association !== undefined && !TRUSTED_ASSOCIATIONS.includes(issue.association)) {
    return { ...out, target: null, reason: `起票者の関係(${issue.association || '不明'})が OWNER・MEMBER・COLLABORATOR ではないため、対象にしない(外部の者の起票で機械が通知を出さないため)` };
  }
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
 * materials: 判定資料の Issue(ラベル pre-review-material)。{ number, title, body }[]
 * 戻り値: { actions, notes }。action は { kind: 'create-issue'|'comment'|'update-comment', ... }
 */
export function planNotify({ issues, materials = [], now, config, d0Text = '', holidays = new Set(), offsetMinutes = DEFAULT_OFFSET_MINUTES, holidaysNote = null }) {
  const nowDay = dayOf(now, offsetMinutes);
  const notes = [];
  const actions = [];
  if (holidaysNote) notes.push(holidaysNote);
  if (!nowDay) return { actions, notes: [...notes, '現在の時刻を読めない'] };
  const esc = escalationTarget(d0Text, config);
  for (const issue of issues.filter((i) => i.state === 'open')) {
    const p = readProposal(issue, { config, holidays });
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
    comments: parse(gh, [`repos/${repo}/issues/${i.number}/comments?per_page=100`]).map(commentOf),
  }));
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
  const materials = fetchIssues(ghCli, repo, { label: MATERIAL_LABEL, state: 'all' });
  const d0 = path.join(ROOT, D0_FILE);
  const d0Text = fs.existsSync(d0) ? fs.readFileSync(d0, 'utf8') : '';
  const r = planNotify({ issues, materials, now, config, d0Text, holidays: hol.days, offsetMinutes: offset, holidaysNote: hol.note });
  if (!issues.length) console.log(`注意: ラベル ${LABEL} の開いている Issue が無い(様式で起票していないか、ラベルが付いていない)`);
  for (const n of r.notes) console.log(`注意: ${n}`);
  for (const l of applyActions(ghCli, repo, r.actions, { dry })) console.log(l);
  console.log(`実行 ${r.actions.length} 件。措置(代理の指名)・判定資料の内容の確定・意見の採否は人が行う。実物の GitHub では確かめていない(束 B21 単位11・12)。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
