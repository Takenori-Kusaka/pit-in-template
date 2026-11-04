// 効力を持つ記録(例外承認の台帳の行・停止の解除の記録)の帰属の検査(material-attribution.mjs)の試験
// (標準 第4章「判定記録を基底ブランチへ入れる操作」。process-compass #380 / ADR-0106)。PR の時点の検査(check-pr.mjs)と出荷の証跡の集約
// (aggregate-evidence.mjs)が同じ関数を使う。IMPL-0414(集約)と IMPL-0416(ルールセット)の対はここ、IMPL-0413(PR の時点の検査に
// 組み込んだ形)の対は test-check-pr.mjs にある。
//
//   node scripts/gate/test-material-attribution.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declarationOf,
  exceptionReviewBacking,
  stopReviewCandidates,
  stopReleaseTextOfReview,
  introducedBacking,
  lastCommitOfRow,
  lastCommitOfFile,
  normalizeReviews,
  approverLogins,
  fixedHosting,
  ghHosting,
  defaultBranchRulesetProblems,
} from './material-attribution.mjs';
import { parseStopRelease, readPolicy } from './org-assurance.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).slice(0, 600)}`}`);
}

const config = {
  aiNames: ['Claude'],
  people: [
    { id: 'p1', name: '山田 太郎', accounts: ['yamada'] },
    { id: 'p2', name: '鈴木 一郎', accounts: ['suzuki'] },
    { id: 'p3', name: '佐藤 花子', accounts: ['sato'] },
  ],
  seats: [{ role: 'biz-approver', accountable: '佐藤 花子' }],
};
const signer = config.people[1];
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const row = { id: 'D-012', approver: '鈴木 一郎' };
const review = (o = {}) => ({ id: 1, user: { login: 'suzuki', type: 'User' }, state: 'COMMENTED', body: '例外承認: D-012\n\n理由は台帳の行のとおり', submitted_at: '2026-11-05T10:00:00Z', commit_id: HEAD, edited_by: null, ...o });

// ---------------------------------------------------------------- 宣言行
check('宣言行: 例外承認の ID を読む(全角のコロン・小文字も)', declarationOf('例外承認：d-012')?.id === 'D-012' && declarationOf('例外承認: D-012')?.kind === 'exception');
check('宣言行: 停止の解除', declarationOf('<!-- c -->\n停止の解除: 解除\n| 申し立てた者 | 山田 太郎 |')?.kind === 'stop');
check('宣言行: 1行目に無ければ宣言行でない', declarationOf('LGTM\n例外承認: D-012') === null);
check('レビューの形: REST・gh pr view・写しの形をそろえる', (() => {
  const [a, b, c] = normalizeReviews([review(), { author: { login: 'suzuki' }, state: 'APPROVED', body: '', submittedAt: 'x', commit: { oid: HEAD } }, { author: { login: 'x[bot]', is_bot: true }, state: 'APPROVED', commitId: OLD }]);
  return a.login === 'suzuki' && a.commitId === HEAD && b.commitId === HEAD && c.isBot && c.commitId === OLD;
})());

// ---------------------------------------------------------------- (A) 例外承認のレビュー
const backing = (reviews, o = {}) => exceptionReviewBacking(config, row, signer, { reviews, author: 'yamada', head: HEAD, instructorIds: ['p1'], ...o });
// IMPL-0414:ok(違反と適合の対。標準の実装マーク。process-compass #314)
check('A: 承認した者本人が、先頭のコミットに対して宣言行のレビューを出した → 裏づける(COMMENT でよい)', backing([review()]).backed);
// IMPL-0414:ng(違反と適合の対。標準の実装マーク。process-compass #314)
check('A: レビューの後に先頭が変わった → 失効', !backing([review({ commit_id: OLD })]).backed && /失効/.test(backing([review({ commit_id: OLD })]).why.join('')));
check('A: 書き手が PR の作成者 → 数えない(本人か AI かを区別できない)', !backing([review()], { author: 'suzuki' }).backed && /作成者/.test(backing([review()], { author: 'suzuki' }).why.join('')));
check('A: 書き手が台帳の承認した者でない(名前を借りた行) → 数えない', !backing([review({ user: { login: 'sato' } })]).backed);
check('A: 書き手が作成を指示した者 → 数えない', !backing([review()], { instructorIds: ['p2'] }).backed);
check('A: bot・AI の名義 → 数えない', !backing([review({ user: { login: 'suzuki', type: 'Bot' } })]).backed && !backing([review({ user: { login: 'Claude' } })]).backed);
check('A: 取り下げたレビュー → 数えない', !backing([review({ state: 'DISMISSED' })]).backed);
check('A: 別の行の ID を指す宣言行 → 数えない', !backing([review({ body: '例外承認: D-013' })]).backed);
check('A: 名簿に無いアカウント → 数えない', !backing([review({ user: { login: 'stranger' } })]).backed);
check('A: 先頭が分からない → 数えない', !backing([review()], { head: null }).backed);
check('A: レビューを読めない → 数えない', !backing(null).backed);
check('A: 本文を書き手以外が編集した(他人のレビューの1行目を宣言行に書き換えた) → 数えない', !backing([review({ edited_by: 'yamada' })]).backed && /書き手以外/.test(backing([review({ edited_by: 'yamada' })]).why.join('')));
check('A: 本文を書き手本人が編集した → 数える', backing([review({ edited_by: 'suzuki' })]).backed);
check('A: 編集の記録(editor)を読めない → 数えない', !backing([(({ edited_by, ...r }) => r)(review())]).backed);

// ---------------------------------------------------------------- (A) 停止の解除のレビュー
const stopBody = '停止の解除: 解除\n\n| 欄 | 記載 |\n| --- | --- |\n| 申し立てた者 | 山田 太郎 |\n| 解除の理由 | 原因を除いた |\n| 申し立てた者の見解を退けたか | 退けていない |\n| 上申先と日付(退けた場合) | 該当なし |\n';
const stopReview = (o = {}) => ({ id: 9, user: { login: 'sato' }, state: 'COMMENTED', body: stopBody, submitted_at: '2026-11-05T12:00:00Z', commit_id: HEAD, edited_by: null, ...o });
{
  const c = stopReviewCandidates(config, { reviews: [stopReview()], author: 'yamada', head: HEAD, labeledAt: '2026-11-05T09:00:00Z' });
  // IMPL-0414:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check('停止の解除: ラベルの後に、権限者本人が先頭に対して出したレビューを候補にする', c.candidates.length === 1);
  const policy = readPolicy(config, { text: null });
  const r = parseStopRelease(config, policy, 'PR #7 のレビュー 9', stopReleaseTextOfReview(c.candidates[0].review, c.candidates[0].person, 7));
  check('停止の解除: レビューの本文の表を、様式と同じ読み方で読み、権限者(層1 が無ければ事業決裁者)と照合する', r && r.valid && r.target === 'PR #7' && r.judge === '佐藤 花子', JSON.stringify(r?.problems));
  const notAuth = c.candidates.length ? parseStopRelease(config, policy, 'x', stopReleaseTextOfReview(stopReview({ user: { login: 'suzuki' } }), signer, 7)) : null;
  check('停止の解除: 権限者でない人のレビューは成立しない', notAuth && !notAuth.valid);
  // IMPL-0414:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  const before = stopReviewCandidates(config, { reviews: [stopReview({ submitted_at: '2026-11-05T08:00:00Z' })], author: 'yamada', head: HEAD, labeledAt: '2026-11-05T09:00:00Z' });
  check('停止の解除: ラベルを付けた時刻より前のレビューは数えない', !before.candidates.length && /より前/.test(before.rejected.join('')));
  const own = stopReviewCandidates(config, { reviews: [stopReview()], author: 'sato', head: HEAD, labeledAt: '2026-11-05T09:00:00Z' });
  check('停止の解除: 作成者本人のレビューは数えない', !own.candidates.length);
  const noHistory = stopReviewCandidates(config, { reviews: [stopReview()], author: 'yamada', head: HEAD, labeledAt: null });
  check('停止の解除: ラベルを付けた時刻を読めなければ、レビューを数えない', !noHistory.candidates.length && /読めず/.test(noHistory.rejected.join('')));
  const stale = stopReviewCandidates(config, { reviews: [stopReview({ commit_id: OLD })], author: 'yamada', head: HEAD, labeledAt: '2026-11-05T09:00:00Z' });
  check('停止の解除: 解除の後の push で失効', !stale.candidates.length);
}

// ---------------------------------------------------------------- (B) 基底ブランチの記録を入れた変更
// IMPL-0414:ok(違反と適合の対。標準の実装マーク。process-compass #314)
check('B: 行を入れた PR を記名者本人が承認した → 裏づける', introducedBacking(config, signer, { number: 5, author: 'yamada', approvers: ['suzuki'] }).backed);
check('B: 記名者本人が作成し、記名者以外の人が承認した(帰属の確認) → 裏づける', introducedBacking(config, signer, { number: 5, author: 'suzuki', approvers: ['sato'], commitAuthors: ['suzuki'] }).backed);
check('B: PR を経ないコミットで、ホスティングが署名を検証し、committer・author が記名者 → 裏づける', introducedBacking(config, signer, { number: null, verified: true, authorLogin: 'suzuki', committerLogin: 'suzuki' }).backed);
check('B: 署名を検証したコミットでも、committer が記名者でなければ数えない(author は偽装できる)', !introducedBacking(config, signer, { number: null, verified: true, authorLogin: 'suzuki', committerLogin: 'yamada' }).backed);
check('B: 記名者の PR に記名者以外のコミットが混じる(他の者が行を push し、無関係の人が承認) → 数えない', !introducedBacking(config, signer, { number: 5, author: 'suzuki', approvers: ['sato'], commitAuthors: ['suzuki', 'yamada'] }).backed);
check('B: 記名者の PR のコミットの作成者を読めない → 数えない', !introducedBacking(config, signer, { number: 5, author: 'suzuki', approvers: ['sato'] }).backed);
check('B: 名簿に無いアカウントの承認は、帰属の確認に数えない', !introducedBacking(config, signer, { number: 5, author: 'suzuki', approvers: ['stranger'], commitAuthors: ['suzuki'] }).backed);
// IMPL-0414:ng(違反と適合の対。標準の実装マーク。process-compass #314)
check('B: 判定される側が「承認した者: 鈴木」と書いた行の PR を開き、無関係の人が承認した → 数えない(名前を借りる経路)', !introducedBacking(config, signer, { number: 5, author: 'yamada', approvers: ['sato'] }).backed);
check('B: 記名者本人が作成したが、他の人の承認が無い → 数えない', !introducedBacking(config, signer, { number: 5, author: 'suzuki', approvers: [], commitAuthors: ['suzuki'] }).backed);
check('B: bot・AI の承認は帰属の確認に数えない', !introducedBacking(config, signer, { number: 5, author: 'suzuki', approvers: ['ci[bot]', 'Claude'], commitAuthors: ['suzuki'] }).backed);
check('B: PR を経ない署名なしのコミット → 数えない', !introducedBacking(config, signer, { number: null, verified: false, authorLogin: 'suzuki' }).backed);
check('B: ホスティングの記録を読めない → 数えない', !introducedBacking(config, signer, null).backed);
check('B: 記名者のアカウントが名簿に無い → 数えない', !introducedBacking(config, { id: 'x', name: '外部 太郎' }, { number: 5, author: 'yamada', approvers: ['ext'] }).backed);
check('B: 記名者が名簿の人へ対応づかない → 数えない', !introducedBacking(config, null, { number: 5, author: 'yamada', approvers: ['suzuki'] }).backed);
{
  // 帰属の確認者を置けない体制(名簿に記名者以外の人がいない)。自己申告として数え、その旨を出す
  const solo = { aiNames: ['Claude'], people: [{ id: 'p1', name: '山田 太郎', accounts: ['yamada'] }] };
  const me = solo.people[0];
  const s1 = introducedBacking(solo, me, { number: 5, author: 'yamada', approvers: [], commitAuthors: ['yamada'] });
  check('B: 1名の体制で、記名者本人が作成した PR → 自己申告として数え、その旨を出す', s1.backed && s1.selfAttested && /自己申告/.test(s1.note));
  const s2 = introducedBacking(solo, me, { number: null, verified: false, authorLogin: 'yamada' });
  check('B: 1名の体制で、PR を経ない署名なしのコミットの author が記名者 → 自己申告として数える', s2.backed && s2.selfAttested);
  check('B: 1名の体制でも、作成者が記名者でなければ数えない', !introducedBacking(solo, me, { number: 5, author: 'other', approvers: [] }).backed);
  const withExternal = { ...solo, people: [...solo.people, { id: 'ext', name: '外部 確認者', external: true, accounts: ['ext'] }] };
  check('B: 外部の確認者が名簿にいれば、記名者本人の作成だけでは数えない(帰属の確認を要する)', !introducedBacking(withExternal, me, { number: 5, author: 'yamada', approvers: [], commitAuthors: ['yamada'] }).backed && introducedBacking(withExternal, me, { number: 5, author: 'yamada', approvers: ['ext'], commitAuthors: ['yamada'] }).backed);
}
check('承認者: 最後の状態が承認のログインだけ', JSON.stringify(approverLogins([{ user: { login: 'a' }, state: 'APPROVED' }, { user: { login: 'b' }, state: 'APPROVED' }, { user: { login: 'b' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'c' }, state: 'COMMENTED' }])) === '["a"]');
{
  // ホスティングの読み方(gh の代わりに run を渡す)
  const answers = {
    'api repos/o/r/commits/m1/pulls': [{ number: 5, merged_at: 'x', merge_commit_sha: 'm1', head: { sha: 'h5' }, user: { login: 'suzuki' } }],
    'api --paginate repos/o/r/pulls/5/reviews': [{ user: { login: 'sato' }, state: 'APPROVED', commit_id: 'old' }, { user: { login: 'yamada' }, state: 'APPROVED', commit_id: 'h5' }],
    'api --paginate repos/o/r/pulls/5/commits': [{ author: { login: 'suzuki' } }],
    'api repos/o/r/commits/m2/pulls': [{ number: 6, merged_at: 'x', merge_commit_sha: 'other', head: { sha: 'h6' }, user: { login: 'suzuki' } }],
    'api repos/o/r/commits/m2': { commit: { verification: { verified: true } }, author: { login: 'suzuki' }, committer: { login: 'web-flow' } },
  };
  const h = ghHosting('o/r', { run: (args) => answers[args.join(' ')] ?? [] });
  const i1 = h.prOfCommit('m1');
  check('ホスティング: 承認は取り込んだ先頭のコミットに対するものだけを数える(承認の後の push で失効)', JSON.stringify(i1.approvers) === '["yamada"]' && JSON.stringify(i1.commitAuthors) === '["suzuki"]', JSON.stringify(i1));
  const i2 = h.prOfCommit('m2');
  check('ホスティング: そのコミットを取り込みのコミットとしない PR は拾わない(PR を経ないコミットとして読む)', i2.number === null && i2.committerLogin === 'web-flow' && !introducedBacking(config, signer, i2).backed, JSON.stringify(i2));
}
check('固定のホスティング: 未知のコミットは null', fixedHosting({ abc: { number: 1 } }).prOfCommit('abc')?.number === 1 && fixedHosting({}).prOfCommit('zzz') === null);

// ---------------------------------------------------------------- 行・ファイルを最後に変えたコミット
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-material-'));
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: TMP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'tester']);
  git(['config', 'core.autocrlf', 'false']);
  const head = '| ID | 区分 |\n| --- | --- |\n';
  const commit = (text, msg) => {
    fs.writeFileSync(path.join(TMP, 'ledger.md'), text);
    git(['add', '-A']);
    git(['commit', '-q', '-m', msg]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  const c1 = commit(`${head}| D-001 | 例外 | 承認 鈴木 |\n`, 'add D-001');
  const c2 = commit(`${head}| D-001 | 例外 | 承認 鈴木 |\n| D-002 | 例外 | 承認 佐藤 |\n`, 'add D-002');
  check('行を最後に変えたコミット: ほかの行を足したコミットは当たらない', lastCommitOfRow(git, 'HEAD', 'ledger.md', 'D-001') === c1 && lastCommitOfRow(git, 'HEAD', 'ledger.md', 'D-002') === c2);
  const c3 = commit(`${head}|  D-001  | 例外 | 承認 山田 |\n| D-002 | 例外 | 承認 佐藤 |\n`, 'rewrite D-001');
  check('行を最後に変えたコミット: 行を書き換えたコミットを採る(最初に足したコミットではない)', lastCommitOfRow(git, 'HEAD', 'ledger.md', 'D-001') === c3);
  check('ファイルを最後に変えたコミット', lastCommitOfFile(git, 'HEAD', 'ledger.md') === c3 && lastCommitOfRow(git, 'HEAD', 'ledger.md', 'D-999') === null);
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 既定ブランチのルールセット(IMPL-0416)
{
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'rulesets');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const problems = files.flatMap((f) => defaultBranchRulesetProblems(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
  // IMPL-0416:ok(違反と適合の対。標準の実装マーク。process-compass #314)
  check(`ルールセット: 準拠テンプレートの既定ブランチのルールセット(${files.length} 件)は bypass actor を置かず、承認の件数を 0 にしない`, files.length >= 3 && !problems.length, problems.join(' / '));
  const base = JSON.parse(fs.readFileSync(path.join(dir, 'team.json'), 'utf8'));
  // IMPL-0416:ng(違反と適合の対。標準の実装マーク。process-compass #314)
  check('ルールセット: bypass actor を足した形を出す', defaultBranchRulesetProblems({ ...base, bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }] }).length === 1);
  check('ルールセット: 承認の件数を 0 にした形を出す', defaultBranchRulesetProblems({ ...base, rules: base.rules.map((r) => (r.type === 'pull_request' ? { ...r, parameters: { ...r.parameters, required_approving_review_count: 0 } } : r)) }).length === 1);
  check('ルールセット: 既定ブランチを対象としないもの(records)は見ない', !defaultBranchRulesetProblems({ name: 'records', conditions: { ref_name: { include: ['refs/heads/records'] } }, bypass_actors: [{ actor_id: 1 }] }).length);
}

console.log(failures ? `\n効力を持つ記録の帰属の試験: ${checks} 件のうち ${failures} 件が期待と一致しません` : `\n効力を持つ記録の帰属の試験: ${checks} 件が期待と一致しました`);
process.exit(failures ? 1 : 0);
