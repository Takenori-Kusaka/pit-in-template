// 判定記録の記述の内容の四半期の抽出(content-sampling.mjs)の試験。process-compass #359 / IMPL-0174
//
//   node scripts/gate/test-content-sampling.mjs
//
// 日付と種は引数で固定する(時計に依らない)。入口は一時の置き場で、記録用ブランチの無い構成として走らせる。GitHub へ問い合わせません。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { quarterOf, prevQuarter, population, sample, sampleCount, hadFindings, samplingOverdueNote, BASE_COUNT } from './content-sampling.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? `\n  ${String(detail).slice(0, 1500)}` : ''}`);
  }
}

check('四半期: 2026-11-12 は 2026Q4、直前は 2026Q3、2026Q1 の直前は 2025Q4', quarterOf('2026-11-12 10:00') === '2026Q4' && prevQuarter('2026Q4') === '2026Q3' && prevQuarter('2026Q1') === '2025Q4');
const recs = Array.from({ length: 12 }, (_, i) => ({ file: `docs/gates/g${i}.md`, judgedAt: `2026-0${7 + (i % 3)}-1${i % 9} 10:00` }));
const reviews = new Map([[41, { reviews: [{ id: 9001, body: '挙動要約: 招待の一覧に失効の表示を足す変更', submitted_at: '2026-08-02T01:00:00Z' }, { id: 9002, body: '', submitted_at: '2026-08-02T02:00:00Z' }] }]]);
const pop = population({ gateRecords: [...recs, { file: 'records/gates/g0.md', judgedAt: '2026-07-10 10:00' }], reviews });
check('母集団: 様式と本文のある承認レビューを数え、同じ名の複製と本文の無いレビューを数えない', pop.length === 13 && pop.some((p) => p.id === 'PR #41 review 9001') && !pop.some((p) => p.id === 'PR #41 review 9002'), JSON.stringify(pop));
// IMPL-0174:ok(違反と適合の対。標準の実装マーク)
const a = sample(pop, 'seed-1', BASE_COUNT);
const b = sample(pop, 'seed-1', BASE_COUNT);
const c = sample(pop, 'seed-2', BASE_COUNT);
check('抽出: 同じ種と母集団なら同じ5件を選ぶ(種を記録すれば誰でも抽出をやり直せる)', a.length === 5 && JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a));
check('抽出: 種が違えば選び方が変わる', JSON.stringify(a) !== JSON.stringify(c));
check('抽出: 母集団が5件以下なら全件', sample(pop.slice(0, 3), 'x', BASE_COUNT).length === 3);
// IMPL-0174:ng(違反と適合の対。標準の実装マーク)
check('件数: 5件を下回る指定を受け付けない(増やしてよく、減らさない)', sampleCount({ requested: 3 }).problem !== null && sampleCount({ requested: 8 }).count === 8 && sampleCount({}).count === 5);
const prevWithFinding = '| # | 抽出した記録 | 確かめた者 | 所見 |\n| --- | --- | --- | --- |\n| 1 | docs/gates/g1.md | 監査 一郎 | 確認していない事項が直前の記録の写し |\n';
const prevNone = '| 項目 | 値 |\n| --- | --- |\n| 種 | x |\n\n| # | 抽出した記録 | 確かめた者 | 所見 |\n| --- | --- | --- | --- |\n| 1 | docs/gates/g1.md | 監査 一郎 | なし |\n';
check('件数: 前の四半期に所見があれば10件、所見が「なし」だけなら5件', hadFindings(prevWithFinding) && sampleCount({ prevText: prevWithFinding }).count === 10 && !hadFindings(prevNone) && sampleCount({ prevText: prevNone }).count === 5);
check('件数: 所見があった次の四半期に、10件を下回る指定を受け付けない', sampleCount({ prevText: prevWithFinding, requested: 6 }).problem !== null);

// /pit の注記
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-sampling-note-'));
  const items = pop.map((p) => ({ ...p }));
  const note = samplingOverdueNote({ root: dir, today: '2026-10-05', items });
  check('/pit: 直前の四半期(2026Q3)に母集団があり記録が無ければ、抽出の未実施を注記に出す', Boolean(note) && note.includes('2026Q3') && note.includes('母集団 13 件'), note);
  fs.mkdirSync(path.join(dir, 'docs/content-sampling'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/content-sampling/2026Q3.md'), prevNone);
  check('/pit: 直前の四半期の記録があれば、注記を出さない', samplingOverdueNote({ root: dir, today: '2026-10-05', items }) === null);
  check('/pit: 直前の四半期に母集団が無ければ、注記を出さない', samplingOverdueNote({ root: dir, today: '2027-05-05', items }) === null);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// 入口(content-sampling.mjs)を一時の置き場で通す
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-sampling-'));
  for (const d of ['scripts', 'templates']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify({ configured: true }) + '\n');
  fs.mkdirSync(path.join(dir, 'docs/gates'), { recursive: true });
  for (let i = 0; i < 7; i++) {
    fs.writeFileSync(path.join(dir, `docs/gates/g${i}.md`), ['# ゲート判定記録', '', '| 項目 | 値 |', '| --- | --- |', `| ゲート | G-${1 + (i % 8)} 判定 |`, `| 対象 | F-00${i} |`, '| 判定者 | 判定 花子 |', `| 判定日時 | 2026-08-0${1 + i} 10:00 |`, '| 結果 | 通過 |', ''].join('\n'));
  }
  const node = (...a) => {
    const r = spawnSync(process.execPath, ['scripts/gate/content-sampling.mjs', ...a], { cwd: dir, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  let r = node('--quarter', '2026Q3', '--seed', 'fixed', '--count', '3');
  check('入口: 5件を下回る件数を拒む', r.status === 1 && r.out.includes('減らさない'), r.out);
  r = node('--quarter', '2026Q3', '--seed', 'fixed');
  const rec = fs.existsSync(path.join(dir, 'docs/content-sampling/2026Q3.md')) ? fs.readFileSync(path.join(dir, 'docs/content-sampling/2026Q3.md'), 'utf8') : '';
  const listed = rec.split('\n').filter((l) => /^\| [1-9] \| docs\/gates\/g\d\.md \|/.test(l));
  check('入口: 種・母集団の件数・抽出した5件を記録の様式に書き、確かめた者と所見を空けて人へ渡す', r.status === 0 && rec.includes('| 種 | fixed |') && rec.includes('| 母集団の件数 | 7 |') && listed.length === 5 && listed.every((l) => /\| \| \|$/.test(l)) && !rec.includes('<四半期>'), `${r.out}\n${rec}`);
  r = node('--quarter', '2026Q3', '--seed', 'other');
  check('入口: 同じ四半期の記録があれば、上書きせずに止まる(抽出をやり直さない)', r.status === 1 && r.out.includes('上書きしません'), r.out);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(`test-content-sampling: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
