// 検査の道具を動かす Node の版の固定(process-compass #377)の試験。
// .github/workflows/ のうち scripts/ の Node の道具を実行するワークフローの各ジョブが、最初の `node scripts/` の手順より前に
// actions/setup-node で .github/gate-node-version を読むことを確かめる。固定しないと、ランナーの既定の Node で動き、
// 親の CI(標準のリポジトリ)が試験した版と食い違う。
//
//   node scripts/gate/test-gate-node.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, '.github/workflows');
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
}

/** ジョブごとの手順の行(jobs: の下の2段目のキーで区切る) */
export function jobsOf(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = [];
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (m) {
      cur = { name: m[1], lines: [] };
      jobs.push(cur);
    } else if (cur) cur.lines.push(l);
  }
  return jobs;
}

/** ジョブが Node の道具を動かす前に版を固定しているか。道具を動かさないジョブは null */
export function pinnedBeforeTools(job) {
  const firstTool = job.lines.findIndex((l) => /\bnode scripts\//.test(l));
  if (firstTool < 0) return null;
  const pin = job.lines.findIndex((l) => /node-version-file:\s*\.github\/gate-node-version/.test(l));
  return pin >= 0 && pin < firstTool;
}

const version = fs.existsSync(path.join(ROOT, '.github/gate-node-version')) ? fs.readFileSync(path.join(ROOT, '.github/gate-node-version'), 'utf8').trim() : null;
check('版の正本: .github/gate-node-version に、主の版の数が1つ書かれている', /^\d+$/.test(version ?? ''), String(version));

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yml'))) {
  for (const job of jobsOf(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
    const r = pinnedBeforeTools(job);
    if (r === null) continue;
    check(`${f} のジョブ ${job.name}: 道具を動かす前に Node の版を固定する`, r === true);
  }
}

// 判定の関数そのもの
check('判定: 固定の前に道具を動かすジョブを出す', pinnedBeforeTools({ lines: ['      - run: node scripts/gate/x.mjs', '          node-version-file: .github/gate-node-version'] }) === false);
check('判定: 道具を動かさないジョブは対象外', pinnedBeforeTools({ lines: ['      - run: echo hi'] }) === null);

console.log(failures ? `\n検査の道具の Node の版の試験: ${checks} 件のうち ${failures} 件が期待と一致しません` : `\n検査の道具の Node の版の試験: ${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
