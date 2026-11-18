// レビューの滞留の通知(IMPL-0680・0681・0682・0979・0136・0212。束 B18 裁定 §3.7。process-compass #445)。
//
// 機械が決めるのは、日時の比較・件数・有無だけである。コメントと記名(@login)で知らせるだけで、指名の取り消し・再割り当て・自動承認はしない。
// 合否を持たない。必須チェックにしない(ADR-0200 決定4)。
//
//   - 0680 チームだけを指名した PR へ、個人の指名を求める
//   - 0681 応答の期限の超過で、指名した者へ催促。2倍の超過で D-0 節6 の「期限を超過」の判定する者へ通知
//   - 0682 レビュアごとの未応答の指名の数が上限(既定3)を超えたら、PR へ知らせる(指名は外さない)
//   - 0979 判定の期限の超過で、D-0 節6 の同じ行の者へ通知し、代理の判定者の指名を求める
//   - 0136 散文のファイルだけを変える PR を、検出から外さない(外す分岐を持たない。試験で確かめる)
//   - 0212 リスク区分のラベルが無い PR へ、区分の下限から一次判定のラベルを付ける(既にあれば変えない)
//
// PR を持たないゲート(G-1・G-7・G-8・SG)は確かめない。G-6 は全ての PR、G-3 は context/decisions/ だけを変える PR、
// G-2・G-4 は specs/ だけを変える PR を対象にする。G-2 と G-4 は PR から見分けないため、specs/ だけの PR は長い方の期限(G-2 と G-4 の大きい方)で見る。
// 日付・時刻は引数で渡し、時計を読まない。暦の日は business-days.mjs(UTC の暦、明示した差で直す)で求める。
//
// 使い方: node scripts/gate/review-queue.mjs [queue|risk] [--pr N] [--dry-run] [--now ISO] [--offset-minutes 540]
//   環境変数: GITHUB_REPOSITORY, GH_TOKEN, REVIEW_LOAD_LIMIT(既定3)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, findPerson, accountLoginOf, loadConfig } from './config.mjs';
import { riskFloorOf } from './check-pr.mjs';
import { addBusinessDays, dayOf, loadHolidays, DEFAULT_OFFSET_MINUTES } from './business-days.mjs';

const D0_FILE = 'docs/D-0-governance.md';
export const MARKER = 'pit-in:review-queue';

/** 標準の既定(D-0 節5 の表が読めないときに使う。使ったことは出力に書く) */
export const DEFAULT_DEADLINES = {
  'G-6': { responseBd: 1, judgeBd: 2 },
  'G-2': { hours: 48 },
  'G-3': { hours: 48 },
  'G-4': { hours: 24 },
};
export const DEFAULT_LOAD_LIMIT = 3;

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const norm = (s) => String(s ?? '').normalize('NFKC').replace(/[\s*`]/g, '');

/** 見出し(## N. …)の節の中の表の行(見出し行と区切り行を除く)を cells の配列で返す。節が無ければ null */
export function sectionRows(text, n) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s*${n}\\.`).test(l));
  if (start < 0) return null;
  const rows = [];
  let inTable = false;
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    if (/^\s*\|/.test(lines[i])) {
      if (!inTable) {
        inTable = true;
        i++; // 区切り行
        continue;
      }
      rows.push(cellsOf(lines[i]));
    } else if (inTable) break;
  }
  return rows;
}

/** D-0 節5 の期限を読む。読めない値は標準の既定を使い、defaulted にゲートを並べる */
export function parseDeadlines(d0Text) {
  const out = JSON.parse(JSON.stringify(DEFAULT_DEADLINES));
  const defaulted = [];
  const rows = sectionRows(d0Text, 5);
  for (const gate of Object.keys(DEFAULT_DEADLINES)) {
    const row = rows?.find((c) => norm(c[0]).startsWith(gate.replace('-', '-')));
    const v = norm(row?.[1] ?? '');
    let ok = false;
    if (gate === 'G-6') {
      const m = /応答(\d+)営業日\/判定(\d+)営業日/.exec(v);
      if (m && +m[1] > 0 && +m[2] > 0) {
        out[gate] = { responseBd: +m[1], judgeBd: +m[2] };
        ok = true;
      }
    } else {
      const m = /^(\d+)時間/.exec(v);
      if (m && +m[1] > 0) {
        out[gate] = { hours: +m[1] };
        ok = true;
      }
    }
    if (!ok) defaulted.push(gate);
  }
  return { deadlines: out, defaulted };
}

/** 席の名(D-0 の語彙)と構成の席の role の対応 */
export const SEAT_ROLE = {
  価値責任者: 'value-owner',
  技術判断者: 'tech-lead',
  開発者: 'dev-verifier',
  独立レビュア: 'independent-reviewer',
  出荷判定者: 'qa-gatekeeper',
  品質保証: 'qa-gatekeeper',
  事業決裁者: 'biz-approver',
};
const roleOfText = (t) => Object.entries(SEAT_ROLE).find(([k]) => norm(t).includes(k))?.[1] ?? null;

/** 構成の席 → 責任者 → 名簿 → 最初のログイン名。{ login, person, why } */
export function seatLogin(config, role) {
  const seat = (Array.isArray(config?.seats) ? config.seats : []).find((s) => s?.role === role);
  if (!seat?.accountable) return { login: null, person: null, why: `席 ${role} に責任者が記入されていない` };
  const person = findPerson(config ?? {}, seat.accountable);
  if (!person) return { login: null, person: null, why: `席 ${role} の責任者が名簿に無い` };
  const login = (Array.isArray(person.accounts) ? person.accounts : []).map(accountLoginOf).find(Boolean) ?? null;
  return login ? { login, person, why: null } : { login: null, person, why: `席 ${role} の責任者の名簿にログイン名が無い` };
}

/**
 * D-0 節6 の行「ゲート判定・会議体の決定が期限を超過」の判定する者を、席 → 名簿 → login で解く。
 * セルが「節3『体制と運用形態』の決定者」を指すときは、節3 の表の「体制と運用形態」の行の決定の列を読む(空なら既定の事業決裁者)
 */
export function escalationTarget(d0Text, config) {
  const rows = sectionRows(d0Text, 6);
  const row = rows?.find((c) => norm(c[0]).includes('期限を超過') && norm(c[0]).includes('ゲート判定'));
  if (!row) return { login: null, person: null, role: null, why: 'D-0 節6 に「期限を超過」の行が無い' };
  let text = row[1] ?? '';
  if (/節3/.test(norm(text)) || /体制と運用形態/.test(norm(text))) {
    const r3 = sectionRows(d0Text, 3)?.find((c) => norm(c[0]).startsWith('体制と運用形態'));
    text = norm(r3?.[1] ?? '') ? r3[1] : '事業決裁者';
  }
  const role = roleOfText(text);
  if (!role) return { login: null, person: null, role: null, why: `判定する者「${text}」を席へ対応づけられない` };
  return { ...seatLogin(config, role), role };
}

/** PR の変更のファイルから、対象のゲートを決める。G-6 は全ての PR。時間で見るもの(G-3・G-2/G-4)は hoursGate に返す */
export function hoursGateOf(files, deadlines) {
  if (!files.length) return null;
  if (files.every((f) => f.startsWith('context/decisions/'))) return 'G-3';
  if (files.every((f) => f.startsWith('specs/'))) return deadlines['G-2'].hours >= deadlines['G-4'].hours ? 'G-2' : 'G-4';
  return null;
}

const hasMarker = (pr, key) => (pr.comments ?? []).some((c) => typeof c.body === 'string' && c.body.includes(`<!-- ${MARKER} ${key} -->`));
const stamp = (key, text) => `<!-- ${MARKER} ${key} -->\n${text}`;
const mention = (login) => (login ? `@${login}` : null);

/**
 * 滞留の通知を決める(純関数)。
 * pr: { number, draft, createdAt, readyAt, files[], requestedTeams[], requests:[{login, at}], reviews:[{login, state, at}], comments:[{body}] }
 * 戻り値: { actions: [{ pr, key, body }], notes: [] }
 */
export function queueActions({ prs, now, config, d0Text, holidays = new Set(), loadLimit = DEFAULT_LOAD_LIMIT, offsetMinutes = DEFAULT_OFFSET_MINUTES, holidaysNote = null }) {
  const { deadlines, defaulted } = parseDeadlines(d0Text);
  const esc = escalationTarget(d0Text, config);
  const notes = [];
  if (defaulted.length) notes.push(`D-0 節5 の期限が読めないため標準の既定を使った: ${defaulted.join('・')}`);
  if (holidaysNote) notes.push(holidaysNote);
  if (!esc.login) notes.push(`D-0 節6 の宛先を解決できない(${esc.why})。記名なしで知らせる`);
  const nowDay = dayOf(now, offsetMinutes);
  const nowMs = Date.parse(now);
  const actions = [];
  const push = (pr, key, text) => {
    if (!hasMarker(pr, key) && !actions.some((a) => a.pr === pr.number && a.key === key)) actions.push({ pr: pr.number, key, body: stamp(key, text) });
  };
  const open = prs.filter((p) => !p.draft);
  const respondedBy = (pr, login) => (pr.reviews ?? []).some((r) => r.login?.toLowerCase() === login.toLowerCase());
  const escLine = esc.login ? `${mention(esc.login)} ` : '';
  const g6 = deadlines['G-6'];

  // 未応答の指名の数(0682)
  const held = new Map();
  for (const pr of open) {
    for (const rq of pr.requests ?? []) {
      if (respondedBy(pr, rq.login)) continue;
      const k = rq.login.toLowerCase();
      if (!held.has(k)) held.set(k, []);
      held.get(k).push({ pr: pr.number, at: rq.at, login: rq.login });
    }
  }
  for (const [, list] of held) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.pr - b.pr);
    list.slice(loadLimit).forEach((h) => {
      const pr = open.find((p) => p.number === h.pr);
      push(pr, `load:${h.login.toLowerCase()}`, `@${h.login} への未応答の指名が ${list.length} 件あり、同時保有の上限(${loadLimit})を超えています。指名先を確保できないときは、起案者へ差し戻します(/gate の手引き)。指名は外していません。`);
    });
  }

  for (const pr of open) {
    // 0680
    if ((pr.requestedTeams ?? []).length && !(pr.requests ?? []).length) {
      push(pr, 'team-only', `レビューの依頼がチーム(${pr.requestedTeams.join(', ')})だけで、個人の指名がありません。応答の期限を数える宛先が無いため、個人のレビュアを指名してください。`);
    }
    // 0681(G-6。応答)
    for (const rq of pr.requests ?? []) {
      if (respondedBy(pr, rq.login)) continue;
      const startDay = dayOf(rq.at, offsetMinutes);
      if (!startDay || !nowDay) continue;
      const due = addBusinessDays(startDay, g6.responseBd, holidays);
      const due2 = addBusinessDays(startDay, g6.responseBd * 2, holidays);
      if (nowDay > due) push(pr, `nudge:${rq.login.toLowerCase()}:${rq.at}`, `@${rq.login} さん、指名から ${g6.responseBd} 営業日(${due} まで)を過ぎても応答がありません。レビューの応答をお願いします。自動の再割り当ては行いません。`);
      if (nowDay > due2) push(pr, `nudge2:${rq.login.toLowerCase()}:${rq.at}`, `${escLine}@${rq.login} への指名が、応答の期限の2倍(${due2} まで)を過ぎても未応答です。D-0 節6「ゲート判定・会議体の決定が期限を超過」の対応をお願いします。`);
    }
    // 判定の期限(0979)
    const approved = (pr.reviews ?? []).some((r) => r.state === 'APPROVED');
    if (approved) continue;
    const startAt = pr.readyAt ?? pr.createdAt;
    const hg = hoursGateOf(pr.files ?? [], deadlines);
    let overdueText = null;
    if (hg) {
      const due = Date.parse(startAt) + deadlines[hg].hours * 3600000;
      if (Number.isFinite(due) && nowMs > due) overdueText = `${hg} の判定の期限(${deadlines[hg].hours} 時間)`;
    } else {
      const sd = dayOf(startAt, offsetMinutes);
      if (sd && nowDay > addBusinessDays(sd, g6.judgeBd, holidays)) overdueText = `G-6 の判定の期限(${g6.judgeBd} 営業日)`;
    }
    if (overdueText) {
      push(pr, 'judge-overdue', `${escLine}この PR は ${overdueText}を過ぎても判定が付いていません。D-0 節6 の宛先として、代理の判定者の指名をお願いします。期限を超えた者が宛先と同じ人のときは、組織上の任命権者が指名します(D-0 節6 の注記)。指名は人が行います。自動承認はしません。`);
    }
  }
  return { actions, notes };
}

/** 一次判定のリスク区分のラベル(0212)。risk/* が既にあれば何もしない */
export function riskLabelAction({ pr, rules }) {
  if ((pr.labels ?? []).some((l) => /^risk\//.test(l))) return null;
  const kinds = { added: 'add', modified: 'modify', removed: 'delete', renamed: 'rename', copied: 'add', changed: 'modify' };
  const changes = (pr.changes ?? []).map((c) => ({ path: c.path, from: c.from, kind: kinds[c.status] ?? 'modify' }));
  const { floor } = riskFloorOf(rules, changes);
  return { pr: pr.number, label: `risk/${floor}` };
}

// ---- GitHub からの読み取りと書き込み(差し替えられる) ----

export function ghCli(args, { input = null } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', input: input ?? undefined, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}
const json = (gh, args) => {
  const t = gh(['api', '--paginate', ...args]).trim();
  // --paginate は配列を連結して出す(][ で繋がる)。単一のオブジェクトは配列に包む
  return JSON.parse(t.startsWith('[') ? t.replace(/\]\s*\[/g, ',') : `[${t}]`);
};

/** 開いた PR を読み、queueActions の入力へ整える。gh は差し替えられる */
export function fetchSnapshot(gh, repo, { only = null } = {}) {
  const list = only ? [json(gh, [`repos/${repo}/pulls/${only}`])[0]] : json(gh, [`repos/${repo}/pulls?state=open&per_page=100`]);
  return list.map((p) => {
    const n = p.number;
    const events = json(gh, [`repos/${repo}/issues/${n}/events?per_page=100`]);
    const latest = new Map();
    for (const e of events.filter((x) => x.event === 'review_requested' && x.requested_reviewer?.login)) latest.set(e.requested_reviewer.login.toLowerCase(), { login: e.requested_reviewer.login, at: e.created_at });
    const requests = [...latest.values()];
    const stillRequested = new Set((p.requested_reviewers ?? []).map((u) => u.login.toLowerCase()));
    const ready = events.filter((e) => e.event === 'ready_for_review').map((e) => e.created_at).sort().at(-1) ?? null;
    const files = json(gh, [`repos/${repo}/pulls/${n}/files?per_page=100`]);
    const reviews = json(gh, [`repos/${repo}/pulls/${n}/reviews?per_page=100`]);
    const comments = json(gh, [`repos/${repo}/issues/${n}/comments?per_page=100`]);
    return {
      number: n,
      draft: Boolean(p.draft),
      createdAt: p.created_at,
      readyAt: ready,
      files: files.map((f) => f.filename),
      changes: files.map((f) => ({ path: f.filename, from: f.previous_filename ?? null, status: f.status })),
      requestedTeams: (p.requested_teams ?? []).map((t) => t.slug),
      requests: requests.filter((r) => stillRequested.has(r.login.toLowerCase())),
      reviews: reviews.map((r) => ({ login: r.user?.login ?? '', state: r.state, at: r.submitted_at })),
      comments: comments.map((c) => ({ body: c.body })),
      labels: (p.labels ?? []).map((l) => l.name),
    };
  });
}

export function postComment(gh, repo, n, body) {
  gh(['api', '-X', 'POST', `repos/${repo}/issues/${n}/comments`, '--input', '-'], { input: JSON.stringify({ body }) });
}
export function addLabel(gh, repo, n, label) {
  gh(['api', '-X', 'POST', `repos/${repo}/issues/${n}/labels`, '--input', '-'], { input: JSON.stringify({ labels: [label] }) });
}

function main(argv) {
  const mode = argv.find((a) => a === 'queue' || a === 'risk') ?? 'queue';
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
  const only = opt('--pr');
  const prs = fetchSnapshot(ghCli, repo, { only });
  if (mode === 'risk') {
    for (const pr of prs) {
      const a = riskLabelAction({ pr, rules: config.riskFloor?.rules });
      if (!a) continue;
      console.log(`PR #${a.pr}: 一次判定のラベル ${a.label}${dry ? '(dry-run)' : ''}`);
      if (!dry) addLabel(ghCli, repo, a.pr, a.label);
    }
    return;
  }
  const d0 = path.join(ROOT, D0_FILE);
  const d0Text = fs.existsSync(d0) ? fs.readFileSync(d0, 'utf8') : '';
  const hol = loadHolidays(ROOT);
  const limit = Number(process.env.REVIEW_LOAD_LIMIT) > 0 ? Number(process.env.REVIEW_LOAD_LIMIT) : DEFAULT_LOAD_LIMIT;
  const r = queueActions({ prs, now, config, d0Text, holidays: hol.days, loadLimit: limit, offsetMinutes: offset, holidaysNote: hol.note });
  for (const n of r.notes) console.log(`注意: ${n}`);
  for (const a of r.actions) {
    console.log(`PR #${a.pr}: ${a.key}${dry ? '(dry-run)' : ''}`);
    if (!dry) postComment(ghCli, repo, a.pr, a.body);
  }
  console.log(`通知 ${r.actions.length} 件。確かめていない範囲: PR を持たないゲート(G-1・G-7・G-8・SG)。実物の GitHub では確かめていない(束 B18 単位9)。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
