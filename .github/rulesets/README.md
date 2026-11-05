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

### 必須チェック gate-g5-base(基底から読む判定)

既定ブランチの 4 本は、必須チェックに `gate-g5` と `gate-g5-base` の 2 つを置きます(process-compass #371 / ADR-0115)。

- `gate-g5`(`gate-g5.yml`)は `pull_request` で動き、定義も検査のスクリプトも PR の側から読まれます。同じ PR で集約・検査の一覧を書き換えた PR、同じ名前のジョブを足した PR でも通ります(2026-11-05 の実機の確認)
- `gate-g5-base`(`gate-g5-base.yml`)は `pull_request_target` で動き、PR 単位の検査を既定ブランチの判定のコードと構成で行います。PR のコードを checkout せず、差分と本文をデータとして読みます。統制の設定を変える PR には、AI維持管理者の席の責任者本人の承認のレビューを求めます(名簿の数値の識別子で照らします。本文の記名は数えません)
- 結果は、ジョブの結果(check run)で出ます。PR の側に同じ名前のジョブを足しても、`gate-g5-base` の失敗が残る限りマージは止まります。commit status で結果を出す形には替えないでください(PR の側のワークフローが後から上書きできます)
- 必須チェックの送り手(`integration_id`)を GitHub Actions に固定しても、PR の側のワークフローと区別されません。固定は適合の手段に数えません
- 作成者が唯一のコード所有者の1名の体制では、コード所有者のレビューは何も止めず、作成者本人の承認も拒否されます。この体制で AI維持管理者が自分で作成した PR は、承認が自己申告として出荷の証跡の集約に区別して出ます
- 既存の採用者がこのファイルを適用し直すまで、`gate-g5-base` は必須になりません。適用は人が行います(`gh api -X PUT repos/<owner>/<name>/rulesets/<id> --input .github/rulesets/<ファイル>`)。適用したかは `node scripts/gate/adoption-trial.mjs env-check --by <氏名>` の「基底から読む判定」の3値(満たす・満たさない・確かめていない)に出ます

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

#### 記録用ブランチが防がないことと、検出(process-compass #379 / ADR-0109)

記録用ブランチの規則が止めるのは、履歴の書き換え(force push)とブランチの削除だけです。**書き込みの権限を持つ者とジョブのトークン(`GITHUB_TOKEN`)は、新しいコミットで写しと様式を追加・変更・削除できます**。ジョブのトークンはどのワークフローにも同じ名義で出るため、書き込みを `record-copy.yml` に限れません。ホスティングの管理者(個人所有のリポジトリでは所有者)は、規則そのものを外せます。標準は置き場を「成立した記録を、記録を残さずには書き換えられない場所」と定め、書き込みの防止を課しません。

- 出荷の集約(`aggregate-evidence.mjs`)が記録用ブランチの履歴を走査し、`records/` の下の追加以外の変更(変更・削除・名前の変更)と、PR のマージより前に置かれた写しを、成立した記録の書き換えとして欠落に数えます(IMPL-0432)
- 出荷ごとに、集約が読んだ先頭を出荷の PR で `docs/records/heads/` へ残します。次の集約は、それが今の先頭の祖先であることを確かめます。規則を外していた間の履歴の書き換えは、祖先関係の破れとして出ます(IMPL-0433)
- `records-signed.json` を適用する構成(規制業・CL2 以上)では、署名をホスティングが検証していない書き込みを欠落に数えます(IMPL-0434)
- 写しの不変の欄(レビューの識別子・`user.id`・`commit_id`・`submitted_at`)は、ホスティングの記録を正として突き合わせます。写しにだけあるレビューは欠落です。ホスティングで照合できなかった写しでは G-6 を数えません(IMPL-0435)
- 訂正は、元の記録を指す訂正の記録を足す形に限ります。起きた書き換えは、例外承認でだけ受け入れます
- 書き込める主体を限れないことは、保証の開示の項目1 に構成ごとの定型の文で出し、外へ渡す開示にも載せます(IMPL-0439)。検出の件数が 0 であることは、書き換えを防いだことを示しません
- 置き場は改行の変換と整形の対象から外します(`.gitattributes`・`.prettierignore`。記録用ブランチの側は `record-copy.yml` が初期化のときに `.gitattributes` を置く)。AI の担い手による置き場の既にある記録の編集は、強制層のフック(`guard.json` の `appendOnlyPatterns`。記録用ブランチを作業木に取り出した `records/**`)が拒否します。フックは Write・Edit の道具だけに効き、Bash による編集は止めません(抑止の層)

### 署名を必須にする構成(`records-signed.json`)

`records-signed.json` を適用する構成では、`git push` のコミットは署名を持たないため止まります。この構成では、`record-copy.yml` と `ship-evidence.yml` が GitHub が署名する API 経由のコミット(GraphQL `createCommitOnBranch`)で書きます。経路の判定は、構成の回答だけから導きます。規制業(`q-quality` が `quality-regulated`)または安全重要度 CL2 以上(`q-criticality` が `cl2`・`cl3`)なら API 経由、それ以外は `git push` です(`scripts/gate/records.mjs` の `recordsSignatureRequired`)。集約の欠落(署名の無い書き込み)と保証の開示の文も同じ判定を使います。リポジトリの変数には頼りません(process-compass #379)。署名を要する構成では、`records-signed.json` を適用します。

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
| 承認者 | PR を開いた人以外の人(GitHub では PR の作成者は自分の PR を承認できない)。この承認は**転記の確認**であり、判定ではない。承認者は verify の結果を確かめる。G-7 の判定は `records/gates/` の様式で成立している。`safety.json`・`regulated.json` はコード所有者の承認を課すため、`docs/gates/` の所有者(既定は出荷判定者の席)が承認できるよう、出荷判定者以外の人が PR を開く |
| 検査 | PR の上で `ship-evidence` の verify ジョブが同じ集約を再実行し、複製が `records` ブランチと一致することを検査する。JSON は `pr`・`merge_commit_sha`・`head_sha` と `reviews[]` の `id`・`commit_id`・`submitted_at`・`user.id`・`body`、md は内容。不一致は失敗。記録の置き場の既存のファイルの変更・削除も失敗 |
| 起動 | **PR は出荷判定者が開きます**(実行の要約・成果物 `ship-pr` の URL から)。人が開いた PR では gate-g5 と verify が自動で起動します。`GITHUB_TOKEN` は既定の設定で PR を作れず(「GitHub Actions is not permitted to create or approve pull requests」)、作れる設定でも `GITHUB_TOKEN` で開いた PR は gate-g5 も verify も起動しません(GitHub の仕様)。再検査だけなら `ship-evidence` の手動実行(入力 `verify_pr` に PR の番号)で、結果は PR のコメントに出ます(ステータスチェックには付きません) |

「Allow GitHub Actions to create and approve pull requests」を有効にして機械に PR を開かせる形は採りません。この設定は機械の承認も許し、required approving review を `GITHUB_TOKEN` の承認で満たせる状態を作るためです(env-check の所見 approvalCounting)。個人のトークン(PAT)で PR を開く形も採りません。人の名義の操作を機械が行う形になるためです。

## 記録だけの PR に残る承認(転記の確認と帰属の確認)

GitHub のルールセットは、パス単位の免除を持ちません。`team.json`・`safety.json`・`regulated.json` を適用した既定ブランチでは、記録だけを足す PR(出荷の PR、後退経路で入れる停止の解除・例外承認の台帳)にも、承認 1 件(規制業は 2 件)が残ります。標準は基底ブランチへ入る記録を2つに分けます(第4章「判定記録を基底ブランチへ入れる操作」、ADR-0106)。

- **判定記録**(様式・写し・出荷の PR): 記名者以外の者の判定を課しません。残る承認(出荷の PR)は**転記の確認**で、承認者は verify の結果を確かめます(実装マーク IMPL-0124)。記録用ブランチへの様式の push(判定者本人の直接 push)には承認が残りません
- **効力を持つ記録**(例外承認の台帳の行・停止の解除の記録): 効力を持つ前に、記名者本人のアカウントの操作で帰属を裏づけます。既定の経路は、対象の PR の上の記名者本人のレビューです(記録だけの PR が要りません)。後退経路(対象が PR でない場合、認証情報を共有する体制)では、記録を入れる PR の承認者に記名者本人がいるか、記名者本人が作成者で記名者以外の人が承認すること(**帰属の確認**)を、G-5 と集約がホスティングの記録で確かめます(IMPL-0413・IMPL-0414)。手順は `.claude/skills/gate/reference/recording.md`「効力を持つ記録の届け方」にあります
- 残る承認 1 件は、名前を借りる経路(判定される側が「承認した者: 他の人」と書いた行の PR を開き、無関係の人が承認する)を塞ぎません。塞いでいるのは G-5 と集約の帰属の照合です。**承認の要件を外して効力を持つ記録を入れる構成**(パス単位の免除、bypass actor、検査を掛けない別ブランチへの移設)を採りません
- 既定ブランチのルールセットに bypass actor を置きません。承認の件数を 0 にして、パス条件で足し戻す構成(`required_reviewers`)も既定にしません(`scripts/gate/test-material-attribution.mjs` が雛形を確かめる。IMPL-0416)
- 記録の置き場(`docs/gates/**`・`docs/records/**`・`records/**`)の所有者は `CODEOWNERS` で記名者の席へ割り当てます。これは誘導層です。所有者の誰か 1 人で足り、bypass actor を素通りさせるため、**遮断に数えません**

## 適用のしかた

```bash
gh api repos/{owner}/{repo}/rulesets --input .github/rulesets/team.json
```

記録用ブランチのルールセットも、同じ形で適用します(規制業・CL2 以上は `records-signed.json`。ワークフローは構成の回答から署名の要否を導く)。ブランチ `records` 自体は、最初のマージで `record-copy.yml` が作ります。ルールセットはブランチが無くても適用できますが、`records-signed.json` は初期化の後に適用します(前掲「記録用ブランチの初期化」)。

```bash
gh api repos/{owner}/{repo}/rulesets --input .github/rulesets/records.json
```

適用の後は、`node scripts/gate/adoption-trial.mjs env-check --by <氏名>` の所見(`findings`)で、記録用ブランチの保護(`non_fast_forward`・`deletion`、bypass actor なし)、`record-copy.yml` の直近の実行、写しの到着、既定ブランチの bypass actor を確かめられます。所見は記録(`docs/adoption-trial/env-check.json`)に残り、一致しない所見(保護の欠落、bypass actor)は `/pit` の注記と出荷の集約の項目4 の表に出続けます(確認済みの判定には入れず、欠落にもしません)。

記録の置き場の `CODEOWNERS` の行(席ごと)は、`/process-init` が `PROCESS-PROFILE.md` の「記録の置き場の所有者(CODEOWNERS の案)」に、席の責任者のアカウント(人の名簿 `people[].accounts`)から起こします。人がその案を `.github/CODEOWNERS` へ写します(`/process-init` は `CODEOWNERS` を書き換えません)。

適用済みのルールセットを確認します。

```bash
gh api repos/{owner}/{repo}/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
```

私有リポジトリでルールセットを使えないプラン(2026-10 時点の無料のプラン)では、記録用ブランチも保護できません。その構成では、写しと判定記録の履歴の書き換えも止められず、記録の日時は自己申告になります。出荷の集約は、新しいコミットによる書き換えを履歴の走査で、履歴の書き換えを前回の出荷で残した先頭(`docs/records/heads/`)との祖先関係の破れで検出します。最初の出荷より前に履歴を書き換えた場合は、検出できません(テンプレートの README「ブランチ保護を適用する」)。ルールセットを適用した構成でも、書き込める主体は限れません(前掲「記録用ブランチが防がないことと、検出」)。

## なぜここに置くか

指示ファイルへ「作成者は自分の PR を承認しない」と書いても、遵守は保証されません。**強制層(ホスティングの設定)に置いた項目だけが、遮断できたものとして数えられます**。

`require_last_push_approval: true` が要点です。これがないと、承認を得たあとに自分で push して内容を変えられます。
