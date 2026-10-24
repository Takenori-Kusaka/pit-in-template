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
//   - 述べられる名: 作業中の版・終了後は無し / 未達・列挙に無い離脱があれば適用の表明 / 閉じた列挙の逸脱だけなら逸脱を伴う適合の主張
// GitHub へ問い合わせません。リポジトリの状態を変えません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, claimStatus, classifyDeviations, findInitCommit, initRecordProblem, sealChangeLog, standardEdition, configDigest } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

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
  check('作業中の版に従う構成は、表明・主張の名を持たない', standardEdition(c) === null ? draft.name === null && draft.blockers.some((b) => /作業中の版/.test(b)) : true, JSON.stringify(draft));
  const issued = { ...c, standard: { edition: '第1版' } };
  const s1 = claimStatus(issued);
  check('発行した版に従い、未達も逸脱も無い構成は「適合の主張」', s1.name === '適合の主張' && s1.blockers.length === 0, JSON.stringify(s1));
  const ended = { ...issued, changeLog: [...issued.changeLog, { kind: 'end', date: '2026-10-20', end: { reason: 'closed' }, decidedBy: '名簿 甲' }] };
  const s2 = claimStatus(ended);
  check('適用を終えた構成は、現在形の表明・主張の名を持たない', s2.name === null && s2.ended?.reason === 'closed', JSON.stringify(s2));
  const legacy = { ...issued, standard: undefined };
  check('欄の無い旧い構成は、作業中の版として読む', standardEdition(legacy) === null && claimStatus(legacy).editionLabel.startsWith('作業中の版'));
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
  check('出荷判定者 × 事業決裁者の兼務(列挙に無い離脱)がある構成は「適用の表明」まで', st2.name === '適用の表明' && st2.unlisted.some((d) => /出荷判定者|事業決裁者/.test(d.label)), JSON.stringify({ name: st2.name, unlisted: st2.unlisted.map((d) => d.label), unmet: st2.unmet }));
}
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
  const r0 = change({ kind: 'edition', edition: '第1版', summary: '第1版へ', decidedBy: '名簿 甲', reason: '発行された' });
  if (kbEdition !== '第1版') check('知識ベースの版と異なる版へは切り替えない', !r0.ok && /知識ベース/.test(r0.out), r0.out);
  const rDraft = change({ kind: 'edition', edition: null, summary: '作業中へ', decidedBy: '名簿 甲', reason: 'x' });
  check('作業中の版へは切り替えない', !rDraft.ok && /作業中の版/.test(rDraft.out), rDraft.out);
  // 知識ベースを第1版の複製にして切り替える
  const kb = w.readJson('scripts/vendor/tailoring-kb.json');
  kb.source = { ...kb.source, edition: '第1版' };
  w.writeJson('scripts/vendor/tailoring-kb.json', kb);
  w.commit('chore: kb 第1版');
  const rNoSign = change({ kind: 'edition', edition: '第1版', summary: '第1版へ' });
  check('版の切り替えは、記名と理由が無ければ拒否する', !rNoSign.ok && /decidedBy/.test(rNoSign.out), rNoSign.out);
  const r1 = change({ kind: 'edition', edition: '第1版', summary: '第1版へ切り替えた', decidedBy: '名簿 甲', reason: '第1版が発行された' });
  check('知識ベースの版へは、記名と理由つきで切り替えられる', r1.ok, r1.out);
  const c1 = w.readJson('process.config.json');
  check('切り替えの後、構成は第1版に従い、記録に前後の版が残る', c1.standard?.edition === '第1版' && c1.changeLog.at(-1).kind === 'edition' && c1.changeLog.at(-1).edition?.to === '第1版', JSON.stringify([c1.standard, c1.changeLog.at(-1).edition]));
  const v1 = w.node('scripts/gate/verify-gate-contract.mjs');
  check('切り替えの後、契約検査が版と記録の不整合を出さない', !contractErrors(v1.out).length, contractErrors(v1.out).join('\n'));
  w.commit('chore: edition');
  check('版の切り替えは、適用の開始(configured が true になった最初のコミット)を動かさない', findInitCommit(w.dir)?.hash === initHash);
  const rEndBad = change({ kind: 'end', endReason: 'paused', summary: '止める', decidedBy: '名簿 甲', reason: 'x' });
  check('一時停止などの理由の区分は受け付けない', !rEndBad.ok && /endReason/.test(rEndBad.out), rEndBad.out);
  const rEnd = change({ kind: 'end', endReason: 'closed', summary: '案件を完了した', decidedBy: '名簿 甲', reason: '納品を終えた' });
  check('適用の終了は、理由の区分と記名つきで記録できる', rEnd.ok, rEnd.out);
  const c2 = w.readJson('process.config.json');
  check('終了の後も configured は true のまま', c2.configured === true && c2.changeLog.at(-1).end?.reason === 'closed');
  const prof = fs.readFileSync(path.join(w.dir, 'PROCESS-PROFILE.md'), 'utf8');
  check('プロセス構成書に、従う版と適用の終了が出る', /従う本標準の版: \*\*第1版\*\*/.test(prof) && /適用の終了: /.test(prof), prof.slice(0, 1200));
  const v2 = w.node('scripts/gate/verify-gate-contract.mjs');
  check('終了の後、契約検査が記録の不整合を出さない', !contractErrors(v2.out).length, contractErrors(v2.out).join('\n'));
  w.commit('chore: end');
  const rAfter = change({ kind: 'settings', summary: '値を変える', settings: { task: { maxChangedLines: 300 } } });
  check('終了の後は、変化点を追記しない', !rAfter.ok && /適用を終えています/.test(rAfter.out), rAfter.out);
  check('終了は、適用の開始を動かさない', findInitCommit(w.dir)?.hash === initHash);
  w.done();
}
{
  // 旧い構成(standard の欄なし)は、変化点を経ない再生成で欄を足さない
  const w = workspace();
  w.commit('chore: template');
  fs.writeFileSync(path.join(w.dir, 'answers.json'), JSON.stringify({ ...COMMON, 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' }));
  const init = w.node('scripts/init/generate-profile.mjs', '--answers', 'answers.json', '--stack', 'node');
  check('試験の前提: 初期化が通る', init.ok, init.out);
  fs.rmSync(path.join(w.dir, 'answers.json'));
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
  w.writeJson('process.config.json', sealed(base));
  w.commit('chore: init');
  check('境は、changeLog に依らず configured が true になった最初のコミット', findInitCommit(w.dir)?.hash === handHash);
  const v = w.node('scripts/gate/verify-gate-contract.mjs');
  check('契約検査が、初期化の記録の無いことを注記する', /構成の初期化の記録/.test(v.out), v.out);
  const a = w.node('scripts/gate/aggregate-evidence.mjs');
  check('集約が、適用の開始のコミットの初期化の記録の欠落を出す', /適用の開始\([0-9a-f]{12}\): .*記録の欠落です/.test(a.out), a.out);
  w.done();
}

console.log('');
if (failures) {
  console.log(`版・適用の終了・適用の開始の境の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`版・適用の終了・適用の開始の境の試験: ${checks} 件が期待と一致しました`);
