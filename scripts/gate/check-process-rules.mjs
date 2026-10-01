// CLAUDE.md の構成依存部分が process.config.json と一致するかを検査する。
//
//   node scripts/gate/check-process-rules.mjs
//
// エージェントが起動時に読む文書は CLAUDE.md です。この文書が構成から乖離すると、
// 標準の規定も案件の構成も実行主体へ届きません(ADR-0035)。
// マーカー区間は導出物であり、手で編集した状態を検出して失敗させます。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, fail, notice } from './config.mjs';
import { renderProcessRules, RULES_BEGIN, RULES_END } from '../init/generate-profile.mjs';

const config = loadConfig();
const FILE = path.join(ROOT, 'CLAUDE.md');

if (!fs.existsSync(FILE)) {
  fail('CLAUDE.md がありません');
  process.exit(1);
}

const text = fs.readFileSync(FILE, 'utf8');
const b = text.indexOf(RULES_BEGIN);
const e = text.indexOf(RULES_END);

if (b < 0 || e < 0 || e < b) {
  fail(
    `CLAUDE.md に ${RULES_BEGIN} / ${RULES_END} の区間がありません。テンプレートの CLAUDE.md から区間の目印を戻し、` +
      '構成が未設定なら /process-init、設定済みなら /process-change で再生成してください'
  );
  process.exit(1);
}

const norm = (s) => s.replace(/\r\n/g, '\n').trim();

const actual = norm(text.slice(b + RULES_BEGIN.length, e));
const expected = norm(renderProcessRules(config));

if (actual !== expected) {
  if (config.configured === false) {
    fail('プロセス構成が未設定（configured: false）ですが、CLAUDE.md の依存部分に別案件の設定（Filetto等）が残っています。初期状態に戻してください。');
  } else {
    fail('CLAUDE.md の構成依存部分が process.config.json と一致しません');
    console.log('');
    console.log('この区間は導出物です。手で編集しないでください。');
    console.log('構成を変えたい場合は、`/process-change` で体制の変化点として反映します。`/process-init` の再実行では、失効と発生を特定できません。');
    console.log('構成を変えずに区間だけを戻す場合: node scripts/init/generate-profile.mjs --answers process.config.json');
    console.log('process.config.json を手で編集した場合は、編集を戻してください。構成を書き換えるのは /process-change だけです(契約検査が、変化点を経ない書き換えを検出します)。');
  }
  process.exit(1);
}

if (config.configured === false) {
  notice('プロセス構成が未設定であり、CLAUDE.md の構成依存部分も初期状態に保たれています');
} else {
  notice('CLAUDE.md の構成依存部分は構成と一致しています');
}
process.exit(0);
