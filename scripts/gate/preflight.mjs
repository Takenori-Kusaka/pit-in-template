// 初期化の事前点検。既存のリポジトリへ持ち込むとき、統制が黙って外れる状態を、構成を設定済みにする前に見つけて止める。
//
//   node scripts/gate/preflight.mjs            点検の結果を出す。止める項目が1つでもあれば終了コード 1
//   node scripts/gate/preflight.mjs --draft    既存の統制の資産の一覧の下書き(Markdown)を標準出力へ出す
//   node scripts/gate/preflight.mjs --json     結果を JSON で出す
//
// 何も書き込みません(読むだけ)。/process-init(generate-profile.mjs)は、構成(configured: true)を書く前にこの点検を
// 実行し、止める項目が1つでもあれば構成を書きません(標準 第1章 1.10.1「既存のリポジトリで適用を始める場合」。
// process-compass #315 / ADR-0085 決定1・2)。
//
// 点検は事実を読むだけで、設問の回答を検出の結果で埋めません(/process-init の「ファイルから技術スタックを推測しない」と両立する)。
// 止める項目は、黙って統制が外れる状態です(目印の無い指示ファイル、フックの登録の欠け、CODEOWNERS の置き場の重なりと
// 雛形の所有者、既定ブランチの名、強制層のワークフロー gate-g5.yml の欠け)。告げる項目は、既存の統制の資産の一覧
// (docs/adoption-inventory.md)へ載せることを求めます。一覧に無い資産と、扱いを確定していない資産は止めます(一覧の網羅を人の申告だけに頼らない)。
// 共通の祖先の無い履歴の併合(根のコミットが2つ以上)は止めず、一覧へ載せることを求めます(#315 突合 X-4)。開始より前の履歴は
// 出所を問わず主張の外で、古い併合は履歴を書き換えないと戻せないためです。準拠テンプレートの履歴を併合しない定め1 は保ちます。
// カバレッジの測定の欠落は、一覧へ載せれば止めません。node では G-5 の test ジョブが失敗し、go では G-5 基準3 を「実施しない」と
// 記録するため、黙っては外れません(#315 突合 X-12。ADR-0028 の「未達」ではない)。
// 既存の違反の基準線(新しい違反だけを止める記録)は設けません。既存の違反は、未達・前提の受容・例外承認の3つの経路で扱います。

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, aiNameReason, isFilledValue, codeownersState, CODEOWNERS_PLACES, hookRegistrationProblems } from './config.mjs';
import { loadManifest, missingResident } from './claude-md-resident.mjs';

/** CLAUDE.md の生成区間の目印(generate-profile.mjs の RULES_BEGIN・RULES_END と同じ文字列。test-adoption.mjs が一致を確かめる) */
export const RULES_BEGIN = '<!-- generated:process-rules start -->';
export const RULES_END = '<!-- generated:process-rules end -->';

/** 既存の統制の資産の一覧の置き場 */
export const INVENTORY_FILE = 'docs/adoption-inventory.md';
/** 資産ごとの扱い(標準 第1章 1.10.1) */
export const DISPOSITIONS = ['取り込む', '置き換える', '残して並存する', '対象外とする'];

/** 準拠テンプレートが持つワークフロー。これ以外のワークフローは既存の資産として一覧へ載せる */
export const TEMPLATE_WORKFLOWS = ['ai-review.yml', 'assurance-period.yml', 'context-drift.yml', 'delegation.yml', 'gate-entry.yml', 'gate-g5.yml', 'ship-evidence.yml'];
/** 準拠テンプレートの直下の配置。これ以外のファイルは、既存の製品のコードと履歴として一覧へ載せる */
export const TEMPLATE_TOP = ['.claude', '.github', '.gitignore', '.ignore', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'LICENSE-docs', 'PROCESS-PROFILE.md', 'README.md', 'adapters', 'context', 'docs', 'evidence', 'process.config.json', 'profiles', 'scripts', 'specs', 'templates'];
/** .gitignore に含めるテンプレートの行(証跡・秘匿情報・カバレッジの出力・端末ごとの状態の除外) */
export const TEMPLATE_GITIGNORE_LINES = ['coverage/', 'evidence/', '.env', '.env.*', '*.pem', '*.key', '.claude/.self-heal'];
/**
 * 準拠テンプレート自身が持つエージェントの指示ファイル(テンプレートの git ls-files から作る。test-adoption.mjs が一致を確かめる)。
 * 入れ子の指示ファイルの点検は、これだけを除く(#315 突合 X-14。製品の scripts/CLAUDE.md などを見落とさない)
 */
export const TEMPLATE_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
/** 準拠テンプレートの CODEOWNERS の、コメントでない行のパスの並び(test-adoption.mjs が .github/CODEOWNERS と一致を確かめる) */
export const TEMPLATE_CODEOWNERS_PATTERNS = ['*'];
/** エージェントの指示ファイルの名 */
const INSTRUCTION_NAMES = new Set(['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md']);
/** テンプレートの AGENTS.md(CLAUDE.md を正本と指す入口)の目印 */
const AGENTS_ENTRY = /開発規約の正本は \[`CLAUDE\.md`\]/;
/** 言語ごとの目印のファイル。アダプタがあるのは node・python・go だけ */
const STACK_MARKERS = [
  ['node', /(^|\/)package\.json$/],
  ['python', /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements[^/]*\.txt)$/],
  ['go', /(^|\/)go\.mod$/],
  ['rust', /(^|\/)Cargo\.toml$/],
  ['java', /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/],
  ['ruby', /(^|\/)Gemfile$/],
  ['php', /(^|\/)composer\.json$/],
  ['dotnet', /\.(csproj|fsproj|sln)$/],
  ['swift', /(^|\/)Package\.swift$/],
];
const ADAPTER_STACKS = new Set(['node', 'python', 'go']);
const SKIP_DIRS = /(^|\/)(node_modules|\.git|vendor|\.venv|venv|dist|build|target|coverage|evidence|graft)\//;

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}
const readText = (root, rel) => {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

/** 既定ブランチ。origin の HEAD、無ければ手元の main、無ければ現在のブランチ。{ name, how } */
export function defaultBranch(root = ROOT) {
  const remote = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (remote) return { name: remote.replace(/^refs\/remotes\/origin\//, ''), how: 'origin の HEAD' };
  if (git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']) !== null) return { name: 'main', how: '手元の main ブランチ(origin の HEAD を読めない)' };
  const cur = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return cur && cur !== 'HEAD' ? { name: cur, how: '現在のブランチ(origin の HEAD も手元の main も無い)' } : { name: null, how: '読めない' };
}

/** 一覧(docs/adoption-inventory.md)を読む。{ present, rows: [{ asset, place, disposition, reason }], decidedBy, decidedAt, problems } */
export function readInventory(root = ROOT) {
  const text = readText(root, INVENTORY_FILE);
  const out = { present: text !== null, rows: [], decidedBy: null, decidedAt: null, problems: [] };
  if (text === null) return out;
  const field = (label) => {
    const m = text.match(new RegExp(`^[-*]\\s*${label}[^:：]*[:：][ \\t]*(.*)$`, 'm'));
    const v = m ? m[1].replace(/<!--.*?-->/g, '').trim() : '';
    return v && !/^<.*>$/.test(v) ? v : null;
  };
  out.decidedBy = field('確定した者');
  out.decidedAt = field('確定日');
  let header = null;
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) {
      header = null;
      continue;
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    if (!header) {
      header = cells;
      continue;
    }
    const col = (name) => {
      const i = header.findIndex((h) => h.includes(name));
      return i >= 0 ? (cells[i] ?? '').replace(/`/g, '').trim() : '';
    };
    if (!header.some((h) => h.includes('所在')) || !header.some((h) => h.includes('扱い'))) continue;
    out.rows.push({ asset: col('資産'), place: col('所在'), disposition: col('扱い'), reason: col('理由') });
  }
  if (!isFilledValue(out.decidedBy)) out.problems.push(`${INVENTORY_FILE} の「確定した者」が未記入です。扱いは技術判断の席の責任者(人)が記名で確定します`);
  else if (aiNameReason(out.decidedBy)) out.problems.push(`${INVENTORY_FILE} の「確定した者」"${out.decidedBy}" は ${aiNameReason(out.decidedBy)}。AI の名義で扱いを確定しません`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.decidedAt ?? '')) out.problems.push(`${INVENTORY_FILE} の「確定日」が YYYY-MM-DD で書かれていません`);
  return out;
}

/** 走査するファイル(追跡しているファイルと、無視されていない未追跡のファイル)。git を読めなければ null */
function listFiles(root) {
  const out = git(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
  if (out === null) return null;
  return [...new Set(out.split('\n').filter(Boolean))].filter((f) => !SKIP_DIRS.test(`${f}`) && fs.existsSync(path.join(root, f)));
}

/**
 * 事前点検。{ stops: [{ id, place, text, fix }], tells: [{ id, place, text }], assets: [{ asset, place, text }], inventory, needInventory, facts }。
 * stops が空でなければ、初期化は構成を書かない
 */
export function preflight(root = ROOT) {
  const stops = [];
  const tells = [];
  const assets = [];
  const stop = (id, place, text, fix) => stops.push({ id, place, text, fix });
  const asset = (id, assetName, place, text) => {
    assets.push({ id, asset: assetName, place, text });
    tells.push({ id, place, text });
  };
  const facts = {};
  const files = listFiles(root);
  if (files === null) {
    stop('git', '.', 'git の履歴を読めない(git のリポジトリでない)。適用の開始の境(構成が設定済みになった最初のコミット)を置けない', 'git のリポジトリで実行する');
    return { stops, tells, assets, inventory: readInventory(root), needInventory: false, facts };
  }

  // --- 止める: 指示ファイル ---
  const claude = readText(root, 'CLAUDE.md');
  if (claude === null) stop('claude-md', 'CLAUDE.md', 'CLAUDE.md が無い。常駐の規則がエージェントへ届かない', 'テンプレートの CLAUDE.md を置く');
  else {
    const b = claude.indexOf(RULES_BEGIN);
    const e = claude.indexOf(RULES_END);
    if (b < 0 || e < 0 || e < b) {
      stop('claude-md-marker', 'CLAUDE.md', `既存の CLAUDE.md に、生成区間の目印(${RULES_BEGIN} / ${RULES_END})が無い`, '既存の内容を残したうえで、テンプレートの CLAUDE.md の目印の区間と常駐の規則の節をすべて含める');
    }
    const manifest = loadManifest();
    if (manifest) {
      const m = missingResident(claude, manifest);
      const n = m.absent.length + m.empty.length + m.rules.length;
      if (n) stop('claude-md-resident', 'CLAUDE.md', `CLAUDE.md に、常駐の規則の節または規則が ${n} 件無い(node scripts/gate/check-process-rules.mjs が一覧を出す)`, 'テンプレートの CLAUDE.md の常駐の規則の節と規則をすべて含める');
    } else stop('claude-md-resident', 'scripts/gate/claude-md-resident.json', '常駐の規則の一覧が無い。CLAUDE.md の規則を確かめられない', 'テンプレートから一覧を戻す');
  }
  const inventory = readInventory(root);
  const listed = (place) => inventory.rows.find((r) => r.place === place) ?? null;
  const agents = readText(root, 'AGENTS.md');
  if (agents !== null && !AGENTS_ENTRY.test(agents)) {
    asset('agents-md', 'エージェントの指示ファイル', 'AGENTS.md', 'テンプレートの入口(CLAUDE.md を正本と指す)でない独自の AGENTS.md。CLAUDE.md があると読まれない基盤があり、矛盾する指示はどちらが選ばれるか定まらない');
  }
  const nested = files.filter((f) => {
    const base = f.split('/').pop();
    if (TEMPLATE_INSTRUCTION_FILES.includes(f)) return false;
    return INSTRUCTION_NAMES.has(base) || f === '.claude/CLAUDE.md';
  });
  for (const f of nested) asset('nested-instructions', 'エージェントの指示ファイル', f, '入れ子の指示ファイル。近いファイルが優先される基盤があり、テンプレートの規則より優先されうる');

  // --- 止める: CODEOWNERS ---
  const co = codeownersState(root);
  facts.codeowners = co;
  if (co.places.length > 1) {
    stop('codeowners-places', co.places.join(' / '), `CODEOWNERS が ${co.places.length} か所にある。GitHub は最初の1つ(${co.effective})だけを使い、ほかは黙って無効になる`, `1か所(${CODEOWNERS_PLACES[0]} を推奨)へまとめ、ほかを消す`);
  }
  // 既存の CODEOWNERS(テンプレートの置き場でない、またはパスの並びがテンプレートと違う)は、資産「コードオーナーの定め」として
  // 一覧へ載せる(1.10.1 の要求事項1。#315 突合 X-14)。テンプレートの CODEOWNERS の所有者を置き換えただけのものは載せない
  if (co.places.length === 1) {
    const text = readText(root, co.effective) ?? '';
    const patterns = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/)[0]);
    const isTemplate = co.effective === CODEOWNERS_PLACES[0] && JSON.stringify(patterns) === JSON.stringify(TEMPLATE_CODEOWNERS_PATTERNS);
    if (!isTemplate) asset('codeowners', 'コードオーナーの定め', co.effective, `既存の CODEOWNERS(パス ${patterns.length} 行)。テンプレートの CODEOWNERS と置き換えるか、残して並存させるか(効くのは1か所だけ)を決める`);
  }
  if (co.owner.length) {
    stop('codeowners-owner', co.effective, `${co.effective} に雛形の所有者 @OWNER が残っている(${co.owner.join('・')} 行目)。不正な所有者の行は黙って飛ばされ、コードオーナーが誰もいない`, '@OWNER を実在のアカウントかチームへ置き換える(人が決める)');
  }

  // --- 止める: フックの登録 ---
  const settingsText = readText(root, '.claude/settings.json');
  if (settingsText !== null) {
    let settings = null;
    try {
      settings = JSON.parse(settingsText);
    } catch {
      settings = null;
    }
    const h = hookRegistrationProblems(settings);
    if (h.problems.length) {
      stop('hooks', '.claude/settings.json', h.problems.join('。'), 'node scripts/init/generate-profile.mjs --merge-hooks で、既存の登録を残したままテンプレートのフックの登録を併合する');
    }
  } else stop('hooks', '.claude/settings.json', '.claude/settings.json が無い。フック(書き込みの遮断)が登録されない', 'テンプレートの .claude/settings.json を置く');

  // --- 止める: 強制層のワークフロー(#315 突合 X-15)。契約検査を走らせるのは gate-g5.yml 自身のため、欠けは契約検査では見つからない ---
  if (!fs.existsSync(path.join(root, '.github/workflows/gate-g5.yml'))) {
    stop('gate-g5-workflow', '.github/workflows/gate-g5.yml', 'テンプレートのワークフロー gate-g5.yml が無い。G-5 の機械判定と契約検査が走らない(契約検査を走らせるのはこのワークフロー自身)', 'テンプレートの .github/workflows/ を複製する');
  }

  // --- 止める: 既定ブランチ ---
  const br = defaultBranch(root);
  facts.defaultBranch = br;
  if (br.name !== 'main') {
    stop('default-branch', br.name ?? '(不明)', `既定ブランチが main でない(${br.name ?? '読めない'}。${br.how})。gate-g5.yml の push の契機が main に固定のため、push の契約検査が黙って走らない`, '既定ブランチを main にしてから初期化する(push の契機を書き換える経路は、準拠テンプレートに置いていない)');
  }

  // --- 告げる(一覧へ載せることを求める) ---
  // 共通の祖先の無い履歴の併合(#315 突合 X-4)。止めずに、主系列の根でない根のコミットごとに一覧へ載せる。
  // テンプレートの履歴の併合を識別して免除する・止めることはしない(識別は出所の申告に依るため)。定め1 は告げる
  const roots = (git(root, ['rev-list', '--max-parents=0', 'HEAD']) ?? '').split('\n').filter(Boolean);
  const mainRoot = (git(root, ['rev-list', '--first-parent', '--max-parents=0', 'HEAD']) ?? '').split('\n').filter(Boolean)[0] ?? null;
  facts.roots = roots.length;
  for (const r of roots.filter((x) => x !== mainRoot)) {
    asset(
      'unrelated-histories',
      '併合した別の履歴',
      `根のコミット ${r.slice(0, 12)}`,
      `共通の祖先の無い履歴の併合(根のコミット ${roots.length} 件)。開始より前の履歴は出所を問わず主張の外。準拠テンプレートの履歴は併合しない(定め1)。テンプレートの履歴を併合したのなら、併合を戻してファイルの複製で持ち込む`
    );
  }

  const commits = Number(git(root, ['rev-list', '--count', 'HEAD']) ?? 0);
  facts.commits = commits;
  const product = files.filter((f) => !TEMPLATE_TOP.includes(f.split('/')[0]));
  facts.productFiles = product.length;
  if (product.length) asset('history', '既存の製品のコードと履歴', '履歴', `テンプレートの配置の外のファイル ${product.length} 件、コミット ${commits} 件。適用の開始より前の履歴は、出所を問わず要求事項の対象外として件数だけを開示する`);
  const workflows = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) && !TEMPLATE_WORKFLOWS.includes(f.split('/').pop()));
  for (const f of workflows) asset('workflow', '既存の CI のワークフロー', f, '既存のワークフロー。必須チェックの名・パスの絞り・契機が gate-g5 と重ならないかを確かめる');
  const stacks = new Map();
  for (const f of files) {
    for (const [stack, re] of STACK_MARKERS) {
      if (re.test(f)) {
        if (!stacks.has(stack)) stacks.set(stack, []);
        stacks.get(stack).push(f);
      }
    }
  }
  facts.stacks = Object.fromEntries(stacks);
  const multi = stacks.size > 1;
  for (const [stack, marks] of stacks) {
    const out = !ADAPTER_STACKS.has(stack);
    for (const f of marks) {
      asset('stack', '使う言語とアダプタ', f, `${stack} の目印${out ? '(アダプタの外の言語)' : ''}${multi ? `(複数のスタック: ${[...stacks.keys()].join('・')}。構成のアダプタは1つ)` : ''}`);
    }
  }
  const coverageGaps = [];
  for (const f of stacks.get('node') ?? []) {
    try {
      const pkg = JSON.parse(readText(root, f));
      if (!pkg?.scripts?.coverage) coverageGaps.push(`${f} に coverage のスクリプトが無い(G-5 の test ジョブが失敗し、PR が通らない)`);
    } catch {
      coverageGaps.push(`${f} を JSON として読めない`);
    }
  }
  for (const f of (stacks.get('python') ?? []).filter((x) => /pyproject\.toml$/.test(x))) {
    if (!/pytest-cov/.test(readText(root, f) ?? '')) coverageGaps.push(`${f} に pytest-cov が無い(アダプタは pytest --cov で測る)`);
  }
  if ((stacks.get('go') ?? []).length) coverageGaps.push('go のアダプタはカバレッジの要約を持たず、判定は「実施しない」として記録される');
  if (coverageGaps.length) asset('coverage', 'カバレッジの測定', 'カバレッジの測定', `${coverageGaps.join('。')}。止めない(node では G-5 の test ジョブが失敗し、go では G-5 基準3 を「実施しない」と記録するため、黙っては外れない)`);
  const gi = readText(root, '.gitignore');
  const giLines = new Set((gi ?? '').split(/\r?\n/).map((l) => l.trim()));
  const giMissing = TEMPLATE_GITIGNORE_LINES.filter((l) => !giLines.has(l));
  if (giMissing.length) asset('gitignore', '版管理から外すファイルの指定', '.gitignore', `.gitignore にテンプレートの行が無い(${giMissing.join(' ')})。証跡・秘匿情報の除外に効く`);

  // --- 一覧との照合(一覧の網羅を人の申告だけに頼らない) ---
  const needInventory = assets.length > 0;
  if (needInventory) {
    if (!inventory.present) {
      stop('inventory', INVENTORY_FILE, `既存の統制の資産を ${assets.length} 件検出した。資産ごとの扱いの一覧(${INVENTORY_FILE})が無い`, `node scripts/gate/preflight.mjs --draft > ${INVENTORY_FILE} で下書きを作り、扱いと確定した者(技術判断の席の責任者)を人が書く`);
    } else {
      for (const p of inventory.problems) stop('inventory', INVENTORY_FILE, p, '人が記名で確定する');
      for (const a of assets) {
        const r = listed(a.place);
        if (!r) stop('inventory-missing', a.place, `検出した資産(${a.asset}: ${a.place})が ${INVENTORY_FILE} に無い`, `${INVENTORY_FILE} の表へ行を足し、扱いを書く`);
        else if (!DISPOSITIONS.includes(r.disposition)) stop('inventory-disposition', a.place, `${INVENTORY_FILE} の ${a.place} の扱い "${r.disposition}" が ${DISPOSITIONS.join('・')} のいずれでもない`, '扱いを確定する');
      }
    }
  }
  return { stops, tells, assets, inventory, needInventory, facts };
}

/** 一覧の下書き(Markdown)。扱いと確定した者は空欄。AI は下書きまでで、扱いを確定しない */
export function draftInventory(result) {
  const L = [];
  L.push('# 既存の統制の資産の一覧(適用の開始の記録)');
  L.push('');
  L.push('標準 第1章 1.10.1「既存のリポジトリで適用を始める場合」の記録です。事前点検(`node scripts/gate/preflight.mjs`)が検出した資産は、すべて表に載せます。');
  L.push(`扱いは ${DISPOSITIONS.join('・')} のいずれかを書きます。扱いを確定するのは技術判断の席の責任者(人)です。AI は下書きまでを行い、扱いと確定した者の欄を埋めません。`);
  L.push('');
  L.push('- 確定した者(技術判断の席の責任者): <氏名>');
  L.push('- 確定日: <YYYY-MM-DD>');
  L.push('');
  L.push('| 資産 | 所在 | 検出した事実 | 扱い | 理由 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const a of result.assets) L.push(`| ${a.asset} | \`${a.place}\` | ${a.text.replace(/\|/g, '/')} |  |  |`);
  if (!result.assets.length) L.push('| (検出した資産なし) | — | — | — | — |');
  L.push('');
  L.push('点検が検出しない資産(ブランチ保護とルールセット、必須チェックの設定など、リポジトリの外の設定)も、行を足して扱いを書きます。実環境の設定は `node scripts/gate/adoption-trial.mjs env-check --by <氏名>` が読みます。');
  L.push('既存の `CODEOWNERS` は点検が行を出します。旧来のブランチ保護だけで必須チェックを効かせている構成は、テンプレートの統制の手段(ルールセット)へ「置き換える」ことを勧めます。');
  return L.join('\n') + '\n';
}

/**
 * 初期化の記録(changeLog[0]、種別 init)へ書く事前点検の結果(#315 突合 X-2)。道具が書き、人は書かない。
 * 止める項目 0 件で初期化したこと、資産の件数、一覧の所在と要約値・記名を残す。開始の後に、複製した構成や
 * --dry-run の出力の流用など初期化を経ない経路を、契約検査と出荷の証跡の集約が「記録の欠落」として見つける
 */
export function preflightRecord(result, root = ROOT, at = null) {
  const inv = readText(root, INVENTORY_FILE);
  return {
    ranAt: at,
    stops: result.stops.length,
    assets: result.assets.length,
    assetIds: [...new Set(result.assets.map((a) => a.id))],
    inventory: inv === null ? null : { path: INVENTORY_FILE, sha256: crypto.createHash('sha256').update(inv).digest('hex'), decidedBy: result.inventory.decidedBy, decidedAt: result.inventory.decidedAt },
    defaultBranch: result.facts.defaultBranch?.name ?? null,
    roots: result.facts.roots ?? null,
  };
}

/** 結果を人が読む行で出す */
export function printPreflight(result, log = console.log) {
  for (const s of result.stops) log(`[止める] ${s.place}: ${s.text}。直し方: ${s.fix}`);
  for (const t of result.tells) {
    const r = result.inventory.rows.find((x) => x.place === t.place);
    log(`[告げる] ${t.place}: ${t.text}${r ? `(一覧の扱い: ${r.disposition || '未記入'})` : ''}`);
  }
  if (result.facts.defaultBranch) log(`[事実] 既定ブランチ: ${result.facts.defaultBranch.name ?? '不明'}(${result.facts.defaultBranch.how})。コミット ${result.facts.commits ?? '?'} 件、根のコミット ${result.facts.roots ?? '?'} 件`);
  log(
    result.stops.length
      ? `事前点検: 止める項目が ${result.stops.length} 件あります。初期化は構成を書きません`
      : `事前点検: 止める項目はありません(告げる項目 ${result.tells.length} 件${result.needInventory ? `。一覧 ${INVENTORY_FILE} と照合済み` : ''})`
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = preflight(ROOT);
  if (process.argv.includes('--draft')) {
    process.stdout.write(draftInventory(r));
    process.exit(0);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else printPreflight(r);
  process.exit(r.stops.length ? 1 : 0);
}
