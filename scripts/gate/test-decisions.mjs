// 判断記録の状態と参照の検査(check-decisions)を、一時の置き場で試験する。
//
//   node scripts/gate/test-decisions.mjs
//
// 標準 第6章 テンプレ2「置き換えと廃止」と、第4章 G-3「記載の検査」の両側の参照の行を固定する。
// 通る場面(誤検出の候補)と落ちる場面の両方を置く。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

if (failures) {
  console.error(`\n判断記録の検査の試験: ${failures} / ${n} 件が期待と一致しませんでした`);
  process.exit(1);
}
console.log(`\n判断記録の検査の試験: ${n} 件が期待と一致しました`);
