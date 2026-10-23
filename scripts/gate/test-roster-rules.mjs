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
//   - 価値責任者 × 技術判断者は 10名以上で拒否、3〜9名は非推奨(拒否せず注記と D-0 の記録)。事業決裁者 × 価値責任者は 3名以上で非推奨、どの規模でも拒否しない(process-compass #312)
//   - state:dev-done の受け手は独立レビュアだけ。ready-to-merge は独立レビュアが付ける(process-compass #312)
//   - 回答と名簿・席の人数の食い違いを 3名・10名の境界で出す(process-compass #312 で IMPL-0300 として固定)

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, allowedDeciders, answersRosterNotices, answersRosterProblems, behaviorSummaryKey, confirmerOnRoster, rosterProblems, confirmedAccounts, accountConfirmationProblems, aiAccountCheck, approvalBinding, aiNameBlocked, nameConfirmationProblems, nameConfirmationNotices, nameConfirmationState, nameOverrideDetails, nameOverrides, parseGhVersion, versionBelow, unboundCauseText } from './config.mjs';
import { buildConfig, deciderProblems, seatSeparationFindings, MAILBOX, seatPairingNotes, renderD0Section, d0SectionProblems } from '../init/generate-profile.mjs';
import { headcountProblems } from './config.mjs';
import { discouragedPairings, discouragedUnrecorded } from './org-assurance.mjs';

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

// ---------------------------------------------------------------- アカウント名の確認済みの上書き(#296 L-9)
// AI を示す語に当たる実在の人のアカウントは、本人以外が記名した名簿の変更(変化点の記録)でだけ人として扱う
{
  const devin = { id: 'd', name: 'Devin Smith', accounts: ['devin-smith'], accountsConfirmed: ['devin-smith'], nameConfirmed: true };
  const other = { id: 'y', name: '山田 太郎', accounts: ['yamada'] };
  const base = { people: [devin, other] };
  const byOther = { ...base, changeLog: [{ date: '2026-10-20', decidedBy: '山田 太郎', accountConfirmations: [{ id: 'd', account: 'devin-smith' }] }] };
  const bySelf = { ...base, changeLog: [{ date: '2026-10-20', decidedBy: 'Devin Smith', accountConfirmations: [{ id: 'd', account: 'devin-smith' }] }] };
  const byAi = { ...base, changeLog: [{ date: '2026-10-20', decidedBy: 'Claude', accountConfirmations: [{ id: 'd', account: 'devin-smith' }] }] };
  check('上書き: 記録が無ければ AI の名義として扱う', aiAccountCheck(base, 'devin-smith').reason !== null && !aiAccountCheck(base, 'devin-smith').overridden);
  check('上書き: 記録が無い accountsConfirmed は契約検査が落とす', accountConfirmationProblems(base).length === 1, JSON.stringify(accountConfirmationProblems(base)));
  const ok = aiAccountCheck(byOther, 'devin-smith');
  check('上書き: 本人以外が記名した名簿の変更があれば、人のアカウントとして扱う(上書きした旨を返す)', ok.reason === null && ok.overridden === true && ok.by === '山田 太郎', JSON.stringify(ok));
  check('上書き: 本人以外の記名があれば契約検査は落とさない', accountConfirmationProblems(byOther).length === 0, JSON.stringify(accountConfirmationProblems(byOther)));
  check('上書き: 本人の記名では効かない', aiAccountCheck(bySelf, 'devin-smith').reason !== null && confirmedAccounts(bySelf).size === 0 && accountConfirmationProblems(bySelf).length === 1);
  check('上書き: AI の名義の記名では効かない', aiAccountCheck(byAi, 'devin-smith').reason !== null && confirmedAccounts(byAi).size === 0);
  check('上書き: [bot] の表記は上書きしない', aiAccountCheck(byOther, 'devin-smith[bot]').reason !== null);
  check('上書き: ホスティングが bot と返す名義は上書きしない', aiAccountCheck(byOther, 'devin-smith', true).reason !== null);
  check('上書き: 名簿の accountsConfirmed に無ければ、記録があっても効かない', aiAccountCheck({ ...byOther, people: [{ ...devin, accountsConfirmed: [] }, other] }, 'devin-smith').reason !== null);
  const rp = rosterProblems({ ...byOther, people: [{ ...devin, accountsConfirmed: ['someone-else'] }, other] });
  check('名簿: accountsConfirmed は本人の accounts に無いアカウントを書けない', rp.some((m) => /accounts に無い/.test(m)), JSON.stringify(rp));
}

// ---------------------------------------------------------------- 氏名の確認(nameConfirmed。#296 裁定 8 の付記)
// AI を示す語に当たる実在の氏名も、本人以外が記名した名簿の変更(変化点の記録)でだけ通す
{
  const devin = { id: 'd', name: 'Devin Smith', nameConfirmed: true };
  const other = { id: 'y', name: '山田 太郎' };
  const base = { people: [devin, other] };
  const rec = (decidedBy) => ({ ...base, changeLog: [{ date: '2026-10-20', decidedBy, nameConfirmations: [{ id: 'd' }] }] });
  check('氏名の確認: 記録が無ければ AI の名義として拒否し、契約検査が落とす', aiNameBlocked(base, 'Devin Smith') !== null && nameConfirmationProblems(base).length === 1 && nameOverrides(base).length === 0);
  check('氏名の確認: 本人以外の記名があれば通し、上書きとして表示する', aiNameBlocked(rec('山田 太郎'), 'Devin Smith') === null && nameConfirmationProblems(rec('山田 太郎')).length === 0 && nameOverrides(rec('山田 太郎'))[0] === 'Devin Smith');
  check('氏名の確認: 本人の記名では効かない', aiNameBlocked(rec('Devin Smith'), 'Devin Smith') !== null && nameConfirmationProblems(rec('Devin Smith')).length === 1);
  check('氏名の確認: AI の名義の記名では効かない', aiNameBlocked(rec('Claude'), 'Devin Smith') !== null);
  check('氏名の確認: 記録があっても名簿の nameConfirmed が無ければ効かない', aiNameBlocked({ ...rec('山田 太郎'), people: [{ id: 'd', name: 'Devin Smith' }, other] }, 'Devin Smith') !== null);
  // 体制の内の人が1名の名簿(追加の裁定): 本人の記名を受け付け、自己申告の氏名として出す。記録の無い確認は落とさず、未記録として知らせる
  const solo = { people: [devin, { id: 'x', name: '外部 確認', external: true }] };
  const soloSelf = { ...solo, changeLog: [{ date: '2026-10-20', decidedBy: 'Devin Smith', nameConfirmations: [{ id: 'd' }] }] };
  check('1名の体制: 本人の記名の確認を受け付け、自己申告として開示する', aiNameBlocked(soloSelf, 'Devin Smith') === null && nameConfirmationState(soloSelf, devin) === 'self' && nameConfirmationProblems(soloSelf).length === 0 && nameOverrideDetails(soloSelf)[0]?.how === 'self' && /自己申告/.test(nameConfirmationNotices(soloSelf)[0] ?? ''));
  check('1名の体制: 記録の無い確認は落とさず効かせ、未記録として記録する手順を知らせる', aiNameBlocked(solo, 'Devin Smith') === null && nameConfirmationProblems(solo).length === 0 && /未記録/.test(nameConfirmationNotices(solo)[0] ?? '') && /\/process-change/.test(nameConfirmationNotices(solo)[0] ?? ''));
  check('2名以上の体制: 本人の記名の記録は効かず、契約検査が落とす(記録する手順を出す)', nameConfirmationState(rec('Devin Smith'), devin) === 'invalid' && /\/process-change/.test(nameConfirmationProblems(rec('Devin Smith'))[0] ?? ''));
  check('2名以上の体制: 本人以外の記名は自己申告として扱わない', nameConfirmationState(rec('山田 太郎'), devin) === 'other' && nameConfirmationNotices(rec('山田 太郎')).length === 0);
  const { diffConfig } = await import('../init/generate-profile.mjs');
  const soloBefore = { configured: true, gates: {}, seats: [], people: solo.people };
  check('1名の体制: 未記録の確認は、次の変化点で記名して記録する項目になる', diffConfig(soloBefore, soloBefore).nameConfirmItems.length === 1);
  check('1名の体制: 本人の記名の記録がある確認は、再び項目にしない', diffConfig({ ...soloBefore, changeLog: soloSelf.changeLog }, { ...soloBefore, changeLog: soloSelf.changeLog }).nameConfirmItems.length === 0);
  check('2人目が加わると、本人の記名だけの確認は本人以外の記名を要する項目になる', diffConfig({ ...soloBefore, changeLog: soloSelf.changeLog }, { ...soloBefore, people: [devin, other], changeLog: soloSelf.changeLog }).nameConfirmItems.length === 1);
  const before = { configured: true, gates: {}, people: [{ id: 'd', name: 'Devin Smith' }, other], seats: [] };
  const after = { ...before, people: [devin, other] };
  const rep = diffConfig(before, after);
  check('氏名の確認: 名簿へ nameConfirmed を足す変更は、本人以外の記名を要する項目になる', rep.nameConfirmItems?.length === 1 && rep.nameConfirmItems[0].id === 'd', JSON.stringify(rep.nameConfirmItems));
  check('氏名の確認: 既に有効な記録がある確認は、再び項目にしない', diffConfig({ ...rec('山田 太郎'), configured: true, gates: {}, seats: [] }, { ...rec('山田 太郎'), configured: true, gates: {}, seats: [] }).nameConfirmItems.length === 0);
  check('氏名の確認: #296 より前に書いた確認(記録なし)は、次の変化点で項目になる', diffConfig({ ...before, people: [devin, other] }, { ...before, people: [devin, other] }).nameConfirmItems.length === 1);
}

// ---------------------------------------------------------------- gh の版(#296 突合 X-7)
check('gh の版: gh --version の出力を読む', parseGhVersion('gh version 2.45.0 (2024-03-04)\nhttps://github.com/cli/cli/releases/tag/v2.45.0') === '2.45.0');
check('gh の版: 2.30.0 より前は commit.oid を返さない旨を出す', versionBelow('2.20.2', '2.30.0') === true && /2\.30\.0/.test(unboundCauseText('2.20.2') ?? ''));
check('gh の版: 2.30.0 以上は原因の文を出さない', unboundCauseText('2.30.0') === null && unboundCauseText('2.61.1') === null);
check('gh の版: 読めなければ確かめるよう出す', /読めません/.test(unboundCauseText(null) ?? ''));

// ---------------------------------------------------------------- 承認した版(#296 L-2)
check('承認した版: 先頭のコミットと同じなら数える', approvalBinding({ commit: { oid: 'ABC' } }, 'abc') === 'bound');
check('承認した版: 承認の後に更新があれば数えない(stale)', approvalBinding({ commit_id: 'abc' }, 'def') === 'stale');
check('承認した版: 版を確かめられなければ数えない(unknown)', approvalBinding({}, 'def') === 'unknown' && approvalBinding({ commit: { oid: 'abc' } }, null) === 'unknown');

// ---------------------------------------------------------------- 非推奨の兼務と 10名以上の禁止(#312)
{
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊己庚辛壬癸'[i]}`, accounts: [`acc${i}`] }));
  const base = { 'q-biz-phase': 'growth', 'q-external-reviewer': 'reviewer-yes' };
  const seats10 = seatsOf({ 'value-owner': 'p0', 'tech-lead': 'p0', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' });
  const large = build({ ...base, 'q-team-size': 'size-10plus' }, { people: many, seats: seats10 });
  check('10名以上: 価値責任者 × 技術判断者の兼務は拒否する(sep-size)', seatSeparationFindings(large).violations.some((v) => /価値責任者/.test(v) && /技術判断者/.test(v)), JSON.stringify(seatSeparationFindings(large).violations));
  check('10名以上: 価値責任者 × 技術判断者の禁止は非推奨の注記にしない', discouragedPairings(large).length === 0);
  const mid = build({ ...base, 'q-team-size': 'size-3-9' }, { people: many.slice(0, 5), seats: seats10 });
  check('3〜9名: 価値責任者 × 技術判断者の兼務は拒否しない', seatSeparationFindings(mid).violations.length === 0, JSON.stringify(seatSeparationFindings(mid).violations));
  check('3〜9名: 価値責任者 × 技術判断者の兼務を非推奨の注記に出す', seatPairingNotes(mid).some((n) => /非推奨の兼務/.test(n) && /価値責任者/.test(n)), JSON.stringify(seatPairingNotes(mid)));
  const bizSeats = seatsOf({ 'value-owner': 'p0', 'biz-approver': 'p0', 'tech-lead': 'p5', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3' });
  const bizLarge = build({ ...base, 'q-team-size': 'size-10plus' }, { people: many, seats: bizSeats });
  check('10名以上: 事業決裁者 × 価値責任者の兼務は拒否しない', seatSeparationFindings(bizLarge).violations.length === 0, JSON.stringify(seatSeparationFindings(bizLarge).violations));
  check('10名以上: 事業決裁者 × 価値責任者の兼務を非推奨の注記に出す', discouragedPairings(bizLarge).some((p) => p.id === 'biz-value'));
  const small = build({ ...base, 'q-team-size': 'size-1-2' }, { people: [A, B], seats: seatsOf({ 'value-owner': 'a', 'tech-lead': 'a', 'biz-approver': 'a', 'dev-verifier': 'a', 'independent-reviewer': 'b' }) });
  check('1〜2名: 非推奨の兼務の対象にしない(許容)', discouragedPairings(small).length === 0);

  const d0 = (rows) => `# D-0\n\n## 2. 兼務の可否\n\n### 非推奨の兼務の記録\n\n| 兼務する組 | 責任者 | 兼務を選んだ理由 | 記録日 |\n| --- | --- | --- | --- |\n${rows}\n\n## 3. 決定の権限\n`;
  check('記録: 表の行が無ければ記載の欠落', discouragedUnrecorded(mid, d0('| | | | |')).length === 1);
  check('記録: 組・責任者・理由のある行があれば欠落にしない', discouragedUnrecorded(mid, d0('| 価値責任者 × 技術判断者 | 名簿 甲 | 技術判断を担える人が他にいない | 2026-10-23 |')).length === 0);
  check('記録: 理由が空欄なら欠落', discouragedUnrecorded(mid, d0('| 価値責任者 × 技術判断者 | 名簿 甲 | | 2026-10-23 |')).length === 1);
  check('記録: 別の組の行では欠落を解かない', discouragedUnrecorded(mid, d0('| 事業決裁者 × 価値責任者 | 名簿 甲 | 理由 | 2026-10-23 |')).length === 1);
  check('記録: D-0 が無ければ欠落を出さない(D-0 の欠落は別に出る)', discouragedUnrecorded(mid, null).length === 0);
}

// ---------------------------------------------------------------- 受信箱のラベル(#312)
check('dev-done の受け手は独立レビュアだけ', Object.entries(MAILBOX).filter(([, m]) => m.inbox.includes('state:dev-done')).map(([r]) => r).join(',') === 'independent-reviewer');
check('ready-to-merge を付けるのは独立レビュアだけ', Object.entries(MAILBOX).filter(([, m]) => m.hands.includes('state:ready-to-merge')).map(([r]) => r).join(',') === 'independent-reviewer');
check('ready-to-merge は出荷判定者の受信箱に入る', MAILBOX['qa-gatekeeper'].inbox.includes('state:ready-to-merge'));
check('事業決裁者の受信箱は needs-owner(価値責任者の受信箱と分ける)', MAILBOX['biz-approver'].inbox.includes('state:needs-owner') && !MAILBOX['value-owner'].inbox.includes('state:needs-owner'));

// ---------------------------------------------------------------- 回答と人数の食い違い(#312。IMPL-0300)
{
  const people = (k) => Array.from({ length: k }, (_, i) => ({ id: `h${i}`, name: `人数 ${i}号`, accounts: [`h${i}`] }));
  const cfg = (size, k) => ({ answers: { 'q-team-size': size }, people: people(k), seats: [] });
  check('人数: 1〜2名の回答で名簿に3名なら出す', headcountProblems(cfg('size-1-2', 3)).length === 1);
  check('人数: 3〜9名の回答で名簿に10名なら出す', headcountProblems(cfg('size-3-9', 10)).length === 1);
  check('人数: 10名以上の回答で名簿に5名なら出す', headcountProblems(cfg('size-10plus', 5)).length === 1);
  check('人数: 3〜9名の回答で名簿に2名なら出す', headcountProblems(cfg('size-3-9', 2)).length === 1);
  check('人数: 3名以上の回答で名簿が空なら出さない(降りていない差。IMPL-0278)', headcountProblems(cfg('size-3-9', 0)).length === 0);
  check('人数: 外部の確認者は数えない', headcountProblems({ answers: { 'q-team-size': 'size-1-2' }, people: [...people(2), { ...X }], seats: [] }).length === 0);
}

// ---------------------------------------------------------------- D-0 節1 の氏名の確認の列(#312)
{
  const nc = build({ 'q-team-size': 'size-1-2', 'q-biz-phase': 'mvp', 'q-external-reviewer': 'reviewer-yes' }, { people: [{ ...A, nameConfirmed: true }], seats: seatsOf({ 'dev-verifier': 'a' }) });
  const cur = renderD0Section('seats', nc);
  const old = renderD0Section('seats', nc, { legacy: true });
  check('名簿に nameConfirmed があれば、氏名の確認の列を出す', /氏名の確認/.test(cur) && !/氏名の確認/.test(old));
  const wrap = (body) => ['seats', 'performers', 'history'].map((k) => `<!-- generated:d0-${k} start -->\n\n${k === 'seats' ? body : renderD0Section(k, nc)}\n\n<!-- generated:d0-${k} end -->`).join('\n\n');
  check('列の無い旧い生成区間も一致として受け付ける', d0SectionProblems(wrap(old), nc).length === 0 && d0SectionProblems(wrap(cur), nc).length === 0, JSON.stringify(d0SectionProblems(wrap(old), nc)));
}

console.log('');
if (failures) {
  console.log(`独立と席の規則の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`独立と席の規則の試験: ${n} 件が期待と一致しました`);
