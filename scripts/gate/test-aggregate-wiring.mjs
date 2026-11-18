// 出荷の証跡の集約(aggregate-evidence.mjs)の結線の試験。実物の集約を、使い捨てのリポジトリで動かす(process-compass #448 / 束 B20 の独立の突合 1巡目の所見)。
//
//   node scripts/gate/test-aggregate-wiring.mjs
//
// 単体の試験(test-aggregate-records.mjs など)は判定の論理を守るが、集約から呼ぶ行を消しても通る。ここは「違反の場面で欠落や開示の行が出ること」と
// 「適合の場面で出ないこと」を、実物の集約の出力(evidence/evidence.json の gaps と品質レポート)で固定する。場面は基点のタグへ戻して使い回す。
// GitHub へ問い合わせない。PR は基底ブランチの写し(docs/records/reviews/pr-N.json)と、ローカルの git の履歴で渡す。
import fs from 'node:fs';
import { makeRepo, buildCfg, checker, lineWith, seatsOf } from './e2e-fixture.mjs';
import { METHOD_COLUMNS } from './check-safety-record.mjs';

const { check, finish } = checker();
const FROM = ['--from', 'base', '--to', 'HEAD'];
const agg = (r) => r.runAggregate(FROM);
const hit = (gaps, re) => gaps.filter((g) => re.test(g));
const HOLD = /出荷しません/;
// 変異の確認で場面を絞る(WIRING_ONLY=0738,0498 のように IMPL 番号を並べる)。指定が無ければ全場面を流す
const ONLY = (process.env.WIRING_ONLY ?? '').split(',').filter(Boolean);
const want = (tags) => !ONLY.length || tags.split(' ').some((t) => ONLY.includes(t));

// ---------------------------------------------------------------- IMPL-0738(人の確認の未達は CL1 以上と規制業で出荷を止める。G-3 は開示だけ)
if (want('0738')) {
  const G6 = { gate: 'g6', label: 'G-6 独立レビュー', reason: '作成を指示した本人以外の確認者がいない', howToResolve: ['作成を指示した本人以外の確認者を名簿と席へ置く'] };
  const cl1 = buildCfg({ 'q-criticality': 'cl1' }, { stack: 'node' });
  const r = makeRepo({ config: cl1 });
  const withUnmet = (cfg, list) => ({ ...JSON.parse(JSON.stringify(cfg)), unmet: list });
  const run = (cfg) => {
    r.resetTo('base');
    r.writeConfig(cfg);
    r.commitAll('chore: config');
    return agg(r);
  };
  const a = run(withUnmet(cl1, [G6]));
  check('IMPL-0738:ng 集約: CL1 × G-6 未達は欠落(出荷しません)になり、終了コードが 1', hit(a.gaps, HOLD).some((g) => /G-6 独立レビュー/.test(g)) && a.status === 1, JSON.stringify(a.gaps.filter((g) => /G-6/.test(g))));
  const reg = buildCfg({ 'q-quality': 'quality-regulated' }, { stack: 'node' });
  check('IMPL-0738:ng 集約: CL0 × 規制業 × G-6 未達も欠落', hit(run(withUnmet(reg, [G6])).gaps, HOLD).length === 1);
  const undetermined = buildCfg({ 'q-criticality': 'cl1' }, { stack: 'undetermined' });
  const g3 = run(undetermined);
  check('IMPL-0738:ok 集約: CL1 × G-3 未達は欠落にならず、保証の開示に G-3 の未達が出る', hit(g3.gaps, HOLD).length === 0 && /G-3/.test(lineWith(g3.report, '未達')), lineWith(g3.report, 'G-3').slice(0, 300));
  const hand = run(withUnmet(undetermined, []));
  check('IMPL-0738:ok 集約: 手で unmet: [] と書いても、導き直した G-3 が開示の未達に出る(欠落にはならない)', hit(hand.gaps, HOLD).length === 0 && /G-3/.test(lineWith(hand.report, '未達')), lineWith(hand.report, '未達').slice(0, 300));
  const std = run(withUnmet(buildCfg({}, { stack: 'node' }), [G6]));
  check('IMPL-0738:ok 集約: CL0 × 標準 × G-6 未達は欠落にならず、開示に出る', hit(std.gaps, HOLD).length === 0 && /G-6/.test(lineWith(std.report, '未達')));
  // 委託 × 価値責任者を置かない(IMPL-0755)
  const SLA = (cell) => r.read('templates/08-ai-sla.md').replace(/\r\n/g, '\n').replace(/^\| 価値責任者\(発注側が選任した者\) \|[^\n]*$/m, `| 価値責任者(発注側が選任した者) | ${cell} |`);
  const vendor = (over) => buildCfg({ 'q-dev-form': 'vendor', ...over }, { stack: 'node' });
  const runSla = (cfg, cell) => {
    r.resetTo('base');
    r.writeConfig(cfg);
    r.write('docs/ai-sla.md', SLA(cell));
    r.commitAll('chore: sla');
    return agg(r);
  };
  const v1 = runSla(vendor({ 'q-criticality': 'cl1' }), '置かない');
  check('IMPL-0738:ng 集約: CL1 × 委託 × 「置かない」は G-2 の欠落', hit(v1.gaps, HOLD).some((g) => /G-2/.test(g)), JSON.stringify(v1.gaps.filter((g) => /G-2/.test(g))));
  check('IMPL-0738:ng 集約: 規制業 × 委託 × 「置かない」も欠落', hit(runSla(vendor({ 'q-quality': 'quality-regulated' }), '置かない').gaps, HOLD).some((g) => /G-2/.test(g)));
  const v0 = runSla(vendor({}), '置かない');
  check('IMPL-0738:ok 集約: CL0 × 標準 × 委託 × 「置かない」は欠落にならず、開示に G-2 が出る', hit(v0.gaps, HOLD).length === 0 && /G-2/.test(lineWith(v0.report, '未達')));
  r.done();
}


/** 様式 04 を土台にして、欄の値を差し替えた判定記録の本文 */
const form04 = (r, over) => {
  let t = r.read('templates/04-gate-record.md').replace(/\r\n/g, '\n');
  for (const [k, v] of Object.entries(over)) t = t.split('\n').map((l) => (l.startsWith(`| ${k} |`) ? `| ${k} | ${v} |` : l)).join('\n');
  return t;
};

// ---------------------------------------------------------------- 判定記録の読み(IMPL-0638 暫定任命の併記・IMPL-0667 必達基準の回数)
if (want('0638 0667')) {
  const r = makeRepo({ config: buildCfg({ 'q-criticality': 'cl1' }, { stack: 'node' }) });
  const withD0Row = (row) => {
    const lines = r.read('docs/D-0-governance.md').replace(/\r\n/g, '\n').split('\n');
    const at = lines.findIndex((l) => l.startsWith('| 役割 | 暫定任命の対象'));
    lines[at + 2] = row;
    r.write('docs/D-0-governance.md', lines.join('\n'));
  };
  const g3 = (cosign) => form04(r, { ゲート: 'G-3 技術設計判断', 対象: 'ADR-0001', 判定者: '名簿 己', 判定日時: '2026-11-05 10:00', 結果: '通過', '確認済みの者の併記(任意)': cosign });
  const scene = (cosign) => {
    r.resetTo('base');
    withD0Row('| 技術判断者(Tech Lead) | 責任者 | 2026-10-01〜2026-12-31 | 任命を解く | |');
    r.write('docs/gates/g3-adr-0001.md', g3(cosign));
    r.commitAll('docs: G-3');
    return agg(r);
  };
  const ng = scene('');
  check('IMPL-0638:ng 集約: CL1 × 範囲の中の判定に併記なし(暫定任命の期間)は欠落(出荷しません)', hit(ng.gaps, HOLD).some((g) => /併記/.test(g)), JSON.stringify(ng.gaps.filter((g) => /併記/.test(g))));
  const ok = scene('名簿 甲');
  check('IMPL-0638:ok 集約: 併記があれば欠落にならない', !hit(ok.gaps, HOLD).some((g) => /併記/.test(g)), JSON.stringify(ok.gaps.filter((g) => /併記/.test(g))));
  check('IMPL-0638:ok 集約: 併記のない判定は保証の開示にも出る', /併記/.test(lineWith(ng.report, '暫定任命')), lineWith(ng.report, '暫定任命').slice(0, 200));

  // IMPL-0667: 必達基準の判定(乙の継続)の回数
  const reach = (i, over = {}) => form04(r, { ゲート: '必達基準の判定', 対象: `ステージ ${i}`, 判定者: '名簿 丁', 判定日時: `2026-0${i}-01 10:00`, 結果: '通過', 区分: '期間 乙 / 案件 乙', 判定: '継続', ...over });
  const reachScene = (n, over) => {
    r.resetTo('base');
    for (let i = 1; i <= n; i++) r.write(`docs/gates/reach-${i}.md`, reach(i, over));
    r.commitAll('docs: reach');
    return agg(r);
  };
  const four = reachScene(4);
  check('IMPL-0667:ng 集約: 様式 04 を埋めた乙の継続 4 件で、4 回目が欠落になる', hit(four.gaps, /4 回目/).length === 1, JSON.stringify(four.gaps.filter((g) => /回目/.test(g))));
  const three = reachScene(3);
  check('IMPL-0667:ok 集約: 3 件なら欠落にならず、項目7 に回数が出る', hit(three.gaps, /回目/).length === 0 && /必達基準/.test(lineWith(three.report, '必達基準')), lineWith(three.report, '必達基準').slice(0, 240));
  const blank = reachScene(4, { 判定: '継続 / 中止 / 保留 / 差し戻し' });
  check('IMPL-0667:ok 集約: 判定が様式のまま(未記入)の記録は継続に数えず、欠落にならない', hit(blank.gaps, /回目/).length === 0);
  r.done();
}


// ---------------------------------------------------------------- IMPL-0523(判断記録の再検査)・IMPL-0498(層の合わさり)
if (want('0523')) {
  const r = makeRepo({ config: buildCfg({}, { stack: 'node' }) });
  const ADR = (n, body, extra = '') => `# ADR-${n} 試験\n\n- 状態: 採用\n- 置き換える決定: ${extra || 'なし'}\n\n## 決定\n\n${body}\n`;
  const adrFile = 'context/decisions/0007-test.md';
  const g3Form = (sha, over = {}) => form04(r, { ゲート: 'G-3 技術設計判断', 対象: 'ADR-0007', 判定者: '名簿 己', 判定日時: '2026-11-05 10:00', 結果: '通過', '判定した判断記録(G-3 のみ)': `ADR-0007 / 版: ${sha.slice(0, 8)}`, ...over });
  /** 記録用ブランチ records に様式を置く(orphan のブランチ。main の作業ツリーへ戻る) */
  const onRecords = (files) => {
    r.git('checkout', '-q', '--orphan', 'records');
    r.git('rm', '-rfq', '--ignore-unmatch', '.');
    for (const [f, t] of Object.entries(files)) r.write(f, t);
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'records');
    r.git('checkout', '-q', '-f', 'main');
  };
  const adrScene = ({ viaBranch = false, change = null } = {}) => {
    r.resetTo('base');
    r.write(adrFile, ADR('0007', '初版の決定'));
    const sha = r.commitAll('docs: adr 0007');
    if (viaBranch) onRecords({ 'records/gates/g3-adr-0007.md': g3Form(sha) });
    else r.write('docs/gates/g3-adr-0007.md', g3Form(sha));
    r.commitAll('docs: G-3');
    if (change) {
      r.write(adrFile, change === 'state' ? ADR('0007', '初版の決定').replace('状態: 採用', '状態: 非推奨') : ADR('0007', '本文を書き換えた'));
      r.commitAll('docs: adr change');
    }
    return agg(r);
  };
  const MIS = /G-3 で判定した版.*から本文が変わっています/;
  check('IMPL-0523:ng 集約: 基底の様式の通過の後に本文を書き換えると不一致(欠落)', hit(adrScene({ change: 'body' }).gaps, MIS).length === 1);
  const viaBranchNg = adrScene({ viaBranch: true, change: 'body' });
  check('IMPL-0523:ng 集約: 記録用ブランチだけの G-3 の通過の後に本文を書き換えても不一致を検出する', hit(viaBranchNg.gaps, MIS).length === 1, JSON.stringify(viaBranchNg.gaps.filter((g) => /ADR-0007/.test(g))));
  check('IMPL-0523:ok 集約: 状態の行だけの変更は一致(欠落にならない)', hit(adrScene({ change: 'state' }).gaps, MIS).length === 0);
  check('IMPL-0523:ok 集約: 本文を変えなければ一致(記録用ブランチの通過)', hit(adrScene({ viaBranch: true }).gaps, MIS).length === 0);
  // G-3 の無い「置き換える決定」
  const REPL = /「置き換える決定」を持つのに/;
  const replScene = (viaBranch) => {
    r.resetTo('base');
    r.write('context/decisions/0008-new.md', ADR('0008', '置き換える', 'ADR-0007'));
    const sha = r.commitAll('docs: adr 0008');
    if (viaBranch) {
      onRecords({ 'records/gates/g3-adr-0008.md': g3Form(sha, { 対象: 'ADR-0008', '判定した判断記録(G-3 のみ)': `ADR-0008 / 版: ${sha.slice(0, 8)}` }) });
      r.commitAll('chore: nothing');
    }
    return agg(r);
  };
  check('IMPL-0523:ng 集約: G-3 の通過の無い置き換える決定は欠落', hit(replScene(false).gaps, REPL).length === 1);
  check('IMPL-0523:ok 集約: 記録用ブランチの G-3 の通過があれば置き換えは欠落にならない', hit(replScene(true).gaps, REPL).length === 0);
  r.done();
}

if (want('0498')) {
  // IMPL-0498: 承認の無い下の層(基底が既定ブランチでない)が、既定ブランチへ入った PR の先頭の祖先なら、その PR を確認ありに数えない
  const r = makeRepo({ config: buildCfg({}, { stack: 'node' }) });
  const stack = (xReviews) => {
    r.resetTo('base');
    r.git('checkout', '-q', '-b', 'stack');
    r.write('x.txt', 'x\n');
    r.commitAll('feat: layer x (#1)');
    const mX = r.git('rev-parse', 'HEAD');
    r.git('checkout', '-q', '-b', 'y');
    r.write('y.txt', 'y\n');
    r.commitAll('feat: y');
    const yHead = r.git('rev-parse', 'HEAD');
    r.git('checkout', '-q', 'main');
    r.git('merge', '-q', '--no-ff', '-m', 'feat: y (#2)', 'y');
    const copy = (n, over) => JSON.stringify({ pr: n, number: n, default_branch: 'main', title: `PR ${n}`, body: '', author: { login: 'acc1', id: 9001 }, reviews: [], ...over });
    r.write('docs/records/reviews/pr-1.json', copy(1, { base: { ref: 'stack' }, head_sha: mX, merge_commit_sha: mX, merged_at: '2026-11-01T00:00:00Z', reviews: xReviews.map((v) => ({ ...v, commit_id: mX, submitted_at: '2026-11-01T00:00:00Z' })) }));
    r.write('docs/records/reviews/pr-2.json', copy(2, { base: { ref: 'main' }, head_sha: yHead, merge_commit_sha: r.git('rev-parse', 'HEAD'), merged_at: '2026-11-02T00:00:00Z' }));
    r.commitAll('docs: copies');
    return agg(r);
  };
  const line = (a) => lineWith(a.report, '承認の無い層');
  const botOnly = [{ id: 11, user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }, state: 'APPROVED', author_association: 'MEMBER', body: '承認' }];
  const ng = stack(botOnly);
  check('IMPL-0498:ng 集約: bot だけが承認した層の上の PR は、確認ありに数えない(承認の無い層 1 件・数えなかった PR 1 件)', /承認の無い層 1 件。確認ありに数えなかった PR 1 件/.test(line(ng)), line(ng).slice(0, 300) || ng.out.slice(-300));
  const human = [{ id: 12, user: { login: 'acc2', id: 9002, type: 'User' }, state: 'APPROVED', author_association: 'MEMBER', body: '挙動要約: 層 x の追加を差分で確かめた' }];
  const ok = stack(human);
  check('IMPL-0498:ok 集約: 名簿の別の人が承認した層は、承認の無い層に数えない(0 件)', /承認の無い層 0 件。確認ありに数えなかった PR 0 件/.test(line(ok)), line(ok).slice(0, 300));
  const self = stack([{ id: 13, user: { login: 'acc1', id: 9001, type: 'User' }, state: 'APPROVED', author_association: 'MEMBER', body: '挙動要約: 自分で承認した' }]);
  check('IMPL-0498:ng 集約: 作成者本人だけが承認した層も、承認の無い層に数える', /承認の無い層 1 件/.test(line(self)), line(self).slice(0, 300));
  r.done();
}


// ---------------------------------------------------------------- IMPL-1007・0925・0927・0934(安全関連部の検証の記録。基準7)
if (want('1007 0925 0927 0934')) {
  const r = makeRepo({ config: buildCfg({}, { stack: 'node' }), d0Q1: 'はい。制動の制御部を含む' });
  const GOOD_ITEMS = {
    安全関連部の切り分け: '制動の制御部。入出力の境界で切り分けた',
    適用規格と安全度水準: 'ISO 13849-1 / PLr d / 機械の危険源の分析による',
    'AI の利用': 'モデル甲の版 3 / リポジトリの指示ファイル / 段階2 / 担当者乙(段2)',
    独立した評価: '評価者丙 / 段3 / 適合',
  };
  const GOOD_METHOD = ['静的解析', 'HR', '規格X 版Y 表Z', '適用', ''];
  const goodFaults = () => Array.from({ length: 7 }, (_, i) => ['模擬環境(HIL-2)', i === 1 ? '不一致(時間窓なし。早い応答を通す)' : '一致']);
  const render = ({ methods = [GOOD_METHOD], faults = goodFaults() } = {}) => {
    const L = ['# 安全文書', '', '## 安全関連部の検証の記録(適用: 例)', '', '| 項目 | 記入 |', '| --- | --- |'];
    for (const [k, v] of Object.entries(GOOD_ITEMS)) L.push(`| ${k} | ${v} |`);
    L.push('| 適用した手法 | 下の手法の表 |', '| 故障挿入の結果 | 下の表 |', '');
    L.push(`| ${METHOD_COLUMNS.join(' | ')} |`, '| --- | --- | --- | --- | --- |');
    for (const m of methods) L.push(`| ${m.join(' | ')} |`);
    L.push('', '| # | 故障挿入の試験項目 | 挿入した環境 | 結果と期待との一致 |', '| --- | --- | --- | --- |');
    faults.forEach((f, i) => L.push(`| ${i + 1} | 項目${i + 1} | ${f[0]} | ${f[1]} |`));
    L.push('', '## 記入時の注意', '');
    return L.join('\n');
  };
  const faultsWith = (n, env, result) => {
    const f = goodFaults();
    f[n - 1] = [env ?? f[n - 1][0], result ?? f[n - 1][1]];
    return f;
  };
  const LEDGER = [
    '# 技術負債台帳', '', '| ID | 区分 | 対象 | 内容 | 受容した理由 | 顕在化の兆候 | 返却の目安 | 状態 | 記録者 | 承認した者 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| D-5 | 負債 | — | 試験項目2 を省く | 時間 | なし | S3 | 未返却 | 名簿 乙 | — |', '',
  ].join('\n');
  const scene = (text, ledger = null) => {
    r.resetTo('base');
    if (text !== null) r.write('docs/safety-risk-assessment.md', text);
    if (ledger) r.write('docs/debt-ledger.md', ledger);
    r.commitAll('docs: safety');
    return agg(r);
  };
  const B7 = /安全関連部の検証の記録\(基準7\)/;
  const none = scene(null);
  check('IMPL-1007:ng 集約: Q1「はい」で検証の記録が無ければ基準7 の欠落になり、終了コードが 1', hit(none.gaps, B7).length >= 1 && none.status === 1, JSON.stringify(none.gaps.filter((g) => /基準7/.test(g))));
  const good = scene(render());
  check('IMPL-1007:ok 集約: 記入済みの記録なら基準7 の欠落は出ない', hit(good.gaps, B7).length === 0, JSON.stringify(good.gaps.filter((g) => /基準7/.test(g))));
  check('IMPL-0925:ng 集約: 挿入した環境が模擬環境(TBD)なら基準7 の欠落', hit(scene(render({ faults: faultsWith(1, '模擬環境(TBD)') })).gaps, /試験項目1.*挿入した環境/).length === 1);
  check('IMPL-0927:ng 集約: 項目2 の結果が区分「負債」の行の ID を指す例外承認なら基準7 の欠落', hit(scene(render({ faults: faultsWith(2, null, '例外承認: D-5') }), LEDGER).gaps, /試験項目2.*結果/).length === 1);
  check('IMPL-0934:ng 集約: 手法の表の手法の名が空欄なら基準7 の欠落', hit(scene(render({ methods: [['', 'HR', '規格X 版Y 表Z', '適用', '']] })).gaps, B7).length >= 1);
  r.done();
}

// ---------------------------------------------------------------- IMPL-0628・0612・0669(第7章の行使。項目7)
if (want('0628 0612 0669')) {
  const NAMES = (i) => `名簿 ${'甲乙丙丁戊己'[i]}`;
  const r = makeRepo({ config: buildCfg({}, { stack: 'node' }), userName: NAMES(1) });
  const BRIEF = (quota) => r.read('templates/06-project-brief.md').replace(/\r\n/g, '\n').split('\n').map((l) => (l.startsWith('| 例外の枠') ? `| 例外の枠(事業ステージあたり) | ${quota} |` : l)).join('\n');
  const LEDGER = (rows) => `# 技術負債台帳\n\n| ID | 区分 | 対象 | 内容 | 受容した理由 | 顕在化の兆候 | 返却の目安 | 状態 | 記録者 | 承認した者 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`;
  const ROW = (id, target, approver) => `| ${id} | 例外 | ${target} | ファストトラック(短縮: G-6) 急ぎ | 障害 | 再発 | 2026-12-31 まで。回収責任者 ${NAMES(2)} | 未返却 | ${NAMES(1)} | ${approver} |`;
  const scene = ({ approver, b2 = null, quota = '2' }) => {
    r.resetTo('base');
    const day = new Date().toISOString().slice(0, 10);
    const R = { id: 'pay-1', person: NAMES(2), paths: ['src/payments/**'], basis: 'docs/injection/2026-11.md', recordedBy: NAMES(1) };
    const fired = r.runChange({ kind: 'notice', summary: '制限の発動', event: 'restriction', restriction: R, notice: { to: NAMES(3), at: day } });
    r.commitAll('chore: restriction');
    r.write('src/payments/pay.js', 'export const v = 1;\n');
    r.commitAll('fix: payments\n\nRisk: R3\nVerification: 手元で試験を実行し、通過を確かめた');
    const hash = r.git('rev-parse', 'HEAD').slice(0, 8);
    r.write(`docs/gates/g6-${hash}.md`, form04(r, { ゲート: 'G-6 独立レビュー', 対象: `コミット ${hash}`, 判定者: NAMES(2), 判定日時: '2026-11-12 10:00', 結果: '通過', 変更のリスク区分: 'R3' }) + '\n## 挙動要約\n\n支払いの金額の丸めを、端数を切り捨てる挙動へ変えたことを差分で確かめた。\n');
    r.write('docs/debt-ledger.md', LEDGER([ROW('D-10', `コミット ${hash}`, approver)]));
    r.write('docs/project-brief.md', BRIEF(quota));
    if (b2) r.write('docs/D-0-governance.md', r.read('docs/D-0-governance.md').split('\n').map((l) => (l.startsWith('| B-2 |') ? l.replace(/<事業決裁者>/, b2) : l)).join('\n'));
    r.commitAll('docs: ledger');
    const a = agg(r);
    a.fired = fired;
    return a;
  };
  const DEC = /制限された状態での例外決裁 D-10.*B-2 の決定者/;
  const ng = scene({ approver: NAMES(1) });
  check('IMPL-0628:ng 集約: 制限に触れる変更の例外承認を決定者でない者が行えば欠落(前提: 制限の発動を受け付ける)', ng.fired.ok && hit(ng.gaps, DEC).length === 1, `${ng.fired.out.slice(-200)}\n${JSON.stringify(ng.gaps.filter((g) => /D-10/.test(g)))}`);
  const ok = scene({ approver: NAMES(4) });
  check('IMPL-0628:ok 集約: 事業決裁者(B-2 の既定の決定者)の承認は欠落にならない', hit(ok.gaps, DEC).length === 0, JSON.stringify(ok.gaps.filter((g) => /D-10/.test(g))));
  check('IMPL-0628:ok 集約: D-0 の B-2 の欄に名簿の氏名を書けば、その人を決定者として引ける(F-13)', hit(scene({ approver: NAMES(3), b2: NAMES(3) }).gaps, DEC).length === 0);
  check('IMPL-0628:ng 集約: B-2 の欄が氏名なら、その人以外の承認は決定者でない(F-13)', hit(scene({ approver: NAMES(4), b2: NAMES(3) }).gaps, DEC).length === 1);
  check('IMPL-0612:ok 集約: 印のある行の回収完了率の指標が項目7 に出る', /回収完了率/.test(lineWith(ok.report, 'ファストトラック')), lineWith(ok.report, 'ファストトラック').slice(0, 300));
  check('IMPL-0669:ok 集約: 7.9.5 の枠と行使が項目7 に出る(枠 2・行使 1・残り 1)', /枠 2・行使 1・残り 1/.test(lineWith(ok.report, '7.9.4')), lineWith(ok.report, '7.9.4').slice(0, 300));
  r.done();
}


// ---------------------------------------------------------------- 開示の行(IMPL-0622・0739・0683・0710・R1-15)
if (want('0622 0739 0683')) {
  const r = makeRepo({ config: buildCfg({ 'q-biz-phase': 'mvp' }, { stack: 'node' }) });
  // IMPL-0622: S1 以降は、案件に関与していない者による点検(棚卸し)の記録が無ければ注意を出す。記録があれば経過日数を出す
  const none = agg(r);
  check('IMPL-0622:ng 集約: S1 で棚卸しの判定記録が無ければ点検の注意が項目7 に出る', /棚卸しの判定記録なし/.test(lineWith(none.report, '案件に関与していない者による点検')), lineWith(none.report, '点検').slice(0, 300));
  r.resetTo('base');
  r.write('docs/gates/inventory.md', form04(r, { ゲート: '棚卸し', 対象: '案件全体', 判定者: '名簿 丁', 判定日時: '2026-10-01 10:00', 結果: '通過' }));
  r.commitAll('docs: inventory');
  const inv = agg(r);
  check('IMPL-0622:ok 集約: 棚卸しの記録があれば経過日数が出る', /経過 \d+ 日/.test(lineWith(inv.report, '案件に関与していない者による点検')), lineWith(inv.report, '点検').slice(0, 300));
  // IMPL-0739: G-6 未達のまま入った R2 の変更の件数(止めない)
  r.resetTo('base');
  r.write('a.js', 'export const a = 1;\n');
  r.commitAll('fix: a\n\nRisk: R2\nVerification: 手元で試験を実行し、通過を確かめた');
  const r2 = agg(r);
  check('IMPL-0739:ng 集約: G-6 未達の R2 の変更があれば件数 1 件が項目3 に出る', /G-6 未達のまま入った R2[^\n]*: 1 件/.test(r2.report), lineWith(r2.report, 'G-6 未達のまま入った R2').slice(0, 300));
  check('IMPL-0739:ok 集約: 該当の変更が無い出荷でも行は出て 0 件になる', /G-6 未達のまま入った R2[^\n]*: 0 件/.test(none.report), lineWith(none.report, 'G-6 未達のまま入った R2').slice(0, 300));
  // IMPL-0683: 暫定のライセンスの許可と期限が出る(期限の内の許可)
  const lic = buildCfg({ 'q-biz-phase': 'mvp' }, { stack: 'node' });
  lic.ci = { ...(lic.ci ?? {}), provisionalLicenses: [{ license: 'GPL-3.0-only', expires: '2099-12-31', approvedBy: '名簿 戊', reason: '評価のために一時的に使う' }] };
  r.resetTo('base');
  r.writeConfig(lic);
  r.commitAll('chore: provisional license');
  const pl = agg(r);
  check('IMPL-0683:ok 集約: 暫定のライセンスの許可と期限が項目5 に出る', /GPL-3\.0-only\(期限 2099-12-31/.test(pl.report), (pl.report.match(/[^\n]*GPL-3[^\n]*/) ?? [''])[0].slice(0, 200));
  check('IMPL-0683:ng 集約: 許可の無い構成では暫定のライセンスの行は出ない', !/GPL-3\.0-only\(期限/.test(none.report));
  // R1-15: 品質レポートの基準7 の行
  check('R1-15:ok 集約: 基準7 の行は「内容の妥当性は機械では確かめていない」と書く(2列目と3列目が食い違わない)', /7\. 安全適合性の検証記録[^\n]*\| 内容の妥当性は機械では確かめていない/.test(none.report), lineWith(none.report, '7. 安全適合性').slice(0, 300));
  r.done();
}

if (want('0710')) {
  // IMPL-0710: 基準集合の確定者と導入承認者が同一人物
  const seats = seatsOf({ 'value-owner': 'p0', 'tech-lead': 'p5', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4', 'ai-ops': 'p5' });
  const r = makeRepo({ config: buildCfg({}, { stack: 'node', seats }) });
  const put = (confirmedBy) => {
    r.resetTo('base');
    r.write('docs/eval-baseline/cases.json', '[]');
    r.write('docs/eval-baseline/diff.md', '差分\n');
    r.write('docs/eval-baseline/answers.json', JSON.stringify({ cases: [{ id: 'C-1', kind: 'verdict', source: 'new', seat: 'ai-ops', confirmedBy, at: '2026-09-20', draft: { model: 'drafter-1' }, revisions: [] }], blindConfirmation: 'なし' }));
    r.write('docs/model-adoption.json', JSON.stringify({ adoptions: [{ model: 'model-b', provider: 'p', replaces: 'model-a', baseline: 'docs/eval-baseline/', evaluatedAt: '2026-10-03', diff: 'docs/eval-baseline/diff.md', approvedBy: '名簿 己', approvedAt: '2026-10-04', change: '#42', grading: 'deterministic' }] }));
    r.commitAll('docs: adoption');
    return agg(r);
  };
  const same = put('名簿 己');
  check('IMPL-0710:ng 集約: 確定者と導入承認者が同一人物なら、単一障害点の項目に出る', /基準集合の確定者と導入承認者が同一人物/.test(same.report), (same.report.match(/[^\n]*単一障害点[^\n]*/) ?? [''])[0].slice(0, 200));
  const other = put('名簿 丁');
  check('IMPL-0710:ok 集約: 別の人が確定していれば出ない', !/基準集合の確定者と導入承認者が同一人物/.test(other.report));
  r.done();
}

// ---------------------------------------------------------------- IMPL-0743・1019(実行の記録の集計)
if (want('0743')) {
  const r = makeRepo({ config: buildCfg({}, { stack: 'node' }) });
  const SHA = 'a'.repeat(64);
  const ai = (name, trailers = '') => {
    r.write(name, `${name}\n`);
    r.git('add', name);
    r.git('commit', '-q', '-m', `feat: ${name}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>${trailers ? `\n${trailers}` : ''}`);
    return r.git('rev-parse', 'HEAD').slice(0, 10);
  };
  r.resetTo('base');
  // 導入前(.githooks/commit-msg を入れる前)の履歴を作る
  r.git('checkout', '-q', '--orphan', 'hist');
  r.git('rm', '-q', '--cached', '.githooks/commit-msg');
  r.git('commit', '-q', '-m', 'chore: root');
  const root = r.git('rev-parse', 'HEAD');
  const pre = ai('pre.txt');
  r.git('add', '.githooks/commit-msg');
  r.git('commit', '-q', '-m', 'chore: introduce hook');
  const noTrailer = ai('nt.txt');
  const unknown = ai('un.txt', 'Agent-Run: r1\nAgent-Assets: unknown(no-run-record)');
  const clean = ai('cl.txt', `Agent-Run: r2\nAgent-Assets: sha256:${SHA}; base=${'b'.repeat(40)}; assets=clean; user-scope=unrecorded`);
  const a = r.runAggregate(['--from', root, '--to', 'HEAD']);
  const ex = lineWith(a.report, '監査の抽出から外す対象');
  check('IMPL-0743:ng 集約: 導入後のトレーラなしと unknown が外す対象に出る', ex.includes(noTrailer) && ex.includes(unknown), ex.slice(0, 300) || a.out.slice(-300));
  check('IMPL-0743:ng 集約: 導入前のコミットは外す対象に混ざらない', !ex.includes(pre), ex.slice(0, 300));
  check('IMPL-0743:ok 集約: 版を特定できるコミットは外す対象に出ない', !ex.includes(clean), ex.slice(0, 300));
  const line = lineWith(a.report, 'AI の印のあるコミットの指示資産の版');
  check('IMPL-0743:ok 集約: 区分の件数(特定できる 1 件、トレーラなし 1 件、記録なし・読めない 1 件)が出る', /版を特定できる 1 件/.test(line) && /トレーラなし 1 件/.test(line) && /記録なし・読めない 1 件/.test(line), line.slice(0, 400));
  r.resetTo('base');
  r.done();
}
if (want('1019')) {
  // IMPL-1019: 実行の記録(.claude/agent-runs/<id>.json)が JSON として読めても値が不正なら、unknown(unreadable-run-record)
  const r = makeRepo({ config: buildCfg({}, { stack: 'node' }) });
  const val = (rec) => {
    r.write('.claude/agent-runs/run1.json', JSON.stringify(rec));
    return r.node('scripts/gate/agent-run-record.mjs', ['assets', 'run1']).out.trim();
  };
  check('IMPL-1019:ng 値が不正な記録(digest が 64 桁の 16 進でない)は unknown(unreadable-run-record)', val({ runId: 'run1', base: 'x', digest: 'zzz', assets: 'clean' }) === 'unknown(unreadable-run-record)');
  check('IMPL-1019:ng assets の値が不正な記録も unknown(unreadable-run-record)', val({ runId: 'run1', base: 'x', digest: 'a'.repeat(64), assets: 'weird' }) === 'unknown(unreadable-run-record)');
  check('IMPL-1019:ok 正しい記録は要約値つきの値を返す', /^sha256:[0-9a-f]{64}; base=x; assets=(clean|dirty)/.test(val({ runId: 'run1', base: 'x', digest: 'a'.repeat(64), assets: 'clean' })));
  r.done();
}


// IMPL-0523 の宣言行の経路(F-03): G-3 の通過を、PR の宣言行のレビュー(`G-3: 通過`)で受けた判断記録
if (want('0523')) {
  const r = makeRepo({ config: buildCfg({}, { stack: 'node' }) });
  const ADR = (body, st = '採用') => `# ADR-0007 試験\n\n- 状態: ${st}\n- 置き換える決定: なし\n\n## 決定\n\n${body}\n`;
  const scene = (c2text, reviewOnC1) => {
    r.resetTo('base');
    r.write('context/decisions/0007-test.md', ADR('初版'));
    const c1 = r.commitAll('docs: adr 0007 draft');
    r.write('context/decisions/0007-test.md', c2text);
    const c2 = r.commitAll('docs: adr 0007 (#3)');
    const copy = {
      pr: 3, number: 3, default_branch: 'main', title: 'adr', body: '', author: { login: 'acc1', id: 9001 }, base: { ref: 'main' }, head_sha: c2, merge_commit_sha: c2, merged_at: '2026-11-02T00:00:00Z',
      reviews: [{ id: 21, user: { login: 'acc5', id: 9005, type: 'User' }, state: 'COMMENTED', author_association: 'MEMBER', body: 'G-3: 通過\n\nADR-0007 を確認した', commit_id: reviewOnC1 ? c1 : c2, submitted_at: '2026-11-01T00:00:00Z' }],
    };
    r.write('docs/records/reviews/pr-3.json', JSON.stringify(copy));
    r.commitAll('docs: copy');
    return agg(r);
  };
  const MIS = /G-3 で判定した版.*から本文が変わっています/;
  const ng = scene(ADR('書き換え'), true);
  check('IMPL-0523:ng 集約(宣言行): レビューした版の後に PR の中で本文を変えると不一致(欠落)。版は宣言行のレビューの commit_id', hit(ng.gaps, MIS).length === 1 && /不一致 1/.test(lineWith(ng.report, '判断記録の再検査')), JSON.stringify(ng.gaps.filter((g) => /ADR-0007/.test(g))));
  const okState = scene(ADR('初版', '非推奨'), true);
  check('IMPL-0523:ok 集約(宣言行): 状態の行だけの変更は一致', hit(okState.gaps, MIS).length === 0 && /一致 1 \/ 不一致 0/.test(lineWith(okState.report, '判断記録の再検査')));
  const okHead = scene(ADR('書き換え'), false);
  check('IMPL-0523:ok 集約(宣言行): マージ時の head のレビューなら版はマージコミットで、一致', hit(okHead.gaps, MIS).length === 0 && /一致 1 \/ 不一致 0/.test(lineWith(okHead.report, '判断記録の再検査')));
  r.done();
}

finish();
