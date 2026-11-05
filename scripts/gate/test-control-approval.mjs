// 統制の設定の変更の承認と、基底から読む判定の読み方を試験する(標準 第4章 G-5「判定のコードの読み元」「統制の設定の変更の承認」。
// process-compass #371 / ADR-0115)。
//
//   node scripts/gate/test-control-approval.mjs
//
// 確かめること:
//   - controlApprovalBacking: AI維持管理者の席の責任者本人のアカウント(名簿の数値の識別子)の、PR の先頭への承認のレビューで成立する。
//     本文の記名・他の人の承認・失効した承認・ログイン名だけの一致は数えない。作成者が席の責任者本人なら、別の人の承認で帰属を確かめ、
//     1名の体制では自己申告として受け付ける
//   - analyzePr の --head(基底から読む判定): 作業ツリー(既定ブランチ)ではなく、取得した PR の先頭をデータとして読む
//   - analyzePr の --require-control-approval(3c): 統制の設定を変える PR は承認のレビューが無ければ落ち、本文の記名だけでも落ちる。
//     CONTROL_FILES に足した .github/actions/**・.github/gate-node-version と、新しいワークフローの追加も統制の設定の変更に数える
//   - 出荷の証跡の集約(controlApprovalSummary): 承認の無い変更を欠落に数え、自己申告と規定の採用日より前の変更は欠落に数えない
// GitHub へ問い合わせません。実際の GitHub 上での承認の振る舞い(別のアカウントの承認。実機の確認 E-7・E-13)は確かめていません。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePr, CONTROL_FILES, controlTouchedOf } from './check-pr.mjs';
import { controlApprovalBacking, CONTROL_APPROVAL_REQUIRED_SINCE } from './material-attribution.mjs';
import { controlApprovalSummary } from './aggregate-evidence.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

// 名簿(架空の人名)。鈴木 一郎が AI維持管理者の席の責任者
const UID = { yamada: 2001, suzuki: 2002, sato: 2003, bot: 2099 };
const acct = (login) => ({ login, id: UID[login] });
const people = [
  { id: 'p1', name: '山田 太郎', accounts: [acct('yamada')] },
  { id: 'p2', name: '鈴木 一郎', accounts: [acct('suzuki')] },
  { id: 'p3', name: '佐藤 花子', accounts: [acct('sato')] },
];
const seats = [
  { role: 'developer', accountable: '山田 太郎' },
  { role: 'ai-maintainer', accountable: '鈴木 一郎' },
];
const cfg = { configured: true, people, seats, changeLog: [] };
const HEAD = 'a'.repeat(40);
const review = (login, { state = 'APPROVED', commit = HEAD, id = UID[login], editedBy = null, body = '' } = {}) => ({
  id: Math.floor(Math.random() * 1e9),
  state,
  body,
  submitted_at: '2026-11-05T10:00:00Z',
  commit_id: commit,
  author_association: 'MEMBER',
  author: { login, id, is_bot: false },
  edited_by: editedBy,
});
const yamadaAuthor = { login: 'yamada', id: UID.yamada };

// ---------------------------------------------------------------- controlApprovalBacking
{
  // IMPL-0456:ok
  const ok = controlApprovalBacking(cfg, { reviews: [review('suzuki')], author: yamadaAuthor, head: HEAD });
  check('AI維持管理者本人(数値の識別子)の先頭への承認のレビューで成立する', ok.backed && ok.how === 'review' && !ok.selfAttested, JSON.stringify(ok));
  // IMPL-0456:ng
  const none = controlApprovalBacking(cfg, { reviews: [], author: yamadaAuthor, head: HEAD });
  check('承認のレビューが無ければ成立しない', !none.backed && /本人の承認のレビュー/.test(none.why.join()), JSON.stringify(none));
  const other = controlApprovalBacking(cfg, { reviews: [review('sato')], author: yamadaAuthor, head: HEAD });
  check('AI維持管理者でない人の承認は数えない', !other.backed, JSON.stringify(other));
  const stale = controlApprovalBacking(cfg, { reviews: [review('suzuki', { commit: 'b'.repeat(40) })], author: yamadaAuthor, head: HEAD });
  check('先頭と違うコミットへの承認(失効)は数えない', !stale.backed && /失効/.test(stale.why.join()), JSON.stringify(stale));
  const wrongId = controlApprovalBacking(cfg, { reviews: [review('suzuki', { id: 9999 })], author: yamadaAuthor, head: HEAD });
  check('ログイン名が一致しても数値の識別子が違う書き手は数えない', !wrongId.backed, JSON.stringify(wrongId));
  const withdrawn = controlApprovalBacking(cfg, { reviews: [review('suzuki'), review('suzuki', { state: 'CHANGES_REQUESTED' })], author: yamadaAuthor, head: HEAD });
  check('承認の後に同じ人が変更要求を出したら数えない(最後の状態)', !withdrawn.backed, JSON.stringify(withdrawn));
  const edited = controlApprovalBacking(cfg, { reviews: [review('suzuki', { editedBy: 'yamada' })], author: yamadaAuthor, head: HEAD });
  check('書き手以外が本文を編集した承認は数えない', !edited.backed, JSON.stringify(edited));
  const noSeat = controlApprovalBacking({ ...cfg, seats: [{ role: 'developer', accountable: '山田 太郎' }] }, { reviews: [review('suzuki')], author: yamadaAuthor, head: HEAD });
  check('AI維持管理者の席が無い構成では成立しない', !noSeat.backed && /席の責任者が構成/.test(noSeat.why.join()), JSON.stringify(noSeat));
  // 作成者が席の責任者本人(本人は自分の PR を承認できない)
  const suzukiAuthor = { login: 'suzuki', id: UID.suzuki };
  const selfNoConf = controlApprovalBacking(cfg, { reviews: [], author: suzukiAuthor, head: HEAD });
  check('作成者が AI維持管理者本人で、名簿に別の人がいるのに確認の承認が無ければ成立しない', !selfNoConf.backed && /自分の PR を承認できない/.test(selfNoConf.why.join()), JSON.stringify(selfNoConf));
  const selfConf = controlApprovalBacking(cfg, { reviews: [review('sato')], author: suzukiAuthor, head: HEAD });
  check('作成者が AI維持管理者本人なら、別の名簿の人の承認で成立する(帰属の確認)', selfConf.backed && selfConf.how === 'author', JSON.stringify(selfConf));
  const alone = { configured: true, people: [people[1]], seats: [{ role: 'ai-maintainer', accountable: '鈴木 一郎' }], changeLog: [] };
  const selfAlone = controlApprovalBacking(alone, { reviews: [], author: suzukiAuthor, head: HEAD });
  check('1名の体制で作成者が AI維持管理者本人なら、自己申告として受け付ける(AR-3)', selfAlone.backed && selfAlone.selfAttested && selfAlone.how === 'self-attested', JSON.stringify(selfAlone));
  const botAuthor = controlApprovalBacking(cfg, { reviews: [review('suzuki')], author: { login: 'dependabot[bot]', id: 49699333 }, head: HEAD });
  check('依存の更新の bot の PR も、AI維持管理者本人の承認で成立する', botAuthor.backed, JSON.stringify(botAuthor));
}

// ---------------------------------------------------------------- CONTROL_FILES
check('CONTROL_FILES に .github/actions/** と .github/gate-node-version がある', CONTROL_FILES.includes('.github/actions/**') && CONTROL_FILES.includes('.github/gate-node-version'), JSON.stringify(CONTROL_FILES));
check(
  'controlTouchedOf: 手元の action・Node の版・新しいワークフロー・名前の変更の元を数え、製品のコードは数えない',
  JSON.stringify(controlTouchedOf([{ path: '.github/actions/setup-stack/action.yml' }, { path: '.github/gate-node-version' }, { path: '.github/workflows/fake.yml' }, { path: 'src/x.js', from: 'scripts/gate/old.mjs' }, { path: 'src/a.js' }]).sort()) ===
    JSON.stringify(['.github/actions/setup-stack/action.yml', '.github/gate-node-version', '.github/workflows/fake.yml', 'scripts/gate/old.mjs'].sort())
);

// ---------------------------------------------------------------- analyzePr(--head と --require-control-approval)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-control-approval-'));
const git = (...args) => execFileSync('git', args, { cwd: TMP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true });
  fs.writeFileSync(path.join(TMP, rel), typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n');
};
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'tester');
git('config', 'core.autocrlf', 'false');
write('process.config.json', { ...cfg, adapters: { stack: 'node' }, task: { maxChangedLines: 400, maxChangedFiles: 15 } });
write('.github/workflows/gate-g5.yml', 'name: gate-g5\non: pull_request\n');
write('.github/actions/setup-stack/action.yml', 'name: setup\n');
write('.github/gate-node-version', '22\n');
write('scripts/gate/check-pr.mjs', "export const CONTROL_FILES = ['.github/workflows/**'];\n");
write('src/a.js', 'export const a = 1;\n');
git('add', '-A');
git('commit', '-q', '-m', 'chore: base');

const RISK = '## リスク区分\n\nR3\n\n';
const NEG = '## 統制の設定の陰性の確認\n\n通した違反の場面: 必須の検査を外した PR を通した\n結果: 止まった\n確かめた者: 佐藤 花子\n\n';
const REMOVED = '## 統制の設定の陰性の確認\n\n結果: 外した\n外した検査: pr-rules\n止めていた場面: 陰性の確認の無い PR\n外した後に止めるもの: なし(止めないと決めた)\n受け入れた者: 鈴木 一郎\n\n';
const BODY = (extra = '') => `## 変更の概要\n\n説明\n\n## 作成を指示した者\n\n山田 太郎\n\n${RISK}${extra}## トレーラ\n\nSpec: setup\n`;
let k = 0;
/** PR のブランチを作り、既定ブランチへ戻ってから(作業ツリーは既定ブランチ)、取得した参照を head として判定する */
function pr(name, mutate, { body = BODY(NEG), reviews = [], author = 'yamada' } = {}) {
  k++;
  const branch = `pr-${k}`;
  git('switch', '-q', '-C', branch, 'main');
  mutate();
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', `change ${k}`);
  const head = git('rev-parse', 'HEAD').trim();
  git('switch', '-q', 'main');
  const prIn = { number: 100 + k, title: 'chore: x', body, author, authorId: UID[author] ?? null, reviews: reviews.map((r) => ({ ...r, commit_id: r.commit_id === HEAD ? head : r.commit_id })), head, hostingLookup: { prOfCommit: () => null } };
  return analyzePr({ root: TMP, base: 'main', pr: prIn, head: `refs/heads/${branch}`, requireControlApproval: true });
}
const hasErr = (r, re) => r.errors.some((e) => re.test(e));

{
  // 作業ツリーは既定ブランチのまま、取得した PR の先頭の差分を読む(ワークフローの定義の側は test-base-judge-workflow.mjs)
  const r = pr('PR の先頭の差分を読む', () => write('src/a.js', 'export const a = 2;\nexport const b = 3;\n'), { body: BODY() });
  check('--head: 作業ツリー(既定ブランチ)でなく、PR の先頭の差分を読む', r.size?.lines === 2 && r.size?.files === 1, JSON.stringify(r.size));
  check('--head: 作業ツリーは既定ブランチのまま(PR のファイルを取り出さない)', fs.readFileSync(path.join(TMP, 'src/a.js'), 'utf8') === 'export const a = 1;\n');
  // PR の側が判定のコードの一覧を空にしても、判定は PR の側のコードを使わず、統制の設定の変更として承認を求める(実機の確認 E-2 の経路)
  const r2 = pr('PR の側が CONTROL_FILES を空にする', () => write('scripts/gate/check-pr.mjs', 'export const CONTROL_FILES = [];\n'));
  check('PR の側が判定のコード(CONTROL_FILES)を空にしても、既定ブランチの判定のコードが統制の設定の変更として扱い、承認を求めて落ちる', hasErr(r2, /統制の設定の変更の承認/), JSON.stringify(r2.errors));
}
{
  // IMPL-0456:ng(強制層の変更を含む PR で、承認のレビューが無ければ落ちる)
  const r = pr('ワークフローを書き換え、承認なし', () => write('.github/workflows/gate-g5.yml', 'name: gate-g5\non: pull_request\njobs: {}\n'));
  check('強制層(ワークフロー)の変更を含む PR で、承認のレビューが無ければ落ちる', hasErr(r, /統制の設定の変更の承認/) && r.controlApproval?.backing?.backed === false, JSON.stringify(r.errors));
  const r2 = pr('本文の記名だけ', () => write('.github/workflows/gate-g5.yml', 'name: gate-g5\non: pull_request\njobs: {}\n'), { body: BODY(REMOVED) });
  check('本文の記名(受け入れた者: AI維持管理者)だけでは落ちる', hasErr(r2, /統制の設定の変更の承認/) && hasErr(r2, /本文の記名は承認に数えない/), JSON.stringify(r2.errors));
  const r3 = pr('承認あり', () => write('.github/workflows/gate-g5.yml', 'name: gate-g5\non: pull_request\njobs: {}\n'), { reviews: [review('suzuki')] });
  check('AI維持管理者本人の承認のレビューがあれば、承認の検査は通る', !hasErr(r3, /統制の設定の変更の承認/) && r3.controlApproval?.backing?.backed === true, JSON.stringify(r3.errors));
  const r4 = pr('手元の action', () => write('.github/actions/setup-stack/action.yml', 'name: setup\nruns: { using: composite, steps: [] }\n'));
  check('.github/actions/** の変更は統制の設定の変更に数える', hasErr(r4, /統制の設定の変更の承認/) && r4.controlApproval.changed.includes('.github/actions/setup-stack/action.yml'), JSON.stringify(r4.controlApproval));
  const r5 = pr('Node の版', () => write('.github/gate-node-version', '20\n'));
  check('.github/gate-node-version の変更は統制の設定の変更に数える', hasErr(r5, /統制の設定の変更の承認/) && r5.controlApproval.changed.includes('.github/gate-node-version'), JSON.stringify(r5.controlApproval));
  const r6 = pr('同じ名前のジョブを足す新しいワークフロー', () => write('.github/workflows/fake.yml', 'name: fake\non: pull_request\njobs:\n  gate-g5-base:\n    runs-on: ubuntu-latest\n    steps: [{ run: exit 0 }]\n'), { body: BODY() });
  check('基底に無いワークフローの追加も統制の設定の変更に数え、承認を求める', hasErr(r6, /統制の設定の変更の承認/), JSON.stringify(r6.errors));
  const r7 = pr('統制の設定に触れない', () => write('src/a.js', 'export const a = 5;\n'), { body: BODY() });
  check('統制の設定に触れない PR には承認を求めない', !hasErr(r7, /統制の設定の変更の承認/) && r7.controlApproval?.changed.length === 0, JSON.stringify(r7.errors));
}
{
  // --require-control-approval を渡さない(gate-g5.yml の pr-rules)ときは、承認を照らさない(PR の側で動く判定は同じ PR で外せるため)
  k++;
  git('switch', '-q', '-C', `pr-${k}`, 'main');
  write('.github/workflows/gate-g5.yml', 'name: gate-g5\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  const r = analyzePr({ root: TMP, base: 'main', pr: { number: 900, title: 'x', body: BODY(NEG), author: 'yamada', authorId: UID.yamada, reviews: [], hostingLookup: { prOfCommit: () => null } } });
  git('switch', '-q', 'main');
  check('PR の側で動く判定(--require-control-approval なし)は承認を照らさない', !r.controlApproval && !hasErr(r, /統制の設定の変更の承認/), JSON.stringify(r.errors));
}

// ---------------------------------------------------------------- 出荷の証跡の集約(controlApprovalSummary)
{
  const p = (number, { files = ['.github/workflows/gate-g5.yml'], reviews = [], author = 'yamada', mergedAt = '2026-11-10T00:00:00Z', parentConfigured = true } = {}) => ({
    number,
    control: { files, parentConfigured },
    mergedAt,
    material: { reviews, head: HEAD, author, authorId: UID[author] ?? null },
  });
  // IMPL-0457:ng
  const s = controlApprovalSummary([p(1), p(2, { reviews: [review('suzuki')] }), p(3, { files: [] }), p(4, { mergedAt: '2026-10-01T00:00:00Z' }), p(5, { parentConfigured: false })], cfg);
  check('集約: 統制の設定を変えた変更に承認が無ければ欠落に数える', s.missing.map((x) => x.pr).join() === '1' && s.gaps.length === 1 && /PR #1/.test(s.gaps[0]), JSON.stringify(s.gaps));
  // IMPL-0457:ok
  check('集約: 承認のレビューがある変更は欠落に数えない', s.review === 1 && !s.missing.some((x) => x.pr === 2));
  check(`集約: 規定の採用日(${CONTROL_APPROVAL_REQUIRED_SINCE})より前の変更は欠落に数えず、別に数える`, s.beforeRule.map((x) => x.pr).join() === '4');
  check('集約: 統制の設定に触れない変更と、マージの前の構成が未設定の変更は数えない', s.changes.length === 3);
  const alone = { configured: true, people: [people[1]], seats: [{ role: 'ai-maintainer', accountable: '鈴木 一郎' }] };
  const s2 = controlApprovalSummary([p(7, { author: 'suzuki' })], alone);
  check('集約: 1名の体制の自己申告は欠落に数えず、件数を出す', s2.selfAttested === 1 && !s2.gaps.length, JSON.stringify(s2));
  const s3 = controlApprovalSummary([p(8, { reviews: [], author: 'yamada' })], cfg, { mergedAtOf: () => null });
  check('集約: マージの時刻を読めない変更は、採用日より前に数えない(欠落)', s3.missing.length === 1);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${n - failures} / ${n} 件が期待どおり`);
process.exit(failures ? 1 : 0);
