---
name: process-init
description: このプロジェクトのプロセス構成を対話で決め、PROCESS-PROFILE.md と process.config.json を生成する。チーム規模・事業ステージ・品質要求・安全重要度・開発形態など8問(1〜2名のときだけ聞く1問を含む)を聞き、有効なゲート・成果物・ブランチ保護を導出する。テンプレートから作った直後に実行する。体制やステージが変わったときは process-change を使う。
---

# プロセス構成の初期化

このプロジェクトで**どのゲートを通すか**を決めます。決まっていない状態で実装を始めると、完了の条件が定まりません。

## 手順

### 1. 現在の状態を確認する

`process.config.json` の `configured` を見ます。

- `false` → 初回。そのまま手順2へ
- `true` → 設定済み。**このスキルで作り直さず、`/process-change` を使う**

体制・運用形態・AI の担い手・軸の入力が変わったときは、体制の変化点として `/process-change` で反映します(標準 第3章 3.13 / 第8章「再テーラリングの契機」)。全問を聞き直す再実行では、何が失効し、何が新たに生じたかを特定できず、変化点の記録も残りません。設定済みの構成に対して回答を変えて `generate-profile.mjs` を実行すると、スクリプトが拒否します。

### 2. 設問を聞く(8問)

`scripts/vendor/tailoring-kb.json` の `questions` にある文言をそのまま使ってください。**専門用語で聞き直さないでください**。設問と選択肢は標準側で言葉を選んであります。

聞く順序と、専門用語を使わない言い換え:

| # | 質問 ID | 内容 | 言い換え(設問の文言に添えて示す) |
| --- | --- | --- | --- |
| 1 | `q-team-size` | 開発に関わる人数 | 作る・確かめる・決める人を、あなたを含めて何人で分担するか |
| 2 | `q-biz-phase` | プロダクトの段階 | 捨てる前提で試している / 最初のお客さんに使ってもらう / 使う人を増やしている / 落ち着いて動かし続けている、のどれに近いか |
| 3 | `q-quality` | 品質への要求 | 止まったとき、困るのが自分たちだけか、社会やお金の流れまで及ぶか、監査や役所への説明が要るか |
| 4 | `q-criticality` | 最悪の場合に何が起きるか | いちばん悪い壊れ方をしたとき、損をするのはお金や仕事の時間だけか、人の権利や暮らしか、けがや命か |
| 5 | `q-dev-form` | 開発の形態 | 自分たちで作るか、よそへ頼むか、よそから頼まれて作るか |
| 6 | `q-external-reviewer` | **1〜2名を選んだ場合のみ**。作成を指示した本人以外に、確認できる人がいるか(2名体制の相手を含む) | AI に作らせた変更を、頼んだ本人とは別の人が見て確かめられるか |
| 7 | `q-existing-gates` | 社内に既存の承認ゲートはあるか | 会社の決まりで、先へ進む前に誰かの承認(はんこ)をもらう場面がすでにあるか |
| 8 | `q-ai-constraint` | AI 利用の制約 | 会社の決まりで、使ってよい AI が限られているか、使えないか |

質問6は `q-team-size` が `size-1-2` のときだけ表示します(`appliesWhen`)。他の質問は常に聞きます。

**AskUserQuestion を使って一度に複数の質問を出してよい**ですが、選択肢の文言は `questions` の `label` をそのまま使ってください。`note` があれば説明として添えます。上の表の言い換えは、設問の文言を置き換えずに、括弧書きで併記します。

質問4(安全重要度)は、技術的な難しさやチーム規模ではなく、**想定できる最悪の故障が起きたときの帰結**で選ぶものだと明示してください。ここを取り違えると構成全体がずれます。

### 3. 使う言語のアダプタを聞く

`adapters/` にあるものから選ばせます。

| id | 対象 |
| --- | --- |
| `node` | Node.js / TypeScript |
| `python` | Python |
| `go` | Go |
| `none` | 上記以外。コマンドを自分で書く |
| `undetermined` | まだ決まっていない。S0 探索の完了(SG-0)までに確定させる |

`undetermined` を選んだ場合、S0 探索の完了（SG-0を通過する）までにスタックを確定し、アダプタを切り替える（後述の手続）必要があります。
`none` を選んだ場合、**あとで `adapters/none.json` にテストの実行コマンドを書く必要がある**ことを伝えてください。空のままでは G-5 が失敗します。検査を実施していない状態を通過した記録として残さないための設計です。

### 4. 案件 ID を聞く

既定は `P-001` です。既存の管理体系があればそれに合わせます。

### 5. 生成する

回答を JSON ファイルへ書き、スクリプトを実行します。

```bash
cat > /tmp/answers.json <<'JSON'
{
  "q-team-size": "size-1-2",
  "q-biz-phase": "poc",
  "q-quality": "quality-standard",
  "q-criticality": "cl0",
  "q-dev-form": "inhouse",
  "q-external-reviewer": "reviewer-no",
  "q-existing-gates": "gates-none",
  "q-ai-constraint": "ai-free"
}
JSON

node scripts/init/generate-profile.mjs --answers /tmp/answers.json --stack node --project-id P-001
```

不変条件に反する回答(1〜2名で CL1 以上、1〜2名で規制業など)は、スクリプトが理由つきで拒否します。**拒否されたら回答を勝手に変えないでください**。利用者へ理由を伝え、体制を確保するか対象を外すかを選んでもらいます。

生成物は3つです。`PROCESS-PROFILE.md`、`process.config.json`、そして **`CLAUDE.md` のマーカー区間**(`<!-- generated:process-rules -->`)です。あわせて、初回の G-5 を通す**開発の基盤**を、無いファイルだけ作ります(既存のファイルは書き換えません。出力の `[開発の基盤]`)。区間には構成の要約(体制、有効なゲート、出荷できない状態、未達・逸脱、運用形態、委任の範囲、席の責任者の記入状況)と、自分のロールを確かめるコマンド(`node scripts/gate/next.mjs --role <ロール>`)が入ります。ロールごとの判定ゲート・担ってはならない工程・受信箱のラベルは、そのコマンドが構成から出します。

構成には、人の名簿(`people[]`)、席ごとの責任者と運用形態(`seats[]`)、委任の範囲(`delegation`)、D-0 表1 の2行の決定者の席(`governance`)、体制の変化点の記録(`changeLog[]`)が入ります。初期値は、名簿が空、責任者が未記入、運用形態が協働(事業決裁者と AI運用担当者は人確定)、委任なしです。**名簿(氏名とリポジトリ上のアカウント)と責任者の氏名は、人が決めます**。`/process-change`(種別 `accountable`)で構成へ反映します。D-0 体制図の責任者の表・担い手と運用形態・改訂履歴は、構成から生成されます。体制図と構成へ、同じ内容を二重に書く必要はありません。1人で全部の席を兼ねる場合も、同じ手順で全席へ同じ氏名を書きます(成立しない兼務禁止は、1名の体制では逸脱として記録されます。2名の体制で、相手がいるのに同じ人が兼ねる場合は、決定した者の記名と理由を要します)。

**席の責任者の記入は任免(決定)です**(標準 第3章 3.13.3)。全席が未記入の状態からの記入は、次のいずれかで出します。記名の欄を推測で埋めないでください。

| 経路 | 初回の記入 |
| --- | --- |
| 既定 | 名簿と全席を1回の変化点(種別 `accountable`)で出す。記名(`decidedBy`)と理由(`reason`)は、その変化点で D-0 表1「体制と運用形態」の決定者の席(既定は事業決裁者)に記入する人のものに限る。体制の人数に依らない |
| 任命権者による | 組織上の任命権者(D-0 体制図へ体制の外の人として記載する人。名簿へ `external: true` と `appointer: true`)を含む名簿を先に記入し、次の変化点で、任命権者の記名で席を埋める。同じ変化点で足した任命権者は記名できない |

人が全員離脱して全席が空いた状態は、初回の記入に当たりません(組織上の任命権者の記名に限る)。

`/process-change` を使う前に、D-0 体制図(`docs/D-0-governance.md`)を `templates/00-d0-governance.md` から作ります。**D-0 が無い状態では、体制の変化点は適用されません**。**区間の中を手で編集しないでください**。`scripts/gate/check-process-rules.mjs` が乖離を検出して失敗します。

**生成した `process.config.json` を、手で編集しないでください**。初期化の後、構成を書き換える経路は `/process-change` だけです。変化点の記録(`changeLog[]`)は、適用後の構成の要約値を持ちます。手で書き換えた構成は要約値と一致しなくなり、契約検査(`verify-gate-contract`)が失敗します。回答ファイルからの再生成も、構成を変えない場合にしか通りません。

カバレッジの下限は、標準の導出値から始まります(雛形の値を引き継ぎません)。未達の代償措置として CI を強める構成では、導出値が上がります。

開発の基盤(#286)はスタックごとに次のとおりです。初期化の直後に `node scripts/gate/g5-local.mjs` を実行すると、CI(gate-g5)と同じ範囲の検査を手元で確かめられます。

| スタック | 作るもの | 初期化の出力が列挙するもの(作らない) |
| --- | --- | --- |
| `node` | `package.json`(`test` と `coverage` のスクリプト、`c8` の固定の版)、`.secretlintrc.json`、`tests/README.md` | `npm install` でロックファイルを作る手順。製品のコードは `src/` へ置く |
| `python` / `go` | `.secretlintrc.json` | `pyproject.toml` とテスト(python)、`go.mod` と検査の道具(go) |
| `none` | なし | `adapters/none.json` のコマンド |
| `undetermined` | なし | スタックを確定した後の手順(`--scaffold` で基盤だけを作れる) |

スタックを `/process-change` で確定・変更した後は、`node scripts/init/generate-profile.mjs --scaffold` で基盤だけを作ります(構成は書き換えません)。

### 6. 生成物を確認して伝える

生成後、次を必ず利用者へ伝えてください。

1. **未達のゲートがあるか**。ある場合は理由と、埋める方法を提示する
2. **代償措置つきの逸脱があるか**。ある場合は、代償措置を満たすことが運用の条件だと伝える
3. どのゲートが省略されたか、その理由
4. カバレッジの下限は初期値であり、実測に基づく値ではないこと
5. **スタックが未確定（undetermined）であるかどうか**。未確定の場合、**SG-0を通過するまでに確定させる必要があること（確定期限）**を伝える
6. 開発の基盤。`[開発の基盤]` の行(作ったもの・作らなかったもの・続けて行う手順)をそのまま示す
7. 次にやること。生成の出力の末尾に、`next.mjs` が導いた次の一手が出ます。それをそのまま示します

### 7. 構成に応じて後片付けをする

`process.config.json` を読み、次を行います。

| 条件 | 操作 |
| --- | --- |
| `gates.g7.state === 'omitted'` | `.github/workflows/ship-evidence.yml` を削除してよいか確認する |
| `aiReview.enabled === false` | `.github/workflows/ai-review.yml` を削除する |
| `ruleset` が `null` でない | ブランチ保護(`.github/rulesets/<ruleset>.json`)の適用コマンドを提示する(実行はしない) |
| `ruleset` が `null` | 必須チェック(gate-g5)だけのルールセット(`.github/rulesets/checks-only.json`)の適用コマンドを提示する(実行はしない)。私有リポジトリでルールセットを使えないプランでは、事後の検出(出荷判定の証跡の集約)だけになることを伝える |
| 常に | スカッシュのコミットのメッセージを「PR の題名と本文」にする設定のコマンドを提示する(実行はしない)。PR の様式の末尾の段落が、コミットのトレーラとして残る |
| 常に | `context/projects/<案件ID>.md` を、`context/projects/README.md` の「書くこと」の見出し(案件の目的・いま作っているもの・暗黙の前提・決まっていないこと・直近の判断)で作る。**企画書ではない**。企画書の様式(`templates/06-project-brief.md`)をここへ写さない。企画書の置き場は `docs/project-brief.md` の1か所だけで、作るのは `next.mjs` が案内したとき(D-0 の承認の後)。「案件の目的」の欄は、企画書ができた後に `docs/project-brief.md` へのリンクと1〜3段落の要約を書く |

ブランチ保護の適用は利用者の操作です。エージェントが実行してはなりません。

```bash
gh api repos/{owner}/{repo}/rulesets --input .github/rulesets/team.json          # ruleset が team の場合
gh api repos/{owner}/{repo}/rulesets --input .github/rulesets/checks-only.json   # ruleset が null の場合
gh api -X PATCH repos/{owner}/{repo} -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
```

初期化の出力の `[ブランチ保護]` の行が、どちらを適用するかを示します。理由と、ルールセットを使えない場合の扱いは README の「ブランチ保護を適用する」にあります。

### 8. 最初のコミット(PR を経る)

生成物と開発の基盤を、**ブランチを切って PR で main へ入れます**。main へ直接コミットしません。プロセス構成は成果物であり、強制層(`.claude/guard.json`・`.claude/settings.json`)の初期値と席の構成を含むためです。

PR にする理由(#286): このスクリプトは強制層と `templates/06-project-brief.md` も書き換えるため、このコミットは「記録だけのコミット」に当たりません。独立レビュー(G-6)を適用する体制(3名以上、または作成を指示した本人以外の確認者がいる体制)では、PR を経ないコミットは、G-6 の判定記録か例外承認が対応づかない限り、出荷判定の証跡で欠落になります。初期化のコミットを集約の対象から外す方式は採りません。初期化が書くファイルの中身(強制層の初期値)を、作成を指示した本人以外が確かめる機会を残すためです。G-6 を適用しない体制でも同じ経路にします(G-5 が初期化の構成と基盤を CI で検査します)。

```bash
git switch -c chore/process-init
npm install                                   # node の場合。package-lock.json を作り、同じ PR に含める
node scripts/gate/g5-local.mjs                # CI と同じ範囲の G-5 を手元で確かめる
git add -A && git commit                      # メッセージは下の例
git push -u origin chore/process-init         # PR を作る。本文は PR の様式に従う
```

PR の本文の末尾の段落(トレーラ)に `Spec: setup` を書きます。初期化の PR は、構成・強制層・基盤のファイルだけで製品のコードを含まないため、仕様とタスクを指しません(G-5 の `pr-rules` は、変更が基盤のファイルだけに収まる場合に限り `Spec: setup` を受け付けます)。

```
chore: プロセス構成を初期化する

- ピットイン方式のテーラリング(軸A〜E)を適用
- PROCESS-PROFILE.md / process.config.json / CLAUDE.md の構成依存部分と、開発の基盤を生成

Spec: setup
Co-Authored-By: <モデルの名称と版>
```

PR の「リスク区分」は利用者が決めます(強制層の初期化であり、AI が区分を低く書いてはなりません)。区分を1つだけ残さない本文は、G-5 の `pr-rules` が失敗させます(`Spec: setup` の PR も対象)。構成の初期化より前のコミット(テンプレート由来の初期コミットなど)は、証跡の集約で対象外(pre-init)として件数だけが表示されます。

GitHub を使わず PR を作れない場合に限り、PR を経ずにコミットします。このときはトレーラ `Risk` と `Verification`(`verify-gate-contract` と `check-process-rules` の結果)を書きます。G-6 を適用する体制では、それでも出荷判定の証跡で欠落になるため、G-6 の判定記録(対象にコミットの識別子)を残します。

### 9. 次の一手を示す

```bash
node scripts/gate/next.mjs
```

出力された次の一手を利用者へ示します。「人の判断待ち」が出たら、コマンドを実行せず、待つ席へ受信箱のラベルで渡します。

## 技術スタックの確定・変更手続

開発技術スタックを確定・変更する場合は、プロセス構成の再生成（`/process-init` の全ステップの再実行）ではなく、以下の手順で行います。技術選定は重要な意思決定のため、**ADR (Architecture Decision Record) の作成を伴います**。

**`process.config.json` を直接編集しません**。構成を書き換える経路は `/process-change` だけです。手で編集した構成と、引数(`--stack`)で値を変える再生成は、拒否されます。

1. **意思決定の記録**: `/adr-write` を実行し、採用した技術スタックと選定理由、比較検討した選択肢（採らなかった選択肢）を `context/decisions/` へ記録します。
2. **構成への反映**: `/process-change` の種別 `settings` で、決定したスタック（`node`, `python`, `go`, `none` のいずれか）を反映します。変更は `changeLog[]` へ記録されます。
   ```bash
   cat > /tmp/change.json <<'JSON'
   { "kind": "settings", "summary": "技術スタックを確定した(ADR-001)", "settings": { "stack": "<決定したスタック>" } }
   JSON
   node scripts/init/generate-profile.mjs --change /tmp/change.json
   ```
3. **契約検査の実行**: `node scripts/gate/verify-gate-contract.mjs` を実行して、不整合がないことを確認します。

カバレッジの下限、許可するライセンス、変更規模の上限など、ほかの個別の値も同じ経路で変えます。検査の下限を下げる向きは、決定した者の記名と理由を要します(`/process-change` の「個別の値を変える」)。

## やってはならないこと

- 回答を推測して埋めること。設問の答えは利用者の状況であり、コードからは分からない
- **構想メモや既存ファイルからスタックを推測して埋めること。決まっていない場合は `undetermined` を選択してください**
- 不変条件の拒否を回避するために回答を変えること
- 未達(`unmet`)を省略(`omitted`)へ書き換えること
- `PROCESS-PROFILE.md` の未達の節を削除すること
- 逸脱(`deviations[]`)の記録を消して、通常の `required` に見せること
- D-0 体制図の兼務表を、逸脱の記録なしに埋めること
- ブランチ保護を代わりに適用すること
- 席の責任者(`seats[].accountable`)へ AI を書くこと、氏名を推測で埋めること。人の名簿(`people[]`)へ、利用者から受け取っていない名前を足すこと
- 運用形態を委任(`delegated`)へ書き換えること。委任は `/process-change` で、席の責任者の記名と理由を伴って行う
- 生成した `process.config.json` を手で編集すること。個別の値を変える場合も `/process-change`(種別 `settings`)を使う

## 参照

- [第8章 テーラリング](https://takenori-kusaka.github.io/process-compass/phase4-process-design/tailoring-guide/)
- [提案書の出力フォーマット](https://takenori-kusaka.github.io/process-compass/tool/proposal-output/)
