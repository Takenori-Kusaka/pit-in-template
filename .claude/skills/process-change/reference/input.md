# 変化点の入力のキー

`/process-change` の手順1・3 の詳細です。種別ごとの例は `kinds/<種別>.md` にあります。

現在の構成は次で読みます(全文を読まない)。

```bash
node -e "const c=require('./process.config.json');console.log(JSON.stringify({answers:c.answers,people:c.people,seats:c.seats,delegation:c.delegation,governance:c.governance,d0Version:c.d0Version,unmet:c.unmet.map(u=>u.gate),deviations:c.deviations.map(d=>d.gate??d.separationId)},null,2))"
```

```json
{
  "kind": "headcount",
  "date": "2026-10-01",
  "summary": "3人目が加わり、独立レビュアを置けるようになった",
  "answers": { "q-team-size": "size-3-9" },
  "people": [{ "id": "p1", "name": "<氏名>", "accounts": ["<アカウント>"] }],
  "seats": { "independent-reviewer": { "accountable": "<氏名>" } },
  "decidedBy": "<D-0 表1「体制と運用形態」の決定者の氏名>",
  "reason": "<任命の理由>"
}
```

| キー | 内容 |
| --- | --- |
| `kind` | 種別。必須 |
| `date` | 発効日(YYYY-MM-DD)。省略すると実行日(手元の時刻帯の日付)。記録には時刻 `at`(オフセットつき)も残る。**暦に実在する日付で、今日以前、かつ最後の記録の日付以降に限る** |
| `summary` | 何が変わったかを1行で |
| `answers` | 変える軸の回答だけ。書かなかった回答は現在の値を引き継ぐ。文言は `scripts/vendor/tailoring-kb.json` の `questions` のものに限る |
| `people` | 人の名簿。**書くと全体を置き換える**。`{ "id", "name", "external", "appointer", "accounts", "nameConfirmed", "team" }`。`team` は所属(任意。10名以上の規則の判定に使う)。詳細: `kinds/accountable.md` |
| `seats` | 席(ロール ID)ごとに、変える欄だけ。`accountable` / `mode` / `performer` / `fallback` / `qualification` / `competence` |
| `delegation` | `rules` / `changeTypes` / `protectedPaths`。**書いた一覧は全体を置き換える**。詳細: `kinds/mode.md` |
| `governance` | D-0 表1 の2行の決定者の席と、品質保証部門の通知先。`{ "structureDecider", "catalogRegistrar", "qaNotice" }`。決定者の席を変えるのは、変更前の「体制と運用形態」の決定者に限る(記名と理由)。`qaNotice` を定めるのは厳しくする向き、外す(`null`)のは緩める向き |
| `decidedBy` / `reason` | 決定した者の氏名と理由。**緩める向きと任免では必須** |
| `takeover` | 交代した新しい責任者が、その席の委任を引き継ぐ(`kinds/accountable.md`) |
| `ruleApprovedBy` | 委任の規則の追加・拡大を承認した者。**AI維持管理者の席の責任者に限る**(`kinds/mode.md`) |
| `sgRecord` | ステージを前へ戻す変更で、SG の判定記録の所在(`docs/gates/` 配下の実在する .md) |
| `notice` | 即時通知の記録 `{ "to", "at" }`(`kinds/notice.md`) |
| `invalidatedChecks` | 無効になった確認と、やり直しの要否(`reference/direction.md`) |
| `recheckDue` | 失効した適合性確認・例外の、再確認の期日 |
| `d0Version` | D-0 の新しい版。省略すると末尾の数字を1つ進める(`1.2` → `1.3`)。人が先に frontmatter の版を上げていれば、その版を使う。**版を下げる指定は拒否**。版を上げるとき、frontmatter の `approver` と `approved_at` は、この変化点の決定者と日付から書かれる |
| `outage` / `settings` / `noticeFor` / `event` | 種別 `outage` / `settings` / `notice` でだけ使う |

## 席の欄の値

| 欄 | 値 |
| --- | --- |
| `accountable` | 責任者。名簿の氏名または `id`。**記名の自然人に限る** |
| `mode` | `human`(人確定) / `collab`(協働) / `delegated`(委任)。**上限の宣言**であり、変更ごとのリスク区分の判定が下げる |
| `performer` | `{ "model": "<モデルの版>", "instructions": "<指示資産の版>", "permissions": "<権限の組>" }`。人が担う席は `null` |
| `fallback` | AI が使えないときの扱い。`human`(人へ戻す) / `stop`(止める) |
| `qualification` | 適合性確認の記録。`{ "confirmedAt", "performedBy", "approvedBy", "cases", "result", "performer" }`。`confirmedAt` は発効日以前の実在する日付。`performer` に確認した担い手の識別。**`performedBy` は AI維持管理者の席の責任者、`approvedBy` は当該の席の責任者に限る**(標準 第3章 3.4.2)。承認し直すだけなら `{ "approvedBy": "<新しい責任者>" }` |
| `competence` | 席の責任者本人の、AI を使わずに判断できる力量の確認の記録(判断を担う席。標準 第3章 3.4.3 要求事項1)。`{ "confirmedAt", "confirmedBy", "record" }`。`confirmedBy` は本人以外の自然人。`null` で記録を消す。責任者が交代すると前任の記録は引き継がれない。記録だけの変化点に記名は要らない。詳細: `kinds/accountable.md` |

指示資産の版は、末尾へ `@<識別子>` を書くと、契約検査が実ファイル(`CLAUDE.md`・`AGENTS.md`・`.claude/`)と照合します。識別子を伴わない申告は照合されず、自己申告として表示されます。

```bash
node scripts/gate/verify-gate-contract.mjs --instructions-digest
```
