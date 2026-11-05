// 効力を持つ記録(例外承認の台帳の行・停止の申し立ての解除の記録)の帰属(標準 第4章「判定記録を基底ブランチへ入れる操作」、
// フェーズ5「PR 単位の検査」。process-compass #380 / ADR-0106)。
//
// 効力を持つ記録は、効力を持つ前に、記名者本人のアカウントの操作で帰属を裏づける。名前の一致だけを裏づけに数えない。
// 裏づけは2つの経路のどちらか:
//   (A) 対象の PR の上の、記名者本人のレビュー(宣言行つき。状態を問わない)。書き手のアカウントが名簿の人で AI・bot の名義でなく、
//       PR の作成者と異なり、レビューの対象のコミットが PR の先頭と一致するもの。例外承認では、宣言行が台帳の行の識別子を指し、
//       行の承認した者が書き手と同じ人で、書き手が作成を指示した者でないもの
//   (B) 記録の今の中身を基底ブランチへ入れた PR(記録を最後に変えた変更)の作成者、または承認したレビューの書き手のアカウントが、記名者のアカウントであること。
//       記名者が作成者の場合は、記名者以外の人の承認(帰属の確認)を要する。PR を経ずに入った記録は、ホスティングが署名を検証した
//       コミットで、author が記名者のアカウントのものに限る
// 確かめられない記録は数えない。PR の時点の検査(check-pr.mjs)と出荷の証跡の集約(aggregate-evidence.mjs)が同じ関数を使う。
//
// 層1・D-0 の決定の記名・前倒しで要る SG の判定記録(process-compass #428 / IMPL-0415)も、(B) で裏づける:
//   層1   docs/quality-assurance-policy.md を最後に変えた変更の作成者・承認者に、層1 の記名者(冒頭の「記名」の欄)の
//         アカウントがあるか(policyAttribution)。項目4 の各行の受容者は、層1 の記名者の記名で一体として扱い、行ごとの帰属を求めない。
//         確かめられない層1 は、権限者の照合(org-assurance.mjs の checkAuthority)で項目4 を使わず、層1 が無い場合と同じ扱いにする
//   D-0   構成の変化点の記録(changeLog[])のうち、決定者の記名(decidedBy)を要するもの(緩める向き・任免・名簿の変更。
//         decisionNeedsAttribution)。記録を入れた変更の作成者・承認者に、決定者のアカウントがあるか
//   SG    事業ステージを前へ戻す変化点(sgRecord)が指す docs/gates/ の判定記録。記録を最後に変えた変更の作成者・承認者に、
//         記録の判定者のアカウントがあるか
//
// 名簿の照合は数値の識別子で行う(people[].accounts の { login, id }。identifyAccount。process-compass #430 / ADR-0108)。
// ログイン名だけが一致する書き手・作成者・承認者は、記名者のアカウントとして数えない。
// 名義の共有(標準 第3章 3.5.3「人と AI の担い手の名義」。構成の seats[].performerAccount が shared、または担い手を宣言して
// 無記入の席の責任者。process-compass #430 / ADR-0107 / IMPL-0427): 記名者が AI の担い手と名義を共有する場合、記名者本人の
// アカウントの操作(対象の PR の上のレビュー、記録を入れた変更の作成と承認、署名コミット)だけでは帰属に数えない。記名者以外で
// 名義を共有していない人の承認(帰属の確認)を要する。その人が名簿にいない体制では、名義の共有を理由とする自己申告として
// 受け付け、sharedAccount を付けて区別して返す(呼び出し側が保証の開示に出す)。
// 限界: 名義の申告は自己申告であり、申告の無い共有(専用と偽った申告)は検出しない(env-check の照合は実行した環境と時点に限る)。
// レビューの本文が提出の後に編集されたかは確かめない(EV-0220)
import { execFileSync } from 'node:child_process';
import { accountKey, aiNameBlocked, dedicatedSeatOf, hasWriteAssociation, identifyAccount, numericAccountId, parsePagedJson, resolveSigner, sharingOf, sharingText, SIGNED_DIRECTIONS, RULE_APPROVER_SEAT, isFilledValue } from './config.mjs';

/**
 * 記名者が AI の担い手と名義を共有するか。共有するなら { seats, confirmable }、しなければ null。
 * confirmable は、記名者以外で名義を共有していない人(組織上の任命権者を除く)が名簿にいるか(帰属の確認者を置けるか)
 */
export function signerSharing(config, signer) {
  const seats = signer ? sharingOf(config, signer) : null;
  if (!seats) return null;
  const roster = Array.isArray(config?.people) ? config.people : [];
  const confirmable = roster.some((p) => p && p.id !== signer.id && p.appointer !== true && !sharingOf(config, p));
  return { seats, confirmable };
}

/** 名義の共有を理由とする自己申告の注記 */
function sharedSelfText(sh) {
  return `記名者は ${sharingText(sh.seats)}と名義を共有し、記名者以外で名義を共有していない人が名簿にいないため、帰属の確認を経ていない(名義の共有を理由とする自己申告)`;
}

/**
 * 対象の PR の上の帰属の確認(名義を共有する記名者のレビューに添える承認)。書き手ごとの最後の状態が承認で、PR の先頭に対するもの、
 * 書き手が名簿の人(数値の識別子で対応づく)で、AI・bot・専用の名義でなく、記名者でなく、名義を共有せず、PR の作成者でないもの
 */
function attributionConfirmers(config, list, { signer, author = null, head = null }) {
  const last = new Map();
  for (const r of list) {
    if (!r.login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    last.set(r.accountId !== null ? `#${r.accountId}` : `@${accountKey(r.login)}`, r);
  }
  const out = [];
  for (const r of last.values()) {
    if (r.state !== 'APPROVED' || r.isBot || aiNameBlocked(config, r.login)) continue;
    if (hasWriteAssociation({ author_association: r.association }) === false) continue;
    if (!head || r.commitId !== head) continue;
    const ref = { login: r.login, id: r.accountId };
    if (dedicatedSeatOf(config, ref)) continue;
    if (author && sameAccount(author, ref)) continue;
    const who = identified(config, ref, '確認者');
    if (!who.person || who.person.id === signer?.id || sharingOf(config, who.person)) continue;
    out.push({ login: r.login, person: who.person });
  }
  return out;
}

/** { login, id } または login の文字列を、identifyAccount へ渡す形へ直す */
const refOf = (x, id = null) => (x && typeof x === 'object' ? { login: x.login ?? '', id: numericAccountId(x.id ?? null) } : { login: String(x ?? ''), id: numericAccountId(id) });
const loginOfRef = (x) => (x && typeof x === 'object' ? String(x.login ?? '') : String(x ?? ''));

/** 2つのアカウントが同じか。両方に数値の識別子があれば識別子で、そうでなければログイン名で比べる */
function sameAccount(a, b) {
  const ra = refOf(a);
  const rb = refOf(b);
  if (ra.id !== null && rb.id !== null) return ra.id === rb.id;
  return Boolean(accountKey(ra.login)) && accountKey(ra.login) === accountKey(rb.login);
}

/** ホスティングの記録の書き手を名簿の人へ対応づける(数値の識別子で)。{ person, why } */
function identified(config, ref, label) {
  const res = identifyAccount(config, refOf(ref));
  const login = loginOfRef(ref);
  if (res.person && res.person.appointer !== true) return { person: res.person, note: res.problem };
  if (res.person) return { person: null, why: `${label} @${login} が人の名簿(people[].accounts)の人へ対応づかない(任命権者)` };
  return { person: null, why: `${label} @${login} が人の名簿(people[].accounts)の人へ対応づかない${res.problem ? `(${res.problem})` : ''}`, problem: res.problem, how: res.how };
}

/** 例外承認の宣言行(レビューの本文の1行目)。`例外承認: D-012` */
export const EXCEPTION_DECLARATION = /^例外承認\s*[::]\s*([A-Za-z][A-Za-z0-9]*-\d+)\s*$/;
/** 停止の解除の宣言行(レビューの本文の1行目)。`停止の解除: 解除` */
export const STOP_DECLARATION = /^停止の解除\s*[::]\s*解除\s*$/;

const firstLine = (body) =>
  String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((l) => l.normalize('NFKC').trim())
    .find(Boolean) ?? '';

/**
 * レビューを1つの形へ直す。REST(user.login・commit_id・submitted_at)、gh pr view(author.login・commit.oid・submittedAt)、
 * 写しを直したもの(aggregate-evidence.mjs の reviewsOfCopy。author.login・commitId)のいずれも読む
 */
export function normalizeReviews(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.map((r) => {
    const login = r?.author?.login ?? r?.user?.login ?? null;
    const isBot = Boolean(r?.author?.is_bot ?? r?.author?.isBot) || String(r?.user?.type ?? '') === 'Bot' || /\[bot\]$/i.test(String(login ?? ''));
    return {
      id: r?.id ?? null,
      login,
      // 書き手の数値の識別子(REST の user.id、gh api の author.id、写しの user.id)。gh pr view の reviews は持たない(null)
      accountId: numericAccountId(r?.author?.id ?? r?.author?.databaseId ?? r?.user?.id ?? null),
      isBot,
      state: String(r?.state ?? '').toUpperCase(),
      body: String(r?.body ?? ''),
      submittedAt: r?.submittedAt ?? r?.submitted_at ?? null,
      commitId: r?.commitId ?? r?.commit_id ?? r?.commit?.oid ?? null,
      // 本文を編集した者(GraphQL の editor)。null は編集なし。欄が無ければ undefined(編集の記録を読めない)
      association: r?.author_association ?? r?.authorAssociation ?? null,
      editedBy: r && 'editedBy' in r ? r.editedBy : r && 'edited_by' in r ? r.edited_by : r && 'editor' in r ? (r.editor?.login ?? null) : undefined,
    };
  });
}

/** レビューの宣言行。{ kind: 'exception', id } / { kind: 'stop' } / null */
export function declarationOf(body) {
  const l = firstLine(body);
  const ex = l.match(EXCEPTION_DECLARATION);
  if (ex) return { kind: 'exception', id: ex[1].toUpperCase() };
  if (STOP_DECLARATION.test(l)) return { kind: 'stop' };
  return null;
}

/**
 * (A) のレビューの共通の条件。書き手が名簿の人で AI・bot の名義でなく、PR の作成者と異なり、対象のコミットが先頭と一致する。
 * 満たせば { person }、満たさなければ { why }
 */
function reviewerCheck(config, r, { author = null, head = null } = {}) {
  if (r.state === 'DISMISSED') return { why: '取り下げられたレビュー' };
  if (!r.login) return { why: '書き手のアカウントが読めない' };
  if (r.isBot || aiNameBlocked(config, r.login)) return { why: `書き手 @${r.login} が AI・bot の名義` };
  if (hasWriteAssociation({ author_association: r.association }) === false) return { why: `書き手 @${r.login} のリポジトリとの関係が ${r.association}(書き込みの権限を持たない。名簿のログイン名を他人が取得した疑い)` };
  const who = identified(config, { login: r.login, id: r.accountId }, '書き手');
  if (!who.person) return { why: who.why };
  const person = who.person;
  if (author && sameAccount(author, { login: r.login, id: r.accountId })) return { why: `書き手 @${r.login} が PR の作成者である(作成者と記名者が同じアカウントでは、本人の操作か AI の操作かを区別できない)` };
  // 書き込みの権限を持つ者は、他人のコメントを編集できる(EV-0220)。書き手以外が編集した本文は、書き手の記録として数えない
  if (r.editedBy === undefined) return { why: `レビュー ${r.id ?? '(id なし)'} の本文の編集の記録(editor)を読めない` };
  if (r.editedBy && accountKey(r.editedBy) !== accountKey(r.login)) return { why: `レビューの本文を書き手以外(@${r.editedBy})が編集した` };
  if (!head) return { why: 'PR の先頭のコミットが分からず、レビューの対象を確かめられない' };
  if (!r.commitId) return { why: 'レビューの対象のコミットが読めない' };
  if (r.commitId !== head) return { why: `レビューの後に PR の先頭が変わった(レビューの対象 ${String(r.commitId).slice(0, 7)}、先頭 ${String(head).slice(0, 7)}。失効)` };
  return { person, note: who.note ?? null };
}

/**
 * (A) 例外承認のレビュー。台帳の行(row)の承認した者(signer。名簿の人)本人が、宣言行 `例外承認: <行の ID>` のレビューを
 * 対象の PR の上に出しているか。instructorIds は作成を指示した者の名簿の id
 */
export function exceptionReviewBacking(config, row, signer, { reviews = null, author = null, head = null, instructorIds = [] } = {}) {
  const list = normalizeReviews(reviews);
  if (!list) return { backed: false, why: ['対象の PR のレビューを読めない'] };
  const why = [];
  for (const r of list) {
    const d = declarationOf(r.body);
    if (d?.kind !== 'exception' || d.id !== String(row.id ?? '').toUpperCase()) continue;
    const c = reviewerCheck(config, r, { author, head });
    if (c.why) {
      why.push(c.why);
      continue;
    }
    if (!signer || c.person.id !== signer.id) {
      why.push(`書き手 @${r.login} が台帳の行の承認した者でない`);
      continue;
    }
    if (instructorIds.includes(c.person.id)) {
      why.push(`書き手 @${r.login} が作成を指示した者である`);
      continue;
    }
    const review = { id: r.id, login: r.login, submittedAt: r.submittedAt, commitId: r.commitId };
    // 記名者が AI の担い手と名義を共有する場合、本人のレビューだけでは帰属に数えない(IMPL-0427)
    const sh = signerSharing(config, c.person);
    if (sh) {
      const conf = attributionConfirmers(config, list, { signer: c.person, author, head });
      if (conf.length) return { backed: true, how: 'review', review, sharedAccount: true, confirmedBy: conf[0], note: `記名者は ${sharingText(sh.seats)}と名義を共有する。帰属の確認 @${conf[0].login}(${conf[0].person.name})`, why: [] };
      if (!sh.confirmable) return { backed: true, how: 'review', review, selfAttested: true, sharedAccount: true, note: sharedSelfText(sh), why: [] };
      why.push(
        `書き手 @${r.login}(${c.person.name})は ${sharingText(sh.seats)}と名義を共有する。本人のレビューだけでは帰属に数えない。` +
          `記名者以外で名義を共有していない人の承認(帰属の確認)が、対象の PR の先頭に無い`
      );
      continue;
    }
    return { backed: true, how: 'review', review, why: [] };
  }
  return { backed: false, why: why.length ? why : [`宣言行「例外承認: ${row.id}」のレビューが無い`] };
}

/**
 * (A) 停止の解除のレビュー。宣言行 `停止の解除: 解除` のレビューのうち、共通の条件を満たし、ラベルを付けた最後の時刻より後に
 * 提出されたもの。権限者の照合と欄の検査は、呼び出し側が parseStopRelease で行う(本文の表の欄を、様式と同じ読み方で読む)。
 * 返り値の candidates は { review, person } の配列(新しい順)
 */
export function stopReviewCandidates(config, { reviews = null, author = null, head = null, labeledAt = null } = {}) {
  const list = normalizeReviews(reviews);
  if (!list) return { candidates: [], rejected: ['対象の PR のレビューを読めない'] };
  const candidates = [];
  const rejected = [];
  for (const r of list) {
    if (declarationOf(r.body)?.kind !== 'stop') continue;
    const c = reviewerCheck(config, r, { author, head });
    if (c.why) {
      rejected.push(`レビュー ${r.id ?? '(id なし)'}: ${c.why}`);
      continue;
    }
    if (!labeledAt) {
      rejected.push(`レビュー ${r.id ?? '(id なし)'}: ラベルを付けた時刻(ラベルの履歴)を読めず、申し立ての後に出したかを確かめられない`);
      continue;
    }
    if (!(r.submittedAt && String(r.submittedAt) > String(labeledAt))) {
      rejected.push(`レビュー ${r.id ?? '(id なし)'}: ラベルを付けた時刻(${labeledAt})より前に提出された`);
      continue;
    }
    // 解除した者が AI の担い手と名義を共有する場合、本人のレビューだけでは帰属に数えない(IMPL-0427)
    const sh = signerSharing(config, c.person);
    if (sh) {
      const conf = attributionConfirmers(config, list, { signer: c.person, author, head });
      if (conf.length) candidates.push({ review: r, person: c.person, sharedAccount: true, confirmedBy: conf[0], note: `解除した者は ${sharingText(sh.seats)}と名義を共有する。帰属の確認 @${conf[0].login}(${conf[0].person.name})` });
      else if (!sh.confirmable) candidates.push({ review: r, person: c.person, sharedAccount: true, selfAttested: true, note: sharedSelfText(sh) });
      else rejected.push(`レビュー ${r.id ?? '(id なし)'}: 書き手 @${r.login}(${c.person.name})は ${sharingText(sh.seats)}と名義を共有する。本人のレビューだけでは帰属に数えない。記名者以外で名義を共有していない人の承認(帰属の確認)が、対象の PR の先頭に無い`);
      continue;
    }
    candidates.push({ review: r, person: c.person });
  }
  candidates.sort((a, b) => String(b.review.submittedAt ?? '').localeCompare(String(a.review.submittedAt ?? '')));
  return { candidates, rejected };
}

/**
 * 停止の解除のレビューを、様式(テンプレ4 の節「停止の申し立ての解除」)と同じ読み方で読める本文へ直す。
 * 機械が出す欄(ゲート・対象・判定者・判定日時・結果)はレビューの記録から起こし、人が書く欄(申し立てた者・解除の理由・
 * 見解を退けたか・上申先と日付)はレビューの本文の表から読む(書き換えない)
 */
export function stopReleaseTextOfReview(review, person, prNumber) {
  return [
    '| 欄 | 値 |',
    '| --- | --- |',
    '| ゲート | 停止の申し立ての解除 |',
    `| 対象 | PR #${prNumber} |`,
    `| 判定者 | ${person.name} |`,
    `| 判定日時 | ${review.submittedAt ?? ''} |`,
    '| 結果 | 通過 |',
    '',
    String(review.body ?? ''),
  ].join('\n');
}

/**
 * (B) 記録を基底ブランチへ入れた変更の帰属。info は hosting.prOfCommit(sha) の返り値:
 *   { number, author, approvers: [login] }(PR を経た) / { number: null, verified, authorLogin }(PR を経ないコミット) / null(読めない)
 * 記名者(signer。名簿の人)のアカウントが、PR の承認者か、作成者(かつ記名者以外の人の承認あり)か、署名を検証したコミットの author なら裏づける
 */
export function introducedBacking(config, signer, info, { what = '記録' } = {}) {
  if (!signer) return { backed: false, why: '記名者が名簿の人へ対応づかない' };
  if (!info) return { backed: false, why: `${what}を基底ブランチへ入れた変更の記録(作成者・承認者)をホスティングから読めない。帰属を確かめられない` };
  if (!(Array.isArray(signer.accounts) ? signer.accounts : []).some((a) => accountKey(a))) return { backed: false, why: `記名者 ${signer.name} のアカウントが名簿(people[].accounts)に無い。帰属を確かめられない` };
  // 記名者のアカウントかは、数値の識別子で名簿の人へ対応づけて確かめる(process-compass #430)。ログイン名だけの一致は数えず、
  // 数えなかった理由(名簿・記録に数値の識別子が無い、識別子の食い違い)を why に出す
  const unmatched = [];
  const isSigner = (ref) => {
    if (!loginOfRef(ref)) return false;
    const res = identifyAccount(config, refOf(ref));
    if (res.person) return res.person.id === signer.id;
    if (res.candidate?.id === signer.id && res.problem) unmatched.push(`@${loginOfRef(ref)}: ${res.problem}`);
    return false;
  };
  const unmatchedText = () => (unmatched.length ? `。記名者のログイン名に一致したが数えなかったアカウント: ${[...new Set(unmatched)].join(' / ')}` : '');
  // 帰属の確認者を置けない体制(名簿に記名者以外の人がいない)。記名者本人のアカウントの操作は、本人か AI の担い手かを区別
  // できないまま受け付け、記名が自己申告であることを出す(第4章「判定記録を基底ブランチへ入れる操作」。ADR-0106 決定3)
  const alone = !(Array.isArray(config.people) ? config.people : []).some((p) => p && p.id !== signer.id && p.appointer !== true);
  // 記名者が AI の担い手と名義を共有する場合(IMPL-0427)。記名者本人のアカウントの操作だけでは帰属に数えず、記名者以外で
  // 名義を共有していない人の承認(帰属の確認)を要する。その人が名簿にいなければ、名義の共有を理由とする自己申告として受け付ける
  const sh = signerSharing(config, signer);
  const selfNote = (how) =>
    sh
      ? { backed: true, how: 'self-attested', selfAttested: true, sharedAccount: true, note: `${how}。${sharedSelfText(sh)}` }
      : { backed: true, how: 'self-attested', selfAttested: true, note: `${how}。名簿に記名者以外の人がいないため、帰属の確認を経ていない(記名が自己申告)` };
  const sharedWhy = sh ? `。記名者 ${signer.name} は ${sharingText(sh.seats)}と名義を共有する。記名者本人のアカウントの操作だけでは帰属に数えず、記名者以外で名義を共有していない人の承認(帰属の確認)を要する` : '';
  if (info.number == null) {
    // ホスティングの署名の検証が結び付けるのは committer。author は偽装できるため、committer と author の両方が記名者のものに限る
    const committerOwn = Boolean(info.committerLogin) && isSigner({ login: info.committerLogin, id: info.committerId ?? null });
    const authorOwn = Boolean(info.authorLogin) && isSigner({ login: info.authorLogin, id: info.authorId ?? null });
    if (info.verified === true && committerOwn && authorOwn) {
      if (!sh) return { backed: true, how: 'signed-commit', note: `署名を検証したコミットの committer・author @${info.committerLogin}` };
      // 署名の鍵は担い手も使える。PR を経ないコミットには帰属の確認が付かない
      if (!sh.confirmable) return selfNote(`署名を検証したコミットの committer・author @${info.committerLogin}`);
      return { backed: false, why: `${what}は PR を経ずに、記名者の署名を検証したコミットで入った${sharedWhy}。記名者以外で名義を共有していない人が承認する PR で入れる` };
    }
    if ((alone || (sh && !sh.confirmable)) && authorOwn) return selfNote(`PR を経ないコミットの author が記名者 @${info.authorLogin}(署名の検証なし)`);
    return { backed: false, why: `${what}は PR を経ずに入り、記名者のアカウントが署名を検証したコミット(committer・author とも記名者)でない${unmatchedText()}${sharedWhy}` };
  }
  // 承認者は、名簿の人のアカウント(数値の識別子で対応づいたもの)で、AI・bot の名義でないものに限る(失効した承認は、呼び出し側が先頭のコミットとの照合で除く)。
  // 要素は { login, id }。ログイン名の文字列(数値の識別子を持たない)は、名簿の人へ対応づけない
  const humans = (Array.isArray(info.approvers) ? info.approvers : [])
    .map((x) => refOf(x))
    .filter((x) => x.login && !/\[bot\]$/i.test(x.login) && !aiNameBlocked(config, x.login))
    .map((x) => ({ ...x, res: identifyAccount(config, x) }))
    .filter((x) => {
      // 組織上の任命権者は承認者に数えない。ただし記名者本人が任命権者の場合(層1 の記名者、任命権者の記名による任免)は、本人の承認として数える(#428)
      if (x.res.person && (x.res.person.appointer !== true || x.res.person.id === signer.id)) return true;
      if (x.res.candidate?.id === signer.id && x.res.problem) unmatched.push(`@${x.login}: ${x.res.problem}`);
      return false;
    });
  // 帰属の確認に数える承認者。記名者が名義を共有する場合は、名義を共有していない人に限る(専用の名義のアカウントは名簿に無いため数えない)
  const confirmers = humans.filter((x) => x.res.person.id !== signer.id && (!sh || !sharingOf(config, x.res.person)) && !dedicatedSeatOf(config, x));
  const approvedBySigner = humans.find((x) => x.res.person.id === signer.id);
  if (approvedBySigner) {
    if (!sh) return { backed: true, how: 'approval', note: `PR #${info.number} の記名者本人(@${approvedBySigner.login})の承認` };
    if (confirmers.length) return { backed: true, how: 'approval', sharedAccount: true, note: `PR #${info.number} の記名者本人(@${approvedBySigner.login})の承認。記名者は ${sharingText(sh.seats)}と名義を共有する。帰属の確認 @${confirmers[0].login}` };
    if (!sh.confirmable) return selfNote(`PR #${info.number} の記名者本人(@${approvedBySigner.login})の承認`);
    return { backed: false, why: `PR #${info.number} の承認者に記名者本人(@${approvedBySigner.login})がいるが、記名者以外で名義を共有していない人の承認が無い${sharedWhy}` };
  }
  if (info.author && isSigner({ login: loginOfRef(info.author), id: info.author?.id ?? info.authorId ?? null })) {
    const authorLogin = loginOfRef(info.author);
    // 記名者の PR へ他の者がコミット(台帳の行)を足し、無関係の人が承認する経路を塞ぐ。PR のコミットの作成者が全員記名者であることを要する
    if (!Array.isArray(info.commitAuthors)) return { backed: false, why: `PR #${info.number} のコミットの作成者を読めない(作成者が記名者でも、記名者以外のコミットが混じっていないかを確かめられない)` };
    const foreign = info.commitAuthors.filter((l) => !loginOfRef(l) || !isSigner(l));
    if (foreign.length) return { backed: false, why: `PR #${info.number} の作成者は記名者本人だが、記名者以外のコミット(${[...new Set(foreign.map((l) => (loginOfRef(l) ? `@${loginOfRef(l)}` : '作成者を読めないもの')))].join(', ')})を含む${unmatchedText()}` };
    const other = confirmers[0];
    if (other) return { backed: true, how: 'author', ...(sh ? { sharedAccount: true } : {}), note: `PR #${info.number} の作成者が記名者本人(@${authorLogin})。${sh ? `記名者は ${sharingText(sh.seats)}と名義を共有する。` : ''}帰属の確認 @${other.login}` };
    if (alone || (sh && !sh.confirmable)) return selfNote(`PR #${info.number} の作成者が記名者本人(@${authorLogin})`);
    return { backed: false, why: `PR #${info.number} の作成者は記名者本人だが、記名者以外の人${sh ? 'で名義を共有していない人' : ''}の承認(帰属の確認)が無い${sharedWhy}` };
  }
  return {
    backed: false,
    why: `${what}を入れた PR #${info.number} の作成者(@${loginOfRef(info.author) || '?'})・承認者(${humans.map((x) => `@${x.login}`).join(', ') || 'なし'})に、記名者 ${signer.name} のアカウントが無い${unmatchedText()}`,
  };
}

/**
 * 台帳の行を最後に変えたコミット(rev の履歴で、行の ID の行を足した・変えた最新のもの)。行の今の中身を入れた変更の帰属を見るため、
 * 最初に足したコミットではなく最新のものを採る。読めなければ null。正規表現は BRE・ERE のどちらでも同じ意味になる形で書く
 */
export function lastCommitOfRow(git, rev, file, id) {
  const out = git(['log', '--format=%H', `-G^[|][[:space:]]*${String(id).replace(/[^A-Za-z0-9-]/g, '')}[[:space:]]*[|]`, rev, '--', file]);
  return String(out ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
}

/** ファイルを最後に変えたコミット。読めなければ null */
export function lastCommitOfFile(git, rev, file) {
  const out = git(['log', '-1', '--format=%H', rev, '--', file]);
  return String(out ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
}

/**
 * 統制の設定を変える変更の AI維持管理者の承認(標準 第4章 G-5「統制の設定の変更の承認」、第1章 1.4 の効力を持つ記録。
 * process-compass #371 / ADR-0115)。AI維持管理者の席の責任者本人のアカウントによる、PR の先頭のコミットへの承認のレビューで成立する。
 * 本文の記名は数えない。書き手の条件は (A) と同じ(reviewerCheck: 名簿の数値の識別子、AI・bot の名義でない、PR の作成者でない、
 * 書き手以外の編集なし、対象のコミットが先頭と一致)。書き手ごとの最後の状態が承認であるものに限る。
 * 席の責任者が AI の担い手と名義を共有する場合は、本人の承認に加えて帰属の確認を要する(IMPL-0427 と同じ)。
 * 席の責任者が PR の作成者である場合(本人は自分の PR を承認できない)は、席の責任者以外で名義を共有していない名簿の人の承認
 * (帰属の確認)を要する。その人が名簿にいない体制(1名の体制)では、席の責任者本人のアカウントの PR の先頭へのレビュー(意見のレビュー
 * を含む)を数値の識別子で照らして自己申告として受け付け、selfAttested を付けて返す。本文の記名・作成の事実だけでは受け付けない(突合 C-6)
 * (ADR-0106 決定3 と同じ扱い。ADR-0115 / 議長の裁定 AR-3)。PR の時点の判定(check-pr.mjs の 3c)と出荷の証跡の集約が同じ関数を使う。
 * 返り値: { backed, how: 'review' | 'author' | 'self-attested', selfAttested?, sharedAccount?, maintainer, review?, note, why: [] }
 */
export function controlApprovalBacking(config, { reviews = null, author = null, head = null } = {}) {
  const name = (config?.seats ?? []).find((s) => s?.role === RULE_APPROVER_SEAT)?.accountable ?? null;
  if (!isFilledValue(name)) return { backed: false, maintainer: null, why: ['AI維持管理者の席の責任者が構成(seats)に無い。承認する者を確かめられない'] };
  const maintainer = resolveSigner(config, name);
  if (!maintainer) return { backed: false, maintainer: name, why: [`AI維持管理者の席の責任者 ${name} が人の名簿(people)の人へ対応づかない`] };
  if (!(Array.isArray(maintainer.accounts) ? maintainer.accounts : []).some((a) => numericAccountId(a?.id ?? null) !== null)) {
    return { backed: false, maintainer: maintainer.name, why: [`AI維持管理者 ${maintainer.name} のアカウントの数値の識別子が名簿(people[].accounts)に無い。承認のレビューの書き手を照らせない`] };
  }
  const list = normalizeReviews(reviews);
  if (!list) return { backed: false, maintainer: maintainer.name, why: ['対象の PR のレビューを読めない'] };
  const last = new Map();
  for (const r of list) {
    if (!r.login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED'].includes(r.state)) continue;
    // 意見だけのレビュー(COMMENTED)は、書き手の最後の状態を変えない
    if (r.state === 'COMMENTED') continue;
    last.set(r.accountId !== null ? `#${r.accountId}` : `@${accountKey(r.login)}`, r);
  }
  const maintainerLogins = new Set((maintainer.accounts ?? []).map((a) => accountKey(a?.login ?? '')).filter(Boolean));
  const why = [];
  const sh = signerSharing(config, maintainer);
  for (const r of last.values()) {
    if (r.state !== 'APPROVED') {
      if (maintainerLogins.has(accountKey(r.login))) why.push(`AI維持管理者 @${r.login} の最後のレビューが承認でない(${r.state})`);
      continue;
    }
    const c = reviewerCheck(config, r, { author, head });
    if (c.why) {
      if (maintainerLogins.has(accountKey(r.login))) why.push(c.why);
      continue;
    }
    if (c.person.id !== maintainer.id) continue;
    const review = { id: r.id, login: r.login, submittedAt: r.submittedAt, commitId: r.commitId };
    if (sh) {
      const conf = attributionConfirmers(config, list, { signer: maintainer, author, head });
      if (conf.length) return { backed: true, how: 'review', review, sharedAccount: true, maintainer: maintainer.name, note: `AI維持管理者 ${maintainer.name}(@${r.login})の承認のレビュー。名義を共有するため、帰属の確認 @${conf[0].login}(${conf[0].person.name})`, why: [] };
      if (!sh.confirmable) return { backed: true, how: 'review', review, selfAttested: true, sharedAccount: true, maintainer: maintainer.name, note: `AI維持管理者 ${maintainer.name}(@${r.login})の承認のレビュー。${sharedSelfText(sh)}`, why: [] };
      why.push(`AI維持管理者 ${maintainer.name}(@${r.login})は ${sharingText(sh.seats)}と名義を共有する。本人の承認だけでは帰属に数えず、名義を共有していない人の承認(帰属の確認)が PR の先頭に無い`);
      continue;
    }
    return { backed: true, how: 'review', review, maintainer: maintainer.name, note: `AI維持管理者 ${maintainer.name}(@${r.login})の承認のレビュー(PR の先頭 ${String(r.commitId).slice(0, 7)})`, why: [] };
  }
  // 席の責任者が PR の作成者(本人は自分の PR を承認できない)
  const authorPerson = author ? identifyAccount(config, refOf(author)).person : null;
  if (authorPerson && authorPerson.id === maintainer.id) {
    const conf = attributionConfirmers(config, list, { signer: maintainer, author, head });
    if (conf.length) return { backed: true, how: 'author', ...(sh ? { sharedAccount: true } : {}), maintainer: maintainer.name, note: `PR の作成者が AI維持管理者 ${maintainer.name} 本人。帰属の確認 @${conf[0].login}(${conf[0].person.name})の承認`, why: [] };
    const alone = !(Array.isArray(config.people) ? config.people : []).some((p) => p && p.id !== maintainer.id && p.appointer !== true);
    if (alone || (sh && !sh.confirmable)) {
      // 自己申告は、席の責任者本人のアカウントの操作(PR の先頭へのレビュー。本人は承認を出せないため、意見のレビューを含む)を
      // 名簿の数値の識別子で照らして成立させる。本文の記名・作成の事実だけでは数えない(process-compass #371 突合 C-6、実機の確認 F-5)
      const own = list.find((r) => {
        if (!r.login || r.isBot || r.state === 'DISMISSED' || !r.state) return false;
        if (r.commitId !== head || !head) return false;
        if (r.editedBy === undefined || (r.editedBy && accountKey(r.editedBy) !== accountKey(r.login))) return false;
        return identifyAccount(config, refOf({ login: r.login, id: r.accountId })).person?.id === maintainer.id;
      });
      if (!own) {
        why.push(
          `PR の作成者が AI維持管理者 ${maintainer.name} 本人で、名簿に${sh ? '名義を共有していない' : '席の責任者以外の'}人がいない(1名の体制)。自己申告は、本人のアカウントのレビュー(意見のレビューでよい)を PR の先頭${head ? `(${String(head).slice(0, 7)})` : ''}に出して成立させる。本文の記名だけでは数えない`
        );
        return { backed: false, maintainer: maintainer.name, why };
      }
      return {
        backed: true,
        how: 'self-attested',
        selfAttested: true,
        ...(sh ? { sharedAccount: true } : {}),
        maintainer: maintainer.name,
        review: { id: own.id, login: own.login, submittedAt: own.submittedAt, commitId: own.commitId, state: own.state },
        note:
          `PR の作成者が AI維持管理者 ${maintainer.name} 本人で、名簿に${sh ? '名義を共有していない' : '席の責任者以外の'}人がいない。作成者は自分の PR を承認できず、別の者の承認を得られないため、` +
          `本人のアカウントのレビュー(@${own.login}、${own.state})を自己申告として受け付けた${sh ? '。名義を AI の担い手と共有するため、この操作が AI のものでありうる' : ''}`,
        why: [],
      };
    }
    why.push(`PR の作成者が AI維持管理者 ${maintainer.name} 本人であり、本人は自分の PR を承認できない。席の責任者以外${sh ? 'で名義を共有していない' : ''}名簿の人の承認(帰属の確認)が PR の先頭に無い`);
  }
  return { backed: false, maintainer: maintainer.name, why: why.length ? [...new Set(why)] : [`AI維持管理者 ${maintainer.name} 本人の承認のレビューが、PR の先頭${head ? `(${String(head).slice(0, 7)})` : ''}に無い`] };
}

/** 承認者ごとの最後の状態が APPROVED のログイン */
export function approverLogins(reviews) {
  return approverAccounts(reviews).map((a) => a.login);
}

/**
 * 承認者ごとの最後の状態が APPROVED のアカウント([{ login, id }])。書き手は数値の識別子があれば識別子で、
 * 無ければログイン名で区別する(id が読めない承認は id: null。名簿の人へ対応づけない。process-compass #430)
 */
export function approverAccounts(reviews) {
  const last = new Map();
  for (const r of normalizeReviews(reviews) ?? []) {
    if (!r.login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    const k = r.accountId !== null ? `#${r.accountId}` : `@${accountKey(r.login)}`;
    last.set(k, { state: r.state, login: r.login, id: r.accountId });
  }
  return [...last.values()].filter((v) => v.state === 'APPROVED').map(({ login, id }) => ({ login, id }));
}

/**
 * ホスティング(GitHub)の記録を gh で引く。repo が無い、gh が使えない場合は prOfCommit が null を返す(呼び出し側は確かめられない
 * 記録として数えない)。fixture: 試験は { prOfCommit } を直接渡す。--pr の JSON の hosting.commits({ <sha>: info })も読む
 */
export function ghHosting(repo, { run = null } = {}) {
  const cache = new Map();
  // --paginate の頁ごとの配列の連結にも耐える読み方(parsePagedJson。#430 突合 C-3)
  const call = run ?? ((args) => parsePagedJson(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })));
  return {
    prOfCommit(sha) {
      if (!repo || !sha) return null;
      if (cache.has(sha)) return cache.get(sha);
      let info = null;
      try {
        const pulls = call(['api', `repos/${repo}/commits/${sha}/pulls`]);
        // そのコミットを取り込みのコミットとする PR に限る(別のブランチへ取り込んだ PR や、構成要素のコミットの PR を拾わない)
        const pr = (Array.isArray(pulls) ? pulls : []).find((p) => p?.merged_at && p?.merge_commit_sha === sha) ?? null;
        if (pr) {
          const reviews = call(['api', '--paginate', `repos/${repo}/pulls/${pr.number}/reviews`]);
          const commits = call(['api', '--paginate', `repos/${repo}/pulls/${pr.number}/commits`]);
          // 承認は、取り込んだ先頭のコミットに対するものだけを数える(承認の後の push で失効。集約の G-6 の数え方と同じ)
          const head = pr.head?.sha ?? null;
          const bound = (Array.isArray(reviews) ? reviews : []).map((r) => (String(r?.state ?? '').toUpperCase() === 'APPROVED' && (!head || r?.commit_id !== head) ? { ...r, state: 'DISMISSED' } : r));
          // 数値の識別子(REST の user.id・author.id)を捨てない。名簿の照合は識別子で行う(process-compass #430)
          info = {
            number: pr.number,
            author: pr.user?.login ?? null,
            authorId: numericAccountId(pr.user?.id ?? null),
            // PR の head のブランチ名。出荷の PR(ship/*)の機械の複製のコミットを見分ける(process-compass #379)
            headRef: pr.head?.ref ?? null,
            approvers: approverAccounts(bound),
            commitAuthors: Array.isArray(commits) ? commits.map((c) => (c?.author?.login ? { login: c.author.login, id: numericAccountId(c.author.id ?? null) } : null)) : null,
          };
        } else {
          const c = call(['api', `repos/${repo}/commits/${sha}`]);
          info = {
            number: null,
            verified: c?.commit?.verification?.verified === true,
            authorLogin: c?.author?.login ?? null,
            authorId: numericAccountId(c?.author?.id ?? null),
            committerLogin: c?.committer?.login ?? null,
            committerId: numericAccountId(c?.committer?.id ?? null),
          };
        }
      } catch {
        info = null;
      }
      cache.set(sha, info);
      return info;
    },
    /**
     * コミットのホスティングの検証(PR を経たかを問わない)。{ verified, authorLogin, authorId, committerLogin, committerId }。
     * 記録用ブランチへの書き込みの署名の確認と、様式を足したコミットの帰属に使う(process-compass #379)。読めなければ null
     */
    commitOf(sha) {
      if (!repo || !sha) return null;
      const k = `commit:${sha}`;
      if (cache.has(k)) return cache.get(k);
      let out = null;
      try {
        const c = call(['api', `repos/${repo}/commits/${sha}`]);
        out = c && typeof c === 'object' ? { number: null, verified: c?.commit?.verification?.verified === true, authorLogin: c?.author?.login ?? null, authorId: numericAccountId(c?.author?.id ?? null), committerLogin: c?.committer?.login ?? null, committerId: numericAccountId(c?.committer?.id ?? null) } : null;
      } catch {
        out = null;
      }
      cache.set(k, out);
      return out;
    },
    /**
     * PR のレビューの一次記録(REST。数値の id・user.id・commit_id・submitted_at を持つ)と PR の作成者・マージの時刻。
     * 写しとの突合と、委任の判定が数える差し戻しの帰属に使う(process-compass #379)。PR を引けなければ null
     */
    pullOf(number) {
      if (!repo || !number) return null;
      const k = `pullOf:${number}`;
      if (cache.has(k)) return cache.get(k);
      let out = null;
      try {
        const pr = call(['api', `repos/${repo}/pulls/${number}`]);
        const reviews = call(['api', '--paginate', `repos/${repo}/pulls/${number}/reviews`]);
        out = pr && typeof pr === 'object' && pr.number != null ? { number: pr.number, author: { login: pr.user?.login ?? null, id: numericAccountId(pr.user?.id ?? null) }, mergedAt: pr.merged_at ?? null, reviews: Array.isArray(reviews) ? reviews : null } : null;
      } catch {
        out = null;
      }
      cache.set(k, out);
      return out;
    },
    /** PR のコミットの作成者([{ login, id }])。PR の時点の検査が、検査する PR 自身の帰属を確かめるときに使う(#428)。読めなければ null */
    pullCommitAuthors(number) {
      if (!repo || !number) return null;
      const k = `pull:${number}`;
      if (cache.has(k)) return cache.get(k);
      let out = null;
      try {
        const commits = call(['api', '--paginate', `repos/${repo}/pulls/${number}/commits`]);
        out = Array.isArray(commits) ? commits.map((c) => (c?.author?.login ? { login: c.author.login, id: numericAccountId(c.author.id ?? null) } : null)) : null;
      } catch {
        out = null;
      }
      cache.set(k, out);
      return out;
    },
  };
}

/**
 * --pr の JSON の hosting.commits({ <sha>: info })から引く(試験と、ホスティングの記録を書き出して渡す手元の実行)。
 * pulls({ <PR 番号>: { commitAuthors } })は、検査する PR 自身のコミットの作成者(#428)
 */
export function fixedHosting(commits, pulls = null) {
  const m = commits && typeof commits === 'object' ? commits : {};
  const p = pulls && typeof pulls === 'object' ? pulls : {};
  const own = (o, k) => k != null && Object.prototype.hasOwnProperty.call(o, String(k));
  return {
    prOfCommit: (sha) => (sha && own(m, sha) ? m[sha] : null),
    // PR を経ないコミットの情報(number: null)だけを返す。PR を経たコミットの検証は、この fixture では読まない
    commitOf: (sha) => (sha && own(m, sha) && m[sha]?.number == null ? m[sha] : null),
    pullCommitAuthors: (number) => (own(p, number) ? (p[String(number)]?.commitAuthors ?? null) : null),
    // pulls の { author, mergedAt, reviews }(REST の形)。無ければ null(PR を引けない)
    pullOf: (number) => (own(p, number) && p[String(number)]?.reviews !== undefined ? { number: Number(number), author: p[String(number)].author ?? null, mergedAt: p[String(number)].mergedAt ?? null, reviews: p[String(number)].reviews } : null),
  };
}

// ---------------------------------------------------------------- 層1・D-0 の決定の記名・前倒しで要る SG(#428 / IMPL-0415)

/**
 * 検査する PR 自身を、記録を入れる変更として introducedBacking へ渡す形(PR の時点の検査。#428)。
 * 承認は PR の先頭(head)に対するものだけを数える(先頭より前の承認は失効)。レビューを読めなければ null(帰属を確かめられない)
 */
export function pullInfoOf({ number = null, author = null, reviews = null, head = null, commitAuthors = null } = {}) {
  if (!number || !Array.isArray(reviews)) return null;
  const a = refOf(author);
  const bound = normalizeReviews(reviews).map((r) => ({
    author: { login: r.login, id: r.accountId },
    state: r.state === 'APPROVED' && (!head || r.commitId !== head) ? 'DISMISSED' : r.state,
    commit_id: r.commitId,
    body: r.body,
  }));
  return { number, author: a.login || null, authorId: a.id, approvers: approverAccounts(bound), commitAuthors: Array.isArray(commitAuthors) ? commitAuthors : null };
}

/**
 * 層1(docs/quality-assurance-policy.md)の帰属。層1 を最後に変えた変更(rev の履歴)の作成者・承認者に、層1 の記名者
 * (冒頭の「記名」の欄。readPolicy の signer)のアカウントがあるか。項目4 の各行の受容者の記名は、層1 の記名者の記名で一体として扱う
 * (行ごとの帰属を求めない)。層1 が無ければ null。返り値は introducedBacking の返り値に { signer, commit } を足したもの。
 * pull を渡すと、層1 を PR の中で変えた場合に、その PR を記録を入れる変更として照合する
 */
export function policyAttribution(config, policy, { git = null, rev = null, hosting = null, file = 'docs/quality-assurance-policy.md', pull = null } = {}) {
  if (!policy?.present) return null;
  const signer = policy.signer ? resolveSigner(config, policy.signer) : null;
  if (!signer) return { backed: false, why: `層1 の記名者 "${policy.signer ?? '未記入'}" が人の名簿(people[])の人へ対応づかない。記名者のアカウントを確かめられない`, signer: policy.signer ?? null, commit: null };
  const sha = git && rev ? lastCommitOfFile(git, rev, file) : null;
  const info = pull ?? (sha && hosting ? hosting.prOfCommit(sha) : null);
  return { ...introducedBacking(config, signer, info, { what: '層1' }), signer: signer.name, commit: sha };
}

/** 層1 に帰属の照合の結果を付ける。backed が偽なら、権限者の照合(checkAuthority)は項目4 を使わない */
export function withPolicyAttribution(policy, attribution) {
  return policy && attribution ? { ...policy, attribution } : policy;
}

/** 帰属を確かめられない層1 の注記(出力に出す) */
export function policyUnattributedText(attribution) {
  return (
    `帰属を確かめられない層1(${attribution.why})。項目4 の権限者の照合には、層1 が無い場合と同じく事業決裁者の席の責任者を使う。` +
    '層1 は、記名者本人が作成者または承認者となる PR で入れる(記名者が作成者なら、記名者以外の人の承認を経る)'
  );
}

/** 名簿の変更(D-0 表5)を含む変化点の記録か。表記の変更・アカウントと氏名の確認・名簿への追加と削除 */
export function rosterChangeOf(e) {
  return Boolean(e?.rosterEdits?.length || e?.accountConfirmations?.length || e?.nameConfirmations?.length || (Array.isArray(e?.diff) && e.diff.some((d) => /^人の名簿\s*[::]/.test(String(d)))));
}

/**
 * 変化点の記録のうち、決定者の記名(decidedBy)の帰属を要するもの(D-0 の決定の記名。#428)。緩める向き・任免の決定(SIGNED_DIRECTIONS)と、
 * 名簿の変更。記名の無い記録は、帰属の照合の対象にしない(緩める向きの記名の欠落は configIntegrityProblems が出す)
 */
export function decisionNeedsAttribution(e) {
  if (!e || !e.decidedBy) return false;
  return SIGNED_DIRECTIONS.includes(e.direction) || rosterChangeOf(e);
}

/** 保持していた宣言を規則の承認で有効にした変化点の理由の末尾(generate-profile.mjs の reason) */
const HELD_SUFFIX = /[((]\s*[^()()]*の決定を、規則の承認により有効にした\s*[))]\s*$/;

/**
 * 決定者の記名を持つ記録の添字。保持していた委任の宣言を規則の承認で有効にした変化点は、決定者の記名が宣言した時点の変化点にある。
 * 理由の文の一致だけでは宣言の時点の記録を借りない(理由の文は PR の作成者が書ける。#428 突合 H-1)。次のすべてが一致するときに限り、
 * 宣言した時点の変化点の添字を返す。一致しなければ index(有効化の記録そのものを照合する)
 *   - 記録が intentApplied(有効にした宣言の席・決定者・理由・宣言の日)を持ち、全件の決定者が記録の決定者と同じ
 *   - 記録の理由が「<宣言の理由>(<宣言の日> の決定を、規則の承認により有効にした)」の形で、宣言の理由・日と一致する
 *   - 記録を入れる前の構成(prior)の席が、同じ宣言(seats[].intent の decidedBy・reason・at)を保持している
 *   - より前の記録に、決定者・理由・日付(date)が宣言と一致する記録がある(そのうち最新のもの)
 * 規則の拡大(pendingChange)と規則だけの有効化は intentApplied を持たないため、有効化の記録そのものを照合する
 */
export function signatureIndexOf(log, index, { prior = null } = {}) {
  const e = Array.isArray(log) ? log[index] : null;
  if (!e) return null;
  const reason = String(e.reason ?? '');
  if (!HELD_SUFFIX.test(reason)) return index;
  const held = Array.isArray(e.intentApplied) ? e.intentApplied : [];
  if (!held.length || !held.every((x) => x && x.decidedBy === e.decidedBy)) return index;
  const x = held[0];
  if (reason !== `${x.reason}(${x.at} の決定を、規則の承認により有効にした)`) return index;
  const kept = (Array.isArray(prior?.seats) ? prior.seats : []).find((s) => s?.role === x.seat)?.intent ?? null;
  if (!kept || kept.decidedBy !== x.decidedBy || kept.reason !== x.reason || kept.at !== x.at) return index;
  for (let i = index - 1; i >= 0; i--) {
    const d = log[i];
    if (d?.decidedBy === x.decidedBy && String(d.reason ?? '') === x.reason && String(d.date ?? '').slice(0, 10) === x.at) return i;
  }
  return index;
}

/**
 * 名簿の数値の識別子を足すだけの変化点(#430 の移行。#428 突合 H-2)の照合に使う名簿。記録を入れる前の名簿(pre)のうち、変化点が
 * アカウントを書き換えた行(rosterEdits の field: accounts)で、ログイン名の集合が同じで既にある識別子を変えないものだけを、変化点が
 * 書く {login, id}(post の行)へ置き換える。ホスティングの記録(REST の user.login・user.id)が書く値と一致したときだけ、その行の人へ
 * 対応づく(identifyAccount)。書く値がホスティングの実際の値と一致することが裏づけになる。当たらなければ pre をそのまま返す
 */
export function idMigrationRoster(pre, post, e) {
  const rows = new Set((Array.isArray(e?.rosterEdits) ? e.rosterEdits : []).filter((x) => x?.field === 'accounts').map((x) => x.id));
  if (!rows.size || !Array.isArray(pre?.people) || !Array.isArray(post?.people)) return pre;
  const idOf = (a) => (a && typeof a === 'object' ? numericAccountId(a.id ?? null) : null);
  const keys = (list) => list.map((a) => accountKey(a)).sort().join('\n');
  const after = new Map(post.people.map((p) => [p?.id, p]));
  let changed = false;
  const people = pre.people.map((p) => {
    const q = after.get(p?.id);
    if (!p || !q || !rows.has(p.id)) return p;
    const was = Array.isArray(p.accounts) ? p.accounts : [];
    const now = Array.isArray(q.accounts) ? q.accounts : [];
    if (keys(was) !== keys(now)) return p;
    const before = new Map(was.map((a) => [accountKey(a), idOf(a)]));
    if (!now.every((a) => before.get(accountKey(a)) == null || before.get(accountKey(a)) === idOf(a))) return p;
    changed = true;
    return { ...p, accounts: now };
  });
  return changed ? { ...pre, people } : pre;
}

/** ファイルの中の1行(文字列そのもの)を今の形で入れたコミット(git log -S)。D-0 節15 の受容の行の帰属に使う。読めなければ null */
export function lastCommitOfLine(git, rev, file, line) {
  if (!line) return null;
  const out = git(['log', '-1', '--format=%H', `-S${line}`, rev, '--', file]);
  return String(out ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
}

/**
 * 変化点の記録 changeLog[index] の今の中身を入れたコミット(rev の履歴で、その記録を今と同じ中身で持つ最も古いコミット)。
 * 記録は追記だけで書き換えないため、記録を足したコミットに当たる。読めなければ null
 */
export function commitOfChangeLogEntry(git, rev, index, { file = 'process.config.json', cache = null } = {}) {
  const shas = String(git(['log', '--format=%H', rev, '--', file]) ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const logAt = (sha) => {
    if (cache?.has(sha)) return cache.get(sha);
    let log = null;
    try {
      log = JSON.parse(git(['show', `${sha}:${file}`]) ?? 'null')?.changeLog ?? null;
    } catch {
      log = null;
    }
    cache?.set(sha, log);
    return log;
  };
  let target = null;
  let found = null;
  for (const sha of shas) {
    const log = logAt(sha);
    const e = Array.isArray(log) && index < log.length ? JSON.stringify(log[index]) : null;
    if (target === null) {
      if (e === null) return null;
      target = e;
      found = sha;
      continue;
    }
    if (e !== target) break;
    found = sha;
  }
  return found;
}

/** 変化点の sgRecord を、リポジトリの根からの相対の所在(docs/gates/…)へ直す。docs/gates/ の外を指せば null */
export function sgRecordPath(e) {
  const given = String(e?.sgRecord ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!given) return null;
  // 絶対の所在で書いた記録(/process-change は ROOT からの解決で受け付ける)は、docs/gates/ からの部分を読む
  const at = given.lastIndexOf('/docs/gates/');
  const raw = given.startsWith('docs/gates/') || at < 0 ? given : given.slice(at + 1);
  const parts = raw.split('/');
  if (parts.includes('..') || !raw.startsWith('docs/gates/') || !/\.md$/i.test(raw)) return null;
  return raw;
}

/**
 * 既定ブランチのルールセット(.github/rulesets/*.json)の、効力を持つ記録の統制を外す形(IMPL-0416)。
 * bypass actor を置かない(アクター単位で効き、パスを見ないため、効力を持つ記録の承認と帰属の確認も外れる)。
 * PR を課すルールセットで、承認の件数を 0 にしない(パス条件で足し戻す構成を既定にしない)。既定ブランチを対象としない
 * ルールセット(記録用ブランチ records など)は見ない
 */
export function defaultBranchRulesetProblems(ruleset) {
  const include = ruleset?.conditions?.ref_name?.include ?? [];
  if (!include.includes('~DEFAULT_BRANCH')) return [];
  const problems = [];
  if (Array.isArray(ruleset.bypass_actors) && ruleset.bypass_actors.length) problems.push(`${ruleset.name ?? '(名前なし)'}: bypass actor が ${ruleset.bypass_actors.length} 件ある`);
  for (const r of Array.isArray(ruleset.rules) ? ruleset.rules : []) {
    if (r?.type === 'pull_request' && r.parameters?.required_approving_review_count === 0) problems.push(`${ruleset.name ?? '(名前なし)'}: PR を課しながら承認の件数が 0`);
  }
  return problems;
}
