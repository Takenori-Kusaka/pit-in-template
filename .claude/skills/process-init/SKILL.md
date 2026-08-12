---
name: process-init
description: このプロジェクトのプロセス構成を対話で決め、PROCESS-PROFILE.md と process.config.json を生成する。チーム規模・事業ステージ・品質要求・開発形態・安全重要度の5軸を聞き、有効なゲート・成果物・ブランチ保護を導出する。テンプレートから作った直後、および体制やステージが変わったときに実行する。
---

# プロセス構成の初期化

このプロジェクトで**どのゲートを通すか**を決めます。決まっていない状態で実装を始めると、完了の条件が定まりません。

## 手順

### 1. 現在の状態を確認する

`process.config.json` の `configured` を見ます。

- `false` → 初回。そのまま手順2へ
- `true` → 再設定。**現在の構成を先に提示し、何を変えるのかを利用者へ確認する**

再設定で構成を**緩める方向**(ゲートの適用 → 省略、承認数を減らす、規模を大きい側から小さい側へ)の変更が含まれる場合、理由を判断記録として残すよう促してください。厳しくする方向は自由です。引き上げは判定を要し、引き下げは自動という非対称を、構成の変更にも効かせます。

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
| 6 | `q-external-reviewer` | **1〜2名を選んだ場合のみ**。レビューを頼める相手が外にいるか |
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

### 6. 生成物を確認して伝える

生成後、次を必ず利用者へ伝えてください。

1. **未達のゲートがあるか**。ある場合は理由と、埋める方法を提示する
2. どのゲートが省略されたか、その理由
3. カバレッジの下限は初期値であり、実測に基づく値ではないこと
4. **スタックが未確定（undetermined）であるかどうか**。未確定の場合、**SG-0を通過するまでに確定させる必要があること（確定期限）**を伝える
5. 次にやること

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

```
chore: プロセス構成を初期化する

- ピットイン方式のテーラリング(軸A〜E)を適用
- PROCESS-PROFILE.md / process.config.json を生成
```

## 技術スタックの確定・変更手続

開発技術スタックを確定・変更する場合は、プロセス構成の再生成（`/process-init` の全ステップの再実行）ではなく、以下の手順で行います。技術選定は重要な意思決定のため、**ADR (Architecture Decision Record) の作成を伴います**。

1. **意思決定の記録**: `/adr-write` を実行し、採用した技術スタックと選定理由、比較検討した選択肢（採らなかった選択肢）を `context/decisions/` へ記録します。
2. **構成ファイルの更新**: `process.config.json` の `adapters.stack` の値を、決定したスタック（`node`, `python`, `go`, `none` のいずれか）へ直接編集します。
3. **プロファイルの再生成**: `generate-profile.mjs` を実行して `PROCESS-PROFILE.md` のみを更新します。
   ```bash
   node scripts/init/generate-profile.mjs --answers process.config.json --stack <決定したスタック> --project-id <既存の案件ID>
   ```
   ※ `--answers` に `process.config.json` のパスを渡すことで、既存の5軸回答を保持したままプロファイルと構成を更新できます。
4. **契約検査の実行**: `node scripts/gate/verify-gate-contract.mjs` を実行して、不整合がないことを確認します。

## やってはならないこと

- 回答を推測して埋めること。5軸は利用者の状況であり、コードからは分からない
- **構想メモや既存ファイルからスタックを推測して埋めること。決まっていない場合は `undetermined` を選択してください**
- 不変条件の拒否を回避するために回答を変えること
- 未達(`unmet`)を省略(`omitted`)へ書き換えること
- `PROCESS-PROFILE.md` の未達の節を削除すること
- ブランチ保護を代わりに適用すること

## 参照

- [第8章 テーラリング](https://takenori-kusaka.github.io/process-compass/phase4-process-design/tailoring-guide/)
- [提案書の出力フォーマット](https://takenori-kusaka.github.io/process-compass/tool/proposal-output/)
