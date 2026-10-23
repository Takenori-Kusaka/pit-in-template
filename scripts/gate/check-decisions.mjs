// 判断記録(ADR)の状態と、置き換えの両側の参照を検査する(標準 第6章 テンプレ2「置き換えと廃止」、第4章 G-3「記載の検査」)。
//
//   node scripts/gate/check-decisions.mjs              検査する。不一致があれば終了コード 1
//   node scripts/gate/check-decisions.mjs --overdue    期限つきの実験のうち、期限を過ぎて結果が状態に反映されていないものを出す(失敗にしない)
//   node scripts/gate/check-decisions.mjs --json       結果を JSON で出す
//   オプション --root <dir>(既定はリポジトリの直下)、--today YYYY-MM-DD(既定は今日)
//
// 読む置き場は 2 つ。context/decisions/(現に効いている判断記録)と context/_archive/decisions/(保管領域)。
// どちらも README.md は数えない。
//
// 検査すること(標準 第6章 テンプレ2):
//   1. 状態の行が 4 つの語彙(採用 / 一部置き換え(→ ADR-MMM の決定 n)/ 置き換え(→ ADR-MMM)/ 廃止)のどれかである
//   2. 「置き換える決定」の欄がある(何も置き換えない場合は「なし」)
//   3. 置き換えられた側の状態の行が指す後継が、「置き換える決定」の欄で置き換えられた側を指している。逆向きも同じ。
//      全部の置き換え(「(全部)」)は状態「置き換え」と、一部の置き換えは状態「一部置き換え」と対応する
//   4. 状態が置き換え・廃止の判断記録は保管領域にあり、採用・一部置き換えの判断記録は保管領域に無い
//
// 確かめないこと: 置き換えた決定の内容が妥当か、決定の番号(決定 n)が実在するか、欄が空でないか・回復の時間が幅か・
// 兆候が「なし」でないか(第4章 G-3「記載の検査」のうち、この 3 つは実装していない)。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './config.mjs';

export const DECISIONS_DIR = 'context/decisions';
export const ARCHIVE_DIR = 'context/_archive/decisions';

const ADR_REF = /ADR-(\d{1,5})/g;
const pad = (n) => `ADR-${String(Number(n)).padStart(4, '0')}`;

/** HTML コメントを除く。様式の説明に書いた語彙を、記入として読まない */
const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');

/** 「- 欄: 値」の行の値を返す。無ければ null */
function bulletField(text, label) {
  const re = new RegExp(`^[ \\t]*[-*][ \\t]*${label}[ \\t]*[::][ \\t]*(.*?)[ \\t]*$`, 'm');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/** 状態の行を返す。「- 状態:」の行を優先し、無ければ「## ステータス」の節の最初の行を読む(旧い様式) */
export function stateLineOf(text) {
  const body = stripComments(text);
  const bullet = bulletField(body, '状態');
  if (bullet !== null) return bullet;
  const parts = body.replace(/\r\n/g, '\n').split(/^##[ \t]*ステータス[ \t]*$/m);
  if (parts.length < 2) return null;
  const line = parts[1].split(/^##\s/m)[0].split('\n').map((l) => l.trim()).find(Boolean);
  return line ?? null;
}

/** 状態の行を分類する。partial は superseded より先に見る(語が含まれるため) */
export function classifyState(line) {
  if (line === null || line === undefined) return { kind: null, successors: [] };
  const t = String(line).normalize('NFKC');
  const successors = [...t.matchAll(ADR_REF)].map((m) => pad(m[1]));
  if (/廃止/.test(t)) return { kind: 'abolished', successors };
  if (/一部置き換え|一部を置き換え/.test(t)) return { kind: 'partial', successors };
  if (/置き換え/.test(t)) return { kind: 'superseded', successors };
  if (/採用/.test(t)) return { kind: 'adopted', successors };
  return { kind: null, successors };
}

/** 「置き換える決定」の欄を読む。無ければ null。「なし」は空の配列。各項目は { id, whole } */
export function replacesOf(text) {
  const v = bulletField(stripComments(text), '置き換える決定');
  if (v === null) return null;
  const t = v.normalize('NFKC');
  if (/^(なし|無し|-|—)?$/.test(t.trim())) return [];
  const out = [];
  for (const m of t.matchAll(/ADR-(\d{1,5})([^、,;]*)/g)) {
    out.push({ id: pad(m[1]), whole: /全部/.test(m[2]) });
  }
  return out;
}

/** 期限の欄(期限つきの実験)。無い・「なし」なら null */
export function deadlineOf(text) {
  const v = bulletField(stripComments(text), '期限[^::\\n]*');
  if (!v) return null;
  const m = v.normalize('NFKC').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** 状態の行に添えた継続の日(「継続(YYYY-MM-DD)」)。無ければ null */
export function continuedOf(line) {
  const m = String(line ?? '').normalize('NFKC').match(/継続[^0-9]{0,6}(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** 1件の判断記録を読む。file はリポジトリの直下からの相対パス */
export function parseDecision(text, file) {
  const base = path.basename(file);
  const num = base.match(/^(\d{1,5})-/) ?? String(text).match(/^#\s*ADR-(\d{1,5})/m);
  const stateLine = stateLineOf(text);
  const state = classifyState(stateLine);
  return {
    file,
    id: num ? pad(num[1]) : null,
    archived: file.replace(/\\/g, '/').startsWith(`${ARCHIVE_DIR}/`),
    stateLine,
    kind: state.kind,
    successors: state.successors,
    replaces: replacesOf(text),
    deadline: deadlineOf(text),
    continued: continuedOf(stateLine),
  };
}

/** 置き場の判断記録を読む。README.md と .md 以外は数えない */
export function loadDecisions(root = ROOT) {
  const out = [];
  for (const dir of [DECISIONS_DIR, ARCHIVE_DIR]) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.md') || /^readme\.md$/i.test(f)) continue;
      const rel = `${dir}/${f}`;
      out.push(parseDecision(fs.readFileSync(path.join(abs, f), 'utf8'), rel));
    }
  }
  return out;
}

const KIND_LABEL = { adopted: '採用', partial: '一部置き換え', superseded: '置き換え', abolished: '廃止' };

/** 検査する。problems は不一致(失敗にする)。counts は状態ごとの件数 */
export function checkDecisions(list) {
  const problems = [];
  const byId = new Map();
  for (const d of list) {
    if (!d.id) {
      problems.push(`${d.file}: 番号が読めない(ファイル名を NNNN-<英語のケバブケース>.md にする)`);
      continue;
    }
    if (byId.has(d.id)) problems.push(`${d.id}: 番号が重複している(${byId.get(d.id).file} と ${d.file})`);
    else byId.set(d.id, d);
  }
  for (const d of list) {
    const name = d.id ?? d.file;
    if (!d.kind) {
      problems.push(`${name}: 状態の行が読めない(採用 / 一部置き換え(→ ADR-MMM の決定 n) / 置き換え(→ ADR-MMM) / 廃止 のいずれか。記載: ${d.stateLine ?? 'なし'})`);
      continue;
    }
    if (d.replaces === null) problems.push(`${name}: 「置き換える決定」の欄が無い(何も置き換えない場合は「- 置き換える決定: なし」と書く)`);
    // 置き場(第6章 テンプレ2。全部の置き換え・廃止は保管領域へ移し、ほかは移さない)
    if ((d.kind === 'superseded' || d.kind === 'abolished') && !d.archived) {
      problems.push(`${name}: 状態が「${KIND_LABEL[d.kind]}」なのに ${DECISIONS_DIR}/ にある(その状態にした変更で ${ARCHIVE_DIR}/ へ移す。削除しない)`);
    }
    if ((d.kind === 'adopted' || d.kind === 'partial') && d.archived) {
      problems.push(`${name}: 状態が「${KIND_LABEL[d.kind]}」なのに保管領域にある(効いている決定を含む判断記録は ${DECISIONS_DIR}/ に置く)`);
    }
    // 旧い側 → 新しい側
    if (d.kind === 'partial' || d.kind === 'superseded') {
      if (!d.successors.length) problems.push(`${name}: 状態「${KIND_LABEL[d.kind]}」に後継の番号が無い(→ ADR-MMM を書く)`);
      for (const s of d.successors) {
        const succ = byId.get(s);
        if (!succ) {
          problems.push(`${name}: 状態の行が指す後継 ${s} が無い`);
          continue;
        }
        const entry = (succ.replaces ?? []).find((r) => r.id === d.id);
        if (!entry) problems.push(`${name}: 後継 ${s} の「置き換える決定」の欄が ${d.id} を指していない`);
        else if (d.kind === 'superseded' && !entry.whole) problems.push(`${name}: 状態は「置き換え」(全部)だが、${s} の「置き換える決定」は一部の置き換えとして書かれている(「${d.id}(全部)」とする)`);
        else if (d.kind === 'partial' && entry.whole) problems.push(`${name}: 状態は「一部置き換え」だが、${s} の「置き換える決定」は全部の置き換え(「(全部)」)として書かれている`);
      }
    }
    // 新しい側 → 旧い側
    for (const r of d.replaces ?? []) {
      const old = byId.get(r.id);
      if (!old) {
        problems.push(`${name}: 「置き換える決定」が指す ${r.id} が無い`);
        continue;
      }
      const want = r.whole ? 'superseded' : 'partial';
      if (!old.successors.includes(d.id) || (old.kind !== 'partial' && old.kind !== 'superseded')) {
        problems.push(`${name}: 置き換えた ${r.id} の状態の行が ${d.id} を指していない(${r.id} の状態を「${KIND_LABEL[want]}(→ ${d.id}${r.whole ? '' : ' の決定 n'})」にする。状態の行だけは書き換えてよい)`);
      }
    }
  }
  const counts = { adopted: 0, partial: 0, superseded: 0, abolished: 0, unknown: 0 };
  for (const d of list) counts[d.kind ?? 'unknown'] += 1;
  return { problems, counts, total: list.length };
}

/**
 * 期限つきの実験の判断記録のうち、期限を過ぎて結果が状態に反映されていないもの(改善サイクル。四半期の振り返りの入力)。
 * 反映とみなすのは、状態が採用以外になったか、状態の行に期限の日以後の継続の日が添えられている場合
 */
export function overdueDecisions(list, today = new Date().toISOString().slice(0, 10)) {
  return list.filter((d) => d.deadline && d.deadline < today && d.kind === 'adopted' && !(d.continued && d.continued >= d.deadline));
}

/** 状態ごとの件数を 1 行にする(出荷判定の証跡の集約が使う) */
export function countsLine(result) {
  const c = result.counts;
  return `採用 ${c.adopted} 件 / 一部置き換え ${c.partial} 件 / 置き換え ${c.superseded} 件 / 廃止 ${c.abolished} 件${c.unknown ? ` / 状態が読めない ${c.unknown} 件` : ''}(保管領域を含む。README を数えない)`;
}

function main(argv) {
  const opt = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : null;
  };
  const root = opt('--root') ? path.resolve(opt('--root')) : ROOT;
  const today = opt('--today') ?? new Date().toISOString().slice(0, 10);
  const list = loadDecisions(root);
  const result = checkDecisions(list);
  const overdue = overdueDecisions(list, today);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...result, overdue: overdue.map((d) => ({ id: d.id, file: d.file, deadline: d.deadline })) }, null, 2));
    return result.problems.length && !argv.includes('--overdue') ? 1 : 0;
  }
  if (argv.includes('--overdue')) {
    if (!overdue.length) console.log(`期限を過ぎて結果が状態に反映されていない判断記録はありません(${today} 時点)`);
    else {
      console.log(`期限を過ぎて結果が状態に反映されていない判断記録: ${overdue.length} 件(${today} 時点。四半期の振り返りの入力。扱いは技術判断者が決める)`);
      for (const d of overdue) console.log(`- ${d.id}(${d.file})期限 ${d.deadline}。状態: ${d.stateLine}`);
    }
    return 0;
  }
  console.log(`判断記録: ${countsLine(result)}`);
  if (result.problems.length) {
    console.log(`置き換えの両側の参照・状態・置き場の不一致: ${result.problems.length} 件`);
    for (const p of result.problems) console.log(`- ${p}`);
    console.log('規約: 標準 第6章 テンプレ2「置き換えと廃止」(templates/02-adr.md)');
    return 1;
  }
  console.log('置き換えの両側の参照・状態・置き場の不一致: 0 件');
  if (overdue.length) console.log(`期限を過ぎて結果が状態に反映されていない判断記録: ${overdue.length} 件(--overdue で一覧。失敗にはしない)`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
