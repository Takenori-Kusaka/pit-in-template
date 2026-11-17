// 運用引き継ぎ文書の3項目の未記入の検出(handover-items.mjs と、出荷の証跡の集約の基準4)を試験する
// (標準 第4章 G-7 基準4 の記録 / IMPL-0043・出荷の証跡の集約。process-compass #355)。
//
//   node scripts/gate/test-handover-items.mjs
//
// 純関数の場面と、集約の入口(aggregate-evidence.mjs)を一時の置き場で通しで流す場面を持つ。
// 集約の出力に「未記入」の文が出る場面(ng)と、出ない場面(ok)の対を置く。出ないことは、欠落の総数ではなく、文の不在で確かめる。
// 機械が確かめるのは未記入までで、完備ではない。様式の文の書き換えと「TBD」が通る限界は、目印なしで固定する。
// GitHub へ問い合わせません。リポジトリの状態を変えません。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';
import { handoverItems, handoverGapText } from './handover-items.mjs';

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

const BLANK = fs.readFileSync(path.join(ROOT, 'templates/05-handover.md'), 'utf8').replace(/\r\n/g, '\n');
const MON_BLANK = '| 何を見るか | どこで | 異常の閾値 | 誰へ通知するか |\n| --- | --- | --- | --- |\n| | | | |';
const MON_FILLED = '| 何を見るか | どこで | 異常の閾値 | 誰へ通知するか |\n| --- | --- | --- | --- |\n| 決済の失敗率 | ダッシュボード | 2% 超 | 当番の運用担当 |';
const CON_BLANK = '- エスカレーション順序: ';
const CON_FILLED = '- エスカレーション順序: 当番 → 技術責任者 → 事業責任者';
const REC_RE = /^\| 切り戻し \|.*$/m;
const REC_FILLED = '| 切り戻し | 前の版のタグへ戻す(2026-11-10 に実行した) |';
const fillMon = (t) => t.replace(MON_BLANK, MON_FILLED);
const fillCon = (t) => t.replace(CON_BLANK, CON_FILLED);
const fillRec = (t) => t.replace(REC_RE, REC_FILLED);
const fillAll = (t) => fillRec(fillCon(fillMon(t)));
const resultsOf = (text, initial = BLANK) => Object.fromEntries(handoverItems(text, initial).items.map((i) => [i.id, i.result]));
const STD = '# 引き継ぎ\n\n## 監視項目\n\n- ダッシュボードで失敗率を見る\n\n## 障害時の連絡先・体制\n\n- 当番へ電話する\n\n## 復旧手順\n\n- 前の版へ戻す\n';

// ---------------------------------------------------------------- 純関数
{
  const r = resultsOf(BLANK);
  // 静的確認: 様式を白紙のまま通すと3項目が unfilled(missing でない。様式と置き場の語の対応を固定)
  check('静的確認: 白紙の様式(templates/05-handover.md)は3項目とも unfilled で、missing ではない', r.monitoring === 'unfilled' && r.contacts === 'unfilled' && r.recovery === 'unfilled', JSON.stringify(r));
  const g = handoverItems(BLANK, BLANK).items.map(handoverGapText).join('\n');
  check('欠落の文に「完備」「合格」の語を使わない', !/完備|合格/.test(g), g);
  check('監視だけ記入: 監視は filled、残りは unfilled', JSON.stringify(resultsOf(fillMon(BLANK))) === JSON.stringify({ monitoring: 'filled', contacts: 'unfilled', recovery: 'unfilled' }), JSON.stringify(resultsOf(fillMon(BLANK))));
  check('3項目を記入: すべて filled', Object.values(resultsOf(fillAll(BLANK))).every((v) => v === 'filled'), JSON.stringify(resultsOf(fillAll(BLANK))));
  check('標準の様式の見出しと箇条書きで書いた文書は、3項目とも filled', Object.values(resultsOf(STD)).every((v) => v === 'filled'), JSON.stringify(resultsOf(STD)));
  check('見出しを「4. モニタリング」へ改めた文書は、監視が missing', resultsOf(fillAll(BLANK).replace('## 4. 監視', '## 4. モニタリング')).monitoring === 'missing');
  check('initialText が null なら compared:false で、空欄だけを見る(白紙の監視と連絡先は unfilled)', (() => {
    const h = handoverItems(BLANK, null);
    return h.compared === false && h.items.find((i) => i.id === 'monitoring').result === 'unfilled' && h.items.find((i) => i.id === 'contacts').result === 'unfilled';
  })());
  check('全体が <…> のセルと「—」は記入に数えない', resultsOf(BLANK.replace(MON_BLANK, MON_FILLED.replace('決済の失敗率', '<入力>').replace('ダッシュボード', '—').replace('2% 超', '-').replace('当番の運用担当', ' '))).monitoring === 'unfilled');
  check('HTML コメントの中は読まない', resultsOf(BLANK.replace(CON_BLANK, '<!-- ' + CON_FILLED + ' -->\n' + CON_BLANK)).contacts === 'unfilled');
  // 「エスカレーション」だけを含む別の節は、連絡先の置き場にしない(偽の合格を防ぐ)
  const other = BLANK.replace(CON_BLANK, CON_BLANK + '\n\n### エスカレーションの見直し\n\n- 四半期ごとに見直す');
  check('白紙の連絡先の節と、記入のある別の「エスカレーション」の節: 連絡先は unfilled のまま', resultsOf(other).contacts === 'unfilled', JSON.stringify(resultsOf(other)));
  const only = '# 引き継ぎ\n\n## エスカレーションの見直し\n\n- 四半期ごとに見直す\n';
  check('「エスカレーション」だけを見出しに持つ文書: 連絡先は置き場なし(missing)', resultsOf(only).contacts === 'missing', JSON.stringify(resultsOf(only)));
}

// ---------------------------------------------------------------- 集約の通し
const ANSWERS = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes',
};
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-handover-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const config = quiet(() => buildConfig({ ...ANSWERS, 'q-biz-phase': 'growth' }, { generatedAt: '2026-11-04T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('process.config.json', JSON.stringify(config, null, 2) + '\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'maintenance.auto', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: fixture');
  const run = (handover, { dropTemplate = false } = {}) => {
    write('docs/handover.md', handover);
    if (dropTemplate) fs.rmSync(path.join(dir, 'templates/05-handover.md'), { force: true });
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    const evFile = path.join(dir, 'evidence/evidence.json');
    const ev = fs.existsSync(evFile) ? JSON.parse(fs.readFileSync(evFile, 'utf8')) : null;
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ev };
  };
  return { run, done: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}
const gapOf = (out, label) => out.includes(`運用引き継ぎ文書(docs/handover.md)の${label}が未記入です`);
const missingOf = (out, label) => out.includes(`運用引き継ぎ文書(docs/handover.md)の${label}の置き場がありません`);
const criterion4 = (ev) => {
  const walk = (o) => {
    if (!o || typeof o !== 'object') return null;
    if (Array.isArray(o)) {
      for (const x of o) {
        if (x && x.id === 4 && x.label === '運用引き継ぎ文書') return x;
      }
    }
    for (const v of Object.values(o)) {
      const r = walk(v);
      if (r) return r;
    }
    return null;
  };
  return walk(ev);
};
const ITEMS = ['監視項目', '障害時の連絡先', '復旧手順'];
{
  const w = workspace();
  const first = w.run(BLANK);
  check('試験の前提: 集約が最後まで走る', /を出力しました/.test(first.out), first.out);
  // IMPL-0989:ng(通し。違反の入力。標準の実装マーク)
  check('白紙の様式のまま → 3項目の未記入の文が出る', ITEMS.every((l) => gapOf(first.out, l)), first.out);
  const c4 = criterion4(first.ev);
  check('白紙の様式のまま → 基準4 の行に「未記入」が出て、完備とは書かない', !!c4 && /監視項目=未記入/.test(c4.result) && /記入が在ることは完備を意味しない/.test(c4.humanReconcile), JSON.stringify(c4));
  check('evidence.json の handover に items が出る', Array.isArray(first.ev?.handover?.items) && first.ev.handover.items.length === 3, JSON.stringify(first.ev?.handover));
  const mon = w.run(fillMon(BLANK));
  check('監視だけ記入 → 残り2項目の文が出る', gapOf(mon.out, '障害時の連絡先') && gapOf(mon.out, '復旧手順'), mon.out);
  // IMPL-0989:ok(通し。適合の入力。標準の実装マーク)
  check('監視だけ記入 → 監視の文は出ない', !gapOf(mon.out, '監視項目') && !missingOf(mon.out, '監視項目'));
  const renamed = w.run(fillAll(BLANK).replace('## 4. 監視', '## 4. モニタリング'));
  check('見出しを「4. モニタリング」へ改めた文書 → 「置き場がありません」が出る', missingOf(renamed.out, '監視項目'), renamed.out);
  const all = w.run(fillAll(BLANK));
  check('3項目を記入 → 3つの未記入・置き場なしの文のどれも出ない', ITEMS.every((l) => !gapOf(all.out, l) && !missingOf(all.out, l)), all.out);
  const std = w.run(STD);
  check('標準の様式の見出しと箇条書きで記入 → 文が出ない', ITEMS.every((l) => !gapOf(std.out, l) && !missingOf(std.out, l)), std.out);
  const alias = w.run(STD.replace('## 障害時の連絡先・体制', '## 障害時連絡先'));
  check('見出し「障害時連絡先」(基準の表の語)で記入 → 文が出ない', ITEMS.every((l) => !gapOf(alias.out, l) && !missingOf(alias.out, l)), alias.out);
  // 限界の固定(目印なし)
  const tbd = w.run(fillAll(BLANK).replace('決済の失敗率', 'TBD'));
  check('限界: 「TBD」だけでも記入ありとして通る(完備は判定しない)', !gapOf(tbd.out, '監視項目'));
  const oneChar = w.run(BLANK.replace('戻せる経路として数えない', '戻せる経路として数えません'));
  check('限界: 様式の手引きの文を1字書き換えると記入ありとして通る', !gapOf(oneChar.out, '復旧手順'), oneChar.out);
  const noTpl = w.run(BLANK, { dropTemplate: true });
  const row = criterion4(noTpl.ev);
  check('限界: 同梱の様式が無ければ空欄だけを見て、「初期の文と比べていない」が基準4 に出る', !!row && /比べていない/.test(`${row.result}${row.humanReconcile}`), JSON.stringify(row));
  w.done();
}

// 静的確認: gate-g5.yml が本試験を条件なしで流す(templateTestWired が確かめる)
check('静的確認: gate-g5.yml が test-handover-items.mjs を手順に持つ', /- run: node scripts\/gate\/test-handover-items\.mjs/.test(fs.readFileSync(path.join(ROOT, '.github/workflows/gate-g5.yml'), 'utf8')));

console.log('');
if (failures) {
  console.log(`運用引き継ぎ文書の3項目の検出の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`運用引き継ぎ文書の3項目の検出の試験: ${checks} 件が期待と一致しました`);
