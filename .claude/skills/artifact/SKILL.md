---
name: artifact
description: 成果物(テンプレ00〜10)を作る・見直すときの入口。`/artifact <種別>` で、その成果物の補助ファイル1枚(目的・読み手・形式、作成の手順、レビューの観点、機械の検査の所在)だけを読み、様式(templates/)から起こす。運用の工程(運用引き継ぎ、障害時)も含む。種別が分からないときは /pit を実行する。
---

# 成果物を作る・見直す

成果物ごとの知識は補助ファイルにあります。**指定された種別の1枚だけを読みます**。全部を読みません。

## 手順

### 1. 種別を決める

`node scripts/gate/next.mjs` の出力に `/artifact <種別>` と「読む:」があれば、それに従います。無ければ、利用者が指定した種別を使います。推測で種別を選びません。

| 種別 | 成果物 | 補助ファイル | 置き場 |
| --- | --- | --- | --- |
| `00` | 意思決定・エスカレーション体制図(D-0) | `artifacts/00-d0-governance.md` | `docs/D-0-governance.md` |
| `01` | 機能仕様書 | `artifacts/01-feature-spec.md` | `specs/F-NNN/spec.md` |
| `02` | 判断記録(ADR) | `artifacts/02-adr.md` | `context/decisions/NNNN-*.md` |
| `03` | 技術負債台帳 | `artifacts/03-debt-ledger.md` | `docs/debt-ledger.md` |
| `04` | ゲート判定記録 | `artifacts/04-gate-record.md` | `docs/gates/*.md` |
| `05` | 運用引き継ぎ文書 | `artifacts/05-handover.md` | `docs/handover.md` |
| `06` | 企画書 | `artifacts/06-project-brief.md` | `docs/project-brief.md` |
| `07` | 実装計画 | `artifacts/07-implementation-plan.md` | `specs/F-NNN/plan.md` |
| `08` | AI-SLA 合意確認書 | `artifacts/08-ai-sla.md` | `docs/ai-sla.md` |
| `09` | AIエージェント安全リスクアセスメント表 | `artifacts/09-safety-risk-assessment.md` | `docs/safety-risk-assessment.md` |
| `10` | 前提の台帳 | `artifacts/10-assumption-ledger.md` | `docs/assumptions.md` |
| `incident` | 障害時に使う記録(D-0 表4・引き継ぎの復旧手順・ポストモーテム) | `artifacts/incident.md` | — |

補助ファイルの所在は、このスキルのディレクトリ(`.claude/skills/artifact/`)からの相対です。

### 2. 補助ファイルを読む

選んだ1枚を読みます。補助ファイルは**欄の一覧を持ちません**。様式の正本は `templates/NN-*.md` です。欄を補助ファイルから推測して足したり削ったりしません。

### 3. 様式から起こす

置き場にファイルが無ければ、様式を写します。

```bash
cp templates/<NN>-<名前>.md <置き場>
```

既にあれば、写さずに既存のファイルを直します。成立済みの判定記録(`docs/gates/`)と、採用済みの判断記録は書き換えません。

### 4. 書く

- 補助ファイルの「作成の手順」に従う
- **人が書く欄(承認者・決定者・判定の結果・異議・受容の記名・観点1・2 など)を、AI が推測で埋めない**。空欄のまま、誰が書くかを利用者へ伝える
- 構成から生成される区間(D-0 の生成区間など)を手で書き換えない

### 5. 機械の検査を実行する

補助ファイルの「機械の検査」に書かれたコマンドを実行し、出力をそのまま利用者へ示します。検査が無い成果物は、無いことを伝えます(人が確かめる)。

### 6. 次の一手を示す

```bash
node scripts/gate/next.mjs
```

「人の判断待ち」が出たら、コマンドを実行せず、待つ席へ受信箱のラベルで渡します。

## このスキルがしないこと

- 判定(ゲートの判定は `/gate`)。成果物を作ることと、それを判定することを同じ主体が行わない
- 補助ファイルを複数まとめて読むこと
- 様式の欄を、補助ファイルや標準の本文に合わせて書き換えること(様式の変更はテンプレートの改訂として人が行う)

## 参照

- 成果物と置き場の一覧: `templates/README.md`
- [第6章 成果物・記録・トレーサビリティ](https://takenori-kusaka.github.io/process-compass/phase4-process-design/deliverable-templates/)
