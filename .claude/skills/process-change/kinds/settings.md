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
| `task.maxChangedLines` / `maxChangedFiles` / `selfHealMaxIterations` | 変更規模と反復の上限 | **上げるのは緩める向き** |
| `guard` | 強制層の緩和設定 `{ "enabled", "reviewBy", "reason" }`。消すときは `null` | **無効にする、期限を延ばすのは緩める向き**。期限と理由を要する |
| `platform.host` / `platform.hostUrl` | 成果物の配布先 | — |
| `reviewSourcing` | `{ "g6": "<確認者の調達先>" }`。`node scripts/init/set-review-sourcing.mjs` もこの経路で記録する | — |
| `riskFloor` | 区分の下限の規則 `{ "rules": [{ "id", "paths": ["<glob>"], "floor": "R1" \| "R2", "kinds"?: ["add" \| "modify" \| "delete" \| "rename"], "why" }] }`(標準 第3章 3.8.1)。消すときは `null` | **規則を削る・下限を下げる・対象のパスを外すのは緩める向き**(D-0 表1「体制と運用形態」の決定者の記名)。起案は技術判断者、承認は AI維持管理者(機械は起案と承認の記名を見ない) |
| `dependencies` | 依存先の欄 `[{ "provider", "models"?: [], "noticePeriod", "data" }]`(第3章 3.12.11)。契約・規約で確かめた廃止・契約変更の通知の期間と、提供者へ渡すデータの種別と保持の条件 | — 。空欄の欄は単一障害点の候補として出る。書くのは AI運用担当者 |

- 緩める向きの決定をできるのは、AI維持管理者の席の責任者、または D-0 表1「体制と運用形態」の決定者。記名と理由を利用者から受け取る(`decidedBy`・`reason`)
- カバレッジの下限は、較正していない値(導出値のまま)に限り、代償措置で導出値が上がると自動で追随する。導出値が下がっても、自動では下げない
- テンプレートや知識ベースの更新で構成の導出が変わる場合も、空の `settings` で再導出する(`{ "kind": "settings", "summary": "テンプレートの更新を反映する" }`)
- ライセンスの許可リストの恒久の追加は法務の所管。技術判断者・AI維持管理者の裁量で行わない

## 閾値の変更は、製品のコードと別の PR にする(禁止事項6)

`ci`・`task`・`guard` を変える変化点を、製品のコードの変更と同じ PR に入れると、G-5 の `pr-rules`(`scripts/gate/check-pr.mjs`)が失敗します。閾値だけの PR として出します。変更規模の上限は**基底ブランチの**構成から読まれるため、上限を上げた PR がマージされるまで、新しい上限は効きません。

## 変更規模の上限を変えるとき

上限の値は暫定です。自組織の実測による較正(四半期ごと、充足率が8割を下回らない最大の区間)は人が判断します。**較正の手続を自動化しません**。超過したまま一度だけレビューする場合は、上限を上げずに例外承認を使います(`.claude/skills/artifact/artifacts/03-debt-ledger.md`)。
