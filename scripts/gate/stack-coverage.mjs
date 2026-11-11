// 製品のすべてのスタックを G-5 の対象にする(標準 第4章 G-5「製品のすべてのスタック」。process-compass #363 / ADR-0121)。
//
// 契約検査(verify-gate-contract.mjs)が PR ごとに呼ぶ。製品のコードにあるスタックと、「宣言したスタック + 登録した除外」を
// 突き合わせ、外れたスタックがあれば G-5 を失敗にする(第1段)。
//
//   - 検出: 目印のファイル(package.json・pyproject.toml・go.mod など)と、拡張子の集計(.py・.ts・.go など)を併せる。
//     目印を持たない .py の寄せ集めを見落とさないため。製品でないファイル(強制層・文書の置き場の文書)と依存の置き場は数えない
//   - 宣言: 人が行う。単位は「スタック × 作業の場所」。言語のアダプタ(node・python・go ほか)は、そのスタック × projectDir を
//     宣言する(旧い構成の1つのアダプタを、値を変えずにそのまま宣言として読む)。アダプタの外の言語と複数のスタックは、
//     手書きの要素(adapters/none.json のコマンドと stacks)で受ける。手書きの要素が無ければ失敗になる。検出の結果で宣言を埋めない
//   - 除外: .github/stack-exclusions.json(統制の設定。AI維持管理者の承認を要し、製品のコードと同じ PR で変えられない)。
//     区分は「製品でない」(non-product)だけ。パス(ファイルかディレクトリ。ワイルドカードを使わない)・理由・人の記名を要し、
//     AI の名義を受け付けない。宣言した作業の場所を覆う除外は受けない(製品のスタックは除外できない)
//   - 除外は基準7(秘匿情報の検査)に効かない。secretScan はこのファイルを読まず、リポジトリの直下から全体を検査する
//   - 複数のアダプタ・スタックごとの並列の段・スタックごとのカバレッジ(第2段)は、この準拠テンプレートに無い。
//     宣言の外のスタックは、第2段が降りるまでの間も失敗にする(未実施は失敗に数える)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, adapterFamily, adapterProjectDir, nameProblems, isFilledValue } from './config.mjs';
import { isNonProduct } from './check-pr.mjs';

/** 除外の一覧の置き場(統制の設定。check-pr.mjs の THRESHOLD_FILES に入れ、同時変更の検査と変更の承認に掛ける) */
export const STACK_EXCLUSIONS_FILE = '.github/stack-exclusions.json';

/** 除外の区分。閉じた列挙で、「製品でない」だけを持つ */
export const EXCLUSION_CATEGORIES = { 'non-product': '製品でない' };

/** スタックごとの目印のファイル(基本名)。preflight.mjs の STACK_MARKERS と同じ並び */
export const STACK_MARKER_FILES = {
  node: /^package\.json$/,
  python: /^(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements[^/]*\.txt)$/,
  go: /^go\.mod$/,
  rust: /^Cargo\.toml$/,
  java: /^(pom\.xml|build\.gradle(\.kts)?)$/,
  ruby: /^Gemfile$/,
  php: /^composer\.json$/,
  dotnet: /\.(csproj|fsproj|sln)$/,
  swift: /^Package\.swift$/,
};

/** スタックごとの拡張子(拡張子の集計) */
export const STACK_EXTENSIONS = {
  node: /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/i,
  python: /\.pyi?$/i,
  go: /\.go$/i,
  rust: /\.rs$/i,
  java: /\.(java|kt|kts)$/i,
  ruby: /\.rb$/i,
  php: /\.php$/i,
  dotnet: /\.(cs|fs|vb)$/i,
  swift: /\.swift$/i,
};

export const KNOWN_STACKS = Object.keys(STACK_MARKER_FILES);

/** 依存・生成物の置き場(preflight.mjs・config.mjs の目印の走査と同じ) */
const SKIP_DIRS = /(^|\/)(node_modules|\.git|vendor|\.venv|venv|dist|build|target|coverage|evidence|graft)\//;

/** G-5 の基準のうち、製品のすべてのスタックを対象にするもの(基準1・2・3・5)と、その検査 */
export const STACK_CRITERIA = '基準1(test)・基準2(lint・audit)・基準3(coverage)・基準5(licenses)';

/** ファイルのスタック。{ stack, via: 'marker' | 'extension' } か null */
export function stackOfFile(f) {
  const base = f.slice(f.lastIndexOf('/') + 1);
  for (const [stack, re] of Object.entries(STACK_MARKER_FILES)) if (re.test(base)) return { stack, via: 'marker' };
  for (const [stack, re] of Object.entries(STACK_EXTENSIONS)) if (re.test(base)) return { stack, via: 'extension' };
  return null;
}

/** 製品のコードの候補か(強制層・文書の置き場の文書・依存の置き場を除く) */
export function isProductCandidate(f, head = null) {
  const p = f.replace(/\\/g, '/');
  if (SKIP_DIRS.test(p)) return false;
  return !isNonProduct(p, head);
}

/** 正規化したパス(直下は '.'、末尾の / を除く)。直下の外・絶対パス・ワイルドカードは null */
function normalizePlace(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '');
  if (v === '' || v === '.') return '.';
  if (path.isAbsolute(v) || /^[A-Za-z]:/.test(v) || v.startsWith('/') || v.split('/').includes('..') || v.split('/').includes('.')) return null;
  if (/[*?[\]{}]/.test(v)) return null;
  return v;
}

/** パス p が場所 place(ディレクトリ。'.' は直下)の下にあるか、ファイルそのものか */
export function under(p, place) {
  return place === '.' || p === place || p.startsWith(`${place}/`);
}

/**
 * 構成のアダプタから、宣言したスタックの一覧を読む。{ declared: [{ stack, place, by }], problems }
 *   言語のアダプタ: そのスタック × projectDir(旧い構成の1つのアダプタを値を変えずに宣言として読む)
 *   none: 手書きの要素の stacks([{ stack, path }])。コマンドは adapters/none.json に人が書く
 *   undetermined: 宣言なし
 */
export function declaredStacks(adapter, { dirExists = () => true } = {}) {
  const problems = [];
  const declared = [];
  if (!adapter) return { declared, problems };
  const family = adapterFamily(adapter);
  if (family) {
    let place = '.';
    try {
      place = adapterProjectDir(adapter);
    } catch (e) {
      problems.push(e.message);
    }
    declared.push({ stack: family, place, by: adapter.id });
  }
  const raw = adapter.stacks;
  if (raw !== undefined && raw !== null) {
    if (adapter.id !== 'none') {
      problems.push(
        `アダプタ ${adapter.id} に stacks(手書きの要素の宣言)があります。stacks を持てるのは、コマンドを人が書く adapters/none.json だけです。` +
          '1つの構成で複数のアダプタを回す形(第2段)は、この準拠テンプレートにありません(process-compass #363 / ADR-0121)'
      );
    } else if (!Array.isArray(raw)) {
      problems.push('adapters/none.json の stacks は、{ "stack": "<スタック>", "path": "<作業の場所>" } の配列で書きます');
    } else {
      raw.forEach((d, i) => {
        const label = `adapters/none.json の stacks[${i}]`;
        const stack = String(d?.stack ?? '').trim();
        if (!KNOWN_STACKS.includes(stack)) {
          problems.push(`${label}: スタック "${d?.stack ?? ''}" は ${KNOWN_STACKS.join(' / ')} のいずれかで書きます`);
          return;
        }
        const place = normalizePlace(d?.path ?? '.');
        if (place === null) {
          problems.push(`${label}: 作業の場所 "${d?.path}" は、リポジトリの直下からの相対のディレクトリで書きます(直下の外・ワイルドカードは使えません)`);
          return;
        }
        if (place !== '.' && !dirExists(place)) {
          problems.push(`${label}: 作業の場所 "${place}" のディレクトリがありません。書き誤った場所で宣言を効かせないため、失敗させます`);
          return;
        }
        declared.push({ stack, place, by: 'none' });
      });
    }
  }
  return { declared, problems };
}

/**
 * 除外の一覧(JSON の本文)を読む。{ present, exclusions: [{ path, category, reason, decidedBy }], problems }
 *   declared: 宣言(作業の場所を覆う除外を受けない)
 */
export function parseStackExclusions(text, { config = null, declared = [] } = {}) {
  const out = { present: text !== null && text !== undefined, exclusions: [], problems: [] };
  if (!out.present) return out;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    out.problems.push(`${STACK_EXCLUSIONS_FILE} を JSON として読めません(${e.message})`);
    return out;
  }
  const list = doc?.exclusions;
  if (!Array.isArray(list)) {
    out.problems.push(`${STACK_EXCLUSIONS_FILE} の exclusions は配列で書きます`);
    return out;
  }
  list.forEach((x, i) => {
    const label = `${STACK_EXCLUSIONS_FILE} の exclusions[${i}]`;
    const errs = [];
    const p = normalizePlace(x?.path);
    if (x?.path === undefined || x?.path === null || String(x.path).trim() === '') errs.push('パス(path)がありません');
    else if (p === null) errs.push(`パス "${x.path}" は、リポジトリの直下からの相対のファイルかディレクトリで書きます(直下の外・ワイルドカードは使えません。除外はパスの単位で、スタックの単位では受けません)`);
    else if (p === '.') errs.push('パスがリポジトリの直下の全体です。全体の除外は受けません');
    if (!Object.hasOwn(EXCLUSION_CATEGORIES, x?.category)) errs.push(`区分 "${x?.category ?? ''}" は受けません。区分は non-product(製品でない)だけです。製品のスタックは除外できません`);
    if (!isFilledValue(x?.reason)) errs.push('製品でない理由(reason)が未記入です');
    if (!isFilledValue(x?.decidedBy)) errs.push('記名(decidedBy)が未記入です。除外は人が記名で決めます');
    else if (config) {
      // 記名は自然人の氏名に限る。AI を示す語・担い手の識別(performer)と同じ文字列・名簿(people[])にない名前を受け付けない。
      // 除外は緩める向きの決定であり、名簿が未記入の間は受け付けない(突合 X3-2)
      for (const why of nameProblems(config, x.decidedBy, { requireRoster: true })) errs.push(`記名を受け付けません: ${why}`);
    }
    if (p && p !== '.') {
      const covered = declared.filter((d) => d.place !== '.' && under(d.place, p));
      if (covered.length) errs.push(`パス ${p} は宣言した作業の場所(${covered.map((d) => `${d.stack} × ${d.place}`).join('、')})を覆います。製品のスタックは除外できません`);
    }
    if (errs.length) out.problems.push(`${label}: ${errs.join('。')}`);
    else out.exclusions.push({ path: p, category: x.category, reason: String(x.reason), decidedBy: String(x.decidedBy) });
  });
  return out;
}

/**
 * 突き合わせ(純粋な関数)。files は製品のコードの候補のパス。
 * { detected: { stack: [path] }, uncovered: { stack: [{ path, via }] }, excludedHits: { path: n }, unusedExclusions: [path] }
 */
export function matchStacks(files, declared, exclusions) {
  const detected = {};
  const uncovered = {};
  const excludedHits = Object.fromEntries(exclusions.map((x) => [x.path, 0]));
  for (const raw of files) {
    const f = raw.replace(/\\/g, '/');
    const s = stackOfFile(f);
    if (!s) continue;
    (detected[s.stack] ??= []).push(f);
    if (declared.some((d) => d.stack === s.stack && under(f, d.place))) continue;
    const ex = exclusions.find((x) => under(f, x.path));
    if (ex) {
      excludedHits[ex.path]++;
      continue;
    }
    (uncovered[s.stack] ??= []).push({ path: f, via: s.via });
  }
  const unusedExclusions = exclusions.filter((x) => excludedHits[x.path] === 0).map((x) => x.path);
  return { detected, uncovered, excludedHits, unusedExclusions };
}

/** 失敗の文(宣言の外のスタックごと)。ゲートの単位では「基準1 未充足」、検査の単位では「未実施(構成のアダプタの外)」と出す */
export function uncoveredProblems(uncovered, adapterId) {
  const out = [];
  for (const [stack, list] of Object.entries(uncovered)) {
    const markers = list.filter((x) => x.via === 'marker').map((x) => x.path);
    const shown = [...markers, ...list.filter((x) => x.via !== 'marker').map((x) => x.path)];
    const sample = `${shown.slice(0, 5).join(', ')}${shown.length > 5 ? ` ほか ${shown.length - 5} 件` : ''}`;
    out.push(
      `G-5 基準1 未充足: 構成に宣言していないスタック ${stack} の製品のコードがあります(${sample}。目印 ${markers.length} 件・拡張子 ${list.length - markers.length} 件)。` +
        `このスタックの ${STACK_CRITERIA} は 未実施(構成のアダプタの外)です。未実施は失敗に数えます(構成のアダプタ: ${adapterId})。` +
        '直し方は2つです。(1) 製品のコードなら、スタックを宣言する(/process-change の種別 settings でアダプタを選ぶ。複数のスタックやアダプタの外の言語は、' +
        'adapters/none.json に全スタックのコマンドを手で書き、stacks に「スタック × 作業の場所」を書く。要素ごとに coverageSummary を書かなければ基準3 が未実施で失敗する。1つの構成で複数のアダプタを回す形は、この準拠テンプレートにありません。アダプタの変更は閾値・除外設定と同じく、製品のコードと別の PR にする)。' +
        `(2) 製品でないなら、${STACK_EXCLUSIONS_FILE} にパス・区分 non-product・理由・人の記名で登録する(統制の設定。AI維持管理者の承認を要し、製品のコードと同じ PR では変えられない)` +
        '(標準 第4章 G-5「製品のすべてのスタック」。process-compass #363)'
    );
  }
  return out;
}

/** 追跡しているファイルと、無視されていない未追跡のファイル(config.mjs の targetState と同じ範囲)。読めなければ null */
export function listedFiles(root = ROOT) {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    return [...new Set(out.split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/')))].filter((f) => fs.existsSync(path.join(root, f)));
  } catch {
    return null;
  }
}

/** 先頭の数百字(文書の置き場の拡張子の無いファイルの shebang の判定に使う) */
function headOf(root) {
  return (f) => {
    try {
      const fd = fs.openSync(path.join(root, f), 'r');
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      fs.closeSync(fd);
      return buf.subarray(0, n).toString('utf8');
    } catch {
      return null;
    }
  };
}

/**
 * リポジトリの突き合わせ。{ problems, notes, declared, exclusions, result }
 */
export function stackCoverageReport(config, adapter, root = ROOT) {
  const problems = [];
  const notes = [];
  const dirExists = (rel) => {
    const abs = path.join(root, rel);
    return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  };
  const decl = declaredStacks(adapter, { dirExists });
  problems.push(...decl.problems);
  const exPath = path.join(root, STACK_EXCLUSIONS_FILE);
  const ex = parseStackExclusions(fs.existsSync(exPath) ? fs.readFileSync(exPath, 'utf8') : null, { config, declared: decl.declared });
  problems.push(...ex.problems);
  const files = listedFiles(root);
  if (files === null) {
    problems.push('追跡しているファイルの一覧を git から読めません。製品のスタックと宣言の突き合わせを確かめていないため、失敗させます(未実施は失敗に数える)');
    return { problems, notes, declared: decl.declared, exclusions: ex.exclusions, result: null };
  }
  const head = headOf(root);
  const candidates = files.filter((f) => isProductCandidate(f, head));
  const result = matchStacks(candidates, decl.declared, ex.exclusions);
  problems.push(...uncoveredProblems(result.uncovered, adapter?.id ?? '(なし)'));
  for (const p of result.unusedExclusions) notes.push(`${STACK_EXCLUSIONS_FILE} の除外 ${p} は、製品のコードの候補に1件も当たりません(効いていない除外)`);
  const hits = Object.entries(result.excludedHits).filter(([, n]) => n > 0);
  if (hits.length) {
    notes.push(
      `製品でないとして除外したパス ${hits.length} 件(${hits.map(([p, n]) => `${p}: ${n} 件`).join('、')})。登録してあることは、検査したことではありません。` +
        '除外は秘匿情報の検査(基準7)に効きません'
    );
  }
  return { problems, notes, declared: decl.declared, exclusions: ex.exclusions, result };
}
