# 種別 settings: 個別の値を変える

変化点に数えません。D-0 の版は上げません。主に変わるもの: `adapters`、`ci`、`task`、`guard`、`platform`、`unmet[].reviewSourcing`。**`process.config.json` を直接編集しません**。

```json
{ "kind": "settings", "summary": "技術スタックを確定した", "settings": { "stack": "node" } }
```

| 欄 | 値 | 向き |
| --- | --- | --- |
| `stack` | アダプタ(`adapters/<stack>.json` があるもの) | 技術判断者の判断。判断記録(ADR)を残す(`/adr-write`) |
| `projectId` / `profileName` | 案件 ID、プロファイル名 | — |
| `ci.coverageThreshold` | カバレッジの下限(0〜100) | **下げるのは緩める向き** |
| `ci.failOnSeverity` / `ci.allowedLicenses` | 失敗させる重大度、許可するライセンス | **重大度を外す、ライセンスを足すのは緩める向き** |
| `task.maxChangedLines` / `maxChangedFiles` / `selfHealMaxIterations` | 規模の基準値(超過で規模の確認を要する。遮断ではない)と反復の上限。`maxChanged*` は `null`(基準なし)も取れる。`null` は `task.assurance` が L2 で根拠が実在し、確約範囲・コア指定のパス(`delegation.protectedPaths` か `riskFloor.rules` のパス)を宣言した構成でだけ書け、R1・R2・そのパスの変更には効かない | **上げる・`null` にするのは緩める向き** |
| `task.nonProductPaths` | 規模の算定で別に数える置き場(glob の配列)。既定のテスト・fixture・snapshot に足す | **足すのは緩める向き**。閾値として扱い、製品のコードと同じ PR に入れない |
| `task.assurance` | 担保水準の宣言 `{ "level": "L0" \| "L1" \| "L2", "basis": "<リポジトリ内のパス>", "declaredBy", "declaredAt", "reviewAt" }`。未宣言は L0 | **L0 から L1・L2 へ上げるのは緩める向き**(記名と理由を要する)。宣言は記録であり、緩和を自動で与えない。機械が確かめるのは根拠の実在と見直し日だけで、見直し日を過ぎると L0 として扱う |
| `guard` | 強制層の緩和設定 `{ "enabled", "reviewBy", "reason" }`。消すときは `null` | **無効にする、期限を延ばすのは緩める向き**。期限と理由を要する |
| `platform.host` / `platform.hostUrl` | 成果物の配布先 | — |
| `reviewSourcing` | `{ "g6": "<確認者の調達先>" }`。`node scripts/init/set-review-sourcing.mjs` もこの経路で記録する | — |
| `riskFloor` | 区分の下限の規則 `{ "rules": [{ "id", "paths": ["<glob>"], "floor": "R1" \| "R2", "kinds"?: ["add" \| "modify" \| "delete" \| "rename"], "why" }] }`(標準 第3章 3.8.1)。消すときは `null` | **規則を削る・下限を下げる・対象のパスを外すのは緩める向き**(D-0 表1「体制と運用形態」の決定者の記名)。起案は技術判断者、承認は AI維持管理者(機械は起案と承認の記名を見ない) |
| `dependencies` | 依存先の欄 `[{ "provider", "models"?: [], "noticePeriod", "data" }]`(第3章 3.12.11)。契約・規約で確かめた廃止・契約変更の通知の期間と、提供者へ渡すデータの種別と保持の条件 | — 。空欄の欄は単一障害点の候補として出る。書くのは AI運用担当者 |

- 緩める向きの決定をできるのは、AI維持管理者の席の責任者、または D-0 表1「体制と運用形態」の決定者。記名と理由を利用者から受け取る(`decidedBy`・`reason`)
- **基準値(カバレッジの下限・失敗させる重大度・除外設定)の変更は、標準では技術判断者の承認を要する**(第4章 G-5「基準値と除外設定の変更」)。機械が受け付ける記名は上の行のとおりで、技術判断者の承認の有無は確かめない。記名する者が技術判断者でない場合は、技術判断者の承認を得たことを理由(`reason`)に書く
- カバレッジの下限は、較正していない値(導出値のまま)に限り、代償措置で導出値が上がると自動で追随する。導出値が下がっても、自動では下げない
- テンプレートや知識ベースの更新で構成の導出が変わる場合も、空の `settings` で再導出する(`{ "kind": "settings", "summary": "テンプレートの更新を反映する" }`)
- ライセンスの許可リストの恒久の追加は法務の所管。技術判断者・AI維持管理者の裁量で行わない

## 閾値の変更は、製品のコードと別の PR にする(禁止事項6)

`ci`・`task`・`guard` を変える変化点を、製品のコードの変更と同じ PR に入れると、G-5 の `pr-rules`(`scripts/gate/check-pr.mjs`)が失敗します。閾値だけの PR として出します。変更規模の上限は**基底ブランチの**構成から読まれるため、上限を上げた PR がマージされるまで、新しい上限は効きません。

## 規模の基準値を変えるとき

基準値の値は暫定です。自組織の実測による較正(観測は四半期、更新は半期以上。充足率が8割を下回らない最大の区間)は人が判断します。**較正の手続を自動化しません**。出荷の集約が、規模の分布・`size:over` の件数・「読み切れたか」の内訳・超過 PR の判定完了時間を出します(基準値へ自動で反映しません)。

超過したまま一度だけレビューする場合も、基準値を上げません。PR の「規模の確認」の欄を書きます(例外承認は要りません)。例外承認は、R2 以上の規範の逸脱のために残っています。

## 担保水準の宣言(task.assurance)

```json
{ "kind": "settings", "summary": "担保水準 L1 を宣言した", "settings": { "task": { "assurance": { "level": "L1", "basis": "docs/assurance/f-001.md", "declaredBy": "<氏名>", "declaredAt": "YYYY-MM-DD", "reviewAt": "YYYY-MM-DD" } } }, "decidedBy": "<氏名>", "reason": "<理由>" }
```

- 水準は自己申告でなく、条件の充足を示す記録の所在(`basis`)で宣言します。`basis` が実在しなければ、書き込みを拒否します
- L1 以上で根拠が実在するとき、規模の確認は「保証の所在」の記入だけで足ります。L2 の機械の検証(リスク採点の稼働)はテンプレートに降ろしていません(`state=undelivered`。標準の実装台帳で開示)
- 見直し日を過ぎた宣言は L0 として扱い、G-5 が通知します

## 能力依存の定数の再評価待ち

`/process-change` の出力の末尾と `/pit` の注記が、再評価待ちの能力依存の定数の件数を出します(`node scripts/gate/recalibration.mjs`)。契機は、種別 `performer` で記録したモデル・指示資産の版の変更と、半期の暦だけです。**値は自動で変えません**。人が「残す・外す・移す」を `docs/calibration-register.md` へ記名で記録します(`| RC-NN | 残す・外す・移す | YYYY-MM-DD | 氏名 | 移した先の保証 |`)。
