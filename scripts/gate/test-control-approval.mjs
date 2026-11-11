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
//   - 1名の体制の自己申告は、本人のアカウントのレビュー(意見のレビューでよい)を数値の識別子で照らして成立させる。本文の記名だけでは通さない
//   - PR の時点の判定と出荷の集約が、統制の設定を変えたファイルを同じ範囲で数える(controlTouchedBetween)
//   - 出荷の証跡の集約(controlApprovalSummary): 承認の無い変更を欠落に数え、自己申告と規定を取り込む前の変更は欠落に数えない。
//     規定を取り込む前かは、基底ブランチの第1親の連鎖で gate-g5-base.yml を初めて足したコミットで決める(controlRuleBoundary。日付に依らない)
// GitHub へ問い合わせません。実際の GitHub 上での承認の振る舞い(別のアカウントの承認。実機の確認 E-7・E-13)は確かめていません。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePr, CONTROL_FILES, controlTouchedOf, controlTouchedBetween } from './check-pr.mjs';
import { controlApprovalBacking } from './material-attribution.mjs';
import { controlApprovalSummary, controlRuleBoundary, CONTROL_RULE_FILE } from './aggregate-evidence.mjs';

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
  // IMPL-0456:ng(1名の体制でも、本文の記名だけ・本人の操作の無い自己申告は数えない。突合 C-6、実機の確認 F-5)
  const selfNone = controlApprovalBacking(alone, { reviews: [], author: suzukiAuthor, head: HEAD });
  check('1名の体制でも、本人のアカウントのレビューが無ければ自己申告は成立しない(本文の記名だけでは通さない)', !selfNone.backed && /本文の記名だけでは数えない/.test(selfNone.why.join()), JSON.stringify(selfNone));
  const selfAlone = controlApprovalBacking(alone, { reviews: [review('suzuki', { state: 'COMMENTED', body: '承認します' })], author: suzukiAuthor, head: HEAD });
  check('1名の体制で、本人が PR の先頭に意見のレビューを出せば、自己申告として受け付ける(AR-3・C-6)', selfAlone.backed && selfAlone.selfAttested && selfAlone.how === 'self-attested' && selfAlone.review?.state === 'COMMENTED', JSON.stringify(selfAlone));
  const selfStale = controlApprovalBacking(alone, { reviews: [review('suzuki', { state: 'COMMENTED', commit: 'c'.repeat(40) })], author: suzukiAuthor, head: HEAD });
  check('1名の体制で、本人のレビューが PR の先頭でなければ自己申告は成立しない', !selfStale.backed, JSON.stringify(selfStale));
  const selfWrongId = controlApprovalBacking(alone, { reviews: [review('suzuki', { state: 'COMMENTED', id: 9999 })], author: suzukiAuthor, head: HEAD });
  check('1名の体制で、ログイン名だけが一致する(数値の識別子が違う)レビューは本人の操作に数えない', !selfWrongId.backed, JSON.stringify(selfWrongId));
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
  // 指示資産の変更の承認(標準 第3章 3.11.5。process-compass #358)
  // 規則の前の版(既定ブランチの判定のコードが指示資産の承認を持たない)では、指示資産の変更を数えない(遡って欠けにしない)
  const before = pr('規則の前の版で CLAUDE.md を変える', () => write('CLAUDE.md', '# 規約\n'), { body: BODY() });
  check('既定ブランチの判定のコードに指示資産の規則が無い版では、指示資産の変更に承認を求めない', !hasErr(before, /統制の設定の変更の承認/), JSON.stringify(before.errors));
  git('switch', '-q', 'main');
  write('scripts/gate/check-pr.mjs', "export const CONTROL_FILES = ['.github/workflows/**'];\nexport const INSTRUCTION_ASSET_FILES = ['CLAUDE.md'];\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: instruction asset rule');
  // IMPL-0227:ng(指示資産・外部ツールの一覧を変える PR で、AI維持管理者本人の承認が無ければ落ちる)
  const a = pr('CLAUDE.md を変え、承認なし', () => write('CLAUDE.md', '# 規約\n\n- 規則を足す\n'), { body: BODY() });
  check('指示資産(CLAUDE.md)の変更に、承認のレビューが無ければ落ちる', hasErr(a, /統制の設定の変更の承認/) && a.controlApproval?.changed.includes('CLAUDE.md'), JSON.stringify(a.errors));
  const b = pr('スキルを足し、承認なし', () => write('.claude/skills/x/SKILL.md', '---\nname: x\n---\n'), { body: BODY() });
  check('指示資産(.claude/skills/)の追加に、承認のレビューが無ければ落ちる', hasErr(b, /統制の設定の変更の承認/), JSON.stringify(b.errors));
  const c = pr('.mcp.json を足し、承認なし', () => write('.mcp.json', '{ "mcpServers": { "x": { "command": "npx" } } }\n'));
  check('外部ツールの一覧(.mcp.json)の追加に、承認のレビューが無ければ落ちる', hasErr(c, /統制の設定の変更の承認/) && c.controlApproval?.changed.includes('.mcp.json'), JSON.stringify(c.errors));
  // IMPL-0227:ok(AI維持管理者本人の承認があれば通り、指示資産だけの変更には陰性の確認を求めない)
  const d = pr('CLAUDE.md を変え、承認あり', () => write('CLAUDE.md', '# 規約\n\n- 規則を足す\n'), { body: BODY(), reviews: [review('suzuki')] });
  check('指示資産の変更に AI維持管理者本人の承認があれば通り、陰性の確認を求めない', !hasErr(d, /統制の設定の変更の承認/) && !hasErr(d, /陰性の確認/), JSON.stringify(d.errors));
  check('controlTouchedOf: 下位の CLAUDE.md・AGENTS.md を数え、文書の *.md は数えない', JSON.stringify(controlTouchedOf([{ path: 'pkg/CLAUDE.md' }, { path: 'AGENTS.md' }, { path: 'docs/design.md' }]).sort()) === JSON.stringify(['AGENTS.md', 'pkg/CLAUDE.md']));
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

{
  // 2つの照合の範囲の一致(突合 C-4): アダプタの thresholdFiles、process.config.json の閾値の鍵、名前の変更の元を、PR の時点の判定と
  // 出荷の集約(controlTouchedBetween)が同じに数える
  git('switch', '-q', 'main');
  write('adapters/node.json', { thresholdFiles: ['vitest.config.js'] });
  write('vitest.config.js', 'export default {};\n');
  write('scripts/gate/old.mjs', '// old\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: adapter');
  const r = pr('範囲の一致', () => {
    write('vitest.config.js', 'export default { coverage: {} };\n');
    git('mv', 'scripts/gate/old.mjs', 'src/moved.mjs');
    const c = JSON.parse(fs.readFileSync(path.join(TMP, 'process.config.json'), 'utf8'));
    write('process.config.json', { ...c, task: { ...c.task, maxChangedLines: 800 } });
  });
  const between = controlTouchedBetween((a) => {
    try {
      return git(...a);
    } catch {
      return null;
    }
  }, 'main', `pr-${k}`).sort();
  const atPr = [...(r.controlApproval?.changed ?? [])].sort();
  check('範囲: アダプタの閾値・構成の閾値・名前の変更の元を、PR の時点の判定と出荷の集約が同じに数える', JSON.stringify(atPr) === JSON.stringify(between) && ['vitest.config.js', 'scripts/gate/old.mjs', 'process.config.json'].every((f) => between.includes(f)), `${JSON.stringify(atPr)} / ${JSON.stringify(between)}`);
}
{
  // 1名の体制の PR の時点の判定(突合 C-6、実機の確認 F-5): 本文の記名だけでは通さず、本人の意見のレビューで自己申告として通す
  git('switch', '-q', 'main');
  const c = JSON.parse(fs.readFileSync(path.join(TMP, 'process.config.json'), 'utf8'));
  write('process.config.json', { ...c, people: [people[1]], seats: [{ role: 'ai-maintainer', accountable: '鈴木 一郎' }] });
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: alone');
  const r1 = pr('1名の体制・本文の記名だけ', () => write('.github/workflows/gate-g5.yml', 'name: gate-g5\non: pull_request\njobs: { x: {} }\n'), { body: BODY(REMOVED), author: 'suzuki' });
  check('1名の体制: 本文の記名(受け入れた者)だけでは gate-g5-base の承認の検査を通さない', hasErr(r1, /統制の設定の変更の承認/) && hasErr(r1, /本文の記名だけでは数えない/), JSON.stringify(r1.errors));
  const r2 = pr('1名の体制・本人の意見のレビュー', () => write('.github/workflows/gate-g5.yml', 'name: gate-g5\non: pull_request\njobs: { y: {} }\n'), { author: 'suzuki', reviews: [review('suzuki', { state: 'COMMENTED' })] });
  check('1名の体制: 本人のアカウントの意見のレビュー(PR の先頭)で、自己申告として通す', !hasErr(r2, /統制の設定の変更の承認/) && r2.controlApproval?.backing?.selfAttested === true, JSON.stringify(r2.errors));
}

// ---------------------------------------------------------------- 出荷の証跡の集約(controlApprovalSummary)
{
  const p = (number, { files = ['.github/workflows/gate-g5.yml'], reviews = [], author = 'yamada', parentConfigured = true, before = false } = {}) => ({
    number,
    control: { files, parentConfigured },
    before,
    material: { reviews, head: HEAD, author, authorId: UID[author] ?? null },
  });
  const beforeRuleOf = (x) => x.before;
  // IMPL-0457:ng
  const s = controlApprovalSummary([p(1), p(2, { reviews: [review('suzuki')] }), p(3, { files: [] }), p(4, { before: true }), p(5, { parentConfigured: false })], cfg, { beforeRuleOf });
  check('集約: 統制の設定を変えた変更に承認が無ければ欠落に数える', s.missing.map((x) => x.pr).join() === '1' && s.gaps.length === 1 && /PR #1/.test(s.gaps[0]), JSON.stringify(s.gaps));
  // IMPL-0457:ok
  check('集約: 承認のレビューがある変更は欠落に数えない', s.review === 1 && !s.missing.some((x) => x.pr === 2));
  check('集約: 規定を取り込む前の変更は欠落に数えず、別に数える', s.beforeRule.map((x) => x.pr).join() === '4');
  check('集約: 統制の設定に触れない変更と、マージの前の構成が未設定の変更は数えない', s.changes.length === 3);
  const alone = { configured: true, people: [people[1]], seats: [{ role: 'ai-maintainer', accountable: '鈴木 一郎' }] };
  const s2 = controlApprovalSummary([p(7, { author: 'suzuki', reviews: [review('suzuki', { state: 'COMMENTED' })] })], alone);
  check('集約: 1名の体制の自己申告(本人の意見のレビューあり)は欠落に数えず、件数を出す', s2.selfAttested === 1 && !s2.gaps.length, JSON.stringify(s2));
  const s2b = controlApprovalSummary([p(9, { author: 'suzuki' })], alone);
  check('集約: 1名の体制でも、本人の操作の無い変更は欠落に数える', s2b.missing.length === 1 && s2b.gaps.length === 1, JSON.stringify(s2b));
}
{
  // 規定を取り込んだ境(議長の裁定 J-5、突合 C-2): 基底ブランチの第1親の連鎖で gate-g5-base.yml を初めて足したコミット。日付に依らない
  const T2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-control-boundary-'));
  const g2 = (...a) => execFileSync('git', a, { cwd: T2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const g2n = (a) => {
    try {
      return g2(...a);
    } catch {
      return null;
    }
  };
  const w2 = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(T2, rel)), { recursive: true });
    fs.writeFileSync(path.join(T2, rel), text);
  };
  g2('init', '-q', '-b', 'main');
  g2('config', 'user.email', 't@example.com');
  g2('config', 'user.name', 'tester');
  const commit = (msg, date) => {
    g2('add', '-A');
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: T2, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
    return g2('rev-parse', 'HEAD').trim();
  };
  w2('a.txt', '1\n');
  const before = commit('before', '2026-09-01T00:00:00Z');
  const none = controlRuleBoundary(g2n, 'HEAD');
  check('境: gate-g5-base.yml を一度も取り込んでいない構成は、すべて規定の前', none.boundary === null && none.beforeRule(before) === true);
  w2(CONTROL_RULE_FILE, 'name: gate-g5-base\n');
  const intro = commit('introduce', '2026-09-02T00:00:00Z');
  w2('a.txt', '2\n');
  // 日付を規定の前へ偽った後のコミット(第1親の連鎖の順で決まり、日付に依らない)
  const after = commit('after-with-old-date', '2020-01-01T00:00:00Z');
  const b = controlRuleBoundary(g2n, 'HEAD');
  check('境: 取り込んだコミット以前は規定の前、後は規定の後(コミットの日付を偽っても後)', b.boundary === intro && b.beforeRule(before) === true && b.beforeRule(intro) === true && b.beforeRule(after) === false, JSON.stringify({ boundary: b.boundary }));
  check('境: 連鎖に無いコミットは規定の後に数える', b.beforeRule('0'.repeat(40)) === false);
  fs.rmSync(T2, { recursive: true, force: true });
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${n - failures} / ${n} 件が期待どおり`);
process.exit(failures ? 1 : 0);
