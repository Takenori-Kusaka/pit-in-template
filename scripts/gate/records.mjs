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
//   - 様式の帰属の裏づけは、ホスティングの記録で確かめた記名者本人のアカウントの操作に限る(呼び出し側が gh で確かめる)。
//     この層は、記録用ブランチで様式を足したコミット(addedCommitOf)を返すだけで、手元の署名の検証(%G?)と、署名の無い
//     author の名前・email の一致を裏づけに数えない(process-compass #379 / ADR-0109 決定3)
//   - 記録用ブランチの履歴を走査し、成立した記録の変更・削除・名前の変更を列挙する(scanRecordsHistory・classifyRecordsHistory。
//     process-compass #379 / ADR-0109 決定1)。記録用ブランチの規則(non_fast_forward・deletion)が止めるのは履歴の書き換えと削除だけで、
//     書き込みの権限を持つ者とジョブのトークンは新しいコミットで既存の記録を変えられる。変えた事実は履歴に残る
//   - 読めない写し(壊れた JSON、名前の形が違うファイル)は黙って落とさず skipped に出す
//
// この層が決めないこと: 判定の成否・欠落の判定・名簿との照合。呼び出し側(next.mjs・aggregate-evidence.mjs)が行う。
// GitHub へ問い合わせない。記録用ブランチが手元に無ければ、fetch を 1 回だけ試す。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 記録用ブランチの名前(`.github/workflows/record-copy.yml` の RECORDS_BRANCH、`.github/rulesets/records.json`) */
export const RECORDS_REF = 'records';
/** 写しの置き場。`records/reviews/pr-<番号>.json` */
export const REVIEWS_DIR = 'records/reviews';
/** 様式の置き場。`records/gates/<ゲート>-<対象>-<日付>.md` */
export const GATES_DIR = 'records/gates';
/**
 * 写しの取り出しの衝突の記録の置き場。`records/conflicts/pr-<番号>-<実行の識別子>.json`。record-copy.yml が、既にある写しと
 * 不変の欄が食い違う写しを取り出したときに追記する(既にある写しは書き換えない。process-compass #379 / ADR-0109 決定4)
 */
export const CONFLICTS_DIR = 'records/conflicts';
/** 記録の置き場の全体(履歴の走査の対象) */
export const RECORDS_ROOT = 'records';

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

/**
 * ファイルを最後に触ったコミット(author と、手元の署名の検証結果)。rev は読む版(記録用ブランチの参照、基底なら 'HEAD')。
 * 読めなければ null。signed は手元の鍵束による検証(%G?)であり、帰属の裏づけに使わない(判定される側が鍵束を用意できる。
 * 帰属はホスティングの検証で確かめる。process-compass #379 / ADR-0109 決定3)。表示と試験のために返す
 */
export function lastCommitOf(cwd, rev, file) {
  const out = gitIn(cwd, ['log', '-1', '--format=%H%x00%an%x00%ae%x00%aI%x00%G?', rev, '--', file]);
  if (!out || !out.trim()) return null;
  const [hash, authorName, authorEmail, date, sig] = out.trim().split('\0');
  // %G?: G=有効な署名 / U=有効だが信頼の無い鍵 / E=検証できない / N=署名なし / B=不正な署名 / X・Y・R=鍵の失効・期限切れ
  const signed = sig === 'G' || sig === 'U' ? true : sig === 'N' ? false : null;
  return { hash, authorName, authorEmail, authorLogin: loginOfEmail(authorEmail), date, signed, signature: sig ?? null };
}

/**
 * ファイルを足したコミット(rev の履歴で、そのパスを最後に足したもの)。様式の帰属は、置き場で様式を足したコミットで照らす
 * (足した後の変更は、履歴の走査が成立した記録の書き換えとして出す)。読めなければ null
 */
export function addedCommitOf(cwd, rev, file) {
  const out = gitIn(cwd, ['log', '-1', '--diff-filter=A', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%cI', rev, '--', file]);
  if (!out || !out.trim()) return null;
  const [hash, authorName, authorEmail, committerName, committerEmail, committedAt] = out.trim().split('\0');
  return { hash, authorName, authorEmail, authorLogin: loginOfEmail(authorEmail), committerName, committerEmail, committedAt };
}

/**
 * 記録用ブランチの履歴を読む(process-compass #379 / ADR-0109 決定1)。from(前回の出荷で残した先頭)を渡すと from..rev、
 * 渡さなければ rev の最初のコミットから読む。浅い取得(shallow)では履歴の全体を読めないため available=false。
 * 返り値の commits は古い順で、changes は records/ の下の変更([{ status, path, from? }]。status は git の
 * name-status の 1 文字目。A・M・D・R・C・T)。マージコミットは第1の親との差分で読む(--diff-merges=first-parent)。
 * マージの解決で既存の記録を変えたコミットも、変更として出す。--full-history で、パスの簡略化による枝の省略をしない
 */
export function scanRecordsHistory(cwd, { rev, from = null } = {}) {
  if (!rev) return { available: false, reason: '記録用ブランチの先頭が無い', commits: [] };
  const shallow = gitIn(cwd, ['rev-parse', '--is-shallow-repository']);
  if (shallow !== null && shallow.trim() === 'true') return { available: false, reason: '浅い取得(shallow)で、記録用ブランチの履歴の全体を読めない', commits: [] };
  const range = from ? `${from}..${rev}` : rev;
  const out = gitIn(cwd, ['log', '--reverse', '--full-history', '--diff-merges=first-parent', '-M', '--name-status', '--format=%x1e%H%x09%cI%x09%an%x09%ae%x09%cn%x09%ce', range, '--', `${RECORDS_ROOT}/`]);
  if (out === null) return { available: false, reason: `記録用ブランチの履歴(${range})を読めない(git log が失敗)`, commits: [] };
  const commits = [];
  for (const block of out.split('\x1e').filter((b) => b.trim())) {
    const [head, ...rest] = block.split('\n');
    const [hash, committedAt, authorName, authorEmail, committerName, committerEmail] = head.split('\t');
    const changes = [];
    for (const line of rest) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = parts[0].charAt(0);
      if (status === 'R' || status === 'C') changes.push({ status, from: parts[1], path: parts[2] });
      else changes.push({ status, path: parts[1] });
    }
    commits.push({ hash, committedAt, authorName, authorEmail, authorLogin: loginOfEmail(authorEmail), committerName, committerEmail, changes });
  }
  return { available: true, reason: null, range, commits };
}

/**
 * 履歴の走査の結果を、成立した記録の書き換えとマージより前に置かれた写しへ分ける(純粋な関数。試験が直接呼ぶ)。
 *   rewrites   追加以外の変更(変更・削除・名前の変更・複製・種別の変更)。訂正は元の記録を指す記録を足す形に限るため、
 *              既存のファイルを変えたコミットはすべて書き換えに数える
 *   premature  写し(records/reviews/pr-N.json)を、その PR のマージより前の時刻に足したコミット。mergedAtOf(N) は
 *              ホスティングの記録のマージの時刻(読めなければ null。null の写しは比べない)
 *   additions  追加の件数
 * 時刻はコミットの committer の時刻であり、書き手が設定できる(早く気づく手段。主の防御はホスティングとの突合)
 */
export function classifyRecordsHistory(scan, { mergedAtOf = () => null } = {}) {
  const rewrites = [];
  const premature = [];
  // 走査の範囲で足された写しの取り出しの衝突の記録(records/conflicts/)。前回の出荷の先頭より後に限って数える
  const conflicts = [];
  let additions = 0;
  const seen = new Set();
  for (const c of scan?.commits ?? []) {
    for (const ch of c.changes ?? []) {
      if (ch.status !== 'A') {
        rewrites.push({ hash: c.hash, status: ch.status, path: ch.path, from: ch.from ?? null, committedAt: c.committedAt, author: c.authorName });
        continue;
      }
      // マージコミットは、取り込んだ枝で足したファイルを第1の親との差分で再び「追加」と出す。同じパスの追加は1件に数える
      if (seen.has(ch.path)) continue;
      seen.add(ch.path);
      additions++;
      if (String(ch.path).startsWith(`${CONFLICTS_DIR}/`)) {
        const m = String(ch.path).slice(CONFLICTS_DIR.length + 1).match(/^pr-(\d+)-/);
        conflicts.push({ hash: c.hash, path: ch.path, pr: m ? Number(m[1]) : null, committedAt: c.committedAt });
        continue;
      }
      const m = String(ch.path).match(/^records\/reviews\/pr-(\d+)\.json$/);
      if (!m) continue;
      const mergedAt = mergedAtOf(Number(m[1]));
      const t = Date.parse(c.committedAt ?? '');
      const mt = Date.parse(mergedAt ?? '');
      if (Number.isFinite(t) && Number.isFinite(mt) && t < mt) premature.push({ hash: c.hash, path: ch.path, pr: Number(m[1]), committedAt: c.committedAt, mergedAt });
    }
  }
  return { rewrites, premature, conflicts, additions };
}

/**
 * 記録用ブランチのルールセット(.github/rulesets/records.json・records-signed.json)が、置き場の要求を満たす形かを確かめる
 * (標準 第4章「判定記録を基底ブランチへ入れる操作」。process-compass #379 / IMPL-0353)。履歴の書き換え(non_fast_forward)と
 * 置き場そのものの削除(deletion)を止め、bypass actor を置かないこと。書き込める主体を限ることは求めない。問題の文の配列を返す
 */
export function recordsRulesetProblems(ruleset, { signed = false } = {}) {
  const name = ruleset?.name ?? '(名前なし)';
  const include = ruleset?.conditions?.ref_name?.include ?? [];
  const problems = [];
  if (!include.includes(`refs/heads/${RECORDS_REF}`)) problems.push(`${name}: 対象が記録用ブランチ refs/heads/${RECORDS_REF} でない`);
  const types = new Set((Array.isArray(ruleset?.rules) ? ruleset.rules : []).map((r) => r?.type));
  if (!types.has('non_fast_forward')) problems.push(`${name}: 履歴の書き換え(non_fast_forward)を止めていない`);
  if (!types.has('deletion')) problems.push(`${name}: 置き場の削除(deletion)を止めていない`);
  if (signed && !types.has('required_signatures')) problems.push(`${name}: 署名を要する構成で、書き込みの署名(required_signatures)を課していない`);
  if (Array.isArray(ruleset?.bypass_actors) && ruleset.bypass_actors.length) problems.push(`${name}: bypass actor が ${ruleset.bypass_actors.length} 件ある`);
  if (ruleset?.enforcement !== undefined && ruleset.enforcement !== 'active') problems.push(`${name}: enforcement が ${ruleset.enforcement}(active でない)`);
  return problems;
}

/**
 * 記録用ブランチへの書き込みごとに署名を要する構成か(規制業(第8章 軸C)と安全重要度 CL2 以上(軸E)。標準 第4章
 * 「判定記録を基底ブランチへ入れる操作」)。構成の回答 q-quality・q-criticality だけから導く(リポジトリの変数に頼らない)。
 * 集約の欠落・保証の開示の文・record-copy.yml・ship-evidence.yml が同じ判定を使う(process-compass #379 突合 M-7)。
 * ワークフローからは `node scripts/gate/records.mjs --signature-required` で呼ぶ(true / false を出す)
 */
export function recordsSignatureRequired(config) {
  return config?.answers?.['q-quality'] === 'quality-regulated' || ['cl2', 'cl3'].includes(config?.answers?.['q-criticality']);
}

/** a が b の祖先(または同じコミット)か。読めないコミットがあれば null */
export function isAncestorCommit(cwd, a, b) {
  if (!a || !b) return null;
  if (gitIn(cwd, ['cat-file', '-e', `${a}^{commit}`]) === null || gitIn(cwd, ['cat-file', '-e', `${b}^{commit}`]) === null) return null;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 写しの JSON を読む。読めなければ copy=null と理由(呼び出し側が skipped に出す)。
 * 写しの最小の組の欠け(reviews の配列が無い、ファイル名と pr が違う)は、推定で補わずに落とす。
 * 記録用ブランチ(readRecordsBranch)と基底ブランチの複製(aggregate-evidence.mjs の readBaseCopies)が同じ検査を使う
 */
export function parseCopy(file, text) {
  const base = String(file ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const m = base.match(REVIEW_FILE_RE);
  if (!m) return { copy: null, prNumber: null, reason: '写しの名前の形(pr-<番号>.json)でない' };
  const prNumber = Number(m[1]);
  let copy;
  try {
    copy = JSON.parse(text);
  } catch (e) {
    return { copy: null, prNumber, reason: `JSON として読めない: ${e.message}` };
  }
  if (!copy || typeof copy !== 'object' || !Array.isArray(copy.reviews)) return { copy: null, prNumber, reason: '写しの形でない(reviews の配列が無い)' };
  if (copy.pr !== undefined && Number(copy.pr) !== prNumber) return { copy: null, prNumber, reason: `ファイル名の PR 番号 ${prNumber} と写しの pr ${copy.pr} が一致しない` };
  return { copy, prNumber, reason: null };
}

/** 写しの head(record-copy.yml は head_sha と書く。旧い写しの head_sha_at_merge も読む)。無ければ null */
export const headOfCopy = (copy) => copy?.head_sha ?? copy?.head_sha_at_merge ?? null;

// ---------------------------------------------------------------- 様式(templates/04-gate-record.md)の冒頭の表
//
// 様式の欄の読み方は 1 か所に置く。docs/gates/(config.mjs の readGateRecords)、records/gates/(next.mjs)、集約の帰属の照合
// (aggregate-evidence.mjs)が同じ読み方を使う。様式の文言を残したままの欄(`<...>`)は未記入。「対象」だけは ` / ` を許す。
// 推奨の書き方(`F-012 / PR #34`、`F-012 / 1a2b3c4`。標準 第4章 G-2)が区切りに使うため。ほかの欄の ` / ` は様式の選択肢
// (`通過 / 差し戻し` など)が残ったものとして未記入に数える(#321 段階 2)

/** 欄の記載そのもの(前後の空白を除く。様式の文言のままの値を含む)。行が無ければ null */
export function formCellRaw(text, key) {
  return String(text ?? '').match(new RegExp(`^\\|\\s*${key}\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'm'))?.[1]?.trim() ?? null;
}

/**
 * 欄の値から Markdown の装飾を除く(比べる前に使う)。除くのは強調の `**` と `__`、インラインコードのバッククォート、
 * リンク `[文字](URL)` の URL(文字だけ残す)。採用先の記録は欄を太字やコード表記で書くことがあり、そのままでは
 * `**通過**` が通過と、`` `specs/F-001` `` が F-001 と一致しない。値の判定そのもの(結果欄の完全一致など)は緩めない
 */
export function normalizeCell(v) {
  if (v === null || v === undefined) return v;
  return String(v)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

/** 欄の値(装飾を除いたもの)。行が無ければ null */
const formCellPlain = (text, key) => normalizeCell(formCellRaw(text, key));

/** 記入済みの欄の値(装飾を除いたもの)。未記入(空、様式の文言のまま、選択肢が残ったまま)は null */
export function formCell(text, key) {
  const v = formCellPlain(text, key) ?? '';
  if (!v || v.startsWith('<')) return null;
  if (key !== '対象' && v.includes(' / ')) return null;
  return v;
}

/** 様式の「対象」の欄(装飾を除いたもの)。機械が出す欄の併記や注記(。以降)は読まない(呼び出し側が照合に使う形) */
export const targetOfForm = (text) => formCellPlain(text, '対象');

/** 様式の「判定者」の欄の記名(注記「。…」を除く)。様式の説明(<氏名>…)を残したままの欄は未記入(null) */
export const judgeOfForm = (text) => {
  const v = formCellPlain(text, '判定者');
  return v && !v.startsWith('<') ? v.replace(/。.*$/, '').trim() : null;
};

/**
 * 様式の本文から記録を起こす。file は所在、source は出所('base' = docs/gates/、'records-branch' = records/gates/)。
 * resultRaw は結果欄の記載そのもの(装飾も除かない。2 値のどちらとも読めない理由を示すために使う)
 */
export function recordFromForm(text, file, source) {
  return {
    file,
    source,
    gate: formCell(text, 'ゲート'),
    target: formCell(text, '対象'),
    result: formCell(text, '結果'),
    resultRaw: formCellRaw(text, '結果'),
    mode: formCell(text, '確定の形態'),
    riskConfirmedBy: formCell(text, 'リスク区分を確定した者'),
    d0Version: formCell(text, '参照した D-0 の版'),
    judgedAt: formCell(text, '判定日時'),
  };
}

/**
 * 記録用ブランチを読む。手元の `refs/remotes/origin/<ref>` か `refs/heads/<ref>` を使い、無ければ fetch=true のときに
 * `git fetch origin <ref>` を 1 回試す。それでも無ければ available=false と理由を返す(呼び出し側は「写しを読めない」として
 * 出す。黙って通さない)。ファイルはブランチを checkout せず、`git ls-tree` と `git show` で読む
 */
export function readRecordsBranch({ cwd = process.cwd(), ref = RECORDS_REF, fetch = true } = {}) {
  const result = { available: false, reason: null, ref, rev: null, head: null, reviews: new Map(), gates: [], conflicts: [], skipped: [] };
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
  result.rev = rev;
  result.head = head;

  const listed = gitIn(cwd, ['ls-tree', '-r', '--name-only', '-z', rev]);
  const files = (listed ?? '').split('\0').filter(Boolean);
  for (const file of files) {
    if (file.startsWith(`${REVIEWS_DIR}/`)) {
      const base = file.slice(REVIEWS_DIR.length + 1);
      if (!REVIEW_FILE_RE.test(base)) {
        result.skipped.push({ file, reason: `写しの名前の形(pr-<番号>.json)でない` });
        continue;
      }
      const text = gitIn(cwd, ['show', `${rev}:${file}`]);
      if (text === null) {
        result.skipped.push({ file, reason: '読めない(git show が失敗)' });
        continue;
      }
      const { copy, prNumber, reason } = parseCopy(base, text);
      if (!copy) {
        result.skipped.push({ file, reason });
        continue;
      }
      result.reviews.set(prNumber, copy);
    } else if (file.startsWith(`${GATES_DIR}/`) && file.endsWith('.md')) {
      const text = gitIn(cwd, ['show', `${rev}:${file}`]);
      if (text === null) {
        result.skipped.push({ file, reason: '読めない(git show が失敗)' });
        continue;
      }
      // commit は最後に触ったコミット(表示用)、added は置き場で様式を足したコミット(帰属を照らすコミット)
      result.gates.push({ file, text, commit: lastCommitOf(cwd, rev, file), added: addedCommitOf(cwd, rev, file) });
    } else if (file.startsWith(`${CONFLICTS_DIR}/`)) {
      // 写しの取り出しの衝突の記録(record-copy.yml)。呼び出し側が、その PR の写しを欠落に数える
      const m = file.slice(CONFLICTS_DIR.length + 1).match(/^pr-(\d+)-/);
      result.conflicts.push({ file, pr: m ? Number(m[1]) : null });
    }
  }
  return result;
}

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
 * 様式を置いたコミットの author と記名者の一致(D6 の表示)。**帰属の裏づけに数えない**(backed は常に false)。
 * Git の author と committer は書き手が任意に設定でき、名前・email・email から推したログイン名の一致は認証ではない。
 * 署名の無い author の一致を「弱い裏づけ」として数えていた形を、process-compass #379 / ADR-0109 決定3 で改めた。
 * 帰属の裏づけは、ホスティングの記録で確かめる(aggregate-evidence.mjs の formAttribution)。この関数は、自己申告の注記に
 * author との一致を添えるためだけに使う。読むのは様式を足したコミット(added)、無ければ最後に触ったコミット(commit)
 *   author-login / author-email / author-name  author が記名者と一致する(自己申告。署名の無い一致)
 *   null                                       一致するものが無い、またはコミットを読めない
 */
export function recordAttribution(gateRecord, { judgeName = null, judgeLogin = null, judgeEmail = null } = {}) {
  const c = gateRecord?.added ?? gateRecord?.commit;
  if (!c) return { backed: false, how: null, note: '様式を置いたコミットを読めない。帰属を裏づけられない' };
  const loginMatch = judgeLogin != null && c.authorLogin != null && sameText(judgeLogin, c.authorLogin);
  const emailMatch = judgeEmail != null && c.authorEmail != null && sameText(judgeEmail, c.authorEmail);
  const nameMatch = judgeName != null && c.authorName != null && sameText(judgeName, c.authorName);
  const short = String(c.hash ?? '').slice(0, 7);
  if (loginMatch) return { backed: false, how: 'author-login', note: `コミット ${short} の author の login が記名者と一致する。署名の無い author の一致は裏づけに数えない(記名は自己申告)` };
  if (emailMatch) return { backed: false, how: 'author-email', note: `コミット ${short} の author の email が記名者と一致する。署名の無い author の一致は裏づけに数えない(記名は自己申告)` };
  if (nameMatch) return { backed: false, how: 'author-name', note: `コミット ${short} の author の名前だけが記名者と一致。記名は自己申告` };
  return { backed: false, how: null, note: `コミット ${short} の author(${c.authorName} <${c.authorEmail}>)は記名者と一致しない。記名は自己申告` };
}

/** 様式の冒頭の表の「ゲート」欄の先頭の語(G-1〜G-8・SG)。無ければ null */
export function gateOfRecord(text) {
  const v = formCellPlain(text, 'ゲート');
  if (!v) return null;
  const g = v.match(/^(G-[1-8]|SG)\b/);
  return g ? g[1] : v;
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

// ワークフローの入口: `node scripts/gate/records.mjs --signature-required` は、作業木の process.config.json から
// 署名を要する構成か(true / false)を出す。構成を読めなければ false を出し、理由を標準エラーへ出す
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv.includes('--signature-required')) {
  let config = null;
  try {
    config = JSON.parse(readFileSync('process.config.json', 'utf8'));
  } catch (e) {
    process.stderr.write(`process.config.json を読めない(${e.message})。署名を要しない構成として扱う\n`);
  }
  process.stdout.write(`${recordsSignatureRequired(config)}\n`);
}

/**
 * G-1 を通過済みかを、基底ブランチの docs/gates/ と記録用ブランチの records/gates/ の両方から決める(process-compass #359 の
 * 独立の突合 高-1)。判定記録の正本は記録用ブランチの様式で、基底ブランチへは出荷の PR が複製する。複製の前の案件を「G-1 の前」と
 * 読み違えて、企画書の行の欠けを遡って失敗させないため。
 * 戻り値: { passed: true|false|null, records, reason }。
 *   passed=true  — どちらかに G-1 の通過の記録がある
 *   passed=false — 両方を読み、通過の記録が無い
 *   passed=null  — 基底ブランチに通過の記録が無く、記録用ブランチを読めない(reason に理由)。呼び出し側は G-1 の前とも
 *                  通過済みとも扱わず、「判定記録を読めない」として出す
 * records は両方の記録(記録用ブランチの記録は text を持つ)。branch を渡せばそれを使う(試験用)
 */
export function g1PassState({ cwd = process.cwd(), baseRecords = [], branch = undefined, fetch = true } = {}) {
  const isG1Pass = (r) => /^G-1(?!\d)/.test(r.gate ?? '') && r.result === '通過';
  let b = branch;
  if (b === undefined) {
    try {
      b = readRecordsBranch({ cwd, fetch });
    } catch (e) {
      b = { available: false, reason: `記録用ブランチを読めない(${e?.message ?? e})`, gates: [] };
    }
  }
  const fromBranch = b?.available ? (b.gates ?? []).map((g) => ({ ...recordFromForm(g.text, g.file, 'records-branch'), text: g.text })) : [];
  const records = [...baseRecords, ...fromBranch];
  if (records.some(isG1Pass)) return { passed: true, records, reason: null };
  if (!b?.available) return { passed: null, records, reason: b?.reason ?? '記録用ブランチを読めない' };
  return { passed: false, records, reason: null };
}
