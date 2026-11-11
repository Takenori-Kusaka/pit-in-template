// 既定ブランチへの push の契機の形を、ワークフローの定義から読んで確かめる(標準 第3章 3.13.5、第5章 準拠テンプレート
// 「既存のリポジトリへの持ち込み」。process-compass #362 / ADR-0123)。
//
// 形の約束:
//   - gate-g5.yml は push を契機に持たず、workflow_call と pull_request を持つ
//   - gate-g5-push.yml は push だけを契機に持ち、絞りはすべてのブランチ('**')。タグ・パスの絞りを持たない
//   - gate-g5-push.yml のジョブは1つで、ID も名も gate-g5 でなく、式の名を使わない。条件は
//     github.ref == format('refs/heads/{0}', github.event.repository.default_branch)。呼び先は ./.github/workflows/gate-g5.yml
//   - どのワークフローにも、gate-g5.yml の集約のほかに ID か名が gate-g5 のジョブが無い
//
// 名が gate-g5 の check run が PR の先頭のコミットに別の契機で付くと、必須チェック gate-g5 を満たしてしまう
// (2026-11-11 の実機の確認。既定ブランチでないブランチへの push の skipped のジョブで、PR の検査が落ちる変更をマージできた)。
// 確かめないこと: GitHub 上の振る舞い(呼び出し側のジョブが skipped のときの check run の名、呼ばれた側の github コンテキスト)。
// それは実機の観測に依る(EV-0245)。YAML は、このテンプレートの書き方(2 字下げのキー)だけを読む。

import fs from 'node:fs';
import path from 'node:path';
import { jobsOf } from './g5-aggregate.mjs';

export const G5_WORKFLOW_FILE = '.github/workflows/gate-g5.yml';
export const PUSH_WORKFLOW_FILE = '.github/workflows/gate-g5-push.yml';
export const PUSH_JOB = 'default-push';
export const PUSH_CONDITION = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
const REQUIRED = 'gate-g5';

const lf = (t) => String(t ?? '').replace(/\r\n/g, '\n');
/** 行の末尾のコメントを除く(引用符の外の「 #」から後) */
const stripComment = (line) => {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line;
};
const unquote = (v) => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');

/** on: の下の事象 → 事象の本文の行(コメントを除く) */
export function eventsOf(text) {
  const lines = lf(text).split('\n').map(stripComment);
  const at = lines.findIndex((l) => /^(on|'on'|"on"):\s*$/.test(l));
  const out = new Map();
  if (at < 0) {
    const inline = lines.find((l) => /^(on|'on'|"on"):\s*\S/.test(l));
    if (inline) for (const e of inline.replace(/^[^:]+:\s*/, '').replace(/[[\]]/g, '').split(',').map((s) => unquote(s)).filter(Boolean)) out.set(e, []);
    return out;
  }
  let cur = null;
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break;
    const m = line.match(/^ {2}([A-Za-z_]+):\s*(.*)$/);
    if (m) {
      cur = m[1];
      out.set(cur, m[2] ? [`    ${m[2]}`] : []);
      continue;
    }
    if (cur && line.trim()) out.get(cur).push(line);
  }
  return out;
}

/** ジョブの本文から 4 字下げのキーの値を読む */
const keyOf = (body, key) => {
  const m = lf(body).split('\n').map(stripComment).map((l) => l.match(new RegExp(`^ {4}${key}:\\s*(.*)$`))).find(Boolean);
  return m ? m[1].trim() : null;
};
const norm = (v) => unquote(v).replace(/\$\{\{\s*|\s*\}\}/g, '').replace(/"/g, "'").replace(/\s+/g, ' ').trim();

/** ID か名が gate-g5 のジョブ(名の式に 'gate-g5' の文字列を含むものも数える) */
function requiredNamedJobs(text) {
  const out = [];
  for (const [id, body] of jobsOf(text)) {
    const name = keyOf(body, 'name');
    const n = name === null ? null : unquote(name);
    if (id === REQUIRED || n === REQUIRED || (n !== null && /\$\{\{/.test(n) && /['"]gate-g5['"]/.test(n))) out.push({ id, name: n });
  }
  return out;
}

/**
 * 形の不備を返す。files: { [相対パス]: 本文 }(.github/workflows/ の下のワークフロー)。gate-g5.yml が無いときは確かめない
 * (その欠けは事前点検の gate-g5-workflow と契約検査の「6. CI の設定」が出す)
 */
export function pushTriggerProblems(files) {
  const problems = [];
  const g5 = files[G5_WORKFLOW_FILE];
  if (g5 === undefined) return problems;
  const ev = eventsOf(g5);
  if (ev.has('push')) problems.push('gate-g5.yml が push を契機に持つ(旧版の書き方。既定ブランチへの push は gate-g5-push.yml から呼ぶ。名を固定した push の契機は、既定ブランチの名が違うと黙って走らない)');
  if (!ev.has('workflow_call')) problems.push('gate-g5.yml が workflow_call を持たない(gate-g5-push.yml から呼べない)');
  if (!ev.has('pull_request')) problems.push('gate-g5.yml が pull_request を契機に持たない');

  const push = files[PUSH_WORKFLOW_FILE];
  if (push === undefined) problems.push('.github/workflows/gate-g5-push.yml が無い(既定ブランチへの push で契約検査が走らない)');
  else {
    const pev = eventsOf(push);
    const others = [...pev.keys()].filter((e) => e !== 'push');
    if (!pev.has('push')) problems.push('gate-g5-push.yml が push を契機に持たない');
    if (others.length) problems.push(`gate-g5-push.yml が push のほかの契機を持つ(${others.join('・')})`);
    if (pev.has('push')) {
      const body = pev.get('push').join('\n');
      const br = body.match(/^ {4}branches:\s*(.*)$/m);
      const vals = br ? br[1].replace(/[[\]]/g, '').split(',').map((s) => unquote(s)).filter(Boolean) : [];
      if (!br || vals.length !== 1 || vals[0] !== '**') problems.push(`gate-g5-push.yml の push の絞りが branches: ['**'] でない(${br ? br[1] : '絞りなし。タグの push でも起動する'})`);
      const extra = [...body.matchAll(/^ {4}([a-z-]+):/gm)].map((m) => m[1]).filter((k) => k !== 'branches');
      if (extra.length) problems.push(`gate-g5-push.yml の push が branches のほかの絞りを持つ(${extra.join('・')})`);
    }
    const jobs = jobsOf(push);
    if (jobs.size !== 1) problems.push(`gate-g5-push.yml のジョブが1つでない(${jobs.size} 件)`);
    for (const [id, body] of jobs) {
      const name = keyOf(body, 'name');
      if (id !== PUSH_JOB) problems.push(`gate-g5-push.yml のジョブの ID が ${PUSH_JOB} でない(${id})`);
      if (name === null || unquote(name) !== PUSH_JOB) problems.push(`gate-g5-push.yml のジョブの名が ${PUSH_JOB} でない(${name ?? '名なし'}。名を式にすると、skipped のときの check run の名が GitHub の表示の振る舞いに依る)`);
      const cond = keyOf(body, 'if');
      if (cond === null || norm(cond) !== PUSH_CONDITION) problems.push(`gate-g5-push.yml のジョブの条件が「${PUSH_CONDITION}」でない(${cond ?? '条件なし'}。github.ref_name はタグと区別しない)`);
      const uses = keyOf(body, 'uses');
      if (uses === null || unquote(uses) !== './.github/workflows/gate-g5.yml') problems.push(`gate-g5-push.yml のジョブが ./.github/workflows/gate-g5.yml を呼ばない(${uses ?? 'uses なし'})`);
    }
  }

  for (const [rel, text] of Object.entries(files)) {
    for (const j of requiredNamedJobs(text)) {
      if (rel === G5_WORKFLOW_FILE && j.id === REQUIRED && j.name === REQUIRED) continue;
      problems.push(`${rel} のジョブ ${j.id}(名 ${j.name ?? 'なし'})が必須チェックの名 gate-g5 を持つ。集約(gate-g5.yml の gate-g5)のほかの契機で名が gate-g5 の check run が付くと、必須チェックを満たしてしまう`);
    }
  }
  return problems;
}

/** 作業ツリーのワークフローを読む */
export function readWorkflows(root) {
  const dir = path.join(root, '.github/workflows');
  const files = {};
  if (!fs.existsSync(dir)) return files;
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) files[`.github/workflows/${f}`] = fs.readFileSync(path.join(dir, f), 'utf8');
  return files;
}
