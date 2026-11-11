// AI レビュー(.github/workflows/ai-review.yml)の決まった手順が呼ぶ記録のスクリプト(process-compass #360 論点C)。
// 既定ブランチの作業ツリーの版で動く(PR の側のスクリプトを実行しない。ADR-0115 の「基底から読む」型)。
//
//   node scripts/gate/ai-review-record.mjs inputs   --dir "$RUNNER_TEMP/ai-review"   (差し込み口の前)
//   node scripts/gate/ai-review-record.mjs findings --dir "$RUNNER_TEMP/ai-review"   (差し込み口の後)
//
// inputs(IMPL-0253。標準 附属書H H.4「確認側へ渡した入力の記録」):
//   ワークフローが列挙できる入力を、パスと sha256 でジョブの要約(GITHUB_STEP_SUMMARY)と <dir>/record/inputs.json へ書く。
//   列挙するのは、指示の置き場 .github/ai-review/ のファイル、差分(diff.patch)と変更したファイルの一覧(files.txt)、
//   既定ブランチ・基底・PR の先頭の SHA、作業ツリーにある自動で読み込まれうる指示ファイルの候補(既知の名前に限る)。
//   候補は読み込まれうるものの上限であり、実際に読み込まれたものではない。入力の記録は、確かめたことを示さない。
//   道具にしか分からない入力(起動の指示・道具の定義・実際に読んだファイル)は、差し込む手順が <dir>/tool-inputs.json へ書く
//   (契約: .github/ai-review/README.md)。
//
// findings(IMPL-0155 の欠落の表示と、IMPL-0253 の契約ファイルの有無の表示。標準 附属書H H.4「指摘の内容(条件5)」):
//   - tool-inputs.json が無い・欄を欠く・読めない場合は「道具の側の入力を列挙できない確認」と要約へ出す
//     (文脈を渡していない確認として記録してはならない)。契約の実装は採用者(IMPL-0493)
//   - findings.json(構造化された指摘)があれば、指摘ごとに所在(location)・根拠(basis)・実行の記録の所在(run。実行の結果を
//     述べる指摘に限る)の欠落を要約へ出す。指摘を消さない・書き換えない。合否に使わない(終了コードは常に 0)
//   - findings.json が無ければ「構造が無いため欠落を検査していない」と出す(散文の出力を拒まない)
//   - 構造を満たしたことは、指摘の内容が成り立つ根拠ではない。中身の正しさは確かめない
//   出力はこのジョブの要約だけ。PR へ書くジョブ(ai-review-notice)へは渡さない。
//
// 記録の保持(四半期の抜き取りまで残ること)は、このスクリプトでは降ろさない(IMPL-0492。#358)。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const INSTRUCTIONS_DIR = '.github/ai-review';

/** 定型の文(要約へ毎回出す。試験が文言を固定する) */
export const NOTE = {
  candidates: '作業ツリーにある自動読込の候補は、読み込まれうるものの上限であり、実際に読み込まれたものではありません(既知の名前に限る。一覧の外の名前を読む道具の読み込みは含みません)',
  notVerified: '入力の記録は、確かめたことを示しません(渡した入力は確認が見られた範囲の上限であり、実際に確かめた範囲ではありません)',
  toolMissing: '道具の側の入力を列挙できない確認です。文脈を渡していない確認として記録してはなりません',
  toolSelfReport: '道具の側の入力の記録は差し込んだ手順の申告です。道具が実際に受け取ったものと一致するかを、機械は確かめていません',
  noStructure: '構造が無いため欠落を検査していません(散文の出力は拒みません)',
  structureNotBasis: '構造を満たしたことは、指摘の内容が成り立つ根拠ではありません。この表示は欠落を示すだけで、指摘を消しません。合否に使いません',
};

/** 自動で読み込まれうる指示ファイルの既知の名前(網羅ではない)。どの階層にあっても候補にする名前と、置き場の決まった名前 */
const AUTOLOAD_BASENAMES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md', '.cursorrules', '.windsurfrules']);
const AUTOLOAD_DIRS = ['.claude', '.cursor/rules', '.github/instructions', '.github/prompts', '.gemini', '.codex'];
const AUTOLOAD_FILES = ['.github/copilot-instructions.md', '.mcp.json'];
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

function walk(abs, rel, out, filter) {
  let ents;
  try {
    ents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  // 並びは符号の順(ロケールに依らない。同じ木から同じ記録を書く)
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.isSymbolicLink()) {
      if (filter(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name);
      continue;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, out, filter);
    } else if (e.isFile() && filter(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name);
  }
}

/** パスと sha256 の行。読めないファイルは sha256 を null にし、理由を残す(黙って落とさない) */
function entry(root, rel) {
  const abs = path.join(root, rel);
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return { path: rel, sha256: null, note: `シンボリックリンク(→ ${fs.readlinkSync(abs)})。リンク先は記録していない` };
    return { path: rel, sha256: sha256(fs.readFileSync(abs)), bytes: st.size };
  } catch (e) {
    return { path: rel, sha256: null, note: `読めない(${e.code ?? e.message})` };
  }
}

/** 作業ツリーにある自動読込の候補(既知の名前に限る) */
export function autoloadCandidates(root) {
  const found = new Set();
  const any = [];
  walk(root, '', any, (n) => AUTOLOAD_BASENAMES.has(n));
  for (const r of any) found.add(r);
  for (const d of AUTOLOAD_DIRS) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    const xs = [];
    walk(abs, d, xs, () => true);
    for (const r of xs) found.add(r);
  }
  for (const f of AUTOLOAD_FILES) if (fs.existsSync(path.join(root, f))) found.add(f);
  return [...found].sort();
}

function gitSha(root, ref) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * 列挙できる入力の記録(IMPL-0253)。root は既定ブランチの作業ツリー、dir は差分を書き出した一時の置き場。
 * shaOf はテストで差し替える(既定は git rev-parse)
 */
export function collectInputs({ root = ROOT, dir, baseRef = process.env.BASE_REF ?? '', shaOf = (ref) => gitSha(root, ref) } = {}) {
  const instr = [];
  walk(path.join(root, INSTRUCTIONS_DIR), INSTRUCTIONS_DIR, instr, () => true);
  const artifacts = ['diff.patch', 'files.txt'].map((f) => {
    const e = entry(dir, f);
    return { ...e, path: `$RUNNER_TEMP/ai-review/${f}` };
  });
  return {
    kind: 'ai-review-inputs',
    version: 1,
    shas: {
      defaultBranch: shaOf('HEAD'),
      base: baseRef ? shaOf(`refs/remotes/origin/${baseRef}`) : null,
      prHead: shaOf('refs/remotes/pr/head'),
    },
    instructions: instr.map((r) => entry(root, r)),
    artifacts,
    autoloadCandidates: autoloadCandidates(root).map((r) => entry(root, posix(r))),
    notes: [NOTE.candidates, NOTE.notVerified],
  };
}

/** 要約へ書く文字列を、コードブロックの外へ出られない形にする(道具の書いた値・ファイル名を Markdown として解釈させない) */
const fenceSafe = (s) => String(s).replace(/```/g, "'''").replace(/[\r\n]+/g, ' ');
const block = (lines) => ['```text', ...lines.map(fenceSafe), '```'];
const row = (e) => `${e.sha256 ?? '(sha256 なし)'}  ${e.path}${e.note ? `  # ${e.note}` : ''}`;

export function inputsSummary(rec) {
  const L = ['### AI レビューへ渡した入力の記録(ワークフローが列挙できるもの)', ''];
  for (const n of rec.notes) L.push(`- ${n}`);
  L.push('- 道具の側の入力(起動の指示・道具の定義・実際に読んだファイル)は、差し込んだ手順が書く tool-inputs.json による(後段の表示)', '');
  L.push(...block([
    `既定ブランチ(作業ツリー): ${rec.shas.defaultBranch ?? '(取得できない)'}`,
    `基底: ${rec.shas.base ?? '(取得できない)'}`,
    `PR の先頭: ${rec.shas.prHead ?? '(取得できない)'}`,
    '',
    `[指示の置き場 ${INSTRUCTIONS_DIR}/] ${rec.instructions.length} 件`,
    ...rec.instructions.map(row),
    '',
    '[差分とファイルの一覧]',
    ...rec.artifacts.map(row),
    '',
    `[作業ツリーにある自動読込の候補] ${rec.autoloadCandidates.length} 件`,
    ...(rec.autoloadCandidates.length ? rec.autoloadCandidates.map(row) : ['(なし)']),
  ]));
  L.push('');
  return L.join('\n');
}

const nonEmpty = (v) => (typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined && (typeof v !== 'object' || Object.values(v).some(nonEmpty)));

/**
 * tool-inputs.json の欄の欠落(契約: .github/ai-review/README.md)。text が null ならファイルが無い。
 * 返すのは { state: 'absent' | 'unreadable' | 'incomplete' | 'present', problems, data }。中身が実際の受け取りと一致するかは確かめない
 */
export function toolInputsCheck(text) {
  if (text === null || text === undefined) return { state: 'absent', problems: ['tool-inputs.json が無い'] };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { state: 'unreadable', problems: [`tool-inputs.json を JSON として読めない(${e.message})`] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { state: 'unreadable', problems: ['tool-inputs.json の最上位がオブジェクトでない'] };
  const p = [];
  if (!nonEmpty(data.launch)) p.push('launch(起動の指示: 起動のコマンドと、モデルへ渡した指示の所在・sha256)が無い');
  if (!Array.isArray(data.tools)) p.push('tools(道具の定義の一覧。与えていなければ空の配列)が配列でない');
  else data.tools.forEach((t, i) => { if (!nonEmpty(t?.name ?? t)) p.push(`tools[${i}] に name が無い`); });
  if (!Array.isArray(data.read)) p.push('read(実際に読んだファイルの一覧。道具の実行の記録から)が配列でない');
  else data.read.forEach((r, i) => { if (!nonEmpty(r?.path ?? r)) p.push(`read[${i}] に path が無い`); });
  if (!nonEmpty(data.source)) p.push('source(この記録を書いた元の、道具の実行の記録の所在)が無い');
  return { state: p.length ? 'incomplete' : 'present', problems: p, data };
}

/**
 * findings.json の欄の欠落(IMPL-0155)。text が null ならファイルが無い(散文だけの出力)。
 * 指摘を消さない。返す items は入力の指摘と同じ数・同じ順
 */
export function findingsCheck(text) {
  if (text === null || text === undefined) return { state: 'absent', items: [] };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { state: 'unreadable', items: [], why: `findings.json を JSON として読めない(${e.message})` };
  }
  const list = Array.isArray(data) ? data : data?.findings;
  if (!Array.isArray(list)) return { state: 'unreadable', items: [], why: 'findings.json に指摘の配列(findings)が無い' };
  const items = list.map((f, i) => {
    const missing = [];
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { index: i, missing: ['指摘がオブジェクトでない(欄を読めない)'], location: null };
    if (!nonEmpty(f.location)) missing.push('所在(location)');
    if (!nonEmpty(f.basis)) missing.push('根拠(basis)');
    else if (typeof f.basis === 'object') {
      if (!nonEmpty(f.basis.criterion)) missing.push('根拠のうち照らした基準(basis.criterion)');
      if (!nonEmpty(f.basis.fact)) missing.push('根拠のうち見た事実(basis.fact)');
    }
    if (f.execution === true && !nonEmpty(f.run)) {
      missing.push(nonEmpty(f.command) && nonEmpty(f.observed)
        ? '実行の記録の所在(run)。コマンドと観測した結果はあるが、実行で確かめたとは記録しない'
        : '実行の記録の所在(run)');
    }
    return { index: i, missing, location: nonEmpty(f.location) ? (typeof f.location === 'string' ? f.location : JSON.stringify(f.location)) : null };
  });
  return { state: 'checked', items };
}

export function findingsSummary(tool, fnd) {
  const L = ['### 道具の側の入力と、指摘の欄の欠落(AI レビューの出力の形の表示)', ''];
  if (tool.state === 'present') {
    L.push(`- ${NOTE.toolSelfReport}`, '');
    const d = tool.data;
    L.push(...block([
      `launch: ${typeof d.launch === 'string' ? d.launch : JSON.stringify(d.launch)}`,
      `source: ${typeof d.source === 'string' ? d.source : JSON.stringify(d.source)}`,
      `[tools] ${d.tools.length} 件`,
      ...d.tools.map((t) => (typeof t === 'string' ? t : `${t.name}${t.sha256 ? `  ${t.sha256}` : ''}`)),
      `[read] ${d.read.length} 件`,
      ...d.read.map((r) => (typeof r === 'string' ? r : `${r.sha256 ?? '(sha256 なし)'}  ${r.path}`)),
    ]));
  } else {
    L.push(`- **${NOTE.toolMissing}**`);
    L.push(...block(tool.problems));
  }
  L.push('');
  L.push(`- ${NOTE.structureNotBasis}`);
  if (fnd.state === 'absent') L.push(`- 構造化された指摘(findings.json)がありません。${NOTE.noStructure}`);
  else if (fnd.state === 'unreadable') L.push(`- ${fenceSafe(fnd.why)}。${NOTE.noStructure}`);
  else {
    const gaps = fnd.items.filter((x) => x.missing.length);
    L.push(`- 構造化された指摘 ${fnd.items.length} 件のうち、欄を欠く指摘 ${gaps.length} 件(欠く指摘も消していません。採否は人が記録します。所在か根拠を欠く指摘は「不採用(所在・根拠なし)」と記録してよい)`);
    if (gaps.length) L.push(...block(gaps.map((x) => `#${x.index + 1}${x.location ? ` ${x.location}` : ''}: 欠く欄 ${x.missing.join('、')}`)));
  }
  L.push('');
  return L.join('\n');
}

const readOrNull = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

function appendSummary(text) {
  const s = process.env.GITHUB_STEP_SUMMARY;
  if (s) fs.appendFileSync(s, `${text}\n`);
  process.stdout.write(`${text}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const at = args.indexOf('--dir');
  const dir = at >= 0 ? args[at + 1] : null;
  if (!['inputs', 'findings'].includes(cmd) || !dir) {
    console.error('使い方: node scripts/gate/ai-review-record.mjs inputs|findings --dir <差分を書き出した置き場>');
    process.exit(2);
  }
  if (cmd === 'inputs') {
    const rec = collectInputs({ dir });
    fs.mkdirSync(path.join(dir, 'record'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'record', 'inputs.json'), `${JSON.stringify(rec, null, 2)}\n`);
    appendSummary(inputsSummary(rec));
  } else {
    const tool = toolInputsCheck(readOrNull(path.join(dir, 'tool-inputs.json')));
    const fnd = findingsCheck(readOrNull(path.join(dir, 'findings.json')));
    appendSummary(findingsSummary(tool, fnd));
    if (tool.state !== 'present') console.log(`::warning::${NOTE.toolMissing}`);
  }
}
