// CLAUDE.md の構成依存部分が process.config.json と一致するかと、常駐の規則の節があるかを検査する。
//
//   node scripts/gate/check-process-rules.mjs
//   node scripts/gate/check-process-rules.mjs --write-resident   常駐の規則の一覧へ、いまの CLAUDE.md の節と規則を追加する
//                                                               (追加だけ。テンプレートの CLAUDE.md の規則を足したときだけ使う)
//
// エージェントが起動時に読む文書は CLAUDE.md です。この文書が構成から乖離すると、
// 標準の規定も案件の構成も実行主体へ届きません(ADR-0035)。
// マーカー区間は導出物であり、手で編集した状態を検出して失敗させます。
//
// 区間の外には、標準の規定を常駐させています(規則の索引)。既存のリポジトリへ持ち込むとき、既存の CLAUDE.md を残して
// 区間の目印だけを足すと、常駐の規則が無いまま区間の検査が通ります。この経路を塞ぐため、常駐の規則の節の一覧
// (claude-md-resident.json)にある節と規則が CLAUDE.md にあることを確かめます(process-compass #306)。
// 規則は、規則ごとの核の文言を、同じ節の行と正規化して照合します(process-compass #314 / ADR-0084 決定2)。
// 案件が行の前後へ書き足すこと・並べ替えることは妨げません。一覧から規則を除くのは強制層の縮小です(state:needs-platform)。
// 除いた規則(omit)の各項目に、理由(reason)と承認した者(approvedBy。AI の名義でない)が無ければ落とします(#314 の突合 X-12)。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, fail, notice, aiNameBlocked } from './config.mjs';
import { renderProcessRules, RULES_BEGIN, RULES_END } from '../init/generate-profile.mjs';
import { RESIDENT_FILE, buildManifest, loadManifest, missingResident, omitProblems } from './claude-md-resident.mjs';

const config = loadConfig();
const FILE = path.join(ROOT, 'CLAUDE.md');

if (!fs.existsSync(FILE)) {
  fail('CLAUDE.md がありません');
  process.exit(1);
}

const text = fs.readFileSync(FILE, 'utf8');

if (process.argv.includes('--write-resident')) {
  const previous = loadManifest();
  const manifest = buildManifest(text, previous);
  fs.writeFileSync(RESIDENT_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  const added = manifest.rules.length - (previous?.rules?.length ?? 0);
  console.log(
    `常駐の規則の一覧へ追加しました: ${path.relative(ROOT, RESIDENT_FILE)}(${manifest.sections.length} 節、規則 ${manifest.rules.length} 件。うち追加 ${added} 件)。` +
      '追加だけです。一覧から規則を除くのは強制層の縮小であり、state:needs-platform を経て omit へ理由つきで移します'
  );
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
const omitIssues = omitProblems(manifest, (name) => aiNameBlocked(config, name));
if (omitIssues.length > 0) {
  fail(`常駐の規則の一覧の omit に、不備が ${omitIssues.length} 件あります`);
  for (const p of omitIssues) console.log(`  ${p}`);
  console.log('');
  console.log('一覧から規則を除くのは強制層の縮小です。state:needs-platform を経て、AI維持管理者(人)が承認し、');
  console.log('omit の項目へ reason(除く理由)と approvedBy(承認した者の氏名)を書きます。AI の名義の承認は受け付けません。');
  process.exit(1);
}
const { absent, empty, rules } = missingResident(text, manifest);
const ruleCount = manifest.rules?.length ?? 0;
if (absent.length > 0 || empty.length > 0 || rules.length > 0) {
  fail(
    `CLAUDE.md に、常駐の規則の節が ${absent.length + empty.length} 件、規則が ${rules.length} 件ありません` +
      `(見出しが無い ${absent.length} 件、見出しだけで本文が無い ${empty.length} 件。一覧は ${manifest.sections.length} 節、規則 ${ruleCount} 件)`
  );
  console.log('');
  for (const s of absent) console.log(`  見出しが無い: ${'#'.repeat(s.level)} ${s.heading}`);
  for (const s of empty) console.log(`  本文が無い: ${'#'.repeat(s.level)} ${s.heading}`);
  for (const r of rules) console.log(`  規則が無い: ${r.id}(節「${r.section}」): ${r.core}`);
  if (rules.length > 0) {
    console.log('');
    console.log('規則の照合は、核の文言(上の文)が同じ節のいずれかの行に含まれるかを見ます。前後への書き足しと並べ替えは妨げません。');
    console.log('核の文言を変える(否定を除く等)ことは標準の規定の書き換えです。規則を外すなら state:needs-platform を経て、一覧の omit へ理由つきで移します。');
  }
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
notice(`CLAUDE.md に、常駐の規則が揃っています(${manifest.sections.length} 節、規則 ${ruleCount} 件。核の文言を正規化して照合)`);
process.exit(0);
