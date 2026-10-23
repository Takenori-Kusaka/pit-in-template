// カバレッジを基準値と比べる(G-5 基準3)。
//
//   node scripts/gate/coverage-check.mjs [--base <比較の起点>]
//
// 測る範囲は構成 ci.coverageScope で決める(標準 第4章 G-5「カバレッジの測る範囲と規模(基準3)」。process-compass #296)。
//   changed  変更で加えた・変えた行(git の差分の追加行)だけを分母にする。既定。行単位の被覆(アダプタの coverageDetail)を要する
//   whole    コードの全体の行の割合(アダプタの coverageSummary)。変更の未被覆が全体の被覆で薄まることを、結果と保証の開示に出す
// 構成に範囲が無い場合は、アダプタが変更の範囲を測れるなら changed、測れないなら whole として扱い、その旨を出す。
// 比較の起点は --base、無ければ GITHUB_BASE_REF(origin/<基底>)。changed で起点を解決できなければ失敗させる(測っていない状態を
// 通過として残さない)。
//
// 結果(evidence/coverage-result.json)には、割合・範囲・分母・測っていない製品のファイルの数を書く。割合だけでは、
// 2 行中 2 行の 100% と、2,000 行中 1,600 行の 80% を区別できないためである(ADR-0077 決定6)。
// coverageSummary が null のアダプタは、判定を実施しない扱いとして記録する(通過させる。#330 の範囲)。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadAdapter, ROOT, fail, notice, warn, hasTarget, matchGlob, isFilledValue } from './config.mjs';
import { isProductCode, THRESHOLD_FILES } from './check-pr.mjs';

export const COVERAGE_SCOPES = ['changed', 'whole'];
export const SCOPE_LABEL = { changed: '変更で加えた・変えたコード', whole: 'コードの全体' };
/** 行単位の被覆を読める拡張子(node のアダプタ。istanbul の coverage-final.json に載る) */
const NODE_MEASURABLE = /\.(m?[jt]sx?|c[jt]s)$/i;

/** アダプタが変更の範囲を測れるか(行単位の被覆の置き場を持つか) */
export const canMeasureChanged = (adapter) => typeof adapter?.coverageDetail === 'string' && adapter.coverageDetail.length > 0;

/**
 * 適用する測る範囲。構成 ci.coverageScope があればそれ。無ければ、アダプタが変更の範囲を測れるなら changed、測れないなら whole。
 * declared は構成に範囲が書かれていたか
 */
export function coverageScopeOf(config, adapter) {
  const v = config?.ci?.coverageScope;
  if (COVERAGE_SCOPES.includes(v)) return { scope: v, declared: true };
  return { scope: canMeasureChanged(adapter) ? 'changed' : 'whole', declared: false, invalid: v !== undefined && v !== null ? v : undefined };
}

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
      const p = line.slice(4).trim();
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
export function changedScopeCoverage({ added, coverage, isTarget, measurable = (f) => NODE_MEASURABLE.test(f) }) {
  let denominator = 0;
  let covered = 0;
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
    const hits = lineHits(fc);
    const miss = [];
    for (const l of [...lines].sort((a, b) => a - b)) {
      if (!hits.has(l)) continue;
      denominator++;
      if (hits.get(l) > 0) covered++;
      else miss.push(l);
    }
    if (miss.length) uncovered.push({ file, lines: miss.slice(0, 50) });
  }
  const pct = denominator ? Math.round((covered / denominator) * 10000) / 100 : null;
  return { denominator, covered, pct, unmeasured, notMeasurable, uncovered };
}

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

/** 分母へ入れる製品のファイルか(製品のコードで、テストの置き場でない) */
export function productFilter(root, adapter) {
  let testPatterns = [];
  try {
    testPatterns = JSON.parse(fs.readFileSync(path.join(root, '.claude/guard.json'), 'utf8')).testPatterns ?? [];
  } catch {
    // ガードの設定が無ければ、テストの識別を行わない
  }
  const thresholdGlobs = [...THRESHOLD_FILES, ...(Array.isArray(adapter?.thresholdFiles) ? adapter.thresholdFiles : [])];
  const head = (f) => {
    try {
      return fs.readFileSync(path.join(root, f), 'utf8').slice(0, 200);
    } catch {
      return null;
    }
  };
  return (f) => isProductCode(f, thresholdGlobs, head) && !testPatterns.some((g) => matchGlob(g, f));
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
  if (!declared) say('notice', `構成に測る範囲(ci.coverageScope)がありません。アダプタ ${adapter.id} の既定として「${SCOPE_LABEL[scope]}」で測ります`);
  const scopeInfo = { scope, scopeLabel: SCOPE_LABEL[scope], scopeDeclared: declared };

  const rel = adapter.coverageSummary;
  if (!rel) {
    say('warn', `アダプタ ${adapter.id} はカバレッジの集計ファイルを持ちません。判定を実施しない扱いで記録します`);
    return { code: 0, result: { measured: false, reason: 'coverageSummary が null', ...scopeInfo }, messages };
  }
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    say('fail', `カバレッジの集計ファイルがありません: ${rel}。テストの実行設定を確認してください`);
    return { code: 1, result: { measured: false, reason: '集計ファイルが無い', ...scopeInfo }, messages };
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const isTarget = productFilter(root, adapter);
  const product = productFiles(root, adapter);
  // 測定の対象のコードが0行(製品のコードを置く前の基盤だけの状態)。istanbul は割合を "Unknown" と出す。
  // 製品のコードが既にあるのに0行なら、測定の対象の設定の不備であり、失敗させる(#286)
  const total = raw.total?.lines?.total ?? raw.totals?.num_statements;
  if (total === 0) {
    if (product.length) {
      say(
        'fail',
        `カバレッジの測定対象が0行ですが、製品のコードがあります(${product.slice(0, 5).join(', ')}${product.length > 5 ? ` ほか ${product.length - 5} 件` : ''})。` +
          '測定の対象(node では package.json の coverage の --include)を、製品のコードの置き場に合わせてください'
      );
      return { code: 1, result: { measured: false, reason: '測定対象が0行だが製品のコードがある', product: product.slice(0, 20), ...scopeInfo }, messages };
    }
    say('warn', `カバレッジ判定: ${rel} の測定対象が0行で、製品のコードもありません。対象なしとして記録します`);
    return { code: 0, result: { measured: false, reason: '測定対象のコードが0行', ...scopeInfo }, messages };
  }

  // 全体の割合と、測っていない製品のファイル(行単位の記録があれば、それに載らない測れる拡張子の製品のファイル)
  let wholePct = null;
  if (raw.total?.lines?.pct !== undefined) wholePct = raw.total.lines.pct;
  else if (raw.totals?.percent_covered !== undefined) wholePct = raw.totals.percent_covered;
  const wholeDenominator = raw.total?.lines?.total ?? raw.totals?.num_statements ?? null;
  let coverage = null;
  if (canMeasureChanged(adapter) && fs.existsSync(path.join(root, adapter.coverageDetail))) {
    coverage = indexCoverage(JSON.parse(fs.readFileSync(path.join(root, adapter.coverageDetail), 'utf8')), root);
  }
  const wholeUnmeasured = coverage ? product.filter((f) => NODE_MEASURABLE.test(f) && !coverage.has(f)) : null;

  if (scope === 'whole') {
    if (wholePct === null) {
      say('fail', `${rel} からカバレッジを読み取れません。istanbul 形式または pytest-cov 形式に対応しています`);
      return { code: 1, result: { measured: false, reason: '集計ファイルを読み取れない', ...scopeInfo }, messages };
    }
    const ok = wholePct >= threshold;
    const result = {
      measured: true,
      ...scopeInfo,
      pct: wholePct,
      threshold,
      ok,
      denominator: wholeDenominator,
      unmeasuredProductFiles: wholeUnmeasured === null ? null : wholeUnmeasured.length,
      unmeasured: wholeUnmeasured === null ? null : wholeUnmeasured.slice(0, 20),
      // 全体で判定する場合、変更の未被覆は全体の被覆で薄まる。保証の開示に記録する(標準 第4章 G-5 基準3)
      dilution: true,
    };
    say('notice', `測る範囲はコードの全体です。変更の未被覆は全体の被覆で薄まります(保証の開示に記録します)`);
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
    return { code: 1, result: { measured: false, reason: 'アダプタが変更の範囲を測れない', ...scopeInfo }, messages };
  }
  if (!coverage) {
    say('fail', `行単位の被覆の記録がありません: ${adapter.coverageDetail}。node では c8 に --reporter=json を足してください(変更の範囲を測るため)`);
    return { code: 1, result: { measured: false, reason: '行単位の被覆の記録が無い', ...scopeInfo }, messages };
  }
  const git = gitIn(root);
  const ref = base ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null);
  const mergeBase = ref ? (git(['merge-base', ref, 'HEAD']) ?? '').trim() : '';
  if (!mergeBase) {
    say('fail', `変更の範囲の起点${ref ? ` ${ref}` : ''}を解決できません。--base で比較の起点を渡してください(基底ブランチを取得してから実行する)。起点が無いまま通過として残しません`);
    return { code: 1, result: { measured: false, reason: '変更の範囲の起点を解決できない', ...scopeInfo }, messages };
  }
  const added = parseAddedLines(git(['diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=AMR', mergeBase, '--']) ?? '');
  const c = changedScopeCoverage({ added, coverage, isTarget });
  const result = {
    measured: true,
    ...scopeInfo,
    base: ref,
    pct: c.pct,
    threshold,
    denominator: c.denominator,
    covered: c.covered,
    unmeasuredProductFiles: c.unmeasured.length,
    unmeasured: c.unmeasured.slice(0, 20),
    notMeasurableFiles: c.notMeasurable.length,
    uncovered: c.uncovered.slice(0, 20),
    whole: { pct: wholePct, denominator: wholeDenominator, unmeasuredProductFiles: wholeUnmeasured?.length ?? null },
    ok: false,
  };
  if (c.unmeasured.length) {
    say(
      'fail',
      `変更した製品のファイルのうち ${c.unmeasured.length} 件が被覆の記録に無く、測っていません(${c.unmeasured.slice(0, 5).join(', ')})。` +
        '測定の対象(node では package.json の coverage の --include)を、製品のコードの置き場に合わせてください。測っていないファイルを分母から外して通しません'
    );
    return { code: 1, result, messages };
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

function writeResult(root, o) {
  const dir = path.join(root, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'coverage-result.json'), JSON.stringify(o, null, 2) + '\n', 'utf8');
}

function main() {
  const config = loadConfig();
  const adapter = loadAdapter(config);
  if (!hasTarget(adapter)) {
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
