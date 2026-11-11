// 判定記録の記述の内容の四半期の抽出(content-sampling.mjs)の試験。process-compass #359 / IMPL-0174
//
//   node scripts/gate/test-content-sampling.mjs
//
// 日付は引数で固定する(時計に依らない)。入口は一時の置き場の git のリポジトリで、記録用ブランチの無い構成として走らせる。
// GitHub へ問い合わせません。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { quarterOf, prevQuarter, quarterEnd, population, deriveSeed, sample, sampleCount, hadFindings, verifyRecord, samplingOverdueNote, BASE_COUNT } from './content-sampling.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? `\n  ${String(detail).slice(0, 1500)}` : ''}`);
  }
}

check('四半期: 2026-11-12 は 2026Q4、直前は 2026Q3、2026Q1 の直前は 2025Q4、2026Q3 の末日は 2026-09-30', quarterOf('2026-11-12 10:00') === '2026Q4' && prevQuarter('2026Q4') === '2026Q3' && prevQuarter('2026Q1') === '2025Q4' && quarterEnd('2026Q3') === '2026-09-30');
const recs = Array.from({ length: 12 }, (_, i) => ({ file: `docs/gates/g${i}.md`, judgedAt: `2026-1${i % 3}-1${i % 9} 10:00` }));
const reviews = new Map([[41, { reviews: [{ id: 9001, body: '挙動要約: 招待の一覧に失効の表示を足す変更', submitted_at: '2026-11-02T01:00:00Z' }, { id: 9002, body: '', submitted_at: '2026-11-02T02:00:00Z' }] }]]);
const pop = population({ gateRecords: [...recs, { file: 'records/gates/g0.md', judgedAt: '2026-10-10 10:00' }], reviews });
check('母集団: 様式と本文のある承認レビューを数え、同じ名の複製と本文の無いレビューを数えない', pop.length === 13 && pop.some((p) => p.id === 'PR #41 review 9001') && !pop.some((p) => p.id === 'PR #41 review 9002'), JSON.stringify(pop));
// IMPL-0174:ok(違反と適合の対。標準の実装マーク)
const ids = pop.map((p) => p.id);
check('種: 四半期と母集団の一覧から導き、一覧の並びに依らない(実行者は選べない)', deriveSeed('2026Q4', ids) === deriveSeed('2026Q4', [...ids].reverse()) && deriveSeed('2026Q4', ids) !== deriveSeed('2026Q3', ids) && deriveSeed('2026Q4', ids) !== deriveSeed('2026Q4', ids.slice(1)));
const seed = deriveSeed('2026Q4', ids);
check('抽出: 同じ種と母集団なら同じ5件を選ぶ', JSON.stringify(sample(pop, seed, BASE_COUNT)) === JSON.stringify(sample(pop, seed, BASE_COUNT)) && sample(pop, seed, BASE_COUNT).length === 5);
check('抽出: 母集団が5件以下なら全件', sample(pop.slice(0, 3), 'x', BASE_COUNT).length === 3);
// IMPL-0174:ng(違反と適合の対。標準の実装マーク)
check('件数: 5件を下回る指定を受け付けない(増やしてよく、減らさない)', sampleCount({ requested: 3 }).problem !== null && sampleCount({ requested: 8 }).count === 8 && sampleCount({}).count === 5);
const prevWithFinding = '| # | 抽出した記録 | 確かめた者 | 所見 |\n| --- | --- | --- | --- |\n| 1 | g1.md | 監査 一郎 | 確認していない事項が直前の記録の写し |\n';
check('件数: 前の四半期に所見があれば10件、所見が「なし」だけなら5件', hadFindings(prevWithFinding) && sampleCount({ prevText: prevWithFinding }).count === 10 && sampleCount({ prevText: prevWithFinding.replace('確認していない事項が直前の記録の写し', 'なし') }).count === 5);

// 入口と検証を、一時の置き場の git のリポジトリで通す
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-sampling-'));
try {
  for (const d of ['scripts', 'templates']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify({ configured: true }) + '\n');
  fs.mkdirSync(path.join(dir, 'docs/gates'), { recursive: true });
  for (let i = 0; i < 7; i++) {
    fs.writeFileSync(path.join(dir, `docs/gates/g${i}.md`), ['# ゲート判定記録', '', '| 項目 | 値 |', '| --- | --- |', `| ゲート | G-${1 + (i % 8)} 判定 |`, `| 対象 | F-00${i} |`, '| 判定者 | 判定 花子 |', `| 判定日時 | 2026-10-0${1 + i} 10:00 |`, '| 結果 | 通過 |', ''].join('\n'));
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  const node = (...a) => {
    const r = spawnSync(process.execPath, ['scripts/gate/content-sampling.mjs', ...a], { cwd: dir, encoding: 'utf8', env });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const rel = 'docs/content-sampling/2026Q4.md';
  const recPath = path.join(dir, rel);
  const popIds = Array.from({ length: 7 }, (_, i) => `g${i}.md`);
  const derived = deriveSeed('2026Q4', popIds);

  let r = node('--quarter', '2026Q4', '--today', '2026-12-15');
  check('入口: 四半期が締まる前は抽出しない', r.status === 1 && r.out.includes('まだ締まっていない'), r.out);
  r = node('--quarter', '2026Q4', '--today', '2027-01-05', '--count', '3');
  check('入口: 5件を下回る件数を拒む', r.status === 1 && r.out.includes('減らさない'), r.out);
  r = node('--quarter', '2026Q4', '--today', '2027-01-05', '--seed', 'chosen-by-me');
  check('IMPL-0174:ng 入口: 導いた種と違う --seed を拒む(種を選ばせない)', r.status === 1 && r.out.includes('照合の用途に限る') && !fs.existsSync(recPath), r.out);
  r = node('--quarter', '2026Q4', '--today', '2027-01-05', '--seed', derived);
  const rec = fs.existsSync(recPath) ? fs.readFileSync(recPath, 'utf8') : '';
  const listed = rec.split('\n').filter((l) => /^\| [1-9] \| g\d\.md \|/.test(l));
  check('IMPL-0174:ok 入口: 導いた種と同じ --seed は照合として受け付け、種・母集団の一覧・抽出した5件を書き、確かめた者と所見を空ける', r.status === 0 && rec.includes(`| 種 | ${derived} |`) && rec.includes('| 母集団の件数 | 7 |') && popIds.every((id) => rec.includes(`| ${id} |`)) && listed.length === 5 && listed.every((l) => /\| \| \|$/.test(l)), `${r.out}\n${rec}`);
  const today = '2027-01-10';
  const items = popIds.map((id) => ({ id, quarter: '2026Q4' }));
  // 記入の無い記録は済ませたことに数えない
  let note = samplingOverdueNote({ root: dir, today, items });
  check('/pit: 記入の無い・コミットされていない記録は、抽出を済ませたことに数えず注記に出す', Boolean(note) && note.includes('コミットされていない') && note.includes('記入が無い'), note);
  // 記入して1回でコミットすれば通る
  fs.writeFileSync(recPath, rec.replace(/^(\| [1-9] \| g\d\.md \|) \| \|$/gm, '$1 監査 一郎 | なし |'));
  git('add', '-A');
  git('commit', '-q', '-m', 'docs: 2026Q4 の抽出');
  r = node('--verify', '2026Q4');
  check('IMPL-0174:ok --verify: 記入して1回でコミットした記録は通る', r.status === 0, r.out);
  check('/pit: 検証を通る記録があれば注記を出さない', samplingOverdueNote({ root: dir, today, items }) === null);
  // 書き換え(2回目のコミット)は済ませたことに数えない
  fs.writeFileSync(recPath, fs.readFileSync(recPath, 'utf8').replace('監査 一郎 | なし |', '監査 次郎 | なし |'));
  git('add', '-A');
  git('commit', '-q', '-m', 'docs: 書き換え');
  r = node('--verify', '2026Q4');
  check('IMPL-0174:ng --verify: 2回目のコミットで書き換えた記録は数えない', r.status === 1 && r.out.includes('2 回のコミット'), r.out);
  // 消して起こし直すことは、履歴で止める
  fs.rmSync(recPath);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: 消す');
  r = node('--quarter', '2026Q4', '--today', '2027-01-05');
  check('IMPL-0174:ng 入口: 消した記録を起こし直さない(履歴にあれば止める)', r.status === 1 && r.out.includes('起こし直さない') && !fs.existsSync(recPath), r.out);
  // 種・抽出を書き換えた記録(関数で確かめる)
  const okText = rec.replace(/^(\| [1-9] \| g\d\.md \|) \| \|$/gm, '$1 監査 一郎 | なし |');
  check('検証: 種を書き換えた記録は一致しない', verifyRecord({ text: okText.replace(derived, 'f'.repeat(64)), quarter: '2026Q4', items, commits: ['a'] }).some((p) => p.includes('種が')));
  const firstPicked = listed[0].split('|')[2].trim();
  const other = popIds.find((id) => !listed.some((l) => l.includes(`| ${id} |`)));
  check('検証: 抽出した記録を差し替えた記録は再現と一致しない', verifyRecord({ text: okText.replace(`| ${firstPicked} | 監査`, `| ${other} | 監査`), quarter: '2026Q4', items, commits: ['a'] }).some((p) => p.includes('再現した抽出と一致しない')));
  check('検証: 母集団の一覧から記録を抜いた記録は、種も母集団も一致しない', (() => { const p = verifyRecord({ text: okText.replace(`| ${popIds[6]} |\n`, ''), quarter: '2026Q4', items, commits: ['a'] }); return p.some((x) => x.includes('母集団の一覧')) && p.some((x) => x.includes('種が')); })());
  // 規定を運び始めた四半期・案件の開始より前には、遡って注記を出さない
  const q3 = popIds.map((id) => ({ id, quarter: '2026Q3' }));
  check('/pit: 規定を運び始めた四半期(2026Q4)より前の四半期には、遡って注記を出さない', samplingOverdueNote({ root: dir, today: '2026-10-05', items: q3 }) === null);
  const q1 = popIds.map((id) => ({ id, quarter: '2027Q1' }));
  check('/pit: 案件の開始の四半期より前には注記を出さず、開始の後は出す', samplingOverdueNote({ root: dir, today: '2027-04-05', items: q1, startQuarter: '2027Q2' }) === null && Boolean(samplingOverdueNote({ root: dir, today: '2027-04-05', items: q1, startQuarter: '2027Q1' })));
} finally {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`test-content-sampling: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
