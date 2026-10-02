---
name: gate-record
description: /gate の旧名(互換のための入口)。ゲート判定の記録は /gate <ゲート> を使う。このスキルは /gate へ案内するだけで、手順を持たない。
---

# ゲート判定を記録する(旧名)

このスキルは `/gate` へ移りました。**`.claude/skills/gate/SKILL.md` を読み、その手順に従ってください**。ゲートを指定して、そのゲートの補助ファイル(`.claude/skills/gate/gates/G-N.md`・`SG.md`)を1枚だけ読みます。

- 判定は人が行います。記録をもって判定が成立します。結果の欄を先に埋めません
- ゲートが分からないときは `node scripts/gate/next.mjs` を実行し、出力の「読む:」に従います
