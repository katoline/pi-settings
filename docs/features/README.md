# 機能の仕様

## 概要

今ある機能（拡張・スキル・指示）の挙動・処理・既知の制約・関連ファイルを、1 機能 1 ファイルでまとめる。コードを変えたら同じ PR で更新する。

## 一覧

| 機能 | ファイル | 種類 | 置き場所 |
| --- | --- | --- | --- |
| ハーネスのガード | [harness-guards.md](harness-guards.md) | 拡張（ガード。ほかの機能はフェーズ 3 以降で追加） | `agent/extensions/harness/guards/` |
| 利用状況（usage） | [usage.md](usage.md) | 拡張 | `agent/extensions/usage/` |
| /exit | [exit.md](exit.md) | 拡張 | `agent/extensions/exit/` |
| pr スキル | [pr-skill.md](pr-skill.md) | スキル | `agent/skills/pr/` |
| git-pull スキル | [git-pull-skill.md](git-pull-skill.md) | スキル（`/skill:git-pull` でのみ起動） | `agent/skills/git-pull/` |
| ui-compare スキル | [ui-compare-skill.md](ui-compare-skill.md) | スキル（`/skill:ui-compare` でのみ起動） | `agent/skills/ui-compare/` |
| ハーネスの固定の指示と完了の合図 | [harness-instructions.md](harness-instructions.md) | 拡張（`<harness>` セクションへの差し込み） | `agent/extensions/harness/instructions/`・`output/` |

取り込み計画（[plan/](../plan/README.md)）で機能が置き換わったら、このファイルの一覧と各ファイルを更新する。
