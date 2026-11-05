// 氏名の確認(nameConfirmed)と、確認した氏名の使用(任命・委任の席・適合性確認の承認)を同じ変化点に含むときの、
// 評価の時点の試験(標準 第4章 G-6。process-compass #375 / ADR-0111。IMPL-0446)。
//
//   node scripts/gate/test-name-confirmation-timing.mjs
//
// 固定する決定:
//   - 名簿へ足すのと同じ変化点で、本人以外の名簿の人が記名した氏名の確認を、その変化点の任命の判定に数える。
//     変化点の記録の nameOverrides と出力の [上書き] も、同じ記録から作る(ADR-0111 決定1・2。IMPL-0446:ok)
//   - 確認の記名者の資格は、変化点の前の構成で照らす(類B)。本人・AI の名義・名簿に無い人・記名なし・AI を示す語を含む名義どうしの
//     確認・同じ変化点で名簿へ足した人による確認は、同じ変化点でも数えず、拒否する(ADR-0111 決定2。IMPL-0446:ng)
//   - 委任の席(clampSeats)の責任者の名義は、変化点の記録を足した後の構成で照らす。前の変化点・同じ変化点の確認のどちらでも
//     委任の席に置ける。記名なしでは、委任の席は緩まない(ADR-0111 決定3)
//   - 確認の記名者の資格の例外は、第3章 3.13.3 の初回の記入に限る(追加の裁定 AR-1)。外部の人だけが前の名簿にいる初回でない変化点では数えない
//   - 1名の体制に2人目を足す変化点は、本人の自己申告を確認待ちとして受け付け、確認待ちのままでは契約検査と集約が欠落として扱い、
//     次の変化点で本人以外が確認すれば解ける(追加の裁定 AR-2)
// 一時の置き場で試し、GitHub へ問い合わせません。日付は過去(2026-10-01)に固定します。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sealChangeLog, configIntegrityProblems } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-12).join('\n       ')}`}`);
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

const DAY = '2026-10-01';
const answers = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9', 'q-biz-phase': 'mvp',
};
const PEOPLE3 = [
  { id: 'yamada', name: '山田 太郎', accounts: [{ login: 'yamada-taro', id: 4001 }] },
  { id: 'sato', name: '佐藤 花子', accounts: [{ login: 'sato-hanako', id: 4002 }] },
  { id: 'suzuki', name: '鈴木 一郎', accounts: [{ login: 'suzuki-ichiro', id: 4003 }] },
  { id: 'org', name: '組織 任命者', external: true, appointer: true },
];
const SEATS3 = {
  'biz-approver': { accountable: '山田 太郎' },
  'value-owner': { accountable: '山田 太郎' },
  'tech-lead': { accountable: '山田 太郎' },
  'dev-verifier': { accountable: '山田 太郎' },
  'independent-reviewer': { accountable: '佐藤 花子' },
  'qa-gatekeeper': { accountable: '鈴木 一郎' },
  'context-owner': { accountable: '山田 太郎' },
  'ai-maintainer': { accountable: '山田 太郎' },
  'ai-ops': { accountable: '鈴木 一郎' },
};
const DUPONT = { id: 'dupont', name: 'Claude Dupont', accounts: [{ login: 'cdupont', id: 4011 }], nameConfirmed: true };
const GEMINI = { id: 'gsato', name: 'Gemini Sato', accounts: [{ login: 'gsato', id: 4012 }], nameConfirmed: true };
const TAKAHASHI = { id: 'takahashi', name: '高橋 次郎', accounts: [{ login: 'takahashi-jiro', id: 4013 }] };
const P = { model: 'claude-fable-5-1', instructions: 'CLAUDE.md@v1', permissions: 'tok-dev' };
const Q = (approvedBy) => ({ confirmedAt: '2026-09-30', performedBy: '山田 太郎', approvedBy, cases: '注入事例10件', result: '9/10', performer: P });
const BASIS = {
  detection: { rejectionRate: 'docs/metrics/q3.md(差し戻しの件数から算出)', reworkRate: 'docs/metrics/q3.md(14日以内の書き換えの行数から算出)' },
  rollback: 'docs/rollback/2026-09.md(文言の取り消しを3回実行)',
  tests: 'tests/i18n/*.spec.ts が全キーの表示を確かめる',
};
const TYPES = [{ id: '表示文言', registeredBy: '鈴木 一郎', registeredAt: '2026-09-30', basis: BASIS }];
const RULE = { id: 'DR-001', seat: 'dev-verifier', changeType: '表示文言', paths: ['src/i18n/**'], decidedBy: '山田 太郎', decidedAt: '2026-09-30', reason: '文言のレビュー待ちを無くす' };
const DELEGATE = { mode: 'delegated', performer: P, fallback: 'human', qualification: Q('Claude Dupont') };

const blank = quiet(() => buildConfig(answers, { generatedAt: '2026-10-01T09:00:00+09:00', d0Version: null }).config);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-375-'));
try {
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
  const cfgPath = path.join(dir, 'process.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(blank), null, 2) + '\n');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'templates/00-d0-governance.md'), path.join(dir, 'docs/D-0-governance.md'));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: init');
  git('tag', 'blank');
  const run = (obj) => {
    fs.writeFileSync(path.join(dir, 'change.json'), JSON.stringify({ kind: 'accountable', date: DAY, ...obj }));
    const r = spawnSync(process.execPath, ['scripts/init/generate-profile.mjs', '--change', 'change.json'], { cwd: dir, encoding: 'utf8', env });
    fs.rmSync(path.join(dir, 'change.json'), { force: true });
    if (r.status === 0) {
      git('add', '-A');
      git('commit', '-q', '-m', 'chore: change');
    }
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const cfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const raw = () => fs.readFileSync(cfgPath, 'utf8');
  const contract = () => {
    const r = spawnSync(process.execPath, ['scripts/gate/verify-gate-contract.mjs'], { cwd: dir, encoding: 'utf8', env });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const resetTo = (tag) => {
    git('reset', '-q', '--hard', tag);
    git('clean', '-qfd');
  };
  const seatOf = (role) => cfg().seats.find((s) => s.role === role);

  const filled = run({ summary: '3名体制', people: PEOPLE3, seats: SEATS3, decidedBy: '山田 太郎', reason: '初期の体制を記入する' });
  check('前提: 3名体制の初回の記入を受け付ける', filled.ok, filled.out);
  git('tag', 'base3');

  // 根の場面: 同じ変化点で名簿へ足して確認し、技術判断者へ任命する(記名は本人以外の、前から名簿にいる山田)
  const appoint = (o = {}) => ({ summary: 'Dupont が加わった', people: [...PEOPLE3, DUPONT], seats: { 'tech-lead': { accountable: 'Claude Dupont' } }, decidedBy: '山田 太郎', reason: '技術判断者を任命', ...o });

  // IMPL-0446:ok 同じ変化点の確認を、その変化点の任命の判定に数え、記録と表示を同じ記録から作る
  resetTo('base3');
  const same = run(appoint());
  const last = same.ok ? cfg().changeLog.at(-1) : {};
  const k = same.ok ? contract() : { out: '' };
  check(
    'IMPL-0446:ok 名簿へ足すのと同じ変化点で本人以外が記名した氏名の確認を数え、その人を席の責任者に任命できる。記録の nameOverrides と出力の [上書き] も同じ記録から出る',
    same.ok &&
      seatOf('tech-lead').accountable === 'Claude Dupont' &&
      JSON.stringify(last.nameConfirmations) === JSON.stringify([{ id: 'dupont' }]) &&
      last.decidedBy === '山田 太郎' &&
      (last.nameOverrides ?? []).includes('Claude Dupont') &&
      same.out.includes('[上書き] 名義の機械検査を人が上書きした: Claude Dupont') &&
      // 契約検査は一時の置き場のアダプタ・CODEOWNERS の未記入で落ちるため、名義と記名の行だけを見る
      k.out.includes('::warning::名義の機械検査を人が上書きした: Claude Dupont') &&
      !/::error::.*(nameConfirmed|Dupont|記名)/.test(k.out),
    `${same.out}\n----\n${k.out}\n${JSON.stringify(last)}`
  );

  // 分けた経路(確認だけの変化点)でも、確認した変化点の記録の nameOverrides と [上書き] が、その確認を数える
  resetTo('base3');
  const onlyConfirm = run({ summary: 'Dupont が加わった', people: [...PEOPLE3, DUPONT], decidedBy: '山田 太郎', reason: '氏名を確認した' });
  check(
    '確認だけの変化点の記録の nameOverrides と出力の [上書き] が、その変化点の確認を数える',
    onlyConfirm.ok && (cfg().changeLog.at(-1).nameOverrides ?? []).includes('Claude Dupont') && onlyConfirm.out.includes('[上書き] 名義の機械検査を人が上書きした: Claude Dupont'),
    onlyConfirm.out
  );

  // IMPL-0446:ng 確認の記名者の要件を満たさない確認は、同じ変化点でも数えず、拒否する(構成を書き換えない)
  const refusedCase = (label, input, pattern) => {
    resetTo('base3');
    const before = raw();
    const r = run(input);
    check(`IMPL-0446:ng ${label}`, !r.ok && pattern.test(r.out) && raw() === before, r.out);
  };
  const blocked = /記名を受け付けられません: 技術判断者\(Tech Lead\) の責任者: "Claude Dupont"/;
  refusedCase('本人の記名による確認は数えず、任命を拒否する', appoint({ decidedBy: 'Claude Dupont' }), /Claude Dupont の氏名の確認を、本人の記名では確定できません/);
  refusedCase('AI の名義の記名による確認は数えず、任命を拒否する', appoint({ decidedBy: 'Claude Fable 5.1' }), /氏名の確認の記名を受け付けられません: "Claude Fable 5\.1"/);
  refusedCase('名簿に無い人の記名による確認は数えず、任命を拒否する', appoint({ decidedBy: '田中 三郎' }), /氏名の確認の記名を受け付けられません: "田中 三郎" は人の名簿\(people\[\]\)にない/);
  refusedCase('記名なしの確認は数えず、任命を拒否する', appoint({ decidedBy: undefined, reason: undefined }), /氏名の確認\(Claude Dupont\)を含みます。決定した者の記名\(decidedBy\)と理由\(reason\)が要ります/);
  {
    resetTo('base3');
    const before = raw();
    const r = run(appoint({ people: [...PEOPLE3, DUPONT, GEMINI], decidedBy: 'Gemini Sato' }));
    check(
      'IMPL-0446:ng AI を示す語を含む名義どうしの相互の確認は数えず、任命を拒否する',
      !r.ok && blocked.test(r.out) && /Gemini Sato の氏名の確認を、本人の記名では確定できません/.test(r.out) && raw() === before,
      r.out
    );
  }
  {
    resetTo('base3');
    const before = raw();
    const r = run({ summary: '高橋と Dupont が加わった', people: [...PEOPLE3, TAKAHASHI, DUPONT], decidedBy: '高橋 次郎', reason: '氏名を確認した' });
    check(
      'IMPL-0446:ng 同じ変化点で名簿へ足した人による確認は数えず、拒否する(記名者の資格は変化点の前の構成で照らす)',
      !r.ok && /記名者 "高橋 次郎" は、この変化点で名簿へ足した人です/.test(r.out) && raw() === before,
      r.out
    );
  }
  // 拒否の文は原因ごとに分け、同じ変化点で確認できることと記名者の要件を案内する
  {
    resetTo('base3');
    const r = run(appoint({ decidedBy: 'Claude Dupont' }));
    check(
      '拒否の文: 確認の旨に有効な記録が無い原因を示し、記名者の要件と、同じ変化点で確認できることを案内する',
      /名簿の nameConfirmed: true に、確認される本人以外が記名した変化点の記録が無い/.test(r.out) && /その変化点より前から名簿にいる人/.test(r.out) && /同じ変化点で出せる/.test(r.out),
      r.out
    );
    const n = run({ summary: 'Dupont', people: [...PEOPLE3, { ...DUPONT, nameConfirmed: undefined }], seats: { 'tech-lead': { accountable: 'Claude Dupont' } }, decidedBy: '山田 太郎', reason: '任命' });
    check('拒否の文: 確認の旨が無い原因では、nameConfirmed: true を書く手順を案内する', !n.ok && /名簿の該当者へ nameConfirmed: true を書く/.test(n.out), n.out);
  }

  // 委任の席(clampSeats): 前の変化点で確認した人を、委任の席の責任者に置ける
  resetTo('base3');
  const c1 = run({ summary: 'Dupont が加わった', people: [...PEOPLE3, DUPONT], seats: { 'dev-verifier': { accountable: 'Claude Dupont' } }, decidedBy: '山田 太郎', reason: '開発者(検証者)を任命' });
  git('tag', 'dupont-dev');
  const c2 = run({ kind: 'mode', summary: '委任', seats: { 'dev-verifier': DELEGATE }, delegation: { rules: [RULE], changeTypes: TYPES }, ruleApprovedBy: '山田 太郎', decidedBy: 'Claude Dupont', reason: '委任する' });
  check(
    '委任の席: 前の変化点で本人以外が確認した人を責任者とする席を、委任にできる(clampSeats が変化点の記録を読む)',
    c1.ok && c2.ok && seatOf('dev-verifier').mode === 'delegated',
    `${c1.out}\n----\n${c2.out}`
  );
  // 同じ変化点で確認し、委任の席の責任者・適合性確認の承認者に置ける
  resetTo('base3');
  const c3 = run({
    summary: 'Dupont が加わった',
    people: [...PEOPLE3, DUPONT],
    seats: { 'dev-verifier': { accountable: 'Claude Dupont', ...DELEGATE } },
    delegation: { rules: [RULE], changeTypes: TYPES },
    ruleApprovedBy: '山田 太郎',
    decidedBy: '山田 太郎',
    reason: '開発者(検証者)を任命し委任する',
  });
  check('委任の席: 同じ変化点で確認した人を、委任の席の責任者と適合性確認の承認者に置ける', c3.ok && seatOf('dev-verifier').mode === 'delegated', c3.out);

  // 委任の席は、記名なしには緩まない
  resetTo('dupont-dev');
  {
    const before = raw();
    const r = run({ kind: 'mode', summary: '委任', seats: { 'dev-verifier': DELEGATE }, delegation: { rules: [RULE], changeTypes: TYPES }, ruleApprovedBy: '山田 太郎' });
    check('委任の席: 記名と理由の無い委任の宣言は受け付けず、席を緩めない', !r.ok && raw() === before && seatOf('dev-verifier').mode !== 'delegated', r.out);
  }
  // 委任の宣言が規則の承認待ちで協働に留まった席は、記名の無い後の変化点で委任へ変わらない(突合 X-6)
  resetTo('dupont-dev');
  {
    const held = run({ kind: 'mode', summary: '委任(規則は承認待ち)', seats: { 'dev-verifier': DELEGATE }, delegation: { rules: [RULE], changeTypes: TYPES }, decidedBy: 'Claude Dupont', reason: '委任する' });
    const heldSeat = seatOf('dev-verifier');
    check('委任の席: 規則の承認待ちの委任の宣言は受け付け、席は協働に留まる(宣言を保持する)', held.ok && heldSeat.mode !== 'delegated' && heldSeat.intent?.mode === 'delegated', `${held.out}\n${JSON.stringify(heldSeat)}`);
    const unsigned = run({ summary: '鈴木の所属', people: [PEOPLE3[0], PEOPLE3[1], { ...PEOPLE3[2], team: '品質' }, PEOPLE3[3], DUPONT] });
    check('委任の席: 留まった席は、記名の無い後の変化点(規則の承認を含まない)を受け付けても委任へ変わらない', unsigned.ok && seatOf('dev-verifier').mode !== 'delegated', unsigned.out);
  }

  // 初回の記入の例外(追加の裁定 AR-1)。どの席にも責任者が記入されたことのない状態から、D-0 表1 の決定者の席に記入する人が記名する
  // 変化点では、確認の記名者をその変化点の名簿で照らす。自己確認の経路は開かない
  {
    resetTo('blank');
    const r = run({ summary: '3名と Dupont', people: [...PEOPLE3, DUPONT], seats: SEATS3, decidedBy: '山田 太郎', reason: '初期の体制を記入する' });
    const st = r.ok ? cfg().changeLog.at(-1) : {};
    check('初回の記入: 同じ変化点で記入する決定者の記名で、Dupont の氏名の確認を数える', r.ok && JSON.stringify(st.nameConfirmations) === JSON.stringify([{ id: 'dupont' }]) && (st.nameOverrides ?? []).includes('Claude Dupont'), r.out);
    resetTo('blank');
    const self = run({ summary: '3名と Dupont', people: [...PEOPLE3, DUPONT], seats: { ...SEATS3, 'biz-approver': { accountable: 'Claude Dupont' } }, decidedBy: 'Claude Dupont', reason: '初期の体制を記入する' });
    check('初回の記入: 2名以上の名簿で本人の記名による確認は、初回でも拒否する', !self.ok && /Claude Dupont の氏名の確認を、本人の記名では確定できません/.test(self.out), self.out);
    resetTo('blank');
    const mutual = run({ summary: '3名と2名', people: [...PEOPLE3, DUPONT, GEMINI], seats: { ...SEATS3, 'biz-approver': { accountable: 'Gemini Sato' } }, decidedBy: 'Gemini Sato', reason: '初期の体制を記入する' });
    check('初回の記入: AI を示す語を含む名義どうしの確認は、初回でも拒否する', !mutual.ok && /Gemini Sato の氏名の確認を、本人の記名では確定できません/.test(mutual.out), mutual.out);
    // 境界: 外部の人だけが前の名簿にいる、初回の記入でない変化点(席を記入しない)では、同じ変化点で足した人の確認を数えない
    resetTo('blank');
    const org = run({ summary: '任命権者', people: [PEOPLE3[3]] });
    const before = raw();
    const add = run({ summary: '高橋と Dupont', people: [PEOPLE3[3], TAKAHASHI, DUPONT], decidedBy: '高橋 次郎', reason: '氏名を確認した' });
    check('初回の記入の境界: 外部の人だけが前の名簿にいる変化点で、同じ変化点で足した人の確認を数えず拒否する', org.ok && !add.ok && /記名者 "高橋 次郎" は、この変化点で名簿へ足した人です/.test(add.out) && raw() === before, `${org.out}\n----\n${add.out}`);
  }

  // 確認待ち(追加の裁定 AR-2)。1名の体制(AI を示す語を含む氏名の本人の自己申告)に2人目を足す変化点は、確認待ちとして受け付ける。
  // 確認待ちのままでは契約検査が欠落として落とし、次の変化点で本人以外が確認すれば落ちない
  {
    resetTo('blank');
    const answers12 = { ...answers, 'q-team-size': 'size-1-2', 'q-external-reviewer': 'reviewer-yes' };
    const blank12 = quiet(() => buildConfig(answers12, { generatedAt: '2026-10-01T09:00:00+09:00', d0Version: null }).config);
    fs.writeFileSync(cfgPath, JSON.stringify(sealChangeLog(blank12), null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: init 1-2');
    const all = (n) => Object.fromEntries(Object.keys(SEATS3).map((k) => [k, { accountable: n }]));
    const solo = run({ summary: '1名', people: [DUPONT], seats: all('Claude Dupont'), decidedBy: 'Claude Dupont', reason: '初期の体制を記入する' });
    check('確認待ちの前提: 1名の体制の本人の記名による確認(自己申告)を受け付ける', solo.ok, solo.out);
    const two = run({ summary: '高橋が加わった', people: [DUPONT, TAKAHASHI], seats: { 'independent-reviewer': { accountable: '高橋 次郎' } }, decidedBy: 'Claude Dupont', reason: '確認者を置く' });
    const c2 = cfg();
    const k2 = contract();
    check(
      'AR-2: 1名から2名へ移る変化点を、本人の自己申告を確認待ちとして受け付け、確認待ちと次の手順を案内する。構成へ確認待ちの印を書かない',
      two.ok && /\[確認待ち\] Claude Dupont の氏名の確認/.test(two.out) && /本人以外の名簿の人/.test(two.out) && c2.nameConfirmPending === undefined && !JSON.stringify(c2.changeLog.at(-1)).includes('nameConfirmPending'),
      two.out
    );
    check('AR-2: 確認待ちのままでは、契約検査が欠落として落とす', !k2.ok && /Claude Dupont の氏名の確認\(nameConfirmed\)は確認待ちです/.test(k2.out), k2.out);
    check('AR-2: 確認待ちのままでは、出荷の証跡の集約の構成の検査(configIntegrityProblems)が欠落として出す', configIntegrityProblems(c2).some((p) => /Claude Dupont の氏名の確認\(nameConfirmed\)は確認待ちです/.test(p)));
    const conf = run({ summary: 'Dupont の氏名を確認', people: [DUPONT, TAKAHASHI], decidedBy: '高橋 次郎', reason: '氏名を確認した' });
    const k3 = contract();
    check(
      'AR-2: 次の変化点で本人以外(足した2人目)が確認すれば、確認待ちが解け、契約検査の名義の行が落ちない',
      conf.ok && JSON.stringify(cfg().changeLog.at(-1).nameConfirmations) === JSON.stringify([{ id: 'dupont' }]) && !/確認待ち/.test(k3.out) && !/::error::.*(nameConfirmed|Dupont|記名)/.test(k3.out),
      `${conf.out}\n----\n${k3.out}`
    );
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n氏名の確認の評価の時点の試験: ${failures} 件の失敗`);
  process.exit(1);
}
console.log('\n氏名の確認の評価の時点の試験: すべて通過');
