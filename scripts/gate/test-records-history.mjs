// 記録用ブランチの履歴の走査・先頭の固定・署名の要否・置き場の規則・書き込める主体の開示の試験(process-compass #379 / ADR-0109)。
//
//   node scripts/gate/test-records-history.mjs
//
// 標準 第4章「判定記録を基底ブランチへ入れる操作」は、写しと様式の置き場を「成立した記録を、記録を残さずには書き換えられない場所」
// と定め、書き換えの防止を課さず、出荷判定(G-7)の集約による検出を求める。この試験は、一時のリポジトリに記録用ブランチ(orphan)を作り、
// 成立した記録の変更・削除・名前の変更、マージより前に置かれた写し、前回の出荷の先頭から連続しない履歴を、records.mjs と
// aggregate-evidence.mjs の関数が検出することを確かめる。コミットの時刻は過去の固定の時刻(協定世界時)で作り、時刻帯に依らない。
// GitHub へ問い合わせない(ホスティングの検証は関数で渡す)。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECORDS_REF, readRecordsBranch, scanRecordsHistory, classifyRecordsHistory, isAncestorCommit, recordsRulesetProblems } from './records.mjs';
import { recordsHistoryGaps, readPinnedRecordsHead, recordsWriterStatement, recordsSignatureRequired, unbackedSignerForms, detectionReferred, RECORDS_HEADS_DIR } from './aggregate-evidence.mjs';
import { recordsProtectionState, claimStatus } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(HERE, '..', '..');

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-records-history-'));
// コミットの時刻は過去の固定の時刻(協定世界時)。手元の時刻帯・実行の日に依らない
const git = (cwd, args, at = null) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) },
  }).trim();
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const commit = (dir, msg, at) => {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg], at);
  return git(dir, ['rev-parse', 'HEAD']);
};
const copy = (pr, mergedAt) => `${JSON.stringify({ pr, merged_at: mergedAt, merge_commit_sha: 'm'.repeat(40), head_sha: 'h'.repeat(40), reviews: [] })}\n`;

try {
  const A = path.join(TMP, 'a');
  fs.mkdirSync(A, { recursive: true });
  git(A, ['init', '-q', '-b', 'main']);
  git(A, ['config', 'user.email', 't@example.com']);
  git(A, ['config', 'user.name', 'tester']);
  git(A, ['config', 'core.autocrlf', 'false']);
  git(A, ['config', 'commit.gpgsign', 'false']);
  write(A, 'README.md', '# app\n');
  commit(A, 'chore: base', '2026-08-01T00:00:00Z');
  git(A, ['checkout', '-q', '--orphan', RECORDS_REF]);
  git(A, ['rm', '-rfq', '.']);
  write(A, 'README.md', '# 記録用ブランチ\n');
  write(A, '.gitattributes', '* -text\n');
  commit(A, 'chore: 記録用ブランチを初期化する', '2026-08-01T01:00:00Z');
  // PR #1 はマージ(2026-08-02T00:00Z)の後に写しを置く(適合)。様式を足す
  write(A, 'records/reviews/pr-1.json', copy(1, '2026-08-02T00:00:00Z'));
  commit(A, 'records: PR #1 の写し', '2026-08-02T00:10:00Z');
  write(A, 'records/gates/g7-v1.0.0-2026-08-03.md', '| ゲート | G-7 出荷判定 |\n');
  const h1 = commit(A, 'records: G-7 の判定記録', '2026-08-03T00:00:00Z');
  const mergedAtOf = (pr) => ({ 1: '2026-08-02T00:00:00Z', 2: '2026-08-06T00:00:00Z', 3: '2026-08-04T00:00:00Z' })[pr] ?? null;

  // IMPL-0432:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const clean = classifyRecordsHistory(scanRecordsHistory(A, { rev: `refs/heads/${RECORDS_REF}` }), { mergedAtOf });
  check('走査: 追加だけの履歴(マージの後に置いた写しと様式)は書き換えもマージより前の写しも 0 件', clean.rewrites.length === 0 && clean.premature.length === 0 && clean.additions === 2, JSON.stringify(clean));
  const scan0 = scanRecordsHistory(A, { rev: `refs/heads/${RECORDS_REF}` });
  check('走査: records/ の外(README・.gitattributes)は走査の対象にしない', scan0.available && scan0.commits.every((c) => c.changes.every((x) => x.path.startsWith('records/'))), JSON.stringify(scan0.commits.map((c) => c.changes)));

  // 成立した記録の変更・削除・名前の変更と、マージより前に置かれた写し
  write(A, 'records/reviews/pr-1.json', copy(1, '2026-08-01T00:00:00Z'));
  commit(A, 'records: 写しを書き換える', '2026-08-04T00:00:00Z');
  write(A, 'records/reviews/pr-2.json', copy(2, '2026-08-06T00:00:00Z'));
  commit(A, 'records: PR #2 の写しを先に置く', '2026-08-05T00:00:00Z');
  git(A, ['mv', 'records/gates/g7-v1.0.0-2026-08-03.md', 'records/gates/g7-v1.0.1-2026-08-03.md']);
  commit(A, 'records: 様式の名前を変える', '2026-08-06T01:00:00Z');
  write(A, 'records/reviews/pr-3.json', copy(3, '2026-08-04T00:00:00Z'));
  commit(A, 'records: PR #3 の写し', '2026-08-06T02:00:00Z');
  fs.rmSync(path.join(A, 'records/reviews/pr-3.json'));
  commit(A, 'records: 写しを消す', '2026-08-06T03:00:00Z');
  const head = git(A, ['rev-parse', 'HEAD']);

  // IMPL-0432:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const scan = scanRecordsHistory(A, { rev: `refs/heads/${RECORDS_REF}`, from: h1 });
  const cls = classifyRecordsHistory(scan, { mergedAtOf });
  const kinds = cls.rewrites.map((r) => `${r.status}:${r.path}`).sort();
  check('走査: 既存の記録の変更(M)・名前の変更(R)・削除(D)を、成立した記録の書き換えとして列挙する', kinds.join() === ['D:records/reviews/pr-3.json', 'M:records/reviews/pr-1.json', 'R:records/gates/g7-v1.0.1-2026-08-03.md'].sort().join(), kinds.join());
  check('走査: 名前の変更は元の名前も残す', cls.rewrites.find((r) => r.status === 'R')?.from === 'records/gates/g7-v1.0.0-2026-08-03.md', JSON.stringify(cls.rewrites));
  check('走査: PR のマージより前の時刻に足した写しを、マージより前に置かれた写しとして出す', cls.premature.length === 1 && cls.premature[0].pr === 2 && cls.premature[0].mergedAt === '2026-08-06T00:00:00Z', JSON.stringify(cls.premature));
  check('走査: from(前回の出荷の先頭)を渡すと、その後の履歴だけを読む', scan.range === `${h1}..refs/heads/${RECORDS_REF}` && scan.commits.length === 5, JSON.stringify({ range: scan.range, n: scan.commits.length }));
  const branch = readRecordsBranch({ cwd: A, fetch: false });
  const g = recordsHistoryGaps({ branch, pinned: { head: h1, file: `${RECORDS_HEADS_DIR}/x.json` }, ancestor: isAncestorCommit(A, h1, head), scan, classified: cls });
  check('欠落: 書き換え 3 件とマージより前の写し 1 件を、欠落の文と件数に出す', g.counts.rewrites === 3 && g.counts.premature === 1 && g.gaps.length === 4 && g.gaps.every((x) => /欠落|例外承認/.test(x)), JSON.stringify(g));
  check('欠落: 書き換えの文は、訂正の形(元の記録を指す記録を足す)と例外承認での受け入れを示す', g.gaps.some((x) => /訂正は元の記録を指す訂正の記録を足す形/.test(x) && /例外承認でだけ受け入れ/.test(x)));
  check('読み取り: 衝突の記録(records/conflicts/)を読む', (() => {
    write(A, 'records/conflicts/pr-9-123-1.json', '{}\n');
    commit(A, 'records: 衝突', '2026-08-07T00:00:00Z');
    const b = readRecordsBranch({ cwd: A, fetch: false });
    return b.conflicts.length === 1 && b.conflicts[0].pr === 9;
  })());

  // 先頭の固定(前回の出荷の先頭が今の先頭の祖先か)
  // IMPL-0433:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const now = git(A, ['rev-parse', 'HEAD']);
  check('先頭の固定: 前回の先頭が今の先頭の祖先なら連続(欠落にしない)', isAncestorCommit(A, h1, now) === true && recordsHistoryGaps({ branch: readRecordsBranch({ cwd: A, fetch: false }), pinned: { head: h1, file: 'x' }, ancestor: true, scan: { available: true, commits: [] }, classified: { rewrites: [], premature: [] } }).gaps.length === 0);
  // 規則を外して履歴を書き換えた(前回の先頭を含まない履歴へ置き換えた)
  git(A, ['checkout', '-q', '--orphan', 'rewritten']);
  git(A, ['rm', '-rfq', '.']);
  write(A, 'records/reviews/pr-1.json', copy(1, '2026-08-02T00:00:00Z'));
  const forged = commit(A, 'records: 書き換えた履歴', '2026-08-08T00:00:00Z');
  git(A, ['branch', '-f', RECORDS_REF, forged]);
  git(A, ['checkout', '-q', 'main']);
  // IMPL-0433:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const rb2 = readRecordsBranch({ cwd: A, fetch: false });
  const anc = isAncestorCommit(A, h1, rb2.head);
  const g2 = recordsHistoryGaps({ branch: rb2, pinned: { head: h1, file: `${RECORDS_HEADS_DIR}/2026-08-06.json` }, ancestor: anc, scan: scanRecordsHistory(A, { rev: rb2.rev }), classified: { rewrites: [], premature: [] } });
  check('先頭の固定: 前回の先頭が今の先頭の祖先でなければ、履歴の書き換えとして欠落に出す', anc === false && g2.gaps.some((x) => /子孫ではありません/.test(x)), JSON.stringify(g2.gaps));
  check('先頭の固定: 前回の先頭を読めなければ、連続を確かめられないとして欠落に出す', isAncestorCommit(A, 'f'.repeat(40), rb2.head) === null && recordsHistoryGaps({ branch: rb2, pinned: { head: 'f'.repeat(40), file: 'x' }, ancestor: null, scan: { available: true, commits: [] } }).gaps.some((x) => /確かめられません/.test(x)));
  check('先頭の固定: 前回の先頭を記録したのに記録用ブランチを読めなければ欠落に出す', recordsHistoryGaps({ branch: { available: false, reason: '無い' }, pinned: { head: h1, file: 'x' } }).gaps.length === 1);
  check('先頭の固定: 記録用ブランチが無く、前回の先頭の記録も無い(導入の前)なら欠落にしない', recordsHistoryGaps({ branch: { available: false, reason: '無い' }, pinned: null }).gaps.length === 0);
  check('走査: 履歴を読めない(浅い取得など)なら欠落に出す', recordsHistoryGaps({ branch: rb2, pinned: null, scan: { available: false, reason: '浅い取得' } }).gaps.some((x) => /走査できません/.test(x)));

  // 基底ブランチに残した先頭の読み取り(最後に記録したもの)
  const B = path.join(TMP, 'b');
  write(B, `${RECORDS_HEADS_DIR}/2026-08-03-start-HEAD.json`, JSON.stringify({ head: h1, recordedAt: '2026-08-03T00:00:00Z' }));
  write(B, `${RECORDS_HEADS_DIR}/2026-08-09-v1-v2.json`, JSON.stringify({ head: forged, recordedAt: '2026-08-09T00:00:00Z' }));
  write(B, `${RECORDS_HEADS_DIR}/broken.json`, '{');
  const pinned = readPinnedRecordsHead(B);
  check('先頭の記録: docs/records/heads/ のうち最後に記録したものを読む(壊れたものは飛ばす)', pinned?.head === forged && /2026-08-09/.test(pinned.file), JSON.stringify(pinned));
  check('先頭の記録: 置き場が無ければ null(最初の出荷)', readPinnedRecordsHead(path.join(TMP, 'none')) === null);

  // 署名を要する構成(規制業・CL2 以上)の署名の無い書き込み
  const scanS = scanRecordsHistory(A, { rev: rb2.rev });
  // IMPL-0434:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const unsigned = recordsHistoryGaps({ branch: rb2, scan: scanS, classified: { rewrites: [], premature: [] }, requireSigned: true, verifyOf: () => ({ verified: false }) });
  check('署名: 署名を要する構成で、ホスティングが署名を検証していない書き込みを欠落に出す', unsigned.counts.unsigned === scanS.commits.length && unsigned.gaps.every((x) => /署名の無い書き込み/.test(x)), JSON.stringify(unsigned));
  const unknown = recordsHistoryGaps({ branch: rb2, scan: scanS, classified: { rewrites: [], premature: [] }, requireSigned: true, verifyOf: () => null });
  check('署名: ホスティングの検証を読めない書き込みも欠落に出す', unknown.counts.unverifiedSigner === scanS.commits.length && unknown.gaps.length === scanS.commits.length);
  // IMPL-0434:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const signedOk = recordsHistoryGaps({ branch: rb2, scan: scanS, classified: { rewrites: [], premature: [] }, requireSigned: true, verifyOf: () => ({ verified: true }) });
  check('署名: ホスティングが署名を検証した書き込みは欠落にしない', signedOk.gaps.length === 0 && signedOk.counts.unsigned === 0);
  check('署名: 署名を要しない構成では、署名を確かめない', recordsHistoryGaps({ branch: rb2, scan: scanS, classified: { rewrites: [], premature: [] }, verifyOf: () => ({ verified: false }) }).gaps.length === 0);
  check('署名の要否: 規制業と CL2 以上で要する。CL1 以下の規制業でない構成では要しない', recordsSignatureRequired({ answers: { 'q-quality': 'quality-regulated' } }) && recordsSignatureRequired({ answers: { 'q-criticality': 'cl2' } }) && !recordsSignatureRequired({ answers: { 'q-criticality': 'cl1' } }) && !recordsSignatureRequired({}));

  // 中身を変えるマージコミット(突合 H-1)。マージの解決で既存の写しを書き換えても、第1の親との差分で変更として出す
  const M = path.join(TMP, 'm');
  fs.mkdirSync(M, { recursive: true });
  git(M, ['init', '-q', '-b', RECORDS_REF]);
  git(M, ['config', 'user.email', 't@example.com']);
  git(M, ['config', 'user.name', 'tester']);
  git(M, ['config', 'core.autocrlf', 'false']);
  git(M, ['config', 'commit.gpgsign', 'false']);
  write(M, 'records/reviews/pr-5.json', copy(5, '2026-08-01T00:00:00Z'));
  const m0 = commit(M, 'records: PR #5', '2026-08-01T01:00:00Z');
  git(M, ['checkout', '-q', '-b', 'side']);
  write(M, 'records/reviews/pr-6.json', copy(6, '2026-08-01T00:00:00Z'));
  commit(M, 'records: PR #6', '2026-08-02T00:00:00Z');
  git(M, ['checkout', '-q', RECORDS_REF]);
  git(M, ['merge', '-q', '--no-ff', '--no-commit', 'side'], '2026-08-03T00:00:00Z');
  write(M, 'records/reviews/pr-5.json', copy(5, '2026-07-01T00:00:00Z'));
  git(M, ['add', '-A']);
  git(M, ['commit', '-q', '-m', 'Merge side'], '2026-08-03T00:00:00Z');
  const mScan = scanRecordsHistory(M, { rev: `refs/heads/${RECORDS_REF}`, from: m0 });
  const mCls = classifyRecordsHistory(mScan, { mergedAtOf: () => '2026-08-01T00:00:00Z' });
  // IMPL-0432:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('走査: マージの解決で既存の写しを書き換えたマージコミットを、成立した記録の書き換えとして出す(第1の親との差分)', mCls.rewrites.some((r) => r.status === 'M' && r.path === 'records/reviews/pr-5.json'), JSON.stringify(mCls));
  check('走査: マージで取り込んだ枝の追加は、追加として1件に数える', mCls.additions === 1 && !mCls.rewrites.some((r) => r.path === 'records/reviews/pr-6.json'), JSON.stringify(mCls));
  // 衝突の記録は、走査の範囲で足されたものだけを数える(突合 H-3)
  write(M, 'records/conflicts/pr-5-777-1.json', '{}\n');
  const mHead = commit(M, 'records: 衝突', '2026-08-04T00:00:00Z');
  const cScan = scanRecordsHistory(M, { rev: `refs/heads/${RECORDS_REF}`, from: m0 });
  const cCls = classifyRecordsHistory(cScan, {});
  check('走査: 範囲で足された衝突の記録を conflicts に出す', cCls.conflicts.length === 1 && cCls.conflicts[0].pr === 5 && cCls.conflicts[0].hash === mHead, JSON.stringify(cCls.conflicts));
  check('走査: 前回の出荷の先頭より前の衝突の記録は数えない', classifyRecordsHistory(scanRecordsHistory(M, { rev: `refs/heads/${RECORDS_REF}`, from: mHead }), {}).conflicts.length === 0);

  // 検出の受け入れ(例外承認。突合 H-3)
  const mBranch = readRecordsBranch({ cwd: M, fetch: false });
  const rewrite = mCls.rewrites.find((r) => r.path === 'records/reviews/pr-5.json');
  const target = `${rewrite.hash.slice(0, 9)} records/reviews/pr-5.json`;
  // IMPL-0443:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const acc = recordsHistoryGaps({ branch: mBranch, scan: cScan, classified: cCls, accepted: (d) => (detectionReferred(target, d) ? ['docs/debt-ledger.md D-9'] : []) });
  check('受け入れ: 対象に検出の識別子(コミットとファイル)を書いた例外承認で受け入れた書き換えは欠落に数えず、件数に出す', acc.counts.accepted === 1 && acc.accepted[0].detection.kind === 'rewrite' && !acc.gaps.some((g) => g.includes('records/reviews/pr-5.json') && g.includes('成立した記録の書き換え')), JSON.stringify(acc));
  // IMPL-0443:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('受け入れ: 受け入れていない検出(衝突)は欠落に数え、受け入れ方(対象に書く所在)を示す', acc.gaps.some((g) => /衝突/.test(g) && /records\/conflicts\/pr-5-777-1\.json を書きます/.test(g)), JSON.stringify(acc.gaps));
  check('受け入れ: 識別子の照合はコミットの先頭7桁以上とファイルの両方を要する', !detectionReferred(rewrite.hash.slice(0, 6) + ' records/reviews/pr-5.json', { kind: 'rewrite', hash: rewrite.hash, path: 'records/reviews/pr-5.json' }) && !detectionReferred(rewrite.hash.slice(0, 9), { kind: 'rewrite', hash: rewrite.hash, path: 'records/reviews/pr-5.json' }) && detectionReferred('records/conflicts/pr-5-777-1.json', { kind: 'conflict', hash: mHead, path: 'records/conflicts/pr-5-777-1.json' }));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

// 置き場の規則(雛形のルールセット)
{
  const read = (f) => JSON.parse(fs.readFileSync(path.join(TEMPLATE, '.github', 'rulesets', f), 'utf8'));
  // IMPL-0353:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('置き場の規則: records.json は履歴の書き換えと削除を止め、bypass actor を置かない', recordsRulesetProblems(read('records.json')).length === 0, JSON.stringify(recordsRulesetProblems(read('records.json'))));
  check('置き場の規則: records-signed.json は加えて署名を課す', recordsRulesetProblems(read('records-signed.json'), { signed: true }).length === 0);
  // IMPL-0353:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const weak = { ...read('records.json'), rules: [{ type: 'non_fast_forward' }], bypass_actors: [{ actor_id: 1 }] };
  const p = recordsRulesetProblems(weak);
  check('置き場の規則: 削除を止めない・bypass actor を置くルールセットを問題に出す', p.some((x) => /deletion/.test(x)) && p.some((x) => /bypass/.test(x)), JSON.stringify(p));
  check('置き場の規則: 署名を要する構成で records.json(署名なし)を問題に出す', recordsRulesetProblems(read('records.json'), { signed: true }).some((x) => /required_signatures/.test(x)));
}

// 書き込める主体の開示(保証の開示の項目1 の定型の文)
{
  // IMPL-0439:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const plain = recordsWriterStatement({ signed: false, protection: 'confirmed' });
  check('開示: 署名を課さない構成では、書き込める主体(書き込みの権限を持つ者とジョブのトークン)、規則が止めないこと、管理者が規則を外せること、主体を確かめられないことを書く', /ジョブのトークン/.test(plain) && /既存の記録の変更ではありません/.test(plain) && /規則そのものを外せます/.test(plain) && /確かめられません/.test(plain) && /防いだことを示しません/.test(plain), plain);
  // IMPL-0439:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  const signed = recordsWriterStatement({ signed: true, protection: 'confirmed' });
  check('開示: 署名を課す構成では、人の書き込みは署名で主体を確かめられ、ジョブのトークンの書き込みは区別できないことを書く', /署名を課します/.test(signed) && /区別できません/.test(signed) && !/主体を記録から確かめられません/.test(signed), signed);
  check('開示: 定型の文は良否の評価の語を含めない', !/(安全|十分|問題なし|適切)/.test(plain + signed));
  // 規則で書き換えを止められない構成(無料のプランなど。突合 M-8)
  const none = recordsWriterStatement({ signed: false, protection: 'mismatch' });
  check('開示: 規則が適用されていない構成では、履歴の書き換えと削除も止まらないこと・列挙に無い離脱であることを書き、規則が止めるとは書かない', none.includes('履歴の書き換え(force push)とブランチの削除も止まりません') && none.includes('列挙に無い離脱') && !none.includes('規則(ルールセット)が止めるのは'), none);
  const unk = recordsWriterStatement({ signed: false, protection: 'unconfirmed' });
  check('開示: 規則の適用を確かめていない構成では、その旨を書く', /確かめていません/.test(unk), unk);
  check('離脱: 実環境の統制の確認が記録用ブランチの規則の欠落を観測した構成は、列挙に無い離脱として適合の主張を述べられない', claimStatus({ recordsProtection: { status: 'mismatch', detail: 'ルールセットが無い' } }).blockers?.some?.((b) => /置き場の履歴の書き換えと削除/.test(b)) ?? JSON.stringify(claimStatus({ recordsProtection: { status: 'mismatch', detail: 'x' } })).includes('置き場の履歴の書き換えと削除'), JSON.stringify(claimStatus({ recordsProtection: { status: 'mismatch', detail: 'ルールセットが無い' } })).slice(0, 800));
  check('離脱: 規則を確かめた構成は、この離脱に当たらない', !JSON.stringify(claimStatus({ recordsProtection: { status: 'confirmed', detail: '' } })).includes('置き場の履歴の書き換えと削除'));
  check('離脱: 実環境の統制の確認の記録が無ければ未確認(離脱に数えない)', recordsProtectionState({}, { root: path.join(os.tmpdir(), 'pit-in-no-such-dir') }).status === 'unconfirmed');
}

// 保証の主張の成立条件4 は、帰属を裏づけた記名だけで判定する
{
  const att = { 'docs/gates/g7.md': { backed: true }, 'docs/gates/g8.md': { backed: false, note: '記名が自己申告' } };
  // IMPL-0438:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const ng = unbackedSignerForms([{ file: 'docs/gates/g7.md' }, { file: 'docs/gates/g8.md' }], (f) => att[f]);
  check('成立条件4: 記名が自己申告の G-8 の判定記録を、条件4 を成立させない記録として返す', ng.length === 1 && ng[0].file === 'docs/gates/g8.md' && /自己申告/.test(ng[0].note), JSON.stringify(ng));
  // IMPL-0438:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('成立条件4: 帰属を裏づけた記録だけなら空', unbackedSignerForms([{ file: 'docs/gates/g7.md' }], (f) => att[f]).length === 0);
  check('成立条件4: 帰属の結果が無い記録は、確かめられないものとして返す', unbackedSignerForms([{ file: 'docs/gates/g9.md' }], (f) => att[f])[0]?.note === '帰属を確かめられない');
}

console.log('');
if (failures) {
  console.log(`記録用ブランチの履歴の走査の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`記録用ブランチの履歴の走査の試験: ${n} 件が期待と一致しました`);
