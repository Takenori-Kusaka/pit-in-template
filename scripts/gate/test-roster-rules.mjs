// 独立と席の規則の試験(標準 第3章 3.5、第4章 G-6・G-7、第8章 軸A・軸B・軸E。process-compass #302・#304・#305・#307)。
//
//   node scripts/gate/test-roster-rules.mjs
//
// 構成の生成(buildConfig)と、構成だけから導く検査を、リポジトリの状態を変えずに呼びます。GitHub へ問い合わせません。
// 固定する決定:
//   - 確認者を置けるかどうかは、人の名簿と席から導く。設問への回答は根拠にしない。席が未記入のあいだは未達(ADR-0065 決定5)
//   - 未達は体制の表示で、事業ステージで変わらない。確認者を置けない体制は S0 でも未達、置ける体制の S0 は省略(同 決定2)
//   - S0・標準品質・CL0 は G-6・G-7 を省略する。CL1 以上は S0 でも G-6 を適用する(同 決定1・3)
//   - 3名以上の体制で、出荷判定者の席は、開発者の席とも独立レビュアの席とも兼ねない(ADR-0066 決定1)
//   - 強制する承認の数は、構成の承認者の数から導く。CL2 は 1名(ADR-0067 決定5)
//   - 同一の文の挙動要約は、2件目に数えない(ADR-0067 決定3)
//   - 独立レビュアの席の責任者に置いた外部の確認者に、その席の統制を緩める向きの決定権を与えない(ADR-0060 決定2)

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, allowedDeciders, answersRosterNotices, answersRosterProblems, behaviorSummaryKey, confirmerOnRoster } from './config.mjs';
import { buildConfig, deciderProblems, seatSeparationFindings } from '../init/generate-profile.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

// 較正の引き継ぎの案内(console.log)を、試験の出力へ混ぜない
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

const COMMON = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free' };
const A = { id: 'a', name: '山田 太郎', accounts: ['yamada'] };
const B = { id: 'b', name: '佐藤 花子', accounts: ['sato'] };
const C = { id: 'c', name: '鈴木 一郎', accounts: ['suzuki'] };
const X = { id: 'x', name: '高橋 次郎', external: true, accounts: ['takahashi-j'] };
const seatsOf = (map) => Object.entries(map).map(([role, accountable]) => ({ role, accountable }));
const build = (answers, opts = {}) => quiet(() => buildConfig({ ...COMMON, ...answers }, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, ...opts }).config);

// ---------------------------------------------------------------- 確認者の有無は、名簿と席から導く
for (const [stage, withConfirmer] of [['poc', 'omitted'], ['mvp', 'required'], ['growth', 'required']]) {
  for (const answer of ['reviewer-yes', 'reviewer-no']) {
    const a = { 'q-team-size': 'size-1-2', 'q-biz-phase': stage, 'q-external-reviewer': answer };
    const blank = build(a);
    check(`${stage}・${answer}: 名簿が空(席が未記入)なら G-6 は未達`, blank.gates.g6.state === 'unmet' && blank.unmet.some((u) => u.gate === 'g6'), blank.gates.g6.state);
    const devOnly = build(a, { people: [A, B], seats: seatsOf({ 'dev-verifier': 'a' }) });
    check(`${stage}・${answer}: 独立レビュアの席が未記入なら未達(2人目が名簿にいても)`, devOnly.gates.g6.state === 'unmet', devOnly.gates.g6.state);
    const same = build(a, { people: [A], seats: seatsOf({ 'dev-verifier': 'a', 'independent-reviewer': 'a' }) });
    check(`${stage}・${answer}: 2つの席が同一人物なら未達`, same.gates.g6.state === 'unmet', same.gates.g6.state);
    check(`${stage}・${answer}: 未達の構成は、代償措置の CI の下限(90)と、承認の強制なしになる`, same.ci.coverageThreshold === 90 && same.review.requiredApprovals === 0 && same.ruleset === null, JSON.stringify([same.ci.coverageThreshold, same.review.requiredApprovals, same.ruleset]));
  }
  const yes = { 'q-team-size': 'size-1-2', 'q-biz-phase': stage, 'q-external-reviewer': 'reviewer-yes' };
  const two = build(yes, { people: [A, B], seats: seatsOf({ 'dev-verifier': 'a', 'independent-reviewer': 'b' }) });
  check(`${stage}・確認者を席から確かめられる2名: G-6 は ${withConfirmer}(未達ではない)`, two.gates.g6.state === withConfirmer && !two.unmet.some((u) => u.gate === 'g6'), two.gates.g6.state);
  const ext = build(yes, { people: [A, X], seats: seatsOf({ 'dev-verifier': 'a', 'independent-reviewer': '高橋 次郎' }) });
  check(`${stage}・外部の確認者を独立レビュアの席の責任者に置いた1名: G-6 は ${withConfirmer}`, ext.gates.g6.state === withConfirmer, ext.gates.g6.state);
  const rosterOnly = build(yes, { people: [A, X], seats: seatsOf({ 'dev-verifier': 'a', 'independent-reviewer': 'a' }) });
  check(`${stage}・外部の確認者を名簿にだけ載せた1名: 構成上の G-6 は未達のまま`, rosterOnly.gates.g6.state === 'unmet', rosterOnly.gates.g6.state);
}
{
  const yes = { 'q-team-size': 'size-1-2', 'q-biz-phase': 'poc', 'q-external-reviewer': 'reviewer-yes' };
  const blank = build(yes);
  check('未達の理由に、席が未記入であることと、回答を根拠にしないことが出る', /席の責任者が未記入/.test(blank.unmet[0].reason) && /回答は判定の根拠にしない/.test(blank.unmet[0].reason), blank.unmet[0].reason);
  check('回答「いる」・席が未記入: 食い違いの注記が出る(拒否はしない)', answersRosterNotices(blank).length === 1 && answersRosterProblems(blank).length === 0, JSON.stringify(answersRosterNotices(blank)));
  const no = build({ ...yes, 'q-external-reviewer': 'reviewer-no' });
  check('回答「いない」・席が未記入: 食い違いではない(注記なし)', answersRosterNotices(no).length === 0 && answersRosterProblems(no).length === 0);
  const noButOther = build({ ...yes, 'q-external-reviewer': 'reviewer-no' }, { people: [A, B], seats: seatsOf({ 'dev-verifier': 'a', 'independent-reviewer': 'b' }) });
  check('回答「いない」・席に別の人: 回答と名簿の矛盾として拒否する(従来どおり)', answersRosterProblems(noButOther).length === 1, JSON.stringify(answersRosterProblems(noButOther)));
  const ok = build(yes, { people: [A, B], seats: seatsOf({ 'dev-verifier': 'a', 'independent-reviewer': 'b' }) });
  check('回答「いる」・席に別の人: 注記も矛盾も無い', answersRosterNotices(ok).length === 0 && answersRosterProblems(ok).length === 0);
  check('confirmerOnRoster: 3名以上の体制には当てない', confirmerOnRoster(build({ 'q-team-size': 'size-3-9', 'q-biz-phase': 'mvp' })).applies === false);
}

// ---------------------------------------------------------------- S0 の省略と、CL1 以上
for (const size of ['size-3-9', 'size-10plus']) {
  const s0 = build({ 'q-team-size': size, 'q-biz-phase': 'poc' });
  check(`${size}・S0・標準品質・CL0: G-6 と G-7 は省略、G-8 は適用`, s0.gates.g6.state === 'omitted' && s0.gates.g7.state === 'omitted' && s0.gates.g8.state === 'required', JSON.stringify([s0.gates.g6.state, s0.gates.g7.state, s0.gates.g8.state]));
  for (const cl of ['cl1', 'cl2', 'cl3']) {
    const c = build({ 'q-team-size': size, 'q-biz-phase': 'poc', 'q-criticality': cl });
    check(`${size}・S0・${cl.toUpperCase()}: G-6 は適用(承認を強制する)`, c.gates.g6.state === 'required' && c.review.requiredApprovals >= 1 && Boolean(c.ruleset), JSON.stringify([c.gates.g6.state, c.review.requiredApprovals, c.ruleset]));
  }
}

// ---------------------------------------------------------------- 出荷判定者の席は、開発者の席とも独立レビュアの席とも兼ねない
{
  const three = { 'q-team-size': 'size-3-9', 'q-biz-phase': 'growth' };
  const all = (m) => seatsOf({ 'biz-approver': 'a', 'value-owner': 'a', 'tech-lead': 'a', 'context-owner': 'a', 'ai-maintainer': 'a', 'ai-ops': 'c', ...m });
  const bad = build(three, { people: [A, B, C], seats: all({ 'dev-verifier': 'b', 'independent-reviewer': 'c', 'qa-gatekeeper': 'c' }) });
  const f = seatSeparationFindings(bad);
  check('3名: 独立レビュア = 出荷判定者 は兼務禁止に抵触する', f.violations.some((v) => v.includes('独立レビュア') && v.includes('出荷判定者')), JSON.stringify(f.violations));
  const dev = build(three, { people: [A, B, C], seats: all({ 'dev-verifier': 'c', 'independent-reviewer': 'a', 'qa-gatekeeper': 'c' }) });
  check('3名: 開発者 = 出荷判定者 は兼務禁止に抵触する(従来どおり)', seatSeparationFindings(dev).violations.some((v) => v.includes('開発者') && v.includes('出荷判定者')));
  const good = build(three, { people: [A, B, C], seats: all({ 'dev-verifier': 'b', 'independent-reviewer': 'a', 'qa-gatekeeper': 'c' }) });
  check('3名: 3つの席が別の人なら抵触しない(独立レビュアは価値責任者・技術判断者・事業決裁者と兼ねてよい)', seatSeparationFindings(good).violations.length === 0, JSON.stringify(seatSeparationFindings(good).violations));
  const vo = build(three, { people: [A, B, C], seats: seatsOf({ 'biz-approver': 'a', 'value-owner': 'c', 'tech-lead': 'c', 'context-owner': 'c', 'ai-maintainer': 'a', 'ai-ops': 'c', 'dev-verifier': 'b', 'independent-reviewer': 'a', 'qa-gatekeeper': 'c' }) });
  check('3名: 出荷判定者が価値責任者・技術判断者・文脈オーナー・AI運用担当者を兼ねることは禁じない', seatSeparationFindings(vo).violations.length === 0, JSON.stringify(seatSeparationFindings(vo).violations));
  const two = build({ 'q-team-size': 'size-1-2', 'q-biz-phase': 'growth', 'q-external-reviewer': 'reviewer-yes' }, { people: [A, B], seats: seatsOf({ 'biz-approver': 'a', 'value-owner': 'a', 'tech-lead': 'a', 'context-owner': 'a', 'ai-maintainer': 'a', 'ai-ops': 'b', 'dev-verifier': 'a', 'independent-reviewer': 'b', 'qa-gatekeeper': 'b' }) });
  const f2 = seatSeparationFindings(two);
  check('2名: 独立レビュア = 出荷判定者 は拒否せず、代償措置つきの例外(第3章 3.5.2)として扱う', f2.violations.length === 0 && f2.excepted.some((v) => v.includes('独立レビュア') && v.includes('出荷判定者')), JSON.stringify(f2));
  check('2名: 出荷判定(G-7)の兼務は逸脱として記録される', two.deviations.some((d) => d.gate === 'g7'));
}

// ---------------------------------------------------------------- 強制する承認の数(ルールセット)
{
  const g = { 'q-team-size': 'size-3-9', 'q-biz-phase': 'growth' };
  const cl2 = build({ ...g, 'q-criticality': 'cl2' });
  check('CL2: 承認者は1名、ルールセットは safety(承認 1)', cl2.review.reviewerCount === 1 && cl2.ruleset === 'safety', JSON.stringify([cl2.review.reviewerCount, cl2.ruleset]));
  const cl3 = build({ ...g, 'q-criticality': 'cl3' });
  check('CL3: 承認者は2名、ルールセットは regulated(承認 2)', cl3.review.reviewerCount === 2 && cl3.ruleset === 'regulated', JSON.stringify([cl3.review.reviewerCount, cl3.ruleset]));
  const reg = build({ ...g, 'q-quality': 'quality-regulated' });
  check('規制業: 承認者は2名、ルールセットは regulated', reg.review.reviewerCount === 2 && reg.ruleset === 'regulated', JSON.stringify([reg.review.reviewerCount, reg.ruleset]));
  const std = build(g);
  check('標準品質・CL0: ルールセットは team', std.ruleset === 'team', String(std.ruleset));
  const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, '.github/rulesets', `${name}.json`), 'utf8'));
  const prOf = (r) => r.rules.find((x) => x.type === 'pull_request').parameters;
  check('safety.json: 承認 1。ほかの設定は regulated.json と同じ', read('safety').name === 'safety' && prOf(read('safety')).required_approving_review_count === 1 && JSON.stringify({ ...prOf(read('safety')), required_approving_review_count: 2 }) === JSON.stringify(prOf(read('regulated'))) && JSON.stringify(read('safety').rules.slice(1)) === JSON.stringify(read('regulated').rules.slice(1)));
  for (const [cfg, name] of [[cl2, 'safety'], [cl3, 'regulated'], [std, 'team']]) {
    check(`${name}.json の承認の数は、構成の承認者の数と一致する`, prOf(read(name)).required_approving_review_count === cfg.review.reviewerCount);
  }
}

// ---------------------------------------------------------------- 同一の文の挙動要約
{
  const k = behaviorSummaryKey;
  check('挙動要約: 空白・記号・見出し語だけが違う文は同一として扱う', k('挙動要約: 差分を読み、招待の失効の分岐を自分で確かめた') === k('差分を読み、 招待の失効の分岐を、自分で確かめた。'));
  check('挙動要約: 別の文は同一として扱わない', k('差分を読み、招待の失効の分岐を自分で確かめた') !== k('失効した招待を開くと再発行の画面へ進むことを確かめた'));
  check('挙動要約: 最低限の形を満たさない本文は比べない(null)', k('LGTM') === null && k('') === null);
}

// ---------------------------------------------------------------- 外部の確認者と、緩める向きの決定
{
  const yes = { 'q-team-size': 'size-1-2', 'q-biz-phase': 'mvp', 'q-external-reviewer': 'reviewer-yes' };
  const ext = build(yes, { people: [A, X], seats: seatsOf({ 'biz-approver': 'a', 'dev-verifier': 'a', 'independent-reviewer': '高橋 次郎' }) });
  const d = allowedDeciders(ext, 'independent-reviewer');
  check('独立レビュアの席の責任者が外部の確認者: その席の緩める向きの決定者に含めない(決定者だけ)', !d.has('x') && d.has('a') && d.size === 1, JSON.stringify([...d]));
  const two = build(yes, { people: [A, B], seats: seatsOf({ 'biz-approver': 'a', 'dev-verifier': 'a', 'independent-reviewer': 'b' }) });
  const d2 = allowedDeciders(two, 'independent-reviewer');
  check('独立レビュアの席の責任者が体制の内の人: 席の責任者も決定できる(従来どおり)', d2.has('b') && d2.has('a'), JSON.stringify([...d2]));
  // 変化点の検査(deciderProblems)が、外部の確認者の記名による緩める向きの決定を拒否すること
  const report = { loosenItems: [{ line: '独立レビュア: 協働 → 委任', seat: 'independent-reviewer' }], appointItems: [], renameItems: [], priorDeciderPresent: true, priorDecider: 'a' };
  const byExt = deciderProblems(ext, report, '高橋 次郎', ext);
  check('独立レビュアの席の委任の宣言: 外部の確認者(席の責任者)の記名では受け付けない', byExt.length === 1 && /外部の確認者であり/.test(byExt[0]) && /席の責任者の記名では受け付けません/.test(byExt[0]), JSON.stringify(byExt));
  check('同: D-0 表1 の決定者(事業決裁者の席の責任者)の記名なら受け付ける', deciderProblems(ext, report, '山田 太郎', ext).length === 0, JSON.stringify(deciderProblems(ext, report, '山田 太郎', ext)));
  check('体制の内の人が責任者である独立レビュアの席: 席の責任者の記名で受け付ける(従来どおり)', deciderProblems(two, report, '佐藤 花子', two).length === 0, JSON.stringify(deciderProblems(two, report, '佐藤 花子', two)));
}

console.log('');
if (failures) {
  console.log(`独立と席の規則の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`独立と席の規則の試験: ${n} 件が期待と一致しました`);
