// 自己修正ループの停止条件の試験(標準 第3章 3.12.10。process-compass #296)。
//
//   node scripts/gate/test-self-heal.mjs
//
// self-heal.mjs の判定(純関数)と、テンプレートを写した一時の置き場での iterate・release の実行を確かめます。
// 固定する決定:
//   - iterate はスクリプト自身がテストを実行し、失敗したテストの識別を記録する(担い手の申告を使わない)
//   - 同じ失敗したテストの集合が続けば保留にする(無進捗)。失敗の内容が毎回変わっても、失敗の反復の上限で保留にする(連続失敗)。
//     回数の上限は外さない(費用の歯止め)
//   - 識別できない失敗は無進捗に数えない(同一と確かめられない)。連続失敗の上限は効く
//   - テストが通れば、iterate がロックを終える
//   - 記録は追跡する置き場(docs/self-heal-log.tsv)に残る
//   - 保留を解く名義は名簿の人に限る。AI の名義と名簿に無い名義を拒否する

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { failingTestIds, nextIteration, releaseProblem, LOG_REL } from './self-heal.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
};

// ---------------------------------------------------------------- 失敗したテストの識別
const tap = ['TAP version 13', '# Subtest: adds', 'ok 1 - adds', '# Subtest: rejects empty', 'not ok 2 - rejects empty', '  ---', '# Subtest: limit', 'not ok 3 - limit # time=1.2ms'].join('\n');
check('識別: node --test の TAP から not ok の名前を読む(並べて重複を除く)', JSON.stringify(failingTestIds(tap)) === JSON.stringify(['limit', 'rejects empty']), JSON.stringify(failingTestIds(tap)));
check('識別: pytest の FAILED を読む', JSON.stringify(failingTestIds('FAILED tests/test_a.py::test_x - AssertionError\nFAILED tests/test_a.py::test_y')) === JSON.stringify(['tests/test_a.py::test_x', 'tests/test_a.py::test_y']));
check('識別: go の --- FAIL を読む', JSON.stringify(failingTestIds('--- FAIL: TestAdd (0.00s)\nok pkg')) === JSON.stringify(['TestAdd']));
check('識別: jest の ● を読む', JSON.stringify(failingTestIds('  ● Suite › works\n')) === JSON.stringify(['Suite › works']));
check('識別: 読めない出力は空', failingTestIds('Error: something broke').length === 0);

// ---------------------------------------------------------------- 判定(純関数)
const L = { max: 3, noProgress: 2 };
const start = { state: 'active', spec: 'F-001', task: 'Task-1', iterations: 0, history: [] };
let s1 = nextIteration(start, ['a'], L);
check('判定: 1 回目の失敗は保留にしない', s1.state === 'active' && s1.iterations === 1, JSON.stringify(s1));
let s2 = nextIteration(s1, ['a'], L);
check('判定: 同じ失敗の集合が 2 回続けば保留(無進捗)', s2.state === 'held' && s2.condition === 'no-progress' && /無進捗/.test(s2.reason), JSON.stringify(s2));
s2 = nextIteration(s1, ['b'], L);
const s3 = nextIteration(s2, ['a'], L);
check('判定: 失敗の内容が毎回変わる振動でも、失敗の反復の上限(3 回)で保留(連続失敗。上限を外さない)', s2.state === 'active' && s3.state === 'held' && s3.condition === 'consecutive-failures', JSON.stringify([s2.state, s3.condition]));
const u1 = nextIteration(start, null, L);
const u2 = nextIteration(u1, null, L);
check('判定: 識別できない失敗は無進捗に数えない', u2.state === 'active' && u2.history.at(-1).streak === 0, JSON.stringify(u2));
check('判定: 識別できない失敗も、連続失敗の上限は効く', nextIteration(u2, null, L).state === 'held');
check('判定: 部分集合は同一に数えない(a,b → a)', nextIteration(nextIteration(start, ['a', 'b'], L), ['a'], L).state === 'active');

// ---------------------------------------------------------------- 解除の名義
const roster = { people: [{ id: 'p1', name: '山田 太郎', accounts: ['yamada'] }, { id: 'p2', name: 'Devin Smith', nameConfirmed: true }] };
check('解除: 名簿の人は受け付ける', releaseProblem(roster, '山田 太郎') === null);
check('解除: アカウント名でも名簿の人へ対応づけば受け付ける', releaseProblem(roster, '@yamada') === null);
check('解除: AI の名義を拒否する', /AI の名義/.test(releaseProblem(roster, 'Claude') ?? ''), releaseProblem(roster, 'Claude'));
check('解除: 名簿に無い名義を拒否する', /対応づきません/.test(releaseProblem(roster, '鈴木 一郎') ?? ''));
check('解除: 人が確認した氏名(nameConfirmed)は受け付ける', releaseProblem(roster, 'Devin Smith') === null, releaseProblem(roster, 'Devin Smith'));
check('解除: 名簿が空なら確かめられないとして拒否する', /名簿/.test(releaseProblem({ people: [] }, '山田 太郎') ?? ''));

// ---------------------------------------------------------------- 一時の置き場での実行
const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft', 'docs']);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-selfheal-'));
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (SKIP.has(e.name)) continue;
  fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
}
fs.rmSync(path.join(dir, '.claude/.self-heal'), { force: true });
// 構成: 名簿と、テストのコマンド(TESTS のファイルが指す結果で失敗・通過する)
const config = JSON.parse(fs.readFileSync(path.join(dir, 'process.config.json'), 'utf8'));
config.adapters = { stack: 'none' };
config.people = roster.people;
config.task = { ...config.task, selfHealMaxIterations: 3, selfHealNoProgressLimit: 2 };
fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(config, null, 2));
const adapter = JSON.parse(fs.readFileSync(path.join(dir, 'adapters/none.json'), 'utf8'));
adapter.commands = { ...adapter.commands, test: 'node fake-test.mjs' };
fs.writeFileSync(path.join(dir, 'adapters/none.json'), JSON.stringify(adapter, null, 2));
fs.writeFileSync(
  path.join(dir, 'fake-test.mjs'),
  "import fs from 'node:fs';\nconst f = fs.readFileSync('TESTS', 'utf8').trim();\nif (!f) process.exit(0);\nfor (const [i, t] of f.split(',').entries()) console.log(`not ok ${i + 1} - ${t}`);\nprocess.exit(1);\n"
);
const run = (...a) => spawnSync(process.execPath, ['scripts/gate/self-heal.mjs', ...a], { cwd: dir, encoding: 'utf8' });
const setTests = (t) => fs.writeFileSync(path.join(dir, 'TESTS'), t);
const lock = () => JSON.parse(fs.readFileSync(path.join(dir, '.claude/.self-heal'), 'utf8'));
execFileSync('git', ['init', '-q'], { cwd: dir });

let r = run('start', '--spec', 'F-001', '--task', 'Task-1');
check('実行: start でロックを始める', r.status === 0, r.stderr);
setTests('limit,rejects empty');
r = run('iterate');
check('実行: iterate がテストを実行し、失敗したテストを記録する', r.status === 0 && JSON.stringify(lock().history[0].failures) === JSON.stringify(['limit', 'rejects empty']), `${r.stdout}${r.stderr}`);
r = run('iterate');
check('実行: 同じ失敗が続けば保留(終了コード 3)', r.status === 3 && lock().state === 'held' && lock().condition === 'no-progress', `${r.status} ${r.stderr}`);
r = run('release', '--by', 'Claude');
check('実行: AI の名義では保留を解かない', r.status === 2 && fs.existsSync(path.join(dir, '.claude/.self-heal')), r.stderr);
r = run('release', '--by', '見知らぬ人');
check('実行: 名簿に無い名義では保留を解かない', r.status === 2, r.stderr);
r = run('release', '--by', '山田 太郎');
check('実行: 名簿の人が保留を解く', r.status === 0 && !fs.existsSync(path.join(dir, '.claude/.self-heal')), r.stderr);
run('start', '--spec', 'F-001', '--task', 'Task-2');
setTests('a');
run('iterate');
setTests('b');
run('iterate');
setTests('c');
r = run('iterate');
check('実行: 失敗が毎回変わっても、3 回で保留(連続失敗)', r.status === 3 && lock().condition === 'consecutive-failures', `${r.status} ${r.stderr}`);
run('release', '--by', '山田 太郎');
run('start', '--spec', 'F-001', '--task', 'Task-3');
setTests('');
r = run('iterate');
check('実行: テストが通れば iterate がロックを終える', r.status === 0 && !fs.existsSync(path.join(dir, '.claude/.self-heal')), `${r.stdout}${r.stderr}`);
const logText = fs.existsSync(path.join(dir, LOG_REL)) ? fs.readFileSync(path.join(dir, LOG_REL), 'utf8') : '';
check('記録: 追跡する置き場(docs/self-heal-log.tsv)に、反復・保留・解除の拒否・解除が残る', /\thold\t/.test(logText) && /\trelease-refused\t/.test(logText) && /\trelease\t/.test(logText) && /limit \| rejects empty/.test(logText), logText.slice(0, 600));
const ignored = spawnSync('git', ['check-ignore', '-q', LOG_REL], { cwd: dir });
check('記録: 記録の置き場は .gitignore で外れない', ignored.status === 1, String(ignored.status));

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`自己修正ループの試験: ${failures} / ${n} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`自己修正ループの試験: ${n} 件が期待と一致しました`);
