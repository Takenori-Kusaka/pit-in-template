// 出荷判定(G-7)の証跡を集約する。
//
//   node scripts/gate/aggregate-evidence.mjs --from v1.3.0 --to v1.4.0 [--previous <前回の evidence.json>]
//   node scripts/gate/aggregate-evidence.mjs --period-from 2026-09-01 --period-to 2026-09-30 [--previous <前回の期間の evidence.json>]
//
// 出力: evidence/evidence.json(機械可読)、evidence/quality-report.md(人が読む)、
//       evidence/assurance-disclosure.external.md(組織の外へ渡す保証の開示)
//
// --period-from と --period-to は、出荷の範囲によらず、期間を指定して保証の開示を出す(標準 第4章 G-7・G-8
// 「期間ごとの保証の開示」/ 第5章 5.5.4)。委任で先へ進めた変更と、事後の抜き取りの結果を載せる。
// 出力先は evidence/period-<起点>_<終点>/ である。出荷の範囲に固有の検査(運用引き継ぎ文書・知財潔白性の
// 検査記録・当該出荷の判定記録の有無)は行わない。期間の開示に対応する受容と異議の記録(G-8 の判定記録の
// 「対象」に期間の起点と終点を書いたもの)が無ければ、記載の欠落とする。記録は開示を読んでから書くため、
// 記録を書いた後に同じ期間で集約し直すと検査を通る。前回の期間の出力は --previous で渡す(自動では探さない)
//
// 組織の外へ渡す出力は、項目6 を検出率の値で出しません。測定している事実・測定時点・推移の向きで
// 出します(標準 附属書H H.6「組織の外へ渡すとき」)。人が差し替える手順を持ちません。
//
// --previous を省くと、前回の出荷の出力を次の順に探します。無ければ「前回なし」と出力します。
//   1. evidence/previous/evidence.json(ship-evidence ワークフローが前回の成果物を置く場所)
//   2. 起点のタグに含まれる evidence/evidence.json(証跡をコミットしている場合)
//   3. 実行前から置かれている evidence/evidence.json のうち、終点が今回の起点と一致するもの
//
// G-7 は再テスト・再レビューを行いません。**記録と基準の突合**に限ります。
// したがってここで集めるのは「実施した記録」であって、品質の再判定ではありません。
// 記録が欠けていれば gaps へ入れ、ジョブを失敗させます。
//
// 保証の開示(G-7 基準9 の7項目)も、ここで出力します。構成と既存の記録からの投影であり、
// 人に新しい記述を書かせません。導けない項目は「未測定」「記録なし」を値として出します。
// 値の良否では落としません。落とすのは記録の欠落だけです(標準 附属書H H.6)。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig,
  loadAdapter,
  hasTarget,
  ROOT,
  fail,
  notice,
  warn,
  MODE_LABEL,
  qualificationProblems,
  sumNumstat,
  matchGlob,
  canonicalJson,
  readGateRecords,
  KIND_NOTE,
  DIRECTION_LABEL,
  aiNameReason,
  personKey,
  personName,
  findPerson,
  findPersonByAccount,
  pendingNotices,
  outagePeriods,
  aiNameBlocked,
  nameOverrides,
  configIntegrityProblems,
  isRealDay,
  localDay,
  localIso,
  resolveSigner,
  signerKey,
  isFilledValue,
  ACTIVE_EXCEPTION_STATES,
  dueDayOf,
  nameProblems,
} from './config.mjs';
import { riskClassOf, classifyByRule, classifyForSeat, REVIEWER_SEAT, DEVELOPER_SEAT } from './delegation.mjs';
import { seatSeparationFindings, outageText, rosterEditText } from '../init/generate-profile.mjs';

const config = loadConfig();
/**
 * 変化点の記録の日付(手元の時刻帯の日付)。時刻帯つきの時刻(at)があればその日付、無ければ date。
 * at を持たない旧い記録の date は、協定世界時の日付のことがある
 */
const changeDay = (e) => String(e?.at ?? e?.date ?? '').slice(0, 10);
const seats = config.seats ?? [];
const seatOf = (role) => seats.find((s) => s.role === role);
const whoKey = (role) => personKey(config, seatOf(role)?.accountable);
const whoName = (role) => (seatOf(role)?.accountable ? personName(config, seatOf(role).accountable) : null);
const g6Unmet = (config.unmet ?? []).find((u) => u.gate === 'g6');
// 独立レビュアの席の責任者が、開発者の席の責任者と同一人物か。AI を何体に分けても独立は成立しない
const reviewerIsDeveloper = Boolean(whoKey('independent-reviewer')) && whoKey('independent-reviewer') === whoKey('dev-verifier');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function git(args) {
  // 期間の指定では、コミットの一覧を標準入力で渡す(--stdin)
  const input = args.includes('--stdin') ? periodInput : null;
  // 期間にコミットが無い場合。空の入力では git log が HEAD をたどるため、呼ばない
  if (input === '') return '';
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...(input !== null ? { input } : { stdio: ['ignore', 'pipe', 'ignore'] }) }).trim();
  } catch {
    return '';
  }
}

function gh(args) {
  try {
    return JSON.parse(execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8' }));
  } catch {
    return null;
  }
}

// 期間を指定した保証の開示(委任で先へ進めた変更の、期間ごとの開示)。指定があれば、出荷の範囲を使わない
const periodFrom = arg('--period-from', null);
const periodTo = arg('--period-to', null);
const period = periodFrom || periodTo ? { from: periodFrom, to: periodTo } : null;
if (period && !(isRealDay(periodFrom) && isRealDay(periodTo) && periodFrom <= periodTo)) {
  fail('--period-from と --period-to には、実在する日付(YYYY-MM-DD)を、起点 ≦ 終点で指定してください');
  process.exit(2);
}

const to = period ? 'HEAD' : arg('--to', git(['describe', '--tags', '--abbrev=0']) || 'HEAD');
const from = period ? '' : arg('--from', git(['describe', '--tags', '--abbrev=0', `${to}^`]) || '');

const range = period ? `期間 ${period.from}〜${period.to}` : from ? `${from}..${to}` : to;
// git log へ渡す範囲の指定。期間の指定では、既定ブランチ(HEAD)のコミットのうち、コミットの日付(committer date)を
// 手元の時刻帯の日付に直した値が、起点から終点まで(両端を含む)に入るもの。git log --since は、日付の順に並ばない
// 履歴で途中から先をたどらないため使わない。全件を読んでから日付で切る
var periodInput = null;
if (period) {
  periodInput = git(['log', '--format=%H%x09%cI', 'HEAD'])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([, at]) => {
      const day = localDay(new Date(at));
      return day >= period.from && day <= period.to;
    })
    .map(([h]) => h)
    .join('\n');
}
const PERIOD_CUT = period
  ? `期間は、コミットの日付(committer date)を手元の時刻帯(実行した環境の時刻帯。UTC${localIso().slice(19)})の日付に直し、起点 ${period.from} から終点 ${period.to} まで(両端を含む)で切った`
  : null;
const logRange = period ? ['--no-walk=unsorted', '--stdin'] : [range];
const OUT_DIR = period ? `evidence/period-${period.from}_${period.to}` : 'evidence';

// --- 構成の初期化より前の履歴(pre-init) ---------------------------------------
//
// テンプレート由来の初期コミットなど、構成の初期化(process.config.json が設定済みになったコミット)より
// 前の履歴は、利用者の変更ではない。対象外(pre-init)として扱い、件数を表示する。初期化のコミット自身は
// 対象である(/process-init の例はトレーラ Risk・Verification を書く)
function findInitCommit() {
  for (const h of git(['log', '--reverse', '--format=%H', '--', 'process.config.json']).split('\n').filter(Boolean)) {
    try {
      const c = JSON.parse(execFileSync('git', ['show', `${h}:process.config.json`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      if (c?.configured === true) return h;
    } catch {
      // 読めない版は飛ばす
    }
  }
  return null;
}
const initCommit = findInitCommit();
const preInit = new Set(initCommit ? git(['rev-list', `${initCommit}^`]).split('\n').filter(Boolean) : []);

const allCommits = git(['log', '--format=%H%x09%s%x09%P', ...logRange])
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [hash, subject, parents] = l.split('\t');
    return { hash, subject: subject ?? '', parents: (parents ?? '').split(' ').filter(Boolean) };
  });
const preInitCommits = allCommits.filter((c) => preInit.has(c.hash));
const commits = allCommits.filter((c) => !preInit.has(c.hash));

// --- PR の識別(標準 第3章 3.8.1 / 第4章 G-7 基準5) ----------------------------
//
// コミットを PR の変更として扱うのは、そのコミットが当該 PR のマージコミット(GitHub の mergeCommit)と
// 一致する場合に限る。件名に「(#N)」があっても、一致しないコミットは PR を経ていないコミットである
// (main へ直接入れた件名、git revert の既定の件名「Revert "… (#N)"」など)。
// マージコミットを取得できない PR の番号を持つコミットも、PR を経ていないコミットとして扱い、その旨を表示する。
// マージの方式ごとの扱い:
//   スカッシュ: マージコミット1件が PR の変更である
//   マージコミット: マージコミットが PR の変更である。第2の親から取り込んだコミットは、PR の構成要素として数えない
//   リベース: マージコミット(最後のコミット)から第1の親をたどり、PR のコミットと件名・作成日時が順に一致する
//             コミットを、PR の構成要素として数えない。一致しなければ、PR を経ていないコミットとして扱う(安全側)

const candidateNumbers = new Set();
for (const c of commits) {
  for (const m of c.subject.matchAll(/\(#(\d+)\)|^Merge pull request #(\d+)/g)) candidateNumbers.add(Number(m[1] ?? m[2]));
}

const dropComments = (s) => String(s ?? '').replace(/<!--[\s\S]*?-->/g, '');
/** PR の本文から、見出しの節の中身を取り出す。様式のコメントは除く。節が無ければ null */
function sectionOf(body, title) {
  const rest = dropComments(body).split(new RegExp(`^##\\s*${title}.*$`, 'm'))[1];
  return rest === undefined ? null : rest.split(/^(?:##\s|---\s*$)/m)[0].trim();
}
/**
 * PR の番号への参照を含むか。PR を指すのは「PR #12」、前に語の無い「#12」、PR の URL(…/pull/12)に限る。
 * 「Issue #12」「課題#12」「org/repo#12」のように、前に PR 以外の語がある番号は PR を指さない(K75)
 */
const refersToPr = (text, n) => {
  const s = String(text ?? '');
  if (new RegExp(`/pull/${n}(?!\\d)`).test(s)) return true;
  for (const m of s.matchAll(new RegExp(`#${n}(?!\\d)`, 'g'))) {
    const before = s.slice(0, m.index).replace(/\s+$/, '');
    if (/(?:^|[^A-Za-z])(?:PR|pull request|プルリクエスト)$/i.test(before)) return true;
    // 直前が語(英数字・かな・漢字・パスの区切り)でなければ、PR の番号とみなす
    if (!/[\p{L}\p{N}_/.-]$/u.test(before)) return true;
  }
  return false;
};

// --- 成果物の記録 ----------------------------------------------------------

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}
function listDir(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => f.endsWith('.md')) : [];
}

const gateRecords = listDir('docs/gates');
const adrs = listDir('context/decisions');
const debtFile = 'docs/debt-ledger.md';
const handoverFile = 'docs/handover.md';

const coverage = exists('evidence/coverage-result.json')
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/coverage-result.json'), 'utf8'))
  : { measured: false, reason: '集計ファイルがありません' };

const depDiff = exists('evidence/dependency-diff.json')
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/dependency-diff.json'), 'utf8'))
  : null;

const licenseScan = exists('evidence/license-scan.json')
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/license-scan.json'), 'utf8'))
  : { scanRun: false };

/** 記入があるか。「—」「未定」などの記入でない値と、様式の説明(<…>)を残したままの欄は、未記入である(登録の根拠と同じ関数) */
const filled = isFilledValue;

// 技術負債台帳の全行。未回収の一覧(項目5)と、例外承認の記録の対応づけに使う。
// 欄は見出し行の欄名で読む(標準 第6章 テンプレ3)。見出し行に「区分」と「状態」を持たない旧い台帳は、
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
function readLedger() {
  if (!exists(debtFile)) return null;
  const rows = [];
  let header = null;
  for (const line of fs.readFileSync(path.join(ROOT, debtFile), 'utf8').split(/\r?\n/)) {
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
const ledgerRows = readLedger();

// ゲート判定記録の、様式(テンプレ4)に依る欄。対象・判定者・結果・挙動要約・出荷判定者の異議を読む。
// 様式の説明文と記入例を残したままの欄は、未記入として扱う
const gateRecordList = readGateRecords();
const gateTemplate = exists('templates/04-gate-record.md') ? fs.readFileSync(path.join(ROOT, 'templates/04-gate-record.md'), 'utf8') : '';
const mdSection = (text, heading) => text.split(new RegExp(`^##\\s*${heading}.*$`, 'm'))[1]?.split(/^##\s/m)[0] ?? null;
const normLine = (l) => l.replace(/\s+/g, ' ').trim();
const rowValue = (text, key, exact = true) =>
  text.match(new RegExp(`^\\|\\s*\\**${key}${exact ? '' : '[^|]*'}\\**\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'm'))?.[1]?.trim() ?? null;
const templateSummaryLines = new Set((mdSection(gateTemplate, '挙動要約') ?? '').split(/\r?\n/).map(normLine).filter(Boolean));
const templateObjection = normLine(rowValue(gateTemplate, '出荷判定者の異議', false) ?? '');
const gateDetails = gateRecordList.map((r) => {
  const text = fs.readFileSync(path.join(ROOT, r.file), 'utf8');
  const summary = (mdSection(text, '挙動要約') ?? '').split(/\r?\n/).map(normLine).filter((l) => l && !templateSummaryLines.has(l) && !l.startsWith('>'));
  const objectionRaw = rowValue(text, '出荷判定者の異議', false);
  const objection = normLine(objectionRaw ?? '');
  const judge = rowValue(text, '判定者');
  return {
    ...r,
    target: rowValue(text, '対象'),
    // 判定者の記名。様式の説明(<氏名>…)を残したままの欄は未記入
    judge: judge && !judge.startsWith('<') ? judge.replace(/。.*$/, '').trim() : null,
    // 作成側の検証の記載。「検証方法と結果」の欄(表の行)または節に、記載があるか
    authorVerificationPresent: Boolean(
      (rowValue(text, '検証方法と結果') ?? '').replace(/^<.*>$/, '').trim() || dropComments(mdSection(text, '検証方法と結果') ?? '').trim()
    ),
    // 「変更のリスク区分」の欄。選択肢を残したままの欄は未記入として扱う
    riskClass: ((m) => (m.size === 1 ? [...m][0] : null))(new Set((rowValue(text, '変更のリスク区分') ?? '').match(/R[123]/g) ?? [])),
    behaviorSummaryPresent: summary.length > 0,
    objectionRowPresent: objectionRaw !== null,
    objection: objection && objection !== templateObjection && !objection.startsWith('<') ? objection : null,
  };
});
const passed = (g) => /^通過/.test(g.result ?? '');
/**
 * G-6 の判定記録のうち、対象が refers に当たり、結果が通過のもの。確定の形態が「委任」の記録は、事後の抜き取りの
 * 記録であり、事前の承認ではない。独立した人の確認には数えない(第4章 G-6「記録」)
 */
const g6RecordsFor = (refers) =>
  gateDetails.filter((g) => /G-6/.test(g.gate ?? '') && passed(g) && g.mode !== MODE_LABEL.delegated && refers(g.target));

// 当該出荷の範囲(期間の指定では、当該期間)で追加された判定記録。過去の出荷の記録で、今回の完備を示さない
// (標準 第4章 G-7 基準5・9)
const recordsInRange =
  from || period
    ? new Set(git(['log', '--diff-filter=A', '--name-only', '--format=', ...logRange, '--', 'docs/gates']).split('\n').filter(Boolean))
    : null;
const records = gateDetails.filter((r) => !recordsInRange || recordsInRange.has(r.file));

// --- コミットのトレーラ ------------------------------------------------------

const trailerFormat =
  '%H%x09%an%x09%ae%x09%(trailers:key=Delegated,valueonly,separator=%x2C)%x09%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)%x09%(trailers:key=Risk,valueonly,separator=%x2C)%x09%(trailers:key=Verification,valueonly,separator=%x2C)%x09%(trailers:key=Spec,valueonly,separator=%x2C)';
const trailerOf = new Map(
  git(['log', `--format=${trailerFormat}`, ...logRange])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, authorName, authorEmail, delegated, coAuthors, risk, verification, spec] = l.split('\t');
      return [
        hash,
        {
          authorName: authorName ?? '',
          authorEmail: authorEmail ?? '',
          delegated: (delegated ?? '').split(',')[0].trim() || null,
          coAuthors: (coAuthors ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          risk: (risk ?? '').split(',')[0].trim() || null,
          verification: (verification ?? '').trim() || null,
          // 仕様の識別子(F-NNN)。様式の例(F-xxx)は数えない
          specs: [...new Set(((spec ?? '').match(/F-\d+/g) ?? []))],
        },
      ];
    })
);
const trailers = commits.map((c) => ({ ...c, ...(trailerOf.get(c.hash) ?? { coAuthors: [], specs: [] }) }));

// --- PR とマージコミットの突合(K44) ---------------------------------------------

const repo = process.env.GITHUB_REPOSITORY ?? '';
const PR_FIELDS = 'number,title,author,reviews,statusCheckRollup,body,mergeCommit,commits';
const prData = new Map();
const fetchPr = (n) => {
  if (!prData.has(n)) prData.set(n, repo ? gh(['pr', 'view', String(n), '--repo', repo, '--json', PR_FIELDS]) : null);
  return prData.get(n);
};
for (const n of candidateNumbers) fetchPr(n);

const inRange = new Map(commits.map((c) => [c.hash, c]));
const sameTime = (a, b) => Boolean(a && b) && new Date(a).getTime() === new Date(b).getTime();
// コミット → PR。role は merge(PR の変更として数えるコミット)または constituent(PR の構成要素。数えない)
const commitPr = new Map();
function mapPr(n, d) {
  const mc = d?.mergeCommit?.oid ?? null;
  if (!mc || !inRange.has(mc) || commitPr.has(mc)) return;
  const c = inRange.get(mc);
  if (c.parents.length > 1) {
    commitPr.set(mc, { number: n, role: 'merge', method: 'merge-commit' });
    for (const h of git(['rev-list', `${c.parents[0]}..${c.parents[1]}`]).split('\n').filter(Boolean)) {
      if (!commitPr.has(h)) commitPr.set(h, { number: n, role: 'constituent', method: 'merge-commit' });
    }
    return;
  }
  const own = Array.isArray(d.commits) ? d.commits : [];
  let method = 'squash';
  if (own.length > 1) {
    // リベース: 第1の親をたどり、PR のコミットと件名・作成日時が順に一致するかを見る
    const chain = [];
    let cur = mc;
    for (let i = 0; i < own.length && cur; i++) {
      const info = git(['log', '-1', '--format=%s%x09%aI%x09%P', cur]).split('\t');
      chain.unshift({ hash: cur, subject: info[0], authored: info[1] });
      cur = (info[2] ?? '').split(' ')[0] || null;
    }
    const matches =
      chain.length === own.length && chain.every((x, i) => x.subject === own[i].messageHeadline && (!own[i].authoredDate || sameTime(x.authored, own[i].authoredDate)));
    if (matches) {
      method = 'rebase';
      for (const x of chain.slice(0, -1)) if (!commitPr.has(x.hash)) commitPr.set(x.hash, { number: n, role: 'constituent', method });
    }
  }
  commitPr.set(mc, { number: n, role: 'merge', method });
}
for (const n of candidateNumbers) mapPr(n, fetchPr(n));
// 件名に番号を持たないコミット(スカッシュの件名を書き換えた場合など)は、GitHub にコミットと PR の関係を問い合わせる
for (const c of commits) {
  if (commitPr.has(c.hash) || c.parents.length > 1 || !repo) continue;
  if (/\(#\d+\)|^Merge pull request #\d+/.test(c.subject)) continue;
  const list = gh(['api', `repos/${repo}/commits/${c.hash}/pulls`]);
  const hit = Array.isArray(list) ? list.find((p) => p?.merge_commit_sha === c.hash && p?.merged_at) : null;
  if (hit) mapPr(Number(hit.number), fetchPr(Number(hit.number)));
}
/** 件名に PR の番号を持つが、PR の変更と認めないコミットの理由 */
function claimedPrNote(c) {
  const n = Number(c.subject.match(/\(#(\d+)\)|^Merge pull request #(\d+)/)?.slice(1).find(Boolean) ?? 0) || null;
  if (!n) return null;
  const d = prData.get(n);
  if (!d) return { number: n, why: `PR #${n} の記録を取得できない。マージコミットと突合できないため、PR を経ていないコミットとして扱う` };
  if (!d.mergeCommit?.oid) return { number: n, why: `PR #${n} のマージコミットを取得できない(マージされていない PR を含む)。PR を経ていないコミットとして扱う` };
  return { number: n, why: `件名は PR #${n} を指すが、PR #${n} のマージコミット(${d.mergeCommit.oid.slice(0, 7)})と一致しない。PR を経ていないコミットとして扱う` };
}

// --- 承認者の同一性(標準 第4章 G-6 基準4 / 附属書H H.6) -----------------------
//
// 承認を「独立した人の確認」に数えるのは、次をすべて満たす場合に限る(第4章 G-6 の4条件)。
//   1. 承認した者が、名簿(people[])の人へ対応づく(アカウント people[].accounts[]、または判定記録の判定者の氏名)
//   2. その人が、当該変更の作成を指示した者でない
//   3. 構成上、G-6 が未達でも「成立しない(責任者が同一)」でもない。
//      ただし、承認した人が名簿で外部の確認者(external)である場合は数える
//   4. 承認した者自身の書いた挙動要約を伴う(承認レビューの本文、または当人が判定者の G-6 の判定記録の「挙動要約」の節)
// 承認は、レビュアごとの最後の状態で数える。承認の後に同じ人が変更要求を出した場合、取り下げられた承認は数えない。
// PR のレビューの承認のほかに、G-6 の判定記録(対象が当該の PR またはコミット、結果が通過)も承認として数える。
// 差し戻された変更は、独立した人が確認し、G-6 の判定記録を残したうえで突合し直す(第4章 G-7 基準5)。
// 作成を指示した者は、PR 本文の欄「作成を指示した者」から取る。欄が未記入のときは、PR の作成者
// (人のアカウントの場合)と、開発者の席の責任者を指示者とみなす(既定値)。PR を経ていないコミットでは、
// コミットの Author と、開発者の席の責任者を指示者とみなす。
// 名簿のアカウントの記載が正しいかは、機械で確かめない(架空の2人目を書ける)。監査観点6 で確かめる。

const UNCONFIRMED = {
  recordNotFound: '承認記録を取得できない',
  noApproval: '人のアカウントによる承認がない',
  aiOrBot: 'AI・bot のアカウントによる承認だけである(検出の層。承認に数えない)',
  approverUnmapped: '承認者を名簿と対応づけられない(組織上の任命権者は確認者に数えない)',
  approverIsInstructor: '承認者が、作成を指示した者である',
  structure: '構成上、独立レビュー(G-6)が未達または成立しない(体制の内の人の承認を数えない)',
  instructorUnresolved: '作成を指示した者を名簿と対応づけられない',
  noReviewerSummary: 'レビュアの挙動要約が無い(承認した者自身の挙動要約を伴わない承認は数えない)',
  directCommit: 'PR を経ていない(独立した人の G-6 の判定記録が対応づかない)',
};

/** 数えない理由の識別子(evidence.json の prs[].g6.notCountedReason) */
const NOT_COUNTED_CODE = {
  recordNotFound: 'record-not-found',
  noApproval: 'no-approval-record',
  aiOrBot: 'ai-or-bot',
  approverUnmapped: 'approver-not-in-roster',
  approverIsInstructor: 'approver-instructed',
  structure: 'g6-not-established',
  instructorUnresolved: 'instructor-not-in-roster',
  noReviewerSummary: 'no-reviewer-summary',
  directCommit: 'direct-commit',
};

/**
 * 欄「作成を指示した者」の記載(複数可。改行・「、」「,」「/」で区切る)。氏名、名簿の id、@アカウント のいずれか。
 * 区切れない書き方(「A と B」など)と、姓だけなど名簿の複数の人に当たり得る記名は、対応づけられない指示者になる(K73)
 */
function instructorTokens(body) {
  return (sectionOf(body, '作成を指示した者') ?? '')
    .split(/[\n,、，/／]/)
    .map((t) => t.replace(/^[\s\-*・]+/, '').trim())
    .filter(Boolean);
}
// 氏名の空白・括弧書き・敬称、アカウントの @ の有無を正規化して、名簿の人へ対応づける(例外承認の承認した者と同じ照合)
const resolvePerson = (token) => (token.startsWith('@') ? findPersonByAccount(config, token) : resolveSigner(config, token));

/** 開発者の席の責任者を、指示者の既定値へ足す */
function addDeveloper(known, unresolved) {
  const devName = seatOf('dev-verifier')?.accountable ?? null;
  const dev = devName ? findPerson(config, devName) : null;
  if (dev) known.set(dev.id, dev.name);
  else if (devName) unresolved.push(devName);
}

function instructorsOf(d) {
  const known = new Map();
  const unresolved = [];
  const tokens = instructorTokens(d.body);
  for (const t of tokens) {
    const p = resolvePerson(t);
    if (p) known.set(p.id, p.name);
    else unresolved.push(t);
  }
  if (tokens.length) return { known, unresolved, byDefault: false };
  // 欄が未記入。PR の作成者(人のアカウントの場合)と、開発者の席の責任者を指示者とみなす
  const login = d.author?.login ?? null;
  if (login && !d.author?.is_bot && !aiNameReason(login, { account: true })) {
    const p = findPersonByAccount(config, login);
    if (p) known.set(p.id, p.name);
    else unresolved.push(`@${login}`);
  }
  addDeveloper(known, unresolved);
  if (!known.size && !unresolved.length) unresolved.push('(PR の作成者が人のアカウントでなく、開発者の席の責任者も未記入)');
  return { known, unresolved, byDefault: true };
}

/** PR を経ていないコミットの指示者。コミットの Author(氏名、またはメールのアカウント部分)と、開発者の席の責任者 */
function commitInstructors(c) {
  const known = new Map();
  const unresolved = [];
  const account = String(c.authorEmail ?? '').split('@')[0].replace(/^\d+\+/, '');
  const p = resolveSigner(config, c.authorName) ?? findPersonByAccount(config, account);
  if (p) known.set(p.id, p.name);
  // 名簿に無い Author は捨てずに、対応づけられない指示者として扱う(K73。独立の判定と例外承認の照合を安全側に倒す)
  else unresolved.push(String(c.authorName ?? '').trim() || (account ? `@${account}` : '(コミットの Author が不明)'));
  addDeveloper(known, unresolved);
  return { known, unresolved, byDefault: true };
}

/** レビュアごとの最後の状態。COMMENTED は状態を変えない。承認の本文は、最後の承認までの連続した承認のいずれかにあれば足る */
function lastReviewStates(reviews) {
  const last = new Map();
  let withdrawn = 0;
  for (const r of reviews ?? []) {
    const login = r.author?.login;
    const state = String(r.state ?? '').toUpperCase();
    if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) continue;
    const before = last.get(login);
    const body = dropComments(r.body).trim().length > 0;
    if (state === 'APPROVED') last.set(login, { state, bot: Boolean(r.author?.is_bot), summary: body || (before?.state === 'APPROVED' && before.summary) });
    else last.set(login, { state, bot: Boolean(r.author?.is_bot), summary: false, withdrew: before?.state === 'APPROVED' || before?.withdrew });
  }
  for (const v of last.values()) if (v.state !== 'APPROVED' && v.withdrew) withdrawn++;
  return { last, withdrawn };
}

/** 承認者として名簿の人へ対応づける。組織上の任命権者(appointer)は確認者ではないため、対応づけない */
const reviewerPerson = (p) => (p && p.appointer !== true ? p : null);
const isAiLogin = (login, bot) => bot || Boolean(aiNameReason(login ?? '', { account: true }));

/**
 * 独立した人の確認に数えるかを判定する。
 * reviews: PR のレビュー(PR を経ていないコミットでは空)。refers: G-6 の判定記録の「対象」が当該の変更を指すか
 */
function independentConfirmation(ins, reviews, refers, { direct = false } = {}) {
  const about = {
    instructors: [...ins.known.values()],
    instructorsByDefault: ins.byDefault,
    unresolvedInstructors: ins.unresolved,
    unmappedApprovers: [],
  };
  const none = (reason, extra = {}) => ({ counted: false, reason, reasonText: UNCONFIRMED[reason], by: [], byLogins: [], ...about, ...extra });
  const { last, withdrawn } = lastReviewStates(reviews);
  about.withdrawnApprovals = withdrawn;
  const records = g6RecordsFor(refers);
  const candidates = [];
  let ai = 0;
  for (const [login, v] of last) {
    if (v.state !== 'APPROVED') continue;
    if (isAiLogin(login, v.bot)) {
      ai++;
      continue;
    }
    candidates.push({ login, label: login, person: reviewerPerson(findPersonByAccount(config, login)), summary: v.summary ? 'review' : null, source: 'review' });
  }
  for (const g of records) {
    if (!g.judge) continue;
    if (aiNameBlocked(config, g.judge)) {
      ai++;
      continue;
    }
    candidates.push({ login: null, label: g.judge, person: reviewerPerson(findPerson(config, g.judge)), summary: g.behaviorSummaryPresent ? 'gate-record' : null, source: 'gate-record', file: g.file });
  }
  // 承認レビューの本文に要約が無くても、当人が判定者の G-6 の判定記録に要約があれば足る
  for (const c of candidates) {
    if (c.summary || !c.person) continue;
    if (records.some((g) => g.behaviorSummaryPresent && findPerson(config, g.judge)?.id === c.person.id)) c.summary = 'gate-record';
  }
  if (!candidates.length) return none(direct && !ai ? 'directCommit' : ai ? 'aiOrBot' : 'noApproval');
  about.unmappedApprovers = candidates.filter((c) => !c.person).map((c) => c.label);
  const known = candidates.filter((c) => c.person);
  if (!known.length) return none('approverUnmapped');
  const others = known.filter((c) => !ins.known.has(c.person.id));
  if (!others.length) return none('approverIsInstructor');
  const eligible = g6Unmet || reviewerIsDeveloper ? others.filter((c) => c.person.external === true) : others;
  if (!eligible.length) return none('structure');
  if (ins.unresolved.length) return none('instructorUnresolved');
  const summarized = eligible.filter((c) => c.summary);
  if (!summarized.length) return none('noReviewerSummary');
  const reviewerKey = whoKey('independent-reviewer');
  return {
    counted: true,
    reason: null,
    reasonText: null,
    by: [...new Set(summarized.map((c) => c.person.name))],
    byLogins: summarized.map((c) => c.login).filter(Boolean),
    source: summarized.some((c) => c.source === 'review') ? 'review' : 'gate-record',
    summarySource: summarized.some((c) => c.summary === 'review') ? 'review' : 'gate-record',
    // 承認した者に、独立レビュアの席の責任者が含まれるか(件数として別に出す。欠落にはしない)
    byReviewerSeat: Boolean(reviewerKey) && summarized.some((c) => c.person.id === reviewerKey || personKey(config, c.person.name) === reviewerKey),
    ...about,
  };
}

/** 開発者の席の責任者(人)の承認があるか(最後の状態が承認)。G-6 を事後へ移す委任で、開発者の席が協働の場合に要る */
function developerApproved(reviews) {
  const devKey = whoKey('dev-verifier');
  if (!devKey) return false;
  const { last } = lastReviewStates(reviews);
  return [...last].some(([login, v]) => v.state === 'APPROVED' && !isAiLogin(login, v.bot) && findPersonByAccount(config, login)?.id === devKey);
}

const prs = [];
for (const [hash, m] of commitPr) {
  if (m.role !== 'merge') continue;
  const n = m.number;
  const d = prData.get(n);
  const g5 = (d?.statusCheckRollup ?? []).find((s) => s.name === 'gate-g5' || s.context === 'gate-g5');
  const ins = instructorsOf(d);
  const independent = independentConfirmation(ins, d.reviews, (text) => refersToPr(text, n));
  const { last } = lastReviewStates(d.reviews);
  const humanApprovers = [...last].filter(([login, v]) => v.state === 'APPROVED' && !isAiLogin(login, v.bot)).map(([login]) => login);
  // PR の変更に属するコミット(マージコミットと構成要素)
  const own = [...commitPr].filter(([, x]) => x.number === n).map(([h]) => h);
  prs.push({
    number: n,
    title: d?.title ?? null,
    recordFound: true,
    mergeCommit: hash.slice(0, 8),
    // マージの方式。squash / merge-commit / rebase(構成要素の数え方だけが変わる)
    mergeMethod: m.method,
    riskClass: riskClassOf(d?.body),
    g5: g5 ? (g5.conclusion ?? g5.state ?? 'unknown').toLowerCase() : 'unknown',
    // 作成側の検証の記載(PR 本文「検証方法と結果」)。レビュアの挙動要約ではない
    authorVerificationPresent: Boolean(sectionOf(d?.body, '検証方法と結果')),
    // 作成を指示した者と、その出所。declared(PR 本文の欄) / default(既定値: PR の作成者と、開発者の席の責任者)
    instructedBy: [...independent.instructors, ...independent.unresolvedInstructors],
    instructedBySource: independent.instructorsByDefault ? 'default' : 'declared',
    specs: [...new Set(own.flatMap((h) => trailerOf.get(h)?.specs ?? []))],
    developerApproved: developerApproved(d.reviews),
    g6: {
      approver: humanApprovers[0] ?? null,
      approvers: humanApprovers,
      approvals: humanApprovers.length,
      // 承認の後に変更要求を出し、承認を取り下げたレビュア
      withdrawnApprovals: independent.withdrawnApprovals ?? 0,
      // 承認者の同一性と挙動要約を確かめたうえで、独立した人の確認に数えたか。数えない理由は independent にある
      independentHuman: independent.counted,
      notCountedReason: independent.counted ? null : NOT_COUNTED_CODE[independent.reason],
      independent,
      // レビュアの挙動要約(G-6 基準2)の有無と所在。'review'(承認レビューの本文) / 'gate-record'(G-6 の判定記録)
      reviewerSummaryPresent: independent.counted,
      reviewerSummarySource: independent.counted ? independent.summarySource : null,
    },
    commits: own.map((h) => h.slice(0, 8)),
  });
}
prs.sort((a, b) => a.number - b.number);
const prByNumber = new Map(prs.map((p) => [p.number, p]));

// --- PR を経ていないコミット(標準 第3章 3.8.1) --------------------------------
//
// リスク区分は変更ごとに確定する記録である。PR を経ていないコミットは、PR 本文の欄を持たないため、
// コミットのトレーラ `Risk: R1|R2|R3` から読む。トレーラが無いコミットは、区分が未記入である。
// 作成側の検証の記載は、トレーラ `Verification: <実行した検証と結果の要点、または証跡の所在>` から読む。
// 機械が見るのは有無だけである。内容は見ない(PR 本文の「検証方法と結果」と同じ水準)。
// 変更したファイルがすべて記録の置き場に収まるコミットは、製品の変更でないため対象外とする。
// 対象外にしたコミットは、変更の件数にも数えない。件数は表示する。

/**
 * 記録の置き場。ここだけを変えるコミットは、製品の変更でない。
 *
 * 無条件で対象外にするのは、判定記録、証跡、技術負債台帳、体制図、構成書(全体が生成物)である。
 * 体制図は、決定の理由と記名の記録である。生成区間と構成の一致は、D-0 の検査(check-d0)が確かめる
 */
const RECORD_PATHS = ['docs/gates/**', 'evidence/**', 'docs/debt-ledger.md', 'docs/D-0-governance.md', 'PROCESS-PROFILE.md'];

/**
 * 内容を見て対象外にするファイル。パスだけで対象外にすると、構成の手での書き換えと、指示資産の
 * 手書き部分(強制層)の変更が、リスク区分の記録も、独立した人の確認の件数も免れる。
 * 対象外にできない場合は、その理由を返す。対象外にできる場合は null
 */
const GENERATED_BLOCK = /<!-- generated:process-rules start -->[\s\S]*?<!-- generated:process-rules end -->/;
const CONDITIONAL_RECORD_PATHS = {
  // /process-change が書くのは生成区間だけである。生成区間の外(手書き部分)が変わっていないこと
  'CLAUDE.md': (before, after) => {
    if (before === null || after === null) return 'CLAUDE.md の追加または削除である';
    const outside = (text) => text.replace(/\r\n/g, '\n').replace(GENERATED_BLOCK, '').trim();
    return outside(before) === outside(after) ? null : 'CLAUDE.md の生成区間の外(手書き部分)が変わっている';
  },
  // 構成を書き換えるのは /process-change だけである。変化点の記録(changeLog[])が追記されており、
  // 既存の記録が先頭部分として保たれていること
  'process.config.json': (before, after) => {
    let b;
    let h;
    try {
      b = JSON.parse(before ?? '');
      h = JSON.parse(after ?? '');
    } catch {
      return 'process.config.json の前後を読めない(追加・削除、または JSON でない)';
    }
    const bl = Array.isArray(b.changeLog) ? b.changeLog : [];
    const hl = Array.isArray(h.changeLog) ? h.changeLog : [];
    if (hl.length <= bl.length) return 'process.config.json が、変化点の記録(changeLog)の追記なしに書き換えられている';
    if (bl.some((e, i) => canonicalJson(e) !== canonicalJson(hl[i]))) return 'process.config.json の、既存の変化点の記録(changeLog)が書き換えられている';
    return null;
  },
};
// 構成の初期化より前のコミットのうち、製品のコード(記録の置き場の外)を変えたもの。欠落にはしないが、
// 件数を保証の開示の項目1・5 に出し、品質レポートに一覧を出す(隠さない)。独立した人の確認・リスク区分・
// 検証の記載は確かめていない。テンプレート由来の初期コミット(親を持たず、テンプレートのファイルだけを持つ
// コミット)は、一覧から除いて件数だけ出す
const TEMPLATE_FILES = [
  '.claude/**', '.github/**', 'adapters/**', 'context/**', 'docs/**', 'evidence/**', 'profiles/**', 'scripts/**', 'specs/**', 'templates/**',
  'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'LICENSE-docs', 'README.md', 'process.config.json', 'PROCESS-PROFILE.md', '.gitignore',
];
const preInitDetail = (() => {
  const product = [];
  let templateOrigin = 0;
  let recordOnly = 0;
  for (const c of preInitCommits) {
    const files = git(['show', '--name-only', '--format=', c.hash]).split('\n').filter(Boolean);
    if (!c.parents.length && files.length && files.every((x) => TEMPLATE_FILES.some((g) => matchGlob(g, x)))) {
      templateOrigin++;
      continue;
    }
    const outside = files.filter((x) => !RECORD_PATHS.some((g) => matchGlob(g, x)));
    if (!outside.length) {
      recordOnly++;
      continue;
    }
    product.push({ commit: c.hash.slice(0, 8), subject: c.subject, files: outside.length });
  }
  return { total: preInitCommits.length, templateOrigin, recordOnly, product };
})();
const fileAt = (rev, file) => {
  try {
    return execFileSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};
const commitRefers = (hash) => (text) => (String(text ?? '').match(/\b[0-9a-f]{7,40}\b/gi) ?? []).some((t) => hash.toLowerCase().startsWith(t.toLowerCase()));
const directChanges = trailers
  .filter((c) => !commitPr.has(c.hash))
  .map((c) => {
    const files = git(['show', '--name-only', '--format=', c.hash]).split('\n').filter(Boolean);
    // 対象外にできない理由。空なら、記録だけのコミットである
    const notRecord = [];
    for (const x of files) {
      if (RECORD_PATHS.some((g) => matchGlob(g, x))) continue;
      const judge = CONDITIONAL_RECORD_PATHS[x];
      if (!judge) {
        notRecord.push(`記録の置き場の外のファイルを含む(${x})`);
        continue;
      }
      const why = judge(fileAt(`${c.hash}^`, x), fileAt(c.hash, x));
      if (why) notRecord.push(why);
    }
    // 対象外: 記録だけのコミット(record-only)と、ファイルの変更を持たないコミット(empty。マージなど)
    const exempt = !files.length ? 'empty' : notRecord.length ? null : 'record-only';
    const ins = commitInstructors(c);
    const independent = exempt ? null : independentConfirmation(ins, [], commitRefers(c.hash), { direct: true });
    return {
      commit: c.hash.slice(0, 8),
      hash: c.hash,
      subject: c.subject,
      // 件名が PR の番号を指すのに、PR の変更と認めなかったコミット(番号と理由)
      claimedPr: claimedPrNote(c),
      riskClass: /^R[123]$/.test(c.risk ?? '') ? c.risk : null,
      // 作成側の検証の記載(トレーラ Verification)。値が空のトレーラは、記載なしとして扱う
      authorVerificationPresent: Boolean(c.verification),
      exempt,
      // 対象にした理由(先頭の3件)
      notExemptBecause: exempt ? [] : notRecord.slice(0, 3),
      files: files.length,
      specs: c.specs ?? [],
      independent,
      instructedBy: independent ? [...independent.instructors, ...independent.unresolvedInstructors] : [],
    };
  });
const directProduct = directChanges.filter((d) => !d.exempt);

function configBefore(hash) {
  try {
    return JSON.parse(git(['show', `${hash}^:process.config.json`]));
  } catch {
    return config;
  }
}

// --- 委任で先へ進めた変更の識別(標準 第5章 5.5.4 条件2・7 / 第4章 G-6) --------
//
// 委任の変更は、コミットのトレーラ `Delegated: <規則ID>` で変更単位に識別する。
// トレーラは行為した側の申告にすぎないため、該当は機械の規則(delegation.rules)と
// 変更したファイルの照合で判定する。規則は当該コミットの直前の構成から読む。
// コミット自身が足した規則で、自らを委任の範囲へ入れる経路を作らないためである。
//
// 独立レビュー(G-6)の判定の時点が事後へ移るのは、次の3つをすべて満たす変更に限る。
//   1. トレーラの規則に当たる(行為した席の委任の範囲)
//   2. 独立レビュアの席が委任を宣言しており、その席の規則にも当たる
//   3. PR のリスク区分が R3 と記録されている(R1・R2・未記入の変更は移さない)
// 開発者の席の規則だけでは、G-6 の承認は免除されない。
// トレーラ Delegated を持つ変更のリスク区分が R3 でない場合は、委任の範囲の逸脱である(第4章 G-6)。
// G-6 を事後へ移す変更で、開発者の席がその変更について協働である(開発者の席の規則に当たらない)場合は、
// 開発者の席の責任者(人)の承認を要する(第5章 5.5.6)。

const delegatedChanges = [];
for (const c of trailers) {
  if (!c.delegated) continue;
  const files = git(['show', '--name-only', '--format=', c.hash]).split('\n').filter(Boolean);
  const lines = sumNumstat(git(['show', '--numstat', '--format=', c.hash]));
  const cfg = configBefore(c.hash);
  // 規則の範囲に加えて、規則が有効に成立しているか(決定した者、AI維持管理者の承認、変更種別の登録)を確かめる。
  // マージの経路の判定(check-delegation)と同じ関数を使う
  const judged = classifyByRule(cfg, files, c.delegated, lines);
  const reviewer = classifyForSeat(cfg, files, REVIEWER_SEAT, lines);
  const developer = classifyForSeat(cfg, files, DEVELOPER_SEAT, lines);
  const m = commitPr.get(c.hash);
  const pr = m ? m.number : null;
  const direct = directChanges.find((d) => d.hash === c.hash);
  delegatedChanges.push({
    commit: c.hash.slice(0, 8),
    rule: c.delegated,
    pr,
    inScope: judged.rule !== null,
    problems: judged.reasons,
    reviewerRule: reviewer.rule,
    reviewerProblems: reviewer.reasons,
    // 開発者の席の規則。null なら、この変更について開発者の席は協働である
    developerRule: developer.rule,
    riskClass: pr ? (prByNumber.get(pr)?.riskClass ?? null) : (direct?.riskClass ?? null),
    exempt: direct?.exempt ?? null,
  });
}
for (const p of prs) {
  const own = delegatedChanges.filter((d) => d.pr === p.number);
  p.delegated = own.some((d) => d.inScope);
  // G-6 を事後の抜き取りへ移せない理由。空なら移す
  p.g6PostHocBlockers = [];
  if (p.delegated) {
    if (!own.some((d) => d.inScope && d.reviewerRule)) {
      p.g6PostHocBlockers.push(
        `独立レビュアの席の委任の範囲に当たらない(${own.flatMap((d) => d.reviewerProblems).slice(0, 2).join('。') || '規則なし'})`
      );
    }
    if (p.riskClass !== 'R3') p.g6PostHocBlockers.push(`リスク区分が R3 と記録されていない(記録: ${p.riskClass ?? '未記入'})`);
  }
  // 独立した人が事前に承認した変更は、事後へ移していない(開発者の席だけの委任を含む)
  p.g6PostHoc = p.delegated && p.g6PostHocBlockers.length === 0 && !p.g6.independentHuman;
  // 開発者の席がこの変更について協働か(G-6 を事後へ移す変更で、開発者の席の人の検証を要する)
  p.developerSeatCollab = p.g6PostHoc && !own.some((d) => d.inScope && d.developerRule);
}

// 例外承認の記録(標準 第7章 7.3)と変更の対応づけ。技術負債台帳の区分「例外」の行に限る(7.3 の記録の置き場)。
// 対応づくのは、次をすべて満たす行だけである(第4章 G-7 基準5)。
//   1. 「対象」の欄が、当該の変更(PR の番号、またはコミットの識別子の先頭7桁以上)を明示している。
//      他の欄に番号が現れるだけの行は対応づけない
//   2. 状態が有効を示す値(未返却・未回収・有効)と完全に一致する。返却済み・取り下げ・失効・不要になった行、
//      「未返却(…)」のように値を書き足した行は対応づけない
//   3. 承認した者の記名、理由(内容と受容した理由)、期限(返却の目安。日付として解釈できる値)が記入されている
//   4. 承認した者が名簿の人へ対応づき、その人が当該の変更の作成を指示した者でない。AI の名義でない。
//      記名は、氏名の空白・括弧書き・敬称、アカウントの @ の有無を正規化して照合する(文字列の完全一致で比べない)
//   5. 作成を指示した者が、全員名簿の人へ対応づく。1人でも対応づかない場合は、承認した者と別の人かを
//      確かめられないため、対応づけない(K73。PR を経ないコミットの、名簿に無い Author を含む)
// 承認した者が例外承認の権限を持つかは、機械では確かめない(内部監査で確かめる)
function exceptionMatch(refers, ins) {
  const matched = [];
  const rejected = [];
  for (const r of ledgerRows ?? []) {
    if (r.kind !== '例外') continue;
    if (r.target === null) {
      if (refers(r.text)) rejected.push(`${r.id}: 台帳に「対象」の欄が無い(旧い様式)。「対象」と「承認した者」の欄を足す`);
      continue;
    }
    if (!refers(r.target)) continue;
    const why = [];
    if (!ACTIVE_EXCEPTION_STATES.includes(r.state.replace(/\*/g, '').normalize('NFKC').trim())) {
      why.push(`状態が有効を示す値(${ACTIVE_EXCEPTION_STATES.join(' / ')})でない(${r.state || '未記入'})`);
    }
    if (!filled(r.approver)) why.push('承認した者が未記入');
    if (!filled(r.content) || (r.reason !== null && !filled(r.reason))) why.push('理由(内容・受容した理由)が未記入');
    if (!filled(r.due) || !dueDayOf(r.due)) why.push(`期限(返却の目安)が未記入、または日付として解釈できない(${r.due || '未記入'})`);
    if (filled(r.approver)) {
      if (aiNameBlocked(config, r.approver)) why.push('承認した者が AI の名義である');
      const p = resolveSigner(config, r.approver);
      if (!p) {
        why.push(`承認した者 "${r.approver}" が、人の名簿(people[])の人へ対応づかない(氏名・名簿の id・アカウントのいずれかで書く)`);
      } else {
        // 名簿に対応づかない指示者の記載も、同じ正規化で比べる(氏名・id・アカウントのいずれかが一致すれば同じ人)
        const keysOfP = new Set([p.id, p.name, ...(Array.isArray(p.accounts) ? p.accounts : [])].map((x) => signerKey(x)));
        if (ins.known.has(p.id) || ins.unresolved.some((u) => resolveSigner(config, u)?.id === p.id || keysOfP.has(signerKey(u)))) {
          why.push('承認した者が、作成を指示した者である');
        }
      }
    }
    if (ins.unresolved.length && !why.includes('承認した者が、作成を指示した者である')) {
      why.push(`作成を指示した者を名簿と対応づけられない(${ins.unresolved.join(' / ')})`);
    }
    if (why.length) rejected.push(`${r.id}: ${why.join('、')}`);
    else matched.push(`${debtFile} ${r.id}`);
  }
  return { matched, rejected };
}

// --- 突合と gaps -----------------------------------------------------------

const gaps = [];
const isActive = (key) => ['required', 'simplified'].includes(config.gates?.[key]?.state);
// G-6 を適用する体制(作成を指示した者以外の確認者を置ける体制)。未達・成立しない・省略の体制は含まない
const g6Applied = isActive('g6') && !g6Unmet && !reviewerIsDeveloper;

// 構成の整合(契約検査のうち、構成だけから確かめられる部分)。PR を経ない体制では、契約検査が走らないまま
// 出荷へ進む場合があるため、集約の時点でも確かめる(要約値の連鎖、回答と名簿の食い違いなど)
for (const p of configIntegrityProblems(config)) gaps.push(`構成の整合: ${p}`);

/**
 * 独立した人の確認を経ていない変更の扱い(第4章 G-7 基準5 の表)。
 *   G-6 を適用する体制: G-6 を事後へ移した変更を除き、記録の欠落。例外承認の記録が対応づけば欠落にしない(区分を問わない)
 *   G-6 が未達・成立しない・省略の体制: R1 の変更だけ、例外承認の記録を要する
 */
function exceptionNeeded(counted, postHoc, riskClass) {
  if (counted || postHoc) return false;
  return g6Applied || riskClass === 'R1';
}

for (const p of prs) {
  const needs = exceptionNeeded(p.g6.independent.counted, p.g6PostHoc, p.riskClass);
  const ex = needs ? exceptionMatch((text) => refersToPr(text, p.number), { known: new Map(p.g6.independent.instructors.map((n) => [personKey(config, n), n])), unresolved: p.g6.independent.unresolvedInstructors }) : { matched: [], rejected: [] };
  p.exceptionRecords = ex.matched;
  p.exceptionRejected = ex.rejected;
  if (!needs || ex.matched.length) continue;
  const rejected = ex.rejected.length ? `対応づけなかった例外の行: ${ex.rejected.join(' / ')}。` : '';
  if (g6Applied) {
    gaps.push(
      `PR #${p.number}: 独立した人の確認を経ていません(${p.g6.independent.reasonText})。G-6 を適用する体制では記録の欠落です` +
        (p.delegated ? `(委任の申告があるが、G-6 を事後へ移せない: ${p.g6PostHocBlockers.join(' / ')})` : '') +
        `。${rejected}独立した人(作成を指示した者でない、名簿の人)が、自分の挙動要約を付けて承認するか、G-6 の判定記録(「対象」に PR #${p.number}、判定者、挙動要約)を残してください。` +
        `確認を待てない場合は、例外承認の記録(技術負債台帳の区分「例外」の行。「対象」に PR #${p.number}、状態・承認した者・理由・期限を記入)を対応づけます(第7章 7.3)`
    );
  } else {
    gaps.push(
      `PR #${p.number}: リスク区分 R1 の変更が、独立した人の確認を経ていません(${p.g6.independent.reasonText})。` +
        `例外承認の記録(第7章 7.3)が対応づきません。${rejected}技術負債台帳の区分「例外」の行の「対象」へ「PR #${p.number}」を書き、状態(未返却)・承認した者・理由・期限を記入してください`
    );
  }
}

// 作成側の検証の記載(PR 本文「検証方法と結果」)。開発者(検証)の席の記録であり、独立レビュー(G-6)の
// 成立とは別である。G-6 の状態に依らず、無ければ欠落とする。独立した人の確認が無い体制ほど、
// この記載が唯一の証拠になる(標準 第5章 5.5.6)。開発者の席の委任の範囲の変更では、担い手が実行結果の証拠として書く。
// 人確定・協働の変更では、人が書く。誰が書いたかは、機械では確かめない
for (const p of prs) {
  if (p.authorVerificationPresent) continue;
  gaps.push(
    `PR #${p.number}: 作成側の検証の記載(PR 本文「検証方法と結果」)がありません` +
      (p.delegated ? '。開発者の席の委任の範囲の変更では、担い手が実行結果の証拠として書きます' : '')
  );
}

// G-6 を事後へ移す委任で、開発者の席がその変更について協働である場合は、開発者の席の人による検証が変更ごとに要る
// (標準 第4章 G-6 / 第5章 5.5.6)。記録は、開発者の席の責任者(人)の承認である
for (const p of prs) {
  if (!p.developerSeatCollab || p.developerApproved) continue;
  gaps.push(
    `PR #${p.number}: G-6 を事後へ移した委任の変更ですが、開発者の席はこの変更について協働です(開発者の席の規則に当たらない)。` +
      '開発者の席の責任者(人)による検証の記録(PR の承認)がありません(第5章 5.5.6)'
  );
}

// リスク区分は、変更ごとに確定する記録である(標準 第3章 3.8.1)。未記入は記録の欠落として扱う。
// 独立した人の確認の有無にはよらない。選択肢を残したままの欄も未記入である
for (const p of prs) {
  if (p.riskClass) continue;
  gaps.push(`PR #${p.number}: リスク区分が未記入です(選択肢を残したままの欄は未記入として扱います)。リスク区分は変更ごとに確定する記録です(第3章 3.8.1)`);
}

// PR を経ていないコミット。区分はトレーラ Risk から読む
for (const d of directProduct) {
  // トレーラを書き忘れたコミットは、履歴を書き換えずに、判定記録で区分を確定できる。
  // 判定記録の「対象」がコミットの識別子(先頭7桁以上)を指し、「変更のリスク区分」が1つに定まっていること
  d.riskClassSource = d.riskClass ? 'trailer' : null;
  if (!d.riskClass) {
    const rec = gateDetails.find((g) => g.riskClass && commitRefers(d.hash)(g.target));
    if (rec) {
      d.riskClass = rec.riskClass;
      d.riskClassSource = rec.file;
    }
  }
  // 検証の記載(トレーラ Verification)を書き忘れたコミットも、判定記録で補える。判定記録の「対象」が
  // コミットの識別子を指し、「検証方法と結果」の欄または節に記載があること
  d.authorVerificationSource = d.authorVerificationPresent ? 'trailer' : null;
  if (!d.authorVerificationPresent) {
    const rec = gateDetails.find((g) => g.authorVerificationPresent && commitRefers(d.hash)(g.target));
    if (rec) {
      d.authorVerificationPresent = true;
      d.authorVerificationSource = rec.file;
    }
  }
  const claimed = d.claimedPr ? `${d.claimedPr.why}。` : '';
  if (!d.authorVerificationPresent) {
    gaps.push(
      `コミット ${d.commit}: ${claimed}PR を経ていないコミットに、作成側の検証の記載(トレーラ Verification: <実行した検証と結果の要点、または証跡の所在>)がありません。` +
        `成立済みのコミットは書き換えず、判定記録(docs/gates)の「対象」へコミットの識別子 ${d.commit.slice(0, 7)} を、「検証方法と結果」の欄へ記載を書いてください`
    );
  }
  if (!d.riskClass) {
    gaps.push(
      `コミット ${d.commit}: ${claimed}PR を経ていないコミットに、リスク区分のトレーラ(Risk: R1 / R2 / R3 のいずれか)がありません(${d.notExemptBecause[0]})。` +
        'リスク区分は変更ごとに確定する記録です(第3章 3.8.1)。成立済みのコミットは書き換えず、判定記録(docs/gates)の「対象」へ' +
        `コミットの識別子 ${d.commit.slice(0, 7)} を、「変更のリスク区分」へ区分を書いて確定してください`
    );
  }
  const needs = exceptionNeeded(d.independent.counted, false, d.riskClass);
  const ex = needs ? exceptionMatch(commitRefers(d.hash), { known: new Map(d.independent.instructors.map((n) => [personKey(config, n), n])), unresolved: d.independent.unresolvedInstructors }) : { matched: [], rejected: [] };
  d.exceptionRecords = ex.matched;
  d.exceptionRejected = ex.rejected;
  if (!needs || ex.matched.length) continue;
  const rejected = ex.rejected.length ? `対応づけなかった例外の行: ${ex.rejected.join(' / ')}。` : '';
  gaps.push(
    g6Applied
      ? `コミット ${d.commit}: ${claimed}PR を経ておらず、独立した人の確認を経ていません。G-6 を適用する体制では記録の欠落です。${rejected}` +
          `独立した人が確認し、G-6 の判定記録(「対象」にコミットの識別子 ${d.commit.slice(0, 7)}、判定者、挙動要約)を残すか、` +
          `例外承認の記録(技術負債台帳の区分「例外」の行。「対象」にコミットの識別子、状態・承認した者・理由・期限を記入)を対応づけてください(第7章 7.3)`
      : `コミット ${d.commit}: リスク区分 R1 の変更が、PR を経ておらず、独立した人の確認を経ていません。例外承認の記録(第7章 7.3)が対応づきません。${rejected}` +
          `技術負債台帳の区分「例外」の行の「対象」へ、コミットの識別子 ${d.commit.slice(0, 7)} を書き、状態(未返却)・承認した者・理由・期限を記入してください`
  );
}

// 即時通知(標準 第3章 3.13.6)の通知先と通知日が未記入の変化点
for (const n of pendingNotices(config)) {
  gaps.push(
    `changeLog[${n.index}](${String(n.date ?? '').slice(0, 10)} ${n.kind}): 出荷判定者の席の責任者への即時通知の、通知先と通知日が未記入です` +
      `${n.reasons.length ? `(${n.reasons.join(' / ')})` : ''}。/process-change で通知の記録を追記してください(第3章 3.13.6)`
  );
}
// 出荷できない状態(CL1 以上・規制業で体制が3名を割った)。出荷の判定を通さない
if (config.shipBlocked) gaps.push(`出荷できない状態です(${config.shipBlocked.since} から): ${config.shipBlocked.reason}`);

// 責任者が未記入の席は、誰が結果責任を負うかを示せない。記録の欠落として扱う(D-0 節1)
const blankSeats = (config.seats ?? []).filter((s) => !s.accountable).map((s) => s.name ?? s.role);
if (blankSeats.length) gaps.push(`責任者が未記入の席があります: ${blankSeats.join(' / ')}`);
for (const d of delegatedChanges) {
  if (d.exempt) continue;
  if (!d.inScope) {
    gaps.push(
      `コミット ${d.commit}: 委任の範囲の逸脱です(Delegated: ${d.rule})。${d.problems.join('。')}。` +
        '該当の範囲を協働へ引き下げ、人の判定を受けてください'
    );
  } else if (d.riskClass !== 'R3') {
    // 委任の識別を持つ変更は R3 に限る(第4章 G-6「委任の識別を持つ変更が R3 でない場合」)
    gaps.push(
      `コミット ${d.commit}${d.pr ? `(PR #${d.pr})` : ''}: 委任の範囲の逸脱です(Delegated: ${d.rule})。委任の識別を持つ変更のリスク区分が R3 でない(記録: ${d.riskClass ?? '未記入'})。` +
        '委任の範囲に入れられるのは R3 の変更だけです。該当の範囲を協働へ引き下げ、人の判定を受けてください'
    );
  }
}

// 判定記録が参照する D-0 の版と、判定の時点で構成が追随していた版のずれ(標準 第3章 3.13.5)。
// 成立済みの判定記録は書き換えないため、変化点より前の記録は当時の版を正とする
//
// 変化点の記録が時刻帯つきの時刻(at。ISO 8601、オフセットつき)を持つ場合は、その手元の日付と時刻で比べる。
// 持たない旧い記録は、日付(date)で比べる。判定記録の側が日付だけの場合、または同じ日の変化点の時刻が
// 分からない場合は、その日のどの時点かで成り立つ版(その日の開始時点の版と、その日に改訂された版)を
// 参照していれば一致とする。判定記録の時刻は、変化点の記録と同じ時刻帯で書かれたものとして比べる。
// 並びは changeLog[] の順(追記だけであり、時系列である)を使う
const d0Timeline = (config.changeLog ?? [])
  .filter((e) => e.d0After)
  .map((e) => ({
    day: changeDay(e),
    // 手元の日付と時刻(分まで)。時刻を持たない記録は null
    local: typeof e.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.at) ? e.at.slice(0, 16) : null,
    version: String(e.d0After),
    before: e.d0Before ? String(e.d0Before) : null,
  }));
const recordsWithoutD0 = [];
for (const r of gateRecordList) {
  if (!r.d0Version) {
    recordsWithoutD0.push(r.file);
    continue;
  }
  const judged = (r.judgedAt ?? '').trim();
  const day = judged.slice(0, 10);
  const time = judged.match(/^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/)?.[1] ?? null;
  const at = time ? `${day}T${time}` : null;
  // 判定の時点との前後。同じ日で、どちらかの時刻が分からない場合と、同じ分の場合は、前後を決めない
  const order = (e) => {
    if (e.day !== day) return e.day < day ? 'before' : 'after';
    if (!at || !e.local || e.local === at) return 'same-day';
    return e.local < at ? 'before' : 'after';
  };
  const accepted = new Set();
  const past = d0Timeline.filter((e) => order(e) === 'before');
  if (past.length) accepted.add(past[past.length - 1].version);
  for (const e of d0Timeline) {
    if (order(e) !== 'same-day') continue;
    accepted.add(e.version);
    if (e.before) accepted.add(e.before);
  }
  const following = d0Timeline.filter((e) => order(e) === 'after');
  // 判定より後の変化点が無ければ、現在の版が判定の時点の版である。後の変化点があれば、その直前の版
  if (!following.length && config.d0Version) accepted.add(String(config.d0Version));
  else if (following.length && !past.length && following[0].before) accepted.add(following[0].before);
  if (day && accepted.size && !accepted.has(r.d0Version)) {
    gaps.push(
      `${r.file}: 参照した D-0 の版(${r.d0Version})が、判定の時点の版(${[...accepted].join(' / ')})と一致しません。` +
        '体制の変化点の後は、改訂後の D-0 を参照して判定します'
    );
  }
}
for (const p of prs) {
  if (p.g5 !== 'success' && p.g5 !== 'unknown') gaps.push(`PR #${p.number}: gate-g5 が ${p.g5} です`);
}

// G-7 基準5: 変更が仕様(トレーラ Spec: F-NNN)を指す場合、その仕様の機能仕様承認(G-4)の判定記録が要る。
// 判定記録はリポジトリの全体から探す(仕様の承認は、当該出荷より前のことがある)。結果が通過のものに限る
const specChanges = [
  ...prs.map((p) => ({ label: `PR #${p.number}`, specs: p.specs })),
  ...directProduct.map((d) => ({ label: `コミット ${d.commit}`, specs: d.specs })),
];
const g4Approved = (spec) =>
  // 対応は判定記録の「対象」欄が仕様の ID を指していることで確かめる。ファイル名だけでは対応づけない
  gateDetails.some((g) => /G-4/.test(g.gate ?? '') && passed(g) && new RegExp(`(?<![A-Za-z0-9])${spec}(?!\\d)`).test(String(g.target ?? '')));
const specsWithoutG4 = isActive('g4') ? [...new Set(specChanges.flatMap((c) => c.specs))].filter((s) => !g4Approved(s)) : [];
for (const s of specsWithoutG4) {
  gaps.push(
    `仕様 ${s}: 変更(${specChanges.filter((c) => c.specs.includes(s)).map((c) => c.label).join(', ')})がトレーラ Spec で指す仕様に、` +
      '機能仕様承認(G-4)の判定記録(結果が通過で、「対象」に仕様の識別子)がありません(第4章 G-7 基準5)'
  );
}

if (!period && config.gates.g7?.state !== 'omitted') {
  if (!exists(handoverFile)) gaps.push('運用引き継ぎ文書(docs/handover.md)がありません');
  if (!exists(debtFile)) gaps.push('技術負債台帳(docs/debt-ledger.md)がありません');
  // 判定記録の有無は、当該出荷の範囲のものだけを見る。過去の出荷の1件で通さない
  if (!records.length) {
    gaps.push(
      from
        ? `当該出荷の範囲(${range})で追加されたゲート判定記録(docs/gates/)が1件もありません。過去の出荷の記録は、今回の出荷の記録に数えません`
        : 'ゲート判定記録(docs/gates/)が1件もありません'
    );
  }
}

// リリース決裁(G-8)の決断の記録の「出荷判定者の異議」欄。空欄は記載の欠落である(標準 第4章 G-8)。
// 出荷の範囲では、当該出荷の範囲で追加された G-8 の記録と、「対象」が今回の終点を指す G-8 の記録を対象にする。
// 今回の出荷の G-8 の記録は、集約の後に書かれる。記録を書いた後に集約し直すと、ここで検査される。
// 期間の指定では、「対象」が期間(起点〜終点)を指す G-8 の記録を対象にする(期間の開示への受容と異議)。
// 「対象」に書かれた日付が起点と終点の2つだけで、その間が期間を表す区切り(〜、~、-、から、..)である記録に限る。
// 2つの日付を別の文脈で含むだけの記録(「2026-09-01 と 2026-09-30 の障害」など)は対応づけない
const PERIOD_SEP = /^\s*(〜|～|~|-|–|—|から|\.\.|to)\s*$/i;
function periodTarget(g) {
  if (!period) return false;
  const text = String(g.target ?? '').normalize('NFKC');
  const dates = [...text.matchAll(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g)];
  if (dates.length !== 2) return false;
  const day = (m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (day(dates[0]) !== period.from || day(dates[1]) !== period.to) return false;
  return PERIOD_SEP.test(text.slice(dates[0].index + dates[0][0].length, dates[1].index));
}
const g8All = gateDetails.filter((g) => /G-8/.test(g.gate ?? ''));
const g8Records = g8All.filter((g) =>
  period ? periodTarget(g) : !recordsInRange || recordsInRange.has(g.file) || (to !== 'HEAD' && (g.target ?? '').includes(to))
);
if (period && !g8Records.length) {
  const near = g8All.filter((g) => String(g.target ?? '').includes(period.from) && String(g.target ?? '').includes(period.to)).map((g) => g.file);
  gaps.push(
    `期間の開示(${period.from}〜${period.to})に対応する受容と異議の記録がありません。リリース決裁(G-8)の判定記録(テンプレ4)の「対象」へ、` +
      `期間を「${period.from}〜${period.to}」の形で書き、事業決裁者の受容と出荷判定者の異議を記録してください(第4章 G-8)。記録を書いた後に、同じ期間で集約し直すと検査を通ります` +
      (near.length ? `。起点と終点の日付を含むが、期間の形で書かれていない記録: ${near.join(', ')}` : '')
  );
}
// 期間の G-8 記録は、判定者の記名(名簿の人。AI の名義でない)・判定の結果・対象の期間を確かめる。
// 結果が差し戻しの記録は、期間の開示を受容していない
if (period) {
  for (const g of g8Records) {
    const judgeProblems = g.judge ? nameProblems(config, g.judge, { requireRoster: true }) : ['記名がない'];
    if (judgeProblems.length) gaps.push(`${g.file}: 期間の G-8 の記録の判定者を受け付けられません(${judgeProblems.join('。')})`);
    const result = String(g.result ?? '').replace(/\*/g, '').trim();
    if (/^差し戻し/.test(result)) {
      gaps.push(`${g.file}: 期間の G-8 の記録の結果が差し戻しです。期間の開示(${period.from}〜${period.to})は受容されていません`);
    } else if (!/^通過/.test(result)) {
      gaps.push(`${g.file}: 期間の G-8 の記録の結果が未記入、または判定の値(通過 / 差し戻し)でありません(${result || '未記入'})`);
    }
  }
}
for (const g of g8Records) {
  if (g.objection) continue;
  gaps.push(
    `${g.file}: リリース決裁(G-8)の決断の記録の「出荷判定者の異議」欄が${g.objectionRowPresent ? '空欄です' : 'ありません'}。` +
      '記載の欠落です。出荷判定者が記載します。異議が無い場合も「異議なし」と書きます'
  );
}
if (!period && !licenseScan.scanRun) {
  gaps.push('知財潔白性の検査記録がありません。判定するのは検査を実施し記録したことです');
}


// --- 未達(隠す経路を持たない) --------------------------------------------

const unmet = (config.unmet ?? []).map((u) => ({
  gate: u.gate,
  label: u.label ?? u.gate,
  reason: u.reason,
  compensation: u.compensation ?? [],
  reviewSourcing: u.reviewSourcing ?? null,
}));

// --- 代償措置つきの逸脱(未達と区別して載せる) ------------------------------

const deviations = (config.deviations ?? []).map((d) => ({
  gate: d.gate,
  label: d.label ?? d.gate,
  rule: d.rule ?? null,
  reason: d.reason,
  compensation: d.compensation ?? [],
  resolveWhen: d.resolveWhen ?? null,
}));

// --- 保証の開示(G-7 基準9。標準 第4章 G-7 / 附属書H H.6) -------------------
//
// 7項目を構成と既存の記録から機械的に導く。要約と評価を値にしない。
// 導けない項目は「未測定」「記録なし」を値として出し、空欄にしない。

const NO_RECORD = '記録なし';
const UNMEASURED = '未測定';
const sep = seatSeparationFindings(config);
const count = (list, pred) => list.filter(pred).length;

// 前回の出荷の出力。項目1・3・6 へ前回の値を併記する(標準 第4章 G-7 基準9 / 附属書H H.6)。
// 併記するのは値だけで、良否の評価は付けない
const NO_PREVIOUS = '前回なし';
function loadPrevious() {
  const tryParse = (text) => {
    try {
      const j = JSON.parse(text);
      return j?.assurance ? j : null;
    } catch {
      return null;
    }
  };
  const readFile = (p) => (fs.existsSync(p) ? tryParse(fs.readFileSync(p, 'utf8')) : null);
  const explicit = arg('--previous', null);
  if (explicit) return readFile(path.resolve(explicit));
  // 期間の指定では、前回の期間の出力を自動では探さない(出荷の出力と取り違えないため)
  if (period) return null;
  const placed = readFile(path.join(ROOT, 'evidence/previous/evidence.json'));
  if (placed) return placed;
  if (from) {
    const committed = tryParse(git(['show', `${from}:evidence/evidence.json`]));
    if (committed) return committed;
    const onDisk = readFile(path.join(ROOT, 'evidence/evidence.json'));
    if (onDisk?.range?.to === from) return onDisk;
  }
  return null;
}
const previous = loadPrevious();
const prevA = previous?.assurance ?? null;
const prevLabel = previous ? `前回 ${previous.range?.to ?? '(終点の記録なし)'}` : NO_PREVIOUS;
/** 前回の値を取り出して文字列にする。前回の出力が無い、または当該の値を持たない場合は「前回なし」 */
const prev = (pick) => {
  if (!prevA) return NO_PREVIOUS;
  try {
    const v = pick(prevA);
    return v === undefined || v === null ? `${prevLabel}: 値なし` : `${prevLabel}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
  } catch {
    return `${prevLabel}: 値なし`;
  }
};

// 1. 体制と独立性の成立状況
const g7Deviation = (config.deviations ?? []).find((d) => d.gate === 'g7');
const omittedText = (key) => `省略(${config.gates[key]?.state}。テーラリングの宣言による)`;
const small = config.answers?.['q-team-size'] === 'size-1-2';
const roster = config.people ?? [];

// G-6 の区分: 成立 / 外部依頼 / 未達 / 成立しない / 省略。事後の抜き取りは別の行で件数を出す
let g6Status;
if (g6Unmet) {
  g6Status = g6Unmet.reviewSourcing
    ? `未達(確認者の調達先: ${g6Unmet.reviewSourcing}。調達先の記入は未達を解消しない)`
    : '未達(確認者の調達先は未記入)';
} else if (!isActive('g6')) g6Status = omittedText('g6');
else if (seats.length && !whoKey('independent-reviewer')) g6Status = '成立を確認できない(独立レビュアの席の責任者が未記入)';
else if (whoKey('independent-reviewer') && whoKey('independent-reviewer') === whoKey('dev-verifier')) {
  g6Status = `成立しない(責任者が同一: ${whoName('dev-verifier')}。AI を何体に分けても独立は成立しない)`;
} else if (findPerson(config, seatOf('independent-reviewer')?.accountable)?.external) {
  g6Status = `外部依頼(独立レビュアの席の責任者が外部の確認者: ${whoName('independent-reviewer')}。変更ごとの実施は件数による)`;
} else if (small) g6Status = '成立(相互。作成を指示していない側の人が確認する。構成上。変更ごとの実施は件数による)';
else g6Status = '成立(構成上。変更ごとの実施は件数による)';

let g7Status;
if (g7Deviation) g7Status = `兼務(代償措置: ${(g7Deviation.compensation ?? []).join(' / ')})`;
else if (!isActive('g7')) g7Status = omittedText('g7');
else if (seats.length && !whoKey('qa-gatekeeper')) g7Status = '成立を確認できない(出荷判定者の席の責任者が未記入)';
else if (whoKey('qa-gatekeeper') && whoKey('qa-gatekeeper') === whoKey('dev-verifier')) g7Status =`成立しない(責任者が同一: ${whoName('dev-verifier')})`;
else g7Status = '成立(構成上。変更ごとの実施は件数による)';

// 変更の一覧(PR と、PR を経ていないコミット)。独立した人の確認の有無を、同じ条件で数える
const directCommits = directProduct.length;
const knownPrs = prs;
const changeUnits = [
  ...prs.map((p) => ({ label: `#${p.number}`, independent: p.g6.independent, riskClass: p.riskClass, postHoc: p.g6PostHoc, exceptionRecords: p.exceptionRecords ?? [] })),
  ...directProduct.map((d) => ({ label: `コミット ${d.commit}`, independent: d.independent, riskClass: d.riskClass, postHoc: false, exceptionRecords: d.exceptionRecords ?? [] })),
];
const changesTotal = changeUnits.length;
// マージコミットを取得できず、PR の変更と認めなかったコミット。PR を経ていないコミットに数えている
const approvalRecordNotFound = count(directProduct, (d) => Boolean(d.claimedPr));
// 独立した人の確認に数えるのは、第4章 G-6 の4条件を満たす承認を持つ変更だけである。数えない理由ごとに件数を出す
const unconfirmedBy = (reason) => count(prs, (p) => p.g6.independent.reason === reason);
const unconfirmed = {
  noApproval: unconfirmedBy('noApproval'),
  aiOrBot: unconfirmedBy('aiOrBot'),
  approverUnmapped: unconfirmedBy('approverUnmapped'),
  approverIsInstructor: unconfirmedBy('approverIsInstructor'),
  structure: unconfirmedBy('structure'),
  instructorUnresolved: unconfirmedBy('instructorUnresolved'),
  noReviewerSummary: unconfirmedBy('noReviewerSummary'),
  recordNotFound: approvalRecordNotFound,
  directCommits: count(directProduct, (d) => !d.independent.counted),
};
const confirmedUnits = changeUnits.filter((c) => c.independent.counted);
const confirmedPrs = prs.filter((p) => p.g6.independent.counted);
const withoutIndependentHuman = changesTotal - confirmedUnits.length;
const identityUnconfirmed = unconfirmed.approverUnmapped + unconfirmed.instructorUnresolved;
// 委任の変更は、変更の単位(PR、または PR を経ていないコミット)で数える。マージコミットの方式で取り込んだ
// 複数のコミットが同じ規則を申告しても、1件である
const delegatedUnits = [...new Map(delegatedChanges.filter((d) => !d.exempt).map((d) => [d.pr ? `pr:${d.pr}` : `c:${d.commit}`, d])).keys()].map((key) => {
  const own = delegatedChanges.filter((d) => (d.pr ? `pr:${d.pr}` : `c:${d.commit}`) === key);
  const p = own[0].pr ? prByNumber.get(own[0].pr) : null;
  const direct = own[0].pr ? null : directProduct.find((x) => x.commit === own[0].commit);
  return {
    inScope: own.some((d) => d.inScope),
    counted: Boolean(p ? p.g6.independent.counted : direct?.independent?.counted),
    postHoc: Boolean(p?.g6PostHoc),
  };
});
const inScopeDelegated = count(delegatedUnits, (d) => d.inScope);
// トレーラ Delegated は、変更ごとの検証を担い手へ委ねたことの識別である。独立した人が事前に承認した変更
// (開発者の席だけの委任)は、独立した人の確認を経た変更に数える
const delegatedWithHuman = count(delegatedUnits, (d) => d.inScope && d.counted);
// 独立した人の事前の承認が無い委任の変更。「人の事前確認を経ていない変更」と呼ぶのは、このうち
// G-6 の判定を事後へ移した変更だけである(第4章 G-7 保証の開示)。それ以外は、独立した人の確認を経ていない変更である
const delegatedWithoutPriorHuman = inScopeDelegated - delegatedWithHuman;
const delegatedPostHoc = count(delegatedUnits, (d) => d.inScope && d.postHoc);
const g6PostHoc = count(prs, (p) => p.g6PostHoc);
const STATEMENT = '本成果物は、作成を指示した者から独立した人による確認を経ていません。';
// 未確認が1件でもあれば、定型の文を出す(標準 附属書H H.6)
let statement = null;
if (changesTotal && withoutIndependentHuman === changesTotal) statement = STATEMENT;
else if (withoutIndependentHuman) {
  statement = `本${period ? '期間' : 'リリース'}の変更 ${changesTotal} 件のうち ${withoutIndependentHuman} 件は、作成を指示した者から独立した人による確認を経ていません。`;
} else if (!changesTotal && g6Unmet) statement = STATEMENT;
if (statement && identityUnconfirmed) {
  statement += `(うち ${identityUnconfirmed} 件は、承認者または作成を指示した者を名簿と対応づけられず、未確認に数えています)`;
}

// R1 の変更のうち、独立した人の確認を経ていないもの。変更ごとに例外承認の記録を要する
const r1Unconfirmed = changeUnits.filter((c) => c.riskClass === 'R1' && !c.independent.counted).map((c) => ({ label: c.label, exceptionRecords: c.exceptionRecords }));
// 例外承認の記録が対応づいたことで、欠落として扱わなかった変更(区分を問わない)。項目5 へ未回収の例外として載せる
const exceptedChanges = changeUnits.filter((c) => c.exceptionRecords.length).map((c) => ({ label: c.label, riskClass: c.riskClass, records: c.exceptionRecords }));
// リスク区分が未記入で、独立した人の確認を経ていない変更。R1 かどうかを機械で判定できない
const unclassifiedUnconfirmed = count(changeUnits, (c) => !c.riskClass && !c.independent.counted);

// レビュアの挙動要約(G-6 基準2)。挙動要約を伴わない承認は、独立した人の確認に数えていない
const withoutBehaviorSummary = prs.filter((p) => p.g6.independent.reason === 'noReviewerSummary').map((p) => p.number);

// 事後の抜き取りを、作成を指示した本人が行う体制か。本人による抜き取りは独立した確認に数えない
const samplerIsAuthor = Boolean(g6Unmet) || reviewerIsDeveloper;
const seatDeviationLabels = (config.deviations ?? []).filter((d) => !d.gate).map((d) => d.label);
// 出荷判定者の席と事業決裁者の席の責任者が同一人物か。異議を書く者と、残存リスクを受容する者が同一になる(第4章 G-8)
const objectionSelfAccepted = Boolean(whoKey('qa-gatekeeper')) && whoKey('qa-gatekeeper') === whoKey('biz-approver');

const independence = {
  g6: g6Status,
  g6PostHocSampling: g6PostHoc
    ? `G-6 を事後の抜き取りへ移した変更 ${g6PostHoc} 件` +
      (samplerIsAuthor ? '(抜き取りは責任者本人が実施する。独立した確認に数えない)' : '(独立レビュアの席の責任者が事後に抜き取る)')
    : 'なし',
  g7: g7Status,
  sameAccountable: sep.notIndependent,
  separationDeviations: seatDeviationLabels,
  seatsWithoutAccountable: sep.blank,
  // 異議を書く者(出荷判定者)と、残存リスクを受容する者(事業決裁者)が同一人物か
  objectionSelfAccepted,
  rosterPresent: roster.length > 0,
  nameOverrides: nameOverrides(config),
  changes: {
    total: changesTotal,
    withoutIndependentHuman,
    approvalRecordNotFound,
    // 独立した人の確認に数えなかった理由ごとの件数(1件の変更は1つの理由に数える)
    unconfirmed,
    approverNotInRoster: unconfirmed.approverUnmapped,
    withoutReviewerSummary: withoutBehaviorSummary.length,
    r1WithoutException: count(r1Unconfirmed, (p) => !p.exceptionRecords.length),
    // 数えた変更のうち、作成を指示した者を既定値(PR の作成者と開発者の席の責任者)で判定した件数
    instructorsByDefault: count(confirmedUnits, (c) => c.independent.instructorsByDefault),
    // 数えた変更のうち、承認した者に独立レビュアの席の責任者が含まれる件数と、含まれない件数(欠落にはしない)
    byReviewerSeat: count(confirmedUnits, (c) => c.independent.byReviewerSeat),
    notByReviewerSeat: count(confirmedUnits, (c) => !c.independent.byReviewerSeat),
    // 承認の後に同じ人が変更要求を出し、取り下げた承認を持つ PR の件数
    withdrawnApprovals: count(prs, (p) => (p.g6.withdrawnApprovals ?? 0) > 0),
  },
  accountsRegistered: roster.some((p) => Array.isArray(p?.accounts) && p.accounts.length > 0),
  // R1 の変更を、独立した人の確認を経ないまま出荷する場合の例外承認(変更ごと)
  r1WithoutIndependentHuman: {
    total: r1Unconfirmed.length,
    withExceptionRecord: count(r1Unconfirmed, (p) => p.exceptionRecords.length > 0),
    withoutExceptionRecord: r1Unconfirmed.filter((p) => !p.exceptionRecords.length).map((p) => p.label),
  },
  unclassifiedWithoutIndependentHuman: unclassifiedUnconfirmed,
  // レビュアの挙動要約(G-6 基準2)。挙動要約を伴わない承認は数えない
  reviewerSummary: {
    confirmedChanges: confirmedUnits.length,
    present: confirmedUnits.length,
    absent: withoutBehaviorSummary,
  },
  statement,
  previous: prevA
    ? {
        release: previous.range?.to ?? null,
        g6: prevA.independence?.g6 ?? null,
        g7: prevA.independence?.g7 ?? null,
        changes: prevA.independence?.changes ?? null,
      }
    : NO_PREVIOUS,
};

// 2. テーラリングの宣言(外した項目と理由)
const STATE_TEXT = { simplified: '簡略化', omitted: '省略', unmet: '未達' };
const tailoring = Object.values(config.gates)
  .filter((g) => g.state !== 'required')
  .map((g) => ({ label: g.label, state: STATE_TEXT[g.state] ?? `統合(${g.state})`, why: g.why ?? [] }));
if (config.guard?.enabled === false) {
  tailoring.push({
    label: '強制層の書き込み遮断',
    state: `一時緩和(期限 ${config.guard.reviewBy ?? '未記入'})`,
    why: [config.guard.reason ?? '理由は未記入'],
  });
}

// 3. リスク区分ごとの変更の件数と、確定の形態の内訳
// リスク区分を確定した者の記名(判定記録)。「自己記載」と AI の名義は、確定した者の記名に数えない
const riskConfirmed = count(records, (r) => r.riskConfirmedBy && !/自己記載/.test(r.riskConfirmedBy) && !aiNameBlocked(config, r.riskConfirmedBy));
const byClass = (k) => {
  const own = knownPrs.filter((p) => (k === 'notRecorded' ? !p.riskClass : p.riskClass === k));
  return {
    total: own.length,
    withIndependentHuman: count(own, (p) => p.g6.independent.counted),
    withBehaviorSummary: count(own, (p) => p.g6.independentHuman && p.g6.reviewerSummaryPresent),
    g6PostHoc: count(own, (p) => p.g6PostHoc),
  };
};
const changeCounts = {
  byRiskClass: knownPrs.length
    ? {
        R1: count(knownPrs, (p) => p.riskClass === 'R1'),
        R2: count(knownPrs, (p) => p.riskClass === 'R2'),
        R3: count(knownPrs, (p) => p.riskClass === 'R3'),
        notRecorded: count(knownPrs, (p) => !p.riskClass),
      }
    : NO_RECORD,
  byRiskClassDetail: knownPrs.length
    ? { R1: byClass('R1'), R2: byClass('R2'), R3: byClass('R3'), notRecorded: byClass('notRecorded') }
    : NO_RECORD,
  // 区分の出所。低い区分への自己記載で、人の確認を経ない変更が増える経路を見えるようにする
  riskClassSource: riskConfirmed
    ? `区分を確定した者の記名がある判定記録 ${riskConfirmed} 件。それ以外の変更の区分は、PR 本文の自己記載に依る(PR と判定記録の突合はしていない)`
    : 'PR 本文の自己記載だけに依る。区分を確定した者の記名は無い',
  riskClassConfirmedRecords: riskConfirmed,
  byMode: records.length
    ? {
        human: count(records, (r) => r.mode === MODE_LABEL.human),
        collab: count(records, (r) => r.mode === MODE_LABEL.collab),
        delegatedPostHoc: count(records, (r) => r.mode === MODE_LABEL.delegated),
        notRecorded: count(records, (r) => !Object.values(MODE_LABEL).includes(r.mode)),
      }
    : NO_RECORD,
  // inScope: トレーラ Delegated で識別した、規則の範囲の変更(変更ごとの検証を担い手へ委ねた)
  // withIndependentHuman: うち、独立した人が事前に承認した変更(開発者の席だけの委任など)
  // withoutPriorHuman: うち、独立した人の事前の承認が無い委任の変更。内訳は withoutPriorHumanBreakdown
  //   g6PostHoc: G-6 の判定を事後へ移した変更(「人の事前確認を経ていない変更」はこれだけを指す)
  //   other: それ以外。独立した人の確認を経ていない変更である(G-6 を適用する体制では記録の欠落)
  delegated: {
    inScope: inScopeDelegated,
    withIndependentHuman: delegatedWithHuman,
    withoutPriorHuman: delegatedWithoutPriorHuman,
    withoutPriorHumanBreakdown: { g6PostHoc: delegatedPostHoc, other: delegatedWithoutPriorHuman - delegatedPostHoc },
    outOfScope: delegatedUnits.length - inScopeDelegated,
    g6PostHoc,
  },
  // PR を経ていないコミット。区分はトレーラ Risk による。exempt は、リスク区分の対象外にしたコミット
  directCommits: {
    total: directChanges.length,
    R1: count(directProduct, (d) => d.riskClass === 'R1'),
    R2: count(directProduct, (d) => d.riskClass === 'R2'),
    R3: count(directProduct, (d) => d.riskClass === 'R3'),
    notRecorded: count(directProduct, (d) => !d.riskClass),
    exempt: {
      recordOnly: count(directChanges, (d) => d.exempt === 'record-only'),
      empty: count(directChanges, (d) => d.exempt === 'empty'),
    },
  },
  gateRecordsWithoutD0Version: recordsWithoutD0.length,
  previous: prevA
    ? {
        release: previous.range?.to ?? null,
        byRiskClass: prevA.changes?.byRiskClass ?? null,
        byMode: prevA.changes?.byMode ?? null,
        delegated: prevA.changes?.delegated ?? null,
      }
    : NO_PREVIOUS,
};

// 4. 機械検査の結果。未実施と通過を区別する
let adapter = null;
try {
  adapter = loadAdapter(config);
} catch {
  adapter = null;
}
const phase = (name) => {
  if (!adapter) return NO_RECORD;
  if (!hasTarget(adapter)) return '未実施(検査対象が存在しない)';
  return (adapter.commands?.[name] ?? '').trim() ? '実施(結果は gate-g5 に含む)' : '未実施(コマンドが未設定)';
};
const machineChecks = {
  gateG5: prs.length
    ? {
        success: count(prs, (p) => p.g5 === 'success'),
        notSuccess: count(prs, (p) => p.g5 !== 'success' && p.g5 !== 'unknown'),
        notRecorded: count(prs, (p) => p.g5 === 'unknown'),
      }
    : NO_RECORD,
  test: phase('test'),
  coverage: coverage.measured ? `実施(${coverage.pct}% / 下限 ${coverage.threshold}%)` : `${UNMEASURED}(${coverage.reason})`,
  staticAnalysis: phase('lint'),
  dependencyAudit: phase('audit'),
  licenses: licenseScan.scanRun ? `実施(${licenseScan.result ?? '結果の記録なし'})` : '未実施',
  secretScan: phase('secretScan'),
  dependencyDiff: depDiff ? '実施' : NO_RECORD,
};

// 5. 残存リスク、既知の不具合、未回収の例外
const debtRows = ledgerRows ? ledgerRows.filter((r) => r.state.startsWith('未返却')) : null;
const residual = {
  unmet: unmet.map((u) => u.label),
  deviations: deviations.map((d) => d.label),
  // 独立した人の確認を経ていないが、例外承認の記録が対応づいたため欠落として扱わなかった変更(未回収の例外)
  exceptedChanges: exceptedChanges.map((c) => `${c.label}(${c.riskClass ?? '区分未記入'}。${c.records.join(', ')})`),
  openExceptions: debtRows ? debtRows.filter((r) => r.kind === '例外').map((r) => `${r.id} ${r.content}`) : NO_RECORD,
  openUnresolved: debtRows ? debtRows.filter((r) => r.kind === '未解決').map((r) => `${r.id} ${r.content}`) : NO_RECORD,
  openDebt: debtRows ? count(debtRows, (r) => r.kind === '負債') : NO_RECORD,
  knownDefects: `${NO_RECORD}(不具合の台帳を持たない。追跡は Issue による)`,
  // 構成の初期化より前に、製品のコードを変えたコミット。独立した人の確認・リスク区分・検証の記載を確かめていない
  preInitProductChanges: preInitDetail.product.length,
};
independence.preInit = { productChanges: preInitDetail.product.length, templateOrigin: preInitDetail.templateOrigin };

// 6. 検出能力の測定値と測定時点(人の層・AI の層)
const seeded = exists('evidence/seeded-errors.json')
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/seeded-errors.json'), 'utf8'))
  : null;
// 期間の指定では、起点と終点の日付そのもの(手元の時刻帯の日付)で切る
const fromDay = period ? period.from : from ? git(['log', '-1', '--format=%cs', from]) : '';
const toDay = period ? period.to : git(['log', '-1', '--format=%cs', to]);
// 未測定が続いている期間。起点は、未測定のまま出荷した最初の出荷である(標準 第4章 G-7 項目6 /
// 附属書H H.6)。前回の出力から起点と回数を引き継ぎ、測定値が入ったら途切れる。
// 未測定は正当な値だが、続いていることを見えるようにする。
// 前回の出力を読めないとき、過去に出荷があったかどうかは機械では分からない。起点を今回とし、その旨を出す
const releaseDay = toDay || new Date().toISOString().slice(0, 10);
// 同じ出荷の再集計かどうかは、終点のコミットで比べる(HEAD のような参照名は、出荷ごとに指す先が変わる)
const toCommit = git(['rev-parse', '--verify', '--quiet', `${to}^{commit}`]) || null;
const sameRelease =
  Boolean(previous) &&
  (previous.range?.toCommit ? previous.range.toCommit === toCommit : previous.range?.to === to && to !== 'HEAD');
const dayOfRef = (ref) => (ref ? git(['log', '-1', '--format=%cs', ref]) : '') || null;
function unmeasuredStreak(measured, prevSince, prevReleases, prevWasUnmeasured) {
  if (measured) return { since: null, releases: 0, note: null };
  // 同じ出荷の再集計では、回数を進めない
  if (sameRelease && prevSince) return { since: prevSince, releases: prevReleases ?? 1, note: null };
  if (prevSince) return { since: prevSince, releases: (prevReleases ?? 1) + 1, note: null };
  if (previous && prevWasUnmeasured && !sameRelease) {
    // 起点を持たない旧い形式の出力。前回の出荷を起点とする
    const since = dayOfRef(previous.range?.to) || String(previous.generatedAt ?? '').slice(0, 10) || releaseDay;
    return { since, releases: 2, note: null };
  }
  return { since: releaseDay, releases: 1, note: previous ? '今回の出荷から' : '前回の出力なし。起点は今回' };
}
const streakText = (st) => `${st.since} の出荷から ${st.releases} 回連続${st.note ? `。${st.note}` : ''}`;

// 測定の記録(evidence/seeded-errors.json)は、human / ai のキーを持てば層ごとに読む。
// 持たない場合は、全体を人の層の記録として扱う
const seededHuman = seeded ? (seeded.human ?? (seeded.ai === undefined ? seeded : null)) : null;
const seededAi = seeded?.ai ?? null;
const performerSeats = seats.filter((s) => s.performer);
// 測定時点の後に担い手の識別が変わっていれば、AI の層の値は失効している(標準 附属書H H.6 項目6)。
// 測定時点の記録が無い値は、失効していないことを示せない
const measuredAtOf = (v) => (v && typeof v === 'object' ? (v.measuredAt ?? v.scannedAt ?? null) : null);
const lastPerformerChange =
  (config.changeLog ?? [])
    .filter((e) => e.kind === 'performer')
    .map((e) => changeDay(e))
    .sort()
    .at(-1) ?? null;
const aiExpired = Boolean(
  seededAi && lastPerformerChange && (!measuredAtOf(seededAi) || String(measuredAtOf(seededAi)).slice(0, 10) < lastPerformerChange)
);
// AI の層の検出能力は、欠陥注入による実測があるときだけ「測定済み」とする。
// 適合性確認(第3章 3.4.2)の結果は、検出能力の測定値として出さない(附属書H H.7)
const aiMeasured = performerSeats.length > 0 && Boolean(seededAi) && !aiExpired;
const prevD = prevA?.detection ?? null;
// 前回の出力が旧い形式(席ごとの配列。適合性確認の結果を値にしていた)なら、未測定として引き継ぐ
const prevAiUnmeasured = Array.isArray(prevD?.ai) || (typeof prevD?.ai === 'string' && prevD.ai.startsWith(UNMEASURED));
const humanStreak = unmeasuredStreak(Boolean(seededHuman), prevD?.unmeasuredSince, prevD?.unmeasuredReleases, prevD?.human === UNMEASURED);
// AI の担い手の宣言が無い構成には、AI の層が無い。継続は数えない
const aiStreak = performerSeats.length
  ? unmeasuredStreak(aiMeasured, prevD?.aiUnmeasuredSince, prevD?.aiUnmeasuredReleases, prevAiUnmeasured)
  : { since: null, releases: 0, note: null };
let aiValue;
if (!performerSeats.length) aiValue = `${UNMEASURED}(AI の担い手の宣言なし)`;
else if (aiMeasured) aiValue = seededAi;
else if (aiExpired) aiValue = `${UNMEASURED}(測定時点の後に担い手の識別が変わり、値は失効している。測定時点の記録が無い値も同じ扱い)`;
else aiValue = `${UNMEASURED}(AI の層の検出能力を測定した記録がない)`;
const detection = {
  human: seededHuman ?? UNMEASURED,
  // 人の層が未測定のまま出荷した最初の出荷の日付と、連続した出荷の回数。測定済みなら null と 0
  unmeasuredSince: humanStreak.since,
  unmeasuredReleases: humanStreak.releases,
  unmeasuredNote: humanStreak.note,
  ai: aiValue,
  aiUnmeasuredSince: aiStreak.since,
  aiUnmeasuredReleases: aiStreak.releases,
  aiUnmeasuredNote: aiStreak.note,
  // 適合性確認(第3章 3.4.2)の結果。検出能力の測定値ではない。別の行に出す
  conformity: performerSeats.map((s) => {
    const problems = qualificationProblems(s);
    return {
      seat: s.name,
      valid: !problems.length,
      result: problems.length ? null : s.qualification.result,
      confirmedAt: problems.length ? null : s.qualification.confirmedAt,
      problem: problems[0] ?? null,
    };
  }),
  previous: prevA ? { release: previous.range?.to ?? null, human: prevD?.human ?? null, ai: prevD?.ai ?? null } : NO_PREVIOUS,
};

// 組織の外へ渡す形(標準 附属書H H.6「組織の外へ渡すとき」)。検出率の値を出さない。
// 出すのは、測定している事実・測定時点・推移の向きである
const rateOf = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.rate === 'number') return v.rate;
  const total = v.seeded ?? v.injected ?? v.total;
  return typeof v.detected === 'number' && typeof total === 'number' && total > 0 ? v.detected / total : null;
};
function trendOf(current, before) {
  const a = rateOf(current);
  if (a === null) return '導けない(記録に、検出率を導ける値がない)';
  if (!previous) return '前回の出力なし';
  const b = rateOf(before);
  if (b === null) return '前回は値なし';
  return a > b ? '上昇' : a < b ? '低下' : '変化なし';
}
const externalLayer = (value, streak, before) =>
  typeof value === 'string'
    ? { measuring: false, note: value, unmeasuredSince: streak.since, unmeasuredReleases: streak.releases }
    : { measuring: true, measuredAt: measuredAtOf(value) ?? '測定時点の記録なし', trend: trendOf(value, before) };
const detectionExternal = {
  human: externalLayer(detection.human, humanStreak, prevD?.human),
  ai: externalLayer(detection.ai, aiStreak, prevD?.ai),
  conformity: detection.conformity.map((q) => ({
    seat: q.seat,
    status: q.valid ? `実施済み(${q.confirmedAt})` : '未実施または失効',
  })),
};

// 7. 生成の条件と、期間中の体制の変化点
const observedCoAuthors = [...new Set(trailers.flatMap((c) => c.coAuthors))];
const declaredPerformers = seats
  .filter((s) => s.performer)
  .map((s) => ({ seat: s.name, ...s.performer }));
const changeLog = config.changeLog ?? [];
// 期間中の変化点は、起点の時点の構成に無かった記録(changeLog[] は追記だけ)として数える。
// 日付では比べない。変化点の記録の日付(協定世界時の日付)と、コミットの日付(手元の時刻帯の日付)は
// 1日ずれることがあり、日付で比べると、期間中の変化点が開示から落ちる。
// 起点の構成を読めない場合(起点なし、起点に構成が無い)に限り、日付で比べる
const changeLogLengthAtFrom = (() => {
  if (!from) return null;
  try {
    const log = JSON.parse(git(['show', `${from}:process.config.json`])).changeLog;
    return Array.isArray(log) ? log.length : null;
  } catch {
    return null;
  }
})();
const inPeriodByDay = (day) => (!fromDay || day >= fromDay) && (!toDay || day <= toDay);
const inPeriod = (e, index) => (changeLogLengthAtFrom !== null ? index >= changeLogLengthAtFrom : inPeriodByDay(changeDay(e)));
// 即時通知(第3章 3.13.6)の記録。対象の変化点は notice を持つ。通知先と通知日は、その記録か、
// 後から追記された種別 notice の記録(noticeFor が添字を指す)にある
const noticeOf = (e, index) => {
  if (!e.notice) return null;
  const later = changeLog.find((x) => x?.kind === 'notice' && x.noticeFor === index && x.notice?.to && x.notice?.at);
  const n = e.notice.to && e.notice.at ? e.notice : (later?.notice ?? null);
  // self: 通知する者と通知先が同一(生成側が自動で記録)。also: 前任の出荷判定者・決定者・品質保証部門への通知
  return n
    ? { required: true, to: n.to, at: String(n.at).slice(0, 10), self: n.self === true, also: Array.isArray(n.also) ? n.also.map((a) => ({ to: a?.to ?? null, role: a?.role ?? null })) : [] }
    : { required: true, to: null, at: null, self: false, also: [] };
};
const generation = {
  declaredPerformers: declaredPerformers.length ? declaredPerformers : '宣言なし',
  observedCoAuthors: observedCoAuthors.length ? observedCoAuthors : NO_RECORD,
  instructionAssets: git(['log', '-1', '--format=%h %cs', to, '--', 'CLAUDE.md', '.claude']) || NO_RECORD,
  changePoints: changeLog
    .map((e, index) => ({ e, index }))
    .filter(({ e, index }) => e.kind !== 'outage' && e.kind !== 'notice' && inPeriod(e, index))
    .map(({ e, index }) => ({
      date: changeDay(e),
      kind: e.kind,
      changePoint: e.changePoint ?? null,
      summary: e.summary ?? null,
      result: e.result,
      direction: e.direction,
      arising: e.arising ?? [],
      decidedBy: e.decidedBy ?? null,
      // 前任の決定者が体制から外れ、組織上の任命権者の記名で任免を決定した(第3章 3.13.3)
      appointerSigned: e.appointerSigned === true,
      // 人の名簿の表記の変更(旧い値と新しい値。席の責任者の行なら、その席。K74)
      rosterEdits: e.rosterEdits ?? [],
      // 即時通知の対象でない変化点は null
      notice: noticeOf(e, index),
    })),
  // AI が使えなかった期間。変化点に数えないが、期間とその間の扱いを出す(第3章 3.13.2)
  // 開始だけを記録した期間は、後の記録(outage.closes)で閉じる。閉じた期間を2件に数えないよう、
  // 期間の一覧(outagePeriods)から読む。閉じていない期間は ongoing(継続中)
  // 期間に入れるのは、継続中の期間、期間中に記録または閉じた期間、日付が期間と重なる期間
  outages: outagePeriods(config)
    .filter(
      (o) =>
        o.ongoing ||
        (changeLogLengthAtFrom !== null &&
          (o.index >= changeLogLengthAtFrom || changeLog.some((e, i) => i >= changeLogLengthAtFrom && e?.kind === 'outage' && e.outage?.closes === o.index))) ||
        ((!toDay || o.from <= toDay) && (!fromDay || (o.to ?? '9999-12-31') >= fromDay))
    )
    .map((o) => ({ from: o.from, to: o.to, handling: o.handling, switched: o.switched, ongoing: o.ongoing, summary: changeLog[o.index]?.summary ?? null })),
  changeLogPresent: Array.isArray(config.changeLog),
};

// 宣言と実態のずれ(標準 第3章 3.13.5)。検出したずれは変化点の起票として扱う
const drift = [];
const approvers = new Set(prs.flatMap((p) => p.g6.approvers));
const sizeLimit = { 'size-1-2': 2, 'size-3-9': 9 }[config.answers?.['q-team-size']];
if (sizeLimit && approvers.size > sizeLimit) {
  drift.push(`人数: 宣言したチーム規模は ${config.answerLabels?.['q-team-size'] ?? config.answers['q-team-size']} だが、期間中の承認者は ${approvers.size} 名いる`);
}
const norm = (s) => String(s).toLowerCase().replace(/<[^>]*>/g, '').replace(/[^a-z0-9]/g, '');
const declaredModels = declaredPerformers.map((p) => norm(p.model ?? '')).filter(Boolean);
const undeclared = observedCoAuthors.filter((c) => !declaredModels.some((m) => norm(c).includes(m) || m.includes(norm(c))));
if (undeclared.length) {
  drift.push(`担い手の識別: 宣言にない共著者の記録がある(${undeclared.join(' / ')})。人の共著者を含む場合がある`);
}

const assurance = {
  independence,
  tailoring,
  changes: changeCounts,
  machineChecks,
  residual,
  detection,
  // 組織の外へ渡す形の項目6。値を含まない
  detectionExternal,
  generation,
  drift,
};

// --- 出荷判定者の異議(標準 第4章 G-8「出荷判定者の異議」) ----------------------
//
// 開示が次の4つの事項のいずれかに当たる場合、出荷判定者は、異議の有無とあわせて理由を書く。
// 「異議なし」とする場合も同じである。当たるかどうかは、上で導いた値から機械的に判定する。
// 理由の内容は判定しない。欄の記載が異議の有無だけかどうかを表示するに留める
// 事項3 は、次の2つの量を別々に比べる。どちらか一方が増えれば当たる。合算して比べない(第4章 G-8)。
//   独立した人の確認を経ていない変更の件数(項目1。G-6 を事後へ移した変更を含む)
//   構成上の未達のゲートと逸脱の数の合計(項目1)
const unmetAndDeviations = unmet.length + deviations.length;
const prevUnmetAndDeviations = prevA?.residual
  ? (Array.isArray(prevA.residual.unmet) ? prevA.residual.unmet.length : 0) + (Array.isArray(prevA.residual.deviations) ? prevA.residual.deviations.length : 0)
  : null;
const prevWithoutIndependentHuman = typeof prevA?.independence?.changes?.withoutIndependentHuman === 'number' ? prevA.independence.changes.withoutIndependentHuman : null;
const matter3 = [
  prevWithoutIndependentHuman !== null && withoutIndependentHuman > prevWithoutIndependentHuman
    ? `独立した人の確認を経ていない変更の件数が増えた(前回 ${prevWithoutIndependentHuman} 件 / 今回 ${withoutIndependentHuman} 件)`
    : null,
  prevUnmetAndDeviations !== null && unmetAndDeviations > prevUnmetAndDeviations
    ? `構成上の未達のゲートと逸脱の数が増えた(前回 ${prevUnmetAndDeviations} / 今回 ${unmetAndDeviations})`
    : null,
].filter(Boolean);
const objectionMatters = [
  r1Unconfirmed.length ? { id: 1, text: `独立した人の確認を経ていない R1 の変更が ${r1Unconfirmed.length} 件ある` } : null,
  humanStreak.releases >= 2 || aiStreak.releases >= 2
    ? { id: 2, text: `前回の出荷に続いて、検出能力が未測定である(連続: 人の層 ${humanStreak.releases} 回 / AI の層 ${aiStreak.releases} 回)` }
    : null,
  matter3.length ? { id: 3, text: matter3.join('。') } : null,
  samplerIsAuthor && g6PostHoc
    ? { id: 4, text: `事後の抜き取りを、作成を指示した本人が行っている(G-6 を事後の抜き取りへ移した変更 ${g6PostHoc} 件)` }
    : null,
].filter(Boolean);
const objectionNotJudged = [
  ...(prevA ? [] : ['事項3(独立した人の確認を経ていない変更の件数、または構成上の未達のゲートと逸脱の数が、前回より増えた): 前回の出力が無いため、判定していない']),
  ...(prevA && prevWithoutIndependentHuman === null ? ['事項3 のうち、独立した人の確認を経ていない変更の件数: 前回の出力が値を持たないため、比べていない'] : []),
  ...(unclassifiedUnconfirmed
    ? [`事項1: リスク区分が未記入で、独立した人の確認を経ていない変更が ${unclassifiedUnconfirmed} 件ある。R1 かどうかを判定していない`]
    : []),
];
// 欄の記載から、異議の有無を表す語と区切りを除いた残り。残りが無ければ、理由の記載を確認できない
const beyondVerdict = (s) => s.replace(/異議|なし|無し|ありません|ない|あり|有り|です|ます|[。、．，.,:：\s*]/g, '');
const g8Objection = {
  matters: objectionMatters,
  notJudged: objectionNotJudged,
  records: g8Records.map((g) => {
    // どの出荷の開示への記載か。「対象」が今回の終点、または前回の終点を指す記録だけを対応づける
    // 「対象」がどちらも指さない記録は、今回の開示への記載として扱う(安全側)。前回の出力が事項の一覧を
    // 持たない場合は、判定できない(null)
    const about =
      to !== 'HEAD' && (g.target ?? '').includes(to) ? 'current' : previous?.range?.to && (g.target ?? '').includes(previous.range.to) ? 'previous' : 'unknown';
    const matters = about === 'previous' ? (previous.g8Objection?.matters ?? null) : objectionMatters;
    return {
      file: g.file,
      target: g.target,
      about,
      recorded: Boolean(g.objection),
      mattersApplicable: matters ? matters.map((m) => m.id) : null,
      reasonPresent: g.objection ? beyondVerdict(g.objection).length > 0 : null,
    };
  }),
};

// 開示が理由を要する事項に当たるのに、異議の欄が異議の有無を表す語だけの記録は、記載の欠落である(標準 第4章 G-8)。
// 判別は、欄の記載から異議の有無を表す語と区切りを除いた残りがあるかどうかによる。理由の内容は判定しない
for (const r of g8Objection.records) {
  if (r.recorded && r.mattersApplicable?.length && !r.reasonPresent) {
    gaps.push(
      `${r.file}: 開示が、理由を要する事項(${r.mattersApplicable.join('・')})に当たりますが、「出荷判定者の異議」欄に理由の記載がありません。` +
        '記載の欠落です。「異議なし」とする場合も、理由を書きます'
    );
  }
}
assurance.objectionMatters = { matters: objectionMatters, notJudged: objectionNotJudged };

// --- 事後の抜き取り(第8章「事後監査の手続」)と、期間ごとの開示 -----------------------
//
// G-6 を事後へ移した変更のうち、独立レビュアの席の責任者による事後の抜き取りの記録があるもの。
// 記録は、G-6 の判定記録で、確定の形態が「委任」、「対象」が当該の PR を指すもの(リポジトリの全体から探す)。
// 抜き取りの数と頻度が第8章を満たすかは、機械では判定しない
const samplingRecords = gateDetails.filter((g) => /G-6/.test(g.gate ?? '') && g.mode === MODE_LABEL.delegated);
const sampling = prs
  .filter((p) => p.g6PostHoc)
  .map((p) => {
    const recs = samplingRecords.filter((g) => refersToPr(g.target, p.number));
    return { pr: p.number, sampled: recs.length > 0, records: recs.map((g) => ({ file: g.file, result: g.result ?? null, judge: g.judge ?? null })) };
  });

// --- G-7 の基準ごとの、機械が確かめた範囲(第4章 G-7 基準1〜9) --------------------
//
// 機械が確かめた結果か、「機械では確かめていない。出荷判定者が次の記録と突合する」かを、基準ごとに出す。
// machine: checked(機械が確かめた) / partial(一部だけ機械が確かめた) / not-checked(機械では確かめていない)
const gateLabelRe = (key) => new RegExp(`^G-${key.slice(1)}(?!\\d)`);
const gatesInRange = Object.entries(config.gates ?? {})
  .filter(([k]) => isActive(k))
  .map(([k, g]) => ({ gate: k, label: g.label ?? k, records: count(records, (r) => gateLabelRe(k).test(r.gate ?? '')) }));
const g6Summary = `独立した人の確認あり ${confirmedUnits.length} 件 / G-6 を事後へ移した ${g6PostHoc} 件 / 例外承認の記録が対応づいた ${exceptedChanges.length} 件 / 独立した人の確認を経ていない ${withoutIndependentHuman} 件` +
  (g6Applied ? '(G-6 を適用する体制。事後へ移した変更と例外承認のある変更を除き、欠落として扱う)' : '(G-6 を適用しない体制。R1 の変更だけ例外承認を要する)');
const g5Summary = prs.length ? `gate-g5 成功 ${count(prs, (p) => p.g5 === 'success')} / 成功以外 ${count(prs, (p) => p.g5 !== 'success' && p.g5 !== 'unknown')} / 記録なし ${count(prs, (p) => p.g5 === 'unknown')}(PR ごと)` : 'PR なし';
const specTotal = new Set(specChanges.flatMap((c) => c.specs)).size;
const criteria = [
  { id: 1, label: '計画したテストの消化率', machine: 'not-checked', result: null, humanReconcile: 'テスト計画と、G-7 の判定記録の「未消化のテスト」の節(未消化が1件以上ある場合)' },
  { id: 2, label: '未解決の欠陥', machine: 'not-checked', result: null, humanReconcile: '欠陥の追跡(Issue など)と、事業ステージ別の欠陥トリアージ基準' },
  {
    id: 3,
    label: '受容した負債の台帳記録',
    machine: 'partial',
    result: `技術負債台帳 ${exists(debtFile) ? 'あり' : 'なし'}(台帳の有無だけを見た)`,
    humanReconcile: '記録漏れ(台帳に無い妥協)は機械で確かめていない。PR のチェックリスト「受容した妥協・仮実装を技術負債台帳へ記録した」と台帳',
  },
  {
    id: 4,
    label: '運用引き継ぎ文書',
    machine: 'partial',
    result: `docs/handover.md ${exists(handoverFile) ? 'あり' : 'なし'}(文書の有無だけを見た)`,
    humanReconcile: '完備(監視項目・障害時連絡先・復旧手順)は機械で確かめていない。docs/handover.md の中身',
  },
  {
    id: 5,
    label: '全ゲートの通過記録',
    machine: 'partial',
    result:
      `G-5: ${g5Summary}。G-6: ${g6Summary}。G-4: トレーラ Spec が指す仕様 ${specTotal} 件のうち、機能仕様承認の判定記録が無い ${specsWithoutG4.length} 件。` +
      `当該${period ? '期間' : '出荷の範囲'}の判定記録の件数: ${gatesInRange.map((g) => `${g.label} ${g.records}`).join(' / ') || 'なし'}`,
    humanReconcile: '適用するゲートごとの判定記録の件数が、当該の出荷に対応しているか(G-1〜G-3・G-7・G-8 の、出荷に対応する件数は機械で決められない)',
  },
  { id: 6, label: 'AI 品質指標の確認', machine: 'not-checked', result: null, humanReconcile: '第4章「AI 品質指標の扱い」に従った指標の記録' },
  {
    id: 7,
    label: '安全適合性の検証記録(安全関連ソフトウェアのみ)',
    machine: 'not-checked',
    result: null,
    humanReconcile: `安全関連ソフトウェアを含むか(構成の安全重要度: ${config.answers?.['q-criticality'] ?? '未記入'})と、含む場合は附属書F F.7 の記録`,
  },
  {
    id: 8,
    label: '知財潔白性の検査記録',
    machine: 'partial',
    result: `依存関係のライセンス検査の記録 ${licenseScan.scanRun ? 'あり' : 'なし'}(記録の有無だけを見た)`,
    humanReconcile: '類似の検知の実施記録と結果、判定できなかった項目の台帳記録',
  },
  { id: 9, label: '保証の開示の完備', machine: 'checked', result: `7項目を出力した。記録の欠落 ${gaps.length} 件(欠落の一覧による)`, humanReconcile: null },
];

const evidence = {
  range: { from: from || null, to, toCommit },
  // 期間を指定した開示の起点と終点。出荷の範囲の出力では null
  period: period ? { ...period, cut: PERIOD_CUT } : null,
  // 構成の初期化より前の履歴(対象外)の件数と、初期化のコミット
  preInit: {
    commits: preInitCommits.length,
    initCommit: initCommit ? initCommit.slice(0, 8) : null,
    // 製品のコード(記録の置き場の外)を変えたコミット。テンプレート由来の初期コミットは件数だけ
    productChanges: preInitDetail.product,
    templateOrigin: preInitDetail.templateOrigin,
    recordOnly: preInitDetail.recordOnly,
  },
  // G-7 の基準ごとの、機械が確かめた範囲
  criteria,
  gatesInRange,
  specsWithoutG4,
  // G-6 を事後へ移した変更ごとの、事後の抜き取りの記録
  sampling,
  generatedAt: new Date().toISOString(),
  profile: {
    projectId: config.projectId,
    answers: config.answers ?? null,
    gates: Object.fromEntries(Object.entries(config.gates).map(([k, g]) => [k, g.state])),
  },
  prs,
  commits: commits.length,
  tests: { coverage },
  dependencies: depDiff ? { manifestsChanged: depDiff.manifestsChanged } : null,
  debt: { ledgerPresent: exists(debtFile) },
  handover: { updated: exists(handoverFile) },
  gateRecords,
  // 当該出荷の範囲で追加された判定記録。完備の判定は、こちらだけを見る
  gateRecordsInRange: records.map((r) => r.file),
  adrs,
  ipClearance: licenseScan,
  shipBlocked: config.shipBlocked ?? null,
  unmet,
  deviations,
  delegatedChanges,
  directChanges,
  assurance,
  g8Objection,
  gaps,
};

fs.mkdirSync(path.join(ROOT, OUT_DIR), { recursive: true });
fs.writeFileSync(path.join(ROOT, OUT_DIR, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');

// --- 人が読むレポート ------------------------------------------------------

const R = [];
R.push(`# 品質レポート ${range}`);
R.push('');
R.push(`生成: ${evidence.generatedAt}`);
R.push('');
if (period) {
  R.push(
    `期間を指定した保証の開示です(${period.from}〜${period.to})。委任で先へ進めた変更と、事後の抜き取りの結果を載せます(第4章 G-7・G-8「期間ごとの保証の開示」)。` +
      '出荷の範囲に固有の検査(運用引き継ぎ文書・知財潔白性の検査記録・当該出荷の判定記録の有無)は行っていません。' +
      `${PERIOD_CUT}。変化点の記録は、記録した時刻(時刻帯つき)の日付で同じ期間に切った。`
  );
  R.push('');
}

// G-7 の基準ごとに、機械が確かめた範囲と、出荷判定者が突合する記録を出す(第4章 G-7)
R.push('## G-7 の基準ごとの確認範囲');
R.push('');
R.push('| 基準 | 機械が確かめた結果 | 出荷判定者が突合する記録 |');
R.push('| --- | --- | --- |');
const MACHINE_TEXT = { checked: '', partial: '(一部だけ)', 'not-checked': '機械では確かめていない' };
for (const c of criteria) {
  R.push(
    `| ${c.id}. ${c.label} | ${c.result ? `${MACHINE_TEXT[c.machine]}${c.result}` : MACHINE_TEXT[c.machine]} | ${c.humanReconcile ? `機械では確かめていない。出荷判定者が次の記録と突合する: ${c.humanReconcile}` : '—'} |`
  );
}
R.push('');
R.push('「機械では確かめていない」基準は、欠落として検出していません。出荷判定者が、右の列の記録と突合して判定します。');
R.push('');

if (config.shipBlocked) {
  R.push('## 出荷できない状態');
  R.push('');
  R.push(`**${config.shipBlocked.reason}**`);
  R.push('');
  // 原因は2つある。人が減った(headcount)場合と、1〜2名の体制のまま案件が CL1 以上・規制業になった(criticality)場合
  R.push(
    `発生日: ${config.shipBlocked.since}。` +
      (config.shipBlocked.cause === 'criticality'
        ? '体制を3名以上にする変化点で解除されます(1〜2名の体制では、CL1 以上・規制業の案件を出荷できません)。'
        : '体制を3名以上へ戻す変化点で解除されます。')
  );
  R.push('');
}

if (unmet.length) {
  R.push('## 未達のゲート');
  R.push('');
  R.push('**目的を達成する構成を示せていないゲートがあります。省略ではありません。**');
  R.push('');
  R.push('| ゲート | 理由 | 代償措置 | 確認者の調達先 |');
  R.push('| --- | --- | --- | --- |');
  for (const u of unmet) {
    R.push(`| ${u.label} | ${u.reason} | ${u.compensation.join(' / ') || '—'} | ${u.reviewSourcing ?? '**未記入**'} |`);
  }
  R.push('');
}

if (deviations.length) {
  R.push('## 逸脱');
  R.push('');
  R.push('**標準が要求する属性を欠いているゲート・兼務があります。未達ではありません。**');
  R.push('');
  R.push('| 対象 | 抵触する規則 | 欠けるもの | 代償措置 | 解消の時点 |');
  R.push('| --- | --- | --- | --- | --- |');
  for (const d of deviations) {
    const comp = d.compensation.join(' / ') || (d.gate ? '**なし**' : '定められていない(記録と表示による)');
    R.push(`| ${d.label} | ${d.rule ?? '—'} | ${d.reason} | ${comp} | ${d.resolveWhen ?? '**未記入**'} |`);
  }
  R.push('');
}

// 保証の開示。値は上で導いたものをそのまま出す。評価の語を足さない。
// external を真にすると、組織の外へ渡す形で出す。変えるのは項目6 だけである(標準 附属書H H.6)
const listOr = (v, empty = 'なし') => (Array.isArray(v) ? (v.length ? v.join(' / ') : empty) : v);
const A = assurance;
function renderAssurance(external) {
  const R = [];
  R.push('## 保証の開示');
  R.push('');
  R.push(
    '構成と既存の記録からの投影です。**未達・未測定・記録なしは値です**。' +
      '開示したことは、出荷してよい理由になりません。残存リスクの受容は、リリース決裁(G-8)の決断の記録に事業決裁者が記名します。'
  );
  R.push('');
  if (A.independence.statement) {
    R.push(`> ${A.independence.statement}`);
    R.push('');
  }
  R.push('### 1. 体制と独立性の成立状況');
  R.push('');
  const ch = A.independence.changes;
  const un = ch.unconfirmed;
  const prevUn = (key) => prev((p) => p.independence.changes.unconfirmed?.[key]);
  R.push('| 項目 | 値 | 前回の出荷の値 |');
  R.push('| --- | --- | --- |');
  R.push(`| G-6 独立レビュー | ${A.independence.g6} | ${prev((p) => p.independence.g6)} |`);
  R.push(`| G-6 の事後の抜き取り | ${A.independence.g6PostHocSampling} | ${prev((p) => p.independence.g6PostHocSampling)} |`);
  R.push(`| G-7 出荷判定 | ${A.independence.g7} | ${prev((p) => p.independence.g7)} |`);
  R.push(`| 責任者が同一人物のため独立が成立しない組 | ${listOr(A.independence.sameAccountable)} | ${prev((p) => listOr(p.independence.sameAccountable))} |`);
  R.push(`| 逸脱として記録した兼務(1〜2名の体制) | ${listOr(A.independence.separationDeviations)} | ${prev((p) => listOr(p.independence.separationDeviations ?? []))} |`);
  if (A.independence.objectionSelfAccepted) {
    R.push(`| 出荷判定者の異議と、残存リスクの受容 | **異議を書く者と、残存リスクを受容する者が同一である**(出荷判定者の席と事業決裁者の席の責任者が同一人物) | ${prev((p) => (p.independence.objectionSelfAccepted ? '同一' : '別の人'))} |`);
  }
  R.push(`| 責任者が未記入の席 | ${seats.length ? `${A.independence.seatsWithoutAccountable} 席` : NO_RECORD} | ${prev((p) => `${p.independence.seatsWithoutAccountable} 席`)} |`);
  R.push(`| 変更の件数 | ${ch.total} | ${prev((p) => p.independence.changes.total)} |`);
  R.push(`| うち、独立した人の確認を経ていない変更 | ${ch.withoutIndependentHuman} | ${prev((p) => p.independence.changes.withoutIndependentHuman)} |`);
  R.push(`| 　内訳: 人のアカウントによる承認がない | ${un.noApproval} | ${prevUn('noApproval')} |`);
  R.push(`| 　内訳: AI・bot のアカウントによる承認だけである | ${un.aiOrBot} | ${prevUn('aiOrBot')} |`);
  R.push(`| 　内訳: 承認者が、作成を指示した者である | ${un.approverIsInstructor} | ${prevUn('approverIsInstructor')} |`);
  R.push(`| 　内訳: 構成上、G-6 が未達または成立しない(体制の内の人の承認を数えない) | ${un.structure} | ${prevUn('structure')} |`);
  R.push(`| 　内訳: 承認者を名簿と対応づけられない(承認者の同一性は未確認) | ${un.approverUnmapped} | ${prevUn('approverUnmapped')} |`);
  R.push(`| 　内訳: 作成を指示した者を名簿と対応づけられない | ${un.instructorUnresolved} | ${prevUn('instructorUnresolved')} |`);
  R.push(`| 　内訳: レビュアの挙動要約を伴わない承認だけである | ${un.noReviewerSummary ?? 0} | ${prevUn('noReviewerSummary')} |`);
  R.push(`| 　内訳: PR を経ていないコミット(独立した人の G-6 の判定記録が対応づかない) | ${un.directCommits} | ${prevUn('directCommits')} |`);
  if (ch.approvalRecordNotFound) {
    R.push(`| 　うち、件名は PR の番号を持つが、PR のマージコミットと一致しない・取得できないコミット | ${ch.approvalRecordNotFound} | ${prev((p) => p.independence.changes.approvalRecordNotFound)} |`);
  }
  R.push(
    `| 独立した人の確認に数えた変更のうち、承認した者に独立レビュアの席の責任者を含む | 含む ${ch.byReviewerSeat ?? 0} 件 / 含まない ${ch.notByReviewerSeat ?? 0} 件 | ${prev((p) => (p.independence.changes.byReviewerSeat === undefined ? '値なし' : `含む ${p.independence.changes.byReviewerSeat} 件 / 含まない ${p.independence.changes.notByReviewerSeat} 件`))} |`
  );
  if (ch.withdrawnApprovals) {
    R.push(`| 承認の後に同じ人が変更要求を出した(取り下げた承認は数えていない) | ${ch.withdrawnApprovals} 件 | ${prev((p) => p.independence.changes.withdrawnApprovals ?? '値なし')} |`);
  }
  if (preInitDetail.total) {
    R.push(
      `| 構成の初期化より前に、製品のコードを変えたコミット(変更の件数に数えていない。独立した人の確認・リスク区分・検証の記載を確かめていない) | ${A.independence.preInit.productChanges} 件(ほかにテンプレート由来の初期コミット ${A.independence.preInit.templateOrigin} 件) | ${prev((p) => (p.independence.preInit ? `${p.independence.preInit.productChanges} 件` : '値なし'))} |`
    );
  }
  const r1 = A.independence.r1WithoutIndependentHuman;
  R.push(
    `| 独立した人の確認を経ていない R1 の変更 | ${r1.total} 件(例外承認の記録あり ${r1.withExceptionRecord} 件 / 記録なし ${r1.withoutExceptionRecord.length} 件${r1.withoutExceptionRecord.length ? `: ${r1.withoutExceptionRecord.join(', ')}` : ''}) | ${prev((p) => `${p.independence.r1WithoutIndependentHuman.total} 件`)} |`
  );
  if (A.independence.unclassifiedWithoutIndependentHuman) {
    R.push(
      `| リスク区分が未記入で、独立した人の確認を経ていない変更 | ${A.independence.unclassifiedWithoutIndependentHuman} 件(R1 かどうかを判定していない) | ${prev((p) => `${p.independence.unclassifiedWithoutIndependentHuman} 件`)} |`
    );
  }
  const bs = A.independence.reviewerSummary;
  R.push(
    `| 挙動要約を伴わないため、独立した人の確認に数えなかった承認 | ${bs.absent.length} 件${bs.absent.length ? `: ${bs.absent.map((n) => `#${n}`).join(', ')}` : ''} | ${prev((p) => `${p.independence.reviewerSummary.absent.length} 件`)} |`
  );
  R.push('');
  R.push(
    'AI の確認は検出の層であり、この表の「独立した人の確認」に数えていません。AI・bot のアカウントによる承認も数えていません。' +
      '「成立(構成上)」は席の責任者の宣言から導いた値であり、変更ごとに確認が行われたことは件数の行で読みます。'
  );
  R.push('');
  R.push(
    '承認を独立した人の確認に数えるのは、承認した者が名簿(people[])の人へ対応づき、その人が作成を指示した者でなく、構成上 G-6 が成立し(未達の体制では外部の確認者に限る)、承認した者自身の挙動要約を伴う場合に限ります(第4章 G-6 の4条件)。' +
      '承認は、レビュアごとの最後の状態で数えます。PR のレビューの承認のほか、G-6 の判定記録(「対象」が当該の変更、結果が通過)も承認に数えます。' +
      '作成を指示した者は、PR 本文の欄「作成を指示した者」から取ります。PR を経ていないコミットでは、コミットの Author と開発者の席の責任者です。' +
      (ch.instructorsByDefault
        ? `数えた変更のうち ${ch.instructorsByDefault} 件は、欄が未記入のため、指示した者を既定値(PR の作成者と、開発者の席の責任者)で判定しています。`
        : '') +
      '名簿のアカウントの記載が正しいかは、機械で確かめていません(内部監査の観点6 で確かめます)。' +
      'レビュアの挙動要約は、承認レビューの本文、または承認した者が判定者の G-6 の判定記録の「挙動要約」の節に記載があるかだけを見ています。内容は判定していません。' +
      'PR の変更として数えるのは、PR のマージコミットと一致するコミットだけです。件名の番号だけでは PR の変更に数えません。'
  );
  if (!A.independence.accountsRegistered) {
    R.push('');
    R.push('人の名簿にアカウント(people[].accounts[])が1件も登録されていません。承認者を人へ対応づけられないため、すべての承認を未確認に数えています。');
  }
  if (external && A.independence.nameOverrides.length) {
    R.push('');
    R.push(`名義の機械検査を人が上書きした記録: ${A.independence.nameOverrides.length} 件(内容は組織の内側の開示にある)`);
  } else {
    for (const n of A.independence.nameOverrides) {
      R.push('');
      R.push(`名義の機械検査を人が上書きした: ${n}`);
    }
  }
  if (!A.independence.rosterPresent) {
    R.push('');
    R.push('人の名簿(people[])が未記入です。責任者の同一性は、席に書かれた氏名の文字列だけで比べています。');
  }
  R.push('');

  R.push('### 2. テーラリングの宣言(外した項目と理由)');
  R.push('');
  if (A.tailoring.length) {
    R.push('| 項目 | 状態 | 理由 |');
    R.push('| --- | --- | --- |');
    for (const t of A.tailoring) {
      // 強制層の一時緩和の理由は自由記述である。組織の外へ渡す形では出さない
      const why = external && t.label === '強制層の書き込み遮断' ? ['理由は組織の内側の開示にある'] : t.why;
      R.push(`| ${t.label} | ${t.state} | ${why.join(' / ') || '**理由の記録なし**'} |`);
    }
  } else {
    R.push('- 外した項目なし');
  }
  R.push('');

  R.push('### 3. リスク区分ごとの変更の件数と、確定の形態の内訳');
  R.push('');
  const rc = A.changes.byRiskClass;
  const bm = A.changes.byMode;
  const rcText = (v) => (!v || v === NO_RECORD ? NO_RECORD : `R1 ${v.R1} / R2 ${v.R2} / R3 ${v.R3} / 記載なし ${v.notRecorded}`);
  const bmText = (v) =>
    !v || v === NO_RECORD ? NO_RECORD : `人確定 ${v.human} / 協働 ${v.collab} / 委任(事後の抜き取り) ${v.delegatedPostHoc} / 記載なし ${v.notRecorded}`;
  R.push(`- リスク区分(PR の記載): ${rcText(rc)}(${prev((p) => rcText(p.changes.byRiskClass))})`);
  R.push(`- リスク区分の出所: ${A.changes.riskClassSource}`);
  R.push(`- 確定の形態(当該出荷の範囲の判定記録の記載): ${bmText(bm)}(${prev((p) => bmText(p.changes.byMode))})`);
  const dg = A.changes.delegated;
  const dgb = dg.withoutPriorHumanBreakdown;
  R.push(
    `- 変更ごとの検証を担い手へ委ねた変更(トレーラ Delegated): ${dg.inScope} 件 / うち独立した人が事前に承認 ${dg.withIndependentHuman} 件 / ` +
      `独立した人の事前の承認が無い委任の変更 ${dg.withoutPriorHuman} 件(内訳: G-6 を事後の抜き取りへ移した変更=人の事前確認を経ていない変更 ${dgb.g6PostHoc} 件 / それ以外=独立した人の確認を経ていない変更 ${dgb.other} 件) / 範囲の逸脱 ${dg.outOfScope} 件` +
      `(${prev((p) => `${p.changes.delegated.inScope} 件 / 独立した人の事前の承認が無い ${p.changes.delegated.withoutPriorHuman ?? '値なし'} 件 / 範囲の逸脱 ${p.changes.delegated.outOfScope} 件`)})`
  );
  const dc = A.changes.directCommits;
  R.push(
    `- PR を経ていないコミット(区分はトレーラ Risk、または判定記録による): R1 ${dc.R1} / R2 ${dc.R2} / R3 ${dc.R3} / 記載なし ${dc.notRecorded}` +
      `。対象外にしたコミット: 記録だけのコミット ${dc.exempt.recordOnly} 件 / ファイルの変更を持たないコミット ${dc.exempt.empty} 件(変更の件数に数えていない)`
  );
  R.push(`- 参照した D-0 の版の記載がない判定記録: ${A.changes.gateRecordsWithoutD0Version} 件`);
  R.push('');
  const detail = A.changes.byRiskClassDetail;
  if (detail !== NO_RECORD) {
    R.push('| リスク区分 | 変更の件数 | 独立した人の確認あり | うち、レビュアの挙動要約あり | G-6 を事後の抜き取りへ移した |');
    R.push('| --- | --- | --- | --- | --- |');
    for (const [k, label] of [['R1', 'R1'], ['R2', 'R2'], ['R3', 'R3'], ['notRecorded', '記載なし']]) {
      R.push(`| ${label} | ${detail[k].total} | ${detail[k].withIndependentHuman} | ${detail[k].withBehaviorSummary} | ${detail[k].g6PostHoc} |`);
    }
    R.push('');
    R.push('G-6 を事後へ移すのは、独立レビュアの席が委任で、規則に該当し、R3 と記録された変更だけです。R1・R2・記載なしの変更は移していません。');
    R.push('');
  }

  R.push('### 4. 機械検査の結果(未実施と通過を区別する)');
  R.push('');
  const g5 = A.machineChecks.gateG5;
  R.push('| 検査 | 結果 |');
  R.push('| --- | --- |');
  R.push(`| gate-g5(PR ごと) | ${g5 === NO_RECORD ? NO_RECORD : `成功 ${g5.success} / 成功以外 ${g5.notSuccess} / 記録なし ${g5.notRecorded}`} |`);
  R.push(`| テスト | ${A.machineChecks.test} |`);
  R.push(`| カバレッジ | ${A.machineChecks.coverage} |`);
  R.push(`| 静的解析 | ${A.machineChecks.staticAnalysis} |`);
  R.push(`| 依存の監査 | ${A.machineChecks.dependencyAudit} |`);
  R.push(`| 依存関係のライセンス | ${A.machineChecks.licenses} |`);
  R.push(`| 秘匿情報 | ${A.machineChecks.secretScan} |`);
  R.push(`| 依存の追加・更新の識別 | ${A.machineChecks.dependencyDiff} |`);
  R.push('');

  R.push('### 5. 残存リスク、既知の不具合、未回収の例外');
  R.push('');
  R.push(`- 未達のゲート: ${listOr(A.residual.unmet)}`);
  R.push(`- 逸脱(代償措置つきの逸脱と、1〜2名の体制の兼務): ${listOr(A.residual.deviations)}`);
  // 組織の外へ渡す形では、台帳の自由記述(内容)を出さない。行の ID と件数で出す
  const idsOnly = (v) => (Array.isArray(v) ? v.map((x) => String(x).split(' ')[0]) : v);
  R.push(`- 未回収の例外(技術負債台帳): ${listOr(external ? idsOnly(A.residual.openExceptions) : A.residual.openExceptions)}`);
  R.push(`- 独立した人の確認を経ていないが、例外承認の記録が対応づいた変更(未回収の例外): ${listOr(A.residual.exceptedChanges ?? [])}`);
  R.push(`- 未解決事項(技術負債台帳): ${listOr(external ? idsOnly(A.residual.openUnresolved) : A.residual.openUnresolved)}`);
  R.push(`- 未返却の負債(技術負債台帳): ${A.residual.openDebt === NO_RECORD ? NO_RECORD : `${A.residual.openDebt} 件`}`);
  R.push(`- 既知の不具合: ${A.residual.knownDefects}`);
  if (preInitDetail.total) {
    R.push(
      `- 構成の初期化より前に、製品のコードを変えたコミット: ${A.residual.preInitProductChanges} 件(独立した人の確認・リスク区分・検証の記載を確かめていない。一覧は品質レポートの「変更単位」にある)`
    );
  }
  R.push('');

  if (external) {
    // 組織の外へ渡す形。検出率の値と、適合性確認の結果の値を出さない
    R.push('### 6. 検出能力の測定(測定している事実・測定時点・推移の向き)');
    R.push('');
    const layer = (label, v) =>
      v.measuring
        ? `- ${label}: 測定している / 測定時点 ${v.measuredAt} / 推移の向き(前回の出荷との比較) ${v.trend}`
        : `- ${label}: ${v.note}${v.unmeasuredSince ? `。未測定のまま ${v.unmeasuredSince} の出荷から ${v.unmeasuredReleases} 回連続` : ''}`;
    R.push(layer('人の層(欠陥注入)', A.detectionExternal.human));
    R.push(layer('AI の層(欠陥注入)', A.detectionExternal.ai));
    for (const q of A.detectionExternal.conformity) R.push(`- AI の担い手の適合性確認(${q.seat}): ${q.status}`);
    R.push('');
    R.push('検出率の値は、組織の外へ出しません。値が契約の条件になると、測定が目標になるためです(標準 附属書H H.7)。適合性確認は、検出能力の測定ではありません。');
    R.push('');
  } else {
    R.push('### 6. 検出能力の測定値と測定時点');
    R.push('');
    const valueText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
    // 前回の出力が旧い形式(席ごとの配列)の場合、値は適合性確認の結果であり、検出能力の測定値ではない
    const prevAiText = (v) =>
      Array.isArray(v) ? `${UNMEASURED}(前回の出力は、適合性確認の結果を値にしていた: ${v.map((d) => `${d.seat} ${d.value}`).join(' / ')})` : valueText(v);
    R.push(
      `- 人の層(欠陥注入): ${A.detection.human === UNMEASURED ? `${UNMEASURED}(${streakText(humanStreak)})` : JSON.stringify(A.detection.human)}` +
        `(${prev((p) => (p.detection.human === UNMEASURED ? UNMEASURED : JSON.stringify(p.detection.human)))})`
    );
    R.push(`- AI の層(欠陥注入): ${valueText(A.detection.ai)}(${prev((p) => prevAiText(p.detection.ai))})`);
    if (aiStreak.since) R.push(`- AI の層の未測定の継続: ${streakText(aiStreak)}`);
    if (A.detection.conformity.length) {
      for (const q of A.detection.conformity) {
        R.push(`- 適合性確認の結果(${q.seat}): ${q.valid ? `${q.result}(${q.confirmedAt} 実施)` : `未実施または失効(${q.problem})`}`);
      }
    } else {
      R.push('- 適合性確認の結果: 対象なし(AI の担い手の宣言なし)');
    }
    R.push('');
    R.push(
      '適合性確認(第3章 3.4.2)の結果は、AI を担い手に置く前の確認の記録です。検出能力の測定値ではないため、別の行に出しています。' +
        '組織の外へ渡すときは、`evidence/assurance-disclosure.external.md` を使います。値を出さず、測定している事実・測定時点・推移の向きで示します。'
    );
    R.push('');
  }

  R.push('### 7. 生成の条件と、期間中の体制の変化点');
  R.push('');
  if (Array.isArray(A.generation.declaredPerformers)) {
    for (const p of A.generation.declaredPerformers) {
      R.push(`- 宣言した担い手(${p.seat}): モデル ${p.model ?? '未記入'} / 指示資産 ${p.instructions ?? '未記入'} / 権限 ${p.permissions ?? '未記入'}`);
    }
  } else {
    R.push(`- 宣言した担い手: ${A.generation.declaredPerformers}`);
  }
  R.push(`- コミットに記録された共著者: ${listOr(A.generation.observedCoAuthors)}`);
  R.push(`- 指示資産(CLAUDE.md・.claude)の最終変更: ${A.generation.instructionAssets}`);
  if (!A.generation.changeLogPresent) {
    R.push(`- 期間中の体制の変化点: ${NO_RECORD}(構成に changeLog がない)`);
  } else if (!A.generation.changePoints.length) {
    R.push('- 期間中の体制の変化点: なし');
  } else {
    R.push('');
    R.push('| 日付 | 種別 | 概要 | 結果 | 向き | 決定した者 | 即時通知(通知先・通知日) |');
    R.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const e of A.generation.changePoints) {
      // 組織の外へ渡す形では、概要(自由記述)・決定した者・通知先の氏名を出さない。記名と通知の有無で出す
      // 名簿の表記の変更は、旧い値と新しい値を出す(K74)。組織の外へ渡す形では、氏名・アカウントを出さず件数で出す
      const edits = e.rosterEdits ?? [];
      const editText = external
        ? edits.length
          ? `名簿の表記の変更 ${edits.length} 件(うち席の責任者の行 ${edits.filter((x) => x.seats?.length).length} 件)`
          : null
        : edits.length
          ? `名簿の表記の変更: ${edits.map(rosterEditText).join(' / ')}`
          : null;
      const summary = external
        ? ['(概要は組織の内側の開示にある)', editText].filter(Boolean).join('。')
        : [e.summary ?? '—', ...(e.arising ?? []), editText].filter(Boolean).join('。');
      const ALSO_ROLE = { predecessor: '前任の出荷判定者', decider: 'D-0 表1 の決定者', 'qa-dept': '品質保証部門' };
      const also = (e.notice?.also ?? []).map((a) => (external ? ALSO_ROLE[a.role] ?? a.role : `${ALSO_ROLE[a.role] ?? a.role} ${a.to ?? ''}`.trim()));
      const noticeText = !e.notice
        ? '対象外'
        : e.notice.self
          ? `通知する者と通知先が同一(自動で記録。${e.notice.at})`
          : e.notice.to
            ? `${external ? '記録あり' : `${e.notice.to}${e.notice.noTarget || resolveSigner(config, e.notice.to) ? '' : '(名簿の人でない名義)'}`}(${e.notice.at})${also.length ? `。あわせて: ${also.join(' / ')}` : ''}`
            : '**未記入**';
      const decided =
        (external ? (e.decidedBy ? '記名あり' : '—') : (e.decidedBy ?? '—')) + (e.appointerSigned ? '(決定者の任命を、組織上の任命権者の記名で行った)' : '');
      R.push(
        `| ${e.date} | ${KIND_NOTE[e.kind] ?? `${e.changePoint ?? '—'} ${e.kind}`} | ${summary} | ${e.result === 'no-change' ? '構成の変更なし' : '変更あり'} | ${DIRECTION_LABEL[e.direction] ?? '—'} | ${decided} | ${noticeText} |`
      );
    }
    R.push('');
  }
  if (A.generation.outages.length) {
    for (const o of A.generation.outages) R.push(`- ${outageText(o)}${o.summary && !external ? `。${o.summary}` : ''}`);
  } else {
    R.push(`- AI が使えなかった期間: ${A.generation.changeLogPresent ? '記録なし' : NO_RECORD}`);
  }
  R.push('');
  if (A.drift.length) {
    R.push('**宣言と実態のずれ**(体制の変化点として起票してください):');
    R.push('');
    if (external) R.push(`- ${A.drift.length} 件(内容は組織の内側の開示にある)`);
    else for (const d of A.drift) R.push(`- ${d}`);
    R.push('');
  }
  // 組織の外へ渡す形では、人の氏名とアカウントを出さない(席の名前と件数で示す)。構成から導いた値に
  // 氏名が含まれる場合(外部依頼の確認者、同一人物の組など)は、ここで伏せる
  return external ? R.map(redactNames) : R;
}
/** 名簿の氏名・id・アカウントと、席に書かれた氏名を伏せる。長い名前から置き換える */
const PERSON_TOKENS = [
  ...new Set(
    [...roster.flatMap((p) => [p?.name, ...(Array.isArray(p?.accounts) ? p.accounts : [])]), ...seats.map((s) => s.accountable)]
      .filter((v) => typeof v === 'string' && v.trim().length >= 2)
      .map((v) => v.trim())
  ),
].sort((a, b) => b.length - a.length);
function redactNames(line) {
  let out = line;
  for (const t of PERSON_TOKENS) out = out.split(t).join('(氏名は出さない)');
  return out;
}
R.push(...renderAssurance(false));

// 出荷判定者の異議。開示が4つの事項に当たる場合、異議の有無とあわせて理由を要する(標準 第4章 G-8)
R.push('## 出荷判定者の異議で検討する事項');
R.push('');
R.push(
  '出荷判定者は、開示された未達・未測定についての異議の有無を、リリース決裁(G-8)の決断の記録へ記載します。' +
    '開示が次の事項に当たる場合は、異議の有無とあわせて理由を書きます。「異議なし」とする場合も同じです。理由の無い記載は、空欄と同じ記載の欠落です。'
);
R.push('');
if (g8Objection.matters.length) for (const m of g8Objection.matters) R.push(`- 事項${m.id}: ${m.text}`);
else R.push('- 機械で判定できた範囲では、理由の記載を要する事項に当たりません。異議の有無の記載は要ります');
for (const n of g8Objection.notJudged) R.push(`- 判定していない: ${n}`);
R.push('');
if (g8Objection.records.length) {
  R.push('| G-8 の記録 | 対象 | 異議の欄 | 理由の記載 |');
  R.push('| --- | --- | --- | --- |');
  for (const r of g8Objection.records) {
    let reason;
    if (!r.recorded) reason = '—';
    else if (r.mattersApplicable === null) reason = '前回の出荷の開示への記載。前回の出力が事項の一覧を持たないため、判定していない';
    else if (!r.mattersApplicable.length) reason = '理由の記載を要する事項なし';
    else if (r.reasonPresent) reason = `事項 ${r.mattersApplicable.join('・')} に当たる。記載あり(内容は判定していない)`;
    else reason = `事項 ${r.mattersApplicable.join('・')} に当たるが、**理由の記載がない(記載の欠落)**。記載は異議の有無だけ`;
    R.push(`| ${r.file} | ${r.target ?? '未記入'} | ${r.recorded ? '記載あり' : '**空欄(記載の欠落)**'} | ${reason} |`);
  }
  R.push('');
} else {
  R.push('当該出荷の範囲に、G-8 の記録はありません。');
  R.push('');
}
R.push('この検査の方法と限界:');
R.push('');
R.push('- 欠落とするのは、異議の欄が空欄の記録と、開示が上の事項に当たるのに、欄の記載が異議の有無を表す語だけの記録です。事項に当たらない開示では、異議の有無の語だけで足ります');
R.push('- 理由の有無は、欄の記載から「異議」「なし」「あり」などの語と句読点を除いた残りがあるかどうかで判別しています。**理由の内容が、開示された事実に応えているかは判定していません**。内部監査の観点14 が確かめます');
R.push('- **今回の出荷の G-8 の記録は、この集約の後に作られます**。検査されるのは、記録を書いた後に集約し直したとき(起点に前回のタグ、終点に今回のタグを指定)、または次の出荷の集約のときです');
R.push('- 対象にするのは、当該出荷の範囲で追加された G-8 の記録と、「対象」が終点のタグを指す G-8 の記録です。「対象」が今回と前回のどちらのタグも指さない記録は、今回の開示への記載として扱います');
R.push('- 事項3 は、前回の出荷の出力が無い場合は判定していません');
R.push('');

R.push('## ゲートの構成');
R.push('');
R.push('| ゲート | 状態 |');
R.push('| --- | --- |');
for (const [k, g] of Object.entries(config.gates)) R.push(`| ${g.label} | ${g.state} |`);
R.push('');

R.push('## 変更単位');
R.push('');
R.push(`- コミット: ${commits.length} 件`);
if (preInitCommits.length) {
  const pi = preInitDetail;
  R.push(
    `- 構成の初期化より前の履歴(pre-init): ${pi.total} 件。上の件数にも変更の件数にも数えていない(初期化のコミット ${initCommit.slice(0, 8)} 自身は対象)。` +
      `内訳: テンプレート由来の初期コミット ${pi.templateOrigin} 件 / 記録だけのコミット ${pi.recordOnly} 件 / 製品のコード(記録の置き場の外)を変えたコミット ${pi.product.length} 件。` +
      '初期化より前のコミットは、独立した人の確認・リスク区分・検証の記載を確かめていない(欠落として扱わない)'
  );
  for (const p of pi.product) R.push(`  - ${p.commit} ${p.subject}(記録の置き場の外のファイル ${p.files} 件)`);
}
R.push(
  `- PR を経ていないコミット: ${directChanges.length} 件(うち、記録だけのコミット ${count(directChanges, (d) => d.exempt === 'record-only')} 件と、ファイルの変更を持たないコミット ${count(directChanges, (d) => d.exempt === 'empty')} 件は、変更の件数とリスク区分の対象外)`
);
R.push(
  `- 記録の置き場として扱うパス: ${RECORD_PATHS.join(' / ')}。` +
    'CLAUDE.md は、生成区間の外が変わっていないコミットに限る。process.config.json は、変化点の記録(changeLog)が追記され、既存の記録が保たれているコミットに限る'
);
R.push(`- PR: ${prs.length} 件(PR のマージコミットと一致するコミットだけを、PR の変更として数えている)`);
const claimed = directChanges.filter((d) => d.claimedPr);
if (claimed.length) {
  R.push(`- 件名は PR の番号を持つが、PR の変更と認めなかったコミット: ${claimed.length} 件(${claimed.map((d) => `${d.commit} → ${d.claimedPr.why}`).join(' / ')})`);
}
R.push('');
if (prs.length) {
  R.push('| PR | マージの方式 | リスク区分 | G-5 | 承認(人のアカウント。最後の状態) | 作成を指示した者 | 独立した人の確認 | レビュアの挙動要約 | 作成側の検証の記載 |');
  R.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const METHOD = { squash: 'スカッシュ', 'merge-commit': 'マージコミット', rebase: 'リベース' };
  const SUMMARY_PLACE = { review: 'あり(承認レビューの本文)', 'gate-record': 'あり(G-6 の判定記録)' };
  for (const p of prs) {
    const ind = p.g6.independent;
    const instructors =
      [...ind.instructors, ...ind.unresolvedInstructors.map((t) => `${t}(名簿と対応づかない)`)].join(' / ') || '—';
    const confirmed = ind.counted
      ? `あり(${ind.by.join(' / ')})`
      : `**なし**(${ind.reasonText}${p.g6PostHoc ? '。G-6 は事後の抜き取りで判定する' : ''}${p.exceptionRecords.length ? `。例外承認の記録: ${p.exceptionRecords.join(', ')}` : ''}${p.developerSeatCollab ? `。開発者の席は協働: 開発者の席の責任者の承認 ${p.developerApproved ? 'あり' : '**なし**'}` : ''})`;
    R.push(
      `| #${p.number} | ${METHOD[p.mergeMethod] ?? p.mergeMethod} | ${p.riskClass ?? '未記入'} | ${p.g5} | ${p.g6.approvers.join(' / ') || '—'} | ${instructors}${ind.instructorsByDefault && p.recordFound ? '(既定値による)' : ''} | ${confirmed} | ${ind.counted ? (SUMMARY_PLACE[p.g6.reviewerSummarySource] ?? '**なし**') : '—'} | ${p.authorVerificationPresent ? 'あり' : '**なし**'} |`
    );
  }
  R.push('');
  R.push(
    '「作成側の検証の記載」は、PR 本文の「検証方法と結果」です。レビュアの挙動要約(G-6 基準2)とは別の記録です。開発者の席の委任の範囲の変更では担い手が実行結果の証拠として書き、人確定・協働の変更では人が書きます。' +
      '独立レビュー(G-6)の状態に依らず、記載の無い変更は欠落です。'
  );
  R.push('');
}
if (directProduct.length) {
  R.push('| PR を経ていないコミット | 件名 | リスク区分 | 作成側の検証の記載 | 独立した人の確認 |');
  R.push('| --- | --- | --- | --- | --- |');
  const sourceText = (s) => (s === 'trailer' ? 'トレーラ' : `判定記録 ${s}`);
  for (const d of directProduct) {
    R.push(
      `| ${d.commit} | ${d.subject.replace(/[|]/g, '/')} | ${d.riskClass ? `${d.riskClass}(${sourceText(d.riskClassSource)})` : '**未記入**'} | ${d.authorVerificationPresent ? `あり(${sourceText(d.authorVerificationSource)})` : '**なし**'} | ${d.independent.counted ? `あり(G-6 の判定記録: ${d.independent.by.join(' / ')})` : `**なし**(${d.independent.reasonText}${d.exceptionRecords.length ? `。例外承認の記録: ${d.exceptionRecords.join(', ')}` : ''})`} |`
    );
  }
  R.push('');
  R.push('PR を経ていないコミットは、リスク区分をトレーラ Risk、作成側の検証の記載をトレーラ Verification から読みます。機械が見るのは有無だけです。内容は見ていません。');
  R.push('');
}

if (prs.some((p) => p.g6PostHoc) || period) {
  R.push('## 事後の抜き取り(G-6 を事後へ移した変更)');
  R.push('');
  if (sampling.length) {
    R.push('| PR | 事後の抜き取りの記録(G-6 の判定記録、確定の形態「委任」) |');
    R.push('| --- | --- |');
    for (const x of sampling) R.push(`| #${x.pr} | ${x.sampled ? x.records.map((r) => `${r.file}(${r.result ?? '結果の記載なし'})`).join(' / ') : 'なし(抜き取られていない)'} |`);
    R.push('');
    R.push(
      `抜き取った変更 ${count(sampling, (x) => x.sampled)} 件 / 抜き取られていない変更 ${count(sampling, (x) => !x.sampled)} 件。` +
        '抜き取りの数と頻度が第8章「事後監査の手続」を満たすかは、機械では判定していません。抜き取られていない変更を、承認・通過として扱いません。'
    );
  } else {
    R.push('G-6 を事後へ移した変更はありません。');
  }
  R.push('');
}

R.push('## 記録');
R.push('');
R.push(`- カバレッジ: ${coverage.measured ? `${coverage.pct}%(下限 ${coverage.threshold}%)` : `未測定(${coverage.reason})`}`);
R.push(`- ゲート判定記録: 当該出荷の範囲で追加 ${records.length} 件(リポジトリの全体 ${gateRecords.length} 件)`);
R.push(`- 判断記録(ADR): ${adrs.length} 件`);
R.push(`- 技術負債台帳: ${exists(debtFile) ? 'あり' : '**なし**'}`);
R.push(`- 運用引き継ぎ文書: ${exists(handoverFile) ? 'あり' : '**なし**'}`);
R.push(`- 知財潔白性の検査: ${licenseScan.scanRun ? '実施' : '**未実施**'}`);
R.push('');

if (gaps.length) {
  R.push('## 欠落');
  R.push('');
  for (const g of gaps) R.push(`- ${g}`);
  R.push('');
}

R.push('---');
R.push('');
R.push('このレポートは記録の突合です。品質の再判定ではありません。');
R.push('出荷判定者は数値の十分性を判定しません。閾値の充足は G-5 が機械で判定済みです。');

fs.writeFileSync(path.join(ROOT, OUT_DIR, 'quality-report.md'), R.join('\n') + '\n', 'utf8');

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, R.join('\n') + '\n');
}

// 組織の外へ渡す保証の開示。項目6 だけを、値を出さない形にする。人が差し替える手順を持たない
const X = [];
X.push(`# 保証の開示(組織の外へ渡す形) ${range}`);
X.push('');
X.push(`生成: ${evidence.generatedAt}`);
X.push('');
X.push(
  '出荷判定の証跡の集約が、品質レポートと同じ記録から機械的に出力したものです。人が書き換えていません。' +
    '項目6 は、検出率の値ではなく、測定している事実・測定時点・推移の向きで示しています。' +
    '人の氏名・アカウントと、自由記述(変化点の概要、台帳の内容、一時緩和の理由、宣言と実態のずれ)は出していません。席の名前と件数で示しています。他の値は、組織の内側で読むものと同じです。'
);
X.push('');
if (PERIOD_CUT) {
  X.push(`${PERIOD_CUT}。`);
  X.push('');
}
if (gaps.length) {
  X.push(`**記録の欠落が ${gaps.length} 件あります。この開示は完備していません。**`);
  X.push('');
}
X.push(...renderAssurance(true));
fs.writeFileSync(path.join(ROOT, OUT_DIR, 'assurance-disclosure.external.md'), X.join('\n') + '\n', 'utf8');

console.log(
  `${OUT_DIR}/evidence.json、${OUT_DIR}/quality-report.md、${OUT_DIR}/assurance-disclosure.external.md を出力しました(${range})`
);

for (const u of unmet) warn(`未達: ${u.label} — ${u.reason}`);
for (const d of assurance.drift) warn(`宣言と実態のずれ: ${d}`);
for (const g of gaps) fail(g);

if (gaps.length) {
  console.log('');
  console.log(`記録の欠落が ${gaps.length} 件あります。出荷判定(G-7)は通過できません`);
  process.exit(1);
}
notice('記録は完備しています');
