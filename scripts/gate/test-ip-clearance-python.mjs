// python の依存ライセンス検査(ip-clearance-python.mjs)の判定を試験する(process-compass #361 N-5)。
//
//   node scripts/gate/test-ip-clearance-python.mjs
//
// 確かめること:
//   - pip-licenses が返す自由文の名前(許可済みの MPL-2.0・PSF の別名)は、語に分割されず許可される(適合)
//   - 許可に無い自由文・許可に無い語を含む式・演算子で許可に無い語と結ばれた式は、従来どおり違反になる(違反)
// 入力は標準入力の JSON(pip-licenses の --format=json)。許可は環境変数 PIT_IN_ALLOWED_LICENSES で渡す。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ip-clearance-python.mjs');
const ALLOWED = 'mit;apache-2.0;bsd-3-clause;python-2.0;mpl-2.0';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
}

function run(license) {
  const input = JSON.stringify([{ Name: 'dep-under-test', Version: '1.0', License: license }]);
  const r = spawnSync(process.execPath, [SCRIPT], {
    input,
    encoding: 'utf8',
    env: { ...process.env, PIT_IN_ALLOWED_LICENSES: ALLOWED, PIT_IN_PROJECT_DIR: '' },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// 適合: 許可済みのライセンスの自由文の名前
for (const lic of ['Mozilla Public License 2.0 (MPL 2.0)', 'Python Software Foundation License', 'MPL-2.0', 'MIT License', 'Apache Software License', 'Apache-2.0 OR BSD-3-Clause']) {
  const r = run(lic);
  check(`許可済みの「${lic}」は違反にしない`, r.status === 0, r.out);
}
// 違反: 許可に無い名前・式
for (const lic of ['GNU General Public License v3 (GPLv3)', 'GPL-3.0', 'MIT AND GPL-3.0', 'Proprietary License', '',
  'GPLv3 and MIT License', 'GPL-3.0 and Apache Software License', 'Proprietary (based on Apache License)', 'CC-BY-NC-4.0 with PSF parts']) {
  const r = run(lic);
  check(`許可に無い「${lic}」は違反にする`, r.status === 1 && /ライセンス違反/.test(r.out), r.out);
}

console.log('');
if (failures) {
  console.log(`python のライセンス検査の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`python のライセンス検査の試験: ${checks} 件が期待と一致しました`);
