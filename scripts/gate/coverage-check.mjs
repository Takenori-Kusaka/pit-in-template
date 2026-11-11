// カバレッジを基準値と比べる(G-5 基準3)。
//
//   node scripts/gate/coverage-check.mjs [--base <比較の起点>]
//
// 測る範囲は構成 ci.coverageScope で決める(標準 第4章 G-5「カバレッジの測る範囲と規模(基準3)」。process-compass #296)。
//   changed  変更で加えた・変えた行(git の差分の追加行)だけを分母にする。既定。行単位の被覆(アダプタの coverageDetail)を要する
//   whole    コードの全体の行の割合(アダプタの coverageSummary)。変更の未被覆が全体の被覆で薄まることを、結果と保証の開示に出す
// 構成に範囲が無い場合は、従来どおり whole として扱い、範囲が既定から補われたことを結果と保証の開示に出す(既存の採用者を
// 壊さない。緩める向きの変更ではなく、#296 より前の挙動の維持。突合 X-4)。新しく生成する構成は、アダプタが変更の範囲を
// 測れるなら changed を書く(generate-profile.mjs)。
//
// 変更の範囲の分母は、追加行のうち文の開始行に当たる行である(istanbul の行の割合と同じ近似)。複数行にわたる文の
// 2 行目以降だけを変えた変更は分母に入らない(限界。結果の approximation に出す)。
// 比較の起点は --base、無ければ GITHUB_BASE_REF(origin/<基底>)。changed で起点を解決できなければ失敗させる(測っていない状態を
// 通過として残さない)。
//
// 結果(evidence/coverage-result.json)には、割合・範囲・分母・測っていない製品のファイルの数を書く。割合だけでは、
// 2 行中 2 行の 100% と、2,000 行中 1,600 行の 80% を区別できないためである(ADR-0078 決定6)。
// 被覆の記録の形式はアダプタの coverageFormat で決める(process-compass #360。IMPL-0259)。
//   istanbul         node。coverageSummary は coverage-summary.json、coverageDetail は coverage-final.json(文の開始行)
//   coverage-py      python。coverage.py の coverage json(pytest-cov の --cov-report=json)。files.<path>.executed_lines・missing_lines が
//                    文の開始行の被覆。1つのファイルで全体と変更の範囲を兼ねる。全体の割合は、テストのファイル(.claude/guard.json の
//                    testPatterns)を除いた文の割合(IMPL-0496。branch の設定に依らない)
//   go-coverprofile  go。go test -coverprofile の coverage.out(ブロック単位。パスは import のパス)。全体の割合は
//                    Σ(回数 > 0 のブロックの文の数) / Σ 文の数(go tool cover -func の合計と同じ)。変更の範囲は、ソースの構文木
//                    (_go-stmt-lines/main.go。go が要る)で得た各文の開始行に、その文を含む最も内側のブロックの回数を当てる(gocov 系の方式)
// coverageFormat が無いアダプタは istanbul として読む(#360 より前のアダプタの形)。
// 言語のアダプタ(none・undetermined 以外)で coverageSummary が null なら、基準3 の未実施として失敗に数える(IMPL-0495。ADR-0124 が
// ADR-0085 決定2 の go の句を置き換える)。none(手書きの要素の無い場合)と undetermined は対象なしの扱いの規定どおり通知して通す。
// none の手書きの要素(stacks)で宣言したスタックは、要素ごとの coverageSummary を要し、無ければ基準3 の未実施として失敗に数える
// (process-compass #363 の突合 X3-1)。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadAdapter, ROOT, fail, notice, warn, targetState, nestedTargetProblem, adapterProjectDir, matchGlob, isFilledValue, unquoteGitPath } from './config.mjs';
import { isProductCode, THRESHOLD_FILES } from './check-pr.mjs';

export const COVERAGE_SCOPES = ['changed', 'whole'];
export const SCOPE_LABEL = { changed: '変更で加えた・変えたコード', whole: 'コードの全体' };
/** 行単位の被覆を読める拡張子(node のアダプタ。istanbul の coverage-final.json に載る) */
const NODE_MEASURABLE = /\.(m?[jt]sx?|c[jt]s)$/i;

/** 被覆の記録の形式。measurable は行単位の被覆を読める製品のファイル、guide は案内の文の差し込み */
export const COVERAGE_FORMATS = {
  istanbul: {
    measurable: (f) => NODE_MEASURABLE.test(f),
    detailHint: 'node では c8 に --reporter=json を足します(行単位の被覆 coverage-final.json を出すため)',
    targetHint: '測定の対象(node では package.json の coverage の --include)を、製品のコードの置き場に合わせてください',
    readHint: 'istanbul 形式(coverage-summary.json の total.lines)',
  },
  'coverage-py': {
    measurable: (f) => /\.py$/i.test(f),
    detailHint: 'python では coverage.py の coverage json(pytest-cov の --cov-report=json)の files の行の記録を使います',
    targetHint: '測定の対象(python では [tool.coverage.run] の source、または pytest の --cov=<パッケージ>)を、製品のコードの置き場に合わせてください。source を書かないと、テストから import されない製品のファイルは記録に載りません',
    readHint: 'coverage.py の coverage json の形式(files.<パス>.executed_lines・missing_lines)',
  },
  'go-coverprofile': {
    measurable: (f) => /\.go$/i.test(f) && !/_test\.go$/i.test(f),
    detailHint: 'go では go test -coverprofile=coverage.out の記録と、ソースの構文木(scripts/gate/_go-stmt-lines。go が要る)を使います',
    targetHint: '測定の対象(go では go test の対象のパッケージ ./... と -coverpkg)を、製品のコードの置き場に合わせてください。projectDir の go.mod の module 行で記録のパスを戻します(go.work の複数の module・replace の先は扱いません)',
    readHint: 'go の coverprofile の形式(先頭の mode: の行と、ブロックの行)',
  },
};

/** アダプタの被覆の記録の形式。coverageFormat が無ければ istanbul(#360 より前の形)。未知の値は null */
export function coverageFormatOf(adapter) {
  const v = adapter?.coverageFormat;
  if (v === undefined || v === null) return 'istanbul';
  return Object.hasOwn(COVERAGE_FORMATS, v) ? v : null;
}

/** 言語のアダプタか(none・undetermined は対象なしの扱いの規定に従う。IMPL-0495) */
export const isLanguageAdapter = (adapter) => !['none', 'undetermined'].includes(adapter?.id);

/** アダプタが変更の範囲を測れるか(行単位の被覆の置き場を持つか) */
export const canMeasureChanged = (adapter) => typeof adapter?.coverageDetail === 'string' && adapter.coverageDetail.length > 0;

/** 新しく生成する構成に書く範囲(アダプタが変更の範囲を測れるなら changed、測れないなら whole) */
export const derivedCoverageScope = (adapter) => (canMeasureChanged(adapter) ? 'changed' : 'whole');

/**
 * 適用する測る範囲。構成 ci.coverageScope があればそれ。無ければ従来どおり whole(既存の構成を壊さない。突合 X-4)。
 * declared は構成に範囲が書かれていたか。defaulted は既定から補ったか
 */
export function coverageScopeOf(config, adapter) {
  const v = config?.ci?.coverageScope;
  if (COVERAGE_SCOPES.includes(v)) return { scope: v, declared: true, defaulted: false };
  return { scope: 'whole', declared: false, defaulted: true, invalid: v !== undefined && v !== null ? v : undefined };
}

/** 企画書の範囲の行の名前 */
export const BRIEF_SCOPE_ROW = 'カバレッジの測る範囲(G-5 基準3)';

/**
 * 企画書に範囲の行が無いことの扱い(突合 X-4)。行は #296 で足した。既に G-1 を通過した企画書を遡って失敗させず、
 * 欠落として /pit と出荷の証跡の集約に出す。G-1 を通過する前の企画書(新しい G-1 の判定)では必須。
 * records は config.mjs の readGateRecords() の戻り値。戻り値: null(行がある・企画書が無い)、'gap'(欠落として出す)、'required'(失敗させる)
 */
export function briefScopeRowState(briefText, records) {
  if (briefText === null || briefText === undefined) return null;
  if (briefCoverageScope(briefText) !== null) return null;
  const g1Passed = (records ?? []).some((r) => /^G-1(?!\d)/.test(r.gate ?? '') && r.result === '通過');
  return g1Passed ? 'gap' : 'required';
}
export const BRIEF_SCOPE_GAP_TEXT =
  `企画書(docs/project-brief.md)に「${'カバレッジの測る範囲(G-5 基準3)'}」の行がありません(#296 で足した行。G-1 を通過済みのため遡って失敗させません)。` +
  '記載の欠落です。様式(templates/06-project-brief.md)から行を写し、構成の ci.coverageScope と同じ範囲を書きます(範囲の記録と構成の一致は契約検査が確かめます)';

// unquoteGitPath は config.mjs へ移した(check-pr.mjs の差分の読み取りと共通。突合 X-1)。互換のため再び公開する
export { unquoteGitPath };

/**
 * G-1 企画書(docs/project-brief.md)の「カバレッジの測る範囲(G-5 基準3)」の行の値。行が無ければ null、
 * 未記入(空欄・様式の説明 <…> のまま)なら { scope: null, raw, blank: true }、値が範囲を表していなければ { scope: null, raw }。「変更」を含めば changed、「全体」を含めば whole(両方は判定しない)
 */
export function briefCoverageScope(text) {
  const row = String(text ?? '')
    .split(/\r?\n/)
    .find((l) => /^\|\s*\**カバレッジの測る範囲/.test(l));
  if (!row) return null;
  const cells = row.replace(/\*/g, '').trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const raw = cells[1] ?? '';
  if (!isFilledValue(raw)) return { scope: null, raw, blank: true };
  const changed = /変更/.test(raw);
  const whole = /全体/.test(raw);
  return { scope: changed && !whole ? 'changed' : whole && !changed ? 'whole' : null, raw };
}

/** git diff -U0 の出力から、ファイルごとの追加行の行番号(変更後の側)を読む */
export function parseAddedLines(diffText) {
  const out = new Map();
  let file = null;
  for (const line of String(diffText ?? '').split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = unquoteGitPath(line.slice(4).replace(/\t$/, '').trimEnd());
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < count; i++) out.get(file).add(start + i);
    }
  }
  for (const [f, s] of out) if (!s.size) out.delete(f);
  return out;
}

/** istanbul の FileCoverage から行ごとの実行回数を出す(istanbul-lib-coverage の getLineCoverage と同じ: 文の開始行の最大値) */
export function lineHits(fileCoverage) {
  const map = new Map();
  const sm = fileCoverage?.statementMap ?? {};
  for (const [k, count] of Object.entries(fileCoverage?.s ?? {})) {
    const line = sm[k]?.start?.line;
    if (!Number.isInteger(line)) continue;
    if (!map.has(line) || map.get(line) < count) map.set(line, count);
  }
  return map;
}

/** coverage-final.json のキー(絶対パス、または相対パス)を、リポジトリからの相対パスへ寄せる */
export function indexCoverage(final, root) {
  const out = new Map();
  for (const [k, v] of Object.entries(final ?? {})) {
    const abs = path.isAbsolute(v?.path ?? k) ? (v?.path ?? k) : path.join(root, v?.path ?? k);
    out.set(path.relative(root, abs).split(path.sep).join('/'), v);
  }
  return out;
}

/**
 * 変更の範囲の割合。added は ファイル → 追加行の集合、coverage は 相対パス → FileCoverage、isTarget は分母に入れる製品のファイルか。
 * 分母は、追加行のうち実行できる行(被覆の記録に文がある行)。測れる拡張子の製品のファイルが被覆の記録に無ければ、
 * 測っていない製品のファイルとして数える(分母から黙って落とさない)
 */
export function changedScopeCoverage({ added, coverage, isTarget, measurable = (f) => NODE_MEASURABLE.test(f), hitsOf = lineHits, excluded = null }) {
  let denominator = 0;
  let covered = 0;
  let excludedChanged = 0;
  const unmeasured = [];
  const notMeasurable = [];
  const uncovered = [];
  for (const [file, lines] of added) {
    if (!isTarget(file)) continue;
    if (!measurable(file)) {
      notMeasurable.push(file);
      continue;
    }
    const fc = coverage.get(file);
    if (!fc) {
      unmeasured.push(file);
      continue;
    }
    const hits = hitsOf(fc);
    const ex = excluded?.get(file);
    const miss = [];
    for (const l of [...lines].sort((a, b) => a - b)) {
      if (ex?.has(l)) excludedChanged++;
      if (!hits.has(l)) continue;
      denominator++;
      if (hits.get(l) > 0) covered++;
      else miss.push(l);
    }
    if (miss.length) uncovered.push({ file, lines: miss.slice(0, 50) });
  }
  const pct = denominator ? Math.round((covered / denominator) * 10000) / 100 : null;
  return { denominator, covered, pct, unmeasured, notMeasurable, uncovered, excludedChanged };
}

/** 割合(百分率、小数2桁)。分母 0 は null */
const percent = (covered, total) => (total ? Math.round((covered / total) * 10000) / 100 : null);

/** 記録のパス(所在 projBase からの相対・絶対、OS の区切り)を、リポジトリからの相対パス('/' 区切り)へ寄せる */
export function repoRelative(p, projBase, root) {
  const s = String(p).replace(/\\/g, '/');
  const abs = path.isAbsolute(s) || /^[A-Za-z]:\//.test(s) ? s : path.join(projBase, s);
  return path.relative(root, abs).split(path.sep).join('/');
}

// ---------------------------------------------------------------- coverage.py(coverage json)

/**
 * coverage.py の coverage json を読む。files のキーを repo 相対へ寄せ、行の実行回数(executed_lines を 1、missing_lines を 0。
 * どちらも文の開始行)と除外の行(excluded_lines)を返す。全体の割合は isTest のファイルを除いた文の割合(IMPL-0496)。
 * files が無ければ null(形式を読めない)
 */
export function readCoveragePy(raw, { projBase, root, isTest = () => false }) {
  if (!raw || typeof raw.files !== 'object' || raw.files === null) return null;
  const files = new Map();
  const excluded = new Map();
  let statements = 0;
  let covered = 0;
  let excludedLines = 0;
  const testFiles = [];
  for (const [k, v] of Object.entries(raw.files)) {
    const rel = repoRelative(k, projBase, root);
    const hits = new Map();
    for (const l of v?.missing_lines ?? []) if (Number.isInteger(l)) hits.set(l, 0);
    for (const l of v?.executed_lines ?? []) if (Number.isInteger(l)) hits.set(l, 1);
    files.set(rel, hits);
    excluded.set(rel, new Set((v?.excluded_lines ?? []).filter(Number.isInteger)));
    if (isTest(rel)) {
      testFiles.push(rel);
      continue;
    }
    statements += hits.size;
    covered += [...hits.values()].filter((c) => c > 0).length;
    excludedLines += excluded.get(rel).size;
  }
  return { files, excluded, statements, covered, pct: percent(covered, statements), testFiles, excludedLines, branch: raw.meta?.branch_coverage === true };
}

/** coverage.py の近似と限界(結果の limits と通知に出す。H-7 の D) */
function coveragePyLimits(py, { changedExcluded = null } = {}) {
  const out = [];
  out.push(
    `\`# pragma: no cover\` と構成の exclude_lines で除外した行は分母に入りません(全体で除外の行 ${py.excludedLines} 行${changedExcluded === null ? '' : `、変更の行のうち ${changedExcluded} 行`})。` +
      '行の中の除外の注記は、閾値・除外設定の同時変更の検査(thresholdFiles)に掛かりません'
  );
  out.push(
    py.branch
      ? 'branch を有効にした記録です。本判定は文の割合だけで数え、分岐は判定しません。coverage.py の percent_covered(文と分岐の合算)とは値が異なります'
      : '本判定は文の割合で数えます。branch を有効にすると coverage.py の percent_covered は文と分岐の合算に変わりますが、本判定は分岐を判定しません'
  );
  if (py.testFiles.length) out.push(`全体の割合から、テストのファイル(.claude/guard.json の testPatterns)${py.testFiles.length} 件を除いて数えました(${py.testFiles.slice(0, 5).join(', ')})`);
  return out;
}

// ---------------------------------------------------------------- go(coverprofile)

/**
 * go test -coverprofile の記録を読む。戻り値 { mode, blocks: [{ file, sl, sc, el, ec, numStmt, count }] }。
 * 同じブロックの重複(-coverpkg で複数のテストのバイナリが同じパッケージを測る)は1つにまとめ、mode set は最大、count・atomic は和を取る
 * (go tool cover と同じ)。形式でなければ null
 */
export function parseCoverprofile(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const head = lines[0]?.match(/^mode:\s*(\w+)\s*$/);
  if (!head) return null;
  const mode = head[1];
  const byKey = new Map();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const m = line.match(/^(.+):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/);
    if (!m) return null;
    const key = `${m[1]}:${m[2]}.${m[3]},${m[4]}.${m[5]}`;
    const count = Number(m[7]);
    const prev = byKey.get(key);
    if (prev) prev.count = mode === 'set' ? Math.max(prev.count, count) : prev.count + count;
    else byKey.set(key, { file: m[1], sl: Number(m[2]), sc: Number(m[3]), el: Number(m[4]), ec: Number(m[5]), numStmt: Number(m[6]), count });
  }
  return { mode, blocks: [...byKey.values()] };
}

/** 全体の割合: Σ(回数 > 0 のブロックの文の数) / Σ 文の数(go tool cover -func の合計と同じ) */
export function coverprofileTotals(profile) {
  let statements = 0;
  let covered = 0;
  for (const b of profile.blocks) {
    statements += b.numStmt;
    if (b.count > 0) covered += b.numStmt;
  }
  return { statements, covered, pct: percent(covered, statements) };
}

/** go.mod の module 行のパス。読めなければ null */
export function goModulePath(goModText) {
  const m = String(goModText ?? '').match(/^\s*module\s+("?)([^\s"]+)\1\s*(?:\/\/.*)?$/m);
  return m ? m[2] : null;
}

/** 記録のパス(import のパス)を repo 相対へ戻す。module の外のパスは null(戻せない) */
export function goProfilePath(p, { module, projBase, root }) {
  const s = String(p).replace(/\\/g, '/');
  if (module && s.startsWith(`${module}/`)) return repoRelative(s.slice(module.length + 1), projBase, root);
  if (path.isAbsolute(s) || /^[A-Za-z]:\//.test(s)) return repoRelative(s, projBase, root);
  return null;
}

/** 文の範囲を出す Go のプログラムの所在 */
export const GO_STMT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '_go-stmt-lines');

/**
 * ソースを構文木(go/parser)で読み、各文の範囲 [開始行, 開始列, 終了行, 終了列] を得る。absFiles は絶対パス。
 * 戻り値 { files: { <絶対パス>: [[sl, sc, el, ec], ...] }, errors: { <絶対パス>: <文> } }。go が無い・実行に失敗すれば例外
 */
export function goStatementRanges(absFiles, { goBin = process.env.PIT_IN_GO ?? 'go' } = {}) {
  const env = { ...process.env, GOFLAGS: '', GOWORK: 'off' };
  const out = execFileSync(goBin, ['run', 'main.go'], { cwd: GO_STMT_DIR, input: absFiles.join('\n') + '\n', encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out);
}

/**
 * 1つのファイルの行の実行回数。各文の開始位置を含む最も内側のブロックの回数を、その文の開始行に当てる(行は最大値)。
 * mismatched は、当てた文の数がブロックの文の数(numStmt)と食い違うブロックの数(近似の開示)。unassigned はどのブロックにも入らない文の数
 */
export function goLineHits(blocks, stmts) {
  const before = (al, ac, bl, bc) => al < bl || (al === bl && ac < bc);
  const assigned = new Map(blocks.map((b) => [b, 0]));
  const hits = new Map();
  let unassigned = 0;
  for (const [l, c] of stmts) {
    let best = null;
    for (const b of blocks) {
      const inside = !before(l, c, b.sl, b.sc) && before(l, c, b.el, b.ec);
      if (!inside) continue;
      if (!best || !before(b.sl, b.sc, best.sl, best.sc)) best = b;
    }
    if (!best) {
      unassigned++;
      continue;
    }
    assigned.set(best, assigned.get(best) + 1);
    if (!hits.has(l) || hits.get(l) < best.count) hits.set(l, best.count);
  }
  const mismatched = [...assigned].filter(([b, n]) => n !== b.numStmt).length;
  return { hits, mismatched, unassigned };
}

const GO_APPROXIMATION =
  '分母は追加行のうち文の開始行に当たる行。文の開始行はソースの構文木(go/parser)で得て、その文の開始位置を含む最も内側のプロファイルのブロックの回数を当てる(gocov 系の方式)。' +
  '構文木の文とプロファイルのブロックの対応は近似であり、ブロックに当てた文の数がプロファイルの文の数と食い違うブロックの数を goBlocksMismatched に出す。複数行にわたる文の 2 行目以降だけの変更は分母に入らない';

function gitIn(root) {
  return (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
}

/** リポジトリが追跡しているファイルのうち、製品のコード(check-pr と同じ分類)で、テストでないもの */
export function productFiles(root, adapter) {
  const git = gitIn(root);
  const files = (git(['ls-files', '-z']) ?? '').split('\0').filter(Boolean);
  const isTarget = productFilter(root, adapter);
  return files.filter(isTarget);
}

/** テストのファイルの識別(.claude/guard.json の testPatterns。ガードの設定が無ければ識別しない) */
export function testFilter(root) {
  let testPatterns = [];
  try {
    testPatterns = JSON.parse(fs.readFileSync(path.join(root, '.claude/guard.json'), 'utf8')).testPatterns ?? [];
  } catch {
    // ガードの設定が無ければ、テストの識別を行わない
  }
  return (f) => testPatterns.some((g) => matchGlob(g, f));
}

/** 分母へ入れる製品のファイルか(製品のコードで、テストの置き場でない) */
export function productFilter(root, adapter) {
  const isTest = testFilter(root);
  const thresholdGlobs = [...THRESHOLD_FILES, ...(Array.isArray(adapter?.thresholdFiles) ? adapter.thresholdFiles : [])];
  const head = (f) => {
    try {
      return fs.readFileSync(path.join(root, f), 'utf8').slice(0, 200);
    } catch {
      return null;
    }
  };
  return (f) => isProductCode(f, thresholdGlobs, head) && !isTest(f);
}

/**
 * 判定する。戻り値は { code, result, messages: [{ level, text }] }。code は終了コード。
 * root・config・adapter・base は試験で差し替えられる
 */
export function evaluateCoverage({ root = ROOT, config, adapter, base = null }) {
  const messages = [];
  const say = (level, text) => messages.push({ level, text });
  const threshold = config.ci?.coverageThreshold ?? 80;
  const { scope, declared, invalid } = coverageScopeOf(config, adapter);
  if (invalid !== undefined) {
    say('fail', `構成 ci.coverageScope の値 "${invalid}" は changed / whole のいずれでもありません`);
    return { code: 1, result: { measured: false, reason: 'ci.coverageScope の値が不正', scope: null }, messages };
  }
  if (!declared) {
    say(
      'warn',
      `構成に測る範囲(ci.coverageScope)がありません。従来どおり「${SCOPE_LABEL[scope]}」で測ります(範囲を既定から補った旨を結果と保証の開示に出します)。` +
        `範囲を記録するには /process-change(種別 settings)で ci.coverageScope を書き、企画書(G-1)の「カバレッジの測る範囲(G-5 基準3)」と揃えます` +
        (canMeasureChanged(adapter) ? `。changed にする場合の行単位の被覆は ${adapter.coverageDetail} です。${COVERAGE_FORMATS[coverageFormatOf(adapter)]?.detailHint ?? ''}` : '')
    );
  }
  const scopeInfo = { scope, scopeLabel: SCOPE_LABEL[scope], scopeDeclared: declared, scopeDefaulted: !declared };

  // 手書きの要素(none の stacks)で宣言したスタックは、要素ごとにカバレッジを報告し、要素ごとに同じ基準値と比べる。
  // 報告の無い要素は基準3 の未実施であり、失敗に数える(標準 第4章 G-5「製品のすべてのスタック」。process-compass #363 の突合 X3-1)
  if (adapter.id === 'none' && Array.isArray(adapter.stacks) && adapter.stacks.length) {
    return evaluateHandwrittenStacks({ root, adapter, threshold, scopeInfo, say, messages });
  }

  const format = coverageFormatOf(adapter);
  const rel = adapter.coverageSummary;
  if (!rel) {
    if (isLanguageAdapter(adapter)) {
      // 言語のアダプタで集計の記録が無いのは、基準3 の未実施。未実施は失敗に数える(IMPL-0495。ADR-0124)
      say(
        'fail',
        `アダプタ ${adapter.id} はカバレッジの集計の記録(coverageSummary)を持ちません。言語のアダプタでは基準3 は 未実施 で、未実施は失敗に数えます(標準 第4章 G-5「検査対象が存在しない場合の扱い」)。` +
          `adapters/${adapter.id}.json に、coverage のコマンドが出す集計の記録(coverageSummary)とその形式(coverageFormat: ${Object.keys(COVERAGE_FORMATS).join(' / ')})を書いてください。アダプタの変更は統制の設定の変更です`
      );
      return { code: 1, result: { measured: false, reason: 'coverageSummary が null(言語のアダプタの未実施)', ...scopeInfo }, messages };
    }
    say('warn', `アダプタ ${adapter.id} はカバレッジの集計ファイルを持ちません。判定を実施しない扱いで記録します`);
    return { code: 0, result: { measured: false, reason: 'coverageSummary が null', ...scopeInfo }, messages };
  }
  if (format === null) {
    say('fail', `アダプタ ${adapter.id} の coverageFormat "${adapter.coverageFormat}" は ${Object.keys(COVERAGE_FORMATS).join(' / ')} のいずれでもありません`);
    return { code: 1, result: { measured: false, reason: 'coverageFormat の値が不正', ...scopeInfo }, messages };
  }
  const fmt = COVERAGE_FORMATS[format];
  const fmtInfo = { ...scopeInfo, format };
  // 集計ファイルは、アダプタのコマンドを実行した所在(projectDir)の下に出る(#363)
  const projBase = path.join(root, adapterProjectDir(adapter));
  const p = path.join(projBase, rel);
  if (!fs.existsSync(p)) {
    say('fail', `カバレッジの集計ファイルがありません: ${rel}。テストの実行設定を確認してください。集計の記録が出ないのは基準3 の未実施で、失敗に数えます`);
    return { code: 1, result: { measured: false, reason: '集計ファイルが無い', ...fmtInfo }, messages };
  }
  const rec = readCoverageRecord({ format, root, projBase, adapter, summaryPath: p });
  if (rec.problem) {
    say('fail', `${rel} からカバレッジを読み取れません(${rec.problem})。アダプタ ${adapter.id} は ${fmt.readHint}を読みます`);
    return { code: 1, result: { measured: false, reason: '集計ファイルを読み取れない', ...fmtInfo }, messages };
  }
  const isTarget = productFilter(root, adapter);
  const product = productFiles(root, adapter);
  // 測定の対象のコードが0行(製品のコードを置く前の基盤だけの状態)。istanbul は割合を "Unknown" と出す。
  // 製品のコードが既にあるのに0行なら、測定の対象の設定の不備であり、失敗させる(#286)
  if (rec.total === 0) {
    if (product.length) {
      say(
        'fail',
        `カバレッジの測定対象が0行ですが、製品のコードがあります(${product.slice(0, 5).join(', ')}${product.length > 5 ? ` ほか ${product.length - 5} 件` : ''})。` + fmt.targetHint
      );
      return { code: 1, result: { measured: false, reason: '測定対象が0行だが製品のコードがある', product: product.slice(0, 20), ...fmtInfo }, messages };
    }
    say('warn', `カバレッジ判定: ${rel} の測定対象が0行で、製品のコードもありません。対象なしとして記録します`);
    return { code: 0, result: { measured: false, reason: '測定対象のコードが0行', ...fmtInfo }, messages };
  }

  // 全体の割合と、測っていない製品のファイル(行単位の記録があれば、それに載らない測れる拡張子の製品のファイル)
  const wholePct = rec.wholePct;
  const wholeDenominator = rec.total ?? null;
  // 行単位の記録に載らない製品のファイル。アダプタが測れない拡張子の製品のファイルも、測っていない製品のファイルに数える(突合 X-5)
  const wholeNotMeasurable = canMeasureChanged(adapter) ? product.filter((f) => !fmt.measurable(f)) : null;
  const wholeUnmeasured = rec.fileSet ? [...product.filter((f) => fmt.measurable(f) && !rec.fileSet.has(f)), ...(wholeNotMeasurable ?? [])] : null;
  const limits = format === 'coverage-py' ? coveragePyLimits(rec.py) : [];
  if (format === 'go-coverprofile') limits.push('全体の割合は coverage.out の文の数の割合(Σ 回数 > 0 のブロックの文の数 / Σ 文の数。go tool cover -func の合計と同じ)');
  if (rec.unmapped?.length) {
    limits.push(`記録のパスを go.mod の module 行で戻せないファイルが ${rec.unmapped.length} 件あります(${rec.unmapped.slice(0, 5).join(', ')})。全体の割合には含め、変更の範囲では使いません`);
  }
  const extra = {
    ...(limits.length ? { limits } : {}),
    ...(rec.py ? { excludedLines: rec.py.excludedLines, testFilesExcluded: rec.py.testFiles.length, branchCoverage: rec.py.branch } : {}),
    ...(rec.unmapped ? { unmappedProfileFiles: rec.unmapped.length } : {}),
  };

  if (scope === 'whole') {
    if (wholePct === null || wholePct === undefined) {
      say('fail', `${rel} からカバレッジを読み取れません。アダプタ ${adapter.id} は ${fmt.readHint}を読みます`);
      return { code: 1, result: { measured: false, reason: '集計ファイルを読み取れない', ...fmtInfo }, messages };
    }
    const ok = wholePct >= threshold;
    const result = {
      measured: true,
      ...fmtInfo,
      pct: wholePct,
      threshold,
      ok,
      denominator: wholeDenominator,
      unmeasuredProductFiles: wholeUnmeasured === null ? null : wholeUnmeasured.length,
      unmeasured: wholeUnmeasured === null ? null : wholeUnmeasured.slice(0, 20),
      notMeasurableFiles: wholeNotMeasurable === null ? null : wholeNotMeasurable.length,
      // 全体で判定する場合、変更の未被覆は全体の被覆で薄まる。保証の開示に記録する(標準 第4章 G-5 基準3)
      dilution: true,
      ...extra,
    };
    say('notice', `測る範囲はコードの全体です。変更の未被覆は全体の被覆で薄まります(保証の開示に記録します)`);
    for (const l of limits) say('notice', `測り方の限界: ${l}`);
    if (wholeUnmeasured === null) say('notice', `測っていない製品のファイルの数: 行単位の記録が無いため数えていません(アダプタ ${adapter.id})`);
    else if (wholeUnmeasured.length) say('warn', `測っていない製品のファイルが ${wholeUnmeasured.length} 件あります(${wholeUnmeasured.slice(0, 5).join(', ')})。全体の割合はこれを分母に含みません`);
    if (!ok) {
      say('fail', `カバレッジ ${wholePct}%(範囲: コードの全体、分母 ${wholeDenominator} 行)が基準値 ${threshold}% を下回っています`);
      return { code: 1, result, messages };
    }
    say('notice', `カバレッジ ${wholePct}%(範囲: コードの全体、分母 ${wholeDenominator} 行。基準値 ${threshold}%)`);
    return { code: 0, result, messages };
  }

  // changed: 変更で加えた・変えた行
  if (!canMeasureChanged(adapter)) {
    say('fail', `アダプタ ${adapter.id} は行単位の被覆(coverageDetail)を持たないため、変更の範囲を測れません。構成 ci.coverageScope を whole にし、企画書(G-1)の記録と揃えてください`);
    return { code: 1, result: { measured: false, reason: 'アダプタが変更の範囲を測れない', ...fmtInfo }, messages };
  }
  if (!rec.detail) {
    say('fail', `行単位の被覆の記録がありません: ${adapter.coverageDetail}。${fmt.detailHint}(変更の範囲を測るため)`);
    return { code: 1, result: { measured: false, reason: '行単位の被覆の記録が無い', ...fmtInfo }, messages };
  }
  const git = gitIn(root);
  const ref = base ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null);
  const mergeBase = ref ? (git(['merge-base', ref, 'HEAD']) ?? '').trim() : '';
  if (!mergeBase) {
    say('fail', `変更の範囲の起点${ref ? ` ${ref}` : ''}を解決できません。--base で比較の起点を渡してください(基底ブランチを取得してから実行する)。起点が無いまま通過として残しません`);
    return { code: 1, result: { measured: false, reason: '変更の範囲の起点を解決できない', ...fmtInfo }, messages };
  }
  // core.quotePath=false: ASCII 以外を含むパスを引用符で囲ませない(parseAddedLines は引用符つきのパスも戻す。突合 X-5)
  const added = parseAddedLines(git(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=AMR', mergeBase, '--']) ?? '');
  let coverage = rec.detail;
  let goInfo = null;
  if (format === 'go-coverprofile') {
    // 変更した製品の go のファイルだけ、構文木で文の範囲を得る
    const need = [...added.keys()].filter((f) => isTarget(f) && fmt.measurable(f) && rec.detail.has(f));
    coverage = new Map();
    goInfo = { mismatched: 0, unassigned: 0, parseErrors: [] };
    if (need.length) {
      let ranges;
      try {
        ranges = goStatementRanges(need.map((f) => path.join(root, f)));
      } catch (e) {
        say(
          'fail',
          `go のソースの構文木から文の開始行を得られません(${String(e?.stderr || e?.message || e).trim().split('\n')[0]})。変更の範囲の go の判定には go が要ります(scripts/gate/_go-stmt-lines を go run で実行する)。測っていない状態を通過として残しません`
        );
        return { code: 1, result: { measured: false, reason: 'go の構文木を得られない', ...fmtInfo }, messages };
      }
      for (const f of need) {
        const abs = path.join(root, f);
        const stmts = ranges?.files?.[abs];
        if (!stmts) {
          goInfo.parseErrors.push(f);
          continue;
        }
        const h = goLineHits(rec.detail.get(f), stmts);
        goInfo.mismatched += h.mismatched;
        goInfo.unassigned += h.unassigned;
        coverage.set(f, h.hits);
      }
    }
    // 構文木を得られなかったファイルは coverage に入れない。被覆の記録に無いファイルとして数える(分母から黙って落とさない)
  }
  const c = changedScopeCoverage({ added, coverage, isTarget, measurable: fmt.measurable, hitsOf: (h) => h, excluded: rec.py?.excluded ?? null });
  const changedLimits = format === 'coverage-py' ? coveragePyLimits(rec.py, { changedExcluded: c.excludedChanged }) : limits;
  const result = {
    measured: true,
    ...fmtInfo,
    base: ref,
    pct: c.pct,
    threshold,
    denominator: c.denominator,
    covered: c.covered,
    // 測っていない製品のファイル = 被覆の記録に無い測れるファイル + アダプタが測れない拡張子の製品のファイル(突合 X-5)
    unmeasuredProductFiles: c.unmeasured.length + c.notMeasurable.length,
    unmeasured: [...c.unmeasured, ...c.notMeasurable].slice(0, 20),
    notMeasurableFiles: c.notMeasurable.length,
    notMeasurable: c.notMeasurable.slice(0, 20),
    approximation: format === 'go-coverprofile' ? GO_APPROXIMATION : '分母は追加行のうち文の開始行に当たる行。複数行にわたる文の 2 行目以降だけの変更は分母に入らない',
    uncovered: c.uncovered.slice(0, 20),
    whole: { pct: wholePct, denominator: wholeDenominator, unmeasuredProductFiles: wholeUnmeasured?.length ?? null },
    ...extra,
    ...(changedLimits.length ? { limits: changedLimits } : {}),
    ...(format === 'coverage-py' ? { excludedChangedLines: c.excludedChanged } : {}),
    ...(goInfo ? { goBlocksMismatched: goInfo.mismatched, goStatementsUnassigned: goInfo.unassigned } : {}),
    ok: false,
  };
  for (const l of changedLimits) say('notice', `測り方の限界: ${l}`);
  if (goInfo) say('notice', `測り方の近似: ${GO_APPROXIMATION}(食い違うブロック ${goInfo.mismatched} 件、ブロックに入らない文 ${goInfo.unassigned} 件)`);
  if (c.unmeasured.length) {
    const parseNote = goInfo?.parseErrors.length ? `。うち ${goInfo.parseErrors.length} 件は構文木を得られませんでした(${goInfo.parseErrors.slice(0, 5).join(', ')})` : '';
    say(
      'fail',
      `変更した製品のファイルのうち ${c.unmeasured.length} 件が被覆の記録に無く、測っていません(${c.unmeasured.slice(0, 5).join(', ')})${parseNote}。` +
        `${fmt.targetHint}。測っていないファイルを分母から外して通しません`
    );
    return { code: 1, result, messages };
  }
  if (c.notMeasurable.length) {
    say('warn', `変更した製品のファイルのうち ${c.notMeasurable.length} 件は、アダプタ ${adapter.id} が行単位の被覆を測れない拡張子です(${c.notMeasurable.slice(0, 5).join(', ')})。測っていない製品のファイルとして数えます(分母には入りません)`);
  }
  if (!c.denominator) {
    result.ok = true;
    result.noTarget = true;
    say('notice', `変更で加えた・変えた実行できる行がありません(起点 ${ref})。対象なしとして記録します`);
    return { code: 0, result, messages };
  }
  result.ok = c.pct >= threshold;
  if (!result.ok) {
    const where = c.uncovered.slice(0, 3).map((u) => `${u.file}:${u.lines.slice(0, 5).join(',')}`).join(' / ');
    say('fail', `カバレッジ ${c.pct}%(範囲: 変更で加えた・変えたコード、分母 ${c.denominator} 行)が基準値 ${threshold}% を下回っています(未被覆: ${where})`);
    return { code: 1, result, messages };
  }
  say('notice', `カバレッジ ${c.pct}%(範囲: 変更で加えた・変えたコード、分母 ${c.denominator} 行。基準値 ${threshold}%。全体 ${wholePct ?? '—'}%)`);
  return { code: 0, result, messages };
}

/**
 * 形式ごとに集計と行単位の記録を読む。戻り値 { total, wholePct, detail: Map<repo 相対, 行の実行回数> | (go は Map<repo 相対, ブロック>) | null,
 * fileSet: Set | null(記録に載るファイル), py?, unmapped? }、読めなければ { problem }
 */
function readCoverageRecord({ format, root, projBase, adapter, summaryPath }) {
  const readJson = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const detailPath = canMeasureChanged(adapter) ? path.join(projBase, adapter.coverageDetail) : null;
  if (format === 'coverage-py') {
    const isTest = testFilter(root);
    const raw = readJson(summaryPath);
    const py = readCoveragePy(raw, { projBase, root, isTest });
    if (!py) return { problem: raw === undefined ? 'JSON として読めない' : 'files が無い' };
    let detail = null;
    if (detailPath && fs.existsSync(detailPath)) {
      const d = path.resolve(detailPath) === path.resolve(summaryPath) ? py : readCoveragePy(readJson(detailPath), { projBase, root, isTest });
      detail = d ? d.files : null;
      if (d && d !== py) py.excluded = d.excluded;
    }
    return { total: py.statements, wholePct: py.pct, detail, fileSet: new Set(py.files.keys()), py };
  }
  if (format === 'go-coverprofile') {
    let text;
    try {
      text = fs.readFileSync(summaryPath, 'utf8');
    } catch {
      return { problem: '読めない' };
    }
    const profile = parseCoverprofile(text);
    if (!profile) return { problem: 'coverprofile の形式でない' };
    const t = coverprofileTotals(profile);
    let goMod = null;
    try {
      goMod = fs.readFileSync(path.join(projBase, 'go.mod'), 'utf8');
    } catch {
      goMod = null;
    }
    const module = goModulePath(goMod);
    const byFile = new Map();
    const unmapped = new Set();
    for (const b of profile.blocks) {
      const r = goProfilePath(b.file, { module, projBase, root });
      if (r === null) {
        unmapped.add(b.file);
        continue;
      }
      if (!byFile.has(r)) byFile.set(r, []);
      byFile.get(r).push(b);
    }
    const detail = detailPath && fs.existsSync(detailPath) ? (path.resolve(detailPath) === path.resolve(summaryPath) ? byFile : null) : null;
    return { total: t.statements, wholePct: t.pct, detail, fileSet: new Set(byFile.keys()), unmapped: [...unmapped] };
  }
  // istanbul(従来の形。pytest-cov の totals も読む。#360 より前の手書きのアダプタのため)
  const raw = readJson(summaryPath);
  if (raw === undefined) return { problem: 'JSON として読めない' };
  const total = raw.total?.lines?.total ?? raw.totals?.num_statements;
  let wholePct = null;
  if (raw.total?.lines?.pct !== undefined) wholePct = raw.total.lines.pct;
  else if (raw.totals?.percent_covered !== undefined) wholePct = raw.totals.percent_covered;
  let detail = null;
  if (detailPath && fs.existsSync(detailPath)) {
    const final = readJson(detailPath);
    if (final !== undefined) detail = new Map([...indexCoverage(final, root)].map(([k, v]) => [k, lineHits(v)]));
  }
  return { total, wholePct, detail, fileSet: detail ? new Set(detail.keys()) : null };
}

/** 集計ファイルの全体の割合と分母(istanbul の coverage-summary.json、pytest-cov の coverage.json)。読めなければ null */
export function summaryTotals(raw, { projBase = null, root = null, isTest = null } = {}) {
  // coverage.py の coverage json(files を持つ)は、テストのファイルを除いた文の割合で数える(IMPL-0496)
  if (projBase && root && raw && typeof raw.files === 'object' && raw.files !== null && raw.totals) {
    const py = readCoveragePy(raw, { projBase, root, isTest: isTest ?? (() => false) });
    if (py) return { pct: py.pct, total: py.statements, testFilesExcluded: py.testFiles.length };
  }
  const pct = raw?.total?.lines?.pct ?? raw?.totals?.percent_covered;
  const total = raw?.total?.lines?.total ?? raw?.totals?.num_statements;
  return typeof pct === 'number' || typeof total === 'number' ? { pct: typeof pct === 'number' ? pct : null, total: typeof total === 'number' ? total : null } : null;
}

/**
 * 手書きの要素(adapters/none.json の stacks)のカバレッジの判定。要素ごとに coverageSummary(作業の場所からの相対のパス)を読み、
 * 要素ごとに同じ基準値と比べる。合算しない。coverageSummary の無い要素は、そのスタックの基準3 の未実施として失敗に数える
 * (第4章 G-5「検査対象が存在しない場合の扱い」の「未実施は失敗に数える」。#363 の突合 X3-1)。測る範囲は全体(行単位の被覆を読まない)
 */
export function evaluateHandwrittenStacks({ root, adapter, threshold, scopeInfo = {}, say = () => {}, messages = [] }) {
  const perStack = [];
  let failed = false;
  for (const [i, d] of adapter.stacks.entries()) {
    const stack = String(d?.stack ?? '');
    const place = String(d?.path ?? '.').replace(/\\/g, '/').replace(/\/+$/, '') || '.';
    const label = `手書きの要素 stacks[${i}](${stack} × ${place})`;
    const rel = typeof d?.coverageSummary === 'string' && d.coverageSummary.trim() ? d.coverageSummary.trim() : null;
    if (!rel) {
      failed = true;
      perStack.push({ stack, place, measured: false, reason: 'カバレッジを報告しない(未実施)' });
      say(
        'fail',
        `${label}: カバレッジの集計ファイル(coverageSummary)がありません。このスタックの基準3 は 未実施 で、未実施は失敗に数えます。` +
          'adapters/none.json の stacks の要素に、手で書いたコマンドが出す集計ファイル(istanbul の coverage-summary.json か pytest-cov の coverage.json。作業の場所からの相対のパス)を書いてください。スタックの間で合算しません'
      );
      continue;
    }
    const p = path.join(root, place, rel);
    const raw = fs.existsSync(p) ? (() => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } })() : undefined;
    const t = raw ? summaryTotals(raw, { projBase: path.join(root, place), root, isTest: testFilter(root) }) : null;
    if (raw === undefined || t === null || t.pct === null) {
      failed = true;
      perStack.push({ stack, place, measured: false, reason: raw === undefined ? '集計ファイルが無い' : '集計ファイルを読み取れない' });
      say('fail', `${label}: カバレッジの集計ファイル ${path.posix.join(place, rel)} が${raw === undefined ? 'ありません' : '読み取れません'}。テストの実行設定を確認してください`);
      continue;
    }
    const ok = t.pct >= threshold;
    perStack.push({ stack, place, measured: true, pct: t.pct, denominator: t.total, ok, ...(t.testFilesExcluded !== undefined ? { testFilesExcluded: t.testFilesExcluded } : {}) });
    if (!ok) {
      failed = true;
      say('fail', `${label}: カバレッジ ${t.pct}%(分母 ${t.total} 行)が基準値 ${threshold}% を下回っています`);
    } else say('notice', `${label}: カバレッジ ${t.pct}%(分母 ${t.total} 行。基準値 ${threshold}%)`);
  }
  const measured = perStack.filter((s) => s.measured);
  const result = {
    measured: measured.length === perStack.length,
    ...scopeInfo,
    scope: 'whole',
    perStack,
    threshold,
    ok: !failed,
    // 最も低いスタックの割合(合算ではない)
    pct: measured.length ? Math.min(...measured.map((s) => s.pct)) : null,
    dilution: true,
  };
  return { code: failed ? 1 : 0, result, messages };
}

function writeResult(root, o) {
  const dir = path.join(root, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'coverage-result.json'), JSON.stringify(o, null, 2) + '\n', 'utf8');
}

function main() {
  const config = loadConfig();
  const adapter = loadAdapter(config);
  let state;
  try {
    state = targetState(adapter);
  } catch (e) {
    fail(e.message);
    writeResult(ROOT, { measured: false, reason: 'アダプタの projectDir が不正' });
    process.exit(1);
  }
  const nested = nestedTargetProblem(adapter, state);
  if (nested) {
    fail(nested);
    writeResult(ROOT, { measured: false, reason: '目印が所在に無く、下の階層にある' });
    process.exit(1);
  }
  if (!state.present) {
    notice(`カバレッジ判定: 対象プロジェクトが見つかりません。未実施として記録します`);
    writeResult(ROOT, { measured: false, reason: 'No target project found' });
    process.exit(0);
  }
  const i = process.argv.indexOf('--base');
  const base = i >= 0 ? process.argv[i + 1] : null;
  const { code, result, messages } = evaluateCoverage({ root: ROOT, config, adapter, base });
  for (const m of messages) (m.level === 'fail' ? fail : m.level === 'warn' ? warn : notice)(m.text);
  writeResult(ROOT, result);
  process.exit(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
