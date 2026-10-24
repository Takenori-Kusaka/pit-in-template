# ブランチ保護

`process.config.json` の `ruleset` が、適用するファイルを指します。

| ファイル | 適用する場面 | 承認数 | 署名 |
| --- | --- | --- | --- |
| `team.json` | 独立レビュー(G-6)を適用する構成。標準品質 | 1 | 任意 |
| `safety.json` | 独立レビュー(G-6)を適用する構成のうち、安全重要度 CL2 で、承認者が1名の構成(標準 第8章 軸E)。承認の数のほかは `regulated.json` と同じ | 1 | 必須 |
| `regulated.json` | 独立レビュー(G-6)を適用する構成のうち、承認者2名を要する構成(規制業、安全重要度 CL3) | 2 | 必須 |
| `checks-only.json` | 上の3つを使わない構成(独立レビュー(G-6)が未達・簡略化・適用しない構成)。`process.config.json` の `ruleset` は `null` のまま | — | 任意 |

どのファイルを使うかは、人数ではなく、独立レビュー(G-6)の状態で決まります。強制する承認の数は、構成の承認者の数(`review.reviewerCount`)と同じです。

| 体制 | 独立レビュー(G-6) | ルールセット |
| --- | --- | --- |
| 3名以上 | 適用する | `team.json`、`safety.json` または `regulated.json` |
| 2名。作成を指示していない側の人が確認する(相互の確認) | 適用する | `team.json` |
| 1名。外部の確認者を置いた | 適用する | `team.json` |
| 1〜2名。作成を指示した本人以外の確認者を、人の名簿と席から確かめられない(席が未記入の間を含む) | **未達** | `checks-only.json`(必須チェックだけ) |

未達の構成では、承認を強制するルールセットを置きません。作成者の自己承認を止める設定は、承認者が別に存在して初めて意味を持つためです。代わりに、必須チェック(gate-g5)だけを持つ `checks-only.json` を適用します(#286)。G-5 が落ちた変更のマージを止めるのは、人数によらず必要だからです。この場合、独立レビュー(G-6)は**未達**として `PROCESS-PROFILE.md` に残ります。事業ステージの規則で独立レビューを簡略化する構成と、適用しない構成でも、承認を強制するルールセットは置かず、`checks-only.json` を適用します。

`checks-only.json` は既定ブランチへの直接の push も止めます(必須チェックを経た変更だけを受け付けるため)。1名でも PR を経て取り込む運用になります。私有リポジトリでルールセットを使えないプランでは、出荷判定(G-7)の証跡の集約が、gate-g5 の成功を持たない PR を事後に欠落として検出するだけになります(テンプレートの README「ブランチ保護を適用する」)。

体制が変わってルールセットが変わるときは、`/process-change` の残作業に、適用するコマンドが出ます。適用と解除は人が行います。

## 記録用ブランチ

上の 4 本は既定ブランチだけを対象にします。これに加えて、承認レビューの写しと判定記録の置き場として、ブランチ `records`(記録用ブランチ)を 1 本持ちます。記録用ブランチには、既定ブランチとは別のルールセットを適用します。

| ファイル | 適用する場面 | 置く規則 |
| --- | --- | --- |
| `records.json` | 記録用ブランチを使う構成の既定 | `non_fast_forward`、`deletion` |
| `records-signed.json` | 規制業(第8章 軸C)と安全重要度 CL2 以上(軸E)の構成。`records.json` の代わりに適用する | 上の 2 つに `required_signatures` を足す |

- `pull_request` と `required_status_checks` は置きません。記録だけのコミットに、記名者以外の承認を課さないためです(標準 第4章「判定の成立」、第5章 CI/CD ゲート構成)。履歴は追記だけになり、既存の記録の書き換え(force push)と削除は止まります
- **既定ブランチのルールセットは変えません。bypass actor を足しません。`exempt` を使いません**。写しを置くために既定ブランチの強制層を縮小する構成(Bot の bypass)は採りません。強制層の縮小(ADR-0038)であり、「App の名義の変更は人の承認を経ない」と開示してしか成立しないためです
- 記録用ブランチへ書くのは、マージを契機に走るワークフロー `record-copy.yml`(承認レビューの写し `records/reviews/pr-<番号>.json`。`GITHUB_TOKEN` の `contents: write` で足り、App の鍵を要しません)と、判定者本人(様式 `records/gates/<ゲート>-<対象>-<日付>.md`。直接 push する。PR も他者の承認も要らない。`.claude/skills/gate/reference/recording.md`「様式の届け方」)です
- 記録用ブランチの内容を基底ブランチへ入れるのは、遅くとも出荷判定(G-7)です。`ship-evidence.yml` が出荷のブランチ `ship/<日付>` を 1 本 push し、`records/reviews/` を `docs/records/reviews/` へ、`records/gates/` を `docs/gates/` へ複製します。PR を開くのは出荷判定者です(下記「出荷の PR」)。入れる操作に、記名者(出荷判定者)以外の承認を課しません

### 署名を必須にする構成(`records-signed.json`)と変数 `RECORDS_SIGNED`

`records-signed.json` を適用する構成では、`git push` のコミットは署名を持たないため止まります。この構成では、`record-copy.yml` と `ship-evidence.yml` が GitHub が署名する API 経由のコミット(GraphQL `createCommitOnBranch`)で書きます。経路の判定は次のとおりです。

1. 構成 `process.config.json` に `records.signed`(真偽値)があればその値。2026-10-23 時点で `/process-init` はこの値を書きません(将来の `/process-change` の入力)
2. 無ければ、リポジトリの変数 **`RECORDS_SIGNED`**(Settings > Secrets and variables > Actions > Variables)が `true` のとき API 経由、それ以外は `git push`

```bash
gh variable set RECORDS_SIGNED --body true     # records-signed.json を適用する構成で設定する
```

- `ship-evidence.yml` は、既定ブランチのルールセットが `safety.json` / `regulated.json`(署名を必須にする)の構成でも API 経由で書きます(出荷の PR のコミットが既定ブランチの署名の規則で止まらないため)
- **`createCommitOnBranch` と `required_signatures` の組は、2026-10-23 時点で実機で確かめていません**(E0)。初回のマージと初回の出荷で、Actions の実行の記録を確かめてください
- 判定者本人が様式を push するときは、`git commit -S`(署名の設定は各自の端末)で push します

#### 記録用ブランチの初期化

`records` ブランチは、最初のマージで `record-copy.yml` が履歴を持たない(orphan)ブランチとして作ります。`createCommitOnBranch` はブランチの現在の先頭(`expectedHeadOid`)を要するため、ブランチが無い状態では使えません。署名を必須にする構成では、初期コミット(`git push`。署名なし)が `required_signatures` で止まるため、`record-copy.yml` は理由を出して失敗します。次のいずれかで初期化します。

- `records-signed.json` を適用する**前に**最初のマージを 1 回通す(初期コミットは署名なしで入る。その後にルールセットを適用する)
- 人が署名コミットで作る

```bash
git checkout --orphan records && git rm -rf --quiet .
printf '# 記録用ブランチ\n' > README.md && git add README.md
git commit -S -m "chore: 記録用ブランチを初期化する" && git push origin records
```

初期化の後、失敗した `record-copy.yml` の実行を再実行すると、その PR の写しが置かれます。

## 出荷の PR(記録を基底ブランチへ入れる)

`ship-evidence.yml` は、タグの push(または手動実行)で証跡を集約した後、出荷のブランチを push し、PR を開く URL(題名と本文を入力済み)を出します。PR を開くのは出荷判定者(人)です。

| 項目 | 内容 |
| --- | --- |
| ブランチ | `ship/<日付>`(同じ日に 2 回目があれば `ship/<日付>-<実行番号>`) |
| 中身 | `records/reviews/*.json` → `docs/records/reviews/`、`records/gates/*.md` → `docs/gates/`(追加だけ。基底ブランチに既にあるファイルは上書きしない)。品質レポート(保証の開示を含む)→ `docs/evidence/<日付>-<範囲>.md` |
| 承認者 | **出荷判定者本人**(`CODEOWNERS` の `docs/gates/`・`docs/records/` の所有者)。記名者以外の承認が付く体制では、その承認は取り込みの事務 |
| 検査 | PR の上で `ship-evidence` の verify ジョブが同じ集約を再実行し、複製が `records` ブランチと一致することを検査する。JSON は `pr`・`merge_commit_sha`・`head_sha` と `reviews[]` の `id`・`commit_id`・`submitted_at`・`user.id`・`body`、md は内容。不一致は失敗。記録の置き場の既存のファイルの変更・削除も失敗 |
| 起動 | **PR は出荷判定者が開きます**(実行の要約・成果物 `ship-pr` の URL から)。人が開いた PR では gate-g5 と verify が自動で起動します。`GITHUB_TOKEN` は既定の設定で PR を作れず(「GitHub Actions is not permitted to create or approve pull requests」)、作れる設定でも `GITHUB_TOKEN` で開いた PR は gate-g5 も verify も起動しません(GitHub の仕様)。再検査だけなら `ship-evidence` の手動実行(入力 `verify_pr` に PR の番号)で、結果は PR のコメントに出ます(ステータスチェックには付きません) |

「Allow GitHub Actions to create and approve pull requests」を有効にして機械に PR を開かせる形は採りません。この設定は機械の承認も許し、required approving review を `GITHUB_TOKEN` の承認で満たせる状態を作るためです(env-check の所見 approvalCounting)。個人のトークン(PAT)で PR を開く形も採りません。人の名義の操作を機械が行う形になるためです。

## 記録だけの PR にも承認 1 件が残る(降りていない規定)

GitHub のルールセットは、パス単位の免除を持ちません。`team.json`・`safety.json`・`regulated.json` を適用した既定ブランチでは、記録だけを足す PR(出荷の PR、停止の解除・例外承認の台帳)にも、承認 1 件(規制業は 2 件)が残ります。

- 標準は「判定記録だけのコミットを基底ブランチへ入れる操作に、記名者以外の承認を課さない」と定めています(第4章「判定の成立」。実装マーク IMPL-0124、`state=undelivered`)。この規定は、GitHub の強制層へ降りていません。**降りていない規定として、消さずに表示し続けます**(未達のゲートと同じ扱い)
- 記録用ブランチへの様式の push(判定者本人の直接 push)には承認が残りません。残るのは基底ブランチへ入れる PR だけです
- 残る承認の承認者は、**記名者本人**です(出荷の PR は出荷判定者。例外承認の台帳・停止の解除は記名者)。手順は `.claude/skills/gate/reference/recording.md`「記録だけの PR の届け方」にあります。草案の文脈(AI の担い手)が push と PR を担い、記名者は push せず承認だけを行います。`require_last_push_approval` の下では、記名者が push すると自分では承認できなくなるためです
- 記名者と同じアカウントで AI の担い手が push する体制(認証情報を共有する体制)や、承認者 2 名の構成では、記名者以外の承認が付きます。**その承認は、ファイルの取り込みの事務であり、判定ではありません**。承認者は記録の中身を判定していません。記録は記名者の記名で成立しています(標準 第4章)
- 記録の置き場(`docs/gates/**`・`docs/records/**`・`records/**`)の所有者は `CODEOWNERS` で記名者の席へ割り当てます。これは誘導層です。所有者の誰か 1 人で足り、bypass actor を素通りさせるため、**遮断に数えません**

## 適用のしかた

```bash
gh api repos/{owner}/{repo}/rulesets --input .github/rulesets/team.json
```

記録用ブランチのルールセットも、同じ形で適用します(規制業・CL2 以上は `records-signed.json`。あわせて変数 `RECORDS_SIGNED` を `true` にする)。ブランチ `records` 自体は、最初のマージで `record-copy.yml` が作ります。ルールセットはブランチが無くても適用できますが、`records-signed.json` は初期化の後に適用します(前掲「記録用ブランチの初期化」)。

```bash
gh api repos/{owner}/{repo}/rulesets --input .github/rulesets/records.json
```

適用の後は、`node scripts/gate/adoption-trial.mjs env-check --by <氏名>` の所見(`findings`)で、記録用ブランチの保護(`non_fast_forward`・`deletion`、bypass actor なし)、`record-copy.yml` の直近の実行、写しの到着、既定ブランチの bypass actor を確かめられます。所見は記録(`docs/adoption-trial/env-check.json`)に残り、一致しない所見(保護の欠落、bypass actor)は `/pit` の注記と出荷の集約の項目4 の表に出続けます(確認済みの判定には入れず、欠落にもしません)。

記録の置き場の `CODEOWNERS` の行(席ごと)は、`/process-init` が `PROCESS-PROFILE.md` の「記録の置き場の所有者(CODEOWNERS の案)」に、席の責任者のアカウント(人の名簿 `people[].accounts`)から起こします。人がその案を `.github/CODEOWNERS` へ写します(`/process-init` は `CODEOWNERS` を書き換えません)。

適用済みのルールセットを確認します。

```bash
gh api repos/{owner}/{repo}/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
```

私有リポジトリでルールセットを使えないプラン(2026-10 時点の無料のプラン)では、記録用ブランチも保護できません。その構成では、写しと判定記録の書き換えを止められず、記録の日時は自己申告になります。出荷の PR の verify ジョブは `records` ブランチと複製の一致を検査しますが、`records` ブランチ自体の書き換えは検出できません(テンプレートの README「ブランチ保護を適用する」)。

## なぜここに置くか

指示ファイルへ「作成者は自分の PR を承認しない」と書いても、遵守は保証されません。**強制層(ホスティングの設定)に置いた項目だけが、遮断できたものとして数えられます**。

`require_last_push_approval: true` が要点です。これがないと、承認を得たあとに自分で push して内容を変えられます。
