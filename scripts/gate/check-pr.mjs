// G-5 の PR 単位の検査(#286)。gate-g5.yml の pr-rules ジョブが呼ぶ。手元ではフィクスチャで試験する
// (scripts/gate/test-check-pr.mjs)。
//
//   node scripts/gate/check-pr.mjs --base origin/<PR の基底> [--policy-base origin/<既定ブランチ>] [--pr <PR の JSON>] [--report <出力先>] [--comment] [--json]
//                                  [--head <PR の先頭を取得した参照> --require-control-approval]
//
// 基底から読む判定(process-compass #371 / ADR-0115): gate-g5-base.yml は、pull_request_target で既定ブランチを取り出し、
// この判定のコードと構成を既定ブランチから読む。PR の先頭は取得(fetch)だけを行い、--head で渡した参照を git の内容として読む
// (取り出さない・実行しない)。--require-control-approval で、統制の設定を変える PR に AI維持管理者本人の承認のレビューを求める(3c)。
// 結果は、そのジョブの結果(check run)で出す。commit status で出さない(PR の側のワークフローが同じ context で上書きできるため)
//
// 差分は PR の基底(--base)から取る。基準値・名簿・区分の下限の規則・除外設定(.gitattributes)・台帳の例外承認・
// 停止の申し立ての解除の記録は、既定ブランチ(--policy-base)の先端から読む(標準 フェーズ5「スタック型 PR」・CI/CD ゲート構成
// の pr-rules。process-compass #294 / ADR-0078)。スタックの上の層の PR は基底が下の層のブランチになり、まだ既定ブランチへ
// 入っていない下の層で緩めた基準値で判定される経路を開くためである。既定ブランチの構成が未設定で基底が設定済みなら、PR の
// 側の構成へ戻らず失敗する。--policy-base を省くと --base との分岐点から読む(手元の実行)。
// 以下の「基底ブランチの構成」「基底ブランチの台帳」は、この既定ブランチの側を指す
// PR の情報(番号・題名・本文・作成者)は、--pr の JSON({ number, title, body, author })か、環境変数
// PR_NUMBER / PR_TITLE / PR_BODY / PR_AUTHOR から読む。題名と本文をシェルへ展開しないため、ワークフローは
// 環境変数で渡す。
//
// 検査は 1〜8 と 3b。1〜3・3b・5〜7 は失敗させる。4・8 は失敗させない。
//   1. トレーラ Spec: スカッシュのメッセージになる PR の本文の末尾の段落に `Spec: F-NNN / Task-N` があり、
//      指す仕様(specs/F-NNN/spec.md)と実装計画のタスクが実在すること。製品のコードを変えない PR と、
//      依存の更新の bot の PR は対象外(出力に出す)
//   2. 変更規模の基準値(#295 / ADR-0058): 構成の task.maxChangedLines / maxChangedFiles(基底ブランチの構成)を、
//      製品のコードの差分で数える。算定は、ファイルごとの max(追加, 削除)の合計。テスト・fixture・snapshot
//      (TEST_PATTERNS と構成 task.nonProductPaths)は別に数え、基準値の判定に入れない。算定から除くのは、文書・記録・
//      強制層(下の NON_PRODUCT。ただし *.md は、文書の置き場(DOC_ONLY_DIRS)とリポジトリの直下にあるものだけを除き、
//      置き場の外の *.md は数える。#289 D-10 / ADR-0072)、ロックファイル、生成物(基底ブランチの .gitattributes の linguist-generated、または
//      基底で生成の印を持つファイル)、空白だけの変更(一括整形)、内容の変わらない名前の変更。
//      **基準値の超過は失敗にしない**(遮断として運用しない)。超過した PR は、(a) size:over を結果に出し、(b) 区分の下限を
//      R2 へ引き上げ(7)、(c) PR の本文の「規模の確認」(実施者・読み切れたか・分割しなかった理由・保証の所在)を要する。
//      欄が無い、実施者が AI の名義、「読み切れたか」が「いいえ」のときだけ失敗させる。担保水準 L1 以上の宣言(task.assurance)に
//      根拠が実在すれば、保証の所在の記入だけでよい。基準値は null(基準なし)を取れる。null が効くのは、L2 の宣言と根拠が
//      実在し、R3 で、確約範囲・コア指定のパスに触れない変更だけである。基底の構成が未設定の初回(chore/process-init)は判定しない。
//      基底ブランチの台帳に有効な例外承認の行がある PR は、従来どおり規模の確認を要さない(過去の記録を壊さない)
//   3. 閾値・除外設定と製品のコードの同時変更(第4章 G-5「基準値と除外設定の変更」): 基底に既にある閾値・除外設定のファイルと、製品の
//      コードが、同じ PR でともに変わった場合だけ失敗させる。閾値だけの PR と、初回の設定(基底に無いファイル、
//      基底の構成が未設定)は通す
//   3b. 統制の設定の陰性の確認(標準 第4章 G-5 / ADR-0073・ADR-0074): 閾値・除外設定(3 と同じ)、ルールセット・フック・権限・
//      ワークフロー・コード所有者の設定と検査装置(検査のスクリプト・知識ベースの複製・アダプタ。CONTROL_FILES)を変える PR は、
//      本文の「## 統制の設定の陰性の確認」に通した違反の場面・結果(止まった / 止まらなかった / 外した)・確かめた者を要する。
//      欠けている、結果が「止まらなかった」、確かめた者が AI の名義なら失敗させる。結果が「外した」(検査を意図して外す)なら、
//      外した検査・止めていた場面・外した後に止めるもの・受け入れた者(AI の名義でない。構成に AI維持管理者の席の責任者が
//      あればその人)を要する。初回の設定と依存の更新の bot の PR は対象外。場面が実際に止まるかは確かめない
//   3c. 統制の設定の変更の承認(標準 第4章 G-5。process-compass #371 / ADR-0115。--require-control-approval のときだけ): 統制の設定
//      (CONTROL_FILES と閾値・除外設定。追加・削除を含む)を変える PR は、AI維持管理者の席の責任者本人のアカウント(名簿の数値の識別子)
//      による、PR の先頭のコミットへの承認のレビューを要する。本文の記名は承認に数えない。席の責任者が作成者なら、席の責任者以外の
//      名簿の人の承認を要し、その人が名簿にいない体制(1名の体制)では、本人のアカウントの PR の先頭へのレビュー(意見のレビューでよい)を
//      照らして自己申告として受け付けて出す(本文の記名だけでは通さない)。照らす関数は material-attribution.mjs
//      の controlApprovalBacking(出荷の証跡の集約と同じ)
//   4. 既存のテストの変更: 基底にあるテスト(.claude/guard.json の testPatterns)の削除・名前の変更・行の削除を
//      一覧にする。独立レビュー(G-6)の材料であり、合否には使わない。--comment で PR へ出す
//   4b. 機械の検出の一覧(process-compass #360。G-6 の必須の確認事項。合否には使わない): 検証を弱める変更(基底に無い新しいテストの
//      ファイルを含む。追加行の skip・only・todo・落ちることを期待する印、対の無い削除行のアサーション、同じ塊の中の期待値の改めの旧・新。
//      IMPL-0204)、PR 本文の `## 期待値の改め` の根拠の解決、印の注釈 `pit-in: known-failure` の欠け・見直しの時期の超過(IMPL-0488)、
//      製品のコードを変えずに既存のテストを変えた変更(IMPL-0486)、実装計画の対象のパスとの差(既定ブランチの先端の計画。IMPL-0205)。
//      0 件でも検出の限界の文を出す。正本は gate-g5-base のジョブの要約。ただし pytest の strict の無い xfail の付与(印の strict=True も
//      構成の xfail_strict = true も無い、strict=False、pytest.xfail( の呼び出し)は失敗させる(IMPL-0489。予期せず通った場合は試験の失敗)
//   5. リスク区分: PR の本文の「リスク区分」の節に R1 / R2 / R3 のいずれか1つだけが残っていること。変更の種類に
//      依らない(文書・記録だけの PR、Spec: setup の PR、依存の更新の bot の PR を含む)。区分は変更ごとに確定する
//      記録であり(標準 第3章 3.8.1)、出荷判定の証跡の集約が同じ読み方(delegation.mjs の riskClassOf)で欠落にする
//      判定を、マージの前へ移す。区分の妥当性は見ない(下限と確定者は 7 で見る)
//   7. 区分の下限と確定者(標準 第3章 3.8.1「区分の下限と確定者」): 基底ブランチの構成の riskFloor.rules(パスと
//      変更の種類から R1・R2 の下限を導く規則)に当たる変更で、記載された区分が下限より低ければ失敗させる。
//      riskFloor を変える PR の下限は R2 とし、riskFloor と製品のコードを同じ PR で変えたら失敗させる。
//      R1・R2 の区分は、「リスク区分」の節の「確定した者: <氏名>」に、作成を指示した者以外の名簿の人(AI の名義でない)の
//      記名が要る。指示した者以外の人が名簿にいない体制(1名体制など)では失敗させず、確定していない区分として出す
//   7b. 判断記録の要否の規則(標準 第2章 2.6「判断記録の要否の規則」。process-compass #422 / ADR-0101): 基底ブランチの
//      構成の decisionRules.rules(パスと変更の種類から、判断記録を要する変更を導く規則)に当たる変更で、本文の末尾の
//      段落にトレーラ ADR が無い、または指す判断記録が context/decisions/ に無ければ失敗させる(事業ステージ S0 では
//      失敗させず注意として出す。2.6 のステージ表)。申告で外す経路は置かない。規則が無い・規則のパスが追跡中の
//      ファイルに1件も当たらない構成は、未宣言として「長期的な決定を検出できない」と出す。decisionRules を変える
//      PR の下限は R2 とし、decisionRules と製品のコードを同じ PR で変えたら失敗させる。G-3 の判定記録への到達と、
//      判断記録の中身は確かめない
//   6. 停止の申し立て(標準 第7章 7.11): 受信箱のラベル `state:stop-requested` が付いた PR(付けた履歴のある PR を
//      含む)は、基底ブランチに成立した解除の記録(テンプレ4 のゲート欄「停止の申し立ての解除」)が無い限り失敗させる。
//      解除は層1 の項目4 の権限者の記名と理由を要し、AI の名義を受け付けない。見解を退けた解除は上申先と日付を要する。
//      ラベルは PR_LABELS(JSON の配列)、付け外しの履歴は PR_LABEL_EVENTS(JSON)、または --pr の labels / labelEvents。
//      層1 は、層1 を最後に変えた PR の作成者・承認者に層1 の記名者のアカウントがあるときだけ、項目4 を権限者の照合に使う。
//      確かめられない層1 は、層1 が無い場合と同じく事業決裁者の席の責任者と照合し、その旨を出す(#428 / IMPL-0415)
//   6b. D-0 の決定の記名と、前倒しで要る SG の判定記録の帰属(標準 第4章「判定記録を基底ブランチへ入れる操作」。#428 / IMPL-0415):
//      PR が changeLog に足した記録のうち、決定者の記名を要するもの(緩める向き・任免・名簿の変更)は決定者が、事業ステージを
//      前へ戻す記録(sgRecord)は指す SG の判定記録の判定者が、記録を入れる PR の作成者か承認者であること(作成者なら記名者以外の
//      人の承認)を確かめ、満たさなければ失敗させる。承認は後から付くため、承認の後にワークフローを再実行する。
//      PR のコミットの作成者は --pr の commitAuthors、またはホスティング(gh api pulls/<n>/commits)から引く
//   8. G-6 の承認者の数(標準 第8章 軸C 規制業・軸E CL3「独立レビューは2名で実施する」。基底ブランチの構成の
//      review.reviewerCount): PR のレビューを読めるとき(PR_REVIEWS の JSON、または --pr の reviews)、出荷の証跡の集約と
//      同じ条件(人のアカウント、名簿の人、作成を指示した者でない、承認した者自身の挙動要約つき、レビュアごとの最後の
//      状態)で独立した人の承認者を数え、「G-6 の承認者 N 名 / 要求 M 名」を出す。満たなければ警告として出す。
//      **合否にはしない**。pr-rules はレビューの前(push・本文の編集)に走り、承認はその後に付くため、失敗にすると
//      すべての PR が承認まで赤になる。要求を満たさないまま取り込んだ変更は、出荷の証跡の集約が「独立した人の確認を
//      経ていない」に数えて止める。レビューを読めないときは、その旨を出す(黙って通さない)
//   9. 変更要求の本文の形(標準 第4章 G-6「承認レビューを判定記録とする条件」の条件1。#321): レビュアごとの最後の状態が
//      CHANGES_REQUESTED のレビューの本文に、満たさない基準の項目番号(`基準 3`・`基準 2, 5`・`項目 3`)と再提出の期限
//      (`期限 YYYY-MM-DD`)の両方があることを確かめる。宣言行 `G-6: 差し戻し / 基準 3 / 期限 2026-11-05` の形は通る。
//      欠く変更要求を「理由の無い差し戻し」として、レビュアのログイン名と欠けている要素(項目番号 / 期限)を出す。
//      **合否にはしない**。機械が見るのは形だけであり、差し戻し理由の要求は判定者への要求であって PR の合否ではない。
//      承認し直されたレビュア(最後の状態が APPROVED)の変更要求は対象外。AI・bot のアカウントの変更要求は数えない。
//      名簿の人でないログイン名の変更要求も、形だけは検査して出す(独立した人の確認の数には元から入らない)。
//      基準が当該ゲートに実在するか、期限が妥当かは確かめない(内部監査の抜き取り)
//
// 限界(機械で閉じないもの):
//   - 規模はパスで分類する。テスト・fixture・snapshot のパスへ移した製品のコードは、別集計に入る(別集計の側にも、基準行数の
//     TEST_OVER_FACTOR 倍の上限を置いて、無制限の抜け道にしない。それでも、5 倍までは製品のコードを別集計へ置ける)。
//     文書の置き場(docs・specs・context・templates・evidence・profiles)に置いたコードの拡張子のファイルは製品として数えるが、
//     拡張子のないスクリプトや、強制層・構成のパス(.claude・.github・scripts/gate など)へ置いたコードは数えない
//   - 規模の確認は、欄の有無・実施者の名義・読み切れたかの答えだけを確かめる。理由が1語や定型文でも通る。333 行の変更を 3 つの
//     PR に分けても、検出しない(改訂前も同じ)。実施者が実際に読んだか、保証の所在の内容が正しいかは確かめない
//   - 担保水準 L1・L2 の宣言は、根拠のパスの実在と見直し日だけを確かめる。根拠の中身(条件の充足)は確かめない
//   - 生成物・機械的な変換のうち、上の印で識別できないものは算定に入る。例外承認か、先に印を基底へ入れる
//   - package.json のように依存と設定を兼ねるファイルの中の閾値は、閾値のファイルとして扱わない。python のアダプタは、
//     pyproject.toml・setup.cfg・tox.ini の中の閾値・除外設定の表を「ファイル#表」の形で thresholdFiles に持ち、表の中身だけを比べる
//     (#363)。表の見出しの外に書いた点つきの鍵と、[tool] の中の表の値は読まない
//   - 例外承認の権限を持つ者か、作成を指示した者の全員と別の人かは確かめない(出荷判定の証跡の集約が確かめる)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  fail,
  warn,
  notice,
  matchGlob,
  parseLedger,
  ACTIVE_EXCEPTION_STATES,
  isFilledValue,
  dueDayOf,
  resolveSigner,
  findPersonByAccount,
  identifyAccount,
  findPerson,
  accountKey,
  identifyWhy,
  dedicatedSeatOf,
  sharingOf,
  sharingText,
  accountRefOf,
  numericAccountId,
  aiNameBlocked,
  canonicalJson,
  hasBehaviorSummary,
  behaviorSummaryShortfall,
  behaviorSummaryKey,
  reviewersRequiredOf,
  touchesCore,
  assuranceOf,
  sizeLimitsOf,
  corePathsOf,
  trackedFiles,
  unmatchedCoreText,
  DEFAULT_MAX_CHANGED_LINES,
  DEFAULT_MAX_CHANGED_FILES,
  personKey,
  RULE_APPROVER_SEAT,
  hasWriteAssociation,
  directionLabel,
  unquoteGitPath,
} from './config.mjs';
import { riskClassOf } from './delegation.mjs';
import { readPolicy, parseStopRelease, STOP_LABEL, POLICY_FILE } from './org-assurance.mjs';
import { stageOf, readPlanTargets } from './verification-trace.mjs';
import {
  exceptionReviewBacking,
  stopReviewCandidates,
  stopReleaseTextOfReview,
  introducedBacking,
  lastCommitOfRow,
  lastCommitOfFile,
  ghHosting,
  fixedHosting,
  policyAttribution,
  withPolicyAttribution,
  policyUnattributedText,
  pullInfoOf,
  decisionNeedsAttribution,
  signatureIndexOf,
  commitOfChangeLogEntry,
  sgRecordPath,
  idMigrationRoster,
  controlApprovalBacking,
} from './material-attribution.mjs';
import { judgeOfForm } from './records.mjs';

/** 製品のコードでないもの。文書・記録・成果物・強制層・構成。変更規模の算定と、同時変更の判定から除く */
export const NON_PRODUCT = [
  '*.md',
  'docs/**',
  'specs/**',
  'context/**',
  'templates/**',
  'evidence/**',
  'profiles/**',
  '.claude/**',
  '.github/**',
  'scripts/gate/**',
  'scripts/init/**',
  'scripts/vendor/**',
  'adapters/**',
  'process.config.json',
  'PROCESS-PROFILE.md',
  'CODEOWNERS',
  'LICENSE',
  'LICENSE-docs',
  '.gitignore',
  '.gitattributes',
  // 外部ツール(MCP サーバー)の一覧(標準 第3章 3.11.6。#358)。製品のコードでなく、統制の設定(CONTROL_FILES)として承認を要する
  '.mcp.json',
];

/**
 * テスト・fixture・snapshot の置き場の既定(規模の算定では別に数え、基準値の判定に入れない。#295)。
 * 構成 task.nonProductPaths で足せる。task は閾値として扱うため、足す変更は製品のコードと同じ PR にできない
 */
export const TEST_PATTERNS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/fixtures/**', '**/__snapshots__/**', '**/*.snap'];

/** ロックファイル(算定から除く)。ファイル名で判定する */
export const LOCK_FILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'go.sum',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
];

/**
 * 閾値・除外設定のファイル(第4章 G-5「基準値と除外設定の変更」)。アダプタの thresholdFiles を足す。構成(process.config.json の
 * ci・task・guard)とアダプタの定義は、ファイルの種類によらず閾値として扱う(下の thresholdChanges)
 */
export const THRESHOLD_FILES = [
  '.gitattributes',
  'codecov.yml',
  '.codecov.yml',
  'sonar-project.properties',
  '.gitleaks.toml',
  '.gitleaksignore',
  '.trivyignore',
  '.semgrepignore',
  '.secretlintrc*',
  '.secretlintignore',
  // 製品のスタックの除外の一覧(標準 第4章 G-5「製品のすべてのスタック」。process-compass #363 / ADR-0121)。除外は検査の対象を縮める
  // 変更であり、閾値・除外設定と同じく、製品のコードと同じ PR で変えない。変更は統制の設定の変更の承認を要する。
  // 基底に無い一覧を新しく置く変更も、基底の構成が設定済みなら初回の設定として外さない(下の STACK_EXCLUSIONS)
  '.github/stack-exclusions.json',
];
/** 製品のスタックの除外の一覧。基底の構成が設定済みなら、新しく置く変更も閾値・除外設定の変更に数える(除外の追加は緩める向きのため) */
export const STACK_EXCLUSIONS = '.github/stack-exclusions.json';

/**
 * 開発の基盤(設定・ツール・雛形)のファイル。変更がこれだけに収まる PR は、トレーラ `Spec: setup` で通す(#286)。
 * 初期化の直後に、テストの実行・カバレッジ・秘匿情報の検査の設定を足す変更は、まだ仕様もタスクも持たないためである。
 * 製品のコード(このほかのファイル)を1つでも含めば、通常どおり `Spec: F-NNN / Task-N` を要する。
 * スラッシュを含まないパターンは、どの階層のファイル名にも当てる。依存と設定を兼ねるファイルは中身を見ない
 */
export const SETUP_FILES = [
  'package.json',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  'tsconfig*.json',
  'jsconfig.json',
  '.editorconfig',
  '.prettierrc*',
  '.prettierignore',
  'pyproject.toml',
  'requirements*.txt',
  'setup.cfg',
  'Pipfile',
  '.python-version',
  'go.mod',
  '.tool-versions',
  '.ignore',
  '.gitkeep',
];
const SETUP_TRAILER = /^Spec:\s*setup\s*$/i;

const GENERATED_MARK = /@generated\b|Code generated .*DO NOT EDIT/;
const SPEC_LINE = /^Spec:\s*(F-\d+)\s*\/\s*(Task-\d+)\s*$/;
const TRAILER_LINE = /^[A-Za-z][\w-]*:\s*\S/;
const DEPENDENCY_BOTS = ['dependabot[bot]', 'renovate[bot]'];
const ASSERTION = /\b(expect|assert\w*|should|toBe|toEqual|toMatch\w*|toStrictEqual|toHaveBeenCalled\w*|Equal|Equals|require\.\w+|t\.(Error|Fatal)\w*)\b/;

function gitIn(root) {
  return (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
}

const basename = (f) => f.split('/').pop();
/** スラッシュを含まないパターンは、どの階層のファイル名にも当てる */
const matchAny = (globs, f) => globs.some((g) => (g.includes('/') ? matchGlob(g, f) : matchGlob(g, basename(f))));
/**
 * 文書・記録の置き場(NON_PRODUCT のうち、コードを置く場所ではないもの)。ここに置いたファイルは、文書・データの拡張子
 * (DOC_DATA_EXTENSIONS)のものを除き、製品のコードとして数える(process-compass #296)。拡張子の無いファイルは、先頭の行が
 * shebang(#!)なら製品のコードとして数える。中身を読めないときは、製品のコードとして数える(数え漏らす側へ倒さない)。
 * 強制層・構成(.claude・.github・scripts/gate・scripts/init・scripts/vendor・adapters)は、設計上スクリプトを置くため含めない
 */
export const DOC_ONLY_DIRS = ['docs/**', 'specs/**', 'context/**', 'templates/**', 'evidence/**', 'profiles/**'];
/** 文書・データ・画像の拡張子。文書の置き場で、これ以外の拡張子のファイルは製品のコードとして数える */
export const DOC_DATA_EXTENSIONS =
  /\.(md|mdx|markdown|txt|text|rst|adoc|asciidoc|org|tex|json|jsonc|json5|ya?ml|toml|csv|tsv|xml|html?|css|svg|png|jpe?g|gif|webp|bmp|ico|pdf|drawio|puml|plantuml|mmd|dot|ini|cfg|conf|properties|log|lock|diff|patch|bib|odt|docx?|xlsx?|pptx?|key|numbers|pages|eps|ai|psd|mp4|mov|webm|mp3|wav|zip|gz|tgz)$/i;
/** 文書の置き場に置く、拡張子の無い文書の名前 */
const DOC_NAMES = /(^|\/)(LICENSE([-.][\w.-]+)?|NOTICE|CODEOWNERS|AUTHORS|CONTRIBUTORS|CHANGELOG|README|COPYING|\.gitkeep|\.keep|\.gitignore|\.gitattributes)$/;
/** @deprecated 文書の置き場の判定は DOC_DATA_EXTENSIONS の否定へ反転した(#296)。他のスクリプトからの参照のために残す */
export const CODE_EXTENSIONS = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|sh|ps1|sql|lua|dart|ex|exs|vue|svelte)$/i;
/** 規模の別集計(テスト・fixture・snapshot)が基準行数のこの倍を超えたら、別集計の側も size:over とする */
export const TEST_OVER_FACTOR = 5;
const hasExtension = (f) => /\.[^./]+$/.test(f.split('/').pop().replace(/^\./, ''));
/**
 * 文書の置き場に置いたファイルが製品のコードか。文書・データの拡張子なら文書。拡張子が無ければ、先頭の行の shebang で判定する。
 * head は (path) => 先頭の文字列 | null。渡さない、または読めないときは製品のコードとして数える
 */
export function docDirFileIsCode(f, head = null) {
  if (DOC_NAMES.test(f)) return false;
  if (hasExtension(f)) return !DOC_DATA_EXTENSIONS.test(f);
  const text = typeof head === 'function' ? head(f) : null;
  if (text === null || text === undefined) return true;
  return /^#!/.test(String(text));
}
/** 文書・記録・強制層か。*.md はどの階層でも文書として扱う。文書の置き場でも、文書・データの拡張子以外のファイルは製品として数える */
export const isNonProduct = (f, head = null) => {
  if (DOC_ONLY_DIRS.some((g) => matchGlob(g, f)) && !/\.md$/i.test(f) && docDirFileIsCode(f, head)) return false;
  return NON_PRODUCT.some((g) => (g === '*.md' ? /\.md$/i.test(f) : matchGlob(g, f)));
};
/**
 * 変更規模の算定から除くか(標準 第4章「タスクの分割基準」。ADR-0072)。除くのは、文書の置き場(DOC_ONLY_DIRS)と
 * リポジトリの直下にある散文(*.md)と、強制層・構成のファイル。置き場の外(src/ など製品のディレクトリ)に置いた *.md は数える。
 * 製品のディレクトリへ *.md を置いて、算定と区分の下限 R2 から外す経路を塞ぐ(#289 D-10)。同時変更の判定(isNonProduct)は変えない
 */
export const isExcludedFromSize = (f, head = null) => {
  if (!isNonProduct(f, head)) return false;
  if (!/\.md$/i.test(f)) return true;
  if (!f.includes('/')) return true;
  if (DOC_ONLY_DIRS.some((g) => matchGlob(g, f))) return true;
  // 強制層・構成の置き場(.claude・.github・scripts/gate ほか)の *.md は、強制層の一部として除く
  return NON_PRODUCT.some((g) => g !== '*.md' && matchGlob(g, f));
};
/**
 * 統制の設定のファイル(標準 第4章 G-5「統制の設定の陰性の確認」。ADR-0073)。閾値・除外設定(thresholdGlobs と構成の ci・task・guard)に加え、
 * ルールセット・フック・権限・ワークフロー・コード所有者の設定。これを変える PR は、本文に陰性の確認の記録を要する
 */
export const CONTROL_FILES = [
  '.claude/settings.json', '.claude/guard.json', '.claude/hooks/**', '.github/workflows/**', '.github/rulesets/**', 'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS',
  // 検査装置(標準 第1章 1.4): 検査のスクリプト、知識ベースの複製、スタック別の検査の定義。検査のスクリプトを `process.exit(0)` に
  // 替える PR が、誤りも注意も出さずに通っていた(process-compass #290 / ADR-0074)
  'scripts/gate/**', 'scripts/vendor/**', 'adapters/**',
  // 判定のコードの読み込み先(標準 第4章 G-5「判定のコードの読み元」)。ワークフローが使う手元の action と、検査の道具を動かす
  // Node の版。書き換えれば判定のコードを替えられる(process-compass #371 / ADR-0115)
  '.github/actions/**', '.github/gate-node-version',
  // AI レビューの指示の置き場(標準 第5章 5.8.6 の要求事項7)。ai-review.yml は既定ブランチの版から読むため、その PR 自身のレビューは
  // 変えられない。それでも、指示を弱める PR を先に取り込み、次の PR をその指示でレビューさせる2段の経路が残る(process-compass #369)
  '.github/ai-review/**',
  // 案件の範囲の外部ツール(MCP サーバー)の一覧(標準 第3章 3.11.6 要求事項1・5。process-compass #358 / IMPL-0228・IMPL-0229)。
  // 一覧に足すサーバーは、エージェントに道具と権限を足す。追加と変更は AI維持管理者の承認を要する
  '.mcp.json',
];

/**
 * エージェント指示資産(誘導層・再利用層)。変更に AI維持管理者本人の承認を要する(標準 第3章 3.11.5。process-compass #358 / IMPL-0227)。
 * 統制の設定(CONTROL_FILES)と違い、陰性の確認(3b)を課さない。誘導層は止める仕組みではなく、陰性の確認の対象にならないため
 */
export const INSTRUCTION_ASSET_FILES = ['CLAUDE.md', 'AGENTS.md', '**/CLAUDE.md', '**/AGENTS.md', '.claude/skills/**', '.claude/rules/**', '.claude/agents/**', '.claude/commands/**'];
/** 個人の作業環境に固有の指示(版管理から除外する。標準 第3章 3.11.5。IMPL-0504) */
export const PERSONAL_INSTRUCTION_FILES = ['CLAUDE.local.md', '**/CLAUDE.local.md', '.claude/settings.local.json', '**/.claude/settings.local.json'];

// ---------------------------------------------------------------- 依存と設定を兼ねるファイルの中の閾値(process-compass #363)
//
// アダプタの thresholdFiles の「ファイル#表」の形(例: pyproject.toml#tool.ruff、setup.cfg#coverage)は、そのファイルの中の
// 表(TOML の [tool.ruff] とその下位の表 [tool.ruff.lint] など、INI の [coverage:run] のような節)だけを閾値・除外設定として比べる。
// ファイルの全体を閾値にすると、依存の更新まで閾値の変更として止めるためである。
// 限界: 表の見出しの外に書いた点つきの鍵(最上位の tool.ruff.line-length = …)と、[tool] の中の表の値(ruff = { … })は読まない

/** thresholdFiles を、ファイルの glob と「ファイル#表」に分ける */
export function splitThresholdGlobs(globs) {
  const plain = [];
  const keyed = [];
  for (const g of globs ?? []) {
    if (typeof g !== 'string' || !g) continue;
    const i = g.indexOf('#');
    if (i > 0 && i < g.length - 1) keyed.push({ file: g.slice(0, i), table: g.slice(i + 1) });
    else plain.push(g);
  }
  return { plain, keyed };
}

/** 表の見出しの名(TOML の [a.b]・[[a.b]]、INI の [a:b])。見出しでない行は null */
function tableHeader(line) {
  const m = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:[#;].*)?$/.exec(line);
  return m ? m[1].replace(/\s*\.\s*/g, '.').replace(/["']/g, '') : null;
}

/**
 * TOML の1行から、文字列の外の行末の注記(# 以降)を除く。複数行の文字列(""" と ''')の中は注記として扱わない。
 * state は { ml: null | '"""' | "'''" }。行をまたいで持ち越す(process-compass #363 の突合 X-6)
 */
export function stripTomlComment(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.ml) {
      const end = line.indexOf(state.ml, i);
      if (end < 0) return out + line.slice(i);
      out += line.slice(i, end + 3);
      i = end + 3;
      state.ml = null;
      continue;
    }
    const c = line[i];
    if (c === '#') return out;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.ml = line.slice(i, i + 3);
      out += state.ml;
      i += 3;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += c === '"' && line[j] === '\\' ? 2 : 1;
      out += line.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * TOML・INI の本文のうち、表 table とその下位の表(名が table に . : - で続くもの)の中身。比べるための正規の文字列を返す
 * (空行と行の全体の注記を除き、前後の空白を除く。toml が真なら、文字列の外の行末の注記も除く)。該当する表が無ければ ''
 */
export function tableSection(text, table, { toml = false } = {}) {
  if (text === null || text === undefined) return '';
  const out = [];
  let current = null;
  const state = { ml: null };
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const inString = Boolean(state.ml);
    const line = toml ? stripTomlComment(raw, state) : raw;
    const h = inString ? null : tableHeader(line);
    if (h !== null) {
      current = h === table || (h.startsWith(table) && /^[.:-]/.test(h.slice(table.length))) ? h : null;
      if (current) out.push(`[${current}]`);
      continue;
    }
    if (!current) continue;
    const t = inString ? line : line.trim();
    if (!t.trim() || (!inString && /^[#;]/.test(t))) continue;
    out.push(inString ? t : t.replace(/\s+$/, ''));
  }
  return out.join('\n');
}

/**
 * 変更したファイルのうち、「ファイル#表」の表の中身が変わったもの。{ changed: [表示], initial: [表示], files: Set(パス) }
 *   files: 「ファイル#表」のファイルに当たるパス(同時変更の検査で製品のコードに数えない)
 *   before(path)・after(path): 変更の前・後の本文(無ければ null)
 */
export function keyedThresholdChanges(entries, keyed, before, after) {
  const changed = [];
  const initial = [];
  const files = new Set();
  if (!keyed.length) return { changed, initial, files };
  for (const e of entries ?? []) {
    const f = e?.path;
    if (!f) continue;
    const hits = keyed.filter((k) => matchAny([k.file], f));
    if (!hits.length) continue;
    files.add(f);
    const b = before(e.from ?? f);
    const a = after(f);
    for (const { table } of hits) {
      const toml = /.toml$/i.test(f);
      const sb = tableSection(b, table, { toml });
      const sa = tableSection(a, table, { toml });
      if (sb === sa) continue;
      // 「初回の設定」は、ファイルそのものが基底に無い場合に限る。基底に在るファイルへ表を新しく足す変更は、除外の追加に
      // 近い緩める向きの変更として、閾値の変更に数える(process-compass #363 の突合 X-2)
      if (b === null) initial.push(`${f}([${table}]。ファイルが基底に無い)`);
      else changed.push(`${f}([${table}])${sb ? '' : '(表を新しく足した)'}`);
    }
  }
  return { changed, initial, files };
}

/**
 * 統制の設定を変える変更の承認で数える、変更したファイル(標準 第4章 G-5「統制の設定の変更の承認」。process-compass #371 / ADR-0115)。
 * CONTROL_FILES と閾値・除外設定(thresholdGlobs)に当たる変更したファイル(名前の変更の元を含む)。陰性の確認(3b)と違い、
 * 基底に無いファイルの追加(新しいワークフローの追加を含む)と削除も数える。同じ名前のジョブを足すワークフローの追加が、
 * 統制の設定の変更に当たるためである。files は { path, from } の配列
 */
export function controlTouchedOf(files, thresholdGlobs = THRESHOLD_FILES) {
  const out = new Set();
  for (const e of files ?? []) {
    // 指示資産(INSTRUCTION_ASSET_FILES)も承認の範囲に数える(陰性の確認は課さない。#358 / IMPL-0227)
    for (const f of [e?.path, e?.from].filter(Boolean)) if (matchAny(CONTROL_FILES, f) || matchAny(thresholdGlobs, f) || matchAny(INSTRUCTION_ASSET_FILES, f)) out.add(f);
  }
  return [...out];
}

/**
 * 2つの版の間で統制の設定を変えたファイル(PR の時点の判定 3c と出荷の証跡の集約が同じ範囲で数える。process-compass #371 突合 C-4)。
 * 名前の変更の元(-M)、変更の前の版のアダプタの thresholdFiles、process.config.json の閾値の鍵(ci・task・guard)の変更を含む。
 * git は (args) => 文字列 | null。parent は変更の前の版(PR では基底との分岐点、集約ではマージのコミットの第1親)
 */
/**
 * 承認を要する統制の設定に数える構成の鍵。閾値・除外設定(ci・task・guard)に加え、AI レビューの有効化とフォークの扱い(aiReview)。
 * aiReview を切る・フォークを許す変更も、指示を弱める変更と同じく、先に取り込んで後の PR のレビューを変える経路になる
 * (process-compass #369 の突合 F-9)。閾値の同時変更の検査(製品のコードと同じ PR で変えない)には aiReview を入れない
 */
export const CONTROL_CONFIG_KEYS = ['ci', 'task', 'guard', 'aiReview'];
export function controlTouchedBetween(git, parent, commit) {
  const json = (t) => {
    try {
      return t ? JSON.parse(t) : null;
    } catch {
      return null;
    }
  };
  const entries = parseNumstatZ(git(['diff', '--numstat', '-z', '-M', parent, commit]));
  const pc = json(git(['show', `${parent}:process.config.json`]));
  const hc = json(git(['show', `${commit}:process.config.json`]));
  const stack = pc?.adapters?.stack ?? hc?.adapters?.stack ?? null;
  const adapter = stack ? json(git(['show', `${parent}:adapters/${stack}.json`])) : null;
  const { plain, keyed } = splitThresholdGlobs(Array.isArray(adapter?.thresholdFiles) ? adapter.thresholdFiles : []);
  const globs = [...THRESHOLD_FILES, ...plain];
  const touched = controlTouchedOf(entries, globs).filter((f) => {
    // 指示資産の承認(#358 / IMPL-0227)は、変更の前の版の判定のコードがこの規則を持つ変更にだけ数える。規則の前に入った指示資産の
    // 変更を、出荷の集約が遡って承認の欠けにしないため(統制の設定の承認の境 beforeRule と同じ考え方)
    if (matchAny(CONTROL_FILES, f) || matchAny(globs, f) || !matchAny(INSTRUCTION_ASSET_FILES, f)) return true;
    return /INSTRUCTION_ASSET_FILES/.test(git(['show', `${parent}:scripts/gate/check-pr.mjs`]) ?? '');
  });
  // 依存と設定を兼ねるファイルの中の閾値の表(#363)。表の中身が変わったファイルだけを数える
  const kc = keyedThresholdChanges(entries, keyed, (f) => git(['show', `${parent}:${f}`]), (f) => git(['show', `${commit}:${f}`]));
  for (const label of [...kc.changed, ...kc.initial]) {
    const f = label.slice(0, label.indexOf('('));
    if (!touched.includes(f)) touched.push(f);
  }
  if (entries.some((e) => e.path === 'process.config.json' || e.from === 'process.config.json') && pc && pc.configured !== false && CONTROL_CONFIG_KEYS.some((k) => canonicalJson(pc[k] ?? null) !== canonicalJson(hc?.[k] ?? null))) touched.push('process.config.json');
  return touched;
}
/**
 * 「統制の設定の陰性の確認」の節。通した違反の場面・結果(止まった / 止まらなかった / 外した)・確かめた者。節が無ければ present: false。
 * 結果が「外した」(検査を意図して外す変更。標準 第4章 G-5「検査を外す変更の記録」。#290 / ADR-0074)のときは、外した検査・
 * 止めていた場面・外した後に止めるもの(または止めないと決めた理由)・受け入れた者を読む。HTML コメントの中の節・欄は読まない
 */
export function negativeCheckOf(body) {
  const parts = String(body ?? '').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split(/^##\s*統制の設定の陰性の確認.*$/m);
  if (parts.length < 2) return { present: false };
  const section = parts[1].split(/^(?:##\s|---\s*$)/m)[0];
  const field = (label) => {
    const m = section.match(new RegExp(`^[ \\t]*[-*]?[ \\t]*${label}[ \\t]*[::][ \\t]*(.*?)[ \\t]*$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const t = String(field('結果') ?? '').normalize('NFKC').trim();
  return {
    present: true,
    scene: field('通した違反の場面'),
    result: /^止まった$/.test(t) ? 'stopped' : /^止まらなかった$/.test(t) ? 'not-stopped' : /^外した$/.test(t) ? 'removed' : null,
    checker: field('確かめた者'),
    removed: field('外した検査'),
    removedScene: field('止めていた場面'),
    afterRemoval: field('外した後に止めるもの'),
    acceptedBy: field('受け入れた者'),
  };
}
/** 陰性の確認の不備を理由の配列で返す */
export function negativeCheckProblems(nc, { config }) {
  if (!nc.present) return ['PR の本文に「## 統制の設定の陰性の確認」の節がありません(本文は .github/PULL_REQUEST_TEMPLATE.md から作る)'];
  const p = [];
  if (nc.result === 'removed') return removalProblems(nc, { config });
  if (!isFilledValue(nc.scene)) p.push('通した違反の場面が未記入');
  if (nc.result === 'not-stopped') p.push('結果が「止まらなかった」である(変更した統制の設定が、違反を止めていない。設定を直してから確かめ直す。検査を意図して外す変更なら、結果を「外した」にして外した検査の欄を書く)');
  else if (nc.result === null) p.push('結果が「止まった」「止まらなかった」「外した」のいずれでもない(1つだけ残す)');
  if (!isFilledValue(nc.checker)) p.push('確かめた者が未記入');
  else if (aiNameBlocked(config, nc.checker)) p.push(`確かめた者 "${nc.checker}" が AI の名義である(確かめるのは人)`);
  return p;
}
/**
 * 結果「外した」の記録の不備(標準 第4章 G-5「検査を外す変更の記録」、第3章 3.11.4 要求事項3)。4 欄の記入と、受け入れた者が
 * AI の名義でないこと、構成に AI維持管理者の席の責任者があればその人であることを確かめる。G-5 の判定基準を実装する検査を
 * 集約から外す変更は、この記録があっても契約検査が落とす(外せるのは第8章の調整だけ)
 */
export function removalProblems(nc, { config }) {
  const p = [];
  if (!isFilledValue(nc.removed)) p.push('外した検査が未記入');
  if (!isFilledValue(nc.removedScene)) p.push('止めていた場面(外した検査が止めていた違反の場面)が未記入');
  if (!isFilledValue(nc.afterRemoval)) p.push('外した後に止めるもの(止める検査、または止めないと決めた理由)が未記入');
  if (!isFilledValue(nc.acceptedBy)) p.push('受け入れた者(AI維持管理者の席の責任者)が未記入');
  else if (aiNameBlocked(config, nc.acceptedBy)) p.push(`受け入れた者 "${nc.acceptedBy}" が AI の名義である(外す判断を AI に行わせない。標準 第3章 3.11.4)`);
  else {
    const maintainer = (config?.seats ?? []).find((s) => s.role === RULE_APPROVER_SEAT)?.accountable;
    if (maintainer && personKey(config, maintainer) !== personKey(config, nc.acceptedBy)) {
      p.push(`受け入れた者 "${nc.acceptedBy}" は、AI維持管理者の席の責任者(${maintainer})ではない(強制層の検査の削除・統合は AI維持管理者が承認する。標準 第3章 3.11.2)`);
    }
  }
  return p;
}
export const isLock = (f) => LOCK_FILES.includes(basename(f));
export const isSetupFile = (f) => matchAny(SETUP_FILES, f);
/** 製品のコードか(文書・記録・強制層・閾値の設定・ロックファイル・基盤のファイル以外)。thresholdGlobs はアダプタの分を足したもの */
export const isProductCode = (f, thresholdGlobs = THRESHOLD_FILES, head = null) => !isNonProduct(f, head) && !matchAny(thresholdGlobs, f) && !isLock(f) && !isSetupFile(f);

/** .gitattributes の本文から、linguist-generated の対象のパターンを読む */
export function generatedPatterns(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    if (attrs.some((a) => a === 'linguist-generated' || a === 'linguist-generated=true')) out.push(pattern);
  }
  return out;
}

/** gitattributes のパターンにパスが当たるか。スラッシュを含まないパターンは、どの階層のファイル名にも当たる */
export function attrMatch(pattern, file) {
  let p = pattern.replace(/^\//, '');
  if (p.endsWith('/')) p += '**';
  if (!p.includes('/')) return matchGlob(p, basename(file));
  return matchGlob(p, file);
}

/** git diff --numstat -z の出力を読む。名前の変更は { from, path } を持つ。バイナリは lines: null */
export function parseNumstatZ(text) {
  const tok = String(text ?? '').split('\0');
  const out = [];
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t);
    if (!m) continue;
    const lines = m[1] === '-' ? null : Number(m[1]) + Number(m[2]);
    const removed = m[2] === '-' ? 0 : Number(m[2]);
    const added = m[1] === '-' ? 0 : Number(m[1]);
    if (m[3] === '') {
      out.push({ from: tok[i + 1], path: tok[i + 2], lines, removed, added });
      i += 2;
    } else out.push({ from: null, path: m[3], lines, removed, added });
  }
  return out;
}

/** 本文の末尾の段落(スカッシュのメッセージでトレーラとして読まれる段落)を返す */
export function lastParagraph(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  const paras = text.split(/\n[ \t]*\n/);
  return paras[paras.length - 1].trim();
}

/** トレーラ Spec の検査。違反の理由の配列と、見つかった Spec の配列を返す */
export function specFindings(pr, { exists }) {
  const problems = [];
  const body = String(pr.body ?? '').replace(/\r\n/g, '\n');
  const anywhere = body.split('\n').map((l) => l.trim()).filter((l) => /^Spec:/.test(l));
  const last = lastParagraph(body);
  const lastLines = last.split('\n').map((l) => l.trim()).filter(Boolean);
  const specs = lastLines.map((l) => SPEC_LINE.exec(l)).filter(Boolean).map((m) => ({ feature: m[1], task: m[2] }));
  if (!specs.length) {
    if (anywhere.some((l) => SPEC_LINE.test(l))) {
      problems.push('トレーラ Spec が本文の末尾の段落にありません。スカッシュのメッセージでは、末尾の段落のトレーラだけが読まれます(PR の様式の「トレーラ」の節へ置く)');
    } else if (anywhere.length) {
      problems.push(`トレーラ Spec の形式が違います(${anywhere[0]})。\`Spec: F-NNN / Task-N\` で書く`);
    } else {
      problems.push('トレーラ `Spec: F-NNN / Task-N` が PR の本文にありません。製品のコードを変える PR は、対応する仕様とタスクを指す');
    }
    return { problems, specs };
  }
  const notTrailer = lastLines.filter((l) => !TRAILER_LINE.test(l));
  if (notTrailer.length) {
    problems.push(`本文の末尾の段落に、トレーラでない行があります(${notTrailer[0].slice(0, 60)})。末尾の段落はトレーラの行だけにする`);
  }
  for (const s of specs) {
    const spec = `specs/${s.feature}/spec.md`;
    const plan = `specs/${s.feature}/plan.md`;
    if (!exists(spec)) {
      problems.push(`Spec: ${s.feature} / ${s.task} が指す仕様 ${spec} がありません`);
      continue;
    }
    const planText = exists(plan);
    if (!planText) problems.push(`Spec: ${s.feature} / ${s.task} が指す実装計画 ${plan} がありません`);
    else if (!new RegExp(`^\\|\\s*${s.task}\\s*\\|`, 'm').test(planText)) problems.push(`Spec: ${s.feature} / ${s.task} のタスクが、実装計画 ${plan} の表にありません`);
  }
  return { problems, specs };
}

/**
 * この PR を対象とする有効な例外承認の行を探す(出荷判定の証跡の集約と同じ条件のうち、PR の時点で確かめられるもの)。
 * 作成を指示した者の全員との照合は、出荷判定の証跡の集約が行う。
 *
 * 行の帰属(標準 第4章「判定記録を基底ブランチへ入れる操作」。process-compass #380 / ADR-0106 / IMPL-0413・IMPL-0414):
 * 名前の一致だけでは数えない。(A) 対象の PR の上の、承認した者本人のレビュー(宣言行 `例外承認: <行の ID>`)か、
 * (B) 基底ブランチの行は、行を入れた PR の作成者・承認者に承認した者本人のアカウントがあること(material-attribution.mjs)。
 * (A) で裏づけた行は、PR の先頭の台帳(headLedgerText)にある行でもよい。ctx を渡さない呼び出しは帰属を確かめられず、行を数えない
 */
export function exceptionFor(ledgerText, prNumber, config, prAuthor, ctx = {}) {
  const matched = [];
  const rejected = [];
  const backing = {};
  const { git = null, policyRef = null, reviews = null, head = null, headLedgerText = null, hosting = null, instructorIds = [], instructorUnresolved = [] } = ctx;
  if (!ledgerText && !headLedgerText) return { matched, rejected, backing, reason: '基底ブランチに技術負債台帳(docs/debt-ledger.md)がありません' };
  if (!prNumber) return { matched, rejected, backing, reason: 'PR の番号が分からないため、例外承認の行と対応づけられません' };
  const refers = (text) => new RegExp(`PR\\s*#\\s*${prNumber}(?!\\d)`).test(String(text ?? ''));
  // PR の作成者はホスティングの記録。数値の識別子で名簿の人へ対応づける(process-compass #430)
  const author = prAuthor ? identifyAccount(config, authorRef(prAuthor)).person : null;
  const baseRows = ledgerText ? parseLedger(ledgerText) : [];
  const baseIds = new Set(baseRows.map((r) => r.id));
  // PR の中で足した行(基底に無い ID)は、(A) のレビューで裏づけたときだけ数える
  const headOnly = headLedgerText ? parseLedger(headLedgerText).filter((r) => !baseIds.has(r.id)).map((r) => ({ ...r, inHead: true })) : [];
  for (const r of [...baseRows, ...headOnly]) {
    if (r.kind !== '例外') continue;
    if (r.target === null) {
      if (refers(r.text)) rejected.push(`${r.id}: 台帳に「対象」の欄が無い(旧い様式)`);
      continue;
    }
    if (!refers(r.target)) continue;
    const why = [];
    if (!ACTIVE_EXCEPTION_STATES.includes(r.state.replace(/\*/g, '').normalize('NFKC').trim())) why.push(`状態が有効を示す値でない(${r.state || '未記入'})`);
    if (!isFilledValue(r.approver)) why.push('承認した者が未記入');
    else {
      if (aiNameBlocked(config, r.approver)) why.push('承認した者が AI の名義である');
      const p = resolveSigner(config, r.approver);
      if (!p) why.push(`承認した者 "${r.approver}" が人の名簿の人へ対応づかない`);
      else if (author && author.id === p.id) why.push('承認した者が PR の作成者である');
    }
    if (!isFilledValue(r.content) || (r.reason !== null && !isFilledValue(r.reason))) why.push('理由(内容・受容した理由)が未記入');
    if (!isFilledValue(r.due) || !dueDayOf(r.due)) why.push('期限(返却の目安)が未記入、または日付として解釈できない');
    // 名簿に対応づかない指示者がいると、承認した者が指示した者と別の人かを確かめられない(出荷の集約と揃える。#429)
    if (instructorUnresolved.length) why.push(`作成を指示した者 ${instructorUnresolved.join(' / ')} を名簿と対応づけられない`);
    if (!why.length) {
      // 帰属の裏づけ。(A) 承認した者本人のレビュー → (B) 行を入れた PR(基底ブランチの行だけ)
      const signer = resolveSigner(config, r.approver);
      const a = exceptionReviewBacking(config, r, signer, { reviews, author: prAuthor, head, instructorIds });
      if (a.backed) backing[r.id] = `対象の PR の上の承認した者本人のレビュー(@${a.review.login}、${a.review.submittedAt ?? '提出日時なし'})${a.note ? `。${a.note}` : ''}`;
      else if (r.inHead) why.push(`PR の中で足した行で、承認した者本人のレビューが無い(${a.why.join(' / ')})`);
      else {
        const sha = git && policyRef ? lastCommitOfRow(git, policyRef, 'docs/debt-ledger.md', r.id) : null;
        const b = introducedBacking(config, signer, sha && hosting ? hosting.prOfCommit(sha) : null, { what: '台帳の行' });
        if (b.backed) backing[r.id] = b.note;
        else why.push(`帰属を確かめられない(名前の一致だけでは数えない): ${b.why}。対象の PR の上で、承認した者本人が宣言行「例外承認: ${r.id}」のレビューを出す`);
      }
    }
    if (why.length) rejected.push(`${r.id}: ${why.join('、')}`);
    else matched.push(r.id);
  }
  return { matched, rejected, backing, reason: null };
}

/**
 * 停止の申し立て(標準 第7章 7.11)。受信箱のラベル `state:stop-requested` が付いた PR、または付けた履歴のある PR を、
 * 基底ブランチに成立した解除の記録が無い限り失敗させる(マージを保留する)。
 *
 * 解除の記録は、ゲート判定記録の様式(テンプレ4)で、ゲート欄が「停止の申し立ての解除」、対象が `PR #<番号>` のもの。
 * 基底ブランチ(base の先端)の docs/gates/ だけを読む。保留した PR の中で足した記録は数えない(例外承認と同じ)。
 * 解除する者は、基底ブランチの層1(docs/quality-assurance-policy.md)の項目4「停止の申し立ての解除」の受容者の席の
 * 責任者。層1 が無い、または行が空欄なら、事業決裁者の席の責任者と照合する(出力にその旨を出す)。AI の名義を受け付けない。
 * 申し立てた者の見解を退けた解除は、上申先と日付の記録を要する。ラベルを付けた日より前の解除の記録は数えない。
 *
 * 限界: ラベルの履歴(pr.labelEvents)を渡せない場合、ラベルを外した PR は申し立てを検出できない(ワークフローは
 * GitHub の issue の events から履歴を渡す)。記録の記述が事実と合うか、異常の内容の妥当性は判定しない
 */
export function stopFindings({ git, base, pr = {}, config = {}, hosting = null }) {
  const name = (l) => (typeof l === 'string' ? l : (l?.name ?? null));
  const labels = (Array.isArray(pr.labels) ? pr.labels : []).map(name).filter(Boolean);
  const events = Array.isArray(pr.labelEvents) ? pr.labelEvents.filter((e) => name(e?.label) === STOP_LABEL) : null;
  const labeledNow = labels.includes(STOP_LABEL);
  const lastLabeled = (events ?? []).filter((e) => e.event === 'labeled').map((e) => String(e.at ?? e.created_at ?? '')).filter(Boolean).sort().at(-1) ?? null;
  const requested = labeledNow || Boolean(lastLabeled);
  if (!requested) return { requested: false, historyRead: events !== null };
  const sinceDay = lastLabeled ? lastLabeled.slice(0, 10) : null;
  const policyText = git(['show', `${base}:${POLICY_FILE}`]);
  // 層1 の帰属(#428 / IMPL-0415)。基底ブランチの層1 を最後に変えた PR の作成者・承認者に、層1 の記名者のアカウントがあるか。
  // 確かめられない層1 は、項目4 の権限者の照合に使わない(事業決裁者の席の責任者へ戻す)
  const policyRead = readPolicy(config, { text: policyText ?? null });
  const policyAtt = policyAttribution(config, policyRead, { git, rev: base, hosting });
  const policy = withPolicyAttribution(policyRead, policyAtt);
  const policyNote = policyAtt && !policyAtt.backed ? `。${policyUnattributedText(policyAtt)}` : policyAtt?.backed ? `。層1 の帰属: ${policyAtt.note}` : '';
  const files = (git(['ls-tree', '--name-only', base, 'docs/gates/']) ?? '').split('\n').map((f) => f.trim()).filter((f) => f.endsWith('.md'));
  const refers = (text) => Boolean(pr.number) && new RegExp(`PR\\s*#\\s*${pr.number}(?!\\d)`).test(String(text ?? ''));
  // 解除の記録の帰属(process-compass #380 / ADR-0106 / IMPL-0413・IMPL-0414)。基底ブランチの記録は、記録を入れた PR の作成者・
  // 承認者に解除した者本人のアカウントがあるときだけ数える。対象の PR の上の解除した者本人のレビュー(宣言行 `停止の解除: 解除`)も受け付ける
  const releases = files
    .map((f) => parseStopRelease(config, policy, f, git(['show', `${base}:${f}`])))
    .filter((r) => r && refers(r.target))
    .map((r) => {
      if (!r.valid) return r;
      const sha = lastCommitOfFile(git, base, r.file);
      const b = introducedBacking(config, resolveSigner(config, r.judge), sha && hosting ? hosting.prOfCommit(sha) : null, { what: '解除の記録' });
      return b.backed ? { ...r, notes: [...r.notes, `帰属: ${b.note}`] } : { ...r, valid: false, problems: [...r.problems, `帰属を確かめられない(名前の一致だけでは数えない): ${b.why}`] };
    });
  const byReview = stopReviewCandidates(config, { reviews: pr.reviews ?? null, author: pr.author ? prAuthorRef(pr) : null, head: pr.head ?? null, labeledAt: lastLabeled });
  for (const c of byReview.candidates) {
    const r = parseStopRelease(config, policy, `PR #${pr.number} のレビュー ${c.review.id ?? '(id なし)'}`, stopReleaseTextOfReview(c.review, c.person, pr.number));
    if (r) releases.push({ ...r, review: c.review.id ?? null, ...(c.note ? { notes: [...r.notes, `帰属: ${c.note}`] } : {}) });
  }
  const fresh = releases.filter((r) => r.review != null || !sinceDay || (r.day && r.day >= sinceDay));
  const valid = fresh.filter((r) => r.valid);
  const how = labeledNow ? `ラベル ${STOP_LABEL} が付いている` : `ラベル ${STOP_LABEL} を付けた履歴がある(${sinceDay}。ラベルを外しただけでは解除にならない)`;
  if (valid.length) {
    const r = valid[0];
    return {
      requested: true,
      released: true,
      releases,
      message:
        `停止の申し立て: ${how}。${r.review != null ? '' : '基底ブランチの'}解除の記録 ${r.file}(解除 ${r.judge}、${r.day})により保留を解く` +
        `${r.declined ? `。申し立てた者の見解を退けた解除(上申: ${r.escalation})` : ''}${r.selfReleased ? '。申し立てた者と解除した者が同一(その旨を記録に残す)' : ''}` +
        `${r.notes.length ? `。${r.notes.join('。')}` : ''}${labeledNow ? `。ラベル ${STOP_LABEL} は外してよい` : ''}${policyNote}`,
      policyAttribution: policyAtt,
    };
  }
  const rejected = [...releases.map((r) => `${r.file}: ${!fresh.includes(r) ? `ラベルを付けた日(${sinceDay})より前の記録` : r.problems.join('、')}`), ...byReview.rejected.filter((x) => !/読めない/.test(x))];
  return {
    requested: true,
    released: false,
    releases,
    message:
      `停止の申し立て: ${how}。対象のマージを保留する(標準 第7章 7.11)。解除は、層1 の項目4「停止の申し立ての解除」の権限者本人が、` +
      `この PR の上で宣言行「停止の解除: 解除」のレビュー(本文の表に、申し立てた者・解除の理由・申し立てた者の見解を退けたか・退けた場合は上申先と日付)を出して行う。` +
      `対象が PR でない場合などは、解除の記録(テンプレ4 のゲート欄「停止の申し立ての解除」、対象 \`PR #${pr.number ?? '<番号>'}\`)を、権限者本人が作成者または承認者となる PR で基底ブランチへ先に入れる。` +
      `同じ PR で足した記録は数えない。名前の一致だけでは解除に数えない。AI の名義の解除を受け付けない` +
      `${rejected.length ? `。成立しない解除の記録: ${rejected.join(' / ')}` : ''}${policy.present ? '' : '。層1 が無いため、事業決裁者の席の責任者を権限者として照合する'}${policyNote}`,
    policyAttribution: policyAtt,
  };
}

/**
 * D-0 の決定の記名と、前倒しで要る SG の判定記録の帰属(標準 第4章「判定記録を基底ブランチへ入れる操作」。process-compass #428 /
 * ADR-0106 決定5 / IMPL-0415)。PR が構成(process.config.json)の changeLog に足した記録のうち、
 *   - 決定者の記名(decidedBy)を要するもの(緩める向き・任免・名簿の変更。decisionNeedsAttribution)は、決定者のアカウントが
 *     この PR の作成者か承認者であること(作成者なら記名者以外の人の承認、名義の共有なら名義を共有していない人の承認)
 *   - 事業ステージを前へ戻す変化点(sgRecord)は、指す SG の判定記録の判定者のアカウントが、記録を最後に変えた変更(この PR で
 *     変えたならこの PR、基底にあれば記録を入れた PR)の作成者か承認者であること
 * を introducedBacking で確かめ、満たさなければ失敗させる。名簿は既定ブランチの構成(rosterConfig)から読む(PR の中で足した人を
 * 記名者・確認者に数えない)。保持していた宣言を有効にした変化点は、宣言した時点の変化点(基底にあれば、それを入れた PR)で確かめる。
 * 承認は後から付くため、失敗の文に再実行を書く(pull_request_review では起動しない。ワークフローの冒頭)
 */
export function decisionRecordFindings({ git, policyRef, pr = {}, baseConfig = null, headConfig = null, rosterConfig = null, hosting = null, changedFiles = [], atHead = () => null }) {
  const errors = [];
  const notices = [];
  const checked = [];
  const baseLog = Array.isArray(baseConfig?.changeLog) ? baseConfig.changeLog : [];
  const headLog = Array.isArray(headConfig?.changeLog) ? headConfig.changeLog : [];
  if (!rosterConfig || headLog.length <= baseLog.length) return { errors, notices, checked };
  let pull;
  const current = () => {
    if (pull === undefined) {
      const commitAuthors = Array.isArray(pr.commitAuthors) ? pr.commitAuthors : (hosting?.pullCommitAuthors?.(pr.number) ?? null);
      pull = pullInfoOf({ number: pr.number ?? null, author: prAuthorRef(pr), reviews: pr.reviews ?? null, head: pr.head ?? null, commitAuthors });
    }
    return pull;
  };
  const cache = new Map();
  const rerun = '承認は後から付くため、承認の後に gate-g5 の最後の実行を再実行する';
  const how = (who) =>
    `${who}本人がこの PR の作成者か承認者となる(作成者なら、${who}以外の人が PR の先頭を承認する。${who}が AI の担い手と名義を共有するなら、名義を共有していない人が承認する)`;
  const record = (kind, label, b, fix) => {
    checked.push({ kind, label, backed: b.backed, how: b.how ?? null, note: b.note ?? null, why: b.why ?? null, selfAttested: Boolean(b.selfAttested), sharedAccount: Boolean(b.sharedAccount) });
    if (!b.backed) errors.push(`${label}: 帰属を確かめられない(名前の一致だけでは数えない): ${b.why}。${fix}。${rerun}`);
    else if (b.selfAttested) notices.push(`${label}: ${b.note}`);
    else notices.push(`${label}: 帰属 ${b.note}`);
  };
  for (let i = baseLog.length; i < headLog.length; i++) {
    const e = headLog[i];
    if (decisionNeedsAttribution(e)) {
      const label = `D-0 の決定の記名 changeLog[${i}](${e.kind ?? '種別なし'}・${directionLabel(e)}${e.rosterEdits?.length || e.accountConfirmations?.length || e.nameConfirmations?.length ? '・名簿の変更' : ''}、決定 ${e.decidedBy})`;
      // 保持していた宣言の有効化は、記録の内容(intentApplied と基底の構成の席の宣言)が一致するときだけ宣言の時点の記録で確かめる(突合 H-1)
      const j = signatureIndexOf(headLog, i, { prior: baseConfig }) ?? i;
      let info;
      if (j >= baseLog.length) info = current();
      else {
        const sha = commitOfChangeLogEntry(git, policyRef, j, { cache });
        info = sha && hosting ? hosting.prOfCommit(sha) : null;
      }
      // 名簿の数値の識別子を足すだけの変化点は、変化点が書く {login, id} で決定者を同定してよい(突合 H-2)
      const roster = j === i ? idMigrationRoster(rosterConfig, headConfig, e) : rosterConfig;
      const b = introducedBacking(roster, resolveSigner(roster, e.decidedBy), info, { what: j === i ? '決定の記名' : `決定の記名(宣言した時点の changeLog[${j}])` });
      record('d0', j !== i ? `${label}(記名は宣言した時点の changeLog[${j}])` : label, b, how('決定者'));
    }
    // 委任の規則の承認の記名(ruleApprovedBy。AI維持管理者)は、規則を働かせる記名であり、記録を入れるこの PR で確かめる(突合 H-3)
    if (e?.ruleApprovedBy) {
      const b = introducedBacking(rosterConfig, resolveSigner(rosterConfig, e.ruleApprovedBy), current(), { what: '規則の承認の記名' });
      record('rule', `委任の規則の承認の記名 changeLog[${i}](承認 ${e.ruleApprovedBy})`, b, how('承認した者'));
    }
    if (e?.sgRecord) {
      const file = sgRecordPath(e);
      const label = `前倒しで要る SG の判定記録 changeLog[${i}](sgRecord ${e.sgRecord})`;
      if (!file) {
        record('sg', label, { backed: false, why: 'sgRecord が docs/gates/ 配下の判定記録(.md)を指さない' }, 'sgRecord に docs/gates/ の SG の判定記録の所在を書く');
        continue;
      }
      const text = atHead(file);
      const judge = text ? judgeOfForm(text) : null;
      const inPr = changedFiles.includes(file) || git(['show', `${policyRef}:${file}`]) === null;
      let b;
      if (!text) b = { backed: false, why: `${file} が PR の先頭に無い` };
      else if (!judge) b = { backed: false, why: `${file} の判定者が未記入` };
      else {
        const sha = inPr ? null : lastCommitOfFile(git, policyRef, file);
        const info = inPr ? current() : sha && hosting ? hosting.prOfCommit(sha) : null;
        b = introducedBacking(rosterConfig, resolveSigner(rosterConfig, judge), info, { what: 'SG の判定記録' });
      }
      record('sg', `${label}、判定者 ${judge ?? '未記入'}`, b, how('判定者'));
    }
  }
  return { errors, notices, checked };
}

const RISK_RANK = { R3: 1, R2: 2, R1: 3 };
const KIND_OF_STATUS = { A: 'add', M: 'modify', D: 'delete', R: 'rename', C: 'add', T: 'modify' };

/**
 * 区分の下限の規則(構成の riskFloor.rules)に当たる変更から、下限を導く。rules は基底ブランチの構成から渡す。
 * 規則: { id, paths: [glob], floor: 'R1' | 'R2', kinds?: ['add' | 'modify' | 'delete' | 'rename'], why }
 */
export function riskFloorOf(rules, changes) {
  const hits = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!RISK_RANK[r?.floor] || !Array.isArray(r?.paths)) continue;
    const kinds = Array.isArray(r.kinds) && r.kinds.length ? r.kinds : null;
    const files = changes.filter((c) => (!kinds || kinds.includes(c.kind)) && r.paths.some((g) => matchAny([g], c.path) || (c.from && matchAny([g], c.from)))).map((c) => c.path);
    if (files.length) hits.push({ id: r.id ?? '(ID なし)', floor: r.floor, why: r.why ?? null, files });
  }
  const floor = hits.reduce((f, h) => (RISK_RANK[h.floor] > RISK_RANK[f] ? h.floor : f), 'R3');
  return { floor, hits };
}

/**
 * 判断記録の要否の規則(構成の decisionRules.rules)に当たる変更を返す。rules は基底ブランチの構成から渡す。
 * 規則: { id, paths: [glob], kinds?: ['add' | 'modify' | 'delete' | 'rename'], why }。
 * tracked(追跡中のファイル)を渡すと、追跡中のファイルに1件も当たらない規則を unmatched に出す(未宣言として扱う)
 */
export function decisionRuleHits(rules, changes, tracked = null) {
  const hits = [];
  const unmatched = [];
  const malformed = [];
  let valid = 0;
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!Array.isArray(r?.paths) || !r.paths.length || !r.paths.every((g) => typeof g === 'string' && g.trim())) {
      malformed.push(r?.id ?? '(ID なし)');
      continue;
    }
    valid++;
    if (tracked && !tracked.some((f) => r.paths.some((g) => matchAny([g], f)))) unmatched.push(r.id ?? '(ID なし)');
    const kinds = Array.isArray(r.kinds) && r.kinds.length ? r.kinds : null;
    const files = changes.filter((c) => (!kinds || kinds.includes(c.kind)) && r.paths.some((g) => matchAny([g], c.path) || (c.from && matchAny([g], c.from)))).map((c) => c.path);
    if (files.length) hits.push({ id: r.id ?? '(ID なし)', why: r.why ?? null, files });
  }
  return { rules: valid, unmatched, malformed, hits };
}

/** 本文の末尾の段落のトレーラ ADR が指す判断記録の番号(4桁)。「ADR: ADR-021, ADR-0034」の形を読む */
export function adrTrailerIds(body) {
  const ids = [];
  for (const line of lastParagraph(body).split('\n')) {
    const m = /^\s*ADR\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    for (const x of m[1].matchAll(/ADR-(\d{1,5})/g)) ids.push(String(Number(x[1])).padStart(4, '0'));
  }
  return [...new Set(ids)];
}

/** 「リスク区分」の節の「確定した者: <氏名>」。無ければ null */
export function riskConfirmerOf(body) {
  const section = String(body ?? '').replace(/\r\n/g, '\n').split(/^##\s*リスク区分.*$/m)[1]?.split(/^##\s/m)[0] ?? '';
  const m = section.replace(/<!--[\s\S]*?-->/g, '').match(/^\s*[-*]?\s*確定した者\s*[::]\s*(.+?)\s*$/m);
  return m && isFilledValue(m[1]) ? m[1].trim() : null;
}

/** PR の作成者の { login, id }。author はログイン名の文字列か { login, id }。authorId は PR_AUTHOR_ID・--pr の JSON の値 */
export function prAuthorRef(pr) {
  if (pr?.author && typeof pr.author === 'object') return accountRefOf({ author: pr.author });
  return { login: String(pr?.author ?? '').replace(/^@/, ''), id: numericAccountId(pr?.authorId ?? pr?.author_id ?? null) };
}
/** ログイン名の文字列、または { login, id } を { login, id } へ直す */
function authorRef(a) {
  return a && typeof a === 'object' ? { login: String(a.login ?? '').replace(/^@/, ''), id: numericAccountId(a.id ?? null) } : { login: String(a ?? '').replace(/^@/, ''), id: null };
}

/** 作成を指示した者(PR の本文の節)。未記入なら PR の作成者のアカウント */
export function instructorsOf(config, body, author, lookup = null) {
  return instructorTokensOf(config, body, author, lookup).resolved;
}

/**
 * 作成を指示した者の欄の記載を、名簿の人へ対応づけたもの(resolved)と、対応づかなかった記載(unresolved)に分ける。
 * 対応づかない記載を黙って落とすと、旧いログイン名や誤記を書いた PR で、指示した者本人の承認が PR の時点で数えられる
 * (出荷の集約は対応づかない指示者を「確かめられない」として数えない。PR の時点でも数えない側に揃える。ただし既定値は、集約が開発者の席の責任者を足すのに対し、PR の時点は作成者だけである。process-compass #429)
 */
/** 作成を指示した者の節の記載(区切りで分けたもの)。節が無ければ空 */
export function instructorSectionTokens(body) {
  const section = String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').split(/^##\s*作成を指示した者.*$/m)[1]?.split(/^(?:##\s|---\s*$)/m)[0] ?? '';
  return section.split(/[\n,、，/／]/).map((t) => t.replace(/^[\s\-*・]+/, '').trim()).filter(Boolean);
}

export function instructorTokensOf(config, body, author, lookup = null) {
  const tokens = instructorSectionTokens(body);
  const ref = authorRef(author);
  const resolved = [];
  const unresolved = [];
  if (!tokens.length) {
    // 既定値は PR の作成者(ホスティングの記録)。数値の識別子で名簿の人へ対応づける。ログイン名だけの一致は対応づけず、
    // 理由を添えて対応づかない指示者に入れる(process-compass #430 / ADR-0108)
    if (ref.login) {
      const res = identifyAccount(config, ref);
      if (res.person) resolved.push(res.person);
      else if (!aiNameBlocked(config, ref.login)) unresolved.push(res.problem ? `@${ref.login}(${res.problem})` : `@${ref.login}`);
    }
    return { resolved, unresolved, byDefault: true };
  }
  // 人が書いた記載(氏名・名簿の id)は、名簿の記載の名として解決する。@アカウントは、検査の時点にホスティングで数値の識別子へ
  // 解決できる実行(lookup。GH のトークンがある実行)では識別子で名簿と照合し、解決できなければ名簿に対応づかない指示者とする
  // (標準 第4章「アカウントと人の対応表」。process-compass #430 / ADR-0108 決定1 / IMPL-0426)。トークンの無い手元の実行は
  // 従来の名の解決(ログイン名)のまま
  for (const t of tokens) {
    const r = resolveInstructorToken(config, t, lookup);
    if (r.person) resolved.push(r.person);
    else unresolved.push(r.why ? `${t}(${r.why})` : t);
  }
  return { resolved, unresolved, byDefault: false };
}

/**
 * 作成を指示した者の欄の記載1つを名簿の人へ解決する(PR の時点の検査と出荷の集約が同じ関数を使う)。
 * アカウントの記載(@ を付けたもの、または名簿の氏名・id でなく名簿のアカウントのログイン名に当たるもの。#430 突合 L-2)は、
 * lookup があれば数値の識別子へ解決して identifyAccount で照合する。lookup が無ければ従来の名の解決(ログイン名)。
 * 戻り値は { person, why, account }(account は、アカウントの記載として扱ったか)
 */
export function resolveInstructorToken(config, t, lookup = null) {
  const token = String(t ?? '').trim();
  const asAccount = token.startsWith('@') || (Boolean(findPersonByAccount(config, token)) && !findPerson(config, token));
  if (!asAccount) return { person: resolveSigner(config, token), why: null, account: false };
  if (!lookup) return { person: findPersonByAccount(config, token), why: null, account: true };
  const got = lookup.resolve(token);
  if (!got) return { person: null, why: '検査の時点に数値の識別子へ解決できない', account: true };
  const res = identifyAccount(config, got);
  return res.person ? { person: res.person, why: null, account: true } : { person: null, why: `${res.problem ? res.problem : '名簿の人へ対応づかない'}。識別子 ${got.id}`, account: true };
}

/**
 * 作成を指示した者の欄の @アカウントを、検査の時点に数値の識別子へ解決する道具(ADR-0108 決定1)。resolveRaw(login) は
 * { login, id } か null(存在しない・読めない)を返す。解決した値と時点を entries に残す(検査の結果へ出す)。
 * 同じログイン名は1回だけ引く
 */
export function accountLookup(resolveRaw, { at = new Date().toISOString() } = {}) {
  const entries = new Map();
  return {
    at,
    entries,
    resolve(token) {
      const login = String(token ?? '').trim().replace(/^@/, '');
      const key = accountKey(login);
      if (!key) return null;
      if (!entries.has(key)) {
        let got = null;
        let error = null;
        try {
          const r = resolveRaw(login);
          got = r && numericAccountId(r.id ?? null) !== null ? { login: String(r.login ?? login), id: numericAccountId(r.id) } : null;
          if (!got) error = '存在しない、または数値の識別子を読めない';
        } catch (e) {
          error = String(e?.stderr ?? e?.message ?? e).split('\n')[0];
        }
        entries.set(key, { token: `@${login}`, login: got?.login ?? login, id: got?.id ?? null, at, error });
      }
      const e = entries.get(key);
      return e.id !== null ? { login: e.login, id: e.id } : null;
    },
  };
}

/** gh api users/<login> で引く(GH のトークンがある実行)。読めなければ例外 */
export function ghUserLookup() {
  return accountLookup((login) => {
    const r = JSON.parse(execFileSync('gh', ['api', `users/${encodeURIComponent(login)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    return { login: r?.login ?? login, id: r?.id ?? null };
  });
}

/** --pr の JSON の accountIds({ <login>: 数値 | null })から引く(試験と、解決の結果を書き出して渡す手元の実行) */
export function fixedUserLookup(ids, { at } = {}) {
  const m = new Map(Object.entries(ids && typeof ids === 'object' ? ids : {}).map(([k, v]) => [accountKey(k), v]));
  return accountLookup((login) => {
    const v = m.get(accountKey(login));
    return v === undefined || v === null ? null : { login, id: v };
  }, at ? { at } : {});
}

/**
 * G-6 の承認者の数(検査8)。PR のレビュー(reviews: [{ author: { login, is_bot }, state, body }])から、出荷の証跡の集約と同じ条件で
 * 独立した人の承認者を数える。レビュアごとの最後の状態で数え、承認の後の変更要求は承認を取り下げたものとして扱う。
 * G-6 の判定記録(docs/gates/)は PR の時点では基底に無いことが多いため、ここでは読まない(集約が読む)。
 * reviews が無い(読めない)ときは readable: false を返し、呼び出し側がその旨を出す
 */
export function approverFindings(config, pr, files = null, tracked = null) {
  const g6Active = ['required', 'simplified'].includes(config.gates?.g6?.state);
  const counts = reviewersRequiredOf(config);
  // コア機能の変更(構成のコア機能のパス = 確約範囲・コア指定 + 区分の下限の規則のパス)は coreReviewerCount と reviewerCount の大きいほう(#288 第8巡 Z7)。
  // パスが未宣言なら、コア機能かどうかを確かめられない(core.declared が偽)。黙って全変更の数で通さず、呼び出し側がその旨を出す
  const coreOf = counts.coreDeclared && counts.core > counts.all && Array.isArray(files) ? touchesCore(config, files, { tracked }) : null;
  const core = counts.coreDeclared && counts.core > counts.all ? { configured: counts.core, declared: Boolean(coreOf), hit: coreOf?.hit ?? null, files: coreOf?.files ?? [], paths: coreOf?.paths ?? [] } : null;
  const required = core?.hit ? counts.core : counts.all;
  if (!g6Active) return { applies: false, required, core };
  if (!Array.isArray(pr.reviews)) return { applies: true, readable: false, required, core };
  const instructorInfo = instructorTokensOf(config, pr.body, prAuthorRef(pr), pr.accountLookup ?? null);
  const instructors = instructorInfo.resolved;
  // レビュアは数値の識別子で区別する(識別子が読めなければログイン名)。ホスティングの (login, id) と名簿の (login, id) の
  // 食い違いは accountFindings に出す(process-compass #430 / ADR-0108)
  const last = new Map();
  for (const r of pr.reviews) {
    const ref = accountRefOf(r);
    const login = ref.login || null;
    const lkey = ref.id !== null ? `#${ref.id}` : login;
    let state = String(r?.state ?? '').toUpperCase();
    // 書き込みの権限を持たない関係のアカウントの承認(名簿のログイン名を他人が取得した疑い)は数えない(#429)
    if (state === 'APPROVED' && hasWriteAssociation(r) === false) {
      last.set(lkey, { login, id: ref.id, approved: false, bot: Boolean(r.author?.is_bot), summary: false, untrusted: String(r.author_association ?? r.authorAssociation) });
      continue;
    }
    if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) continue;
    const before = last.get(lkey);
    // 承認の本文は、挙動要約の最低限の形(承認の語だけでない、8文字以上)を満たすときだけ挙動要約に数える(集約と同じ。#288 第8巡 X8)
    const body = hasBehaviorSummary(r.body);
    // 挙動要約の文(同一の文かを比べる形)。本文の無い再承認は、直前の承認の文を引き継ぐ
    const key = body ? behaviorSummaryKey(r.body) : before?.approved ? before.key ?? null : null;
    if (state === 'APPROVED') last.set(lkey, { login, id: ref.id, approved: true, bot: Boolean(r.author?.is_bot), summary: body || (before?.approved && before.summary), key, summaryWhy: body ? null : behaviorSummaryShortfall(r.body) });
    else last.set(lkey, { login, id: ref.id, approved: false, bot: Boolean(r.author?.is_bot), summary: false });
  }
  const counted = [];
  const notCounted = [];
  const accountFindings = [];
  for (const v of last.values()) {
    const login = v.login;
    const ident = identifyAccount(config, { login, id: v.id });
    if (ident.how === 'mismatch' || (ident.how === 'id' && ident.problem)) accountFindings.push(`@${login}(${ident.problem})`);
    if (v.untrusted) {
      notCounted.push(`@${login}(リポジトリとの関係が ${v.untrusted}。書き込みの権限を持たないアカウントの承認。名簿のログイン名を他人が取得した疑い)`);
      continue;
    }
    if (!v.approved) continue;
    // 名義を「専用」と申告した AI の担い手のアカウントの承認は、AI を示す語の有無に依らず数えない。照合は数値の識別子で行う
    // (標準 第4章 G-6。process-compass #430 / ADR-0107 / IMPL-0423)
    const dedicated = dedicatedSeatOf(config, { login, id: v.id });
    if (dedicated) {
      notCounted.push(`@${login}(${dedicated.name}の AI の担い手の専用の名義(数値の識別子 ${v.id})。検出の層)`);
      continue;
    }
    if (instructorInfo.unresolved.length) {
      notCounted.push(`@${login}(作成を指示した者 ${instructorInfo.unresolved.join(' / ')} を名簿と対応づけられず、承認者と別の人かを確かめられない)`);
      continue;
    }
    if (v.bot || aiNameBlocked(config, login)) {
      notCounted.push(`@${login}(AI・bot のアカウント。検出の層)`);
      continue;
    }
    const person = ident.person;
    if (!person || person.appointer === true) {
      notCounted.push(`@${login}(名簿の人へ対応づかない${ident.problem && !person ? `: ${ident.problem}` : ''})`);
      continue;
    }
    if (instructors.some((i) => i.id === person.id)) {
      notCounted.push(`@${login}(作成を指示した者)`);
      continue;
    }
    if (!v.summary) {
      notCounted.push(`@${login}(承認の本文に挙動要約が無い${v.summaryWhy ? `: ${v.summaryWhy}` : ''})`);
      continue;
    }
    if (counted.some((c) => c.id === person.id)) continue;
    // 先に数えた別の承認者と同一の文の挙動要約は、2件目に数えない(標準 第4章 G-6。#305 / ADR-0067 決定3)。
    // 機械が見るのは文の同一だけで、言い換えた写しは検出しない
    const same = v.key ? counted.find((c) => c.key === v.key) : null;
    if (same) {
      notCounted.push(`@${login}(挙動要約が、先に数えた承認者 ${same.name} と同一の文。自分の言葉で書く)`);
      continue;
    }
    // 名義を共有する人(第3章 3.5.3。未申告を含む)の承認は、担い手の操作でないことを機械で確かめられない。条件を満たせば数え、
    // 印(shared)を付ける。件数は保証の開示の項目1 に出る(集約)。適合の主張の根拠に数えない(第1章 1.10.2)
    const shared = sharingOf(config, person);
    counted.push({ id: person.id, name: person.name, login, key: v.key ?? null, shared: shared ? sharingText(shared) : null });
  }
  const sharedApprovals = counted.filter((c) => c.shared).map((c) => ({ name: c.name, login: c.login, with: c.shared }));
  return {
    applies: true,
    readable: true,
    required,
    core,
    counted: counted.length,
    approvers: counted.map((c) => c.name),
    sharedApprovals,
    notCounted,
    accountFindings,
    enough: counted.length >= required,
  };
}

/** 変更要求の本文の、満たさない基準の項目番号(`基準 3`・`基準 2, 5`・`項目 3`)。全角の数字・空白は NFKC で寄せてから読む */
const CRITERION_REF = /(?:基準|項目)\s*\d+/;
/** 変更要求の本文の、再提出の期限(`期限 2026-11-05`・`期限: 2026-11-05`)。日付の妥当性は見ない */
const RESUBMIT_DUE = /期限\s*[::]?\s*\d{4}-\d{1,2}-\d{1,2}/;

/**
 * 変更要求の本文の形(検査9)。PR のレビューから、レビュアごとの最後の状態が CHANGES_REQUESTED のものを選び、本文に
 * 項目番号と期限の両方があるかを確かめる。欠くものを missing に `@login(項目番号なし、期限なし)` の形で返す。
 * 承認し直されたレビュア(最後の状態が APPROVED)は対象外。AI・bot のアカウントは数えない(検出の層)。
 * 名簿の人でないログイン名も形だけは検査し、その旨を添える。検査8 と同じく G-6 が有効な構成でだけ適用する。
 * reviews が無い(読めない)ときは readable: false を返す
 */
export function changesRequestedFindings(config, pr) {
  if (!['required', 'simplified'].includes(config.gates?.g6?.state)) return { applies: false };
  if (!Array.isArray(pr.reviews)) return { applies: true, readable: false };
  const last = new Map();
  for (const r of pr.reviews) {
    const ref = accountRefOf(r);
    const login = ref.login || null;
    const state = String(r?.state ?? '').toUpperCase();
    if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) continue;
    last.set(ref.id !== null ? `#${ref.id}` : login, { login, id: ref.id, state, body: r.body, bot: Boolean(r.author?.is_bot) });
  }
  const checked = [];
  const missing = [];
  const skipped = [];
  for (const v of last.values()) {
    const login = v.login;
    if (v.state !== 'CHANGES_REQUESTED') continue;
    if (v.bot || aiNameBlocked(config, login)) {
      skipped.push(`@${login}(AI・bot のアカウント。検出の層)`);
      continue;
    }
    // HTML コメントの中の記載は読まない(承認の挙動要約と同じ)
    const text = String(v.body ?? '').replace(/<!--[\s\S]*?-->/g, '').normalize('NFKC');
    const lacks = [];
    if (!CRITERION_REF.test(text)) lacks.push('項目番号なし');
    if (!RESUBMIT_DUE.test(text)) lacks.push('期限なし');
    const ident = identifyAccount(config, { login, id: v.id });
    const person = ident.person;
    const outside = !person || person.appointer === true ? `、名簿の人へ対応づかない${ident.problem && !person ? `: ${ident.problem}` : ''}` : '';
    checked.push(login);
    if (lacks.length) missing.push(`@${login}(${lacks.join('、')}${outside})`);
  }
  return { applies: true, readable: true, checked, missing, skipped };
}

/**
 * 「規模の確認」の節(#295 / ADR-0058)。規模の基準値を超えた PR が、同じ PR の中で人の確認を記録する欄。
 * 実施者・読み切れたか(はい / いいえ)・分割しなかった理由・保証の所在。節が無ければ present: false
 */
export function sizeAttestationOf(body) {
  // HTML コメントの中の見出し・欄は読まない(コメントに隠した見出しで、欄があるように見せる経路を塞ぐ)
  const parts = String(body ?? '').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split(/^##\s*規模の確認.*$/m);
  if (parts.length < 2) return { present: false };
  const section = parts[1].split(/^(?:##\s|---\s*$)/m)[0].replace(/<!--[\s\S]*?-->/g, '');
  const field = (label) => {
    const m = section.match(new RegExp(`^[ \\t]*[-*]?[ \\t]*${label}[ \\t]*[::][ \\t]*(.*?)[ \\t]*$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const rawRead = field('読み切れたか');
  const t = String(rawRead ?? '').normalize('NFKC').trim();
  // 完全一致だけを読む(「はい、ただし…」のような留保つきの値は、答えとして数えない)
  const yes = /^(はい|yes|y)$/i.test(t);
  const no = /^(いいえ|no|n)$/i.test(t);
  return {
    present: true,
    performer: field('実施者'),
    readAll: yes && !no ? 'yes' : no && !yes ? 'no' : null,
    reason: field('分割しなかった理由'),
    assurance: field('保証の所在'),
  };
}

/** 「規模の確認」の不備を理由の配列で返す。L1 以上で根拠が実在する(assuranceValid)ときは、保証の所在だけを要する */
export function sizeAttestationProblems(att, { config, assuranceValid }) {
  if (!att.present) return ['PR の本文に「## 規模の確認」の節がありません(本文は .github/PULL_REQUEST_TEMPLATE.md から作る)'];
  const p = [];
  if (isFilledValue(att.performer) && aiNameBlocked(config, att.performer)) p.push(`実施者 "${att.performer}" が AI の名義である(確認は人が行う。AI の確認は検出の層)`);
  if (!assuranceValid) {
    if (!isFilledValue(att.performer)) p.push('実施者(確認した人の氏名)が未記入');
    if (att.readAll === 'no') p.push('「読み切れたか」が「いいえ」である(読み切れない変更は、実装計画(plan.md)へ戻して分け直す)');
    else if (att.readAll === null) p.push('「読み切れたか」が「はい」「いいえ」のどちらでもない(1つだけ残す)');
    if (!isFilledValue(att.reason)) p.push('分割しなかった理由が未記入');
  }
  if (!isFilledValue(att.assurance)) p.push('保証の所在(テスト・契約・型など、確認の範囲を限定したもの。全体を読んだ場合は「なし(全体を読んだ)」のように書く)が未記入');
  return p;
}

/**
 * 規模の基準値の実効値。null(基準なし)は、次をすべて満たすときだけ効く。それ以外は既定値で判定し、理由を notes に出す。
 *   - 担保水準 L2 の宣言と、実在する根拠・見直し日(assuranceOf)
 *   - 確約範囲・コア指定のパス(delegation.protectedPaths か riskFloor.rules のパス)が宣言されている(宣言が無い構成では、コア外かを確かめられない)
 *   - この変更のリスク区分が R3 で、区分の下限も R3
 *   - 変更したパスが、確約範囲・コア指定のパスに触れない
 * PR の検査と、出荷の集約(マージ済みの変更の判定)が同じ条件を使う
 */
export function effectiveSizeLimits(cfg, { assurance, risk, floor, touched, tracked = null }) {
  const lim = sizeLimitsOf(cfg);
  let maxLines = lim.lines;
  let maxFiles = lim.files;
  const notes = [];
  let nullApplied = false;
  if (lim.nullLines || lim.nullFiles) {
    // 宣言したパスが追跡中のファイルに1件も当たらなければ、未宣言として扱う(#296 L-9)
    const core = corePathsOf(cfg, { tracked });
    const blockers = [];
    if (assurance.level !== 'L2') blockers.push(assurance.problems.length ? `担保水準の宣言が成立しない(${assurance.problems.join('、')})` : `担保水準が ${assurance.declared} である(基準なしは L2 の宣言と根拠が実在するときだけ)`);
    if (!core.paths.length) blockers.push(core.unmatched.length ? `確約範囲・コア指定のパスが、追跡中のファイルに1件も当たらない(${core.unmatched.join(' ')})。未宣言として扱い、コア外の変更かを確かめられない` : '確約範囲・コア指定のパス(delegation.protectedPaths か riskFloor.rules のパス)が宣言されていない。コア外の変更かを確かめられない');
    else if (core.unmatched.length) notes.push(unmatchedCoreText(core));
    if (risk !== 'R3') blockers.push(`リスク区分が R3 でない(記載: ${risk ?? '未記入'})`);
    if (floor !== 'R3') blockers.push(`区分の下限が ${floor} である`);
    if ((touched ?? []).some((f) => core.paths.some((g) => matchGlob(g, f)))) blockers.push('確約範囲またはコア指定のパスに触れる');
    if (blockers.length) {
      if (lim.nullLines) maxLines = DEFAULT_MAX_CHANGED_LINES;
      if (lim.nullFiles) maxFiles = DEFAULT_MAX_CHANGED_FILES;
      notes.push(`基準値 null(基準なし)は、この変更に効かない(${blockers.join('、')})。既定値(${DEFAULT_MAX_CHANGED_LINES} 行・${DEFAULT_MAX_CHANGED_FILES} ファイル)で判定する`);
    } else nullApplied = true;
  }
  return { maxLines, maxFiles, notes, nullApplied };
}

/** 変更規模の算定の対象を分ける(製品のコード・別集計のテスト・除外)。PR の検査と、出荷の集約の規模の観測が同じ読み方を使う(#295) */
export function classifySize(all, ws, { atBase, atHead = null, genPatterns, isTestPath }) {
  const excluded = [];
  const counted = [];
  const testCounted = [];
  // 文書の置き場の拡張子の無いファイルは、変更後の版の先頭の行(shebang)で判定する(#296)
  const head = atHead ? (f) => { const t = atHead(f); return t === null ? null : t.slice(0, 200); } : null;
  for (const e of all) {
    const f = e.path;
    if (isExcludedFromSize(f, head)) continue;
    if (matchAny(THRESHOLD_FILES, f)) continue;
    if (isLock(f)) {
      excluded.push(`${f}(ロックファイル)`);
      continue;
    }
    if (genPatterns.some((g) => attrMatch(g, f))) {
      excluded.push(`${f}(生成物: 基底の .gitattributes)`);
      continue;
    }
    const before = atBase(e.from ?? f);
    if (before !== null && GENERATED_MARK.test(before.split('\n').slice(0, 5).join('\n'))) {
      excluded.push(`${f}(生成物: 基底で生成の印を持つ)`);
      continue;
    }
    const w = ws?.get(f);
    const added = e.lines === null ? 0 : ws === null ? e.added : (w?.added ?? 0);
    const removed = e.lines === null ? 0 : ws === null ? e.removed : (w?.removed ?? 0);
    if (e.lines !== null && added + removed === 0) {
      excluded.push(`${f}(${e.from && e.lines === 0 ? '内容の変わらない名前の変更' : '空白だけの変更'})`);
      continue;
    }
    (isTestPath(f) ? testCounted : counted).push({ path: f, lines: Math.max(added, removed), added, removed, binary: e.lines === null });
  }
  return { excluded, counted, testCounted };
}

/**
 * マージ済みの変更(スカッシュ・マージコミットの 1 コミット)の規模を、PR の検査と同じ読み方で測る。出荷の集約が使う。
 * git は (args) => 出力 | null の関数。config は、変更の起点(parent)の時点の構成(基準値を変えても過去の判定が変わらないため)。
 * risk は PR の本文のリスク区分(基準なし null の適用条件に使う)。今日の日付(担保水準の見直し日の判定)は、マージコミットの日付を使う。
 * 測れなければ null。構成を読めないときは over: null(判定不能)を返し、黙って超過なしにしない
 */
export function measureCommitSize({ git, parent, commit, config = null, risk = null }) {
  const rawOut = git(['diff', '--numstat', '-z', '-M', parent, commit]);
  if (rawOut === null) return null;
  const all = parseNumstatZ(rawOut);
  const wsOut = git(['diff', '--numstat', '-z', '-M', '-w', '--ignore-blank-lines', parent, commit]);
  const ws = wsOut === null ? null : new Map(parseNumstatZ(wsOut).map((e) => [e.path, e]));
  const atBase = (file) => git(['show', `${parent}:${file}`]);
  const extra = Array.isArray(config?.task?.nonProductPaths) ? config.task.nonProductPaths.filter((g) => typeof g === 'string' && g.trim()) : [];
  const { excluded, counted, testCounted } = classifySize(all, ws, {
    atBase,
    atHead: (file) => git(['show', `${commit}:${file}`]),
    genPatterns: generatedPatterns(atBase('.gitattributes')),
    isTestPath: (f) => [...TEST_PATTERNS, ...extra].some((g) => matchGlob(g, f)),
  });
  const lines = counted.reduce((n, c) => n + c.lines, 0);
  const testLines = testCounted.reduce((n, c) => n + c.lines, 0);
  const out = { lines, files: counted.length, testLines, testFiles: testCounted.length, excluded: excluded.length, over: null, limits: null, reason: null };
  if (!config) {
    out.reason = '変更の起点の構成を読めない';
    return out;
  }
  if (config.configured === false) {
    out.over = false;
    out.reason = '変更の起点の構成が未設定(初回)のため判定しない';
    return out;
  }
  const status = new Map(
    (git(['diff', '--name-status', '-z', '--no-renames', parent, commit]) ?? '').split('\0').reduce((acc, t, i, arr) => (i % 2 === 0 && t ? [...acc, [arr[i + 1], t[0]]] : acc), [])
  );
  const changes = all.map((e) => ({ path: e.path, from: e.from, kind: e.from ? 'rename' : (KIND_OF_STATUS[status.get(e.path)] ?? 'modify') }));
  const day = (git(['show', '-s', '--format=%cs', commit]) ?? '').trim() || undefined;
  const assurance = assuranceOf(config, { exists: (p) => atBase(p) !== null, ...(day ? { today: day } : {}) });
  const eff = effectiveSizeLimits(config, { assurance, risk, floor: riskFloorOf(config.riskFloor?.rules, changes).floor, touched: all.flatMap((e) => (e.from ? [e.path, e.from] : [e.path])), tracked: (() => { const t = git(['ls-tree', '-r', '-z', '--name-only', commit]); return t === null ? null : t.split('\0').filter(Boolean); })() });
  out.limits = { lines: eff.maxLines, files: eff.maxFiles };
  // 超過の理由の内訳(行・ファイル・別集計)と、別集計の基準行数に対する倍率(EV-0084 の差し替え条件の観測。#296)
  out.overReasons = {
    lines: Boolean(eff.maxLines && lines > eff.maxLines),
    files: Boolean(eff.maxFiles && counted.length > eff.maxFiles),
    test: Boolean(eff.maxLines && testLines > eff.maxLines * TEST_OVER_FACTOR),
  };
  out.testRatio = eff.maxLines ? Math.round((testLines / eff.maxLines) * 100) / 100 : null;
  out.over = out.overReasons.lines || out.overReasons.files || out.overReasons.test;
  return out;
}

/** PR の変更を読み、検査の結果を返す。root は検査するリポジトリ(試験では一時のリポジトリ) */
export function analyzePr({ root = ROOT, base, policyBase = null, pr = {}, head = null, requireControlApproval = false, today = null }) {
  const git = gitIn(root);
  const result = { errors: [], warnings: [], notices: [], size: null, thresholds: null, spec: null, riskClass: null, testChanges: [] };
  // 判定の対象の版。head を渡したとき(基底から読む判定。gate-g5-base.yml)は、PR の先頭を取得した参照をデータとして読み、
  // 作業ツリー(既定ブランチの判定のコード)を判定の対象にしない。PR のファイルを取り出さず、実行しない(process-compass #371 / ADR-0115)。
  // 省いたとき(手元の実行と gate-g5.yml の pr-rules)は、取り出した作業ツリー(HEAD)を読む
  const HEADREF = head ?? 'HEAD';
  // 作成を指示した者の欄の @アカウントの解決(ADR-0108 決定1 / IMPL-0426)。--pr の JSON の accountIds(試験・書き出した結果)、
  // または呼び出し側が渡す accountLookup(GH のトークンがある実行の gh api users/<login>)。無ければ名の解決(ログイン名)
  const userLookup = pr.accountLookup ?? (pr.accountIds ? fixedUserLookup(pr.accountIds, { at: pr.accountIdsAt ?? undefined }) : null);
  const mergeBase = (git(['merge-base', base, HEADREF]) ?? '').trim();
  if (!mergeBase) {
    result.errors.push(`比較の起点 ${base} を解決できません。基底ブランチを取得してから実行する(fetch-depth: 0)`);
    return result;
  }
  const atBase = (file) => git(['show', `${mergeBase}:${file}`]);
  // 基準値・名簿・規則・台帳を読む起点。--policy-base を渡したときは既定ブランチの先端、省いたとき(手元の実行)は PR の基底との分岐点。
  // スタックの上の層(基底が下の層のブランチ)でも、まだ既定ブランチへ入っていない下の層の構成・台帳を読まない(ADR-0078)
  const policyRef = policyBase ?? base;
  const policyPoint = policyBase ? (git(['rev-parse', '--verify', '--quiet', `${policyBase}^{commit}`]) ?? '').trim() : mergeBase;
  if (!policyPoint) {
    result.errors.push(`既定ブランチ ${policyRef} を解決できません。既定ブランチを取得してから実行する(基準値と台帳は既定ブランチから読む)`);
    return result;
  }
  const atPolicy = policyPoint === mergeBase ? atBase : (file) => git(['show', `${policyPoint}:${file}`]);
  result.policy = { ref: policyRef, sameAsBase: policyPoint === mergeBase };
  // 効力を持つ記録の帰属を確かめるための、PR の先頭のコミットとホスティングの記録(process-compass #380)。
  // 先頭はワークフローが PR_HEAD_SHA で渡す(checkout はマージのコミットを取り出すため)。手元の実行は HEAD
  const prHead = pr.head ?? ((git(['rev-parse', HEADREF]) ?? '').trim() || null);
  const prHosting = pr.hosting?.commits || pr.hosting?.pulls ? fixedHosting(pr.hosting.commits, pr.hosting.pulls) : (pr.hostingLookup ?? null);
  if (policyPoint !== mergeBase) result.notices.push(`基準値・名簿・区分の下限の規則・台帳の例外承認・停止の申し立ての解除は、PR の基底(${base})でなく既定ブランチ(${policyRef})の先端から読む`);
  const atHead = head
    ? (file) => git(['show', `${head}:${file}`])
    : (file) => {
        const p = path.join(root, file);
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
      };
  const json = (text) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  const headConfig = json(atHead('process.config.json')) ?? {};
  const baseConfig = json(atBase('process.config.json'));
  const baseConfigured = Boolean(baseConfig) && baseConfig.configured !== false;
  const policyConfig = atPolicy === atBase ? baseConfig : json(atPolicy('process.config.json'));
  const policyConfigured = Boolean(policyConfig) && policyConfig.configured !== false;
  // 既定ブランチが未設定なのに PR の基底(スタックの下の層)が設定済みなら、PR の側の構成へ戻らず失敗させる(緩める向きの代替を持たない)。
  // 基底も未設定の初回の chore/process-init は、従来どおり規模の判定を行わない
  if (!policyConfigured && atPolicy !== atBase && baseConfigured) {
    result.errors.push(`既定ブランチ ${policyRef} の構成(process.config.json)が未設定ですが、PR の基底 ${base} は設定済みです。構成を PR の側から読まないため、既定ブランチへ初期化を先に入れてから実行する`);
    return result;
  }
  // 上限と名簿は既定ブランチの構成から読む。同じ PR(とスタックの下の層)で上限を書き換えても、その PR の検査は変わらない
  const limitsFrom = policyConfigured ? policyConfig : headConfig;

  const all = parseNumstatZ(git(['diff', '--numstat', '-z', '-M', mergeBase, HEADREF]));
  // 空白を無視した差分。空白だけが変わったファイル(一括整形)は、この出力に現れない。取得に失敗した場合は、空白を含めて数える
  const wsOut = git(['diff', '--numstat', '-z', '-M', '-w', '--ignore-blank-lines', mergeBase, HEADREF]);
  const ws = wsOut === null ? null : new Map(parseNumstatZ(wsOut).map((e) => [e.path, e]));
  const status = new Map(
    (git(['diff', '--name-status', '-z', '--no-renames', mergeBase, HEADREF]) ?? '')
      .split('\0')
      .reduce((acc, t, i, arr) => (i % 2 === 0 && t ? [...acc, [arr[i + 1], t[0]]] : acc), [])
  );

  // --- 2. 変更規模(#295 / ADR-0058) ---
  // 超過は失敗にしない(標準 第4章「タスクの分割基準」。遮断として運用しない)。超過した PR は、(a) 結果に size:over を出し、
  // (b) 区分の下限を R2 へ引き上げ(下の 7)、(c) PR の本文の「規模の確認」を要する。確認が無い・AI の名義・読み切れなかった場合だけ失敗させる。
  // 算定は、製品のコードのファイルごとの max(追加, 削除)の合計。テスト・fixture・snapshot は別に数え、基準値の判定に入れない。
  // ただし別集計が基準行数の TEST_OVER_FACTOR 倍を超えたら、別集計の側も size:over とする(別集計に上限が無い抜け道を塞ぐ)
  const genPatterns = generatedPatterns(atPolicy('.gitattributes'));
  const extraNonProduct = Array.isArray(limitsFrom.task?.nonProductPaths) ? limitsFrom.task.nonProductPaths.filter((g) => typeof g === 'string' && g.trim()) : [];
  const isTestPath = (f) => [...TEST_PATTERNS, ...extraNonProduct].some((g) => matchGlob(g, f));
  const { excluded, counted, testCounted } = classifySize(all, ws, { atBase, atHead, genPatterns, isTestPath });
  // 区分の下限の規則と変更の種類。size:over の下限(7)と、基準なし(null)の適用条件の両方が使う
  const changes = all.map((e) => ({ path: e.path, from: e.from, kind: e.from ? 'rename' : (KIND_OF_STATUS[status.get(e.path)] ?? 'modify') }));
  const assurance = assuranceOf(limitsFrom, { exists: (p) => atPolicy(p) !== null });
  const declaredRisk = riskClassOf(pr.body);
  const eff = effectiveSizeLimits(limitsFrom, {
    assurance,
    risk: declaredRisk,
    floor: riskFloorOf(limitsFrom.riskFloor?.rules, changes).floor,
    touched: all.flatMap((e) => (e.from ? [e.path, e.from] : [e.path])),
    tracked: trackedFiles(root, HEADREF),
  });
  const { maxLines, maxFiles } = eff;
  const lines = counted.reduce((n, c) => n + c.lines, 0);
  const testLines = testCounted.reduce((n, c) => n + c.lines, 0);
  const size = {
    lines,
    files: counted.length,
    maxLines,
    maxFiles,
    excluded,
    over: [],
    measure: 'ファイルごとの max(追加, 削除)の合計(製品のコードのみ)',
    test: { lines: testLines, files: testCounted.length },
    sizeOver: false,
    overFiles: [...counted, ...testCounted].map((c) => c.path),
    skipped: null,
    attestation: null,
    assurance: { declared: assurance.declared, level: assurance.level, problems: assurance.problems },
  };
  for (const n of eff.notes) result.notices.push(n);
  if (assurance.problems.length && assurance.declared !== 'L0') result.notices.push(`担保水準の宣言(${assurance.declared})は成立していない: ${assurance.problems.join('、')}。L0 として扱う`);
  if (testCounted.length) result.notices.push(`変更規模(別集計): テスト・fixture・snapshot ${testLines} 行 / ${testCounted.length} ファイル。基準値の判定に入れない(基準行数の ${TEST_OVER_FACTOR} 倍を超えたら別集計の側も size:over とする)`);
  if (!policyConfigured) {
    size.skipped = '基底ブランチの構成が未設定(初回の chore/process-init)のため、規模の判定を行わない';
    result.notices.push(`変更規模: ${size.skipped}`);
  } else {
    if (maxLines && lines > maxLines) size.over.push(`変更行数 ${lines} が基準値 ${maxLines} を超えている`);
    if (maxFiles && counted.length > maxFiles) size.over.push(`変更ファイル数 ${counted.length} が基準値 ${maxFiles} を超えている`);
    if (maxLines && testLines > maxLines * TEST_OVER_FACTOR) size.over.push(`テスト・fixture・snapshot(別集計)${testLines} 行が、基準行数の ${TEST_OVER_FACTOR} 倍(${maxLines * TEST_OVER_FACTOR} 行)を超えている`);
  }
  if (size.over.length) {
    size.sizeOver = true;
    // 既存の台帳の例外承認の行は有効のまま(過去の記録を壊さない)。新しい超過は、台帳でなく規模の確認で扱う
    const ex = exceptionFor(atPolicy('docs/debt-ledger.md'), pr.number, limitsFrom, prAuthorRef(pr), {
      git,
      policyRef: policyPoint,
      reviews: pr.reviews ?? null,
      head: prHead,
      headLedgerText: atHead('docs/debt-ledger.md'),
      hosting: prHosting,
      instructorIds: instructorsOf(limitsFrom, pr.body, prAuthorRef(pr), userLookup).map((i) => i.id),
      instructorUnresolved: instructorTokensOf(limitsFrom, pr.body, prAuthorRef(pr), userLookup).unresolved,
    });
    size.exception = ex;
    if (ex.matched.length) {
      size.exceptionApproved = true;
      result.notices.push(`size:over: ${size.over.join('、')}。台帳の例外承認(${ex.matched.map((id) => `${id}。帰属: ${ex.backing?.[id] ?? '—'}`).join(' / ')})が有効なため、規模の確認は要さない。判定完了時間と変更規模を記録し、較正の母集団に含める`);
    } else {
      const att = sizeAttestationOf(pr.body);
      if (ex.rejected.length) result.notices.push(`size:over: 台帳の例外承認の行は有効でない(${ex.rejected.join(' / ')})。規模の超過は例外承認でなく規模の確認で扱う`);
      const problems = sizeAttestationProblems(att, { config: limitsFrom, assuranceValid: assurance.valid });
      // 実施者の名簿照合。作成を指示した者以外の人が名簿にいる体制では、名簿外の実施者を失敗にする(1名体制は警告)
      const instrInfo = instructorTokensOf(limitsFrom, pr.body, prAuthorRef(pr), userLookup);
      const instr = instrInfo.resolved;
      if (instrInfo.unresolved.length) result.warnings.push(`規模の確認: 作成を指示した者 ${instrInfo.unresolved.join(' / ')} を名簿と対応づけられず、実施者が指示した者と別の人かを確かめられない(#429)`);
      const roster = Array.isArray(limitsFrom.people) ? limitsFrom.people : [];
      const others = roster.filter((p) => p?.appointer !== true && !instr.some((i) => i.id === p.id));
      const performer = isFilledValue(att.performer) ? (resolveSigner(limitsFrom, att.performer.replace(/^@/, '')) ?? findPersonByAccount(limitsFrom, att.performer)) : null;
      if (isFilledValue(att.performer) && !performer && !aiNameBlocked(limitsFrom, att.performer)) {
        if (others.length) problems.push(`実施者 "${att.performer}" が人の名簿(people[])の人へ対応づかない(名簿に指示した者以外の人がいる体制では、名簿の人が確認する)`);
        else result.warnings.push(`規模の確認: 実施者 "${att.performer}" が人の名簿(people[])の人へ対応づかない(1名体制のため失敗にしない)`);
      }
      size.attestation = { ...att, assuranceBasis: assurance.valid ? assurance.basis : null, ok: !problems.length, problems };
      result.notices.push(
        `size:over: ${size.over.join('、')}(算定から除いたもの ${excluded.length} 件)。失敗にはしない。区分の下限を R2 へ引き上げ(独立した人の確認が掛かる)、` +
          `PR の本文の「規模の確認」を要する。この観測は保証の開示に集計する(上限へは自動で反映しない)`
      );
      if (problems.length) {
        result.errors.push(`規模の確認: ${problems.join('。')}。\`## 規模の確認\` の節へ、実施者・読み切れたか・分割しなかった理由・保証の所在を書く(標準 第4章「タスクの分割基準」。例外承認は要さない)`);
      } else if (performer && instr.some((i) => i.id === performer.id)) {
        result.notices.push(`規模の確認: 実施者は作成を指示した者である。独立した人の確認(G-6)は別に要る${others.length ? '' : '。名簿に指示した者以外の人がいないため、独立した人の確認は無いと記録に出る'}`);
      }
    }
  } else if (maxLines === null || maxFiles === null) {
    result.notices.push('変更規模: 基準値が null(基準なし)で、この変更に効く。規模の確認を要さない(担保水準 L2 の宣言と根拠が実在し、確約範囲・コア指定のパスが宣言され、R3 でコア外の変更)');
    // IMPL-0494: 基準なしが効いた PR には毎回、根拠の中身を機械で確かめていないことを定型で出す(process-compass #360 H-6)
    size.assuranceContentUnchecked = ASSURANCE_CONTENT_UNCHECKED;
    result.notices.push(`変更規模: ${ASSURANCE_CONTENT_UNCHECKED}`);
  }
  result.size = size;

  // --- 3. 閾値・除外設定と製品のコードの同時変更 ---
  const thresholdChanges = [];
  const initial = [];
  const product = all.filter((e) => !isNonProduct(e.path, atHead) && !matchAny(THRESHOLD_FILES, e.path) && !isLock(e.path)).map((e) => e.path);
  const stack = (policyConfig ?? baseConfig ?? headConfig).adapters?.stack ?? null;
  const baseAdapter = stack ? json(atPolicy(`adapters/${stack}.json`)) : null;
  const { plain: adapterThresholds, keyed: keyedThresholds } = splitThresholdGlobs(Array.isArray(baseAdapter?.thresholdFiles) ? baseAdapter.thresholdFiles : []);
  const thresholdGlobs = [...THRESHOLD_FILES, ...adapterThresholds];
  // 依存と設定を兼ねるファイル(pyproject.toml など)の中の閾値の表(アダプタの「ファイル#表」。#363)。
  // 表の中身が変わったときだけ閾値の変更に数え、そのファイルは製品のコードに数えない
  const keyedChange = keyedThresholdChanges(all, keyedThresholds, atBase, atHead);
  thresholdChanges.push(...keyedChange.changed);
  initial.push(...keyedChange.initial);
  for (const e of all) {
    const f = e.path;
    const isThreshold = matchAny(thresholdGlobs, f) || (stack && f === `adapters/${stack}.json`);
    if (!isThreshold) continue;
    if (atBase(e.from ?? f) === null && !(f === STACK_EXCLUSIONS && baseConfigured)) initial.push(f);
    else thresholdChanges.push(f);
  }
  if (all.some((e) => e.path === 'process.config.json')) {
    if (!baseConfigured) initial.push('process.config.json(基底の構成が未設定)');
    else {
      const keys = ['ci', 'task', 'guard'].filter((k) => canonicalJson(baseConfig[k] ?? null) !== canonicalJson(headConfig[k] ?? null));
      if (keys.length) thresholdChanges.push(`process.config.json(${keys.join('・')})`);
    }
  }
  // アダプタの thresholdFiles に当たるファイルは、製品のコードから外す(閾値のファイルを製品のコードと数えない)
  const productCode = product.filter((f) => !matchAny(thresholdGlobs, f) && !keyedChange.files.has(f));
  result.thresholds = { changed: thresholdChanges, initial, product: productCode.length };
  if (thresholdChanges.length && productCode.length) {
    result.errors.push(
      `閾値・除外設定と製品のコードが同じ PR で変わっています(第4章 G-5「基準値と除外設定の変更」)。閾値・除外設定: ${thresholdChanges.slice(0, 5).join(', ')} / 製品のコード: ${productCode.slice(0, 5).join(', ')}${productCode.length > 5 ? ` ほか ${productCode.length - 5} 件` : ''}。` +
        '閾値・除外設定の変更を別の PR に分ける'
    );
  } else if (thresholdChanges.length) {
    result.notices.push(`閾値・除外設定だけを変える PR です(${thresholdChanges.join(', ')})。緩める向きの変更は /process-change と記名を要する`);
  }
  if (initial.length) result.notices.push(`閾値・除外設定の初回の設定(基底に無い): ${initial.join(', ')}。同時変更の検査の対象外`);

  // --- 3b. 統制の設定の陰性の確認(標準 第4章 G-5。ADR-0073) ---
  // 統制の設定(閾値・除外設定・ルールセット・フック・権限・ワークフロー)を変える PR は、違反の場面を1つ通して止まることを人が確かめ、本文に記録する。
  // 初回の設定(基底に無い・基底の構成が未設定)と、依存の更新の bot の PR は対象外。場面が実際に止まるかは、この検査では確かめない
  const controlChanged = [
    ...thresholdChanges,
    ...all.filter((e) => matchAny(CONTROL_FILES, e.path) && !thresholdChanges.includes(e.path) && atBase(e.from ?? e.path) !== null).map((e) => e.path),
  ];
  result.negativeCheck = { changed: controlChanged, record: null };
  if (controlChanged.length && baseConfigured && !DEPENDENCY_BOTS.includes(String(pr.author ?? ''))) {
    const nc = negativeCheckOf(pr.body);
    const problems = negativeCheckProblems(nc, { config: limitsFrom });
    result.negativeCheck.record = { ...nc, ok: !problems.length, problems };
    if (problems.length) {
      result.errors.push(
        `統制の設定の陰性の確認: 統制の設定(${controlChanged.slice(0, 5).join(', ')}${controlChanged.length > 5 ? ` ほか ${controlChanged.length - 5} 件` : ''})を変える PR です。${problems.join('。')}。` +
          (nc.result === 'removed'
            ? '`## 統制の設定の陰性の確認` の節へ、外した検査・止めていた場面・外した後に止めるもの(または止めないと決めた理由)・受け入れた者(AI維持管理者)を書く(標準 第4章 G-5「検査を外す変更の記録」。人が書く)'
            : '`## 統制の設定の陰性の確認` の節へ、通した違反の場面・結果(止まった / 止まらなかった / 外した)・確かめた者を書く(標準 第4章 G-5。人が確かめ、人が書く)')
      );
    } else if (nc.result === 'removed') {
      result.notices.push(
        `統制の設定の陰性の確認: 検査を外す記録あり(外した検査 ${nc.removed.slice(0, 60)}。外した後に止めるもの ${nc.afterRemoval.slice(0, 60)}。受け入れた者 ${nc.acceptedBy})。` +
          '記名の済んだ縮小は、是正の起動の起点「統制の弱化の検知」に当たらない。外した後に止めると書いた検査が実際に止めるかは、この検査では確かめていない'
      );
    } else result.notices.push(`統制の設定の陰性の確認: 記録あり(${nc.scene.slice(0, 60)} → 止まった。確かめた者 ${nc.checker})。場面が実際に止まるかは、この検査では確かめていない`);
  }

  // --- 3c. 統制の設定の変更の承認(標準 第4章 G-5「統制の設定の変更の承認」。process-compass #371 / ADR-0115) ---
  // 基底から読む判定(gate-g5-base.yml の --require-control-approval)でだけ行う。PR の側で動く pr-rules では行わない(同じ PR で外せるため)。
  // 統制の設定を変える変更は、その変更自身が書き換えた検査に合格しただけでは取り込まない。AI維持管理者の席の責任者本人のアカウント
  // (名簿の数値の識別子)による、PR の先頭のコミットへの承認のレビューを要する。本文の記名(「受け入れた者」)は承認に数えない。
  // 向きに依らず掛ける(機械は緩める向きか強める向きかを判定しない)。依存の更新の bot の PR も対象にする(ワークフローの action の更新を含む)
  if (requireControlApproval) {
    // 範囲は出荷の証跡の集約と同じ関数で決める(突合 C-4)
    const touched = controlTouchedBetween(git, mergeBase, HEADREF);
    result.controlApproval = { changed: touched, backing: null };
    if (touched.length && policyConfigured) {
      const b = controlApprovalBacking(policyConfig, { reviews: pr.reviews ?? null, author: { login: pr.author ?? '', id: pr.authorId ?? null }, head: prHead });
      result.controlApproval.backing = b;
      const list = `${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ` ほか ${touched.length - 5} 件` : ''}`;
      if (!b.backed) {
        result.errors.push(
          `統制の設定の変更の承認: 統制の設定(${list})を変える PR です。この変更自身が書き換えた検査に合格しただけでは取り込みません。` +
            `${b.why.join('。')}。AI維持管理者の席の責任者本人が、PR の先頭のコミットに承認のレビューを出す(本文の記名は承認に数えない)。` +
            '承認の後に、このワークフロー(gate-g5-base)の最後の実行を再実行する(標準 第4章 G-5「統制の設定の変更の承認」)'
        );
      } else if (b.selfAttested) {
        result.notices.push(`統制の設定の変更の承認: ${b.note}(統制の設定 ${list})。自己申告として出荷の証跡の集約が区別して数える`);
      } else result.notices.push(`統制の設定の変更の承認: ${b.note}(統制の設定 ${list})`);
    } else if (touched.length) {
      result.notices.push(`統制の設定の変更の承認: 既定ブランチの構成が未設定のため、承認を照らさない(初回の設定。統制の設定 ${touched.slice(0, 5).join(', ')})`);
    }
  }

  // --- 1. トレーラ Spec ---
  const author = String(pr.author ?? '');
  if (DEPENDENCY_BOTS.includes(author)) {
    result.spec = { skipped: `依存の更新の bot(${author})の PR` };
    result.notices.push(`トレーラ Spec: 依存の更新の bot(${author})の PR のため、検査の対象外。依存の追加・更新の必要性は G-6 で確かめる`);
  } else if (!productCode.length) {
    result.spec = { skipped: '製品のコードを変えない PR' };
    result.notices.push('トレーラ Spec: 製品のコードを変えない PR(文書・記録・強制層・構成だけ)のため、検査の対象外');
  } else {
    const lastLines = lastParagraph(pr.body).split('\n').map((l) => l.trim()).filter(Boolean);
    const setupDeclared = lastLines.some((l) => SETUP_TRAILER.test(l));
    const hasFeatureSpec = lastLines.some((l) => SPEC_LINE.test(l));
    const notSetup = productCode.filter((f) => !isSetupFile(f));
    if (setupDeclared && !hasFeatureSpec) {
      const notTrailer = lastLines.filter((l) => !TRAILER_LINE.test(l));
      if (notTrailer.length) {
        result.spec = { problems: [], specs: [] };
        result.errors.push(`トレーラ Spec: 本文の末尾の段落に、トレーラでない行があります(${notTrailer[0].slice(0, 60)})。末尾の段落はトレーラの行だけにする`);
      } else if (!notSetup.length) {
        result.spec = { skipped: '基盤(設定・ツール・雛形)だけの PR(Spec: setup)', setup: productCode };
        result.notices.push(`トレーラ Spec: setup。変更が開発の基盤のファイル(${productCode.slice(0, 5).join(', ')}${productCode.length > 5 ? ` ほか ${productCode.length - 5} 件` : ''})だけに収まるため、仕様とタスクの検査の対象外`);
      } else {
        result.spec = { problems: [], specs: [] };
        result.errors.push(
          `トレーラ Spec: setup は、変更が開発の基盤(設定・ツール・雛形。scripts/gate/check-pr.mjs の SETUP_FILES)だけに収まる PR に限ります。` +
            `製品のコード ${notSetup.slice(0, 5).join(', ')}${notSetup.length > 5 ? ` ほか ${notSetup.length - 5} 件` : ''} を含むため、\`Spec: F-NNN / Task-N\` で対応する仕様とタスクを指す`
        );
      }
    } else {
      const found = specFindings(pr, { exists: (f) => atHead(f) });
      result.spec = found;
      for (const p of found.problems) result.errors.push(`トレーラ Spec: ${p}`);
      // 基盤だけの変更に Spec を書いていない場合は、Spec: setup の経路を示す(仕様を作らせない)
      if (found.problems.length && !found.specs.length && !notSetup.length) {
        result.errors.push('トレーラ Spec: この PR の変更は開発の基盤のファイルだけです。対応する仕様が無い場合は、トレーラの段落へ `Spec: setup` と書く');
      }
    }
  }

  // --- 5. リスク区分 ---
  const risk = riskClassOf(pr.body);
  result.riskClass = risk;
  if (!risk) {
    const section = String(pr.body ?? '').split(/^##\s*リスク区分.*$/m)[1];
    const left = new Set((section?.split(/^##\s/m)[0] ?? '').replace(/<!--[\s\S]*?-->/g, '').match(/R[123]/g) ?? []);
    const why =
      section === undefined
        ? 'PR の本文に「## リスク区分」の節がありません(本文は .github/PULL_REQUEST_TEMPLATE.md から作る)'
        : left.size > 1
          ? `「リスク区分」の節に区分が ${left.size} つ残っています(${[...left].join(' / ')})`
          : '「リスク区分」の節に R1 / R2 / R3 の記載がありません';
    result.errors.push(
      `リスク区分: ${why}。この変更の区分を1つだけ残す。文書・記録だけの PR と Spec: setup の PR も対象です(区分は変更ごとに確定する記録。標準 第3章 3.8.1)。` +
        '本文を直すと、このチェックが再実行されます。AI の担い手は草案を書けますが、確定は人が行います'
    );
  }

  // --- 7. 区分の下限と確定者(標準 第3章 3.8.1「区分の下限と確定者」) ---
  // 規則は基底ブランチの構成から読む。同じ PR で規則を書き換えても、その PR の下限は変わらない
  const rulesConfig = policyConfigured ? policyConfig : headConfig;
  const floorResult = riskFloorOf(rulesConfig.riskFloor?.rules, changes);
  // 規模の基準値の超過(size:over)は、区分の下限を R2 へ引き上げる(#295 / ADR-0058。既存の台帳の例外承認を得た PR を除く)
  if (size.sizeOver && !size.exceptionApproved) {
    floorResult.hits.push({ id: 'size:over', floor: 'R2', why: '規模の基準値を超えた変更の下限は R2(独立した人の確認と区分の確定者を掛ける。ADR-0058)', files: size.overFiles.slice(0, 10) });
    if (RISK_RANK.R2 > RISK_RANK[floorResult.floor]) floorResult.floor = 'R2';
  }
  const rulesChanged = baseConfigured && canonicalJson(baseConfig.riskFloor ?? null) !== canonicalJson(headConfig.riskFloor ?? null);
  if (rulesChanged) {
    floorResult.hits.push({ id: 'riskFloor の変更', floor: 'R2', why: '区分の下限の規則を変える変更の下限は R2(第3章 3.8.1 の要求事項6)', files: ['process.config.json'] });
    if (RISK_RANK.R2 > RISK_RANK[floorResult.floor]) floorResult.floor = 'R2';
    if (productCode.length) {
      result.errors.push(
        `区分の下限: 区分の下限の規則(process.config.json の riskFloor)と製品のコード(${productCode.slice(0, 3).join(', ')}${productCode.length > 3 ? ' ほか' : ''})が同じ PR で変わっています。規則の変更を別の PR に分ける(第3章 3.8.1 の要求事項6)`
      );
    }
  }
  // 判断記録の要否の規則を変える変更も、下限は R2(第2章 2.6「判断記録の要否の規則」の要求事項6。3.8.1 の要求事項6 と同じ扱い)
  const decisionRulesChanged = baseConfigured && canonicalJson(baseConfig.decisionRules ?? null) !== canonicalJson(headConfig.decisionRules ?? null);
  if (decisionRulesChanged) {
    floorResult.hits.push({ id: 'decisionRules の変更', floor: 'R2', why: '判断記録の要否の規則を変える変更の下限は R2(第2章 2.6「判断記録の要否の規則」の要求事項6)', files: ['process.config.json'] });
    if (RISK_RANK.R2 > RISK_RANK[floorResult.floor]) floorResult.floor = 'R2';
    if (productCode.length) {
      result.errors.push(
        `判断記録の要否の規則: 規則(process.config.json の decisionRules)と製品のコード(${productCode.slice(0, 3).join(', ')}${productCode.length > 3 ? ' ほか' : ''})が同じ PR で変わっています。規則の変更を別の PR に分ける(第2章 2.6「判断記録の要否の規則」の要求事項6)`
      );
    }
  }
  result.riskFloor = { floor: floorResult.floor, hits: floorResult.hits, rules: (rulesConfig.riskFloor?.rules ?? []).length };
  if (risk && RISK_RANK[risk] < RISK_RANK[floorResult.floor]) {
    const why = floorResult.hits.filter((h) => RISK_RANK[h.floor] > RISK_RANK[risk]).map((h) => `${h.id}(下限 ${h.floor}${h.why ? `。${h.why}` : ''}: ${h.files.slice(0, 3).join(', ')}${h.files.length > 3 ? ' ほか' : ''})`);
    result.errors.push(
      `区分の下限: 記載された区分 ${risk} は、変更の対象から導いた下限 ${floorResult.floor} より低い。当たった規則: ${why.join(' / ')}。区分を ${floorResult.floor} 以上へ改める(下限より高い区分は妨げない。第3章 3.8.1 の要求事項2)。規則の網羅は主張しない`
    );
  }
  if (risk === 'R1' || risk === 'R2') {
    const confirmer = riskConfirmerOf(pr.body);
    const instructorInfo = instructorTokensOf(rulesConfig, pr.body, prAuthorRef(pr), userLookup);
    const instructors = instructorInfo.resolved;
    const roster = Array.isArray(rulesConfig.people) ? rulesConfig.people : [];
    const others = roster.filter((p) => p?.appointer !== true && !instructors.some((i) => i.id === p.id));
    const why = [];
    let person = null;
    // 名簿に対応づかない指示者がいると、確定した者が指示した者と別の人かを確かめられない(出荷の集約と揃える。#429)
    if (instructorInfo.unresolved.length) why.push(`作成を指示した者 ${instructorInfo.unresolved.join(' / ')} を名簿と対応づけられず、確定した者と別の人かを確かめられない`);
    if (!confirmer) why.push('「リスク区分」の節に「確定した者: <氏名>」が無い');
    else if (aiNameBlocked(rulesConfig, confirmer)) why.push(`確定した者 "${confirmer}" が AI の名義である`);
    else if (!(person = resolveSigner(rulesConfig, confirmer.replace(/^@/, '')) ?? findPersonByAccount(rulesConfig, confirmer))) why.push(`確定した者 "${confirmer}" が人の名簿(people[])の人へ対応づかない`);
    else if (instructors.some((i) => i.id === person.id)) why.push(`確定した者 "${confirmer}" は作成を指示した者である`);
    result.riskConfirmation = { confirmer, valid: !why.length, why, instructors: instructors.map((i) => i.name) };
    if (why.length) {
      if (!others.length) {
        result.notices.push(
          `リスク区分の確定者: ${why.join('。')}。作成を指示した者以外の人が名簿にいないため失敗させない。${risk} の区分は確定していないものとして扱い、保証の開示の項目3 に出る(外部の確認者を名簿に置けば確定できる。第3章 3.8.1)`
        );
      } else {
        result.errors.push(
          `リスク区分の確定者: ${risk} の区分は、作成を指示した者以外の名簿の人が確定し記名する(第3章 3.8.1 の要求事項3)。${why.join('。')}。` +
            '「リスク区分」の節に `確定した者: <氏名>` を1行書く(区分を確定した人が自分で書く。AI は書かない)'
        );
      }
    }
  }

  // --- 7b. 判断記録の要否の規則(標準 第2章 2.6。#422 / ADR-0101) ---
  // 規則は基底ブランチの構成から読む。同じ PR で規則を書き換えても、その PR の当たりは変わらない。
  // 規則に当たった変更を、申告(「設計上の選択を含まない」の記載など)で外す経路は置かない。偽陽性は規則を狭める変更で直す
  {
    const tracked = trackedFiles(root, HEADREF);
    const dr = decisionRuleHits(rulesConfig.decisionRules?.rules, changes, tracked);
    const stage = stageOf(rulesConfig);
    const declared = dr.rules > dr.unmatched.length;
    const ids = adrTrailerIds(pr.body);
    const listMd = head
      ? (dir) => String(git(['ls-tree', '--name-only', `${head}:${dir}`]) ?? '').split(/\r?\n/).filter(Boolean)
      : (dir) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)) : []);
    const has = (files, id) => files.some((f) => f.startsWith(`${id}-`) && f.endsWith('.md'));
    const present = listMd('context/decisions');
    const archived = listMd('context/_archive/decisions');
    const found = ids.filter((id) => has(present, id));
    const missing = ids.filter((id) => !found.includes(id));
    const retired = missing.filter((id) => has(archived, id));
    result.decisionRules = { rules: dr.rules, unmatched: dr.unmatched, malformed: dr.malformed, hits: dr.hits, stage, adr: found, missing, retired };
    if (dr.malformed.length) {
      result.notices.push(`判断記録の要否の規則: 形の誤った規則(${dr.malformed.join(', ')}。paths はパスの glob の配列)を数えていない。構成は /process-change の種別 settings で直す`);
    }
    if (!declared) {
      result.notices.push(
        dr.rules
          ? `判断記録の要否の規則: 規則のパスが追跡中のファイルに1件も当たらない(${dr.unmatched.join(', ')})。未宣言として扱い、判断記録を要する設計上の選択(公開インタフェース・データ形式・構成単位の境界など)を検出できない(第2章 2.6「判断記録の要否の規則」)`
          : '判断記録の要否の規則(process.config.json の decisionRules.rules)が無い。判断記録を要する設計上の選択(公開インタフェース・データ形式・構成単位の境界など)を検出できない。規則の外の選択は、PR の自己チェックと G-6 に残る(第2章 2.6「判断記録の要否の規則」)'
      );
    } else if (dr.unmatched.length) {
      result.notices.push(`判断記録の要否の規則: 規則 ${dr.unmatched.join(', ')} のパスが追跡中のファイルに1件も当たらない(当たらない規則は検出しない)`);
    }
    if (dr.hits.length && !found.length) {
      const where = dr.hits.map((h) => `${h.id}(${h.files.slice(0, 3).join(', ')}${h.files.length > 3 ? ' ほか' : ''}${h.why ? `。${h.why}` : ''})`).join(' / ');
      const why = retired.length
        ? `トレーラ ADR が指す判断記録(${retired.map((id) => `ADR-${id}`).join(', ')})は保管領域(context/_archive/decisions/)にあり、置き換え・廃止済みである。現に効いている判断記録(後継)を指す`
        : missing.length
          ? `トレーラ ADR が指す判断記録(${missing.map((id) => `ADR-${id}`).join(', ')})が context/decisions/ に無い(ファイル名は 4 桁の番号で始める)`
          : '本文の末尾の段落にトレーラ ADR が無い';
      const msg =
        `判断記録の要否の規則: 判断記録を要する変更です(当たった規則: ${where})。${why}。判断記録を context/decisions/ へ置き、トレーラ \`ADR: ADR-NNNN\` を末尾の段落に書く。` +
        '判断記録は取り込む前に技術設計判断(G-3)の判定を受ける。選択の余地が無かった場合も、判断記録にそう書いて G-3 に掛ける。申告で外す経路はありません。規則が広すぎる場合は、規則を狭める変更を別の PR で行う(第2章 2.6「判断記録の要否の規則」)';
      if (stage === 'S0') result.notices.push(`${msg}。事業ステージ S0 のため失敗させない(2.6 のステージ表)`);
      else result.errors.push(msg);
    } else if (dr.hits.length && missing.length) {
      result.warnings.push(`判断記録の要否の規則: トレーラ ADR のうち ${missing.map((id) => `ADR-${id}`).join(', ')} が context/decisions/ に無い`);
    }
  }

  // --- 6. 停止の申し立て(標準 第7章 7.11) ---
  result.stop = stopFindings({ git, base: policyRef, pr: { ...pr, head: prHead }, config: policyConfigured ? policyConfig : headConfig, hosting: prHosting });
  if (result.stop.requested) {
    if (result.stop.released) result.notices.push(result.stop.message);
    else result.errors.push(result.stop.message);
  }

  // --- 6b. D-0 の決定の記名と、前倒しで要る SG の判定記録の帰属(第4章「判定記録を基底ブランチへ入れる操作」。#428 / IMPL-0415) ---
  if (policyConfigured && baseConfig) {
    result.decisionRecords = decisionRecordFindings({
      git,
      policyRef,
      pr: { ...pr, head: prHead },
      baseConfig,
      headConfig,
      // 名簿は既定ブランチの構成から読む。既定ブランチの名簿が空(初回の任免で名簿を埋める PR)なら、PR の先頭の構成の名簿を使う
      rosterConfig: Array.isArray(policyConfig?.people) && policyConfig.people.length ? policyConfig : headConfig,
      hosting: prHosting,
      changedFiles: all.flatMap((e) => (e.from ? [e.path, e.from] : [e.path])),
      atHead,
    });
    result.errors.push(...result.decisionRecords.errors);
    result.notices.push(...result.decisionRecords.notices);
  }

  // --- 8. G-6 の承認者の数(構成 review.reviewerCount。合否にしない。理由は冒頭) ---
  // コア機能の変更(構成のコア機能のパス)は coreReviewerCount(第8章 軸C 高)を要する。パスは変更したファイル(改名の元を含む)で判定する(#288 第8巡 Z7)
  result.approvers = approverFindings(policyConfigured ? policyConfig : headConfig, { ...pr, accountLookup: userLookup },all.flatMap((e) => (e.from ? [e.path, e.from] : [e.path])), trackedFiles(root, HEADREF));
  if (result.approvers.applies) {
    const a = result.approvers;
    const coreText = a.core
      ? a.core.hit
        ? `。コア機能の変更(当たったパス: ${a.core.files.slice(0, 3).join(', ')}${a.core.files.length > 3 ? ' ほか' : ''}。構成 gates.g6.params.coreReviewerCount ${a.core.configured} 名)`
        : a.core.declared
          ? ''
          : `。**コア機能のパスが未宣言のため、この変更がコア機能(要求 ${a.core.configured} 名)に当たるかを確かめられない**(/process-change の種別 mode で delegation.protectedPaths を宣言するか、区分の下限の規則 riskFloor.rules のパスを置く)`
      : '';
    // 名義を共有する人の承認の印(標準 第4章 G-6。IMPL-0423)。数えたうえで、担い手の操作でないことを確かめられない旨を出す
    const sharedText = a.sharedApprovals?.length
      ? `。名義を共有するアカウントの承認 ${a.sharedApprovals.length} 件(${a.sharedApprovals.map((x) => `${x.name} @${x.login}: ${x.with}と名義を共有`).join('、')}。` +
        '担い手の操作でないことを機械で確かめられないため、印を付けて数える。出荷の証跡の集約が保証の開示の項目1 に件数を出す。適合の主張の根拠に数えない)'
      : '';
    if (!a.readable) {
      result.notices.push(
        `G-6 の承認者の数: PR のレビューを読めない(PR_REVIEWS、または --pr の reviews が無い)。要求 ${a.required} 名(構成 review.reviewerCount${a.core?.hit ? ' / コア機能 coreReviewerCount' : ''})の承認は、この検査では確かめていない。ブランチ保護と出荷の証跡の集約で確かめる${coreText}`
      );
    } else if (!a.enough) {
      result.warnings.push(
        `G-6 の承認者 ${a.counted} 名 / 要求 ${a.required} 名${a.core?.hit ? '(コア機能)' : ''}(独立した人の確認に数えられる承認: ${a.approvers.join('、') || 'なし'}${a.notCounted.length ? `。数えない承認: ${a.notCounted.join('、')}` : ''})${coreText}${sharedText}。` +
          `マージの前に、名簿の別人が自分の挙動要約を付けて承認する。要求を満たさないまま取り込んだ変更は、出荷の証跡の集約が「独立した人の確認を経ていない」に数える(この検査は合否にしない)`
      );
    } else {
      result.notices.push(`G-6 の承認者 ${a.counted} 名 / 要求 ${a.required} 名${a.core?.hit ? '(コア機能)' : ''}(${a.approvers.join('、')})。要求を満たす${a.notCounted.length ? `。数えない承認: ${a.notCounted.join('、')}` : ''}${coreText}${sharedText}`);
    }
  }
  // ホスティングの (login, id) と名簿の (login, id) の食い違い(標準 第4章「アカウントと人の対応表」。process-compass #430 / IMPL-0426)。
  // 改名(識別子が一致しログイン名が違う)と、ログイン名が一致し識別子が異なるアカウント(他人の取得の疑い)を出す。合否にしない
  {
    const rosterOf = policyConfigured ? policyConfig : headConfig;
    const found = [...(result.approvers?.accountFindings ?? [])];
    const aref = prAuthorRef(pr);
    if (aref.login) {
      const ai = identifyAccount(rosterOf, aref);
      if (ai.how === 'mismatch' || (ai.how === 'id' && ai.problem)) found.push(`PR の作成者 @${aref.login}(${ai.problem})`);
      else if (ai.how === 'login-only') found.push(`PR の作成者 @${aref.login}(${ai.problem}。作成者を名簿の人へ対応づけない)`);
    }
    // 作成を指示した者の欄の @アカウントの解決の記録(ADR-0108 決定1 / IMPL-0426)。解決した値・時点・名簿との照合の結果を残す
    const atTokens = instructorSectionTokens(pr.body).filter((t) => t.startsWith('@') || (findPersonByAccount(rosterOf, t) && !findPerson(rosterOf, t)));
    if (userLookup) {
      for (const t of atTokens) userLookup.resolve(t);
      const entries = [...userLookup.entries.values()].map((e) => {
        const res = e.id !== null ? identifyAccount(rosterOf, { login: e.login, id: e.id }) : null;
        return {
          ...e,
          result: e.id === null ? 'unresolvable' : res.how,
          person: res?.person?.name ?? null,
          why: e.id === null ? `数値の識別子へ解決できない${e.error ? `(${e.error})` : ''}。名簿に対応づかない指示者として扱う` : res.person ? null : identifyWhy(res),
        };
      });
      result.instructorResolution = { mode: 'id', at: userLookup.at, entries };
      if (entries.length) {
        result.notices.push(
          `作成を指示した者の @アカウントを、検査の時点(${userLookup.at})に数値の識別子へ解決して名簿と照合した: ` +
            entries.map((e) => `${e.token} → ${e.id ?? '解決できない'}(${e.person ? `${e.person}` : e.why})`).join('、')
        );
      }
    } else {
      result.instructorResolution = { mode: 'login', at: null, entries: atTokens.map((t) => ({ token: t, login: t.replace(/^@/, ''), id: null, result: 'login-name', person: findPersonByAccount(rosterOf, t)?.name ?? null })) };
      if (atTokens.length) {
        result.notices.push(
          `作成を指示した者の @アカウント(${atTokens.join('、')})は、GH のトークンの無い実行のため数値の識別子へ解決せず、従来どおりログイン名で名簿と対応づけた(名の解決。CI の検査は識別子で照合する)`
        );
      }
    }
    result.accountFindings = [...new Set(found)];
    if (result.accountFindings.length) {
      result.warnings.push(
        `アカウントと人の対応表: ホスティングのアカウント(ログイン名・数値の識別子)と名簿の記載が食い違う、または数値の識別子が無いため対応づけなかったものがある: ${result.accountFindings.join('、')}。` +
          '名簿の数値の識別子は `node scripts/gate/roster-ids.mjs` の提案を確かめ、人が /process-change(種別 accountable)で記入する(ADR-0108)'
      );
    }
  }

  // --- 9. 変更要求の本文の形(標準 第4章 G-6「承認レビューを判定記録とする条件」の条件1。合否にしない。理由は冒頭) ---
  // レビューを読めないときの注記は 8 が出している。読めるときだけ、項目番号と期限を欠く変更要求を「理由の無い差し戻し」として出す
  result.changesRequested = changesRequestedFindings(baseConfigured ? baseConfig : headConfig, pr);
  if (result.changesRequested.readable && result.changesRequested.missing.length) {
    const c = result.changesRequested;
    result.notices.push(
      `review:changes-requested-without-reason: ${c.missing.join('、')}。理由の無い差し戻し(標準 第4章 G-6「承認レビューを判定記録とする条件」の条件1)。` +
        '変更要求の本文に、満たさない基準の項目番号(`基準 N`)と再提出の期限(`期限 YYYY-MM-DD`)を書く(例: `G-6: 差し戻し / 基準 3 / 期限 2026-11-05`)。' +
        '機械が見るのは形だけで、基準の実在と期限の妥当性は確かめない。この検査は合否にしない(記載の欠落は内部監査の抜き取りで数える)'
    );
  }

  // --- 4. 既存のテストの変更 ---
  const guard =json(atBase('.claude/guard.json')) ?? json(atHead('.claude/guard.json')) ?? {};
  const testPatterns = Array.isArray(guard.testPatterns) ? guard.testPatterns : [];
  const isTest = (f) => testPatterns.some((g) => matchGlob(g, f));
  for (const e of all) {
    const from = e.from ?? e.path;
    if (!isTest(from) || atBase(from) === null) continue;
    const st = status.get(e.path) ?? (e.from ? 'R' : 'M');
    if (st === 'D' || status.get(from) === 'D') {
      if (e.from) result.testChanges.push({ file: from, kind: `名前の変更(→ ${e.path})`, removed: e.removed, assertions: [] });
      else result.testChanges.push({ file: from, kind: '削除', removed: e.removed, assertions: [] });
      continue;
    }
    if (!e.removed) continue;
    const diff = git(['diff', '-U0', '-M', mergeBase, HEADREF, '--', from, e.path]) ?? '';
    const removedLines = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const assertions = removedLines.filter((l) => ASSERTION.test(l)).map((l) => l.slice(1).trim().slice(0, 120));
    result.testChanges.push({ file: e.path, kind: e.from ? `名前の変更と行の削除(${from} →)` : '行の削除・書き換え', removed: e.removed, assertions });
  }

  // --- 4b. 検証を弱める変更の検出・期待値の改めの根拠・落ちることを期待する印(process-compass #360。合否に使わない。IMPL-0489 だけは失敗) ---
  // IMPL-0204・IMPL-0488・IMPL-0489。対象は基底にあるテストと、基底に無い新しいテストのファイルの両方
  {
    const listDir = head
      ? (dir) => String(git(['ls-tree', '--name-only', `${head}:${dir}`]) ?? '').split(/\r?\n/).filter(Boolean)
      : (dir) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)) : []);
    const decisions = listDir('context/decisions');
    const adapter = json(atPolicy(`adapters/${(policyConfig ?? baseConfig ?? headConfig).adapters?.stack ?? ''}.json`));
    const dirs = ['.', typeof adapter?.projectDir === 'string' ? adapter.projectDir.replace(/^\.\/?/, '') || '.' : '.'];
    const checkDay = today ?? pr.today ?? new Date().toISOString().slice(0, 10);
    const w = weakeningFindings({
      // core.quotePath=false: ASCII 以外を含むパスを引用符で囲ませない。囲まれたパスは parseUnifiedDiff が戻す(突合 X-1。coverage-check と同じ扱い)
      diffText: git(['-c', 'core.quotePath=false', 'diff', '-U0', '-M', mergeBase, HEADREF]) ?? '',
      isTest,
      atHead,
      atBase,
      body: pr.body,
      today: checkDay,
      pytestStrict: pytestXfailStrict(atHead, dirs),
      adrExists: (id) => decisions.some((f) => f.startsWith(`${id}-`) && f.endsWith('.md')),
      specText: (feature) => atHead(`specs/${feature}/spec.md`),
    });
    w.today = checkDay;
    result.weakening = w;
    // IMPL-0489: strict の無い pytest の xfail の付与は試験の失敗の扱い(本文「予期せず通った場合は試験の失敗」)の強制であり、検出の表示と分ける
    for (const e of w.strictErrors) {
      result.errors.push(`落ちることを期待する印(pytest の xfail): ${e}。予期せず通った場合を試験の失敗にするため、印に strict=True を書くか、構成に xfail_strict = true を置く(標準 第5章 5.8.5 の後の段落)`);
    }
  }

  // --- 4c. 製品のコードを変えずに既存のテストを変えた変更(IMPL-0486。合否に使わない。静的な近似) ---
  {
    const existingTests = all.filter((e) => isTest(e.from ?? e.path) && atBase(e.from ?? e.path) !== null).map((e) => e.path);
    const productNonTest = productCode.filter((f) => !isTest(f));
    result.testOnly = { detected: existingTests.length > 0 && productNonTest.length === 0, files: existingTests, limit: TEST_ONLY_LIMIT };
  }

  // --- 4d. 実装計画の対象のパスと、変更されたパスの差(IMPL-0205。標準 第5章 5.8.6 要求事項10。合否に使わない) ---
  if (result.spec?.skipped || !result.spec?.specs?.length) {
    result.planTrace = {
      skipped: result.spec?.skipped
        ? `対象外(${result.spec.skipped})。Spec: setup・依存の更新の bot・製品のコードを変えない PR はタスクを持たないため、計画の対象パスとの突合をしない`
        : 'トレーラ Spec: F-NNN / Task-N を読めないため、計画の対象パスとの突合をしない',
    };
  } else {
    result.planTrace = planPathTrace({
      specs: result.spec.specs,
      atPolicy,
      atHead,
      changed: all.flatMap((e) => (e.from ? [e.from, e.path] : [e.path])),
      isTest,
      readTargets: readPlanTargets,
    });
  }

  // --- 4e. 指示資産の変更(標準 第3章 3.11.5。process-compass #358 / IMPL-0501・IMPL-0502・IMPL-0504) ---
  {
    const head = (f) => atHead(f);
    const changedAssets = all.filter((e) => matchAny(INSTRUCTION_ASSET_FILES, e.path) && head(e.path) !== null).map((e) => e.path);
    // IMPL-0504: 個人の作業環境に固有の指示(CLAUDE.local.md・.claude/settings.local.json)を版管理へ入れる変更は失敗(消す変更は通す)
    for (const e of all) {
      if (matchAny(PERSONAL_INSTRUCTION_FILES, e.path) && head(e.path) !== null) {
        result.errors.push(`個人の作業環境に固有の指示 ${e.path} を版管理へ入れています。共有の指示資産へ混入させないため、追跡から外す(.gitignore にある。標準 第3章 3.11.5)`);
      }
    }
    // IMPL-0501: 1ファイルあたりの分量。上限は強制層の設定(.claude/guard.json の instructionAssetLimit.maxLinesPerFile)を既定ブランチから読む。
    // 値は組織が定める(ADR-0084)。未設定なら「上限未設定」と出して判定しない(上限内とは記録しない。失敗にもしない)
    const guardAtPolicy = json(atPolicy('.claude/guard.json'));
    const maxLines = Number.isInteger(guardAtPolicy?.instructionAssetLimit?.maxLinesPerFile) && guardAtPolicy.instructionAssetLimit.maxLinesPerFile > 0 ? guardAtPolicy.instructionAssetLimit.maxLinesPerFile : null;
    const sizes = changedAssets.map((f) => {
      const t = String(head(f) ?? '').replace(/\r\n/g, '\n');
      return { file: f, lines: t === '' ? 0 : t.replace(/\n$/, '').split('\n').length, chars: [...t].length };
    });
    for (const s of sizes) {
      if (maxLines !== null && s.lines > maxLines) result.errors.push(`指示資産 ${s.file} が ${s.lines} 行で、上限 ${maxLines} 行(.claude/guard.json の instructionAssetLimit.maxLinesPerFile)を超えています(標準 第3章 3.11.4 要求事項1・3.11.5)`);
    }
    // IMPL-0502: コードベースから導出できる内容のうち、形で特定できるもの(ディレクトリの木の図)。合否に使わない
    const treeForms = [];
    for (const f of changedAssets) {
      const lines = String(head(f) ?? '').replace(/\r\n/g, '\n').split('\n');
      lines.forEach((l, i) => {
        if (/[├└]──|^\s*[│|]\s+[├└]/.test(l)) treeForms.push({ file: f, line: i + 1, text: l.trim().slice(0, 80) });
      });
    }
    result.instructionAssets = {
      changed: changedAssets,
      sizes,
      maxLines,
      treeForms,
      limit:
        '機械が確かめるのは、1ファイルの行数と上限、ディレクトリの木の図の形までである。既存の記述との矛盾と、形で特定できない導出できる内容は、' +
        'AI維持管理者がレビューで確かめて PR の「指示資産の変更の確認」へ記録する(機械も AI の確認も、その確かめに数えない)。木の図が出ないことは、導出できる内容が無いことを示さない',
    };
  }
  return result;
}

/** 既存のテストの変更の一覧(G-6 の材料)を Markdown にする */
export function renderTestChanges(changes) {
  const L = ['<!-- pit-in:g6-test-changes -->', '### 既存のテストの変更(G-6 の材料。合否には使わない)', ''];
  if (!changes.length) {
    L.push('基底ブランチにあるテストの削除・名前の変更・行の削除はありません。');
    return L.join('\n');
  }
  L.push('レビュアは、各テストの変更が受入基準の変更に対応しているか(テストの失敗をテストの変更で解消していないか)を確かめます。機械は理由の妥当性を判定しません。', '');
  L.push('| テスト | 変更 | 削除した行 | 期待値の変更の候補 |', '| --- | --- | --- | --- |');
  for (const c of changes) {
    const a = c.assertions.length ? c.assertions.slice(0, 3).map((x) => `\`${x.replace(/[|`]/g, ' ')}\``).join('<br>') + (c.assertions.length > 3 ? `<br>ほか ${c.assertions.length - 3} 行` : '') : '—';
    L.push(`| \`${c.file}\` | ${c.kind} | ${c.removed} | ${a} |`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- G-6 の材料: 検証を弱める変更の検出(process-compass #360)
//
// 標準 第5章 5.8.5 の後の段落(検証を弱める変更・期待値の改め・落ちることを期待する印)と 5.8.6 要求事項10(対象のパスの突合)。
// すべて合否に使わない表示である(本文「検出を G-5 の合否に使ってはならない」)。例外は pytest の strict の無い xfail の付与
// (IMPL-0489)で、これは検出ではなく「予期せず通った場合は試験の失敗」の強制のため、G-5(pr-rules)の失敗にする。
// 正本は、既定ブランチのコードで計算するジョブ(gate-g5-base)の要約(--report と GITHUB_STEP_SUMMARY)。PR のコメントは閲覧の便宜。
// ラベルは付けない(ラベルは誰でも外せ、外すと一覧から消えたように見えるため)。

/** 追加行の skip 相当の印(IMPL-0204)。[表示, 正規表現] */
export const SKIP_MARKS = [
  ['.skip( / .todo( / .only(', /\b(?:it|test|describe|context|suite)\.(?:skip|todo|only)\s*\(/],
  ['xit( / xdescribe( / xtest(', /\b(?:xit|xdescribe|xtest)\s*\(/],
  ['pytest.skip(', /\bpytest\.skip\s*\(/],
  ['@pytest.mark.skip / skipif', /\bpytest\.mark\.skip(?:if)?\b/],
  ['@unittest.skip*', /\bunittest\.skip\w*/],
  ['t.Skip( / Skipf( / SkipNow(', /\b\w+\.(?:SkipNow|Skipf|Skip)\s*\(/],
  ['@Disabled', /@Disabled\b/],
  ['@Ignore', /@Ignore\b/],
  ['{ skip: true }', /\bskip\s*:\s*true\b/],
];
/** 追加行の落ちることを期待する印(IMPL-0204・IMPL-0488)。[表示, 正規表現, 枠組み] */
export const XFAIL_MARKS = [
  ['@pytest.mark.xfail', /\bpytest\.mark\.xfail\b/, 'pytest-marker'],
  ['pytest.xfail(', /\bpytest\.xfail\s*\(/, 'pytest-imperative'],
  ['test.fails( / it.fails(', /\b(?:test|it)\.fails\s*\(/, 'vitest'],
  ['test.failing( / it.failing(', /\b(?:test|it)\.failing\s*\(/, 'jest'],
  ['expectFailure', /\bexpectFailure\b/, 'node-test'],
  ['@unittest.expectedFailure', /(?:\bunittest\.|@)expectedFailure\b/, 'unittest'],
];
/** 注釈の行の印(IMPL-0488)。`pit-in: known-failure issue=#NNN match="<照合する失敗の理由>" review=YYYY-MM` */
export const KNOWN_FAILURE_NOTE = /pit-in:\s*known-failure\b(.*)$/;
/** 注釈を探す範囲: 印の行と、その直前の行数 */
export const KNOWN_FAILURE_LOOKBACK = 3;
/** 検出の限界の定型の文(IMPL-0204)。0 件でも出す */
export const WEAKENING_LIMIT =
  '検出の限界: 列挙した語(skip・only・todo・xfail・fails・failing・expectFailure・expectedFailure・Disabled・Ignore・アサーションの語)以外の弱め方は拾わない。' +
  '早期の return、試験の注釈化、別名を経た xfail・skip の一部(同じファイルの import pytest as・from pytest import mark・行頭の xfail = pytest.mark.xfail の代入は読む。from pytest import xfail・関数の中の import・ファイルを越えた別名・skip の別名は読まない)、自前の検証・印、設定による除外(-k・--deselect・testPathIgnorePatterns など)、テストのパスの外のテスト、製品のコードの側で検証を無効にする変更は、一覧に出ない';
/** 「製品のコードを変えずに既存のテストを変えた変更」の検出の限界の定型の文(IMPL-0486)。0 件でも出す */
export const TEST_ONLY_LIMIT = '検出の限界: 同じ PR で製品とテストを変えた場合、ローカルで解消した失敗は拾わない(PR の全体の差分だけを見る静的な近似。失敗が解消したことは確かめない)';
/** 担保水準 L2 で規模の基準なし(null)が効いた PR に毎回出す定型の文(IMPL-0494) */
export const ASSURANCE_CONTENT_UNCHECKED =
  '担保水準の根拠の中身は機械で確かめていない: 機械が確かめたのは L2 の宣言の根拠のパスの実在と見直し日だけである。根拠が L2 の条件(記録で示す)を満たすかは、' +
  '変化点の決定者が /process-change の種別 settings の手順で根拠の中身を読んで確かめる(L2 の採点の稼働を機械で検証することは課さない)';
/** 対象のパスの突合の限界の定型の文(IMPL-0205) */
export const PLAN_TRACE_LIMIT = '計画は既定ブランチの先端から読む。差・列の変更は合否に使わない。glob は ** と * だけを読む({a,b}・? は読まない)';

const COMMENT_LINE = /^\s*(?:\/\/|#|\/\*|\*|--|<!--)/;
const ASSERTION_IN_COMMENT = /\b(expect|assert\w*|toBe|toEqual|toMatch\w*|toStrictEqual|toHaveBeenCalled\w*|Equals|require\.\w+|t\.(Error|Fatal)\w*)\b/;
/** 行がアサーションか。注釈の行では誤検出の多い should・Equal を数えない */
const isAssertionLine = (text) => (COMMENT_LINE.test(text) ? ASSERTION_IN_COMMENT.test(text) : ASSERTION.test(text));

/**
 * `git diff -U0` の出力を、ファイルと塊(hunk)に分ける。
 * 返り値: [{ file: 変更後のパス(削除なら null), from: 変更前のパス(追加なら null), hunks: [{ lines: [{ type: '+'|'-', text, line }] }] }]
 * line は、追加行では変更後の行番号、削除行では変更前の行番号
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of String(text ?? '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = { file: null, from: null, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (!hunk && raw.startsWith('--- ')) {
      // 引用符つきのパス("a/tests/test_\346\227\245.py")は戻してから接頭辞を外す(突合 X-1)。空白を含むパスの末尾のタブも外す
      const p = unquoteGitPath(raw.slice(4).replace(/\t$/, '').trimEnd());
      cur.from = p === '/dev/null' ? null : p.replace(/^a\//, '');
      continue;
    }
    if (!hunk && raw.startsWith('+++ ')) {
      const p = unquoteGitPath(raw.slice(4).replace(/\t$/, '').trimEnd());
      cur.file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      hunk = { lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith('+')) hunk.lines.push({ type: '+', text: raw.slice(1), line: newLine++ });
    else if (raw.startsWith('-')) hunk.lines.push({ type: '-', text: raw.slice(1), line: oldLine++ });
    else if (raw.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  return files;
}

/** 注釈 `pit-in: known-failure ...` の欄を読み、欠け・超過の理由を返す。today は検査の日(YYYY-MM-DD) */
export function knownFailureProblems(noteText, today) {
  if (noteText === null || noteText === undefined) return ['注釈 `pit-in: known-failure issue=#NNN match="..." review=YYYY-MM` が印の行にも直前の行にも無い'];
  const m = KNOWN_FAILURE_NOTE.exec(noteText);
  const rest = m ? m[1] : '';
  const problems = [];
  if (!/\bissue=#\d+\b/.test(rest)) problems.push('issue=#NNN の欄が無い');
  if (!/\bmatch="[^"]*\S[^"]*"/.test(rest)) problems.push('match="<照合する失敗の理由>" の欄が無い');
  const rv = /\breview=(\d{4})-(\d{2})\b/.exec(rest);
  if (!rv || Number(rv[2]) < 1 || Number(rv[2]) > 12) problems.push('review=YYYY-MM の欄が無い');
  else if (today && `${rv[1]}-${rv[2]}` < String(today).slice(0, 7)) problems.push(`見直しの時期 review=${rv[1]}-${rv[2]} を過ぎている(検査の日 ${String(today).slice(0, 10)})`);
  return problems;
}

/** ini・toml の真偽の値(pytest の ini の bool と同じ語) */
const truthy = (v) => /^(?:true|1|yes|y|t|on)$/i.test(String(v ?? '').trim().replace(/^["']|["']$/g, ''));

/**
 * pytest の構成の xfail_strict(IMPL-0489)。pytest が構成のファイルを選ぶ順(pytest.ini → pyproject.toml の
 * [tool.pytest.ini_options] → tox.ini の [pytest] → setup.cfg の [tool:pytest])で、最初に当たったファイルだけを読む。
 * dirs は探す置き場(リポジトリの直下 '.' とアダプタの projectDir)。返り値: { file, strict } | null(構成が無い)
 */
export function pytestXfailStrict(read, dirs = ['.']) {
  const candidates = [
    ['pytest.ini', 'pytest', false, true],
    ['pyproject.toml', 'tool.pytest.ini_options', true, false],
    ['tox.ini', 'pytest', false, false],
    ['setup.cfg', 'tool:pytest', false, false],
  ];
  for (const dir of [...new Set(dirs)]) {
    for (const [name, table, toml, always] of candidates) {
      const file = dir === '.' || !dir ? name : `${dir.replace(/\/+$/, '')}/${name}`;
      const text = read(file);
      if (text === null || text === undefined) continue;
      const section = tableSection(text, table, { toml });
      if (!section && !always) continue;
      const v = /^xfail_strict\s*=\s*(.+)$/m.exec(section);
      return { file, strict: Boolean(v && truthy(v[1])) };
    }
  }
  return null;
}

/** 印の行から、括弧が閉じるまで(最大 10 行)の本文を返す(複数行に分けた @pytest.mark.xfail( ... strict=True) を読む) */
function markCall(headLines, lineNo) {
  let out = '';
  let depth = 0;
  let opened = false;
  for (let i = lineNo - 1; i < Math.min(headLines.length, lineNo + 9); i++) {
    const l = headLines[i] ?? '';
    out += `${l}\n`;
    for (const c of l) {
      if (c === '(') {
        depth++;
        opened = true;
      } else if (c === ')') depth--;
    }
    if (!opened || depth <= 0) break;
  }
  return out;
}

/**
 * PR 本文の `## 期待値の改め` の表(`ファイル | 旧 | 新 | 根拠`)を読む。節が無ければ null。
 * 根拠の識別子は ADR-NNNN・F-NNN/AC-N(受入基準)・条項の番号(第N章 N.N.N、N.N.N、附属書X)に限る。Issue の番号だけは数えない
 */
export function expectationTableOf(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^#{2,3}\s*期待値の改め/.test(l));
  if (start < 0) return null;
  const rows = [];
  let header = null;
  let inComment = false;
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(l)) break;
    if (/<!--/.test(l) && !/-->/.test(l)) inComment = true;
    if (inComment) {
      if (/-->/.test(l)) inComment = false;
      continue;
    }
    const t = l.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|[\s|:-]+\|$/.test(t)) continue;
    const cells = t.slice(1, t.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim());
    if (!header) {
      header = cells;
      continue;
    }
    if (cells.every((c) => !c || /^[—–-]$/.test(c))) continue;
    rows.push({ file: cells[0] ?? '', old: cells[1] ?? '', new: cells[2] ?? '', basis: cells[3] ?? '' });
  }
  return { rows };
}

/** 表の「ファイル」の升をパスへ(バッククォートと末尾の :行 を除く) */
const tableFileOf = (cell) => String(cell ?? '').replace(/`/g, '').trim().replace(/:\d+(?:-\d+)?$/, '');

/** 根拠の升の識別子を解決する。ctx: { adrExists(id4), specText(feature) }。返り値: { ids: [表示], problems: [理由] } */
export function basisProblems(cell, { adrExists, specText }) {
  const text = String(cell ?? '').normalize('NFKC');
  const ids = [];
  const problems = [];
  for (const m of text.matchAll(/ADR-(\d{1,5})/g)) {
    const id = String(Number(m[1])).padStart(4, '0');
    ids.push(`ADR-${id}`);
    if (!adrExists(id)) problems.push(`ADR-${id} が context/decisions/ に無い`);
  }
  for (const m of text.matchAll(/\b(F-\d+)\s*[/#:]?\s*AC-?(\d+)\b/g)) {
    ids.push(`${m[1]}/AC-${m[2]}`);
    const spec = specText(m[1]);
    if (spec === null || spec === undefined) problems.push(`${m[1]}/AC-${m[2]} の仕様 specs/${m[1]}/spec.md が無い`);
    else if (!new RegExp(`^\\|\\s*${m[2]}\\s*\\|`, 'm').test(spec)) problems.push(`${m[1]}/AC-${m[2]} の受入基準が specs/${m[1]}/spec.md の表に無い`);
  }
  const clauses = [...text.matchAll(/(?:第\s*\d+\s*章\s*)?\b\d+(?:\.\d+){1,4}\b|附属書\s*[A-Z](?:\.\d+)*/g)].map((m) => m[0].replace(/\s+/g, ' '));
  ids.push(...clauses.map((c) => `条項 ${c}`));
  if (!ids.length) problems.push(/#\d+/.test(text) ? 'Issue の番号だけで、根拠の識別子(ADR・受入基準・条項)が無い' : '根拠の識別子(ADR-NNNN・F-NNN/AC-N・条項の番号)が無い');
  return { ids, clausesUnresolved: clauses.length > 0, problems };
}

/**
 * pytest の印の別名(IMPL-0204・IMPL-0489。突合 X-2)。同じファイルの本文の import と、行頭の代入だけを読む。
 * 読む形: `import pytest as pt`(pt.mark.xfail・pt.xfail()、`from pytest import mark [as m]`(mark.xfail)、
 * `xfail = <pytest の mark>.xfail[(...)]`(@xfail)。関数の中の import、ファイルを越えた別名、`from pytest import xfail` などは読まない(限界の文に書く)
 */
export function pytestAliasesOf(text) {
  const src = String(text ?? '');
  const modules = new Set(['pytest']);
  for (const m of src.matchAll(/^import[ \t]+([^\n#]+)/gm)) {
    for (const part of m[1].split(',')) {
      const a = /^\s*pytest\s+as\s+(\w+)\s*$/.exec(part);
      if (a) modules.add(a[1]);
    }
  }
  const marks = new Set();
  for (const m of src.matchAll(/^from[ \t]+pytest[ \t]+import[ \t]+\(?([^)\n#]+)/gm)) {
    for (const part of m[1].split(',')) {
      const a = /^\s*mark(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (a) marks.add(a[1] ?? 'mark');
    }
  }
  const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const markExpr = [...[...modules].map((x) => `${rx(x)}\\.mark`), ...[...marks].map(rx)].join('|');
  const assign = new RegExp(`^\\s*(\\w+)\\s*=\\s*(?<![\\w.])(?:${markExpr})\\.xfail\\b`);
  const names = new Map();
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    const m = assign.exec(l);
    if (m && m[1] !== 'pytest') names.set(m[1], markCall(lines, i + 1));
  });
  const aliasModules = [...modules].filter((x) => x !== 'pytest');
  return {
    assign,
    // pytest.mark.xfail の字面は XFAIL_MARKS が拾う。ここは別名だけ
    marker: aliasModules.length || marks.size ? new RegExp(`(?<![\\w.])(?:${[...aliasModules.map((x) => `${rx(x)}\\.mark`), ...[...marks].map(rx)].join('|')})\\.xfail\\b`) : null,
    imperative: aliasModules.length ? new RegExp(`(?<![\\w.])(?:${aliasModules.map(rx).join('|')})\\.xfail\\s*\\(`) : null,
    names,
    decorator: names.size ? new RegExp(`^\\s*@(${[...names.keys()].map(rx).join('|')})\\b`) : null,
  };
}

/** 別名を経た pytest の xfail の行か。XFAIL_MARKS と同じ形 [表示, 正規表現, 枠組み, 代入の式] を返す。当たらなければ null */
export function pytestAliasMark(text, alias) {
  if (alias.marker?.test(text)) return [`@pytest.mark.xfail(別名 ${alias.marker.exec(text)[0]})`, alias.marker, 'pytest-marker'];
  if (alias.imperative?.test(text)) return [`pytest.xfail( (別名 ${alias.imperative.exec(text)[0].replace(/\s*\($/, '')})`, alias.imperative, 'pytest-imperative'];
  const d = alias.decorator?.exec(text);
  if (d) return [`@pytest.mark.xfail(別名 @${d[1]})`, alias.decorator, 'pytest-marker', alias.names.get(d[1]) ?? ''];
  return null;
}

/**
 * 検証を弱める変更の検出(IMPL-0204)・期待値の改めの根拠・落ちることを期待する印の注釈(IMPL-0488)・pytest の strict(IMPL-0489)。
 * diffText: `git diff -U0 -M <基底> <先頭>` の全体。isTest: テストのパスの判定。atHead・atBase: 本文を読む関数。
 * 返り値: { files, skips, xfails, removedAssertions, pairs, newTestFiles, strictErrors, expectation, limit }
 */
export function weakeningFindings({ diffText, isTest, atHead, atBase, body = '', today = null, pytestStrict = null, adrExists = () => false, specText = () => null }) {
  const out = { newTestFiles: [], skips: [], xfails: [], removedAssertions: [], pairs: [], strictErrors: [], notes: [], expectation: null, limit: WEAKENING_LIMIT };
  const headCache = new Map();
  const headLinesOf = (f) => {
    if (!headCache.has(f)) headCache.set(f, String(atHead(f) ?? '').replace(/\r\n/g, '\n').split('\n'));
    return headCache.get(f);
  };
  const aliasCache = new Map();
  const aliasesOf = (f, lines) => {
    if (!aliasCache.has(f)) aliasCache.set(f, pytestAliasesOf(lines.join('\n')));
    return aliasCache.get(f);
  };
  let jsFails = false;
  for (const d of parseUnifiedDiff(diffText)) {
    if (!d.file) continue; // 削除したテストのファイルは、既存のテストの変更の一覧(IMPL-0203)が出す
    if (!isTest(d.file) && !(d.from && isTest(d.from))) continue;
    if (!d.from || atBase(d.from) === null) out.newTestFiles.push(d.file);
    for (const h of d.hunks) {
      const removed = h.lines.filter((l) => l.type === '-' && isAssertionLine(l.text));
      const added = h.lines.filter((l) => l.type === '+' && isAssertionLine(l.text));
      removed.forEach((r, i) => {
        const a = added[i];
        if (a) out.pairs.push({ file: d.file, line: a.line, old: r.text.trim().slice(0, 160), new: a.text.trim().slice(0, 160) });
        else out.removedAssertions.push({ file: d.from ?? d.file, line: r.line, text: r.text.trim().slice(0, 160) });
      });
      for (const l of h.lines) {
        if (l.type !== '+' || COMMENT_LINE.test(l.text)) continue;
        const skip = SKIP_MARKS.find(([, re]) => re.test(l.text));
        if (skip) out.skips.push({ file: d.file, line: l.line, mark: skip[0], text: l.text.trim().slice(0, 160) });
        const headLines = headLinesOf(d.file);
        const alias = aliasesOf(d.file, headLines);
        // 別名の代入の行(xfail = pytest.mark.xfail)は印の使用ではない。使用の側(@xfail)で、代入の式も合わせて strict を見る
        if (alias.assign.test(l.text)) continue;
        const xf = XFAIL_MARKS.find(([, re]) => re.test(l.text)) ?? pytestAliasMark(l.text, alias);
        if (!xf) continue;
        const from = Math.max(0, l.line - 1 - KNOWN_FAILURE_LOOKBACK);
        const near = headLines.slice(from, l.line).reverse().find((x) => KNOWN_FAILURE_NOTE.test(x)) ?? null;
        const problems = knownFailureProblems(near, today);
        out.xfails.push({ file: d.file, line: l.line, mark: xf[0], framework: xf[2], text: l.text.trim().slice(0, 160), note: near ? near.trim().slice(0, 200) : null, problems });
        // IMPL-0489: pytest は、予期せず通った場合に失敗にする strict を要する。Jest・Vitest は枠組みが予期せぬ通過を失敗にする
        if (xf[2] === 'pytest-marker') {
          // 別名(@xfail)は、使用の側の呼び出しに、代入の式(xfail = pytest.mark.xfail(strict=True))を足して見る
          const call = markCall(headLines, l.line) + (xf[3] ?? '');
          if (/\bstrict\s*=\s*False\b/.test(call)) out.strictErrors.push(`${d.file}:${l.line} の ${xf[0]} が strict=False を指定している(予期せず通っても失敗にならない)`);
          else if (!/\bstrict\s*=\s*True\b/.test(call) && !pytestStrict?.strict) {
            out.strictErrors.push(`${d.file}:${l.line} の ${xf[0]} に strict=True が無く、構成${pytestStrict ? `(${pytestStrict.file})` : '(pytest.ini・pyproject.toml・tox.ini・setup.cfg)'}にも xfail_strict = true が無い(予期せず通っても失敗にならない)`);
          }
        } else if (xf[2] === 'pytest-imperative') {
          out.strictErrors.push(`${d.file}:${l.line} の pytest.xfail( は、呼んだ時点で試験を xfail として終えるため、予期せず通ったことを検出できない(strict は効かない)。@pytest.mark.xfail(strict=True) で書く`);
        } else if (xf[2] === 'vitest' || xf[2] === 'jest') jsFails = true;
      }
    }
  }
  if (jsFails) out.notes.push('test.fails(Vitest)・test.failing(Jest)は、予期せず通ると枠組みが試験を失敗にするため、strict の検査をしない');
  // 期待値の改めの根拠(PR 本文の表)
  const table = expectationTableOf(body);
  const pairFiles = [...new Set(out.pairs.map((p) => p.file))];
  const rows = (table?.rows ?? []).map((r) => ({ ...r, file: tableFileOf(r.file), ...basisProblems(r.basis, { adrExists, specText }) }));
  const listed = new Set(rows.map((r) => r.file));
  out.expectation = { section: Boolean(table), rows, unlisted: pairFiles.filter((f) => !listed.has(f)) };
  return out;
}

/**
 * 実装計画の対象のパスと、変更されたパスの差(IMPL-0205)。specs: トレーラ Spec の [{ feature, task }]。
 * atPolicy: 既定ブランチの先端(--policy-base。無ければ基底)の本文、atHead: PR の先頭の本文。changed: 変更されたパス(名前の変更は前後とも)
 */
export function planPathTrace({ specs, atPolicy, atHead, changed, isTest, readTargets }) {
  const out = { tasks: [], notInBase: [], unreadable: [], columnChanges: [], outside: [], outsideTests: [], limit: PLAN_TRACE_LIMIT };
  const globs = [];
  const seenFeatures = new Set();
  for (const s of specs) {
    const file = `specs/${s.feature}/plan.md`;
    const base = readTargets(s.feature, { text: atPolicy(file) });
    const head = readTargets(s.feature, { text: atHead(file) });
    const t = base.tasks.find((x) => x.id === s.task);
    if (!base.plan) out.notInBase.push(`${s.feature} / ${s.task}(既定ブランチに ${file} が無い)`);
    else if (!base.column) out.unreadable.push(`${s.feature} の計画に「変更の対象パス」の列が無い`);
    else if (!t) out.notInBase.push(`${s.feature} / ${s.task}(既定ブランチの ${file} の表に無い)`);
    else if (t.unreadable) out.unreadable.push(`${s.feature} / ${s.task}: ${t.cell || '(空)'}`);
    else globs.push(...t.globs);
    if (t) out.tasks.push({ feature: s.feature, task: s.task, globs: t.globs });
    if (seenFeatures.has(s.feature)) continue;
    seenFeatures.add(s.feature);
    // 計画の対象パスの列そのものの変更(この PR が計画の範囲を広げていないか)
    const before = new Map(base.tasks.map((x) => [x.id, x.cell]));
    for (const x of head.tasks) {
      if (!before.has(x.id)) {
        if (base.plan) out.columnChanges.push({ feature: s.feature, task: x.id, before: null, after: x.cell });
      } else if (before.get(x.id) !== x.cell) out.columnChanges.push({ feature: s.feature, task: x.id, before: before.get(x.id), after: x.cell });
    }
    for (const [id, cell] of before) if (!head.tasks.some((x) => x.id === id)) out.columnChanges.push({ feature: s.feature, task: id, before: cell, after: null });
  }
  const inPlan = (f) => globs.some((g) => matchGlob(g, f));
  for (const f of [...new Set(changed)]) {
    if (inPlan(f)) continue;
    (isTest(f) ? out.outsideTests : out.outside).push(f);
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/[|`]/g, ' ').replace(/\s+/g, ' ').trim();

/** G-6 の材料(機械の検出の一覧)を Markdown にする。既存のテストの変更(IMPL-0203)に、検出の一覧を足したもの。合否には使わない */
export function renderG6Material(r) {
  const L = [renderTestChanges(r.testChanges ?? []), ''];
  const w = r.weakening;
  if (w) {
    L.push('### 検証を弱める変更の検出(G-6 の必須の確認事項。合否には使わない)', '');
    L.push(`- 新しいテストのファイル: ${w.newTestFiles.length ? w.newTestFiles.map((f) => `\`${esc(f)}\``).join(', ') : 'なし'}`);
    L.push(`- 追加行の skip・only・todo: ${w.skips.length} 件`);
    for (const s of w.skips.slice(0, 20)) L.push(`  - \`${esc(s.file)}:${s.line}\` ${s.mark}: \`${esc(s.text)}\``);
    L.push(`- 追加行の落ちることを期待する印: ${w.xfails.length} 件`);
    for (const x of w.xfails.slice(0, 20)) L.push(`  - \`${esc(x.file)}:${x.line}\` ${x.mark}${x.problems.length ? ` — 注釈: ${x.problems.join('、')}` : ` — 注釈: \`${esc(x.note)}\``}`);
    L.push(`- 削除行のアサーション(対の無いもの): ${w.removedAssertions.length} 件`);
    for (const a of w.removedAssertions.slice(0, 20)) L.push(`  - \`${esc(a.file)}:${a.line}\` \`${esc(a.text)}\``);
    L.push(`- 同じ塊の中の期待値の改め(旧 → 新): ${w.pairs.length} 件`);
    for (const p of w.pairs.slice(0, 20)) L.push(`  - \`${esc(p.file)}:${p.line}\` \`${esc(p.old)}\` → \`${esc(p.new)}\``);
    for (const n of w.notes) L.push(`- ${n}`);
    const e = w.expectation;
    L.push('', '#### 期待値の改めの根拠(PR 本文の `## 期待値の改め`)', '');
    if (!e.section) L.push(w.pairs.length ? '- PR 本文に `## 期待値の改め` の表が無い。上の改めの根拠(ADR・受入基準・条項)が示されていない' : '- PR 本文に `## 期待値の改め` の表は無い');
    for (const row of e.rows) L.push(`- \`${esc(row.file)}\`: 根拠 ${row.ids.length ? row.ids.join(', ') : '—'}${row.problems.length ? ` — **${row.problems.join('、')}**` : ''}${row.clausesUnresolved ? '(条項の番号は書式だけを見て、実在は確かめない)' : ''}`);
    if (e.unlisted.length) L.push(`- 表に無い改め: ${e.unlisted.map((f) => `\`${esc(f)}\``).join(', ')}`);
    L.push('- 機械が確かめるのは識別子の実在までで、引いた決定がその挙動を定めているかは確かめない', '', `> ${w.limit}`, '');
  }
  if (r.testOnly) {
    L.push('### 製品のコードを変えずに既存のテストを変えた変更(合否には使わない)', '');
    L.push(r.testOnly.detected ? `- 検出: 製品のコードの変更が無く、既存のテスト ${r.testOnly.files.map((f) => `\`${esc(f)}\``).join(', ')} を変えている` : '- 検出なし');
    L.push('', `> ${r.testOnly.limit}`, '');
  }
  const p = r.planTrace;
  if (p) {
    L.push('### 実装計画の対象のパスとの差(標準 第5章 5.8.6 要求事項10。合否には使わない)', '');
    if (p.skipped) L.push(`- ${p.skipped}`);
    else {
      L.push(`- 計画の対象パスに当たらない変更: ${p.outside.length ? p.outside.map((f) => `\`${esc(f)}\``).join(', ') : 'なし'}`);
      L.push(`- 計画の対象パスに当たらないテストのパス: ${p.outsideTests.length ? p.outsideTests.map((f) => `\`${esc(f)}\``).join(', ') : 'なし'}`);
      L.push(`- 計画の対象パスの列の変更: ${p.columnChanges.length ? p.columnChanges.map((c) => `${c.feature} / ${c.task}(${esc(c.before ?? '(無し)')} → ${esc(c.after ?? '(削除)')})`).join('、') : 'なし'}`);
      L.push(`- 既定ブランチの計画に無いタスク: ${p.notInBase.length ? p.notInBase.join('、') : 'なし'}`);
      L.push(`- 読めない升: ${p.unreadable.length ? p.unreadable.map(esc).join('、') : 'なし'}`);
      L.push('', `> ${p.limit}`);
    }
    L.push('');
  }
  const ia = r.instructionAssets;
  if (ia && ia.changed.length) {
    L.push('### 指示資産の変更(標準 第3章 3.11.5。木の図の検出は合否に使わない)', '');
    L.push(`- 上限: ${ia.maxLines === null ? '**上限未設定**(`.claude/guard.json` の `instructionAssetLimit.maxLinesPerFile`。値は組織が定める。未設定の間は判定せず、上限内とは記録しない)' : `1ファイル ${ia.maxLines} 行`}`);
    for (const s of ia.sizes) L.push(`  - \`${esc(s.file)}\`: ${s.lines} 行・${s.chars} 文字${ia.maxLines !== null && s.lines > ia.maxLines ? ' — **上限を超える**' : ''}`);
    L.push(`- ディレクトリの木の図の形: ${ia.treeForms.length} 件`);
    for (const t of ia.treeForms.slice(0, 20)) L.push(`  - \`${esc(t.file)}:${t.line}\` \`${esc(t.text)}\``);
    L.push('- 変更の承認: AI維持管理者本人の承認のレビュー(統制の設定の変更の承認と同じ数え方。陰性の確認は要らない)');
    L.push('', `> ${ia.limit}`, '');
  }
  return L.join('\n').trimEnd();
}

function renderReport(r) {
  const L = ['## G-5 PR の検査(check-pr)', ''];
  L.push(`- 失敗: ${r.errors.length} 件`);
  L.push(`- リスク区分: ${r.riskClass ?? '未記入'}`);
  for (const e of r.errors) L.push(`  - ${e}`);
  for (const w of r.warnings ?? []) L.push(`- 警告: ${w}`);
  for (const n of r.notices) L.push(`- ${n}`);
  if (r.size) {
    L.push(`- 変更規模(製品のコード。max(追加, 削除)の合計): ${r.size.lines} 行 / ${r.size.files} ファイル(基準値 ${r.size.maxLines ?? '—'} 行 / ${r.size.maxFiles ?? '—'} ファイル)${r.size.sizeOver ? ' **size:over**' : ''}`);
    if (r.size.test?.files) L.push(`- テスト・fixture・snapshot(別集計): ${r.size.test.lines} 行 / ${r.size.test.files} ファイル`);
    if (r.size.excluded.length) L.push(`- 算定から除いたもの: ${r.size.excluded.slice(0, 10).join(', ')}${r.size.excluded.length > 10 ? ` ほか ${r.size.excluded.length - 10} 件` : ''}`);
  }
  L.push('', renderG6Material(r));
  return L.join('\n');
}

/** 既存のテストの変更の一覧を PR のコメントへ出す。同じ印のコメントがあれば書き換える */
function upsertComment(markdown, prNumber) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !prNumber) return 'GITHUB_REPOSITORY または PR の番号が無い';
  const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  try {
    const ids = gh(['api', `repos/${repo}/issues/${prNumber}/comments`, '--paginate', '--jq', '.[] | select(.body | startswith("<!-- pit-in:g6-test-changes -->")) | .id']).split('\n').filter(Boolean);
    const payload = JSON.stringify({ body: markdown });
    if (ids.length) gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${ids[0]}`, '--input', '-'], payload);
    else gh(['api', '-X', 'POST', `repos/${repo}/issues/${prNumber}/comments`, '--input', '-'], payload);
    return null;
  } catch (e) {
    return String(e.stderr ?? e.message).split('\n')[0];
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/** 環境変数の JSON を読む。無い・読めない場合は null */
function parseJsonEnv(key) {
  const v = process.env[key];
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    warn(`${key} を JSON として読めません。停止の申し立ての検査は、読めない値を無いものとして扱います`);
    return null;
  }
}

if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
  const base = arg('--base', process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null);
  // 基準値・台帳を読む既定ブランチ。ワークフローは github.event.repository.default_branch を渡す。省くと --base から読む
  const policyBase = arg('--policy-base', null);
  if (!base) {
    fail('比較の起点(--base)を指定してください');
    process.exit(2);
  }
  const prFile = arg('--pr');
  const pr = prFile
    ? JSON.parse(fs.readFileSync(prFile, 'utf8'))
    : {
        number: process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : null,
        title: process.env.PR_TITLE ?? '',
        body: process.env.PR_BODY ?? '',
        author: process.env.PR_AUTHOR ?? '',
        // PR の作成者の数値の識別子(github.event.pull_request.user.id)。名簿の照合は識別子で行う(process-compass #430)
        authorId: numericAccountId(process.env.PR_AUTHOR_ID ?? null),
        // 停止の申し立て(第7章 7.11)。ラベルと、ラベルの付け外しの履歴(JSON)
        labels: parseJsonEnv('PR_LABELS') ?? [],
        labelEvents: parseJsonEnv('PR_LABEL_EVENTS'),
        // G-6 の承認者の数(検査8)。レビューの一覧(JSON)。無ければ「読めない」として出す
        reviews: parseJsonEnv('PR_REVIEWS') ?? undefined,
        // 効力を持つ記録の帰属(#380)。PR の先頭のコミットと、記録を入れた PR の作成者・承認者を引くリポジトリ
        head: process.env.PR_HEAD_SHA || undefined,
      };
  if (!pr.hosting && process.env.GITHUB_REPOSITORY && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) pr.hostingLookup = ghHosting(process.env.GITHUB_REPOSITORY);
  // 作成を指示した者の @アカウントを検査の時点に数値の識別子へ解決する(GH のトークンがある実行。ADR-0108 決定1)。--pr の JSON の accountIds が先
  if (!pr.accountIds && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) pr.accountLookup = ghUserLookup();
  // 基底から読む判定(gate-g5-base.yml): --head は PR の先頭を取得した参照(データとして読む)、--require-control-approval は
  // 統制の設定の変更の承認(3c)を照らす(process-compass #371 / ADR-0115)
  const head = arg('--head', null);
  if (head && pr.head) {
    const fetched = (() => {
      try {
        return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${head}^{commit}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        return '';
      }
    })();
    if (fetched !== pr.head) {
      fail(`取得した PR の先頭(${fetched.slice(0, 12) || '解決できない'})が、イベントの PR の先頭(${String(pr.head).slice(0, 12)})と一致しません。PR が更新されたため、最新の実行の結果を見る`);
      process.exit(1);
    }
  }
  const r = analyzePr({ base, policyBase, pr, head, requireControlApproval: argv.includes('--require-control-approval') });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const e of r.errors) fail(e);
    for (const w of r.warnings) warn(w);
    for (const n of r.notices) notice(n);
    if (r.testChanges.length) warn(`既存のテストの変更が ${r.testChanges.length} 件あります(G-6 の材料。合否には使わない)`);
    const w = r.weakening;
    if (w && w.skips.length + w.xfails.length + w.removedAssertions.length + w.pairs.length) {
      warn(`検証を弱める変更の検出: skip ${w.skips.length} / 落ちることを期待する印 ${w.xfails.length} / 削除行のアサーション ${w.removedAssertions.length} / 期待値の改め ${w.pairs.length}(G-6 の必須の確認事項。合否には使わない)`);
    }
  }
  const report = renderReport(r);
  const out = arg('--report');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, report + '\n');
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  if (argv.includes('--comment')) {
    // PR のコメントは閲覧の便宜。正本は既定ブランチのコードで計算するジョブ(gate-g5-base)の要約
    const why = upsertComment(renderG6Material(r), pr.number);
    if (why) warn(`既存のテストの変更の一覧を PR へ出せませんでした(${why})。ジョブの要約に出しています`);
  }
  process.exit(r.errors.length ? 1 : 0);
}
