// PR を経ないコミットに、区分の下限の規則と判断記録の要否の規則を当てることを、出荷判定の証跡の集約(aggregate-evidence.mjs)の
// 通しで試験する(標準 第3章 3.8.1 の要求事項2・6、第2章 2.6 の要求事項2・6。process-compass #423 / ADR-0101。IMPL-0389・IMPL-0391)。
//
//   node scripts/gate/test-direct-commit-rules.mjs
//
// テンプレートの全ファイルを一時のディレクトリへ写し、区分の下限の規則(src/auth/** → R1)と判断記録の要否の規則(src/api/**)を
// 置いた構成で、PR を経ないコミットを積んで集約を実行します。次を確かめます。
//   - 下限より低い区分のトレーラ Risk を持つコミットを、記載の欠落にする。下限以上なら出さない
//   - 規則に当たりトレーラ ADR が無い(または指す判断記録がそのコミットに無い)コミットを、記載の欠落にする。実在する判断記録を指せば出さない
//   - 規則と製品のコードを同じコミットで変えたら、記載の欠落にする
//   - 事業ステージ S0 では、判断記録の要否の当たりを欠落にせず、品質レポートの注意に出す
// 欠落の件数そのもの(ほかの記録の欠落)は確かめません。GitHub へ問い合わせません。リポジトリの状態を変えません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';
import { copyTemplateTree } from './template-copy.mjs';

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
}
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

const ANSWERS = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes',
};
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
const RULES = {
  riskFloor: { rules: [{ id: 'auth', paths: ['src/auth/**'], floor: 'R1', why: '認証・認可' }] },
  decisionRules: { rules: [{ id: 'public-api', paths: ['src/api/**'], why: '公開インタフェース' }] },
};

function workspace(phase, extra = {}, answers = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-direct-rules-'));
  copyTemplateTree(dir, { skip: SKIP });
  const config = quiet(() => buildConfig({ ...ANSWERS, ...answers, 'q-biz-phase': phase }, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('process.config.json', JSON.stringify({ ...config, ...RULES, ...extra }, null, 2) + '\n');
  write('src/auth/login.js', 'export const a = 1;\n');
  write('src/api/handler.js', 'export const h = 1;\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: fixture');
  const commit = (subject, trailers, files) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git('add', '-A');
    git('commit', '-q', '-m', `${subject}\n\n${trailers}\nVerification: 手元で試験を実行し、通過を確かめた`);
    return git('rev-parse', 'HEAD').trim().slice(0, 8);
  };
  const run = () => {
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    const report = fs.existsSync(path.join(dir, 'evidence/quality-report.md')) ? fs.readFileSync(path.join(dir, 'evidence/quality-report.md'), 'utf8') : '';
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, report };
  };
  const done = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { commit, run, done, git, write, read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8') };
}

const linesOf = (out, id) => out.split('\n').filter((l) => l.includes(`コミット ${id}`));
{
  const w = workspace('growth');
  const low = w.commit('fix: auth', 'Risk: R3', { 'src/auth/login.js': 'export const a = 2;\n' });
  const ok1 = w.commit('fix: auth again', 'Risk: R1', { 'src/auth/login.js': 'export const a = 3;\n' });
  const noAdr = w.commit('feat: api', 'Risk: R2', { 'src/api/handler.js': 'export const h = 2;\n' });
  const ghost = w.commit('feat: api ghost', 'Risk: R2\nADR: ADR-0009', { 'src/api/handler.js': 'export const h = 3;\n' });
  const withAdr = w.commit('feat: api adr', 'Risk: R2\nADR: ADR-0001', { 'src/api/handler.js': 'export const h = 4;\n', 'context/decisions/0001-api-shape.md': '# ADR-0001: 公開インタフェースの形\n' });
  const cfg = JSON.parse(w.read('process.config.json'));
  cfg.riskFloor = { rules: [] };
  const both = w.commit('chore: rules and code', 'Risk: R2', { 'process.config.json': JSON.stringify(cfg, null, 2) + '\n', 'src/a.js': 'export const x = 1;\n' });
  const r = w.run();
  check('試験の前提: 集約が最後まで走る', /を出力しました/.test(r.out), r.out);
  // IMPL-0391:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('区分の下限: 規則(src/auth/**、下限 R1)に当たる R3 のコミットを欠落にする', linesOf(r.out, low).some((l) => /区分 R3 は、変更の対象から導いた下限 R1 より低い/.test(l)), linesOf(r.out, low).join('\n') || r.out);
  // IMPL-0391:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('区分の下限: 下限以上(R1)のコミットには出さない', !linesOf(r.out, ok1).some((l) => /下限/.test(l)), linesOf(r.out, ok1).join('\n'));
  // IMPL-0389:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('判断記録の要否: 規則に当たりトレーラ ADR の無いコミットを欠落にする', linesOf(r.out, noAdr).some((l) => /判断記録の要否の規則に当たります.*トレーラ ADR が無い/.test(l)), linesOf(r.out, noAdr).join('\n') || r.out);
  check('判断記録の要否: 指す判断記録がそのコミットに無ければ欠落にする', linesOf(r.out, ghost).some((l) => /ADR-0009\)が、そのコミットの context\/decisions\/ に無い/.test(l)), linesOf(r.out, ghost).join('\n') || r.out);
  // IMPL-0389:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('判断記録の要否: 実在する判断記録を指すコミットには出さない', !linesOf(r.out, withAdr).some((l) => /判断記録の要否/.test(l)), linesOf(r.out, withAdr).join('\n'));
  // 既定ブランチ以外へ取り込んだマージの検出(process-compass #360 H-4 / IMPL-0248)を、集約の本体の出力で確かめる。
  // 記録用ブランチも基底ブランチの複製も無い構成では「未確認」で、0 件と出さない。限界の定型の文も出す。合否に使わない
  {
    const ev = JSON.parse(w.read('evidence/evidence.json'));
    const od = ev.assurance?.records?.offDefaultMerges;
    check('マージの後の検出: 写しの置き場が無ければ evidence.json に「未確認」を出す', od?.status === 'unconfirmed' && /読めない/.test(od?.reason ?? ''), JSON.stringify(od));
    check('マージの後の検出: 保証の開示に3値の行と、PR を経ない push を拾わない定型の文を出す', /\| 既定ブランチ以外へ取り込んだマージ\(写しの base\.ref。検出あり \/ 0 件 \/ 未確認。合否・出荷の失敗に使わない\) \| \*\*未確認\*\*.*PR を経ない push による取り込み/.test(r.report), r.report.split('\n').filter((l) => /既定ブランチ以外/.test(l)).join('\n') || r.report.slice(0, 400));
  }
  check('規則と製品のコードを同じコミットで変えたら欠落にする', linesOf(r.out, both).some((l) => /区分の下限の規則\(process\.config\.json の riskFloor\)と製品のコード/.test(l)), linesOf(r.out, both).join('\n') || r.out);
  w.done();
}
{
  const w = workspace('poc');
  const noAdr = w.commit('feat: api', 'Risk: R2', { 'src/api/handler.js': 'export const h = 2;\n' });
  const r = w.run();
  check('S0: 判断記録の要否の当たりを欠落にしない', !linesOf(r.out, noAdr).some((l) => /判断記録の要否/.test(l)), linesOf(r.out, noAdr).join('\n'));
  // 規則が無い構成では、何も出さない(警告もしない)
  check('記録された選択を読む対象から外す規則: 規則が無い構成では、保証の開示にも警告にも出さない', !/読む対象から外す規則/.test(r.report + r.out) && !JSON.stringify(JSON.parse(w.read('evidence/evidence.json')).assurance?.tailoring ?? []).includes('読む対象から外す規則'), r.out);
  check('S0: 品質レポートに注意として出す', /注意: コミット [0-9a-f]{8}: .*判断記録の要否の規則に当たります.*S0 のため欠落にしない/.test(r.report), r.report.split('\n').filter((l) => /注意/.test(l)).join('\n') || r.out.slice(-800));
  w.done();
}

// 記録された作業上の選択と理由を確定の場で読む対象から外す規則(標準 第5章 5.5.1。規定 B)。規則の当たり・R1 の除外・
// CL1 以上での不適用・件数の開示・合否に数えないこと・規則と製品のコードの同時変更
const CHOICE = { choiceReviewExclusions: { rules: [{ id: 'internal-tools', paths: ['tools/**'], why: '内部ツール' }] } };
const rowOf = (w, id) => {
  const t = (JSON.parse(w.read('evidence/evidence.json')).assurance?.tailoring ?? []).find((x) => /読む対象から外す規則/.test(x.label));
  return t ? { state: t.state, why: (t.why ?? []).find((l) => l.startsWith(`${id}:`)) ?? '' } : null;
};
{
  const w = workspace('growth', CHOICE);
  w.commit('chore: tool', 'Risk: R3', { 'tools/a.js': 'export const a = 1;\n' });
  w.commit('chore: tool r1', 'Risk: R1', { 'tools/b.js': 'export const b = 1;\n' });
  w.commit('fix: auth tool', 'Risk: R1', { 'src/auth/login.js': 'export const a = 9;\n', 'tools/c.js': 'export const c = 1;\n' });
  w.commit('feat: other', 'Risk: R3', { 'src/a.js': 'export const x = 1;\n' });
  const cfg = JSON.parse(w.read('process.config.json'));
  cfg.choiceReviewExclusions.rules[0].paths.push('scripts/**');
  const both = w.commit('chore: rule widened and code', 'Risk: R2', { 'process.config.json': JSON.stringify(cfg, null, 2) + '\n', 'src/b.js': 'export const y = 1;\n' });
  const r = w.run();
  const row = rowOf(w, 'internal-tools');
  // 規則ごとの外した件数と範囲の変更の件数を、保証の開示の項目2(テーラリングの宣言)へ出す
  // IMPL-1082:ok(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: 規則に当たった変更の件数(外した件数)を保証の開示の項目2 に出す', Boolean(row) && /外した 1 件 \/ 出荷の範囲の変更 \d+ 件/.test(row.why), JSON.stringify(row));
  // IMPL-1082:ng(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: R1(記載の区分 R1)の変更には当てず、当てなかった件数を並べる', Boolean(row) && /うち R1 のため当てなかった 2 件/.test(row.why), JSON.stringify(row));
  check('作業上の選択を読む対象から外す規則: 品質レポートの保証の開示にも載る', /記録された作業上の選択と理由を確定の場で読む対象から外す規則/.test(r.report), r.report.split('\n').filter((l) => /読む対象/.test(l)).join('\n'));
  // 件数は開示で、合否にも記載の欠落にも数えない。規則を理由にした欠落の行が出ない(規則と製品のコードの同時変更を除く)
  check('作業上の選択を読む対象から外す規則: 件数を記載の欠落に数えない', !r.out.split('\n').some((l) => /コミット [0-9a-f]{8}: .*読む対象から外す/.test(l) && !/同じコミットで変わっています/.test(l)), r.out.split('\n').slice(-12).join('\n'));
  check('作業上の選択を読む対象から外す規則: 規則と製品のコードを同じコミットで変えたら欠落にする', linesOf(r.out, both).some((l) => /記録された作業上の選択を読む対象から外す規則\(process\.config\.json の choiceReviewExclusions\)と製品のコード/.test(l)), linesOf(r.out, both).join('\n') || r.out);
  w.done();
}
{
  // 区分の下限の規則で R1 に当たる変更には、記載の区分が R3 でも当てない
  const w = workspace('growth', { choiceReviewExclusions: { rules: [{ id: 'all-src', paths: ['src/**'], why: '試験' }] } });
  w.commit('fix: auth low', 'Risk: R3', { 'src/auth/login.js': 'export const a = 5;\n' });
  w.commit('feat: lib', 'Risk: R3', { 'src/lib.js': 'export const l = 1;\n' });
  w.run();
  const row = rowOf(w, 'all-src');
  check('作業上の選択を読む対象から外す規則: 区分の下限の規則で R1 に当たる変更には当てない(外した 1 件、R1 のため 1 件)', Boolean(row) && /外した 1 件 .*うち R1 のため当てなかった 1 件/.test(row.why), JSON.stringify(row));
  w.done();
}
{
  // 安全重要度 CL1 以上の案件では、規則を置いても外さず、当てていない旨を示す
  const w = workspace('growth', CHOICE, { 'q-criticality': 'cl1' });
  w.commit('chore: tool', 'Risk: R3', { 'tools/a.js': 'export const a = 1;\n' });
  const r = w.run();
  const row = rowOf(w, 'internal-tools');
  // IMPL-1082:ng(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: 安全重要度 CL1 以上の案件では外さず、当てていない旨を示す', Boolean(row) && /当てていない/.test(row.state) && /当てていない/.test(row.why) && !/外した [1-9]/.test(row.why), JSON.stringify(row) + r.out.slice(-300));
  w.done();
}
{
  // 規制業の案件でも同じ
  const w = workspace('growth', CHOICE, { 'q-quality': 'quality-regulated' });
  w.commit('chore: tool', 'Risk: R3', { 'tools/a.js': 'export const a = 1;\n' });
  const r = w.run();
  const row = rowOf(w, 'internal-tools');
  check('作業上の選択を読む対象から外す規則: 規制業の案件でも外さず、当てていない旨を示す', Boolean(row) && /当てていない/.test(row.state) && !/外した [1-9]/.test(row.why), JSON.stringify(row) + r.out.slice(-300));
  w.done();
}

// 規則の当たりの算出を、判定ごとに確かめる(判定を壊すと落ちる場面)
{
  // 規則の変更そのものは規則に当てない(規則 ** の下でも外した件数に入らない)。規則を変えるコミットの区分の下限は R2
  const w = workspace('growth', { choiceReviewExclusions: { rules: [{ id: 'all', paths: ['**'], why: '全体' }] } });
  w.commit('chore: tool', 'Risk: R3', { 'tools/a.js': 'export const a = 1;\n' });
  const cfg = JSON.parse(w.read('process.config.json'));
  cfg.choiceReviewExclusions.rules[0].why = '全体(理由を直した)';
  const low = w.commit('chore: rule why', 'Risk: R3', { 'process.config.json': JSON.stringify(cfg, null, 2) + '\n' });
  cfg.choiceReviewExclusions.rules[0].why = '全体(理由を直した 2)';
  const fine = w.commit('chore: rule why again', 'Risk: R2', { 'process.config.json': JSON.stringify(cfg, null, 2) + '\n' });
  const r = w.run();
  const row = rowOf(w, 'all');
  check('作業上の選択を読む対象から外す規則: 規則のファイルだけを変えた変更は、規則に当てない(外した件数に入れない)', Boolean(row) && /外した 1 件 \//.test(row.why), JSON.stringify(row));
  // IMPL-1082:ng(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: PR を経ず規則だけを R3 で変えたコミットを、下限 R2 より低いとして欠落にする', linesOf(r.out, low).some((l) => /区分 R3 は、変更の対象から導いた下限 R2 より低い.*choiceReviewExclusions の変更/.test(l)), linesOf(r.out, low).join('\n') || r.out);
  // IMPL-1082:ok(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: 規則だけを R2 で変えたコミットには、下限の欠落を出さない', !linesOf(r.out, fine).some((l) => /下限/.test(l)), linesOf(r.out, fine).join('\n'));
  w.done();
}
{
  // 規則は変更の親の版(基底)の構成から読む。規則を足すコミットそのものは外さず、次の変更から外す
  const w = workspace('growth');
  const cfg = JSON.parse(w.read('process.config.json'));
  cfg.choiceReviewExclusions = CHOICE.choiceReviewExclusions;
  w.commit('chore: add rule and tool', 'Risk: R2', { 'process.config.json': JSON.stringify(cfg, null, 2) + '\n', 'tools/x.js': 'export const x = 1;\n' });
  w.commit('chore: tool', 'Risk: R3', { 'tools/y.js': 'export const y = 1;\n' });
  w.run();
  const row = rowOf(w, 'internal-tools');
  // IMPL-1082:ng(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: 規則を足すコミットそのものは外さず、基底の構成の規則を次の変更から当てる(HEAD の構成から読まない)', Boolean(row) && /外した 1 件 \//.test(row.why), JSON.stringify(row));
  w.done();
}
{
  // 変更ごとの安全重要度: 変更の親の版が CL1 以上なら、HEAD の構成が CL0 に下がっていても、その変更には当てない
  const w = workspace('growth', CHOICE, { 'q-criticality': 'cl1' });
  const cfg = JSON.parse(w.read('process.config.json'));
  cfg.answers['q-criticality'] = 'cl0';
  w.commit('chore: lower and tool', 'Risk: R2', { 'process.config.json': JSON.stringify(cfg, null, 2) + '\n', 'tools/a.js': 'export const a = 1;\n' });
  w.commit('chore: tool', 'Risk: R3', { 'tools/b.js': 'export const b = 1;\n' });
  w.run();
  const row = rowOf(w, 'internal-tools');
  // IMPL-1082:ng(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: 変更の親の版が安全重要度 CL1 以上なら、HEAD が CL0 でも当てていない旨を出す', Boolean(row) && /当てていない/.test(row.why), JSON.stringify(row));
  w.done();
}
{
  // 組織の外へ渡す開示には、規則の id と件数だけを出し、パスと理由(自由記述)を出さない。内側の開示には出す
  const w = workspace('growth', { choiceReviewExclusions: { rules: [{ id: 'internal-tools', paths: ['tools/**'], why: '機微な理由の文' }] } });
  w.commit('chore: tool', 'Risk: R3', { 'tools/a.js': 'export const a = 1;\n' });
  const r = w.run();
  const external = w.read('evidence/assurance-disclosure.external.md');
  check('作業上の選択を読む対象から外す規則: 内側の開示には規則の理由を出す', /機微な理由の文/.test(r.report), r.report.split('\n').filter((l) => /読む対象/.test(l)).join('\n'));
  // IMPL-1082:ng(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: 組織の外へ渡す開示には、規則の id と件数だけを出し、理由とパスを出さない', /internal-tools: 外した 1 件/.test(external) && !/機微な理由の文/.test(external) && !/tools\/\*\*/.test(external), external.split('\n').filter((l) => /internal-tools|機微/.test(l)).join('\n'));
  w.done();
}
{
  // PR の経路(マージされた PR)でも、当たりと R1 の除外を数える。PR の区分は PR の本文(写し)から読む
  const w = workspace('growth', CHOICE);
  const copyOf = (n, mc, head, risk) =>
    JSON.stringify({ repository: 'o/r', pr: n, title: 'x', body: `## リスク区分\n\n${risk}\n`, head_ref: 'feat', merge_commit_sha: mc, head_sha: head, author: { id: 11, login: 'acc1' }, merged_at: '2026-11-03T00:00:00Z', merged_by: { login: 'acc1' }, base: { ref: 'main' }, default_branch: 'main', copied_at: '2026-11-03T00:01:00Z', copied_by: 'record-copy workflow (GITHUB_TOKEN)', reviews: [], audit_log: 'x' }, null, 2) + '\n';
  for (const [n, risk] of [[1, 'R3'], [2, 'R1']]) {
    const h = w.commit(`chore: tool ${n} (#${n})`, 'Risk: R3', { [`tools/p${n}.js`]: `export const p = ${n};\n` });
    const mc = w.git('rev-parse', 'HEAD').trim();
    w.commit(`docs: copy ${n}`, 'Risk: R3', { [`docs/records/reviews/pr-${n}.json`]: copyOf(n, mc, h, risk) });
  }
  w.run();
  const row = rowOf(w, 'internal-tools');
  // IMPL-1082:ng(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: PR の経路で、R3 の PR は外した 1 件、R1 の PR は当てなかった 1 件に数える', Boolean(row) && /外した 1 件 \/ 出荷の範囲の変更 3 件\(うち R1 のため当てなかった 1 件\)/.test(row.why), JSON.stringify(row));
  w.done();
}

console.log('');
if (failures) {
  console.log(`PR を経ないコミットの規則の通しの試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`PR を経ないコミットの規則の通しの試験: ${checks} 件が期待と一致しました`);
