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
//   - 0215 意見のコメントの雛形(賛否:・理由:・代替案または充足条件:)の欄の空を示す。注意の喚起に限る(意見を応答の対象から外さない)
//
// 日付・時刻は引数で渡し、時計を読まない。暦の日は business-days.mjs(UTC の暦、明示した差で直す)で求める。
// GitHub への読み書きは差し替えられる(fetchIssues・postComment など)。通知は冪等である(同じ印のコメントがあれば出さない)。
//
// 使い方: node scripts/gate/pre-review.mjs [notify] [--dry-run] [--now ISO] [--offset-minutes 540]
//   環境変数: GITHUB_REPOSITORY, GH_TOKEN, PRE_REVIEW_METRICS_ISSUE(指標の Issue の番号。月次の集計の宛先)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig, aiAccountCheck, dedicatedSeatOf } from './config.mjs';
import { addBusinessDays, dayOf, isRealDate, loadHolidays, DEFAULT_OFFSET_MINUTES } from './business-days.mjs';
import { escalationTarget, ghCli } from './review-queue.mjs';

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

const loginsOf = (text) => [...String(text ?? '').matchAll(/@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/g)].map((m) => m[1]);
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
const hasKey = (comments, key) => (comments ?? []).some((c) => typeof c.body === 'string' && c.body.includes(`<!-- ${MARKER} ${key} -->`));
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
  const out = { number: issue.number, fields, ...t, risk, T: isRealDate(T) ? T : null, problems: [] };
  if (!t.target) return out;
  if (!risk) out.problems.push('リスク区分を読めない(R1〜R3)');
  if (!out.T) out.problems.push('判定予定日 T を読めない(YYYY-MM-DD)');
  out.author = loginsOf(fields[FIELDS.author])[0] ?? null;
  const named = uniq(loginsOf(fields[FIELDS.reviewers]));
  out.aiReviewers = named.filter((l) => isAiActor(config, { login: l }));
  out.reviewers = named.filter((l) => !out.aiReviewers.includes(l));
  if (!out.reviewers.length) out.problems.push('指名レビュアを読めない(@login)');
  if (out.risk && out.T) out.timeline = timelineOf(out.T, risk, holidays);
  const humans = (issue.comments ?? []).filter((c) => !OWN_MARK.test(c.body ?? '') && !isAiActor(config, c));
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

const materialOf = (materials, n) => (materials ?? []).find((m) => new RegExp(`<!-- ${MARKER} material of=#${n} -->`).test(m.body ?? '')) ?? null;

/** 判定資料が公開されているか。資料の Issue があり題名に草案の印が無いか、申請 Issue の「判定資料の所在」が書かれている */
export function publishedState(p, materials) {
  const m = materialOf(materials, p.number);
  if (norm(p.fields[FIELDS.material])) return { published: true, why: '判定資料の所在が書かれている' };
  if (!m) return { published: false, why: '判定資料の Issue が無い' };
  if (String(m.title ?? '').startsWith(DRAFT_PREFIX.trim())) return { published: false, why: `判定資料 #${m.number} は草案の印が付いたまま` };
  return { published: true, why: `判定資料 #${m.number}` };
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
    const tl = p.timeline;
    const push = (key, text) => {
      if (!hasKey(issue.comments, key) && !actions.some((a) => a.issue === issue.number && a.key === key)) actions.push({ kind: 'comment', issue: issue.number, key, body: stamp(key, text) });
    };

    // 0210 判定資料の起票(T の5営業日前。R1 は10)。草案の印つき。同じ資料があれば作らない
    if (nowDay >= tl.publishDay && nowDay <= p.T && !materialOf(materials, p.number) && !actions.some((a) => a.kind === 'create-issue' && a.of === p.number)) {
      actions.push({ kind: 'create-issue', of: p.number, key: `material:#${p.number}`, title: `${DRAFT_PREFIX}判定資料: #${p.number}`, body: draftBody(p), labels: [MATERIAL_LABEL] });
    }

    // 0215 意見の様式の欄の空(注意の喚起に限る)
    for (const o of p.opinions) {
      const gaps = opinionGaps(o);
      if (gaps.length) push(`opinion:${o.id}`, `${mention(o.login)} さん、意見の欄が空です: ${gaps.join('・')}。埋めてください。${SPLIT_PROMPT}\nこれは注意の喚起です。意見として扱うかは機械が決めません(起案者が応答に理由を添えて記録し、決定者が判定記録で確かめます。標準 3.10.4)。`);
    }

  }
  return { actions, notes };
}

// ---- GitHub からの読み取りと書き込み(差し替えられる) ----

const parse = (gh, args) => {
  const t = gh(['api', '--paginate', ...args]).trim();
  return JSON.parse(t.startsWith('[') ? t.replace(/\]\s*\[/g, ',') : `[${t}]`);
};

/** ラベルつきの Issue(PR を除く)をコメントつきで読む。gh は差し替えられる */
export function fetchIssues(gh, repo, { label, state = 'all' }) {
  const raw = parse(gh, [`repos/${repo}/issues?state=${state}&labels=${encodeURIComponent(label)}&per_page=100`]).filter((i) => !i.pull_request);
  return raw.map((i) => ({
    number: i.number,
    state: i.state,
    title: i.title,
    body: i.body ?? '',
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    comments: parse(gh, [`repos/${repo}/issues/${i.number}/comments?per_page=100`]).map((c) => ({ id: c.id, body: c.body ?? '', login: c.user?.login ?? '', userId: c.user?.id ?? null, bot: c.user?.type === 'Bot', at: c.created_at })),
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

function main(argv) {
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
  const issues = fetchIssues(ghCli, repo, { label: LABEL, state: 'open' });
  const materials = fetchIssues(ghCli, repo, { label: MATERIAL_LABEL, state: 'all' });
  const d0 = path.join(ROOT, D0_FILE);
  const d0Text = fs.existsSync(d0) ? fs.readFileSync(d0, 'utf8') : '';
  const r = planNotify({ issues, materials, now, config, d0Text, holidays: hol.days, offsetMinutes: offset, holidaysNote: hol.note });
  for (const n of r.notes) console.log(`注意: ${n}`);
  for (const l of applyActions(ghCli, repo, r.actions, { dry })) console.log(l);
  console.log(`実行 ${r.actions.length} 件。措置(代理の指名)・判定資料の内容の確定・意見の採否は人が行う。実物の GitHub では確かめていない(束 B21 単位11・12)。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
