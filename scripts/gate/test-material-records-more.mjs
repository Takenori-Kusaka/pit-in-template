// 効力を持つ記録のうち、層1・D-0 の決定の記名・前倒しで要る SG の判定記録の帰属の試験(標準 第4章「判定記録を基底ブランチへ
// 入れる操作」。process-compass #428 / ADR-0106 決定5 / IMPL-0415)。
//
//   node scripts/gate/test-material-records-more.mjs
//
// 次を確かめます。
//   - 部品(material-attribution.mjs): 帰属を要する変化点の判定、宣言した時点の変化点の添字、変化点を入れたコミット、sgRecord の所在、
//     層1 の帰属、検査する PR 自身の帰属の材料、任命権者の記名者の承認
//   - 権限者の照合(org-assurance.mjs の checkAuthority): 帰属を確かめられない層1 は項目4 を使わず、事業決裁者の席へ戻す
//   - PR の時点の検査(check-pr.mjs の analyzePr): 層1 の帰属で停止の解除の権限者が変わる。PR が足した D-0 の決定の記名と、
//     前倒しで要る SG の判定記録の帰属を確かめ、満たさなければ失敗させる
//   - 出荷の集約(aggregate-evidence.mjs)の通し: 範囲の中の D-0 の決定の記名の帰属を確かめられなければ欠落にする(模擬の gh を
//     使わないため、裏づけのある場面は回帰の試験 scripts/regress/ が確かめる)
// GitHub へ問い合わせません。ホスティングの記録は代役(prOfCommit・pullCommitAuthors)で渡します。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { analyzePr } from './check-pr.mjs';
import { checkAuthority, readPolicy } from './org-assurance.mjs';
import {
  commitOfChangeLogEntry,
  decisionNeedsAttribution,
  fixedHosting,
  introducedBacking,
  policyAttribution,
  pullInfoOf,
  sgRecordPath,
  signatureIndexOf,
  withPolicyAttribution,
} from './material-attribution.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 900)}`}`);
}

// 名簿とホスティングの記録の数値の識別子(名簿の照合は識別子で行う。process-compass #430)
const UID = { yamada: 1001, suzuki: 1002, sato: 1003, boss: 1004, tester: 1009 };
const acct = (login) => ({ login, id: UID[login] });
const PEOPLE = [
  { id: 'p1', name: '山田 太郎', accounts: [acct('yamada')] },
  { id: 'p2', name: '鈴木 一郎', accounts: [acct('suzuki')] },
  { id: 'p3', name: '佐藤 花子', accounts: [acct('sato')] },
];
const SEATS = [
  { role: 'biz-approver', accountable: '佐藤 花子' },
  { role: 'qa-gatekeeper', accountable: '鈴木 一郎' },
];
const POLICY = (signer = '鈴木 一郎') =>
  `# 品質保証の方針と受容の基準(層1)\n\n| 項目 | 値 |\n| --- | --- |\n| 版 | v1.0 |\n| 記名(記名者) | ${signer} |\n| 記名日 | 2026-10-01 |\n\n` +
  '## 4. 受容の権限の段階\n\n| 受容の対象 | 受容できる水準 | 受容者(役割) | 受容の期限 |\n| --- | --- | --- | --- |\n| 停止の申し立ての解除 | 解除 | 出荷判定者 | 即時 |\n';

// ---------------------------------------------------------------- 部品
{
  const loosen = { kind: 'mode', direction: 'loosen', decidedBy: '鈴木 一郎', reason: 'x' };
  check('帰属を要する変化点: 緩める向き・任免・名簿の変更(表記の変更・確認・名簿の追加)', [loosen, { ...loosen, direction: 'appoint' }, { kind: 'accountable', direction: 'none', decidedBy: '鈴木 一郎', rosterEdits: [{ id: 'p1' }] }, { kind: 'accountable', direction: 'none', decidedBy: '鈴木 一郎', diff: ['人の名簿: 追加 高橋 次郎'] }].every(decisionNeedsAttribution));
  check('帰属を要さない変化点: 厳しくする向き・記名の無い記録', ![{ ...loosen, direction: 'tighten' }, { ...loosen, decidedBy: null }, { kind: 'notice', direction: 'none', decidedBy: '鈴木 一郎' }].some(decisionNeedsAttribution));
  const INTENT = { seat: 'dev-verifier', decidedBy: '鈴木 一郎', reason: '委任する', at: '2026-10-01' };
  const prior = { seats: [{ role: 'dev-verifier', intent: { mode: 'delegated', decidedBy: '鈴木 一郎', reason: '委任する', at: '2026-10-01' } }] };
  const activation = { decidedBy: '鈴木 一郎', reason: '委任する(2026-10-01 の決定を、規則の承認により有効にした)', intentApplied: [INTENT] };
  const log = [{ decidedBy: '鈴木 一郎', reason: '委任する', date: '2026-10-01' }, { decidedBy: '山田 太郎', reason: 'y' }, activation];
  check('宣言した時点の変化点: intentApplied と、前の構成の席の宣言と、宣言の記録(決定者・理由・日)が一致すれば宣言の記録を指す', signatureIndexOf(log, 2, { prior }) === 0 && signatureIndexOf(log, 1, { prior }) === 1);
  // IMPL-0415:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('宣言した時点の変化点: 理由の文の一致だけ(intentApplied なし)では宣言の記録を借りず、有効化の記録そのものを指す(突合 H-1)', signatureIndexOf([log[0], log[1], { ...activation, intentApplied: undefined }], 2, { prior }) === 2);
  check('宣言した時点の変化点: 前の構成の席が宣言を保持していなければ、有効化の記録そのものを指す', signatureIndexOf(log, 2, { prior: { seats: [{ role: 'dev-verifier' }] } }) === 2 && signatureIndexOf(log, 2) === 2);
  check('宣言した時点の変化点: 宣言の日が合わない記録は借りない', signatureIndexOf([{ ...log[0], date: '2026-09-30' }, log[1], activation], 2, { prior }) === 2);
  check('sgRecord の所在: docs/gates/ の .md だけ。絶対の所在は docs/gates/ から読む', sgRecordPath({ sgRecord: 'docs/gates/sg-1.md' }) === 'docs/gates/sg-1.md' && sgRecordPath({ sgRecord: '/repo/docs/gates/sg-1.md' }) === 'docs/gates/sg-1.md' && sgRecordPath({ sgRecord: 'docs/x.md' }) === null && sgRecordPath({ sgRecord: 'docs/gates/../x.md' }) === null);
  const HEAD = 'a'.repeat(40);
  const info = pullInfoOf({ number: 9, author: acct('yamada'), head: HEAD, reviews: [{ user: acct('suzuki'), state: 'APPROVED', commit_id: HEAD }, { user: acct('sato'), state: 'APPROVED', commit_id: 'b'.repeat(40) }] });
  check('検査する PR の材料: 先頭に対する承認だけを数える(先頭より前の承認は失効)', info.approvers.length === 1 && info.approvers[0].login === 'suzuki' && info.author === 'yamada' && info.authorId === UID.yamada, JSON.stringify(info));
  check('検査する PR の材料: レビューを読めなければ null', pullInfoOf({ number: 9, author: 'yamada', reviews: undefined }) === null);
  const boss = { configured: true, people: [...PEOPLE, { id: 'p9', name: '社長 一', appointer: true, accounts: [acct('boss')] }], seats: SEATS };
  check('任命権者の記名者: 記名者本人(任命権者)の承認を、本人の承認として数える', introducedBacking(boss, boss.people[3], { number: 3, author: 'yamada', authorId: UID.yamada, approvers: [acct('boss')] }).backed);
  check('任命権者の記名者: 記名者でない任命権者の承認は数えない', !introducedBacking(boss, boss.people[1], { number: 3, author: 'yamada', authorId: UID.yamada, approvers: [acct('boss')] }).backed);
}

// ---------------------------------------------------------------- 層1 と権限者の照合(単体)
{
  const config = { configured: true, people: PEOPLE, seats: SEATS };
  const policy = readPolicy(config, { text: POLICY() });
  const hosting = (approvers) => fixedHosting({ c1: { number: 1, author: 'yamada', authorId: UID.yamada, approvers } });
  const git = () => 'c1\n';
  const ng = policyAttribution(config, policy, { git, rev: 'main', hosting: hosting([acct('sato')]) });
  const ok = policyAttribution(config, policy, { git, rev: 'main', hosting: hosting([acct('suzuki')]) });
  // IMPL-0415:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('層1: 層1 を入れた PR の作成者・承認者に記名者のアカウントが無ければ、帰属を確かめられない', ng && !ng.backed && /鈴木 一郎/.test(ng.why), JSON.stringify(ng));
  // IMPL-0415:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('層1: 記名者本人の承認で入った層1 は裏づける', ok?.backed === true, JSON.stringify(ok));
  check('層1: 記名者が名簿の人へ対応づかなければ、帰属を確かめられない', policyAttribution(config, readPolicy(config, { text: POLICY('外部 太郎') }), { git, rev: 'main', hosting: hosting([acct('suzuki')]) }).backed === false);
  check('層1: 層1 が無ければ照合しない(null)', policyAttribution(config, readPolicy(config, { text: null }), { git, rev: 'main', hosting: hosting([]) }) === null);
  const re = /停止の申し立ての解除/;
  const unatt = withPolicyAttribution(policy, ng);
  const att = withPolicyAttribution(policy, ok);
  check('権限者の照合: 裏づけた層1 は項目4 の受容者(出荷判定者 = 鈴木)と照合する', checkAuthority(config, att, re, '鈴木 一郎', { fallbackSeat: 'biz-approver' }).ok && !checkAuthority(config, att, re, '佐藤 花子', { fallbackSeat: 'biz-approver' }).ok);
  const a = checkAuthority(config, unatt, re, '佐藤 花子', { fallbackSeat: 'biz-approver' });
  check('権限者の照合: 帰属を確かめられない層1 は項目4 を使わず、事業決裁者(佐藤)と照合し、その旨を出す', a.ok && a.notes.some((x) => /帰属を確かめられない層1/.test(x)) && !checkAuthority(config, unatt, re, '鈴木 一郎', { fallbackSeat: 'biz-approver' }).ok, JSON.stringify(a));
  const c = checkAuthority(config, unatt, re, '鈴木 一郎', {});
  const c2 = checkAuthority(config, unatt, re, '佐藤 花子', {});
  check('権限者の照合: 戻す席を渡さない照合(D-0 節15 の受容)も、帰属を確かめられない層1 では事業決裁者と照合する(照合を外さない)', !c.ok && c2.ok && c2.notes.some((x) => /帰属を確かめられない層1/.test(x)), JSON.stringify([c, c2]));
  check('権限者の照合: 委任の登録の錠(厳しくする向き)は、帰属を確かめられない層1 でも外さない', withPolicyAttribution(readPolicy(config, { text: POLICY().replace('| 停止の申し立ての解除 | 解除 |', '| AI の利用の拡大 | 認めない |') }), ng).delegationLock.locked === true);
}

// ---------------------------------------------------------------- PR の時点の検査(analyzePr)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-material-more-'));
const git = (...args) => execFileSync('git', args, { cwd: TMP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true });
  fs.writeFileSync(path.join(TMP, rel), typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n');
};
const read = (rel) => JSON.parse(fs.readFileSync(path.join(TMP, rel), 'utf8'));
const RISK = '## リスク区分\n\nR3\n\n';
const BODY = `## 変更の概要\n\n説明\n\n## 作成を指示した者\n\n山田 太郎\n\n${RISK}## トレーラ(スカッシュのメッセージの末尾になる。消さない)\n\nSpec: setup\n`;
const SG = (judge) => `# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | SG |\n| 対象 | 事業ステージ S2 → S1 |\n| 判定者 | ${judge} |\n| 判定日時 | 2026-10-03 10:00 |\n| 結果 | 通過 |\n`;
const RELEASE = (pr, judge) =>
  `# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | 停止の申し立ての解除 |\n| 対象 | PR #${pr} |\n| 判定者 | ${judge} |\n| 判定日時 | 2026-10-03 10:00 |\n| 結果 | 通過 |\n\n` +
  '## 停止の申し立ての解除\n\n| 欄 | 記載 |\n| --- | --- |\n| 申し立てた者 | 山田 太郎 |\n| 解除の理由 | 原因を除いた |\n| 申し立てた者の見解を退けたか | 退けていない |\n| 上申先と日付(退けた場合) | 該当なし |\n';

git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'tester');
git('config', 'core.autocrlf', 'false');
const INIT = { kind: 'init', date: '2026-10-01', direction: 'none', decidedBy: null };
const HELD_DECL = { kind: 'mode', date: '2026-10-01', direction: 'none', decidedBy: '鈴木 一郎', reason: '委任する' };
// 開発者の席は、委任の宣言を保持している(規則の承認待ち。HELD_DECL で宣言した)
const HELD_SEAT = { role: 'dev-verifier', accountable: '鈴木 一郎', intent: { mode: 'delegated', decidedBy: '鈴木 一郎', reason: '委任する', at: '2026-10-01' } };
write('process.config.json', { configured: true, people: PEOPLE, seats: [...SEATS, HELD_SEAT], changeLog: [INIT, HELD_DECL] });
write('docs/quality-assurance-policy.md', POLICY());
write('src/a.js', 'export const a = 1;\n');
git('add', '-A');
git('commit', '-q', '-m', 'chore: base');
const CONFIG_SHA = git('rev-parse', 'HEAD');
const POLICY_SHA = CONFIG_SHA;
write('docs/gates/sg-back.md', SG('佐藤 花子'));
git('add', '-A');
git('commit', '-q', '-m', 'docs: SG の判定記録');
const SG_SHA = git('rev-parse', 'HEAD');

let n = 0;
/** 場面: main から PR のブランチを切って変更を積み、analyzePr を呼ぶ。pr は先頭(head)を受け取る関数でもよい */
function run(pr, mutate) {
  n++;
  git('switch', '-q', '-C', `pr-${n}`, 'main');
  mutate();
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', `change ${n}`);
  const head = git('rev-parse', 'HEAD');
  const p = typeof pr === 'function' ? pr(head) : pr;
  const prIn = { number: 200 + n, title: 'chore: x', body: BODY, author: 'yamada', authorId: UID.yamada, head, ...p };
  return analyzePr({ root: TMP, base: 'main', pr: prIn });
}
const approved = (head, ...logins) => logins.map((l, i) => ({ id: 50 + i, user: acct(l), state: 'APPROVED', body: '', submitted_at: '2026-10-05T00:00:00Z', commit_id: head }));
const addEntry = (e) => () => {
  const c = read('process.config.json');
  write('process.config.json', { ...c, changeLog: [...c.changeLog, { date: '2026-10-05', ...e }] });
};
const errs = (r, re) => r.errors.filter((e) => re.test(e));
const LOOSEN = { kind: 'mode', direction: 'loosen', decidedBy: '鈴木 一郎', reason: '開発者の席を協働へ' };
const hostingOf = (map) => fixedHosting(map);
const BASE_HOSTING = (o = {}) => ({
  hostingLookup: hostingOf({
    [CONFIG_SHA]: { number: 1, author: 'tester', authorId: UID.tester, approvers: [acct('suzuki')] },
    [SG_SHA]: { number: 2, author: 'tester', authorId: UID.tester, approvers: [acct('sato')] },
    ...o,
  }),
});

// --- 層1(停止の解除の権限者) ---
{
  const stopPr = 200 + n + 1;
  git('switch', '-q', 'main');
  write(`docs/gates/stop-${stopPr}.md`, RELEASE(stopPr, '鈴木 一郎'));
  write(`docs/gates/stop-${stopPr + 1}.md`, RELEASE(stopPr + 1, '鈴木 一郎'));
  write(`docs/gates/stop-${stopPr + 2}.md`, RELEASE(stopPr + 2, '佐藤 花子'));
  git('add', '-A');
  git('commit', '-q', '-m', 'docs: 解除の記録');
  const RELEASE_SHA = git('rev-parse', 'HEAD');
  const releaseBacked = { number: 3, author: 'tester', authorId: UID.tester, approvers: [acct('suzuki'), acct('sato')] };
  const STOP = { labels: ['state:stop-requested'] };
  const unatt = hostingOf({ [POLICY_SHA]: { number: 1, author: 'yamada', authorId: UID.yamada, approvers: [acct('sato')] }, [RELEASE_SHA]: releaseBacked });
  const att = hostingOf({ [POLICY_SHA]: { number: 1, author: 'yamada', authorId: UID.yamada, approvers: [acct('suzuki')] }, [RELEASE_SHA]: releaseBacked });
  const r1 = run({ ...STOP, hostingLookup: unatt }, () => write('docs/x.md', 'x\n'));
  // IMPL-0431:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('PR の時点・層1: 帰属を確かめられない層1 の項目4(出荷判定者)では解除できず、その旨を出す', r1.stop?.released === false && /帰属を確かめられない層1/.test(r1.stop.message) && /権限者/.test(r1.stop.message), r1.stop?.message);
  const r2 = run({ ...STOP, hostingLookup: att }, () => write('docs/x.md', 'x\n'));
  // IMPL-0431:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('PR の時点・層1: 記名者本人の承認で入った層1 の項目4 の権限者(出荷判定者)の解除で保留を解く', r2.stop?.released === true && /層1 の帰属/.test(r2.stop.message), r2.stop?.message);
  const r3 = run({ ...STOP, hostingLookup: unatt }, () => write('docs/x.md', 'x\n'));
  check('PR の時点・層1: 帰属を確かめられない層1 では、事業決裁者の席の責任者の解除で保留を解く(層1 が無い場合と同じ)', r3.stop?.released === true && /帰属を確かめられない層1 のため/.test(r3.stop.message), r3.stop?.message);
}

// --- D-0 の決定の記名 ---
{
  const r = run((head) => ({ reviews: approved(head, 'sato'), ...BASE_HOSTING() }), addEntry(LOOSEN));
  // IMPL-0431:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('PR の時点・D-0: 緩める向きの記録の決定者(鈴木)が PR の作成者でも承認者でもなければ失敗し、再実行を促す', errs(r, /D-0 の決定の記名 changeLog\[2\].*帰属を確かめられない.*gate-g5 の最後の実行を再実行する/).length === 1, JSON.stringify(r.errors));
  const ok = run((head) => ({ reviews: approved(head, 'suzuki'), ...BASE_HOSTING() }), addEntry(LOOSEN));
  // IMPL-0431:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('PR の時点・D-0: 決定者本人が PR の先頭を承認していれば通す', !errs(ok, /D-0 の決定の記名/).length && ok.decisionRecords?.checked?.[0]?.backed === true, JSON.stringify(ok.errors));
  const stale = run((head) => ({ reviews: approved('c'.repeat(40), 'suzuki'), ...BASE_HOSTING() }), addEntry(LOOSEN));
  check('PR の時点・D-0: 決定者の承認が先頭より前のものなら数えない(失効)', errs(stale, /D-0 の決定の記名/).length === 1, JSON.stringify(stale.errors));
  const self = run({ author: 'suzuki', authorId: UID.suzuki, reviews: [], commitAuthors: [acct('suzuki')], ...BASE_HOSTING() }, addEntry(LOOSEN));
  check('PR の時点・D-0: 決定者が作成者で、記名者以外の承認(帰属の確認)が無ければ失敗', errs(self, /作成者は記名者本人だが.*承認\(帰属の確認\)が無い/).length === 1, JSON.stringify(self.errors));
  const selfOk = run((head) => ({ author: 'suzuki', authorId: UID.suzuki, reviews: approved(head, 'sato'), commitAuthors: [acct('suzuki')], ...BASE_HOSTING() }), addEntry(LOOSEN));
  check('PR の時点・D-0: 決定者が作成者で、記名者以外の人が先頭を承認していれば通す', !errs(selfOk, /D-0 の決定の記名/).length, JSON.stringify(selfOk.errors));
  const selfPulls = run((head) => ({ author: 'suzuki', authorId: UID.suzuki, reviews: approved(head, 'sato'), hostingLookup: fixedHosting({}, { [200 + n]: { commitAuthors: [acct('suzuki'), acct('yamada')] } }) }), addEntry(LOOSEN));
  check('PR の時点・D-0: 決定者が作成者でも、記名者以外のコミットを含む PR は数えない(コミットの作成者はホスティングから引く)', errs(selfPulls, /記名者以外のコミット/).length === 1, JSON.stringify(selfPulls.errors));
  const unread = run({ reviews: undefined, ...BASE_HOSTING() }, addEntry(LOOSEN));
  check('PR の時点・D-0: PR のレビューを読めなければ、帰属を確かめられないとして失敗', errs(unread, /D-0 の決定の記名.*ホスティングから読めない/).length === 1, JSON.stringify(unread.errors));
  const roster = run((head) => ({ reviews: approved(head, 'sato'), ...BASE_HOSTING() }), addEntry({ kind: 'accountable', direction: 'none', decidedBy: '鈴木 一郎', reason: '表記', rosterEdits: [{ id: 'p1', field: 'name', from: '山田 太郎', to: '山田 太朗' }] }));
  check('PR の時点・D-0: 名簿の変更(表5)の決定者の記名も確かめる', errs(roster, /D-0 の決定の記名.*名簿の変更/).length === 1, JSON.stringify(roster.errors));
  const tighten = run((head) => ({ reviews: approved(head, 'sato'), ...BASE_HOSTING() }), addEntry({ ...LOOSEN, direction: 'tighten' }));
  check('PR の時点・D-0: 厳しくする向きの記録は照合しない(従来どおり)', !errs(tighten, /D-0 の決定の記名/).length && !(tighten.decisionRecords?.checked ?? []).length, JSON.stringify(tighten.errors));
  const HELD = { kind: 'approve', direction: 'loosen', decidedBy: '鈴木 一郎', reason: '委任する(2026-10-01 の決定を、規則の承認により有効にした)', intentApplied: [{ seat: 'dev-verifier', decidedBy: '鈴木 一郎', reason: '委任する', at: '2026-10-01' }] };
  const forged = run((head) => ({ reviews: approved(head, 'sato'), ...BASE_HOSTING() }), addEntry({ ...HELD, intentApplied: undefined }));
  check('PR の時点・D-0: 理由の文だけを有効化の形にした記録は、宣言の記録を借りず、この PR で決定者を照合する(突合 H-1)', errs(forged, /D-0 の決定の記名 changeLog\[2\].*帰属を確かめられない/).length === 1 && !/宣言した時点/.test(JSON.stringify(forged.errors)), JSON.stringify(forged.errors));
  const held = run((head) => ({ reviews: approved(head, 'sato'), ...BASE_HOSTING() }), addEntry(HELD));
  check('PR の時点・D-0: 保持していた宣言を有効にした記録は、宣言した時点の記録を入れた PR(決定者本人の承認)で裏づける', !errs(held, /D-0 の決定の記名/).length && /宣言した時点の changeLog\[1\]/.test(JSON.stringify(held.decisionRecords?.checked)), JSON.stringify(held.errors));
  const heldNg = run((head) => ({ reviews: approved(head, 'sato'), ...BASE_HOSTING({ [CONFIG_SHA]: { number: 1, author: 'tester', authorId: UID.tester, approvers: [acct('yamada')] } }) }), addEntry(HELD));
  check('PR の時点・D-0: 宣言した時点の記録を入れた PR に決定者の操作が無ければ失敗', errs(heldNg, /D-0 の決定の記名.*宣言した時点の changeLog\[1\]/).length === 1, JSON.stringify(heldNg.errors));
  // 委任の規則の承認の記名(突合 H-3)
  const RULE = { kind: 'approve', direction: 'loosen', decidedBy: '鈴木 一郎', reason: '規則を承認する', ruleApprovedBy: '佐藤 花子' };
  const ruleNg = run((head) => ({ reviews: approved(head, 'suzuki'), ...BASE_HOSTING() }), addEntry(RULE));
  check('PR の時点・規則の承認: 承認した者(佐藤)がこの PR の作成者でも承認者でもなければ失敗', errs(ruleNg, /委任の規則の承認の記名 changeLog\[2\].*帰属を確かめられない/).length === 1 && !errs(ruleNg, /D-0 の決定の記名/).length, JSON.stringify(ruleNg.errors));
  const ruleOk = run((head) => ({ reviews: approved(head, 'suzuki', 'sato'), ...BASE_HOSTING() }), addEntry(RULE));
  check('PR の時点・規則の承認: 承認した者本人も PR の先頭を承認していれば通す', !errs(ruleOk, /委任の規則の承認の記名|D-0 の決定の記名/).length, JSON.stringify(ruleOk.errors));
}

// --- 前倒しで要る SG の判定記録 ---
{
  const BACK = { kind: 'stage', direction: 'loosen', decidedBy: '鈴木 一郎', reason: 'S1 へ戻す', sgRecord: 'docs/gates/sg-back.md' };
  const ng = run((head) => ({ reviews: approved(head, 'suzuki'), ...BASE_HOSTING({ [SG_SHA]: { number: 2, author: 'tester', authorId: UID.tester, approvers: [acct('yamada')] } }) }), addEntry(BACK));
  // IMPL-0431:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('PR の時点・SG: 指す SG の判定記録を入れた PR に判定者(佐藤)の操作が無ければ失敗', errs(ng, /前倒しで要る SG の判定記録.*判定者 佐藤 花子.*帰属を確かめられない/).length === 1 && !errs(ng, /D-0 の決定の記名/).length, JSON.stringify(ng.errors));
  const ok = run((head) => ({ reviews: approved(head, 'suzuki'), ...BASE_HOSTING() }), addEntry(BACK));
  // IMPL-0431:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('PR の時点・SG: 判定者本人の承認で入った SG の判定記録を指す変化点は通す', !errs(ok, /前倒しで要る SG|D-0 の決定の記名/).length, JSON.stringify(ok.errors));
  const inPr = run((head) => ({ reviews: approved(head, 'suzuki', 'yamada'), ...BASE_HOSTING() }), () => {
    write('docs/gates/sg-new.md', SG('山田 太郎'));
    addEntry({ ...BACK, sgRecord: 'docs/gates/sg-new.md' })();
  });
  check('PR の時点・SG: 同じ PR で足した SG の判定記録は、この PR の作成者・承認者で照合する', !errs(inPr, /前倒しで要る SG/).length, JSON.stringify(inPr.errors));
  const inPrNg = run((head) => ({ reviews: approved(head, 'suzuki'), ...BASE_HOSTING() }), () => {
    write('docs/gates/sg-new2.md', SG('佐藤 花子'));
    addEntry({ ...BACK, sgRecord: 'docs/gates/sg-new2.md' })();
  });
  check('PR の時点・SG: 同じ PR で足した SG の判定記録で、判定者がこの PR の作成者でも承認者でもなければ失敗', errs(inPrNg, /前倒しで要る SG/).length === 1, JSON.stringify(inPrNg.errors));
  const outside = run((head) => ({ reviews: approved(head, 'suzuki'), ...BASE_HOSTING() }), addEntry({ ...BACK, sgRecord: 'docs/sg.md' }));
  check('PR の時点・SG: docs/gates/ の外を指す sgRecord は失敗', errs(outside, /sgRecord が docs\/gates\/ 配下/).length === 1, JSON.stringify(outside.errors));
}
fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

// ---------------------------------------------------------------- 名簿の数値の識別子の移行(#430 の移行。突合 H-2)
// 既定ブランチの名簿は、アカウントをログイン名だけで持つ(#430 より前)。識別子を足す変化点の決定者は、変化点が書く {login, id} で
// 同定してよい。ただし、PR の作成者・承認者のホスティングの記録(login・id)が、書く値と一致する場合に限る
function migration(people, after, entry, pr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-id-migration-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (c) => fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(c, null, 2) + '\n');
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'tester');
  g('config', 'core.autocrlf', 'false');
  const base = { configured: true, people, seats: [{ role: 'biz-approver', accountable: people[0].name }], changeLog: [INIT] };
  put(base);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  g('switch', '-q', '-c', 'pr');
  put({ ...base, people: after, changeLog: [INIT, { date: '2026-10-02', ...entry }] });
  g('add', '-A');
  g('commit', '-q', '-m', 'ids');
  const head = g('rev-parse', 'HEAD');
  const r = analyzePr({ root: dir, base: 'main', pr: { number: 301, title: 'chore: ids', body: BODY, head, hostingLookup: fixedHosting({}), ...pr(head) } });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return r;
}
{
  const ONE = [{ id: 'p1', name: '山田 太郎', accounts: ['yamada'] }];
  const ONE_AFTER = [{ id: 'p1', name: '山田 太郎', accounts: [acct('yamada')] }];
  const selfEntry = { kind: 'accountable', direction: 'none', decidedBy: '山田 太郎', reason: '識別子を足す', rosterEdits: [{ id: 'p1', field: 'accounts', from: 'yamada', to: 'yamada(#1001)', selfIdAddition: true }] };
  const one = migration(ONE, ONE_AFTER, selfEntry, () => ({ author: 'yamada', authorId: UID.yamada, reviews: [], commitAuthors: [acct('yamada')] }));
  // IMPL-0415:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('識別子の移行(1名): 本人が自分の行に識別子を足す PR は、書く {login, id} と作成者のホスティングの記録が一致して通る(自己申告)', !errs(one, /D-0 の決定の記名/).length && one.decisionRecords?.checked?.[0]?.selfAttested === true, JSON.stringify([one.errors, one.decisionRecords]));
  const oneBad = migration(ONE, [{ id: 'p1', name: '山田 太郎', accounts: [{ login: 'yamada', id: 9999 }] }], { ...selfEntry, rosterEdits: [{ id: 'p1', field: 'accounts', from: 'yamada', to: 'yamada(#9999)' }] }, () => ({ author: 'yamada', authorId: UID.yamada, reviews: [], commitAuthors: [acct('yamada')] }));
  check('識別子の移行(1名): 書く識別子が作成者のホスティングの識別子と違えば通さない', errs(oneBad, /D-0 の決定の記名/).length === 1, JSON.stringify(oneBad.errors));
  const TWO = [{ id: 'p1', name: '山田 太郎', accounts: ['yamada'] }, { id: 'p2', name: '鈴木 一郎', accounts: ['suzuki'] }];
  const TWO_AFTER = [{ id: 'p1', name: '山田 太郎', accounts: [acct('yamada')] }, { id: 'p2', name: '鈴木 一郎', accounts: [acct('suzuki')] }];
  const twoEntry = { kind: 'accountable', direction: 'none', decidedBy: '鈴木 一郎', reason: '識別子を足す', rosterEdits: [{ id: 'p1', field: 'accounts', from: 'yamada', to: 'yamada(#1001)' }, { id: 'p2', field: 'accounts', from: 'suzuki', to: 'suzuki(#1002)' }] };
  const two = migration(TWO, TWO_AFTER, twoEntry, (head) => ({ author: 'yamada', authorId: UID.yamada, reviews: approved(head, 'suzuki') }));
  check('識別子の移行(2名): 他の人の行と決定者の行に識別子を足す PR は、決定者の承認(書く {login, id} と一致)で通る', !errs(two, /D-0 の決定の記名/).length && two.decisionRecords?.checked?.[0]?.backed === true, JSON.stringify([two.errors, two.decisionRecords]));
  const twoBad = migration(TWO, TWO_AFTER, twoEntry, (head) => ({ author: 'yamada', authorId: UID.yamada, reviews: [{ id: 50, user: { login: 'suzuki', id: 7777 }, state: 'APPROVED', commit_id: head }] }));
  check('識別子の移行(2名): 承認者のホスティングの識別子が書く値と違えば通さない', errs(twoBad, /D-0 の決定の記名/).length === 1, JSON.stringify(twoBad.errors));
}

// ---------------------------------------------------------------- 変化点を入れたコミット(git の履歴)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-changelog-commit-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'tester');
  const put = (log, extra = {}) => {
    fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify({ ...extra, changeLog: log }, null, 2));
    g('add', '-A');
    g('commit', '-q', '-m', 'c');
    return g('rev-parse', 'HEAD');
  };
  const a = put([{ k: 0 }]);
  const b = put([{ k: 0 }, { k: 1 }]);
  put([{ k: 0 }, { k: 1 }], { other: true });
  put([{ k: 0 }, { k: 1 }, { k: 2 }]);
  const gitText = (args) => {
    try {
      return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  check('変化点を入れたコミット: 記録を足したコミット(後の構成の変更を越えて遡る)', commitOfChangeLogEntry(gitText, 'HEAD', 1) === b && commitOfChangeLogEntry(gitText, 'HEAD', 0) === a);
  check('変化点を入れたコミット: 無い記録は null', commitOfChangeLogEntry(gitText, 'HEAD', 5) === null);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ---------------------------------------------------------------- 出荷の集約(通し。模擬の gh を使わない)
{
  const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-material-agg-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
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
  const people = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [{ login: `acc${i}`, id: 3000 + i }] }));
  const seats = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
  const answers = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free', 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes', 'q-biz-phase': 'growth' };
  const config = quiet(() => buildConfig(answers, { generatedAt: '2026-10-01T09:00:00+09:00', d0Version: null, people, seats }).config);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const put = (c) => fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(c, null, 2) + '\n');
  put(config);
  // 層1(記名者は名簿の人)。模擬の gh を使わないため、層1 を入れた変更の記録を読めず、帰属を確かめられない層1 になる
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/quality-assurance-policy.md'), POLICY('名簿 戊'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'tester');
  g('config', 'core.autocrlf', 'false');
  g('config', 'gc.auto', '0');
  g('add', '-A');
  g('commit', '-q', '-m', 'chore: fixture');
  const at = '2026-10-02T10:00:00+09:00';
  put({ ...config, changeLog: [...config.changeLog, { date: '2026-10-02', at, kind: 'mode', direction: 'tighten', decidedBy: '名簿 戊', reason: '厳しくする', diff: [] }, { date: '2026-10-02', at, kind: 'mode', direction: 'loosen', decidedBy: '名簿 戊', reason: '緩める', diff: [] }] });
  g('add', '-A');
  g('commit', '-q', '-m', 'chore: 変化点\n\nRisk: R3\nVerification: 手元で試験を実行した');
  const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const idx = config.changeLog.length;
  check('集約の前提: 集約が最後まで走る', /を出力しました/.test(out), out.slice(-1500));
  // IMPL-0415:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('集約・D-0: 範囲の中の緩める向きの記録で、記録を入れた変更の帰属を確かめられなければ欠落にする', new RegExp(`D-0 の決定の記名 changeLog\\[${idx + 1}\\].*効力を持つ記録の帰属を確かめられません`).test(out), out.split('\n').filter((l) => /D-0/.test(l)).join('\n') || out.slice(-1500));
  // IMPL-0415:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('集約・D-0: 厳しくする向きの記録は照合しない(欠落にしない)', !new RegExp(`D-0 の決定の記名 changeLog\\[${idx}\\]`).test(out), out.split('\n').filter((l) => /D-0/.test(l)).join('\n'));
  const ev = fs.existsSync(path.join(dir, 'evidence/evidence.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'evidence/evidence.json'), 'utf8')) : null;
  const c1 = ev?.assurance?.claim?.conditions?.find((x) => x.id === 1);
  check('集約・層1: 帰属を確かめられない層1 は、保証の主張の成立条件1 を満たさず、理由に出す', c1 && c1.ok === false && /層1 の帰属を確かめられない\(名前の一致だけでは数えない\)/.test(c1.reason ?? '') && ev.assurance.claim.policy.attribution?.backed === false, JSON.stringify(c1));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ---------------------------------------------------------------- 出荷の集約(通し。模擬の gh。裏づけのある場面。突合 M-4)
// 模擬の gh を PATH の先頭に置く(Windows では置き方が異なるため省く。CI は Linux で走る)。gh api の応答だけを返す
if (process.platform === 'win32') {
  console.log('---- 集約の通しの裏づけのある場面(模擬の gh): Windows では省きます(CI で確かめる)');
} else {
  const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-fake-gh-'));
  fs.writeFileSync(
    path.join(BIN, 'gh'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "const map = JSON.parse(fs.readFileSync(process.env.FAKE_GH_MAP, 'utf8'));",
      "const target = args.find((a) => a.startsWith('repos/')) ?? '';",
      "if (args[0] === 'api' && Object.prototype.hasOwnProperty.call(map, target)) { process.stdout.write(JSON.stringify(map[target])); process.exit(0); }",
      "if (args[0] === 'api' && /\\/(pulls|reviews|commits)$/.test(target)) { process.stdout.write('[]'); process.exit(0); }",
      'process.exit(1);',
      '',
    ].join('\n')
  );
  fs.chmodSync(path.join(BIN, 'gh'), 0o755);
  const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
  const quiet = (fn) => {
    const log = console.log;
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.log = log;
    }
  };
  const R = 'example/agg';
  /** 一時の複製。commits は [{ files, message, pr: { number, author, approvers } | null }]。PR の記録は模擬の gh が返す */
  const aggregateOf = ({ people, seats, answers, commits }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-material-agg-gh-'));
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
    }
    const config = quiet(() => buildConfig(answers, { generatedAt: '2026-10-01T09:00:00+09:00', d0Version: null, people, seats }).config);
    const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    put('process.config.json', JSON.stringify(config, null, 2) + '\n');
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'tester');
    g('config', 'core.autocrlf', 'false');
    g('add', '-A');
    g('commit', '-q', '-m', 'chore: fixture');
    const map = {};
    for (const c of commits) {
      for (const [rel, text] of Object.entries(c.files(config))) put(rel, text);
      g('add', '-A');
      g('commit', '-q', '-m', `${c.message}\n\nRisk: R3\nVerification: 手元で試験を実行した`);
      const sha = g('rev-parse', 'HEAD');
      if (!c.pr) continue;
      const user = (login) => ({ login, id: people.flatMap((p) => p.accounts ?? []).find((a) => a.login === login)?.id ?? null });
      map[`repos/${R}/commits/${sha}/pulls`] = [{ number: c.pr.number, merged_at: '2026-10-02T00:00:00Z', merge_commit_sha: sha, head: { sha: `head-${c.pr.number}` }, user: user(c.pr.author) }];
      map[`repos/${R}/pulls/${c.pr.number}/reviews`] = c.pr.approvers.map((l, i) => ({ id: 800 + i, user: { ...user(l), type: 'User' }, state: 'APPROVED', commit_id: `head-${c.pr.number}`, body: '' }));
      map[`repos/${R}/pulls/${c.pr.number}/commits`] = [{ author: user(c.pr.author) }];
    }
    const mapFile = path.join(BIN, `map-${path.basename(dir)}.json`);
    fs.writeFileSync(mapFile, JSON.stringify(map));
    const r = spawnSync(process.execPath, ['scripts/gate/aggregate-evidence.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_MAP: mapFile, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: R, GH_TOKEN: '', GITHUB_TOKEN: '' } });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const evFile = path.join(dir, 'evidence/evidence.json');
    const ev = fs.existsSync(evFile) ? JSON.parse(fs.readFileSync(evFile, 'utf8')) : null;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { out, ev, idx: config.changeLog.length };
  };
  // 5名の体制: 緩める向きの D-0 の記録(決定 名簿 戊)と、前倒しの SG の判定記録(判定者 名簿 丁)を、記名者本人が承認した PR で入れる
  {
    const people = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [{ login: `acc${i}`, id: 3000 + i }] }));
    const seats = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
    const answers = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free', 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes', 'q-biz-phase': 'growth' };
    const at = '2026-10-02T10:00:00+09:00';
    const files = (config) => ({
      'docs/gates/sg-back.md': SG('名簿 丁'),
      'process.config.json':
        JSON.stringify({ ...config, changeLog: [...config.changeLog, { date: '2026-10-02', at, kind: 'mode', direction: 'loosen', decidedBy: '名簿 戊', reason: '緩める', diff: [] }, { date: '2026-10-02', at, kind: 'axis', direction: 'loosen', decidedBy: '名簿 戊', reason: 'S1 へ戻す', diff: [], sgRecord: 'docs/gates/sg-back.md' }] }, null, 2) + '\n',
    });
    const ok = aggregateOf({ people, seats, answers, commits: [{ message: 'chore: 変化点と SG', files, pr: { number: 5, author: 'acc0', approvers: ['acc4', 'acc3'] } }] });
    const da = ok.ev?.assurance?.generation?.decisionAttribution ?? [];
    check('集約(模擬の gh)の前提: 集約が最後まで走る', /を出力しました/.test(ok.out), ok.out.slice(-1500));
    // IMPL-0415:ok(違反と適合の対。標準の実装マーク。process-compass #314)
    check('集約・D-0: 決定者本人が承認した PR で入れた緩める向きの記録は裏づき、欠落にしない', da.filter((d) => d.kind === 'd0').length === 2 && da.filter((d) => d.kind === 'd0').every((d) => d.backed) && !/D-0 の決定の記名 changeLog.*帰属を確かめられません/.test(ok.out), JSON.stringify(da));
    // IMPL-0415:ok(違反と適合の対。標準の実装マーク。process-compass #314)
    check('集約・SG: 判定者本人が承認した PR で入れた SG の判定記録を指す変化点は裏づき、欠落にしない', da.some((d) => d.kind === 'sg' && d.backed) && !/前倒しで要る SG の判定記録.*帰属を確かめられません/.test(ok.out), JSON.stringify(da));
    const ng = aggregateOf({ people, seats, answers, commits: [{ message: 'chore: 変化点と SG', files, pr: { number: 5, author: 'acc0', approvers: ['acc1'] } }] });
    // IMPL-0415:ng(違反と適合の対。標準の実装マーク。process-compass #314)
    check('集約・SG: 判定者の操作が無い PR で入れた SG の判定記録を指す変化点は欠落にする', /前倒しで要る SG の判定記録.*判定者 名簿 丁.*帰属を確かめられません/.test(ng.out), ng.out.split('\n').filter((l) => /SG/.test(l)).join('\n') || ng.out.slice(-1500));
  }
  // 1名の体制: 層1 を本人が作成した PR で入れる。確認者を置けないため自己申告として受け付け、成立条件1 の帰属は満たす(その旨を出す)
  {
    const people = [{ id: 'p0', name: '名簿 甲', accounts: [{ login: 'acc0', id: 3000 }] }];
    const seats = ['value-owner', 'tech-lead', 'dev-verifier', 'independent-reviewer', 'qa-gatekeeper', 'biz-approver'].map((role) => ({ role, accountable: 'p0' }));
    const answers = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free', 'q-team-size': 'size-1-2', 'q-external-reviewer': 'reviewer-no', 'q-biz-phase': 'poc' };
    const one = aggregateOf({ people, seats, answers, commits: [{ message: 'docs: 層1', files: () => ({ 'docs/quality-assurance-policy.md': POLICY('名簿 甲') }), pr: { number: 6, author: 'acc0', approvers: [] } }] });
    const c1 = one.ev?.assurance?.claim?.conditions?.find((x) => x.id === 1);
    // IMPL-0415:ok(違反と適合の対。標準の実装マーク。process-compass #314)
    check('集約・層1(1名): 本人が作成した PR で入れた層1 は自己申告として受け付け、成立条件1 に帰属の理由を出さず、自己申告の旨を出す', one.ev?.assurance?.claim?.policy?.attribution?.selfAttested === true && !/層1 の帰属を確かめられない/.test(c1?.reason ?? '') && /自己申告/.test(c1?.note ?? ''), JSON.stringify([one.ev?.assurance?.claim?.policy, c1]) || one.out.slice(-1500));
  }
  fs.rmSync(BIN, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`層1・D-0・SG の帰属の試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`層1・D-0・SG の帰属の試験: ${checks} 件が期待と一致しました`);
