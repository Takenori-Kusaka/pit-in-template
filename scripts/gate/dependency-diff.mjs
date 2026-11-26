// 依存関係の追加・更新を一覧にする(G-5 基準8)。
//
//   node scripts/gate/dependency-diff.mjs --base origin/main
//
// 合否は判定しません。**一覧を機械が出力する**ことが規定です。
// 追加・更新した依存の一覧は独立レビューの必須確認事項になります(G-6 判定基準5)。
//
// 一覧の欄の値のうち、レジストリへの照会が要るもの(公開日時・公開者・証明)は dependency-provenance.mjs が先に書く
// evidence/dependency-provenance.json を読みます。このファイルはネットワークを使いません(process-compass #455 / ADR-0261)。
// 解析の入力(dependency-collect.mjs)と照会の入力は、表示で切った後の行にしません。表示を切るときは、省略の件数を必ず出します。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, notice, loadConfig, loadAdapter } from './config.mjs';
import { git, changedManifests, collectEntries } from './dependency-collect.mjs';
import { MARK, marksOf, skipReasons } from './dependency-parse.mjs';

/** 表示で切る上限。印の付いた行は切らない(読ませない行を作らない)。生の差分の行は、省略の件数を出す */
export const UNMARKED_ROW_LIMIT = 40;
export const RAW_LINE_LIMIT = 40;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const SRC_LABEL = { public: '公開レジストリ', private: '私設・ミラー', git: 'git', url: 'URL', file: 'file', workspace: 'workspace', unknown: '不明' };
const day = (s) => (s ? String(s).slice(0, 10) : '—');

/** 依存の解決(install の段)を行う構成か。未実施なら理由を返す */
export function resolutionState(adapter) {
  if (!adapter) return { done: false, reason: 'アダプタを読めない' };
  const cmd = String(adapter.commands?.install ?? '').trim();
  if (!cmd) return { done: false, reason: `アダプタ ${adapter.id} の install が空(依存の解決が走らない。保証の開示 項目4 は依存の導入を対象にしない。ADR-0151)` };
  return { done: true, reason: `install: ${cmd}` };
}

/**
 * 一覧の組み立て(ネットワークも git も使わない)。
 * input: { base, details, entries, unparsed, queries, verification, resolution }
 */
export function buildReport(input) {
  const { base, details = [], entries = [], unparsed = [], queries = [], verification = { status: 'not-run', reason: '未指定', kinds: [] }, resolution } = input;
  const failed = new Set(verification.status === 'failed' ? verification.failedNames ?? [] : []);
  const rows = entries.map((e, i) => ({ e, q: queries[i], marks: marksOf(e, queries[i], failed) }));
  const marked = rows.filter((r) => r.marks.length);
  const unmarked = rows.filter((r) => !r.marks.length);
  const shownUnmarked = unmarked.slice(0, UNMARKED_ROW_LIMIT);
  const omittedRows = unmarked.length - shownUnmarked.length;
  const shownRows = rows.filter((r) => r.marks.length || shownUnmarked.includes(r));
  const rawOmitted = details.reduce((n, d) => n + Math.max(0, d.removed.length - RAW_LINE_LIMIT) + Math.max(0, d.added.length - RAW_LINE_LIMIT), 0);
  const notQueried = queries.filter((q) => q?.status === 'skipped' || q?.status === 'out-of-scope').length + Math.max(0, entries.length - queries.length);
  const reasons = skipReasons(queries);
  if (entries.length > queries.length) reasons.push(`照会の結果なし ${entries.length - queries.length} 件`);
  const lockless = entries.filter((e) => e.lockless).length;

  const md = [];
  md.push('## 依存関係の変更');
  md.push('');
  md.push('独立レビュー(G-6)の必須確認事項です。**追加が必要であることと、意図した部品であることの確認**を行ってください。印の付いた行を読んでください。この一覧は合否に使いません。');
  md.push('');
  md.push(`- 依存の解決: ${resolution?.done ? `実施(${resolution.reason})` : `未実施(${resolution?.reason ?? '不明'})`}`);
  md.push(`- 照会: ${entries.length} 件中 ${notQueried} 件を照会せず${reasons.length ? `(${reasons.join('、')})` : ''}`);
  md.push(
    `- 検証: ${verification.status === 'passed' ? '実施(失敗なし)' : verification.status === 'failed' ? `実施(失敗あり。${(verification.failedNames ?? []).length} 件の名前に「${MARK.VERIFY_FAILED}」)` : `未実施(${verification.reason ?? '理由なし'})`}` +
      (verification.kinds?.length ? `。種類: ${verification.kinds.join('・')}` : '。種類: 署名・来歴の証明・完全性は別。完全性(go mod verify)を来歴と数えない')
  );
  if (lockless) md.push(`- 推移的な依存は見えない: ロックファイルの無い構成の ${lockless} 件は、直接の依存の宣言だけを出している`);
  for (const u of unparsed) md.push(`- 解析せず: \`${u.file}\`(${u.reason})`);
  md.push(`- 印の付いた行: ${marked.length} 件(印: ${[...new Set(marked.flatMap((r) => r.marks))].join('・') || 'なし'})`);
  const omitTotal = omittedRows + rawOmitted;
  md.push(`- ${MARK.OMITTED}: ${omitTotal ? `印の無い行 ${omittedRows} 件、差分の行 ${rawOmitted} 件を表示から省いた(解析と照会は省く前の全件に行った)` : '0 件'}`);
  md.push('');
  if (shownRows.length) {
    md.push('| 印 | 名前 | 版 | 直接 | 解決元 | 版の公開日 | 名前の初回公開日 | 公開者 | 署名・来歴の証明 | 照会 |');
    md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const { e, q, marks } of shownRows) {
      const ok = q?.status === 'queried';
      const att = ok ? (q.attestation === null ? '—' : q.attestation ? '来歴の証明あり' : '来歴の証明なし') + (q.signaturePresent ? '・署名あり' : q.signaturePresent === false ? '・署名なし' : '') : '—';
      const state = q ? (q.status === 'queried' ? (q.missing ? `取得(欠け: ${q.missing.join('・')})` : '取得') : q.status === 'skipped' ? `照会せず(${q.reason})` : q.status === 'out-of-scope' ? `対象外(${q.reason})` : `取得できず(${q.reason})`) : '照会せず(結果なし)';
      md.push(
        `| ${marks.join('・') || '—'} | \`${e.name}\` | ${e.from ?? '—'} → ${e.to} | ${e.direct ? '直接' : '推移'} | ${SRC_LABEL[e.source] ?? e.source} | ${ok ? day(q.publishedAt) : '—'} | ${ok ? day(q.firstPublishedAt) : '—'} | ${ok ? q.publisher ?? '—' : '—'} | ${att} | ${state} |`
      );
    }
    md.push('');
  }
  for (const d of details) {
    md.push(`### \`${d.file}\``);
    md.push('');
    md.push('```diff');
    for (const l of d.removed.slice(0, RAW_LINE_LIMIT)) md.push(`- ${l}`);
    for (const l of d.added.slice(0, RAW_LINE_LIMIT)) md.push(`+ ${l}`);
    md.push('```');
    const o = Math.max(0, d.removed.length - RAW_LINE_LIMIT) + Math.max(0, d.added.length - RAW_LINE_LIMIT);
    if (o) md.push(`(表示から ${o} 行を省いた)`);
    md.push('');
  }
  const json = {
    base,
    manifestsChanged: details.map((d) => d.file),
    details,
    entries: rows.map((r) => ({ ...r.e, marks: r.marks, query: r.q ?? null })),
    unparsed,
    summary: { entries: entries.length, notQueried, marked: marked.length, omittedRows, rawOmitted, resolution: resolution ?? null, verification: verification.status },
  };
  return { md: md.join('\n'), json };
}

function readProvenance() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/dependency-provenance.json'), 'utf8'));
  } catch {
    return { queries: [], verification: { status: 'not-run', reason: '照会を実行していない(evidence/dependency-provenance.json が無い)', kinds: [] } };
  }
}

function main() {
  const base = arg('--base', 'origin/main');
  const touched = changedManifests(base);
  const details = [];
  for (const f of touched) {
    const diff = git(['diff', `${base}...HEAD`, '--unified=0', '--', f]);
    const lines = diff.split('\n');
    const pick = (p, skip) => lines.filter((l) => l.startsWith(p) && !l.startsWith(skip)).map((l) => l.slice(1).trim()).filter(Boolean);
    // 切らずに持つ。切るのは表示だけ(buildReport が省略の件数を出す)
    details.push({ file: f, added: pick('+', '+++'), removed: pick('-', '---') });
  }

  fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
  if (!touched.length) {
    fs.writeFileSync(path.join(ROOT, 'evidence/dependency-diff.json'), JSON.stringify({ base, manifestsChanged: [], details: [] }, null, 2) + '\n', 'utf8');
    notice('依存関係の変更はありません');
    process.exit(0);
  }
  let adapter = null;
  try {
    adapter = loadAdapter(loadConfig());
  } catch {
    /* 構成が読めなければ未実施として出す */
  }
  const { entries, unparsed } = collectEntries(base, touched);
  const prov = readProvenance();
  const { md, json } = buildReport({ base, details, entries, unparsed, queries: prov.queries ?? [], verification: prov.verification, resolution: resolutionState(adapter) });
  fs.writeFileSync(path.join(ROOT, 'evidence/dependency-diff.json'), JSON.stringify(json, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(ROOT, 'evidence/dependency-diff.md'), md, 'utf8');
  console.log(md);

  // GitHub Actions のジョブサマリへも出す
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
