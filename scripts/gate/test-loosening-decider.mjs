// 外部の確認者が席の責任者である独立レビュアの席を、緩める向きに変える変化点の入口の試験
// (標準 第3章 3.13.3。process-compass #314 / ADR-0084 決定6。IMPL-0115)。
//
//   node scripts/gate/test-loosening-decider.mjs
//
// 固定する決定:
//   - 変化点の入口(generate-profile.mjs --change)が、外部の確認者(独立レビュアの席の責任者)の記名による
//     緩める向きの決定(独立レビュアの席の運用形態を人確定から協働へ上げる)を拒否し、構成を書き換えない(IMPL-0115:ng)
//   - 同じ変化点を、D-0 表1 の決定者(事業決裁者の席の責任者)の記名なら受け付ける(IMPL-0115:ok)
//   - 任免と緩める向きの行を1つの変化点に含み、すべての行の要件を満たす1人がいなければ拒否し、変化点を分ける案内を出す。
//     分ければ受け付ける(process-compass #376 / ADR-0110 決定2。IMPL-0444:ng/ok)
//   - 決定者が当事者になる行は本人以外が記名する。名簿へ人を足す行の記名者。発生で入った兼務の決定待ちと期限。差し替えの禁止
//     (process-compass #432・#433 / ADR-0122。IMPL-0480〜IMPL-0484)
//   - 変化点の記録に差分の行ごとの種類(rowKinds)を残し、数の合わない記録を検査が問題にする(ADR-0110 決定3。IMPL-0445:ng/ok)
// 関数の単位の試験(test-roster-rules.mjs)に加えて、入口を通して確かめる。一時の置き場で試し、GitHub へ問い合わせません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sealChangeLog, directionLabel, rowKindsProblems, localDay, observationWindowAt, reworkBaselineInfo } from './config.mjs';
import { buildConfig, authoritySourceForm } from '../init/generate-profile.mjs';
import { copyTemplateTree } from './template-copy.mjs';

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
function check(name, ok, detail = '') {
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

const A = { id: 'a', name: '山田 太郎', accounts: ['yamada'] };
// 外部の確認者を独立レビュアの席の責任者に置く条件(3.5 の(イ))の記録を持たせる(process-compass #357 / ADR-0127 決定3)
const X = { id: 'x', name: '高橋 次郎', external: true, accounts: ['takahashi-j'], reviewCompetence: { confirmedAt: '2026-10-20', confirmedBy: '山田 太郎', record: 'docs/review-competence/x.md' } };
const seatsOf = (map) => Object.entries(map).map(([role, accountable]) => ({ role, accountable }));
const answers = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-1-2', 'q-biz-phase': 'mvp', 'q-external-reviewer': 'reviewer-yes',
};
const config = quiet(
  () =>
    buildConfig(answers, {
      generatedAt: '2026-10-24T09:00:00+09:00',
      d0Version: null,
      people: [A, X],
      seats: seatsOf({ 'biz-approver': 'a', 'dev-verifier': 'a', 'independent-reviewer': 'x' }).map((s) =>
        s.role === 'independent-reviewer' ? { ...s, agreement: { at: '2026-10-20', record: 'docs/agreements/x.pdf' } } : s
      ),
    }).config
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-loosen-'));
try {
  copyTemplateTree(dir, { skip: SKIP });
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  const cfgPath = path.join(dir, 'process.config.json');
  // 独立レビュアの席を人確定にしておき、協働へ上げる(上限の宣言を上げる = 緩める向き)
  const initial = JSON.parse(JSON.stringify(config));
  initial.seats.find((s) => s.role === 'independent-reviewer').mode = 'human';
  fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(initial), null, 2) + '\n');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'templates/00-d0-governance.md'), path.join(dir, 'docs/D-0-governance.md'));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: init');
  const before = fs.readFileSync(cfgPath, 'utf8');
    const change = (decidedBy) => {
    fs.writeFileSync(
      path.join(dir, 'change.json'),
      JSON.stringify({ kind: 'mode', summary: '独立レビュアの席の運用形態を上げる', seats: { 'independent-reviewer': { mode: 'collab' } }, decidedBy, reason: '試験' })
    );
    const r = spawnSync(process.execPath, ['scripts/init/generate-profile.mjs', '--change', 'change.json'], { cwd: dir, encoding: 'utf8', env });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  // IMPL-0115:ng 外部の確認者(独立レビュアの席の責任者)の記名では受け付けない
  const ng = change(X.name);
  check(
    'IMPL-0115:ng 外部の確認者の記名による、独立レビュアの席を緩める変化点を、入口が拒否する',
    !ng.ok && /外部の確認者であり/.test(ng.out) && /席の責任者の記名では受け付けません/.test(ng.out),
    ng.out
  );
  check('拒否した変化点は、構成を書き換えない', fs.readFileSync(cfgPath, 'utf8') === before);

  // 人ごとに担う席の列挙(seatsByPerson)。検証の前に席ごとの入力へ展開する。食い違いは拒否する
  const byPerson = (extra, args = []) => {
    fs.writeFileSync(path.join(dir, 'change.json'), JSON.stringify({ summary: '席の責任者を人ごとに書く', decidedBy: A.name, reason: '試験', ...extra }));
    const r = spawnSync(process.execPath, ['scripts/init/generate-profile.mjs', '--change', 'change.json', ...args], { cwd: dir, encoding: 'utf8', env });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const strip = (s) => s.replace(/変化点の入力 [^\n]*\n?/g, '').trim();
  const perPerson = byPerson({ kind: 'accountable', seatsByPerson: { [A.name]: ['biz-approver', 'dev-verifier'], [X.name]: ['independent-reviewer'] } }, ['--dry-run']);
  const perSeat = byPerson({ kind: 'accountable', seats: { 'biz-approver': { accountable: A.name }, 'dev-verifier': { accountable: A.name }, 'independent-reviewer': { accountable: X.name } } }, ['--dry-run']);
  check(
    '人ごとの席の列挙: 席ごとの入力と同じ構成・差分になる(兼務の開示と席の表は展開後から生成される)',
    perPerson.ok && perSeat.ok && /accountable|責任者|席/.test(perPerson.out) && strip(perPerson.out) === strip(perSeat.out),
    `${perPerson.out}\n----\n${perSeat.out}`
  );
  const clash = byPerson({ kind: 'accountable', seatsByPerson: { [A.name]: ['biz-approver'] }, seats: { 'biz-approver': { accountable: X.name } } }, ['--dry-run']);
  check('人ごとの席の列挙: 席ごとの入力と食い違うときは拒否する', !clash.ok && /食い違います/.test(clash.out), clash.out);
  const sameById = byPerson({ kind: 'accountable', seatsByPerson: { [A.name]: ['biz-approver'] }, seats: { 'biz-approver': { accountable: A.id } } }, ['--dry-run']);
  check('人ごとの席の列挙: 同じ人を id と氏名で書き分けても、食い違いとして拒否しない', !/食い違います/.test(sameById.out), sameById.out);
  const dup = byPerson({ kind: 'accountable', seatsByPerson: { [A.name]: ['biz-approver'], [X.name]: ['biz-approver'] } }, ['--dry-run']);
  check('人ごとの席の列挙: 同じ席を複数の人に書くと拒否する', !dup.ok && /複数の人/.test(dup.out), dup.out);
  const wrongKind = byPerson({ kind: 'mode', seatsByPerson: { [A.name]: ['biz-approver'] } }, ['--dry-run']);
  check('人ごとの席の列挙: 種別 accountable 以外では拒否する', !wrongKind.ok && /種別 accountable でだけ/.test(wrongKind.out), wrongKind.out);
  check('人ごとの席の列挙の試験は、構成を書き換えない', fs.readFileSync(cfgPath, 'utf8') === before);

  // IMPL-0115:ok D-0 表1 の決定者(事業決裁者の席の責任者)の記名なら受け付ける
  const ok = change(A.name);
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const last = after.changeLog.at(-1);
  check(
    'IMPL-0115:ok 同じ変化点を、D-0 表1 の決定者の記名なら受け付け、記名が変化点に残る',
    ok.ok && last.kind === 'mode' && last.decidedBy === A.name && after.changeLog.length === initial.changeLog.length + 1 && after.seats.find((s) => s.role === 'independent-reviewer').mode === 'collab',
    `${ok.out}\n${JSON.stringify(last)}`
  );

  // 判断記録の要否の規則(標準 第2章 2.6。process-compass #422 / ADR-0101)。種別 settings で書き、再生成で失わない。
  // 規則を削る・対象のパスを外すのは緩める向きで、D-0 表1 の決定者の記名を要する
  const settings = (obj) => {
    fs.writeFileSync(path.join(dir, 'change.json'), JSON.stringify({ kind: 'settings', ...obj }));
    const r = spawnSync(process.execPath, ['scripts/init/generate-profile.mjs', '--change', 'change.json'], { cwd: dir, encoding: 'utf8', env });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: mode');
  const badShape = settings({ summary: '規則を置く', settings: { decisionRules: { rules: [{ id: 'api', paths: 'src/api/**' }] } } });
  check('判断記録の要否の規則: 形の違う規則(paths が配列でない、why が無い)を拒否する', !badShape.ok && /decisionRules\.rules\[0\]\.paths/.test(badShape.out) && /decisionRules\.rules\[0\]\.why/.test(badShape.out), badShape.out);
  const add = settings({ summary: '規則を置く', settings: { decisionRules: { rules: [{ id: 'api', paths: ['src/api/**'], why: '公開インタフェース' }] } } });
  const withRule = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  check('判断記録の要否の規則: 規則を足す変化点を受け付け、構成に残る', add.ok && withRule.decisionRules?.rules?.[0]?.id === 'api', add.out);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: rules');
  const keep = settings({ summary: '値を変える', settings: { task: { maxChangedLines: 300 } } });
  check('判断記録の要否の規則: ほかの設定の変化点で規則を失わない', keep.ok && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).decisionRules?.rules?.length === 1, keep.out);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: task');
  const beforeDrop = fs.readFileSync(cfgPath, 'utf8');
  const drop = settings({ summary: '規則を消す', settings: { decisionRules: null } });
  // IMPL-0390:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('判断記録の要否の規則: 規則を削る変化点は、決定者の記名と理由が無ければ拒否する', !drop.ok && /判断記録の要否の規則 api: 削除/.test(drop.out) && fs.readFileSync(cfgPath, 'utf8') === beforeDrop, drop.out);
  const dropOk = settings({ summary: '規則を消す', settings: { decisionRules: null }, decidedBy: A.name, reason: '試験' });
  // IMPL-0390:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('判断記録の要否の規則: 同じ変化点を、D-0 表1 の決定者の記名なら受け付ける', dropOk.ok && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).decisionRules === undefined, dropOk.out);

  // 記録された作業上の選択を読む対象から外す規則(標準 第5章 5.5.1)。種別 settings の choiceReviewExclusions。
  // 条件はパスと変更種別だけ。規則を置く・対象のパスを足す・変更の種類を広げるのは緩める向きで、D-0 表1 の決定者の記名と理由を要する
  // (判断記録の要否の規則と向きが逆。削る・狭めるのは強める向きで、記名なしで受け付ける)
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: before choice rules');
  const xRule = { id: 'tools', paths: ['tools/**'], why: '内部ツール' };
  const xBadKey = settings({ summary: '規則を置く', settings: { choiceReviewExclusions: { rules: [{ ...xRule, dependedOn: true }] } } });
  // IMPL-1080:ng(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: 記録の中身・担い手の申告を条件にする欄(未知の鍵)を拒否する', !xBadKey.ok && /choiceReviewExclusions\.rules\[0\] に書けない欄があります\(dependedOn\)/.test(xBadKey.out), xBadKey.out);
  const xBadTop = settings({ summary: '規則を置く', settings: { choiceReviewExclusions: { rules: [xRule], selfDeclared: true } } });
  check('作業上の選択を読む対象から外す規則: 規則の並びの外の未知の鍵を拒否する', !xBadTop.ok && /choiceReviewExclusions に書けない欄があります\(selfDeclared\)/.test(xBadTop.out), xBadTop.out);
  const xBadShape = settings({ summary: '規則を置く', settings: { choiceReviewExclusions: { rules: [{ id: 'tools', paths: 'tools/**', kinds: ['edit'] }] } } });
  check(
    '作業上の選択を読む対象から外す規則: 形の違う規則(paths が配列でない、kinds が列挙外、why が無い)を拒否する',
    !xBadShape.ok && /choiceReviewExclusions\.rules\[0\]\.paths/.test(xBadShape.out) && /choiceReviewExclusions\.rules\[0\]\.kinds/.test(xBadShape.out) && /choiceReviewExclusions\.rules\[0\]\.why/.test(xBadShape.out),
    xBadShape.out
  );
  const xBeforeDup = fs.readFileSync(cfgPath, 'utf8');
  const xDup = settings({ summary: '規則を置く', settings: { choiceReviewExclusions: { rules: [xRule, { ...xRule, paths: ['docs/**'] }] } }, decidedBy: A.name, reason: '試験' });
  // IMPL-1080:ng(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: id が重複した規則を拒否し、構成を書き換えない', !xDup.ok && /choiceReviewExclusions.rules の id "tools" が重複しています/.test(xDup.out) && fs.readFileSync(cfgPath, 'utf8') === xBeforeDup, xDup.out);
  const xBefore = fs.readFileSync(cfgPath, 'utf8');
  const xAdd = settings({ summary: '規則を置く', settings: { choiceReviewExclusions: { rules: [xRule] } } });
  // IMPL-1080:ng(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: 規則を置く変化点は、決定者の記名と理由が無ければ拒否する', !xAdd.ok && /記録された作業上の選択を読む対象から外す規則 tools: 追加/.test(xAdd.out) && fs.readFileSync(cfgPath, 'utf8') === xBefore, xAdd.out);
  const xAddOk = settings({ summary: '規則を置く', settings: { choiceReviewExclusions: { rules: [xRule] } }, decidedBy: A.name, reason: '試験' });
  // IMPL-1080:ok(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: 同じ変化点を、D-0 表1 の決定者の記名と理由なら受け付け、構成に残る', xAddOk.ok && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).choiceReviewExclusions?.rules?.[0]?.id === 'tools', xAddOk.out);
  const profileText = () => fs.readFileSync(path.join(dir, 'PROCESS-PROFILE.md'), 'utf8');
  // IMPL-1080:ok(違反と適合の対。標準の実装マーク)
  check('作業上の選択を読む対象から外す規則: PROCESS-PROFILE.md に規則の id・パス・理由を表示する', /## 記録された作業上の選択を読む対象から外す規則/.test(profileText()) && profileText().split('\n').some((l) => /^[|] tools [|] `tools[/][*][*]` [|] 全種類 [|] 内部ツール [|]$/.test(l)), profileText().split('\n').filter((l) => /tools|読む対象/.test(l)).join('\n'));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: choice rule');
  const xKeep = settings({ summary: '値を変える', settings: { task: { maxChangedLines: 290 } } });
  check('作業上の選択を読む対象から外す規則: ほかの設定の変化点で規則を失わない', xKeep.ok && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).choiceReviewExclusions?.rules?.length === 1, xKeep.out);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: task again');
  const xWiden = settings({ summary: '対象を足す', settings: { choiceReviewExclusions: { rules: [{ ...xRule, paths: ['tools/**', 'docs/**'] }] } } });
  check('作業上の選択を読む対象から外す規則: 対象のパスを足す変化点は、記名と理由が無ければ拒否する', !xWiden.ok && /対象のパスを足す\(docs\/\*\*\)/.test(xWiden.out), xWiden.out);
  const xNarrow = settings({ summary: '種類を絞る', settings: { choiceReviewExclusions: { rules: [{ ...xRule, kinds: ['modify'] }] } } });
  check('作業上の選択を読む対象から外す規則: 変更の種類を絞る変化点(強める向き)は、記名なしで受け付ける', xNarrow.ok && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).choiceReviewExclusions.rules[0].kinds?.[0] === 'modify', xNarrow.out);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: narrowed');
  const xBroaden = settings({ summary: '種類の絞りを外す', settings: { choiceReviewExclusions: { rules: [xRule] } } });
  check('作業上の選択を読む対象から外す規則: 変更の種類の絞りを外す変化点(広げる向き)は、記名と理由が無ければ拒否する', !xBroaden.ok && /変更の種類 \["modify"\] → null/.test(xBroaden.out), xBroaden.out);
  const xDrop = settings({ summary: '規則を消す', settings: { choiceReviewExclusions: null } });
  check('作業上の選択を読む対象から外す規則: 規則を削る変化点(強める向き)は、記名なしで受け付ける', xDrop.ok && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).choiceReviewExclusions === undefined, xDrop.out);
  check('作業上の選択を読む対象から外す規則: 規則を消した構成の PROCESS-PROFILE.md には、この節を足さない', !/読む対象から外す規則/.test(profileText()), profileText().split('\n').filter((l) => /読む対象/.test(l)).join('\n'));

  // 観測の窓(標準 第5章 5.4.6。process-compass #349)。種別 settings の observationWindow。整数・下限 1・最小標本数の欄は持たない。
  // 値を変えるのは、向きを問わず決定した者の記名と理由を要する
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: rules dropped');
  const cfgText = () => fs.readFileSync(cfgPath, 'utf8');
  const w0 = cfgText();
  const w1 = settings({ summary: '窓', settings: { observationWindow: { months: 0 } }, decidedBy: A.name, reason: '試験' });
  check('観測の窓: 下限 1 を下回る値(0)を拒否し、構成を書き換えない', !w1.ok && /observationWindow.months/.test(w1.out) && cfgText() === w0, w1.out);
  const w25 = settings({ summary: '窓', settings: { observationWindow: { months: 2.5 } }, decidedBy: A.name, reason: '試験' });
  check('観測の窓: 整数でない値(2.5)を拒否する', !w25.ok && /observationWindow.months/.test(w25.out) && cfgText() === w0, w25.out);
  const wMin = settings({ summary: '窓', settings: { observationWindow: { months: 4, minSample: 10 } }, decidedBy: A.name, reason: '試験' });
  check('観測の窓: 最小標本数の欄(minSample)を拒否する(欄を持たず、下げられない)', !wMin.ok && /minSample/.test(wMin.out) && cfgText() === w0, wMin.out);
  const wNoName = settings({ summary: '窓', settings: { observationWindow: { months: 4 } } });
  // IMPL-0516:ng(違反の入力: 記名と理由の無い窓の変更)
  check('観測の窓: 決定した者の記名と理由の無い変更を拒否し、構成を書き換えない', !wNoName.ok && /決定した者/.test(wNoName.out) && cfgText() === w0, wNoName.out);
  const wAi = settings({ summary: '窓', settings: { observationWindow: { months: 4 } }, decidedBy: 'Claude', reason: '試験' });
  check('観測の窓: AI の名義の記名を拒否する', !wAi.ok && cfgText() === w0, wAi.out);
  const w4 = settings({ summary: '窓を長くする', settings: { observationWindow: { months: 4 } }, decidedBy: A.name, reason: '件数が少ない種別のため' });
  const c4 = JSON.parse(cfgText());
  // IMPL-0516:ok(適合の入力: 記名と理由のある窓の変更。値・記録した日・決定した者・理由が構成に残る)
  check(
    '観測の窓: 記名と理由のある変更を受け付け、値・記録した日・決定した者・理由を構成に残す',
    w4.ok && c4.observationWindow?.months === 4 && c4.observationWindow.history.length === 1 && c4.observationWindow.history[0].months === 4 && c4.observationWindow.history[0].decidedBy === A.name && c4.observationWindow.history[0].reason === '件数が少ない種別のため' && /^\d{4}-\d{2}-\d{2}$/.test(c4.observationWindow.history[0].recordedAt),
    `${w4.out}
${JSON.stringify(c4.observationWindow)}`
  );
  // 向きを付けない(長くする・短くするのどちらも、緩める向きの決定者の絞り込みに掛けない)。前の値が無ければ「定めていない」と出す
  const w4log = JSON.stringify(c4.changeLog.at(-1));
  check('観測の窓: 変化点に残り、向きを付けず、定めていない前の値は「定めていない」と出す', w4log.includes('観測の窓') && w4log.includes('定めていない') && !w4log.includes('"loosen"') && !/緩め/.test(w4log), w4log);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: window 4');
  const wKeep = settings({ summary: '値を変える', settings: { task: { maxChangedLines: 290 } } });
  check('観測の窓: ほかの設定の変化点で窓と履歴を失わない', wKeep.ok && JSON.parse(cfgText()).observationWindow?.months === 4 && JSON.parse(cfgText()).observationWindow.history.length === 1, wKeep.out);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: task 290');
  const w4b = cfgText();
  const wShortNo = settings({ summary: '窓を短くする', settings: { observationWindow: { months: 2 } } });
  check('観測の窓: 短くする向きも、記名と理由が無ければ拒否する', !wShortNo.ok && /決定した者/.test(wShortNo.out) && cfgText() === w4b, wShortNo.out);
  const wShort = settings({ summary: '窓を短くする', settings: { observationWindow: { months: 2 } }, decidedBy: A.name, reason: '件数が増えたため' });
  const c2 = JSON.parse(cfgText());
  check('観測の窓: 短くする向きは、記名と理由があれば受け付け、履歴に足す(拒否しない)', wShort.ok && c2.observationWindow?.months === 2 && c2.observationWindow.history.length === 2, wShort.out);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: window 2');

  // 手戻り率の基準値(標準 第5章 5.4.6。process-compass #348)。種別 settings の reworkBaseline。0〜100・既定値なし。
  // 値を変えるのは、向きを問わず決定した者の記名と理由を要する。上げる・新しく置くのは緩める向き、下げる・外すのは強める向き
  const b0 = cfgText();
  const b150 = settings({ summary: '基準値', settings: { reworkBaseline: { percent: 150, method: 'pre-measurement' } }, decidedBy: A.name, reason: '試験' });
  check('手戻り率の基準値: 0〜100 の範囲外(150)を拒否し、構成を書き換えない', !b150.ok && /reworkBaseline.percent/.test(b150.out) && cfgText() === b0, b150.out);
  const bExtra = settings({ summary: '基準値', settings: { reworkBaseline: { percent: 20, method: 'pre-measurement', minSample: 10 } }, decidedBy: A.name, reason: '試験' });
  check('手戻り率の基準値: percent 以外の欄を拒否する', !bExtra.ok && /minSample/.test(bExtra.out) && cfgText() === b0, bExtra.out);
  const bNoName = settings({ summary: '基準値', settings: { reworkBaseline: { percent: 20, method: 'pre-measurement' } } });
  // IMPL-0517:ng(違反の入力: 記名と理由の無い基準値の設定)
  check('手戻り率の基準値: 決定した者の記名と理由の無い設定を拒否し、構成を書き換えない', !bNoName.ok && /決定した者/.test(bNoName.out) && cfgText() === b0, bNoName.out);
  const bAi = settings({ summary: '基準値', settings: { reworkBaseline: { percent: 20, method: 'pre-measurement' } }, decidedBy: 'Claude', reason: '試験' });
  check('手戻り率の基準値: AI の名義の記名を拒否する', !bAi.ok && cfgText() === b0, bAi.out);
  const b20 = settings({ summary: '基準値を置く', settings: { reworkBaseline: { percent: 20, method: 'pre-measurement' } }, decidedBy: A.name, reason: '直近の実績から置く' });
  const cb20 = JSON.parse(cfgText());
  // IMPL-0517:ok(適合の入力: 記名と理由のある基準値の設定。値・記録した日・決定した者・理由が構成に残る)
  check(
    '手戻り率の基準値: 記名と理由のある設定を受け付け、値・記録した日・決定した者・理由を構成に残す',
    b20.ok && cb20.reworkBaseline?.percent === 20 && cb20.reworkBaseline.history.length === 1 && cb20.reworkBaseline.history[0].decidedBy === A.name && cb20.reworkBaseline.history[0].reason === '直近の実績から置く' && /^\d{4}-\d{2}-\d{2}$/.test(cb20.reworkBaseline.history[0].recordedAt),
    `${b20.out}\n${JSON.stringify(cb20.reworkBaseline)}`
  );
  // 単位 Y2: IMPL-0291 の後、基準値の未設定は登録した変更種別を止める。新しく置く変化点は停止を解くため、緩める向きとして残る(向きの原則: ADR-0129)
  check('手戻り率の基準値: 未設定 → 20% の変化点は緩める向き(停止を解く)として記録される', cb20.changeLog.at(-1).direction === 'loosen', JSON.stringify(cb20.changeLog.at(-1)));
  // IMPL-1006:ok(適合の入力: 決め方 pre-measurement を履歴に残す)
  check('手戻り率の基準値の決め方: 値を置く記録の method(pre-measurement)が履歴に残る', cb20.reworkBaseline.history[0].method === 'pre-measurement' && /実測前/.test(JSON.stringify(cb20.changeLog.at(-1))), JSON.stringify(cb20.reworkBaseline.history[0]));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: rework 20');
  {
    const base = cfgText();
    // IMPL-1006:ng(違反の入力: 決め方の無い値の記録)
    const mNone = settings({ summary: '基準値を上げる(決め方なし)', settings: { reworkBaseline: { percent: 30 } }, decidedBy: A.name, reason: '試験' });
    check('手戻り率の基準値の決め方: 値を置く記録に method が無いと拒否し、構成を書き換えない', !mNone.ok && /method/.test(mNone.out) && cfgText() === base, mNone.out);
    // IMPL-1006:ng(違反の入力: 列挙外の決め方)
    const mBad = settings({ summary: '基準値の決め方', settings: { reworkBaseline: { percent: 20, method: 'guess' } }, decidedBy: A.name, reason: '試験' });
    check('手戻り率の基準値の決め方: 列挙外の method(guess)を拒否し、構成を書き換えない', !mBad.ok && /method/.test(mBad.out) && cfgText() === base, mBad.out);
    // IMPL-1006:ng(違反の入力: 値を外す記録に決め方を付ける)
    const mOffM = settings({ summary: '基準値を外す(決め方つき)', settings: { reworkBaseline: { percent: null, method: 'measured' } }, decidedBy: A.name, reason: '試験' });
    check('手戻り率の基準値の決め方: 値を外す記録に method を付けると拒否する', !mOffM.ok && /method/.test(mOffM.out) && cfgText() === base, mOffM.out);
    // IMPL-1006:ng(違反の入力: 決め方だけを改める記録に記名が無い)
    const mNoName = settings({ summary: '決め方だけを改める', settings: { reworkBaseline: { percent: 20, method: 'measured' } } });
    check('手戻り率の基準値の決め方: 値が同じで決め方だけを改める記録も、記名と理由が無ければ拒否する', !mNoName.ok && /決定した者/.test(mNoName.out) && cfgText() === base, mNoName.out);
    // IMPL-1006:ng(違反の入力: AI の名義)
    const mAi = settings({ summary: '決め方だけを改める', settings: { reworkBaseline: { percent: 20, method: 'measured' } }, decidedBy: 'Claude', reason: '試験' });
    check('手戻り率の基準値の決め方: 決め方だけを改める記録の AI の名義の記名を拒否する', !mAi.ok && cfgText() === base, mAi.out);
  }
  const bKeep = settings({ summary: '値を変える', settings: { task: { maxChangedLines: 280 } } });
  check('手戻り率の基準値: ほかの設定の変化点で基準値と履歴を失わない', bKeep.ok && JSON.parse(cfgText()).reworkBaseline?.percent === 20 && JSON.parse(cfgText()).reworkBaseline.history.length === 1, bKeep.out);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: task 280');
  const bUpNo = settings({ summary: '基準値を上げる', settings: { reworkBaseline: { percent: 30, method: 'pre-measurement' } } });
  check('手戻り率の基準値: 上げる向き(緩める)も、記名と理由が無ければ拒否する', !bUpNo.ok && /決定した者/.test(bUpNo.out), bUpNo.out);
  const bUp = settings({ summary: '基準値を上げる', settings: { reworkBaseline: { percent: 30, method: 'pre-measurement' } }, decidedBy: A.name, reason: '標本が小さいため' });
  const cb30 = JSON.parse(cfgText());
  check('手戻り率の基準値: 上げる向きは緩める向きとして変化点に残り、履歴に足す', bUp.ok && cb30.reworkBaseline?.percent === 30 && cb30.reworkBaseline.history.length === 2 && /緩め|loosen/.test(JSON.stringify(cb30.changeLog.at(-1))), JSON.stringify(cb30.changeLog.at(-1)));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: rework 30');
  const bDown = settings({ summary: '基準値を下げる', settings: { reworkBaseline: { percent: 10, method: 'pre-measurement' } }, decidedBy: A.name, reason: '厳しくする' });
  check('手戻り率の基準値: 下げる向き(強める)も、記名と理由があれば受け付け、履歴に足す', bDown.ok && JSON.parse(cfgText()).reworkBaseline?.percent === 10 && JSON.parse(cfgText()).reworkBaseline.history.length === 3, bDown.out);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: rework 10');
  const bOff = settings({ summary: '基準値を外す', settings: { reworkBaseline: { percent: null } }, decidedBy: A.name, reason: '算出を見直すため' });
  const cbOff = JSON.parse(cfgText());
  // 期待を改めた場面(単位 Y2): 外す(null)は、IMPL-0291 の後は未設定による停止を生むため強める向きへ改めた(旧: 緩める向き。未設定は最も緩いとしていた)。記名と理由は向きを問わず要る
  check('手戻り率の基準値: 外す(null)は強める向き(未設定は停止)として記録され、記名と理由を要し、履歴に残る', bOff.ok && cbOff.reworkBaseline?.percent === null && cbOff.reworkBaseline.history.at(-1).percent === null && cbOff.changeLog.at(-1).direction === 'tighten', JSON.stringify(cbOff.changeLog.at(-1)));
  // 発効日(date)を過去へ置いても、窓と基準値の「記録した日」は入口を実行した日になる(過去の評価の日へ遡って当てない)
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: rework off');
  {
    const cb = JSON.parse(cfgText());
    cb.changeLog.at(-1).date = '2026-06-01'; // 最後の記録だけ過去にして封をし直す(連鎖を壊さない)
    fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(cb), null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: backdate log');
    const todayStr = localDay();
    const pastW = settings({ summary: '窓を過去の発効日で長くする', date: '2026-06-02', settings: { observationWindow: { months: 6 } }, decidedBy: A.name, reason: '試験' });
    const cw = JSON.parse(cfgText());
    // IMPL-0516:ng/ok(違反の入力: 過去の発効日。記録した日は実行日で、過去の評価の日には前の値が効く)
    check(
      '観測の窓: 発効日を過去(2026-06-02)に置いても、記録した日は入口を実行した日で、過去の評価の日(2026-07-01・実行日)には前の値(2)が効く',
      pastW.ok && cw.observationWindow?.months === 6 && cw.observationWindow.history.at(-1).recordedAt === todayStr && observationWindowAt(cw, '2026-07-01') === 2 && observationWindowAt(cw, todayStr) === 2,
      `${pastW.out}
${JSON.stringify(cw.observationWindow)}`
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: window 6');
    const pastB = settings({ summary: '基準値を過去の発効日で置く', date: '2026-06-03', settings: { reworkBaseline: { percent: 25, method: 'pre-measurement' } }, decidedBy: A.name, reason: '試験' });
    const cbp = JSON.parse(cfgText());
    // IMPL-0517:ng/ok(違反の入力: 過去の発効日。記録した日は実行日で、過去の評価の日には前の値が効く)
    check(
      '手戻り率の基準値: 発効日を過去(2026-06-03)に置いても、記録した日は入口を実行した日で、過去の評価の日(2026-07-01・実行日)には前の値(未設定)が効く',
      pastB.ok && cbp.reworkBaseline?.percent === 25 && cbp.reworkBaseline.history.at(-1).recordedAt === todayStr && reworkBaselineInfo(cbp, '2026-07-01').percent === null && reworkBaselineInfo(cbp, todayStr).percent === null,
      `${pastB.out}
${JSON.stringify(cbp.reworkBaseline)}`
    );
  }
  // IMPL-1006:ok(適合の入力: 値は同じ 25 のまま、決め方だけを pre-measurement → measured へ改める。履歴が1件増え、向きは付かない)
  {
    const cmBefore = JSON.parse(cfgText()).reworkBaseline.history.length;
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: rework 25');
    const mOk = settings({ summary: '決め方だけを改める', settings: { reworkBaseline: { percent: 25, method: 'measured' } }, decidedBy: A.name, reason: '2四半期の実測で確かめた' });
    const cm = JSON.parse(cfgText());
    const lastH = cm.reworkBaseline.history.at(-1);
    check(
      '手戻り率の基準値の決め方: 値が同じで決め方だけを pre-measurement → measured へ改める記録を、記名と理由のもとで受け付け、履歴を1件足し、percent は 25 のまま',
      mOk.ok && cm.reworkBaseline.percent === 25 && cm.reworkBaseline.history.length === cmBefore + 1 && lastH.method === 'measured' && lastH.percent === 25 && lastH.decidedBy === A.name && lastH.reason === '2四半期の実測で確かめた',
      `${mOk.out}\n${JSON.stringify(cm.reworkBaseline)}`
    );
    check('手戻り率の基準値の決め方: 決め方だけの変化は向きなし(緩める向きにも強める向きにも数えない)', !['loosen', 'tighten'].includes(cm.changeLog.at(-1).direction), JSON.stringify(cm.changeLog.at(-1)));
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: rework 25 measured');
    // 値を外す(null)の記録は method を持たない(受け付ける)
    const mOff = settings({ summary: '基準値を外す', settings: { reworkBaseline: { percent: null } }, decidedBy: A.name, reason: '算出を見直すため' });
    const co = JSON.parse(cfgText());
    check('手戻り率の基準値の決め方: 値を外す(null)記録は method なしで受け付け、履歴の記録は method を持たない', mOff.ok && co.reworkBaseline.percent === null && co.reworkBaseline.history.at(-1).method === undefined, `${mOff.out}\n${JSON.stringify(co.reworkBaseline)}`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 担い手の名義の変更(/process-change 種別 performer。process-compass #430 / IMPL-0429)
// 名義は変化点4 に数えるが担い手の識別に含めないため、適合性確認を失効させない。専用から共有への切り替えは緩める向きの変更で、
// 当該の席の責任者の記名と理由を要する(D-0 表1 の決定者の記名では受け付けない。AI の担い手が決めない)
{
  const B = { id: 'b', name: '鈴木 一郎', accounts: [{ login: 'suzuki', id: 2002 }] };
  const PERF = { model: 'm-1', instructions: 'v1', permissions: 'p' };
  const base = quiet(
    () =>
      buildConfig(answers, {
        generatedAt: '2026-10-24T09:00:00+09:00',
        d0Version: null,
        people: [A, B, X],
        seats: seatsOf({ 'biz-approver': 'b', 'dev-verifier': 'a', 'independent-reviewer': 'x' }).map((s) =>
          s.role === 'independent-reviewer' ? { ...s, agreement: { at: '2026-10-20', record: 'docs/agreements/x.pdf' } } : s
        ),
      }).config
  );
  const dev = base.seats.find((s) => s.role === 'dev-verifier');
  dev.performer = PERF;
  dev.qualification = { confirmedAt: '2026-10-20', performedBy: '山田 太郎', approvedBy: '山田 太郎', cases: '試験の事例', result: '通過', performer: PERF };
  dev.performerAccount = { kind: 'dedicated', account: { login: 'pit-agent-acct', id: 7001 } };
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-performer-account-'));
  try {
    copyTemplateTree(dir2, { skip: SKIP });
    const git = (...a) => execFileSync('git', a, { cwd: dir2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'tester');
    git('config', 'core.autocrlf', 'false');
    const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
    const cfgPath = path.join(dir2, 'process.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(base), null, 2) + '\n');
    fs.mkdirSync(path.join(dir2, 'docs'), { recursive: true });
    fs.copyFileSync(path.join(dir2, 'templates/00-d0-governance.md'), path.join(dir2, 'docs/D-0-governance.md'));
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: init');
    const run = (obj) => {
      fs.writeFileSync(path.join(dir2, 'change.json'), JSON.stringify(obj));
      const r = spawnSync(process.execPath, ['scripts/init/generate-profile.mjs', '--change', 'change.json'], { cwd: dir2, encoding: 'utf8', env });
      return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const toShared = (o = {}) => ({ kind: 'performer', summary: '開発者の席の担い手を、責任者のアカウントで動かす', seats: { 'dev-verifier': { performerAccount: { kind: 'shared', person: 'a' } } }, ...o });
    const before = fs.readFileSync(cfgPath, 'utf8');
    const byDecider = run(toShared({ decidedBy: B.name, reason: '試験' }));
    // IMPL-0429:ng(違反と適合の対。標準の実装マーク。process-compass #314)
    check('名義: 専用から共有への切り替えを、D-0 表1 の決定者(席の責任者でない)の記名では受け付けない', !byDecider.ok && /担い手の名義/.test(byDecider.out) && /席の責任者/.test(byDecider.out) && fs.readFileSync(cfgPath, 'utf8') === before, byDecider.out);
    const unsigned = run(toShared());
    check('名義: 専用から共有への切り替えを、記名と理由なしでは受け付けない', !unsigned.ok && fs.readFileSync(cfgPath, 'utf8') === before, unsigned.out);
    const wrongKind = run({ kind: 'accountable', summary: '名義を変える', seats: { 'dev-verifier': { performerAccount: { kind: 'shared', person: 'a' } } }, decidedBy: A.name, reason: '試験' });
    check('名義: 種別 performer 以外では名義を変えない(変化点4)', !wrongKind.ok && /種別 performer/.test(wrongKind.out), wrongKind.out);
    const noPerson = run({ kind: 'performer', summary: '名義を変える', seats: { 'dev-verifier': { performerAccount: { kind: 'shared' } } }, decidedBy: A.name, reason: '試験' });
    check('名義: /process-change の共有は、相手(person)を名簿の id で書く', !noPerson.ok && /person/.test(noPerson.out), noPerson.out);
    const byHolder = run(toShared({ decidedBy: A.name, reason: '試験' }));
    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const last = after.changeLog.at(-1);
    const devAfter = after.seats.find((s) => s.role === 'dev-verifier');
    // IMPL-0429:ok(違反と適合の対。標準の実装マーク。process-compass #314)
    check(
      '名義: 当該の席の責任者の記名と理由なら受け付け、変化点4(緩める向き)として記録する',
      byHolder.ok && last.kind === 'performer' && last.changePoint === 4 && last.direction === 'loosen' && last.decidedBy === A.name && devAfter.performerAccount?.kind === 'shared',
      `${byHolder.out}\n${JSON.stringify(last)}`
    );
    check('名義: 名義の変更では適合性確認を失効させず、即時通知(識別の変更)も出さない', JSON.stringify(devAfter.qualification) === JSON.stringify(dev.qualification) && !/適合性確認の失効/.test(byHolder.out) && !(last.notice?.reasons ?? []).some((r) => /識別/.test(r)), `${byHolder.out}\n${JSON.stringify(devAfter.qualification)}`);
    check('名義: 共有は D-0 表7 の担い手の名義の列に出る(相手は表5-2 の識別子)', /\*\*共有\*\*\(表5-2 の `a`/.test(fs.readFileSync(path.join(dir2, 'docs/D-0-governance.md'), 'utf8')));
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: shared');
    // 共有から専用への切り替えも、統制の数え方(列挙に無い離脱・G-6 の印・帰属の確認)を外す変更として記名を要する(#430 突合 H-2。
    // ADR-0107 が定めていない逆向きを、記名を要する側に倒した)
    const toDedicated = (o = {}) => ({ kind: 'performer', summary: '専用のアカウントへ戻す', seats: { 'dev-verifier': { performerAccount: { kind: 'dedicated', account: { login: 'pit-agent-acct', id: 7001 } } } }, ...o });
    const beforeBack = fs.readFileSync(cfgPath, 'utf8');
    const backUnsigned = run(toDedicated());
    check('名義: 共有から専用への切り替えも、記名と理由なしでは受け付けない', !backUnsigned.ok && fs.readFileSync(cfgPath, 'utf8') === beforeBack, backUnsigned.out);
    const backByDecider = run(toDedicated({ decidedBy: B.name, reason: '試験' }));
    check('名義: 共有から専用への切り替えも、D-0 表1 の決定者(席の責任者でない)の記名では受け付けない', !backByDecider.ok && fs.readFileSync(cfgPath, 'utf8') === beforeBack, backByDecider.out);
    const back = run(toDedicated({ decidedBy: A.name, reason: '試験' }));
    const last2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).changeLog.at(-1);
    check('名義: 共有から専用への切り替えは、当該の席の責任者の記名と理由で受け付ける(記名を要する向きとして記録する)', back.ok && last2.direction === 'loosen' && last2.decidedBy === A.name, `${back.out}\n${JSON.stringify(last2)}`);
    const overlap = run({ kind: 'performer', summary: '専用と申告する', seats: { 'dev-verifier': { performerAccount: { kind: 'dedicated', account: { login: 'suzuki', id: 2002 } } } } });
    check('名義: 名簿の人のアカウントを専用と申告する入力を拒否する', !overlap.ok && /鈴木 一郎/.test(overlap.out), overlap.out);
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 任免と緩める向きを同じ変化点に含む場合(process-compass #376 / ADR-0110。IMPL-0444・IMPL-0445)
// 1つの変化点の記名者は、すべての行(任免・緩める・名簿の表記の変更)の要件を満たす1人に限る。満たす者がいなければ受け付けず、
// 分け方を案内する。分ければ通る。差分の行ごとの種類を記録に残し、緩める行と任免の行を両方含む記録は「緩める(任免を含む)」と出す
{
  const P = [
    { id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: 3001 }] },
    { id: 'p2', name: '佐藤 花子', accounts: [{ login: 'sato', id: 3002 }] },
    { id: 'p3', name: '鈴木 一郎', accounts: [{ login: 'suzuki', id: 3003 }] },
  ];
  const ORG = { id: 'org', name: '組織 任命者', external: true, appointer: true };
  const SEAT_IDS = ['biz-approver', 'value-owner', 'tech-lead', 'dev-verifier', 'independent-reviewer', 'qa-gatekeeper', 'context-owner', 'ai-maintainer', 'ai-ops'];
  /** 席の並び(SEAT_IDS)ごとの人の添字。null は空ける */
  const seatsBy = (arr) => Object.fromEntries(SEAT_IDS.map((s, i) => [s, { accountable: arr[i] === null ? null : P[arr[i]].name }]));
  const DAY = '2026-10-01';
  const workspace = (prefix, ans = answers) => {
    const blank = quiet(() => buildConfig(ans, { generatedAt: '2026-10-01T09:00:00+09:00', d0Version: null }).config);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    copyTemplateTree(d, { skip: SKIP });
    const git = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'tester');
    git('config', 'core.autocrlf', 'false');
    const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
    const cfgPath = path.join(d, 'process.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(blank), null, 2) + '\n');
    fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
    fs.copyFileSync(path.join(d, 'templates/00-d0-governance.md'), path.join(d, 'docs/D-0-governance.md'));
    // 自己の決定の根拠(D-0 節11「決裁の権限の出所」。process-compass #432 突合 X-7)を書いておく
    const d0p = path.join(d, 'docs/D-0-governance.md');
    fs.writeFileSync(d0p, fs.readFileSync(d0p, 'utf8').replace(/^(\| 決裁の権限の出所 \|)[^\n]*\|\s*$/m, '$1 個人事業主本人(試験) |'));
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: init');
    const run = (obj) => {
      fs.writeFileSync(path.join(d, 'change.json'), JSON.stringify({ kind: 'accountable', date: DAY, ...obj }));
      const r = spawnSync(process.execPath, ['scripts/init/generate-profile.mjs', '--change', 'change.json'], { cwd: d, encoding: 'utf8', env });
      if (r.status === 0) {
        git('add', '-A');
        git('commit', '-q', '-m', 'chore: change');
      }
      return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const cfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const contract = () => {
      const r = spawnSync(process.execPath, ['scripts/gate/verify-gate-contract.mjs'], { cwd: d, encoding: 'utf8', env });
      return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    /** 構成を書き換えて封印を付け直す(検査の入口に、壊れた記録を読ませる) */
    const tamper = (fn) => {
      const c = cfg();
      fn(c);
      fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(c), null, 2) + '\n');
    };
    return { d, run, cfg, contract, tamper, d0: () => fs.readFileSync(path.join(d, 'docs/D-0-governance.md'), 'utf8'), raw: () => fs.readFileSync(cfgPath, 'utf8'), profile: () => fs.readFileSync(path.join(d, 'PROCESS-PROFILE.md'), 'utf8') };
  };
  const hinted = (out) => /すべての行\(任免・緩める・名簿の表記の変更\)の要件を満たす記名者が、名簿にいません/.test(out) && /その行を決定できる者\(決定者を替えた場合は新しい決定者\)が記名して決めます/.test(out);

  // (b) 決定者の交代と緩める向きの行を1つの変化点に含む(2名 mvp cl0。前任の決定者は AI維持管理者の席に残らない)
  const wb = workspace('pit-in-376b-');
  try {
    const fill = wb.run({ summary: '1人目', people: [P[0]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '初期の設定' });
    check('#376 (b): 前提の初回の記入を受け付ける', fill.ok, fill.out);
    const mixed = { summary: '決定者の交代と確認者', people: [P[0], P[1]], seats: seatsBy([1, 0, 0, 0, 1, 0, 0, 1, 1]), reason: '決定者を交代する' };
    const before = wb.raw();
    const byPrior = wb.run({ ...mixed, decidedBy: P[0].name });
    const byNew = wb.run({ ...mixed, decidedBy: P[1].name });
    // IMPL-0444:ng 1人ですべての行の要件を満たせない変化点は、どちらの記名でも受け付けず、分け方を案内する
    check(
      'IMPL-0444:ng 決定者の交代と緩める向きの行を1つの変化点に含むと、前任・新任のどちらの記名でも拒否し、変化点を分ける案内を出す',
      !byPrior.ok && !byNew.ok && hinted(byPrior.out) && hinted(byNew.out) && wb.raw() === before,
      `${byPrior.out}\n----\n${byNew.out}`
    );
    // 前任の決定者が AI維持管理者の席に残る形では、前任の記名で全行の要件を満たせる。新任の記名は拒否するが、分け方は案内しない(突合 F-5)
    const keep = wb.run({ summary: '決定者の交代と確認者', people: [P[0], P[1]], seats: seatsBy([1, 0, 0, 0, 1, 0, 0, 0, 1]), decidedBy: P[1].name, reason: '決定者を交代する' });
    check(
      '#376: 全行の要件を満たす者が名簿にいれば、記名者が違っても拒否だけを出し、分け方は案内しない',
      !keep.ok && !hinted(keep.out) && /席の責任者の任免/.test(keep.out) && wb.raw() === before,
      keep.out
    );
    // 分ける: (i) 決定者の交代だけ(前任の記名)→ (ii) 残りの任免と緩める向きの行(新しい決定者の記名)
    const s1 = wb.run({ summary: '決定者の交代', people: [P[0], P[1]], seats: seatsBy([1, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '決定者を交代する' });
    const e1 = wb.cfg().changeLog.at(-1);
    // 新しい決定者(2人目)が AI維持管理者 × AI運用担当者の両方に就くと、決定者が当事者になる兼務になり、本人の記名では決められない
    // (標準 第3章 3.13.3「決定者が自分に関わる変更」。process-compass #432)。AI運用担当者は1人目に残す
    const s2 = wb.run({ summary: '確認者', people: [P[0], P[1]], seats: seatsBy([1, 0, 0, 0, 1, 0, 0, 1, 0]), decidedBy: P[1].name, reason: '確認者を置く' });
    const c2 = wb.cfg();
    const e2 = c2.changeLog.at(-1);
    // IMPL-0444:ok 分ければ、各段をその段の要件を満たす者の記名で受け付ける
    check(
      'IMPL-0444:ok 変化点を分ければ、決定者の交代(前任の記名)と、緩める向きの行を含む任命(新しい決定者の記名)を受け付ける',
      s1.ok && s2.ok && e1.direction === 'appoint' && e2.direction === 'loosen' && e2.decidedBy === P[1].name && c2.ci.coverageThreshold === 80,
      `${s1.out}\n----\n${s2.out}\n${JSON.stringify(e2)}`
    );
    const kindOf = (e, re) => e.rowKinds?.[e.diff.findIndex((l) => re.test(l))];
    // IMPL-0445:ok 差分の行ごとの種類を、diff と同じ順・同じ数で記録に残す
    check(
      'IMPL-0445:ok 変化点の記録に、差分の行ごとの種類(任免・緩める)を diff と同じ数で残す',
      Array.isArray(e2.rowKinds) &&
        e2.rowKinds.length === e2.diff.length &&
        kindOf(e2, /^独立レビュア.*: 責任者 /) === 'appoint' &&
        kindOf(e2, /^カバレッジの下限: /) === 'loosen' &&
        Array.isArray(e1.rowKinds) &&
        e1.rowKinds.length === e1.diff.length &&
        e1.rowKinds.includes('appoint') &&
        !e1.rowKinds.includes('loosen'),
      `${JSON.stringify(e1.diff)}\n${JSON.stringify(e1.rowKinds)}\n${JSON.stringify(e2.diff)}\n${JSON.stringify(e2.rowKinds)}`
    );
    check(
      '#376: 緩める向きの行と任免の行を両方含む記録は、体制の変化点の記録(PROCESS-PROFILE.md)の向きに「緩める(任免を含む)」と出す(要約の向きは loosen のまま)',
      /\| 緩める\(任免を含む\) \|/.test(wb.profile()) && /\| 任免の決定 \|/.test(wb.profile()),
      wb.profile().split('\n').filter((l) => /^\| 20/.test(l)).join('\n')
    );
    check(
      // S1(コア機能に限る構成)は必須の承認数が 0 のままのため、承認数 0 → 1 の「厳しくする」の行が出ない(4 → 3)
      '#376: D-0 の改訂履歴(節13)に「変更の行ごとの種類」の欄を出し、種類ごとの行の数を書く(第3章 3.13.4 記録7)',
      /\| 通知先と通知日\(即時の通知を要する事象\) \| 変更の行ごとの種類 \|/.test(wb.d0()) && /\| 任免 2 \/ 緩める 1 \/ 厳しくする 3 \|/.test(wb.d0()),
      wb.d0().split('\n').filter((l) => /^\| 20/.test(l)).join('\n')
    );
    const clean = wb.contract();
    check('#376: 行ごとの種類の揃った記録は、契約検査の行ごとの種類の問題に出ない', !/rowKinds|行ごとの種類/.test(clean.out), clean.out);
    // IMPL-0445:ng 契約検査(verify-gate-contract)の入口が、数の合わない記録と、欄の欠けた新しい記録を問題にする
    wb.tamper((c) => {
      c.changeLog.at(-1).rowKinds = c.changeLog.at(-1).rowKinds.slice(1);
    });
    const short = wb.contract();
    wb.tamper((c) => {
      delete c.changeLog.at(-1).rowKinds;
    });
    const missing = wb.contract();
    check(
      'IMPL-0445:ng 契約検査が、差分の行と数の合わない rowKinds と、rowKinds を持つ記録より後で欄を欠く記録を、問題にする',
      !short.ok && /rowKinds\(差分の行ごとの種類\)が \d+ 件で、差分の行\(\d+ 件\)と数が合いません/.test(short.out) && !missing.ok && /行ごとの種類\(rowKinds\)がありません/.test(missing.out),
      `${short.out}\n----\n${missing.out}`
    );
  } finally {
    fs.rmSync(wb.d, { recursive: true, force: true });
  }

  // (a) 前任の決定者が離脱済みで、組織上の任命権者が決定者を任命する変化点に、代償措置の終了(緩める向きの行)が混ざる
  const wa = workspace('pit-in-376a-');
  try {
    // 2名の名簿で全席を1人目(決定者)に置く初回の記入は、決定者が当事者の兼務になり、1人目の記名では通らない(process-compass #432)
    const fill = wa.run({ summary: '体制を記入', people: [P[0], ORG], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '初期の体制を記入する' });
    // 名簿への追加は記名を要する(ADR-0108 決定3。#432 突合 X-2)。決定者(1人目)が外れる変化点なので、組織上の任命権者が記名する
    const leave = wa.run({ summary: '1人目が離脱', people: [P[1], ORG], seats: seatsBy(SEAT_IDS.map(() => null)), decidedBy: ORG.name, reason: '2人目を名簿へ足す' });
    check('#376 (a): 前提の記入と離脱を受け付ける', fill.ok && leave.ok, `${fill.out}\n${leave.out}`);
    const before = wa.raw();
    const mixed = wa.run({ summary: '後任の任命と確認者', people: [P[1], P[2], ORG], seats: seatsBy([1, 1, 1, 1, 2, 2, 1, 1, 2]), decidedBy: ORG.name, reason: '前任の離脱に伴う後任の任命' });
    // IMPL-0444:ng 任命権者は緩める向きの行を決められず、新任の決定者は自分の任命を決められない。案内を出す
    check(
      'IMPL-0444:ng 任命権者の記名による任命に代償措置の終了が混ざる変化点を拒否し、変化点を分ける案内を出す',
      !mixed.ok && hinted(mixed.out) && /カバレッジの下限: 90% → 80%/.test(mixed.out) && wa.raw() === before,
      mixed.out
    );
    const s1 = wa.run({ summary: '後任の任命', people: [P[1], ORG], seats: seatsBy([1, 1, 1, 1, 1, 1, 1, 1, 1]), decidedBy: ORG.name, reason: '前任の離脱に伴う後任の任命' });
    const e1 = wa.cfg().changeLog.at(-1);
    const s2 = wa.run({ summary: '確認者の任命', people: [P[1], P[2], ORG], seats: seatsBy([1, 1, 1, 1, 2, 1, 1, 1, 2]), decidedBy: P[1].name, reason: '確認者を置く' });
    const c2 = wa.cfg();
    const e2 = c2.changeLog.at(-1);
    // IMPL-0444:ok 任命権者の段に緩める向きの行を入れず、新しい決定者の段で決めれば受け付ける
    check(
      'IMPL-0444:ok 任命権者の段(緩める向きの行なし)と、新しい決定者の段(代償措置の終了を含む)に分ければ受け付ける',
      s1.ok && s2.ok && e1.direction === 'appoint' && e1.appointerSigned === true && e2.direction === 'loosen' && c2.ci.coverageThreshold === 80,
      `${s1.out}\n----\n${s2.out}`
    );
  } finally {
    fs.rmSync(wa.d, { recursive: true, force: true });
  }

  // 前任の決定者が離脱し、組織上の任命権者が名簿にいない。任免の段を記名できる者がいないため、分けても通らない。案内しない(突合 F-5)
  const wc = workspace('pit-in-376c-');
  try {
    const fill = wc.run({ summary: '体制を記入', people: [P[0]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '初期の体制を記入する' });
    // 名簿への追加は記名を要する。決定者(1人目)が残る間に足し、その後に離脱する
    const add2 = wc.run({ summary: '2人目', people: [P[0], P[1]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '2人目を名簿へ足す' });
    const leave = add2.ok ? wc.run({ summary: '1人目が離脱', people: [P[1]], seats: seatsBy(SEAT_IDS.map(() => null)) }) : add2;
    const none = wc.run({ summary: '後任の任命と確認者', people: [P[1], P[2]], seats: seatsBy([1, 1, 1, 1, 2, 1, 1, 1, 2]), decidedBy: P[1].name, reason: '前任の離脱に伴う後任の任命' });
    check(
      '#376: 任免の段を記名できる者が名簿にいないときは、緩める向きの行を含んでも分け方を案内しない(任免の拒否だけを出す)',
      fill.ok && leave.ok && !none.ok && !hinted(none.out) && /組織上の任命権者/.test(none.out),
      `${fill.out}\n${leave.out}\n${none.out}`
    );
  } finally {
    fs.rmSync(wc.d, { recursive: true, force: true });
  }

  // 複合のラベルと、行ごとの種類の欄の検査(欄の無い旧い記録は受け付ける)
  const legacy = { direction: 'loosen', diff: ['独立レビュア: 責任者 山田 太郎 → 佐藤 花子', 'カバレッジの下限: 90% → 80%'] };
  check(
    '#376: 行ごとの種類の無い旧い記録は「緩める」と出し、欄の検査で問わない。任免だけの記録は「任免の決定」と出す',
    directionLabel(legacy) === '緩める' && rowKindsProblems(legacy, 0).length === 0 && directionLabel({ direction: 'appoint', rowKinds: ['appoint'] }) === '任免の決定' &&
      directionLabel({ ...legacy, rowKinds: ['appoint', 'loosen'] }) === '緩める(任免を含む)' && directionLabel({ ...legacy, rowKinds: ['none', 'loosen'] }) === '緩める'
  );
  // 関数の単位: 数の合わない記録、不明な種類、向きと種類の食い違い(突合 F-3)
  check(
    '#376: 行ごとの種類の数が差分の行と合わない記録、不明な種類を含む記録、向きが緩めるなのに緩める行の無い記録を、検査の関数が問題にする',
    rowKindsProblems({ ...legacy, rowKinds: ['appoint', 'none'] }, 0).some((p) => /緩める行がありません/.test(p)) &&
    rowKindsProblems({ ...legacy, rowKinds: ['loosen'] }, 4).some((p) => /changeLog\[4\].*数が合いません/.test(p)) && rowKindsProblems({ ...legacy, rowKinds: ['appoint', 'widen'] }, 0).some((p) => /不明な種類/.test(p))
  );
  // ---------------------------------------------------------------- 決定者が自分に関わる変更と、発生で入った兼務(process-compass #432・#433 / ADR-0122)
  // 回帰の場面 self-decision(本体 scripts/regress/suite/self-decision.mjs)と同じ入力の一部を、入口を通して固定する
  const SELF = '決定者は、自分に関わる変更を自分の記名で決められません';
  const wd = workspace('pit-in-432-');
  try {
    // IMPL-0483:ng 決定者(2人目)が自分を出荷判定者へ置く(出荷判定者 × 事業決裁者の当事者になる)変化点を、本人の記名では受け付けない
    const base = wd.run({ summary: '体制を記入', people: [P[0], P[1], ORG], seats: seatsBy([1, 0, 0, 0, 1, 0, 0, 0, 1]), decidedBy: P[1].name, reason: '初期の設定' });
    const selfShip = wd.run({ summary: '出荷判定者', people: [P[0], P[1], ORG], seats: seatsBy([1, 0, 0, 0, 1, 1, 0, 0, 1]), decidedBy: P[1].name, reason: '試験' });
    check('IMPL-0483:ng 決定者が当事者になる兼務を、決定者本人の記名では受け付けない', base.ok && !selfShip.ok && selfShip.out.includes(SELF), `${base.out}\n${selfShip.out}`);
    // IMPL-0483:ok 同じ変化点を、本人以外の席の責任者(1人目)の記名なら受け付ける
    const otherShip = wd.run({ summary: '出荷判定者', people: [P[0], P[1], ORG], seats: seatsBy([1, 0, 0, 0, 1, 1, 0, 0, 1]), decidedBy: P[0].name, reason: '試験' });
    check('IMPL-0483:ok 同じ変化点を、本人以外の席の責任者の記名なら受け付ける', otherShip.ok && wd.cfg().changeLog.at(-1).selfDecided !== true, otherShip.out);
    // IMPL-0480:ng 名簿へ人を足す行に、決定者でない名簿の人が記名した変化点を受け付けない
    const addByOther = wd.run({ summary: '外部の確認者', people: [P[0], P[1], ORG, { id: 'x', name: '高橋 次郎', external: true, accounts: [{ login: 'takahashi', id: 3009 }] }], seats: seatsBy([1, 0, 0, 0, 1, 1, 0, 0, 1]), decidedBy: P[0].name, reason: '試験' });
    check('IMPL-0480:ng 名簿へ人を足す行に、決定者でない名簿の人の記名を受け付けない', !addByOther.ok && /名簿の変更です/.test(addByOther.out), addByOther.out);
    // IMPL-0480:ng 記名の無い追加も受け付けない(ADR-0108 決定3。#432 突合 X-2)
    const ext = { id: 'x', name: '高橋 次郎', external: true, accounts: [{ login: 'takahashi', id: 3009 }] };
    const addUnsigned = wd.run({ summary: '外部の確認者', people: [P[0], P[1], ORG, ext], seats: seatsBy([1, 0, 0, 0, 1, 1, 0, 0, 1]) });
    check('IMPL-0480:ng 名簿へ人を足す変化点を、記名なしでは受け付けない', !addUnsigned.ok && /人の名簿への追加/.test(addUnsigned.out), addUnsigned.out);
    // IMPL-0480:ok 決定者(2人目)の記名なら反映する
    const addSigned = wd.run({ summary: '外部の確認者', people: [P[0], P[1], ORG, ext], seats: seatsBy([1, 0, 0, 0, 1, 1, 0, 0, 1]), decidedBy: P[1].name, reason: '外部の確認者を名簿へ' });
    check('IMPL-0480:ok 名簿へ人を足す変化点を、決定者の記名で受け付ける', addSigned.ok, addSigned.out);
  } finally {
    fs.rmSync(wd.d, { recursive: true, force: true });
  }
  const we = workspace('pit-in-432e-');
  try {
    const one = we.run({ summary: '1人目', people: [P[0]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '初期の設定' });
    const add = we.run({ summary: '2人目', people: [P[0], P[1]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '2人目を名簿へ足す' });
    const e = we.cfg().changeLog.at(-1);
    // IMPL-0481:ok 1人体制で入った兼務は、2人目を足す変化点で決定待ちの行になり、記名を要しない。行は当事者の id を持つ
    check(
      'IMPL-0481:ok 2人目を足す変化点(決定者の記名。兼務の決定の記名は待たない)を反映し、続く兼務に当事者つきの「選択の余地が生じた(決定待ち)」の行を出す',
      one.ok && add.ok && e.diff.filter((l) => /の兼務\(当事者の id p1。山田 太郎\): 選択の余地が生じた/.test(l)).length === 2,
      `${one.out}\n${add.out}\n${JSON.stringify(e.diff)}`
    );
    // 旧い構成からの移行(#432 突合 X-6): 当事者を書いた行の無い記録の決定待ちは、版の切り替えの記録が無ければ、
    // この規定を含む版で記録した最初の変化点を起点とする。それより前の判定記録は数えない
    {
      const gp = await import('../init/generate-profile.mjs');
      const now = we.cfg();
      const legacyLog = now.changeLog.map((x) => ({ ...x, diff: (x.diff ?? []).map((l) => String(l).replace(/\(当事者の id [^)]*\)/, '')) }));
      const legacy = { ...now, changeLog: legacyLog };
      const st = gp.separationStates(legacy);
      const rec = [{ file: 'docs/gates/g1-old.md', gate: 'G-1 企画承認', judgedAt: '2026-10-01 10:00' }];
      check(
        'IMPL-0482:ok 移行の決定待ちで起点の記録が無ければ、それより前の判定記録を欠落に数えない',
        st.length === 2 && st.every((x) => x.state === 'pending' && x.migrated && !x.since) && gp.pendingSeparationProblems(legacy, rec).length === 0,
        JSON.stringify(st)
      );
      const next = gp.diffConfig(legacy, { ...legacy, answers: { ...legacy.answers } });
      check(
        '#432 X-6: 移行の後の最初の変化点に「決定待ち(旧い構成からの移行)」の行を出し、そこを起点にする',
        next.diff.filter((l) => /: 決定待ち\(旧い構成からの移行/.test(l)).length === 2,
        JSON.stringify(next.diff)
      );
    }
    // IMPL-0482:ok 決定待ちでも、判定記録が無ければ契約検査は決定待ちを問題にしない
    check('IMPL-0482:ok 決定待ちでも、期限の前(判定記録なし)は契約検査が問題にしない', !/決定待ちです/.test(we.contract().out), we.contract().out);
    // IMPL-0482:ng 決定待ちのまま記録したゲート判定を、契約検査が記載の欠落として扱う
    fs.mkdirSync(path.join(we.d, 'docs/gates'), { recursive: true });
    fs.writeFileSync(
      path.join(we.d, 'docs/gates/g1-test.md'),
      '# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | G-1 企画承認 |\n| 対象 | 企画書 |\n| 判定者 | 山田 太郎 |\n| 判定日時 | 2099-01-01 10:00 |\n| 結果 | 通過 |\n| 参照した D-0 の版 | 1.0 |\n'
    );
    const late = we.contract();
    check('IMPL-0482:ng 決定待ちのまま記録したゲート判定を、契約検査が記載の欠落として落とす', !late.ok && /決定待ちです/.test(late.out) && /記載の欠落/.test(late.out), late.out);
    // IMPL-0481:ng 決定待ちの兼務を、当事者(決定者)の記名で続ける決定は受け付けない
    const keepSelf = we.run({ summary: '続ける', people: [P[0], P[1]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), keepSeparations: ['sep-shipping-business', 'sep-maintainer-ops'], decidedBy: P[0].name, reason: '試験' });
    check('IMPL-0481:ng 決定待ちの兼務を続ける決定を、当事者である決定者の記名では受け付けない', !keepSelf.ok && keepSelf.out.includes(SELF), keepSelf.out);
    const keepOther = we.run({ summary: '続ける', people: [P[0], P[1]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), keepSeparations: ['sep-shipping-business', 'sep-maintainer-ops'], decidedBy: P[1].name, reason: '試験' });
    check('#432: 同じ決定を、もう1人の記名なら受け付け、契約検査の決定待ちが消える', keepOther.ok && !/決定待ちです/.test(we.contract().out), `${keepOther.out}\n${we.contract().out}`);
    // IMPL-0954: G・SG に当たらないゲート欄(価値責任者の調整など)も、ゲート欄の値で同じゲートを決め、決定の後の記録し直しで欠落を解く
    {
      const gp = await import('../init/generate-profile.mjs');
      const cfg = we.cfg();
      const iv = gp.separationPendingIntervals(cfg).find((x) => x.start && x.end);
      const inside = String(iv?.start ?? '').slice(0, 16);
      const rec = (gate, judgedAt, file) => ({ file, gate, judgedAt });
      const probs = (rs) => gp.pendingSeparationProblems(cfg, rs).length;
      check('IMPL-0954:前提 決定で閉じた決定待ちの区間が在る', !!iv && inside.length === 16, JSON.stringify(gp.separationPendingIntervals(cfg)));
      check('IMPL-0954:ng 決定待ちの間の「価値責任者の調整」の記録だけなら欠落に数える', probs([rec('価値責任者の調整', inside, 'adj-1.md')]) > 0);
      check(
        'IMPL-0954:ok 決定の後に同じゲート欄(強調の揺れを除く)の記録があれば欠落を解く',
        probs([rec('価値責任者の調整', inside, 'adj-1.md'), rec('**価値責任者の調整**', '2099-01-01 10:00', 'adj-2.md')]) === 0
      );
      check(
        'IMPL-0954:ng 決定の後の記録が別のゲート欄(価値責任者の判断)なら欠落は解けない',
        probs([rec('価値責任者の調整', inside, 'adj-1.md'), rec('価値責任者の判断', '2099-01-01 10:00', 'adj-3.md')]) > 0
      );
      check(
        'IMPL-0954:ok(固定) G-4 は、決定の後の G-4 の記録で解け、無ければ欠落のまま',
        probs([rec('G-4 機能仕様承認', inside, 'g4-1.md'), rec('G-4', '2099-01-01 10:00', 'g4-2.md')]) === 0 && probs([rec('G-4 機能仕様承認', inside, 'g4-1.md')]) > 0
      );
      check('IMPL-0954:ng(固定) G-4 の欠落は、別のゲート(G-5)の記録し直しでは解けない', probs([rec('G-4 機能仕様承認', inside, 'g4-1.md'), rec('G-5', '2099-01-01 10:00', 'g5-2.md')]) > 0);
      // 入口(契約検査)でも同じ: 決定待ちの間の調整の記録は、決定の後の同じゲート欄の記録で解ける
      {
        const adjFile = (name, judgedAt) =>
          fs.writeFileSync(
            path.join(we.d, 'docs/gates', name),
            `# 価値責任者の調整\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | 価値責任者の調整 |\n| 対象 | 企画書 |\n| 判定者 | 山田 太郎 |\n| 判定日時 | ${judgedAt} |\n| 結果 | 通過 |\n| 参照した D-0 の版 | 1.0 |\n`
          );
        fs.rmSync(path.join(we.d, 'docs/gates/g1-test.md'), { force: true });
        adjFile('adj-in.md', inside);
        const pend = /決定待ちの間.*記載の欠落/;
        const before = we.contract();
        check('IMPL-0954:ng(入口) 決定待ちの間の調整の記録は、契約検査が記載の欠落として落とす', !before.ok && pend.test(before.out), before.out);
        adjFile('adj-after.md', '2099-01-01 10:00');
        const after = we.contract();
        check('IMPL-0954:ok(入口) 決定の後に同じゲート欄で記録し直せば、契約検査の欠落が解ける', !pend.test(after.out), after.out);
      }
    }
  } finally {
    fs.rmSync(we.d, { recursive: true, force: true });
  }
  const ws = workspace('pit-in-433s-');
  try {
    const fillS = ws.run({ summary: '体制', people: [P[0], P[1]], seats: seatsBy([0, 0, 0, 0, 1, 1, 0, 0, 1]), decidedBy: P[0].name, reason: '初期の設定' });
    // IMPL-0484:ng 既存の行の氏名とアカウントの両方を変える変更を、決定者の記名でも受け付けない
    const swap = ws.run({ summary: '差し替え', people: [P[0], { id: 'p2', name: '鈴木 一郎', accounts: [{ login: 'suzuki', id: 3003 }] }], seats: Object.fromEntries(SEAT_IDS.map((s, i) => [s, { accountable: [0, 0, 0, 0, 1, 1, 0, 0, 1][i] === 0 ? P[0].name : '鈴木 一郎' }])), decidedBy: P[0].name, reason: '試験' });
    check('IMPL-0484:ng 既存の行の氏名とアカウントの両方を変える変更を、決定者の記名でも受け付けない', fillS.ok && !swap.ok && /差し替えることはできません/.test(swap.out), `${fillS.out}\n${swap.out}`);
    // IMPL-0484:ok 氏名だけの変更は、同じ人の表記の変更として決定者の記名で受け付ける
    const nameOnly = ws.run({ summary: '氏名', people: [P[0], { ...P[1], name: '佐藤 花代' }], seats: Object.fromEntries(SEAT_IDS.map((s, i) => [s, { accountable: [0, 0, 0, 0, 1, 1, 0, 0, 1][i] === 0 ? P[0].name : '佐藤 花代' }])), decidedBy: P[0].name, reason: '改名' });
    check('IMPL-0484:ok 氏名だけの変更は、同じ人の表記の変更として決定者の記名で受け付ける', nameOnly.ok, nameOnly.out);
  } finally {
    fs.rmSync(ws.d, { recursive: true, force: true });
  }

  // 例外は行ごとに判定する(process-compass #432 再確認 Y-1)。2名・任命権者なしで、決定者の交代(例外に当たる行)と
  // 決定者本人の改名(もう1人が記名できる行)を束ねた変化点は受け付けず、分け方を案内する。分ければ通る
  const wy = workspace('pit-in-432y-');
  try {
    const twoSeats = (name0) => Object.fromEntries(SEAT_IDS.map((r, k) => [r, { accountable: [0, 0, 0, 0, 1, 0, 0, 0, 1][k] === 0 ? name0 : P[1].name }]));
    // 1人で記入し、2人目を足して独立レビュア・AI運用担当者に置く(記名 1人目=決定者)
    const fill0 = wy.run({ summary: '1人目', people: [P[0]], seats: Object.fromEntries(SEAT_IDS.map((r) => [r, { accountable: P[0].name }])), decidedBy: P[0].name, reason: '初期の設定' });
    const fill1 = fill0.ok ? wy.run({ summary: '2人目', people: [P[0], P[1]], seats: twoSeats(P[0].name), decidedBy: P[0].name, reason: '2人目' }) : fill0;
    const fill = fill1;
    const renamedA = { ...P[0], name: '山田 太朗' };
    const handover = (name0) => ({ ...twoSeats(name0), 'biz-approver': { accountable: P[1].name } });
    // IMPL-0483:ng 例外に当たらない行(本人の改名)を、例外に当たる行(交代)と束ねた変化点を、前任の記名で受け付けない
    const bundled = wy.run({ summary: '改名と交代', people: [renamedA, P[1]], seats: handover('山田 太朗'), decidedBy: P[0].name, reason: '試験' });
    check(
      'IMPL-0483:ng 決定者の交代と本人の改名を束ねた変化点を、前任の記名(自己の決定)では受け付けず、分け方を案内する',
      fill.ok && !bundled.ok && /例外は行ごとに判定します/.test(bundled.out) && wy.cfg().changeLog.at(-1).selfDecided !== true,
      `${fill.out}\n${bundled.out}`
    );
    // IMPL-0483:ok 分ければ通る。先に改名をもう1人の記名で、その後で交代を前任の記名(自己の決定)で出す
    const rename = wy.run({ summary: '改名', people: [renamedA, P[1]], seats: twoSeats('山田 太朗'), decidedBy: P[1].name, reason: '改名' });
    const swap = wy.run({ summary: '交代', people: [renamedA, P[1]], seats: handover('山田 太朗'), decidedBy: '山田 太朗', reason: '交代' });
    check(
      'IMPL-0483:ok 分ければ、改名はもう1人の記名で、交代は前任の記名(自己の決定)で受け付ける',
      rename.ok && wy.cfg().changeLog.at(-2).selfDecided !== true && swap.ok && wy.cfg().changeLog.at(-1).selfDecided === true,
      `${rename.out}\n${swap.out}`
    );
  } finally {
    fs.rmSync(wy.d, { recursive: true, force: true });
  }

  // 1名の体制の自己の任命(第3章 3.13.3 の例外。process-compass #359 / IMPL-0342)。前任の決定者(1人目)が体制から外れ、後継(2人目)が
  // 全席に就く。D-0 節11 の選択の欄「体制の法的な形態(自己の任命の例外)」が「個人事業主」か「1名で代表権を持つ法人」と完全に一致する体制に限り、
  // 新任の記名を自己の任命として受け付ける。自由な文(決裁の権限の出所)の中身では受け付けない(確認 第3巡への裁定 高-2)
  const setForm = (d0p, v) => fs.writeFileSync(d0p, fs.readFileSync(d0p, 'utf8').replace(/^(\| 体制の法的な形態\(自己の任命の例外\) \|)[^\n]*\|\s*$/m, `$1 ${v} |`));
  const wz = workspace('pit-in-359z-');
  try {
    const d0p = path.join(wz.d, 'docs/D-0-governance.md');
    const fill = wz.run({ summary: '1人目', people: [P[0]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '初期の設定' });
    const succession = { summary: '事業の承継', people: [P[1]], seats: seatsBy([1, 1, 1, 1, 1, 1, 1, 1, 1]), decidedBy: P[1].name, reason: '前任が退いたため承継する' };
    // IMPL-0342:ng 選択の欄が様式のまま(#359 より前の D-0 と同じく値が無い)なら、決裁の権限の出所に「個人事業主本人」と書いてあっても受け付けない
    const before = wz.raw();
    const noForm = wz.run(succession);
    check(
      'IMPL-0342:ng 選択の欄に値が無ければ、自由な文に個人事業主と書いてあっても新任の決定者の自己の任命を受け付けず、欄を書く案内を出す',
      fill.ok && !noForm.ok && /新任の決定者が、自分の任命を自分の記名で確定することはできません/.test(noForm.out) && /体制の法的な形態\(自己の任命の例外\)/.test(noForm.out) && /#359 より前の D-0 にはこの欄が無い/.test(noForm.out) && wz.raw() === before,
      `${fill.out}\n${noForm.out}`
    );
    // IMPL-0342:ng 選択の欄が一致しても、決裁の権限の出所が様式のまま・「—」なら受け付けない(確認 第4巡への裁定 高-1)
    setForm(d0p, '個人事業主');
    const formRow = fs.readFileSync(path.join(wz.d, 'templates/00-d0-governance.md'), 'utf8').match(/^\| 決裁の権限の出所 \|[^\n]*\|\s*$/m)[0];
    const setSourceRow = (row) => fs.writeFileSync(d0p, fs.readFileSync(d0p, 'utf8').replace(/^\| 決裁の権限の出所 \|[^\n]*\|\s*$/m, row));
    for (const [label, row] of [['様式のまま', formRow], ['様式の文から山括弧を外したもの', formRow.replace('| <', '| ').replace(/> \|\s*$/, ' |')], ['—', '| 決裁の権限の出所 | — |']]) {
      setSourceRow(row);
      const r = wz.run(succession);
      check(`IMPL-0342:ng 選択の欄が一致しても、決裁の権限の出所が${label}なら新任の自己の任命を受け付けない`, !r.ok && wz.raw() === before, r.out);
    }
    setSourceRow('| 決裁の権限の出所 | 個人事業主本人(開業届 2020-04-01。試験) |');
    // IMPL-0342:ng 名簿に組織上の任命権者がいれば、例外に当たらない(任命権者の記名による)
    const withOrg = wz.run({ ...succession, people: [P[1], ORG] });
    check('IMPL-0342:ng 名簿に組織上の任命権者がいれば、新任の自己の任命を受け付けない', !withOrg.ok && wz.raw() === before, withOrg.out);
    // IMPL-0342:ok 選択の欄が「個人事業主」の1名の体制の承継は、新任の記名を自己の任命として受け付け、変化点の記録に残す
    const ok = wz.run(succession);
    const e = wz.cfg().changeLog.at(-1);
    check(
      'IMPL-0342:ok 選択の欄が「個人事業主」の1名の体制の承継は、新任の決定者の記名を自己の任命として受け付け、selfAppointed を残す',
      ok.ok && e.selfAppointed === true && e.decidedBy === P[1].name && e.selfAppointedNoExternalRef !== true,
      `${ok.out}\n${JSON.stringify(e)}`
    );
  } finally {
    fs.rmSync(wz.d, { recursive: true, force: true });
  }
  // IMPL-0342:ng 変化点の前の名簿に本人と前任以外の体制の内の人がいれば、同じ変化点で外しても自己の任命を受け付けない(#359 重の実装の突合 中-2)
  const wo = workspace('pit-in-359o-');
  try {
    const d0p = path.join(wo.d, 'docs/D-0-governance.md');
    setForm(d0p, '個人事業主');
    const fill1 = wo.run({ summary: '1人目', people: [P[0]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '初期の設定' });
    const add2 = wo.run({ summary: '2人目', people: [P[0], P[2]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '2人目を名簿へ足す' });
    const fill2 = { ok: fill1.ok && add2.ok && wo.cfg().people.length === 2, out: `${fill1.out}\n${add2.out}` };
    const before = wo.raw();
    const sweep = wo.run({ summary: '全員を外して承継', people: [P[1]], seats: seatsBy([1, 1, 1, 1, 1, 1, 1, 1, 1]), decidedBy: P[1].name, reason: '承継' });
    check(
      'IMPL-0342:ng 前の名簿に本人と前任以外の体制の内の人がいれば、同じ変化点で外しても新任の自己の任命を受け付けない',
      fill2.ok && !sweep.ok && /新任の決定者が、自分の任命を自分の記名で確定することはできません/.test(sweep.out) && wo.raw() === before,
      `${fill2.out}\n${sweep.out}`
    );
  } finally {
    fs.rmSync(wo.d, { recursive: true, force: true });
  }
  // 確認 第3巡への裁定 高-2: 選択の欄の値の完全一致だけを見る。自由な文と、欄の値の言い換え・否定・付け足しは受け付けない
  {
    const form = (choice, source = '個人事業主本人') => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-359f-'));
      try {
        fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(d, 'docs/D-0-governance.md'), `| 決裁の権限の出所 | ${source} |\n| 体制の法的な形態(自己の任命の例外) | ${choice} |\n`);
        return authoritySourceForm(d).form;
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
      }
    };
    check('IMPL-0342:ok 選択の欄の「個人事業主」「1名で代表権を持つ法人」をそのまま読む', form('個人事業主') === 'sole' && form('1名で代表権を持つ法人') === 'corp');
    check('IMPL-0342:ng 決裁の権限の出所が様式の文のときは記入とみなさず、外部の記録の言及も探さない', (() => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-359f-'));
      try {
        fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
        fs.mkdirSync(path.join(d, 'templates'), { recursive: true });
        const form = fs.readFileSync(path.join(ROOT, 'templates/00-d0-governance.md'), 'utf8');
        fs.writeFileSync(path.join(d, 'templates/00-d0-governance.md'), form);
        const row = form.match(/^\| 決裁の権限の出所 \|[^\n]*\|\s*$/m)[0];
        fs.writeFileSync(path.join(d, 'docs/D-0-governance.md'), `${row}\n| 体制の法的な形態(自己の任命の例外) | 1名で代表権を持つ法人 |\n`);
        const a = authoritySourceForm(d);
        return a.form === 'corp' && a.filled === false && a.externalRef === false;
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
      }
    })());
    const ngChoices = ['個人事業主ではない', '個人事業主本人', '1名で代表権を持つ法人(他に代表権を持つ者はいない)', '代表権を持たない1名の担当者', '該当なし', '<自己の任命の例外を使う体制だけ>', ''];
    check('IMPL-0342:ng 選択の欄の値が2つの語と完全に一致しなければ、言い換え・否定・付け足し・空欄を法的な形態として読まない', ngChoices.every((v) => form(v) === null), JSON.stringify(ngChoices.map((v) => [v, form(v)])));
    check('IMPL-0342:ng 自由な文(決裁の権限の出所)の中身では読まない(選択の欄が無ければ、出所に「1名で代表権を持つ法人」と書いてあっても読まない)', (() => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-359f-'));
      try {
        fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(d, 'docs/D-0-governance.md'), '| 決裁の権限の出所 | 1名で代表権を持つ法人 |\n');
        return authoritySourceForm(d).form === null;
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
      }
    })());
  }
  // 法人で外部の記録(登記・議事録)への言及が無ければ、受け付けたうえで記録に残す(保証の開示の項目7 に「外部の記録の所在なし」)
  const wq = workspace('pit-in-359c-');
  try {
    const d0p = path.join(wq.d, 'docs/D-0-governance.md');
    setForm(d0p, '1名で代表権を持つ法人');
    fs.writeFileSync(d0p, fs.readFileSync(d0p, 'utf8').replace(/^(\| 決裁の権限の出所 \|)[^\n]*\|\s*$/m, '$1 代表取締役の決裁(試験) |'));
    wq.run({ summary: '1人目', people: [P[0]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '初期の設定' });
    const ok = wq.run({ summary: '代表の交代', people: [P[1]], seats: seatsBy([1, 1, 1, 1, 1, 1, 1, 1, 1]), decidedBy: P[1].name, reason: '前任の代表が退任した' });
    const e = wq.cfg().changeLog.at(-1);
    check('IMPL-0342:ok 1名で代表権を持つ法人で外部の記録への言及が無ければ、受け付けて selfAppointedNoExternalRef を残す', ok.ok && e.selfAppointed === true && e.selfAppointedNoExternalRef === true, `${ok.out}\n${JSON.stringify(e)}`);
  } finally {
    fs.rmSync(wq.d, { recursive: true, force: true });
  }

  // IMPL-0513:ok 受託・委託の構成の席の任免は、表1 の決定者に限らず、名簿の自然人の記名を受け付ける(誰が任命の権限を持つかは確かめない)。
  // 決定者その人を替える行は、従来どおり前任の決定者の記名を要する
  for (const [form, expectOk] of [['inhouse', false], ['vendor', true], ['outsourcer', true]]) {
    const wo = workspace('pit-in-357-', { ...answers, 'q-dev-form': form });
    try {
      wo.run({ summary: '1人目', people: [P[0]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '初期の設定' });
      const f0 = wo.run({ summary: '2人目を置く', people: [P[0], P[1]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 1]), decidedBy: P[0].name, reason: '2人目を置く' });
      check(`IMPL-0513: ${form} の前提の記入を受け付ける`, f0.ok, f0.out);
      const r = wo.run({ summary: '技術判断者の任命', people: [P[0], P[1]], seats: seatsBy([0, 0, 1, 0, 0, 0, 0, 0, 1]), decidedBy: P[1].name, reason: '受注側の任命の権限を持つ者が決定した' });
      check(`IMPL-0513:${expectOk ? 'ok' : 'ng'} ${form} の構成で、表1 の決定者以外の名簿の人の記名による席の任免を${expectOk ? '受け付ける' : '拒否する'}`, r.ok === expectOk, r.out);
      const dr = wo.run({ summary: '決定者の交代', people: [P[0], P[1]], seats: seatsBy([1, 0, 0, 0, 0, 0, 0, 0, 1]), decidedBy: P[1].name, reason: '決定者を交代する' });
      check(`IMPL-0513:ng ${form} の構成でも、決定者その人を替える行は新任の記名では受け付けない`, !dr.ok, dr.out);
    } finally {
      fs.rmSync(wo.d, { recursive: true, force: true });
    }
  }

  // IMPL-0513:ng(第2巡 中①)内製の構成から受託へ切り替える答えと席の任命を同じ変化点で出しても、表1 の決定者以外の記名では受け付けない
  {
    const ws = workspace('pit-in-357s-', { ...answers, 'q-dev-form': 'inhouse' });
    try {
      ws.run({ summary: '1人目', people: [P[0]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '初期の設定' });
      ws.run({ summary: '2人目を置く', people: [P[0], P[1]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 1]), decidedBy: P[0].name, reason: '2人目を置く' });
      const sw = ws.run({ summary: '受託へ切り替えと任命', answers: { 'q-dev-form': 'vendor' }, people: [P[0], P[1]], seats: seatsBy([0, 0, 1, 0, 0, 0, 0, 0, 1]), decidedBy: P[1].name, reason: '切り替えと任命を束ねた' });
      check('IMPL-0513:ng 内製から受託への切り替えと任命を束ねた変化点を、表1 の決定者以外の記名では受け付けない', !sw.ok, sw.out);
    } finally {
      fs.rmSync(ws.d, { recursive: true, force: true });
    }
  }
  // IMPL-0513:ng(第2巡 中②)受託・委託の構成でも、任命権者でない外部の確認者の記名では席の任免を受け付けない
  {
    const XE = { id: 'x', name: '高橋 次郎', external: true, accounts: [{ login: 'takahashi', id: 3009 }] };
    const we = workspace('pit-in-357e-', { ...answers, 'q-dev-form': 'vendor' });
    try {
      we.run({ summary: '1人目', people: [P[0]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 0]), decidedBy: P[0].name, reason: '初期の設定' });
      we.run({ summary: '2人目を置く', people: [P[0], P[1]], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 1]), decidedBy: P[0].name, reason: '2人目を置く' });
      we.run({ summary: '外部の確認者を足す', people: [P[0], P[1], XE], seats: seatsBy([0, 0, 0, 0, 0, 0, 0, 0, 1]), decidedBy: P[0].name, reason: '外部の確認者を足す' });
      const er = we.run({ summary: '技術判断者の任命', people: [P[0], P[1], XE], seats: seatsBy([0, 0, 1, 0, 0, 0, 0, 0, 1]), decidedBy: XE.name, reason: '外部の確認者が決定した' });
      check('IMPL-0513:ng 任命権者でない外部の確認者の記名による席の任免を、受託の構成でも拒否する', !er.ok, er.out);
    } finally {
      fs.rmSync(we.d, { recursive: true, force: true });
    }
  }
}

if (failures) {
  console.error(`\n緩める向きの決定者の入口の試験: ${failures} 件の失敗`);
  process.exit(1);
}
console.log('\n緩める向きの決定者の入口の試験: すべて通過');
