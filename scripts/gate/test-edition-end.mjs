// 本標準の版・適用の終了・適用の開始の境・主張の名の試験(標準 第1章 1.10。process-compass #313 / ADR-0083)。
//
//   node scripts/gate/test-edition-end.mjs
//
// 固定する決定:
//   - 初期化は、複製した知識ベースの版(source.edition)を構成の standard.edition に書く。null は作業中の版(未発行)
//   - 欄の無い旧い構成は作業中の版として読み、変化点を経ない再生成で欄を足さない(要約値を保つ)
//   - 版の切り替えは種別 edition だけで行い、複製した知識ベースの版に限る。作業中の版へは切り替えない。記名と理由を要する
//   - 適用の終了は種別 end で、理由の区分と記名を要する。終了の後は notice のほかの変化点を追記しない
//   - 版の切り替えと終了は、適用の開始(configured が true になった最初のコミット)を動かさない
//   - 適用の開始のコミットに初期化の記録(changeLog[0] の init)が無ければ、集約が記録の欠落として出し、契約検査が注記する
//   - 述べられる名: 終了後は無し / 作業中の版・未達・列挙に無い離脱があれば適用の表明(作業中の版はコミットとともに名指す。X-4)/
//     閉じた列挙の逸脱だけなら逸脱を伴う適合の主張
//   - 集約の名は範囲ごとに求める。版の切り替えをまたぐ範囲には名を出さず、終了より前の範囲の名は終了で消さない(X-7)
//   - 適用の開始のコミットが検査の範囲にあれば、初期化の記録の欠けで契約検査を失敗にする(X-13)
//   - 発行の時点でない知識ベース(edition が null、basedOn あり)へは版を切り替えない(X-1)
// GitHub へ問い合わせません。リポジトリの状態を変えません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, claimStatus, statementFactsLine, classifyDeviations, findInitCommit, initRecordProblem, sealChangeLog, standardEdition, configDigest } from './config.mjs';
import { buildConfig, renderProcessRules, renderProfileMd } from '../init/generate-profile.mjs';

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

const COMMON = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free', 'q-biz-phase': 'growth' };
const PEOPLE = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊己'[i]}`, accounts: [`acc${i}`] }));
const seatsOf = (map) => Object.entries(map).map(([role, accountable]) => ({ role, accountable }));
const SEATS3 = seatsOf({ 'value-owner': 'p0', 'tech-lead': 'p5', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' });
const build = (answers, opts = {}) => quiet(() => buildConfig({ ...COMMON, ...answers }, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, ...opts }).config);
const KB = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/vendor/tailoring-kb.json'), 'utf8'));

// ---------------------------------------------------------------- 構成の生成と主張の名
{
  const c = build({ 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' }, { people: PEOPLE, seats: SEATS3 });
  check('初期化は、知識ベースの版を standard.edition に書く', c.standard && c.standard.edition === (KB.source?.edition ?? null), JSON.stringify(c.standard));
  const draft = claimStatus(c);
  check('作業中の版に従う構成は、適用の表明まで(2つの適合の主張は発行した版を要する)', standardEdition(c) === null ? draft.name === '適用の表明' && draft.blockers.some((b) => /作業中の版/.test(b)) : true, JSON.stringify(draft));
  const labeled = claimStatus(c, { kbSource: { edition: null, basedOn: '第1版', commit: 'abcdef1234567890abcdef1234567890abcdef12' } });
  check('作業中の版の表示は、最後に発行した版と標準のコミットを添える', /作業中の版\(第1版の後。標準のコミット abcdef123456\)/.test(labeled.editionLabel), labeled.editionLabel);
  const issued = { ...c, standard: { edition: '第1版' } };
  const s1 = claimStatus(issued);
  // IMPL-0305:ok IMPL-0308:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('発行した版に従い、未達も逸脱も列挙に無い離脱も無い構成は「適合の主張」', s1.name === '適合の主張' && s1.blockers.length === 0, JSON.stringify(s1));
  const ended = { ...issued, changeLog: [...issued.changeLog, { kind: 'end', date: '2026-10-20', end: { reason: 'closed' }, decidedBy: '名簿 甲' }] };
  const s2 = claimStatus(ended);
  check('適用を終えた構成は、現在形の表明・主張の名を持たない', s2.name === null && s2.ended?.reason === 'closed', JSON.stringify(s2));
  const legacy = { ...issued, standard: undefined };
  check('欄の無い旧い構成は、作業中の版として読む', standardEdition(legacy) === null && claimStatus(legacy).editionLabel.startsWith('作業中の版'));
  // IMPL-0305:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('版の書式に当たらない値は、発行した版として読まない', standardEdition({ standard: { edition: 'v1.0' } }) === null && standardEdition({ standard: { edition: '第2版 修正1' } }) === '第2版 修正1');
}
{
  // 1〜2名の体制: 外部の確認者を席に置くと G-6 は未達でなくなり、G-7 は閉じた列挙の逸脱(D-1)だけが残る構成を作れる
  const X = { id: 'x', name: '外部 確認者', external: true, accounts: ['ext'] };
  const A = { id: 'a', name: '名簿 甲', accounts: ['acc0'] };
  const B = { id: 'b', name: '名簿 乙', accounts: ['acc1'] };
  const two = build(
    { 'q-team-size': 'size-1-2', 'q-external-reviewer': 'reviewer-yes' },
    { people: [A, B, X], seats: seatsOf({ 'value-owner': 'a', 'tech-lead': 'a', 'dev-verifier': 'a', 'independent-reviewer': 'x', 'qa-gatekeeper': 'a', 'biz-approver': 'b', 'ai-maintainer': 'a', 'ai-ops': 'b' }) }
  );
  const cls = classifyDeviations(two);
  const st = claimStatus({ ...two, standard: { edition: '第1版' } });
  if (cls.listed.length && !cls.unlisted.length && !two.unmet.length) {
    check('閉じた列挙の逸脱(D-1)だけの構成は「逸脱を伴う適合の主張」', st.name === '逸脱を伴う適合の主張' && st.listed[0].closedListId === 'D-1', JSON.stringify(st));
  } else {
    check('試験の前提: 2名の体制で D-1 だけが残る構成を作れる', false, JSON.stringify({ listed: cls.listed.map((d) => d.label), unlisted: cls.unlisted.map((d) => d.label), unmet: two.unmet.map((u) => u.gate) }));
  }
  const same = build(
    { 'q-team-size': 'size-1-2', 'q-external-reviewer': 'reviewer-yes' },
    { people: [A, B, X], seats: seatsOf({ 'value-owner': 'a', 'tech-lead': 'a', 'dev-verifier': 'a', 'independent-reviewer': 'x', 'qa-gatekeeper': 'b', 'biz-approver': 'b', 'ai-maintainer': 'a', 'ai-ops': 'b' }) }
  );
  const st2 = claimStatus({ ...same, standard: { edition: '第1版' } });
  // IMPL-0308:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('出荷判定者 × 事業決裁者の兼務(列挙に無い離脱)がある構成は「適用の表明」まで', st2.name === '適用の表明' && st2.unlisted.some((d) => /出荷判定者|事業決裁者/.test(d.label)), JSON.stringify({ name: st2.name, unlisted: st2.unlisted.map((d) => d.label), unmet: st2.unmet }));
}
// IMPL-0304:ok(違反と適合の対。標準の実装マーク。process-compass #314)
check('初期化の記録が changeLog[0] にあれば問題なし', initRecordProblem({ changeLog: [{ kind: 'init' }] }) === null);
check('changeLog[0] が init でなければ問題を返す', /init/.test(initRecordProblem({ changeLog: [{ kind: 'settings' }] }) ?? ''));
check('changeLog が無ければ問題を返す', /init/.test(initRecordProblem({}) ?? ''));

// ---------------------------------------------------------------- 一時の置き場で通しに確かめる
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-edition-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  // 雛形の所有者(@OWNER)は採用者が置き換える(残すと契約検査が失敗にする。process-compass #315 R-2)
  const co = path.join(dir, '.github/CODEOWNERS');
  fs.writeFileSync(co, fs.readFileSync(co, 'utf8').replace(/@OWNER\b/g, '@tester'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  const node = (script, ...a) => {
    const r = spawnSync(process.execPath, [script, ...a], { cwd: dir, encoding: 'utf8', env });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const writeJson = (rel, v) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(v, null, 2) + '\n');
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD').trim();
  };
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, git, node, writeJson, readJson, commit, done };
}

// 契約検査の不整合のうち、アダプタ(この試験は none)に由来しないもの
const contractErrors = (out) => out.split('\n').filter((l) => /::error::/.test(l) && !/アダプタ none/.test(l));
const sealed = (c) => sealChangeLog(JSON.parse(JSON.stringify(c)));
const base = build({ 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' }, { people: PEOPLE, seats: SEATS3 });

{
  const w = workspace();
  w.commit('chore: template');
  w.writeJson('process.config.json', sealed(base));
  const initHash = w.commit('chore: init');
  const change = (obj) => {
    fs.writeFileSync(path.join(w.dir, 'change.json'), JSON.stringify(obj));
    return w.node('scripts/init/generate-profile.mjs', '--change', 'change.json');
  };
  const kbEdition = KB.source?.edition ?? null;
  {
    // 発行の時点でない知識ベース(作業中の版。最後に発行した版は第1版)からは、第1版へ切り替えない
    const kb0 = w.readJson('scripts/vendor/tailoring-kb.json');
    const keep = JSON.stringify(kb0);
    kb0.source = { ...kb0.source, edition: null, basedOn: '第1版' };
    w.writeJson('scripts/vendor/tailoring-kb.json', kb0);
    const rAfterIssue = change({ kind: 'edition', edition: '第1版', summary: '第1版へ', decidedBy: '名簿 甲', reason: '発行された' });
    check('発行の後の作業中の版の知識ベースからは、発行した版へ切り替えない', !rAfterIssue.ok && /知識ベース/.test(rAfterIssue.out), rAfterIssue.out);
    fs.writeFileSync(path.join(w.dir, 'scripts/vendor/tailoring-kb.json'), JSON.stringify(JSON.parse(keep), null, 2) + '\n');
  }
  const r0 = change({ kind: 'edition', edition: '第1版', summary: '第1版へ', decidedBy: '名簿 甲', reason: '発行された' });
  if (kbEdition !== '第1版') check('知識ベースの版と異なる版へは切り替えない', !r0.ok && /知識ベース/.test(r0.out), r0.out);
  const rDraft = change({ kind: 'edition', edition: null, summary: '作業中へ', decidedBy: '名簿 甲', reason: 'x' });
  // IMPL-0306:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('作業中の版へは切り替えない', !rDraft.ok && /作業中の版/.test(rDraft.out), rDraft.out);
  // 知識ベースを第1版の複製にして切り替える
  const kb = w.readJson('scripts/vendor/tailoring-kb.json');
  kb.source = { ...kb.source, edition: '第1版' };
  w.writeJson('scripts/vendor/tailoring-kb.json', kb);
  w.commit('chore: kb 第1版');
  const rNoSign = change({ kind: 'edition', edition: '第1版', summary: '第1版へ' });
  check('版の切り替えは、記名と理由が無ければ拒否する', !rNoSign.ok && /decidedBy/.test(rNoSign.out), rNoSign.out);
  const r1 = change({ kind: 'edition', edition: '第1版', summary: '第1版へ切り替えた', decidedBy: '名簿 甲', reason: '第1版が発行された' });
  // IMPL-0306:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('知識ベースの版へは、記名と理由つきで切り替えられる', r1.ok, r1.out);
  const c1 = w.readJson('process.config.json');
  check('切り替えの後、構成は第1版に従い、記録に前後の版が残る', c1.standard?.edition === '第1版' && c1.changeLog.at(-1).kind === 'edition' && c1.changeLog.at(-1).edition?.to === '第1版', JSON.stringify([c1.standard, c1.changeLog.at(-1).edition]));
  const v1 = w.node('scripts/gate/verify-gate-contract.mjs');
  check('切り替えの後、契約検査が版と記録の不整合を出さない', !contractErrors(v1.out).length, contractErrors(v1.out).join('\n'));
  const editionHash = w.commit('chore: edition');
  check('版の切り替えは、適用の開始(configured が true になった最初のコミット)を動かさない', findInitCommit(w.dir)?.hash === initHash);
  const rEndBad = change({ kind: 'end', endReason: 'paused', summary: '止める', decidedBy: '名簿 甲', reason: 'x' });
  // IMPL-0307:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('一時停止などの理由の区分は受け付けない', !rEndBad.ok && /endReason/.test(rEndBad.out), rEndBad.out);
  const rEnd = change({ kind: 'end', endReason: 'closed', summary: '案件を完了した', decidedBy: '名簿 甲', reason: '納品を終えた' });
  // IMPL-0307:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('適用の終了は、理由の区分と記名つきで記録できる', rEnd.ok, rEnd.out);
  const c2 = w.readJson('process.config.json');
  check('終了の後も configured は true のまま', c2.configured === true && c2.changeLog.at(-1).end?.reason === 'closed');
  const prof = fs.readFileSync(path.join(w.dir, 'PROCESS-PROFILE.md'), 'utf8');
  check('プロセス構成書に、従う版と適用の終了が出る', /従う本標準の版: \*\*第1版\*\*/.test(prof) && /適用の終了: /.test(prof), prof.slice(0, 1200));
  const v2 = w.node('scripts/gate/verify-gate-contract.mjs');
  check('終了の後、契約検査が記録の不整合を出さない', !contractErrors(v2.out).length, contractErrors(v2.out).join('\n'));
  const endHash = w.commit('chore: end');
  const rAfter = change({ kind: 'settings', summary: '値を変える', settings: { task: { maxChangedLines: 300 } } });
  check('終了の後は、変化点を追記しない', !rAfter.ok && /適用を終えています/.test(rAfter.out), rAfter.out);
  // 制限の範囲・対象の人・根拠・記録した者を要する(process-compass #357 / ADR-0127 決定5)
  const rNotice = change({
    kind: 'notice',
    summary: '一時制限の発動を記録した',
    event: 'restriction',
    restriction: { id: 'r1', cause: '7.9.1-2', person: '名簿 丁', paths: ['src/payments/**'], basis: '試験の注入の記録', recordedBy: '名簿 丁' },
    notice: { to: '名簿 丁', at: new Date().toLocaleDateString('sv-SE') },
  });
  check('終了の後も、種別 notice は受け付ける', rNotice.ok, rNotice.out);
  fs.rmSync(path.join(w.dir, 'change.json'), { force: true });
  w.git('checkout', '-q', '--', '.');
  w.git('clean', '-qfd');
  // 集約の名は範囲ごとに求める(X-7)
  const claimOf = (...a) => {
    w.node('scripts/gate/aggregate-evidence.mjs', ...a);
    try {
      return w.readJson('evidence/evidence.json').claim;
    } catch {
      return null;
    }
  };
  const straddle = claimOf('--from', initHash, '--to', editionHash);
  check('版の切り替えをまたぐ範囲には、名を出さず、範囲を分けるよう出す', straddle && straddle.name === null && straddle.blockers.some((b) => /版の切り替えをまたぎます/.test(b)), JSON.stringify(straddle));
  const past = claimOf('--from', editionHash, '--to', endHash);
  check('終了を含む範囲の名は、終了で消さず、過去の範囲として述べる旨を出す', past && past.name !== null && past.blockers.some((b) => /過去の範囲/.test(b)) && past.editionsInRange.length === 1, JSON.stringify(past));
  check('終了は、適用の開始を動かさない', findInitCommit(w.dir)?.hash === initHash);
  w.done();
}
{
  // 旧い構成(standard の欄なし)は、変化点を経ない再生成で欄を足さない
  const w = workspace();
  w.commit('chore: template');
  // 回答は作業の場所の外へ置く(作業の場所に置くと、事前点検が既存のファイルとして数える。process-compass #315)
  const answers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-answers-')), 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ ...COMMON, 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' }));
  const init = w.node('scripts/init/generate-profile.mjs', '--answers', answers, '--stack', 'node');
  check('試験の前提: 初期化が通る', init.ok, init.out);
  fs.rmSync(path.dirname(answers), { recursive: true, force: true });
  const legacy = w.readJson('process.config.json');
  delete legacy.standard;
  w.writeJson('process.config.json', sealed(legacy));
  w.commit('chore: init(旧い構成)');
  const r = w.node('scripts/init/generate-profile.mjs', '--answers', 'process.config.json');
  const after = w.readJson('process.config.json');
  check('旧い構成は、変化点を経ない再生成で通り、版の欄を足さない', r.ok && after.standard === undefined && configDigest(after) === after.changeLog.at(-1).stateHash, r.out);
  w.done();
}
{
  // 手で configured を先に入れた履歴: 適用の開始のコミットに初期化の記録が無い
  const w = workspace();
  w.commit('chore: template');
  const hand = JSON.parse(JSON.stringify(base));
  hand.changeLog = [{ ...hand.changeLog[0], kind: 'settings', summary: '手で設定した' }];
  w.writeJson('process.config.json', sealed(hand));
  const handHash = w.commit('chore: 手で configured を入れた');
  const vInit = w.node('scripts/gate/verify-gate-contract.mjs');
  check('適用の開始のコミットが検査の範囲にあれば、初期化の記録の欠けで契約検査が失敗する', contractErrors(vInit.out).some((l) => /構成の初期化の記録/.test(l)), vInit.out);
  w.writeJson('process.config.json', sealed(base));
  w.commit('chore: init');
  check('境は、changeLog に依らず configured が true になった最初のコミット', findInitCommit(w.dir)?.hash === handHash);
  const v = w.node('scripts/gate/verify-gate-contract.mjs');
  check('契約検査が、初期化の記録の無いことを注記する', /構成の初期化の記録/.test(v.out), v.out);
  const a = w.node('scripts/gate/aggregate-evidence.mjs');
  // IMPL-0304:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('集約が、適用の開始のコミットの初期化の記録の欠落を出す', /適用の開始\([0-9a-f]{12}\): .*記録の欠落です/.test(a.out), a.out);
  w.done();
}

{
  // 手で書いた不正な end・edition の記録を、契約検査が不整合にする(X-14)
  const w = workspace();
  w.commit('chore: template');
  w.writeJson('process.config.json', sealed(base));
  w.commit('chore: init');
  const bad = JSON.parse(JSON.stringify(base));
  bad.changeLog.push({ ...bad.changeLog[0], kind: 'end', summary: '手で終えた', end: {}, decidedBy: undefined });
  w.writeJson('process.config.json', sealed(bad));
  const vEnd = w.node('scripts/gate/verify-gate-contract.mjs');
  check('理由の区分と記名の無い end の記録を、契約検査が不整合にする', contractErrors(vEnd.out).some((l) => /end/.test(l)), vEnd.out);
  const bad2 = JSON.parse(JSON.stringify(base));
  bad2.changeLog.push({ ...bad2.changeLog[0], kind: 'edition', summary: '手で切り替えた', edition: { from: null, to: 'v2' }, decidedBy: '名簿 甲', reason: 'x' });
  w.writeJson('process.config.json', sealed(bad2));
  const vEd = w.node('scripts/gate/verify-gate-contract.mjs');
  check('版の書式に当たらない edition の記録を、契約検査が不整合にする', contractErrors(vEd.out).some((l) => /版の切り替えの記録/.test(l)), vEd.out);
  w.writeJson('process.config.json', sealed(base));
  // D-0 に「従う本標準の版」の欄が無ければ、/pit が注記する(X-15)
  fs.mkdirSync(path.join(w.dir, 'docs'), { recursive: true });
  const d0 = fs.readFileSync(path.join(w.dir, 'templates/00-d0-governance.md'), 'utf8').split('\n').filter((l) => !/^- 従う本標準の版:/.test(l)).join('\n');
  fs.writeFileSync(path.join(w.dir, 'docs/D-0-governance.md'), d0);
  const pit = w.node('scripts/gate/next.mjs');
  // IMPL-0311:ng(違反の入力: 欄の無い D-0。標準の実装マーク。process-compass #314)
  check('D-0 に従う本標準の版の欄が無ければ、/pit が注記する', /従う本標準の版」が無い/.test(pit.out), pit.out.slice(0, 1500));
  const filled = fs
    .readFileSync(path.join(w.dir, 'templates/00-d0-governance.md'), 'utf8')
    .split('\n')
    .map((l) => (/^- 従う本標準の版:/.test(l) ? '- 従う本標準の版: 作業中の版(未発行)' : l))
    .join('\n');
  fs.writeFileSync(path.join(w.dir, 'docs/D-0-governance.md'), filled);
  const pitOk = w.node('scripts/gate/next.mjs');
  // IMPL-0311:ok(適合の入力: 欄を記入した D-0)
  check('D-0 の従う本標準の版の欄を記入すれば、/pit は注記しない', pitOk.ok !== false && !/従う本標準の版」が/.test(pitOk.out), pitOk.out.slice(0, 1500));
  w.done();
}

{
  // 適用の開始の前後(第1章 1.10.1。IMPL-0119)。前の変更は数えず欠落にもせず、後の変更は要求事項のすべての対象にする
  const w = workspace();
  w.commit('chore: template');
  fs.mkdirSync(path.join(w.dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'src/before.js'), 'export const a = 1;\n');
  const beforeHash = w.commit('feat: 適用の開始より前の製品の変更');
  w.writeJson('process.config.json', sealed(base));
  w.commit('chore: init');
  fs.writeFileSync(path.join(w.dir, 'src/after.js'), 'export const b = 1;\n');
  const afterHash = w.commit('feat: 適用の開始の後の製品の変更');
  const a = w.node('scripts/gate/aggregate-evidence.mjs');
  const errs = a.out.split('\n').filter((l) => /::error::/.test(l));
  // IMPL-0119:ng(違反の入力: 適用の開始の後の、記録の無い製品の変更。標準の実装マーク。process-compass #314)
  check('適用の開始の後の、記録の無い製品の変更は欠落として出る', errs.some((l) => l.includes(`コミット ${afterHash.slice(0, 8)}`)), errs.join('\n'));
  // IMPL-0119:ok(適合の入力: 適用の開始より前の製品の変更は、記録が無くても欠落にしない)
  check('適用の開始より前の製品の変更は、記録が無くても欠落にしない', !errs.some((l) => l.includes(beforeHash.slice(0, 7))), errs.join('\n'));
  w.done();
}

// ---------------------------------------------------------------- 判定の結果を受け取る者(process-compass #317 / ADR-0087 決定3)
{
  const w = workspace();
  const out = build({ 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes', 'q-dev-form': 'outsourcer' }, { people: PEOPLE, seats: SEATS3 });
  w.writeJson('process.config.json', sealed(out));
  fs.mkdirSync(path.join(w.dir, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(w.dir, 'templates/08-ai-sla.md'), path.join(w.dir, 'docs/ai-sla.md'));
  w.commit('chore: outsourcer');
  check('委託の構成では、CLAUDE.md の生成部分に受け取る者の所在の1行が入る', /docs\/ai-sla\.md` の「判定の置き先と結果の受け渡し」の節/.test(renderProcessRules(out)));
  {
    const built = quiet(() => buildConfig({ ...COMMON, 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes', 'q-dev-form': 'outsourcer' }, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS3 }));
    check('委託の構成では、構成書(PROCESS-PROFILE)にも受け取る者の所在の1行が入る', /docs\/ai-sla\.md` の「判定の置き先と結果の受け渡し」の節/.test(renderProfileMd(built.config, built.result)));
    check('生成の1行は、組織をまたぐ引き渡しに state ラベルを課さない(ADR-0069 決定2)', !/state:\*/.test(renderProcessRules(out)));
  }
  check('内製の構成では、受け取る者の所在の1行を入れない', !/docs\/ai-sla\.md` の「判定の置き先と結果の受け渡し」の節/.test(renderProcessRules(base)));
  const r0 = w.node('scripts/gate/next.mjs');
  // IMPL-0337:ng(違反の入力: 委託の構成で、受け取る者の欄が雛形の記入例のまま)
  check('委託の構成で受け取る者が空欄なら、/pit が注記を出す(段階は止めない)', r0.ok && /判定の結果を受け取る者\(発注側\)/.test(r0.out) && /渡す先が決まっていない/.test(r0.out), r0.out.slice(-1200));
  const sla = path.join(w.dir, 'docs/ai-sla.md');
  fs.writeFileSync(
    sla,
    fs
      .readFileSync(sla, 'utf8')
      .replace(/^\| 判定の結果を受け取る者\(発注側\) \|[^\n]*$/m, '| 判定の結果を受け取る者(発注側) | 仕様承認者 名簿 甲 |')
      .replace(/^\| 判定の結果を受け取る者\(受注側\) \|[^\n]*$/m, '| 判定の結果を受け取る者(受注側) | 作成を担う本人と同じ |')
  );
  const r1 = w.node('scripts/gate/next.mjs');
  // IMPL-0337:ok(適合の入力: 受け取る者の欄が記入済み)
  check('受け取る者が記入済みなら、注記を出さない', r1.ok && !/渡す先が決まっていない/.test(r1.out), r1.out.slice(-1200));
  fs.rmSync(sla);
  const r2 = w.node('scripts/gate/next.mjs');
  check('委託の構成で docs/ai-sla.md が無ければ、その旨を注記する', r2.ok && /docs\/ai-sla\.md が無い/.test(r2.out), r2.out.slice(-1200));
  const inhouse = build({ 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' }, { people: PEOPLE, seats: SEATS3 });
  w.writeJson('process.config.json', sealed(inhouse));
  const r3 = w.node('scripts/gate/next.mjs');
  check('内製の構成では、受け取る者の注記を出さない', r3.ok && !/渡す先が決まっていない/.test(r3.out), r3.out.slice(-1200));
  w.done();
}

// ---------------------------------------------------------------- 適用の表明に併記する事項の値の行(IMPL-0120。ADR-0165 決定1)
{
  const draftNoCommit = statementFactsLine({ editionLabel: '作業中の版(第1版の後)', edition: null, kbCommit: null, unmet: [], gapCount: 0, listed: [], unlisted: [] });
  // IMPL-0120:ng(違反の入力: 作業中の版でコミットの識別が無い)
  check('値の行(ng): 作業中の版でコミットが無ければ「コミットの識別なし」を添える', /コミットの識別なし/.test(draftNoCommit), draftNoCommit);
  const draftWith = statementFactsLine({ editionLabel: '作業中の版(第1版の後。標準のコミット abcdef123456)', edition: null, kbCommit: 'abcdef1234567890abcdef1234567890abcdef12', unmet: [], gapCount: 0, listed: [], unlisted: [] });
  // IMPL-0120:ok(適合の入力: 作業中の版でコミットあり)。コミットの先頭12字を出すのは editionLabel(claimStatus)で、行は識別なしの注記の有無だけを kbCommit で決める
  check('値の行(ok): 作業中の版でコミットの識別があれば、識別なしの注記を出さない(先頭12字は版の表示が運ぶ)', /abcdef123456/.test(draftWith) && !/コミットの識別なし/.test(draftWith), draftWith);
  const some = statementFactsLine({ editionLabel: '第1版', edition: '第1版', unmet: ['G-5'], gapCount: 2, listed: ['L-1 兼務(第3章)'], unlisted: ['名義の共有'] });
  // IMPL-0120:ok(適合の入力: 未達1件・欠落2件・離脱あり。件数と一覧が値のとおり出る。値の出力の確認であり違反の検出ではない)
  check('値の行: 未達1件・欠落2件・一覧の値が出る', /未達のゲート 1 件/.test(some) && /集約の欠落の一覧\) 2 件/.test(some) && /L-1 兼務/.test(some) && /名義の共有/.test(some), some);
  const none = statementFactsLine({ editionLabel: '第1版', edition: '第1版', unmet: [], gapCount: 0, listed: [], unlisted: [] });
  // IMPL-0120:ok(適合の入力: 0 件・離脱なし。0 件と「無し」を省かない)
  check('値の行(ok): 0 件と「無し」が両方出る', /未達のゲート 0 件/.test(none) && /欠落の一覧\) 0 件/.test(none) && (none.match(/無し/g) || []).length === 2 && /ADR-0165/.test(none), none);
}

// ---------------------------------------------------------------- 記録から数える、列挙に無い離脱(process-compass #354 項目2 / ADR-0147)
{
  const issued = { ...base, standard: { edition: '第1版' } };
  const HANDOVER_HEAD = '# 運用引き継ぎ\n\n## 2. コア機能\n\n| 機能 | 理解保持者 | 確認した者(本人以外) | 確認の記録と確認日 | 判断記録 | 関わる登録した変更種別 |\n| --- | --- | --- | --- | --- | --- |\n';
  const claimWith = (files) => {
    const w = workspace();
    w.commit('chore: template');
    w.writeJson('process.config.json', sealed(issued));
    w.commit('chore: init');
    fs.mkdirSync(path.join(w.dir, 'docs'), { recursive: true });
    for (const f of ['docs/handover.md', 'docs/quality-assurance-policy.md']) fs.rmSync(path.join(w.dir, f), { force: true });
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(w.dir, rel), text);
    w.git('add', '-A');
    w.git('commit', '-q', '--allow-empty', '-m', 'chore: records');
    w.node('scripts/gate/aggregate-evidence.mjs');
    const ev = w.readJson('evidence/evidence.json');
    const claim = ev.claim;
    Object.defineProperty(claim, '__full', { value: { gaps: ev.gaps, report: fs.readFileSync(path.join(w.dir, 'evidence/quality-report.md'), 'utf8'), external: fs.readFileSync(path.join(w.dir, 'evidence/assurance-disclosure.external.md'), 'utf8') }, enumerable: false });
    w.done();
    return claim;
  };
  const ONE = { 'docs/handover.md': `${HANDOVER_HEAD}| 決済 | 名簿 甲 | 名簿 乙 | 演習 2026-10-01 | | なし |\n` };
  const c1 = claimWith(ONE);
  // IMPL-0521:ng(違反の入力: 運用引き継ぎ文書の節2 の保持者が1名以下)
  check('集約(iv): 保持者が1名以下のコア機能は、名が適用の表明・離脱の一覧に出る', c1.name === '適用の表明' && c1.unlistedDepartures.some((l) => /コア機能の理解の保持者が1名以下/.test(l)) && c1.blockers.some((b) => /記録から数えた/.test(b)), JSON.stringify(c1));
  const BIZ = { 'docs/quality-assurance-policy.md': '# 層1\n\n| 項目 | 値 |\n| --- | --- |\n| 版 | v1 |\n| 記名 | 名簿 戊 |\n| 記名日 | 2026-10-01 |\n' };
  const c2 = claimWith(BIZ);
  check('集約(v): 層1 の記名者 = 事業決裁者は、名が適用の表明・離脱の一覧に出る', c2.name === '適用の表明' && c2.unlistedDepartures.some((l) => /層1 の記名者が事業決裁者/.test(l)), JSON.stringify(c2));
  const c3 = claimWith({});
  // IMPL-0521:ok(適合の入力: 記録が無い。名を下げず確かめられない旨を出す)
  check('集約(vi): 引き継ぎ文書も層1 も無いときは、離脱に数えず、確かめられない旨を出す', !c3.unlistedDepartures.some((l) => /保持者|記名者/.test(l)) && c3.unverifiable.length === 2 && c3.blockers.some((b) => /この項目では名を下げません/.test(b)), JSON.stringify(c3));

  // IMPL-0120:ok(適合の入力: 集約の値の行の件数が、同じ実行の欠落の一覧の件数と一致する。品質レポートの行・外へ渡す形も通す)
  check('集約の値の行: claim.statementFacts の欠落の件数は、同じ実行の欠落の一覧(evidence.gaps)の件数と一致する', Array.isArray(c3.__full.gaps) && c3.statementFacts?.gapCount === c3.__full.gaps.length && c1.statementFacts?.gapCount === c1.__full.gaps.length && Array.isArray(c3.statementFacts.unmet), JSON.stringify({ facts: c3.statementFacts, gaps: c3.__full.gaps?.length }));
  const factsLineOf = (text) => (text.match(/^- 適用の表明に併記する事項.*$/m) || [''])[0];
  const lineC3 = factsLineOf(c3.__full.report);
  check('品質レポートの行: 値の行が1行出て、欠落の件数が evidence.gaps の件数と同じ', lineC3 !== '' && lineC3.includes(`集約の欠落の一覧) ${c3.__full.gaps.length} 件`), lineC3);
  // IMPL-0120:ng(違反の入力: 外へ渡す形に離脱の内容(保持者の名)を出す)と対(内部の形は一覧を出す)
  check('外へ渡す形: 列挙に無い離脱は件数だけで、内容(保持者の名)を出さない。内部の品質レポートは内容を出す', factsLineOf(c1.__full.external).includes(`${c1.unlistedDepartures.length} 件(内容は外へ出さない)`) && !/名簿 [甲乙]/.test(factsLineOf(c1.__full.external)) && /保持者が1名以下/.test(factsLineOf(c1.__full.report)), `${factsLineOf(c1.__full.external)}
${factsLineOf(c1.__full.report)}`);

  // ---- 集約の側(process-compass #348 の単位 Z4): IMPL-0645 の1行・トレーラ Spec の読み方・欠陥の台帳の登録外の ID の表示
  const aggWith = (files, msgs = []) => {
    const w = workspace();
    w.commit('chore: template');
    w.writeJson('process.config.json', sealed(issued));
    w.commit('chore: init');
    fs.mkdirSync(path.join(w.dir, 'docs'), { recursive: true });
    for (const f of ['docs/handover.md', 'docs/quality-assurance-policy.md']) fs.rmSync(path.join(w.dir, f), { force: true });
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(w.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(w.dir, rel), text);
    }
    w.git('add', '-A');
    w.git('commit', '-q', '--allow-empty', '-m', 'chore: records');
    msgs.forEach((m, i) => {
      fs.writeFileSync(path.join(w.dir, `f${i}.txt`), String(i));
      w.git('add', '-A');
      w.git('commit', '-q', '-m', m);
    });
    w.node('scripts/gate/aggregate-evidence.mjs');
    const ev = w.readJson('evidence/evidence.json');
    const out = { ev, gaps: ev.gaps, report: fs.readFileSync(path.join(w.dir, 'evidence/quality-report.md'), 'utf8'), get disclosure() { return this.report; }, external: fs.readFileSync(path.join(w.dir, 'evidence/assurance-disclosure.external.md'), 'utf8') };
    w.done();
    return out;
  };
  const LEDGER_HEAD = ['| ID | 区分 | 対象 | 内容 | 受容した理由 | 顕在化の兆候 | 返却の目安 | 状態 | 記録者 | 承認した者 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  const ledgerOf = (...rows) => ['# 技術負債台帳', '', ...LEDGER_HEAD, ...rows].join('\n') + '\n';
  const REM = '| D-001 | 負債 | コア理解: 決済 | 決済の理解を2名にする | 人員 | 離脱 | S2 移行時。責任者 佐藤 花子 | 未返却 | 山田 太郎 | — |';
  const lineOf = (text) => (text.match(/^- コア機能の是正の行.*$/m) || [''])[0];
  const aNone = aggWith(ONE);
  const aMiss = aggWith({ ...ONE, 'docs/debt-ledger.md': ledgerOf() });
  const aOk = aggWith({ ...ONE, 'docs/debt-ledger.md': ledgerOf(REM) });
  // IMPL-0645:ng(違反の入力: 保持者1名で是正の行が無い / 台帳が無い)
  check('集約(IMPL-0645): 台帳に是正の行が無ければ、保証の開示に機能の名と「が無い」を出す', /「決済」の是正の行/.test(lineOf(aMiss.disclosure)) && /が無い/.test(lineOf(aMiss.disclosure)), lineOf(aMiss.disclosure));
  check('集約(IMPL-0645): 台帳が無ければ「確かめられない」と出し、0 件と出さない', /確かめられない/.test(lineOf(aNone.disclosure)), lineOf(aNone.disclosure));
  // IMPL-0645:ok(適合の入力: 是正の行がある。表示は残る)
  check('集約(IMPL-0645): 是正の行があれば「是正の行がある」と出し、中身は機械で確かめない旨を添える', /に是正の行がある/.test(lineOf(aOk.disclosure)) && /機械で確かめない/.test(lineOf(aOk.disclosure)), lineOf(aOk.disclosure));
  check('集約(IMPL-0645): 台帳の行の有無で表示が変わる(範囲の終点の版の台帳を読む)', lineOf(aOk.disclosure) !== lineOf(aMiss.disclosure));
  // 表示だけ: 記載の欠落・未確認の一覧に数えない(要求事項7)
  check('集約(IMPL-0645): 是正の行が無くても、台帳の行の有無で欠落の一覧の件数は変わらず、是正の行を欠落に数えない', aMiss.gaps.length === aOk.gaps.length && ![aMiss, aOk, aNone].some((x) => x.gaps.some((g) => /是正の行|要求事項6/.test(g))), String(aMiss.gaps.length));

  // トレーラ Spec は本文の末尾の段落だけを読む(ADR-0172 決定3)。値の形は緩く保つ
  const g4Line = (a) => (a.disclosure.match(/G-4: トレーラ Spec が指す仕様 [0-9]+ 件.*?無い [0-9]+ 件(?:\(.*?\))?。/) || [''])[0];
  const mid = aggWith({}, ['feat: a\n\nSpec: F-001 / Task-1\n\nCo-Authored-By: Claude <c@example.com>']);
  // ng(違反の入力: 中の段落の Spec は仕様に数えず、件数を出す)
  check('集約(Spec): 中の段落の Spec は仕様に数えず、持つコミットの件数を出す', /仕様 0 件/.test(g4Line(mid)) && /末尾の段落の外に .Spec:. 行を持つコミット 1 件/.test(g4Line(mid)), g4Line(mid));
  const last = aggWith({}, ['feat: b\n\nSpec: F-002']);
  // ok(適合の入力: 末尾の段落で、タスクを欠く行も仕様を指すものとして数える。G-4 の要否が消えない)
  check('集約(Spec): 末尾の段落の Spec: F-002(タスクなし)は仕様に数え、段落の外の件数は出さない', /仕様 1 件/.test(g4Line(last)) && !/段落の外/.test(g4Line(last)), g4Line(last));
  const lastFull = aggWith({}, ['feat: c\n\nSpec: F-003 / Task-2\nCo-Authored-By: Claude <c@example.com>']);
  check('集約(Spec): 末尾の段落の Spec: F-003 / Task-2 は仕様に数える(手戻り率の読み方と同じ段落)', /仕様 1 件/.test(g4Line(lastFull)), g4Line(lastFull));


  // 保持者の数え方(ADR-0147 決定2。独立の突合 1巡目 高-1・中-1)。層1 は様式を写し、記名者(事業決裁者でない人)と力量の確認の周期だけを埋める
  const tpl11 = fs.readFileSync(path.join(ROOT, 'templates/11-quality-assurance-policy.md'), 'utf8').replace(/\r\n/g, '\n');
  const signed = tpl11.replace(/^\| 記名\(記名者\) \|.*$/m, '| 記名(記名者) | 名簿 丁 |').replace(/^\| 記名日 \|.*$/m, '| 記名日 | 2026-10-01 |');
  const POLICY12 = { 'docs/quality-assurance-policy.md': signed.replace(/^(\| AI を使わない力量の確認の周期[^|]*\| )<例: 12か月>/m, '$112か月') };
  const POLICY_BLANK = { 'docs/quality-assurance-policy.md': signed };
  const row = (holders, by, at) => `| 決済 | ${holders} | ${by} | ${at} | | なし |\n`;
  const TWO = (by = '名簿 丙', at = '演習 2026-10-01') => ({ 'docs/handover.md': HANDOVER_HEAD + row('名簿 甲、名簿 乙', by, at) });
  const coreDep = (c) => c.unlistedDepartures.filter((l) => /コア機能の理解の保持者/.test(l));
  const coreUnv = (c) => c.unverifiable.filter((l) => /コア機能/.test(l));
  // IMPL-0521:ng(違反の入力: 保持者1名・有効な層1。離脱の文に「1 名」が出る)
  const cOne = claimWith({ ...ONE, ...POLICY12 });
  check('集約(iv): 層1 を置いた保持者1名は、「数えた 1 名」で離脱に数える', coreDep(cOne).length === 1 && /数えた 1 名・書いた 1 名/.test(coreDep(cOne)[0]), JSON.stringify(cOne));
  // IMPL-0521:ok(適合の入力: 保持者2名・有効な層1。離脱にも確かめられない旨にも出さない)
  const cA = claimWith({ ...TWO(), ...POLICY12 });
  check('集約(A): 保持者2名・有効な層1 は、離脱に数えず、確かめられない旨も出さない', !coreDep(cA).length && !coreUnv(cA).length, JSON.stringify(cA));
  // IMPL-0521:ok(適合の入力: 書いた名は2名で、層1 なし・周期の空欄・日付の書式は、解けない記録として名を下げない)
  for (const [label, files] of [
    ['B 層1 なし', TWO()],
    ['C 周期の空欄', { ...TWO(), ...POLICY_BLANK }],
    ['D 確認日の書式', { ...TWO('名簿 丙', '演習 2026/10/01'), ...POLICY12 }],
    ['K 層1 が雛形のまま', { ...TWO(), 'docs/quality-assurance-policy.md': tpl11 }],
  ]) {
    const c = claimWith(files);
    check(`集約(${label}): 離脱に数えず、数えなかった理由とともに確かめられない旨を出す`, !coreDep(c).length && coreUnv(c).length === 1 && /書いた 2 名のうち数えたのは 0 名/.test(coreUnv(c)[0]), JSON.stringify(c));
  }
  // IMPL-0521:ng(違反の入力: 確認日の語が無い・周期超過・本人。要求事項8 を欠く。書いた名が2名でも離脱。独立の突合 2巡目 高-1・低-4)
  for (const [label, files] of [
    ['L 確認日の欄が空', TWO('名簿 丙', '')],
    ['O 日付の語が無い(演習)', TWO('名簿 丙', '演習')],
    ['P 日付の語が無い(未確認)', TWO('名簿 丙', '未確認')],
    ['M 確認日が周期を過ぎた', TWO('名簿 丙', '演習 2024-01-01')],
    ['N 確認者が保持者本人', TWO('名簿 甲', '演習 2026-10-01')],
  ]) {
    const c = claimWith({ ...files, ...POLICY12 });
    check(`集約(${label}): 書いた名が2名でも離脱に数える`, coreDep(c).length === 1 && !coreUnv(c).length, JSON.stringify(c));
  }
  // IMPL-0521:ng/ok(違反と適合の対: 2名のうち1名が数えられ、もう1名の理由で分かれる。Q は書式で決まらない、R は確認者の空欄)
  const MIX = (second) => ({ 'docs/handover.md': HANDOVER_HEAD + row('名簿 甲', '名簿 丙', '演習 2026-10-01') + second });
  const cQ = claimWith({ ...MIX(row('名簿 乙', '名簿 丙', '演習 2026/10/01')), ...POLICY12 });
  check('集約(Q): 1名を数え、もう1名が書式で決まらないときは、離脱に数えず確かめられない旨を出す', !coreDep(cQ).length && coreUnv(cQ).length === 1 && /書いた 2 名のうち数えたのは 1 名/.test(coreUnv(cQ)[0]), JSON.stringify(cQ));
  const cR = claimWith({ ...MIX(row('名簿 乙', '', '演習 2026-10-01')), ...POLICY12 });
  check('集約(R): 1名を数え、もう1名が確認者の空欄のときは、離脱に数える', coreDep(cR).length === 1 && /数えた 1 名・書いた 2 名/.test(coreDep(cR)[0]) && !coreUnv(cR).length, JSON.stringify(cR));
  // 同じ人を2行に書き、1行を数えたとき、数えた名を「数えなかった」に出さない(低-1)
  const cT = claimWith({ ...MIX(row('名簿 甲', '名簿 丙', '演習 2026/10/01')), ...POLICY12 });
  check('集約(T): 数えた名は「数えなかった」に出さない', coreDep(cT).length === 1 && /数えた 1 名・書いた 1 名/.test(coreDep(cT)[0]) && !/数えなかった/.test(coreDep(cT)[0]), JSON.stringify(cT));
  // 終点が先頭でない範囲(独立の突合 2巡目 低-3・中-1)。終点のコミットの記録で、名と開示の表の両方を読む
  const claimAtEnd = (endFiles, headFiles) => {
    const w = workspace();
    w.commit('chore: template');
    w.writeJson('process.config.json', sealed(issued));
    w.commit('chore: init');
    fs.mkdirSync(path.join(w.dir, 'docs'), { recursive: true });
    for (const f of ['docs/handover.md', 'docs/quality-assurance-policy.md']) fs.rmSync(path.join(w.dir, f), { force: true });
    const put = (files) => { for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(w.dir, rel), text); w.git('add', '-A'); w.git('commit', '-q', '--allow-empty', '-m', 'chore: records'); };
    put(endFiles);
    const end = w.git('rev-parse', 'HEAD').toString().trim();
    put(headFiles);
    w.node('scripts/gate/aggregate-evidence.mjs', '--to', end);
    const ev = w.readJson('evidence/evidence.json');
    w.done();
    return ev;
  };
  // 終点は保持者2名、先頭は1名。終点の記録で読むので離脱に数えず、開示の表も2名を示す
  const evR1 = claimAtEnd({ ...TWO(), ...POLICY12 }, { ...ONE, ...POLICY12 });
  check('集約(R1): 終点の記録が2名なら、名は離脱に数えず、開示の表も終点の2名を示す', !coreDep(evR1.claim).length && evR1.assurance.continuity.core[0]?.holders === 2, JSON.stringify([evR1.claim.unlistedDepartures, evR1.assurance.continuity.core]));
  // 終点は保持者1名、先頭は2名。終点の記録で読むので離脱に数え、開示の表も1名を示す
  const evR2 = claimAtEnd({ ...ONE, ...POLICY12 }, { ...TWO(), ...POLICY12 });
  check('集約(R2): 終点の記録が1名なら、名は離脱に数え、開示の表も終点の1名を示す', coreDep(evR2.claim).length === 1 && evR2.assurance.continuity.core[0]?.holders === 1, JSON.stringify([evR2.claim.unlistedDepartures, evR2.assurance.continuity.core]));
  // IMPL-0521:ng(違反の入力: 確認の記録を欠く(要求事項8)。確認者の列なし・空欄は、書いた名が2名でも離脱)
  const OLD = { 'docs/handover.md': '# 運用引き継ぎ\n\n## 2. コア機能\n\n| 機能 | 理解保持者 | 判断記録 |\n| --- | --- | --- |\n| 決済 | 名簿 甲、名簿 乙 | |\n' };
  for (const [label, files] of [['E 確認者の列なし', OLD], ['F 確認者が空欄', TWO('', '演習 2026-10-01')]]) {
    const c = claimWith({ ...files, ...POLICY12 });
    check(`集約(${label}): 書いた名が2名でも離脱に数える`, coreDep(c).length === 1 && /書いた 2 名/.test(coreDep(c)[0]) && !coreUnv(c).length, JSON.stringify(c));
  }
}

// ---------------------------------------------------------------- AI 生成箇所の追跡(IMPL-0760・IMPL-0839。process-compass #448・#446)
{
  const built = (answers) => quiet(() => buildConfig({ ...COMMON, 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes', ...answers }, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS3 }));
  const shown = (b) => ({ profile: renderProfileMd(b.config, b.result), rules: renderProcessRules(b.config) });
  const TRACE = /AI 生成箇所の追跡/;
  const cl1 = shown(built({ 'q-criticality': 'cl1' }));
  const reg = shown(built({ 'q-quality': 'quality-regulated' }));
  const none = shown(built({}));
  // IMPL-0760:ng IMPL-0839:ng(違反の入力: CL1 以上または規制業なのに、追跡の文が出ない構成は、適合の側の試験が落とす)
  check('追跡: CL1 の構成は、PROCESS-PROFILE.md に規則 r-e-cl1 の追跡の文を出す', TRACE.test(cl1.profile) && /r-e-cl1/.test(cl1.profile), cl1.profile.slice(0, 200));
  check('追跡: CL1 の構成は、CLAUDE.md の構成依存部分に同じ文を出す', TRACE.test(cl1.rules) && /r-e-cl1/.test(cl1.rules));
  check('追跡: 規制業の構成は、PROCESS-PROFILE.md と構成依存部分に規則 r-c-regulated の追跡の文を出す', TRACE.test(reg.profile) && TRACE.test(reg.rules) && /r-c-regulated/.test(reg.profile) && /r-c-regulated/.test(reg.rules));
  check('追跡: 箇所の単位の照合は機械で確かめない旨を、文に書く', /人が確かめる/.test(cl1.rules));
  // IMPL-0760:ok IMPL-0839:ok(適合の入力: CL0 の標準品質の構成は、追跡の文を出さない)
  check('追跡: CL0・標準品質の構成は、追跡の文を出さない', !TRACE.test(none.profile) && !TRACE.test(none.rules));
}

// ---------------------------------------------------------------- 提案書へ写す調整の宣言(IMPL-0959。process-compass #446)
{
  const built = (answers, opts = {}) => quiet(() => buildConfig({ ...COMMON, 'q-external-reviewer': 'reviewer-yes', ...answers }, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS3, ...opts }));
  const section = (b) => {
    const t = renderProfileMd(b.config, b.result);
    const i = t.indexOf('## 提案書へ写す調整の宣言');
    return i < 0 ? '' : t.slice(i).split('\n## ')[0];
  };
  // IMPL-0959:ng(違反の入力: 外した項目・簡略化した項目・practice の調整があるのに、節が無い・項目が載らない構成は、この対が落とす)
  const poc = built({ 'q-team-size': 'size-1-2', 'q-biz-phase': 'poc' });
  const sec = section(poc);
  check('宣言: 外した項目(PoC の独立レビュー・出荷判定の省略)が、区分と理由とともに載る', /独立レビュー/.test(sec) && /適用しない/.test(sec) && !/調整の宣言: \*\*なし\*\*/.test(sec), sec.slice(0, 400));
  check('宣言: 簡略化した項目と practice の調整(役割の委譲など)が載る', /簡略化して適用する|practice:/.test(sec), sec.slice(0, 400));
  check('宣言: 承認者の欄に AI の名義を書かない(決裁者が記名する旨を案内する)', /決裁者が記名/.test(sec) && !/承認者: /.test(sec), sec);
  // IMPL-0959:ok(適合の入力: 調整が何も無い構成は、「なし」と出す)
  const plain = built({ 'q-team-size': 'size-3-9' });
  const allRequired = { ...plain.config, gates: Object.fromEntries(Object.entries(plain.config.gates).map(([k, g]) => [k, { ...g, state: 'required' }])) };
  const t0 = renderProfileMd(allRequired, { ...plain.result, profile: {} });
  check('宣言: 調整が何も無い構成は「なし」と出す', /調整の宣言: \*\*なし\*\*/.test(t0.slice(t0.indexOf('## 提案書へ写す調整の宣言'))), t0.slice(t0.indexOf('## 提案書へ写す調整の宣言'), t0.indexOf('## 提案書へ写す調整の宣言') + 300));
}

console.log('');
if (failures) {
  console.log(`版・適用の終了・適用の開始の境の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`版・適用の終了・適用の開始の境の試験: ${checks} 件が期待と一致しました`);
