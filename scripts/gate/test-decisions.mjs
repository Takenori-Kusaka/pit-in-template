// 判断記録の状態と参照の検査(check-decisions)を、一時の置き場で試験する。
//
//   node scripts/gate/test-decisions.mjs
//
// 標準 第6章 テンプレ2「置き換えと廃止」と、第4章 G-3「記載の検査」の両側の参照の行を固定する。
// 通る場面(誤検出の候補)と落ちる場面の両方を置く。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { loadDecisions, checkDecisions, overdueDecisions, parseDecision, countsLine, DECISIONS_DIR, ARCHIVE_DIR } from './check-decisions.mjs';

let failures = 0;
let n = 0;
function check(name, ok, detail = '') {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
}

const adr = ({ num, state, replaces = 'なし', deadline = null, legacy = false }) =>
  legacy
    ? `# ADR-${num}: 旧い様式\n\n## ステータス\n\n${state}\n\n## コンテキスト\n\n本文\n${replaces === null ? '' : `\n- 置き換える決定: ${replaces}\n`}`
    : `# ADR-${num}: 決定\n\n- 状態: ${state}\n${replaces === null ? '' : `- 置き換える決定: ${replaces}\n`}- 判定者(技術判断者): 山田 太郎 / 判定日: 2026-10-01\n- 対象: F-001\n${deadline ? `- 期限(期限つきの実験として導入した場合): ${deadline}\n` : ''}\n## 決定\n\n決定1 本文\n`;

/** 場面ごとに一時の置き場を作る。files は { 'context/decisions/0001-a.md': text } */
function scenario(name, files, expect) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-decisions-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const list = loadDecisions(dir);
  const r = checkDecisions(list);
  const problems = expect(r, list);
  check(name, !problems.length, `${problems.join(' / ')}\n       problems: ${JSON.stringify(r.problems)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
const passes = (r) => (r.problems.length ? ['失敗するはずがない'] : []);
const failsWith = (re) => (r) => (r.problems.some((p) => re.test(p)) ? [] : [`${re} の不一致が出ていない`]);
const D = (f) => `${DECISIONS_DIR}/${f}`;
const A = (f) => `${ARCHIVE_DIR}/${f}`;

// ---------------------------------------------------------------- 通る場面
// IMPL-0139:ng(違反と適合の対。標準の実装マーク。process-compass #314)
scenario('置き場が空(README だけ)', { [D('README.md')]: '# 判断記録\n\n状態: 置き換え(→ ADR-0009)\n' }, (r) => [...passes(r), ...(r.total === 0 ? [] : [`README を数えた(${r.total} 件)`])]);
scenario('採用だけ', { [D('0001-a.md')]: adr({ num: '0001', state: '採用(2026-10-01)' }) }, passes);
scenario('一部置き換え: 両側が互いを指し、旧い側は置き場に残る', {
  [D('0001-a.md')]: adr({ num: '0001', state: '一部置き換え(→ ADR-0002 の決定1)' }),
  [D('0002-b.md')]: adr({ num: '0002', state: '採用(2026-10-02)', replaces: 'ADR-0001 の決定2' }),
}, passes);
// IMPL-0131:ok(違反と適合の対。標準の実装マーク。process-compass #314)
scenario('全部の置き換え: 旧い側は保管領域へ移してある', {
  [A('0001-a.md')]: adr({ num: '0001', state: '置き換え(→ ADR-0002)' }),
  [D('0002-b.md')]: adr({ num: '0002', state: '採用(2026-10-02)', replaces: 'ADR-0001(全部)' }),
}, passes);
scenario('廃止: 保管領域にある', { [A('0001-a.md')]: adr({ num: '0001', state: '廃止(2026-10-03)' }) }, passes);
scenario('旧い様式(## ステータスの節)でも状態を読む', {
  [D('0001-a.md')]: adr({ num: '0001', state: '採用(2026-08-01)。一部を置き換え(2026-10-01): 決定2 を ADR-0002 が置き換えました', legacy: true }),
  [D('0002-b.md')]: adr({ num: '0002', state: '採用(2026-10-01)', replaces: 'ADR-0001 の決定2' }),
}, passes);
scenario('1つの判断記録が2つを置き換える(一部と全部)', {
  [D('0001-a.md')]: adr({ num: '0001', state: '一部置き換え(→ ADR-0003 の決定1)' }),
  [A('0002-b.md')]: adr({ num: '0002', state: '置き換え(→ ADR-0003)' }),
  [D('0003-c.md')]: adr({ num: '0003', state: '採用', replaces: 'ADR-0001 の決定1、ADR-0002(全部)' }),
}, passes);

// ---------------------------------------------------------------- 落ちる場面
scenario('旧い側だけが後継を指す(新しい側の欄が「なし」)', {
  [D('0001-a.md')]: adr({ num: '0001', state: '一部置き換え(→ ADR-0002 の決定1)' }),
  [D('0002-b.md')]: adr({ num: '0002', state: '採用' }),
}, failsWith(/ADR-0002 の「置き換える決定」の欄が ADR-0001 を指していない/));
scenario('新しい側だけが旧い側を指す(旧い側の状態が採用のまま。本プロジェクトの ADR で 6 件あった形)', {
  [D('0001-a.md')]: adr({ num: '0001', state: '採用(2026-08-01)' }),
  [D('0002-b.md')]: adr({ num: '0002', state: '採用', replaces: 'ADR-0001 の決定7' }),
}, failsWith(/置き換えた ADR-0001 の状態の行が ADR-0002 を指していない/));
// IMPL-0131:ng(違反と適合の対。標準の実装マーク。process-compass #314)
scenario('全部を置き換えたのに、旧い側が置き場に残っている', {
  [D('0001-a.md')]: adr({ num: '0001', state: '置き換え(→ ADR-0002)' }),
  [D('0002-b.md')]: adr({ num: '0002', state: '採用', replaces: 'ADR-0001(全部)' }),
}, failsWith(/保管領域|_archive/));
scenario('廃止したのに、置き場に残っている', { [D('0001-a.md')]: adr({ num: '0001', state: '廃止' }) }, failsWith(/_archive/));
scenario('一部置き換えなのに、保管領域へ移した(効いている決定が読み込みから外れる)', {
  [A('0001-a.md')]: adr({ num: '0001', state: '一部置き換え(→ ADR-0002 の決定1)' }),
  [D('0002-b.md')]: adr({ num: '0002', state: '採用', replaces: 'ADR-0001 の決定3' }),
}, failsWith(/保管領域にある/));
scenario('全部と一部の食い違い(旧い側は置き換え、新しい側は一部)', {
  [A('0001-a.md')]: adr({ num: '0001', state: '置き換え(→ ADR-0002)' }),
  [D('0002-b.md')]: adr({ num: '0002', state: '採用', replaces: 'ADR-0001 の決定1' }),
}, failsWith(/一部の置き換えとして書かれている/));
scenario('後継の番号が実在しない', { [D('0001-a.md')]: adr({ num: '0001', state: '一部置き換え(→ ADR-0009 の決定1)' }) }, failsWith(/後継 ADR-0009 が無い/));
scenario('「置き換える決定」の欄が無い', { [D('0001-a.md')]: adr({ num: '0001', state: '採用', replaces: null }) }, failsWith(/「置き換える決定」の欄が無い/));
scenario('状態の語彙に無い値(承認済み)', { [D('0001-a.md')]: adr({ num: '0001', state: '承認済み' }) }, failsWith(/状態の行が読めない/));
scenario('番号の重複(置き場と保管領域)', {
  [D('0001-a.md')]: adr({ num: '0001', state: '採用' }),
  [A('0001-b.md')]: adr({ num: '0001', state: '廃止' }),
}, failsWith(/番号が重複/));

// ---------------------------------------------------------------- 期限つきの実験(改善サイクル)
{
  const list = [
    parseDecision(adr({ num: '0001', state: '採用(2026-07-01)', deadline: '2026-09-30' }), D('0001-a.md')),
    parseDecision(adr({ num: '0002', state: '採用(2026-07-01)。継続(2026-10-05)', deadline: '2026-09-30' }), D('0002-b.md')),
    parseDecision(adr({ num: '0003', state: '採用(2026-07-01)', deadline: '2026-12-31' }), D('0003-c.md')),
    parseDecision(adr({ num: '0004', state: '廃止(2026-10-02)', deadline: '2026-09-30' }), A('0004-d.md')),
    parseDecision(adr({ num: '0005', state: '採用(2026-07-01)。継続(2026-08-01)', deadline: '2026-09-30' }), D('0005-e.md')),
    parseDecision(adr({ num: '0006', state: '採用(2026-07-01)' }), D('0006-f.md')),
  ];
  const ids = overdueDecisions(list, '2026-10-23').map((d) => d.id);
  // IMPL-0140:ng(違反の入力: 期限を過ぎて採用のまま・期限の前の継続だけ。標準の実装マーク。process-compass #314)
  check('期限を過ぎて採用のまま・期限の前の継続だけの判断記録を出す', ids.includes('ADR-0001') && ids.includes('ADR-0005'), JSON.stringify(ids));
  // IMPL-0140:ok(適合の入力: 期限の後の継続・廃止・期限前・期限なし)
  check('期限の後の継続・廃止・期限前・期限なしの判断記録は出さない', ['ADR-0002', 'ADR-0003', 'ADR-0004', 'ADR-0006'].every((id) => !ids.includes(id)) && ids.length === 2, JSON.stringify(ids));
}

// ---------------------------------------------------------------- 件数の表示(出荷判定の証跡の集約)
{
  const r = checkDecisions([
    parseDecision(adr({ num: '0001', state: '一部置き換え(→ ADR-0002 の決定1)' }), D('0001-a.md')),
    parseDecision(adr({ num: '0002', state: '採用', replaces: 'ADR-0001 の決定2' }), D('0002-b.md')),
    parseDecision(adr({ num: '0003', state: '廃止' }), A('0003-c.md')),
  ]);
  const line = countsLine(r);
  // IMPL-0139:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('件数の表示は状態ごとで、README を数えない旨を添える', /採用 1 件 \/ 一部置き換え 1 件 \/ 置き換え 0 件 \/ 廃止 1 件/.test(line) && /README を数えない/.test(line), line);
}

// ---------------------------------------------------------------- テンプレートの様式と置き場の自己検査
{
  const tpl = parseDecision(fs.readFileSync(path.join(ROOT, 'templates/02-adr.md'), 'utf8'), 'templates/02-adr.md');
  check('様式(templates/02-adr.md)の記入例は、状態を採用・置き換える決定をなしと読む', tpl.kind === 'adopted' && Array.isArray(tpl.replaces) && tpl.replaces.length === 0, JSON.stringify(tpl));
  const r = checkDecisions(loadDecisions(ROOT));
  check('このリポジトリの判断記録に不一致が無い', !r.problems.length, JSON.stringify(r.problems));
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  check('権限設定が保管領域の読み込みを拒否している(第3章 3.11.4 要求事項7)', (settings.permissions?.deny ?? []).includes('Read(./context/_archive/**)'), JSON.stringify(settings.permissions?.deny));
}

// ---------------------------------------------------------------- 事業影響の5欄の検査(IMPL-0132。process-compass #355)
// 入口は node scripts/gate/check-decisions.mjs --root <一時> を子として走らせ、終了コードと出力を見る
const impactSection = (o = {}, heading = '## 事業への影響') => {
  const v = { users: '決済を使う全利用者の購入', signs: '決済の失敗率が 2% を超える', recovery: '30分〜4時間', revocable: '人手で戻せる', criteria: '該当なし', ...o };
  return `\n${heading}\n\n| 項目 | 内容 |\n| --- | --- |\n| 影響を受ける利用者・業務 | ${v.users} |\n| 顕在化が分かる兆候 | ${v.signs} |\n| 回復に要する時間 | ${v.recovery} |\n| 取り消しの可否 | ${v.revocable} |\n| 影響する必達基準 | ${v.criteria} |\n`;
};
const runCheck = (files, extra = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-decisions-cli-'));
  const all = { 'templates/02-adr.md': fs.readFileSync(path.join(ROOT, 'templates/02-adr.md'), 'utf8'), ...files };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/gate/check-decisions.mjs'), '--root', dir, ...extra], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const withImpact = (o, heading) => ({ [D('0001-a.md')]: adr({ num: '0001', state: '採用(2026-10-01)' }) + impactSection(o, heading) });
const fieldCase = (name, files, wantFail, re) => {
  const r = runCheck(files);
  const hit = re ? re.test(r.out) : true;
  check(name, wantFail ? r.status === 1 && hit : r.status === 0 && !/事業影響の欄の形式の欠落/.test(r.out) && hit, `終了 ${r.status}\n       ${r.out.split('\n').slice(0, 8).join('\n       ')}`);
};
const blankTemplate = fs.readFileSync(path.join(ROOT, 'templates/02-adr.md'), 'utf8').replace(/^# ADR-NNNN:.*$/m, '# ADR-0001: 白紙').replace('採用(YYYY-MM-DD)', '採用(2026-10-01)');
// IMPL-0132:ng(違反の入力。標準の実装マーク)
fieldCase('白紙の様式の写しは、事業影響の5欄すべてが空として落ちる', { [D('0001-a.md')]: blankTemplate }, true, /影響を受ける利用者・業務.*空[\s\S]*顕在化が分かる兆候.*空[\s\S]*回復に要する時間.*空[\s\S]*取り消しの可否[\s\S]*影響する必達基準.*空/);
for (const [key, label] of [['users', '影響を受ける利用者・業務'], ['signs', '顕在化が分かる兆候'], ['recovery', '回復に要する時間'], ['revocable', '取り消しの可否'], ['criteria', '影響する必達基準']]) {
  fieldCase(`欄が空白: ${label}`, withImpact({ [key]: '' }), true, new RegExp(`「${label}」が空`));
  fieldCase(`欄が「—」: ${label}`, withImpact({ [key]: '—' }), true, new RegExp(`「${label}」が空`));
}
for (const v of ['2時間', '約1日', '2時間〜2時間', '1時間以内']) fieldCase(`回復が単一の値: ${v}`, withImpact({ recovery: v }), true, /単一の値/);
for (const v of ['なし', '特になし', 'N/A', '無し。', '該当なし']) fieldCase(`兆候が「なし」: ${v}`, withImpact({ signs: v }), true, /が「なし」/);
fieldCase('取り消しの可否に選択肢が2つ以上残る', withImpact({ revocable: '自動で戻せる / 人手で戻せる' }), true, /選択肢が2つ残っている/);
fieldCase('事業影響の節が無い記録', { [D('0001-a.md')]: adr({ num: '0001', state: '採用(2026-10-01)' }) }, true, /事業影響の節/);
fieldCase('標準の見出し(事業影響)と欄の名(影響する利用者と業務)で空', { [D('0001-a.md')]: adr({ num: '0001', state: '採用(2026-10-01)' }) + impactSection({ users: '' }, '## 事業影響(G-3 判定基準5)').replace('影響を受ける利用者・業務', '影響する利用者と業務') }, true, /「影響を受ける利用者・業務」が空/);
fieldCase('旧い様式(「## ステータス」の節だけ)の採用の記録は、事業影響の節が無いとして落ちる', { [D('0001-a.md')]: '# ADR-0001: 旧\n\n## ステータス\n\n採用(2026-10-01)\n\n## 決定\n\n- 決定 1: a\n' }, true, /事業影響の節/);
// IMPL-0132:ok(適合の入力。標準の実装マーク)
fieldCase('全記入の記録は、欄の文が出ず終了 0', withImpact({}), false);
fieldCase('標準の見出しと欄の名で全記入', { [D('0001-a.md')]: adr({ num: '0001', state: '採用(2026-10-01)' }) + impactSection({}, '## 事業影響(G-3 判定基準5)').replace('影響を受ける利用者・業務', '影響する利用者と業務') }, false);
fieldCase('必達基準「該当なし」は通る', withImpact({ criteria: '該当なし' }), false);
fieldCase('兆候「更新がなしのまま 3 日続く」は通る', withImpact({ signs: '更新がなしのまま 3 日続く' }), false);
fieldCase('幅の別の書き方(から・2-3日)は通る', withImpact({ recovery: '数分から数十分' }), false);
fieldCase('保管領域の節の無い記録は見ない', { [A('0001-a.md')]: adr({ num: '0001', state: '廃止(2026-10-03)' }) }, false);
// 限界の固定(目印なし。落とさないことを固定する。標準の文を超えて落とさない)
fieldCase('限界: 兆候「不明」は通る', withImpact({ signs: '不明' }), false);
fieldCase('限界: 兆候「TBD」は通る', withImpact({ signs: 'TBD' }), false);
fieldCase('限界: 「なし(自動で戻せるため)」は通る', withImpact({ signs: 'なし(自動で戻せるため)' }), false);
fieldCase('開示した偽の失敗: 回復「2026-11-20 まで」は単一の値として落ちる', withImpact({ recovery: '2026-11-20 まで' }), true, /単一の値/);
fieldCase('限界: 初期の文を1字書き換えた記載は通る', withImpact({ users: 'この選択が裏目に出たとき、誰の何が止まるのか' }), false);
// 開示した偽の失敗(目印なし。幅でも単一の値として落ちる。EV-0290)
fieldCase('開示した偽の失敗: 回復「1日(最悪で3日)」は落ちる', withImpact({ recovery: '1日(最悪で3日)' }), true, /単一の値/);
fieldCase('開示した偽の失敗: 取り消し「人手で戻せる(一部は自動で戻せる)」は落ちる', withImpact({ revocable: '人手で戻せる(一部は自動で戻せる)' }), true, /選択肢が2つ残っている/);
// 静的確認: gate-g5.yml が検査の手順を結線している
{
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/gate-g5.yml'), 'utf8');
  check('gate-g5.yml が check-decisions.mjs と test-decisions.mjs を手順に持つ', /run: node scripts\/gate\/check-decisions\.mjs/.test(yml) && /run: node scripts\/gate\/test-decisions\.mjs/.test(yml));
}

if (failures) {
  console.error(`\n判断記録の検査の試験: ${failures} / ${n} 件が期待と一致しませんでした`);
  process.exit(1);
}
console.log(`\n判断記録の検査の試験: ${n} 件が期待と一致しました`);
