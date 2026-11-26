// 初期化の開発の基盤(scaffoldStack)の「作るもの」の出し方の試験(process-compass #361 D-7)。
//
//   node scripts/gate/test-scaffold-todo.mjs
//
// 固定する決定:
//   - go: 既にある go.mod は「作るもの」に挙げない。無ければ挙げる。検査の道具(govulncheck・go-licenses)の置き場を示す
//   - 採らない(process-compass #361 R-6): go.mod の go 行とアダプタの runtimeVersion の版の比較、既存の package.json の中身(coverage)の検査。
//     初期化は存在の検査だけを行い、既存のファイルの中身を読まない
//   - node: 既にある package.json は変更しない
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

{
  // go.mod が無い(違反側。作るものに挙がる)
  const d = tmp();
  const r = scaffoldStack('go', d);
  check('go: go.mod が無ければ「作るもの」に go.mod を挙げる', r.todo.some((t) => /^go\.mod:/.test(t)), r.todo.join('\n'));
  check('go: 検査の道具の置き場(.github/actions/setup-stack/action.yml)と例を示す', r.todo.some((t) => /govulncheck/.test(t) && /\.github\/actions\/setup-stack\/action\.yml/.test(t) && /go install/.test(t)), r.todo.join('\n'));
  fs.rmSync(d, { recursive: true, force: true });
}
{
  // go.mod が既にある(適合側。作るものに挙げない。go 行の版と runtimeVersion が違っても比較しない)
  const d = tmp();
  put(d, 'go.mod', 'module example.com/app\n\ngo 1.22\n');
  put(d, 'adapters/go.json', JSON.stringify({ runtimeVersion: '1.23' }));
  const r = scaffoldStack('go', d);
  check('go: 既にある go.mod は「作るもの」に挙げない', !r.todo.some((t) => /^go\.mod:/.test(t)), r.todo.join('\n'));
  check('go: 版の比較をしない(go 行と runtimeVersion が違っても告げない)', !r.next.some((t) => /runtimeVersion/.test(t)), r.next.join('\n'));
  fs.rmSync(d, { recursive: true, force: true });
}
{
  // node: 既にある package.json は変更せず、中身(scripts.coverage)を読んだ todo を出さない
  const d = tmp();
  put(d, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'jest' } }));
  const before = fs.readFileSync(path.join(d, 'package.json'), 'utf8');
  const r = scaffoldStack('node', d);
  check('node: 既にある package.json は変更しない', fs.readFileSync(path.join(d, 'package.json'), 'utf8') === before && r.kept.includes('package.json'));
  check('node: 既にある package.json の中身(scripts.coverage)を読んだ todo を出さない', !r.todo.some((t) => /scripts\.coverage/.test(t)), r.todo.join('\n'));
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\nscaffold の todo の試験: ${checks - failures}/${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
