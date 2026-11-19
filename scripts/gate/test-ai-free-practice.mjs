// 第5章 5.4.7「AI を用いない実施」の機会の確保の表示(保証の開示の項目7)を試験する
// (process-compass #447 の IMPL-1021・IMPL-1022。IMPL-0978 の降ろし先の合成)。
//
//   node scripts/gate/test-ai-free-practice.mjs
//
// 固定する決定(ADR-0179 決定1〜4、束 B19 の議長の裁定):
//   - 範囲(L2 以上を適用する範囲)は、D-0 の「AI自律レベルの適用」の表が L3 と書く変更種別。表と判定は同じ導き方(l3ScopeIds)を使う
//   - 層1 の頻度は白名簿の全体一致だけを読む。1期間に2回以上・幅・0・自由文は読めない値として空欄と同じに扱い、値を併記する
//   - 数える行 = 実在の日で基準日以前・対象領域が範囲の名と一致・実施者が人の名簿の人だけ(AI の名義を含めない)
//   - 頻度を過ぎる日は月末を繰り越さない(2026-01-31 + 1か月 = 2026-02-28)
//   - 表示は止めない(記載の欠落にも組織継続の側の状態にも入れない)。実施者の名は出さない
// GitHub へ問い合わせません。リポジトリの状態を変えません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { l3ScopeIds } from './autonomy.mjs';
import { aiFreePracticeState, aiFreePracticeTexts, parsePracticeInterval, practiceDue, intervalEnd, readPolicy } from './org-assurance.mjs';
import { buildConfig, renderAutonomyTable } from '../init/generate-profile.mjs';

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

// ---------------------------------------------------------------- 構成と D-0 の置き場
const PEOPLE = [
  { id: 'p0', name: '名簿 甲', accounts: ['acc0'] },
  { id: 'p1', name: '名簿 乙', accounts: ['acc1'] },
];
const BASIS = { detection: { rejectionRate: '所在 A', reworkRate: '所在 B' }, rollback: 'r', tests: 't', enforcement: { selfCorrection: 'e1', aiReviewRound: '該当なし(往復を使わない)' } };
const cfgOf = (over = {}) => ({
  configured: true,
  people: PEOPLE,
  autonomy: { maxLevel: 'L3' },
  delegation: { allowed: true, changeTypes: [{ id: 'docs-typo', basis: BASIS }] },
  ...over,
});
const D0_HEAD = '# D-0\n\n## 12. 担い手と運用形態\n\n**AI を用いない実施の記録(標準 第5章 5.4.7)**\n\n| 実施した日 | 対象領域(AI自律レベルの適用の範囲の名) | 実施者(節1 の人の名簿の人) |\n| --- | --- | --- |\n';
const root = (rows) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-aifree-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  if (rows !== null) fs.writeFileSync(path.join(dir, 'docs/D-0-governance.md'), `${D0_HEAD}${rows}\n\n### 縮退の3列\n`);
  return dir;
};
const policyOf = (raw) => ({ present: true, cycle: { aiFree: parsePracticeInterval(raw), aiFreeRaw: raw || null } });
const state = (rows, { freq = '四半期に1回', day = '2026-03-01', config = cfgOf(), scope = null, policy = null } = {}) => {
  const dir = root(rows);
  try {
    return aiFreePracticeState(config, policy ?? policyOf(freq), { root: dir, day, scope: scope ?? l3ScopeIds(config, { q1: false }) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const texts = (...a) => aiFreePracticeTexts(state(...a));
const row = (d, area, by) => `| ${d} | ${area} | ${by} |`;
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const R0 = row('2026-02-01', 'docs-typo', '名簿 甲');

// ---------------------------------------------------------------- 層1 の頻度の読み(白名簿)
for (const [raw, n] of [['四半期に1回', 3], ['12か月', 12], ['半年に1回', 6], ['90日ごと', 90], ['毎年', 12], ['毎月', 1], ['1年に1回', 12], ['3か月に1回', 3], ['2週ごと', 14]]) {
  check(`IMPL-1021:ok 読める値(${raw})`, parsePracticeInterval(raw)?.n === n, JSON.stringify(parsePracticeInterval(raw)));
}
// IMPL-1021:ng(読めない値は空欄と同じに扱い、値を併記して表示する)
for (const raw of ['3月', '12月', '年に1回', '月1回', '12か月毎', '毎月毎', '3ヶ月', '3か月に2回', '毎月2回', '3〜6か月', '0か月', '随時', '必要に応じて', '毎月1回、繁忙期は2回', '半年ごと(重要案件は毎月)', '']) {
  const t = texts(row('2026-02-01', 'docs-typo', '名簿 甲'), { freq: raw });
  check(`IMPL-1021:ng 読めない値/空欄(${raw || '空欄'})は「頻度を定めていない」を値つきで出す`, parsePracticeInterval(raw) === null && t.some((x) => x.includes('頻度を定めていない') && x.includes(raw || '空欄')), t.join(' / '));
}
check('IMPL-1021:ok 読める値なら「頻度を定めていない」は出ない', !texts(row('2026-02-01', 'docs-typo', '名簿 甲')).some((x) => x.includes('頻度を定めていない')));
check('IMPL-1021:ok 範囲が無い構成(allowed が偽)では、空欄でも表示しない', texts(null, { freq: '', config: cfgOf({ delegation: { allowed: false, changeTypes: [{ id: 'docs-typo', basis: BASIS }] } }) }).length === 0);
check('IMPL-1021:ok 範囲が無い構成(種別の登録なし)では、空欄でも表示しない', texts(null, { freq: '', config: cfgOf({ delegation: { allowed: true, changeTypes: [] } }) }).length === 0);
check('IMPL-1021:ok 層1 そのものが無い案件は頻度の表示を重ねて出さない(別の欠落として出る)', !texts(null, { policy: { present: false, cycle: {} } }).some((x) => x.includes('頻度を定めていない')));
check('IMPL-1022:ng 層1 そのものが無い案件でも「記録が無い」は出る(頻度に依らず)', texts(null, { policy: { present: false, cycle: {} } }).some((x) => x.includes('記録が無い') && x.includes('docs-typo')));
check('IMPL-1022:ok 層1 が無くても記録があれば「記録が無い」は出ない', !texts(R0, { policy: { present: false, cycle: {} } }).some((x) => x.includes('記録が無い')));
check('IMPL-1021:ng 層1 があり行が無い(頻度が null)なら、空欄として出す', texts(null, { policy: { present: true, cycle: { aiFree: null, aiFreeRaw: null } } }).some((x) => x.includes('頻度を定めていない') && x.includes('空欄')));

// 層1 の様式の行を実際に読む(テンプレ11 の IMPL-1020 の行)
{
  const tpl = fs.readFileSync(path.join(ROOT, 'templates/11-quality-assurance-policy.md'), 'utf8').replace(/\r\n/g, '\n');
  const p1 = readPolicy(cfgOf(), { text: tpl.replace('<例: 四半期に1回>', '四半期に1回') });
  check('IMPL-1020:ok テンプレ11 の頻度の行を層1 が読む(四半期に1回 → 3か月)', p1.cycle.aiFree?.n === 3 && p1.cycle.aiFreeRaw === '四半期に1回', JSON.stringify(p1.cycle.aiFree));
  const p0 = readPolicy(cfgOf(), { text: tpl });
  check('IMPL-1020:ng 例示の文(<例: …>)のままの行は読めない値になる', p0.cycle.aiFree === null);
}

// ---------------------------------------------------------------- 記録と頻度切れ
const R = row('2026-02-01', 'docs-typo', '名簿 甲');
{
  // IMPL-1022:ng
  check('IMPL-1022:ng D-0 に表が無い(D-0 が無い)なら「記録が無い」', texts(null).some((x) => x.includes('記録が無い') && x.includes('docs-typo')));
  check('IMPL-1022:ng 行が無いなら「記録が無い」(頻度が空欄でも出る)', texts('', { freq: '' }).some((x) => x.includes('記録が無い')));
  check('IMPL-1022:ng 名簿に無い名は数えない', texts(row('2026-02-01', 'docs-typo', '名簿 丙')).some((x) => x.includes('記録が無い')));
  check('IMPL-1022:ng 複数の実施者のうち1名でも名簿に無ければ数えない', texts(row('2026-02-01', 'docs-typo', '名簿 甲、名簿 丙')).some((x) => x.includes('記録が無い')));
  check('IMPL-1022:ng AI の名義(Claude)は数えない', texts(row('2026-02-01', 'docs-typo', 'Claude')).some((x) => x.includes('記録が無い')));
  check('IMPL-1022:ng 基準日より後の日は数えない', texts(row('2026-03-02', 'docs-typo', '名簿 甲')).some((x) => x.includes('記録が無い')));
  check('IMPL-1022:ng 実在しない日(2026-02-30)は数えない', texts(row('2026-02-30', 'docs-typo', '名簿 甲')).some((x) => x.includes('記録が無い')));
  check('IMPL-1022:ng 範囲の名の不一致は数えない', texts(row('2026-02-01', 'other', '名簿 甲')).some((x) => x.includes('記録が無い')));
  check('IMPL-1022:ng 実施者が空なら数えない', texts(row('2026-02-01', 'docs-typo', '')).some((x) => x.includes('記録が無い')));
  const ov = texts(row('2026-01-31', 'docs-typo', '名簿 甲'), { freq: '1か月', day: '2026-03-01' });
  check('IMPL-1022:ng 最後 2026-01-31・頻度1か月・基準日 2026-03-01 は頻度を過ぎている(期限 2026-02-28)', ov.some((x) => x.includes('頻度を過ぎている') && x.includes('2026-01-31') && x.includes('2026-02-28') && x.includes('1か月')), ov.join(' / '));
  // IMPL-1022:ok
  check('IMPL-1022:ok 同じ行で基準日 2026-02-28 は表示なし(intervalEnd なら 03-03 なので 03-01 も出ない差を確かめる対)', texts(row('2026-01-31', 'docs-typo', '名簿 甲'), { freq: '1か月', day: '2026-02-28' }).length === 0);
  check('試験の前提: intervalEnd は月末を繰り越す(2026-03-03)が practiceDue は繰り越さない', intervalEnd('2026-01-31', { n: 1, unit: 'month' }) === '2026-03-03' && practiceDue('2026-01-31', { n: 1, unit: 'month' }) === '2026-02-28' && practiceDue('2024-02-29', { n: 12, unit: 'month' }) === '2025-02-28');
  check('IMPL-1022:ok 名簿の人2名を「、」で並べた行は数える', texts(row('2026-02-01', 'docs-typo', '名簿 甲、名簿 乙')).length === 0);
  check('IMPL-1022:ok 「登録した変更種別 X」と書いた対象領域は数える', texts(row('2026-02-01', '登録した変更種別 docs-typo', '名簿 甲')).length === 0);
  check('IMPL-1022:ok 頻度が空欄のとき、日付の古い行でも「頻度を過ぎている」は出ない', !texts(row('2020-01-01', 'docs-typo', '名簿 甲'), { freq: '' }).some((x) => x.includes('頻度を過ぎている')));
  check('IMPL-1022:ok 数えない新しい行が、数える古い行より後にあっても、古い行から頻度を数える', texts(`${row('2026-01-01', 'docs-typo', '名簿 甲')}\n${row('2026-02-20', 'docs-typo', 'Claude')}`, { freq: '1か月', day: '2026-03-01' }).some((x) => x.includes('頻度を過ぎている') && x.includes('2026-01-01')));
  check('IMPL-1022:ok 頻度内の記録は表示なし', texts(R).length === 0);
  const ext = JSON.stringify(state(row('2026-02-01', 'docs-typo', '名簿 甲')));
  check('IMPL-1022:ok 組織の外へ渡す材料(状態)に実施者の名が出ない', !ext.includes('名簿 甲'));
}

// ---------------------------------------------------------------- 範囲: D-0 の表との一致
{
  const L = (config) => renderAutonomyTable(config, false, { q1: false }).filter((l) => /^\| 登録した変更種別 /.test(l)).map((l) => l.split('|')[1].trim());
  const withBasis = (over) => cfgOf(over);
  const cases = [
    ['allowed が偽', withBasis({ delegation: { allowed: false, changeTypes: [{ id: 'a', basis: BASIS }] } }), []],
    ['上限が L3 未満', withBasis({ autonomy: { maxLevel: 'L1' } }), []],
    ['手戻り率が未計測', withBasis({ delegation: { allowed: true, changeTypes: [{ id: 'a', basis: { detection: { rejectionRate: 'x' } } }] } }), []],
    ['L3', withBasis({ delegation: { allowed: true, changeTypes: [{ id: 'a', basis: BASIS }, { id: 'b', basis: { detection: { rejectionRate: 'x' } } }] } }), ['a']],
  ];
  for (const [name, config, expected] of cases) {
    const ids = l3ScopeIds(config, { q1: false });
    const lv = L(config);
    const tableL3 = renderAutonomyTable(config, false, { q1: false })
      .filter((l) => /^\| 登録した変更種別 /.test(l))
      .filter((l) => l.split('|')[2].trim().startsWith('L3'))
      .map((l) => l.split('|')[1].trim().replace('登録した変更種別 ', ''));
    check(`範囲(${name}): 判定の範囲と D-0 の表の L3 の行が一致し、id の配列だけを返す`, JSON.stringify(ids) === JSON.stringify(expected) && JSON.stringify(tableL3) === JSON.stringify(expected) && ids.every((x) => typeof x === 'string'), `${JSON.stringify(ids)} / ${JSON.stringify(tableL3)} / ${lv}`);
  }
  // IMPL-1021:ok D-0 の表が L1 と書く3つの理由では、空欄でも表示を出さない(表と項目7 が食い違わない)
  for (const [name, config] of cases.slice(0, 3)) {
    check(`IMPL-1021:ok 範囲なし(${name})は空欄でも表示しない`, texts(null, { freq: '', config }).length === 0);
  }
  // 停止中の範囲(「L3(停止中は L1)」の行)も範囲に含める(表の静的な文字列にそろえる)
  check('範囲: 表が「L3(停止中は L1)」と書く行は範囲に含める', renderAutonomyTable(cases[3][1], false, { q1: false }).some((l) => l.includes('L3(停止中は L1)')) && l3ScopeIds(cases[3][1], { q1: false }).includes('a'));
}

// ---------------------------------------------------------------- 生成区間の不変(L3 の範囲の導き方を共有する変更の前後)
{
  // 変更前の導き方(表のレベルの列)を直に書き、新しい導き方で作った表の「現在のレベル」と一致することを4構成で確かめる
  const legacy = (config, t) => {
    const cap = config.autonomy?.maxLevel ?? 'L1';
    const measured = Boolean(t.basis?.detection?.reworkRate);
    return ['L1', 'L2', 'L3'].indexOf(cap) < 2 ? `L1(上限 ${cap} のため登録を適用しない)` : !measured ? 'L1(手戻り率が未計測)' : 'L3(停止中は L1)';
  };
  const four = [
    cfgOf({ autonomy: { maxLevel: 'L1' } }),
    cfgOf({ autonomy: { maxLevel: 'L2' } }),
    cfgOf({ delegation: { allowed: true, changeTypes: [{ id: 'a', basis: { detection: { rejectionRate: 'x' } } }] } }),
    cfgOf(),
  ];
  four.forEach((config, i) => {
    const rows = renderAutonomyTable(config, false, { q1: false }).filter((l) => /^\| 登録した変更種別 /.test(l));
    const same = rows.every((l, j) => l.split('|')[2].trim() === legacy(config, config.delegation.changeTypes[j]));
    check(`D-0 の表の生成(代表 ${i + 1}/4): 現在のレベルの列が変更前の導き方と一致する`, rows.length === config.delegation.changeTypes.length && same, rows.join('\n'));
  });
}

// ---------------------------------------------------------------- 集約の通し(項目7 の表示。止めない・記載の欠落に入れない)
{
  const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
  const ANSWERS = {
    'q-quality': 'quality-standard',
    'q-criticality': 'cl0',
    'q-dev-form': 'inhouse',
    'q-existing-gates': 'gates-none',
    'q-ai-constraint': 'ai-free',
    'q-team-size': 'size-3-9',
    'q-biz-phase': 'growth',
    'q-external-reviewer': 'reviewer-yes',
  };
  const people = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
  const seats = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
  const e2e = (rows, freq = '四半期に1回') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-aifree-e2e-'));
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
    }
    const config = quiet(() => buildConfig(ANSWERS, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, people, seats }).config);
    config.autonomy = { ...(config.autonomy ?? {}), maxLevel: 'L3' };
    config.delegation = { ...(config.delegation ?? {}), allowed: true, changeTypes: [{ id: 'docs-typo', basis: BASIS }] };
    fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(config, null, 2) + '\n');
    let d0 = fs.readFileSync(path.join(dir, 'templates/00-d0-governance.md'), 'utf8').replace(/\r\n/g, '\n');
    // 安全関連部の委任の停止(IMPL-0919)。D-0 表10 の F.2 の Q1 が「いいえ」の案件にする
    d0 = d0.replace(/(\| 附属書F F\.2 の回答 \|)[^\n]*/, '$1 いいえ。人身への危害は生じない |');
    d0 = d0.replace(/(\*\*AI を用いない実施の記録[\s\S]*?\| --- \| --- \| --- \|\n)\| \| \| \|/, `$1${rows}`);
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/D-0-governance.md'), d0);
    const qa = fs.readFileSync(path.join(dir, 'templates/11-quality-assurance-policy.md'), 'utf8').split('\r\n').join('\n').replace('<例: 四半期に1回>', freq);
    fs.writeFileSync(path.join(dir, 'docs/quality-assurance-policy.md'), qa);
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'tester');
    git('config', 'core.autocrlf', 'false');
    git('config', 'gc.auto', '0');
    git('config', 'maintenance.auto', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: fixture');
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    const report = path.join(dir, 'evidence/quality-report.md');
    const body = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '';
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { body, out };
  };
  const none = e2e('| | | |');
  check('IMPL-1022:ng 集約: 記録が無い範囲を項目7 に出し、照らした基準日を併記する', /AI を用いない実施の記録が無い\(範囲: docs-typo\)/.test(none.body) && /照らした基準日: \d{4}-\d{2}-\d{2}/.test(none.body), none.out.slice(-600));
  check('IMPL-1022:ng 集約: 表示は記載の欠落(止める側)に入れない', !none.out.split('\n').some((l) => /AI を用いない実施/.test(l) && /記載の欠落です/.test(l)), none.out.slice(-600));
  const done = e2e(`| ${localDay()} | docs-typo | 名簿 甲 |`);
  check('IMPL-1022:ok 集約: 頻度内の記録があれば(層1 の既定の頻度内)「記録が無い」は出ない', !/AI を用いない実施の記録が無い/.test(done.body), done.out.slice(-600));
}

console.log('');
if (failures) {
  console.log(`AI を用いない実施の表示の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`AI を用いない実施の表示の試験: ${checks} 件が期待と一致しました`);
