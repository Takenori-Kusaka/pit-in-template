// 初期化の開発の基盤(scaffoldStack)の「作るもの」の出し方の試験(process-compass #361 D-7・D-9)。
//
//   node scripts/gate/test-scaffold-todo.mjs
//
// 固定する決定:
//   - go: 既にある go.mod は「作るもの」に挙げない。無ければ挙げる。検査の道具(govulncheck・go-licenses)の置き場を示す。
//     go.mod の go 行とアダプタの runtimeVersion が違えば告げる(版の比較は値の一致だけ。どちらを直すかは決めない)
//   - node: 既にある package.json に scripts.coverage が無ければ、変更せずに「作るもの」へ挙げる。あれば挙げない
// GitHub へ問い合わせません。リポジトリの状態を変えません。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldStack } from '../init/generate-profile.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-scaffold-todo-'));
const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const goAdapter = JSON.stringify({ runtimeVersion: '1.23' });

{
  // go.mod が無い(違反側。作るものに挙がる)
  const d = tmp();
  const r = scaffoldStack('go', d);
  check('go: go.mod が無ければ「作るもの」に go.mod を挙げる', r.todo.some((t) => /^go\.mod:/.test(t)), r.todo.join('\n'));
  check('go: 検査の道具の置き場(.github/actions/setup-stack/action.yml)と例を示す', r.todo.some((t) => /govulncheck/.test(t) && /\.github\/actions\/setup-stack\/action\.yml/.test(t) && /go install/.test(t)), r.todo.join('\n'));
  fs.rmSync(d, { recursive: true, force: true });
}
{
  // go.mod が既にある(適合側。作るものに挙げない)
  const d = tmp();
  put(d, 'go.mod', 'module example.com/app\n\ngo 1.23\n');
  put(d, 'adapters/go.json', goAdapter);
  const r = scaffoldStack('go', d);
  check('go: 既にある go.mod は「作るもの」に挙げない', !r.todo.some((t) => /^go\.mod:/.test(t)), r.todo.join('\n'));
  check('go: go 行とアダプタの runtimeVersion が同じなら、食い違いを告げない', !r.next.some((t) => /runtimeVersion/.test(t)), r.next.join('\n'));
  fs.rmSync(d, { recursive: true, force: true });
}
{
  const d = tmp();
  put(d, 'go.mod', 'module example.com/app\n\ngo 1.22\n');
  put(d, 'adapters/go.json', goAdapter);
  const r = scaffoldStack('go', d);
  check('go: go 行(1.22)とアダプタの runtimeVersion(1.23)が違えば、告げる', r.next.some((t) => /1\.22/.test(t) && /1\.23/.test(t) && /runtimeVersion/.test(t)), r.next.join('\n'));
  fs.rmSync(d, { recursive: true, force: true });
}
{
  // node: 既存の package.json に coverage が無い(違反側)
  const d = tmp();
  put(d, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'jest' } }));
  const before = fs.readFileSync(path.join(d, 'package.json'), 'utf8');
  const r = scaffoldStack('node', d);
  check('node: 既存の package.json に scripts.coverage が無ければ、「作るもの」へ挙げる', r.todo.some((t) => /scripts\.coverage/.test(t)), r.todo.join('\n'));
  check('node: 既にある package.json は変更しない', fs.readFileSync(path.join(d, 'package.json'), 'utf8') === before && r.kept.includes('package.json'));
  fs.rmSync(d, { recursive: true, force: true });
}
{
  // node: coverage がある(適合側)・package.json が無い(初期化が作る)
  const d = tmp();
  put(d, 'package.json', JSON.stringify({ name: 'x', scripts: { coverage: 'jest --coverage' } }));
  const r = scaffoldStack('node', d);
  check('node: 既存の package.json に scripts.coverage があれば、挙げない', !r.todo.some((t) => /scripts\.coverage/.test(t)), r.todo.join('\n'));
  fs.rmSync(d, { recursive: true, force: true });
  const e = tmp();
  const r2 = scaffoldStack('node', e);
  check('node: package.json が無ければ初期化が作り、coverage の todo は出ない', r2.created.includes('package.json') && !r2.todo.some((t) => /scripts\.coverage/.test(t)));
  fs.rmSync(e, { recursive: true, force: true });
}

console.log(`\nscaffold の todo の試験: ${checks - failures}/${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
