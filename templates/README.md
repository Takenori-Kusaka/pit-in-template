# 成果物テンプレート

ピットイン方式の成果物12種と、標準の様式番号を持たない補助の様式2種です。使うときは写して、`docs/` `specs/` `context/` の該当箇所へ置きます。

| # | テンプレート | 置き場 | 必須の条件 | 関係するゲート |
| --- | --- | --- | --- | --- |
| 0 | [体制図(D-0)](./00-d0-governance.md) | `docs/D-0-governance.md` | **常に必須**(規模によらない) | G-1 の前提条件 |
| 1 | [機能仕様](./01-feature-spec.md) | `specs/F-NNN/spec.md` | **常に必須** | G-2 / G-4 |
| 2 | [判断記録(ADR)](./02-adr.md) | `context/decisions/NNNN-*.md` | 設計上の選択を伴った場合 | G-3、G-6(コア機能で添付) |
| 3 | [技術負債台帳](./03-debt-ledger.md) | `docs/debt-ledger.md` | 妥協・仮実装を受容した場合 | G-5 / G-7 |
| 4 | [ゲート判定記録](./04-gate-record.md) | `docs/gates/*.md` | **常に必須**(有効なゲートすべて) | 全ゲート |
| 5 | [運用引き継ぎ文書](./05-handover.md) | `docs/handover.md` | G-7 が有効なら必須 | G-7 |
| 6 | [企画書](./06-project-brief.md) | `docs/project-brief.md` | **常に必須** | G-1 |
| 7 | [実装計画](./07-implementation-plan.md) | `specs/F-NNN/plan.md` | **常に必須** | G-4 |
| 8 | [AI-SLA 合意確認書](./08-ai-sla.md) | `docs/ai-sla.md` | 委託契約がある場合 | G-7、契約添付 |
| 9 | [安全リスクアセスメント](./09-safety-risk-assessment.md) | `docs/safety-risk-assessment.md` | 下の4条件のいずれか | G-1 の前提条件 |
| 10 | [前提の台帳](./10-assumption-ledger.md) | `docs/assumptions.md` | **常に必須** | 全ゲートの通過条件 |
| 11 | [品質保証の方針と受容の基準(層1)](./11-quality-assurance-policy.md) | `docs/quality-assurance-policy.md` | 組織として品質を保証すると主張する場合(組織に1つ。案件ごとに作らない) | G-1 / G-7 / G-8 |
| — | [欠陥の台帳](./defect-ledger.md) | `docs/defect-ledger.md` | G-7 が有効なら必須(既知の欠陥が無くても置く) | G-7 基準2 |
| — | [導入前の検証: 合否の基準](./adoption-trial-criteria.md) | `docs/adoption-trial/criteria.md` | 採用を判断する前(標準 附属書I I.11) | — |

## テンプレ9 の適用条件

次のいずれかに該当する場合に必須です。

1. 物理的な危険源を持つ機器を制御する
2. エージェントの適用範囲に、取り消しに相手方の同意を要する変更種別(R1)を含む
3. エージェントが本番環境の資源へ到達する
4. AI 自律レベルが L2 以上

## テンプレ11 の扱い

無くても案件は進められます。無い組織、記名が無い組織、(必須)の行の受容者が空欄の組織では、保証の主張の成立条件1 を満たさず、出荷判定の証跡の集約がすべての変更を「品質保証の対象外として出荷した」と出します。記名は適用範囲の組織単位を最高位で指揮し管理する者(人)が行います。AI は様式を写すまでにとどめ、欄を推測で埋めません。

## 常に必須の6種

`process.config.json` の構成にかかわらず必要なものです。

- テンプレ0(体制図) — 人数が少ないほど兼務が増え、誰が決めるかが曖昧になるため
- テンプレ1(機能仕様)
- テンプレ4(ゲート判定記録)
- テンプレ6(企画書)
- テンプレ7(実装計画)
- テンプレ10(前提の台帳)

会議体は規模に応じて減らせます。**決定の権限と境界の記述は減らせません**。

## 参照

- [第6章 成果物テンプレート](https://takenori-kusaka.github.io/process-compass/phase4-process-design/deliverable-templates/)
