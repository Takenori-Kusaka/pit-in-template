// G-5 の PR 単位の検査(#286)。gate-g5.yml の pr-rules ジョブが呼ぶ。手元ではフィクスチャで試験する
// (scripts/gate/test-check-pr.mjs)。
//
//   node scripts/gate/check-pr.mjs --base origin/main [--pr <PR の JSON>] [--report <出力先>] [--comment] [--json]
//
// PR の情報(番号・題名・本文・作成者)は、--pr の JSON({ number, title, body, author })か、環境変数
// PR_NUMBER / PR_TITLE / PR_BODY / PR_AUTHOR から読む。題名と本文をシェルへ展開しないため、ワークフローは
// 環境変数で渡す。
//
// 検査は5つ。1〜3 と 5 は失敗させる。4 は失敗させない。
//   1. トレーラ Spec: スカッシュのメッセージになる PR の本文の末尾の段落に `Spec: F-NNN / Task-N` があり、
//      指す仕様(specs/F-NNN/spec.md)と実装計画のタスクが実在すること。製品のコードを変えない PR と、
//      依存の更新の bot の PR は対象外(出力に出す)
//   2. 変更規模の上限: 構成の task.maxChangedLines / maxChangedFiles(基底ブランチの構成)を、製品のコードの
//      差分で数える。算定から除くのは、文書・記録・強制層(下の NON_PRODUCT)、ロックファイル、生成物(基底
//      ブランチの .gitattributes の linguist-generated、または基底で生成の印を持つファイル)、空白だけの変更
//      (一括整形)、内容の変わらない名前の変更。上限を超えたら、**基底ブランチの**技術負債台帳に、この PR を
//      対象とする有効な例外承認の行がある場合だけ通す。同じ PR で足した行は数えない
//   3. 閾値・除外設定と製品のコードの同時変更(禁止事項6): 基底に既にある閾値・除外設定のファイルと、製品の
//      コードが、同じ PR でともに変わった場合だけ失敗させる。閾値だけの PR と、初回の設定(基底に無いファイル、
//      基底の構成が未設定)は通す
//   4. 既存のテストの変更: 基底にあるテスト(.claude/guard.json の testPatterns)の削除・名前の変更・行の削除を
//      一覧にする。独立レビュー(G-6)の材料であり、合否には使わない。--comment で PR へ出す
//   5. リスク区分: PR の本文の「リスク区分」の節に R1 / R2 / R3 のいずれか1つだけが残っていること。変更の種類に
//      依らない(文書・記録だけの PR、Spec: setup の PR、依存の更新の bot の PR を含む)。区分は変更ごとに確定する
//      記録であり(標準 第3章 3.8.1)、出荷判定の証跡の集約が同じ読み方(delegation.mjs の riskClassOf)で欠落にする
//      判定を、マージの前へ移す。区分の妥当性と、確定した者の記名は見ない
//
// 限界(機械で閉じないもの):
//   - 生成物・機械的な変換のうち、上の印で識別できないものは算定に入る。例外承認か、先に印を基底へ入れる
//   - package.json・pyproject.toml のように依存と設定を兼ねるファイルの中の閾値は、閾値のファイルとして扱わない
//   - 例外承認の権限を持つ者か、作成を指示した者の全員と別の人かは確かめない(出荷判定の証跡の集約が確かめる)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  fail,
  warn,
  notice,
  matchGlob,
  parseLedger,
  ACTIVE_EXCEPTION_STATES,
  isFilledValue,
  dueDayOf,
  resolveSigner,
  findPersonByAccount,
  aiNameBlocked,
  canonicalJson,
} from './config.mjs';
import { riskClassOf } from './delegation.mjs';

/** 製品のコードでないもの。文書・記録・成果物・強制層・構成。変更規模の算定と、同時変更の判定から除く */
export const NON_PRODUCT = [
  '*.md',
  'docs/**',
  'specs/**',
  'context/**',
  'templates/**',
  'evidence/**',
  'profiles/**',
  '.claude/**',
  '.github/**',
  'scripts/gate/**',
  'scripts/init/**',
  'scripts/vendor/**',
  'adapters/**',
  'process.config.json',
  'PROCESS-PROFILE.md',
  'CODEOWNERS',
  'LICENSE',
  'LICENSE-docs',
  '.gitignore',
  '.gitattributes',
];

/** ロックファイル(算定から除く)。ファイル名で判定する */
export const LOCK_FILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'go.sum',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
];

/**
 * 閾値・除外設定のファイル(禁止事項6)。アダプタの thresholdFiles を足す。構成(process.config.json の
 * ci・task・guard)とアダプタの定義は、ファイルの種類によらず閾値として扱う(下の thresholdChanges)
 */
export const THRESHOLD_FILES = [
  '.gitattributes',
  'codecov.yml',
  '.codecov.yml',
  'sonar-project.properties',
  '.gitleaks.toml',
  '.gitleaksignore',
  '.trivyignore',
  '.semgrepignore',
  '.secretlintrc*',
  '.secretlintignore',
];

/**
 * 開発の基盤(設定・ツール・雛形)のファイル。変更がこれだけに収まる PR は、トレーラ `Spec: setup` で通す(#286)。
 * 初期化の直後に、テストの実行・カバレッジ・秘匿情報の検査の設定を足す変更は、まだ仕様もタスクも持たないためである。
 * 製品のコード(このほかのファイル)を1つでも含めば、通常どおり `Spec: F-NNN / Task-N` を要する。
 * スラッシュを含まないパターンは、どの階層のファイル名にも当てる。依存と設定を兼ねるファイルは中身を見ない
 */
export const SETUP_FILES = [
  'package.json',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  'tsconfig*.json',
  'jsconfig.json',
  '.editorconfig',
  '.prettierrc*',
  '.prettierignore',
  'pyproject.toml',
  'requirements*.txt',
  'setup.cfg',
  'Pipfile',
  '.python-version',
  'go.mod',
  '.tool-versions',
  '.ignore',
  '.gitkeep',
];
const SETUP_TRAILER = /^Spec:\s*setup\s*$/i;

const GENERATED_MARK = /@generated\b|Code generated .*DO NOT EDIT/;
const SPEC_LINE = /^Spec:\s*(F-\d+)\s*\/\s*(Task-\d+)\s*$/;
const TRAILER_LINE = /^[A-Za-z][\w-]*:\s*\S/;
const DEPENDENCY_BOTS = ['dependabot[bot]', 'renovate[bot]'];
const ASSERTION = /\b(expect|assert\w*|should|toBe|toEqual|toMatch\w*|toStrictEqual|toHaveBeenCalled\w*|Equal|Equals|require\.\w+|t\.(Error|Fatal)\w*)\b/;

function gitIn(root) {
  return (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
}

const basename = (f) => f.split('/').pop();
/** スラッシュを含まないパターンは、どの階層のファイル名にも当てる */
const matchAny = (globs, f) => globs.some((g) => (g.includes('/') ? matchGlob(g, f) : matchGlob(g, basename(f))));
/** 文書・記録・強制層か。*.md はどの階層でも文書として扱う */
export const isNonProduct = (f) => NON_PRODUCT.some((g) => (g === '*.md' ? /\.md$/i.test(f) : matchGlob(g, f)));
export const isLock = (f) => LOCK_FILES.includes(basename(f));
export const isSetupFile = (f) => matchAny(SETUP_FILES, f);
/** 製品のコードか(文書・記録・強制層・閾値の設定・ロックファイル・基盤のファイル以外)。thresholdGlobs はアダプタの分を足したもの */
export const isProductCode = (f, thresholdGlobs = THRESHOLD_FILES) => !isNonProduct(f) && !matchAny(thresholdGlobs, f) && !isLock(f) && !isSetupFile(f);

/** .gitattributes の本文から、linguist-generated の対象のパターンを読む */
export function generatedPatterns(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    if (attrs.some((a) => a === 'linguist-generated' || a === 'linguist-generated=true')) out.push(pattern);
  }
  return out;
}

/** gitattributes のパターンにパスが当たるか。スラッシュを含まないパターンは、どの階層のファイル名にも当たる */
export function attrMatch(pattern, file) {
  let p = pattern.replace(/^\//, '');
  if (p.endsWith('/')) p += '**';
  if (!p.includes('/')) return matchGlob(p, basename(file));
  return matchGlob(p, file);
}

/** git diff --numstat -z の出力を読む。名前の変更は { from, path } を持つ。バイナリは lines: null */
export function parseNumstatZ(text) {
  const tok = String(text ?? '').split('\0');
  const out = [];
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t);
    if (!m) continue;
    const lines = m[1] === '-' ? null : Number(m[1]) + Number(m[2]);
    const removed = m[2] === '-' ? 0 : Number(m[2]);
    if (m[3] === '') {
      out.push({ from: tok[i + 1], path: tok[i + 2], lines, removed });
      i += 2;
    } else out.push({ from: null, path: m[3], lines, removed });
  }
  return out;
}

/** 本文の末尾の段落(スカッシュのメッセージでトレーラとして読まれる段落)を返す */
export function lastParagraph(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  const paras = text.split(/\n[ \t]*\n/);
  return paras[paras.length - 1].trim();
}

/** トレーラ Spec の検査。違反の理由の配列と、見つかった Spec の配列を返す */
export function specFindings(pr, { exists }) {
  const problems = [];
  const body = String(pr.body ?? '').replace(/\r\n/g, '\n');
  const anywhere = body.split('\n').map((l) => l.trim()).filter((l) => /^Spec:/.test(l));
  const last = lastParagraph(body);
  const lastLines = last.split('\n').map((l) => l.trim()).filter(Boolean);
  const specs = lastLines.map((l) => SPEC_LINE.exec(l)).filter(Boolean).map((m) => ({ feature: m[1], task: m[2] }));
  if (!specs.length) {
    if (anywhere.some((l) => SPEC_LINE.test(l))) {
      problems.push('トレーラ Spec が本文の末尾の段落にありません。スカッシュのメッセージでは、末尾の段落のトレーラだけが読まれます(PR の様式の「トレーラ」の節へ置く)');
    } else if (anywhere.length) {
      problems.push(`トレーラ Spec の形式が違います(${anywhere[0]})。\`Spec: F-NNN / Task-N\` で書く`);
    } else {
      problems.push('トレーラ `Spec: F-NNN / Task-N` が PR の本文にありません。製品のコードを変える PR は、対応する仕様とタスクを指す');
    }
    return { problems, specs };
  }
  const notTrailer = lastLines.filter((l) => !TRAILER_LINE.test(l));
  if (notTrailer.length) {
    problems.push(`本文の末尾の段落に、トレーラでない行があります(${notTrailer[0].slice(0, 60)})。末尾の段落はトレーラの行だけにする`);
  }
  for (const s of specs) {
    const spec = `specs/${s.feature}/spec.md`;
    const plan = `specs/${s.feature}/plan.md`;
    if (!exists(spec)) {
      problems.push(`Spec: ${s.feature} / ${s.task} が指す仕様 ${spec} がありません`);
      continue;
    }
    const planText = exists(plan);
    if (!planText) problems.push(`Spec: ${s.feature} / ${s.task} が指す実装計画 ${plan} がありません`);
    else if (!new RegExp(`^\\|\\s*${s.task}\\s*\\|`, 'm').test(planText)) problems.push(`Spec: ${s.feature} / ${s.task} のタスクが、実装計画 ${plan} の表にありません`);
  }
  return { problems, specs };
}

/**
 * 基底ブランチの台帳から、この PR を対象とする有効な例外承認の行を探す(出荷判定の証跡の集約と同じ条件のうち、
 * PR の時点で確かめられるもの)。作成を指示した者の全員との照合は、出荷判定の証跡の集約が行う
 */
export function exceptionFor(ledgerText, prNumber, config, prAuthor) {
  const matched = [];
  const rejected = [];
  if (!ledgerText) return { matched, rejected, reason: '基底ブランチに技術負債台帳(docs/debt-ledger.md)がありません' };
  if (!prNumber) return { matched, rejected, reason: 'PR の番号が分からないため、例外承認の行と対応づけられません' };
  const refers = (text) => new RegExp(`PR\\s*#\\s*${prNumber}(?!\\d)`).test(String(text ?? ''));
  const author = prAuthor ? findPersonByAccount(config, prAuthor) : null;
  for (const r of parseLedger(ledgerText)) {
    if (r.kind !== '例外') continue;
    if (r.target === null) {
      if (refers(r.text)) rejected.push(`${r.id}: 台帳に「対象」の欄が無い(旧い様式)`);
      continue;
    }
    if (!refers(r.target)) continue;
    const why = [];
    if (!ACTIVE_EXCEPTION_STATES.includes(r.state.replace(/\*/g, '').normalize('NFKC').trim())) why.push(`状態が有効を示す値でない(${r.state || '未記入'})`);
    if (!isFilledValue(r.approver)) why.push('承認した者が未記入');
    else {
      if (aiNameBlocked(config, r.approver)) why.push('承認した者が AI の名義である');
      const p = resolveSigner(config, r.approver);
      if (!p) why.push(`承認した者 "${r.approver}" が人の名簿の人へ対応づかない`);
      else if (author && author.id === p.id) why.push('承認した者が PR の作成者である');
    }
    if (!isFilledValue(r.content) || (r.reason !== null && !isFilledValue(r.reason))) why.push('理由(内容・受容した理由)が未記入');
    if (!isFilledValue(r.due) || !dueDayOf(r.due)) why.push('期限(返却の目安)が未記入、または日付として解釈できない');
    if (why.length) rejected.push(`${r.id}: ${why.join('、')}`);
    else matched.push(r.id);
  }
  return { matched, rejected, reason: null };
}

/** PR の変更を読み、4つの検査の結果を返す。root は検査するリポジトリ(試験では一時のリポジトリ) */
export function analyzePr({ root = ROOT, base, pr = {} }) {
  const git = gitIn(root);
  const result = { errors: [], notices: [], size: null, thresholds: null, spec: null, riskClass: null, testChanges: [] };
  const mergeBase = (git(['merge-base', base, 'HEAD']) ?? '').trim();
  if (!mergeBase) {
    result.errors.push(`比較の起点 ${base} を解決できません。基底ブランチを取得してから実行する(fetch-depth: 0)`);
    return result;
  }
  const atBase = (file) => git(['show', `${mergeBase}:${file}`]);
  const atHead = (file) => {
    const p = path.join(root, file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };
  const json = (text) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  const headConfig = json(atHead('process.config.json')) ?? {};
  const baseConfig = json(atBase('process.config.json'));
  const baseConfigured = Boolean(baseConfig) && baseConfig.configured !== false;
  // 上限と名簿は基底ブランチの構成から読む。同じ PR で上限を書き換えても、その PR の検査は変わらない
  const limitsFrom = baseConfigured ? baseConfig : headConfig;

  const all = parseNumstatZ(git(['diff', '--numstat', '-z', '-M', mergeBase, 'HEAD']));
  // 空白を無視した差分。空白だけが変わったファイル(一括整形)は、この出力に現れない。取得に失敗した場合は、空白を含めて数える
  const wsOut = git(['diff', '--numstat', '-z', '-M', '-w', '--ignore-blank-lines', mergeBase, 'HEAD']);
  const ws = wsOut === null ? null : new Map(parseNumstatZ(wsOut).map((e) => [e.path, e]));
  const status = new Map(
    (git(['diff', '--name-status', '-z', '--no-renames', mergeBase, 'HEAD']) ?? '')
      .split('\0')
      .reduce((acc, t, i, arr) => (i % 2 === 0 && t ? [...acc, [arr[i + 1], t[0]]] : acc), [])
  );

  // --- 2. 変更規模 ---
  const genPatterns = generatedPatterns(atBase('.gitattributes'));
  const excluded = [];
  const counted = [];
  for (const e of all) {
    const f = e.path;
    if (isNonProduct(f)) continue;
    const thresholdFile = matchAny(THRESHOLD_FILES, f);
    if (thresholdFile) continue;
    if (isLock(f)) {
      excluded.push(`${f}(ロックファイル)`);
      continue;
    }
    if (genPatterns.some((g) => attrMatch(g, f))) {
      excluded.push(`${f}(生成物: 基底の .gitattributes)`);
      continue;
    }
    const before = atBase(e.from ?? f);
    if (before !== null && GENERATED_MARK.test(before.split('\n').slice(0, 5).join('\n'))) {
      excluded.push(`${f}(生成物: 基底で生成の印を持つ)`);
      continue;
    }
    const w = ws?.get(f);
    const lines = e.lines === null ? 0 : ws === null ? e.lines : (w?.lines ?? 0);
    if (e.lines !== null && lines === 0) {
      excluded.push(`${f}(${e.from && e.lines === 0 ? '内容の変わらない名前の変更' : '空白だけの変更'})`);
      continue;
    }
    counted.push({ path: f, lines, binary: e.lines === null });
  }
  const maxLines = limitsFrom.task?.maxChangedLines ?? null;
  const maxFiles = limitsFrom.task?.maxChangedFiles ?? null;
  const lines = counted.reduce((n, c) => n + c.lines, 0);
  const size = { lines, files: counted.length, maxLines, maxFiles, excluded, over: [] };
  if (maxLines && lines > maxLines) size.over.push(`変更行数 ${lines} が上限 ${maxLines} を超えている`);
  if (maxFiles && counted.length > maxFiles) size.over.push(`変更ファイル数 ${counted.length} が上限 ${maxFiles} を超えている`);
  if (size.over.length) {
    const ex = exceptionFor(atBase('docs/debt-ledger.md'), pr.number, limitsFrom, pr.author);
    size.exception = ex;
    if (ex.matched.length) {
      result.notices.push(`変更規模: ${size.over.join('、')}。基底ブランチの台帳の例外承認(${ex.matched.join(', ')})により通す。判定完了時間と変更規模を記録し、較正の母集団に含める`);
    } else {
      result.errors.push(
        `変更規模: ${size.over.join('、')}(算定から除いたもの ${excluded.length} 件)。実装計画(plan.md)へ差し戻すのが既定。超過したままレビューするには、` +
          `例外承認(標準 第7章 7.3)の行を、この PR を対象(\`PR #${pr.number ?? '<番号>'}\`)として、基底ブランチの技術負債台帳へ先に入れる。` +
          `同じ PR で足した行は数えない${ex.reason ? `。${ex.reason}` : ''}${ex.rejected.length ? `。対応づかない行: ${ex.rejected.join(' / ')}` : ''}`
      );
    }
  }
  result.size = size;

  // --- 3. 閾値・除外設定と製品のコードの同時変更 ---
  const thresholdChanges = [];
  const initial = [];
  const product = all.filter((e) => !isNonProduct(e.path) && !matchAny(THRESHOLD_FILES, e.path) && !isLock(e.path)).map((e) => e.path);
  const stack = (baseConfig ?? headConfig).adapters?.stack ?? null;
  const baseAdapter = stack ? json(atBase(`adapters/${stack}.json`)) : null;
  const thresholdGlobs = [...THRESHOLD_FILES, ...(Array.isArray(baseAdapter?.thresholdFiles) ? baseAdapter.thresholdFiles : [])];
  for (const e of all) {
    const f = e.path;
    const isThreshold = matchAny(thresholdGlobs, f) || (stack && f === `adapters/${stack}.json`);
    if (!isThreshold) continue;
    if (atBase(e.from ?? f) === null) initial.push(f);
    else thresholdChanges.push(f);
  }
  if (all.some((e) => e.path === 'process.config.json')) {
    if (!baseConfigured) initial.push('process.config.json(基底の構成が未設定)');
    else {
      const keys = ['ci', 'task', 'guard'].filter((k) => canonicalJson(baseConfig[k] ?? null) !== canonicalJson(headConfig[k] ?? null));
      if (keys.length) thresholdChanges.push(`process.config.json(${keys.join('・')})`);
    }
  }
  // アダプタの thresholdFiles に当たるファイルは、製品のコードから外す(閾値のファイルを製品のコードと数えない)
  const productCode = product.filter((f) => !matchAny(thresholdGlobs, f));
  result.thresholds = { changed: thresholdChanges, initial, product: productCode.length };
  if (thresholdChanges.length && productCode.length) {
    result.errors.push(
      `閾値・除外設定と製品のコードが同じ PR で変わっています(禁止事項6)。閾値・除外設定: ${thresholdChanges.slice(0, 5).join(', ')} / 製品のコード: ${productCode.slice(0, 5).join(', ')}${productCode.length > 5 ? ` ほか ${productCode.length - 5} 件` : ''}。` +
        '閾値・除外設定の変更を別の PR に分ける'
    );
  } else if (thresholdChanges.length) {
    result.notices.push(`閾値・除外設定だけを変える PR です(${thresholdChanges.join(', ')})。緩める向きの変更は /process-change と記名を要する`);
  }
  if (initial.length) result.notices.push(`閾値・除外設定の初回の設定(基底に無い): ${initial.join(', ')}。同時変更の検査の対象外`);

  // --- 1. トレーラ Spec ---
  const author = String(pr.author ?? '');
  if (DEPENDENCY_BOTS.includes(author)) {
    result.spec = { skipped: `依存の更新の bot(${author})の PR` };
    result.notices.push(`トレーラ Spec: 依存の更新の bot(${author})の PR のため、検査の対象外。依存の追加・更新の必要性は G-6 で確かめる`);
  } else if (!productCode.length) {
    result.spec = { skipped: '製品のコードを変えない PR' };
    result.notices.push('トレーラ Spec: 製品のコードを変えない PR(文書・記録・強制層・構成だけ)のため、検査の対象外');
  } else {
    const lastLines = lastParagraph(pr.body).split('\n').map((l) => l.trim()).filter(Boolean);
    const setupDeclared = lastLines.some((l) => SETUP_TRAILER.test(l));
    const hasFeatureSpec = lastLines.some((l) => SPEC_LINE.test(l));
    const notSetup = productCode.filter((f) => !isSetupFile(f));
    if (setupDeclared && !hasFeatureSpec) {
      const notTrailer = lastLines.filter((l) => !TRAILER_LINE.test(l));
      if (notTrailer.length) {
        result.spec = { problems: [], specs: [] };
        result.errors.push(`トレーラ Spec: 本文の末尾の段落に、トレーラでない行があります(${notTrailer[0].slice(0, 60)})。末尾の段落はトレーラの行だけにする`);
      } else if (!notSetup.length) {
        result.spec = { skipped: '基盤(設定・ツール・雛形)だけの PR(Spec: setup)', setup: productCode };
        result.notices.push(`トレーラ Spec: setup。変更が開発の基盤のファイル(${productCode.slice(0, 5).join(', ')}${productCode.length > 5 ? ` ほか ${productCode.length - 5} 件` : ''})だけに収まるため、仕様とタスクの検査の対象外`);
      } else {
        result.spec = { problems: [], specs: [] };
        result.errors.push(
          `トレーラ Spec: setup は、変更が開発の基盤(設定・ツール・雛形。scripts/gate/check-pr.mjs の SETUP_FILES)だけに収まる PR に限ります。` +
            `製品のコード ${notSetup.slice(0, 5).join(', ')}${notSetup.length > 5 ? ` ほか ${notSetup.length - 5} 件` : ''} を含むため、\`Spec: F-NNN / Task-N\` で対応する仕様とタスクを指す`
        );
      }
    } else {
      const found = specFindings(pr, { exists: (f) => atHead(f) });
      result.spec = found;
      for (const p of found.problems) result.errors.push(`トレーラ Spec: ${p}`);
      // 基盤だけの変更に Spec を書いていない場合は、Spec: setup の経路を示す(仕様を作らせない)
      if (found.problems.length && !found.specs.length && !notSetup.length) {
        result.errors.push('トレーラ Spec: この PR の変更は開発の基盤のファイルだけです。対応する仕様が無い場合は、トレーラの段落へ `Spec: setup` と書く');
      }
    }
  }

  // --- 5. リスク区分 ---
  const risk = riskClassOf(pr.body);
  result.riskClass = risk;
  if (!risk) {
    const section = String(pr.body ?? '').split(/^##\s*リスク区分.*$/m)[1];
    const left = new Set((section?.split(/^##\s/m)[0] ?? '').replace(/<!--[\s\S]*?-->/g, '').match(/R[123]/g) ?? []);
    const why =
      section === undefined
        ? 'PR の本文に「## リスク区分」の節がありません(本文は .github/PULL_REQUEST_TEMPLATE.md から作る)'
        : left.size > 1
          ? `「リスク区分」の節に区分が ${left.size} つ残っています(${[...left].join(' / ')})`
          : '「リスク区分」の節に R1 / R2 / R3 の記載がありません';
    result.errors.push(
      `リスク区分: ${why}。この変更の区分を1つだけ残す。文書・記録だけの PR と Spec: setup の PR も対象です(区分は変更ごとに確定する記録。標準 第3章 3.8.1)。` +
        '本文を直すと、このチェックが再実行されます。AI の担い手は草案を書けますが、確定は人が行います'
    );
  }

  // --- 4. 既存のテストの変更 ---
  const guard = json(atBase('.claude/guard.json')) ?? json(atHead('.claude/guard.json')) ?? {};
  const testPatterns = Array.isArray(guard.testPatterns) ? guard.testPatterns : [];
  const isTest = (f) => testPatterns.some((g) => matchGlob(g, f));
  for (const e of all) {
    const from = e.from ?? e.path;
    if (!isTest(from) || atBase(from) === null) continue;
    const st = status.get(e.path) ?? (e.from ? 'R' : 'M');
    if (st === 'D' || status.get(from) === 'D') {
      if (e.from) result.testChanges.push({ file: from, kind: `名前の変更(→ ${e.path})`, removed: e.removed, assertions: [] });
      else result.testChanges.push({ file: from, kind: '削除', removed: e.removed, assertions: [] });
      continue;
    }
    if (!e.removed) continue;
    const diff = git(['diff', '-U0', '-M', mergeBase, 'HEAD', '--', from, e.path]) ?? '';
    const removedLines = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const assertions = removedLines.filter((l) => ASSERTION.test(l)).map((l) => l.slice(1).trim().slice(0, 120));
    result.testChanges.push({ file: e.path, kind: e.from ? `名前の変更と行の削除(${from} →)` : '行の削除・書き換え', removed: e.removed, assertions });
  }
  return result;
}

/** 既存のテストの変更の一覧(G-6 の材料)を Markdown にする */
export function renderTestChanges(changes) {
  const L = ['<!-- pit-in:g6-test-changes -->', '### 既存のテストの変更(G-6 の材料。合否には使わない)', ''];
  if (!changes.length) {
    L.push('基底ブランチにあるテストの削除・名前の変更・行の削除はありません。');
    return L.join('\n');
  }
  L.push('レビュアは、各テストの変更が受入基準の変更に対応しているか(テストの失敗をテストの変更で解消していないか)を確かめます。機械は理由の妥当性を判定しません。', '');
  L.push('| テスト | 変更 | 削除した行 | 期待値の変更の候補 |', '| --- | --- | --- | --- |');
  for (const c of changes) {
    const a = c.assertions.length ? c.assertions.slice(0, 3).map((x) => `\`${x.replace(/[|`]/g, ' ')}\``).join('<br>') + (c.assertions.length > 3 ? `<br>ほか ${c.assertions.length - 3} 行` : '') : '—';
    L.push(`| \`${c.file}\` | ${c.kind} | ${c.removed} | ${a} |`);
  }
  return L.join('\n');
}

function renderReport(r) {
  const L = ['## G-5 PR の検査(check-pr)', ''];
  L.push(`- 失敗: ${r.errors.length} 件`);
  L.push(`- リスク区分: ${r.riskClass ?? '未記入'}`);
  for (const e of r.errors) L.push(`  - ${e}`);
  for (const n of r.notices) L.push(`- ${n}`);
  if (r.size) {
    L.push(`- 変更規模(算定の対象): ${r.size.lines} 行 / ${r.size.files} ファイル(上限 ${r.size.maxLines ?? '—'} 行 / ${r.size.maxFiles ?? '—'} ファイル)`);
    if (r.size.excluded.length) L.push(`- 算定から除いたもの: ${r.size.excluded.slice(0, 10).join(', ')}${r.size.excluded.length > 10 ? ` ほか ${r.size.excluded.length - 10} 件` : ''}`);
  }
  L.push('', renderTestChanges(r.testChanges));
  return L.join('\n');
}

/** 既存のテストの変更の一覧を PR のコメントへ出す。同じ印のコメントがあれば書き換える */
function upsertComment(markdown, prNumber) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !prNumber) return 'GITHUB_REPOSITORY または PR の番号が無い';
  const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  try {
    const ids = gh(['api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate', '--jq', '.[] | select(.body | startswith("<!-- pit-in:g6-test-changes -->")) | .id']).split('\n').filter(Boolean);
    const payload = JSON.stringify({ body: markdown });
    if (ids.length) gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${ids[0]}`, '--input', '-'], payload);
    else gh(['api', '-X', 'POST', `repos/${repo}/issues/${prNumber}/comments`, '--input', '-'], payload);
    return null;
  } catch (e) {
    return String(e.stderr ?? e.message).split('\n')[0];
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
  const base = arg('--base', process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null);
  if (!base) {
    fail('比較の起点(--base)を指定してください');
    process.exit(2);
  }
  const prFile = arg('--pr');
  const pr = prFile
    ? JSON.parse(fs.readFileSync(prFile, 'utf8'))
    : { number: process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null, title: process.env.PR_TITLE ?? '', body: process.env.PR_BODY ?? '', author: process.env.PR_AUTHOR ?? '' };
  const r = analyzePr({ base, pr });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const e of r.errors) fail(e);
    for (const n of r.notices) notice(n);
    if (r.testChanges.length) warn(`既存のテストの変更が ${r.testChanges.length} 件あります(G-6 の材料。合否には使わない)`);
  }
  const report = renderReport(r);
  const out = arg('--report');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, report + '\n');
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  if (argv.includes('--comment')) {
    const why = upsertComment(renderTestChanges(r.testChanges), pr.number);
    if (why) warn(`既存のテストの変更の一覧を PR へ出せませんでした(${why})。ジョブの要約に出しています`);
  }
  process.exit(r.errors.length ? 1 : 0);
}
