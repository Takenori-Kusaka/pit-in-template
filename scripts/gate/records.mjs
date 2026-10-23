// 記録用ブランチ(records)の読み取り(process-compass #321 D2〜D6 / #54 段階 2)。next.mjs と aggregate-evidence.mjs が
// 共通に使う。
//
// 記録用ブランチには 2 種類のファイルが置かれる。
//   records/reviews/pr-<番号>.json  承認レビューの写し。record-copy.yml がマージを契機に置く。推定を含まない機械の複製
//   records/gates/<ゲート>-<対象>-<日付>.md  判定記録(様式。templates/04-gate-record.md)。対象が PR でない判定の受け皿
//
// この層が決めること:
//   - 宣言行(レビューの本文の 1 行目 `G-4: 通過` / `G-4: 差し戻し / 基準 2 / 期限 2026-10-30`)の読み方は 1 か所に置く。
//     宣言行の無いレビューは取り込みの事務であり、判定に数えない(`.claude/skills/gate/reference/recording.md`)
//   - 同じゲートに同じ人が複数のレビューを出していれば、提出の最後の 1 件だけを判定として読む(承認者ごとの最後の状態。D8)
//   - 対象の版はレビューの commit_id。写しの head とずれた判定は「確定していない版を取り込んだ」になる(D4)
//   - 様式の帰属の裏づけは、記名者本人の操作(署名コミット、または author が記名者)。名前の一致だけなら自己申告(D6)
//   - 読めない写し(壊れた JSON、名前の形が違うファイル)は黙って落とさず skipped に出す
//
// この層が決めないこと: 判定の成否・欠落の判定・名簿との照合。呼び出し側(next.mjs・aggregate-evidence.mjs)が行う。
// GitHub へ問い合わせない。記録用ブランチが手元に無ければ、fetch を 1 回だけ試す。

import { execFileSync } from 'node:child_process';

/** 記録用ブランチの名前(`.github/workflows/record-copy.yml` の RECORDS_BRANCH、`.github/rulesets/records.json`) */
export const RECORDS_REF = 'records';
/** 写しの置き場。`records/reviews/pr-<番号>.json` */
export const REVIEWS_DIR = 'records/reviews';
/** 様式の置き場。`records/gates/<ゲート>-<対象>-<日付>.md` */
export const GATES_DIR = 'records/gates';

/**
 * 宣言行。本文の 1 行目にだけ現れる。結果は 2 値の語の完全一致(注記を足した値は通さない)。
 * 差し戻しには、満たさない基準の項目番号と再提出の期限を添えられる(標準 第4章「工程ゲートの判定の語彙」)
 */
export const DECLARATION_RE = /^(G-[1-8]|SG): (通過|差し戻し)( \/ 基準 [0-9,、 ]+)?( \/ 期限 \d{4}-\d{2}-\d{2})?$/;

const REVIEW_FILE_RE = /^pr-(\d+)\.json$/;

/**
 * レビューの本文から宣言行を読む。見るのは 1 行目だけ(前後の空白と先頭の引用記号 `>` を除く)。
 * 宣言行で無ければ null。criteria は項目番号の配列(無ければ空)、deadline は YYYY-MM-DD か null
 */
export function parseDeclaration(body) {
  const first = String(body ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s>]+/, '').trim())
    .find((l) => l !== '');
  if (!first) return null;
  const m = first.match(DECLARATION_RE);
  if (!m) return null;
  const criteria = m[3]
    ? m[3]
        .replace(/^ \/ 基準 /, '')
        .split(/[,、 ]+/)
        .filter(Boolean)
        .map(Number)
    : [];
  return { gate: m[1], result: m[2], criteria, deadline: m[4] ? m[4].replace(/^ \/ 期限 /, '') : null };
}

/** git を cwd で呼ぶ。失敗したら null(呼び出し側が「無い」と「読めない」を区別しないで済むよう、例外にしない) */
function gitIn(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** 参照が実在すれば、そのコミットの識別子。無ければ null */
function resolveRef(cwd, fullRef) {
  const out = gitIn(cwd, ['rev-parse', '--verify', '--quiet', `${fullRef}^{commit}`]);
  return out ? out.trim() : null;
}

/** GitHub の noreply アドレス(`<id>+<login>@users.noreply.github.com`、旧形式 `<login>@users.noreply.github.com`)から login を取る */
function loginOfEmail(email) {
  const m = String(email ?? '').match(/^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)@users\.noreply\.github\.com$/i);
  return m ? m[1] : null;
}

/** 様式のファイルを最後に触ったコミット(author と署名の検証結果)。読めなければ null */
function lastCommitOf(cwd, rev, file) {
  const out = gitIn(cwd, ['log', '-1', '--format=%H%x00%an%x00%ae%x00%aI%x00%G?', rev, '--', file]);
  if (!out || !out.trim()) return null;
  const [hash, authorName, authorEmail, date, sig] = out.trim().split('\0');
  // %G?: G=有効な署名 / U=有効だが信頼の無い鍵 / E=検証できない / N=署名なし / B=不正な署名 / X・Y・R=鍵の失効・期限切れ
  const signed = sig === 'G' || sig === 'U' ? true : sig === 'N' ? false : null;
  return { hash, authorName, authorEmail, authorLogin: loginOfEmail(authorEmail), date, signed, signature: sig ?? null };
}

/**
 * 記録用ブランチを読む。手元の `refs/remotes/origin/<ref>` か `refs/heads/<ref>` を使い、無ければ fetch=true のときに
 * `git fetch origin <ref>` を 1 回試す。それでも無ければ available=false と理由を返す(呼び出し側は「写しを読めない」として
 * 出す。黙って通さない)。ファイルはブランチを checkout せず、`git ls-tree` と `git show` で読む
 */
export function readRecordsBranch({ cwd = process.cwd(), ref = RECORDS_REF, fetch = true } = {}) {
  const result = { available: false, reason: null, ref, head: null, reviews: new Map(), gates: [], skipped: [] };
  const candidates = [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`];
  let rev = null;
  let head = null;
  const find = () => {
    for (const c of candidates) {
      const h = resolveRef(cwd, c);
      if (h) {
        rev = c;
        head = h;
        return true;
      }
    }
    return false;
  };
  if (!find() && fetch) {
    // 手元に無いときだけ 1 回取りに行く。失敗(remote が無い、ブランチが無い、オフライン)は理由に書く
    gitIn(cwd, ['fetch', '--quiet', 'origin', `${ref}:refs/remotes/origin/${ref}`]);
    find();
  }
  if (!rev) {
    result.reason = `記録用ブランチ ${ref} が手元に無い(refs/remotes/origin/${ref}・refs/heads/${ref} のいずれも無い${fetch ? '。origin からの fetch も通らなかった' : ''})。承認レビューの写しと様式を読めない`;
    return result;
  }
  result.available = true;
  result.head = head;

  const listed = gitIn(cwd, ['ls-tree', '-r', '--name-only', '-z', rev]);
  const files = (listed ?? '').split('\0').filter(Boolean);
  for (const file of files) {
    if (file.startsWith(`${REVIEWS_DIR}/`)) {
      const base = file.slice(REVIEWS_DIR.length + 1);
      const m = base.match(REVIEW_FILE_RE);
      if (!m) {
        result.skipped.push({ file, reason: `写しの名前の形(pr-<番号>.json)でない` });
        continue;
      }
      const text = gitIn(cwd, ['show', `${rev}:${file}`]);
      if (text === null) {
        result.skipped.push({ file, reason: '読めない(git show が失敗)' });
        continue;
      }
      let copy;
      try {
        copy = JSON.parse(text);
      } catch (e) {
        result.skipped.push({ file, reason: `JSON として読めない: ${e.message}` });
        continue;
      }
      if (!copy || typeof copy !== 'object' || !Array.isArray(copy.reviews)) {
        result.skipped.push({ file, reason: '写しの形でない(reviews の配列が無い)' });
        continue;
      }
      const prNumber = Number(m[1]);
      if (copy.pr !== undefined && Number(copy.pr) !== prNumber) {
        result.skipped.push({ file, reason: `ファイル名の PR 番号 ${prNumber} と写しの pr ${copy.pr} が一致しない` });
        continue;
      }
      result.reviews.set(prNumber, copy);
    } else if (file.startsWith(`${GATES_DIR}/`) && file.endsWith('.md')) {
      const text = gitIn(cwd, ['show', `${rev}:${file}`]);
      if (text === null) {
        result.skipped.push({ file, reason: '読めない(git show が失敗)' });
        continue;
      }
      result.gates.push({ file, text, commit: lastCommitOf(cwd, rev, file) });
    }
  }
  return result;
}

/** 写しの head(record-copy.yml は head_sha_at_merge と書く。将来 head_sha へ改めても読めるよう両方を見る) */
const headOfCopy = (copy) => copy?.head_sha ?? copy?.head_sha_at_merge ?? null;

/**
 * 写しのレビューのうち、宣言行を持つものを判定として取り出す。judgeLogins(Set<string>)を渡せば、その login に限る。
 * 同じ (gate, login) に複数あれば、submitted_at が最後の 1 件だけを残す(同時刻なら配列の後のもの)
 */
export function judgementsFromCopy(copy, { judgeLogins = null } = {}) {
  const prNumber = copy?.pr ?? null;
  const last = new Map();
  for (const r of Array.isArray(copy?.reviews) ? copy.reviews : []) {
    const d = parseDeclaration(r?.body);
    if (!d) continue;
    const login = r?.user?.login ?? null;
    if (judgeLogins && !(login !== null && judgeLogins.has(login))) continue;
    const j = {
      prNumber,
      reviewId: r.id ?? null,
      gate: d.gate,
      result: d.result,
      criteria: d.criteria,
      deadline: d.deadline,
      login,
      userId: r?.user?.id ?? null,
      commitId: r.commit_id ?? null,
      submittedAt: r.submitted_at ?? null,
      state: r.state ?? null,
      body: r.body ?? '',
    };
    const key = `${d.gate}\0${login ?? ''}`;
    const prev = last.get(key);
    if (!prev || Date.parse(j.submittedAt ?? '') >= Date.parse(prev.submittedAt ?? '') || Number.isNaN(Date.parse(prev.submittedAt ?? ''))) {
      last.set(key, j);
    }
  }
  return [...last.values()];
}

/**
 * 判定の対象の版(レビューの commit_id)が、マージ時の head と一致するか。写しに head が無ければ判定できない
 * (match=false, head=null)。一致しない判定は「確定していない版を取り込んだ」として呼び出し側が欠落に数える
 */
export function headMatches(copy, judgement) {
  const head = headOfCopy(copy);
  return { match: head !== null && judgement?.commitId !== null && judgement?.commitId === head, head };
}

const sameText = (a, b) => a != null && b != null && String(a).replace(/\s+/g, '').toLowerCase() === String(b).replace(/\s+/g, '').toLowerCase();

/**
 * 様式の帰属の裏づけ(D6)。記名者本人の操作で置かれたかを、ファイルを最後に触ったコミットから読む。
 *   signed-commit  署名の検証が通り、author が記名者(login・email のどちらかが一致。両方を渡していなければ名前で)
 *   author-login   署名は無いが author の login が記名者(弱い裏づけ)
 *   author-email   署名は無いが author の email が記名者(弱い裏づけ)
 *   author-name    author の名前だけが一致。自己申告(backed=false)
 *   null           一致するものが無い、またはコミットを読めない
 */
export function recordAttribution(gateRecord, { judgeName = null, judgeLogin = null, judgeEmail = null } = {}) {
  const c = gateRecord?.commit;
  if (!c) return { backed: false, how: null, note: '様式を置いたコミットを読めない。帰属を裏づけられない' };
  const loginMatch = judgeLogin != null && c.authorLogin != null && sameText(judgeLogin, c.authorLogin);
  const emailMatch = judgeEmail != null && c.authorEmail != null && sameText(judgeEmail, c.authorEmail);
  const nameMatch = judgeName != null && c.authorName != null && sameText(judgeName, c.authorName);
  const identified = loginMatch || emailMatch || (judgeLogin == null && judgeEmail == null && nameMatch);
  if (c.signed === true && identified) {
    return { backed: true, how: 'signed-commit', note: `署名の検証が通ったコミット ${c.hash.slice(0, 7)} の author が記名者` };
  }
  if (loginMatch) return { backed: true, how: 'author-login', note: `コミット ${c.hash.slice(0, 7)} の author の login が記名者(署名なし。弱い裏づけ)` };
  if (emailMatch) return { backed: true, how: 'author-email', note: `コミット ${c.hash.slice(0, 7)} の author の email が記名者(署名なし。弱い裏づけ)` };
  if (nameMatch) return { backed: false, how: 'author-name', note: `コミット ${c.hash.slice(0, 7)} の author の名前だけが記名者と一致。記名は自己申告` };
  return { backed: false, how: null, note: `コミット ${c.hash.slice(0, 7)} の author(${c.authorName} <${c.authorEmail}>)は記名者と一致しない。記名は自己申告` };
}

/** 様式の冒頭の表の「ゲート」欄の先頭の語(G-1〜G-8・SG)。無ければ null */
export function gateOfRecord(text) {
  const m = String(text ?? '').match(/^\|\s*ゲート\s*\|\s*([^|\n]+?)\s*\|/m);
  if (!m) return null;
  const g = m[1].match(/^(G-[1-8]|SG)\b/);
  return g ? g[1] : m[1].trim();
}

/** 件数の要約(表示用)。byGate は、宣言行を持つ判定と様式のゲート欄を、ゲートごとに数える */
export function summarizeRecords(records) {
  const byGate = {};
  const bump = (g) => {
    const k = g ?? '(ゲート欄なし)';
    byGate[k] = (byGate[k] ?? 0) + 1;
  };
  let judgementCount = 0;
  for (const copy of records?.reviews?.values?.() ?? []) {
    for (const j of judgementsFromCopy(copy)) {
      judgementCount++;
      bump(j.gate);
    }
  }
  for (const g of records?.gates ?? []) bump(gateOfRecord(g.text));
  return { reviewCount: records?.reviews?.size ?? 0, judgementCount, gateCount: records?.gates?.length ?? 0, byGate };
}
