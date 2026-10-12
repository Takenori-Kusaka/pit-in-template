// CLAUDE.md の構成依存部分が process.config.json と一致するかと、常駐の規則の節があるかを検査する。
//
//   node scripts/gate/check-process-rules.mjs
//   node scripts/gate/check-process-rules.mjs --write-resident   常駐の規則の節の一覧を、いまの CLAUDE.md から作り直す
//                                                               (テンプレートの CLAUDE.md の節を変えたときだけ使う)
//
// エージェントが起動時に読む文書は CLAUDE.md です。この文書が構成から乖離すると、
// 標準の規定も案件の構成も実行主体へ届きません(ADR-0035)。
// マーカー区間は導出物であり、手で編集した状態を検出して失敗させます。
//
// 区間の外には、標準の規定を常駐させています(規則の索引)。既存のリポジトリへ持ち込むとき、既存の CLAUDE.md を残して
// 区間の目印だけを足すと、常駐の規則が無いまま区間の検査が通ります。この経路を塞ぐため、常駐の規則の節の一覧
// (claude-md-resident.json)にある節が CLAUDE.md にあることを確かめます(process-compass #306)。
// 確かめるのは、節の見出しと、その下に本文があることまでです。節の中の個々の行の有無は確かめません。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, fail, notice } from './config.mjs';
import { renderProcessRules, RULES_BEGIN, RULES_END } from '../init/generate-profile.mjs';
import { RESIDENT_FILE, buildManifest, loadManifest, missingResident } from './claude-md-resident.mjs';

const config = loadConfig();
const FILE = path.join(ROOT, 'CLAUDE.md');

if (!fs.existsSync(FILE)) {
  fail('CLAUDE.md がありません');
  process.exit(1);
}

const text = fs.readFileSync(FILE, 'utf8');

if (process.argv.includes('--write-resident')) {
  const manifest = buildManifest(text);
  fs.writeFileSync(RESIDENT_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`常駐の規則の節の一覧を書きました: ${path.relative(ROOT, RESIDENT_FILE)}(${manifest.sections.length} 節)`);
  process.exit(0);
}

const b = text.indexOf(RULES_BEGIN);
const e = text.indexOf(RULES_END);

if (b < 0 || e < 0 || e < b) {
  fail(
    `CLAUDE.md に ${RULES_BEGIN} / ${RULES_END} の区間がありません。テンプレートの CLAUDE.md から、区間の目印と常駐の規則の節を戻し、` +
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

// 常駐の規則の節(区間の外)
const manifest = loadManifest();
if (!manifest) {
  fail(
    `常駐の規則の節の一覧(${path.relative(ROOT, RESIDENT_FILE)})がありません。テンプレートから戻してください。` +
      '一覧が無いと、CLAUDE.md に常駐の規則があるかを確かめられません'
  );
  process.exit(1);
}
const { absent, empty } = missingResident(text, manifest);
if (absent.length > 0 || empty.length > 0) {
  fail(
    `CLAUDE.md に、常駐の規則の節が ${absent.length + empty.length} 件ありません` +
      `(見出しが無い ${absent.length} 件、見出しだけで本文が無い ${empty.length} 件。一覧は ${manifest.sections.length} 節)`
  );
  console.log('');
  for (const s of absent) console.log(`  見出しが無い: ${'#'.repeat(s.level)} ${s.heading}`);
  for (const s of empty) console.log(`  本文が無い: ${'#'.repeat(s.level)} ${s.heading}`);
  console.log('');
  console.log('CLAUDE.md は規則の索引です。構成依存部分(目印の区間)の外に、標準の規定を常駐させています。');
  console.log('区間の目印だけを足した CLAUDE.md では、規則が実行主体へ届きません。');
  console.log('テンプレートの CLAUDE.md の上の節を、案件の CLAUDE.md へ含めてください。既存の内容は残して構いません。');
  console.log('既存のリポジトリへ持ち込む場合の定め: README.md の「既存のリポジトリへ持ち込む」');
  process.exit(1);
}

if (config.configured === false) {
  notice('プロセス構成が未設定であり、CLAUDE.md の構成依存部分も初期状態に保たれています');
} else {
  notice('CLAUDE.md の構成依存部分は構成と一致しています');
}
notice(`CLAUDE.md に、常駐の規則の節が揃っています(${manifest.sections.length} 節。節の中の個々の行は確かめていません)`);
process.exit(0);
