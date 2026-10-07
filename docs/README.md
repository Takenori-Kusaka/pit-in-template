# 成果物の置き場

| ファイル | 内容 | テンプレート |
| --- | --- | --- |
| `D-0-governance.md` | 意思決定・エスカレーション体制図。**常に必須** | テンプレ0 |
| `project-brief.md` | 企画書 | テンプレ6 |
| `assumptions.md` | 前提の台帳 | テンプレ10 |
| `quality-assurance-policy.md` | 品質保証の方針と受容の基準(層1。組織に1つ。トップマネジメントが記名する) | テンプレ11 |
| `debt-ledger.md` | 技術負債台帳 | テンプレ3 |
| `handover.md` | 運用引き継ぎ文書 | テンプレ5 |
| `ai-sla.md` | AI-SLA 合意確認書(委託契約がある場合) | テンプレ8 |
| `safety-risk-assessment.md` | 安全リスクアセスメント(適用条件に該当する場合) | テンプレ9 |
| `gates/` | ゲート判定記録 | テンプレ4 |

テンプレートは `../templates/` にある。

## D-0 がないと始まらない

`D-0-governance.md` は企画承認(G-1)の前提条件。frontmatter が空、または `next_review` を過ぎていると `gate-entry` ワークフローが失敗する。

規模によらず必須。人数が少ないほど兼務が増え、誰が決めるかが曖昧になるため。
