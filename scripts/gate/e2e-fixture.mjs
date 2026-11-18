// 結線の試験の足場(test-aggregate-wiring.mjs・test-delegation-wiring.mjs が使う。`test-` で始めないので試験としては走らない)。
//
// 単体の試験は判定の論理を守るが、集約や入口から呼ぶ「結線」を守らない。ここは、template の全ファイルを一時の置き場へ写し、
// `git init` した使い捨てのリポジトリで、実物の集約(aggregate-evidence.mjs)・入口(generate-profile.mjs --change)・
// D-0 の検査(check-d0.mjs)を動かす。基点のタグへ戻して場面ごとに使い回す(test-name-confirmation-timing.mjs の resetTo と同じ形)。
//
// GitHub へ問い合わせない(GITHUB_REPOSITORY・GH_TOKEN は空にする)。PR は、基底ブランチの写し(docs/records/reviews/pr-N.json)で渡す。
// 日付は過去に固定し、集約の --exception-day も固定する(実行日に依らない)。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sealChangeLog } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);

export const ANSWERS = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-biz-phase': 'growth', 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes',
};
export const PEOPLE = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊己'[i]}`, accounts: [{ login: `acc${i}`, id: 9000 + i }] }));
export const SEAT_MAP = { 'value-owner': 'p0', 'tech-lead': 'p5', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' };
export const seatsOf = (map = SEAT_MAP) => Object.entries(map).map(([role, accountable]) => ({ role, accountable }));
/** D-0 の附属書F F.2 の回答(Q1)の欄に入れる「いいえ」の記入 */
export const Q1_NO = 'いいえ。人身への危害は生じない';

const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

export function buildCfg(answers = {}, { people = PEOPLE, seats = seatsOf(), stack } = {}) {
  return JSON.parse(JSON.stringify(quiet(() => buildConfig({ ...ANSWERS, ...answers }, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, people, seats, ...(stack ? { stack } : {}) }).config)));
}

/**
 * 使い捨てのリポジトリを作る。
 *   config   構成(buildCfg の戻り値)。省略すると answers・people・seats から作る
 *   d0Q1     D-0 の Q1 の記入。null なら様式のまま(未記入)。既定は「いいえ」
 */
export function makeRepo({ config = null, answers = {}, people = PEOPLE, seats = seatsOf(), stack, d0Q1 = Q1_NO, d0 = true, userName = 'tester' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-wire-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const abs = (rel) => path.join(dir, rel);
  const co = abs('.github/CODEOWNERS');
  if (fs.existsSync(co)) fs.writeFileSync(co, fs.readFileSync(co, 'utf8').replace(/@OWNER\b/g, '@tester'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', userName);
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text);
  };
  const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
  const writeConfig = (cfg) => write('process.config.json', JSON.stringify(sealChangeLog(JSON.parse(JSON.stringify(cfg))), null, 2) + '\n');
  const cfg0 = config ?? buildCfg(answers, { people, seats, stack });
  writeConfig(cfg0);
  fs.rmSync(abs('docs/D-0-governance.md'), { force: true });
  const d0Path = 'docs/D-0-governance.md';
  const setD0Q1 = (value) => {
    const blank = read('templates/00-d0-governance.md');
    write(d0Path, value === null ? blank : blank.replace(/(\| 附属書F F\.2 の回答 \|)[^\n]*/, `$1 ${value} |`));
  };
  if (d0) setD0Q1(d0Q1);
  const commitAll = (msg) => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  commitAll('chore: init');
  git('tag', 'base');
  const resetTo = (tag = 'base') => {
    git('checkout', '-q', 'main');
    git('reset', '-q', '--hard', tag);
    git('clean', '-qfdx');
    for (const b of git('branch', '--format=%(refname:short)').split('\n').filter((x) => x && x !== 'main')) git('branch', '-q', '-D', b);
  };
  const node = (script, args = []) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const readJson = (rel) => {
    try {
      return JSON.parse(read(rel));
    } catch {
      return null;
    }
  };
  const runAggregate = (extra = []) => {
    fs.rmSync(abs('evidence'), { recursive: true, force: true });
    const r = node('scripts/gate/aggregate-evidence.mjs', ['--exception-day', '2026-11-20', ...extra]);
    const evidence = readJson('evidence/evidence.json');
    const rf = ['evidence/quality-report.md', 'evidence/report.md'].find((f) => fs.existsSync(abs(f)));
    return { status: r.status, out: r.out, evidence, gaps: evidence?.gaps ?? [], report: rf ? read(rf) : '' };
  };
  /** 入口(generate-profile.mjs --change)。dryRun なら書き込まない */
  const runChange = (obj, { dryRun = false } = {}) => {
    write('change.json', JSON.stringify(obj));
    const r = node('scripts/init/generate-profile.mjs', ['--change', 'change.json', ...(dryRun ? ['--dry-run'] : [])]);
    fs.rmSync(abs('change.json'), { force: true });
    return { ok: r.status === 0, status: r.status, out: r.out };
  };
  const runCheckD0 = () => {
    const r = node('scripts/gate/check-d0.mjs');
    return { ok: r.status === 0, status: r.status, out: r.out };
  };
  /** ゲート判定記録(docs/gates/)。obj の欄を様式の表にする */
  const writeGateRecord = (file, obj, body = '') => {
    const rows = Object.entries(obj).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
    write(`docs/gates/${file}`, `# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n${rows}\n${body}\n`);
  };
  const done = () => (process.env.KEEP_WORKSPACE ? console.log(`作業場所: ${dir}`) : fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { dir, abs, git, env, node, write, read, readJson, writeConfig, setD0Q1, commitAll, resetTo, runAggregate, runChange, runCheckD0, writeGateRecord, cfg: cfg0, done };
}

/** 集約の保証の開示の行(部分一致)を返す */
export const lineWith = (report, text) => String(report).split('\n').filter((l) => l.includes(text)).join('\n');

/** 試験の check。失敗を数えて最後に exit する */
export function checker() {
  let failures = 0;
  let checks = 0;
  const check = (name, ok, detail = '') => {
    checks++;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-10).join('\n       ')}`}`);
  };
  const finish = () => {
    console.log(failures ? `\nNG ${failures} 件(全 ${checks} 件)` : `\n全 ${checks} 件通過`);
    process.exit(failures ? 1 : 0);
  };
  return { check, finish };
}
