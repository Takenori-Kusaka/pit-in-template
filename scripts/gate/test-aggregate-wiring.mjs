// 出荷の証跡の集約(aggregate-evidence.mjs)の結線の試験。実物の集約を、使い捨てのリポジトリで動かす(process-compass #448 / 束 B20 の独立の突合 1巡目の所見)。
//
//   node scripts/gate/test-aggregate-wiring.mjs
//
// 単体の試験(test-aggregate-records.mjs など)は判定の論理を守るが、集約から呼ぶ行を消しても通る。ここは「違反の場面で欠落や開示の行が出ること」と
// 「適合の場面で出ないこと」を、実物の集約の出力(evidence/evidence.json の gaps と品質レポート)で固定する。場面は基点のタグへ戻して使い回す。
// GitHub へ問い合わせない。PR は基底ブランチの写し(docs/records/reviews/pr-N.json)と、ローカルの git の履歴で渡す。
import fs from 'node:fs';
import { makeRepo, buildCfg, checker, lineWith } from './e2e-fixture.mjs';

const { check, finish } = checker();
const FROM = ['--from', 'base', '--to', 'HEAD'];
const agg = (r) => r.runAggregate(FROM);
const hit = (gaps, re) => gaps.filter((g) => re.test(g));
const HOLD = /出荷しません/;

// ---------------------------------------------------------------- IMPL-0738(人の確認の未達は CL1 以上と規制業で出荷を止める。G-3 は開示だけ)
{
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
{
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
{
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

{
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

finish();
