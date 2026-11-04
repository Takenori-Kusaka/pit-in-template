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
// 限界: 名簿の照合はログイン名で行う(people[].accounts。数値の識別子での照合は process-compass #429)。AI の担い手が記名者の
// 認証情報で動く構成では、AI の操作と本人の操作を区別できない(#429)。レビューの本文が提出の後に編集されたかは確かめない(EV-0220)
import { execFileSync } from 'node:child_process';
import { accountKey, aiNameBlocked, findPersonByAccount } from './config.mjs';

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
      isBot,
      state: String(r?.state ?? '').toUpperCase(),
      body: String(r?.body ?? ''),
      submittedAt: r?.submittedAt ?? r?.submitted_at ?? null,
      commitId: r?.commitId ?? r?.commit_id ?? r?.commit?.oid ?? null,
      // 本文を編集した者(GraphQL の editor)。null は編集なし。欄が無ければ undefined(編集の記録を読めない)
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
  const person = findPersonByAccount(config, r.login);
  if (!person || person.appointer === true) return { why: `書き手 @${r.login} が人の名簿(people[].accounts)の人へ対応づかない` };
  if (author && accountKey(author) === accountKey(r.login)) return { why: `書き手 @${r.login} が PR の作成者である(作成者と記名者が同じアカウントでは、本人の操作か AI の操作かを区別できない)` };
  // 書き込みの権限を持つ者は、他人のコメントを編集できる(EV-0220)。書き手以外が編集した本文は、書き手の記録として数えない
  if (r.editedBy === undefined) return { why: `レビュー ${r.id ?? '(id なし)'} の本文の編集の記録(editor)を読めない` };
  if (r.editedBy && accountKey(r.editedBy) !== accountKey(r.login)) return { why: `レビューの本文を書き手以外(@${r.editedBy})が編集した` };
  if (!head) return { why: 'PR の先頭のコミットが分からず、レビューの対象を確かめられない' };
  if (!r.commitId) return { why: 'レビューの対象のコミットが読めない' };
  if (r.commitId !== head) return { why: `レビューの後に PR の先頭が変わった(レビューの対象 ${String(r.commitId).slice(0, 7)}、先頭 ${String(head).slice(0, 7)}。失効)` };
  return { person };
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
    return { backed: true, how: 'review', review: { id: r.id, login: r.login, submittedAt: r.submittedAt, commitId: r.commitId }, why: [] };
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
  const own = new Set((Array.isArray(signer.accounts) ? signer.accounts : []).map((a) => accountKey(a)).filter(Boolean));
  if (!own.size) return { backed: false, why: `記名者 ${signer.name} のアカウントが名簿(people[].accounts)に無い。帰属を確かめられない` };
  // 帰属の確認者を置けない体制(名簿に記名者以外の人がいない)。記名者本人のアカウントの操作は、本人か AI の担い手かを区別
  // できないまま受け付け、記名が自己申告であることを出す(第4章「判定記録を基底ブランチへ入れる操作」。ADR-0106 決定3)
  const alone = !(Array.isArray(config.people) ? config.people : []).some((p) => p && p.id !== signer.id && p.appointer !== true);
  const selfNote = (how) => ({ backed: true, how: 'self-attested', selfAttested: true, note: `${how}。名簿に記名者以外の人がいないため、帰属の確認を経ていない(記名が自己申告)` });
  if (info.number == null) {
    // ホスティングの署名の検証が結び付けるのは committer。author は偽装できるため、committer と author の両方が記名者のものに限る
    const committerOwn = Boolean(info.committerLogin) && own.has(accountKey(info.committerLogin));
    const authorOwn = Boolean(info.authorLogin) && own.has(accountKey(info.authorLogin));
    if (info.verified === true && committerOwn && authorOwn) return { backed: true, how: 'signed-commit', note: `署名を検証したコミットの committer・author @${info.committerLogin}` };
    if (alone && authorOwn) return selfNote(`PR を経ないコミットの author が記名者 @${info.authorLogin}(署名の検証なし)`);
    return { backed: false, why: `${what}は PR を経ずに入り、記名者のアカウントが署名を検証したコミット(committer・author とも記名者)でない` };
  }
  // 承認者は、名簿の人のアカウントで、AI・bot の名義でないものに限る(失効した承認は、呼び出し側が先頭のコミットとの照合で除く)
  const humans = (Array.isArray(info.approvers) ? info.approvers : []).filter((l) => l && !/\[bot\]$/i.test(l) && !aiNameBlocked(config, l) && findPersonByAccount(config, l));
  const approvedBySigner = humans.find((l) => own.has(accountKey(l)));
  if (approvedBySigner) return { backed: true, how: 'approval', note: `PR #${info.number} の記名者本人(@${approvedBySigner})の承認` };
  if (info.author && own.has(accountKey(info.author))) {
    // 記名者の PR へ他の者がコミット(台帳の行)を足し、無関係の人が承認する経路を塞ぐ。PR のコミットの作成者が全員記名者であることを要する
    if (!Array.isArray(info.commitAuthors)) return { backed: false, why: `PR #${info.number} のコミットの作成者を読めない(作成者が記名者でも、記名者以外のコミットが混じっていないかを確かめられない)` };
    const foreign = info.commitAuthors.filter((l) => !l || !own.has(accountKey(l)));
    if (foreign.length) return { backed: false, why: `PR #${info.number} の作成者は記名者本人だが、記名者以外のコミット(${[...new Set(foreign.map((l) => (l ? `@${l}` : '作成者を読めないもの')))].join(', ')})を含む` };
    const other = humans.find((l) => !own.has(accountKey(l)));
    if (other) return { backed: true, how: 'author', note: `PR #${info.number} の作成者が記名者本人(@${info.author})。帰属の確認 @${other}` };
    if (alone) return selfNote(`PR #${info.number} の作成者が記名者本人(@${info.author})`);
    return { backed: false, why: `PR #${info.number} の作成者は記名者本人だが、記名者以外の人の承認(帰属の確認)が無い` };
  }
  return { backed: false, why: `${what}を入れた PR #${info.number} の作成者(@${info.author ?? '?'})・承認者(${humans.map((l) => `@${l}`).join(', ') || 'なし'})に、記名者 ${signer.name} のアカウントが無い` };
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

/** 承認者ごとの最後の状態が APPROVED のログイン */
export function approverLogins(reviews) {
  const last = new Map();
  for (const r of normalizeReviews(reviews) ?? []) {
    if (!r.login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    last.set(r.login, r.state);
  }
  return [...last].filter(([, s]) => s === 'APPROVED').map(([l]) => l);
}

/**
 * ホスティング(GitHub)の記録を gh で引く。repo が無い、gh が使えない場合は prOfCommit が null を返す(呼び出し側は確かめられない
 * 記録として数えない)。fixture: 試験は { prOfCommit } を直接渡す。--pr の JSON の hosting.commits({ <sha>: info })も読む
 */
export function ghHosting(repo, { run = null } = {}) {
  const cache = new Map();
  const call = run ?? ((args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })));
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
          info = {
            number: pr.number,
            author: pr.user?.login ?? null,
            approvers: approverLogins(bound),
            commitAuthors: Array.isArray(commits) ? commits.map((c) => c?.author?.login ?? null) : null,
          };
        } else {
          const c = call(['api', `repos/${repo}/commits/${sha}`]);
          info = { number: null, verified: c?.commit?.verification?.verified === true, authorLogin: c?.author?.login ?? null, committerLogin: c?.committer?.login ?? null };
        }
      } catch {
        info = null;
      }
      cache.set(sha, info);
      return info;
    },
  };
}

/** --pr の JSON の hosting.commits({ <sha>: info })から引く(試験と、ホスティングの記録を書き出して渡す手元の実行) */
export function fixedHosting(commits) {
  const m = commits && typeof commits === 'object' ? commits : {};
  return { prOfCommit: (sha) => (sha && Object.prototype.hasOwnProperty.call(m, sha) ? m[sha] : null) };
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
