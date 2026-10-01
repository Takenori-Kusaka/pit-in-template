---
name: process-init
description: このプロジェクトのプロセス構成を対話で決め、PROCESS-PROFILE.md と process.config.json を生成する。チーム規模・事業ステージ・品質要求・開発形態・安全重要度の5軸を聞き、有効なゲート・成果物・ブランチ保護を導出する。テンプレートから作った直後に実行する。体制やステージが変わったときは process-change を使う。
---

# プロセス構成の初期化

このプロジェクトで**どのゲートを通すか**を決めます。決まっていない状態で実装を始めると、完了の条件が定まりません。

## 手順

### 1. 現在の状態を確認する

`process.config.json` の `configured` を見ます。

- `false` → 初回。そのまま手順2へ
- `true` → 設定済み。**このスキルで作り直さず、`/process-change` を使う**

体制・運用形態・AI の担い手・軸の入力が変わったときは、体制の変化点として `/process-change` で反映します(標準 第3章 3.13 / 第8章「再テーラリングの契機」)。全問を聞き直す再実行では、何が失効し、何が新たに生じたかを特定できず、変化点の記録も残りません。設定済みの構成に対して回答を変えて `generate-profile.mjs` を実行すると、スクリプトが拒否します。

### 2. 5つの軸を聞く

`scripts/vendor/tailoring-kb.json` の `questions` にある文言をそのまま使ってください。**専門用語で聞き直さないでください**。設問と選択肢は標準側で言葉を選んであります。

聞く順序:

| # | 質問 ID | 内容 |
| --- | --- | --- |
| 1 | `q-team-size` | 開発に関わる人数 |
| 2 | `q-biz-phase` | プロダクトの段階 |
| 3 | `q-quality` | 品質への要求 |
| 4 | `q-criticality` | 最悪の場合に何が起きるか |
| 5 | `q-dev-form` | 開発の形態 |
| 6 | `q-external-reviewer` | **1〜2名を選んだ場合のみ**。作成を指示した本人以外に、確認できる人がいるか(2名体制の相手を含む) |
| 7 | `q-existing-gates` | 社内に既存の承認ゲートはあるか |
| 8 | `q-ai-constraint` | AI 利用の制約 |

質問6は `q-team-size` が `size-1-2` のときだけ表示します(`appliesWhen`)。他の質問は常に聞きます。

**AskUserQuestion を使って一度に複数の質問を出してよい**ですが、選択肢の文言は `questions` の `label` をそのまま使ってください。`note` があれば説明として添えます。

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

生成物は3つです。`PROCESS-PROFILE.md`、`process.config.json`、そして **`CLAUDE.md` のマーカー区間**(`<!-- generated:process-rules -->`)です。区間には有効なゲートと判定者、ロールごとの権限と運用形態、委任の範囲、担ってはならない工程、受信箱のラベルが入ります。

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

### 6. 生成物を確認して伝える

生成後、次を必ず利用者へ伝えてください。

1. **未達のゲートがあるか**。ある場合は理由と、埋める方法を提示する
2. **代償措置つきの逸脱があるか**。ある場合は、代償措置を満たすことが運用の条件だと伝える
3. どのゲートが省略されたか、その理由
4. カバレッジの下限は初期値であり、実測に基づく値ではないこと
5. **スタックが未確定（undetermined）であるかどうか**。未確定の場合、**SG-0を通過するまでに確定させる必要があること（確定期限）**を伝える
6. 次にやること

### 7. 構成に応じて後片付けをする

`process.config.json` を読み、次を行います。

| 条件 | 操作 |
| --- | --- |
| `gates.g7.state === 'omitted'` | `.github/workflows/ship-evidence.yml` を削除してよいか確認する |
| `aiReview.enabled === false` | `.github/workflows/ai-review.yml` を削除する |
| `ruleset` が `null` でない | ブランチ保護の適用コマンドを提示する(実行はしない) |
| 常に | `context/projects/<案件ID>.md` を `templates/` から作る |

ブランチ保護の適用は利用者の操作です。エージェントが実行してはなりません。

```bash
gh api repos/{owner}/{repo}/rulesets --input .github/rulesets/team.json
```

### 8. 最初のコミット

生成物をコミットします。プロセス構成は成果物です。

このスクリプトは強制層(`.claude/guard.json`・`.claude/settings.json`)と `templates/06-project-brief.md` も書き換えるため、このコミットは「記録だけのコミット」に当たりません。PR を経ずにコミットする場合、出荷判定の証跡の集約は、トレーラ `Risk` と `Verification` の無いコミットを記録の欠落として扱います。コミットの前に契約検査を実行し、その結果を `Verification` へ書きます。

```bash
node scripts/gate/verify-gate-contract.mjs
node scripts/gate/check-process-rules.mjs
```

トレーラは、メッセージの末尾の段落に書きます(途中の段落のトレーラは読まれません)。

```
chore: プロセス構成を初期化する

- ピットイン方式のテーラリング(軸A〜E)を適用
- PROCESS-PROFILE.md / process.config.json / CLAUDE.md の構成依存部分を生成

Risk: R2
Verification: verify-gate-contract と check-process-rules が通過(<契約検査の最後の行を写す>)
Co-Authored-By: <モデルの名称と版>
```

`Risk` の区分は利用者が決めます(強制層の初期化であり、AI が区分を低く書いてはなりません)。構成の初期化より前のコミット(テンプレート由来の初期コミットなど)は、証跡の集約で対象外(pre-init)として件数だけが表示されます。

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

- 回答を推測して埋めること。5軸は利用者の状況であり、コードからは分からない
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
