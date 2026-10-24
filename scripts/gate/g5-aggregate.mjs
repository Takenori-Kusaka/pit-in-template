// G-5 の集約ジョブ(gate-g5)が合否に使う検査の集合を、ワークフローの定義から読む。
//
// 標準 第4章 G-5「判定基準を実装する検査と集約」(process-compass #290 / ADR-0073)。
// 必須ステータスチェックが指すのは集約ジョブ1つである。個々の検査のジョブを集約の needs から外すと、
// その検査が落ちても G-5 は通る。ブランチ保護も契約検査も「集約がある」ことしか見ないと、基準を実装する
// 検査は黙って外れる。ここでは、基準を実装するジョブが集約の needs にあり、集約がその結果を合否に使って
// いることを確かめる。契約検査(verify-gate-contract.mjs)と出荷判定の証跡の集約(aggregate-evidence.mjs の
// 保証の開示 項目4)が、同じ読み方を使う。
//
// 確かめないこと: ジョブの中の手順が実際に検査を実行しているか(手順の書き換えは、統制の設定の陰性の確認で人が確かめる)、
// 手順の continue-on-error、ジョブの if が常に偽になっていないか。YAML は、このテンプレートの書き方(2 字下げのジョブ、
// needs の配列か箇条)だけを読む。

import fs from 'node:fs';
import path from 'node:path';

export const G5_WORKFLOW = '.github/workflows/gate-g5.yml';
export const G5_AGGREGATE_JOB = 'gate-g5';

/**
 * G-5 の判定基準と、それを実装するジョブ(標準 第4章 G-5 の基準表)。基準6 のジョブ(context-format)が確かめるのは参照切れ
 * (相対リンクと取り込み @path)だけで、見出しのアンカー・逆引用符の中のパス・1ファイルの分量の上限は確かめない
 * (process-compass #314 / ADR-0083 決定3。`.claude/skills/gate/gates/G-5.md`)。基準8 は合否を判定しない(一覧を出すだけ)ため、
 * 集約に含めることを求めない
 */
export const G5_CRITERION_JOBS = [
  { criterion: 1, label: '全テスト', job: 'test' },
  { criterion: 2, label: '静的解析・脆弱性スキャン', job: 'static-analysis' },
  { criterion: 3, label: 'テストカバレッジ', job: 'test' },
  { criterion: 4, label: '曖昧語チェック', job: 'spec-lint' },
  { criterion: 5, label: '依存関係のライセンス検査', job: 'ip-clearance' },
  { criterion: 6, label: '文脈ファイルの形式検査(参照切れ)', job: 'context-format' },
  { criterion: 7, label: '秘匿情報の混入検査', job: 'secret-scan' },
];
/** 基準の外で G-5 の規則を実装するジョブ(構成と設定の整合、PR 単位の検査) */
export const G5_RULE_JOBS = [
  { label: '構成と CI・ブランチ保護の整合(契約検査)', job: 'contract' },
  { label: 'PR 単位の検査(禁止事項6・陰性の確認・区分の下限ほか)', job: 'pr-rules' },
];

/** ジョブ名 → ジョブの本文(2 字下げのキーから次の 2 字下げのキーまで) */
export function jobsOf(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const at = src.search(/^jobs:\s*$/m);
  if (at < 0) return new Map();
  const body = src.slice(at).split('\n').slice(1);
  const jobs = new Map();
  let cur = null;
  for (const line of body) {
    if (/^\S/.test(line)) break; // jobs: の外へ出た
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (m) {
      cur = m[1];
      jobs.set(cur, []);
      continue;
    }
    if (cur) jobs.get(cur).push(line);
  }
  return new Map([...jobs].map(([k, v]) => [k, v.join('\n')]));
}

/** ジョブの本文から needs の一覧を読む(`needs: [a, b]`、`needs: a`、箇条の3つの書き方) */
export function needsOf(jobBody) {
  const lines = String(jobBody ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {4}needs:\s*(.*?)\s*(?:#.*)?$/);
    if (!m) continue;
    const v = m[1];
    if (v.startsWith('[')) return v.replace(/[[\]]/g, '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (v) return [v.replace(/^['"]|['"]$/g, '')];
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^ {6}-\s*['"]?([A-Za-z0-9_-]+)['"]?\s*(?:#.*)?$/);
      if (item) out.push(item[1]);
      else if (lines[j].trim() && !/^\s*#/.test(lines[j])) break;
    }
    return out;
  }
  return [];
}

/**
 * 集約ジョブが合否に使う検査の集合と、その不備を返す。
 * effective: 集約の needs にあり、ジョブとして定義され、ジョブの単位で continue-on-error を持たず、集約が needs の結果を
 * 合否に使っているジョブ。problems: 基準を実装するジョブが effective に無い理由。notes: 確かめられない基準
 */
export function aggregateFindings(text) {
  const jobs = jobsOf(text);
  const problems = [];
  const notes = [];
  const agg = jobs.get(G5_AGGREGATE_JOB);
  if (!agg) {
    problems.push(`集約ジョブ "${G5_AGGREGATE_JOB}" がありません。必須ステータスチェックの名前は ${G5_AGGREGATE_JOB} に固定です`);
    return { needs: [], effective: new Set(), problems, notes };
  }
  const needs = needsOf(agg);
  // 集約が needs の結果で失敗させているか(結果を見ずに通す集約は、needs にあっても合否に使っていない)。結果を表示するだけの
  // echo の行は数えない
  const judged = agg.split('\n').filter((l) => !/^\s*echo\b/.test(l)).join('\n');
  const usesResults = /needs\.\*\.result/.test(judged) || needs.some((n) => judged.includes(`needs.${n}.result`));
  if (!usesResults) problems.push(`集約ジョブ "${G5_AGGREGATE_JOB}" が、needs のジョブの結果(needs.*.result)を合否に使っていません`);
  const effective = new Set();
  const why = new Map();
  for (const n of needs) {
    const body = jobs.get(n);
    if (body === undefined) why.set(n, `needs にあるジョブ "${n}" が定義されていません`);
    else if (/^ {4}continue-on-error:\s*(true|\$\{\{)/m.test(body)) why.set(n, `ジョブ "${n}" が continue-on-error を持ち、失敗しても集約へ失敗として届きません`);
    else if (usesResults) effective.add(n);
  }
  const required = [
    ...G5_CRITERION_JOBS.map((c) => ({ ...c, what: `G-5 基準${c.criterion}(${c.label})` })),
    ...G5_RULE_JOBS.map((c) => ({ ...c, what: c.label })),
  ];
  const seen = new Set();
  for (const r of required) {
    const key = `${r.job}:${r.what}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (effective.has(r.job)) continue;
    if (!usesResults && needs.includes(r.job)) continue; // 集約そのものの不備として上で出した
    const reason = why.get(r.job) ?? `ジョブ "${r.job}" が集約 "${G5_AGGREGATE_JOB}" の needs にありません`;
    problems.push(
      `${r.what} を実装する検査が、集約の合否に使われていません(${reason})。` +
        '集約から外すことで基準を外せません。基準を外せるのは標準 第8章の調整だけです(標準 第4章 G-5「判定基準を実装する検査と集約」)'
    );
  }
  notes.push(
    'G-5 基準6(文脈ファイルの形式検査)のジョブ context-format が確かめるのは参照切れ(相対リンクと取り込み @path)だけです。' +
      '見出しのアンカー、逆引用符の中のパス、1ファイルの分量の上限は確かめていません(採用者が足すときは、同じジョブか集約の needs へ入れます)'
  );
  return { needs, effective, problems, notes };
}

/** リポジトリのワークフローを読んで aggregateFindings を返す。ファイルが無ければ null */
export function readAggregate(root) {
  const p = path.join(root, G5_WORKFLOW);
  if (!fs.existsSync(p)) return null;
  return aggregateFindings(fs.readFileSync(p, 'utf8'));
}

/**
 * 保証の開示 項目4 の、機械検査ごとの表示(標準 附属書H H.6 項目4)。「実施」は、集約が合否に使ったジョブの検査に限る。
 * 構成にコマンドが書かれていること(設計の有効性)で「実施」と出さない
 *   name: アダプタのコマンド名(test / lint / audit / secretScan)。null ならコマンドの有無を見ない
 *   job: その検査を実行するジョブ
 */
export function machineCheckStatus({ adapter, hasTarget, aggregate, name, job, noRecord }) {
  if (!adapter) return noRecord;
  if (!hasTarget) return '未実施(検査対象が存在しない)';
  if (name && !(adapter.commands?.[name] ?? '').trim()) return '未実施(コマンドが未設定)';
  if (!aggregate) return `未実施(集約 ${G5_AGGREGATE_JOB} の定義 ${G5_WORKFLOW} が無い)`;
  if (!aggregate.effective.has(job)) return `未実施(ジョブ ${job} を集約 ${G5_AGGREGATE_JOB} が合否に使っていない)`;
  return `実施(結果は ${G5_AGGREGATE_JOB} に含む)`;
}
